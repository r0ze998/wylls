// The live mode of the screenshot fixture (UX design 12.4, 14.5): a small
// SAMPLE WORLD that keeps going under the M1 rules, in the shapes the real
// herald and relay use, so the page plays the game after landing against it.
// Nothing touches a chain. Field ownership uses the local arrival-control
// development rule (territory.mjs); military resolution still uses the
// shared rules crate. Other numbers and steps follow the
// program's (rules.mjs names every source), the clash is resolved by the
// rules kernel the page itself loads (kernel.mjs: frontier.wasm,
// `resolve_from_inputs`), and an order is refused exactly where the program
// refuses it, with the program's error name.
//
//   the clock    A turn is 600 game seconds, as in the program; the world's
//                clock runs `600 / turn` times the wall clock (`turn`: wall
//                seconds a turn lasts, 20 by default). Everything follows
//                that one clock: stores, the build queue, shields, stamina,
//                the reveal window, the beacon's rounds. The season record
//                says so: `cluster: "localnet"` and the test beacon's key
//                are what the page already reads as a test world (More >
//                details: "test beacon"; a localnet clock is the only one
//                whose rate the page estimates), and `sample: {world,
//                turnSecs, rate, paused, seed, simpler}` is the hook for
//                the page that wants to say it and to set its clock's rate
//                at once (the page learns a rate only from two samples of
//                /h/season, the second 30 s after load).
//                `advance()` steps to the next turn at once, `pause(on)`
//                stops the clock.
//   the viewer   Stage `holding`: a town with two hosts, a reserve and a
//                march that reached the camp last turn. Stage `provisional`:
//                a hamlet founded a moment ago with the starter kit, which
//                becomes final soon after the first toll (Harvest, Build and
//                Train until then). Other stages: the clock and the
//                neighbours run, the viewer has no village to order.
//   the orders   Harvest, Build (six buildings, walls, the tier-up), Train,
//                Muster, Garrison, Dissolve, Explore, Depart, and the settle
//                shapes SettleExplore and SettleTransit, each checked in the
//                program's order (prologue, action bucket, then the
//                instruction's own checks) and written as the program
//                writes it, with its PS2 record.
//   the keeper   What the keepers do on a chain happens here at the earliest
//                moment the program allows: the anchor two seconds after a
//                bell ends, the reveal window W after it, the seed at round
//                S, then for every province the bell's resolve (the kernel,
//                when anything meets on a tile; a quiet skip otherwise) and
//                the settle of its pending changes, SettleDeparture, the
//                return settle, SettleExplore, and SettleTransit 600 s
//                after the window closed.
//   neighbours   Three villages of other nations with a host each or two,
//                which march now and then by a seeded script through the
//                same Depart and Reveal as the viewer's. Their destinations
//                are sealed until their arrival bell has ended.
//
// Where this world is simpler than the program is listed in SIMPLER below
// (and said in the season record's `sample.simpler`).
//
// THE ONE EXCEPTION to "nothing here is a rule of its own": with the option
// `claims` (off by default) the world also plays a LABELLED PROTOTYPE of the
// banner rule, a design that is not in the program (claims.mjs: the rule's
// pure functions; claimsworld.mjs: what the world keeps, computes and serves
// of it). With the option off nothing of it runs and every record is what it
// was before the prototype was written (claims-golden.mjs pins that).
//
// A refusal is a `{ok: false, code, error}` body with HTTP 200, as the
// fixture always answered (the real relay answers 4xx: the browser suites
// count any HTTP error as a failure of the page).
import * as W from './world.mjs';
import { ACCOUNTS } from '../../permutation-server/web/frontier/abi.mjs';
import * as R from './rules.mjs';
import { createTerritory, resolveTerritory, settleHomeTerritory, territorySnapshot } from './territory.mjs';
import { kernel } from './kernel.mjs';
import { createClaims, SIMPLER_CLAIMS } from './claimsworld.mjs';
import { keyFromSeed, verify } from '../../permutation-server/web/session.mjs';
import { parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { classify } from '../../permutation-server/web/sdk/frontier/shapes.mjs';
import { minTipLamports } from '../../permutation-server/web/sdk/frontier/fees.mjs';
import { encode as toBase58, decode as fromBase58 } from '../../permutation-server/web/sdk/base58.mjs';
import { fromBase64, toBase64, toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';
import { decode as decodeAccount } from '../../permutation-server/web/frontier/fcodec.mjs';
import { decodeOverview } from '../../permutation-server/web/frontier/herald.mjs';
import { seasonClock, seedRound, roundTime, tlockRound } from '../../permutation-server/web/frontier/clock.mjs';
import { ringOf, regionOf, wedgeOf, tileHex, ringProvinces, hexDistance, TILE_OFFSETS, DIRECTIONS, locate } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostId, hostParts, seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { pack, unpack, pathStep, encodePath, commit as sealCommit, ctHash as sealCtHash, sealRoot as sealRootOf } from '../../permutation-server/web/frontier/seal.mjs';
import { buildClashArgs, resolveArgs, decodeClashOut, campId } from '../../permutation-server/web/frontier/screens/report.mjs';

const { GENESIS_TS, BELL, LATEST_UNIX, LATEST_SLOT, HOME, CAMP_TILE, HOSTS, PROGRAM, SEASON_ID } = W;
const { ES, OP, TS, TF, QK, FATE, OUTCOME, NO_BELL, NO_TILE, MILLI } = R;

/** The turn the page's clock shows at load, and the constants of the sample world. */
export const LIVE = Object.freeze({
  TURN: Math.floor((LATEST_UNIX - GENESIS_TS) / 600),
  /** Wall seconds a turn lasts (the default; `live(true, {turn})`). */
  TURN_SECS: 20,
  /** Wall seconds from the page's first /h/season to the first toll (the default; `live(true, {delay})`); at most MAX_LEAD game seconds. */
  DELAY: 8,
  MAX_LEAD: 520,
  /** Wall ms a relayed transaction takes to land (GET /f/tx says `unknown` until then). */
  LAND_MS: 1_200,
  /** THE anchor of a bell is posted this many game seconds after the bell ends (the fixture's own figure: world.mjs `bellRegion`). */
  A_OFF: 2,
  /** `advance()` lands this many game seconds into the next turn: after the anchor, the transit settles and the resolve of the turn's opening. */
  ADVANCE_INTO: 80,
  /** The neighbours give their orders this many game seconds into a turn (after the province has caught up). */
  NPC_AT: 150,
  /** Per-bell province files kept for every province (the bells a clash was resolved in are kept for good). */
  KEEP_BELLS: 8,
  /** The seed of the world (the bell seeds, the neighbours' script). */
  SEED: 1,
  /** The viewer's march that reached the camp the turn before the world starts: its departure and arrival bells. */
  MARCH_DEPART: W.MARCH_DEPART, MARCH_ARRIVE: W.MARCH_ARRIVE,
  /** The building in the town's queue is done this many game seconds after the first toll: a woodcutter's (catalog item 1), +10 wood an hour. */
  BUILT_AFTER: 360,
  FEE_SEED: new Uint8Array(32).fill(0x33),
});

/** Where the sample world is simpler than the program (also in the season record: `sample.simpler`). */
export const SIMPLER = Object.freeze([
  'seals are not opened or judged: a seal is taken as valid, and a march of the viewer is revealed only by the page\'s own self-reveal (POST /f/reveal); a march nobody revealed is routed, as the program routes an unrevealed arrival',
  'the arrival quota fills the first free of a nation\'s four slots; a fifth arrival, or a second of the same citizen, is refused (QuotaRefused) where the program ranks and displaces',
  'no lamports: tips, march fees, bonds, rent and the defence pool are recorded in the transit and the log as the program records them, nothing is paid',
  'one keeper that never lags and never fails: every keeper step lands at the first moment the program allows it',
  'ArrivalDay accounts, GATHER and SKIP records, the event chains (heads and tails) and compute budgets are not written',
  'no joining, tickets, vigil hours, dormancy release or season end; the viewer\'s session key is taken as unexpired',
  'the neighbours have no economy: their villages keep the hosts and garrisons they start with',
  'rings 0 to 2 only, as the still fixture',
]);

const SEASON = decodeAccount('Season', fromBase64(W.seasonRecord().bytes_b64));
const CLOCK = seasonClock(SEASON);
const RINGS = W.seasonRecord().rings.map(r => ({ ring: r.d, seed: r.seed }));
const A = seasonAddresses(PROGRAM, SEASON_ID);
const TIP_MIN = minTipLamports(SEASON.minRevealPriorityMilli, SEASON.revealCuLimit, SEASON.revealLoadedLimit);
const bs = b => GENESIS_TS + 600 * b, be = b => bs(b + 1);
const bellOf = t => Math.floor((t - GENESIS_TS) / 600);
/** THE anchor's time, the window's close, the seed's round and when it is out, for bell b (contract §5.1). */
const anchorAt = b => be(b) + LIVE.A_OFF;
const closeAt = b => anchorAt(b) + CLOCK.window(b);
const seedRoundOf = b => seedRound(CLOCK.drand, closeAt(b), CLOCK.margin);
const seedAt = b => roundTime(CLOCK.drand.genesis, CLOCK.drand.period, seedRoundOf(b));
const resolveAt = b => seedAt(b) + 1;
const transitAt = b => closeAt(b) + 600 + 1;
const hexOf = b => (typeof b === 'string' ? b : toHex(b));
const hexBytes = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
const le32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return b; };
const utf8 = s => new TextEncoder().encode(s);
const key = (p, q) => `${p},${q}`;
const same = (a, b) => BigInt(a) === BigInt(b);
/** Entries, site mirrors, transit records as the accounts store them (plain fields: world.mjs `encode`). */
const entry = o => ({ id: 0n, faction: 0, unit: 0, tile: 0, state: 0, troops: 0, staminaValue: 0, dealtBps: 0, staminaBell: 0, readyBell: 0, fromBell: 0, pendBell: 0, pendOp: 0, opA: 0, opB: 0, opTroops: 0, opRef: 0, ...o });
const mirror = o => ({ state: 0, faction: 6, order: 0, tier: 0, gen: 0, garrison: 0, pend0Bell: NO_BELL, pend0Delta: 0, pend1Bell: NO_BELL, pend1Delta: 0, wallsCommitted: 0, wallItem0Bell: NO_BELL, wallItem0Delta: 0, wallItem1Bell: NO_BELL, wallItem1Delta: 0, shieldUntilBell: 0, ...o });
const FREE_TRANSIT = Object.freeze({ state: 0, unit: 0, faction: 0, originTile: 0, originP: 0, originQ: 0, hostId: 0n, departBell: 0, arriveBell: 0, departTs: 0, depMass: 0, marchStamina: 0, dealtBps: 0, troopsAfter: 0, staminaAfter: 0, readyBellOff: 0, sealRoot: '00'.repeat(32), tip: 0n, flags: 0, destP: 0, destQ: 0 });
const FREE_QUEUE = Object.freeze({ doneAt: 0, kind: 0, arg: 0, delta: 0 });
/** `bell_from` (prog/citizen.rs:728-731): the first bell at or after `t`. */
const bellFrom = t => Math.floor((Math.max(0, t - GENESIS_TS) + 599) / 600);
/** The fixture roster's tag of a held site (world.mjs `rosterBytes`): the neighbours are people of the roster. */
const rosterTag = (p, q, site) => 0x5eed0000n + BigInt((p + 64) * 4096 + (q + 64) * 16 + site);
const VIEWER_TAG = 0x5eed_0001n;
const REFUSED_TEXT = Object.freeze({
  Bucket: 'the action bucket is empty (30 an hour, 60 stored)', QuotaExceeded: 'the sponsored-transaction quota for this game day is used up',
  QueueFull: 'the build queue is full', Insufficient: 'the stores or the reserve do not hold that much', NotFinal: 'the village is still provisional',
  NotResident: 'the province has not resolved the bells this needs, or the host is not in its roster', HostBusy: 'a change is already pending', HostInTransit: 'the host is on a march that is not settled',
  Cooldown: 'the host fought or lacks the stamina of a march', ArrivalBell: 'the arrival bell is outside what the march allows', TransitState: 'that transit record is in use, or free',
  Explored: 'that tile was explored already', ProvinceFull: 'the province holds as many hosts as it may', BadData: 'the order names something that is not there', NotOwner: 'that is not the caller\'s',
  Kernel: 'the rules kernel refused it', TipTooLow: 'the tip is below the season\'s minimum', SeedNotReady: 'the bell\'s seed is not out yet', AlreadyDone: 'done already', TooEarly: 'not yet',
  DepartureUnsettled: 'the departure is not settled yet', BadAccount: 'an account is not what the instruction names',
});

/**
 * A sample world: `{orders, reveals, seen(), now(), turn(), tollAt, advance(), pause(on), summary(), herald(path, url),
 * relay(method, path, body), clock()}`.
 * `viewer`: the fixture's viewer (world.mjs `viewer()`); `stage`: its stage; `turn`: wall seconds a turn lasts;
 * `delay`: wall seconds to the first toll; `landMs` as LIVE; `wall`: ms clock (tests pass their own); `seed`: the
 * world's seed; `neighbours`: false for a world where nobody else marches; `paused`: start with the clock stopped;
 * `stores`: whole units the viewer's village starts with instead of the stage's own (a premise of the sample, for
 * captures of what the starter kit cannot buy; said in the season record); `claims`: true plays the labelled prototype of
 * the banner rule as well (a design, not a rule of the program: claims.mjs, claimsworld.mjs), or an object of its
 * script's options (`{threat: 'auto' | 'pole' | 'border' | 'none', deadline, afterRaise}`); off by default.
 */
export function createLive({ viewer, stage = 'holding', territory = false, turn = LIVE.TURN_SECS, delay = LIVE.DELAY, landMs = LIVE.LAND_MS, wall = () => Date.now(), seed = LIVE.SEED, neighbours = true, paused = false, stores = null, opening = false, claims = false } = {}) {
  const K = kernel();
  const turnSecs = Math.max(0.2, Number(turn) || LIVE.TURN_SECS), rate = 600 / turnSecs;
  const T1 = bs(LIVE.TURN + 1);   // the first toll: turn 43 begins
  const START = Math.floor(T1 - Math.min(LIVE.MAX_LEAD, Math.max(1, delay * rate)));
  let t0 = null, base = START, frozen = !!paused;
  const now = () => (frozen || t0 === null ? base : base + ((wall() - t0) / 1000) * rate);
  const fee = keyFromSeed(LIVE.FEE_SEED);
  let land = stage === 'holding' || stage === 'provisional';
  let viewerSession = viewer?.session;
  let JOINED = null;
  const myHolding = () => ME ? A.of('Holding', ME) : viewer.holding;
  const seasonRecord = () => {
    const r = W.seasonRecord();
    if (!opening) return r;
    const bytes = fromBase64(r.bytes_b64);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(ACCOUNTS.Season.fields.find(f => f[0] === 'PROGRAM_VERSION')[1], 2, true);
    return { ...r, bytes_b64: toBase64(bytes) };
  };
  const orders = [], reveals = [];
  const rng = (...parts) => { const h = sha256(utf8('wylls-sample-world'), le32(seed), ...parts.map(x => (typeof x === 'string' ? utf8(x) : x instanceof Uint8Array ? x : le32(Number(x))))); return h; };
  const pick = (n, ...parts) => (n <= 0 ? 0 : ((rng(...parts)[0] << 8) | rng(...parts)[1]) % n);
  /** The seed of bell b in region r (the sample world's stand-in for the beacon's round S). */
  const seedOf = (b, r) => toHex(rng('seed', b, r));

  // ------------------------------------------------------------------ the land: every province of rings 0-2
  const provinces = new Map(), provinceAt = new Map(), holdings = new Map();
  const territories = new Map();
  const territoryFor = pv => {
    const id = key(pv.p, pv.q);
    if (!territories.has(id)) territories.set(id, createTerritory(pv));
    return territories.get(id);
  };
  const territoryOf = pv => { const t = territoryFor(pv); settleHomeTerritory(t, pv); return territorySnapshot(t); };
  const st = {
    log: [], slots: new Map(), closed: new Map(), reports: new Map(), clashes: new Map(),
    next: { anchor: 0, transit: 0, resolve: 0, npc: 0 }, sent: new Map(), tracks: 0, slotSeq: 0,
    quota: { left: 38, day: bellOf(START) / R.BELLS_PER_DAY | 0 }, npc: [], npcLog: [],
  };
  const held = new Map();
  for (let d = 0; d <= 2; d++) for (const r of decodeOverview(W.overview(d)).provinces) held.set(key(r.p, r.q), r.sites.map((s, i) => (s === 1 ? r.owners[i] : null)));
  const SHIELD_OLD = bellFrom(GENESIS_TS + 1_300 + R.shieldSecs(0));   // the villages of the fixture were founded early on day 0
  for (let d = 0; d <= 2; d++) for (const { p, q } of ringProvinces(d)) {
    const g = K.call('generate_province', { ring_seed: RINGS[d].seed, p, q }).value;
    const terrain = Uint8Array.from(g.terrain.terrain);
    let rough = 0n;
    terrain.forEach((x, i) => { if (x === 2 || x === 3) rough |= 1n << BigInt(i); });
    const home = p === HOME.p && q === HOME.q;
    const pv = { p, q, ring: d, wedge: wedgeOf(p, q) ?? 0xff, region: regionOf(p, q), resolvedNext: BELL + 1, openedBell: 3, relations: 0n, lastDigest: '00'.repeat(32), rosterEpoch: 4, eventSeq: 9,
      terrain, resource: Uint8Array.from(g.terrain.resource, x => (x === null ? 0 : x + 1)), sites: [...g.terrain.sites], siteCount: g.terrain.siteCount, passableMask: g.passableMask, roughMask: rough, roadMask: 0n, exploredMask: 0n,
      siteMirror: Array.from({ length: 12 }, () => mirror()), entries: Array.from({ length: R.STORAGE }, () => entry()),
      resolveSummary: { bell: 0, engagements: 0, arrivals: 0, destroyed: 0, bounced: 0, resolver: new Uint8Array(8) }, camp: { tile: 0, state: 0, troops: 0, nextCheckDay: 1, gen: 0 } };
    (held.get(key(p, q)) ?? []).forEach((f, s) => { if (f !== null && f < 6 && s < pv.siteCount) pv.siteMirror[s] = mirror({ state: 1, faction: f, order: 1, tier: 1, garrison: home ? 120_000 : 90_000, shieldUntilBell: SHIELD_OLD }); });
    // the camp: the home province's is the fixture's; every other province of ring 2 has the one it was opened with (camp.rs: `initial`)
    if (home) pv.camp = { tile: CAMP_TILE, state: 1, troops: 250, nextCheckDay: 1, gen: 1 };
    else if (d >= 2) { const c = initialCamp(pv, RINGS[d].seed); if (c) pv.camp = { tile: c.tile, state: 1, troops: c.troops, nextCheckDay: 1, gen: 1 }; }
    provinces.set(key(p, q), pv);
    provinceAt.set(A.of('Province', { p, q }), pv);
  }
  const passable = (pv, tile) => tile >= 0 && tile < 61 && ((pv.passableMask >> BigInt(tile)) & 1n) === 1n;
  const siteOfTile = (pv, tile) => { const k = pv.sites.indexOf(tile); return k >= 0 && k < pv.siteCount ? k : -1; };
  /** `camp::place(…, initial = true)` (camp.rs:83-123): the camp a province of ring ≥ 2 is opened with. */
  function initialCamp(pv, ringSeed) {
    const id = new Uint8Array(13);
    id.set(le32(pv.p), 0); id.set(le32(pv.q), 4); id[12] = 1;
    const cands = [];
    for (let t = 1; t < 61; t++) if (((pv.passableMask >> BigInt(t)) & 1n) === 1n && !pv.sites.slice(0, pv.siteCount).includes(t)) cands.push(t);
    if (!cands.length) return null;
    const s = hexBytes(ringSeed);
    return { tile: cands[R.below(R.rand(s, 'frontier/camp/tile', id), cands.length)], troops: 100 + R.below(R.rand(s, 'frontier/camp/troops', id), 301) };
  }
  const encodeProvince = pv => W.encode('Province', { ...pv, nEntries: pv.entries.filter(e => e.state !== ES.FREE).length, nSitesUsed: pv.siteMirror.filter(m => m.state === 1).length });

  // ------------------------------------------------------------------ the log (PS2 records, as the herald pages them)
  const BASE_SEQ = 800;
  const emit = (kind, bell, fields) => { st.log.push({ seq: BASE_SEQ + st.log.length, slot: slotNow(), kind, bell, fields, body: null }); };
  const slotNow = () => LATEST_SLOT + 1 + Math.floor(Math.max(0, now() - START) * 2.5);

  // ------------------------------------------------------------------ the villages
  /** A village of the world: the rules-side holding (rules.mjs) with what the Holding account and its owner's Citizen keep beside it. */
  function village({ p, q, site, faction, tier = 1, npc = false, k, state = 2, ticketBell = 3, finalTs = GENESIS_TS + 20_000, reserve = [0, 0, 0, 0, 0, 0, 0, 0], hostSeq = 1, garrison = 0, citizen }) {
    const pv = provinces.get(key(p, q)), tile = pv.sites[site];
    const H = { p, q, site, gen: 0, tile, faction, state, npc, ticketBell, finalTs, reserve: [...reserve], hostSeq, transit: [null, null, null, null], explore: null, escrow: 0n, poolOwed: 0n, plans: [],
      ...k, tier: k.tier, citizen: { tag: npc ? rosterTag(p, q, site) : VIEWER_TAG, flags: 1 | (state === 2 ? 4 : 8), exploresFloorLeft: 3, works: 0, explores: 0, arrivals: 0, bucketMilli: SEASON.bucketBurst * 1000, bucketT: 0, lastActionTs: 0, ...citizen } };
    H.shieldUntil = H.foundedTs + R.shieldSecs(H.foundedDay);
    pv.siteMirror[site] = mirror({ state: 1, faction, order: 1, tier, garrison, shieldUntilBell: bellFrom(H.shieldUntil) });
    holdings.set(`${p},${q},${site}`, H);
    return H;
  }
  const holdingOfHost = id => { const h = hostParts(id); return h ? holdings.get(`${h.p},${h.q},${h.site}`) ?? null : null; };
  const oldTown = (extra = {}) => { const k = R.foundHolding(GENESIS_TS + 1_300, 0); k.tier = 1; k.production = R.baseProduction(1); k.stores.forEach((s, r) => { s.cap = R.STORAGE_CAP[1]; s.rate = k.production[r]; s.t0 = START; }); k.lastOwnerAction = START; return { ...k, ...extra }; };
  const put = (pv, e) => { const i = pv.entries.findIndex(x => x.state === ES.FREE); pv.entries[i] = entry(e); return i; };
  const home = provinces.get(key(HOME.p, HOME.q));

  let ME = null;   // the viewer's village
  if (stage === 'holding') {
    // a town with a farm built and a woodcutter under way, as the still fixture shows it
    const k = oldTown();
    k.production[R.RES.Food] += R.BUILDINGS[0].perHour * MILLI;
    const amounts = stores ?? [1_200, 800, 650, 300, 0, 120, 40, 0];
    k.stores.forEach((s, r) => { s.value = amounts[r] * MILLI; s.rate = k.production[r]; s.t0 = START - 1_800; });
    k.lastOwnerAction = START - 1_800;
    k.queue[0] = { doneAt: T1 + LIVE.BUILT_AFTER, kind: QK.PRODUCTION, arg: R.RES.Wood, delta: R.BUILDINGS[1].perHour * MILLI };
    ME = village({ ...HOME, faction: 0, tier: 1, k, reserve: [...W.HOLDING_RESERVE], hostSeq: 10, garrison: 300_000 });
    put(home, { id: HOSTS.free, faction: 0, unit: 0, tile: HOME.tile, state: ES.ROSTER, troops: 600_000, staminaValue: 110, staminaBell: BELL, dealtBps: 10_000, readyBell: 30, fromBell: 30 });
    put(home, { id: HOSTS.scout, faction: 0, unit: 6, tile: HOME.tile, state: ES.ROSTER, troops: 100_000, staminaValue: 120, staminaBell: BELL, dealtBps: 10_000, readyBell: 30, fromBell: 30 });
    // the march that reached the camp last turn: departed and settled at its origin, sealed on this device (world.mjs
    // `liveBook`), revealed by it when its arrival turn began; the turn's clash is still to be resolved
    const m = W.liveMarch();
    ME.transit[1] = { ...FREE_TRANSIT, state: TS.SETTLED, unit: 0, faction: 0, originTile: HOME.tile, originP: HOME.p, originQ: HOME.q, hostId: HOSTS.marching, departBell: LIVE.MARCH_DEPART, arriveBell: LIVE.MARCH_ARRIVE,
      departTs: bs(LIVE.MARCH_DEPART) + 300, depMass: 400_000, marchStamina: R.DEPART_STAMINA, dealtBps: R.dealtBps(0, true), troopsAfter: 400_000, staminaAfter: R.STAMINA_CAP - R.DEPART_STAMINA, readyBellOff: 0,
      sealRoot: toHex(m.sealRoot), tip: TIP_MIN, flags: TF.FEE | TF.BOND };
    ME.citizen.arrivals = 1;
    slotPut({ p: HOME.p, q: HOME.q, bell: LIVE.MARCH_ARRIVE, faction: 0, i: 0, unit: 0, stance: 1, tile: CAMP_TILE, retreatBps: 0, hostId: HOSTS.marching, citizenTag: VIEWER_TAG, depMass: 400_000, dealtBps: R.dealtBps(0, true, 1) });
  } else if (stage === 'provisional') {
    // a hamlet founded when its ticket's seed came out, with the starter kit; final 600 s after that round (contract §5.1)
    const founded = seedAt(BELL) + 5, k = R.foundHolding(founded, 0);
    if (stores) k.stores.forEach((s, r) => { s.value = stores[r] * MILLI; });
    ME = village({ ...HOME, faction: 0, tier: 0, k, state: 1, ticketBell: BELL, finalTs: seedAt(BELL) + 600, hostSeq: 0 });
  }
  // the base of the log: the ring, the province, the viewer's own records (as the still fixture's log has them)
  emit(4, 3, { d: 2, t_open: GENESIS_TS + 1_800 });
  emit(6, 3, { p: HOME.p, q: HOME.q, ring: 2, wedge: wedgeOf(HOME.p, HOME.q), region: regionOf(HOME.p, HOME.q), site_count: 12, camp_tile: CAMP_TILE, camp_troops: 250 });
  if (stage !== 'none') emit(10, 4, {});
  if (stage === 'holding') {
    emit(14, 5, { p: HOME.p, q: HOME.q, site: HOME.site, outcome: 0 });
    emit(16, 29, { p: HOME.p, q: HOME.q, site: HOME.site, final_ts: GENESIS_TS + 20_000 });
    emit(43, 30, { p: HOME.p, q: HOME.q, tile: CAMP_TILE, troops: 250, day: 0 });
    emit(30, LIVE.MARCH_DEPART, { host_id: HOSTS.marching, origin_p: HOME.p, origin_q: HOME.q, origin_tile: HOME.tile, depart_bell: LIVE.MARCH_DEPART, arrive_bell: LIVE.MARCH_ARRIVE, dep_mass: 400_000, march_stamina: R.DEPART_STAMINA, tip: TIP_MIN, seal_root: W.liveMarch().sealRoot });
    emit(21, LIVE.TURN - 1, { p: HOME.p, q: HOME.q, site: HOME.site, item: 1, done_at: T1 + LIVE.BUILT_AFTER });
    emit(31, LIVE.MARCH_ARRIVE, { p: HOME.p, q: HOME.q, arrive: LIVE.MARCH_ARRIVE, faction: 0, i: 0, host_id: HOSTS.marching, tile: CAMP_TILE, stance: 1, retreat: 0 });
  } else {
    emit(43, 30, { p: HOME.p, q: HOME.q, tile: CAMP_TILE, troops: 250, day: 0 });
    if (stage === 'provisional') emit(14, LIVE.TURN, { p: HOME.p, q: HOME.q, site: HOME.site, outcome: 0, final_ts: ME.finalTs, ticket_bell: BELL });
  }

  // ------------------------------------------------------------------ the neighbours (other nations; seeded, deterministic)
  if (neighbours) {
    const lot = [
      { p: HOME.p, q: HOME.q, site: 7, hosts: [[3, 0, 300], [4, 0, 200]] },      // Cinder, in the viewer's own province
      { p: 1, q: 1, site: 2, hosts: [[1, 2, 200]] },                            // the next province inward
      { p: 2, q: -2, site: 1, hosts: [[1, 0, 400]] },                           // two provinces along the ring
    ];
    lot.forEach((n, ni) => {
      const pv = provinces.get(key(n.p, n.q)), f = pv.siteMirror[n.site].faction;
      if (pv.siteMirror[n.site].state !== 1 || !(f < 6)) return;
      const H = village({ p: n.p, q: n.q, site: n.site, faction: f, tier: 1, npc: true, k: oldTown(), hostSeq: 9, garrison: pv.siteMirror[n.site].garrison });
      n.hosts.forEach(([seq, unit, troops], hi) => {
        const id = hostId({ p: n.p, q: n.q, site: n.site, gen: 0, seq });
        put(pv, { id, faction: f, unit, tile: H.tile, state: ES.ROSTER, troops: troops * MILLI, staminaValue: R.STAMINA_CAP, staminaBell: BELL, dealtBps: R.dealtBps(f, false), readyBell: 30, fromBell: 30 });
        // when it first marches: the second host of the village next door is on its way from the start
        st.npc.push({ id, H, out: true, at: LIVE.TURN + (ni === 0 && hi === 1 ? -1 : 2 + 2 * ni + pick(3, 'npc', ni, hi)) });
      });
    });
  }

  // ------------------------------------------------------------------ arrival slots, per-bell files
  function slotPut(s) {
    const k = `${s.p},${s.q},${s.bell}`, list = st.slots.get(k) ?? [];
    list.push({ ...s, slot: LATEST_SLOT + 1_500 + st.slotSeq++, settled: false });
    st.slots.set(k, list);
  }
  const slotsOf = (p, q, b) => st.slots.get(`${p},${q},${b}`) ?? [];
  const slotBytes = s => W.encode('ArrivalSlot', { p: s.p, q: s.q, bell: s.bell, faction: s.faction, i: s.i, unit: s.unit, stance: s.stance, tile: s.tile, retreatBps: s.retreatBps, hostId: s.hostId, citizenTag: s.citizenTag, depMass: s.depMass, dealtBps: s.dealtBps });
  const slotJson = s => ({ key: `ar:${s.p},${s.q},${s.bell},${s.faction},${s.i}`, slot: s.slot, bytes: toBase64(slotBytes(s)) });

  // ------------------------------------------------------------------ the program's checks and effects, one instruction each
  const no = (code, detail) => ({ ok: false, code, error: `${code}: ${detail ?? REFUSED_TEXT[code] ?? code}` });
  const entryOf = (pv, id) => pv.entries.find(e => e.state !== ES.FREE && same(e.id, id)) ?? null;
  const inTransit = (H, id) => H.transit.some(x => x && x.state >= 1 && x.state <= 3 && same(x.hostId, id));
  /** frontier-abi `prologue::finality_due` (prologue.rs:1160-1164): the fixture's provinces keep no open ticket cohort. */
  const finalNow = (H, pv, t) => H.state === 2 || (H.state === 1 && pv.p === H.p && pv.q === H.q && t >= H.finalTs);
  /** The player prologue's bucket (contract §5.6 step 3), then `run(b)`; the debit, the lazy finality flip and the records stay only when the instruction succeeds. */
  function player(H, t, pv, run) {
    const c = { ...H.citizen };
    if (!R.debitBucket(c, t - GENESIS_TS, SEASON.bucketRatePerH, SEASON.bucketBurst)) return no('Bucket');
    const b = bellOf(t);
    if (b >= SEASON.endBell) return no('WrongStatus');
    const flip = pv && H.state === 1 && finalNow(H, pv, t);
    const r = run(b, flip || H.state === 2);
    if (!r.ok) return r;
    Object.assign(H.citizen, { bucketMilli: c.bucketMilli, bucketT: c.bucketT, lastActionTs: t });
    if (flip) { H.state = 2; H.citizen.flags = (H.citizen.flags | 4) & ~8; st.log.splice(st.log.length - r.records, 0, { seq: 0, slot: slotNow(), kind: 16, bell: b, fields: { p: H.p, q: H.q, site: H.site, final_ts: H.finalTs }, body: null }); st.log.forEach((x, i) => { x.seq = BASE_SEQ + i; }); }
    return r;
  }
  const done = (records = 1, extra = {}) => ({ ok: true, records, ...extra });

  const ORDER = {
    /** 0x40 Harvest: the settle and the owner touch (prog/holding.rs:539-562). */
    Harvest(H, d, pv, t) {
      return player(H, t, null, b => { R.touchHolding(H, t); emit(20, b, { p: H.p, q: H.q, site: H.site }); return done(); });
    },
    /** 0x41 Build(item) (prog/holding.rs:564-618): the cost of the n-th copy, the serial queue of the tier's slots; the walls also write the Province's site mirror. */
    Build(H, d, pv, t) {
      if (!(d.item <= R.ITEM_TIER_UP)) return no('BadData');
      const walls = d.item === R.ITEM_WALLS;
      if (walls && (!pv || pv.p !== H.p || pv.q !== H.q)) return no('BadAccount');
      return player(H, t, walls ? pv : null, b => {
        const k = structuredClone(pickKernel(H));
        R.touchHolding(k, t);
        const o = R.buildOrder(k, d.item, H.faction);
        if (o.error) return no(o.error, o.sub);
        if (!R.pay(k, o.cost)) return no('Insufficient');
        const intro = opening && (H.flags & 2) && d.item < 6;
        const q = R.enqueue(k, t, intro ? 60 : o.secs, o.item);
        if (q.error) return q.error === 'QueueFull' ? no('QueueFull') : no('Kernel', `HoldingError::${q.error}`);
        if (walls) {
          // wall_item (prog/holding.rs:650-690): items in force fold into walls_committed; a free item takes this one
          const m = pv.siteMirror[H.site];
          let committed = m.wallsCommitted;
          const items = [0, 1].map(i => ({ bell: m[`wallItem${i}Bell`], delta: m[`wallItem${i}Delta`] })).map(x => (x.delta > 0 && x.bell <= pv.resolvedNext ? (committed = Math.min(R.MAX_WALLS, committed + x.delta), { bell: 0, delta: 0 }) : x));
          const free = items.findIndex(x => x.delta === 0);
          if (free < 0) return no('QueueFull');
          items[free] = { bell: bellOf(q.doneAt) + 1, delta: R.WALL_STEP };
          m.wallsCommitted = committed;
          items.forEach((x, i) => { m[`wallItem${i}Bell`] = x.bell; m[`wallItem${i}Delta`] = x.delta; });
        }
        Object.assign(H, k);
        if (intro) H.flags &= ~2;
        emit(21, b, { p: H.p, q: H.q, site: H.site, item: d.item, cost_digest: sha256(...o.cost.map(c => { const x = new Uint8Array(8); new DataView(x.buffer).setBigInt64(0, BigInt(c), true); return x; })), done_at: q.doneAt });
        return done(1, { doneAt: q.doneAt });
      });
    },
    /** 0x42 Train(unit, n) (prog/holding.rs:716-752): paid at once, into the reserve at once. */
    Train(H, d, pv, t) {
      return player(H, t, null, b => {
        const cost = R.trainCost(d.unit, d.n);
        if (!cost) return no('BadData');
        const k = structuredClone(pickKernel(H));
        R.touchHolding(k, t);
        if (!R.pay(k, cost)) return no('Insufficient');
        Object.assign(H, k);
        H.reserve[d.unit] += d.n;
        emit(22, b, { p: H.p, q: H.q, site: H.site, unit: d.unit, n: d.n, done_at: t });
        return done();
      });
    },
    /** 0x43 Muster(unit, troops, tile) (prog/host.rs:188-296): onto any passable tile of the village's own province, in the roster from the next bell. */
    Muster(H, d, pv, t) {
      if (!pv || pv.p !== H.p || pv.q !== H.q) return no('BadAccount');
      return player(H, t, pv, (b, final) => {
        if (!final) return no('NotFinal');
        if (!R.residentOk(pv.resolvedNext, b)) return no('NotResident');
        if (!(d.unit >= 0 && d.unit <= R.SCOUT)) return no('BadData');
        if (H.reserve[d.unit] < d.troops) return no('Insufficient');
        if (d.troops * MILLI < R.MIN_HOST_TROOPS) return no('Kernel', 'HostError::TooSmall (a host is at least 100 troops)');
        if (d.troops * MILLI > R.MAX_HOST_TROOPS) return no('Kernel', 'HostError::TooLarge (a host is at most 30,000 troops)');
        if (!passable(pv, d.tile)) return no('BadData', 'a host stands on a passable tile of the village\'s province');
        const roster = pv.entries.filter(e => e.state === ES.ROSTER || e.state === ES.MUSTER_PENDING);
        const slot = pv.entries.findIndex(e => e.state === ES.FREE);
        if (roster.length >= R.PROVINCE_HOST_CAP || roster.filter(e => e.faction === H.faction).length >= R.FACTION_RESIDENT_CAP || slot < 0) return no('ProvinceFull');
        R.touchHolding(H, t);
        const id = hostId({ p: H.p, q: H.q, site: H.site, gen: H.gen, seq: H.hostSeq });
        pv.entries[slot] = entry({ id, faction: H.faction, unit: d.unit, tile: d.tile, state: ES.MUSTER_PENDING, troops: d.troops * MILLI, staminaValue: R.STAMINA_CAP, staminaBell: b, dealtBps: R.dealtBps(H.faction, false), readyBell: b, fromBell: b + 1 });
        pv.rosterEpoch++;
        H.reserve[d.unit] -= d.troops;
        H.hostSeq++;
        emit(23, b, { host_id: id, unit: d.unit, troops: d.troops, tile: d.tile, entry: slot });
        return done(1, { host: id });
      });
    },
    /** 0x44 Dissolve(host) (prog/host.rs:298-337): the host leaves after the bell's clash; its troops return to the reserve at the return settle. */
    Dissolve(H, d, pv, t) {
      return resident(H, d.host_id, pv, t, (b, e) => {
        if (e.pendOp !== OP.NONE) return no('HostBusy');
        R.touchHolding(H, t);
        e.pendOp = OP.LEAVE; e.pendBell = b;
        emit(24, b, { host_id: e.id, pending_bell: b, delta: e.troops });
        return done();
      });
    },
    /** 0x45 Garrison(delta) (prog/host.rs:380-446): Spearmen of the reserve into the garrison after the bell's clash; only additions in M1. */
    Garrison(H, d, pv, t) {
      if (!pv || pv.p !== H.p || pv.q !== H.q) return no('BadAccount');
      return player(H, t, pv, (b, final) => {
        if (!final) return no('NotFinal');
        if (!R.residentOk(pv.resolvedNext, b)) return no('NotResident');
        const n = Number(d.delta);
        if (!(n > 0 && n <= 0xffffffff)) return no('BadData', 'a garrison is only added to in M1');
        if (H.reserve[0] < n) return no('Insufficient');
        // GarrisonState::change (host.rs): the room under 30,000, one pending change per bell, two bells at most
        const m = pv.siteMirror[H.site], pend = [0, 1].map(i => ({ bell: m[`pend${i}Bell`], delta: Number(m[`pend${i}Delta`]) })).filter(x => x.bell !== NO_BELL && x.delta !== 0);
        if (n * MILLI > R.MAX_HOST_TROOPS - (m.garrison + pend.reduce((a, x) => a + x.delta, 0))) return no('Kernel', 'HostError::TooLarge (a garrison is at most 30,000 troops)');
        const sameBell = [0, 1].find(i => m[`pend${i}Bell`] === b && Number(m[`pend${i}Delta`]) !== 0);
        const free = sameBell ?? [0, 1].find(i => m[`pend${i}Bell`] === NO_BELL || Number(m[`pend${i}Delta`]) === 0);
        if (free === undefined) return no('HostBusy');
        R.touchHolding(H, t);
        m[`pend${free}Delta`] = (sameBell !== undefined ? Number(m[`pend${free}Delta`]) : 0) + n * MILLI;
        m[`pend${free}Bell`] = b;
        H.reserve[0] -= n;
        emit(25, b, { p: H.p, q: H.q, site: H.site, pending_bell: b, delta: n * MILLI });
        return done();
      });
    },
    /** 0x46 Explore(host, n, tiles) (prog/holding.rs:764-857): a Scout host, up to two tiles within one hex, not yet explored; one exploration pending per village. */
    Explore(H, d, pv, t) {
      return resident(H, d.host_id, pv, t, (b, e) => {
        if (e.unit !== R.SCOUT) return no('BadData', 'only a Scout host explores');
        if (e.pendOp !== OP.NONE) return no('HostBusy');
        if (!(d.n === 1 || d.n === 2)) return no('BadData');
        const rec = d.n === 1 ? [d.tiles[0], NO_TILE] : [d.tiles[0], d.tiles[1]], tiles = rec.slice(0, d.n);
        if (d.n === 2 && tiles[0] === tiles[1]) return no('BadData');
        const o = TILE_OFFSETS[e.tile];
        if (tiles.some(x => !(x < 61) || hexDistance(o.q, o.r, TILE_OFFSETS[x].q, TILE_OFFSETS[x].r) > 1)) return no('BadData', 'a tile to explore is within one hex of the host');
        if (H.explore) return no('HostBusy', 'one exploration at a time');
        if (tiles.some(x => (pv.exploredMask >> BigInt(x)) & 1n)) return no('Explored');
        // (the prototype of the banner rule only: five tiles a player a game day; the order past it is refused and marks nothing)
        const limit = proto?.exploreLimit(H, b, d.n);
        if (limit && !limit.ok) return { ...no('ExploreLimit', `at most ${limit.perDay} tiles a game day are explored (${limit.left} left today)`), need: { left: limit.left, perDay: limit.perDay } };
        R.touchHolding(H, t);
        proto?.exploredNow(H, b, d.n);
        for (const x of tiles) pv.exploredMask |= 1n << BigInt(x);
        H.explore = { bell: b, p: pv.p, q: pv.q, tiles: rec, host: BigInt(e.id), state: 1 };
        emit(26, b, { host_id: e.id, p: pv.p, q: pv.q, n: d.n, tiles: Uint8Array.from(rec) });
        return done();
      });
    },
    /** 0x50 Depart (prog/host.rs:566-700): the checks of contract §5.11 in order; the march's stamina is charged after the bell's clash. */
    Depart(H, d, pv, t) {
      if (!pv) return no('BadAccount');
      return player(H, t, pv, (b, final) => {
        if (!(H.state === 2 || (final && pv.p === H.p && pv.q === H.q))) return no('NotFinal');
        if (!R.residentOk(pv.resolvedNext, b)) return no('NotResident');
        if (!((d.seal[0] & 0x80) !== 0 && (d.seal[0] & 0x40) === 0)) return no('BadData', 'the seal does not begin as a compressed point');
        const hp = hostParts(d.host_id);
        if (!hp || hp.p !== H.p || hp.q !== H.q || hp.site !== H.site || hp.gen !== H.gen) return no('NotOwner');
        const e = entryOf(pv, d.host_id);
        if (!e || e.state !== ES.ROSTER) return no('NotResident');
        if (e.pendOp !== OP.NONE) return no('HostBusy');
        if (inTransit(H, d.host_id)) return no('HostInTransit');
        if (b < e.readyBell) return no('Cooldown', 'the host fought and cannot depart this bell');
        if (R.staminaAt(e.staminaValue, e.staminaBell, b) < R.DEPART_STAMINA) return no('Cooldown', `a march needs stamina ${R.DEPART_STAMINA}`);
        if (d.arrive_bell < b + R.MIN_ARRIVAL_LEAD_BELLS || d.arrive_bell > b + R.MAX_ARRIVAL_LEAD_BELLS || d.arrive_bell >= SEASON.endBell) return no('ArrivalBell');
        if (BigInt(d.tip) < TIP_MIN) return no('TipTooLow');
        if (!(d.transit_slot >= 0 && d.transit_slot < R.TRANSIT_SLOTS)) return no('BadData');
        if (H.transit[d.transit_slot]) return no('TransitState', 'that transit record is in use (four marches of a village are out at most)');
        R.touchHolding(H, t);
        const root = toHex(sealRootOf(d.commit, sealCtHash(d.seal)));
        e.pendOp = OP.SPEND; e.pendBell = b; e.opB = R.DEPART_STAMINA;
        H.transit[d.transit_slot] = { ...FREE_TRANSIT, state: TS.DEPARTED, unit: e.unit, faction: e.faction, originTile: e.tile, originP: pv.p, originQ: pv.q, hostId: BigInt(d.host_id), departBell: b, arriveBell: d.arrive_bell,
          departTs: Math.floor(t), depMass: e.troops, marchStamina: R.DEPART_STAMINA, dealtBps: R.dealtBps(e.faction, true), sealRoot: root, tip: BigInt(d.tip), flags: TF.FEE | TF.BOND };
        H.escrow += BigInt(d.tip) + BigInt(SEASON.marchFee) + BigInt(SEASON.sealBond);
        H.citizen.arrivals++;
        emit(30, b, { host_id: BigInt(d.host_id), origin_p: pv.p, origin_q: pv.q, origin_tile: e.tile, depart_bell: b, arrive_bell: d.arrive_bell, dep_mass: e.troops, march_stamina: R.DEPART_STAMINA, tip: BigInt(d.tip),
          seal_root: hexBytes(root), commit: Uint8Array.from(d.commit), seal: Uint8Array.from(d.seal) });
        return done();
      });
    },
  };
  /** The rules-side fields of a village (what `touchHolding` settles), as one object. */
  const pickKernel = H => ({ tier: H.tier, order: H.order, foundedTs: H.foundedTs, foundedDay: H.foundedDay, lastOwnerAction: H.lastOwnerAction, stores: H.stores, production: H.production, upkeep: H.upkeep, queue: H.queue, walls: H.walls, wallsCommittedBefore: H.wallsCommittedBefore, foodShortfall: H.foodShortfall });
  /** The resident checks of Dissolve and Explore (prog/host.rs:117-160 `resident_host`), in their order. */
  function resident(H, id, pv, t, run) {
    if (!pv) return no('BadAccount');
    return player(H, t, pv, (b, final) => {
      const hp = hostParts(id);
      if (!hp || hp.p !== H.p || hp.q !== H.q || hp.site !== H.site || hp.gen !== H.gen) return no('NotOwner');
      if (inTransit(H, id)) return no('HostInTransit');
      if (!(H.state === 2 || (final && pv.p === H.p && pv.q === H.q))) return no('NotFinal');
      if (!R.residentOk(pv.resolvedNext, b)) return no('NotResident');
      const e = entryOf(pv, id);
      if (!e || e.state !== ES.ROSTER) return no('NotResident');
      return run(b, e);
    });
  }

  // ------------------------------------------------------------------ the keeper: Reveal (contract §5.11, prog/reveal.rs)
  /** Reveal: `{ok, i}` or the program's refusal. `plain`, `salt`: bytes; `ctHash`: bytes. */
  function reveal(H, slot, plain, salt, ctHash, t) {
    const tr = H.transit[slot];
    if (!tr || !(tr.state >= 1 && tr.state <= 3)) return no('TransitState');
    if (!K.call('plaintext_validate', { plain, host_id: tr.hostId, arrive_bell: tr.arriveBell }).ok) return no('BadPlaintext', 'the plaintext is not this march\'s order');
    if (toHex(sealRootOf(sealCommit(plain, salt), ctHash)) !== hexOf(tr.sealRoot)) return no('CommitMismatch', 'the material is not what was sealed at departure');
    const p = unpack(plain), arrive = tr.arriveBell, pv = provinces.get(key(p.destP, p.destQ));
    // the window: open until THE anchor's A + W (before the anchor exists nothing closes it)
    if (t >= anchorAt(arrive) && t >= closeAt(arrive)) return no('WindowClosed', 'the reveal window of the arrival bell has closed');
    if (!pv) return no('BadAccount', 'the destination is not an opened province');
    if (st.clashes.has(`${pv.p},${pv.q},${arrive}`) || pv.resolvedNext > arrive) return no('LatchClosed', 'the arrival bell is resolved already');
    // the path: the rules' own walk and price (kernel `path_cost`), its end the destination tile, then the arrival bell
    const dirs = Array.from({ length: p.pathLen }, (_, i) => pathStep(p.path, i));
    const cost = K.call('path_cost', { start: tileHex(tr.originP, tr.originQ, tr.originTile), dirs, unit: tr.unit, seeds: RINGS });
    const dest = tileHex(p.destP, p.destQ, p.destTile);
    if (!cost.ok || !dest || cost.value.end.q !== dest.q || cost.value.end.r !== dest.r) return no('Path', 'the path does not lead from the host to the destination over passable land');
    if (!K.call('check_arrival_bell', { genesis_ts: GENESIS_TS, depart_ts: tr.departTs, secs: R.travelSecs(tr.faction, cost.value.secs), chosen: arrive }).ok) return no('ArrivalBell', 'the host cannot be there by that bell');
    const site = siteOfTile(pv, p.destTile), m = site >= 0 ? pv.siteMirror[site] : null;
    if (m && m.state === 1 && m.faction !== tr.faction) {
      if (m.shieldUntilBell > arrive) return no('Shielded', 'that village is under its founding shield');
      if (H.shieldUntil > bs(arrive) && !(t >= H.lastOwnerAction + R.DORMANT_AFTER)) return no('Shielded', 'a host of a shielded village may not march on another nation\'s village');
    }
    const mine = slotsOf(pv.p, pv.q, arrive).filter(s => s.faction === tr.faction);
    if (mine.some(s => same(s.hostId, tr.hostId))) return no('AlreadyDone');
    if (mine.some(s => s.citizenTag === H.citizen.tag) || mine.length >= 4) return no('QuotaRefused', 'the nation\'s arrival slots of that bell are taken (the sample world does not rank and displace)');
    const i = [0, 1, 2, 3].find(x => !mine.some(s => s.i === x));
    slotPut({ p: pv.p, q: pv.q, bell: arrive, faction: tr.faction, i, unit: tr.unit, stance: p.stance, tile: p.destTile, retreatBps: p.retreatBps, hostId: tr.hostId, citizenTag: H.citizen.tag, depMass: tr.depMass, dealtBps: R.dealtBps(tr.faction, true, p.stance),
      ...(proto ? { route: routeTiles(tileHex(tr.originP, tr.originQ, tr.originTile), dirs) } : {}) });
    emit(31, bellOf(t), { p: pv.p, q: pv.q, arrive, faction: tr.faction, i, host_id: tr.hostId, tile: p.destTile, stance: p.stance, retreat: p.retreatBps });
    return { ok: true, i };
  }

  // ------------------------------------------------------------------ the keeper: a bell's resolve in one province (contract §5.11, prog/clash.rs, model)
  const RESOLVER = sha256(utf8('wylls-sample-keeper'));
  /** The day's camp check (model: clash_model.rs:291-314), not yet written: `{camp, spawned}` or null when it ran already. */
  function campCheck(pv, b) {
    const day = Math.floor(b / R.BELLS_PER_DAY);
    if (day < pv.camp.nextCheckDay) return null;
    const block = encodeProvince(pv).slice(128, 263);   // TERRAIN ..= SITE_COUNT
    const c = R.campPlace(R.campSeed(block), pv.p, pv.q, { passable: x => passable(pv, x), isSite: x => siteOfTile(pv, x) >= 0 }, day, pv.siteMirror.some((m, s) => s < pv.siteCount && m.state === 1));
    return { camp: c ? { tile: c.tile, state: 1, troops: c.troops, nextCheckDay: day + 1, gen: pv.camp.gen + 1 } : { ...pv.camp, nextCheckDay: day + 1 }, spawned: !!c, day };
  }
  function resolveBell(pv, b, t) {
    const fieldState = territoryFor(pv);
    // GatherClash: each revealed arrival with its host's values after its origin's clash (prog/clash.rs:408-530)
    const recs = new Array(24).fill(null), slots = slotsOf(pv.p, pv.q, b);
    for (const s of slots) {
      const H = holdingOfHost(s.hostId), tr = H?.transit.find(x => x && same(x.hostId, s.hostId) && x.arriveBell === b);
      if (!tr || tr.state === TS.DEPARTED) continue;   // (a departure is always settled by now: its origin resolved the departure bell two bells ago)
      const pos = s.faction * 4 + s.i;
      tr.flags |= TF.GATHERED; tr.destP = pv.p; tr.destQ = pv.q;
      recs[pos] = tr.state === TS.DESTROYED_AT_ORIGIN
        ? { hostId: s.hostId, citizenTag: s.citizenTag, depMass: s.depMass, troops: 0, stamina: 0, retreat: s.retreatBps, dealt: s.dealtBps, faction: s.faction, unit: s.unit, tile: s.tile, stance: s.stance, present: 0, fate: FATE.DESTROYED, troopsAfter: 0 }
        : { hostId: s.hostId, citizenTag: s.citizenTag, depMass: s.depMass, troops: tr.troopsAfter, stamina: R.staminaAt(tr.staminaAfter, tr.departBell + 1, b), retreat: s.retreatBps, dealt: s.dealtBps, faction: s.faction, unit: s.unit, tile: s.tile, stance: s.stance, present: 1, fate: 0, troopsAfter: 0 };
    }
    const present = recs.filter(r => r && r.present === 1).length;
    const check = campCheck(pv, b);
    if (!present && R.triviallyQuiet(check ? { ...pv, camp: check.camp } : pv, b)) {
      // SkipQuiet (contract §5.11): the day's check, the pending changes, nothing else
      if (check) { pv.camp = check.camp; if (check.spawned) emit(43, bellOf(t), { p: pv.p, q: pv.q, tile: check.camp.tile, troops: check.camp.troops, day: check.day }); }
      if (R.settleBell(pv, b) || check?.spawned) pv.rosterEpoch++;
      resolveTerritory(fieldState, pv, b);
      pv.resolvedNext = b + 1;
      return close(pv, b, null);
    }
    // ResolveFromInputs: the kernel builds the clash from the Province before the resolve and the gathered inputs, and resolves it
    const seedHex = seedOf(b, pv.region), seed = hexBytes(seedHex);
    const ci = { p: pv.p, q: pv.q, bell: b, arrivalsMask: 0xffffff, campMask: 0, flags: present ? 0 : 1, nPresent: present, settledMask: 0, arrivals: recs.map(r => (r ? { ...r } : null)), resolver: RESOLVER, resolvedTs: 0 };
    const before = encodeProvince(pv), ciBefore = W.encode('ClashInputs', ci);
    const own = K.call('resolve_from_inputs', { province: before, inputs: ciBefore, bell: b, seed });
    if (!own.ok) throw new Error(`the kernel refused the clash of ${pv.p},${pv.q} at bell ${b}: ${JSON.stringify(own)}`);
    const { outcome, digest } = decodeClashOut(own.value);
    // the write-back is not among the kernel's exports: rules.mjs writes it out from the program's own (frontier-abi
    // clash_model), over the fighters of the page's transcription of the builder, kept only when it resolves to the
    // kernel's very digest
    const campBefore = { ...pv.camp };
    if (check) pv.camp = check.camp;
    const built = buildClashArgs({ province: decodeAccount('Province', encodeProvince(pv)), inputs: decodeAccount('ClashInputs', ciBefore), bell: b, seed });
    const mine = built.ok ? resolveArgs(K, built.args) : null;
    if (!mine?.ok || mine.digest !== digest) throw new Error(`the sample world's reading of the clash of ${pv.p},${pv.q} at bell ${b} differs from the kernel's builder`);
    const arrivals = built.args.arrivals, arrPos = arrivals.map(a => recs.findIndex(r => r && r.present === 1 && same(r.hostId, a.id)));
    const garrisons = built.args.garrisons.map(g => ({ ...g, site: g.faction === R.NEUTRAL && same(g.id, campId(pv.camp.gen)) ? R.CAMP_SITE : hostParts(g.id).site }));
    const camp = { ...pv.camp };
    const ap = R.applyOutcome(pv, { bell: b, residents: built.args.residents, arrivals, garrisons, arrPos, camp }, outcome, { withdrawalRestarts: !!proto });
    R.settleBell(pv, b);
    const battleTiles = [...built.args.residents, ...built.args.arrivals].filter(f => outcome.fighters.some(x => same(x.id, f.id) && x.engaged)).map(f => f.tile);
    resolveTerritory(fieldState, pv, b, { battleTiles,
      arrivedHostIds: outcome.fighters.filter(f => f.arrival && f.fate.kind === 'Stays').map(f => f.id),
      withdrawnHostIds: outcome.fighters.filter(f => f.fate.kind !== 'Stays').map(f => f.id) });
    pv.rosterEpoch++;
    pv.resolvedNext = b + 1;
    pv.lastDigest = digest;
    pv.resolveSummary = { bell: b, engagements: outcome.engagements, arrivals: present, destroyed: ap.destroyed, bounced: ap.bounced, resolver: RESOLVER.slice(0, 8) };
    ci.arrivals.forEach((r, k) => { if (r && r.present === 1) { r.fate = ap.fates[k]; r.troopsAfter = ap.troopsAfter[k]; } });
    Object.assign(ci, { flags: ci.flags | 2, campMask: ap.campMask, resolvedTs: Math.floor(t - GENESIS_TS) });
    const lb = bellOf(t);
    if (check?.spawned) emit(43, lb, { p: pv.p, q: pv.q, tile: check.camp.tile, troops: check.camp.troops, day: check.day });
    if (ap.campCleared) emit(43, lb, { p: pv.p, q: pv.q, tile: campBefore.state === 1 && !check?.spawned ? campBefore.tile : camp.tile, troops: 0, day: Math.floor(b / R.BELLS_PER_DAY) });
    const fates = new Uint8Array(9);
    ap.fates.forEach((v, k) => { for (let x = 0; x < 3; x++) if ((v >> x) & 1) { const bit = 3 * k + x; fates[bit >> 3] |= 1 << (bit % 8); } });
    const inputDigest = toHex(sha256(utf8('PSF-CLASH-INPUT-v1'), le32(b), seed, before.slice(296, 3800), ciBefore.slice(96, 1056)));
    emit(41, lb, { p: pv.p, q: pv.q, bell: b, outcome_digest: hexBytes(digest), input_digest: hexBytes(inputDigest), engagements: outcome.engagements, fates });
    const ciAfter = W.encode('ClashInputs', ci), region = pv.region;
    st.clashes.set(`${pv.p},${pv.q},${b}`, ci);
    st.reports.set(`${pv.p},${pv.q},${b}`, { v: 1, key: `ci:${pv.p},${pv.q},${b}`, bell: b, province: [pv.p, pv.q], slot: slotNow(), inputs_b64: toBase64(ciAfter), seed: seedHex, province_before_b64: toBase64(before),
      anchor: { key: `an:${b},${region}`, A: anchorAt(b), round: Number(tlockRound(CLOCK.drand, GENESIS_TS, b)) }, cache: { key: `sd:${b},${region},0`, nonce: 0 }, archive: null, outcomeDigest: digest, inputDigest,
      decoded: { fighters: [], engagements: outcome.engagements, fates: ap.fates }, heraldCheck: 'match', builder: 'kernel', recomputedDigest: digest, checkError: null,
      // (what of this resolve the kernel does not export, said in the record itself)
      sample: 'the clash is the rules kernel\'s (resolve_from_inputs); its write-back into the Province is the sample world\'s transcription of the program\'s (frontier-abi clash_model apply, settle_bell)' });
    return close(pv, b, ciAfter);
  }
  /** The bell's own file of the province (immutable from now on, as the herald closes a bell): the Province after it, its arrival slots, its ClashInputs. */
  function close(pv, b, inputs) {
    st.closed.set(`${pv.p},${pv.q},${b}`, { ...(territory ? { sampleTerritory: territoryOf(pv) } : {}), bytes: toBase64(encodeProvince(pv)), slots: slotsOf(pv.p, pv.q, b).map(slotJson), inputs: inputs ? toBase64(inputs) : null });
    const old = `${pv.p},${pv.q},${b - LIVE.KEEP_BELLS}`;
    if (st.closed.get(old) && !st.closed.get(old).inputs) st.closed.delete(old);
  }

  // ------------------------------------------------------------------ the keeper: settles (prog/host.rs, prog/clash.rs, prog/transit.rs, prog/holding.rs)
  const all = () => [...holdings.values()];
  /** SettleDeparture (prog/host.rs:705-790): the departed entry's values after its origin's clash move into the transit record; the entry is freed. */
  function settleDepartures(t) {
    for (const H of all()) H.transit.forEach(tr => {
      if (!tr || tr.state !== TS.DEPARTED) return;
      const pv = provinces.get(key(tr.originP, tr.originQ));
      if (pv.resolvedNext <= tr.departBell) return;
      const e = entryOf(pv, tr.hostId);
      if (!e || e.state !== ES.DEPARTED) return;
      const destroyed = e.troops < R.DESTROYED_BELOW;
      Object.assign(tr, { troopsAfter: destroyed ? 0 : e.troops, staminaAfter: R.staminaAt(e.staminaValue, e.staminaBell, tr.departBell + 1), readyBellOff: Math.max(0, e.readyBell - tr.departBell), state: destroyed ? TS.DESTROYED_AT_ORIGIN : TS.SETTLED });
      R.clearEntry(e);
      pv.rosterEpoch++;
      emit(32, bellOf(t), { host_id: tr.hostId, troops_after: tr.troopsAfter, stamina_after: tr.staminaAfter, destroyed: destroyed ? 1 : 0 });
    });
  }
  /** The return settle (prog/clash.rs:1527-1620): hosts that left a province (Dissolve, a bounced resident) give their troops back to their village's reserve. */
  function settleReturns(t) {
    for (const pv of provinces.values()) for (const e of pv.entries) {
      if (e.state !== ES.DEPARTED || e.pendOp !== OP.LEAVE) continue;
      const H = holdingOfHost(e.id);
      if (H) H.reserve[e.unit] += Math.floor(e.troops / MILLI);
      emit(32, bellOf(t), { host_id: e.id, troops_after: e.troops, stamina_after: e.staminaValue, destroyed: 2 });
      R.clearEntry(e);
      pv.rosterEpoch++;
    }
  }
  /** `return_home` (prog/transit.rs:441-512): a muster-pending entry at the village when an entry and the caps allow, else the reserve. */
  function returnHome(H, tr, troops, stamina, staminaBell, nowBell) {
    if (troops < R.DESTROYED_BELOW) return;
    const pv = provinces.get(key(H.p, H.q)), roster = pv.entries.filter(e => e.state === ES.ROSTER || e.state === ES.MUSTER_PENDING), i = pv.entries.findIndex(e => e.state === ES.FREE);
    if (roster.length >= R.PROVINCE_HOST_CAP || roster.filter(e => e.faction === tr.faction).length >= R.FACTION_RESIDENT_CAP || i < 0) { H.reserve[tr.unit] += Math.floor(troops / MILLI); return; }
    pv.entries[i] = entry({ id: tr.hostId, faction: tr.faction, unit: tr.unit, tile: H.tile, state: ES.MUSTER_PENDING, troops, staminaValue: stamina, staminaBell, dealtBps: R.dealtBps(tr.faction, false),
      readyBell: Math.max(tr.departBell + tr.readyBellOff, nowBell + 1), fromBell: nowBell + 1 });
    pv.rosterEpoch++;
  }
  /** SettleTransit (contract §5.11, prog/transit.rs): `{ok}` or the program's refusal. The seal is taken as valid (SIMPLER). */
  function settleTransit(H, slot, t) {
    const tr = H.transit[slot];
    if (!tr) return no('TransitState');
    if (tr.state === TS.DEPARTED) return no('DepartureUnsettled');
    const b = tr.arriveBell, nowBell = bellOf(t), gathered = (tr.flags & TF.GATHERED) !== 0;
    if (t < closeAt(b) + 600) return no('TooEarly');
    const pv = gathered ? provinces.get(key(tr.destP, tr.destQ)) : null;
    if (pv && pv.resolvedNext <= b) return no('TooEarly');
    const ci = pv ? st.clashes.get(`${pv.p},${pv.q},${b}`) : null, pos = ci ? ci.arrivals.findIndex(r => r && same(r.hostId, tr.hostId)) : -1, rec = pos >= 0 ? ci.arrivals[pos] : null;
    let outcome, troops = 0;
    if (tr.state === TS.DESTROYED_AT_ORIGIN) outcome = OUTCOME.DESTROYED;
    else if (rec && rec.present === 1) {
      outcome = rec.fate - 1; troops = rec.troopsAfter;
      if (rec.fate === FATE.BOUNCED || rec.fate === FATE.RETREATED) returnHome(H, tr, rec.troopsAfter, rec.stamina, b, nowBell);
      ci.settledMask |= 1 << pos;
      // the camp's Works: the arrival at the lowest position of the camp mask that stays (prog/transit.rs, v1.7)
      const win = [...Array(24).keys()].find(k => (ci.campMask >> k) & 1);
      if (win === pos && rec.fate === FATE.STAYS) H.citizen.works += R.WORKS_CAMP;
      // (the prototype of the banner rule only: the trail of a host that stays, from the route its Reveal carried)
      if (proto && rec.fate === FATE.STAYS) proto.arrived(pv, tr.hostId, slotsOf(pv.p, pv.q, b).find(s => same(s.hostId, tr.hostId))?.route ?? null);
    } else {
      // no slot in a resolved set: never revealed (or the reveal was refused): routed, half its troops, no stamina
      outcome = OUTCOME.ROUTED; troops = R.routSurvivors(tr.troopsAfter);
      returnHome(H, tr, troops, 0, nowBell, nowBell);
    }
    H.escrow -= BigInt(tr.tip) + BigInt(SEASON.marchFee) + BigInt(SEASON.sealBond);
    if (H.escrow < 0n) H.escrow = 0n;
    const mine = pv ? slotsOf(pv.p, pv.q, b).find(s => same(s.hostId, tr.hostId)) : null;
    if (mine) mine.settled = true;
    H.transit[slot] = null;
    emit(34, nowBell, { host_id: tr.hostId, outcome, seal_code: 0, troops, tip: BigInt(tr.tip), fee: BigInt(SEASON.marchFee), bond: BigInt(SEASON.sealBond) });
    return { ok: true, outcome };
  }
  /** SettleExplore (prog/holding.rs:905-995): 4 Works a tile while the citizen's floor lasts, then with chance one half by the bell's seed. */
  function settleExplore(H, t) {
    const x = H.explore;
    if (!x) return no('AlreadyDone');
    if (t < seedAt(x.bell)) return no('SeedNotReady');
    const seedBytes = hexBytes(seedOf(x.bell, regionOf(x.p, x.q))), per = [0, 0];
    let total = 0, floorUsed = 0, n = 0;
    x.tiles.forEach((tile, i) => {
      if (tile === NO_TILE) return;
      const floor = H.citizen.exploresFloorLeft > 0;
      if (floor) { H.citizen.exploresFloorLeft--; floorUsed++; }
      per[i] = R.exploreRoll(seedBytes, x.p, x.q, tile, x.host, floor);
      total += per[i]; n++;
    });
    H.citizen.works += total; H.citizen.explores += n;
    H.explore = null;
    const w = new Uint8Array(8), dv = new DataView(w.buffer);
    dv.setUint32(0, per[0], true); dv.setUint32(4, per[1], true);
    emit(27, bellOf(t), { host_id: x.host, works_per_tile: w, works: total, floor_used: floorUsed });
    return { ok: true, works: total };
  }

  // ------------------------------------------------------------------ the neighbours' orders (through the same Depart and Reveal)
  function npcOrders(b, t) {
    for (const n of st.npc) {
      if (n.at > b) continue;
      const H = n.H, at = [...provinces.values()].find(pv => entryOf(pv, n.id));
      const e = at && entryOf(at, n.id);
      if (!e) { if (!inTransit(H, n.id)) n.at = Infinity; continue; }   // lost: it marches no more
      // (a neighbour gives no order the program would refuse: it waits while its host forms, rests or its province lags)
      if (e.state !== ES.ROSTER || e.pendOp !== OP.NONE || inTransit(H, n.id) || b < e.readyBell || R.staminaAt(e.staminaValue, e.staminaBell, b) < R.DEPART_STAMINA || !R.residentOk(at.resolvedNext, b)) continue;
      // out: an open tile of the viewer's province nobody stands on; home: its own village
      let dest;
      if (n.out) {
        // (nor where another neighbour is already bound: the script stands in for people who would not walk into each other)
        const taken = new Set([...home.entries.filter(x => x.state !== ES.FREE).map(x => x.tile), ...all().flatMap(X => X.plans.map(x => unpack(x.plain))).filter(x => x.destP === home.p && x.destQ === home.q).map(x => x.destTile),
          ...[...st.slots.values()].flat().filter(x => x.p === home.p && x.q === home.q && x.bell >= home.resolvedNext).map(x => x.tile)]);
        const cands = [...Array(61).keys()].filter(x => passable(home, x) && siteOfTile(home, x) < 0 && !(home.camp.state === 1 && home.camp.tile === x) && !taken.has(x));
        dest = cands.length ? { p: home.p, q: home.q, tile: cands[pick(cands.length, 'npc-tile', n.id.toString(), b)] } : null;
      } else dest = { p: H.p, q: H.q, tile: H.tile };
      if (!dest || (dest.p === at.p && dest.q === at.q && dest.tile === e.tile)) { n.out = !n.out; n.at = b + 1; continue; }
      const plan = K.call('plan_path', { start: tileHex(at.p, at.q, e.tile), dest: tileHex(dest.p, dest.q, dest.tile), unit: e.unit, blocked: [], seeds: RINGS });
      if (!plan.ok || !plan.value || plan.value.dirs.length > R.MAX_PATH_STEPS) { n.at = b + 1; continue; }
      const early = K.call('earliest_arrival_bell', { genesis_ts: GENESIS_TS, depart_ts: Math.floor(t), secs: R.travelSecs(e.faction, plan.value.secs) }).value;
      const arrive = Math.max(b + R.MIN_ARRIVAL_LEAD_BELLS, early) + pick(2, 'npc-late', n.id.toString(), b);
      const slot = H.transit.findIndex(x => !x), path = encodePath(plan.value.dirs);
      const plain = pack({ version: 1, hostId: n.id, arriveBell: arrive, destP: dest.p, destQ: dest.q, destTile: dest.tile, stance: 0, retreatBps: 0, pathLen: path.pathLen, path: path.path });
      const salt = rng('npc-salt', n.id.toString(), b), seal = Uint8Array.from({ length: 165 }, (_, i) => (i === 0 ? 0x80 | (salt[1] & 0x1f) : salt[i % 32] ^ i));
      const r = ORDER.Depart(H, { host_id: n.id, commit: sealCommit(plain, salt), seal, arrive_bell: arrive, tip: TIP_MIN, transit_slot: slot }, at, t);
      st.npcLog.push({ host: n.id, bell: b, ok: r.ok, code: r.code ?? null, arrive, dest });
      if (!r.ok) { n.at = b + 1; continue; }
      H.plans.push({ slot, plain, salt, ctHash: sealCtHash(seal), arrive, host: n.id });
      // it rests where it arrives until its stamina carries another march (74 of 120, one a turn), then goes the other way
      n.out = !n.out;
      n.at = arrive + 30 + pick(6, 'npc-rest', n.id.toString(), b);
    }
  }
  /** The keeper opens what the round of the arrival bell's end unlocks: the neighbours' marches (the world wrote their orders, so it can). */
  function npcReveals(b, t) {
    for (const H of all()) {
      for (const x of H.plans.filter(x => x.arrive === b)) { const r = reveal(H, x.slot, x.plain, x.salt, x.ctHash, t); reveals.push({ host: x.host, bell: bellOf(t), ok: r.ok, code: r.code ?? null, by: 'keeper' }); }
      H.plans = H.plans.filter(x => x.arrive !== b);
    }
  }
  /** The tiles a march enters before its last, nearest the arrival first: `[{p, q, tile}]` (the prototype's trail is cut from it). */
  function routeTiles(start, dirs) {
    const out = [];
    let h = { q: start.q, r: start.r };
    dirs.forEach((d, i) => { h = { q: h.q + DIRECTIONS[d][0], r: h.r + DIRECTIONS[d][1] }; if (i < dirs.length - 1) { const l = locate(h.q, h.r); out.unshift({ p: l.p, q: l.q, tile: l.idx }); } });
    return out;
  }
  /** One march of a neighbour's host, ordered by a script through the same Depart (the keeper reveals it when its arrival turn has ended): `{ok, arrive}` or why not. */
  function scriptMarch(H, id, at, e, dest, b, t) {
    const plan = K.call('plan_path', { start: tileHex(at.p, at.q, e.tile), dest: tileHex(dest.p, dest.q, dest.tile), unit: e.unit, blocked: [], seeds: RINGS });
    if (!plan.ok || !plan.value || plan.value.dirs.length > R.MAX_PATH_STEPS) return { ok: false, code: 'Path' };
    const early = K.call('earliest_arrival_bell', { genesis_ts: GENESIS_TS, depart_ts: Math.floor(t), secs: R.travelSecs(e.faction, plan.value.secs) }).value;
    const arrive = Math.max(b + R.MIN_ARRIVAL_LEAD_BELLS, early), slot = H.transit.findIndex(x => !x), path = encodePath(plan.value.dirs);
    if (slot < 0) return { ok: false, code: 'TransitState' };
    const plain = pack({ version: 1, hostId: id, arriveBell: arrive, destP: dest.p, destQ: dest.q, destTile: dest.tile, stance: 0, retreatBps: 0, pathLen: path.pathLen, path: path.path });
    const salt = rng('script-salt', id.toString(), b), seal = Uint8Array.from({ length: 165 }, (_, i) => (i === 0 ? 0x80 | (salt[1] & 0x1f) : salt[i % 32] ^ i));
    const r = ORDER.Depart(H, { host_id: id, commit: sealCommit(plain, salt), seal, arrive_bell: arrive, tip: TIP_MIN, transit_slot: slot }, at, t);
    if (r.ok) H.plans.push({ slot, plain, salt, ctHash: sealCtHash(seal), arrive, host: id });
    return r.ok ? { ok: true, arrive } : r;
  }
  // ------------------------------------------------------------------ the prototype of the banner rule (off unless `claims`)
  const proto = claims && land ? createClaims({
    options: typeof claims === 'object' ? claims : {}, provinces, holdings, home, HOME, me: () => ME, st, pick, startTurn: LIVE.TURN, neighbours, viewer, K, RINGS, SEASON, R, quotaReset: () => GENESIS_TS + (st.quota.day + 1) * R.DAY,
    now, bellOf, slotNow, player, done, no, entryOf, inTransit, holdingOfHost, scriptMarch, routeTiles, wall, landMs,
    /** A record of the prototype in the world's log (served by /h/events as `kind: 'PROTO_LAND', proto: true`). */
    log: rec => { st.log.push({ seq: BASE_SEQ + st.log.length, slot: slotNow(), kind: 'PROTO_LAND', bell: rec.turn, fields: rec, proto: true, body: null }); },
    /** One more host standing at a neighbour's village (the script's own). */
    addHost: (H, seq, unit, troops) => { const id = hostId({ p: H.p, q: H.q, site: H.site, gen: 0, seq }); put(provinces.get(key(H.p, H.q)), { id, faction: H.faction, unit, tile: H.tile, state: ES.ROSTER, troops: troops * MILLI, staminaValue: R.STAMINA_CAP, staminaBell: BELL, dealtBps: R.dealtBps(H.faction, false), readyBell: 30, fromBell: 30 }); return id; },
    startRoute: stage === 'holding' ? { host: HOSTS.marching, route: routeTiles(tileHex(HOME.p, HOME.q, HOME.tile), [...W.MARCH_DIRS]) } : null,
  }) : null;
  // the neighbour's march that is on its way when the world starts: ordered during the turn before
  if (st.npc.some(n => n.at < LIVE.TURN)) npcOrders(LIVE.TURN - 1, bs(LIVE.TURN - 1) + LIVE.NPC_AT);

  // ------------------------------------------------------------------ the agenda: what is due, in the order of its time
  const STEPS = [
    ['anchor', anchorAt, (b, t) => npcReveals(b, t)],
    ['transit', transitAt, (b, t) => { for (const H of all()) H.transit.forEach((tr, i) => { if (tr && tr.arriveBell === b && tr.state !== TS.DEPARTED) settleTransit(H, i, t); }); }],
    ['resolve', resolveAt, (b, t) => {
      if (b >= SEASON.endBell) return;   // no bell at or after the season's end is resolved (contract §5.11)
      for (const pv of [...provinces.values()].sort((x, y) => x.p - y.p || x.q - y.q)) if (pv.resolvedNext === b) { resolveBell(pv, b, t); proto?.keeper(pv); }
      settleDepartures(t); settleReturns(t);
      for (const H of all()) if (H.explore && H.explore.bell <= b) settleExplore(H, t);
    }],
    ['npc', b => bs(b) + LIVE.NPC_AT, (b, t) => { npcOrders(b, t); proto?.script(b, t); }],
  ];
  // what happened before the world starts has happened: each step begins at the first bell whose time is still to come
  for (const [name, at] of STEPS) { let b = LIVE.TURN - 6; while (at(b) <= START) b++; st.next[name] = b; }
  /** Bring the world up to the clock: every step that is due, in time order; the quota's day. */
  function settle() {
    const t = now();
    for (;;) {
      let best = null;
      for (const [name, at, run] of STEPS) { const b = st.next[name], when = at(b); if (when <= t && (!best || when < best.when)) best = { name, b, when, run }; }
      if (!best) break;
      st.next[best.name] = best.b + 1;
      best.run(best.b, best.when);
    }
    // the relay's quota: 40 a game day, unused allowance carried up to 60 (gateway src/frontier/quota.mjs)
    const day = Math.floor(bellOf(t) / R.BELLS_PER_DAY);
    while (st.quota.day < day) { st.quota.day++; st.quota.left = Math.min(60, st.quota.left + 40); }
    return t;
  }

  // A first-home development world uses the existing signed Join / PlaceHome
  // shapes. One wallet, one grant; the selected nation determines the wedge.
  function startOrder(name, d, acc, t) {
    if (!opening) return null;
    const b = bellOf(t);
    if (name === 'Join') {
      if (JOINED || ME) return no('AlreadyJoined');
      if (acc.wallet !== viewer.wallet || acc.citizen !== viewer.citizen || !(d.faction >= 0 && d.faction < 6) || Number(d.session_expiry) <= t) return no('BadData');
      JOINED = { ...W.citizenValues(viewer, 'joined'), faction: d.faction, session: Uint8Array.from(d.session), sessionExpiry: Number(d.session_expiry), joinBell: b };
      viewerSession = toBase58(d.session);
      emit(10, b, { wallet: fromBase58(viewer.wallet), faction: d.faction, session: d.session, expiry: d.session_expiry });
      return done();
    }
    if (name === 'SetSession') {
      if (!JOINED) return no('NotJoined');
      if (acc.citizen !== viewer.citizen || Number(d.expiry) <= t) return no('BadData');
      JOINED.session = Uint8Array.from(d.session); JOINED.sessionExpiry = Number(d.expiry);
      viewerSession = toBase58(d.session);
      emit(11, b, { session: d.session, expiry: d.expiry });
      return done();
    }
    if (name === 'PlaceHome') {
      if (!JOINED) return no('NotJoined');
      if (ME || (JOINED.flags & 32)) return no('HomeAlreadyGranted');
      const pv = provinces.get(key(d.p, d.q));
      if (!pv || pv.ring < 2 || wedgeOf(d.p, d.q) !== JOINED.faction || acc.province !== A.of('Province', d) || acc.holding !== A.of('Holding', d)) return no('BadAccount');
      if (!(d.site >= 0 && d.site < pv.siteCount) || pv.siteMirror[d.site].state !== 0 || pv.sites[d.site] === pv.camp.tile && pv.camp.state === 1) return no('SiteOccupied');
      const k = R.foundHolding(t, Math.floor((t - GENESIS_TS) / R.DAY));
      ME = village({ p: d.p, q: d.q, site: d.site, faction: JOINED.faction, tier: 0, k, state: 2, ticketBell: b, finalTs: t, hostSeq: 0 });
      ME.flags = 2; ME.citizen.flags |= 32; ME.gen = pv.siteMirror[d.site].gen;
      JOINED.flags = ME.citizen.flags; land = true;
      emit(17, b, { p: ME.p, q: ME.q, site: ME.site, citizen_tag: VIEWER_TAG, gen: ME.gen, final_ts: t });
      return done();
    }
    return null;
  }

  // ------------------------------------------------------------------ the relay
  const answer = r => ({ status: 200, body: r });
  /** POST /f/relay: the checks of the real relay that need no chain, then the instruction as the program runs it. */
  async function sponsor(body) {
    const fk = await fee;
    let tx, shape;
    try {
      const wire = fromBase64(String(body?.tx ?? ''));
      tx = parseTransaction(wire);
      shape = classify(tx, { programId: PROGRAM, wireBytes: wire.length });
    } catch (e) {
      return answer({ ok: false, code: 'InvalidTransaction', error: String(e?.message ?? e) });
    }
    if (!shape.ok) return answer({ ok: false, code: shape.code, error: `relay refused: ${shape.problem}` });
    if (shape.feePayer !== fk.publicKey) return answer({ ok: false, code: 'RelayRejected', error: 'relay refused: the fee payer is not a key of this relay' });
    if (shape.authority) {
      const sig = tx.signatures[tx.signers.indexOf(shape.authority)];
      if (shape.authority !== (['Join', 'SetSession'].includes(shape.name) ? viewer?.wallet : viewerSession) || !(await verify(shape.authority, tx.message, sig))) return answer({ ok: false, code: 'BadSignature', error: 'the authority\'s signature is missing or invalid' });
    } else if (body?.requester !== undefined) {
      // a settle shape is charged to its requester, who signed the request (contract §8.3)
      let good = false;
      try { good = body.requester === viewerSession && await verify(body.requester, tx.message, fromBase64(String(body.requesterSig ?? ''))); } catch { good = false; }
      if (!good) return answer({ ok: false, code: 'BadSignature', error: 'the requester\'s signature is missing or invalid' });
    }
    const t = Math.floor(settle()), turnNow = bellOf(t), d = shape.data, acc = shape.accounts;
    const refuse = r => { orders.push({ name: shape.name, ok: false, code: r.code, turn: turnNow }); return answer(r); };
    if (!ME && !(opening && ['Join', 'SetSession', 'PlaceHome'].includes(shape.name))) return refuse(no('NotJoined'));
    if (opening && acc.citizen !== undefined && acc.citizen !== viewer.citizen) return refuse(no('NotOwner'));
    if (opening && JOINED && shape.authority && !['Join', 'SetSession'].includes(shape.name) && Number(JOINED.sessionExpiry) <= t) return refuse(no('SessionExpired'));
    if (shape.name !== 'PlaceHome' && acc.holding !== undefined && acc.holding !== myHolding()) return refuse(no('NotOwner'));
    if (st.quota.left < 1) return refuse({ ...no('QuotaExceeded'), retryAt: GENESIS_TS + (st.quota.day + 1) * R.DAY });
    const pv = acc.province ? provinceAt.get(acc.province) ?? null : null;
    let r = startOrder(shape.name, d, acc, t);
    if (r) { /* start order already checked */ }
    else if (ORDER[shape.name]) r = ORDER[shape.name](ME, d, pv, t);
    else if (shape.name === 'SettleExplore') r = settleExplore(ME, t);
    else if (shape.name === 'SettleTransit') r = settleTransit(ME, d.transit_slot, t);
    else return null;   // a shape this world does not play (the fixture's old refusal then)
    if (!r.ok) return refuse(r);
    const signature = toBase58(await fk.sign(tx.message));
    st.sent.set(signature, { at: wall() + landMs, slot: slotNow() });
    st.quota.left--;
    orders.push({ name: shape.name, ok: true, signature, turn: turnNow });
    return answer({ ok: true, signature });
  }
  /** POST /f/reveal: the keeper's answer; the Reveal itself is judged as the program judges it (refused: nothing is written, the march will be routed). */
  function revealRoute(body) {
    let plain, salt, ct;
    try { plain = fromBase64(String(body?.plain_b64 ?? '')); salt = fromBase64(String(body?.salt_b64 ?? '')); ct = fromBase64(String(body?.ct_hash_b64 ?? '')); unpack(plain); } catch { return answer({ ok: false, code: 'BadPlaintext', error: 'plain_b64 must be base64 of 37 bytes' }); }
    const t = Math.floor(settle());
    if (!ME || body?.holding !== myHolding()) return answer({ ok: false, code: 'TransitState', error: REFUSED_TEXT.TransitState });
    const tr = ME.transit[body.transit_slot];
    if (!tr) return answer({ ok: false, code: 'TransitState', error: REFUSED_TEXT.TransitState });
    const r = reveal(ME, body.transit_slot, plain, salt, ct, t);
    reveals.push({ host: tr.hostId, bell: bellOf(t), ok: r.ok, code: r.code ?? null, by: 'self' });
    return { status: 202, body: { accepted: true, track: `live-${++st.tracks}` } };
  }

  // ------------------------------------------------------------------ the herald
  const live = pv => ({ v: 1, key: `pv:${pv.p},${pv.q}`, bell: bellOf(now()), slot: slotNow(), seq: String(pv.eventSeq), head: '7e'.repeat(32), bytes: toBase64(encodeProvince(pv)),
    slots: slotsOf(pv.p, pv.q, bellOf(now())).filter(s => !s.settled).map(slotJson), day: null, inputs: null, ...(territory ? { sampleTerritory: territoryOf(pv) } : {}) });
  function holdingBytes(H) {
    return W.encode('Holding', { flags: H.flags ?? 0, p: H.p, q: H.q, site: H.site, gen: H.gen, tile: H.tile, state: H.state, ownerCitizen: fromBase58(viewer.citizen), faction: H.faction, order: H.order, tier: H.tier, ticketBell: H.ticketBell,
      foundedTs: H.foundedTs, foundedDay: H.foundedDay, hostSeq: H.hostSeq, lastOwnerAction: Math.floor(H.lastOwnerAction), shieldUntil: H.shieldUntil,
      stores: H.stores.map(s => ({ ...s, t0: Math.floor(s.t0) })), production: H.production, upkeep: H.upkeep, queue: H.queue.map(q => q ?? FREE_QUEUE), walls: H.walls, wallsCommittedBefore: Math.floor(H.wallsCommittedBefore),
      foodShortfall: H.foodShortfall, reserve: H.reserve, transit: H.transit.map(x => x ?? FREE_TRANSIT), ...(H.explore ? { explore: H.explore } : {}), escrow: H.escrow, finalTs: H.finalTs, poolOwed: H.poolOwed });
  }
  function me() {
    if (!ME) return JOINED ? { v: 1, wallet: viewer.wallet, citizen: { address: viewer.citizen, bytes_b64: toBase64(W.encode('Citizen', JOINED)) }, holdings: [], slots: [] } : W.meRecord(viewer, stage);
    const c = ME.citizen;
    const citizen = W.encode('Citizen', { ...W.citizenValues(viewer, stage), ...(JOINED ?? {}), faction: ME.faction, holdingsN: 1, holding: [{ p: ME.p, q: ME.q, site: ME.site, gen: ME.gen }], flags: c.flags, exploresFloorLeft: c.exploresFloorLeft, works: BigInt(c.works), explores: c.explores, arrivals: c.arrivals, bucketMilli: c.bucketMilli, bucketT: Math.floor(c.bucketT), lastActionTs: Math.floor(c.lastActionTs) });
    const hosts = [], slots = [];
    for (const pv of provinces.values()) for (const e of pv.entries) if (e.state !== ES.FREE && holdingOfHost(e.id) === ME) hosts.push({ id: String(e.id), province: [pv.p, pv.q], state: e.state, faction: e.faction, unit: e.unit, tile: e.tile, troops: e.troops, readyBell: e.readyBell, fromBell: e.fromBell });
    for (const list of st.slots.values()) for (const s of list) if (s.citizenTag === VIEWER_TAG && !s.settled) slots.push({ key: slotJson(s).key, slot: s.slot, bytes_b64: slotJson(s).bytes });
    return { v: 1, wallet: viewer.wallet, citizen: { address: viewer.citizen, bytes_b64: toBase64(citizen) }, holdings: [{ address: myHolding(), bytes_b64: toBase64(holdingBytes(ME)) }], hosts,
      transits: ME.transit.map((x, slot) => (x ? { slot, host: String(x.hostId), state: x.state, departBell: x.departBell, arriveBell: x.arriveBell } : null)).filter(Boolean), slots, seals: [],
      quota: { left: st.quota.left, resetsAt: GENESIS_TS + (st.quota.day + 1) * R.DAY }, latestSlot: slotNow() };
  }
  // (a record of the prototype is no PS2 record and has no body: `{seq, kind: 'PROTO_LAND', proto: true, ...}`; `slot` is its banner's slot)
  const eventJson = x => { if (x.proto) return { seq: String(x.seq), chainSlot: x.slot, kind: 'PROTO_LAND', proto: true, ...x.fields }; x.body ??= toBase64(W.record(x.kind, x.bell, x.fields)); return { seq: String(x.seq), slot: x.slot, sig: String((x.seq % 9) + 1).repeat(64), body_b64: x.body }; };
  function bellRegion(b, region) {
    const t = now();
    if (t < anchorAt(b)) return { v: 1, bell: b, region, anchor: null, S: null, caches: [], tombstoned: false, archived: false, resolved: [] };
    const a = anchorAt(b), S = Number(seedRoundOf(b));
    const anchor = W.encode('BellAnchor', { bell: b, region, net: 2, round: Number(tlockRound(CLOCK.drand, GENESIS_TS, b)), a, slot: 100_000, sig48: '93'.repeat(48) });
    return { v: 1, bell: b, region, anchor: { key: `an:${b},${region}`, bytes_b64: toBase64(anchor) }, S, caches: t >= seedAt(b) ? [{ nonce: 0, round: S, seed: seedOf(b, region), A: a }] : [],
      tombstoned: false, archived: false, resolved: [...st.reports.values()].filter(r => r.bell === b && regionOf(r.province[0], r.province[1]) === region).map(r => r.province) };
  }
  /** What the season record says of the sample world (the hook for the page: the clock's rate, 0 while it stands). */
  const sampleNow = () => ({ world: 'sample', ...(territory ? { territory: { mode: 'arrival-control', authority: 'local-preview' } } : {}), turnSecs, rate: frozen ? 0 : rate, paused: frozen, seed, simpler: opening ? SIMPLER.filter(x => !x.startsWith('no joining')).concat('first-home and arrival-control are local development rules; no chain transactions or funds') : proto ? [...SIMPLER, ...SIMPLER_CLAIMS] : SIMPLER, ...(stores ? { stores: [...stores] } : {}), ...(proto ? { proto: { claims: proto.season() } } : {}) });

  return {
    orders, reveals,
    /** The page's first /h/season: the clock starts. */
    seen() { if (t0 === null && !frozen) t0 = wall(); },
    now, turn: () => bellOf(now()),
    /** When the first turn ends (chain seconds), and when the world's clock starts. */
    tollAt: T1, startAt: START, turnSecs, rate,
    /** Step to the next turn at once: `into` game seconds after it begins (by default after the turn's opening has resolved). A page that is open learns it at its next season poll. */
    advance({ into = LIVE.ADVANCE_INTO } = {}) {
      const t = now(), next = bs(bellOf(t) + 1) + into;
      base += next - t;
      settle();
      return bellOf(now());
    },
    /** Stop the clock (true) or let it run again (false). */
    pause(on = true) {
      const t = now();
      frozen = !!on; base = t; t0 = frozen ? t0 : wall();
      return frozen;
    },
    /** The clock alone: what the season record says. */
    clock() { const t = settle(); return { headSeq: BASE_SEQ + st.log.length - 1, latestUnix: Math.floor(t), latestSlot: slotNow() }; },
    /** The world in a few lines (the play-through script prints it; tests read it). */
    summary() {
      const t = settle(), b = bellOf(t);
      const hostsOf = H => [...provinces.values()].flatMap(pv => pv.entries.filter(e => e.state !== ES.FREE && holdingOfHost(e.id) === H).map(e => ({ id: String(e.id), unit: e.unit, troops: Math.floor(e.troops / MILLI), province: [pv.p, pv.q], tile: e.tile, state: e.state,
        stamina: R.staminaAt(e.staminaValue, e.staminaBell, b), readyBell: e.readyBell, fromBell: e.fromBell, pending: e.pendOp })));
      const of = H => ({ village: [H.p, H.q, H.site], tile: H.tile, nation: H.faction, state: H.state, tier: H.tier, reserve: [...H.reserve], hosts: hostsOf(H),
        marches: H.transit.map((x, slot) => (x ? { slot, host: String(x.hostId), state: x.state, departBell: x.departBell, arriveBell: x.arriveBell, revealed: [...st.slots.values()].some(l => l.some(s => same(s.hostId, x.hostId) && s.bell === x.arriveBell)) } : null)).filter(Boolean) });
      return { turn: b, into: Math.floor(t - bs(b)), turnSecs, paused: frozen, resolvedNext: home.resolvedNext, camp: { ...home.camp }, explored: home.exploredMask.toString(2).split('').reverse().map((x, i) => (x === '1' ? i : -1)).filter(i => i >= 0),
        me: ME ? { ...of(ME), stores: ME.stores.map(s => Math.floor(R.accrualAt(s, Math.floor(t)) / MILLI)), perHour: ME.stores.map(s => s.rate / MILLI), queue: ME.queue.filter(Boolean).map(q => ({ kind: q.kind, arg: q.arg, doneIn: Math.round(q.doneAt - t) })),
          walls: ME.walls, garrison: Math.floor(provinces.get(key(ME.p, ME.q)).siteMirror[ME.site].garrison / MILLI), explore: ME.explore ? { bell: ME.explore.bell, tiles: ME.explore.tiles.filter(x => x !== NO_TILE) } : null, works: ME.citizen.works, floorLeft: ME.citizen.exploresFloorLeft,
          bucket: Math.floor(ME.citizen.bucketMilli / 1000), quota: st.quota.left, shieldUntilBell: bellFrom(ME.shieldUntil), finalAt: ME.state === 1 ? ME.finalTs : null } : null,
        neighbours: all().filter(H => H.npc).map(of), ...(territory ? { territory: [...provinces.values()].map(pv => ({ p: pv.p, q: pv.q, ...territoryOf(pv) })) } : {}), records: st.log.length, ...(proto ? { proto: proto.summary() } : {}) };
    },
    /** The log's records after `after` (decoded names for tests: `{seq, kind, bell, fields}`). */
    records: (after = -1) => { settle(); return st.log.filter(x => x.seq > after).map(x => ({ seq: x.seq, kind: x.kind, bell: x.bell, fields: x.fields })); },
    /** The fake herald while the world is live: `{status, body}`, or null for what the still fixture answers. */
    herald(path, url) {
      let m;
      if (path === '/h/season') { this.seen(); const c = this.clock(); return answer({ ...seasonRecord(), headSeq: String(c.headSeq), latestUnix: c.latestUnix, latestSlot: c.latestSlot, sample: sampleNow() }); }
      settle();
      if ((m = /^\/h\/province\/(-?\d+),(-?\d+)\/(latest|\d+)$/.exec(path))) {
        const pv = provinces.get(key(Number(m[1]), Number(m[2])));
        if (!pv) return null;
        if (m[3] === 'latest') { const land = proto?.province(pv); return answer(land ? { ...live(pv), proto: { land } } : live(pv)); }
        const b = Number(m[3]), c = st.closed.get(`${pv.p},${pv.q},${b}`);
        // a bell's own file exists once the bell is resolved (the page keeps it for good); until then it is not a
        // file the page can read, and the page takes the latest one (the real herald answers 425 Too Early)
        if (!c) return answer({ v: 0, ok: false, code: 'TooEarly', error: `bell ${b} of province ${pv.p},${pv.q} is not closed (or its file was not kept)` });
        return answer({ v: 1, key: `pv:${pv.p},${pv.q}`, bell: b, slot: slotNow(), seq: String(pv.eventSeq), head: '7e'.repeat(32), bytes: c.bytes, slots: c.slots, day: null, ...(territory ? { sampleTerritory: c.sampleTerritory } : {}),
          inputs: c.inputs ? { key: `ci:${pv.p},${pv.q},${b}`, seq: '1', head: '7e'.repeat(32), bytes: c.inputs } : null });
      }
      if ((m = /^\/h\/bell\/(\d+)\/region\/(\d+)$/.exec(path))) return answer(bellRegion(Number(m[1]), Number(m[2])));
      if ((m = /^\/h\/me\/(\w+)$/.exec(path)) && m[1] === viewer.wallet) return answer(proto && ME ? { ...me(), proto: { land: proto.me() } } : me());
      if (proto && path === '/h/proto/standings') return answer(proto.standings());
      if (proto && path === '/h/proto/preview') return answer(proto.preview(url));
      if (path === '/h/events') {
        const after = Number(url.searchParams.get('after') ?? 0) || 0;
        const list = st.log.filter(x => x.seq > after).slice(0, 400).map(eventJson);
        return answer({ v: 1, events: list, next: String(list.length ? list[list.length - 1].seq : after), full: st.log.some(x => x.seq > (list.length ? Number(list[list.length - 1].seq) : after)) });
      }
      if ((m = /^\/h\/clash\/(-?\d+),(-?\d+)\/(\d+)$/.exec(path))) { const r = st.reports.get(`${Number(m[1])},${Number(m[2])},${Number(m[3])}`); return r ? answer(r) : null; }
      return null;
    },
    /** The relay's answer `{status, body}`, or null for what this world does not play (the fixture's old refusal then). */
    async relay(method, path, body) {
      const fk = await fee;
      settle();
      const quota = { left: st.quota.left, resetsAt: GENESIS_TS + (st.quota.day + 1) * R.DAY };
      if (method === 'GET' && path === '/gw/f/relay') return answer({ feePayer: fk.publicKey, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000, programId: PROGRAM, quota });
      if (method === 'GET' && path === '/gw/f/quota') return answer({ ...quota, lamportsLeft: '400000000' });
      if (proto && method === 'POST' && path === '/gw/f/proto/land') return answer(proto.route(body, Math.floor(now()), orders));
      if (method === 'GET' && path.startsWith('/gw/f/tx/')) {
        const s = st.sent.get(decodeURIComponent(path.slice('/gw/f/tx/'.length)));
        return answer(s && s.at <= wall() ? { state: 'landed', slot: s.slot } : { state: 'unknown' });
      }
      if (method === 'POST' && (path === '/gw/f/relay' || opening && path === '/gw/f/join')) return land || opening ? sponsor(body) : null;
      if (method === 'POST' && path === '/gw/f/reveal') return land ? revealRoute(body) : null;
      if (method === 'POST' && path === '/gw/f/nudge') return answer({ queued: true, blocking: false });
      return null;
    },
    /** For tests: an order as the program would take it from the viewer, without the relay's envelope (`name`, the instruction's data, the province it names). */
    order(name, data = {}, province = HOME) { const t = Math.floor(settle()); return ME && ORDER[name] ? ORDER[name](ME, data, province ? provinces.get(key(province.p, province.q)) ?? null : null, t) : no('BadData'); },
    /** For tests: the Reveal of one of the viewer's marches, judged as the program judges it. */
    revealNow(slot, plain, salt, ctHash) { const t = Math.floor(settle()); return reveal(ME, slot, plain, salt, ctHash, t); },
    settleExploreNow() { return settleExplore(ME, Math.floor(settle())); },
    settleTransitNow(slot) { return settleTransit(ME, slot, Math.floor(settle())); },
    /** For tests: a province's fields as the world holds them (a copy). */
    province: (p, q) => { settle(); const pv = provinces.get(key(p, q)); return pv ? structuredClone(pv) : null; },
    npcLog: st.npcLog,
    /** The prototype of the banner rule in this world (claimsworld.mjs), or null when it is off. */
    proto,
  };
}
