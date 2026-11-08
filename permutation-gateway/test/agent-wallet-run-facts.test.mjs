// Workstream 04: what a run follows after the agent wallet signed. No keys are made or used here and nothing is
// signed: the node is a fake object, the records are plain data.
//   - fate.mjs answers carry the commitment the node reported and whether the node could be asked at all;
//   - actionFateView turns an action record and that answer into one state: not-sent, landed, failed, expired,
//     pending, unknown (result unknown) or unqueryable (could not ask, or the record is not kept);
//   - AgentGateway#actionFate reads the kept history entry by idempotency key and asks the chain by the same rule
//     reconcile uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fateOf } from '../src/frontier/agent/fate.mjs';
import { AgentGateway, actionFateView } from '../src/frontier/agent/gateway.mjs';

const node = ({ status = null, height = 100, tx = null, first = null, fail = {} } = {}) => ({
  async getSignatureStatuses() { if (fail.status) throw new Error('rpc down'); return { value: [status] }; },
  async getBlockHeight() { if (fail.height) throw new Error('rpc down'); return height; },
  async getTransaction() { if (fail.tx) throw new Error('rpc down'); return tx; },
  async getFirstAvailableBlock() { if (first === null) throw new Error('Method not found'); return first; },
});
const sent = { signature: 'sig1', lastValidBlockHeight: 150, slotFloor: 400 };

test('fateOf reports the commitment it saw; only finalized decides', async () => {
  for (const c of ['processed', 'confirmed']) {
    const f = await fateOf(node({ status: { confirmationStatus: c, err: null } }), sent);
    assert.deepEqual([f.fate, f.commitment, f.queryFailed], ['pending', c, false]);
  }
  const e = await fateOf(node({ status: { confirmationStatus: 'confirmed', err: { x: 1 } } }), sent);
  assert.deepEqual([e.fate, e.commitment], ['pending', 'confirmed'], 'an error before finality is not a failure');
  const l = await fateOf(node({ status: { confirmationStatus: 'finalized', err: null } }), sent);
  assert.deepEqual([l.fate, l.commitment], ['landed', 'finalized']);
  const none = await fateOf(node({ height: 120 }), sent);
  assert.deepEqual([none.fate, none.commitment, none.queryFailed], ['pending', null, false], 'no status, inside its lifetime');
  const late = await fateOf(node({ height: 200, tx: { meta: { err: null } } }), sent);
  assert.deepEqual([late.fate, late.commitment], ['landed', 'finalized'], 'found by getTransaction at finalized');
});

test('fateOf separates "could not ask" from "cannot prove"', async () => {
  for (const fail of [{ status: true }, { height: true }]) {
    const f = await fateOf(node({ fail }), sent);
    assert.deepEqual([f.fate, f.queryFailed], ['pending', true], JSON.stringify(fail));
  }
  const tx = await fateOf(node({ height: 200, fail: { tx: true }, first: 0 }), sent);
  assert.deepEqual([tx.fate, tx.queryFailed], ['unknown', true]);
  const pruned = await fateOf(node({ height: 200, first: 401 }), sent);
  assert.deepEqual([pruned.fate, pruned.queryFailed], ['unknown', false], 'history starts after the send: result unknown, the node answered');
  const proved = await fateOf(node({ height: 200, first: 0 }), sent);
  assert.deepEqual([proved.fate, proved.queryFailed], ['expired', false]);
});

test('actionFateView: one state per record and answer', () => {
  assert.equal(actionFateView(null).state, 'unqueryable');
  assert.equal(actionFateView(null).retained, false, 'not kept here is not "not sent"');
  assert.equal(actionFateView({ key: 'k', status: 'refused', code: 'BudgetExceeded' }).state, 'not-sent');
  assert.equal(actionFateView({ key: 'k', status: 'failed', code: 'SendFailed', sent: false }).state, 'not-sent');
  assert.equal(actionFateView({ key: 'k', status: 'failed', code: 'SendFailed' }).state, 'unknown', 'an older failure without sent/signature may have left');
  const rec = { key: 'k', status: 'failed', code: 'SendFailed', sent: true, signature: 'sig1', lastValidBlockHeight: 150, slotFloor: 400, signedAt: 1700 };
  const pend = actionFateView(rec, { fate: 'pending', why: 'status confirmed', commitment: 'confirmed', queryFailed: false });
  assert.deepEqual([pend.state, pend.signature, pend.lastValidBlockHeight, pend.slotFloor, pend.signedAt, pend.commitment], ['pending', 'sig1', 150, 400, 1700, 'confirmed']);
  assert.equal(actionFateView(rec, { fate: 'landed', why: 'finalized', commitment: 'finalized', queryFailed: false }).state, 'landed', 'a failed answer whose bytes landed is landed');
  assert.equal(actionFateView(rec, { fate: 'pending', why: 'rpc down', commitment: null, queryFailed: true }).state, 'unqueryable');
  assert.equal(actionFateView(rec, { fate: 'unknown', why: 'history starts later', commitment: null, queryFailed: false }).state, 'unknown');
  assert.equal(actionFateView(rec, { fate: 'expired', why: 'proved', commitment: null, queryFailed: false }).state, 'expired');
});

test('AgentGateway#actionFate: the latest kept entry by key, asked by the reconcile rule', async () => {
  const history = [
    { type: 'action', key: 'k1', status: 'sent', sent: true, signature: 'sigA', lastValidBlockHeight: 150, slotFloor: 400, signedAt: 1 },
    { type: 'decision', key: 'k1' },
    { type: 'action', key: 'k2', status: 'refused', code: 'ActionNotAllowed' },
  ];
  const self = (connection, custody = null) => ({ ledger: { get: () => ({ history }) }, custody, ctx: { connection }, fullHistory: false });
  const a = await AgentGateway.prototype.actionFate.call(self(node({ status: { confirmationStatus: 'finalized', err: null } })), 'agent1', 'k1');
  assert.deepEqual([a.agentId, a.state, a.signature, a.commitment], ['agent1', 'landed', 'sigA', 'finalized']);
  const b = await AgentGateway.prototype.actionFate.call(self(node({ fail: { status: true } })), 'agent1', 'k1');
  assert.equal(b.state, 'unqueryable');
  const c = await AgentGateway.prototype.actionFate.call(self(node()), 'agent1', 'k2');
  assert.equal(c.state, 'not-sent');
  const d = await AgentGateway.prototype.actionFate.call(self(node()), 'agent1', 'gone');
  assert.deepEqual([d.state, d.retained], ['unqueryable', false]);
  // With a Custody, its reading is used (the same object reconcile asks).
  const custody = { async fate() { return { fate: 'unknown', why: 'custody says so', commitment: null, queryFailed: false }; } };
  const e = await AgentGateway.prototype.actionFate.call(self(node(), custody), 'agent1', 'k1');
  assert.deepEqual([e.state, e.why], ['unknown', 'custody says so']);
});
