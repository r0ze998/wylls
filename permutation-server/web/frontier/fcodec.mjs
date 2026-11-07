// Account decoding from raw bytes, driven by the generated layout tables
// (abi.mjs, from frontier-abi's vectors). The client decodes the bytes the
// herald serves itself and never trusts the herald's decoded JSON for
// anything it signs or verifies (contract §9.2).
//
// decode('Season', bytes) → {kind, …fields} with camelCase names; u64/i64
// as BigInt, smaller integers as numbers, byte arrays as Uint8Array,
// sub-records as objects (arrays of them for ×N). Reserved bytes are left
// out. The magic, the size and (when given) the season id are checked.
import { ACCOUNTS, RECORDS } from './abi.mjs';
import { LAYOUTS as V2 } from '../sdk/frontier/abi-v2-layouts.mjs';
const fields = xs => xs.map(x => [x.name, x.off, x.len, x.ty]);
const ACCOUNTS_V2 = Object.fromEntries(V2.accounts.map(x => [x.kind, { ...x, fields: fields(x.fields) }]));
const RECORDS_V2 = { ...RECORDS, ...Object.fromEntries(V2.records.map(x => [x.name, { ...x, fields: fields(x.fields) }])) };
const SEASON_CQ_V2 = ACCOUNTS_V2.Season.fields.find(f => f[0] === 'CONQUEST_PARAMS');
const CQ_V2 = RECORDS_V2.ConquestParams;

/** 'GENESIS_TS' → 'genesisTs'. */
export const camel = name => name.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

export class CodecError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const SCALAR = {
  u8: [1, (dv, o) => dv.getUint8(o)],
  u16: [2, (dv, o) => dv.getUint16(o, true)],
  u32: [4, (dv, o) => dv.getUint32(o, true)],
  u64: [8, (dv, o) => dv.getBigUint64(o, true)],
  i16: [2, (dv, o) => dv.getInt16(o, true)],
  i32: [4, (dv, o) => dv.getInt32(o, true)],
  i64: [8, (dv, o) => dv.getBigInt64(o, true)],
};

function readField(bytes, dv, base, [, off, len, ty], records = RECORDS) {
  const o = base + off;
  if (SCALAR[ty]) return SCALAR[ty][1](dv, o);
  let m = /^\[u8;(\d+)\]$/.exec(ty);
  if (m) return bytes.slice(o, o + +m[1]);
  m = /^\[(u16|u32|u64|i64);(\d+)\]$/.exec(ty);
  if (m) {
    const [w, rd] = SCALAR[m[1]];
    return Array.from({ length: +m[2] }, (_, i) => rd(dv, o + i * w));
  }
  m = /^rec:(\w+) x(\d+)$/.exec(ty);
  if (m) {
    const rec = records[m[1]];
    if (!rec) throw new CodecError('BadLayout', `no record ${m[1]}`);
    const n = +m[2];
    if (rec.size * n !== len) throw new CodecError('BadLayout', `${m[1]} x${n} is not ${len} B`);
    const one = i => readRecord(bytes, dv, o + i * rec.size, rec, records);
    return n === 1 ? one(0) : Array.from({ length: n }, (_, i) => one(i));
  }
  throw new CodecError('BadLayout', `unknown type ${ty}`);
}

function readRecord(bytes, dv, base, layout, records) {
  const out = {};
  for (const f of layout.fields) if (f[3] !== 'rsv') out[camel(f[0])] = readField(bytes, dv, base, f, records);
  return out;
}

/** A malformed world flag must not make a continuous account look finite. */
function checkWorldMode(bytes, season) {
  const mode = season.conquestParams?.continuous;
  if (mode !== 0 && mode !== 1) throw new CodecError('BadWorldMode', 'unknown continuous-world flag');
  const placement = season.conquestParams?.placement;
  if (placement !== 0 && placement !== 1) throw new CodecError('BadWorldMode', 'unknown placement mode');
  const base = SEASON_CQ_V2?.[1];
  if (base === undefined || !CQ_V2) throw new CodecError('BadLayout', 'missing conquest block');
  for (const [, off, len, ty] of CQ_V2.fields) {
    if (ty === 'rsv' && bytes.subarray(base + off, base + off + len).some(b => b !== 0)) {
      throw new CodecError('BadWorldMode', 'reserved conquest bytes are nonzero');
    }
  }
  if (mode === 1 && season.endBell !== 0xffffffff) {
    throw new CodecError('BadWorldMode', 'continuous world has an end bell');
  }
}

const text = b => String.fromCharCode(...b);

/**
 * Decode one account. `seasonId` (string, number or BigInt), when given,
 * must equal the header's. Throws CodecError (`WrongKind`, `WrongSize`,
 * `WrongMagic`, `WrongSeason`).
 */
export function decode(kind, bytes, { seasonId, profile } = {}) {
  const raw = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (profile === undefined) profile = (ACCOUNTS_V2[kind] ?? ACCOUNTS[kind])?.chained && raw[16] === 2 && raw[17] === 0 ? 2 : 1;
  const layout = (profile >= 2 ? ACCOUNTS_V2 : ACCOUNTS)[kind];
  const records = profile >= 2 ? RECORDS_V2 : RECORDS;
  if (!layout) throw new CodecError('WrongKind', `unknown account kind ${kind}`);
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  // A closed Season is a 128-byte tombstone (contract §5.2).
  if (b.length !== layout.size && !(kind === 'Season' && b.length === 128)) throw new CodecError('WrongSize', `${kind}: ${b.length} B, expected ${layout.size}`);
  if (text(b.subarray(0, 8)) !== layout.magic) throw new CodecError('WrongMagic', `${kind}: magic ${JSON.stringify(text(b.subarray(0, 8)))}`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = { kind };
  for (const f of layout.fields) {
    if (f[3] === 'rsv' || f[1] + f[2] > b.length) continue;
    out[camel(f[0])] = readField(b, dv, 0, f, records);
  }
  if (kind === 'Season' && b.length === layout.size) {
    const layoutV2 = out.layoutVersion >= 2;
    const programV2 = out.programVersion >= 3;
    if (layoutV2 !== programV2 || layoutV2 !== (profile >= 2)) {
      throw new CodecError('BadWorldMode', 'Season layout and program versions disagree');
    }
    if (layoutV2) checkWorldMode(b, out);
  }
  if (seasonId !== undefined && seasonId !== null && out.seasonId !== BigInt(String(seasonId))) {
    throw new CodecError('WrongSeason', `${kind}: season ${out.seasonId}, expected ${seasonId}`);
  }
  return out;
}

/**
 * The fields of a layout read off the head of a longer record, with no magic, size or season check of its own
 * (`bytes` must at least cover the layout). For records that keep a deployed layout as their prefix under a magic
 * of their own, e.g. the experimental wide holding (fwide.mjs: the whole Holding v2 layout plus a trailer): the
 * caller checks that record's magic, exact size and identity itself. Never a substitute for `decode`.
 */
export function decodePrefix(kind, bytes, { profile = 2 } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const layout = profile >= 2 ? ACCOUNTS_V2[kind] ?? ACCOUNTS[kind] : ACCOUNTS[kind];
  const records = profile >= 2 ? RECORDS_V2 : RECORDS;
  if (!layout) throw new CodecError('WrongKind', `unknown account kind ${kind}`);
  if (b.length < layout.size) throw new CodecError('WrongSize', `${kind} prefix: ${b.length} B, at least ${layout.size} needed`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = { kind };
  for (const f of layout.fields) if (f[3] !== 'rsv') out[camel(f[0])] = readField(b, dv, 0, f, records);
  return out;
}

/** The byte range of a field: [offset, length] (for checks that compare raw bytes). */
export function fieldRange(kind, name) {
  const f = ACCOUNTS[kind]?.fields.find(x => x[0] === name);
  if (!f) throw new CodecError('BadLayout', `${kind}.${name}`);
  return [f[1], f[2]];
}

// ------------------------------------------------------------------ season helpers (§5.3, §5.1)
export const SEASON_STATUS = Object.freeze(['Announced', 'Created', 'Seeded', 'Running', 'Ended', 'Closed', 'Aborted']);
export const NO_WINDOW_CHANGE = 0xffffffff;

/** The effective status at chain time `now` (s): Running is never stored (Seeded ∧ now ≥ genesis_ts). */
export function effectiveStatus(season, now) {
  const s = SEASON_STATUS[season.status] ?? 'Unknown';
  if (s === 'Seeded' && season.genesisTs !== undefined && BigInt(Math.floor(now)) >= season.genesisTs) return 'Running';
  return s;
}

/** W(b): `window_next` once a scheduled change applies, else `reveal_window`. */
export const windowAt = (season, b) => (season.windowFromBell !== NO_WINDOW_CHANGE && b >= season.windowFromBell ? season.windowNext : season.revealWindow);
