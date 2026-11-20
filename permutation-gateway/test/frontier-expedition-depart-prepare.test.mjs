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
  DEPART_CLOSED, DEPART_NOT_PROVEN, DEPART_INNER_HEAD, DEPART_OUTER_HEAD, DEPART_INNER_BYTES, DEPART_HEAP_FRAME,
  EXPEDITION_DEPART_PREPARE_ROUTE } from '../src/frontier/expedition-depart-prepare.mjs';
import { expeditionDepartPrepareRoutes } from '../src/frontier/routes/expedition-depart-prepare.mjs';
import { EXPEDITION_PREPARE_ROUTE, PREPARE_MAX_REQUEST_BYTES } from '../src/frontier/expedition-prepare.mjs';
// The relay's real handler imports the gateway's npm packages. A checkout without them installed cannot load it:
// the handler tests are then SKIPPED with that reason (never passed), and any other load failure fails this file.
const APP = await import('../src/frontier/app.mjs').catch(e => {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && /^Cannot find package '/.test(e.message)) return { missing: e.message.split(' imported from ')[0] };
  throw e;
});
const { createFrontierHandler, FRONTIER_ROUTES, FRONTIER_PUBLIC_ROUTES, FRONTIER_IP_LIMITS, FRONTIER_MAX_BODY_BYTES } = APP;
const HANDLER = { skip: APP.missing ? `the relay's handler cannot be loaded here: ${APP.missing}` : false };
import { decode } from '../client/src/base58.mjs';
import { compileMessage, parseMessage } from '../../permutation-server/web/sdk/solana-tx.mjs';
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

// The real Rust report of the canonical shape: three budget instructions, the one fixed 256 KiB heap frame, the dispatch.
const RUST_TEXT = readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-heap256k-rust.json', import.meta.url), 'utf8');
// HISTORICAL, never edited: the real Rust report of the FORMER shape (no heap frame, `heap: null`). The real SBF program
// does not complete that message (it runs out of the default 32 KiB heap); it is kept as the record of the old contract.
const FORMER_TEXT = readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-rust.json', import.meta.url), 'utf8');
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
  assert.equal(Buffer.byteLength(RUST_TEXT), 7767); assert.equal(createHash('sha256').update(RUST_TEXT).digest('hex'), 'eb6bfe3a34bb0aecc47cade1eeb5da3fd429b849fd181136c1aaab7fc70152e4', 'the real preparer\'s output, as generated');
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
  assert.deepEqual(accepted.prepared.shape, { bytes: 908, locks: 10, sigs: 2, writes: 5 });
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
    heap: v => { v.prepared.budget.heap = null; }, 'heap size': v => { v.prepared.budget.heap = 131072; }, 'role flag': v => { v.prepared.roles[2].writable = true; }, 'role address': v => { v.prepared.roles[8].address = OTHER; }, 'role dropped': v => { v.prepared.roles.pop(); },
    'instruction kind': v => { v.prepared.instruction_hex = `daff0204${v.prepared.instruction_hex.slice(8)}`; }, 'instruction tail': v => { v.prepared.instruction_hex = `${v.prepared.instruction_hex.slice(0, -2)}a8`; },
    'message digest': v => { v.prepared.message_digest = 'ab'.repeat(32); }, 'message padding': v => { v.prepared.message_b64 += '\n'; }, 'message not base64': v => { v.prepared.message_b64 = '!!!!'; },
    'signers reordered': v => { v.prepared.signers.reverse(); }, 'signer added': v => { v.prepared.signers.push(OTHER); }, 'signer dropped': v => { v.prepared.signers.pop(); },
    'shape bytes': v => { v.prepared.shape.bytes = 907; }, 'shape writes': v => { v.prepared.shape.writes = 4; }, 'shape extra': v => { v.prepared.shape.cu = 1; },
    'proposal digest': v => { v.prepared.proposal_digest = 'ab'.repeat(32); }, 'prepared extra': v => { v.prepared.signatures = []; }, 'prepared null': v => { v.prepared = null; },
  };
  for (const [name, mutate] of Object.entries(cases)) { const v = rust(); mutate(v); invalidReport(v, name); }
  for (const v of [null, [], 'prepared', {}]) invalidReport(v, JSON.stringify(v));
});

test('the former shape (no heap frame) is refused; the heap frame is exactly 256 KiB, once, fourth', () => {
  const former = JSON.parse(FORMER_TEXT), now = rust();
  assert.equal(Buffer.byteLength(FORMER_TEXT), 9412, 'the former fixture is untouched');
  assert.equal(former.prepared.budget.heap, null); assert.equal(now.prepared.budget.heap, 262144); assert.equal(DEPART_HEAP_FRAME, 262144);
  // the same request and the same dispatch instruction; only the message around it differs
  assert.deepEqual(former.request, now.request); assert.equal(former.prepared.instruction_hex, now.prepared.instruction_hex);
  assert.deepEqual(expeditionDepartPrepareRequest(former.request), former.request, 'the former REQUEST is still a canonical request');
  assert.throws(() => expeditionDepartPrepareReport(JSON.parse(FORMER_TEXT), former.request, PINS), code('ExpeditionDepartPrepareInvalidReport'), 'the former report is not a preparation any more');
  // the former message under a restated budget, and the present message under the former budget, are both refused
  { const v = JSON.parse(FORMER_TEXT); v.prepared.budget.heap = 262144; invalidReport(v, 'former message, new budget'); }
  { const v = rust(); v.prepared.budget.heap = null; invalidReport(v, 'new message, former budget'); }
  for (const heap of [0, 32768, 131072, 262143, 262145, 524288, '262144', true]) { const v = rust(); v.prepared.budget.heap = heap; invalidReport(v, `heap ${heap}`); }
  // messages compiled here from the fixture's own instructions (the web SDK compiler), digest and shape restated
  const base = parseMessage(Buffer.from(now.prepared.message_b64, 'base64'));
  const ix = base.instructions.map(i => ({ programId: i.programId, keys: i.keys, data: Buffer.from(i.data) }));
  const heapOf = bytes => ({ programId: ix[3].programId, keys: [], data: Buffer.concat([Buffer.from([1]), u32(bytes)]) });
  const report = instructions => { const v = rust(), m = Buffer.from(compileMessage({ feePayer: base.accountKeys[0], recentBlockhash: base.recentBlockhash, instructions })), parsed = parseMessage(m), n = parsed.accountKeys.length;
    v.prepared.message_b64 = m.toString('base64'); v.prepared.message_digest = createHash('sha256').update(m).digest('hex');
    v.prepared.shape = { bytes: m.length + 1 + 64 * parsed.signers.length, locks: n, writes: n - parsed.header.numReadonlySignedAccounts - parsed.header.numReadonlyUnsignedAccounts, sigs: parsed.signers.length }; return v; };
  assert.deepEqual(expeditionDepartPrepareReport(report(ix), now.request, PINS), report(ix), 'the same five instructions, recompiled, are accepted (account order is not the contract)');
  const cases = { 'no heap frame': [ix[0], ix[1], ix[2], ix[4]], 'two heap frames': [ix[0], ix[1], ix[2], ix[3], ix[3], ix[4]], 'the heap frame first': [ix[3], ix[0], ix[1], ix[2], ix[4]],
    'the heap frame last': [ix[0], ix[1], ix[2], ix[4], ix[3]], 'the heap frame before the loaded-data limit': [ix[0], ix[1], ix[3], ix[2], ix[4]],
    'a 32 KiB frame': [ix[0], ix[1], ix[2], heapOf(32768), ix[4]], 'a 128 KiB frame': [ix[0], ix[1], ix[2], heapOf(131072), ix[4]], 'a frame one page short': [ix[0], ix[1], ix[2], heapOf(262144 - 1024), ix[4]],
    'a sixth instruction': [...ix, { programId: ix[0].programId, keys: [], data: Buffer.from([2, 1, 0, 0, 0]) }], 'the dispatch twice': [ix[0], ix[1], ix[2], ix[3], ix[4], ix[4]], 'no price instruction': [ix[0], ix[2], ix[3], ix[4]] };
  for (const [name, instructions] of Object.entries(cases)) invalidReport(report(instructions), name);
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

test('the child\'s exit and its report must agree; a signal, another exit or a stdout that is not one JSON report is refused', async () => {
  const r = rust().request, h = harness();
  /** One request whose child writes `out` (a report object, or raw text) and closes with (exit, signal). */
  const run = async (out, exit, signal, want) => {
    const pending = h.api.prepare(r), rejected = assert.rejects(pending, code(want), `${typeof out === 'string' ? JSON.stringify(out.slice(0, 24)) : out === null ? 'no output' : out.status} exit ${exit} signal ${signal} → ${want}`);
    const child = h.children.at(-1);
    if (out !== null) child.stdout.emit('data', Buffer.from(typeof out === 'string' ? out : JSON.stringify(out)));
    child.emit('close', exit, signal); await rejected;
    assert.equal(h.api.active, 0, 'the slot is free once the child has closed');
  };
  // the exit code and the report's status disagree
  await run(rust(), 2, null, 'ExpeditionDepartPrepareInvalidReport');
  await run(blocked(), 0, null, 'ExpeditionDepartPrepareInvalidReport');
  await run(blocked('OutputTooLarge', null), 0, null, 'ExpeditionDepartPrepareInvalidReport');
  // any other exit, or no exit code at all, is not a report, whatever stdout holds
  for (const exit of [1, 3, 9, 101, 127, 255, -1, null]) await run(rust(), exit, null, 'ExpeditionDepartPrepareUnavailable');
  // ended by a signal: a complete, valid report on stdout is still not delivered
  for (const signal of ['SIGTERM', 'SIGKILL', 'SIGSEGV', 'SIGPIPE']) { await run(rust(), null, signal, 'ExpeditionDepartPrepareUnavailable'); await run(rust(), 0, signal, 'ExpeditionDepartPrepareUnavailable'); await run(blocked(), 2, signal, 'ExpeditionDepartPrepareUnavailable'); }
  // stdout that is not exactly one JSON report, with either accepted exit code
  const text = JSON.stringify(rust());
  for (const out of [null, '', ' ', 'prepared', 'error: connection refused', '<html>', '{', text.slice(0, -1), `${text}${text}`, `${text}\n{"status":"prepared"}`, `ok ${text}`,
    'null', 'true', '0', '"prepared"', '[]', `[${text}]`, '{}', '{"status":"prepared"}', `﻿${text}`]) {
    await run(out, 0, null, 'ExpeditionDepartPrepareInvalidReport'); await run(out, 2, null, 'ExpeditionDepartPrepareInvalidReport');
  }
  assert.ok(h.children.every(c => c.killed === undefined), 'a child that ended by itself is not killed again');
  // and the same child output with the matching exit is still accepted (whitespace around the one report is JSON's own)
  const fine = h.api.prepare(r); h.children.at(-1).stdout.emit('data', Buffer.from(`\n ${text} \n`)); h.children.at(-1).emit('close', 0, null); assert.deepEqual(await fine, rust());
  // a report delivered in pieces is one report
  const pieces = h.api.prepare(r), child = h.children.at(-1), bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; at += 997) child.stdout.emit('data', bytes.subarray(at, at + 997));
  child.emit('close', 0, null); assert.deepEqual(await pieces, rust());
});

// ---- the real HTTP handler (app.mjs createFrontierHandler) over mock request/response objects: no listener, no socket
const settle = () => new Promise(resolve => setImmediate(resolve));
/** One exchange with `handler`. `body`: a Buffer/string sent in `chunk`-byte pieces, or null for none; `end: false` leaves the request open. */
function exchange(handler, { method = 'POST', path, body = null, headers = {}, ip = '127.0.0.1', end = true, chunk = 4096 } = {}) {
  const req = new EventEmitter(); Object.assign(req, { method, url: path, headers: { ...headers }, socket: { remoteAddress: ip }, aborted: false });
  const res = new EventEmitter(); Object.assign(res, { writableEnded: false, destroyed: false, status: null, headers: null, text: null,
    writeHead(status, h) { res.status = status; res.headers = h; }, end(text) { res.text = text; res.writableEnded = true; } });
  const done = handler(req, res);
  const bytes = body === null ? null : Buffer.from(body);
  if (bytes) for (let at = 0; at < bytes.length; at += chunk) req.emit('data', bytes.subarray(at, at + chunk));
  if (end) req.emit('end');
  return { req, res, done, json: () => JSON.parse(res.text),
    /** The client goes away, as Node reports it: the request is aborted and the response closed and destroyed. */
    disconnect() { req.aborted = true; res.destroyed = true; req.emit('aborted'); res.emit('close'); } };
}
/** A JSON object of exactly `size` bytes. */
const padded = size => { const head = '{"pad":"', tail = '"}'; return head + 'a'.repeat(size - head.length - tail.length) + tail; };
function relay({ depart = harness(), surface = 'operator' } = {}) {
  const resident = { seen: [], prepare(body, { signal } = {}) { resident.seen.push({ body, signal }); return resident.answer ?? Promise.resolve({ resident: true }); } };
  const limits = [], logs = [];
  const ctx = { cfg: { heraldPeer: '127.0.0.1' }, log: line => logs.push(line), limiter: { check: (key, limit) => limits.push({ key, limit }) }, funds: { check() { assert.fail('a preparation never asks the relay pool'); } },
    expeditionDepartPrepare: depart?.api ?? null, expeditionPrepare: resident, expeditionPreview: null };
  // an ordinary route beside the real table: it reads its body and says what the handler gave it
  const echoed = [];
  const routes = { ...FRONTIER_ROUTES, 'POST /f/test-echo': async (_, request) => { const body = await request.json(); echoed.push(request.signal); return { body: { bytes: JSON.stringify(body).length, signal: request.signal === undefined ? 'none' : 'given' } }; } };
  return { ctx, depart, resident, limits, logs, echoed, handler: createFrontierHandler(ctx, { surface, routes }) };
}
const DEPART = '/f/expedition/depart/prepare', RESIDENT = '/f/expedition/prepare';

test('the real handler serves the route: the Rust report through, closed headers, both listeners, its own rate limit', HANDLER, async () => {
  assert.ok(Object.hasOwn(FRONTIER_ROUTES, EXPEDITION_DEPART_PREPARE_ROUTE) && FRONTIER_PUBLIC_ROUTES.includes(EXPEDITION_DEPART_PREPARE_ROUTE));
  assert.deepEqual(FRONTIER_IP_LIMITS[EXPEDITION_DEPART_PREPARE_ROUTE], { burst: 4, perSecond: 0.2 });
  for (const surface of ['operator', 'public']) {
    const x = relay({ surface }), e = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request) });
    await settle(); assert.equal(x.depart.calls.length, 1, surface); assert.deepEqual(JSON.parse(x.depart.children[0].input), rust().request);
    assert.equal(e.res.status, null, 'nothing is answered before the child has');
    x.depart.children[0].report(rust()); await e.done;
    assert.equal(e.res.status, 200); assert.deepEqual(e.json(), rust());
    assert.equal(e.res.headers['Content-Type'], 'application/json'); assert.equal(e.res.headers['Cache-Control'], 'no-store');
    assert.equal(e.res.headers['X-Content-Type-Options'], surface === 'public' ? 'nosniff' : undefined);
    assert.deepEqual(x.limits, [], 'a loopback client is not rate limited'); assert.deepEqual(x.resident.seen, [], 'the resident adapter is not asked');
  }
  // a public client elsewhere is counted against this route's own bucket
  const far = relay({ surface: 'public' }), e = exchange(far.handler, { path: DEPART, body: JSON.stringify(rust().request), ip: '203.0.113.9' });
  await settle(); far.depart.children[0].report(blocked()); await e.done;
  assert.equal(e.res.status, 200); assert.equal(e.json().status, 'blocked');
  assert.equal(far.limits.length, 1); assert.ok(far.limits[0].key.startsWith(`f-ip:${EXPEDITION_DEPART_PREPARE_ROUTE}:`)); assert.deepEqual(far.limits[0].limit, { burst: 4, perSecond: 0.2 });
  // not configured: a code, on both listeners, and the body is never read
  for (const surface of ['operator', 'public']) {
    const off = relay({ depart: null, surface }), o = exchange(off.handler, { path: DEPART, body: JSON.stringify(rust().request) }); await o.done;
    assert.equal(o.res.status, 503); assert.deepEqual(o.json(), { error: 'unsigned departure preparation is not configured', code: 'ExpeditionDepartPrepareDisabled' });
  }
  // only POST on exactly this path
  for (const [method, path] of [['GET', DEPART], ['PUT', DEPART], ['POST', `${DEPART}/`], ['POST', '/f/expedition/depart'], ['POST', `${DEPART}/x`]]) {
    const x = relay({ surface: 'public' }), o = exchange(x.handler, { method, path, body: JSON.stringify(rust().request) }); await o.done;
    assert.equal(o.res.status, 404, `${method} ${path}`); assert.equal(x.depart.calls.length, 0);
  }
});

test('the real handler bounds this route\'s body at 16 KiB, before the adapter, and leaves the other routes\' bounds alone', HANDLER, async () => {
  assert.equal(DEPART_PREPARE_MAX_REQUEST_BYTES, 16 * 1024); assert.equal(PREPARE_MAX_REQUEST_BYTES, 16 * 1024); assert.equal(FRONTIER_MAX_BODY_BYTES, 64 * 1024);
  const tooLarge = { error: 'request body too large', code: 'BodyTooLarge' };
  // declared too large: refused from the header alone
  { const x = relay(), e = exchange(x.handler, { path: DEPART, headers: { 'content-length': String(16 * 1024 + 1) }, body: null, end: false }); await e.done;
    assert.equal(e.res.status, 413); assert.deepEqual(e.json(), tooLarge); assert.equal(x.depart.calls.length, 0); }
  // streamed past the bound with no length declared, in small pieces
  { const x = relay(), e = exchange(x.handler, { path: DEPART, body: padded(16 * 1024 + 1), chunk: 1000 }); await e.done;
    assert.equal(e.res.status, 413); assert.deepEqual(e.json(), tooLarge); assert.equal(x.depart.calls.length, 0, 'no child for a body that was cut off'); }
  // a declared length that lies low does not widen the bound
  { const x = relay(), e = exchange(x.handler, { path: DEPART, headers: { 'content-length': '10' }, body: padded(20 * 1024) }); await e.done;
    assert.equal(e.res.status, 413); assert.equal(x.depart.calls.length, 0); }
  // exactly the bound is read whole and reaches the adapter's own check (which refuses it as a request, not as a size)
  { const x = relay(), e = exchange(x.handler, { path: DEPART, body: padded(16 * 1024) }); await e.done;
    assert.equal(e.res.status, 400); assert.equal(e.json().code, 'ExpeditionDepartPrepareInvalidRequest'); assert.equal(x.depart.calls.length, 0); }
  // not JSON, and JSON that is not an object
  for (const body of ['not json', '[1,2]', '"text"', 'null']) { const x = relay(), e = exchange(x.handler, { path: DEPART, body }); await e.done;
    assert.equal(e.res.status, 400, body); assert.equal(e.json().code, 'InvalidJson'); assert.equal(x.depart.calls.length, 0); }
  // the resident route keeps its own bound and its own adapter
  { const x = relay(), ok = exchange(x.handler, { path: RESIDENT, body: padded(16 * 1024) }); await ok.done;
    assert.equal(ok.res.status, 200); assert.deepEqual(ok.json(), { resident: true }); assert.equal(x.resident.seen.length, 1); assert.equal(JSON.stringify(x.resident.seen[0].body).length, 16 * 1024);
    const over = exchange(x.handler, { path: RESIDENT, body: padded(16 * 1024 + 1) }); await over.done;
    assert.equal(over.res.status, 413); assert.equal(x.resident.seen.length, 1); assert.equal(x.depart.calls.length, 0, 'the departure adapter is not asked'); }
  // an ordinary route still reads up to the relay's general 64 KiB and is given no signal
  { const x = relay(), ok = exchange(x.handler, { path: '/f/test-echo', body: padded(64 * 1024) }); await ok.done;
    assert.equal(ok.res.status, 200); assert.deepEqual(ok.json(), { bytes: 64 * 1024, signal: 'none' });
    const mid = exchange(x.handler, { path: '/f/test-echo', body: padded(16 * 1024 + 1) }); await mid.done; assert.equal(mid.res.status, 200, 'a body the preparation routes refuse is ordinary here');
    const over = exchange(x.handler, { path: '/f/test-echo', body: padded(64 * 1024 + 1) }); await over.done; assert.equal(over.res.status, 413);
    assert.deepEqual(x.echoed, [undefined, undefined]); }
});

test('the real handler carries a client that goes away to the adapter: the child is killed and nothing is written back', HANDLER, async () => {
  // while the child is working
  { const x = relay(), e = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request) });
    await settle(); assert.equal(x.depart.calls.length, 1); assert.equal(x.depart.children[0].killed, undefined);
    e.disconnect(); await e.done;
    assert.equal(x.depart.children[0].killed, 'SIGKILL', 'the abort reached the adapter');
    assert.equal(e.res.status, null); assert.equal(e.res.text, null, 'no answer is written to a client that left');
    assert.equal(x.depart.api.active, 1, 'the slot is held until the killed child has closed');
    x.depart.children[0].report(rust()); assert.equal(x.depart.api.active, 0); assert.equal(e.res.text, null, 'a late report is not delivered either'); }
  // the response closing alone (the socket went) is enough
  { const x = relay(), e = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request) });
    await settle(); e.res.destroyed = true; e.res.emit('close'); await e.done;
    assert.equal(x.depart.children[0].killed, 'SIGKILL'); assert.equal(e.res.status, null); }
  // while the body is still arriving: no child is ever started
  { const x = relay(), e = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request).slice(0, 500), end: false });
    await settle(); e.disconnect(); await e.done;
    assert.equal(x.depart.calls.length, 0); assert.equal(e.res.status, null); }
  // two clients: one leaves, the other is answered
  { const x = relay(), a = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request) }), b = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request) });
    await settle(); assert.equal(x.depart.calls.length, 2);
    a.disconnect(); await a.done; assert.equal(x.depart.children[0].killed, 'SIGKILL'); assert.equal(x.depart.children[1].killed, undefined, 'the other request is untouched');
    x.depart.children[1].report(rust()); await b.done; assert.equal(b.res.status, 200); assert.deepEqual(b.json(), rust()); }
  // the resident route's own request is aborted by its own client only, and gets its own signal
  { const x = relay(); let release; x.resident.answer = new Promise(resolve => { release = resolve; });
    const resident = exchange(x.handler, { path: RESIDENT, body: padded(100) }), depart = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request) });
    await settle(); assert.equal(x.resident.seen.length, 1); assert.equal(x.depart.calls.length, 1);
    const signal = x.resident.seen[0].signal; assert.ok(signal instanceof AbortSignal && !signal.aborted);
    depart.disconnect(); await depart.done;
    assert.equal(x.depart.children[0].killed, 'SIGKILL'); assert.equal(signal.aborted, false, 'the resident request is not aborted by another client leaving');
    release({ resident: true }); await resident.done; assert.equal(resident.res.status, 200); assert.deepEqual(resident.json(), { resident: true });
    // and the other way round
    // (a resident adapter that, like the real one, ends its work when its signal aborts)
    x.resident.prepare = (body, { signal }) => new Promise((_, reject) => { x.resident.seen.push({ body, signal });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'RequestAborted' })), { once: true }); });
    const r2 = exchange(x.handler, { path: RESIDENT, body: padded(100) }), d2 = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request) });
    await settle(); r2.disconnect(); await r2.done;
    assert.equal(x.resident.seen[1].signal.aborted, true); assert.equal(r2.res.status, null, 'and nothing is written to the resident client that left'); assert.equal(x.depart.children[1].killed, undefined, 'the departure child is not killed by the resident client leaving');
    x.depart.children[1].report(rust()); await d2.done; assert.equal(d2.res.status, 200); }
  // an ordinary route has no signal to abort and answers as before
  { const x = relay(), e = exchange(x.handler, { path: '/f/test-echo', body: padded(100) }); await e.done; assert.equal(e.res.status, 200); assert.equal(e.json().signal, 'none'); }
});

test('the real handler\'s own 30 s clock ends the request as a timeout: the child is killed and the code says so', HANDLER, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const x = relay(); let never; x.resident.answer = new Promise(() => {}); never = x.resident;
  const depart = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request) }), resident = exchange(x.handler, { path: RESIDENT, body: padded(100) });
  await settle(); assert.equal(x.depart.calls.length, 1);
  t.mock.timers.tick(DEPART_PREPARE_TIMEOUT_MS - 1); await settle();
  assert.equal(x.depart.children[0].killed, undefined, 'not a moment before'); assert.equal(depart.res.status, null);
  t.mock.timers.tick(1); await depart.done;
  assert.equal(x.depart.children[0].killed, 'SIGKILL');
  assert.equal(depart.res.status, 504); assert.deepEqual(depart.json(), { error: 'unsigned departure preparation timed out', code: 'ExpeditionDepartPrepareTimeout' });
  // the resident request, started at the same moment, was ended by its own clock with its own reason
  assert.equal(never.seen[0].signal.aborted, true); assert.equal(never.seen[0].signal.reason, 'ExpeditionPrepareTimeout');
  x.depart.children[0].emit('close', null, 'SIGKILL'); assert.equal(x.depart.api.active, 0);
  // a body that never finishes is ended by the same clock, with no child
  const slow = exchange(x.handler, { path: DEPART, body: '{"schema":', end: false });
  await settle(); t.mock.timers.tick(DEPART_PREPARE_TIMEOUT_MS); await slow.done;
  assert.equal(slow.res.status, 504); assert.equal(slow.json().code, 'ExpeditionDepartPrepareTimeout'); assert.equal(x.depart.calls.length, 1);
  // an answered request leaves no clock behind
  const quick = exchange(x.handler, { path: DEPART, body: JSON.stringify(rust().request) }); await settle();
  x.depart.children[1].report(rust()); await quick.done; assert.equal(quick.res.status, 200);
  t.mock.timers.tick(DEPART_PREPARE_TIMEOUT_MS * 2); await settle(); assert.equal(x.depart.children[1].killed, undefined);
  void resident;
});

test('wiring: the relay serves the route with its own limits, reads its own settings and closes it; the resident route is as it was', () => {
  const read = file => readFileSync(new URL(`../src/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), cfg = read('config.mjs'), server = read('server.mjs'), adapter = read('expedition-depart-prepare.mjs');
  assert.match(app, /FRONTIER_ROUTES = Object\.freeze\(\{[^}]*\.\.\.expeditionPrepareRoutes, \.\.\.expeditionDepartPrepareRoutes(?:, \.\.\.devnetPlayRoutes)? \}\)/);
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
  assert.match(cfg, /\[\.\.\.expeditionPreviewConfigProblems\(cfg\), \.\.\.expeditionPrepareConfigProblems\(cfg\), \.\.\.expeditionDepartPrepareConfigProblems\(cfg\)(?:, \.\.\.devnetPlayConfigProblems\(cfg\))?\]/);
  assert.match(server, /apps\.ctx\.expeditionPreview\?\.close\(\); apps\.ctx\.expeditionPrepare\?\.close\(\); apps\.ctx\.expeditionDepartPrepare\?\.close\(\);/);
  // the adapter's own source: one child process API, nothing that signs, seals, connects a wallet or sends
  const code = adapter.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort(), ['../../../permutation-server/web/frontier/faddr.mjs', '../../../permutation-server/web/frontier/fexpedition-depart.mjs', '../../../permutation-server/web/frontier/flocalplay-lane.mjs', '../../client/src/base58.mjs', '../../client/src/solana-tx.mjs', './expedition-preview.mjs', 'node:child_process', 'node:crypto', 'node:path']);
  assert.doesNotMatch(code, /\bfetch\s*\(|Keypair|secretKey|privateKey|\.sign\(|signTransaction|sendTransaction|sendRawTransaction|simulateTransaction|process\.env|exec\(|execFile|fork\(/);
  assert.match(code, /stdio: \['pipe', 'pipe', 'ignore'\]/); assert.match(code, /shell: false, cwd: '\/', env: \{\}/);
});
