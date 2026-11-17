// Preload (`node --import`) for key-free runs: no program-derived address may be computed. Workstream 04's
// scripts/ci/no-keys-guard.mjs refuses key generation, derivation and signing but not PDAs, and an ESM export
// cannot be replaced after loading, so a loader hook rewrites the two PDA functions of the repository's
// solana-tx.mjs copies (permutation-gateway/client/src, permutation-server/web/sdk) to throw `NoPdaGuard`, and
// @solana/web3.js's PublicKey.findProgramAddressSync / createProgramAddressSync are replaced where it resolves.
// Like ④'s guard, it refuses what it knows; it does not prove absence.
import { register, createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const hooks = `
export async function load(url, context, next) {
  const r = await next(url, context);
  if (!/\\/solana-tx\\.mjs$/.test(url)) return r;
  let src = String(r.source);
  for (const name of ['findProgramAddress', 'createProgramAddress']) {
    src = src.replace('export function ' + name + '(', 'export function ' + name + '() { const e = new Error("NoPdaGuard: ' + name + ' is refused in a key-free run"); e.code = "NoPdaGuard"; throw e; }\\nfunction __guarded_' + name + '(');
  }
  return { ...r, source: src };
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);

// @solana/web3.js ships a CommonJS build and an ESM build: separate module instances. Both are patched (the
// PublicKey class is shared by reference within each), resolved from the working directory as the code under test.
const refuseStatic = PublicKey => {
  for (const name of ['findProgramAddressSync', 'createProgramAddressSync', 'findProgramAddress', 'createProgramAddress']) {
    if (typeof PublicKey?.[name] === 'function') PublicKey[name] = () => { const e = new Error(`NoPdaGuard: PublicKey.${name} is refused in a key-free run`); e.code = 'NoPdaGuard'; throw e; };
  }
};
export const guarded = [];
try {
  const req = createRequire(join(process.cwd(), 'noop.js'));
  refuseStatic(req('@solana/web3.js').PublicKey); guarded.push('web3 (cjs)');
  const pkgPath = req.resolve('@solana/web3.js/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const esm = pkg.exports?.['.']?.import ?? pkg.exports?.['.']?.node?.import ?? pkg.module;
  const entry = typeof esm === 'string' ? esm : esm?.default;
  if (entry) { refuseStatic((await import(pathToFileURL(join(dirname(pkgPath), entry)).href)).PublicKey); guarded.push('web3 (esm)'); }
} catch { /* web3 not resolvable from the working directory: only the repository's copies are guarded */ }
