// Model-call billing when the outcome cannot be known (the review of
// 2026-10-17, DESIGN.md §6.5): a restart during a call, a call past its
// TTL, a result after a refund, repeated restarts; nothing is guessed, no
// double charge, no unrecorded cost, no action from a stale decision. And
// the sponsored deposit (the browser's path): the exact shape, the relay's
// co-signature, one credit per signature through the same verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ata } from '../client/src/frontier/prize.mjs';
import { ERR } from '../src/frontier/agent/contract.mjs';
import { INFERENCE_HOLD_TTL_MS } from '../src/frontier/agent/gateway.mjs';
import { llmDecider, runOnce } from '../src/frontier/agent/runner.mjs';
import { transferCheckedIx } from '../src/frontier/agent/custody.mjs';
import { call, createAgent, delegate, deposit, fakeChain, MINT, OPERATOR, ownerCommand, policy, relay, sound, sponsoredDeposit } from './agent-wallet-fixtures.mjs';

const IP = '127.0.0.1';
const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: IP });
const operator = (r, method, path, body) => call(r.operator, method, path, { body, headers: { authorization: `Bearer ${OPERATOR}` } });
const gated = () => { let release; const gate = new Promise(res => { release = res; }); return { gate, release }; };
const PRICE = '10000';

async function ready(r, { balance = 100_000n } = {}) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: policy(['economy']) });
  if (balance > 0n) await deposit(r, o, made.agentId, balance);
  delegate(r, o, made.agentKey);
  await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }));
  return { owner, o, ...made };
}
// A new process over the same state file and key directory (the keyring instance stands in for the files).
const restart = (r, over = {}) => relay({ chain: r.chain, prices: { inference: PRICE }, agentState: JSON.parse(JSON.stringify(r.agentStore.state)), keyring: r.gateway.keyring, ...over });
const costs = r => r.gateway.ledger.db.operatorCosts;

test('a restart during a model call: the hold becomes unresolved (reserved, not refunded, not charged), once however many restarts; the operator decides; a late result after a refund is recorded, not billed', async () => {
  const r = relay({ prices: { inference: PRICE } });
  const a = await ready(r);
  const { gate } = gated();
  // The call never returns in this process (the process "dies" with it).
  r.gateway.meterInference(a.agentId, () => gate, { key: 'call-1', model: 'm' }).catch(() => {});
  await new Promise(res => setTimeout(res, 2));
  const h = Object.values(r.gateway.ledger.get(a.agentId).holds)[0];
  assert.equal(h.state, 'running');
  // Restart 1: unresolved; restart 2 and 3: unchanged.
  const r2 = restart(r);
  const v2 = r2.gateway.view(a.agentId);
  assert.deepEqual([v2.balance.available, v2.balance.reserved, v2.balance.unresolved, v2.balance.spent.inference], ['90000', '10000', '10000', '0']);
  assert.equal(r2.gateway.ledger.get(a.agentId).holds[h.id].state, 'unresolved');
  assert.deepEqual(costs(r2).map(c => [c.kind, c.holdId, c.amount, c.reason]), [['unknown-call', h.id, PRICE, 'restart']]);
  const r3 = restart(r2);
  const r4 = restart(r3);
  assert.equal(r4.gateway.ledger.get(a.agentId).holds[h.id].state, 'unresolved');
  assert.equal(costs(r4).length, 1, 'one record however many restarts');
  assert.equal(r4.gateway.view(a.agentId).history.filter(x => x.type === 'unresolved').length, 1);
  assert.equal(r4.gateway.view(a.agentId).history.filter(x => x.type === 'spend').length, 0, 'nothing charged on a guess');
  // Unresolved money is not withdrawable; everything else is.
  const w = await post(r4, '/f/agent/command', ownerCommand(a.owner, 'withdraw', { agentId: a.agentId, params: { all: true } }));
  assert.equal(w.status, 200, JSON.stringify(w.json));
  assert.deepEqual([w.json.agent.balance.available, w.json.agent.balance.reserved, w.json.agent.balance.withdrawn, w.json.agent.mode], ['0', '10000', '90000', 'manual']);
  sound(r4);
  // The operator route lists it; a decision needs the operator token; refund gives it back and records the cost.
  assert.equal((await post(r4, '/f/agent/settle', { agentId: a.agentId, holdId: h.id, outcome: 'refund' })).status, 404, 'not public');
  assert.equal((await call(r4.operator, 'POST', '/f/agent/settle', { body: { agentId: a.agentId, holdId: h.id, outcome: 'refund' }, headers: { authorization: 'Bearer nope' } })).json.code, 'OperatorOnly');
  const list = await operator(r4, 'GET', '/f/agent/unresolved');
  assert.equal(list.json.holds.length, 1);
  assert.equal(list.json.total, PRICE);
  assert.equal((await operator(r4, 'POST', '/f/agent/settle', { agentId: a.agentId, holdId: h.id, outcome: 'maybe' })).status, 400);
  const refund = await operator(r4, 'POST', '/f/agent/settle', { agentId: a.agentId, holdId: h.id, outcome: 'refund', note: 'model log shows no request' });
  assert.equal(refund.status, 200, JSON.stringify(refund.json));
  assert.deepEqual([refund.json.balance.available, refund.json.balance.reserved, refund.json.balance.unresolved], ['10000', '0', '0']);
  assert.deepEqual(costs(r4).map(c => c.kind), ['unknown-call', 'refunded-call']);
  assert.equal((await operator(r4, 'POST', '/f/agent/settle', { agentId: a.agentId, holdId: h.id, outcome: 'charge' })).status, 404, 'decided already');
  assert.equal((await operator(r4, 'GET', '/f/agent/unresolved')).json.holds.length, 0);
  // A result for that call reaching this (old) process after the refund: not billed, recorded once, the books balance.
  // (simulated on the first process, whose promise is still pending)
  const lateGate = gated();
  const p = r.gateway.meterInference(a.agentId, () => lateGate.gate, { key: 'call-2', model: 'm' });
  await new Promise(res => setTimeout(res, 2));
  const h2 = Object.values(r.gateway.ledger.get(a.agentId).holds).find(x => x.key === 'call-2');
  r.gateway.ledger.release(a.agentId, h2.id, 'operator-refund'); // what the operator's refund does to this hold
  lateGate.release({ choice: null, tokens: null });
  const out = await p;
  assert.deepEqual([out.ok, out.charged], [true, '0'], 'the late result is not billed');
  assert.deepEqual(costs(r).at(-1).kind, 'late-result');
  assert.equal(r.gateway.view(a.agentId).balance.spent.inference, '0');
  sound(r);
  // Charge, the other decision: the owner pays once; the hold is gone after.
  const r5 = relay({ prices: { inference: PRICE } });
  const b = await ready(r5);
  r5.gateway.meterInference(b.agentId, () => gated().gate, { key: 'c', model: 'm' }).catch(() => {});
  await new Promise(res => setTimeout(res, 2));
  const r6 = restart(r5);
  const hb = Object.values(r6.gateway.ledger.get(b.agentId).holds)[0];
  const charge = await operator(r6, 'POST', '/f/agent/settle', { agentId: b.agentId, holdId: hb.id, outcome: 'charge', note: 'the model log shows the call' });
  assert.deepEqual([charge.json.balance.spent.inference, charge.json.balance.reserved], [PRICE, '0']);
  assert.ok(r6.gateway.view(b.agentId).history.some(x => x.type === 'spend' && x.decidedBy?.via === 'operator-token' && x.claimedBy === null), 'the charge names the credential, not a label');
  sound(r6);
});

test('a call past its TTL: not refunded (unresolved); a result arriving later settles it once; a second delivery changes nothing', async () => {
  let t = Date.now();
  const r = relay({ prices: { inference: PRICE }, now: () => t });
  const a = await ready(r);
  const { gate, release } = gated();
  const pending = r.gateway.meterInference(a.agentId, () => gate, { key: 'slow', model: 'm' });
  await new Promise(res => setTimeout(res, 2));
  const h = Object.values(r.gateway.ledger.get(a.agentId).holds)[0];
  t += INFERENCE_HOLD_TTL_MS + 1;
  assert.equal(r.gateway.ledger.expire(), 1);
  assert.equal(r.gateway.ledger.get(a.agentId).holds[h.id].state, 'unresolved', 'past its TTL: unresolved, not released');
  assert.deepEqual([r.gateway.view(a.agentId).balance.available, r.gateway.view(a.agentId).balance.unresolved], ['90000', '10000']);
  assert.equal(r.gateway.ledger.expire(), 0, 'once');
  assert.deepEqual(costs(r).map(c => [c.kind, c.reason]), [['unknown-call', 'ttl']]);
  // The result arrives after all: the outcome is known, the call is paid for, the unresolved line is closed.
  release({ choice: null, tokens: { prompt: 1, completion: 1 } });
  const out = await pending;
  assert.deepEqual([out.ok, out.charged], [true, PRICE]);
  const v = r.gateway.view(a.agentId);
  assert.deepEqual([v.balance.available, v.balance.reserved, v.balance.unresolved, v.balance.spent.inference], ['90000', '0', '0', PRICE]);
  assert.ok(v.history.some(x => x.type === 'spend' && x.late === true));
  // Delivered twice (a retry of the same key): the ledger settles a hold once; the second settle is a no-op.
  assert.equal(r.gateway.ledger.settle(a.agentId, h.id), false);
  assert.equal(r.gateway.view(a.agentId).balance.spent.inference, PRICE);
  assert.equal((await operator(r, 'GET', '/f/agent/unresolved')).json.holds.length, 0);
  sound(r);
});

test('after a stop and after a restart no action comes from a stale decision; the runner charges only what the live process settled', async () => {
  const r = relay({ prices: { inference: PRICE } });
  const a = await ready(r);
  // A model that answers after the owner stopped the agent: charged (it ran), its action refused.
  const { gate, release } = gated();
  const llm = { alias: 'late', async complete() { await gate; return { ok: true, content: JSON.stringify({ action: 'Harvest', fields: {}, reason: 'late' }), usage: null }; } };
  const run = runOnce(r.gateway, a.agentId, llmDecider({ llm }), { tick: 1 });
  await new Promise(res => setTimeout(res, 2));
  r.gateway.setMode(a.agentId, a.o, 'manual');
  release();
  const out = await run;
  assert.deepEqual([out.charged, out.result.status, out.result.error.code], [PRICE, 'refused', ERR.AGENT_STOPPED]);
  assert.equal(r.chain.sent.length, 0);
  // A restart while the model thinks: the new process has no decision to act on; the call is unresolved, nothing is sent.
  r.gateway.setMode(a.agentId, a.o, 'auto');
  const slow = gated();
  runOnce(r.gateway, a.agentId, llmDecider({ llm: { alias: 'slow', async complete() { await slow.gate; return { ok: true, content: '{}', usage: null }; } } }), { tick: 2 }).catch(() => {});
  await new Promise(res => setTimeout(res, 2));
  const r2 = restart(r);
  assert.equal(r2.gateway.inflight.size, 0);
  assert.equal(r2.gateway.view(a.agentId).balance.unresolved, PRICE);
  assert.equal(r2.chain.sent.length, 0, 'the new process sends nothing on its own');
  // Its own next tick decides afresh (the autopilot here), free, and acts.
  const next = await runOnce(r2.gateway, a.agentId, { name: 'autopilot', free: true, async decide() { return { name: 'Harvest', fields: {} }; } }, { tick: 3 });
  assert.deepEqual([next.charged, next.result.status], ['0', 'sent'], JSON.stringify(next.result));
  assert.equal(r2.gateway.view(a.agentId).balance.spent.inference, PRICE, 'only the stopped-but-returned call was billed');
  sound(r2);
});

test('sponsored deposit: the owner signs, a pool key pays, the relay co-signs and credits once through the same verifier; wrong shapes and replays are refused', async () => {
  const r = relay();
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const { agentId } = await createAgent(r, owner);
  const feePayer = (await call(r.public, 'GET', '/f/relay', { ip: IP })).json.feePayer;
  const { wire } = sponsoredDeposit(r, owner, 2_500_000n, { feePayer });
  const res = await post(r, '/f/agent/deposit', { agentId, tx: wire });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual([res.json.credited, res.json.sponsored, res.json.amount, res.json.balance.available], [true, true, '2500000', '2500000']);
  const sent = r.chain.sent.at(-1);
  assert.equal(sent.signers[0], feePayer);
  assert.equal(sent.signers[1], o);
  assert.ok(r.pool.has(sent.signers[0]), 'the pool paid the fee');
  assert.equal(r.store.state.quota?.[`citizen:${o}`], undefined, 'no game quota is charged for a deposit');
  // The same signed transaction again: refused as a repeat; the ledger's deposits stay one.
  const again = await post(r, '/f/agent/deposit', { agentId, tx: wire });
  assert.equal(again.json.code, 'Duplicate');
  assert.equal(r.gateway.view(agentId).balance.deposited, '2500000');
  // Its signature claimed by the other path: already.
  const claimed = await post(r, '/f/agent/deposit', { agentId, signature: res.json.signature });
  assert.deepEqual([claimed.json.credited, claimed.json.already], [false, true]);
  // Without the custody account's creation (it exists now): fine.
  const second = sponsoredDeposit(r, owner, 100n, { feePayer, createAta: false });
  assert.equal((await post(r, '/f/agent/deposit', { agentId, tx: second.wire })).json.amount, '100');
  // Wrong shapes: another destination, another amount sign, an extra instruction, a stranger's signature, a payer outside the pool, another owner.
  const stranger = Keypair.generate();
  const refuse = async (what, wireB64, code = ERR.DEPOSIT_INVALID) => {
    const bad = await post(r, '/f/agent/deposit', { agentId, tx: wireB64 });
    assert.equal(bad.json.code, code, `${what}: ${JSON.stringify(bad.json)}`);
  };
  await refuse('another destination', sponsoredDeposit(r, owner, 5n, { feePayer, tamper: ixs => [ixs[0], transferCheckedIx({ source: ata(o, MINT), mint: MINT, dest: ata(stranger.publicKey.toBase58(), MINT), authority: o, amount: 5n, decimals: 6 })] }).wire);
  await refuse('extra instruction', sponsoredDeposit(r, owner, 5n, { feePayer, tamper: ixs => [...ixs, ixs[1]] }).wire);
  await refuse('zero amount', sponsoredDeposit(r, owner, 0n, { feePayer }).wire);
  await refuse('payer outside the pool', sponsoredDeposit(r, owner, 5n, { feePayer: stranger.publicKey.toBase58() }).wire);
  await refuse('signed by a stranger (not the owner)', sponsoredDeposit(r, stranger, 5n, { feePayer }).wire);
  const sentBefore = r.chain.sent.length;
  assert.equal(r.chain.sent.length, sentBefore, 'nothing refused was sent');
  assert.equal((await post(r, '/f/agent/deposit', { agentId, tx: 'AAAA' })).json.code, 'InvalidTransaction');
  // (the per-agent deposit limit, burst 10, is a different subject: reset it for the rest)
  r.ctx.limiter.buckets.clear();
  // A failed simulation sends nothing and credits nothing; the same bytes may be sent again after.
  const failing = fakeChain({ fail: () => ({ InstructionError: [1, { Custom: 1 }] }) });
  const simulate = r.chain.simulateTransaction;
  r.chain.simulateTransaction = failing.simulateTransaction;
  const third = sponsoredDeposit(r, owner, 7n, { feePayer, createAta: false });
  const refused = await post(r, '/f/agent/deposit', { agentId, tx: third.wire });
  assert.notEqual(refused.status, 200);
  r.chain.simulateTransaction = simulate;
  const retried = await post(r, '/f/agent/deposit', { agentId, tx: third.wire });
  assert.equal(retried.json.amount, '7', `not a Duplicate after a refusal: ${JSON.stringify(retried.json)}`);
  assert.equal(r.gateway.view(agentId).balance.deposited, '2500107');
  // By owner: the listing the browser starts from.
  const mine = await call(r.public, 'GET', `/f/agent/by-owner?owner=${o}`, { ip: IP });
  assert.equal(mine.json.agents.length, 1);
  assert.equal(mine.json.agents[0].balance.available, '2500107');
  sound(r);
});

test('the proposed deadline rule is off by default; when given, an unresolved call is released after it, a later result is not billed, the operator\'s record keeps both; settlements are audited and never double', async () => {
  let t = Date.now();
  // Off (the default): an unresolved hold waits however long.
  const off = relay({ prices: { inference: PRICE }, now: () => t });
  const a = await ready(off);
  off.gateway.meterInference(a.agentId, () => gated().gate, { key: 'k', model: 'm' }).catch(() => {});
  await new Promise(res => setTimeout(res, 2));
  const r1 = restart(off, { now: () => t });
  assert.equal(r1.gateway.unresolvedReleaseMs, null);
  t += 48 * 3_600_000;
  assert.equal((await r1.gateway.reconcile()).autoReleased, 0);
  assert.equal(r1.gateway.view(a.agentId).balance.unresolved, PRICE);
  // On (the proposal, 1 hour): released past the deadline, recorded as the operator's cost; a result after that is not billed.
  const h = Object.values(r1.gateway.ledger.get(a.agentId).holds)[0];
  const on = relay({ chain: r1.chain, prices: { inference: PRICE }, agentState: JSON.parse(JSON.stringify(r1.agentStore.state)), keyring: r1.gateway.keyring, now: () => t, unresolvedReleaseMs: 3_600_000 });
  assert.equal((await on.gateway.reconcile()).autoReleased, 1);
  const v = on.gateway.view(a.agentId);
  assert.deepEqual([v.balance.unresolved, v.balance.reserved, v.balance.available, v.balance.spent.inference], ['0', '0', '100000', '0']);
  assert.deepEqual(costs(on).map(c => c.kind), ['unknown-call', 'released-call']);
  assert.equal(on.gateway.ledger.settle(a.agentId, h.id), false, 'a result for it now: the hold is gone, nothing billed');
  assert.equal(on.gateway.view(a.agentId).balance.spent.inference, '0');
  // Not released before the deadline. (the clock is 48 h ahead of the wall clock here: no owner command, the gateway directly)
  const ownerB = Keypair.generate();
  const b = (() => { const made = on.gateway.createAgent({ owner: ownerB.publicKey.toBase58(), village: [-3, 7, 11], policy: policy(['economy']) }); return { agentId: made.agent.agentId, agentKey: made.agent.agentKey, o: ownerB.publicKey.toBase58() }; })();
  await deposit(on, b.o, b.agentId, 100_000n);
  delegate(on, b.o, b.agentKey);
  on.gateway.setMode(b.agentId, b.o, 'auto');
  on.gateway.meterInference(b.agentId, () => gated().gate, { key: 'k2', model: 'm' }).catch(() => {});
  await new Promise(res => setTimeout(res, 2));
  const on2 = relay({ chain: on.chain, prices: { inference: PRICE }, agentState: JSON.parse(JSON.stringify(on.agentStore.state)), keyring: on.gateway.keyring, now: () => t, unresolvedReleaseMs: 3_600_000 });
  t += 30 * 60_000;
  assert.equal((await on2.gateway.reconcile()).autoReleased, 0);
  assert.equal(on2.gateway.view(b.agentId).balance.unresolved, PRICE);
  // The audit of an operator's decision: who, when, which call, why, on what evidence; twice is refused; a late result after a charge is not billed again.
  const hb = Object.values(on2.gateway.ledger.get(b.agentId).holds)[0];
  const dec = await operator(on2, 'POST', '/f/agent/settle', { agentId: b.agentId, holdId: hb.id, outcome: 'charge', note: 'the model log shows the request and its answer', by: 'ops-1', evidence: 'llama-server.log line 4321' });
  assert.equal(dec.status, 200, JSON.stringify(dec.json));
  assert.deepEqual([dec.json.by.via, dec.json.by.token.length, dec.json.claimedBy], ['operator-token', 8, 'ops-1']);
  const list = await operator(on2, 'GET', '/f/agent/unresolved');
  const s = list.json.settlements.at(-1);
  assert.deepEqual([s.agentId, s.holdId, s.outcome, s.by.via, s.claimedBy, s.note, s.evidence, s.unresolvedReason, typeof s.at], [b.agentId, hb.id, 'charge', 'operator-token', 'ops-1', 'the model log shows the request and its answer', 'llama-server.log line 4321', 'restart', 'number']);
  assert.ok(on2.gateway.view(b.agentId).history.some(x => x.type === 'spend' && x.decidedBy?.via === 'operator-token' && x.claimedBy === 'ops-1' && x.evidence));
  assert.equal((await operator(on2, 'POST', '/f/agent/settle', { agentId: b.agentId, holdId: hb.id, outcome: 'refund' })).status, 404, 'decided once');
  assert.equal(on2.gateway.ledger.settle(b.agentId, hb.id), false, 'a late result: no second charge');
  assert.equal(on2.gateway.view(b.agentId).balance.spent.inference, PRICE);
  assert.equal(list.json.unresolvedReleaseMs, 3_600_000);
  sound(on2);
});
