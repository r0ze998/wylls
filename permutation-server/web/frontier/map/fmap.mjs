// FrontierMap: the ring/province map (web design §7.3). Levels of detail
// with hysteresis (world → province → tile), culling to the provinces in
// view, presentation-only fog with a "show everything" switch (I-35),
// selection by click/tap or keyboard, drag and wheel/pinch zoom, and a
// redraw only when something changed. Tile LOD draws terrain from the WASM
// kernel when the caller has it; every other level works without it. The
// pure parts (LOD, projection, culling, picking) are exported and tested
// (web-frontier-map.test.mjs); the class only wires them to a canvas.
//
// W5-E (web design §10): zoom in, zoom out and "my holding" buttons stay
// visible at every width (a group after the canvas, 44-px targets, names in
// the current language); the canvas carries `data-lod` and, at tile LOD,
// `data-terrain` (ready | pending) for the smoke tests; the terrain comes
// from the rules module lazily (terrain.mjs) when the caller gives none;
// only provinces the viewer knows or sees are drawn as tiles, with the fog
// veil over them; H goes to the viewer's first holding.
//
// The camera (UX brief §4, map/camera.mjs): `view` is the logical view and
// changes at once; the picture travels toward it (fly, eased zoom, the glide
// after a drag) and jumps under reduced motion. The opening view depends on
// who is looking (map/opening.mjs) and never overrides a camera a person
// moved. M and the "world chart" button go to the far view and back. Depth
// without a tilt: a horizon haze and a vignette in screen space
// (map/dressing.mjs); a change of level of detail dissolves instead of
// popping. At rest only the animated layers repaint on the timer: the still
// ground and props wait in two bitmaps (map/sprites.mjs paints the parts).
import { paintPins } from '../hud/pins.mjs';
import { paintReach } from '../hud/reach.mjs';
import { inverseHex } from '../../map.mjs';
import { L, onLangChange } from '../../lang.mjs';
import { locate, ringOf, ringProvinces, hexDistance, tileHex } from '../fgeo.mjs';
import { fogLevel, paintProvince, paintTiles, paintVeil, provincePixel, PROVINCE_CIRCUMRADIUS } from './layers.mjs';
import { createTerrain } from './terrain.mjs';
import { SpriteArt, terrainLookup } from './sprites.mjs';
import { project, RADIUS } from '../../map.mjs';
import { Camera, EASE, MOVE_MS, centreOn, clampCentre, fitView, focusOf, reducedMotion } from './camera.mjs';
import { OPEN_FROM, OPEN_WAIT_MS, TITLE_FROM, TITLE_MS, heroZoom, openingPlan, placePoint } from './opening.mjs';
import { nearness, paintDressing } from './dressing.mjs';
import { PROBE } from './probe.mjs';

/** Fog levels drawn as tiles at tile LOD (a distant province stays a muted cell). */
export const TILE_FOGS = Object.freeze(['sight', 'known', 'clear']);
/**
 * The map buttons: `[{id, glyph, icon, label()}]`. `icon` is the path of a drawn
 * icon on a 24-px grid (round 1.75-px strokes); `glyph` (ASCII or a symbol,
 * never text to translate) stands in where no SVG can be made.
 */
export const MAP_TOOLS = Object.freeze([
  { id: 'in', glyph: '+', icon: 'M12 5.5v13M5.5 12h13', label: () => L`地図を拡大` },
  { id: 'out', glyph: '\u2212', icon: 'M5.5 12h13', label: () => L`地図を縮小` },
  { id: 'home', glyph: '\u2302', icon: 'M4 11.5 12 4.5l8 7M6.5 9.8v9.7h11V9.8M10 19.5v-5h4v5', label: () => L`自分の村へ移動` },
  // the far view and back (M): a folded chart
  { id: 'chart', glyph: '\u25CE', icon: 'M3.5 6.5 9 4.5l6 2 5.5-2v13L15 19.5l-6-2-5.5 2zM9 4.5v13M15 6.5v13', label: () => L`全体図を見る`, labelOn: () => L`もとの場所へ戻る` },
]);

/** Zoom thresholds (screen px per world px) with hysteresis between levels. */
export const LOD_EDGES = Object.freeze({ provinceIn: 0.14, provinceOut: 0.12, tileIn: 0.5, tileOut: 0.45 });
/** The absolute zoom limits. The map itself never goes further out than a little past the far view (zoomMin). */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 2.2;
/** Home's zoom on a dpr-1 screen (opening.mjs heroZoom): tile detail, the holding and the hosts beside it in view. */
export const HOME_ZOOM = 1.3;
/** The far view never leaves the world level of detail. */
export const FAR_ZOOM_CAP = LOD_EDGES.provinceOut * 0.95;
/** A change of level of detail dissolves over this long (ms), after waiting at most LOD_HOLD_MS for the new level's art. */
export const LOD_FADE_MS = 280;
export const LOD_HOLD_MS = 700;
/** The opening fades in from the bare table over this long (ms). */
export const REVEAL_MS = 520;
/** The dissolve's still is gone once the zoom has travelled this far from it (natural log of the zoom ratio). */
export const LOD_FADE_DRIFT = 0.32;
/** The table under the world (the vignette of dressing.mjs darkens it toward the edges). */
export const TABLE = '#2a4742';
/**
 * Bitmaps the size of the canvas (the two still layers, the dressing) are kept only up to this many
 * pixels each (about 36 MB): a larger canvas is painted whole every frame, as before.
 */
export const STILL_MAX_PIXELS = 9_000_000;
/** The still layers of a resting view are repainted at least this often (ms): a change nobody announced heals. */
export const LAYER_MAX_AGE_MS = 2000;

/** The level of detail at `zoom`, given the current one (no flicker at an edge). */
export function lodFor(zoom, current = 'world') {
  const e = LOD_EDGES;
  if (current === 'world') return zoom >= e.tileIn ? 'tile' : zoom >= e.provinceIn ? 'province' : 'world';
  if (current === 'province') return zoom >= e.tileIn ? 'tile' : zoom < e.provinceOut ? 'world' : 'province';
  return zoom < e.provinceOut ? 'world' : zoom < e.tileOut ? 'province' : 'tile';
}

/** view = {x, y (world px at the screen centre), zoom}. */
export const worldToScreen = (view, size, x, y) => ({ x: (x - view.x) * view.zoom + size.width / 2, y: (y - view.y) * view.zoom + size.height / 2 });
export const screenToWorld = (view, size, sx, sy) => ({ x: (sx - size.width / 2) / view.zoom + view.x, y: (sy - size.height / 2) / view.zoom + view.y });

/** The provinces of rings 0..maxRing whose cell intersects the viewport, nearest the centre first. */
export function visibleProvinces(view, size, maxRing) {
  const a = screenToWorld(view, size, 0, 0), b = screenToWorld(view, size, size.width, size.height);
  const m = PROVINCE_CIRCUMRADIUS;
  const out = [];
  for (let d = 0; d <= maxRing; d++) {
    for (const pr of ringProvinces(d)) {
      const c = provincePixel(pr.p, pr.q);
      if (c.x >= a.x - m && c.x <= b.x + m && c.y >= a.y - m && c.y <= b.y + m) out.push({ ...pr, dist: Math.hypot(c.x - view.x, c.y - view.y) });
    }
  }
  return out.sort((x, y) => x.dist - y.dist).map(({ p, q }) => ({ p, q }));
}

/** The tile and province under a screen point: {tileQ, tileR, p, q, idx}. */
export function pick(view, size, sx, sy) {
  const w = screenToWorld(view, size, sx, sy);
  const [tq, tr] = inverseHex(w.x, w.y).split(',').map(Number);
  const l = locate(tq, tr);
  return { tileQ: tq, tileR: tr, p: l.p, q: l.q, idx: l.idx };
}

/** Clamp a zoom and keep the world point under (sx, sy) fixed. */
export function zoomAround(view, size, factor, sx, sy) {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * factor));
  const before = screenToWorld(view, size, sx, sy);
  const next = { ...view, zoom };
  const after = screenToWorld(next, size, sx, sy);
  return { ...next, x: view.x + before.x - after.x, y: view.y + before.y - after.y };
}

/** The distance in provinces from (p, q) to the nearest of `anchors` (the viewer's holdings and hosts). */
export const sightDistance = (p, q, anchors) => anchors.reduce((m, a) => Math.min(m, hexDistance(p, q, a.p, a.q)), Infinity);

/**
 * What the page's panel covers of the canvas (CSS px): `{top, right, bottom, left}`.
 * `#panel` laid over the map as a bottom sheet (a phone) covers it from
 * below; as a drawer over the map's side it covers that side. A panel beside
 * the map covers nothing.
 */
export function coveredInsets(canvas) {
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  const panel = canvas?.ownerDocument?.getElementById?.('panel');
  const view = canvas?.ownerDocument?.defaultView;
  if (!panel || !view || !canvas.getBoundingClientRect) return none;
  const pos = view.getComputedStyle(panel).position;
  if (pos !== 'absolute' && pos !== 'fixed') return none;
  const c = canvas.getBoundingClientRect(), p = panel.getBoundingClientRect();
  const w = Math.max(0, Math.min(c.right, p.right) - Math.max(c.left, p.left)), h = Math.max(0, Math.min(c.bottom, p.bottom) - Math.max(c.top, p.top));
  if (!(w > 0) || !(h > 0)) return none;
  if (w >= c.width * 0.8) return { ...none, bottom: p.bottom >= c.bottom - 1 ? h : 0 };
  if (h >= c.height * 0.6) return p.right >= c.right - 1 ? { ...none, right: w } : p.left <= c.left + 1 ? { ...none, left: w } : none;
  return none;
}
/** Height (CSS px) of the canvas covered from below by the page's bottom sheet (`#panel` laid over the map), else 0. */
export const coveredBelow = canvas => coveredInsets(canvas).bottom;

/** How long a flight between two views takes (ms): longer for a longer trip, never slow. */
export function flightMs(from, to, size) {
  const z = Math.min(from.zoom, to.zoom);
  const screens = Math.hypot(to.x - from.x, to.y - from.y) * z / Math.max(1, Math.min(size.width, size.height));
  const octaves = Math.abs(Math.log2(to.zoom / from.zoom));
  return Math.round(Math.max(420, Math.min(1200, 420 + 110 * Math.min(4, screens) + 150 * octaves)));
}

/**
 * The march being composed, for this browser only (the destination is
 * sealed for everyone else): a dashed line along the planned hexes and a
 * ringed marker on the destination tile. `route = {hexes: [{q, r}], dest: {q, r} | null}`.
 */
/**
 * The world view's labels, as a map has them: each faction's name over the
 * heart of its land (the weighted centre of the provinces it holds most of
 * in), and the Concord at the centre. Screen-sized type in the display face.
 */
export function paintRealmLabels(ctx, recs, zoom, nameOf = null) {
  const acc = Array.from({ length: 6 }, () => ({ x: 0, y: 0, w: 0 }));
  for (const r of recs.values()) {
    const n = Array(6).fill(0);
    r.owners.forEach((f, j) => { if (r.sites[j] === 1 && f < 6) n[f]++; });
    const best = n.indexOf(Math.max(...n));
    if (n[best] <= 0) continue;
    const c = provincePixel(r.p, r.q);
    acc[best].x += c.x * n[best]; acc[best].y += c.y * n[best]; acc[best].w += n[best];
  }
  const k = 1 / zoom;
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const face = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", Georgia, serif';
  const label = (text, x, y, size, fill) => {
    ctx.font = `700 ${size * k}px ${face}`;
    ctx.lineJoin = 'round'; ctx.lineWidth = 5 * k; ctx.strokeStyle = 'rgba(14,22,20,.78)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = fill; ctx.fillText(text, x, y);
  };
  acc.forEach((a, f) => {
    if (a.w < 3) return;
    const name = nameOf ? nameOf(f) : String(f);
    label(name, a.x / a.w, a.y / a.w, 22, '#fff6e2');
  });
  const c0 = provincePixel(0, 0);
  label(nameOf ? nameOf('concord') : 'Concord', c0.x, c0.y, 15, '#f3d58a');
  ctx.restore();
}

/**
 * Incoming risk (spec §7.3): a red halo that breathes around each of the
 * viewer's holdings an enemy may reach, with the earliest bell it could
 * arrive. `threats = [{p, q, tile, bell}]` (destinations are sealed: a
 * warning, never a certainty).
 */
export function paintThreats(ctx, threats, zoom, label = null) {
  const t = (globalThis.performance?.now?.() ?? Date.now()) / 1000;
  const k = 1 / zoom, pulse = 0.5 + 0.5 * Math.sin(t * 3);
  const seen = new Set();
  ctx.save();
  for (const w of threats) {
    const key = `${w.p},${w.q},${w.tile}`;
    if (seen.has(key) || !Number.isInteger(w.tile)) continue;
    seen.add(key);
    const h = tileHex(w.p, w.q, w.tile), c = project(h.q, h.r);
    const r = Math.max(RADIUS * 1.3, 18 * k) * (1 + pulse * 0.12);
    const g = ctx.createRadialGradient(c.x, c.y, r * 0.4, c.x, c.y, r);
    g.addColorStop(0, 'rgba(200,40,30,0)'); g.addColorStop(0.75, `rgba(200,40,30,${0.18 + pulse * 0.14})`); g.addColorStop(1, 'rgba(200,40,30,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `rgba(230,70,50,${0.6 + pulse * 0.4})`; ctx.lineWidth = 2.4 * k; ctx.setLineDash([6 * k, 4 * k]);
    ctx.beginPath(); ctx.arc(c.x, c.y, r * 0.78, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    if (label) {
      const text = label(w);
      ctx.font = `700 ${11 * k}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(text).width + 12 * k, th = 16 * k, y = c.y + r * 0.78 + 4 * k;
      ctx.fillStyle = 'rgba(120,20,12,.92)'; ctx.beginPath(); ctx.roundRect?.(c.x - tw / 2, y, tw, th, 8 * k); ctx.fill();
      ctx.fillStyle = '#fff2ee'; ctx.fillText(text, c.x, y + th / 2 + 0.5 * k);
    }
  }
  ctx.restore();
}

/**
 * The guide's target (hud/guide.mjs, UI plan G1): a gold ring that breathes
 * on the tile the current step is about, with a short label.
 */
export function paintGuide(ctx, g, zoom, label = '') {
  if (!g || !Number.isInteger(g.tile)) return;
  const t = (globalThis.performance?.now?.() ?? Date.now()) / 1000;
  const k = 1 / zoom, pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
  const h = tileHex(g.p, g.q, g.tile), c = project(h.q, h.r);
  const r = Math.max(RADIUS * 1.15, 20 * k) * (1 + pulse * 0.15);
  ctx.save();
  ctx.strokeStyle = 'rgba(16,24,22,.55)'; ctx.lineWidth = 6 * k; ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = `rgba(243,213,138,${0.7 + pulse * 0.3})`; ctx.lineWidth = 3 * k; ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
  // a pointer above the ring
  ctx.fillStyle = '#f3d58a'; ctx.beginPath(); const y = c.y - r - (6 + pulse * 4) * k; ctx.moveTo(c.x, y); ctx.lineTo(c.x - 7 * k, y - 11 * k); ctx.lineTo(c.x + 7 * k, y - 11 * k); ctx.closePath(); ctx.fill();
  if (label) {
    ctx.font = `700 ${11 * k}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 12 * k, th = 17 * k, ly = y - 13 * k - th;
    ctx.fillStyle = 'rgba(31,26,16,.94)'; ctx.beginPath(); ctx.roundRect?.(c.x - tw / 2, ly, tw, th, 8 * k); ctx.fill();
    ctx.fillStyle = '#f3d58a'; ctx.fillText(label, c.x, ly + th / 2 + 0.5 * k);
  }
  ctx.restore();
}

export function paintRoute(ctx, route, zoom) {
  const pts = (route.hexes ?? []).map(h => project(h.q, h.r));
  const k = 1 / zoom;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (pts.length > 1) {
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = 'rgba(16,24,22,.55)'; ctx.lineWidth = 7 * k; ctx.stroke();
    ctx.setLineDash([10 * k, 8 * k]); ctx.strokeStyle = '#f3d58a'; ctx.lineWidth = 3.5 * k; ctx.stroke();
    ctx.setLineDash([]);
  }
  if (route.dest) {
    const d = project(route.dest.q, route.dest.r);
    ctx.beginPath(); ctx.arc(d.x, d.y, 16 * k, 0, Math.PI * 2); ctx.fillStyle = 'rgba(243,213,138,.25)'; ctx.fill();
    ctx.lineWidth = 3 * k; ctx.strokeStyle = '#f3d58a'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(d.x - 7 * k, d.y); ctx.lineTo(d.x + 7 * k, d.y); ctx.moveTo(d.x, d.y - 7 * k); ctx.lineTo(d.x, d.y + 7 * k); ctx.strokeStyle = '#1b2e28'; ctx.lineWidth = 2.5 * k; ctx.stroke();
  }
  ctx.restore();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const clock = () => globalThis.performance?.now?.() ?? Date.now();
/** A canvas off the page (the still layers, the dissolve's snapshot), or null where there is none. */
function spareCanvas(doc, w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const cv = doc?.createElement?.('canvas');
  if (!cv) return null;
  cv.width = w; cv.height = h;
  return cv;
}
/** A map button's picture: the drawn icon, or its glyph. */
function toolIcon(doc, t) {
  if (t.icon && doc.createElementNS) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', t.icon);
    svg.append(path);
    return svg;
  }
  const g = doc.createElement('span');
  g.setAttribute('aria-hidden', 'true');
  g.textContent = t.glyph;
  return g;
}

export class FrontierMap {
  /**
   * `canvas`; `source()` → {overviews: Map ring→overview, ringsOpen,
   * own: [{p,q,tile}], known: Set "p,q", showAll, selected, terrainOf(p,q) →
   * {terrain, sites, names} | null, open: opening.mjs openHint};
   * `onSelect(hit)`; `onView(view, lod)` (the logical view).
   */
  constructor(canvas, { source, onSelect = () => {}, onView = () => {}, onHover = () => {}, art = false }) {
    this.canvas = canvas;
    this.source = source;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.onView = onView;
    this.cam = new Camera({ view: { x: 0, y: 0, zoom: 0.06 }, limit: (v, o) => this.limitView(v, o) });
    this.lod = lodFor(this.cam.view.zoom);
    /** The level of detail on screen (it follows the drawn view; `lod` follows the logical one). */
    this.drawnLod = this.lod;
    this.dirty = true;
    /** Counts everything that may have changed the still picture (data, art, language): the still layers follow it. */
    this.stamp = 0;
    this.drag = null;
    this.pointers = new Map();
    this.terrainOf = createTerrain({ onReady: () => this.invalidate() });
    // canvas text (name tags, tiers, construction labels, pills) is drawn in the page's language: redraw on a switch
    this.unredraw = onLangChange(() => this.invalidate());
    // Opt-in sprite art at tile LOD (map/sprites.mjs); the vector tiles stay the default.
    this.art = art ? new SpriteArt({ onLoad: () => this.invalidate(), onTick: () => this.tick() }) : null;
    this.mark();
    this.bind();
    this.mountTools();
    this.watchSize();
    this.frame = ts => {
      this.frameNo = (this.frameNo ?? 0) + 1;
      const now = ts ?? clock();
      if (this.cam.step(now)) this.dirty = true;
      if (this.dirty) this.draw(now);
      this.raf = globalThis.requestAnimationFrame?.(this.frame);
    };
    this.raf = globalThis.requestAnimationFrame?.(this.frame);
  }

  /** The logical view {x, y, zoom}: where the camera is going (picking by keyboard, the LOD and tests read this). */
  get view() { return this.cam.view; }
  /** The view on screen right now (it travels toward `view`): for things that should follow the picture, like a minimap frame. */
  get shown() { return this.cam.drawn; }
  size() { return { width: this.canvas.clientWidth, height: this.canvas.clientHeight }; }
  dpr() { return Math.min(globalThis.devicePixelRatio || 1, 2); }
  /** What the page's sheets cover of the canvas (read once a frame at most). */
  inset() {
    if (this.insetAt !== this.frameNo || !this.insetNow) { this.insetNow = coveredInsets(this.canvas); this.insetAt = this.frameNo; }
    return this.insetNow;
  }
  /** Something the still picture is made of changed: repaint everything. */
  invalidate() { this.stamp++; this.dirty = true; }
  /** An animation frame is due: the animated layers repaint (the still ones are kept while the view rests). */
  tick() { this.dirty = true; }
  /** Another frame in a moment (an animated overlay: the threat halo). */
  invalidateSoon(ms = 80) { if (this.soon) return; this.soon = setTimeout(() => { this.soon = null; this.tick(); }, ms); }

  /**
   * Place the camera: the logical view changes now; with `ms` the picture
   * travels there (see camera.mjs). A call from the page counts as a person
   * moving the camera (the opening view stops framing); `auto` does not.
   */
  setView(v, { auto = false, ...move } = {}) {
    if (!auto) this.cam.userMoved = true;
    this.cam.set(v, move);
    this.sync();
  }

  /** After the logical view changed: the LOD, the canvas marks, the buttons, the page. */
  sync() {
    this.lod = lodFor(this.cam.view.zoom, this.lod);
    this.dirty = true;
    this.mark();
    this.syncTools();
    this.onView(this.cam.view, this.lod);
  }

  /** The canvas's `data-lod` (and `data-terrain` once drawn at tile LOD). */
  mark(terrain) {
    const d = this.canvas.dataset;
    if (!d) return;
    if (d.lod !== this.lod) d.lod = this.lod;
    const t = this.lod === 'tile' ? terrain ?? d.terrain ?? 'pending' : 'none';
    if (d.terrain !== t) d.terrain = t;
  }

  /** The open rings, as the last frame knew them. */
  ringsNow() { return Math.max(1, this.rings ?? this.source?.()?.ringsOpen ?? 1); }
  /** The furthest the map zooms out: a little past the far view. */
  zoomMin(size = this.size()) {
    if (!(size.width > 0) || !(size.height > 0)) return ZOOM_MIN;
    return Math.max(ZOOM_MIN, fitView(this.ringsNow(), size, { cap: FAR_ZOOM_CAP, floor: ZOOM_MIN }).zoom * 0.8);
  }
  clampZoom(zoom, size = this.size()) { return Math.min(ZOOM_MAX, Math.max(this.zoomMin(size), zoom)); }
  /** The camera's limits: the zoom range always; the opened world plus a margin for a pan a person makes (`clamp`). */
  limitView(v, { clamp = false, soft = 0 } = {}) {
    const size = this.size();
    const zoom = this.clampZoom(v.zoom, size);
    const out = zoom === v.zoom ? v : { ...v, zoom };
    return clamp && size.width > 0 && size.height > 0 ? clampCentre(out, { ringsOpen: this.ringsNow(), size, soft }) : out;
  }

  /** Centre on a province (and zoom to its LOD); with `ms` the picture flies there. */
  focus(p, q, zoom = 0.2, ms = 0) { const c = provincePixel(p, q); this.setView({ x: c.x, y: c.y, zoom }, { ms, kind: 'fly' }); }

  /**
   * Fly to a place: `{p, q, tile?, zoom?}` or `{x, y, zoom?}` (world px). The
   * place lands in the middle of the part of the canvas no sheet covers
   * (`exact`: the canvas centre). `ms` null: by the length of the trip.
   */
  flyTo(target, ms = null, { auto = false, exact = false } = {}) {
    const size = this.size(), v = this.cam.view;
    const zoom = this.clampZoom(target.zoom ?? v.zoom, size);
    const pt = Number.isInteger(target.p) && Number.isInteger(target.q) ? placePoint(target) : { x: target.x ?? v.x, y: target.y ?? v.y };
    const to = exact || !(size.width > 0) ? { x: pt.x, y: pt.y, zoom } : centreOn(pt, zoom, size, this.inset());
    this.setView(to, { auto, ms: ms ?? flightMs(this.cam.drawn, to, size), kind: 'fly' });
  }

  /**
   * Home (the button, H): fly to the viewer's village, close up on its tile
   * (the hero zoom; a closer zoom is kept), above the sheet on a phone;
   * pressed again while on one, the next village (Civ's "next city").
   * Without a village: the opening view of this viewer.
   */
  home() {
    const src = this.source?.() ?? {}, size = this.size(), inset = this.inset();
    this.back = null;
    const own = (src.own ?? []).filter(o => Number.isInteger(o.p) && Number.isInteger(o.q));
    if (!own.length) {
      const plan = openingPlan({ ...(src.open ?? {}), ready: true }, src, size, { inset, dpr: this.dpr() });
      this.setView(plan.view, { ms: flightMs(this.cam.drawn, plan.view, size), kind: 'fly' });
      return;
    }
    const at = own.map(placePoint);
    const f = focusOf(this.cam.view, size, inset);
    const here = at.findIndex(c => Math.hypot(c.x - f.x, c.y - f.y) < RADIUS * 0.5);
    const c = at[here >= 0 ? (here + 1) % at.length : Math.min(at.length - 1, Math.max(0, src.open?.active ?? 0))];
    this.flyTo({ x: c.x, y: c.y, zoom: Math.max(this.cam.view.zoom, heroZoom(this.dpr())) });
  }

  /** The far view of this canvas: the opened world above the sheet, at world LOD. */
  farView(src = this.source?.(), size = this.size()) {
    return fitView(Math.max(1, src?.ringsOpen ?? 1), size, { inset: this.inset(), cap: FAR_ZOOM_CAP, floor: ZOOM_MIN });
  }

  /** Jump to the far view, unless a person already moved the camera. */
  fit(src, size) {
    if (this.cam.userMoved) return;
    this.setView(this.farView(src, size), { auto: true });
  }

  /** Whether the far view on screen was reached through the world chart (M) and remembers the way back. */
  chartOn() { return !!this.back && this.lod === 'world'; }

  /** The world chart (the button, M): fly out to the far view; again, fly back to where the camera was (from a world view reached another way: home). */
  worldChart() {
    const size = this.size();
    if (this.chartOn()) {
      const b = this.back;
      this.back = null;
      this.setView(b, { ms: flightMs(this.cam.drawn, b, size), kind: 'fly' });
      return;
    }
    // already looking at the world without a way back: the button leads home
    if (this.lod === 'world') { this.home(); return; }
    const far = this.farView();
    this.back = { ...this.cam.view };
    this.setView(far, { ms: Math.max(MOVE_MS.far, flightMs(this.cam.drawn, far, size)), kind: 'fly' });
  }

  /** Zoom by `factor` about the middle of the uncovered canvas (the buttons, + and −): eased. */
  zoomBy(factor, ms = MOVE_MS.zoom) {
    const s = this.size(), f = focusOf({ x: 0, y: 0, zoom: 1 }, s, this.inset());
    this.zoomAt(factor, s.width / 2 + f.x, s.height / 2 + f.y, { ms });
  }

  /** Zoom by `factor` keeping the world point under screen point (sx, sy); the picture eases there when `move.ms`. */
  zoomAt(factor, sx, sy, move = {}) {
    const s = this.size(), v = this.cam.view;
    const z = this.clampZoom(v.zoom * factor, s);
    this.setView(zoomAround(v, s, z / v.zoom, sx, sy), { clamp: true, ...move, anchor: { x: sx - s.width / 2, y: sy - s.height / 2 } });
  }

  /** The map buttons after the canvas (a DOM page only). */
  mountTools() {
    const c = this.canvas, doc = c.ownerDocument;
    if (!doc || !c.parentElement || c.parentElement.querySelector?.('.map-tools')) return;
    const box = doc.createElement('div');
    box.className = 'map-tools';
    box.setAttribute('role', 'group');
    const act = { in: () => this.zoomBy(1.25), out: () => this.zoomBy(0.8), home: () => this.home(), chart: () => this.worldChart() };
    const buttons = MAP_TOOLS.map(t => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'map-btn';
      b.dataset.map = t.id;
      b.append(toolIcon(doc, t));
      b.addEventListener('click', () => act[t.id]?.());
      box.append(b);
      return [b, t];
    });
    const label = () => {
      box.setAttribute('aria-label', L`地図の操作`);
      for (const [b, t] of buttons) {
        const on = t.id === 'chart' && this.chartOn();
        const x = on ? t.labelOn() : t.label();
        b.setAttribute('aria-label', x); b.title = x;
        if (t.id === 'chart') b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    };
    label();
    this.unlang = onLangChange(label);
    this.relabel = label;
    c.after(box);
    this.tools = box;
  }

  /** The world chart button says which way it goes. */
  syncTools() {
    const on = this.chartOn();
    if (on === this.toolsOn) return;
    this.toolsOn = on;
    this.relabel?.();
  }

  /** A resize of the canvas repaints (and the backing store follows in draw). */
  watchSize() {
    const c = this.canvas;
    if (typeof ResizeObserver !== 'undefined' && c?.nodeType === 1) {
      this.resizer = new ResizeObserver(() => this.invalidate());
      this.resizer.observe(c);
      // the page's sheet too: while nobody has moved the camera, its subject stays in the uncovered part
      const panel = c.ownerDocument?.getElementById?.('panel');
      if (panel) this.resizer.observe(panel);
    }
    const win = c?.ownerDocument?.defaultView;
    if (win?.addEventListener) { this.onResize = () => this.invalidate(); win.addEventListener('resize', this.onResize); }
  }

  bind() {
    const c = this.canvas;
    if (!c.addEventListener) return;
    const at = e => ({ x: e.offsetX, y: e.offsetY });
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture?.(e.pointerId);
      // a finger on the map stops a move where the picture is
      if (this.cam.halt()) { this.cam.userMoved = true; this.sync(); }
      const p = at(e);
      this.pointers.set(e.pointerId, p);
      this.drag = { x: p.x, y: p.y, moved: false, track: [{ t: e.timeStamp, x: p.x, y: p.y }] };
    });
    c.addEventListener('pointermove', e => {
      const prev = this.pointers.get(e.pointerId), p = at(e);
      // a mouse over the map with no button down: what is under it (the page's hover tip), in the picture on screen
      if (!prev) { if (e.pointerType === 'mouse') this.onHover(pick(this.cam.drawn, this.size(), p.x, p.y), p); return; }
      this.onHover(null);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        this.pointers.set(e.pointerId, p);
        const [a2, b2] = [...this.pointers.values()];
        const after = Math.hypot(a2.x - b2.x, a2.y - b2.y);
        if (before > 0) this.zoomAt(after / before, (a2.x + b2.x) / 2, (a2.y + b2.y) / 2);
        if (this.drag) { this.drag.moved = true; this.drag.track = []; }
        return;
      }
      this.pointers.set(e.pointerId, p);
      const d = this.drag;
      if (d && Math.hypot(p.x - d.x, p.y - d.y) > 4) d.moved = true;
      if (!d?.moved) return;
      d.track.push({ t: e.timeStamp, x: p.x, y: p.y });
      while (d.track.length > 2 && e.timeStamp - d.track[0].t > 120) d.track.shift();
      // the drag itself: the land follows the finger, with some give past the edge of the world
      const v = this.cam.view;
      this.setView({ x: v.x - (p.x - prev.x) / v.zoom, y: v.y - (p.y - prev.y) / v.zoom }, { clamp: true, soft: 1 });
    });
    const up = e => {
      const d = this.drag, p = at(e);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.drag = null;
      if (!d) return;
      if (!d.moved) { if (e.type === 'pointerup') this.onSelect(pick(this.cam.drawn, this.size(), p.x, p.y)); return; }
      if (this.pointers.size > 0) return;
      // released: the land glides on and settles inside the world's edge
      const tr = d.track, a = tr[0], b = tr[tr.length - 1];
      const dt = a && b ? b.t - a.t : 0, fresh = b ? e.timeStamp - b.t < 80 : false;
      const glided = e.type === 'pointerup' && fresh && dt > 12 && this.cam.fling((b.x - a.x) / dt, (b.y - a.y) / dt);
      if (!glided) this.cam.set(this.cam.view, { clamp: true, ms: MOVE_MS.settle, tag: 'settle' });
      this.sync();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointerleave', () => this.onHover(null));
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      // the wheel takes over a flight where the picture is; its own easing is only retargeted
      if (this.cam.tween && this.cam.tween.tag !== 'wheel' && this.cam.halt()) this.sync();
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY, { ms: MOVE_MS.wheel, tag: 'wheel' });
    }, { passive: false });
    c.addEventListener('keydown', e => {
      const v = this.cam.view, step = 80 / v.zoom;
      const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (k) { e.preventDefault(); this.setView({ x: v.x + k[0], y: v.y + k[1] }, { clamp: true, ms: MOVE_MS.pan }); return; }
      const s = this.size();
      if (e.key === '+' || e.key === '=') this.zoomBy(1.25);
      else if (e.key === '-') this.zoomBy(0.8);
      else if (e.key === 'h' || e.key === 'H') this.home();
      else if (e.key === 'm' || e.key === 'M') this.worldChart();
      else if (e.key === 'Enter') this.onSelect(pick(v, s, s.width / 2, s.height / 2));
    });
  }

  /**
   * The opening view (opening.mjs): once the viewer is known, and again when
   * the viewer becomes more (a village lands), the title card closes, the
   * canvas changes size or a sheet covers more or less of it — never after
   * a person moved the camera. Returns false while the map still waits to
   * know who is looking.
   */
  open(src, size, { dpr = this.dpr(), now = clock() } = {}) {
    if (this.cam.userMoved) return true;
    const inset = this.inset();
    let plan = openingPlan(src?.open, src, size, { inset, dpr });
    if (!plan) {
      this.openWait ??= now;
      if (now - this.openWait < OPEN_WAIT_MS) { this.dirty = true; return !!this.opened; }
      plan = openingPlan({ ready: true }, { ringsOpen: src?.ringsOpen }, size, { inset, dpr });
    }
    const title = !!src?.open?.title;
    // what the sheets cover, in steps (a sheet settling by a pixel is not a new picture)
    const cover = [inset.top, inset.right, inset.bottom, inset.left].map(n => Math.round((n ?? 0) / 8)).join(',');
    const subject = `${plan.kind}|${Math.round(plan.at.x)},${Math.round(plan.at.y)}|${plan.kind === 'fit' ? src?.ringsOpen ?? 1 : ''}`;
    const key = `${subject}|${size.width}x${size.height}|${title ? 'title' : ''}|${cover}`;
    if (key === this.openKey) return true;
    const prev = this.opened ?? null, was = { ...this.cam.drawn };
    this.openKey = key;
    this.opened = { kind: plan.kind, rank: plan.rank, width: size.width, height: size.height, title, subject };
    this.setView(plan.view, { auto: true });
    const f = focusOf({ x: 0, y: 0, zoom: 1 }, size, inset);
    if (!prev) {
      // the first picture: the title card drifts in from the mist; a player's land is reached from a little above
      const k = title ? TITLE_FROM : plan.kind === 'fit' ? 1 : OPEN_FROM;
      if (k < 1) this.cam.from(centreOn(plan.at, Math.max(ZOOM_MIN, plan.view.zoom * k), size, inset), { ms: title ? TITLE_MS : MOVE_MS.open, ease: EASE.outCubic, anchor: f });
      this.reveal = now;
    } else if (prev.width !== size.width || prev.height !== size.height) {
      // a new canvas size: framed again, at once
    } else if (prev.subject === subject && prev.title === title) {
      // only the sheets moved (a phone's sheet opened or closed): the subject slides back into the uncovered part
      this.cam.from(was, { ms: MOVE_MS.settle, ease: EASE.outCubic });
    } else if (plan.kind !== 'fit' || prev.title) {
      // the viewer became more, or the title closed mid-drift: fly the rest of the way
      this.cam.from(was, { ms: prev.title && !title && prev.kind === plan.kind ? MOVE_MS.far : MOVE_MS.open, ease: EASE.outCubic, kind: 'fly' });
    }
    return true;
  }

  draw(now = clock()) {
    this.dirty = false;
    // the canvas is painted edge to edge every frame: no alpha to blend with the page
    const ctx = this.canvas.getContext?.('2d', { alpha: false });
    if (!ctx) return;
    PROBE.begin();
    const dpr = this.dpr();
    const { width, height } = this.size();
    const W = Math.round(width * dpr), H = Math.round(height * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; this.sceneKey = null; this.fade = null; }
    if (!(width > 0) || !(height > 0)) return;
    const size = { width, height };
    // the table the world lies on: one colour (a gradient over the whole canvas every frame costs far more than
    // the scene on a slow canvas); its fall into shadow toward the edges is the vignette of the depth dressing,
    // which is painted once into a bitmap and copied
    const table = g => { g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = TABLE; g.fillRect(0, 0, width, height); };
    const inset = this.inset();
    const dressing = zoom => { const step = Math.round(nearness(zoom) * 16); this.stamped(ctx, 'dressCv', `${W}x${H}|${step}|${inset.top},${inset.right},${inset.bottom},${inset.left}`, W, H, dpr, g => paintDressing(g, size, { near: step / 16, inset })); };
    const src = this.source();
    this.rings = src.ringsOpen ?? 1;
    if (!this.open(src, size, { dpr, now })) {
      // who is looking is not known yet: the bare table, never the whole world first
      table(ctx);
      dressing(0);
      PROBE.end('wait', ctx);
      return;
    }
    const v = this.cam.drawn, logical = this.cam.view;
    const was = this.drawnLod, lod = lodFor(v.zoom, was);
    this.drawnLod = lod;
    const motion = !reducedMotion();
    // a change of level of detail dissolves: the last picture of the old level fades over the new one
    // (only when the zoom travels through the threshold: a jump cuts, as a jump should)
    const travelled = Math.abs(Math.log(v.zoom / (this.lastZoom ?? v.zoom))) < 0.3;
    this.lastZoom = v.zoom;
    if (lod !== was && this.art && this.painted && motion && travelled) {
      const cv = this.fadeCv?.width === W && this.fadeCv?.height === H ? this.fadeCv : spareCanvas(this.canvas.ownerDocument, W, H);
      const g = cv?.getContext?.('2d');
      if (g) {
        // (the world only: labels are always drawn fresh on top, a still of them would ghost as the zoom goes on)
        this.paintScene(ctx, src, v, was, size, dpr, { now, table });
        g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'copy'; g.drawImage(this.canvas, 0, 0); g.globalCompositeOperation = 'source-over';
        this.fadeCv = cv;
        this.fade = { view: { ...v }, since: now, t0: null };
      }
    }
    // at rest (the same picture as the last frame) the still layers are kept and only the animated ones repaint
    const sceneKey = `${v.x}|${v.y}|${v.zoom}|${W}x${H}|${lod}`;
    const rest = sceneKey === this.sceneKey && !this.fade && !this.cam.moving && !this.drag?.moved;
    this.sceneKey = sceneKey;
    // while the picture flies to a nearer view, what it will need there is asked for now (and the art of that zoom is used all the way)
    if (this.cam.moving && this.lod === 'tile' && this.warmKey !== `${logical.x}|${logical.y}|${logical.zoom}`) {
      this.warmKey = `${logical.x}|${logical.y}|${logical.zoom}`;
      const terrainOf = src.terrainOf ?? this.terrainOf;
      for (const pr of visibleProvinces(logical, size, Math.max(0, this.rings - 1) + 1)) { terrainOf?.(pr.p, pr.q); if (this.art && ringOf(pr.p, pr.q) < this.rings) src.provinceOf?.(pr.p, pr.q); }
    }
    // away from the tile view its still layers are let go (two bitmaps the size of the canvas)
    if (lod !== 'tile' && this.layers) this.layers = null;
    const out = this.paintScene(ctx, src, v, lod, size, dpr, { now, rest, table, artZoom: Math.max(v.zoom, logical.zoom) });
    this.painted = true;
    if (this.fade) {
      // the old picture stays whole until the new level has its art (a moment at most), then fades; it is a still
      // of one zoom, so the further the zoom has travelled since, the less of it is left (a flight through the
      // threshold does not drag a stale rectangle along)
      const drift = Math.abs(Math.log(v.zoom / this.fade.view.zoom)) / LOD_FADE_DRIFT;
      if (this.fade.t0 === null && (out.pending === 0 || now - this.fade.since > LOD_HOLD_MS || drift > 0.3)) this.fade.t0 = now;
      const k = Math.max(drift, this.fade.t0 === null ? 0 : (now - this.fade.t0) / LOD_FADE_MS);
      if (!(k < 1)) { this.fade = null; if (this.fadeCv) { this.fadeCv.width = 0; this.fadeCv.height = 0; this.fadeCv = null; } }
      else {
        const f = this.fade.view, s = v.zoom / f.zoom;
        ctx.save();
        ctx.globalAlpha = 1 - EASE.inOutCubic(Math.max(0, k));
        ctx.setTransform(s, 0, 0, s, dpr * ((width / 2) * (1 - s) + (f.x - v.x) * v.zoom), dpr * ((height / 2) * (1 - s) + (f.y - v.y) * v.zoom));
        ctx.drawImage(this.fadeCv, 0, 0);
        ctx.restore();
        this.dirty = true;
      }
    }
    // the opening comes out of the bare table it waited on: the land first, its labels with it
    let shown = 1;
    if (this.reveal !== undefined && this.reveal !== null) {
      const k = motion ? (now - this.reveal) / REVEAL_MS : 1;
      if (!(k < 1)) this.reveal = null;
      else {
        shown = 1 - Math.pow(1 - Math.max(0, k), 2);
        ctx.save(); ctx.globalAlpha = 1 - shown; table(ctx); ctx.restore();
        this.dirty = true;
      }
    }
    dressing(v.zoom);
    if (shown > 0.4) { ctx.save(); ctx.globalAlpha = shown; out.over(); ctx.restore(); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.mark(lod === this.lod && out.wanted > 0 && out.drawn === out.wanted ? 'ready' : 'pending');
    PROBE.end(out.kind, ctx);
    PROBE.paint(ctx, size);
  }

  /**
   * Copy a picture that only changes with `key` onto the canvas: `paint(g)`
   * draws it (in CSS px) into a bitmap of its own the first time and when the
   * key changes (a gradient over the whole canvas costs far more than a
   * copy). Without a spare canvas it is painted straight onto `ctx`.
   */
  stamped(ctx, name, key, W, H, dpr, paint) {
    let slot = this[name];
    if (W * H > STILL_MAX_PIXELS) { this[name] = null; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); paint(ctx); return; }
    if (!slot || slot.cv.width !== W || slot.cv.height !== H) {
      const cv = spareCanvas(this.canvas.ownerDocument, W, H), g = cv?.getContext?.('2d');
      slot = this[name] = g ? { cv, g, key: null } : null;
    }
    if (!slot) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); paint(ctx); return; }
    if (slot.key !== key) {
      slot.g.setTransform(1, 0, 0, 1, 0, 0); slot.g.clearRect(0, 0, W, H); slot.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(slot.g);
      slot.key = key;
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(slot.cv, 0, 0); ctx.restore();
  }

  /**
   * One picture of the world at `view` and `lod` into `ctx`. Returns
   * `{wanted, drawn, kind, over, pending}`: the tile LOD's terrain state, what
   * kind of frame it was ('full' | 'live' | 'far'), `over()`, which paints
   * what belongs above the depth dressing (labels, warnings, pins, the
   * guide), and how much art of this picture is still on its way.
   */
  paintScene(ctx, src, view, lod, size, dpr, { now = clock(), rest = false, artZoom = view.zoom, table = () => {} } = {}) {
    const { width, height } = size, z = view.zoom;
    const world = [dpr * z, 0, 0, dpr * z, dpr * (width / 2 - view.x * z), dpr * (height / 2 - view.y * z)];
    // what lies under the art: the table, and the provinces drawn as plain cells (no terrain yet, or no art);
    // painted onto the canvas, or once into the ground layer of a resting tile view
    const plain = [];
    const under = g => { table(g); g.setTransform(...world); for (const f of plain) f(g); };
    const ringsOpen = src.ringsOpen ?? 1, own = src.own ?? [];
    const maxRing = Math.max(0, ringsOpen - 1) + 1;
    const recs = new Map();
    for (const ov of src.overviews?.values?.() ?? []) for (const r of ov.provinces) recs.set(`${r.p},${r.q}`, r);
    const terrainOf = src.terrainOf ?? this.terrainOf;
    // the fog of a province, and of the province a tile is in: one rule for every painter of this frame
    const fogOf = (p, q) => fogLevel({ ringOpen: ringOf(p, q) < ringsOpen, showAll: src.showAll, known: src.known?.has(`${p},${q}`), sightDistance: sightDistance(p, q, own) });
    const fogAt = (q, r) => { const at = locate(q, r); return fogOf(at.p, at.q); };
    let wanted = 0, drawn = 0, kind = 'far', labels = null, pending = 0;
    const artTiles = [], artCells = [];
    for (const pr of visibleProvinces(view, size, maxRing)) {
      const key = `${pr.p},${pr.q}`;
      const fog = fogOf(pr.p, pr.q);
      const selected = !!src.selected && src.selected.p === pr.p && src.selected.q === pr.q;
      const rec = recs.get(key);
      if (lod === 'tile' && this.art) {
        // Art: every fog level is drawn as tiles (distant muted, unopened as cloud sea; LOD.md).
        if (fog === 'unopened') { artTiles.push({ ...pr, fog, selected }); continue; }
        // a viewer with no holdings (spectator, before joining) sees the land clear: fog is relative to one's own
        const artFog = own.length ? fog : 'clear';
        const t = terrainOf?.(pr.p, pr.q);
        if (TILE_FOGS.includes(fog)) wanted++;
        if (t) { artTiles.push({ ...pr, ...t, rec, fog: artFog, selected, prov: src.provinceOf?.(pr.p, pr.q) ?? null, clash: src.clashOf?.(pr.p, pr.q) ?? null, pending: src.pendingOf?.(pr.p, pr.q) ?? null }); if (TILE_FOGS.includes(fog)) drawn++; continue; }
        plain.push(g => paintProvince(g, { ...pr, rec, fog, selected, scale: z }));
        continue;
      }
      if (lod === 'tile' && TILE_FOGS.includes(fog)) {
        wanted++;
        const t = terrainOf?.(pr.p, pr.q);
        if (t) {
          plain.push(g => { paintTiles(g, { ...pr, ...t, rec, selectedTile: selected ? src.selected.idx : null }); paintVeil(g, { ...pr, fog, scale: z, selected }); });
          drawn++;
          continue;
        }
      }
      // Art, far: the land itself, painted once per province (sprites.mjs farBitmap); clouds beyond the rim
      if (this.art && fog === 'unopened') { artCells.push({ ...pr, fog, selected }); continue; }
      if (this.art) {
        const t = terrainOf?.(pr.p, pr.q);
        if (t) { artCells.push({ ...pr, ...t, rec, fog: own.length ? fog : 'clear', selected, prov: src.provinceOf?.(pr.p, pr.q, { far: true }) ?? null, tiers: src.tierOf ? Array.from({ length: 12 }, (_, j) => src.tierOf(pr.p, pr.q, j)) : null }); continue; }
      }
      plain.push(g => paintProvince(g, { ...pr, rec, fog, selected, scale: z }));
    }
    // a resting tile view: the still layers (the table is in the ground layer), then the animated ones
    const tileOpts = artTiles.length ? { zoom: z, dpr, artZoom, stamp: this.stamp, between: this.between ? c => this.between(c, { zoom: z, now }) : null, terrainAt: terrainLookup(terrainOf), fogAt, selected: src.selected, viewerFaction: src.viewerFaction ?? null, demoRoads: !!src.demoRoads, ringsOpen: src.ringsOpen ?? null, replayRing: src.artReplayRing ?? null, engineStage: src.engineStage ?? 0, relics: src.relics ?? [], waystones: src.waystones ?? [], demoSpecials: !!src.demoSpecials, rivers: src.rivers ?? [], demoRivers: !!src.demoRivers, alliedPairs: src.alliedPairs ?? [],
      // people (people/crowds.mjs): the source's departures, explores and holder names; tags nearest the view centre first
      people: src.people ? { ...src.people(), centre: { x: view.x, y: view.y } } : null } : null;
    const missed = this.art?.misses ?? 0;
    const layered = tileOpts && rest ? this.paintLayered(ctx, artTiles, tileOpts, world, now, under) : null;
    if (!layered) under(ctx);
    ctx.setTransform(...world);
    if (artCells.length) {
      // while the picture travels, far bitmaps are not painted for zooms it only passes through (the ones at hand
      // are stretched); arriving, they are painted for where it rests
      this.art.paintFar(ctx, artCells, { zoom: z, dpr, terrainAt: terrainLookup(terrainOf), fogAt, alliedPairs: src.alliedPairs ?? [], lod, lens: src.lens ?? 'realm',
        passing: this.cam.moving, resZoom: this.cam.moving ? Math.min(z, this.cam.view.zoom) : z });
      pending += this.art.farPending ?? 0;
      if (lod === 'world' && (src.lens ?? 'realm') !== 'land') paintRealmLabels(ctx, recs, z, src.realmName ?? null);
    }
    if (tileOpts) {
      kind = layered === 'live' ? 'live' : 'full';
      if (!layered) this.art.paint(ctx, artTiles, { ...tileOpts, part: 'world' });
      labels = () => this.art.labels(ctx, tileOpts);
      pending += this.art.misses - missed;   // sprites still on their way
    }
    if (src.reach?.tiles?.length) { paintReach(ctx, src.reach.tiles, z, clock() / 1000, src.reach.t0); this.invalidateSoon(); }
    if (src.route) paintRoute(ctx, src.route, z);
    // what is read rather than looked at goes over the depth dressing: labels, warnings, pins, the guide
    const over = () => {
      ctx.setTransform(...world);
      labels?.();
      if (src.threats?.length) { paintThreats(ctx, src.threats, z, src.threatLabel ?? null); this.invalidateSoon(); }
      if (src.pins?.length) paintPins(ctx, src.pins, z);
      if (src.guide && !src.route) { paintGuide(ctx, src.guide, z, src.guideLabel?.(src.guide) ?? ''); this.invalidateSoon(); }
    };
    return { wanted, drawn, kind, over, pending };
  }

  /**
   * The tile view of a resting camera: the still ground (with the table
   * under it) and the still props are painted once into two bitmaps the size
   * of the canvas and kept until the picture or the data changes; every
   * frame after that is two copies and the animated layers (hosts, people,
   * moments, battles). `under(g)` paints what lies under the art. Returns
   * 'live' (only the animated layers were painted), 'fresh' (this frame had
   * to paint the still layers first: a full frame) or null (no spare
   * canvas, or a canvas too large to keep copies of: the caller paints the
   * frame whole).
   */
  paintLayered(ctx, tiles, opts, world, now, under) {
    const W = this.canvas.width, H = this.canvas.height;
    if (W * H > STILL_MAX_PIXELS) { this.layers = null; return null; }
    const L = this.layers ??= { key: null, at: 0 };
    for (const n of ['ground', 'props']) {
      if (L[n]?.cv.width === W && L[n].cv.height === H) continue;
      const cv = spareCanvas(this.canvas.ownerDocument, W, H), g = cv?.getContext?.('2d', n === 'ground' ? { alpha: false } : undefined);
      if (!g) { this.layers = null; return null; }
      L[n] = { cv, g };
      L.key = null;
    }
    const key = `${this.stamp}|${this.sceneKey}`;
    const fresh = L.key !== key || now - L.at > LAYER_MAX_AGE_MS;
    if (fresh) {
      under(L.ground.g);
      L.ground.g.setTransform(...world);
      this.art.paint(L.ground.g, tiles, { ...opts, part: 'ground', between: null });
      const g = L.props.g;
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.setTransform(...world);
      this.art.paint(g, tiles, { ...opts, part: 'props' });
      L.key = key; L.at = now;
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy'; ctx.drawImage(L.ground.cv, 0, 0); ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    ctx.setTransform(...world);
    opts.between?.(ctx);   // ground-level effects: over the land, under what stands on it
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(L.props.cv, 0, 0); ctx.restore();
    this.art.paint(ctx, tiles, { ...opts, part: 'live' });
    return fresh ? 'fresh' : 'live';
  }

  destroy() {
    if (this.raf) globalThis.cancelAnimationFrame?.(this.raf);
    if (this.soon) clearTimeout(this.soon);
    this.resizer?.disconnect?.();
    if (this.onResize) this.canvas?.ownerDocument?.defaultView?.removeEventListener?.('resize', this.onResize);
    this.unlang?.(); this.unredraw?.(); this.tools?.remove();
  }
}
