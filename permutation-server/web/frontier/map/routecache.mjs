// Cache only geometry from the planner, never the arrival clock. A route is
// determined by its kernel, endpoints, unit, ring seeds and blocked hexes.
// Same-size changes to a palisade feed are not the same walking world.
// The planner is injected so this cache has no account, wallet or IO path.
export function createRouteCache(plan, { limit = 96 } = {}) {
  const cache = new Map();
  let previousKernel = null;
  return (kernel, args) => {
    if (!kernel) return plan(kernel, args);
    if (kernel !== previousKernel) { cache.clear(); previousKernel = kernel; }
    const { from, to, unit, seeds = [], blocked = [] } = args;
    const key = JSON.stringify([
      [from.p, from.q, from.tile], [to.p, to.q, to.tile], unit,
      seeds.map(s => [s.ring, typeof s.seed === 'string' ? s.seed : Array.from(s.seed)]),
      blocked.map(h => [h.q, h.r]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    ]);
    if (cache.has(key)) {
      const value = cache.get(key);
      cache.delete(key); cache.set(key, value);
      return value;
    }
    const value = plan(kernel, args);
    cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value);
    return value;
  };
}
