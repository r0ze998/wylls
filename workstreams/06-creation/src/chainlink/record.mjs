/**
 * ⑥ chain link, slice 1 (LOCAL ONLY, behind a flag that is off by default):
 * the byte layout of the two accounts a world-4 program would keep for a
 * published creation, so that the local stand-in (localchain.mjs) and every
 * reader (catalog.mjs, the prototype page) already speak the planned shape.
 *
 * Nothing here is on any chain. No program has these accounts; the magic,
 * seed tags, account-kind numbers and sizes are a PROPOSAL
 * (docs/design/creation/item6-chainlink-plan.md; open questions Q-6CL-1..7) and need r0ze's OK and
 * the world-4 scope before a program carries them.
 *
 * What goes on chain is a *commitment*, not the definition: the manifest
 * JSON stays off chain (catalog), and the account holds its content hash
 * (contentHash of src/canonical.mjs), the author, name, version, status and
 * the status sequence the registry already signs over (statusMessage).
 * Field order and widths follow the v2 accounts of frontier-abi (magic 8 B,
 * season id u64, layout version u16, little-endian integers; cf. the Grant
 * layout in frontier-abi/src/v2/rights.rs).
 *
 * Pure: no key, no clock, no I/O.
 */

import { fromHex, sha256, toHex, utf8 } from "../canonical.mjs";

export const LAYOUT_VERSION_1 = 1;

/** Publication status as one byte (the registry's STATUSES keys, in order). */
export const STATUS_CODES = Object.freeze({ listed: 0, suspended: 1, withdrawn: 2 });
export const STATUS_NAMES = Object.freeze(["listed", "suspended", "withdrawn"]);

/** ⑥'s names are [a-z0-9-]{3,40} (manifest.mjs NAME_RE). */
export const NAME_MAX = 40;

/** One entry per (author, name): its status and newest version. */
export const ENTRY = Object.freeze({
  MAGIC: "PSF6CENT",
  SEED_TAG: "ce",
  SEASON_ID: 8, // u64 (the world)
  VERSION: 16, // u16 layout version
  STATUS: 18, // u8 (STATUS_CODES)
  NAME_LEN: 19, // u8
  NAME: 20, // [u8; 40] ascii, zero padded
  STATUS_SEQ: 60, // u32 = the registry's statusLog length (publishes count)
  AUTHOR: 64, // [u8; 32] the author's ed25519 public key = the wallet that signs the tx
  VERSION_COUNT: 96, // u32
  NEWEST_MAJOR: 100, // u32
  NEWEST_MINOR: 104, // u32
  NEWEST_PATCH: 108, // u32
  NEWEST_HASH: 112, // [u8; 32]
  CREATED_SLOT: 144, // u64
  STATUS_SLOT: 152, // u64
  STATUS_DAY: 160, // u32 bell-day of the last change (Q6-3: day boundary still open)
  RESERVED: 164, // [u8; 12]
  SIZE: 176,
});

/** One immutable account per published version. */
export const VERSION = Object.freeze({
  MAGIC: "PSF6CVER",
  SEED_TAG: "cv",
  SEASON_ID: 8, // u64
  VERSION: 16, // u16 layout version
  NAME_LEN: 18, // u8
  FLAGS: 19, // u8, bit 0 = derived_from is set
  MAJOR: 20, // u32
  MINOR: 24, // u32
  PATCH: 28, // u32
  AUTHOR: 32, // [u8; 32]
  NAME: 64, // [u8; 40]
  CONTENT_HASH: 104, // [u8; 32]
  DERIVED_FROM_HASH: 136, // [u8; 32] the source version's content hash (fork.mjs derivedFrom.hash)
  PUBLISHED_SLOT: 168, // u64
  PUBLISHED_DAY: 176, // u32
  RESERVED: 180, // [u8; 12]
  SIZE: 192,
});

/** Rent-exempt minimum of an account of `size` bytes at the default rent. */
export function rentExempt(size, lamportsPerByteYear = 3480, years = 2) {
  return (128 + size) * lamportsPerByteYear * years;
}

export class RecordError extends Error {
  constructor(code, detail = {}) {
    super(`${code}${detail.detail ? `: ${detail.detail}` : ""}`);
    this.code = code;
    Object.assign(this, detail);
  }
}

const HEX32 = /^[0-9a-f]{64}$/;

function key32(hex, what) {
  if (typeof hex !== "string" || !HEX32.test(hex)) throw new RecordError("RECORD_FIELD", { detail: `${what} is 32 bytes of lowercase hex` });
  return fromHex(hex);
}

function nameBytes(name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(name)) throw new RecordError("RECORD_FIELD", { detail: "name is [a-z0-9][a-z0-9-]{2,39}" });
  return utf8(name);
}

function u32(n, what) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new RecordError("RECORD_FIELD", { detail: `${what} is a u32` });
  return n;
}

function u64(n, what) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RecordError("RECORD_FIELD", { detail: `${what} is a non-negative safe integer (u64)` });
  return BigInt(n);
}

/** "1.2.3" → [1, 2, 3] (semver.mjs grammar; each part ≤ 999999 < 2^32). */
export function versionTriple(text) {
  const m = typeof text === "string" && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(text);
  if (!m) throw new RecordError("RECORD_FIELD", { detail: "version is MAJOR.MINOR.PATCH" });
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function magic(view, text) {
  for (let i = 0; i < 8; i++) view.setUint8(i, text.charCodeAt(i));
}

function readMagic(bytes) {
  return String.fromCharCode(...bytes.subarray(0, 8));
}

function readName(bytes, lenOff, nameOff) {
  const n = bytes[lenOff];
  if (n < 3 || n > NAME_MAX) throw new RecordError("RECORD_CORRUPT", { detail: "name length" });
  for (let i = nameOff + n; i < nameOff + NAME_MAX; i++) if (bytes[i] !== 0) throw new RecordError("RECORD_CORRUPT", { detail: "name padding" });
  const name = new TextDecoder().decode(bytes.subarray(nameOff, nameOff + n));
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(name)) throw new RecordError("RECORD_CORRUPT", { detail: "name grammar" });
  return name;
}

function reservedZero(bytes, from, to) {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) throw new RecordError("RECORD_CORRUPT", { detail: "reserved bytes" });
}

function header(bytes, want, size) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) throw new RecordError("RECORD_CORRUPT", { detail: `size ${bytes?.length} ≠ ${size}` });
  if (readMagic(bytes) !== want) throw new RecordError("RECORD_CORRUPT", { detail: "magic" });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(16, true) !== LAYOUT_VERSION_1) throw new RecordError("RECORD_CORRUPT", { detail: "layout version" });
  return view;
}

function safe(big, what) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new RecordError("RECORD_CORRUPT", { detail: `${what} beyond 2^53` });
  return Number(big);
}

/**
 * @param e { seasonId, author (hex), name, status, statusSeq, versionCount,
 *            newest ("x.y.z"), newestHash (hex), createdSlot, statusSlot, statusDay }
 */
export function encodeEntry(e) {
  const out = new Uint8Array(ENTRY.SIZE);
  const v = new DataView(out.buffer);
  magic(v, ENTRY.MAGIC);
  v.setBigUint64(ENTRY.SEASON_ID, u64(e.seasonId, "seasonId"), true);
  v.setUint16(ENTRY.VERSION, LAYOUT_VERSION_1, true);
  if (!Object.hasOwn(STATUS_CODES, e.status)) throw new RecordError("RECORD_FIELD", { detail: "status" });
  v.setUint8(ENTRY.STATUS, STATUS_CODES[e.status]);
  const nb = nameBytes(e.name);
  v.setUint8(ENTRY.NAME_LEN, nb.length);
  out.set(nb, ENTRY.NAME);
  v.setUint32(ENTRY.STATUS_SEQ, u32(e.statusSeq, "statusSeq"), true);
  out.set(key32(e.author, "author"), ENTRY.AUTHOR);
  v.setUint32(ENTRY.VERSION_COUNT, u32(e.versionCount, "versionCount"), true);
  const [a, b, c] = versionTriple(e.newest);
  v.setUint32(ENTRY.NEWEST_MAJOR, a, true);
  v.setUint32(ENTRY.NEWEST_MINOR, b, true);
  v.setUint32(ENTRY.NEWEST_PATCH, c, true);
  out.set(key32(e.newestHash, "newestHash"), ENTRY.NEWEST_HASH);
  v.setBigUint64(ENTRY.CREATED_SLOT, u64(e.createdSlot, "createdSlot"), true);
  v.setBigUint64(ENTRY.STATUS_SLOT, u64(e.statusSlot, "statusSlot"), true);
  v.setUint32(ENTRY.STATUS_DAY, u32(e.statusDay ?? 0, "statusDay"), true);
  return out;
}

export function decodeEntry(bytes) {
  const v = header(bytes, ENTRY.MAGIC, ENTRY.SIZE);
  const s = bytes[ENTRY.STATUS];
  if (s >= STATUS_NAMES.length) throw new RecordError("RECORD_CORRUPT", { detail: "status byte" });
  reservedZero(bytes, ENTRY.RESERVED, ENTRY.SIZE);
  return {
    kind: "entry",
    seasonId: safe(v.getBigUint64(ENTRY.SEASON_ID, true), "seasonId"),
    status: STATUS_NAMES[s],
    name: readName(bytes, ENTRY.NAME_LEN, ENTRY.NAME),
    statusSeq: v.getUint32(ENTRY.STATUS_SEQ, true),
    author: toHex(bytes.subarray(ENTRY.AUTHOR, ENTRY.AUTHOR + 32)),
    versionCount: v.getUint32(ENTRY.VERSION_COUNT, true),
    newest: `${v.getUint32(ENTRY.NEWEST_MAJOR, true)}.${v.getUint32(ENTRY.NEWEST_MINOR, true)}.${v.getUint32(ENTRY.NEWEST_PATCH, true)}`,
    newestHash: toHex(bytes.subarray(ENTRY.NEWEST_HASH, ENTRY.NEWEST_HASH + 32)),
    createdSlot: safe(v.getBigUint64(ENTRY.CREATED_SLOT, true), "createdSlot"),
    statusSlot: safe(v.getBigUint64(ENTRY.STATUS_SLOT, true), "statusSlot"),
    statusDay: v.getUint32(ENTRY.STATUS_DAY, true),
  };
}

/**
 * @param r { seasonId, author, name, version ("x.y.z"), hash, derivedFromHash?, publishedSlot, publishedDay }
 */
export function encodeVersion(r) {
  const out = new Uint8Array(VERSION.SIZE);
  const v = new DataView(out.buffer);
  magic(v, VERSION.MAGIC);
  v.setBigUint64(VERSION.SEASON_ID, u64(r.seasonId, "seasonId"), true);
  v.setUint16(VERSION.VERSION, LAYOUT_VERSION_1, true);
  const nb = nameBytes(r.name);
  v.setUint8(VERSION.NAME_LEN, nb.length);
  v.setUint8(VERSION.FLAGS, r.derivedFromHash ? 1 : 0);
  const [a, b, c] = versionTriple(r.version);
  v.setUint32(VERSION.MAJOR, a, true);
  v.setUint32(VERSION.MINOR, b, true);
  v.setUint32(VERSION.PATCH, c, true);
  out.set(key32(r.author, "author"), VERSION.AUTHOR);
  out.set(nb, VERSION.NAME);
  out.set(key32(r.hash, "hash"), VERSION.CONTENT_HASH);
  if (r.derivedFromHash) out.set(key32(r.derivedFromHash, "derivedFromHash"), VERSION.DERIVED_FROM_HASH);
  v.setBigUint64(VERSION.PUBLISHED_SLOT, u64(r.publishedSlot, "publishedSlot"), true);
  v.setUint32(VERSION.PUBLISHED_DAY, u32(r.publishedDay ?? 0, "publishedDay"), true);
  return out;
}

export function decodeVersion(bytes) {
  const v = header(bytes, VERSION.MAGIC, VERSION.SIZE);
  const flags = bytes[VERSION.FLAGS];
  if (flags & ~1) throw new RecordError("RECORD_CORRUPT", { detail: "flags" });
  const derived = bytes.subarray(VERSION.DERIVED_FROM_HASH, VERSION.DERIVED_FROM_HASH + 32);
  if (!(flags & 1) && derived.some((x) => x !== 0)) throw new RecordError("RECORD_CORRUPT", { detail: "derived_from without its flag" });
  reservedZero(bytes, VERSION.RESERVED, VERSION.SIZE);
  return {
    kind: "version",
    seasonId: safe(v.getBigUint64(VERSION.SEASON_ID, true), "seasonId"),
    name: readName(bytes, VERSION.NAME_LEN, VERSION.NAME),
    version: `${v.getUint32(VERSION.MAJOR, true)}.${v.getUint32(VERSION.MINOR, true)}.${v.getUint32(VERSION.PATCH, true)}`,
    author: toHex(bytes.subarray(VERSION.AUTHOR, VERSION.AUTHOR + 32)),
    hash: toHex(bytes.subarray(VERSION.CONTENT_HASH, VERSION.CONTENT_HASH + 32)),
    derivedFromHash: flags & 1 ? toHex(derived) : null,
    publishedSlot: safe(v.getBigUint64(VERSION.PUBLISHED_SLOT, true), "publishedSlot"),
    publishedDay: v.getUint32(VERSION.PUBLISHED_DAY, true),
  };
}

/** Decode either account by its magic. */
export function decodeRecord(bytes) {
  const m = bytes instanceof Uint8Array && bytes.length >= 8 ? readMagic(bytes) : "";
  if (m === ENTRY.MAGIC) return decodeEntry(bytes);
  if (m === VERSION.MAGIC) return decodeVersion(bytes);
  throw new RecordError("RECORD_CORRUPT", { detail: "unknown magic" });
}

// ------------------------------------------------------------ seeds

/**
 * Seeds in the frontier-abi style (`tag ‖ hex(raw)`, at most 32 chars, so a
 * with-seed address of the world's Season PDA can carry it): 15 raw bytes.
 * The entry's raw key is the first 15 bytes of
 * sha256("wylls.creation.entry/1" ‖ author ‖ name); a version's is the
 * first 15 bytes of sha256("wylls.creation.version/1" ‖ that whole 32-byte
 * entry hash ‖ major ‖ minor ‖ patch as u32 LE). (verify-pr329: an earlier
 * draft kept only 3 bytes of the entry hash, so anyone could grind a name of
 * their own whose 3 bytes match a victim's and take the victim's version
 * accounts first; 120 hashed bits make that infeasible.)
 *
 * Locally the seed itself is the address (`local:<seed>`): the real address
 * needs the Season PDA and the program id, which a world-4 build defines.
 */
function entryKey(author, name) {
  const pre = utf8("wylls.creation.entry/1");
  const a = key32(author, "author");
  const n = nameBytes(name);
  const buf = new Uint8Array(pre.length + 32 + n.length);
  buf.set(pre, 0); buf.set(a, pre.length); buf.set(n, pre.length + 32);
  return sha256(buf);
}

export function entrySeed(author, name) {
  return ENTRY.SEED_TAG + toHex(entryKey(author, name).subarray(0, 15));
}

export function versionSeed(author, name, version) {
  const pre = utf8("wylls.creation.version/1");
  const buf = new Uint8Array(pre.length + 32 + 12);
  buf.set(pre, 0);
  buf.set(entryKey(author, name), pre.length);
  const v = new DataView(buf.buffer);
  const [a, b, c] = versionTriple(version);
  const at = pre.length + 32;
  v.setUint32(at, a, true); v.setUint32(at + 4, b, true); v.setUint32(at + 8, c, true);
  return VERSION.SEED_TAG + toHex(sha256(buf).subarray(0, 15));
}

export const LOCAL_ADDRESS_PREFIX = "local:";
export const entryAddress = (author, name) => LOCAL_ADDRESS_PREFIX + entrySeed(author, name);
export const versionAddress = (author, name, version) => LOCAL_ADDRESS_PREFIX + versionSeed(author, name, version);
