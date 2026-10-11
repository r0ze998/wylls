// Picking a tile on the board for an order (UX design 14.2: "select a thing,
// act on the board"). The page gives the map a set of tiles a rule allows
// (every passable tile of the home province for a muster, the tiles next to a
// Scout for an exploration); the map lights them as ONE shape in the kind's
// colour (the reach's style, UX design 11.7: the outer contour, a light just
// inside it, everything outside a little darker; only the tile under the
// pointer shows a hexagon of its own), says what the tap will do on a tag,
// and answers with the tile that was tapped.
//
// This file is the model: the lit set in the shape the reach's painters take
// (map/actions.mjs), the colours by kind, and the keyboard's step from tile
// to tile. The map (map/fmap.mjs pickTile) holds the promise and the pointer.
// Which tiles are allowed is never decided here: the caller reads the rules.
import { project } from '../../map.mjs';
import { hexDistance, locate, tileHex } from '../fgeo.mjs';
import { ACTION_COLOURS } from './actions.mjs';

const int = Number.isInteger;
/**
 * The colours of a pick by kind (`fill` and the brighter `rim`, as map/actions.mjs ACTION_COLOURS):
 *   muster   gold-teal: where a new host may be formed (neither the reach's pale teal nor the gold of "yours")
 *   explore  sky blue: the tiles a Scout may explore (the colour of an exploration everywhere)
 *   move     the reach's own pale teal, for any other pick
 */
export const PICK_KINDS = Object.freeze({
  muster: Object.freeze({ fill: [206, 226, 150], rim: [222, 238, 150] }),
  explore: Object.freeze({ fill: [127, 196, 232], rim: [186, 228, 252] }),
  move: ACTION_COLOURS.move,
});
/** The palette the reach's painters take for a pick of `kind`: the contour in the kind's colour, a chosen tile's own hexagon in it too. */
export function pickPalette(kind) {
  const c = PICK_KINDS[kind] ?? PICK_KINDS.move;
  return { ...ACTION_COLOURS, move: c, explore: { ...c, veil: 0.36 } };
}

/** A tile as the caller may give it (`{p, q, tile}` or `{q, r}` axial) → `{p, q, tile, hq, hr}`, or null. */
export function pickTileOf(t) {
  if (!t) return null;
  if (int(t.p) && int(t.q) && int(t.tile)) { const h = tileHex(t.p, t.q, t.tile); return h ? { p: t.p, q: t.q, tile: t.tile, hq: h.q, hr: h.r } : null; }
  const q = t.hq ?? t.q, r = t.hr ?? t.r;
  if (!int(q) || !int(r)) return null;
  const at = locate(q, r);
  return { p: at.p, q: at.q, tile: at.idx, hq: q, hr: r };
}

/**
 * The lit set of a pick, in the shape of the reach's model (map/actions.mjs): `{mode: 'pick', kind, tiles: [{p, q,
 * tile, hq, hr, d, kind, lv}], byHex: Map "q,r" → tile, hex (the tile the set rolls out from, or null), t0, max,
 * label, chosen: [tile index], picked: [{p, q, tile}]}`.
 *   tiles    the tiles a rule allows (the caller's)
 *   origin   `{p, q, tile}` the light spreads from (the village, the Scout); it is part of the shape and is not
 *            itself a tile to pick unless it is also in `tiles`. Without one: the tile nearest the set's middle
 *   picked   the tiles taken so far (a pick of more than one): each shows a hexagon of its own with a tick
 */
export function pickModel({ kind = 'move', tiles = [], origin = null, max = 1, label = '', t0 = 0, picked = [], levelOf = () => 3 } = {}) {
  const list = [], byHex = new Map();
  for (const raw of tiles) { const t = pickTileOf(raw); if (!t || byHex.has(`${t.hq},${t.hr}`)) continue; byHex.set(`${t.hq},${t.hr}`, t); list.push(t); }
  let o = pickTileOf(origin);
  if (!o && list.length) {
    const cq = list.reduce((a, t) => a + t.hq, 0) / list.length, cr = list.reduce((a, t) => a + t.hr, 0) / list.length;
    o = list.reduce((a, t) => (Math.hypot(t.hq - cq, t.hr - cr) < Math.hypot(a.hq - cq, a.hr - cr) ? t : a));
  }
  const took = new Set(picked.map(pickTileOf).filter(Boolean).map(t => `${t.hq},${t.hr}`));
  for (const t of list) {
    t.d = o ? hexDistance(o.hq, o.hr, t.hq, t.hr) : 0;
    t.lv = levelOf(t.p, t.q, t.tile);
    t.kind = took.has(`${t.hq},${t.hr}`) ? 'explore' : 'move';
  }
  // (a model with an origin that is not one of the tiles: the reach's shape takes the origin in, as it does a host's own tile)
  const inSet = o && byHex.has(`${o.hq},${o.hr}`);
  return { mode: 'pick', kind: PICK_KINDS[kind] ? kind : 'move', tiles: list, byHex, hex: o && !inSet ? { q: o.hq, r: o.hr } : null, origin: o ? { p: o.p, q: o.q, tile: o.tile } : null, t0, max: Math.max(1, max | 0),
    label: String(label ?? ''), chosen: list.filter(t => t.kind === 'explore').map(t => t.tile), picked: list.filter(t => t.kind === 'explore').map(t => ({ p: t.p, q: t.q, tile: t.tile })) };
}

/**
 * The keyboard's step through a lit set: from hex `from` (`{q, r}` or null) one step toward `dir` ('left', 'right',
 * 'up', 'down' as the board is seen) to the lit tile that lies most nearly that way and nearest; with no `from`,
 * the tile nearest the set's origin. Returns the tile, or null when none lies that way.
 */
export function pickStep(model, from, dir) {
  const list = model?.tiles ?? [];
  if (!list.length) return null;
  if (!from || !int(from.q) || !int(from.r)) return [...list].sort((a, b) => a.d - b.d || a.hr - b.hr || a.hq - b.hq)[0];
  const v = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
  if (!v) return null;
  const c = project(from.q, from.r);
  let best = null, score = Infinity;
  for (const t of list) {
    if (t.hq === from.q && t.hr === from.r) continue;
    const p = project(t.hq, t.hr), dx = p.x - c.x, dy = p.y - c.y, len = Math.hypot(dx, dy);
    const along = dx * v[0] + dy * v[1];
    if (!(along > len * 0.35)) continue;   // within about 70° of the way asked for
    const s = len * (1 + 1.6 * (1 - along / len));
    if (s < score) { score = s; best = t; }
  }
  return best;
}
