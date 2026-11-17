// What a resident wants, as weights over the same terms for every resident:
// growth (more production in its own village) and use (stock it does not
// need put to work somewhere). A goal is not a job: both residents can do
// every action, run the same candidate code and see the same facts; only
// these weights and horizons differ, and the owner can change them.
import { BUILDINGS, MOVABLE, RESOURCES, prodPerBellMilli, resIndex, MILLI } from '../world/rules.mjs';

export const GOALS = Object.freeze({
  'village-first': Object.freeze({ growth: 1.0, use: 0.2, planDepth: 2, reserve: 60, patienceBells: 6, words: 'grow my own village first; trade stock I do not need for what my next buildings lack' }),
  'surplus-use': Object.freeze({ growth: 0.35, use: 1.0, planDepth: 1, reserve: 40, patienceBells: 24, words: 'put stock I do not need to use where it is needed, without starving my own village' }),
});

/** The economy buildings a plan picks from (food, wood, stone, ore, gold; science and the workshop are left to later). */
const PLAN_ITEMS = BUILDINGS.filter(b => ['Food', 'Wood', 'Stone', 'Ore', 'Gold'].includes(b.produces));

const perHour = (name, buildings) => prodPerBellMilli(resIndex(name), buildings) * 6 / MILLI;

/**
 * The next `depth` builds: each time the building of the resource the
 * village makes least of (ties: the lower item). Built and building items
 * count as owned.
 */
export function planBuilds(village, depth) {
  const owned = [...village.buildings, ...village.building.map(b => b.item)];
  const plan = [];
  for (let i = 0; i < depth; i++) {
    const next = [...PLAN_ITEMS].sort((a, b) => perHour(a.produces, owned) - perHour(b.produces, owned) || a.item - b.item)[0];
    plan.push(next);
    owned.push(next.item);
  }
  return plan;
}

/**
 * The village's ledger of wants: `needed` (the plan's cost), `idle` (stock
 * beyond the plan and the reserve, movable goods only), the next build's
 * `shortfall` and the whole plan's, and the bells production alone needs to cover each.
 */
export function assess(village, goal) {
  const plan = planBuilds(village, goal.planDepth);
  const needed = Object.fromEntries(RESOURCES.map(r => [r, 0]));
  for (const b of plan) for (const [n, v] of Object.entries(b.cost)) needed[n] += v;
  const idle = {};
  for (const r of MOVABLE) {
    const x = village.stores[r] - needed[r] - goal.reserve;
    if (x > 0) idle[r] = x;
  }
  const next = plan[0];
  const shortfall = {};
  let waitBells = 0;
  for (const [n, v] of Object.entries(next.cost)) {
    const short = v - village.stores[n];
    if (short > 0) {
      shortfall[n] = short;
      const per = prodPerBellMilli(resIndex(n), village.buildings) / MILLI;
      waitBells = Math.max(waitBells, per > 0 ? Math.ceil(short / per) : Infinity);
    }
  }
  // The whole plan's lack (what a request asks for): a resident that plans further ahead asks sooner.
  const planShortfall = {};
  let planWaitBells = 0;
  for (const [n, v] of Object.entries(needed)) {
    const short = v - village.stores[n];
    if (short > 0) {
      planShortfall[n] = short;
      const per = prodPerBellMilli(resIndex(n), village.buildings) / MILLI;
      planWaitBells = Math.max(planWaitBells, per > 0 ? Math.ceil(short / per) : Infinity);
    }
  }
  const affordable = Object.keys(shortfall).length === 0;
  return { plan, next, needed, idle, shortfall, waitBells, planShortfall, planWaitBells, affordable };
}
