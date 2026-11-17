// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Pure: imports ws04-acts.mjs only (which
// imports nothing); plain objects; nothing is read, sent or signed. Run it only with its own approval.
//
// fateOfReceipt: a receipt whose `code` is Duplicate and which carries a signature (the earlier send's) is the Duplicate
// failure the wallet gave this key's submit — no signature, fate failed (Duplicate) — never this key's sent/landed.
// Everything else is as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fateOfReceipt, Unqueryable } from '../resident/ports/ws04-acts.mjs';

const receipt = o => ({ receiptVersion: 'p04-acts/0.1', run4Id: 'act-0123456789abcdef', state: 'landed', final: true, next: 'done',
  newAttemptAllowed: false, commitment: 'finalized', signature: 'sigEarlier', ...o });

test('a Duplicate with the earlier signature is a Duplicate failure, not this key\'s landing', () => {
  for (const state of ['landed', 'pending', 'unknown', 'failed']) {
    const a = fateOfReceipt(receipt({ state, code: 'Duplicate' }));
    assert.deepEqual([a.ok, a.status, a.fate, a.fateError, a.error.code, a.duplicate], [false, 'failed', 'failed', 'Duplicate', 'Duplicate', true], state);
    assert.equal(a.signature, undefined, 'the earlier signature is not this key\'s');
    assert.equal(a.ws04.state, state, 'workstream 4\'s reading is kept beside it, for the operator');
  }
});

test('a Duplicate without a signature (refused before signing: not-sent) keeps today\'s handling', () => {
  const a = fateOfReceipt(receipt({ state: 'not-sent', code: 'Duplicate', signature: null, final: true, next: 'new-attempt', newAttemptAllowed: true }));
  assert.deepEqual([a.ok, a.status, a.fate], [true, 'refused', 'not-sent']);
});

test('no code, or another code: unchanged', () => {
  const a = fateOfReceipt(receipt({}));
  assert.deepEqual([a.ok, a.status, a.fate, a.signature], [true, 'sent', 'landed', 'sigEarlier']);
  const b = fateOfReceipt(receipt({ state: 'pending', code: 'SendFailed', signature: 'sigOwn' }));
  assert.deepEqual([b.status, b.fate, b.signature], ['sent', 'pending', 'sigOwn']);
});

test('unqueryable is still thrown first, Duplicate or not', () => {
  assert.throws(() => fateOfReceipt(receipt({ state: 'unqueryable', code: 'Duplicate' })), Unqueryable);
});
