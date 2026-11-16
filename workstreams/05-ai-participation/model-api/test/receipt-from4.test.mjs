// WRITTEN, NOT RUN (2026-11-16/17, under an execution pause): no part of this file has been executed. Run it only
// through the repository's key-free guard once runs are allowed again.
//
// The RunReceipt's `from4` act fields filled from ④'s act registry receipt (p04-acts/0.1), the mapping of ④'s
// toP05Act (workstreams/04-execution/clients/acts.mjs:106; EXECUTION-CONTRACT-20261106 §7.3):
//   F1 a registry receipt fills run4Id, idempotencyKey, source, signedAt, fate (④'s state), cancellable, cancel.until,
//      and says the receipt is no evidence of a chain (chain: null)
//   F2 without a registry receipt the act is exactly as before (the autopilot without `acts`)
//   F3 a registry receipt for another signature fills nothing and is kept as from4.mismatch
//   F4 only ④'s REAL registry clears the act fields from missingFrom4; the substitute leaves them listed
//   F5 refreshFates without a fate reader keeps the registry's fate (GET /f/tx never replaces it)
//   F6 the receipt still passes the port's conformance checks
//   F7 a registry receipt for another key (not <source>:<requestId>) fills nothing
//   F8 close: with the registry's key, only that exact history entry is read (another source's entry is not mixed in);
//      an entry carrying another signature is never matched
//   F9 close without a registry: two different keys ending in :<requestId> are ambiguous, neither is picked
//   F10 refreshFates with a fate reader: a read for another signature changes nothing
//   F11 refreshFates with a fate reader: a final state from the registry does not change; facts are kept
//   F12 a REAL registry that gave no signedAt (store-only or failed read) leaves acts[].signedAt missing
//   F13 readVia (acts-port.mjs: gateway | store-only) is carried into from4 as given, null when missing or unknown, on
//       the mismatch path too; it changes no fate, finality or missingFrom4
// KEY-FREE: imports run-receipt.mjs and its conformance file only (neither imports anything else). The relay and the
// fate reader are stub functions, the registry receipts are written by hand in ④'s receipt shape; nothing is signed,
// sent, read from disk or fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACT_FROM4_FIELDS, REGISTRY_CHAIN_NOTE, actFrom4, localReceiptPort } from '../src/run-receipt.mjs';
import { conformance } from '../src/run-receipt.conformance.mjs';

const KEY = 'ai:p05.attempt-1';
const viewWith = history => async () => ({ agentId: 'agent1', citizen: 'c1', policy: { version: 3 }, modeEpoch: 1, historySeq: 7, history, holds: [] });
const view = viewWith([{ type: 'action', key: KEY, source: 'ai' }]);
/** One act's receipt as acts-port.mjs returns it (④'s p04-acts/0.1 fields, plus connection, port, next). */
const receipt4 = ({ state = 'landed', signature = 'sigA', connection = 'real', key = KEY, signedAt = 1_762_000_000_000 } = {}) => ({
  receiptVersion: 'p04-acts/0.1', run4Id: 'act-008445dbab443860', runId: 'p05-autopilot:agent1', agentId: 'agent1', idempotencyKey: key, source: 'ai',
  state, final: ['landed', 'failed', 'expired', 'not-sent'].includes(state), signature, signedAt, lastValidBlockHeight: 5000,
  slotFloor: 10, commitment: 'finalized', why: null, lastReadError: null, conflict: null, cancellable: false,
  cancel: { stage: 'sent', result: 'Irrevocable', until: { lastValidBlockHeight: 5000 }, phase: 'Completed' }, retention: { retentionBells: null, deleted: false },
  connection, port: connection === 'real' ? '④ runexec act (run store)' : '⑤ local substitute (acts-registry.mjs)', next: 'done', newAttemptAllowed: false,
});

async function run({ registry, txState = async () => ({ state: 'expired' }), fate = null, v = view }) {
  const port = localReceiptPort({ view: v, txState, fate });
  await port.open({ runId: 't1', decisionKey: 'dk1' });
  port.attachAct('t1', { requestId: 'p05.attempt-1', outcome: 'sent', signature: 'sigA', proposed: { name: 'Train' }, registry });
  return { port, r: await port.close('t1') };
}

test('F1 a registry receipt fills the act fields only ④ gives (toP05Act), and is no chain evidence', async () => {
  const { r } = await run({ registry: receipt4() });
  const a = r.acts[0];
  assert.deepEqual([a.idempotencyKey, a.source, a.signature, a.signedAt, a.fate, a.cancellable, a.lastValidBlockHeight],
    [KEY, 'ai', 'sigA', 1_762_000_000_000, 'landed', false, 5000]);
  assert.deepEqual(a.from4, { connection: 'real', port: '④ runexec act (run store)', readVia: null, run4Id: 'act-008445dbab443860', commitment: 'finalized',
    cancel: { stage: 'sent', result: 'Irrevocable', until: { lastValidBlockHeight: 5000 } }, chain: null, chainWhy: REGISTRY_CHAIN_NOTE });
  assert.match(REGISTRY_CHAIN_NOTE, /not that a chain executed the act/);
  assert.deepEqual(actFrom4(receipt4()).cancel.until, { lastValidBlockHeight: 5000 });
});

test('F2 without a registry receipt the act is as before', async () => {
  const { r } = await run({ registry: null });
  const a = r.acts[0];
  assert.deepEqual([a.signedAt, a.fate, a.cancellable, 'from4' in a, 'lastValidBlockHeight' in a, 'historyAmbiguous' in a], [null, 'unknown', null, false, false, false]);
  assert.equal(a.idempotencyKey, KEY, 'read back from the relay history, as before');
  assert.deepEqual(r.missingFrom4, ['run4Id', ...ACT_FROM4_FIELDS, 'cancel.stage', 'cancel.until']);
});

test('F3 a registry receipt for another signature fills nothing', async () => {
  const { r } = await run({ registry: receipt4({ signature: 'sigOther' }) });
  const a = r.acts[0];
  assert.deepEqual([a.signature, a.signedAt, a.fate, a.cancellable], ['sigA', null, 'unknown', null]);
  assert.match(a.from4.mismatch, /sigOther/);
  assert.equal(a.from4.chain, null);
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
  for (const registry of [receipt4(), receipt4({ connection: 'substitute' }), receipt4({ signature: 'sigOther' }), receipt4({ key: 'mcp:p05.attempt-1' }), null]) {
    const { r } = await run({ registry });
    assert.deepEqual(conformance(r), []);
  }
});

test('F7 a registry receipt for another key fills nothing', async () => {
  for (const key of ['ai:p05.attempt-2', 'mcp:p05.attempt-1', null]) {
    const { r } = await run({ registry: receipt4({ key }) });
    const a = r.acts[0];
    assert.deepEqual([a.signedAt, a.fate, a.cancellable], [null, 'unknown', null], String(key));
    assert.match(a.from4.mismatch, /another key/);
  }
});

test('F8 close reads only the registry key; another source or another signature is not mixed in', async () => {
  // the other source's entry comes first: the old suffix match would have taken it
  const both = viewWith([{ type: 'action', key: 'mcp:p05.attempt-1', source: 'mcp' }, { type: 'action', key: KEY, source: 'ai' }]);
  const a = (await run({ registry: receipt4(), v: both })).r.acts[0];
  assert.deepEqual([a.idempotencyKey, a.source], [KEY, 'ai']);
  // a history entry under the same key but another signature is never this act's
  const other = viewWith([{ type: 'action', key: KEY, source: 'ai', signature: 'sigOther' }]);
  const b = (await run({ registry: null, v: other })).r.acts[0];
  assert.deepEqual([b.idempotencyKey, b.source], [null, null]);
});

test('F9 close without a registry: two keys ending in :<requestId> are ambiguous', async () => {
  const two = viewWith([{ type: 'action', key: 'mcp:p05.attempt-1', source: 'mcp' }, { type: 'action', key: KEY, source: 'ai' }]);
  const a = (await run({ registry: null, v: two })).r.acts[0];
  assert.equal(a.idempotencyKey, null);
  assert.deepEqual(a.historyAmbiguous, ['mcp:p05.attempt-1', KEY]);
});

test('F10 a fate read for another signature changes nothing', async () => {
  const fate = async () => ({ state: 'failed', signature: 'sigOther', signedAt: 1, lastValidBlockHeight: 1 });
  for (const registry of [null, receipt4({ state: 'pending' })]) {
    const { port } = await run({ registry, fate });
    const before = port.get('t1').acts[0];
    const a = (await port.refreshFates('t1')).acts[0];
    assert.deepEqual([a.fate, a.signature, a.signedAt, a.lastValidBlockHeight ?? null], [before.fate, 'sigA', before.signedAt, before.lastValidBlockHeight ?? null]);
    assert.match(a.fateRead.mismatch, /sigOther/);
  }
});

test('F11 a final registry state does not change on a later fate read; known facts are kept', async () => {
  const contradict = async () => ({ state: 'unknown', signature: 'sigA', signedAt: null, lastValidBlockHeight: null, why: 'history gap' });
  const { port } = await run({ registry: receipt4({ state: 'landed' }), fate: contradict });
  const a = (await port.refreshFates('t1')).acts[0];
  assert.deepEqual([a.fate, a.signedAt, a.lastValidBlockHeight], ['landed', 1_762_000_000_000, 5000]);
  assert.deepEqual(a.fateRead, { conflict: { state: 'unknown', why: 'history gap' } });
  // a non-final registry state is followed by the read, and facts the read lacks are kept
  const later = async () => ({ state: 'landed', signature: 'sigA', signedAt: null, lastValidBlockHeight: null });
  const p2 = (await run({ registry: receipt4({ state: 'pending' }), fate: later })).port;
  const b = (await p2.refreshFates('t1')).acts[0];
  assert.deepEqual([b.fate, b.signedAt, b.lastValidBlockHeight], ['landed', 1_762_000_000_000, 5000]);
});

test('F12 a REAL registry without signedAt leaves acts[].signedAt missing', async () => {
  const { r } = await run({ registry: receipt4({ state: 'registered', signedAt: null }) });
  assert.ok(r.missingFrom4.includes('acts[].signedAt'), 'the registry gave no value: still missing');
  assert.ok(!r.missingFrom4.includes('acts[].cancellable'), 'cancellable is given (false) by ④\'s receipt');
});

test('F13 readVia is carried as an observation-source class only', async () => {
  for (const [given, want] of [['gateway', 'gateway'], ['store-only', 'store-only'], [undefined, null], [null, null], ['chain', null]]) {
    const ok = (await run({ registry: { ...receipt4(), readVia: given } })).r;
    assert.equal(ok.acts[0].from4.readVia, want, `matched: ${given}`);
    assert.equal(actFrom4({ ...receipt4(), readVia: given }).readVia, want);
    const bad = (await run({ registry: { ...receipt4({ signature: 'sigOther' }), readVia: given } })).r;
    assert.equal(bad.acts[0].from4.readVia, want, `mismatch: ${given}`);
  }
  // the same fate, finality and missingFrom4 whatever readVia says
  const g = (await run({ registry: { ...receipt4({ state: 'pending' }), readVia: 'gateway' } })).r;
  const s = (await run({ registry: { ...receipt4({ state: 'pending' }), readVia: 'store-only' } })).r;
  assert.deepEqual([g.acts[0].fate, g.missingFrom4], [s.acts[0].fate, s.missingFrom4]);
  assert.deepEqual([g.acts[0].from4.chain, g.acts[0].from4.commitment], [null, 'finalized']);
});
