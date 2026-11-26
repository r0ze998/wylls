// The numbers of the village's orders, as the rules give them (UX design
// 14.1, 14.2): what the NEXT copy of a building costs and how long it takes,
// how many things a village of each tier may have under way, what a
// promotion costs and gives, what training costs, what each unit is, and
// what the stores hold once the lazy settlement the program runs before
// every owner instruction is applied. The hand (hud/hand.mjs) and the
// village drawer (screens/holding.mjs) both read these, so a fan over the
// village and a row in the drawer can never disagree.
//
// Nothing here decides anything: the program does. Each table is pinned
// against its Rust definition by permutation-gateway/test/web-frontier-hand.test.mjs:
//
//   QUEUE_SLOTS, STORE_CAP, WORKED_RADIUS   permutation-rules/src/frontier/holding.rs  Tier::{queue_slots, storage_cap, worked_radius}
//   duplicateCost                           holding.rs  duplicate_cost: base × (2 + (n−1)²) / 2
//   buildSecs                               catalog.rs  build_secs(n) = 3,600 + 1,800 n  (n = the copy's number, from 1)
//   copyNumber                              permutation-frontier/src/proc/holding.rs  copy_number: built + queued + 1
//   TIER_UP, ITEM_TIER_UP                   catalog.rs  tier_up; proc/holding.rs ITEM_TIER_UP = ITEM_COUNT (7)
//   WALLS                                   catalog.rs  WALL_STEP, WALL_COST_STONE, WALL_SECS; holding.rs MAX_WALLS; doctrine.rs wall_cost_bps
//   TRAIN_PER_100, trainCost                catalog.rs  TROOP_COST_PER_100, TROOP_COST_BASE_PROD, train()
//   UNIT_STATS                              permutation-rules/src/units.rs  UNIT_STATS (class, strength, move, prod), counters()
//   COUNTER_BPS                             permutation-rules/src/combat.rs  COUNTER
//   settled                                 holding.rs  Holding::settle / apply; proc/holding.rs settle_tiered
import { BUILD_ITEMS, QUEUE_KIND, BASE_PROD, TIER_BONUS_PCT, baseProduction, queueItem, projectedHolding, buildItemOf, WORKSHOP } from '../fland.mjs';
import { TRAIN_ARMS_PER_100, seasonBase } from '../fs1.mjs';
import { RESOURCE_ORDER } from '../resources.mjs';

const HOUR = 3600;
export const TIER_MAX = 3;
/** Things a village may have under way at once, by tier (Hamlet … Stronghold). */
export const QUEUE_SLOTS = Object.freeze([2, 3, 4, 4]);
export const queueSlots = tier => QUEUE_SLOTS[Math.max(0, Math.min(TIER_MAX, Number(tier) || 0))];
/** What one store holds at most, whole units, by tier. */
export const STORE_CAP = Object.freeze([2_000, 6_000, 15_000, 40_000]);
/** How far the village's worked land reaches, in tiles, by tier. */
export const WORKED_RADIUS = Object.freeze([1, 2, 2, 3]);
/** The Build item of a promotion to the next tier (the program's ITEM_TIER_UP). */
export const ITEM_TIER_UP = 7;
export const ITEM_WALLS = 6;
/** Copies of one building the catalog prices (catalog MAX_COPIES). */
export const MAX_COPIES = 64;

/** `duplicate_cost(base, n)`: the n-th copy costs base × (1 + (n−1)² / 2), rounded down. */
export const duplicateCost = (base, n) => Math.floor((Number(base) * (2 + (Math.max(1, n) - 1) ** 2)) / 2);
/** `build_secs(n)`: the n-th copy takes 60 + 30 n minutes (90 for the first). */
export const buildSecs = n => HOUR + 1_800 * Math.max(1, n);

/** Promotion to the next tier: cost by resource (whole units) and seconds; null at the top tier. */
export const TIER_UP = Object.freeze([
  Object.freeze({ cost: Object.freeze([0, 1_000, 600, 0, 0, 300, 0, 0]), secs: 6 * HOUR }),
  Object.freeze({ cost: Object.freeze([0, 4_000, 3_000, 0, 0, 1_500, 0, 0]), secs: 12 * HOUR }),
  Object.freeze({ cost: Object.freeze([0, 12_000, 10_000, 0, 0, 5_000, 0, 0]), secs: 24 * HOUR }),
  null,
]);

/** Walls: +100 wall points for 300 stone and four hours, to 1,200 at most; the first nation (Aster) pays 95%. */
export const WALLS = Object.freeze({ step: 100, stone: 300, secs: 4 * HOUR, max: 1_200, costBps: Object.freeze([9_500, 10_000, 10_000, 10_000, 10_000, 10_000]) });
export const wallStone = faction => Math.floor((WALLS.stone * (WALLS.costBps[faction] ?? 10_000)) / 10_000);

/** Training per started hundred of the Spearman's class: food, ore, gold; ore and gold scale with the unit's production cost over 6. */
export const TRAIN_PER_100 = Object.freeze({ food: 60, ore: 20, gold: 10, baseProd: 6 });
/** Units in kernel order: class, strength per troop, move, production cost (units.rs UNIT_STATS). */
export const UNIT_STATS = Object.freeze([
  { unit: 'Spearman', cls: 'Melee', strength: 10, move: 1, prod: 6 },
  { unit: 'Archer', cls: 'Ranged', strength: 10, move: 1, prod: 7 },
  { unit: 'Horseman', cls: 'Mounted', strength: 10, move: 2, prod: 9 },
  { unit: 'Pikeman', cls: 'Melee', strength: 22, move: 1, prod: 12 },
  { unit: 'Crossbowman', cls: 'Ranged', strength: 22, move: 1, prod: 14 },
  { unit: 'Knight', cls: 'Mounted', strength: 22, move: 2, prod: 16 },
  { unit: 'Scout', cls: 'Civilian', strength: 0, move: 3, prod: 10 },
  { unit: 'Settler', cls: 'Civilian', strength: 0, move: 1, prod: 30 },
].map(Object.freeze));
/** A class beats this class (units.rs counters: melee > mounted, ranged > melee, mounted > ranged), at COUNTER_BPS. */
export const BEATS = Object.freeze({ Melee: 'Mounted', Ranged: 'Melee', Mounted: 'Ranged' });
export const COUNTER_BPS = 15_000;
/** Troops a host holds: 100 to 30,000 (host.rs MIN_HOST_TROOPS, MAX_HOST_TROOPS). */
export const HOST_TROOPS = Object.freeze({ min: 100, max: 30_000 });
/** A village may have this many marches out at once (host.rs TRANSIT_SLOTS). */
export const TRANSIT_SLOTS = 4;

/** What training `n` troops of unit `unit` costs, by resource in kernel order (whole units); null for nothing or a unit that does not train. */
export function trainCost(unit, n, programVersion = 1) {
  const st = UNIT_STATS[unit];
  if (!st || unit > 6 || !(n > 0)) return null;
  const k = Math.ceil(n / 100);
  const prod = Number(programVersion) >= 3 && unit === 2 ? 6 : st.prod;
  const c = [0, 0, 0, 0, 0, 0, 0, 0];
  c[0] = TRAIN_PER_100.food * k;
  c[3] = Math.floor((TRAIN_PER_100.ore * k * prod) / TRAIN_PER_100.baseProd);
  c[5] = Math.floor((TRAIN_PER_100.gold * k * prod) / TRAIN_PER_100.baseProd);
  // S1 (program_version 4): the strong units also cost arms (arms.rs train_v3).
  if (Number(programVersion) >= 4) c[4] = (TRAIN_ARMS_PER_100[unit] ?? 0) * k;
  return c;
}
/** The most troops of `unit` the stores `have` (by resource index, whole units) pay for, in hundreds. */
export function maxTrain(unit, have, programVersion = 1) {
  let lo = 0, hi = 300;   // 30,000 at most is asked for at once (a host's size)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2), c = trainCost(unit, mid * 100, programVersion);
    if (c && c.every((x, i) => x <= (have[i] ?? 0))) lo = mid; else hi = mid - 1;
  }
  return lo * 100;
}
/** What of `cost` the stores `have` lack: `[{r (resource index), need}]`. */
export const shortOf = (cost, have) => (cost ?? []).map((c, r) => ({ r, need: c - (have[r] ?? 0) })).filter(x => x.need > 0);

// ------------------------------------------------------------------ the stores as the next instruction will find them
const big = x => { try { return BigInt(x ?? 0); } catch { return 0n; } };
/**
 * The holding as the program's next owner instruction will find it at `now` (every instruction settles first: the
 * stores accrue, and each queued building that is done raises its production from the moment it was done; a
 * promotion that is done raises the tier, the caps and the base production). The page showed the stores at the old
 * rate until an instruction happened to land, so a finished building "paid nothing until harvest was pressed".
 * Returns the shared read-only projection, including completed production, upkeep, tier and dormancy changes.
 */
export function settled(holding, now) {
  if (!holding?.stores?.length) return holding;
  return { ...projectedHolding(holding, now), settledAt: now };
}

// ------------------------------------------------------------------ building
/**
 * B19 (loop-play3): whether the village has been used at all — something built or queued (a building, the walls, a
 * promotion), troops trained (a reserve), a host ever formed (`hostSeq`) or a march under way. The first-village
 * welcome card is for a village nothing has been done with: in local play its "seen" note lives in the page's memory
 * only, so a reload or `--resume` forgot it and welcomed the player to a village that already had a farm and a host.
 */
export function villageInUse(h) {
  if (!h) return false;
  if (Number(h.hostSeq ?? 0) > 0 || Number(h.walls ?? 0) > 0 || Number(h.tier ?? 0) > 0) return true;
  if ((h.reserve ?? []).some(n => Number(n) > 0)) return true;
  if ((h.queue ?? []).some(q => q && Number(q.doneAt ?? 0) > 0)) return true;
  if ((h.transit ?? []).some(t => t && Number(t.state ?? 0) !== 0)) return true;
  // (loop-play7: on S1 a mine is told from the ore above the village's TERRAIN ore. While the terrain is not read yet
  //  (seasonBase null), copyNumber falls back to the tier's base and counted a fresh village with terrain ore (+30/h)
  //  as holding several mines: the first-village welcome card never stood. A resource whose base is unknown is skipped.)
  try {
    const tier = Number(h.tier ?? 0), base = seasonBase(baseProduction(tier), h, { bonusPct: TIER_BONUS_PCT[tier] ?? 0 });
    return BUILD_ITEMS.some(b => b.cost && base[RESOURCE_ORDER.indexOf(b.resource)] !== null && copyNumber(h, b.item) > 1);
  } catch { return false; }
}

/** The number of the copy the next Build of `item` (0–5) makes: built (production above the tier's base) + queued + 1. */
export function copyNumber(h, item) {
  const b = buildItemOf(item);
  if (!b || !(b.perHour > 0)) return 1;
  const r = RESOURCE_ORDER.indexOf(b.resource);
  // (on S1 the ore base is the village's terrain ore, fs1.mjs seasonBase: its mines over it, not the terrain's own ore;
  // while the terrain is not known the tier's base is used, as before)
  const tier = Number(h.tier ?? 0), base = seasonBase(baseProduction(tier), h, { bonusPct: TIER_BONUS_PCT[tier] ?? 0 })[r] ?? baseProduction(tier)[r] ?? 0n;
  const have = h.production?.[r] !== undefined ? big(h.production[r]) : base;
  const above = have > base ? have - base : 0n;
  const built = Number(above / BigInt(b.perHour * 1000));
  const queued = (h.queue ?? []).filter(q => Number(q.doneAt) > 0 && queueItem(q) === item).length;
  return built + queued + 1;
}

// Walls remain in the queue at their exact completion second; commit_walls
// releases them strictly afterward, unlike production and tier-up settlement.
const isQueuedAt = (q, now) => !!q && Number(q.doneAt) > 0 && (q.kind === QUEUE_KIND.WALLS ? Number(q.doneAt) >= now : Number(q.doneAt) > now);

/** What is under way: `[{q, item (0–6 or 7 for a promotion, null otherwise), doneAt, startAt, secs, doneIn, share}]`, in order. The queue is serial: each starts when the one before it ends. */
export function queueNow(h, now) {
  const items = (h?.queue ?? []).filter(q => isQueuedAt(q, now)).sort((a, b) => Number(a.doneAt) - Number(b.doneAt));
  let prev = null;
  return items.map(q => {
    const doneAt = Number(q.doneAt);
    const item = q.kind === QUEUE_KIND.TIER_UP ? ITEM_TIER_UP : queueItem(q);
    // (the record keeps only when it is done; the start is the end of the one before it, or cannot be known for the first)
    const startAt = prev;
    prev = doneAt;
    const secs = startAt !== null ? doneAt - startAt : null;
    const running = startAt === null || startAt <= now;
    return { q, item, doneAt, startAt, secs, doneIn: doneAt - now, running, share: secs && running ? Math.max(0, Math.min(1, 1 - (doneAt - now) / secs)) : null };
  });
}

/** When an order placed at `now` would be done: after everything queued, `secs` later. */
export const doneAfterQueue = (h, now, secs) => Math.max(now, ...(h?.queue ?? []).map(q => Number(q.doneAt) || 0)) + secs;

/**
 * Everything the village may order built now, with the program's numbers for the NEXT copy: `[{item, kind:
 * 'building' | 'walls' | 'promotion', resource, perHour, n, cost (by resource, whole units), secs, doneIn (seconds
 * until it would be done, after what is queued), short: [{r, need}], blocks: [code]}]`. `h` should be the settled
 * holding; `have` its stores in whole units by resource index. Codes: QueueFull (the tier's slots are taken; one
 * promotion at a time), Insufficient, AboveCap (walls at their most), TopTier.
 */
export function buildOffers(h, { now = 0, have = [], faction = 0, walls = null, s1 = false, mirror = null, resolvedNext = null, workshop = true } = {}) {
  const slots = queueSlots(h.tier);
  const under = (h.queue ?? []).filter(q => isQueuedAt(q, now));
  const full = under.length >= slots;
  const offer = (o, extra = []) => {
    const short = shortOf(o.cost, have);
    return { ...o, short, doneIn: doneAfterQueue(h, now, o.secs) - now, blocks: [...(full ? ['QueueFull'] : []), ...extra, ...(short.length ? ['Insufficient'] : [])] };
  };
  // S1: the workshop (item 8) after the six buildings — where the place the order goes takes it (`workshop`; fix-loop9,
  // LP9-3: a plain local world's relay takes Build items 0-7 only, so the page offered a workshop it could never send)
  const items = s1 && workshop ? [...BUILD_ITEMS, WORKSHOP] : BUILD_ITEMS;
  const out = items.filter(b => b.cost).map(b => {
    const n = copyNumber(h, b.item);
    // (fix-loop14, LP14-6: the program gives the 60-second first build only to the six production buildings — items
    //  below the walls, proc/holding.rs `intro = x.item < catalog::ITEM_WALLS && FLAG_INTRO_BUILD_AVAILABLE` —, and a
    //  workshop (item 8) neither gets it nor uses it up. The page stamped the workshop row "1:00 First building" too:
    //  built first it took its full time, about 90 minutes of the chain's clock)
    const intro = b.item < ITEM_WALLS && !!(Number(h.flags ?? 0) & 2);
    return offer({ item: b.item, kind: 'building', resource: b.resource, perHour: b.perHour, n, cost: b.cost.map(c => duplicateCost(c, n)), intro, secs: intro ? 60 : buildSecs(n) }, n > MAX_COPIES ? ['AboveCap'] : []);
  });
  const stone = [0, 0, wallStone(faction), 0, 0, 0, 0, 0];
  const wallsNow = Number(walls ?? h.walls ?? 0) + under.filter(q => q.kind === QUEUE_KIND.WALLS).reduce((n, q) => n + Number(q.delta ?? WALLS.step), 0);
  // (2026-11-16: the program also writes each walls order into one of the TWO wall items of the village's site in its
  //  province, and answers QueueFull when both still wait for their turn — proc/holding.rs wall_item: an item is free
  //  once its turn (effective bell) is ≤ the province's resolved_next. The page offered a third and only the send
  //  was refused. `mirror` is the village's site mirror, `resolvedNext` its province's.)
  const wallBlocks = [...(wallsNow + WALLS.step > WALLS.max ? ['AboveCap'] : []), ...(wallItemsBusy(mirror, resolvedNext) ? ['WallsBusy'] : [])];
  out.push(offer({ item: ITEM_WALLS, kind: 'walls', resource: 'Walls', perHour: 0, n: Math.floor(wallsNow / WALLS.step) + 1, cost: stone, secs: WALLS.secs, walls: wallsNow }, wallBlocks));
  return out;
}

/**
 * proc/holding.rs `wall_item`: both wall items of the site mirror still wait for their turn (delta > 0 and effective
 * bell > the province's `resolved_next`), so a walls order has no item to write and the program answers QueueFull.
 * False without a mirror (nothing to read: the program decides).
 */
export function wallItemsBusy(mirror, resolvedNext) {
  if (!mirror) return false;
  const rn = Number(resolvedNext);
  return [[mirror.wallItem0Bell, mirror.wallItem0Delta], [mirror.wallItem1Bell, mirror.wallItem1Delta]].every(([b, d]) => Number(d) > 0 && !(Number(b) <= rn));
}

/**
 * The promotion to the next tier, or null at the top: `{item: 7, kind: 'promotion', from, to, cost, secs, doneIn,
 * short, blocks, gives: {prodPct: [from, to], cap: [from, to], slots: [from, to], radius: [from, to], base: [per
 * hour by resource at the next tier]}}`. One promotion may be under way at a time (the program answers QueueFull).
 */
export function promotionOffer(h, { now = 0, have = [] } = {}) {
  const tier = Number(h.tier ?? 0), up = TIER_UP[tier];
  if (!up) return null;
  const under = (h.queue ?? []).filter(q => isQueuedAt(q, now));
  const running = under.find(q => q.kind === QUEUE_KIND.TIER_UP) ?? null;
  const short = shortOf(up.cost, have);
  const blocks = [...(running ? ['Promoting'] : under.length >= queueSlots(tier) ? ['QueueFull'] : []), ...(short.length ? ['Insufficient'] : [])];
  return { item: ITEM_TIER_UP, kind: 'promotion', from: tier, to: tier + 1, cost: [...up.cost], secs: up.secs, doneIn: running ? Number(running.doneAt) - now : doneAfterQueue(h, now, up.secs) - now, running: !!running, short, blocks,
    gives: { prodPct: [TIER_BONUS_PCT[tier], TIER_BONUS_PCT[tier + 1]], cap: [STORE_CAP[tier], STORE_CAP[tier + 1]], slots: [QUEUE_SLOTS[tier], QUEUE_SLOTS[tier + 1]], radius: [WORKED_RADIUS[tier], WORKED_RADIUS[tier + 1]],
      base: BASE_PROD.map(b => Math.floor((b * (100 + TIER_BONUS_PCT[tier + 1])) / 100) - Math.floor((b * (100 + TIER_BONUS_PCT[tier])) / 100)) } };
}

// ------------------------------------------------------------------ a march on a keep: the turn it arrives
// The first clash decides whether a march stays on a keep's tile: the arrival attacks, the keep's garrison defends
// (walls on) and strikes back, both from the counts before the turn, and the side with more strength left holds the
// tile (a tie goes to the side that was already there: the keep). The numbers are combat.rs's: damage to B =
// n_A · str_A · k / str_B · 1,000 / F[n] · mods · roll, n = (n_A + n_B) whole troops clamped to 1–64, k 0.55, each
// side's roll 0.90–1.10; the attack × WALLS (and × TERRAIN on a forest or hills tile), the garrison's blow ×
// CITY_RETALIATION; a keep fights as a city: strength 10, no class (clash.rs `keep::garrison`, `resolve_engagement`).
// Left out: other hosts on the tile, a stance edge (a keep stands in Hold, which no stance beats), the attacking
// nation's doctrine drill (×1.05–1.10 in its own stance; this errs on the keep's side) and, on an S1 season, the wear
// of enemy watchtowers on the road (1% a minute in range, at most 30%: structure.rs; this errs on the host's side,
// and the keep list says so).
/** combat.rs F[n] = round(n^0.2 × 1,000), n = 0…64. */
const CLASH_F = Object.freeze([
  0, 1000, 1149, 1246, 1320, 1380, 1431, 1476, 1516, 1552, 1585, 1615, 1644, 1670, 1695, 1719,
  1741, 1762, 1783, 1802, 1821, 1838, 1856, 1872, 1888, 1904, 1919, 1933, 1947, 1961, 1974, 1987,
  2000, 2012, 2024, 2036, 2048, 2059, 2070, 2081, 2091, 2102, 2112, 2122, 2132, 2141, 2151, 2160,
  2169, 2178, 2187, 2195, 2204, 2212, 2221, 2229, 2237, 2245, 2253, 2260, 2268, 2275, 2283, 2290,
  2297,
]);
/** combat.rs / params.rs: k, and the modifiers the arrival on a keep meets (bps). */
// (fix-loop22: `exhausted` — combat.rs ATTACKER_EXHAUSTED, an arrival under ENGAGE_STAMINA 20 strikes at 85 %)
export const CLASH_BPS = Object.freeze({ k: 5_500, walls: 6_667, cityRetaliation: 5_000, terrain: 8_000, exhausted: 8_500, rollLow: 9_000, rollHigh: 11_000 });
const CITY_STRENGTH = 10;

/** combat.rs `damage` in milli-troops (`nA`, `nB` milli-troops; `mods` bps, applied in order). */
function clashDamage(nA, strA, nB, strB, mods, roll) {
  if (!nA || !strA || !strB) return 0;
  const n = Math.min(64, Math.max(1, Math.floor((nA + nB) / 1000)));
  let x = Math.floor(Math.floor((nA * strA * CLASH_BPS.k) / 10_000) / strB);
  x = Math.floor((x * 1000) / CLASH_F[n]);
  for (const m of mods) x = Math.floor((x * m) / 10_000);
  return Math.floor((x * roll) / 10_000);
}

/** One arrival turn of `troops` (whole) of `unit` on a keep of `keepTroops` (whole): what is left of each side and whether the host holds the tile, at the given rolls. */
function arrivalTurn(unit, troops, keepTroops, rough, rollHost, rollKeep, walls = true, tired = false) {
  const str = UNIT_STATS[unit]?.strength ?? 0;
  const a = troops * 1000, g = keepTroops * 1000;
  // (pt-first-battle: a barbarian camp is the same kind of garrison — clash.rs `Combatant::City`, strength 10, retaliation
  //  ×0.5 — standing without walls: clash_model's camp garrison has `walls: false`)
  // (fix-loop22: combat.rs pushes the attack's modifiers in this order — terrain, exhausted, then walls)
  const mods = [...(rough ? [CLASH_BPS.terrain] : []), ...(tired ? [CLASH_BPS.exhausted] : []), ...(walls ? [CLASH_BPS.walls] : [])];
  const toKeep = clashDamage(a, str, g, CITY_STRENGTH, mods, rollHost);
  const toHost = clashDamage(g, CITY_STRENGTH, a, str, [CLASH_BPS.cityRetaliation], rollKeep);
  const hostLeft = Math.max(0, a - toHost), keepLeft = Math.max(0, g - toKeep);
  return { hostLeft: Math.floor(hostLeft / 1000), keepLeft: Math.floor(keepLeft / 1000), holds: hostLeft >= 500 && hostLeft * str > keepLeft * CITY_STRENGTH };
}

/**
 * The arrival of a march on a keep, as the rules resolve its first turn (above): `{odds, worst, best, need}` —
 * `worst` / `best` the turn at the luck that favours the keep / the host (`{hostLeft, keepLeft, holds}`, whole
 * troops); `odds` 'good' (it holds the tile even at the worst luck), 'even' (only with luck), 'poor' (not even at
 * the best); `need` the fewest troops of the unit, in hundreds, that hold the tile at the worst luck (null for a
 * unit that does not fight, or above a host's 30,000). `rough`: the keep's tile is forest or hills.
 */
export function keepArrival({ unit, troops, keepTroops, rough = true, tired = false }) {
  const str = UNIT_STATS[unit]?.strength ?? 0;
  if (!(str > 0) || !(troops > 0) || !(keepTroops >= 0)) return { odds: 'poor', worst: null, best: null, need: null };
  // (fix-loop22, LP22-4: `tired` — the host arrives under ENGAGE_STAMINA and strikes exhausted, as the chain resolves it)
  const worst = arrivalTurn(unit, troops, keepTroops, rough, CLASH_BPS.rollLow, CLASH_BPS.rollHigh, true, tired);
  const best = arrivalTurn(unit, troops, keepTroops, rough, CLASH_BPS.rollHigh, CLASH_BPS.rollLow, true, tired);
  let need = null;
  for (let n = HOST_TROOPS.min; n <= HOST_TROOPS.max; n += 100) {
    if (arrivalTurn(unit, n, keepTroops, rough, CLASH_BPS.rollLow, CLASH_BPS.rollHigh, true, tired).holds) { need = n; break; }
  }
  return { odds: worst.holds ? 'good' : best.holds ? 'even' : 'poor', worst, best, need };
}

/**
 * (pt-first-battle, owner 2026-11-26 15:48 Q-PT-2) The arrival of a march on a barbarian camp, as the rules resolve
 * its first turn: the keep's estimate without walls (the camp is a city-kind garrison with no walls). Same answer shape
 * as `keepArrival`. A guide only: the march card's forecast is the rules' own run (hud/forecast.mjs).
 */
export function campArrival({ unit, troops, campTroops, rough = false }) {
  const str = UNIT_STATS[unit]?.strength ?? 0;
  if (!(str > 0) || !(troops > 0) || !(campTroops >= 0)) return { odds: 'poor', worst: null, best: null, need: null };
  const worst = arrivalTurn(unit, troops, campTroops, rough, CLASH_BPS.rollLow, CLASH_BPS.rollHigh, false);
  const best = arrivalTurn(unit, troops, campTroops, rough, CLASH_BPS.rollHigh, CLASH_BPS.rollLow, false);
  let need = null;
  for (let n = HOST_TROOPS.min; n <= HOST_TROOPS.max; n += 100) {
    if (arrivalTurn(unit, n, campTroops, rough, CLASH_BPS.rollLow, CLASH_BPS.rollHigh, false).holds) { need = n; break; }
  }
  return { odds: worst.holds ? 'good' : best.holds ? 'even' : 'poor', worst, best, need };
}

/** A tile counts as rough for the defender (forest, hills: map.rs defense_bps below 10,000). */
export const ROUGH_TERRAIN = Object.freeze(new Set(['Forest', 'Hills']));

/** What has grown in each store since the holding was last settled on chain (whole units by resource index): what a Harvest writes down. */
export function grownSince(holding, now) {
  const s = settled(holding, now);
  return (holding?.stores ?? []).map((a, i) => Number((s.stores[i].value - big(a.value)) / 1000n));
}
