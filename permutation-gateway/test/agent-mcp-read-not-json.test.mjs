// The agent MCP's four reads (mcp/agent-mcp.mjs: agent_view, agent_terms, agent_whoami, world_read) when the relay or
// the herald answers HTTP 200 without a JSON object (2026-11-17). SOURCE-ONLY when written: not run in the session that
// wrote it. A fake fetch answers; nothing is sent anywhere, no relay or herald is started, no key is made. This file
// imports only mcp/agent-mcp.mjs (node:readline, node:url): not @solana/web3.js, not the gateway's fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentMcp } from '../mcp/agent-mcp.mjs';

const CAP = 'cap-secret-token-for-this-test';
/** A fetch whose every answer is HTTP 200 with `body` (a string: what `res.json()` would fail to parse, or JSON). */
function fetch200(body) {
  const asked = [];
  const f = async (url, init = {}) => {
    asked.push({ url: String(url), method: init.method ?? 'GET' });
    return { status: 200, json: async () => JSON.parse(body) };
  };
  return { asked, f };
}
const call = (server, name, args = {}) => server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).then(r => r.result);

test('a 200 that is not a JSON object is an error, never a successful null, for every read', async () => {
  for (const body of ['<html>proxy</html>', '', 'null', '[]', '"text"', '7']) {
    const { asked, f } = fetch200(body);
    const s = createAgentMcp({ relay: 'http://relay.test', agentId: 'agent-1', capability: CAP, herald: 'http://herald.test', fetch: f });
    for (const [name, args, code] of [['agent_view', {}, 'RelayError'], ['agent_terms', {}, 'RelayError'], ['agent_whoami', {}, 'RelayError'],
      ['world_read', { what: 'season' }, 'HeraldError'], ['world_read', { what: 'province', p: 1, q: 0 }, 'HeraldError']]) {
      const r = await call(s, name, args);
      assert.equal(r.isError, true, `${name} ${JSON.stringify(body)}`);
      assert.equal(r.structuredContent.error.code, code);
      assert.ok(!JSON.stringify(r).includes(CAP), 'the capability never comes back');
    }
    // the reads asked only what they always asked (GET, and whoami's POST with the capability in its body)
    assert.deepEqual(asked.map(a => `${a.method} ${a.url}`), ['GET http://relay.test/f/agent?id=agent-1', 'GET http://relay.test/f/agent/terms',
      'POST http://relay.test/f/agent/whoami', 'GET http://herald.test/h/season', 'GET http://herald.test/h/province/1,0/latest']);
  }
});

test('a 200 with a JSON object is passed through unchanged, as before', async () => {
  const { f } = fetch200('{"agentId":"agent-1","village":[1,0,2]}');
  const s = createAgentMcp({ relay: 'http://relay.test', agentId: 'agent-1', capability: CAP, herald: 'http://herald.test', fetch: f });
  for (const name of ['agent_view', 'agent_terms', 'agent_whoami']) {
    const r = await call(s, name);
    assert.equal(r.isError, false); assert.deepEqual(r.structuredContent, { agentId: 'agent-1', village: [1, 0, 2] });
  }
  const w = await call(s, 'world_read', { what: 'season' });
  assert.equal(w.isError, false); assert.deepEqual(w.structuredContent, { agentId: 'agent-1', village: [1, 0, 2] });
});

test('agent_act and the tool list are unchanged (pinned as text)', () => {
  const src = readFileSync(new URL('../mcp/agent-mcp.mjs', import.meta.url), 'utf8');
  const act = src.slice(src.indexOf('  async function act(args) {'), src.indexOf('  async function world(args) {'));
  assert.doesNotMatch(act, /isObject|notJson/, 'agent_act is not changed by this');
  assert.match(src, /const tools = \{ agent_view: view, agent_terms: terms, agent_whoami: whoami, agent_act: act, world_read: world \};/);
  assert.equal((src.match(/if \(!isObject\(r\.json\)\) return notJson\(/g) ?? []).length, 4);
});
