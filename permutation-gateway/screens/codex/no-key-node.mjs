// Defence in depth for an already statically audited screen-runner path.
// This module never invokes a blocked operation, even as a self-test.
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
export const keyCalls = [];
for (const name of ['generateKeyPair', 'generateKeyPairSync', 'generateKey', 'generateKeySync', 'sign', 'createSign',
  'createPrivateKey', 'diffieHellman', 'createECDH', 'createDiffieHellman', 'scrypt', 'scryptSync', 'pbkdf2', 'pbkdf2Sync', 'hkdf', 'hkdfSync']) {
  if (typeof crypto[name] !== 'function') continue;
  crypto[name] = () => { keyCalls.push(name); throw new Error(`Prohibited key operation: ${name}`); };
}
syncBuiltinESMExports();

// Also cover Node's WebCrypto surface without exercising any blocked method.
const subtle = crypto.webcrypto.subtle;
for (const name of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'unwrapKey']) {
  Object.defineProperty(subtle, name, { value: async () => { keyCalls.push(`subtle.${name}`); throw new Error(`Prohibited key operation: subtle.${name}`); } });
}
const importKey = subtle.importKey.bind(subtle);
Object.defineProperty(subtle, 'importKey', { value: async (format, data, algorithm, extractable, usages) => {
  if (format === 'pkcs8' || (format === 'jwk' && data?.d) || usages?.includes('sign')) {
    keyCalls.push(`subtle.importKey:${format}`); throw new Error('Prohibited private-key import');
  }
  return importKey(format, data, algorithm, extractable, usages);
} });
// A caller must not be able to swallow a blocked attempt and still pass.
process.on('exit', () => { if (keyCalls.length) process.exitCode = 1; });
