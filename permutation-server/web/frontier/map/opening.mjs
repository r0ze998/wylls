// The opening view (UX brief §4): the one place that decides where the map
// opens. It depends on who is looking:
//
//   a village (provisional or final)   the active village's tile at the hero zoom
//   a ticket with candidate sites      the first candidate's province
//   joined, no land yet                the nation's home wedge
//   not joined, watching, practising   the whole opened world, as before
//
// The page says who is looking with `openHint(FS)` in the map's source; the
// map asks `openingPlan` every frame until a person moves the camera. A plan
// is null while the first answer about the viewer is still on its way (the
// holdings arrive after the first frame): the map waits instead of showing
// the whole world first. Higher priorities live outside this file: a link
// with ?at= and a battle the page focuses both place the camera themselves,
// which counts as moved.
import { project } from '../../map.mjs';
import { ringProvinces, tileHex, wedgeOf } from '../fgeo.mjs';
import { homeWedge } from '../fland.mjs';
import { provincePixel, PROVINCE_CIRCUMRADIUS, FLATTEN } from './layers.mjs';
import { centreOn, fitView, freeBox } from './camera.mjs';

/** The hero zoom: a hex about 90 to 100 CSS px wide; a little less on a dense screen, where the largest sprites are already stretched (never below the zoom at which every village carries its name tag). */
export const heroZoom = (dpr = 1) => (dpr >= 1.5 ? 1.2 : 1.3);
/** The opening never waits longer than this for the viewer's record (ms); then the world view. */
export const OPEN_WAIT_MS = 4000;
/** How much higher than its target the opening starts (zoom factor), and the title card's longer drift. */
export const OPEN_FROM = 0.5;
export const TITLE_FROM = 0.35;
export const TITLE_MS = 7000;
/** The far view stays in the world level of detail. */
const FAR_CAP = 0.114;
const RANK = { fit: 0, wedge: 1, candidates: 2, home: 3 };

/**
 * What the page knows about the viewer, for the map's source:
 * `{mode, ready, stage, faction, candidates: [{p, q, site}], active, title}`.
 * `ready` is false only on the play page while the viewer's record has not
 * answered yet; `title` is true while the title card is up.
 */
export function openHint(fs, { ready = false, title = false } = {}) {
  const mode = fs?.mode ?? 'play';
  if (mode !== 'play') return { mode, ready: true, stage: 'watch', faction: null, candidates: [], active: 0, title };
  const land = fs.land ?? null;
  return { mode, ready: ready || !!land, stage: land?.stage ?? 'none', faction: Number.isInteger(fs.citizen?.faction) ? fs.citizen.faction : null,
    candidates: land?.ticket?.sites ?? [], active: Number.isInteger(fs.activeHolding) ? fs.activeHolding : 0, title };
}

/** The world point of a holding `{p, q, tile?}`: its tile, or its province's centre. */
export function placePoint(o) {
  const h = Number.isInteger(o.tile) ? tileHex(o.p, o.q, o.tile) : null;
  return h ? project(h.q, h.r) : provincePixel(o.p, o.q);
}

/** The box (world px) around the provinces of `faction`'s home wedge in the open rings. */
export function wedgeBox(faction, ringsOpen) {
  const w = homeWedge(faction);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let d = 1; d < Math.max(2, ringsOpen); d++) for (const pr of ringProvinces(d)) {
    if (wedgeOf(pr.p, pr.q) !== w) continue;
    const c = provincePixel(pr.p, pr.q);
    x0 = Math.min(x0, c.x - PROVINCE_CIRCUMRADIUS); x1 = Math.max(x1, c.x + PROVINCE_CIRCUMRADIUS);
    y0 = Math.min(y0, c.y - PROVINCE_CIRCUMRADIUS * FLATTEN); y1 = Math.max(y1, c.y + PROVINCE_CIRCUMRADIUS * FLATTEN);
  }
  return Number.isFinite(x0) ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: x1 - x0, height: y1 - y0 } : null;
}

/**
 * The opening for this viewer: `{kind, view, at, rank}`, or null while the
 * viewer is not known yet. `src` is the map's source (own, ringsOpen);
 * `size` the canvas in CSS px; `inset` what the page's sheets cover.
 */
export function openingPlan(hint, src, size, { inset = null, dpr = 1 } = {}) {
  const h = hint ?? { ready: true };
  if (h.ready === false) return null;
  const rings = Math.max(1, src?.ringsOpen ?? 1);
  const free = freeBox(size, inset);
  const hero = heroZoom(dpr);
  const plan = (kind, at, zoom) => ({ kind, at, rank: RANK[kind], view: centreOn(at, zoom, size, inset) });
  const own = (src?.own ?? []).filter(o => Number.isInteger(o.p) && Number.isInteger(o.q));
  if (own.length) return plan('home', placePoint(own[Math.min(own.length - 1, Math.max(0, h.active ?? 0))]), hero);
  const first = (h.candidates ?? []).find(s => Number.isInteger(s?.p) && Number.isInteger(s?.q));
  if (first) {
    // one province fills the uncovered part: its tiles are drawn, so the candidate sites can be seen
    const zoom = Math.max(0.55, Math.min(hero, (0.85 * Math.min(free.width, free.height / FLATTEN)) / (2 * PROVINCE_CIRCUMRADIUS)));
    return plan('candidates', provincePixel(first.p, first.q), zoom);
  }
  if (Number.isInteger(h.faction) && ['joined', 'ticket', 'refugee'].includes(h.stage)) {
    const box = wedgeBox(h.faction, rings);
    if (box) return plan('wedge', { x: box.x, y: box.y }, Math.max(0.16, Math.min(0.8, 0.92 * Math.min(free.width / box.width, free.height / box.height))));
  }
  return { kind: 'fit', at: { x: 0, y: 0 }, rank: RANK.fit, view: fitView(rings, size, { inset, cap: FAR_CAP, floor: 0.02 }) };
}
