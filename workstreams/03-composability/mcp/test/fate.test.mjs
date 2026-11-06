// The agent wallet's seven states (workstream 04's execution contract 2026-11-06 §1), read by this server for its own
// request's key (GET /f/agent/fate), never by sending. Only landed / failed (finalized), expired (proven) and the
// wallet's own not-sent decide; pending waits; unknown is held (it may have landed); unqueryable changes nothing.
// None of signed-failed, unproven expiry, unknown or unqueryable is ever re-sent or released. Against the real relay
// and wallet code (workstream 04's tree), its scripted chain; no keys made outside the wallet's own test fixtures, no
// signing by this server, nothing reaching a real chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HAS_FATE, client, connect, server, world } from './fixture.mjs';
import { revokeStatement } from '../src/auth.mjs';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';

const skip = HAS_FATE ? false : 'needs the wallet with GET /f/agent/fate (workstream 04, WS03_GATEWAY_ROOT)';
const sig = (bytes, kp) => Buffer.from(signTalk(bytes, kp)).toString('base64');
async function post(s, p, body) {
  const res = await fetch(`${s.issuer}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function setup(opts = {}) {
  const w = await world();
  const s = await server(w, opts);
  const c = await connect(s, w);
  const m = client(s, c.access_token);
  const st = (await m.tool('get_village_status')).structuredContent;
  const plan = async (n = 10) => (await m.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: n } })).structuredContent;
  const posts = () => w.calls.filter(x => x.endsWith('/f/agent/action')).length;
  const grant = async () => (await m.tool('get_connection')).structuredContent.grant;
  const status = async id => { const x = (await m.tool('get_operation_status', { operationId: id })).structuredContent; return x.error?.receipt ?? x; };
  return { w, s, c, m, plan, posts, grant, status };
}
const idOf = x => x.operationId ?? x.error?.operationId;
/** The relay sends; its answer never comes back. */
const loseAnswer = w => { w.state.intercept = async (u, init) => { if (u.pathname !== '/f/agent/action') return null; w.state.intercept = null; await w.fx.call(w.r.public, 'POST', u.pathname, { body: JSON.parse(init.body) }); throw new Error('socket hang up (scripted)'); }; };
/** The wallet's answer for every key replaced (states this scripted chain cannot reach: a proven expiry). */
const scriptFate = (w, f) => { w.state.intercept = async u => (u.pathname === '/f/agent/fate' ? { status: 200, json: async () => f(u.searchParams.get('key')) } : null); };

test('signed, then failed on the way back (sent: true, its signature): accepted, never re-sent; its own signature decides at finalized', { skip }, async () => {
  const { w, s, m, plan, posts, grant, status } = await setup();
  try {
    w.r.chain.confirm = false;
    const send = w.r.chain.sendRawTransaction;
    w.r.chain.sendRawTransaction = async raw => { await send(raw); throw new Error('RPC timeout after the bytes left (scripted)'); };
    const p = await plan();
    const r = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-sf01' })).structuredContent;
    w.r.chain.sendRawTransaction = send;
    assert.deepEqual([r.state, r.gateway.status, r.gateway.sent], ['accepted', 'failed', true]);
    assert.ok(r.gateway.signature, 'the failure carries its signature');
    assert.equal(typeof r.lifetime.lastValidBlockHeight, 'number');
    const n = posts();
    const again = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-sf01' })).structuredContent;
    assert.deepEqual([again.state, again.fate.state], ['accepted', 'pending']);
    assert.equal(posts(), n, 'not re-sent');
    assert.equal((await grant()).used, 1, 'counted');
    w.r.chain.statuses.set(r.gateway.signature, { slot: 80, err: null, confirmationStatus: 'confirmed' });
    assert.equal((await status(r.operationId)).state, 'accepted', 'confirmed is not final');
    w.r.chain.statuses.set(r.gateway.signature, { slot: 80, err: null, confirmationStatus: 'finalized' });
    const o = await status(r.operationId);
    assert.deepEqual([o.state, o.fate.state, o.caravan.mine.signature], ['processing', 'landed', r.gateway.signature]);
    assert.equal(w.r.chain.sent.length, 1, 'one transaction');
  } finally { await s.close(); }
});

test('failed at finalized: decided, given back; the same failure at confirmed is not', { skip }, async () => {
  const { w, s, m, plan, grant, status } = await setup();
  try {
    w.r.chain.confirm = false;
    const r = (await m.tool('send_caravan', { planId: (await plan()).planId, requestId: 'req-fate-fl01' })).structuredContent;
    const err = { InstructionError: [3, { Custom: 4 }] };
    w.r.chain.statuses.set(r.gateway.signature, { slot: 80, err, confirmationStatus: 'confirmed' });
    assert.deepEqual([(await status(r.operationId)).state, (await grant()).used], ['accepted', 1]);
    w.r.chain.statuses.set(r.gateway.signature, { slot: 80, err, confirmationStatus: 'finalized' });
    const o = await status(r.operationId);
    assert.deepEqual([o.state, o.error.code, o.fate.state], ['failed', 'TransactionFailed', 'failed']);
    assert.equal((await grant()).used, 0);
  } finally { await s.close(); }
});

test('past its lifetime with no proof of absence (unknown; the relay\'s plain "expired" too): held, never re-sent, never released, past any window', { skip }, async () => {
  const clock = { t: Date.now() };
  const { w, s, m, plan, posts, grant, status } = await setup({ clock, uncertainWindowMs: 60_000 });
  try {
    w.r.chain.confirm = false;
    const p = await plan();
    const r = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-un01' })).structuredContent;
    w.r.chain.height = r.lifetime.lastValidBlockHeight + 10; // past its lifetime
    w.r.chain.getFirstAvailableBlock = async () => r.lifetime.slotFloor + 1_000; // this node's history starts after the send: absence not provable
    w.state.intercept = async u => (u.pathname.startsWith('/f/tx/') ? { status: 200, json: async () => ({ state: 'expired' }) } : null);
    const o = await status(r.operationId);
    assert.deepEqual([o.state, o.fate.state, o.hold.code], ['accepted', 'unknown', 'ResultUnknown']);
    clock.t += 10 * 60_000;
    const n = posts();
    const again = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-un01' })).structuredContent;
    assert.deepEqual([again.state, again.hold.code], ['accepted', 'ResultUnknown']);
    assert.equal(posts(), n, 'not re-sent');
    const g = await grant();
    assert.equal(g.used + g.reserved, 1, 'still counted');
    assert.equal(w.r.chain.sent.length, 1);
  } finally { w.state.intercept = null; await s.close(); }
});

test('proven never to land (expired): failed, given back; only then', { skip }, async () => {
  const { w, s, m, plan, grant, status } = await setup();
  try {
    w.r.chain.confirm = false;
    const r = (await m.tool('send_caravan', { planId: (await plan()).planId, requestId: 'req-fate-ex01' })).structuredContent;
    scriptFate(w, key => ({ retained: true, key, status: 'sent', sent: true, signature: r.gateway.signature, lastValidBlockHeight: 150, state: 'expired', fate: 'expired', commitment: null, queryFailed: false, why: 'scripted: history covers its lifetime, no transaction' }));
    const o = await status(r.operationId);
    assert.deepEqual([o.state, o.error.code, o.chain.absenceProven], ['failed', 'NotLanded', true]);
    assert.equal((await grant()).used, 0);
  } finally { w.state.intercept = null; await s.close(); }
});

test('the node could not be asked (unqueryable): nothing changes, nothing is re-sent, nothing released', { skip }, async () => {
  const { w, s, m, plan, posts, grant, status } = await setup();
  try {
    w.r.chain.confirm = false;
    const p = await plan();
    const r = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-uq01' })).structuredContent;
    const real = w.r.chain.getSignatureStatuses;
    w.r.chain.getSignatureStatuses = async () => { throw new Error('node down (scripted)'); };
    const o = await status(r.operationId);
    assert.deepEqual([o.state, o.fate.state, o.fate.queryFailed], ['accepted', 'unqueryable', true]);
    const n = posts();
    await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-uq01' });
    assert.equal(posts(), n, 'not re-sent');
    assert.equal((await grant()).used, 1);
    w.r.chain.getSignatureStatuses = real;
  } finally { await s.close(); }
});

test('the answer lost: read from the wallet (no POST); the relay unreachable for the read: NotResent, no POST', { skip }, async () => {
  const { w, s, m, plan, posts, status } = await setup();
  try {
    w.r.chain.confirm = false;
    const p = await plan();
    loseAnswer(w);
    const lost = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-la01' })).structuredContent;
    assert.equal(lost.error.code, 'RelayUnreachable');
    // The relay cannot be read either: a retry does not send (it cannot tell whether the wallet got the first).
    w.state.fail = u => u.pathname === '/f/agent/fate';
    const n = posts();
    const blocked = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-la01' })).structuredContent;
    assert.deepEqual([blocked.error.code, blocked.error.fate.state], ['NotResent', 'unqueryable']);
    assert.equal(posts(), n);
    w.state.fail = null;
    const o = await status(idOf(lost));
    assert.deepEqual([o.state, o.fate.state, o.gateway.recoveredFrom], ['accepted', 'pending', 'agent wallet GET /f/agent/fate (read only)']);
    assert.equal(posts(), n, 'read, not re-sent');
    assert.equal(w.r.chain.sent.length, 1);
  } finally { await s.close(); }
});

test('the request never reached the wallet (it holds nothing under the key): the retry is the first send under the same key, once', { skip }, async () => {
  const { w, s, m, plan, posts } = await setup();
  try {
    const p = await plan();
    w.state.fail = u => u.pathname === '/f/agent/action';
    assert.equal((await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-nr01' })).structuredContent.error.code, 'RelayUnreachable');
    w.state.fail = null;
    assert.equal(w.r.chain.sent.length, 0);
    const n = posts();
    const r = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-nr01' })).structuredContent;
    assert.equal(r.state, 'accepted');
    assert.equal(posts(), n + 1);
    await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-nr01' });
    assert.equal(posts(), n + 1, 'then never again');
    assert.equal(w.r.chain.sent.length, 1);
  } finally { await s.close(); }
});

test('failed before anything was sent (sent: false): failed, given back; the wallet\'s fate says not-sent', { skip }, async () => {
  const { w, s, m, plan, grant } = await setup();
  try {
    const real = w.r.chain.getLatestBlockhash;
    w.r.chain.getLatestBlockhash = async () => { throw new Error('RPC down before building (scripted)'); };
    const r = (await m.tool('send_caravan', { planId: (await plan()).planId, requestId: 'req-fate-ns01' })).structuredContent;
    w.r.chain.getLatestBlockhash = real;
    assert.deepEqual([r.error.receipt.state, r.error.receipt.gateway.sent], ['failed', false]);
    assert.equal((await grant()).used + (await grant()).reserved, 0);
    assert.equal(w.r.chain.sent.length, 0);
  } finally { await s.close(); }
});

test('lost answer, a restart on the same store, then a revocation: the owner\'s view reads the wallet; one transaction, counted once', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const { w, s, c, m, plan } = await setup({ storeFile, sealKey });
  w.r.chain.confirm = false;
  const p = await plan();
  loseAnswer(w);
  const lost = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-rs01' })).structuredContent;
  await s.close();
  const s2 = await server(w, { storeFile, sealKey });
  try {
    s2.auth.issuer = s.issuer; s2.auth.resource = `${s.issuer}/mcp`;
    const m2 = client(s2, c.access_token);
    const posts = () => w.calls.filter(x => x.endsWith('/f/agent/action')).length;
    const n = posts();
    const again = (await m2.tool('send_caravan', { planId: p.planId, requestId: 'req-fate-rs01' })).structuredContent;
    assert.deepEqual([again.operationId, again.state], [idOf(lost), 'accepted']);
    assert.equal(posts(), n, 'answered from the wallet after the restart');
    const linkId = Object.keys(s2.auth.db.links)[0];
    const at = s2.clock.t;
    assert.equal((await post(s2, '/link/revoke', { linkId, owner: w.o, at, signature: sig(revokeStatement({ linkId, owner: w.o, at }), w.owner) })).status, 200);
    w.r.chain.statuses.set(again.gateway.signature, { slot: 80, err: null, confirmationStatus: 'finalized' });
    const q = await post(s2, '/owner/statement', { owner: w.o });
    const v = await post(s2, '/owner/operations', { owner: w.o, at: q.json.at, signature: sig(Buffer.from(q.json.statementB64, 'base64'), w.owner) });
    const o = v.json.operations.find(x => x.operationId === idOf(lost));
    assert.deepEqual([o.state, o.fate.state], ['processing', 'landed']);
    assert.equal(posts(), n);
    assert.equal(w.r.chain.sent.length, 1);
    assert.equal(s2.auth.link(linkId).grantUse.used + Object.keys(s2.auth.link(linkId).grantUse.reserved).length, 1, 'counted once');
  } finally { await s2.close(); }
});
