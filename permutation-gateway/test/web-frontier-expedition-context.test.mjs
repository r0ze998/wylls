// Synthetic public account observations; no RPC, chain, key or signer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { fromBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { originalHostRef } from '../../permutation-server/web/frontier/fexpedition.mjs';
import { OUTBOUND_POP, openOutbound, editOutbound, clearOutbound, inspectOutboundContext, inspectOutboundRoute } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';
import { outboundSnapshotRequest, outboundSnapshotRequestDigest, parseOutboundSnapshot, readOutboundSnapshot } from '../../permutation-server/web/frontier/fexpedition-context.mjs';
import { evaluateOriginalOutboundReady } from '../../permutation-server/web/frontier/fexpedition-ready.mjs';
import { evaluateOutboundRoute } from '../../permutation-server/web/frontier/fexpedition-route.mjs';
import { outboundSnapshotRequestDigest as serverRequestDigest, outboundSnapshotReport } from '../src/frontier/outbound-snapshot.mjs';
import { syntheticOutboundSnapshot } from '../screens/codex/outbound-context-observation.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const A = seasonAddresses(PROGRAM, '7'), WORLD = worldIdOf(A.season, PROGRAM), HOME = { p: '128', q: '0', site: 3, gen: 1, seq: 0 };
const HOST = hostId({ ...HOME, p: 128, q: 0 }).toString();
function fixture(options = {}) {
  const source = { cluster: 'localnet', program: PROGRAM, season: A.season, seasonId: '7', wallet: WALLET, payer: WALLET,
    original_owner: A.of('Citizen', { wallet: WALLET }), world: WORLD, host: originalHostRef(WORLD, HOST), hostId: HOST,
    home: HOME, origin: { p: '128', q: '0', tile: 60 }, holding: A.of('Holding', { p: 128, q: 0, site: 3 }),
    programVersion: 16388, ruleset: '01'.repeat(32), unit: 0, faction: 0, holdingFlags: 0 };
  const request = outboundSnapshotRequest(source, [0], { minSlot: '99' }), report = syntheticOutboundSnapshot(request, options);
  const d = (name, kind) => decode(kind, fromBase64(report.accounts[name].bytes_b64), { profile: 2 });
  const fs = { mode: 'play', season: d('season', 'Season'), citizen: d('citizen', 'Citizen'), holdings: [d('holding', 'Holding')],
    wallet: { address: WALLET }, session: null, resident: null, meStatus: 'ready', meAnswered: true, activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: HOST, pop: OUTBOUND_POP },
    nowBell: 10, chain: { rate: 1, last: { slot: 99, unix: 1800006000 }, now: () => 1800006000 },
    provinces: new Map([['128,0', { province: d('standing', 'Province') }]]), land: { stage: 'final' },
    marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: { programId: PROGRAM, seasonId: '7', cluster: 'localnet', addresses: A }, relay: '/gw', source: {} };
  openOutbound(fs, ctx); editOutbound(fs, ctx, 'step', '0'); editOutbound(fs, ctx, 'arriveBell', '12');
  assert.ok(fs.expeditionCompose.source, fs.expeditionCompose.error);
  return { source, request, report, fs, ctx };
}

test('browser and server agree on request and all unique raw account/Clock content bindings', () => {
  const f = fixture();
  assert.equal(outboundSnapshotRequestDigest(f.request), serverRequestDigest(f.request));
  assert.deepEqual(outboundSnapshotReport(f.report, f.request), f.report);
  const data = parseOutboundSnapshot(f.report, f.request, f);
  assert.equal(data.coherent, true); assert.equal(data.contentConsistent, true); assert.equal(data.authorityVerified, false);
  assert.equal(data.clock.unixTimestamp, 1800006000n); assert.equal(data.clock.slot, 5000n);
  const ready = evaluateOriginalOutboundReady({ ...data, holding: data.holdingBytes, arriveBell: 12, tip: 20000n });
  assert.equal(ready.ok, true, ready.code);
  const route = evaluateOutboundRoute({ ...data, directions: [0], departTs: data.clock.unixTimestamp + 90n, arriveBell: 12 });
  assert.equal(route.ok, true, route.code); assert.equal(route.travelSecs, 120); assert.equal(data.executable, false);
});

test('source aliases, metadata, clock, scope, row order and content tampering are refused', () => {
  const f = fixture();
  const changes = [j => { j.scope.wallet = PROGRAM; }, j => { j.source.coherent = false; }, j => { j.source.authority_verified = true; },
    j => { j.source.context_slot = '98'; }, j => { j.clock.unix_timestamp = '1800005999'; }, j => { j.source.commitment = 'processed'; },
    j => { j.accounts.citizen.owner = WALLET; }, j => { j.accounts.citizen.executable = true; },
    j => { j.accounts.home = { ...j.accounts.home, lamports: '1' }; }, j => { j.accounts.citizen.lamports = '1'; },
    j => { j.route[0].key = '00'.repeat(50); }, j => { j.route[0].account.address = WALLET; }, j => { j.route.push(j.route[0]); },
    j => { j.route[0].account.bytes_b64 += '='; }, j => { j.executable = true; }, j => { j.source.digest = 'ff'.repeat(32); }];
  for (const change of changes) { const report = structuredClone(f.report); change(report); assert.throws(() => parseOutboundSnapshot(report, f.request, f)); }
});

test('unknown route land is bound as absent and cannot become a traversable route', () => {
  const f = fixture({ missing: true }), data = parseOutboundSnapshot(f.report, f.request, f);
  assert.equal(data.lands.size, 0); assert.equal(data.unavailable.length, 1);
  assert.equal(evaluateOutboundRoute({ ...data, directions: [0], departTs: data.clock.unixTimestamp + 90n, arriveBell: 12 }).code, 'RouteLandMissing');
  const bad = structuredClone(f.report); bad.accounts.season = null;
  assert.throws(() => parseOutboundSnapshot(bad, f.request, f));
});

test('actual composer consumes the new POST through bounded readInspection without mutating ordinary game state', async () => {
  const f = fixture(), keep = [f.fs.provinces, f.fs.holdings, f.fs.selected, f.fs.compose, f.fs.marches, f.fs.book];
  let received;
  await inspectOutboundContext(f.fs, { context: () => f.ctx, read: async (request, options) => {
    received = request; assert.equal(options.relay, '/gw'); assert.equal(options.isCurrent(), true);
    return syntheticOutboundSnapshot(request);
  } });
  assert.equal(received.min_slot, '99');
  const check = f.fs.expeditionCompose.contextCheck;
  assert.equal(check.status, 'read'); assert.equal(check.ready.ok, true, check.ready.code); assert.equal(check.report.ok, true, check.report.code);
  assert.equal(check.executable, false); assert.equal(check.signed, false); assert.equal(check.enqueued, false);
  assert.equal(check.departTs, '1800006090'); assert.equal(f.fs.session, null);
  assert.deepEqual([f.fs.provinces, f.fs.holdings, f.fs.selected, f.fs.compose, f.fs.marches, f.fs.book], keep);
  let calls = 0;
  const data = await readOutboundSnapshot(f.source, [0], { relay: '/gw', minSlot: '99', fetch: async (url, init) => {
    calls++; assert.equal(url, '/gw/f/expedition/preview'); assert.equal(init.method, 'POST'); assert.equal(init.cache, 'no-store');
    return new Response(JSON.stringify(syntheticOutboundSnapshot(JSON.parse(init.body))));
  } });
  assert.equal(calls, 1); assert.equal(data.status, 'snapshot');
});

test('fractional accelerated rates and insufficient current stamina remain explicit observations', async () => {
  const f = fixture(); f.fs.chain.rate = 45.25; openOutbound(f.fs, f.ctx); editOutbound(f.fs, f.ctx, 'step', '0'); editOutbound(f.fs, f.ctx, 'arriveBell', '12');
  await inspectOutboundContext(f.fs, { context: () => f.ctx, read: async request => syntheticOutboundSnapshot(request, { stamina: 73 }) });
  const r = f.fs.expeditionCompose.contextCheck;
  assert.equal(r.status, 'read'); assert.equal(r.departTs, '1800006091'); assert.equal(r.ready.code, 'Cooldown');
  assert.equal(r.report.ok, true); assert.equal(r.executable, false);
});

test('edits, close, context changes, repeated checks and captured-land reads supersede old snapshots', async () => {
  const changes = [f => editOutbound(f.fs, f.ctx, 'step', '1'), f => clearOutbound(f.fs), f => { f.fs.nowBell++; },
    f => { f.ctx.relay = '/other'; }, f => { f.ctx.source = {}; }, f => { f.fs.holdings[0].flags++; }];
  for (const change of changes) {
    const f = fixture(); let release, seenSignal;
    const pending = inspectOutboundContext(f.fs, { context: () => f.ctx, read: (request, options) => {
      seenSignal = options.signal; return new Promise(r => { release = () => r(syntheticOutboundSnapshot(request)); });
    } });
    change(f); release(); await pending;
    assert.equal(f.fs.expeditionCompose.contextCheck, null); assert.equal(seenSignal.aborted, true);
  }
  const f = fixture(), replies = [];
  const read = request => new Promise(r => replies.push(() => r(syntheticOutboundSnapshot(request))));
  const old = inspectOutboundContext(f.fs, { context: () => f.ctx, read });
  const fresh = inspectOutboundContext(f.fs, { context: () => f.ctx, read });
  replies[0](); await old; assert.equal(f.fs.expeditionCompose.contextCheck.status, 'loading');
  replies[1](); await fresh; assert.equal(f.fs.expeditionCompose.contextCheck.status, 'read');
  await inspectOutboundRoute(f.fs, { context: () => f.ctx });
  assert.equal(f.fs.expeditionCompose.contextCheck, null);
});
