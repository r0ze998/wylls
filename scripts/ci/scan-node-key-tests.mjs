// Writes scripts/ci/node-key-tests.txt: the Node test files that generate,
// derive or sign with a key, by a static scan that follows relative imports
// into the package's own test helpers (not into src/: what a test reaches in
// src is caught at run time by no-keys-guard.mjs, and such files are added
// below `# seen by the guard` by hand). Read-only except the list.
//   node scripts/ci/scan-node-key-tests.mjs [--check]   (--check: fail if the list is not current)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PAT = /Keypair\.generate|Keypair\.fromSeed|Keypair\.fromSecretKey|generateKeyPair|generateKey\(|createPrivateKey|subtle\.(sign|generateKey|importKey)|signTransaction|signMessage|\.sign\(|partialSign|ed25519\.|secp256k1\.|nacl|keygen|secretKey|privateKey/;
const SETS = [
  ['permutation-gateway', ['test', 'screens'], f => /\.test\.mjs$/.test(f) || f === 'screens/logic.screen.mjs', ['test']],
  ['permutation-state-solana-receipt-spike', ['client', 'server'], f => /\.test\.mjs$/.test(f), ['client', 'server']],
];
const imports = src => [...src.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map(m => m[1] ?? m[2]);

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

const old = existsSync(join(root, 'scripts/ci/node-key-tests.txt')) ? readFileSync(join(root, 'scripts/ci/node-key-tests.txt'), 'utf8') : '';
const seenByGuard = old.includes('# seen by the guard') ? old.slice(old.indexOf('# seen by the guard')).split('\n').slice(1).filter(l => l && !l.startsWith('#')) : [];
const out = [];
for (const [dir, roots, isTest, helperDirs] of SETS) {
  const pkg = join(root, dir);
  for (const r of roots) {
    const d = join(pkg, r);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) {
      const rel = `${r}/${f}`;
      if (!isTest(rel)) continue;
      const hit = keyed(join(pkg, rel), helperDirs, pkg);
      if (hit) out.push(`${dir}/${rel}`);
    }
  }
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
