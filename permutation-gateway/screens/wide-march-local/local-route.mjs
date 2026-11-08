// Independent re-walk of a chosen direction string over the wide tile lattice, in BigInt.
//
// A port of frontier-abi `world_index/tiles.rs`: `WideTile::of` (province centre + the legacy tile offset),
// `WideTile::checked` (the ±(13·2^62 + 4) tile box, the province by `cell_of_i128`, the local index by the offset),
// `WideTile::neighbors` (`hex::DIRECTIONS` order, None past the world), and `verify_route`'s list of provinces
// entered (distinct step provinces, first-entered order; the start's province only when a step stands in it).
// Pure geometry over the production fgeo tables. It decides NOTHING about passability, cost, time or legality:
// the caller compares its result with what the host reported and with the host's own province bytes.
import { TILE_OFFSETS, DIRECTIONS } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { WIDE_BOUND, parseWideInt } from '../../../permutation-server/web/frontier/map/wide.mjs';

export const MAX_ROUTE_STEPS = 32;
export const TILE_COORD_BOUND = 13n * WIDE_BOUND + 4n;
const DET = 61n;
const INDEX = new Map(TILE_OFFSETS.map((o, i) => [`${o.q},${o.r}`, i]));
const abs = x => (x < 0n ? -x : x);
/** Floor division by a positive divisor (`i128::div_euclid` for b > 0). */
const floorDiv = (a, b) => { const q = a / b; return a % b !== 0n && a < 0n ? q - 1n : q; };
const centre = (p, q) => ({ q: 9n * p + 4n * q, r: -4n * p + 5n * q });
const hexDistance = (dq, dr) => (abs(dq) + abs(dr) + abs(dq + dr)) / 2n;

/** `cell_of_i128`: the province of global tile (q, r). */
function cellOf(q, r) {
  const p0 = floorDiv(5n * q - 4n * r, DET), q0 = floorDiv(4n * q + 9n * r, DET);
  let best = null;
  for (let dp = -1n; dp <= 1n; dp++) for (let dq = -1n; dq <= 1n; dq++) {
    const pp = p0 + dp, qq = q0 + dq, c = centre(pp, qq), d = hexDistance(q - c.q, r - c.r);
    if (best === null || d < best.d) best = { d, p: pp, q: qq };
  }
  return best;
}
/** `WideTile::of`: global coordinates of tile `local` of province (p, q). */
export function tileOf(p, q, local) {
  const o = TILE_OFFSETS[local];
  if (typeof p !== 'bigint' || typeof q !== 'bigint' || !Number.isInteger(local) || !o) throw new Error('BadTile');
  const c = centre(p, q);
  return { q: c.q + BigInt(o.q), r: c.r + BigInt(o.r), p, pq: q, local };
}
/** `WideTile::checked`: the tile at global (q, r), or null outside the world. */
export function tileAt(q, r) {
  if (abs(q) > TILE_COORD_BOUND || abs(r) > TILE_COORD_BOUND) return null;
  const cell = cellOf(q, r);
  if (abs(cell.p) > WIDE_BOUND || abs(cell.q) > WIDE_BOUND) return null;
  const c = centre(cell.p, cell.q), local = INDEX.get(`${q - c.q},${r - c.r}`);
  if (local === undefined) return null;
  return { q, r, p: cell.p, pq: cell.q, local };
}
/** Re-walks `dirs` (1..32 digits 0..5) from start {p, q, tile} (canonical decimal strings, tile 0..60).
 * → {steps: [{p, q, tile}], offWorld: index|null}; steps stop before a step that leaves the world. */
export function walkDirections(start, dirs) {
  if (typeof dirs !== 'string' || dirs.length < 1 || dirs.length > MAX_ROUTE_STEPS || !/^[0-5]+$/.test(dirs)) throw new Error('BadDirections');
  let cur = tileOf(parseWideInt(start.p), parseWideInt(start.q), start.tile);
  const steps = [];
  for (let i = 0; i < dirs.length; i++) {
    const [dq, dr] = DIRECTIONS[Number(dirs[i])];
    const next = tileAt(cur.q + BigInt(dq), cur.r + BigInt(dr));
    if (!next) return { steps, offWorld: i };
    steps.push({ p: next.p.toString(), q: next.pq.toString(), tile: next.local });
    cur = next;
  }
  return { steps, offWorld: null };
}
/** `verify_route`'s provinces: the distinct provinces the steps stand in, in first-entered order. */
export function provincesEntered(steps) {
  const out = [], seen = new Set();
  for (const s of steps) { const k = `${s.p},${s.q}`; if (!seen.has(k)) { seen.add(k); out.push({ p: s.p, q: s.q }); } }
  return out;
}
