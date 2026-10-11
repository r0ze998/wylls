// The depth dressing of a map WITHOUT the tilted stage (a page that has no
// `#map-stage`, and the tests): a pale haze toward the top edge and a
// vignette, painted over the finished scene in screen space. On the three
// pages the board is really tilted (map/tilt.mjs) and the dressing is the
// page's own `#map-dress` (frontier.css), driven by `nearness`: a warm haze on
// the far edge only, at most 0.30, and a soft vignette.
//
// One function, tuned from screenshots. `near` is 0 at the far view and 1 at
// the diorama; the context is in CSS px. Context-tolerant (tests draw into
// recorders without gradients).
import { LOD_NEAR, freeBox } from './camera.mjs';

/** How "near" a zoom is: 0 up to the chart, 1 from the diorama on. */
export const nearness = zoom => { const k = Math.max(0, Math.min(1, (zoom - LOD_NEAR.from) / (LOD_NEAR.to - LOD_NEAR.from))); return k * k * (3 - 2 * k); };

export const HAZE = Object.freeze({ reach: 0.26, top: 0.3, mid: 0.13, rgb: '240,228,200' });
export const VIGNETTE = Object.freeze({ far: 0.4, near: 0.3, rgb: '6,14,13' });

export function paintDressing(ctx, size, { zoom = 1, near = nearness(zoom), inset = null } = {}) {
  if (!ctx?.createLinearGradient || !(size?.width > 0) || !(size?.height > 0)) return;
  const { width: w, height: h } = size;
  // the part of the canvas no sheet covers is the picture: the horizon is its top, the eye rests in its middle
  const f = freeBox(size, inset), top = h / 2 + f.y - f.height / 2, cx = w / 2 + f.x, cy0 = h / 2 + f.y;
  ctx.save();
  if (near > 0.01) {
    const reach = f.height * HAZE.reach;
    const g = ctx.createLinearGradient(0, top, 0, top + reach);
    g.addColorStop(0, `rgba(${HAZE.rgb},${HAZE.top * near})`);
    g.addColorStop(0.38, `rgba(${HAZE.rgb},${HAZE.mid * near})`);
    g.addColorStop(1, `rgba(${HAZE.rgb},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, top + reach);
  }
  // the vignette sits a little below the middle: the top already fades into the haze
  const cy = cy0 + f.height * 0.06 * near, a = VIGNETTE.far + (VIGNETTE.near - VIGNETTE.far) * near;
  // (at the far view it starts nearer the middle: there it is the table's own falling into shadow)
  const v = ctx.createRadialGradient(cx, cy, Math.min(f.width, f.height) * (0.2 + 0.18 * near), cx, cy, Math.hypot(f.width, f.height) * 0.62);
  v.addColorStop(0, `rgba(${VIGNETTE.rgb},0)`); v.addColorStop(0.55, `rgba(${VIGNETTE.rgb},${a * (0.5 - 0.18 * near)})`); v.addColorStop(1, `rgba(${VIGNETTE.rgb},${a})`);
  ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  // the near edge of the table (under a sheet there is none to see)
  if (near > 0.01 && !(inset?.bottom > 0)) {
    const from = h * 0.86;
    const b = ctx.createLinearGradient(0, from, 0, h);
    b.addColorStop(0, `rgba(${VIGNETTE.rgb},0)`); b.addColorStop(1, `rgba(${VIGNETTE.rgb},${0.26 * near})`);
    ctx.fillStyle = b; ctx.fillRect(0, from, w, h - from);
  }
  ctx.restore();
}
