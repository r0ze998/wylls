// Display geometry only. No pathfinding, economy, combat, clock or lifecycle rules.
// The camera is BigInt (production wide.mjs): a global coordinate never passes through Number. Only the small
// offset of a province from the camera (|Δ| ≤ VIEW_RADIUS_MAX) and tile pixel positions are plain numbers.
import { originAt, parseWideInt, relativeTo, formatCoord, WIDE_BOUND } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { TILE_OFFSETS, tileHex, provinceCentre, DIRECTIONS } from '../../../permutation-server/web/frontier/fgeo.mjs';

/** The view is bounded: at most this province radius around the camera (19 provinces, 1,159 hexes). */
export const VIEW_RADIUS_MAX = 2;
export const VIEW_PROVINCES_MAX = 1 + 3 * VIEW_RADIUS_MAX * (VIEW_RADIUS_MAX + 1);
/** Pan step sizes in provinces (BigInt). */
export const PAN_STEPS = Object.freeze([1n, 1000n, 1000000000n]);
/** The six axial directions, in production fgeo order, as display labels. */
export const DIRECTION_LABELS = Object.freeze(['P+1', 'P+1 Q−1', 'Q−1', 'P−1', 'P−1 Q+1', 'Q+1']);
const abs = x => (x < 0n ? -x : x);
const pixel = h => ({ x: Math.sqrt(3) * (h.q + h.r / 2), y: 1.5 * h.r });
const inBound = (p, q) => abs(p) <= WIDE_BOUND && abs(q) <= WIDE_BOUND;

export function localTilePoint(origin, place) {
  const p = parseWideInt(place.p), q = parseWideInt(place.q);
  if (!Number.isInteger(place.tile) || place.tile < 0 || place.tile >= TILE_OFFSETS.length) throw new Error('BadTile');
  const offset = relativeTo(origin, p, q);
  if (!offset) throw new Error('OutsideCamera');
  const h = tileHex(offset.dp, offset.dq, place.tile);
  return Object.freeze({ ...pixel(h), label: `${formatCoord(p, q)} · tile ${place.tile}` });
}

// Caller supplies only validated host positions and route tiles. Geometry never infers a legal route.
export function mapLayout({ origin, provinces, route = [] }) {
  const camera = originAt(origin.p, origin.q);
  if (!Array.isArray(provinces) || provinces.length < 1 || provinces.length > 2 || !Array.isArray(route) || route.length > 128) throw new Error('BadMap');
  const seen = new Set();
  const tiles = provinces.flatMap(province => {
    const p = parseWideInt(province.p), q = parseWideInt(province.q), key = `${p},${q}`;
    if (seen.has(key)) throw new Error('DuplicateProvince');
    seen.add(key);
    return TILE_OFFSETS.map((_, tile) => ({ passable: province.passableMask === undefined ? null : !!(BigInt(province.passableMask) & (1n << BigInt(tile))), p: p.toString(), q: q.toString(), tile, ...localTilePoint(camera, { p: p.toString(), q: q.toString(), tile }) }));
  });
  const path = route.map(point => {
    if (!seen.has(`${parseWideInt(point.p)},${parseWideInt(point.q)}`)) throw new Error('UnknownRouteProvince');
    return localTilePoint(camera, point);
  });
  const xs = tiles.map(t => t.x), ys = tiles.map(t => t.y);
  return { tiles, path, bounds: [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) - Math.min(...xs) + 4, Math.max(...ys) - Math.min(...ys) + 4] };
}

// ------------------------------------------------------------------ camera (view state only; never sent anywhere)
/** A camera at province (p, q) — BigInts or canonical decimal strings within ±2^62 — showing `radius` rings. */
export function cameraAt(p, q, radius = 1) {
  if (!Number.isInteger(radius) || radius < 0 || radius > VIEW_RADIUS_MAX) throw new Error('BadRadius');
  return Object.freeze({ centre: originAt(p, q), radius });
}
/** The camera moved `step` provinces in fgeo direction `direction`; null when that would leave ±2^62 (a bound, not infinity). */
export function panCamera(camera, direction, step = 1n) {
  const d = DIRECTIONS[direction];
  if (!d || typeof step !== 'bigint' || !PAN_STEPS.includes(step)) throw new Error('BadPan');
  const p = camera.centre.p + BigInt(d[0]) * step, q = camera.centre.q + BigInt(d[1]) * step;
  if (!inBound(p, q)) return null;
  return Object.freeze({ centre: originAt(p, q), radius: camera.radius });
}
export const resizeCamera = (camera, radius) => cameraAt(camera.centre.p, camera.centre.q, radius);
/** View-only jump to typed coordinates: canonical decimals within ±2^62 (parseWideInt), else it throws. */
export const jumpCamera = (pText, qText, radius = 1) => cameraAt(parseWideInt(pText), parseWideInt(qText), radius);

/**
 * The bounded view around `camera`. Every province cell is one of:
 *   - `known`: one of the (at most two) provinces whose account bytes the local host returned, with its passability;
 *   - `unknown`: a lattice position with NO data in this session — not opened, not generated, not playable here;
 *   - `outside`: beyond the ±2^62 coordinate bound, where no province can exist.
 * The lattice geometry is mathematics; nothing about an unknown cell's terrain, owner or existence is implied.
 */
export function viewLayout({ camera, provinces = [], route = [], marker = null }) {
  if (!camera || !Array.isArray(provinces) || provinces.length > 2 || !Array.isArray(route) || route.length > 128) throw new Error('BadMap');
  const known = new Map();
  for (const k of provinces) {
    const key = `${parseWideInt(k.p)},${parseWideInt(k.q)}`;
    if (known.has(key)) throw new Error('DuplicateProvince');
    known.set(key, k);
  }
  const R = camera.radius, cells = [], visible = new Map();
  for (let dp = -R; dp <= R; dp++) {
    for (let dq = Math.max(-R, -dp - R); dq <= Math.min(R, -dp + R); dq++) {
      const P = camera.centre.p + BigInt(dp), Q = camera.centre.q + BigInt(dq), key = `${P},${Q}`;
      const outside = !inBound(P, Q);
      const k = outside ? undefined : known.get(key);
      const state = outside ? 'outside' : k ? 'known' : 'unknown';
      const tiles = TILE_OFFSETS.map((_, tile) => Object.freeze({
        tile, ...pixel(tileHex(dp, dq, tile)),
        passable: state === 'known' && k.passableMask !== undefined ? !!(BigInt(k.passableMask) & (1n << BigInt(tile))) : null,
      }));
      cells.push(Object.freeze({ p: P.toString(), q: Q.toString(), key, state, label: formatCoord(P, Q), centre: pixel(provinceCentre(dp, dq)), tiles: Object.freeze(tiles) }));
      if (!outside) visible.set(key, { dp, dq });
    }
  }
  if (cells.length > VIEW_PROVINCES_MAX) throw new Error('ViewBound');
  const place = point => {
    const key = `${parseWideInt(point.p)},${parseWideInt(point.q)}`;
    if (!Number.isInteger(point.tile) || point.tile < 0 || point.tile >= TILE_OFFSETS.length) throw new Error('BadTile');
    const at = visible.get(key);
    return at ? pixel(tileHex(at.dp, at.dq, point.tile)) : null;
  };
  let offRoute = 0;
  const path = [];
  for (const point of route) {
    if (!known.has(`${parseWideInt(point.p)},${parseWideInt(point.q)}`)) throw new Error('UnknownRouteProvince');
    const pt = place(point);
    if (pt) path.push(pt); else offRoute++;
  }
  const markerPoint = marker?.place ? place(marker.place) : null;
  const xs = cells.flatMap(c => c.tiles.map(t => t.x)), ys = cells.flatMap(c => c.tiles.map(t => t.y));
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return Object.freeze({
    cells: Object.freeze(cells), path, pathComplete: offRoute === 0, offRoute, markerPoint,
    markerOffCamera: !!marker?.place && !markerPoint,
    counts: Object.freeze({ known: cells.filter(c => c.state === 'known').length, unknown: cells.filter(c => c.state === 'unknown').length, outside: cells.filter(c => c.state === 'outside').length }),
    bounds: [minX - 1.5, minY - 1.5, Math.max(...xs) - minX + 3, Math.max(...ys) - minY + 3],
  });
}

export function phaseMarker(state) {
  if (!state) return null;
  const origin = { ...state.map.origin, tile: state.host.originTile };
  const destination = { ...state.map.destination, tile: state.host.destinationTile };
  switch (state.phase) {
    case 'ready': return { place: origin, text: '出発元の部隊表' };
    case 'departed': return { place: origin, text: '出発元の消費決済待ち' };
    case 'travelling': return { place: null, text: '移動中：正確な現在タイルは表示しません' };
    case 'revealed': return { place: null, text: '命令公開済み・移動中：到着は未解決' };
    case 'resolved': return { place: destination, text: '到着解決済み：到着先の部隊表' };
    case 'settled': return { place: destination, text: '到着決済済み：到着先の部隊表' };
    case 'returned': return { place: { ...state.map.origin, tile: state.holding.tile }, text: '帰還兵を村の予備兵へ計上済み（再出撃した部隊ではありません）' };
    default: throw new Error('BadPhase');
  }
}

const hexPoints = (t, r) => Array.from({ length: 6 }, (_, i) => { const a = (i * 60 - 30) * Math.PI / 180; return `${t.x + r * Math.cos(a)},${t.y + r * Math.sin(a)}`; }).join(' ');

/**
 * Draws the bounded camera view into `container`. `camera` defaults to the village's province at radius 1.
 * Returns the layout's facts (counts, what lies off camera) for the page to state in words.
 */
export function renderLocalMap(container, model, marker = null, camera = null) {
  container.replaceChildren();
  if (!model) return null;
  const cam = camera ?? cameraAt(model.origin.p, model.origin.q, 1);
  const layout = viewLayout({ camera: cam, provinces: model.provinces, route: model.route, marker });
  const doc = container.ownerDocument, ns = 'http://www.w3.org/2000/svg';
  const node = (tag, attrs) => { const e = doc.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
  const titled = (el, text) => { const t = node('title', {}); t.textContent = text; el.append(t); return el; };
  const svg = node('svg', { viewBox: layout.bounds.join(' '), role: 'img', 'aria-label': `カメラ中心 ${formatCoord(cam.centre.p, cam.centre.q)}。ホストが返した州 ${layout.counts.known}、データなしの未知の州 ${layout.counts.unknown}、座標範囲外 ${layout.counts.outside}。チェーンの地図ではありません。` });
  for (const c of layout.cells) {
    if (c.state === 'known') {
      for (const t of c.tiles) svg.append(titled(node('polygon', { points: hexPoints(t, .94), fill: t.passable === false ? '#111a1d' : '#29464a', stroke: '#6d858e', 'stroke-width': .045 }), `${c.label} · tile ${t.tile}${t.passable === null ? '' : t.passable ? ' · passable' : ' · impassable'}`));
    } else {
      const g = titled(node('g', { class: `cell-${c.state}` }), c.state === 'unknown'
        ? `${c.label} · 未知（データなし）：このローカルホストはこの州を持たず、開かれた土地でも生成済みの土地でもありません。遊べません。`
        : `${c.label} · 座標範囲外（|P|,|Q| ≤ 2^62 の外）：州は存在できません。`);
      for (const t of c.tiles) g.append(node('polygon', { points: hexPoints(t, .9), fill: c.state === 'unknown' ? '#0c1315' : '#1a0d0d', stroke: c.state === 'unknown' ? '#33464d' : '#5a2a2a', 'stroke-width': .04, 'stroke-dasharray': '.15 .15' }));
      const mark = node('text', { x: c.centre.x, y: c.centre.y + .9, 'text-anchor': 'middle', 'font-size': 2.6, fill: c.state === 'unknown' ? '#5d7780' : '#8a4b4b' });
      mark.textContent = c.state === 'unknown' ? '?' : '×';
      g.append(mark);
      svg.append(g);
    }
  }
  if (layout.path.length > 1 && layout.pathComplete) svg.append(node('polyline', { points: layout.path.map(p => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: '#e6c56e', 'stroke-width': .24 }));
  for (const [i, p] of layout.path.entries()) svg.append(node('circle', { cx: p.x, cy: p.y, r: layout.pathComplete && (i === 0 || i === layout.path.length - 1) ? .4 : .12, fill: '#e6c56e' }));
  if (layout.markerPoint) svg.append(titled(node('circle', { cx: layout.markerPoint.x, cy: layout.markerPoint.y, r: .65, fill: 'none', stroke: '#e8ffff', 'stroke-width': .18 }), marker.text));
  container.append(svg);
  return layout;
}
