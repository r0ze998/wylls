// The ore a village takes from the land around it (S1, the redesign's stage 1:
// permutation-rules arms.rs `terrain_ore_per_hour`): every holding makes
// ORE.base an hour, and each other tile of its own province within ORE.radius
// adds ORE.hills, ORE.mountain and ORE.iron by its terrain and resource, the
// whole terrain part capped at ORE.cap. The program reckons it once, when the
// village is founded or taken, and keeps it with the Holding (`terrainOre`,
// milli per hour); the tier's bonus applies on top.
//
// What the board shows of it: when the viewer selects their own village of an
// S1 season, the tiles that feed its ore are lit in amber with what each adds,
// and the village carries one tag with the sum. That is why this village has
// the ore it has, and what another site would have had; it is the record's
// own number (the model is checked against `terrainOre` and says when the two
// differ), never an estimate. Nothing here is shown for anyone else's village.
//
// `oreField` is pure; `paintOreField` is context-tolerant; words go through L.
import { FLATTEN, RADIUS, hexPoints, project } from '../../map.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { TILE_OFFSETS, hexDistance, tileHex } from '../fgeo.mjs';
import { upright } from './tilt.mjs';
import { paintBellTag } from './hostmarks.mjs';

/** permutation-rules arms.rs, units per hour [phase 6]. Pinned by web-frontier-orefield.test.mjs. */
export const ORE = Object.freeze({ base: 4, hills: 2, mountain: 3, iron: 4, radius: 2, cap: 30 });
/** Terrain and resource indices (permutation-rules map.rs `Terrain`, `TileResource`; wasm.mjs TERRAIN). */
const HILLS = 3, MOUNTAIN = 4, IRON = 1;

/**
 * The ore field of the village on tile `tile` of a province whose generated terrain is `land`
 * (`{terrain: [61], resource: [61 | null]}`, map/terrain.mjs):
 *   tiles   `[{idx, ore, hills, mountain, iron}]`: each tile within the radius that adds anything
 *   extra   the terrain part before the cap; `capped` whether the cap took some of it
 *   perHour units per hour before the tier's bonus (base + capped terrain part): the record's `terrainOre / 1000`
 *   counts  `{hills, mountain, iron}`: how many tiles of each feed it
 * or null without the terrain or for a tile outside the province.
 */
export function oreField(land, tile) {
  const at = TILE_OFFSETS[tile];
  if (!at || !Array.isArray(land?.terrain)) return null;
  const tiles = [], counts = { hills: 0, mountain: 0, iron: 0 };
  let extra = 0;
  TILE_OFFSETS.forEach((o, idx) => {
    if (idx === tile || hexDistance(o.q, o.r, at.q, at.r) > ORE.radius) return;
    const t = land.terrain[idx], hills = t === HILLS, mountain = t === MOUNTAIN, iron = land.resource?.[idx] === IRON;
    const ore = (hills ? ORE.hills : mountain ? ORE.mountain : 0) + (iron ? ORE.iron : 0);
    if (!ore) return;
    if (hills) counts.hills++;
    if (mountain) counts.mountain++;
    if (iron) counts.iron++;
    extra += ore;
    tiles.push({ idx, ore, hills, mountain, iron });
  });
  return { tiles, extra, capped: extra > ORE.cap, perHour: ORE.base + Math.min(extra, ORE.cap), counts };
}

/** Whether the field agrees with the record: `terrainOre` is milli per hour (a BigInt, a string or a number). */
export function fieldMatches(field, terrainOre) {
  const rec = Number(terrainOre ?? 0) / 1000;
  return !!field && rec > 0 && Math.abs(rec - field.perHour) < 1e-6;
}

/** The tag on the village: "地形の鉱石 +34/時（丘 5 · 山 4 · 鉄 1）"; the record's number when given. */
export function oreTagText(field, terrainOre = null) {
  if (!field) return '';
  const per = terrainOre !== null && Number(terrainOre) > 0 ? Number(terrainOre) / 1000 : field.perHour;
  const parts = [];
  if (field.counts.hills) parts.push(L`丘 ${fmtNum(field.counts.hills)}`);
  if (field.counts.mountain) parts.push(L`山 ${fmtNum(field.counts.mountain)}`);
  if (field.counts.iron) parts.push(L`鉄 ${fmtNum(field.counts.iron)}`);
  // (the terrain part is capped: the tiles' chips add up to more than the village gets)
  if (field.capped) parts.push(L`上限 ${fmtNum(ORE.cap)}`);
  return parts.length ? L`地形の鉱石 +${fmtNum(per)}/時（${parts.join(' · ')}）` : L`地形の鉱石 +${fmtNum(per)}/時`;
}

const AMBER = Object.freeze({ fill: 'rgba(240,176,64,0.20)', edge: 'rgba(255,214,120,0.85)', ink: '#2a1a06', chip: '#f3c561', chipEdge: '#7a5214' });

/** The tiles of the field as the board shows them: `[{c: world point of the tile's middle, ore}]`. */
const fieldTiles = (p, q, field) => field.tiles.map(t => ({ ...t, h: tileHex(p, q, t.idx) })).filter(t => t.h).map(t => ({ ...t, c: project(t.h.q, t.h.r) }));

/** The field's ground: an amber wash and a dashed rim on each tile that feeds it (under what stands on the tiles). */
export function paintOreGround(g, { p, q, field, zoom = 1, alpha = 1 } = {}) {
  if (!g?.save || !field?.tiles?.length || alpha <= 0.01) return;
  const k = 1 / zoom;
  g.save();
  g.globalAlpha = alpha;
  for (const t of fieldTiles(p, q, field)) {
    const pts = hexPoints(t.c.x, t.c.y, RADIUS * 0.1);
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
    g.fillStyle = AMBER.fill; g.fill();
    g.setLineDash?.([5 * k, 4 * k]); g.strokeStyle = AMBER.edge; g.lineWidth = 1.6 * k; g.stroke(); g.setLineDash?.([]);
  }
  g.restore();
}

/**
 * The field's words over the board: a chip with what each tile adds (upright, over its middle, kept out of the other
 * labels' way), and the village's tag with the sum. `tile` the village's tile, `terrainOre` the record's. Returns the
 * tag's box.
 */
export function paintOreField(g, { p, q, tile, field, terrainOre = null, zoom = 1, pass = null, alpha = 1 } = {}) {
  if (!g?.save || !field?.tiles?.length || alpha <= 0.01) return null;
  const k = 1 / zoom;
  for (const t of fieldTiles(p, q, field)) {
    const text = `+${fmtNum(t.ore)}`, w = (text.length * 7 + 12) * k, hh = 18 * k;
    pass?.block?.(t.c.x, t.c.y, { x: t.c.x - w / 2, y: t.c.y - hh / 2, w, h: hh });
    upright(g, t.c.x, t.c.y, () => {
      g.save();
      g.globalAlpha = alpha;
      g.font = `700 ${12 * k}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const cw = (g.measureText?.(text)?.width ?? text.length * 7 * k) + 12 * k, y0 = t.c.y - hh / 2;
      g.beginPath(); g.roundRect?.(t.c.x - cw / 2, y0, cw, hh, hh / 2);
      g.fillStyle = AMBER.chip; g.fill(); g.strokeStyle = AMBER.chipEdge; g.lineWidth = 1 * k; g.stroke();
      g.fillStyle = AMBER.ink; g.fillText?.(text, t.c.x, t.c.y + 0.5 * k);
      g.restore();
    });
  }
  const home = tileHex(p, q, tile);
  if (!home) return null;
  const c = project(home.q, home.r);
  // (below the field's last row, where no chip stands: the radius's rows lie 1.5 radii apart down the board)
  const foot = { x: c.x, y: c.y + RADIUS * FLATTEN * (1.5 * ORE.radius + 0.95) };
  return paintBellTag(g, foot.x, foot.y, oreTagText(field, terrainOre), { zoom, place: 'below', gap: 2, accent: AMBER.chip, alpha, anchor: foot, pass, size: 12 });
}
