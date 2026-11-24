// ⑬'s resident brain on a LOCAL-PLAY TEST world (2026-11-22, reports/playable-2-3-4-13.md §2 step 2). KEY-FREE and pure.
//
// The resident's own goals (goals.mjs GOALS: growth / use weights, plan depth, reserve, patience), its own limits
// (resident.mjs DEFAULT_LIMITS: the shortest gap between decisions, the idle back-off, the allowance of decisions,
// the day's actions, the doubling hold after a failed action) and its own memory (journal.mjs) are mapped onto the
// six orders a person's page has in local play — Join, PlaceHome, Harvest, Build, Train, Muster — and, in a local
// wide-land world only, the page's rim first-village request (FileTicket, WIDE_HOME_ORDER) and the wide land's own orders (wide.mjs: WideClaim, WideTrain/WideMuster/WideDepart, the Expedition); onto nothing else. What it reads is what the page reads about ITS OWN village (the public herald, observe.mjs); the numbers it
// plans with are the page's own (hud/rulebook.mjs buildOffers, trainCost, maxTrain; fland.mjs storesAt), never the
// test world's (world/rules.mjs). A choice is only a request: the relay and the program refuse it exactly as they
// refuse a person's.
//
//   candidates   every order the resident could ask for now, each with `held` reasons when it cannot be chosen
//                (said, never guessed: an unread number is a held candidate, not a zero)
//   decide       the no-charge local rule (no model, no network, nothing billed). An injected provider goes through
//                ⑬'s own boundary (live/decide.mjs decideLive: it must state charges:false, answer one offered, not
//                held candidate id, else the answer is `wait`).
//
// Joining: the ⑤B newcomer path (#57) — the operator admits the resident's public address, the resident presses the
// page's own start route and signs its own Join (live/candidates.mjs UNSUPPORTED.join is about the S1 live world).
import { GOALS } from '../goals.mjs';
import { DEFAULT_LIMITS } from '../resident.mjs';
import { decideLive } from '../live/decide.mjs';
import { buildOffers, trainCost, maxTrain, settled, HOST_TROOPS, TRANSIT_SLOTS, duplicateCost, copyNumber } from '../../../../permutation-server/web/frontier/hud/rulebook.mjs';
import { BUILD_ITEMS, storesAt, queueItem, TIER_BONUS_PCT } from '../../../../permutation-server/web/frontier/fland.mjs';
import { RESOURCE_ORDER } from '../../../../permutation-server/web/frontier/resources.mjs';
import { s1On, s1OreBase, setOreExtraProvider, holdingOreExtra } from '../../../../permutation-server/web/frontier/fs1.mjs';
import { TERRITORY_CLAIM, TERRITORY_LIMITS, territoryMem, tileOrder, growthTile, growthHolds, noteTile, claimNow, territorySeen } from './territory.mjs';
import { WIDE_LIMITS, EXPEDITION, wideMem, claimNotDue, claimSettling, claimNotFinal, claimCost, claimOrder, saveHold, expeditionNotDue, wideHostDecision, departMeta, expeditionFields, noteWide } from './wide.mjs';

export const BRAIN_KIND = 'ws13-local-brain/1';
/** The six orders of a local-play page (flocalplay-act.mjs LOCAL_ACT_NAMES' first six): the only ones asked for. */
export const LOCAL_ORDERS = Object.freeze(['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster']);
/**
 * (external-wide) In a LOCAL WIDE-LAND world only, the page's seventh (LOCAL_ACT_NAMES[6]): a first village past the
 * heartland is asked for by a one-site request, FileTicket, which the world's runner settles at a turn's end (itest
 * wide_play run_claims, for every wallet alike) — exactly the page's rim route (controller.mjs confirmHome).
 * (external-wide-orders) And the wide land's own orders, as the page has them there (wide.mjs): the wide claim 0xD9, a
 * wide village's WideTrain / WideMuster / WideDepart, and the rim → wide expedition (the page's depart route). The rule:
 * rim village → save for the settler cost → wide claim → wide village → train / muster → wide march; and a ready rim
 * host → an expedition into the bordering wide land. One action per turn, as every other order.
 */
export const WIDE_HOME_ORDER = 'FileTicket';
/**
 * Turns a landed rim request is waited for before another site is tried: the runner settles it at a turn's end, at the
 * latest once its cohort expires (COHORT_BELLS 24 turns); at ×60 under load that took far longer (loop-play6: ~60
 * turns), so 72 (half a game day). The page waits without a limit; a second request meanwhile would be the program's
 * to refuse, and the failure hold would follow.
 */
export const TICKET_WAIT_BELLS = 72;
/** ⑬'s plan items: the economy buildings (goals.mjs PLAN_ITEMS: food, wood, stone, ore, gold), real items 0–4. */
export const PLAN_ITEMS = Object.freeze(BUILD_ITEMS.filter(b => ['Food', 'Wood', 'Stone', 'Ore', 'Gold'].includes(b.resource)).map(b => b.item));
/** The Join's session expiry, as the page counts it (controller.mjs: chain now + 30 days − 600 s). */
export const SESSION_SECONDS = 30 * 86_400 - 600;
export const BELLS_PER_DAY = 144;

/**
 * ⑬'s limits for a local world. Taken from resident.mjs DEFAULT_LIMITS; three are the resident's own pace for a world
 * whose rule is one action per turn (each is the resident's own choice: looser than ⑬'s S1 values, never looser than the world's rule):
 *   wakeEveryBells 1 (S1: 3)      it may decide every turn; the world allows one action per turn and no more
 *   actionsPerDay 144 (S1: 12)    one a turn at most (BELLS_PER_DAY); the S1 value was set against S1's 30/h bucket
 *   idleBackoffMaxBells 4 (S1: 24) a waiting resident looks again within 4 turns (×60: 40 s), not 24
 * `actsPerBell` is the world's (owner Q16-2) and not a setting. `touchEveryBells`: with nothing else worth doing, a
 * Harvest (the owner's touch: settle, keep the village from dormancy) at most this often; otherwise it waits.
 */
export const LOCAL_LIMITS = Object.freeze({
  ...DEFAULT_LIMITS, wakeEveryBells: 1, actionsPerDay: BELLS_PER_DAY, idleBackoffMaxBells: 4,
  actsPerBell: 1, touchEveryBells: 6, trainBatchMax: 500, failureHoldMaxBells: 36,
});

const have = (obs) => (obs?.stores ?? []).map(s => s.value);
const idx = name => RESOURCE_ORDER.indexOf(name);

/**
 * ⑬ goals.mjs planBuilds on the real catalog: the next `depth` builds, each the plan item whose resource the village
 * makes least of per hour (ties: the lower item), counting the ones already planned. → `[{item, n, cost}]`.
 */
export function planBuildsReal(h, perHour, depth, now = 0) {
  const rate = [...perHour];
  // (goals.mjs planBuilds: "built and building items count as owned" — a building still in the queue adds its rate)
  for (const q of h?.queue ?? []) {
    if (!q || !(Number(q.doneAt) > now)) continue;
    const item = queueItem(q);
    if (PLAN_ITEMS.includes(item)) rate[idx(BUILD_ITEMS[item].resource)] += BUILD_ITEMS[item].perHour;
  }
  const plan = [];
  const extra = {};
  for (let i = 0; i < depth; i++) {
    const item = [...PLAN_ITEMS].sort((a, b) => rate[idx(BUILD_ITEMS[a].resource)] - rate[idx(BUILD_ITEMS[b].resource)] || a - b)[0];
    const n = copyNumber(h, item) + (extra[item] ?? 0);
    plan.push({ item, n, cost: BUILD_ITEMS[item].cost.map(c => duplicateCost(c, n)) });
    extra[item] = (extra[item] ?? 0) + 1;
    rate[idx(BUILD_ITEMS[item].resource)] += BUILD_ITEMS[item].perHour;
  }
  return plan;
}

/**
 * ⑬ goals.mjs assess, on the real village: the plan, what it needs, the stock beyond the plan and the goal's reserve
 * (`idle`, by resource index), the next build's shortfall and the bells production alone needs to cover it.
 */
export function assessReal(obs, goal) {
  const stock = have(obs), perHour = (obs.stores ?? []).map(s => s.perHour);
  const plan = planBuildsReal(obs.settled, perHour, goal.planDepth, obs.nowSecs ?? 0);
  const needed = RESOURCE_ORDER.map((_, r) => plan.reduce((n, b) => n + (b.cost[r] ?? 0), 0));
  const idle = RESOURCE_ORDER.map((_, r) => Math.max(0, (stock[r] ?? 0) - needed[r] - goal.reserve));
  const next = plan[0];
  let waitBells = 0;
  const shortfall = {};
  next.cost.forEach((c, r) => {
    const short = c - (stock[r] ?? 0);
    if (short > 0) {
      shortfall[RESOURCE_ORDER[r]] = short;
      const perBell = (perHour[r] ?? 0) / 6;
      waitBells = Math.max(waitBells, perBell > 0 ? Math.ceil(short / perBell) : Infinity);
    }
  });
  return { plan, next, needed, idle, shortfall, waitBells, affordable: Object.keys(shortfall).length === 0 };
}

// ------------------------------------------------------------------ S1: my village's terrain ore (LP9-4)
// On S1 (fs1.mjs s1Season: layout 2, program ≥ 4) the program counts a mine as the ore ABOVE the village's terrain ore
// (proc/holding.rs copy_number with arms::base_production), not above the tier's base (15/h). The page tells the two
// apart with the map's terrain (app.mjs setOreExtraProvider); this resident has no map, so it says its own village's
// terrain ore here. Without it copyNumber used the tier's base: a village whose terrain gives 4/h with three mines
// (22/h) read as one mine, so its plan priced the 4th mine as the 2nd (wood 120, not 440) and the chain refused it
// Insufficient, again and again (loop-play9 LP9-4).
const ORE_KNOWN = new Map();   // "p,q,tile" → extra (0–30) of fs1.mjs s1OreBase
let oreProvider = false;
/** Register what the terrain adds to the ore of the village on tile (p, q, tile) (null: not known). */
export function knowVillageOre(holding, extra) {
  if (!holding || !Number.isInteger(holding.tile)) return;
  if (!oreProvider) { setOreExtraProvider((p, q, tile) => ORE_KNOWN.get(`${p},${q},${tile}`) ?? null); oreProvider = true; }
  const k = `${holding.p},${holding.q},${holding.tile}`;
  if (Number.isInteger(extra)) ORE_KNOWN.set(k, extra); else ORE_KNOWN.delete(k);
}
/**
 * The terrain part of a v2 Holding's own TERRAIN_ORE (holding2::TERRAIN_ORE, milli per hour, written at founding or
 * capture: (4 + min(extra, 30)) × 1000, arms.rs terrain_ore_per_hour) → extra 0–30, or null (unread, or not of that form).
 */
export const terrainOreExtra = raw => holdingOreExtra(raw);   // (the page's own reading: fs1.mjs holdingOreExtra)

const villageKey = h => (h ? `${h.p},${h.q},${h.site}` : null);
/**
 * My village's landed builds, kept in my memory (journal lines are pruned at 96): `mem.village = {key, complete,
 * builds: {item: n}}`. `complete` when the record began with my own PlaceHome landing (every build of the village is
 * then mine and counted); a village first seen otherwise (an older state) is counted from then on, not complete.
 * → a note when the record changed (a new or another village), else null.
 */
export function trackVillage(mem, obs) {
  const k = villageKey(obs?.holding);
  if (!k || mem.village?.key === k) return null;
  const was = mem.village?.key ?? null;
  mem.village = { key: k, complete: false, builds: {} };
  return `my village ${k} was not placed by me in this memory${was ? ` (it was ${was})` : ''}: its builds are counted from now on`;
}
/** Builds of `item` that landed for my village (all of them: the record is complete) → n, or null when not known. */
export function landedCopies(mem, obs, item) {
  const v = mem?.village;
  return v && v.complete && v.key === villageKey(obs?.holding) ? Number(v.builds?.[item] ?? 0) : null;
}
/**
 * S1, the terrain ore not read: my landed mines tell the ore base apart from the mines. Every landed mine is either
 * built (in `production`) or still queued; with `done` built ones the base is at most production − done × 6/h, and
 * the largest terrain extra under that bound gives copyNumber exactly done + queued + 1 (each extra step is ≤ 2.75/h,
 * under a mine's 6/h). A build that landed but is not in the record yet counts as built: the copy reads high, never low.
 */
export function oreExtraFromLanded(obs, mem) {
  const mines = landedCopies(mem, obs, 3);
  if (mines === null || !obs?.settled?.production) return null;
  const now = obs.nowSecs ?? 0;
  const queued = (obs.settled.queue ?? []).filter(q => q && Number(q.doneAt) > now && queueItem(q) === 3).length;
  const done = Math.max(0, mines - queued);
  let prod; try { prod = BigInt(obs.settled.production[RESOURCE_ORDER.indexOf('Ore')]); } catch { return null; }
  const bonus = TIER_BONUS_PCT[Number(obs.settled.tier ?? 0)] ?? 0;
  const bound = prod - BigInt(done * BUILD_ITEMS[3].perHour * 1000);
  let e = 0;
  for (let x = 0; x <= 30; x++) if (s1OreBase(x, bonus) <= bound) e = x;
  return e;
}
/**
 * Say my village's terrain ore to the page's rulebook (copyNumber, buildOffers, the stores' projection) before any
 * build is counted: from the Holding's own TERRAIN_ORE (observe.mjs `holding.oreExtra`), else from my landed mines.
 * → `{extra, by: 'record' | 'landed' | null}`, or null off S1.
 */
export function villageOre(obs, mem) {
  if (!s1On() || !obs?.holding || !obs.settled) return null;
  let extra = Number.isInteger(obs.holding.oreExtra) ? obs.holding.oreExtra : null, by = extra === null ? null : 'record';
  if (extra === null) { extra = oreExtraFromLanded(obs, mem); by = extra === null ? null : 'landed'; }
  knowVillageOre(obs.holding, extra);
  return { extra, by };
}
/**
 * The record does not show all my landed builds of `item` yet (the herald trails the chain): the copy it reads is
 * lower than my landed builds + 1, so a cost read from it is too low. → why (wait), or null.
 */
export function recordBehind(obs, mem, item) {
  const mine = landedCopies(mem, obs, item);
  if (mine === null || !obs?.settled) return null;
  const now = copyNumber(obs.settled, item);
  return mine + 1 > now ? `${mine} build(s) of my ${BUILD_ITEMS[item].resource} landed; my village's record shows copy ${now} next, not ${mine + 1}: waiting for the record` : null;
}

/** The chain refused an order for resources (frontier-abi error.rs Insufficient = 21, the runner's `Custom(21)`). */
export function refusedForResources(r) {
  if (!r) return false;
  if (r.code === 'Insufficient' || r.programCode === 21 || r.detail?.program_code === 21) return true;
  let text = r.detail ?? r.message ?? '';
  if (typeof text !== 'string') { try { text = JSON.stringify(text); } catch { text = ''; } }
  return /Custom\(21\)/.test(text) || /"program_code"\s*:\s*21\b/.test(text);
}
/**
 * A Build the chain refused for resources is not sent again until the stock has grown past what it was at the refusal
 * in every resource the building costs (a landing of that building clears it). → why (held), or null.
 */
export function refusalHold(mem, obs, item) {
  const rec = mem?.refusals?.[`Build:${item}`];
  if (!rec || !Array.isArray(rec.stock)) return null;
  const stock = have(obs);
  const need = (BUILD_ITEMS[item]?.cost ?? []).map((c, r) => (c > 0 ? r : -1)).filter(r => r >= 0);
  const behind = need.filter(r => !((stock[r] ?? 0) > (rec.stock[r] ?? 0)));
  if (!behind.length) return null;
  return `the chain refused this ${BUILD_ITEMS[item].resource} build (copy ${rec.copy}) for resources at turn ${rec.bell}: not sent again until ${behind.map(r => `${RESOURCE_ORDER[r]} grows past ${rec.stock[r] ?? 0}`).join(', ')}`;
}

const failKey = c => (c.kind === 'tile' ? TERRITORY_CLAIM : c.kind === 'build' ? `Build:${c.order.fields.item}` : c.kind === 'home' ? (c.order.name === WIDE_HOME_ORDER ? WIDE_HOME_ORDER : 'PlaceHome') : c.order.name);
export { failKey };
/** The site of a home order (PlaceHome `{p, q, site}`; FileTicket `{sites: [one]}`) as `"p,q,site"`. */
const homeSiteKey = order => { const s = order.name === WIDE_HOME_ORDER ? order.fields.sites?.[0] ?? {} : order.fields; return `${s.p},${s.q},${s.site}`; };

/** A held reason from the failure memory (the doubling hold), or null. */
function failureHold(mem, key, bell) {
  const f = mem.failures?.[key];
  return f && Number.isInteger(f.until) && f.until > bell ? `held after ${f.count} refusal(s) until turn ${f.until}${f.code ? ` (${f.code})` : ''}` : null;
}

/**
 * (external-wide-orders) The wide land's candidates, pushed onto `out` (the village's own ones are there already):
 *   wideclaim   the wide claim on the nearest target in reach, when no wide village is mine yet; held while saving (the
 *               settler cost not in the stores) or while a landed claim settles. While a claim is saved for and
 *               production covers its cost within WIDE_LIMITS.savePatienceBells, the village's builds and training that
 *               would spend that cost are held (the save).
 *   widehost    the page's wide-village planner's one act (WideTrain / WideMuster / WideDepart)
 *   expedition  a ready rim host into the bordering wide land (the page's depart route); with no host at home yet, the
 *               village's Muster (and training toward it) is preferred
 */
/** What the next copy of building `item` costs this village (by resource index; the page's duplicateCost on copyNumber). */
export const buildSpend = (obs, item) => (BUILD_ITEMS[item] && obs?.settled ? BUILD_ITEMS[item].cost.map(c => duplicateCost(c, copyNumber(obs.settled, item))) : null);

/**
 * (ws13-territory, #209) The tile candidates of a world with player territory, pushed onto `out` (kind 'tile', the
 * page's own act TerritoryClaim; one claim a turn is the world's, one action a turn the resident's):
 *   tile:site    the tile of the site the next wide village will stand on (`siteFirst`, wide.mjs claimOrder), as soon as
 *                the ore covers it — without it no village can be founded
 *   tile:growth  one more tile next to its own land, at its own pace (territory.mjs TERRITORY_LIMITS / growthHolds:
 *                only from ore beyond the plan, the reserve and a training hundred; LP15-5)
 * Held, each with its reason: the turn's claim used, upkeep unpaid (the world refuses claims then), the ore short.
 */
export function territoryCandidates(obs, mem, out, { bell, a = null, siteFirst = null, final = true, tl = TERRITORY_LIMITS } = {}) {
  const view = obs.territory;
  territoryMem(mem);
  const ore = (obs.stores ?? [])[idx('Ore')]?.value ?? null, now = claimNow(view, { ore });
  const common = () => { const held = [...now.why]; const fh = failureHold(mem, TERRITORY_CLAIM, bell); if (fh) held.push(fh); return held; };
  if (siteFirst) {
    const x = siteFirst.province, held = common();
    // (the same lazy final flip as the wide claim's: the site's tile is bought once the first village is final —
    //  a tile for a village that cannot be claimed yet would only start its upkeep early)
    if (!final) held.push('my first village is not final yet: the site\'s tile once a wide claim can follow');
    out.push({ id: `tile:${x.p},${x.q},${siteFirst.tile}`, kind: 'tile', site: `${x.p},${x.q},${siteFirst.tile}`, meta: { purpose: 'site', villageSite: siteFirst.site }, order: tileOrder(obs.holding, x, siteFirst.tile),
      ...(held.length ? { held } : {}), score: 1.55,
      why: `claim tile ${siteFirst.tile} at ${x.p},${x.q} for ${view.own.nextClaimOre} ore: the site ${siteFirst.site} of my next village stands on it (a village stands only on my own land)` });
  }
  const g = growthTile(view, mem, tl);
  if (g.province) {
    const x = g.province, pv = Number(obs.programVersion ?? 1), t100 = trainCost(0, 100, pv);
    const held = [...common(), ...growthHolds(view, mem, { bell, idleOre: a?.idle?.[idx('Ore')] ?? 0, trainOre100: t100?.[idx('Ore')] ?? 0, foodPerHour: (obs.stores ?? [])[idx('Food')]?.perHour ?? 0, addMilli: x.tileUpkeepMilliFoodPerHour, limits: tl })];
    out.push({ id: `tile:${x.p},${x.q},${g.tile}`, kind: 'tile', site: `${x.p},${x.q},${g.tile}`, meta: { purpose: 'growth' }, order: tileOrder(obs.holding, x, g.tile), ...(held.length ? { held } : {}), score: 0.45,
      why: `grow my land: tile ${g.tile} at ${x.p},${x.q} next to my own (${view.own.tiles} owned) for ${view.own.nextClaimOre} ore, +${(x.tileUpkeepMilliFoodPerHour / 1000).toFixed(3)} food/h upkeep${g.seen ? '' : ' (out of my sight: it may be another player\'s)'}` });
  }
  return out;
}

export function wideCandidates(obs, mem, out, { bell, limits = LOCAL_LIMITS, a = null, wl = WIDE_LIMITS } = {}) {
  wideMem(mem);
  const v = { holding: { p: obs.holding.p, q: obs.holding.q, site: obs.holding.site } };
  // the claim
  const notDue = claimNotDue(obs, mem, wl);
  if (!notDue) {
    const cost = claimCost(obs), settling = claimSettling(obs, mem, wl), o = claimOrder(obs, mem);
    const held = [];
    if (o.why) held.push(o.why);
    if (settling) held.push(settling);
    const nf = claimNotFinal(obs); if (nf) held.push(nf);
    if (!cost.affordable) held.push(`saving for the settler cost (short ${Object.entries(cost.short).map(([r, n]) => `${r} ${n}`).join(', ')})`);
    const fh = failureHold(mem, 'WideClaim', bell); if (fh) held.push(fh);
    if (o.order) out.push({ id: `wideclaim:${o.site}`, kind: 'wideclaim', site: o.site, order: o.order, ...(held.length ? { held } : {}), score: 1.6,
      why: `claim wide land at ${o.order.v.target.p},${o.order.v.target.q} site ${o.order.fields.site} (slot ${o.order.fields.slot}): my village is within reach of the wide land` });
    // (the save: production covers the cost within the patience → what would spend it waits; wide.mjs saveHold)
    for (const c of out) {
      const spend = c.kind === 'build' ? buildSpend(obs, c.order.fields.item) : c.kind === 'train' ? trainCost(0, c.order.fields.n, Number(obs.programVersion ?? 1)) : null;
      const sh = saveHold(obs, mem, spend, wl);
      if (sh) c.held = [...(c.held ?? []), sh];
    }
  }
  // (ws13-territory) the land's tiles, in a world with player territory
  if (obs.territory?.on === true) territoryCandidates(obs, mem, out, { bell, a, siteFirst: notDue ? null : claimOrder(obs, mem).tileFirst ?? null, final: !claimNotFinal(obs) });
  // the wide village's host
  const hd = wideHostDecision(obs, mem, wl);
  if (hd.decision) {
    const d = hd.decision, held = [];
    const fh = failureHold(mem, d.name, bell); if (fh) held.push(fh);
    out.push({ id: `wide:${d.name}`, kind: 'widehost', order: { name: d.name, v: d.v, fields: d.fields }, ...(departMeta(d) ? { meta: departMeta(d) } : {}), ...(held.length ? { held } : {}),
      score: d.name === 'WideDepart' ? 1.4 : 0.95, why: d.why });
  }
  // the expedition
  const xNot = expeditionNotDue(obs, mem, wl), x = obs.wideLand.expedition;
  if (!xNot && x?.ok) {
    const held = [];
    const fh = failureHold(mem, EXPEDITION, bell); if (fh) held.push(fh);
    out.push({ id: 'expedition', kind: 'expedition', order: { name: EXPEDITION, v: {}, fields: expeditionFields(x.plan) }, plan: x.plan, ...(held.length ? { held } : {}), score: 1.5,
      why: `a ready host (${Math.floor(Number(x.plan.host.troops))} troops) of my rim village marches into the wide land at ${x.plan.dest.p},${x.plan.dest.q} (arrival turn ${x.plan.arriveBell})` });
  } else if (!xNot && x && x.hosts === 0) {
    // (no host at home: form one for the expedition — the village's own Muster, and its training when the reserve is short)
    for (const c of out) if (c.kind === 'muster') { c.score += 1.2; c.why += ' (for an expedition into the wide land)'; }
    const reserve = Number(obs.settled?.reserve?.[0] ?? 0);
    if (reserve < 100) for (const c of out) if (c.kind === 'train' && c.held?.every(h => /^idle stock/.test(h))) {
      // (the training is held only for want of idle stock beyond the plan: a hundred for the expedition's host is paid from the stock itself when it covers it)
      const pv = Number(obs.programVersion ?? 1), cost = trainCost(0, 100, pv), have = (obs.stores ?? []).map(s => s.value);
      if (cost && cost.every((n, r) => (have[r] ?? 0) >= n)) { delete c.held; c.order = { ...c.order, fields: { unit: 0, n: 100 } }; c.score = 0.9; c.why = 'train 100 spearmen for an expedition host into the wide land'; }
    }
  }
  return out;
}

/**
 * Every order the resident could ask for now. `obs` (observe.mjs): `{bell, nowSecs, programVersion, joined, faction,
 * holding: {p, q, site, tile?} | null, settled, stores: [{resource, value, perHour, cap}], homes: [{p, q, site}]}`;
 * `mem` (journal.mjs state): goal, nation, failures, triedHomes, lastTouchBell.
 * → `{candidates: [{id, kind, order: {name, v, fields}, held?, score, why}], assessment, why}`.
 */
export function localCandidates(obs, mem, { limits = LOCAL_LIMITS } = {}) {
  const goal = GOALS[mem.goal];
  if (!goal) return { candidates: [], assessment: null, why: [`unknown goal ${mem.goal}`] };
  const out = [], why = [];
  const bell = obs?.bell;
  if (!obs || !Number.isInteger(bell)) return { candidates: [], assessment: null, why: ['no readable observation (turn unknown)'] };
  if (!obs.joined) {
    const held = [];
    if (!Number.isSafeInteger(obs.nowSecs) || obs.nowSecs <= 0) held.push('no chain clock yet for the Join expiry');
    const h = failureHold(mem, 'Join', bell); if (h) held.push(h);
    out.push({ id: 'join', kind: 'join', order: { name: 'Join', v: { faction: mem.nation }, fields: { faction: mem.nation, session_expiry: Number.isSafeInteger(obs.nowSecs) ? obs.nowSecs + SESSION_SECONDS : null } },
      ...(held.length ? { held } : {}), score: 1, why: `not a citizen yet: join my nation ${mem.nation} as a newcomer (⑤B: same Join a page signs)` });
    return { candidates: out, assessment: null, why };
  }
  if (!obs.holding) {
    const tried = new Set(mem.triedHomes ?? []);
    // (external-wide: a rim request that landed waits for the runner's settlement at a turn's end; nothing else is
    //  asked for the first village meanwhile — the page shows its 'ticket' wait the same way)
    const t = mem.ticket;
    const waiting = t && Number.isInteger(t.bell) && bell < t.bell + TICKET_WAIT_BELLS ? `my village request for ${t.site} (turn ${t.bell}) waits for the turn's end (until turn ${t.bell + TICKET_WAIT_BELLS})` : null;
    const free = (obs.homes ?? []).filter(x => !tried.has(`${x.p},${x.q},${x.site}`));
    if (!free.length) why.push(obs.wide ? 'no untried free first-village site of my nation seen (outward, as the page reads them)' : 'no untried free home site of my nation seen');
    free.slice(0, 3).forEach((x, i) => {
      const ticket = obs.wide === true && x.ticket === true, one = { p: x.p, q: x.q, site: x.site };
      const held = [failureHold(mem, ticket ? WIDE_HOME_ORDER : 'PlaceHome', bell), waiting].filter(Boolean);
      out.push({ id: `home:${x.p},${x.q},${x.site}`, kind: 'home',
        order: ticket ? { name: WIDE_HOME_ORDER, v: { sites: [one] }, fields: { sites: [one] } } : { name: 'PlaceHome', v: { holding: one, faction: obs.faction }, fields: { ...one } },
        ...(held.length ? { held } : {}), score: 1 - i * 0.01,
        why: ticket ? 'a citizen with no village: request a rim site of my nation (outward, the page\'s first-village route in a wide world)' : 'a citizen with no village: the nearest free home site of my nation' });
    });
    return { candidates: out, assessment: null, why };
  }
  if (!obs.settled || !Array.isArray(obs.stores) || obs.stores.length < 6) {
    why.push('my village\'s record is not readable: nothing but a wait');
    return { candidates: out, assessment: null, why };
  }
  const v = { holding: { p: obs.holding.p, q: obs.holding.q, site: obs.holding.site } };
  const a = assessReal(obs, goal);
  const stock = have(obs);
  // Build: the page's own offers (QueueFull, Insufficient, AboveCap are the page's codes); scored by the goal's plan
  const offers = buildOffers(obs.settled, { now: obs.nowSecs, have: stock, faction: obs.faction });
  for (const item of PLAN_ITEMS) {
    const o = offers.find(x => x.item === item);
    const held = [];
    if (!o) held.push('not offered by the page'); else if (o.blocks.length) held.push(`the page says ${o.blocks.join(', ')}${o.short.length ? ` (short ${o.short.map(s => `${RESOURCE_ORDER[s.r]} ${s.need}`).join(', ')})` : ''}`);
    const isNext = item === a.next.item, inPlan = a.plan.some(p => p.item === item);
    const fh = failureHold(mem, `Build:${item}`, bell); if (fh) held.push(fh);
    const rh = refusalHold(mem, obs, item); if (rh) held.push(rh);
    const rb = recordBehind(obs, mem, item); if (rb) held.push(rb);
    out.push({ id: `build:${item}`, kind: 'build', order: { name: 'Build', v: { ...v, item }, fields: { item } }, ...(held.length ? { held } : {}),
      score: goal.growth * (isNext ? 1 : inPlan ? 0.6 : 0.3) + 0.1,
      why: `${BUILD_ITEMS[item].resource} building copy ${o?.n ?? '?'}: ${isNext ? 'the next of my plan (what my village makes least of)' : inPlan ? 'in my plan' : 'not in my plan'}` });
  }
  // Train: only from the stock beyond the plan and the reserve (⑬ "use": put idle stock to work), spearmen in hundreds
  {
    const pv = Number(obs.programVersion ?? 1);
    const n = Math.min(limits.trainBatchMax, maxTrain(0, a.idle, pv));
    const held = [];
    if (n < 100) held.push(`idle stock beyond my plan and reserve ${goal.reserve} pays for no hundred (food ${a.idle[0]}, ore ${a.idle[3]}, gold ${a.idle[5]})`);
    const fh = failureHold(mem, 'Train', bell); if (fh) held.push(fh);
    out.push({ id: 'train:0', kind: 'train', order: { name: 'Train', v, fields: { unit: 0, n: Math.max(100, n) } }, ...(held.length ? { held } : {}),
      score: goal.use * 0.9 * Math.min(1, n / 300) + (a.affordable ? 0 : 0.05),
      why: `train ${Math.max(100, n)} spearmen from idle stock (cost ${JSON.stringify(trainCost(0, Math.max(100, n), pv))})` });
  }
  // Muster: a host from the reserve, at least 100 (permutation-rules host.rs MIN_HOST_TROOPS)
  {
    const reserve = Number(obs.settled.reserve?.[0] ?? 0);
    const troops = Math.min(HOST_TROOPS.max, Math.floor(reserve / 100) * 100);
    const busy = (obs.settled.transit ?? []).filter(t => t && Number(t.state ?? 0) !== 0).length;
    const held = [];
    if (troops < HOST_TROOPS.min) held.push(`reserve ${reserve} spearmen: a host needs ${HOST_TROOPS.min}`);
    if (obs.holding.tile === undefined) held.push('my village\'s tile is not known');
    if (busy >= TRANSIT_SLOTS) held.push('every host slot is in use');
    // (the program's resident_ok: the village's province must be resolved to the turn before this one; at ×60 the
    //  world's keeper trails, and a Muster sent early is refused NotResident (Custom 26). Unread is held, never guessed.)
    const rn = obs.province?.resolvedNext;
    if (!Number.isInteger(rn)) held.push('my province\'s resolved turn is not read');
    else if (rn + 1 < bell) held.push(`my province is resolved to turn ${rn}; a muster waits until it reaches turn ${bell - 1}`);
    const fh = failureHold(mem, 'Muster', bell); if (fh) held.push(fh);
    out.push({ id: 'muster:0', kind: 'muster', order: { name: 'Muster', v, fields: { unit: 0, troops: Math.max(100, troops), tile: obs.holding.tile ?? null } }, ...(held.length ? { held } : {}),
      score: goal.use * 0.35 + 0.05, why: `form a host of ${Math.max(100, troops)} from my reserve (guards the village)` });
  }
  // (external-wide-orders) the wide land's orders, in a local wide world with a village (obs.wideLand, wide.mjs)
  if (obs.wideLand) wideCandidates(obs, mem, out, { bell, limits, a });
  // Harvest: the owner's touch, only when the village has not been touched for touchEveryBells turns
  {
    const last = Number.isInteger(mem.lastTouchBell) ? mem.lastTouchBell : -Infinity;
    const held = [];
    if (bell - last < limits.touchEveryBells) held.push(`touched ${bell - last} turn(s) ago: a harvest only every ${limits.touchEveryBells}`);
    const fh = failureHold(mem, 'Harvest', bell); if (fh) held.push(fh);
    out.push({ id: 'harvest', kind: 'harvest', order: { name: 'Harvest', v, fields: {} }, ...(held.length ? { held } : {}),
      score: 0.08 + (a.affordable ? 0 : a.waitBells <= goal.patienceBells ? 0.05 : 0), why: 'settle my village (the owner\'s touch keeps it from dormancy)' });
  }
  return { candidates: out, assessment: { plan: a.plan.map(p => `${BUILD_ITEMS[p.item].resource}#${p.n}`), next: a.next.item, affordable: a.affordable, shortfall: a.shortfall, waitBells: Number.isFinite(a.waitBells) ? a.waitBells : null, idle: Object.fromEntries(a.idle.map((x, r) => [RESOURCE_ORDER[r], x]).filter(([, x]) => x > 0)) }, why };
}

/** The no-charge local rule: the highest-scoring candidate that is not held (ties: the first listed), else wait. */
export function localRule({ candidates }) {
  const free = candidates.filter(c => !c.held);
  if (!free.length) return { choice: 'wait', by: 'ws13-local-rule', why: candidates.length ? 'every order is held' : 'nothing to ask for' };
  const best = free.reduce((b, c) => (c.score > b.score ? c : b), free[0]);
  return { choice: best.id, by: 'ws13-local-rule', why: best.why };
}

/** decide: the local rule, or an injected provider through ⑬'s own fail-closed boundary (decideLive). */
export function decideLocal({ candidates, obs }, provider = null, { allow = {} } = {}) {
  if (!provider) return localRule({ candidates });
  return decideLive({ candidates, obs }, provider, { allow });
}

/**
 * After an order: the failure memory (⑬ resident.mjs: each failure doubles the hold — 4, 8, 16, 32, at most 36 turns;
 * a landing clears it), the tried home sites, the last touch. `outcome`: landed | failed | refused | unknown | not-sent.
 * `not-sent` (nothing reached the chain: a transport failure before the submit) holds nothing. A landed PlaceHome starts
 * my village's record of landed builds, a landed Build counts in it (`mem.village`); a Build refused for resources
 * (`resources`, refusedForResources) is remembered with the copy and the stock of `obs` (`mem.refusals`, refusalHold).
 */
export function noteOutcome(mem, cand, outcome, { bell, code = null, limits = LOCAL_LIMITS, resources = false, obs = null, programCode = null } = {}) {
  const key = failKey(cand);
  mem.failures = mem.failures ?? {};
  mem.refusals = mem.refusals ?? {};
  // (ws13-territory: a tile claim's own memory — the claim's turn, the growth pace, tiles not asked again)
  if (cand.kind === 'tile') {
    noteTile(mem, { site: cand.site ?? null, growth: cand.meta?.purpose === 'growth' }, outcome, { bell, programCode });
    // ("already yours" is no failure: the tile is mine, the next look goes on from there)
    if ((outcome === 'failed' || outcome === 'refused') && programCode === 52) return mem;
  }
  // (external-wide-orders: the wide land's own memory — claims tried and settling, the wide host's marches, expeditions)
  if (['wideclaim', 'widehost', 'expedition'].includes(cand.kind)) {
    const site = cand.kind === 'wideclaim' ? (cand.site ?? `${cand.order.v?.target?.p},${cand.order.v?.target?.q},${cand.order.fields?.site}`) : null;
    noteWide(mem, cand.kind, cand.order.name, outcome, { bell, site, meta: cand.meta ?? null });
  }
  if (outcome === 'landed') {
    delete mem.failures[key];
    if (cand.kind !== 'join') mem.lastTouchBell = bell;
    // (external-wide: a landed rim request is not a village yet — the runner settles it at a turn's end, as taken or
    //  as a village; the site is not asked for again, and the request is waited for: TICKET_WAIT_BELLS)
    if (cand.kind === 'home' && cand.order.name === WIDE_HOME_ORDER) { const site = homeSiteKey(cand.order); mem.ticket = { bell, site }; mem.triedHomes = [...(mem.triedHomes ?? []), site]; }
    // (LP9-4: my village's landed builds, counted here — the order's own landing, read once — on the send and on the
    //  reconcile alike; a landed PlaceHome of mine starts a complete record; a rim village from a request is counted
    //  from when it is first seen, trackVillage)
    else if (cand.kind === 'home') mem.village = { key: homeSiteKey(cand.order), complete: true, builds: {} };
    if (cand.kind === 'build' && mem.village) {
      const item = cand.order.fields.item;
      mem.village.builds = { ...(mem.village.builds ?? {}), [item]: Number(mem.village.builds?.[item] ?? 0) + 1 };
      delete mem.refusals[key];
    }
    return mem;
  }
  // (LP9-4: refused for resources: remember the copy and the stock, refusalHold keeps the same Build back)
  if (cand.kind === 'build' && (outcome === 'refused' || outcome === 'failed') && resources) {
    const item = cand.order.fields.item;
    mem.refusals[key] = { item, copy: obs?.settled ? copyNumber(obs.settled, item) : null, stock: have(obs), bell, code };
  }
  if (cand.kind === 'home' && outcome !== 'unknown' && outcome !== 'not-sent') mem.triedHomes = [...(mem.triedHomes ?? []), homeSiteKey(cand.order)];
  if (outcome === 'failed' || outcome === 'refused') {
    const count = (mem.failures[key]?.count ?? 0) + 1;
    mem.failures[key] = { count, until: bell + Math.min(limits.failureHoldMaxBells, limits.retryBackoffBells * 2 ** count), code };
  }
  return mem;
}

export const ORDER_KINDS = Object.freeze({ tile: TERRITORY_CLAIM, join: 'Join', home: 'PlaceHome', harvest: 'Harvest', build: 'Build', train: 'Train', muster: 'Muster', wideclaim: 'WideClaim', expedition: EXPEDITION });   // (a wide world's rim home: kind 'home', order WIDE_HOME_ORDER; kind 'widehost': WideTrain / WideMuster / WideDepart)
/** For logs: the observation reduced to what the brain read. */
export function seenOf(obs) {
  if (!obs) return null;
  return { bell: obs.bell, joined: obs.joined, faction: obs.faction, village: obs.holding ? `${obs.holding.p},${obs.holding.q},${obs.holding.site}` : null,
    stores: obs.stores ? Object.fromEntries(obs.stores.slice(0, 6).map(s => [s.resource, s.value])) : null, reserve: obs.settled?.reserve?.[0] !== undefined ? Number(obs.settled.reserve[0]) : null,
    queue: obs.settled?.queue ? obs.settled.queue.filter(q => q && Number(q.doneAt) > (obs.nowSecs ?? 0)).length : null, homesSeen: obs.homes?.length ?? 0,
    ...(obs.territory ? { territory: territorySeen(obs.territory) } : {}),
    ...(obs.wideLand ? { wide: { villages: obs.wideLand.villages.map(x => `${x.p},${x.q},${x.site}`), targets: obs.wideLand.targets.length, border: obs.wideLand.border.length, host: obs.wideLand.host?.decision?.name ?? obs.wideLand.host?.why ?? null, expedition: obs.wideLand.expedition ? (obs.wideLand.expedition.ok ? 'ready' : obs.wideLand.expedition.why) : null } } : {}) };
}
export { settled, storesAt };
