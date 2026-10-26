// The reconciliation rule (src/frontier/agent/fate.mjs; STATUS-2026-10-23.ja.md §6): time passing is not
// evidence. A sent hold or withdrawal is settled only when finalized; it is given back only when the node
// proves the transaction never landed (no status, past its lifetime, no transaction at finalized, and history
// that covers the send) — and a withdrawal only when the custody account still holds the money. Anything else
// stays reserved and is marked for the operator once. One relay process per state file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { fateOf, slotFloorOf } from '../src/frontier/agent/fate.mjs';
import { lockStateFile } from '../src/frontier/agent/lock.mjs';
import { AgentGateway } from '../src/frontier/agent/gateway.mjs';
import { call, createAgent, deposit, MINT, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';
import { tokenAccountData } from './gateway-fixtures.mjs';

const post = (r, p, body) => call(r.public, 'POST', p, { body, ip: '127.0.0.1' });

/** A node: `status` (or null), `height` (finalized), `tx` (getTransaction at finalized, or null), `first` (getFirstAvailableBlock, a number, null = unsupported). */
const node = ({ status = null, height = 100, tx = null, first = null, fail = {} } = {}) => ({
  async getSignatureStatuses() { if (fail.status) throw new Error('rpc'); return { value: [status] }; },
  async getBlockHeight(c) { assert.equal(c, 'finalized'); if (fail.height) throw new Error('rpc'); return height; },
  async getTransaction(_s, o) { assert.equal(o.commitment, 'finalized'); if (fail.tx) throw new Error('rpc'); return tx; },
  async getFirstAvailableBlock() { if (first === null) throw new Error('Method not found'); return first; },
  async getSlot(c) { assert.equal(c, 'finalized'); return 500; },
});
const sent = { signature: 'sig', lastValidBlockHeight: 150, slotFloor: 400 };

test('fateOf: finalized decides; confirmed waits; no status inside the lifetime waits', async () => {
  assert.equal((await fateOf(node({ status: { confirmationStatus: 'finalized', err: null } }), sent)).fate, 'landed');
  assert.equal((await fateOf(node({ status: { confirmationStatus: 'finalized', err: { InstructionError: [0, 'x'] } } }), sent)).fate, 'failed');
  for (const c of ['confirmed', 'processed', undefined]) assert.equal((await fateOf(node({ status: { confirmationStatus: c, err: null } }), sent)).fate, 'pending', `${c} is not final`);
  assert.equal((await fateOf(node({ status: { confirmationStatus: 'confirmed', err: { x: 1 } } }), sent)).fate, 'pending', 'a confirmed error is not final either');
  assert.equal((await fateOf(node({ height: 150 }), sent)).fate, 'pending', 'at the last valid height it can still land');
  assert.equal((await fateOf(node({ fail: { status: true } }), sent)).fate, 'pending', 'an unreadable status decides nothing');
  assert.equal((await fateOf(node({ fail: { height: true } }), sent)).fate, 'pending');
});

test('fateOf: past its lifetime, "expired" needs no transaction at finalized AND history that covers the send', async () => {
  const past = { height: 151 };
  // A lagging status index: the transaction itself is there.
  assert.equal((await fateOf(node({ ...past, tx: { meta: { err: null } } }), sent)).fate, 'landed');
  assert.equal((await fateOf(node({ ...past, tx: { meta: { err: { x: 1 } } } }), sent)).fate, 'failed');
  // No transaction: the node's history decides.
  assert.equal((await fateOf(node({ ...past, first: 0 }), sent)).fate, 'expired', 'history from slot 0 covers slot 400');
  assert.equal((await fateOf(node({ ...past, first: 400 }), sent)).fate, 'expired', 'history from the floor itself covers it');
  const pruned = await fateOf(node({ ...past, first: 401 }), sent);
  assert.equal(pruned.fate, 'unknown', 'history starts after the send: cannot prove');
  assert.match(pruned.why, /cannot show the transaction never landed/);
  assert.equal((await fateOf(node({ ...past, first: null }), sent)).fate, 'unknown', 'no getFirstAvailableBlock');
  assert.equal((await fateOf(node({ ...past, first: 0 }), { ...sent, slotFloor: null })).fate, 'unknown', 'no slot recorded before the send');
  assert.equal((await fateOf(node({ ...past, fail: { tx: true }, first: 0 }), sent)).fate, 'unknown', 'an unreadable transaction is not an absent one');
  assert.equal((await fateOf(node({ ...past }), { ...sent, lastValidBlockHeight: null })).fate, 'unknown', 'no lifetime recorded');
  // The in-process local chain keeps everything: no proof needed.
  assert.equal((await fateOf(node({ ...past, first: null }), { ...sent, slotFloor: null }, { fullHistory: true })).fate, 'expired');
  assert.equal(await slotFloorOf(node()), 500);
  assert.equal(await slotFloorOf({ async getSlot() { throw new Error('rpc'); } }), null);
});

async function owner(r, balance) {
  const kp = Keypair.generate();
  const o = kp.publicKey.toBase58();
  const made = await createAgent(r, kp, { policy: policy(['economy']) });
  await deposit(r, o, made.agentId, balance);
  return { kp, o, ...made };
}
const setCustodyBalance = (r, amount) => r.chain.set(r.custody.account, { data: tokenAccountData({ mint: MINT, owner: r.custody.authority, amount }) });

test('a withdrawal that landed, read from a node without history, is never given back (no second withdrawal), across restarts', async () => {
  const r = relay();
  const a = await owner(r, 10_000n);
  setCustodyBalance(r, 10_000n);
  // The send times out; the transfer did land (the custody account lost the 6,000) but this node keeps no history of it.
  const send = r.chain.sendRawTransaction;
  r.chain.confirm = false;
  r.chain.sendRawTransaction = async raw => { await send(raw); throw new Error('timeout'); };
  const w = await post(r, '/f/agent/command', ownerCommand(a.kp, 'withdraw', { agentId: a.agentId, params: { amount: '6000' } }));
  assert.equal(w.json.withdrawal.state, 'sending');
  const rec = r.gateway.ledger.get(a.agentId);
  const sentW = rec.withdrawals[w.json.withdrawal.id];
  assert.equal(sentW.slotFloor, 77, 'the slot read before the transaction was built is recorded');
  setCustodyBalance(r, 4_000n);
  r.chain.height = 151;
  r.chain.getFirstAvailableBlock = async () => 1_000;          // history starts long after the send
  for (let i = 0; i < 3; i++) assert.equal((await r.gateway.reconcile()).undecided, 1);
  let v = r.gateway.view(a.agentId);
  assert.deepEqual([v.balance.available, v.balance.pendingWithdraw, v.balance.withdrawn], ['4000', '6000', '0'], 'the 6,000 is not available again');
  assert.equal(v.history.filter(h => h.type === 'undecided').length, 1, 'marked once, not once per reconcile');
  assert.equal(r.gateway.ledger.db.operatorCosts.filter(c => c.kind === 'undecided-withdrawal').length, 1, 'the operator is told once');
  // The owner asks for everything: only the 4,000 that is really available can go.
  r.chain.sendRawTransaction = send;
  r.chain.confirm = true;
  const all = await post(r, '/f/agent/command', ownerCommand(a.kp, 'withdraw', { agentId: a.agentId, params: { all: true } }));
  assert.equal(all.json.withdrawal.amount, '4000');
  // A restart (the state file read back by a new gateway): the undecided withdrawal stays as it is.
  const again = new AgentGateway({ ctx: r.ctx, ledger: r.gateway.ledger, keyring: r.gateway.keyring, custody: r.custody });
  assert.equal(again.ledger.get(a.agentId).withdrawals[w.json.withdrawal.id].state, 'sending');
  assert.equal((await again.reconcile()).undecided, 1);
  v = again.view(a.agentId);
  assert.deepEqual([v.balance.available, v.balance.pendingWithdraw], ['0', '6000']);
  sound(r);
});

test('a node that wrongly claims history: the custody balance still stops a landed withdrawal from coming back', async () => {
  const r = relay();
  const a = await owner(r, 10_000n);
  setCustodyBalance(r, 10_000n);
  const send = r.chain.sendRawTransaction;
  r.chain.confirm = false;
  r.chain.sendRawTransaction = async raw => { await send(raw); throw new Error('timeout'); };
  const w = await post(r, '/f/agent/command', ownerCommand(a.kp, 'withdraw', { agentId: a.agentId, params: { amount: '6000' } }));
  setCustodyBalance(r, 4_000n);                                 // the money left
  r.chain.height = 151;
  r.chain.getFirstAvailableBlock = async () => 0;               // ...but the node says its history is complete and finds nothing
  assert.equal((await r.gateway.reconcile()).undecided, 1);
  const v = r.gateway.view(a.agentId);
  assert.deepEqual([v.balance.available, v.balance.pendingWithdraw], ['4000', '6000']);
  assert.match(r.gateway.ledger.get(a.agentId).withdrawals[w.json.withdrawal.id].undecided.why, /custody account holds 4000 for liabilities of 10000/);
  // When the money is really there (the transfer never ran), it comes back.
  setCustodyBalance(r, 10_000n);
  assert.equal((await r.gateway.reconcile()).withdrawalsFailed, 1);
  assert.equal(r.gateway.view(a.agentId).balance.available, '10000');
  sound(r);
});

test('a priced action is settled only at finalized; its slot floor is recorded', async () => {
  const r = relay({ prices: { game: { Harvest: '500' } } });
  const a = await owner(r, 10_000n);
  const { delegate } = await import('./agent-wallet-fixtures.mjs');
  delegate(r, a.o, a.agentKey);
  await post(r, '/f/agent/command', ownerCommand(a.kp, 'mode', { agentId: a.agentId, params: { mode: 'auto' } }));
  r.chain.confirm = false;
  const v0 = r.gateway.view(a.agentId);
  const res = await r.gateway.submit({ agentId: a.agentId, source: 'mcp', idempotencyKey: 'fate-hold-1', policyVersion: v0.policy.version, modeEpoch: v0.modeEpoch, action: { name: 'Harvest', holding: v0.village, fields: {} } }, { capability: a.capability });
  assert.equal(res.status, 'sent');
  const hold = Object.values(r.gateway.ledger.get(a.agentId).holds).find(h => h.state === 'sending');
  assert.equal(hold.slotFloor, 77);
  r.chain.statuses.set(res.signature, { slot: 78, err: null, confirmationStatus: 'confirmed' });
  assert.equal((await r.gateway.reconcile()).pending, 1, 'confirmed is not final');
  assert.equal(r.gateway.view(a.agentId).balance.reserved, '500');
  r.chain.statuses.set(res.signature, { slot: 78, err: null, confirmationStatus: 'finalized' });
  assert.equal((await r.gateway.reconcile()).settled, 1);
  assert.deepEqual([r.gateway.view(a.agentId).balance.reserved, r.gateway.view(a.agentId).balance.spent.game], ['0', '500']);
  sound(r);
});

test('one relay process per state file: a live holder is refused, a dead one is taken over, release removes only its own lock', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aw-lock-'));
  const state = path.join(dir, 'sub', 'agent-wallet.json');
  const a = lockStateFile(state, { pid: 1111, isAlive: () => true });
  assert.equal(readFileSync(a.path, 'utf8').trim(), '1111');
  assert.throws(() => lockStateFile(state, { pid: 2222, isAlive: () => true }), /in use by process 1111/);
  // The holder crashed: taken over.
  const b = lockStateFile(state, { pid: 2222, isAlive: pid => pid !== 1111 });
  assert.equal(readFileSync(b.path, 'utf8').trim(), '2222');
  assert.ok(existsSync(`${b.path}.stale-1111`));
  // The old holder's release must not remove the new holder's lock.
  a.release();
  assert.equal(readFileSync(b.path, 'utf8').trim(), '2222');
  b.release();
  assert.equal(existsSync(b.path), false);
  // An unreadable lock is treated as held.
  writeFileSync(b.path, 'garbage');
  assert.throws(() => lockStateFile(state, { pid: 3333, isAlive: () => false }), /in use/);
});

test('the page says what cannot be decided, apart from what is available', async () => {
  const { balanceModel, historyRows, renderBalance } = await import('../../permutation-server/web/frontier/fagent.mjs');
  const view = { balance: { deposited: '10000', available: '4000', reserved: '0', pendingWithdraw: '6000', withdrawn: '0', spent: {} },
    withdrawals: [{ id: 'w1', amount: '6000', state: 'sending', undecided: { why: 'x' } }, { id: 'w2', amount: '1', state: 'done' }], holds: [],
    history: [{ type: 'undecided', kind: 'withdrawal', at: 1, amount: '6000' }] };
  const m = balanceModel(view);
  assert.deepEqual([m.withdrawable, m.undecided], ['0.004', '0.006']);
  assert.match(String(renderBalance(view)), /確定できない送信が 0\.006/);
  assert.match(historyRows(view)[0].text, /引き出しの結果をチェーンで確定できません/);
  assert.equal(balanceModel({ ...view, withdrawals: [] }).undecided, '0');
  assert.doesNotMatch(String(renderBalance({ ...view, withdrawals: [] })), /確定できない送信/);
});
