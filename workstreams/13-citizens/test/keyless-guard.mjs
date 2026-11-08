// Preload for keyless runs: `node --import ./test/keyless-guard.mjs --test …` (and NODE_OPTIONS for child processes).
//
// Sets WS13_KEYLESS=1 and makes every way this repository's code could make, derive or use a key fail instead:
//   1. node:crypto: key generation, key objects, sign/verify, HMAC, key exchange, password derivation, and the same in
//      Web Crypto's `subtle`. Hashes (sha256) and random ids stay available.
//   2. @solana/web3.js (the copy permutation-gateway loads, which runs pure-JavaScript ed25519 that (1) cannot see):
//      PDA derivation (PublicKey.findProgramAddress[Sync], createProgramAddress[Sync], createWithSeed), keypair
//      creation (Keypair.generate, fromSeed, fromSecretKey), and transaction signing (Transaction sign/partialSign,
//      VersionedTransaction sign).
//   3. permutation-gateway/client/src/solana-tx.mjs's own findProgramAddress / createProgramAddress (sha256-based PDA
//      derivation): rewritten as it loads, since ESM exports cannot be patched afterwards.
// Every blocked attempt is also recorded (globalThis.__WS13_GUARD_ATTEMPTS__, and appended to $WS13_GUARD_LOG when
// set), so an attempt that some code catches and swallows is still visible to an audit.
//
// Not covered: a dependency's own private ed25519 code reached without going through (1)-(3). An audit run
// (WS13_GUARD_LOG) and the import-closure listing in the work record are how that is checked.
import crypto from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';

process.env.WS13_KEYLESS = '1';

export const BLOCKED = Object.freeze([
  'generateKeyPair', 'generateKeyPairSync', 'generateKey', 'generateKeySync', 'generatePrime', 'generatePrimeSync',
  'createPrivateKey', 'createPublicKey', 'createSecretKey', 'sign', 'verify', 'createSign', 'createVerify',
  'createHmac', 'pbkdf2', 'pbkdf2Sync', 'scrypt', 'scryptSync', 'hkdf', 'hkdfSync',
  'createDiffieHellman', 'createDiffieHellmanGroup', 'getDiffieHellman', 'createECDH', 'diffieHellman',
  'privateEncrypt', 'privateDecrypt', 'publicEncrypt', 'publicDecrypt',
]);
const SUBTLE = ['sign', 'verify', 'generateKey', 'importKey', 'exportKey', 'deriveKey', 'deriveBits', 'wrapKey', 'unwrapKey'];
export const WEB3_BLOCKED = Object.freeze({
  PublicKey: ['findProgramAddressSync', 'findProgramAddress', 'createProgramAddressSync', 'createProgramAddress', 'createWithSeed'],
  Keypair: ['generate', 'fromSeed', 'fromSecretKey'],
  'Transaction.prototype': ['sign', 'partialSign'],
  'VersionedTransaction.prototype': ['sign'],
});
export const SOLANA_TX_BLOCKED = Object.freeze(['findProgramAddress', 'createProgramAddress']);

const attempts = (globalThis.__WS13_GUARD_ATTEMPTS__ ??= []);
const record = what => {
  attempts.push(what);
  if (process.env.WS13_GUARD_LOG) { try { appendFileSync(process.env.WS13_GUARD_LOG, `${process.pid} ${what}\n`); } catch { /* the log is best effort */ } }
};
globalThis.__WS13_GUARD_RECORD__ = record;
const forbid = what => function forbidden() { record(what); throw new Error(`ws13 keyless guard: ${what} is forbidden in this run`); };

// (1) node:crypto
for (const n of BLOCKED) if (typeof crypto[n] === 'function') crypto[n] = forbid(`crypto.${n}`);
const subtle = crypto.webcrypto?.subtle;
if (subtle) for (const n of SUBTLE) if (typeof subtle[n] === 'function') Object.defineProperty(subtle, n, { value: forbid(`crypto.subtle.${n}`), configurable: true });
syncBuiltinESMExports();

// (2) @solana/web3.js, as permutation-gateway resolves it (its package has no exports map: ESM importers get the same
// CommonJS module object, so patching its classes reaches them).
let web3 = null;
try { web3 = createRequire(new URL('../../../permutation-gateway/package.json', import.meta.url))('@solana/web3.js'); } catch { web3 = null; }
const patched = [];
if (web3) {
  for (const [owner, names] of Object.entries(WEB3_BLOCKED)) {
    const target = owner.endsWith('.prototype') ? web3[owner.split('.')[0]]?.prototype : web3[owner];
    if (!target) continue;
    for (const n of names) if (typeof target[n] === 'function') { Object.defineProperty(target, n, { value: forbid(`web3.${owner}.${n}`), configurable: true, writable: true }); patched.push(`${owner}.${n}`); }
  }
}

// (3) the repository's own PDA derivation, rewritten at load.
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (!url.endsWith('/permutation-gateway/client/src/solana-tx.mjs')) return r;
    let src = String(r.source);
    for (const n of SOLANA_TX_BLOCKED) {
      src = src.replace(`export function ${n}(`, `function __ws13_unguarded_${n}(`);
      src += `\nexport function ${n}() { globalThis.__WS13_GUARD_RECORD__?.('solana-tx.${n}'); throw new Error('ws13 keyless guard: solana-tx.${n} (PDA derivation) is forbidden in this run'); }\n`;
    }
    return { ...r, source: src };
  },
});

globalThis.__WS13_KEYLESS_GUARD__ = Object.freeze({ crypto: BLOCKED, web3: web3 ? patched : null, solanaTx: SOLANA_TX_BLOCKED });
