// The land as one country, not a quilt of hexagons (docs/design/uplift/06-MAP-REST): two passes over the baked ground
// of the tile view, laid into a province's ground bitmap once (map/sprites.mjs), so a moving frame costs nothing more.
//
//   blend    where two kinds of land meet, each side takes a little of the other's colour toward the shared edge, so
//            grass runs into plains and plains into hills over a third of a tile instead of at a hard line. The
//            colours are the art's own: each sprite's middle, sampled once.
//   shores   a body of water is outlined once as a whole (across provinces: the same outline whichever province
//            paints it), the outline is smoothed and a little worn, and then the water's hexagon corners that lie
//            outside it are given to the land, the land's corners inside it to the water, and the new coast gets a
//            band of wet sand, a band of shallows and a line of foam. The baked edge-by-edge beaches are not drawn
//            under it (they followed the hexagons).
//
// Nothing here is a rule: the hexes, where water is, what a tile is, are exactly the record's. Only where the colour of
// one meets the colour of the next is painted softer. Pure drawing; context-tolerant (a recorder in a test, no
// gradients, no image data: nothing is drawn and nothing throws).
import { project, hexPoints, RADIUS } from '../../map.mjs';
import { landShape } from './ownland.mjs';

/** Neighbour across edge k (axial, as map/sprites.mjs EDGE_DIRS; edge 0 the upper-left one). */
const EDGE_DIRS = [[0, -1], [-1, 0], [-1, 1], [0, 1], [1, 0], [1, -1]];
/** The two hex corners (hexPoints indices: 0 upper right, clockwise) edge k runs between, and the corners beyond them. */
const ends = k => [(10 - k) % 6, (11 - k) % 6];
const beyond = k => [(9 - k) % 6, (12 - k) % 6];
/** How far a neighbour's colour reaches into a tile (share of the tile's centre-to-edge distance), and how strong at the edge. */
export const BLEND = Object.freeze({ depth: 0.5, edge: 0.5 });
/** The coast: how many times the outline is rounded, how far it is worn (world px), and its bands (world px wide). */
export const SHORE = Object.freeze({ rounds: 3, wear: 2.4, sand: 7, shallows: 15, foam: 1.5, cap: 900 });
/** Kinds of land that blend (water has its coast; cloud and the chart are not land). */
const LAND = new Set(['grassland', 'plains', 'forest', 'hills', 'mountain']);
const keyOf = (q, r) => `${q},${r}`;

// ------------------------------------------------------------------ the art's colours
const sampled = new WeakMap();
/**
 * The colour of a sprite's middle (its top face, away from the skirt and the edges): `[r, g, b]`, or null where the
 * image cannot be read. Sampled once per image.
 */
export function spriteColour(img) {
  if (!img || typeof img !== 'object') return null;
  if (sampled.has(img)) return sampled.get(img);
  let out = null;
  try {
    const w = 12, h = 8, cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null;
    const c = cv?.getContext?.('2d', { willReadFrequently: true });
    if (c && img.width && img.height) {
      // the middle third across and the band above the anchor down (the top face of the sprite)
      c.drawImage(img, img.width * 0.3, img.height * 0.32, img.width * 0.4, img.height * 0.26, 0, 0, w, h);
      const d = c.getImageData(0, 0, w, h).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      if (n) out = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }
  } catch { out = null; }
  sampled.set(img, out);
  return out;
}
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

const hexPath = (g, x, y, inset = 0) => { hexPoints(x, y, inset).forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); };
const canPaint = g => !!g?.save && !!g.createLinearGradient?.(0, 0, 1, 1)?.addColorStop;

// ------------------------------------------------------------------ blend
/**
 * Soften the meeting of two kinds of land on `tiles` (the tiles of one province's bitmap, or of a frame).
 * `nameAt(q, r)` the kind of land of a hex (null where none is known), `colourAt(q, r)` its art's colour or null,
 * `paints(q, r)` whether the hex is painted land (surveyed) here.
 */
export function paintBlend(g, tiles, { nameAt, colourAt, paints = () => true } = {}) {
  if (!canPaint(g)) return;
  g.save();
  for (const t of tiles) {
    if (!LAND.has(t.name) || !paints(t.q, t.r)) continue;
    // (each wedge is the middle and four corners of the tile's own hexagon: inside it, with no clip; a clip a tile made
    // the blend the dearest part of a bitmap after the swell)
    const pts = hexPoints(t.x, t.y, 0);
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = EDGE_DIRS[k], nq = t.q + dq, nr = t.r + dr, nb = nameAt(nq, nr);
      if (!nb || nb === t.name || !LAND.has(nb) || !paints(nq, nr)) continue;
      // (forest and grassland lie on the same baked ground, and hills under a mountain: the same colour meets itself)
      const col = colourAt(nq, nr);
      if (!col) continue;
      const [ia, ib] = ends(k), a = pts[ia], b = pts[ib], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const ex = mx + (t.x - mx) * BLEND.depth, ey = my + (t.y - my) * BLEND.depth;
      const gr = g.createLinearGradient(mx, my, ex, ey);
      gr.addColorStop(0, rgba(col, BLEND.edge)); gr.addColorStop(0.45, rgba(col, BLEND.edge * 0.38)); gr.addColorStop(1, rgba(col, 0));
      g.fillStyle = gr;
      // the half of the tile on this edge's side (a wedge wider than the edge, so neighbouring edges' colours meet softly)
      const [i0, i3] = beyond(k), p0 = pts[i0], p3 = pts[i3];
      g.beginPath(); g.moveTo(t.x, t.y); g.lineTo(p0[0], p0[1]); g.lineTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(p3[0], p3[1]); g.closePath(); g.fill();
    }
  }
  g.restore();
}

// ------------------------------------------------------------------ the land's own light and shade
/** The broad light and shade over the land: how strong, and how wide its swells are (world px). */
export const MACRO = Object.freeze({ alpha: 0.3, wave: 520, reach: 1.7 });
/** A smooth value in −1..1 over the world (a few long waves, the same everywhere for a point). */
export function swell(x, y) {
  const w = MACRO.wave;
  return (Math.sin(x / w * 1.7 + 0.3) * Math.cos(y / w * 2.3 - 1.1) * 0.55 + Math.sin((x + y) / w * 1.1 + 2.0) * 0.3 + Math.cos((x - 2 * y) / w * 0.9) * 0.15);
}
/**
 * Long swells of light and shade across the land, so a stretch of one kind of land is not the same picture hexagon
 * after hexagon: each land tile and its neighbours lay a soft round wash of warm light or cool shade, by `swell` at
 * their middles, inside `tiles`' hexagons only (a neighbour of another province lays its wash too: the swell does not
 * stop at a province's edge).
 */
export function paintSwell(g, tiles, { nameAt, paints = () => true } = {}) {
  if (!canPaint(g) || !g.createRadialGradient) return;
  const here = tiles.filter(t => LAND.has(t.name) && paints(t.q, t.r));
  if (!here.length) return;
  const seeds = new Map();
  for (const t of here) for (const [dq, dr] of [[0, 0], ...EDGE_DIRS]) {
    const q = t.q + dq, r = t.r + dr, k = keyOf(q, r);
    if (!seeds.has(k) && LAND.has(nameAt(q, r))) seeds.set(k, project(q, r));
  }
  g.save();
  g.beginPath(); for (const t of here) hexPath(g, t.x, t.y, -0.3); g.clip();
  g.globalCompositeOperation = 'soft-light';
  const rad = RADIUS * MACRO.reach;
  // (the swell is a wash of waves some 500 world px long: it is laid on a sheet at SWELL_RES of a world px and put
  // over the land once, soft-light, instead of some hundred gradients each blended at the bitmap's full size, which
  // made a province's bitmap a third slower to make on a 61-province world)
  const sheet = swellSheet(seeds, rad);
  // (plain alpha instead of soft-light saved a little more but greyed the shaded patches: soft-light kept)
  if (sheet) g.drawImage(sheet.cv, sheet.x, sheet.y, sheet.w, sheet.h);
  else for (const c of seeds.values()) {
    const v = swell(c.x, c.y), a = Math.min(1, Math.abs(v)) * MACRO.alpha;
    if (a < 0.02) continue;
    const col = v > 0 ? [255, 236, 186] : [22, 40, 34];
    const gr = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad);
    gr.addColorStop(0, rgba(col, a)); gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr; g.fillRect(c.x - rad, c.y - rad, rad * 2, rad * 2);
  }
  g.restore();
}
/** The swell's sheet: canvas px per world px (the wash has no detail finer than a few tiles). */
export const SWELL_RES = 0.125;
/** The swell's washes laid on a small sheet covering the seeds: `{cv, x, y, w, h}` in world px, or null where no canvas. */
function swellSheet(seeds, rad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of seeds.values()) { x0 = Math.min(x0, c.x - rad); y0 = Math.min(y0, c.y - rad); x1 = Math.max(x1, c.x + rad); y1 = Math.max(y1, c.y + rad); }
  const w = Math.max(1, Math.ceil((x1 - x0) * SWELL_RES)), h = Math.max(1, Math.ceil((y1 - y0) * SWELL_RES));
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null;
  const s = cv?.getContext?.('2d');
  if (!s?.createRadialGradient) return null;
  s.setTransform(SWELL_RES, 0, 0, SWELL_RES, -x0 * SWELL_RES, -y0 * SWELL_RES);
  for (const c of seeds.values()) {
    const v = swell(c.x, c.y), a = Math.min(1, Math.abs(v)) * MACRO.alpha;
    if (a < 0.02) continue;
    const col = v > 0 ? [255, 236, 186] : [22, 40, 34];
    const gr = s.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad);
    gr.addColorStop(0, rgba(col, a)); gr.addColorStop(1, rgba(col, 0));
    s.fillStyle = gr; s.fillRect(c.x - rad, c.y - rad, rad * 2, rad * 2);
  }
  // (the sheet's own size in world px: its pixels are whole, so it reaches a little past x1, y1; laid at x1 − x0 it was
  // stretched by up to a pixel of the sheet, a different amount in each province's bitmap)
  return { cv, x: x0, y: y0, w: w / SWELL_RES, h: h / SWELL_RES };
}

// ------------------------------------------------------------------ shores
const bodies = new Map();
/**
 * The body of water hex (q, r) belongs to, found over every hex whose kind is known (`nameAt`): `{key, set, loops}`,
 * `loops` the smoothed, worn coast (world px). The same body, and so the same coast, whichever tile asks.
 * Kept until `forgetShores()`.
 */
export function waterBody(q, r, nameAt) {
  const k0 = keyOf(q, r);
  for (const b of bodies.values()) if (b.set.has(k0)) return b;
  const set = new Set([k0]), list = [{ q, r, d: 0 }], open = [{ q, r }];
  while (open.length && set.size < SHORE.cap) {
    const h = open.pop();
    for (const [dq, dr] of EDGE_DIRS) {
      const nq = h.q + dq, nr = h.r + dr, k = keyOf(nq, nr);
      if (set.has(k) || nameAt(nq, nr) !== 'water') continue;
      set.add(k); list.push({ q: nq, r: nr, d: 1 }); open.push({ q: nq, r: nr });
    }
  }
  const loops = landShape(list).loops.map(smoothLoop);
  const key = [...set].sort()[0];
  const body = { key, set, loops };
  bodies.set(key, body);
  return body;
}
/** The coasts of every body of water any of `tiles` is or touches (for the grid, which stays off the water). */
export function waterLoops(tiles, nameAt) {
  const seen = new Map();
  for (const t of tiles) {
    const w = t.name === 'water' ? t : EDGE_DIRS.map(([dq, dr]) => ({ q: t.q + dq, r: t.r + dr })).find(h => nameAt(h.q, h.r) === 'water');
    if (!w) continue;
    const b = waterBody(w.q, w.r, nameAt);
    seen.set(b.key, b);
  }
  return [...seen.values()].flatMap(b => b.loops);
}
/** Clip `g` to everything outside the loops (call between save and restore). */
export function clipOutside(g, loops) {
  if (!loops.length || !g?.clip) return;
  g.beginPath(); g.rect(-1e6, -1e6, 2e6, 2e6); loopPath(g, loops); g.clip('evenodd');
}

/** Forget the bodies of water (a season's land changed: a new ring opened). */
export function forgetShores() { bodies.clear(); }

/** A closed loop rounded (Chaikin, cutting a quarter) and worn a little (a seeded wobble along its normal). */
export function smoothLoop(loop) {
  let pts = loop.map(([x, y]) => [x, y]);
  for (let i = 0; i < SHORE.rounds; i++) {
    const out = [];
    for (let j = 0; j < pts.length; j++) {
      const [ax, ay] = pts[j], [bx, by] = pts[(j + 1) % pts.length];
      out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    pts = out;
  }
  // the wear: seeded by where the point is in the world, so a coast is worn the same in every province's picture
  return pts.map(([x, y], j) => {
    const [px, py] = pts[(j + pts.length - 1) % pts.length], [nx, ny] = pts[(j + 1) % pts.length];
    const tx = nx - px, ty = ny - py, len = Math.hypot(tx, ty) || 1;
    const s = Math.sin(x * 0.091 + y * 0.137) * 0.6 + Math.sin(x * 0.033 - y * 0.051) * 0.4;
    return [x + (-ty / len) * s * SHORE.wear, y + (tx / len) * s * SHORE.wear];
  });
}
const loopPath = (g, loops) => { for (const l of loops) { l.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); } };

/**
 * The coasts on `tiles` (one province's bitmap, or a frame's tiles): only inside those tiles' hexagons, so two
 * provinces' pictures meet without a seam. `nameAt`, `colourAt`, `paints` as for paintBlend. Returns whether any
 * coast was drawn (the caller then leaves the edge-by-edge beaches out).
 */
export function paintShores(g, tiles, { nameAt, colourAt, paints = () => true } = {}) {
  if (!canPaint(g)) return false;
  const here = tiles.filter(t => paints(t.q, t.r) && (t.name === 'water' || EDGE_DIRS.some(([dq, dr]) => nameAt(t.q + dq, t.r + dr) === 'water')));
  if (!here.length) return false;
  const seen = new Map(), bodyOf = new Map();
  for (const t of here) {
    const wet = t.name === 'water' ? [t] : EDGE_DIRS.map(([dq, dr]) => ({ q: t.q + dq, r: t.r + dr })).filter(h => nameAt(h.q, h.r) === 'water');
    const mine = new Map();
    for (const w of wet) { const b = waterBody(w.q, w.r, nameAt); mine.set(b.key, b); if (!seen.has(b.key)) seen.set(b.key, b); }
    bodyOf.set(keyOf(t.q, t.r), [...mine.values()]);
  }
  const all = [...seen.values()].flatMap(b => b.loops);
  // (a tile's corners are cut by the coasts of the bodies it is or touches: clipping each tile against every coast of
  // the picture made the shores the dearest part of a bitmap on a world of many lakes. A body cut short at SHORE.cap (a
  // sea) has a false edge where it stops: a tile of one is cut by every coast, as before)
  const own = t => { const bs = bodyOf.get(keyOf(t.q, t.r)) ?? []; return !bs.length || bs.some(b => b.set.size >= SHORE.cap) ? all : bs.flatMap(b => b.loops); };
  const inWater = (t) => { const c = project(t.q, t.r); return { ...t, x: c.x, y: c.y }; };
  g.save();
  // only inside this picture's own hexes
  g.beginPath(); for (const t of tiles) { const c = project(t.q, t.r); hexPath(g, c.x, c.y, -0.3); } g.clip();
  // 1. the water's corners outside the coast go to the land beside them: each edge's wedge in its neighbour's colour
  for (const t of here.filter(x => x.name === 'water').map(inWater)) {
    const pts = hexPoints(t.x, t.y, 0), lands = EDGE_DIRS.map(([dq, dr]) => ({ q: t.q + dq, r: t.r + dr })).filter(h => LAND.has(nameAt(h.q, h.r)));
    if (!lands.length) continue;
    const mean = lands.map(h => colourAt(h.q, h.r)).filter(Boolean);
    if (!mean.length) continue;
    const avg = [0, 1, 2].map(i => Math.round(mean.reduce((s, c) => s + c[i], 0) / mean.length));
    g.save();
    // outside the coast, inside this hexagon
    g.beginPath(); hexPath(g, t.x, t.y, -0.3); g.clip();
    g.beginPath(); g.rect(t.x - RADIUS * 2, t.y - RADIUS * 2, RADIUS * 4, RADIUS * 4); loopPath(g, own(t)); g.clip('evenodd');
    g.fillStyle = rgba(avg, 1); g.fillRect(t.x - RADIUS * 2, t.y - RADIUS * 2, RADIUS * 4, RADIUS * 4);
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = EDGE_DIRS[k], col = LAND.has(nameAt(t.q + dq, t.r + dr)) ? colourAt(t.q + dq, t.r + dr) : null;
      if (!col) continue;
      const [ia, ib] = ends(k), a = pts[ia], b = pts[ib];
      g.fillStyle = rgba(col, 1); g.beginPath(); g.moveTo(t.x, t.y); g.lineTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.closePath(); g.fill();
    }
    g.restore();
  }
  // 2. the land's corners inside the coast go to the water (the water's own colour)
  for (const t of here.filter(x => x.name !== 'water' && LAND.has(x.name)).map(inWater)) {
    const wet = EDGE_DIRS.map(([dq, dr]) => ({ q: t.q + dq, r: t.r + dr })).find(h => nameAt(h.q, h.r) === 'water');
    const col = wet ? colourAt(wet.q, wet.r) : null;
    if (!col) continue;
    g.save(); g.beginPath(); hexPath(g, t.x, t.y, -0.3); g.clip();
    g.beginPath(); loopPath(g, own(t)); g.clip('evenodd');
    g.fillStyle = rgba(col, 1); g.fillRect(t.x - RADIUS * 2, t.y - RADIUS * 2, RADIUS * 4, RADIUS * 4);
    g.restore();
  }
  // 3. the body as one water: its tiles' own pools (each baked tile darkens toward its middle) under one even sheet of
  // the water's colour, deeper away from the coast
  {
    const wet = here.find(x => x.name === 'water') ?? null, col = wet ? colourAt(wet.q, wet.r) : null;
    if (col) {
      g.save(); g.beginPath(); loopPath(g, all); g.clip('evenodd');
      g.fillStyle = rgba(col, 0.5); g.fillRect(-1e5, -1e5, 2e5, 2e5);
      g.restore();
    }
  }
  // 4. the coast: wet sand on the land's side, shallows on the water's, a line of foam on it
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.save(); g.beginPath(); g.rect(-1e5, -1e5, 2e5, 2e5); loopPath(g, all); g.clip('evenodd');
  g.beginPath(); loopPath(g, all); g.strokeStyle = 'rgba(118,92,52,.32)'; g.lineWidth = SHORE.sand * 2; g.stroke();
  g.beginPath(); loopPath(g, all); g.strokeStyle = 'rgba(226,206,150,.42)'; g.lineWidth = SHORE.sand * 0.8; g.stroke();
  g.restore();
  g.save(); g.beginPath(); loopPath(g, all); g.clip('evenodd');
  g.beginPath(); loopPath(g, all); g.strokeStyle = 'rgba(178,222,214,.34)'; g.lineWidth = SHORE.shallows * 2; g.stroke();
  g.beginPath(); loopPath(g, all); g.strokeStyle = 'rgba(206,236,228,.32)'; g.lineWidth = SHORE.shallows * 0.7; g.stroke();
  g.restore();
  g.beginPath(); loopPath(g, all); g.strokeStyle = 'rgba(252,252,244,.62)'; g.lineWidth = SHORE.foam; g.setLineDash?.([14, 5, 6, 4]); g.stroke(); g.setLineDash?.([]);
  g.restore();
  return true;
}
