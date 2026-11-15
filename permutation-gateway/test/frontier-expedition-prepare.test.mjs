// Selected public-only contract tests. Fake child events; no CLI, keys or RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syntheticPreparation } from '../screens/codex/prepare-observation.mjs';
import { createExpeditionPrepare, canonicalResidentProposal, expeditionPrepareRequest,
  expeditionPrepareReport, expeditionPrepareConfigProblems, PREPARE_REQUEST_SCHEMA,
  PREPARE_MAX_OUTPUT_BYTES, PREPARE_TIMEOUT_MS, EXPEDITION_PREPARE_ROUTE } from '../src/frontier/expedition-prepare.mjs';
import { expeditionPrepareRoutes } from '../src/frontier/routes/expedition-prepare.mjs';

const clone = structuredClone;
const code = name => e => e.code === name && !/operator|127\.0\.0\.1|private/.test(e.message);
function request(action = 'Dissolve') {
  const source = JSON.parse(readFileSync(new URL(`../../frontier-node/crates/keeper/tests/fixtures/original_expedition_preview_${action.toLowerCase()}_request.json`, import.meta.url)));
  source.deployment.program_version = '18436';
  return { schema: PREPARE_REQUEST_SCHEMA, request_id: '1700_1', action, source_request: source,
    source_context_slot: '80', source_snapshot_digest: 'ab'.repeat(32), proposal: canonicalResidentProposal(source, action) };
}
const config = r => ({ cluster: r.source_request.cluster, programId: r.source_request.program,
  expeditionPrepareBin: '/operator/bin/frontier-experimental-expedition-prepare', expeditionPrepareRpc: 'http://127.0.0.1:41010',
  expeditionPrepareFeePayer: r.source_request.payer, expeditionPrepareRulesetHash: r.source_request.deployment.ruleset_hash,
  expeditionPrepareCuLimit: 200000, expeditionPrepareLoadedLimit: 65536 });
const pins = r => ({ fee_payer: r.source_request.payer, cu_limit: 200000, loaded_limit: 65536 });
function harness(r = request()) {
  const calls = [], children = [], timers = new Map(); let tick = 0;
  const api = createExpeditionPrepare({ cfg: config(r), season: r.source_request.season,
    spawn: (binary, args, options) => {
      calls.push({ binary, args, options }); const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = payload => { child.input = payload; };
      child.kill = signal => { child.killed = signal; return true; };
      child.report = (report, exit = report.status === 'prepared' ? 0 : 2) => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(report))); child.emit('close', exit, null);
      };
      children.push(child); return child;
    }, setTimer: (fn, ms) => { const id = ++tick; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id) });
  return { api, calls, children, timers };
}

test('default off and partial configuration never starts a process', () => {
  assert.equal(createExpeditionPrepare({ cfg: {}, season: 'unused', spawn() { assert.fail(); } }), null);
  assert.deepEqual(expeditionPrepareConfigProblems({}), []);
  assert.ok(expeditionPrepareConfigProblems({ expeditionPrepareCuLimit: 200000 }).length);
  const r = request(), cfg = config(r);
  for (const mutate of [c => { c.expeditionPrepareBin = 'relative'; }, c => { c.expeditionPrepareRpc = 'http://example.com'; },
    c => { c.expeditionPrepareRpc = 'http://user:password@127.0.0.1'; }, c => { c.expeditionPrepareRpc += '?secret=value'; },
    c => { c.expeditionPrepareCuLimit = 1400001; }, c => { c.expeditionPrepareLoadedLimit = 67108865; }]) {
    const bad = clone(cfg); mutate(bad); assert.ok(expeditionPrepareConfigProblems(bad).length);
  }
});

for (const action of ['Dissolve', 'Return']) test(`${action}: canonical request, strict child report and closed route`, async () => {
  const r = request(action), expected = syntheticPreparation(r), h = harness(r);
  assert.deepEqual(expeditionPrepareRequest(r), r);
  // Rust JSON map key ordering differs from browser objects and is immaterial.
  const sorted = JSON.parse(JSON.stringify(expected, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
  assert.deepEqual(expeditionPrepareReport(sorted, r, pins(r)), expected);
  const pending = expeditionPrepareRoutes[EXPEDITION_PREPARE_ROUTE]({ expeditionPrepare: h.api }, { json: async () => r });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(h.children[0].input), r);
  assert.deepEqual(h.calls[0].args, ['--rpc-url', config(r).expeditionPrepareRpc, '--program', r.source_request.program,
    '--season', r.source_request.season, '--fee-payer', r.source_request.payer, '--ruleset-hash', r.source_request.deployment.ruleset_hash,
    '--cu-limit', '200000', '--loaded-limit', '65536']);
  assert.deepEqual(h.calls[0].options.env, {}); assert.equal(h.calls[0].options.shell, false);
  h.children[0].report(sorted); assert.deepEqual((await pending).body, expected); assert.equal(h.timers.size, 0);
});

test('request canonical roles/bytes/digest/version and target pins reject before spawn', async () => {
  const r = request(), h = harness(r);
  for (const mutate of [x => { x.request_id = ''; }, x => { x.action = 'Depart'; }, x => { x.source_request.deployment.program_version = '16388'; },
    x => { x.source_context_slot = '79'; }, x => { x.extra = true; }, x => { x.proposal.roles.reverse(); },
    x => { x.proposal.roles[0].writable = false; }, x => { x.proposal.content_digest = 'ab'.repeat(32); },
    x => { x.proposal.bytes_hex = '00'.repeat(60); }]) {
    const bad = clone(r); mutate(bad); await assert.rejects(h.api.prepare(bad), code('ExpeditionPrepareInvalidRequest'));
  }
  const mismatch = clone(r); mismatch.source_request.cluster = 'devnet';
  await assert.rejects(h.api.prepare(mismatch), code('ExpeditionPrepareScopeMismatch')); assert.equal(h.calls.length, 0);
});

test('report cannot substitute request/source/blockhash/budget/flags or message semantics', () => {
  const r = request(), valid = syntheticPreparation(r);
  for (const mutate of [v => { v.request.request_id = 'old'; }, v => { v.ready = true; }, v => { v.host_only = false; },
    v => { v.prepared.budget.cu_price = '1'; }, v => { v.prepared.budget.loaded_limit++; }, v => { v.prepared.roles.reverse(); },
    v => { v.source.context_slot = '79'; }, v => { v.source.request_digest = 'cd'.repeat(32); }, v => { v.blockhash.valid = false; },
    v => { v.blockhash.coherent = true; }, v => { v.blockhash.remaining_block_heights = '1'; },
    v => { v.blockhash.height_min_context_slot = '999'; }, v => { v.prepared.shape.bytes--; }, v => { v.prepared.signers = []; },
    v => { v.prepared.message_b64 += '='; }, v => { v.prepared.fee_payer = v.prepared.program; },
    v => { const b = Buffer.from(v.prepared.message_b64, 'base64'); b[b.length - 1] ^= 1;
      v.prepared.message_b64 = b.toString('base64'); v.prepared.message_digest = createHash('sha256').update(b).digest('hex'); },
    v => { const b = Buffer.from(v.prepared.message_b64, 'base64'); b[2]--;
      v.prepared.message_b64 = b.toString('base64'); v.prepared.message_digest = createHash('sha256').update(b).digest('hex'); }]) {
    const bad = clone(valid); mutate(bad); assert.throws(() => expeditionPrepareReport(bad, r, pins(r)), code('ExpeditionPrepareInvalidReport'));
  }
});

test('cancellation/overflow/timeout kill child and retain concurrency until close', async () => {
  const r = request(), h = harness(r), controller = new AbortController();
  const a = h.api.prepare(r, { signal: controller.signal }), aRejected = assert.rejects(a, code('ExpeditionPrepareAborted'));
  const b = h.api.prepare(r), bRejected = assert.rejects(b, code('ExpeditionPrepareOutputTooLarge'));
  controller.abort(); h.children[1].stderr.emit('data', Buffer.alloc(PREPARE_MAX_OUTPUT_BYTES + 1));
  await Promise.all([aRejected, bRejected]); assert.ok(h.children.every(c => c.killed === 'SIGKILL'));
  await assert.rejects(h.api.prepare(r), code('ExpeditionPrepareBusy')); assert.equal(h.calls.length, 2);
  h.children.forEach(c => c.emit('close', null, 'SIGKILL'));
  const c = h.api.prepare(r), cRejected = assert.rejects(c, code('ExpeditionPrepareTimeout'));
  const timer = [...h.timers.values()][0]; assert.equal(timer.ms, PREPARE_TIMEOUT_MS); timer.fn(); await cRejected;
  assert.equal(h.children[2].killed, 'SIGKILL'); h.children[2].emit('close', null, 'SIGKILL'); h.api.close();
  await assert.rejects(h.api.prepare(r), code('ExpeditionPrepareUnavailable'));
});

test('disabled route and failed child redact details, blocked report remains closed', async () => {
  const route = expeditionPrepareRoutes[EXPEDITION_PREPARE_ROUTE], r = request();
  assert.equal((await route({}, { json() { assert.fail(); } })).status, 503);
  const h = harness(r), pending = route({ expeditionPrepare: h.api }, { json: async () => r }); await Promise.resolve();
  h.children[0].stderr.emit('data', 'private operator credential http://127.0.0.1'); h.children[0].emit('close', 9, null);
  const failure = await pending; assert.equal(failure.status, 503); assert.doesNotMatch(JSON.stringify(failure), /private|credential|127\.0\.0\.1/);
  const report = syntheticPreparation(r); Object.assign(report, { status: 'blocked', source: null, blockhash: null, prepared: null, blocker: { code: 'SourceBlocked' } });
  const p = h.api.prepare(r); h.children[1].report(report); assert.deepEqual(await p, report);
});
