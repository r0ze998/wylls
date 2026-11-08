// Writes scripts/ci/node-key-tests.txt: the Node test files that generate,
// derive or sign with a key, by a static scan that follows relative imports
// into the package's own test helpers (not into src/: what a test reaches in
// src is caught at run time by no-keys-guard.mjs, and such files are added
// below `# seen by the guard` by hand). Read-only except the list.
//   node scripts/ci/scan-node-key-tests.mjs [--check]   (--check: fail if the list is not current)
//   node scripts/ci/scan-node-key-tests.mjs --covers <repo-relative file>...
//     (exit 4 naming every file the scan does not examine: node-keyfree.sh runs only examined files)
//   WS04_SCAN_ROOT=<dir>: scan another tree (the scan's own fixture test); the list is then neither read nor written there
//     unless --check or the default mode is given.
//
// Two kinds of package are scanned (2026-11-08, ④: the list once missed workstream 06's roles.test.mjs, which calls
// generateKey(), because only the two SETS packages were scanned):
//   - SETS: as before, unchanged.
//   - every other git-tracked `*.test.mjs` (workstreams/*, the other permutation-* packages): helpers are the files a
//     test imports relatively from inside its own test directory (the nearest ancestor named test or tests, else its
//     own directory), never src/.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.WS04_SCAN_ROOT ? resolve(process.env.WS04_SCAN_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PAT = /Keypair\.generate|Keypair\.fromSeed|Keypair\.fromSecretKey|generateKeyPair|generateKey\(|createPrivateKey|subtle\.(sign|generateKey|importKey)|signTransaction|signMessage|\.sign\(|partialSign|ed25519\.|secp256k1\.|nacl|keygen|secretKey|privateKey/;
const SETS = [
  ['permutation-gateway', ['test', 'screens'], f => /\.test\.mjs$/.test(f) || f === 'screens/logic.screen.mjs', ['test']],
  ['permutation-state-solana-receipt-spike', ['client', 'server'], f => /\.test\.mjs$/.test(f), ['client', 'server']],
];
// `import … from './x'`, `export … from './x'`, `import('./x')` and the bare `import './x'` (side effects only).
const imports = src => [...src.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|(?:^|[;\s])import\s*['"](\.[^'"]+)['"]/gm)].map(m => m[1] ?? m[2] ?? m[3]);

function keyed(file, helperDirs, pkg, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  if (PAT.test(src)) return file;
  for (const spec of imports(src)) {
    const t = resolve(dirname(file), spec);
    if (!existsSync(t)) continue;
    const rel = relative(pkg, t);
    if (!helperDirs.some(d => rel.startsWith(d + '/'))) continue;
    const hit = keyed(t, helperDirs, pkg, seen);
    if (hit) return hit;
  }
  return null;
}

/** The directory a generic test's helpers must lie in: its nearest ancestor named test/tests, else its own directory. */
function testRoot(rel) {
  const parts = rel.split('/').slice(0, -1);
  for (let i = 0; i < parts.length; i++) if (parts[i] === 'test' || parts[i] === 'tests') return parts.slice(0, i + 1).join('/');
  return parts.join('/');
}
function keyedIn(file, base, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  if (PAT.test(src)) return file;
  for (const spec of imports(src)) {
    const t = resolve(dirname(file), spec);
    if (!existsSync(t)) continue;
    const rel = relative(base, t);
    if (rel.startsWith('..') || rel.split(sep).includes('src') || rel.split(sep).includes('node_modules')) continue;
    const hit = keyedIn(t, base, seen);
    if (hit) return hit;
  }
  return null;
}
const inSets = rel => SETS.some(([dir]) => rel.startsWith(dir + '/'));
const tracked = () => {
  try { return execFileSync('git', ['ls-files', '-z', '--', '*.test.mjs'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean); }
  catch { return walk(root, ''); }
};
function walk(dir, pre) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const rel = pre ? `${pre}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel));
    else if (/\.test\.mjs$/.test(e.name)) out.push(rel);
  }
  return out;
}

const old = existsSync(join(root, 'scripts/ci/node-key-tests.txt')) ? readFileSync(join(root, 'scripts/ci/node-key-tests.txt'), 'utf8') : '';
const seenByGuard = old.includes('# seen by the guard') ? old.slice(old.indexOf('# seen by the guard')).split('\n').slice(1).filter(l => l && !l.startsWith('#')) : [];
const out = [];
const examined = new Set();
for (const [dir, roots, isTest, helperDirs] of SETS) {
  const pkg = join(root, dir);
  for (const r of roots) {
    const d = join(pkg, r);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) {
      const rel = `${r}/${f}`;
      if (!isTest(rel)) continue;
      examined.add(`${dir}/${rel}`);
      const hit = keyed(join(pkg, rel), helperDirs, pkg);
      if (hit) out.push(`${dir}/${rel}`);
    }
  }
}
for (const rel of tracked().filter(f => !inSets(f)).sort()) {
  examined.add(rel);
  if (keyedIn(join(root, rel), join(root, testRoot(rel)))) out.push(rel);
}
if (process.argv.includes('--covers')) {
  const asked = process.argv.slice(process.argv.indexOf('--covers') + 1);
  const missing = asked.filter(f => !examined.has(f));
  if (missing.length) { console.error(`not examined by scripts/ci/scan-node-key-tests.mjs (not run):\n${missing.map(f => `  ${f}`).join('\n')}`); process.exit(4); }
  process.exit(0);
}
const body = [
  '# Node test files that generate, derive or sign with a key: never run by the key-free CI jobs,',
  '# only by the manual key-tests job. Written by scripts/ci/scan-node-key-tests.mjs (the file itself',
  '# or a test helper it imports names a key API).',
  ...out,
  '# seen by the guard (they reach a key API in src/ at run time; added by hand)',
  ...seenByGuard.filter(l => !out.includes(l)),
].join('\n') + '\n';
if (process.argv.includes('--check')) {
  if (body !== old) { console.error('scripts/ci/node-key-tests.txt is not current: run node scripts/ci/scan-node-key-tests.mjs'); process.exit(3); }
} else writeFileSync(join(root, 'scripts/ci/node-key-tests.txt'), body);
console.log(`${out.length} by the scan, ${seenByGuard.filter(l => !out.includes(l)).length} seen by the guard`);
