// The world's extent (map growth, docs/frontier/map-growth/): what a place
// is before any question of what the viewer has seen.
//
//   outside    its ring is beyond the season's rMax: never land this season
//              (a season without a ceiling, as every season before map growth)
//   extendable a season with a ceiling (r_max_ceiling, ExtendFrontier): beyond
//              the current rMax but within the ceiling — not on the map yet,
//              the map may still be extended to it one ring at a time
//   beyondCeiling  a season with a ceiling: beyond it — never land this season
//   beyondHard a season with a ceiling: beyond ring 128, the program's hard
//              limit (R_MAX_HARD); no season reaches it. The map is bounded,
//              never infinite
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
// (Provinces on chain per ring), `rMax` (the effective outermost ring:
// the season's r_max or the Frontier's r_max_ext), `rMaxCeiling` (0 or
// absent: no extension) and `rMaxHard` (128); for a ring only partly on
// chain, `/h/world/ring/{d}` names its Provinces (`present`). An older
// herald without the new fields gives `open` / `unopened` as before.
// Pure: no DOM, no fetch (applySeasonRecord asks a herald the caller hands
// it for ring lists; it never fetches on its own).
import { FLATTEN, RADIUS } from '../../map.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { locate, ringOf, ringProvinces, ringSize } from '../fgeo.mjs';
import { provinceCorners, provincePixel } from './layers.mjs';

export const PLACE = Object.freeze({ open: 'open', pending: 'pending', unopened: 'unopened', outside: 'outside', extendable: 'extendable', beyondCeiling: 'beyondCeiling', beyondHard: 'beyondHard' });
/** The program's hard limit of any season's outermost ring (geometry R_MAX_HARD). */
export const R_MAX_HARD = 128;

const int = Number.isInteger;

/** The extent of the world from the season record: `{ringsOpen, ringsOpened, rMax, ringProvinces}`. */
export function worldOf(record) {
  const ringsOpen = Math.max(1, record?.rings?.length ?? 1);
  const ringsOpened = int(record?.ringsOpened) ? Math.max(ringsOpen, record.ringsOpened) : ringsOpen;
  const rMax = int(record?.rMax) ? record.rMax : null;
  const ringProvinces = Array.isArray(record?.ringProvinces) ? record.ringProvinces : null;
  const w = { ringsOpen, ringsOpened, rMax, ringProvinces };
  // map growth: only a season with a ceiling above its map carries one (every other season keeps the four states)
  const ceiling = record?.rMaxCeiling;
  if (int(ceiling) && rMax !== null && ceiling > rMax) {
    w.rMaxCeiling = Math.min(ceiling, R_MAX_HARD);
    w.rMaxHard = int(record?.rMaxHard) ? record.rMaxHard : R_MAX_HARD;
  }
  return w;
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
  if (w.rMax !== null && d > w.rMax) {
    if (!int(w.rMaxCeiling)) return PLACE.outside;
    if (d > (w.rMaxHard ?? R_MAX_HARD)) return PLACE.beyondHard;
    return d <= w.rMaxCeiling ? PLACE.extendable : PLACE.beyondCeiling;
  }
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

/**
 * What a fresh season record means for the page's world state (pure; nothing is fetched here): the new `world`,
 * the partly created rings (`partial`: each wants its `/h/world/ring/{d}` list again, until it is whole) and the
 * ring lists the page holds that are no longer wanted (`drop`: the ring is whole, or the record no longer says it
 * is partial). `worldRings` is the page's Map of ring → Set of "p,q" (FS.worldRings), or null.
 *
 * Every poll of the season record goes through this, so a map that grew on chain (ExtendFrontier raised rMax,
 * OpenRing opened a ring, OpenProvince put its Provinces on chain) is seen by the next poll without a reload:
 * the inspector's state of a place, the border and the cloud sea all read `world`, never a copy taken at boot.
 */
export function worldSync(record, worldRings = null) {
  const world = worldOf(record);
  const partial = partialRings(world);
  const drop = [...(worldRings?.keys?.() ?? [])].filter(d => !partial.includes(d));
  return { world, partial, drop };
}

/**
 * Applies a fresh season record to the page's state: `FS.record`, `FS.world`, and `FS.worldRings` (the lists no
 * longer wanted dropped; each partly created ring asked of `herald.worldRing(d)` when a herald is given, `onRings(d)`
 * once a list arrives). The one place the page keeps these three together: the boot, the poll and the ticket
 * planner's re-read all call it, so none of them can leave `FS.world` behind `FS.record` (the controller's re-read
 * did, and the inspector then called a ring the herald had just put inside the map "outside" until the next poll).
 * Returns worldSync's answer.
 */
export function applySeasonRecord(FS, record, { herald = null, onRings = () => {} } = {}) {
  const s = worldSync(record, FS.worldRings ?? null);
  const revision = (FS.worldRevision ?? 0) + 1;
  FS.worldRevision = revision;
  FS.record = record;
  FS.world = s.world;
  for (const d of s.drop) FS.worldRings?.delete?.(d);
  if (herald?.worldRing) {
    for (const d of s.partial) {
      Promise.resolve().then(() => herald.worldRing(d)).then(a => { if (a?.ok && FS.worldRevision === revision && FS.record === record) { (FS.worldRings ??= new Map()).set(d, a.present); onRings(d); } }).catch(() => {});
    }
  }
  return s;
}

/**
 * The rings whose overview the page should (re)load now: every open ring (`0 .. ringsOpen − 1`) it has no overview
 * of yet, and every ring whose Province count in the season record rose or fell since its overview was taken (a
 * ring being created on chain: each OpenProvince adds a record the next overview carries). `taken` is the page's
 * Map of ring → the Province count the record showed when the overview was taken (null when the record carried no
 * counts; such a ring is asked once). Pure: the caller fetches.
 */
export function overviewRings(world, taken = null) {
  const out = [];
  if (!world) return out;
  for (let d = 0; d < world.ringsOpen; d++) {
    const n = world.ringProvinces?.[d];
    const had = taken?.get?.(d);
    if (had === undefined || (int(n) && had !== n)) out.push(d);
  }
  return out;
}

/** Records that ring d's overview was just taken, with the Province count the page's world shows for it now. */
export function overviewTaken(FS, d, requestedWorld = FS.world) {
  // Never stamp an old response with a newer Province count. A later poll retries it.
  if (FS.world !== requestedWorld) return false;
  const n = requestedWorld?.ringProvinces?.[d];
  (FS.overviewTaken ??= new Map()).set(d, int(n) ? n : null);
  return true;
}

/** How many rings past the open land the season's border is drawn from (further out it lies off the sheet). */
export const EDGE_NEAR_RINGS = 2;
/** Whether the border of a map of `rMax` rings is near enough to `ringsOpen` open rings to be drawn. */
export const edgeNear = (rMax, ringsOpen) => int(rMax) && rMax <= Math.max(0, ringsOpen - 1) + EDGE_NEAR_RINGS;

/**
 * The season's border (edgeSegments) on a world-transformed canvas: a dark dashed ink over a paper halo, widths in
 * screen px. `faint`: the ceiling of a season that may still be extended (a thinner, lighter, sparser dash).
 */
export function paintEdge(ctx, segs, scale = 1, { faint = false } = {}) {
  if (!segs.length) return;
  ctx.save();
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of segs) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(244,239,224,.9)'; ctx.lineWidth = (faint ? 4 : 6) / scale; ctx.setLineDash([]); ctx.stroke();
  ctx.strokeStyle = faint ? 'rgba(58,42,34,.55)' : '#3a2a22'; ctx.lineWidth = (faint ? 1.5 : 2.5) / scale;
  ctx.setLineDash(faint ? [4 / scale, 9 / scale] : [10 / scale, 7 / scale]); ctx.stroke();
  ctx.restore();
}

/** The map's answer to a tap on a place that is not open land. */
export const PLACE_NOTE = Object.freeze({
  outside: () => L`ここはこのシーズンの地図の外です`,
  unopened: () => L`まだひらいていない土地です`,
  pending: () => L`この土地は生まれるところです（しばらくお待ちください）`,
  extendable: () => L`ここはまだ地図の外です（このシーズンは、ここまで地図を広げられます）`,
  beyondCeiling: () => L`ここはこのシーズンの上限の外です`,
  beyondHard: () => L`ここはプログラムの上限（第128輪）の外です`,
});

/** The ring as the inspector says it, with what the place is. */
export function ringText(state, ring) {
  if (state === PLACE.outside) return L`第${fmtNum(ring)}輪（このシーズンの地図の外）`;
  if (state === PLACE.unopened) return L`第${fmtNum(ring)}輪（まだひらいていません）`;
  if (state === PLACE.pending) return L`第${fmtNum(ring)}輪（生まれるところです）`;
  if (state === PLACE.extendable) return L`第${fmtNum(ring)}輪（広げられるが、まだ地図の外）`;
  if (state === PLACE.beyondCeiling) return L`第${fmtNum(ring)}輪（このシーズンの上限の外）`;
  if (state === PLACE.beyondHard) return L`第${fmtNum(ring)}輪（プログラムの上限・第128輪の外）`;
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
