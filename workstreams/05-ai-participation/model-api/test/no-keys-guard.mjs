// Preload for workstream 5's runs: `NODE_OPTIONS="--import <abs path>/no-keys-guard.mjs" node --test …` (NODE_OPTIONS
// so that every child process the tests start has it too).
// Any key made, derived or used, any address derived (PDAs and seeded addresses) or anything signed THROWS:
//   - node:crypto: key generation, key objects, sign/verify, HMAC, key derivation, key exchange (as workstream 13's)
//   - @solana/web3.js (the CommonJS build Node loads for both require and import): Keypair.generate/fromSeed/
//     fromSecretKey, PublicKey.findProgramAddress(Sync)/createProgramAddress(Sync)/createWithSeed, transaction signing
//   - the shared modules' own: solana-tx createProgramAddress/findProgramAddress, addresses withSeed/seasonPda/
//     programDataAddress, keys, signTalk, coSign, signCommand, signAs (no-keys-loader.mjs rewrites them as they load)
// Hashes (sha256) and random ids stay available.
import crypto from 'node:crypto';
import { createRequire, register, syncBuiltinESMExports } from 'node:module';

globalThis.__p05NoKeys = what => { throw Object.assign(new Error(`p05 no-keys guard: ${what} is forbidden in this run`), { code: 'NoKeysGuard' }); };
const forbid = what => function forbidden() { globalThis.__p05NoKeys(what); };
for (const n of ['generateKeyPair', 'generateKeyPairSync', 'generateKey', 'generateKeySync', 'createPrivateKey', 'createPublicKey', 'createSecretKey',
  'sign', 'verify', 'createSign', 'createVerify', 'createHmac', 'pbkdf2', 'pbkdf2Sync', 'scrypt', 'scryptSync', 'hkdf', 'hkdfSync',
  'createDiffieHellman', 'createDiffieHellmanGroup', 'getDiffieHellman', 'createECDH', 'diffieHellman', 'privateEncrypt', 'privateDecrypt', 'publicEncrypt', 'publicDecrypt']) {
  if (typeof crypto[n] === 'function') crypto[n] = forbid(`crypto.${n}`);
}
const subtle = crypto.webcrypto?.subtle;
if (subtle) for (const n of ['sign', 'verify', 'generateKey', 'importKey', 'exportKey', 'deriveKey', 'deriveBits', 'wrapKey', 'unwrapKey']) Object.defineProperty(subtle, n, { value: forbid(`crypto.subtle.${n}`), configurable: true });
syncBuiltinESMExports();

const PG = new URL('../../../../permutation-gateway/', import.meta.url);
function patchWeb3(w) {
  for (const n of ['generate', 'fromSeed', 'fromSecretKey']) w.Keypair[n] = forbid(`Keypair.${n}`);
  for (const n of ['findProgramAddressSync', 'findProgramAddress', 'createProgramAddressSync', 'createProgramAddress', 'createWithSeed']) w.PublicKey[n] = forbid(`PublicKey.${n}`);
  for (const C of [w.Transaction, w.VersionedTransaction]) for (const n of ['sign', 'partialSign']) if (C?.prototype?.[n]) C.prototype[n] = forbid(`${C.name}.${n}`);
}
try {
  // Node resolves the package to its CommonJS build for require and for import alike: one instance, patched here.
  patchWeb3(createRequire(new URL('package.json', PG))('@solana/web3.js'));
} catch (e) { if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
register(new URL('./no-keys-loader.mjs', import.meta.url));
globalThis.__P05_NO_KEYS_GUARD__ = true;
