// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// What a consumer (ChatGPT through MCP) is told about an operation whose result is not known (08-mcp-contracts state
// table: accepted also covers "an attempt whose result is not known"; 07 "結果が分からない送付" is never "nothing sent"):
//   D1 accepted + hold (ResultUnknown): next says the result is not known, not to send again, neither delivered nor
//      failed — and does not point at an arrival time
//   D2 accepted + uncertain without a hold yet: the same
//   D3 accepted, sent and known: unchanged (call again later, ETA)
//   D4 terminal states keep their own next (delivered → none; failed → recovery), a left-over hold changes nothing
//   D5 the receipt's note and the tool description name the unknown case
// KEY-FREE: imports ports.mjs (no imports); reads tools.mjs as text (not imported). Plain objects; nothing is signed,
// sent or fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { receiptOf, STATES } from '../src/ports.mjs';

const op = (o = {}) => ({ id: 'op_1', requestId: 'req-00000001', kind: 'caravan', state: STATES.ACCEPTED, createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z',
  planSummary: { from: 'holding:1', to: 'vault:1' }, steps: [], ...o });
const text = r => r.next.join(' ');

test('D1 a held operation is not shown as on its way', () => {
  const r = receiptOf(op({ hold: { code: 'ResultUnknown', since: '2026-11-17T00:00:00.000Z', detail: 'x' }, uncertain: true }));
  assert.equal(r.terminal, false);
  assert.match(text(r), /result is not known yet \(ResultUnknown\)/);
  assert.match(text(r), /do not prepare or send this again/);
  assert.match(text(r), /neither delivered nor failed/);
  assert.doesNotMatch(text(r), /ETA|arriveAt/);
  assert.equal(r.hold.code, 'ResultUnknown');
});

test('D2 an uncertain attempt without a hold yet: the same', () => {
  const r = receiptOf(op({ uncertain: true }));
  assert.match(text(r), /result is not known yet:/);
  assert.doesNotMatch(text(r), /ETA/);
});

test('D3 a known send keeps the arrival guidance', () => {
  for (const state of [STATES.ACCEPTED, STATES.PROCESSING]) {
    const r = receiptOf(op({ state, uncertain: false, gateway: { signature: 'S' } }));
    assert.deepEqual(r.next, ['call operation_status again later (arrival is not instant; ETA in caravan.arriveAt)']);
  }
});

test('D4 terminal states keep their own next', () => {
  assert.deepEqual(receiptOf(op({ state: STATES.COMPLETED, outcome: 'delivered', hold: { code: 'Indeterminate' } })).next, []);
  assert.match(text(receiptOf(op({ state: STATES.FAILED, error: { code: 'Expired' }, uncertain: true }))), /expired before it landed/);
});

test('D5 the note and the tool description name the unknown case', () => {
  assert.match(receiptOf(op()).notes[0], /an attempt whose result is not known yet/);
  const tools = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
  assert.match(tools, /accepted \(the relay sent the transaction, or an attempt whose result is not known yet/);
});
