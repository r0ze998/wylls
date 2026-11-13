// The keeps a press at a point of the page can take (FrontierMap.keepAt, map/fmap.mjs), found in the keep board's
// bucket index (map/keepindex.mjs) instead of by projecting every keep of the world.
//
// keepAt takes a keep when the press (X, Y) lies in a box round the point where the keep's anchor is seen
// (`at = map.project(P.x, P.y)`, client px): `|X − at.x| ≤ hw`, `−up ≤ Y − at.y ≤ down`, with
//   s = u · z · k,  hw = max(min, 0.95 s),  up = max(2 min, 1.55 s),  down = max(0.6 min, 0.6 s),
// `u` the fortress unit at zoom `z` (the same for every keep), `min` 12 or 22 px and `k` the row's scale under the
// tilt (`standAt(...).k`, 1 on a flat board). Under the tilt (map/tilt.mjs, perspective P, angle θ) the scale of a
// row is linear in where it is seen: with t = tan θ / P and c the box's middle row in client px,
//   k = 1 + (at.y − c) · t        (toBox: 1 + (by − cy)·c·k·s / (P c) = P k / P)
// so a keep that can be taken has at.y ≤ Y + up(k) ≤ Y + max(2 min, 1.55 u z k), which bounds k by
//   kMax = max(1 + (Y + 2 min − c) t,  (Y − c + 1/t) / (1/t − 1.55 u z))      (when 1/t > 1.55 u z)
// and every such keep is seen inside the client rectangle of the press widened by hw, up and down at kMax. A keep
// seen beyond the horizon (k ≤ 0) is seen above c − 1/t with the smallest box; a press well below that line cannot
// take it. The rectangle (wholly below the horizon) goes back to the world through the map's own `unproject`: a
// perspective map takes a convex quadrilateral to a convex quadrilateral, so the box round its four corners holds
// every anchor that can be taken. The rows in it are taken from the index in the rows' order and keepAt runs its
// own unchanged test over them: the same keep, and the same first one of two equally near.
//
// Anything not certain gives null and keepAt scans every keep as before: a number that is not finite, a flat
// board's `standAt` that is not null, an angle too steep for the bound, a press near the horizon, corners that do not
// come back through `project`, a row scale that is not the line above at the rectangle's edge, or a box too wide
// for the buckets (the far view).
import { RADIUS } from '../../map.mjs';
import { KEEP_LOOK, KeepBoard } from './keeps.mjs';
import { TILT, tiltGeo } from './tilt.mjs';

/** Client px added round the rectangle, and world px round the box, so that rounding never leaves out a keep the exact test takes. */
export const KEEP_SCREEN_SLACK = 1;
/** How far (client px) a corner may come back from `project(unproject(corner))`, and how far the row scale may be from the line, before the scan is used instead. */
export const KEEP_SCREEN_TOL = Object.freeze({ px: 0.01, k: 1e-6 });
const RAD = Math.PI / 180;
const finite = (...v) => v.every(Number.isFinite);

/** The fortress unit at zoom `z` (KeepBoard.place's `u`). */
export const keepUnit = z => Math.max(RADIUS * KEEP_LOOK.unit, KEEP_LOOK.minPx / z);

/**
 * The client rectangle that holds the point where every keep a press at (x, y) can take is seen: `{x0, x1, y0, y1,
 * kMax}`, or null. `uz`: the fortress unit times the zoom; `min`: the least half width (12 or 22 px); `tilt`: null on
 * a flat board (every k is 1), else `{t, c}` with k(clientY) = 1 + (clientY − c)·t.
 */
export function keepScreenRect({ x, y, min, uz, tilt = null }) {
  if (!finite(x, y, min, uz) || !(min >= 0) || !(uz >= 0)) return null;
  let kMax = 1;
  if (tilt) {
    const { t, c } = tilt;
    if (!finite(t, c) || !(t > 0)) return null;
    const horizon = c - 1 / t, a = 1 / t - 1.55 * uz;
    // (a keep beyond the horizon is seen above it, with a box reaching 0.6 min below: the press must be clear of that)
    if (!(y - 0.6 * min - KEEP_SCREEN_SLACK > horizon) || !(a > 0)) return null;
    kMax = Math.max(1 + (y + 2 * min - c) * t, (y - c + 1 / t) / a, 0);
    kMax = kMax * (1 + 1e-9) + 1e-9;
  }
  const s = uz * kMax, hw = Math.max(min, 0.95 * s), up = Math.max(2 * min, 1.55 * s), down = Math.max(0.6 * min, 0.6 * s), m = KEEP_SCREEN_SLACK;
  const r = { x0: x - hw - m, x1: x + hw + m, y0: y - down - m, y1: y + up + m, kMax };
  if (!finite(r.x0, r.x1, r.y0, r.y1)) return null;
  if (tilt && !(r.y0 > tilt.c - 1 / tilt.t)) return null;
  return r;
}

/**
 * The tilt of `map` as keepScreenRect wants it, checked against the map's own geometry: `{flat: true}`, `{t, c}`, or
 * null (not certain). `map`: FrontierMap's `geo`, `size`, `rect`, `persp`, `standAt`, `cam.drawn`.
 */
export function keepTiltOf(map, z) {
  const size = map.size(), T = map.geo(z, size), r = map.rect();
  if (!T || !finite(size?.width, size?.height, r?.left, r?.top)) return null;
  if (T.flat) return { flat: true };
  const P = map.persp === undefined ? TILT.perspective : map.persp;
  if (!finite(T.deg, P) || !(P > 0) || !(T.deg > 0) || !(T.deg < 90)) return null;
  return { t: Math.tan(T.deg * RAD) / P, c: r.top + size.height / 2, T, top: r.top };
}

/**
 * The keep rows a press at client (x, y) can take on `map` (a FrontierMap with `keeps`, a KeepBoard) at the drawn
 * zoom `z` with least half width `min`, in the rows' order: a superset of keepAt's hits. Null: scan every row.
 * `stats` (optional object) is told what was done, for tests.
 */
export function keepRowsNear(map, x, y, z, min, stats = null, { exact = false } = {}) {
  const note = v => { if (stats) Object.assign(stats, v); return null; };
  if (!finite(x, y, z, min) || !(z > 0)) return note({ full: 'numbers' });
  // (the bound is proved for FrontierMap's own project / unproject / standAt and KeepBoard's own place: a map or a
  // board that replaces any of them is a transform it cannot vouch for, and keepAt scans as before. `exact` is
  // keepAt's word that its map's three methods are the prototype's)
  if (!exact) return note({ full: 'transform' });
  const board = map?.keeps;
  if (!board || typeof board.keepIndex !== 'function' || board.place !== KeepBoard.prototype.place || !(board.rows instanceof Map)) return note({ full: 'board' });
  if (!['size', 'geo', 'rect', 'standAt', 'unproject', 'project'].every(k => typeof map[k] === 'function') || !finite(map.cam?.drawn?.x, map.cam?.drawn?.y)) return note({ full: 'map' });
  try { return near(map, board, x, y, z, min, note); } catch { return note({ full: 'error' }); }
}

/** The geometry `T` (map.geo) is the tilt of map/tilt.mjs for `size` at its own angle and the map's perspective: checked at the box's corners and middle. */
function plainTilt(T, size, P) {
  if (!T || typeof T.toBox !== 'function' || typeof T.toStage !== 'function' || typeof T.scaleAt !== 'function') return false;
  const ref = tiltGeo(size, T.flat ? 0 : T.deg, P), w = size.width, h = size.height;
  if (!!ref.flat !== !!T.flat) return false;
  const near = (a, b) => finite(a, b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  for (const [px, py] of [[0, 0], [w, 0], [w, h], [0, h], [w / 2, h / 2], [w / 3, -h], [w / 2, 2 * h]]) {
    const a = T.toBox(px, py), b = ref.toBox(px, py), c = T.toStage(px, py), d = ref.toStage(px, py);
    if (!near(a?.x, b.x) || !near(a?.y, b.y) || !near(c?.x, d.x) || !near(c?.y, d.y) || !near(T.scaleAt(py), ref.scaleAt(py))) return false;
  }
  return true;
}

function near(map, board, x, y, z, min, note) {
  const u = keepUnit(z);
  if (!finite(u)) return note({ full: 'board' });
  const tilt = keepTiltOf(map, z);
  if (!tilt) return note({ full: 'tilt' });
  const size = map.size();
  if (!plainTilt(tilt.flat ? map.geo(z, size) : tilt.T, size, map.persp === undefined ? TILT.perspective : map.persp)) return note({ full: 'geo' });
  // (a flat board's keeps all stand at scale 1: standAt says so by null)
  if (tilt.flat && map.standAt(map.cam.drawn.x, map.cam.drawn.y) !== null) return note({ full: 'flat' });
  const rect = keepScreenRect({ x, y, min, uz: u * z, tilt: tilt.flat ? null : tilt });
  if (!rect) return note({ full: 'rect' });
  if (!tilt.flat) {
    // the row scale at the rectangle's lowest row is the largest a keep inside it has: it must be the line's, and
    // within kMax (the bound was solved so that it is)
    for (const by of [rect.y0, rect.y1]) {
      const k = tilt.T.scaleAt(tilt.T.toStage(0, by - tilt.top).y), line = 1 + (by - tilt.c) * tilt.t;
      if (!finite(k) || Math.abs(k - line) > KEEP_SCREEN_TOL.k * Math.max(1, Math.abs(line))) return note({ full: 'scale' });
    }
    if (!(1 + (rect.y1 - KEEP_SCREEN_SLACK - tilt.c) * tilt.t <= rect.kMax * (1 + 1e-6) + 1e-6)) return note({ full: 'bound' });
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [cx, cy] of [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]]) {
    const w = map.unproject(cx, cy);
    if (!finite(w?.x, w?.y)) return note({ full: 'corner' });
    const back = map.project(w.x, w.y);
    if (!finite(back?.x, back?.y) || Math.abs(back.x - cx) > KEEP_SCREEN_TOL.px || Math.abs(back.y - cy) > KEEP_SCREEN_TOL.px) return note({ full: 'corner' });
    // the row scale keepAt itself will read there (standAt) is the one the bound assumed
    const k = map.standAt(w.x, w.y)?.k ?? 1, line = tilt.flat ? 1 : 1 + (cy - tilt.c) * tilt.t;
    if (!finite(k) || Math.abs(k - line) > KEEP_SCREEN_TOL.k * Math.max(1, Math.abs(line))) return note({ full: 'scale' });
    x0 = Math.min(x0, w.x); x1 = Math.max(x1, w.x); y0 = Math.min(y0, w.y); y1 = Math.max(y1, w.y);
  }
  const m = KEEP_SCREEN_SLACK + 1e-9 * Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1));
  const index = board.keepIndex(), box = { x0: x0 - m, x1: x1 + m, y0: y0 - m, y1: y1 + m };
  const got = index.query(board.rows, box);
  if (!got) return note({ full: 'wide' });
  note({ full: false, rect, box, candidates: got.length, cells: index.last?.cells ?? null });
  return got.map(e => e.row);
}
