// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// Every code the server can end an operation with (definite(op, link, 'Code', …) in server.mjs, read as text) has its
// own advice in RECOVERY, or is one of the few where the fallback "prepare again" is right (nothing of it moved and
// nothing of it will: NotLanded is proven never to land; a definite ContextChanged ended in an old world context).
//   K1 every literal definite code is covered
//   K2 DuplicateOfOperation sends the person to the other operation — on its own connection, or the owner's view (an
//      operation of another connection is UnknownOperation here) — never to prepare again
//   K3 RunConflict: nothing was sent, the request has ended (no resend under any runId), a new decision is a new plan,
//      confirmed, with a new requestId (corrects 20061e81, which advised "send again with that runId")
// KEY-FREE: imports ports.mjs (no imports); reads server.mjs as text (not imported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RECOVERY, STATES, receiptOf } from '../src/ports.mjs';

const FALLBACK_OK = new Set(['NotLanded', 'ContextChanged']);
const failed = error => receiptOf({ id: 'op_1', requestId: 'req-00000001', kind: 'caravan', state: STATES.FAILED, createdAt: 'x', updatedAt: 'x', planSummary: null, steps: [], error });

test('K1 every definite code has advice or a right fallback', () => {
  const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const codes = [...new Set([...src.matchAll(/definite\(op, link, '([A-Za-z]+)'/g)].map(m => m[1]))];
  assert.ok(codes.length >= 5, codes.join(','));
  for (const c of codes) assert.ok(RECOVERY[c] || FALLBACK_OK.has(c), `${c}: no advice`);
});

test('K2 DuplicateOfOperation: follow the other operation', () => {
  const t = failed({ code: 'DuplicateOfOperation', message: 'the same transaction was already sent by this server\'s operation op_x' }).next.join(' ');
  assert.match(t, /get_operation_status on the connection that sent it, or the owner's view/);
  assert.match(t, /do not prepare again/);
});

test('K3 RunConflict: nothing sent, the request has ended, a new decision is a new plan', () => {
  const t = failed({ code: 'RunConflict' }).next.join(' ');
  assert.match(t, /nothing was sent and this request has ended/);
  assert.match(t, /not sent again/);
  assert.doesNotMatch(t, /send again with that runId/);
  assert.match(t, /prepare_caravan, the person confirms, then send_caravan with a new requestId/);
});
