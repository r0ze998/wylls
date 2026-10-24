// The MCP connection's contract (docs/agent-wallet/MCP.md): an MCP caller is
// one more caller of POST /f/agent/action. These tests drive the MCP server
// (mcp/agent-mcp.mjs) against the relay with the agent wallet attached (the
// same fixtures as the gateway's tests, no network) and pin that:
//   * it exposes reads and agent_act only — no owner command (create, policy,
//     mode, withdraw, rotate) is reachable through it;
//   * every agent_act passes the same gateway checks: stopped, stale policy,
//     stale mode epoch, an action not allowed, another village, an unpaid
//     budget, no on-chain delegation — each refused, nothing sent;
//   * a retry with the same requestId never sends twice (also from a new
//     server process), a different action under a used requestId is refused;
//   * the capability token never appears in anything it returns, and a
//     revoked (rotated) token is refused;
//   * the stdio transport speaks newline-delimited JSON-RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Keypair } from '@solana/web3.js';
import { createAgentMcp, serveStdio, TOOLS } from '../mcp/agent-mcp.mjs';
import { call, createAgent, delegate, deposit, ownerCommand, policy, relay, sound, VILLAGE } from './agent-wallet-fixtures.mjs';

const RELAY = 'http://relay.test';
/** fetch over the relay's handler (the fixture's call), as an MCP server's HTTP would reach it. */
const fetchOver = r => async (url, init = {}) => {
  const u = new URL(url);
  const res = await call(r.public, init.method ?? 'GET', u.pathname + u.search, { body: init.body === undefined ? undefined : JSON.parse(init.body) });
  return { status: res.status, json: async () => res.json };
};
const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: '127.0.0.1' });

async function ready(r, { balance = 0n, p = policy(['economy']), auto = true, delegated = true } = {}) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: p });
  if (balance > 0n) await deposit(r, o, made.agentId, balance);
  if (delegated) delegate(r, o, made.agentKey);
  if (auto) await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }));
  return { owner, o, ...made };
}

const rpc = (server, method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, params });
const tool = async (server, name, args = {}) => (await rpc(server, 'tools/call', { name, arguments: args })).result;

test('MCP: initialize and tools/list expose reads and agent_act only, never an owner command', async () => {
  const r = relay();
  const a = await ready(r);
  const s = createAgentMcp({ relay: RELAY, agentId: a.agentId, capability: a.capability, fetch: fetchOver(r) });
  const init = await rpc(s, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = (await rpc(s, 'tools/list')).result.tools.map(t => t.name);
  assert.deepEqual(list.sort(), ['agent_act', 'agent_terms', 'agent_view', 'world_read']);
  for (const forbidden of ['create', 'policy', 'mode', 'withdraw', 'rotate', 'deposit', 'settle', 'stop']) {
    assert.equal(list.some(n => n.includes(forbidden)), false, forbidden);
    const res = await rpc(s, 'tools/call', { name: `agent_${forbidden}`, arguments: {} });
    assert.equal(res.error.code, -32602, `${forbidden} is not a tool`);
  }
  assert.equal((await rpc(s, 'resources/list')).error.code, -32601);
  // agent_act's schema requires the epoch and the policy version the caller read.
  assert.deepEqual(TOOLS.find(t => t.name === 'agent_act').inputSchema.required, ['requestId', 'policyVersion', 'modeEpoch', 'action']);
});

test('MCP: agent_act goes through the gateway\'s checks; a retry never sends twice', async () => {
  const r = relay();
  const a = await ready(r);
  const s = createAgentMcp({ relay: RELAY, agentId: a.agentId, capability: a.capability, fetch: fetchOver(r) });
  const v = (await tool(s, 'agent_view')).structuredContent;
  assert.equal(v.agentId, a.agentId);
  assert.deepEqual(v.village, VILLAGE);
  const sentBefore = r.chain.sent.length;
  const args = { requestId: 'decision-0001', policyVersion: v.policy.version, modeEpoch: v.modeEpoch, action: { name: 'Harvest' }, reason: 'collect' };
  const first = await tool(s, 'agent_act', args);
  assert.equal(first.isError, false);
  assert.deepEqual([first.structuredContent.status, first.structuredContent.ok], ['sent', true]);
  assert.equal(r.chain.sent.length, sentBefore + 1);
  // The same requestId again, from this server and from a fresh one (a restart): the recorded result, nothing sent.
  const again = await tool(s, 'agent_act', args);
  const fresh = createAgentMcp({ relay: RELAY, agentId: a.agentId, capability: a.capability, fetch: fetchOver(r) });
  const restarted = await tool(fresh, 'agent_act', args);
  for (const x of [again, restarted]) {
    assert.equal(x.structuredContent.replayed, true);
    assert.equal(x.structuredContent.signature, first.structuredContent.signature);
  }
  assert.equal(r.chain.sent.length, sentBefore + 1, 'one send for one requestId');
  // A different action under the used requestId: refused, nothing sent.
  const conflict = await tool(s, 'agent_act', { ...args, action: { name: 'Build', fields: { item: 0 } } });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.error.code, 'IdempotencyConflict');
  // Concurrent repeats of one new requestId share one send.
  const conc = { ...args, requestId: 'decision-0002' };
  const both = await Promise.all([tool(s, 'agent_act', conc), tool(s, 'agent_act', conc)]);
  assert.equal(both[0].structuredContent.signature, both[1].structuredContent.signature);
  assert.equal(r.chain.sent.length, sentBefore + 2);
  // The action history marks the source.
  assert.ok(r.gateway.view(a.agentId).history.some(h => h.type === 'action' && h.source === 'mcp' && h.status === 'sent'));
  sound(r);
});

test('MCP: refused like any caller — stopped, stale policy, stale epoch, not allowed, never delegable, no delegation, unpaid price', async () => {
  const r = relay({ prices: { game: { Build: '5000' } } });
  const a = await ready(r, { p: policy(['economy']) });
  const s = createAgentMcp({ relay: RELAY, agentId: a.agentId, capability: a.capability, fetch: fetchOver(r) });
  const v0 = (await tool(s, 'agent_view')).structuredContent;
  let n = 0;
  const act = (over = {}) => tool(s, 'agent_act', { requestId: `refusal-${String(++n).padStart(4, '0')}`, policyVersion: v0.policy.version, modeEpoch: v0.modeEpoch, action: { name: 'Harvest' }, ...over });
  const code = res => res.structuredContent.error?.code;
  const sent0 = r.chain.sent.length;

  assert.equal(code(await act({ action: { name: 'Depart', fields: {} } })), 'ActionNotAllowed', 'military is not in the policy');
  assert.equal(code(await act({ action: { name: 'DeclareSiege', fields: {} } })), 'ActionNotAllowed', 'never delegable');
  assert.equal(code(await act({ action: { name: 'Build', fields: { item: 0 } } })), 'InsufficientBalance', 'a priced action with no balance');
  assert.equal(code(await act({ policyVersion: v0.policy.version + 1 })), 'StalePolicy');
  // The owner saves a new policy: the decision taken under the old one is refused.
  await post(r, '/f/agent/command', ownerCommand(a.owner, 'policy', { agentId: a.agentId, params: { policy: policy(['economy', 'vigil']) } }));
  assert.equal(code(await act()), 'StalePolicy');
  const v1 = (await tool(s, 'agent_view')).structuredContent;
  // The owner stops and restarts: a decision from the earlier auto period is refused by its epoch.
  await post(r, '/f/agent/command', ownerCommand(a.owner, 'mode', { agentId: a.agentId, params: { mode: 'manual' } }));
  assert.equal(code(await act({ policyVersion: v1.policy.version, modeEpoch: v1.modeEpoch })), 'AgentStopped');
  await post(r, '/f/agent/command', ownerCommand(a.owner, 'mode', { agentId: a.agentId, params: { mode: 'auto' } }));
  assert.equal(code(await act({ policyVersion: v1.policy.version, modeEpoch: v1.modeEpoch })), 'StaleMode');
  // The owner takes the key back on chain: refused by the chain's delegation, whatever the server mode.
  const v2 = (await tool(s, 'agent_view')).structuredContent;
  delegate(r, a.o, Keypair.generate().publicKey.toBase58());
  assert.equal(code(await act({ policyVersion: v2.policy.version, modeEpoch: v2.modeEpoch })), 'SessionNotDelegated');
  assert.equal(r.chain.sent.length, sent0, 'nothing was sent');
  assert.equal(r.gateway.view(a.agentId).balance.spent.game, '0', 'nothing was charged');
  sound(r);
});

test('MCP: the token never comes back; a rotated token is refused; the caller cannot name another agent or village', async () => {
  const r = relay();
  const a = await ready(r);
  const b = await ready(r);
  const s = createAgentMcp({ relay: RELAY, agentId: a.agentId, capability: a.capability, fetch: fetchOver(r) });
  const v = (await tool(s, 'agent_view')).structuredContent;
  const outs = [await rpc(s, 'initialize', {}), await rpc(s, 'tools/list'), await tool(s, 'agent_view'), await tool(s, 'agent_terms'),
    await tool(s, 'agent_act', { requestId: 'token-check-1', policyVersion: v.policy.version, modeEpoch: v.modeEpoch, action: { name: 'Harvest' } })];
  for (const o of outs) assert.equal(JSON.stringify(o).includes(a.capability), false);
  assert.equal(JSON.stringify(s).includes(a.capability), false, 'its JSON form holds no token');
  // Extra fields (another agent, another village) are not part of the tool's input: the village is read from the agent.
  const sneaky = await tool(s, 'agent_act', { requestId: 'token-check-2', policyVersion: v.policy.version, modeEpoch: v.modeEpoch, action: { name: 'Harvest' }, agentId: b.agentId, holding: [0, 0, 0] });
  assert.equal(sneaky.structuredContent.agentId, a.agentId);
  // B's server with A's token: refused.
  const wrong = createAgentMcp({ relay: RELAY, agentId: b.agentId, capability: a.capability, fetch: fetchOver(r) });
  const vb = (await tool(wrong, 'agent_view')).structuredContent;
  const crossed = await tool(wrong, 'agent_act', { requestId: 'token-check-3', policyVersion: vb.policy.version, modeEpoch: vb.modeEpoch, action: { name: 'Harvest' } });
  assert.equal(crossed.isError, true);
  assert.equal(crossed.structuredContent.error.code, 'BadCapability');
  // The owner rotates A's token: the server holding the old one is refused at once.
  await post(r, '/f/agent/command', ownerCommand(a.owner, 'rotate-capability', { agentId: a.agentId }));
  const old = await tool(s, 'agent_act', { requestId: 'token-check-4', policyVersion: v.policy.version, modeEpoch: v.modeEpoch, action: { name: 'Harvest' } });
  assert.equal(old.structuredContent.error.code, 'BadCapability');
  assert.equal(JSON.stringify(old).includes(a.capability), false);
});

test('MCP: an unreachable relay is reported as safe to retry with the same requestId; bad arguments never reach the relay', async () => {
  let calls = 0;
  const down = async () => { calls++; throw new Error('connect ECONNREFUSED 127.0.0.1:41630'); };
  const s = createAgentMcp({ relay: RELAY, agentId: 'a1', capability: 'secret-token-value', fetch: down });
  const r = await tool(s, 'agent_act', { requestId: 'offline-0001', policyVersion: 1, modeEpoch: 1, action: { name: 'Harvest' } });
  assert.deepEqual([r.isError, r.structuredContent.error.code, r.structuredContent.error.retrySameRequestId], [true, 'RelayUnreachable', true]);
  calls = 0;
  for (const bad of [{}, { requestId: 'short', policyVersion: 1, modeEpoch: 1, action: { name: 'Harvest' } }, { requestId: 'long-enough-1', modeEpoch: 1, action: { name: 'Harvest' } },
    { requestId: 'long-enough-1', policyVersion: 1, action: { name: 'Harvest' } }, { requestId: 'long-enough-1', policyVersion: 1, modeEpoch: 1 }]) {
    assert.equal((await tool(s, 'agent_act', bad)).structuredContent.error.code, 'BadRequest');
  }
  assert.equal(calls, 0, 'refused before any request');
  assert.throws(() => createAgentMcp({ relay: RELAY, agentId: 'a1' }), /capability/);
  assert.equal((await tool(s, 'world_read', { what: 'season' })).structuredContent.error.code, 'NotConfigured');
});

test('MCP: the stdio transport is one JSON-RPC message per line', async () => {
  const s = createAgentMcp({ relay: RELAY, agentId: 'a1', capability: 'tok-tok-tok', fetch: async () => { throw new Error('unused'); } });
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)));
  const rl = serveStdio(s, { input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write('not json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }) + '\n');
  await new Promise(res => setTimeout(res, 50));
  rl.close();
  const msgs = lines.map(l => JSON.parse(l));
  assert.equal(msgs.length, 3, 'no answer to the notification');
  assert.equal(msgs.find(m => m.id === 7).result.serverInfo.name, 'wylls-agent-wallet');
  assert.equal(msgs.find(m => m.id === null).error.code, -32700);
  assert.equal(msgs.find(m => m.id === 8).result.tools.length, 4);
});
