// Literal public land bytes and pure arithmetic only. Both no-key guards required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { fromHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef, canonicalWideProvinceKey, decodeWideProvinceKey,
  traceWideDirections } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { evaluateOriginalReverseRoute } from '../../permutation-server/web/frontier/fexpedition-reverse.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(0x12)), SEASON = seasonAddresses(PROGRAM, '11').season;
const WORLD = worldIdOf(SEASON, PROGRAM), ALL = (1n << 61n) - 1n, GENESIS = 1800000000n;
const host = canonicalOriginalHostRef({ world: WORLD, p: '128', q: '0', site: 3, gen: 2, seq: 1 });
// Literal offsets from v2 Province and WideProvince, no production serializer.
function land(key, { passable = ALL, rough = 0n, road = 0n } = {}) {
  const at = decodeWideProvinceKey(key), wide = BigInt(at.ring) > 128n;
  const b = new Uint8Array(wide ? 4864 : 4736), v = new DataView(b.buffer);
  b.set(new TextEncoder().encode(wide ? 'PSFXWPV1' : 'PSF1PROV'));
  v.setBigUint64(8, 11n, true); v.setUint16(16, wide ? 3 : 2, true);
  if (wide) {
    v.setUint16(4736, 1, true); b[4738] = 1; b[4739] = 15;
    b.set(fromHex(WORLD), 4740); b.set(fromHex(key.slice(66)), 4772);
    b[70] = b[4780]; b.fill(0x66, 4800, 4832);
  } else { v.setInt16(64, Number(at.p), true); v.setInt16(66, Number(at.q), true); }
  v.setBigUint64(264, passable, true); v.setBigUint64(272, rough, true); v.setBigUint64(280, road, true);
  return b;
}
function fixture(options = {}) {
  const source = { program: PROGRAM, season: SEASON, seasonId: '11', world: WORLD, host,
    standing: { p: '129', q: '0', tile: 30 }, unit: 0, faction: 0, holdingFlags: 0, ...options.source };
  const directions = options.directions ?? Array(16).fill(3);
  const route = traceWideDirections({ world: WORLD, origin: source.standing, directions });
  return { source, directions, landBytes: new Map(route.accountKeys.map(key => [key, land(key, options.land)])),
    season: { seasonId: 11n, genesisTs: GENESIS, status: 3, minLead: 2, maxLead: 72, endBell: 1000,
      stances: new Uint8Array(36), ...options.season }, departTs: GENESIS + 6000n, arriveBell: 20 };
}
function closed(r) {
  for (const k of ['complete', 'executable', 'admitted', 'signed', 'sealed', 'enqueued', 'publicDispatchAvailable',
    'sourceResidentVerified', 'ownershipVerified', 'clockCoherent', 'terrainVerified', 'arrivalVerified', 'completionProven']) assert.equal(r[k], false, k);
  assert.deepEqual(r.blockers, ['ReverseProducerUnavailable', 'ReverseOwnershipUnverified', 'ReverseArrivalUnavailable',
    'SnapshotAuthorityUnverified', 'PublicDispatchClosed']);
  assert.equal(r.observationOnly, true);
}
test('reverse route keeps original issuer separate from wide standing and returns incomplete arithmetic only', () => {
  const f = fixture(), before = [...f.landBytes.values()].map(x => x.slice()), r = evaluateOriginalReverseRoute(f);
  assert.equal(r.code, null); assert.equal(r.status, 'incomplete'); assert.equal(r.calculationComplete, true);
  assert.equal(r.source.host, host); assert.equal(r.source.issuer.p, '128'); assert.equal(r.source.standing.p, '129');
  assert.ok(BigInt(r.route.origin.ring) > 128n); assert.ok(BigInt(r.route.endpoint.ring) <= 128n);
  assert.equal(r.route.accountKeys[0], r.route.endpoint.key);
  assert.deepEqual([r.rawSecs, r.travelSecs, r.watchedSecs, r.wearBps], [1920, 1920, 0, 0]);
  assert.deepEqual([r.referenceTiming.departBell, r.referenceTiming.earliest, r.referenceTiming.min,
    r.referenceTiming.max, r.referenceTiming.withinWindow], [10, 14, 14, 82, true]);
  assert.equal(r.referenceTiming.reverseArrivalVerified, false); closed(r);
  assert.deepEqual([...f.landBytes.values()], before); assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.ok(Object.isFrozen(r.source.standing) && Object.isFrozen(r.referenceTiming));
  assert.ok(!Object.hasOwn(r, 'plainHex') && !Object.hasOwn(r, 'roles'));
});
test('both mounted units, road and rough costs, faction travel bias preserve raw wear basis', () => {
  for (const unit of [0, 2, 5]) for (const faction of [0, 4]) {
    const f = fixture({ source: { unit, faction }, land: { rough: ALL, road: ALL } });
    const r = evaluateOriginalReverseRoute(f), raw = unit === 0 ? 1440 : 720;
    assert.equal(r.rawSecs, raw); assert.equal(r.travelSecs, Math.floor(raw * (faction === 4 ? .75 : 1)));
    assert.equal(r.calculationComplete, true); closed(r);
  }
});
test('actual original watch, allied stance, expelled issuer, and stopping palisade affect reverse route', () => {
  const f = fixture(), route = traceWideDirections({ world: WORLD, origin: f.source.standing, directions: f.directions });
  const tile = route.steps.find(x => BigInt(x.ring) <= 128n), b = f.landBytes.get(tile.key);
  b.set([1, tile.tile, 1, 1], 4044);
  const watched = evaluateOriginalReverseRoute(f); assert.ok(watched.watchedSecs > 0); assert.ok(watched.wearBps > 0);
  f.season.stances[6] = 2; assert.equal(evaluateOriginalReverseRoute(f).watchedSecs, 0);
  b[4046] = 0; f.source.holdingFlags = 4; assert.ok(evaluateOriginalReverseRoute(f).watchedSecs > 0);
  b[4044] = 2; const stopped = evaluateOriginalReverseRoute(f);
  assert.equal(stopped.code, 'RoutePalisade'); assert.equal(stopped.key, tile.key); assert.ok(stopped.stepIndex >= 0); closed(stopped);
});
test('missing land, impassability, forged family, and unsupported wide structures refuse', () => {
  const f = fixture(), r = traceWideDirections({ world: WORLD, origin: f.source.standing, directions: f.directions });
  const first = r.steps[0], original = f.landBytes.get(first.key);
  f.landBytes.delete(first.key); assert.equal(evaluateOriginalReverseRoute(f).code, 'RouteLandMissing');
  f.landBytes.set(first.key, { passable: ALL }); assert.equal(evaluateOriginalReverseRoute(f).code, 'RouteLandMissing');
  f.landBytes.set(first.key, original); new DataView(original.buffer).setBigUint64(264, 0n, true);
  assert.equal(evaluateOriginalReverseRoute(f).code, 'RouteImpassable');
  f.landBytes.set(first.key, land(first.key)); f.landBytes.get(first.key)[4044] = 1;
  assert.equal(evaluateOriginalReverseRoute(f).code, 'WideStructureUnsupported');
  f.landBytes.set(first.key, new Uint8Array(4736)); assert.equal(evaluateOriginalReverseRoute(f).code, 'LandLength');
});
test('full host, world, standing family and missing ownership-dependent facts are never fabricated', () => {
  for (const [mutate, code] of [
    [f => { f.source.host = '1'; }, 'Host'], [f => { f.source.world = 'ab'.repeat(32); }, 'WorldMismatch'],
    [f => { f.source.host = canonicalWideProvinceKey({ world: WORLD, p: '129', q: '0' }) + '030201000000'; }, 'OriginalHostRequired'],
    [f => { f.source.standing.p = '128'; }, 'WideStandingRequired'],
    [f => { f.source.origin = { p: '128', q: '0', tile: 30 }; }, 'WideStandingRequired'],
    [f => { delete f.source.unit; }, 'SourceUnitUnavailable'], [f => { delete f.source.faction; }, 'SourceFactionUnavailable'],
    [f => { delete f.source.holdingFlags; }, 'SourceHoldingFlagsUnavailable'],
    [f => { f.source.seasonId = '12'; }, 'SeasonPinMismatch'],
  ]) { const f = fixture(); mutate(f); const r = evaluateOriginalReverseRoute(f); assert.equal(r.code, code); closed(r); }
});
test('far exact wide coordinates remain exact and refuse an endpoint that has not crossed to original', () => {
  const f = fixture({ source: { standing: { p: '9007199254740993', q: '-2', tile: 30 } }, directions: [3] });
  const r = evaluateOriginalReverseRoute(f); assert.equal(r.code, 'OriginalDestinationRequired');
  assert.equal(r.route.origin.p, '9007199254740993'); assert.equal(r.route.origin.q, '-2'); closed(r);
  const empty = fixture({ directions: [] }); assert.equal(evaluateOriginalReverseRoute(empty).code, 'EmptyPath');
  const long = fixture(); long.directions = Array(33).fill(3); assert.equal(evaluateOriginalReverseRoute(long).code, 'PathTooLong');
});
test('reference timing refuses early, late, ended and absent arrival without asserting reverse admissibility', () => {
  for (const [arriveBell, code] of [[13, 'ArrivalTooEarly'], [83, 'ArrivalTooLate'], [1000, 'ArrivalAfterSeason'], [null, 'ArrivalRequired']]) {
    const f = fixture(); f.arriveBell = arriveBell; const r = evaluateOriginalReverseRoute(f);
    assert.equal(r.code, code); assert.equal(r.calculationComplete, false); assert.equal(r.referenceTiming.withinWindow, false); closed(r);
  }
  const ended = fixture({ season: { endBell: 10 } }); assert.equal(evaluateOriginalReverseRoute(ended).code, 'SeasonEnded');
  const window = fixture({ season: { maxLead: 2 } }); assert.equal(evaluateOriginalReverseRoute(window).code, 'ArrivalWindowEmpty');
});
test('i64 timestamp precision is retained and unsafe Number or overflow is refused', () => {
  const high = fixture({ season: { genesisTs: (1n << 63n) - 10000n } }); high.departTs = high.season.genesisTs + 6000n;
  const r = evaluateOriginalReverseRoute(high); assert.equal(r.calculationComplete, true); assert.equal(r.referenceTiming.departTs, high.departTs.toString());
  const low = fixture({ season: { genesisTs: -(1n << 63n) } }); low.departTs = low.season.genesisTs + 6000n;
  assert.equal(evaluateOriginalReverseRoute(low).referenceTiming.earliest, 14);
  high.departTs = Number(high.departTs); assert.equal(evaluateOriginalReverseRoute(high).code, 'Timestamp');
  const overflow = fixture({ season: { genesisTs: (1n << 63n) - 7000n } }); overflow.departTs = overflow.season.genesisTs + 6000n;
  assert.equal(evaluateOriginalReverseRoute(overflow).code, 'TimestampOverflow');
});
