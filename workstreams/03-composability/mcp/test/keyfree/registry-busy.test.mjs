// When workstream 04's act registry cannot be written (`StoreError: database is locked`, what ④ 16576826's runexec
// answers when two processes make a brand-new run store's first open at once: harness.mjs openRunStore), ③ sends
// nothing — it answers RunRegistryUnavailable with "retry with the same requestId" — and the retry registers once and
// sends once. KEY-FREE, PDA-FREE. MOCK: the registry's answers are scripted to the shape ④'s client gives (code
// StoreError); the wallet's capability check is the real AgentGateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAS_SENDERS, keyfreeWorld, mcpServer } from './harness.mjs';

const skip = HAS_SENDERS ? false : 'needs a wallet tree with per-sender capabilities (WS03_GATEWAY_ROOT)';

function busyOnce() {
  const calls = { register: 0 };
  const rows = new Map();
  return {
    calls,
    async register(a) {
      calls.register++;
      if (calls.register === 1) throw Object.assign(new Error('database is locked'), { code: 'StoreError' });
      const run4Id = `act-${String(rows.size).padStart(16, '0')}`;
      rows.set(a.key, { run4Id, runId: a.runId, state: 'registered', source: a.source, idempotencyKey: a.key });
      return { run4Id, runId: a.runId, state: 'registered' };
    },
    async status(q) { const r = [...rows.values()].find(x => x.idempotencyKey === q.key || x.run4Id === q.run4Id); return { ...r, next: 'wait', newAttemptAllowed: false }; },
    async list(runId) { return { runId, acts: [...rows.values()].filter(r => r.runId === runId) }; },
  };
}

test('the registry busy at the first registration: nothing sent, RunRegistryUnavailable; the retry registers once and sends once', { skip }, async () => {
  const w = await keyfreeWorld({ relay: 'ws05' });
  const acts = busyOnce();
  const s = mcpServer(w, { acts });
  const { linkId } = await s.connectViaRelay();
  const p = await s.plan(linkId);
  const first = await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-busy01' });
  assert.deepEqual([first.error?.code, first.error?.retrySameRequestId], ['RunRegistryUnavailable', true]);
  assert.equal(w.script.posts, 0, 'nothing sent while unregistered');
  const op = s.store.state.operations[first.error.operationId];
  assert.deepEqual([op.state, op.attempts], ['requested', 0], 'no attempt counted');
  const again = await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-busy01' });
  assert.equal(again.state, 'accepted');
  assert.deepEqual([acts.calls.register, w.script.posts, w.script.chainSent], [2, 1, 1], 'registered once (after the refusal), sent once');
});
