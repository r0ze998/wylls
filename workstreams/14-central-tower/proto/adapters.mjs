// Connection points of the ⑭ prototype with the other workstreams. Each is a
// stub until that workstream's material is received; the stub is named as such
// in the prototype and in README.ja.md.
//
//   ① requests and cooperation  NOT RECEIVED. The model's own barter requests
//      stand in (model.mjs: post / help / board). `REQUEST_PORT` is the shape ⑭
//      needs from ①: if ① already shows every request to every nation, case B
//      adds nothing (switch `requestVisibility` to 'world' to see this).
//   ⑧ dispersed placement and the expanded map  NOT RECEIVED. `placeVillages`
//      places villages by a rule of ⑭'s own: 'compact' keeps them in the rings
//      the S1_LOCAL_14D preset lets players settle (2..3, heartland_max_ring 3);
//      'dispersed' spreads them over rings 2..8 as a placeholder for ⑧.
//   ⑮ achievement and victory  ⑭ hands over facts only. `toFacts` is the
//      export; it carries no winner, score or end of the world.
import { ringProvinces, sextant } from './geometry.mjs';

/** What ⑭ needs from ①'s requests (a description, not code that ① must adopt). */
export const REQUEST_PORT = Object.freeze({
  received: false,
  needs: [
    'who can see a request (own nation / allies / everyone)',
    'what a request promises in return (barter, nothing, a record)',
    'whether dispatch and arrival are separate states (handoff note: do not confuse them)',
    'how a request that is not paid is recorded',
  ],
});

/**
 * What ⑭ needs to know about periods (a description). ⑭ keeps no World or
 * Period of its own: the model's `periodHours` only marks a boundary as a
 * fact so tests can cross one. The real source is ⑧'s continuing-world
 * design, collected by ④.
 */
export const PERIOD_PORT = Object.freeze({
  received: false,
  from: '⑧ → ④',
  needs: [
    'whether a period boundary exists for the tower at all, and where its time comes from',
    'which tower facts a period-scoped evaluation (⑮) reads, without the tower closing',
    'whether on-chain addresses stay per-season (AddrCtx.season) or move to a world key, and how old ones are read',
  ],
});

/** What ⑭ needs from ⑧'s placement (a description). */
export const PLACEMENT_PORT = Object.freeze({
  received: false,
  needs: ['the rings and provinces villages are placed in, by nation and by join time', 'whether the map grows during a period and where', 'whether the Concord stays at ring 0 of the expanded map'],
});

/**
 * Village placements: [{nation, prov: {p, q}}], `P.nations[k]` villages in wedge k.
 * A village takes a free province of its wedge in the allowed rings, nearest
 * ring first for 'compact' (as the client's join list sorts, fjoin.mjs) and
 * evenly over the rings for 'dispersed'. Several villages may share a
 * province (12 sites each, geometry.rs).
 */
export function placeVillages(P, R) {
  const rings = P.placement === 'dispersed' ? [2, 3, 4, 5, 6, 7, 8] : [2, 3];
  const byWedge = P.nations.map(() => []);
  for (const d of rings) for (const pv of ringProvinces(d)) {
    const w = sextant(pv.p, pv.q);
    if (w < byWedge.length) byWedge[w].push({ ...pv, ring: d });
  }
  const out = [];
  P.nations.forEach((n, k) => {
    const cands = byWedge[k];
    for (let i = 0; i < n; i++) {
      const pick = P.placement === 'dispersed'
        ? cands.filter(c => c.ring === rings[i % rings.length])
        : cands;
      const pool = pick.length ? pick : cands;
      const c = pool[Math.floor(R() * pool.length)];
      out.push({ nation: k, prov: { p: c.p, q: c.q } });
    }
  });
  return out;
}

/** The facts ⑭ hands to ⑮: tower state and actions, nothing decided. */
export function toFacts(sim) {
  return {
    schema: 'wylls.ws14.tower-facts/0',
    case: sim.case,
    params: { ...sim.P, rules: undefined },
    tower: sim.case === 'C' ? { stage: sim.tower.stage, dormant: sim.tower.dormant, stock: { ...sim.tower.stock }, completedAtHour: [...sim.tower.completedAt], lapses: sim.tower.lapses } : null,
    events: sim.facts.filter(f => f.kind.startsWith('tower.') || f.kind.startsWith('centre.')),
  };
}
