// Test preload (workstream 07): no key is generated, derived, imported as private, or used to sign. Any such call is
// logged to NOKEYS_LOG and throws, so a test that needs one fails instead of doing it.
import crypto from 'node:crypto';
import { appendFileSync } from 'node:fs';
const LOG = process.env.NOKEYS_LOG || '/dev/null';
const block = what => { try { appendFileSync(LOG, `${process.argv.slice(1).join(' ')}\t${what}\n`); } catch {} const e = new Error(`key use blocked: ${what}`); e.code = 'KeyUseBlocked'; return e; };
const subtle = globalThis.crypto?.subtle;
if (subtle) {
  for (const m of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'unwrapKey', 'wrapKey']) {
    const orig = subtle[m]?.bind(subtle);
    if (orig) Object.defineProperty(subtle, m, { value: async () => { throw block(`subtle.${m}`); } });
  }
  const imp = subtle.importKey.bind(subtle);
  Object.defineProperty(subtle, 'importKey', { value: async (fmt, data, alg, ext, uses) => {
    if (fmt === 'pkcs8' || (fmt === 'jwk' && data && data.d) || (uses ?? []).some(u => ['sign', 'deriveKey', 'deriveBits', 'decrypt', 'unwrapKey'].includes(u))) throw block(`subtle.importKey(${fmt}, ${JSON.stringify(uses)})`);
    return imp(fmt, data, alg, ext, uses);
  } });
}
for (const m of ['generateKeyPair', 'generateKeyPairSync', 'generateKey', 'generateKeySync', 'createPrivateKey', 'sign', 'hkdf', 'hkdfSync', 'pbkdf2', 'pbkdf2Sync', 'scrypt', 'scryptSync', 'createSign', 'diffieHellman', 'createECDH']) {
  if (typeof crypto[m] === 'function') try { crypto[m] = () => { throw block(`node:crypto.${m}`); }; } catch {}
}
// (named imports of node:crypto see the patched functions)
import { syncBuiltinESMExports } from 'node:module';
syncBuiltinESMExports();
