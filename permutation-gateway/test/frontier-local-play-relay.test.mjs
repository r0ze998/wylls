// The local-play relay (src/frontier/local-play-relay*.mjs): pins, the
// prepare → submit → status flow and its refusals. The wallet is an in-memory
// test Ed25519 key (never printed or stored); the CLI adapter and the runner's
// JSON-RPC are injected stubs, so nothing is spawned or sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { encode } from '../client/src/base58.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import http from 'node:http';
import {
  createLocalPlayRelay, localPlayRelayConfigProblems, localPlayPort, singleSigned, fetchRpc, LocalPlayError,
  LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH, SUBMIT_SCHEMA, STATUS_SCHEMA, OPEN_TTL_MS, MAX_HISTORY,
} from '../src/frontier/local-play-relay.mjs';
import { serveLocalPlayRelay, parseArgs } from '../src/frontier/local-play-relay-server.mjs';

const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0];
const key = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { address: encode(raw), privateKey };
};
const W = key(), OTHER = key();
const cfg = (over = {}) => ({ localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address,
  rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/nonexistent/frontier-experimental-expedition-depart-prepare', cuLimit: '1000000', loadedLimit: '1048576', ...over });
const MESSAGE = Buffer.concat([Buffer.from([1, 0, 0]), Buffer.alloc(200, 7)]); // opaque bytes for the stub report
const DIGEST = createHash('sha256').update(MESSAGE).digest('hex');
const request = (over = {}) => ({ cluster: 'localnet', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address, payer: W.address,
  deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH }, ...over });
const prepared = (over = {}) => ({ status: 'prepared', blockhash: { last_valid_block_height: '100' },
  prepared: { fee_payer: W.address, signers: [W.address], message_b64: MESSAGE.toString('base64'), message_digest: DIGEST, ...over } });
function harness({ report = prepared(), height = 50, send = null, heightDelay = 0, clock = { t: 0 }, prepareDelay = 0 } = {}) {
  const calls = { prepare: 0, rpc: [] };
  const relay = createLocalPlayRelay({
    cfg: cfg(),
    now: () => clock.t,
    prepare: { prepare: async () => { calls.prepare++; if (prepareDelay) await new Promise(r => setTimeout(r, prepareDelay)); return typeof report === 'function' ? report() : report; }, close() {} },
    rpc: async (method, params) => {
      calls.rpc.push(method);
      if (method === 'getBlockHeight') { if (heightDelay) await new Promise(r => setTimeout(r, heightDelay)); return { result: typeof height === 'function' ? height() : height }; }
      if (method === 'sendTransaction') return send ? send(params) : { result: encode(singleSigned(Buffer.from(params[0], 'base64')).signature) };
      // (as the runner answers: a context slot with the value — the relay takes a status only from the well-formed answer)
      if (method === 'getSignatureStatuses') return { result: { context: { slot: 130 }, value: [{ slot: 9, confirmationStatus: 'confirmed', err: null }] } };
      return { error: { code: -1 } };
    },
  });
  return { relay, calls };
}
const wire = (message, signers = [W]) => Buffer.concat([Buffer.from([signers.length]), ...signers.map(s => sign(null, message, s.privateKey)), message]).toString('base64');
const code = async (p, want) => assert.rejects(p, e => e instanceof LocalPlayError && e.code === want);

test('only the exact local-play pins configure a relay', () => {
  assert.deepEqual(localPlayRelayConfigProblems(cfg()), []);
  assert.equal(localPlayPort('http://127.0.0.1:41964'), 41964);
  for (const url of ['http://127.0.0.1:41970', 'http://127.0.0.1:8899', 'https://127.0.0.1:41964', 'http://localhost:41964',
    'http://127.0.0.1:41964/', 'http://user@127.0.0.1:41964', 'http://127.0.0.1:041964', 'http://0.0.0.0:41964']) {
    assert.equal(localPlayPort(url), null, url);
  }
  for (const [k, v] of [['localPlay', false], ['localPlay', 'true'], ['rpc', 'http://127.0.0.1:41970'], ['program', encode(new Uint8Array(32).fill(0x12))],
    ['season', encode(new Uint8Array(32).fill(3))], ['wallet', LOCAL_PLAY_PROGRAM], ['wallet', 'x'], ['rulesetHash', '00'.repeat(32)], ['prepareBin', 'relative/bin']]) {
    assert.notDeepEqual(localPlayRelayConfigProblems(cfg({ [k]: v })), [], `${k}=${v}`);
    assert.throws(() => createLocalPlayRelay({ cfg: cfg({ [k]: v }), prepare: { prepare() {} } }), `${k}`);
  }
  assert.notDeepEqual(localPlayRelayConfigProblems({ ...cfg(), extra: 1 }), []);
});

test('prepare passes only the local-play wallet-as-payer scope to the existing preparation', async () => {
  const { relay, calls } = harness();
  for (const over of [{ payer: OTHER.address }, { wallet: OTHER.address }, { program: encode(new Uint8Array(32).fill(0x12)) },
    { season: encode(new Uint8Array(32).fill(3)) }, { cluster: 'devnet' }, { deployment: { program_version: '18432', ruleset_hash: LOCAL_PLAY_RULESET_HASH } },
    { deployment: { program_version: '18436', ruleset_hash: '00'.repeat(32) } }]) {
    await code(relay.prepare(request(over)), 'LocalPlayScopeMismatch');
  }
  assert.equal(calls.prepare, 0, 'refused before the CLI');
  const out = await relay.prepare(request());
  assert.equal(out.report.status, 'prepared');
  assert.deepEqual(out.submit, { route: 'POST /f/local-play/depart/submit', schema: SUBMIT_SCHEMA, message_digest: DIGEST, last_valid_block_height: '100', signer: W.address });
  // a report naming another payer or a second signer is refused
  await code(harness({ report: prepared({ signers: [W.address, OTHER.address] }) }).relay.prepare(request()), 'LocalPlayScopeMismatch');
  // a blocked report is returned as is, nothing to submit
  const blocked = await harness({ report: { status: 'blocked', blocker: { code: 'TipTooLow' } } }).relay.prepare(request());
  assert.equal(blocked.submit, null);
});

test('submit sends exactly the prepared message signed once by the wallet, once', async () => {
  const { relay, calls } = harness();
  await relay.prepare(request());
  const body = { schema: SUBMIT_SCHEMA, message_digest: DIGEST, transaction_b64: wire(MESSAGE) };
  const tampered = Buffer.from(MESSAGE); tampered[50] ^= 1;
  await code(relay.submit({ ...body, transaction_b64: wire(tampered) }), 'LocalPlayBadTransaction');
  await code(relay.submit({ ...body, transaction_b64: wire(MESSAGE, [OTHER]) }), 'LocalPlayBadSignature');
  await code(relay.submit({ ...body, transaction_b64: wire(MESSAGE, [W, W]) }), 'LocalPlayBadTransaction');
  await code(relay.submit({ ...body, message_digest: '00'.repeat(32) }), 'LocalPlayUnknownMessage');
  await code(relay.submit({ ...body, extra: 1 }), 'LocalPlayInvalidRequest');
  assert.deepEqual(calls.rpc, [], 'no RPC before a valid signed message');
  const out = await relay.submit(body);
  assert.equal(out.status, 'submitted');
  assert.deepEqual(calls.rpc, ['getBlockHeight', 'sendTransaction']);
  await code(relay.submit(body), 'LocalPlayMessageUsed');
  const st = await relay.status({ schema: STATUS_SCHEMA, signature: out.signature });
  assert.deepEqual(st, { signature: out.signature, status: 'confirmed', err: null, slot: 9, context_slot: 130 });
  await code(relay.status({ schema: STATUS_SCHEMA, signature: encode(new Uint8Array(64).fill(1)) }), 'LocalPlayUnknownSignature');
});

test('an expired message and a runner refusal are reported, never retried', async () => {
  const late = harness({ height: 101 });
  await late.relay.prepare(request());
  await code(late.relay.submit({ schema: SUBMIT_SCHEMA, message_digest: DIGEST, transaction_b64: wire(MESSAGE) }), 'LocalPlayMessageExpired');
  assert.deepEqual(late.calls.rpc, ['getBlockHeight']);
  const refused = harness({ send: () => ({ error: { code: -32002, message: 'Transaction simulation failed' } }) });
  await refused.relay.prepare(request());
  const body = { schema: SUBMIT_SCHEMA, message_digest: DIGEST, transaction_b64: wire(MESSAGE) };
  await assert.rejects(refused.relay.submit(body), e => e.code === 'LocalPlaySendRefused' && e.detail.code === -32002);
  await code(refused.relay.submit(body), 'LocalPlayMessageUsed');
  // (fix-loop11, live: the runner's preflight ran the departure and the PROGRAM refused it — NotResident as the turn rolled
  //  under the send: a definite "not taken", with the program's number; still never retried, the bytes stay used)
  const rejected = harness({ send: () => ({ error: { code: -32002, message: 'Transaction simulation failed: InstructionError(4, Custom(26))', data: { err: { InstructionError: [4, { Custom: 26 }] }, logs: [] } } }) });
  await rejected.relay.prepare(request());
  await assert.rejects(rejected.relay.submit(body), e => e.code === 'LocalPlayRejected' && e.status === 422 && e.detail.program_code === 26 && e.detail.code === -32002 && typeof e.detail.signature === 'string');
  await code(rejected.relay.submit(body), 'LocalPlayMessageUsed');
  // (AlreadyProcessed is no rejection: the signature is known — the outcome stays unknown)
  const known = harness({ send: () => ({ error: { code: -32002, message: 'Transaction simulation failed: This transaction has already been processed', data: { err: 'AlreadyProcessed' } } }) });
  await known.relay.prepare(request());
  await assert.rejects(known.relay.submit(body), e => e.code === 'LocalPlaySendRefused');
});

test('the loopback listener: info, routes, body limits; the CLI wiring and its arguments', async () => {
  const { relay } = harness();
  const s = await serveLocalPlayRelay(relay, 0);
  try {
    const url = p => `http://127.0.0.1:${s.port}${p}`;
    const info = await (await fetch(url('/f/local-play/info'))).json();
    assert.equal(info.program, LOCAL_PLAY_PROGRAM);
    assert.equal(info.wallet, W.address);
    const post = (p, body) => fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await post('/f/local-play/depart/prepare', '{')).status, 400);
    assert.equal((await post('/f/local-play/depart/prepare', 'x'.repeat(17 * 1024))).status, 413);
    assert.equal((await post('/f/local-play/nothing', '{}')).status, 404);
    const r = await post('/f/local-play/depart/prepare', JSON.stringify(request({ payer: OTHER.address })));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'LocalPlayScopeMismatch');
    const ok = await (await post('/f/local-play/depart/prepare', JSON.stringify(request()))).json();
    assert.equal(ok.submit.message_digest, DIGEST);
    // security-audit (DNS rebinding): another name in Host, or any browser Origin, is refused before a route runs;
    // the listener's own address (as the herald's /gw and the launcher's proxy send it) and localhost pass.
    const raw = headers => new Promise((resolve, reject) => {
      const q = http.request({ hostname: '127.0.0.1', port: s.port, path: '/f/local-play/info', headers }, r => { let b = ''; r.on('data', c => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
      q.on('error', reject); q.end();
    });
    for (const h of [{ host: `rebind.example:${s.port}` }, { host: `127.0.0.1:${s.port + 1}` }, { host: '127.0.0.1' }, { host: `127.0.0.1:${s.port}`, origin: 'http://rebind.example' },
      { host: `127.0.0.1:${s.port}`, origin: `http://127.0.0.1:${s.port}` }]) {
      const r = await raw(h);
      assert.equal(r.status, 403, JSON.stringify(h));
      assert.equal(JSON.parse(r.body).code, 'LocalPlayHostNotAllowed');
    }
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`]) assert.equal((await raw({ host })).status, 200, host);
  } finally {
    await s.close();
  }
  assert.throws(() => serveLocalPlayRelay(relay, 41970));
  assert.throws(() => serveLocalPlayRelay(relay, 8080));
  // the real adapter is built from the pins (an absent binary answers Unavailable, nothing else)
  const real = createLocalPlayRelay({ cfg: cfg(), rpc: async () => ({ error: {} }) });
  await assert.rejects(real.prepare(request()), e => e.code !== 'LocalPlayScopeMismatch');
  real.close();
  const args = ['--local-play', '--listen-port', '41967', '--rpc', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON,
    '--wallet', W.address, '--ruleset-hash', LOCAL_PLAY_RULESET_HASH, '--prepare-bin', '/x/bin', '--cu-limit', '1000000', '--loaded-limit', '1048576'];
  const parsed = parseArgs(args);
  assert.equal(parsed.port, 41967);
  assert.deepEqual(localPlayRelayConfigProblems({ ...parsed.cfg, prepareBin: '/x/bin' }), []);
  assert.equal(parseArgs(args.slice(1)).cfg.localPlay, false, 'without --local-play the relay is refused by its config check');
  assert.throws(() => parseArgs([...args, '--rpc', 'http://127.0.0.1:41964']));
});

const submitBody = (message = MESSAGE) => ({ schema: SUBMIT_SCHEMA, message_digest: createHash('sha256').update(message).digest('hex'), transaction_b64: wire(message) });

test('two concurrent submits of one message: exactly one is sent', async () => {
  const { relay, calls } = harness({ heightDelay: 30 });
  await relay.prepare(request());
  const results = await Promise.allSettled([relay.submit(submitBody()), relay.submit(submitBody())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'LocalPlayMessageUsed');
  assert.equal(calls.rpc.filter(m => m === 'sendTransaction').length, 1);
});

test('a failed height read gives the reservation back; a send that times out is unknown yet looked up by status', async () => {
  let fail = true;
  const relay = createLocalPlayRelay({ cfg: cfg(), prepare: { prepare: async () => prepared(), close() {} },
    rpc: async method => {
      if (method === 'getBlockHeight') { if (fail) { fail = false; throw new LocalPlayError('LocalPlayRpcUnavailable'); } return { result: 1 }; }
      if (method === 'sendTransaction') throw new LocalPlayError('LocalPlayRpcUnavailable');
      if (method === 'getSignatureStatuses') return { result: { context: { slot: 130 }, value: [null] } };
      return { error: {} };
    } });
  await relay.prepare(request());
  await code(relay.submit(submitBody()), 'LocalPlayRpcUnavailable');
  const out = await relay.submit(submitBody()); // the reservation was given back: nothing had been sent
  assert.equal(out.status, 'unknown');
  // (not found at slot 130, past the message's last valid height 100 — and STILL pending: this relay has no pinned runner instance, so an absence settles nothing)
  assert.deepEqual(await relay.status({ schema: STATUS_SCHEMA, signature: out.signature }), { signature: out.signature, status: 'pending', context_slot: 130, last_valid_block_height: '100' });
  await code(relay.submit(submitBody()), 'LocalPlayMessageUsed');
});

test('the same digest prepared again never reopens its ticket', async () => {
  const { relay } = harness();
  await relay.prepare(request());
  await relay.submit(submitBody());
  await code(relay.prepare(request()), 'LocalPlayMessageUsed');
  await code(relay.submit(submitBody()), 'LocalPlayMessageUsed');
  // an open one prepared again keeps its first ticket (and first time)
  const clock = { t: 0 };
  const h = harness({ clock });
  await h.relay.prepare(request());
  clock.t = OPEN_TTL_MS - 1;
  await h.relay.prepare(request());
  clock.t = OPEN_TTL_MS + 1;
  await code(h.relay.submit(submitBody()), 'LocalPlayMessageExpired');
  await code(h.relay.prepare(request()), 'LocalPlayMessageUsed');
});

const uniqueReports = () => {
  let n = 0;
  return () => { const m = Buffer.concat([Buffer.from([1, 0, 0]), Buffer.alloc(200, n & 0xff), Buffer.from([n >> 8, n & 0xff])]); n++;
    return prepared({ message_b64: m.toString('base64'), message_digest: createHash('sha256').update(m).digest('hex') }); };
};

test('stale open tickets close by time but stay in the replay barrier; time alone never retires a digest', async () => {
  const clock = { t: 0 };
  let h = 50; // the runner's height: paused at 50, below every last valid height (100)
  const { relay } = harness({ clock, report: uniqueReports(), height: () => h });
  for (let i = 0; i < 8; i++) await relay.prepare(request());
  await code(relay.prepare(request()), 'LocalPlayBusy');
  clock.t = OPEN_TTL_MS + 1;
  assert.ok((await relay.prepare(request())).submit, 'expired open tickets no longer count as open');
  // 8 expired tombstones + 1 new open ticket (the refused 9th never reached the CLI)
  assert.equal(relay.stats().pending, 9, 'expired tickets stay in the barrier');
  // a long wall-clock wait with the height paused retires nothing
  clock.t += 10 * 365 * 24 * 3600 * 1000;
  assert.equal(relay.stats().pending, 9);
  // the barrier fills and then refuses (fail-closed) while the height cannot prove expiry
  while (relay.stats().pending < MAX_HISTORY) { clock.t += OPEN_TTL_MS + 1; await relay.prepare(request()); }
  await code(relay.prepare(request()), 'LocalPlayBusy');
  // the chain really passes the last valid height: the barrier retires them
  h = 101;
  assert.ok((await relay.prepare(request())).submit);
  // every used/expired ticket retired; the fill loop's last ticket is still open
  // (inside its TTL, so not a tombstone) and stays, beside the new one
  assert.deepEqual(relay.stats(), { pending: 2, open: 2, preparing: 0 });
});

test('with the height paused, a used message can be neither re-prepared nor re-sent, however long and however full', async () => {
  const clock = { t: 0 };
  const sends = [];
  const relay = createLocalPlayRelay({ cfg: cfg(), now: () => clock.t,
    prepare: { prepare: async () => prepared(), close() {} },
    rpc: async (method, params) => {
      if (method === 'getBlockHeight') return { result: 50 };
      if (method === 'sendTransaction') { sends.push(params[0]); return { result: encode(singleSigned(Buffer.from(params[0], 'base64')).signature) }; }
      return { result: { context: { slot: 50 }, value: [null] } };
    } });
  await relay.prepare(request());
  const out = await relay.submit(submitBody());
  clock.t += 10 * 365 * 24 * 3600 * 1000;
  await code(relay.prepare(request()), 'LocalPlayMessageUsed');
  await code(relay.submit(submitBody()), 'LocalPlayMessageUsed');
  assert.equal((await relay.status({ schema: STATUS_SCHEMA, signature: out.signature })).status, 'pending', 'still answerable');
  assert.equal(sends.length, 1);
});

// ------------------------------------------------------------------ F2: settling an outcome that is not known
const INSTANCE = 'ab'.repeat(32), OTHER_INSTANCE = 'cd'.repeat(32);
/** A relay whose runner answers `status(sig)` (the whole JSON-RPC answer) for getSignatureStatuses; `runnerInstance` as given. */
function settling({ runnerInstance = INSTANCE, height = 50, status, send = null } = {}) {
  const sends = [], asked = [];
  const relay = createLocalPlayRelay({ cfg: cfg(), runnerInstance, prepare: { prepare: async () => prepared(), close() {} },
    rpc: async (method, params) => {
      if (method === 'getBlockHeight') return { result: typeof height === 'function' ? height() : height };
      if (method === 'sendTransaction') { sends.push(params[0]); return send ? send(params) : { result: encode(singleSigned(Buffer.from(params[0], 'base64')).signature) }; }
      if (method === 'getSignatureStatuses') { asked.push(params[0][0]); return status(params[0][0], asked.length); }
      return { error: { code: -1 } };
    } });
  return { relay, sends, asked };
}
const notFound = (slot, instance = INSTANCE) => ({ result: { context: { slot, ...(instance === null ? {} : { instance }) }, value: [null] } });
const sendOnce = async relay => { await relay.prepare(request()); return relay.submit(submitBody()); };
const ask = (relay, signature) => relay.status({ schema: STATUS_SCHEMA, signature });

test('F2 — "did not land" is settled only by the chain: the pinned runner\'s own strict not-found, past the last valid height', async () => {
  // prepared()'s last valid block height is 100; the message is sent at height 50
  let s = settling({ status: () => notFound(101) }), out = await sendOnce(s.relay);
  let st = await ask(s.relay, out.signature);
  assert.deepEqual(st, { signature: out.signature, status: 'expired_unlanded', context_slot: 101, last_valid_block_height: '100' });
  // a tombstone: the same answer again WITHOUT asking the runner; the bytes stay barred for good; nothing was resent
  const before = s.asked.length;
  assert.deepEqual(await ask(s.relay, out.signature), st); assert.equal(s.asked.length, before);
  await code(s.relay.submit(submitBody()), 'LocalPlayMessageUsed'); await code(s.relay.prepare(request()), 'LocalPlayMessageUsed');
  assert.equal(s.sends.length, 1);
  // NOT past the height (equal counts as not past): still pending, asked again each time, and settles once the chain is past it
  let slot = 100; s = settling({ status: () => notFound(slot) }); out = await sendOnce(s.relay);
  assert.equal((await ask(s.relay, out.signature)).status, 'pending'); slot = 99; assert.equal((await ask(s.relay, out.signature)).status, 'pending');
  slot = 101; assert.equal((await ask(s.relay, out.signature)).status, 'expired_unlanded');
  // found after the height: the chain's own answer, never "expired"
  s = settling({ status: () => ({ result: { context: { slot: 500, instance: INSTANCE }, value: [{ slot: 60, confirmationStatus: 'finalized', err: null }] } }) }); out = await sendOnce(s.relay);
  assert.deepEqual(await ask(s.relay, out.signature), { signature: out.signature, status: 'finalized', err: null, slot: 60, context_slot: 500 });
  s = settling({ status: () => ({ result: { context: { slot: 500, instance: INSTANCE }, value: [{ slot: 60, confirmationStatus: 'finalized', err: { InstructionError: [4, { Custom: 6001 }] } }] } }) }); out = await sendOnce(s.relay);
  assert.deepEqual([(await ask(s.relay, out.signature)).status, (await ask(s.relay, out.signature)).err], ['failed', { InstructionError: [4, { Custom: 6001 }] }]);
});

test('F2 — nothing else settles it: no pinned runner, another runner, a slot that went backwards, a malformed answer, a runner refusal', async () => {
  // NO runner instance pinned (today): a strict not-found far past the height is still pending — forever
  let s = settling({ runnerInstance: null, status: () => notFound(1_000_000, null) }), out = await sendOnce(s.relay);
  assert.equal((await ask(s.relay, out.signature)).status, 'pending');
  s = settling({ runnerInstance: null, status: () => notFound(1_000_000, INSTANCE) }); out = await sendOnce(s.relay);
  assert.equal((await ask(s.relay, out.signature)).status, 'pending', 'an id in the answer is not a pin');
  // a pinned runner, but the answer carries ANOTHER id, or none: not this chain — the runner "did not answer", found or not
  for (const instance of [OTHER_INSTANCE, null, INSTANCE.toUpperCase(), '', 7]) {
    s = settling({ status: () => ({ result: { context: { slot: 500, ...(instance === null ? {} : { instance }) }, value: [null] } }) }); out = await sendOnce(s.relay);
    await code(ask(s.relay, out.signature), 'LocalPlayRpcUnavailable');
    s = settling({ status: () => ({ result: { context: { slot: 500, ...(instance === null ? {} : { instance }) }, value: [{ slot: 60, confirmationStatus: 'finalized', err: null }] } }) }); out = await sendOnce(s.relay);
    await code(ask(s.relay, out.signature), 'LocalPlayRpcUnavailable');
  }
  // the slot went backwards (below the slot the message was sent at): another chain; here sent at 150 with a last valid height of 100 is impossible, so: sent at 50, read at 40
  s = settling({ status: () => notFound(40) }); out = await sendOnce(s.relay);
  assert.equal((await ask(s.relay, out.signature)).status, 'pending');
  // malformed answers are never a not-found: no context, no slot, a bad slot, no value, an empty or a longer array, undefined, a non-object entry
  for (const result of [{ value: [null] }, { context: {}, value: [null] }, { context: { slot: '101', instance: INSTANCE }, value: [null] }, { context: { slot: -1, instance: INSTANCE }, value: [null] },
    { context: { slot: 101.5, instance: INSTANCE }, value: [null] }, { context: { slot: 101, instance: INSTANCE } }, { context: { slot: 101, instance: INSTANCE }, value: [] },
    { context: { slot: 101, instance: INSTANCE }, value: [null, null] }, { context: { slot: 101, instance: INSTANCE }, value: [undefined] }, { context: { slot: 101, instance: INSTANCE }, value: null },
    { context: { slot: 101, instance: INSTANCE }, value: ['finalized'] }, { context: { slot: 101, instance: INSTANCE }, value: [[]] }, undefined, null]) {
    s = settling({ status: () => ({ result }) }); out = await sendOnce(s.relay);
    await code(ask(s.relay, out.signature), 'LocalPlayRpcUnavailable');
    // ...and the ticket is still unsettled: a well-formed answer afterwards is taken
  }
  // a FOUND entry is taken only whole: `err` and `slot` present, a real slot not after the context, a known level — nothing is filled in
  for (const entry of [{ confirmationStatus: 'confirmed' }, { confirmationStatus: 'confirmed', err: null }, { confirmationStatus: 'confirmed', slot: 60 }, { slot: 60, err: null },
    { slot: 60, err: null, confirmationStatus: 'settled' }, { slot: 60, err: null, confirmationStatus: null }, { slot: '60', err: null, confirmationStatus: 'finalized' },
    { slot: -1, err: null, confirmationStatus: 'finalized' }, { slot: 501, err: null, confirmationStatus: 'finalized' }, { slot: 60.5, err: null, confirmationStatus: 'finalized' },
    { slot: 60, err: 0, confirmationStatus: 'finalized' }, { slot: 60, err: false, confirmationStatus: 'finalized' }, { slot: 60, err: [], confirmationStatus: 'finalized' }, { slot: 60, err: undefined, confirmationStatus: 'finalized' }]) {
    s = settling({ status: () => ({ result: { context: { slot: 500, instance: INSTANCE }, value: [entry] } }) }); out = await sendOnce(s.relay);
    await code(ask(s.relay, out.signature), 'LocalPlayRpcUnavailable');
  }
  // an RPC error, a throw: the runner did not answer
  s = settling({ status: () => ({ error: { code: -32000 } }) }); out = await sendOnce(s.relay); await code(ask(s.relay, out.signature), 'LocalPlayRpcUnavailable');
  s = settling({ status: () => { throw new Error('down'); } }); out = await sendOnce(s.relay); await code(ask(s.relay, out.signature), 'LocalPlayRpcUnavailable');
  // a runner REFUSAL of the send is not "not sent": the ticket is used, its signature recorded, and it settles only by the chain like any other
  let slot = 60; s = settling({ send: () => ({ error: { code: -32002, message: 'preflight' } }), status: () => notFound(slot) });
  await s.relay.prepare(request()); await code(s.relay.submit(submitBody()), 'LocalPlaySendRefused');
  const sig = encode(singleSigned(Buffer.from(submitBody().transaction_b64, 'base64')).signature);
  assert.equal((await ask(s.relay, sig)).status, 'pending'); await code(s.relay.submit(submitBody()), 'LocalPlayMessageUsed');
  slot = 101; assert.equal((await ask(s.relay, sig)).status, 'expired_unlanded');
  // a signature this relay never sent is refused as before, whatever the chain says
  await code(ask(s.relay, encode(new Uint8Array(64).fill(3))), 'LocalPlayUnknownSignature');
  // a bad instance at construction is refused
  for (const bad of ['', 'ab', 'AB'.repeat(32), '00'.repeat(32), 'zz'.repeat(32), 7, {}]) assert.throws(() => createLocalPlayRelay({ cfg: cfg(), runnerInstance: bad, prepare: { prepare: async () => prepared(), close() {} } }), /bad runner instance/);
});

test('F2 — a sent ticket is never dropped, however far the chain goes; the barrier is bounded and fails closed when full', async () => {
  // a used ticket survives its last valid height (it used to be dropped then): still answerable, still barred
  let height = 50;
  const s = settling({ runnerInstance: null, height: () => height, status: () => notFound(height, null) }), out = await sendOnce(s.relay);
  height = 10_000;
  await code(s.relay.prepare(request()), 'LocalPlayMessageUsed'); await code(s.relay.submit(submitBody()), 'LocalPlayMessageUsed');
  assert.equal((await ask(s.relay, out.signature)).status, 'pending'); assert.equal(s.sends.length, 1);
  // a full barrier of SENT tickets refuses every new preparation, and keeps answering what it holds
  let n = 0, chain = 50;
  const many = createLocalPlayRelay({ cfg: cfg(), runnerInstance: INSTANCE,
    prepare: { prepare: async () => { const m = Buffer.concat([Buffer.from([1, 0, 0]), Buffer.alloc(200, 7), Buffer.from(String(n++))]);
      return prepared({ message_b64: m.toString('base64'), message_digest: createHash('sha256').update(m).digest('hex') }); }, close() {} },
    rpc: async (method, params) => {
      if (method === 'getBlockHeight') return { result: chain };
      if (method === 'sendTransaction') return { result: encode(singleSigned(Buffer.from(params[0], 'base64')).signature) };
      if (method === 'getSignatureStatuses') return notFound(chain);
      return { error: { code: -1 } };
    } });
  const sigs = [];
  for (let i = 0; i < MAX_HISTORY; i++) {
    const p = await many.prepare(request()), m = Buffer.from(p.report.prepared.message_b64, 'base64');
    sigs.push((await many.submit({ schema: SUBMIT_SCHEMA, message_digest: p.report.prepared.message_digest, transaction_b64: wire(m) })).signature);
  }
  chain = 10_000;   // far past every last valid height: nothing sent is retired by that
  await code(many.prepare(request()), 'LocalPlayBusy');
  // settling them does not free room either (tombstones are kept): still full, still answering
  assert.equal((await ask(many, sigs[0])).status, 'expired_unlanded'); assert.equal((await ask(many, sigs[MAX_HISTORY - 1])).status, 'expired_unlanded');
  await code(many.prepare(request()), 'LocalPlayBusy');
  assert.equal((await ask(many, sigs[0])).status, 'expired_unlanded');
});

test('concurrent preparations never exceed the open-ticket limit', async () => {
  const { relay } = harness({ report: uniqueReports(), prepareDelay: 30 });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => relay.prepare(request())));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  assert.equal(ok, 8);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'LocalPlayBusy'));
  assert.deepEqual(relay.stats(), { pending: 8, open: 8, preparing: 0 });
});

test('an invalid block height never leaves a reservation behind', async () => {
  for (const bad of [NaN, 1.5, -1, '5', 2 ** 53, null, undefined, Infinity]) {
    let first = true;
    const relay = createLocalPlayRelay({ cfg: cfg(), prepare: { prepare: async () => prepared(), close() {} },
      rpc: async method => {
        if (method === 'getBlockHeight') { const r = first ? bad : 50; first = false; return { result: r }; }
        if (method === 'sendTransaction') return { result: 'x' };
        return { error: {} };
      } });
    await relay.prepare(request());
    await code(relay.submit(submitBody()), 'LocalPlayRpcUnavailable');
    assert.equal((await relay.submit(submitBody())).status, 'unknown', `${String(bad)}: the reservation was given back`);
  }
});

test('a slow prepare over real HTTP completes (a finished request body is not a disconnect)', async () => {
  const { relay } = harness({ prepareDelay: 300 });
  const s = await serveLocalPlayRelay(relay, 0);
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/f/local-play/depart/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).submit.message_digest, DIGEST);
  } finally {
    await s.close();
  }
});

test('the RPC client follows no redirect, bounds the response and times out', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(307, { location: 'http://203.0.113.1/' }); return res.end(); }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"result":"'); res.write('x'.repeat(300 * 1024)); return res.end('"}'); }
    if (req.url === '/slow') return; // never answers
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1,"result":7}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.deepEqual(await fetchRpc(base + '/ok', 'getBlockHeight', []), { result: 7 });
    await assert.rejects(fetchRpc(base + '/redirect', 'getBlockHeight', []), e => e.code === 'LocalPlayRpcUnavailable');
    await assert.rejects(fetchRpc(base + '/big', 'getBlockHeight', []), e => e.code === 'LocalPlayRpcUnavailable');
    await assert.rejects(fetchRpc(base + '/slow', 'getBlockHeight', [], { timeoutMs: 200 }), e => e.code === 'LocalPlayRpcUnavailable');
  } finally {
    srv.closeAllConnections?.();
    await new Promise(r => srv.close(r));
  }
});
