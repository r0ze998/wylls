// A route the program accepts when the kernel's own planner finds none (fmarch.planRoute's fallback).
//
// The kernel's planner (frontier-wasm path.rs `plan`) searches for the cheapest route by hex alone and checks the
// 4-province limit only at the end, so a fast route that crosses a fifth province hides a slower legal one, and a fast
// but long route hides a short one within 32 steps. This search keeps the limits IN its state: a state is a hex plus
// the provinces the steps have entered (≤ MAX_PATH_PROVINCES, the start province only once a step enters it, as the
// program's `travel::path_cost` counts them), at most MAX_PATH_STEPS steps, breadth-first (fewest steps first). Terrain
// comes from the same kernel (`generate_province` of each ring's seed: the province records the chain writes at
// OpenProvince). The answer is never trusted on its own: the kernel's `path_cost` must accept the directions and end on
// the destination. The search has an explicit budget of states; past it the answer is `PlannerBudget`, never a guess.
// Nothing here is sent or stored.
import { tileHex, locate, ringOf, DIRECTIONS } from './fgeo.mjs';
import { encodePath } from './seal.mjs';

export const BOUNDED_MAX_STEPS = 32;
export const BOUNDED_MAX_PROVINCES = 4;
/** The most states the search visits before it gives up (`PlannerBudget`). */
export const BOUNDED_STATE_BUDGET = 60000;

const hexBytes = h => Uint8Array.from(String(h).match(/../g) ?? [], x => parseInt(x, 16));
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;

/**
 * `{ok: true, route: {dirs, pathLen, path, secs, hexes, provinces, bounded: true}}`, or `{ok: false, code}`:
 * `NoKernel`, `BadTile`, `NoPath` (no route within the limits), `PlannerBudget`, `CostRefused` (the kernel's check
 * refused what the search found: never offered).
 */
export function planBounded(kernel, { from, to, unit = 0, seeds = [], blocked = [] }, { budget = BOUNDED_STATE_BUDGET } = {}) {
  if (!kernel) return { ok: false, code: 'NoKernel' };
  const start = tileHex(from.p, from.q, from.tile), dest = tileHex(to.p, to.q, to.tile);
  if (!start || !dest) return { ok: false, code: 'BadTile' };
  if (dist(start, dest) > BOUNDED_MAX_STEPS || (start.q === dest.q && start.r === dest.r)) return { ok: false, code: 'NoPath' };
  const seedOf = new Map((seeds ?? []).map(s => [Number(s.ring), s.seed]));
  const masks = new Map();
  const passable = (p, q, idx) => {
    const key = `${p},${q}`;
    if (!masks.has(key)) {
      const seed = seedOf.get(ringOf(p, q));
      const g = seed ? kernel.call('generate_province', { ring_seed: typeof seed === 'string' ? hexBytes(seed) : seed, p, q }) : null;
      masks.set(key, g?.ok && g.value?.passableMask !== undefined && g.value.passableMask !== null ? BigInt(g.value.passableMask) : null);
    }
    const m = masks.get(key);
    return m !== null && ((m >> BigInt(idx)) & 1n) === 1n;
  };
  const blockedSet = new Set((blocked ?? []).map(h => `${h.q},${h.r}`));
  if (blockedSet.has(`${dest.q},${dest.r}`)) return { ok: false, code: 'NoPath' };
  // breadth-first over (hex, entered provinces): `prev` per state for the directions back
  const keyOf = (h, provs) => `${h.q},${h.r}|${provs.join(';')}`;
  const startKey = keyOf(start, []);
  const prev = new Map([[startKey, null]]);
  let frontier = [{ h: start, provs: [], key: startKey }];
  let visited = 0;
  for (let steps = 0; steps < BOUNDED_MAX_STEPS && frontier.length; steps++) {
    const next = [];
    for (const s of frontier) {
      for (let d = 0; d < 6; d++) {
        const n = { q: s.h.q + DIRECTIONS[d][0], r: s.h.r + DIRECTIONS[d][1] };
        if (steps + 1 + dist(n, dest) > BOUNDED_MAX_STEPS || blockedSet.has(`${n.q},${n.r}`)) continue;
        const loc = locate(n.q, n.r);
        if (!passable(loc.p, loc.q, loc.idx)) continue;
        const pk = `${loc.p},${loc.q}`;
        const provs = s.provs.includes(pk) ? s.provs : [...s.provs, pk].sort();
        if (provs.length > BOUNDED_MAX_PROVINCES) continue;
        const k = keyOf(n, provs);
        if (prev.has(k)) continue;
        if (++visited > budget) return { ok: false, code: 'PlannerBudget' };
        prev.set(k, { from: s.key, d });
        if (n.q === dest.q && n.r === dest.r) return finish(kernel, k, prev, { start, dest, unit, seeds });
        next.push({ h: n, provs, key: k });
      }
    }
    frontier = next;
  }
  return { ok: false, code: 'NoPath' };
}

function finish(kernel, key, prev, { start, dest, unit, seeds }) {
  const dirs = [];
  for (let k = key; prev.get(k); k = prev.get(k).from) dirs.push(prev.get(k).d);
  dirs.reverse();
  // the kernel's own price and check (travel::path_cost: adjacency, passability, ≤ 32 steps, ≤ 4 provinces)
  const c = kernel.call('path_cost', { start, dirs, unit, seeds });
  if (!c.ok || !c.value || c.value.end?.q !== dest.q || c.value.end?.r !== dest.r) return { ok: false, code: 'CostRefused' };
  if (c.value.provinces.length > BOUNDED_MAX_PROVINCES || dirs.length > BOUNDED_MAX_STEPS) return { ok: false, code: 'CostRefused' };
  const enc = encodePath(dirs);
  if (!enc) return { ok: false, code: 'CostRefused' };
  return { ok: true, route: { dirs, pathLen: enc.pathLen, path: enc.path, secs: c.value.secs, hexes: c.value.hexes, provinces: c.value.provinces, bounded: true } };
}
