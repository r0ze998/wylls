// The pure IBE primitives of the march seals (no worker handler, no state):
// tlock's Boneh–Franklin IBE with the Fujisaki–Okamoto transform on G2 with
// the RFC 9380 G1 hash (tlock `encryptOnG2RFC9380`, quicknet), carrying a
// 16-byte key k. Moved here unchanged from seal-worker.mjs, which re-exports
// every name, so both the legacy 165-byte worker and the wide 264-byte worker
// can import them without installing each other's message handlers.
import { bls12_381 as bls } from '../sdk/vendor/noble/curves/bls12-381.mjs';
import { sha256 as nobleSha256 } from '../sdk/vendor/noble/hashes/sha2.mjs';

export const DST_G1 = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
export const K_LEN = 16;
const enc = new TextEncoder();
const G2 = bls.G2.ProjectivePoint;
const Fr = bls.fields.Fr;

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const h = (...parts) => nobleSha256(concat(...parts.map(p => (typeof p === 'string' ? enc.encode(p) : p))));
const xor = (a, b) => { if (a.length !== b.length) throw new Error('xor: lengths'); return a.map((x, i) => x ^ b[i]); };
const hexToBytes = s => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
const asBytes = x => (typeof x === 'string' ? hexToBytes(x) : Uint8Array.from(x));
const bigBE = b => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** tlock's identity for a round: sha256(round as u64 big-endian). */
export function roundIdentity(round) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(round), false);
  return h(b);
}

/** H3(σ, msg): a scalar from sha256(i_le16 ‖ sha256("IBE-H3" ‖ σ ‖ msg)), top bit dropped, first i below r. */
export function h3(sigma, msg) {
  const base = h('IBE-H3', sigma, msg);
  for (let i = 1; i < 65535; i++) {
    const d = h(Uint8Array.of(i & 0xff, i >> 8), base);
    d[0] >>= 1;
    const n = bigBE(d);
    if (n < Fr.ORDER) return n;
  }
  throw new Error('h3: no scalar');
}
/** H4(σ): sha256("IBE-H4" ‖ σ), first `len` bytes. */
export const h4 = (sigma, len) => h('IBE-H4', sigma).slice(0, len);

// GT element bytes as tlock serialises them: Fp12 = (c1, c0) of Fp6, Fp6 =
// (c2, c1, c0) of Fp2, Fp2 = (c1, c0) of Fp, each Fp 48 bytes big-endian.
const fpBytes = x => hexToBytes(x.toString(16).padStart(96, '0'));
const fp2Bytes = x => concat(fpBytes(x.c1), fpBytes(x.c0));
const fp6Bytes = x => concat(fp2Bytes(x.c2), fp2Bytes(x.c1), fp2Bytes(x.c0));
const fp12Bytes = x => concat(fp6Bytes(x.c1), fp6Bytes(x.c0));
/** H2(g): sha256("IBE-H2" ‖ g), first `len` bytes. */
export const gtHash = (gt, len) => h('IBE-H2', fp12Bytes(gt)).slice(0, len);

/** The G2 public key (96-byte compressed hex or bytes) as a point; throws unless valid and in the subgroup. */
export function publicKeyPoint(pk) {
  const p = G2.fromHex(asBytes(pk));
  p.assertValidity();
  return p;
}

/** H2(e(Q_id(round), pk)^r): the V mask. */
export function maskFor(pk, round, r) {
  const qid = bls.G1.hashToCurve(roundIdentity(round), { DST: DST_G1 });
  const gid = bls.pairing(qid, publicKeyPoint(pk));
  return gtHash(bls.fields.Fp12.pow(gid, r), K_LEN);
}

/** IBE-encrypt the 16-byte key `k` to `round` under `pk` with the given σ: {U, V, W}. */
export function ibeEncrypt(pk, round, k, sigma) {
  if (k.length !== K_LEN || sigma.length !== K_LEN) throw new Error('k and σ are 16 bytes');
  const r = h3(sigma, k);
  const U = G2.BASE.multiply(r).toRawBytes(true);
  const V = xor(sigma, maskFor(pk, round, r));
  const W = xor(k, h4(sigma, K_LEN));
  return { U, V, W };
}
