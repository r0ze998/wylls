// The agent wallet's money (docs/agent-wallet/DESIGN.md §4, §6): priced
// actions held, settled and released by the chain's answer; the budget, the
// daily limit and the balance under 20 concurrent requests; a stop or a new
// policy right before the send; a send that throws; withdrawals (partial,
// full with the auto-stop, racing a reserved hold, uncertain and reconciled);
// metered model calls; recovery after a restart; and that no secret reaches
// a view, the state file or the log. The books balance after every step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decodeTokenAccount, ata, TOKEN_PROGRAM } from '../client/src/frontier/prize.mjs';
import { ERR } from '../src/frontier/agent/contract.mjs';
import { AgentKeyring } from '../src/frontier/agent/keyring.mjs';
import { actionRequest, call, createAgent, delegate, deposit, fakeChain, MINT, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';

const IP = '127.0.0.1';
const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: IP });
const slow = (f, ms = 5) => async (...a) => { await new Promise(res => setTimeout(res, ms)); return f(...a); };

/** An agent in auto mode, delegated on chain, with `balance` deposited. */
async function ready(r, { balance = 100_000n, policy: p = policy(['economy'], '1000000', '1000000') } = {}) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: p });
  if (balance > 0n) await deposit(r, o, made.agentId, balance);
  delegate(r, o, made.agentKey);
  const m = await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }));
  assert.equal(m.status, 200, JSON.stringify(m.json));
  return { owner, o, ...made, act: (over = {}) => r.gateway.submit(actionRequest(made.agentId, over), { capability: made.capability }) };
}

test('a priced action is held before the send, settled when the transaction lands, released when it fails; balance, budget and daily limit refuse without sending', async () => {
  const r = relay({ prices: { inference: '10000', game: { Harvest: '5000', Train: '7000' } } });
  const a = await ready(r, { balance: 0n, policy: policy(['economy'], '12000', '12000') });
  // No balance: refused, nothing held, nothing sent.
  const broke = await a.act({ key: 'b1' });
  assert.equal(broke.error.code, ERR.INSUFFICIENT_BALANCE);
  assert.deepEqual([broke.error.available, broke.error.needed], ['0', '5000']);
  assert.equal(r.chain.sent.length, 0);
  await deposit(r, a.o, a.agentId, 100_000n);
  // Sent: 5,000 reserved until the chain answers.
  const one = await a.act({ key: 'h1' });
  assert.equal(one.status, 'sent', JSON.stringify(one));
  assert.deepEqual(one.charges, [{ category: 'game', amount: '5000', state: 'reserved' }]);
  assert.deepEqual([one.balance.available, one.balance.reserved, one.balance.spent.game], ['95000', '5000', '0']);
  sound(r);
  const rec = await r.gateway.reconcile();
  assert.equal(rec.settled, 1);
  assert.deepEqual(r.gateway.view(a.agentId).balance, { available: '95000', reserved: '0', pendingWithdraw: '0', withdrawn: '0', deposited: '100000', spent: { inference: '0', network: '0', game: '5000' } });
  assert.ok(r.gateway.view(a.agentId).history.some(h => h.type === 'spend' && h.category === 'game' && h.amount === '5000' && h.key === 'h1'));
  // A failed transaction gives the hold back.
  const two = await a.act({ key: 'h2', name: 'Train', fields: { unit: 1, n: 1 } });
  assert.equal(two.status, 'sent');
  r.chain.statuses.set(two.signature, { slot: 79, err: { InstructionError: [3, { Custom: 24 }] }, confirmationStatus: 'confirmed' });
  assert.equal((await r.gateway.reconcile()).released, 1);
  assert.equal(r.gateway.view(a.agentId).balance.available, '95000');
  // The budget (12,000 over the agent's life): 5,000 spent; 7,000 more fits, 5,000 after that does not.
  const three = await a.act({ key: 'h3', name: 'Train', fields: { unit: 1, n: 1 } });
  assert.equal(three.status, 'sent');
  const over = await a.act({ key: 'h4' });
  assert.equal(over.error.code, ERR.BUDGET_EXCEEDED);
  assert.deepEqual([over.error.budget, over.error.used], ['12000', '12000']);
  assert.equal(r.chain.sent.length, 3);
  await r.gateway.reconcile();
  // A bigger budget but a daily limit of 9,000: today's 12,000 is already past it; the next UTC day has room.
  await post(r, '/f/agent/command', ownerCommand(a.owner, 'policy', { agentId: a.agentId, params: { policy: policy(['economy'], '1000000', '9000') } }));
  const day = await a.act({ key: 'h5', policyVersion: 2 });
  assert.equal(day.error.code, ERR.DAILY_LIMIT);
  assert.deepEqual([day.error.perDay, day.error.today], ['9000', '12000']);
  r.gateway.ledger.now = () => Date.now() + 86_400_000;
  const next = await a.act({ key: 'h6', policyVersion: 2 });
  assert.equal(next.status, 'sent', JSON.stringify(next));
  sound(r);
});

test('20 concurrent priced requests over a balance for 10: exactly 10 are sent, 10 refused, the books balance', async () => {
  const chain = fakeChain();
  chain.getAccountInfo = slow(chain.getAccountInfo);
  chain.getBalance = slow(chain.getBalance);
  const r = relay({ chain, prices: { game: { Harvest: '1000' } } });
  const a = await ready(r, { balance: 10_000n });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => a.act({ key: `c${i}` })));
  const sent = results.filter(x => x.status === 'sent');
  const refused = results.filter(x => x.status === 'refused');
  assert.equal(sent.length, 10, JSON.stringify(results.map(x => x.status)));
  assert.equal(refused.length, 10);
  assert.ok(refused.every(x => x.error.code === ERR.INSUFFICIENT_BALANCE));
  assert.equal(r.chain.sent.length, 10);
  assert.equal(new Set(sent.map(x => x.signature)).size, 10, 'ten distinct transactions');
  assert.deepEqual([r.gateway.view(a.agentId).balance.available, r.gateway.view(a.agentId).balance.reserved], ['0', '10000']);
  sound(r);
  assert.equal((await r.gateway.reconcile()).settled, 10);
  assert.equal(r.gateway.view(a.agentId).balance.spent.game, '10000');
  // The same 20 keys again: every answer is the recorded one, nothing new is sent.
  const again = await Promise.all(Array.from({ length: 20 }, (_, i) => a.act({ key: `c${i}` })));
  assert.ok(again.every(x => x.replayed === true));
  assert.equal(r.chain.sent.length, 10);
  // Concurrent repeats of one new key share one send.
  await deposit(r, a.o, a.agentId, 1_000n);
  const same = await Promise.all([0, 1, 2].map(() => a.act({ key: 'shared' })));
  assert.equal(r.chain.sent.length, 11);
  assert.equal(same.filter(x => x.status === 'sent').length, 3);
  assert.equal(same.filter(x => x.replayed).length, 2);
  sound(r);
});

test('a stop or a new policy while the action is being prepared refuses it right before the send: nothing sent, nothing charged, the quota given back', async () => {
  for (const [what, change, code] of [['manual', (r, a) => r.gateway.setMode(a.agentId, a.o, 'manual'), ERR.AGENT_STOPPED], ['policy', (r, a) => r.gateway.setPolicy(a.agentId, a.o, policy(['economy'])), ERR.STALE_POLICY]]) {
    const chain = fakeChain();
    chain.getBalance = slow(chain.getBalance, 10);
    const r = relay({ chain, prices: { game: { Harvest: '1000' } } });
    const a = await ready(r, { balance: 5_000n });
    const pending = a.act({ key: 's1' });
    await new Promise(res => setTimeout(res, 3));
    assert.equal(r.gateway.view(a.agentId).balance.reserved, '1000', 'held while in flight');
    change(r, a);
    const res = await pending;
    assert.equal(res.status, 'refused', what);
    assert.equal(res.error.code, code, what);
    assert.equal(r.chain.sent.length, 0, what);
    assert.deepEqual([r.gateway.view(a.agentId).balance.available, r.gateway.view(a.agentId).balance.reserved], ['5000', '0'], what);
    const q = r.store.state.quota?.[`citizen:${r.ctx.addresses.citizen(a.o)}`];
    assert.ok(!q || q.left === 40, `quota given back (${what}): ${JSON.stringify(q)}`);
    assert.ok(!r.ctx.relayed.seen.size, 'the replay key is released');
    sound(r);
  }
});

test('a send that throws after signing leaves the hold to the chain\'s answer: expired gives it back, landed spends it; a free action has nothing to keep', async () => {
  const chain = fakeChain();
  const send = chain.sendRawTransaction;
  chain.sendRawTransaction = async () => { throw new Error('node down'); };
  const r = relay({ chain, prices: { game: { Harvest: '1000' } } });
  const a = await ready(r, { balance: 5_000n });
  const res = await a.act({ key: 'f1' });
  assert.equal(res.status, 'failed');
  assert.equal(res.error.code, ERR.SEND_FAILED);
  assert.deepEqual(res.charges, [{ category: 'game', amount: '1000', state: 'reserved' }]);
  const hold = Object.values(r.gateway.ledger.get(a.agentId).holds)[0];
  assert.equal(hold.state, 'sending');
  assert.equal(hold.lastValidBlockHeight, 150);
  assert.equal(r.gateway.view(a.agentId).balance.reserved, '1000');
  // Not expired yet: still pending. Past the last valid height with no status: expired, released.
  assert.equal((await r.gateway.reconcile()).pending, 1);
  chain.height = 151;
  assert.equal((await r.gateway.reconcile()).released, 1);
  assert.equal(r.gateway.view(a.agentId).balance.available, '5000');
  // The same with a transaction that did reach the chain: settled on reconcile.
  const two = await a.act({ key: 'f2' });
  assert.equal(two.status, 'failed');
  const h2 = Object.values(r.gateway.ledger.get(a.agentId).holds)[0];
  chain.statuses.set(h2.signature, { slot: 80, err: null, confirmationStatus: 'confirmed' });
  assert.equal((await r.gateway.reconcile()).settled, 1);
  assert.equal(r.gateway.view(a.agentId).balance.spent.game, '1000');
  // The replayed answer of a failed send is the recorded failure, not a new attempt.
  chain.sendRawTransaction = send;
  assert.equal((await a.act({ key: 'f2' })).status, 'failed');
  assert.equal(r.chain.sent.length, 0);
  // Free actions: the throw charges nothing and keeps nothing.
  const free = relay({ chain: fakeChain() });
  free.chain.sendRawTransaction = async () => { throw new Error('node down'); };
  const b = await ready(free, { balance: 0n });
  const fr = await b.act({ key: 'f3' });
  assert.equal(fr.status, 'failed');
  assert.deepEqual(fr.charges, []);
  assert.equal(Object.keys(free.gateway.ledger.get(b.agentId).holds).length, 0);
  sound(r);
  sound(free);
});

test('withdraw: available only, to the owner\'s token account, by the custody key; a full withdrawal stops the agent; an uncertain send waits for the chain', async () => {
  const r = relay({ prices: { game: { Harvest: '1000' } } });
  const a = await ready(r, { balance: 10_000n });
  // One hold in flight (reserved) stays.
  const held = await a.act({ key: 'w0' });
  assert.equal(held.status, 'sent');
  const part = await post(r, '/f/agent/command', ownerCommand(a.owner, 'withdraw', { agentId: a.agentId, params: { amount: '4000' } }));
  assert.equal(part.status, 200, JSON.stringify(part.json));
  assert.equal(part.json.withdrawal.state, 'done');
  assert.equal(part.json.agent.mode, 'auto', 'a partial withdrawal does not stop the agent');
  assert.deepEqual([part.json.agent.balance.available, part.json.agent.balance.reserved, part.json.agent.balance.withdrawn], ['5000', '1000', '4000']);
  const tx = r.chain.sent.at(-1);
  assert.ok(r.pool.has(tx.signers[0]), 'a pool payer pays the fee');
  assert.equal(tx.signers[1], r.custody.authority, 'the custody key signs');
  const transfer = tx.instructions.at(-1);
  assert.equal(transfer.programId, TOKEN_PROGRAM);
  assert.equal(transfer.data[0], 12, 'TransferChecked');
  assert.equal(Buffer.from(transfer.data).readBigUInt64LE(1), 4000n);
  assert.equal(transfer.keys[0].pubkey, r.custody.account);
  assert.equal(transfer.keys[2].pubkey, ata(a.o, MINT), 'to the owner\'s token account, nobody else\'s');
  // More than available (the reserved 1,000 is not available): refused.
  const over = await post(r, '/f/agent/command', ownerCommand(a.owner, 'withdraw', { agentId: a.agentId, params: { amount: '5001' } }));
  assert.equal(over.json.code, ERR.INSUFFICIENT_BALANCE);
  assert.equal((await post(r, '/f/agent/command', ownerCommand(a.owner, 'withdraw', { agentId: a.agentId, params: { amount: 'x' } }))).status, 400);
  // Everything: the agent stops first (its held holds come back and go too), the sending hold stays until reconcile.
  const all = await post(r, '/f/agent/command', ownerCommand(a.owner, 'withdraw', { agentId: a.agentId, params: { all: true } }));
  assert.equal(all.status, 200, JSON.stringify(all.json));
  assert.equal(all.json.agent.mode, 'manual');
  assert.equal(all.json.agent.modeEpoch, 2);
  assert.deepEqual([all.json.agent.balance.available, all.json.agent.balance.reserved, all.json.agent.balance.withdrawn], ['0', '1000', '9000']);
  assert.equal((await post(r, '/f/agent/command', ownerCommand(a.owner, 'withdraw', { agentId: a.agentId, params: { all: true } }))).status, 409, 'nothing to withdraw');
  // The in-flight hold fails on chain: its money is available again and can be withdrawn.
  r.chain.statuses.set(held.signature, { slot: 80, err: { InstructionError: [3, { Custom: 1 }] }, confirmationStatus: 'confirmed' });
  await r.gateway.reconcile();
  assert.equal(r.gateway.view(a.agentId).balance.available, '1000');
  // A send that throws after signing: the withdrawal waits for the chain; landed finishes it, expired gives it back.
  const send = r.chain.sendRawTransaction;
  r.chain.sendRawTransaction = async raw => { await send(raw); throw new Error('timeout'); };
  r.chain.confirm = false;
  const unsure = await post(r, '/f/agent/command', ownerCommand(a.owner, 'withdraw', { agentId: a.agentId, params: { all: true } }));
  assert.equal(unsure.status, 200, JSON.stringify(unsure.json));
  assert.equal(unsure.json.withdrawal.state, 'sending');
  assert.deepEqual([unsure.json.agent.balance.available, unsure.json.agent.balance.pendingWithdraw], ['0', '1000']);
  sound(r);
  assert.equal((await r.gateway.reconcile()).pending, 1);
  r.chain.statuses.set(unsure.json.withdrawal.signature, { slot: 81, err: null, confirmationStatus: 'confirmed' });
  assert.equal((await r.gateway.reconcile()).withdrawn, 1);
  assert.deepEqual([r.gateway.view(a.agentId).balance.pendingWithdraw, r.gateway.view(a.agentId).balance.withdrawn], ['0', '10000']);
  // Expired: back to available.
  await deposit(r, a.o, a.agentId, 700n);
  const exp = await post(r, '/f/agent/command', ownerCommand(a.owner, 'withdraw', { agentId: a.agentId, params: { amount: '700' } }));
  assert.equal(exp.json.withdrawal.state, 'sending');
  r.chain.height = 151;
  assert.equal((await r.gateway.reconcile()).withdrawalsFailed, 1);
  assert.equal(r.gateway.view(a.agentId).balance.available, '700');
  // A withdrawal that cannot even be built fails at once with the money back.
  r.chain.getLatestBlockhash = async () => { throw new Error('rpc down'); };
  r.ctx.blockhashes.cached = null;
  const broken = await post(r, '/f/agent/command', ownerCommand(a.owner, 'withdraw', { agentId: a.agentId, params: { amount: '700' } }));
  assert.equal(broken.json.code, ERR.WITHDRAW_FAILED);
  assert.equal(r.gateway.view(a.agentId).balance.available, '700');
  // Without custody: 503.
  const none = relay({ withCustody: false });
  const b = await createAgent(none, Keypair.generate());
  assert.equal((await post(none, '/f/agent/deposit', { agentId: b.agentId, signature: 'x'.repeat(80) })).status, 503);
  sound(r);
});

test('meterInference: a model call is held before and charged after, whether it succeeded or failed; the autopilot is free; an unaffordable call is never made', async () => {
  const r = relay({ prices: { inference: '10000' } });
  const a = await ready(r, { balance: 25_000n });
  let calls = 0;
  const ok = await r.gateway.meterInference(a.agentId, async () => { calls++; return { choice: 'Harvest', tokens: { prompt: 120, completion: 9 } }; }, { key: 'm1', model: 'test' });
  assert.deepEqual([ok.ok, ok.charged, ok.result.choice], [true, '10000', 'Harvest']);
  const bad = await r.gateway.meterInference(a.agentId, async () => { calls++; throw new Error('model: timeout'); }, { key: 'm2', model: 'test' });
  assert.deepEqual([bad.ok, bad.charged, bad.error.code], [false, '10000', ERR.INFERENCE_FAILED]);
  assert.equal(r.gateway.view(a.agentId).balance.spent.inference, '20000');
  const spends = r.gateway.view(a.agentId).history.filter(h => h.type === 'spend' && h.category === 'inference');
  assert.equal(spends.length, 2);
  assert.deepEqual(spends[0].tokens, { prompt: 120, completion: 9 });
  assert.equal(spends[1].ok, false);
  const free = await r.gateway.meterInference(a.agentId, async () => { calls++; return 'rule'; }, { free: true, model: 'autopilot' });
  assert.deepEqual([free.charged, free.result], ['0', 'rule']);
  // 5,000 left: the model is not called.
  await assert.rejects(r.gateway.meterInference(a.agentId, async () => { calls++; }, { key: 'm3' }), e => e.code === ERR.INSUFFICIENT_BALANCE);
  assert.equal(calls, 3);
  r.gateway.setMode(a.agentId, a.o, 'manual');
  await assert.rejects(r.gateway.meterInference(a.agentId, async () => { calls++; }, { free: true }), e => e.code === ERR.AGENT_STOPPED);
  assert.equal(calls, 3);
  sound(r);
});

test('after a restart: held holds are given back, sending ones wait for the chain; key files are the agent\'s own and mode 0600; no secret in the state or a view', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-keys-'));
  try {
    const r = relay({ prices: { game: { Harvest: '1000' } }, keyringDir: dir });
    const a = await ready(r, { balance: 5_000n });
    const res = await a.act({ key: 'r1' });
    assert.equal(res.status, 'sent');
    // Leave one hold `held` by hand (a request that died with its process).
    r.gateway.ledger.hold(a.agentId, { category: 'game', amount: '1000', key: 'dead', policyVersion: 1, modeEpoch: 1 });
    assert.deepEqual([r.gateway.view(a.agentId).balance.available, r.gateway.view(a.agentId).balance.reserved], ['3000', '2000']);
    const files = readdirSync(dir);
    assert.deepEqual(files, [`${a.agentId}.key`]);
    assert.equal(statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
    const json = JSON.stringify(r.agentStore.state);
    assert.equal(json.includes(a.capability), false, 'no token');
    assert.equal(json.includes(Buffer.from(r.custodyKey.secretKey.slice(0, 32)).toString('hex')), false, 'no custody seed');
    assert.equal(JSON.stringify(r.gateway.view(a.agentId)).includes('secret'), false);
    assert.equal(JSON.stringify(r.gateway).includes('secretKey'), false);
    // The same state and key directory in a new process.
    const again = relay({ chain: r.chain, prices: { game: { Harvest: '1000' } }, keyringDir: dir, agentState: JSON.parse(json) });
    const v = again.gateway.view(a.agentId);
    assert.deepEqual([v.balance.available, v.balance.reserved], ['4000', '1000'], 'the dead hold came back; the sent one waits');
    assert.ok(v.history.some(h => h.type === 'release' && h.reason === 'restart'));
    assert.equal(again.gateway.keyring.publicKey(a.agentId), a.agentKey, 'the key was read back from its file');
    assert.equal((await again.gateway.reconcile()).settled, 1);
    assert.equal(again.gateway.view(a.agentId).balance.spent.game, '1000');
    // The new process signs with the same key.
    const next = await again.gateway.submit(actionRequest(a.agentId, { key: 'r2', policyVersion: 1 }), { capability: a.capability });
    assert.equal(next.status, 'sent', JSON.stringify(next));
    assert.equal(again.chain.sent.at(-1).signers[1], a.agentKey);
    sound(again);
    // The custody view is public keys only.
    assert.deepEqual(Object.keys(r.custody.toJSON()).sort(), ['account', 'authority', 'mint']);
    assert.ok(decodeTokenAccount(r.chain.accounts.get(r.custody.account).data));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
