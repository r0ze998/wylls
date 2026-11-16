// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// ActionNotAllowed has three causes in the relay (permutation-gateway src/frontier/agent, read only): policy.mjs
// checkAllowed "<name> is not allowed for this agent", gateway.mjs "SendCaravan exists in S1 seasons only", gateway.mjs
// "<name> is not an action an agent sends". The advice follows the relay's message:
//   A1 the policy message: allow the transport group — and on a relay without patch 0005 there is none to allow
//   A2 the season message: a policy change does not help
//   A3 the not-an-agent-action message: this relay does not take SendCaravan from an agent; a policy change does not help
//   A4 another or no message: the generic advice names the three causes and points at error.message
//   A5 the failed receipt carries the matching advice; other codes are unchanged
//   A6 the boundary text no longer asserts that the relay needs patch 0005
// KEY-FREE: imports ports.mjs and budget-port.mjs (neither imports anything). Plain objects only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECOVERY, STATES, actionNotAllowedNext, receiptOf } from '../src/ports.mjs';
import { refusalOf } from '../src/budget-port.mjs';

const j = a => a.join(' ');

test('A1 the policy message', () => {
  const t = j(actionNotAllowedNext('SendCaravan is not allowed for this agent'));
  assert.match(t, /allows the transport group/);
  assert.match(t, /without patch 0005 there is no transport group to allow/);
});

test('A2 the season message', () => {
  const t = j(actionNotAllowedNext('SendCaravan exists in S1 seasons only'));
  assert.match(t, /S1 seasons only/);
  assert.match(t, /a policy change does not help/);
  assert.doesNotMatch(t, /allows the transport group/);
});

test('A3 the not-an-agent-action message', () => {
  const t = j(actionNotAllowedNext('SendCaravan is not an action an agent sends'));
  assert.match(t, /does not take SendCaravan from an agent/);
  assert.match(t, /a policy change does not help/);
});

test('A4 any other message: the generic advice', () => {
  for (const m of [undefined, null, '', 'something else']) assert.deepEqual(actionNotAllowedNext(m), RECOVERY.ActionNotAllowed);
  assert.match(j(RECOVERY.ActionNotAllowed), /policy.*S1.*patch 0005.*error\.message/);
});

const failed = error => receiptOf({ id: 'op_1', requestId: 'req-00000001', kind: 'caravan', state: STATES.FAILED, createdAt: 'x', updatedAt: 'x', planSummary: null, steps: [], error });

test('A5 the failed receipt follows the message; other codes unchanged', () => {
  assert.match(j(failed({ code: 'ActionNotAllowed', message: 'SendCaravan exists in S1 seasons only' }).next), /S1 seasons only/);
  assert.match(j(failed({ code: 'ActionNotAllowed', message: 'SendCaravan is not allowed for this agent' }).next), /patch 0005/);
  assert.deepEqual(failed({ code: 'Expired' }).next, RECOVERY.Expired);
  assert.deepEqual(failed({ code: 'NoSuchCode' }).next, ['prepare again']);
});

test('A6 the boundary text names the three causes, no unconditional claim', () => {
  const b = refusalOf('ActionNotAllowed');
  assert.deepEqual([b.by, b.kind, b.retrySame], ['⑤', 'policy', false]);
  assert.doesNotMatch(b.next, /the relay needs patch 0005/);
  assert.match(b.next, /S1 seasons only/);
});
