// Public literal accounts/arithmetic only; run this exact file with both
// no-key preloads. No chain, application boot, sealer or transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { fromHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { worldIdOf, WIDE_BOUND } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalWideProvinceKey, decodeWideProvinceKey, traceWideDirections } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { routeLandFromBytes, evaluateOutboundRoute } from '../../permutation-server/web/frontier/fexpedition-route.mjs';
import { departMargin } from '../../permutation-server/web/frontier/fmarch.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(0x12)), SEASON = encode(new Uint8Array(32).fill(0x34));
const WORLD = worldIdOf(SEASON, PROGRAM), ALL = (1n << 61n) - 1n, GENESIS = 1800000000n;
const source = () => ({ program: PROGRAM, season: SEASON, world: WORLD, seasonId: '11',
  origin: { p: '128', q: '0', tile: 30 }, unit: 0, faction: 0, holdingFlags: 0 });
const season = () => ({ seasonId: 11n, genesisTs: GENESIS, status: 3, minLead: 2, maxLead: 72,
  endBell: 1000, stances: new Uint8Array(36) });
const at = (p, q, world = WORLD) => ({ p: String(p), q: String(q), key: canonicalWideProvinceKey({ world, p: String(p), q: String(q) }) });
// Independent literal deployed offsets and header bytes, also pinned to Rust
// by the final test. These are not generated accounts or signer fixtures.
function bytesFor(identity, { rough = 0n, road = 0n, passable = ALL, structure } = {}) {
  const id = decodeWideProvinceKey(identity.key), wide = BigInt(id.ring) > 128n;
  const b = new Uint8Array(wide ? 4864 : 4736), v = new DataView(b.buffer);
  b.set(new TextEncoder().encode(wide ? 'PSFXWPV1' : 'PSF1PROV'));
  v.setBigUint64(8, 11n, true); v.setUint16(16, wide ? 3 : 2, true);
  if (wide) {
    v.setUint16(4736, 1, true); b[4738] = 1; b[4739] = 15;
    b.set(fromHex(id.world), 4740); b.set(fromHex(identity.key.slice(66)), 4772);
    b[70] = b[4780]; b.fill(0x66, 4800, 4832);
  } else {
    v.setInt16(64, Number(identity.p), true); v.setInt16(66, Number(identity.q), true);
  }
  v.setBigUint64(264, passable, true); v.setBigUint64(272, rough, true); v.setBigUint64(280, road, true);
  if (structure) b.set(structure, 4044);
  return b;
}
function fixture(options = {}) {
  const s = { ...source(), ...options.source }, se = { ...season(), ...options.season };
  const directions = options.directions ?? Array(16).fill(0);
  const route = traceWideDirections({ world: s.world, origin: s.origin, directions });
  const raw = new Map(), lands = new Map();
  for (const key of route.accountKeys) {
    const id = decodeWideProvinceKey(key), b = bytesFor(id, options.land);
    raw.set(key, b); lands.set(key, routeLandFromBytes({ source: s, at: id, bytes: b }));
  }
  return { source: s, season: se, directions, lands, raw, route, departTs: GENESIS + 6000n, arriveBell: 20 };
}
function refresh(f, key) {
  f.lands.set(key, routeLandFromBytes({ source: f.source, at: decodeWideProvinceKey(key), bytes: f.raw.get(key) }));
}
const expectError = (code, f) => assert.throws(f, e => e.code === code);
const checkClosed = result => {
  assert.equal(result.observationOnly, true); assert.equal(result.executable, false); assert.equal(result.admitted, false);
  for (const name of ['sourceVerified', 'clockCoherent', 'terrainVerified', 'costVerified', 'arrivalVerified']) assert.equal(result[name], false);
};

test('literal original/wide route matches Rust 16-step flat cost and stays an observation', () => {
  const f = fixture(), before = [...f.raw.values()].map(b => b.slice());
  const r = evaluateOutboundRoute(f);
  assert.equal(r.ok, true); assert.equal(r.rawSecs, 1920); assert.equal(r.travelSecs, 1920);
  assert.equal(r.watchedSecs, 0); assert.equal(r.wearBps, 0);
  assert.deepEqual([r.departBell, r.earliest, r.min, r.max, r.arrivalValid], [10, 14, 14, 82, true]);
  assert.equal(f.lands.get(f.route.accountKeys[0]).family, 'wide');
  assert.ok([...f.lands.values()].some(l => l.family === 'original'));
  assert.deepEqual([...f.raw.values()], before); checkClosed(r);
});

test('rough, roads, both mounted units and faction 4 doctrine apply in Rust order', () => {
  for (const [unit, raw] of [[0, 1440], [2, 720], [5, 720]]) {
    for (let faction = 0; faction < 6; faction++) {
      const f = fixture({ source: { unit, faction }, land: { rough: ALL, road: ALL } });
      const r = evaluateOutboundRoute(f);
      assert.equal(r.ok, true); assert.equal(r.rawSecs, raw);
      assert.equal(r.travelSecs, faction === 4 ? Math.floor(raw * .75) : raw);
    }
  }
  const f = fixture({ source: { unit: 2, faction: 4, origin: { p: '128', q: '0', tile: 60 } }, directions: [0], land: { rough: ALL, road: ALL } });
  assert.deepEqual([evaluateOutboundRoute(f).rawSecs, evaluateOutboundRoute(f).travelSecs], [45, 33]);
});

test('tower watch reads actual nation stance and current original Holding expulsion', () => {
  const f = fixture({ land: { rough: ALL, road: ALL }, source: { unit: 5, faction: 4 } });
  const first = f.route.steps[0], b = f.raw.get(first.key);
  b.set([1, first.tile, 1, 1], 4044); refresh(f, first.key);
  const r = evaluateOutboundRoute(f);
  // The tower on the first entered tile covers the first three horizontal
  // steps; each rough/road/mounted step is 180 >> 2 = 45 seconds.
  assert.equal(r.watchedSecs, 135); assert.equal(r.wearBps, 225);
  f.season.stances[1 * 6 + 4] = 2; assert.equal(evaluateOutboundRoute(f).watchedSecs, 0);
  f.season.stances[1 * 6 + 4] = 1; assert.equal(evaluateOutboundRoute(f).watchedSecs, 0);
  b[4046] = 4; refresh(f, first.key); assert.equal(evaluateOutboundRoute(f).watchedSecs, 0);
  f.source.holdingFlags = 4; assert.equal(evaluateOutboundRoute(f).watchedSecs, 135);
});

test('unknown land, impassable tiles and stopping palisades identify the exact step', () => {
  const f = fixture(), step = f.route.steps[0], land = f.lands.get(step.key);
  f.lands.delete(step.key);
  let r = evaluateOutboundRoute(f); assert.equal(r.code, 'RouteLandMissing'); assert.equal(r.stepIndex, 0); assert.equal(r.key, step.key);
  f.lands.set(step.key, land);
  const b = f.raw.get(step.key), v = new DataView(b.buffer);
  v.setBigUint64(264, ALL & ~(1n << BigInt(step.tile)), true); refresh(f, step.key);
  r = evaluateOutboundRoute(f); assert.equal(r.code, 'RouteImpassable'); assert.equal(r.stepIndex, 0);
  v.setBigUint64(264, ALL, true); b.set([2, step.tile, 1, 1], 4044); refresh(f, step.key);
  r = evaluateOutboundRoute(f); assert.equal(r.code, 'RoutePalisade'); assert.equal(r.stepIndex, 0);
  f.season.stances[6] = 2; assert.equal(evaluateOutboundRoute(f).ok, true);
  checkClosed(r);
});

test('no arbitrary watch masks or cloned, stale-identity lands are accepted', () => {
  const f = fixture(), step = f.route.steps[0], land = f.lands.get(step.key);
  f.lands.set(step.key, { ...land, watch: { wear: 0n, block: 0n } });
  assert.equal(evaluateOutboundRoute(f).code, 'RouteLandUnverified');
  f.lands.set(step.key, f.lands.get(f.route.accountKeys[0]));
  assert.equal(evaluateOutboundRoute(f).code, 'RouteLandUnverified');
  f.lands.set(step.key, land);
  assert.throws(() => { land.passable = 0n; }, TypeError);
  f.raw.get(step.key).fill(0); assert.equal(evaluateOutboundRoute(f).ok, true);
});

test('wide structures, malformed inactive forts and even empty live forts fail closed', () => {
  const id = at(129, 0);
  for (const [offset, value, code] of [[4044, 1, 'WideStructureUnsupported'], [4047, 1, 'WideStructureUnsupported'],
    [4711, 1, 'WideFortUnsupported'], [4725, 1, 'WideFortUnsupported'], [4711, 2, 'WideFortMalformed'],
    [4708, 1, 'WideFortMalformed'], [4735, 1, 'WideFortMalformed']]) {
    const b = bytesFor(id); b[offset] = value;
    expectError(code, () => routeLandFromBytes({ source: source(), at: id, bytes: b }));
  }
});

test('raw original v2 and wide identities reject shadow families, versions, seasons and coordinates', () => {
  const original = at(128, 0), wide = at(129, 0);
  for (const [id, bytes] of [[original, bytesFor(wide)], [wide, bytesFor(original)]])
    expectError('LandLength', () => routeLandFromBytes({ source: source(), at: id, bytes }));
  for (const [id, off, value, code] of [[original, 16, 1, 'LandVersion'], [wide, 16, 2, 'LandVersion'],
    [wide, 4736, 2, 'LandVersion'], [wide, 4738, 0, 'LandNotReady'], [wide, 4739, 31, 'LandNotReady'],
    [wide, 4789, 1, 'LandReserved'], [wide, 4840, 1, 'LandReserved'], [wide, 64, 1, 'LandLegacyPrefix'],
    [wide, 70, 1, 'LandWedge'], [wide, 4740, 0, 'WorldMismatch'], [wide, 4788, 1, 'LandIdentity'],
    [original, 8, 12, 'SeasonPinMismatch'], [wide, 8, 12, 'SeasonPinMismatch'], [original, 64, 127, 'LandIdentity']]) {
    const b = bytesFor(id); b[off] = value;
    expectError(code, () => routeLandFromBytes({ source: source(), at: id, bytes: b }));
  }
  const b = bytesFor(wide); b.fill(0, 4800, 4832);
  expectError('LandSeedMissing', () => routeLandFromBytes({ source: source(), at: wide, bytes: b }));
  expectError('LandIdentity', () => routeLandFromBytes({ source: source(), at: { ...wide, p: '130' }, bytes: bytesFor(wide) }));
});

test('wide raw identities retain all signed 64-bit-range world coordinate digits', () => {
  for (const [p, q] of [[WIDE_BOUND, 0n], [-WIDE_BOUND, 0n], [9007199254740993n, -9007199254740992n]]) {
    const id = at(p, q), l = routeLandFromBytes({ source: source(), at: id, bytes: bytesFor(id) });
    assert.equal(l.p, p.toString()); assert.equal(l.q, q.toString()); assert.equal(l.key, id.key);
  }
});

test('arrival uses ceil, two-bell lead, 72-bell cap and strict season end', () => {
  const f = fixture();
  for (const [bell, code] of [[13, 'ArrivalTooEarly'], [83, 'ArrivalTooLate'], [1000, 'ArrivalAfterSeason']]) {
    const r = evaluateOutboundRoute({ ...f, arriveBell: bell });
    assert.equal(r.code, code); assert.equal(r.rawSecs, 1920); assert.equal(r.arrivalValid, false); checkClosed(r);
  }
  for (const bell of [14, 82]) assert.equal(evaluateOutboundRoute({ ...f, arriveBell: bell }).ok, true);
  const short = fixture({ source: { origin: { p: '128', q: '0', tile: 60 } }, directions: [0] });
  assert.equal(evaluateOutboundRoute({ ...short, arriveBell: 12 }).earliest, 12);
  const exact = GENESIS + 10n * 600n + 480n;
  assert.equal(evaluateOutboundRoute({ ...f, departTs: exact }).earliest, 14);
  assert.equal(evaluateOutboundRoute({ ...f, departTs: exact + 1n }).earliest, 15);
  assert.equal(evaluateOutboundRoute({ ...f, departTs: Number(exact) + .9 }).earliest, 14);
  assert.equal(evaluateOutboundRoute({ ...f, season: { ...f.season, endBell: 20 } }).code, 'ArrivalAfterSeason');
  assert.equal(evaluateOutboundRoute({ ...f, season: { ...f.season, endBell: 14 } }).code, 'ArrivalWindowEmpty');
});

test('observed clock margin remains explicit and relative arithmetic preserves i64 precision', () => {
  const f = fixture(), t = Number(GENESIS) + 10 * 600 + 480;
  assert.equal(departMargin(), 90); assert.equal(departMargin(150), 300);
  assert.equal(evaluateOutboundRoute({ ...f, departTs: t + departMargin() }).earliest, 15);
  const genesis = (1n << 63n) - 100000n;
  const r = evaluateOutboundRoute({ ...f, season: { ...f.season, genesisTs: genesis }, departTs: genesis + 6000n });
  assert.equal(r.ok, true); assert.equal(r.earliest, 14);
  assert.equal(evaluateOutboundRoute({ ...f, departTs: Number(genesis) }).code, 'Timestamp');
  assert.equal(evaluateOutboundRoute({ ...f, departTs: GENESIS - 1n }).code, 'BeforeGenesis');
  assert.equal(evaluateOutboundRoute({ ...f, departTs: GENESIS + 600n * 0xffffffffn }).code, 'BellOverflow');
});

test('source, stance, clock and arrival input gaps never imply ready travel', () => {
  const f = fixture();
  for (const [patch, code] of [[{ source: { ...f.source, holdingFlags: undefined } }, 'HoldingFlagsMissing'],
    [{ source: { ...f.source, unit: 8 } }, 'Unit'], [{ source: { ...f.source, faction: 6 } }, 'Faction'],
    [{ season: { ...f.season, stances: null } }, 'SeasonStancesMissing'],
    [{ season: { ...f.season, seasonId: 12n } }, 'SeasonPinMismatch'],
    [{ season: { ...f.season, status: 4 } }, 'SeasonNotRunning'],
    [{ season: { ...f.season, minLead: 73, maxLead: 72 } }, 'LeadWindow'],
    [{ departTs: NaN }, 'Timestamp'], [{ arriveBell: '20' }, 'ArrivalRequired']]) {
    const r = evaluateOutboundRoute({ ...f, ...patch }); assert.equal(r.code, code); assert.equal(r.ok, false); checkClosed(r);
  }
});

test('geometry limits remain canonical: nonempty outbound, at most 32 steps and four provinces', () => {
  const f = fixture();
  for (const [directions, code] of [[[], 'EmptyPath'], [[0], 'WideDestinationRequired'], [[6], 'Direction'],
    [Array(33).fill(0), 'PathTooLong'], [Array(24).fill(0), 'PathProvinces']])
    assert.equal(evaluateOutboundRoute({ ...f, directions }).code, code);
  const directions = [0, ...Array.from({ length: 30 }, (_, i) => i % 2 ? 0 : 3), 0];
  const g = fixture({ source: { origin: { p: '128', q: '0', tile: 60 } }, directions });
  assert.equal(evaluateOutboundRoute(g).ok, true); assert.equal(g.route.steps.length, 32);
});

test('static Rust references pin family rejection, route cost, doctrine and arrival contract', () => {
  const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
  const route = read('permutation-frontier/src/proc/wide_expedition_route.rs');
  assert.match(route, /base >> \(cavalry as u32 \+ \(l\.road & bit != 0\) as u32\)/);
  assert.match(route, /of_faction_v3\(t\.faction\)/);
  assert.match(route, /FR::STATE_NONE if r\.iter\(\)\.all\(\|b\| \*b == 0\)/);
  assert.match(route, /!frontier_abi::clash_model::forts_at\(&d, bell\)\?\.is_empty\(\)/);
  const doctrine = read('permutation-rules/src/frontier/doctrine.rs');
  assert.match(doctrine, /name: "E Lumen",[\s\S]*?travel_bps: 7_500/);
  assert.match(doctrine, /secs \* self.travel_bps as u64 \/ BPS_ONE as u64/);
  const travel = read('permutation-rules/src/frontier/travel.rs');
  assert.match(travel, /MIN_ARRIVAL_LEAD_BELLS: u32 = 2/); assert.match(travel, /MAX_ARRIVAL_LEAD_BELLS: u32 = 72/);
  const land = read('frontier-abi/src/world_index/land.rs');
  assert.match(land, /TRAILER == 4_736/); assert.match(land, /SIZE == 4_864/);
});
