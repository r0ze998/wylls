// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// The update rules consult (server.mjs) applies to op.ws04Act after a registry status read, as pure helpers:
//   R1 another key's receipt is refused (Inconsistent, with the key named) and nothing is built from it
//   R2 a receipt without a key (an older ④ or a stub) is applied
//   R3 a read that answered keeps the receipt's signature, key and source, and sets `at` to this read
//   R4 a read that answered drops an earlier readError / readErrorAt; fields it does not set are kept (registeredAt…)
//   R5 a failed read keeps everything known and the last answering read's `at`; it sets readError and readErrorAt
//   R6 success → failure → success: `at` follows only the reads that answered; the stale error goes
// KEY-FREE: imports receipt-port.mjs (→ ports.mjs, which imports nothing). Plain objects only; nothing is signed, sent,
// read from disk or fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ws04ActAfterRead, ws04ActAfterFailedRead } from '../src/receipt-port.mjs';

const KEY = 'ws03:lnk_a:req-0001';
const T1 = '2026-11-17T00:00:01.000Z', T2 = '2026-11-17T00:00:02.000Z', T3 = '2026-11-17T00:00:03.000Z';
const registered = { run4Id: 'act-0000000000000001', runId: 'op_1', registeredAt: '2026-11-17T00:00:00.000Z', receiptVersion: 'p04-acts/0.1', state: 'registered' };
const receipt = (extra = {}) => ({ run4Id: 'act-0000000000000001', receiptVersion: 'p04-acts/0.1', state: 'pending', final: false, next: 'wait', newAttemptAllowed: false,
  cancel: { stage: 'sent', result: 'Irrevocable', until: { lastValidBlockHeight: 900 }, phase: 'AwaitingSigned' }, retention: { retentionBells: null, deleted: false },
  conflict: null, signature: 'S', idempotencyKey: KEY, source: 'mcp', ...extra });

test('R1 another key\'s receipt is refused', () => {
  const r = ws04ActAfterRead(registered, receipt({ idempotencyKey: 'ws03:lnk_b:req-0001' }), { key: KEY, at: T1 });
  assert.deepEqual(r, { ok: false, code: 'Inconsistent', message: 'the registry answered for another key (ws03:lnk_b:req-0001)' });
});

test('R2 a receipt without a key is applied', () => {
  for (const idempotencyKey of [undefined, null]) {
    const r = ws04ActAfterRead(registered, receipt({ idempotencyKey }), { key: KEY, at: T1 });
    assert.equal(r.ok, true);
    assert.equal(r.act.idempotencyKey, null);
  }
});

test('R3 a read that answered keeps signature, key and source, and its time', () => {
  const { act } = ws04ActAfterRead(registered, receipt(), { key: KEY, at: T1 });
  assert.deepEqual([act.signature, act.idempotencyKey, act.source, act.at, act.state, act.next, act.final, act.newAttemptAllowed],
    ['S', KEY, 'mcp', T1, 'pending', 'wait', false, false]);
  assert.deepEqual(act.cancel.until, { lastValidBlockHeight: 900 });
  const bare = ws04ActAfterRead(undefined, { run4Id: 'act-1', state: 'registered' }, { key: KEY, at: T1 }).act;
  assert.deepEqual([bare.signature, bare.source, bare.cancel, bare.conflict, bare.next], [null, null, null, null, null]);
});

test('R4 a read that answered drops an earlier error and keeps what it does not set', () => {
  const prev = { ...registered, readError: 'Spawn: runexec missing', readErrorAt: T1 };
  const { act } = ws04ActAfterRead(prev, receipt(), { key: KEY, at: T2 });
  assert.equal('readError' in act, false);
  assert.equal('readErrorAt' in act, false);
  assert.deepEqual([act.runId, act.registeredAt], ['op_1', '2026-11-17T00:00:00.000Z']);
});

test('R5 a failed read keeps what was known and the last answering read\'s time', () => {
  const known = ws04ActAfterRead(registered, receipt(), { key: KEY, at: T1 }).act;
  const after = ws04ActAfterFailedRead(known, 'StoreError: locked', T2);
  assert.deepEqual(after, { ...known, readError: 'StoreError: locked', readErrorAt: T2 });
  assert.equal(after.at, T1);
  assert.deepEqual(ws04ActAfterFailedRead(undefined, 'Spawn: x', T2), { readError: 'Spawn: x', readErrorAt: T2 });
  assert.equal(known.readError, undefined, 'the input is not changed');
});

test('R6 success, failure, success', () => {
  let act = ws04ActAfterRead(registered, receipt(), { key: KEY, at: T1 }).act;
  act = ws04ActAfterFailedRead(act, 'Spawn: x', T2);
  assert.deepEqual([act.at, act.readErrorAt], [T1, T2]);
  act = ws04ActAfterRead(act, receipt({ state: 'landed', final: true, next: 'done' }), { key: KEY, at: T3 }).act;
  assert.deepEqual([act.at, act.state, 'readError' in act, 'readErrorAt' in act], [T3, 'landed', false, false]);
});
