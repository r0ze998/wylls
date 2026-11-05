// ⑯ independent verification of ④'s action-state vocabulary (agent
// gateway `actionFateView`, ④ 0a5473af and later). The function is pure:
// no key is generated, derived or signed here, and no transaction is
// built. Signatures are fixed placeholder strings. What is checked is that
// "not known here" is never reported as "not sent" (B1's history limit),
// and that a failure after the bytes left keeps its signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/frontier/agent/gateway.mjs';

const SIG = 'PlaceholderSignature1111111111111111111111111111111111111111111111111111111111111111';

test('V16-F1: an action no longer in the kept history is unqueryable (not "not-sent")', () => {
  assert.equal(typeof G.actionFateView, 'function', 'this tree has no actionFateView');
  const v = G.actionFateView(null);
  assert.equal(v.state, 'unqueryable');
  assert.equal(v.retained, false);
  assert.notEqual(v.sent, false, 'a dropped record must not claim nothing was sent');
});

test('V16-F2: an older failed record without a signature is unknown (it may have been sent)', () => {
  const v = G.actionFateView({ type: 'action', key: 'k1', status: 'failed' });
  assert.equal(v.state, 'unknown');
});

test('V16-F3: a refusal before signing is not-sent; a signed failure carries its signature and needs the chain', () => {
  assert.equal(G.actionFateView({ type: 'action', key: 'k2', status: 'refused' }).state, 'not-sent');
  const signedFail = { type: 'action', key: 'k3', status: 'failed', sent: true, signature: SIG, lastValidBlockHeight: 10, slotFloor: 5 };
  const noChain = G.actionFateView(signedFail);
  assert.deepEqual([noChain.state, noChain.signature, noChain.sent], ['unqueryable', SIG, true]);
  const asked = G.actionFateView(signedFail, { fate: 'landed', commitment: 'finalized', queryFailed: false, why: 'x' });
  assert.equal(asked.state, 'landed', 'a "failed" send the chain shows landed is reported landed, not failed');
  const down = G.actionFateView(signedFail, { fate: 'pending', queryFailed: true, why: 'rpc down' });
  assert.equal(down.state, 'unqueryable');
});
