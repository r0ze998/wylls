// Which keeps of other nations a march of the viewer can reach (conquest):
// one question to the rules kernel per keep and origin (fmarch.planRoute, the
// composer's own planner: at most 4 provinces and MAX_PATH_STEPS steps), over
// the keeps the page already holds for the control snapshot. No request is
// made here. A guide only: the route the composer plans is what a march takes.
import { planRoute } from './fmarch.mjs';

/** A march may cross this many provinces (planRoute refuses a longer route; the program re-checks at Reveal). */
export const MAX_ROUTE_PROVINCES = 4;

const list = keeps => (keeps instanceof Map ? [...keeps.values()] : Object.values(keeps ?? {}));
const tileOk = t => Number.isInteger(t) && t >= 0 && t < 61;

/**
 * The keeps a march could be sent against now: held by another nation (0–5),
 * not a heartland, and not inside a known protection after a capture (a keep
 * whose protection the page has not read yet stays in: its panel says so).
 */
export function contestableKeeps(keeps, { faction, nowBell = 0 }) {
  return list(keeps).filter(k => k && Number.isInteger(k.p) && Number.isInteger(k.q) && tileOk(k.tile)
    && Number.isInteger(k.holder) && k.holder >= 0 && k.holder <= 5 && k.holder !== faction && !k.heartland
    && !(Number.isInteger(k.consolidatedUntil) && k.consolidatedUntil > nowBell));
}

/**
 * The reachable list: `{ok, rows, unreachable}` or `{ok: false, code}`.
 *   origins  `[{p, q, tile, unit, host?, troops?}]` (ready hosts, or the home tile with unit 0)
 *   rows     `[{p, q, tile, holder, troops, route: {hexes, provinces, secs}, origin}]`, the
 *            fastest origin of each keep, sorted by travel time
 *   unreachable  `['p,q', …]`: candidate keeps no origin has a route to
 */
export function reachableKeeps({ kernel, keeps, origins = [], seeds = [], faction, nowBell = 0 }) {
  if (!kernel) return { ok: false, code: 'NoKernel' };
  const rows = [], unreachable = [];
  for (const k of contestableKeeps(keeps, { faction, nowBell })) {
    let best = null;
    for (const o of origins) {
      const r = planRoute(kernel, { from: { p: o.p, q: o.q, tile: o.tile }, to: { p: k.p, q: k.q, tile: k.tile }, unit: o.unit, seeds });
      if (r.ok && (!best || r.route.secs < best.route.secs)) best = { route: r.route, origin: o };
    }
    if (best) rows.push({ p: k.p, q: k.q, tile: k.tile, holder: k.holder, troops: k.troops, origin: best.origin,
      route: { hexes: best.route.hexes, provinces: best.route.provinces, secs: best.route.secs } });
    else unreachable.push(`${k.p},${k.q}`);
  }
  rows.sort((a, b) => a.route.secs - b.route.secs || a.route.hexes - b.route.hexes || a.p - b.p || a.q - b.q);
  return { ok: true, rows, unreachable };
}

/** The cache key: every origin's tile and unit, the turn, and the control snapshot the keeps came from. */
export function reachKey({ origins = [], nowBell = 0, controlBell = null, faction = null }) {
  return `${faction}|${nowBell}|${controlBell}|${origins.map(o => `${o.p},${o.q},${o.tile},${o.unit}`).join(';')}`;
}

/**
 * The list through a cache: `cache` is the last answer (`{key, …}`) or null;
 * the same origins, turn and control snapshot give it back without asking the
 * kernel again. A missing kernel is not cached (it may load later).
 */
export function cachedReach(cache, args) {
  const key = reachKey({ origins: args.origins, nowBell: args.nowBell, controlBell: args.controlBell, faction: args.faction });
  if (cache?.key === key && cache.ok) return cache;
  return { key, home: !!args.home, ...reachableKeeps(args) };
}
