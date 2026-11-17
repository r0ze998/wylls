// Geography for the placement study (../16-placement.ja.md). Off unless params.geo is set, so
// every earlier result reproduces unchanged.
//
// Coordinates are the province grid of permutation-rules/src/frontier/geometry.rs: axial (p, q),
// ring = hex distance from the Concord (0, 0), wedge = sextant (hex.rs `sextant`). Ring 1 holds
// the six Seats (capitals, never capturable), so homes start at ring 2. The code's PlaceHome puts
// a home in rings 2..heartland_max_ring (3) of the player's own wedge: 5 provinces per nation.
// `homeRingMax` widens the home area for every policy alike (density sensitivity: 3 = the code's
// heartland, about 2.8 villages per province here; 5 = about 1 per province).
//
// Placement policies (identifiers kept apart from the world-structure proposals P0/A/B1/B2/C):
//   PL-W  – clustered: every village in its own nation's wedge, rings 2–3 (the code's rule)
//   PL-G  – small groups: `group` villages of one nation share a province; the nation's groups are
//           scattered over all of rings 2–3, at least `spread` provinces apart where possible
//   PL-S  – scattered: every village in a random province of rings 2–3, nation ignored
// All three use the same home provinces (rings 2..homeRingMax), so land and distance to the centre
// are equal in expectation; only who is next to whom changes.
//
// Not modelled: the large tower at the Concord. Its rule effects are being mapped by
// workstream 1; nothing here gives the centre any value (see 16-placement.ja.md §16-2).

import { draw, drawInt } from './rng.mjs';

export const RING_MIN = 2;

export function hexDistance(a, b) {
  const dq = a.p - b.p;
  const dr = a.q - b.q;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function ring(a) {
  return hexDistance(a, { p: 0, q: 0 });
}

// hex.rs: rotate (q, r) -> (-r, q + r); unrotate (q, r) -> (q + r, -q); sextant: first k with q > 0 && r >= 0
function unrotate(h) {
  return { p: h.p + h.q, q: -h.p };
}

export function sextant(h) {
  let w = h;
  for (let k = 0; k < 6; k++) {
    if (w.p > 0 && w.q >= 0) return k;
    w = unrotate(w);
  }
  return 0;
}

export function provincesInRings(lo, hi) {
  const out = [];
  for (let p = -hi; p <= hi; p++) {
    for (let q = -hi; q <= hi; q++) {
      const h = { p, q };
      const r = ring(h);
      if (r >= lo && r <= hi) out.push({ ...h, ring: r, wedge: sextant(h), id: `${p},${q}` });
    }
  }
  return out;
}

/** Hexes on the straight line between two provinces (cube lerp, both ends included). */
export function line(a, b) {
  const n = hexDistance(a, b);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const x = a.p + (b.p - a.p) * t + 1e-6;
    const z = a.q + (b.q - a.q) * t + 1e-6;
    const y = -x - z;
    let rx = Math.round(x);
    let rz = Math.round(z);
    const ry = Math.round(y);
    const dx = Math.abs(rx - x);
    const dy = Math.abs(ry - y);
    const dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy <= dz) rz = -rx - ry;
    out.push({ p: rx, q: rz });
  }
  return out;
}

/**
 * The victory objectives of the geographic runs: six provinces one ring beyond the home area,
 * at the corners of that ring (between wedges) or at the middle of each wedge's arc.
 */
export function objectiveProvinces(layout = 'corner', r = 4) {
  const base = layout === 'mid' ? { p: Math.ceil(r / 2), q: Math.floor(r / 2) } : { p: r, q: 0 };
  const out = [];
  let h = base;
  for (let k = 0; k < 6; k++) {
    out.push({ p: h.p, q: h.q });
    h = { p: -h.q, q: h.p + h.q }; // rotate
  }
  return out;
}

export function createGeo(P) {
  const homes = provincesInRings(RING_MIN, P.homeRingMax);
  return {
    homes,
    byId: new Map(homes.map((h) => [h.id, h])),
    occ: new Map(homes.map((h) => [h.id, []])), // province id -> agent ids
    groups: [], // { nation, prov, members: [] }
    influenceDay: -1,
    influence: new Map(), // province id -> nation with the most villages (or null)
  };
}

export function resetGeo(w) {
  w.geo = createGeo(w.P);
}

function freeHomes(w) {
  return w.geo.homes.filter((h) => w.geo.occ.get(h.id).length < w.P.provCap);
}

function pick(list, u) {
  return list[Math.min(list.length - 1, Math.floor(u * list.length))];
}

function candidate(w, a, attempt) {
  const { P, geo } = w;
  const free = freeHomes(w);
  if (free.length === 0) return geo.homes[0];
  const u = draw(w.seed, 'spawn', a.id, w.period, a.starterKits, attempt);
  if (P.placement === 'PL-W') {
    const own = free.filter((h) => h.wedge === a.nation);
    if (own.length) {
      // the code fills its own heartland; take the least occupied, ties by the draw
      const minOcc = Math.min(...own.map((h) => geo.occ.get(h.id).length));
      return pick(own.filter((h) => geo.occ.get(h.id).length === minOcc), u);
    }
    return pick(free, u);
  }
  if (P.placement === 'PL-S') return pick(free, u);
  // PL-G: join an own group that still has room, else open a new group away from the nation's others
  const mine = geo.groups.filter((g) => g.nation === a.nation && g.members.length < P.group && geo.occ.get(g.prov.id).length < P.provCap);
  if (mine.length && attempt === 0) return mine[0].prov;
  const others = geo.groups.filter((g) => g.nation === a.nation).map((g) => g.prov);
  const apart = free.filter((h) => others.every((o) => hexDistance(o, h) >= P.spread));
  return pick(apart.length ? apart : free, u);
}

/** Spawn quality used only by the re-roll exploit: allies close by, enemies far, an objective near. */
function spawnScore(w, a, h) {
  let allies = 0;
  let enemies = 0;
  for (const b of w.agents) {
    if (!b.active || b.id === a.id || !b.prov) continue;
    const d = hexDistance(b.prov, h);
    if (d <= 1) {
      if (b.nation === a.nation) allies++;
      else enemies++;
    }
  }
  const fort = Math.min(...w.forts.filter((f) => f.prov).map((f) => hexDistance(f.prov, h)));
  return 2 * allies - enemies - 0.5 * fort;
}

export function assignHome(w, a) {
  const { P, geo } = w;
  let h = candidate(w, a, 0);
  const rolls = a.flags.reroll || 0;
  if (rolls > 0) {
    let best = h;
    let bestS = spawnScore(w, a, h);
    for (let k = 1; k <= rolls; k++) {
      const c = candidate(w, a, k);
      const s = spawnScore(w, a, c);
      if (s > bestS) {
        best = c;
        bestS = s;
      }
    }
    h = best;
  }
  if (a.prov) {
    const prev = geo.occ.get(a.prov.id);
    if (prev) geo.occ.set(a.prov.id, prev.filter((x) => x !== a.id));
  }
  a.prov = h;
  geo.occ.get(h.id).push(a.id);
  if (P.placement === 'PL-G') {
    let g = geo.groups.find((x) => x.nation === a.nation && x.prov.id === h.id);
    if (!g) {
      g = { nation: a.nation, prov: h, members: [] };
      geo.groups.push(g);
    }
    if (!g.members.includes(a.id)) g.members.push(a.id);
  }
}

export function leaveHome(w, a) {
  if (!a.prov || !w.geo) return;
  const occ = w.geo.occ.get(a.prov.id);
  if (occ) w.geo.occ.set(a.prov.id, occ.filter((x) => x !== a.id));
  for (const g of w.geo.groups) g.members = g.members.filter((x) => x !== a.id);
}

/** Province -> nation with the most active villages there (null when none or tied). Daily cache. */
export function influenceAt(w, h) {
  const day = Math.floor(w.t / 24);
  if (w.geo.influenceDay !== day) {
    w.geo.influence = new Map();
    const count = new Map();
    for (const a of w.agents) {
      if (!a.active || !a.prov) continue;
      const k = a.prov.id;
      if (!count.has(k)) count.set(k, new Array(w.P.nations).fill(0));
      count.get(k)[a.nation]++;
    }
    for (const [k, c] of count) {
      const m = Math.max(...c);
      const who = c.filter((x) => x === m).length === 1 ? c.indexOf(m) : null;
      w.geo.influence.set(k, who);
    }
    w.geo.influenceDay = day;
  }
  return w.geo.influence.get(`${h.p},${h.q}`) ?? null;
}

/** Share of the provinces on the way (ends excluded) held by another nation. */
export function routeHostility(w, from, to, nation) {
  const path = line(from, to).slice(1, -1);
  if (path.length === 0) return 0;
  let hostile = 0;
  for (const h of path) {
    const who = influenceAt(w, h);
    if (who !== null && who !== nation) hostile++;
  }
  return hostile / path.length;
}

/** Initial conditions of a village where it was placed (recorded once per founding). */
export function spawnConditions(w, a) {
  let nearest = Infinity;
  let allies1 = 0;
  let enemies1 = 0;
  let enemies2 = 0;
  let others1 = new Set();
  for (const b of w.agents) {
    if (!b.active || b.id === a.id || !b.prov) continue;
    const d = hexDistance(a.prov, b.prov);
    if (b.nation === a.nation) {
      nearest = Math.min(nearest, d);
      if (d <= 1) allies1++;
    } else {
      if (d <= 1) {
        enemies1++;
        others1.add(b.nation);
      }
      if (d <= 2) enemies2++;
    }
  }
  const forts = w.forts.filter((f) => f.prov && f.theater === w.theater);
  let fortDist = Infinity;
  let fortRoute = 0;
  for (const f of forts) {
    const d = hexDistance(a.prov, f.prov);
    if (d < fortDist) {
      fortDist = d;
      fortRoute = routeHostility(w, a.prov, f.prov, a.nation);
    }
  }
  return { nearestAlly: nearest, allies1, enemies1, enemies2, otherNations1: others1.size, fortDist, fortRoute, centre: ring(a.prov) };
}
