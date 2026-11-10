// Observed original-source checks from wide_expedition_exec::stage_depart,
// frontier_abi::prologue and rules::host. No dispatch, signature or sealer.
import { decode } from './fcodec.mjs';
import { hostParts, hostId, seasonAddresses } from './faddr.mjs';
import { canonicalOutboundRoles } from './fexpedition-depart.mjs';
import { parseU64, ringPosition } from './map/wide.mjs';
import { encode } from '../sdk/base58.mjs';
import { toHex } from '../sdk/bytes.mjs';
import { minTipLamports } from '../sdk/frontier/fees.mjs';
import { LAYOUTS } from '../sdk/frontier/abi-v2-layouts.mjs';

const U32 = 0xffffffff, I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;
const HOLDING = LAYOUTS.accounts.find(x => x.kind === 'Holding');
const TRANSIT = HOLDING.fields.find(x => x.name === 'TRANSIT').off;
const ENTRY_COUNT = Number(/ x(\d+)$/.exec(LAYOUTS.accounts.find(x => x.kind === 'Province').fields.find(x => x.name === 'ENTRIES').ty)[1]);
const closed = Object.freeze({ observationOnly: true, executable: false, admitted: false,
  authorityVerified: false, coherentSnapshotVerified: false, sourceVerified: false,
  signed: false, sealed: false, publicDispatchAvailable: false });
const check = (ok, code = 'BadAccount') => { if (!ok) throw Object.assign(new Error(code), { code }); };
const uint = (x, max = U32, code = 'BadAccount') => { check(Number.isInteger(x) && x >= 0 && x <= max, code); return x; };
const exact = (x, min, max, code = 'BadAccount') => {
  check(typeof x === 'bigint' || (typeof x === 'number' && Number.isSafeInteger(x))
    || (typeof x === 'string' && /^(0|-?[1-9][0-9]*)$/.test(x) && x.length <= 20), code);
  const n = BigInt(x); check(n >= min && n <= max, code); return n;
};
const i64 = (x, code) => exact(x, I64_MIN, I64_MAX, code);
const u64 = (x, code) => exact(x, 0n, (1n << 64n) - 1n, code);
const address = x => { check(x instanceof Uint8Array && x.length === 32); return encode(x); };
function account(kind, value, sid) {
  check(!!value, 'SourceObservationMissing');
  const a = value instanceof Uint8Array ? decode(kind, value, { seasonId: sid, profile: 2 }) : value;
  check(a.kind === kind && a.layoutVersion === 2);
  check(u64(a.seasonId).toString() === sid, 'SeasonMismatch');
  return a;
}
function original(p, q, code = 'BadAccount') {
  check(Number.isInteger(p) && Number.isInteger(q) && Math.abs(p) <= 128 && Math.abs(q) <= 128, code);
  check(ringPosition(BigInt(p), BigInt(q)).ring <= 128n, code);
}
const sameHome = (a, b) => a && b && ['p', 'q'].every(k => String(a[k]) === String(b[k]))
  && ['site', 'gen'].every(k => a[k] === b[k]);

// All four slots are validated before checking for this host. Decoded bridge
// records omit reserved/version bytes, so a state-4 slot needs raw Holding
// bytes; without them its occupancy is unknown, never free. Marker rules are
// expedition_bridge::BridgeMarker::from_bytes + prologue::transit_occupancy.
function occupancy(holding, raw, issuer) {
  check(Array.isArray(holding.transit) && holding.transit.length === 4);
  return holding.transit.map((t, slot) => {
    uint(t.state, 4, 'BadData');
    if (t.state === 0) return { state: 0, id: null };
    const id = u64(t.hostId, 'BadData');
    if (t.state === 4) {
      check(raw instanceof Uint8Array, 'TransitObservationUnavailable');
      const b = raw.subarray(TRANSIT + slot * 96, TRANSIT + (slot + 1) * 96);
      check(b.length === 96 && b[93] === 1 && b.subarray(94).every(x => x === 0)
        && b.subarray(40, 48).every(x => x === 0) && b.subarray(89, 93).every(x => x === 0)
        && (b[88] & ~3) === 0, 'BadData');
      const parts = hostParts(id);
      check(parts && hostId(parts) === id && ['p', 'q', 'site'].every(k => parts[k] === issuer[k]), 'BadData');
      original(t.originP, t.originQ, 'BadData');
      uint(t.originTile, 60, 'BadData'); uint(t.unit, 7, 'BadData'); uint(t.faction, 5, 'BadData');
      const depart = uint(t.departBell, U32 - 72, 'BadData'), arrive = uint(t.arriveBell, U32, 'BadData');
      check(arrive >= depart + 2 && arrive <= depart + 72, 'BadData');
    }
    return { state: t.state, id };
  });
}

/**
 * source: outboundSource's public pins, hostId/full host, home and origin.
 * Accounts may be fcodec decoded v2 objects or exact Uint8Array account bytes.
 * Clock is {unixTimestamp: exact i64} or the 40-byte Solana Clock sysvar.
 * ownProvince is required when standing away from home; no global scan occurs.
 * host is optional; the authoritative observation for this calculation is the
 * matching Entry inside province, and a separately supplied host must agree.
 * arrival is checked against stage_depart's actual b+2..b+72 and end_bell;
 * route travel/season composer lead policy remain evaluateOutboundRoute's job.
 * A successful result only means these observed fields pass these checks.
 */
export function evaluateOriginalOutboundReady(input = {}) {
  const out = { ok: false, code: null, problems: [], nowBell: null, finality: null,
    stamina: null, transitSlot: null, arrival: null, sealSchedule: null, minTip: null,
    bucket: null, unchecked: ['AccountOwnerAndFreshness', 'SignatureAndSessionAuthority',
      'RouteTravel', 'BeaconAuthenticationAndSeal', 'ExternalSlotAbsence', 'PayerBalanceAndRent',
      'PublicDispatch'], ...closed };
  try {
    const { source, arriveBell, tip } = input;
    check(source && typeof source === 'object', 'SourceObservationMissing');
    const sid = parseU64(String(source.seasonId), 'SeasonMismatch').toString();
    const season = account('Season', input.season, sid), citizen = account('Citizen', input.citizen, sid);
    const holding = account('Holding', input.holding, sid), province = account('Province', input.province, sid);
    const homeStanding = province.p === holding.p && province.q === holding.q;
    const ownProvince = input.ownProvince === undefined && homeStanding ? province : account('Province', input.ownProvince, sid);
    const rawHolding = input.holding instanceof Uint8Array ? input.holding : null;
    const clock = input.clock;
    check(clock && (!(clock instanceof Uint8Array) || clock.length === 40), 'ClockObservationMissing');
    const now = clock instanceof Uint8Array
      ? new DataView(clock.buffer, clock.byteOffset, clock.byteLength).getBigInt64(32, true)
      : i64(clock.unixTimestamp, 'ClockObservationMissing');
    const genesis = i64(season.genesisTs), elapsed = now - genesis;
    const status = season.status === 2 && now >= genesis ? 3 : season.status;
    check(status === 3 && elapsed >= 0n && elapsed <= I64_MAX && elapsed / 600n <= BigInt(U32), 'WrongStatus');
    const bell = Number(elapsed / 600n); out.nowBell = bell;
    const end = uint(season.endBell);
    check(bell < end, 'WrongStatus');
    check(uint(season.programVersion, 65535) === source.programVersion && (season.programVersion & 0x4000) !== 0,
      'RulesetMismatch');
    check(season.rulesetHash instanceof Uint8Array && season.rulesetHash.length === 32
      && /^[0-9a-f]{64}$/.test(source.ruleset) && toHex(season.rulesetHash) === source.ruleset, 'RulesetMismatch');
    check(!Object.hasOwn(citizen, 'residentAsset'), 'WalletResidentRequired');
    check(address(citizen.wallet) === source.wallet, 'NotOwner');
    const id = parseU64(source.hostId, 'BadAccount'), parts = hostParts(id);
    check(parts && hostId(parts) === id);
    // This also checks world, full host, original origin and canonical issuer
    // addresses against the pinned wallet Citizen. It proves no authority.
    canonicalOutboundRoles({ ...source, home: { ...parts, p: String(parts.p), q: String(parts.q) } }, { transitSlot: 0 });
    if (source.home !== undefined) check(sameHome(source.home, parts) && source.home.seq === parts.seq, 'NotOwner');
    const a = seasonAddresses(source.program, sid);
    check(a.season === source.season, 'BadAddress');
    check(address(holding.ownerCitizen) === source.original_owner && sameHome(holding, parts), 'NotOwner');
    check(uint(holding.hostSeq) > parts.seq);
    original(province.p, province.q); original(ownProvince.p, ownProvince.q);
    check(String(province.p) === source.origin.p && String(province.q) === source.origin.q, 'NotResident');
    check(ownProvince.p === holding.p && ownProvince.q === holding.q, 'BadAddress');
    const order = uint(holding.order, 3); check(order >= 1);
    check(Array.isArray(citizen.holding) && citizen.holding.length === 3 && sameHome(citizen.holding[order - 1], holding), 'NotOwner');
    uint(holding.state, 255); uint(holding.site, 11); uint(holding.gen, 255);
    check(Array.isArray(ownProvince.siteMirror) && ownProvince.siteMirror.length === 12);
    const mirror = ownProvince.siteMirror[holding.site]; uint(mirror.state, 255); uint(mirror.gen, 255);
    check(!([1, 2].includes(holding.state) && mirror.state === 1 && mirror.gen === ((holding.gen + 1) & 255)), 'CapturePending');
    let lazy = false;
    if (holding.state === 1 && homeStanding && now >= i64(holding.finalTs)) {
      const ticket = uint(holding.ticketBell);
      let cohortClosed = bell >= Math.min(U32, ticket + 24);
      if (!cohortClosed) {
        check(Array.isArray(province.ticketCohorts) && province.ticketCohorts.length === 8);
        cohortClosed = province.ticketCohorts.every(c => {
          uint(c.bell); uint(c.filed, 65535); uint(c.settled, 65535);
          return c.bell !== ticket || c.filed === 0 || c.settled >= c.filed;
        });
      }
      lazy = cohortClosed;
    }
    out.finality = { storedState: holding.state, lazyDue: lazy, observedFinal: holding.state === 2 || lazy,
      citizenFlagsWouldChange: lazy && order === 1 };
    check(out.finality.observedFinal, 'NotFinal');
    const resolved = uint(province.resolvedNext);
    check(resolved + 1 >= bell, 'NotResident');
    const slots = occupancy(holding, rawHolding, parts);
    check(!slots.some(t => t.state !== 0 && t.id === id), 'HostInTransit');
    check(Array.isArray(province.entries) && province.entries.length === ENTRY_COUNT);
    const matches = province.entries.filter(e => e.state !== 0 && u64(e.id) === id);
    check(matches.length === 1, 'NotResident');
    const entry = matches[0];
    check(entry.state === 1, 'NotResident');
    uint(entry.pendOp, 6); check(entry.pendOp === 0, 'HostBusy');
    uint(entry.unit, 7); uint(entry.faction, 5); uint(entry.tile, 60); uint(entry.troops);
    check(entry.unit === source.unit && entry.faction === source.faction && entry.tile === source.origin.tile, 'SourceChanged');
    if (input.host) for (const field of ['id', 'state', 'pendOp', 'pendBell', 'unit', 'faction', 'tile', 'troops', 'readyBell', 'staminaValue', 'staminaBell']) {
      check(String(input.host[field]) === String(entry[field]), 'SourceChanged');
    }
    const stored = uint(entry.staminaValue, 65535), at = uint(entry.staminaBell), ready = uint(entry.readyBell);
    const available = bell <= at ? stored : Math.min(120, stored + bell - at);
    out.stamina = { stored, storedBell: at, available, required: 74, readyBell: ready,
      restBells: Math.max(0, ready - bell, available >= 74 ? 0 : Math.max(0, at - bell) + 74 - available) };
    check(bell >= ready && available >= 74, 'Cooldown');
    check(bell <= U32 - 72, 'Overflow');
    out.arrival = { min: bell + 2, max: Math.min(bell + 72, end - 1), arriveBell };
    uint(arriveBell, U32, 'ArrivalBell');
    check(arriveBell >= out.arrival.min && arriveBell <= out.arrival.max, 'ArrivalBell');
    const minimum = minTipLamports(uint(season.minRevealPriorityMilli), uint(season.revealCuLimit), uint(season.revealLoadedLimit));
    out.minTip = minimum.toString();
    check(u64(tip, 'TipTooLow') >= minimum, 'TipTooLow');
    const selected = input.transitSlot ?? slots.findIndex(t => t.state === 0);
    check(Number.isInteger(selected) && selected >= 0 && selected < 4 && slots[selected].state === 0, 'TransitState');
    out.transitSlot = selected;
    // PlayerStart::finish debits this bucket only after staging. Here it is
    // arithmetic over observations; neither Citizen nor any account changes.
    const milli = BigInt(uint(citizen.bucketMilli)), since = BigInt(uint(citizen.bucketT));
    const rate = BigInt(uint(season.bucketRatePerH, 65535)), cap = BigInt(uint(season.bucketBurst, 65535)) * 1000n;
    const refill = rate * 1000n * (elapsed > since ? elapsed - since : 0n) / 3600n;
    const have = milli + refill < cap ? milli + refill : cap;
    out.bucket = { availableMilli: have.toString(), requiredMilli: '1000' };
    check(have >= 1000n, 'Bucket'); check(elapsed <= BigInt(U32), 'Overflow');
    // Public T(arrive_bell), rules::beacon first_round_from/round_time.
    // No seal is supplied, created, opened, checked or made usable here.
    const dg = i64(season.drandGenesis, 'SealScheduleUnavailable');
    const period = BigInt(Math.max(1, uint(season.drandPeriod, U32, 'SealScheduleUnavailable')));
    const arrivalEnd = genesis + 600n * (BigInt(arriveBell) + 1n);
    check(arrivalEnd <= I64_MAX && arrivalEnd >= I64_MIN, 'Overflow');
    const round = arrivalEnd <= dg ? 1n : (arrivalEnd - dg + period - 1n) / period + 1n;
    check(round <= (1n << 64n) - 1n, 'Overflow');
    const roundTs = dg + (round - 1n) * period;
    check(roundTs <= I64_MAX, 'Overflow');
    out.sealSchedule = { round: round.toString(), roundTs: roundTs.toString(), arrivalEnd: arrivalEnd.toString(),
      future: roundTs > now, verified: false };
    check(roundTs > now, 'ArrivalBell');
    out.ok = true;
  } catch (e) { out.code = e.code ?? 'BadAccount'; out.problems.push(out.code); }
  for (const name of ['problems', 'unchecked', 'finality', 'stamina', 'arrival', 'sealSchedule', 'bucket']) {
    if (out[name]) Object.freeze(out[name]);
  }
  return Object.freeze(out);
}
