// Preloaded by scripts/ci/node-keyfree.sh (`node --import`): a run that may not
// generate, derive or sign with any key. Every API below that would do so throws
// `NoKeysGuard` before it acts, so a test that reaches one fails instead of
// using a key. The guarded test files were also chosen by a static scan
// (scripts/ci/node-key-tests.txt lists the ones left out); this guard is the
// second line, for paths the scan cannot see (imported helpers).
//
// Covered: node:crypto (generateKeyPair[Sync], generateKey[Sync], sign,
// createSign, createPrivateKey, diffieHellman, ECDH, scrypt/pbkdf2/hkdf as
// derivations), WebCrypto subtle (generateKey, sign, deriveKey, deriveBits,
// importKey of private material, unwrapKey), @solana/web3.js (Keypair.generate,
// fromSeed, fromSecretKey; Transaction/VersionedTransaction sign and
// partialSign; sendAndConfirmTransaction), @noble/curves ed25519/secp256k1
// (sign, getPublicKey, utils.randomPrivateKey / randomSecretKey) and the vendored noble BLS12-381
// of the web SDK (sign, getPublicKey). Not covered (limits): any other ed25519 implementation a test
// brings itself; the guard does not prove absence, it refuses what it knows.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const refuse = what => function noKeys() {
  const e = new Error(`NoKeysGuard: ${what} is refused in a key-free CI run`);
  e.code = 'NoKeysGuard';
  throw e;
};

const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
for (const name of ['generateKeyPair', 'generateKeyPairSync', 'generateKey', 'generateKeySync', 'sign', 'createSign',
  'createPrivateKey', 'diffieHellman', 'createECDH', 'createDiffieHellman', 'scrypt', 'scryptSync', 'pbkdf2',
  'pbkdf2Sync', 'hkdf', 'hkdfSync']) {
  if (typeof crypto[name] === 'function') crypto[name] = refuse(`node:crypto.${name}`);
}
syncBuiltinESMExports();

const subtle = globalThis.crypto?.subtle;
if (subtle) {
  const proto = Object.getPrototypeOf(subtle);
  for (const name of ['generateKey', 'sign', 'deriveKey', 'deriveBits', 'unwrapKey']) {
    Object.defineProperty(proto, name, { value: refuse(`crypto.subtle.${name}`), configurable: true, writable: true });
  }
  const importKey = proto.importKey;
  Object.defineProperty(proto, 'importKey', {
    configurable: true, writable: true,
    value: function (format, keyData, algorithm, extractable, usages) {
      if (format === 'pkcs8' || format === 'jwk' && keyData?.d !== undefined || (usages ?? []).includes('sign')) {
        return refuse('crypto.subtle.importKey (private key)')();
      }
      return importKey.call(this, format, keyData, algorithm, extractable, usages);
    },
  });
}

/** A module as the code under test resolves it (from the working directory). */
async function load(spec) {
  try {
    const req = createRequire(join(process.cwd(), 'noop.js'));
    return await import(pathToFileURL(req.resolve(spec)).href);
  } catch { return null; }
}

const web3 = await load('@solana/web3.js');
if (web3?.Keypair) {
  for (const name of ['generate', 'fromSeed', 'fromSecretKey']) web3.Keypair[name] = refuse(`Keypair.${name}`);
}
for (const cls of [web3?.Transaction, web3?.VersionedTransaction]) {
  if (!cls) continue;
  for (const name of ['sign', 'partialSign', 'addSignature']) {
    if (typeof cls.prototype[name] === 'function') cls.prototype[name] = refuse(`${cls.name}.${name}`);
  }
}
if (web3?.sendAndConfirmTransaction) {
  // An ESM export binding cannot be replaced; the Transaction patches above cover its signing.
}

function guardCurve(mod, label) {
  const b = mod?.bls12_381 ?? mod?.bls;
  const curves = [mod?.ed25519, mod?.secp256k1, mod?.x25519, b, b?.signatures, b?.shortSignatures, b?.longSignatures];
  for (const curve of curves.filter(Boolean)) {
    for (const name of ['sign', 'getPublicKey', 'getSharedSecret']) {
      try { if (typeof curve[name] === 'function') curve[name] = refuse(`${label}.${name}`); } catch { /* frozen */ }
    }
    for (const name of ['randomPrivateKey', 'randomSecretKey']) {
      try { if (curve.utils && typeof curve.utils[name] === 'function') curve.utils[name] = refuse(`${label}.utils.${name}`); } catch { /* frozen */ }
    }
  }
}
guardCurve(await load('@noble/curves/ed25519'), '@noble/curves/ed25519');
guardCurve(await load('@noble/curves/secp256k1'), '@noble/curves/secp256k1');

// The web SDK's vendored noble tree (permutation-server/web/sdk/vendor/noble).
for (const rel of ['permutation-server/web/sdk/vendor/noble/curves/bls12-381.mjs']) {
  for (const base of [process.cwd(), join(process.cwd(), '..')]) {
    const p = join(base, rel);
    if (existsSync(p)) guardCurve(await import(pathToFileURL(p).href), `vendor/noble/${rel.split('/').pop()}`);
  }
}

globalThis.__NO_KEYS_GUARD__ = true;
