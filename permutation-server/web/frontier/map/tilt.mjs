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
// Pure: no DOM. `upright` is the one helper painters use: text and marks that
// must stay crisp and upright are drawn on an untransformed canvas, each
// around its own anchor on the ground.

/**
 * The tilt at the near view (degrees), the most the baked art allows, the viewing distance (CSS px), and the spare
 * rim of the ground canvas. The angle was chosen from side-by-side pictures at 0, 12, 16 and 20 degrees (1440 × 900
 * and 390 × 844): at 12 the board still reads as a flat sheet; at 16 the rows visibly shorten toward the far edge; at
 * 20 straight things (the sheet's edge, its neatline, the province borders) also lean together toward the far
 * edge, which is what makes it a board seen from a seat, and the painted props (drawn for a steeper view) are not
 * yet squashed: they lose 6% of their height. Past 22 they would be.
 */
export const TILT = Object.freeze({ deg: 20, max: 22, perspective: 1600, margin: 10 });
/** The zoom from which the board is fully tilted (below the far view's zoom it lies flat). */
export const TILT_NEAR = 0.62;

const RAD = Math.PI / 180;
const clamp01 = x => Math.max(0, Math.min(1, x));

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
    return { ...FLAT, width: w, height: h, toBox: (x, y) => ({ x, y }), toStage: (x, y) => ({ x, y }), scaleAt: () => 1,
      quad: () => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] };
  }
  const s = Math.sin(deg * RAD), c = Math.cos(deg * RAD), P = perspective;
  const scaleAt = sy => P / (P - (sy - cy) * s);
  const toBox = (sx, sy) => { const k = scaleAt(sy); return { x: cx + (sx - cx) * k, y: cy + (sy - cy) * c * k }; };
  const toStage = (bx, by) => { const v = by - cy, dy = (v * P) / (P * c + v * s), k = P / (P - dy * s); return { x: cx + (bx - cx) / k, y: cy + dy }; };
  return { deg, flat: false, width: w, height: h, toBox, toStage, scaleAt, quad: () => [toStage(0, 0), toStage(w, 0), toStage(w, h), toStage(0, h)] };
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
 * Draw something that must stand upright around world point (x, y): on the
 * untransformed label canvas `draw()` runs with that point where the tilted
 * ground shows it and with the map's zoom as its only scale (so a painter
 * written in world px needs no other change); on any other context it simply
 * runs. Returns what `draw` returns.
 */
const armed = new WeakMap();
export function upright(ctx, x, y, draw) {
  const at = ctx && typeof ctx === 'object' ? armed.get(ctx) : null;
  return at ? at(x, y, draw) : draw();
}

/**
 * Arm a context as the label canvas for one frame: `place(x, y)` gives the
 * box px of a world point, `zoom` the map's zoom, `ratio` device px per CSS
 * px. `disarmUpright` makes it a plain context again.
 */
export function armUpright(ctx, { place, zoom, ratio = 1 }) {
  if (!ctx?.save || !ctx.setTransform) return;
  armed.set(ctx, (x, y, draw) => {
    const p = place(x, y), k = ratio * zoom;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, ratio * p.x - k * x, ratio * p.y - k * y);
    try { return draw(); } finally { ctx.restore(); }
  });
}
export const disarmUpright = ctx => { if (ctx && typeof ctx === 'object') armed.delete(ctx); };
/** Whether `ctx` is armed as the label canvas (its painters draw upright around their anchors). */
export const isUpright = ctx => !!ctx && typeof ctx === 'object' && armed.has(ctx);
