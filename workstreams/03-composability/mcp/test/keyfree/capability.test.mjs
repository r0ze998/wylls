// Issuing, renewing and revoking ③'s sender capability next to ⑤'s, on the integrated wallet (④ d0e96d53 + ⑤'s shared
// patches + ③ 0008/0008b) — KEY-FREE (harness.mjs). REAL: the wallet's AgentGateway (issue, rotate, revoke, whoami,
// the per-sender check), ③'s Auth (the command it builds, the relay step after the owner's signature, the relay-side
// revocation and its check). MOCK: the relay's signature check on owner commands (not run), an older relay (scripted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAS_0008, OWNER, keyfreeWorld, mcpServer } from './harness.mjs';

const skip = HAS_0008 ? false : 'needs patch 0008 in WS03_GATEWAY_ROOT';
const who = (w, token) => { try { const r = w.g.whoami(w.agentId, { capability: token }); return r.capabilitySource ?? r.source ?? 'unscoped'; } catch (e) { return e.code; } };
const five = async w => (await w.fetch('http://relay.test/f/agent/command', { method: 'POST', body: JSON.stringify({ command: { op: 'rotate-capability', owner: OWNER, agentId: w.agentId, params: { source: 'ai' } } }) })).json();

test('issue: ③ asks for its own mcp token; ⑤\'s ai token (⑤\'s rotate-capability {source} form) keeps working; one whoami contract', { skip }, async () => {
  const w = await keyfreeWorld();
  const s = mcpServer(w);
  const ai = (await five(w)).capability;
  assert.deepEqual([ai.source, who(w, ai.token)], ['ai', 'ai'], '⑤\'s form issues an ai token on this relay');
  const c = await s.connectViaRelay();
  assert.deepEqual([c.command.op, c.command.params, c.meta], ['issue-capability', { source: 'mcp' }, { source: 'mcp', version: 1 }]);
  const wm = w.g.whoami(w.agentId, { capability: c.token });
  assert.deepEqual([wm.capabilitySource, wm.capabilitySourceVersion, 'source' in wm], ['mcp', 1, false], 'capabilitySource is the one field');
  assert.equal(who(w, ai.token), 'ai', '⑤ is not stopped by ③\'s connection');
  assert.deepEqual(w.script.commands, ['rotate-capability', 'issue-capability']);
});

test('renew: a new connection replaces ③\'s old token at the relay (the old one is refused there), ⑤\'s untouched; the old link cannot send', { skip }, async () => {
  const w = await keyfreeWorld();
  const s = mcpServer(w);
  const ai = (await five(w)).capability.token;
  const first = await s.connectViaRelay({ linkId: 'lnk_keyfree_old' });
  const second = await s.connectViaRelay({ linkId: 'lnk_keyfree_new' });
  assert.deepEqual([who(w, first.token), who(w, second.token), who(w, ai)], ['BadCapability', 'mcp', 'ai']);
  assert.equal(second.meta.version, 2);
  const p = await s.plan('lnk_keyfree_old');
  const r = await s.tool('lnk_keyfree_old', 'send_caravan', { planId: p.planId, requestId: 'req-kf-old01' });
  assert.equal(r.error?.code, 'BadCapability', 'the replaced token is refused by the relay itself');
  assert.equal(w.script.chainSent, 0);
  const p2 = await s.plan('lnk_keyfree_new');
  assert.equal((await s.tool('lnk_keyfree_new', 'send_caravan', { planId: p2.planId, requestId: 'req-kf-new01' })).state, 'accepted');
});

test('revoke: dropping ③\'s copy is not enough — the owner\'s revoke-capability {mcp} is forwarded and the relay no longer accepts the token', { skip }, async () => {
  const w = await keyfreeWorld();
  const s = mcpServer(w);
  const ai = (await five(w)).capability.token;
  const c = await s.connectViaRelay();
  s.auth.revokeLink(c.linkId, 'owner');
  assert.equal(s.auth.link(c.linkId).capability, null, '③\'s sealed copy is gone');
  assert.equal(who(w, c.token), 'mcp', 'but by itself that leaves the token valid at the relay');
  // ③ cannot revoke another sender's capability with the owner's command for this link.
  await assert.rejects(s.auth.revokeAtRelay(c.linkId, { command: { op: 'revoke-capability', owner: OWNER, agentId: w.agentId, params: { source: 'ai' } }, signature: 'x' }), e => e.error === 'invalid_request');
  const rr = await s.auth.revokeAtRelay(c.linkId, { command: { op: 'revoke-capability', owner: OWNER, agentId: w.agentId, params: { source: 'mcp' } }, signature: 'not-run-in-this-harness' });
  assert.deepEqual([rr.confirmed, s.auth.link(c.linkId).relayRevoke.confirmed], [true, true]);
  assert.deepEqual([who(w, c.token), who(w, ai)], ['BadCapability', 'ai'], 'refused at the relay; ⑤ still works');
  const v = (await s.game.json('GET', `http://relay.test/f/agent?id=${w.agentId}`)).json;
  assert.deepEqual(v.capabilities, { ai: { version: 1 } });
});

test('an older relay (one capability per agent): no write connection, nothing sent to the relay, ⑤\'s token intact — and why', { skip }, async () => {
  const w = await keyfreeWorld({ relay: 'old' });
  const s = mcpServer(w);
  const fives = w.legacyToken;
  await assert.rejects(s.auth.capabilityCommandFor(OWNER, w.agentId, 'n', 0), e => e.error === 'capability_separation_unavailable' && e.status === 409 && /stop the agent's other senders/.test(e.message));
  await assert.rejects(s.connectViaRelay(), e => e.error === 'capability_separation_unavailable');
  assert.deepEqual([w.script.commands, who(w, fives)], [[], 'unscoped'], 'no command reached the relay; ⑤ keeps working');
  // What the stop prevents (the operator's explicit opt-in): the rotation stops ⑤.
  const s2 = mcpServer(w, { allowGlobalRotate: true });
  const c = await s2.connectViaRelay();
  assert.deepEqual([c.command.op, c.meta.source, who(w, fives)], ['rotate-capability', null, 'BadCapability']);
});

test('a relay that answers a sender\'s request with the agent\'s one token: not kept, refused with the reason', { skip }, async () => {
  const w = await keyfreeWorld({ relay: 'unbound' });
  const s = mcpServer(w);
  await assert.rejects(s.connectViaRelay(), e => e.error === 'capability_separation_unavailable' && /not bound to the mcp sender/.test(e.message));
  assert.equal(Object.keys(s.auth.db.links).length, 0, 'no link, no token kept');
});
