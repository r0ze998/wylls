// A lost answer, asked again without sending anything — against an OLDER wallet (no GET /f/agent/fate: its
// history view). The current wallet's seven states are fate.test.mjs. When the relay's answer to send_caravan is lost, a status
// query reads the agent wallet's own record for this request's key from its public view (GET /f/agent?id=, ⑤'s
// gateway as it is; the same read ④'s gateway port makes). A signature found there is this request's own and
// decides as an answer received would; a refusal before signing means nothing was sent; anything else (not found,
// failed without a signature) decides nothing and releases nothing. It works after the connection is revoked (the
// owner's signed query), and the signature's lifetime from patch 0007 becomes ④'s AwaitingSigned.until.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAS_0007, PATCHED, client, connect, encodeCaravanRecord, server, world } from './fixture.mjs';
import { revokeStatement } from '../src/auth.mjs';
import { ws04CancelPhase } from '../src/receipt-port.mjs';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';

const needsPatch = PATCHED ? false : 'needs patch 0005 in the gateway tree (WS03_GATEWAY_ROOT)';
const sig = (bytes, kp) => Buffer.from(signTalk(bytes, kp)).toString('base64');
const le = (v, n) => { let x = BigInt.asUintN(8 * n, BigInt(v)); let out = 0n; for (let i = 0; i < n; i++) { out |= (x & 0xffn) << BigInt(8 * i); x >>= 8n; } return out; };
const placeLog = ({ kind, p, q, at, gen = 1, tile = 0 }) => BigInt(kind) | (le(p, 2) << 8n) | (le(q, 2) << 24n) | (BigInt(at) << 40n) | (BigInt(gen) << 48n) | (BigInt(tile) << 56n);
const cargo = units => { const b = Buffer.alloc(32); units.forEach((u, i) => b.writeUInt32LE(u, 4 * i)); return b; };
const row = (w, name, kind, signature, op, payload) => w.state.events.push({ seq: String(w.state.events.length + 1), sig: signature, kind, bell: 30, tx: 1, slot: 70 + w.state.events.length,
  body_b64: encodeCaravanRecord(name, { ownerTag: BigInt(op.caravan.ownerTag), seq: op.caravan.seq, payload }).toString('base64') });
const status = (m, id) => m.tool('get_operation_status', { operationId: id }).then(x => x.structuredContent);
async function post(s, p, body) {
  const res = await fetch(`${s.issuer}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

/** The relay takes the request and the gateway sends it; the answer never comes back to this server. */
function loseNextAnswer(w) {
  w.state.intercept = async (u, init) => {
    if (u.pathname !== '/f/agent/action') return null;
    w.state.intercept = null;
    await w.fx.call(w.r.public, 'POST', u.pathname, { body: JSON.parse(init.body) });
    throw new Error('socket hang up (scripted: the answer was lost)');
  };
}

async function lostSend({ requestId = 'req-lost-0001' } = {}) {
  const w = await world();
  w.state.noFate = true; // this file: an older wallet without GET /f/agent/fate (its history view); fate.test.mjs is the current one
  const s = await server(w);
  w.r.chain.confirm = false; // sent, no status yet
  const c = await connect(s, w);
  const m = client(s, c.access_token);
  const st = (await m.tool('get_village_status')).structuredContent;
  const p = (await m.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 100 } })).structuredContent;
  loseNextAnswer(w);
  const r = await m.tool('send_caravan', { planId: p.planId, requestId });
  assert.equal(r.structuredContent.error.code, 'RelayUnreachable');
  const opId = r.structuredContent.error.operationId;
  assert.equal(w.r.chain.sent.length, 1, 'the gateway did send it');
  return { w, s, m, c, opId, planId: p.planId, dst: { kind: 1, p: w.P, q: w.Q, at: w.SITE } };
}

test('the answer lost after the send: a status query reads the agent wallet\'s record (no re-send), takes its signature, and that signature decides', { skip: needsPatch }, async () => {
  const { w, s, m, opId, dst } = await lostSend();
  try {
    const actions = () => w.calls.filter(x => x.endsWith('/f/agent/action')).length;
    const before = actions();
    const o = await status(m, opId);
    assert.equal(actions(), before, 'no POST /f/agent/action: nothing re-sent');
    assert.equal(w.r.chain.sent.length, 1, 'still one transaction');
    assert.equal(o.state, 'accepted');
    assert.equal(o.gateway.signature.length > 60, true);
    assert.match(o.gateway.recoveredFrom, /agent wallet history .*read only/);
    assert.deepEqual([o.agentRecord.read, o.agentRecord.found, o.agentRecord.status], [true, true, 'sent']);
    assert.equal(o.error, undefined, 'RelayUnreachable cleared: the record answered');
    assert.equal((await m.tool('get_connection')).structuredContent.grant.used, 1, 'counted as sent');
    if (HAS_0007) {
      assert.equal(typeof o.lifetime.lastValidBlockHeight, 'number');
      assert.equal(o.lifetime.unit, 'block height');
    }
    // Its own record, signed by the recovered signature: on the road.
    row(w, 'CARAVAN_SENT', 91, o.gateway.signature, o, { dst: placeLog(dst), cargo: cargo([0, 0, 100, 0, 0, 0, 0, 0]) });
    const o2 = await status(m, opId);
    assert.deepEqual([o2.state, o2.caravan.mine.signature], ['processing', o.gateway.signature]);
    assert.equal(w.r.chain.sent.length, 1);
  } finally { await s.close(); }
});

test('a send_caravan retry after a lost answer reads the record first: the same operation, nothing re-sent', { skip: needsPatch }, async () => {
  const { w, s, m, opId, planId } = await lostSend({ requestId: 'req-lost-0002' });
  try {
    // The retry comes first (no status query in between): the record is read before anything is re-sent.
    const posts = () => w.calls.filter(x => x.endsWith('/f/agent/action')).length;
    const before = posts();
    const again = (await m.tool('send_caravan', { planId, requestId: 'req-lost-0002' })).structuredContent;
    assert.deepEqual([again.operationId, again.state, again.replayed], [opId, 'accepted', true]);
    assert.equal(posts(), before, 'no POST /f/agent/action: answered from the record');
    assert.equal(w.r.chain.sent.length, 1);
  } finally { await s.close(); }
});

test('after the connection is revoked: the owner\'s signed query reads the record too (no capability, no send), and AwaitingSigned carries until', { skip: needsPatch }, async () => {
  const { w, s, opId } = await lostSend({ requestId: 'req-lost-0003' });
  try {
    const linkId = Object.keys(s.auth.db.links)[0];
    const at = s.clock.t;
    assert.equal((await post(s, '/link/revoke', { linkId, owner: w.o, at, signature: sig(revokeStatement({ linkId, owner: w.o, at }), w.owner) })).status, 200);
    const st = await post(s, '/owner/statement', { owner: w.o });
    const res = await post(s, '/owner/operations', { owner: w.o, at: st.json.at, signature: sig(Buffer.from(st.json.statementB64, 'base64'), w.owner) });
    assert.equal(res.status, 200);
    const o = res.json.operations.find(x => x.operationId === opId);
    assert.equal(o.state, 'accepted');
    assert.match(o.gateway.recoveredFrom, /read only/);
    assert.equal(w.r.chain.sent.length, 1, 'nothing sent after the revocation');
    // ④'s cancel phase for it: signed, not decided, until its recorded lifetime (patch 0007; null without it).
    const phase = ws04CancelPhase({ ...o, attempts: 1 });
    assert.equal(phase.phase, 'AwaitingSigned');
    if (HAS_0007) assert.deepEqual([typeof phase.until.lastValidBlockHeight, phase.until.signature], ['number', o.gateway.signature]);
    else assert.equal(phase.until, null);
  } finally { await s.close(); }
});

test('records that decide nothing: not found, failed without a signature; a refusal before signing fails it (nothing sent under the key)', { skip: needsPatch }, async () => {
  for (const [name, view, expect, holds = () => []] of [
    ['not found', () => [], o => { assert.deepEqual([o.state, o.agentRecord.found], ['requested', false]); assert.match(o.agentRecord.note, /proves nothing/); }],
    ['failed, no signature', key => [{ type: 'action', key, status: 'failed', code: 'SendFailed', seq: 9 }], o => { assert.deepEqual([o.state, o.agentRecord.status, o.gateway?.signature ?? null], ['requested', 'failed', null]); assert.match(o.agentRecord.note, /G-2/); }],
    ['failed after signing (a priced action\'s hold keeps the signature)', key => [{ type: 'action', key, status: 'failed', code: 'SendFailed', seq: 9 }], o => {
      assert.deepEqual([o.state, o.gateway.signature, o.agentRecord.hold.signature], ['accepted', 'SIG-FROM-HOLD', 'SIG-FROM-HOLD']);
      assert.match(o.gateway.recoveredFrom, /hold/);
    }, key => [{ id: 'h1', category: 'game', amount: '5', state: 'sending', key, signature: 'SIG-FROM-HOLD' }]],
    ['refused', key => [{ type: 'action', key, status: 'refused', code: 'BudgetExceeded', seq: 9 }], o => { assert.deepEqual([o.state, o.error.code, o.gateway.status], ['failed', 'BudgetExceeded', 'refused']); }],
  ]) {
    const w = await world();
    w.state.noFate = true;
    const s = await server(w);
    try {
      const m = client(s, (await connect(s, w)).access_token);
      const st = (await m.tool('get_village_status')).structuredContent;
      const p = (await m.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 100 } })).structuredContent;
      w.state.fail = u => u.pathname === '/f/agent/action';
      const r = (await m.tool('send_caravan', { planId: p.planId, requestId: `req-rec-${name.replace(/\W/g, '')}` })).structuredContent;
      w.state.fail = null;
      const linkId = Object.keys(s.auth.db.links)[0];
      const key = `ws03:${linkId}:req-rec-${name.replace(/\W/g, '')}`;
      // The agent view as ⑤'s gateway shapes it, with the line under test.
      w.state.intercept = async u => {
        if (u.pathname !== '/f/agent') return null;
        const real = await w.fx.call(w.r.public, 'GET', u.pathname + u.search, {});
        return { status: 200, json: async () => ({ ...real.json, history: view(key), holds: holds(key) }) };
      };
      const grantBefore = (await m.tool('get_connection')).structuredContent.grant;
      const x = await status(m, r.error.operationId);
      const o = x.error?.receipt ?? x;
      expect(o);
      const g = (await m.tool('get_connection')).structuredContent.grant;
      if (name === 'refused') assert.equal(g.used + g.reserved, grantBefore.used + grantBefore.reserved - 1, 'refused before signing: given back');
      else if (name.startsWith('failed after signing')) assert.equal(g.used + g.reserved, grantBefore.used + grantBefore.reserved, 'counted once, nothing released');
      else assert.deepEqual([g.used, g.reserved], [grantBefore.used, grantBefore.reserved], `${name}: nothing released`);
      assert.equal(w.r.chain.sent.length, 0);
    } finally { await s.close(); }
  }
});

test('AwaitingSigned.until is the recorded lifetime of this request\'s own signature, null without it', () => {
  const base = { state: 'accepted', attempts: 1, caravan: { ownerTag: '1', seq: 0 } };
  assert.deepEqual(ws04CancelPhase({ ...base }), { phase: 'AwaitingSigned', until: null });
  assert.deepEqual(ws04CancelPhase({ ...base, lifetime: { lastValidBlockHeight: 150, source: 'x' } }), { phase: 'AwaitingSigned', until: null }, 'a lifetime without the signature is not used');
  assert.deepEqual(ws04CancelPhase({ ...base, gateway: { signature: 'S' }, lifetime: { lastValidBlockHeight: 150, source: 'relay' } }),
    { phase: 'AwaitingSigned', until: { lastValidBlockHeight: 150, unit: 'block height', signature: 'S', source: 'relay' } });
});
