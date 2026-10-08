// The table and the sheet (UX brief §1, §11.2): "the frontier is an
// unfinished map lying on a dark table". Two materials drawn by code, under
// everything else of the world:
//
//   the table   dark stained wood: boards with a fine grain (one texture made
//               once and laid on the world, so the boards move with the sheet
//               when the camera pans), and a soft pool of lamp light around
//               the sheet that falls into shadow toward the corners;
//   the sheet   the parchment the world is drawn on: a rectangle with room
//               around the opened land for the cloud sea and a bare margin, a
//               deckled edge, wear along it, a ruled neatline, a compass rose
//               in a corner, and a cast shadow on the table. The world ends
//               as a sheet: nothing blurs into the dark.
//
// Both are in world px; `res` is the device px per world px the paper's grain
// is made for (the provinces' own sheets use the same, so the paper is one).
// Context-tolerant: without a canvas (tests) the painters return quietly and
// the geometry still works. No asset files.
import { FLATTEN, RADIUS } from '../../map.mjs';
import { landBox } from './camera.mjs';
import { paintPaper } from './chart.mjs';

const SQRT3 = Math.sqrt(3);
/** A hex's width (world px): the unit the sheet's margins are counted in. */
export const HEX_W = SQRT3 * RADIUS;
/**
 * The sheet around the opened land, in hexes: `sea` the cloud bank at its
 * full depth beyond the land's edge, `fade` over which it thins to bare
 * paper, `margin` the bare paper between it and the sheet's edge.
 */
export const SHEET = Object.freeze({ sea: 3.3, fade: 1.3, margin: 1.15, grow: 0.15 });
/** The table's colours: the lit wood, and the ink of its shadow. */
export const WOOD = Object.freeze({ base: [58, 42, 30], dark: [30, 21, 15], shade: '8,6,5' });

const spare = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);
const hash = (a, b = 0, c = 0) => { let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1); h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return (h >>> 0) / 4294967296; };
const smooth = t => t * t * (3 - 2 * t);
/** Value noise along a line, −1..1. */
const noise1 = (x, seed = 0) => { const i = Math.floor(x), f = smooth(x - i), a = hash(i, seed), b = hash(i + 1, seed); return (a + (b - a) * f) * 2 - 1; };
/** Value noise on the plane, −1..1; it repeats every `wx` cells across and `wy` down when given. */
function noise2(x, y, seed = 0, wx = 0, wy = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
  const at = (i, j) => hash(wx ? ((i % wx) + wx) % wx : i, wy ? ((j % wy) + wy) % wy : j, seed);
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return (a + (b - a) * fx + (c - a + (d - c - b + a) * fx) * fy) * 2 - 1;
}

// ------------------------------------------------------------------ the wood
/** The texture: BOARDS boards of BOARD px, WOOD_W px along the grain; it repeats both ways without a seam. */
const BOARD = 256, BOARDS = 4, WOOD_W = 1024;
let wood;
/** The boards, made once (null where there is no canvas). */
export function woodTexture() {
  if (wood !== undefined) return wood;
  const W = WOOD_W, H = BOARD * BOARDS, cv = spare(W, H), g = cv?.getContext?.('2d');
  if (!g?.createImageData) { wood = null; return null; }
  const img = g.createImageData(W, H), d = img.data;
  const [R, G, B] = WOOD.base;
  for (let y = 0, i = 0; y < H; y++) {
    const board = Math.floor(y / BOARD), v = y - board * BOARD;
    // each board its own tone, and its own place along the tree
    const tone = 1 + (hash(board, 3) - 0.5) * 0.2, shift = hash(board, 4) * 97, warm = (hash(board, 5) - 0.5) * 6;
    for (let x = 0; x < W; x++, i += 4) {
      // the grain: long streaks along the board, bent by a slow wave; finer hairs across them
      const bend = noise2(x / 256, (v + board * 311) / 64, 21, 4, 0) * 9;
      const streak = noise2(x / 512 + shift, (v + bend) / 5.5, 22 + board, 2, 0) * 0.6 + noise2(x / 128 + shift, (v + bend) / 2.1, 23 + board, 8, 0) * 0.4;
      const ring = Math.sin((v + bend * 2.4 + noise2(x / 340, v / 30, 24 + board, 3, 0) * 14) * 0.21) * 0.5;
      const hair = (hash(x, y, 7) - 0.5) * 0.16;
      // a board is a little darker toward its edges, and its seam is a dark line with a lit lip under it
      const edge = Math.min(v, BOARD - 1 - v);
      const seam = edge < 1.2 ? -0.5 : edge < 2.4 ? (v < BOARD / 2 ? 0.1 : -0.22) : edge < 14 ? -0.07 * (1 - edge / 14) : 0;
      const k = tone * (1 + streak * 0.16 + ring * 0.07 + hair * 0.5 + seam);
      d[i] = (R + warm) * k; d[i + 1] = G * k; d[i + 2] = (B - warm * 0.6) * k; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // where two lengths of a board meet: one butt joint a board
  for (let b = 0; b < BOARDS; b++) {
    const x = Math.round(hash(b, 9) * (W - 40)) + 20, y = b * BOARD;
    g.fillStyle = 'rgba(8,5,3,0.5)'; g.fillRect(x, y + 1, 1.5, BOARD - 2);
    g.fillStyle = 'rgba(255,225,190,0.05)'; g.fillRect(x + 1.5, y + 1, 1, BOARD - 2);
  }
  wood = cv;
  return wood;
}

/** Whether the table can show at all in a picture whose four world corners are `quad`: not when all of it lies on the sheet. */
export function tableShows(quad, sheet) {
  if (!quad || !sheet) return true;
  return quad.some(p => Math.abs(p.x) > sheet.x - 40 || Math.abs(p.y) > sheet.y - 40);
}

/**
 * The table over the whole canvas. `view` and `size` are the canvas's own
 * flat view and box (CSS px), `ratio` its device px per CSS px, `sheet` the
 * sheet lying on it (sheetOf). Leaves the transform at device px.
 */
export function paintTable(g, { view, size, ratio = 1, sheet = null }) {
  if (!g?.fillRect) return;
  const W = size.width * ratio, H = size.height * ratio, z = view.zoom * ratio;
  g.setTransform(1, 0, 0, 1, 0, 0);
  const tex = woodTexture();
  const ox = (size.width / 2 - view.x * view.zoom) * ratio, oy = (size.height / 2 - view.y * view.zoom) * ratio;   // the world's middle on the canvas
  let pat = null;
  if (tex && g.createPattern && typeof DOMMatrix !== 'undefined') {
    pat = g.createPattern(tex, 'repeat');
    // a board is a sixth of the sheet's height or so: the table is a table at every size of world
    const board = (sheet ? sheet.y * 2 : 2400) / 5.6, k = (board / BOARD) * z;
    pat?.setTransform?.(new DOMMatrix([k, 0, 0, k, ox, oy + board * z * 0.31]));
  }
  g.fillStyle = pat ?? `rgb(${WOOD.base.join(',')})`;
  g.fillRect(0, 0, W, H);
  // the lamp: a pool of light around the sheet, the wood falling into shadow away from it
  if (g.createRadialGradient) {
    const r = (sheet ? Math.hypot(sheet.x, sheet.y) : 2600) * z;
    const lamp = g.createRadialGradient(ox, oy, r * 0.55, ox, oy, r * 1.9);
    lamp.addColorStop(0, `rgba(${WOOD.shade},0)`); lamp.addColorStop(0.45, `rgba(${WOOD.shade},0.32)`); lamp.addColorStop(1, `rgba(${WOOD.shade},0.74)`);
    g.fillStyle = lamp; g.fillRect(0, 0, W, H);
  }
}

// ------------------------------------------------------------------ the sheet
const sheets = new Map();
/**
 * The sheet for `ringsOpen` open rings: `{x, y}` half its width and height
 * (world px), `pad` the room beyond the land's own box, `points` its deckled
 * outline, `path` the same as a Path2D (null without one), `rose` where the
 * compass rose stands. The same sheet every time: the deckle is seeded.
 */
export function sheetOf(ringsOpen) {
  const d = Math.max(1, ringsOpen ?? 1);
  if (sheets.has(d)) return sheets.get(d);
  const land = landBox(d);
  const pad = Math.max((SHEET.sea + SHEET.fade + SHEET.margin) * HEX_W, land.x * SHEET.grow);
  const X = land.x + pad, Y = land.y + pad * FLATTEN * 1.08;
  // walk the rectangle (corners a little rounded) and push each point in or out: a slow wave, a tremor, a fray, a few nicks
  const rc = HEX_W * 0.55, step = 16, pts = [];
  const sides = [[-X + rc, -Y, X - rc, -Y, 0, -1], [X, -Y + rc, X, Y - rc, 1, 0], [X - rc, Y, -X + rc, Y, 0, 1], [-X, Y - rc, -X, -Y + rc, -1, 0]];
  let s = 0;
  const push = (x, y, nx, ny) => {
    const nick = hash(Math.floor(s / 46), 31) < 0.07 ? -(7 + hash(Math.floor(s / 46), 32) * 15) * Math.max(0, 1 - Math.abs(((s / 46) % 1) - 0.5) * 2.6) : 0;
    const off = noise1(s / 460, 11) * 10 + noise1(s / 120, 12) * 4.5 + noise1(s / 31, 13) * 2 + nick;
    pts.push([x + nx * off, y + ny * off]);
    s += step;
  };
  sides.forEach(([x0, y0, x1, y1, nx, ny], i) => {
    const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.round(len / step));
    for (let j = 0; j <= n; j++) push(x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n, nx, ny);
    // the corner to the next side: a quarter turn about a point rc inside both
    const [, , , , mx, my] = sides[(i + 1) % 4], cx = x1 - nx * rc, cy = y1 - ny * rc;
    const a0 = Math.atan2(ny, nx);
    let da = Math.atan2(my, mx) - a0;
    while (da <= 0) da += Math.PI * 2;
    for (let j = 1; j < 5; j++) { const a = a0 + (da * j) / 5; push(cx + Math.cos(a) * rc, cy + Math.sin(a) * rc, Math.cos(a), Math.sin(a)); }
  });
  let path = null;
  if (typeof Path2D !== 'undefined') { path = new Path2D(); pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath(); }
  const v = Object.freeze({ x: X, y: Y, pad, land, points: pts, path, rose: Object.freeze({ x: X - HEX_W * 2.5, y: -Y + HEX_W * 2.5 * FLATTEN * 1.25, r: HEX_W * 1.25 }) });
  if (sheets.size > 12) sheets.clear();
  sheets.set(d, v);
  return v;
}

/** The compass rose, in sepia ink (lying on the sheet: squashed like the ground). */
function paintRose(g, rose, lw) {
  const { x, y, r } = rose;
  g.save();
  g.translate(x, y); g.scale(1, FLATTEN);
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeStyle = 'rgba(92,72,40,0.5)'; g.lineWidth = lw;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.moveTo(r * 0.8, 0); g.arc(0, 0, r * 0.8, 0, Math.PI * 2); g.stroke();
  // the ticks between the rings
  g.beginPath();
  for (let i = 0; i < 32; i++) { const a = (i * Math.PI) / 16, c = Math.cos(a), s = Math.sin(a), r0 = i % 4 ? r * 0.87 : r * 0.8; g.moveTo(c * r0, s * r0); g.lineTo(c * r, s * r); }
  g.stroke();
  // eight points: the four winds long, the four between them short; each a kite, half of it inked
  for (const [n, len, wide] of [[4, 0.74, 0.11], [4, 0.5, 0.09]]) for (let i = 0; i < n; i++) {
    const a = (i * Math.PI) / 2 + (len < 0.6 ? Math.PI / 4 : 0) - Math.PI / 2, c = Math.cos(a), s = Math.sin(a), L = r * len * (len > 0.6 && i === 0 ? 1.5 : 1), w = r * wide;
    g.beginPath(); g.moveTo(c * L, s * L); g.lineTo(-s * w, c * w); g.lineTo(0, 0); g.closePath();
    g.fillStyle = 'rgba(92,72,40,0.42)'; g.fill(); g.stroke();
    g.beginPath(); g.moveTo(c * L, s * L); g.lineTo(s * w, -c * w); g.lineTo(0, 0); g.closePath(); g.stroke();
  }
  g.restore();
}

/**
 * The sheet under the world: its shadow on the table, the paper, the wear
 * along its edge, the neatline and the compass rose. `g` is in world px;
 * `box` `{x0, y0, x1, y1}` the part of the world in the picture (the paper is
 * only laid there); `res` as for the provinces' sheets; `zoom` CSS px per
 * world px (line widths).
 */
export function paintSheet(g, sheet, { box, res = 1, zoom = 1 } = {}) {
  if (!g?.save || !sheet?.path) return;
  const { x: X, y: Y, path } = sheet;
  const b = box ?? { x0: -X - 200, y0: -Y - 200, x1: X + 200, y1: Y + 200 };
  // nothing of the sheet's edge in the picture: bare paper, edge to edge
  const inside = b.x0 > -X + 60 && b.x1 < X - 60 && b.y0 > -Y + 60 && b.y1 < Y - 60;
  g.save();
  if (!inside) {
    // the cast shadow: the lamp stands up and to the left
    g.lineJoin = 'round';
    for (const [w, a] of [[110, 0.07], [70, 0.09], [38, 0.12], [14, 0.16]]) {
      g.save(); g.translate(13, 20);
      g.strokeStyle = `rgba(4,3,2,${a})`; g.lineWidth = w; g.stroke(path);
      g.fillStyle = `rgba(4,3,2,${a})`; g.fill(path);
      g.restore();
    }
    g.clip(path);
  }
  const p = { x0: Math.max(b.x0, -X - 30), y0: Math.max(b.y0, -Y - 30), x1: Math.min(b.x1, X + 30), y1: Math.min(b.y1, Y + 30) };
  if (p.x1 > p.x0 && p.y1 > p.y0) paintPaper(g, p, res);
  if (!inside) {
    // wear: the edge is browner, and darkest at the very rim (half of each stroke falls outside the clip)
    for (const [w, a] of [[150, 0.05], [64, 0.07], [22, 0.1], [5, 0.2]]) { g.strokeStyle = `rgba(104,74,36,${a})`; g.lineWidth = w; g.stroke(path); }
  }
  // the neatline: two ruled lines inside the margin
  const lw = Math.max(1.5, 1.1 / zoom), m = HEX_W * 0.48;
  g.strokeStyle = 'rgba(92,72,40,0.5)'; g.lineWidth = lw * 1.5; g.strokeRect(-X + m, -Y + m * FLATTEN * 1.1, 2 * (X - m), 2 * (Y - m * FLATTEN * 1.1));
  const m2 = m + Math.max(9, 6 / zoom);
  g.strokeStyle = 'rgba(92,72,40,0.38)'; g.lineWidth = lw * 0.7; g.strokeRect(-X + m2, -Y + m2 * FLATTEN * 1.1, 2 * (X - m2), 2 * (Y - m2 * FLATTEN * 1.1));
  if (sheet.rose.x + sheet.rose.r > b.x0 && sheet.rose.x - sheet.rose.r < b.x1 && sheet.rose.y + sheet.rose.r > b.y0 && sheet.rose.y - sheet.rose.r < b.y1) paintRose(g, sheet.rose, lw);
  g.restore();
}
