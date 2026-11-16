// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// ④'s registry cancel.until is shown as "this send's deadline" only for THIS request's own signature — the rule of
// lost-answer.test.mjs "AwaitingSigned.until is the recorded lifetime of this request's own signature, null without it":
//   G1 the registry's signature equals the one this server received: its until is used, with that signature and readAt
//   G2 the registry names another signature: not used (the relay lifetime of the request's own signature, or null)
//   G3 the registry receipt names no signature (an operation stored before ws04Act kept it): not used
//   G4 this server holds no signature of its own (a lost answer, or the wallet's fate could not be read while the
//      registry answered): the registry's until is NOT used — its signature may be an earlier send's (a Duplicate the
//      server never learned of); null, as the relay path gives without a signature. (Corrected on the intake candidate:
//      eaf2b97d used it.)
//   G5 a Duplicate, also one that named no signature (duplicateOf present, null): the registry's until is never adopted
//   G6 without a registry receipt the answers are exactly the existing ones (lost-answer.test.mjs:156-161)
// KEY-FREE: imports receipt-port.mjs (which imports ports.mjs only; ports.mjs imports nothing). Operations are plain
// objects; nothing is signed, sent, read from disk or fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ws04CancelPhase } from '../src/receipt-port.mjs';

const base = { state: 'accepted', attempts: 1, caravan: { ownerTag: '1', seq: 0 } };
const act = (signature, extra = {}) => ({ run4Id: 'act-0000000000000001', state: 'pending', at: '2026-11-17T00:00:00.000Z',
  cancel: { stage: 'sent', result: 'Irrevocable', until: { lastValidBlockHeight: 900 }, phase: 'AwaitingSigned' }, ...(signature === undefined ? {} : { signature }), ...extra });
const REG = 'ws04 act registry (runexec act status)';

test('G1 the registry until for this request\'s own signature', () => {
  const p = ws04CancelPhase({ ...base, gateway: { signature: 'S' }, ws04Act: act('S') });
  assert.deepEqual(p, { phase: 'AwaitingSigned', until: { lastValidBlockHeight: 900, unit: 'block height', signature: 'S', source: REG, readAt: '2026-11-17T00:00:00.000Z' }, stage: 'sent', result: 'Irrevocable' });
});

test('G2 a registry receipt naming another signature is not this send\'s deadline', () => {
  const lifetime = { lastValidBlockHeight: 150, signature: 'S', source: 'relay' };
  assert.deepEqual(ws04CancelPhase({ ...base, gateway: { signature: 'S' }, lifetime, ws04Act: act('X') }),
    { phase: 'AwaitingSigned', until: { lastValidBlockHeight: 150, unit: 'block height', signature: 'S', source: 'relay' } });
  assert.deepEqual(ws04CancelPhase({ ...base, gateway: { signature: 'S' }, ws04Act: act('X') }), { phase: 'AwaitingSigned', until: null });
});

test('G3 a registry receipt without a signature is not used', () => {
  for (const s of [undefined, null]) assert.deepEqual(ws04CancelPhase({ ...base, gateway: { signature: 'S' }, ws04Act: act(s) }), { phase: 'AwaitingSigned', until: null });
});

test('G4 no signature of this server\'s own: the registry\'s until is not used', () => {
  assert.deepEqual(ws04CancelPhase({ ...base, ws04Act: act('R') }), { phase: 'AwaitingSigned', until: null });
  assert.deepEqual(ws04CancelPhase({ ...base, gateway: { signature: null }, ws04Act: act('R') }), { phase: 'AwaitingSigned', until: null });
  // A relay lifetime alone (no own signature) is not used either: the existing rule.
  assert.deepEqual(ws04CancelPhase({ ...base, lifetime: { lastValidBlockHeight: 150, signature: 'R', source: 'relay' }, ws04Act: act('R') }), { phase: 'AwaitingSigned', until: null });
});

test('G5 a Duplicate never takes the registry\'s until', () => {
  assert.deepEqual(ws04CancelPhase({ ...base, gateway: { duplicateOf: 'E' }, ws04Act: act('E') }), { phase: 'AwaitingSigned', until: null });
  assert.deepEqual(ws04CancelPhase({ ...base, gateway: { signature: null, duplicateOf: null }, ws04Act: act('E') }), { phase: 'AwaitingSigned', until: null }, 'a Duplicate that named no signature');
  assert.deepEqual(ws04CancelPhase({ ...base, gateway: { signature: 'E', duplicateOf: null }, ws04Act: act('E') }), { phase: 'AwaitingSigned', until: null }, 'duplicateOf present: never the registry\'s until, even beside a signature');
});

test('G6 without a registry receipt: the existing answers', () => {
  assert.deepEqual(ws04CancelPhase({ ...base }), { phase: 'AwaitingSigned', until: null });
  assert.deepEqual(ws04CancelPhase({ ...base, lifetime: { lastValidBlockHeight: 150, source: 'x' } }), { phase: 'AwaitingSigned', until: null });
  assert.deepEqual(ws04CancelPhase({ ...base, gateway: { signature: 'S' }, lifetime: { lastValidBlockHeight: 150, source: 'relay' } }),
    { phase: 'AwaitingSigned', until: { lastValidBlockHeight: 150, unit: 'block height', signature: 'S', source: 'relay' } });
  assert.deepEqual(ws04CancelPhase({ ...base, state: 'requested', attempts: 0 }), { phase: 'StoppingNew' });
});
