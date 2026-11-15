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
      if (method === 'getSignatureStatuses') return { result: { value: [{ slot: 9, confirmationStatus: 'confirmed', err: null }] } };
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
  assert.deepEqual(st, { signature: out.signature, status: 'confirmed', err: null, slot: 9 });
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
      if (method === 'getSignatureStatuses') return { result: { value: [null] } };
      return { error: {} };
    } });
  await relay.prepare(request());
  await code(relay.submit(submitBody()), 'LocalPlayRpcUnavailable');
  const out = await relay.submit(submitBody()); // the reservation was given back: nothing had been sent
  assert.equal(out.status, 'unknown');
  assert.deepEqual(await relay.status({ schema: STATUS_SCHEMA, signature: out.signature }), { signature: out.signature, status: 'pending' });
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
      return { result: { value: [null] } };
    } });
  await relay.prepare(request());
  const out = await relay.submit(submitBody());
  clock.t += 10 * 365 * 24 * 3600 * 1000;
  await code(relay.prepare(request()), 'LocalPlayMessageUsed');
  await code(relay.submit(submitBody()), 'LocalPlayMessageUsed');
  assert.equal((await relay.status({ schema: STATUS_SCHEMA, signature: out.signature })).status, 'pending', 'still answerable');
  assert.equal(sends.length, 1);
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
