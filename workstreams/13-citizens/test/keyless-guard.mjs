// Preload for keyless runs: `node --import ./test/keyless-guard.mjs --test …`.
//
// Sets WS13_KEYLESS=1 and replaces every node:crypto function that makes, derives, imports or uses a key (sign,
// verify, HMAC, key exchange, password derivation) with one that throws, also in Web Crypto's `subtle`. So a keyless
// run cannot generate, derive or sign anything with node:crypto, even by accident in shared set-up: such a call fails
// the test instead of happening. Hashes (sha256) and random ids stay available.
//
// Not covered: pure-JavaScript key code inside a dependency (e.g. a bundled ed25519 implementation in node_modules).
// This guard would not stop one; the keyless harness is written not to reach any (its key paths go through
// resident/keys.mjs, which uses node:crypto only).
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

process.env.WS13_KEYLESS = '1';

export const BLOCKED = Object.freeze([
  'generateKeyPair', 'generateKeyPairSync', 'generateKey', 'generateKeySync', 'generatePrime', 'generatePrimeSync',
  'createPrivateKey', 'createPublicKey', 'createSecretKey', 'sign', 'verify', 'createSign', 'createVerify',
  'createHmac', 'pbkdf2', 'pbkdf2Sync', 'scrypt', 'scryptSync', 'hkdf', 'hkdfSync',
  'createDiffieHellman', 'createDiffieHellmanGroup', 'getDiffieHellman', 'createECDH', 'diffieHellman',
  'privateEncrypt', 'privateDecrypt', 'publicEncrypt', 'publicDecrypt',
]);
const SUBTLE = ['sign', 'verify', 'generateKey', 'importKey', 'exportKey', 'deriveKey', 'deriveBits', 'wrapKey', 'unwrapKey'];

const forbid = what => function forbidden() { throw new Error(`ws13 keyless guard: ${what} is forbidden in this run`); };
for (const n of BLOCKED) if (typeof crypto[n] === 'function') crypto[n] = forbid(`crypto.${n}`);
const subtle = crypto.webcrypto?.subtle;
if (subtle) for (const n of SUBTLE) if (typeof subtle[n] === 'function') Object.defineProperty(subtle, n, { value: forbid(`crypto.subtle.${n}`), configurable: true });
syncBuiltinESMExports();
globalThis.__WS13_KEYLESS_GUARD__ = BLOCKED;
