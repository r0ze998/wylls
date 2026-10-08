// The map's camera (UX brief §4): every move is a move.
//
// Two views. `view` is the LOGICAL one: where the camera is going. It changes
// at once, so picking by keyboard, the level of detail, `data-lod` and every
// test read the result of an input synchronously. `drawn` is what is on
// screen: it travels toward the logical view (a fly, an eased zoom about the
// pointer, the glide after a drag). With reduced motion there is no travel:
// the drawn view is the logical view.
//
// Pure: no DOM, no timers of its own. The owner (FrontierMap) calls `step(now)`
// once a frame and redraws while it returns true. Pointer input stops a move
// where it is (`halt`); keys and buttons act on the logical view, so presses
// add up whatever the picture is doing.
import { FLATTEN, RADIUS, project } from '../../map.mjs';
import { PROVINCE_TILES, ringProvinces, tileHex } from '../fgeo.mjs';
import { provincePixel, PROVINCE_CIRCUMRADIUS } from './layers.mjs';
import { motion } from '../fx/motion.mjs';

/** Milliseconds of the standard moves. */
export const MOVE_MS = Object.freeze({ open: 1400, fly: 720, far: 900, zoom: 170, pan: 150, wheel: 140, settle: 260 });
/** The glide after a drag: speed decays with this time constant (ms); slower than FLING_MIN px/ms does not glide. */
export const FLING_TAU = 300;
export const FLING_MIN = 0.12;
/** A frame never advances a move by more than this (a slow frame slows the move, it does not skip it). */
const MAX_STEP_MS = 50;

/**
 * Whether nothing may travel: the one answer of the whole client (fx/motion.mjs: the calmer of the system's
 * reduced-motion setting and the player's "effects: full / reduced / off").
 */
export function reducedMotion() {
  try { return motion() !== 'full'; } catch { return false; }
}

const clamp01 = x => Math.max(0, Math.min(1, x));
export const EASE = Object.freeze({
  linear: k => k,
  outCubic: k => 1 - Math.pow(1 - k, 3),
  outQuint: k => 1 - Math.pow(1 - k, 5),
  inOutCubic: k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  /** A glide that starts at the release speed and dies away (6 time constants long). */
  decay: k => (1 - Math.exp(-6 * k)) / (1 - Math.exp(-6)),
});

/**
 * The view between `from` and `to` at eased progress `e` (0..1).
 * Zoom always travels on a log scale. Position:
 *   kind 'fly'     the far end of the trip glides across the screen at an even pace, whatever the zoom
 *                  (a descent keeps its target in the picture; a climb keeps where it left);
 *   kind 'anchor'  the world point under the screen point `anchor` (px from the canvas centre) travels in
 *                  a straight line: with the same point at both ends it stays under the pointer.
 */
export function between(from, to, e, kind = 'anchor', anchor = null) {
  if (e <= 0) return { ...from };
  if (e >= 1) return { ...to };
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, e);
  if (kind === 'fly') {
    if (to.zoom >= from.zoom) {
      const k = from.zoom * (1 - e) / zoom;
      return { x: to.x - (to.x - from.x) * k, y: to.y - (to.y - from.y) * k, zoom };
    }
    const k = to.zoom * e / zoom;
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, zoom };
  }
  const ax = anchor?.x ?? 0, ay = anchor?.y ?? 0;
  const wx0 = from.x + ax / from.zoom, wy0 = from.y + ay / from.zoom;
  const wx1 = to.x + ax / to.zoom, wy1 = to.y + ay / to.zoom;
  return { x: wx0 + (wx1 - wx0) * e - ax / zoom, y: wy0 + (wy1 - wy0) * e - ay / zoom, zoom };
}

/** The radius (world px) of the opened world: the open rings and the first ring of cloud around them. */
export function worldRadius(ringsOpen) {
  const edge = provincePixel(Math.max(1, ringsOpen ?? 1), 0);
  return Math.hypot(edge.x, edge.y) + PROVINCE_CIRCUMRADIUS;
}

/** Of a picture's width or height, how much the cloud sea beyond the opened land may take: a pan stops there. */
export const SEA_SHARE = 1 / 3;

/**
 * Keep a view's centre where the picture is mostly land: the cloud sea beyond
 * the opened rings never takes more than about a third of it (UX brief
 * §11.3). The land is close to an ellipse (the ground plane is squashed by
 * FLATTEN); zoomed out to where the whole world shows, the centre stays near
 * the middle. `soft` (0..1) lets a drag pull past the limit with that much
 * give; the release settles back.
 */
export function clampCentre(view, { ringsOpen = 1, size, soft = 0 } = {}) {
  const b = landBox(ringsOpen);
  const halfW = (size?.width ?? 0) / 2 / view.zoom, halfH = (size?.height ?? 0) / 2 / view.zoom;
  // (the picture reaches `half` past its centre: with SEA_SHARE of its whole width beyond the land's edge, the centre
  // stands half · (1 − 2 · SEA_SHARE) inside that edge. A picture as wide as the land itself keeps the land whole)
  const reach = (land, half) => {
    const t = Math.max(0, Math.min(1, (half / land - 0.45) / 0.55)), k = 1 - 2 * SEA_SHARE * (1 - t * t * (3 - 2 * t));
    return Math.max(land * 0.12, land - half * k);
  };
  const ax = reach(b.x, halfW), ay = reach(b.y, halfH);
  const u = view.x / ax, v = view.y / ay, len = Math.hypot(u, v);
  if (len <= 1) return view;
  const over = len - 1, keep = soft > 0 ? 1 + (1 - 1 / (over * 2.2 + 1)) * 0.5 * soft : 1;
  return { ...view, x: (u / len) * keep * ax, y: (v / len) * keep * ay };
}

/** The radius (world px) of the opened land alone: the open rings without the cloud around them. */
export function landRadius(ringsOpen) {
  const edge = provincePixel(Math.max(0, (ringsOpen ?? 1) - 1), 0);
  return Math.hypot(edge.x, edge.y) + PROVINCE_CIRCUMRADIUS;
}

const boxes = new Map();
/** The opened land's own box about the Concord: `{x, y}` half its width and half its height (world px, to the tiles' edges). */
export function landBox(ringsOpen) {
  const d = Math.max(1, ringsOpen ?? 1);
  if (boxes.has(d)) return boxes.get(d);
  let x = 0, y = 0;
  const provinces = [{ p: 0, q: 0 }];
  for (let r = 1; r < d; r++) provinces.push(...ringProvinces(r));
  for (const pr of provinces) for (let i = 0; i < PROVINCE_TILES; i++) { const h = tileHex(pr.p, pr.q, i), c = project(h.q, h.r); x = Math.max(x, Math.abs(c.x)); y = Math.max(y, Math.abs(c.y)); }
  const v = Object.freeze({ x: x + RADIUS * Math.sqrt(3) / 2, y: y + RADIUS * FLATTEN });
  if (boxes.size > 12) boxes.clear();
  boxes.set(d, v);
  return v;
}

/** The far view shows the opened land in this share of the free part of the picture (UX brief §11.2), and never nearer than FAR_CAP (it stays a chart: the level of detail of the world, map/fmap.mjs lodEdges). */
export const FAR_FILL = 0.7;
export const FAR_CAP = 0.345;

/**
 * The far view ("the world chart"): the opened land takes `fill` of the part
 * of the canvas nothing covers, by its tighter side, so the sheet it is drawn
 * on lies on the table with room around it. `inset` = {top, right, bottom,
 * left} CSS px covered by the page's sheets. Never nearer than `cap`.
 */
export function fitView(ringsOpen, size, { inset = null, cap = FAR_CAP, floor = 0, fill = FAR_FILL } = {}) {
  const b = landBox(ringsOpen);
  const free = freeBox(size, inset);
  const zoom = Math.max(floor, Math.min(cap, fill * Math.min(free.width / (2 * b.x), free.height / (2 * b.y))));
  return centreOn({ x: 0, y: 0 }, zoom, size, inset);
}

/** The part of the canvas nothing covers: {x, y (its centre, px from the canvas centre), width, height}. */
export function freeBox(size, inset = null) {
  const t = inset?.top ?? 0, r = inset?.right ?? 0, b = inset?.bottom ?? 0, l = inset?.left ?? 0;
  // never less than 40% of a side: a full sheet does not push the map off the screen
  const width = Math.max(size.width * 0.4, size.width - l - r), height = Math.max(size.height * 0.4, size.height - t - b);
  const cx = l + (size.width - l - r) / 2, cy = t + (size.height - t - b) / 2;
  const x = Math.max(width / 2, Math.min(size.width - width / 2, cx)) - size.width / 2;
  const y = Math.max(height / 2, Math.min(size.height - height / 2, cy)) - size.height / 2;
  return { x, y, width, height };
}

/** The view that shows world point `pt` in the middle of the uncovered part of the canvas at `zoom`. */
export function centreOn(pt, zoom, size, inset = null) {
  const f = freeBox(size, inset);
  return { x: pt.x - f.x / zoom, y: pt.y - f.y / zoom, zoom };
}

/** The world point in the middle of the uncovered part of the canvas. */
export function focusOf(view, size, inset = null) {
  const f = freeBox(size, inset);
  return { x: view.x + f.x / view.zoom, y: view.y + f.y / view.zoom };
}

export class Camera {
  /** `view` the first view; `now()` ms; `reduced()` whether moves jump; `limit(view, soft)` clamps a view. */
  constructor({ view = { x: 0, y: 0, zoom: 1 }, reduced = reducedMotion, limit = null } = {}) {
    this.view = { ...view };
    this.drawn = { ...view };
    this.reduced = reduced;
    this.limit = limit;
    /** True once a person (or the page on their behalf) placed the camera: automatic framing stops. */
    this.userMoved = false;
    this.tween = null;
  }

  /** Whether the drawn view is still travelling. */
  get moving() { return !!this.tween; }

  /**
   * Go to `view` (a partial view is merged). The logical view changes now;
   * the drawn one arrives after `ms` (0, or reduced motion: at once).
   * `kind` and `anchor` as in between(); `soft` keeps a drag's give.
   */
  set(view, { ms = 0, ease = EASE.outCubic, kind = 'anchor', anchor = null, clamp = false, soft = 0, tag = null } = {}) {
    let next = { ...this.view, ...view };
    if (this.limit) next = this.limit(next, { clamp, soft });
    this.view = next;
    if (!(ms > 0) || this.reduced()) { this.drawn = { ...next }; this.tween = null; return next; }
    const d = this.drawn;
    if (Math.abs(d.x - next.x) * next.zoom < 0.25 && Math.abs(d.y - next.y) * next.zoom < 0.25 && Math.abs(Math.log(d.zoom / next.zoom)) < 1e-4) { this.drawn = { ...next }; this.tween = null; return next; }
    this.tween = { from: { ...d }, ms, ease, kind, anchor, tag, elapsed: 0, last: null };
    return next;
  }

  /** Start the drawn view somewhere else (the opening: a little above the target) and travel to the logical view. */
  from(view, opts) {
    if (this.reduced()) return;
    this.drawn = { ...this.drawn, ...view };
    this.set(this.view, opts);
  }

  /** Stop where the picture is (a finger on the map): the logical view becomes the drawn one. Returns whether it was moving. */
  halt() {
    if (!this.tween) return false;
    this.tween = null;
    this.view = { ...this.drawn };
    return true;
  }

  /** Arrive now. */
  finish() { this.tween = null; this.drawn = { ...this.view }; }

  /**
   * The glide after a drag released at (vx, vy) screen px per ms: the logical
   * view goes to where the glide will end, the drawn view decays toward it.
   */
  fling(vx, vy) {
    const speed = Math.hypot(vx, vy);
    if (!(speed >= FLING_MIN) || this.reduced()) return false;
    const z = this.view.zoom;
    this.set({ x: this.view.x - (vx * FLING_TAU) / z, y: this.view.y - (vy * FLING_TAU) / z }, { ms: FLING_TAU * 6, ease: EASE.decay, clamp: true, tag: 'glide' });
    return true;
  }

  /** Advance the drawn view to time `now` (ms). Returns true while it moved (the owner redraws). */
  step(now) {
    const tw = this.tween;
    if (!tw) return false;
    let dt = tw.last === null ? 0 : now - tw.last;
    if (tw.last !== null && !(dt > 0)) dt = 1000 / 60;   // a frozen clock still animates, a frame at a time
    tw.last = now;
    tw.elapsed += Math.min(MAX_STEP_MS, dt);
    const k = clamp01(tw.elapsed / tw.ms);
    const d = this.drawn = between(tw.from, this.view, tw.ease(k), tw.kind, tw.anchor), v = this.view;
    // arrived, or so close that nothing on screen would change (the long tail of a glide)
    const there = k > 0.5 && Math.abs(d.x - v.x) * v.zoom < 0.2 && Math.abs(d.y - v.y) * v.zoom < 0.2 && Math.abs(Math.log(d.zoom / v.zoom)) < 2e-4;
    if (k >= 1 || there) { this.drawn = { ...v }; this.tween = null; }
    return true;
  }
}

/** The zooms between which the far view turns into the near one (the depth dressing and the far bitmaps follow it). */
export const LOD_NEAR = Object.freeze({ from: 0.16, to: 0.55 });
