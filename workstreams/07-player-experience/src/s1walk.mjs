// Workstream 07: what an S1 walk meets on its way, as the program judges it
// (permutation-rules structure.rs `stops`, `watch`, `march_watch`,
// `caravan_watch`, `wear_bps`, `wear`; S1-1E-CONTRACT §2.5: "fastest_path
// callers (keeper, clients) remove the stopped palisade tiles from the
// passable mask"). A port, not a new rule: every function is pinned against
// vectors written by the rules crate itself (rust-vectors/, test
// s1walk.test.mjs). The page today plans marches (fmarch.mjs planRoute) and
// caravans (fcaravan.mjs fastestPath) without these, and its march forecast
// (hud/forecast.mjs) counts no tower wear.
//
// A structure here is the herald's `h/structures.json` entry as
// map/s1marks.mjs reads it: `{kind (1 tower, 2 palisade, 3 fort), p, q, tile,
// faction}`; `stances` the nations feed's 6 × 6 table (row N: nation N's
// stance toward each nation; 0 war, 1 pass, 2 ally), or null when the page
// has not read it.
import { DIRECTIONS, TILE_OFFSETS, locate, tileHex } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { FLAT_HEX_SECS, ROUGH_HEX_SECS, ROAD_BPS, BPS_ONE, MAX_PATH_STEPS } from '../../../permutation-server/web/frontier/fcaravan.mjs';

export const KIND_TOWER = 1, KIND_PALISADE = 2, KIND_FORT = 3;
export const NATIONS = 6;
export const STANCE_WAR = 0;
/** structure.rs [phase 6]: a tower's range, its wear a minute (bps) and the most one walk is worn. */
export const TOWER_RANGE = 2;
export const TOWER_WEAR_BPS_PER_MIN = 100;
export const TOWER_WEAR_CAP_BPS = 3000;
/** travel.rs CAVALRY_BPS, and the mounted units (units.rs class Mounted: Horseman, Knight). */
export const CAVALRY_BPS = 5000;
export const CAVALRY_UNITS = Object.freeze([2, 5]);
export const isCavalry = unit => CAVALRY_UNITS.includes(Number(unit));

const big = v => (typeof v === 'bigint' ? v : BigInt(String(v ?? 0)));

/** structure.rs COVER: the tiles of one Province within TOWER_RANGE of each tile (bigint masks). */
export const COVER = Object.freeze(TILE_OFFSETS.map(({ q: aq, r: ar }) => {
  let m = 0n;
  TILE_OFFSETS.forEach(({ q: bq, r: br }, b) => {
    const dq = aq - bq, dr = ar - br;
    if ((Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 <= TOWER_RANGE) m |= 1n << BigInt(b);
  });
  return m;
}));
export const coverage = tile => (Number.isInteger(tile) && tile >= 0 && tile < 61 ? COVER[tile] : 0n);

/** structure.rs `stops`: whether a work of nation `nation` stops a walker of `faction`. */
export function stops(stances, nation, faction, expelled) {
  const n = Number(nation), f = Number(faction);
  if (!(n >= 0 && n < NATIONS)) return false;
  if (n === f) return !!expelled;
  if (!(f >= 0 && f < NATIONS)) return true;
  return stanceOf(stances, n, f) === STANCE_WAR;
}
/** N's stance toward f from a 6 × 6 table given as rows or flat; a fresh season's (and an unread table's) are all war. */
export function stanceOf(stances, n, f) {
  if (!stances) return STANCE_WAR;
  const v = Array.isArray(stances[0]) ? stances[n]?.[f] : stances[n * NATIONS + f];
  return Number.isInteger(Number(v)) ? Number(v) : STANCE_WAR;
}

/** structure.rs `watch`: `{wear, block}` (bigint tile masks) a walker meets in one Province's structures. */
export function watchOf(structures, stances, faction, expelled) {
  let wear = 0n, block = 0n;
  for (const s of structures ?? []) {
    const kind = Number(s.kind), tile = Number(s.tile);
    if (!kind || kind === KIND_FORT || !stops(stances, s.faction, faction, expelled)) continue;
    if (kind === KIND_TOWER) wear |= coverage(tile);
    else if (kind === KIND_PALISADE && tile >= 0 && tile < 61) block |= 1n << BigInt(tile);
  }
  return { wear, block };
}

/** The structures of one Province from the feed's flat list. */
export const structuresIn = (all, p, q) => (all ?? []).filter(s => Number(s.p) === p && Number(s.q) === q);

/** structure.rs `wear_bps`. */
export const wearBps = secs => Math.min(TOWER_WEAR_CAP_BPS, Math.floor((Math.max(0, Math.floor(secs)) * TOWER_WEAR_BPS_PER_MIN) / 60));
/** structure.rs `wear`: `v` (whole or milli units, an integer) worn by `bps`; the loss rounds down. */
export function wear(v, bps) {
  const b = BigInt(Math.min(BPS_ONE, Math.max(0, bps | 0))), x = big(v);
  const out = x - (x * b) / BigInt(BPS_ONE);
  return typeof v === 'bigint' ? out : Number(out);
}

/**
 * structure.rs `march_watch`: what a march meets on `dirs` from `origin`
 * (`{p, q, tile}`). `lands`: `[{p, q, rough, road, watch: {wear, block}}]`.
 * `'blocked'` when a step enters a stopping palisade's tile, else the
 * seconds of the steps that enter a covered tile; null when a step leaves
 * the lands given or the path is too long.
 */
export function marchWatch(origin, dirs, lands, cavalry = false) {
  if (dirs.length > MAX_PATH_STEPS) return null;
  let h = tileHex(origin.p, origin.q, origin.tile);
  if (!h) return null;
  let secs = 0, blocked = false;
  for (const d of dirs) {
    const dir = DIRECTIONS[d];
    if (!dir) return null;
    h = { q: h.q + dir[0], r: h.r + dir[1] };
    const at = locate(h.q, h.r), l = lands.find(x => x.p === at.p && x.q === at.q);
    if (!l) return null;
    const bit = 1n << BigInt(at.idx);
    if ((big(l.watch?.block) & bit) !== 0n) blocked = true;
    if ((big(l.watch?.wear) & bit) === 0n) continue;
    let s = (big(l.rough) & bit) !== 0n ? ROUGH_HEX_SECS : FLAT_HEX_SECS;
    if ((big(l.road) & bit) !== 0n) s = Math.floor((s * ROAD_BPS) / BPS_ONE);
    if (cavalry) s = Math.floor((s * CAVALRY_BPS) / BPS_ONE);
    secs += s;
  }
  return blocked ? 'blocked' : secs;
}

/**
 * structure.rs `caravan_watch` over a caravan's steps `[{p, q, tile,
 * atSecs}]` (fcaravan.mjs stepSecsOf gives `atSecs`); `watchAt(p, q)` a
 * Province's watch. `'blocked'` or the seconds spent in coverage.
 */
export function caravanWatch(steps, watchAt) {
  let secs = 0, prev = 0;
  for (const s of steps) {
    const w = watchAt(s.p, s.q) ?? { wear: 0n, block: 0n }, bit = 1n << BigInt(s.tile);
    if ((big(w.block) & bit) !== 0n) return 'blocked';
    if ((big(w.wear) & bit) !== 0n) secs += Math.max(0, s.atSecs - prev);
    prev = s.atSecs;
  }
  return secs;
}

/** The steps of `dirs` from `origin` as `[{p, q, tile}]` (the tile each step ends on). */
export function stepTiles(origin, dirs) {
  let h = tileHex(origin.p, origin.q, origin.tile);
  const out = [];
  for (const d of dirs) {
    h = { q: h.q + DIRECTIONS[d][0], r: h.r + DIRECTIONS[d][1] };
    const at = locate(h.q, h.r);
    out.push({ p: at.p, q: at.q, tile: at.idx });
  }
  return out;
}

/**
 * The lands for fcaravan.mjs `fastestPath` with the stopped palisade tiles
 * removed from each passable mask (S1-1E-CONTRACT §2.5). `watchAt(p, q)`.
 */
export const avoidingPalisades = (lands, watchAt) => lands.map(l => ({ ...l, passable: big(l.passable) & ~big(watchAt(l.p, l.q)?.block ?? 0n) }));

/**
 * The hexes (axial `{q, r}`) a march planner must not enter: every
 * stopping palisade's tile among `structures` (fmarch.mjs planRoute takes
 * them as `blocked`, the kernel's plan_path refuses to step on them).
 */
export function blockedHexes(structures, stances, faction, expelled) {
  const out = [];
  for (const s of structures ?? []) {
    if (Number(s.kind) !== KIND_PALISADE || !stops(stances, s.faction, faction, expelled)) continue;
    const h = tileHex(Number(s.p), Number(s.q), Number(s.tile));
    if (h) out.push(h);
  }
  return out;
}
