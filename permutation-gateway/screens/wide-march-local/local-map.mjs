// Display geometry only. No pathfinding, economy, combat, clock or lifecycle rules.
import { originAt, parseWideInt, relativeTo, formatCoord } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { TILE_OFFSETS, tileHex } from '../../../permutation-server/web/frontier/fgeo.mjs';

export function localTilePoint(origin, place) {
  const p = parseWideInt(place.p), q = parseWideInt(place.q);
  if (!Number.isInteger(place.tile) || place.tile < 0 || place.tile >= TILE_OFFSETS.length) throw new Error('BadTile');
  const offset = relativeTo(origin, p, q);
  if (!offset) throw new Error('OutsideCamera');
  const h = tileHex(offset.dp, offset.dq, place.tile);
  return Object.freeze({ x: Math.sqrt(3) * (h.q + h.r / 2), y: 1.5 * h.r, label: `${formatCoord(p, q)} · tile ${place.tile}` });
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

export function renderLocalMap(container, model, marker = null) {
  container.replaceChildren();
  if (!model) return;
  const layout = mapLayout(model), doc = container.ownerDocument, ns = 'http://www.w3.org/2000/svg';
  const node = (tag, attrs) => { const e = doc.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
  const svg = node('svg', { viewBox: layout.bounds.join(' '), role: 'img', 'aria-label': 'ローカルホストの州・タイルと固定経路。チェーンの地図ではありません。' });
  for (const t of layout.tiles) {
    const points = Array.from({ length: 6 }, (_, i) => { const a = (i * 60 - 30) * Math.PI / 180; return `${t.x + .94 * Math.cos(a)},${t.y + .94 * Math.sin(a)}`; }).join(' ');
    const hex = node('polygon', { points, fill: t.passable === false ? '#111a1d' : '#29464a', stroke: '#6d858e', 'stroke-width': .045 });
    const title = node('title', {}); title.textContent = `${t.label}${t.passable === null ? '' : t.passable ? ' · passable' : ' · impassable'}`; hex.append(title); svg.append(hex);
  }
  if (layout.path.length > 1) svg.append(node('polyline', { points: layout.path.map(p => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: '#e6c56e', 'stroke-width': .24 }));
  for (const [i, p] of layout.path.entries()) svg.append(node('circle', { cx: p.x, cy: p.y, r: i === 0 || i === layout.path.length - 1 ? .4 : .12, fill: '#e6c56e' }));
  if (marker?.place) {
    const p = localTilePoint(originAt(model.origin.p, model.origin.q), marker.place);
    const circle = node('circle', { cx:p.x, cy:p.y, r:.65, fill:'none', stroke:'#e8ffff', 'stroke-width':.18 });
    const title = node('title', {}); title.textContent=marker.text; circle.append(title); svg.append(circle);
  }
  container.append(svg);
}
