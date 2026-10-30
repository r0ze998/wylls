// ⑯ independent verification (flow B / cross-cutting X5): the agent
// wallet's idempotency record is capped (ledger.mjs REQUESTS_MAX = 2,000,
// oldest dropped), so a request key older than the newest 2,000 is no
// longer remembered. DESIGN.md §6.6 promises "a retry with the same
// idempotencyKey returns the recorded result … no second send". These tests
// pin the promise as the invariant and show where it breaks.
//
// Both tests drive the real AgentGateway over the scripted chain of the
// agent-wallet fixtures (no network). Nothing here is a mock of the gateway
// or the ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createAgentMcp } from '../mcp/agent-mcp.mjs';
import { actionRequest, call, createAgent, delegate, ownerCommand, policy, relay, sound, VILLAGE } from './agent-wallet-fixtures.mjs';

const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: '127.0.0.1' });

async function ready(r) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: policy(['economy']) });
  delegate(r, o, made.agentKey);
  const m = await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }));
  assert.equal(m.status, 200, JSON.stringify(m.json));
  return { owner, o, ...made, act: (over = {}) => r.gateway.submit(actionRequest(made.agentId, over), { capability: made.capability }) };
}

test('V16-B1: a sent request key is still a replay after 2,000 later requests (invariant of DESIGN.md §6.6)', async () => {
  const r = relay();
  const a = await ready(r);
  const first = await a.act({ key: 'decision-0000001' });
  assert.equal(first.status, 'sent', JSON.stringify(first));
  const sentBefore = r.chain.sent.length;
  // 2,000 later decisions, each refused before any hold (another village: WrongVillage) so they are cheap, but each is
  // remembered under its own key exactly as a sent one would be (ledger.remember is called for refusals too).
  for (let i = 0; i < 2000; i++) {
    const res = await a.act({ key: `later-${String(i).padStart(7, '0')}`, holding: [VILLAGE[0] + 1, VILLAGE[1], VILLAGE[2]] });
    assert.equal(res.status, 'refused');
  }
  assert.equal(r.chain.sent.length, sentBefore, 'the refusals sent nothing');
  // The retry of the first decision (same key, same request): the contract says the recorded result comes back and
  // nothing is sent again.
  const again = await a.act({ key: 'decision-0000001' });
  assert.equal(again.replayed, true, `the first key must still be a replay; got ${JSON.stringify(again)}`);
  assert.equal(r.chain.sent.length, sentBefore, 'a replay sends nothing');
  sound(r);
});

test('V16-B7: MCP requestIds are namespaced per agent (two agents, the same requestId, both act)', async () => {
  const r = relay();
  const a = await ready(r);
  const b = await ready(r);
  const fetchOver = async (url, init = {}) => {
    const u = new URL(url);
    const res = await call(r.public, init.method ?? 'GET', u.pathname + u.search, { body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { status: res.status, json: async () => res.json };
  };
  const mcpA = createAgentMcp({ relay: 'http://relay.test', agentId: a.agentId, capability: a.capability, fetch: fetchOver });
  const mcpB = createAgentMcp({ relay: 'http://relay.test', agentId: b.agentId, capability: b.capability, fetch: fetchOver });
  const args = { requestId: 'shared-req-0001', policyVersion: 1, modeEpoch: 1, action: { name: 'Harvest', fields: {} } };
  const ra = await mcpA.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_act', arguments: args } });
  const rb = await mcpB.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_act', arguments: args } });
  assert.equal(ra.result.structuredContent.status, 'sent', JSON.stringify(ra.result.structuredContent));
  assert.equal(rb.result.structuredContent.status, 'sent', JSON.stringify(rb.result.structuredContent));
  assert.equal(rb.result.structuredContent.replayed, undefined, 'agent B\'s first use of the id is not a replay of A\'s');
  sound(r);
});
