// The opening view (UX brief §4): the one place that decides where the map
// opens. It depends on who is looking:
//
//   a village (provisional or final)   the active village's tile at the hero zoom
//   a ticket with candidate sites      every candidate site, in the part nothing covers
//   joined, no land yet                the nation's home wedge
//   not joined (the nation choice)     close on the bell at the Concord; a nation that is looked at:
//                                      its home wedge with the bell at its point
//   watching, practising               the whole opened world, as before
//
// The page says who is looking with `openHint(FS)` in the map's source; the
// map asks `openingPlan` every frame until a person moves the camera. A plan
// is null while the first answer about the viewer is still on its way (the
// holdings arrive after the first frame): the map waits instead of showing
// the whole world first. Higher priorities live outside this file: a link
// with ?at= and a battle the page focuses both place the camera themselves,
// which counts as moved.
import { project } from '../../map.mjs';
import { tileHex } from '../fgeo.mjs';
import { provincePixel, FLATTEN } from './layers.mjs';
import { dispersedPlace, homeBox, homeLook } from './homeland.mjs';
import { FAR_CAP, centreOn, fitView, freeBox } from './camera.mjs';
import { RADIUS } from '../../map.mjs';
import { TOWER } from './belltower.mjs';
import { candidatesBox } from './waitview.mjs';

/**
 * The hero zoom (UX brief §12.1): the camera stands a little further back than it did, a hex some 85 CSS px wide at
 * the middle of the picture (it was 115), so the far rows and the horizon they end in are in the everyday frame; a
 * little less on a phone, whose picture is narrow (never below the zoom at which every village carries its plate and
 * badges: map/plates.mjs PLATE_BADGES_R).
 */
export const heroZoom = (dpr = 1) => (dpr >= 1.5 ? 1.1 : 1.15);
/**
 * The opening never waits longer than this for the viewer's record (ms); then the world view. A safety net only: the
 * page says the viewer is known as soon as the record has answered or failed, and until then the map shows the bare
 * sheet on its table (UX brief §12.3). It was 4 s: on a slow connection the whole world came up first.
 */
export const OPEN_WAIT_MS = 15000;
/** How much higher than its target the opening starts (zoom factor). Behind the title the camera waits there (the title is opaque: fmap.mjs open). */
export const OPEN_FROM = 0.5;
/**
 * The view of the bell before joining: its tower takes `share` of the height nothing covers, between the zooms `min`
 * (the tiles stay tiles and the board keeps its tilt) and `max`; the picture's middle is `middle` of the way up it.
 */
export const ENGINE_VIEW = Object.freeze({ share: 0.78, min: 0.62, max: 1.3, middle: 0.44, aside: 0.13 });
/**
 * A nation that is looked at before joining: the camera comes no nearer than `max`, and looks `reach` of the way from
 * the bell to the middle of the first province of that nation's home wedge (the wedge begins half way there: the
 * picture holds the bell and the wedge's near edge with a few tiles of its lit land).
 */
export const LOOK = Object.freeze({ max: 1.15, reach: 0.72 });
/**
 * The point of nation `faction`'s home region the camera turns to from the bell (world px; the region's name stands
 * there), or null. `place`: the season's placement (home.mjs seasonPlace). The wedge: `reach` of the way to its
 * ring-1 province; a dispersed region: its anchor province (map/homeland.mjs homeLook); no readable placement: null.
 */
export function lookPoint(faction, ringsOpen, place = undefined) {
  return homeLook(faction, ringsOpen, place, { near: true, reach: LOOK.reach });
}
/**
 * Candidate sites are never framed from further out than this (the far bitmaps still show their painted discs, and a
 * site's plate is drawn down to a hex radius of 9 px). It was 0.3, measured against at least 40% of the picture's
 * height; a phone's wait sheet leaves a third, and the sites are now fitted into what is really left (`room` below).
 */
export const CANDIDATES_MIN = 0.21;
/** The wait in the home wedge: the wedge takes `fill` of the free part of the picture (it was 0.92), and the camera looks `out` of that part's width beyond the wedge's middle, away from the Concord. */
export const WEDGE_VIEW = Object.freeze({ fill: 0.84, out: 0.05 });
const RANK = { fit: 0, frame: 0, wedge: 1, candidates: 2, home: 3 };

/**
 * What the page knows about the viewer, for the map's source:
 * `{mode, ready, stage, faction, candidates: [{p, q, site}], active, title}`.
 * `ready` is false only on the play page while the viewer's record has not
 * answered yet; `title` is true while the title card is up.
 */
export function openHint(fs, { ready = false, title = false, frame = null } = {}) {
  const mode = fs?.mode ?? 'play';
  if (mode !== 'play') return { mode, ready: true, stage: 'watch', faction: null, candidates: [], active: 0, title };
  const land = fs.land ?? null;
  // `frame`: the nation choice stands along the foot of the map (UX brief §7.2): `{nation}` the nation that is
  // looked at (its home wedge comes into the part above the banners), or `{}` for the chart itself
  return { mode, ready: ready || !!land, stage: land?.stage ?? 'none', faction: Number.isInteger(fs.citizen?.faction) ? fs.citizen.faction : null,
    candidates: land?.ticket?.sites ?? [], active: Number.isInteger(fs.activeHolding) ? fs.activeHolding : 0, title, frame: (land?.stage ?? 'none') === 'none' ? frame : null };
}

/** The world point of a holding `{p, q, tile?}`: its tile, or its province's centre. */
export function placePoint(o) {
  const h = Number.isInteger(o.tile) ? tileHex(o.p, o.q, o.tile) : null;
  return h ? project(h.q, h.r) : provincePixel(o.p, o.q);
}

/**
 * The box (world px) around the provinces of `faction`'s home region in the open rings (map/homeland.mjs homeBox:
 * the wedge, or the dispersed provinces under that placement), or null (none in the open rings, or no readable
 * placement). `place`: the season's placement (home.mjs seasonPlace).
 */
export function wedgeBox(faction, ringsOpen, place = undefined) {
  return homeBox(faction, ringsOpen, place);
}

/**
 * The opening for this viewer: `{kind, view, at, rank}`, or null while the
 * viewer is not known yet. `src` is the map's source (own, ringsOpen, and
 * `place`, the season's placement: home.mjs seasonPlace; without a readable
 * one no home region is framed, never the wedge); `size` the canvas in CSS
 * px; `inset` what the page's sheets cover.
 */
export function openingPlan(hint, src, size, { inset = null, dpr = 1 } = {}) {
  const h = hint ?? { ready: true };
  if (h.ready === false) return null;
  const rings = Math.max(1, src?.ringsOpen ?? 1), place = src?.place;
  const free = freeBox(size, inset);
  const hero = heroZoom(dpr);
  const plan = (kind, at, zoom) => ({ kind, at, rank: RANK[kind], view: centreOn(at, zoom, size, inset) });
  const own = (src?.own ?? []).filter(o => Number.isInteger(o.p) && Number.isInteger(o.q));
  if (own.length) return plan('home', placePoint(own[Math.min(own.length - 1, Math.max(0, h.active ?? 0))]), hero);
  // candidate sites (UX brief §11.10): all of them in the uncovered part, as near as that allows (their tiles are
  // drawn from the tile view on; a request whose sites lie far apart is seen from further out). The survey knows
  // their tiles once the terrain is there; until then their provinces stand in
  const sites = (src?.survey?.candidates?.length ? src.survey.candidates : h.candidates ?? []).filter(s => Number.isInteger(s?.p) && Number.isInteger(s?.q));
  const cb = candidatesBox(sites);
  if (cb) {
    // (in the height that is really free: `freeBox` never goes below 40% of the picture, and under a phone's wait
    // sheet, which leaves a third, the first site's plate stood under the dial)
    const room = Math.max(120, Math.min(free.height, size.height - (inset?.top ?? 0) - (inset?.bottom ?? 0)));
    const zoom = Math.max(CANDIDATES_MIN, Math.min(hero, 0.9 * Math.min(free.width / (cb.x1 - cb.x0), room / (cb.y1 - cb.y0))));
    return plan('candidates', { x: (cb.x0 + cb.x1) / 2, y: (cb.y0 + cb.y1) / 2 }, zoom);
  }
  if (Number.isInteger(h.faction) && ['joined', 'ticket', 'refugee'].includes(h.stage)) {
    const box = wedgeBox(h.faction, rings, place);
    if (box) {
      // (UX brief §13.6: the wedge with room about it, WEDGE_VIEW.fill of the free part, and the camera a little to
      // its outer side, so the cloud sea beyond it, the sheet's edge and, where the picture is wide enough, the
      // table are in the view: the wait is seen from the seat, not as a map filled to its edges)
      const zoom = Math.max(0.16, Math.min(0.8, WEDGE_VIEW.fill * Math.min(free.width / box.width, free.height / box.height)));
      const far = Math.hypot(box.x, box.y) || 1, out = (WEDGE_VIEW.out * Math.min(free.width, free.height * 1.6)) / zoom;
      return plan('wedge', { x: box.x + (box.x / far) * out, y: box.y + (box.y / far) * out * FLATTEN }, zoom);
    }
  }
  // (a player who has not joined: with the nation choice standing along the foot of the map, `frame`, or with it put away)
  const frame = h.frame ?? (h.mode === 'play' && h.stage === 'none' ? {} : null);
  if (frame) {
    // before joining (UX brief §11.9): the camera is close on the bell at the Concord, the chart's one landmark, not
    // on the world. Its tower takes most of the height nothing covers; the chart runs out of the picture around it.
    // (the nation choice may leave less than the 40% of the height that `freeBox` never goes below: the bell is
    // framed in what is really free, `room`, and `lift` is how far that part's middle lies above the box's)
    const room = Math.max(120, Math.min(free.height, size.height - (inset?.top ?? 0) - (inset?.bottom ?? 0)));
    const lift = free.height > room ? (inset?.top ?? 0) + room / 2 - (size.height / 2 + free.y) : 0;
    const tall = TOWER.height * RADIUS, mid = { x: 0, y: -tall * ENGINE_VIEW.middle };
    const near = Math.max(ENGINE_VIEW.min, Math.min(ENGINE_VIEW.max, (ENGINE_VIEW.share * room) / tall, (0.9 * free.width) / (TOWER.plinth * 2 * RADIUS)));
    // a nation that is looked at (UX brief §11.9; the second review: the camera pulled out to the whole world, sheet,
    // cloud ring and table, and the bell became a toy): the camera stays close on the bell and turns toward that
    // nation's home wedge, the only land that lights. In the picture: the tower, whole, and the near part of the
    // wedge (`lookPoint`); the rest of the wedge runs out of the picture, as the chart does
    // (a dispersed region has no near side: its provinces stand round the whole heartland ring. The camera does not
    // turn from the bell toward one of them, it frames all of them, as the wait does, with the bell among them)
    const scattered = Number.isInteger(frame.nation) && dispersedPlace(place) ? wedgeBox(frame.nation, rings, place) : null;
    if (scattered) {
      const zoom = Math.max(0.16, Math.min(0.8, WEDGE_VIEW.fill * Math.min(free.width / scattered.width, room / scattered.height)));
      return plan('frame', { x: scattered.x, y: scattered.y - lift / zoom }, zoom);
    }
    const P = Number.isInteger(frame.nation) ? lookPoint(frame.nation, rings, place) : null;
    if (P) {
      const x0 = Math.min(P.x - RADIUS * 2.6, -TOWER.plinth * RADIUS), x1 = Math.max(P.x + RADIUS * 2.6, TOWER.plinth * RADIUS);
      const y0 = Math.min(P.y - RADIUS * 1.9, -tall), y1 = Math.max(P.y + RADIUS * 1.9, RADIUS);
      const zoom = Math.max(ENGINE_VIEW.min, Math.min(LOOK.max, near, 0.92 * Math.min(free.width / (x1 - x0), room / (y1 - y0))));
      return plan('frame', { x: (x0 + x1) / 2, y: (y0 + y1) / 2 - lift / zoom }, zoom);
    }
    // (in a wide picture the tower stands a little left of the middle: the turn's dial hangs in the middle of the top edge)
    const aside = free.width > room * 2.2 ? (ENGINE_VIEW.aside * free.width) / near : 0;
    return plan('frame', { x: mid.x + aside, y: mid.y - lift / near }, near);
  }
  return { kind: 'fit', at: { x: 0, y: 0 }, rank: RANK.fit, view: fitView(rings, size, { inset, cap: FAR_CAP, floor: 0.02 }) };
}
