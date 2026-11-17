// The dedicated local-play relay's resident routes (src/frontier/local-play-resident.mjs): the return's two
// player-signed steps (Dissolve, Return) through the existing preparation adapter and the Depart relay's own
// submit/status machinery. A KEY-USING test (scripts/ci/node-key-tests.txt): the wallet is an in-memory test Ed25519
// key (never printed or stored) that signs the prepared message. The CLI child and the runner's JSON-RPC are
// injected stubs: nothing is spawned, nothing is sent anywhere, no network beyond a loopback listener.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { encode } from '../client/src/base58.mjs';
import { seasonPda, withSeed, seedOf } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { syntheticPreparation } from '../screens/codex/prepare-observation.mjs';
import { canonicalResidentProposal, PREPARE_REQUEST_SCHEMA, PREPARE_TIMEOUT_MS, EXPEDITION_PREPARE_ROUTE } from '../src/frontier/expedition-prepare.mjs';
import { createLocalPlayRelay, LocalPlayError, LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH, ROUTES, SUBMIT_SCHEMA, STATUS_SCHEMA, singleSigned } from '../src/frontier/local-play-relay.mjs';
import { createLocalPlayResident, ExpeditionPrepareError, RESIDENT_ROUTES, RESIDENT_SUBMIT_SCHEMA, RESIDENT_STATUS_SCHEMA } from '../src/frontier/local-play-resident.mjs';
import { serveLocalPlayRelay, parseArgs } from '../src/frontier/local-play-relay-server.mjs';

const key = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { address: encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), privateKey };
};
const W = key(), OTHER = key();
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], BIN = '/operator/bin/frontier-experimental-expedition-prepare';
// (the synthetic preparation's budgets are 200000 CU and 65536 loaded bytes: the relay's own limits here)
const cfg = (over = {}) => ({ localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address,
  rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/nonexistent/frontier-experimental-expedition-depart-prepare', cuLimit: '200000', loadedLimit: '65536', ...over });
const source = (over = {}) => ({ schema: 'frontier-original-expedition-request-v1', operation: 'inspect', cluster: 'localnet', program: LOCAL_PLAY_PROGRAM, season: SEASON,
  deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH },
  host: canonicalOriginalHostRef({ world: worldIdOf(SEASON, LOCAL_PLAY_PROGRAM), p: '128', q: '0', site: 1, gen: 2, seq: 0 }),
  original_owner: withSeed(SEASON, seedOf('Citizen', { wallet: W.address }), LOCAL_PLAY_PROGRAM), standing: { p: '129', q: '0' }, min_slot: '80', wallet: W.address, payer: W.address, ...over });
let ids = 0;
function request(action = 'Dissolve', over = {}) {
  const s = source(over);
  // (a scope the canonical roles cannot be built for still carries a well-formed proposal: the scope is what is refused)
  let proposal; try { proposal = canonicalResidentProposal(s, action); } catch { proposal = canonicalResidentProposal(source(), action); }
  return { schema: PREPARE_REQUEST_SCHEMA, request_id: `lp_${++ids}`, action, source_request: s, source_context_slot: '80', source_snapshot_digest: 'ab'.repeat(32), proposal };
}
/** The resident routes with a stub child (the real adapter, its real report validation) and a stub runner. */
function harness({ send = null, height = 120, status = () => ({ slot: 9, confirmationStatus: 'confirmed', err: null }) } = {}) {
  const calls = [], children = [], rpcCalls = [];
  const resident = createLocalPlayResident({ cfg: cfg(), residentBin: BIN,
    setTimer: (fn, ms) => ({ fn, ms }), clearTimer: () => {},
    spawn: (bin, args, options) => {
      calls.push({ bin, args, options }); const c = new EventEmitter();
      c.stdin = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin.end = payload => { c.input = payload; queueMicrotask(() => c.auto?.(JSON.parse(payload))); };
      c.kill = signal => { c.killed = signal; return true; };
      c.report = (v, code = v.status === 'prepared' ? 0 : 2) => { c.stdout.emit('data', Buffer.from(JSON.stringify(v))); c.emit('close', code, null); };
      c.auto = h.auto ? r => c.report(h.auto(r)) : null;
      children.push(c); return c;
    },
    rpc: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === 'getBlockHeight') return { result: typeof height === 'function' ? height() : height };
      if (method === 'sendTransaction') return send ? send(params) : { result: encode(singleSigned(Buffer.from(params[0], 'base64')).signature) };
      if (method === 'getSignatureStatuses') { const s = status(params[0][0]); return { result: { context: { slot: 130 }, value: [s] } }; }
      return { error: { code: -1 } };
    } });
  const h = { resident, calls, children, rpcCalls, auto: r => syntheticPreparation(r), sends: () => rpcCalls.filter(x => x.method === 'sendTransaction').length };
  return h;
}
const wire = (report, signers = [W]) => { const message = Buffer.from(report.prepared.message_b64, 'base64'); return Buffer.concat([Buffer.from([signers.length]), ...signers.map(s => sign(null, message, s.privateKey)), message]).toString('base64'); };
const refused = (p, want) => assert.rejects(p, e => e instanceof LocalPlayError && e.code === want);

for (const action of ['Dissolve', 'Return']) test(`${action}: the existing preparation under the relay's pins, then the exact message signed once by the wallet, sent once; status answers`, async () => {
  const h = harness(), r = request(action);
  const { report, submit } = await h.resident.prepare(r);
  // the existing one-shot preparation, with the relay's own runner, wallet-as-payer and limits; no shell, no environment
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].bin, BIN);
  assert.deepEqual(h.calls[0].args, ['--rpc-url', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--fee-payer', W.address,
    '--ruleset-hash', LOCAL_PLAY_RULESET_HASH, '--cu-limit', '200000', '--loaded-limit', '65536']);
  assert.deepEqual(h.calls[0].options, { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  assert.deepEqual(JSON.parse(h.children[0].input), r);
  // the adapter's whole validated report; one signer (the wallet pays and acts); one fixed 256 KiB heap frame
  assert.equal(report.status, 'prepared'); assert.equal(report.prepared.action, action); assert.deepEqual(report.prepared.signers, [W.address]); assert.equal(report.prepared.fee_payer, W.address);
  assert.equal(report.prepared.budget.heap, 256 * 1024); assert.equal(report.signed, false); assert.equal(report.automatic_send, false);
  assert.deepEqual(submit, { route: RESIDENT_ROUTES.submit, schema: RESIDENT_SUBMIT_SCHEMA, message_digest: report.prepared.message_digest, last_valid_block_height: '250', signer: W.address });
  assert.equal(h.sends(), 0, 'preparing sends nothing');
  // submit: exactly that message, signed by the wallet
  const tx = wire(report), body = { schema: RESIDENT_SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: tx };
  const sent = await h.resident.submit(body);
  assert.equal(sent.status, 'submitted'); assert.equal(sent.status_route, RESIDENT_ROUTES.status); assert.equal(h.sends(), 1);
  assert.deepEqual(h.rpcCalls.find(x => x.method === 'sendTransaction').params, [tx, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  // once: the same message again is refused, also after being prepared again
  await refused(h.resident.submit(body), 'LocalPlayMessageUsed');
  h.auto = () => report; await refused(h.resident.prepare(r), 'LocalPlayMessageUsed');
  assert.equal(h.sends(), 1);
  assert.deepEqual(await h.resident.status({ schema: RESIDENT_STATUS_SCHEMA, signature: sent.signature }), { signature: sent.signature, status: 'confirmed', err: null, slot: 9, context_slot: 130 });
  await refused(h.resident.status({ schema: RESIDENT_STATUS_SCHEMA, signature: encode(new Uint8Array(64).fill(3)) }), 'LocalPlayUnknownSignature');
});

test('another wallet, payer, cluster, program, Season, version or ruleset is refused before anything is spawned; a blocked preparation has no submit note', async () => {
  const h = harness(), other = encode(new Uint8Array(32).fill(0x33)), season2 = seasonPda(other, 11)[0];
  for (const over of [{ wallet: OTHER.address }, { payer: OTHER.address }, { payer: null }, { wallet: null }, { cluster: 'devnet' }, { cluster: 'mainnet-beta' },
    { deployment: { program_version: '16388', ruleset_hash: LOCAL_PLAY_RULESET_HASH } }, { deployment: { program_version: '18436', ruleset_hash: 'ab'.repeat(32) } },
    { program: other, season: season2, host: canonicalOriginalHostRef({ world: worldIdOf(season2, other), p: '128', q: '0', site: 1, gen: 2, seq: 0 }), original_owner: withSeed(season2, seedOf('Citizen', { wallet: W.address }), other) }]) {
    await refused(h.resident.prepare(request('Dissolve', over)), 'LocalPlayScopeMismatch');
  }
  for (const body of [null, [], 'x', {}, { source_request: null }, { source_request: 'x' }]) await refused(h.resident.prepare(body), 'LocalPlayInvalidRequest');
  // the adapter's own canonical request check stays (its own error): an action that is not one of the two, a foreign proposal, a raw draft
  for (const change of [r => { r.action = 'Depart'; }, r => { r.proposal.bytes_hex = '00' + r.proposal.bytes_hex.slice(2); }, r => { r.proposal.roles[0].writable = !r.proposal.roles[0].writable; }, r => { r.transaction_b64 = 'AA=='; }]) {
    const r = request('Return'); change(r);
    await assert.rejects(h.resident.prepare(r), e => e instanceof ExpeditionPrepareError && e.code === 'ExpeditionPrepareInvalidRequest');
  }
  assert.equal(h.calls.length, 0, 'nothing was spawned for any of them');
  // blocked: the report as it is, no submit note, no ticket
  const r = request('Return');
  h.auto = q => ({ ...syntheticPreparation(q), status: 'blocked', blockhash: null, prepared: null, blocker: { code: 'SourceBlocked' } });
  assert.deepEqual((await h.resident.prepare(r)).submit, null); assert.equal(h.resident.stats().open, 0);
  // a report whose message is not this request's is the adapter's refusal, never a ticket
  h.auto = q => { const v = syntheticPreparation(q); v.prepared.message_digest = '00'.repeat(32); return v; };
  await assert.rejects(h.resident.prepare(request('Return')), e => e instanceof ExpeditionPrepareError && e.code === 'ExpeditionPrepareInvalidReport');
  assert.equal(h.resident.stats().open, 0); assert.equal(h.sends(), 0);
  // the pins and the path are fixed at construction
  for (const residentBin of ['relative/bin', undefined, null, '', 7]) assert.throws(() => createLocalPlayResident({ cfg: cfg(), residentBin }), /local-play resident/, String(residentBin));
  for (const over of [{ localPlay: false }, { rpc: 'http://127.0.0.1:8899' }, { program: other }, { rulesetHash: '00'.repeat(32) }, { residentBin: BIN }]) assert.throws(() => createLocalPlayResident({ cfg: cfg(over), residentBin: BIN }), /local-play resident/, JSON.stringify(over));
});

test('only the pinned wallet\'s single signature over the exact prepared message is sent; an unknown outcome is never resent', async () => {
  const h = harness(), r = request('Dissolve'), { report, submit } = await h.resident.prepare(r);
  const body = tx => ({ schema: RESIDENT_SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: tx });
  const message = Buffer.from(report.prepared.message_b64, 'base64'), other = Buffer.from(message); other[other.length - 1] ^= 1;
  await refused(h.resident.submit(body(wire(report, [OTHER]))), 'LocalPlayBadSignature');
  await refused(h.resident.submit(body(wire(report, [W, OTHER]))), 'LocalPlayBadTransaction');
  await refused(h.resident.submit(body(Buffer.concat([Buffer.from([1]), sign(null, other, W.privateKey), other]).toString('base64'))), 'LocalPlayBadTransaction');
  await refused(h.resident.submit({ ...body(wire(report)), message_digest: 'ab'.repeat(32) }), 'LocalPlayUnknownMessage');
  // the Depart schema is not this flow's, nor is an extra field
  await refused(h.resident.submit({ ...body(wire(report)), schema: SUBMIT_SCHEMA }), 'LocalPlayInvalidRequest');
  await refused(h.resident.submit({ ...body(wire(report)), again: true }), 'LocalPlayInvalidRequest');
  await refused(h.resident.status({ schema: STATUS_SCHEMA, signature: 'x' }), 'LocalPlayInvalidRequest');
  assert.equal(h.sends(), 0, 'none of them reached the runner');
  // past its last valid block height: consumed, unsent
  const late = harness({ height: 251 }), l = await late.resident.prepare(request('Return'));
  await refused(late.resident.submit({ schema: RESIDENT_SUBMIT_SCHEMA, message_digest: l.submit.message_digest, transaction_b64: wire(l.report) }), 'LocalPlayMessageExpired');
  assert.equal(late.sends(), 0);
  // a send whose answer never comes: unknown; the same transaction again is refused, the signature is answered by status
  const lost = harness({ send: () => { throw new Error('socket'); }, status: () => null }), p = await lost.resident.prepare(request('Return'));
  const b = { schema: RESIDENT_SUBMIT_SCHEMA, message_digest: p.submit.message_digest, transaction_b64: wire(p.report) };
  const u = await lost.resident.submit(b);
  assert.equal(u.status, 'unknown'); assert.equal(lost.sends(), 1);
  await refused(lost.resident.submit(b), 'LocalPlayMessageUsed'); assert.equal(lost.sends(), 1);
  { const st = await lost.resident.status({ schema: RESIDENT_STATUS_SCHEMA, signature: u.signature });
    assert.deepEqual([st.signature, st.status, st.context_slot, typeof st.last_valid_block_height], [u.signature, 'pending', 130, 'string'], 'not found: pending, with the slot it was read at; nothing settles without a pinned runner'); }
  // a runner refusal is reported with the signature and consumes the message
  const no = harness({ send: () => ({ error: { code: -32002, message: 'simulation failed' } }) }), q = await no.resident.prepare(request('Dissolve'));
  const nb = { schema: RESIDENT_SUBMIT_SCHEMA, message_digest: q.submit.message_digest, transaction_b64: wire(q.report) };
  await refused(no.resident.submit(nb), 'LocalPlaySendRefused'); await refused(no.resident.submit(nb), 'LocalPlayMessageUsed'); assert.equal(no.sends(), 1);
});

test('the resident flow and the Depart relay keep apart: their own routes, schemas and replay barriers; a malformed flow is refused', async () => {
  const h = harness(), r = request('Return'), { report, submit } = await h.resident.prepare(r);
  const depart = createLocalPlayRelay({ cfg: cfg(), prepare: { prepare: async () => { throw new Error('never'); }, close() {} }, rpc: async () => ({ result: 1 }) });
  // a resident message is unknown to the Depart relay, whatever schema it is offered under
  await refused(depart.submit({ schema: SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: wire(report) }), 'LocalPlayUnknownMessage');
  await refused(depart.submit({ schema: RESIDENT_SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: wire(report) }), 'LocalPlayInvalidRequest');
  assert.deepEqual(depart.info().routes, ROUTES, 'the Depart relay names only its own routes');
  for (const route of Object.values(RESIDENT_ROUTES)) assert.ok(!Object.values(ROUTES).includes(route) && route !== EXPEDITION_PREPARE_ROUTE);
  const adapter = { prepare: async () => ({}), close() {} }, good = { routes: RESIDENT_ROUTES, submitSchema: RESIDENT_SUBMIT_SCHEMA, statusSchema: RESIDENT_STATUS_SCHEMA, scopeOf: b => b.source_request };
  for (const flow of [{ ...good, routes: ROUTES }, { ...good, submitSchema: SUBMIT_SCHEMA }, { ...good, statusSchema: STATUS_SCHEMA }, { ...good, scopeOf: null }, { ...good, extra: 1 }, { routes: RESIDENT_ROUTES }, {}]) {
    assert.throws(() => createLocalPlayRelay({ cfg: cfg(), prepare: adapter, flow }), /bad flow/);
  }
  assert.throws(() => createLocalPlayRelay({ cfg: cfg(), flow: good }), /bad flow/, 'a flow has no default adapter');
});

test('over HTTP: served only when given; prepare, submit and status dispatch; refusals keep their own codes; the listener closes it; the command line', async () => {
  const depart = () => createLocalPlayRelay({ cfg: cfg(), prepare: { prepare: async () => ({ status: 'blocked', blocker: { code: 'X' } }), close() {} }, rpc: async () => ({ error: { code: -1 } }) });
  const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const bare = await serveLocalPlayRelay(depart(), 0);
  try { for (const p of ['prepare', 'submit', 'status']) assert.equal((await post(bare.port, `/f/local-play/resident/${p}`, {})).status, 404); } finally { await bare.close(); }
  const h = harness(), s = await serveLocalPlayRelay(depart(), 0, { resident: h.resident });
  try {
    const r = request('Dissolve'), res = await post(s.port, '/f/local-play/resident/prepare', r);
    assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
    const { report, submit } = await res.json();
    assert.equal(report.status, 'prepared'); assert.equal(submit.route, 'POST /f/local-play/resident/submit');
    const sent = await (await post(s.port, '/f/local-play/resident/submit', { schema: RESIDENT_SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: wire(report) })).json();
    assert.equal(sent.status, 'submitted');
    const st = await (await post(s.port, '/f/local-play/resident/status', { schema: RESIDENT_STATUS_SCHEMA, signature: sent.signature })).json();
    assert.equal(st.status, 'confirmed');
    for (const [path, body, status, code] of [['prepare', request('Dissolve', { wallet: OTHER.address }), 409, 'LocalPlayScopeMismatch'], ['prepare', { ...request('Return'), action: 'Depart' }, 400, 'ExpeditionPrepareInvalidRequest'],
      ['submit', { schema: RESIDENT_SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: wire(report) }, 409, 'LocalPlayMessageUsed'], ['submit', { schema: SUBMIT_SCHEMA, message_digest: submit.message_digest, transaction_b64: wire(report) }, 400, 'LocalPlayInvalidRequest'],
      ['status', { schema: RESIDENT_STATUS_SCHEMA, signature: encode(new Uint8Array(64).fill(5)) }, 404, 'LocalPlayUnknownSignature'], ['prepare', '{', 400, 'InvalidJson']]) {
      const bad = await post(s.port, `/f/local-play/resident/${path}`, body), answer = await bad.json();
      assert.equal(bad.status, status, code); assert.equal(answer.code, code); assert.ok(!JSON.stringify(answer).includes(BIN));
    }
    assert.equal(h.sends(), 1);
    // the general gateway's unsigned-review route is not this relay's
    assert.equal((await post(s.port, '/f/expedition/prepare', r)).status, 404);
    // the Depart routes are as they were
    const info = await (await fetch(`http://127.0.0.1:${s.port}/f/local-play/info`)).json();
    assert.deepEqual(info.routes, ROUTES);
  } finally { await s.close(); }
  await assert.rejects(h.resident.prepare(request('Return')), e => e instanceof ExpeditionPrepareError && e.code === 'ExpeditionPrepareUnavailable', 'closing the listener closed the adapter');
  // the command line: --resident-bin is optional, once, apart from the relay's closed configuration
  const base = ['--local-play', '--listen-port', '41966', '--rpc', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--wallet', W.address,
    '--ruleset-hash', LOCAL_PLAY_RULESET_HASH, '--prepare-bin', '/abs/prepare', '--cu-limit', '1000000', '--loaded-limit', '1048576'];
  const plain = parseArgs(base), withBin = parseArgs([...base, '--resident-bin', BIN, '--preview-bin', '/abs/preview']);
  assert.equal(plain.residentBin, null); assert.equal(withBin.residentBin, BIN); assert.equal(withBin.previewBin, '/abs/preview'); assert.deepEqual(withBin.cfg, plain.cfg);
  assert.throws(() => parseArgs([...base, '--resident-bin', BIN, '--resident-bin', BIN]), /bad argument/);
  assert.throws(() => parseArgs([...base, '--resident-bin']), /bad argument/);
  assert.equal(PREPARE_TIMEOUT_MS, 30_000);
});
