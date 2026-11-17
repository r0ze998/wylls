// Map growth as the page can read it (2026-11-18): READ ONLY, for the provisional first-village draw (fhome-draw.mjs).
//
// The existing rule (permutation-frontier proc/map.rs extend_frontier, 0xC1 ExtendFrontier, unchanged): the Season's
// outermost ring grows by one, up to its r_max_ceiling, when
//   (1) the Season has a ceiling above its effective r_max            (BadData without one, AlreadyDone at it)
//   (2) every ring up to the effective r_max is opened                (TooEarly)
//   (3) the Season's end bell is not reached                          (WrongStatus)
//   (4) a bell has passed since the last ring opening                 (TooEarly)
//   (5) some wedge is at θ occupancy on the folded values             (Capacity; θ early or late by now − genesis_ts)
// Ring d is then opened by OpenRing as any other ring (its own conditions and its ring seed round).
//
// What is read here: the herald's season record (`rMax`, `rMaxCeiling`, `ringsOpened`, `wedgeOpen`, `wedgeOccupied`,
// `genesisTs`, `latestUnix`) and the decoded Season (`thetaEarlyBps`, `thetaLateBps`, `thetaSwitchSecs`, `endBell`).
// The Frontier's LAST_RING_OPEN_BELL is not in the record, so (4) is always "not read". Time is the herald's
// latestUnix and the caller's herald bell, never the local clock.
//
// What is NOT connected (no rule is made up for it): sending ExtendFrontier or OpenRing (who sends, who pays the rent,
// any fee), a cap or cost beyond the program's own, any announcement, and exploration growing the map: the existing
// Explore (a Scout's tiles, contract §5.10) finds things on open land and opens no ring. The owner's "the map grows by
// exploration" has no adopted rule yet.
const int = Number.isInteger;
const BPS_ONE = 10000;

/** proc/map.rs ring_occupancy_met: some wedge with open sites has occupied × 10,000 ≥ θ × open. */
export function ringOccupancyMet(occupied, open, thetaBps) {
  if (!Array.isArray(occupied) || !Array.isArray(open) || occupied.length !== 6 || open.length !== 6 || !int(thetaBps)) return null;
  if (![...occupied, ...open].every(x => int(x) && x >= 0)) return null;
  return open.some((o, w) => o > 0 && occupied[w] * BPS_ONE >= thetaBps * o);
}

export const GROWTH = Object.freeze({ none: 'none', unmet: 'unmet', maybe: 'maybe', unknown: 'unknown' });
export const NOT_CONNECTED = Object.freeze([
  'sending ExtendFrontier or OpenRing: who sends, who pays, any fee (no wrapper here)',
  'a cost or a cap beyond the program\'s own ceiling',
  'growth by exploration: Explore opens no ring; no rule is adopted',
  'any announcement of a new ring',
]);

/**
 * → {state: GROWTH.*, rMax, ceiling, nextRing, conditions: [{id, met: true|false|null, why}], notConnected}
 *   none     the Season cannot grow (no ceiling, at it, or ended)
 *   unmet    a condition read is not met now
 *   maybe    every condition read is met; one or more are not read (never "it will grow")
 *   unknown  the record is not read
 */
export function growthView({ record, season, nowBell = null } = {}) {
  const c = [];
  const out = (state, extra = {}) => Object.freeze({ state, ...extra, conditions: Object.freeze(c.map(Object.freeze)), notConnected: NOT_CONNECTED });
  if (!record || typeof record !== 'object' || !int(record.rMax)) return out(GROWTH.unknown, { rMax: null, ceiling: null, nextRing: null });
  const rMax = record.rMax, ceiling = int(record.rMaxCeiling) ? record.rMaxCeiling : null;
  const base = { rMax, ceiling, nextRing: null };
  if (ceiling === null) { c.push({ id: 'ceiling', met: null, why: 'the ceiling is not read' }); return out(GROWTH.unknown, base); }
  if (ceiling === 0) { c.push({ id: 'ceiling', met: false, why: 'this Season has no ceiling: its map does not grow' }); return out(GROWTH.none, base); }
  if (ceiling <= rMax) { c.push({ id: 'ceiling', met: false, why: `the map is at its ceiling (ring ${ceiling})` }); return out(GROWTH.none, base); }
  c.push({ id: 'ceiling', met: true, why: `ring ${rMax + 1} is within the ceiling (ring ${ceiling})` });
  const next = { ...base, nextRing: rMax + 1 };
  const endBell = Number(season?.endBell);
  if (!int(nowBell) || !Number.isSafeInteger(endBell)) c.push({ id: 'end', met: null, why: 'the herald turn or the end is not read' });
  else if (nowBell >= endBell) { c.push({ id: 'end', met: false, why: 'the Season has reached its end: the map no longer grows' }); return out(GROWTH.none, next); }
  else c.push({ id: 'end', met: true, why: 'before the Season\'s end' });
  if (!int(record.ringsOpened)) c.push({ id: 'opened', met: null, why: 'the opened rings are not read' });
  else c.push({ id: 'opened', met: record.ringsOpened === rMax + 1, why: record.ringsOpened === rMax + 1 ? 'every ring up to the edge is opened' : `rings up to ${rMax} are not all opened yet` });
  c.push({ id: 'sinceLast', met: null, why: 'the last ring opening is not in the season record (Frontier LAST_RING_OPEN_BELL)' });
  const g = Number(record.genesisTs), t = Number(record.latestUnix), sw = Number(season?.thetaSwitchSecs);
  const early = season?.thetaEarlyBps, late = season?.thetaLateBps;
  let theta = null;
  if (Number.isSafeInteger(g) && Number.isSafeInteger(t) && t > 0 && Number.isSafeInteger(sw) && int(early) && int(late)) theta = t - g < sw ? early : late;
  const occ = theta === null ? null : ringOccupancyMet(record.wedgeOccupied, record.wedgeOpen, theta);
  if (occ === null) c.push({ id: 'crowding', met: null, why: 'the folded wedge counts or θ are not read' });
  else c.push({ id: 'crowding', met: occ, why: occ ? 'some nation\'s land is crowded enough' : 'no nation\'s land is crowded enough yet' });
  if (c.some(x => x.met === false)) return out(GROWTH.unmet, next);
  return out(GROWTH.maybe, next);
}
