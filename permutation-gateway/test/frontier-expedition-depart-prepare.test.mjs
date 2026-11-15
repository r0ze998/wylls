// The unsigned Depart preparation adapter (src/frontier/expedition-depart-prepare.mjs) against a report the real Rust
// CLI produced from fixed public inputs (fixtures/frontier-expedition-depart-prepare-rust.json, never edited here),
// and against fake child events. No CLI, key, wallet, seal, RPC, relay or listener runs in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createExpeditionDepartPrepare, canonicalDepartProposal, expeditionDepartPrepareRequest, expeditionDepartPrepareReport,
  expeditionDepartPrepareConfigProblems, ExpeditionDepartPrepareError, DEPART_PREPARE_REQUEST_SCHEMA, DEPART_PREPARE_REPORT_SCHEMA,
  DEPART_PREPARE_MAX_REQUEST_BYTES, DEPART_PREPARE_MAX_OUTPUT_BYTES, DEPART_PREPARE_TIMEOUT_MS, DEPART_PREPARE_MAX_CONCURRENT,
  DEPART_CLOSED, DEPART_NOT_PROVEN, DEPART_INNER_HEAD, DEPART_OUTER_HEAD, DEPART_INNER_BYTES,
  EXPEDITION_DEPART_PREPARE_ROUTE } from '../src/frontier/expedition-depart-prepare.mjs';
import { expeditionDepartPrepareRoutes } from '../src/frontier/routes/expedition-depart-prepare.mjs';
import { EXPEDITION_PREPARE_ROUTE } from '../src/frontier/expedition-prepare.mjs';
import { decode } from '../client/src/base58.mjs';

const RUST_TEXT = readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-rust.json', import.meta.url), 'utf8');
const rust = () => JSON.parse(RUST_TEXT);
const clone = structuredClone;
const PINS = Object.freeze({ fee_payer: rust().prepared.fee_payer, cu_limit: 200000, loaded_limit: 1000000 });
const OTHER = 'B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3'; // a public address of the fixture that is neither wallet nor payer
const code = name => e => e instanceof ExpeditionDepartPrepareError && e.code === name && !/operator|127\.0\.0\.1|private/.test(e.message);
const invalidRequest = fn => assert.throws(fn, code('ExpeditionDepartPrepareInvalidRequest'));
const invalidReport = (report, label) => assert.throws(() => expeditionDepartPrepareReport(report, rust().request, PINS), code('ExpeditionDepartPrepareInvalidReport'), label);
const config = (r = rust().request) => ({ cluster: r.cluster, programId: r.program,
  expeditionDepartPrepareBin: '/operator/bin/frontier-experimental-expedition-depart-prepare', expeditionDepartPrepareRpc: 'http://127.0.0.1:41010',
  expeditionDepartPrepareFeePayer: r.payer, expeditionDepartPrepareRulesetHash: r.deployment.ruleset_hash,
  expeditionDepartPrepareCuLimit: 200000, expeditionDepartPrepareLoadedLimit: 1000000 });
function harness(cfg = config(), season = rust().request.season) {
  const calls = [], children = [], timers = new Map(); let tick = 0;
  const api = createExpeditionDepartPrepare({ cfg, season,
    spawn: (binary, args, options) => {
      calls.push({ binary, args, options }); const child = new EventEmitter();
      child.pid = 4000 + children.length; child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.stderr = null;
      child.stdin.end = payload => { child.input = payload; };
      child.kill = signal => { child.killed = signal; return true; };
      child.report = (report, exit = report.status === 'prepared' ? 0 : 2) => { child.stdout.emit('data', Buffer.from(JSON.stringify(report))); child.emit('close', exit, null); };
      children.push(child); return child;
    }, setTimer: (fn, ms) => { const id = ++tick; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id) });
  return { api, calls, children, timers };
}
/** The fixture's unsigned message with `mutate(bytes)` applied and its digest restated, so only the content differs. */
function withMessage(mutate) {
  const report = rust(), bytes = Buffer.from(report.prepared.message_b64, 'base64');
  mutate(bytes);
  report.prepared.message_b64 = bytes.toString('base64'); report.prepared.message_digest = createHash('sha256').update(bytes).digest('hex');
  return report;
}
const blocked = (blocker = 'TransitSlotBusy', request = rust().request) => ({ ...rust(), status: 'blocked', request, source: null, blockhash: null, prepared: null, blocker: { code: blocker } });

test('the real Rust report: request, roles, inner bytes and digest are rebuilt here from public facts and agree', () => {
  const report = rust(), request = report.request;
  assert.equal(report.schema, DEPART_PREPARE_REPORT_SCHEMA); assert.equal(request.schema, DEPART_PREPARE_REQUEST_SCHEMA);
  assert.equal(Buffer.byteLength(RUST_TEXT), 9412, 'the fixture is the file that was handed over, untouched');
  // Nothing of the caller's proposal is used: the scope alone gives the same nine roles, 369 bytes and digest.
  const { proposal, ...scope } = request;
  const canonical = canonicalDepartProposal(scope);
  assert.deepEqual(canonical.roles, proposal.roles, 'the web role builder and fclient\'s draft name the same accounts and privileges');
  assert.equal(canonical.bytes_hex, proposal.bytes_hex); assert.equal(canonical.content_digest, proposal.content_digest);
  assert.equal(canonical.bytes_hex.length, 2 * DEPART_INNER_BYTES);
  assert.equal(canonical.bytes_hex.slice(0, 8), Buffer.from(DEPART_INNER_HEAD).toString('hex'));
  assert.equal(report.prepared.instruction_hex, Buffer.from(DEPART_OUTER_HEAD).toString('hex') + canonical.bytes_hex);
  assert.deepEqual(expeditionDepartPrepareRequest(request), request);
  assert.ok(Object.isFrozen(expeditionDepartPrepareRequest(request)));
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= DEPART_PREPARE_MAX_REQUEST_BYTES);
});

test('the real Rust report passes the independent inspection whole, and stays closed', () => {
  const report = rust(), accepted = expeditionDepartPrepareReport(report, report.request, PINS);
  assert.deepEqual(accepted, report);
  assert.equal(accepted.status, 'prepared'); assert.equal(accepted.host_only, true);
  for (const flag of DEPART_CLOSED) assert.equal(accepted[flag], false, flag);
  assert.deepEqual(DEPART_CLOSED.slice().sort(), ['admitted', 'automatic_send', 'deployment_verified', 'enqueued', 'ready', 'relay_submission_available', 'seal_verified', 'signed']);
  assert.deepEqual(accepted.not_proven, [...DEPART_NOT_PROVEN]);
  assert.deepEqual(accepted.prepared.signers, [report.request.payer, report.request.wallet], 'the payer first, then the acting wallet: nobody else signs');
  assert.deepEqual(accepted.prepared.shape, { bytes: 900, locks: 10, sigs: 2, writes: 5 });
  assert.ok(Object.isFrozen(accepted) && Object.isFrozen(accepted.prepared.roles[0]));
  // the same report under other pins is not this deployment's
  for (const pins of [{ ...PINS, fee_payer: OTHER }, { ...PINS, cu_limit: 200001 }, { ...PINS, loaded_limit: 999999 }])
    assert.throws(() => expeditionDepartPrepareReport(rust(), rust().request, pins), code('ExpeditionDepartPrepareInvalidReport'));
});

test('through the adapter: one child, the fixed binary and seven pins, the canonical request on stdin, the Rust report out', async () => {
  const h = harness(), r = rust().request, pending = h.api.prepare(r);
  assert.equal(h.calls.length, 1);
  const { binary, args, options } = h.calls[0];
  assert.equal(binary, '/operator/bin/frontier-experimental-expedition-depart-prepare');
  assert.deepEqual(args, ['--rpc-url', 'http://127.0.0.1:41010', '--program', r.program, '--season', r.season, '--fee-payer', r.payer,
    '--ruleset-hash', r.deployment.ruleset_hash, '--cu-limit', '200000', '--loaded-limit', '1000000']);
  assert.deepEqual(options, { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }, 'no shell, no inherited environment, stdin and stdout only');
  assert.deepEqual(JSON.parse(h.children[0].input), r); assert.equal(h.api.active, 1);
  h.children[0].report(rust());
  assert.deepEqual(await pending, rust()); assert.equal(h.api.active, 0); assert.equal(h.children[0].killed, undefined); assert.equal(h.timers.size, 0);
  // an exit code that contradicts the report, or any other exit, is not a preparation
  for (const [report, exit, want] of [[rust(), 2, 'ExpeditionDepartPrepareInvalidReport'], [blocked(), 0, 'ExpeditionDepartPrepareInvalidReport'], [rust(), 1, 'ExpeditionDepartPrepareUnavailable'], [rust(), 9, 'ExpeditionDepartPrepareUnavailable']]) {
    const p = h.api.prepare(r), rejected = assert.rejects(p, code(want)); h.children.at(-1).report(report, exit); await rejected;
  }
  const garbage = h.api.prepare(r), rejected = assert.rejects(garbage, code('ExpeditionDepartPrepareInvalidReport'));
  h.children.at(-1).stdout.emit('data', Buffer.from('{"status":')); h.children.at(-1).emit('close', 0, null); await rejected;
});

test('a request that is not the canonical one for its own facts is refused before any process', async () => {
  const h = harness();
  const cases = {
    schema: r => { r.schema = 'frontier-experimental-expedition-prepare-request-v1'; }, extra: r => { r.sign = true; }, missing: r => { delete r.tip; },
    version: r => { r.deployment.program_version = '16388'; }, 'slot 4': r => { r.transit_slot = '4'; }, 'slot form': r => { r.transit_slot = '00'; },
    'bell form': r => { r.arrive_bell = '015'; }, 'bell number': r => { r.arrive_bell = 15; }, 'tip sign': r => { r.tip = '-1'; }, 'tip u64': r => { r.tip = '18446744073709551616'; },
    'commit zero': r => { r.public_commit = '00'.repeat(32); }, 'commit case': r => { r.public_commit = 'AB'.repeat(32); }, 'seal zero': r => { r.public_seal = '00'.repeat(264); },
    'seal short': r => { r.public_seal = r.public_seal.slice(2); }, 'seal not compressed': r => { r.public_seal = `27${r.public_seal.slice(2)}`; }, 'seal infinity': r => { r.public_seal = `e7${r.public_seal.slice(2)}`; },
    'host short': r => { r.host = r.host.slice(2); }, 'host world': r => { r.host = `01ff${r.host.slice(4)}`; }, 'standing -0': r => { r.standing.p = '-0'; }, 'standing extra': r => { r.standing.tile = 0; },
    'program is season': r => { r.season = r.program; }, 'payer zero': r => { r.payer = '11111111111111111111111111111111'; }, cluster: r => { r.cluster = 'Local'; }, id: r => { r.request_id = 'a b'; },
    'roles 8': r => { r.proposal.roles.pop(); }, 'proposal extra': r => { r.proposal.signers = []; },
    // every fact is well formed, but the proposal is not the one these facts have
    'bytes': r => { r.proposal.bytes_hex = `${r.proposal.bytes_hex.slice(0, -2)}a8`; }, digest: r => { r.proposal.content_digest = 'ab'.repeat(32); },
    'role signer': r => { r.proposal.roles[0].signer = false; }, 'role writable': r => { r.proposal.roles[2].writable = true; }, 'role address': r => { r.proposal.roles[8].address = OTHER; },
    'role name': r => { r.proposal.roles[3].name = 'owner'; }, 'role order': r => { [r.proposal.roles[3], r.proposal.roles[4]] = [r.proposal.roles[4], r.proposal.roles[3]]; }, 'role extra key': r => { r.proposal.roles[1].lamports = 1; },
    'standing moved': r => { r.standing.q = '1'; r.standing.p = '127'; }, 'standing outside the original land': r => { r.standing.p = '129'; },
    'tip changed': r => { r.tip = '2504'; }, 'bell changed': r => { r.arrive_bell = '16'; }, 'slot changed': r => { r.transit_slot = '1'; },
    'wallet changed': r => { r.wallet = OTHER; }, 'payer changed': r => { r.payer = OTHER; }, 'seal changed': r => { r.public_seal = `${r.public_seal.slice(0, -2)}a8`; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const r = rust().request; mutate(r);
    invalidRequest(() => expeditionDepartPrepareRequest(r));
    await assert.rejects(h.api.prepare(r), code('ExpeditionDepartPrepareInvalidRequest'), name);
  }
  for (const bad of [null, [], 'x', 1, {}]) invalidRequest(() => expeditionDepartPrepareRequest(bad));
  assert.equal(h.calls.length, 0, 'no child for any of them');
});

test('a canonical request for another target, payer or ruleset is a scope mismatch, before any process', async () => {
  const r = rust().request;
  for (const mutate of [c => { c.cluster = 'devnet'; }, c => { c.programId = r.season; }, c => { c.expeditionDepartPrepareFeePayer = r.wallet; }, c => { c.expeditionDepartPrepareRulesetHash = '0a'.repeat(32); }]) {
    const cfg = config(); mutate(cfg); const h = harness(cfg);
    await assert.rejects(h.api.prepare(r), code('ExpeditionDepartPrepareScopeMismatch')); assert.equal(h.calls.length, 0);
  }
  const h = harness(config(), OTHER);
  await assert.rejects(h.api.prepare(r), code('ExpeditionDepartPrepareScopeMismatch')); assert.equal(h.calls.length, 0);
});

test('a report with an open flag, a foreign echo or any restated source, blockhash or prepared field is refused', () => {
  for (const flag of DEPART_CLOSED) { const v = rust(); v[flag] = true; invalidReport(v, flag); }
  const cases = {
    'host_only': v => { v.host_only = false; }, 'extra flag': v => { v.sendable = false; }, 'missing flag': v => { delete v.seal_verified; }, schema: v => { v.schema = 'frontier-experimental-expedition-prepare-report-v1'; },
    status: v => { v.status = 'ready'; }, 'not_proven shorter': v => { v.not_proven.pop(); }, 'not_proven reworded': v => { v.not_proven[4] = 'seal verified'; }, 'not_proven absent': v => { delete v.not_proven; },
    'echo null': v => { v.request = null; }, 'echo other id': v => { v.request.request_id = 'depart-2'; }, 'echo other tip': v => { v.request.tip = '2504'; }, 'echo other min slot': v => { v.request.min_slot = '81'; },
    'blocker beside prepared': v => { v.blocker = { code: 'X' }; },
    'source null': v => { v.source = null; }, 'source before min slot': v => { v.source.context_slot = '79'; }, 'source other bell': v => { v.source.arrive_bell = '16'; },
    'arrival too soon': v => { v.source.current_bell = '14'; }, 'arrival too late': v => { v.source.current_bell = '0'; v.request.arrive_bell = '15'; v.source.arrive_bell = '73'; },
    'slot not free': v => { v.source.transit_slot_free = false; }, 'source incoherent': v => { v.source.coherent = false; }, 'source authority': v => { v.source.authority_verified = true; }, 'source extra': v => { v.source.digest = 'ab'.repeat(32); },
    'time form': v => { v.source.unix_timestamp = 1700006000; },
    'blockhash null': v => { v.blockhash = null; }, 'blockhash other': v => { v.blockhash.hash = OTHER; }, 'blockhash before source': v => { v.blockhash.latest_context_slot = '99'; },
    'validity before latest': v => { v.blockhash.validity_context_slot = '99'; v.blockhash.height_min_context_slot = '99'; }, 'height slot differs': v => { v.blockhash.height_min_context_slot = '102'; },
    'one height left': v => { v.blockhash.last_valid_block_height = '201'; v.blockhash.remaining_block_heights = '1'; }, 'heights disagree': v => { v.blockhash.remaining_block_heights = '11'; },
    'not confirmed': v => { v.blockhash.commitment = 'processed'; }, 'blockhash coherent': v => { v.blockhash.coherent = true; }, 'blockhash authority': v => { v.blockhash.authority_verified = true; }, 'blockhash invalid': v => { v.blockhash.valid = false; },
    program: v => { v.prepared.program = v.prepared.season; }, season: v => { v.prepared.season = OTHER; }, 'version': v => { v.prepared.program_version = '16388'; }, action: v => { v.prepared.action = 'Return'; },
    'fee payer': v => { v.prepared.fee_payer = v.request.wallet; }, 'cu limit': v => { v.prepared.budget.cu_limit = 1400000; }, 'cu price': v => { v.prepared.budget.cu_price = '1'; }, 'loaded limit': v => { v.prepared.budget.loaded_limit = 2000000; },
    heap: v => { v.prepared.budget.heap = 262144; }, 'role flag': v => { v.prepared.roles[2].writable = true; }, 'role address': v => { v.prepared.roles[8].address = OTHER; }, 'role dropped': v => { v.prepared.roles.pop(); },
    'instruction kind': v => { v.prepared.instruction_hex = `daff0204${v.prepared.instruction_hex.slice(8)}`; }, 'instruction tail': v => { v.prepared.instruction_hex = `${v.prepared.instruction_hex.slice(0, -2)}a8`; },
    'message digest': v => { v.prepared.message_digest = 'ab'.repeat(32); }, 'message padding': v => { v.prepared.message_b64 += '\n'; }, 'message not base64': v => { v.prepared.message_b64 = '!!!!'; },
    'signers reordered': v => { v.prepared.signers.reverse(); }, 'signer added': v => { v.prepared.signers.push(OTHER); }, 'signer dropped': v => { v.prepared.signers.pop(); },
    'shape bytes': v => { v.prepared.shape.bytes = 899; }, 'shape writes': v => { v.prepared.shape.writes = 4; }, 'shape extra': v => { v.prepared.shape.cu = 1; },
    'proposal digest': v => { v.prepared.proposal_digest = 'ab'.repeat(32); }, 'prepared extra': v => { v.prepared.signatures = []; }, 'prepared null': v => { v.prepared = null; },
  };
  for (const [name, mutate] of Object.entries(cases)) { const v = rust(); mutate(v); invalidReport(v, name); }
  for (const v of [null, [], 'prepared', {}]) invalidReport(v, JSON.stringify(v));
});

test('the unsigned message itself is parsed: a message that says anything else is refused though its digest is restated', () => {
  assert.deepEqual(expeditionDepartPrepareReport(withMessage(() => {}), rust().request, PINS), rust(), 'the helper alone changes nothing');
  const find = (bytes, needle) => { const at = bytes.indexOf(Buffer.from(needle)); assert.ok(at >= 0 && bytes.indexOf(Buffer.from(needle), at + 1) < 0, 'one such place'); return at; };
  const cases = {
    'one signature required': b => { b[0] = 1; }, 'three signatures required': b => { b[0] = 3; }, 'the wallet made writable': b => { b[1] = 0; },
    'one more read-only account': b => { b[2] += 1; }, 'one fewer read-only account': b => { b[2] -= 1; },
    'another fee payer': b => { b[4] ^= 1; }, 'another blockhash': b => { b[find(b, decode(rust().blockhash.hash)) + 31] ^= 1; },
    'the compute limit': b => { b[find(b, [0x02, 0x40, 0x0d, 0x03, 0x00]) + 1] ^= 1; }, 'a compute price': b => { b[find(b, [0x03, 0, 0, 0, 0, 0, 0, 0, 0]) + 1] = 1; },
    'the loaded-data limit': b => { b[find(b, [0x04, 0x40, 0x42, 0x0f, 0x00]) + 1] ^= 1; },
    'the dispatch kind': b => { b[find(b, [0xda, 0xff, 0x02, 0x00, 0xda, 0xff, 0x01, 0x06]) + 3] = 4; }, 'the inner op': b => { b[find(b, [0xda, 0xff, 0x02, 0x00, 0xda, 0xff, 0x01, 0x06]) + 7] = 2; },
    'the tip': b => { b[find(b, [0x0f, 0, 0, 0, 0xc7, 0x09]) + 4] ^= 1; }, 'the arrival turn': b => { b[find(b, [0x0f, 0, 0, 0, 0xc7, 0x09])] ^= 1; },
    'the commit': b => { b[find(b, [0xc7, 0x09, 0, 0, 0, 0, 0, 0, 0x01]) + 8] ^= 2; }, 'the last seal byte': b => { b[b.length - 1] ^= 1; },
    'a role moved': b => { const at = find(b, [0x09, 0x01, 0x00, 0x09, 0x03]); [b[at + 1], b[at + 2]] = [b[at + 2], b[at + 1]]; },
    'truncated': b => { b.fill(0, b.length - 4); },
  };
  for (const [name, mutate] of Object.entries(cases)) invalidReport(withMessage(mutate), name);
  // bytes after the message end, and a message cut short
  const base = Buffer.from(rust().prepared.message_b64, 'base64');
  for (const bytes of [Buffer.concat([base, Buffer.from([0])]), base.subarray(0, base.length - 1)]) {
    const v = rust(); v.prepared.message_b64 = bytes.toString('base64'); v.prepared.message_digest = createHash('sha256').update(bytes).digest('hex'); invalidReport(v, `length ${bytes.length}`);
  }
});

test('a refusal stays a closed report: with or without the echo, never with a source, a blockhash or a message', async () => {
  for (const b of ['TransitSlotBusy', 'SourceUnavailable', 'HostCannotDepart', 'ArrivalBell', 'SnapshotMismatch', 'ScopeMismatch']) assert.deepEqual(expeditionDepartPrepareReport(blocked(b), rust().request, PINS), blocked(b));
  assert.deepEqual(expeditionDepartPrepareReport(blocked('OutputTooLarge', null), rust().request, PINS), blocked('OutputTooLarge', null), 'a refusal before the request was read echoes none');
  const cases = { 'flag open': v => { v.seal_verified = true; }, 'source kept': v => { v.source = rust().source; }, 'blockhash kept': v => { v.blockhash = rust().blockhash; }, 'message kept': v => { v.prepared = rust().prepared; },
    'no blocker': v => { v.blocker = null; }, 'blocker words': v => { v.blocker = { code: 'slot is busy' }; }, 'blocker detail': v => { v.blocker = { code: 'TransitSlotBusy', rpc: 'http://127.0.0.1:41010' }; },
    'echo of another request': v => { v.request.tip = '2504'; }, 'not_proven dropped': v => { v.not_proven = []; } };
  for (const [name, mutate] of Object.entries(cases)) { const v = blocked(); mutate(v); invalidReport(v, name); }
  const h = harness(), p = h.api.prepare(rust().request); h.children[0].report(blocked());
  const got = await p; assert.equal(got.status, 'blocked'); assert.equal(got.prepared, null); for (const flag of DEPART_CLOSED) assert.equal(got[flag], false);
});

test('cancel, too much output, a timeout and close each kill the child; a slot is held until the child has closed', async () => {
  assert.equal(DEPART_PREPARE_MAX_CONCURRENT, 2); assert.equal(DEPART_PREPARE_TIMEOUT_MS, 30_000); assert.equal(DEPART_PREPARE_MAX_OUTPUT_BYTES, 64 * 1024); assert.equal(DEPART_PREPARE_MAX_REQUEST_BYTES, 16 * 1024);
  const r = rust().request, h = harness(), controller = new AbortController();
  const a = assert.rejects(h.api.prepare(r, { signal: controller.signal }), code('ExpeditionDepartPrepareAborted'));
  const b = assert.rejects(h.api.prepare(r), code('ExpeditionDepartPrepareOutputTooLarge'));
  controller.abort(); h.children[1].stdout.emit('data', Buffer.alloc(DEPART_PREPARE_MAX_OUTPUT_BYTES + 1));
  await Promise.all([a, b]); assert.ok(h.children.every(c => c.killed === 'SIGKILL'));
  await assert.rejects(h.api.prepare(r), code('ExpeditionDepartPrepareBusy')); assert.equal(h.calls.length, 2, 'the killed children still hold both slots');
  assert.equal(h.api.active, 2);
  h.children.forEach(c => c.emit('close', null, 'SIGKILL')); assert.equal(h.api.active, 0);
  // the adapter's own clock
  const c = assert.rejects(h.api.prepare(r), code('ExpeditionDepartPrepareTimeout'));
  const timer = [...h.timers.values()][0]; assert.equal(timer.ms, DEPART_PREPARE_TIMEOUT_MS); timer.fn(); await c;
  assert.equal(h.children[2].killed, 'SIGKILL'); h.children[2].emit('close', null, 'SIGKILL');
  // the listener's clock (app.mjs aborts the request's signal with this reason) and a signal already aborted
  const late = new AbortController(), d = assert.rejects(h.api.prepare(r, { signal: late.signal }), code('ExpeditionDepartPrepareTimeout'));
  late.abort('ExpeditionDepartPrepareTimeout'); await d; assert.equal(h.children[3].killed, 'SIGKILL'); h.children[3].emit('close', null, 'SIGKILL');
  const gone = new AbortController(); gone.abort();
  await assert.rejects(h.api.prepare(r, { signal: gone.signal }), code('ExpeditionDepartPrepareAborted')); assert.equal(h.calls.length, 4, 'no child for a request already cancelled');
  // a report that arrives after the kill is not delivered
  const e = h.api.prepare(r), f = assert.rejects(e, code('ExpeditionDepartPrepareAborted'));
  h.api.close(); await f; assert.equal(h.children[4].killed, 'SIGKILL'); h.children[4].report(rust()); assert.equal(h.api.active, 0);
  await assert.rejects(h.api.prepare(r), code('ExpeditionDepartPrepareUnavailable')); assert.equal(h.calls.length, 5, 'closed: nothing new starts');
});

test('a binary that cannot start, a broken pipe and a throwing spawn give the slot back and say nothing of the host', async () => {
  const r = rust().request, h = harness();
  const a = assert.rejects(h.api.prepare(r), code('ExpeditionDepartPrepareUnavailable'));
  h.children[0].pid = undefined; h.children[0].emit('error', Object.assign(new Error('spawn /operator/bin/private ENOENT'), { code: 'ENOENT' })); await a;
  assert.equal(h.api.active, 0, 'a child that never started holds no slot');
  const b = assert.rejects(h.api.prepare(r), code('ExpeditionDepartPrepareUnavailable'));
  h.children[1].stdin.emit('error', new Error('EPIPE private')); await b; assert.equal(h.children[1].killed, 'SIGKILL'); h.children[1].emit('close', null, 'SIGKILL');
  const thrower = createExpeditionDepartPrepare({ cfg: config(), season: r.season, spawn() { throw new Error('private operator path'); } });
  await assert.rejects(thrower.prepare(r), code('ExpeditionDepartPrepareUnavailable')); assert.equal(thrower.active, 0);
});

test('off by default; a partial or unsafe configuration is a problem and never an adapter', () => {
  assert.equal(createExpeditionDepartPrepare({ cfg: {}, season: 'unused', spawn() { assert.fail(); } }), null);
  assert.deepEqual(expeditionDepartPrepareConfigProblems({}), []);
  // the resident adapter's settings do not turn this one on
  const resident = { expeditionPrepareBin: '/operator/bin/frontier-experimental-expedition-prepare', expeditionPrepareRpc: 'http://127.0.0.1:41010', expeditionPrepareFeePayer: OTHER,
    expeditionPrepareRulesetHash: '09'.repeat(32), expeditionPrepareCuLimit: 200000, expeditionPrepareLoadedLimit: 65536, cluster: 'localnet', programId: rust().request.program };
  assert.deepEqual(expeditionDepartPrepareConfigProblems(resident), []); assert.equal(createExpeditionDepartPrepare({ cfg: resident, season: rust().request.season }), null);
  assert.ok(expeditionDepartPrepareConfigProblems({ expeditionDepartPrepareCuLimit: 200000 }).length);
  assert.deepEqual(expeditionDepartPrepareConfigProblems(config()), []);
  for (const mutate of [c => { c.expeditionDepartPrepareBin = 'frontier-experimental-expedition-depart-prepare'; }, c => { c.expeditionDepartPrepareBin = './bin/x'; }, c => { c.expeditionDepartPrepareBin = '/bin/x\0y'; },
    c => { c.expeditionDepartPrepareRpc = 'http://example.com'; }, c => { c.expeditionDepartPrepareRpc = 'https://127.0.0.1:8899'; }, c => { c.expeditionDepartPrepareRpc = 'http://localhost:8899'; },
    c => { c.expeditionDepartPrepareRpc = 'http://user:password@127.0.0.1:8899'; }, c => { c.expeditionDepartPrepareRpc += '?secret=value'; }, c => { c.expeditionDepartPrepareRpc = null; },
    c => { c.expeditionDepartPrepareFeePayer = 'not-an-address'; }, c => { c.expeditionDepartPrepareRulesetHash = 'AB'.repeat(32); },
    c => { c.expeditionDepartPrepareCuLimit = 1400001; }, c => { c.expeditionDepartPrepareCuLimit = 0; }, c => { c.expeditionDepartPrepareLoadedLimit = 67108865; }, c => { c.expeditionDepartPrepareLoadedLimit = '1e6'; },
    c => { c.programId = 'x'; }, c => { c.cluster = 'Local Net'; }]) {
    const bad = config(); mutate(bad);
    assert.ok(expeditionDepartPrepareConfigProblems(bad).length);
    assert.throws(() => createExpeditionDepartPrepare({ cfg: bad, season: rust().request.season, spawn() { assert.fail(); } }), code('ExpeditionDepartPrepareDisabled'));
  }
  assert.throws(() => createExpeditionDepartPrepare({ cfg: config(), season: 'not-an-address' }), code('ExpeditionDepartPrepareDisabled'));
  // limits given as text (argv, environment) are the same pins
  const text = config(); text.expeditionDepartPrepareCuLimit = '200000'; text.expeditionDepartPrepareLoadedLimit = '1000000';
  assert.deepEqual(expeditionDepartPrepareConfigProblems(text), []);
});

test('the route: disabled without its adapter, the report through, every failure a code with no host detail', async () => {
  assert.equal(EXPEDITION_DEPART_PREPARE_ROUTE, 'POST /f/expedition/depart/prepare'); assert.notEqual(EXPEDITION_DEPART_PREPARE_ROUTE, EXPEDITION_PREPARE_ROUTE);
  assert.deepEqual(Object.keys(expeditionDepartPrepareRoutes), [EXPEDITION_DEPART_PREPARE_ROUTE]);
  const route = expeditionDepartPrepareRoutes[EXPEDITION_DEPART_PREPARE_ROUTE], r = rust().request;
  const off = await route({}, { json() { assert.fail('the body is not read while the adapter is off'); } });
  assert.deepEqual(off, { status: 503, body: { error: 'unsigned departure preparation is not configured', code: 'ExpeditionDepartPrepareDisabled' } });
  // the resident adapter on the context does not serve this route
  assert.equal((await route({ expeditionPrepare: { prepare() { assert.fail(); } } }, { json() { assert.fail(); } })).status, 503);
  const h = harness(), ok = route({ expeditionDepartPrepare: h.api }, { json: async () => r, signal: undefined }); await Promise.resolve(); await Promise.resolve();
  h.children[0].report(rust()); assert.deepEqual(await ok, { body: rust() });
  const failing = route({ expeditionDepartPrepare: h.api }, { json: async () => r }); await Promise.resolve(); await Promise.resolve();
  h.children[1].stdout.emit('data', 'private operator credential http://127.0.0.1:41010'); h.children[1].emit('close', 9, null);
  const failure = await failing; assert.equal(failure.status, 503); assert.equal(failure.body.code, 'ExpeditionDepartPrepareUnavailable'); assert.doesNotMatch(JSON.stringify(failure), /private|credential|127\.0\.0\.1|operator/);
  const body = e => route({ expeditionDepartPrepare: h.api }, { json: async () => { throw Object.assign(new Error('x'), { code: e }); } });
  assert.deepEqual([(await body('BodyTooLarge')).status, (await body('InvalidJson')).status], [413, 400]);
  assert.deepEqual([(await body('RequestAborted')).body.code, (await body('RequestTimeout')).body.code], ['ExpeditionDepartPrepareAborted', 'ExpeditionDepartPrepareTimeout']);
  assert.deepEqual([(await body('RequestAborted')).status, (await body('RequestTimeout')).status], [499, 504]);
  const bad = await route({ expeditionDepartPrepare: h.api }, { json: async () => ({ ...r, tip: '2504' }) }); assert.equal(bad.status, 400); assert.equal(bad.body.code, 'ExpeditionDepartPrepareInvalidRequest');
  const scope = await route({ expeditionDepartPrepare: harness(config(), OTHER).api }, { json: async () => r }); assert.equal(scope.status, 409);
  const odd = await route({ expeditionDepartPrepare: { prepare() { throw new TypeError('private operator stack'); } } }, { json: async () => r });
  assert.equal(odd.status, 503); assert.doesNotMatch(JSON.stringify(odd), /private|stack/);
  assert.equal(h.calls.length, 2);
});

test('wiring: the relay serves the route with its own limits, reads its own settings and closes it; the resident route is as it was', () => {
  const read = file => readFileSync(new URL(`../src/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), cfg = read('config.mjs'), server = read('server.mjs'), adapter = read('expedition-depart-prepare.mjs');
  assert.match(app, /FRONTIER_ROUTES = Object\.freeze\(\{[^}]*\.\.\.expeditionPrepareRoutes, \.\.\.expeditionDepartPrepareRoutes \}\)/);
  const pub = app.slice(app.indexOf('export const FRONTIER_PUBLIC_ROUTES'), app.indexOf('export const FRONTIER_FUNDED_ROUTES'));
  for (const name of ['EXPEDITION_PREVIEW_ROUTE', 'EXPEDITION_PREPARE_ROUTE', 'EXPEDITION_DEPART_PREPARE_ROUTE']) assert.match(pub, new RegExp(`\\n  ${name},`));
  const funded = app.slice(app.indexOf('export const FRONTIER_FUNDED_ROUTES'), app.indexOf('export const FRONTIER_IP_LIMITS'));
  assert.doesNotMatch(funded, /expedition/i, 'the relay pool never pays for a preparation');
  assert.match(app, /\[EXPEDITION_DEPART_PREPARE_ROUTE\]: \{ burst: 4, perSecond: 0\.2 \}/); assert.match(app, /\[EXPEDITION_PREPARE_ROUTE\]: \{ burst: 4, perSecond: 0\.2 \}/);
  assert.match(app, /expeditionDepartPrepare: expeditionDepartPrepare === undefined \? createExpeditionDepartPrepare\(\{ cfg, season: addresses\.season \}\) : expeditionDepartPrepare,/);
  assert.match(app, /expeditionPrepare: expeditionPrepare === undefined \? createExpeditionPrepare\(\{ cfg, season: addresses\.season \}\) : expeditionPrepare,/);
  assert.match(app, /const bounded = preview \|\| prepare \|\| departPrepare;/);
  assert.match(app, /controller\.abort\(departPrepare \? 'ExpeditionDepartPrepareTimeout' : prepare \? 'ExpeditionPrepareTimeout' : 'ExpeditionPreviewTimeout'\), departPrepare \? DEPART_PREPARE_TIMEOUT_MS : prepare \? PREPARE_TIMEOUT_MS : EXPEDITION_TIMEOUT_MS\)/);
  assert.match(app, /readJson\(req, departPrepare \? DEPART_PREPARE_MAX_REQUEST_BYTES : prepare \? PREPARE_MAX_REQUEST_BYTES : preview \? EXPEDITION_MAX_REQUEST_BYTES : FRONTIER_MAX_BODY_BYTES, controller\?\.signal\)/);
  assert.match(app, /\['ExpeditionPreviewTimeout', 'ExpeditionPrepareTimeout', 'ExpeditionDepartPrepareTimeout'\]\.includes\(signal\?\.reason\)/);
  for (const key of ['Bin', 'Rpc', 'FeePayer', 'RulesetHash', 'CuLimit', 'LoadedLimit']) {
    assert.match(cfg, new RegExp(`\\n  expeditionDepartPrepare${key}: null,`), `${key} is off by default`);
    assert.match(cfg, new RegExp(`\\n    expeditionDepartPrepare${key}: pick\\('expedition-depart-prepare-[a-z-]+', 'FRONTIER_EXPEDITION_DEPART_PREPARE_[A-Z_]+', d\\.expeditionDepartPrepare${key}\\),`));
    assert.match(cfg, new RegExp(`\\n    expeditionPrepare${key}: pick\\('expedition-prepare-[a-z-]+', 'FRONTIER_EXPEDITION_PREPARE_[A-Z_]+', d\\.expeditionPrepare${key}\\),`), `the resident ${key} is read as before`);
  }
  assert.match(cfg, /\[\.\.\.expeditionPreviewConfigProblems\(cfg\), \.\.\.expeditionPrepareConfigProblems\(cfg\), \.\.\.expeditionDepartPrepareConfigProblems\(cfg\)\]/);
  assert.match(server, /apps\.ctx\.expeditionPreview\?\.close\(\); apps\.ctx\.expeditionPrepare\?\.close\(\); apps\.ctx\.expeditionDepartPrepare\?\.close\(\);/);
  // the adapter's own source: one child process API, nothing that signs, seals, connects a wallet or sends
  const code = adapter.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort(), ['../../../permutation-server/web/frontier/faddr.mjs', '../../../permutation-server/web/frontier/fexpedition-depart.mjs',
    '../../client/src/base58.mjs', '../../client/src/solana-tx.mjs', './expedition-preview.mjs', 'node:child_process', 'node:crypto', 'node:path']);
  assert.doesNotMatch(code, /\bfetch\s*\(|Keypair|secretKey|privateKey|\.sign\(|signTransaction|sendTransaction|sendRawTransaction|simulateTransaction|process\.env|exec\(|execFile|fork\(/);
  assert.match(code, /stdio: \['pipe', 'pipe', 'ignore'\]/); assert.match(code, /shell: false, cwd: '\/', env: \{\}/);
});
