// The world context the relay serves changes under a running server (a migration, or today's season switch as the
// stand-in for one): the connection, the owner's identity and the operation history carry over; nothing of one
// context is read or sent as another's; operations in flight are neither failed nor released for the change alone;
// a restart on the same store keeps all of it; and when the context they belong to is served again, they go on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PATCHED, client, connect, encodeCaravanRecord, server, world } from './fixture.mjs';
import { ownerQueryStatement } from '../src/auth.mjs';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';

const needsPatch = PATCHED ? false : 'needs patch 0005 in the gateway tree (WS03_GATEWAY_ROOT)';
const settle = (w, op) => w.state.events.push({ seq: String(w.state.events.length + 1), sig: 'keeper', kind: 92, bell: 40, tx: 1, slot: 90,
  body_b64: encodeCaravanRecord('CARAVAN_SETTLED', { bell: 40, ownerTag: BigInt(op.caravan.ownerTag), seq: op.caravan.seq, payload: { outcome: 0 } }).toString('base64') });

test('a context change under a running server: history kept, nothing of the old context read or sent as the new one\'s, nothing released; a restart keeps it; the old context served again lets tracking go on', { skip: needsPatch }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const w = await world();
  const first = w.fx.SEASON_ID;
  const s1 = await server(w, { storeFile, sealKey });
  const c = await connect(s1, w);
  const m1 = client(s1, c.access_token);
  const st = (await m1.tool('get_village_status')).structuredContent;
  const plan = to => m1.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: to } }).then(r => r.structuredContent);
  // A: sent and landed (its own signature): on the road.
  const pa = await plan(100);
  const a = (await m1.tool('send_caravan', { planId: pa.planId, requestId: 'req-ctx-a-01' })).structuredContent;
  const a1 = (await m1.tool('get_operation_status', { operationId: a.operationId })).structuredContent;
  assert.equal(a1.state, 'processing');
  assert.match(a1.context, /:5$/);
  w.state.caravans = 1;
  // B: the relay unreachable: outcome unknown, one attempt recorded.
  const pb = await plan(50);
  w.state.fail = u => u.pathname === '/f/agent/action';
  assert.equal((await m1.tool('send_caravan', { planId: pb.planId, requestId: 'req-ctx-b-01' })).structuredContent.error.code, 'RelayUnreachable');
  w.state.fail = null;
  // C: prepared, not sent.
  const pc = await plan(10);
  const sentBefore = w.r.chain.sent.length;
  const grantBefore = (await m1.tool('get_connection')).structuredContent.grant;

  // ---- the boundary: the relay and herald now serve another context.
  w.switchContext(first + 1n);
  const conn = (await m1.tool('get_connection')).structuredContent;
  assert.match(conn.context.current.key, /:6$/);
  assert.deepEqual(conn.context.changes.map(x => x.seasonId), ['5'], 'the change is recorded, the old context named');
  assert.deepEqual([conn.grant.used, conn.grant.reserved], [grantBefore.used, grantBefore.reserved], 'the grant carries over unchanged');
  // The owner's places in the new context are not the old ones: no read is passed off as theirs.
  const v = await m1.tool('get_village_status');
  assert.equal(v.isError, true);
  // C: the old plan is not sent in the new context.
  const cRes = await m1.tool('send_caravan', { planId: pc.planId, requestId: 'req-ctx-c-01' });
  assert.equal(cRes.isError, true);
  // B: the retry makes no new attempt in the new context; it is held, not failed, not released.
  const b = await m1.tool('send_caravan', { planId: pb.planId, requestId: 'req-ctx-b-01' });
  const bR = b.structuredContent.receipt ?? b.structuredContent.error?.receipt ?? b.structuredContent;
  assert.deepEqual([bR.state, bR.hold?.code], ['accepted', 'ContextChanged']);
  // A: its old context's records are not read in the new one, even if one appears: held, not completed.
  settle(w, a1);
  const a2 = (await m1.tool('get_operation_status', { operationId: a.operationId })).structuredContent;
  assert.deepEqual([a2.state, a2.hold?.code, a2.hold?.from, a2.hold?.to], ['processing', 'ContextChanged', a1.context, conn.context.current.key]);
  assert.equal(w.r.chain.sent.length, sentBefore, 'nothing sent across the boundary');
  const listed = (await m1.tool('list_operations')).structuredContent.operations;
  assert.equal(listed.length, 2, 'the history is all there');
  await s1.close();

  // ---- a restart on the same store, still in the new context.
  const s2 = await server(w, { storeFile, sealKey });
  try {
    s2.auth.issuer = s1.issuer; s2.auth.resource = `${s1.issuer}/mcp`;
    const m2 = client(s2, c.access_token);
    const a3 = (await m2.tool('get_operation_status', { operationId: a.operationId })).structuredContent;
    assert.deepEqual([a3.state, a3.hold?.code], ['processing', 'ContextChanged']);
    // The owner's view without a connection: the owner's identity does not depend on the context.
    const q = (await fetch(`${s2.issuer}/owner/statement`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: w.o }) }).then(r => r.json()));
    const body = { owner: w.o, at: q.at, signature: Buffer.from(signTalk(ownerQueryStatement({ type: 'wylls-mcp-owner-operations/1', aud: s2.auth.resource, owner: w.o, at: q.at }), w.owner)).toString('base64') };
    const owned = await fetch(`${s2.issuer}/owner/operations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    assert.deepEqual(owned.operations.map(o => o.context).sort(), [a1.context, a1.context]);
    // ---- the operations' own context is served again: tracking goes on from where it was.
    w.switchContext(first);
    const a4 = (await m2.tool('get_operation_status', { operationId: a.operationId })).structuredContent;
    assert.deepEqual([a4.state, a4.outcome], ['completed', 'delivered'], 'its own context\'s settle record, read in its own context');
    assert.equal(w.r.chain.sent.length, sentBefore, 'still no second send');
    const g = (await m2.tool('get_connection')).structuredContent.grant;
    // B's attempt may have been sent, so its hold moved from reserved to used when it was held; nothing was counted
    // twice and nothing given back: the total is what it was before the boundary.
    assert.equal(g.used + g.reserved, grantBefore.used + grantBefore.reserved, 'counted once each, none released');
  } finally { await s2.close(); }
});

test('an operation stored before contexts were recorded is not assumed to be the current context\'s', async () => {
  const { receiptOf } = await import('../src/ports.mjs');
  const legacy = receiptOf({ id: 'op_l', requestId: 'r', kind: 'caravan.send', state: 'accepted', createdAt: 't', updatedAt: 't', steps: [], planSummary: {} });
  assert.deepEqual([legacy.context, legacy.contextRecorded], [null, false]);
  const recorded = receiptOf({ id: 'op_n', requestId: 'r', kind: 'caravan.send', state: 'accepted', createdAt: 't', updatedAt: 't', steps: [], planSummary: {}, context: 'P:5' });
  assert.deepEqual([recorded.context, recorded.contextRecorded], ['P:5', true]);
});
