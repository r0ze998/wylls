// A read-only capability check (proposed for ④/the agent wallet: ⑤ patch 0004). It authenticates exactly as submit does
// and records nothing — unlike asking for an action, which always leaves an idempotency record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createAgentMcp } from '../mcp/agent-mcp.mjs';
import { call, createAgent, delegate, ownerCommand, policy, relay } from './agent-wallet-fixtures.mjs';

async function ready() {
  const r = relay();
  const owner = Keypair.generate();
  const made = await createAgent(r, owner, { policy: policy(['economy']) });
  await call(r.public, 'POST', '/f/agent/command', { body: ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }), ip: '127.0.0.1' });
  delegate(r, owner.publicKey.toBase58(), made.agentKey);
  const fetch = async (url, init = {}) => { const u = new URL(url); const res = await call(r.public, init.method ?? 'GET', u.pathname + u.search, { body: init.body === undefined ? undefined : JSON.parse(init.body) }); return { status: res.status, json: async () => res.json }; };
  return { r, owner, ...made, fetch };
}

test('whoami: the current capability is named with its agent, owner and policy; nothing is recorded', async () => {
  const w = await ready();
  const rec = () => w.r.gateway.ledger.get(w.agentId);
  const before = { saves: w.r.agentStore.saves, requests: Object.keys(rec().requests).length, history: rec().history.length };
  const res = await call(w.r.public, 'POST', '/f/agent/whoami', { body: { agentId: w.agentId, capability: w.capability }, ip: '127.0.0.1' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.json.agentId, res.json.owner, res.json.mode, res.json.policyVersion], [w.agentId, w.owner.publicKey.toBase58(), 'auto', 1]);
  assert.equal(JSON.stringify(res.json).includes(w.capability), false, 'the token is never echoed');
  assert.deepEqual({ saves: w.r.agentStore.saves, requests: Object.keys(rec().requests).length, history: rec().history.length }, before);
});

test('whoami: an old (rotated) capability, another agent\'s, or none is refused as submit would refuse it', async () => {
  const w = await ready();
  const other = await createAgent(w.r, Keypair.generate(), { policy: policy(['economy']) });
  const rot = await call(w.r.public, 'POST', '/f/agent/command', { body: ownerCommand(w.owner, 'rotate-capability', { agentId: w.agentId }), ip: '127.0.0.1' });
  assert.equal(rot.status, 200);
  for (const capability of [w.capability, other.capability, undefined]) {
    const res = await call(w.r.public, 'POST', '/f/agent/whoami', { body: { agentId: w.agentId, capability }, ip: '127.0.0.1' });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'BadCapability');
  }
});

test('whoami through MCP: agent_whoami is listed and answers; a stale token gives BadCapability', async () => {
  const w = await ready();
  const m = createAgentMcp({ relay: 'http://relay.test', agentId: w.agentId, capability: w.capability, fetch: w.fetch });
  assert.ok(m.tools.includes('agent_whoami'));
  const t = await m.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_whoami', arguments: {} } });
  assert.equal(t.result.structuredContent.agentId, w.agentId);
  await call(w.r.public, 'POST', '/f/agent/command', { body: ownerCommand(w.owner, 'rotate-capability', { agentId: w.agentId }), ip: '127.0.0.1' });
  const t2 = await m.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_whoami', arguments: {} } });
  assert.equal(t2.result.structuredContent.error.code, 'BadCapability');
});
