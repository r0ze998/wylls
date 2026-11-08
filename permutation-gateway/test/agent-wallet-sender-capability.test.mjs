// Workstream 04 AUTH-ROUTES A1, by workstream 05: a capability per sender (ai | mcp) beside the general token.
// Workstream 03's MCP consent rotates the `mcp` token only; workstream 05's autopilot keeps its `ai` token.
// No key is generated, derived or used and nothing is signed: the agent record is plain data (its key fields are
// fixed strings), the owner commands are called on the gateway directly (the route's signature check is not
// exercised here), and the agent is in manual mode, so every request stops at the gate after authentication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLedger } from '../src/frontier/agent/ledger.mjs';
import { AgentGateway, SEQ_ACTIONS, SOURCES_WITH_TOKENS } from '../src/frontier/agent/gateway.mjs';
import { normalisePolicy } from '../src/frontier/agent/policy.mjs';
import { OWNER_OPS } from '../src/frontier/agent/owner-auth.mjs';

const OWNER = 'OwnerOfTheTestAgent1111111111111111111111111';
function world(state = {}) {
  const store = { state, save() {} };
  const ledger = new AgentLedger({ store });
  if (!ledger.db.agents.a1) ledger.create({ agentId: 'a1', owner: OWNER, agentKey: 'AgentKeyFixedString11111111111111111111111111', village: [1, 2, 3], policy: normalisePolicy({ allowed: ['Train'], budget: { total: '1000', perDay: '100' } }) });
  const gateway = new AgentGateway({ ctx: { addresses: { citizen: () => 'Citizen' } }, ledger, keyring: null });
  return { store, ledger, gateway };
}
const req = (source, n) => ({ agentId: 'a1', source, idempotencyKey: `${source}:k${n}`, policyVersion: 1, action: { name: 'Train', holding: [1, 2, 3], fields: { unit: 0, n: 1 } } });
let n = 0;
/** Authenticated → the gate refuses (manual mode): AgentStopped. Not authenticated → BadCapability thrown. */
async function tryAs(g, source, capability) {
  try { const r = await g.submit(req(source, ++n), { capability }); return r.error?.code ?? r.status; } catch (e) { return e.code; }
}

test('a token per sender: issued, used and revoked apart; the general token as before', async () => {
  const { gateway: g, store } = world();
  assert.deepEqual(SOURCES_WITH_TOKENS, ['ai', 'mcp']);
  assert.ok(OWNER_OPS.includes('revoke-capability'));
  const general = g.rotateCapability('a1', OWNER).capability;
  const ai = g.rotateCapability('a1', OWNER, 'ai').capability;
  const mcp1 = g.rotateCapability('a1', OWNER, 'mcp').capability;
  assert.deepEqual([general.source, ai.source, mcp1.source], ['any', 'ai', 'mcp']);
  assert.deepEqual([await tryAs(g, 'ai', ai.token), await tryAs(g, 'mcp', mcp1.token), await tryAs(g, 'ai', general.token), await tryAs(g, 'mcp', general.token)], ['AgentStopped', 'AgentStopped', 'AgentStopped', 'AgentStopped']);
  // A sender's token is that sender's only.
  assert.equal(await tryAs(g, 'mcp', ai.token), 'BadCapability');
  assert.equal(await tryAs(g, 'ai', mcp1.token), 'BadCapability');
  // ③'s consent again (rotate mcp): ③'s old token stops, ⑤'s `ai` token and the general token go on.
  const mcp2 = g.rotateCapability('a1', OWNER, 'mcp').capability;
  assert.equal(mcp2.version, 2);
  assert.deepEqual([await tryAs(g, 'mcp', mcp1.token), await tryAs(g, 'mcp', mcp2.token), await tryAs(g, 'ai', ai.token), await tryAs(g, 'ai', general.token)], ['BadCapability', 'AgentStopped', 'AgentStopped', 'AgentStopped']);
  // Rotating the general token leaves the senders' tokens alone.
  const general2 = g.rotateCapability('a1', OWNER).capability;
  assert.deepEqual([await tryAs(g, 'ai', general.token), await tryAs(g, 'ai', general2.token), await tryAs(g, 'ai', ai.token)], ['BadCapability', 'AgentStopped', 'AgentStopped']);
  // Revoking ⑤'s token stops ⑤ only.
  assert.equal(g.revokeCapability('a1', OWNER, 'ai').revoked, true);
  assert.deepEqual([await tryAs(g, 'ai', ai.token), await tryAs(g, 'mcp', mcp2.token)], ['BadCapability', 'AgentStopped']);
  assert.equal(g.revokeCapability('a1', OWNER, 'ai').revoked, false);
  // whoami says which token it is; nothing of a token is stored or shown.
  assert.deepEqual([g.whoami('a1', { capability: mcp2.token }).capabilitySource, g.whoami('a1', { capability: general2.token }).capabilitySource], ['mcp', 'any']);
  assert.throws(() => g.whoami('a1', { capability: ai.token }), { code: 'BadCapability' });
  assert.deepEqual(g.view('a1').senderCapabilities, { mcp: { version: 2 } });
  const saved = JSON.stringify(store.state);
  for (const t of [general, general2, ai, mcp1, mcp2]) assert.ok(!saved.includes(t.token), 'no token in the saved state');
  // Only the owner, only ai | mcp.
  assert.throws(() => g.rotateCapability('a1', 'SomeoneElse111111111111111111111111111111111', 'ai'), { code: 'NotOwner' });
  assert.throws(() => g.rotateCapability('a1', OWNER, 'browser'), { code: 'BadRequest' });
  assert.throws(() => g.revokeCapability('a1', OWNER, 'ws04'), { code: 'BadRequest' });
});

test('restart: a sender\'s token still works after the ledger is read back; a record from before A1 still works', async () => {
  const w1 = world();
  const ai = w1.gateway.rotateCapability('a1', OWNER, 'ai').capability;
  const w2 = world(JSON.parse(JSON.stringify(w1.store.state)));
  assert.equal(await tryAs(w2.gateway, 'ai', ai.token), 'AgentStopped');
  // A record saved before this change has no `capabilities`.
  const old = world();
  const general = old.gateway.rotateCapability('a1', OWNER).capability;
  const s = JSON.parse(JSON.stringify(old.store.state));
  delete s.agentWallet.agents.a1.capabilities;
  const w3 = world(s);
  assert.equal(await tryAs(w3.gateway, 'mcp', general.token), 'AgentStopped');
  assert.equal(await tryAs(w3.gateway, 'mcp', 'not-a-token'), 'BadCapability');
});

test('0002b rebuilds no action that carries the Citizen\'s sequence number', () => {
  assert.ok(SEQ_ACTIONS.has('SendCaravan'));
  assert.ok(!SEQ_ACTIONS.has('Train'));
});
