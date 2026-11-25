// The wide land (rings 129 and beyond) on the ORDINARY map and its world chart
// 「全体図」: the provinces the herald's fold captured (`/h/world/wide`, read
// through map/wide.mjs exactly as the 「記録」 sheet reads them), drawn where they
// lie, around the heartland, with their terrain and their keep's nation.
//
// Rendering only. Nothing here decides who may settle or march on the wide
// land (that rule is the program's), nothing is signed or sent, and a place
// that is not in the record is not drawn as land (it stays under the cloud:
// unknown, never "open" and never "closed").
//
// Where the terrain comes from: a wide province account is the whole Province
// v2 layout plus a 128-byte trailer (frontier-abi world_index/land.rs). The
// program writes its terrain at open (`encode_terrain` over the wide kernel's
// terrain), so the captured bytes carry it: TERRAIN @128 (61 tiles), SITES @250,
// SITE_COUNT @262, PASSABLE_MASK @264. They are read from the capture the page
// parser already checked (map/widecapture.mjs: magic, season, world, key,
// summary); the client never regenerates wide terrain.
//
// Levels of detail (the ordinary map's own: map/fmap.mjs coarseChart / lod):
//  - chart and world: one cell per province in the mean colour of its terrain, cells batched per colour, at most PATH_CHUNK a
//    path (as fmap.mjs paintChartCells does), and the wide land's outer edge;
//  - province: each cell in the mean colour of its terrain, the outer edge;
//  - tile: the 61 tiles in their terrain colours, the outer edge.
//  (territory-map, owner 2026-11-25 OQ-3: a province is no longer coloured, washed or bordered by its keep's nation — the
//  tiles players own are, map/territorytiles.mjs, over this land and under the villages' marks (`overLand`); who holds a
//  province is its keep's icon. Before: territory-video-3's nation border round the union of the keep-held provinces.)
// Villages (verify-pr88): every captured wide Holding of a province (`e.wide.holdings`, the herald's own capture of the
// PSFXWHL1 account: a v2 Holding plus a trailer, so its nation is Holding.FACTION @112) is drawn as its nation's sigil
// — on its own site at the tile view (layers.mjs paintTiles' `rec`, as a legacy province's settled sites), and from
// farther as one sigil at the province's centre (its first village's nation), so a new wide village is seen on the map
// and on 「全体図」 as soon as the herald records it.
// Only the provinces whose box meets the view are visited, so the cost follows what is on screen.
//
// Precision (no centre assumption): a captured coordinate is a BigInt. The ordinary map lays provinces out in
// plain numbers, so a province is placed only when |P| and |Q| are within MAP_LIMIT (the legacy map's own i16
// range); the rest are counted as `far` and left to the 「記録」 sheet, which keeps a BigInt origin.
import { fromBase64 } from '../../sdk/bytes.mjs';
import { COLORS } from '../../map.mjs';
import { TERRAIN } from '../wasm.mjs';
import { L } from '../../lang.mjs';
import { NATION_LAND, NATION_DARK } from '../palette.mjs';
import { provinceCorners, provincePixel, PROVINCE_CIRCUMRADIUS, paintTiles, paintSigil } from './layers.mjs';
import { loadWide, WideWalk, sourcePins } from './wide.mjs';

/** The legacy map's coordinate range: a wide province further than this from (0, 0) is left to the 「記録」 sheet. */
export const MAP_LIMIT = 32767;
/** Seconds between manifest polls (the 「記録」 sheet's own WIDE_POLL_S): a new snapshot reloads the land. */
export const POLL_S = 30;
/** Seconds before a herald that serves no recorded world is asked again (a local world may start serving it later). */
export const RETRY_S = 300;
/** The keep holder that is no nation (frontier-abi world CONTROLLER_NEUTRAL). */
export const NEUTRAL = 6;
/** The fill of a province whose keep no nation holds. */
export const NEUTRAL_LAND = '#b9b29a';
/**
 * The least a province is drawn on screen (CSS px across its corners): from far (the chart 「全体図」 and the world view)
 * a province of the wide land is a few pixels or less, so each is drawn as a hexagon of at least this size about its own
 * centre (neighbours then overlap into one mosaic of the nations' colours), ringed in ink so the land reads on the sheet.
 */
export const MIN_CELL_PX = 14;
/** How strongly the nation's colour lies over the land, by level of detail. */
export const WASH = Object.freeze({ chart: 0.92, world: 0.86, province: 0.55, tile: 0.3 });

// the Province v2 offsets (frontier-abi v2/layout/province.rs) of what the map draws
const TERRAIN_AT = 128, TILES = 61, SITES_AT = 250, SITE_COUNT_AT = 262, PASSABLE_AT = 264;
// the Holding v2 offset of its nation (frontier-abi v2/layout/player.rs holding FACTION @ 112) and the wide holding's size
const HOLDING_FACTION_AT = 112, WIDE_HOLDING_BYTES = 1344;

/** A captured wide Holding's nation (0–5), or null when its bytes are not a whole wide holding or name no nation. */
export function villageNation(h) {
  let b;
  try { b = fromBase64(h?.capture?.bytes_b64); } catch { return null; }
  if (!(b instanceof Uint8Array) || b.length !== WIDE_HOLDING_BYTES) return null;
  const f = b[HOLDING_FACTION_AT];
  return f < 6 ? f : null;
}
// (territory-map) the wide Holding's owner: OWNER_CITIZEN @72 (frontier-abi v2/layout/player.rs holding)
const HOLDING_OWNER_AT = 72;
/**
 * (territory-map) A captured wide Holding's owner as the territory records name one: `{tag, nation}` (the Citizen tag =
 * OWNER_CITIZEN's first 8 bytes, little-endian, as a decimal string; FACTION @112), or null (not a whole wide holding,
 * no owner, no nation). map/territorytiles.mjs reads a tile owner's nation from it.
 */
export function villageOwner(h) {
  let b;
  try { b = fromBase64(h?.capture?.bytes_b64); } catch { return null; }
  if (!(b instanceof Uint8Array) || b.length !== WIDE_HOLDING_BYTES) return null;
  const tag = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(HOLDING_OWNER_AT, true), f = b[HOLDING_FACTION_AT];
  return tag === 0n || !(f < 6) ? null : { tag: tag.toString(), nation: f };
}
/** The villages of a wide province record: `[{site, nation}]` (site 0–11, nation 0–5 or null), in site order. */
export function villagesOf(holdings) {
  return (Array.isArray(holdings) ? holdings : []).filter(h => Number.isInteger(h?.site) && h.site >= 0 && h.site < 12)
    .map(h => ({ site: h.site, nation: villageNation(h) })).sort((a, b) => a.site - b.site);
}
/** paintTiles' `rec` for a province's villages: a settled site (1) and its nation as owner (7 = none). */
export function villageRec(villages) {
  const sites = Array(12).fill(0), owners = Array(12).fill(7);
  for (const v of villages) if (v.nation !== null) { sites[v.site] = 1; owners[v.site] = v.nation; }
  return { sites, owners };
}

/** The terrain block of a captured wide province (`bytes_b64`, 4,864 bytes) → `{terrain, sites, names, passable}`, or null. */
export function terrainOfCapture(b64) {
  let b;
  try { b = fromBase64(b64); } catch { return null; }
  if (!(b instanceof Uint8Array) || b.length !== 4864) return null;
  const terrain = Array.from(b.subarray(TERRAIN_AT, TERRAIN_AT + TILES));
  if (terrain.some(t => t >= TERRAIN.length)) return null;
  const n = Math.min(12, b[SITE_COUNT_AT]);
  const sites = Array.from(b.subarray(SITES_AT, SITES_AT + n));
  if (sites.some(s => s >= TILES)) return null;
  const passable = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(PASSABLE_AT, true);
  return { terrain, sites, names: TERRAIN, passable };
}

// the Province v2 entries and keep (frontier-abi v2/layout/province.rs ENTRIES @1064 x56 of 48 bytes, KEEP @4480)
const ENTRIES_AT = 1064, ENTRY_BYTES = 48, ENTRIES_N = 56, KEEP_AT = 4480, NO_TILE = 0xff, ROSTER = 1;
/**
 * The keep and the standing hosts of a captured wide province (`bytes_b64`, 4,864 bytes) →
 * `{keep: {tile, holder, contender, progress, required, troops, changes} | null, hosts: [{faction, unit, tile, troops}]}`, or null.
 * A host is an entry in state ROSTER (1: standing on the land; 2 mustering and 3 departed are not on a tile). A
 * `contender` of 0xFF is none (null here).
 */
/**
 * A territory world's facts of one wide province capture (verify-pr206-209: the page's tile card): `{siteTiles,
 * keepTile}` when the trailer's territory byte (4,736 + 53) is 1 (frontier-abi world_index/land.rs territory_rule_of;
 * site tiles Province v2 SITES @250, SITE_COUNT @262; the keep's tile @4480), else null.
 */
export function territoryOfCapture(b64) {
  try {
    if (typeof b64 !== 'string') return null;
    const b = fromBase64(b64);
    if (b.length !== 4864 || b[4789] !== 1) return null;
    return Object.freeze({ siteTiles: Object.freeze(Array.from(b.subarray(250, 250 + Math.min(b[262], 12)))), keepTile: b[4480] });
  } catch { return null; }
}

export function keepAndHostsOfCapture(b64) {
  let b;
  try { b = fromBase64(b64); } catch { return null; }
  if (!(b instanceof Uint8Array) || b.length !== 4864) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), hosts = [];
  for (let i = 0; i < ENTRIES_N; i++) {
    const o = ENTRIES_AT + i * ENTRY_BYTES;
    if (b[o + 11] !== ROSTER || b[o + 10] >= TILES || b[o + 8] > 5) continue;
    // (an entry's TROOPS are in thousandths of a soldier — the arrival's troops_milli; a keep's TROOPS are whole)
    hosts.push({ faction: b[o + 8], unit: b[o + 9], tile: b[o + 10], troops: Math.floor(v.getUint32(o + 12, true) / 1000) });
  }
  const k = KEEP_AT, keep = b[k] === NO_TILE || b[k] >= TILES ? null
    : { tile: b[k], holder: b[k + 1], contender: b[k + 2] === 0xff ? null : b[k + 2], progress: b[k + 3], required: b[k + 4], troops: v.getUint32(k + 8, true), changes: v.getUint16(k + 6, true) };
  return { keep, hosts };
}

const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgbHex = c => `#${c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
/** The mean colour of a province's tiles (its look from afar). */
export function meanColour(terrain) {
  const sum = [0, 0, 0];
  for (const t of terrain) { const c = hexRgb((COLORS[TERRAIN[t]] ?? COLORS.Plains)[0]); sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; }
  return rgbHex(sum.map(v => v / Math.max(1, terrain.length)));
}

/** A nation's land colour for keep holder `h` (0–5), else the neutral land. */
export const holderFill = h => (Number.isInteger(h) && h >= 0 && h < 6 ? NATION_LAND[h] : NEUTRAL_LAND);
/** The ink of a border on a nation's side. */
export const holderInk = h => (Number.isInteger(h) && h >= 0 && h < 6 ? NATION_DARK[h] : '#5d5848');

// the six lattice neighbours of a province, in the order of provinceCorners' edges is not assumed: borders are found
// by the shared corner pair, which needs no orientation
const NEIGHBOURS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/**
 * The wide land from a finished WideWalk (map/wide.mjs): `{cells, byKey, rings: {min, max}, reach, far, count, key}`.
 * A cell is `{p, q, key, ring, wedge, holder, terrain, keep, hosts, colour, x, y, box}` for every OPEN captured wide province
 * (ring > 128, a checked capture) within MAP_LIMIT; legacy records (rings ≤ 128) are the ordinary map's own and are
 * skipped. `reach` is the ring count the camera and the sheet must cover (max ring + 1), `far` the provinces past
 * MAP_LIMIT. `edges`: for each cell, the borders to draw — `{a, b, inner}` corner pairs; `inner` false is the wide
 * land's outer edge (no recorded wide province beyond it), true a border between two keep nations.
 */
export function wideLandOf(walk) {
  const cells = [], byKey = new Map();
  let far = 0, min = null, max = null;
  for (const e of walk?.entries?.values?.() ?? []) {
    if (e.state !== 'open' || !e.wide || e.ring <= 128n) continue;
    const lim = BigInt(MAP_LIMIT);
    if (e.p > lim || e.p < -lim || e.q > lim || e.q < -lim) { far++; continue; }
    const p = Number(e.p), q = Number(e.q), ring = Number(e.ring);
    const t = terrainOfCapture(e.wide.capture?.bytes_b64), kh = keepAndHostsOfCapture(e.wide.capture?.bytes_b64);
    const c = provincePixel(p, q), r = PROVINCE_CIRCUMRADIUS;
    const cell = { p, q, key: `${p},${q}`, ring, wedge: e.wedge, holder: e.wide.keepHolder, holdings: e.wide.holdings?.length ?? 0, villages: villagesOf(e.wide.holdings), terrain: t,
      owners: (Array.isArray(e.wide.holdings) ? e.wide.holdings : []).map(villageOwner).filter(Boolean),
      keep: kh?.keep ?? null, hosts: kh?.hosts ?? [], territory: territoryOfCapture(e.wide.capture?.bytes_b64),
      colour: t ? meanColour(t.terrain) : NEUTRAL_LAND, x: c.x, y: c.y, box: { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r } };
    cells.push(cell); byKey.set(cell.key, cell);
    min = min === null ? ring : Math.min(min, ring); max = max === null ? ring : Math.max(max, ring);
  }
  bordersOf(cells, byKey);
  return Object.freeze({ cells, byKey, rings: { min, max }, reach: max === null ? 0 : max + 1, far, count: cells.length,
    key: `${walk?.world ?? ''}|${walk?.snapshot?.epoch ?? ''}|${walk?.snapshot?.stamp ?? ''}|${cells.length}` });
}

/**
 * The same land with only `cells` (copies of some of `land`'s cells, holders possibly changed: the fog of war of a local
 * test world, map/fog.mjs), its borders drawn again. `reach` and `rings` stay the whole land's (the camera's extent is
 * not a secret: the wide land's rings are in the season record).
 */
export function landOfCells(cells, land) {
  const byKey = new Map(cells.map(c => [c.key, c]));
  bordersOf(cells, byKey);
  return Object.freeze({ cells, byKey, rings: land?.rings ?? { min: null, max: null }, reach: land?.reach ?? 0, far: land?.far ?? 0, count: cells.length, key: land?.key ?? '' });
}

/** Each cell's `corners` and `edges` (see wideLandOf), from its neighbours in `byKey`. */
function bordersOf(cells, byKey) {
  for (const cell of cells) {
    const corners = cell.corners = provinceCorners(cell.p, cell.q), edges = [], rim = [];
    for (const [dp, dq] of NEIGHBOURS) {
      const n = byKey.get(`${cell.p + dp},${cell.q + dq}`);
      // (territory-video-3: the nation's own border, on this cell's side, wherever the land beyond is not known to be the
      //  same nation's — another nation's, no nation's, one the fog never saw the holder of, or no recorded land at all)
      if (!n || n.holder !== cell.holder || known(n) !== known(cell)) {
        const s = sharedEdge(corners, provinceCorners(cell.p + dp, cell.q + dq));
        if (s) rim.push({ a: s[0], b: s[1] });
      }
      if (n && n.holder === cell.holder) continue;
      // (a neighbour that is a wide province of another nation: one border, drawn once, from the lower key)
      if (n && n.key < cell.key) continue;
      const shared = sharedEdge(corners, provinceCorners(cell.p + dp, cell.q + dq));
      if (shared) edges.push({ a: shared[0], b: shared[1], inner: !!n, other: n?.holder ?? null });
    }
    cell.edges = edges;
    cell.rim = rim;
  }
}

/** Whether the holder of a cell is known (the fog of war, map/fog.mjs fogWideLand, marks one it never saw `holderKnown: false`). */
const known = c => c?.holderKnown !== false;
/** The nation (0–5) whose border a cell carries, or null (no nation's, or a holder the fog does not know). */
export const borderNation = c => (known(c) && Number.isInteger(c?.holder) && c.holder >= 0 && c.holder < 6 ? c.holder : null);

/** The two corners two neighbouring cells share (within a pixel), or null. */
function sharedEdge(a, b) {
  const near = (u, v) => Math.abs(u[0] - v[0]) < 0.5 && Math.abs(u[1] - v[1]) < 0.5;
  const s = a.filter(u => b.some(v => near(u, v)));
  return s.length === 2 ? s : null;
}

/** The cells whose box meets the world box `seen` ({x0, y0, x1, y1}). */
export function cellsIn(land, seen) {
  if (!land?.cells?.length || !seen) return [];
  return land.cells.filter(c => c.box.x1 >= seen.x0 && c.box.x0 <= seen.x1 && c.box.y1 >= seen.y0 && c.box.y0 <= seen.y1);
}

/** The level of detail the wide land is painted at, from the map's own (`lod`) and whether the frame is the coarse chart. */
export const wideLevel = (lod, coarse) => (coarse ? 'chart' : lod === 'tile' ? 'tile' : lod === 'province' ? 'province' : 'world');

/**
 * Most hexagons (or border segments) one canvas path holds. One path of many sub-paths costs the browser far more than
 * linear time (Chromium, measured in verify-pr87: 5,544 hexagons in one path 92 ms, the same in paths of 256 6 ms), so
 * a colour's batch is drawn in paths of at most this many.
 */
export const PATH_CHUNK = 256;
// (`grow`: how much larger than the province each hexagon is drawn, about its centre; 1 = the province itself)
const path = (ctx, cells, grow = 1) => {
  ctx.beginPath();
  for (const c of cells) {
    const pts = c.corners ?? provinceCorners(c.p, c.q);
    pts.forEach(([x, y], j) => { const X = c.x + (x - c.x) * grow, Y = c.y + (y - c.y) * grow; return j ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.closePath();
  }
};
/** Fills `cells` (as `path` draws them) in the current fill style, PATH_CHUNK hexagons a path. → the number of fills. */
const fillCells = (ctx, cells, grow = 1) => {
  let n = 0;
  for (let i = 0; i < cells.length; i += PATH_CHUNK) { path(ctx, cells.slice(i, i + PATH_CHUNK), grow); ctx.fill(); n++; }
  return n;
};
/** How much a province is enlarged at `zoom` so it is at least MIN_CELL_PX across (1 when it already is). */
export const cellGrow = zoom => Math.max(1, MIN_CELL_PX / (2 * PROVINCE_CIRCUMRADIUS * Math.max(zoom, 1e-9)));

/**
 * Paints the wide land that is in `seen` (world px) into `ctx`, already in the map's world transform, at `zoom`.
 * `level`: wideLevel's. Returns `{cells, fills}` (what was drawn: for the tests and the trace).
 */
export function paintWideLand(ctx, land, { seen, zoom = 1, level = 'world', overLand = null } = {}) {
  const cells = cellsIn(land, seen);
  if (!cells.length) return { cells: 0, fills: 0 };
  let fills = 0;
  ctx.save();
  // from far: a mosaic of enlarged cells, an ink ring under each, then the nations' colours (one path per colour)
  const grow = level === 'chart' || level === 'world' ? cellGrow(zoom) : 1;
  if (grow > 1) {
    const ring = 2.4 / zoom / PROVINCE_CIRCUMRADIUS;
    ctx.fillStyle = 'rgba(27,46,40,.9)'; fills += fillCells(ctx, cells, grow + ring);
    const base = new Map();
    for (const c of cells) { const colour = landFill(c); if (!base.has(colour)) base.set(colour, []); base.get(colour).push(c); }
    for (const [colour, group] of base) { ctx.fillStyle = colour; fills += fillCells(ctx, group, grow); }
    // (territory-map: `overLand(ctx)` paints over the land and under the villages' marks — the owned tiles)
    const territory = overLand ? overLand(ctx) : null;
    const villages = paintVillageMarks(ctx, cells, { zoom, grow });
    ctx.restore();
    return { cells: cells.length, fills, grow, villages, holders: holdersOf(cells), territory };
  }
  if (level === 'tile') {
    for (const c of cells) {
      if (c.terrain) paintTiles(ctx, { p: c.p, q: c.q, terrain: c.terrain.terrain, sites: c.terrain.sites, names: c.terrain.names, rec: c.villages?.length ? villageRec(c.villages) : null });
      else { path(ctx, [c]); ctx.fillStyle = c.colour; ctx.fill(); }
      fills++;
    }
  } else {
    // the land itself (the chart and the world view: the nation's colour is the land's; nearer, the terrain's mean)
    const base = new Map();
    for (const c of cells) {
      const colour = level === 'province' ? c.colour : landFill(c);
      if (!base.has(colour)) base.set(colour, []);
      base.get(colour).push(c);
    }
    for (const [colour, group] of base) { ctx.fillStyle = colour; fills += fillCells(ctx, group); }
  }
  // (territory-map, owner 2026-11-25 OQ-3: "colour only the tiles actually owned; show province control with the keep
  //  icon" — a province is no longer washed or bordered in its keep nation's colour. The owned tiles and their
  //  tile-by-tile border are map/territorytiles.mjs paintTerritoryTiles, painted after this; the keep's icon,
  //  map/widemarks.mjs near and territorytiles.mjs paintFarKeeps from far. paintNationBorders / nationBands stay: the
  //  tiles' border is the same band, per tile)
  // the wide land's outer edge, a dashed ink line
  ctx.lineCap = 'round';
  const outer = [];
  for (const c of cells) for (const e of c.edges ?? []) if (!e.inner) outer.push(e);
  const stroke = (list, colour, width) => {
    ctx.strokeStyle = colour; ctx.lineWidth = width / zoom;
    for (let i = 0; i < list.length; i += PATH_CHUNK) {
      ctx.beginPath();
      for (const e of list.slice(i, i + PATH_CHUNK)) { ctx.moveTo(e.a[0], e.a[1]); ctx.lineTo(e.b[0], e.b[1]); }
      ctx.stroke();
    }
  };
  const w = level === 'chart' ? 1 : level === 'world' ? 1.4 : 2;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  stroke(outer, 'rgba(27,46,40,.9)', w + 0.4);
  ctx.setLineDash([]);
  const territory = overLand ? overLand(ctx) : null;
  // (the tile view drew each village on its own site, with the tiles; farther, one mark at the province's centre)
  const villages = level === 'tile' ? cells.reduce((n, c) => n + (c.terrain ? (c.villages ?? []).filter(v => v.nation !== null).length : 0), 0)
    : paintVillageMarks(ctx, cells, { zoom, grow });
  ctx.restore();
  return { cells: cells.length, fills, grow, villages, holders: holdersOf(cells), borders: [], territory };
}

/** The fill of a cell from afar: its terrain's own colour (territory-map OQ-3: never its keep nation's — the keep's icon says that). */
const landFill = c => c.colour;
/** The holders drawn (`cells`), for the page's legend: nations 0–5 and NEUTRAL, each once, ascending; unknown ones left out. */
export const holdersOf = cells => [...new Set(cells.filter(known).map(c => (Number.isInteger(c.holder) && c.holder >= 0 && c.holder < 6 ? c.holder : NEUTRAL)))].sort((a, b) => a - b);
/** Whether the world point (x, y) lies inside the convex polygon `poly` ([{x, y}], either winding). */
function insideConvex(poly, x, y) {
  let pos = false, neg = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], k = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (k > 0) pos = true; else if (k < 0) neg = true;
    if (pos && neg) return false;
  }
  return true;
}
/**
 * The holders of the `cells` that stand in the picture (verify-pr205): `view` is the picture's four world corners (the
 * tilted board's trapezoid, or the flat screen's box). The canvas paints a margin round the screen (the tilted ground is
 * larger than it), so the legend read the holders of land drawn but out of sight — "Fjordal" in the key with no Fjordal
 * land on the screen, or four nations listed over an empty stretch of paper. A cell counts when its middle or a corner is
 * in the picture, or a corner of the picture is in the cell's hexagon. Unknown holders are left out, as in holdersOf.
 */
export function holdersInView(cells, view) {
  if (!Array.isArray(view) || view.length < 3) return holdersOf(cells);
  return holdersOf(cells.filter(c => {
    if (insideConvex(view, c.x, c.y)) return true;
    for (const k of c.corners ?? []) if (insideConvex(view, k[0], k[1])) return true;
    // (a picture wholly inside one province: a corner of the picture in the province's own hexagon)
    const hex = (c.corners ?? []).map(k => ({ x: k[0], y: k[1] }));
    return hex.length >= 3 && view.some(p => insideConvex(hex, p.x, p.y));
  }));
}

/**
 * A nation's border, by level of detail (CSS px, inside its land): `band` its colour along the edge, `seam` the dark line
 * on the edge itself, `glow` the soft band fading inward and `alpha` that band's strength. Civilization-style national
 * borders (reports/territory-video-3.md: Unciv's two-colour edge sprites, freeciv's per-edge player-colour lines, Civ's
 * line with an inner gradient): the outline says whose land it is; the fill under it stays light.
 */
export const NATION_BORDER = Object.freeze({
  tile: Object.freeze({ band: 6, seam: 1.6, glow: 26, alpha: 0.34 }),
  province: Object.freeze({ band: 5, seam: 1.4, glow: 18, alpha: 0.32 }),
  world: Object.freeze({ band: 3.2, seam: 1, glow: 9, alpha: 0.3 }),
});
/**
 * The bands along the rim of a nation's `cells` (the union's edge), `d` world units deep, inside its land (verify-pr205):
 * one quadrilateral per rim side, its outer edge the side itself, its inner edge the side moved `d` inward. At each end
 * it meets the band of the next side of the union's edge — in the same province or the neighbouring one of the same
 * nation — on the mitre (where the two moved sides cross), so the bands of a nation's provinces join without a seam or a
 * notch, as one line round the union does. Where the edge does not simply continue (two provinces touching at a corner
 * only) the band ends square on its own province's next side. `d` is held under half a province's depth. → [[[x, y] × 4]].
 */
export function nationBands(cells, d) {
  if (!(d > 0)) return [];
  const sides = [], at = new Map(), keyOf = p => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  let depth = Infinity;
  for (const cell of cells) {
    const k = cell.corners, n = k?.length ?? 0;
    if (n < 3 || !cell.rim?.length) continue;
    let cx = 0, cy = 0;
    for (const c of k) { cx += c[0] / n; cy += c[1] / n; }
    const normal = k.map((a, i) => {
      const b = k[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l;
      if ((cx - a[0]) * nx + (cy - a[1]) * ny < 0) { nx = -nx; ny = -ny; }
      depth = Math.min(depth, (cx - a[0]) * nx + (cy - a[1]) * ny);
      return [nx, ny];
    });
    const rim = new Array(n).fill(false);
    for (const e of cell.rim) { const i = k.indexOf(e.a), j = k.indexOf(e.b); if (i >= 0 && j >= 0) rim[(i + 1) % n === j ? i : j] = true; }
    for (let i = 0; i < n; i++) {
      if (!rim[i]) continue;
      const side = { a: k[i], b: k[(i + 1) % n], n: normal[i], before: rim[(i - 1 + n) % n] ? null : normal[(i - 1 + n) % n], after: rim[(i + 1) % n] ? null : normal[(i + 1) % n] };
      sides.push(side);
      for (const p of [side.a, side.b]) { const kk = keyOf(p); if (!at.has(kk)) at.set(kk, []); at.get(kk).push(side); }
    }
  }
  const w = Math.min(d, depth * 0.45);
  // the point `w` inside both lines (through X, inward normals u and v): where the two moved sides cross
  const cross = (X, u, du, v, dv) => {
    const det = u[0] * v[1] - u[1] * v[0];
    if (Math.abs(det) < 1e-9) return [X[0] + u[0] * du, X[1] + u[1] * du];
    return [X[0] + (du * v[1] - u[1] * dv) / det, X[1] + (u[0] * dv - du * v[0]) / det];
  };
  const inner = (side, X, own) => {
    const others = at.get(keyOf(X)).filter(o => o !== side);
    if (others.length === 1) return cross(X, side.n, w, others[0].n, w);
    // (no single next side of the union here: square on this province's own next side)
    return own ? cross(X, side.n, w, own, 0) : [X[0] + side.n[0] * w, X[1] + side.n[1] * w];
  };
  return sides.map(s => [s.a, s.b, inner(s, s.b, s.after), inner(s, s.a, s.before)]);
}

/**
 * Draws each nation's border round the union of its `cells` (each cell's `rim`, see bordersOf), inside its own land:
 * the soft band fading inward, the band in its colour, the dark seam on the edge — each a fill of the rim's bands
 * (nationBands), so the borders of two neighbouring nations stand side by side, each in its own land, and joins between
 * provinces of one nation are seamless. (verify-pr205: it was drawn as lines centred on the rim under a clip to the
 * nation's land — the same picture, but a clip makes the wide lines about four times dearer to paint.) A province
 * whose holder is no nation's or unknown to the fog carries none. → `{nations, strokes}` (strokes: the fills made).
 */
export function paintNationBorders(ctx, cells, { zoom = 1, level = 'province' } = {}) {
  const look = NATION_BORDER[level];
  if (!look || !ctx?.fill) return { nations: [], strokes: 0 };
  const by = new Map();
  for (const c of cells) { const h = borderNation(c); if (h === null || !c.rim?.length) continue; if (!by.has(h)) by.set(h, []); by.get(h).push(c); }
  const z = Math.max(zoom, 1e-9), nations = [];
  let strokes = 0;
  for (const [h, group] of [...by].sort((a, b) => a[0] - b[0])) {
    const band = (style, width, alpha = 1) => {
      ctx.fillStyle = style; ctx.globalAlpha = alpha;
      const quads = nationBands(group, width / z);
      for (let i = 0; i < quads.length; i += PATH_CHUNK) {
        ctx.beginPath();
        for (const q of quads.slice(i, i + PATH_CHUNK)) { ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]); ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]); ctx.closePath(); }
        ctx.fill(); strokes++;
      }
    };
    band(NATION_LAND[h], look.glow, look.alpha * 0.5);
    band(NATION_LAND[h], look.glow * 0.5, look.alpha);
    band(NATION_LAND[h], look.band);
    band(NATION_DARK[h], look.seam);
    ctx.globalAlpha = 1;
    nations.push(h);
  }
  return { nations, strokes };
}

/**
 * One mark per province with a village (its first village's nation's sigil on a paper disc, at least ~11 CSS px) at the
 * province's centre, enlarged as the cell is (`grow`). → the number of marks.
 */
function paintVillageMarks(ctx, cells, { zoom, grow = 1 }) {
  let n = 0;
  const r = Math.max(PROVINCE_CIRCUMRADIUS * 0.22, 5.5 / Math.max(zoom, 1e-9));
  for (const c of cells) {
    const v = (c.villages ?? []).find(x => x.nation !== null);
    if (!v) continue;
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f4efe0'; ctx.fill(); ctx.strokeStyle = '#3a3a33'; ctx.lineWidth = 1.6 / Math.max(zoom, 1e-9); ctx.stroke();
    paintSigil(ctx, { x: c.x, y: c.y, r: r * 0.66, faction: v.nation });
    n++;
  }
  return n;
}

/** The words the map writes on the wide land (the page's language). */
export const WIDE_WORDS = Object.freeze({
  name: () => L`広い土地`,
  rings: (a, b) => (a === b ? L`第${a}輪・記録` : L`第${a}–${b}輪・記録`),
});

/** How far past its land a tag stands (screen px): beside the land, never over it. */
export const TAG_GAP_PX = 30;
/** About half a tag's width (screen px). */
export const TAG_HALF_PX = 52;
/**
 * Where the wide land's name stands: one tag per wedge (the six directions out of the heartland), beside that wedge's
 * recorded cells that are in `seen`: from their middle, outward (away from province (0, 0), the lattice's origin, which
 * is only a direction here), past the furthest of them by TAG_GAP_PX at `zoom`. → `[{x, y, text, sub, at: {x, y}}]`
 * (`at`: the land's middle).
 */
export function wideTags(land, seen, zoom = 1) {
  const by = new Map();
  const cells = cellsIn(land, seen);
  for (const c of cells) {
    const w = by.get(c.wedge) ?? { x: 0, y: 0, n: 0, min: c.ring, max: c.ring, cells: [] };
    w.x += c.x; w.y += c.y; w.n++; w.min = Math.min(w.min, c.ring); w.max = Math.max(w.max, c.ring); w.cells.push(c);
    by.set(c.wedge, w);
  }
  const grow = cellGrow(zoom);
  return [...by.values()].map(w => {
    const mx = w.x / w.n, my = w.y / w.n, len = Math.hypot(mx, my) || 1, ux = mx / len, uy = my / len;
    // the land's own reach along the outward line, and the cells' own (drawn) size
    let reach = 0;
    for (const c of w.cells) reach = Math.max(reach, (c.x - mx) * ux + (c.y - my) * uy);
    // (a tag is wider than it is tall: one that stands to the side of its land is pushed out by half its width too)
    const out = reach + PROVINCE_CIRCUMRADIUS * grow + (TAG_GAP_PX + Math.abs(ux) * TAG_HALF_PX) / zoom;
    return { x: mx + ux * out, y: my + uy * out, at: { x: mx, y: my }, text: WIDE_WORDS.name(), sub: WIDE_WORDS.rings(w.min, w.max) };
  });
}

/** The tags, upright over the board (`o`: the label canvas in the map's world transform). */
export function paintWideTags(o, land, { seen, zoom = 1 } = {}) {
  const tags = wideTags(land, seen, zoom);
  o.save();
  o.textAlign = 'center'; o.textBaseline = 'middle';
  for (const t of tags) {
    const fs = 15 / zoom, ss = 11.5 / zoom;
    o.font = `600 ${fs}px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
    o.lineWidth = 4 / zoom; o.strokeStyle = 'rgba(20,28,24,.82)'; o.fillStyle = '#fff6e2';
    o.strokeText(t.text, t.x, t.y - fs * 0.55); o.fillText(t.text, t.x, t.y - fs * 0.55);
    o.font = `500 ${ss}px system-ui, sans-serif`;
    o.lineWidth = 3.4 / zoom;
    o.strokeText(t.sub, t.x, t.y + ss * 0.75); o.fillText(t.sub, t.x, t.y + ss * 0.75);
  }
  o.restore();
  return tags.length;
}

/**
 * Keeps the wide land of the page's season loaded in the background: `{land(), stop(), reload()}`. Reads only when
 * the season record gives pins (map/wide.mjs sourcePins: never a sample or prototype world), polls the manifest every
 * POLL_S and reloads on a new snapshot; a herald with no recorded world (`WideWorldUnavailable`) is asked again after
 * RETRY_S. `onChange()` runs when the land changes. Never throws; never signs or sends.
 */
export function mountWideLand({ herald, recordOf = () => null, isSample = () => false, onChange = () => {}, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = t => clearTimeout(t) } = {}) {
  let land = null, timer = null, controller = null, stopped = false, pinsKey = null, snapshot = null, busy = false;
  const later = s => { if (!stopped) { if (timer) clearTimer(timer); timer = setTimer(tick, s * 1000); } };
  const drop = () => { if (land) { land = null; onChange(); } snapshot = null; };
  async function load(pins) {
    controller?.abort?.();
    const c = typeof AbortController !== 'undefined' ? new AbortController() : null;
    controller = c;
    let r;
    try { r = await loadWide(herald, { walk: new WideWalk(), signal: c?.signal ?? null, pins }); } catch (e) { r = { ok: false, code: e?.code ?? 'network' }; }
    if (stopped || controller !== c) return null;
    if (!r.ok) return r.code;
    land = wideLandOf(r.walk);
    snapshot = r.walk.snapshot;
    onChange();
    return 'ok';
  }
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (!herald?.wideWorld || isSample()) { drop(); return later(RETRY_S); }
      let pins;
      try { pins = sourcePins(recordOf()); } catch { return later(5); }
      if (pins.key !== pinsKey) { pinsKey = pins.key; drop(); }
      if (land && snapshot) {
        const m = await herald.wideWorld({ pins });
        if (stopped) return;
        if (m.ok && m.manifest.snapshot.epoch === snapshot.epoch && m.manifest.snapshot.stamp === snapshot.stamp) return later(POLL_S);
        if (!m.ok && (m.code === 'network' || m.code === 'Aborted')) return later(POLL_S);
      }
      const code = await load(pins);
      if (code === 'WideWorldUnavailable' || code === 'SampleWorld') { drop(); return later(RETRY_S); }
      later(POLL_S);
    } finally { busy = false; }
  }
  later(0);
  return {
    land: () => land,
    reload: () => { snapshot = null; later(0); },
    stop: () => { stopped = true; controller?.abort?.(); if (timer) clearTimer(timer); timer = null; },
  };
}
