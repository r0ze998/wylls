// A caller's run id (workstream 06's run) carried by ③ into workstream 04's registry and answered back by run — KEY-FREE
// (harness.mjs). REAL: ③'s server, ④'s runexec and clients/acts.mjs, ⑤'s acts-port, the wallet's capability check and
// fate logic. MOCK: the send's answer, the node, the herald; ⑥'s run id is a string here (⑥ 517796dc's runs are
// its own mock and not yet connected to ④: ④ INTEGRATION-20261106b §2).
//
//   WS03_GATEWAY_ROOT=<④ d0e96d53 + ⑤ shared patches + ③ 0008/0008b>/permutation-gateway
//   RUNEXEC_BIN=<④ runexec>  WS04_ROOT=<④ tree>  WS05_ROOT=<⑤ e9d1551a tree>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HAS_0008, OWNER, keyfreeWorld, mcpServer, openRunStore } from './harness.mjs';

const BIN = process.env.RUNEXEC_BIN;
const CLIENT4 = process.env.WS04_ROOT && path.join(process.env.WS04_ROOT, 'workstreams/04-execution/clients/acts.mjs');
const PORT5 = process.env.WS05_ROOT && path.join(process.env.WS05_ROOT, 'workstreams/05-ai-participation/model-api/src/acts-port.mjs');
const skip = [!HAS_0008 && 'needs patch 0008', (!BIN || !existsSync(BIN)) && 'set RUNEXEC_BIN', (!CLIENT4 || !existsSync(CLIENT4)) && 'set WS04_ROOT', (!PORT5 || !existsSync(PORT5)) && 'set WS05_ROOT'].find(Boolean) ?? false;
// ⑥'s own forms (⑥ 59bc9565, workstreams/06-creation/src/connect): run = ws06:<plan hash, 64 hex>:<request 1–16>:<step 1–40>,
// requestId = ws06.<48 hex of the content hash>.
const RUN6 = `ws06:${'ab'.repeat(32)}:1:2`;
const REQ6 = n => `ws06.${String(n).padStart(2, '0').repeat(24)}`;

async function setup(extra = {}) {
  const { createActsClient } = await import(pathToFileURL(CLIENT4).href);
  const w = await keyfreeWorld();
  const fp = await w.fatePort();
  const db = path.join(mkdtempSync(path.join(tmpdir(), 'ws03-run-')), 'runs.db');
  await openRunStore(createActsClient, BIN, db); // before ③ and ⑤ use it at once (harness.mjs: ④'s cold-open race)
  const acts = () => createActsClient({ bin: BIN, db, gatewayPort: fp.address().port });
  return { w, fp, db, acts, s: mcpServer(w, { acts: acts(), ...extra }) };
}

test('two sends of one ⑥ run: registered under the run in ④\'s registry; get_run_status answers both, sending nothing', { skip }, async () => {
  const { w, fp, acts, s } = await setup();
  try {
    const { linkId } = await s.connectViaRelay();
    const p1 = await s.plan(linkId);
    const a = await s.tool(linkId, 'send_caravan', { planId: p1.planId, requestId: REQ6(1), runId: RUN6 });
    w.state.caravans = 1;
    const p2 = await s.plan(linkId);
    const b = await s.tool(linkId, 'send_caravan', { planId: p2.planId, requestId: REQ6(2), runId: RUN6 });
    assert.deepEqual([a.state, b.state, a.runId, a.ws04Act.runId], ['accepted', 'accepted', RUN6, RUN6]);
    const reg = (await acts().list(RUN6)).acts;
    assert.deepEqual(reg.map(x => [x.source, x.runId]).sort(), [['mcp', RUN6], ['mcp', RUN6]]);
    const posts = w.script.posts;
    w.node.statuses.set(a.gateway.signature, { slot: 80, err: null, confirmationStatus: 'finalized' });
    const rs = await s.tool(linkId, 'get_run_status', { runId: RUN6 });
    assert.deepEqual(rs.operations.map(o => [o.requestId, o.state]).sort(), [[REQ6(1), 'processing'], [REQ6(2), 'accepted']]);
    assert.deepEqual([rs.registry.read, rs.registry.acts.length], [true, 2]);
    assert.equal(w.script.posts, posts, 'read only');
    // The run is fixed for a requestId.
    const other = await s.tool(linkId, 'send_caravan', { planId: p1.planId, requestId: REQ6(1), runId: 'ws06.run.other.0001' });
    assert.equal(other.error.code, 'IdempotencyConflict');
  } finally { fp.close(); }
});

test('a ⑥ run through a lost answer, a restart and the owner\'s revocation: one registration under the run, one send; unknown is held, not re-sent', { skip }, async () => {
  const { w, fp, acts } = await setup();
  const storeFile = path.join(mkdtempSync(path.join(tmpdir(), 'ws03-run-store-')), 'store.json');
  try {
    const s1 = mcpServer(w, { storeFile, acts: acts() });
    const { linkId } = await s1.connectViaRelay();
    const p = await s1.plan(linkId);
    w.script.next = 'drop';
    const lost = await s1.tool(linkId, 'send_caravan', { planId: p.planId, requestId: REQ6(3), runId: RUN6 });
    assert.equal(lost.error.code, 'RelayUnreachable');
    const run4 = lost.error.receipt.ws04Act.run4Id;
    const s2 = mcpServer(w, { storeFile, acts: acts(), clock: s1.clock });
    const posts = w.script.posts;
    const back = await s2.tool(linkId, 'send_caravan', { planId: p.planId, requestId: REQ6(3), runId: RUN6 });
    assert.deepEqual([back.state, back.ws04Act.run4Id, back.runId], ['accepted', run4, RUN6]);
    // Past its lifetime, the node's history not covering it: unknown — held, not re-sent, at any time later.
    w.node.height = 200; w.node.first = 1_000;
    s2.clock.t += 7 * 86_400_000;
    const held = await s2.tool(linkId, 'get_run_status', { runId: RUN6 });
    assert.deepEqual([held.operations[0].state, held.operations[0].fate.state, held.operations[0].hold.code, held.registry.acts[0].state], ['accepted', 'unknown', 'ResultUnknown', 'unknown']);
    const again = await s2.tool(linkId, 'send_caravan', { planId: p.planId, requestId: REQ6(3), runId: RUN6 });
    assert.equal(again.hold.code, 'ResultUnknown');
    // The owner revokes (③'s copy and, with the owner's command, the relay's mcp token).
    s2.auth.revokeLink(linkId, 'owner');
    const rr = await s2.auth.revokeAtRelay(linkId, { command: { op: 'revoke-capability', owner: OWNER, agentId: w.agentId, params: { source: 'mcp' } }, signature: 'not-run-in-this-harness' });
    assert.equal(rr.confirmed, true);
    const owned = await s2.mcp.ownerOperations(OWNER);
    const o = owned.operations.find(x => x.operationId === back.operationId);
    assert.deepEqual([o.state, o.runId, o.ws04Act.run4Id], ['accepted', RUN6, run4]);
    assert.equal((await acts().list(RUN6)).acts.length, 1, 'one registration under the run');
    assert.equal(w.script.posts, posts, 'nothing re-sent after the lost answer');
    assert.equal(w.script.chainSent, 1);
  } finally { fp.close(); }
});

test('③ (mcp, a ⑥ run) and ⑤ (ai, its autopilot run) on one agent and one registry, each with its own capability', { skip }, async () => {
  const { w, fp, acts, s } = await setup();
  try {
    const five = await import(pathToFileURL(PORT5).href);
    // ⑤'s real port over ④'s client on the same run store (what loadFourActsPort builds).
    const reg5 = five.registerBeforeSend(five.fourActsPort(acts()), { agentId: w.agentId, source: 'ai' });
    const ai = (await (await w.fetch('http://relay.test/f/agent/command', { method: 'POST', body: JSON.stringify({ command: { op: 'rotate-capability', owner: OWNER, agentId: w.agentId, params: { source: 'ai' } } }) })).json()).capability.token;
    const { linkId } = await s.connectViaRelay();
    const p = await s.plan(linkId);
    const [r3, g5] = await Promise.all([s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: REQ6(4), runId: RUN6 }), reg5({ requestId: 'p05.co.1' })]);
    const s5 = await (await w.fetch('http://relay.test/f/agent/action', { method: 'POST', body: JSON.stringify({ capability: ai, request: { agentId: w.agentId, source: 'ai', idempotencyKey: 'ai:p05.co.1', policyVersion: 1, action: { name: 'Harvest', holding: [-3, 7, 11], fields: {} } } }) })).json();
    assert.deepEqual([r3.state, g5.ok, s5.status], ['accepted', true, 'sent']);
    assert.deepEqual((await acts().list(RUN6)).acts.map(x => x.source), ['mcp']);
    assert.deepEqual((await acts().list(five.actsRunIdOf(w.agentId))).acts.map(x => x.source), ['ai']);
  } finally { fp.close(); }
});

/** ⑥'s reading of a run (its message): the registry's acts of source mcp whose key ends with :<requestId>. */
const sixReads = (rs, requestId) => (rs.registry?.read ? rs.registry.acts.filter(a => a.source === 'mcp' && a.idempotencyKey.endsWith(`:${requestId}`)) : null);

test('⑥\'s calling pattern: plan errors send nothing (re-plan under the same ids); PlanUsed names the operation that used it; a reconnect never sends a requestId twice; ⑥ reads the run by key suffix', { skip }, async () => {
  const { w, fp, s } = await setup();
  try {
    const { linkId } = await s.connectViaRelay({ linkId: 'lnk_kf_six_a' });
    // A plan that expired: refused before anything; no operation exists for the requestId.
    const stale = await s.plan(linkId);
    s.clock.t += 10 * 60_000;
    const exp = await s.tool(linkId, 'send_caravan', { planId: stale.planId, requestId: REQ6(5), runId: RUN6 });
    assert.equal(exp.error.code, 'PlanExpired');
    assert.equal(w.script.posts, 0, 'nothing sent');
    // ⑥ makes a new plan and calls again with the same requestId and runId: sent once.
    const fresh = await s.plan(linkId);
    const sent = await s.tool(linkId, 'send_caravan', { planId: fresh.planId, requestId: REQ6(5), runId: RUN6 });
    assert.equal(sent.state, 'accepted');
    // The same plan under another requestId: PlanUsed names the operation that sent it (⑥ must hold, not re-plan).
    const used = await s.tool(linkId, 'send_caravan', { planId: fresh.planId, requestId: REQ6(6), runId: RUN6 });
    assert.deepEqual([used.error.code, used.error.operationId], ['PlanUsed', sent.operationId]);
    // The owner reconnects (a new link); ⑥ retries the same requestId on it: refused, nothing sent.
    await s.connectViaRelay({ linkId: 'lnk_kf_six_b' });
    w.state.caravans = 1;
    const p2 = await s.plan('lnk_kf_six_b');
    const again = await s.tool('lnk_kf_six_b', 'send_caravan', { planId: p2.planId, requestId: REQ6(5), runId: RUN6 });
    assert.deepEqual([again.error.code, again.error.operationId], ['RequestIdUsedOnAnotherConnection', sent.operationId]);
    assert.equal(w.script.posts, 1, 'one send in all');
    // ⑥ reads the run on the new connection by the registry (its acts are per run, not per connection).
    const rs = await s.tool('lnk_kf_six_b', 'get_run_status', { runId: RUN6 });
    const mine = sixReads(rs, REQ6(5));
    assert.deepEqual([mine.length, mine[0].state, mine[0].idempotencyKey], [1, 'pending', `ws03:lnk_kf_six_a:${REQ6(5)}`]);
  } finally { fp.close(); }
});
