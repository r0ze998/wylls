// ⑬'s resident brain on a LOCAL-PLAY TEST world (2026-11-22, reports/playable-2-3-4-13.md §2 step 2). KEY-FREE and pure.
//
// The resident's own goals (goals.mjs GOALS: growth / use weights, plan depth, reserve, patience), its own limits
// (resident.mjs DEFAULT_LIMITS: the shortest gap between decisions, the idle back-off, the allowance of decisions,
// the day's actions, the doubling hold after a failed action) and its own memory (journal.mjs) are mapped onto the
// six orders a person's page has in local play — Join, PlaceHome, Harvest, Build, Train, Muster — and onto nothing
// else. What it reads is what the page reads about ITS OWN village (the public herald, observe.mjs); the numbers it
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
import { BUILD_ITEMS, storesAt, queueItem } from '../../../../permutation-server/web/frontier/fland.mjs';
import { RESOURCE_ORDER } from '../../../../permutation-server/web/frontier/resources.mjs';

export const BRAIN_KIND = 'ws13-local-brain/1';
/** The six orders of a local-play page (flocalplay-act.mjs LOCAL_ACT_NAMES' first six): the only ones asked for. */
export const LOCAL_ORDERS = Object.freeze(['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster']);
/** ⑬'s plan items: the economy buildings (goals.mjs PLAN_ITEMS: food, wood, stone, ore, gold), real items 0–4. */
export const PLAN_ITEMS = Object.freeze(BUILD_ITEMS.filter(b => ['Food', 'Wood', 'Stone', 'Ore', 'Gold'].includes(b.resource)).map(b => b.item));
/** The Join's session expiry, as the page counts it (controller.mjs: chain now + 30 days − 600 s). */
export const SESSION_SECONDS = 30 * 86_400 - 600;
export const BELLS_PER_DAY = 144;

/**
 * ⑬'s limits for a local world. Taken from resident.mjs DEFAULT_LIMITS; three are the resident's own pace for a world
 * whose rule is one action per turn (each is the resident's choice, stricter than the world, and set in its charter):
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

const failKey = c => (c.kind === 'build' ? `Build:${c.order.fields.item}` : c.kind === 'home' ? 'PlaceHome' : c.order.name);

/** A held reason from the failure memory (the doubling hold), or null. */
function failureHold(mem, key, bell) {
  const f = mem.failures?.[key];
  return f && Number.isInteger(f.until) && f.until > bell ? `held after ${f.count} refusal(s) until turn ${f.until}${f.code ? ` (${f.code})` : ''}` : null;
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
    const hold = failureHold(mem, 'PlaceHome', bell);
    const free = (obs.homes ?? []).filter(x => !tried.has(`${x.p},${x.q},${x.site}`));
    if (!free.length) why.push('no untried free home site of my nation seen');
    free.slice(0, 3).forEach((x, i) => out.push({ id: `home:${x.p},${x.q},${x.site}`, kind: 'home', order: { name: 'PlaceHome', v: { holding: { p: x.p, q: x.q, site: x.site }, faction: obs.faction }, fields: { p: x.p, q: x.q, site: x.site } },
      ...(hold ? { held: [hold] } : {}), score: 1 - i * 0.01, why: 'a citizen with no village: the nearest free home site of my nation' }));
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
 * `not-sent` (nothing reached the chain: a transport failure before the submit) holds nothing.
 */
export function noteOutcome(mem, cand, outcome, { bell, code = null, limits = LOCAL_LIMITS } = {}) {
  const key = failKey(cand);
  mem.failures = mem.failures ?? {};
  if (outcome === 'landed') {
    delete mem.failures[key];
    if (cand.kind !== 'join') mem.lastTouchBell = bell;
    return mem;
  }
  if (cand.kind === 'home' && outcome !== 'unknown' && outcome !== 'not-sent') mem.triedHomes = [...(mem.triedHomes ?? []), `${cand.order.fields.p},${cand.order.fields.q},${cand.order.fields.site}`];
  if (outcome === 'failed' || outcome === 'refused') {
    const count = (mem.failures[key]?.count ?? 0) + 1;
    mem.failures[key] = { count, until: bell + Math.min(limits.failureHoldMaxBells, limits.retryBackoffBells * 2 ** count), code };
  }
  return mem;
}

export const ORDER_KINDS = Object.freeze({ join: 'Join', home: 'PlaceHome', harvest: 'Harvest', build: 'Build', train: 'Train', muster: 'Muster' });
/** For logs: the observation reduced to what the brain read. */
export function seenOf(obs) {
  if (!obs) return null;
  return { bell: obs.bell, joined: obs.joined, faction: obs.faction, village: obs.holding ? `${obs.holding.p},${obs.holding.q},${obs.holding.site}` : null,
    stores: obs.stores ? Object.fromEntries(obs.stores.slice(0, 6).map(s => [s.resource, s.value])) : null, reserve: obs.settled?.reserve?.[0] !== undefined ? Number(obs.settled.reserve[0]) : null,
    queue: obs.settled?.queue ? obs.settled.queue.filter(q => q && Number(q.doneAt) > (obs.nowSecs ?? 0)).length : null, homesSeen: obs.homes?.length ?? 0 };
}
export { settled, storesAt };
