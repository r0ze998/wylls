// Pure public bytes and injected one-shot child transport only. No RPC/network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encode } from '../client/src/base58.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { createExpeditionPreview } from '../src/frontier/expedition-preview.mjs';
import { OUTBOUND_SNAPSHOT_REQUEST_SCHEMA as REQUEST, OUTBOUND_SNAPSHOT_REPORT_SCHEMA as REPORT,
  outboundSnapshotRequest, outboundSnapshotRequestDigest, outboundSnapshotAddresses, outboundSnapshotDigest,
  outboundSnapshotReport } from '../src/frontier/outbound-snapshot.mjs';

const address = n => encode(new Uint8Array(32).fill(n));
function request() {
  const program = address(0x12), season = seasonAddresses(program, '11').season;
  return { schema: REQUEST, operation: 'outbound_snapshot', cluster: 'localnet', program, season, season_id: '11',
    deployment: { program_version: '16388', ruleset_hash: 'ab'.repeat(32) },
    host: canonicalOriginalHostRef({ world: worldIdOf(season, program), p: '128', q: '0', site: 0, gen: 1, seq: 0 }),
    wallet: address(0x71), origin: { p: '128', q: '0', tile: 30 }, directions: Array(16).fill(0), min_slot: '100' };
}
function report(r = request()) {
  const expected = outboundSnapshotAddresses(r), rows = new Map();
  const row = (address, size) => {
    if (!rows.has(address)) rows.set(address, { address, owner: r.program, lamports: '5000', executable: false, bytes_b64: Buffer.alloc(size).toString('base64') });
    return rows.get(address);
  };
  const accounts = Object.fromEntries(Object.entries(expected.source).map(([name, address]) =>
    [name, row(address, { season: 2048, citizen: 384, holding: 1280, home: 4736, standing: 4736 }[name])]));
  const route = expected.route.map(({ key, p, q, address, wide }) => ({ key, p, q, account: row(address, wide ? 4864 : 4736) }));
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(123n, 0); clock.writeBigInt64LE(1800006000n, 32);
  const source = { kind: 'single_snapshot_source', read_calls: '1', coherent: true, single_response: true, context_slot: '123',
    min_slot: r.min_slot, commitment: 'confirmed', digest: null, authority_verified: false, freshness: 'unknown', complete_world_view: false };
  source.digest = outboundSnapshotDigest(source, rows, clock);
  return { schema: REPORT, status: 'snapshot', request_digest: outboundSnapshotRequestDigest(r), scope: structuredClone(r), source,
    clock: { slot: '123', unix_timestamp: '1800006000', bytes_b64: clock.toString('base64') }, accounts, route, blocker: null,
    observation_only: true, dispatch_available: false, executable: false, admitted: false, signed: false, enqueued: false };
}
function harness(r = request()) {
  const calls = [], children = [];
  const api = createExpeditionPreview({ cfg: { cluster: r.cluster, programId: r.program,
    expeditionPreviewBin: '/operator/bin/frontier-original-expedition-preview', expeditionPreviewRpc: 'http://127.0.0.1:41010/rpc',
    expeditionPreviewProgramVersion: r.deployment.program_version, expeditionPreviewRulesetHash: r.deployment.ruleset_hash }, season: r.season,
    spawn: (bin, args, options) => {
      calls.push({ bin, args, options }); const c = new EventEmitter();
      c.stdin = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin.end = payload => { c.input = payload; }; c.kill = signal => { c.killed = signal; };
      c.report = (v, code = v.status === 'snapshot' ? 0 : 2) => { c.stdout.emit('data', Buffer.from(JSON.stringify(v))); c.emit('close', code, null); };
      children.push(c); return c;
    } });
  return { api, calls, children };
}

test('request is closed, canonical and bounded to original source plus four entered provinces', () => {
  const r = request(); assert.deepEqual(outboundSnapshotRequest(r), r);
  const addresses = outboundSnapshotAddresses(r);
  assert.equal(addresses.source.home, addresses.source.standing); assert.ok(addresses.route.length <= 4);
  assert.equal(addresses.route[0].wide, true);
  for (const patch of [{ operation: 'send' }, { directions: [] }, { directions: [6] }, { directions: Array(33).fill(0) },
    { directions: Array(24).fill(0) }, { origin: { p: '129', q: '0', tile: 30 } }, { season_id: '011' }, { min_slot: '-1' },
    { season: address(0x33) }, { signature: 'not-accepted' }]) assert.throws(() => outboundSnapshotRequest({ ...r, ...patch }));
});
test('full same-context report remains observation-only and digest binds all bytes, owners and clocks', () => {
  const r = request(), v = report(r); assert.equal(outboundSnapshotReport(v, r), v);
  for (const change of [v => { v.source.context_slot = '124'; }, v => { v.clock.unix_timestamp = '1800006001'; },
    v => { v.source.digest = '00'.repeat(32); }, v => { v.accounts.citizen.lamports = '5001'; },
    v => { v.accounts.holding.owner = address(0x72); }, v => { v.accounts.season.executable = true; },
    v => { v.accounts.citizen.bytes_b64 = Buffer.alloc(384, 1).toString('base64'); },
    v => { v.route.reverse(); }, v => { v.source.authority_verified = true; }, v => { v.source.freshness = 'current'; },
    v => { v.signed = true; }, v => { v.executable = true; }, v => { v.admitted = true; },
    v => { v.scope.directions[0] = 1; }, v => { v.accounts.standing.lamports = '5001'; }, v => { v.source.min_slot = '99'; }]) {
    const value = structuredClone(v); change(value); assert.throws(() => outboundSnapshotReport(value, r));
  }
});
test('absent route is explicit and digest-bound, never filled from another response', () => {
  const r = request(), v = report(r), a = outboundSnapshotAddresses(r), rows = new Map(Object.values(v.accounts).map(x => [x.address, x]));
  v.route[0].account = null;
  v.route.forEach((x, i) => rows.set(a.route[i].address, x.account));
  v.source.digest = outboundSnapshotDigest(v.source, rows, Buffer.from(v.clock.bytes_b64, 'base64'));
  assert.equal(outboundSnapshotReport(v, r).route[0].account, null);
  v.route[0].account = report(r).route[0].account;
  assert.throws(() => outboundSnapshotReport(v, r));
});
test('existing optional transport selects only the new keyless CLI mode and echoes exact request', async () => {
  const r = request(), h = harness(r), pending = h.api.inspect(r);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args, ['--outbound-snapshot', '--rpc-url', 'http://127.0.0.1:41010/rpc']);
  assert.deepEqual(h.calls[0].options.env, {}); assert.equal(h.calls[0].options.shell, false);
  assert.deepEqual(JSON.parse(h.children[0].input), r);
  h.children[0].report(report(r)); assert.equal((await pending).status, 'snapshot'); h.api.close();
});
test('wrong scope, mutated report, cancellation and shared concurrency remain fail closed', async () => {
  const r = request(), h = harness(r);
  await assert.rejects(h.api.inspect({ ...r, cluster: 'devnet' }), e => e.code === 'ExpeditionPreviewScopeMismatch');
  assert.equal(h.calls.length, 0);
  const a = h.api.inspect(r), b = h.api.inspect(r);
  await assert.rejects(h.api.inspect(r), e => e.code === 'ExpeditionPreviewBusy');
  const bad = report(r); bad.dispatch_available = true; h.children[0].report(bad);
  await assert.rejects(a, e => e.code === 'ExpeditionPreviewInvalidReport');
  h.children[1].report(report(r)); await b;
  const control = new AbortController(), p = h.api.inspect(r, { signal: control.signal }); control.abort();
  await assert.rejects(p, e => e.code === 'ExpeditionPreviewAborted'); assert.equal(h.children[2].killed, 'SIGKILL');
  h.children[2].emit('close', null, 'SIGKILL'); h.api.close();
});
