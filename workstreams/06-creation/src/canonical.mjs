/**
 * Canonical JSON and SHA-256 for creation manifests.
 *
 * A manifest's identity is the SHA-256 of its canonical form: object keys
 * sorted, no whitespace, numbers restricted to safe integers (so two
 * implementations cannot disagree on how a float prints). The hash is
 * synchronous and dependency-free so the validator stays a pure function
 * in Node and in the browser.
 */

export class CanonicalError extends Error {
  constructor(message, path) {
    super(`${message} at ${path || "$"}`);
    this.name = "CanonicalError";
    this.path = path;
  }
}

export const MAX_DEPTH = 32;

export function canonicalize(value, path = "$", depth = 0) {
  if (depth > MAX_DEPTH) throw new CanonicalError("nested too deep", path);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalError("number is not a safe integer", path);
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v, i) => canonicalize(v, `${path}[${i}]`, depth + 1)).join(",")}]`;
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k], `${path}.${k}`, depth + 1)}`).join(",")}}`;
    }
    default:
      throw new CanonicalError(`unsupported ${typeof value}`, path);
  }
}

/** The own property `k` of `o`, never one inherited from Object.prototype. */
export function own(o, k) {
  return o !== null && typeof o === "object" && typeof k === "string" && Object.hasOwn(o, k) ? o[k] : undefined;
}

/**
 * A copy of a JSON value whose objects have no prototype, so a key such as
 * "constructor" or "toString" reads as absent. Throws CanonicalError past
 * MAX_DEPTH.
 */
export function plain(value, path = "$", depth = 0) {
  if (depth > MAX_DEPTH) throw new CanonicalError("nested too deep", path);
  if (Array.isArray(value)) return value.map((v, i) => plain(v, `${path}[${i}]`, depth + 1));
  if (value && typeof value === "object") {
    const out = Object.create(null);
    for (const k of Object.keys(value)) out[k] = plain(value[k], `${path}.${k}`, depth + 1);
    return out;
  }
  return value;
}

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function utf8(text) {
  return new TextEncoder().encode(text);
}

export function sha256(bytes) {
  const data = typeof bytes === "string" ? utf8(bytes) : bytes;
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 || /[^0-9a-f]/.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The content hash that names a JSON value: hex SHA-256 of its canonical form. */
export function contentHash(value) {
  return toHex(sha256(canonicalize(value)));
}
