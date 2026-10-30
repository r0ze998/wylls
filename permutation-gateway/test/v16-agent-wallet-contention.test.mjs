// ⑯ independent verification (flow B, B8): the owner's own MCP caller and
// the operator's runner both act for one agent in the same turn. Nothing in
// the gateway serialises an agent's actions across sources: each source has
// its own idempotency key, the mode/policy/budget gates pass for both, and
// both transactions are sent. Whether one agent may send two actions in one
// turn is a design decision nobody has written down (DESIGN.md §7 speaks of
// "one action" per tick of the runner only). This test records the
// behaviour; it is expected to pass and is listed under 仕様未決定.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { runOnce } from '../src/frontier/agent/runner.mjs';
import { actionRequest, call, createAgent, delegate, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';

const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: '127.0.0.1' });

test('V16-B8: MCP and the runner both send for one agent in the same tick (no per-agent, per-turn serialisation)', async () => {
  const r = relay();
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: policy(['economy']) });
  delegate(r, o, made.agentKey);
  await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }));
  const decider = { name: 'test-model', free: true, async decide() { return { name: 'Train', fields: { unit: 0, n: 100 } }; } };
  const [viaRunner, viaMcp] = await Promise.all([
    runOnce(r.gateway, made.agentId, decider, { tick: 1_000 }),
    r.gateway.submit(actionRequest(made.agentId, { key: 'mcp:decision-1', modeEpoch: 1 }), { capability: made.capability }),
  ]);
  assert.equal(viaRunner.result.status, 'sent', JSON.stringify(viaRunner));
  assert.equal(viaMcp.status, 'sent', JSON.stringify(viaMcp));
  assert.equal(r.chain.sent.length, 2, 'two actions for one village in one tick');
  sound(r);
});
