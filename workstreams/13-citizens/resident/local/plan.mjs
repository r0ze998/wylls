// ⑬ local resident's MULTI-TURN PLANS (2026-11-22, reports/playable-2-3-4-13.md §2 step 3). KEY-FREE and pure.
//
// The resident's goal (goals.mjs: plan depth, reserve, patience) becomes a plan of its own village's next orders —
// a build chain on the page's own catalogue (brain.mjs planBuildsReal), training from what the chain leaves, a host
// from the trained reserve — and workstream 04's plan store (workstreams/04-execution src/plans.rs) runs it, one
// step per turn, through restarts (executor.mjs). Only the six local orders — and, in a local wide-land world, the wide
// land's own (external-wide-orders: WideClaim, WideTrain/WideMuster/WideDepart, the rim → wide Expedition; wide.mjs);
// never a caravan (owner question Q4).
//
//   makePlanSteps(obs, goal)   → the steps of a new plan, each with what must still be true when it is sent (`expect`)
//   checkStep(step, obs, mem)  → {go: candidate} | {wait: why} | {replan: why} — the same checks the page makes
//                                (buildOffers, trainCost, the host rules, resident_ok); a step whose world changed under
//                                it (a copy that exists already, a building the page no longer offers, a shortfall
//                                production will not cover in the goal's patience) is a replan, never a blind send;
//                                a copy my landed builds say exists but the record does not show yet is a wait, and
//                                a Build the chain refused for resources waits until the stock has grown (LP9-4).
import { planBuildsReal, PLAN_ITEMS, LOCAL_LIMITS, recordBehind, refusalHold, buildSpend } from './brain.mjs';
import { buildOffers, trainCost, HOST_TROOPS, TRANSIT_SLOTS, copyNumber } from '../../../../permutation-server/web/frontier/hud/rulebook.mjs';
import { BUILD_ITEMS } from '../../../../permutation-server/web/frontier/fland.mjs';
import { RESOURCE_ORDER } from '../../../../permutation-server/web/frontier/resources.mjs';
import { WIDE_ORDERS, WIDE_HOST_ORDERS, WIDE_LIMITS, EXPEDITION, saveHold, claimNotDue, claimSettling, claimNotFinal, claimCost, claimOrder, expeditionNotDue, wideHostDecision, departMeta, expeditionFields } from './wide.mjs';

export const PLAN_SCHEMA = 'p04-plan/0.1';
/** The orders a plan may hold (workstreams/04-execution src/plans.rs LOCAL_ORDERS). */
export const PLAN_ORDERS = Object.freeze(['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster', ...WIDE_ORDERS]);
export const PLAN_LIMITS = Object.freeze({
  /** steps in a plan the resident makes */
  steps: 12,
  /** turns one step may wait (resources, a full queue, the province's resolved turn) before the plan is remade */
  maxWaitBells: 48,
  /** plans one resident makes in one world (a cap on replanning churn) */
  maxPlans: 24,
  /** spearmen per training step, and the host's size */
  trainN: 100,
  musterTroops: 100,
});

const stockOf = obs => (obs?.stores ?? []).map(s => s.value);
const rateOf = obs => (obs?.stores ?? []).map(s => s.perHour);
const vOf = obs => ({ holding: { p: obs.holding.p, q: obs.holding.q, site: obs.holding.site } });

/**
 * The steps of a new plan for a village (`obs` from observe.mjs with a readable village): `builds` builds of the
 * goal's plan (each the resource the village makes least of), with a harvest, two trainings and a host woven in:
 *   B B B Harvest Train B B Train B … Muster
 * → `[{name, fields, expect, note}]` (p04-plan/0.1 steps), or null when the village is not readable.
 */
export function makePlanSteps(obs, goal, { limits = PLAN_LIMITS, mem = null } = {}) {
  if (!obs?.holding || !obs.settled || !Array.isArray(obs.stores) || obs.stores.length < 6) return null;
  const n = Math.max(4, limits.steps);
  const builds = n - 4;   // + Harvest, Train, Train, Muster
  const chain = planBuildsReal(obs.settled, rateOf(obs), builds, obs.nowSecs ?? 0);
  const b = chain.map(c => ({ name: 'Build', fields: { item: c.item }, expect: { copy: c.n }, note: `${BUILD_ITEMS[c.item].resource} copy ${c.n}` }));
  const train = { name: 'Train', fields: { unit: 0, n: limits.trainN }, expect: {}, note: `${limits.trainN} spearmen` };
  const steps = [];
  const take = k => steps.push(...b.splice(0, k));
  take(3);
  steps.push({ name: 'Harvest', fields: {}, expect: {}, note: 'settle my village (the owner\'s touch)' });
  steps.push({ ...train });
  take(2);
  steps.push({ ...train });
  take(b.length);
  steps.push({ name: 'Muster', fields: { unit: 0, troops: limits.musterTroops, tile: obs.holding.tile ?? null }, expect: { reserveAtLeast: limits.musterTroops }, note: `a host of ${limits.musterTroops} guards the village` });
  // (LP9-4: a Build the chain refused for resources, still held, is not the plan's first step: the first step that
  //  is not such a Build goes first — each replan began with the same refused mine, sent at once)
  const held = st => st.name === 'Build' && refusalHold(mem, obs, st.fields.item);
  if (held(steps[0])) { const i = steps.findIndex(st => !held(st)); if (i > 0) steps.unshift(...steps.splice(i, 1)); }
  // (external-wide-orders: the wide land's steps first, each followed by two of the village's own — wideSteps)
  const front = mem ? wideSteps(obs, mem, { limits }) : [];
  // (a touch before its claim stays next to it: builds between them would spend the saved cost — live run2)
  if (front[0]?.name === 'Harvest') steps.unshift(...front); else front.forEach((w, k) => steps.splice(k * 3, 0, w));
  return steps;
}

/**
 * (external-wide-orders) The wide land's steps of a new plan, in a local wide-land world with `obs.wideLand` (wide.mjs):
 *   a ready rim host, an expedition due        [Expedition]
 *   a wide village with the planner's next act  its chain from there: [WideTrain, WideMuster, WideDepart] (or the tail)
 *   a wide claim due, its settler cost in the stores or covered by production within the plan's wait
 *                                              [WideClaim] (the plan waits for the stores: the save)
 *   an expedition due and no host at home       [Train 100 (reserve short), Muster, Expedition]
 * → steps (p04-plan/0.1; a wide act's fields are made when it is sent: its seal, arrival and site are of that turn).
 */
export function wideSteps(obs, mem, { limits = PLAN_LIMITS } = {}) {
  if (!obs?.wideLand || !obs.holding) return [];
  const xNot = expeditionNotDue(obs, mem), x = obs.wideLand.expedition;
  const step = (name, note, fields = {}, expect = {}) => ({ name, fields, expect, note });
  if (!xNot && x?.ok) return [step(EXPEDITION, 'a ready host of my rim village marches into the wide land')];
  const hd = wideHostDecision(obs, mem);
  if (hd.decision) return WIDE_HOST_ORDERS.slice(Math.max(0, WIDE_HOST_ORDERS.indexOf(hd.decision.name))).map(n => step(n, `my wide village: ${n}`));
  // (an expedition due, no host at home, the reserve already holds one: a muster spends nothing of a claim's settler cost,
  //  so the host is formed and sent before the save — live run2: a fresh rim village holds a reserve from the start)
  const reserve0 = Number(obs.settled?.reserve?.[0] ?? 0);
  if (!xNot && x && x.hosts === 0 && obs.holding.tile !== undefined && reserve0 >= limits.musterTroops) {
    const troops = Math.min(HOST_TROOPS.max, Math.floor(reserve0 / 100) * 100, 300);
    return [step('Muster', `a host of ${troops} for an expedition into the wide land`, { unit: 0, troops, tile: obs.holding.tile }, { reserveAtLeast: troops }), step(EXPEDITION, 'the new host marches into the wide land')];
  }
  // (ws13-territory: a site whose tile is claimed first — the brain's own tile claim, not a plan step — is a claim due too)
  const co = !claimNotDue(obs, mem) && !claimSettling(obs, mem) ? claimOrder(obs, mem) : {};
  if (co.order || co.tileFirst) {
    const c = coverable(obs, claimCost(obs).need);
    // (a provisional first village with the cost in the stores: the owner's touch first — the lazy final flip)
    if (claimNotFinal(obs) && !Object.keys(c.short).length) return [step('Harvest', 'the owner\'s touch: the program flips my provisional village to final on my own next action'), step('WideClaim', `claim wide land (slot ${obs.wideLand.slot})`)];
    if (Number.isFinite(c.bells) && c.bells <= WIDE_LIMITS.savePatienceBells) return [step('WideClaim', `claim wide land (slot ${obs.wideLand.slot}): the settler cost ${Object.keys(c.short).length ? `in about ${c.bells} turn(s)` : 'is in my stores'}`)];
  }
  if (!xNot && x && x.hosts === 0 && obs.holding.tile !== undefined) {
    const reserve = Number(obs.settled?.reserve?.[0] ?? 0), troops = Math.min(HOST_TROOPS.max, Math.max(limits.musterTroops, Math.floor(reserve / 100) * 100));
    const muster = step('Muster', `a host of ${troops} for an expedition into the wide land`, { unit: 0, troops, tile: obs.holding.tile }, { reserveAtLeast: troops });
    return [...(reserve < troops ? [step('Train', `${troops - Math.floor(reserve / 100) * 100} spearmen for the expedition's host`, { unit: 0, n: Math.max(100, troops - Math.floor(reserve / 100) * 100) })] : []), muster, step(EXPEDITION, 'the new host marches into the wide land')];
  }
  return [];
}

/** The plan spec (p04-plan/0.1) the store accepts. */
export function planSpec({ planId, owner, world, goal, steps, replaces = null }) {
  return { schema: PLAN_SCHEMA, planId, owner, world, goal, ...(replaces ? { replaces } : {}), maxAttempts: 3, steps };
}

/** Production alone covers `cost` (by resource index) within `patience` turns? → {short, bells} (bells Infinity: never). */
export function coverable(obs, cost) {
  const stock = stockOf(obs), rate = rateOf(obs);
  let bells = 0;
  const short = {};
  (cost ?? []).forEach((c, r) => {
    const s = c - (stock[r] ?? 0);
    if (s > 0) {
      short[RESOURCE_ORDER[r]] = s;
      const perBell = (rate[r] ?? 0) / 6;
      bells = Math.max(bells, perBell > 0 ? Math.ceil(s / perBell) : Infinity);
    }
  });
  return { short, bells };
}

const failHeld = (mem, key, bell) => {
  const f = mem?.failures?.[key];
  return f && Number.isInteger(f.until) && f.until > bell ? `held after ${f.count} refusal(s) until turn ${f.until}` : null;
};

/**
 * Whether plan step `step` (a view step of the store: {idx, name, fields, expect}) may be sent now. Every check is
 * one the page makes for a person; nothing is guessed (an unread number is a wait). `patience` (turns): how long a
 * shortfall may take production to cover before the step is a replan.
 */
export function checkStep(step, obs, mem, { patience = 36 } = {}) {
  const bell = obs?.bell;
  if (!PLAN_ORDERS.includes(step?.name)) return { replan: `step ${step?.idx}: ${step?.name} is not a local order` };
  if (WIDE_ORDERS.includes(step.name)) return checkWideStep(step, obs, mem, { patience });
  if (!obs?.holding || !obs.settled || !Array.isArray(obs.stores) || obs.stores.length < 6) {
    return step.name === 'Join' || step.name === 'PlaceHome' ? { replan: 'plans start once the village exists' } : { wait: 'my village\'s record is not readable' };
  }
  const v = vOf(obs);
  const cand = (id, kind, order) => ({ go: { id, kind, order, score: 1, why: `plan step ${step.idx}: ${step.note ?? step.name}` } });
  const fh = failHeld(mem, step.name === 'Build' ? `Build:${step.fields.item}` : step.name, bell);
  if (fh) return { wait: fh };
  switch (step.name) {
    case 'Build': {
      const item = step.fields.item;
      if (!PLAN_ITEMS.includes(item)) return { replan: `build item ${item} is not one of my plan's` };
      const rh = refusalHold(mem, obs, item);
      if (rh) return { wait: rh };
      // (LP9-4: reconcile with my own landed builds before replanning. The herald trails the chain: a build that
      //  landed and is not in the record yet reads as one copy fewer — wait for it, never replan or price from it)
      const behind = recordBehind(obs, mem, item);
      if (behind) return { wait: behind };
      const now = copyNumber(obs.settled, item);
      // (a copy above the plan's: one exists already, replan; below it with my landed builds covering it: waited above)
      if (Number.isInteger(step.expect?.copy) && now !== step.expect.copy) return { replan: `state changed: ${BUILD_ITEMS[item].resource} would be copy ${now}, the plan expected copy ${step.expect.copy}` };
      const o = buildOffers(obs.settled, { now: obs.nowSecs, have: stockOf(obs), faction: obs.faction }).find(x => x.item === item);
      if (!o) return { replan: `the page no longer offers ${BUILD_ITEMS[item].resource}` };
      const blocks = o.blocks.filter(b => b !== 'Insufficient' && b !== 'QueueFull');
      if (blocks.length) return { replan: `the page says ${blocks.join(', ')}` };
      if (o.blocks.includes('Insufficient')) {
        const c = coverable(obs, o.cost);
        if (!Number.isFinite(c.bells) || c.bells > patience) return { replan: `short ${JSON.stringify(c.short)}: production covers it in ${Number.isFinite(c.bells) ? c.bells : 'no'} turn(s), past my patience ${patience}` };
        return { wait: `short ${JSON.stringify(c.short)} for ${BUILD_ITEMS[item].resource}: about ${c.bells} turn(s) of production` };
      }
      if (o.blocks.includes('QueueFull')) return { wait: 'the build queue is full: waiting for a building to finish' };
      // (external-wide-orders: a wide claim being saved for — this build would spend it: the plan is remade, claim first)
      const sh = saveHold(obs, mem, buildSpend(obs, item)); if (sh) return { replan: sh };
      return cand(`build:${item}`, 'build', { name: 'Build', v: { ...v, item }, fields: { item } });
    }
    case 'Train': {
      const pv = Number(obs.programVersion ?? 1);
      const cost = trainCost(step.fields.unit, step.fields.n, pv);
      if (!cost) return { replan: `no training price for unit ${step.fields.unit} × ${step.fields.n}` };
      const c = coverable(obs, cost);
      if (Object.keys(c.short).length) {
        if (!Number.isFinite(c.bells) || c.bells > patience) return { replan: `training short ${JSON.stringify(c.short)} past my patience` };
        return { wait: `training short ${JSON.stringify(c.short)}: about ${c.bells} turn(s)` };
      }
      { const sh = saveHold(obs, mem, cost); if (sh) return { replan: sh }; }
      return cand(`train:${step.fields.unit}`, 'train', { name: 'Train', v, fields: { unit: step.fields.unit, n: step.fields.n } });
    }
    case 'Muster': {
      const reserve = Number(obs.settled.reserve?.[step.fields.unit] ?? 0);
      const troops = step.fields.troops;
      if (!(troops >= HOST_TROOPS.min && troops <= HOST_TROOPS.max)) return { replan: `a host of ${troops} is outside ${HOST_TROOPS.min}–${HOST_TROOPS.max}` };
      if (obs.holding.tile === undefined) return { wait: 'my village\'s tile is not known' };
      if (step.fields.tile !== obs.holding.tile) return { replan: `state changed: my village's tile is ${obs.holding.tile}, the plan has ${step.fields.tile}` };
      if (reserve < troops) return { wait: `reserve ${reserve} spearmen: the host needs ${troops} (training under way finishes into the reserve)` };
      const busy = (obs.settled.transit ?? []).filter(t => t && Number(t.state ?? 0) !== 0).length;
      if (busy >= TRANSIT_SLOTS) return { wait: 'every host slot is in use' };
      const rn = obs.province?.resolvedNext;
      if (!Number.isInteger(rn)) return { wait: 'my province\'s resolved turn is not read' };
      if (rn + 1 < bell) return { wait: `my province is resolved to turn ${rn}; a muster waits until it reaches turn ${bell - 1} (resident_ok)` };
      return cand(`muster:${step.fields.unit}`, 'muster', { name: 'Muster', v, fields: { unit: step.fields.unit, troops, tile: step.fields.tile } });
    }
    case 'Harvest':
      return cand('harvest', 'harvest', { name: 'Harvest', v, fields: {} });
    default:
      return { replan: `${step.name} is made by the resident's own brain, not a plan, in this client` };
  }
}

/**
 * (external-wide-orders) A wide step: the same checks as the brain's wide candidates (wide.mjs), never a guess; the
 * order is made now (its site, seal and arrival are this turn's). A step the world no longer asks for (a wide village
 * exists, the planner wants another act, no host at home) is a replan; one that only needs time (the stores, a claim
 * settling, a host forming, the province catching up) is a wait.
 */
export function checkWideStep(step, obs, mem, { patience = 36 } = {}) {
  const bell = obs?.bell;
  if (!obs?.holding || !obs.settled || !Array.isArray(obs.stores) || obs.stores.length < 6) return { wait: 'my village\'s record is not readable' };
  if (!obs.wideLand) return { wait: 'the wide land is not read this turn' };
  const fh = failHeld(mem, step.name, bell);
  if (fh) return { wait: fh };
  const why = `plan step ${step.idx}: ${step.note ?? step.name}`;
  if (step.name === 'WideClaim') {
    const no = claimNotDue(obs, mem); if (no) return { replan: no };
    const settling = claimSettling(obs, mem); if (settling) return { wait: settling };
    const o = claimOrder(obs, mem); if (!o.order) return o.tileFirst ? { wait: o.why } : { replan: o.why };
    // (the provisional → final flip is LAZY: the program applies it in the prologue of the owner's own next action
    //  (frontier-abi prologue.rs finality_due / apply_finality). A plan that only saves never acts, so the village never
    //  flips — live run2, provisional 250+ turns. Not final and untouched for a while: the plan is remade with a Harvest
    //  (the owner's touch, it spends nothing) before the claim; touched recently: wait)
    const nf = claimNotFinal(obs);
    if (nf) {
      const last = Number.isInteger(mem?.lastTouchBell) ? mem.lastTouchBell : -Infinity;
      return bell - last >= LOCAL_LIMITS.touchEveryBells ? { replan: `${nf}: a touch first (the program flips a due village to final on the owner's next action)` } : { wait: nf };
    }
    const cost = claimCost(obs);
    if (!cost.affordable) {
      const c = coverable(obs, cost.need);
      // (the save's patience, not a build's: the claim step is the plan's save — a step waited past the plan's own wait is
      //  remade by the executor, and the remade plan saves on)
      const save = Math.max(patience, WIDE_LIMITS.savePatienceBells);
      if (!Number.isFinite(c.bells) || c.bells > save) return { replan: `the settler cost is short ${JSON.stringify(c.short)} past my patience ${save}` };
      return { wait: `saving for the settler cost: short ${JSON.stringify(c.short)}, about ${c.bells} turn(s)` };
    }
    return { go: { id: `wideclaim:${o.site}`, kind: 'wideclaim', site: o.site, order: o.order, score: 1, why } };
  }
  if (step.name === EXPEDITION) {
    const no = expeditionNotDue(obs, mem); if (no) return { replan: no };
    const x = obs.wideLand.expedition;
    if (x?.ok) return { go: { id: 'expedition', kind: 'expedition', order: { name: EXPEDITION, v: {}, fields: expeditionFields(x.plan) }, plan: x.plan, score: 1, why } };
    if (x && x.hosts === 0) return { replan: 'no host at home for the expedition' };
    // (only a host still forming or resting is a matter of time; no passable path, no border, another Season: the plan
    //  is remade without it — live run1: every path from a rim village was RouteImpassable, and the step blocked the plan)
    if (!x || /host is not ready/.test(x.why ?? '')) return { wait: `the expedition is not ready: ${x?.why ?? 'not read'}` };
    return { replan: `no expedition from here now: ${x.why}` };
  }
  // WideTrain / WideMuster / WideDepart: the page's planner's act of this turn
  if (!obs.wideLand.villages.length) return { wait: 'my wide village is not founded (or not read) yet' };
  const hd = wideHostDecision(obs, mem);
  if (hd.decision) {
    if (hd.decision.name !== step.name) return { replan: `state changed: my wide village's next act is ${hd.decision.name}, the plan has ${step.name}` };
    const d = hd.decision;
    return { go: { id: `wide:${d.name}`, kind: 'widehost', order: { name: d.name, v: d.v, fields: d.fields }, ...(departMeta(d) ? { meta: departMeta(d) } : {}), score: 1, why: `${why}: ${d.why}` } };
  }
  if (hd.wait === 'cap') return { replan: hd.why };
  return { wait: `my wide village: ${hd.why}` };
}

export { LOCAL_LIMITS };
