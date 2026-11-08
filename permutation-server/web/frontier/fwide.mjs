// The viewer's wide villages on the village screen, read-only (map growth;
// docs/frontier/map-growth/WIDE-HOLDING-VILLAGE-UI-20261108.md): the
// `/h/me` fields `wideContext` and `wideHoldings` parsed strictly, every
// fact re-read from the captured WideHolding bytes themselves (the herald's
// summary is checked, never believed), the whole inventory pinned to the
// Citizen the viewer *is* (the caller derives it from the wallet or the NFT
// played; the answer's own address is checked, never the only pin) and to
// the viewer's own Citizen bytes (the slot bindings), the page's wide state
// beside — never inside — `FS.holdings`, and the one guard that keeps a wide
// holding out of every legacy transaction path.
//
// What a wide village here is: a captured account (`captured-unverified`),
// as it stood at the capture's slot. It is not current state, not a proof of
// ownership, not a projection of production, and not a thing an order can
// reach: the only wide instructions are not enabled, and no legacy builder,
// trainer, muster, march, caravan or nudge may take a wide holding. A slot
// the Citizen binds wide whose record the fold has not captured is
// `not-captured`: unknown, never an empty slot and never zero.
//
// Precision: coordinates are BigInts from decimal strings and never pass
// through Number; amounts stay exact integers (decimal strings of the stored
// milli-units). Pure: no DOM, no fetch, nothing signed or sent.
import { fromBase64, toHex, utf8 } from '../sdk/bytes.mjs';
import { decode as fromB58, encode as toB58 } from '../sdk/base58.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { withSeed } from './faddr.mjs';
import { decodePrefix } from './fcodec.mjs';
import { RESOURCE_ORDER } from './resources.mjs';
import { parseWideInt, parseU64, ringPosition, worldIdOf, WideError, WIDE_BOUND, WORLD_DOMAIN } from './map/wide.mjs';
import { L } from '../lang.mjs';

export { WideError };

// ------------------------------------------------------------------ the record (frontier-abi world_index::holding)
/** The whole Holding v2 layout (1,280 B) plus the 64-byte wide trailer. */
export const WIDE_HOLDING_SIZE = 1344;
export const WIDE_HOLDING_MAGIC = 'PSFXWHL1';
export const WIDE_LAYOUT_VERSION = 3;
export const WIDE_FAMILY_VERSION = 1;
export const WIDE_STATUS_FOUNDED = 1;
/** The first ring past the legacy disk (R_MAX_HARD + 1). */
export const FIRST_WIDE_RING = 129n;
export const HOST_IDENTITY_UNALLOCATED = 0;
export const HOST_IDENTITY_FULL_REF_V1 = 1;
/** `sha256(HOLDING_SEED_DOMAIN ‖ sort key ‖ site)[..15]` under the tag `wh`. */
export const HOLDING_SEED_DOMAIN = 'PSF-WIDE-HOLDING-SEED-v1';
export const HOLDING_SEED_TAG = 'wh';
export const SORT_KEY_LEN = 17;
const T = 1280;
/** Trailer offsets (world_index::holding::wide_holding). */
export const TRAILER = Object.freeze({ FAMILY_VERSION: T, STATUS: T + 2, SLOT: T + 3, HOST_IDENTITY: T + 4, OPEN_TRANSITS: T + 6, RSV_7: T + 7, WORLD: T + 8, SORT_KEY: T + 40, RSV: T + 57, RSV_LEN: 7 });
/** Prefix offsets the identity check reads directly (the rest comes through the Holding v2 layout table). */
const PREFIX = Object.freeze({ SEASON_ID: 8, LAYOUT_VERSION: 16, P: 64, Q: 66, SITE: 68, GEN: 69, OWNER_CITIZEN: 72, HOST_SEQ: 132, TRANSIT: 784, TRANSIT_SIZE: 96, TRANSIT_N: 4, EXPLORE_STATE: 1168 + 18 });

const HEX64_RE = /^[0-9a-f]{64}$/;
const ZERO64 = '0'.repeat(64);
const check = (cond, code, msg) => { if (!cond) throw new WideError(code, msg ?? code); };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const abs = x => (x < 0n ? -x : x);

/** A base58 32-byte address, as given (never re-encoded: the comparison is textual and exact). */
function addressOf(s, code = 'BadWideRecord') {
  check(typeof s === 'string' && s.length >= 32 && s.length <= 44, code, 'address');
  let b;
  try { b = fromB58(s); } catch { throw new WideError(code, 'address'); }
  check(b.length === 32, code, 'address');
  return s;
}

// ------------------------------------------------------------------ coordinates ↔ sort key
/**
 * The coordinate a ring position names (the inverse of map/wide.mjs ringPosition, as frontier-abi
 * `WideCoord::from_ring_position`): the wedge-0 representative is (ring − pos, pos); each wedge back undoes one 60°
 * turn. Non-canonical positions (wedge ≥ 6, pos ≥ ring, a nonzero wedge or pos for ring 0, out of bounds) are refused.
 */
export function coordOfRingPosition(ring, wedge, pos) {
  check(typeof ring === 'bigint' && typeof pos === 'bigint' && Number.isInteger(wedge) && ring >= 0n && pos >= 0n, 'BadCoord', 'ring position');
  check(wedge >= 0 && wedge < 6, 'BadCoord', 'wedge');
  if (ring === 0n) { check(wedge === 0 && pos === 0n, 'BadCoord', 'the origin has one position'); return { p: 0n, q: 0n }; }
  check(pos < ring, 'BadCoord', 'position past the wedge');
  let a = ring - pos, b = pos;
  for (let k = 0; k < wedge; k++) [a, b] = [-b, a + b];
  check(abs(a) <= WIDE_BOUND && abs(b) <= WIDE_BOUND, 'BadCoord', 'out of bounds');
  const rp = ringPosition(a, b);
  check(rp.ring === ring && rp.wedge === wedge && rp.pos === pos, 'BadCoord', 'not canonical');
  return { p: a, q: b };
}

/** `ring ‖ wedge ‖ position` (u64 BE, u8, u64 BE), the record's 17-byte sort key of (p, q). */
export function sortKeyOf(p, q) {
  const rp = ringPosition(p, q);
  const k = new Uint8Array(SORT_KEY_LEN), dv = new DataView(k.buffer);
  dv.setBigUint64(0, rp.ring, false);
  k[8] = rp.wedge;
  dv.setBigUint64(9, rp.pos, false);
  return k;
}

/** The coordinate a 17-byte sort key names (refused when not canonical). */
export function coordOfSortKey(key) {
  check(key instanceof Uint8Array && key.length === SORT_KEY_LEN, 'BadCoord', 'sort key length');
  const dv = new DataView(key.buffer, key.byteOffset, key.byteLength);
  return coordOfRingPosition(dv.getBigUint64(0, false), key[8], dv.getBigUint64(9, false));
}

/** The with-seed seed of the wide holding at `site` of (p, q): `wh ‖ hex(sha256(domain ‖ sort key ‖ site)[..15])`. */
export function wideHoldingSeed(p, q, site) {
  const h = sha256(utf8(HOLDING_SEED_DOMAIN), sortKeyOf(p, q), Uint8Array.of(site));
  return HOLDING_SEED_TAG + toHex(h.slice(0, 15));
}
/** The canonical address of that holding: create_with_seed(season PDA, seed, program), public bytes only. */
export const wideHoldingAddress = (seasonAddress, programId, p, q, site) => withSeed(seasonAddress, wideHoldingSeed(p, q, site), programId);

// ------------------------------------------------------------------ the bytes
const big = v => (typeof v === 'bigint' ? v : BigInt(v));
const str = v => String(big(v));

/**
 * The captured WideHolding bytes, decoded and checked as frontier-abi `WideHolding::read` does: exact size, magic,
 * layout version 3, family version 1, status founded, reserved zero, a zero legacy P/Q prefix, a canonical sort key
 * past the legacy disk, site < 12, generation 1..254, inventory slot 2 or 3, a known host identity version, and no
 * debit no identity could settle (a host sequence or open transit under the unallocated identity, any transit or
 * explore record in use). The economy is read through the Holding v2 layout table at the same offsets, exact:
 * `{identity, economy}` with every amount a decimal string of the stored milli-units. Nothing is projected.
 */
export function decodeWideHoldingBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  check(b.length === WIDE_HOLDING_SIZE, 'BadWideBytes', `${b.length} B is not a wide holding`);
  check(String.fromCharCode(...b.subarray(0, 8)) === WIDE_HOLDING_MAGIC, 'BadWideBytes', 'magic');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  check(dv.getUint16(PREFIX.LAYOUT_VERSION, true) === WIDE_LAYOUT_VERSION, 'BadWideBytes', 'layout version');
  check(dv.getUint16(TRAILER.FAMILY_VERSION, true) === WIDE_FAMILY_VERSION, 'BadWideBytes', 'family version');
  check(b[TRAILER.STATUS] === WIDE_STATUS_FOUNDED, 'BadWideBytes', 'status');
  check(b[TRAILER.RSV_7] === 0 && b.subarray(TRAILER.RSV, TRAILER.RSV + TRAILER.RSV_LEN).every(x => x === 0), 'BadWideBytes', 'reserved');
  check(dv.getInt16(PREFIX.P, true) === 0 && dv.getInt16(PREFIX.Q, true) === 0, 'BadWideBytes', 'a legacy identity in the prefix');
  const { p, q } = coordOfSortKey(b.slice(TRAILER.SORT_KEY, TRAILER.SORT_KEY + SORT_KEY_LEN));
  const rp = ringPosition(p, q);
  check(rp.ring >= FIRST_WIDE_RING, 'BadWideBytes', 'inside the legacy disk');
  const site = b[PREFIX.SITE], generation = b[PREFIX.GEN];
  check(site < 12 && generation >= 1 && generation <= 254, 'BadWideBytes', 'site or generation');
  const inventorySlot = b[TRAILER.SLOT];
  check(inventorySlot === 2 || inventorySlot === 3, 'BadWideBytes', 'inventory slot');
  const hostIdentity = dv.getUint16(TRAILER.HOST_IDENTITY, true);
  check(hostIdentity === HOST_IDENTITY_UNALLOCATED || hostIdentity === HOST_IDENTITY_FULL_REF_V1, 'BadWideBytes', 'host identity version');
  const openTransits = b[TRAILER.OPEN_TRANSITS];
  const hostSeq = dv.getUint32(PREFIX.HOST_SEQ, true);
  const anyTransit = Array.from({ length: PREFIX.TRANSIT_N }, (_, i) => b[PREFIX.TRANSIT + i * PREFIX.TRANSIT_SIZE]).some(s => s !== 0);
  check(!(hostIdentity === HOST_IDENTITY_UNALLOCATED && (hostSeq !== 0 || openTransits !== 0)) && !anyTransit && b[PREFIX.EXPLORE_STATE] === 0, 'BadWideBytes', 'a debit without an identity');
  const world = toHex(b.subarray(TRAILER.WORLD, TRAILER.WORLD + 32));
  check(world !== ZERO64, 'BadWideBytes', 'the reserved zero world');
  const h = decodePrefix('Holding', b, { profile: 2 });
  const identity = Object.freeze({
    season: str(dv.getBigUint64(PREFIX.SEASON_ID, true)), world, p, q, ring: rp.ring, site, generation, inventorySlot,
    ownerCitizenBytes: b.slice(PREFIX.OWNER_CITIZEN, PREFIX.OWNER_CITIZEN + 32), hostIdentity, openTransits, hostSeq,
  });
  const economy = Object.freeze({
    tier: h.tier, state: h.state, flags: h.flags, faction: h.faction, order: h.order, walls: h.walls,
    foundedTs: str(h.foundedTs), lastOwnerAction: str(h.lastOwnerAction), shieldUntil: str(h.shieldUntil), finalTs: str(h.finalTs),
    foodShortfall: str(h.foodShortfall), escrow: str(h.escrow), wallsCommittedBefore: str(h.wallsCommittedBefore),
    stores: Object.freeze(h.stores.map((a, i) => Object.freeze({ resource: RESOURCE_ORDER[i], value: str(a.value), rate: str(a.rate), cap: str(a.cap), t0: str(a.t0), frac: str(a.frac) }))),
    production: Object.freeze(h.production.map(str)),
    upkeep: Object.freeze(h.upkeep.map(str)),
    queue: Object.freeze(h.queue.map((x, i) => Object.freeze({ index: i, kind: x.kind, arg: x.arg, doneAt: str(x.doneAt), delta: str(x.delta), inUse: x.kind !== 0 }))),
    reserve: Object.freeze(h.reserve.slice()),
  });
  return Object.freeze({ identity, economy });
}

// ------------------------------------------------------------------ the Citizen's own inventory (frontier-abi world_index::holding)
/** The six-byte ref a Citizen slot carries while a wide holding occupies it: P 0, Q 0, site 12 (one past the last), gen 0. */
export const WIDE_SLOT_MARKER = Object.freeze({ p: 0, q: 0, site: 12, gen: 0 });
/** The deployed empty ref's generation. */
export const EMPTY_GEN = 255;

/**
 * The binding of each of the three inventory slots as the viewer's own decoded Citizen bytes say it, exactly as the
 * herald derives them (`binding_of`): `empty` (gen 0xFF), `wide` (the marker), `legacy`, or `malformed` (an impossible
 * site or generation that is not the marker). The `/h/me` envelope's bindings must agree with these; the answer never
 * decides them alone. A Citizen without three slot refs has no wide inventory.
 */
export function citizenBindings(citizen) {
  const code = 'BadWideRecord';
  check(isObj(citizen) && Array.isArray(citizen.holding) && citizen.holding.length === 3, code, 'a Citizen with three inventory slots');
  return Object.freeze(citizen.holding.map((r, i) => {
    check(isObj(r) && Number.isInteger(r.p) && Number.isInteger(r.q) && Number.isInteger(r.site) && Number.isInteger(r.gen), code, `Citizen inventory slot ${i + 1}`);
    if (r.gen === EMPTY_GEN) return 'empty';
    if (r.p === WIDE_SLOT_MARKER.p && r.q === WIDE_SLOT_MARKER.q && r.site === WIDE_SLOT_MARKER.site && r.gen === WIDE_SLOT_MARKER.gen) return 'wide';
    if (r.site >= 12 || r.gen === 0) return 'malformed';
    return 'legacy';
  }));
}

// ------------------------------------------------------------------ the `/h/me` fields
const BINDINGS = new Set(['empty', 'legacy', 'wide', 'malformed']);
const STATUSES = new Set(['captured-unverified', 'not-captured', 'ambiguous']);
const POST_STATES = new Set(['transaction', 'at-or-after-transaction']);
const EMPTY = Object.freeze([]);
const UNAVAILABLE = Object.freeze({ status: 'unavailable', context: null, inventory: null, slots: EMPTY });

function contextOf(j, { world, seasonId, citizen }) {
  const code = 'BadWideRecord';
  check(isObj(j), code, 'wideContext');
  check(j.v === 1 && j.readOnly === true && j.executable === false && j.verification === 'captured-unverified', code, 'not the read-only captured envelope');
  check(typeof j.world === 'string' && HEX64_RE.test(j.world) && j.world !== ZERO64, code, 'world');
  check(j.worldDomain === WORLD_DOMAIN, code, 'world domain');
  check(j.world === world, 'WorldMismatch', 'the inventory names another world');
  const season = parseU64(j.season, code).toString();
  if (seasonId !== undefined && seasonId !== null) check(season === String(seasonId), 'WrongSeason', 'the inventory of another season');
  const who = addressOf(j.citizen, code);
  // (the expected Citizen is the caller's own derivation, never optional: parseWideInventory refuses without it)
  check(typeof citizen === 'string' && who === citizen, 'WrongKey', 'the inventory of another Citizen');
  const latestSlot = parseU64(j.latestSlot, code), foldedThrough = parseU64(j.foldedThrough, code);
  check(POST_STATES.has(j.postState), code, 'post state');
  check(Array.isArray(j.inventory) && j.inventory.length === 3, code, 'three inventory slots');
  const inventory = j.inventory.map((x, i) => {
    check(isObj(x) && x.inventorySlot === i + 1 && BINDINGS.has(x.binding), code, `inventory slot ${i + 1}`);
    check(!(i === 0 && x.binding === 'wide'), code, 'the first home is legacy land');
    return Object.freeze({ inventorySlot: i + 1, binding: x.binding });
  });
  return Object.freeze({ world: j.world, season, citizen: who, latestSlot, foldedThrough, postState: j.postState, inventory: Object.freeze(inventory) });
}

function captureOf(c, ctx) {
  const code = 'BadWideCapture';
  check(isObj(c), code, 'capture');
  check(c.verification === 'captured-unverified', code, 'verification');
  check(c.postState === ctx.postState, code, 'post state');
  const slot = parseU64(c.slot, code), archiveSequence = parseU64(c.archiveSequence, code);
  check(slot <= ctx.latestSlot, code, 'a capture ahead of the fold');
  check(archiveSequence <= ctx.foldedThrough, code, 'a capture past the folded archive');
  check(typeof c.bytes_b64 === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(c.bytes_b64), code, 'capture bytes');
  let bytes;
  try { bytes = fromBase64(c.bytes_b64); } catch { throw new WideError(code, 'capture bytes'); }
  check(bytes.length === WIDE_HOLDING_SIZE, code, 'capture length');
  return Object.freeze({ address: addressOf(c.address, code), slot, archiveSequence, postState: c.postState, verification: c.verification, bytes });
}

function holdingOf(j, slot, ctx, pins) {
  const code = 'BadWideCapture';
  check(isObj(j), code, 'holding');
  check(j.world === ctx.world, 'WorldMismatch', 'a holding of another world');
  const p = parseWideInt(j.p), q = parseWideInt(j.q);
  const rp = ringPosition(p, q);
  check(parseU64(j.ring, code) === rp.ring, code, 'ring');
  check(rp.ring >= FIRST_WIDE_RING, code, 'inside the legacy disk');
  check(Number.isInteger(j.site) && j.site >= 0 && j.site < 12, code, 'site');
  check(Number.isInteger(j.generation) && j.generation >= 1 && j.generation <= 254, code, 'generation');
  check(j.inventorySlot === slot, code, 'inventory slot');
  check(parseU64(j.season, code).toString() === ctx.season, 'WrongSeason', 'a holding of another season');
  check(addressOf(j.ownerCitizen, code) === ctx.citizen, 'WrongKey', 'a holding of another Citizen');
  check(j.hostIdentity === HOST_IDENTITY_UNALLOCATED || j.hostIdentity === HOST_IDENTITY_FULL_REF_V1, code, 'host identity');
  check(Number.isInteger(j.openTransits) && j.openTransits >= 0 && j.openTransits <= 255, code, 'open transits');
  const capture = captureOf(j.capture, ctx);
  // canonical identity first: the capture sits at the with-seed address of (season, world-indexed coordinate, site);
  // a record anywhere else is another Citizen's or nobody's, whatever its bytes say
  check(capture.address === wideHoldingAddress(pins.seasonAddress, pins.programId, p, q, j.site), 'WrongKey', 'the holding is not at its canonical address');
  // the record's own bytes decide: their owner is the expected Citizen, and the summary above agrees with them in every field
  const { identity, economy } = decodeWideHoldingBytes(capture.bytes);
  check(toHex(identity.ownerCitizenBytes) === toHex(fromB58(ctx.citizen)), 'WrongKey', 'the bytes name another owner');
  check(identity.world === ctx.world && identity.p === p && identity.q === q && identity.site === j.site && identity.generation === j.generation
    && identity.inventorySlot === slot && identity.season === ctx.season && identity.hostIdentity === j.hostIdentity && identity.openTransits === j.openTransits, code, 'the summary disagrees with the bytes');
  const slotsBehind = ctx.latestSlot - capture.slot;
  return Object.freeze({
    kind: 'WideHolding', wide: true, readOnly: true, executable: false,
    key: `${ctx.world}:${p},${q}:${j.site}:${j.generation}`,
    inventorySlot: slot, world: ctx.world, season: ctx.season, p, q, ring: rp.ring, site: j.site, generation: j.generation,
    ownerCitizen: ctx.citizen, hostIdentity: j.hostIdentity, openTransits: j.openTransits,
    capture: Object.freeze({ address: capture.address, slot: capture.slot, archiveSequence: capture.archiveSequence, postState: capture.postState, verification: capture.verification }),
    // currentness is never claimed: the captured slot against the fold's latest, as a slot count (not a time)
    currentness: Object.freeze({ capturedSlot: capture.slot, latestSlot: ctx.latestSlot, slotsBehind, current: 'unverified', age: 'unknown' }),
    economy,
  });
}

/**
 * `/h/me`'s `wideContext` and `wideHoldings` → `{status, context, inventory, slots}`:
 *   `unavailable` — the record has neither field (a herald without the wide index) or a null envelope (no index yet,
 *                   or no Citizen captured): nothing is known, which is not "no wide villages";
 *   `ready`       — the envelope checked against `pins` and every slot entry checked: `slots` is one entry per
 *                   wide-bound slot (2, 3) in order, each `{inventorySlot, status, holding}` with `holding` only for
 *                   `captured-unverified` (the bytes re-read and agreeing with the summary).
 * The pins: `seasonAddress`, `programId` (the canonical addresses; `world` recomputed from them unless given),
 * `seasonId`, and — required for any non-null envelope — `citizen`, the Citizen the viewer *is*, derived by the
 * caller from the connected wallet or the NFT played under the pinned program and season (never read from the
 * answer: an answer's own `citizen.address` is checked when present), and `citizenRecord`,
 * the viewer's decoded Citizen bytes from the same `/h/me` read, whose slot refs decide the three bindings
 * (`citizenBindings`); `viewerKey`, when given, is held against those bytes' wallet field.
 * Half a record, a repeat, a mixed world, a wide binding without its entry, an entry for a slot not bound wide, a
 * capture ahead of the fold, a summary the bytes contradict, a holding not at its canonical address, an envelope or
 * a capture of another Citizen, bindings the Citizen bytes contradict, or a missing expected Citizen throws
 * WideError: the whole wide inventory is refused (the legacy view is untouched by that).
 */
export function parseWideInventory(record, pins = {}) {
  const code = 'BadWideRecord';
  check(isObj(record), code, 'record');
  const ctxJ = record.wideContext, list = record.wideHoldings;
  if (ctxJ === undefined && list === undefined) return UNAVAILABLE;
  check(ctxJ !== undefined && list !== undefined, code, 'half a wide record');
  check(Array.isArray(list), code, 'wideHoldings');
  if (ctxJ === null) { check(list.length === 0, code, 'entries without an envelope'); return UNAVAILABLE; }
  check(typeof pins.seasonAddress === 'string' && typeof pins.programId === 'string', 'NoSeasonYet', 'the season record is needed for the addresses');
  // the Citizen this inventory must be about: the caller's own derivation, required (the answer's metadata is never
  // the only pin; when the answer names a Citizen address at all, it must be this one)
  check(typeof pins.citizen === 'string', 'NoCitizenPin', 'the viewer\'s Citizen is not known');
  const citizen = addressOf(pins.citizen, 'NoCitizenPin');
  if (record.citizen?.address !== undefined) check(record.citizen.address === citizen, 'WrongKey', 'the record is about another Citizen');
  // the viewer's own Citizen bytes decide the bindings; an envelope without them is half a record
  check(isObj(pins.citizenRecord), code, 'a wide envelope without the Citizen bytes');
  const bindings = citizenBindings(pins.citizenRecord);
  // (workstream 20: an NFT Citizen's bytes name its asset, with the wallet zero — fcodec `residentAsset`)
  if (pins.viewerKey !== undefined && pins.viewerKey !== null) {
    const r = pins.citizenRecord;
    if (r.residentAsset !== undefined) check(r.residentAsset !== null && toB58(r.residentAsset) === pins.viewerKey, 'WrongKey', 'the Citizen bytes name another viewer');
    else if (r.wallet) check(toB58(r.wallet) === pins.viewerKey, 'WrongKey', 'the Citizen bytes name another viewer');
  }
  const world = pins.world ?? worldIdOf(pins.seasonAddress, pins.programId);
  const ctx = contextOf(ctxJ, { world, seasonId: pins.seasonId, citizen });
  check(ctx.inventory.every((x, i) => x.binding === bindings[i]), code, 'the inventory disagrees with the Citizen bytes');
  const wideBound = ctx.inventory.filter(x => x.binding === 'wide').map(x => x.inventorySlot);
  check(list.length === wideBound.length, code, 'an entry per wide-bound slot');
  const slots = list.map((e, i) => {
    check(isObj(e) && e.inventorySlot === wideBound[i], code, `entry ${i}: slot`);
    check(STATUSES.has(e.status), code, `entry ${i}: status`);
    const captured = e.status === 'captured-unverified';
    check(captured ? isObj(e.holding) : e.holding === null, code, `entry ${i}: holding`);
    return Object.freeze({ inventorySlot: e.inventorySlot, status: e.status, holding: captured ? holdingOf(e.holding, e.inventorySlot, ctx, { ...pins, world }) : null });
  });
  return Object.freeze({ status: 'ready', context: ctx, inventory: ctx.inventory, slots: Object.freeze(slots) });
}

// ------------------------------------------------------------------ the page's wide state (beside FS.holdings)
/** A wide holding, or something shaped like one: never a legacy Holding (a BigInt coordinate is never legacy). */
export const isWideHolding = x => !!x && typeof x === 'object' && (x.kind === 'WideHolding' || x.wide === true || typeof x.p === 'bigint' || typeof x.q === 'bigint');

const sameSource = (a, b) => !!a && !!b && a.world === b.world && a.season === b.season && a.citizen === b.citizen;

/** The wide inventory of the Citizen the record is about, adopted after a `/h/me` read (the legacy fields are the caller's). */
export function adoptWide(FS, record, pins) {
  const before = FS.wideHoldings?.context ?? null;
  let parsed;
  try { parsed = parseWideInventory(record, pins); } catch (e) { failWide(FS, e instanceof WideError ? e.code : 'BadWideRecord'); return FS.wideStatus; }
  FS.wideHoldings = parsed;
  FS.wideStatus = parsed.status;
  FS.wideError = null;
  // another Citizen, world or season (a wallet or NFT resident switch, another source): the old choice is not this one's
  if (parsed.status !== 'ready' || (before && !sameSource(before, parsed.context))) FS.wideSelect = null;
  reconcileSelect(FS);
  return FS.wideStatus;
}

/** A failed read: no wide data and no wide selection (a stale card could otherwise stand on nothing). */
export function failWide(FS, code) {
  FS.wideHoldings = null;
  FS.wideStatus = 'error';
  FS.wideError = { code: code ?? 'Unavailable' };
  FS.wideSelect = null;
}

/** Forget the wide inventory and selection (a wallet, resident or source change; a reload). */
export function clearWide(FS) {
  FS.wideHoldings = null;
  FS.wideStatus = 'loading';
  FS.wideError = null;
  FS.wideSelect = null;
}

/** The slot entries on offer (empty until the inventory is ready). */
export const wideSlots = FS => (FS?.wideStatus === 'ready' ? FS.wideHoldings?.slots ?? EMPTY : EMPTY);

/** The selected slot's entry, or null (the village screen then shows the legacy village). */
export function selectedWide(FS) {
  const s = FS?.wideSelect;
  if (!s) return null;
  return wideSlots(FS).find(e => e.inventorySlot === s.inventorySlot) ?? null;
}

/** Keep a selection only while its slot is still a wide slot of this inventory; follow the capture it now shows. */
export function reconcileSelect(FS) {
  if (!FS.wideSelect) return;
  const e = selectedWide(FS);
  if (!e) { FS.wideSelect = null; return; }
  FS.wideSelect = Object.freeze({ inventorySlot: e.inventorySlot, key: e.holding?.key ?? null, status: e.status });
}

/** Choose the wide village of `inventorySlot` for the village screen: true when it is one of this inventory's slots. */
export function selectWide(FS, inventorySlot) {
  const slot = Number(inventorySlot);
  const e = wideSlots(FS).find(x => x.inventorySlot === slot);
  if (!e) return false;
  FS.wideSelect = Object.freeze({ inventorySlot: slot, key: e.holding?.key ?? null, status: e.status });
  FS.tab = 'holding';
  return true;
}

/** Back to the legacy village (close / a legacy selection). */
export function clearWideSelect(FS) { if (FS.wideSelect) FS.wideSelect = null; }

// ------------------------------------------------------------------ the guard
/**
 * Every legacy order a village can be the subject of: the `data-act` and `data-form` names of the page and the
 * instruction names `act` sends. While a wide village stands on the village screen, none of these may run from
 * there; and nowhere may any of them take a wide holding as its subject.
 */
export const GUARDED_ACTS = Object.freeze(['harvest', 'build', 'train', 'muster', 'garrison', 'nudge', 'dissolve', 'compose', 'march-send', 'march-home',
  'explore-open', 'explore-send', 'settle-explore', 'settle-transit', 'home-scout-train', 'home-scout-muster',
  's1-vault', 's1-structure', 's1-raid', 's1-seize', 's1-siege', 'cq-march', 'cq-outpost', 'caravans']);
export const GUARDED_FORMS = Object.freeze(['train', 'muster', 'garrison', 's1-fort', 's1-caravan']);
export const GUARDED_INSTRUCTIONS = Object.freeze(['Harvest', 'Build', 'Train', 'Muster', 'Garrison', 'Dissolve', 'Explore', 'Depart', 'SettleExplore', 'SettleTransit',
  'FortGarrison', 'BuildVault', 'BuildStructure', 'SeizeVault', 'SeizeStructure', 'SendCaravan', 'RaidCaravan', 'DeclareSiege', 'FileOutpost', 'PlaceHome', 'FileTicket']);
const GUARDED = new Set([...GUARDED_ACTS, ...GUARDED_FORMS, ...GUARDED_INSTRUCTIONS]);

/** Scan nested order subjects without recursion; cycles terminate, excessive object graphs fail closed. */
export function namesWide(v) {
  const pending = [v], seen = new Set();
  while (pending.length) {
    const x = pending.pop();
    if (isWideHolding(x)) return true;
    if (!x || typeof x !== 'object' || seen.has(x)) continue;
    if (seen.size >= 4096) return true;
    seen.add(x);
    if (ArrayBuffer.isView(x)) continue;
    for (const child of Object.values(x)) if (child && typeof child === 'object') pending.push(child);
  }
  return false;
}

/**
 * Why `name` (a data-act, a form, or an instruction) may not run now with subjects `v`, or null: a wide holding
 * among the subjects, or a guarded order while the village screen shows a wide village (`FS.wideSelect` with the
 * village tab): a stale control, a forged dataset, a shortcut, a repeated press or a programmatic call all meet the
 * same answer. Legacy orders with legacy subjects on the legacy screen pass untouched.
 */
export function wideRefusal(name, v, FS) {
  if (namesWide(v)) return refusal();
  if (FS?.wideSelect && (FS.tab ?? 'map') === 'holding' && GUARDED.has(String(name))) return refusal();
  return null;
}
const refusal = () => ({ code: 'WideReadOnly', text: L`遠方の村は捕捉記録の読み取り専用表示です。この村には命令を送れません。` });

/**
 * The subjects an order is built from at the moment of the send (`actOnce`: the accounts of a settle are a function of
 * the relay's fee payer, known only then), checked for a wide holding alone — not for the screen's state, which was
 * judged when the order was authorized: an order of a legacy village continues after unrelated navigation, an order
 * naming a wide village builds no accounts. Throws the refusal; returns `v` unchanged.
 */
export function assertLegacySubjects(name, v) {
  const r = wideRefusal(name, v, null);
  if (r) throw new WideError(r.code, r.text);
  return v;
}

/** Wrap the guarded entries of an action table in place (`refuse(r)` answers a refusal; the entry's result otherwise). */
export function guardLegacy(table, names, { FS, refuse }) {
  for (const name of names) {
    const fn = table[name];
    if (typeof fn !== 'function') continue;
    // (a table entry's first argument is a dataset or a form, never an order's subjects: the subject scan is `act`'s)
    table[name] = (...args) => { const r = wideRefusal(name, null, FS); return r ? refuse(r) : fn(...args); };
  }
  return table;
}
