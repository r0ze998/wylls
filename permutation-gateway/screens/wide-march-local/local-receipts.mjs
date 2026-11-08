// Independent recomputation of the wide event chains from the receipts a LOCAL host emits.
//
// A strict port of frontier-abi `world_index/event.rs` (PSW1 body codec, `next_head`, `advance`, `verify_chain`,
// `WideRecord::{concerns, province_of, holding_of}`), with the exact key rules it calls (`key.rs`
// `ProvinceKey`/`WideHostRef::from_bytes`, `coord.rs` `WideCoord::from_sort_key`, `economy.rs` `decode_key` and
// `EconomyReceipt::decode`) and the chained header H of `layout/mod.rs` (EVENT_SEQ @24 LE u64, EVENT_HEAD @32).
// Pure: no DOM, no network, no key, no signature. Hashing is the SDK's synchronous SHA-256. Every integer that can
// exceed 2^53 (sequences, ring coordinates) is a BigInt.
//
// WHAT THIS VERIFIES (verifyReceiptChains):
//   - every receipt decodes strictly under version 0x82 (0x81 refused by name, any other version refused), a known
//     kind, the kind's exact key and payload widths, canonical keys, an economy payload of exactly its kind, and a
//     tail that is exactly the kind's link set in ascending entity order with nothing after it;
//   - for every chain account the caller DECLARES (entity + full identity + its 64-byte header before and after, or
//     an explicit `null` for absent): the header's magic, layout version and reserved bytes; an unchanged identity
//     (magic, season id, layout version) when it exists on both sides; and that walking ALL receipts with the ABI's
//     `verify_chain` from the before header (a fresh `(0, zero)` header when it is created) lands exactly on the
//     after header. An untouched chain must therefore be byte-identical in seq and head;
//   - account removal only as the ABI allows: a province whose chain ends in its own ProvinceClosed record (the
//     terminal record, nothing consumed after it); a holding has no close record in the ABI, so it can never vanish;
//   - coverage: every link of every receipt belongs to a declared chain, or to an identity the caller lists
//     explicitly as unverified (reported back, never counted as verified); every receipt that chains nothing
//     (RosterClosed, Revealed, Gathered, RecordClosed, TransitClosed) is of a kind the caller explicitly permits;
//   - optionally, the exact sequence of receipt kinds.
// WHAT IT DOES NOT VERIFY: the payload's facts (troops, digests, escrow, seal roots) beyond their canonical shape;
// the resolve/economy digests (they need the whole Season, roster and inputs bytes); that a header belongs to the
// account the caller says it does (the caller maps accounts to identities); that any receipt was authorised,
// signed or executed on a chain; the order of receipts of unrelated chains relative to each other.
import { sha256 } from '../../../permutation-server/web/sdk/sha256.mjs';
import { WIDE_BOUND, ringPosition, parseWideInt } from '../../../permutation-server/web/frontier/map/wide.mjs';

export class ReceiptError extends Error {
  constructor(code, detail = null) { super(detail === null ? code : `${code}: ${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail = null) => { throw new ReceiptError(code, detail); };

// ------------------------------------------------------------------ ABI constants (event.rs, key.rs, layout)
export const WIDE_LOG_PREFIX = 'PSW1';
export const WIDE_EVENT_VERSION = 0x82;
export const WIDE_EVENT_VERSION_RETIRED = 0x81;
export const WIDE_CHAIN_DOMAIN = 'PSF-WIDE-CHAIN-v1';
export const HEAD_LEN = 6;
export const LINK_LEN = 1 + 8 + 32;
export const MAX_LINKS = 2;
export const PROVINCE_KEY_LEN = 50;
export const HOST_REF_LEN = 56;
export const HOST_KEY_LEN = HOST_REF_LEN + PROVINCE_KEY_LEN;
export const HOLDING_KEY_LEN = HOST_REF_LEN;
export const ECONOMY_PAYLOAD_LEN = 80;
export const DEPARTED_PAYLOAD_LEN = 1 + 4 + 4 + 4 + 2 + 8 + 8 + 8 + 32;
export const TRANSIT_SETTLED_PAYLOAD_LEN = 1 + 1 + 1 + 4 + 8 + 8 + 8 + 1 + PROVINCE_KEY_LEN;
export const TRANSIT_SETTLED_DEST_AT = 1 + 1 + 1 + 4 + 8 + 8 + 8 + 1;
export const MAX_BODY = HEAD_LEN + HOST_KEY_LEN + TRANSIT_SETTLED_PAYLOAD_LEN + 1 + MAX_LINKS * LINK_LEN;
export const ENTITY = Object.freeze({ PROVINCE: 1, HOLDING: 2 });
/** Chained header H (layout/mod.rs `header`) and the wide layout version (world_index/land.rs WIDE_LAYOUT_VERSION). */
export const HEADER = Object.freeze({ SIZE: 64, MAGIC: 0, SEASON_ID: 8, LAYOUT_VERSION: 16, RESERVED: 18, EVENT_SEQ: 24, EVENT_HEAD: 32 });
export const WIDE_LAYOUT_VERSION = 3;
/** The magic of each chained wide entity's account (holding.rs, land.rs). */
export const CHAINED_MAGIC = Object.freeze({ [ENTITY.PROVINCE]: 'PSFXWPV1', [ENTITY.HOLDING]: 'PSFXWHL1' });
/** Input bounds of this module (not ABI rules): the protocol's record list bound and a small chain table. */
export const MAX_RECORDS = 256, MAX_CHAINS = 32, MAX_UNVERIFIED = 32;

const KEY_VERSION = 1, WORLD_LEN = 32, SORT_KEY_LEN = 17, SITES = 12, EMPTY_GEN = 0xff, FIRST_WIDE_RING = 129n;
const U64_MAX = (1n << 64n) - 1n;
const ZERO_HEAD = '00'.repeat(32);
// economy.rs
const ACTION_LEN = 6, RECEIPT_VERSION = 1, TAG_HARVEST = 0, TAG_BUILD = 1, TAG_TRAIN = 2;
const BUILD_ITEM_WALLS = 6, BUILD_ITEM_TIER_UP = 7, BUILD_ITEM_MAX = 8, TRAIN_UNITS = 7;

const PH = Object.freeze([ENTITY.PROVINCE, ENTITY.HOLDING]), P = Object.freeze([ENTITY.PROVINCE]);
const H = Object.freeze([ENTITY.HOLDING]), NONE = Object.freeze([]);
const kind = (code, name, payloadLen, links, keyClass) => Object.freeze({
  code, name, payloadLen, links, keyClass,
  keyLen: keyClass === 'host' ? HOST_KEY_LEN : keyClass === 'holding' ? HOLDING_KEY_LEN : PROVINCE_KEY_LEN,
});
/** WideKind: code → {name, payload width, exact link set, key class}. */
export const KINDS = Object.freeze({
  1: kind(1, 'WIDE_MUSTER', 1 + 4 + 1 + 1 + 8, PH, 'host'),
  2: kind(2, 'WIDE_DISSOLVE', 4 + 4 + 1, PH, 'host'),
  3: kind(3, 'WIDE_RESOLVE', 32 + 32 + 4 + 1 + 1 + 1, P, 'province'),
  4: kind(4, 'WIDE_RETURN', 4 + 1 + 1, PH, 'host'),
  5: kind(5, 'WIDE_STRANDED', 4 + 1, P, 'host'),
  6: kind(6, 'WIDE_ROSTER_CLOSED', 32 + 8, NONE, 'province'),
  7: kind(7, 'WIDE_DEPARTED', DEPARTED_PAYLOAD_LEN, PH, 'host'),
  8: kind(8, 'WIDE_TRANSIT_SETTLED', TRANSIT_SETTLED_PAYLOAD_LEN, PH, 'host'),
  9: kind(9, 'WIDE_DEPARTURE_SETTLED', 1 + 1 + 4 + 2 + 2 + 1, PH, 'host'),
  10: kind(10, 'WIDE_REVEALED', 1 + 1 + 1 + 1 + 1 + 2 + 4 + 1, NONE, 'host'),
  11: kind(11, 'WIDE_GATHERED', 4 + 1 + 1 + 4 + 1 + 1, NONE, 'province'),
  12: kind(12, 'WIDE_RECORD_CLOSED', 1 + 4 + 1 + 1 + 32 + 8, NONE, 'province'),
  13: kind(13, 'WIDE_TRANSIT_CLOSED', 1 + 32 + 8, NONE, 'host'),
  14: kind(14, 'WIDE_PROVINCE_CLOSED', 32 + 8, P, 'province'),
  15: kind(15, 'WIDE_ECONOMY', ECONOMY_PAYLOAD_LEN, H, 'holding'),
  16: kind(16, 'WIDE_ECONOMY_MIRROR', ECONOMY_PAYLOAD_LEN, PH, 'holding'),
});
export const KIND = Object.freeze({
  MUSTER: 1, DISSOLVE: 2, RESOLVE: 3, RETURN: 4, STRANDED: 5, ROSTER_CLOSED: 6, DEPARTED: 7, TRANSIT_SETTLED: 8,
  DEPARTURE_SETTLED: 9, REVEALED: 10, GATHERED: 11, RECORD_CLOSED: 12, TRANSIT_CLOSED: 13, PROVINCE_CLOSED: 14,
  ECONOMY: 15, ECONOMY_MIRROR: 16,
});
/** The kinds that chain no entity: always "non-chain" records, attributed but never consumed by verify_chain. */
export const NON_CHAIN_KINDS = Object.freeze(Object.values(KINDS).filter(k => k.links.length === 0).map(k => k.code));

// ------------------------------------------------------------------ bytes
const HEX_RE = /^(?:[0-9a-f]{2})*$/;
const toHex = b => { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; };
function fromHex(s, what, { exact = null, max }) {
  if (typeof s !== 'string') fail('Hex', `${what} is not a hex string`);
  if (s.length > 2 * max) fail('Bounds', `${what} longer than ${max} bytes`);
  if (!HEX_RE.test(s)) fail('Hex', `${what} is not lowercase even-length hex`);
  if (exact !== null && s.length !== 2 * exact) fail('Hex', `${what} is not ${exact} bytes`);
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return b;
}
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64le = (b, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
const u64be = (b, o) => { let v = 0n; for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[o + i]); return v; };
const le64 = v => { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn); return b; };
const be64 = v => { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[7 - i] = Number((v >> BigInt(8 * i)) & 0xffn); return b; };
const isU64 = v => typeof v === 'bigint' && v >= 0n && v <= U64_MAX;
const absBig = x => (x < 0n ? -x : x);
const allZero = b => b.every(x => x === 0);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function onlyKeys(x, allowed, what) {
  if (!obj(x)) fail('BadInput', `${what} is not an object`);
  for (const k of Object.keys(x)) if (!allowed.includes(k)) fail('BadInput', `${what} has an unknown field ${k}`);
}

// ------------------------------------------------------------------ keys (coord.rs, key.rs, economy.rs)
/** `WideCoord::from_sort_key` (via `from_ring_position`): canonical bytes only, within ±2^62. Throws code 'Key'. */
function coordFromSortKey(b, o) {
  const ring = u64be(b, o), wedge = b[o + 8], pos = u64be(b, o + 9);
  if (wedge >= 6) fail('Key', 'sort key: wedge ≥ 6');
  if (ring === 0n) {
    if (wedge === 0 && pos === 0n) return { p: 0n, q: 0n, ring };
    fail('Key', 'sort key: ring 0 with a wedge or position');
  }
  if (pos >= ring) fail('Key', 'sort key: position ≥ ring');
  let a = ring - pos, c = pos;
  for (let i = 0; i < wedge; i++) [a, c] = [-c, a + c];
  if (absBig(a) > WIDE_BOUND || absBig(c) > WIDE_BOUND) fail('Key', 'sort key: outside ±2^62');
  const rp = ringPosition(a, c);
  if (rp.ring !== ring || rp.wedge !== wedge || rp.pos !== pos) fail('Key', 'sort key: not canonical');
  return { p: a, q: c, ring };
}
/** `ProvinceKey::from_bytes` over exactly 50 bytes at `o`. */
function provinceKeyAt(b, o) {
  if (b.length - o !== PROVINCE_KEY_LEN) fail('Key', 'province key length');
  if (b[o] !== KEY_VERSION) fail('Key', 'province key version');
  const world = b.subarray(o + 1, o + 1 + WORLD_LEN);
  if (allZero(world)) fail('Key', 'reserved world');
  const c = coordFromSortKey(b, o + 1 + WORLD_LEN);
  return { hex: toHex(b.subarray(o, o + PROVINCE_KEY_LEN)), worldHex: toHex(world), p: c.p, q: c.q, ring: c.ring };
}
/** `WideHostRef::from_bytes` over exactly 56 bytes at `o`. */
function hostRefAt(b, o) {
  if (b.length - o !== HOST_REF_LEN) fail('Key', 'host reference length');
  if (b[o] !== KEY_VERSION) fail('Key', 'host reference version');
  const world = b.subarray(o + 1, o + 1 + WORLD_LEN);
  if (allZero(world)) fail('Key', 'reserved world');
  const s = o + 1 + WORLD_LEN, c = coordFromSortKey(b, s);
  const site = b[s + SORT_KEY_LEN], gen = b[s + SORT_KEY_LEN + 1], seq = u32le(b, s + SORT_KEY_LEN + 2);
  if (site >= SITES) fail('Key', 'site ≥ 12');
  const hex = toHex(b.subarray(o, o + HOST_REF_LEN));
  return { hex, worldHex: toHex(world), p: c.p, q: c.q, ring: c.ring, site, gen, seq, holdingHex: hex.slice(0, 2 * (HOST_REF_LEN - 4)) + '00000000' };
}
/** `economy::check_holding_ref`: sequence 0, a live generation, a wide ring. */
function checkHoldingRef(h) {
  if (h.seq !== 0) fail('Key', 'a holding reference has sequence 0');
  if (h.gen === 0 || h.gen === EMPTY_GEN) fail('Key', 'holding generation 0 or 0xFF');
  if (h.ring < FIRST_WIDE_RING) fail('Key', 'holding below the first wide ring');
  return h;
}
/** `EconomyReceipt::decode` → the kind its action belongs under (`Action::kind`). Throws code 'Payload'. */
function economyReceiptKind(p) {
  if (p.length !== ECONOMY_PAYLOAD_LEN) fail('Payload', 'receipt length');
  if (p[0] !== RECEIPT_VERSION) fail('Payload', 'receipt version');
  const a = p.subarray(1, 1 + ACTION_LEN);
  let mirror = false;
  if (a[0] === TAG_HARVEST) { if (!allZero(a.subarray(1))) fail('Payload', 'harvest padding'); }
  else if (a[0] === TAG_BUILD) {
    if (!allZero(a.subarray(2))) fail('Payload', 'build padding');
    if (a[1] > BUILD_ITEM_MAX) fail('Payload', 'build item');
    mirror = a[1] === BUILD_ITEM_WALLS || a[1] === BUILD_ITEM_TIER_UP;
  } else if (a[0] === TAG_TRAIN) {
    if (a[1] >= TRAIN_UNITS) fail('Payload', 'train unit');
    if (u32le(a, 2) === 0) fail('Payload', 'train count 0');
  } else fail('Payload', 'action tag');
  const flip = p[1 + ACTION_LEN + 8];
  if (flip !== 0 && flip !== 1) fail('Payload', 'became_final is not a bool');
  return mirror ? KIND.ECONOMY_MIRROR : KIND.ECONOMY;
}

// ------------------------------------------------------------------ record codec (WideRecord::decode, encode)
/** Decodes one PSW1 body. Internal form keeps the bytes the chain hashes. */
function decodeBody(b) {
  let at = 0;
  const take = n => { if (at + n > b.length) fail('Short'); const s = b.subarray(at, at + n); at += n; return s; };
  const ver = take(1)[0];
  if (ver === WIDE_EVENT_VERSION_RETIRED) fail('RetiredVersion', '0x81');
  if (ver !== WIDE_EVENT_VERSION) fail('Version', `0x${ver.toString(16).padStart(2, '0')}`);
  const k = take(1)[0], info = KINDS[k];
  if (!info) fail('UnknownKind', String(k));
  const bell = u32le(take(4), 0);
  const key = take(info.keyLen), payload = take(info.payloadLen);
  const bodyWithoutTail = b.slice(0, at);
  let host = null, standing = null, holding = null, province = null, sealedDest = null;
  if (info.keyClass === 'host') {
    host = hostRefAt(key.subarray(0, HOST_REF_LEN), 0);
    standing = provinceKeyAt(key, HOST_REF_LEN);
    if (host.worldHex !== standing.worldHex) fail('Key', 'host and standing province of different worlds');
    if (k === KIND.TRANSIT_SETTLED) {
      sealedDest = provinceKeyAt(payload, TRANSIT_SETTLED_DEST_AT);
      if (sealedDest.worldHex !== host.worldHex) fail('Key', 'sealed destination of another world');
    }
  } else if (info.keyClass === 'holding') {
    holding = checkHoldingRef(hostRefAt(key, 0));
    if (economyReceiptKind(payload) !== k) fail('Payload', 'receipt under the other economic kind');
  } else province = provinceKeyAt(key, 0);
  const n = take(1)[0];
  if (n > MAX_LINKS) fail('Tail', 'more than two links');
  const links = [];
  let last = 0;
  for (let i = 0; i < n; i++) {
    const e = take(1)[0];
    if (e !== ENTITY.PROVINCE && e !== ENTITY.HOLDING) fail('UnknownEntity', String(e));
    if (e <= last) fail('Tail', 'links not in ascending entity order');
    last = e;
    const seq = u64le(take(8), 0);
    links.push(Object.freeze({ entity: e, seq, headHex: toHex(take(32)) }));
  }
  if (at !== b.length) fail('Trailing');
  if (links.length !== info.links.length || links.some((l, i) => l.entity !== info.links[i])) fail('Links', 'tail is not the kind\'s link set');
  const keyHex = toHex(key);
  // attribution (WideRecord::province_of / holding_of), from the full key, never an alias
  const provinceHex = host ? standing.hex : holding ? '01' + keyHex.slice(2, 2 * PROVINCE_KEY_LEN) : province.hex;
  const holdingHex = holding ? keyHex : host ? host.holdingHex : null;
  const record = Object.freeze({
    kind: k, name: info.name, bell, chained: info.links.length > 0, chains: info.links,
    keyHex, payloadHex: toHex(payload), bodyHex: toHex(b),
    links: Object.freeze(links),
    provinceHex, holdingHex, hostHex: host ? host.hex : null,
    homeHex: host ? '01' + host.hex.slice(2, 2 * PROVINCE_KEY_LEN) : holding ? provinceHex : null,
    sealedDestHex: sealedDest ? sealedDest.hex : null,
  });
  return { record, bodyWithoutTail };
}
function bodyOf(input, what = 'record') {
  if (input instanceof Uint8Array) {
    if (input.length > MAX_BODY) fail('Bounds', `${what} longer than ${MAX_BODY} bytes`);
    return input.slice();
  }
  return fromHex(input, what, { max: MAX_BODY });
}
/** One PSW1 body (lowercase hex or bytes) → a frozen decoded record. Throws ReceiptError with the ABI's refusal
 * name as `code` (Short, Version, RetiredVersion, UnknownKind, UnknownEntity, Tail, Links, Trailing, Key, Payload),
 * or Hex/Bounds for an input that is not bounded hex. */
export function decodeRecord(input) { return decodeBody(bodyOf(input)).record; }

/** `event::encode` (write_body + write_tail): the same width, holding-key and receipt-kind checks, the tail exactly
 * the kind's link set in order. Like the ABI it does not validate host or province keys (decode does). */
export function encodeRecord({ kind: k, bell, keyHex, payloadHex, links }) {
  const info = KINDS[k];
  if (!info) fail('BadInput', 'unknown kind');
  if (!Number.isInteger(bell) || bell < 0 || bell > 0xffffffff) fail('BadInput', 'bell');
  const key = fromHex(keyHex, 'key', { max: HOST_KEY_LEN }), payload = fromHex(payloadHex, 'payload', { max: TRANSIT_SETTLED_PAYLOAD_LEN });
  if (key.length !== info.keyLen || payload.length !== info.payloadLen) fail('BadInput', 'width');
  if (info.keyClass === 'holding') {
    checkHoldingRef(hostRefAt(key, 0));
    if (economyReceiptKind(payload) !== k) fail('Payload', 'receipt under the other economic kind');
  }
  if (!Array.isArray(links) || links.length !== info.links.length || links.some((l, i) => !obj(l) || l.entity !== info.links[i])) fail('BadInput', 'links are not the kind\'s link set');
  const parts = [Uint8Array.of(WIDE_EVENT_VERSION, k, bell & 0xff, (bell >>> 8) & 0xff, (bell >>> 16) & 0xff, bell >>> 24), key, payload, Uint8Array.of(links.length)];
  for (const l of links) {
    if (!isU64(l.seq)) fail('BadInput', 'link seq');
    parts.push(Uint8Array.of(l.entity), le64(l.seq), fromHex(l.headHex, 'link head', { exact: 32, max: 32 }));
  }
  return parts.map(toHex).join('');
}

// ------------------------------------------------------------------ chain rule (next_head, advance, verify_chain)
const bytes32 = (x, what) => (x instanceof Uint8Array ? (x.length === 32 ? x : fail('BadInput', `${what} is not 32 bytes`)) : fromHex(x, what, { exact: 32, max: 32 }));
const entityOk = e => e === ENTITY.PROVINCE || e === ENTITY.HOLDING;
/** `next_head`: sha256(WIDE_CHAIN_DOMAIN ‖ entity ‖ LE64(seq') ‖ prev head ‖ body_without_tail) → 32 bytes. */
export function nextHead(entity, seqNext, prevHead, bodyWithoutTail) {
  if (!entityOk(entity)) fail('BadInput', 'entity');
  if (!isU64(seqNext)) fail('BadInput', 'seq is not a u64 BigInt');
  const bwt = bodyWithoutTail instanceof Uint8Array ? bodyWithoutTail : fromHex(bodyWithoutTail, 'body', { max: MAX_BODY });
  return sha256(WIDE_CHAIN_DOMAIN, Uint8Array.of(entity), le64(seqNext), bytes32(prevHead, 'head'), bwt);
}
/** `advance`: the chain after one record; throws 'Overflow' where the ABI returns None. */
export function advance(entity, seq, head, bodyWithoutTail) {
  if (!isU64(seq)) fail('BadInput', 'seq is not a u64 BigInt');
  if (seq === U64_MAX) fail('Overflow');
  const next = seq + 1n;
  return Object.freeze({ entity, seq: next, headHex: toHex(nextHead(entity, next, head, bodyWithoutTail)) });
}
function targetOf(t, { strictHolding }) {
  onlyKeys(t, ['entity', 'keyHex'], 'target');
  if (t.entity === ENTITY.PROVINCE) {
    const k = provinceKeyAt(fromHex(t.keyHex, 'province key', { exact: PROVINCE_KEY_LEN, max: PROVINCE_KEY_LEN }), 0);
    return { entity: ENTITY.PROVINCE, match: k.hex };
  }
  if (t.entity === ENTITY.HOLDING) {
    const h = hostRefAt(fromHex(t.keyHex, 'holding reference', { exact: HOST_REF_LEN, max: HOST_REF_LEN }), 0);
    if (strictHolding) checkHoldingRef(h);
    return { entity: ENTITY.HOLDING, match: h.holdingHex }; // WideTarget::Holding compares holding_ref()
  }
  return fail('BadInput', 'target entity');
}
const concerns = (rec, t) => (t.entity === ENTITY.PROVINCE ? rec.provinceHex === t.match : rec.holdingHex === t.match);
/** The walk of verify_chain over decoded records; returns the end and the consumed record indices. */
function walk(t, start, decoded, label) {
  let seq = start.seq, head = start.headHex;
  const consumed = [];
  decoded.forEach(({ record, bodyWithoutTail }, i) => {
    if (!concerns(record, t) || !record.chains.includes(t.entity)) return; // another account, or a kind that does not chain it
    const link = record.links.find(l => l.entity === t.entity);
    if (!link || seq === U64_MAX) fail('Chain', `${label} at seq ${seq} (record ${i})`);
    const want = advance(t.entity, seq, head, bodyWithoutTail);
    if (want.seq !== link.seq || want.headHex !== link.headHex) fail('Chain', `${label} at seq ${seq} (record ${i})`);
    seq = link.seq; head = link.headHex;
    consumed.push(i);
  });
  return { seq, headHex: head, consumed };
}
function decodeAll(bodies) {
  if (!Array.isArray(bodies) || bodies.length > MAX_RECORDS) fail('Bounds', `at most ${MAX_RECORDS} records`);
  return bodies.map((b, i) => {
    try { return decodeBody(bodyOf(b, `record ${i}`)); } catch (e) { if (e instanceof ReceiptError) e.index = i; throw e; }
  });
}
/** `verify_chain(target, start, bodies)`: `target` {entity, keyHex} (a province key, or any host reference, compared
 * by its holding reference as the ABI does); `start` {seq: BigInt, headHex}. Returns {seq, headHex, consumed}. */
export function verifyChain(target, start, bodies) {
  const t = targetOf(target, { strictHolding: false });
  onlyKeys(start, ['seq', 'headHex'], 'start');
  if (!isU64(start.seq)) fail('BadInput', 'start seq');
  bytes32(start.headHex, 'start head');
  return Object.freeze(walk(t, { seq: start.seq, headHex: start.headHex }, decodeAll(bodies), 'target'));
}

// ------------------------------------------------------------------ chained headers and accounts
const MAGIC_TEXT = b => String.fromCharCode(...b.subarray(0, 8));
/** A chained header H of `entity` (exactly 64 bytes, hex) → {seq, headHex, identityHex, seasonId}. */
export function parseChainHeader(headerHex, entity) {
  if (!entityOk(entity)) fail('BadInput', 'entity');
  const b = fromHex(headerHex, 'header', { exact: HEADER.SIZE, max: HEADER.SIZE });
  if (MAGIC_TEXT(b) !== CHAINED_MAGIC[entity]) fail('Header', `magic is not ${CHAINED_MAGIC[entity]}`);
  if (u16le(b, HEADER.LAYOUT_VERSION) !== WIDE_LAYOUT_VERSION) fail('Header', 'layout version');
  if (!allZero(b.subarray(HEADER.RESERVED, HEADER.EVENT_SEQ))) fail('Header', 'reserved header bytes');
  return Object.freeze({
    seq: u64le(b, HEADER.EVENT_SEQ), headHex: toHex(b.subarray(HEADER.EVENT_HEAD, HEADER.EVENT_HEAD + 32)),
    identityHex: toHex(b.subarray(0, HEADER.EVENT_SEQ)), seasonId: u64le(b, HEADER.SEASON_ID),
  });
}
const DEC_U64 = /^(0|[1-9][0-9]{0,19})$/;
/** A protocol account {keyHex, ownerHex, lamports, dataHex} → its 64-byte header hex, or `null` when it does not
 * exist (no data, no lamports, the zero owner: what the runtime holds for an absent key). Anything else (data under
 * another owner, an empty account holding lamports, fewer than 64 bytes) is refused, never guessed. */
export function chainHeaderOfAccount(account, { programOwnerHex }) {
  onlyKeys(account, ['keyHex', 'ownerHex', 'lamports', 'dataHex'], 'account');
  fromHex(account.keyHex, 'account key', { exact: 32, max: 32 });
  fromHex(account.ownerHex, 'account owner', { exact: 32, max: 32 });
  fromHex(programOwnerHex, 'program owner', { exact: 32, max: 32 });
  if (typeof account.lamports !== 'string' || !DEC_U64.test(account.lamports) || BigInt(account.lamports) > U64_MAX) fail('Account', 'lamports');
  if (typeof account.dataHex !== 'string' || account.dataHex.length > 2 * 1048576 || !HEX_RE.test(account.dataHex)) fail('Account', 'data');
  if (account.dataHex === '') {
    if (account.lamports === '0' && account.ownerHex === ZERO_HEAD) return null;
    fail('Account', 'an empty account that holds lamports or an owner');
  }
  if (account.ownerHex !== programOwnerHex) fail('Account', 'not owned by the program');
  if (account.dataHex.length < 2 * HEADER.SIZE) fail('Account', 'shorter than the chained header');
  return account.dataHex.slice(0, 2 * HEADER.SIZE);
}
/** The header of the one account with `keyHex` in `accounts` (null when absent as above). A key that is not in the
 * list is 'AccountMissing': the caller must decide explicitly whether a removed image means absent. */
export function chainHeaderFromAccounts(accounts, keyHex, opts) {
  if (!Array.isArray(accounts) || accounts.length > 256) fail('Bounds', 'accounts');
  const found = accounts.filter(a => obj(a) && a.keyHex === keyHex);
  if (found.length === 0) fail('AccountMissing', keyHex);
  if (found.length > 1) fail('Account', `duplicate account ${keyHex}`);
  return chainHeaderOfAccount(found[0], opts);
}
/** The 50-byte province key of (p, q) in `worldHex`, as hex (BigInt or canonical decimal coordinates). */
export function provinceKeyHex(worldHex, p, q) {
  const world = fromHex(worldHex, 'world', { exact: WORLD_LEN, max: WORLD_LEN });
  if (allZero(world)) fail('Key', 'reserved world');
  const coord = v => { if (typeof v === 'bigint') return v; try { return parseWideInt(v); } catch { return fail('Key', 'coordinate is not a canonical decimal'); } };
  const P_ = coord(p), Q_ = coord(q);
  if (absBig(P_) > WIDE_BOUND || absBig(Q_) > WIDE_BOUND) fail('Key', 'outside ±2^62');
  const rp = ringPosition(P_, Q_);
  return '01' + worldHex + toHex(be64(rp.ring)) + rp.wedge.toString(16).padStart(2, '0') + toHex(be64(rp.pos));
}
/** The 56-byte holding reference (sequence 0) of the holding at (p, q, site, gen), checked like an economy key. */
export function holdingRefHex(worldHex, p, q, site, gen) {
  if (!Number.isInteger(site) || site < 0 || site > 255 || !Number.isInteger(gen) || gen < 0 || gen > 255) fail('Key', 'site/gen');
  const hex = provinceKeyHex(worldHex, p, q) + site.toString(16).padStart(2, '0') + gen.toString(16).padStart(2, '0') + '00000000';
  checkHoldingRef(hostRefAt(fromHex(hex, 'holding reference', { exact: HOST_REF_LEN, max: HOST_REF_LEN }), 0));
  return hex;
}

// ------------------------------------------------------------------ one transition
const LABEL_RE = /^[\x20-\x7e]{1,64}$/;
/**
 * Verifies the receipts of ONE host transition against the declared chain accounts (see the module doc).
 *
 * @param {object} o
 * @param {string[]} o.records     the transition's PSW1 bodies, in emitted order (≤ 256)
 * @param {object[]} o.chains      1..32 of {label?, entity: 1|2, targetHex, before, after}; `before`/`after` are the
 *                                 64-byte header hex or an explicit `null` (absent). Both fields are required.
 * @param {number[]} [o.nonChainKinds]  kinds that chain nothing and are permitted here (e.g. [10] for a Reveal)
 * @param {object[]} [o.unverified]     {entity, keyHex} identities whose links are permitted but NOT verified
 * @param {number[]|null} [o.kinds]     the exact expected kind sequence, or null
 * @returns a frozen report: {records, chains: [{label, entity, targetHex, before, after, consumed, created, closed}],
 *          nonChainRecords, unverifiedLinks, verifies: 'WIDE_EVENT_CHAINS_ONLY'}
 */
export function verifyReceiptChains(o) {
  onlyKeys(o, ['records', 'chains', 'nonChainKinds', 'unverified', 'kinds'], 'options');
  const { records, chains, nonChainKinds = [], unverified = [], kinds = null } = o;
  const decoded = decodeAll(records);
  if (!Array.isArray(chains) || chains.length < 1 || chains.length > MAX_CHAINS) fail('BadInput', `1..${MAX_CHAINS} chains`);
  const declared = new Map();
  const table = chains.map((c, i) => {
    onlyKeys(c, ['label', 'entity', 'targetHex', 'before', 'after'], `chain ${i}`);
    if (!Object.hasOwn(c, 'before') || !Object.hasOwn(c, 'after')) fail('BadInput', `chain ${i}: before and after are both required (null for absent)`);
    const label = c.label ?? `chain ${i}`;
    if (typeof label !== 'string' || !LABEL_RE.test(label)) fail('BadInput', `chain ${i}: label`);
    const t = targetOf({ entity: c.entity, keyHex: c.targetHex }, { strictHolding: true });
    const id = `${t.entity}:${t.match}`;
    if (declared.has(id)) fail('BadInput', `${label}: declared twice`);
    declared.set(id, i);
    const header = h => (h === null ? null : parseChainHeader(h, t.entity));
    const before = header(c.before), after = header(c.after);
    if (!before && !after) fail('BadInput', `${label}: absent before and after`);
    if (before && after && before.identityHex !== after.identityHex) fail('Identity', `${label}: magic, season or layout changed`);
    return { label, t, before, after };
  });
  if (!Array.isArray(nonChainKinds) || nonChainKinds.length > NON_CHAIN_KINDS.length || new Set(nonChainKinds).size !== nonChainKinds.length
    || !nonChainKinds.every(k => NON_CHAIN_KINDS.includes(k))) fail('BadInput', 'nonChainKinds must be distinct kinds that chain nothing');
  if (!Array.isArray(unverified) || unverified.length > MAX_UNVERIFIED) fail('BadInput', 'unverified');
  const permitted = new Set(unverified.map(u => {
    const t = targetOf(u, { strictHolding: true }), id = `${t.entity}:${t.match}`;
    if (declared.has(id)) fail('BadInput', 'an unverified identity is also declared');
    return id;
  }));
  if (kinds !== null) {
    if (!Array.isArray(kinds) || kinds.length > MAX_RECORDS) fail('BadInput', 'kinds');
    const got = decoded.map(d => d.record.kind);
    if (got.length !== kinds.length || got.some((k, i) => k !== kinds[i])) fail('Kinds', `got [${got.join(',')}]`);
  }
  // coverage: every link of every record is declared or explicitly unverified; every non-chain record permitted
  const nonChainRecords = [], unverifiedLinks = [];
  decoded.forEach(({ record: r }, i) => {
    if (!r.chained) {
      if (!nonChainKinds.includes(r.kind)) fail('Unexpected', `record ${i}: ${r.name} is not permitted here`);
      nonChainRecords.push(i);
      return;
    }
    for (const e of r.chains) {
      const id = `${e}:${e === ENTITY.PROVINCE ? r.provinceHex : r.holdingHex}`;
      if (declared.has(id)) continue;
      if (!permitted.has(id)) fail('Undeclared', `record ${i}: ${r.name} chains an undeclared ${e === ENTITY.PROVINCE ? 'province' : 'holding'}`);
      unverifiedLinks.push(Object.freeze({ record: i, entity: e, keyHex: id.slice(2) }));
    }
  });
  // every declared chain: before (or a fresh header) → all records → after (or a terminal close)
  const out = table.map(({ label, t, before, after }) => {
    const start = before ? { seq: before.seq, headHex: before.headHex } : { seq: 0n, headHex: ZERO_HEAD };
    const end = walk(t, start, decoded, label);
    const closes = end.consumed.filter(i => decoded[i].record.kind === KIND.PROVINCE_CLOSED);
    if (after) {
      if (closes.length) fail('Closed', `${label}: closed by record ${closes[0]} but still present`);
      if (end.seq !== after.seq || end.headHex !== after.headHex) fail('ChainEnd', `${label}: receipts end at seq ${end.seq}, the account at seq ${after.seq}`);
    } else {
      if (t.entity !== ENTITY.PROVINCE) fail('NotClosed', `${label}: a holding has no close record in the ABI`);
      if (!closes.length) fail('NotClosed', `${label}: absent after, without its ProvinceClosed record`);
      if (end.consumed.at(-1) !== closes[0]) fail('ChainAfterClose', `${label}: records after its ProvinceClosed`);
    }
    return Object.freeze({
      label, entity: t.entity, targetHex: t.match,
      before: before ? Object.freeze({ seq: before.seq, headHex: before.headHex }) : null,
      after: after ? Object.freeze({ seq: after.seq, headHex: after.headHex }) : null,
      consumed: Object.freeze(end.consumed), created: !before, closed: !after,
    });
  });
  return Object.freeze({
    records: Object.freeze(decoded.map(d => d.record)), chains: Object.freeze(out),
    nonChainRecords: Object.freeze(nonChainRecords), unverifiedLinks: Object.freeze(unverifiedLinks),
    verifies: 'WIDE_EVENT_CHAINS_ONLY',
  });
}
