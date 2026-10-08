// Your land in your colour (UX brief §5.1, §5.3).
//
// The tiles the viewer's own village works are filled with the nation's colour
// (strongest along the rim, fading inward so the village itself stays clear)
// and outlined with three strokes: dark ink, the nation's colour, and a gold
// line that breathes slowly. Gold is the viewer's mark and nothing else: a
// nation-mate's land keeps the quiet nation wash, another nation's is quieter
// still (map/sprites.mjs). A provisional village has a dashed rim and its tag.
// A standard stands on the village at every zoom (a pole, a swallow-tail
// pennon in the nation's colour with its sigil, a gold finial), and from afar
// it is a gold beacon with the village's name.
//
// The landing (the first time the village exists on this device): the colour
// floods outward ring by ring, the border draws on, the standard drops in
// with dust. One timeline (`landingAt`), read on the effects clock
// (chart.mjs fxNow), so the effects engine can freeze or step it.
//
// Pure parts first (the land of a village, its outline as closed loops, the
// timeline); the painters after them are context-tolerant (tests draw into
// recorders and proxies).
import { FLATTEN, RADIUS, hexPoints, project } from '../../map.mjs';
import { L } from '../../lang.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { SIGILS } from './layers.mjs';
import { WORKED_RADIUS } from './survey.mjs';
import { YOU, fxNow } from './chart.mjs';
import { upright } from './tilt.mjs';

/** The fill of the viewer's own land: its strength at the rim and in the middle (the rim is the brief's 0.38). */
export const OWN_FILL = Object.freeze({ rim: 0.38, middle: 0.2 });
/** How far the ground under the viewer's land takes the nation's hue before the wash (0 = not at all). */
export const TINT = 0.55;
/** The breathing of the gold line: one breath in this many seconds. */
export const BREATH_SECS = 3.6;
/** Dark inks of the six nations (under the colour, on the pennon's hem). */
const NATION_INK = Object.freeze(['#6a221e', '#154a44', '#6b4c10', '#3d2d62', '#1c3b66', '#5c2440']);
const INK = 'rgba(14,22,20,';
const IVORY = '#fff6e2';

// ------------------------------------------------------------------ the land of a village (pure)
/** The neighbour across the edge between corners k−1 and k of hexPoints. */
const EDGE_OF = [[1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1]];
const hk = (q, r) => `${q},${r}`;

/**
 * The tiles a village at hex (q, r) of `tier` works: `[{q, r, d}]`, d the
 * distance from the village. `accept(q, r, d)` leaves a tile out (water, a
 * tile a nearer village claims); the village's own tile is always in.
 */
export function landTiles({ q, r, tier = 0 }, accept = () => true) {
  const rad = WORKED_RADIUS[tier] ?? WORKED_RADIUS[0];
  const out = [];
  for (let dq = -rad; dq <= rad; dq++) for (let dr = Math.max(-rad, -dq - rad); dr <= Math.min(rad, -dq + rad); dr++) {
    const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
    if (d === 0 || accept(q + dq, r + dr, d)) out.push({ q: q + dq, r: r + dr, d });
  }
  return out;
}

/**
 * The shape of a set of tiles: `{tiles, maxD, rings: [[{q, r}]] by distance,
 * loops: [[[x, y], …]] (the outline as closed loops of hex corners, world
 * px, clockwise on screen; a hole is a loop of its own), centre {x, y},
 * key}`.
 */
export function landShape(tiles) {
  const set = new Set(tiles.map(t => hk(t.q, t.r)));
  const rings = [];
  let maxD = 0;
  for (const t of tiles) { (rings[t.d] ??= []).push({ q: t.q, r: t.r }); if (t.d > maxD) maxD = t.d; }
  for (let d = 0; d <= maxD; d++) rings[d] ??= [];
  // every edge with no tile of the set across it, from corner to corner the same way round
  const ck = ([x, y]) => `${Math.round(x * 8)},${Math.round(y * 8)}`;
  const next = new Map();
  for (const t of tiles) {
    const c = project(t.q, t.r), pts = hexPoints(c.x, c.y, 0);
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = EDGE_OF[k];
      if (set.has(hk(t.q + dq, t.r + dr))) continue;
      const a = pts[(k + 5) % 6], b = pts[k];
      next.set(ck(a), { a, b });
    }
  }
  const loops = [];
  while (next.size) {
    const [start, first] = next.entries().next().value;
    const loop = [first.a];
    let e = first;
    next.delete(start);
    for (let guard = 0; guard < 4096; guard++) {
      const key = ck(e.b);
      if (key === start) break;
      const n = next.get(key);
      if (!n) break;
      loop.push(n.a);
      next.delete(key);
      e = n;
    }
    loops.push(loop);
  }
  const home = tiles.find(t => t.d === 0) ?? tiles[0] ?? { q: 0, r: 0 };
  return { tiles, maxD, rings, loops, centre: project(home.q, home.r), key: tiles.map(t => `${t.q},${t.r},${t.d}`).join(';') };
}

/** The key of a village: `"P,Q,tile"`. */
export const villageKey = v => `${v.p},${v.q},${v.tile}`;

// ------------------------------------------------------------------ the landing's timeline (pure)
/** The landing, in ms from its start. */
export const LANDING = Object.freeze({ floodAt: 120, ring: 90, ringFade: 260, flash: 420, borderGap: 200, border: 360, standardGap: 240, drop: 420, impact: 0.7, dust: 900 });
const clamp01 = x => Math.max(0, Math.min(1, x));
const outCubic = k => 1 - Math.pow(1 - clamp01(k), 3);
/** A fall that lands at `impact` of its length and settles with one small rebound. */
export function dropCurve(k, impact = LANDING.impact) {
  const x = clamp01(k);
  if (x < impact) { const u = x / impact; return 1 - u * u; }   // 1 (up) → 0 (on the ground), accelerating
  const u = (x - impact) / (1 - impact);
  return 0.07 * Math.sin(u * Math.PI) * (1 - u);                // a short rebound
}

/** How long a landing over rings 0..maxD lasts (ms). */
export const landingMs = maxD => LANDING.floodAt + maxD * LANDING.ring + LANDING.borderGap + LANDING.standardGap + LANDING.drop + LANDING.dust;

/**
 * Where the landing is `t` ms after it began, for a land of rings 0..maxD:
 * `{ring(d) → {fill 0..1, flash 0..1}, border 0..1, standard: {shown, lift
 * (1 high up … 0 on the ground), alpha}, dust 0..1 | null, done}`.
 */
export function landingAt(t, maxD = 1) {
  const T = LANDING;
  const ring = d => { const u = (t - T.floodAt - d * T.ring) / T.ringFade; return { fill: outCubic(u), flash: u <= 0 ? 0 : Math.max(0, 1 - (t - T.floodAt - d * T.ring) / T.flash) }; };
  const borderAt = T.floodAt + maxD * T.ring + T.borderGap, standardAt = borderAt + T.standardGap;
  const k = (t - standardAt) / T.drop;
  const impactAt = standardAt + T.drop * T.impact;
  const dust = t >= impactAt && t < impactAt + T.dust ? (t - impactAt) / T.dust : null;
  return { ring, border: clamp01((t - borderAt) / T.border), standard: { shown: k > 0, lift: k >= 1 ? 0 : dropCurve(k), alpha: clamp01(k * 6) }, dust, done: t >= landingMs(maxD) };
}

// ------------------------------------------------------------------ paths
const pathCache = new Map();
/** The paths of a shape (made once): `{fill, ring: [Path2D], edge}`; null without Path2D. */
function pathsOf(shape) {
  if (typeof Path2D === 'undefined' || !shape) return null;
  const hit = pathCache.get(shape.key);
  if (hit) return hit;
  const hexInto = (path, { q, r }) => { const c = project(q, r); hexPoints(c.x, c.y, 0).forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath(); };
  const fill = new Path2D(), ring = shape.rings.map(list => { const p = new Path2D(); for (const t of list) hexInto(p, t); return p; });
  for (const t of shape.tiles) hexInto(fill, t);
  const edge = new Path2D();
  for (const loop of shape.loops) { loop.forEach(([x, y], i) => (i ? edge.lineTo(x, y) : edge.moveTo(x, y))); edge.closePath(); }
  const v = { fill, ring, edge };
  if (pathCache.size > 48) pathCache.clear();
  pathCache.set(shape.key, v);
  return v;
}

/** Line widths follow the zoom a little: thin lines from afar, never hairlines; a touch heavier close up. */
const lineScale = zoom => (0.72 + 0.28 * Math.min(1.8, Math.max(0.3, zoom))) * Math.min(1, 0.45 + zoom * 1.6) / zoom;

// ------------------------------------------------------------------ the land
/**
 * The viewer's land on the ground (under what stands on it): the fill and
 * the three-stroke border. `land` = `{shape, provisional}`; `flood` the
 * landing's state (landingAt) while it plays, else null; `still`: no breath.
 */
export function paintOwnLand(g, land, { zoom = 1, faction = 0, now = fxNow(), still = false, flood = null, far = false, base = false } = {}) {
  const P = pathsOf(land?.shape);
  if (!P || !g?.save) return;
  const col = FACTION_COLORS[faction] ?? YOU, ink = NATION_INK[faction] ?? '#3a3a34';
  const k = lineScale(zoom);
  // (`base`: the picture without its breath, for a layer that is kept; paintOwnBreath lays the breath over it)
  const breath = base ? 0 : still ? 0.6 : breathAt(now);
  const shown = flood ? flood.border : 1;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  // ---- the fill
  if (flood) {
    land.shape.rings.forEach((_, d) => {
      const s = flood.ring(d);
      if (s.fill <= 0) return;
      if (TINT > 0) { g.globalCompositeOperation = 'color'; g.globalAlpha = TINT * s.fill; g.fillStyle = col; g.fill(P.ring[d]); g.globalCompositeOperation = 'source-over'; }
      g.globalAlpha = OWN_FILL.middle * s.fill; g.fillStyle = col; g.fill(P.ring[d]);
      // the flood's front: a breath of warm light that runs ahead of the colour
      if (s.flash > 0) { g.globalAlpha = 0.5 * s.flash; g.fillStyle = '#fff1c8'; g.fill(P.ring[d]); }
    });
  } else {
    // the ground takes the nation's hue (its own light and shade stay), then the wash over it
    if (TINT > 0) { g.globalCompositeOperation = 'color'; g.globalAlpha = TINT; g.fillStyle = col; g.fill(P.fill); g.globalCompositeOperation = 'source-over'; }
    g.globalAlpha = OWN_FILL.middle; g.fillStyle = col; g.fill(P.fill);
  }
  if (shown > 0 && RADIUS * zoom > 9) {
    // stronger toward the rim: bands along the outline, kept inside the land
    g.save();
    g.clip(P.fill);
    g.strokeStyle = col;
    for (const [w, a] of [[1.9, 0.1], [1.05, 0.1], [0.44, 0.07]]) { g.globalAlpha = a * shown; g.lineWidth = RADIUS * w; g.stroke(P.edge); }
    g.restore();
  }
  // ---- the border: a glow of gold, dark ink, the nation's colour, the gold line
  if (shown > 0) {
    const dash = land.provisional ? [9 * k, 7 * k] : [];
    g.setLineDash([]);
    g.globalAlpha = (0.12 + 0.2 * breath) * shown; g.strokeStyle = YOU; g.lineWidth = 12 * k; g.stroke(P.edge);
    g.globalAlpha = 0.86 * shown; g.strokeStyle = `${INK}1)`; g.lineWidth = 7.4 * k; g.stroke(P.edge);
    g.globalAlpha = shown; g.strokeStyle = far ? col : ink; g.lineWidth = 5.4 * k; g.stroke(P.edge);
    g.strokeStyle = col; g.lineWidth = 4.4 * k; g.stroke(P.edge);
    // (a provisional village: the gold line is dashed)
    g.setLineDash(dash);
    g.globalAlpha = (0.78 + 0.22 * breath) * shown; g.strokeStyle = YOU; g.lineWidth = 2 * k; g.stroke(P.edge);
    g.setLineDash([]);
  }
  g.restore();
}

const breathAt = now => 0.5 + 0.5 * Math.sin((now / 1000) * (2 * Math.PI / BREATH_SECS));
/** The breath of the gold line alone, over a land painted with `base` (two strokes: what a resting frame costs). */
export function paintOwnBreath(g, land, { zoom = 1, now = fxNow() } = {}) {
  const P = pathsOf(land?.shape);
  if (!P || !g?.save) return;
  const k = lineScale(zoom), breath = breathAt(now);
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeStyle = YOU;
  g.globalAlpha = 0.2 * breath; g.lineWidth = 12 * k; g.stroke(P.edge);
  g.setLineDash(land.provisional ? [9 * k, 7 * k] : []);
  g.globalAlpha = 0.5 * breath; g.lineWidth = 2 * k; g.stroke(P.edge);
  g.setLineDash([]);
  g.restore();
}

/** The same outline once more, thin, over what stands on the land (a wood or a peak never breaks it). */
export function paintOwnOutline(g, land, { zoom = 1, shown = 1 } = {}) {
  const P = pathsOf(land?.shape);
  if (!P || !g?.save || !(shown > 0)) return;
  const k = lineScale(zoom);
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.setLineDash(land.provisional ? [10 * k, 7 * k] : []);
  g.globalAlpha = 0.42 * shown; g.strokeStyle = YOU; g.lineWidth = 1.2 * k; g.stroke(P.edge);
  g.setLineDash([]);
  g.restore();
}

/** The word under a provisional village's land (the brief's tag). */
export function paintProvisionalTag(g, land, { zoom = 1 } = {}) {
  if (!land?.provisional || !g?.save || RADIUS * zoom < 14) return;
  const k = 1 / zoom, c = land.shape.centre, text = L`仮`;
  g.save();
  g.font = `700 ${12 * k}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  // on the lower edge of the land, clear of the village's name
  const tw = (g.measureText?.(text)?.width ?? 12 * k) + 14 * k, th = 18 * k, ty = c.y + (land.shape.maxD * 1.5 + 1) * RADIUS * FLATTEN;
  upright(g, c.x, ty, () => {
    g.fillStyle = `${INK}.92)`; g.beginPath(); g.roundRect?.(c.x - tw / 2, ty - th / 2, tw, th, 9 * k); g.fill();
    g.strokeStyle = YOU; g.lineWidth = 1.2 * k; g.stroke();
    g.fillStyle = YOU; g.fillText(text, c.x, ty + 0.5 * k);
  });
  g.restore();
}

// ------------------------------------------------------------------ the standard
/** Where the standard stands on its village's tile (world px from the tile's centre): behind the houses, to the right. */
export const STANDARD_AT = Object.freeze({ x: RADIUS * 0.84, y: -RADIUS * 0.32 });
/** The standard's height unit (world px) at `zoom`: a part of the board close up, never smaller than a small flag on screen. */
export const STANDARD_UNIT = RADIUS * 1.15;
export const standardUnit = zoom => Math.max(STANDARD_UNIT, 24 / zoom);

function sigilPath(g, shape, x, y, r) {
  const pts = n => Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [x + Math.cos(a) * r, y + Math.sin(a) * r]; });
  g.beginPath();
  if (shape === 'circle' || shape === 'ring') g.arc(x, y, r * 0.86, 0, Math.PI * 2);
  else if (shape === 'cross') {
    const w = r * 0.36;
    [[-w, -r], [w, -r], [w, -w], [r, -w], [r, w], [w, w], [w, r], [-w, r], [-w, w], [-r, w], [-r, -w], [-w, -w]].forEach(([px, py], i) => (i ? g.lineTo(x + px, y + py) : g.moveTo(x + px, y + py)));
    g.closePath();
  } else {
    const c = shape === 'triangle' ? pts(3) : shape === 'square' ? pts(4).map(([px, py]) => [x + ((px - x) - (py - y)) * 0.62, y + ((py - y) + (px - x)) * 0.62]) : shape === 'diamond' ? pts(4) : pts(6);
    c.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.closePath();
  }
}

/**
 * The standard at world point (x, y) (its foot): a pole with a gold finial
 * and a swallow-tail pennon in the nation's colour carrying the sigil,
 * moving gently. `u` its height unit (standardUnit); `lift` 0 on the ground …
 * 1 high above it (the drop of the landing); `dust` 0..1 the dust of its
 * landing, or null.
 */
export function paintStandard(g, x, y, { u = RADIUS, zoom = 1, faction = 0, now = fxNow(), still = false, lift = 0, alpha = 1, dust = null } = {}) {
  if (!g?.save || !(alpha > 0)) return;
  const col = FACTION_COLORS[faction] ?? YOU, dark = NATION_INK[faction] ?? '#3a3a34';
  const lw = Math.max(1 / zoom, u * 0.028);
  const t = still ? 0.8 : now / 1000;
  const H = u * 1.5, up = lift * u * 2.6;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  // the dust of the landing: low puffs rolling out along the ground
  if (dust !== null && dust >= 0 && dust < 1) {
    const e = 1 - Math.pow(1 - dust, 2);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4, dx = Math.cos(a) * u * (0.14 + 0.62 * e), dy = Math.sin(a) * u * (0.14 + 0.62 * e) * FLATTEN * 0.8 - u * 0.1 * e * (i % 2);
      g.globalAlpha = 0.62 * Math.pow(1 - dust, 0.7) * alpha; g.fillStyle = i % 2 ? '#f4ead0' : '#dccca4';
      g.beginPath(); g.ellipse?.(x + dx, y + dy, u * (0.12 + 0.2 * e), u * (0.08 + 0.12 * e), 0, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 0.8 * (1 - dust) * alpha; g.strokeStyle = YOU; g.lineWidth = lw * 1.6;
    g.beginPath(); g.ellipse?.(x, y, u * (0.2 + 0.9 * e), u * (0.2 + 0.9 * e) * FLATTEN, 0, 0, Math.PI * 2); g.stroke();
  }
  // its shadow and the foot's ring on the ground
  g.globalAlpha = 0.34 * alpha * (1 - 0.6 * lift); g.fillStyle = '#0c1210';
  g.beginPath(); g.ellipse?.(x + u * 0.16, y + u * 0.03, u * 0.3, u * 0.1, 0, 0, Math.PI * 2); g.fill();
  g.globalAlpha = alpha;
  g.translate(0, -up);
  // the pole
  g.strokeStyle = '#161d1a'; g.lineWidth = u * 0.085; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - H); g.stroke();
  g.strokeStyle = '#b08a3c'; g.lineWidth = u * 0.04; g.beginPath(); g.moveTo(x, y - u * 0.02); g.lineTo(x, y - H + u * 0.02); g.stroke();
  // the pennon: a swallow tail flying from the pole's head
  const top = y - H + u * 0.1, bot = top + u * 0.46, len = u * 0.98, notch = 0.7;
  const wave = xr => Math.sin(t * 2.3 - xr * 5.4) * u * 0.05 * xr + Math.sin(t * 1.1 - xr * 2.2) * u * 0.02 * xr;
  const N = 8, upper = [], lower = [];
  for (let i = 0; i <= N; i++) { const xr = i / N; upper.push([x + xr * len, top + xr * u * 0.05 + wave(xr)]); lower.push([x + xr * len, bot - xr * u * 0.07 + wave(xr)]); }
  const mid = [x + notch * len, (top + bot) / 2 + wave(notch)];
  const cloth = () => { g.beginPath(); upper.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.lineTo(mid[0], mid[1]); for (let i = N; i >= 0; i--) g.lineTo(lower[i][0], lower[i][1]); g.closePath(); };
  cloth(); g.fillStyle = col; g.fill();
  // the folds: light along the upper edge, shade in the trough of the wave
  g.save(); cloth(); g.clip?.();
  g.globalAlpha = 0.22 * alpha; g.strokeStyle = '#fff6e2'; g.lineWidth = u * 0.09; g.beginPath(); upper.forEach(([px, py], i) => (i ? g.lineTo(px, py + u * 0.04) : g.moveTo(px, py + u * 0.04))); g.stroke();
  g.globalAlpha = 0.26 * alpha; g.strokeStyle = dark; g.lineWidth = u * 0.1; g.beginPath(); lower.forEach(([px, py], i) => (i ? g.lineTo(px, py - u * 0.03) : g.moveTo(px, py - u * 0.03))); g.stroke();
  g.restore();
  g.globalAlpha = alpha;
  cloth(); g.strokeStyle = '#161d1a'; g.lineWidth = lw; g.stroke();
  // the sigil, in ivory with its ink outline (a nation is never told by its colour alone)
  const sx = x + len * 0.3, sy = (top + bot) / 2 - u * 0.005 + wave(0.3), sr = u * 0.135;
  sigilPath(g, SIGILS[faction] ?? 'ring', sx, sy, sr);
  if ((SIGILS[faction] ?? 'ring') === 'ring') { g.strokeStyle = IVORY; g.lineWidth = lw * 2.2; g.stroke(); }
  else { g.fillStyle = IVORY; g.fill(); g.strokeStyle = dark; g.lineWidth = lw * 0.9; g.stroke(); }
  // the finial: a gold lozenge with its glint
  const fy = y - H - u * 0.07, fr = u * 0.1;
  g.beginPath(); g.moveTo(x, fy - fr * 1.25); g.lineTo(x + fr * 0.8, fy); g.lineTo(x, fy + fr * 1.05); g.lineTo(x - fr * 0.8, fy); g.closePath();
  g.fillStyle = YOU; g.fill(); g.strokeStyle = '#161d1a'; g.lineWidth = lw; g.stroke();
  g.fillStyle = '#fffbe9'; g.beginPath(); g.arc(x - fr * 0.2, fy - fr * 0.3, fr * 0.2, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ the beacon (the far view)
/**
 * The viewer's village from afar: a gold pip that breathes, ringed in ink.
 * Returns the label's anchor (the name goes under it: map/labels.mjs lays the
 * far view's names out together).
 */
export function paintBeacon(g, x, y, { zoom = 1, now = fxNow(), still = false, active = true } = {}) {
  if (!g?.save) return;
  const k = 1 / zoom, breath = still ? 0.5 : 0.5 + 0.5 * Math.sin((now / 1000) * (2 * Math.PI / (BREATH_SECS * 0.6)));
  const r = (active ? 5 : 4) * k;
  g.save();
  // the light it gives: two rings, the outer one opening and fading
  g.strokeStyle = YOU; g.lineWidth = 1.4 * k;
  g.globalAlpha = 0.55 * (1 - breath); g.beginPath(); g.arc(x, y, r + (5 + 9 * breath) * k, 0, Math.PI * 2); g.stroke();
  g.globalAlpha = 0.24; g.fillStyle = YOU; g.beginPath(); g.arc(x, y, r + 5 * k, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 1;
  g.fillStyle = '#131b18'; g.beginPath(); g.arc(x, y, r + 2.1 * k, 0, Math.PI * 2); g.fill();
  g.fillStyle = YOU; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fffbe9'; g.beginPath(); g.arc(x - r * 0.3, y - r * 0.32, r * 0.3, 0, Math.PI * 2); g.fill();
  g.restore();
}
