// Public synthetic account observations only. No runtime startup or keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { fromHex, toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { WORLD_DOMAIN, worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { captureAddress } from '../../permutation-server/web/frontier/map/widecapture.mjs';
import { decodeWideProvinceKey } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { OUTBOUND_POP, openOutbound, editOutbound, clearOutbound, reconcileOutbound, inspectOutboundRoute } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';
import { outboundRoutePlaces, parseOutboundRouteCaptures } from '../../permutation-server/web/frontier/fexpedition-route-read.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const A = seasonAddresses(PROGRAM, '1'), OWNER = A.of('Citizen', { wallet: WALLET });
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const WORLD = worldIdOf(A.season, PROGRAM), ALL = (1n << 61n) - 1n;
const HOST = hostId({ p: 128, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, fields) => decode(kind, encodeAccount(kind, { LAYOUT_VERSION: 2, SEASON_ID: 1n, ...fields }, { profile: 2 }));

function fixture() {
  const holding = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(OWNER) });
  const province = acct('Province', { P: 128, Q: 0, RING: 128, RESOLVED_NEXT: 11, PASSABLE_MASK: ALL,
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 10 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: acct('Season', { PROGRAM_VERSION: 16388, RULESET_HASH: new Uint8Array(32).fill(1),
    STATUS: 3, GENESIS_TS: 1800000000n, MIN_LEAD: 2, MAX_LEAD: 72, END_BELL: 1000, REVEAL_CU_LIMIT: 26000, REVEAL_LOADED_LIMIT: 1540096,
    MIN_REVEAL_PRIORITY_MILLI: 433, MARCH_FEE: 10000n, SEAL_BOND: 20000n }),
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff,
      HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }),
    holdings: [holding], activeHolding: 0, selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: HOST, pop: OUTBOUND_POP },
    nowBell: 10, chain: { now: () => 1800006000 }, provinces: new Map([['128,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: PIN, relay: '/gw', source: {} };
  openOutbound(fs, ctx); editOutbound(fs, ctx, 'step', '0'); editOutbound(fs, ctx, 'arriveBell', '12');
  assert.ok(fs.expeditionCompose.source);
  const source = fs.expeditionCompose.source;
  return { fs, ctx, source, places: outboundRoutePlaces(source, [0]) };
}

function response(source, places) {
  return { v: 1, experimental: true, readOnly: true, completeness: 'captured', world: WORLD, worldDomain: WORLD_DOMAIN,
    program: PROGRAM, season: '1', seasonAddress: A.season, snapshot: { epoch: '1', stamp: 'ab'.repeat(32), lastSlot: '100', foldedThrough: '20' },
    recorded: places.length, refused: 0, legacy: { rMax: 128, rMaxHard: 128, ringsOpened: 129, provinces: 49537 }, page: { max: 256, default: 64 },
    route: places.map(at => {
      const identity = decodeWideProvinceKey(at.key), wide = BigInt(identity.ring) > 128n;
      const original = encodeAccount('Province', { LAYOUT_VERSION: 2, SEASON_ID: 1n, P: wide ? 0 : Number(at.p), Q: wide ? 0 : Number(at.q),
        RING: wide ? 0 : Number(identity.ring), WEDGE: identity.wedge, PASSABLE_MASK: ALL }, { profile: 2 });
      let bytes = original, address = A.of('Province', { p: Number(at.p), q: Number(at.q) });
      if (wide) {
        bytes = new Uint8Array(4864); bytes.set(original); bytes.set(new TextEncoder().encode('PSFXWPV1'));
        const v = new DataView(bytes.buffer); v.setUint16(16, 3, true); v.setUint16(4736, 1, true); bytes[4738] = 1; bytes[4739] = 15;
        bytes.set(fromHex(source.world), 4740); const key = fromHex(at.key.slice(66)); bytes.set(key, 4772); bytes.fill(7, 4800, 4832);
        address = captureAddress('province', key, null, source.season, source.program);
      }
      return { p: at.p, q: at.q, state: 'captured', capture: { address, slot: '99', archiveSequence: '19', postState: 'transaction',
        verification: 'captured-unverified', bytes_b64: toBase64(bytes) } };
    }) };
}

test('one bounded captured response keeps exact route order and public identity', () => {
  const f = fixture(), places = outboundRoutePlaces(f.source, [3, 0, 0]);
  assert.deepEqual(places.map(p => [p.p, p.q]), [['129', '0'], ['128', '0']]);
  const r = parseOutboundRouteCaptures(response(f.source, places), { source: f.source, places });
  assert.deepEqual([...r.lands.keys()], places.map(p => p.key));
  assert.deepEqual([...r.lands.values()].map(p => p.family), ['wide', 'original']);
  assert.equal(r.captures.length, 2); assert.equal(r.coherentSnapshotVerified, false); assert.equal(r.provenanceVerified, false); assert.equal(r.executable, false);
});

test('unknown and closed are explicit missing observations, never fabricated land', () => {
  const f = fixture();
  for (const state of ['unknown', 'closed']) {
    const json = response(f.source, f.places); Object.assign(json.route[0], { state, capture: null });
    const r = parseOutboundRouteCaptures(json, f); assert.equal(r.lands.size, 0); assert.equal(r.unavailable[0].state, state);
  }
});

test('swapped scope/rows, address, bounds, bytes and false verification are refused', () => {
  const f = fixture();
  const mutations = [
    j => { j.world = 'ff'.repeat(32); }, j => { j.season = '2'; }, j => { j.readOnly = false; }, j => { j.route.push(j.route[0]); },
    j => { j.route[0].p = '9007199254740993'; }, j => { j.route[0].capture.address = WALLET; }, j => { j.route[0].capture.slot = '101'; },
    j => { j.route[0].capture.archiveSequence = '21'; }, j => { j.route[0].capture.verification = 'verified'; },
    j => { j.route[0].capture.bytes_b64 = toBase64(new Uint8Array(4864)); }, j => { j.route[0].state = 'unknown'; },
  ];
  for (const change of mutations) { const j = response(f.source, f.places); change(j); assert.throws(() => parseOutboundRouteCaptures(j, f)); }
});

test('actual composer read calculates captured terrain and keeps all execution gates closed', async () => {
  const f = fixture(), before = [f.fs.selected, f.fs.provinces, f.fs.holdings, f.fs.compose, f.fs.marches, f.fs.book];
  let calls = 0, signal;
  f.ctx.source.wideRoute = async args => { calls++; signal = args.signal; assert.deepEqual(args.places, f.places); return { ok: true, json: response(f.source, f.places) }; };
  await inspectOutboundRoute(f.fs, { context: () => f.ctx });
  const r = f.fs.expeditionCompose.routeCheck;
  assert.equal(calls, 1); assert.equal(signal.aborted, true); assert.equal(r.status, 'read'); assert.equal(r.report.ok, true, r.report.code);
  assert.equal(r.report.travelSecs, 120); assert.equal(r.departTs, 1800006090); assert.equal(r.report.min, 12);
  assert.equal(r.executable, false); assert.equal(r.admitted, false); assert.equal(r.signed, false); assert.equal(f.fs.session, null);
  assert.deepEqual([f.fs.selected, f.fs.provinces, f.fs.holdings, f.fs.compose, f.fs.marches, f.fs.book], before);
  editOutbound(f.fs, f.ctx, 'step', '1'); assert.equal(f.fs.expeditionCompose.routeCheck, null);
});

test('edits, close, source/clock changes and repeat reads discard pending old responses', async () => {
  const changes = [f => editOutbound(f.fs, f.ctx, 'step', '1'), f => clearOutbound(f.fs),
    f => { f.fs.nowBell++; reconcileOutbound(f.fs, f.ctx); }, f => { f.ctx.source = {}; },
    f => { f.fs.holdings[0].flags = 4; }, f => { f.fs.season.stances[0] = 1; }];
  for (const change of changes) {
    const f = fixture(); let release, signal;
    f.ctx.source.wideRoute = args => { signal = args.signal; return new Promise(r => { release = r; }); };
    const pending = inspectOutboundRoute(f.fs, { context: () => f.ctx });
    change(f); release({ ok: true, json: response(f.source, f.places) }); await pending;
    assert.equal(f.fs.expeditionCompose.routeCheck, null); assert.equal(signal.aborted, true);
  }
  const f = fixture(), releases = [];
  f.ctx.source.wideRoute = () => new Promise(r => releases.push(r));
  const old = inspectOutboundRoute(f.fs, { context: () => f.ctx }), fresh = inspectOutboundRoute(f.fs, { context: () => f.ctx });
  releases[0]({ ok: false, code: 'OldFailure' }); await old;
  assert.equal(f.fs.expeditionCompose.routeCheck.status, 'loading');
  releases[1]({ ok: true, json: response(f.source, f.places) }); await fresh;
  assert.equal(f.fs.expeditionCompose.routeCheck.status, 'read');
});

test('provider and malformed response failures never fall back to generated terrain', async () => {
  const f = fixture();
  for (const answer of [{ ok: false, code: 'WideWorldUnavailable' }, { ok: true, json: {} }]) {
    f.ctx.source.wideRoute = async () => answer;
    await inspectOutboundRoute(f.fs, { context: () => f.ctx });
    assert.equal(f.fs.expeditionCompose.routeCheck.status, 'error');
    assert.equal(f.fs.expeditionCompose.executable, false);
  }
});

test('missing, nonnumeric or nonfinite chain time cannot become a departure observation', async () => {
  for (const now of [null, undefined, '1800006000', NaN, Infinity, -1]) {
    const f = fixture(); f.fs.chain.now = () => now;
    f.ctx.source.wideRoute = async () => ({ ok: true, json: response(f.source, f.places) });
    await inspectOutboundRoute(f.fs, { context: () => f.ctx });
    assert.equal(f.fs.expeditionCompose.routeCheck.status, 'error');
    assert.equal(f.fs.expeditionCompose.routeCheck.code, 'RouteClockUnavailable');
  }
});

test('Herald requests only canonical exact coordinates with bounded response bytes', async () => {
  const f = fixture(), calls = [];
  const client = createHerald({ fetch: async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify(response(f.source, f.places)), { status: 200 }); } });
  assert.equal((await client.wideRoute({ places: f.places })).ok, true);
  assert.equal(calls[0][0], '/h/world/wide/route?at=129%2C0'); assert.equal(calls[0][1].cache, 'no-store');
  for (const places of [[], [...f.places, ...f.places], [{ p: 129, q: '0' }], [{ p: '0129', q: '0' }], Array(5).fill(f.places[0])]) {
    assert.equal((await client.wideRoute({ places })).ok, false);
  }
  assert.equal(calls.length, 1);
  for (const response of [new Response('x'.repeat(65537)), new Response('{}', { headers: { 'content-length': '65537' } })]) {
    const c = createHerald({ fetch: async () => response });
    assert.equal((await c.wideRoute({ places: f.places })).code, 'ResponseTooLarge');
  }
});
