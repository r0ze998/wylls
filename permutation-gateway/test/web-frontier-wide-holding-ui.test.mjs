// The viewer's wide villages on the village screen, read-only (fwide.mjs,
// screens/wideholding.mjs, the hooks in screens/holding.mjs and hud/hud.mjs,
// the controller's adoption, clearing and guard): the `/h/me` wide inventory
// parsed strictly against fixed public pins — the Citizen the viewer *is*,
// derived from the wallet or the NFT under the pinned program and season,
// never read from the answer —, every fact re-read from synthetic WideHolding
// bytes laid out as frontier-abi writes them, canonical with-seed addresses
// recomputed from public bytes, coordinates exact past 2^53 and at the 2^62
// bound, the missing / ambiguous / stale captures kept apart from an empty
// inventory, the legacy village and its actions untouched, every legacy order
// refused at a wide village, the selection cleared on a Citizen, world or
// source switch, a failed read and a late answer, and the phone sheet's
// composition carrying the same wide selector as the desktop rail.
//
// Fixed public data only: the season PDA, the Citizen addresses and the wide
// holding addresses are public derivations (fchainio.setPin, faddr), no key is
// generated, derived or used, nothing is signed, no network is reached (the
// controller reads a fake herald and sends through a fake transport that
// answers a refusal; the relay base is unset, so every relay read answers
// `NoRelay` before any fetch). controller.mjs is imported as the key-free
// web-frontier-hud and web-frontier-autoticket tests import it. These are
// markup-string and state tests with no DOM, not browser or visual acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import {
  parseWideInventory, decodeWideHoldingBytes, sortKeyOf, coordOfSortKey, coordOfRingPosition, wideHoldingSeed, wideHoldingAddress,
  adoptWide, failWide, clearWide, selectWide, clearWideSelect, selectedWide, wideSlots, reconcileSelect, citizenBindings,
  wideRefusal, guardLegacy, assertLegacySubjects, namesWide, isWideHolding, GUARDED_ACTS, GUARDED_FORMS, GUARDED_INSTRUCTIONS,
  WideError, WIDE_HOLDING_SIZE, TRAILER, FIRST_WIDE_RING, WIDE_SLOT_MARKER, EMPTY_GEN,
} from '../../permutation-server/web/frontier/fwide.mjs';
import { render as renderWide, wideModel, renderWidePips, formatMilli, recordedTime } from '../../permutation-server/web/frontier/screens/wideholding.mjs';
import * as holdingScreen from '../../permutation-server/web/frontier/screens/holding.mjs';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import * as CTRL from '../../permutation-server/web/frontier/controller.mjs';
import { FS as STORE, activeHolding } from '../../permutation-server/web/frontier/fstate.mjs';
import { worldIdOf, ringPosition, WIDE_BOUND, WORLD_DOMAIN } from '../../permutation-server/web/frontier/map/wide.mjs';
import { withSeed } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { residentCitizen } from '../../permutation-server/web/sdk/frontier/resident.mjs';
import { encode as toB58, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { toBase64, fromHex, toHex, utf8 } from '../../permutation-server/web/sdk/bytes.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';

// ------------------------------------------------------------------ fixed public data
// The page's pin (fchainio.setPin, as startPlay pins it): the Season PDA of season 5 under a fixed program id, and the
// Citizen addresses of two fixed wallets and one fixed NFT asset, all public derivations — the same ones the controller
// makes when it pins the wide inventory to the viewer. Nothing here is a key.
const PROGRAM = toB58(new Uint8Array(32).fill(0x5e));
const PIN = io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: 5 });
const SEASON_ADDR = PIN.addresses.season;
const WORLD = worldIdOf(SEASON_ADDR, PROGRAM);
const OTHER_SEASON_ADDR = toB58(new Uint8Array(32).fill(4));
const OTHER_WORLD = worldIdOf(OTHER_SEASON_ADDR, PROGRAM);
const WALLET_A = toB58(new Uint8Array(32).fill(0x41)), WALLET_B = toB58(new Uint8Array(32).fill(0x42));
/** Citizen A: the connected wallet's canonical Citizen; Citizen B: another wallet's. */
const CITIZEN = PIN.addresses.of('Citizen', { wallet: WALLET_A });
const OWNER = fromB58(CITIZEN);
const OTHER_CITIZEN = PIN.addresses.of('Citizen', { wallet: WALLET_B });
const OTHER_OWNER = fromB58(OTHER_CITIZEN);
/** An NFT resident (⑳): its Citizen sits at the resident id's address. */
const ASSET = toB58(new Uint8Array(32).fill(0x21));
const NFT_CITIZEN = residentCitizen(PIN.addresses, ASSET);
const NFT_OWNER = fromB58(NFT_CITIZEN);
const ENV = Object.freeze({ seasonAddress: SEASON_ADDR, programId: PROGRAM, world: WORLD, season: '5' });
const OTHER_ENV = Object.freeze({ seasonAddress: OTHER_SEASON_ADDR, programId: PROGRAM, world: OTHER_WORLD, season: '6' });
/** The far coordinate the herald tests pin (past 2^53), and one on the first wide ring. */
const FAR = Object.freeze({ p: 9007199254740993n, q: -130n });
const NEAR = Object.freeze({ p: 129n, q: 0n });
const STORE_VALUES = [1220, 815, 662, 305, 122, 90, 40, 20];
const STORE_RATES = [40, 30, 25, 10, 5, 0, 0, 0];

// ------------------------------------------------------------------ the viewer's Citizen bytes (the slot refs decide the bindings)
const REF = Object.freeze({ empty: { P: 0, Q: 0, SITE: 0, GEN: 255 }, wide: { P: 0, Q: 0, SITE: 12, GEN: 0 }, home: { P: 2, Q: 0, SITE: 3, GEN: 1 }, legacy: { P: 3, Q: -1, SITE: 1, GEN: 1 } });
const refsOf = bindings => bindings.map((b, i) => (b === 'legacy' ? (i === 0 ? REF.home : REF.legacy) : REF[b]));
/** The viewer's decoded Citizen, by the codec's own round trip of the v2 layout: the wallet (or the NFT asset) and the three slot refs. */
const citizenRecord = ({ wallet = WALLET_A, bindings = ['legacy', 'wide', 'empty'], refs = refsOf(bindings) } = {}) =>
  decode('Citizen', encodeAccount('Citizen', { SEASON_ID: 5n, WALLET: fromB58(wallet), FACTION: 2, HOLDING: refs, TICKET_BELL: 0xffffffff }, { profile: 2 }), { profile: 2, seasonId: 5 });
/** The parser's pins as the controller passes them: the season's addresses, the viewer's derived Citizen and the viewer's Citizen bytes. */
const PINS = Object.freeze({ seasonAddress: SEASON_ADDR, programId: PROGRAM, seasonId: '5', citizen: CITIZEN, citizenRecord: citizenRecord() });
const pinsOf = (bindings, over = {}) => ({ ...PINS, citizenRecord: citizenRecord({ bindings }), ...over });

/**
 * Synthetic WideHolding bytes, laid out as frontier-abi `WideHolding::write_identity` does over the whole Holding v2
 * layout: the wide magic, layout version 3, a zero legacy P/Q, site, generation and owner in the prefix; family
 * version, founded status, inventory slot, host identity, open transits, world and the 17-byte sort key in the
 * trailer. The economy fields are plain recorded values (fixed numbers, no rule applied).
 */
function wideBytes({ p, q, site = 3, gen = 1, slot = 2, owner = OWNER, world = WORLD, season = 5n, hostIdentity = 0, openTransits = 0, economy = {} } = {}) {
  const prefix = encodeAccount('Holding', {
    SEASON_ID: season, SITE: site, GEN: gen, OWNER_CITIZEN: owner, TIER: 1, STATE: 2, WALLS: 250, FACTION: 2, ORDER: 2,
    FOUNDED_TS: 1_799_990_000n, LAST_OWNER_ACTION: 1_800_000_000n, FINAL_TS: 1_799_995_000n, SHIELD_UNTIL: 0n, ESCROW: 123n, FOOD_SHORTFALL: 0n,
    STORES: STORE_VALUES.map((v, i) => ({ VALUE: BigInt(v * 1000), RATE: BigInt(STORE_RATES[i] * 1000), CAP: 6_000_000n, T0: 1_800_000_000n, FRAC: 0n })),
    PRODUCTION: STORE_RATES.map(r => BigInt(r * 1000)), UPKEEP: STORE_RATES.map(() => 0n),
    QUEUE: [{ DONE_AT: 1_800_003_600n, KIND: 1, ARG: 1, DELTA: 10_000n }, { DONE_AT: 0n, KIND: 0, ARG: 0, DELTA: 0n }, { DONE_AT: 0n, KIND: 0, ARG: 0, DELTA: 0n }, { DONE_AT: 0n, KIND: 0, ARG: 0, DELTA: 0n }],
    RESERVE: [400, 0, 0, 0, 0, 0, 100, 0], ...economy,
  }, { profile: 2 });
  const b = new Uint8Array(WIDE_HOLDING_SIZE);
  b.set(prefix, 0);
  const dv = new DataView(b.buffer);
  b.set(utf8('PSFXWHL1'), 0);
  dv.setUint16(16, 3, true);
  dv.setInt16(64, 0, true); dv.setInt16(66, 0, true);
  dv.setUint16(TRAILER.FAMILY_VERSION, 1, true);
  b[TRAILER.STATUS] = 1;
  b[TRAILER.SLOT] = slot;
  dv.setUint16(TRAILER.HOST_IDENTITY, hostIdentity, true);
  b[TRAILER.OPEN_TRANSITS] = openTransits;
  b.set(fromHex(world), TRAILER.WORLD);
  b.set(sortKeyOf(p, q), TRAILER.SORT_KEY);
  return b;
}
const captureJson = (address, bytes, over = {}) => ({ address, slot: '1000', archiveSequence: '12', postState: 'transaction', verification: 'captured-unverified', bytes_b64: toBase64(bytes), ...over });
/** One `wideHoldings` entry: a captured holding of `owner` at (p, q) in `env`'s season and world, or a not-captured / ambiguous slot. */
function entry({ p, q, site = 3, gen = 1, slot = 2, owner = OWNER, bytes = null, status = 'captured-unverified', holding = undefined, capture = {}, env = ENV } = {}) {
  if (holding !== undefined) return { inventorySlot: slot, status, holding };
  if (status !== 'captured-unverified') return { inventorySlot: slot, status, holding: null };
  const data = bytes ?? wideBytes({ p, q, site, gen, slot, owner, world: env.world, season: BigInt(env.season) });
  return { inventorySlot: slot, status, holding: {
    world: env.world, p: String(p), q: String(q), ring: String(ringPosition(p, q).ring), site, generation: gen, inventorySlot: slot, season: env.season,
    ownerCitizen: toB58(owner), hostIdentity: 0, openTransits: 0, capture: captureJson(wideHoldingAddress(env.seasonAddress, env.programId, p, q, site), data, capture) } };
}
const inventory = (b1 = 'legacy', b2 = 'wide', b3 = 'empty') => [{ inventorySlot: 1, binding: b1 }, { inventorySlot: 2, binding: b2 }, { inventorySlot: 3, binding: b3 }];
const context = (over = {}) => ({ v: 1, readOnly: true, executable: false, verification: 'captured-unverified', world: WORLD, worldDomain: WORLD_DOMAIN, season: '5', citizen: CITIZEN,
  latestSlot: '2000', foldedThrough: '40', postState: 'transaction', inventory: inventory(), ...over });
const record = ({ ctx = context(), entries = [entry(FAR)], citizen = { address: CITIZEN } } = {}) => ({ v: 1, wallet: 'w', citizen, holdings: [], slots: [], wideContext: ctx, wideHoldings: entries });
const clone = x => JSON.parse(JSON.stringify(x));
const refused = (fn, code) => {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  assert.ok(e instanceof WideError, `expected a WideError ${code}, got ${e?.stack ?? e}`);
  assert.equal(e.code, code, e.message);
};
const flat = x => [x].flat(Infinity).map(String).join('');

// ------------------------------------------------------------------ the legacy village (web-frontier-cards.test.mjs' world, unchanged)
const FIX = new URL('fixtures/frontier/', import.meta.url);
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('season.json', FIX), 'utf8')).bytes_b64, 'base64'));
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }), { seasonId: 1 });
function legacyWorld() {
  const holding = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, FINAL_TS: 0, RESERVE: [400, 0, 0, 0, 0, 0, 100, 0],
    STORES: STORE_VALUES.map((v, i) => ({ VALUE: BigInt(v * 1000), RATE: BigInt(STORE_RATES[i] * 1000), CAP: BigInt(6_000_000), T0: 0n })) });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 41, SITE_COUNT: 1, SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))] });
  return { mode: 'play', tab: 'holding', season: SEASON, nowBell: 42, chain: { now: () => 1_000 }, citizen: { faction: 0, vigilStartMin: 0, exploresFloorLeft: 3 }, land: { stage: 'final' },
    holdings: [holding], provinces: new Map([['2,0', { province }]]), view: { fog: true }, ui: { dismissed: ['onboarding'] }, marches: [], chronicle: [], incoming: [], feed: [], playReady: true,
    wideHoldings: null, wideStatus: 'loading', wideError: null, wideSelect: null };
}

// ================================================================== coordinates
test('the sort key round-trips exact coordinates past 2^53 and at the 2^62 bound; non-canonical keys are refused', () => {
  for (const [p, q] of [[FAR.p, FAR.q], [NEAR.p, NEAR.q], [WIDE_BOUND, -1n], [-WIDE_BOUND, WIDE_BOUND], [0n, 0n], [-1n, 0n], [1n, 1n], [0n, (1n << 53n) + 1n]]) {
    const key = sortKeyOf(p, q);
    assert.equal(key.length, 17);
    assert.deepEqual(coordOfSortKey(key), { p, q }, `${p},${q}`);
    const rp = ringPosition(p, q);
    assert.deepEqual(coordOfRingPosition(rp.ring, rp.wedge, rp.pos), { p, q });
  }
  // 2^53 + 1 is not a double: the key keeps it where Number would not
  assert.notEqual(BigInt(Number(FAR.p)), FAR.p);
  assert.equal(coordOfSortKey(sortKeyOf(FAR.p, FAR.q)).p, 9007199254740993n);
  // the big-endian layout: ring, wedge, position. frontier-abi `WideCoord::ring_position` turns (p, q) back by 60°
  // — (a, b) → (a + b, −a) — until a > 0 and b ≥ 0: (2^62, −1) needs five turns, so it sits in wedge 5 at position
  // 2^62 − 1 on ring 2^62; the far coordinate (2^53 + 1, −130) likewise in wedge 5, at position 2^53 − 129
  const k = sortKeyOf(WIDE_BOUND, -1n);
  assert.equal(toHex(k.slice(0, 8)), '4000000000000000');
  assert.equal(k[8], 5);
  assert.equal(toHex(k.slice(9)), '3fffffffffffffff');
  assert.deepEqual(ringPosition(FAR.p, FAR.q), { ring: FAR.p, wedge: 5, pos: (1n << 53n) - 129n });
  assert.deepEqual(ringPosition(1n, 1n), { ring: 2n, wedge: 0, pos: 1n }, 'the herald\'s own pinned example');
  // refusals: wedge 6, a position past the ring, a nonzero position at the origin, out of bounds
  refused(() => coordOfRingPosition(5n, 6, 0n), 'BadCoord');
  refused(() => coordOfRingPosition(5n, 0, 5n), 'BadCoord');
  refused(() => coordOfRingPosition(0n, 0, 1n), 'BadCoord');
  refused(() => coordOfRingPosition(0n, 1, 0n), 'BadCoord');
  refused(() => coordOfRingPosition((1n << 63n) + 2n, 0, 0n), 'BadCoord');
  refused(() => coordOfSortKey(new Uint8Array(16)), 'BadCoord');
});

test('the canonical wide holding address is with-seed arithmetic over public bytes: "wh" ‖ hex(sha256(domain ‖ sort key ‖ site)[..15])', () => {
  const seed = wideHoldingSeed(FAR.p, FAR.q, 3);
  assert.equal(seed.length, 32);
  assert.equal(seed.slice(0, 2), 'wh');
  assert.equal(seed, `wh${toHex(sha256(utf8('PSF-WIDE-HOLDING-SEED-v1'), sortKeyOf(FAR.p, FAR.q), Uint8Array.of(3)).slice(0, 15))}`);
  assert.equal(wideHoldingAddress(SEASON_ADDR, PROGRAM, FAR.p, FAR.q, 3), withSeed(SEASON_ADDR, seed, PROGRAM));
  assert.notEqual(wideHoldingAddress(SEASON_ADDR, PROGRAM, FAR.p, FAR.q, 3), wideHoldingAddress(SEASON_ADDR, PROGRAM, FAR.p, FAR.q, 4), 'a site of its own');
  assert.notEqual(wideHoldingAddress(SEASON_ADDR, PROGRAM, FAR.p, FAR.q, 3), wideHoldingAddress(SEASON_ADDR, PROGRAM, NEAR.p, NEAR.q, 3), 'a place of its own');
  assert.notEqual(wideHoldingAddress(SEASON_ADDR, PROGRAM, FAR.p, FAR.q, 3), wideHoldingAddress(OTHER_SEASON_ADDR, PROGRAM, FAR.p, FAR.q, 3), 'a season of its own');
});

// ================================================================== the bytes
test('captured wide holding bytes decode to an exact identity and economy; every malformed form is refused by name', () => {
  const b = wideBytes(FAR);
  const { identity, economy } = decodeWideHoldingBytes(b);
  assert.deepEqual({ ...identity, ownerCitizenBytes: toB58(identity.ownerCitizenBytes) },
    { season: '5', world: WORLD, p: FAR.p, q: FAR.q, ring: ringPosition(FAR.p, FAR.q).ring, site: 3, generation: 1, inventorySlot: 2, ownerCitizenBytes: CITIZEN, hostIdentity: 0, openTransits: 0, hostSeq: 0 });
  assert.ok(identity.ring >= FIRST_WIDE_RING);
  assert.equal(economy.tier, 1); assert.equal(economy.state, 2); assert.equal(economy.walls, 250); assert.equal(economy.escrow, '123');
  assert.equal(economy.stores[0].resource, 'Food');
  assert.equal(economy.stores[0].value, '1220000', 'milli-units, exact, as stored');
  assert.equal(economy.stores[0].rate, '40000'); assert.equal(economy.stores[0].cap, '6000000'); assert.equal(economy.stores[0].t0, '1800000000');
  assert.equal(economy.stores[7].value, '20000');
  assert.deepEqual(economy.production, STORE_RATES.map(r => String(r * 1000)));
  assert.equal(economy.queue.filter(q => q.inUse).length, 1);
  assert.deepEqual(economy.queue[0], { index: 0, kind: 1, arg: 1, doneAt: '1800003600', delta: '10000', inUse: true });
  assert.deepEqual(economy.reserve, [400, 0, 0, 0, 0, 0, 100, 0]);
  assert.equal(economy.lastOwnerAction, '1800000000');
  assert.ok(Object.isFrozen(economy) && Object.isFrozen(economy.stores[0]));
  // the allocated host identity may show a mustered host; a transit or explore in use is still a debit nothing settles
  const v1 = wideBytes({ ...FAR, hostIdentity: 1 }); new DataView(v1.buffer).setUint32(132, 1, true);
  assert.equal(decodeWideHoldingBytes(v1).identity.hostSeq, 1);
  const edits = [
    ['magic', x => { x[0] ^= 1; }], ['layout version', x => { new DataView(x.buffer).setUint16(16, 2, true); }],
    ['family version', x => { new DataView(x.buffer).setUint16(TRAILER.FAMILY_VERSION, 2, true); }], ['status', x => { x[TRAILER.STATUS] = 0; }],
    ['reserved', x => { x[TRAILER.RSV] = 1; }], ['reserved 7', x => { x[TRAILER.RSV_7] = 1; }], ['legacy P in the prefix', x => { x[64] = 1; }],
    ['slot 1', x => { x[TRAILER.SLOT] = 1; }], ['slot 4', x => { x[TRAILER.SLOT] = 4; }], ['site 12', x => { x[68] = 12; }], ['gen 0', x => { x[69] = 0; }], ['gen 255', x => { x[69] = 255; }],
    ['host identity 2', x => { new DataView(x.buffer).setUint16(TRAILER.HOST_IDENTITY, 2, true); }],
    ['host seq under the unallocated identity', x => { new DataView(x.buffer).setUint32(132, 1, true); }],
    ['open transits under the unallocated identity', x => { x[TRAILER.OPEN_TRANSITS] = 1; }],
    ['a transit in use', x => { x[784 + 2 * 96] = 1; }], ['an explore pending', x => { x[1168 + 18] = 1; }],
    ['inside the legacy disk', x => { x.set(sortKeyOf(100n, 0n), TRAILER.SORT_KEY); }],
    ['the zero world', x => { x.fill(0, TRAILER.WORLD, TRAILER.WORLD + 32); }],
  ];
  for (const [what, edit] of edits) { const x = wideBytes(FAR); edit(x); refused(() => decodeWideHoldingBytes(x), 'BadWideBytes'); }
  const x = wideBytes({ ...FAR, hostIdentity: 1 }); x[784] = 1; refused(() => decodeWideHoldingBytes(x), 'BadWideBytes');
  refused(() => decodeWideHoldingBytes(b.slice(0, 1280)), 'BadWideBytes');
  refused(() => decodeWideHoldingBytes(new Uint8Array(0)), 'BadWideBytes');
  const bad = wideBytes(FAR); bad[TRAILER.SORT_KEY + 8] = 6; refused(() => decodeWideHoldingBytes(bad), 'BadCoord');
});

// ================================================================== the viewer's own Citizen bytes
test('the three inventory bindings come from the viewer\'s own Citizen slot refs, as the herald derives them: empty (gen 0xFF), the wide marker, legacy, malformed', () => {
  assert.deepEqual(WIDE_SLOT_MARKER, { p: 0, q: 0, site: 12, gen: 0 }); assert.equal(EMPTY_GEN, 255);
  // the codec's round trip of the v2 layout gives {p, q, site, gen} per slot
  const c = citizenRecord();
  assert.deepEqual(c.holding.map(r => [r.p, r.q, r.site, r.gen]), [[2, 0, 3, 1], [0, 0, 12, 0], [0, 0, 0, 255]]);
  assert.equal(toB58(c.wallet), WALLET_A);
  assert.deepEqual(citizenBindings(c), ['legacy', 'wide', 'empty']);
  assert.deepEqual(citizenBindings(citizenRecord({ bindings: ['legacy', 'wide', 'wide'] })), ['legacy', 'wide', 'wide']);
  assert.deepEqual(citizenBindings(citizenRecord({ bindings: ['legacy', 'legacy', 'empty'] })), ['legacy', 'legacy', 'empty']);
  assert.deepEqual(citizenBindings(citizenRecord({ bindings: ['empty', 'empty', 'empty'] })), ['empty', 'empty', 'empty']);
  // the marker in slot 1 reads as the herald reads it (wide); the envelope check then refuses the wide first home
  assert.deepEqual(citizenBindings(citizenRecord({ refs: [REF.wide, REF.empty, REF.empty] })), ['wide', 'empty', 'empty']);
  // a ref no writer may act on: an impossible site or a zero generation that is not the marker
  assert.deepEqual(citizenBindings(citizenRecord({ refs: [REF.home, { P: 0, Q: 0, SITE: 12, GEN: 1 }, { P: 1, Q: 0, SITE: 3, GEN: 0 }] })), ['legacy', 'malformed', 'malformed']);
  assert.deepEqual(citizenBindings(citizenRecord({ refs: [REF.home, { P: 0, Q: 0, SITE: 13, GEN: 0 }, REF.empty] })), ['legacy', 'malformed', 'empty']);
  // a plain decoded shape works the same; fewer than three refs, or none, is no inventory
  assert.deepEqual(citizenBindings({ holding: [{ p: 2, q: 0, site: 3, gen: 1 }, { p: 0, q: 0, site: 12, gen: 0 }, { p: 0, q: 0, site: 0, gen: 255 }] }), ['legacy', 'wide', 'empty']);
  refused(() => citizenBindings({ holding: [{ gen: 255 }] }), 'BadWideRecord');
  refused(() => citizenBindings({ holding: [{ gen: 255 }, { gen: 255 }, { gen: 255 }] }), 'BadWideRecord');
  refused(() => citizenBindings(null), 'BadWideRecord');
  refused(() => citizenBindings({}), 'BadWideRecord');
});

// ================================================================== the /h/me fields
test('the wide inventory binds world, season, Citizen, canonical addresses and capture metadata to the bytes; disagreement fails closed', () => {
  const r = parseWideInventory(record(), PINS);
  assert.equal(r.status, 'ready');
  assert.equal(r.context.world, WORLD); assert.equal(r.context.season, '5'); assert.equal(r.context.citizen, CITIZEN);
  assert.equal(r.context.latestSlot, 2000n); assert.equal(r.context.foldedThrough, 40n);
  assert.deepEqual(r.inventory.map(x => x.binding), ['legacy', 'wide', 'empty']);
  assert.equal(r.slots.length, 1);
  const h = r.slots[0].holding;
  assert.equal(r.slots[0].status, 'captured-unverified');
  assert.equal(h.kind, 'WideHolding'); assert.equal(h.wide, true); assert.equal(h.readOnly, true); assert.equal(h.executable, false);
  assert.equal(typeof h.p, 'bigint'); assert.equal(h.p, FAR.p); assert.equal(h.q, FAR.q);
  assert.equal(h.inventorySlot, 2); assert.equal(h.site, 3); assert.equal(h.generation, 1); assert.equal(h.ownerCitizen, CITIZEN); assert.equal(h.season, '5');
  assert.equal(h.capture.address, wideHoldingAddress(SEASON_ADDR, PROGRAM, FAR.p, FAR.q, 3));
  assert.equal(h.capture.slot, 1000n); assert.equal(h.capture.archiveSequence, 12n); assert.equal(h.capture.verification, 'captured-unverified');
  assert.deepEqual(h.currentness, { capturedSlot: 1000n, latestSlot: 2000n, slotsBehind: 1000n, current: 'unverified', age: 'unknown' });
  assert.equal(h.economy.stores[0].value, '1220000');
  assert.ok(!('tile' in h) && !Number.isInteger(h.p), 'never shaped like a legacy holding');
  assert.ok(Object.isFrozen(h) && Object.isFrozen(r));
  // the world is recomputed from the public season address and program when the caller does not pin it
  assert.equal(parseWideInventory(record(), { ...PINS, world: undefined }).context.world, WORLD);
  // two wide slots, in order, each at its own canonical address
  const two = parseWideInventory(record({ ctx: context({ inventory: inventory('legacy', 'wide', 'wide') }), entries: [entry(FAR), entry({ ...NEAR, slot: 3, site: 7 })] }), pinsOf(['legacy', 'wide', 'wide']));
  assert.deepEqual(two.slots.map(s => [s.inventorySlot, String(s.holding.p)]), [[2, '9007199254740993'], [3, '129']]);
  refused(() => parseWideInventory(record(), { seasonId: '5' }), 'NoSeasonYet');
  const cases = [
    ['half a record', x => { delete x.wideContext; }, 'BadWideRecord'],
    ['entries without an envelope', x => { x.wideContext = null; }, 'BadWideRecord'],
    ['executable', x => { x.wideContext.executable = true; }, 'BadWideRecord'],
    ['verified envelope', x => { x.wideContext.verification = 'verified'; }, 'BadWideRecord'],
    ['another world', x => { x.wideContext.world = OTHER_WORLD; }, 'WorldMismatch'],
    ['another season', x => { x.wideContext.season = '6'; }, 'WrongSeason'],
    ['another Citizen', x => { x.wideContext.citizen = OTHER_CITIZEN; }, 'WrongKey'],
    ['an answer naming another Citizen address', x => { x.citizen = { address: OTHER_CITIZEN }; }, 'WrongKey'],
    ['an answer naming an address that is not one', x => { x.citizen = { address: 'not-an-address' }; }, 'WrongKey'],
    ['a wide first home', x => { x.wideContext.inventory[0].binding = 'wide'; }, 'BadWideRecord'],
    ['two inventory slots', x => { x.wideContext.inventory.pop(); }, 'BadWideRecord'],
    ['an unknown binding', x => { x.wideContext.inventory[2].binding = 'free'; }, 'BadWideRecord'],
    ['a binding the Citizen bytes contradict', x => { x.wideContext.inventory[2].binding = 'wide'; }, 'BadWideRecord'],
    ['a latest slot that is not a decimal', x => { x.wideContext.latestSlot = 2000; }, 'BadWideRecord'],
    ['a wide binding without its entry', x => { x.wideHoldings = []; }, 'BadWideRecord'],
    ['an entry twice', x => { x.wideHoldings.push(clone(x.wideHoldings[0])); }, 'BadWideRecord'],
    ['an entry for a slot not bound wide', x => { x.wideHoldings[0].inventorySlot = 3; x.wideHoldings[0].holding.inventorySlot = 3; }, 'BadWideRecord'],
    ['an unknown status', x => { x.wideHoldings[0].status = 'captured'; }, 'BadWideRecord'],
    ['captured without a holding', x => { x.wideHoldings[0].holding = null; }, 'BadWideRecord'],
    ['not captured with a holding', x => { x.wideHoldings[0].status = 'not-captured'; }, 'BadWideRecord'],
    ['a holding of another world', x => { x.wideHoldings[0].holding.world = OTHER_WORLD; }, 'WorldMismatch'],
    ['a non-canonical coordinate', x => { x.wideHoldings[0].holding.p = '+9007199254740993'; }, 'BadCoord'],
    ['a coordinate through Number', x => { x.wideHoldings[0].holding.p = 9007199254740993; }, 'BadCoord'],
    ['a lying ring', x => { x.wideHoldings[0].holding.ring = '129'; }, 'BadWideCapture'],
    // (a summary place or site that disagrees with the bytes moves the canonical address too: the address is checked
    // first, so the refusal is the identity's, not the summary's)
    ['a summary place the bytes contradict', x => { x.wideHoldings[0].holding.p = '9007199254740994'; x.wideHoldings[0].holding.ring = String(ringPosition(9007199254740994n, -130n).ring); }, 'WrongKey'],
    ['a summary site the bytes contradict', x => { x.wideHoldings[0].holding.site = 4; }, 'WrongKey'],
    ['a summary generation the bytes contradict', x => { x.wideHoldings[0].holding.generation = 2; }, 'BadWideCapture'],
    ['a holding of another season', x => { x.wideHoldings[0].holding.season = '6'; }, 'WrongSeason'],
    ['a holding of another owner', x => { x.wideHoldings[0].holding.ownerCitizen = OTHER_CITIZEN; }, 'WrongKey'],
    ['bytes of another owner', x => { x.wideHoldings[0].holding.capture.bytes_b64 = toBase64(wideBytes({ ...FAR, owner: OTHER_OWNER })); }, 'WrongKey'],
    ['bytes of another slot', x => { x.wideHoldings[0].holding.capture.bytes_b64 = toBase64(wideBytes({ ...FAR, slot: 3 })); }, 'BadWideCapture'],
    ['bytes of another generation', x => { x.wideHoldings[0].holding.capture.bytes_b64 = toBase64(wideBytes({ ...FAR, gen: 2 })); }, 'BadWideCapture'],
    ['not at its canonical address', x => { x.wideHoldings[0].holding.capture.address = wideHoldingAddress(SEASON_ADDR, PROGRAM, FAR.p, FAR.q, 4); }, 'WrongKey'],
    ['an address that is not one', x => { x.wideHoldings[0].holding.capture.address = 'not-base58-0OIl'; }, 'BadWideCapture'],
    ['a capture ahead of the fold', x => { x.wideHoldings[0].holding.capture.slot = '2001'; }, 'BadWideCapture'],
    ['a capture past the folded archive', x => { x.wideHoldings[0].holding.capture.archiveSequence = '41'; }, 'BadWideCapture'],
    ['a capture timing that is not the fold\'s', x => { x.wideHoldings[0].holding.capture.postState = 'at-or-after-transaction'; }, 'BadWideCapture'],
    ['a verified capture', x => { x.wideHoldings[0].holding.capture.verification = 'verified'; }, 'BadWideCapture'],
    ['short bytes', x => { x.wideHoldings[0].holding.capture.bytes_b64 = toBase64(wideBytes(FAR).slice(0, 1280)); }, 'BadWideCapture'],
    ['bytes that are not base64', x => { x.wideHoldings[0].holding.capture.bytes_b64 = '***'; }, 'BadWideCapture'],
    ['an unknown host identity', x => { x.wideHoldings[0].holding.hostIdentity = 2; }, 'BadWideCapture'],
    ['a host identity the bytes contradict', x => { x.wideHoldings[0].holding.hostIdentity = 1; }, 'BadWideCapture'],
    ['open transits the bytes contradict', x => { x.wideHoldings[0].holding.openTransits = 1; }, 'BadWideCapture'],
  ];
  for (const [what, edit, code] of cases) { const x = record(); edit(x); refused(() => parseWideInventory(x, PINS), code); }
  // the pins themselves: no expected Citizen, no Citizen bytes, bytes of another viewer
  refused(() => parseWideInventory(record(), { ...PINS, citizen: null }), 'NoCitizenPin');
  refused(() => parseWideInventory(record(), { ...PINS, citizen: undefined }), 'NoCitizenPin');
  refused(() => parseWideInventory(record(), { ...PINS, citizen: 'not-an-address' }), 'NoCitizenPin');
  refused(() => parseWideInventory(record(), { ...PINS, citizenRecord: null }), 'BadWideRecord');
  refused(() => parseWideInventory(record(), { ...PINS, citizenRecord: { holding: [{ gen: 255 }] } }), 'BadWideRecord');
  refused(() => parseWideInventory(record(), pinsOf(['legacy', 'empty', 'empty'])), 'BadWideRecord');
  refused(() => parseWideInventory(record(), pinsOf(['legacy', 'legacy', 'empty'])), 'BadWideRecord');
  refused(() => parseWideInventory(record(), { ...PINS, viewerKey: WALLET_B }), 'WrongKey');
  assert.equal(parseWideInventory(record(), { ...PINS, viewerKey: WALLET_A }).status, 'ready');
  // an answer that names no Citizen address at all is still bound by the pin (never shown on its own word)
  assert.equal(parseWideInventory(record({ citizen: {} }), PINS).status, 'ready');
  assert.equal(parseWideInventory(record({ citizen: undefined }), PINS).status, 'ready');
});

test('an NFT viewer\'s wide inventory reads the program\'s NFT Citizen bytes (workstream 20, vectors/v2/resident-citizen.json)', () => {
  // The Citizen bytes frontier-abi `resident_citizen::mark` writes (WALLET zero, the asset in RSV_348, the flag),
  // decoded by the client's codec; the slot refs are home (2,0,3) gen 1, a wide ref and an empty slot.
  const V = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/resident-citizen.json', import.meta.url), 'utf8'));
  const bytes = name => decode('Citizen', fromHex(V.cases.find(c => c.case === name).bytes), { seasonId: 5 });
  const nft = bytes('nft');
  const at = residentCitizen(PIN.addresses, V.asset), owner = fromB58(at);
  const r = record({ ctx: context({ citizen: at }), entries: [entry({ ...FAR, owner })], citizen: { address: at } });
  const pins = { ...PINS, citizen: at, citizenRecord: nft, viewerKey: V.asset };
  assert.equal(parseWideInventory(r, pins).status, 'ready');
  // another viewer, or a flagged Citizen the program never writes, is refused
  refused(() => parseWideInventory(r, { ...pins, viewerKey: WALLET_A }), 'WrongKey');
  refused(() => parseWideInventory(r, { ...pins, citizenRecord: bytes('flagged_with_wallet') }), 'WrongKey');
  refused(() => parseWideInventory(r, { ...pins, citizenRecord: bytes('flagged_zero_asset') }), 'WrongKey');
  // the program's wallet Citizen bytes for the asset viewer: another viewer
  refused(() => parseWideInventory(r, { ...pins, citizenRecord: bytes('wallet') }), 'WrongKey');
});

test('a record with Citizen A\'s bytes and no Citizen address cannot show Citizen B\'s internally consistent wide inventory (regression)', () => {
  // B's inventory, valid on its own: B's envelope, B's capture at its canonical address, B's bytes
  const b = record({ ctx: context({ citizen: OTHER_CITIZEN }), entries: [entry({ ...FAR, owner: OTHER_OWNER })], citizen: {} });
  assert.equal(parseWideInventory(b, { ...PINS, citizen: OTHER_CITIZEN, citizenRecord: citizenRecord({ wallet: WALLET_B }) }).status, 'ready', 'B sees B');
  // the viewer is A (the pin is A's own derivation; the answer omits the address): refused, never A's screen with B's village
  refused(() => parseWideInventory(b, PINS), 'WrongKey');
  // the envelope and the summary forged to name A while the capture is B's: the bytes name another owner
  const forged = clone(b); forged.wideContext.citizen = CITIZEN; forged.wideHoldings[0].holding.ownerCitizen = CITIZEN;
  refused(() => parseWideInventory(forged, PINS), 'WrongKey');
  // B's record under A's bytes with a slot A's bytes do not bind wide
  const three = record({ ctx: context({ citizen: OTHER_CITIZEN, inventory: inventory('legacy', 'wide', 'wide') }), entries: [entry({ ...FAR, owner: OTHER_OWNER }), entry({ ...NEAR, slot: 3, owner: OTHER_OWNER })], citizen: {} });
  refused(() => parseWideInventory(three, PINS), 'WrongKey');
  refused(() => parseWideInventory({ ...three, wideContext: { ...three.wideContext, citizen: CITIZEN } }, PINS), 'BadWideRecord', 'A\'s bytes bind one wide slot, not two');
  // through the page's adoption: an error, no data, no selection, no pip; the legacy arrays are not touched
  const FS = { mode: 'play', tab: 'map', holdings: [], wideHoldings: null, wideStatus: 'loading', wideError: null, wideSelect: null };
  assert.equal(adoptWide(FS, record(), PINS), 'ready'); assert.equal(selectWide(FS, 2), true);
  assert.equal(adoptWide(FS, b, PINS), 'error');
  assert.deepEqual([FS.wideStatus, FS.wideHoldings, FS.wideSelect, FS.wideError.code, FS.holdings], ['error', null, null, 'WrongKey', []]);
  assert.equal(flat(renderWidePips(FS)), ''); assert.equal(wideModel(FS).kind, 'none'); assert.equal(selectWide(FS, 2), false);
  // no expected Citizen at all: refused, never shown
  assert.equal(adoptWide(FS, record(), { ...PINS, citizen: null }), 'error'); assert.equal(FS.wideError.code, 'NoCitizenPin');
});

test('absent, not-captured, ambiguous and stale captures stay apart from an empty inventory and never read as zero or as a free slot', () => {
  // a herald without the wide index: unknown, not "no wide villages"
  const none = parseWideInventory({ v: 1, citizen: { address: CITIZEN }, holdings: [], slots: [] }, PINS);
  assert.equal(none.status, 'unavailable'); assert.deepEqual(none.slots, []); assert.equal(none.context, null);
  assert.equal(parseWideInventory({ v: 1, wideContext: null, wideHoldings: [] }, PINS).status, 'unavailable');
  // an empty wide inventory: ready, with the bindings and no slot
  const empty = parseWideInventory(record({ ctx: context({ inventory: inventory('legacy', 'legacy', 'empty') }), entries: [] }), pinsOf(['legacy', 'legacy', 'empty']));
  assert.equal(empty.status, 'ready'); assert.deepEqual(empty.slots, []);
  // a wide slot the fold has not captured: explicit, with no holding and no figures
  const missing = parseWideInventory(record({ entries: [entry({ slot: 2, status: 'not-captured' })] }), PINS);
  assert.deepEqual(missing.slots, [{ inventorySlot: 2, status: 'not-captured', holding: null }]);
  const ambiguous = parseWideInventory(record({ entries: [entry({ slot: 2, status: 'ambiguous' })] }), PINS);
  assert.equal(ambiguous.slots[0].status, 'ambiguous'); assert.equal(ambiguous.slots[0].holding, null);
  // a capture far behind the fold's latest slot: the distance is a slot count, currentness is never claimed, the age is unknown
  const stale = parseWideInventory(record({ ctx: context({ latestSlot: '9007199254740994' }) }), PINS).slots[0].holding;
  assert.equal(stale.currentness.slotsBehind, 9007199254740994n - 1000n);
  assert.equal(stale.currentness.current, 'unverified'); assert.equal(stale.currentness.age, 'unknown');
  const fresh = parseWideInventory(record({ ctx: context({ latestSlot: '1000' }) }), PINS).slots[0].holding;
  assert.equal(fresh.currentness.slotsBehind, 0n); assert.equal(fresh.currentness.current, 'unverified', 'even at the latest slot nothing is called current');
  // the cards say so (no ledger and no zero for a missing capture; the slot count is not a time; the age is unknown)
  const FS = { mode: 'play', tab: 'holding', holdings: [], wideSelect: null };
  adoptWide(FS, record({ entries: [entry({ slot: 2, status: 'not-captured' })] }), PINS); selectWide(FS, 2);
  let out = flat(renderWide(FS));
  assert.match(out, /捕捉なし/); assert.match(out, /不明です/); assert.doesNotMatch(out, /<table/); assert.doesNotMatch(out, /ledger-val/);
  assert.match(out, /data-act="wide-close"/); assert.match(out, /wide-noexec/);
  assert.equal(wideModel(FS).status, 'not-captured'); assert.equal(wideModel(FS).executable, false);
  adoptWide(FS, record({ entries: [entry({ slot: 2, status: 'ambiguous' })] }), PINS); selectWide(FS, 2);
  out = flat(renderWide(FS));
  assert.match(out, /複数の捕捉記録/); assert.doesNotMatch(out, /<table/); assert.match(out, /wide-noexec/);
  adoptWide(FS, record({ ctx: context({ latestSlot: '9007199254740994' }) }), PINS); selectWide(FS, 2);
  out = flat(renderWide(FS));
  assert.match(out, /9007199254740994/); assert.match(out, /9007199254740993/); assert.match(out, /-130/);
  assert.match(out, /9007199254739994 スロット（時間ではありません）/);
  assert.match(out, /現在性：未確認/); assert.match(out, /経過時間：不明/); assert.match(out, /捕捉・未検証/);
  assert.doesNotMatch(out, /あと |満杯まで|\/時/, 'no countdown, no projection');
  assert.match(out, /1220\.000/); assert.match(out, /6000\.000/); assert.match(out, /40\.000/);
  assert.match(out, /2027-01-15 09:00:00/, 'the queue item\'s recorded due time, as recorded');
  assert.equal(formatMilli('1220000'), '1220.000'); assert.equal(formatMilli('-1500'), '−1.500'); assert.equal(formatMilli('9007199254740993001'), '9007199254740993.001');
  assert.equal(recordedTime('0'), '0'); assert.match(recordedTime('1800000000'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

// ================================================================== the page: legacy untouched, wide beside it
test('the legacy village, its model, activeHolding and the plate are unchanged; the wide pips stand apart and name no legacy pip', () => {
  const FS = legacyWorld();
  const legacyCards = holdingScreen.render(FS), legacyModel = holdingScreen.holdingModel(FS), legacyRail = flat(hud.renderRail(FS));
  assert.equal(legacyCards.length, 5);
  assert.match(flat(legacyCards), /data-act="harvest"/);
  assert.doesNotMatch(legacyRail, /wide-select/);
  adoptWide(FS, record({ ctx: context({ inventory: inventory('legacy', 'wide', 'wide') }), entries: [entry(FAR), entry({ ...NEAR, slot: 3, site: 7, status: 'not-captured' })] }), pinsOf(['legacy', 'wide', 'wide']));
  assert.equal(FS.wideStatus, 'ready');
  // nothing wide entered the legacy arrays or the active holding
  assert.equal(FS.holdings.length, 1); assert.ok(!FS.holdings.some(isWideHolding));
  assert.equal(activeHolding(FS), FS.holdings[0]);
  assert.deepEqual(holdingScreen.holdingModel(FS).stores, legacyModel.stores);
  assert.equal(flat(holdingScreen.render(FS)), flat(legacyCards), 'no wide selection: the legacy screen, byte for byte');
  // the rail: the legacy plate first and unchanged, then the wide pips
  const rail = flat(hud.renderRail(FS));
  assert.ok(rail.startsWith(legacyRail), 'the plate is the same markup');
  const pips = flat(renderWidePips(FS));
  assert.equal(rail, legacyRail + pips);
  assert.match(pips, /class="plate-pips wide-pips"/);
  assert.match(pips, /data-act="wide-select" data-slot="2" aria-current="false"[^>]*読み取り専用/);
  assert.match(pips, /data-act="wide-select" data-slot="3" aria-current="false"[^>]*捕捉なし/);
  assert.doesNotMatch(pips, /holding-go|holding-pick|data-i=/);
  // selecting: the active legacy holding stays what it was, the pip is current, the village screen is the wide one
  assert.equal(selectWide(FS, 2), true);
  assert.equal(activeHolding(FS), FS.holdings[0]);
  assert.match(flat(renderWidePips(FS)), /data-slot="2" aria-current="true"/);
  // no inventory, unavailable or loading: no pips at all (never a pip for "unknown")
  for (const st of [{ wideStatus: 'loading', wideHoldings: null }, { wideStatus: 'unavailable', wideHoldings: null }, { wideStatus: 'error', wideHoldings: null }]) assert.equal(flat(renderWidePips({ ...FS, ...st })), '');
  assert.equal(flat(renderWidePips({ ...FS, mode: 'spectate' })), '');
});

test('the phone sheet\'s resting markup carries the wide selector with the plate: hud.renderRest, the one composition app.mjs restMarkup uses', () => {
  const FS = legacyWorld();
  const before = hud.renderRest(FS, { next: '' }).map(flat);
  // (workstream 07: the inventory's status line stands after the next row, so the next row stays whole in the phone's peek)
  assert.equal(before.length, 5, 'plate, wide pips, the next row, the inventory status, the to-do lines');
  assert.equal(before[0], flat(hud.renderPlate(FS)), 'the plate first, as before');
  assert.equal(before[1], '', 'no inventory read yet: no pip (never a pip for "unknown")');
  assert.equal(before[3], '', 'no status line while the inventory is being read');
  assert.equal(before[4], flat(hud.renderTodo(FS, { max: 8, open: true })));
  assert.doesNotMatch(before.join(''), /wide-select/);
  adoptWide(FS, record({ ctx: context({ inventory: inventory('legacy', 'wide', 'wide') }), entries: [entry(FAR), entry({ ...NEAR, slot: 3, site: 7, status: 'not-captured' })] }), pinsOf(['legacy', 'wide', 'wide']));
  const after = hud.renderRest(FS, { next: '<next-row/>', todoMax: 8 }).map(flat);
  assert.equal(after[0], before[0], 'the plate is unchanged, byte for byte');
  assert.equal(after[1], flat(renderWidePips(FS)), 'the same read-only pips the desktop rail carries');
  assert.match(after[1], /data-act="wide-select" data-slot="2" aria-current="false"/);
  assert.match(after[1], /data-act="wide-select" data-slot="3"/);
  assert.equal(after[2], '<next-row/>', 'the caller\'s next row, after the pips');
  assert.equal(after[3], '', 'a ready inventory has no status line');
  assert.equal(after[4], before[4]);
  assert.doesNotMatch(after[0], /wide-select/, 'one copy: never inside the plate or among its legacy pips');
  // a selection marks the pip in the sheet too; unavailable and error show none
  selectWide(FS, 3);
  assert.match(hud.renderRest(FS).map(flat)[1], /data-slot="3" aria-current="true"/);
  for (const st of [{ wideStatus: 'unavailable', wideHoldings: null }, { wideStatus: 'error', wideHoldings: null }]) {
    const parts = hud.renderRest({ ...FS, ...st }, { next: '<next-row/>' }).map(flat);
    assert.doesNotMatch(parts[1], /wide-select/);
    assert.equal(parts[2], '<next-row/>');
    assert.match(parts[3], /wide-inventory-status/, 'said, after the next row');
  }
  // the phone path in app.mjs is this composition (a source check: app.mjs is not importable without a document)
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const at = app.indexOf('export function restMarkup(');
  assert.ok(at > 0);
  const rest = app.slice(at, app.indexOf('\n}', at));
  assert.match(rest, /return hud\.renderRest\(FS, \{ next: /);
  assert.doesNotMatch(rest, /hud\.renderPlate\(|hud\.renderTodo\(/, 'the plate and the lines come through renderRest alone');
  // and the desktop rail still renders the same pips after the plate
  assert.ok(flat(hud.renderRail(FS)).endsWith(flat(renderWidePips(FS))));
});

test('selecting a wide slot swaps the village screen for read-only cards with no legacy control; closing or any legacy selection brings the legacy screen back', () => {
  const FS = legacyWorld();
  adoptWide(FS, record(), PINS);
  assert.equal(selectWide(FS, 2), true);
  assert.equal(FS.tab, 'holding');
  const cards = holdingScreen.render(FS);
  assert.equal(cards.length, 6, 'head, provenance, stores, building, troops, the rest');
  const out = flat(cards);
  for (const act of ['harvest', 'build', 'train', 'muster', 'garrison', 'nudge', 'step', 'step-set', 'compose', 'dissolve', 'explore-open', 'march-home']) assert.doesNotMatch(out, new RegExp(`data-act="${act}"`), `no ${act} control`);
  assert.doesNotMatch(out, /data-form=|<form|<input|<select|type="submit"/, 'no form at all');
  assert.match(out, /data-act="wide-close"/);
  assert.match(out, /P 9007199254740993, Q -130/);
  assert.match(out, /村の場所 3 · 世代 1/);
  assert.match(out, new RegExp(wideHoldingAddress(SEASON_ADDR, PROGRAM, FAR.p, FAR.q, 3)));
  assert.match(out, new RegExp(CITIZEN));
  assert.match(out, /<dt>捕捉スロット<\/dt><dd>1000<\/dd>/); assert.match(out, /<dt>配信元の最新スロット<\/dt><dd>2000<\/dd>/);
  assert.match(out, /履歴未検証/); assert.match(out, /取引直後/);
  assert.match(out, /控え 500/); assert.match(out, /槍兵 400|Spearman 400/); assert.match(out, /建設中 1/);
  assert.match(out, /命令を送れません/);
  assert.equal((out.match(/wide-noexec/g) ?? []).length, 1);
  // the model the tests read
  const m = wideModel(FS);
  assert.equal(m.kind, 'wide'); assert.equal(m.executable, false); assert.equal(m.stores[0].value, '1220.000'); assert.equal(m.queue.length, 1); assert.equal(m.reserve.length, 2);
  // back: the wide card's own press, then the legacy screen as before
  clearWideSelect(FS);
  assert.equal(FS.wideSelect, null);
  assert.match(flat(holdingScreen.render(FS)), /data-act="harvest"/);
  assert.equal(holdingScreen.render(FS).length, 5);
  // the inventory is still there for the pips; selecting again is one selection, selecting a slot not offered is refused
  assert.equal(selectWide(FS, 2), true); assert.equal(selectWide(FS, 2), true);
  assert.deepEqual({ ...FS.wideSelect }, { inventorySlot: 2, key: `${WORLD}:${FAR.p},${FAR.q}:3:1`, status: 'captured-unverified' });
  assert.equal(selectWide(FS, 3), false); assert.equal(selectWide(FS, 1), false); assert.equal(selectWide(FS, '2x'), false);
  assert.equal(FS.wideSelect.inventorySlot, 2, 'a refused selection changes nothing');
  assert.equal(wideModel({ ...FS, wideSelect: null }).kind, 'none');
  assert.equal(renderWide({ ...FS, wideSelect: null }), '');
});

// ================================================================== the guard
test('the central guard refuses every legacy order routed at a wide village — forged datasets, repeated presses, stale forms, programmatic calls — and lets legacy orders on the legacy screen through', () => {
  const FS = { mode: 'play', tab: 'holding', holdings: [{ p: 2, q: 0, site: 3, gen: 1, tile: 30 }], wideSelect: { inventorySlot: 2, key: 'k', status: 'captured-unverified' } };
  const calls = [], refusals = [];
  const table = { harvest: () => calls.push('harvest'), build: d => calls.push(['build', d.item]), muster: d => calls.push(['muster', d.unit]), tab: d => calls.push(['tab', d.tab]), 'wide-close': () => calls.push('close') };
  guardLegacy(table, GUARDED_ACTS, { FS, refuse: r => { refusals.push(r.code); return r; } });
  const forms = { train: f => calls.push(['train', f.elements.n.value]), vigil: () => calls.push('vigil') };
  guardLegacy(forms, GUARDED_FORMS, { FS, refuse: r => { refusals.push(r.code); return r; } });
  assert.equal(table.harvest({}).code, 'WideReadOnly');
  table.build({ item: '0' }); table.build({ item: '0' }); table.build({ item: '7' });
  table.muster({ unit: '0', troops: '100' });
  forms.train({ elements: { n: { value: '100' } } });
  assert.deepEqual(calls, []);
  assert.equal(refusals.length, 6); assert.ok(refusals.every(c => c === 'WideReadOnly'));
  // orders that are not a village's pass (the tab switch, closing the wide card, the vigil form)
  table.tab({ tab: 'map' }); table['wide-close'](); forms.vigil();
  assert.deepEqual(calls, [['tab', 'map'], 'close', 'vigil']);
  // the wide card closed: the same controls run their legacy orders
  FS.wideSelect = null; calls.length = 0;
  table.harvest({}); table.build({ item: '0' }); forms.train({ elements: { n: { value: '100' } } });
  assert.deepEqual(calls, ['harvest', ['build', '0'], ['train', '100']]);
  // a wide selection with the village screen away (the map, the hosts): the legacy hand's orders are the legacy village's
  FS.wideSelect = { inventorySlot: 2 }; FS.tab = 'map'; calls.length = 0;
  table.muster({ unit: '0' });
  assert.deepEqual(calls, [['muster', '0']]);
  // the instruction guard: a wide holding among the subjects is refused anywhere, on any screen
  const wide = parseWideInventory(record(), PINS).slots[0].holding;
  const legacy = FS.holdings[0];
  for (const name of GUARDED_INSTRUCTIONS) assert.equal(wideRefusal(name, { holding: wide }, { tab: 'map', wideSelect: null })?.code, 'WideReadOnly', name);
  assert.equal(wideRefusal('FileOutpost', { sites: [wide], anchor: legacy }, { tab: 'map', wideSelect: null })?.code, 'WideReadOnly');
  assert.equal(wideRefusal('SendCaravan', { holding: legacy, dst: { kind: 'holding', p: 9007199254740993n, q: -130n } }, { tab: 'map', wideSelect: null })?.code, 'WideReadOnly', 'a BigInt coordinate is never legacy');
  assert.equal(wideRefusal('Harvest', { holding: { ...legacy, wide: true } }, { tab: 'map', wideSelect: null })?.code, 'WideReadOnly', 'a forged flag');
  assert.equal(wideRefusal('SetVigil', {}, { tab: 'map', wideSelect: null }), null);
  assert.equal(wideRefusal('Harvest', { holding: legacy }, { tab: 'map', wideSelect: null }), null);
  assert.equal(wideRefusal('Harvest', { holding: legacy }, { tab: 'holding', wideSelect: null }), null);
  assert.equal(wideRefusal('Harvest', { holding: legacy }, { tab: 'holding', wideSelect: { inventorySlot: 2 } })?.code, 'WideReadOnly', 'a stale legacy control under the wide card');
  assert.equal(wideRefusal('Harvest', null, { tab: 'holding', wideSelect: { inventorySlot: 2 } })?.code, 'WideReadOnly');
  assert.equal(wideRefusal('SetVigil', null, { tab: 'holding', wideSelect: { inventorySlot: 2 } }), null, 'a Citizen order is not a village order');
  assert.equal(wideRefusal('Harvest', { holding: legacy }, { tab: 'holding', wideSelect: { inventorySlot: 2 } }).text.length > 0, true);
  // the send-time check judges the subjects alone (no page state): a legacy subject passes whatever the screen shows, a wide one never
  assert.equal(wideRefusal('Harvest', { holding: legacy }, null), null);
  assert.equal(wideRefusal('Harvest', { holding: wide }, null)?.code, 'WideReadOnly');
  assert.deepEqual(assertLegacySubjects('SettleTransit', { holding: legacy, settle: { dest: { p: 3, q: 0 } } }), { holding: legacy, settle: { dest: { p: 3, q: 0 } } });
  refused(() => assertLegacySubjects('SettleTransit', { holding: wide, settle: {} }), 'WideReadOnly');
  refused(() => assertLegacySubjects('SettleTransit', { holding: legacy, settle: { campCitizen: wide } }), 'WideReadOnly');
  assert.ok(namesWide([legacy, wide]) && !namesWide([legacy]) && !namesWide(null) && !namesWide('x') && namesWide({ a: { b: 1 }, c: [wide] }));
  assert.ok(isWideHolding(wide) && !isWideHolding(legacy) && !isWideHolding(null));
});

// ================================================================== switches, failures, late answers (the module's own state transitions)
test('a Citizen, world or source switch, a failed read and a late answer for another viewer clear the wide selection and data; the same source keeps and follows it', () => {
  const FS = { mode: 'play', tab: 'map', holdings: [], wideHoldings: null, wideStatus: 'loading', wideError: null, wideSelect: null };
  assert.equal(adoptWide(FS, record(), PINS), 'ready');
  assert.equal(selectWide(FS, 2), true);
  // the same source answers again with a newer capture of the same slot: the selection follows the new capture
  assert.equal(adoptWide(FS, record({ entries: [entry({ ...FAR, gen: 2, bytes: wideBytes({ ...FAR, gen: 2 }), capture: { slot: '1500' } })] }), PINS), 'ready');
  assert.equal(FS.wideSelect.inventorySlot, 2); assert.equal(FS.wideSelect.key, `${WORLD}:${FAR.p},${FAR.q}:3:2`);
  assert.equal(selectedWide(FS).holding.currentness.capturedSlot, 1500n);
  // the slot stops being wide-bound (unbound on chain, the Citizen bytes say so too): the selection goes, the inventory stays
  assert.equal(adoptWide(FS, record({ ctx: context({ inventory: inventory('legacy', 'empty', 'empty') }), entries: [] }), pinsOf(['legacy', 'empty', 'empty'])), 'ready');
  assert.equal(FS.wideSelect, null); assert.deepEqual(wideSlots(FS), []);
  // the slot is wide again but not captured: selectable, shown as unknown
  adoptWide(FS, record({ entries: [entry({ slot: 2, status: 'not-captured' })] }), PINS); assert.equal(selectWide(FS, 2), true); assert.equal(FS.wideSelect.status, 'not-captured');
  // a late answer for another Citizen (an NFT resident or wallet switch), with that Citizen pinned: the old choice is not this one's
  const other = record({ ctx: context({ citizen: OTHER_CITIZEN }), entries: [entry({ ...FAR, owner: OTHER_OWNER })], citizen: { address: OTHER_CITIZEN } });
  const otherPins = { ...PINS, citizen: OTHER_CITIZEN, citizenRecord: citizenRecord({ wallet: WALLET_B }) };
  assert.equal(adoptWide(FS, other, otherPins), 'ready');
  assert.equal(FS.wideSelect, null);
  assert.equal(FS.wideHoldings.context.citizen, OTHER_CITIZEN);
  // another season (another source): the same
  selectWide(FS, 2);
  const otherSeason = { ...otherPins, seasonAddress: OTHER_SEASON_ADDR, seasonId: '6' };
  const six = record({ ctx: context({ citizen: OTHER_CITIZEN, world: OTHER_WORLD, season: '6' }), entries: [entry({ ...FAR, owner: OTHER_OWNER, env: OTHER_ENV })], citizen: { address: OTHER_CITIZEN } });
  assert.equal(adoptWide(FS, six, otherSeason), 'ready');
  assert.equal(FS.wideSelect, null);
  // a malformed answer: no data, no selection, the code kept; the legacy arrays are not this module's to touch
  selectWide(FS, 2);
  const bad = clone(six); bad.wideContext.world = WORLD;
  assert.equal(adoptWide(FS, bad, otherSeason), 'error');
  assert.equal(FS.wideHoldings, null); assert.equal(FS.wideSelect, null); assert.equal(FS.wideError.code, 'WorldMismatch'); assert.deepEqual(FS.holdings, []);
  assert.deepEqual(wideSlots(FS), []); assert.equal(selectedWide(FS), null); assert.equal(selectWide(FS, 2), false);
  // a herald without the wide fields: unavailable, and a selection cannot stand on it
  adoptWide(FS, record(), PINS); selectWide(FS, 2);
  assert.equal(adoptWide(FS, { v: 1, holdings: [], slots: [] }, PINS), 'unavailable');
  assert.equal(FS.wideSelect, null);
  // a failed /h/me read, and a wallet or source change
  adoptWide(FS, record(), PINS); selectWide(FS, 2);
  failWide(FS, 'network');
  assert.deepEqual([FS.wideStatus, FS.wideHoldings, FS.wideSelect, FS.wideError.code], ['error', null, null, 'network']);
  adoptWide(FS, record(), PINS); selectWide(FS, 2);
  clearWide(FS);
  assert.deepEqual([FS.wideStatus, FS.wideHoldings, FS.wideSelect, FS.wideError], ['loading', null, null, null]);
  // reconcile on its own: a selection naming a slot the inventory no longer offers is dropped
  adoptWide(FS, record(), PINS); FS.wideSelect = { inventorySlot: 3 }; reconcileSelect(FS); assert.equal(FS.wideSelect, null);
  FS.wideSelect = { inventorySlot: 2 }; reconcileSelect(FS); assert.equal(FS.wideSelect.key, `${WORLD}:${FAR.p},${FAR.q}:3:1`);
});

// ================================================================== the controller's glue (a fake herald, a fake transport; no key, no network)
/** One `/h/me` answer as the herald client hands it to the controller: the decoded Citizen beside the record (the wide fields inside it). */
const meOf = (citizen, wide = null) => ({ ok: true, citizen, holdings: [], slots: [], record: { v: 1, citizen: {}, holdings: [], slots: [], hosts: [], ...(wide ?? {}) } });
/** The wide fields of a record about `citizenAddr`, whose one captured village is owned by `owner` (the answer's own address stays omitted). */
const wideOf = (citizenAddr, owner) => { const r = record({ ctx: context({ citizen: citizenAddr }), entries: [entry({ ...FAR, owner })] }); return { wideContext: r.wideContext, wideHoldings: r.wideHoldings }; };
const NFT = Object.freeze({ asset: ASSET, generation: 1, joined: true });
/** The store as a playing page has it, minus the DOM: a pinned season, the wallet connected, no legacy village, nothing in flight. */
const baseStore = () => ({
  mode: 'play', tab: 'map', clock: { genesisTs: 0 }, chain: { now: () => 6000 }, wallet: { address: WALLET_A }, resident: null, nfts: null,
  session: null, sessionProblem: null, delegation: null, agentWallet: false, season: {}, record: { seasonAddress: SEASON_ADDR, programId: PROGRAM, season: '5' }, proto: null,
  provinces: new Map(), overviews: new Map(), chronicle: [], landRec: null, land: null, citizen: null, holdings: [], activeHolding: 0, meStatus: 'loading', meError: null,
  notice: null, orders: [], marches: [], incoming: [], inFlight: 0, autoTicketBusy: true, homeGrant: null,
  wideHoldings: null, wideStatus: 'loading', wideError: null, wideSelect: null,
});
const keepStore = () => { const saved = { ...STORE }; return () => { for (const k of Object.keys(STORE)) if (!(k in saved)) delete STORE[k]; Object.assign(STORE, saved); }; };
const settle = async (until, n = 40) => { for (let i = 0; i < n && !until(); i++) await Promise.resolve(); if (!until()) await new Promise(r => setTimeout(r, 0)); };

test('the controller pins the wide inventory to the Citizen it derives from the wallet or the NFT played, never to the answer (applyMeResult)', () => {
  const restore = keepStore();
  try {
    Object.assign(STORE, baseStore());
    // Citizen A's bytes, no address in the answer, Citizen B's internally consistent wide inventory: refused
    assert.equal(CTRL.applyMeResult(meOf(citizenRecord(), wideOf(OTHER_CITIZEN, OTHER_OWNER))), 'found');
    assert.deepEqual([STORE.wideStatus, STORE.wideHoldings, STORE.wideSelect, STORE.wideError.code], ['error', null, null, 'WrongKey']);
    assert.deepEqual(STORE.holdings, [], 'the legacy view is untouched'); assert.equal(STORE.meStatus, 'ready');
    assert.equal(flat(renderWidePips(STORE)), '');
    // the answer naming B's address as well: the address is held against the derivation, not believed
    CTRL.applyMeResult(meOf(citizenRecord(), { ...wideOf(OTHER_CITIZEN, OTHER_OWNER), citizen: { address: OTHER_CITIZEN } }));
    assert.equal(STORE.wideError.code, 'WrongKey');
    // A's own inventory: ready, about A
    CTRL.applyMeResult(meOf(citizenRecord(), wideOf(CITIZEN, OWNER)));
    assert.equal(STORE.wideStatus, 'ready'); assert.equal(STORE.wideHoldings.context.citizen, CITIZEN); assert.equal(STORE.wideError, null);
    assert.match(flat(renderWidePips(STORE)), /data-slot="2"/);
    // A's bytes with slot 2 not bound wide while the envelope says wide: refused
    CTRL.applyMeResult(meOf(citizenRecord({ bindings: ['legacy', 'empty', 'empty'] }), wideOf(CITIZEN, OWNER)));
    assert.equal(STORE.wideError.code, 'BadWideRecord');
    // an envelope without the Citizen bytes: half a record
    CTRL.applyMeResult({ ...meOf(citizenRecord(), wideOf(CITIZEN, OWNER)), citizen: null });
    assert.equal(STORE.wideError.code, 'BadWideRecord');
    // playing an NFT: the pin is the NFT's Citizen; A's inventory is then another Citizen's, and bytes of another viewer are refused
    STORE.resident = { ...NFT, citizen: NFT_CITIZEN };
    CTRL.applyMeResult(meOf(citizenRecord({ wallet: ASSET }), wideOf(CITIZEN, OWNER)));
    assert.equal(STORE.wideError.code, 'WrongKey');
    CTRL.applyMeResult(meOf(citizenRecord({ wallet: WALLET_A }), wideOf(NFT_CITIZEN, NFT_OWNER)));
    assert.equal(STORE.wideError.code, 'WrongKey');
    CTRL.applyMeResult(meOf(citizenRecord({ wallet: ASSET }), wideOf(NFT_CITIZEN, NFT_OWNER)));
    assert.equal(STORE.wideStatus, 'ready'); assert.equal(STORE.wideHoldings.context.citizen, NFT_CITIZEN);
    // no wide fields at all: unavailable, never an empty inventory; NotFound: unavailable, nothing kept
    CTRL.applyMeResult(meOf(citizenRecord({ wallet: ASSET })));
    assert.equal(STORE.wideStatus, 'unavailable');
    CTRL.applyMeResult(meOf(citizenRecord({ wallet: ASSET }), wideOf(NFT_CITIZEN, NFT_OWNER))); selectWide(STORE, 2);
    assert.equal(CTRL.applyMeResult({ ok: false, code: 'NotFound' }), 'missing');
    assert.deepEqual([STORE.wideStatus, STORE.wideHoldings, STORE.wideSelect], ['unavailable', null, null]);
    // a failed read: an error, no data, no selection
    CTRL.applyMeResult(meOf(citizenRecord({ wallet: ASSET }), wideOf(NFT_CITIZEN, NFT_OWNER))); selectWide(STORE, 2);
    assert.equal(CTRL.applyMeResult({ ok: false, code: 'Unavailable' }), 'error');
    assert.deepEqual([STORE.wideStatus, STORE.wideHoldings, STORE.wideSelect, STORE.wideError.code], ['error', null, null, 'Unavailable']);
  } finally { restore(); }
});

test('an NFT login or logout changes the viewer at once: the former viewer\'s wide inventory and selection leave before any read answers; a late answer for a former viewer restores nothing; switches repeat', async () => {
  const restore = keepStore();
  const reads = [];
  const read = async key => {
    await settle(() => reads.some(r => r.key === key));
    const i = reads.findIndex(r => r.key === key);
    assert.ok(i >= 0, `a /h/me read for ${key} (reads: ${reads.map(r => r.key).join(', ')})`);
    return reads.splice(i, 1)[0].resolve;
  };
  try {
    Object.assign(STORE, baseStore(), { nfts: { residents: [{ ...NFT }], policy: { residentProgram: toB58(new Uint8Array(32).fill(0x22)) } } });
    CTRL.useHerald({ me: key => new Promise(resolve => reads.push({ key, resolve })), events: async () => ({ ok: false }) });
    // the wallet's Citizen A: its wide village read and chosen for the village screen
    const first = CTRL.refresh();
    (await read(WALLET_A))(meOf(citizenRecord(), wideOf(CITIZEN, OWNER)));
    await first;
    assert.equal(STORE.wideStatus, 'ready'); assert.equal(STORE.wideHoldings.context.citizen, CITIZEN);
    CTRL.ACTIONS['wide-select']({ slot: '2' });
    assert.equal(STORE.wideSelect.inventorySlot, 2); assert.equal(STORE.tab, 'holding'); assert.equal(wideModel(STORE).kind, 'wide');
    assert.match(flat(renderWidePips(STORE)), /aria-current="true"/);
    // login to the NFT: synchronously, before its read answers, A's inventory and selection are gone
    const login = CTRL.ACTIONS['nft-login']({ asset: ASSET });
    assert.equal(STORE.resident?.citizen, NFT_CITIZEN, 'the NFT\'s Citizen is derived, not read');
    assert.deepEqual([STORE.wideStatus, STORE.wideHoldings, STORE.wideSelect, STORE.wideError], ['loading', null, null, null], 'cleared while the read is in flight');
    assert.equal(wideModel(STORE).kind, 'none'); assert.equal(flat(renderWidePips(STORE)), '');
    (await read(ASSET))(meOf(citizenRecord({ wallet: ASSET }), wideOf(NFT_CITIZEN, NFT_OWNER)));
    await login;
    assert.equal(STORE.wideStatus, 'ready'); assert.equal(STORE.wideHoldings.context.citizen, NFT_CITIZEN); assert.equal(STORE.wideSelect, null, 'the former viewer\'s choice is not this one\'s');
    CTRL.ACTIONS['wide-select']({ slot: '2' });
    // logout: cleared at once; the wallet's read is in flight
    const logout = CTRL.ACTIONS['nft-logout']();
    assert.equal(STORE.resident, null);
    assert.deepEqual([STORE.wideStatus, STORE.wideHoldings, STORE.wideSelect], ['loading', null, null]);
    const answerWallet = await read(WALLET_A);
    // a repeated switch before that read answers: back to the NFT, cleared again
    const again = CTRL.ACTIONS['nft-login']({ asset: ASSET });
    assert.deepEqual([STORE.wideStatus, STORE.wideSelect, STORE.resident?.citizen], ['loading', null, NFT_CITIZEN]);
    const answerNft = await read(ASSET);
    // the late answer for the wallet (the viewer of two switches ago) arrives first: nothing of it is adopted
    answerWallet(meOf(citizenRecord(), wideOf(CITIZEN, OWNER)));
    await logout;
    assert.deepEqual([STORE.wideStatus, STORE.wideHoldings, STORE.wideSelect], ['loading', null, null], 'a late answer for a former viewer restores nothing');
    answerNft(meOf(citizenRecord({ wallet: ASSET }), wideOf(NFT_CITIZEN, NFT_OWNER)));
    await again;
    assert.equal(STORE.wideStatus, 'ready'); assert.equal(STORE.wideHoldings.context.citizen, NFT_CITIZEN); assert.equal(STORE.wideSelect, null);
    // a final logout answered in order: the wallet's own inventory, no selection carried over
    CTRL.ACTIONS['wide-select']({ slot: '2' });
    const out = CTRL.ACTIONS['nft-logout']();
    assert.equal(STORE.wideSelect, null);
    (await read(WALLET_A))(meOf(citizenRecord(), wideOf(CITIZEN, OWNER)));
    await out;
    assert.equal(STORE.wideStatus, 'ready'); assert.equal(STORE.wideHoldings.context.citizen, CITIZEN); assert.equal(STORE.wideSelect, null);
    // an answer for the wallet that carries the NFT's inventory (a crossed or forged read): refused under the wallet's pin
    const cross = CTRL.refresh();
    (await read(WALLET_A))(meOf(citizenRecord(), wideOf(NFT_CITIZEN, NFT_OWNER)));
    await cross;
    assert.deepEqual([STORE.wideStatus, STORE.wideError.code], ['error', 'WrongKey']);
    // the helper both actions share, on its own
    CTRL.applyMeResult(meOf(citizenRecord(), wideOf(CITIZEN, OWNER))); selectWide(STORE, 2);
    CTRL.adoptResident({ ...NFT, citizen: NFT_CITIZEN });
    assert.deepEqual([STORE.wideStatus, STORE.wideHoldings, STORE.wideSelect, STORE.resident.citizen], ['loading', null, null, NFT_CITIZEN]);
    CTRL.adoptResident(null);
    assert.deepEqual([STORE.wideStatus, STORE.wideSelect, STORE.resident], ['loading', null, null]);
    assert.equal(reads.length, 0, 'no read left unanswered');
  } finally { CTRL.useHerald(null); restore(); }
});

test('a legacy order authorized on the legacy screen runs to its answer after the viewer moves to a wide village; a press under the wide card is refused before anything is built; a wide subject builds no accounts', async () => {
  const restore = keepStore();
  const submits = [];
  let release = null;
  try {
    Object.assign(STORE, baseStore(), {
      session: { publicKey: toB58(new Uint8Array(32).fill(7)), publicKeyBytes: new Uint8Array(32).fill(7) }, citizen: { faction: 0 },
      holdings: [{ p: 2, q: 0, site: 3, gen: 1, tile: 30, state: 2, transit: [], stores: [] }],
    });
    adoptWide(STORE, record(), PINS);
    CTRL.useTransport({ submit: req => new Promise(resolve => { submits.push(req); release = resolve; }), track: async () => ({ ok: false, code: 'Unconfirmed' }) });
    const form = () => ({ elements: { delta: { value: '5' } } });
    // authorized on the legacy screen: built and handed to the transport
    const first = CTRL.FORMS.garrison(form());
    await settle(() => release !== null);
    assert.equal(submits.length, 1); assert.equal(submits[0].name, 'Garrison');
    assert.ok(submits[0].accounts && typeof submits[0].accounts === 'object', 'the accounts of a legacy village, built');
    // unrelated navigation while the send is awaited: the wide village comes onto the village screen
    CTRL.ACTIONS['wide-select']({ slot: '2' });
    assert.equal(STORE.wideSelect.inventorySlot, 2); assert.equal(STORE.tab, 'holding');
    release({ ok: false, code: 'Stub' });
    await first;
    assert.equal(STORE.notice.code, 'Stub', 'the legacy order ran to the transport\'s answer; the navigation did not refuse it');
    assert.equal(STORE.orders[0].state, 'refused'); assert.equal(STORE.orders[0].code, 'Stub');
    // a new press under the wide card (the same form, a stale control, a data-act): refused, nothing built or sent
    await CTRL.FORMS.garrison(form());
    assert.equal(STORE.notice.code, 'WideReadOnly'); assert.equal(submits.length, 1);
    await CTRL.ACTIONS.harvest({});
    assert.equal(STORE.notice.code, 'WideReadOnly'); assert.equal(submits.length, 1);
    await CTRL.ACTIONS.build({ item: '0' });
    assert.equal(STORE.notice.code, 'WideReadOnly'); assert.equal(submits.length, 1);
    // the wide card closed (the village tab kept): the same press sends again
    CTRL.ACTIONS['wide-close']();
    assert.equal(STORE.wideSelect, null);
    release = null;
    const second = CTRL.FORMS.garrison(form());
    await settle(() => release !== null);
    assert.equal(submits.length, 2);
    release({ ok: false, code: 'Stub' });
    await second;
    assert.equal(STORE.notice.code, 'Stub');
  } finally { CTRL.useTransport(null); restore(); }
  // accounts that are a function of the fee payer (a settle) go through assertLegacySubjects inside the constructor,
  // and every send re-checks its subjects: read off the controller's source, since no march can be staged here
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(src, /typeof v === 'function' \? fp => accountsFor\(name, fwide\.assertLegacySubjects\(name, v\(fp\)\)\) : accountsFor\(name, ctx\(v\)\)/);
  assert.match(src, /const late = typeof v === 'object' \? fwide\.wideRefusal\(name, v, null\) : null;/);
  assert.match(src, /'nft-logout': async \(\) => \{ adoptResident\(null\); await refresh\(\); \}/);
  assert.match(src, /adoptResident\(\{ \.\.\.id, joined: true \}\);\n\s+await refresh\(\);/);
});


test('nested subject scans terminate on cycles and refuse a wide reference at any depth', () => {
  const legacy = legacyWorld().holdings[0];
  const v = { holding: legacy }; v.self = v;
  assert.equal(namesWide(v), false);
  v.settle = { nested: [{ deeper: parseWideInventory(record(), PINS).slots[0].holding }] };
  assert.equal(namesWide(v), true);
  refused(() => assertLegacySubjects('SettleTransit', v), 'WideReadOnly');
  const large = { rows: Array.from({ length: 4097 }, () => ({})) };
  assert.equal(namesWide(large), true, 'excessive object graphs fail closed');
});

test('failed and unavailable wide inventory remain visibly unknown in the desktop rail, phone sheet and village panel', () => {
  const FS = legacyWorld();
  adoptWide(FS, record(), PINS); selectWide(FS, 2);
  failWide(FS, 'BadWideCapture');
  for (const render of [hud.renderRail, hud.renderRest, holdingScreen.render]) {
    const output = flat(render(FS));
    assert.match(output, /wide-inventory-status/);
    assert.match(output, /保有地がないことを意味しません/);
    assert.match(output, /data-act="me-retry"/);
    assert.doesNotMatch(output, /data-act="wide-select"/);
  }
  assert.match(flat(holdingScreen.render(FS)), /data-act="harvest"/, 'legacy cards remain usable');
  FS.wideStatus = 'unavailable';
  for (const render of [hud.renderRail, hud.renderRest, holdingScreen.render]) {
    assert.match(flat(render(FS)), /保有地の有無は不明/);
  }
  adoptWide(FS, record({ ctx: context({ inventory: inventory('legacy', 'empty', 'empty') }), entries: [] }),
    { ...PINS, citizenRecord: citizenRecord({ bindings: ['legacy', 'empty', 'empty'] }) });
  assert.equal(FS.wideStatus, 'ready');
  assert.doesNotMatch(flat(hud.renderRest(FS)), /wide-inventory-status|data-act="wide-select"/);
});

test('the desktop rail passes the pointer through, so the wide pips and the wide inventory status (Retry) must opt back in by name (regression: W2/W3 clicks did nothing in Chrome)', () => {
  const css = readFileSync(new URL('../../permutation-server/web/frontier/frontier.css', import.meta.url), 'utf8');
  assert.match(css, /^\.rail\s*\{[^}]*pointer-events:\s*none/m, 'the rail itself stays pointer-transparent');
  const optIn = /^\.rail \.wide-pips,\s*\.rail \.wide-inventory-status\s*\{\s*pointer-events:\s*auto;?\s*\}/m;
  assert.match(css, optIn, '.rail .wide-pips and .rail .wide-inventory-status restore pointer-events: auto');
});

test('the wide stores table lives in a named, focusable scroll region that scrolls inside its card; wide t0 and the blocked status use paper contrast tokens (regression: clipped ledger at 390px, unreadable last column)', () => {
  const FS = { mode: 'play', tab: 'holding', holdings: [], wideSelect: null };
  adoptWide(FS, record(), PINS); selectWide(FS, 2);
  const out = flat(renderWide(FS));
  assert.match(out, /<p class="muted wide-ledger-hint">表は横にスクロールできます<\/p>/, 'a visible hint says the table scrolls sideways');
  assert.match(out, /<div class="wide-ledger-scroll" tabindex="0" role="region" aria-label="資源（捕捉時の記録値）"><table class="ledger">[\s\S]*?<\/table><\/div>/, 'the table is wrapped in a focusable named region');
  assert.equal((out.match(/wide-ledger-scroll/g) ?? []).length, 1, 'only the stores table is wrapped');
  assert.match(out, /ledger-t0/, 'the t0 column is kept');
  const css = readFileSync(new URL('../../permutation-server/web/frontier/frontier.css', import.meta.url), 'utf8');
  assert.match(css, /^\.wide-village \.wide-ledger-scroll\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*overscroll-behavior-x:\s*contain;?[^}]*\}/m, 'the wrapper scrolls horizontally within the card');
  assert.match(css, /^\.wide-village \.ledger-t0\s*\{[^}]*color:\s*var\(--ink-2\)/m, 'wide t0 uses paper ink, not HUD ink');
  assert.doesNotMatch(css, /^\.wide-village \.ledger-t0\s*\{[^}]*--hud-ink/m);
  assert.match(css, /^\.wide-inventory-status\.blocked\s*\{[^}]*background:\s*var\(--paper-sheet\)/m, 'the blocked status gets an opaque paper sheet behind its --err-ink text');
  assert.match(css, /^\.ledger \{ width: 100%;/m, 'the legacy ledger rule is untouched');
  const en = readFileSync(new URL('../../permutation-server/web/lang/en-frontier.mjs', import.meta.url), 'utf8');
  assert.match(en, /"表は横にスクロールできます":\s*"This table scrolls sideways"/, 'the hint is translated');
});
