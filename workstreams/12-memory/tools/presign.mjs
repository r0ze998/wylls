// Writes fixtures/presigned-signatures.json: the public keys and signatures the key-free tests (every test/*.test.mjs
// that imports fixtures/presigned.mjs) need, made with fixtures/scenario.mjs's deterministic TEST-ONLY keys. This
// tool signs, so it is never part of a key-free run. It runs those tests with WS12_PRESIGN_RECORD set (they collect
// what is missing instead of failing), signs what they asked for, and repeats until nothing is missing; then the
// tests are run once more without it. Entries no test asks for any more are dropped. Deterministic output.
//   node workstreams/12-memory/tools/presign.mjs [--check]   (--check: exit 1 if the table is not current)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixturePublicKey, fixtureSignature } from '../fixtures/scenario.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const tablePath = join(here, 'fixtures/presigned-signatures.json');
const check = process.argv.includes('--check');
const tests = readdirSync(join(here, 'test')).filter(f => f.endsWith('.test.mjs')).sort()
  .filter(f => /from '\.\.\/fixtures\/presigned\.mjs'/.test(readFileSync(join(here, 'test', f), 'utf8'))).map(f => join('test', f));
const old = readFileSync(tablePath, 'utf8');
const was = JSON.parse(old);
const write = t => {
  const out = { format: was.format, note: was.note, public: Object.fromEntries(Object.entries(t.public).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    signatures: [...t.signatures].sort((a, b) => (a.tag + a.bytes < b.tag + b.bytes ? -1 : 1)) };
  return JSON.stringify(out, null, 1) + '\n';
};
// Start from nothing, so stale entries go: every entry is asked for again by a test.
const t = { public: {}, signatures: [] };
const tmp = mkdtempSync(join(tmpdir(), 'ws12-presign-'));
const rec = join(tmp, 'missing.jsonl');
const draft = join(tmp, 'table.json');
for (let round = 1; ; round++) {
  writeFileSync(draft, write(t));
  rmSync(rec, { force: true });
  try { execFileSync(process.execPath, ['--test', ...tests], { cwd: here, env: { ...process.env, WS12_PRESIGN_RECORD: rec, WS12_PRESIGN_TABLE: draft }, stdio: 'ignore' }); } catch { /* tests fail while entries are missing */ }
  const asked = existsSync(rec) ? readFileSync(rec, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  if (!asked.length) break;
  if (round > 50) throw new Error('presign: still missing entries after 50 rounds');
  for (const e of asked) {
    if (e.kind === 'public') t.public[e.tag] = fixturePublicKey(e.tag);
    else if (!t.signatures.some(s => s.tag === e.tag && s.bytes === e.bytes)) t.signatures.push({ tag: e.tag, bytes: e.bytes, sig: fixtureSignature(e.tag, Buffer.from(e.bytes, 'utf8')) });
  }
}
rmSync(tmp, { recursive: true, force: true });
const now = write(t);
if (check) {
  if (now !== old) { console.error('fixtures/presigned-signatures.json is not current: run node workstreams/12-memory/tools/presign.mjs'); process.exit(1); }
  console.log(`presigned table current: ${Object.keys(t.public).length} public keys, ${t.signatures.length} signatures, ${tests.length} test files`);
} else {
  writeFileSync(tablePath, now);
  execFileSync(process.execPath, ['--test', ...tests], { cwd: here, stdio: 'inherit' });
  console.log(`wrote ${tablePath}: ${Object.keys(t.public).length} public keys, ${t.signatures.length} signatures for ${tests.length} test files`);
}
