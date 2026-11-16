// WRITTEN, NOT RUN (2026-11-16, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// The RunReceipt's `from4` act fields filled from ④'s act registry receipt (p04-acts/0.1), the mapping of ④'s
// toP05Act (workstreams/04-execution/clients/acts.mjs:106; EXECUTION-CONTRACT-20261106 §7.3):
//   F1 a registry receipt fills run4Id, idempotencyKey, source, signedAt, fate (④'s state), cancellable, cancel.until
//   F2 without a registry receipt the act is exactly as before (the autopilot without `acts`)
//   F3 a registry receipt for another signature fills nothing and is kept as from4.mismatch
//   F4 only ④'s REAL registry clears the act fields from missingFrom4; the substitute leaves them listed
//   F5 refreshFates without a fate reader keeps the registry's fate (GET /f/tx never replaces it)
//   F6 the receipt still passes the port's conformance checks
// KEY-FREE: imports run-receipt.mjs and its conformance file only (neither imports anything else). The relay is a stub
// object, the registry receipts are written by hand in ④'s receipt shape; nothing is signed, sent, read from disk or
// fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACT_FROM4_FIELDS, actFrom4, localReceiptPort } from '../src/run-receipt.mjs';
import { conformance } from '../src/run-receipt.conformance.mjs';

const KEY = 'ai:p05.attempt-1';
const view = async () => ({ agentId: 'agent1', citizen: 'c1', policy: { version: 3 }, modeEpoch: 1, historySeq: 7,
  history: [{ type: 'action', key: KEY, source: 'ai' }], holds: [] });
/** One act's receipt as acts-port.mjs returns it (④'s p04-acts/0.1 fields, plus connection, port, next). */
const receipt4 = ({ state = 'landed', signature = 'sigA', connection = 'real' } = {}) => ({
  receiptVersion: 'p04-acts/0.1', run4Id: 'act-008445dbab443860', runId: 'p05-autopilot:agent1', agentId: 'agent1', idempotencyKey: KEY, source: 'ai',
  state, final: ['landed', 'failed', 'expired', 'not-sent'].includes(state), signature, signedAt: 1_762_000_000_000, lastValidBlockHeight: 5000,
  slotFloor: 10, commitment: 'finalized', why: null, lastReadError: null, conflict: null, cancellable: false,
  cancel: { stage: 'sent', result: 'Irrevocable', until: { lastValidBlockHeight: 5000 }, phase: 'Completed' }, retention: { retentionBells: null, deleted: false },
  connection, port: connection === 'real' ? '④ runexec act (run store)' : '⑤ local substitute (acts-registry.mjs)', next: 'done', newAttemptAllowed: false,
});

async function run({ registry, txState = async () => ({ state: 'expired' }) }) {
  const port = localReceiptPort({ view, txState });
  await port.open({ runId: 't1', decisionKey: 'dk1' });
  port.attachAct('t1', { requestId: 'p05.attempt-1', outcome: 'sent', signature: 'sigA', proposed: { name: 'Train' }, registry });
  return { port, r: await port.close('t1') };
}

test('F1 a registry receipt fills the act fields only ④ gives (toP05Act)', async () => {
  const { r } = await run({ registry: receipt4() });
  const a = r.acts[0];
  assert.deepEqual([a.idempotencyKey, a.source, a.signature, a.signedAt, a.fate, a.cancellable, a.lastValidBlockHeight],
    [KEY, 'ai', 'sigA', 1_762_000_000_000, 'landed', false, 5000]);
  assert.deepEqual(a.from4, { connection: 'real', port: '④ runexec act (run store)', run4Id: 'act-008445dbab443860', commitment: 'finalized',
    cancel: { stage: 'sent', result: 'Irrevocable', until: { lastValidBlockHeight: 5000 } } });
  assert.deepEqual(actFrom4(receipt4()).cancel.until, { lastValidBlockHeight: 5000 });
});

test('F2 without a registry receipt the act is as before', async () => {
  const { r } = await run({ registry: null });
  const a = r.acts[0];
  assert.deepEqual([a.signedAt, a.fate, a.cancellable, 'from4' in a, 'lastValidBlockHeight' in a], [null, 'unknown', null, false, false]);
  assert.equal(a.idempotencyKey, KEY, 'read back from the relay history, as before');
  assert.deepEqual(r.missingFrom4, ['run4Id', ...ACT_FROM4_FIELDS, 'cancel.stage', 'cancel.until']);
});

test('F3 a registry receipt for another signature fills nothing', async () => {
  const { r } = await run({ registry: receipt4({ signature: 'sigOther' }) });
  const a = r.acts[0];
  assert.deepEqual([a.signature, a.signedAt, a.fate, a.cancellable], ['sigA', null, 'unknown', null]);
  assert.match(a.from4.mismatch, /sigOther/);
  assert.ok(r.missingFrom4.includes('acts[].signedAt'));
});

test('F4 only the REAL registry clears the act fields from missingFrom4', async () => {
  const real = (await run({ registry: receipt4() })).r;
  const sub = (await run({ registry: receipt4({ connection: 'substitute' }) })).r;
  for (const k of ACT_FROM4_FIELDS) {
    assert.ok(!real.missingFrom4.includes(k), `real: ${k} no longer missing`);
    assert.ok(sub.missingFrom4.includes(k), `substitute: ${k} still missing`);
  }
  assert.ok(real.missingFrom4.includes('run4Id'), 'the run-level ④ id is not given by an act receipt');
  assert.equal(sub.acts[0].from4.connection, 'substitute');
});

test('F5 refreshFates without a fate reader keeps the registry fate', async () => {
  const { port } = await run({ registry: receipt4({ state: 'pending' }) });
  const r = await port.refreshFates('t1');
  assert.equal(r.acts[0].fate, 'pending', 'GET /f/tx `expired` does not replace ④\'s state');
});

test('F6 the receipt passes the port conformance checks', async () => {
  for (const registry of [receipt4(), receipt4({ connection: 'substitute' }), receipt4({ signature: 'sigOther' }), null]) {
    const { r } = await run({ registry });
    assert.deepEqual(conformance(r), []);
  }
});
