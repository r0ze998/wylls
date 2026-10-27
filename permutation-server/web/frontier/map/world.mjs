// The world's extent (map growth, docs/frontier/map-growth/): what a place
// is before any question of what the viewer has seen.
//
//   outside    its ring is beyond the season's rMax: never land this season
//   unopened   its ring is not open: no land yet (OpenRing opens the next ring
//              when the crowding rule holds; the cloud sea lies there)
//   pending    its ring is open but its seed is still on its way, or the
//              Province is not on chain yet (the keeper is creating it)
//   open       on chain. Fog over open land is the viewer's survey
//              (map/survey.mjs: chart, surveyed, in sight), never a state of
//              the world: everything open is public.
//
// From the herald's season record: `rings` (the seeded rings, 0..n−1),
// `ringsOpened` (also the rings whose seed is on its way), `ringProvinces`
// (Provinces on chain per ring) and `rMax`; for a ring only partly on
// chain, `/h/world/ring/{d}` names its Provinces (`present`). An older
// herald without the new fields gives `open` / `unopened` as before.
// Pure: no DOM, no fetch.
import { FLATTEN, RADIUS } from '../../map.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { locate, ringOf, ringProvinces, ringSize } from '../fgeo.mjs';
import { provinceCorners, provincePixel } from './layers.mjs';

export const PLACE = Object.freeze({ open: 'open', pending: 'pending', unopened: 'unopened', outside: 'outside' });

const int = Number.isInteger;

/** The extent of the world from the season record: `{ringsOpen, ringsOpened, rMax, ringProvinces}`. */
export function worldOf(record) {
  const ringsOpen = Math.max(1, record?.rings?.length ?? 1);
  const ringsOpened = int(record?.ringsOpened) ? Math.max(ringsOpen, record.ringsOpened) : ringsOpen;
  const rMax = int(record?.rMax) ? record.rMax : null;
  const ringProvinces = Array.isArray(record?.ringProvinces) ? record.ringProvinces : null;
  return { ringsOpen, ringsOpened, rMax, ringProvinces };
}

/** Seeded rings with some of their Provinces not on chain yet (each wants its `/h/world/ring/{d}` list). */
export function partialRings(w) {
  const out = [];
  for (let d = 0; d < w.ringsOpen; d++) {
    const n = w.ringProvinces?.[d];
    if (int(n) && n < ringSize(d)) out.push(d);
  }
  return out;
}

/**
 * What place (p, q) is (PLACE). `present(d)`: the Set of "p,q" on chain in ring d when the page has its list,
 * else null (a partly created ring without its list counts as open: the herald's province answer decides).
 */
export function placeOf(w, p, q, present = () => null) {
  const d = ringOf(p, q);
  if (w.rMax !== null && d > w.rMax) return PLACE.outside;
  if (d >= w.ringsOpened) return PLACE.unopened;
  if (d >= w.ringsOpen) return PLACE.pending;
  const n = w.ringProvinces?.[d];
  if (int(n) && n < ringSize(d)) {
    const set = present(d);
    if (set && !set.has(`${p},${q}`)) return PLACE.pending;
  }
  return PLACE.open;
}

/**
 * placeOf for the page's state: `FS.world` (from the season record, else worked out from it) and `FS.worldRings`;
 * null while the page has no season record (the caller keeps its own answer).
 */
export function placeNow(FS, p, q) {
  if (!FS.world && !FS.record) return null;
  return placeOf(FS.world ?? worldOf(FS.record), p, q, d => FS.worldRings?.get?.(d) ?? null);
}

/** How many rings past the open land the season's border is drawn from (further out it lies off the sheet). */
export const EDGE_NEAR_RINGS = 2;
/** Whether the border of a map of `rMax` rings is near enough to `ringsOpen` open rings to be drawn. */
export const edgeNear = (rMax, ringsOpen) => int(rMax) && rMax <= Math.max(0, ringsOpen - 1) + EDGE_NEAR_RINGS;

/** The season's border (edgeSegments) on a world-transformed canvas: a dark dashed ink over a paper halo, widths in screen px. */
export function paintEdge(ctx, segs, scale = 1) {
  if (!segs.length) return;
  ctx.save();
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of segs) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(244,239,224,.9)'; ctx.lineWidth = 6 / scale; ctx.setLineDash([]); ctx.stroke();
  ctx.strokeStyle = '#3a2a22'; ctx.lineWidth = 2.5 / scale; ctx.setLineDash([10 / scale, 7 / scale]); ctx.stroke();
  ctx.restore();
}

/** The map's answer to a tap on a place that is not open land. */
export const PLACE_NOTE = Object.freeze({
  outside: () => L`ここはこのシーズンの地図の外です`,
  unopened: () => L`まだひらいていない土地です`,
  pending: () => L`この土地は生まれるところです（しばらくお待ちください）`,
});

/** The ring as the inspector says it, with what the place is. */
export function ringText(state, ring) {
  if (state === PLACE.outside) return L`第${fmtNum(ring)}輪（このシーズンの地図の外）`;
  if (state === PLACE.unopened) return L`第${fmtNum(ring)}輪（まだひらいていません）`;
  if (state === PLACE.pending) return L`第${fmtNum(ring)}輪（生まれるところです）`;
  return L`第${fmtNum(ring)}輪`;
}

/** The tile under world pixel (x, y) (the inverse of map.mjs's layout, as map/cloudsea.mjs rounds it). */
export function hexAtPixel(x, y) {
  const fy = y / FLATTEN, rf = ((2 / 3) * fy) / RADIUS, qf = ((Math.sqrt(3) / 3) * x - fy / 3) / RADIUS;
  let q = Math.round(qf), r = Math.round(rf);
  const s = Math.round(-qf - rf), dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s + qf + rf);
  if (dq > dr && dq > ds) q = -r - s; else if (dr > ds) r = -q - s;
  return { q, r };
}

const edges = new Map();
/**
 * The outer border of the season's map: the sides of ring rMax's provinces that face a province beyond rMax, as
 * world-pixel segments `[[x0, y0, x1, y1]]` (a side faces outward when the point a little past its middle lies in a
 * province of a ring above rMax). Empty without an rMax. Kept per rMax (12·rMax + 6 sides at most).
 */
export function edgeSegments(rMax) {
  if (!int(rMax) || rMax < 0) return [];
  if (edges.has(rMax)) return edges.get(rMax);
  const out = [];
  for (const { p, q } of ringProvinces(rMax)) {
    const pts = provinceCorners(p, q), c = provincePixel(p, q);
    for (let k = 0; k < 6; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % 6];
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const h = hexAtPixel(mx + (mx - c.x) * 0.12, my + (my - c.y) * 0.12);
      const at = locate(h.q, h.r);
      if (ringOf(at.p, at.q) > rMax) out.push([x0, y0, x1, y1]);
    }
  }
  edges.set(rMax, out);
  return out;
}
