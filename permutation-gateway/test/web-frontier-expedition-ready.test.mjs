// Literal public observations only; run this one file under both no-key guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { originalHostRef } from '../../permutation-server/web/frontier/fexpedition.mjs';
import { evaluateOriginalOutboundReady } from '../../permutation-server/web/frontier/fexpedition-ready.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const A = seasonAddresses(PROGRAM, '7'), OWNER = A.of('Citizen', { wallet: WALLET });
const WORLD = worldIdOf(A.season, PROGRAM), GENESIS = 1800000000n;
const HOME = { p: 128, q: 0, site: 3, gen: 1, seq: 0 }, ID = hostId(HOME);
const raw = (kind, fields) => encodeAccount(kind, { LAYOUT_VERSION: 2, SEASON_ID: 7n, ...fields }, { profile: 2 });
const acct = (kind, fields) => decode(kind, raw(kind, fields));
function fixture() {
  const season = acct('Season', { PROGRAM_VERSION: 16388, RULESET_HASH: new Uint8Array(32).fill(1), STATUS: 3,
    GENESIS_TS: GENESIS, END_BELL: 1000, MIN_LEAD: 2, MAX_LEAD: 72,
    MIN_REVEAL_PRIORITY_MILLI: 433, REVEAL_CU_LIMIT: 26000, REVEAL_LOADED_LIMIT: 1048576,
    DRAND_GENESIS: 1692803367n, DRAND_PERIOD: 3, BUCKET_RATE_PER_H: 120, BUCKET_BURST: 4 });
  const citizen = acct('Citizen', { WALLET: fromB58(WALLET), FLAGS: 5, BUCKET_MILLI: 4000, BUCKET_T: 6000,
    HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] });
  const holding = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, ORDER: 1, STATE: 2, HOST_SEQ: 1,
    OWNER_CITIZEN: fromB58(OWNER), FINAL_TS: GENESIS + 6000n, TICKET_BELL: 8 });
  const province = acct('Province', { P: 128, Q: 0, RING: 128, RESOLVED_NEXT: 9,
    SITE_MIRROR: [{}, {}, {}, { STATE: 1, GEN: 1 }],
    ENTRIES: [{ ID, STATE: 1, UNIT: 0, FACTION: 0, TILE: 60, TROOPS: 600000, STAMINA_VALUE: 74, STAMINA_BELL: 10, READY_BELL: 10 }] });
  const source = { program: PROGRAM, season: A.season, seasonId: '7', wallet: WALLET, payer: WALLET,
    original_owner: OWNER, world: WORLD, host: originalHostRef(WORLD, ID.toString()), hostId: ID.toString(),
    origin: { p: '128', q: '0', tile: 60 }, home: { ...HOME, p: '128', q: '0' },
    holding: A.of('Holding', HOME), unit: 0, faction: 0, programVersion: 16388, ruleset: '01'.repeat(32) };
  return { source, season, citizen, holding, province, clock: { unixTimestamp: GENESIS + 6000n }, arriveBell: 12, tip: '14441' };
}
function closed(r) {
  assert.equal(r.observationOnly, true);
  for (const k of ['executable', 'admitted', 'authorityVerified', 'coherentSnapshotVerified', 'sourceVerified', 'signed', 'sealed', 'publicDispatchAvailable']) assert.equal(r[k], false);
  assert.ok(Object.isFrozen(r));
}
const evaluate = f => { const r = evaluateOriginalOutboundReady(f); closed(r); return r; };
const reject = (code, change) => { const f = fixture(); change(f); assert.equal(evaluate(f).code, code); };

test('original source observation matches stage_depart thresholds without mutation or authority', () => {
  const f = fixture(), before = structuredClone(f), r = evaluate(f);
  assert.equal(r.ok, true, r.code); assert.equal(r.nowBell, 10); assert.equal(r.transitSlot, 0);
  assert.equal(r.finality.observedFinal, true); assert.equal(r.finality.lazyDue, false);
  assert.deepEqual(r.stamina, { stored: 74, storedBell: 10, available: 74, required: 74, readyBell: 10, restBells: 0 });
  assert.deepEqual(r.arrival, { min: 12, max: 82, arriveBell: 12 });
  assert.equal(r.minTip, '14441'); assert.equal(r.sealSchedule.arrivalEnd, '1800007800');
  assert.equal(r.sealSchedule.round, '35734812'); assert.equal(r.sealSchedule.roundTs, '1800007800');
  assert.deepEqual(f, before); assert.ok(r.unchecked.includes('PublicDispatch'));
});

test('lazy finality requires home standing, elapsed time and closed or expired ticket cohorts', () => {
  const f = fixture(); f.holding.state = 1; f.citizen.flags = 3;
  f.province.ticketCohorts[0] = { bell: 8, filed: 2, settled: 1 };
  assert.equal(evaluate(f).code, 'NotFinal');
  f.province.ticketCohorts[0].settled = 2;
  const r = evaluate(f); assert.equal(r.ok, true, r.code); assert.equal(r.finality.lazyDue, true);
  assert.equal(r.finality.citizenFlagsWouldChange, true); assert.equal(f.holding.state, 1); assert.equal(f.citizen.flags, 3);
  f.holding.finalTs++; assert.equal(evaluate(f).code, 'NotFinal'); f.holding.finalTs--;
  f.province.ticketCohorts[0].settled = 0; f.holding.ticketBell = 0;
  f.clock.unixTimestamp = GENESIS + 24n * 600n; f.province.resolvedNext = 23; f.arriveBell = 26;
  assert.equal(evaluate(f).ok, true);
  delete f.province.ticketCohorts; f.holding.ticketBell = 23;
  assert.equal(evaluate(f).code, 'BadAccount');
  const away = fixture(); away.holding.state = 1; away.ownProvince = structuredClone(away.province);
  away.province.p = 127; away.source.origin.p = '127';
  assert.equal(evaluate(away).code, 'NotFinal');
});

test('issuer, citizen slot, capture lock and observed host identity cannot be substituted', () => {
  reject('NotOwner', f => { f.citizen.holding[0].gen++; });
  reject('NotOwner', f => { f.holding.gen++; });
  reject('BadAccount', f => { f.holding.hostSeq = 0; });
  reject('CapturePending', f => { f.province.siteMirror[3].gen = 2; });
  reject('CapturePending', f => { f.holding.gen = 255; f.citizen.holding[0].gen = 255;
    const parts = { ...HOME, gen: 255 }; const id = hostId(parts); f.source.hostId = id.toString();
    f.source.host = originalHostRef(WORLD, id.toString()); f.source.home.gen = 255;
    f.province.entries[0].id = id; f.province.siteMirror[3].gen = 0; });
  reject('SourceChanged', f => { f.host = { ...f.province.entries[0], staminaValue: 100 }; });
  reject('NotResident', f => { f.province.entries[1] = { ...f.province.entries[0] }; });
  reject('SourceObservationMissing', f => { f.province.p = 127; f.source.origin.p = '127'; });
  reject('WalletResidentRequired', f => { f.citizen.residentAsset = null; });
});

test('resolution, all pending operations, transit occupancy and free slot use actual refusal codes', () => {
  reject('NotResident', f => { f.province.resolvedNext = 8; });
  reject('NotResident', f => { f.province.entries[0].state = 2; });
  for (let op = 1; op <= 6; op++) reject('HostBusy', f => { f.province.entries[0].pendOp = op; });
  for (let state = 1; state <= 3; state++) reject('HostInTransit', f => { Object.assign(f.holding.transit[0], { state, hostId: ID }); });
  reject('BadData', f => { f.holding.transit[3].state = 5; });
  reject('TransitObservationUnavailable', f => { f.holding.transit[3].state = 4; });
  reject('TransitState', f => { f.holding.transit.forEach(t => Object.assign(t, { state: 1, hostId: ID + 1n })); });
  reject('TransitState', f => { f.transitSlot = 4; });
  const f = fixture(); f.holding.transit[0].state = 1; f.holding.transit[0].hostId = ID + 1n;
  assert.equal(evaluate(f).transitSlot, 1);
});

test('stamina lazily refills at bells, charges 74 and reports exact remaining rest', () => {
  reject('Cooldown', f => { f.province.entries[0].staminaValue = 73; });
  reject('Cooldown', f => { f.province.entries[0].readyBell = 11; });
  const f = fixture(), e = f.province.entries[0]; e.staminaValue = 73; e.staminaBell = 9;
  assert.equal(evaluate(f).stamina.available, 74); assert.equal(evaluate(f).ok, true);
  e.staminaValue = 1; e.staminaBell = 12; e.readyBell = 20;
  assert.equal(evaluate(f).stamina.restBells, 75);
  e.staminaValue = 119; e.staminaBell = 0; e.readyBell = 10;
  assert.equal(evaluate(f).stamina.available, 120);
});

test('arrival limits, effective season status, tip and bucket match their integer rules', () => {
  for (const bell of [11, 83, -1, 12.5]) reject('ArrivalBell', f => { f.arriveBell = bell; });
  reject('ArrivalBell', f => { f.season.endBell = 12; });
  reject('WrongStatus', f => { f.season.endBell = 10; });
  reject('WrongStatus', f => { f.clock.unixTimestamp = GENESIS - 1n; });
  reject('RulesetMismatch', f => { f.season.programVersion = 4; });
  reject('TipTooLow', f => { f.tip = '14440'; });
  reject('Bucket', f => { f.citizen.bucketMilli = 999; f.season.bucketRatePerH = 0; });
  const f = fixture(); f.season.status = 2; f.arriveBell = 82;
  assert.equal(evaluate(f).ok, true);
  f.tip = '14442'; assert.equal(evaluate(f).ok, true, 'runtime accepts non-preset tips above the minimum');
  f.citizen.bucketMilli = 0; f.citizen.bucketT = 5970;
  assert.equal(evaluate(f).bucket.availableMilli, '1000'); assert.equal(evaluate(f).ok, true);
});

test('raw accounts and Clock decode from public observations, and bridge markers fail closed', () => {
  const f = fixture();
  const holding = raw('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, ORDER: 1, STATE: 2, HOST_SEQ: 1,
    OWNER_CITIZEN: fromB58(OWNER), TRANSIT: [{ STATE: 4, UNIT: 0, FACTION: 0, ORIGIN_P: 128, ORIGIN_Q: 0,
      ORIGIN_TILE: 60, HOST_ID: ID, DEPART_BELL: 8, ARRIVE_BELL: 10, DEPART_TS: GENESIS + 4800n, DEP_MASS: 1000, MARCH_STAMINA: 74 }] });
  holding[784 + 93] = 1; f.holding = holding;
  assert.equal(evaluate(f).code, 'HostInTransit');
  holding[784 + 94] = 1; assert.equal(evaluate(f).code, 'BadData'); holding[784 + 94] = 0;
  new DataView(holding.buffer).setInt16(784 + 4, 129, true);
  assert.equal(evaluate(f).code, 'BadData'); new DataView(holding.buffer).setInt16(784 + 4, 128, true);
  // A structurally valid occupied record for another issued sequence is not
  // this host's lock, even if it retains a previous holding generation.
  new DataView(holding.buffer).setBigUint64(784 + 8, hostId({ ...HOME, gen: 0, seq: 2 }), true);
  const clock = new Uint8Array(40); new DataView(clock.buffer).setBigInt64(32, GENESIS + 6000n, true); f.clock = clock;
  assert.equal(evaluate(f).ok, true); assert.equal(evaluate(f).transitSlot, 1);
  f.holding = holding.subarray(0, 100); assert.equal(evaluate(f).ok, false);
});

test('exact clocks above 2^53 and missing schedule fields never round or invent a beacon', () => {
  const f = fixture(), g = 9007199254740993n;
  f.season.genesisTs = g; f.clock.unixTimestamp = g + 6000n; f.season.drandGenesis = g - 300n;
  const r = evaluate(f); assert.equal(r.ok, true, r.code); assert.equal(r.nowBell, 10);
  assert.equal(r.sealSchedule.round, '2701'); assert.equal(r.sealSchedule.arrivalEnd, (g + 7800n).toString());
  f.clock.unixTimestamp = Number(g + 6000n); assert.equal(evaluate(f).code, 'ClockObservationMissing');
  delete f.clock; assert.equal(evaluate(f).code, 'ClockObservationMissing');
  const missing = fixture(); delete missing.season.drandGenesis;
  assert.equal(evaluate(missing).code, 'SealScheduleUnavailable');
});

test('source pins retain runtime finality, resident, pending, stamina, arrival and fee definitions', () => {
  const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const depart = read('permutation-frontier/src/proc/wide_expedition_exec.rs');
  for (const name of ['ap::finality_due', 'capture_lock_of', 'ap::resident_ok', 'host_in_transit_with_bridge',
    'e.busy()', 'host.depart(', 'bell.checked_add(2)', 'bell.checked_add(72)', 'x.arrive_bell >= hdr.end_bell', 'fees::min_tip_lamports', 'start.finish']) assert.ok(depart.includes(name), name);
  const prologue = read('frontier-abi/src/prologue.rs');
  assert.match(prologue, /resolved_next as u64 \+ 1 >= b as u64/);
  assert.match(prologue, /h\.state == H::STATE_PROVISIONAL/);
  assert.match(read('permutation-frontier/src/proc/host.rs'), /assert_eq!\(DEPART_STAMINA, 74\)/);
  assert.match(read('permutation-rules/src/frontier/host.rs'), /if b < self\.ready_bell/);
  assert.match(read('permutation-rules/src/frontier/beacon.rs'), /pub fn first_round_from/);
});
