// The external resident's OWN key, in a file only its owner can read (mode 0600), TEST-ONLY.
//
// The reference client keeps its key the way a separate agent would: made once on its own machine, never sent to the
// world's operator, the launcher, the relay or the MCP server — only its public address and its signatures leave this
// process. The file says `test_only: true`; a file without it, of another schema, readable by anyone but its owner,
// or not a regular file is refused. Never use a real wallet's key here: local TEST worlds only.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { openSync, writeSync, closeSync, fstatSync, readFileSync, lstatSync } from 'node:fs';
import { encode } from '../../../../../permutation-server/web/sdk/base58.mjs';

export const KEY_SCHEMA = 'wylls-external-resident-test-key-v1';
const SPKI_PREFIX = 12;   // (an ed25519 SPKI DER: 12 header bytes, then the 32-byte public key)

function keyFrom(privateKey) {
  const address = encode(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX));
  return Object.freeze({ address, signMessage: bytes => new Uint8Array(edSign(null, Buffer.from(bytes), privateKey)) });
}

/** Make a NEW TEST key file (refused if the path exists), mode 0600. → `{address, signMessage}`. */
export function createKeyFile(file) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const key = keyFrom(privateKey);
  const body = JSON.stringify({ schema: KEY_SCHEMA, test_only: true, warning: 'TEST-ONLY key of a local TEST world: never a real wallet', address: key.address,
    pkcs8_b64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }) + '\n';
  const fd = openSync(file, 'wx', 0o600);
  try { if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error('key file: the new file is readable by others (umask?)'); writeSync(fd, body); } finally { closeSync(fd); }
  return key;
}

/** Read an existing TEST key file: a regular file of this user, mode 0600 (or stricter), schema and test_only checked. */
export function loadKeyFile(file) {
  const st = lstatSync(file);
  if (!st.isFile()) throw new Error('key file: not a regular file');
  if ((st.mode & 0o077) !== 0) throw new Error('key file: readable or writable by others (chmod 600)');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('key file: not this user\'s');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (j?.schema !== KEY_SCHEMA || j.test_only !== true || typeof j.pkcs8_b64 !== 'string') throw new Error('key file: not a TEST-only key of this client');
  const key = keyFrom(createPrivateKey({ key: Buffer.from(j.pkcs8_b64, 'base64'), format: 'der', type: 'pkcs8' }));
  if (key.address !== j.address) throw new Error('key file: the address does not match the key');
  return key;
}
