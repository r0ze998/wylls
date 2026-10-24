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
// moved; it is a dive from the waiting sheet, one picture from the first
// frame on (UX brief §13.4: `open`, `draw`). M and the "world chart" button go to the far view and back. The
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
import { L, onLangChange, fmtNum } from '../../lang.mjs';
import { s1On } from '../fs1.mjs';
import { locate, ringOf, ringProvinces, hexDistance, tileHex } from '../fgeo.mjs';
import { fogLevel, paintProvince, paintSigil, paintTiles, paintVeil, provincePixel, PROVINCE_CIRCUMRADIUS } from './layers.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { NATION_ON } from '../palette.mjs';
import { createTerrain } from './terrain.mjs';
import { INERT_CTX, SpriteArt, artSize, farRes, terrainLookup } from './sprites.mjs';
import { paintSheet, paintTable, sheetOf, tableShows } from './table.mjs';
import { CloudSea, DRIFT_SPEED, SEA_BAKES, seaField, seaRes } from './cloudsea.mjs';
import { project, RADIUS, FLATTEN } from '../../map.mjs';
import { Camera, EASE, FAR_CAP, MOVE_MS, ZOOM_GIVE, centreReach, clampCentre, fitView, freeBox, reducedMotion } from './camera.mjs';
import { OPEN_FROM, OPEN_WAIT_MS, heroZoom, lookPoint, openingPlan, placePoint } from './opening.mjs';
import { nearness, paintDressing } from './dressing.mjs';
import { PROBE } from './probe.mjs';
import { L2, L3, openSurvey } from './survey.mjs';
import { CHART, YOURS, fxNow, paintCandidates, paintWedge } from './chart.mjs';
import { wedgeBox } from './opening.mjs';
import { STANDARD_AT, STANDARD_UNIT, landShape, landTiles, landingAt, paintBeacon, paintOwnBreath, paintOwnLand, paintOwnOutline, paintProvisionalTag, paintStandard, standardUnit, villageKey } from './ownland.mjs';
import { reachSteps } from '../hud/reach.mjs';
import { NOTE_MS, reachText, reachTop, actionPalette, actorText, arrivalText, blockText, paintActionGround, paintActionPulse, paintActionTop, paintReachDim, paintLandLens, reachBox, rolledOut, paintHoverGround, paintHoverTop, paintRefusal, paintRibbon, paintSelectionGround, paintSelectionTop, paintTag } from './actions.mjs';
import { edgePointer, mountHomePointer } from './homepointer.mjs';
import { layoutLabels } from './labels.mjs';
import { plateRise } from './plates.mjs';
import { LANDING } from './ownland.mjs';
import { WORKED_RADIUS } from './survey.mjs';
import { emit as fxEmit } from '../fx/bus.mjs';
import { createLabelPass, rectOf, tileKeyOf } from './labelpass.mjs';
import { paintWaitCharacter } from '../people/onboard.mjs';
import { leaderWords, paintCandidateLabels, paintHomeTag, paintSiteMarks, paintSurveyLines, paintWaitStandard, standardBox, waitLine, waitSpotAt, wedgeSites } from './waitview.mjs';
import { TILT, armUpright, disarmUpright, groundBox, groundView, nearQuad, perspFromQuery, standing, tiltAt, tiltFromQuery, tiltGeo, tiltNear, upright } from './tilt.mjs';
import { marchShare, watchOf } from './board.mjs';
import { paintHostRing, MARKER_PX, awayText, awaitKeyText, exploreFlagText, formingText, marchTagText, paintBellTag, paintMarkerDisc, paintSealedMarch, paintSurveyFlag, paintWatch, paintWatchTop, watchTop, LAND_WORDS } from './hostmarks.mjs';
import { PICK_KINDS, pickModel, pickPalette, pickStep } from './picktile.mjs';
import { createSurveyor, packMemory } from './survey.mjs';
import { promotionAt } from './villagework.mjs';
import { surveyInput } from './viewer.mjs';
import { paintPlayerFace } from '../people/faces.mjs';
import { marcherSpots, marcherTop, paintMarcher } from './marcher.mjs';
// the banner rule's prototype (a design; the sample world alone serves its records): map/protoboard.mjs
import { ProtoBoard, POLE_AT } from './protoboard.mjs';
import { protoLandAt } from '../proto/board-model.mjs';
import { protoTag } from './protowords.mjs';
import { PROTO_LOOK, bannerUnit } from './protoland.mjs';
import { syncProtoChip } from './protochip.mjs';
import { setProtoLegend } from './legend.mjs';
// the keeps of a conquest season (the program's version 3): map/keeps.mjs
import { KeepBoard } from './keeps.mjs';
import { paintS1Marks, caravanTagText } from './s1marks.mjs';

/** The zoom below which a lit set is not framed on a narrow screen: neighbouring tiles stand about 44 px apart there (a tile's width is RADIUS × √3 world px, flattened by the tilt). */
export const TOUCH_TILE_ZOOM = 0.87;
/** A watch that is new draws on from its host over this long (ms), and its name stands beside it this long. */
export const WATCH_ON_MS = 600;
export const WATCH_WORDS_MS = 9000;
/** After a person's own move of the map the camera is not taken for this long (ms). */
export const BUSY_MS = 3500;
/** Where the board says, by the village, that the viewer's lead host is away on a sealed march (world px from the tile's centre): where the character stands. */
export const AWAY_AT = Object.freeze({ x: RADIUS * 1.78, y: RADIUS * 0.12 });
/** A pick's lit set takes this much of its colour as a wash (every tile of it may be taken: map/picktile.mjs). */
export const PICK_WASH = 0.16;
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
  { id: 'chart', glyph: '\u25CE', icon: 'M3.5 6.5 9 4.5l6 2 5.5-2v13L15 19.5l-6-2-5.5 2zM9 4.5v13M15 6.5v13', label: () => L`全体図を見る`, labelOn: () => L`もとの場所へ戻る`, text: () => L`全体図`, textOn: () => L`戻る` },
]);

/** Zoom thresholds (screen px per world px) with hysteresis between levels. */
export const LOD_EDGES = Object.freeze({ provinceIn: 0.14, provinceOut: 0.12, tileIn: 0.5, tileOut: 0.45 });
/** The absolute zoom limits. The map itself never goes further out than a little past the far view (zoomMin). */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 2.2;
/** Home's zoom on a dpr-1 screen (opening.mjs heroZoom): tile detail, the holding and the hosts beside it in view. */
export const HOME_ZOOM = 1.15;
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
/** While the camera travels, the kept sheet under the land serves until the zoom has grown this much past the fineness it was made at. */
export const BACKDROP_STRETCH = 1.4;
/** After the camera has come to rest the sheet under the world is laid properly this much later (ms): not in the frame the camera arrives in. */
export const BACKDROP_IDLE_MS = 450;
/** The whole sheet as one picture, for a travelling camera (FrontierMap.quickSheet): at most this many pixels. */
export const SHEET_PIXELS = 4_000_000;
/** A kept sheet this much coarser than the budget would allow for the picture at hand still serves it (it was made for the apron's larger box). */
export const BACKDROP_SHARE = 0.76;
/** On a screen of one device pixel per CSS pixel the tilted ground is painted this much finer (the near half of the board is drawn larger than life). */
export const GROUND_FINER = 1.4;
/**
 * The page's own things over the map that no label may stand under, until the page says them (`map.setNoGo`): the
 * dial and the strip's two sides, the search button and the objective, the to-do lines and the village plate, the
 * minimap with its lens chips, the map's buttons, the dock, the drawer, the objective's chip, a milestone's banner. (The pointer home
 * is the map's own: it keeps clear of these, and the labels keep clear of it.)
 */
/**
 * The kept places (map/labelpass.mjs `hard`): the sample world's tag and the chip of the prototype rule say what is
 * true of the whole screen, and no label of the board stands in them, whatever the page feeds as its no-go list. The
 * map measures them itself, so the place is kept on a page that says nothing of them.
 */
export const KEPT_SELECTORS = '#sample-tag, [data-proto-chip], .proto-chip-map';
/** Air round a kept place (px): a label's own rim and shadow stay clear of the chip's dashed line. */
export const KEPT_AIR = 3;
export const NOGO_SELECTORS = '#bell-pill, #bell-pill .dial-top, #topbar .strip-side, #hud-tl > *, #rail > *, #minimap, .map-tools, #tabs, #panel, #ob-map, .feed > *, #mile-banner';
export const NOGO_EVERY_MS = 300;
/** The air the map's labels keep round the dial beyond its own box (px). */
export const DIAL_AIR = 8;
/**
 * The waiting picture's frame (nobody knows yet who is looking): the sheet takes at most this share of the uncovered
 * width and height, and its middle is seen this share of the uncovered height below the middle.
 */
export const WAIT_VIEW = Object.freeze({ wide: 0.62, high: 0.7, drop: 0.02 });
/** The opening's land comes out of the bare sheet at the latest this long (ms) after the map knew where to go, whatever of it is still being made. */
export const OPEN_HOLD_MS = 1600;
/**
 * The opening's dive (UX brief §13.4): the camera sets off from the waiting picture's own view the moment the map
 * knows where to go, and flies `ms` (eased out steeply: it is close above its subject after a third of that). The
 * picture it flies to is made meanwhile, out of sight: a frame gives `ground` ms to new ground bitmaps and `sea` ms
 * to new pieces of the cloud sea (one of each at least). The land comes out of the sheet over `land` ms once that
 * picture is made and the camera has come within `near` of its zoom (from further up the picture is several times
 * as wide: more ground than the map keeps, and none of it prepared). Once `rest` ms have gone the land is shown
 * with the province the camera flies to alone, and the chart around it and the sea join as they are made. The
 * ground of a dive is made at `lo` of its fineness, and its sea as fine as a picture at `sea0` of its zoom needs (a
 * picture in motion, and cloud is soft; the resting picture makes its own, and these stand in until it has).
 */
export const DIVE = Object.freeze({ ms: 1100, land: 380, ground: 64, sea: 30, near: 0.72, rest: 900, lo: 0.5, sea0: 0.6 });
/**
 * The apron of a travelling picture (FrontierMap.groundApron): how far it reaches past the canvas (device px), the
 * most pixels it may have, how far ahead of the camera's way it is laid (of the margin), between which zooms (of the
 * one it was made at) it serves stretched, at which zoom (of the picture's own) it is made while the camera flies
 * out (a wider one, so a flight out makes it once or twice and not at every step), and how soon one that was not
 * whole is made again (ms).
 */
export const APRON = Object.freeze({ margin: 256, pixels: 12_000_000, lead: 0.7, out: 0.8, in: 1.6, away: 0.7, retry: 250 });
/** The seat's frame: the viewer's village is seen this share of the uncovered height below its middle (a tilted board only). */
export const SEAT_DROP = 0.08;
/** The far rows' haze in the view of the bell before joining (of its full strength): the tower stands up into that band. */
export const BELL_HAZE = 0.4;
/** The haze of the far rows stops this far inside the sheet's edge (world px): the deckle's nicks reach about that far in. */
export const HAZE_INSET = 22;
/**
 * The haze's band and a sheet over the foot of the picture (a phone's drawer at half height or more): the band is
 * `HAZE_SHARE` of the picture's height (the style sheet's own number, .map-dress::before) while at least `HAZE_FREE`
 * of the height is left above the sheet; with less left it shrinks in step, never under `HAZE_BAND_MIN` of itself.
 * The camera frames its subject in the part the sheet leaves, so a band that kept its full height lay over the
 * viewer's own village there.
 */
export const HAZE_SHARE = 0.64, HAZE_FREE = 0.7, HAZE_BAND_MIN = 0.5;
/** What a pick names, as one word (the tile, or the province from afar). */
const hoverId = hit => (hit ? `${hit.p},${hit.q},${hit.idx ?? ''}` : '');
/** The map's words fade out for a set piece, and back in after it, over this long (ms). */
export const PIECE_LABELS_MS = 200;
/**
 * The camera eases out to a lit reach: the reach's box takes at most this share of the uncovered picture, keeps
 * this many px clear of its edges, and the zoom never goes below this factor of the tile view's own edge (a
 * phone's picture is too narrow for a whole reach: there it eases out as far as the tiles stay tiles).
 */
export const REACH_FIT = 0.97;
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
export function paintRealmLabels(ctx, recs, zoom, nameOf = null, { seen = null, controlSeen = null, territoryOf = null, seenTile = null, min = 3, home = null, extra = [], nations = true } = {}) {
  // with a survey (`seen(rec, site)`): a nation is named over the villages the viewer has surveyed, and the
  // viewer's own nation over its home wedge while it has no village (`home` = {faction, x, y}).
  // `extra`: more names to lay out with them (`[{text, x, y, size, fill, below (screen px under the point)}]`:
  // the viewer's village under its beacon). No name covers another (map/labels.mjs).
  const acc = Array.from({ length: 6 }, () => ({ x: 0, y: 0, w: 0 }));
  if (nations) for (const r of recs.values()) {
    const n = Array(6).fill(0);
    if (territoryOf) {
      const territory = territoryOf(r.p, r.q);
      for (const [i, f] of (territory?.owners ?? []).entries()) if (f < 6 && (!seenTile || seenTile(r, i))) n[f]++;
    } else if (Number.isInteger(r.control)) {
      if (r.control >= 0 && r.control < 6 && (!seen || controlSeen?.(r))) n[r.control] = 1;
    } else r.owners.forEach((f, j) => { if (r.sites[j] === 1 && f < 6 && (!seen || seen(r, j))) n[f]++; });
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
        // (ruled twice, as the viewer's own plate at the tile view is: gold, and an ivory hair inside it)
        ctx.strokeStyle = YOURS.gold; ctx.lineWidth = 1.4 * k; ctx.stroke();
        ctx.beginPath(); ctx.roundRect?.(it.x - w / 2 + 2.4 * k, it.y - h / 2 + 2.4 * k, w - 4.8 * k, h - 4.8 * k, 4 * k); ctx.strokeStyle = 'rgba(255,252,240,.7)'; ctx.lineWidth = 0.8 * k; ctx.stroke();
        ctx.fillStyle = '#fff3cf'; ctx.fillText(it.text, it.x, it.y + 0.5 * k);
        return;
      }
      // a nation's name: its sigil on its colour stands before it (a nation is never told by colour or by name alone)
      const sr = Number.isInteger(it.faction) ? it.size * 0.46 * k : 0, tx = it.x + (sr ? sr + 2 * k : 0);
      if (sr) {
        const sx = tx - (it.tw * k) / 2 - sr - 5 * k;
        ctx.beginPath(); ctx.arc(sx, it.y, sr, 0, Math.PI * 2); ctx.fillStyle = FACTION_COLORS[it.faction] ?? '#8a8f86'; ctx.fill();
        ctx.strokeStyle = 'rgba(14,22,20,.85)'; ctx.lineWidth = 1.6 * k; ctx.stroke();
        paintSigil(ctx, { x: sx, y: it.y, r: sr * 0.56, faction: it.faction, mark: NATION_ON[it.faction] ?? '#fff6e2' });
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
    // the dark of the room above the board's horizon (UX brief §12.1): one more piece of the depth dressing, made here
    // so the three pages need no line for it
    if (this.dress?.querySelector && !this.dress.querySelector('.map-dusk') && page.createElement) { const d = page.createElement('i'); d.className = 'map-dusk'; this.dress.append(d); }
    // (the waiting picture, UX brief §12.3, is painted on the ground canvas itself, the stage at the seat's angle: the
    // opening is one picture from the first frame on. The third wave gave it a stage of its own and dissolved the land
    // out of it; for a fifth of a second two pictures of two views lay over one another: UX brief §13.4)
    /** The opening's dive while it plays (`open`), else null. */
    this.dive = null;
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
    // (the demo switch may lay sample records over the page's own: `setSample`; every other caller sees the page's)
    this.source = () => this.sampled(source());
    /** A tile is being picked on the board for an order (`pickTile`), else null. */
    this.pick = null;
    /** The host that is ringed (`selectHost`), as text, or null. */
    this.hostSel = null;
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
    /** The banner rule's prototype on the board (map/protoboard.mjs): nothing of it is drawn until `setProto` gives it a model. */
    this.proto = new ProtoBoard({ tick: () => this.tick(), invalidate: () => this.invalidate() });
    // the keeps of a conquest season: read from the control record and the keep events (map/keeps.mjs); `keepFeed` is the page's part of them (map/keepmount.mjs)
    this.keeps = new KeepBoard({ tick: () => this.tick(), invalidate: () => this.invalidate() });
    this.keepFeed = null;
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
      if (this.landingFly) { const f = this.landingFly; this.landingFly = null; this.flyTo({ ...f, zoom: Math.max(this.cam.view.zoom, heroZoom(this.dpr()) * LANDING_ZOOM) }, null, { auto: !this.cam.userMoved, seat: true }); if (this.landing?.arriving) this.landing.moves = this.moves ?? 0; }
      this.landingBeat(); this.landingEase();
      // the reach of a host that was just selected is not all in the picture: the camera eases out to it
      // (asked for inside the last picture: a person who moved the camera since then keeps it)
      if (this.arrivalWant) this.arrivalEase(now);
      if (this.proto.on || this.shakeSet) { this.protoShake(); if (this.shakeSet) this.dirty = true; }
      if (this.reachFly) { const f = this.reachFly; this.reachFly = null; if (f.moves === (this.moves ?? 0)) this.setView(f.to, { auto: true, ms: MOVE_MS.reach, kind: 'fly', ease: EASE.inOutCubic }); }
      if (this.cam.step(now)) this.dirty = true;
      if (this.dirty) this.draw(now);
      this.raf = globalThis.requestAnimationFrame?.(this.frame);
    };
    this.raf = globalThis.requestAnimationFrame?.(this.frame);
  }

  /** The logical view {x, y, zoom}: where the camera is going (picking by keyboard, the LOD and tests read this). */
  get view() { return this.cam.view; }
  /** The opening's dive while its land is not on screen yet (the first picture is still being made), else null. */
  get openHold() { return this.dive && this.dive.landAt === null ? this.dive : null; }
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
  tiltDeg(zoom, size = this.size()) {
    if (!(this.tiltMax > 0)) return 0;
    // (fully tilted from a little over twice the far view's zoom: on a phone, whose far view is far out, well before
    // the tile view; map/tilt.mjs tiltNear)
    const far = this.flatZoom(size) * 1.05, at = z => tiltAt(z, { far, near: tiltNear(far), deg: this.tiltMax }), own = at(zoom);
    // (the opening's dive begins at the seat's own angle, the waiting picture's, whatever the zoom, and goes over
    // evenly to the angle of the view it ends on; never flatter than the zoom's own. Only the picture on screen: where
    // the camera is going is worked out with the angle it will have there)
    const d = this.dive;
    return d?.seat && zoom === this.cam.drawn.zoom ? Math.max(own, this.tiltMax + (at(this.cam.view.zoom) - this.tiltMax) * d.p) : own;
  }
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
  aim(pt, zoom, size = this.size(), inset = this.inset(), drop = 0) {
    // (`drop`: the point is seen that share of the uncovered height below its middle: the seat's frame, `seatDrop`)
    const f = freeBox(size, inset), s = this.geo(zoom, size).toStage(size.width / 2 + f.x, size.height / 2 + f.y + drop * f.height);
    return { x: pt.x - (s.x - size.width / 2) / zoom, y: pt.y - (s.y - size.height / 2) / zoom, zoom };
  }
  /**
   * The everyday frame is a view from a seat (UX brief §12.1): the viewer's village stands a little below the middle
   * of the uncovered picture, so more of the far rows, and the horizon they end in, are in it. On a flat board (no
   * tilt) the village stays in the middle.
   */
  seatDrop() { return this.tiltMax > 0 ? SEAT_DROP : 0; }
  /**
   * The view that shows world point `pt` at client px (cx, cy) at `zoom`, as it is seen (tilt and all): what a set
   * piece asks for when its scene must stand in the part of the screen the HUD leaves free (fx/battle.mjs).
   */
  viewShowing(pt, cx, cy, zoom, size = this.size()) {
    const r = this.canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 }, s = this.geo(zoom, size).toStage(cx - r.left, cy - r.top);
    return { x: pt.x - (s.x - size.width / 2) / zoom, y: pt.y - (s.y - size.height / 2) / zoom, zoom };
  }
  /** Write the board's angle and the depth dressing onto the page (custom properties: the page's CSP allows no inline style). */
  dressPage(deg, { near = 0, shown = 1, inset = null, haze = 1, sheet = 'none', dusk = 0 } = {}) {
    const set = (el, k, v) => { el.cache ??= {}; if (el.cache[k] !== v) { el.cache[k] = v; el.node.style.setProperty(k, v); } };
    if (this.stage) set(this.stageVars ??= { node: this.stage }, '--map-tilt', `${deg.toFixed(2)}deg`);
    // (the angle on screen, for whoever must know it without asking the map: the browser tests aim their presses with it)
    const d0 = this.canvas.dataset, mark = deg.toFixed(2);
    if (d0 && d0.tilt !== mark) d0.tilt = mark;
    if (!this.dress) return;
    const d = this.dressVars ??= { node: this.dress };
    // the haze is the far edge of a tilted board: none on a flat one
    const far = this.tiltMax > 0 ? Math.min(1, deg / this.tiltMax) * shown * haze : 0;
    set(d, '--map-haze', far.toFixed(3));
    // (the dark of the room above the horizon goes with the haze; `dusk`: what the waiting picture adds of its own
    // while it shows, so the dark does not blink as the land comes out of that picture)
    set(d, '--map-dusk', (this.tiltMax > 0 ? Math.min(1, far + dusk) : 0).toFixed(3));
    set(d, '--map-near', (near * shown).toFixed(3));
    set(d, '--map-top', `${Math.round(inset?.top ?? 0)}px`);
    set(d, '--map-sheet', sheet);
    // (the band keeps to the far rows of what a tall sheet leaves of the picture: HAZE_FREE)
    const tall = this.size().height, left = tall > 0 ? 1 - Math.max(0, inset?.bottom ?? 0) / tall : 1;
    set(d, '--map-haze-h', left >= HAZE_FREE ? 'none' : `${Math.round(tall * HAZE_SHARE * Math.max(HAZE_BAND_MIN, left / HAZE_FREE))}px`);
  }
  /**
   * The sheet's outline as the picture shows it, for the haze (which lies on the sheet, never on the table beyond
   * it): `none` while the whole picture is on the sheet, else a CSS polygon in px from the map's corner. The sheet
   * is a rectangle on the board, so it is seen as a trapezoid: its part on the ground canvas, corner by corner.
   */
  sheetClip(v, size, T, G) {
    if (T.flat) return 'none';
    const sh = sheetOf(this.rings ?? 1), m = HAZE_INSET;
    const sx = x => (x - v.x) * v.zoom + size.width / 2, sy = y => (y - v.y) * v.zoom + size.height / 2;
    const x0 = sx(-sh.x + m), x1 = sx(sh.x - m), y0 = sy(-sh.y + m), y1 = sy(sh.y - m);
    if (T.quad().every(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)) return 'none';
    // (kept to the ground canvas: a corner far below the picture would lie behind the eye)
    const a0 = Math.max(x0, G.left), a1 = Math.min(x1, G.left + G.width), b0 = Math.max(y0, G.top), b1 = Math.min(y1, G.top + G.height);
    if (!(a1 > a0) || !(b1 > b0)) return 'polygon(0 0)';
    return `polygon(${[[a0, b0], [a1, b0], [a1, b1], [a0, b1]].map(([x, y]) => { const p = T.toBox(x, y); return `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`; }).join(', ')})`;
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
  setNoGo(rects) {
    // (the dial is round and the largest piece of the strip: the map's plates keep a little air from it, DIAL_AIR;
    // the second review: a village's plate pressed against the dial)
    const aired = r => { const b = rectOf(r); return b && r?.id === 'dial' ? { ...b, x: b.x - DIAL_AIR, y: b.y - DIAL_AIR, w: b.w + 2 * DIAL_AIR, h: b.h + 2 * DIAL_AIR } : b; };
    this.nogoFed = Array.isArray(rects) ? rects.map(aired).filter(Boolean) : null; this.tick();
  }
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
    // the kept places, measured here whatever the page fed
    for (const el of doc.querySelectorAll(KEPT_SELECTORS)) {
      if (el.hidden || el.closest?.('[hidden]')) continue;
      const b = rectOf(el.getBoundingClientRect?.());
      if (!b || b.x + b.w <= r.left || b.x >= r.right || b.y + b.h <= r.top || b.y >= r.bottom) continue;
      out.push({ x: b.x - r.left - KEPT_AIR, y: b.y - r.top - KEPT_AIR, w: b.w + 2 * KEPT_AIR, h: b.h + 2 * KEPT_AIR, hard: true });
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
  limitView(v, { clamp = false, soft = 0, give = 0 } = {}) {
    const size = this.size();
    const zoom = this.clampZoom(v.zoom, size);
    const out = zoom === v.zoom ? v : { ...v, zoom };
    return clamp && size.width > 0 && size.height > 0 ? clampCentre(out, { ringsOpen: this.ringsNow(), size, soft, give, inset: this.inset() }) : out;
  }
  /**
   * How far past the pan's limit the camera rests now (of the limit's radius; 0 inside it, ZOOM_GIVE at most): a
   * zoom about the pointer may leave it there, and a step by the keys from there is not first pulled back inside.
   */
  pastLimit() {
    const size = this.size();
    if (!(size.width > 0) || !(size.height > 0)) return 0;
    return Math.max(0, Math.min(ZOOM_GIVE, centreReach(this.cam.view, { ringsOpen: this.ringsNow(), size, inset: this.inset() }).len - 1));
  }

  /** Centre on a province (and zoom to its LOD); with `ms` the picture flies there. */
  focus(p, q, zoom = 0.2, ms = 0) { const c = provincePixel(p, q); this.setView({ x: c.x, y: c.y, zoom }, { ms, kind: 'fly' }); }

  /**
   * Fly to a place: `{p, q, tile?, zoom?}` or `{x, y, zoom?}` (world px). The
   * place lands in the middle of the part of the canvas no sheet covers
   * (`exact`: the canvas centre). `ms` null: by the length of the trip.
   */
  flyTo(target, ms = null, { auto = false, exact = false, seat = false } = {}) {
    const size = this.size(), v = this.cam.view;
    const zoom = this.clampZoom(target.zoom ?? v.zoom, size);
    const pt = Number.isInteger(target.p) && Number.isInteger(target.q) ? placePoint(target) : { x: target.x ?? v.x, y: target.y ?? v.y };
    const to = exact || !(size.width > 0) ? { x: pt.x, y: pt.y, zoom } : this.aim(pt, zoom, size, this.inset(), seat ? this.seatDrop() : 0);
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
    const f = (c => this.unproject(size.width / 2 + c.x, size.height / 2 + c.y + this.seatDrop() * c.height, { logical: true, box: true }))(freeBox(size, inset));
    const here = at.findIndex(c => Math.hypot(c.x - f.x, c.y - f.y) < RADIUS * 0.5);
    const c = at[here >= 0 ? (here + 1) % at.length : Math.min(at.length - 1, Math.max(0, src.open?.active ?? 0))];
    this.flyTo({ x: c.x, y: c.y, zoom: Math.max(this.cam.view.zoom, heroZoom(this.dpr())) }, null, { seat: true });
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
    if (fly) this.flyTo({ p: at.p, q: at.q, tile: at.tile, zoom: Math.max(this.cam.view.zoom, heroZoom(this.dpr())) }, 900, { auto: !this.cam.userMoved, seat: true });
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
    const size = this.size(), to = this.aim(placePoint(b.at), hero, size, this.inset(), this.seatDrop());
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
    const want = { x: wx - (b.x - s.width / 2) / z, y: wy - (b.y - s.height / 2) / z, zoom: z };
    // (UX brief §13.6: the point stays under the pointer as far as the pan's limit allows, and the limit gives a
    // little for a zoom, ZOOM_GIVE. What it does not allow, out toward the far view where the world comes to the
    // middle of the picture, is a glide of its own length, not the zoom's own 140 ms: nothing jumps)
    const to = this.limitView(want, { clamp: true, give: ZOOM_GIVE });
    const pull = Math.hypot(to.x - want.x, to.y - want.y) * to.zoom;
    const slow = pull > 2 && move.ms > 0 ? { ms: move.ms + Math.min(MOVE_MS.pull, pull * 1.6), ease: EASE.inOutCubic } : null;
    this.setView(want, { clamp: true, give: ZOOM_GIVE, ...move, ...slow, anchor: { x: b.x - s.width / 2, y: b.y - s.height / 2 } });
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
      // (the world chart says what it is in a word: the folded-sheet glyph alone was not read; the second review)
      if (t.text) { const w = doc.createElement('span'); w.className = 'map-btn-text'; b.append(w); b.dataset.worded = ''; }
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
        const w = t.text ? b.querySelector?.('.map-btn-text') : null;
        if (w) { const say = on ? t.textOn() : t.text(); if (w.textContent !== say) w.textContent = say; }
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
    // (while the map waits to know who is looking there is nothing on it to press, and a press must not count as a
    // person moving the camera: the opening would never frame its subject)
    // (a camera the page placed itself, a link with ?at=, is open from the start)
    const shut = () => !this.opened && !this.cam.userMoved;
    c.addEventListener('pointerdown', e => {
      this.touchedAt = clock();
      if (shut()) return;
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
      if (!d.moved) { if (e.type === 'pointerup') this.tap(pick(this.cam.drawn, this.size(), p.x, p.y), e); return; }
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
      this.touchedAt = clock();
      if (shut()) return;
      // the wheel takes over a flight where the picture is; its own easing is only retargeted
      if (this.cam.tween && this.cam.tween.tag !== 'wheel' && this.cam.halt()) this.sync();
      const p = at(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), p.bx, p.by, { ms: MOVE_MS.wheel, tag: 'wheel' });
    }, { passive: false });
    c.addEventListener('keydown', e => {
      this.touchedAt = clock();
      if (shut()) return;
      // a tile is being picked: the arrows step through the lit tiles, Enter or Space takes one, Escape lets go
      if (this.pick && this.pickKey(e)) return;
      const v = this.cam.view, step = 80 / v.zoom;
      const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (k) { e.preventDefault(); this.setView({ x: v.x + k[0], y: v.y + k[1] }, { clamp: true, give: this.pastLimit(), ms: MOVE_MS.pan }); return; }
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

  // ------------------------------------------------------------------ the hand on the board (UX design 14.2)
  /**
   * A tap on the board. While a tile is being picked (`pickTile`) the tap is the pick's. Otherwise it is a
   * selection (`onSelect`), and when a host's figure, its pill or a player's character with its host is under the
   * pointer, the tile selected is that host's and the hit says which host: `hit.host` = `hostAt`'s answer (the page
   * may then choose that host as the one that acts).
   */
  tap(hit, e = null) {
    if (this.pick) { this.pickTap(hit); return; }
    const host = e && Number.isFinite(e.clientX) && this.lod === 'tile' ? this.hostAt(e.clientX, e.clientY) : null;
    if (host && Number.isInteger(host.tile)) {
      const h = tileHex(host.p, host.q, host.tile);
      if (h) hit = { tileQ: h.q, tileR: h.r, p: host.p, q: host.q, idx: host.tile, host };
    }
    // (the host that was pressed is ringed for as long as its tile stays selected; `selectHost` rings one whatever is
    // selected, and is the page's to set and to take away: the play page rings the host that has the hand)
    this.hostTap = host ? String(host.id) : null;
    // a keep was pressed while a host's reach is lit (its walls stand over the tile behind it: the press is a press on
    // the keep's own tile, as a press on a host's figure is one on its tile): the board answers a keep out of reach
    // with the reason, and the tap goes on to the page with the keep's tile (`hit.keep`: `{p, q, reachable}`)
    if (!host && this.keeps.on && this.keeps.lit && e && Number.isFinite(e.clientX)) {
      const k = this.keepAt(e.clientX, e.clientY), it = k ? this.keeps.tapped(k) : null, h = it ? tileHex(k.p, k.q, k.tile) : null;
      if (h) hit = { tileQ: h.q, tileR: h.r, p: k.p, q: k.q, idx: k.tile, keep: { p: k.p, q: k.q, reachable: !!it.reachable } };
    }
    this.onSelect(hit);
  }

  // ------------------------------------------------------------------ the keeps of a conquest season (map/keeps.mjs)
  /** Whether this frame draws keeps: a conquest season's records are there (the page says so through `keepFeed`; else a keep's tile in the records), never in the arrival-control sample world. */
  keepsOn(src, recs, feed = this.keepFeedNow ?? null) {
    if (src?.territoryEnabled) return false;
    if (this.keeps.sample) return true;
    if (feed && feed.enabled !== undefined) return !!feed.enabled;
    if (this.keepsSeen?.recs !== recs || this.keepsSeen.n !== recs?.size) { let any = false; for (const r of recs?.values?.() ?? []) if (Number.isInteger(r.keepTile)) { any = true; break; } this.keepsSeen = { recs, n: recs?.size, any }; }
    return this.keepsSeen.any;
  }
  /**
   * The page's part of the keeps' records: `fn()` → `{enabled (a conquest season), events (the keep events known,
   * oldest first, or null while unread), viewer (the viewer's nation or null), bell}` (map/keepmount.mjs), or null.
   */
  setKeepFeed(fn = null) { this.keepFeed = typeof fn === 'function' ? fn : null; this.invalidate(); }
  /**
   * Light the keeps a fighting host in hand can reach (conquest): `list` = `[{p, q, tile, arriveTurn, holder,
   * defenders, reachable, why}]`, or null when no such host is in hand.
   *   reachable true   the keep lights: a breathing gold ring on its tile and 「ターン N に到着」 (`arriveTurn`) over it
   *   reachable false  the keep stays dim; a tap on it is answered on the board with `why` (a line in the page's language)
   * Keeps the list does not name are drawn as ever. `holder` and `defenders` are the caller's own reading and are not
   * drawn from here (the board draws the holder from the control record). The list is the page's: once this has been
   * called the board no longer lights a reach by itself (map/keepmount.mjs). Returns whether anything changed.
   */
  setKeepReach(list = null) { return this.keeps.setReach(list, { own: true }); }
  /**
   * The keep under a point of the page (client px, as `hostAt`): its fortress standing over its tile, or the tile
   * itself. `{p, q}` (with `tile`, the keep's tile), or null. Read from the last picture painted, at any zoom.
   */
  keepAt(clientX, clientY) {
    if (!this.keeps.on || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const z = this.cam.drawn.zoom, coarse = !!globalThis.matchMedia?.('(pointer: coarse)')?.matches, min = coarse ? 22 : 12;
    let best = null, bd = Infinity;
    for (const row of this.keeps.rows.values()) {
      const P = this.keeps.place(row, z);
      if (!P) continue;
      const k = this.standAt(P.x, P.y)?.k ?? 1, at = this.project(P.x, P.y), s = P.u * z * k;
      const dx = clientX - at.x, dy = clientY - at.y, hw = Math.max(min, s * 0.95), up = Math.max(min * 2, s * 1.55), down = Math.max(min * 0.6, s * 0.6);
      if (Math.abs(dx) > hw || dy < -up || dy > down) continue;
      const d = Math.hypot(dx, dy + up * 0.3);
      if (d < bd) { bd = d; best = { p: row.p, q: row.q, tile: row.tile }; }
    }
    return best;
  }
  /** Fly to the keep of province `{p, q}`, near enough to see its fortress and the tiles round it (a closer view is kept). Returns whether there is such a keep. */
  flyToKeep(at) {
    const row = at && this.keeps.on ? this.keeps.rows.get(`${at.p},${at.q}`) ?? null : null;
    if (!row) return false;
    this.flyTo({ p: row.p, q: row.q, tile: row.tile, zoom: Math.max(this.cam.view.zoom, FLY_TO_ZOOM) });
    return true;
  }
  /** Sample records of the keeps for the demo switch alone (fx/keep-demo.mjs; `{recs, events, viewer, bell}` in the records' own shapes), or null. */
  setKeepSample(sample = null, opts = {}) { this.keeps.setSample(sample, opts); }

  /**
   * Light a set of tiles and let the player take one (UX design 14.2: 「ここに集める」, a Scout's tiles):
   *   kind    'muster' (gold-teal) | 'explore' (sky blue) | 'move' (the reach's pale teal)
   *   tiles   `[{p, q, tile}]` the tiles a rule allows (the caller reads the rules; the map only lights them)
   *   max     how many may be taken (1: the promise answers with the first tap)
   *   label   what the tap will do, on a bell-metal tag over the set
   *   origin  `{p, q, tile}` the light spreads from (the village, the Scout)
   *   chosen  `[{p, q, tile}]` tiles of the set already taken (the caller's own choice so far): each shows its own
   *           hexagon with a tick from the start. With `max` 1 a tap on one of them answers with it like any other
   *           (the caller may let it go); with `max` > 1 they are the first of the tiles taken
   *   miss    `hit => {}`: when given, a tap outside the lit set is handed to it and the pick stays open (a card
   *           of the page stands with the pick: a slip of the finger does not put it away). Without it such a
   *           tap lets the pick go
   * Returns a promise of the tile `{p, q, tile}` (an array of them when `max` > 1), or null when the pick was let
   * go: Escape, a tap outside the lit set (without `miss`), a deselection (`pickCancel`, or `pickTile(null)`),
   * another pick. With `max` > 1 the promise
   * answers once `max` tiles are taken, or with fewer on Enter or `pickDone()`; a tap on a taken tile lets it go.
   * The camera eases out until the lit set is in the picture (as for a reach); when the pick is let go it goes back
   * to where it was, unless a person has moved it since. A pick of the same set asked again right after an answer
   * (the page asks again while its card stands) is the same pick going on: its light does not roll out a second
   * time and the camera's place to go back to is the first one. The tiles are exact under the tilt (the same
   * inverse mapping as every tap). While a pick is open the canvas
   * carries `data-pick="<kind>"` and the bus says `pick:open` / `pick:close` `{kind, picked}`.
   */
  pickTile(opts = {}) {
    this.pickCancel();
    if (opts === null) return Promise.resolve(null);
    const { kind = 'move', tiles = [], max = 1, label = '', origin = null, chosen = [], miss = null } = opts;
    const src = this.source?.() ?? {}, sv = src.survey && !src.survey.showAll ? src.survey : null;
    const levelOf = sv ? (p, q, idx) => sv.levelOf(p, q, idx) : () => 3;
    const key = `${kind}|${max}|${tiles.map(t => `${t.p ?? ''}.${t.q}.${t.tile ?? t.r}`).join(',')}`;
    const again = this.pickLast && this.pickLast.key === key && fxNow() - this.pickLast.at < 1500 ? this.pickLast : null;
    this.pickLast = null;
    const model = pickModel({ kind, tiles, origin, max, label, t0: again?.t0 ?? fxNow(), levelOf, picked: chosen ?? [] });
    return new Promise(resolve => {
      if (!model.tiles.length) { resolve(null); return; }
      this.pick = { model, resolve, levelOf, cursor: null, key, miss: typeof miss === 'function' ? miss : null, args: { kind, tiles, origin, max, label }, memo: again?.memo ?? this.viewMemo() };
      if (this.canvas.dataset) this.canvas.dataset.pick = model.kind;
      // Escape lets go wherever the focus is (the action bar, the canvas), and lets go of the pick alone: the selection under it stays
      this.pickEsc = ev => { if (ev.key === 'Escape' && this.pick) { ev.preventDefault?.(); ev.stopImmediatePropagation?.(); this.pickCancel(); } };
      this.canvas.ownerDocument?.addEventListener?.('keydown', this.pickEsc, true);
      fxEmit('pick:open', { kind: model.kind, n: model.tiles.length, max: model.max, label: model.label, again: !!again });
      // the lit set is framed like a reach: the camera eases out until its edge is in the picture
      if (!again) this.reachFit = null;
      this.invalidate();
    });
  }
  /** Whether a tile is being picked. */
  get picking() { return !!this.pick; }
  /** End the pick with `value` (null: let go). */
  pickEnd(value) {
    const P = this.pick;
    if (!P) return;
    this.pick = null;
    if (this.canvas.dataset) delete this.canvas.dataset.pick;
    if (this.pickEsc) { this.canvas.ownerDocument?.removeEventListener?.('keydown', this.pickEsc, true); this.pickEsc = null; }
    if (P.cursor) this.setHover(null);
    fxEmit('pick:close', { kind: P.model.kind, picked: value });
    // a pick that was let go gives the camera back (it eased out to show the lit set), unless a person has moved it since;
    // after a tile was taken the camera stays: the page may bring it back itself (`restore`)
    if (value === null && this.reachFit?.held) this.restore(P.memo, { ifStill: true, ms: MOVE_MS.reach });
    // (an answer may be followed by the same pick asked again: it then goes on as it was)
    this.pickLast = value === null ? null : { key: P.key, t0: P.model.t0, memo: P.memo, at: fxNow(), fit: this.reachFit };
    if (value === null) this.reachFit = null;
    this.invalidate();
    P.resolve(value);
  }
  /** Let the pick go (the promise answers null). */
  pickCancel() { this.pickEnd(null); }
  /** Finish a pick of more than one tile with what is taken so far (none: let go). */
  pickDone() { const P = this.pick; if (!P) return; const got = P.model.picked; this.pickEnd(got.length ? (P.model.max > 1 ? got : got[0]) : null); }
  /** A tap while a tile is picked: a lit tile is taken (a taken one is let go), anything else lets the pick go. */
  pickTap(hit) {
    const P = this.pick;
    if (!P) return false;
    const t = hit && Number.isInteger(hit.idx) ? P.model.byHex.get(`${hit.tileQ},${hit.tileR}`) : null;
    if (!t) {
      // (the page keeps the pick with its card: it is told of the tap, and says why that tile is not one of the set)
      if (P.miss) { try { P.miss(hit ?? null); } catch { /* the page's own answer */ } return true; }
      this.pickCancel(); return true;
    }
    const one = { p: t.p, q: t.q, tile: t.tile };
    if (P.model.max <= 1) { this.pickEnd(one); return true; }
    const had = P.model.picked.some(x => x.p === one.p && x.q === one.q && x.tile === one.tile);
    const picked = had ? P.model.picked.filter(x => !(x.p === one.p && x.q === one.q && x.tile === one.tile)) : [...P.model.picked, one];
    P.model = pickModel({ ...P.args, t0: P.model.t0, picked, levelOf: P.levelOf });
    fxEmit('pick:change', { kind: P.model.kind, picked });
    if (picked.length >= P.model.max) this.pickEnd(picked);
    else this.invalidate();
    return true;
  }
  /** A key while a tile is picked (the canvas has the focus): the arrows step through the lit tiles, Enter or Space takes the one stepped to. */
  pickKey(e) {
    const P = this.pick;
    if (!P) return false;
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
    if (dir) {
      e.preventDefault?.();
      const t = pickStep(P.model, P.cursor, dir) ?? (P.cursor ? null : pickStep(P.model, null));
      if (t) {
        P.cursor = { q: t.hq, r: t.hr };
        this.mouse = null;
        this.setHover({ tileQ: t.hq, tileR: t.hr, p: t.p, q: t.q, idx: t.tile });
        // the tile stepped to stays in the picture
        const c = project(t.hq, t.hr), s = this.size(), at = this.project(c.x, c.y, { logical: true, box: true });
        if (at.x < 40 || at.y < 90 || at.x > s.width - 40 || at.y > s.height - 110) this.flyTo({ x: c.x, y: c.y }, MOVE_MS.pan, { auto: true });
      }
      return true;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault?.();
      if (P.cursor) { const t = P.model.byHex.get(`${P.cursor.q},${P.cursor.r}`); if (t) this.pickTap({ tileQ: t.hq, tileR: t.hr, p: t.p, q: t.q, idx: t.tile }); }
      else if (P.model.picked.length) this.pickDone();
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault?.(); this.pickCancel(); return true; }
    return false;
  }

  /**
   * The host under a point of the page (client px): its figure, its pill, or the character that stands with it (one
   * hit area; at least 44 px on a touch screen). `{id, ids (every host of the group), own, faction, p, q, tile,
   * lead (a player's character stands with it), world: {x, y}}`, or null. The viewer's own hosts come first where
   * two overlap. Read from the last picture painted (the tile view; further out there are no figures to press).
   */
  hostAt(clientX, clientY) {
    if (this.drawnLod !== 'tile' || !this.art) return null;
    const toks = this.art.tokens ?? [], z = this.cam.drawn.zoom;
    const coarse = !!globalThis.matchMedia?.('(pointer: coarse)')?.matches;
    const min = coarse ? 22 : 12;
    let best = null, bd = Infinity;
    for (const tok of toks) {
      const ch = tok.character ?? null;
      // (a character is a way to press the host it leads: one that stands by its village leads nothing afield)
      const ids = ch ? (ch.host ? [String(ch.host)] : []) : (tok.hosts ?? []).map(String);
      if (!ids.length) continue;
      const k = this.standAt(tok.x, tok.y)?.k ?? 1, at = this.project(tok.x, tok.y);
      const s = (ch ? RADIUS * 0.66 * 2 * (ch.share ?? 1) : tok.size ?? RADIUS * 0.66) * z * k;
      const hw = Math.max(min, s * (ch ? 0.34 : 0.46)), up = Math.max(min * 2, s * (ch ? 1.25 : 1.5)), down = Math.max(min * 0.6, s * 0.22);
      const dx = clientX - at.x, dy = clientY - at.y;
      if (Math.abs(dx) > hw || dy < -up || dy > down) continue;
      const d = Math.hypot(dx, dy + up * 0.4) - (tok.own || ch?.own ? 1000 : 0);
      if (d < bd) { bd = d; best = { id: ids[0], ids, own: !!(tok.own || ch?.own), faction: tok.faction, p: ch?.place?.p ?? tok.p, q: ch?.place?.q ?? tok.q, tile: ch?.place?.tile ?? tok.tile, lead: !!ch || !!tok.led, world: { x: tok.x, y: tok.y } }; }
    }
    return best;
  }
  /**
   * Ring a host on the board (`id`; null: none): a bright ring at its figure's feet, gold for the viewer's own.
   * The ring alone: which host acts and what it can reach is the page's (its selection lights the reach as before).
   * Without it the host that was pressed is ringed while its tile is selected, else the host of the selection that acts.
   */
  selectHost(id = null) { this.hostSel = id === null || id === undefined ? null : String(id); this.tick(); }

  /**
   * The camera's place, to come back to (`restore`): `{x, y, zoom}` of where the camera is going now. A drawer that
   * opens, or a battle that is replayed, takes the camera; the page keeps this first and gives it back afterwards.
   */
  viewMemo() { const v = this.cam.view; return { x: v.x, y: v.y, zoom: v.zoom, moves: this.moves ?? 0 }; }
  /**
   * Fly back to a place kept with `viewMemo` (`ms` null: by the length of the trip; 0: at once). `ifStill`: only
   * when no person has moved the camera since the memo was taken. Returns whether the camera went.
   */
  restore(memo, { ms = null, ifStill = false } = {}) {
    if (!memo || !Number.isFinite(memo.x) || !Number.isFinite(memo.y) || !(memo.zoom > 0)) return false;
    if (ifStill && Number.isInteger(memo.moves) && (this.moves ?? 0) !== memo.moves) return false;
    const to = { x: memo.x, y: memo.y, zoom: this.clampZoom(memo.zoom) };
    this.setView(to, { auto: true, ms: ms ?? flightMs(this.cam.drawn, to, this.size()), kind: 'fly' });
    return true;
  }

  /** Whether the map itself draws the viewer's sealed march to `dest` `{p, q, tile}` from its record (then no effect needs to keep a ribbon there). */
  drawsMarchTo(dest) {
    const b = this.boardNow;
    return !!dest && !!b?.marches?.some(m => m.known && !m.open && m.dest.p === dest.p && m.dest.q === dest.q && m.dest.tile === dest.tile);
  }

  // ------------------------------------------------------------------ the banner rule's prototype (a design: PROTOTYPE-SPEC.md)
  /**
   * Hand the map the prototype's records as the model of proto/board-model.mjs (`protoBoardModel`), or null while the
   * prototype is off: then the map draws exactly what it drew before. Every moment the board plays (a raise's flood,
   * a trail's ink, a banner falling) starts from the difference between two models, that is, from records.
   * The label of the prototype is kept on screen for as long as a model is on (map/protochip.mjs: the map's own chip
   * stands down when the page shows one, an element with `data-proto-chip`).
   */
  setProto(model = null, { at = null } = {}) {
    // (`at`: when the records came, on the effects clock in ms; the demo switch alone gives it, so a frame of a moment can be sought)
    const before = new Set(this.proto.moments.keys());
    const changed = this.proto.set(model?.on ? model : null, { now: at ?? fxNow(), still: reducedMotion() });
    // a banner of the viewer's that has just risen, or been lost: the camera eases there when the player is not busy and
    // the place is not in the picture (as for an arrival: `arrivalEase`; never for a sample the demo switch seeks through)
    // (`moment`: the player's own press brought it — a banner raised —, so a press a moment ago does not keep the camera:
    // it goes in a quarter of a second, and the pole is brought well inside the part of the map nothing covers. On a
    // phone the pole stood at the top edge of that part, under the notice that told of it)
    if (changed && at === null) for (const [key, m] of this.proto.moments) if (!before.has(key) && (m.mine || m.wasMine) && m.pole) this.arrivalWant = { p: m.pole.p, q: m.pole.pq, tile: m.pole.idx, at: fxNow(), moment: true };
    this.protoShake();
    syncProtoChip(this.canvas, this.proto.on ? this.proto.model.label : null);
    setProtoLegend(this.proto.on ? this.proto.model.label : null);
    return changed;
  }
  /**
   * The banner under a point of the page (client px): its standard on the pole (one hit area, at least 44 px on a
   * touch screen), else the banner whose land the tile under the point belongs to. `{p, q, slot}` (with `mine`,
   * `nation`, `pole: {p, q, tile}`), or null. Read from the last picture painted (the tile view and the middle distance).
   */
  bannerAt(clientX, clientY) {
    const M = this.proto.model;
    if (!M?.on || !M.banners.length) return null;
    const z = this.cam.drawn.zoom, coarse = !!globalThis.matchMedia?.('(pointer: coarse)')?.matches, min = coarse ? 22 : 12;
    const ref = b => ({ p: b.p, q: b.q, slot: b.slot, mine: b.mine, nation: b.nation, pole: b.pole ? { p: b.pole.p, q: b.pole.pq, tile: b.pole.idx } : null });
    let best = null, bd = Infinity;
    if (this.drawnLod === 'tile') for (const b of M.banners) {
      if (!b.pole) continue;
      const c = project(b.pole.q, b.pole.r), x = c.x + POLE_AT.x, y = c.y + POLE_AT.y, k = this.standAt(x, y)?.k ?? 1, at = this.project(x, y);
      const h = bannerUnit(z) * 1.5 * z * k, hw = Math.max(min, h * 0.4), dx = clientX - at.x - h * 0.15, dy = clientY - at.y;
      if (Math.abs(dx) > hw || dy < -Math.max(min * 2, h) || dy > min * 0.6) continue;
      const d = Math.hypot(dx, dy + h * 0.5) - (b.mine ? 1000 : 0);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) return ref(best);
    const w = this.unproject(clientX, clientY);
    if (!w || !Number.isFinite(w.x)) return null;
    const [q, hr] = inverseHex(w.x, w.y).split(',').map(Number);
    const b = M.banners.find(x => x.tiles.some(t => t.q === q && t.r === hr));
    return b ? ref(b) : null;
  }
  /** Fly to a banner `{p, q, slot}` (its pole's tile, near enough to see its land; a closer view is kept). Returns whether the model has it. */
  flyToBanner(ref) {
    const b = this.proto.banner(ref);
    if (!b?.pole) return false;
    this.flyTo({ p: b.p, q: b.q, tile: b.pole.idx, zoom: Math.max(this.cam.view.zoom, FLY_TO_ZOOM) });
    return true;
  }
  /**
   * While the player chooses where to form or send a host: show what a banner raised there would bring. `answer` is
   * the preview route's own answer (`GET /h/proto/preview`: `{ok: true, tiles, trail, size, price, waitTurns}` or
   * `{ok: false, code, need}`) with the place it was asked for beside it: `p, q, tile` in the answer itself, or as the
   * second argument `{p, q, tile}`. Null puts it away. Nothing is shown while the prototype is off.
   */
  showRaisePreview(answer = null, at = null) {
    return this.proto.setPreview(answer ? { ...answer, ...(at ?? {}) } : null, (p, q, idx) => tileHex(p, q, idx));
  }
  /**
   * What tile (p, q, idx) is under the prototype, for the page's own tip or card: `{kind: 'banner' | 'village' |
   * 'commons', mine, mate, nation, line (the sentence that names it, without the tag), tag (「試作」), banner?: {p, q,
   * slot}}`, or null (the prototype is off, or its records say nothing of the tile).
   */
  protoAt(p, q, idx) {
    const M = this.proto.model, h = M?.on && Number.isInteger(idx) ? tileHex(p, q, idx) : null;
    const at = h ? protoLandAt(M, h.q, h.r) : null;
    return at ? { kind: at.kind, mine: !!at.mine, mate: !!at.mate, nation: at.nation ?? null, line: this.proto.landLine(at), tag: protoTag(), banner: at.banner ? { p: at.banner.p, q: at.banner.q, slot: at.banner.slot } : null } : null;
  }

  // ------------------------------------------------------------------ sample records (the demo switch alone)
  /**
   * Lay sample records over the page's own (fx/demo.mjs, the labelled `?fx=` switch; never normal play): `fs` is a
   * page state in the page's own shapes (`{holdings, provinces: Map, marches, nowBell, chain, clock, …}`), or null to
   * take the sample away. The board then draws from it through the same functions as from real records: the survey
   * (map/viewer.mjs surveyInput), the provinces' entries, the people's source (`people` of the sample replaces the
   * page's when given). `key` names the sample (any value): the same sample laid again starts afresh.
   */
  setSample(fs = null, key = null) {
    // (what one sample surveyed stays surveyed for the next, as it would in play: a host that has left leaves its land
    // painted. A sample that is laid again, `key` the same, begins as it began: its own run is played afresh)
    if (this.sample?.last?.survey?.tiles?.size && key !== this.sample.key) this.sampleMemory = packMemory(this.sample.last.survey.tiles.keys());
    this.sample = fs ? { fs, key, surveyor: createSurveyor({ storage: { get: () => this.sampleMemory ?? null, set: () => true }, now: fxNow }), last: null } : null;
    // (what the sample opens with is simply there, as a page's own records are when it opens: nothing is announced for it)
    this.boardSeen = null; this.boardMemo = null;
    this.invalidate();
  }
  /** The page's source with the sample's records laid over it (the page's own when there is no sample). */
  sampled(src) {
    const S = this.sample;
    if (!S || !src) return src;
    const fs = typeof S.fs === 'function' ? S.fs() : S.fs;
    // (what the viewer had surveyed before the sample is remembered: the sample adds to the picture, as play would)
    if (!this.sampleMemory && src.survey?.tiles) this.sampleMemory = packMemory(src.survey.tiles.keys());
    // (read again only when the sample hands over another state: the survey's input is not rebuilt every frame)
    if (S.last?.fs !== fs) S.last = { fs, survey: S.surveyor(surveyInput({ ...fs, wallet: fs.wallet ?? { address: 'sample' } }, { terrainOf: src.terrainOf, ready: true, scope: { cluster: 'sample', programId: 'sample', seasonId: 0 } })) };
    const survey = S.last.survey;
    const provinceOf = src.provinceOf ? (p, q, o) => fs.provinces?.get?.(`${p},${q}`)?.province ?? src.provinceOf(p, q, o) : undefined;
    const people = src.people ? () => ({ ...src.people(), ...(fs.people ?? {}) }) : undefined;
    return { ...src, survey, provinceOf, people, own: fs.own ?? src.own, sample: true };
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
    this.opened = { kind: plan.kind, rank: plan.rank, width: size.width, height: size.height, title, subject, at: plan.at };
    // (the plan's view is the flat one: the subject goes where it is seen in the middle of the uncovered part)
    const drop = plan.kind === 'home' ? this.seatDrop() : 0;
    const to = this.aim(plan.at, plan.view.zoom, size, inset, drop);
    // the dive is under way and its end moved (the page's sheets settled, the viewer became more, the window changed
    // size): the same flight ends there, with no new start
    if (this.dive && !this.dive.calm && this.cam.moving && prev && !title && !prev.title) { this.cam.retarget(to); this.sync(); return true; }
    this.setView(to, { auto: true });
    // (found on the merged screens, 2026-10-11: after a full reload the map stood on blank parchment and only Home
    // brought the village back. A card of the page that opens before the viewer is known — the first village's — had
    // the camera's place kept for it, hud/camkeep.mjs, and that place was the waiting sheet's; putting the card away
    // then flew the camera "back" there, off the village the opening had just framed. The opening on a new subject is
    // a move by name: a place kept before it is not gone back to)
    // (a conquest season's page: any other keeps the camera's count as it was)
    if ((!prev || prev.subject !== subject) && (this.keepFeedNow ?? this.keepFeed?.())?.enabled) this.moves = (this.moves ?? 0) + 1;
    const f = (b => ({ x: b.x, y: b.y }))(freeBox(size, inset));
    // where an opening starts: a player's land is reached from a little above
    const start = plan.kind === 'fit' ? null : this.aim(plan.at, Math.max(ZOOM_MIN, to.zoom * OPEN_FROM), size, inset, drop);
    if (title) {
      // the title is an opaque scene of its own (UX brief §11.9): behind it the camera waits at the opening's start,
      // whatever changes there (the viewer becomes known, the window changes size). Nothing travels unseen
      if (start) this.hold(start);
      this.reveal = undefined;
    } else if (prev?.title) {
      // the title was put away: the opening plays now, from where the camera waited behind it, and the land comes out of the bare table
      if (start) this.cam.from(was, { ms: MOVE_MS.open, ease: EASE.outCubic, anchor: f });
      this.reveal = now;
    } else if (!prev) {
      // the first picture (UX brief §13.4): the dive. The camera sets off at once from the waiting picture's own view,
      // the whole sheet seen from the seat, and flies down to its subject over the bare sheet; the land comes out of
      // the paper as soon as it is there (`draw`). One picture all the way: nothing is laid over anything
      // (from the waiting picture as it was last shown: the page's sheets may have moved since, with the answer that
      // said who is looking, and the picture must not jump to where they would put it now)
      const from = this.waitAt ?? this.waitView(size, inset), calm = this.cam.reduced();
      this.cam.from(from, { ms: DIVE.ms, ease: EASE.outQuint, kind: 'fly', real: true });
      this.dive = { t0: now, from, calm, seat: !calm && this.tiltMax > 0, p: calm ? 1 : 0, landAt: null };
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
    const table = (g, view = groundView(this.cam.drawn, G)) => paintTable(g, { view, size: gsize, ratio: gr, sheet: sheetOf(this.rings ?? 1), bare: true });
    const inset = this.inset();
    // the depth dressing: on the page, over the stage (custom properties of #map-dress); on a map without a stage, in the canvas
    const dressing = (zoom, deg = 0, shown = 1, haze = 1, sheet = 'none', dusk = 0) => {
      if (staged) { this.dressPage(deg, { near: nearness(zoom), shown, inset, haze, sheet, dusk }); return; }
      const step = Math.round(nearness(zoom) * 16);
      this.stamped(ctx, 'dressCv', `${W}x${H}|${step}|${inset.top},${inset.right},${inset.bottom},${inset.left}`, W, H, dpr, g => paintDressing(g, size, { near: step / 16, inset }));
    };
    const wipe = () => { if (staged) { octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, OW, OH); } };
    const src = this.source();
    this.rings = src.ringsOpen ?? 1;
    if (!this.open(src, size, { dpr, now })) {
      // who is looking is not known yet: the table and the bare sheet, seen from the seat. Never the world first, and
      // nothing that says who the viewer is or is not (UX brief §12.3). Painted once: it does not change
      // (on the ground canvas itself, the stage at the seat's angle, under the page's own haze: the opening's dive
      // begins as this very picture)
      const wv = this.waitView(size, inset), key = `${W}x${H}|${this.rings}|${wv.x.toFixed(1)},${wv.y.toFixed(1)},${wv.zoom.toFixed(4)}`;
      const WT = tiltGeo(size, this.tiltMax, this.persp);
      if (this.bare !== key) { this.paintWait(ctx, wv, G, gsize, gr); this.bare = key; }
      /** The waiting picture's view while it shows: the opening's dive begins exactly there. */
      this.waitAt = wv;
      wipe();
      if (!staged) dressing(0);
      else this.dressPage(WT.deg, { near: nearness(wv.zoom), shown: 1, inset, haze: 1, sheet: this.sheetClip(wv, size, WT, G) });
      this.updatePointer(null);
      // (what the first picture will need whoever is looking: the rules module for the land's shape; asked for now)
      // (and, while a viewer's record is on its way, the sprites any land of the tile view is made of)
      try { (src.terrainOf ?? this.terrainOf)?.(0, 0); if (this.art && src.open?.ready === false) this.art.warm(artSize(RADIUS * heroZoom(dpr) * gr).key); } catch { /* no terrain on this page */ }
      PROBE.end('wait', ctx);
      return;
    }
    this.bare = null;
    const logical = this.cam.view;
    // the dive: how far it has come (by the zoom it has travelled; by the clock where the zoom hardly changes)
    const dive = this.dive;
    if (dive?.seat) {
      const z0 = dive.from.zoom, span = Math.log(logical.zoom / z0);
      dive.p = !this.cam.moving ? 1 : Math.abs(span) > 0.08 ? Math.max(0, Math.min(1, Math.log(this.cam.drawn.zoom / z0) / span)) : this.cam.progress();
    }
    const v = this.cam.drawn;
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
        this.paintScene(ctx, src, gv, was, gsize, gr, { now, table, quad: quadOf(v, T), up, still: true });
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
    if (lod !== 'tile' && this.apron) this.apron = null;
    if (dive && dive.landAt === null) {
      // The dive over the bare sheet (UX brief §13.4). The picture on screen is the sheet on its table, as the camera
      // sees it on its way down; the picture the camera flies to is made meanwhile, into a context that shows
      // nothing: its sprites are asked for, its ground, its relief and its pieces of the sea are made and kept, a
      // few milliseconds of it a frame. The land comes out of the paper once the province the camera flies to has its
      // ground and its sprites (the rest joins as it is made: a sheet of chart, a soft body of cloud), or after
      // OPEN_HOLD_MS whatever is missing. Under reduced motion nothing travels: the waiting picture stays until the
      // land is there, then the picture changes once.
      // (the picture that is made is the one the camera ends on, as wide as the apron of a travelling picture is
      // painted: what the last part of the flight shows)
      const tl = lodFor(logical.zoom, this.lod, E);
      // (the sprites that picture is made of are asked for at once, before the rules module has said what land lies
      // there: the set of the tile view, or the far bitmaps' own)
      this.art?.warm(artSize(RADIUS * (tl === 'tile' ? logical.zoom * gr : farRes(logical.zoom * gr))).key);
      // (under reduced motion: the resting picture itself, the part of the board the tilt shows)
      const pm = tl === 'tile' && !dive.calm ? APRON.margin / gr : 0, wide = tl === 'tile' && !dive.calm ? 1 / DIVE.near : 1, psize = { width: gsize.width * wide + 2 * pm, height: gsize.height * wide + 2 * pm };
      // (the first frame of it makes nothing: it asks for what the picture is made of, and is over at once, so the
      // requests leave now and not after a long frame)
      INERT_CTX.frame();
      const pre = this.paintScene(INERT_CTX, src, groundView(logical, G), tl, psize, gr, { now, artZoom: logical.zoom, prep: dive.asked ? true : 'ask', quad: dive.calm ? quadOf(logical, this.geo(logical.zoom, size)) : null });
      dive.asked = true;
      const waited = now - dive.t0, near = dive.calm || (lod === tl && v.zoom >= logical.zoom * DIVE.near);
      const made = pre.pending === 0 || (waited > DIVE.rest && tl === 'tile' && this.homeMade());
      // (a moment earlier than now: the frame that shows the land first shows a little of it, not none)
      if ((made && near) || waited > OPEN_HOLD_MS) dive.landAt = now - DIVE.land * 0.12;
      if (dive.landAt === null) {
        const bv = dive.calm ? dive.from : v, BT = dive.calm ? tiltGeo(size, this.tiltMax, this.persp) : T;
        this.paintBare(ctx, groundView(bv, G), gsize, gr);
        wipe();
        if (!staged) dressing(0);
        else this.dressPage(BT.deg, { near: nearness(bv.zoom), shown: 1, inset, haze: 1, sheet: this.sheetClip(bv, size, BT, G) });
        this.updatePointer(null);
        this.mark('pending');
        this.dirty = true;
        PROBE.end('wait', ctx);
        try { this.onDraw?.(v, size, lod); } catch { /* the page's own follower */ }
        return;
      }
    }
    const out = this.paintScene(ctx, src, gv, lod, gsize, gr, { now, rest, table, artZoom: Math.max(v.zoom, logical.zoom), quad: quadOf(v, T), up, rush: !!dive });
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
    // the opening: the land comes out of the picture that was on screen, its labels with it
    let shown = 1;
    if (dive) {
      // out of the bare sheet, where the camera is: the sheet is laid over the finished picture, less of it with every frame
      // (the frame that shows the land first is the longest of the opening: the apron of the travelling picture is made
      // in it. The dissolve's clock is set again by the frame after it, so that frame's length is not taken out of the
      // dissolve: the land comes in over `land` ms of frames a person sees)
      if (dive.seen === 1 && motion && !dive.calm) dive.landAt = now - DIVE.land * 0.2;
      dive.seen = (dive.seen ?? 0) + 1;
      const k = motion && !dive.calm ? (now - dive.landAt) / DIVE.land : 1;
      if (k < 1) {
        shown = 1 - Math.pow(1 - Math.max(0, k), 2);
        ctx.save(); ctx.globalAlpha = 1 - shown; this.paintBare(ctx, gv, gsize, gr); ctx.restore();
        this.dirty = true;
      } else {
        this.reveal = null;
        // (the dive itself, the seat's angle easing into the zoom's own, lasts until the camera has come down)
        if (!this.cam.moving) this.dive = null;
      }
    } else if (this.reveal !== undefined && this.reveal !== null) {
      // (the title was put away: out of the bare table)
      const k = motion ? (now - this.reveal) / REVEAL_MS : 1;
      if (!(k < 1)) this.reveal = null;
      else {
        shown = 1 - Math.pow(1 - Math.max(0, k), 2);
        ctx.save(); ctx.globalAlpha = 1 - shown; table(ctx); ctx.restore();
        this.dirty = true;
      }
    }
    /** How much of the land is on screen, 0..1 (for whoever measures the opening). */
    this.landShown = shown;
    // (for whoever measures the opening: frames a person saw in which a square of the sea was only its stand-in body)
    if (out.rough && shown > 0.02) this.roughShown = (this.roughShown ?? 0) + 1;
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
    // (the dark of the room above the horizon stays through the dissolve out of the waiting picture: only the picture changes)
    // (close on the bell before joining, the tower is the picture's subject and stands up into the far rows' band: the
    // haze is thinner there, BELL_HAZE, or its spire pales with the horizon)
    // (through a dive the haze and the dark are there from the waiting picture on: only the land comes; the bell's
    // thinner haze comes as the camera comes down)
    const thin0 = this.opened?.kind === 'frame' && !this.cam.userMoved ? BELL_HAZE : 1, thin = dive?.seat ? 1 + (thin0 - 1) * dive.p : thin0;
    dressing(v.zoom, T.deg, dive ? 1 : shown, words * thin, staged ? this.sheetClip(v, size, T, G) : 'none', 1 - thin);
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
   * Where the camera stands while nobody knows yet who is looking (UX brief §12.3): the whole sheet on its table, seen
   * from the seat, in the part of the picture nothing covers. The flat view for a box `size`; the board is at its
   * full angle (the picture is the seat's, not the far view's flat chart).
   */
  waitView(size = this.size(), inset = this.inset()) {
    const sh = sheetOf(this.rings ?? 1), f = freeBox(size, inset), g = tiltGeo(size, this.tiltMax, this.persp);
    const lean = g.flat ? 1 : Math.cos((g.deg * Math.PI) / 180);
    const zoom = Math.max(ZOOM_MIN, Math.min((WAIT_VIEW.wide * f.width) / (2 * sh.x), (WAIT_VIEW.high * f.height) / (2 * sh.y * lean)));
    const s = g.toStage(size.width / 2 + f.x, size.height / 2 + f.y + WAIT_VIEW.drop * f.height);
    return { x: -(s.x - size.width / 2) / zoom, y: -(s.y - size.height / 2) / zoom, zoom };
  }
  /**
   * The waiting picture: the table, and on it the sheet with nothing drawn on it yet (its paper, its neatline, its
   * rose), at the map's flat view `view`. The stage shows it at the seat's angle, under the page's own haze.
   */
  paintWait(g, view, G, gsize, ratio) { this.paintBare(g, groundView(view, G), gsize, ratio); }
  /**
   * The bare sheet on its table at `gv`, the ground canvas's own flat view: the waiting picture, and every picture of
   * the opening's dive until the land is there. The sheet is the one kept picture of it (`quickSheet`: a copy), so the
   * waiting picture and the dive's first frame are the same pixels.
   */
  paintBare(g, gv, gsize, ratio) {
    const sheet = sheetOf(this.rings ?? 1), z = gv.zoom, hw = gsize.width / 2 / z, hh = gsize.height / 2 / z;
    const box = { x0: gv.x - hw, y0: gv.y - hh, x1: gv.x + hw, y1: gv.y + hh };
    const corners = [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 }];
    if (!this.quickSheet(g, { view: gv, size: gsize, ratio, sheet, corners, ringsOpen: this.rings ?? 1 })) {
      // (no spare canvas to keep the sheet in: painted straight)
      paintTable(g, { view: gv, size: gsize, ratio, sheet });
      g.setTransform(ratio * z, 0, 0, ratio * z, ratio * (gsize.width / 2 - gv.x * z), ratio * (gsize.height / 2 - gv.y * z));
      paintSheet(g, sheet, { box, res: farRes(z * ratio), zoom: z });
    }
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  /** Whether the province the opening flies to has its ground of the tile view, and no sprite is still on its way. */
  homeMade() {
    const at = this.opened?.at;
    if (!this.art || !at) return false;
    const [q, r] = inverseHex(at.x, at.y).split(',').map(Number), l = locate(q, r);
    return this.art.loading === 0 && !!this.art.groundStale(l);
  }
  /** The province the opening flies to, as "P,Q" (its ground is made first), or null. */
  diveKey() {
    const at = this.opened?.at;
    if (!at) return null;
    const [q, r] = inverseHex(at.x, at.y).split(',').map(Number), l = locate(q, r);
    return `${l.p},${l.q}`;
  }

  /**
   * What lies under the world: the table and the sheet (map/table.mjs). Both are still and lie on the world, so
   * they are painted once into a picture of the part of the world around the view (a third wider on every side)
   * and copied from it frame by frame; the picture is made again when the view leaves it or the zoom has moved a
   * step. Deep inside the land nothing of either can show: one flat fill of paper stands in until the land's
   * own bitmaps are there. `seen` and `corners`: the part of the world on the canvas.
   */
  backdrop(g, { view, size, ratio, sheet, paperRes, seen, corners, ringsOpen, quick = false, direct = false }) {
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
    // (a pan, a drag, a glide: the zoom is not travelling. The picture is then made for this zoom's own pixels and
    // copied, not stretched: a copy costs a third of a smoothed stretch of the whole canvas)
    const zooming = this.cam.moving && Math.abs(Math.log(this.cam.drawn.zoom / this.cam.view.zoom)) > 1e-4;
    const moving = zooming;
    const cap = wide => Math.sqrt(BACKDROP_PIXELS / (wide * wide * w * h));
    const fits = b && b.rings === ringsOpen && b.paper === paperRes && seen.x0 >= b.x0 && seen.y0 >= b.y0 && seen.x1 <= b.x1 && seen.y1 <= b.y1
      // (a picture already as fine as its budget allows serves any closer zoom, travelling or at rest: with the finer
      // ground of the fix pass the travelling rule alone never held near the hero zoom, and the sheet was painted
      // again on every frame of a flight, some 110 ms of each)
      // (travelling, the sheet under the land may be stretched by up to BACKDROP_STRETCH before it is made again: paper
      // in motion; made again at every 2% it was painted on most frames of a flight in)
      // (counted from the zoom it was made at: where the pixel budget holds its fineness below the screen's, it was
      // still made again on every frame of a flight in, as the budget's own limit rose with the narrowing view)
      // (and one made for the apron's larger box, a little coarser for the same budget, serves the canvas's own
      // picture too: BACKDROP_SHARE; else the two would make it again in turn)
      && ((moving ? px <= Math.max(b.res, b.px ?? 0) * BACKDROP_STRETCH && px >= b.res * 0.6 : Math.abs(px - b.res) < 1e-9) || (px > b.res && b.res >= cap(1.68) * BACKDROP_SHARE));
    // (`quick`: the picture is travelling. Laying the paper for this picture costs a tenth of a second and more, and
    // a flight did it three or four times. While the camera travels the picture is made from the whole sheet kept as
    // one soft picture (quickSheet), which costs a copy; the paper is laid properly once the camera rests)
    const serves = fits && (quick || !b.quick);
    // (`direct`: the caller keeps the picture itself, the apron: nothing is kept here for it, the soft sheet goes straight onto it)
    if (!serves && quick && direct && this.quickSheet(g, { view, size, ratio, sheet, corners, ringsOpen })) return;
    if (!serves) {
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
      const bview = { x: x0 + bw / 2, y: y0 + bh / 2, zoom: res }, bsize = { width: bw * res, height: bh * res };
      const soft = quick && this.quickSheet(bg, { view: bview, size: bsize, ratio: 1, sheet, corners: [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 }], ringsOpen });
      if (!soft) {
        paintTable(bg, { view: bview, size: bsize, ratio: 1, sheet });
        bg.setTransform(res, 0, 0, res, -x0 * res, -y0 * res);
        paintSheet(bg, sheet, { box, res: paperRes, zoom: view.zoom });
      }
      b = this.under = { cv, ...box, res, px, rings: ringsOpen, paper: paperRes, quick: !!soft };
    }
    const k = b.res;
    // (pixel for pixel when the picture was made for this zoom: a copy)
    if (Math.abs(px - k) < 1e-9) { g.drawImage(b.cv, Math.round((seen.x0 - b.x0) * k), Math.round((seen.y0 - b.y0) * k), W, H, 0, 0, W, H); return; }
    g.imageSmoothingEnabled = true;
    g.drawImage(b.cv, (seen.x0 - b.x0) * k, (seen.y0 - b.y0) * k, w * k, h * k, 0, 0, W, H);
  }

  /**
   * The whole sheet as one kept picture (its shadow, its paper, its edge, its neatline and rose; nothing round it),
   * laid over the table: what stands in for the sheet under the world while the camera travels. Made once for a
   * world's size, at most SHEET_PIXELS; soft close up, which a travelling picture forgives. Returns false where no
   * spare canvas can be had (the caller paints the sheet itself).
   */
  quickSheet(g, { view, size, ratio, sheet, corners, ringsOpen }) {
    let q = this.sheetPic;
    if (!q || q.rings !== ringsOpen) {
      // (room for the cast shadow: it reaches some 80 px of a small sheet's own measure past the edge)
      const pad = 90 * Math.max(1, sheet.x / 1100), bw = 2 * (sheet.x + pad), bh = 2 * (sheet.y + pad);
      const res = Math.min(1, Math.sqrt(SHEET_PIXELS / (bw * bh)));
      const cv = spareCanvas(this.canvas.ownerDocument, Math.ceil(bw * res), Math.ceil(bh * res)), sg = cv?.getContext?.('2d');
      if (!sg) return false;
      sg.setTransform(res, 0, 0, res, (sheet.x + pad) * res, (sheet.y + pad) * res);
      paintSheet(sg, sheet, { box: { x0: -sheet.x - pad, y0: -sheet.y - pad, x1: sheet.x + pad, y1: sheet.y + pad }, res, zoom: res });
      q = this.sheetPic = { cv, rings: ringsOpen, x: -sheet.x - pad, y: -sheet.y - pad, w: bw, h: bh };
    }
    if (tableShows(corners, sheet)) paintTable(g, { view, size, ratio, sheet });
    const z = view.zoom;
    g.setTransform(ratio * z, 0, 0, ratio * z, ratio * (size.width / 2 - view.x * z), ratio * (size.height / 2 - view.y * z));
    g.imageSmoothingEnabled = true;
    g.drawImage(q.cv, q.x, q.y, q.w, q.h);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return true;
  }

  /**
   * The apron (UX brief §12.7: what does not change while the camera travels is not painted again): the still ground
   * of the tile view, the table, the sheet, the land's ground and the cloud sea lying on it, kept in one picture that
   * reaches APRON.margin device px past the canvas on every side. A travelling frame copies its part of it (pixel
   * for pixel while only the place changes; stretched a little while the zoom travels, between APRON.out and
   * APRON.in of the zoom it was made at) and paints only what stands and what lives. It is made again when the
   * picture leaves it (then a little ahead of the way the camera goes), when the zoom has travelled too far from
   * it, when the data changed (`stamp`), and, while a part of it was still being made, every APRON.retry ms.
   * `paint(g, {view, size, box})` paints the picture and returns `{whole}`. Returns `{whole}` when the frame was
   * served, or null (no spare canvas, or a canvas too large to keep one for): the caller paints the frame whole.
   */
  groundApron(ctx, { view, size, dpr, seen, ringsOpen, now, paint, away = false }) {
    const W = ctx.canvas?.width ?? Math.round(size.width * dpr), H = ctx.canvas?.height ?? Math.round(size.height * dpr);
    const px = dpr * view.zoom;
    // (the margin gives way on a very large canvas; below a quarter of it an apron is not worth its pixels)
    let M = APRON.margin;
    while (M >= APRON.margin / 4 && (W + 2 * M) * (H + 2 * M) > APRON.pixels) M = Math.floor(M / 2);
    if (M < APRON.margin / 4 || !(px > 0)) { this.apron = null; return null; }
    let a = this.apron;
    const scale = a ? px / a.px : 1;
    const inside = a && seen.x0 >= a.box.x0 && seen.y0 >= a.box.y0 && seen.x1 <= a.box.x1 && seen.y1 <= a.box.y1;
    const fits = inside && a.stamp === this.stamp && a.rings === ringsOpen && a.W === W && a.H === H && a.dpr === dpr
      && (Math.abs(scale - 1) < 1e-9 || (scale > APRON.out && scale < APRON.in))
      // (one that was not whole is made again after a while: never sooner than three times what making it took, or a
      // slow canvas would make it on every frame)
      && (a.whole || now - a.at < Math.max(APRON.retry, a.cost * 3));
    if (!fits) {
      const cw = W + 2 * M, ch = H + 2 * M;
      // (a canvas of the page's own where there is a page: copying from one is twice as fast as from a canvas off the page)
      const doc = this.canvas.ownerDocument, own = doc?.createElement ? Object.assign(doc.createElement('canvas'), { width: cw, height: ch }) : null;
      const cv = a?.cv?.width === cw && a.cv.height === ch ? a.cv : own?.getContext ? own : spareCanvas(doc, cw, ch), g = cv?.getContext?.('2d', { alpha: false });
      if (!g) { this.apron = null; return null; }
      // a little ahead of the way the camera goes: a straight pan meets the apron's edge half as often
      // (`away`: the camera is flying out. The picture is made for a wider view than this one, about the same middle)
      const az = away ? view.zoom * APRON.away : view.zoom, apx = dpr * az;
      const was = this.apronSeen, m = M / apx, lead = APRON.lead * m, pan = !away && was && was.zoom === view.zoom;
      const dx = pan ? Math.sign(Math.round((view.x - was.x) * px)) * lead : 0, dy = pan ? Math.sign(Math.round((view.y - was.y) * px)) * lead : 0;
      const cx = (seen.x0 + seen.x1) / 2 + dx, cy = (seen.y0 + seen.y1) / 2 + dy, hw = cw / apx / 2, hh = ch / apx / 2;
      const box = { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
      const av = { x: cx, y: cy, zoom: az }, as = { width: cw / dpr, height: ch / dpr };
      const t0 = clock();
      const r = paint(g, { view: av, size: as, box });
      a = this.apron = { cv, box, px: apx, stamp: this.stamp, rings: ringsOpen, W, H, dpr, whole: !!r?.whole, at: now, cost: clock() - t0 };
    }
    this.apronSeen = { x: view.x, y: view.y, zoom: view.zoom };
    const k = a.px, sx = (seen.x0 - a.box.x0) * k, sy = (seen.y0 - a.box.y0) * k;
    // (both canvases are opaque: a plain draw is a copy, and the faster one)
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (Math.abs(px - k) < 1e-9) ctx.drawImage(a.cv, Math.round(sx), Math.round(sy), W, H, 0, 0, W, H);
    else { ctx.imageSmoothingEnabled = true; ctx.drawImage(a.cv, sx, sy, (W * k) / px, (H * k) / px, 0, 0, W, H); }
    ctx.restore();
    return { whole: a.whole };
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
   * ('full' | 'live' | 'far'), `rough` (squares of the cloud sea shown as their stand-in body), `over(o, world)`, which paints what is read
   * rather than looked at (labels, warnings' words, pins, the guide's words)
   * into `o`, the label canvas, whose own flat transform is `world`
   * (default: this canvas), and how much art of this picture is still on
   * its way.
   */
  paintScene(ctx, src, view, lod, size, dpr, { now = clock(), rest = false, artZoom = view.zoom, table = () => {}, quad = null, up = null, still = false, prep = false, rush = prep } = {}) {
    // (`still`: one picture for a dissolve, of a level that is being left: nothing is kept for it)
    // (`prep`: the opening's first picture is made before it is shown: `ctx` paints nothing, and what is kept is
    // the art's own, the ground bitmaps, the relief, the pieces of the sea; no picture of the canvas is kept or
    // copied. `rush`: the opening is on screen: more of what is new is made a frame)
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
    // (travelling, and for a moment after: the paper is laid properly once the camera has rested BACKDROP_IDLE_MS,
    // not in the frame it arrives in)
    if (this.cam.moving || this.drag?.moved) this.movedAt = now;
    const travelling = now - (this.movedAt ?? -Infinity) < BACKDROP_IDLE_MS;
    if (!travelling && this.under?.quick && this.layers?.key) { this.layers.key = null; this.dirty = true; }
    else if (travelling && this.under?.quick) this.invalidateSoon(BACKDROP_IDLE_MS);
    const under = g => {
      if (prep) return;
      this.backdrop(g, { view, size, ratio: dpr, sheet, paperRes, seen, corners, ringsOpen, quick: travelling });
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
    let wanted = 0, drawn = 0, kind = 'far', labels = null, pending = 0, rough = 0;
    const artTiles = [], artCells = [];
    // Art, tile view: every level is drawn as tiles (the chart, muted land, land in sight; unopened as cloud sea)
    // (unopened: its tiles are in the model so the land knows where it ends; the cloud itself is the sea's)
    const artEntry = (pr, fog, selected, rec, seen, sight) => {
      if (fog === 'unopened') return { tiles: { ...pr, fog, selected }, wanted: 0, drawn: 0 };
      const t = terrainOf?.(pr.p, pr.q);
      const prov = seen ? src.provinceOf?.(pr.p, pr.q) ?? null : null;
      const territoryMode = !!src.territoryEnabled, territory = territoryMode && sight ? src.territoryOf?.(pr.p, pr.q) ?? null : null;
      // (`wait`: the province's record is on its way: the opening does not make its ground twice)
      if (t) return { tiles: { ...pr, ...t, rec, fog, selected, prov, territoryMode, territory, wait: seen && !prov && !!src.provinceOf, clash: sight ? src.clashOf?.(pr.p, pr.q) ?? null : null, pending: sight ? src.pendingOf?.(pr.p, pr.q) ?? null : null }, wanted: 1, drawn: 1 };
      return { plain: g => paintProvince(g, { ...pr, rec, fog, selected, scale: z }), wanted: 1, drawn: 0 };
    };
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
        const e = artEntry(pr, fog, selected, rec, seen, sight);
        if (e.tiles) artTiles.push(e.tiles);
        if (e.plain) plain.push(e.plain);
        wanted += e.wanted; drawn += e.drawn;
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
        // (`control`: the nation holding the province's keep, from the season's shared control record. It is public —
        // the standings and the reach list say it of every province — so the territory wash is drawn over unsurveyed
        // land too; everything else of the record still waits for the survey. Never in the arrival-control sample world)
        const held = src.territoryEnabled ? null : recs.get(key)?.control;
        // (a conquest season: a capture's own record is shown before the control record has caught up with it, and the
        // old holder until the capture's flood has run: map/keeps.mjs)
        const shownBy = !src.territoryEnabled && this.keeps.on && this.keeps.rows.has(key) ? this.keeps.farHolder(key) : null;
        if (t) { artCells.push({ ...pr, ...t, rec, control: Number.isInteger(shownBy) ? shownBy : Number.isInteger(held) ? held : null, fog, selected, territoryMode: !!src.territoryEnabled, territory: src.territoryEnabled && sight ? src.territoryOf?.(pr.p, pr.q) ?? null : null, prov: seen ? src.provinceOf?.(pr.p, pr.q, { far: true }) ?? null : null, tiers: seen && src.tierOf ? Array.from({ length: 12 }, (_, j) => src.tierOf(pr.p, pr.q, j)) : null }); continue; }
      }
      plain.push(g => paintProvince(g, { ...pr, rec, fog, selected, scale: z }));
    }
    // what is the viewer's own and what the selection can do (UX brief §5): one bundle for this frame's passes
    const F = this.youFrame(src, survey, lod, z, terrainOf);
    F.seen = seen; F.up = up; F.dpr = dpr;
    // the keeps of a conquest season (map/keeps.mjs): their records are read once a frame; nothing of them in any other season
    // (the page's part of them is asked for once a frame: map/keepmount.mjs)
    const feed = this.keepFeedNow = this.keepFeed?.() ?? null;
    const KB = F.KB = this.keepsOn(src, recs, feed) ? this.keeps : null;
    this.keeps.on = !!KB;
    if (KB) {
      KB.frame(recs, { events: feed?.events ?? null, viewer: feed?.viewer ?? src.viewerFaction ?? null, bell: feed?.bell ?? src.bell ?? null }, { fx: F.fx, still: F.still });
      // (a capture that is the viewer's nation's own, won or lost: the camera comes to it when the player is not busy)
      if (KB.want) { if (!prep) this.arrivalWant = { ...KB.want, at: F.fx, moment: true }; KB.want = null; }
    }
    // a resting tile view: the still layers (the table is in the ground layer), then the animated ones
    // (`between`: on the ground, under what stands on it: the viewer's land and the lit tiles, then the effects engine's ground pass)
    // the cloud sea: its still part (the bank and the puffs) and the light and shade that drift over it
    // (the sea's fineness: as fine as the screen; through a flight as fine as the coarser of where the flight began and
    // where it ends, the same for every frame of it: the far view's own pieces carry a flight in, a flight out makes
    // its few coarse pieces at once, and no frame on the way asks for a fineness of its own)
    // (the opening's dive begins far above its subject, and the sea it ends over is the one made for it: the fineness
    // of where the camera is going)
    // (`diving`: a picture of the dive, on screen or being made for it. Under reduced motion there is no dive: the
    // picture that is made is the resting one, as fine as it will be shown)
    const diving = !!this.dive && !this.dive.calm && (!!prep || this.cam.moving);
    const seaZoom = diving ? this.cam.view.zoom * DIVE.sea0 : this.cam.moving ? Math.min(this.cam.tween?.from?.zoom ?? z, this.cam.view.zoom) : z;
    const sea = (g, part) => {
      // (cloud is soft: it is made for the screen's own pixels, not for the finer ground canvas of a screen of one device px per px)
      const r = this.sea.paint(g, { box: seen, res: seaRes(seaZoom * Math.min(dpr, this.dpr())), ringsOpen, sheet, now: fxNow(), still: reducedMotion(), part, bakes: rush ? SEA_BAKES * 3 : SEA_BAKES, budget: prep === 'ask' ? -1 : prep ? DIVE.sea : null });
      if (r.pending) { pending += r.pending; this.dirty = true; }
      if (r.rough) rough += r.rough;
      // (the drift moves a few px a second: a frame when it has moved about one)
      else if (r.seen && part !== 'still' && !reducedMotion()) this.invalidateSoon(Math.max(110, Math.min(420, 1300 / (Math.hypot(DRIFT_SPEED.x, DRIFT_SPEED.y) * z))));
      return r;
    };
    // (the cloud sea lies on the sheet: it is laid right after the ground, under the ground marks and under what stands
    // on the land, in every kind of frame; so a picture of the ground with its sea can be kept and moved: the apron)
    const marks = c => { c.setTransform(...world); this.groundPass(c, F, 'all'); this.between?.(c, { zoom: z, now }); };
    const tileOpts = artTiles.length ? { zoom: z, dpr, artZoom, passing: this.cam.moving, rush, budget: prep === 'ask' ? -1 : prep ? DIVE.ground : null, first: rush ? this.diveKey() : null, lo: diving ? DIVE.lo : null, stamp: this.stamp, sea: true, up, seaPass: sea, between: c => { c.setTransform(...world); sea(c, null); marks(c); }, ground: (c, phase) => this.groundPass(c, F, phase), stand: KB ? c => { c.setTransform(...world); KB.top(c, F); } : null, terrainAt: terrainLookup(terrainOf), fogAt, selected: null, viewerFaction: src.viewerFaction ?? null, demoRoads: !!src.demoRoads, ringsOpen: src.ringsOpen ?? null, replayRing: src.artReplayRing ?? null, engineStage: src.engineStage ?? 0, relics: src.relics ?? [], waystones: src.waystones ?? [], demoSpecials: !!src.demoSpecials, rivers: src.rivers ?? [], demoRivers: !!src.demoRivers, alliedPairs: src.alliedPairs ?? [], survey,
      // people (people/crowds.mjs): the source's departures, explores and holder names; tags nearest the view centre first
      people: src.people ? { ...src.people(), centre: { x: view.x, y: view.y } } : null } : null;
    const missed = this.art?.misses ?? 0;
    const layered = tileOpts && rest && !prep ? this.paintLayered(ctx, artTiles, tileOpts, world, now, under) : null;
    // a picture that travels (a pan, a drag, a glide, a flight inside the tile view): the still ground under it, the
    // table, the sheet, the land's ground and the cloud sea, comes from the apron, a picture of it kept a little
    // larger than the canvas and moved with the camera; only what stands and what lives is painted afresh
    const apron = tileOpts && !layered && !still && !prep ? this.groundApron(ctx, { view, size, dpr, seen, ringsOpen, now, away: this.cam.moving && this.cam.view.zoom < z * 0.98, paint: (g, a) => {
      const az = a.view.zoom, aw = [dpr * az, 0, 0, dpr * az, dpr * (a.size.width / 2 - a.view.x * az), dpr * (a.size.height / 2 - a.view.y * az)];
      const tiles = [], cells = [];
      for (const pr of visibleProvinces(a.view, a.size, maxRing, null)) {
        const sv = survey.province(pr.p, pr.q), e = artEntry(pr, fogOf(pr.p, pr.q), false, sv.max >= L2 ? recs.get(`${pr.p},${pr.q}`) : null, sv.max >= L2, sv.max === L3);
        if (e.tiles) tiles.push(e.tiles);
        if (e.plain) cells.push(e.plain);
      }
      this.backdrop(g, { view: a.view, size: a.size, ratio: dpr, sheet, paperRes, seen: a.box, corners: [{ x: a.box.x0, y: a.box.y0 }, { x: a.box.x1, y: a.box.y0 }, { x: a.box.x1, y: a.box.y1 }, { x: a.box.x0, y: a.box.y1 }], ringsOpen, quick: true, direct: true });
      g.setTransform(...aw);
      for (const f of cells) f(g);
      const had = this.art.misses;
      this.art.paint(g, tiles, { ...tileOpts, zoom: az, part: 'ground', between: null });
      g.setTransform(...aw);
      // (while the zoom travels the sea's drifting light is left out of the kept picture, which lasts a second: the
      // light is half the sea's cost)
      const zooming = this.cam.moving && Math.abs(Math.log(this.cam.drawn.zoom / this.cam.view.zoom)) > 1e-4;
      const r = this.sea.paint(g, { box: a.box, res: seaRes(seaZoom * Math.min(dpr, this.dpr())), ringsOpen, sheet, now: fxNow(), still: reducedMotion(), part: zooming ? 'still' : null });
      rough += r.rough ?? 0;
      return { whole: this.art.misses === had && !r.pending && cells.length === 0 };
    } }) : null;
    if (apron && !apron.whole) { pending++; this.dirty = true; }
    if (!layered && !apron) under(ctx);
    ctx.setTransform(...world);
    // (tiles without the art, ?art=0: the ground marks go straight over the plain tiles)
    if (!tileOpts && lod === 'tile') this.groundPass(ctx, F, 'all');
    if (artCells.length) {
      // while the picture travels, far bitmaps are not painted for zooms it only passes through (the ones at hand
      // are stretched); arriving, they are painted for where it rests
      this.art.paintFar(ctx, artCells, { zoom: z, dpr, terrainAt: terrainLookup(terrainOf), fogAt, alliedPairs: src.alliedPairs ?? [], lod, lens: src.lens ?? 'realm', survey,
        // (`prep`: the opening makes the far picture it flies to, out of sight: for where it ends, and more of it a frame)
        passing: this.cam.moving && !prep, resZoom: this.cam.moving && !prep ? Math.min(z, this.cam.view.zoom) : z, ...(prep ? { budget: prep === 'ask' ? 0 : DIVE.ground } : {}) });
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
    // (with no request out, or one refused: the surveyors' marks, a station mark on every free site of the wedge,
    // where a village may be placed; with a request out its own candidate sites are what is looked at)
    const waitSites = homeAt && !survey.candidates?.length ? wedgeSites(survey.faction, ringsOpen, recs, terrainOf) : null;
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
      realm = o => paintRealmLabels(o, recs, z, src.realmName ?? null, { extra: names, nations, territoryOf: src.territoryEnabled ? src.territoryOf : null, seenTile: (r, i) => survey.levelOf(r.p, r.q, i) === L3, controlSeen: r => Number.isInteger(r.keepTile) && survey.levelOf(r.p, r.q, r.keepTile) === L3, ...(limited ? { min: 3, home: box && !waiting ? { faction: looked, x: box.x, y: box.y } : null,
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
      if (apron) kind = 'pan';
      // (a frame painted whole: the land with the cloud sea and the ground marks on it, what stands, then what lives;
      // from the apron: the marks, what stands, what lives)
      if (!layered) {
        if (apron) marks(ctx); else this.art.paint(ctx, artTiles, { ...tileOpts, part: 'ground' });
        this.art.paint(ctx, artTiles, { ...tileOpts, part: 'props' });
        tileOpts.stand?.(ctx);
        this.art.paint(ctx, artTiles, { ...tileOpts, part: 'live' });
      }
      labels = (o, pass) => this.art.labels(o, { ...tileOpts, pass });
      pending += this.art.misses - missed;   // sprites still on their way
    }
    // the wedge of the viewer's stage (waited in, or looked at in the nation choice): over the land of every kind of
    // frame (a frame painted whole lays its ground after the far marks: the wedge was lost under it at the tile view)
    ctx.setTransform(...world);
    // (waited in: lit softly from the standard, not an outline on bare chart: UX brief §13.6)
    // (with candidate sites out, their painted land is what is looked at: the wedge keeps its quiet outline there)
    if (waiting) { const wb = homeAt && !survey.candidates?.length ? wedgeBox(survey.faction, ringsOpen) : null; paintWedge(ctx, survey.faction, ringsOpen, z, { wait: wb ? { x: homeAt.x, y: homeAt.y, r: Math.max(wb.width, wb.height / FLATTEN) * 0.5 } : null }); }
    if (waitSites?.length && lod !== 'world') paintSiteMarks(ctx, homeAt, waitSites, { zoom: z });
    if (looked !== null) paintWedge(ctx, looked, ringsOpen, z, { lit: true });
    // (a keep's place and holder are the season's public record: its fortress stands on unsurveyed land too, so the keep the
    // reach list sends the player to can be found on the board. With the art it stands between the props and the people,
    // `stand`; on plain tiles it is drawn here)
    if (lod === 'tile' && KB && !tileOpts) KB.top(ctx, F);
    if (KB?.live()) F.live = true;
    // over what stands on the land: thin outlines of the ground marks, the route, the standards
    this.topPass(ctx, F);
    // the ground marks move: a landing and a roll-out every frame, breathing a few times a second
    if (this.landing || this.promotion || F.rolling || F.shaking) this.dirty = true;
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
    // (the player's own character in the spot kept beside the standard: people/onboard.mjs paints it, upright as the standard is; UX brief §13.6)
    if (homeAt && lod !== 'world') paintWaitCharacter(ctx, waitSpotAt(homeAt, z), { faction: survey.faction, up });
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
      // (and of the spot beside it that is kept for the player's character: `waitSpot`)
      if (homeAt) { pass.block(homeAt.x, homeAt.y, standardBox(homeAt, z)); pass.block(homeAt.x, homeAt.y, waitSpotAt(homeAt, z).box); }
      if (sites) { paintCandidateLabels(o, sites, { zoom: z, line: waitSay, pass }); if (!calm) this.invalidateSoon(120); }
      if (homeAt) paintHomeTag(o, homeAt, { zoom: z, faction: survey.faction, line: waitSay, pass, keep: !sites, marks: !!waitSites?.length && lod !== 'world', say: src.wait?.wordsSaid ? null : leaderWords(survey.faction, src.wait?.state ?? null) });
      // (a countdown is read to the second: the words are drawn again a few times a second)
      if (waitSay) this.invalidateSoon(400);
      if (src.pins?.length) paintPins(o, src.pins, z);
      // (the page's objective chip may stand at the target itself: then the ring alone marks the tile)
      if (guide && !src.guideChip) paintGuide(o, guide, z, src.guideLabel?.(guide) ?? '', 'label', { rise: this.pileRise(guide, z), pass });
      if (guide) this.invalidateSoon();
      this.overPass(o, F);
    };
    return { wanted, drawn, kind, over, pending, rough };
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
    // (a tile that is being picked for an order has the board: its lit set is drawn in the reach's place)
    const P = tile ? this.pick : null;
    const A = P ? P.model : tile ? src.actions ?? null : null;
    const sel = tile && src.selected && Number.isInteger(src.selected.idx) ? src.selected : null;
    const selHex = sel ? tileHex(sel.p, sel.q, sel.idx) : null;
    const selOwn = !!sel && (villages.some(v => v.p === sel.p && v.q === sel.q && v.tile === sel.idx) || (!!A && A.mode === 'select'));
    // (the hexagon under the pointer: on land that exists, never on the cloud sea or the table beyond it)
    const hover = tile && this.hover && ringOf(this.hover.p, this.hover.pq) < (src.ringsOpen ?? 1) ? this.hover : null;
    const hoverLit = hover && A ? A.byHex.get(`${hover.q},${hover.r}`) ?? null : null;
    const fx = fxNow(), still = reducedMotion();
    // tiles that have just lit up (a host was selected): said once on the effects bus, where the engine's glow
    // runs over them as they roll out and a tick sounds (fx/stage.mjs); the lasting light is the map's own
    // the viewer's own records for the board (map/board.mjs, through the survey): hosts, marches, the watch
    const board = limited ? survey.board ?? null : null;
    this.boardNow = board;
    const B = this.boardFrame(src, survey, board, tile, fx, still);
    if (A?.mode === 'select' && A.t0 !== this.litT0) {
      this.litT0 = A.t0;
      // (reach is one shape now: the engine's glow is given the targets only, never a frame for every tile of the reach; `reach` says how many tiles it is)
      if (fx - A.t0 < 250) fxEmit('tiles:lit', { origin: A.hex, reach: A.tiles.length, tiles: A.tiles.filter(t => t.kind !== 'move').map(t => ({ q: t.hq, r: t.hr, kind: t.kind })), colours: Object.fromEntries(Object.entries(actionPalette(limited ? survey.faction : null)).map(([k, c]) => [k, c.rim])) });
    } else if (!A) this.litT0 = null;
    // the camera eases out until the reach's edge is in the picture (UX brief §11.7)
    if (A?.mode === 'select' || A?.mode === 'pick') this.frameReach(A); else this.reachFit = null;
    // a village of the viewer's whose tier has risen while the page was watched: its land floods one ring further
    this.promotionWatch(villages, fx, still, limited ? survey.faction : null);
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
    let ownedLands = null;
    const lands = () => {
      const worked = this.ownLands(survey, villages, lod, terrainOf);
      if (!src.territoryEnabled) return worked;
      return ownedLands ??= worked.map(land => {
        const tiles = land.tiles.filter(t => {
          const at = locate(t.q, t.r);
          return at.p === land.village.p && at.q === land.village.q && at.idx === land.village.tile
            || survey.levelOf(at.p, at.q, at.idx) === L3 && src.territoryOf?.(at.p, at.q)?.owners[at.idx] === survey.faction;
        });
        return { ...land, tiles, shape: landShape(tiles) };
      });
    };
    return { src, survey, lod, z, fx, still, limited, guide, villages, faction: limited ? survey.faction : null, palette: P ? pickPalette(P.model.kind) : actionPalette(limited ? survey.faction : null), A, selHex, selOwn, hover, hoverLit,
      board, B, lands,
      // (what ground a hex is: the prototype's fill is levelled by it — map/protoland.mjs paintLandTile)
      terrainAt: this.proto.on ? (this.terrainAtMemo?.of === terrainOf ? this.terrainAtMemo.at : (this.terrainAtMemo = { of: terrainOf, at: terrainLookup(terrainOf) }).at) : null };
  }

  /**
   * The spot the wait view keeps clear for the player's character (UX brief §13.2, §13.6): beside the nation's
   * standard, to the left of its pole, while the viewer has joined and has no village yet (a request out, refused,
   * or none). For whoever paints the character there, through the map's own hooks (the upright pass, `project`):
   *   world   {x, y}  where its feet stand (world px)
   *   tile    {p, q, idx}  the tile under them
   *   client  {x, y}  the same point on the page, as the picture on screen shows it (`map.project`)
   *   height  how tall the room kept is on screen (CSS px): four fifths of the standard's pole
   *   scale   how large that row of the tilted board is drawn (1 on the picture's middle row)
   *   faction the viewer's nation
   * or null when nobody waits (not joined, a village already, another page).
   */
  waitSpot() {
    const src = this.source?.() ?? {}, sv = src.survey ?? null;
    if (!sv || sv.showAll || !Number.isInteger(sv.faction) || !['joined', 'ticket', 'refugee'].includes(sv.stage)) return null;
    const at = this.wedgeHome(sv.faction, Math.max(1, src.ringsOpen ?? 1));
    if (!at) return null;
    const z = this.cam.drawn.zoom, s = waitSpotAt(at, z), k = this.standAt(s.x, s.y)?.k ?? 1;
    const [q, r] = inverseHex(s.x, s.y).split(',').map(Number), l = locate(q, r);
    return { faction: sv.faction, world: { x: s.x, y: s.y }, tile: { p: l.p, q: l.q, idx: l.idx }, client: this.project(s.x, s.y), height: s.box.h * z * k, scale: k };
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
    const fresh = !R || R.t0 !== A.t0 || R.id !== (A.actor?.id ?? A.kind);
    if (!fresh && ((R.n === A.tiles.length && R.cover === cover) || R.moves !== moves)) return;
    this.reachFit = { t0: A.t0, id: A.actor?.id ?? A.kind, n: A.tiles.length, cover, moves: fresh ? moves : R.moves, held: fresh ? false : R.held };
    const box = reachBox(A);
    if (!box || !(size.width > 0) || !(size.height > 0)) return;
    const f = freeBox(size, inset), v = this.cam.view, pad = REACH_PAD;
    // in the picture already (as it is seen, tilt and all)?
    const cx = size.width / 2 + f.x, cy = size.height / 2 + f.y;
    const inside = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]].every(([x, y]) => { const p = this.project(x, y, { logical: true, box: true }); return Math.abs(p.x - cx) <= f.width / 2 - pad && Math.abs(p.y - cy) <= f.height / 2 - pad; });
    if (inside) return;
    // (the near rows of a tilted board are drawn larger than the middle row: the reach's near edge must fit, as wide
    // as the tilt shows it there; REACH_FIT is the room left over. The board is seen from nearer since the fix pass:
    // a flat 0.9 no longer held the near corners)
    const plain = Math.min((f.width - 2 * pad) / (box.x1 - box.x0), (f.height - 2 * pad) / (box.y1 - box.y0));
    const g = this.geo(Math.min(v.zoom, plain), size), near = g.flat ? 1 : g.scaleAt(g.toStage(cx, cy + f.height / 2).y);
    const lean = g.flat ? 1 : Math.cos((g.deg * Math.PI) / 180);
    const fit = REACH_FIT * Math.min((f.width - 2 * pad) / ((box.x1 - box.x0) * near), (f.height - 2 * pad) / ((box.y1 - box.y0) * lean * near));
    // (on a narrow screen the tiles are pressed with a finger: the camera does not ease out past the zoom at which
    // neighbouring tiles stand a finger apart, about 44 px. A whole province of lit tiles in a phone's free part put
    // them 20 to 29 px apart; the rest of the lit land is a drag away)
    const floor = size.width < 760 ? Math.max(this.edges(size).tileIn * REACH_ZOOM_FLOOR, TOUCH_TILE_ZOOM) : this.edges(size).tileIn * REACH_ZOOM_FLOOR;
    const zoom = Math.min(v.zoom, Math.max(floor, fit));
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
    // (the prototype is on: the viewer's land is what its records say, the village's land and the banners' together)
    const mine = this.proto.on ? this.proto.mineLands(villages, fxNow()) : null;
    if (mine) return mine;
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

  /**
   * The tiers of the viewer's villages, frame to frame: a tier that rises (a promotion's queue item is done: the
   * Holding's record says the next tier) floods the land's new ring, once, and is said on the effects bus:
   * `promotion {p, q, tile, faction, tier, from, to (worked radius before and after), grew}`. Nothing for the tier
   * a page opens with. Reduced motion: the land is simply larger.
   */
  promotionWatch(villages, fx, still, faction) {
    const seen = this.tiersSeen ??= new Map();
    for (const v of villages) {
      const key = villageKey(v), tier = Math.max(0, Math.min(3, Number(v.tier ?? 0))), was = seen.get(key);
      seen.set(key, tier);
      if (was === undefined || !(tier > was)) continue;
      const from = WORKED_RADIUS[was] ?? 1, to = WORKED_RADIUS[tier] ?? from;
      if (!still && to > from) this.promotion = { key, t0: fx, from, to };
      fxEmit('promotion', { p: v.p, q: v.q, tile: v.tile, faction, tier, from, to, grew: to > from });
      this.invalidate();
    }
  }
  /** Play a promotion's flood again on a village of the viewer's (the demo switch; `from` the worked radius it had). */
  playPromotion(v = null, from = null) {
    const src = this.source?.() ?? {}, at = v ?? (src.survey?.villages ?? []).find(o => Number.isInteger(o.tile));
    if (!at) return false;
    const to = WORKED_RADIUS[Math.max(0, Math.min(3, Number(at.tier ?? 0)))] ?? 1;
    this.promotion = reducedMotion() ? null : { key: villageKey(at), t0: fxNow(), from: from ?? Math.max(0, to - 1), to };
    fxEmit('promotion', { p: at.p, q: at.q, tile: at.tile, faction: src.viewerFaction ?? null, tier: Number(at.tier ?? 0), from: from ?? to - 1, to, grew: true, replay: true });
    this.tick();
    return true;
  }
  /** Where the sheaves of the viewer's village on tile (p, q, tile) stand (world px), for what flies from them at a harvest; none when its fields are bare or it is not in the picture. */
  fieldPoints(p, q, tile) { const f = this.art?.fields; return f && f.key === `${p},${q},${tile}` ? f.spots : []; }

  /** The landing's state for a land while it plays (map/ownland.mjs landingAt), else null. */
  floodOf(land, fx) {
    // a promotion: the land it had is there, the new ring floods (map/villagework.mjs promotionAt)
    const pr = this.promotion;
    // (under the prototype a village's land does not grow at a promotion: nothing floods)
    if (pr && pr.key === land.key && !this.landing && !land.proto) {
      const f = promotionAt(fx - pr.t0, pr.from, land.shape.maxD);
      if (f.done) { if (!this.keepLanding) this.promotion = null; return null; }
      return f;
    }
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
    const kept = phase === 'still' ? (this.kept = { lands: new Set(), lit: null, watch: new Set(), keeps: null }) : phase === 'live' ? this.kept ?? { lands: new Set(), lit: null, watch: new Set(), keeps: null } : null;
    // the banner rule's prototype (map/protoboard.mjs), under the viewer's own land: the commons, others' land, where a banner can rise
    const PB = this.proto.on ? this.proto : null, pkey = PB ? PB.staticKey(fx, F) : null;
    if (PB) {
      if (phase === 'still') { PB.groundStill(ctx, F); kept.proto = pkey; }
      else if (phase === 'live') { if (kept.proto !== pkey) { PB.groundStill(ctx, F); F.rebake = true; } }
      else PB.groundStill(ctx, F);
    } else if (phase === 'live' && kept.proto) F.rebake = true;
    // a conquest season: whose land each province is (map/keeps.mjs), under everything else of the ground. The provinces
    // at rest are kept with the still ground; a capture's flood and the rings of the keeps in reach are painted each frame
    const KB = F.KB ?? null;
    if (KB) {
      const kkey = KB.groundKey(fx);
      if (phase === 'still') { KB.ground(ctx, F, 'rest'); kept.keeps = kkey; }
      else if (phase === 'live') { if (kept.keeps !== kkey) { KB.ground(ctx, F, 'rest'); F.rebake = true; } }
      else KB.ground(ctx, F, 'rest');
    } else if (phase === 'live' && kept.keeps) F.rebake = true;
    // (beside banner land a watch is told by its dashed rim alone, and only where it runs outside the land the gold line holds)
    const outside = PB && F.seen ? PB.outsideMine(F.seen) : null;
    const watched = draw => { if (!outside) return draw(); ctx.save(); ctx.clip(outside, 'evenodd'); try { draw(); } finally { ctx.restore(); } };
    // the land the viewer's standing hosts watch (UX design 14.4): under the village's own land and the lit tiles
    // (the prototype is on: a watch is a thin cream rim with no wash, and the host whose own claim runs shows that
    // claim's land instead — three or four hosts by a village laid a honeycomb of rims in the nation's colour, and a
    // watch washed in that colour read as land already held)
    const quiet = PB ? PROTO_LOOK.quiet : null, claiming = PB ? new Set(PB.model.rising.filter(r => r.mine).map(r => `${r.at.q},${r.at.r}`)) : null;
    const W = (F.B?.watch ?? []).filter(w => !claiming?.has(`${w.q},${w.r}`)), washed = new Set();
    for (const w of W) {
      // (a tile several hosts watch is washed once: the later watches lay their colour only where no earlier one has)
      const covered = washed.size ? new Set(washed) : null;
      for (const t of w.tiles ?? []) washed.add(`${t.q},${t.r}`);
      const age = F.still ? null : this.watchAge(w, fx), opts = { zoom: z, faction: F.faction, age, still, covered, quiet };
      if (phase === 'still') { if (age === null) { watched(() => paintWatch(ctx, w, opts)); kept.watch.add(w.key); } }
      else if (phase === 'live') { if (!kept.watch.has(w.key)) { watched(() => paintWatch(ctx, w, opts)); if (age === null) F.rebake = true; else F.rolling = true; } }
      else { watched(() => paintWatch(ctx, w, opts)); if (age !== null) F.rolling = true; }
    }
    if (phase === 'live' && [...(kept.watch ?? [])].some(k => !W.some(w => w.key === k))) F.rebake = true;
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
      const palette = F.palette, wash = A.mode === 'pick' ? PICK_WASH : 0;
      if (phase === 'still') { if (out) { paintActionGround(ctx, A, { zoom: z, dim, base: true, palette, wash }); kept.lit = A; } }
      else if (phase === 'live' && kept.lit === A) { if (!still) paintActionPulse(ctx, A, { zoom: z, now: fx, dim, palette }); }
      else { F.rolling = paintActionGround(ctx, A, { zoom: z, now: fx, still, dim, palette, wash }) || F.rolling; if (phase === 'live' && (out || kept.lit)) F.rebake = true; }
      F.live = true;
    } else if (phase === 'live' && kept.lit) F.rebake = true;
    if (phase === 'still') return;
    // what moves of the keeps: a capture's flood over its province, the breathing ring of a keep in reach
    if (KB) KB.ground(ctx, F, 'moving');
    // what moves of the prototype: a raise's flood, a trail's ink, a threat's ring, the flower of a place being chosen
    if (PB) PB.groundLive(ctx, F);
    // (the page's own chip may stand at the target and point at it: then no ring is laid around the tile)
    if (F.guide && !F.src.guideChip && this.pileRise(F.guide, z) === null) { paintGuide(ctx, F.guide, z, '', 'ring'); F.live = true; }
    if (F.hover) paintHoverGround(ctx, F.hover, { zoom: z, kind: F.hoverLit?.kind ?? null, palette: F.palette });
    if (F.selHex) { paintSelectionGround(ctx, F.selHex, { zoom: z, own: F.selOwn, now: fx, still }); F.live = true; }
    // the host that is ringed (`selectHost`, or the one of the selected tile that acts): a bright ring at its figure's feet
    const ringed = this.hostSel ?? (F.selHex ? this.hostTap ?? null : null) ?? (F.A?.mode === 'select' ? F.A.actor?.id ?? null : null);
    if (ringed !== null && F.lod === 'tile') {
      const tok = (this.art?.tokens ?? []).find(t => !t.character && (t.hosts ?? []).some(id => String(id) === String(ringed)));
      if (tok) { paintHostRing(ctx, tok.x, tok.y, (tok.size ?? RADIUS * 0.66), { zoom: z, own: !!tok.own, now: fx, still }); F.live = true; }
    }
  }

  // ------------------------------------------------------------------ the viewer's hosts on the board (UX design 14.3, 14.4)
  /**
   * What this frame draws of the viewer's own records (map/board.mjs through the survey), made once per survey:
   * `{watch: [{key, q, r, radius, tiles}], marches (sealed, known to this browser, not yet open), forming (hosts
   * that form up next turn), explores}`. A change the records show is said once on the effects bus:
   *   `survey:gain`    `{n, q, r, seq, faction, kind, claims}`: the survey grew by n tiles round that hex (「+N マス測量」)
   *   `board:arrival`  `{host, p, q, tile, faction, lead}`: a march of the viewer's has arrived and its seal is
   *                    open (or its host now stands in the roster there); the camera eases there when the
   *                    player is not busy
   *   `board:formed`   `{host, p, q, tile, unit, faction}`: a host that was forming up now stands
   *   `board:left`     `{host, p, q, tile, faction, lead}`: a standing host of the viewer's is on a sealed march now
   * Nothing is said for what a page finds when it opens: only for what changes while it is watched.
   */
  boardFrame(src, survey, board, tile, fx, still) {
    if (!board) { this.boardMemo = null; return null; }
    let M = this.boardMemo;
    if (!M || M.rev !== survey.rev) {
      const rows = [...board.hosts, ...(board.arrivals ?? []).map(a => ({ id: a.id, p: a.p, q: a.q, tile: a.tile, unit: a.unit, state: 1, home: false }))];
      const watch = watchOf(rows, { nowBell: board.nowBell, open: (q, r) => survey.levelAt(q, r) > 0 }).map(w => ({ ...w, key: `${w.q},${w.r},${w.radius}` }));
      M = this.boardMemo = { rev: survey.rev, watch, marches: (board.marches ?? []).filter(m => m.known && !m.open && m.hexes.length > 1), forming: board.hosts.filter(h => h.forming), explores: board.explores ?? [], byId: new Map(board.hosts.map(h => [h.id, h])) };
      this.boardChanged(src, survey, board, M, fx);
    }
    return tile ? M : { ...M, watch: [] };
  }
  /** The records changed: say once what happened (see `boardFrame`). */
  boardChanged(src, survey, board, M, fx) {
    const faction = survey.faction ?? null, first = !this.boardSeen;
    const seen = this.boardSeen ??= { hosts: new Map(), marches: new Map(), gain: survey.gain?.seq ?? 0, watch: new Map() };
    // the survey grew
    const g = survey.gain;
    // (`kind`: the anchor that caused it; `claims`: the banner rule's prototype is on. Sealing a march surveys its
    // destination and the six tiles round it, and they come out of the chart in colour: with land that can be owned
    // on the board, the chip says once that this is a survey and not land)
    if (g && g.seq !== seen.gain) { seen.gain = g.seq; if (!first) fxEmit('survey:gain', { n: g.n, q: g.q, r: g.r, seq: g.seq, faction, kind: g.kind ?? null, claims: this.proto.on }); }
    const told = new Set();
    const arrive = (host, at) => {
      if (told.has(host)) return;
      told.add(host);
      fxEmit('board:arrival', { host, p: at.p, q: at.q, tile: at.tile, faction, lead: board.lead === host });
      this.arrivalWant = { p: at.p, q: at.q, tile: at.tile, at: fx };
    };
    for (const m of board.marches ?? []) {
      const was = seen.marches.get(m.host);
      if (was && !was.open && m.open && m.dest) arrive(m.host, m.dest);
      seen.marches.set(m.host, { open: m.open, arrived: m.arrived });
    }
    for (const h of board.hosts) {
      const was = seen.hosts.get(h.id);
      if (was) {
        if (was.sealed && h.standing && !h.home && !seen.marches.get(h.id)?.open) arrive(h.id, h);
        if (was.forming && h.standing) fxEmit('board:formed', { host: h.id, p: h.p, q: h.q, tile: h.tile, unit: h.unit, faction });
        if (was.standing && h.sealed) fxEmit('board:left', { host: h.id, p: h.p, q: h.q, tile: h.tile, faction, lead: board.lead === h.id });
      }
      seen.hosts.set(h.id, { sealed: h.sealed, standing: h.standing, forming: h.forming });
    }
    for (const id of [...seen.hosts.keys()]) if (!M.byId.has(id)) seen.hosts.delete(id);
    for (const id of [...seen.marches.keys()]) if (!(board.marches ?? []).some(m => m.host === id)) seen.marches.delete(id);
    // a watch that is new draws on from its host; the ones a page opens with are simply there
    for (const w of M.watch) if (!seen.watch.has(w.key)) seen.watch.set(w.key, first ? -Infinity : fx);
    for (const k of [...seen.watch.keys()]) if (!M.watch.some(w => w.key === k)) seen.watch.delete(k);
  }
  /** How long a watch has stood where it is (ms), while it still draws on; null once it is simply there. */
  watchAge(w, fx) { const t0 = this.boardSeen?.watch.get(w.key); const age = t0 === undefined ? null : fx - t0; return age !== null && age < WATCH_ON_MS ? Math.max(0, age) : null; }
  /** Whether the player is doing something the camera must not be taken from: a finger on the map, an order being placed, a set piece, a recent move of their own. */
  busy(now = clock()) {
    return !!this.drag || this.pointers.size > 0 || !!this.pick || this.piece || !!this.source?.()?.route || now - (this.touchedAt ?? -Infinity) < BUSY_MS;
  }
  /** An arrival the records showed (`boardChanged`): the camera eases until its tile is in the picture, when the player is not busy (called by the frame loop, never inside a draw). */
  arrivalEase(now = clock()) {
    const a = this.arrivalWant;
    if (!a) return;
    this.arrivalWant = null;
    // (a moment the player's own press brought: only a finger on the map, a pick, a set piece or an order being placed keeps the camera)
    if (a.moment) { if (!!this.drag || this.pointers.size > 0 || !!this.pick || this.piece || !!this.source?.()?.route || this.lod !== 'tile') return; }
    else if (this.busy(now) || this.lod !== 'tile') return;
    const pt = placePoint(a), size = this.size(), f = freeBox(size, this.inset());
    const p = this.project(pt.x, pt.y, { logical: true, box: true }), cx = size.width / 2 + f.x, cy = size.height / 2 + f.y;
    // (already well inside the part of the picture nothing covers: the camera stays. A piece of the HUD may still
    // stand over that place — on a phone the notices lie across the top of the map, and the host that had just
    // arrived stood under the very notice that told of it: found in the play-through of wave 5 —, so the tile and
    // the figure standing on it are also asked of the page's own rectangles)
    const r = this.rect(), at = { x: p.x + r.left, y: p.y + r.top }, tall = 64;
    const under = (this.nogoFed ?? []).some(b => at.x >= b.x - 8 && at.x <= b.x + b.w + 8 && at.y >= b.y - 8 && at.y - tall <= b.y + b.h + 8);
    if (!under && Math.abs(p.x - cx) <= f.width * (a.moment ? 0.26 : 0.32) && Math.abs(p.y - cy) <= f.height * (a.moment ? 0.2 : 0.3)) return;
    if (a.moment) { this.flyTo({ p: a.p, q: a.q, tile: a.tile }, reducedMotion() ? 0 : 250, { auto: true }); return; }
    this.flyTo({ p: a.p, q: a.q, tile: a.tile }, null, { auto: true });
  }
  /** A loss of the banner prototype shakes the board a little (map/protoboard.mjs shakeAt): a custom property on the map's own elements, zero when nothing shakes. */
  protoShake(fx = fxNow()) {
    const px = this.proto.on && !reducedMotion() ? this.proto.shakeAt(fx) : 0, v = px ? `${px.toFixed(1)}px` : '';
    if (v === (this.shakeSet ?? '')) return;
    this.shakeSet = v;
    for (const el of [this.canvas, this.stage?.parentElement ?? null]) { try { if (v) el?.style?.setProperty('translate', `${v} 0`); else el?.style?.removeProperty('translate'); } catch { /* an element that is gone */ } }
  }

  /** What stands on the board of the viewer's own records, over the land's props: the sealed marches with their markers, the surveyors' flags. */
  boardTop(ctx, F) {
    const B = F.B;
    if (!B) return;
    const { z, fx, still, survey } = F;
    B.markers = [];
    const now = survey.chainNow?.() ?? 0;
    // (one place at a time: while the character still walks out with its column, its face is not on the ribbon yet)
    const leaving = (this.art?.tokens ?? []).some(t => t.character?.own && t.character.leave);
    for (const m of B.marches) {
      const share = marchShare(m, { genesisTs: survey.genesisTs ?? 0, now });
      const at = paintSealedMarch(ctx, m.hexes, { zoom: z, faction: F.faction, share });
      if (!at) continue;
      const lead = F.board.lead === m.host, d = MARKER_PX / z;
      if (lead && leaving) { F.live = true; continue; }
      // the column walks the road (map/marcher.mjs): the player's character at the head of a short file of the host's own
      // figures when this is the host it leads, the file alone otherwise; each stands upright where the road has it
      const unit = B.byId?.get(m.host)?.unit ?? 0, walking = !m.arrived;
      // (a conquest season's board: any other season keeps the marker it had)
      const spots = F.KB ? marcherSpots(at.path, at.k, { zoom: z, lead }).sort((a, b) => a.y - b.y) : [];
      let drawn = 0;
      for (const sp of spots) standing(ctx, F.up?.(sp.x, sp.y) ?? null, sp.x, sp.y, () => { if (paintMarcher(ctx, sp, { zoom: z, faction: F.faction, unit, now: fx, still, walking })) drawn += sp.kind === 'lead' || !lead ? 1 : 0; });
      // (its art is not here yet: the marker it had, the character's hexagon face on a short pin)
      if (!drawn) standing(ctx, F.up?.(at.x, at.y) ?? null, at.x, at.y, () => {
        ctx.save();
        ctx.fillStyle = 'rgba(8,14,12,.4)'; ctx.beginPath(); ctx.ellipse?.(at.x, at.y, d * 0.3, d * 0.11, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(14,22,20,.9)'; ctx.lineWidth = 3 / z; ctx.beginPath(); ctx.moveTo(at.x, at.y); ctx.lineTo(at.x, at.y - d * 0.36); ctx.stroke();
        ctx.strokeStyle = YOURS.gold; ctx.lineWidth = 1.4 / z; ctx.stroke();
        ctx.restore();
        if (!(lead && paintPlayerFace(ctx, F.faction, at.x - d / 2, at.y - d * 1.3, d, { own: true }))) paintMarkerDisc(ctx, at.x, at.y - d * 0.82, d * 0.92, { faction: F.faction });
      });
      B.markers.push({ m, at, lead, top: drawn ? marcherTop(z, lead) : d * 1.32 });
      F.live = true;

    }
    // the lead is on a sealed march whose order this browser does not hold: no ribbon may be drawn. The character
    // itself stands by the village it left from (people/onboard.mjs characterTokens); under its feet the board says
    // that its host is on the march and when it arrives (that much is public)
    const pl = F.board.place;
    if (pl?.at === 'away' && F.board.village) {
      const h = tileHex(F.board.village.p, F.board.village.q, F.board.village.tile);
      if (h) {
        const c = project(h.q, h.r), at = { x: c.x + AWAY_AT.x, y: c.y + AWAY_AT.y };
        const m = (F.board.marches ?? []).find(x => x.host === pl.host);
        B.away = { at, arriveBell: m?.arriveBell ?? null, hex: h };
      }
    } else B.away = null;
    for (const e of B.explores) {
      const h = tileHex(e.p, e.q, e.tile);
      if (!h) continue;
      const c = project(h.q, h.r), x = c.x + RADIUS * 0.18, y = c.y + RADIUS * 0.12;
      standing(ctx, F.up?.(x, y) ?? null, x, y, () => paintSurveyFlag(ctx, x, y, RADIUS * 0.7, { now: fx, still }));
      F.live = true;
    }
  }

  /** The words of the board's own records, upright over the board: a forming host, a sealed march's marker, an exploration under way, what a watch is. */
  boardOver(ctx, F, hid) {
    const B = F.B;
    if (!B) return;
    const { z, fx, still } = F, pass = F.pass ?? null, col = FACTION_COLORS[F.faction] ?? YOURS.gold;
    for (const h of B.forming) {
      const hex = tileHex(h.p, h.q, h.tile);
      // (on the viewer's own village while it is selected the acting host's tag stands there: the ghost's pill says it)
      if (!hex || hid(hex) || (h.home && F.selHex && F.selHex.q === hex.q && F.selHex.r === hex.r)) continue;
      const c = project(hex.q, hex.r);
      paintBellTag(ctx, c.x, c.y + RADIUS * FLATTEN * (h.home ? 1.5 : 0.92), formingText(), { zoom: z, place: 'below', gap: 3, accent: col, anchor: c, pass });
    }
    for (const k of B.markers ?? []) {
      // (the marker stands `top` world px over the ribbon on a flat board; the tag hangs under it, clear of the face)
      paintBellTag(ctx, k.at.x, k.at.y - k.top * (F.up ? 1.1 : 1), k.m.arrived ? awaitKeyText() : marchTagText(k.m.arriveBell), { zoom: z, place: 'above', gap: 5, accent: col, anchor: k.at, pass, size: 12, hud: true });
    }
    // (under the leader's feet and clear of the village's bottom row: centred on the leader, its left half lay over the houses;
    // not while the village itself is selected: its card says it, and the lens's own words stand there)
    const villageSel = !!(B.away && F.selHex && B.away.hex && F.selHex.q === B.away.hex.q && F.selHex.r === B.away.hex.r);
    if (B.away && !(F.selHex && F.A) && !villageSel) paintBellTag(ctx, B.away.at.x, B.away.at.y + RADIUS * 0.6, awayText(B.away.arriveBell), { zoom: z, place: 'below', gap: 4, accent: col, anchor: B.away.at, pass, size: 12 });
    if (B.explores.length) {
      const e = B.explores[0], hex = tileHex(e.p, e.q, e.tile);
      // (over the flag's top: the flag itself stays in sight)
      if (hex && !hid(hex)) { const c = project(hex.q, hex.r); paintBellTag(ctx, c.x + RADIUS * 0.18, c.y - RADIUS * 0.72 * (F.up ? 1.15 : 1), exploreFlagText(), { zoom: z, place: 'above', gap: 4, accent: '#7fc4e8', anchor: c, pass, size: 12 }); }
    }
    // what the dashed rim is: said beside it while it draws on and for a few seconds after, and whenever the pointer is on watched land
    for (const w of B.watch) {
      const t0 = this.boardSeen?.watch.get(w.key) ?? -Infinity, age = fx - t0;
      const under = F.hover && w.tiles.some(t => t.q === F.hover.q && t.r === F.hover.r) && !F.A;
      if (!under && !(age < WATCH_WORDS_MS) && !this.watchWords) continue;
      const top = watchTop(w);
      if (!top) continue;
      const a = under || still || this.watchWords ? 1 : Math.max(0, Math.min(1, (WATCH_WORDS_MS - age) / 500));
      paintTag(ctx, top.x, top.y, LAND_WORDS.watch(), { zoom: z, tone: 'plain', place: 'below', gap: 5, size: 12, alpha: a, anchor: top, pass });
      if (!under && !still && !this.watchWords) this.invalidateSoon(Math.max(40, Math.min(500, WATCH_WORDS_MS - age)));
    }
  }

  /**
   * What the land of tile (p, q, idx) is to the viewer, for a tip or the inspector (UX design 14.1): 'village' (the
   * village's worked land), 'held' (a host of the viewer's stands on it), 'watch' (a standing host of the viewer's
   * watches it), 'surveyed' (seen before, or in sight of a village), 'chart' (never seen), or null (no viewer).
   * `landWord(kind)` gives its name in the page's language.
   */
  landKindAt(p, q, idx) {
    const src = this.source?.() ?? {}, sv = src.survey;
    const h = Number.isInteger(idx) ? tileHex(p, q, idx) : null;
    if (!sv || sv.showAll || !h) return null;
    const b = sv.board;
    if (b?.hosts?.some(x => x.standing && !x.home && x.p === p && x.q === q && x.tile === idx) || b?.arrivals?.some(x => x.p === p && x.q === q && x.tile === idx)) return 'held';
    const lands = this.ownLands(sv, (sv.villages ?? []).filter(v => Number.isInteger(v.tile)), this.lod, src.terrainOf ?? this.terrainOf);
    if (lands.some(l => l.tiles.some(t => t.q === h.q && t.r === h.r))) return 'village';
    if (this.boardMemo?.rev === sv.rev && this.boardMemo.watch.some(w => w.tiles.some(t => t.q === h.q && t.r === h.r))) return 'watch';
    return sv.levelAt(h.q, h.r) >= L2 ? 'surveyed' : 'chart';
  }
  landWord(kind) { return LAND_WORDS[kind]?.() ?? ''; }

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
      // the village's lens (docs/design/uplift/06-MAP-REST): the viewer's village selected, its own land stays in colour
      // and everything else steps back, greyed, so what the village works is read at a glance
      else if (F.seen && src.selected && Number.isInteger(src.selected.idx)) {
        const s = src.selected, land = F.lands().find(l => l.village?.p === s.p && l.village?.q === s.q && l.village?.tile === s.idx);
        if (land?.shape?.loops?.length) paintLandLens(ctx, land.shape.loops, F.seen);
        // S1: the hills and mountains that give the village its ore, each with what it adds (the rules' own numbers)
        const ore = land && s1On() ? this.art?.oreAround?.(s.p, s.q, s.idx) : null;
        if (ore) {
          for (const o of ore.tiles) paintTag(ctx, o.x, o.y, L`鉱石 +${fmtNum(o.ore)}`, { zoom: z, place: 'above', gap: 2, size: 11, anchor: o });
          const h = tileHex(s.p, s.q, s.idx), v = project(h.q, h.r);
          // (a village with no hill or mountain near it makes only the base ore: said, since that is why it trades for ore)
          // (hills and mountains in sight but across the province's edge do not count: then it says so, in place of the
          // longer sentence, so the land in sight does not seem to contradict it)
          const say = !ore.tiles.length ? (ore.across ? L`地形の鉱石なし（となりの州の丘と山は数えません）` : L`同じ州の 2 マス以内に丘も山もありません（地形の鉱石なし）`)
            : ore.capped ? L`まわりの丘と山から 鉱石 +${fmtNum(ore.total)}/時（上限）` : L`まわりの丘と山から 鉱石 +${fmtNum(ore.total)}/時`;
          paintTag(ctx, v.x, v.y + RADIUS * 0.9, say, { zoom: z, place: 'below', size: 11.5, anchor: v });
        }
      }
      // (the gold line of the viewer's land stays in sight through the reach and its dim: drawn again, and stronger then)
      for (const land of F.lands()) { const flood = this.floodOf(land, fx); paintOwnOutline(ctx, land, { zoom: z, shown: flood ? flood.border : 1, strong: !!F.A }); }
      if (F.A) paintActionTop(ctx, F.A, { zoom: z, now: fx, still, dim: F.A.dest ? 0.5 : 1, palette: F.palette });
      { const outside = this.proto.on && F.seen ? this.proto.outsideMine(F.seen) : null;
        for (const w of F.B?.watch ?? []) { if (outside) { ctx.save(); ctx.clip(outside, 'evenodd'); } paintWatchTop(ctx, w, { zoom: z, faction: F.faction, quiet: this.proto.on ? PROTO_LOOK.quiet : null }); if (outside) ctx.restore(); } }
      // (the keeps a host in hand can reach stay lit through that dim: map/keeps.mjs)
      if (F.A && F.KB) F.KB.lightTop(ctx, F);
      this.boardTop(ctx, F);
      // S1: vaults, structures and caravans on the road (map/s1marks.mjs)
      F.s1Tags = src.s1 ? paintS1Marks(ctx, src.s1, { zoom: z, faction: F.faction, stand: (x, y, fn) => standing(ctx, F.up?.(x, y) ?? null, x, y, fn) }) : null;
      // the banners on their poles (the prototype)
      if (this.proto.on) this.proto.top(ctx, F);
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
    // (the prototype from afar: banner land at the middle distance, each province's gauge on the world chart)
    if (this.proto.on && F.limited) { this.proto.far(ctx, F); F.live = true; }
    // the keeps from afar (a conquest season): a small fortress at the middle distance, a mark on the world chart, a capture's flood
    if (F.KB) F.KB.far(ctx, F);
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
    this.boardOver(ctx, F, hid);
    // S1: when each caravan on the road arrives
    for (const t of F.s1Tags ?? []) {
      const [q, r] = inverseHex(t.x, t.y).split(',').map(Number);
      if (hid({ q, r })) continue;
      paintBellTag(ctx, t.x, t.y - RADIUS * 0.5, caravanTagText(t.c.arriveBell, t.c.raided), { zoom: z, place: 'above', gap: 3, accent: FACTION_COLORS[t.c.faction] ?? undefined, anchor: t, pass, size: 11 });
    }
    // (`piece`: a set piece — a battle — has the stage: the prototype's line of what a tile's land is steps back with every other word)
    F.piece = !!this.piece;
    if (this.proto.on) this.proto.over(ctx, F, hid);
    // the keeps' words and dials (a conquest season)
    if (F.KB) F.KB.over(ctx, F, hid);
    // a pick's own words: what the tap will do, on a bell-metal tag over the lit set
    if (A?.mode === 'pick' && A.label) {
      // (a small set: over its top edge; a set as wide as a province: under the tile it spreads from, where the player is looking)
      const o = A.origin ? tileHex(A.origin.p, A.origin.q, A.origin.tile) : null, wide = A.tiles.length > 19 && !!o;
      const top = wide ? (c => ({ x: c.x, y: c.y + RADIUS * FLATTEN * 1.5 }))(project(o.q, o.r)) : reachTop(A);
      if (top) paintBellTag(ctx, top.x, top.y, A.label, { zoom: z, place: wide ? 'below' : 'above', gap: wide ? 4 : 9, accent: `rgb(${F.palette.move.rim.join(',')})`, anchor: top, pass, size: 14 });
    }
    // the host that acts, under the selected tile (tap the tile again for the next one)
    if (A && A.mode === 'select' && A.hex && !hid(A.hex) && !(this.proto.on && this.proto.hush(F.fx, A.hex))) {
      const c = project(A.hex.q, A.hex.r), y = c.y + RADIUS * FLATTEN * 1.04;
      const box = paintTag(ctx, c.x, y, `${actorText(A.actor)}${A.actors.length > 1 ? ` \u00b7 ${A.index + 1}/${A.actors.length}` : ''}`, { zoom: z, tone: 'you', place: 'below', gap: 3, anchor: c, pass });
      const why = blockText(A.actor);
      if (why && box) paintTag(ctx, c.x, box.y + box.h, why, { zoom: z, tone: 'warn', place: 'below', gap: 3, size: 12, anchor: c, pass });
      // what the pale line is, said beside it for the first seconds of a selection: the near reach, and that a march may go further
      const age = F.fx - A.t0, near = reachSteps(A.actor.stamina), top = A.actor.march?.ok && reachSteps(A.actor.stamina, 99) > near ? reachTop(A) : null;
      if (top && (F.still || age < REACH_WORDS_MS)) paintTag(ctx, top.x, top.y, reachText(near), { zoom: z, tone: 'reach', place: 'above', gap: 7, size: 12, alpha: F.still ? 1 : Math.max(0, Math.min(1, (REACH_WORDS_MS - age) / 500)), anchor: top, pass, spare: true });
      if (top && !F.still && age < REACH_WORDS_MS) this.invalidateSoon(Math.max(40, Math.min(500, REACH_WORDS_MS - age)));
    }
    // when the march would arrive: on the composed route, or on the route under the pointer
    const hr = this.hoverRoute(F);
    // (under the destination: over it stands a village's own name, and the tag lay on it: the design review of 2026-10-24)
    const tagAt = (hex, bell, tone) => { const d = project(hex.q, hex.r); paintTag(ctx, d.x, d.y + RADIUS * FLATTEN * 0.86, arrivalText(bell), { zoom: z, tone, place: 'below', gap: 4, anchor: d, pass }); };
    if (hr && Number.isInteger(hr.arriveBell)) tagAt(hr.hexes[hr.hexes.length - 1], hr.arriveBell, 'plain');
    else if (src.route?.dest && Number.isInteger(src.route.arriveBell)) tagAt(src.route.dest, src.route.arriveBell, 'you');
    const note = this.noteOf(F);
    if (note?.hex) {
      const d = project(note.hex.q, note.hex.r), fade = Math.max(0, Math.min(1, (NOTE_MS - note.age) / 400));
      const shake = F.still ? 0 : Math.sin(note.age / 28) * 5 * Math.exp(-note.age / 150);
      paintTag(ctx, d.x, d.y - RADIUS * FLATTEN * 0.82, note.text, { zoom: z, tone: 'refuse', place: 'above', gap: 4, shake, alpha: fade, anchor: d, pass });
    }
  }

  /**
   * The viewer's own land under the banner rule's prototype as boxes on the canvas (CSS px), one a tile that is in the
   * picture: the pointer home keeps off them (map/homepointer.mjs clearOfLand). [] with the prototype off.
   */
  ownLandBoxes(size = this.size()) {
    const tiles = this.proto.on ? this.proto.model?.mine?.tiles ?? [] : [];
    if (!tiles.length) return [];
    const z = this.cam.drawn.zoom, hw = RADIUS * z * Math.sqrt(3) / 2, hh = RADIUS * z * FLATTEN, out = [];
    for (const t of tiles) {
      const c = project(t.q, t.r), p = this.project(c.x, c.y, { box: true });
      if (p.x + hw < 0 || p.x - hw > size.width || p.y + hh < 0 || p.y - hh > size.height) continue;
      out.push({ x: p.x - hw, y: p.y - hh, w: 2 * hw, h: 2 * hh });
    }
    // (and the count of a threat on that land, with its line of words above it)
    for (const a of this.proto.alarmSpots(z, this.tiltDeg(z, size) ? 1.12 : 1)) {
      const p = this.project(a.x, a.y, { box: true });
      if (p.x < -90 || p.x > size.width + 90 || p.y < -60 || p.y > size.height + 60) continue;
      out.push({ x: p.x - 90, y: p.y - 58, w: 180, h: 84 });
    }
    return out;
  }
  /** The pointer home (map/homepointer.mjs): a gold tab on the map's edge while the viewer's active village is out of the picture; put away while a set piece plays. */
  updatePointer(src, view, size, inset) {
    if (!this.pointer) return;
    const own = src ? (src.own ?? []).filter(o => Number.isInteger(o.p) && Number.isInteger(o.q)) : [];
    // (and for the two seconds of a moment of the banner prototype: on a phone its pill lay on the land that was flooding)
    const at = own.length && !src.open?.title && !this.piece && !(this.proto.on && this.proto.hush(fxNow())) ? own[Math.min(own.length - 1, Math.max(0, src.open?.active ?? 0))] : null;
    this.pointer.update(at ? edgePointer(view, size, placePoint(at), { inset, geo: this.geo(view.zoom, size) }) : null, { name: at?.name ?? '', avoid: at ? this.nogoBoxes() : [], land: at ? this.ownLandBoxes(size) : [] });
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
      // the cloud sea's still part lies on the ground and is kept with it; while a piece of it waits its turn the layer is not final
      L.ground.g.setTransform(...world);
      const sea = opts.seaPass?.(L.ground.g, 'still');
      L.ground.g.setTransform(...world);
      opts.ground?.(L.ground.g, 'still');   // the ground marks that do not move are kept with the ground
      const g = L.props.g;
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.setTransform(...world);
      this.art.paint(g, tiles, { ...opts, part: 'props' });
      // (nor while a province's ground waits its turn, another bitmap of it standing in: the next frame makes it. A
      // resting picture was left with its stand-ins until the layers' own age had passed, two seconds a turn)
      const waiting = (this.art.waiting ?? 0) > 0;
      L.key = sea?.pending || waiting ? null : key; L.at = now;
      if (waiting) this.dirty = true;
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy'; ctx.drawImage(L.ground.cv, 0, 0); ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    ctx.setTransform(...world);
    // over the land, under what stands on it: the sea's drifting light, what moves of the ground marks, then the effects engine's ground pass
    opts.seaPass?.(ctx, 'drift');
    ctx.setTransform(...world);
    if (opts.ground) { opts.ground(ctx, 'live'); this.between?.(ctx, { zoom: opts.zoom, now }); }
    else opts.between?.(ctx);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(L.props.cv, 0, 0); ctx.restore();
    ctx.setTransform(...world);
    // what stands on the land of the board's own (a keep's fortress): over the props, under the people
    opts.stand?.(ctx);
    ctx.setTransform(...world);
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
