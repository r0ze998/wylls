// The relief of the board, drawn by code (UX brief §12.2, §13.5): mountains and
// woods are upright art in the hand of the ground they stand on. The ground is
// a soft render (the baked tile art: no line anywhere, faces that turn from
// light to shade without an edge, a little grain), and the first drawn relief
// stood on it as flat-shaded pieces with an ink line: two hands on one board
// (the last check of wave 3). So here there is no outline at all; every form
// is laid as a wash (painted coarse and stretched back, so nothing inside it
// has a hard edge) inside its own silhouette; the colours are the ground
// art's own, sampled from its sprites (rock, snow, fir and leaf of
// art/props, turf of art/terrain); each piece sits in a soft contact shadow;
// and a fine grain of strokes and specks lies over it, as the render has.
// Light from the upper left, as everything on the board.
//
// Every piece is drawn at whatever size the screen asks for and kept as a
// bitmap for that size, so a frame is a copy. (Hills were tried the same way
// twice, in the third wave with a line and in the fourth as soft upright
// mounds, lit from the left with their feet rubbed into the tile; beside the
// baked ground at the hero frame and the middle view the drawn ones read as
// green cushions, each like the next, and the render's mounds, with their
// own light and shade, as land. The baked ground stays; the code is gone.)
//
//   a mountain   a massif of two to four peaks: a lit face and a shaded face
//                either side of a wandering ridge, turning into one another;
//                gullies, a snow cap whose edge runs down in tongues, turf
//                creeping up its foot, foothills that melt into the ground,
//                a few pines. Three variants.
//   a wood       single trees, each standing on its own spot of the tile (so
//                each is upright where it stands and as large as its row):
//                firs in rounded tiers and broadleaf crowns of a few lobes,
//                three variants of each; where they stand is seeded by the
//                tile, the mix by the tile's variant; the shade under them is
//                laid on the ground.
//
// Units: `u` is a hex's corner radius in the context's units; a picture is
// drawn about the middle of its footprint on the ground. Pure drawing;
// context-tolerant; no asset files.
import { FLATTEN } from '../../map.mjs';

/** How flat the ground is drawn (the villages' own). */
const F = FLATTEN * 0.8;
/** The boxes the pictures need around the middle of their footprints (units of `u`). */
export const RELIEF = Object.freeze({
  mountain: Object.freeze({ left: 1.2, right: 1.2, top: 2.05, bottom: 0.62 }),
  tree: Object.freeze({ left: 0.3, right: 0.3, top: 0.78, bottom: 0.1 }),
  /** A mountain's foot (where it turns upright) lies this far below its tile's middle; its shadow is this dark. */
  foot: 0.3, shadow: 0.3,
});

/**
 * The ground art's own colours, light to dark (sampled from the baked sprites: the rock and snow of
 * art/props/mountain_*, the firs and crowns of art/props/forest_*, the turf of art/terrain/hills_* and grassland_*).
 * `top` is a step lighter than the render's lightest rock: what stands upright catches the light the ground does not.
 */
export const GROUND_PALETTE = Object.freeze({
  rock: Object.freeze({ top: '#beb39d', lit: '#9d927e', mid: '#70685a', shade: '#554e44', deep: '#3e3933' }),
  snow: Object.freeze({ lit: '#f5f7f7', mid: '#e5e9e9', shade: '#c4cbd2', deep: '#a5aeb9' }),
  turf: Object.freeze({ lit: '#7c9a48', mid: '#67873e', shade: '#4f6d30', deep: '#3b5527' }),
  fir: Object.freeze({ lit: '#567e3f', mid: '#335a33', shade: '#1f3d25', deep: '#122c19' }),
  leaf: Object.freeze({ lit: '#86a548', mid: '#658a3d', shade: '#4b7032', deep: '#335126' }),
});
const { rock: ROCK, snow: SNOW, turf: TURF } = GROUND_PALETTE;
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (hex, a) => `rgba(${rgb(hex).join(',')},${a})`;
const tone = (hex, d) => `rgb(${rgb(hex).map((v, i) => Math.max(0, Math.min(255, Math.round(v + d[i])))).join(',')})`;
/** The three firs and the three crowns: the ground art's two greens, each a little cooler or warmer. */
const shift = (pal, d) => Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, tone(v, d)]));
const FIR = [GROUND_PALETTE.fir, shift(GROUND_PALETTE.fir, [-6, 0, 8]), shift(GROUND_PALETTE.fir, [8, 6, -4])];
const LEAF = [GROUND_PALETTE.leaf, shift(GROUND_PALETTE.leaf, [12, 6, -8]), shift(GROUND_PALETTE.leaf, [-10, -2, 4])];
const BARK = { lit: '#6f5a3c', shade: '#3f3020' };

/** A small seeded generator (the same picture every time). */
function rng(seed) {
  let a = (seed | 0) || 1;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const lerp = (a, b, k) => a + (b - a) * k;
const path = (g, pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); };
const poly = (g, pts, fill) => { path(g, pts); g.closePath(); g.fillStyle = fill; g.fill(); };
/** The point `k` (0..1) of the way along a polyline. */
function along(pts, k) {
  const n = pts.length - 1, f = Math.max(0, Math.min(1, k)) * n, i = Math.min(n - 1, Math.floor(f)), t = f - i;
  return [lerp(pts[i][0], pts[i + 1][0], t), lerp(pts[i][1], pts[i + 1][1], t)];
}
/** A gradient between two points, or the middle colour where there are no gradients. */
function grade(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient?.(x0, y0, x1, y1);
  if (!gr?.addColorStop) return stops[Math.floor(stops.length / 2)][1];
  for (const [k, c] of stops) gr.addColorStop(k, c);
  return gr;
}
/** A round gradient, or the middle colour where there are none. */
function glow(g, x, y, r0, r1, stops) {
  const gr = g.createRadialGradient?.(x, y, r0, x, y, r1);
  if (!gr?.addColorStop) return stops[Math.floor(stops.length / 2)][1];
  for (const [k, c] of stops) gr.addColorStop(k, c);
  return gr;
}
const spare = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);

/**
 * A wash: what `draw(c)` paints (in the caller's own units, over `box` = [x0, y0, x1, y1]) is painted `coarse` times
 * coarser than the context's pixels and stretched back, so no edge inside it is hard: one face turns into the next
 * as in a soft render. The caller clips it to the form's own silhouette, which stays crisp. Without a spare canvas
 * (a recorder, a test) it is painted straight.
 */
function wash(g, box, coarse, draw) {
  const m = g.getTransform?.(), s = m && Number.isFinite(m.a) ? Math.hypot(m.a, m.b) : 0;
  const [x0, y0, x1, y1] = box, f = s / coarse, w = Math.ceil((x1 - x0) * f) + 4, h = Math.ceil((y1 - y0) * f) + 4;
  const cv = s > 0 && w > 4 && h > 4 && w * h < 2_000_000 ? spare(w, h) : null, c = cv?.getContext?.('2d');
  if (!c) { draw(g); return; }
  c.setTransform(f, 0, 0, f, 2 - x0 * f, 2 - y0 * f);
  draw(c);
  const was = g.imageSmoothingEnabled, q = g.imageSmoothingQuality;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cv, x0 - 2 / f, y0 - 2 / f, w / f, h / f);
  g.imageSmoothingEnabled = was; if (q) g.imageSmoothingQuality = q;
}

// ------------------------------------------------------------------ mountains
/**
 * The three massifs: peaks back to front, each `{x, w, h, lean, ridge, snow}` in units of `u` (x: its middle, w:
 * half its base, h: its height, lean: how far its summit stands off the middle, ridge: where its ridge meets the
 * base, snow: the share of its height under snow).
 */
const MASSIFS = Object.freeze([
  [{ x: 0.44, w: 0.6, h: 1.04, lean: -0.08, ridge: 0.12, snow: 0.12 }, { x: -0.12, w: 0.84, h: 1.44, lean: 0.05, ridge: 0.22, snow: 0.27 }, { x: -0.56, w: 0.5, h: 0.5, lean: 0.06, ridge: 0.1, snow: 0 }, { x: 0.46, w: 0.46, h: 0.42, lean: -0.04, ridge: 0.1, snow: 0 }],
  [{ x: -0.38, w: 0.66, h: 1.2, lean: 0.06, ridge: 0.16, snow: 0.2 }, { x: 0.32, w: 0.74, h: 1.4, lean: -0.06, ridge: 0.18, snow: 0.26 }, { x: -0.06, w: 0.52, h: 0.46, lean: 0.03, ridge: 0.1, snow: 0 }],
  [{ x: -0.54, w: 0.5, h: 0.9, lean: 0.07, ridge: 0.12, snow: 0 }, { x: 0.52, w: 0.54, h: 0.98, lean: -0.06, ridge: 0.12, snow: 0.12 }, { x: 0.0, w: 0.88, h: 1.52, lean: -0.03, ridge: 0.24, snow: 0.3 }, { x: 0.22, w: 0.46, h: 0.42, lean: 0.02, ridge: 0.08, snow: 0 }],
]);

/** One peak: its silhouette, the wash of its faces and snow inside it, its grain. No line. */
function peak(g, x, y, u, P, R) {
  const cx = x + P.x * u, w = P.w * u, h = P.h * u, sx = cx + P.lean * u, top = y - h;
  const sag = w * F * 0.5;
  // the two slopes, summit to base, each a broken line (a shoulder some way down, the breaks smaller toward the summit)
  const slope = (dir) => {
    const pts = [[sx, top]], n = 7, end = [cx + dir * w, y + sag * 0.12];
    const shoulder = 0.3 + R() * 0.35, sh = (R() - 0.3) * 0.2;
    for (let i = 1; i < n; i++) {
      // (a mountain is broad in the shoulder: the slope swells outward below the summit and steepens again at the foot)
      const k = i / n, bulge = Math.sin(Math.pow(k, 0.8) * Math.PI) * (P.h < 1 ? 0.24 : 0.17) + (Math.abs(k - shoulder) < 0.16 ? sh : 0);
      pts.push([lerp(sx, end[0], k) + dir * (bulge + (R() - 0.5) * 0.1 * k) * w, lerp(top, end[1], Math.pow(k, 1.06)) + (R() - 0.5) * 0.06 * h * k]);
    }
    pts.push(end);
    return pts;
  };
  const L = slope(-1), Rr = slope(1);
  // the ridge between the faces: from the summit down to the base, wandering
  const rb = [cx + P.ridge * u, y + sag];
  const ridge = [[sx, top]];
  for (let i = 1; i < 6; i++) { const k = i / 6; ridge.push([lerp(sx, rb[0], k) + (R() - 0.5) * 0.2 * w * Math.sin(k * Math.PI), lerp(top, rb[1], k)]); }
  ridge.push(rb);
  // the base: it bows toward the eye
  const baseL = [[cx - w, y + sag * 0.12], [cx - w * 0.55, y + sag * 0.8], rb], baseR = [rb, [cx + w * 0.6, y + sag * 0.74], [cx + w, y + sag * 0.12]];
  const lit = [...L, ...baseL.slice(1), ...ridge.slice(1, -1).reverse()];
  const whole = [...L, ...baseL.slice(1), ...baseR.slice(1), ...Rr.slice(1, -1).reverse()];
  const box = [cx - w * 1.2, top - 0.02 * u, cx + w * 1.2, y + sag + 0.02 * u];
  g.save();
  path(g, whole); g.closePath(); g.clip?.();
  // ---- the form, as one wash: the shaded face under everything, the lit face over it, and what turns them
  wash(g, box, Math.max(2.5, u / 22), c => {
    poly(c, whole, grade(c, cx - w * 0.2, top, cx + w, y + sag, [[0, ROCK.shade], [0.55, ROCK.shade], [1, ROCK.deep]]));
    poly(c, lit, grade(c, sx, top, cx - w * 0.5, y + sag, [[0, ROCK.top], [0.6, ROCK.lit], [1, ROCK.mid]]));
    // gullies on the lit face: where the rock turns from the light
    for (let i = 0; i < 4; i++) {
      const k0 = 0.16 + R() * 0.5, a = along(L, k0 * 0.9), b = along(ridge, Math.min(1, k0 + 0.1 + R() * 0.2)), d = along(L, Math.min(1, k0 + 0.3 + R() * 0.3));
      poly(c, [a, [lerp(a[0], b[0], 0.75), lerp(a[1], b[1], 0.75) + 0.05 * h], [lerp(d[0], b[0], 0.3), d[1]]], rgba(ROCK.mid, 0.3 + R() * 0.2));
    }
    // and light caught on the shaded one
    for (let i = 0; i < 3; i++) {
      const k0 = 0.2 + R() * 0.5, a = along(ridge, k0), b = along(Rr, Math.min(1, k0 + 0.05 + R() * 0.2)), d = along(ridge, Math.min(1, k0 + 0.26 + R() * 0.2));
      poly(c, [a, [lerp(a[0], b[0], 0.7), lerp(a[1], b[1], 0.7) + 0.06 * h], d], rgba(ROCK.mid, 0.3 + R() * 0.2));
    }
    // the light of the whole form: from the upper left, falling off to the lower right
    c.fillStyle = grade(c, cx - w, top, cx + w * 0.8, y + sag, [[0, 'rgba(255,241,214,.16)'], [0.4, 'rgba(255,241,214,0)'], [0.62, 'rgba(22,18,14,0)'], [1, 'rgba(22,18,14,.26)']]); c.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    // the turf creeps up the foot, further on the lit side
    const creep = Math.min(h * 0.2, 0.2 * u);
    c.fillStyle = grade(c, 0, y - creep, 0, y + sag, [[0, rgba(TURF.shade, 0)], [0.55, rgba(TURF.shade, 0.38)], [1, rgba(TURF.shade, 0.9)]]); c.fillRect(box[0], y - creep, box[2] - box[0], creep + sag + 0.02 * u);
    // snow: the summit down to a line that runs in tongues, lit on the one face and blue on the other
    if (P.snow > 0) {
      const s = P.snow, tongues = (a, b, n, deep) => {
        const out = [];
        for (let i = 1; i < n; i++) { const k = i / n, drop = (i % 2 ? deep : deep * 0.25) * (0.7 + R() * 0.6) * h; out.push([lerp(a[0], b[0], k), lerp(a[1], b[1], k) + drop]); }
        return out;
      };
      const l0 = along(L, s * 0.94), r0 = along(Rr, s * 0.86), m0 = along(ridge, s * 1.1);
      const upL = L.filter((p, i) => i / (L.length - 1) < s * 0.94), upR = Rr.filter((p, i) => i / (Rr.length - 1) < s * 0.86), upM = ridge.filter((p, i) => i / (ridge.length - 1) < s * 1.1);
      poly(c, [...upM, m0, ...tongues(m0, r0, 5, 0.075), r0, ...upR.slice(1).reverse()], grade(c, 0, top, 0, m0[1] + 0.08 * h, [[0, SNOW.shade], [1, SNOW.deep]]));
      poly(c, [...upL, l0, ...tongues(l0, m0, 6, 0.085), m0, ...upM.slice(1).reverse()], grade(c, 0, top, 0, m0[1] + 0.08 * h, [[0, SNOW.lit], [0.7, SNOW.mid], [1, SNOW.mid]]));
    }
  });
  // ---- the grain, fine and faint: the rock's own lines run down its faces, as the render's do
  g.lineCap = 'round';
  const lw = Math.max(0.006 * u, 0.4);
  for (let i = 0; i < 34; i++) {
    const k = 0.14 + R() * 0.8, onLit = R() < 0.5, a = along(onLit ? L : ridge, k), b = along(onLit ? ridge : Rr, k);
    const t0 = 0.1 + R() * 0.8, len = (0.06 + R() * 0.12) * h, px = lerp(a[0], b[0], t0), py = lerp(a[1], b[1], t0);
    const lean = (px - sx) / Math.max(1e-6, h) * 0.5;
    g.strokeStyle = R() < 0.55 ? rgba(ROCK.deep, 0.12 + R() * 0.14) : rgba(ROCK.top, 0.12 + R() * 0.14); g.lineWidth = lw * (0.9 + R() * 1.6);
    g.beginPath(); g.moveTo(px, py); g.lineTo(px + lean * len, py + len); g.stroke();
  }
  g.restore();
  return { cx, w, sag, whole };
}

/**
 * A grassy mound: lit on the left, shaded on the right, melting into the ground at its foot. Its whole picture is a
 * wash, its own outline too: turf has no edge.
 */
function mound(g, x, y, w, h, { pal = TURF, strength = 1 } = {}) {
  const top = y - h, d = w * F * 0.5;
  const shape = (c) => { c.beginPath(); c.moveTo(x - w, y); c.bezierCurveTo(x - w * 0.62, y - h * 0.5, x - w * 0.42, top, x - w * 0.04, top); c.bezierCurveTo(x + w * 0.4, top, x + w * 0.62, y - h * 0.46, x + w, y); c.quadraticCurveTo(x + w * 0.3, y + d, x - w * 0.2, y + d * 0.92); c.quadraticCurveTo(x - w * 0.74, y + d * 0.6, x - w, y); c.closePath(); };
  wash(g, [x - w * 1.1, top - h * 0.2, x + w * 1.1, y + d * 1.2], Math.max(1.6, w / 20), c => {
    c.save(); shape(c); c.clip?.();
    c.fillStyle = grade(c, x - w * 0.9, top, x + w * 0.9, y + d, [[0, rgba(pal.lit, strength)], [0.4, rgba(pal.mid, strength)], [0.8, rgba(pal.shade, strength)], [1, rgba(pal.deep, strength)]]);
    c.fillRect(x - w, top, 2 * w, h + d);
    // (the light on its crown, the dark under its right shoulder)
    if (c.ellipse) { c.fillStyle = glow(c, x - w * 0.3, top + h * 0.34, 0, w * 0.6, [[0, rgba(pal.lit, 0.55)], [1, rgba(pal.lit, 0)]]); c.beginPath(); c.ellipse(x - w * 0.3, top + h * 0.34, w * 0.6, h * 0.5, 0, 0, Math.PI * 2); c.fill(); }
    c.restore();
    // (its foot is the ground's own colour: it is rubbed out toward the tile)
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = grade(c, 0, y - h * 0.08, 0, y + d, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,.9)']]); c.fillRect(x - w * 1.1, y - h * 0.08, 2.2 * w, h * 0.08 + d * 1.2);
    c.globalCompositeOperation = 'source-over';
  });
}

/** A boulder: a soft lump of the rock, lit from the upper left. */
function boulder(g, x, y, r) {
  if (!g.ellipse) return;
  g.fillStyle = glow(g, x - r * 0.3, y - r * 0.5, r * 0.1, r * 1.2, [[0, ROCK.top], [0.5, ROCK.mid], [1, ROCK.deep]]);
  g.beginPath(); g.ellipse(x, y - r * 0.3, r, r * 0.72, 0, 0, Math.PI * 2); g.fill();
}

/**
 * A mountain with the middle of its footprint at (x, y). `variant` 0..2. (Its shadow on the ground is the caller's:
 * `paintMountainShadow`, laid flat before the mountain is stood up.)
 */
export function paintMountain(g, x, y, u, { variant = 0 } = {}) {
  if (!g?.save) return;
  const v = ((variant % 3) + 3) % 3, R = rng(7919 * (v + 1));
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  const peaks = MASSIFS[v];
  // where it meets the ground: a soft dark under the whole massif (the render's own contact shade), then the apron
  // of turf it stands in, wider than the peaks
  if (g.ellipse) { g.fillStyle = glow(g, x + 0.04 * u, y + 0.2 * u, 0.3 * u, 1.12 * u, [[0, 'rgba(24,30,16,.34)'], [0.6, 'rgba(24,30,16,.16)'], [1, 'rgba(24,30,16,0)']]); g.save(); g.translate(x, y + 0.2 * u); g.scale(1, F * 0.62); g.translate(-x, -(y + 0.2 * u)); g.beginPath(); g.arc(x + 0.04 * u, y + 0.2 * u, 1.12 * u, 0, Math.PI * 2); g.fill(); g.restore(); }
  mound(g, x - 0.06 * u, y + 0.16 * u, 0.98 * u, 0.22 * u, { pal: { lit: '#8f9d58', mid: '#788c47', shade: '#5c7538', deep: '#46602c' } });
  const tall = peaks.filter(p => p.h >= 1), low = peaks.filter(p => p.h < 1);
  const shadeOf = (p, dy) => {
    // (a nearer peak stands in front of what is behind it: the soft shade it throws there, up and to the right of itself)
    if (!g.ellipse) return;
    const cx = x + (p.x + 0.1) * u, cy = y + dy - p.h * 0.42 * u;
    const k = (p.h * 0.7) / p.w;
    g.save(); g.translate(cx, cy); g.scale(1, k); g.translate(-cx, -cy);
    g.fillStyle = glow(g, cx, cy, p.w * 0.2 * u, p.w * 1.0 * u, [[0, 'rgba(26,22,18,.3)'], [1, 'rgba(26,22,18,0)']]);
    g.beginPath(); g.ellipse(cx, cy, p.w * 1.0 * u, p.w * 1.0 * u, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  };
  tall.forEach((p, i) => { if (i) shadeOf(p, 0); peak(g, x, y, u, p, R); });
  // pines on the flanks, behind the low spurs
  for (const [dx, dy, s, k] of [[-0.86, 0.02, 0.62, 0], [0.84, 0.06, 0.56, 1], [-0.7, 0.16, 0.5, 2]].slice(0, 2 + (v % 2))) paintTree(g, x + dx * u, y + dy * u, u * s, { kind: 'fir', variant: k });
  for (const p of low) { shadeOf(p, 0.1 * u); peak(g, x, y + 0.1 * u, u, p, R); }
  // foothills and boulders along the near base
  const hills = [[-0.66, 0.26, 0.3, 0.17], [0.62, 0.28, 0.32, 0.16], [0.02, 0.36, 0.36, 0.15], [-0.3, 0.33, 0.24, 0.12], [0.34, 0.36, 0.22, 0.11]];
  for (const [dx, dy, w, h] of hills.slice(0, 4 + (v === 2 ? 1 : 0))) mound(g, x + (dx + (R() - 0.5) * 0.08) * u, y + dy * u, w * u, h * u);
  for (let i = 0; i < 4; i++) boulder(g, x + (-0.7 + R() * 1.4) * u, y + (0.3 + R() * 0.14) * u, (0.035 + R() * 0.035) * u);
  if (v !== 1) paintTree(g, x + (v ? -0.42 : 0.5) * u, y + 0.42 * u, u * 0.5, { kind: 'fir', variant: v });
  g.restore();
}

/** A mountain's shadow on the ground, to the lower right of its footprint at (x, y): laid flat (before the mountain is stood up), soft to its edge. */
export function paintMountainShadow(g, x, y, u, { alpha = RELIEF.shadow } = {}) {
  if (!g?.ellipse) return;
  g.save(); g.translate(x, y + 0.18 * u); g.rotate(0.26);
  g.scale(1, 0.31);
  g.fillStyle = glow(g, 0.56 * u, 0, 0.2 * u, 1.24 * u, [[0, `rgba(22,22,14,${alpha})`], [0.55, `rgba(22,22,14,${alpha * 0.6})`], [1, 'rgba(22,22,14,0)']]);
  g.beginPath(); g.ellipse(0.56 * u, 0, 1.24 * u, 1.24 * u, 0, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ trees
/** A tree with its foot at (x, y), about `u` × 0.7 tall. `kind` 'fir' | 'leaf'; `variant` 0..2. */
export function paintTree(g, x, y, u, { kind = 'fir', variant = 0 } = {}) {
  if (!g?.save) return;
  const v = ((variant % 3) + 3) % 3;
  g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
  // where it stands: a little dark at its foot
  if (g.ellipse) { g.fillStyle = glow(g, x + 0.02 * u, y, 0.02 * u, 0.2 * u, [[0, 'rgba(14,26,14,.42)'], [1, 'rgba(14,26,14,0)']]); g.save(); g.translate(x, y); g.scale(1, 0.42); g.translate(-x, -y); g.beginPath(); g.arc(x + 0.02 * u, y, 0.2 * u, 0, Math.PI * 2); g.fill(); g.restore(); }
  if (kind === 'fir') {
    const c = FIR[v], h = (0.66 + v * 0.04) * u, w = (0.2 + (v === 1 ? 0.03 : 0)) * u, tiers = v === 2 ? 4 : 3;
    // the trunk's foot
    g.fillStyle = BARK.shade; g.fillRect(x - 0.02 * u, y - 0.09 * u, 0.04 * u, 0.09 * u);
    for (let i = 0; i < tiers; i++) {
      const k0 = i / tiers, k1 = (i + 1.55) / tiers, yb = y - 0.06 * u - (h - 0.06 * u) * k0 * 0.86, yt = y - Math.min(h, 0.06 * u + (h - 0.06 * u) * Math.min(1, k1 * 0.92)), ww = w * (1 - k0 * 0.6);
      const ty = i === tiers - 1 ? y - h : yt;
      // the tier: a rounded skirt, turning from the light on its left to shade on its right, dark under its hem
      const skirt = () => { g.beginPath(); g.moveTo(x, ty); g.quadraticCurveTo(x - ww * 0.42, lerp(ty, yb, 0.62), x - ww, yb); g.quadraticCurveTo(x - ww * 0.5, yb + 0.05 * u, x, yb + 0.022 * u); g.quadraticCurveTo(x + ww * 0.5, yb + 0.05 * u, x + ww, yb); g.quadraticCurveTo(x + ww * 0.42, lerp(ty, yb, 0.62), x, ty); g.closePath(); };
      // (the shade the tier above throws on this one)
      skirt(); g.fillStyle = grade(g, x - ww, 0, x + ww, 0, [[0, c.lit], [0.3, c.lit], [0.52, c.mid], [0.8, c.shade], [1, c.deep]]); g.fill();
      skirt(); g.fillStyle = grade(g, 0, ty, 0, yb + 0.05 * u, [[0, 'rgba(8,22,12,.34)'], [0.34, 'rgba(8,22,12,0)'], [0.8, 'rgba(8,22,12,0)'], [1, 'rgba(8,22,12,.3)']]); g.fill();
      // the light along its upper left
      g.strokeStyle = rgba(c.lit, 0.5); g.lineWidth = Math.max(0.5, 0.016 * u); g.beginPath(); g.moveTo(x - ww * 0.14, lerp(ty, yb, 0.2)); g.quadraticCurveTo(x - ww * 0.5, lerp(ty, yb, 0.66), x - ww * 0.8, yb - 0.01 * u); g.stroke();
    }
  } else {
    const c = LEAF[v], r = (0.2 + (v === 0 ? 0.02 : 0)) * u, cy = y - (0.29 + v * 0.03) * u;
    // the trunk
    poly(g, [[x - 0.028 * u, y], [x + 0.028 * u, y], [x + 0.02 * u, cy], [x - 0.02 * u, cy]], grade(g, x - 0.03 * u, 0, x + 0.03 * u, 0, [[0, BARK.lit], [1, BARK.shade]]));
    // the crown: a few lobes, dark below and to the right, light above and to the left; each turns without an edge
    const lobes = v === 1 ? [[0.5, 0.26, 0.74], [-0.56, 0.2, 0.78], [0.02, -0.02, 1], [-0.3, -0.5, 0.74], [0.4, -0.4, 0.66]] : v === 2 ? [[0.42, 0.22, 0.78], [-0.46, 0.26, 0.74], [0, -0.1, 1], [0.04, -0.72, 0.7]] : [[0.56, 0.16, 0.72], [-0.52, 0.2, 0.76], [0.06, 0, 1], [-0.34, -0.52, 0.7], [0.36, -0.5, 0.62]];
    g.fillStyle = c.deep; g.beginPath(); for (const [dx, dy, s] of lobes) { g.moveTo(x + dx * r + s * r * 1.03, cy + dy * r + 0.03 * u); g.arc(x + dx * r, cy + dy * r + 0.03 * u, s * r * 1.03, 0, Math.PI * 2); } g.fill();
    for (const [dx, dy, s] of lobes) {
      const lx = x + dx * r, ly = cy + dy * r, lr = s * r;
      // (lit from the upper left: the light's middle stands off the lobe's own)
      const gr = g.createRadialGradient?.(lx - lr * 0.38, ly - lr * 0.42, lr * 0.06, lx, ly, lr);
      if (gr?.addColorStop) { gr.addColorStop(0, c.lit); gr.addColorStop(0.5, c.mid); gr.addColorStop(0.86, c.shade); gr.addColorStop(1, rgba(c.shade, 0)); }
      g.fillStyle = gr?.addColorStop ? gr : c.mid;
      g.beginPath(); g.arc(lx, ly, lr, 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();
}

/** How many trees a wood has at most, and how far from the tile's middle they stand (units of the hex radius). */
export const WOOD = Object.freeze({ trees: 27, reach: 0.86, floor: 0.4, clearing: 0.56 });
/** The mix of a wood by its tile's variant (1..3): the share of firs, and the size of its trees. */
const MIX = Object.freeze([{ fir: 0.78, size: 0.86 }, { fir: 0.34, size: 0.88 }, { fir: 0.56, size: 0.84 }]);

/**
 * The trees of the wood on hex (q, r): `[{x, y, s, kind, variant}]`, back to front; x, y from the tile's middle in
 * units of the hex radius (y already flattened as the ground is), `s` the tree's own scale. The same wood every time.
 */
export function woodOf(q, r, variant = 1, { ring = false } = {}) {
  // `ring`: the wood round a site's clearing: its trees stand along the tile's rim and leave the middle free
  const R = rng((q * 73856093) ^ (r * 19349663) ^ 0x5bd1e995), mix = MIX[(((variant - 1) % 3) + 3) % 3];
  const out = [];
  // a loose ring and a filled middle: rows across the hexagon, each spot pushed about, a few left empty
  const rows = [[-0.7, 3], [-0.47, 5], [-0.24, 6], [-0.01, 6], [0.22, 5], [0.45, 4], [0.66, 2]];
  for (const [ry, n] of rows) for (let i = 0; i < n; i++) {
    if (R() < 0.07) continue;
    const span = WOOD.reach * (1 - Math.abs(ry) * 0.5), fx = n === 1 ? 0 : -span + (2 * span * i) / (n - 1);
    const x = fx + (R() - 0.5) * 0.17, y = (ry + (R() - 0.5) * 0.14) * FLATTEN;
    if (ring && Math.hypot(x, y / FLATTEN) < WOOD.clearing) continue;
    out.push({ x, y, s: mix.size * (0.82 + R() * 0.4), kind: R() < mix.fir ? 'fir' : 'leaf', variant: Math.floor(R() * 3) });
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out.slice(0, WOOD.trees);
}

/**
 * The floor of a wood, laid flat on the ground of its tile (middle at (x, y), `u` the hex radius): the shade under
 * the crowns and each tree's own shadow to the lower right. `trees`: woodOf's list.
 */
export function paintWoodFloor(g, x, y, u, trees, { ring = false } = {}) {
  if (!g?.ellipse) return;
  g.save();
  if (!ring) {
    // the shade under the crowns: deepest in the middle of the wood, gone at the tile's rim
    g.save(); g.translate(x, y + 0.03 * u); g.scale(1, FLATTEN * 0.96); g.translate(-x, -(y + 0.03 * u));
    g.fillStyle = glow(g, x, y + 0.03 * u, 0.18 * u, 0.94 * u, [[0, 'rgba(22,48,24,.5)'], [0.62, 'rgba(22,48,24,.34)'], [1, 'rgba(22,48,24,0)']]);
    g.beginPath(); g.ellipse(x, y + 0.03 * u, 0.94 * u, 0.94 * u, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // each tree's own shadow, to its lower right: soft to its edge
  for (const t of trees) {
    const tx = x + (t.x + 0.1 * t.s) * u, ty = y + (t.y + 0.03 * t.s) * u, rx = 0.26 * t.s * u;
    g.save(); g.translate(tx, ty); g.rotate(0.2); g.scale(1, 0.44);
    g.fillStyle = glow(g, 0, 0, rx * 0.15, rx, [[0, `rgba(18,38,20,${WOOD.floor})`], [1, 'rgba(18,38,20,0)']]);
    g.beginPath(); g.ellipse(0, 0, rx, rx, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.restore();
}

// ------------------------------------------------------------------ the bitmaps
const sprites = new Map();
/** The steps of resolution a piece is kept at (device px per unit `u`). */
const SIZES = Object.freeze([10, 14, 20, 28, 38, 52, 70, 94, 126, 168, 224]);
const PAINT = { mountain: paintMountain, fir: (g, x, y, u, o) => paintTree(g, x, y, u, { ...o, kind: 'fir' }), leaf: (g, x, y, u, o) => paintTree(g, x, y, u, { ...o, kind: 'leaf' }) };

/**
 * A piece of relief as a bitmap for `px` device px of `u` on screen: `{cv, ox, oy, w, h}` in units of `u` (draw it at
 * `(x − ox·u, y − oy·u, w·u, h·u)` for the middle of its footprint, a tree's foot, at (x, y)), or null where no spare
 * canvas can be made (the caller paints it straight). `kind` 'mountain' | 'fir' | 'leaf'; `variant` 0..2.
 * Never made smaller than it is shown.
 */
export function reliefSprite(kind, px, variant = 0) {
  const r = SIZES.find(s => s >= px * 0.97) ?? SIZES[SIZES.length - 1], v = ((variant % 3) + 3) % 3;
  const key = `${kind}|${r}|${v}`;
  if (sprites.has(key)) return sprites.get(key);
  const B = RELIEF[kind === 'fir' || kind === 'leaf' ? 'tree' : kind], w = Math.ceil((B.left + B.right) * r), h = Math.ceil((B.top + B.bottom) * r);
  const cv = spare(w, h), g = cv?.getContext?.('2d');
  if (!g) { sprites.set(key, null); return null; }
  PAINT[kind](g, B.left * r, B.top * r, r, { variant: v });
  const out = { cv, ox: B.left, oy: B.top, w: B.left + B.right, h: B.top + B.bottom };
  sprites.set(key, out);
  return out;
}
