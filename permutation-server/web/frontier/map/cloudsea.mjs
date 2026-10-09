// The cloud sea (UX brief §1, §11.3): beyond the opened rings the land does
// not exist yet, and the sheet shows a sea of cloud there. It is not a
// wallpaper of one stamp per hex:
//
//   the bank     one continuous body of cloud whose depth is a field over the
//                world: nothing over the opened land, thin where it meets the
//                chart (it overlaps the chart irregularly, by up to half a
//                hex, and casts a soft shadow on the paper), thick a hex or
//                two out, and thinning again into the bare margin of the
//                sheet. Large soft billows give it form across tile borders.
//   the puffs    the painted cloud sprites, cut out of their hex plates, set
//                down with a seeded turn, flip, size and offset (up to 30% of
//                a hex), denser and larger away from the land; no plate, no
//                lattice.
//   the drift    a large, low-frequency layer of light and shade (features of
//                300 to 600 world px) that moves slowly over the bank and
//                takes no notice of the tiles.
//
// The still part is painted once into square pieces of the world (512 px
// each, at the resolution of the view) and kept; a frame copies the pieces in
// view and lays the drift over them. Everything is seeded by place: the same
// sea every time. Pure where it can be (the field, the seeds); without a
// canvas (tests) the painter returns quietly. No asset files of its own: the
// puffs are the existing cloud sprites.
import { FLATTEN, RADIUS } from '../../map.mjs';
import { locate, ringOf } from '../fgeo.mjs';
import { HEX_W, SHEET } from './table.mjs';

const SQRT3 = Math.sqrt(3);
/** A piece of the sea: PIECE px square; its bank is worked out on a grid of GRID cells a side. */
export const PIECE = 512;
const GRID = 64;
/** A piece is painted this many px wider on every side than it is shown: its edge pixels are whole, two pieces meet without a line. */
const APRON = 2;
/** The bank's grid reaches this many cells past the piece on every side (its shadow falls a little way off it, and must not stop at the piece's edge). */
const SKIRT = 2;
/** The pieces kept (pixels in all); the pieces newly painted in one frame. */
export const SEA_PIXELS = 6_500_000;
export const SEA_BAKES = 3;
/**
 * The finenesses the sea is made at (device px per world px), and the one for a picture: the first that is at least
 * as fine as the screen, never finer than 1 (cloud is soft). The pieces are world squares of PIECE / fineness, so a
 * picture needs about the same number of them at every zoom; made at the art's fineness instead, a wide tile view
 * needed more pieces than the sea keeps and never finished them (straight edges where a square was missing).
 */
export const SEA_STEPS = Object.freeze([0.125, 0.18, 0.25, 0.36, 0.5, 0.71, 1]);
export const seaRes = px => SEA_STEPS.find(s => s >= px * 0.999) ?? 1;
/** The drift: one texture across DRIFT_SPAN world px (its features are a fifth of that), moving at DRIFT_SPEED world px a second. */
export const DRIFT_SPAN = 2300;
export const DRIFT_SPEED = Object.freeze({ x: 11, y: 4 });
/** The cloud's own colours: the body, its lit crests, its shaded troughs, the shadow it casts on the paper. */
export const CLOUD = Object.freeze({ body: [228, 227, 236], lit: [16, 16, 12], shade: [-30, -28, -14], cast: '74,60,52' });
/** How much cloud lies next to the land, and from how many tiles out the bank is at its full depth: it thickens away from the land, all the way to the sheet's margin. */
export const BANK = Object.freeze({ near: 0.7, full: 2.4 });
/** A puff's seeded variety: how far it is turned (radians either way), its sizes, how far it is moved (of a hex). */
export const PUFF = Object.freeze({ turn: 0.4, min: 0.72, max: 1.5, shift: 0.3 });

const spare = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);
const hash = (a, b = 0, c = 0) => { let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1); h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return (h >>> 0) / 4294967296; };
const smooth = t => t * t * (3 - 2 * t);
const step = (a, b, x) => (x <= a ? 0 : x >= b ? 1 : smooth((x - a) / (b - a)));
/** Value noise on the plane, −1..1; it repeats every `wrap` cells when given. */
function noise(x, y, seed = 0, wrap = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
  const at = (i, j) => (wrap ? hash(((i % wrap) + wrap) % wrap, ((j % wrap) + wrap) % wrap, seed) : hash(i, j, seed));
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return (a + (b - a) * fx + (c - a + (d - c - b + a) * fx) * fy) * 2 - 1;
}

// ------------------------------------------------------------------ the field
const RINGS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
/** How far the search for land goes (hex steps): further than the bank is deep. */
const FAR = 8;
const fields = new Map();
/**
 * The sea's field for a world of `ringsOpen` open rings:
 *   steps(q, r)   hex steps from a tile to the nearest opened tile (0 on the land, FAR beyond the search)
 *   depth(x, y)   the same as a smooth number over the world (about 0.5 on the land's own edge)
 *   cover(x, y, sheet)   how much cloud lies at a world point, 0..1
 *   inland(x, y)  whether a world point has opened land five tiles deep all around it
 */
export function seaField(ringsOpen) {
  const d = Math.max(1, ringsOpen ?? 1);
  if (fields.has(d)) return fields.get(d);
  const memo = new Map();
  const key = (q, r) => (q + 2048) * 4096 + (r + 2048);
  const open = (q, r) => { const at = locate(q, r); return ringOf(at.p, at.q) < d; };
  const steps = (q, r) => {
    const k = key(q, r);
    let v = memo.get(k);
    if (v !== undefined) return v;
    v = FAR;
    if (open(q, r)) v = 0;
    else search: for (let n = 1; n < FAR; n++) {
      // the ring of hexes n steps away
      let hq = q + RINGS[4][0] * n, hr = r + RINGS[4][1] * n;
      for (let side = 0; side < 6; side++) for (let i = 0; i < n; i++) {
        if (open(hq, hr)) { v = n; break search; }
        hq += RINGS[side][0]; hr += RINGS[side][1];
      }
    }
    memo.set(k, v);
    return v;
  };
  const depth = (x, y) => {
    // the tile under the point, and its six neighbours, each weighing by how near its middle is
    const fy = y / FLATTEN, rf = ((2 / 3) * fy) / RADIUS, qf = ((SQRT3 / 3) * x - fy / 3) / RADIUS;
    let q = Math.round(qf), r = Math.round(rf);
    const s = Math.round(-qf - rf), dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s + qf + rf);
    if (dq > dr && dq > ds) q = -r - s; else if (dr > ds) r = -q - s;
    let sum = 0, weight = 0;
    for (let i = -1; i < 6; i++) {
      const hq = i < 0 ? q : q + RINGS[i][0], hr = i < 0 ? r : r + RINGS[i][1];
      const cx = SQRT3 * RADIUS * (hq + hr / 2), cy = RADIUS * 1.5 * hr;
      const w = Math.max(0, 1 - Math.hypot(x - cx, fy - cy) / (1.95 * RADIUS));
      if (!(w > 0)) continue;
      sum += w * w * steps(hq, hr); weight += w * w;
    }
    return weight > 0 ? sum / weight : FAR;
  };
  const cover = (x, y, sheet = null) => {
    const s = depth(x, y);
    if (s < 0.02) return 0;
    // where the bank begins: it wanders about the land's edge (a slow wander and a quicker one)
    // (it reaches a little way over the land's last tiles: up to half a hex here, not at all there)
    const lip = step(0.06, 1.15, s + noise(x / 300, y / 240, 41) * 0.5 + noise(x / 95, y / 76, 42) * 0.2);
    if (!(lip > 0)) return 0;
    // (over the land itself it is never more than a thin mist: what stands on a tile in sight stays in sight)
    const inner = (1 - Math.pow(1 - lip, 1.7)) * (s < 0.5 ? 0.4 + 1.2 * s : 1);
    // it thickens away from the land (UX brief §11.3) and lies over all the paper beyond the opened rings: the land
    // that does not exist yet is under cloud, not bare. Only the sheet's own margin, with its ruled line, stays clear
    const outer = BANK.near + (1 - BANK.near) * step(0.8, BANK.full, s + noise(x / 240, y / 200, 43) * 0.5);
    let edge = 1;
    if (sheet) { const m = Math.min(sheet.x - Math.abs(x), (sheet.y - Math.abs(y)) / FLATTEN) / HEX_W + noise(x / 170, y / 150, 46) * 0.16; edge = step(SHEET.margin * 0.5, SHEET.margin * 1.2, m); }
    return inner * outer * edge;
  };
  // (deep in the land: every tile within five steps is opened; kept per tile)
  const deep = new Map();
  const inland = (x, y) => {
    const fy = y / FLATTEN, r = Math.round(((2 / 3) * fy) / RADIUS), q = Math.round(((SQRT3 / 3) * x - fy / 3) / RADIUS), k = key(q, r);
    let v = deep.get(k);
    if (v !== undefined) return v;
    v = open(q, r);
    for (let n = 1; v && n <= 5; n++) {
      let hq = q + RINGS[4][0] * n, hr = r + RINGS[4][1] * n;
      for (let side = 0; v && side < 6; side++) for (let i = 0; v && i < n; i++) { v = open(hq, hr); hq += RINGS[side][0]; hr += RINGS[side][1]; }
    }
    deep.set(k, v);
    return v;
  };
  const v = { ringsOpen: d, steps, depth, cover, inland };
  if (fields.size > 6) fields.clear();
  fields.set(d, v);
  return v;
}

/**
 * The puffs of the tile (q, r), from its seed alone: `[{dx, dy (of a hex's
 * width and height from the tile's middle), turn (radians), flip, size,
 * variant (1..3)}]`. `depth` is the sea's depth there (thicker sea: more and
 * larger puffs); `thin` (0..1) keeps a share of them at a far view.
 */
export function puffsOf(q, r, depth, thin = 1) {
  const out = [];
  const h = n => hash(q, r, n);
  // a tile carries a cluster or not: more often further out, and by a slow field of its own (clear lanes between banks)
  const often = Math.max(0.45, Math.min(0.95, 0.42 + depth * 0.22)) * (0.74 + 0.26 * noise(q / 4.3, r / 3.7, 51));
  if (h(1) < often * thin) {
    out.push({ dx: (h(2) - 0.5) * 2 * PUFF.shift, dy: (h(3) - 0.5) * 2 * PUFF.shift, turn: (h(4) - 0.5) * 2 * PUFF.turn, flip: h(5) < 0.5,
      size: (PUFF.min + (PUFF.max - PUFF.min) * h(6) * h(6)) * (1 + 0.1 * Math.min(3, depth)) / Math.sqrt(thin), variant: 1 + Math.floor(h(7) * 3) % 3 });
  }
  // and now and then a smaller one off toward a neighbour: nothing sits on the lattice
  if (h(8) < 0.55 * thin) {
    const a = h(9) * Math.PI * 2, far = 0.42 + h(10) * 0.2;
    out.push({ dx: Math.cos(a) * far, dy: Math.sin(a) * far, turn: (h(11) - 0.5) * 2 * PUFF.turn, flip: h(12) < 0.5, size: (0.5 + h(13) * 0.32) / Math.sqrt(thin), variant: 1 + Math.floor(h(14) * 3) % 3 });
  }
  return out;
}

// ------------------------------------------------------------------ the drift
let driftTex;
/** The drifting light and shade: a texture that repeats without a seam (lavender shade where it is dense, white where it is bright). */
export function driftTexture() {
  if (driftTex !== undefined) return driftTex;
  const N = 256, cv = spare(N, N), g = cv?.getContext?.('2d');
  if (!g?.createImageData) { driftTex = null; return null; }
  const img = g.createImageData(N, N), d = img.data;
  for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i += 4) {
    const v = noise((x / N) * 5, (y / N) * 5, 61, 5) * 0.72 + noise((x / N) * 11, (y / N) * 11, 62, 11) * 0.28;
    if (v > 0) { d[i] = 118; d[i + 1] = 120; d[i + 2] = 152; d[i + 3] = step(0.04, 0.62, v) * 0.2 * 255; }
    else { d[i] = 255; d[i + 1] = 253; d[i + 2] = 248; d[i + 3] = step(0.18, 0.7, -v) * 0.2 * 255; }
  }
  g.putImageData(img, 0, 0);
  driftTex = cv;
  return driftTex;
}

// ------------------------------------------------------------------ a heap of cloud
/**
 * One heap of cloud about (x, y), `r` across (world px): a handful of soft rounds, each with its shade under it to the
 * lower right and its light on its upper left shoulder; seeded, so the same heap every time. `bank`: a wide, low one.
 */
export function paintHeap(g, x, y, r, seed = 0, alpha = 1, bank = false) {
  if (!g?.createRadialGradient || !(r > 0) || !(alpha > 0)) return 0;
  const n = (bank ? 9 : 4) + Math.floor(hash(seed, 1) * (bank ? 6 : 5));
  const rounds = [];
  for (let i = 0; i < n; i++) {
    const a = hash(seed, 10 + i) * Math.PI * 2, d = Math.sqrt(hash(seed, 40 + i)) * r * (bank ? 0.72 : 0.56);
    rounds.push({ x: x + Math.cos(a) * d * 1.25, y: y + Math.sin(a) * d * 0.62, r: r * (bank ? 0.3 + 0.24 * hash(seed, 70 + i) : 0.36 + 0.3 * hash(seed, 70 + i)) });
  }
  rounds.sort((p, q) => p.y - q.y);
  g.save();
  for (const b of rounds) {
    let gr = g.createRadialGradient(b.x + b.r * 0.2, b.y + b.r * 0.3, b.r * 0.2, b.x + b.r * 0.2, b.y + b.r * 0.3, b.r * 1.08);
    gr.addColorStop(0, `rgba(120,122,160,${(0.42 * alpha).toFixed(3)})`); gr.addColorStop(1, 'rgba(120,122,160,0)');
    g.fillStyle = gr; g.fillRect(b.x - b.r * 1.3, b.y - b.r * 1.3, b.r * 2.6, b.r * 2.6);
    gr = g.createRadialGradient(b.x - b.r * 0.2, b.y - b.r * 0.24, b.r * 0.06, b.x - b.r * 0.08, b.y - b.r * 0.1, b.r * 0.92);
    gr.addColorStop(0, `rgba(255,255,253,${(0.96 * alpha).toFixed(3)})`); gr.addColorStop(0.5, `rgba(250,250,252,${(0.72 * alpha).toFixed(3)})`); gr.addColorStop(0.82, `rgba(240,240,248,${(0.22 * alpha).toFixed(3)})`); gr.addColorStop(1, 'rgba(240,240,248,0)');
    g.fillStyle = gr; g.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
  }
  g.restore();
  return rounds.length;
}

// ------------------------------------------------------------------ the painter
/** The sprite set a resolution draws its puffs from (map/sprites.mjs ART_SIZES: radius, cell, anchor). */
const SETS = [{ key: '@0.5x', r: 22, w: 44, h: 52, ax: 22, ay: 31 }, { key: '@1x', r: 44, w: 88, h: 104, ax: 44, ay: 62 }, { key: '@2x', r: 88, w: 176, h: 208, ax: 88, ay: 124 }];
/** The art's lift from its anchor to the tile's top face (map/sprites.mjs TOP_LIFT), in tile radii. */
const LIFT = 0.24 * Math.sqrt(1 - FLATTEN * FLATTEN);

export class CloudSea {
  /** `image(set, size, name)` gives a loaded sprite or null (map/sprites.mjs SpriteArt.image); without it the sea has its bank and billows only. */
  constructor({ image = null } = {}) {
    this.image = image;
    this.pieces = new Map();
    this.pixels = 0;
    this.puffs = new Map();
    this.scratch = null;
  }

  /** A cloud sprite without its hex plate: the puffs in the middle, fading out before the rim (made once per sprite). */
  puff(set, variant) {
    const img = this.image?.('fog', set.key, `cloud_${variant}`) ?? null;
    if (!img) return null;
    const hit = this.puffs.get(img);
    if (hit) return hit;
    const cv = spare(set.w, set.h), g = cv?.getContext?.('2d');
    if (!g?.createRadialGradient) return null;
    g.drawImage(img, 0, 0, set.w, set.h);
    // keep the middle of the top face; the plate's rim and its outline go
    const cx = set.ax, cy = set.ay - LIFT * set.r;
    g.globalCompositeOperation = 'destination-in';
    g.translate(cx, cy); g.scale(1, 0.8);
    const gr = g.createRadialGradient(0, 0, set.r * 0.36, 0, 0, set.r * 0.8);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.75)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(-set.w, -set.h, set.w * 2, set.h * 2);
    const v = { cv, cx, cy, r: set.r };
    this.puffs.set(img, v);
    return v;
  }

  /**
   * One piece of the sea: the square of the world from (ix, iy) · size, at
   * `res` px per world px. `{cv, mask, x, y, size, empty, whole}`: `mask` is
   * the bank's cover on the piece's grid (for the drift), `empty` a piece
   * with no cloud at all, `whole` false while a sprite was still loading.
   */
  bake(ringsOpen, res, ix, iy, sheet) {
    const size = PIECE / res, x0 = ix * size, y0 = iy * size, cell = size / GRID, n = GRID + 1 + 2 * SKIRT;
    const F = seaField(ringsOpen);
    // the bank on the grid: one sample at every grid point (the pieces agree along their shared edges)
    const mcv = spare(n, n), mg = mcv?.getContext?.('2d');
    if (!mg?.createImageData) return null;
    const img = mg.createImageData(n, n), d = img.data;
    let any = false;
    const [BR, BG, BB] = CLOUD.body;
    for (let j = 0, i = 0; j < n; j++) for (let k = 0; k < n; k++, i += 4) {
      const x = x0 + (k - SKIRT) * cell, y = y0 + (j - SKIRT) * cell, a = F.cover(x, y, sheet);
      if (!(a > 0.004)) continue;
      any = true;
      // lit crests and shaded troughs, large and slow
      const l = noise(x / 420, y / 330, 44) * 0.62 + noise(x / 150, y / 118, 45) * 0.38, t = l > 0 ? CLOUD.lit : CLOUD.shade, m = Math.abs(l);
      d[i] = BR + t[0] * m; d[i + 1] = BG + t[1] * m; d[i + 2] = BB + t[2] * m; d[i + 3] = Math.min(1, a * 1.04) * 250;
    }
    if (!any) return { empty: true, x: x0, y: y0, size, px: 16, whole: true };
    mg.putImageData(img, 0, 0);
    const cv = spare(PIECE + 2 * APRON, PIECE + 2 * APRON), g = cv?.getContext?.('2d');
    if (!g) return null;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    // (a grid point is the middle of its sample: the picture of the grid reaches half a cell past the piece on every side)
    const k = PIECE / GRID, at = [APRON - k * (SKIRT + 0.5), APRON - k * (SKIRT + 0.5), n * k, n * k];
    // the shadow the bank casts on the paper: the bank itself, darkened, a little down and to the right
    const sc = this.scratch ??= spare(n, n), sg = sc.getContext('2d');
    sg.setTransform(1, 0, 0, 1, 0, 0); sg.globalCompositeOperation = 'copy'; sg.drawImage(mcv, 0, 0);
    sg.globalCompositeOperation = 'source-in'; sg.fillStyle = `rgb(${CLOUD.cast})`; sg.fillRect(0, 0, n, n);
    sg.globalCompositeOperation = 'source-over';
    g.globalAlpha = 0.44; g.drawImage(sc, at[0] + 7 * res, at[1] + 11 * res, at[2], at[3]);
    g.globalAlpha = 1; g.drawImage(mcv, ...at);
    g.setTransform(res, 0, 0, res, APRON - x0 * res, APRON - y0 * res);
    // the billows: large soft forms, each lit from the upper left with its shade under it
    const bw = 200, bh = 150;
    for (let by = Math.floor((y0 - bh) / bh); by <= Math.floor((y0 + size + bh) / bh); by++) for (let bx = Math.floor((x0 - bw) / bw); bx <= Math.floor((x0 + size + bw) / bw); bx++) {
      if (hash(bx, by, 71) > 0.88) continue;
      const x = (bx + hash(bx, by, 72)) * bw, y = (by + hash(bx, by, 73)) * bh, a = F.cover(x, y, sheet);
      if (!(a > 0.3)) continue;
      const r = 95 + hash(bx, by, 74) * 90;
      // (a billow keeps whole on the sheet)
      if (sheet && Math.min(sheet.x - Math.abs(x), (sheet.y - Math.abs(y)) / FLATTEN) < r * 1.05 + HEX_W * 0.3) continue;
      g.save(); g.translate(x, y); g.scale(1, FLATTEN * 0.92);
      let gr = g.createRadialGradient(r * 0.2, r * 0.26, r * 0.25, r * 0.2, r * 0.26, r * 1.05);
      gr.addColorStop(0, `rgba(128,128,168,${0.4 * a})`); gr.addColorStop(1, 'rgba(128,128,168,0)');
      g.fillStyle = gr; g.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6);
      gr = g.createRadialGradient(-r * 0.16, -r * 0.2, r * 0.08, -r * 0.16, -r * 0.2, r * 0.86);
      gr.addColorStop(0, `rgba(255,254,251,${0.78 * a})`); gr.addColorStop(0.5, `rgba(255,254,251,${0.4 * a})`); gr.addColorStop(1, 'rgba(255,254,251,0)');
      g.fillStyle = gr; g.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6);
      g.restore();
    }
    // the heaps: every tile near the piece gives its own, back to front. Each is drawn here, soft and lit from the
    // upper left (the art's cloud stamps had one embossed shape: a field of them read as cotton balls); now and then
    // a few tiles share one large bank
    // (from afar a heap would be a speck: fewer of them, each larger)
    const afar = Math.max(1, Math.min(3.4, 0.7 / res));
    const thin = Math.min(1, Math.max(0.08, 1 / (afar * afar)));
    const whole = true;
    const list = [];
    const rowH = RADIUS * 1.5 * FLATTEN, pad = HEX_W * 3.4 * afar;
    // a heap keeps whole on the sheet: none hangs over the sheet's edge onto the table
    const onSheet = (x, y, r) => !sheet || Math.min(sheet.x - Math.abs(x), (sheet.y - Math.abs(y)) / FLATTEN) > r * 1.15 + HEX_W * 0.5;
    for (let r = Math.floor((y0 - pad) / rowH); r <= Math.ceil((y0 + size + pad) / rowH); r++) {
      for (let q = Math.floor((x0 - pad) / HEX_W - r / 2); q <= Math.ceil((x0 + size + pad) / HEX_W - r / 2); q++) {
        const cx = HEX_W * (q + r / 2), cy = rowH * r;
        const dep = F.steps(q, r);
        if (dep === 0) continue;
        puffsOf(q, r, dep, thin).forEach((p, i) => {
          const x = cx + p.dx * HEX_W, y = cy + p.dy * HEX_W * FLATTEN, a = F.cover(x, y, sheet);
          // (`puffsOf` already makes the few heaps of a far view larger)
          const pr = RADIUS * 0.74 * (dep === 1 ? Math.min(p.size, 0.9 * afar) : p.size);
          // (no heap stands over the land: next to it they are small, so none hangs over a tile in sight)
          if (a > 0.16 && F.depth(x, y) > 0.62 && onSheet(x, y, pr)) list.push({ x, y, a: Math.min(1, a * 1.3), r: pr, seed: (q * 131 + r * 977 + i * 7919) | 0 });
        });
        // a bank: a heap three or four tiles wide, well out from the land
        if (dep >= 3 && hash(q, r, 81) < 0.07 * Math.min(1, thin * 1.6)) { const a = F.cover(cx, cy, sheet), br = RADIUS * (2.3 + hash(q, r, 82) * 1.5) * Math.sqrt(afar); if (a > 0.5 && onSheet(cx, cy, br)) list.push({ x: cx, y: cy, a, r: br, seed: (q * 733 + r * 389) | 0, bank: true }); }
      }
    }
    list.sort((a, b) => (b.bank ? 1 : 0) - (a.bank ? 1 : 0) || a.y - b.y || a.x - b.x);
    for (const h of list) paintHeap(g, h.x, h.y, h.r, h.seed, h.a, h.bank);
    return { cv, mask: mcv, x: x0, y: y0, size, px: (PIECE + 2 * APRON) ** 2, whole, empty: false };
  }

  /** The piece (kept, or painted now when `canPaint()`), or null while it waits its turn. */
  piece(ringsOpen, res, ix, iy, sheet, canPaint) {
    const key = `${ringsOpen}|${res}|${ix},${iy}`;
    const hit = this.pieces.get(key);
    if (hit) { this.pieces.delete(key); this.pieces.set(key, hit); return hit; }
    if (!canPaint()) return null;
    const v = this.bake(ringsOpen, res, ix, iy, sheet);
    if (v?.whole) {
      v.rings = ringsOpen;
      this.pieces.set(key, v);
      this.pixels += v.px;
      while (this.pixels > SEA_PIXELS && this.pieces.size > 1) { const [k, o] = this.pieces.entries().next().value; this.pieces.delete(k); this.pixels -= o.px; }
    }
    return v;
  }

  /**
   * Paint the sea where `box` `{x0, y0, x1, y1}` (the part of the world in
   * the picture, world px) has any. `ctx` is in world px; `res` the device px
   * per world px the pieces are made for (at most 1: cloud is soft); `part`
   * 'still' the bank and the puffs, 'drift' the moving light and shade over
   * them, null both; `now` ms (the drift's clock), `still` true under reduced
   * motion (the drift lies where it is). Returns `{pending, seen}`: pieces
   * that wait their turn, and whether any cloud is in the picture.
   */
  paint(ctx, { box, res = 1, ringsOpen = 1, sheet = null, now = 0, still = false, part = null, bakes = SEA_BAKES } = {}) {
    const out = { pending: 0, seen: false };
    if (!ctx?.drawImage || !box) return out;
    const r = Math.min(1, res), size = PIECE / r;
    // (beyond the sheet there is no sea)
    const b = sheet ? { x0: Math.max(box.x0, -sheet.x), y0: Math.max(box.y0, -sheet.y), x1: Math.min(box.x1, sheet.x), y1: Math.min(box.y1, sheet.y) } : box;
    if (!(b.x1 > b.x0) || !(b.y1 > b.y0)) return out;
    let left = bakes;
    const canPaint = () => left-- > 0;
    const m = ctx.getTransform?.() ?? null;
    const tex = part !== 'still' ? driftTexture() : null;
    const t = still ? 0 : now / 1000;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    for (let iy = Math.floor(b.y0 / size); iy <= Math.floor(b.y1 / size); iy++) for (let ix = Math.floor(b.x0 / size); ix <= Math.floor(b.x1 / size); ix++) {
      const p = this.piece(ringsOpen, r, ix, iy, sheet, canPaint);
      if (!p) {
        out.pending++;
        // (a piece that waits its turn: the part of any kept piece of another fineness that lies there stands in,
        // so a flight never shows the sea ending in a straight line; the second review's landing frames)
        if (part !== 'drift' && this.standIn(ctx, ringsOpen, ix * size, iy * size, size)) out.seen = true;
        continue;
      }
      if (p.empty) continue;
      out.seen = true;
      if (!p.whole) out.pending++;
      if (part !== 'drift') {
        if (m) {
          // on whole device pixels: two pieces meet without a seam
          const xa = Math.round(m.a * p.x + m.e), ya = Math.round(m.d * p.y + m.f), xb = Math.round(m.a * (p.x + size) + m.e), yb = Math.round(m.d * (p.y + size) + m.f);
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(p.cv, APRON, APRON, PIECE, PIECE, xa, ya, xb - xa, yb - ya); ctx.setTransform(m);
        } else ctx.drawImage(p.cv, APRON, APRON, PIECE, PIECE, p.x, p.y, size, size);
      }
      if (tex && p.mask) this.drift(ctx, p, tex, t);
    }
    ctx.restore();
    return out;
  }

  /** Paint what kept pieces of other finenesses hold of the square (x, y, size) of the world; returns whether any did. */
  standIn(ctx, ringsOpen, x, y, size) {
    // by fineness: what each holds of the square
    const bySize = new Map();
    for (const [key, q] of this.pieces) {
      if (q.rings !== ringsOpen || !q.cv) continue;
      const x0 = Math.max(x, q.x), y0 = Math.max(y, q.y), x1 = Math.min(x + size, q.x + q.size), y1 = Math.min(y + size, q.y + q.size);
      if (!(x1 - x0 > 0.5) || !(y1 - y0 > 0.5)) continue;
      const e = bySize.get(q.size) ?? { area: 0, list: [] };
      e.area += (x1 - x0) * (y1 - y0); e.list.push([q, x0, y0, x1, y1, key]);
      bySize.set(q.size, e);
    }
    if (!bySize.size) return false;
    // the fineness that holds most of the square first; what it leaves bare is filled from the next (never two over
    // the same ground: the soft edge would be laid on twice), so a square is whole whenever the kept pieces cover it
    const order = [...bySize.values()].sort((a, b) => b.area - a.area);
    const done = [];
    let any = false;
    ctx.save();
    for (const e of order) {
      if (done.length) {
        ctx.beginPath(); ctx.rect(x, y, size, size);
        for (const [x0, y0, x1, y1] of done) ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.clip('evenodd');
      }
      for (const [q, x0, y0, x1, y1, key] of e.list) {
        // (a piece that stands in is in use: it is not the next to be dropped)
        this.pieces.delete(key); this.pieces.set(key, q);
        done.push([x0, y0, x1, y1]);
        if (q.empty) continue;
        const k = PIECE / q.size;
        ctx.drawImage(q.cv, APRON + (x0 - q.x) * k, APRON + (y0 - q.y) * k, (x1 - x0) * k, (y1 - y0) * k, x0, y0, x1 - x0, y1 - y0);
        any = true;
      }
      if (e.area >= size * size - 1) break;
    }
    ctx.restore();
    return any;
  }

  /** The drift over one piece: the moving texture, cut to the piece's own bank. */
  drift(ctx, p, tex, t) {
    const n = GRID + 1 + 2 * SKIRT, cell = p.size / GRID;
    const sc = this.driftCv ??= spare(n, n), sg = sc?.getContext?.('2d');
    if (!sg?.createPattern || typeof DOMMatrix === 'undefined') return;
    const pat = this.driftPat ??= sg.createPattern(tex, 'repeat');
    // the texture lies on the world and moves over it; in this scratch one px is one grid cell of the piece
    const k = DRIFT_SPAN / 256 / cell;
    pat.setTransform(new DOMMatrix([k, 0, 0, k, (DRIFT_SPEED.x * t - p.x) / cell + SKIRT + 0.5, (DRIFT_SPEED.y * t - p.y) / cell + SKIRT + 0.5]));
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalCompositeOperation = 'copy'; sg.fillStyle = pat; sg.fillRect(0, 0, n, n);
    sg.globalCompositeOperation = 'destination-in'; sg.drawImage(p.mask, 0, 0);
    sg.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.size, p.size); ctx.clip();
    ctx.drawImage(sc, p.x - cell * (SKIRT + 0.5), p.y - cell * (SKIRT + 0.5), n * cell, n * cell);
    ctx.restore();
  }
}
