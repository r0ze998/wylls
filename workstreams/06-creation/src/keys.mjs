/**
 * Ed25519 keys over WebCrypto (Node 22 and current browsers).
 *
 * A key is { pub, sign }: `pub` is the raw public key in hex, `sign` signs
 * bytes with a private key that is never extractable. Anything that only
 * verifies takes the public hex, so a function that prepares a plan for a
 * user can be shown not to hold the author's private key at all.
 *
 * Every signature is over a domain-separated message (`DOMAIN.x ‖ 0x00 ‖
 * hash`), so a publication signature can never be replayed as a plan
 * signature or a status change.
 */

import { fromHex, toHex, utf8 } from "./canonical.mjs";

export const DOMAIN = Object.freeze({
  publish: "wylls.creation.publish/0",
  status: "wylls.creation.status/0",
  plan: "wylls.creation.plan/0",
});

const ALG = { name: "Ed25519" };
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available");
  return s;
}

function b64urlToBytes(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function wrap(privateKey, pubBytes) {
  const pub = toHex(pubBytes);
  return Object.freeze({
    pub,
    async sign(bytes) {
      return toHex(new Uint8Array(await subtle().sign(ALG, privateKey, bytes)));
    },
  });
}

/**
 * A key from a 32-byte seed. Only for fixtures and the local demo: a seed
 * written in a repository is not a secret.
 */
export async function keyFromSeed(seedHex) {
  const seed = fromHex(seedHex);
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const der = new Uint8Array([...PKCS8_ED25519_PREFIX, ...seed]);
  const exportable = await subtle().importKey("pkcs8", der, ALG, true, ["sign"]);
  const jwk = await subtle().exportKey("jwk", exportable);
  const privateKey = await subtle().importKey("pkcs8", der, ALG, false, ["sign"]);
  return wrap(privateKey, b64urlToBytes(jwk.x));
}

export async function generateKey() {
  const pair = await subtle().generateKey(ALG, false, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  return wrap(pair.privateKey, raw);
}

export function message(domain, hashHex) {
  const d = utf8(domain);
  const h = utf8(hashHex);
  const out = new Uint8Array(d.length + 1 + h.length);
  out.set(d);
  out.set(h, d.length + 1);
  return out;
}

export async function signHash(key, domain, hashHex) {
  return key.sign(message(domain, hashHex));
}

export async function verifyHash(pubHex, domain, hashHex, sigHex) {
  try {
    const pub = await subtle().importKey("raw", fromHex(pubHex), ALG, false, ["verify"]);
    return await subtle().verify(ALG, pub, fromHex(sigHex), message(domain, hashHex));
  } catch {
    return false;
  }
}

export function isPubHex(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
