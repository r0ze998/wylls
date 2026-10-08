// Where am I (UX brief §5.3): when the viewer's village is off the screen, a
// gold pointer sits at the edge of the map on the line to it and says how
// many tiles away it is; pressing it flies home. A real button (focusable,
// 44 px, named for a screen reader), on phones too, where there is no
// minimap. The geometry is pure (`edgePointer`); the button is placed with
// custom properties (the page's CSP allows no inline style).
import { inverseHex } from '../../map.mjs';
import { L, fmtNum, onLangChange } from '../../lang.mjs';
import { hexDistance } from '../fgeo.mjs';
import { freeBox } from './camera.mjs';

/** The button's size (CSS px) and how far its centre keeps from the edge of the part of the map nothing covers. */
export const POINTER_SIZE = 44;
export const POINTER_MARGIN = 40;

/**
 * Where the pointer goes for a home at world point `home` `{x, y}`:
 * null while home is in the part of the canvas nothing covers, else
 * `{x, y (CSS px on the canvas), angle (radians, 0 = pointing right),
 * tiles}`: on the line from the middle of that part to home, where the line
 * meets its edge (less a margin), with the distance in tiles from the tile
 * in the middle. `view` {x, y, zoom}; `size` {width, height}; `inset` what
 * the page's sheets cover.
 */
export function edgePointer(view, size, home, { inset = null, margin = POINTER_MARGIN } = {}) {
  if (!home || !(size?.width > 0) || !(size?.height > 0) || !(view?.zoom > 0)) return null;
  const f = freeBox(size, inset);
  const cx = size.width / 2 + f.x, cy = size.height / 2 + f.y;
  const hx = (home.x - view.x) * view.zoom + size.width / 2, hy = (home.y - view.y) * view.zoom + size.height / 2;
  const halfW = f.width / 2, halfH = f.height / 2;
  // on screen (with a little room to spare): no pointer
  if (Math.abs(hx - cx) <= halfW - 6 && Math.abs(hy - cy) <= halfH - 6) return null;
  const dx = hx - cx, dy = hy - cy;
  const rx = Math.max(8, halfW - margin), ry = Math.max(8, halfH - margin);
  const s = Math.min(Math.abs(dx) > 1e-6 ? rx / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? ry / Math.abs(dy) : Infinity);
  // the tile in the middle of the picture, and home's
  const mid = { x: view.x + f.x / view.zoom, y: view.y + f.y / view.zoom };
  const [mq, mr] = inverseHex(mid.x, mid.y).split(',').map(Number), [hq, hr] = inverseHex(home.x, home.y).split(',').map(Number);
  return { x: cx + dx * s, y: cy + dy * s, angle: Math.atan2(dy, dx), tiles: hexDistance(mq, mr, hq, hr), from: { x: cx, y: cy } };
}

/**
 * Move a pointer place inward along its line (toward `place.from`) until its
 * box is clear of every box in `avoid` (`[{x, y, w, h}]`, CSS px on the
 * canvas: the map's own controls). Gives the place back unchanged when it is
 * clear already or nothing nearer is clear.
 */
export function clearOf(place, avoid = [], { size = POINTER_SIZE, gap = 6, step = 8, reach = 260 } = {}) {
  if (!place || !avoid.length || !place.from) return place;
  const hits = (x, y) => avoid.some(b => x + size / 2 + gap > b.x && x - size / 2 - gap < b.x + b.w && y + size / 2 + gap > b.y && y - size / 2 - gap < b.y + b.h);
  if (!hits(place.x, place.y)) return place;
  const dx = place.from.x - place.x, dy = place.from.y - place.y, len = Math.hypot(dx, dy);
  if (!(len > 1)) return place;
  for (let d = step; d <= Math.min(reach, len - size); d += step) {
    const x = place.x + (dx / len) * d, y = place.y + (dy / len) * d;
    if (!hits(x, y)) return { ...place, x, y };
  }
  return place;
}

/** The pointer's name for a screen reader, and its hover title. */
export const pointerLabel = tiles => L`自分の村へ移動（${fmtNum(tiles)} マス先）`;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Mount the button after `canvas` (a DOM page only): `{update(place),
 * remove()}`, or null without a document. `update(null)` hides it;
 * `update({x, y, angle, tiles})` shows it there. `onPress()` flies home.
 */
export function mountHomePointer(canvas, { onPress = () => {} } = {}) {
  const doc = canvas?.ownerDocument;
  if (!doc?.createElement || !canvas.parentElement) return null;
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'home-pointer';
  b.dataset.map = 'home-pointer';
  b.hidden = true;
  if (doc.createElementNS) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '-32 -32 64 64', width: '64', height: '64', 'aria-hidden': 'true', focusable: 'false', class: 'hp-arrow' })) svg.setAttribute(k, v);
    // a disc with a head pointing right (the stylesheet turns it toward home); it is drawn a little larger than the 44-px target
    const ring = doc.createElementNS(SVG_NS, 'circle');
    for (const [k, v] of Object.entries({ cx: '0', cy: '0', r: '18', class: 'hp-ring' })) ring.setAttribute(k, v);
    const head = doc.createElementNS(SVG_NS, 'path');
    head.setAttribute('d', 'M16.5-11.5 30.5 0 16.5 11.5c3.4-7.4 3.4-15.6 0-23z');
    head.setAttribute('class', 'hp-head');
    svg.append(ring, head);
    b.append(svg);
  }
  const num = doc.createElement('span');
  num.className = 'hp-dist';
  b.append(num);
  b.addEventListener('click', () => onPress());
  let shown = null;
  const label = () => { if (shown) { const t = pointerLabel(shown.tiles); b.setAttribute('aria-label', t); b.title = t; } };
  const off = onLangChange(label);
  (canvas.parentElement.querySelector?.('.map-tools') ?? canvas).after(b);
  // the map's own controls laid over the canvas (its siblings): the pointer keeps clear of them. Read at most twice a second.
  let boxes = [], boxesAt = -1e9;
  const controls = () => {
    const t = globalThis.performance?.now?.() ?? Date.now();
    if (t - boxesAt < 500) return boxes;
    boxesAt = t; boxes = [];
    const c = canvas.getBoundingClientRect?.();
    if (!c || !(c.width > 0)) return boxes;
    for (const el of canvas.parentElement.children) {
      if (el === canvas || el === b || el.hidden || el.id === 'panel' || el.id === 'map-tip' || el.id === 'map-summary') continue;
      const r = el.getBoundingClientRect?.();
      if (!r || !(r.width > 0) || !(r.height > 0) || r.width * r.height > c.width * c.height * 0.45) continue;
      if (r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom) continue;
      boxes.push({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height });
    }
    return boxes;
  };
  return {
    el: b,
    update(at) {
      if (!at) { if (!b.hidden) { b.hidden = true; shown = null; } return; }
      const place = clearOf(at, controls());
      // (the canvas's own place inside the element the button is laid out in)
      const x = Math.round(place.x + (canvas.offsetLeft ?? 0)), y = Math.round(place.y + (canvas.offsetTop ?? 0)), deg = Math.round(place.angle * 180 / Math.PI);
      const key = `${x},${y},${deg},${place.tiles}`;
      if (shown?.key === key && !b.hidden) return;
      b.style.setProperty('--x', `${x}px`);
      b.style.setProperty('--y', `${y}px`);
      b.style.setProperty('--a', `${deg}deg`);
      const tilesChanged = shown?.tiles !== place.tiles;
      shown = { key, tiles: place.tiles };
      if (tilesChanged) { num.textContent = fmtNum(place.tiles); label(); }
      if (b.hidden) b.hidden = false;
    },
    remove() { off?.(); b.remove(); },
  };
}
