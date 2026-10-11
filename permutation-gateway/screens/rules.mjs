// The M1 rules the sample world plays (UX design 14.5; liveworld.mjs), written
// out from the rules crate and the program, each with its source. Nothing
// here is a rule of its own: every number and every step is a transcription,
// and the tests (liveworld.screen.mjs) pin them against the sources' own
// figures. What the rules kernel exports (the page loads the same file:
// web/frontier/wasm/frontier.wasm) is NOT written out again: the clash, the
// path's cost and the arrival bell are asked of the kernel (kernel.mjs).
//
// Sources (paths from the repository root):
//   catalog   permutation-rules/src/frontier/catalog.rs
//   holding   permutation-rules/src/frontier/holding.rs
//   host      permutation-rules/src/frontier/host.rs
//   travel    permutation-rules/src/frontier/travel.rs
//   explore   permutation-rules/src/frontier/explore.rs
//   camp      permutation-rules/src/frontier/camp.rs
//   doctrine  permutation-rules/src/frontier/doctrine.rs
//   units     permutation-rules/src/units.rs
//   rng       permutation-rules/src/rng.rs
//   model     frontier-abi/src/clash_model.rs (the program's clash builder and write-back)
//   prog/*    permutation-frontier/src/proc/{holding,host,transit,reveal,clash}.rs
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';

export const MILLI = 1000;
export const HOUR = 3600;
export const DAY = 86_400;
export const BELL_SECS = 600;                 // travel.rs:36
export const BELLS_PER_DAY = 144;             // travel.rs:38
export const RESOURCES = 8;                   // holding.rs:44 (Food, Wood, Stone, Ore, Horses, Gold, Science, Influence)
export const RES = Object.freeze({ Food: 0, Wood: 1, Stone: 2, Ore: 3, Horses: 4, Gold: 5, Science: 6, Influence: 7 });
export const NO_BELL = 0xffffffff;
export const NO_TILE = 0xff;
export const PROVINCE_TILES = 61;

// ------------------------------------------------------------------ catalog.rs
/** Base production of a hamlet per hour, units (catalog.rs:37). */
export const BASE_PROD = Object.freeze([40, 30, 20, 15, 0, 15, 5, 0]);
/** Extra base production by tier, percent (catalog.rs:40-47). */
export const TIER_BONUS_PCT = Object.freeze([0, 50, 100, 175]);
/** The six buildings: resource, units per hour, the first copy's cost (catalog.rs:60-91). */
export const BUILDINGS = Object.freeze([
  { resource: RES.Food, perHour: 12, cost: [0, 80, 40, 0, 0, 0, 0, 0] },
  { resource: RES.Wood, perHour: 10, cost: [40, 0, 40, 0, 0, 0, 0, 0] },
  { resource: RES.Stone, perHour: 8, cost: [40, 80, 0, 0, 0, 0, 0, 0] },
  { resource: RES.Ore, perHour: 6, cost: [40, 80, 20, 0, 0, 0, 0, 0] },
  { resource: RES.Gold, perHour: 6, cost: [40, 60, 40, 0, 0, 0, 0, 0] },
  { resource: RES.Science, perHour: 3, cost: [0, 60, 60, 0, 0, 20, 0, 0] },
].map(Object.freeze));
export const ITEM_WALLS = 6;                  // catalog.rs:94
export const ITEM_TIER_UP = 7;                // prog/holding.rs:98 (catalog::ITEM_COUNT)
/** Build seconds of a building's n-th copy (catalog.rs:100-102). */
export const buildSecs = n => 3_600 + 1_800 * n;
/** Tier-up cost (units) and seconds from tier t, or null at the top (catalog.rs:106-113). */
export const TIER_UP = Object.freeze([
  { cost: [0, 1_000, 600, 0, 0, 300, 0, 0], secs: 6 * HOUR },
  { cost: [0, 4_000, 3_000, 0, 0, 1_500, 0, 0], secs: 12 * HOUR },
  { cost: [0, 12_000, 10_000, 0, 0, 5_000, 0, 0], secs: 24 * HOUR },
  null,
]);
export const TROOP_COST_PER_100 = Object.freeze([60, 20, 10]);   // food, ore, gold (catalog.rs:117)
export const TROOP_COST_BASE_PROD = 6;        // catalog.rs:120
export const WALL_STEP = 100, WALL_COST_STONE = 300, WALL_SECS = 4 * HOUR;   // catalog.rs:124-126
/** Starter kit of a new first holding, units (catalog.rs:133). */
export const STARTER_KIT = Object.freeze([300, 300, 200, 100, 0, 100, 0, 0]);
export const WORKS_EXPLORE = 4, WORKS_CAMP = 10;   // catalog.rs:137-138
/** `catalog::base_production(tier)`, milli-units per hour (catalog.rs:145-147; the division before the ×1,000, as there). */
export const baseProduction = tier => BASE_PROD.map(b => Math.floor((b * (100 + TIER_BONUS_PCT[tier])) / 100) * MILLI);
/** Production cost per troop by unit (units.rs:83-92 `UNIT_STATS`, column prod), Spearman … Settler. */
export const UNIT_PROD_COST = Object.freeze([6, 7, 9, 12, 14, 16, 10, 30]);
/** Mounted units ride at cavalry pace (units.rs: class Mounted = Horseman, Knight). */
export const SCOUT = 6, SETTLER = 7;

// ------------------------------------------------------------------ holding.rs
export const WORKED_RADIUS = Object.freeze([1, 2, 2, 3]);             // holding.rs:73-80
export const QUEUE_SLOTS = Object.freeze([2, 3, 4, 4]);               // holding.rs:90-96
export const STORAGE_CAP = Object.freeze([2_000, 6_000, 15_000, 40_000].map(x => x * MILLI));   // holding.rs:98-105
export const DORMANT_AFTER = 5 * DAY;         // holding.rs:122
export const DORMANT_PRODUCTION_BPS = 5_000;  // holding.rs:126
export const SHIELD_SECS = 48 * HOUR, SHIELD_LATE_SECS = 72 * HOUR, SHIELD_LATE_FROM_DAY = 7;   // holding.rs:128-131
export const MAX_DUPLICATES = 64;             // holding.rs:136
export const MAX_WALLS = 1_200;               // holding.rs:143
export const MAX_PRODUCTION_PER_HOUR = 1_000 * MILLI;   // holding.rs:149
/** Queue record kinds as the program stores them (prog/holding.rs:14-16). */
export const QK = Object.freeze({ FREE: 0, PRODUCTION: 1, UPKEEP: 2, TIER_UP: 3, WALLS: 4 });
/** `duplicate_cost(base, n)`: the n-th copy costs base × (1 + 0.5 (n − 1)²) (holding.rs:161-171). */
export const duplicateCost = (base, n) => (n > MAX_DUPLICATES ? null : Math.floor((base * (2 + (n - 1) * (n - 1))) / 2));
export const shieldSecs = day => (day > SHIELD_LATE_FROM_DAY ? SHIELD_LATE_SECS : SHIELD_SECS);   // holding.rs:174-180

/** `Accrual::settle(t)` (holding.rs:228-250): the gain is ⌊(frac + rate × Δt) / 3,600⌋, the remainder is carried, a positive rate stops at the cap. */
export function settleAccrual(a, t) {
  if (t <= a.t0) return 0;
  const num = a.frac + a.rate * (t - a.t0);
  const gain = Math.floor(num / HOUR);
  a.frac = num - gain * HOUR;
  a.t0 = t;
  const v = a.value + gain;
  let short = 0;
  if (a.rate >= 0) { if (a.value < a.cap) a.value = Math.min(v, a.cap); }
  else if (v < 0) { short = -v; a.value = 0; }
  else a.value = v;
  return short;
}
export const accrualAt = (a, t) => { const b = { ...a }; settleAccrual(b, t); return b.value; };

const settleStores = (h, t) => { h.stores.forEach((s, i) => { const short = settleAccrual(s, t); if (i === RES.Food) h.foodShortfall += short; }); };
/** `Holding::apply_rates(t)` (holding.rs:363-369): production (halved while dormant) minus upkeep, from t on. */
function applyRates(h, t) {
  const dormant = t >= h.lastOwnerAction + DORMANT_AFTER;
  for (let r = 0; r < RESOURCES; r++) {
    const prod = Math.max(0, Math.min(MAX_PRODUCTION_PER_HOUR, h.production[r]));
    const p = dormant ? Math.floor((prod * DORMANT_PRODUCTION_BPS) / 10_000) : prod;
    settleAccrual(h.stores[r], t);
    h.stores[r].rate = p - Math.max(0, h.upkeep[r]);
  }
}
/** `Holding::apply(t, effect)` (holding.rs:371-396). */
function applyEffect(h, t, q) {
  if (q.kind === QK.PRODUCTION) h.production[q.arg] = Math.max(0, Math.min(MAX_PRODUCTION_PER_HOUR, h.production[q.arg] + q.delta));
  else if (q.kind === QK.UPKEEP) h.upkeep[q.arg] = Math.max(0, h.upkeep[q.arg] + q.delta);
  else if (q.kind === QK.TIER_UP && h.tier < 3) { h.tier += 1; for (const s of h.stores) { settleAccrual(s, t); s.cap = STORAGE_CAP[h.tier]; } }
}
/**
 * `Holding::settle(now)` (holding.rs:531-572): every store to `now`, queue completions (not the walls: they wait
 * for `commitWalls`) and the start of dormancy applied at their own times, in time order.
 */
export function settleHolding(h, now) {
  for (;;) {
    const t = h.stores[0].t0;
    let next = null;
    h.queue.forEach((q, i) => { if (q && q.kind !== QK.WALLS && q.doneAt <= now && (next === null || q.doneAt < next.t)) next = { t: Math.max(q.doneAt, t), i }; });
    const dorm = h.lastOwnerAction + DORMANT_AFTER, dormDue = dorm > t && dorm <= now;
    if (next && (!dormDue || next.t <= dorm)) {
      settleStores(h, next.t);
      const item = h.queue[next.i];
      h.queue[next.i] = null;
      applyEffect(h, next.t, item);
      applyRates(h, next.t);
    } else if (dormDue) { settleStores(h, dorm); applyRates(h, dorm); } else break;
  }
  settleStores(h, now);
}
/**
 * The program's holding touch (prog/holding.rs:381-430 `settle_tiered`, `touch`): the settle split at each finished
 * tier-up so the new tier's base production starts when the tier does; `touch_owner(now)`; `commit_walls(now)`.
 */
export function touchHolding(h, now) {
  for (;;) {
    const ups = h.queue.filter(q => q && q.kind === QK.TIER_UP && q.doneAt <= now).map(q => q.doneAt);
    if (!ups.length) break;
    const t = Math.max(Math.min(...ups), h.stores[0].t0), old = h.tier;
    settleHolding(h, t);
    if (h.tier === old) break;
    const a = baseProduction(old), b = baseProduction(h.tier);
    for (let r = 0; r < RESOURCES; r++) h.production[r] += b[r] - a[r];
    applyRates(h, t);
  }
  settleHolding(h, now);
  h.lastOwnerAction = now;           // touch_owner (holding.rs:576-581)
  applyRates(h, now);
  // commit_walls(now) (holding.rs:511-529): finished Walls items leave the queue
  if (now > h.wallsCommittedBefore) {
    h.queue.forEach((q, i) => { if (q && q.kind === QK.WALLS && q.doneAt < now) { h.walls = Math.min(MAX_WALLS, h.walls + q.delta); h.queue[i] = null; } });
    h.wallsCommittedBefore = now;
  }
}
/** `Holding::pay` (holding.rs:622-632): all of the cost or nothing. */
export function pay(h, cost) {
  if (cost.some((c, r) => c < 0 || h.stores[r].value < c)) return false;
  cost.forEach((c, r) => { h.stores[r].value -= c; });
  return true;
}
/**
 * `Holding::enqueue` (holding.rs:588-619): `{doneAt}` or `{error: 'QueueFull' | 'TopTier' | 'AboveCap'}`. The item
 * starts when the last queued one ends (a serial queue); the slots are the tier's.
 */
export function enqueue(h, now, secs, item) {
  if (h.queue.filter(Boolean).length >= QUEUE_SLOTS[h.tier]) return { error: 'QueueFull' };
  if (item.kind === QK.TIER_UP && h.tier >= 3) return { error: 'TopTier' };
  // projected_after (holding.rs:440-482): walls and each production with every queued item and this one
  const prod = h.production.map(p => Math.max(0, p));
  let walls = h.walls;
  for (const q of [...h.queue.filter(Boolean), item]) {
    if (q.kind === QK.PRODUCTION) prod[q.arg] += Math.max(0, q.delta);
    else if (q.kind === QK.WALLS) walls += q.delta;
  }
  if (walls > MAX_WALLS || prod.some(p => p > MAX_PRODUCTION_PER_HOUR)) return { error: 'AboveCap' };
  const start = Math.max(now, ...h.queue.filter(Boolean).map(q => q.doneAt));
  const slot = h.queue.findIndex(q => !q);
  if (slot < 0) return { error: 'QueueFull' };
  h.queue[slot] = { ...item, doneAt: start + Math.max(0, secs) };
  return { doneAt: h.queue[slot].doneAt, slot };
}
/** The copy number the next Build of `item` (0–5) makes (prog/holding.rs:432-451): built + queued + 1. */
export function copyNumber(h, item) {
  const bd = BUILDINGS[item], per = bd.perHour * MILLI;
  const built = Math.floor(Math.max(0, h.production[bd.resource] - baseProduction(h.tier)[bd.resource]) / per);
  return built + h.queue.filter(q => q && q.kind === QK.PRODUCTION && q.arg === bd.resource).length + 1;
}
/**
 * `catalog::building(item, n, doctrine)` and `tier_up_item(tier)` (catalog.rs:186-221): `{cost (milli), item, secs}`
 * of Build `item` for holding `h` of `faction`, or `{error}` as the program answers it (prog/holding.rs:568-600).
 */
export function buildOrder(h, item, faction) {
  if (!(Number.isInteger(item) && item >= 0 && item <= ITEM_TIER_UP)) return { error: 'BadData' };
  if (item === ITEM_TIER_UP) {
    if (h.queue.some(q => q && q.kind === QK.TIER_UP)) return { error: 'QueueFull' };   // one tier-up at a time
    const up = TIER_UP[h.tier];
    if (!up) return { error: 'Kernel', sub: 'HoldingError::TopTier' };
    return { cost: up.cost.map(x => x * MILLI), item: { kind: QK.TIER_UP, arg: 0, delta: 0 }, secs: up.secs };
  }
  if (item === ITEM_WALLS) {
    const cost = new Array(RESOURCES).fill(0);
    cost[RES.Stone] = Math.floor((WALL_COST_STONE * DOCTRINES[faction].wallCostBps) / 10_000) * MILLI;
    return { cost, item: { kind: QK.WALLS, arg: 0, delta: WALL_STEP }, secs: WALL_SECS };
  }
  const n = copyNumber(h, item), bd = BUILDINGS[item];
  const cost = bd.cost.map(c => duplicateCost(c, n));
  if (cost.some(c => c === null)) return { error: 'BadData' };
  return { cost: cost.map(c => c * MILLI), item: { kind: QK.PRODUCTION, arg: bd.resource, delta: bd.perHour * MILLI }, secs: buildSecs(n), n };
}
/** `catalog::train(unit, n)` (catalog.rs:245-262): milli-cost per started hundred, or null (n = 0, the Settler, an unknown unit). */
export function trainCost(unit, n) {
  if (!(Number.isInteger(unit) && unit >= 0 && unit <= SCOUT) || !(Number.isInteger(n) && n > 0)) return null;
  const pc = UNIT_PROD_COST[unit], k = Math.ceil(n / 100), c = new Array(RESOURCES).fill(0);
  c[RES.Food] = k * TROOP_COST_PER_100[0] * MILLI;
  c[RES.Ore] = Math.floor((k * TROOP_COST_PER_100[1] * pc) / TROOP_COST_BASE_PROD) * MILLI;
  c[RES.Gold] = Math.floor((k * TROOP_COST_PER_100[2] * pc) / TROOP_COST_BASE_PROD) * MILLI;
  return c;
}
/** A holding as `citizen.rs` founds it (prog/citizen.rs:733-745): a hamlet at its base production with the starter kit. */
export function foundHolding(now, day) {
  const production = baseProduction(0);
  return { tier: 0, order: 1, foundedTs: now, foundedDay: day, lastOwnerAction: now,
    stores: STARTER_KIT.map((v, r) => ({ value: v * MILLI, rate: production[r], cap: STORAGE_CAP[0], t0: now, frac: 0 })),
    production, upkeep: new Array(RESOURCES).fill(0), queue: [null, null, null, null], walls: 0, wallsCommittedBefore: 0, foodShortfall: 0 };
}

// ------------------------------------------------------------------ host.rs, travel.rs
export const MAX_HOST_TROOPS = 30_000 * MILLI, MIN_HOST_TROOPS = 100 * MILLI, DESTROYED_BELOW = 500;   // host.rs:27-31
export const STAMINA_CAP = 120;               // host.rs:32
export const ENGAGE_STAMINA = 20;             // host.rs:35
export const BATTLE_COOLDOWN_BELLS = 1;       // host.rs:37
export const PROVINCE_HOST_CAP = 48, FACTION_RESIDENT_CAP = 8, TRANSIT_SLOTS = 4, STORAGE = 56;   // host.rs:42-44; clash Occupancy::STORAGE
export const ROUT_LOSS_BPS = 5_000;           // host.rs:47
export const MAX_PATH_STEPS = 32, MAX_PATH_PROVINCES = 4, MAX_ARRIVAL_LEAD_BELLS = 72, MIN_ARRIVAL_LEAD_BELLS = 2;   // travel.rs:46-49,173
/** `travel::march_stamina(hexes)` (travel.rs:207-214); Depart charges the 32-step march whatever the sealed path (prog/host.rs:563). */
export const marchStamina = hexes => 10 + 2 * hexes;
export const DEPART_STAMINA = marchStamina(MAX_PATH_STEPS);
/** `Stamina::at(b)` (host.rs:86-97): +1 per bell, capped. */
export const staminaAt = (value, bell, b) => (b <= bell ? value : Math.min(STAMINA_CAP, value + (b - bell)));
/** `rout_survivors` (host.rs:577-579). */
export const routSurvivors = troops => Math.floor((troops * (10_000 - ROUT_LOSS_BPS)) / 10_000);
/** Resident actions at bell b need the province resolved through b − 2 (frontier-abi prologue.rs:1191). */
export const residentOk = (resolvedNext, b) => resolvedNext + 1 >= b;
/** Entry states and pending operations (frontier-abi layout/province.rs:123-134). */
export const ES = Object.freeze({ FREE: 0, ROSTER: 1, MUSTER_PENDING: 2, DEPARTED: 3 });
export const OP = Object.freeze({ NONE: 0, SPEND: 1, SPLIT: 2, ABSORB: 3, ABSORBED_INTO: 4, LEAVE: 5, FORFEIT: 6 });
/** Transit record states and flags (frontier-abi layout/player.rs:192-203). */
export const TS = Object.freeze({ FREE: 0, DEPARTED: 1, SETTLED: 2, DESTROYED_AT_ORIGIN: 3 });
export const TF = Object.freeze({ FEE: 1, BOND: 2, GATHERED: 4 });
/** Fates of an arrival record (frontier-abi layout/clash.rs:156-161) and TRANSIT_SETTLED outcomes (contract §6, kind 34). */
export const FATE = Object.freeze({ NONE: 0, STAYS: 1, WITHDREW: 2, BOUNCED: 3, RETREATED: 4, DESTROYED: 5 });
export const OUTCOME = Object.freeze({ STAYS: 0, WITHDREW: 1, BOUNCED: 2, RETREATED: 3, DESTROYED: 4, BOUNCED_UNRANKED: 5, ROUTED: 6, BAD_SEAL: 7 });

// ------------------------------------------------------------------ doctrine.rs (what the M1 program reads of it)
/**
 * By faction 0–5 (doctrine.rs:96-141): the multiplier of the unit variant, the drilled stance (Hold 0, Assault 1,
 * Flank 2, Brace 3) and its multiplier, the arrival bonus, the travel and wall-cost biases.
 */
export const DOCTRINES = Object.freeze([
  { variantBps: 10_000, drill: [3, 11_000], arrivalBps: 10_000, travelBps: 10_000, wallCostBps: 9_500 },
  { variantBps: 10_000, drill: null, arrivalBps: 10_000, travelBps: 10_000, wallCostBps: 10_000 },
  { variantBps: 10_000, drill: [1, 10_500], arrivalBps: 10_500, travelBps: 10_000, wallCostBps: 10_000 },
  { variantBps: 10_000, drill: [2, 10_500], arrivalBps: 10_000, travelBps: 10_000, wallCostBps: 10_000 },
  { variantBps: 10_000, drill: null, arrivalBps: 10_000, travelBps: 7_500, wallCostBps: 10_000 },
  { variantBps: 11_000, drill: null, arrivalBps: 10_000, travelBps: 10_000, wallCostBps: 10_000 },
].map(Object.freeze));
/** `Doctrine::dealt_bps(Stance(stance), arrival)` (doctrine.rs:197-210), each step rounded down as there. */
export function dealtBps(faction, arrival, stance = 0) {
  const d = DOCTRINES[faction];
  let m = d.variantBps;
  if (d.drill && d.drill[0] === stance) m = Math.floor((m * d.drill[1]) / 10_000);
  if (arrival) m = Math.floor((m * d.arrivalBps) / 10_000);
  return m;
}
export const travelSecs = (faction, secs) => Math.floor((secs * DOCTRINES[faction].travelBps) / 10_000);   // doctrine.rs:229-231

// ------------------------------------------------------------------ rng.rs, explore.rs, camp.rs
const le = (v, n) => { const b = new Uint8Array(n); let x = BigInt.asUintN(8 * n, BigInt(v)); for (let i = 0; i < n; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
/** `rand(seed, domain, id)` (rng.rs:21-27): the first 8 bytes (LE) of sha256(seed ‖ len(domain) ‖ domain ‖ id). */
export function rand(seed, domain, id) {
  const d = new TextEncoder().encode(domain), out = sha256(Uint8Array.from(seed), Uint8Array.of(d.length), d, Uint8Array.from(id));
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(out[i]);
  return x;
}
/** `camp::below(x, n)` (camp.rs:44-46): ⌊x · n / 2⁶⁴⌋. */
export const below = (x, n) => Number((x * BigInt(n)) >> 64n);
/** `explore::roll` (explore.rs:31-50): 4 Works on a floor exploration, else with chance one half. */
export function exploreRoll(seed, p, q, tile, host, floor) {
  if (floor) return WORKS_EXPLORE;
  const id = new Uint8Array(17);
  id.set(le(p, 4), 0); id.set(le(q, 4), 4); id[8] = tile; id.set(le(host, 8), 9);
  return below(rand(seed, 'frontier/explore', id), 2) === 0 ? WORKS_EXPLORE : 0;
}
const campDraw = (seed, domain, p, q, day, initial) => { const id = new Uint8Array(13); id.set(le(p, 4), 0); id.set(le(q, 4), 4); id.set(le(day, 4), 8); id[12] = initial ? 1 : 0; return rand(seed, domain, id); };
/**
 * `camp::place(seed, P, terrain, day, has_holding, initial = false)` (camp.rs:83-123): the daily respawn. A province
 * with a holding gets a camp with chance one half, on one of its passable tiles 1..61 that is not a site, with
 * 100 + (0..=300) troops. `passable(tile)`, `isSite(tile)`.
 */
export function campPlace(seed, p, q, { passable, isSite }, day, hasHolding) {
  if (!hasHolding) return null;
  if (below(campDraw(seed, 'frontier/camp/spawn', p, q, day, false), 2) !== 0) return null;
  const cands = [];
  for (let t = 1; t < PROVINCE_TILES; t++) if (passable(t) && !isSite(t)) cands.push(t);
  if (!cands.length) return null;
  return { tile: cands[below(campDraw(seed, 'frontier/camp/tile', p, q, day, false), cands.length)], troops: 100 + below(campDraw(seed, 'frontier/camp/troops', p, q, day, false), 301) };
}
/** The camp's seed: sha256("PSF-CAMP-v1" ‖ province[TERRAIN ..= SITE_COUNT]) (model: clash_model.rs:163,271-274). */
export const campSeed = block => sha256(new TextEncoder().encode('PSF-CAMP-v1'), block);

// ------------------------------------------------------------------ the action bucket (contract §5.6 step 3)
/** Refill `rate × Δt` (milli-tokens, cap `burst × 1,000`), then debit 1,000: false = `Bucket`. `c = {bucketMilli, bucketT}` (seconds). */
export function debitBucket(c, now, ratePerHour, burst) {
  const dt = Math.max(0, now - c.bucketT);
  const v = Math.min(burst * 1000, c.bucketMilli + Math.floor((ratePerHour * 1000 * dt) / HOUR));
  if (v < 1000) return false;
  c.bucketMilli = v - 1000;
  c.bucketT = now;
  return true;
}

// ------------------------------------------------------------------ the clash's write-back (model: clash_model.rs:759-1003)
/** `ready_bell_after(bell)` (clash.rs:737-739). */
export const readyBellAfter = bell => bell + 1 + BATTLE_COOLDOWN_BELLS;
export const CAMP_SITE = 0xff, NEUTRAL = 6;
/**
 * `clash_model::apply`: the kernel's outcome written into the Province `pv` (plain fields, as encoded), for the
 * kernel input `args` (the program's builder, here the page's own transcription of it: screens/report.mjs
 * `buildClashArgs`, kept only when the kernel's builder agrees) and the positions of the arrivals in the
 * ClashInputs. `camp`: the camp this clash saw (after the day's check). Returns the program's `Applied`:
 * `{fates, troopsAfter, campMask, campCleared, destroyed, bounced, changed}`.
 *
 * `withdrawalRestarts` is NOT the program's: it is the one change to existing code the banner rule's design asks of
 * the clash write-back (claims.mjs; CLAIM-RULE "existing_code_changes": from_bell reset on withdrawal), played only
 * by the sample world's labelled prototype. With it a resident that withdraws to another tile stands there from the
 * next turn (`fromBell = bell + 1`); without it (the program as built) its `fromBell` is left as it was.
 */
export function applyOutcome(pv, { bell, residents, arrivals, garrisons, arrPos, camp }, outcome, { withdrawalRestarts = false } = {}) {
  const ap = { fates: new Array(24).fill(0), troopsAfter: new Array(24).fill(0), campMask: 0, campCleared: false, destroyed: 0, bounced: 0, changed: false };
  const of = (id, arrival) => outcome.fighters.find(x => x.arrival === arrival && BigInt(x.id) === BigInt(id));
  const tileOf = f => (f.fate.kind === 'Stays' || f.fate.kind === 'Withdrew' ? f.fate.tile : null);
  for (const f of residents) {
    const fr = of(f.id, false), e = pv.entries.find(x => x && x.state === ES.ROSTER && BigInt(x.id) === BigInt(f.id));
    if (!fr || !e) throw new Error(`clash write-back: resident ${f.id}`);
    const tile = tileOf(fr);
    if (fr.fate.kind === 'Destroyed') {
      ap.destroyed++;
      if (![OP.SPEND, OP.LEAVE, OP.FORFEIT].includes(e.pendOp)) { clearEntry(e); ap.changed = true; continue; }
    } else if (fr.fate.kind === 'Bounced' || fr.fate.kind === 'Retreated') {
      ap.bounced++;
      if (e.pendOp === OP.NONE) { e.pendOp = OP.LEAVE; e.pendBell = bell; ap.changed = true; }
    }
    if (fr.troops === f.troops && fr.stamina === f.stamina && !fr.engaged && (tile === null || tile === e.tile)) continue;
    e.troops = fr.troops; e.staminaValue = Math.min(STAMINA_CAP, fr.stamina); e.staminaBell = bell;
    if (fr.engaged) e.readyBell = Math.max(e.readyBell, readyBellAfter(bell));
    if (tile !== null) { if (withdrawalRestarts && tile !== e.tile) e.fromBell = bell + 1; e.tile = tile; }
    ap.changed = true;
  }
  arrivals.forEach((f, n) => {
    const fr = of(f.id, true), k = arrPos[n];
    if (!fr) throw new Error(`clash write-back: arrival ${f.id}`);
    ap.fates[k] = FATE[fr.fate.kind.toUpperCase()];
    ap.troopsAfter[k] = fr.troops;
    if (fr.fate.kind === 'Destroyed') ap.destroyed++;
    else if (fr.fate.kind === 'Bounced' || fr.fate.kind === 'Retreated') ap.bounced++;
    else {
      const i = pv.entries.findIndex(x => !x || x.state === ES.FREE);
      if (i < 0) throw new Error('clash write-back: no free entry (the room of I-43 makes this unreachable)');
      pv.entries[i] = { id: BigInt(f.id), faction: f.faction, unit: f.unit, tile: fr.fate.tile, state: ES.ROSTER, troops: fr.troops, staminaValue: fr.stamina, dealtBps: dealtBps(f.faction, false),
        staminaBell: bell, readyBell: fr.engaged ? readyBellAfter(bell) : bell + 1, fromBell: bell + 1, pendBell: 0, pendOp: OP.NONE, opA: 0, opB: 0, opTroops: 0, opRef: 0 };
      ap.changed = true;
    }
  });
  for (const g of garrisons) {
    const gr = outcome.garrisons.find(x => BigInt(x.id) === BigInt(g.id));
    if (!gr) throw new Error(`clash write-back: garrison ${g.id}`);
    if (g.site === CAMP_SITE) {
      const whole = Math.floor(gr.troops / MILLI);
      if (whole === 0 || gr.attackersHold) {
        arrivals.forEach((f, n) => { const fr = of(f.id, true); if (fr.fate.kind === 'Stays' && fr.fate.tile === camp.tile && (gr.holders & (1 << f.faction))) ap.campMask |= 1 << arrPos[n]; });
        camp.state = 0; camp.troops = 0; ap.campCleared = true; ap.changed = true;
      } else if (whole !== camp.troops) { camp.troops = whole; ap.changed = true; }
      continue;
    }
    if (gr.troops !== g.troops) { pv.siteMirror[g.site].garrison = Math.min(MAX_HOST_TROOPS, gr.troops); ap.changed = true; }
  }
  pv.camp = { ...pv.camp, ...camp };
  return ap;
}
export function clearEntry(e) { for (const k of Object.keys(e)) e[k] = k === 'id' ? 0n : 0; }
/**
 * `clash_model::settle_bell(b)`: the pending changes of bell b, resolve and skip alike. Musters whose `from_bell ≤
 * b + 1` join the roster; a departure's stamina is paid at the effective bell and the entry is departed (state 3)
 * until SettleDeparture; a leave is departed with its operation kept until the return settle; a forfeit is freed;
 * garrison changes of bells ≤ b are added. True when anything changed.
 */
export function settleBell(pv, b) {
  let changed = false;
  for (const e of pv.entries) {
    if (!e || e.state === ES.FREE || e.state === ES.DEPARTED) continue;
    const due = e.pendOp !== OP.NONE && e.pendBell <= b;
    if (due && e.pendOp === OP.FORFEIT) { clearEntry(e); changed = true; continue; }
    if (e.state === ES.MUSTER_PENDING) { if (e.fromBell <= b + 1) { e.state = ES.ROSTER; changed = true; } continue; }
    if (!due) continue;
    if (e.pendOp === OP.LEAVE) e.state = ES.DEPARTED;
    else if (e.pendOp === OP.SPEND) {
      const eff = e.pendBell + 1;
      e.staminaValue = Math.max(0, staminaAt(e.staminaValue, e.staminaBell, eff) - e.opB);
      e.staminaBell = eff;
      e.pendBell = 0; e.pendOp = OP.NONE; e.opA = 0; e.opB = 0; e.opTroops = 0; e.opRef = 0;
      e.state = ES.DEPARTED;
    } else continue;   // splits and merges: no M1 instruction issues one
    changed = true;
  }
  for (const m of pv.siteMirror) {
    if (!m || m.state !== 1) continue;
    for (const k of [0, 1]) {
      const bell = m[`pend${k}Bell`], delta = Number(m[`pend${k}Delta`] ?? 0);
      if (bell === NO_BELL || bell > b || delta === 0) continue;
      m.garrison = Math.max(0, Math.min(MAX_HOST_TROOPS, m.garrison + delta));   // GarrisonState::settle (host.rs)
      m[`pend${k}Bell`] = NO_BELL; m[`pend${k}Delta`] = 0;
      changed = true;
    }
  }
  return changed;
}
/**
 * `clash_model::trivially_quiet(b)` (clash_model.rs:1088-1166), as far as the sample world needs it: no hex holds
 * fighters of two factions (the roster of bell b, the garrisons on their sites, the camp as a neutral garrison).
 */
export function triviallyQuiet(pv, b) {
  const at = new Map();
  const put = (tile, f) => { const s = at.get(tile) ?? new Set(); s.add(f); at.set(tile, s); };
  for (const e of pv.entries) if (e && e.state === ES.ROSTER && e.fromBell <= b) put(e.tile, e.faction);
  pv.siteMirror.forEach((m, s) => { if (m && m.state === 1 && s < pv.siteCount) put(pv.sites[s], m.faction); });
  if (pv.camp?.state === 1) put(pv.camp.tile, NEUTRAL);
  return [...at.values()].every(s => s.size === 1);
}
