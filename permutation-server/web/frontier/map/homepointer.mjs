// Where am I (UX brief §5.3, §11.8): when the viewer's village is off the
// screen, a gold tab sits flush with the edge of the map, where the line to
// the village leaves the picture. It carries the home glyph, the village's
// name when it appears, then how far the village is, with the unit (「5 マス」).
// Pressing it flies home. A real button (focusable, 44 px high, named for a
// screen reader), on phones too. It keeps out of the HUD's columns by sliding
// along its edge, and it is put away while a set piece plays.
//
// The geometry is pure (`edgePointer`, `tabBox`, `slideClear`); the button is
// placed with custom properties (the page's CSP allows no inline style).
import { inverseHex } from '../../map.mjs';
import { L, fmtNum, onLangChange } from '../../lang.mjs';
import { hexDistance } from '../fgeo.mjs';
import { freeBox } from './camera.mjs';
import { GLYPHS } from './glyphs.mjs';

/** The tab: its height (the press target), its least length, how long it says the village's name when it appears (ms), and the room it keeps from the HUD's things (px). */
export const POINTER_SIZE = 44;
export const POINTER_MIN = 56;
export const POINTER_NAME_MS = 3600;
export const POINTER_GAP = 8;
/** How far from a corner of the picture the tab's middle keeps (px): a tab is never cut by the corner. */
export const POINTER_MARGIN = 40;

/**
 * Where the pointer goes for a home at world point `home` `{x, y}`: null
 * while home is in the part of the canvas nothing covers, else `{x, y (CSS
 * px on the canvas: where the line from the middle of that part to home
 * leaves it), edge ('left' | 'right' | 'top' | 'bottom'), angle (radians, 0 =
 * pointing right), tiles, from, box: {x0, y0, x1, y1} (that part)}`, with the
 * distance in tiles from the tile in the middle. `view` {x, y, zoom}; `size`
 * {width, height}; `inset` what the page's sheets cover.
 */
export function edgePointer(view, size, home, { inset = null, margin = POINTER_MARGIN, geo = null } = {}) {
  // `geo` (map/tilt.mjs tiltGeo): the board's tilt; home is where it is seen, and the middle tile the one seen in the middle
  if (!home || !(size?.width > 0) || !(size?.height > 0) || !(view?.zoom > 0)) return null;
  const f = freeBox(size, inset);
  const cx = size.width / 2 + f.x, cy = size.height / 2 + f.y;
  const flat = { x: (home.x - view.x) * view.zoom + size.width / 2, y: (home.y - view.y) * view.zoom + size.height / 2 };
  const { x: hx, y: hy } = geo ? geo.toBox(flat.x, flat.y) : flat;
  const halfW = f.width / 2, halfH = f.height / 2;
  // on screen (with a little room to spare): no pointer
  if (Math.abs(hx - cx) <= halfW - 6 && Math.abs(hy - cy) <= halfH - 6) return null;
  const dx = hx - cx, dy = hy - cy;
  const sx = Math.abs(dx) > 1e-6 ? halfW / Math.abs(dx) : Infinity, sy = Math.abs(dy) > 1e-6 ? halfH / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  const edge = sx <= sy ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
  // (along its edge the tab's middle keeps `margin` from the corners)
  const mx = Math.min(margin, halfW), my = Math.min(margin, halfH);
  const x = edge === 'left' || edge === 'right' ? cx + dx * s : Math.max(cx - halfW + mx, Math.min(cx + halfW - mx, cx + dx * s));
  const y = edge === 'top' || edge === 'bottom' ? cy + dy * s : Math.max(cy - halfH + my, Math.min(cy + halfH - my, cy + dy * s));
  // the tile in the middle of the picture, and home's
  const ms = geo ? geo.toStage(cx, cy) : { x: cx, y: cy };
  const mid = { x: view.x + (ms.x - size.width / 2) / view.zoom, y: view.y + (ms.y - size.height / 2) / view.zoom };
  const [mq, mr] = inverseHex(mid.x, mid.y).split(',').map(Number), [hq, hr] = inverseHex(home.x, home.y).split(',').map(Number);
  return { x, y, edge, angle: Math.atan2(dy, dx), tiles: hexDistance(mq, mr, hq, hr), from: { x: cx, y: cy }, box: { x0: cx - halfW, y0: cy - halfH, x1: cx + halfW, y1: cy + halfH } };
}

/** The tab's box for a place on an edge: `{x, y, w, h}` (CSS px on the canvas), flush with that edge and inside the picture along it. */
export function tabBox(place, { w = POINTER_MIN, h = POINTER_SIZE } = {}) {
  const b = place.box, cl = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
  if (place.edge === 'left') return { x: b.x0, y: cl(place.y - h / 2, b.y0, b.y1 - h), w, h };
  if (place.edge === 'right') return { x: b.x1 - w, y: cl(place.y - h / 2, b.y0, b.y1 - h), w, h };
  if (place.edge === 'top') return { x: cl(place.x - w / 2, b.x0, b.x1 - w), y: b.y0, w, h };
  return { x: cl(place.x - w / 2, b.x0, b.x1 - w), y: b.y1 - h, w, h };
}

/**
 * Slide a tab along its edge until its box is clear of every box in `avoid`
 * (`[{x, y, w, h}]`, CSS px on the canvas: the HUD's things), the shortest
 * way. Where no place on the edge is clear (a phone's top edge: the dial in
 * the middle, a column of buttons at either side) the tab steps in from the
 * edge, as little as it takes, and slides there. Gives the box where it was
 * when it is clear already, or when nothing nearer than POINTER_INSET is.
 */
export const POINTER_INSET = 96;
export function slideClear(place, box, avoid = [], { gap = POINTER_GAP, step = 6 } = {}) {
  const hits = b => avoid.some(a => b.x + b.w + gap > a.x && b.x - gap < a.x + a.w && b.y + b.h + gap > a.y && b.y - gap < a.y + a.h);
  if (!avoid.length || !hits(box)) return box;
  const along = place.edge === 'left' || place.edge === 'right' ? 'y' : 'x', across = along === 'y' ? 'x' : 'y';
  const lo = along === 'y' ? place.box.y0 : place.box.x0, hi = (along === 'y' ? place.box.y1 - box.h : place.box.x1 - box.w);
  const inward = place.edge === 'left' || place.edge === 'top' ? 1 : -1;
  for (let n = 0; n <= POINTER_INSET; n += step) {
    const from = { ...box, [across]: box[across] + inward * n };
    if (n && !hits(from)) return from;
    for (let d = step; d <= hi - lo; d += step) for (const s of [d, -d]) {
      const v = box[along] + s;
      if (v < lo || v > hi) continue;
      const b = { ...from, [along]: v };
      if (!hits(b)) return b;
    }
  }
  return box;
}

/** The pointer's name for a screen reader, and its hover title; and what the tab itself says once the name has been read. */
export const pointerLabel = tiles => L`自分の村へ移動（${fmtNum(tiles)} マス先）`;
export const distanceText = tiles => L`${fmtNum(tiles)} マス`;

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgOf = (doc, cls, children) => {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: cls })) svg.setAttribute(k, v);
  for (const [d, tone] of children) { const p = doc.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); if (tone) { p.setAttribute('fill', 'currentColor'); p.setAttribute('fill-opacity', String(tone)); } svg.append(p); }
  return svg;
};

/**
 * Mount the button after `canvas` (a DOM page only): `{update(place, {name, avoid}),
 * remove()}`, or null without a document. `update(null)` puts it away;
 * `update(place)` (edgePointer's) shows it on its edge. `name`: the village's
 * name, said when the tab appears; `avoid`: the HUD's boxes over the map.
 * `onPress()` flies home.
 */
export function mountHomePointer(canvas, { onPress = () => {}, clock = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  const doc = canvas?.ownerDocument;
  if (!doc?.createElement || !canvas.parentElement) return null;
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'home-pointer';
  b.dataset.map = 'home-pointer';
  b.hidden = true;
  if (doc.createElementNS) {
    // a small head that turns toward home, and the home glyph (the HUD sprite's own picture: map/glyphs.mjs)
    b.append(svgOf(doc, 'hp-chev', [['M9 5.5l7 6.5-7 6.5', 0]]), svgOf(doc, 'hp-home', GLYPHS.home.paths));
  }
  const text = doc.createElement('span');
  text.className = 'hp-text';
  b.append(text);
  b.addEventListener('click', () => onPress());
  let shown = null, since = 0, timer = null, name = '';
  const say = () => {
    if (!shown) return;
    const named = !!name && clock() - since < POINTER_NAME_MS;
    const t = named ? name : distanceText(shown.tiles);
    if (text.textContent !== t) { text.textContent = t; shown.w = null; }
    b.dataset.says = named ? 'name' : 'distance';
    const label = pointerLabel(shown.tiles);
    b.setAttribute('aria-label', label); b.title = label;
  };
  const off = onLangChange(say);
  (canvas.parentElement.querySelector?.('.map-tools') ?? canvas).after(b);
  return {
    el: b,
    /** Its box on the canvas while it shows (CSS px), else null: the map's labels keep clear of it. */
    box: () => (shown?.box && !b.hidden ? shown.box : null),
    update(at, { name: n = '', avoid = [] } = {}) {
      if (!at) { if (!b.hidden) { b.hidden = true; shown = null; if (timer) { clearTimeout(timer); timer = null; } } return; }
      const fresh = !shown;
      if (fresh) {
        // it appears: the village's name first, then the distance (a timer turns the page: nothing else redraws the map)
        shown = { tiles: at.tiles, w: null }; since = clock(); name = n;
        b.hidden = false;
        if (timer) clearTimeout(timer);
        timer = globalThis.setTimeout?.(() => { timer = null; say(); place(); }, POINTER_NAME_MS + 30) ?? null;
      }
      if (fresh || shown.tiles !== at.tiles || name !== n) { shown.tiles = at.tiles; name = n; say(); }
      shown.at = at; shown.avoid = avoid;
      place();
    },
    remove() { off?.(); if (timer) clearTimeout(timer); b.remove(); },
  };
  function place() {
    if (!shown?.at) return;
    const at = shown.at;
    if (b.dataset.edge !== at.edge) { b.dataset.edge = at.edge; shown.w = null; }
    // (its length follows its words: read once per change of words or edge)
    shown.w ??= Math.max(POINTER_MIN, b.offsetWidth || POINTER_MIN);
    const box = shown.box = slideClear(at, tabBox(at, { w: shown.w, h: POINTER_SIZE }), shown.avoid ?? []);
    // (the canvas's own place inside the element the button is laid out in)
    const x = Math.round(box.x + (canvas.offsetLeft ?? 0)), y = Math.round(box.y + (canvas.offsetTop ?? 0)), deg = Math.round(at.angle * 180 / Math.PI);
    const key = `${x},${y},${deg}`;
    if (shown.key === key) return;
    shown.key = key;
    b.style.setProperty('--x', `${x}px`);
    b.style.setProperty('--y', `${y}px`);
    b.style.setProperty('--a', `${deg}deg`);
  }
}
