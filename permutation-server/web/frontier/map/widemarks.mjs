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
//   - a NAMEPLATE: 「アステルの土地」 / "Lands of Aster", 「あなたの国の土地」 / "Your nation's land" — (territory-video-3) one
//     per nation in the view, on its largest region, and only where provinces are PLATE_MIN_PX across on screen (it was
//     one per province: the same name two or four times over) — and while another nation is taking a keep, who and how
//     far, at that keep (「ダンマールが奪取中 11/72」); a standing host of another nation names it (「アステル · 兵 300」).
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
import { cellsIn, NEUTRAL } from './wideland.mjs';
import { PROVINCE_CIRCUMRADIUS } from './layers.mjs';

const nation = f => Number.isInteger(f) && f >= 0 && f < 6;

/** The least a province is across on screen (CSS px) for the wide land's names to stand on it (territory-video-3). */
export const PLATE_MIN_PX = 150;
/** How far inside the view (a share of its width and height) a province's plate must stand to be drawn. */
export const PLATE_INSET = 0.06;
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

/** The words of a province's plate: `{name, sub}` (sub null when its keep is not being taken; both null when the fog
 *  does not know whose it is). */
export function wideProvinceWords(cell, viewer = null) {
  // (verify-pr197: under the fog a province whose holder was never seen says nothing — not 「どの国のものでもない土地」)
  if (cell?.holderKnown === false) return { name: null, sub: null };
  const h = nation(cell?.holder) ? cell.holder : null;
  // (territory-map, owner 2026-11-25 OQ-3: the land is the tiles players own; a province's holder is its KEEP's — the
  //  plate over the keep says whose keep it is, not "whose land", which read wrong over a player's own tiles in it)
  const name = h === null ? L`砦：どの国のものでもない` : h === viewer ? L`砦：あなたの国` : L`砦：${factionName(h)}`;
  const k = cell?.keep;
  const sub = k && nation(k.contender) && k.contender !== h && Number.isInteger(k.progress) && k.required > 0
    ? (k.contender === viewer ? L`あなたの国が砦を奪取中 ${fmtNum(k.progress)}/${fmtNum(k.required)} ターン` : L`${factionName(k.contender)}が砦を奪取中 ${fmtNum(k.progress)}/${fmtNum(k.required)} ターン`)
    : null;
  return { name, sub };
}

/**
 * The words under a standing host's figure (territory-video-3, owner: an army on the land said only 「兵 300」 — whose?):
 * another nation's host says its nation, 「アステル · 兵 300」 / "Aster · 300 troops"; the viewer's own says its troops.
 */
export function wideHostWords(spot, viewer = null) {
  const n = fmtNum(spot?.troops ?? 0), more = (spot?.count ?? 1) > 1;
  if (!nation(spot?.faction) || spot.faction === viewer) return more ? L`兵 ${n} ほか` : L`兵 ${n}`;
  const who = factionName(spot.faction);
  return more ? L`${who} · 兵 ${n} ほか` : L`${who} · 兵 ${n}`;
}

const STEPS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
/**
 * The regions of the wide land in `seen` (territory-video-3): each run of neighbouring provinces with one known holder
 * (a nation, or NEUTRAL for no nation's) → `[{holder, cells}]`, largest first. A province the fog never saw the holder of
 * is in none. One region carries one name (two provinces of Aster side by side read 「アステルの土地」 twice before).
 */
export function wideRegions(land, seen) {
  const cells = cellsIn(land, seen).filter(c => c.holderKnown !== false);
  const here = new Map(cells.map(c => [c.key, c])), done = new Set(), out = [];
  const holderOf = c => (nation(c.holder) ? c.holder : NEUTRAL);
  for (const c of cells) {
    if (done.has(c.key)) continue;
    const h = holderOf(c), group = [], todo = [c];
    done.add(c.key);
    while (todo.length) {
      const x = todo.pop();
      group.push(x);
      for (const [dp, dq] of STEPS) {
        const n = here.get(`${x.p + dp},${x.q + dq}`);
        if (n && !done.has(n.key) && holderOf(n) === h) { done.add(n.key); todo.push(n); }
      }
    }
    out.push({ holder: h, cells: group });
  }
  return out.sort((a, b) => b.cells.length - a.cells.length || a.holder - b.holder);
}

/**
 * The words over the wide land (`o` the label canvas in the map's world transform, `pass` map/labelpass.mjs): one plate
 * per REGION in `seen` saying whose land it is (over the keep of its province nearest the region's middle that stands
 * well inside the picture), each keep being taken its own line, and under each standing host's figure its nation and
 * troops. Plates give way to anything placed before them (`pass`: they are never kept over another label).
 * → the number of plates drawn.
 */
export function paintWideNames(o, land, { seen, zoom = 1, level = 'tile', viewer = null, pass = null, screen = null, bounds = null } = {}) {
  if (!o?.save || !land?.cells?.length || (level !== 'tile' && level !== 'province')) return 0;
  let n = 0;
  if (level === 'tile') for (const h of wideHostSpots(land, seen)) {
    const text = wideHostWords(h, viewer);
    paintBellTag(o, h.x, h.y + RADIUS * 0.08, text, { zoom, place: 'below', gap: 2, accent: FACTION_COLORS[h.faction] ?? '#c9a24a', anchor: { x: h.x, y: h.y }, pass, size: 11, spare: true });
  }
  // (a plate stands only where its place is well inside the picture: the label pass slides a label whose place is near
  //  the edge back into the picture, and a province below the top bar had its name stand beside the turn dial)
  // (verify-pr197: on a tilted board `seen` is the ground canvas's flat box, larger than the picture — a plate stood cut
  //  by the left edge of the screen over the cloud and under the turn dial. With `screen(x, y)` (px in the picture) and
  //  `bounds` {w, h} the test is made where the person sees the place)
  const mx = (seen.x1 - seen.x0) * PLATE_INSET, my = (seen.y1 - seen.y0) * PLATE_INSET;
  const inner = screen && bounds?.w > 0 && bounds?.h > 0
    ? p => { const s = screen(p.x, p.y), ix = bounds.w * PLATE_INSET, iy = bounds.h * PLATE_INSET; return !!s && s.x > ix && s.x < bounds.w - ix && s.y > iy * 1.6 && s.y < bounds.h - iy; }
    : p => p.x > seen.x0 + mx && p.x < seen.x1 - mx && p.y > seen.y0 + my * 1.6 && p.y < seen.y1 - my;
  // (over the fortress at the tile view; at the province's middle from farther, where the keep is only a mark)
  const placeOf = c => { const P = widekeepPlace(c, zoom); return level === 'tile' && P ? { x: P.x, y: P.y - P.u * 1.9 } : { x: c.x, y: c.y - RADIUS * 1.2 }; };
  const named = new Set(), plated = new Set();
  // (territory-video-3, live at the province view: a province a few dozen px across carried a plate, nine plates over
  //  eleven provinces. A plate stands only where a province is at least PLATE_MIN_PX across on screen, and one a nation
  //  in the view — on its largest region; the legend (map/widelegend.mjs) names every colour drawn)
  const big = 2 * PROVINCE_CIRCUMRADIUS * zoom >= PLATE_MIN_PX;
  for (const r of big ? wideRegions(land, seen) : []) {
    if (plated.has(r.holder)) continue;
    const mx = r.cells.reduce((a, c) => a + c.x, 0) / r.cells.length, my = r.cells.reduce((a, c) => a + c.y, 0) / r.cells.length;
    const pick = r.cells.map(c => ({ c, at: placeOf(c) })).filter(x => inner(x.at)).sort((a, b) => Math.hypot(a.c.x - mx, a.c.y - my) - Math.hypot(b.c.x - mx, b.c.y - my))[0];
    if (!pick) continue;
    const w = wideProvinceWords(pick.c, viewer);
    if (!w.name) continue;
    const accent = FACTION_COLORS[pick.c.holder] ?? '#8b856d';
    plated.add(r.holder);
    if (paintBellTag(o, pick.at.x, pick.at.y, w.name, { zoom, place: 'above', gap: 2, accent, anchor: pick.at, pass, size: level === 'tile' ? 13 : 12, spare: true })) { n++; named.add(pick.c.key); }
  }
  // (each keep being taken says who and how far, at its own keep: under the region's name when the name stands there)
  for (const c of cellsIn(land, seen)) {
    const w = wideProvinceWords(c, viewer), at = placeOf(c);
    if (!w.sub || !inner(at)) continue;
    paintBellTag(o, at.x, at.y, w.sub, { zoom, place: named.has(c.key) ? 'below' : 'above', gap: 2, accent: FACTION_COLORS[c.keep.contender] ?? '#8b856d', anchor: at, pass, size: 11.5, spare: true });
  }
  return n;
}
