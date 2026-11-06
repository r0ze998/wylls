// ③'s MCP with ④'s act registry and ⑤'s autopilot port on ONE agent — KEY-FREE (harness.mjs: no key generated,
// derived or used; nothing signed). REAL: ③'s server; the agent wallet's AgentGateway/AgentLedger (capability check
// with patch 0008, view, actionFateView, fateOf); ④'s runexec and clients/acts.mjs; ⑤'s acts-port.mjs. MOCK: the
// send's answer, the chain node, the herald; the owner's signed steps are not run (see harness.mjs).
//
//   WS03_GATEWAY_ROOT=<④ d0e96d53 + ⑤ shared patches + ③ 0008/0008b>/permutation-gateway
//   RUNEXEC_BIN=<④ runexec>  WS04_ROOT=<④ tree>  WS05_ROOT=<⑤ e9d1551a tree>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HAS_0008, HAS_FATE, OWNER, keyfreeWorld, mcpServer } from './harness.mjs';

const BIN = process.env.RUNEXEC_BIN;
const CLIENT4 = process.env.WS04_ROOT && path.join(process.env.WS04_ROOT, 'workstreams/04-execution/clients/acts.mjs');
const PORT5 = process.env.WS05_ROOT && path.join(process.env.WS05_ROOT, 'workstreams/05-ai-participation/model-api/src/acts-port.mjs');
const need = (...xs) => xs.find(Boolean) ?? false;
const skipCap = need(!HAS_FATE && 'needs the wallet with GET /f/agent/fate', !HAS_0008 && 'needs patch 0008 in WS03_GATEWAY_ROOT');
const skipAll = need(skipCap, (!BIN || !existsSync(BIN)) && 'set RUNEXEC_BIN', (!CLIENT4 || !existsSync(CLIENT4)) && 'set WS04_ROOT', (!PORT5 || !existsSync(PORT5)) && 'set WS05_ROOT');
const who = (w, token) => { try { return w.g.whoami(w.agentId, { capability: token }).capabilitySource ?? 'unscoped'; } catch (e) { return e.code; } };

async function setup({ storeFile = null } = {}) {
  const { createActsClient } = await import(pathToFileURL(CLIENT4).href);
  const five = await import(pathToFileURL(PORT5).href);
  const w = await keyfreeWorld();
  const fp = await w.fatePort();
  const db = path.join(mkdtempSync(path.join(tmpdir(), 'ws03-kf-')), 'runs.db');
  const gatewayPort = fp.address().port;
  const acts = () => createActsClient({ bin: BIN, db, gatewayPort });
  const port5 = await five.loadFourActsPort({ clientPath: CLIENT4, bin: BIN, db, gatewayPort });
  return { w, fp, db, acts, five, port5 };
}
/** ⑤'s autopilot sending one act the way it does (POST /f/agent/action with its own token, source ai, key ai:<id>). */
async function fiveSends(w, token, requestId, source = 'ai') {
  const res = await w.fetch('http://relay.test/f/agent/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability: token,
    request: { agentId: w.agentId, source, idempotencyKey: `${source}:${requestId}`, policyVersion: 1, action: { name: 'Harvest', holding: [-3, 7, 11], fields: {} } } }) });
  return { status: res.status, json: await res.json() };
}

test('the conflict, reproduced on the real wallet code: the global rotation stops the other holder\'s token', { skip: skipCap }, async () => {
  const w = await keyfreeWorld();
  const fivesToken = w.legacyToken; // today: one token per agent, held by ⑤
  assert.equal(who(w, fivesToken), 'unscoped');
  w.g.rotateCapability(w.agentId, OWNER); // what ③'s consent did before (rotate-capability)
  assert.equal(who(w, fivesToken), 'BadCapability', '⑤ is stopped by ③\'s connection');
});

test('resolved with per-sender capabilities (0008): ③ asks for an mcp token; ⑤\'s ai token survives ③\'s connects; neither acts as the other', { skip: skipCap }, async () => {
  const w = await keyfreeWorld();
  const s = mcpServer(w);
  const ai = w.g.issueSourceCapability(w.agentId, OWNER, 'ai').capability.token; // the owner gives ⑤ its own
  const cmd = await s.auth.capabilityCommandFor(OWNER, w.agentId, 'nonce-kf-1', 0);
  assert.deepEqual([cmd.op, cmd.params], ['issue-capability', { source: 'mcp' }], '③ never asks for the global rotation on such a relay');
  // The relay runs the owner's command (its signature check is the route's unchanged code; not run here).
  let mcp = w.g.issueSourceCapability(w.agentId, OWNER, cmd.params.source).capability.token;
  const link = s.connectAs(mcp);
  mcp = w.g.issueSourceCapability(w.agentId, OWNER, 'mcp').capability.token; // ③ reconnects: its own token only
  s.connectAs(mcp, { linkId: link });
  assert.deepEqual([who(w, ai), who(w, mcp)], ['ai', 'mcp'], '⑤ still holds a working token');
  const p = await s.plan(link);
  const r = await s.tool(link, 'send_caravan', { planId: p.planId, requestId: 'req-kf-cap01' });
  assert.equal(r.state, 'accepted', '③ sends with its mcp token');
  assert.equal((await fiveSends(w, ai, 'p05.cap.1')).json.status, 'sent', '⑤ sends with its ai token, after ③\'s connects');
  assert.equal((await fiveSends(w, mcp, 'p05.cap.2')).json.code, 'BadCapability', '③\'s token cannot act as ai');
  assert.equal((await fiveSends(w, ai, 'p05.cap.3', 'mcp')).json.code, 'BadCapability', '⑤\'s token cannot act as mcp');
  // An older relay (no per-sender capabilities): ③ falls back to the rotation, the conflict as before.
  const v = await s.game.json('GET', `http://relay.test/f/agent?id=${w.agentId}`);
  assert.deepEqual(v.json.capabilities, { ai: { version: 1 }, mcp: { version: 2 } });
});

test('③ and ⑤ on one agent and one ④ registry: separate acts; neither unknown nor unqueryable is a new attempt', { skip: skipAll }, async () => {
  const { w, fp, acts, five, port5 } = await setup();
  try {
    const s = mcpServer(w, { acts: acts() });
    const link = s.connectAs(w.g.issueSourceCapability(w.agentId, OWNER, 'mcp').capability.token);
    const ai = w.g.issueSourceCapability(w.agentId, OWNER, 'ai').capability.token;
    const reg5 = five.registerBeforeSend(port5, { agentId: w.agentId, source: 'ai' });
    const tx5 = five.txStateFromActs(port5, { agentId: w.agentId, source: 'ai' });
    // ③ sends; ⑤ registers before its send (as participate does) and sends, at the same time.
    const p = await s.plan(link);
    const [r3, g5] = await Promise.all([s.tool(link, 'send_caravan', { planId: p.planId, requestId: 'req-kf-reg01' }), reg5({ requestId: 'p05.kf.1' })]);
    assert.deepEqual([r3.state, g5.ok, g5.connection], ['accepted', true, 'real']);
    assert.equal((await fiveSends(w, ai, 'p05.kf.1')).json.status, 'sent');
    // The chain: ⑤'s act is past its lifetime with this node's history starting after it (unknown); then the node is down.
    const sig5 = w.history.find(h => h.key === 'ai:p05.kf.1').signature;
    w.node.height = 200; w.node.first = 1_000;
    const u = await tx5(sig5, { requestId: 'p05.kf.1' });
    assert.deepEqual([u.fateState, u.next, u.newAttemptAllowed], ['unknown', 'hold', false]);
    const o3 = await s.tool(link, 'get_operation_status', { operationId: r3.operationId });
    assert.deepEqual([o3.state, o3.fate.state, o3.hold?.code, o3.ws04Act.state, o3.ws04Act.next], ['accepted', 'unknown', 'ResultUnknown', 'unknown', 'hold']);
    w.node.fail.status = true;
    const q = await tx5(sig5, { requestId: 'p05.kf.1' });
    assert.deepEqual([q.fateState, q.next, q.newAttemptAllowed], ['unqueryable', 'read-again', false]);
    const posts = w.script.posts;
    const again = await s.tool(link, 'send_caravan', { planId: p.planId, requestId: 'req-kf-reg01' });
    assert.equal(w.script.posts, posts, '③ does not send again');
    assert.deepEqual([again.state, again.fate.state, again.hold?.code], ['accepted', 'unqueryable', 'ResultUnknown'], 'could not ask: nothing changes, the hold stays');
    // ④'s registry: one act under ③'s operation (mcp), one under ⑤'s autopilot run (ai).
    const linkKey = `ws03:${link}:req-kf-reg01`;
    assert.deepEqual((await acts().list(r3.operationId)).acts.map(a => [a.source, a.idempotencyKey]), [['mcp', linkKey]]);
    assert.deepEqual((await port5.list(five.actsRunIdOf(w.agentId))).acts.map(a => [a.source, a.idempotencyKey]), [['ai', 'ai:p05.kf.1']]);
    assert.equal(w.script.chainSent, 2, 'one send each');
  } finally { fp.close(); }
});

test('lost answer, a signed failure, an unproven and a proven expiry: only the proven end decides; nothing re-sent', { skip: skipAll }, async () => {
  const { w, fp, acts } = await setup();
  try {
    const s = mcpServer(w, { acts: acts() });
    const link = s.connectAs(w.g.issueSourceCapability(w.agentId, OWNER, 'mcp').capability.token);
    // Lost answer (sent, the answer never came back).
    const p1 = await s.plan(link);
    w.script.next = 'drop';
    const lost = await s.tool(link, 'send_caravan', { planId: p1.planId, requestId: 'req-kf-lost1' });
    assert.equal(lost.error.code, 'RelayUnreachable');
    const n = w.script.posts;
    const back = await s.tool(link, 'send_caravan', { planId: p1.planId, requestId: 'req-kf-lost1' });
    assert.deepEqual([back.state, back.fate.state, back.gateway.recoveredFrom], ['accepted', 'pending', 'agent wallet GET /f/agent/fate (read only)']);
    assert.equal(w.script.posts, n, 'read, not re-sent');
    // Signed, then failed on the way back.
    w.state.caravans = 1;
    const p2 = await s.plan(link);
    w.script.next = 'failed-signed';
    const sf = await s.tool(link, 'send_caravan', { planId: p2.planId, requestId: 'req-kf-sfail' });
    assert.deepEqual([sf.state, sf.gateway.sent], ['accepted', true]);
    // Past the lifetime, the node's history not covering it: unknown, held for both.
    w.node.height = 200; w.node.first = 1_000;
    for (const id of [back.operationId, sf.operationId]) {
      const o = await s.tool(link, 'get_operation_status', { operationId: id });
      assert.deepEqual([o.state, o.fate.state, o.hold?.code], ['accepted', 'unknown', 'ResultUnknown']);
    }
    s.clock.t += 30 * 86_400_000; // a month: time is not evidence
    const late = await s.tool(link, 'send_caravan', { planId: p2.planId, requestId: 'req-kf-sfail' });
    assert.deepEqual([late.state, late.hold?.code], ['accepted', 'ResultUnknown']);
    assert.equal(w.script.posts, n + 1, 'only the signed failure\'s own first send');
    // The node's history now covers their lifetimes and holds neither: proven never to land.
    w.node.first = 0;
    const end = await s.tool(link, 'get_operation_status', { operationId: back.operationId });
    assert.deepEqual([end.error.receipt.state, end.error.code, end.error.receipt.ws04Act.next, end.error.receipt.ws04Act.newAttemptAllowed], ['failed', 'NotLanded', 'new-attempt', true]);
    assert.equal(w.script.posts, n + 1, 'a proven end is not a re-send either: a new attempt is a new requestId');
  } finally { fp.close(); }
});

test('a restart on the same stores and the owner\'s revocation: one registration, one send; ⑤\'s token untouched', { skip: skipAll }, async () => {
  const { w, fp, acts } = await setup();
  const storeFile = path.join(mkdtempSync(path.join(tmpdir(), 'ws03-kf-store-')), 'store.json');
  try {
    const ai = w.g.issueSourceCapability(w.agentId, OWNER, 'ai').capability.token;
    const s1 = mcpServer(w, { storeFile, acts: acts() });
    const link = s1.connectAs(w.g.issueSourceCapability(w.agentId, OWNER, 'mcp').capability.token);
    const p = await s1.plan(link);
    w.script.next = 'drop';
    const lost = await s1.tool(link, 'send_caravan', { planId: p.planId, requestId: 'req-kf-rs001' });
    const opId = lost.error.operationId;
    const run4 = lost.error.receipt.ws04Act.run4Id;
    // A new process on the same MCP store and the same run store.
    const s2 = mcpServer(w, { storeFile, acts: acts(), clock: s1.clock });
    const n = w.script.posts;
    const after = await s2.tool(link, 'send_caravan', { planId: p.planId, requestId: 'req-kf-rs001' });
    assert.deepEqual([after.operationId, after.state, after.ws04Act.run4Id], [opId, 'accepted', run4]);
    assert.equal(w.script.posts, n, 'answered from the wallet after the restart');
    // The owner revokes ③'s link (after the owner's signed statement, not run here): the sealed token is dropped.
    s2.auth.revokeLink(link, 'owner');
    assert.equal(s2.auth.link(link).capability, null);
    w.node.statuses.set(after.gateway.signature, { slot: 80, err: null, confirmationStatus: 'finalized' });
    const owned = await s2.mcp.ownerOperations(OWNER);
    const o = owned.operations.find(x => x.operationId === opId);
    assert.deepEqual([o.state, o.fate.state, o.ws04Act.state, o.ws04Act.run4Id], ['processing', 'landed', 'landed', run4]);
    assert.equal((await acts().list(opId)).acts.length, 1, 'registered once');
    assert.equal(w.script.chainSent, 1, 'sent once');
    assert.equal(who(w, ai), 'ai', '⑤\'s token is not touched by ③\'s revocation');
  } finally { fp.close(); }
});
