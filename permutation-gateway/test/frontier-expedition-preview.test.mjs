// Manually audited, exact key-free subset. Real adapter and route, fake child
// emitters only. No subprocess, RPC, key store, relay startup, wallet or socket.
// App/config are source-binding checks and exact extracted functions, NOT a
// full app import/integration run (the optional gateway packages are absent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { encode as base58 } from '../client/src/base58.mjs';
import {
  createExpeditionPreview, expeditionPreviewConfigProblems, expeditionRpcUrlAllowed,
  expeditionRequest, expeditionRequestDigest, expeditionReport,
  EXPEDITION_REQUEST_SCHEMA, EXPEDITION_REPORT_SCHEMA, EXPEDITION_PREVIEW_ROUTE,
  EXPEDITION_MAX_REQUEST_BYTES, EXPEDITION_MAX_OUTPUT_BYTES, EXPEDITION_TIMEOUT_MS, EXPEDITION_MAX_CONCURRENT,
} from '../src/frontier/expedition-preview.mjs';
import { expeditionPreviewRoutes } from '../src/frontier/routes/expedition-preview.mjs';

const address = n => base58(new Uint8Array(32).fill(n));
const request = () => ({ schema: EXPEDITION_REQUEST_SCHEMA, operation: 'inspect', cluster: 'localnet',
  program: address(1), season: address(2), deployment: { program_version: '16388', ruleset_hash: 'ab'.repeat(32) },
  host: '01'.repeat(56), original_owner: address(3), standing: { p: '129', q: '0' }, min_slot: '7', wallet: null, payer: null });
const config = (r = request()) => ({ cluster: r.cluster, programId: r.program,
  expeditionPreviewBin: '/operator/bin/frontier-original-expedition-preview', expeditionPreviewRpc: 'http://127.0.0.1:41010/rpc',
  expeditionPreviewProgramVersion: r.deployment.program_version, expeditionPreviewRulesetHash: r.deployment.ruleset_hash });
const blocked = (r = request()) => ({ schema: EXPEDITION_REPORT_SCHEMA, status: 'blocked', stage: 'snapshot',
  request_digest: expeditionRequestDigest(r), scope: structuredClone(r),
  source: { kind: 'single_snapshot_source', read_calls: '1', coherent: false, single_response: false,
    context_slot: null, digest: null, authority_verified: false, freshness: 'unknown', complete_world_view: false },
  blocker: { code: 'SnapshotRpc' }, facts: null, draft: null, draft_blocker: null,
  dispatch_available: false, admitted: false, signed: false, enqueued: false, automatic_send: false, completion_proven: false, history_verified: false });

function harness(r = request()) {
  const calls = [], children = [], timers = new Map();
  let tick = 0;
  const api = createExpeditionPreview({ cfg: config(r), season: r.season,
    spawn: (binary, args, options) => {
      calls.push({ binary, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = payload => { child.input = payload; };
      child.kill = signal => { child.killed = signal; return true; };
      child.report = (value, exitCode = value.status === 'preview' ? 0 : 2) => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(value))); child.emit('close', exitCode, null);
      };
      children.push(child); return child;
    },
    setTimer: (fn, ms) => { const id = ++tick; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return { api, calls, children, timers, expire: () => [...timers.values()][0].fn() };
}
const codeIs = code => error => error.code === code && !/\/operator|127\.0\.0\.1|private/.test(error.message);
const golden = (action, kind) => JSON.parse(readFileSync(new URL(`../../frontier-node/crates/keeper/tests/fixtures/original_expedition_preview_${action}_${kind}.json`, import.meta.url), 'utf8'));

for (const action of ['return', 'dissolve']) test(`actual Rust ${action} golden: digest, canonical accounts, report and closed role tuple parity`, async () => {
  const r = golden(action, 'request'), report = golden(action, 'report');
  assert.deepEqual(expeditionRequest(r), r);
  assert.equal(expeditionRequestDigest(r), '65a9ee7524b1527b967b1c9c9b14e8c9c6e3ab442b48152ef2b67d68368925cf');
  assert.equal(expeditionRequestDigest(r), report.request_digest);
  assert.deepEqual(expeditionReport(report, r), report);
  const h = harness(r), pending = h.api.inspect(r), bytes = Buffer.from(JSON.stringify(report));
  h.children[0].stdout.emit('data', bytes.subarray(0, 113));
  h.children[0].stdout.emit('data', bytes.subarray(113));
  h.children[0].emit('close', 0, null);
  assert.deepEqual(await pending, report);
});

test('Rust positive reports reject coordinated address tampering, reordered roles and codec confusion', () => {
  const r = golden('return', 'request');
  for (const change of [v => { v.facts.standing_key = r.host.slice(0, 64) + '00'.repeat(16); },
    v => { v.facts.accounts.original_holding = address(15); v.draft.roles[4].address = address(15); },
    v => { v.facts.accounts.original_home = address(15); v.draft.roles[5].address = address(15); },
    v => { v.facts.accounts.wide_standing = address(15); v.draft.roles[2].address = address(15); },
    v => { v.facts.accounts.wide_roster = address(15); v.draft.roles[3].address = address(15); },
    v => { v.facts.accounts.owned_bridges.reverse(); }, v => { v.draft.roles.reverse(); },
    v => { v.draft.roles[0].signer = false; }, v => { v.draft.roles[3].writable = false; },
    v => { v.draft.roles.push(v.draft.roles[0]); }, v => { v.draft.admitted = true; },
    v => { v.draft.wire = 'forbidden'; }, v => { v.facts.instruction = {}; }, v => { v.facts.tag = 0; },
    v => { v.facts.signed = true; }, v => { v.facts.history_verified = true; },
    v => { v.facts.clock.slot = '99'; }, v => { v.facts.observed.unit = 8; },
    v => { v.facts.observed.entry = 56; }, v => { v.facts.observed.return_units = 12; },
    v => { v.facts.denials.push('UnknownDiagnostic'); }, v => { v.source.context_slot = '79'; }]) {
    const report = golden('return', 'report'); change(report);
    assert.throws(() => expeditionReport(report, r), codeIs('ExpeditionPreviewInvalidReport'));
  }
  const d = golden('dissolve', 'report'); d.draft.roles[0].writable = false;
  assert.throws(() => expeditionReport(d, golden('dissolve', 'request')), codeIs('ExpeditionPreviewInvalidReport'));
});

test('Return does not invent a wallet requirement; a Dissolve proposal must bind the original Citizen', () => {
  const r = golden('return', 'request'), report = golden('return', 'report');
  r.wallet = null; report.scope = r; report.request_digest = expeditionRequestDigest(r);
  assert.equal(expeditionReport(report, r).draft.action, 'Return');
  const d = golden('dissolve', 'request'), bad = golden('dissolve', 'report');
  d.wallet = address(15); bad.scope = d; bad.request_digest = expeditionRequestDigest(d);
  bad.draft.roles[0].address = d.wallet; bad.draft.roles[0].writable = false;
  assert.throws(() => expeditionReport(bad, d), codeIs('ExpeditionPreviewInvalidReport'));
});

test('feature is absent by default, complete only with explicit valid operator settings', () => {
  assert.equal(createExpeditionPreview({ cfg: { rpc: 'http://127.0.0.1:41010' }, season: address(2) }), null);
  assert.deepEqual(expeditionPreviewConfigProblems({}), []);
  const c = config();
  assert.deepEqual(expeditionPreviewConfigProblems(c), []);
  for (const key of ['expeditionPreviewBin', 'expeditionPreviewRpc', 'expeditionPreviewProgramVersion', 'expeditionPreviewRulesetHash']) {
    const partial = { ...c, [key]: null };
    assert.ok(expeditionPreviewConfigProblems(partial).length);
    assert.throws(() => createExpeditionPreview({ cfg: partial, season: address(2) }), codeIs('ExpeditionPreviewDisabled'));
  }
  for (const value of ['relative/bin', '', '/operator/\0private', 'x'.repeat(4097)]) {
    assert.ok(expeditionPreviewConfigProblems({ ...c, expeditionPreviewBin: value }).length);
  }
  for (const value of ['3', '16384.0', 16384, '65536', '016384', '32768']) {
    assert.ok(expeditionPreviewConfigProblems({ ...c, expeditionPreviewProgramVersion: value }).length);
  }
  for (const value of ['16384', '16388', '49152', '65535']) assert.deepEqual(expeditionPreviewConfigProblems({ ...c, expeditionPreviewProgramVersion: value }), []);
});

test('RPC grammar exactly permits explicit loopback HTTP, no fallback/URL credentials', () => {
  for (const url of ['http://127.0.0.1:1', 'http://127.0.0.1:65535/rpc-v1_A.~', 'http://[::1]:41010/']) assert.equal(expeditionRpcUrlAllowed(url), true, url);
  for (const url of ['https://127.0.0.1:41010', 'http://localhost:41010', 'http://127.0.0.2:41010', 'http://example.invalid:41010',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:000001', 'http://127.0.0.1:41010/?private=1',
    'http://user@127.0.0.1:41010/', 'http://127.0.0.1:41010/#fragment', 'http://127.0.0.1:41010/%2f',
    'http://127.0.0.1:41010/\n', `http://127.0.0.1:41010/${'a'.repeat(2048)}`]) assert.equal(expeditionRpcUrlAllowed(url), false, url);
});

test('request schema is closed, precise and preserves explicit nullable proposals', () => {
  const r = request(), frozen = expeditionRequest(r);
  r.standing.p = '999'; assert.equal(frozen.standing.p, '129');
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.deployment) && Object.isFrozen(frozen.standing));
  for (const change of [v => { delete v.payer; }, v => { v.rpc_url = 'http://private'; }, v => { v.operation = 'send'; },
    v => { v.schema = 'other'; }, v => { v.standing.p = 129; }, v => { v.standing.p = '9007199254740993.0'; },
    v => { v.standing.p = '-0'; }, v => { v.standing.p = '+1'; }, v => { v.standing.p = '01'; },
    v => { v.standing.p = '-9223372036854775809'; }, v => { v.min_slot = '18446744073709551616'; },
    v => { v.host += '00'; }, v => { v.host = 'AA'.repeat(56); }, v => { v.wallet = ''; },
    v => { v.payer = base58(new Uint8Array(32)); }, v => { v.deployment.ruleset_hash = 'AB'.repeat(32); },
    v => { v.deployment.rpc = 'private'; }, v => { v.standing.extra = true; }]) {
    const bad = request(); change(bad); assert.throws(() => expeditionRequest(bad), codeIs('ExpeditionPreviewInvalidRequest'));
  }
  const huge = request(); huge.standing.p = '9007199254740993';
  assert.equal(expeditionRequest(huge).standing.p, '9007199254740993');
});

test('canonical digest ignores JSON ordering and changes with every bound field', () => {
  const r = request(), digest = expeditionRequestDigest(r);
  const reordered = Object.fromEntries(Object.entries(r).reverse());
  reordered.deployment = Object.fromEntries(Object.entries(r.deployment).reverse());
  assert.equal(expeditionRequestDigest(reordered), digest);
  for (const change of [v => { v.cluster = 'devnet'; }, v => { v.program = address(8); }, v => { v.season = address(8); },
    v => { v.deployment.program_version = '16389'; }, v => { v.deployment.ruleset_hash = 'ef'.repeat(32); },
    v => { v.host = '02'.repeat(56); }, v => { v.original_owner = address(8); }, v => { v.standing.p = '130'; },
    v => { v.standing.q = '-1'; }, v => { v.min_slot = '8'; }, v => { v.wallet = address(8); }, v => { v.payer = address(8); }]) {
    const next = request(); change(next); assert.notEqual(expeditionRequestDigest(next), digest);
  }
});

test('deployment mismatches and bad inputs fail before a subprocess can start', async () => {
  const h = harness();
  for (const change of [v => { v.cluster = 'devnet'; }, v => { v.program = address(4); }, v => { v.season = address(4); },
    v => { v.deployment.program_version = '16389'; }, v => { v.deployment.ruleset_hash = 'cd'.repeat(32); }]) {
    const r = request(); change(r); await assert.rejects(h.api.inspect(r), codeIs('ExpeditionPreviewScopeMismatch'));
  }
  await assert.rejects(h.api.inspect({ ...request(), executable: '/private' }), codeIs('ExpeditionPreviewInvalidRequest'));
  assert.equal(h.calls.length, 0);
});

test('one fake process receives fixed args, private-free environment and stdin only; blocked reports pass unchanged', async () => {
  const h = harness(), r = request(), promise = h.api.inspect(r), c = h.children[0];
  assert.deepEqual(h.calls, [{ binary: config().expeditionPreviewBin, args: ['--rpc-url', config().expeditionPreviewRpc],
    options: { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true } }]);
  assert.deepEqual(JSON.parse(c.input), r);
  assert.ok(Buffer.byteLength(c.input) <= EXPEDITION_MAX_REQUEST_BYTES);
  assert.equal([...h.timers.values()][0].ms, 25_000);
  c.stderr.emit('data', Buffer.from('private path and RPC error never published'));
  c.report(blocked(r)); assert.deepEqual(await promise, blocked(r)); assert.equal(h.timers.size, 0);
});

test('report selection and all capability flags are independently checked', () => {
  assert.equal(expeditionReport(blocked(), request()).status, 'blocked');
  for (const change of [v => { v.scope.host = '02'.repeat(56); }, v => { v.request_digest = '00'.repeat(32); },
    v => { v.signed = true; }, v => { v.enqueued = true; }, v => { v.dispatch_available = true; }, v => { v.admitted = true; },
    v => { v.automatic_send = true; }, v => { v.completion_proven = true; }, v => { v.history_verified = true; },
    v => { v.source.authority_verified = true; }, v => { v.source.freshness = 'verified'; }, v => { v.transaction = 'private'; },
    v => { v.blocker.code = 'PrivateUnrecognizedError'; }, v => { v.blocker.url = 'http://private'; },
    v => { v.blocker.field = 'private'; }, v => { v.scope = null; v.request_digest = null; },
    v => { v.source.single_response = true; }, v => { v.facts = {}; }]) {
    const report = blocked(); change(report); assert.throws(() => expeditionReport(report, request()), codeIs('ExpeditionPreviewInvalidReport'));
  }
  const early = blocked(); early.stage = 'arguments'; early.scope = null; early.request_digest = null;
  early.source.read_calls = '0'; early.blocker = { code: 'Usage' };
  assert.equal(expeditionReport(early, request()).stage, 'arguments');
});

test('exit code, malformed JSON and child errors are sanitized', async () => {
  for (const emit of [c => c.report(blocked(), 0), c => { c.stdout.emit('data', Buffer.from('private non-json')); c.emit('close', 2, null); }]) {
    const h = harness(), pending = h.api.inspect(request()); emit(h.children[0]);
    await assert.rejects(pending, codeIs('ExpeditionPreviewInvalidReport'));
  }
  for (const emit of [c => c.emit('error', new Error('/operator/private ENOENT')),
    c => c.stdin.emit('error', new Error('http://private EPIPE')), c => c.emit('close', 1, null), c => c.emit('close', null, 'SIGTERM')]) {
    const h = harness(), pending = h.api.inspect(request()); emit(h.children[0]);
    await assert.rejects(pending, codeIs('ExpeditionPreviewUnavailable')); h.children[0].emit('close', 1, null);
  }
  const api = createExpeditionPreview({ cfg: config(), season: request().season, spawn: () => { throw new Error('/operator/private'); } });
  await assert.rejects(api.inspect(request()), codeIs('ExpeditionPreviewUnavailable'));
});

test('combined stdout and stderr bytes are capped before parsing', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const h = harness(), pending = h.api.inspect(request()), c = h.children[0];
    c.stdout.emit('data', Buffer.alloc(EXPEDITION_MAX_OUTPUT_BYTES)); c[stream].emit('data', Buffer.from('x'));
    await assert.rejects(pending, codeIs('ExpeditionPreviewOutputTooLarge'));
    assert.equal(c.killed, 'SIGKILL'); c.emit('close', null, 'SIGKILL');
  }
});

test('bounded concurrency has no queue, timeout holds capacity until child close', async () => {
  const h = harness(), pending = Array.from({ length: EXPEDITION_MAX_CONCURRENT }, () => h.api.inspect(request()));
  const rejects = pending.map(p => assert.rejects(p, codeIs('ExpeditionPreviewTimeout')));
  await assert.rejects(h.api.inspect(request()), codeIs('ExpeditionPreviewBusy')); assert.equal(h.calls.length, 2);
  h.expire(); h.expire(); await Promise.all(rejects);
  await assert.rejects(h.api.inspect(request()), codeIs('ExpeditionPreviewBusy'));
  h.children[0].emit('close', null, 'SIGKILL');
  const retry = h.api.inspect(request()); assert.equal(h.calls.length, 3);
  h.children[2].report(blocked()); await retry; h.children[1].emit('close', null, 'SIGKILL');
});

test('client abort, HTTP deadline and shutdown stop the inspection without replacing it', async () => {
  for (const reason of [undefined, 'ExpeditionPreviewTimeout']) {
    const h = harness(), controller = new AbortController(), pending = h.api.inspect(request(), { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, codeIs(reason ?? 'ExpeditionPreviewAborted'));
    assert.equal(h.children[0].killed, 'SIGKILL'); h.children[0].emit('close', null, 'SIGKILL');
    await assert.rejects(h.api.inspect(request(), { signal: controller.signal }), codeIs(reason ?? 'ExpeditionPreviewAborted'));
    assert.equal(h.calls.length, 1);
  }
  const h = harness(), pending = h.api.inspect(request()); h.api.close();
  await assert.rejects(pending, codeIs('ExpeditionPreviewAborted'));
  await assert.rejects(h.api.inspect(request()), codeIs('ExpeditionPreviewUnavailable'));
  h.children[0].emit('close', null, 'SIGKILL');
});

test('actual route is disabled without config, never asks for funds and sanitizes unrecognized errors', async () => {
  const route = expeditionPreviewRoutes[EXPEDITION_PREVIEW_ROUTE];
  let reads = 0;
  const req = { json: async () => { reads++; return request(); } };
  assert.equal((await route({}, req)).body.code, 'ExpeditionPreviewDisabled'); assert.equal(reads, 0);
  const h = harness(), p = route({ expeditionPreview: h.api, funds: { check: () => assert.fail('must not spend') } }, req);
  await Promise.resolve(); h.children[0].report(blocked()); assert.deepEqual((await p).body, blocked());
  const failure = await route({ expeditionPreview: { inspect: async () => { throw new Error('/private http://private'); } } }, req);
  assert.deepEqual(failure, { status: 503, body: { code: 'ExpeditionPreviewUnavailable', error: 'expedition inspection is unavailable' } });
});

// The imported app would load absent optional SDK packages. Evaluate only its
// exact HTTP/body functions with inert dependencies, and separately assert that
// the real source binds the actual imported route and optional context adapter.
const appSource = readFileSync(new URL('../src/frontier/app.mjs', import.meta.url), 'utf8');
function extractedHandler() {
  const from = appSource.indexOf('const unmap ='), to = appSource.indexOf('/**\n * The routes\' shared context', from);
  const find = appSource.indexOf('function findRoute('), end = appSource.indexOf('/** Both listeners', find);
  assert.ok(from >= 0 && to > from && find > to && end > find);
  class RouteError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
  const env = { Buffer, BigInt, URL, AbortController, setTimeout, clearTimeout, RouteError,
    EXPEDITION_PREVIEW_ROUTE, EXPEDITION_MAX_REQUEST_BYTES, EXPEDITION_TIMEOUT_MS,
    FRONTIER_MAX_BODY_BYTES: 64 * 1024, FRONTIER_ROUTES: expeditionPreviewRoutes,
    FRONTIER_PUBLIC_ROUTES: [EXPEDITION_PREVIEW_ROUTE], FRONTIER_FUNDED_ROUTES: [], FRONTIER_IP_LIMITS: {},
    isIP: () => true, toJson: JSON.stringify, errorResponse: e => ({ status: e.status ?? 500, body: { error: e.message, code: e.code } }),
  };
  const functions = `${appSource.slice(from, to)}\n${appSource.slice(find, end)}`.replace(/^export /gm, '');
  return runInNewContext(`${functions}\ncreateFrontierHandler`, env);
}
function streams(text, { rawLength, peer = '127.0.0.1', url = '/f/expedition/preview' } = {}) {
  const req = new EventEmitter(), res = new EventEmitter();
  Object.assign(req, { method: 'POST', url, headers: rawLength === undefined ? {} : { 'content-length': rawLength }, socket: { remoteAddress: peer } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = body => { res.body = JSON.parse(body); res.writableEnded = true; };
  return { req, res, send: () => { req.emit('data', Buffer.from(text)); req.emit('end'); } };
}

test('source binding: actual route is public, rate limited, never funded, default optional and closed on shutdown', () => {
  assert.match(appSource, /\.\.\.expeditionPreviewRoutes/);
  const publicList = appSource.slice(appSource.indexOf('export const FRONTIER_PUBLIC_ROUTES'), appSource.indexOf('export const FRONTIER_FUNDED_ROUTES'));
  assert.match(publicList, /EXPEDITION_PREVIEW_ROUTE/);
  const funded = appSource.slice(appSource.indexOf('export const FRONTIER_FUNDED_ROUTES'), appSource.indexOf('export const FRONTIER_IP_LIMITS'));
  assert.doesNotMatch(funded, /EXPEDITION_PREVIEW_ROUTE|expedition\/preview/);
  assert.match(appSource, /\[EXPEDITION_PREVIEW_ROUTE\]: \{ burst: 4, perSecond: 0\.2 \}/);
  assert.match(appSource, /createExpeditionPreview\(\{ cfg, season: addresses\.season \}\)/);
  const cfg = readFileSync(new URL('../src/frontier/config.mjs', import.meta.url), 'utf8');
  for (const name of ['BIN', 'RPC', 'PROGRAM_VERSION', 'RULESET_HASH']) assert.ok(cfg.includes(`FRONTIER_EXPEDITION_PREVIEW_${name}`));
  assert.match(cfg, /const out = expeditionPreviewConfigProblems\(cfg\)/);
  assert.match(readFileSync(new URL('../src/frontier/server.mjs', import.meta.url), 'utf8'), /apps\.ctx\.expeditionPreview\?\.close\(\)/);
});

test('extracted HTTP functions: 8 KiB cap before JSON/spawn, including declared length', async () => {
  for (const opts of [{}, { rawLength: '8193' }]) {
    const h = harness(), s = streams(' '.repeat(EXPEDITION_MAX_REQUEST_BYTES + 1), opts);
    const done = extractedHandler()({ cfg: {}, expeditionPreview: h.api, log() {} }, { surface: 'public' })(s.req, s.res);
    s.send(); await done;
    assert.equal(s.res.status, 413); assert.equal(s.res.body.code, 'BodyTooLarge'); assert.equal(h.calls.length, 0);
    assert.equal(s.res.headers['Cache-Control'], 'no-store');
  }
  const h = harness(), s = streams('{');
  const done = extractedHandler()({ cfg: {}, expeditionPreview: h.api, log() {} })(s.req, s.res);
  s.send(); await done; assert.equal(s.res.status, 400); assert.equal(h.calls.length, 0);
});

test('extracted HTTP functions: exact cap is accepted and unrelated routes retain 64 KiB', async () => {
  const raw = JSON.stringify(request()), h = harness(), s = streams(raw.padEnd(EXPEDITION_MAX_REQUEST_BYTES, ' '));
  const done = extractedHandler()({ cfg: {}, expeditionPreview: h.api, log() {} })(s.req, s.res);
  s.send(); await new Promise(setImmediate); h.children[0].report(blocked()); await done;
  assert.equal(s.res.status, 200);
  const other = streams(JSON.stringify({ value: 'a'.repeat(9000) }), { url: '/f/other' });
  const otherDone = extractedHandler()({ cfg: {}, log() {} }, { routes: { 'POST /f/other': async (_ctx, req) => ({ body: await req.json() }) } })(other.req, other.res);
  other.send(); await otherDone; assert.equal(other.res.status, 200); assert.equal(other.res.body.value.length, 9000);
});

test('extracted HTTP functions: client disconnect aborts the fake child and does not write to a dead response', async t => {
  const h = harness(), s = streams(JSON.stringify(request()));
  const done = extractedHandler()({ cfg: {}, expeditionPreview: h.api, log() {} })(s.req, s.res);
  t.after(() => { s.res.destroyed = true; s.res.emit('close'); h.api.close(); });
  s.send(); await new Promise(setImmediate);
  assert.equal(h.children.length, 1);
  s.res.destroyed = true; s.res.emit('close'); await done;
  assert.equal(h.children[0].killed, 'SIGKILL'); assert.equal(s.res.body, undefined); h.children[0].emit('close', null, 'SIGKILL');
});
