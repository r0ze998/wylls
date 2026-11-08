// ⑯: does a reviewed entry in scripts/ci/node-key-reviewed.txt stay in force after the reviewed test or its
// dependencies change to CALL key code? Static only: the fixture files are text written to a temp dir (never
// imported or run); ④'s scan reads them (WS04_SCAN_ROOT). Usage: node v16-scan-stale-review.mjs <scan-node-key-tests.mjs>
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const scan = path.resolve(process.argv[2]);
const GEN = 'generate' + 'Key(';                 // a key-API name, kept out of this file's own text
const T = 'workstreams/06-creation/test/dispatch.test.mjs';
const base = {
  [T]: `import { toRuns } from '../src/connect/caravan.mjs';\nexport const r = toRuns;\n`,
  'workstreams/06-creation/src/connect/caravan.mjs': `import { resolve } from '../plan.mjs';\nexport const toRuns = e => resolve(e);\n`,
  'workstreams/06-creation/src/plan.mjs': `import { signHash } from './keys.mjs';\nexport const resolve = e => e;\nexport const sealPlan = (k, h) => signHash(k, h);\n`,
  'workstreams/06-creation/src/keys.mjs': `export const signHash = async () => crypto.subtle.${GEN});\n`,
  'scripts/ci/node-key-tests.txt': '',
  'scripts/ci/node-key-reviewed.txt': `${T}  ${process.env.V16_DIGEST ? 'closure=0000000000000000  ' : ''}# review: caravan uses plan.resolve only (pure)\n`,
};
// with a digest-pinning scan (V16_DIGEST=1): take the digest the scan reports for the reviewed state, as a reviewer would
// (a scan with `--digest <path>` (④ 5045fe3d and later) prints the digest; else take it from the stale-review message)
const pin = d => {
  const f = path.join(d, 'scripts/ci/node-key-reviewed.txt');
  const g = run(d, ['--digest', T]); const full = /closure=([0-9a-f]{64})/.exec(g.stdout);
  if (full) { writeFileSync(f, `${T}  closure=${full[1]}  # review: caravan uses plan.resolve only (pure)\n`); return; }
  const r = run(d); const m = /closure=([0-9a-f]{16})/.exec(r.stderr);
  if (m) writeFileSync(f, readFileSync(f, 'utf8').replace('closure=0000000000000000', `closure=${m[1]}`));
};
const tree = files => { const d = mkdtempSync(path.join(os.tmpdir(), 'v16-scan-stale-')); for (const [r, b] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, r)), { recursive: true }); writeFileSync(path.join(d, r), b); } return d; };
const run = (d, args = []) => spawnSync(process.execPath, [scan, ...args], { env: { ...process.env, WS04_SCAN_ROOT: d }, encoding: 'utf8' });
const listed = d => readFileSync(path.join(d, 'scripts/ci/node-key-tests.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
const verdict = (d, r) => r.status === 5 ? `scan refuses (exit 5): ${r.stderr.trim().split('\n').pop().trim()}` : listed(d).includes(T) ? 'test LISTED (excluded from key-free jobs)' : 'test NOT listed (runs in key-free jobs: the review still holds)';

const cases = {
  'C0 control: S1 with no review entry at all': { 'scripts/ci/node-key-reviewed.txt': '', 'workstreams/06-creation/src/connect/caravan.mjs': `import { resolve, sealPlan } from '../plan.mjs';\nexport const toRuns = async e => { await sealPlan(null, 'h'); return resolve(e); };\n` },
  'S4 harmless edit to a file in the closure (a comment)': { 'workstreams/06-creation/src/plan.mjs': `// tidy\nimport { signHash } from './keys.mjs';\nexport const resolve = e => e;\nexport const sealPlan = (k, h) => signHash(k, h);\n` },
  'S0 as reviewed (only plan.resolve is called)': {},
  'S1 dependency changed: caravan now calls plan.sealPlan (-> signHash -> key generation)':
    { 'workstreams/06-creation/src/connect/caravan.mjs': `import { resolve, sealPlan } from '../plan.mjs';\nexport const toRuns = async e => { await sealPlan(null, 'h'); return resolve(e); };\n` },
  'S2 the reviewed test itself now calls signHash (no key-API name in its own text)':
    { [T]: `import { toRuns } from '../src/connect/caravan.mjs';\nimport { signHash } from '../src/keys.mjs';\nawait signHash(null, 'h');\nexport const r = toRuns;\n` },
  'S3 a new dependency that generates a key is imported and called':
    { 'workstreams/06-creation/src/connect/caravan.mjs': `import { resolve } from '../plan.mjs';\nimport { fresh } from './wallet.mjs';\nexport const toRuns = async e => { await fresh(); return resolve(e); };\n`,
      'workstreams/06-creation/src/connect/wallet.mjs': `export const fresh = () => crypto.subtle.${GEN});\n` },
};
const out = {};
for (const [name, change] of Object.entries(cases)) {
  const d = tree(base);
  try {
    if (process.env.V16_DIGEST) pin(d);
    const first = run(d);                                  // the list as it stands after the review
    const before = verdict(d, first);
    for (const [r, b] of Object.entries(change)) { mkdirSync(path.dirname(path.join(d, r)), { recursive: true }); writeFileSync(path.join(d, r), b); }
    const check = run(d, ['--check']);                     // CI's check after the change (list not rewritten)
    const regen = run(d);                                  // and a regenerated list
    out[name] = { before, check: check.status === 0 ? '--check passes (exit 0)' : `--check exit ${check.status}`, after: verdict(d, regen) };
  } finally { rmSync(d, { recursive: true, force: true }); }
}
console.log(JSON.stringify(out, null, 1));
