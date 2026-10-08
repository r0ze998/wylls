// Things the set pieces draw more than once (UX-DESIGN §8.3): the wax seal,
// the ribbon of a route, the marks of an accepted and a refused action, the
// far view's pip. Canvas only, no asset files; every function tolerates a
// context whose methods do nothing (tests draw into a proxy).
import { RADIUS } from '../../map.mjs';
import { clamp01, lerp, span, outCubic, outExpo } from './ease.mjs';
import { TONE, rgba } from './effects.mjs';

const TAU = Math.PI * 2;
/** Below this many screen px of hex radius a set piece shows its far-view form (a pip, a mark) instead of figures and particles. */
export const FAR_R = 17;
export const isFar = s => s.zoom * RADIUS < FAR_R;

const WAX = '#9a2617', WAX_HI = '#d2533c', WAX_LO = '#5a130b';

/**
 * A wax seal centred on (x, y), `r` its radius in the context's units:
 * a scalloped disc with a pressed ring and the bell of Wylls in it.
 * `{sx, sy}` squash it (the stamp landing), `alpha`, `split` (0..1) breaks
 * it in two halves that fall apart (an order being unsealed).
 */
export function waxSeal(ctx, x, y, r, { sx = 1, sy = 1, alpha = 1, split = 0, rot = -0.14 } = {}) {
  if (alpha <= 0.01 || r <= 0) return;
  const body = () => {
    ctx.beginPath();
    const N = 14;
    for (let i = 0; i <= N * 4; i++) {
      const a = (i / (N * 4)) * TAU, rr = r * (0.93 + 0.07 * Math.cos(a * N));
      i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient?.(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r * 1.05);
    if (g?.addColorStop) { g.addColorStop(0, WAX_HI); g.addColorStop(0.45, WAX); g.addColorStop(1, WAX_LO); ctx.fillStyle = g; } else ctx.fillStyle = WAX;
    ctx.fill();
    ctx.strokeStyle = rgba('#2b0703', 0.85); ctx.lineWidth = r * 0.07; ctx.lineJoin = 'round'; ctx.stroke();
    // the pressed ring: dark below, light above
    ctx.lineWidth = r * 0.06;
    ctx.strokeStyle = rgba('#3d0a05', 0.7); ctx.beginPath(); ctx.arc(0, r * 0.02, r * 0.66, 0, TAU); ctx.stroke();
    ctx.strokeStyle = rgba('#f0907a', 0.55); ctx.beginPath(); ctx.arc(0, -r * 0.02, r * 0.66, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    // the bell
    ctx.fillStyle = rgba('#4a0d06', 0.82);
    ctx.beginPath();
    ctx.moveTo(-r * 0.3, r * 0.26); ctx.lineTo(-r * 0.24, r * 0.16);
    ctx.quadraticCurveTo(-r * 0.22, -r * 0.3, 0, -r * 0.34); ctx.quadraticCurveTo(r * 0.22, -r * 0.3, r * 0.24, r * 0.16);
    ctx.lineTo(r * 0.3, r * 0.26); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(0, r * 0.34, r * 0.08, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -r * 0.4, r * 0.06, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba('#f0907a', 0.5); ctx.lineWidth = r * 0.035;
    ctx.beginPath(); ctx.moveTo(-r * 0.15, -r * 0.2); ctx.quadraticCurveTo(-r * 0.19, 0, -r * 0.2, r * 0.14); ctx.stroke();
    // a wet highlight
    ctx.strokeStyle = rgba('#ffd2c4', 0.5); ctx.lineWidth = r * 0.05; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, Math.PI * 1.12, Math.PI * 1.42); ctx.stroke();
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha *= alpha;
  // its shadow on the paper
  ctx.fillStyle = rgba('#0c1614', 0.35); ctx.beginPath(); ctx.ellipse?.(r * 0.06, r * 0.12, r * 1.02 * sx, r * 0.98 * sy, 0, 0, TAU); ctx.fill();
  ctx.scale(sx, sy); ctx.rotate(rot);
  if (split <= 0.001) body();
  else for (const d of [-1, 1]) {
    ctx.save();
    ctx.translate(d * r * 0.5 * split, r * 0.3 * split * split); ctx.rotate(d * 0.5 * split);
    ctx.beginPath(); ctx.rect?.(d < 0 ? -r * 1.4 : 0, -r * 1.4, r * 1.4, r * 2.8); ctx.clip?.();
    body();
    ctx.restore();
  }
  ctx.restore();
}

/** A path through world points, smoothed (Catmull-Rom), as samples with their running length: `{pts, len, total}`. */
export function smoothPath(points) {
  const src = (points ?? []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (src.length < 2) return { pts: src, len: src.map(() => 0), total: 0 };
  const pts = [];
  const P = i => src[Math.max(0, Math.min(src.length - 1, i))];
  for (let i = 0; i < src.length - 1; i++) for (let k = 0; k < 10; k++) {
    const t = k / 10, p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2), t2 = t * t, t3 = t2 * t;
    const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    pts.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
  }
  pts.push({ ...src[src.length - 1] });
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, len, total: len[len.length - 1] };
}

/** The point at share k (0..1) of a smoothed path, and its heading. */
export function pathAt(path, k) {
  const { pts, len, total } = path;
  if (!pts.length) return null;
  if (pts.length === 1 || total <= 0) return { x: pts[0].x, y: pts[0].y, dx: 1, dy: 0 };
  const want = clamp01(k) * total;
  let i = 1; while (i < len.length - 1 && len[i] < want) i++;
  const a = pts[i - 1], b = pts[i], u = len[i] > len[i - 1] ? (want - len[i - 1]) / (len[i] - len[i - 1]) : 0;
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), dx: b.x - a.x, dy: b.y - a.y };
}

/** Trace a smoothed path from share k0 to k1 into the current path of `ctx` (no stroke). */
export function tracePath(ctx, path, k0 = 0, k1 = 1) {
  const { pts, len, total } = path;
  if (pts.length < 2 || k1 <= k0) return false;
  const a = pathAt(path, k0), b = pathAt(path, k1), from = k0 * total, to = k1 * total;
  ctx.beginPath(); ctx.moveTo(a.x, a.y);
  for (let i = 0; i < pts.length; i++) if (len[i] > from && len[i] < to) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(b.x, b.y);
  return true;
}

/**
 * The ribbon of a route: a dark underlay, the nation's colour, a light edge.
 * `k` how much of it is drawn (0..1), `px` one screen pixel in the context's
 * units, `level` its overall strength, `sealed` the quieter resting look.
 */
export function ribbon(ctx, path, { k = 1, px = 1, color = TONE.you, level = 1, sealed = false, glint = -1 } = {}) {
  if (level <= 0.01 || k <= 0.001 || path.pts.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const w = sealed ? 0.8 : 1;
  if (tracePath(ctx, path, 0, k)) {
    ctx.strokeStyle = rgba('#0c1614', (sealed ? 0.55 : 0.66) * level); ctx.lineWidth = 12 * w * px; ctx.stroke();
    ctx.strokeStyle = rgba(color, (sealed ? 0.9 : 1) * level); ctx.lineWidth = 7.5 * w * px; ctx.stroke();
    ctx.strokeStyle = rgba(TONE.ivory, (sealed ? 0.55 : 0.9) * level); ctx.lineWidth = 2 * w * px; ctx.stroke();
  }
  // a glint running along it (the pen's tip while it is drawn; a slow shimmer while an order waits)
  if (glint >= 0 && glint <= 1) {
    const g0 = Math.max(0, glint - 0.12), g1 = Math.min(k, glint);
    if (g1 > g0 && tracePath(ctx, path, g0, g1)) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(TONE.white, 0.8 * level); ctx.lineWidth = 5 * px; ctx.stroke();
      const p = pathAt(path, g1);
      const gr = ctx.createRadialGradient?.(p.x, p.y, 0, p.x, p.y, 18 * px);
      if (gr?.addColorStop) { gr.addColorStop(0, rgba(TONE.white, 0.9 * level)); gr.addColorStop(0.4, rgba(color, 0.5 * level)); gr.addColorStop(1, rgba(color, 0)); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(p.x, p.y, 18 * px, 0, TAU); ctx.fill(); }
    }
  }
  ctx.restore();
}

/** A round mark over a tile (screen-sized): a dark disc with a ring in `color` and, drawn on by `k`, a tick ('ok') or a cross ('no'). */
export function roundMark(ctx, x, y, r, { kind = 'ok', color = TONE.you, k = 1, alpha = 1, scale = 1 } = {}) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.translate(x, y); ctx.scale(scale, scale);
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = rgba('#0c1614', 0.9); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = r * 0.16; ctx.beginPath(); ctx.arc(0, 0, r * 0.9, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(k * 1.4)); ctx.stroke();
  ctx.strokeStyle = TONE.ivory; ctx.lineWidth = r * 0.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const kk = clamp01((k - 0.25) / 0.75);
  if (kind === 'ok') {
    const a = [-r * 0.42, r * 0.02], b = [-r * 0.12, r * 0.32], c = [r * 0.44, -r * 0.3];
    const k1 = clamp01(kk / 0.4), k2 = clamp01((kk - 0.4) / 0.6);
    if (k1 > 0) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(lerp(a[0], b[0], k1), lerp(a[1], b[1], k1)); if (k2 > 0) ctx.lineTo(lerp(b[0], c[0], k2), lerp(b[1], c[1], k2)); ctx.stroke(); }
  } else {
    const d = r * 0.34, k1 = clamp01(kk / 0.5), k2 = clamp01((kk - 0.5) / 0.5);
    if (k1 > 0) { ctx.beginPath(); ctx.moveTo(-d, -d); ctx.lineTo(lerp(-d, d, k1), lerp(-d, d, k1)); ctx.stroke(); }
    if (k2 > 0) { ctx.beginPath(); ctx.moveTo(d, -d); ctx.lineTo(lerp(d, -d, k2), lerp(-d, d, k2)); ctx.stroke(); }
  }
  ctx.restore();
}

/**
 * The far view's form of a moment: a pip in `color` with rings leaving it,
 * sized in screen px, drawn only when the map is far out. `t` seconds since
 * it began; returns false once it is over (1.4 s).
 */
export function farPip(ctx, s, x, y, color, t) {
  if (!isFar(s) || t < 0 || t > 1.4) return false;
  const k = s.px;
  ctx.save();
  for (let i = 0; i < 2; i++) {
    const u = (t - i * 0.22) / 0.9;
    if (u < 0 || u >= 1) continue;
    ctx.strokeStyle = rgba(color, (1 - u) ** 1.5); ctx.lineWidth = lerp(4, 1, u) * k;
    ctx.beginPath(); ctx.arc(x, y, lerp(5, 26, outExpo(u)) * k, 0, TAU); ctx.stroke();
  }
  const pop = outCubic(span(t, 0, 0.14)) * (1 - span(t, 1.0, 1.4));
  ctx.fillStyle = rgba('#0c1614', 0.85 * pop); ctx.beginPath(); ctx.arc(x, y, 7 * k * pop, 0, TAU); ctx.fill();
  ctx.fillStyle = rgba(color, pop); ctx.beginPath(); ctx.arc(x, y, 5 * k * pop, 0, TAU); ctx.fill();
  ctx.fillStyle = rgba(TONE.white, 0.9 * (1 - span(t, 0, 0.25))); ctx.beginPath(); ctx.arc(x, y, 5 * k * pop, 0, TAU); ctx.fill();
  ctx.restore();
  return true;
}

/** A standard on a pole: a swallow-tail pennon in `fill` with a `dark` edge and a gold finial; `up` 0..1 raises it, `t` waves it. */
export function standard(ctx, x, y, h, { fill, dark, up = 1, t = 0, px = 1 } = {}) {
  if (up <= 0) return;
  const top = y - h * up, wv = Math.sin(t * 5.2) * h * 0.03, wv2 = Math.sin(t * 5.2 + 1.1) * h * 0.045;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = rgba('#0c1614', 0.55); ctx.lineWidth = h * 0.05; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke();
  ctx.strokeStyle = '#6b4a2e'; ctx.lineWidth = h * 0.03; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke();
  const w = h * 0.5 * up, hh = h * 0.27 * up, y0 = top + h * 0.03;
  ctx.beginPath();
  ctx.moveTo(x, y0); ctx.quadraticCurveTo(x + w * 0.5, y0 + wv, x + w, y0 - h * 0.01 + wv2);
  ctx.lineTo(x + w * 0.74, y0 + hh * 0.5 + wv2); ctx.lineTo(x + w, y0 + hh + wv2);
  ctx.quadraticCurveTo(x + w * 0.5, y0 + hh + wv, x, y0 + hh); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = dark; ctx.lineWidth = Math.max(1.2 * px, h * 0.018); ctx.stroke();
  ctx.fillStyle = TONE.brassHi; ctx.strokeStyle = TONE.brassLo; ctx.lineWidth = 1 * px; ctx.beginPath(); ctx.arc(x, top, h * 0.04, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.restore();
}
