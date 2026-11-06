// Preload for tools/test-nokey.sh: every key generation, derivation and signing entry point of node:crypto throws,
// so a test that needs one fails loudly instead of quietly making or using a key. Verification stays available
// (reading a signature someone else made is not signing). Usage: node --import ./tools/nokey-guard.mjs --test ...
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
const BLOCK = ['generateKeyPair', 'generateKeyPairSync', 'generateKey', 'generateKeySync', 'createPrivateKey', 'createSecretKey',
  'sign', 'createSign', 'diffieHellman', 'createDiffieHellman', 'createECDH', 'hkdf', 'hkdfSync', 'pbkdf2', 'pbkdf2Sync', 'scrypt', 'scryptSync'];
for (const name of BLOCK) {
  if (typeof crypto[name] !== 'function') continue;
  crypto[name] = () => { throw new Error(`nokey: crypto.${name} is disabled in this run (no key generation, derivation or signing)`); };
}
if (crypto.webcrypto?.subtle) for (const m of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'importKey']) {
  crypto.webcrypto.subtle[m] = async () => { throw new Error(`nokey: subtle.${m} is disabled in this run`); };
}
syncBuiltinESMExports();
