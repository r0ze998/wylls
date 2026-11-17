// Fixed public fixture data for the wide-holding village screen, mirroring
// web-frontier-wide-holding-ui.test.mjs: a synthetic captured WideHolding at a
// coordinate past 2^53, the viewer's Citizen by the codec's own round trip, and
// the legacy village untouched. Public derivations only (season PDA, with-seed
// Citizen and wide holding addresses); no key, no signing, no network, no
// session. The caller supplies the decoded Season; nothing is fetched here.
import { seasonAddresses } from '/web/frontier/faddr.mjs';
import { decode } from '/web/frontier/fcodec.mjs';
import { encodeAccount } from '/web/sdk/frontier/codec.mjs';
import { encode as toB58, decode as fromB58 } from '/web/sdk/base58.mjs';
import { toBase64, fromHex, utf8 } from '/web/sdk/bytes.mjs';
import { sortKeyOf, wideHoldingAddress, adoptWide, failWide, WIDE_HOLDING_SIZE, TRAILER } from '/web/frontier/fwide.mjs';
import { worldIdOf, ringPosition, WORLD_DOMAIN } from '/web/frontier/map/wide.mjs';

// ------------------------------------------------------------------ fixed public data
export const PROGRAM = toB58(new Uint8Array(32).fill(0x5e));
export const ADDRESSES = seasonAddresses(PROGRAM, 5);
export const SEASON_ADDR = ADDRESSES.season;
export const WORLD = worldIdOf(SEASON_ADDR, PROGRAM);
const OTHER_SEASON_ADDR = toB58(new Uint8Array(32).fill(4));
const OTHER_WORLD = worldIdOf(OTHER_SEASON_ADDR, PROGRAM);
export const WALLET_A = toB58(new Uint8Array(32).fill(0x41));
export const CITIZEN = ADDRESSES.of('Citizen', { wallet: WALLET_A });
const OWNER = fromB58(CITIZEN);
const ENV = Object.freeze({ seasonAddress: SEASON_ADDR, programId: PROGRAM, world: WORLD, season: '5' });
/** The far coordinate (past 2^53) the captured W2 sits at, and a first-ring coordinate for the W3 slot. */
export const FAR = Object.freeze({ p: 9007199254740993n, q: -130n });
export const NEAR = Object.freeze({ p: 129n, q: 0n });
const STORE_VALUES = [1220, 815, 662, 305, 122, 90, 40, 20];
const STORE_RATES = [40, 30, 25, 10, 5, 0, 0, 0];

// ------------------------------------------------------------------ the viewer's Citizen bytes
const REF = Object.freeze({ empty: { P: 0, Q: 0, SITE: 0, GEN: 255 }, wide: { P: 0, Q: 0, SITE: 12, GEN: 0 }, home: { P: 2, Q: 0, SITE: 3, GEN: 1 }, legacy: { P: 3, Q: -1, SITE: 1, GEN: 1 } });
const refsOf = bindings => bindings.map((b, i) => (b === 'legacy' ? (i === 0 ? REF.home : REF.legacy) : REF[b]));
/** The viewer's decoded Citizen (v2 layout): the wallet and three slot refs matching `bindings`. */
export const citizenRecord = (bindings = ['legacy', 'wide', 'empty']) =>
  decode('Citizen', encodeAccount('Citizen', { SEASON_ID: 5n, WALLET: fromB58(WALLET_A), FACTION: 2, HOLDING: refsOf(bindings), TICKET_BELL: 0xffffffff }, { profile: 2 }), { profile: 2, seasonId: 5 });
/** The parser's pins as the controller passes them, with the Citizen bytes bound to `bindings`. */
export const pinsOf = (bindings) => ({ seasonAddress: SEASON_ADDR, programId: PROGRAM, seasonId: '5', citizen: CITIZEN, citizenRecord: citizenRecord(bindings) });

// ------------------------------------------------------------------ synthetic WideHolding bytes (frontier-abi `WideHolding::write_identity` layout)
export function wideBytes({ p, q, site = 3, gen = 1, slot = 2, owner = OWNER, world = WORLD, season = 5n, hostIdentity = 0, openTransits = 0, economy = {} } = {}) {
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
const captureJson = (address, bytes) => ({ address, slot: '1000', archiveSequence: '12', postState: 'transaction', verification: 'captured-unverified', bytes_b64: toBase64(bytes) });
/** One `wideHoldings` entry: a captured holding of the viewer at (p, q), or a not-captured / ambiguous slot. */
export function entry({ p, q, site = 3, gen = 1, slot = 2, status = 'captured-unverified', env = ENV } = {}) {
  if (status !== 'captured-unverified') return { inventorySlot: slot, status, holding: null };
  const data = wideBytes({ p, q, site, gen, slot, owner: OWNER, world: env.world, season: BigInt(env.season) });
  return { inventorySlot: slot, status, holding: {
    world: env.world, p: String(p), q: String(q), ring: String(ringPosition(p, q).ring), site, generation: gen, inventorySlot: slot, season: env.season,
    ownerCitizen: CITIZEN, hostIdentity: 0, openTransits: 0, capture: captureJson(wideHoldingAddress(env.seasonAddress, env.programId, p, q, site), data) } };
}
const inventory = (b1 = 'legacy', b2 = 'wide', b3 = 'empty') => [{ inventorySlot: 1, binding: b1 }, { inventorySlot: 2, binding: b2 }, { inventorySlot: 3, binding: b3 }];
const context = (over = {}) => ({ v: 1, readOnly: true, executable: false, verification: 'captured-unverified', world: WORLD, worldDomain: WORLD_DOMAIN, season: '5', citizen: CITIZEN,
  latestSlot: '2000', foldedThrough: '40', postState: 'transaction', inventory: inventory(), ...over });
const record = ({ ctx = context(), entries = [entry(FAR)] } = {}) => ({ v: 1, wallet: 'w', citizen: { address: CITIZEN }, holdings: [], slots: [], wideContext: ctx, wideHoldings: entries });

// ------------------------------------------------------------------ the legacy village (web-frontier-cards.test.mjs' world, unchanged)
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }), { seasonId: 1 });
export function legacyWorld(season) {
  const holding = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, FINAL_TS: 0, RESERVE: [400, 0, 0, 0, 0, 0, 100, 0],
    STORES: STORE_VALUES.map((v, i) => ({ VALUE: BigInt(v * 1000), RATE: BigInt(STORE_RATES[i] * 1000), CAP: BigInt(6_000_000), T0: 0n })) });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 41, SITE_COUNT: 1, SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))] });
  return { mode: 'play', tab: 'holding', season, nowBell: 42, chain: { now: () => 1_000 }, citizen: { faction: 0, vigilStartMin: 0, exploresFloorLeft: 3 }, land: { stage: 'final' },
    holdings: [holding], provinces: new Map([['2,0', { province }]]), view: { fog: true }, ui: { dismissed: ['onboarding'] }, marches: [], chronicle: [], incoming: [], feed: [], playReady: true,
    wideHoldings: null, wideStatus: 'loading', wideError: null, wideSelect: null };
}

// ------------------------------------------------------------------ scenarios
export const SCENARIOS = Object.freeze([
  { id: 'captured', label: 'Captured: W2 at the far coordinate, W3 not captured' },
  { id: 'missing', label: 'Missing: W2 not captured' },
  { id: 'ambiguous', label: 'Ambiguous: W2 capture ambiguous' },
  { id: 'error', label: 'Error: context from another world, refused by the parser' },
  { id: 'unavailable', label: 'Unavailable: record without a wide section' },
  { id: 'empty', label: 'Empty: no wide slot bound' },
]);
const KNOWN = new Set(SCENARIOS.map(s => s.id));

/** The `/h/me` record and parser pins of one scenario; the Citizen bytes and the context's slot bindings agree in every non-error case. */
function recordOf(id) {
  switch (id) {
    case 'captured': {
      const bindings = ['legacy', 'wide', 'wide'];
      return { pins: pinsOf(bindings), record: record({ ctx: context({ inventory: inventory(...bindings) }), entries: [entry(FAR), entry({ ...NEAR, slot: 3, status: 'not-captured' })] }) };
    }
    case 'missing': return { pins: pinsOf(), record: record({ entries: [entry({ ...FAR, status: 'not-captured' })] }) };
    case 'ambiguous': return { pins: pinsOf(), record: record({ entries: [entry({ ...FAR, status: 'ambiguous' })] }) };
    case 'error': return { pins: pinsOf(), record: record({ ctx: context({ world: OTHER_WORLD }) }) };
    case 'unavailable': return { pins: pinsOf(), record: { v: 1, wallet: 'w', citizen: { address: CITIZEN }, holdings: [], slots: [] } };
    case 'empty': {
      const bindings = ['legacy', 'empty', 'empty'];
      return { pins: pinsOf(bindings), record: record({ ctx: context({ inventory: inventory(...bindings) }), entries: [] }) };
    }
    default: return null;
  }
}

/**
 * The village state of `scenario` over the caller's decoded Season: the legacy world with the wide inventory adopted by
 * the real parser (`adoptWide`), nothing selected (the UI clicks W2 itself). Unknown ids fail the wide read.
 */
export function makeFixture(scenario, season) {
  const FS = legacyWorld(season);
  const id = KNOWN.has(scenario) ? scenario : null;
  FS.fixtureScenario = id;
  const made = id && recordOf(id);
  if (!made) { failWide(FS, 'Unavailable'); return FS; }
  adoptWide(FS, made.record, made.pins);
  FS.wideSelect = null;
  return FS;
}
