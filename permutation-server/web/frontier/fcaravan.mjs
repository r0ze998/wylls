// A caravan's road on this page (S1; permutation-rules caravan.rs): the
// fastest path the program and every client agree on, its packing, and the
// seconds of each step. The port is pinned by
// permutation-gateway/test/fixtures/caravan-path-v1.json, which fclient's
// caravan_path_vectors test writes from the Rust.
//
// A land is `{p, q, passable, rough, road}`: the Province's masks (bigint or
// decimal string; bit = tile index).
import { DIRECTIONS, locate, tileHex } from './fgeo.mjs';

/** travel.rs: seconds a foot host takes over a flat or a rough tile; a road halves it. */
export const FLAT_HEX_SECS = 120;
export const ROUGH_HEX_SECS = 180;
export const ROAD_BPS = 5000;
export const BPS_ONE = 10000;
/** travel.rs: the longest path and the most Provinces it may cross. */
export const MAX_PATH_STEPS = 32;
export const MAX_PATH_PROVINCES = 4;
/** caravan.rs: a caravan is slower than a host by half. */
export const CARAVAN_SLOW_BPS = 15000;
/** caravan.rs: the lamports a caravan escrows for its settlement. */
export const CARAVAN_FEE = 50000n;
/** caravan.rs: the vaults a citizen may hold, and a vault's cost. */
export const MAX_VAULTS = 3;
export const VAULT_COST = Object.freeze([0, 200, 200, 0, 0, 50, 0, 0]);

const big = v => (typeof v === 'bigint' ? v : BigInt(String(v ?? 0)));
const landOf = l => ({ p: l.p, q: l.q, passable: big(l.passable), rough: big(l.rough), road: big(l.road) });

/** The base seconds of stepping onto `tile` of `land` (before the caravan's slowness), or null when impassable. */
function stepSecs(land, tile) {
  const bit = 1n << BigInt(tile);
  if ((land.passable & bit) === 0n) return null;
  let s = (land.rough & bit) !== 0n ? ROUGH_HEX_SECS : FLAT_HEX_SECS;
  if ((land.road & bit) !== 0n) s = Math.floor((s * ROAD_BPS) / BPS_ONE);
  return s;
}

// a binary min-heap over [cost, steps, q, r] (lexicographic, as Rust's BinaryHeap<Reverse<…>> pops)
const less = (a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
function heapPush(h, x) { h.push(x); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(h[i], h[p])) break; [h[i], h[p]] = [h[p], h[i]]; i = p; } }
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && less(h[l], h[m])) m = l; if (r < h.length && less(h[r], h[m])) m = r; if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m; }
  }
  return top;
}

/**
 * caravan.rs `fastest_path`: the directions from `origin` to `dst` (`{p, q,
 * tile}`) over `lands` and the Provinces in first-entered order (the
 * origin's first), `{dirs, provinces: [{p, q}]}`; null when there is none
 * within MAX_PATH_STEPS steps and MAX_PATH_PROVINCES Provinces, or the
 * fastest would re-enter a Province.
 */
export function fastestPath(origin, dst, lands) {
  const L = lands.map(landOf);
  const landAt = (p, q) => L.find(l => l.p === p && l.q === q) ?? null;
  const start = tileHex(origin.p, origin.q, origin.tile), goal = tileHex(dst.p, dst.q, dst.tile);
  if (!start || !goal || !landAt(origin.p, origin.q)) return null;
  if (start.q === goal.q && start.r === goal.r) return { dirs: [], provinces: [{ p: origin.p, q: origin.q }] };
  const key = (q, r) => `${q},${r}`;
  const best = new Map([[key(start.q, start.r), { cost: 0, steps: 0, prev: null, d: -1 }]]);
  const heap = [[0, 0, start.q, start.r]];
  const goalKey = key(goal.q, goal.r);
  while (heap.length) {
    const [cost, steps, q, r] = heapPop(heap);
    const b = best.get(key(q, r));
    if (b && (b.cost < cost || (b.cost === cost && b.steps < steps))) continue;
    if (key(q, r) === goalKey) break;
    if (steps === MAX_PATH_STEPS) continue;
    DIRECTIONS.forEach(([dq, dr], d) => {
      const hq = q + dq, hr = r + dr, at = locate(hq, hr), land = landAt(at.p, at.q);
      if (!land) return;
      const s = stepSecs(land, at.idx);
      if (s === null) return;
      const c = cost + s, k = key(hq, hr), o = best.get(k);
      if (!o || c < o.cost || (c === o.cost && steps + 1 < o.steps)) {
        best.set(k, { cost: c, steps: steps + 1, prev: [q, r], d });
        heapPush(heap, [c, steps + 1, hq, hr]);
      }
    });
  }
  if (!best.has(goalKey)) return null;
  const dirs = [];
  for (let at = [goal.q, goal.r]; key(...at) !== key(start.q, start.r);) { const b = best.get(key(...at)); dirs.push(b.d); at = b.prev; }
  dirs.reverse();
  const provinces = [{ p: origin.p, q: origin.q }];
  let h = { q: start.q, r: start.r }, cur = provinces[0];
  for (const d of dirs) {
    h = { q: h.q + DIRECTIONS[d][0], r: h.r + DIRECTIONS[d][1] };
    const at = locate(h.q, h.r);
    if (at.p !== cur.p || at.q !== cur.q) {
      if (provinces.some(o => o.p === at.p && o.q === at.q)) return null;
      cur = { p: at.p, q: at.q };
      provinces.push(cur);
    }
  }
  return provinces.length <= MAX_PATH_PROVINCES ? { dirs, provinces } : null;
}

/** caravan.rs `pack`: directions, 3 bits each little-endian across 12 bytes; null when too long or a direction is not 0..5. */
export function pack(dirs) {
  if (dirs.length > MAX_PATH_STEPS) return null;
  const out = new Uint8Array(12);
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    if (!(Number.isInteger(d) && d >= 0 && d <= 5)) return null;
    const bit = 3 * i, v = d << (bit % 8);
    out[bit >> 3] |= v & 0xff;
    if ((bit >> 3) + 1 < 12) out[(bit >> 3) + 1] |= v >> 8;
  }
  return out;
}

/**
 * The seconds from departure at which the caravan reaches each step
 * (caravan.rs `walk` for a path `fastestPath` found): `caravanBps` is the
 * owner's doctrine `caravan_time_bps` (10000 without one).
 */
export function stepSecsOf(origin, dirs, lands, caravanBps = BPS_ONE) {
  const L = lands.map(landOf);
  let h = tileHex(origin.p, origin.q, origin.tile), base = 0n;
  const out = [];
  for (const d of dirs) {
    h = { q: h.q + DIRECTIONS[d][0], r: h.r + DIRECTIONS[d][1] };
    const at = locate(h.q, h.r), land = L.find(l => l.p === at.p && l.q === at.q);
    const s = land ? stepSecs(land, at.idx) : null;
    if (s === null) return null;
    base += BigInt(s);
    out.push(Number((base * BigInt(CARAVAN_SLOW_BPS) / BigInt(BPS_ONE)) * BigInt(caravanBps) / BigInt(BPS_ONE)));
  }
  return out;
}
