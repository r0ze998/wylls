// The signed record bytes of the AI-citizens social layer (contract §6.1).
// SINGLE SOURCE: the council page, the citizens service (citizens/social/*)
// and the Node tests import this file; the Rust mirror is
// bots/src/ai/aisign.rs. It is self-contained (no imports) and does
// encode / decode / hash and nothing else, plus one signing guard.
//
// Three live records, all integers little-endian, strings UTF-8 with a u16
// length prefix, every record starting with its own domain TAG:
//
//   talk     TAG ‖ season u64 ‖ bell u32 ‖ wallet[32] ‖ seq u32 ‖ channel u8
//            (0 world · 1 nation · 3 direct) ‖ target (nation: u8 f · direct:
//            wallet[32] · world: nothing) ‖ kind u8 (0 say · 1 motion) ‖
//            ref u64 (say: reply-to id or 0 · motion: period << 8 | option) ‖
//            origin u8 (0 human · 1 AI-written · 2 scripted by the operator) ‖
//            lang[2] ‖ text (u16 len, ≤ 280 code points, ≤ 1,120 bytes)
//   ballot   TAG ‖ season u64 ‖ period u32 ‖ wallet[32] ‖ faction u8 ‖
//            option u8 (0 none, 1–3) ‖ candidates_hash[32] ‖ nonce[16] ‖ origin u8
//   callread TAG ‖ season u64 ‖ faction u8 ‖ period u32 ‖ wallet[32] ‖ unix i64
//
// Signatures are ed25519 by the citizen's current session key over exactly
// these bytes. Domain separation: signRecord / signable refuse to sign bytes
// that do not start with one of the three live TAGs; the TAG that v1.2
// reserves for a deferred feature (RESERVED_TAG) is refused by name. Byte 0
// of every TAG is 'w' = 0x77, which as a legacy Solana message header would
// claim 119 required signatures and, as a v0 prefix, is not 0x80, so no
// TAG-prefixed byte string is a valid single-signer transaction message.

export const TAGS = Object.freeze({
  talk: 'wylls/frontier/talk/v1',
  ballot: 'wylls/frontier/ballot/v1',
  callread: 'wylls/frontier/callread/v1',
});
/** Reserved by contract v1.2 (Appendix A.5): never encoded, never decoded, never signed. */
export const RESERVED_TAG = 'wylls/frontier/pact/v1';

export const CHANNEL = Object.freeze({ world: 0, nation: 1, direct: 3 });
export const KIND = Object.freeze({ say: 0, motion: 1 });
export const ORIGIN = Object.freeze({ human: 0, ai: 1, scripted: 2 });
export const MAX_TEXT_CHARS = 280;
export const MAX_TEXT_BYTES = 1120;
export const MAX_SEQ_K = 15;

export class SocialError extends Error {
  /** `code` is one of the §6.2 refusal codes (BadBytes, TextTooLong, …) or NotSignable. */
  constructor(code, message) { super(message); this.name = 'SocialError'; this.code = code; }
}
const bad = msg => { throw new SocialError('BadBytes', msg); };

// ------------------------------------------------------------------ byte helpers
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const TAG_BYTES = Object.fromEntries(Object.entries(TAGS).map(([k, v]) => [k, enc.encode(v)]));
const RESERVED_BYTES = enc.encode(RESERVED_TAG);

export const toHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  if (typeof h !== 'string' || h.length % 2 || /[^0-9a-fA-F]/.test(h)) bad('not hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function toBase64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Standard or URL-safe base64, padded or not; throws BadBytes on anything else. */
export function fromBase64(s) {
  if (typeof s !== 'string' || /[^A-Za-z0-9+/_=-]/.test(s)) bad('not base64');
  let t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (t.length % 4 === 1) bad('not base64');
  t += '='.repeat((4 - (t.length % 4)) % 4);
  let bin;
  try { bin = atob(t); } catch { bad('not base64'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Bytes as base58 (the Bitcoin alphabet, as Solana writes keys); each leading zero byte is a '1'. */
export function toBase58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] * 256; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
export function fromBase58(str) {
  if (typeof str !== 'string') bad('not base58');
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < str.length; i++) {
    const v = B58.indexOf(str[i]);
    if (v < 0) bad('not base58');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  return out;
}

/** A 32-byte key or hash from bytes, a 64-hex string or (keys only) a base58 string. */
function bytes32(x, what) {
  let b = x;
  if (typeof x === 'string') b = x.length === 64 && /^[0-9a-fA-F]+$/.test(x) ? fromHex(x) : fromBase58(x);
  if (!(b instanceof Uint8Array) || b.length !== 32) bad(`${what}: 32 bytes expected`);
  return b;
}
function fixed(x, n, what) {
  const b = typeof x === 'string' ? fromHex(x) : x;
  if (!(b instanceof Uint8Array) || b.length !== n) bad(`${what}: ${n} bytes expected`);
  return b;
}
function uint(x, bits, what) {
  let v;
  try { v = typeof x === 'bigint' ? x : typeof x === 'string' ? BigInt(x) : Number.isSafeInteger(x) ? BigInt(x) : null; } catch { v = null; }
  if (v === null || v < 0n || v >= (1n << BigInt(bits))) bad(`${what}: not a u${bits}`);
  return v;
}
function int64(x, what) {
  let v;
  try { v = typeof x === 'bigint' ? x : typeof x === 'string' ? BigInt(x) : Number.isSafeInteger(x) ? BigInt(x) : null; } catch { v = null; }
  if (v === null || v < -(1n << 63n) || v >= (1n << 63n)) bad(`${what}: not an i64`);
  return v;
}

class Out {
  constructor() { this.parts = []; this.n = 0; }
  put(b) { this.parts.push(b); this.n += b.length; return this; }
  u8(v) { return this.put(Uint8Array.of(Number(v))); }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return this.put(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(v), true); return this.put(b); }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return this.put(b); }
  i64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); return this.put(b); }
  done() {
    const r = new Uint8Array(this.n);
    let o = 0;
    for (const p of this.parts) { r.set(p, o); o += p.length; }
    return r;
  }
}

class In {
  constructor(bytes, tag) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = 0;
    if (bytes.length < tag.length) bad('too short');
    for (let i = 0; i < tag.length; i++) if (bytes[i] !== tag[i]) bad('wrong tag');
    this.o = tag.length;
  }
  need(n) { if (this.o + n > this.b.length) bad('truncated'); }
  u8() { this.need(1); return this.b[this.o++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  u64() { this.need(8); const v = this.dv.getBigUint64(this.o, true); this.o += 8; return v; }
  i64() { this.need(8); const v = this.dv.getBigInt64(this.o, true); this.o += 8; return v; }
  raw(n) { this.need(n); const v = this.b.slice(this.o, this.o + n); this.o += n; return v; }
  end() { if (this.o !== this.b.length) bad('trailing bytes'); }
}

/** Code points of a string (a lone surrogate counts as one). */
const codePoints = s => Array.from(s).length;

function textBytes(text) {
  if (typeof text !== 'string') bad('text: a string expected');
  const raw = enc.encode(text);
  if (codePoints(text) > MAX_TEXT_CHARS || raw.length > MAX_TEXT_BYTES) throw new SocialError('TextTooLong', `text: at most ${MAX_TEXT_CHARS} code points and ${MAX_TEXT_BYTES} bytes`);
  if (!text.trim()) bad('text: empty');
  if (/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) bad('text: not well-formed Unicode');
  return raw;
}
function langBytes(lang) {
  if (typeof lang !== 'string' || !/^[a-z]{2}$/.test(lang)) bad('lang: two lowercase ASCII letters');
  return enc.encode(lang);
}
const enumOf = (v, allowed, what) => { if (!allowed.includes(v)) bad(`${what}: ${v} is not one of ${allowed.join(',')}`); return v; };

// ------------------------------------------------------------------ talk
/** `{season, bell, wallet, seq, channel, target, kind, ref?, origin, lang, text}` → bytes. */
export function encodeTalk(r) {
  const channel = enumOf(Number(r.channel), [0, 1, 3], 'channel');
  const kind = enumOf(Number(r.kind), [0, 1], 'kind');
  const origin = enumOf(Number(r.origin), [0, 1, 2], 'origin');
  const o = new Out().put(TAG_BYTES.talk).u64(uint(r.season, 64, 'season')).u32(uint(r.bell, 32, 'bell')).put(bytes32(r.wallet, 'wallet')).u32(uint(r.seq, 32, 'seq')).u8(channel);
  if (channel === 1) {
    const f = uint(r.target, 8, 'target faction');
    o.u8(f);
  } else if (channel === 3) o.put(bytes32(r.target, 'target wallet'));
  else if (r.target !== null && r.target !== undefined) bad('target: a world message has none');
  const ref = uint(r.ref ?? 0, 64, 'ref');
  if (kind === 1) {
    const option = Number(ref & 0xffn);
    if (channel !== 1) bad('a motion goes to the nation channel');
    if (option < 1 || option > 3) bad('motion: option 1..3');
  }
  o.u8(kind).u64(ref).u8(origin).put(langBytes(r.lang));
  const t = textBytes(r.text);
  return o.u16(t.length).put(t).done();
}

export function decodeTalk(bytes) {
  const i = new In(bytes, TAG_BYTES.talk);
  const season = i.u64();
  const bell = i.u32();
  const wallet = i.raw(32);
  const seq = i.u32();
  const channel = enumOf(i.u8(), [0, 1, 3], 'channel');
  const target = channel === 1 ? i.u8() : channel === 3 ? i.raw(32) : null;
  const kind = enumOf(i.u8(), [0, 1], 'kind');
  const ref = i.u64();
  const origin = enumOf(i.u8(), [0, 1, 2], 'origin');
  const lang = String.fromCharCode(...i.raw(2));
  const n = i.u16();
  const raw = i.raw(n);
  i.end();
  langBytes(lang);
  let text;
  try { text = dec.decode(raw); } catch { bad('text: not UTF-8'); }
  if (codePoints(text) > MAX_TEXT_CHARS || raw.length > MAX_TEXT_BYTES) throw new SocialError('TextTooLong', `text: at most ${MAX_TEXT_CHARS} code points and ${MAX_TEXT_BYTES} bytes`);
  if (!text.trim()) bad('text: empty');
  if (kind === 1) {
    const option = Number(ref & 0xffn);
    if (channel !== 1) bad('a motion goes to the nation channel');
    if (option < 1 || option > 3) bad('motion: option 1..3');
  }
  return { type: 'talk', season, bell, wallet, seq, channel, target, kind, ref, origin, lang, text };
}

/** A motion's `ref`: period << 8 | option (option 1..3). */
export const motionRef = (period, option) => (uint(period, 56, 'period') << 8n) | uint(option, 8, 'option');
export const splitMotionRef = ref => ({ period: Number(BigInt(ref) >> 8n), option: Number(BigInt(ref) & 0xffn) });
/** seq = (bell << 4) | k, k = 0..15 the record's index among the wallet's records of the type in that bell. */
export function seqOf(bell, k) {
  if (!Number.isInteger(k) || k < 0 || k > MAX_SEQ_K) bad('seq: k is 0..15');
  const v = uint(bell, 32, 'bell') * 16n + BigInt(k);
  if (v > 0xffffffffn) bad('seq: bell too large');
  return Number(v);
}

// ------------------------------------------------------------------ ballot
/** `{season, period, wallet, faction, option, candidates_hash, nonce, origin}` → bytes. */
export function encodeBallot(r) {
  const option = enumOf(Number(r.option), [0, 1, 2, 3], 'option');
  const origin = enumOf(Number(r.origin), [0, 1, 2], 'origin');
  return new Out().put(TAG_BYTES.ballot).u64(uint(r.season, 64, 'season')).u32(uint(r.period, 32, 'period')).put(bytes32(r.wallet, 'wallet'))
    .u8(uint(r.faction, 8, 'faction')).u8(option).put(bytes32(r.candidates_hash, 'candidates_hash')).put(fixed(r.nonce, 16, 'nonce')).u8(origin).done();
}
export function decodeBallot(bytes) {
  const i = new In(bytes, TAG_BYTES.ballot);
  const season = i.u64();
  const period = i.u32();
  const wallet = i.raw(32);
  const faction = i.u8();
  const option = enumOf(i.u8(), [0, 1, 2, 3], 'option');
  const candidates_hash = i.raw(32);
  const nonce = i.raw(16);
  const origin = enumOf(i.u8(), [0, 1, 2], 'origin');
  i.end();
  return { type: 'ballot', season, period, wallet, faction, option, candidates_hash, nonce, origin };
}

// ------------------------------------------------------------------ call read
/** `{season, faction, period, wallet, unix}` → bytes (a signed read of the sealed Strike Order). */
export function encodeCallRead(r) {
  return new Out().put(TAG_BYTES.callread).u64(uint(r.season, 64, 'season')).u8(uint(r.faction, 8, 'faction')).u32(uint(r.period, 32, 'period'))
    .put(bytes32(r.wallet, 'wallet')).i64(int64(r.unix, 'unix')).done();
}
export function decodeCallRead(bytes) {
  const i = new In(bytes, TAG_BYTES.callread);
  const season = i.u64();
  const faction = i.u8();
  const period = i.u32();
  const wallet = i.raw(32);
  const unix = i.i64();
  i.end();
  return { type: 'callread', season, faction, period, wallet, unix };
}

// ------------------------------------------------------------------ dispatch
const startsWith = (b, tag) => b.length >= tag.length && tag.every((x, k) => b[k] === x);
/** 'talk' | 'ballot' | 'callread' by TAG, else null. */
export function recordType(bytes) {
  for (const [k, tag] of Object.entries(TAG_BYTES)) if (startsWith(bytes, tag)) return k;
  return null;
}
/** Whether the bytes begin with the reserved TAG. */
export const isReserved = bytes => startsWith(bytes, RESERVED_BYTES);
export function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) bad('bytes expected');
  const t = recordType(bytes);
  if (t === 'talk') return decodeTalk(bytes);
  if (t === 'ballot') return decodeBallot(bytes);
  if (t === 'callread') return decodeCallRead(bytes);
  return bad(isReserved(bytes) ? 'a reserved TAG' : 'unknown TAG');
}

/** The domain-separation guard: the record type of bytes a signer may sign; throws NotSignable for any other bytes. */
export function signable(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new SocialError('NotSignable', 'bytes expected');
  if (isReserved(bytes)) throw new SocialError('NotSignable', 'the reserved TAG is refused');
  const t = recordType(bytes);
  if (!t) throw new SocialError('NotSignable', 'only talk, ballot and call-read bytes are signed');
  return t;
}
/** Sign through `sign(bytes) → 64-byte signature` (sync or async) after the guard; returns `{bytes_b64, sig_b64, inner}`. */
export async function signRecord(bytes, sign) {
  signable(bytes);
  const sig = Uint8Array.from(await sign(bytes));
  if (sig.length !== 64) throw new SocialError('NotSignable', 'an ed25519 signature is 64 bytes');
  return { bytes_b64: toBase64(bytes), sig_b64: toBase64(sig), inner: toHex(innerOf(bytes, sig)) };
}

// ------------------------------------------------------------------ SHA-256 (self-contained)
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
/** SHA-256 of the concatenation of the byte arrays (or strings, as UTF-8) given. */
export function sha256(...parts) {
  const chunks = parts.map(p => (typeof p === 'string' ? enc.encode(p) : p));
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  let o = 0;
  for (const c of chunks) { padded.set(c, o); o += c.length; }
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  dv.setUint32(padded.length - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let b = 0; b < padded.length; b += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(b + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15], y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let t = 0; t < 8; t++) odv.setUint32(t * 4, h[t]);
  return out;
}

// ------------------------------------------------------------------ redactable leaves (§6.3)
/** inner = sha256(bytes ‖ sig): what a redaction keeps. */
export const innerOf = (bytes, sig) => sha256(bytes, sig);
/** leaf = sha256(0x00 ‖ inner). */
export const leafOf = inner => sha256(Uint8Array.of(0), inner);
/** node = sha256(0x01 ‖ left ‖ right). */
export const nodeOf = (l, r) => sha256(Uint8Array.of(1), l, r);

// ------------------------------------------------------------------ JSON views
const u64json = v => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());
/** The JSON view of a decoded record (§8.1 field names; wallets base58, hashes hex, u64 a number when safe else a decimal string). */
export function view(r) {
  if (r.type === 'talk') {
    return {
      season: u64json(r.season), bell: r.bell, wallet: toBase58(r.wallet), seq: r.seq, channel: r.channel,
      target: r.channel === 1 ? r.target : r.channel === 3 ? toBase58(r.target) : null,
      kind: r.kind, ref: u64json(r.ref), origin: r.origin, lang: r.lang, text: r.text,
    };
  }
  if (r.type === 'ballot') {
    return {
      season: u64json(r.season), period: r.period, wallet: toBase58(r.wallet), faction: r.faction, option: r.option,
      candidates_hash: toHex(r.candidates_hash), nonce: toHex(r.nonce), origin: r.origin,
    };
  }
  return { season: u64json(r.season), faction: r.faction, period: r.period, wallet: toBase58(r.wallet), unix: r.unix.toString() };
}
