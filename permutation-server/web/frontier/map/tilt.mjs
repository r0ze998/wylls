// The tabletop tilt (UX brief §4, §11.1): the ground is a board seen from a
// seat, not a flat sheet. One element, `#map-stage`, carries a CSS 3D
// transform, `perspective(P) rotateX(tilt)` about the middle of the map's box;
// every world-space canvas lies in it and shares it. This file is the same
// transform in numbers, so that nothing has to ask the browser where a point
// went (and nothing relies on offsetX under a transform):
//
//   stage px    the flat picture: what the map's view formula gives
//               ((x − view.x) · zoom + width / 2), measured from the top left
//               of the map's box. Every flat formula in the client still
//               speaks this, and with no tilt it is the screen.
//   box px      where that point is seen, measured from the same corner
//               (client px less the box's own left and top).
//
// `tiltGeo(size, deg)` gives both directions, the scale of a row, the part of
// the stage that is in view (a trapezoid) and how far the ground canvas must
// reach past the box so the trapezoid is always covered. The angle follows
// the zoom (`tiltAt`): the chart lies flat, the diorama is tilted. `?tilt=`
// overrides the angle; 0 is the flat map, which must stay correct.
//
// Another world-space canvas (the effects' top pass) shares the transform by
// lying INSIDE `#map-stage`, exactly over `#map-ground`: the same left, top,
// width and height (the ground canvas carries them as `--map-gl`, `--map-gt`,
// `--map-gw`, `--map-gh`; `map.groundLayout()` gives the numbers). It is
// larger than the map's box, so it draws through the ground canvas's own flat
// view, `map.groundView()`, in a box of `map.groundSize()` CSS px, with the
// map's usual formula; nothing else changes for its painters. Screen-space
// things stay outside the stage and ask `map.project(worldX, worldY)` (client
// px; `{box: true}` for px from the map's corner) and `map.unproject`.
//
// Pure: no DOM. `upright` is the one helper painters use: text and marks that
// must stay crisp and upright are drawn on an untransformed canvas (the
// page's `#frontier-map`, flat above the stage), each around its own anchor
// on the ground: `upright(ctx, worldX, worldY, () => { …draw as before… })`.
// A painter that does not say its anchor is drawn at its flat place, which
// under a tilt is not where its tile is seen.

/**
 * The tilt at the near view (degrees), the most the art allows, the viewing distance (CSS px), and the spare rim of
 * the ground canvas. The angle was chosen from side-by-side pictures. The second wave took 20 from 0, 12, 16 and 20:
 * the painted props were then part of the tilted ground and would have been squashed past 22. Since the fix pass
 * everything that stands on the board is drawn upright (`standing`), so the third wave looked again, at 20, 23 and 26
 * with the camera further back (a hex about 88 px wide), 1440 × 900 and 390 × 844: at 20 the far rows are four
 * fifths of the middle one and the land still reads as a sheet seen from above; at 23 it begins to lie down; at 26 a
 * far row is three quarters of the middle one and six tenths of the nearest, hexes are clearly wider than tall, and
 * with the haze of the far rows the picture has a far edge: a board seen from a seat. 28 and 30 were looked at too
 * (the clamp lifted for the trial): there the baked ground's own relief (grass mounds painted for a view from some
 * 40 degrees) is squashed flat and the near hexes are stretched more than twice as wide as tall. 26 is the brief's
 * own limit (§12.1) and the clamp.
 */
export const TILT = Object.freeze({ deg: 26, max: 26, perspective: 900, margin: 10 });
/** The zoom from which the board is fully tilted (below the far view's zoom it lies flat). */
export const TILT_NEAR = 0.62;

const RAD = Math.PI / 180;
const clamp01 = x => Math.max(0, Math.min(1, x));

/** `?persp=<px>` of an address: the viewing distance for trials (600 to 4000), or null when it says nothing. */
export function perspFromQuery(search = '') {
  const m = /[?&]persp=(\d+(?:\.\d+)?)(?:&|$)/.exec(String(search ?? ''));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? Math.max(600, Math.min(4000, v)) : null;
}

/** `?tilt=<deg>` of an address: the angle (0 to TILT.max), or null when it says nothing. */
export function tiltFromQuery(search = '') {
  const m = /[?&]tilt=(-?\d+(?:\.\d+)?)(?:&|$)/.exec(String(search ?? ''));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? Math.max(0, Math.min(TILT.max, v)) : null;
}

/**
 * The angle at `zoom`: 0 up to `far` (the far view: the chart lies flat),
 * `deg` from `near` on, eased between them.
 */
export function tiltAt(zoom, { far = 0.16, near = TILT_NEAR, deg = TILT.deg } = {}) {
  if (!(deg > 0) || !(zoom > 0)) return 0;
  const a = Math.min(far, near * 0.8);
  const k = clamp01((zoom - a) / (near - a));
  return deg * k * k * (3 - 2 * k);
}

const FLAT = Object.freeze({ deg: 0, flat: true });

/**
 * The tilt of a box `size` {width, height} (CSS px) by `deg` about its
 * middle, seen from `perspective` px:
 *   toBox(sx, sy)     a stage point as it is seen
 *   toStage(bx, by)   the stage point seen at a point of the box
 *   scaleAt(sy)       how large a stage row is drawn (1 on the middle row, less above it)
 *   quad()            the part of the stage seen through the box: [top left, top right, bottom right, bottom left]
 */
export function tiltGeo(size, deg = 0, perspective = TILT.perspective) {
  const w = size?.width ?? 0, h = size?.height ?? 0, cx = w / 2, cy = h / 2;
  if (!(deg > 0) || !(w > 0) || !(h > 0)) {
    return { ...FLAT, width: w, height: h, toBox: (x, y) => ({ x, y }), toStage: (x, y) => ({ x, y }), scaleAt: () => 1, standAt: () => null,
      quad: () => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] };
  }
  const s = Math.sin(deg * RAD), c = Math.cos(deg * RAD), P = perspective;
  const scaleAt = sy => P / (P - (sy - cy) * s);
  const toBox = (sx, sy) => { const k = scaleAt(sy); return { x: cx + (sx - cx) * k, y: cy + (sy - cy) * c * k }; };
  const toStage = (bx, by) => { const v = by - cy, dy = (v * P) / (P * c + v * s), k = P / (P - dy * s); return { x: cx + (bx - cx) / k, y: cy + dy }; };
  // what stands on the board at stage point (sx, sy): drawn in the plane, sheared by `sh` per px of height and
  // `vs` times as tall about its foot, the tilt shows it upright and as large as its row (the inverse of the
  // tilt's own slope there, times the row's scale)
  const standAt = (sx, sy) => ({ sh: -((sx - cx) * s) / (P * c), vs: 1 / (c * scaleAt(sy)), k: scaleAt(sy) });
  return { deg, flat: false, width: w, height: h, toBox, toStage, scaleAt, standAt, quad: () => [toStage(0, 0), toStage(w, 0), toStage(w, h), toStage(0, h)] };
}

/**
 * How far the ground canvas reaches past the box on each side (CSS px) so
 * that the trapezoid in view is covered at every angle up to `deg`:
 * `{left, top, right, bottom}`. A flat map needs none.
 */
export function overscan(size, deg = TILT.deg, { perspective = TILT.perspective, margin = TILT.margin } = {}) {
  if (!(deg > 0) || !(size?.width > 0) || !(size?.height > 0)) return { left: 0, top: 0, right: 0, bottom: 0 };
  const q = tiltGeo(size, deg, perspective).quad();
  const side = Math.ceil(Math.max(0, -q[0].x, q[1].x - size.width, -q[3].x, q[2].x - size.width)) + margin;
  return { left: side, right: side, top: Math.ceil(Math.max(0, -q[0].y)) + margin, bottom: Math.ceil(Math.max(0, q[2].y - size.height)) + margin };
}

/**
 * The ground canvas for a box `size` under a tilt of up to `deg`: its place
 * in the stage (`left`, `top`: negative, CSS px), its `width` and `height`,
 * and `dx`, `dy`: how far its own middle lies from the box's middle. A canvas
 * laid exactly over it shows the world through a flat view of its own,
 * `groundView(view, ground)`, with the map's usual formula.
 */
export function groundBox(size, deg = TILT.deg, opts = {}) {
  const o = overscan(size, deg, opts);
  const width = size.width + o.left + o.right, height = size.height + o.top + o.bottom;
  return { left: 0 - o.left, top: 0 - o.top, width, height, dx: (o.right - o.left) / 2, dy: (o.bottom - o.top) / 2 };
}

/** The flat view of the ground canvas `ground` (groundBox) when the map's view is `view`. */
export const groundView = (view, ground) => ({ x: view.x + ground.dx / view.zoom, y: view.y + ground.dy / view.zoom, zoom: view.zoom });

/** Whether world point (x, y) lies within `m` world px of the convex quad `q` (four points in order). */
export function nearQuad(q, x, y, m = 0) {
  if (!q) return true;
  // the quad's own turn: clockwise on screen (y down) has a positive cross product
  const turn = Math.sign((q[1].x - q[0].x) * (q[2].y - q[1].y) - (q[1].y - q[0].y) * (q[2].x - q[1].x)) || 1;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
    if (!(len > 0)) continue;
    if ((turn * (ex * (y - a.y) - ey * (x - a.x))) / len < -m) return false;
  }
  return true;
}

/**
 * Draw something that stands on the board with its foot at (x, y) of the context's own units: `m` is what the tilt
 * asks of it there (`standAt`: `{sh, vs}`), or null on a flat board. The picture is drawn in the plane, sheared and
 * stretched about its foot so that the tilted stage shows it upright, as tall as it was painted and as large as its row.
 */
export function standing(g, m, x, y, draw) {
  if (!m || !g?.transform) return draw();
  g.save();
  g.transform(1, 0, m.sh, m.vs, -m.sh * y, y * (1 - m.vs));
  try { return draw(); } finally { g.restore(); }
}

/**
 * Draw something that must stand upright around world point (x, y): on the
 * untransformed label canvas `draw()` runs with that point where the tilted
 * ground shows it and with the map's zoom as its only scale (so a painter
 * written in world px needs no other change); on any other context it simply
 * runs. Returns what `draw` returns.
 */
const armed = new WeakMap(), rows = new WeakMap();
/** How large the row of world point (x, y) is drawn on an armed label canvas (1 on any other context): what stands there is that much taller on screen. */
export const rowScale = (ctx, x, y) => (ctx && typeof ctx === 'object' ? rows.get(ctx)?.(x, y) : null) ?? 1;
export function upright(ctx, x, y, draw) {
  const at = ctx && typeof ctx === 'object' ? armed.get(ctx) : null;
  return at ? at(x, y, draw) : draw();
}

/**
 * Arm a context as the label canvas for one frame: `place(x, y)` gives the
 * box px of a world point, `zoom` the map's zoom, `ratio` device px per CSS
 * px. `disarmUpright` makes it a plain context again.
 */
export function armUpright(ctx, { place, zoom, ratio = 1, scaleAt = null }) {
  if (!ctx?.save || !ctx.setTransform) return;
  if (scaleAt) rows.set(ctx, scaleAt); else rows.delete(ctx);
  armed.set(ctx, (x, y, draw) => {
    const p = place(x, y), k = ratio * zoom;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, ratio * p.x - k * x, ratio * p.y - k * y);
    try { return draw(); } finally { ctx.restore(); }
  });
}
export const disarmUpright = ctx => { if (ctx && typeof ctx === 'object') { armed.delete(ctx); rows.delete(ctx); } };
/** Whether `ctx` is armed as the label canvas (its painters draw upright around their anchors). */
export const isUpright = ctx => !!ctx && typeof ctx === 'object' && armed.has(ctx);
