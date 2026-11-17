// After the handoff (docs 11): the owner's view of their operations once a connection is revoked, a capability
// this process cannot open (another seal key), and the arrival quantity kept apart from the end of transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PATCHED, client, connect, encodeCaravanRecord, fx, keypair, server, world } from './fixture.mjs';
import { ownerQueryStatement, revokeStatement } from '../src/auth.mjs';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';

const needsPatch = PATCHED ? false : 'needs patch 0005 in the gateway tree (WS03_GATEWAY_ROOT)';
const sig = (bytes, kp) => Buffer.from(signTalk(bytes, kp)).toString('base64');
const settle = (w, op, outcome = 0, bell = 40) => w.state.events.push({ seq: String(w.state.events.length + 1), sig: 'x', kind: 92, bell, tx: 1,
  body_b64: encodeCaravanRecord('CARAVAN_SETTLED', { bell, ownerTag: BigInt(op.caravan.ownerTag), seq: op.caravan.seq, payload: { outcome } }).toString('base64') });

async function post(s, p, body) {
  const res = await fetch(`${s.issuer}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
/** The owner's signed query, as the /owner page makes it. */
async function ownerOps(s, w, { signer = w.owner, owner = w.o } = {}) {
  const st = await post(s, '/owner/statement', { owner });
  assert.equal(st.status, 200);
  const body = { owner, at: st.json.at, signature: sig(Buffer.from(st.json.statementB64, 'base64'), signer) };
  return { ...(await post(s, '/owner/operations', body)), body };
}
async function revoke(s, w, linkId) {
  const at = s.clock.t;
  const r = await post(s, '/link/revoke', { linkId, owner: w.o, at, signature: sig(revokeStatement({ linkId, owner: w.o, at }), w.owner) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
async function plan(m, from, to, cargo) {
  const st = (await m.tool('get_village_status')).structuredContent;
  const pick = k => (k === 'village' ? st.village.placeId : st.storehouses[0].placeId);
  return (await m.tool('prepare_caravan', { from: pick(from), to: pick(to), cargo })).structuredContent;
}

test('the owner\'s operations without a connection: wallet-signed, once, recent, only their own; the page holds no secret', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const c = await connect(s, w);
    const linkId = Object.keys(s.auth.db.links)[0];
    const good = await ownerOps(s, w);
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.deepEqual(good.json.connections.map(l => l.linkId), [linkId]);
    assert.equal(good.json.connections[0].cancellation, null, 'a live connection has no cancellation');
    assert.ok(!JSON.stringify(good.json).includes(c.access_token) && !JSON.stringify(good.json).includes('v1.'), 'no token, no sealed capability');
    // The same signed query again: refused (good once).
    assert.equal((await post(s, '/owner/operations', good.body)).status, 400);
    // Signed by another key for this owner: refused.
    assert.equal((await ownerOps(s, w, { signer: keypair() })).status, 401);
    // Too old.
    const at = s.clock.t - 11 * 60_000;
    const old = { owner: w.o, at, signature: sig(ownerQueryStatement({ type: 'wylls-mcp-owner-operations/1', aud: s.auth.resource, owner: w.o, at }), w.owner) };
    assert.equal((await post(s, '/owner/operations', old)).status, 400);
    // Signed for another resource: refused.
    const other = { owner: w.o, at: s.clock.t, signature: sig(ownerQueryStatement({ type: 'wylls-mcp-owner-operations/1', aud: 'http://elsewhere.test/mcp', owner: w.o, at: s.clock.t }), w.owner) };
    assert.equal((await post(s, '/owner/operations', other)).status, 401);
    // Another owner sees nothing of this owner's.
    const stranger = keypair();
    const theirs = await ownerOps(s, w, { signer: stranger, owner: stranger.publicKey.toBase58() });
    assert.equal(theirs.status, 200, JSON.stringify(theirs.json));
    assert.deepEqual([theirs.json.connections, theirs.json.operations], [[], []]);
    // Unsigned: refused.
    assert.equal((await post(s, '/owner/operations', { owner: w.o, at: s.clock.t })).status, 401);
    const page = await fetch(`${s.issuer}/owner`);
    assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);
    const html = await page.text();
    assert.ok(!html.includes(c.access_token) && !/v1\.[A-Za-z0-9_-]{16}\./.test(html));
  } finally { await s.close(); }
});

test('consent shows where it sends the owner back, and warns for a loopback client', async () => {
  const w = await world();
  const s = await server(w);
  try {
    const c = await connect(s, w, { redirect: 'http://localhost:3118/callback' });
    assert.match(c.html, /戻り先: <code>http:\/\/localhost:3118<\/code>/);
    assert.match(c.html, /loopback/);
    assert.match(c.html, /session 鍵ではありません/);
  } finally { await s.close(); }
});

test('a capability sealed under another key: held (CapabilityUnavailable), nothing sent, nothing released; the right key resumes it once', { skip: needsPatch }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const w = await world();
  const s1 = await server(w, { storeFile, sealKey });
  const c = await connect(s1, w);
  await s1.close();
  const s2 = await server(w, { storeFile, sealKey: randomBytes(32).toString('base64url') });
  try {
    s2.auth.issuer = s1.issuer; s2.auth.resource = `${s1.issuer}/mcp`;
    assert.deepEqual(s2.auth.sealCheck(), { sealed: 1, unopenable: 1 });
    const m = client(s2, c.access_token);
    const p = await plan(m, 'vault', 'village', { Stone: 100 });
    const held = await m.tool('send_caravan', { planId: p.planId, requestId: 'req-seal-0001' });
    assert.equal(held.isError, true);
    assert.equal(held.structuredContent.error.code, 'CapabilityUnavailable');
    assert.equal(held.structuredContent.error.receipt.state, 'requested');
    assert.equal(held.structuredContent.error.receipt.hold.code, 'CapabilityUnavailable');
    assert.equal(w.r.chain.sent.length, 0, 'nothing was sent');
    const g = (await m.tool('get_connection')).structuredContent.grant;
    assert.deepEqual([g.used, g.reserved], [0, 1], 'the limit stays held: not released');
    const again = await m.tool('send_caravan', { planId: p.planId, requestId: 'req-seal-0001' });
    assert.equal(again.structuredContent.error.code, 'CapabilityUnavailable', 'a retry is held the same way');
    assert.ok(!readFileSync(storeFile, 'utf8').includes(c.access_token));
  } finally { await s2.close(); }
  // The operator restores the key: the same request goes once.
  const s3 = await server(w, { storeFile, sealKey });
  try {
    s3.auth.issuer = s1.issuer; s3.auth.resource = `${s1.issuer}/mcp`;
    const m = client(s3, c.access_token);
    const op = Object.values(s3.auth.db.operations ?? {})[0] ?? Object.values(JSON.parse(readFileSync(storeFile, 'utf8')).operations)[0];
    const sent = await m.tool('send_caravan', { planId: op.planId, requestId: 'req-seal-0001' });
    assert.equal(sent.isError, false, JSON.stringify(sent.structuredContent));
    assert.equal(sent.structuredContent.state, 'accepted');
    assert.equal(sent.structuredContent.hold, undefined, 'the hold is cleared');
    assert.equal(w.r.chain.sent.length, 1, 'one transaction');
  } finally { await s3.close(); }
});

test('after a revocation: a held request with no attempt fails and gives its hold back; a sent one is reconciled to its end; cancellation goes reconciling → done', { skip: needsPatch }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const w = await world();
  const s1 = await server(w, { storeFile, sealKey });
  const c = await connect(s1, w);
  const m1 = client(s1, c.access_token);
  const p1 = await plan(m1, 'vault', 'village', { Stone: 100 });
  const sent = (await m1.tool('send_caravan', { planId: p1.planId, requestId: 'req-rev-sent-01' })).structuredContent;
  assert.equal(sent.state, 'accepted');
  await s1.close();
  // A restart under the wrong key holds the next request.
  const s2 = await server(w, { storeFile, sealKey: randomBytes(32).toString('base64url') });
  try {
    s2.auth.issuer = s1.issuer; s2.auth.resource = `${s1.issuer}/mcp`;
    const m2 = client(s2, c.access_token);
    const p2 = await plan(m2, 'village', 'vault', { Food: 50 });
    assert.equal((await m2.tool('send_caravan', { planId: p2.planId, requestId: 'req-rev-held-01' })).structuredContent.error.code, 'CapabilityUnavailable');
    const linkId = Object.keys(s2.auth.db.links)[0];
    await revoke(s2, w, linkId);
    assert.equal((await m2.rpc('tools/list')).status, 401, 'the connection is gone');
    const view = await ownerOps(s2, w);
    assert.equal(view.status, 200, JSON.stringify(view.json));
    const byReq = Object.fromEntries(view.json.operations.map(o => [o.requestId, o]));
    assert.equal(byReq['req-rev-held-01'].state, 'failed');
    assert.equal(byReq['req-rev-held-01'].error.code, 'GrantRevoked');
    assert.equal(byReq['req-rev-sent-01'].state, 'processing', 'the sent one is followed on the chain, not dropped');
    const cancel = view.json.connections[0].cancellation;
    assert.deepEqual([cancel.newRequests, cancel.state, cancel.awaitingReconciliation], ['stopped', 'reconciling', [byReq['req-rev-sent-01'].operationId]]);
    assert.equal(w.r.chain.sent.length, 1, 'still one transaction');
    const link = s2.auth.link(linkId);
    assert.deepEqual([link.grantUse.used, Object.keys(link.grantUse.reserved).length], [1, 0], 'the held one was released; the sent one stays counted');
    settle(w, { caravan: byReq['req-rev-sent-01'].caravan }, 0);
    s2.clock.t += 1000; // a new signed query (the same bytes would sign to the same, used, signature)
    const later = await ownerOps(s2, w);
    const done = later.json.operations.find(o => o.requestId === 'req-rev-sent-01');
    assert.deepEqual([done.state, done.outcome], ['completed', 'delivered']);
    assert.equal(later.json.connections[0].cancellation.state, 'done');
  } finally { await s2.close(); }
});

test('the end of transport is not a verified amount: a delivery is quantity unverified with the record\'s lower bound (a recorded 0 is not 0); a lost caravan of this request\'s own is none', { skip: needsPatch }, async () => {
  const w = await world();
  const s = await server(w);
  try {
    const c = await connect(s, w);
    const m = client(s, c.access_token);
    const p = await plan(m, 'village', 'vault', { Food: 100 });
    const r = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-arrive-001' })).structuredContent;
    const op = (await m.tool('get_operation_status', { operationId: r.operationId })).structuredContent;
    assert.equal(op.arrival, undefined, 'on the road: no arrival yet');
    settle(w, op, 0);
    const end = (await m.tool('get_operation_status', { operationId: r.operationId })).structuredContent;
    assert.deepEqual([end.state, end.outcome], ['completed', 'delivered']);
    assert.deepEqual([end.arrival.transportEnded, end.arrival.settled, end.arrival.quantity.state], [true, true, 'unverified']);
    assert.deepEqual(end.arrival.quantity.recorded.cargoLogged, {}, 'the settle record\'s cargo (scripted 0): kept as recorded, with its precision');
    assert.match(end.arrival.quantity.recorded.precision, /lower bound/);
    assert.equal(end.arrival.quantity.sent, undefined, 'never the plan\'s cargo as an amount');
    assert.match(end.arrival.quantity.basis, /capacity/);
    assert.equal(end.arrival.quantity.received, undefined, 'no received amount is claimed');
    fx.sound(w.r);
  } finally { await s.close(); }
  // A lost caravan (its own world: the scripted chain does not advance the caravan counter).
  const w2 = await world();
  const s2 = await server(w2);
  try {
    const m2 = client(s2, (await connect(s2, w2)).access_token);
    const p2 = await plan(m2, 'vault', 'village', { Stone: 10 });
    const r2 = (await m2.tool('send_caravan', { planId: p2.planId, requestId: 'req-arrive-002' })).structuredContent;
    const op2 = (await m2.tool('get_operation_status', { operationId: r2.operationId })).structuredContent;
    settle(w2, op2, 1, 41);
    const lost = (await m2.tool('get_operation_status', { operationId: r2.operationId })).structuredContent;
    assert.deepEqual([lost.outcome, lost.arrival.quantity.state], ['lost', 'none']);
  } finally { await s2.close(); }
});

test('an outcome that is unknown, then a seal-key mismatch and a revocation: never released for the mismatch or the caravan counter; held until this request\'s own evidence', { skip: needsPatch }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const clock = { t: Date.now() };
  const w = await world();
  const s1 = await server(w, { storeFile, sealKey, clock, uncertainWindowMs: 60_000 });
  const c = await connect(s1, w);
  const m1 = client(s1, c.access_token);
  const p = await plan(m1, 'vault', 'village', { Stone: 100 });
  w.state.fail = u => u.pathname === '/f/agent/action'; // the relay may or may not have it: unknown
  assert.equal((await m1.tool('send_caravan', { planId: p.planId, requestId: 'req-unk-0001' })).structuredContent.error.code, 'RelayUnreachable');
  w.state.fail = null;
  await s1.close();
  const s2 = await server(w, { storeFile, sealKey: randomBytes(32).toString('base64url'), clock, uncertainWindowMs: 60_000 });
  try {
    s2.auth.issuer = s1.issuer; s2.auth.resource = `${s1.issuer}/mcp`;
    const m2 = client(s2, c.access_token);
    const held = (await m2.tool('send_caravan', { planId: p.planId, requestId: 'req-unk-0001' })).structuredContent;
    assert.equal(held.error.code, 'CapabilityUnavailable');
    const link = () => s2.auth.link(Object.keys(s2.auth.db.links)[0]);
    assert.equal(Object.keys(link().grantUse.reserved).length, 1, 'held, not released');
    // The owner revokes: an attempt was recorded, so it is reconciled, not released.
    await revoke(s2, w, link().linkId);
    let v = await ownerOps(s2, w);
    let op = v.json.operations.find(o => o.requestId === 'req-unk-0001');
    assert.equal(op.state, 'requested');
    assert.equal(Object.keys(link().grantUse.reserved).length, 1, 'still held after the revocation');
    assert.deepEqual(v.json.connections[0].cancellation.awaitingReconciliation, [op.operationId]);
    // Past the window, no trace: the caravan counter is not proof (another route could have sent, and this server
    // does not know its own signature). Held; the reservation is not released; the cancellation is not done.
    clock.t += 61_000;
    v = await ownerOps(s2, w);
    op = v.json.operations.find(o => o.requestId === 'req-unk-0001');
    assert.deepEqual([op.state, op.hold.code], ['requested', 'Indeterminate']);
    assert.equal(Object.keys(link().grantUse.reserved).length, 1, 'still held: neither the mismatch nor the counter releases it');
    assert.equal(v.json.connections[0].cancellation.state, 'reconciling');
    assert.equal(w.r.chain.sent.length, 0);
  } finally { await s2.close(); }
});

test('the answer was lost after the relay sent, then a seal-key mismatch and a revocation: without its own signature, records under its caravan number decide nothing; nothing is released', { skip: needsPatch }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const clock = { t: Date.now() };
  const w = await world();
  w.state.noFate = true; // the older wallet's path (no fate route): its history view
  const s1 = await server(w, { storeFile, sealKey, clock, uncertainWindowMs: 60_000 });
  const c = await connect(s1, w);
  const m1 = client(s1, c.access_token);
  const p = await plan(m1, 'vault', 'village', { Stone: 100 });
  w.state.intercept = async (u, init) => {
    if (u.pathname !== '/f/agent/action') return null;
    w.state.intercept = null;
    await w.fetch(u.toString(), init); // the relay sends
    throw new Error('socket hang up (scripted)');
  };
  assert.equal((await m1.tool('send_caravan', { planId: p.planId, requestId: 'req-lost-0001' })).structuredContent.error.code, 'RelayUnreachable');
  assert.equal(w.r.chain.sent.length, 1);
  await s1.close();
  const s2 = await server(w, { storeFile, sealKey: randomBytes(32).toString('base64url'), clock, uncertainWindowMs: 60_000 });
  try {
    s2.auth.issuer = s1.issuer; s2.auth.resource = `${s1.issuer}/mcp`;
    const m2 = client(s2, c.access_token);
    // The agent wallet's view no longer shows this key (rolled out of its last 50 lines): its own signature stays
    // unknown here. (With the line still in the view, the signature is read without re-sending: lost-answer.test.)
    w.state.intercept = async (u, init) => { if (u.pathname !== '/f/agent' || (init.method ?? 'GET') !== 'GET') return null; const real = await w.fx.call(w.r.public, 'GET', u.pathname + u.search, {}); return { status: 200, json: async () => ({ ...real.json, history: real.json.history.filter(h => !String(h.key ?? '').startsWith('ws03:')), holds: [] }) }; };
    assert.equal((await m2.tool('send_caravan', { planId: p.planId, requestId: 'req-lost-0001' })).structuredContent.error.code, 'CapabilityUnavailable');
    const link = () => s2.auth.link(Object.keys(s2.auth.db.links)[0]);
    await revoke(s2, w, link().linkId);
    // A caravan with this number is on the road and its send is recorded (under the transaction's real signature),
    // but this server never learned its own signature: the number alone does not make it this request's. Held.
    const st = s2.auth.db.operations[Object.keys(s2.auth.db.operations)[0]];
    w.state.moving.push({ ownerTag: st.caravan.ownerTag, seq: st.caravan.seq, faction: 2, src: { kind: 2, p: w.P, q: w.Q, at: 33, gen: 1, tile: 33 }, dst: { kind: 1, p: w.P, q: w.Q, at: w.SITE, gen: 1, tile: 30 }, steps: 3, cargo: [0, 0, 100, 0, 0, 0, 0, 0], arriveTs: fx.GENESIS + 4_000, runs: [], raided: false });
    w.state.events.push({ seq: String(w.state.events.length + 1), sig: 'the-real-signature', kind: 91, bell: 30, tx: 1, slot: 70,
      body_b64: encodeCaravanRecord('CARAVAN_SENT', { ownerTag: BigInt(st.caravan.ownerTag), seq: st.caravan.seq, payload: {} }).toString('base64') });
    clock.t += 61_000;
    let v = await ownerOps(s2, w);
    let op = v.json.operations.find(o => o.requestId === 'req-lost-0001');
    assert.deepEqual([op.state, op.hold.code], ['requested', 'Indeterminate']);
    assert.equal(Object.keys(link().grantUse.reserved).length + link().grantUse.used, 1, 'not released');
    settle(w, { caravan: st.caravan }, 0);
    clock.t += 1000;
    v = await ownerOps(s2, w);
    op = v.json.operations.find(o => o.requestId === 'req-lost-0001');
    assert.deepEqual([op.state, op.outcome ?? null], ['requested', null], 'a settle record for the number is not this request\'s outcome');
    assert.equal(v.json.connections[0].cancellation.state, 'reconciling');
    assert.equal(w.r.chain.sent.length, 1, 'one transaction');
  } finally { await s2.close(); }
});

test('the relay\'s "expired" is not proof of absence: the send stays counted (held) until its own signature is proven absent', { skip: needsPatch }, async () => {
  const clock = { t: Date.now() };
  const w = await world();
  w.state.noFate = true; // the older wallet's path (no fate route): its history view
  const s = await server(w, { clock, uncertainWindowMs: 60_000 });
  try {
    w.r.chain.confirm = false; // sent, not seen landing
    const m = client(s, (await connect(s, w)).access_token);
    const p = await plan(m, 'vault', 'village', { Stone: 100 });
    const r = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-exp-0001' })).structuredContent;
    assert.equal(r.state, 'accepted');
    w.state.intercept = async u => (u.pathname.startsWith('/f/tx/') ? { status: 200, ok: true, json: async () => ({ state: 'expired' }) } : null);
    const a = (await m.tool('get_operation_status', { operationId: r.operationId })).structuredContent;
    assert.equal(a.state, 'accepted', 'not failed on the relay\'s word');
    assert.deepEqual([a.chain.state, a.chain.absenceProven], ['expired', false]);
    assert.equal((await m.tool('get_connection')).structuredContent.grant.used, 1, 'still counted');
    clock.t += 61_000; // the window passes, no trace: still not proof
    const b = (await m.tool('get_operation_status', { operationId: r.operationId })).structuredContent;
    assert.deepEqual([b.state, b.hold.code], ['accepted', 'Indeterminate']);
    assert.equal((await m.tool('get_connection')).structuredContent.grant.used, 1, 'still counted: absence is not proven');
    // The relay proves absence (patch 0007's detail: finalized history over the lifetime): only then decided.
    w.state.intercept = async u => (u.pathname.startsWith('/f/tx/') ? { status: 200, ok: true, json: async () => ({ state: 'expired', detail: { commitment: null, fee: null, lastValidBlockHeight: 150, absence: { proven: true, fate: 'expired', why: 'scripted' } } }) } : null);
    const c = await m.tool('get_operation_status', { operationId: r.operationId });
    assert.deepEqual([c.structuredContent.error.receipt.state, c.structuredContent.error.code], ['failed', 'NotLanded']);
    assert.equal((await m.tool('get_connection')).structuredContent.grant.used, 0, 'given back on proven absence of its own signature');
  } finally { w.state.intercept = null; await s.close(); }
});
