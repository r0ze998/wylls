// Observed route arithmetic, pinned to proc/wide_expedition_route.rs.
// No account transport, authority, sealing, signing or admission. Raw bytes
// establish a land's shape and identity, never its owner/address or freshness.
import { LAYOUTS } from '../sdk/frontier/abi-v2-layouts.mjs';
import { toHex } from '../sdk/bytes.mjs';
import { decode, decodePrefix } from './fcodec.mjs';
import { canonicalWideProvinceKey, decodeWideProvinceKey, traceWideDirections } from './fexpedition-seal.mjs';
import { worldIdOf, parseU64 } from './map/wide.mjs';
import { watchOf, wearBps, isCavalry } from './s1walk.mjs';
import { FLAT_HEX_SECS, ROUGH_HEX_SECS } from './fcaravan.mjs';
import { arrivalWindow } from './fmarch.mjs';
import { BELL_SECS, bellAt } from './clock.mjs';

const PV = LAYOUTS.accounts.find(a => a.kind === 'Province');
const field = name => PV.fields.find(f => f.name === name);
const STRUCTURES = field('STRUCTURES'), FORTS = field('FORTS');
const TRAILER = PV.size;
const U32 = 0xffffffff;
const observed = new WeakSet();
const closed = Object.freeze({ observationOnly: true, executable: false, admitted: false,
  sourceVerified: false, clockCoherent: false, terrainVerified: false, costVerified: false, arrivalVerified: false });
export class ExpeditionRouteError extends Error {
  constructor(code, detail = {}) { super(code); this.name = 'ExpeditionRouteError'; this.code = code; Object.assign(this, detail); }
}
const check = (ok, code, detail) => { if (!ok) throw new ExpeditionRouteError(code, detail); };
const uint = (x, max, code) => { check(Number.isInteger(x) && x >= 0 && x <= max, code); return x; };
const freeze = x => {
  if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
};
function sourcePin(source) {
  check(source && typeof source === 'object', 'SourceMissing');
  check(source.world === worldIdOf(source.season, source.program), 'WorldMismatch');
  return parseU64(String(source.seasonId), 'SeasonPinMismatch').toString();
}

/**
 * Decode the family selected by the full key, never by caller choice or magic.
 * `source` pins {program, season, world, seasonId}; `at` uses decimal p/q and
 * the canonical 50-byte key. Callers must separately verify capture metadata.
 * Throws ExpeditionRouteError (or the existing strict codec/geometry errors).
 */
export function routeLandFromBytes({ source, at, bytes }) {
  const seasonId = sourcePin(source);
  check(at && typeof at === 'object', 'LandIdentity');
  const key = canonicalWideProvinceKey({ world: source.world, p: at.p, q: at.q });
  check(at.key === key, 'LandIdentity');
  const identity = decodeWideProvinceKey(key), family = BigInt(identity.ring) <= 128n ? 'original' : 'wide';
  check(bytes instanceof Uint8Array, 'LandBytes');
  const b = Uint8Array.from(bytes), v = new DataView(b.buffer);
  check(b.length === (family === 'original' ? PV.size : TRAILER + 128), 'LandLength');
  check(v.getBigUint64(8, true).toString() === seasonId, 'SeasonPinMismatch');
  let province;
  if (family === 'original') {
    check(v.getUint16(16, true) === 2, 'LandVersion');
    province = decode('Province', b, { seasonId, profile: 2 });
    check(BigInt(province.p).toString() === at.p && BigInt(province.q).toString() === at.q, 'LandIdentity');
  } else {
    // frontier-abi world_index/land.rs::WideProvince::read, including the
    // exact readiness and zero reserved trailer bytes. The prefix is v2.
    check(String.fromCharCode(...b.subarray(0, 8)) === 'PSFXWPV1', 'LandMagic');
    check(v.getUint16(16, true) === 3 && v.getUint16(TRAILER, true) === 1, 'LandVersion');
    check(b[TRAILER + 2] === 1 && b[TRAILER + 3] === 15, 'LandNotReady');
    check(b.subarray(TRAILER + 53, TRAILER + 56).every(x => x === 0)
      && b.subarray(TRAILER + 104).every(x => x === 0), 'LandReserved');
    check(toHex(b.subarray(TRAILER + 4, TRAILER + 36)) === source.world, 'WorldMismatch');
    check(toHex(b.subarray(TRAILER + 36, TRAILER + 53)) === key.slice(66), 'LandIdentity');
    check(b.subarray(TRAILER + 64, TRAILER + 96).some(x => x !== 0), 'LandSeedMissing');
    province = decodePrefix('Province', b, { profile: 2 });
    check(province.p === 0 && province.q === 0 && province.ring === 0, 'LandLegacyPrefix');
    check(province.wedge === b[TRAILER + 44], 'LandWedge');
    // forts_at returns every live record, even an unmanned fort. Unknown
    // states and dirty inactive records must not imply an empty fort block.
    for (let i = 0; i < FORTS.len / 14; i++) {
      const r = b.subarray(FORTS.off + 14 * i, FORTS.off + 14 * (i + 1));
      check(r[3] === 1 || (r[3] === 0 && r.every(x => x === 0)), 'WideFortMalformed');
      check(r[3] !== 1, 'WideFortUnsupported');
    }
    check(b.subarray(STRUCTURES.off, STRUCTURES.off + STRUCTURES.len).every(x => x === 0), 'WideStructureUnsupported');
  }
  // Decode this small public list without allowing a caller-supplied watch
  // mask. Rust watch ignores empty/unknown kinds and invalid local tiles.
  const structures = Array.from({ length: STRUCTURES.len / 4 }, (_, i) => {
    const o = STRUCTURES.off + i * 4;
    return { kind: b[o], tile: b[o + 1], faction: b[o + 2], gen: b[o + 3] };
  });
  const land = freeze({ key, world: source.world, p: at.p, q: at.q, family, seasonId,
    passable: province.passableMask, rough: province.roughMask, road: province.roadMask, structures,
    ...closed });
  observed.add(land); return land;
}

function timestamp(value, fractional = false) {
  if (typeof value === 'number') {
    check(Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      && (fractional || Number.isInteger(value)), 'Timestamp');
    value = BigInt(Math.floor(value));
  } else {
    check(typeof value === 'bigint' || (typeof value === 'string' && /^(0|-?[1-9][0-9]{0,18})$/.test(value)), 'Timestamp');
    value = BigInt(value);
  }
  check(value >= -(1n << 63n) && value < (1n << 63n), 'Timestamp');
  return value;
}

/**
 * Cost and timing for an original standing host's chosen outbound steps.
 * `lands` must contain routeLandFromBytes outputs by canonical key. `source`
 * also carries origin, unit, faction and current original Holding holdingFlags.
 * `season` is the decoded Season, including its 36-byte stances and lead limits.
 * `departTs` is the proposed chain timestamp (caller adds fmarch.departMargin
 * to its observed clock). It is floored just as fmarch.earliestBell does.
 * A successful observation is still NOT an executable/admitted route.
 */
export function evaluateOutboundRoute({ source, directions, lands, season, departTs, arriveBell }) {
  const out = { ok: false, code: null, stepIndex: null, rawSecs: null, travelSecs: null, watchedSecs: null,
    wearBps: null, earliest: null, min: null, max: null, arrivalValid: false, ...closed };
  try {
    const seasonId = sourcePin(source);
    uint(source.unit, 7, 'Unit'); uint(source.faction, 5, 'Faction'); uint(source.holdingFlags, 255, 'HoldingFlagsMissing');
    check(String(season?.seasonId) === seasonId, 'SeasonPinMismatch');
    check(season.status === 3, 'SeasonNotRunning');
    uint(season.minLead, 255, 'LeadWindow'); uint(season.maxLead, 255, 'LeadWindow');
    check(season.minLead <= season.maxLead, 'LeadWindow'); uint(season.endBell, U32, 'EndBell');
    check((Array.isArray(season.stances) || season.stances instanceof Uint8Array) && season.stances.length === 36
      && Array.from(season.stances).every(x => Number.isInteger(x) && x >= 0 && x <= 255), 'SeasonStancesMissing');
    const route = traceWideDirections({ world: source.world, origin: source.origin, directions });
    check(route.pathComplete, 'EmptyPath');
    check(BigInt(route.origin.ring) <= 128n, 'OriginalOriginRequired');
    check(BigInt(route.endpoint.ring) > 128n, 'WideDestinationRequired');
    check(lands instanceof Map, 'RouteLandMissing');
    out.route = route;
    let raw = 0, watched = 0;
    for (let stepIndex = 0; stepIndex < route.steps.length; stepIndex++) {
      const tile = route.steps[stepIndex], l = lands.get(tile.key), detail = { stepIndex, key: tile.key };
      check(!!l, 'RouteLandMissing', detail);
      check(observed.has(l) && l.key === tile.key && l.world === source.world && l.seasonId === seasonId, 'RouteLandUnverified', detail);
      const watch = watchOf(l.structures, season.stances, source.faction, (source.holdingFlags & 4) !== 0);
      const bit = 1n << BigInt(tile.tile);
      check((l.passable & bit) !== 0n, 'RouteImpassable', detail);
      check((watch.block & bit) === 0n, 'RoutePalisade', detail);
      const base = (l.rough & bit) !== 0n ? ROUGH_HEX_SECS : FLAT_HEX_SECS;
      const secs = base >> (Number(isCavalry(source.unit)) + Number((l.road & bit) !== 0n));
      raw += secs; if ((watch.wear & bit) !== 0n) watched += secs;
    }
    // doctrine.rs::of_faction_v3 inherits E Lumen's 7,500 bps; all other
    // factions inherit 10,000. Wear counts raw watched seconds, not bias.
    const travel = Math.floor(raw * (source.faction === 4 ? 7500 : 10000) / 10000);
    Object.assign(out, { rawSecs: raw, travelSecs: travel, watchedSecs: watched, wearBps: wearBps(watched) });
    const genesis = timestamp(season.genesisTs), depart = timestamp(departTs, true), elapsed = depart - genesis;
    check(elapsed >= 0n, 'BeforeGenesis');
    check(elapsed / BigInt(BELL_SECS) <= BigInt(U32 - 72), 'BellOverflow');
    // Only a bounded relative time becomes Number, never a world coordinate
    // or full i64 timestamp. This preserves exact ceil at either i64 edge.
    const departBell = bellAt(0, Number(elapsed));
    check(depart + BigInt(travel) < (1n << 63n), 'TimestampOverflow');
    const up = Number((elapsed + BigInt(travel) + BigInt(BELL_SECS - 1)) / BigInt(BELL_SECS));
    const earliest = Math.max(up, departBell + 2);
    const window = arrivalWindow(season, departBell, earliest);
    const min = window.min, max = Math.min(window.max, departBell + 72, season.endBell - 1);
    Object.assign(out, { departBell, earliest, min, max });
    uint(arriveBell, U32, 'ArrivalRequired');
    check(departBell < season.endBell, 'SeasonEnded');
    check(min <= max, 'ArrivalWindowEmpty');
    check(arriveBell >= min, 'ArrivalTooEarly');
    check(arriveBell < season.endBell, 'ArrivalAfterSeason');
    check(arriveBell <= max, 'ArrivalTooLate');
    out.arrivalValid = true; out.ok = true;
  } catch (e) {
    out.code = e.code ?? 'RouteUnavailable';
    if (Number.isInteger(e.stepIndex)) out.stepIndex = e.stepIndex;
    if (typeof e.key === 'string') out.key = e.key;
  }
  return freeze(out);
}
