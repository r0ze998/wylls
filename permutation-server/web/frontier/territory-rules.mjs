// Player territory (preview, owner Q-2 2026-11-24): the page's and the operator AI's copy of the Rust kernel
// `permutation-rules/src/frontier/territory.rs` (feature `territory-preview`). Same inputs, same answers: checked
// against the kernel's committed vectors (`permutation-rules/vectors/territory-preview.json`) by
// `permutation-gateway/test/web-frontier-territory-rules.test.mjs`.
//
// Nothing here picks a number: every open owner question (inbox 2026-11-24-0933-territory-q2-questions.md, T-2..T-5)
// is a parameter. Since #209 the worlds use the decided rule V1 (`TERRITORY_V1` in `flocalplay-territory.mjs`). Amounts are milli-units per hour (upkeep) and
// whole units (claim cost, as BigInt-safe decimal strings or numbers). Arithmetic is BigInt, so "does not fit" is
// `null` exactly where the kernel says `None`.

export const TERRITORY_VERSION = 1;
export const MAX_TERRITORY_UPKEEP_PER_HOUR = 100_000_000n * 1000n;
export const MAX_CELLS = 1 << 20;
export const SRC_HOME = 1;
export const SRC_OWN = 2;
export const SRC_NATION_KEEPS = 4;
export const SRC_NATION_LAND = 8;
const BPS_ONE = 10_000n;
const U64_MAX = (1n << 64n) - 1n;

const big = v => BigInt(v ?? 0);
const fit = v => (v >= 0n && v <= MAX_TERRITORY_UPKEEP_PER_HOUR ? Number(v) : null);
const past = (d, free) => BigInt(Math.max(0, Number(d) - Number(free ?? 0)));

/** Upkeep of one cell of 0-based `rank` at `distance` (curve {flat, perRank, perDistance, freeDistance}). */
export function cellUpkeep(c, rank, distance) {
  return fit(big(c.flat) + big(c.perRank) * BigInt(rank) + big(c.perDistance) * past(distance, c.freeDistance));
}

/** Upkeep per hour of cells at `distances` (any order); null past MAX_CELLS or the cap. */
export function upkeepPerHour(c, distances) {
  const n = BigInt(distances.length);
  if (distances.length > MAX_CELLS) return null;
  let v = big(c.flat) * n + big(c.perRank) * (n > 0n ? (n * (n - 1n)) / 2n : 0n);
  for (const d of distances) {
    v += big(c.perDistance) * past(d, c.freeDistance);
    if (v > MAX_TERRITORY_UPKEEP_PER_HOUR) return null;
  }
  return fit(v);
}

/** The "+x / h" one more cell at `distance` adds (null if the total would not fit). */
export function upkeepDelta(c, distances, distance) {
  const before = upkeepPerHour(c, distances);
  const one = cellUpkeep(c, distances.length, distance);
  if (before == null || one == null) return null;
  return fit(BigInt(before) + BigInt(one)) == null ? null : one;
}

/** Price of the next claim while owning `owned` cells: base + base × owned × perOwnedBps / 10,000 (BigInt or null). */
export function claimCost(cost, owned) {
  const base = big(cost.base);
  const v = base + (base * BigInt(owned) * big(cost.perOwnedBps)) / BPS_ONE;
  return v <= U64_MAX ? v : null;
}

/** Distance to the nearest source the rule enables ({home, own, nationKeep, nationLand}, each number or null). */
export function reachDistance(reach, nearest) {
  const ds = [
    [SRC_HOME, nearest.home],
    [SRC_OWN, nearest.own],
    [SRC_NATION_KEEPS, nearest.nationKeep],
    [SRC_NATION_LAND, nearest.nationLand],
  ]
    .filter(([bit, d]) => (reach.sources & bit) !== 0 && d != null)
    .map(([, d]) => Number(d));
  return ds.length ? Math.min(...ds) : null;
}

/**
 * Judge a claim, in the kernel's order. params: {reach:{range, sources}, cost:{base, perOwnedBps}, claimsPerTurn,
 * claimOwned, unpaid:{blockClaims}}; check: {open, owner: 'nobody'|'claimer'|'other', nearest, owned,
 * claimsThisTurn, upkeepUnpaid, balance}. → {ok: BigInt cost} | {refused: name}.
 */
export function mayClaim(p, c) {
  if (!c.open) return { refused: 'NotOpen' };
  if (c.owner === 'claimer') return { refused: 'AlreadyYours' };
  if (c.owner === 'other' && !p.claimOwned) return { refused: 'Owned' };
  if (p.reach.range > 0) {
    const d = reachDistance(p.reach, c.nearest ?? {});
    if (d == null || d > p.reach.range) return { refused: 'Range' };
  }
  if (p.claimsPerTurn > 0 && c.claimsThisTurn >= p.claimsPerTurn) return { refused: 'TurnLimit' };
  if (c.upkeepUnpaid && p.unpaid?.blockClaims) return { refused: 'UpkeepUnpaid' };
  const cost = claimCost(p.cost, c.owned);
  if (cost == null) return { refused: 'Overflow' };
  if (big(c.balance) < cost) return { refused: 'Insufficient' };
  return { ok: cost };
}

/** What upkeep unpaid since bell `since` (null = paid) does at bell `now`. */
export function unpaidEffect(rule, since, now) {
  if (since == null) return { claimsBlocked: false, productionBps: 10_000, cellsReleased: 0 };
  const late = Math.max(0, now - since);
  const grace = rule.decayAfterBells;
  const cellsReleased = grace != null && late >= grace ? 1 + Math.floor((late - grace) / Math.max(1, rule.decayEveryBells)) : 0;
  return { claimsBlocked: !!rule.blockClaims, productionBps: rule.productionBps, cellsReleased };
}

/** Indices of `cells` ({id, distance, claimedBell}) in release order ('farthest' | 'newest'). */
export function releaseOrder(order, cells) {
  const key = c => (order === 'farthest' ? [c.distance, c.claimedBell, c.id] : [c.claimedBell, c.distance, c.id]);
  return cells
    .map((c, i) => [key(c), i])
    .sort(([a], [b]) => {
      for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return b[k] - a[k];
      return 0;
    })
    .map(([, i]) => i);
}

/** Most cells at one `distance` whose upkeep stays within `income` (milli/h); null = unbounded. */
export function naturalSize(c, income, distance) {
  const one = cellUpkeep(c, 0, distance);
  if (one == null) return null;
  if (one <= 0 && big(c.perRank) <= 0n) return null;
  const per = big(c.flat) + big(c.perDistance) * past(distance, c.freeDistance);
  const total = n => per * BigInt(n) + big(c.perRank) * (n > 0 ? (BigInt(n) * BigInt(n - 1)) / 2n : 0n);
  const inc = BigInt(income);
  let lo = 0;
  let hi = MAX_CELLS;
  if (total(hi) <= inc) return MAX_CELLS;
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (total(mid) <= inc) lo = mid;
    else hi = mid;
  }
  return lo;
}
