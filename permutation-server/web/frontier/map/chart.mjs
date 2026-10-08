// The surveyor's chart (UX brief §1, §3): the materials of what the viewer
// has not seen, and the edge where the chart meets the painted land.
//
//   the chart (L1)      parchment drawn by code (a cached texture: paper tone,
//                       fibres, faint stains), a sepia hex lattice in a slightly
//                       unsteady hand, and small ink glyphs for the terrain
//                       (mountain, hills, forest, water, grass, plain). Terrain is
//                       public (it comes from the ring seeds); nothing else is on it.
//   surveyed (L2)       the painted land, muted (saturation 0.35, brightness 0.7)
//   the edge            a wet edge, as watercolour meets paper (UX brief §11.4):
//                       the pigment thins over the last third of a hex, ends in
//                       a thin darker line that wavers at two scales, and
//                       leaves a pale halo of bare paper beyond it; the chart's
//                       own ink is quieter near the paint (about half)
//   the reveal          a tile seen for the first time dissolves out of the chart
//
// Everything is drawn into the bitmaps the map already keeps (a province's
// ground at the tile view, its far bitmap further out), so a resting frame
// costs nothing more. No asset files. Context-tolerant: without a canvas
// (tests) every function returns quietly.
import { FLATTEN, RADIUS, hexPoints, project } from '../../map.mjs';
import { L } from '../../lang.mjs';
import { DIRECTIONS, ringOf, ringProvinces, tileHex, wedgeOf, PROVINCE_TILES, locate } from '../fgeo.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { L2, L3, REVEAL_MS, WORKED_RADIUS, hexKey, keyHex } from './survey.mjs';
import { upright } from './tilt.mjs';

/** The chart's colours (the brief's --chart and --chart-ink, and the inks drawn with them). */
export const CHART = Object.freeze({ paper: '#e6d9b8', paperRgb: [230, 217, 184], ink: '#7a6a46', line: 'rgba(110,94,60,0.4)', glyph: 'rgba(92,76,46,0.82)', coast: 'rgba(86,72,44,0.7)',
  wash: Object.freeze({ water: 'rgba(84,122,130,0.27)', mountain: 'rgba(108,88,58,0.17)', hills: 'rgba(134,108,60,0.11)', forest: 'rgba(92,110,58,0.15)' }) });
/** The muted look of surveyed land that is not in sight. */
export const MUTED = Object.freeze({ saturation: 0.35, brightness: 0.7, paper: 0.18 });
/** The gold of what is the viewer's own (the brief's --you). */
export const YOU = '#f3d58a';

const SQRT3 = Math.sqrt(3);
const TEX = 512;
const spare = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);
/**
 * The clock of every tween the map draws by itself (the reveal, the landing's flood, the lit tiles' roll-out, the
 * breath of the viewer's own land): milliseconds on the effects clock (fx/clock.mjs publishes it as
 * `globalThis.__fxNow`, in seconds), so the demo switch freezes, slows and steps all of it together with the
 * effects; the page's own clock where there is no effects layer.
 */
export const fxNow = () => { const f = globalThis.__fxNow; return typeof f === 'function' ? f() * 1000 : globalThis.performance?.now?.() ?? Date.now(); };

// ------------------------------------------------------------------ noise
const hash2 = (a, b, c = 0) => { let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1); h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return (h >>> 0) / 4294967296; };
const smooth = t => t * t * (3 - 2 * t);
/** Value noise on the integer lattice, −1..1; `wrap` > 0 makes it repeat every `wrap` cells. */
function vnoise(x, y, seed = 0, wrap = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
  const at = (i, j) => (wrap ? hash2(((i % wrap) + wrap) % wrap, ((j % wrap) + wrap) % wrap, seed) : hash2(i, j, seed));
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return (a + (b - a) * fx + (c - a + (d - c - b + a) * fx) * fy) * 2 - 1;
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------ the paper
let paper;
/**
 * The parchment: one texture that repeats without a seam. Tone that drifts
 * (two octaves), a fine grain, fibres lying mostly one way, a few specks.
 * Made once; null where there is no canvas.
 */
export function parchment() {
  if (paper !== undefined) return paper;
  const cv = spare(TEX, TEX), g = cv?.getContext?.('2d');
  if (!g?.createImageData) { paper = null; return null; }
  const img = g.createImageData(TEX, TEX), d = img.data, rnd = mulberry(0x5eed);
  const [R, G, B] = CHART.paperRgb;
  for (let y = 0, i = 0; y < TEX; y++) for (let x = 0; x < TEX; x++, i += 4) {
    const m = vnoise(x / TEX * 4, y / TEX * 4, 11, 4) * 0.5 + vnoise(x / TEX * 11, y / TEX * 11, 12, 11) * 0.3 + vnoise(x / TEX * 37, y / TEX * 37, 13, 37) * 0.2;
    // a second, slower drift toward a warmer, browner sheet in places
    const w = Math.max(0, vnoise(x / TEX * 3, y / TEX * 3, 14, 3));
    const v = m * 15 + (rnd() - 0.5) * 9;
    d[i] = R + v - w * 9; d[i + 1] = G + v * 0.97 - w * 14; d[i + 2] = B + v * 0.82 - w * 22; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // fibres: short hairs, lighter and darker than the sheet, most of them along the grain
  g.lineCap = 'round';
  for (let n = 0; n < 1500; n++) {
    const x = rnd() * TEX, y = rnd() * TEX, a = (rnd() - 0.5) * 0.9 + (rnd() < 0.2 ? Math.PI / 2 : 0), len = 5 + rnd() * 22, light = rnd() < 0.5;
    g.strokeStyle = light ? `rgba(255,250,232,${0.08 + rnd() * 0.16})` : `rgba(112,88,50,${0.06 + rnd() * 0.12})`;
    g.lineWidth = 0.5 + rnd() * 0.8;
    const dx = Math.cos(a) * len, dy = Math.sin(a) * len, bend = (rnd() - 0.5) * 5;
    for (const ox of [0, x + dx > TEX || x < 0 ? -TEX : x + dx < 0 ? TEX : null]) for (const oy of [0, y + dy > TEX ? -TEX : y + dy < 0 ? TEX : null]) {
      if (ox === null || oy === null) continue;
      g.beginPath(); g.moveTo(x + ox, y + oy); g.quadraticCurveTo(x + ox + dx / 2 - dy / len * bend, y + oy + dy / 2 + dx / len * bend, x + ox + dx, y + oy + dy); g.stroke();
    }
  }
  for (let n = 0; n < 420; n++) { g.fillStyle = `rgba(96,74,40,${0.07 + rnd() * 0.16})`; g.beginPath(); g.arc(4 + rnd() * (TEX - 8), 4 + rnd() * (TEX - 8), 0.4 + rnd() * 0.9, 0, Math.PI * 2); g.fill(); }
  paper = cv;
  return paper;
}

/** The paper as a fill for a context whose user space is world px at `res` device px each: its grain stays the size of the screen's pixels and lies still on the world. */
function paperFill(g, res) {
  const tex = parchment();
  if (!tex || !g.createPattern) return CHART.paper;
  const pat = g.createPattern(tex, 'repeat');
  const s = 1 / Math.max(0.05, Math.min(1, res));
  if (pat?.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0]));
  return pat ?? CHART.paper;
}

const blots = [undefined, undefined];
/** A soft blot (a stain, or a worn pale patch): a small bitmap made once and stretched where it is wanted (a gradient per stain costs far more). */
function blot(pale) {
  const i = pale ? 1 : 0;
  if (blots[i] !== undefined) return blots[i];
  const n = 96, cv = spare(n, n), g = cv?.getContext?.('2d');
  if (!g?.createRadialGradient) { blots[i] = null; return null; }
  const rgb = pale ? '255,249,230' : '126,96,48';
  const gr = g.createRadialGradient(n / 2, n / 2, n * 0.07, n / 2, n / 2, n / 2);
  gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.7, `rgba(${rgb},0.45)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, n, n);
  blots[i] = cv;
  return cv;
}

/**
 * Bare paper over the box `{x0, y0, x1, y1}` (world px) of a context whose user space is world px at `res` device
 * px each: the parchment, and its age: wide stains and worn, paler patches, laid on the world (the same stain lies
 * under two neighbouring sheets, and under the sheet's own margin: map/table.mjs).
 */
export function paintPaper(g, { x0, y0, x1, y1 }, res = 1) {
  if (!g?.fillRect) return;
  g.fillStyle = paperFill(g, res); g.fillRect(x0, y0, x1 - x0, y1 - y0);
  const dark = blot(false), pale = blot(true);
  if (!dark || !pale) return;
  const cell = 620, was = g.globalAlpha;
  for (let cx = Math.floor((x0 - 400) / cell); cx <= Math.floor((x1 + 400) / cell); cx++) for (let cy = Math.floor((y0 - 400) / cell); cy <= Math.floor((y1 + 400) / cell); cy++) for (let n = 0; n < 2; n++) {
    const sx = (cx + hash2(cx, cy, 20 + n)) * cell, sy = (cy + hash2(cx, cy, 30 + n)) * cell, sr = 150 + hash2(cx, cy, 40 + n) * 260;
    if (sx + sr < x0 || sx - sr > x1 || sy + sr < y0 || sy - sr > y1) continue;
    const light = hash2(cx, cy, 50 + n) < 0.4, k = 0.07 + hash2(cx, cy, 60 + n) * 0.09;
    g.globalAlpha = was * (light ? k * 1.5 : k);
    g.drawImage(light ? pale : dark, sx - sr, sy - sr * 0.8, sr * 2, sr * 1.6);
  }
  g.globalAlpha = was;
}

const hexPath = (g, x, y, inset = 0) => { hexPoints(x, y, inset).forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); };
const EDGE_OF = [[1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1]];   // the neighbour across the edge between corners k−1 and k of hexPoints

// ------------------------------------------------------------------ the glyphs
const jit = (q, r, n) => hash2(q, r, n) - 0.5;
/**
 * A tile's terrain in ink: strokes into the open path of `g`, blots into
 * `dots` (filled afterwards). `detail` 2 near (a small drawing), 1 middle
 * (a sign), 0 far (a speck, or nothing: the wash says it).
 */
function glyph(g, dots, t, detail) {
  const { x, name, q, r } = t, y = t.y + 3;
  const a = jit(q, r, 1) * 5, b = jit(q, r, 2) * 5, pick = hash2(q, r, 3);
  if (name === 'mountain') {
    if (detail === 0) { dots.push([[x - 17, y + 10], [x - 3 + a, y - 16], [x + 4, y - 4], [x + 10 + b, y - 10], [x + 20, y + 10]]); return; }
    const px = x - 5 + a, py = y - 19, qx = x + 13 + b, qy = y - 9;
    // the range: a low shoulder, the high peak, a second one behind its flank
    g.moveTo(x - 27, y + 12); g.lineTo(x - 19, y + 3); g.lineTo(x - 15, y + 6);
    g.moveTo(x - 21, y + 12); g.lineTo(px, py); g.lineTo(px + 11, y + 1);
    g.moveTo(px + 7, y - 5); g.lineTo(qx, qy); g.lineTo(x + 26, y + 12);
    if (detail === 2) {
      // the shaded flanks, hatched; a nick of snow under the summit
      for (let i = 1; i <= 4; i++) { const sx = px + i * 2.5, sy = py + i * 4.6; g.moveTo(sx, sy); g.lineTo(sx - 4 + i * 0.3, sy + 9 - i * 0.8); }
      for (let i = 1; i <= 3; i++) { const sx = qx + i * 3, sy = qy + i * 4.9; g.moveTo(sx, sy); g.lineTo(sx - 3, sy + 6); }
      g.moveTo(px - 4.5, py + 8); g.lineTo(px - 1.5, py + 5.5); g.lineTo(px + 0.5, py + 8.5); g.lineTo(px + 3, py + 6);
    }
  } else if (name === 'hills') {
    if (detail === 0) return;
    g.moveTo(x - 22, y + 9); g.quadraticCurveTo(x - 11 + a, y - 13, x + 1, y + 7);
    if (detail === 2 || pick > 0.4) { g.moveTo(x - 4, y + 10); g.quadraticCurveTo(x + 9 + b, y - 7, x + 22, y + 10); }
    if (detail === 2) {
      g.moveTo(x - 6, y - 2); g.lineTo(x - 3.5, y + 3); g.moveTo(x - 10, y - 4); g.lineTo(x - 8.5, y); g.moveTo(x + 15, y + 1); g.lineTo(x + 17, y + 6);
      if (pick > 0.5) { g.moveTo(x - 14, y - 12); g.quadraticCurveTo(x - 6, y - 21, x + 3, y - 12); }
    }
  } else if (name === 'forest') {
    if (detail === 0) return;
    // two or three trees, or a small stand of four: no two tiles of a wood alike
    const all = [[-15 + a, 6, 1], [-1, -7 + b, 1.12], [13 - a, 7, 0.95], [4 + b, 10, 0.82]];
    const spots = pick < 0.3 ? [all[0], all[2]] : pick < 0.78 ? all.slice(0, 3) : all;
    spots.forEach(([dx, dy, k], i) => {
      const tx = x + dx, ty = y + dy;
      // (a sign from the middle distance: two or three small firs, filled)
      if (detail === 1) { if (i < (pick > 0.5 ? 3 : 2)) dots.push([[tx - 6.5, ty + 5], [tx, ty - 9], [tx + 6.5, ty + 5]]); return; }
      if ((pick + i * 0.37) % 1 < 0.45) {
        // a fir: two skirts and a trunk
        g.moveTo(tx - 6 * k, ty + 3 * k); g.lineTo(tx, ty - 6 * k); g.lineTo(tx + 6 * k, ty + 3 * k); g.lineTo(tx - 6 * k, ty + 3 * k);
        g.moveTo(tx - 4.2 * k, ty - 3 * k); g.lineTo(tx, ty - 12 * k); g.lineTo(tx + 4.2 * k, ty - 3 * k);
        g.moveTo(tx, ty + 3 * k); g.lineTo(tx, ty + 7 * k);
      } else {
        // a broadleaf: a round crown with its shade, on a short trunk
        g.moveTo(tx, ty + 7 * k); g.lineTo(tx, ty + 2 * k);
        g.moveTo(tx + 6 * k, ty - 4 * k); g.arc(tx, ty - 4 * k, 6 * k, 0, Math.PI * 2);
        g.moveTo(tx + 1.5 * k, ty - 7 * k); g.quadraticCurveTo(tx + 4.5 * k, ty - 4 * k, tx + 2 * k, ty - 0.5 * k);
      }
    });
  } else if (name === 'water') {
    if (detail === 0) return;
    const rows = detail === 2 ? [[-17, -9, 3], [-8, 2, 3], [-19, 12, 2]] : [[-10, 0, 2]];
    for (const [dx, dy, n] of rows) {
      let wx = x + dx + a, wy = y + dy;
      g.moveTo(wx, wy);
      for (let i = 0; i < n; i++) { g.quadraticCurveTo(wx + 2.8, wy - 4, wx + 5.6, wy); g.quadraticCurveTo(wx + 8.4, wy + 3.4, wx + 11.2, wy); wx += 11.2; }
    }
  } else if (name === 'grassland') {
    if (detail < 2 || pick < 0.22) return;
    for (const [dx, dy] of [[-12 + a, 6], [9, -5 + b], [3 - a, 11]].slice(0, pick > 0.6 ? 3 : 2)) {
      const tx = x + dx, ty = y + dy;
      g.moveTo(tx - 3.5, ty); g.lineTo(tx - 1.6, ty - 5.5); g.moveTo(tx, ty); g.lineTo(tx, ty - 7.5); g.moveTo(tx + 3.5, ty); g.lineTo(tx + 1.8, ty - 5.5);
    }
  } else if (detail === 2 && pick > 0.3) {
    // open plain: stubble, stippled
    for (const [dx, dy] of [[-11 + a, 4], [-3, -6 + b], [8, 1], [1 + b, 9], [13 - a, -7]].slice(0, pick > 0.65 ? 5 : 3)) dots.push({ x: x + dx, y: y + dy, r: 1.25 });
  }
}

/**
 * The chart of `tiles` (`[{q, r, x, y, name}]`, world px) into `g`, whose
 * user space is world px at `res` device px each. `nameAt(q, r)` names the
 * terrain of a tile outside the list (for coasts). The sheet is cut to the
 * tiles, a hair wider, so the sheets of neighbouring provinces meet: by a
 * clip, or with `own` (the canvas holds nothing but this sheet) by cutting
 * the finished sheet once, which costs a slow canvas far less than a clip of
 * sixty hexes under every stroke.
 */
export function paintChart(g, tiles, { res = 1, nameAt = () => null, own: alone = false, ink = true } = {}) {
  // `ink` false: the bare sheet (paper, its age, the thin washes), with no lattice, coast or glyph: what the chart
  // is next to painted land, where its ink is let through only in part (applySurvey)
  if (!tiles.length || !g?.save) return;
  const detail = res >= 0.42 ? 2 : res >= 0.16 ? 1 : 0;
  const lw = Math.max(1.3, 0.8 / res);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const own = new Map();
  for (const t of tiles) { x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x); y0 = Math.min(y0, t.y); y1 = Math.max(y1, t.y); own.set(hexKey(t.q, t.r), t); }
  x0 -= RADIUS + 2; x1 += RADIUS + 2; y0 -= RADIUS; y1 += RADIUS;
  g.save();
  const shape = () => { g.beginPath(); for (const t of tiles) hexPath(g, t.x, t.y, -Math.min(1.6, 0.6 / res)); };
  if (!alone) { shape(); g.clip(); }
  paintPaper(g, { x0, y0, x1, y1 }, res);
  // a thin wash for what the land is: water cool, high ground warm, woods green
  for (const [name, fill] of Object.entries(CHART.wash)) {
    g.beginPath();
    let any = false;
    for (const t of tiles) if (t.name === name) { hexPath(g, t.x, t.y, -0.4); any = true; }
    if (any) { g.fillStyle = fill; g.fill(); if (detail === 0) g.fill(); }
  }
  if (!ink) { if (alone) { g.globalCompositeOperation = 'destination-in'; g.globalAlpha = 1; g.fillStyle = '#000'; shape(); g.fill(); } g.restore(); return; }
  // the lattice: every edge once, drawn a little unsteadily
  g.lineCap = 'round'; g.lineJoin = 'round';
  const wob = (x, y, n) => (hash2(Math.round(x * 2), Math.round(y * 2), n) - 0.5) * 2.2;
  g.beginPath();
  const coast = [], border = [];
  for (const t of tiles) {
    const pts = hexPoints(t.x, t.y, 0);
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = EDGE_OF[k], nq = t.q + dq, nr = t.r + dr;
      const nb = own.get(hexKey(nq, nr));
      const a = pts[(k + 5) % 6], b = pts[k];
      const other = nb ? nb.name : nameAt(nq, nr);
      if ((t.name === 'water') !== (other === 'water') && other && t.name === 'water') coast.push([a, b, t]);
      if (!nb && other) border.push([a, b]);
      if (nb && (dq > 0 || (dq === 0 && dr > 0))) continue;   // the neighbour draws this edge
      const ax = a[0] + wob(a[0], a[1], 1), ay = a[1] + wob(a[0], a[1], 2), bx = b[0] + wob(b[0], b[1], 1), by = b[1] + wob(b[0], b[1], 2);
      const mx = (ax + bx) / 2 + wob(ax + bx, ay + by, 3) * 0.7, my = (ay + by) / 2 + wob(ax + bx, ay + by, 4) * 0.7;
      g.moveTo(ax, ay); g.quadraticCurveTo(mx, my, bx, by);
    }
  }
  // (from afar the lattice is only a hint; there the provinces' own borders carry the sheet)
  g.strokeStyle = detail === 0 ? 'rgba(110,94,60,0.2)' : CHART.line; g.lineWidth = lw * (detail === 0 ? 0.6 : 0.85); g.stroke();
  if (detail === 0 && border.length) {
    g.beginPath();
    for (const [a, b] of border) { g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
    g.strokeStyle = 'rgba(96,80,48,0.42)'; g.lineWidth = lw * 0.7; g.stroke();
  }
  // coasts: a firmer line, and its echo a little way out to sea
  if (coast.length) {
    g.beginPath();
    for (const [a, b] of coast) { g.moveTo(a[0] + wob(a[0], a[1], 1), a[1] + wob(a[0], a[1], 2)); g.lineTo(b[0] + wob(b[0], b[1], 1), b[1] + wob(b[0], b[1], 2)); }
    g.strokeStyle = detail === 0 ? 'rgba(86,72,44,0.34)' : CHART.coast; g.lineWidth = lw * (detail === 0 ? 0.6 : detail === 1 ? 1 : 1.45); g.stroke();
    if (detail === 2) {
      g.beginPath();
      for (const [a, b, t] of coast) { const k = 0.2; g.moveTo(a[0] + (t.x - a[0]) * k, a[1] + (t.y - a[1]) * k); g.lineTo(b[0] + (t.x - b[0]) * k, b[1] + (t.y - b[1]) * k); }
      g.strokeStyle = 'rgba(86,72,44,0.3)'; g.lineWidth = lw * 0.8; g.stroke();
    }
  }
  // the glyphs
  const dots = [];
  g.beginPath();
  for (const t of tiles) glyph(g, dots, t, detail);
  g.strokeStyle = CHART.glyph; g.lineWidth = lw * (detail === 2 ? 1.08 : 1); g.stroke();
  if (dots.length) {
    g.beginPath();
    for (const d of dots) {
      if (Array.isArray(d)) { d.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); }
      else { g.moveTo(d.x + d.r, d.y); g.arc(d.x, d.y, d.r, 0, Math.PI * 2); }
    }
    g.fillStyle = detail === 0 ? 'rgba(92,76,46,0.55)' : 'rgba(92,76,46,0.7)'; g.fill();
  }
  // the Concord: where the Engine stands, ringed as a chart rings its one sure landmark
  const c0 = own.get(hexKey(0, 0));
  if (c0 && g.ellipse) {
    g.beginPath();
    for (const rr of [2.3, 2.52]) { g.moveTo(c0.x + rr * RADIUS * SQRT3 / 2, c0.y); g.ellipse(c0.x, c0.y, rr * RADIUS * SQRT3 / 2, rr * RADIUS * SQRT3 / 2 * FLATTEN, 0, 0, Math.PI * 2); }
    for (let k = 0; k < 12; k++) { const an = (k * Math.PI) / 6, ca = Math.cos(an), sa = Math.sin(an) * FLATTEN, r1 = 2.52 * RADIUS * SQRT3 / 2, r2 = (k % 2 ? 2.72 : 2.95) * RADIUS * SQRT3 / 2; g.moveTo(c0.x + ca * r1, c0.y + sa * r1); g.lineTo(c0.x + ca * r2, c0.y + sa * r2); }
    g.strokeStyle = 'rgba(92,76,46,0.6)'; g.lineWidth = lw * 1.1; g.stroke();
  }
  if (alone) { g.globalCompositeOperation = 'destination-in'; g.globalAlpha = 1; g.fillStyle = '#000'; shape(); g.fill(); }
  g.restore();
}

// ------------------------------------------------------------------ the edge
/**
 * The edge of the land in sight against the muted land out of sight (in hex radii from a tile's centre): alive to
 * `inner`, muted from `outer`, pushed about by `rough`. (The edge of the paint against the chart is the wet edge, below.)
 */
export const EDGE = Object.freeze({ sight: Object.freeze({ inner: 0.9, outer: 1.7, rough: 0.12 }) });
const REACH = 2;

/**
 * The distance field of the tiles at `level` or above over `box` (world px
 * `{x, y, w, h}`) at `mres` px per world px: for every pixel the distance
 * to the nearest such tile's centre, in hex radii (Infinity far from all).
 */
export function surveyField(survey, box, mres, level) {
  const w = Math.max(1, Math.ceil(box.w * mres)), h = Math.max(1, Math.ceil(box.h * mres));
  const f = new Float32Array(w * h).fill(Infinity);
  const ry = RADIUS * FLATTEN;
  const r0 = Math.floor((box.y - REACH * ry) / (1.5 * ry)) - 1, r1 = Math.ceil((box.y + box.h + REACH * ry) / (1.5 * ry)) + 1;
  for (let r = r0; r <= r1; r++) {
    const q0 = Math.floor((box.x - REACH * RADIUS) / (SQRT3 * RADIUS) - r / 2) - 1, q1 = Math.ceil((box.x + box.w + REACH * RADIUS) / (SQRT3 * RADIUS) - r / 2) + 1;
    for (let q = q0; q <= q1; q++) {
      if (survey.levelAt(q, r) < level) continue;
      const c = project(q, r);
      const px0 = Math.max(0, Math.floor((c.x - REACH * RADIUS - box.x) * mres)), px1 = Math.min(w - 1, Math.ceil((c.x + REACH * RADIUS - box.x) * mres));
      const py0 = Math.max(0, Math.floor((c.y - REACH * ry - box.y) * mres)), py1 = Math.min(h - 1, Math.ceil((c.y + REACH * ry - box.y) * mres));
      for (let py = py0; py <= py1; py++) {
        const dy = ((py + 0.5) / mres + box.y - c.y) / ry;
        for (let px = px0; px <= px1; px++) {
          const dx = ((px + 0.5) / mres + box.x - c.x) / RADIUS;
          const d = Math.sqrt(dx * dx + dy * dy), i = py * w + px;
          if (d < f[i]) f[i] = d;
        }
      }
    }
  }
  return { f, w, h };
}

/** How much paint a field value leaves at world point (x, y): 1 on the tile, 0 beyond its reach, uneven between. */
export function coverage(d, x, y, e = EDGE.sight) {
  if (d <= e.inner - e.rough) return 1;
  if (!(d < e.outer + e.rough)) return 0;
  const n = vnoise(x / 30, y / 30, 7) * 0.55 + vnoise(x / 9, y / 9, 8) * 0.45;
  const k = (d + n * e.rough - e.inner) / (e.outer - e.inner);
  return k <= 0 ? 1 : k >= 1 ? 0 : 1 - smooth(k);
}

/** A bitmap whose alpha is the coverage of `field`. */
function maskOf(field, box, mres, e) {
  const { f, w, h } = field;
  const cv = spare(w, h), g = cv?.getContext?.('2d');
  if (!g?.createImageData) return null;
  const img = g.createImageData(w, h), d = img.data;
  for (let py = 0, i = 0, j = 0; py < h; py++) for (let px = 0; px < w; px++, i++, j += 4) d[j + 3] = coverage(f[i], (px + 0.5) / mres + box.x, (py + 0.5) / mres + box.y, e) * 255;
  g.putImageData(img, 0, 0);
  return { cv };
}

const scratches = [];
/** A scratch canvas of at least w × h (two are kept: a composition needs both at once). */
function scratchOf(w, h, slot = 0) {
  const have = scratches[slot];
  if (!have || have.width < w || have.height < h) scratches[slot] = spare(Math.max(w, have?.width ?? 0), Math.max(h, have?.height ?? 0));
  return scratches[slot];
}

// ------------------------------------------------------------------ the wet edge
/**
 * The edge of the paint, in hex radii from the outline of the surveyed tiles
 * (negative: on them): `bias` keeps the line a hair inside that outline (no
 * sliver of a neighbour's paint shows beyond it), `slow` and `quick` are the
 * two scales its line wavers at (`[wavelength in world px, reach]`), `fade`
 * how far in the pigment thins (a third of a hex), `thin` what is left of it
 * at the line, `gap` a hair of bare paper the pigment stops short of the line
 * by (the masks are coarser than the line: no pigment may show beyond it),
 * `halo` how far out the paper stays bare and pale, `quiet` how far out the
 * chart's ink is still at half.
 */
export const WET = Object.freeze({ gap: 0.03, bias: 0.075, slow: Object.freeze([52, 0.085]), quick: Object.freeze([13, 0.04]), fade: 0.58, thin: 0.6, halo: 0.2, quiet: 2.4, line: 'rgba(72,52,26,0.84)', soft: 'rgba(72,52,26,0.2)' });
const HEX_K = [-SQRT3 / 2, 0.5, 1 / SQRT3];
/** How far world point (x, y) lies outside the tile whose middle is (cx, cy), in hex radii on the unsquashed ground (0 on the tile). */
export function hexGap(x, y, cx, cy) {
  // (the tiles stand on a point: the usual flat-topped hexagon distance with its axes swapped; apothem √3/2)
  let px = Math.abs((y - cy) / (RADIUS * FLATTEN)), py = Math.abs((x - cx) / RADIUS);
  const dot = Math.min(HEX_K[0] * px + HEX_K[1] * py, 0);
  px -= 2 * dot * HEX_K[0]; py -= 2 * dot * HEX_K[1];
  const r = SQRT3 / 2;
  px -= Math.max(-HEX_K[2] * r, Math.min(HEX_K[2] * r, px)); py -= r;
  return py > 0 ? Math.hypot(px, py) : 0;
}

const NEAR = (() => { const out = []; for (let dq = -2; dq <= 2; dq++) for (let dr = Math.max(-2, -dq - 2); dr <= Math.min(2, -dq + 2); dr++) if (dq || dr) out.push([dq, dr]); return out; })();
const BEYOND = 2.6;
/**
 * The signed distance to the edge of the land at `level` or above, over
 * `box` (world px `{x, y, w, h}`) at `mres` px per world px: for every pixel
 * the distance in hex radii to the nearest tile of the other kind, negative
 * on the land itself (±BEYOND where the edge is more than two tiles away).
 */
export function surveyEdge(survey, box, mres, level) {
  const w = Math.max(1, Math.ceil(box.w * mres)), h = Math.max(1, Math.ceil(box.h * mres));
  const f = new Float32Array(w * h);
  // per tile: whether it is land, and the middles of the tiles of the other kind within two steps
  const tiles = new Map();
  const tile = (q, r) => {
    const k = (q + 4096) * 8192 + (r + 4096);
    let t = tiles.get(k);
    if (t) return t;
    const land = survey.levelAt(q, r) >= level, others = [];
    for (const [dq, dr] of NEAR) if ((survey.levelAt(q + dq, r + dr) >= level) !== land) { const c = project(q + dq, r + dr); others.push(c.x, c.y); }
    t = { land, others };
    tiles.set(k, t);
    return t;
  };
  for (let py = 0, i = 0; py < h; py++) {
    const y = (py + 0.5) / mres + box.y, fy = y / FLATTEN;
    for (let px = 0; px < w; px++, i++) {
      const x = (px + 0.5) / mres + box.x;
      const rf = ((2 / 3) * fy) / RADIUS, qf = ((SQRT3 / 3) * x - fy / 3) / RADIUS;
      let q = Math.round(qf), r = Math.round(rf);
      const sx = Math.round(-qf - rf), dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(sx + qf + rf);
      if (dq > dr && dq > ds) q = -r - sx; else if (dr > ds) r = -q - sx;
      const t = tile(q, r), o = t.others;
      let d = BEYOND;
      for (let j = 0; j < o.length; j += 2) { const v = hexGap(x, y, o[j], o[j + 1]); if (v < d) d = v; }
      f[i] = t.land ? -d : d;
    }
  }
  return { f, w, h };
}

/** The edge's own waver at a world point (hex radii): two scales, and the bias that keeps it on the land's side. */
export const wetWaver = (x, y) => vnoise(x / WET.slow[0], y / WET.slow[0], 7) * WET.slow[1] + vnoise(x / WET.quick[0], y / WET.quick[0], 8) * WET.quick[1] + WET.bias;
/** How much pigment lies at edge distance `e` (hex radii, waver included): whole well inside, thinner over the last third of a hex, none past the line. */
export const wetPaint = e => (e >= -WET.gap ? 0 : e <= -WET.fade ? 1 : WET.thin + (1 - WET.thin) * smooth(-e / WET.fade));
/** How much of the chart's ink shows at edge distance `e`: none on the paint and in the halo, half near it, all of it further out. */
export const wetInk = e => (e <= WET.halo ? 0 : e < 0.62 ? 0.5 * smooth((e - WET.halo) / (0.62 - WET.halo)) : e >= WET.quiet ? 1 : 0.5 + 0.5 * smooth((e - 0.62) / (WET.quiet - 0.62)));
/** The pale halo of bare paper just beyond the line. */
export const wetHalo = e => (e <= 0 || e >= WET.halo * 1.5 ? 0 : Math.sin((e / (WET.halo * 1.5)) * Math.PI));

/**
 * The wet edge over `box` at `mres`: three masks (alpha only) the size of the
 * field, `paint`, `ink` and `halo`, and `line`, the edge itself as segments
 * `[x0, y0, x1, y1, …]` in world px (where the field crosses nothing: empty).
 */
export function wetEdge(survey, box, mres, level = L2) {
  const { f, w, h } = surveyEdge(survey, box, mres, level);
  const e = new Float32Array(w * h);
  for (let py = 0, i = 0; py < h; py++) for (let px = 0; px < w; px++, i++) {
    const d = f[i];
    e[i] = Math.abs(d) >= 1 ? d : d + wetWaver((px + 0.5) / mres + box.x, (py + 0.5) / mres + box.y);
  }
  // the line: where the field crosses zero, cell by cell (marching squares; a pixel's value sits at its middle)
  const line = [];
  const cut = (a, b) => a / (a - b);
  for (let py = 0; py < h - 1; py++) for (let px = 0, i = py * w; px < w - 1; px++, i++) {
    const a = e[i], b = e[i + 1], c = e[i + w + 1], d = e[i + w];
    const n = (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
    if (n === 0 || n === 15) continue;
    const x0 = (px + 0.5) / mres + box.x, y0 = (py + 0.5) / mres + box.y, u = 1 / mres;
    const T = () => [x0 + cut(a, b) * u, y0], R = () => [x0 + u, y0 + cut(b, c) * u], B = () => [x0 + cut(d, c) * u, y0 + u], Lf = () => [x0, y0 + cut(a, d) * u];
    const seg = (p, q) => line.push(p[0], p[1], q[0], q[1]);
    switch (n) {
      case 1: case 14: seg(Lf(), T()); break;
      case 2: case 13: seg(T(), R()); break;
      case 3: case 12: seg(Lf(), R()); break;
      case 4: case 11: seg(R(), B()); break;
      case 6: case 9: seg(T(), B()); break;
      case 7: case 8: seg(Lf(), B()); break;
      case 5: seg(Lf(), T()); seg(R(), B()); break;
      default: seg(T(), R()); seg(Lf(), B());   // 10
    }
  }
  const mask = of => {
    const cv = spare(w, h), g = cv?.getContext?.('2d');
    if (!g?.createImageData) return null;
    const img = g.createImageData(w, h), d = img.data;
    for (let i = 0, j = 3; i < e.length; i++, j += 4) d[j] = of(e[i]) * 255;
    g.putImageData(img, 0, 0);
    return cv;
  };
  return { e, w, h, line, paint: mask(wetPaint), ink: mask(wetInk), halo: mask(wetHalo) };
}

/** Mute what is on `g`'s canvas (device px, no transform): the saturation and brightness of surveyed land out of sight. */
function mute(g, w, h) {
  g.globalCompositeOperation = 'saturation'; g.globalAlpha = 1 - MUTED.saturation; g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'multiply'; g.globalAlpha = 1; const v = Math.round(MUTED.brightness * 255); g.fillStyle = `rgb(${v + 4},${v + 1},${v - 6})`; g.fillRect(0, 0, w, h);
  // a breath of the paper over it: surveyed land is on its way back into the chart
  g.globalCompositeOperation = 'source-over'; g.fillStyle = `rgba(${CHART.paperRgb.join(',')},${MUTED.paper})`; g.fillRect(0, 0, w, h);
}

/**
 * Lay the survey over a painted bitmap: `g` is the 2D context of a canvas
 * that holds a province's painted land over `box` (world px) at `res` px per
 * world px. What is surveyed but out of sight is muted; what is not surveyed
 * is covered by `chart` (a canvas of the same size holding the province's
 * chart, clear outside its own tiles), with the wet edge between them.
 * `plain` is the same sheet without its ink (paintChart `ink: false`): with
 * it the chart's ink is quiet near the paint.
 * `sig` is the province's survey signature (survey.province(p, q).sig): it
 * says whether the province has any chart or any muted land at all.
 */
export function applySurvey(g, { box, res, survey, sig = '', chart = null, plain = null }) {
  const cv = g?.canvas;
  if (!cv || !g.getTransform || survey?.showAll) return;
  const W = cv.width, H = cv.height;
  const has1 = sig.includes('1'), has2 = sig.includes('2');
  if (!has1 && !has2) return;
  const mres = Math.min(0.5, res);
  const sc = scratchOf(W, H), sg = sc?.getContext?.('2d');
  if (!sg) return;
  const clear = () => { sg.setTransform(1, 0, 0, 1, 0, 0); sg.globalCompositeOperation = 'source-over'; sg.globalAlpha = 1; sg.clearRect(0, 0, sc.width, sc.height); };
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  sg.imageSmoothingEnabled = true;
  if (has2) {
    // the muted copy of the land, left only where it is not in sight
    const m = maskOf(surveyField(survey, box, mres, L3), box, mres, EDGE.sight);
    if (m) {
      clear(); sg.drawImage(cv, 0, 0);
      mute(sg, W, H);
      sg.globalCompositeOperation = 'destination-in'; sg.drawImage(cv, 0, 0);
      sg.globalCompositeOperation = 'destination-out'; sg.drawImage(m.cv, 0, 0, W, H);
      g.drawImage(sc, 0, 0, W, H, 0, 0, W, H);
    }
  }
  if (has1 && chart) {
    // the wet edge: the chart (its ink quiet near the paint, bare and pale just beyond it) with the painted land over
    // it, the pigment thinning toward its line; then the line itself. Nothing of the painted bitmap shows beyond the
    // line: no sliver of a neighbouring tile, no skirt of a tile that is only chart
    const m = wetEdge(survey, box, mres, L2);
    const sb = scratchOf(W, H, 1), bg = sb?.getContext?.('2d');
    if (m.paint && bg) {
      // (b) the painted land, cut to its pigment
      bg.setTransform(1, 0, 0, 1, 0, 0); bg.globalAlpha = 1; bg.imageSmoothingEnabled = true;
      bg.globalCompositeOperation = 'copy'; bg.drawImage(cv, 0, 0);
      bg.globalCompositeOperation = 'destination-in'; bg.drawImage(m.paint, 0, 0, W, H);
      bg.globalCompositeOperation = 'source-over';
      // (a) the chart under it: the bare sheet, then as much of its ink as the edge lets through
      g.globalCompositeOperation = 'copy'; g.drawImage(plain ?? chart, 0, 0);
      g.globalCompositeOperation = 'source-over';
      if (plain && m.ink) {
        clear(); sg.drawImage(chart, 0, 0);
        sg.globalCompositeOperation = 'destination-in'; sg.drawImage(m.ink, 0, 0, W, H);
        g.drawImage(sc, 0, 0, W, H, 0, 0, W, H);
      }
      if (m.halo) {
        // the pale halo: bare paper, a little lighter than the aged sheet, only on the sheet itself
        clear(); sg.drawImage(m.halo, 0, 0, W, H);
        sg.globalCompositeOperation = 'source-in'; sg.fillStyle = 'rgb(250,243,222)'; sg.fillRect(0, 0, W, H);
        sg.globalCompositeOperation = 'destination-in'; sg.drawImage(chart, 0, 0);
        g.globalAlpha = 0.62; g.drawImage(sc, 0, 0, W, H, 0, 0, W, H); g.globalAlpha = 1;
      }
      g.drawImage(sb, 0, 0, W, H, 0, 0, W, H);
      // the line: thin and dark, with a soft shoulder (world px through the bitmap's own transform)
      if (m.line.length && g.setTransform) {
        g.setTransform(res, 0, 0, res, -box.x * res, -box.y * res);
        g.beginPath();
        for (let i = 0; i < m.line.length; i += 4) { g.moveTo(m.line[i], m.line[i + 1]); g.lineTo(m.line[i + 2], m.line[i + 3]); }
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.strokeStyle = WET.soft; g.lineWidth = 3.4 / res; g.stroke();
        g.strokeStyle = WET.line; g.lineWidth = 1.3 / res; g.stroke();
        g.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
  }
  g.restore();
}

// ------------------------------------------------------------------ muted sprites
const mutedOf = new WeakMap();
/** A sprite as surveyed land out of sight shows it (made once per image). */
export function mutedSprite(img) {
  if (!img || typeof img !== 'object') return img;
  const hit = mutedOf.get(img);
  if (hit) return hit;
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const cv = w > 0 && h > 0 ? spare(w, h) : null, g = cv?.getContext?.('2d');
  if (!g) return img;
  g.drawImage(img, 0, 0);
  mute(g, w, h);
  g.globalCompositeOperation = 'destination-in'; g.drawImage(img, 0, 0); g.globalCompositeOperation = 'source-over';
  mutedOf.set(img, cv);
  return cv;
}

// ------------------------------------------------------------------ the reveal
const easeOut = k => 1 - Math.pow(1 - k, 3);
/**
 * Tiles in sight for the first time: each is still chart when its turn
 * comes and lets the paint through over REVEAL_MS (a ring of light runs
 * ahead of the paint). `tiles` are the frame's tiles by hexKey (`byKey`),
 * `reveals` the survey's (hexKey → start on fxNow's clock). Returns how many
 * are still dissolving.
 */
export function paintReveal(g, { reveals, byKey, res = 1, now = fxNow(), nameAt = () => null }) {
  if (!reveals?.size || !g?.save) return 0;
  let live = 0;
  const rim = [];
  for (const [k, t0] of reveals) {
    const u = (now - t0) / REVEAL_MS;
    if (u >= 1) continue;
    live++;
    const t = byKey(k);
    if (!t) continue;
    const a = u <= 0 ? 1 : 1 - easeOut(u);
    g.save();
    g.globalAlpha = a;
    paintChart(g, [t], { res, nameAt });
    g.restore();
    if (u > 0) rim.push([t, u]);
  }
  // the light that runs ahead of the paint
  if (rim.length) {
    g.save();
    g.lineJoin = 'round';
    for (const [t, u] of rim) {
      const k = Math.sin(Math.min(1, u * 1.6) * Math.PI);
      if (k <= 0.02) continue;
      g.beginPath(); hexPath(g, t.x, t.y, 1.5);
      g.fillStyle = `rgba(255,244,208,${0.3 * k})`; g.fill();
      g.strokeStyle = `rgba(255,236,178,${0.75 * k})`; g.lineWidth = 2.2; g.stroke();
    }
    g.restore();
  }
  return live;
}

// ------------------------------------------------------------------ marks of the stages
const wedges = new Map();
/** The home wedge of `faction` in the open rings: `{fill, edge}` paths (world px), or null. */
export function wedgePaths(faction, ringsOpen) {
  if (typeof Path2D === 'undefined' || !Number.isInteger(faction)) return null;
  const key = `${faction}|${ringsOpen}`;
  if (wedges.has(key)) return wedges.get(key);
  const inside = (p, q) => wedgeOf(p, q) === faction;
  const fill = new Path2D(), edge = new Path2D();
  let any = false;
  for (let d = 1; d < Math.max(2, ringsOpen); d++) for (const pr of ringProvinces(d)) {
    if (!inside(pr.p, pr.q)) continue;
    any = true;
    for (let i = 0; i < PROVINCE_TILES; i++) {
      const h = tileHex(pr.p, pr.q, i), c = project(h.q, h.r), pts = hexPoints(c.x, c.y, 0);
      pts.forEach(([x, y], j) => (j ? fill.lineTo(x, y) : fill.moveTo(x, y))); fill.closePath();
      for (let k = 0; k < 6; k++) {
        const [dq, dr] = EDGE_OF[k], at = locate(h.q + dq, h.r + dr);
        if (at.p === pr.p && at.q === pr.q) continue;
        const ring = ringOf(at.p, at.q);
        if (inside(at.p, at.q) && ring >= 1 && ring < Math.max(2, ringsOpen)) continue;
        const a = pts[(k + 5) % 6], b = pts[k];
        edge.moveTo(a[0], a[1]); edge.lineTo(b[0], b[1]);
      }
    }
  }
  const v = any ? { fill, edge } : null;
  wedges.set(key, v);
  return v;
}

/** The viewer's home wedge, outlined in the nation's colour on the chart (a viewer who has joined and has no village yet). */
export function paintWedge(g, faction, ringsOpen, zoom, { lit = false } = {}) {
  const w = wedgePaths(faction, ringsOpen);
  if (!w || !g?.save) return;
  const k = 1 / zoom, col = FACTION_COLORS[faction] ?? YOU;
  g.save();
  // `lit`: the nation that is looked at in the nation choice, its wedge washed in its colour on the chart
  g.globalAlpha = lit ? 0.26 : 0.07; g.fillStyle = col; g.fill(w.fill);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.globalAlpha = 0.22; g.strokeStyle = col; g.lineWidth = 13 * k; g.stroke(w.edge);
  g.globalAlpha = 0.85; g.strokeStyle = 'rgba(22,30,26,.9)'; g.lineWidth = 5.4 * k; g.stroke(w.edge);
  g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 3 * k; g.stroke(w.edge);
  g.strokeStyle = 'rgba(255,246,222,.75)'; g.lineWidth = 0.9 * k; g.stroke(w.edge);
  g.restore();
}

/** The candidate sites of an open ticket: a dashed ring on each tile, in ivory over ink, with a word. */
export function paintCandidates(g, candidates, zoom, { now = fxNow(), still = false, part = null } = {}) {
  // `part` 'mark': the rings, on the ground; 'label': the words, upright over their tiles; null: both
  if (!candidates?.length || !g?.save) return;
  const k = 1 / zoom, turn = still ? 0 : (now / 1000) * 5;
  g.save();
  g.lineCap = 'round';
  candidates.forEach((c, i) => {
    const h = tileHex(c.p, c.q, c.tile);
    if (!h) return;
    const at = project(h.q, h.r), rx = Math.max(RADIUS * 0.92, 15 * k), ry = rx * FLATTEN;
    const ring = (w, style, dash) => { g.beginPath(); g.ellipse?.(at.x, at.y, rx, ry, 0, 0, Math.PI * 2); g.setLineDash(dash ? [9 * k, 6 * k] : []); g.lineDashOffset = -turn * k; g.lineWidth = w * k; g.strokeStyle = style; g.stroke(); };
    if (part !== 'label') { ring(5.2, 'rgba(22,30,26,.7)', false); ring(2.6, '#f4efe0', true); }
    g.setLineDash([]);
    if (part !== 'mark' && RADIUS * zoom >= 16) upright(g, at.x, at.y, () => {
      const text = `${L`候補地`} ${i + 1}`;
      g.font = `700 ${11.5 * k}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText(text).width + 14 * k, th = 18 * k, ty = at.y - ry - 8 * k - th;
      g.fillStyle = 'rgba(22,30,26,.9)'; g.beginPath(); g.roundRect?.(at.x - tw / 2, ty, tw, th, 9 * k); g.fill();
      g.fillStyle = '#f4efe0'; g.fillText(text, at.x, ty + th / 2 + 0.5 * k);
    });
  });
  g.restore();
}

/** The hexes of the survey that are surveyed, for small pictures of it (the minimap): `[{x, y, level}]` in world px. */
export function surveyedPoints(survey) {
  const out = [];
  for (const [k, level] of survey?.tiles ?? []) { const h = keyHex(k), c = project(h.q, h.r); out.push({ x: c.x, y: c.y, level, q: h.q, r: h.r }); }
  return out;
}
export { DIRECTIONS, L2, L3 };
