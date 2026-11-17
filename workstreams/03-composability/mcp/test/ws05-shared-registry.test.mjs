// ③'s MCP and ⑤'s autopilot on ONE agent, sharing ONE workstream 04 act registry (runexec's run store): ③ through
// ④'s client (source mcp, key ws03:<link>:<requestId>, run = the operation), ⑤ through ⑤'s own real port
// (workstream 05 e9d1551a, model-api/src/acts-port.mjs: loadFourActsPort, registerBeforeSend, source ai, key
// ai:<requestId>, run p05-autopilot:<agentId>). Their acts never meet; neither one's state moves the other's; a
// lost answer, a restart and a revocation leave one registration and one transaction for ③; and the states that are
// not proved ends (unknown, unqueryable, an unproved expiry) are never a new attempt on either side.
//
//   RUNEXEC_BIN=<④ runexec>  WS04_ROOT=<④ tree (clients/acts.mjs)>  WS05_ROOT=<⑤ e9d1551a tree>
//   WS03_GATEWAY_ROOT=<④ 95686606 + ⑤'s shared patches>/permutation-gateway   (skipped without them)
// Real: the relay and wallet code, runexec and its SQLite store, ④'s and ⑤'s clients. MOCK: the scripted chain and
// herald; the wallet's fate answer is scripted only where noted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { HAS_FATE, client, connect, server, world } from './fixture.mjs';
import { revokeStatement } from '../src/auth.mjs';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';

const BIN = process.env.RUNEXEC_BIN;
const CLIENT4 = process.env.WS04_ROOT && path.join(process.env.WS04_ROOT, 'workstreams/04-execution/clients/acts.mjs');
const PORT5 = process.env.WS05_ROOT && path.join(process.env.WS05_ROOT, 'workstreams/05-ai-participation/model-api/src/acts-port.mjs');
const skip = !HAS_FATE ? 'needs the wallet with GET /f/agent/fate (WS03_GATEWAY_ROOT)'
  : !BIN || !existsSync(BIN) ? 'set RUNEXEC_BIN to workstream 04\'s runexec'
  : !CLIENT4 || !existsSync(CLIENT4) ? 'set WS04_ROOT (workstream 04\'s clients/acts.mjs)'
  : !PORT5 || !existsSync(PORT5) ? 'set WS05_ROOT to workstream 05\'s tree (model-api/src/acts-port.mjs)' : false;
const sig = (bytes, kp) => Buffer.from(signTalk(bytes, kp)).toString('base64');
async function post(s, p, body) {
  const res = await fetch(`${s.issuer}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
/** 127.0.0.1 in front of the relay's GET /f/agent/fate; `script(key)` may answer instead (states this chain cannot reach). */
function fatePort(w, script = () => null) {
  return new Promise(resolve => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname !== '/f/agent/fate') { res.writeHead(404); res.end('{}'); return; }
      const scripted = script(u.searchParams.get('key'));
      const r = scripted ? { status: 200, json: scripted } : await w.fx.call(w.r.public, 'GET', u.pathname + u.search, {});
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('③ and ⑤ on one agent and one ④ registry: separate acts; lost answer, restart, revocation; no proved end, no new attempt', { skip }, async () => {
  const { createActsClient } = await import(pathToFileURL(CLIENT4).href);
  const five = await import(pathToFileURL(PORT5).href);
  const dir = mkdtempSync(path.join(tmpdir(), 'ws03-ws05-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const db = path.join(dir, 'runs.db');
  const w = await world();
  // ⑤'s acts the wallet has no line for: scripted as ⑤'s autopilot would meet them (it sends nothing in this test).
  const fiveFate = new Map();
  const fp = await fatePort(w, key => fiveFate.get(key) ?? null);
  const gatewayPort = fp.address().port;
  const acts = createActsClient({ bin: BIN, db, gatewayPort });
  const s1 = await server(w, { storeFile, sealKey, acts });
  let s2 = null;
  try {
    const agentId = w.agent.agentId;
    // ⑤'s REAL port on the same store (④'s client underneath, ⑤'s wrapper on top).
    const port5 = await five.loadFourActsPort({ clientPath: CLIENT4, bin: BIN, db, gatewayPort });
    const reg5 = five.registerBeforeSend(port5, { agentId, source: 'ai' });
    const tx5 = five.txStateFromActs(port5, { agentId, source: 'ai' });

    // ③: a caravan whose answer is lost after the wallet sent it.
    const c = await connect(s1, w);
    const m1 = client(s1, c.access_token);
    const st = (await m1.tool('get_village_status')).structuredContent;
    const p = (await m1.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 10 } })).structuredContent;
    w.r.chain.confirm = false;
    w.state.intercept = async (u, init) => { if (u.pathname !== '/f/agent/action') return null; w.state.intercept = null; await w.fx.call(w.r.public, 'POST', u.pathname, { body: JSON.parse(init.body) }); throw new Error('socket hang up (scripted)'); };
    const lost = (await m1.tool('send_caravan', { planId: p.planId, requestId: 'req-share-001' })).structuredContent;
    const opId = lost.error.operationId;
    const run4 = lost.error.receipt.ws04Act.run4Id;

    // ⑤ registers three acts of its own on the same agent, in the same store, at the same time as ③ works.
    const [a, b, d] = await Promise.all([reg5({ requestId: 'p05.share.u' }), reg5({ requestId: 'p05.share.q' }), reg5({ requestId: 'p05.share.e' })]);
    assert.deepEqual([a.ok, b.ok, d.ok, a.connection], [true, true, true, 'real']);
    const signed = (state, why) => ({ retained: true, status: 'sent', sent: true, signature: `sig-${state}`, lastValidBlockHeight: 150, slotFloor: 70, signedAt: 1, state, fate: state, commitment: null, queryFailed: state === 'unqueryable', why });
    fiveFate.set('ai:p05.share.u', signed('unknown', 'past its lifetime; absence not provable'));
    fiveFate.set('ai:p05.share.q', signed('unqueryable', 'node down'));
    fiveFate.set('ai:p05.share.e', signed('expired', 'proved: history covers its lifetime'));
    const u5 = await tx5('sig-unknown', { requestId: 'p05.share.u' });
    const q5 = await tx5('sig-unqueryable', { requestId: 'p05.share.q' });
    const e5 = await tx5('sig-expired', { requestId: 'p05.share.e' });
    assert.deepEqual([u5.fateState, u5.next, u5.newAttemptAllowed, u5.final], ['unknown', 'hold', false, false]);
    assert.deepEqual([q5.fateState, q5.next, q5.newAttemptAllowed, q5.final], ['unqueryable', 'read-again', false, false]);
    assert.deepEqual([e5.fateState, e5.next, e5.newAttemptAllowed], ['expired', 'new-attempt', true], 'only a proved end opens a new attempt');

    // ③'s retry: answered from the wallet, nothing re-sent; ⑤'s registrations did not touch it.
    const posts = () => w.calls.filter(x => x.endsWith('/f/agent/action')).length;
    const n = posts();
    const again = (await m1.tool('send_caravan', { planId: p.planId, requestId: 'req-share-001' })).structuredContent;
    assert.deepEqual([again.state, again.ws04Act.run4Id, again.fate.state], ['accepted', run4, 'pending']);
    assert.equal(posts(), n);
    await s1.close();

    // A restart of ③ on the same stores; then the owner revokes; then the chain finalizes ③'s transaction.
    s2 = await server(w, { storeFile, sealKey, acts: createActsClient({ bin: BIN, db, gatewayPort }) });
    s2.auth.issuer = s1.issuer; s2.auth.resource = `${s1.issuer}/mcp`;
    const m2 = client(s2, c.access_token);
    const after = (await m2.tool('get_operation_status', { operationId: opId })).structuredContent;
    assert.deepEqual([after.state, after.ws04Act.run4Id], ['accepted', run4]);
    const linkId = Object.keys(s2.auth.db.links)[0];
    const at = s2.clock.t;
    assert.equal((await post(s2, '/link/revoke', { linkId, owner: w.o, at, signature: sig(revokeStatement({ linkId, owner: w.o, at }), w.owner) })).status, 200);
    w.r.chain.statuses.set(after.gateway.signature, { slot: 80, err: null, confirmationStatus: 'finalized' });
    const q = await post(s2, '/owner/statement', { owner: w.o });
    const v = await post(s2, '/owner/operations', { owner: w.o, at: q.json.at, signature: sig(Buffer.from(q.json.statementB64, 'base64'), w.owner) });
    const o = v.json.operations.find(x => x.operationId === opId);
    assert.deepEqual([o.state, o.fate.state, o.ws04Act.state, o.ws04Act.run4Id], ['processing', 'landed', 'landed', run4]);

    // The registry: ③'s run holds its one act (mcp), ⑤'s run its three (ai); nothing crossed; ⑤'s holds unchanged.
    const mine = (await acts.list(opId)).acts;
    const theirs = (await port5.list(five.actsRunIdOf(agentId))).acts;
    assert.deepEqual(mine.map(x => [x.source, x.idempotencyKey]), [['mcp', `ws03:${linkId}:req-share-001`]]);
    assert.deepEqual(theirs.map(x => x.source).sort(), ['ai', 'ai', 'ai']);
    assert.ok(theirs.every(x => x.idempotencyKey.startsWith('ai:p05.share.')));
    const u5b = await tx5('sig-unknown', { requestId: 'p05.share.u' });
    assert.deepEqual([u5b.fateState, u5b.newAttemptAllowed], ['unknown', false], 'still held after ③\'s whole run');
    assert.equal(posts(), n);
    assert.equal(w.r.chain.sent.length, 1, 'one transaction in all');
  } finally { fp.close(); await s1.close().catch(() => {}); if (s2) await s2.close(); }
});

test('④\'s register losing a concurrent first registration (UNIQUE): ③ retries that one error once, then sends once', async () => {
  const w = await world();
  let calls = 0;
  const acts = {
    register: async a => { calls++; if (calls === 1) throw Object.assign(new Error('UNIQUE constraint failed: acts.run4_id'), { code: 'BadRequest' }); return { run4Id: 'act-0000000000000000', runId: a.runId, state: 'registered' }; },
    status: async () => ({ run4Id: 'act-0000000000000000', state: 'registered', next: 'wait', newAttemptAllowed: false }),
  };
  const s = await server(w, { acts });
  try {
    const m = client(s, (await connect(s, w)).access_token);
    const st = (await m.tool('get_village_status')).structuredContent;
    const p = (await m.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 10 } })).structuredContent;
    const r = await m.tool('send_caravan', { planId: p.planId, requestId: 'req-race-0001' });
    const posts = w.calls.filter(x => x.endsWith('/f/agent/action')).length;
    assert.equal(calls, 2);
    assert.equal(r.structuredContent.ws04Act?.run4Id ?? r.structuredContent.error?.receipt?.ws04Act?.run4Id, 'act-0000000000000000');
    assert.equal(posts, 1, 'sent once, after the registration');
  } finally { await s.close(); }
});
