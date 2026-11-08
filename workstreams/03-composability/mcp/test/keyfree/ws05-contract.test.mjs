// ③ against ⑤'s per-sender capability contract and Duplicate AS ⑤ DESCRIBED THEM (message from ⑤'s session,
// 2026-11-06; ⑤'s code 09cd4aab has not reached ③). KEY-FREE, PDA-FREE (harness.mjs). The relay's answers are
// scripted to that description over the real AgentGateway (whoami, per-sender tokens); this is a stand-in until
// ⑤'s real series can be run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAS_0008, OWNER, keyfreeWorld, mcpServer } from './harness.mjs';

const skip = HAS_0008 ? false : 'needs a wallet tree with per-sender capabilities (WS03_GATEWAY_ROOT)';
const who = (w, token) => { try { const x = w.g.whoami(w.agentId, { capability: token }).capabilitySource ?? 'unscoped'; return x === 'any' ? 'unscoped' : x; } catch (e) { return e.code; } };
const cmd = async (w, op, params) => (await w.fetch('http://relay.test/f/agent/command', { method: 'POST', body: JSON.stringify({ command: { op, owner: OWNER, agentId: w.agentId, params } }) })).json();

test('⑤\'s contract: ③ sends rotate-capability {source: mcp} only where the view lists senderCapabilities; ⑤\'s ai token survives issue, renewal and ③\'s revocation', { skip }, async () => {
  const w = await keyfreeWorld({ relay: 'ws05' });
  const s = mcpServer(w);
  const ai = (await cmd(w, 'rotate-capability', { source: 'ai' })).capability.token;
  const a = await s.connectViaRelay({ linkId: 'lnk_kf_ws05_a' });
  assert.deepEqual([a.command.op, a.command.params, a.meta.source], ['rotate-capability', { source: 'mcp' }, 'mcp']);
  const b = await s.connectViaRelay({ linkId: 'lnk_kf_ws05_b' });
  assert.deepEqual([who(w, a.token), who(w, b.token), who(w, ai)], ['BadCapability', 'mcp', 'ai']);
  const rr = await s.auth.revokeAtRelay('lnk_kf_ws05_b', { command: { op: 'revoke-capability', owner: OWNER, agentId: w.agentId, params: { source: 'mcp' } }, signature: 'not-run-in-this-harness' });
  assert.equal(rr.confirmed, true, 'mcp gone from senderCapabilities');
  assert.deepEqual([who(w, b.token), who(w, ai)], ['BadCapability', 'ai']);
  assert.deepEqual(w.script.commands, ['rotate-capability', 'rotate-capability', 'rotate-capability', 'revoke-capability']);
});

test('Duplicate (failed, sent: null, the earlier send\'s signature): held and counted; never re-sent; the earlier signature is not adopted even when it lands; only its proven end decides', { skip }, async () => {
  const w = await keyfreeWorld({ relay: 'ws05' });
  const s = mcpServer(w);
  const { linkId } = await s.connectViaRelay();
  const p = await s.plan(linkId);
  w.script.next = 'duplicate';
  const r = await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-dup01' });
  assert.deepEqual([r.state, r.hold?.code, r.gateway.signature], ['accepted', 'Duplicate', null]);
  const earlier = r.gateway.duplicateOf;
  assert.match(earlier, /^sig-dup-/);
  assert.equal((await s.tool(linkId, 'get_connection')).grant.used, 1, 'counted');
  const posts = w.script.posts;
  const again = await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-dup01' });
  assert.deepEqual([again.state, again.hold?.code], ['accepted', 'Duplicate']);
  assert.equal(w.script.posts, posts, 'not re-sent');
  // The earlier transaction lands: still not this request's (it may be another request's), still held.
  w.node.statuses.set(earlier, { slot: 80, err: null, confirmationStatus: 'finalized' });
  const landed = await s.tool(linkId, 'get_operation_status', { operationId: r.operationId });
  assert.deepEqual([landed.state, landed.hold?.code, landed.gateway.signature], ['accepted', 'Duplicate', null]);
  assert.equal((await s.tool(linkId, 'get_connection')).grant.used, 1);
  // A second Duplicate whose earlier transaction is proven never to land: failed, given back.
  w.state.caravans = 1;
  const p2 = await s.plan(linkId);
  w.script.next = 'duplicate';
  const r2 = await s.tool(linkId, 'send_caravan', { planId: p2.planId, requestId: 'req-kf-dup02' });
  w.node.height = 200; w.node.first = 0; // history covers its lifetime, no such transaction
  const end = await s.tool(linkId, 'get_operation_status', { operationId: r2.operationId });
  assert.deepEqual([end.error?.code, end.error?.receipt?.state], ['NotLanded', 'failed']);
  assert.equal(w.script.posts, posts + 1, 'only the second request\'s own first send');
});

test('on ⑤\'s relay ③ never sends 0008\'s issue-capability, and on an old relay it sends nothing', { skip }, async () => {
  const w5 = await keyfreeWorld({ relay: 'ws05' });
  const c = await mcpServer(w5).auth.capabilityCommandFor(OWNER, w5.agentId, 'n', 0);
  assert.equal(c.op, 'rotate-capability');
  const wo = await keyfreeWorld({ relay: 'old' });
  await assert.rejects(mcpServer(wo).auth.capabilityCommandFor(OWNER, wo.agentId, 'n', 0), e => e.error === 'capability_separation_unavailable');
  assert.deepEqual(wo.script.commands, []);
});

test('a Duplicate of this server\'s own earlier operation: that operation carries the transaction; this one ends as its duplicate and gives its hold back (counted once)', { skip }, async () => {
  const w = await keyfreeWorld({ relay: 'ws05' });
  const s = mcpServer(w);
  const { linkId } = await s.connectViaRelay();
  const p1 = await s.plan(linkId);
  w.script.next = 'sent';
  const first = await s.tool(linkId, 'send_caravan', { planId: p1.planId, requestId: 'req-kf-own01' });
  // The relay answers a second request with Duplicate of the first one's signature (scripted, as ⑤ describes).
  w.script.next = 'duplicate';
  w.script.duplicateOf = first.gateway.signature;
  const p2 = await s.plan(linkId);
  const second = await s.tool(linkId, 'send_caravan', { planId: p2.planId, requestId: 'req-kf-own02' });
  const r = second.error?.receipt ?? second;
  assert.deepEqual([second.error?.code, r.state, r.error?.duplicateOfOperation], ['DuplicateOfOperation', 'failed', first.operationId], JSON.stringify(second).slice(0, 400));
  const g = (await s.tool(linkId, 'get_connection')).grant;
  assert.equal(g.used + g.reserved, 1, 'one transaction, counted once');
});
