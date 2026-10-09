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
// moved. M and the "world chart" button go to the far view and back. The
// board is tilted (map/tilt.mjs, UX brief §11.1): the ground is painted on
// `#map-ground` inside the one tilted element `#map-stage`, larger than the
// map's box so the trapezoid in view is always covered; this canvas lies flat
// above it, takes every input (mapped back onto the board in numbers) and
// carries what must stay upright. `project` / `unproject` say where a point
// of the world is seen. A change of level of detail dissolves instead of
// popping. At rest only the animated layers repaint on the timer: the still
// ground and props wait in two bitmaps (map/sprites.mjs paints the parts).
import { paintPins } from '../hud/pins.mjs';
import { inverseHex } from '../../map.mjs';
import { L, onLangChange } from '../../lang.mjs';
import { locate, ringOf, ringProvinces, hexDistance, tileHex } from '../fgeo.mjs';
import { fogLevel, paintProvince, paintSigil, paintTiles, paintVeil, provincePixel, PROVINCE_CIRCUMRADIUS } from './layers.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { createTerrain } from './terrain.mjs';
import { SpriteArt, artSize, farRes, terrainLookup } from './sprites.mjs';
import { paintSheet, paintTable, sheetOf, tableShows } from './table.mjs';
import { CloudSea, DRIFT_SPEED, seaField, seaRes } from './cloudsea.mjs';
import { project, RADIUS, FLATTEN } from '../../map.mjs';
import { Camera, EASE, FAR_CAP, MOVE_MS, clampCentre, fitView, freeBox, reducedMotion } from './camera.mjs';
import { OPEN_FROM, OPEN_WAIT_MS, heroZoom, lookPoint, openingPlan, placePoint } from './opening.mjs';
import { nearness, paintDressing } from './dressing.mjs';
import { PROBE } from './probe.mjs';
import { L2, L3, openSurvey } from './survey.mjs';
import { CHART, fxNow, paintCandidates, paintWedge } from './chart.mjs';
import { wedgeBox } from './opening.mjs';
import { STANDARD_AT, STANDARD_UNIT, landShape, landTiles, landingAt, paintBeacon, paintOwnBreath, paintOwnLand, paintOwnOutline, paintProvisionalTag, paintStandard, standardUnit, villageKey } from './ownland.mjs';
import { reachSteps } from '../hud/reach.mjs';
import { NOTE_MS, reachText, reachTop, actionPalette, actorText, arrivalText, blockText, paintActionGround, paintActionPulse, paintActionTop, paintReachDim, reachBox, rolledOut, paintHoverGround, paintHoverTop, paintRefusal, paintRibbon, paintSelectionGround, paintSelectionTop, paintTag } from './actions.mjs';
import { edgePointer, mountHomePointer } from './homepointer.mjs';
import { layoutLabels } from './labels.mjs';
import { plateRise } from './plates.mjs';
import { LANDING } from './ownland.mjs';
import { WORKED_RADIUS } from './survey.mjs';
import { emit as fxEmit } from '../fx/bus.mjs';
import { createLabelPass, rectOf, tileKeyOf } from './labelpass.mjs';
import { leaderWords, paintCandidateLabels, paintHomeTag, paintSurveyLines, paintWaitStandard, standardBox, waitLine } from './waitview.mjs';
import { TILT, armUpright, disarmUpright, groundBox, groundView, nearQuad, perspFromQuery, standing, tiltAt, tiltFromQuery, tiltGeo, upright } from './tilt.mjs';

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
export const HOME_ZOOM = 1.5;
/**
 * The far view is never nearer than this (map/camera.mjs FAR_CAP). It is always the world's level of detail: on a
 * small world, where the far view is nearer than the fixed edges above, the edges follow it (`lodEdges`).
 */
export const FAR_ZOOM_CAP = FAR_CAP;
/** A change of level of detail dissolves over this long (ms), after waiting at most LOD_HOLD_MS for the new level's art. */
export const LOD_FADE_MS = 280;
export const LOD_HOLD_MS = 700;
/** The opening fades in from the bare table over this long (ms). */
export const REVEAL_MS = 520;
/** The dissolve's still is gone once the zoom has travelled this far from it (natural log of the zoom ratio). */
export const LOD_FADE_DRIFT = 0.32;
/**
 * Bitmaps the size of the canvas (the two still layers, the dressing) are kept only up to this many
 * pixels each (about 36 MB): a larger canvas is painted whole every frame, as before.
 */
export const STILL_MAX_PIXELS = 11_000_000;
/** The picture of the table and the sheet kept under the world has at most this many pixels. */
export const BACKDROP_PIXELS = 6_000_000;
/** On a screen of one device pixel per CSS pixel the tilted ground is painted this much finer (the near half of the board is drawn larger than life). */
export const GROUND_FINER = 1.4;
/**
 * The page's own things over the map that no label may stand under, until the page says them (`map.setNoGo`): the
 * dial and the strip's two sides, the search button and the objective, the to-do lines and the village plate, the
 * minimap with its lens chips, the map's buttons, the dock, the drawer, the objective's chip, a milestone's banner. (The pointer home
 * is the map's own: it keeps clear of these, and the labels keep clear of it.)
 */
export const NOGO_SELECTORS = '#bell-pill, #bell-pill .dial-top, #topbar .strip-side, #hud-tl > *, #rail > *, #minimap, .map-tools, #tabs, #panel, #ob-map, .feed > *, #mile-banner';
export const NOGO_EVERY_MS = 300;
/** What a pick names, as one word (the tile, or the province from afar). */
const hoverId = hit => (hit ? `${hit.p},${hit.q},${hit.idx ?? ''}` : '');
/** The map's words fade out for a set piece, and back in after it, over this long (ms). */
export const PIECE_LABELS_MS = 200;
/**
 * The camera eases out to a lit reach: the reach's box takes at most this share of the uncovered picture, keeps
 * this many px clear of its edges, and the zoom never goes below this factor of the tile view's own edge (a
 * phone's picture is too narrow for a whole reach: there it eases out as far as the tiles stay tiles).
 */
export const REACH_FIT = 0.9;
export const REACH_PAD = 14;
export const REACH_ZOOM_FLOOR = 1.14;
/** What the pale line of a reach is, is said beside it for this long after a host is selected (ms). */
export const REACH_WORDS_MS = 7000;
/** The landing waits until the camera has stood still this long (ms), and never longer than LANDING_WAIT in all. */
export const LANDING_REST = 500, LANDING_WAIT = 6000;
/** The landing's own frame: this much closer than the hero zoom (up to the closest zoom there is), held LANDING_HOLD ms after the standard stands, then eased back. */
export const LANDING_ZOOM = 1.45, LANDING_HOLD = 1000;
/** A place the page asks the map to fly to (`wylls:fly-to`) is seen at this zoom at least: its tiles, and what stands on them. */
export const FLY_TO_ZOOM = 1.0;
/** The still layers of a resting view are repainted at least this often (ms): a change nobody announced heals. */
export const LAYER_MAX_AGE_MS = 2000;

/**
 * The edges for a map whose far view is at zoom `far`: the far view (the opened world fitted to the picture, UX
 * brief §11.2) and a little nearer are the world's level of detail whatever the size of the world; the province
 * level begins past it and still ends where the tiles begin.
 */
export function lodEdges(far = 0) {
  const out = Math.min(LOD_EDGES.tileOut * 0.86, far * 1.08);
  if (!(out > LOD_EDGES.provinceOut)) return LOD_EDGES;
  return { ...LOD_EDGES, provinceOut: out, provinceIn: out * 1.1 };
}

/** The level of detail at `zoom`, given the current one (no flicker at an edge). `e`: the edges (lodEdges). */
export function lodFor(zoom, current = 'world', e = LOD_EDGES) {
  if (current === 'world') return zoom >= e.tileIn ? 'tile' : zoom >= e.provinceIn ? 'province' : 'world';
  if (current === 'province') return zoom >= e.tileIn ? 'tile' : zoom < e.provinceOut ? 'world' : 'province';
  return zoom < e.provinceOut ? 'world' : zoom < e.tileOut ? 'province' : 'tile';
}

/** view = {x, y (world px at the screen centre), zoom}. */
export const worldToScreen = (view, size, x, y) => ({ x: (x - view.x) * view.zoom + size.width / 2, y: (y - view.y) * view.zoom + size.height / 2 });
export const screenToWorld = (view, size, sx, sy) => ({ x: (sx - size.width / 2) / view.zoom + view.x, y: (sy - size.height / 2) / view.zoom + view.y });

/**
 * The provinces of rings 0..maxRing whose cell intersects the viewport, nearest the centre first.
 * `quad` (four world points in order): the part of the ground seen through a tilted board, a
 * trapezoid inside the canvas; provinces in the canvas's unseen corners are left out.
 */
export function visibleProvinces(view, size, maxRing, quad = null) {
  const a = screenToWorld(view, size, 0, 0), b = screenToWorld(view, size, size.width, size.height);
  const m = PROVINCE_CIRCUMRADIUS;
  const out = [];
  for (let d = 0; d <= maxRing; d++) {
    for (const pr of ringProvinces(d)) {
      const c = provincePixel(pr.p, pr.q);
      if (c.x >= a.x - m && c.x <= b.x + m && c.y >= a.y - m && c.y <= b.y + m && nearQuad(quad, c.x, c.y, m)) out.push({ ...pr, dist: Math.hypot(c.x - view.x, c.y - view.y) });
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
 * The world view's labels, as a map has them: each faction's name over the
 * heart of its land (the weighted centre of the provinces it holds most of
 * in), and the Concord at the centre. Screen-sized type in the display face.
 */
export function paintRealmLabels(ctx, recs, zoom, nameOf = null, { seen = null, min = 3, home = null, extra = [], nations = true } = {}) {
  // with a survey (`seen(rec, site)`): a nation is named over the villages the viewer has surveyed, and the
  // viewer's own nation over its home wedge while it has no village (`home` = {faction, x, y}).
  // `extra`: more names to lay out with them (`[{text, x, y, size, fill, below (screen px under the point)}]`:
  // the viewer's village under its beacon). No name covers another (map/labels.mjs).
  const acc = Array.from({ length: 6 }, () => ({ x: 0, y: 0, w: 0 }));
  if (nations) for (const r of recs.values()) {
    const n = Array(6).fill(0);
    r.owners.forEach((f, j) => { if (r.sites[j] === 1 && f < 6 && (!seen || seen(r, j))) n[f]++; });
    const best = n.indexOf(Math.max(...n));
    if (n[best] <= 0) continue;
    const c = provincePixel(r.p, r.q);
    acc[best].x += c.x * n[best]; acc[best].y += c.y * n[best]; acc[best].w += n[best];
  }
  const k = 1 / zoom;
  const face = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", Georgia, serif';
  const fontOf = size => `700 ${size * k}px ${face}`;
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const c0 = provincePixel(0, 0);
  const items = [];
  const add = (text, x, y, size, fill, priority, more = {}) => {
    ctx.font = fontOf(size);
    const w = ((ctx.measureText?.(text)?.width ?? text.length * size * k) / k) + 8;
    // (a nation's name carries its sigil before it: room for that)
    items.push({ text, x, y, size, fill, priority, w: w + (Number.isInteger(more.faction) ? size * 1.15 : 0), tw: w - 8, h: size * 1.3, dir: { x: x - c0.x, y: y - c0.y }, ...more });
  };
  // the viewer's own names first, then the Concord, then the nations (the larger realm first)
  for (const e of extra) {
    if (e.block) items.push({ text: '', x: e.x, y: e.y, w: e.block, h: e.blockH ?? e.block, priority: 10, fixed: true });
    else add(e.text, e.x, e.y + ((e.below ?? 0) + (e.size ?? 13) * 0.65 + (e.tag ? 5 : 0)) * k, e.size ?? 13, e.fill ?? '#f3d58a', 9, { fixed: true, tag: !!e.tag });
  }
  if (nations) {
    add(nameOf ? nameOf('concord') : 'Concord', c0.x, c0.y, 15, '#efe6cf', 8, { fixed: true });
    acc.forEach((a, f) => {
      const name = nameOf ? nameOf(f) : String(f);
      if (a.w < min) { if (home && home.faction === f) add(name, home.x, home.y, 22, '#fff6e2', 7, { faction: f }); return; }
      add(name, a.x / a.w, a.y / a.w, 22, '#fff6e2', 1 + Math.min(5, a.w / 100), { faction: f });
    });
  }
  for (const it of layoutLabels(items, { zoom })) {
    if (!it.text) continue;
    ctx.font = fontOf(it.size);
    upright(ctx, it.x, it.y, () => {
      if (it.tag) {
        // the viewer's own village: its name on a small plate of bell metal with a gold hairline (read at a glance, on any ground)
        const w = (it.w + 6) * k, h = (it.size + 10) * k;
        ctx.fillStyle = 'rgba(4,10,9,.3)'; ctx.beginPath(); ctx.roundRect?.(it.x - w / 2, it.y - h / 2 + 1.5 * k, w, h, 6 * k); ctx.fill();
        ctx.fillStyle = 'rgba(15,32,29,.94)'; ctx.beginPath(); ctx.roundRect?.(it.x - w / 2, it.y - h / 2, w, h, 6 * k); ctx.fill();
        ctx.strokeStyle = '#f3d58a'; ctx.lineWidth = 1 * k; ctx.stroke();
        ctx.fillStyle = '#fff3cf'; ctx.fillText(it.text, it.x, it.y + 0.5 * k);
        return;
      }
      // a nation's name: its sigil on its colour stands before it (a nation is never told by colour or by name alone)
      const sr = Number.isInteger(it.faction) ? it.size * 0.46 * k : 0, tx = it.x + (sr ? sr + 2 * k : 0);
      if (sr) {
        const sx = tx - (it.tw * k) / 2 - sr - 5 * k;
        ctx.beginPath(); ctx.arc(sx, it.y, sr, 0, Math.PI * 2); ctx.fillStyle = FACTION_COLORS[it.faction] ?? '#8a8f86'; ctx.fill();
        ctx.strokeStyle = 'rgba(14,22,20,.85)'; ctx.lineWidth = 1.6 * k; ctx.stroke();
        paintSigil(ctx, { x: sx, y: it.y, r: sr * 0.56, faction: it.faction, mark: '#fff6e2' });
      }
      ctx.lineJoin = 'round'; ctx.lineWidth = 5 * k; ctx.strokeStyle = 'rgba(14,22,20,.78)'; ctx.strokeText(it.text, tx, it.y);
      ctx.fillStyle = it.fill; ctx.fillText(it.text, tx, it.y);
    });
  }
  ctx.restore();
}

/**
 * Incoming risk (spec §7.3): a red halo that breathes around each of the
 * viewer's holdings an enemy may reach, with the earliest bell it could
 * arrive. `threats = [{p, q, tile, bell}]` (destinations are sealed: a
 * warning, never a certainty).
 */
export function paintThreats(ctx, threats, zoom, label = null, part = null) {
  // `part` 'mark': the halo and the ring, on the ground; 'label': the words, upright; null: both
  const t = fxNow() / 1000;
  const k = 1 / zoom, pulse = 0.5 + 0.5 * Math.sin(t * 3);
  const seen = new Set();
  ctx.save();
  for (const w of threats) {
    const key = `${w.p},${w.q},${w.tile}`;
    if (seen.has(key) || !Number.isInteger(w.tile)) continue;
    seen.add(key);
    const h = tileHex(w.p, w.q, w.tile), c = project(h.q, h.r);
    const r = Math.max(RADIUS * 1.3, 18 * k) * (1 + pulse * 0.12);
    if (part !== 'label') {
      const g = ctx.createRadialGradient(c.x, c.y, r * 0.4, c.x, c.y, r);
      g.addColorStop(0, 'rgba(200,40,30,0)'); g.addColorStop(0.75, `rgba(200,40,30,${0.18 + pulse * 0.14})`); g.addColorStop(1, 'rgba(200,40,30,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(230,70,50,${0.6 + pulse * 0.4})`; ctx.lineWidth = 2.4 * k; ctx.setLineDash([6 * k, 4 * k]);
      ctx.beginPath(); ctx.arc(c.x, c.y, r * 0.78, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    if (label && part !== 'mark') upright(ctx, c.x, c.y, () => {
      const text = label(w);
      ctx.font = `700 ${12 * k}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(text).width + 12 * k, th = 18 * k, y = c.y + r * 0.78 + 4 * k;
      ctx.fillStyle = 'rgba(120,20,12,.92)'; ctx.beginPath(); ctx.roundRect?.(c.x - tw / 2, y, tw, th, 8 * k); ctx.fill();
      ctx.fillStyle = '#fff2ee'; ctx.fillText(text, c.x, y + th / 2 + 0.5 * k);
    });
  }
  ctx.restore();
}

/**
 * The guide's target (hud/guide.mjs, UI plan G1): an ivory ring that breathes
 * on the tile the current step is about, with a short label. (Ivory, not
 * gold: gold is the viewer's own mark and nothing else, UX brief §5.3.)
 * `part` 'ring' draws the ring alone (under the map's labels, which it used
 * to cut through), 'label' the pointer and the words, null both.
 */
export function paintGuide(ctx, g, zoom, label = '', part = null, { rise = null, pass = null } = {}) {
  // `rise` (screen px): how far above the tile's centre the pointer's tip stands (over a village's nameplate:
  // map/plates.mjs plateRise); `pass`: the frame's label pass (the words slide out from under the HUD)
  if (!g || !Number.isInteger(g.tile)) return;
  const t = fxNow() / 1000;
  const k = 1 / zoom, pulse = reducedMotion() ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.4);
  const h = tileHex(g.p, g.q, g.tile), c = project(h.q, h.r);
  const r = Math.max(RADIUS * 1.15, 20 * k) * (1 + pulse * 0.15);
  const y = rise === null ? c.y - r - (6 + pulse * 4) * k : c.y - (rise + 3 + pulse * 4) * k;
  ctx.save();
  if (part !== 'label') {
    // a mark laid on the ground around the tile: dashed, quiet (the words and their pointer are what is read)
    ctx.setLineDash([7 * k, 6 * k]); ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(16,24,22,.4)'; ctx.lineWidth = 4.4 * k; ctx.beginPath(); ctx.ellipse?.(c.x, c.y, r, r * FLATTEN, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = `rgba(244,239,224,${0.6 + pulse * 0.3})`; ctx.lineWidth = 2.2 * k; ctx.beginPath(); ctx.ellipse?.(c.x, c.y, r, r * FLATTEN, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  // a pointer above the tile (it and the words stand upright over it)
  if (part !== 'ring') {
    ctx.font = `700 ${12 * k}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = label ? ctx.measureText(label).width + 14 * k : 14 * k, th = label ? 20 * k : 0;
    const move = pass?.place(c.x, c.y, { x: c.x - tw / 2, y: y - 11 * k - 2 * k - th, w: tw, h: th + 13 * k }, { keep: true, reach: 130 }) ?? { dx: 0, dy: 0 };
    upright(ctx, c.x, c.y, () => {
      const px = c.x + move.dx, py = y + move.dy;
      ctx.fillStyle = 'rgba(16,24,22,.6)'; ctx.beginPath(); ctx.moveTo(px, py + 1.5 * k); ctx.lineTo(px - 8.5 * k, py - 11.5 * k); ctx.lineTo(px + 8.5 * k, py - 11.5 * k); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f4efe0'; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - 7 * k, py - 11 * k); ctx.lineTo(px + 7 * k, py - 11 * k); ctx.closePath(); ctx.fill();
      if (!label) return;
      const ly = py - 13 * k - th;
      ctx.fillStyle = 'rgba(16,24,22,.94)'; ctx.beginPath(); ctx.roundRect?.(px - tw / 2, ly, tw, th, 9 * k); ctx.fill();
      ctx.strokeStyle = 'rgba(244,239,224,.5)'; ctx.lineWidth = 1 * k; ctx.stroke();
      ctx.fillStyle = '#f4efe0'; ctx.fillText(label, px, ly + th / 2 + 0.5 * k);
    });
  }
  ctx.restore();
}

/**
 * The march being composed, for this browser only (the destination is
 * sealed for everyone else): a ribbon along the planned hexes to the
 * destination tile. `route = {hexes: [{q, r}], dest: {q, r} | null, arriveBell}`.
 */
export function paintRoute(ctx, route, zoom, { now = fxNow(), still = false, faction = null } = {}) {
  // the same ribbon as under the pointer and after the seal, in the nation's colour (map/actions.mjs): only this browser draws it
  paintRibbon(ctx, route.hexes ?? [], { zoom, faction, proposal: true, now, still });
}

/**
 * Rings of unopened provinces kept in the picture's model around the open rings: the land's last tiles know that
 * cloud, not land, lies beyond them. (The cloud itself is one body over the sheet: map/cloudsea.mjs.)
 */
export const CLOUD_RINGS = 1;

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
  constructor(canvas, { source, onSelect = () => {}, onView = () => {}, onHover = () => {}, onDraw = null, insets = null, art = false, tilt = undefined }) {
    this.canvas = canvas;
    // The tilted stage (map/tilt.mjs, UX brief §11.1): the ground is painted on `#map-ground` inside `#map-stage`,
    // which carries the tilt; this canvas lies flat above it, takes every input and carries what must stay
    // upright (names, pills, tags). A page without the stage (and every test) is the flat map on this one canvas.
    const page = canvas?.ownerDocument ?? null;
    const stage = page?.getElementById?.('map-stage') ?? null, ground = stage ? page.getElementById('map-ground') : null;
    this.stage = stage && ground?.getContext ? stage : null;
    this.ground = this.stage ? ground : canvas;
    this.dress = this.stage ? page.getElementById('map-dress') : null;
    /** The tilt at the near view (degrees): the constant chosen from screenshots, `?tilt=` for trials, 0 for the flat map. */
    this.tiltMax = this.stage ? Math.max(0, Math.min(TILT.max, tilt ?? tiltFromQuery(globalThis.location?.search) ?? TILT.deg)) : 0;
    /** The viewing distance (CSS px): the constant chosen from screenshots, `?persp=` for trials. */
    this.persp = perspFromQuery(globalThis.location?.search) ?? TILT.perspective;
    if (this.stage?.dataset) { if (this.tiltMax > 0) delete this.stage.dataset.flat; else this.stage.dataset.flat = ''; }
    this.stage?.style?.setProperty?.('--map-persp', `${this.persp}px`);
    /** What the page's HUD covers of the canvas (`() => {top, right, bottom, left}`, hud/insets.mjs); without it, what `#panel` covers. */
    this.insetsOf = insets;
    /** Called after every picture with the view on screen and the canvas size (things of the page that follow the map: the objective's place). */
    this.onDraw = onDraw;
    this.source = source;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.onView = onView;
    this.cam = new Camera({ view: { x: 0, y: 0, zoom: 0.06 }, limit: (v, o) => this.limitView(v, o) });
    this.lod = lodFor(this.cam.view.zoom, 'world', this.edges());
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
    // the cloud sea beyond the opened rings (map/cloudsea.mjs): one body of cloud over the sheet; its puffs are the art's cloud sprites
    this.sea = new CloudSea({ image: this.art ? (set, size, name) => this.art.image(set, size, name) : null });
    this.mark();
    this.bind();
    this.mountTools();
    /** The tile under the mouse (`{q, r, p, pq, idx}`), the landing that is playing, the edge pointer home (UX brief §5). */
    this.hover = null;
    this.landing = null;
    this.pointer = mountHomePointer(canvas, { onPress: () => this.home() });
    this.watchSize();
    // a row of a list flies to its place (the wait drawer's candidate sites): `wylls:fly-to` with `{p, q, tile}` (or `site`)
    // (taken: the page's own fallback flight stands down, app.mjs 'site-go')
    this.onFlyTo = e => { try { if (this.flyToPlace(e?.detail)) e.preventDefault?.(); } catch { /* a malformed event */ } };
    globalThis.addEventListener?.('wylls:fly-to', this.onFlyTo);
    this.frame = ts => {
      this.frameNo = (this.frameNo ?? 0) + 1;
      const now = ts ?? clock();
      // a landing that began while the village was out of the picture: the camera goes there (never from inside a draw)
      // (closer than the everyday frame, LANDING_ZOOM: the village is the whole subject of the moment; the camera eases back after it)
      if (this.landingFly) { const f = this.landingFly; this.landingFly = null; this.flyTo({ ...f, zoom: Math.max(this.cam.view.zoom, heroZoom(this.dpr()) * LANDING_ZOOM) }, null, { auto: !this.cam.userMoved }); if (this.landing?.arriving) this.landing.moves = this.moves ?? 0; }
      this.landingBeat(); this.landingEase();
      // the reach of a host that was just selected is not all in the picture: the camera eases out to it
      // (asked for inside the last picture: a person who moved the camera since then keeps it)
      if (this.reachFly) { const f = this.reachFly; this.reachFly = null; if (f.moves === (this.moves ?? 0)) this.setView(f.to, { auto: true, ms: MOVE_MS.reach, kind: 'fly', ease: EASE.inOutCubic }); }
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
  /** The map's box on the page (CSS px): what the views, the insets and every flat formula are measured in. */
  size() { return { width: this.canvas.clientWidth, height: this.canvas.clientHeight }; }
  dpr() { return Math.min(globalThis.devicePixelRatio || 1, 2); }

  // ------------------------------------------------------------------ the tilt (map/tilt.mjs)
  /** The far view's zoom on a canvas of `size` with nothing covering it: there the board lies flat. */
  flatZoom(size = this.size()) {
    const key = `${this.ringsNow()}|${size.width}x${size.height}`;
    if (this.flatKey !== key) { this.flatKey = key; this.flatAt = size.width > 0 && size.height > 0 ? fitView(this.ringsNow(), size, { cap: FAR_ZOOM_CAP, floor: ZOOM_MIN }).zoom : 0; }
    return this.flatAt;
  }
  /** The edges between the levels of detail on this canvas (lodEdges). */
  edges(size = this.size()) { return lodEdges(this.flatZoom(size)); }
  /** The board's angle at `zoom` (degrees): flat at the far view, `tiltMax` at the diorama. */
  tiltDeg(zoom, size = this.size()) { return this.tiltMax > 0 ? tiltAt(zoom, { far: this.flatZoom(size) * 1.05, deg: this.tiltMax }) : 0; }
  /** The tilt's geometry at `zoom` (default: the picture on screen): stage px to box px and back. */
  geo(zoom = this.cam.drawn.zoom, size = this.size()) { return tiltGeo(size, this.tiltDeg(zoom, size), this.persp); }
  /** The canvas's box in the viewport (read once a frame at most). */
  rect() {
    if (this.rectAt !== this.frameNo || !this.rectNow) { const r = this.canvas.getBoundingClientRect?.(); this.rectNow = r ? { left: r.left, top: r.top } : { left: 0, top: 0 }; this.rectAt = this.frameNo; }
    return this.rectNow;
  }
  /**
   * Where world point (x, y) is seen: client px (`box`: px from the map's own top left corner, for an
   * element laid out with it). The picture on screen, or with `logical` where the camera is going.
   */
  project(x, y, { logical = false, box = false } = {}) {
    const v = logical ? this.cam.view : this.cam.drawn, s = this.size();
    const p = this.geo(v.zoom, s).toBox((x - v.x) * v.zoom + s.width / 2, (y - v.y) * v.zoom + s.height / 2);
    if (box) return p;
    const r = this.rect();
    return { x: p.x + r.left, y: p.y + r.top };
  }
  /** The world point seen at client px (cx, cy) (`box`: px from the map's own corner). The inverse of `project`. */
  unproject(cx, cy, { logical = false, box = false } = {}) {
    const v = logical ? this.cam.view : this.cam.drawn, s = this.size(), r = box ? { left: 0, top: 0 } : this.rect();
    const p = this.geo(v.zoom, s).toStage(cx - r.left, cy - r.top);
    return { x: v.x + (p.x - s.width / 2) / v.zoom, y: v.y + (p.y - s.height / 2) / v.zoom };
  }
  /** The part of the world in the picture: four world points (top left, top right, bottom right, bottom left); a trapezoid under a tilt. */
  viewQuad({ logical = false } = {}) {
    const v = logical ? this.cam.view : this.cam.drawn, s = this.size();
    return this.geo(v.zoom, s).quad().map(p => ({ x: v.x + (p.x - s.width / 2) / v.zoom, y: v.y + (p.y - s.height / 2) / v.zoom }));
  }
  /**
   * The ground canvas in the stage: `{left, top, width, height, dx, dy}` (CSS px; map/tilt.mjs groundBox). It
   * reaches past the map's box so the tilted board always fills the picture. Any other world-space canvas (the
   * effects' top pass) is laid exactly over it and draws through `groundView()` with `groundSize()`.
   */
  groundLayout(size = this.size()) {
    const key = `${size.width}x${size.height}|${this.tiltMax}|${this.persp}`;
    if (this.groundKey !== key) {
      this.groundKey = key;
      const g = this.groundNow = this.stage ? groundBox(size, this.tiltMax, { perspective: this.persp }) : { left: 0, top: 0, width: size.width, height: size.height, dx: 0, dy: 0 };
      const st = this.stage ? this.ground.style : null;
      if (st?.setProperty) { st.setProperty('--map-gl', `${g.left}px`); st.setProperty('--map-gt', `${g.top}px`); st.setProperty('--map-gw', `${g.width}px`); st.setProperty('--map-gh', `${g.height}px`); }
    }
    return this.groundNow;
  }
  /** What the tilt asks of a picture that stands on the board at world point (x, y) (map/tilt.mjs standing): `{sh, vs, k}`, or null on a flat board. For another world-space painter (the effects' battle). */
  standAt(x, y) {
    const v = this.cam.drawn, s = this.size(), T = this.geo(v.zoom, s);
    return T.flat ? null : T.standAt((x - v.x) * v.zoom + s.width / 2, (y - v.y) * v.zoom + s.height / 2);
  }
  /** Device px per CSS px of the ground canvas (finer than the screen's own on a screen of one device px per px: the tilt draws the near rows larger). Another canvas laid over it uses the same. */
  groundRatio() { const d = this.dpr(); return d * (this.tiltMax > 0 && d < 1.5 ? GROUND_FINER : 1); }
  /** The flat view of the ground canvas on screen: a canvas laid over `#map-ground` shows world (x, y) at ((x − v.x) · v.zoom + width / 2, …) of its own box. */
  groundView() { return groundView(this.cam.drawn, this.groundLayout()); }
  groundSize() { const g = this.groundLayout(); return { width: g.width, height: g.height }; }
  /** The view that shows world point `pt` at `zoom` in the middle of the part of the picture nothing covers (as it is seen, tilt and all). */
  aim(pt, zoom, size = this.size(), inset = this.inset()) {
    const f = freeBox(size, inset), s = this.geo(zoom, size).toStage(size.width / 2 + f.x, size.height / 2 + f.y);
    return { x: pt.x - (s.x - size.width / 2) / zoom, y: pt.y - (s.y - size.height / 2) / zoom, zoom };
  }
  /**
   * The view that shows world point `pt` at client px (cx, cy) at `zoom`, as it is seen (tilt and all): what a set
   * piece asks for when its scene must stand in the part of the screen the HUD leaves free (fx/battle.mjs).
   */
  viewShowing(pt, cx, cy, zoom, size = this.size()) {
    const r = this.canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 }, s = this.geo(zoom, size).toStage(cx - r.left, cy - r.top);
    return { x: pt.x - (s.x - size.width / 2) / zoom, y: pt.y - (s.y - size.height / 2) / zoom, zoom };
  }
  /** Write the board's angle and the depth dressing onto the page (custom properties: the page's CSP allows no inline style). */
  dressPage(deg, { near = 0, shown = 1, inset = null, haze = 1 } = {}) {
    const set = (el, k, v) => { el.cache ??= {}; if (el.cache[k] !== v) { el.cache[k] = v; el.node.style.setProperty(k, v); } };
    if (this.stage) set(this.stageVars ??= { node: this.stage }, '--map-tilt', `${deg.toFixed(2)}deg`);
    // (the angle on screen, for whoever must know it without asking the map: the browser tests aim their presses with it)
    const d0 = this.canvas.dataset, mark = deg.toFixed(2);
    if (d0 && d0.tilt !== mark) d0.tilt = mark;
    if (!this.dress) return;
    const d = this.dressVars ??= { node: this.dress };
    // the haze is the far edge of a tilted board: none on a flat one
    set(d, '--map-haze', (this.tiltMax > 0 ? Math.min(1, deg / this.tiltMax) * shown * haze : 0).toFixed(3));
    set(d, '--map-near', (near * shown).toFixed(3));
    set(d, '--map-top', `${Math.round(inset?.top ?? 0)}px`);
  }
  /** What the page's sheets cover of the canvas (read once a frame at most). */
  inset() {
    if (this.insetAt !== this.frameNo || !this.insetNow) { let v = null; try { v = this.insetsOf?.() ?? null; } catch { v = null; } this.insetNow = v ?? coveredInsets(this.canvas); this.insetAt = this.frameNo; }
    return this.insetNow;
  }
  // ------------------------------------------------------------------ where labels may stand (map/labelpass.mjs, UX brief §11.6)
  /**
   * The HUD's rectangles over the map, which no label of the map may stand under: `[{x, y, width, height}]` (or
   * `{left, top, right, bottom}`) in client px, as getBoundingClientRect gives them (the dial, the village plate,
   * the dock, the minimap, the button columns). `null`: the map measures the page's known elements itself
   * (NOGO_SELECTORS), a few times a second.
   */
  setNoGo(rects) { this.nogoFed = Array.isArray(rects) ? rects.map(rectOf).filter(Boolean) : null; this.tick(); }
  /**
   * Put a tile's label pile away (`on` true) while an effect plays there, and bring it back (`on` false).
   * `tile`: "P,Q,tile" or `{p, q, tile}`. Counted: two effects on one tile each hide and show once.
   */
  hideLabelsAt(tile, on = true) {
    const key = tileKeyOf(tile);
    if (!key) return;
    const H = this.hiddenLabels ??= new Map(), n = (H.get(key) ?? 0) + (on ? 1 : -1);
    if (n > 0) H.set(key, n); else H.delete(key);
    this.tick();
  }
  /**
   * A set piece has the stage (a battle the camera was sent to) or is over: while one plays the map's words are
   * put away (names, plates, tags, pins: they lie above the effects' canvas and its dim would not reach them) and
   * the pointer home stands aside. Counted like hideLabelsAt. The words go and come back over PIECE_LABELS_MS.
   */
  setPiece(on = true) { this.pieces = Math.max(0, (this.pieces ?? 0) + (on ? 1 : -1)); this.tick(); }
  get piece() { return (this.pieces ?? 0) > 0; }
  /**
   * How far above tile (p, q, tile) the top of its label pile stands (px from the map's own top; null when the
   * tile carries none): the page's own things that point at a tile (the objective's chip) stand above that.
   */
  pileTop(p, q, tile) {
    const u = this.villageAt(p, q, tile);
    return u ? this.project(u.x, u.y, { box: true }).y - plateRise(u, this.cam.drawn.zoom) : null;
  }
  /** The village the tile view draws on tile (p, q, tile), or null (the tile model's own tile: map/sprites.mjs). */
  villageAt(p, q, tile) {
    if (this.drawnLod !== 'tile' || !Number.isInteger(tile)) return null;
    const u = this.art?.modelNow?.byId?.get(`${p},${q},${tile}`);
    return u && u.state === 1 && u.owner < 6 && u.site !== undefined ? u : null;
  }
  /** How far above the centre of place `at` `{p, q, tile}` its label pile reaches at zoom `z` (screen px), or null when it carries none. */
  pileRise(at, z) { const u = at ? this.villageAt(at.p, at.q, at.tile) : null; return u ? plateRise(u, z) : null; }
  /** The no-go rectangles in px from the map's own corner (read from the page at most a few times a second). */
  nogoBoxes() {
    const c = this.canvas, doc = c?.ownerDocument;
    if (!doc?.querySelectorAll || !c.getBoundingClientRect) return [];
    const now = clock();
    if (this.nogoNow && now - this.nogoAt < NOGO_EVERY_MS && this.nogoSrc === this.nogoFed) return this.nogoNow;
    const r = c.getBoundingClientRect(), out = [];
    const add = b => { if (!b || b.x + b.w <= r.left || b.x >= r.right || b.y + b.h <= r.top || b.y >= r.bottom) return; out.push({ x: b.x - r.left, y: b.y - r.top, w: b.w, h: b.h }); };
    if (this.nogoFed) for (const b of this.nogoFed) add(b);
    else for (const el of doc.querySelectorAll(NOGO_SELECTORS)) {
      if (el.hidden || el.closest?.('[hidden]')) continue;
      const b = rectOf(el.getBoundingClientRect?.());
      // (something that covers most of the map is not a thing to step around: a sheet, a wide document)
      if (b && b.w * b.h < r.width * r.height * 0.5) add(b);
    }
    this.nogoNow = out; this.nogoAt = now; this.nogoSrc = this.nogoFed;
    return out;
  }
  /** The label pass of a frame at zoom `z` (`screen`: the labels stand upright on the flat canvas over the tilted board). */
  labelPass(z, screen = true) {
    const size = this.size(), hidden = this.hiddenLabels;
    const tab = screen ? this.pointer?.box?.() ?? null : null;
    return createLabelPass({ nogo: screen ? (tab ? [...this.nogoBoxes(), tab] : this.nogoBoxes()) : [], zoom: z, hidden: hidden?.size ? hidden : null, bounds: screen ? { w: size.width, h: size.height } : null,
      screen: screen ? (x, y) => this.project(x, y, { box: true }) : null });
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
    if (!auto) { this.cam.userMoved = true; this.moves = (this.moves ?? 0) + 1; }
    this.cam.set(v, move);
    this.sync();
  }

  /** The picture waits at `view` while the logical view is already where it will go (the opening behind the title): no move until one is asked for. */
  hold(view) {
    if (this.cam.reduced()) return;
    this.cam.tween = null;
    this.cam.drawn = { ...this.cam.drawn, ...view };
    this.dirty = true;
  }

  /** After the logical view changed: the LOD, the canvas marks, the buttons, the page. */
  sync() {
    this.lod = lodFor(this.cam.view.zoom, this.lod, this.edges());
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
    return clamp && size.width > 0 && size.height > 0 ? clampCentre(out, { ringsOpen: this.ringsNow(), size, soft, inset: this.inset() }) : out;
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
    const to = exact || !(size.width > 0) ? { x: pt.x, y: pt.y, zoom } : this.aim(pt, zoom, size);
    this.setView(to, { auto, ms: ms ?? flightMs(this.cam.drawn, to, size), kind: 'fly' });
  }

  /**
   * Fly to a place the page names (`wylls:fly-to`): `{p, q, tile}`, or `{p, q, site}` (the site's tile, once its
   * province's terrain is known), or `{p, q}` (the province). Near enough to see its tiles; a closer view is kept.
   * Returns whether there was a place to go to.
   */
  flyToPlace(d) {
    if (!d || !Number.isInteger(d.p) || !Number.isInteger(d.q)) return false;
    const terrainOf = this.source?.()?.terrainOf ?? this.terrainOf;
    const tile = Number.isInteger(d.tile) ? d.tile : Number.isInteger(d.site) ? terrainOf?.(d.p, d.q)?.sites?.[d.site] : null;
    this.flyTo({ p: d.p, q: d.q, tile: Number.isInteger(tile) ? tile : undefined, zoom: Math.max(this.cam.view.zoom, Number.isFinite(d.zoom) ? d.zoom : FLY_TO_ZOOM) });
    return true;
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
      const to = this.aim(plan.at, plan.view.zoom, size, inset);
      this.setView(to, { ms: flightMs(this.cam.drawn, to, size), kind: 'fly' });
      return;
    }
    const at = own.map(placePoint);
    // (the world point in the middle of the part of the picture nothing covers, where the camera is going)
    const f = (c => this.unproject(size.width / 2 + c.x, size.height / 2 + c.y, { logical: true, box: true }))(freeBox(size, inset));
    const here = at.findIndex(c => Math.hypot(c.x - f.x, c.y - f.y) < RADIUS * 0.5);
    const c = at[here >= 0 ? (here + 1) % at.length : Math.min(at.length - 1, Math.max(0, src.open?.active ?? 0))];
    this.flyTo({ x: c.x, y: c.y, zoom: Math.max(this.cam.view.zoom, heroZoom(this.dpr())) });
  }

  /**
   * The landing of a village (UX brief §5.1): its colour floods outward ring
   * by ring, the border draws on, the standard drops in with dust; the
   * camera flies there first (`fly`). `v` = `{p, q, tile}`, or none for the
   * viewer's active village. Under reduced motion nothing plays: the land is
   * simply there. Returns whether there was a village to land on. Open to
   * the effects engine and its demo switch (it reads the same clock,
   * `globalThis.__fxNow`).
   */
  playLanding(v = null, { fly = true } = {}) {
    const src = this.source?.() ?? {};
    const own = (src.own ?? []).filter(o => Number.isInteger(o.p) && Number.isInteger(o.q) && Number.isInteger(o.tile));
    const at = v && Number.isInteger(v.tile) ? v : own[Math.min(own.length - 1, Math.max(0, src.open?.active ?? 0))];
    if (!at) return false;
    this.landing = reducedMotion() ? null : { key: villageKey(at), t0: fxNow() };
    this.tellLanding(at, src);
    if (fly) this.flyTo({ p: at.p, q: at.q, tile: at.tile, zoom: Math.max(this.cam.view.zoom, heroZoom(this.dpr())) }, 900, { auto: !this.cam.userMoved });
    this.tick();
    return true;
  }

  /**
   * The landing waits for the picture (the second review: the colour was flooding while the camera was still on its
   * way, and the moment was over before anyone was looking). A landing the page reports is first `arriving`: the
   * camera flies to the village, the land is not yet in its colour; once the camera has stood still for
   * LANDING_REST ms (and the ground is drawn) the timeline starts and the effects are told. It never waits longer
   * than LANDING_WAIT ms.
   */
  landingBeat() {
    const l = this.landing;
    if (!l?.arriving) return;
    const fx = fxNow();
    l.since ??= fx;
    const ready = !this.cam.moving && !this.landingFly && !!this.painted;
    if (!ready) l.rest = null; else l.rest ??= fx;
    if ((l.rest !== null && fx - l.rest >= LANDING_REST) || fx - l.since >= LANDING_WAIT) {
      l.arriving = false; l.t0 = fx;
      if (l.at) this.tellLanding(l.at);
      // a second after the standard stands the camera eases back to the everyday frame (unless a person took the camera)
      const maxD = 2, T = LANDING;
      if (l.at && l.moves === (this.moves ?? 0)) this.landingBack = { at: l.at, when: fx + T.floodAt + maxD * T.ring + T.borderGap + T.standardGap + T.drop + LANDING_HOLD, moves: l.moves };
    }
    this.dirty = true;
  }

  /** The camera's way back from a landing's close frame to the hero zoom, once (never against a person's own move). */
  landingEase() {
    const b = this.landingBack;
    if (!b || fxNow() < b.when) return;
    this.landingBack = null;
    const hero = heroZoom(this.dpr());
    if (b.moves !== (this.moves ?? 0) || !(this.cam.view.zoom > hero * 1.02)) return;
    const size = this.size(), to = this.aim(placePoint(b.at), hero, size);
    this.setView(to, { auto: true, ms: 1100, kind: 'fly', ease: EASE.inOutCubic });
  }

  /**
   * A landing begins: said on the effects bus (fx/stage.mjs plays the dust and sparks where the standard comes
   * down, the shake, the sounds and the village's name) with the moments of the map's own timeline
   * (map/ownland.mjs LANDING), in seconds. Under reduced motion the land is simply there, and so is the word.
   */
  tellLanding(at, src = this.source?.() ?? {}) {
    const h = tileHex(at.p, at.q, at.tile);
    if (!h) return;
    const own = (src.own ?? []).find(o => villageKey(o) === villageKey(at)) ?? at;
    const maxD = WORKED_RADIUS[Math.max(0, Math.min(WORKED_RADIUS.length - 1, Number(own.tier ?? 0)))] ?? 1, T = LANDING;
    const c = project(h.q, h.r), u = standardUnit(this.cam.view.zoom) / STANDARD_UNIT;
    // (`replay`: the demo switch plays the landing of a village that landed long ago)
    fxEmit('landing', { p: at.p, q: at.q, tile: at.tile, faction: src.viewerFaction ?? null, name: own.name ?? null, maxD, replay: !!this.keepLanding, flood: T.floodAt / 1000,
      impact: (T.floodAt + maxD * T.ring + T.borderGap + T.standardGap + T.drop * T.impact) / 1000, standard: { x: c.x + STANDARD_AT.x * u, y: c.y + STANDARD_AT.y * u } });
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
    const s = this.size(), f = freeBox(s, this.inset());
    this.zoomAt(factor, s.width / 2 + f.x, s.height / 2 + f.y, { ms });
  }

  /**
   * Zoom by `factor` keeping the world point seen at (bx, by) (px from the map's own corner) where it is; the
   * picture eases there when `move.ms`. The board's angle changes with the zoom, so the point is found on the
   * board as it is and put back on the board as it will be.
   */
  zoomAt(factor, bx, by, move = {}) {
    const s = this.size(), v = this.cam.view;
    const z = this.clampZoom(v.zoom * factor, s);
    const a = this.geo(v.zoom, s).toStage(bx, by), b = this.geo(z, s).toStage(bx, by);
    const wx = v.x + (a.x - s.width / 2) / v.zoom, wy = v.y + (a.y - s.height / 2) / v.zoom;
    this.setView({ x: wx - (b.x - s.width / 2) / z, y: wy - (b.y - s.height / 2) / z, zoom: z }, { clamp: true, ...move, anchor: { x: b.x - s.width / 2, y: b.y - s.height / 2 } });
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
    // Where an event is: `bx`, `by` px from the map's own corner (never offsetX: under a transform it lies), and
    // `x`, `y` the stage point seen there (the flat picture every formula of the map speaks; map/tilt.mjs).
    const at = e => {
      const real = Number.isFinite(e.clientX) && typeof c.getBoundingClientRect === 'function';
      const r = real ? this.rect() : null, bx = real ? e.clientX - r.left : e.offsetX, by = real ? e.clientY - r.top : e.offsetY;
      const p = this.geo().toStage(bx, by);
      return { x: p.x, y: p.y, bx, by };
    };
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
      if (!prev) {
        if (e.pointerType === 'mouse') {
          const v = this.cam.drawn, hit = pick(v, this.size(), p.x, p.y);
          // (where the mouse rests: when the picture moves under it, what is under it is asked again: rehover)
          this.mouse = { bx: p.bx, by: p.by, view: `${v.x}|${v.y}|${v.zoom}`, id: hoverId(hit) };
          this.setHover(hit); this.onHover(hit, { x: p.bx, y: p.by });
        }
        return;
      }
      this.mouse = null;
      this.setHover(null);
      this.onHover(null);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        this.pointers.set(e.pointerId, p);
        const [a2, b2] = [...this.pointers.values()];
        const after = Math.hypot(a2.x - b2.x, a2.y - b2.y);
        if (before > 0) this.zoomAt(after / before, (a2.bx + b2.bx) / 2, (a2.by + b2.by) / 2);
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
    c.addEventListener('pointerleave', () => { this.mouse = null; this.setHover(null); this.onHover(null); });
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      // the wheel takes over a flight where the picture is; its own easing is only retargeted
      if (this.cam.tween && this.cam.tween.tag !== 'wheel' && this.cam.halt()) this.sync();
      const p = at(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), p.bx, p.by, { ms: MOVE_MS.wheel, tag: 'wheel' });
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
   * The picture moved under a resting mouse (keys, a flight, the drawer opening and the map framing its subject
   * again): once another tile lies under it, the lit hexagon and the page's hover tip are put away, and they come
   * back with the mouse's next move. Nothing is said about a tile the pointer has left, and nothing is said about
   * the tile that slid under it either: the person did not point at that one.
   */
  rehover(v, size) {
    const m = this.mouse;
    if (!m) return;
    const view = `${v.x}|${v.y}|${v.zoom}`;
    if (m.view === view) return;
    m.view = view;
    const p = this.geo(v.zoom, size).toStage(m.bx, m.by);
    if (hoverId(pick(v, size, p.x, p.y)) === m.id) return;
    this.mouse = null;
    this.setHover(null);
    try { this.onHover(null); } catch { /* the page's own follower */ }
  }

  /** The tile under the pointer (a pick, or null): the map lights it (UX brief §5.2). */
  setHover(hit) {
    const h = hit && Number.isInteger(hit.idx) && this.lod === 'tile' ? { q: hit.tileQ, r: hit.tileR, p: hit.p, pq: hit.q, idx: hit.idx } : null;
    if ((h?.q ?? null) === (this.hover?.q ?? null) && (h?.r ?? null) === (this.hover?.r ?? null)) return;
    this.hover = h;
    this.tick();
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
    // a lit reach is framed (frameReach): the opening view waits until that host is let go, then frames its subject again
    if (this.reachFit?.held && this.opened) { this.openKey = null; return true; }
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
    // (the plan's view is the flat one: the subject goes where it is seen in the middle of the uncovered part)
    const to = this.aim(plan.at, plan.view.zoom, size, inset);
    this.setView(to, { auto: true });
    const f = (b => ({ x: b.x, y: b.y }))(freeBox(size, inset));
    // where an opening starts: a player's land is reached from a little above
    const start = plan.kind === 'fit' ? null : this.aim(plan.at, Math.max(ZOOM_MIN, to.zoom * OPEN_FROM), size, inset);
    if (title) {
      // the title is an opaque scene of its own (UX brief §11.9): behind it the camera waits at the opening's start,
      // whatever changes there (the viewer becomes known, the window changes size). Nothing travels unseen
      if (start) this.hold(start);
      this.reveal = undefined;
    } else if (!prev || prev.title) {
      // the first picture, or the title was put away: the opening plays now, and the land comes out of the bare table
      if (start) this.cam.from(prev ? was : start, { ms: MOVE_MS.open, ease: EASE.outCubic, anchor: f });
      this.reveal = now;
    } else if (prev.width !== size.width || prev.height !== size.height) {
      // a new canvas size: framed again, at once
    } else if (prev.subject === subject) {
      // only the sheets moved (a phone's sheet opened or closed): the subject slides back into the uncovered part
      this.cam.from(was, { ms: MOVE_MS.settle, ease: EASE.outCubic });
    } else if (plan.kind !== 'fit') {
      // the viewer became more: fly the rest of the way
      // (the nation choice turns from one nation's wedge to the next: a short glide, not an opening)
      this.cam.from(was, { ms: plan.kind === 'frame' && prev.kind === 'frame' ? MOVE_MS.fly : MOVE_MS.open, ease: plan.kind === 'frame' ? EASE.inOutCubic : EASE.outCubic, kind: plan.kind === 'frame' ? 'anchor' : 'fly' });
    }
    return true;
  }

  draw(now = clock()) {
    this.dirty = false;
    const staged = !!this.stage, gcv = this.ground;
    // the ground is painted edge to edge every frame: no alpha to blend with the page
    const ctx = gcv.getContext?.('2d', { alpha: false });
    // what must stay upright and crisp (names, pills, tags) is drawn on this canvas, flat above the tilted stage
    // (map/tilt.mjs upright); without a stage it is the ground's own canvas
    const octx = staged ? this.canvas.getContext?.('2d') : ctx;
    if (!ctx || !octx) return;
    PROBE.begin();
    const dpr = this.dpr();
    const { width, height } = this.size();
    if (!(width > 0) || !(height > 0)) return;
    const size = { width, height };
    // the ground canvas reaches past the map's box (the tilted board must fill the picture): it has a flat view of its own
    const G = this.groundLayout(size), gsize = { width: G.width, height: G.height };
    // (the tilt draws the near half of the board a little larger than it was painted: on a screen of one device
    // pixel per CSS pixel the ground is painted that much finer, so nothing is stretched)
    const gr = this.groundRatio();
    const W = Math.round(G.width * gr), H = Math.round(G.height * gr);
    if (gcv.width !== W || gcv.height !== H) { gcv.width = W; gcv.height = H; this.sceneKey = null; this.fade = null; }
    const OW = Math.round(width * dpr), OH = Math.round(height * dpr);
    if (staged && (this.canvas.width !== OW || this.canvas.height !== OH)) { this.canvas.width = OW; this.canvas.height = OH; }
    // the table the world's sheet lies on (map/table.mjs): stained boards and a pool of lamp light, laid on the world
    const table = (g, view = groundView(this.cam.drawn, G)) => paintTable(g, { view, size: gsize, ratio: gr, sheet: sheetOf(this.rings ?? 1) });
    const inset = this.inset();
    // the depth dressing: on the page, over the stage (custom properties of #map-dress); on a map without a stage, in the canvas
    const dressing = (zoom, deg = 0, shown = 1, haze = 1) => {
      if (staged) { this.dressPage(deg, { near: nearness(zoom), shown, inset, haze }); return; }
      const step = Math.round(nearness(zoom) * 16);
      this.stamped(ctx, 'dressCv', `${W}x${H}|${step}|${inset.top},${inset.right},${inset.bottom},${inset.left}`, W, H, dpr, g => paintDressing(g, size, { near: step / 16, inset }));
    };
    const wipe = () => { if (staged) { octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, OW, OH); } };
    const src = this.source();
    this.rings = src.ringsOpen ?? 1;
    if (!this.open(src, size, { dpr, now })) {
      // who is looking is not known yet: the bare table, never the whole world first (painted once: it does not change)
      if (this.bare !== `${W}x${H}`) { table(ctx); this.bare = `${W}x${H}`; }
      wipe();
      dressing(0);
      this.updatePointer(null);
      PROBE.end('wait', ctx);
      return;
    }
    this.bare = null;
    const v = this.cam.drawn, logical = this.cam.view;
    this.rehover(v, size);
    // the board's angle on screen follows the zoom on screen; `gv` is the ground canvas's own flat view of the same picture
    const T = this.geo(v.zoom, size), gv = groundView(v, G);
    // what stands on the board stands upright: at world point (x, y) the tilt asks this of a picture drawn in the plane (map/tilt.mjs standing)
    const up = T.flat ? null : (x, y) => T.standAt((x - v.x) * v.zoom + width / 2, (y - v.y) * v.zoom + height / 2);
    const quadOf = (view, t) => (t.flat ? null : t.quad().map(p => ({ x: view.x + (p.x - width / 2) / view.zoom, y: view.y + (p.y - height / 2) / view.zoom })));
    // (the edges between the levels follow the far view of this canvas: a new size, or a ring opening, may move them)
    const E = this.edges(size), now0 = lodFor(logical.zoom, this.lod, E);
    if (now0 !== this.lod) { this.lod = now0; this.mark(); this.syncTools(); this.onView(logical, this.lod); }
    const was = this.drawnLod, lod = lodFor(v.zoom, was, E);
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
        this.paintScene(ctx, src, gv, was, gsize, gr, { now, table, quad: quadOf(v, T), up });
        g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'copy'; g.drawImage(gcv, 0, 0); g.globalCompositeOperation = 'source-over';
        this.fadeCv = cv;
        this.fade = { view: { ...gv }, since: now, t0: null };
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
      for (const pr of visibleProvinces(groundView(logical, G), gsize, Math.max(0, this.rings - 1) + 1, quadOf(logical, this.geo(logical.zoom, size)))) { terrainOf?.(pr.p, pr.q); if (this.art && ringOf(pr.p, pr.q) < this.rings && (src.survey?.province(pr.p, pr.q).max ?? L3) >= L2) src.provinceOf?.(pr.p, pr.q); }
    }
    // away from the tile view its still layers are let go (two bitmaps the size of the canvas)
    if (lod !== 'tile' && this.layers) this.layers = null;
    const out = this.paintScene(ctx, src, gv, lod, gsize, gr, { now, rest, table, artZoom: Math.max(v.zoom, logical.zoom), quad: quadOf(v, T), up });
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
        const f = this.fade.view, s = gv.zoom / f.zoom;
        ctx.save();
        ctx.globalAlpha = 1 - EASE.inOutCubic(Math.max(0, k));
        ctx.setTransform(s, 0, 0, s, gr * ((G.width / 2) * (1 - s) + (f.x - gv.x) * gv.zoom), gr * ((G.height / 2) * (1 - s) + (f.y - gv.y) * gv.zoom));
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
    // a set piece has the stage: the words fade out, and back in after it (at once when nothing may move)
    const want = this.piece ? 0 : 1, had = this.wordsShown ?? 1;
    if (had !== want) {
      const dt = this.wordsAt === undefined || !(now - this.wordsAt > 0) ? 1000 / 60 : Math.min(50, now - this.wordsAt);
      this.wordsShown = motion ? Math.max(0, Math.min(1, had + (want > had ? 1 : -1) * dt / PIECE_LABELS_MS)) : want;
      if (this.wordsShown !== want) this.dirty = true;
    }
    this.wordsAt = now;
    const words = this.wordsShown ?? 1;
    // (the far edge's haze goes with the words: over a map dimmed for a battle it would be a lighter slab)
    dressing(v.zoom, T.deg, shown, words);
    wipe();
    if (shown > 0.4 && words > 0.02) {
      // each label stands upright around its own place on the board (map/tilt.mjs)
      if (staged) armUpright(octx, { place: (x, y) => T.toBox((x - v.x) * v.zoom + width / 2, (y - v.y) * v.zoom + height / 2), zoom: v.zoom, ratio: dpr, scaleAt: T.flat ? null : (x, y) => T.scaleAt((y - v.y) * v.zoom + height / 2) });
      octx.save(); octx.globalAlpha = shown * words;
      out.over(octx, staged ? [dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * (width / 2 - v.x * v.zoom), dpr * (height / 2 - v.y * v.zoom)] : null);
      octx.restore();
      disarmUpright(octx);
    }
    ctx.setTransform(gr, 0, 0, gr, 0, 0);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.updatePointer(src, v, size, inset);
    this.mark(lod === this.lod && out.wanted > 0 && out.drawn === out.wanted ? 'ready' : 'pending');
    PROBE.end(out.kind, ctx);
    PROBE.paint(octx, size);
    try { this.onDraw?.(v, size, lod); } catch { /* the page's own follower */ }
  }

  /**
   * What lies under the world: the table and the sheet (map/table.mjs). Both are still and lie on the world, so
   * they are painted once into a picture of the part of the world around the view (a third wider on every side)
   * and copied from it frame by frame; the picture is made again when the view leaves it or the zoom has moved a
   * step. Deep inside the land nothing of either can show: one flat fill of paper stands in until the land's
   * own bitmaps are there. `seen` and `corners`: the part of the world on the canvas.
   */
  backdrop(g, { view, size, ratio, sheet, paperRes, seen, corners, ringsOpen }) {
    const W = g.canvas?.width ?? Math.round(size.width * ratio), H = g.canvas?.height ?? Math.round(size.height * ratio);
    g.setTransform(1, 0, 0, 1, 0, 0);
    // (inland: every sample of the picture has land five tiles deep around it; the land is close to convex)
    const field = seaField(ringsOpen);
    let inland = true;
    for (let j = 0; j < 4 && inland; j++) for (let i = 0; i < 5 && inland; i++) inland = field.inland(seen.x0 + ((seen.x1 - seen.x0) * i) / 4, seen.y0 + ((seen.y1 - seen.y0) * j) / 3);
    if (inland) { g.fillStyle = CHART.paper; g.fillRect(0, 0, W, H); return; }
    const px = ratio * view.zoom, w = seen.x1 - seen.x0, h = seen.y1 - seen.y0;
    const doc = this.canvas.ownerDocument;
    let b = this.under;
    // while the camera travels a picture made a little finer than the screen serves a range of zooms; at rest it is
    // made for the screen's own pixels (a plain copy, and sharp)
    const moving = this.cam.moving || !!this.drag?.moved;
    const cap = wide => Math.sqrt(BACKDROP_PIXELS / (wide * wide * w * h));
    const fits = b && b.rings === ringsOpen && b.paper === paperRes && seen.x0 >= b.x0 && seen.y0 >= b.y0 && seen.x1 <= b.x1 && seen.y1 <= b.y1
      && (moving ? px <= b.res * 1.02 && px >= b.res * 0.7 : Math.abs(px - b.res) < 1e-9 || (px > b.res && b.res >= cap(1.68) * 0.999));
    if (!fits) {
      // a third more on every side (never more than BACKDROP_PIXELS in all)
      const x0 = seen.x0 - w * 0.34, y0 = seen.y0 - h * 0.34, bw = w * 1.68, bh = h * 1.68;
      const res = Math.min(moving ? px * 1.12 : px, cap(1.68));
      const cw = Math.max(1, Math.ceil(bw * res)), ch = Math.max(1, Math.ceil(bh * res));
      const cv = b?.cv && b.cv.width === cw && b.cv.height === ch ? b.cv : spareCanvas(doc, cw, ch), bg = cv?.getContext?.('2d', { alpha: false });
      if (!bg) {
        // no spare canvas: straight onto the picture
        if (tableShows(corners, sheet)) paintTable(g, { view, size, ratio, sheet });
        g.setTransform(ratio * view.zoom, 0, 0, ratio * view.zoom, ratio * (size.width / 2 - view.x * view.zoom), ratio * (size.height / 2 - view.y * view.zoom));
        paintSheet(g, sheet, { box: seen, res: paperRes, zoom: view.zoom });
        return;
      }
      const box = { x0, y0, x1: x0 + bw, y1: y0 + bh };
      paintTable(bg, { view: { x: x0 + bw / 2, y: y0 + bh / 2, zoom: res }, size: { width: bw * res, height: bh * res }, ratio: 1, sheet });
      bg.setTransform(res, 0, 0, res, -x0 * res, -y0 * res);
      paintSheet(bg, sheet, { box, res: paperRes, zoom: view.zoom });
      b = this.under = { cv, ...box, res, rings: ringsOpen, paper: paperRes };
    }
    const k = b.res;
    // (pixel for pixel when the picture was made for this zoom: a copy)
    if (Math.abs(px - k) < 1e-9) { g.drawImage(b.cv, Math.round((seen.x0 - b.x0) * k), Math.round((seen.y0 - b.y0) * k), W, H, 0, 0, W, H); return; }
    g.imageSmoothingEnabled = true;
    g.drawImage(b.cv, (seen.x0 - b.x0) * k, (seen.y0 - b.y0) * k, w * k, h * k, 0, 0, W, H);
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
   * One picture of the world at `view` and `lod` into `ctx` (the ground
   * canvas: `view` and `size` are its own flat view and box; `quad` the part
   * of the world a tilted board shows of it). Returns `{wanted, drawn, kind,
   * over, pending}`: the tile LOD's terrain state, what kind of frame it was
   * ('full' | 'live' | 'far'), `over(o, world)`, which paints what is read
   * rather than looked at (labels, warnings' words, pins, the guide's words)
   * into `o`, the label canvas, whose own flat transform is `world`
   * (default: this canvas), and how much art of this picture is still on
   * its way.
   */
  paintScene(ctx, src, view, lod, size, dpr, { now = clock(), rest = false, artZoom = view.zoom, table = () => {}, quad = null, up = null } = {}) {
    const { width, height } = size, z = view.zoom;
    const world = [dpr * z, 0, 0, dpr * z, dpr * (width / 2 - view.x * z), dpr * (height / 2 - view.y * z)];
    // what lies under the art: the table, and the provinces drawn as plain cells (no terrain yet, or no art);
    // painted onto the canvas, or once into the ground layer of a resting tile view
    const plain = [];
    const ringsOpen = src.ringsOpen ?? 1, own = src.own ?? [];
    // the sheet the world is drawn on (map/table.mjs), and the table where the picture reaches past it. The paper's
    // grain is made for the same resolution as the provinces' own sheets (the tile view's sprite set, the far
    // bitmaps' step), so the paper is one
    const sheet = sheetOf(ringsOpen);
    const paperRes = lod === 'tile' ? artSize(RADIUS * Math.max(z, artZoom) * dpr).r / RADIUS : farRes((this.cam.moving ? Math.min(z, this.cam.view.zoom) : z) * dpr);
    const seen = { x0: view.x - width / 2 / z, y0: view.y - height / 2 / z, x1: view.x + width / 2 / z, y1: view.y + height / 2 / z };
    const corners = [{ x: seen.x0, y: seen.y0 }, { x: seen.x1, y: seen.y0 }, { x: seen.x1, y: seen.y1 }, { x: seen.x0, y: seen.y1 }];
    const under = g => {
      this.backdrop(g, { view, size, ratio: dpr, sheet, paperRes, seen, corners, ringsOpen });
      g.setTransform(...world);
      for (const f of plain) f(g);
    };
    const maxRing = Math.max(0, ringsOpen - 1) + CLOUD_RINGS;
    const recs = new Map();
    // (an overview's clash flag speaks of the overview's own bell: an overview older than the last bell says nothing
    // about now, so the flag is dropped from what the painters see, and nothing reads "a clash this bell" for history)
    const bellNow = Number.isInteger(src.bell) ? src.bell : null;
    for (const ov of src.overviews?.values?.() ?? []) {
      const old = bellNow !== null && Number.isInteger(ov.bell) && ov.bell < bellNow - 1;
      for (const r of ov.provinces) recs.set(`${r.p},${r.q}`, old && r.clash ? this.settled(r) : r);
    }
    const terrainOf = src.terrainOf ?? this.terrainOf;
    // what the viewer has surveyed (map/survey.mjs): one lookup for every painter of this frame. A page with no
    // viewer (the spectator, practice, a test) gives none: every open tile is in sight
    const survey = src.survey ?? (this.openSv?.ringsOpen === ringsOpen ? this.openSv : (this.openSv = openSurvey(ringsOpen)));
    const limited = !survey.showAll;
    // the fog of a province, in the names the province-level painters know: its ring is not open; the survey
    // is off (clear); some of it is in sight; some of it is surveyed (known); else the chart (distant)
    const fogOf = (p, q) => { const sv = survey.province(p, q); return fogLevel({ ringOpen: ringOf(p, q) < ringsOpen, showAll: survey.showAll, known: sv.max >= L2, sightDistance: sv.max === L3 ? 0 : Infinity }); };
    const fogAt = (q, r) => { const at = locate(q, r); return ringOf(at.p, at.q) < ringsOpen ? 'clear' : 'unopened'; };
    let wanted = 0, drawn = 0, kind = 'far', labels = null, pending = 0;
    const artTiles = [], artCells = [];
    for (const pr of visibleProvinces(view, size, maxRing, quad)) {
      const key = `${pr.p},${pr.q}`;
      const fog = fogOf(pr.p, pr.q);
      // (a selected tile has its own ring: only a province chosen as a whole is framed)
      const selProv = !!src.selected && src.selected.p === pr.p && src.selected.q === pr.q;
      const selected = selProv && !Number.isInteger(src.selected.idx);
      // the records of a province reach the painters only when the viewer has surveyed some of it (and what
      // happens there now only when some of it is in sight); the tile model then gates tile by tile
      const sv = survey.province(pr.p, pr.q), seen = sv.max >= L2, sight = sv.max === L3;
      const rec = seen ? recs.get(key) : null;
      if (lod === 'tile' && this.art) {
        // Art: every level is drawn as tiles (the chart, muted land, land in sight; unopened as cloud sea)
        // (unopened: its tiles are in the model so the land knows where it ends; the cloud itself is the sea's)
        if (fog === 'unopened') { artTiles.push({ ...pr, fog, selected }); continue; }
        const t = terrainOf?.(pr.p, pr.q);
        wanted++;
        if (t) { artTiles.push({ ...pr, ...t, rec, fog, selected, prov: seen ? src.provinceOf?.(pr.p, pr.q) ?? null : null, clash: sight ? src.clashOf?.(pr.p, pr.q) ?? null : null, pending: sight ? src.pendingOf?.(pr.p, pr.q) ?? null : null }); drawn++; continue; }
        plain.push(g => paintProvince(g, { ...pr, rec, fog, selected, scale: z }));
        continue;
      }
      if (lod === 'tile' && TILE_FOGS.includes(fog)) {
        wanted++;
        const t = terrainOf?.(pr.p, pr.q);
        if (t) {
          plain.push(g => { paintTiles(g, { ...pr, ...t, rec, selectedTile: selProv ? src.selected.idx ?? null : null }); paintVeil(g, { ...pr, fog, scale: z, selected }); });
          drawn++;
          continue;
        }
      }
      // beyond the opened rings there is no land to draw: the cloud sea lies over the sheet there (map/cloudsea.mjs)
      if (fog === 'unopened') continue;
      // Art, far: the land itself, painted once per province (sprites.mjs farBitmap)
      if (this.art) {
        const t = terrainOf?.(pr.p, pr.q);
        if (t) { artCells.push({ ...pr, ...t, rec, fog, selected, prov: seen ? src.provinceOf?.(pr.p, pr.q, { far: true }) ?? null : null, tiers: seen && src.tierOf ? Array.from({ length: 12 }, (_, j) => src.tierOf(pr.p, pr.q, j)) : null }); continue; }
      }
      plain.push(g => paintProvince(g, { ...pr, rec, fog, selected, scale: z }));
    }
    // what is the viewer's own and what the selection can do (UX brief §5): one bundle for this frame's passes
    const F = this.youFrame(src, survey, lod, z, terrainOf);
    F.seen = seen; F.up = up;
    // a resting tile view: the still layers (the table is in the ground layer), then the animated ones
    // (`between`: on the ground, under what stands on it: the viewer's land and the lit tiles, then the effects engine's ground pass)
    // the cloud sea: its still part (the bank and the puffs) and the light and shade that drift over it
    const sea = (g, part) => {
      // (as fine as the screen; in a flight as fine as the coarser of where the camera is and where it goes, so the
      // far view's own pieces carry a flight in, and a flight out makes its few coarse pieces at once)
      const r = this.sea.paint(g, { box: seen, res: seaRes((this.cam.moving ? Math.min(z, this.cam.view.zoom) : z) * dpr), ringsOpen, sheet, now: fxNow(), still: reducedMotion(), part });
      if (r.pending) { pending += r.pending; this.dirty = true; }
      // (the drift moves a few px a second: a frame when it has moved about one)
      else if (r.seen && part !== 'still' && !reducedMotion()) this.invalidateSoon(Math.max(110, Math.min(420, 1300 / (Math.hypot(DRIFT_SPEED.x, DRIFT_SPEED.y) * z))));
      return r;
    };
    const tileOpts = artTiles.length ? { zoom: z, dpr, artZoom, stamp: this.stamp, sea: true, up, seaPass: sea, between: c => { this.groundPass(c, F, 'all'); this.between?.(c, { zoom: z, now }); }, ground: (c, phase) => this.groundPass(c, F, phase), terrainAt: terrainLookup(terrainOf), fogAt, selected: null, viewerFaction: src.viewerFaction ?? null, demoRoads: !!src.demoRoads, ringsOpen: src.ringsOpen ?? null, replayRing: src.artReplayRing ?? null, engineStage: src.engineStage ?? 0, relics: src.relics ?? [], waystones: src.waystones ?? [], demoSpecials: !!src.demoSpecials, rivers: src.rivers ?? [], demoRivers: !!src.demoRivers, alliedPairs: src.alliedPairs ?? [], survey,
      // people (people/crowds.mjs): the source's departures, explores and holder names; tags nearest the view centre first
      people: src.people ? { ...src.people(), centre: { x: view.x, y: view.y } } : null } : null;
    const missed = this.art?.misses ?? 0;
    const layered = tileOpts && rest ? this.paintLayered(ctx, artTiles, tileOpts, world, now, under) : null;
    if (!layered) under(ctx);
    ctx.setTransform(...world);
    // (tiles without the art, ?art=0: the ground marks go straight over the plain tiles)
    if (!tileOpts && lod === 'tile') this.groundPass(ctx, F, 'all');
    if (artCells.length) {
      // while the picture travels, far bitmaps are not painted for zooms it only passes through (the ones at hand
      // are stretched); arriving, they are painted for where it rests
      this.art.paintFar(ctx, artCells, { zoom: z, dpr, terrainAt: terrainLookup(terrainOf), fogAt, alliedPairs: src.alliedPairs ?? [], lod, lens: src.lens ?? 'realm', survey,
        passing: this.cam.moving, resZoom: this.cam.moving ? Math.min(z, this.cam.view.zoom) : z });
      pending += this.art.farPending ?? 0;
    }
    // away from the tile view: the sea over the far picture (at the tile view it lies between the props and the people)
    if (lod !== 'tile' || !tileOpts) { ctx.setTransform(...world); sea(ctx, null); }
    // the marks of the viewer's stage, on the land: the home wedge while there is no village yet; the rim of the village's own land
    const waiting = limited && Number.isInteger(survey.faction) && ['joined', 'ticket', 'refugee'].includes(survey.stage);
    // the wait for the village (map/waitview.mjs): the nation's standard stands in its home wedge; what the countdown says
    const homeAt = waiting ? this.wedgeHome(survey.faction, ringsOpen) : null;
    // (the page's wait view says the same time while it stands open: then the map does not say it a second time)
    const waitSay = waiting && !src.wait?.said ? waitLine(src.wait ?? null) : null;
    // the nation choice (UX brief §7.2): the home wedge of the nation that is looked at is lit on the chart
    const looked = !waiting && limited && Number.isInteger(src.focusNation) ? src.focusNation : null;
    // from afar: the viewer's land in its colour, and on the world chart its village as a gold beacon with its name
    const names = lod === 'world' ? this.farPass(ctx, F) : (lod === 'province' && this.farPass(ctx, F), []);
    // the names a map has (drawn with the other words, upright: `over`)
    let realm = null;
    if (lod === 'world' && (artCells.length || names.length)) {
      const nations = artCells.length > 0 && (src.lens ?? 'realm') !== 'land';
      const box = waiting ? wedgeBox(survey.faction, ringsOpen) : looked !== null ? wedgeBox(looked, ringsOpen) : null;
      // (while the viewer waits for a village the standard's own tag names the nation in its wedge: no second name there)
      realm = o => paintRealmLabels(o, recs, z, src.realmName ?? null, { extra: names, nations, ...(limited ? { min: 3, home: box && !waiting ? { faction: looked, x: box.x, y: box.y } : null,
        seen: (r, j) => { if (survey.province(r.p, r.q).max < L2) return false; const t = terrainOf?.(r.p, r.q), idx = t?.sites?.[j]; return Number.isInteger(idx) && survey.levelOf(r.p, r.q, idx) >= L2; } } : {}) });
    }
    // (nearer than the world chart the wedge that is looked at, or waited in, still carries its nation's name)
    else if (lod !== 'world' && looked !== null) {
      // (close on the bell the wedge runs out of the picture: its name stands where the camera looks, `lookPoint`)
      const f = looked, box = lod === 'tile' ? lookPoint(f, ringsOpen) : wedgeBox(f, ringsOpen);
      if (box) realm = o => paintRealmLabels(o, recs, z, src.realmName ?? null, { nations: false, extra: [{ text: src.realmName?.(f) ?? String(f), x: box.x, y: box.y, below: -14, size: 24, fill: '#fff6e2' }] });
    }
    if (tileOpts) {
      kind = layered === 'live' ? 'live' : 'full';
      // (a frame painted whole: the land and what stands on it, the cloud sea, then what lives)
      if (!layered) {
        this.art.paint(ctx, artTiles, { ...tileOpts, part: 'ground' });
        this.art.paint(ctx, artTiles, { ...tileOpts, part: 'props' });
        ctx.setTransform(...world); sea(ctx, null);
        this.art.paint(ctx, artTiles, { ...tileOpts, part: 'live' });
      }
      labels = (o, pass) => this.art.labels(o, { ...tileOpts, pass });
      pending += this.art.misses - missed;   // sprites still on their way
    }
    // the wedge of the viewer's stage (waited in, or looked at in the nation choice): over the land of every kind of
    // frame (a frame painted whole lays its ground after the far marks: the wedge was lost under it at the tile view)
    ctx.setTransform(...world);
    if (waiting) paintWedge(ctx, survey.faction, ringsOpen, z);
    if (looked !== null) paintWedge(ctx, looked, ringsOpen, z, { lit: true });
    // over what stands on the land: thin outlines of the ground marks, the route, the standards
    this.topPass(ctx, F);
    // the ground marks move: a landing and a roll-out every frame, breathing a few times a second
    if (this.landing || F.rolling || F.shaking) this.dirty = true;
    else if (F.live && !F.still) this.invalidateSoon(90);
    // what was kept in the still ground no longer fits (a roll-out or a landing ended, other tiles are lit): paint it again
    if (F.rebake && this.layers) { this.layers.key = null; this.dirty = true; }
    // what lies on the land stays on the board: the guide's ring (at the tile view it is with the other ground
    // marks), a warning's halo, the rings of the candidate sites
    const guide = F.guide, calm = reducedMotion();
    if (guide && lod !== 'tile') paintGuide(ctx, guide, z, '', 'ring');
    if (src.threats?.length) paintThreats(ctx, src.threats, z, null, 'mark');
    if (limited && survey.candidates?.length) {
      // the surveyors' lines from the standard to the sites, then each site's ring with the wait's slow arc round it
      if (homeAt && lod !== 'world') paintSurveyLines(ctx, homeAt, survey.candidates, { zoom: z, now: F.fx, still: calm });
      paintCandidates(ctx, survey.candidates, z, { still: calm, part: 'mark', share: src.wait?.share ?? null });
    }
    if (homeAt) { standing(ctx, up?.(homeAt.x, homeAt.y) ?? null, homeAt.x, homeAt.y, () => paintWaitStandard(ctx, homeAt, { zoom: z, faction: survey.faction, now: F.fx, still: calm })); if (!calm) this.invalidateSoon(90); }
    // what is read rather than looked at stands upright over the board and its depth dressing: names, labels,
    // warnings' words, pins, the guide's words (`o`: the label canvas; `w`: its flat world transform)
    const over = (o = ctx, w = null) => {
      o.setTransform(...(w ?? world));
      // where this frame's words may stand (map/labelpass.mjs): clear of the HUD, of each other, and not on a tile whose pile is put away
      const pass = F.pass = this.labelPass(z, !!w);
      realm?.(o);
      labels?.(o, pass);
      if (src.threats?.length) { paintThreats(o, src.threats, z, src.threatLabel ?? null, 'label'); this.invalidateSoon(); }
      // the wait's words, the candidates' first: they keep clear of the standard's cloth, and the standard's own tag
      // gives way to them (with sites to look at, the nation's name may be left out where there is no room for it)
      const sites = limited && survey.candidates?.length ? survey.candidates : null;
      if (homeAt) pass.block(homeAt.x, homeAt.y, standardBox(homeAt, z));
      if (sites) { paintCandidateLabels(o, sites, { zoom: z, line: waitSay, pass }); if (!calm) this.invalidateSoon(120); }
      if (homeAt) paintHomeTag(o, homeAt, { zoom: z, faction: survey.faction, line: waitSay, pass, keep: !sites, say: leaderWords(survey.faction, src.wait?.state ?? null) });
      // (a countdown is read to the second: the words are drawn again a few times a second)
      if (waitSay) this.invalidateSoon(400);
      if (src.pins?.length) paintPins(o, src.pins, z);
      // (the page's objective chip may stand at the target itself: then the ring alone marks the tile)
      if (guide && !src.guideChip) paintGuide(o, guide, z, src.guideLabel?.(guide) ?? '', 'label', { rise: this.pileRise(guide, z), pass });
      if (guide) this.invalidateSoon();
      this.overPass(o, F);
    };
    return { wanted, drawn, kind, over, pending };
  }

  // ------------------------------------------------------------------ your land, the lit tiles, where you are (UX brief §5)
  /** An overview record without its clash flag (kept per record: the tile model is rebuilt only when a record changes). */
  settled(r) {
    this.settledOf ??= new WeakMap();
    let v = this.settledOf.get(r);
    if (!v) { v = { ...r, clash: false }; this.settledOf.set(r, v); }
    return v;
  }

  /** What this frame's passes share: the viewer's villages and lands, the lit tiles, the hover, the selection, the clock. */
  youFrame(src, survey, lod, z, terrainOf) {
    const limited = !!survey && !survey.showAll;
    const villages = limited ? (survey.villages ?? []).filter(v => Number.isInteger(v.p) && Number.isInteger(v.q) && Number.isInteger(v.tile)) : [];
    const tile = lod === 'tile';
    const A = tile ? src.actions ?? null : null;
    const sel = tile && src.selected && Number.isInteger(src.selected.idx) ? src.selected : null;
    const selHex = sel ? tileHex(sel.p, sel.q, sel.idx) : null;
    const selOwn = !!sel && (villages.some(v => v.p === sel.p && v.q === sel.q && v.tile === sel.idx) || (!!A && A.mode === 'select'));
    // (the hexagon under the pointer: on land that exists, never on the cloud sea or the table beyond it)
    const hover = tile && this.hover && ringOf(this.hover.p, this.hover.pq) < (src.ringsOpen ?? 1) ? this.hover : null;
    const hoverLit = hover && A ? A.byHex.get(`${hover.q},${hover.r}`) ?? null : null;
    const fx = fxNow(), still = reducedMotion();
    // tiles that have just lit up (a host was selected): said once on the effects bus, where the engine's glow
    // runs over them as they roll out and a tick sounds (fx/stage.mjs); the lasting light is the map's own
    if (A?.mode === 'select' && A.t0 !== this.litT0) {
      this.litT0 = A.t0;
      // (reach is one shape now: the engine's glow is given the targets only, never a frame for every tile of the reach; `reach` says how many tiles it is)
      if (fx - A.t0 < 250) fxEmit('tiles:lit', { origin: A.hex, reach: A.tiles.length, tiles: A.tiles.filter(t => t.kind !== 'move').map(t => ({ q: t.hq, r: t.hr, kind: t.kind })), colours: Object.fromEntries(Object.entries(actionPalette(limited ? survey.faction : null)).map(([k, c]) => [k, c.rim])) });
    } else if (!A) this.litT0 = null;
    // the camera eases out until the reach's edge is in the picture (UX brief §11.7)
    if (A?.mode === 'select') this.frameReach(A); else this.reachFit = null;
    // a village the page says has just landed (and this map has not played yet) starts its landing with this frame
    const want = src.landing;
    this.soonKey = !still && !want ? src.landingSoon ?? null : null;
    if (want?.id && want.id !== this.landed) {
      this.landed = want.id;
      const [lp, lq, lt] = String(want.key).split(',').map(Number);
      const lat = [lp, lq, lt].every(Number.isInteger) ? { p: lp, q: lq, tile: lt } : null;
      // (with motion the camera goes there first and the land waits for it: landingBeat; without, the land is simply there)
      if (!still && lat) { this.landing = { key: want.key, t0: null, arriving: true, at: lat }; this.landingFly = want.at ?? lat; }
      else if (lat) this.tellLanding(lat, src);
    }
    // the guide's target (on the world chart the beacon already marks the viewer's village: no ring is laid over it)
    const g0 = src.guide && !src.route ? src.guide : null;
    const guide = g0 && !(lod === 'world' && villages.some(v => v.p === g0.p && v.q === g0.q && v.tile === g0.tile)) ? g0 : null;
    return { src, survey, lod, z, fx, still, limited, guide, villages, faction: limited ? survey.faction : null, palette: actionPalette(limited ? survey.faction : null), A, selHex, selOwn, hover, hoverLit,
      lands: () => this.ownLands(survey, villages, lod, terrainOf) };
  }

  /** Where the nation's standard stands in its home wedge while the viewer has no village: the middle of a tile near the wedge's own middle (world px), or null. */
  wedgeHome(faction, ringsOpen) {
    const key = `${faction}|${ringsOpen}`;
    if (this.homeKey !== key) {
      this.homeKey = key;
      const box = wedgeBox(faction, ringsOpen);
      if (!box) this.homeNow = null;
      else { const [q, r] = inverseHex(box.x, box.y).split(',').map(Number); this.homeNow = project(q, r); }
    }
    return this.homeNow;
  }

  /**
   * A host was selected and its reach is lit: when the reach's edge is not in the part of the picture nothing
   * covers, the camera eases out (never in) until it is, and no further than the tile view goes. Once per
   * selection, and again when the reach grows (a province arrived) as long as no person has moved the camera
   * since the selection; never after that. The move itself is made by the next frame, never inside a draw.
   */
  frameReach(A) {
    const R = this.reachFit, moves = this.moves ?? 0, size = this.size(), inset = this.inset();
    // (what the sheets cover, in steps: the inspector's drawer opens a moment after the selection, and the reach is framed again in what is left)
    const cover = [inset.top, inset.right, inset.bottom, inset.left].map(n => Math.round((n ?? 0) / 8)).join(',');
    const fresh = !R || R.t0 !== A.t0 || R.id !== A.actor?.id;
    if (!fresh && ((R.n === A.tiles.length && R.cover === cover) || R.moves !== moves)) return;
    this.reachFit = { t0: A.t0, id: A.actor?.id, n: A.tiles.length, cover, moves: fresh ? moves : R.moves, held: fresh ? false : R.held };
    const box = reachBox(A);
    if (!box || !(size.width > 0) || !(size.height > 0)) return;
    const f = freeBox(size, inset), v = this.cam.view, pad = REACH_PAD;
    // in the picture already (as it is seen, tilt and all)?
    const cx = size.width / 2 + f.x, cy = size.height / 2 + f.y;
    const inside = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]].every(([x, y]) => { const p = this.project(x, y, { logical: true, box: true }); return Math.abs(p.x - cx) <= f.width / 2 - pad && Math.abs(p.y - cy) <= f.height / 2 - pad; });
    if (inside) return;
    // (the far rows of a tilted board are drawn smaller and the near rows larger: a little room for both)
    const fit = REACH_FIT * Math.min((f.width - 2 * pad) / (box.x1 - box.x0), (f.height - 2 * pad) / (box.y1 - box.y0));
    const zoom = Math.min(v.zoom, Math.max(this.edges(size).tileIn * REACH_ZOOM_FLOOR, fit));
    this.reachFly = { to: this.aim({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }, zoom, size, inset), moves };
    // (the reach has the camera now: the opening view does not take it back while this host stays selected)
    this.reachFit.held = true;
  }

  /**
   * The viewer's lands (map/ownland.mjs): at the tile view from the tile
   * model, which knows the site that claims each tile; further out by
   * geometry (the tiles a village works, less water and less what is not
   * surveyed).
   */
  ownLands(survey, villages, lod, terrainOf) {
    if (!villages.length) return [];
    if (lod === 'tile' && this.art?.modelNow?.lands?.length) return this.art.modelNow.lands;
    const key = `${survey.rev}|${villages.map(v => `${villageKey(v)},${v.tier ?? 0},${v.state ?? ''},${terrainOf?.(v.p, v.q) ? 1 : 0}`).join(';')}`;
    if (this.farLands?.key !== key) {
      const at = terrainLookup(terrainOf);
      this.farLands = { key, lands: villages.map(v => {
        const h = tileHex(v.p, v.q, v.tile);
        const tiles = h ? landTiles({ q: h.q, r: h.r, tier: v.tier ?? 0 }, (q, r) => at(q, r) !== 'water' && survey.levelAt(q, r) >= L2) : [];
        return { key: villageKey(v), village: v, tiles, shape: landShape(tiles), provisional: v.state === 1 };
      }).filter(x => x.tiles.length) };
    }
    return this.farLands.lands;
  }

  /** The landing's state for a land while it plays (map/ownland.mjs landingAt), else null. */
  floodOf(land, fx) {
    const l = this.landing;
    // (a landing the page is about to report: the land is not in its colour yet either)
    if (!l && this.soonKey && this.soonKey === land.key) return landingAt(-1, land.shape.maxD);
    if (!l || l.key !== land.key) return null;
    // (the camera is still on its way: the land is not in its colour yet)
    const f = landingAt(l.arriving ? -1 : fx - l.t0, land.shape.maxD);
    // (`keepLanding`: the demo switch rewinds the clock, the landing stays to be played again)
    if (f.done) { if (!this.keepLanding) this.landing = null; return null; }
    return f;
  }

  /**
   * On the ground, under what stands on it: the viewer's land, the lit tiles,
   * the hexagon under the pointer, the selection. `phase`:
   *   'all'    everything, alive (a frame painted whole: the camera is moving)
   *   'still'  what does not move, into the still ground layer of a resting view: the land without its
   *            breath, the lit tiles once they are out
   *   'live'   over that layer, every animation frame: only the breath, a roll-out or a landing that is
   *            playing, the hover and the selection (a resting frame costs a few strokes, not the whole land)
   */
  groundPass(ctx, F, phase = 'all') {
    const { z, fx, still } = F;
    const kept = phase === 'still' ? (this.kept = { lands: new Set(), lit: null }) : phase === 'live' ? this.kept ?? { lands: new Set(), lit: null } : null;
    for (const land of F.lands()) {
      const flood = this.floodOf(land, fx), id = `${land.key}|${land.shape.key}|${land.provisional}`;
      if (phase === 'still') { if (!flood) { paintOwnLand(ctx, land, { zoom: z, faction: F.faction, base: true }); kept.lands.add(id); } }
      else if (phase === 'live' && kept.lands.has(id) && !flood) { if (!still) paintOwnBreath(ctx, land, { zoom: z, now: fx }); }
      else { paintOwnLand(ctx, land, { zoom: z, faction: F.faction, now: fx, still, flood }); if (phase === 'live' && !flood) F.rebake = true; }
      F.live = true;
    }
    if (phase === 'live' && kept.lands.size > F.lands().length) F.rebake = true;
    const A = F.A, dim = A?.dest ? 0.5 : 1;
    if (A) {
      const out = still || rolledOut(A, fx);
      const palette = F.palette;
      if (phase === 'still') { if (out) { paintActionGround(ctx, A, { zoom: z, dim, base: true, palette }); kept.lit = A; } }
      else if (phase === 'live' && kept.lit === A) { if (!still) paintActionPulse(ctx, A, { zoom: z, now: fx, dim, palette }); }
      else { F.rolling = paintActionGround(ctx, A, { zoom: z, now: fx, still, dim, palette }) || F.rolling; if (phase === 'live' && (out || kept.lit)) F.rebake = true; }
      F.live = true;
    } else if (phase === 'live' && kept.lit) F.rebake = true;
    if (phase === 'still') return;
    // (the page's own chip may stand at the target and point at it: then no ring is laid around the tile)
    if (F.guide && !F.src.guideChip && this.pileRise(F.guide, z) === null) { paintGuide(ctx, F.guide, z, '', 'ring'); F.live = true; }
    if (F.hover) paintHoverGround(ctx, F.hover, { zoom: z, kind: F.hoverLit?.kind ?? null, palette: F.palette });
    if (F.selHex) { paintSelectionGround(ctx, F.selHex, { zoom: z, own: F.selOwn, now: fx, still }); F.live = true; }
  }

  /** The route under the pointer when it leads to a lit tile: `{hexes, arriveBell, kind}` or null. */
  hoverRoute(F) {
    const r = F.src.hoverRoute, d = F.src.route?.dest ?? null;
    // (not over the destination already chosen: its own route is drawn there)
    // (a tile beyond the lit reach may have a route too: the page asked the planner, and the ribbon answers the pointer there as well)
    if (!r || !F.hover || r.q !== F.hover.q || r.r !== F.hover.r || !(r.hexes?.length > 1) || (d && d.q === r.q && d.r === r.r)) return null;
    return { ...r, kind: F.hoverLit?.kind ?? 'move' };
  }

  /** The map's own answer to a tap (a refusal), while it shows: `{hex, text, age}` or null. */
  noteOf(F) {
    const n = F.src.note;
    if (!n || !Number.isInteger(n.tile)) return null;
    const age = F.fx - n.at;
    if (!(age >= 0) || age > NOTE_MS) return null;
    return { hex: tileHex(n.p, n.q, n.tile), text: n.text, age };
  }

  /** Over what stands on the land: the outlines of the ground marks, the route, the refusal, the standards. */
  topPass(ctx, F) {
    const { z, fx, still, src } = F;
    if (F.lod === 'tile') {
      // a reach is lit by contrast: everything outside it is a little darker (the land, what stands on it, who walks there)
      if (F.A && F.seen) paintReachDim(ctx, F.A, { box: F.seen, now: fx, still, dim: F.A.dest ? 0.5 : 1 });
      // (the gold line of the viewer's land stays in sight through the reach and its dim: drawn again, and stronger then)
      for (const land of F.lands()) { const flood = this.floodOf(land, fx); paintOwnOutline(ctx, land, { zoom: z, shown: flood ? flood.border : 1, strong: !!F.A }); }
      if (F.A) paintActionTop(ctx, F.A, { zoom: z, now: fx, still, dim: F.A.dest ? 0.5 : 1, palette: F.palette });
    }
    // the march being composed (this browser only), and the route to the lit tile under the pointer
    if (src.route?.hexes?.length > 1) { paintRoute(ctx, src.route, z, { now: fx, still, faction: F.faction }); F.live = true; }
    const hr = this.hoverRoute(F);
    if (hr) { paintRibbon(ctx, hr.hexes, { zoom: z, faction: F.faction, proposal: true, now: fx, still }); F.live = true; }
    if (F.lod === 'tile') {
      if (F.hover) paintHoverTop(ctx, F.hover, { zoom: z });
      if (F.selHex) paintSelectionTop(ctx, F.selHex, { zoom: z, own: F.selOwn });
      const note = this.noteOf(F);
      if (note?.hex) { paintRefusal(ctx, note.hex, { zoom: z, age: note.age, still }); if (!still && note.age < 420) F.shaking = true; else this.invalidateSoon(Math.max(30, Math.min(400, NOTE_MS - note.age + 20))); }
    }
    // the standard on each of the viewer's villages (the world chart has the beacon instead)
    if (F.lod !== 'world' && F.villages.length) {
      const u = standardUnit(z), lands = F.lands();
      for (const v of F.villages) {
        const h = tileHex(v.p, v.q, v.tile);
        if (!h) continue;
        const c = project(h.q, h.r), land = lands.find(x => x.key === villageKey(v));
        const flood = land ? this.floodOf(land, fx) : null;
        if (flood && !flood.standard.shown) continue;
        const sx = c.x + STANDARD_AT.x * (u / STANDARD_UNIT), sy = c.y + STANDARD_AT.y * (u / STANDARD_UNIT);
        standing(ctx, F.up?.(sx, sy) ?? null, sx, sy, () => paintStandard(ctx, sx, sy, { u, zoom: z, faction: F.faction, now: fx, still, lift: flood?.standard.lift ?? 0, alpha: flood?.standard.alpha ?? 1, dust: flood?.dust ?? null }));
        F.live = true;
      }
    }
  }

  /** The far views: the viewer's land in its colour; on the world chart each village as a beacon. Returns the names to lay out with the chart's labels. */
  farPass(ctx, F) {
    const { z, fx, still } = F;
    if (!F.villages.length) return [];
    for (const land of F.lands()) paintOwnLand(ctx, land, { zoom: z, faction: F.faction, now: fx, still, flood: this.floodOf(land, fx), far: true });
    F.live = true;
    if (F.lod !== 'world') return [];
    const own = F.src.own ?? [], active = F.survey.home ? villageKey(F.survey.home) : null, lands = F.lands();
    const names = [];
    for (const v of F.villages) {
      const h = tileHex(v.p, v.q, v.tile);
      if (!h) continue;
      const c = project(h.q, h.r), key = villageKey(v);
      paintBeacon(ctx, c.x, c.y, { zoom: z, now: fx, still, active: !active || key === active });
      const name = own.find(o => villageKey(o) === key)?.name ?? null;
      // (no other name stands on the viewer's own land: the land's box is taken, and the village's name hangs under its beacon on a plate)
      const land = lands.find(x => x.key === key), R = land ? (land.shape.maxD + 0.6) * RADIUS : 0;
      names.push({ block: Math.max(30, R * 2 * Math.sqrt(3) / 2 * z * 1.05), blockH: Math.max(30, R * 1.5 * FLATTEN * z * 1.05), x: c.x, y: c.y });
      if (name) names.push({ text: name, x: c.x, y: c.y, below: 11, size: 14, fill: '#fff3cf', tag: true });
    }
    return names;
  }

  /** Over the depth dressing: the words of the ground marks (the provisional tag, the acting host, the arrival, a refusal). */
  overPass(ctx, F) {
    const { z, src } = F, pass = F.pass ?? null;
    // (at the tile view a provisional village's plate carries 仮: map/plates.mjs)
    if (F.lod === 'province') for (const land of F.lands()) paintProvisionalTag(ctx, land, { zoom: z });
    if (F.lod !== 'tile') return;
    const A = F.A;
    const hid = hex => { const at = hex ? locate(hex.q, hex.r) : null; return !!at && !!pass?.hiddenAt(`${at.p},${at.q},${at.idx}`); };
    // the host that acts, under the selected tile (tap the tile again for the next one)
    if (A && A.mode === 'select' && A.hex && !hid(A.hex)) {
      const c = project(A.hex.q, A.hex.r), y = c.y + RADIUS * FLATTEN * 1.04;
      const box = paintTag(ctx, c.x, y, `${actorText(A.actor)}${A.actors.length > 1 ? ` \u00b7 ${A.index + 1}/${A.actors.length}` : ''}`, { zoom: z, tone: 'you', place: 'below', gap: 3, anchor: c, pass });
      const why = blockText(A.actor);
      if (why && box) paintTag(ctx, c.x, box.y + box.h, why, { zoom: z, tone: 'warn', place: 'below', gap: 3, size: 12, anchor: c, pass });
      // what the pale line is, said beside it for the first seconds of a selection: the near reach, and that a march may go further
      const age = F.fx - A.t0, near = reachSteps(A.actor.stamina), top = A.actor.march?.ok && reachSteps(A.actor.stamina, 99) > near ? reachTop(A) : null;
      if (top && (F.still || age < REACH_WORDS_MS)) paintTag(ctx, top.x, top.y, reachText(near), { zoom: z, tone: 'reach', place: 'above', gap: 7, size: 12, alpha: F.still ? 1 : Math.max(0, Math.min(1, (REACH_WORDS_MS - age) / 500)), anchor: top, pass });
      if (top && !F.still && age < REACH_WORDS_MS) this.invalidateSoon(Math.max(40, Math.min(500, REACH_WORDS_MS - age)));
    }
    // when the march would arrive: on the composed route, or on the route under the pointer
    const hr = this.hoverRoute(F);
    const tagAt = (hex, bell, tone) => { const d = project(hex.q, hex.r); paintTag(ctx, d.x, d.y - RADIUS * FLATTEN * 0.82, arrivalText(bell), { zoom: z, tone, place: 'above', gap: 4, anchor: d, pass }); };
    if (hr && Number.isInteger(hr.arriveBell)) tagAt(hr.hexes[hr.hexes.length - 1], hr.arriveBell, 'plain');
    else if (src.route?.dest && Number.isInteger(src.route.arriveBell)) tagAt(src.route.dest, src.route.arriveBell, 'you');
    const note = this.noteOf(F);
    if (note?.hex) {
      const d = project(note.hex.q, note.hex.r), fade = Math.max(0, Math.min(1, (NOTE_MS - note.age) / 400));
      const shake = F.still ? 0 : Math.sin(note.age / 28) * 5 * Math.exp(-note.age / 150);
      paintTag(ctx, d.x, d.y - RADIUS * FLATTEN * 0.82, note.text, { zoom: z, tone: 'refuse', place: 'above', gap: 4, shake, alpha: fade, anchor: d, pass });
    }
  }

  /** The pointer home (map/homepointer.mjs): a gold tab on the map's edge while the viewer's active village is out of the picture; put away while a set piece plays. */
  updatePointer(src, view, size, inset) {
    if (!this.pointer) return;
    const own = src ? (src.own ?? []).filter(o => Number.isInteger(o.p) && Number.isInteger(o.q)) : [];
    const at = own.length && !src.open?.title && !this.piece ? own[Math.min(own.length - 1, Math.max(0, src.open?.active ?? 0))] : null;
    this.pointer.update(at ? edgePointer(view, size, placePoint(at), { inset, geo: this.geo(view.zoom, size) }) : null, { name: at?.name ?? '', avoid: at ? this.nogoBoxes() : [] });
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
    const W = this.ground.width, H = this.ground.height;
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
      opts.ground?.(L.ground.g, 'still');   // the ground marks that do not move are kept with the ground
      const g = L.props.g;
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.setTransform(...world);
      this.art.paint(g, tiles, { ...opts, part: 'props' });
      // the cloud sea's still part is kept with the props; while a piece of it waits its turn the layer is not final
      g.setTransform(...world);
      const sea = opts.seaPass?.(g, 'still');
      L.key = sea?.pending ? null : key; L.at = now;
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy'; ctx.drawImage(L.ground.cv, 0, 0); ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    ctx.setTransform(...world);
    // over the land, under what stands on it: what moves of the ground marks, then the effects engine's ground pass
    if (opts.ground) { opts.ground(ctx, 'live'); this.between?.(ctx, { zoom: opts.zoom, now }); }
    else opts.between?.(ctx);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(L.props.cv, 0, 0); ctx.restore();
    ctx.setTransform(...world);
    opts.seaPass?.(ctx, 'drift');
    this.art.paint(ctx, tiles, { ...opts, part: 'live' });
    return fresh ? 'fresh' : 'live';
  }

  destroy() {
    if (this.raf) globalThis.cancelAnimationFrame?.(this.raf);
    if (this.soon) clearTimeout(this.soon);
    this.resizer?.disconnect?.();
    if (this.onResize) this.canvas?.ownerDocument?.defaultView?.removeEventListener?.('resize', this.onResize);
    if (this.onFlyTo) globalThis.removeEventListener?.('wylls:fly-to', this.onFlyTo);
    this.unlang?.(); this.unredraw?.(); this.tools?.remove(); this.pointer?.remove();
  }
}
