// The dedicated local-play relay's read-only `POST /f/expedition/preview` (src/frontier/local-play-preview.mjs): the
// existing preview adapter under the relay's fixed pins, narrowed to the outbound snapshot request of the relay's own
// wallet (and its pinned payer for resident reads). The one-shot child is an injected stub: nothing is spawned, no RPC, no network beyond a loopback listener
// on an ephemeral port. No key is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encode } from '../client/src/base58.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { EXPEDITION_MAX_CONCURRENT, EXPEDITION_MAX_OUTPUT_BYTES, EXPEDITION_TIMEOUT_MS, EXPEDITION_REQUEST_SCHEMA, EXPEDITION_REPORT_SCHEMA, expeditionRequestDigest } from '../src/frontier/expedition-preview.mjs';
import { OUTBOUND_SNAPSHOT_REQUEST_SCHEMA as REQUEST, OUTBOUND_SNAPSHOT_REPORT_SCHEMA as REPORT,
  outboundSnapshotRequestDigest, outboundSnapshotAddresses, outboundSnapshotDigest } from '../src/frontier/outbound-snapshot.mjs';
import { createLocalPlayRelay, LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH, ROUTES } from '../src/frontier/local-play-relay.mjs';
import { createLocalPlayPreview, ExpeditionPreviewError, LOCAL_PLAY_PREVIEW_ROUTE } from '../src/frontier/local-play-preview.mjs';
import { serveLocalPlayRelay, parseArgs } from '../src/frontier/local-play-relay-server.mjs';

const address = n => encode(new Uint8Array(32).fill(n));
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], WALLET = address(0x71), BIN = '/operator/bin/frontier-original-expedition-preview';
const cfg = (over = {}) => ({ localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: WALLET,
  rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/nonexistent/frontier-experimental-expedition-depart-prepare', cuLimit: '1000000', loadedLimit: '1048576', ...over });
const request = (over = {}) => ({ schema: REQUEST, operation: 'outbound_snapshot', cluster: 'localnet', program: LOCAL_PLAY_PROGRAM, season: SEASON, season_id: '11',
  deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH },
  host: canonicalOriginalHostRef({ world: worldIdOf(SEASON, LOCAL_PLAY_PROGRAM), p: '128', q: '0', site: 0, gen: 1, seq: 0 }),
  wallet: WALLET, origin: { p: '128', q: '0', tile: 30 }, directions: Array(16).fill(0), min_slot: '100', ...over });
/** A whole same-context report for `r`, in the adapter's validated shape (as frontier-outbound-snapshot.test.mjs). */
function report(r = request()) {
  const expected = outboundSnapshotAddresses(r), rows = new Map();
  const row = (at, size) => { if (!rows.has(at)) rows.set(at, { address: at, owner: r.program, lamports: '5000', executable: false, bytes_b64: Buffer.alloc(size).toString('base64') }); return rows.get(at); };
  const accounts = Object.fromEntries(Object.entries(expected.source).map(([name, at]) => [name, row(at, { season: 2048, citizen: 384, holding: 1280, home: 4736, standing: 4736 }[name])]));
  const route = expected.route.map(({ key, p, q, address: at, wide }) => ({ key, p, q, account: row(at, wide ? 4864 : 4736) }));
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(123n, 0); clock.writeBigInt64LE(1800006000n, 32);
  const source = { kind: 'single_snapshot_source', read_calls: '1', coherent: true, single_response: true, context_slot: '123',
    min_slot: r.min_slot, commitment: 'confirmed', digest: null, authority_verified: false, freshness: 'unknown', complete_world_view: false };
  source.digest = outboundSnapshotDigest(source, rows, clock);
  return { schema: REPORT, status: 'snapshot', request_digest: outboundSnapshotRequestDigest(r), scope: structuredClone(r), source,
    clock: { slot: '123', unix_timestamp: '1800006000', bytes_b64: clock.toString('base64') }, accounts, route, blocker: null,
    observation_only: true, dispatch_available: false, executable: false, admitted: false, signed: false, enqueued: false };
}
function harness(over = {}) {
  const calls = [], children = [], timers = [];
  const preview = createLocalPlayPreview({ cfg: cfg(over), previewBin: BIN,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimer: t => { if (t) t.cleared = true; },
    spawn: (bin, args, options) => {
      calls.push({ bin, args, options }); const c = new EventEmitter();
      c.stdin = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin.end = payload => { c.input = payload; }; c.kill = signal => { c.killed = signal; };
      c.report = (v, code = ['snapshot', 'preview'].includes(v.status) ? 0 : 2) => { c.stdout.emit('data', Buffer.from(JSON.stringify(v))); c.emit('close', code, null); };
      children.push(c); return c;
    } });
  return { preview, calls, children, timers };
}
const refused = (p, code) => assert.rejects(p, e => e instanceof ExpeditionPreviewError && e.code === code);
const tick = () => new Promise(r => setImmediate(r));

test('a valid request reaches the existing one-shot read under the relay\'s own pins, and its validated report comes back whole', async () => {
  const h = harness(), r = request();
  const pending = h.preview.inspect(r);
  assert.equal(h.calls.length, 1);
  const { bin, args, options } = h.calls[0];
  assert.equal(bin, BIN); assert.deepEqual(args, ['--outbound-snapshot', '--rpc-url', 'http://127.0.0.1:41964'], 'the relay\'s own loopback runner, never a caller\'s');
  assert.deepEqual(options, { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }, 'no shell, no environment: no key can reach it');
  assert.deepEqual(JSON.parse(h.children[0].input), r, 'the canonical request, as asked');
  assert.equal(h.timers[0].ms, EXPEDITION_TIMEOUT_MS);
  const v = report(r); h.children[0].report(v);
  assert.deepEqual(await pending, v);
  assert.equal(v.signed, false); assert.equal(v.executable, false); assert.equal(v.observation_only, true);
  // a report that is not this request's whole validated report is refused (the adapter's own validation, kept)
  for (const change of [x => { x.signed = true; }, x => { x.source.digest = '00'.repeat(32); }, x => { x.scope.wallet = address(0x72); }, x => { x.accounts.holding.owner = address(0x72); }]) {
    const p = h.preview.inspect(r), bad = structuredClone(v); change(bad); h.children.at(-1).report(bad);
    await refused(p, 'ExpeditionPreviewInvalidReport');
  }
  // too much output is cut off and the child killed
  const big = h.preview.inspect(r), c = h.children.at(-1);
  c.stdout.emit('data', Buffer.alloc(EXPEDITION_MAX_OUTPUT_BYTES + 1)); await refused(big, 'ExpeditionPreviewOutputTooLarge'); assert.equal(c.killed, 'SIGKILL'); c.emit('close', null, 'SIGKILL');
});

test('another identity, another wallet or another kind of inspection is refused before anything is spawned', async () => {
  const h = harness();
  const other = address(0x33);
  for (const [over, code] of [[{ wallet: other }, 'ExpeditionPreviewScopeMismatch'], [{ payer: WALLET }, 'ExpeditionPreviewScopeMismatch'], [{ schema: EXPEDITION_REQUEST_SCHEMA }, 'ExpeditionPreviewScopeMismatch'],
    [{ schema: 'frontier-experimental-expedition-depart-prepare-request-v1' }, 'ExpeditionPreviewScopeMismatch'],
    [{ cluster: 'devnet' }, 'ExpeditionPreviewScopeMismatch'], [{ cluster: 'mainnet-beta' }, 'ExpeditionPreviewScopeMismatch'],
    [{ deployment: { program_version: '16388', ruleset_hash: LOCAL_PLAY_RULESET_HASH } }, 'ExpeditionPreviewScopeMismatch'],
    [{ deployment: { program_version: '18436', ruleset_hash: 'ab'.repeat(32) } }, 'ExpeditionPreviewScopeMismatch'],
    [{ operation: 'send' }, 'ExpeditionPreviewInvalidRequest'], [{ signature: 'x' }, 'ExpeditionPreviewInvalidRequest'], [{ rpc: 'http://127.0.0.1:41965' }, 'ExpeditionPreviewInvalidRequest'],
    [{ min_slot: '-1' }, 'ExpeditionPreviewInvalidRequest'], [{ directions: [] }, 'ExpeditionPreviewInvalidRequest']]) {
    await refused(h.preview.inspect(request(over)), code);
  }
  // another program with its own Season: not this relay's deployment
  const season2 = seasonPda(other, 11)[0];
  await refused(h.preview.inspect(request({ program: other, season: season2, host: canonicalOriginalHostRef({ world: worldIdOf(season2, other), p: '128', q: '0', site: 0, gen: 1, seq: 0 }) })), 'ExpeditionPreviewScopeMismatch');
  for (const body of [null, 'x', [], 7]) await refused(h.preview.inspect(body), 'ExpeditionPreviewInvalidRequest');
  assert.equal(h.calls.length, 0, 'nothing was spawned for any of them');
  // the relay's pins and the binary's path are fixed at construction: anything else is no preview at all
  const never = () => { throw new Error('never'); };
  for (const previewBin of ['relative/bin', undefined, null, '', 7]) assert.throws(() => createLocalPlayPreview({ cfg: cfg(), previewBin, spawn: never }), /local-play preview/, String(previewBin));
  for (const over of [{ localPlay: false }, { rpc: 'http://127.0.0.1:8899' }, { program: other }, { rulesetHash: '00'.repeat(32) }, { wallet: 'x' }, { previewBin: BIN }]) {
    assert.throws(() => createLocalPlayPreview({ cfg: cfg(over), previewBin: BIN, spawn: never }), /local-play preview/, JSON.stringify(over));
  }
});

test('cancel, timeout, the two-at-a-time limit and close are the adapter\'s own, kept', async () => {
  const h = harness(), r = request();
  // a caller that goes away: the child is killed, its slot is held until it has really closed
  const ac = new AbortController(), gone = h.preview.inspect(r, { signal: ac.signal });
  ac.abort(); await refused(gone, 'ExpeditionPreviewAborted'); assert.equal(h.children[0].killed, 'SIGKILL');
  const second = h.preview.inspect(r);
  assert.equal(EXPEDITION_MAX_CONCURRENT, 2);
  await refused(h.preview.inspect(r), 'ExpeditionPreviewBusy'); assert.equal(h.calls.length, 2, 'a third is not spawned while two have not closed');
  h.children[0].emit('close', null, 'SIGKILL');
  // the time limit
  const slow = h.preview.inspect(r); assert.equal(h.calls.length, 3);
  h.timers.at(-1).fn(); await refused(slow, 'ExpeditionPreviewTimeout'); assert.equal(h.children[2].killed, 'SIGKILL'); h.children[2].emit('close', null, 'SIGKILL');
  // an already cancelled request spawns nothing
  const dead = new AbortController(); dead.abort();
  await refused(h.preview.inspect(r, { signal: dead.signal }), 'ExpeditionPreviewAborted'); assert.equal(h.calls.length, 3);
  // close: what is in flight is stopped, and nothing more is read
  h.preview.close();
  await refused(second, 'ExpeditionPreviewAborted'); assert.equal(h.children[1].killed, 'SIGKILL');
  await refused(h.preview.inspect(r), 'ExpeditionPreviewUnavailable'); assert.equal(h.calls.length, 3);
});

test('the loopback listener dispatches the route only when a preview is given; a client that leaves cancels its read; closing the listener closes it; Depart is as it was', async () => {
  const prepareCalls = [];
  const relay = () => createLocalPlayRelay({ cfg: cfg(), prepare: { prepare: async body => { prepareCalls.push(body); return { status: 'blocked', blocker: { code: 'TransitSlotBusy' } }; }, close() {} }, rpc: async () => ({ error: { code: -1 } }) });
  const post = (port, path, body, { signal } = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), signal });
  assert.equal(LOCAL_PLAY_PREVIEW_ROUTE, 'POST /f/expedition/preview');
  // without a preview: 404, as before
  const bare = await serveLocalPlayRelay(relay(), 0);
  try {
    const res = await post(bare.port, '/f/expedition/preview', request());
    assert.equal(res.status, 404); assert.equal((await res.json()).code, 'NotFound');
  } finally { await bare.close(); }
  // with one
  const h = harness(), s = await serveLocalPlayRelay(relay(), 0, { preview: h.preview });
  let closed = false;
  try {
    const r = request(), asked = post(s.port, '/f/expedition/preview', r);
    while (h.children.length < 1) await tick();
    assert.deepEqual(JSON.parse(h.children[0].input), r);
    h.children[0].report(report(r));
    const res = await asked; assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), report(r));
    // refusals carry the adapter's own status and code, and nothing else; nothing is spawned for them
    for (const [body, status, code] of [[request({ wallet: address(0x33) }), 409, 'ExpeditionPreviewScopeMismatch'], [request({ schema: EXPEDITION_REQUEST_SCHEMA }), 409, 'ExpeditionPreviewScopeMismatch'],
      [request({ operation: 'send' }), 400, 'ExpeditionPreviewInvalidRequest'], ['{', 400, 'InvalidJson'], [JSON.stringify({ pad: 'x'.repeat(17 * 1024) }), 413, 'BodyTooLarge']]) {
      const bad = await post(s.port, '/f/expedition/preview', body), answer = await bad.json();
      assert.equal(bad.status, status, code); assert.equal(answer.code, code); assert.deepEqual(Object.keys(answer).sort(), ['code', 'error']);
      assert.ok(!JSON.stringify(answer).includes(BIN) && !JSON.stringify(answer).includes('41964'));
    }
    assert.equal(h.calls.length, 1);
    // only POST; the query string is not part of the route
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/f/expedition/preview`)).status, 404);
    // a client that goes away before the answer: its read is cancelled
    const ac = new AbortController(), left = post(s.port, '/f/expedition/preview', r, { signal: ac.signal }).catch(e => e);
    while (h.children.length < 2) await tick();
    ac.abort(); await left;
    while (!h.children[1].killed) await tick();
    assert.equal(h.children[1].killed, 'SIGKILL'); h.children[1].emit('close', null, 'SIGKILL');
    // the Depart routes are served exactly as before, by the relay, not by the preview
    const info = await (await fetch(`http://127.0.0.1:${s.port}/f/local-play/info`)).json();
    assert.equal(info.wallet, WALLET); assert.deepEqual(info.routes, ROUTES); assert.ok(!JSON.stringify(info.routes).includes('preview'));
    const dep = await post(s.port, '/f/local-play/depart/prepare', { cluster: 'localnet', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: WALLET, payer: WALLET, deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH } });
    assert.equal(dep.status, 200); assert.equal(prepareCalls.length, 1); assert.equal(h.calls.length, 2, 'a departure spawns no preview');
    const wrong = await post(s.port, '/f/local-play/depart/prepare', { cluster: 'localnet', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: address(0x33), payer: address(0x33), deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH } });
    assert.equal((await wrong.json()).code, 'LocalPlayScopeMismatch'); assert.equal(prepareCalls.length, 1);
    // closing the listener closes the preview: a read in flight is stopped
    const last = post(s.port, '/f/expedition/preview', r).then(x => x.json()).catch(e => e);
    while (h.children.length < 3) await tick();
    const closing = s.close(); closed = true;
    assert.equal(h.children[2].killed, 'SIGKILL'); h.children[2].emit('close', null, 'SIGKILL');
    const answer = await last; assert.ok(answer instanceof Error || answer.code === 'ExpeditionPreviewAborted');
    await closing;
    await refused(h.preview.inspect(r), 'ExpeditionPreviewUnavailable');
  } finally { if (!closed) await s.close(); }
});

test('the command line: --preview-bin is optional and given once; every other flag is still required', () => {
  const base = ['--local-play', '--listen-port', '41966', '--rpc', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--wallet', WALLET,
    '--ruleset-hash', LOCAL_PLAY_RULESET_HASH, '--prepare-bin', '/abs/prepare', '--cu-limit', '1000000', '--loaded-limit', '1048576'];
  const plain = parseArgs(base);
  assert.equal(plain.port, 41966); assert.equal(plain.previewBin, null, 'without the flag there is no preview route');
  const withBin = parseArgs([...base, '--preview-bin', BIN]);
  assert.equal(withBin.previewBin, BIN); assert.deepEqual(withBin.cfg, plain.cfg, 'the relay\'s own configuration is the same closed one');
  assert.equal(Object.hasOwn(withBin.cfg, 'previewBin'), false);
  assert.throws(() => parseArgs([...base, '--preview-bin', BIN, '--preview-bin', BIN]), /bad argument/);
  assert.throws(() => parseArgs([...base, '--preview-bin']), /bad argument/);
  assert.throws(() => parseArgs(base.slice(0, -2)), /every flag is required/);
  assert.throws(() => parseArgs(['--local-play', '--preview-bin', BIN]), /every flag is required/);
  assert.throws(() => parseArgs([...base, '--preview-rpc', 'http://127.0.0.1:1']), /bad argument/);
});

const residentRequest = (over = {}) => ({ schema: EXPEDITION_REQUEST_SCHEMA, operation: 'inspect', cluster: 'localnet',
  program: LOCAL_PLAY_PROGRAM, season: SEASON, deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH },
  host: request().host, original_owner: address(0x72), standing: { p: '129', q: '0' }, min_slot: '100', wallet: WALLET, payer: WALLET, ...over });
const residentBlocked = (r = residentRequest()) => ({ schema: EXPEDITION_REPORT_SCHEMA, status: 'blocked', stage: 'plan',
  request_digest: expeditionRequestDigest(r), scope: structuredClone(r),
  source: { kind: 'single_snapshot_source', read_calls: '1', coherent: true, single_response: true,
    context_slot: '123', digest: 'ab'.repeat(32), authority_verified: false, freshness: 'unknown', complete_world_view: false },
  blocker: { code: 'ResolveBehind' }, facts: null, draft: null, draft_blocker: null,
  dispatch_available: false, admitted: false, signed: false, enqueued: false, automatic_send: false, completion_proven: false, history_verified: false });

test('resident inspection reaches the existing keyless reader with the same pins and preserves a genuine ResolveBehind blocker', async () => {
  const h = harness(), r = residentRequest(), p = h.preview.inspect(r);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].bin, BIN);
  assert.deepEqual(h.calls[0].args, ['--rpc-url', cfg().rpc]);
  assert.deepEqual(h.calls[0].options, { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  assert.deepEqual(JSON.parse(h.children[0].input), r);
  const v = residentBlocked(r); h.children[0].report(v);
  assert.deepEqual(await p, v, 'do not turn the plan blocker into success');
  for (const change of [v => { v.signed = true; }, v => { v.dispatch_available = true; }, v => { v.scope.payer = address(0x73); }, v => { v.request_digest = '00'.repeat(32); }]) {
    const pending = h.preview.inspect(r), bad = structuredClone(v); change(bad); h.children.at(-1).report(bad);
    await refused(pending, 'ExpeditionPreviewInvalidReport');
  }
});

test('resident inspection rejects a foreign or missing wallet/payer and every mismatched deployment before spawning', async () => {
  const h = harness(), other = address(0x73);
  for (const over of [{ wallet: null }, { wallet: other }, { payer: null }, { payer: other }, { payer: undefined },
    { schema: 'frontier-experimental-expedition-prepare-request-v1' }, { cluster: 'devnet' }, { program: other }, { season: address(0x74) },
    { deployment: { program_version: '16388', ruleset_hash: LOCAL_PLAY_RULESET_HASH } },
    { deployment: { program_version: '18436', ruleset_hash: '00'.repeat(32) } }]) {
    await refused(h.preview.inspect(residentRequest(over)), 'ExpeditionPreviewScopeMismatch');
  }
  for (const over of [{ operation: 'send' }, { rpc: cfg().rpc }, { signature: 'x' }, { min_slot: '-1' }, { standing: { p: '0129', q: '0' } }]) {
    await refused(h.preview.inspect(residentRequest(over)), 'ExpeditionPreviewInvalidRequest');
  }
  assert.equal(h.calls.length, 0);
});

test('outbound and resident reads share the same two-child budget and cancellation lifecycle', async () => {
  const h = harness(), ac = new AbortController();
  const p1 = h.preview.inspect(request()), p2 = h.preview.inspect(residentRequest(), { signal: ac.signal });
  await refused(h.preview.inspect(residentRequest()), 'ExpeditionPreviewBusy');
  assert.equal(h.calls.length, 2);
  ac.abort(); await refused(p2, 'ExpeditionPreviewAborted');
  await refused(h.preview.inspect(request()), 'ExpeditionPreviewBusy');
  h.children[1].emit('close', null, 'SIGKILL');
  h.children[0].report(report()); await p1;
  h.preview.close();
  await refused(h.preview.inspect(residentRequest()), 'ExpeditionPreviewUnavailable');
});

test('the existing loopback preview route serves a resident read without opening any transaction route', async () => {
  const h = harness();
  const relay = createLocalPlayRelay({ cfg: cfg(), prepare: { prepare() { assert.fail('no prepare during inspection'); }, close() {} }, rpc() { assert.fail('no transaction RPC during inspection'); } });
  const s = await serveLocalPlayRelay(relay, 0, { preview: h.preview });
  try {
    const r = residentRequest(), pending = fetch(`http://127.0.0.1:${s.port}/f/expedition/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) });
    while (!h.children.length) await tick();
    assert.deepEqual(JSON.parse(h.children[0].input), r); h.children[0].report(residentBlocked(r));
    const res = await pending; assert.equal(res.status, 200); assert.deepEqual(await res.json(), residentBlocked(r));
    const info = await (await fetch(`http://127.0.0.1:${s.port}/f/local-play/info`)).json();
    assert.deepEqual(info.routes, ROUTES, 'the route advertisement and send capabilities are unchanged');
  } finally { await s.close(); }
});
