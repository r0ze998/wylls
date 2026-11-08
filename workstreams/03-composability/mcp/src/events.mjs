// The caravan records of the program's PS2 log (frontier-abi v2/log.rs),
// decoded from the herald's `/h/events` bodies with the generated layout
// table (abi-v2-logs.mjs), so the server never trusts a decoded copy:
//
//   body = version u8 ‖ kind u8 ‖ bell u32 ‖ key ‖ payload ‖ tail
//
// Only the three kinds a caravan's fate needs are read: CARAVAN_SENT (91),
// CARAVAN_SETTLED (92) and CARAVAN_RAIDED (93), keyed by (owner_tag, seq).
import { LOGS } from '../../../../permutation-gateway/client/src/frontier/abi-v2-logs.mjs';
import { fromBase64 } from '../../../../permutation-gateway/client/src/bytes.mjs';

const WANT = ['CARAVAN_SENT', 'CARAVAN_SETTLED', 'CARAVAN_RAIDED'];
const SPEC = Object.fromEntries(LOGS.kinds.filter(k => WANT.includes(k.name)).map(k => [k.kind, k]));
export const KINDS = Object.freeze(Object.fromEntries(Object.values(SPEC).map(k => [k.name, k.kind])));

/** caravan_outcome (frontier-abi v2/log.rs). */
export const SETTLE_OUTCOME = Object.freeze({ 0: 'delivered', 1: 'lost' });
/** raid_choice (frontier-abi v2/log.rs). */
export const RAID_CHOICE = Object.freeze({ 0: 'taken', 1: 'burned' });

const leUint = (b, o, n) => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };

function fields(list, b, at) {
  const out = {};
  let o = at;
  for (const f of list) {
    const s = b.subarray(o, o + f.len);
    if (s.length !== f.len) throw new Error('short record');
    out[f.name] = [1, 2, 4, 8].includes(f.len) ? leUint(b, o, f.len) : Uint8Array.from(s);
    o += f.len;
  }
  return { out, end: o };
}

/** One body (Uint8Array) → `{kind, name, bell, ownerTag, seq, payload}` for a caravan kind, else null. */
export function decodeCaravanRecord(body) {
  const b = Uint8Array.from(body);
  if (b.length < 6 || b[0] !== 1) return null;
  const spec = SPEC[b[1]];
  if (!spec) return null;
  const bell = Number(leUint(b, 2, 4));
  const key = fields(spec.key, b, 6);
  const payload = fields(spec.payload, b, key.end);
  return { kind: spec.kind, name: spec.name, bell, ownerTag: key.out.owner_tag.toString(), seq: Number(key.out.seq), payload: payload.out };
}

/** A herald `/h/events` row → the decoded caravan record (null for any other kind or an unreadable body). */
export function caravanEvent(row) {
  try {
    const r = decodeCaravanRecord(fromBase64(String(row.body_b64 ?? '')));
    return r && { ...r, eventSeq: String(row.seq), signature: row.sig ?? null };
  } catch {
    return null;
  }
}

/** The cargo field (32 bytes: eight u32 whole units). */
export const cargoOf = bytes => Array.from({ length: 8 }, (_, i) => Number(leUint(bytes, 4 * i, 4)));

export { SPEC as CARAVAN_SPECS };

/** A log_place field (8 bytes, read as a little-endian integer): `{kind, p, q, at, gen, tile}` (caravan.rs Place::log). */
export function placeOfLog(v) {
  const b = Array.from({ length: 8 }, (_, i) => Number((BigInt(v) >> BigInt(8 * i)) & 0xffn));
  const i16 = (lo, hi) => { const x = lo | (hi << 8); return x >= 0x8000 ? x - 0x10000 : x; };
  return { kind: b[0], p: i16(b[1], b[2]), q: i16(b[3], b[4]), at: b[5], gen: b[6], tile: b[7] };
}

