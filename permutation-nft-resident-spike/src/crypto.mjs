// Primitives (node:crypto only, no dependencies): sha256, base58 (the
// Bitcoin alphabet, as Solana writes keys), ed25519 keypairs whose public
// key is a 32-byte Solana-style address, and detached signatures. The same
// DER prefixes as permutation-gateway/client/src/talk-node.mjs.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

export const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p));
  return new Uint8Array(h.digest());
};
export const utf8 = s => new Uint8Array(Buffer.from(s, 'utf8'));
export const toHex = b => Buffer.from(b).toString('hex');
export const fromHex = h => new Uint8Array(Buffer.from(h, 'hex'));
export const concat = (...bs) => new Uint8Array(Buffer.concat(bs.map(b => Buffer.from(b))));
export const equalBytes = (a, b) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
export const randomId = (n = 16) => randomBytes(n).toString('base64url');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGIT = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58(bytes) {
  const src = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < src.length && src[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of src) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  return '1'.repeat(zeros) + out;
}

export function fromBase58(str) {
  if (typeof str !== 'string' || !str.length) throw new TypeError('base58: expected a string');
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of str) {
    const d = DIGIT.get(c);
    if (d === undefined) throw new TypeError(`base58: bad character ${JSON.stringify(c)}`);
    n = n * 58n + d;
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

/** A base58 32-byte key, or throws. */
export function pubkeyBytes(address) {
  const b = fromBase58(address);
  if (b.length !== 32) throw new TypeError(`not a 32-byte key: ${address}`);
  return b;
}
export const isPubkey = s => { try { return typeof s === 'string' && base58(pubkeyBytes(s)) === s; } catch { return false; } };

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An ed25519 keypair (`seed`: 32 bytes; random by default). The secret stays inside `sign`. */
export function keypair(seed = randomBytes(32)) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const raw = new Uint8Array(createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(12));
  const publicKey = base58(raw);
  return Object.freeze({ publicKey, raw, sign: bytes => new Uint8Array(sign(null, Buffer.from(bytes), priv)) });
}

/** Whether `signature` (64 bytes) is `address`'s ed25519 signature of `bytes`. */
export function verifySignature(bytes, signature, address) {
  try {
    if (!signature || signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pubkeyBytes(address))]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(bytes), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** A fresh random 32-byte address (a mint, a collection) with no key behind it. */
export const randomAddress = () => base58(randomBytes(32));
