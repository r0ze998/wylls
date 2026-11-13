// The dedicated local-play relay's conquest routes (src/frontier/local-play-conquest.mjs, conquest-prepare.mjs): the
// one player-signed step, DeclareSiege. A KEY-USING test (scripts/ci/node-key-tests.txt): the wallet is an in-memory
// test Ed25519 key (never printed or stored) that signs the prepared message. The CLI child and the runner's
// JSON-RPC are injected stubs: nothing is spawned or sent, no network beyond a loopback listener.
//
// The outer dispatch kind of DeclareSiege is NOT published yet. Every test that prepares a message passes an
// explicit TEST-ONLY pin (`TEST_PIN`); it asserts nothing about the real value. The first test pins the fact that
// without a pin nothing can be built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { encode } from '../client/src/base58.mjs';
import { compileMessage, COMPUTE_BUDGET_PROGRAM } from '../client/src/solana-tx.mjs';
import { seasonPda, withSeed, seedOf } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { expeditionRequestDigest } from '../src/frontier/expedition-preview.mjs';
import { canonicalDeclareSiegeRoles } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import { createConquestPrepare, conquestPrepareRequest, conquestPrepareReport, conquestDispatchPin, declareSiegeData, ConquestPrepareError,
  CONQUEST_DISPATCH_PINS, CONQUEST_ACTIONS, DECLARE_SIEGE_ROLES, CONQUEST_PREPARE_REQUEST_SCHEMA, CONQUEST_PREPARE_REPORT_SCHEMA, CONQUEST_PREPARE_TIMEOUT_MS } from '../src/frontier/conquest-prepare.mjs';
import { createLocalPlayRelay, LocalPlayError, LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH, ROUTES, SUBMIT_SCHEMA, singleSigned } from '../src/frontier/local-play-relay.mjs';
import { createLocalPlayConquest, conquestCapabilityProblems, CONQUEST_ROUTES, CONQUEST_SUBMIT_SCHEMA, CONQUEST_STATUS_SCHEMA, CONQUEST_OPEN_CONDITIONS, CONQUEST_MARKERS, CONQUEST_WORLD_PRESET } from '../src/frontier/local-play-conquest.mjs';
import { RESIDENT_ROUTES } from '../src/frontier/local-play-resident.mjs';
import { serveLocalPlayRelay, parseArgs } from '../src/frontier/local-play-relay-server.mjs';

const key = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { address: encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), privateKey };
};
const W = key(), OTHER = key();
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], BIN = '/operator/bin/frontier-experimental-conquest-prepare', SYSTEM = '11111111111111111111111111111111';
/** TEST-ONLY: not the published dispatch. Any value ≥ 12 serves; the real one goes into CONQUEST_DISPATCH_PINS. */
const TEST_PIN = { tag: 0xda, kind: 200, heap: 256 * 1024 }, TEST_DISPATCH = { DeclareSiege: TEST_PIN };
const cfg = (over = {}) => ({ localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address,
  rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/nonexistent/frontier-experimental-expedition-depart-prepare', cuLimit: '400000', loadedLimit: '1048576', ...over });
const source = (over = {}) => ({ schema: 'frontier-original-expedition-request-v1', operation: 'inspect', cluster: 'localnet', program: LOCAL_PLAY_PROGRAM, season: SEASON,
  deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH },
  host: canonicalOriginalHostRef({ world: worldIdOf(SEASON, LOCAL_PLAY_PROGRAM), p: '128', q: '0', site: 1, gen: 2, seq: 0 }),
  original_owner: withSeed(SEASON, seedOf('Citizen', { wallet: W.address }), LOCAL_PLAY_PROGRAM), standing: { p: '129', q: '0' }, min_slot: '80', wallet: W.address, payer: W.address, ...over });
let ids = 0;
const request = (over = {}, target = { site: 3, entry: 0 }) => ({ schema: CONQUEST_PREPARE_REQUEST_SCHEMA, request_id: `cq_${++ids}`, action: 'DeclareSiege', source_request: source(over),
  source_context_slot: '80', source_snapshot_digest: 'ab'.repeat(32), target });
const A = n => encode(new Uint8Array(32).fill(n));
/** A synthetic PUBLIC unsigned report for `r` under `pin`, in the contract's shape, with the canonical twelve accounts. Not a CLI's output. */
function synthetic(r, pin = TEST_PIN, { roles: reroles = null, limits = { cu: 400000, loaded: 1048576 } } = {}) {
  const s = r.source_request;
  let roles = canonicalDeclareSiegeRoles(s, r.target.site).map(x => ({ ...x }));
  if (reroles) roles = reroles(roles);
  const budget = (tag, n, size = 4) => { const d = Buffer.alloc(size + 1); d[0] = tag; size === 8 ? d.writeBigUInt64LE(BigInt(n), 1) : d.writeUInt32LE(n, 1); return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: d }; };
  const data = declareSiegeData(r, pin), hash = A(77);
  const message = Buffer.from(compileMessage({ feePayer: s.wallet, recentBlockhash: hash, instructions: [budget(2, limits.cu), budget(3, 0, 8), budget(4, limits.loaded), ...(pin.heap === null ? [] : [budget(1, pin.heap)]),
    { programId: s.program, keys: roles.map(x => ({ pubkey: x.address, isSigner: x.signer, isWritable: x.writable })), data }] }));
  const union = new Map(); for (const x of roles) { const o = union.get(x.address) ?? { w: false }; union.set(x.address, { w: o.w || x.writable }); }
  union.set(s.program, { w: false }); union.set(COMPUTE_BUDGET_PROGRAM, { w: false });
  const slot = (BigInt(r.source_context_slot) + 1n).toString();
  return { schema: CONQUEST_PREPARE_REPORT_SCHEMA, status: 'prepared', request: structuredClone(r),
    source: { request_digest: expeditionRequestDigest(s), context_slot: slot, digest: 'cd'.repeat(32), coherent: true, authority_verified: false },
    blockhash: { hash, latest_context_slot: slot, validity_context_slot: slot, height_min_context_slot: slot, block_height: '100', last_valid_block_height: '250', remaining_block_heights: '150',
      valid: true, commitment: 'confirmed', coherent: false, authority_verified: false },
    prepared: { program: s.program, season: s.season, program_version: '18436', action: r.action, fee_payer: s.wallet, dispatch: { tag: pin.tag, kind: pin.kind },
      budget: { cu_limit: limits.cu, cu_price: '0', loaded_limit: limits.loaded, heap: pin.heap }, roles, instruction_hex: data.toString('hex'),
      message_b64: message.toString('base64'), message_digest: createHash('sha256').update(message).digest('hex'), signers: [s.wallet],
      shape: { bytes: message.length + 65, locks: union.size, writes: [...union.values()].filter(x => x.w).length, sigs: 1 } },
    blocker: null, host_only: true, ready: false, deployment_verified: false, admitted: false, signed: false, enqueued: false, relay_submission_available: false, automatic_send: false };
}
const PINS = { fee_payer: W.address, cu_limit: 400000, loaded_limit: 1048576, dispatch: TEST_PIN };
function harness({ send = null, height = 120, dispatch = TEST_DISPATCH, capability = null, account = null } = {}) {
  const calls = [], children = [], rpcCalls = [];
  const h = { calls, children, rpcCalls, auto: r => synthetic(r), sends: () => rpcCalls.filter(x => x.method === 'sendTransaction').length, reads: () => rpcCalls.filter(x => x.method === 'getAccountInfo') };
  h.conquest = createLocalPlayConquest({ cfg: cfg(), conquestBin: BIN, dispatch, capability, setTimer: (fn, ms) => ({ fn, ms }), clearTimer: () => {},
    spawn: (bin, args, options) => {
      calls.push({ bin, args, options }); const c = new EventEmitter();
      c.stdin = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin.end = payload => { c.input = payload; queueMicrotask(() => { if (h.auto) c.report(h.auto(JSON.parse(payload))); }); };
      c.kill = signal => { c.killed = signal; return true; };
      c.report = (v, code = v.status === 'prepared' ? 0 : 2) => { c.stdout.emit('data', Buffer.from(JSON.stringify(v))); c.emit('close', code, null); };
      children.push(c); return c;
    },
    rpc: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === 'getBlockHeight') return { result: height };
      if (method === 'sendTransaction') return send ? send(params) : { result: encode(singleSigned(Buffer.from(params[0], 'base64')).signature) };
      if (method === 'getSignatureStatuses') return { result: { context: { slot: 130 }, value: [{ slot: 9, confirmationStatus: 'confirmed', err: null }] } };
      if (method === 'getAccountInfo' && account) return account(params);
      return { error: { code: -1 } };
    } });
  return h;
}
const wire = (report, signers = [W]) => { const message = Buffer.from(report.prepared.message_b64, 'base64'); return Buffer.concat([Buffer.from([signers.length]), ...signers.map(s => sign(null, message, s.privateKey)), message]).toString('base64'); };
const refused = (p, want) => assert.rejects(p, e => e instanceof LocalPlayError && e.code === want);
const adapterRefused = (p, want) => assert.rejects(p, e => e instanceof ConquestPrepareError && e.code === want);

test('CLOSED: the dispatch kind is unpinned today, so no conquest route can be built, from code or from the command line', () => {
  assert.deepEqual(CONQUEST_DISPATCH_PINS, { DeclareSiege: { tag: 0xda, kind: 12, heap: 256 * 1024 } }, 'the published kind and tag; the heap frame is a recorded local decision');
  assert.deepEqual(CONQUEST_ACTIONS, ['DeclareSiege'], 'only the player-signed step; the five crank steps are never prepared for a player');
  // a pin alone opens nothing: three conditions are not established, and the route cannot be built while any is false
  assert.throws(() => createLocalPlayConquest({ cfg: cfg(), conquestBin: BIN }), /closed \(not established: heapConfirmed, pageBinding\)/);
  assert.deepEqual(CONQUEST_OPEN_CONDITIONS, { dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
  // the world is never a constant: a capability of THIS start, bound to this relay's program, Season and runner, with both markers
  const capability = { schema: 'frontier-local-play-conquest-capability-v1', artifact_sha256: 'ab'.repeat(32), markers: [...CONQUEST_MARKERS], program: LOCAL_PLAY_PROGRAM, season: SEASON,
    rpc: 'http://127.0.0.1:41964', world_preset: CONQUEST_WORLD_PRESET, free_city: { p: '129', q: '0', site: 3, tile: 43 } };
  assert.deepEqual(conquestCapabilityProblems(capability, cfg()), []);
  assert.deepEqual(CONQUEST_MARKERS, ['PSF_LOCALNET_EXPEDITION_SBF_BUILD', 'PSF_LOCALNET_CONQUEST_SBF_BUILD']);
  for (const over of [{ artifact_sha256: '00'.repeat(32) }, { artifact_sha256: 'AB'.repeat(32) }, { markers: ['PSF_LOCALNET_EXPEDITION_SBF_BUILD'] }, { markers: [...CONQUEST_MARKERS].reverse() }, { markers: [...CONQUEST_MARKERS, 'X'] },
    { program: A(0x33) }, { season: A(0x34) }, { rpc: 'http://127.0.0.1:41965' }, { world_preset: 'expedition' }, { free_city: null }, { free_city: { p: '129', q: '0', site: 12, tile: 43 } },
    { free_city: { p: 129, q: '0', site: 3, tile: 43 } }, { free_city: { p: '129', q: '0', site: 3, tile: 61 } }, { schema: 'x' }, { verified: true }]) {
    assert.notDeepEqual(conquestCapabilityProblems({ ...capability, ...over }, cfg()), [], JSON.stringify(over));
  }
  for (const c of [null, undefined, 'x', [], {}]) assert.notDeepEqual(conquestCapabilityProblems(c, cfg()), []);
  // and even a well-formed capability opens nothing while a condition is not established
  assert.throws(() => createLocalPlayConquest({ cfg: cfg(), conquestBin: BIN, capability }), /closed \(not established: heapConfirmed, pageBinding\)/);
  assert.throws(() => createConquestPrepare({ cfg: { cluster: 'localnet', programId: LOCAL_PLAY_PROGRAM, conquestPrepareBin: BIN, conquestPrepareRpc: 'http://127.0.0.1:41964', conquestPrepareFeePayer: W.address,
    conquestPrepareRulesetHash: LOCAL_PLAY_RULESET_HASH, conquestPrepareCuLimit: 400000, conquestPrepareLoadedLimit: 1048576 }, season: SEASON, dispatch: {} }), e => e.code === 'ConquestPrepareDisabled');
  // a pin must be explicit and well formed: an existing kind (0–11), a missing heap decision or an extra field is no pin
  for (const pin of [null, {}, { tag: 0xda, kind: 12 }, { tag: 0xda, kind: 11, heap: null }, { tag: 0xda, kind: 0, heap: null }, { tag: 256, kind: 12, heap: null }, { tag: 0xda, kind: 12, heap: 1024 }, { tag: 0xda, kind: 12, heap: null, open: true }, { tag: 0xda, kind: '12', heap: null }]) {
    assert.equal(conquestDispatchPin(pin), null); assert.throws(() => createLocalPlayConquest({ cfg: cfg(), conquestBin: BIN, dispatch: { DeclareSiege: pin } }), /closed/);
  }
  assert.deepEqual(conquestDispatchPin({ tag: 0xda, kind: 12, heap: null }), { tag: 0xda, kind: 12, heap: null });
  for (const conquestBin of ['relative/bin', undefined, null, '']) assert.throws(() => createLocalPlayConquest({ cfg: cfg(), conquestBin, dispatch: TEST_DISPATCH }), /closed/);
  for (const over of [{ localPlay: false }, { rpc: 'http://127.0.0.1:8899' }, { program: A(0x33) }, { rulesetHash: '00'.repeat(32) }]) assert.throws(() => createLocalPlayConquest({ cfg: cfg(over), conquestBin: BIN, dispatch: TEST_DISPATCH }), /local-play conquest/);
  // the command line takes the flag and keeps it apart from the relay's closed configuration; starting with it is what throws
  const base = ['--local-play', '--listen-port', '41966', '--rpc', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--wallet', W.address,
    '--ruleset-hash', LOCAL_PLAY_RULESET_HASH, '--prepare-bin', '/abs/prepare', '--cu-limit', '1000000', '--loaded-limit', '1048576'];
  const plain = parseArgs(base), withBin = parseArgs([...base, '--conquest-bin', BIN]);
  assert.equal(plain.conquestBin, null); assert.equal(withBin.conquestBin, BIN); assert.deepEqual(withBin.cfg, plain.cfg);
  assert.throws(() => parseArgs([...base, '--conquest-bin', BIN, '--conquest-bin', BIN]), /bad argument/);
  assert.throws(() => createLocalPlayConquest({ cfg: withBin.cfg, conquestBin: withBin.conquestBin }), /closed/);
});

test('with an explicit pin: the closed request, the one-shot CLI under the relay\'s pins, the exact message signed once by the wallet, sent once', async () => {
  const h = harness(), r = request();
  assert.deepEqual(conquestPrepareRequest(r), r);
  const { report, submit } = await h.conquest.prepare(r);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].bin, BIN);
  assert.deepEqual(h.calls[0].args, ['--rpc-url', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--fee-payer', W.address,
    '--ruleset-hash', LOCAL_PLAY_RULESET_HASH, '--cu-limit', '400000', '--loaded-limit', '1048576']);
  assert.deepEqual(h.calls[0].options, { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  assert.deepEqual(JSON.parse(h.children[0].input), r);
  assert.equal(report.status, 'prepared'); assert.deepEqual(report.prepared.signers, [W.address]); assert.equal(report.signed, false); assert.equal(report.automatic_send, false);
  // the instruction: the outer wrapper of the pin, then the ABI's own DeclareSiege bytes for this site and roster entry
  assert.equal(report.prepared.instruction_hex, 'daff02c8' + 'daff0105' + '0300');
  assert.deepEqual(report.prepared.roles.map(x => [x.name, x.signer, x.writable]), DECLARE_SIEGE_ROLES.map((x, i) => [x[0], x[1], x[2] || i === 0]), 'the ABI table; the wallet named twice is writable at both positions');
  assert.deepEqual(submit, { route: CONQUEST_ROUTES.submit, schema: CONQUEST_SUBMIT_SCHEMA, message_digest: report.prepared.message_digest, last_valid_block_height: '250', signer: W.address });
  assert.equal(h.sends(), 0);
  const body = { schema: CONQUEST_SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: wire(report) };
  const sent = await h.conquest.submit(body);
  assert.equal(sent.status, 'submitted'); assert.equal(sent.status_route, CONQUEST_ROUTES.status); assert.equal(h.sends(), 1);
  await refused(h.conquest.submit(body), 'LocalPlayMessageUsed'); assert.equal(h.sends(), 1);
  assert.deepEqual(await h.conquest.status({ schema: CONQUEST_STATUS_SCHEMA, signature: sent.signature }), { signature: sent.signature, status: 'confirmed', err: null, slot: 9, context_slot: 130 });
  // another signer, two signers, the Depart schema: nothing reaches the runner
  // (the same message prepared again keeps its first, used ticket: that is the replay barrier; another site is another message)
  await refused(h.conquest.prepare(request()), 'LocalPlayMessageUsed');
  const again = await h.conquest.prepare(request({}, { site: 4, entry: 0 }));
  const b2 = tx => ({ schema: CONQUEST_SUBMIT_SCHEMA, message_digest: again.submit.message_digest, transaction_b64: tx });
  await refused(h.conquest.submit(b2(wire(again.report, [OTHER]))), 'LocalPlayBadSignature');
  await refused(h.conquest.submit(b2(wire(again.report, [W, OTHER]))), 'LocalPlayBadTransaction');
  await refused(h.conquest.submit({ ...b2(wire(again.report)), schema: SUBMIT_SCHEMA }), 'LocalPlayInvalidRequest');
  assert.equal(h.sends(), 1);
  // an answer that never comes: unknown; never sent again
  const lost = harness({ send: () => { throw new Error('socket'); } }), p = await lost.conquest.prepare(request());
  const lb = { schema: CONQUEST_SUBMIT_SCHEMA, message_digest: p.submit.message_digest, transaction_b64: wire(p.report) };
  assert.equal((await lost.conquest.submit(lb)).status, 'unknown'); await refused(lost.conquest.submit(lb), 'LocalPlayMessageUsed'); assert.equal(lost.sends(), 1);
  assert.equal(CONQUEST_PREPARE_TIMEOUT_MS, 30_000);
});

test('scope and request: another wallet, payer, cluster, version or ruleset, another action, a site or entry out of range, are refused before anything is spawned', async () => {
  const h = harness();
  for (const over of [{ wallet: OTHER.address, payer: OTHER.address }, { cluster: 'devnet' }, { deployment: { program_version: '18436', ruleset_hash: 'ab'.repeat(32) } }]) await refused(h.conquest.prepare(request(over)), 'LocalPlayScopeMismatch');
  for (const over of [{ payer: OTHER.address }, { payer: null }, { wallet: null, payer: null }]) await refused(h.conquest.prepare(request(over)), 'LocalPlayScopeMismatch');
  await refused(h.conquest.prepare(request({ deployment: { program_version: '16388', ruleset_hash: LOCAL_PLAY_RULESET_HASH } })), 'LocalPlayScopeMismatch');
  for (const change of [r => { r.action = 'SettleCapture'; }, r => { r.action = 'ResolveWithConquest'; }, r => { r.action = 'Dissolve'; }, r => { r.target.site = 12; }, r => { r.target.site = -1; }, r => { r.target.entry = 56; },
    r => { r.target.entry = '0'; }, r => { r.target.tile = 3; }, r => { r.instruction_hex = 'daff'; }, r => { r.source_snapshot_digest = 'AB'.repeat(32); }, r => { r.source_context_slot = '79'; }, r => { r.schema = 'frontier-experimental-expedition-prepare-request-v1'; }]) {
    const r = request(); change(r);
    await adapterRefused(h.conquest.prepare(r), 'ConquestPrepareInvalidRequest');
  }
  for (const body of [null, [], 'x', {}, { source_request: null }]) await refused(h.conquest.prepare(body), 'LocalPlayInvalidRequest');
  // a host that is not this wallet's own Citizen's: its accounts cannot be named for this wallet, so nothing is prepared
  await adapterRefused(h.conquest.prepare(request({ original_owner: withSeed(SEASON, seedOf('Citizen', { wallet: OTHER.address }), LOCAL_PLAY_PROGRAM) })), 'ConquestPrepareInvalidRequest');
  assert.equal(h.calls.length, 0, 'nothing was spawned');
  // blocked: the CLI's own closed blocker, no submit note; an unknown blocker word is no report
  h.auto = q => ({ ...synthetic(q), status: 'blocked', blockhash: null, prepared: null, blocker: { code: 'TargetNotFreeCity' } });
  assert.equal((await h.conquest.prepare(request())).submit, null); assert.equal(h.conquest.stats().open, 0);
  h.auto = q => ({ ...synthetic(q), status: 'blocked', blockhash: null, prepared: null, blocker: { code: 'AnythingElse' } });
  await adapterRefused(h.conquest.prepare(request()), 'ConquestPrepareInvalidReport');
});

test('the report is checked independently: wrapper, inner bytes, roles, privileges, identities, budget and shape cannot be substituted', () => {
  const r = request(), good = synthetic(r);
  assert.deepEqual(conquestPrepareReport(good, r, PINS), good);
  const bad = v => assert.throws(() => conquestPrepareReport(v, r, PINS), e => e.code === 'ConquestPrepareInvalidReport');
  // another dispatch than the pinned one (also a real existing kind), another site or entry, another heap decision
  for (const v of [synthetic(r, { tag: 0xda, kind: 201, heap: 256 * 1024 }), synthetic(r, { tag: 0xdc, kind: 200, heap: 256 * 1024 }), synthetic(r, { tag: 0xda, kind: 4, heap: 256 * 1024 }), synthetic(r, { tag: 0xda, kind: 200, heap: null }),
    synthetic({ ...r, target: { site: 4, entry: 0 } }), synthetic({ ...r, target: { site: 3, entry: 1 } }), synthetic(r, TEST_PIN, { limits: { cu: 400001, loaded: 1048576 } })]) {
    const x = structuredClone(v); x.request = structuredClone(r); bad(x);
  }
  // roles: a privilege added or dropped, an order change, a foreign actor/payer/Season/system, an alias that is not the allowed one, an extra account
  for (const reroles of [roles => roles.map(x => (x.name === 'target_roster' ? { ...x, writable: true } : x)), roles => roles.map(x => (x.name === 'conquest' ? { ...x, writable: false } : x)),
    roles => roles.map(x => (x.name === 'actor' ? { ...x, writable: false } : x)), roles => roles.map(x => (x.name === 'citizen' ? { ...x, signer: true } : x)), roles => [roles[1], roles[0], ...roles.slice(2)],
    roles => roles.map(x => (x.name === 'actor' ? { ...x, address: OTHER.address } : x)), roles => roles.map(x => (x.name === 'payer' ? { ...x, address: OTHER.address } : x)),
    roles => roles.map(x => (x.name === 'season' ? { ...x, address: A(40) } : x)), roles => roles.map(x => (x.name === 'system' ? { ...x, address: A(41) } : x)),
    roles => roles.map(x => (x.name === 'capture_escrow' ? { ...x, address: A(25) } : x)), roles => roles.map(x => (x.name === 'conquest' ? { ...x, address: W.address } : x)),
    roles => roles.map(x => (x.name === 'source_province' ? { ...x, address: A(25) } : x)), roles => roles.map(x => (x.name === 'target_holding_position' ? { ...x, address: LOCAL_PLAY_PROGRAM } : x)),
    roles => roles.slice(0, 11), roles => [...roles, { name: 'extra', address: A(50), signer: false, writable: true }], roles => roles.map(x => (x.name === 'citizen' ? { ...x, name: 'holder' } : x))]) {
    let v; try { v = synthetic(r, TEST_PIN, { roles: reroles }); } catch { continue; }
    bad(v);
  }
  // THE SUBSTITUTION CASES: a report whose accounts are a real, well-formed DeclareSiege of ANOTHER site, ANOTHER
  // province, ANOTHER host's village or ANOTHER Citizen's escrow, offered for this request. Each is the canonical set
  // of some other request, so only the binding to THIS request refuses it.
  const elsewhere = over => canonicalDeclareSiegeRoles(source(over), 3).map(x => ({ ...x }));
  const otherSite = canonicalDeclareSiegeRoles(r.source_request, 4).map(x => ({ ...x }));
  const otherProvince = elsewhere({ standing: { p: '130', q: '0' } });
  const otherHost = elsewhere({ host: canonicalOriginalHostRef({ world: worldIdOf(SEASON, LOCAL_PLAY_PROGRAM), p: '128', q: '0', site: 2, gen: 2, seq: 0 }) });
  assert.notEqual(otherSite[8].address, good.prepared.roles[8].address, 'another site is another target holding position');
  assert.notDeepEqual([5, 6, 8, 9].map(i => otherProvince[i].address), [5, 6, 8, 9].map(i => good.prepared.roles[i].address), 'another province is another province, roster, position and conquest table');
  assert.notEqual(otherHost[4].address, good.prepared.roles[4].address, 'another host is another village');
  for (const swap of [() => otherSite, () => otherProvince, () => otherHost,
    roles => roles.map((x, i) => (i === 8 ? otherSite[8] : x)), roles => roles.map((x, i) => (i === 9 ? otherProvince[9] : x)), roles => roles.map((x, i) => (i === 6 ? otherProvince[6] : x)),
    roles => roles.map((x, i) => (i === 5 ? otherProvince[5] : x)), roles => roles.map((x, i) => (i === 4 ? otherHost[4] : x)), roles => roles.map((x, i) => (i === 7 ? otherProvince[5] : x))]) {
    bad(synthetic(r, TEST_PIN, { roles: swap }));
  }
  // the same holds for the inner bytes: the right accounts with another site or entry in the command are refused (above),
  // and the wrong accounts with the right command are refused (here): site, command and accounts are one binding
  const moved = synthetic({ ...r, target: { site: 4, entry: 0 } }); moved.request = structuredClone(r); bad(moved);
  // claims and bytes
  for (const change of [v => { v.signed = true; }, v => { v.ready = true; }, v => { v.host_only = false; }, v => { v.request.request_id = 'other'; }, v => { v.source.context_slot = '79'; }, v => { v.source.authority_verified = true; },
    v => { v.blockhash.remaining_block_heights = '1'; v.blockhash.last_valid_block_height = '101'; }, v => { v.prepared.message_digest = '00'.repeat(32); }, v => { v.prepared.signers = [W.address, OTHER.address]; },
    v => { v.prepared.fee_payer = OTHER.address; }, v => { v.prepared.program_version = '16388'; }, v => { v.prepared.action = 'SettleCapture'; }, v => { v.prepared.instruction_hex = 'daff02c8daff01050301'; },
    v => { v.prepared.shape.writes += 1; }, v => { v.prepared.budget.cu_price = '1'; }, v => { v.prepared.dispatch.kind = 12; }, v => { v.prepared.extra = 1; }, v => { v.blocker = { code: 'SourceBlocked' }; }]) {
    const v = structuredClone(good); change(v); bad(v);
  }
  // the pinned fee payer is the relay's, whatever the report says
  assert.throws(() => conquestPrepareReport(good, r, { ...PINS, fee_payer: OTHER.address }), e => e.code === 'ConquestPrepareInvalidReport');
});

test('over HTTP: served only when given; its refusals keep their own codes; the other flows and their barriers are apart; the listener closes it', async () => {
  const depart = () => createLocalPlayRelay({ cfg: cfg(), prepare: { prepare: async () => ({ status: 'blocked', blocker: { code: 'X' } }), close() {} }, rpc: async () => ({ error: { code: -1 } }) });
  const post = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const bare = await serveLocalPlayRelay(depart(), 0);
  try { for (const p of ['prepare', 'submit', 'status']) assert.equal((await post(bare.port, `/f/local-play/conquest/${p}`, {})).status, 404); } finally { await bare.close(); }
  for (const route of Object.values(CONQUEST_ROUTES)) assert.ok(!Object.values(ROUTES).includes(route) && !Object.values(RESIDENT_ROUTES).includes(route));
  const h = harness(), s = await serveLocalPlayRelay(depart(), 0, { conquest: h.conquest });
  try {
    const r = request(), res = await post(s.port, '/f/local-play/conquest/prepare', r);
    assert.equal(res.status, 200);
    const { report, submit } = await res.json();
    const sent = await (await post(s.port, '/f/local-play/conquest/submit', { schema: CONQUEST_SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: wire(report) })).json();
    assert.equal(sent.status, 'submitted');
    assert.equal((await (await post(s.port, '/f/local-play/conquest/status', { schema: CONQUEST_STATUS_SCHEMA, signature: sent.signature })).json()).status, 'confirmed');
    for (const [p, body, status, code] of [['prepare', request({ wallet: OTHER.address, payer: OTHER.address }), 409, 'LocalPlayScopeMismatch'], ['prepare', { ...request(), action: 'SettleCapture' }, 400, 'ConquestPrepareInvalidRequest'],
      ['submit', { schema: CONQUEST_SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: wire(report) }, 409, 'LocalPlayMessageUsed'], ['prepare', '{', 400, 'InvalidJson']]) {
      const badRes = await post(s.port, `/f/local-play/conquest/${p}`, body), answer = await badRes.json();
      assert.equal(badRes.status, status, code); assert.equal(answer.code, code); assert.ok(!JSON.stringify(answer).includes(BIN));
    }
    // a conquest message is unknown to the Depart routes of the same listener
    assert.equal((await (await post(s.port, '/f/local-play/depart/submit', { schema: SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: wire(report) })).json()).code, 'LocalPlayUnknownMessage');
    assert.equal(h.sends(), 1);
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${s.port}/f/local-play/info`)).json()).routes, ROUTES, 'the relay\'s info names no conquest route or capability');
  } finally { await s.close(); }
  await adapterRefused(h.conquest.prepare(request()), 'ConquestPrepareUnavailable');
});

// ------------------------------------------------------------------ the city binding (this start's capability)
import { LAYOUTS } from '../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { decodePrefix } from '../../permutation-server/web/frontier/fcodec.mjs';
const PROVINCE = LAYOUTS.accounts.find(a => a.kind === 'Province'), fieldOff = name => PROVINCE.fields.find(f => f.name === name).off;
/** A stand-in wide Province: `sites` is `[[tile, state], …]` in site order (state 5: a Free City, as the ABI has it). */
function provinceBytes(sites) {
  const b = new Uint8Array(4864);
  b[fieldOff('SITE_COUNT')] = sites.length;
  sites.forEach(([tile, state], i) => { b[fieldOff('SITES') + i] = tile; b[fieldOff('SITE_MIRROR') + i * 64] = state; });
  return b;
}
const account = (bytes, owner = LOCAL_PLAY_PROGRAM) => () => ({ result: { value: bytes === null ? null : { owner, lamports: 1, executable: false, data: [Buffer.from(bytes).toString('base64'), 'base64'] } } });
/** TEST-ONLY capability: a Free City at site 3, tile 43 of (129, 0). Not a real start's; it opens nothing by itself. */
const CAPABILITY = { schema: 'frontier-local-play-conquest-capability-v1', artifact_sha256: 'ab'.repeat(32), markers: [...CONQUEST_MARKERS], program: LOCAL_PLAY_PROGRAM, season: SEASON,
  rpc: 'http://127.0.0.1:41964', world_preset: CONQUEST_WORLD_PRESET, free_city: { p: '129', q: '0', site: 3, tile: 43 } };
const CITY = [[10, 1], [20, 0], [30, 1], [43, 5]];   // (site 3 is the Free City, on tile 43)

test('the city binding: a prepare must name THIS start\'s Free City — the province, the site, and on the chain the site\'s tile — or the CLI is never asked', async () => {
  // (the stand-in Province reads back as the ABI has it)
  const read = decodePrefix('Province', provinceBytes(CITY), { profile: 2 });
  assert.equal(read.siteCount, 4); assert.equal(read.sites[3], 43); assert.equal(read.siteMirror[3].state, 5);
  // NORMAL: this province, this site, the tile and the Free City state on the chain → the CLI is asked, as before
  { const h = harness({ capability: CAPABILITY, account: account(provinceBytes(CITY)) }), r = request();
    const { report, submit } = await h.conquest.prepare(r);
    assert.equal(report.status, 'prepared'); assert.equal(h.calls.length, 1); assert.equal(submit.signer, W.address);
    const reads = h.reads(); assert.equal(reads.length, 1, 'one read, of the target Province only');
    assert.deepEqual(reads[0].params, [canonicalDeclareSiegeRoles(r.source_request, 3)[5].address, { encoding: 'base64', commitment: 'confirmed' }]);
    assert.equal(h.sends(), 0); }
  const refusedBefore = async (h, r, code, why) => {
    await assert.rejects(h.conquest.prepare(r), e => e.code === code, why);
    assert.equal(h.calls.length, 0, `${why}: nothing was spawned`); assert.equal(h.sends(), 0); assert.equal(h.conquest.stats().open, 0);
  };
  // ANOTHER PROVINCE than the capability's city (each a canonical request of its own): refused without any read
  for (const standing of [{ p: '130', q: '0' }, { p: '129', q: '1' }, { p: '129', q: '-1' }]) {
    const h = harness({ capability: CAPABILITY, account: account(provinceBytes(CITY)) });
    await refusedBefore(h, request({ standing }), 'ConquestPrepareScopeMismatch', JSON.stringify(standing)); assert.equal(h.reads().length, 0);
  }
  // ANOTHER SITE of the right province (also one that IS a village, and one past the count): refused without any read
  for (const site of [0, 2, 4, 11]) {
    const h = harness({ capability: CAPABILITY, account: account(provinceBytes(CITY)) });
    await refusedBefore(h, request({}, { site, entry: 0 }), 'ConquestPrepareScopeMismatch', `site ${site}`); assert.equal(h.reads().length, 0);
  }
  // THE SITE AND THE TILE on the chain: the capability says site 3 is on tile 43
  for (const [bytes, owner, why] of [
    [provinceBytes([[10, 1], [20, 0], [30, 1], [44, 5]]), LOCAL_PLAY_PROGRAM, 'site 3 is on another tile'],
    [provinceBytes([[10, 1], [20, 0], [43, 5], [30, 1]]), LOCAL_PLAY_PROGRAM, 'tile 43 is another site\'s; site 3 is a village'],
    [provinceBytes([[10, 1], [20, 0], [30, 1], [43, 1]]), LOCAL_PLAY_PROGRAM, 'site 3 is on tile 43 but is not a Free City'],
    [provinceBytes([[10, 1], [20, 0], [30, 1], [43, 0]]), LOCAL_PLAY_PROGRAM, 'site 3 is free land'],
    [provinceBytes([[10, 1], [20, 0], [30, 1]]), LOCAL_PLAY_PROGRAM, 'the province has no site 3'],
    [provinceBytes(CITY), A(0x33), 'the account is not the program\'s'],
    [new Uint8Array(100), LOCAL_PLAY_PROGRAM, 'bytes too short to be a Province'],
    [null, LOCAL_PLAY_PROGRAM, 'the Province is not opened'],
  ]) {
    const h = harness({ capability: CAPABILITY, account: account(bytes, owner) });
    await refusedBefore(h, request(), 'ConquestPrepareScopeMismatch', why); assert.equal(h.reads().length, 1, why);
  }
  // a read that fails or is malformed is no proof: refused as the relay's "runner did not answer", never passed on
  for (const bad of [() => { throw new Error('socket'); }, () => ({ error: { code: -1 } }), () => ({}), () => ({ result: { value: { owner: LOCAL_PLAY_PROGRAM, data: 'AA==' } } }), () => ({ result: { value: { owner: LOCAL_PLAY_PROGRAM, data: ['AA==', 'base58'] } } })]) {
    const h = harness({ capability: CAPABILITY, account: bad });
    await assert.rejects(h.conquest.prepare(request()), e => ['LocalPlayRpcUnavailable', 'ConquestPrepareScopeMismatch'].includes(e.code)); assert.equal(h.calls.length, 0);
  }
  // a malformed body never reaches the read either
  { const h = harness({ capability: CAPABILITY, account: account(provinceBytes(CITY)) });
    for (const body of [null, {}, { source_request: null, target: { site: 3, entry: 0 } }, { source_request: request().source_request }]) await assert.rejects(h.conquest.prepare(body)); assert.equal(h.reads().length, 0); assert.equal(h.calls.length, 0); }
});

test('another world\'s capability is never this relay\'s: it is refused at construction, in a test build as in the real one; and no capability still means closed from the command line', () => {
  const build = capability => createLocalPlayConquest({ cfg: cfg(), conquestBin: BIN, dispatch: TEST_DISPATCH, capability, spawn: () => { throw new Error('never'); } });
  build(CAPABILITY);   // (this world's)
  for (const [over, why] of [[{ program: A(0x33) }, 'another program'], [{ season: A(0x34) }, 'another Season'], [{ rpc: 'http://127.0.0.1:41965' }, 'another runner'], [{ world_preset: 'S1_LOCAL_7D' }, 'another preset'],
    [{ markers: ['PSF_LOCALNET_EXPEDITION_SBF_BUILD'] }, 'the expedition artefact only'], [{ artifact_sha256: '00'.repeat(32) }, 'no artefact'], [{ free_city: { p: '129', q: '0', site: 3 } }, 'a city without its tile'],
    [{ free_city: { p: '129', q: '0', site: 3, tile: 61 } }, 'a tile out of range'], [{ heapConfirmed: true }, 'an extra claim']]) {
    assert.throws(() => build({ ...CAPABILITY, ...over }), /closed \(world capability/, why);
  }
  // the real path is unchanged: with a perfect capability the conditions still close it, and without one it is closed too
  assert.throws(() => createLocalPlayConquest({ cfg: cfg(), conquestBin: BIN, capability: CAPABILITY }), /closed \(not established: heapConfirmed, pageBinding\)/);
  assert.throws(() => createLocalPlayConquest({ cfg: cfg(), conquestBin: BIN }), /closed \(not established: heapConfirmed, pageBinding\)/);
  assert.deepEqual(CONQUEST_OPEN_CONDITIONS, { dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
});

import { readConquestCapability, CONQUEST_CAPABILITY_MAX_BYTES } from '../src/frontier/local-play-relay-server.mjs';
test('the command line: --conquest-capability is an absolute path, only beside --conquest-bin, read once as a small JSON object; it opens nothing', () => {
  const base = ['--local-play', '--listen-port', '41966', '--rpc', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--wallet', W.address,
    '--ruleset-hash', LOCAL_PLAY_RULESET_HASH, '--prepare-bin', '/abs/prepare', '--cu-limit', '1000000', '--loaded-limit', '1048576'];
  const FILE = '/operator/run/conquest-capability.json';
  const plain = parseArgs(base), both = parseArgs([...base, '--conquest-bin', BIN, '--conquest-capability', FILE]);
  assert.equal(plain.conquestCapability, null); assert.equal(both.conquestCapability, FILE); assert.equal(both.conquestBin, BIN);
  assert.deepEqual(both.cfg, plain.cfg, 'the relay\'s own closed configuration is the same: the path is kept apart from it');
  assert.equal(parseArgs([...base, '--conquest-bin', BIN]).conquestCapability, null);
  // without the route, a relative path, twice, or no value: refused, not ignored
  assert.throws(() => parseArgs([...base, '--conquest-capability', FILE]), /needs --conquest-bin/);
  assert.throws(() => parseArgs([...base, '--conquest-bin', BIN, '--conquest-capability', 'run/capability.json']), /absolute path/);
  assert.throws(() => parseArgs([...base, '--conquest-bin', BIN, '--conquest-capability', FILE, '--conquest-capability', FILE]), /bad argument/);
  assert.throws(() => parseArgs([...base, '--conquest-bin', BIN, '--conquest-capability']), /bad argument/);
  // the file: read once, bounded, a JSON object; nothing of the path or the content is in an error
  const reads = [], reader = bytes => file => { reads.push(file); if (bytes instanceof Error) throw bytes; return bytes; };
  assert.deepEqual(readConquestCapability(FILE, reader(Buffer.from(JSON.stringify(CAPABILITY)))), CAPABILITY); assert.deepEqual(reads, [FILE]);
  for (const [bytes, why] of [[new Error('ENOENT /secret/path'), /cannot be read/], [Buffer.alloc(0), /small JSON file/], [Buffer.alloc(CONQUEST_CAPABILITY_MAX_BYTES + 1, 0x20), /small JSON file/],
    [Buffer.from('{'), /not JSON/], [Buffer.from('[]'), /JSON object/], [Buffer.from('null'), /JSON object/], [Buffer.from('"x"'), /JSON object/]]) {
    assert.throws(() => readConquestCapability(FILE, reader(bytes)), e => why.test(e.message) && !e.message.includes('secret') && !e.message.includes(FILE));
  }
  for (const file of ['relative.json', '', null, undefined, 7]) assert.throws(() => readConquestCapability(file, reader(Buffer.from('{}'))), /absolute path/);
  // what was read is still held to this relay's pins and to the opening conditions: a perfect file opens nothing today
  const read = readConquestCapability(FILE, reader(Buffer.from(JSON.stringify(CAPABILITY))));
  assert.deepEqual(conquestCapabilityProblems(read, both.cfg), []);
  assert.throws(() => createLocalPlayConquest({ cfg: both.cfg, conquestBin: both.conquestBin, capability: read }), /closed \(not established: heapConfirmed, pageBinding\)/);
  assert.throws(() => createLocalPlayConquest({ cfg: both.cfg, conquestBin: both.conquestBin, capability: { ...read, season: A(0x34) } }), /closed/);
});

import { conquestFromArgs, readBounded } from '../src/frontier/local-play-relay-server.mjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

test('a request outside the relay\'s scope is refused BEFORE the runner is read for it: another wallet, payer, cluster, program, Season, version or ruleset costs no read', async () => {
  const other = A(0x33), season2 = seasonPda(other, 11)[0];
  for (const [over, why] of [[{ wallet: OTHER.address, payer: OTHER.address }, 'another wallet'], [{ payer: OTHER.address }, 'another payer'], [{ payer: null }, 'no payer'], [{ cluster: 'devnet' }, 'another cluster'],
    [{ deployment: { program_version: '16388', ruleset_hash: LOCAL_PLAY_RULESET_HASH } }, 'another version'], [{ deployment: { program_version: '18436', ruleset_hash: 'ab'.repeat(32) } }, 'another ruleset'],
    [{ program: other }, 'another program'], [{ season: season2 }, 'another Season']]) {
    const h = harness({ capability: CAPABILITY, account: account(provinceBytes(CITY)) });
    await refused(h.conquest.prepare(request(over)), 'LocalPlayScopeMismatch');
    assert.equal(h.reads().length, 0, `${why}: no read`); assert.equal(h.calls.length, 0, `${why}: no spawn`); assert.equal(h.rpcCalls.length, 0, `${why}: the runner was not asked anything`);
  }
  // in scope, the right city: exactly one read, then the CLI (unchanged)
  const h = harness({ capability: CAPABILITY, account: account(provinceBytes(CITY)) });
  assert.equal((await h.conquest.prepare(request())).report.status, 'prepared'); assert.equal(h.reads().length, 1); assert.equal(h.calls.length, 1);
});

test('the capability file is read through one descriptor and no further than the bound, whatever its size; only a regular file is read', () => {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'wylls-conquest-capability-'));
  try {
    const put = (name, bytes) => { const f = nodePath.join(dir, name); writeFileSync(f, bytes); return f; };
    const good = put('capability.json', JSON.stringify(CAPABILITY));
    assert.deepEqual(readConquestCapability(good), CAPABILITY, 'the default reader');
    // exactly at the bound: read whole; one byte over: refused; far over: refused, and no more than bound + 1 bytes were ever taken
    const pad = n => Buffer.from(JSON.stringify({ pad: 'x'.repeat(n - 10) }));
    const exact = put('exact.json', pad(CONQUEST_CAPABILITY_MAX_BYTES)); assert.equal(readBounded(exact, CONQUEST_CAPABILITY_MAX_BYTES).length, CONQUEST_CAPABILITY_MAX_BYTES);
    assert.equal(typeof readConquestCapability(exact).pad, 'string');
    const over = put('over.json', pad(CONQUEST_CAPABILITY_MAX_BYTES + 1)); assert.throws(() => readConquestCapability(over), /small JSON file/);
    const huge = put('huge.json', Buffer.alloc(1024 * 1024, 0x20));
    assert.equal(readBounded(huge, CONQUEST_CAPABILITY_MAX_BYTES).length, CONQUEST_CAPABILITY_MAX_BYTES + 1, 'the read stops at the bound');
    assert.throws(() => readConquestCapability(huge), /small JSON file/);
    assert.equal(readBounded(put('empty.json', ''), CONQUEST_CAPABILITY_MAX_BYTES).length, 0); assert.throws(() => readConquestCapability(nodePath.join(dir, 'empty.json')), /small JSON file/);
    // not a regular file, or not there
    const sub = nodePath.join(dir, 'a-directory'); mkdirSync(sub);
    assert.throws(() => readBounded(sub, CONQUEST_CAPABILITY_MAX_BYTES)); assert.throws(() => readConquestCapability(sub), e => /cannot be read/.test(e.message) && !e.message.includes(dir));
    assert.throws(() => readConquestCapability(nodePath.join(dir, 'missing.json')), e => /cannot be read/.test(e.message) && !e.message.includes(dir));
    // the reader is told the bound it must keep
    const asked = []; readConquestCapability(good, (file, limit) => { asked.push([file, limit]); return Buffer.from(JSON.stringify(CAPABILITY)); });
    assert.deepEqual(asked, [[good, CONQUEST_CAPABILITY_MAX_BYTES]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server wiring from the parsed command line: fail closed on every missing, malformed, foreign or half-given input; the constants stay false', () => {
  const base = ['--local-play', '--listen-port', '41966', '--rpc', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--wallet', W.address,
    '--ruleset-hash', LOCAL_PLAY_RULESET_HASH, '--prepare-bin', '/abs/prepare', '--cu-limit', '1000000', '--loaded-limit', '1048576'];
  const FILE = '/operator/run/conquest-capability.json', file = value => () => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const never = () => { throw new Error('the file must not be read'); };
  // no route asked for: none is built, nothing is read
  assert.equal(conquestFromArgs(parseArgs(base), { read: never }), null);
  // only one of the two flags
  assert.throws(() => parseArgs([...base, '--conquest-capability', FILE]), /needs --conquest-bin/);
  assert.throws(() => conquestFromArgs({ cfg: parseArgs(base).cfg, conquestBin: null, conquestCapability: FILE }, { read: never }), /needs --conquest-bin/);
  // the route without a capability: closed, and nothing is read
  const binOnly = parseArgs([...base, '--conquest-bin', BIN]);
  assert.throws(() => conquestFromArgs(binOnly, { read: never }), /closed \(not established: heapConfirmed, pageBinding\)/);
  // both flags: the file is read once and handed on with the relay's own configuration and the binary, nothing else
  const both = parseArgs([...base, '--conquest-bin', BIN, '--conquest-capability', FILE]);
  const handed = []; let reads = 0;
  const made = conquestFromArgs(both, { read: (f, limit) => { reads++; assert.equal(f, FILE); assert.equal(limit, CONQUEST_CAPABILITY_MAX_BYTES); return Buffer.from(JSON.stringify(CAPABILITY)); }, create: x => { handed.push(x); return 'routes'; } });
  assert.equal(made, 'routes'); assert.equal(reads, 1); assert.deepEqual(handed, [{ cfg: both.cfg, conquestBin: BIN, capability: CAPABILITY }]);
  // with the real constructor a perfect capability still opens nothing
  assert.throws(() => conquestFromArgs(both, { read: file(CAPABILITY) }), /closed \(not established: heapConfirmed, pageBinding\)/);
  assert.deepEqual(CONQUEST_OPEN_CONDITIONS, { dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
  // missing, unreadable, empty, oversized, not JSON, not an object: the start fails, the constructor is never reached
  const reach = { create: () => { throw new Error('the constructor must not be reached'); } };
  for (const [read, why] of [[() => { throw new Error('ENOENT'); }, /cannot be read/], [file(''), /small JSON file/], [() => Buffer.alloc(CONQUEST_CAPABILITY_MAX_BYTES + 1, 0x20), /small JSON file/],
    [file('{'), /not JSON/], [file('[]'), /JSON object/], [file('null'), /JSON object/]]) {
    assert.throws(() => conquestFromArgs(both, { read, ...reach }), why);
  }
  // well formed but not this relay's world, or not a capability at all: refused by the constructor's own check, whatever the constants are
  const strict = x => createLocalPlayConquest({ ...x, dispatch: TEST_DISPATCH });   // (a build with the conditions set aside: only the capability check is left to refuse)
  for (const [value, why] of [[{ ...CAPABILITY, season: A(0x34) }, 'another Season'], [{ ...CAPABILITY, program: A(0x33) }, 'another program'], [{ ...CAPABILITY, rpc: 'http://127.0.0.1:41965' }, 'another runner'],
    [{ ...CAPABILITY, markers: ['PSF_LOCALNET_EXPEDITION_SBF_BUILD'] }, 'one marker'], [{ ...CAPABILITY, world_preset: 'S1_LOCAL_7D' }, 'another preset'], [{}, 'an empty object'],
    [{ schema: 'frontier-local-play-conquest-world-v1', program: LOCAL_PLAY_PROGRAM, season: SEASON, world_preset: CONQUEST_WORLD_PRESET, free_city: CAPABILITY.free_city }, 'the page\'s world statement, not a capability'],
    [{ ...CAPABILITY, signature: 'ab'.repeat(64) }, 'an extra key']]) {
    assert.throws(() => conquestFromArgs(both, { read: file(value), create: strict }), /closed \(world capability/, why);
  }
  assert.doesNotThrow(() => conquestFromArgs(both, { read: file(CAPABILITY), create: strict }), 'and this relay\'s own capability passes that check');
});
