// Whose caravan is it? A record counts for an operation only when it is proven this request's own: its
// CARAVAN_SENT signed by this request's signature with the plan's content (or its own signature landed). The
// caravan number (owner tag, seq) alone proves nothing: another route can use it. Settle and raid records follow
// only a caravan so proven; the settle record's cargo is floor(milli / 1000), a lower bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATCHED, client, connect, encodeCaravanRecord, server, world } from './fixture.mjs';
import { Ws04MappedPort } from '../src/receipt-port.mjs';
import { encode as base58 } from '../../../../permutation-gateway/client/src/base58.mjs';

const needsPatch = PATCHED ? false : 'needs patch 0005 in the gateway tree (WS03_GATEWAY_ROOT)';
const le = (v, n) => { let x = BigInt.asUintN(8 * n, BigInt(v)); let out = 0n; for (let i = 0; i < n; i++) { out |= (x & 0xffn) << BigInt(8 * i); x >>= 8n; } return out; };
/** caravan.rs Place::log as the 8-byte little-endian integer the record holds. */
const placeLog = ({ kind, p, q, at, gen = 1, tile = 0 }) => BigInt(kind) | (le(p, 2) << 8n) | (le(q, 2) << 24n) | (BigInt(at) << 40n) | (BigInt(gen) << 48n) | (BigInt(tile) << 56n);
const cargo = units => { const b = Buffer.alloc(32); units.forEach((u, i) => b.writeUInt32LE(u, 4 * i)); return b; };
const row = (w, name, kind, sig, op, payload) => w.state.events.push({ seq: String(w.state.events.length + 1), sig, kind, bell: 30, tx: 1, slot: 70 + w.state.events.length,
  body_b64: encodeCaravanRecord(name, { ownerTag: BigInt(op.caravan.ownerTag), seq: op.caravan.seq, payload }).toString('base64') });

async function sent(serverOpts = {}, port) {
  const w = await world();
  const s = await server(w, serverOpts);
  if (port) s.mcp.receiptsOverride = port;
  w.r.chain.confirm = false; // the relay sends; no status yet: only records can tell
  const m = client(s, (await connect(s, w)).access_token);
  const st = (await m.tool('get_village_status')).structuredContent;
  const p = (await m.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 100 } })).structuredContent;
  const r = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-attr-0001' })).structuredContent;
  assert.equal(r.state, 'accepted');
  const dst = { kind: 1, p: w.P, q: w.Q, at: w.SITE };
  return { w, s, m, r, dst };
}
const status = (m, r) => m.tool('get_operation_status', { operationId: r.operationId }).then(x => x.structuredContent);

test('another route\'s send with the same caravan number: held (SeqUsedByAnotherSend), never completed by its settle, nothing released', { skip: needsPatch }, async () => {
  const { w, s, m, r, dst } = await sent();
  try {
    row(w, 'CARAVAN_SENT', 91, 'another-signature', r, { dst: placeLog(dst), cargo: cargo([0, 0, 100, 0, 0, 0, 0, 0]) });
    let o = await status(m, r);
    assert.deepEqual([o.state, o.hold.code, o.hold.evidence.signature], ['accepted', 'SeqUsedByAnotherSend', 'another-signature']);
    row(w, 'CARAVAN_SETTLED', 92, 'keeper', r, { outcome: 0, cargo: cargo([0, 0, 100, 0, 0, 0, 0, 0]) });
    o = await status(m, r);
    assert.deepEqual([o.state, o.outcome ?? null], ['accepted', null]);
    assert.equal((await m.tool('get_connection')).structuredContent.grant.used, 1, 'not released');
  } finally { await s.close(); }
});

test('its own signature but not the plan\'s content (destination): held Inconsistent, not on the road', { skip: needsPatch }, async () => {
  const { w, s, m, r, dst } = await sent();
  try {
    row(w, 'CARAVAN_SENT', 91, r.gateway.signature, r, { dst: placeLog({ ...dst, at: dst.at + 1 }), cargo: cargo([0, 0, 100, 0, 0, 0, 0, 0]) });
    const o = await status(m, r);
    assert.deepEqual([o.state, o.hold.code], ['accepted', 'Inconsistent']);
    assert.match(o.hold.detail, /destination/);
  } finally { await s.close(); }
});

test('its own signature but a different cargo with no wear: held Inconsistent', { skip: needsPatch }, async () => {
  const { w, s, m, r, dst } = await sent();
  try {
    row(w, 'CARAVAN_SENT', 91, r.gateway.signature, r, { dst: placeLog(dst), cargo: cargo([0, 0, 99, 0, 0, 0, 0, 0]), worn_bps: 0 });
    assert.equal((await status(m, r)).hold.code, 'Inconsistent', 'no wear: the record must say what was planned');
  } finally { await s.close(); }
});

test('its own record (signature and content, the road wore 3%): on the road; the settle\'s lower bound, never the plan\'s 100, and a recorded 0 is not 0', { skip: needsPatch }, async () => {
  const { w, s, m, r, dst } = await sent();
  try {
    row(w, 'CARAVAN_SENT', 91, r.gateway.signature, r, { dst: placeLog(dst), cargo: cargo([0, 0, 97, 0, 0, 0, 0, 0]), worn_bps: 300, arrive_ts: 1785700000 });
    let o = await status(m, r);
    assert.deepEqual([o.state, o.hold ?? null, o.caravan.mine.signature, o.caravan.sentCargo], ['processing', null, r.gateway.signature, { Stone: 97 }]);
    row(w, 'CARAVAN_SETTLED', 92, 'keeper', r, { outcome: 0, cargo: cargo([0, 0, 97, 0, 0, 0, 0, 0]) });
    o = await status(m, r);
    assert.deepEqual([o.state, o.outcome, o.arrival.quantity.state, o.arrival.quantity.recorded.cargoLogged], ['completed', 'delivered', 'unverified', { Stone: 97 }]);
    // The same operation in ④'s vocabulary: the village's rule applies to the record's bound, with its precision.
    const v = new Ws04MappedPort().arrival({ ...s.store.state.operations[o.operationId] });
    assert.deepEqual([v.quantity.state, v.quantity.received.atLeast, v.quantity.received.below], ['verified', { Stone: 97 }, { Stone: 98 }]);
    const z = new Ws04MappedPort().arrival({ ...s.store.state.operations[o.operationId], caravan: { ...s.store.state.operations[o.operationId].caravan, settle: { cargoLogged: {}, precision: 'floor' } } });
    assert.deepEqual([z.quantity.state, z.quantity.received.atLeast, z.quantity.received.below], ['verified', {}, {}], 'a recorded 0: at least 0, nothing claimed above it');
    assert.match(z.quantity.received.precision, /at least 0, below 1/);
  } finally { await s.close(); }
});

test('a raid that takes its own caravan (matching record): KnownZero in ④\'s vocabulary; a raid record before the caravan is proven its own counts for nothing', { skip: needsPatch }, async () => {
  const { w, s, m, r, dst } = await sent();
  try {
    row(w, 'CARAVAN_RAIDED', 93, 'raider', r, { choice: 0 });
    let o = await status(m, r);
    assert.deepEqual([o.state, o.outcome ?? null], ['accepted', null], 'not yet proven its own: the raid is not its outcome');
    row(w, 'CARAVAN_SENT', 91, r.gateway.signature, r, { dst: placeLog(dst), cargo: cargo([0, 0, 100, 0, 0, 0, 0, 0]) });
    row(w, 'CARAVAN_RAIDED', 93, 'raider', r, { choice: 0 });
    o = await status(m, r);
    assert.deepEqual([o.state, o.outcome], ['completed', 'taken']);
    const v = new Ws04MappedPort().receipt(s.store.state.operations[o.operationId]).ws04;
    assert.deepEqual([v.state, v.reason, v.outcome.verification], ['Failed', 'Raided', 'KnownZero']);
  } finally { await s.close(); }
});

test('records seen before the signature is known are kept: when the retry brings the signature, the earlier record makes the caravan its own', { skip: needsPatch }, async () => {
  const w = await world();
  const s = await server(w);
  try {
    const m = client(s, (await connect(s, w)).access_token);
    const st = (await m.tool('get_village_status')).structuredContent;
    const p = (await m.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 100 } })).structuredContent;
    w.r.chain.confirm = false;
    // The relay sends, the answer is lost: no signature here.
    w.state.intercept = async (u, init) => { if (u.pathname !== '/f/agent/action') return null; w.state.intercept = null; await w.fetch(u.toString(), init); throw new Error('lost (scripted)'); };
    assert.equal((await m.tool('send_caravan', { planId: p.planId, requestId: 'req-late-sig-1' })).structuredContent.error.code, 'RelayUnreachable');
    const sig = base58(w.r.chain.sent[0].signatures[0]);
    const op = Object.values(s.store.state.operations)[0];
    row(w, 'CARAVAN_SENT', 91, sig, op, { dst: placeLog({ kind: 1, p: w.P, q: w.Q, at: w.SITE }), cargo: cargo([0, 0, 100, 0, 0, 0, 0, 0]) });
    const held = (await m.tool('get_operation_status', { requestId: 'req-late-sig-1' })).structuredContent;
    assert.equal(held.state, 'requested');
    // The retry: the agent wallet answers from its record (same key, no second send) and gives the signature.
    const again = (await m.tool('send_caravan', { planId: p.planId, requestId: 'req-late-sig-1' })).structuredContent;
    assert.equal(again.gateway.replayed, true);
    assert.equal(w.r.chain.sent.length, 1);
    const o = (await m.tool('get_operation_status', { requestId: 'req-late-sig-1' })).structuredContent;
    assert.equal(again.gateway.signature, sig, 'the agent wallet\'s record carries the signature');
    assert.deepEqual([o.state, o.caravan.mine.signature, o.caravan.mine.event], ['processing', sig, '1'], 'the record seen before the signature was known')
  } finally { await s.close(); }
});

