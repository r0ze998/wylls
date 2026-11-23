// What stands on the wide land (rings 129+) and what it is called (territory-video-2).
//
// The owner, on the territory recording of 2026-11-23: 「左側の色ついてるマップが意味わからんな」 — the wide land was a
// field of pastel hexagons in six nations' colours with nothing on it that said whose it was or why. Its colour IS the
// nation that holds the province's keep (map/wideland.mjs holderFill), but the keep itself was not drawn, nor the hosts
// that stand on the land, nor any name. A new player saw colour and nothing to read it by.
//
// This module draws, from the same captured province bytes the land is drawn from (the herald's capture, checked in
// map/widecapture.mjs; never a guess):
//   - the KEEP of each province: a fortress with its holder's standard on its tile (tile view), a small tower mark from
//     farther (province view) — the thing whose holder colours the land, so the colour has a visible owner;
//   - the HOSTS standing on the land (province entries in state ROSTER): one figure per tile in its nation's colour
//     (one figure per tile with the tile's total, as freeciv-web draws one unit and a stack mark, and Unciv keeps one
//     military slot per tile: the figures never pile on each other);
//   - a NAMEPLATE per province: 「アステルの土地」 / "Aster's land", 「あなたの国の土地」 / "Your nation's land", and while
//     another nation is taking the keep, who and how far (「ダンマールが奪取中 11/72」).
// Rendering only: nothing here decides, signs or sends. Under the fog (map/fog.mjs fogWideLand) a province remembered
// but not in sight keeps its last-known keep holder and shows no hosts and no contest (they are not seen).
import { project, RADIUS, FLATTEN } from '../../map.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { tileHex } from '../fgeo.mjs';
import { FACTION_COLORS, factionName } from '../fi18n.mjs';
import { KEEP_LOOK, paintKeepFortress, paintKeepMark } from './keeps.mjs';
import { FORTRESS } from './village.mjs';
import { paintStandard } from './ownland.mjs';
import { MINI_KINDS, paintMini } from '../people/minis.mjs';
import { paintBellTag } from './hostmarks.mjs';
import { cellsIn } from './wideland.mjs';

const nation = f => Number.isInteger(f) && f >= 0 && f < 6;

/** The least a standing host's figure is tall on screen (px), and its unit against a tile's corner radius. */
export const WIDE_HOST = Object.freeze({ unit: 0.62, minPx: 28 });

/** Where a keep's fortress stands on its tile (as map/keeps.mjs KeepBoard.place): `{x, y, cx, cy, u}` world px, or null. */
export function widekeepPlace(cell, zoom = 1) {
  const t = cell?.keep?.tile;
  if (!Number.isInteger(t)) return null;
  const h = tileHex(cell.p, cell.q, t);
  if (!h) return null;
  const c = project(h.q, h.r);
  return { x: c.x + KEEP_LOOK.at.x * RADIUS, y: c.y + KEEP_LOOK.at.y * RADIUS * FLATTEN, cx: c.x, cy: c.y, u: Math.max(RADIUS * KEEP_LOOK.unit, KEEP_LOOK.minPx / zoom) };
}

/**
 * The standing hosts of the cells in `seen`, one per tile (pure): `[{p, q, tile, x, y, faction, unit, troops, count}]`
 * — `faction`/`unit` the tile's strongest host's, `troops` the tile's total of that nation, `count` how many hosts of
 * any nation stand there. On a keep's tile the figure stands before its gate (a little right and forward).
 */
export function wideHostSpots(land, seen) {
  const out = [];
  for (const c of cellsIn(land, seen)) {
    const by = new Map();
    for (const h of c.hosts ?? []) {
      if (!Number.isInteger(h.tile)) continue;
      const s = by.get(h.tile) ?? { hosts: [] };
      s.hosts.push(h); by.set(h.tile, s);
    }
    for (const [tile, s] of by) {
      const hx = tileHex(c.p, c.q, tile);
      if (!hx) continue;
      const at = project(hx.q, hx.r), keepTile = c.keep?.tile === tile;
      const top = s.hosts.reduce((a, b) => (b.troops > a.troops ? b : a));
      const troops = s.hosts.filter(h => h.faction === top.faction).reduce((n, h) => n + (h.troops || 0), 0);
      out.push({ p: c.p, q: c.q, tile, x: at.x + (keepTile ? RADIUS * 0.34 : 0), y: at.y + (keepTile ? RADIUS * 0.22 : RADIUS * 0.12), faction: top.faction, unit: top.unit, troops, count: s.hosts.length });
    }
  }
  return out.sort((a, b) => a.y - b.y);
}

/**
 * Paints the keeps and the standing hosts of the wide land in `seen` (world px; `ctx` in the map's world transform).
 * `level` map/wideland.mjs wideLevel's; `stand(x, y, fn)` stands a figure upright on a tilted board (map/tilt.mjs
 * standing); `viewer` the viewer's nation. → `{keeps, hosts}` (what was drawn).
 */
export function paintWideMarks(ctx, land, { seen, zoom = 1, level = 'tile', viewer = null, dpr = 1, now = 0, still = true, stand = (x, y, fn) => fn() } = {}) {
  if (!ctx?.save || !land?.cells?.length || level === 'chart' || level === 'world') return { keeps: 0, hosts: 0 };
  let keeps = 0, hosts = 0;
  const cells = cellsIn(land, seen).map(c => ({ c, P: widekeepPlace(c, zoom) })).filter(x => x.P).sort((a, b) => a.P.y - b.P.y);
  for (const { c, P } of cells) {
    const holder = nation(c.holder) ? c.holder : null, mine = holder !== null && holder === viewer;
    if (level === 'province') { paintKeepMark(ctx, P.cx, P.cy, { zoom, faction: holder, mine }); keeps++; continue; }
    stand(P.x, P.y, () => {
      paintKeepFortress(ctx, P.x, P.y, P.u, { faction: holder, mine, zoom, dpr });
      if (holder !== null) paintStandard(ctx, P.x + FORTRESS.pole.x * P.u, P.y - FORTRESS.pole.up * P.u, { u: P.u * KEEP_LOOK.standard, zoom, faction: holder, now, still });
    });
    keeps++;
  }
  if (level !== 'tile') return { keeps, hosts };
  const s = Math.max(RADIUS * WIDE_HOST.unit, WIDE_HOST.minPx / Math.max(zoom, 1e-9) / 1.5);
  for (const h of wideHostSpots(land, seen)) {
    stand(h.x, h.y, () => paintMini(ctx, h.x, h.y, s, MINI_KINDS[h.unit] ?? MINI_KINDS[0], { faction: h.faction, face: -1, own: h.faction === viewer }));
    hosts++;
  }
  return { keeps, hosts };
}

/** The words of a province's plate: `{name, sub}` (sub null when its keep is not being taken). */
export function wideProvinceWords(cell, viewer = null) {
  const h = nation(cell?.holder) ? cell.holder : null;
  const name = h === null ? L`どの国のものでもない土地` : h === viewer ? L`あなたの国の土地` : L`${factionName(h)}の土地`;
  const k = cell?.keep;
  const sub = k && nation(k.contender) && k.contender !== h && Number.isInteger(k.progress) && k.required > 0
    ? (k.contender === viewer ? L`あなたの国が砦を奪取中 ${fmtNum(k.progress)}/${fmtNum(k.required)} ターン` : L`${factionName(k.contender)}が砦を奪取中 ${fmtNum(k.progress)}/${fmtNum(k.required)} ターン`)
    : null;
  return { name, sub };
}

/**
 * The words over the wide land (`o` the label canvas in the map's world transform, `pass` map/labelpass.mjs): one plate
 * per province in `seen` saying whose land it is (over its keep, or its middle), and under each standing host's figure
 * its troops. Plates give way to anything placed before them (`pass`: they are never kept over another label).
 * → the number of plates drawn.
 */
export function paintWideNames(o, land, { seen, zoom = 1, level = 'tile', viewer = null, pass = null } = {}) {
  if (!o?.save || !land?.cells?.length || (level !== 'tile' && level !== 'province')) return 0;
  let n = 0;
  if (level === 'tile') for (const h of wideHostSpots(land, seen)) {
    const text = h.count > 1 ? L`兵 ${fmtNum(h.troops)} ほか` : L`兵 ${fmtNum(h.troops)}`;
    paintBellTag(o, h.x, h.y + RADIUS * 0.08, text, { zoom, place: 'below', gap: 2, accent: FACTION_COLORS[h.faction] ?? '#c9a24a', anchor: { x: h.x, y: h.y }, pass, size: 11, spare: true });
  }
  for (const c of cellsIn(land, seen)) {
    const P = widekeepPlace(c, zoom), w = wideProvinceWords(c, viewer);
    const accent = FACTION_COLORS[c.holder] ?? '#8b856d';
    // (over the fortress at the tile view; at the province's middle from farther, where the keep is only a mark)
    const at = level === 'tile' && P ? { x: P.x, y: P.y - P.u * 1.9 } : { x: c.x, y: c.y - RADIUS * 1.2 };
    if (paintBellTag(o, at.x, at.y, w.name, { zoom, place: 'above', gap: 2, accent, anchor: at, pass, size: level === 'tile' ? 13 : 12, spare: true })) n++;
    if (w.sub) paintBellTag(o, at.x, at.y, w.sub, { zoom, place: 'below', gap: 2, accent: FACTION_COLORS[c.keep.contender] ?? accent, anchor: at, pass, size: 11.5, spare: true });
  }
  return n;
}
