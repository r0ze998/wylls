// This server's operations registered in workstream 04's act registry (the run store), through ④'s own client
// (workstream 04 clients/acts.mjs → `runexec act …`), source `mcp`, the operation id as the caller's run id. ④'s
// runexec reads the wallet's GET /f/agent/fate on 127.0.0.1 (here a loopback port in front of the real relay code).
// Registering is idempotent: a retry, a lost answer, a restart and a revocation never make a second registration
// or a second send.
//
//   RUNEXEC_BIN=<runexec built from workstream 04> WS04_ROOT=<a tree with workstreams/04-execution/clients/acts.mjs>
//   (skipped without them; ④'s tree also as WS03_GATEWAY_ROOT for the wallet's fate route)
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
const CLIENT = process.env.WS04_ROOT && path.join(process.env.WS04_ROOT, 'workstreams/04-execution/clients/acts.mjs');
const skip = !HAS_FATE ? 'needs the wallet with GET /f/agent/fate (WS03_GATEWAY_ROOT = workstream 04\'s tree)'
  : !BIN || !existsSync(BIN) ? 'set RUNEXEC_BIN to workstream 04\'s runexec'
  : !CLIENT || !existsSync(CLIENT) ? 'set WS04_ROOT to a tree with workstreams/04-execution/clients/acts.mjs' : false;
const sig = (bytes, kp) => Buffer.from(signTalk(bytes, kp)).toString('base64');
async function post(s, p, body) {
  const res = await fetch(`${s.issuer}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

/** 127.0.0.1 in front of the relay's GET /f/agent/fate (what ④'s runexec reads). */
function fatePort(w) {
  return new Promise(resolve => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname !== '/f/agent/fate') { res.writeHead(404); res.end('{}'); return; }
      const r = await w.fx.call(w.r.public, 'GET', u.pathname + u.search, {});
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function setup(extra = {}) {
  const { createActsClient } = await import(pathToFileURL(CLIENT).href);
  const w = await world();
  const fp = await fatePort(w);
  const db = path.join(mkdtempSync(path.join(tmpdir(), 'ws03-acts-')), 'runs.db');
  const acts = createActsClient({ bin: BIN, db, gatewayPort: fp.address().port });
  const s = await server(w, { acts, ...extra });
  const c = await connect(s, w);
  const m = client(s, c.access_token);
  const st = (await m.tool('get_village_status')).structuredContent;
  const plan = async () => (await m.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 10 } })).structuredContent;
  return { w, fp, db, acts, createActsClient, s, c, m, plan };
}

test('a send is registered in ④\'s registry (source mcp, run = the operation), and ④\'s receipt follows the wallet', { skip }, async () => {
  const { w, fp, acts, s, m, plan } = await setup();
  try {
    w.r.chain.confirm = false;
    const r = (await m.tool('send_caravan', { planId: (await plan()).planId, requestId: 'req-acts-0001' })).structuredContent;
    assert.match(r.ws04Act.run4Id, /^act-[0-9a-f]{16}$/);
    const o = (await m.tool('get_operation_status', { operationId: r.operationId })).structuredContent;
    assert.deepEqual([o.ws04Act.state, o.ws04Act.next, o.ws04Act.newAttemptAllowed, o.fate.state], ['pending', 'wait', false, 'pending']);
    assert.equal(o.ws04Act.cancel.until.lastValidBlockHeight, o.lifetime.lastValidBlockHeight);
    w.r.chain.statuses.set(r.gateway.signature, { slot: 80, err: null, confirmationStatus: 'finalized' });
    const o2 = (await m.tool('get_operation_status', { operationId: r.operationId })).structuredContent;
    assert.deepEqual([o2.state, o2.ws04Act.state, o2.ws04Act.next], ['processing', 'landed', 'done']);
    const listed = await acts.list(r.operationId);
    assert.equal(listed.acts.length, 1);
    assert.deepEqual([listed.acts[0].source, listed.acts[0].idempotencyKey], ['mcp', `ws03:${Object.keys(s.auth.db.links)[0]}:req-acts-0001`]);
  } finally { fp.close(); await s.close(); }
});

test('④\'s registry unavailable: nothing is sent; once it is back, the retry registers once and sends once', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const { createActsClient } = await import(pathToFileURL(CLIENT).href);
  const w = await world();
  const fp = await fatePort(w);
  const db = path.join(mkdtempSync(path.join(tmpdir(), 'ws03-acts-')), 'runs.db');
  // A registry that cannot run (no such binary): refused before anything leaves.
  const s1 = await server(w, { storeFile, sealKey, acts: createActsClient({ bin: path.join(dir, 'no-such-runexec'), db }) });
  let s2 = null;
  try {
    const c = await connect(s1, w);
    const m1 = client(s1, c.access_token);
    const st = (await m1.tool('get_village_status')).structuredContent;
    const p = (await m1.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 10 } })).structuredContent;
    const r1 = (await m1.tool('send_caravan', { planId: p.planId, requestId: 'req-acts-0003' })).structuredContent;
    assert.equal(r1.error.code, 'RunRegistryUnavailable');
    assert.equal(w.calls.filter(x => x.endsWith('/f/agent/action')).length, 0, 'nothing sent');
    await s1.close();
    const acts = createActsClient({ bin: BIN, db, gatewayPort: fp.address().port });
    s2 = await server(w, { storeFile, sealKey, acts });
    s2.auth.issuer = s1.issuer; s2.auth.resource = `${s1.issuer}/mcp`;
    const m2 = client(s2, c.access_token);
    const r2 = (await m2.tool('send_caravan', { planId: p.planId, requestId: 'req-acts-0003' })).structuredContent;
    assert.equal(r2.state, 'accepted');
    await m2.tool('send_caravan', { planId: p.planId, requestId: 'req-acts-0003' });
    assert.equal(w.calls.filter(x => x.endsWith('/f/agent/action')).length, 1, 'sent once');
    assert.equal((await acts.list(r2.operationId)).acts.length, 1, 'registered once');
    assert.equal(w.r.chain.sent.length, 1);
  } finally { fp.close(); await s1.close().catch(() => {}); if (s2) await s2.close(); }
});

test('lost answer, retry, restart on the same stores, revocation: one registration, one run4Id, one transaction', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const { w, fp, db, acts, createActsClient, s, c, m, plan } = await setup({ storeFile, sealKey });
  let s2 = null;
  try {
    w.r.chain.confirm = false;
    const p = await plan();
    w.state.intercept = async (u, init) => { if (u.pathname !== '/f/agent/action') return null; w.state.intercept = null; await w.fx.call(w.r.public, 'POST', u.pathname, { body: JSON.parse(init.body) }); throw new Error('socket hang up (scripted)'); };
    const lost = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-acts-0002' })).structuredContent;
    const opId = lost.error.operationId;
    const run4 = lost.error.receipt.ws04Act.run4Id;
    assert.match(run4, /^act-/);
    const posts = () => w.calls.filter(x => x.endsWith('/f/agent/action')).length;
    const n = posts();
    const again = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-acts-0002' })).structuredContent;
    assert.deepEqual([again.state, again.ws04Act.run4Id], ['accepted', run4]);
    assert.equal(posts(), n, 'answered from the wallet, not re-sent');
    await s.close();
    // A restart: a new process, the same MCP store and the same run store.
    s2 = await server(w, { storeFile, sealKey, acts: createActsClient({ bin: BIN, db, gatewayPort: fp.address().port }) });
    s2.auth.issuer = s.issuer; s2.auth.resource = `${s.issuer}/mcp`;
    const m2 = client(s2, c.access_token);
    const after = (await m2.tool('send_caravan', { planId: p.planId, requestId: 'req-acts-0002' })).structuredContent;
    assert.deepEqual([after.operationId, after.ws04Act.run4Id], [opId, run4]);
    const linkId = Object.keys(s2.auth.db.links)[0];
    const at = s2.clock.t;
    assert.equal((await post(s2, '/link/revoke', { linkId, owner: w.o, at, signature: sig(revokeStatement({ linkId, owner: w.o, at }), w.owner) })).status, 200);
    w.r.chain.statuses.set(after.gateway.signature, { slot: 80, err: null, confirmationStatus: 'finalized' });
    const q = await post(s2, '/owner/statement', { owner: w.o });
    const v = await post(s2, '/owner/operations', { owner: w.o, at: q.json.at, signature: sig(Buffer.from(q.json.statementB64, 'base64'), w.owner) });
    const o = v.json.operations.find(x => x.operationId === opId);
    assert.deepEqual([o.state, o.ws04Act.state, o.ws04Act.run4Id], ['processing', 'landed', run4]);
    // ④'s registry: exactly one act under this operation; registering again is the same act, not a second.
    assert.equal((await acts.list(opId)).acts.length, 1);
    const twice = await acts.register({ agentId: w.agent.agentId, key: `ws03:${linkId}:req-acts-0002`, source: 'mcp', runId: opId });
    assert.equal(twice.run4Id, run4);
    assert.equal((await acts.list(opId)).acts.length, 1);
    await assert.rejects(acts.register({ agentId: w.agent.agentId, key: `ws03:${linkId}:req-acts-0002`, source: 'mcp', runId: 'another-run' }), e => e.code === 'Conflict');
    assert.equal(posts(), n);
    assert.equal(w.r.chain.sent.length, 1, 'one transaction');
  } finally { fp.close(); await s.close().catch(() => {}); if (s2) await s2.close(); }
});
