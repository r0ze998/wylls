// The relief of the board, drawn by code (UX brief §12.2): mountains and woods
// are upright art in the same hand as the villages (map/village.mjs)
// and the bell's tower: painted faces with soft shading, light from the upper
// left, a thin ink line, a shadow cast to the lower right. The baked sprites
// were one tile's picture seen from above; stood upright and enlarged they
// were soft and squat. Here every piece is drawn at whatever size the screen
// asks for and kept as a bitmap for that size, so a frame is a copy. (Hills
// were tried the same way and lost to the baked ground, whose soft mounds
// read as rolling land; a row of drawn knolls read as gumdrops. They stay.)
//
//   a mountain   a massif of two to four peaks: a lit face and a shaded face
//                either side of a wandering ridge, gullies and strata, a snow
//                cap whose edge runs down in tongues, scree and grassy
//                foothills at its base, a few pines. Three variants.
//   a wood       single trees, each standing on its own spot of the tile (so
//                each is upright where it stands and as large as its row):
//                firs in tiers and round broadleaf crowns, three variants of
//                each; where they stand is seeded by the tile, the mix by the
//                tile's variant; the floor under them is laid on the ground.
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
  foot: 0.3, shadow: 0.24,
});

const ROCK = { lit0: '#e3d2b4', lit1: '#bda683', lit2: '#97835e', shade0: '#81756d', shade1: '#5b504a', shade2: '#463f34', line: 'rgba(44,36,26,.6)', crack: 'rgba(50,40,28,.3)' };
const SNOW = { lit: '#fdfcf6', mid: '#eef1f4', shade: '#c0cce0', deep: '#9aabc6' };
const GRASS = { lit: '#9db760', mid: '#7c9a4c', shade: '#55733a', deep: '#3d5a30' };
const FIR = [{ lit: '#3f7a46', mid: '#28593a', shade: '#183f2d', deep: '#0f2c21' }, { lit: '#357050', mid: '#1f523c', shade: '#133a2e', deep: '#0c2921' }, { lit: '#4a8044', mid: '#2f6236', shade: '#1c452b', deep: '#12301f' }];
const LEAF = [{ lit: '#86ab45', mid: '#5a8636', shade: '#35602a', deep: '#22431f' }, { lit: '#a2b84a', mid: '#718f37', shade: '#45692b', deep: '#2c4a20' }, { lit: '#6c9c42', mid: '#487834', shade: '#2b5629', deep: '#1c3d1f' }];
const BARK = { lit: '#8a6a44', shade: '#4d371f' };
const INK = 'rgba(26,36,20,.55)';

/** A small seeded generator (the same picture every time). */
function rng(seed) {
  let a = (seed | 0) || 1;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const lerp = (a, b, k) => a + (b - a) * k;
const path = (g, pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); };
const poly = (g, pts, fill, stroke = null, lw = 0) => { path(g, pts); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); } };
/** The point `k` (0..1) of the way along a polyline. */
function along(pts, k) {
  const n = pts.length - 1, f = Math.max(0, Math.min(1, k)) * n, i = Math.min(n - 1, Math.floor(f)), t = f - i;
  return [lerp(pts[i][0], pts[i + 1][0], t), lerp(pts[i][1], pts[i + 1][1], t)];
}
/** A top-to-bottom gradient between two heights, or the middle colour where there are no gradients. */
function fall(g, y0, y1, stops) {
  if (!g.createLinearGradient) return stops[Math.floor(stops.length / 2)][1];
  const gr = g.createLinearGradient(0, y0, 0, y1);
  for (const [k, c] of stops) gr.addColorStop(k, c);
  return gr;
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

/** One peak: its faces, its gullies and strata, its snow, its line. */
function peak(g, x, y, u, P, R, lw) {
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
  const shade = [...ridge, ...baseR.slice(1), ...Rr.slice(1, -1).reverse()];
  const whole = [...L, ...baseL.slice(1), ...baseR.slice(1), ...Rr.slice(1, -1).reverse()];
  poly(g, shade, fall(g, top, y + sag, [[0, ROCK.shade0], [0.5, ROCK.shade1], [0.86, ROCK.shade2], [1, '#4f5a38']]));
  poly(g, lit, fall(g, top, y + sag, [[0, ROCK.lit0], [0.45, ROCK.lit1], [0.82, ROCK.lit2], [1, '#869356']]));
  // the painter's marks, kept inside the peak: gullies on the lit face, light caught on the shaded one, strata, a wash of moss at the foot
  g.save();
  path(g, whole); g.closePath(); g.clip?.();
  for (let i = 0; i < 4; i++) {
    const k0 = 0.16 + R() * 0.5, a = along(L, k0 * 0.9), b = along(ridge, Math.min(1, k0 + 0.1 + R() * 0.2)), c = along(L, Math.min(1, k0 + 0.3 + R() * 0.3));
    poly(g, [a, [lerp(a[0], b[0], 0.75), lerp(a[1], b[1], 0.75) + 0.05 * h], [lerp(c[0], b[0], 0.3), c[1]]], `rgba(86,70,48,${0.1 + R() * 0.1})`);
  }
  for (let i = 0; i < 3; i++) {
    const k0 = 0.2 + R() * 0.5, a = along(ridge, k0), b = along(Rr, Math.min(1, k0 + 0.05 + R() * 0.2)), c = along(ridge, Math.min(1, k0 + 0.26 + R() * 0.2));
    poly(g, [a, [lerp(a[0], b[0], 0.7), lerp(a[1], b[1], 0.7) + 0.06 * h], c], `rgba(255,236,204,${0.07 + R() * 0.07})`);
  }
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const k = 0.24 + R() * 0.68, onLit = R() < 0.55, a = along(onLit ? L : ridge, k), b = along(onLit ? ridge : Rr, Math.min(1, k + (R() - 0.3) * 0.12));
    const t0 = 0.12 + R() * 0.3, t1 = t0 + 0.2 + R() * 0.35;
    g.strokeStyle = onLit ? `rgba(70,56,38,${0.2 + R() * 0.14})` : `rgba(26,22,16,${0.2 + R() * 0.14})`; g.lineWidth = lw * (0.8 + R() * 0.7);
    g.beginPath(); g.moveTo(lerp(a[0], b[0], t0), lerp(a[1], b[1], t0)); g.lineTo(lerp(a[0], b[0], t1), lerp(a[1], b[1], t1) + (R() - 0.5) * 0.03 * h); g.stroke();
  }
  if (g.createLinearGradient) {
    // the form: the shaded side falls darker to the lower right, the lit side is brightest toward the upper left
    const form = g.createLinearGradient(cx - w, top, cx + w, y + sag);
    form.addColorStop(0, 'rgba(255,244,214,.2)'); form.addColorStop(0.42, 'rgba(255,244,214,0)'); form.addColorStop(0.6, 'rgba(20,16,12,0)'); form.addColorStop(1, 'rgba(20,16,12,.34)');
    g.fillStyle = form; g.fillRect(cx - w * 1.3, top, w * 2.6, h + sag);
    g.fillStyle = fall(g, y - h * 0.3, y + sag, [[0, 'rgba(96,122,62,0)'], [0.7, 'rgba(96,122,62,.4)'], [1, 'rgba(92,120,58,.78)']]); g.fillRect(cx - w * 1.2, y - h * 0.3, w * 2.4, h * 0.3 + sag);
  }
  g.restore();
  // snow: the summit down to a line that runs in tongues, lit on the one face and blue on the other
  if (P.snow > 0) {
    const s = P.snow, tongues = (a, b, n, deep) => {
      const out = [];
      for (let i = 1; i < n; i++) { const k = i / n, drop = (i % 2 ? deep : deep * 0.25) * (0.7 + R() * 0.6) * h; out.push([lerp(a[0], b[0], k), lerp(a[1], b[1], k) + drop]); }
      return out;
    };
    const l0 = along(L, s * 0.94), r0 = along(Rr, s * 0.86), m0 = along(ridge, s * 1.1);
    const upL = L.filter((p, i) => i / (L.length - 1) < s * 0.94), upR = Rr.filter((p, i) => i / (Rr.length - 1) < s * 0.86), upM = ridge.filter((p, i) => i / (ridge.length - 1) < s * 1.1);
    poly(g, [...upM, m0, ...tongues(m0, r0, 5, 0.075), r0, ...upR.slice(1).reverse()], fall(g, top, m0[1] + 0.08 * h, [[0, SNOW.shade], [1, SNOW.deep]]));
    poly(g, [...upL, l0, ...tongues(l0, m0, 6, 0.085), m0, ...upM.slice(1).reverse()], fall(g, top, m0[1] + 0.08 * h, [[0, SNOW.lit], [0.7, SNOW.mid], [1, '#dfe8f4']]));
    // (the light along the snow's ridge)
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = lw * 1.2; path(g, [...upM, m0]); g.stroke();
  }
  // the ridge's own line, and the peak's outline
  g.strokeStyle = 'rgba(46,38,28,.34)'; g.lineWidth = lw; path(g, ridge.slice(P.snow > 0 ? Math.ceil(P.snow * 1.1 * (ridge.length - 1)) : 0)); g.stroke();
  g.strokeStyle = ROCK.line; g.lineWidth = lw * 1.15; g.lineJoin = 'round';
  path(g, [...L.slice().reverse(), ...Rr.slice(1)]); g.stroke();
  return { cx, w, sag };
}

/** A grassy mound at a mountain's foot: lit on the left, shaded on the right. */
function mound(g, x, y, w, h, lw, { tone = GRASS, line = true } = {}) {
  const top = y - h, d = w * F * 0.5;
  const shape = () => { g.beginPath(); g.moveTo(x - w, y); g.bezierCurveTo(x - w * 0.62, y - h * 0.5, x - w * 0.42, top, x - w * 0.04, top); g.bezierCurveTo(x + w * 0.4, top, x + w * 0.62, y - h * 0.46, x + w, y); g.quadraticCurveTo(x + w * 0.3, y + d, x - w * 0.2, y + d * 0.92); g.quadraticCurveTo(x - w * 0.74, y + d * 0.6, x - w, y); g.closePath(); };
  shape();
  if (g.createLinearGradient) { const gr = g.createLinearGradient(x - w, top, x + w * 0.9, y + d); gr.addColorStop(0, tone.lit); gr.addColorStop(0.42, tone.mid); gr.addColorStop(0.8, tone.shade); gr.addColorStop(1, tone.deep); g.fillStyle = gr; } else g.fillStyle = tone.mid;
  g.fill();
  // the light on its shoulder
  g.save(); shape(); g.clip?.();
  g.fillStyle = 'rgba(232,240,170,.2)'; g.beginPath(); g.ellipse?.(x - w * 0.34, top + h * 0.3, w * 0.5, h * 0.34, -0.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(24,44,22,.22)'; g.beginPath(); g.ellipse?.(x + w * 0.66, y - h * 0.1, w * 0.5, h * 0.6, 0.5, 0, Math.PI * 2); g.fill();
  g.restore();
  if (line) { g.strokeStyle = 'rgba(40,58,28,.5)'; g.lineWidth = lw; g.beginPath(); g.moveTo(x - w, y); g.bezierCurveTo(x - w * 0.62, y - h * 0.5, x - w * 0.42, top, x - w * 0.04, top); g.bezierCurveTo(x + w * 0.4, top, x + w * 0.62, y - h * 0.46, x + w, y); g.stroke(); }
}

/** A boulder. */
function boulder(g, x, y, r, lw) {
  poly(g, [[x - r, y], [x - r * 0.7, y - r * 0.8], [x + r * 0.1, y - r * 1.05], [x + r * 0.9, y - r * 0.5], [x + r, y + r * 0.1], [x, y + r * 0.3]], ROCK.shade1, ROCK.line, lw * 0.8);
  poly(g, [[x - r, y], [x - r * 0.7, y - r * 0.8], [x + r * 0.1, y - r * 1.05], [x + r * 0.05, y + r * 0.1], [x - r * 0.4, y + r * 0.2]], ROCK.lit1);
}

/**
 * A mountain with the middle of its footprint at (x, y). `variant` 0..2. (Its shadow on the ground is the caller's:
 * `paintMountainShadow`, laid flat before the mountain is stood up.)
 */
export function paintMountain(g, x, y, u, { variant = 0 } = {}) {
  if (!g?.save) return;
  const v = ((variant % 3) + 3) % 3, R = rng(7919 * (v + 1)), lw = Math.max(0.012 * u, 0.5);
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  const peaks = MASSIFS[v];
  // the scree the massif stands in: a low apron of rubble and turf, wider than the peaks
  mound(g, x - 0.06 * u, y + 0.16 * u, 0.98 * u, 0.22 * u, lw, { tone: { lit: '#a9ad74', mid: '#8a9458', shade: '#667a45', deep: '#4a6337' }, line: false });
  const tall = peaks.filter(p => p.h >= 1), low = peaks.filter(p => p.h < 1);
  for (const p of tall) peak(g, x, y, u, p, R, lw);
  // pines on the flanks, behind the low spurs
  for (const [dx, dy, s, k] of [[-0.86, 0.02, 0.62, 0], [0.84, 0.06, 0.56, 1], [-0.7, 0.16, 0.5, 2]].slice(0, 2 + (v % 2))) paintTree(g, x + dx * u, y + dy * u, u * s, { kind: 'fir', variant: k });
  for (const p of low) {
    // (a spur stands in front of the massif: the shade it throws on the face behind it)
    if (g.ellipse && p.h < 0.7 && Math.abs(p.x) < 0.3) { g.fillStyle = 'rgba(30,22,14,.2)'; g.beginPath(); g.ellipse(x + (p.x + 0.06) * u, y + (0.1 - p.h * 0.42) * u, p.w * 0.72 * u, p.h * 0.66 * u, 0, 0, Math.PI * 2); g.fill(); }
    peak(g, x, y + 0.1 * u, u, p, R, lw);
  }
  // foothills and boulders along the near base
  const hills = [[-0.66, 0.26, 0.3, 0.17], [0.62, 0.28, 0.32, 0.16], [0.02, 0.36, 0.36, 0.15], [-0.3, 0.33, 0.24, 0.12], [0.34, 0.36, 0.22, 0.11]];
  for (const [dx, dy, w, h] of hills.slice(0, 4 + (v === 2 ? 1 : 0))) mound(g, x + (dx + (R() - 0.5) * 0.08) * u, y + dy * u, w * u, h * u, lw);
  for (let i = 0; i < 4; i++) boulder(g, x + (-0.7 + R() * 1.4) * u, y + (0.3 + R() * 0.14) * u, (0.035 + R() * 0.035) * u, lw);
  if (v !== 1) paintTree(g, x + (v ? -0.42 : 0.5) * u, y + 0.42 * u, u * 0.5, { kind: 'fir', variant: v });
  g.restore();
}

/** A mountain's shadow on the ground, to the lower right of its footprint at (x, y): laid flat (before the mountain is stood up). */
export function paintMountainShadow(g, x, y, u, { alpha = RELIEF.shadow } = {}) {
  if (!g?.ellipse) return;
  g.save(); g.translate(x, y + 0.18 * u); g.rotate(0.26);
  g.fillStyle = `rgba(22,20,14,${alpha * 0.55})`; g.beginPath(); g.ellipse(0.72 * u, 0.02 * u, 1.18 * u, 0.36 * u, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = `rgba(22,20,14,${alpha})`; g.beginPath(); g.ellipse(0.5 * u, 0, 0.84 * u, 0.26 * u, 0, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ trees
/** A tree with its foot at (x, y), about `u` × 0.7 tall. `kind` 'fir' | 'leaf'; `variant` 0..2. */
export function paintTree(g, x, y, u, { kind = 'fir', variant = 0 } = {}) {
  if (!g?.save) return;
  const v = ((variant % 3) + 3) % 3, lw = Math.max(0.014 * u, 0.4);
  g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
  if (kind === 'fir') {
    const c = FIR[v], h = (0.66 + v * 0.04) * u, w = (0.2 + (v === 1 ? 0.03 : 0)) * u, tiers = v === 2 ? 4 : 3;
    // the trunk's foot
    g.fillStyle = BARK.shade; g.fillRect(x - 0.022 * u, y - 0.1 * u, 0.044 * u, 0.1 * u);
    for (let i = 0; i < tiers; i++) {
      const k0 = i / tiers, k1 = (i + 1.55) / tiers, yb = y - 0.06 * u - (h - 0.06 * u) * k0 * 0.86, yt = y - Math.min(h, 0.06 * u + (h - 0.06 * u) * Math.min(1, k1 * 0.92)), ww = w * (1 - k0 * 0.6);
      const tip = i === tiers - 1 ? [x, y - h] : [x, yt];
      // the tier: a skirt with a scalloped hem, lit on the left
      const hem = [[x - ww, yb], [x - ww * 0.5, yb + 0.024 * u], [x, yb - 0.006 * u], [x + ww * 0.52, yb + 0.026 * u], [x + ww, yb]];
      poly(g, [tip, ...hem.slice(2)], c.shade);
      poly(g, [tip, ...hem.slice(0, 3)], c.mid);
      poly(g, [tip, [x - ww, yb], [x - ww * 0.5, yb + 0.024 * u], [x - ww * 0.34, lerp(yb, tip[1], 0.34)]], c.lit);
      g.strokeStyle = INK; g.lineWidth = lw; path(g, [hem[0], tip, hem[4]]); g.stroke();
      g.fillStyle = 'rgba(8,20,12,.22)'; poly(g, [[x - ww * 0.7, yb + 0.012 * u], [x + ww * 0.74, yb + 0.014 * u], [x + ww * 0.4, yb - 0.03 * u], [x - ww * 0.4, yb - 0.03 * u]], 'rgba(8,20,12,.16)');
    }
  } else {
    const c = LEAF[v], r = (0.2 + (v === 0 ? 0.02 : 0)) * u, cy = y - (0.29 + v * 0.03) * u;
    // the trunk
    poly(g, [[x - 0.03 * u, y], [x + 0.03 * u, y], [x + 0.022 * u, cy], [x - 0.022 * u, cy]], BARK.shade);
    poly(g, [[x - 0.03 * u, y], [x, y], [x - 0.002 * u, cy], [x - 0.022 * u, cy]], BARK.lit);
    // the crown: a few lobes, dark below and to the right, light above and to the left
    const lobes = v === 1 ? [[0.5, 0.26, 0.74], [-0.56, 0.2, 0.78], [0.02, -0.02, 1], [-0.3, -0.5, 0.74], [0.4, -0.4, 0.66]] : v === 2 ? [[0.42, 0.22, 0.78], [-0.46, 0.26, 0.74], [0, -0.1, 1], [0.04, -0.72, 0.7]] : [[0.56, 0.16, 0.72], [-0.52, 0.2, 0.76], [0.06, 0, 1], [-0.34, -0.52, 0.7], [0.36, -0.5, 0.62]];
    g.fillStyle = c.deep; g.beginPath(); for (const [dx, dy, s] of lobes) { g.moveTo(x + dx * r + s * r * 1.06, cy + dy * r + 0.03 * u); g.arc(x + dx * r, cy + dy * r + 0.03 * u, s * r * 1.06, 0, Math.PI * 2); } g.fill();
    for (const [dx, dy, s] of lobes) {
      const lx = x + dx * r, ly = cy + dy * r, lr = s * r;
      if (g.createRadialGradient) { const gr = g.createRadialGradient(lx - lr * 0.4, ly - lr * 0.45, lr * 0.1, lx, ly, lr); gr.addColorStop(0, c.lit); gr.addColorStop(0.55, c.mid); gr.addColorStop(1, c.shade); g.fillStyle = gr; } else g.fillStyle = c.mid;
      g.beginPath(); g.arc(lx, ly, lr, 0, Math.PI * 2); g.fill();
      g.strokeStyle = INK; g.lineWidth = lw; g.beginPath(); g.arc(lx, ly, lr, 0.1, Math.PI * 0.95); g.stroke();
    }
    // leaf light
    g.fillStyle = 'rgba(238,246,170,.16)';
    for (const [dx, dy, s] of lobes.slice(2)) { g.beginPath(); g.ellipse?.(x + dx * r - s * r * 0.36, cy + dy * r - s * r * 0.42, s * r * 0.34, s * r * 0.2, -0.6, 0, Math.PI * 2); g.fill(); }
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
    g.fillStyle = 'rgba(22,48,24,.3)';
    g.beginPath(); g.ellipse(x, y + 0.03 * u, 0.9 * u, 0.9 * u * FLATTEN * 0.96, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(x, y + 0.03 * u, 0.7 * u, 0.7 * u * FLATTEN, 0, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = `rgba(20,40,20,${WOOD.floor})`;
  g.beginPath();
  for (const t of trees) { const tx = x + (t.x + 0.1 * t.s) * u, ty = y + (t.y + 0.03 * t.s) * u; g.moveTo(tx + 0.23 * t.s * u, ty); g.ellipse(tx, ty, 0.23 * t.s * u, 0.1 * t.s * u, 0.2, 0, Math.PI * 2); }
  g.fill();
  g.restore();
}

// ------------------------------------------------------------------ the bitmaps
const sprites = new Map();
const spare = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);
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
