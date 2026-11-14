// ⑰ (2026-11-15): the local-play prize relay's one-use barrier with REAL signatures. KEY-USING TEST: it makes one
// throwaway Ed25519 key IN MEMORY (node:crypto) to stand for the page's wallet, signs only messages this relay
// prepared, and talks to a MOCKED loopback RPC. No key is written, printed, logged or reused; no network; no chain.
// It cannot run under the no-keys guard (it makes a key by design); the user put test-only in-memory keys in scope for
// this verification (2026-11-15). Run: node --test test/local-play-prize-signed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { encode as b58 } from '../client/src/base58.mjs';
import { pubkeyBytes } from '../client/src/solana-tx.mjs';
import { POOL_SIZE, entryResidentAddress, poolAddress } from '../client/src/frontier/prize.mjs';
import { policyAddress } from '../client/src/frontier/resident.mjs';
import { LOCAL_LANE_PROGRAMS } from '../src/frontier/local-lane-versions.mjs';
import { createLocalPlayPrize, MAX_HISTORY, OPEN_TTL_MS, PREPARE_SCHEMA, STATUS_SCHEMA, SUBMIT_SCHEMA } from '../src/frontier/local-play-prize.mjs';
import { fixtureEntryBytes } from '../scripts/prize-nft-fixture-entry.mjs';

// The throwaway wallet: raw 32-byte public key from the SPKI DER (last 32 bytes).
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const WALLET = b58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const signWire = msgB64 => { const m = Buffer.from(msgB64, 'base64'); return Buffer.concat([Buffer.from([1]), edSign(null, m, privateKey), m]).toString('base64'); };

const k = n => b58(new Uint8Array(32).fill(n));
const PROGRAM = LOCAL_LANE_PROGRAMS.conquestNftCandidate, PRIZE = k(0x50), ASSET = k(0x5a), RES = k(0x33), SEASON_ID = 11;
const POOL = poolAddress(PRIZE, PROGRAM, SEASON_ID);
const INSTANCE = 'ab'.repeat(32);
const RUN = '0123456789abcdef0123456789abcdef';
const cfg = { testOnly: true, rpc: 'http://127.0.0.1:41101', programId: PROGRAM, seasonId: SEASON_ID, prizeProgram: PRIZE, wallet: WALLET, runId: RUN };
const ledger = { testOnly: true, shares: { mode: 'shares', members: [{ wallet: `pass:${ASSET}`, asset: ASSET, nation: 1, points: 10, proof: ['00'.repeat(32)] }] } };

function accounts() {
  const pool = new Uint8Array(POOL_SIZE);
  pool.set(new TextEncoder().encode('WYPRPOOL'), 0); pool[10] = 2; pool[11] = 6; pool[12] = 2; pool[13] = 1; pool[14] = 1;
  new DataView(pool.buffer).setBigUint64(16, BigInt(SEASON_ID), true);
  pool.set(pubkeyBytes(PROGRAM), 24); pool.set(pubkeyBytes(k(0x72)), 120); pool.set(pubkeyBytes(k(0x71)), 152);
  const policy = new Uint8Array(136); policy.set(new TextEncoder().encode('PSFNP002'), 0);
  policy.set(pubkeyBytes(k(0x44)), 8); policy.set(pubkeyBytes(RES), 40); policy.set(pubkeyBytes(k(0x55)), 72); policy.set(pubkeyBytes(k(0x66)), 104);
  return new Map([[POOL, { owner: PRIZE, data: pool }], [entryResidentAddress(PRIZE, POOL, ASSET), { owner: PRIZE, data: fixtureEntryBytes({ bump: 255, pool: POOL, asset: ASSET, amount: 25_000_000n, paidBy: WALLET }) }],
    [policyAddress(PROGRAM), { owner: PROGRAM, data: policy }]]);
}

/** A mocked loopback runner. `send` decides each sendTransaction: returns {result}/{error}, throws, or is held (a promise). */
function runner({ send = wire => ({ result: sigOf(wire) }), height = 50, instance = INSTANCE, status = null, runId = RUN, heights = null } = {}) {
  const acc = accounts();
  const sent = [];
  const st = { height, instance, status, runId, heights };
  const rpc = async (method, params) => {
    if (method === 'getAccountInfo') { const a = acc.get(params[0]); return { result: { value: a ? { owner: a.owner, data: [Buffer.from(a.data).toString('base64'), 'base64'] } : null } }; }
    if (method === 'getLatestBlockhash') return { result: { value: { blockhash: k(0x09), lastValidBlockHeight: 100 } } };
    if (method === 'getBlockHeight') return st.heights ? st.heights() : { result: st.height };
    if (method === 'frontier_status') return { result: { runId: st.runId } };
    if (method === 'sendTransaction') { sent.push(params[0]); return send(params[0]); }
    if (method === 'getSignatureStatuses') return { result: { context: { slot: st.height, instance: st.instance }, value: [st.status] } };
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, sent, st };
}
const sigOf = wireB64 => b58(Buffer.from(wireB64, 'base64').subarray(1, 65));
const prepareReq = { schema: PREPARE_SCHEMA, asset: ASSET, generation: 2 };
const make = (r, extra = {}) => createLocalPlayPrize({ cfg, rpc: r.rpc, readLedger: async () => ledger, runnerInstance: INSTANCE, ...extra });

test('success: the wallet\'s signature on the prepared message is sent once and answered with its signature', async () => {
  const r = runner();
  const prize = make(r);
  const p = await prize.prepare(prepareReq);
  const tx = signWire(p.message_b64);
  const s = await prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx });
  assert.deepEqual([s.status, s.signature], ['submitted', sigOf(tx)]);
  assert.equal(r.sent.length, 1);
  // A second submit of the same message: refused, with the signature; nothing is resent.
  await assert.rejects(prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx }), e => e.code === 'LocalPrizeMessageUsed' && e.signature === sigOf(tx));
  assert.equal(r.sent.length, 1);
});

test('concurrent submits of one message: exactly one is sent', async () => {
  const r = runner();
  const prize = make(r);
  const p = await prize.prepare(prepareReq);
  const tx = signWire(p.message_b64);
  const body = { schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx };
  const results = await Promise.allSettled([prize.submit(body), prize.submit(body), prize.submit(body)]);
  assert.equal(results.filter(x => x.status === 'fulfilled' && x.value.status === 'submitted').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected' && x.reason.code === 'LocalPrizeMessageUsed').length, 2);
  assert.equal(r.sent.length, 1);
});

test('re-preparing the same message: open → the same ticket; while its send is held, after it, and after an unknown outcome → refused, never reset', async () => {
  let release;
  const held = new Promise(res => { release = res; });
  const r = runner({ send: () => held });
  const prize = make(r);
  const p = await prize.prepare(prepareReq);
  // Open: preparing again returns the same ticket (same digest, same bytes), not a fresh one.
  const again = await prize.prepare(prepareReq);
  assert.deepEqual([again.status, again.message_digest, again.message_b64, again.again], ['prepared', p.message_digest, p.message_b64, true]);
  const tx = signWire(p.message_b64);
  const inflight = prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx });
  await new Promise(res => setImmediate(res));
  // While the send is held: re-prepare is refused (with the signature already recorded), and a second submit too.
  await assert.rejects(prize.prepare(prepareReq), e => e.code === 'LocalPrizeMessageUsed' && e.signature === sigOf(tx));
  await assert.rejects(prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx }), e => e.code === 'LocalPrizeMessageUsed');
  release({ result: sigOf(tx) });
  assert.equal((await inflight).status, 'submitted');
  await assert.rejects(prize.prepare(prepareReq), e => e.code === 'LocalPrizeMessageUsed');
  assert.equal(r.sent.length, 1);
});

test('an unknown outcome (the send\'s answer is lost) keeps the signature; retry and re-prepare are refused; status answers it', async () => {
  const r = runner({ send: () => { throw new Error('connection reset after the send began'); } });
  const prize = make(r);
  const p = await prize.prepare(prepareReq);
  const tx = signWire(p.message_b64);
  const u = await prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx });
  assert.deepEqual([u.status, u.signature], ['unknown', sigOf(tx)]);
  await assert.rejects(prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx }), e => e.code === 'LocalPrizeMessageUsed' && e.signature === sigOf(tx));
  await assert.rejects(prize.prepare(prepareReq), e => e.code === 'LocalPrizeMessageUsed' && e.signature === sigOf(tx));
  // A different answered signature from the runner is also "unknown", not success.
  const r2 = runner({ send: () => ({ result: k(0x01) }) });
  const prize2 = make(r2);
  const p3 = await prize2.prepare(prepareReq);
  assert.equal((await prize2.submit({ schema: SUBMIT_SCHEMA, message_digest: p3.message_digest, transaction_b64: signWire(p3.message_b64) })).status, 'unknown');
  // status of the unknown claim: still pending while the runner has not passed the last valid height.
  const st = await prize.status({ schema: STATUS_SCHEMA, signature: sigOf(tx) });
  assert.equal(st.status, 'pending');
  assert.equal(r.sent.length, 1);
});

test('a refused send keeps the ticket consumed (with its signature); an expired height never sends', async () => {
  const r = runner({ send: () => ({ error: { code: -32002, message: 'simulation failed: ResidentStaleGeneration' } }) });
  const prize = make(r);
  const p = await prize.prepare(prepareReq);
  const tx = signWire(p.message_b64);
  await assert.rejects(prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx }), e => e.code === 'LocalPrizeSendRefused' && e.signature === sigOf(tx));
  await assert.rejects(prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx }), e => e.code === 'LocalPrizeMessageUsed');
  // Past the last valid height (100): expired before anything is sent.
  const late = runner({ height: 101 });
  const pz = make(late);
  const q = await pz.prepare(prepareReq);
  await assert.rejects(pz.submit({ schema: SUBMIT_SCHEMA, message_digest: q.message_digest, transaction_b64: signWire(q.message_b64) }), e => e.code === 'LocalPrizeMessageExpired');
  assert.equal(late.sent.length, 0);
  // A height that cannot be read gives the reservation back (nothing sent); the same message can be submitted afterwards.
  const flaky = runner();
  const pf = make(flaky);
  const f = await pf.prepare(prepareReq);
  flaky.st.height = -1;
  await assert.rejects(pf.submit({ schema: SUBMIT_SCHEMA, message_digest: f.message_digest, transaction_b64: signWire(f.message_b64) }), e => e.code === 'LocalPrizeRpcUnavailable');
  flaky.st.height = 50;
  assert.equal((await pf.submit({ schema: SUBMIT_SCHEMA, message_digest: f.message_digest, transaction_b64: signWire(f.message_b64) })).status, 'submitted');
  assert.equal(flaky.sent.length, 1);
});

test('status: only the pinned runner\'s answer counts; a replaced runner is refused; "did not land" settles only past the last valid height', async () => {
  const r = runner();
  const prize = make(r);
  const p = await prize.prepare(prepareReq);
  const tx = signWire(p.message_b64);
  await prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx });
  r.st.instance = 'cd'.repeat(32);
  await assert.rejects(prize.status({ schema: STATUS_SCHEMA, signature: sigOf(tx) }), e => e.code === 'LocalPrizeRunnerChanged');
  r.st.instance = INSTANCE;
  assert.equal((await prize.status({ schema: STATUS_SCHEMA, signature: sigOf(tx) })).status, 'pending');
  r.st.height = 101;
  assert.equal((await prize.status({ schema: STATUS_SCHEMA, signature: sigOf(tx) })).status, 'expired_unlanded');
  r.st.status = { err: null, slot: 60, confirmationStatus: 'finalized' };
  assert.equal((await prize.status({ schema: STATUS_SCHEMA, signature: sigOf(tx) })).status, 'expired_unlanded', 'a settled ticket answers from its record');
  await assert.rejects(prize.status({ schema: STATUS_SCHEMA, signature: k(0x02) }), e => e.code === 'LocalPrizeUnknownSignature');
  // Found and finalized on a fresh claim.
  const r2 = runner({ status: { err: null, slot: 40, confirmationStatus: 'finalized' } });
  const p2z = make(r2);
  const q = await p2z.prepare(prepareReq);
  const tx2 = signWire(q.message_b64);
  await p2z.submit({ schema: SUBMIT_SCHEMA, message_digest: q.message_digest, transaction_b64: tx2 });
  assert.equal((await p2z.status({ schema: STATUS_SCHEMA, signature: sigOf(tx2) })).status, 'finalized');
});

test('a runner swapped between prepare and submit: nothing is sent, and that claim message can never be used again', async () => {
  const r = runner();
  const prize = make(r);
  const p = await prize.prepare(prepareReq);
  const tx = signWire(p.message_b64);
  r.st.runId = 'fedcba9876543210fedcba9876543210';
  await assert.rejects(prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx }), e => e.code === 'LocalPrizeRunnerChanged');
  assert.equal(r.sent.length, 0, 'nothing sent to the other runner');
  r.st.runId = RUN; // even back on the pinned runner, the spent ticket stays spent
  await assert.rejects(prize.submit({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: tx }), e => e.code === 'LocalPrizeMessageUsed');
  await assert.rejects(prize.prepare(prepareReq), e => e.code === 'LocalPrizeMessageUsed');
  assert.equal(r.sent.length, 0);
});

test('full history: two prepares of the same message waiting on the height read never overwrite a ticket the first one sent', async () => {
  let t = 1_000;
  const held = [];
  const r = runner();
  const prize = make(r, { now: () => t });
  // Fill the barrier with MAX_HISTORY never-sent tickets (distinct generations), then let them expire.
  for (let g = 0; g < MAX_HISTORY; g++) await prize.prepare({ ...prepareReq, generation: 10_000 + g });
  assert.equal(prize.stats().tickets, MAX_HISTORY);
  t += OPEN_TTL_MS + 1;
  // From now on every height read is held until the test releases it, in order.
  r.st.heights = () => new Promise(res => held.push(res));
  const req = { ...prepareReq, generation: 7 };
  const A = prize.prepare(req), B = prize.prepare(req);
  while (held.length < 2) await new Promise(res => setImmediate(res));
  // A's height: past the expired tickets' last valid height (100): they are retired and A inserts its ticket.
  held.shift()({ result: 200 });
  const a = await A;
  assert.equal(a.status, 'prepared');
  // A is submitted and sent (its height read is held too: released at a valid height).
  const sub = prize.submit({ schema: SUBMIT_SCHEMA, message_digest: a.message_digest, transaction_b64: signWire(a.message_b64) });
  while (held.length < 2) await new Promise(res => setImmediate(res));
  held.pop()({ result: 50 });
  assert.equal((await sub).status, 'submitted');
  assert.equal(r.sent.length, 1);
  // Now B resumes after its own height read: it must see A's (sent) ticket and refuse, not overwrite it as open.
  held.shift()({ result: 200 });
  await assert.rejects(B, e => e.code === 'LocalPrizeMessageUsed' && typeof e.signature === 'string');
  await assert.rejects(prize.submit({ schema: SUBMIT_SCHEMA, message_digest: a.message_digest, transaction_b64: signWire(a.message_b64) }), e => e.code === 'LocalPrizeMessageUsed');
  assert.equal(r.sent.length, 1, 'one send in all');
});
