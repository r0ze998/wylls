// ⑬ local resident's MULTI-TURN PLANS (2026-11-22, reports/playable-2-3-4-13.md §2 step 3). KEY-FREE and pure.
//
// The resident's goal (goals.mjs: plan depth, reserve, patience) becomes a plan of its own village's next orders —
// a build chain on the page's own catalogue (brain.mjs planBuildsReal), training from what the chain leaves, a host
// from the trained reserve — and workstream 04's plan store (workstreams/04-execution src/plans.rs) runs it, one
// step per turn, through restarts (executor.mjs). Only the six local orders; never a caravan (owner question Q4).
//
//   makePlanSteps(obs, goal)   → the steps of a new plan, each with what must still be true when it is sent (`expect`)
//   checkStep(step, obs, mem)  → {go: candidate} | {wait: why} | {replan: why} — the same checks the page makes
//                                (buildOffers, trainCost, the host rules, resident_ok); a step whose world changed under
//                                it (a copy that exists already, a building the page no longer offers, a shortfall
//                                production will not cover in the goal's patience) is a replan, never a blind send.
import { planBuildsReal, PLAN_ITEMS, LOCAL_LIMITS } from './brain.mjs';
import { buildOffers, trainCost, HOST_TROOPS, TRANSIT_SLOTS, copyNumber } from '../../../../permutation-server/web/frontier/hud/rulebook.mjs';
import { BUILD_ITEMS } from '../../../../permutation-server/web/frontier/fland.mjs';
import { RESOURCE_ORDER } from '../../../../permutation-server/web/frontier/resources.mjs';

export const PLAN_SCHEMA = 'p04-plan/0.1';
/** The orders a plan may hold (workstreams/04-execution src/plans.rs LOCAL_ORDERS). */
export const PLAN_ORDERS = Object.freeze(['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster']);
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
export function makePlanSteps(obs, goal, { limits = PLAN_LIMITS } = {}) {
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
  return steps;
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
      const now = copyNumber(obs.settled, item);
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

export { LOCAL_LIMITS };
