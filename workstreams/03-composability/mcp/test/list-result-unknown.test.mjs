// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// list_operations (picking up after a reconnect) tells a result-unknown operation apart from one on its way:
//   L1 resultUnknown: held or uncertain and not terminal → true; a known send, a terminal one → false
//   L2 receiptOf's "not known yet" advice and resultUnknown agree on every case
//   L3 list_operations returns hold and resultUnknown for each operation (server source, read as text)
//   L4 its description says "last recorded state" and points at get_operation_status
// KEY-FREE: imports ports.mjs (no imports); reads server.mjs and tools.mjs as text (not imported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATES, receiptOf, resultUnknown } from '../src/ports.mjs';

const op = (o = {}) => ({ id: 'op_1', requestId: 'req-00000001', kind: 'caravan', state: STATES.ACCEPTED, createdAt: 'x', updatedAt: 'x', planSummary: null, steps: [], ...o });
const CASES = [
  [op({ hold: { code: 'ResultUnknown' } }), true],
  [op({ uncertain: true }), true],
  [op({ state: STATES.REQUESTED, unknownSince: 1, error: { code: 'RelayUnreachable' } }), true],
  [op({ state: STATES.REQUESTED, unknownSince: null }), false],
  [op({ state: STATES.PROCESSING, uncertain: true, unknownSince: 1 }), false],
  [op({ state: STATES.PROCESSING, hold: { code: 'ContextChanged' } }), true],
  [op({ gateway: { signature: 'S' } }), false],
  [op({ state: STATES.PROCESSING }), false],
  [op({ state: STATES.COMPLETED, outcome: 'delivered', hold: { code: 'Indeterminate' } }), false],
  [op({ state: STATES.FAILED, error: { code: 'Expired' }, uncertain: true }), false],
];

test('L1 resultUnknown', () => {
  for (const [o, want] of CASES) assert.equal(resultUnknown(o), want, JSON.stringify(o));
});

test('L2 receiptOf agrees', () => {
  for (const [o, want] of CASES) assert.equal(/result is not known yet/.test(receiptOf(o).next.join(' ')), want, JSON.stringify(o));
});

test('L3 list_operations carries hold and resultUnknown', () => {
  const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /hold: op\.hold\?\.code \?\? null, resultUnknown: resultUnknown\(op\)/);
});

test('L4 the description', () => {
  const tools = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
  assert.match(tools, /with their last recorded state, for picking up after a reconnect: get_operation_status reads one again now/);
  assert.match(tools, /resultUnknown \(with hold\) marks an operation whose result is not known yet/);
});
