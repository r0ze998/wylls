// A participant's own ed25519 key. Every resident makes its own at its first
// start and keeps it in its state directory (mode 0600); no human key is ever
// read or shared. The shape `{publicKey, secretKey: seed ‖ pub}` is a Solana
// keypair's, so the gateway's signTalk/verifyTalk sign and check with it.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encode as base58 } from '../../../permutation-gateway/client/src/base58.mjs';
import { signTalk, verifyTalk } from '../../../permutation-gateway/client/src/talk-node.mjs';
import { canonicalJson } from '../../../permutation-gateway/citizens/mind/guards.mjs';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

function fromSeed(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey: new Uint8Array(pub), secretKey: new Uint8Array(Buffer.concat([seed, pub])) };
}

/** A fresh keypair. */
export function newKeypair() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return fromSeed(Buffer.from(seed));
}

/** The key in `file` (hex seed), made on first use; the secret stays in the returned object and the file. */
export function loadOrCreateKey(file) {
  if (existsSync(file)) return fromSeed(Buffer.from(readFileSync(file, 'utf8').trim(), 'hex'));
  const kp = newKeypair();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(kp.secretKey.slice(0, 32)).toString('hex'), { mode: 0o600 });
  chmodSync(file, 0o600);
  return kp;
}

export const addressOf = kp => base58(kp.publicKey);

/** Canonical bytes of a signed record: a domain line, then key-sorted JSON. */
export function recordBytes(domain, body) {
  return new TextEncoder().encode(`${domain}\n${canonicalJson(body)}`);
}

export function signRecord(domain, body, kp) {
  return Buffer.from(signTalk(recordBytes(domain, body), kp)).toString('base64');
}

export function verifyRecord(domain, body, sigB64, publicKey) {
  return verifyTalk(recordBytes(domain, body), Buffer.from(String(sigB64), 'base64'), publicKey);
}

/**
 * An identity is what a participant acts as: `address`, and `sign(domain, body)` for its records. A keyed identity
 * signs with its ed25519 key. A KEYLESS identity (tests only, WS13_KEYLESS=1) has no key at all: its address is the
 * base58 text of a fixed 32-byte label (an encoding of the label, not a key, nothing derived) and its records are
 * marked unsigned; only a test world created keyless accepts them (it trusts the port it handed the participant).
 */
export function keyIdentity(kp) {
  return Object.freeze({ keyed: true, keypair: kp, address: addressOf(kp), sign: (domain, body) => signRecord(domain, body, kp) });
}

export const UNSIGNED = 'unsigned-test-record';
const KEYLESS_PREFIX = 'ws13-test:';

export function keylessIdentity(label) {
  const text = `${KEYLESS_PREFIX}${label}`;
  const bytes = Buffer.alloc(32);
  if (Buffer.byteLength(text) > 32) throw new Error(`keyless label too long: ${label}`);
  bytes.write(text);
  return Object.freeze({ keyed: false, keypair: null, address: base58(bytes), sign: () => UNSIGNED });
}

/** A keypair or an identity, as an identity. */
export const toIdentity = x => (typeof x?.sign === 'function' && 'address' in x ? x : keyIdentity(x));
