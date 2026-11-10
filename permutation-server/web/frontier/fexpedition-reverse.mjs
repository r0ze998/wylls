// Reverse boundary geography and reference travel arithmetic only.
// WidePlain can represent this geometry, but the current boundary runtime's
// OwnedBridgeTransit producer and route inspector accept original -> wide.
// No reverse producer, authority, arrival handler or transaction is implied.
import { decodeWideHostRef, decodeWideProvinceKey, traceWideDirections } from './fexpedition-seal.mjs';
import { routeLandFromBytes } from './fexpedition-route.mjs';
import { worldIdOf, parseU64 } from './map/wide.mjs';
import { seasonAddresses } from './faddr.mjs';
import { watchOf, wearBps, isCavalry } from './s1walk.mjs';
import { FLAT_HEX_SECS, ROUGH_HEX_SECS } from './fcaravan.mjs';
import { arrivalWindow } from './fmarch.mjs';
import { BELL_SECS } from './clock.mjs';

const U32 = 0xffffffff;
const CLOSED = Object.freeze({ observationOnly: true, complete: false, executable: false,
  admitted: false, signed: false, sealed: false, enqueued: false, publicDispatchAvailable: false,
  sourceResidentVerified: false, ownershipVerified: false, clockCoherent: false,
  terrainVerified: false, arrivalVerified: false, completionProven: false });
const UNRESOLVED = Object.freeze(['ReverseProducerUnavailable', 'ReverseOwnershipUnverified',
  'ReverseArrivalUnavailable', 'SnapshotAuthorityUnverified', 'PublicDispatchClosed']);
const check = (yes, code, detail = {}) => { if (!yes) throw Object.assign(new Error(code), { code, ...detail }); };
const uint = (x, max, code) => { check(Number.isInteger(x) && x >= 0 && x <= max, code); return x; };
const freeze = x => { if (x !== null && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
function timestamp(value) {
  if (typeof value === 'number') { check(Number.isSafeInteger(value), 'Timestamp'); value = BigInt(value); }
  else { check(typeof value === 'bigint' || (typeof value === 'string' && /^(0|-?[1-9][0-9]{0,18})$/.test(value)), 'Timestamp'); value = BigInt(value); }
  check(value >= -(1n << 63n) && value < (1n << 63n), 'Timestamp'); return value;
}

/**
 * Keep the ORIGINAL full host's issuer separate from its WIDE standing tile.
 * source is an explicit observation, not an outboundSource or a dense host id.
 * It must contain {program,season,seasonId,world,host,standing:{p,q,tile},
 * unit,faction,holdingFlags}. These last three values remain unverified input;
 * this module cannot resolve ownership or reconstruct missing source facts.
 * landBytes is a Map of canonical keys to exact original-v2/wide raw bytes.
 * At most four entered provinces are decoded, using the existing strict land
 * reader; absence never means passable. Origin is charged only if re-entered.
 *
 * Timing is explicitly a REFERENCE to existing travel and Season lead rules.
 * It is not a promise that a reverse arrival can be produced or admitted.
 * All world coordinates and timestamps remain exact. Output is immutable JSON.
 */
export function evaluateOriginalReverseRoute({ source, directions, landBytes, season, departTs, arriveBell } = {}) {
  const out = { kind: 'original-host-reverse-route-observation', status: 'refused', code: null,
    calculationComplete: false, route: null, source: null, stepIndex: null, key: null,
    rawSecs: null, travelSecs: null, watchedSecs: null, wearBps: null,
    referenceTiming: null, blockers: [...UNRESOLVED], ...CLOSED };
  try {
    check(source && typeof source === 'object', 'ReverseSourceMissing');
    const seasonId = parseU64(source.seasonId, 'SeasonPinMismatch').toString();
    check(seasonAddresses(source.program, seasonId).season === source.season, 'SeasonPinMismatch');
    check(source.world === worldIdOf(source.season, source.program), 'WorldMismatch');
    const host = decodeWideHostRef(source.host);
    check(host.world === source.world, 'WorldMismatch');
    check(BigInt(host.ring) <= 128n, 'OriginalHostRequired');
    check(source.standing && !Object.hasOwn(source, 'origin'), 'WideStandingRequired');
    const route = traceWideDirections({ world: source.world, origin: source.standing, directions });
    check(BigInt(route.origin.ring) > 128n, 'WideStandingRequired');
    check(route.pathComplete, 'EmptyPath');
    out.route = route;
    check(BigInt(route.endpoint.ring) <= 128n, 'OriginalDestinationRequired');
    // No requirement that the chosen original endpoint is the issuing village:
    // a land route does not itself return troops to that village's reserve.
    out.source = { program: source.program, season: source.season, seasonId, world: source.world,
      host: source.host, issuer: { p: host.p, q: host.q, site: host.site, gen: host.gen, seq: host.seq },
      standing: { p: route.origin.p, q: route.origin.q, tile: route.origin.tile } };
    uint(source.unit, 7, 'SourceUnitUnavailable'); uint(source.faction, 5, 'SourceFactionUnavailable');
    uint(source.holdingFlags, 255, 'SourceHoldingFlagsUnavailable');
    Object.assign(out.source, { unit: source.unit, faction: source.faction, holdingFlags: source.holdingFlags });
    check(String(season?.seasonId) === seasonId, 'SeasonPinMismatch');
    check(season.status === 3, 'SeasonNotRunning');
    uint(season.minLead, 255, 'LeadWindow'); uint(season.maxLead, 255, 'LeadWindow');
    check(season.minLead <= season.maxLead, 'LeadWindow'); uint(season.endBell, U32, 'EndBell');
    check((Array.isArray(season.stances) || season.stances instanceof Uint8Array) && season.stances.length === 36
      && Array.from(season.stances).every(x => Number.isInteger(x) && x >= 0 && x <= 255), 'SeasonStancesMissing');
    check(landBytes instanceof Map, 'RouteLandMissing');
    const lands = new Map();
    for (const key of route.accountKeys) {
      const bytes = landBytes.get(key), at = decodeWideProvinceKey(key);
      check(bytes instanceof Uint8Array, 'RouteLandMissing', { key });
      try { lands.set(key, routeLandFromBytes({ source, at, bytes })); }
      catch (e) { throw Object.assign(e, { key }); }
    }
    let raw = 0, watched = 0;
    for (let stepIndex = 0; stepIndex < route.steps.length; stepIndex++) {
      const tile = route.steps[stepIndex], land = lands.get(tile.key), bit = 1n << BigInt(tile.tile);
      const detail = { stepIndex, key: tile.key };
      const watch = watchOf(land.structures, season.stances, source.faction, (source.holdingFlags & 4) !== 0);
      check((land.passable & bit) !== 0n, 'RouteImpassable', detail);
      check((watch.block & bit) === 0n, 'RoutePalisade', detail);
      const base = (land.rough & bit) !== 0n ? ROUGH_HEX_SECS : FLAT_HEX_SECS;
      const secs = base >> (Number(isCavalry(source.unit)) + Number((land.road & bit) !== 0n));
      raw += secs; if ((watch.wear & bit) !== 0n) watched += secs;
    }
    // Same pure land/walk, doctrine and wear formulas as the boundary route
    // candidate. Calling its outbound-only inspect/producer is deliberately
    // impossible here: no fake original standing source is constructed.
    const travel = Math.floor(raw * (source.faction === 4 ? 7500 : 10000) / 10000);
    Object.assign(out, { rawSecs: raw, travelSecs: travel, watchedSecs: watched, wearBps: wearBps(watched) });
    const genesis = timestamp(season.genesisTs), depart = timestamp(departTs), elapsed = depart - genesis;
    check(elapsed >= 0n, 'BeforeGenesis');
    check(elapsed / BigInt(BELL_SECS) <= BigInt(U32 - 72), 'BellOverflow');
    check(depart + BigInt(travel) < (1n << 63n), 'TimestampOverflow');
    const departBell = Number(elapsed / BigInt(BELL_SECS));
    const earliest = Math.max(Number((elapsed + BigInt(travel) + BigInt(BELL_SECS - 1)) / BigInt(BELL_SECS)), departBell + 2);
    const window = arrivalWindow(season, departBell, earliest);
    const min = window.min, max = Math.min(window.max, departBell + 72, season.endBell - 1);
    out.referenceTiming = { basis: 'existing-travel-and-season-lead-rules', departTs: depart.toString(),
      departBell, earliest, min, max, arriveBell: null, withinWindow: false, reverseArrivalVerified: false };
    check(departBell < season.endBell, 'SeasonEnded'); check(min <= max, 'ArrivalWindowEmpty');
    uint(arriveBell, U32, 'ArrivalRequired'); out.referenceTiming.arriveBell = arriveBell;
    check(arriveBell >= min, 'ArrivalTooEarly'); check(arriveBell < season.endBell, 'ArrivalAfterSeason');
    check(arriveBell <= max, 'ArrivalTooLate');
    out.referenceTiming.withinWindow = true;
    out.calculationComplete = true; out.status = 'incomplete';
  } catch (e) {
    out.code = e.code ?? 'ReverseRouteUnavailable';
    if (Number.isInteger(e.stepIndex)) out.stepIndex = e.stepIndex;
    if (typeof e.key === 'string') out.key = e.key;
  }
  return freeze(out);
}
