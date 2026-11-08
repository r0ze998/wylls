// ③'s MCP inputs and outputs against the gateway's public contract (WS03_GATEWAY_ROOT): malformed tool inputs are
// refused by name, never read as something else; what ③ puts on the wire passes the wallet's own ActionRequest parser;
// and the wallet's answers that mean "this key already holds a request" (409 SendFailed / IdempotencyConflict) are
// never taken as "nothing was sent", also on a retry after a stop before an answer was saved. KEY-FREE, PDA-FREE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GATEWAY_ROOT, HAS_SENDERS, keyfreeWorld, mcpServer } from './harness.mjs';

const { parseActionRequest } = await import(pathToFileURL(path.join(GATEWAY_ROOT, 'src/frontier/agent/contract.mjs')).href);
const skip = HAS_SENDERS ? false : 'needs a wallet tree with per-sender capabilities (WS03_GATEWAY_ROOT)';

async function connected() {
  const w = await keyfreeWorld({ relay: 'ws05' });
  const s = mcpServer(w);
  const { linkId } = await s.connectViaRelay();
  const st = await s.tool(linkId, 'get_village_status');
  return { w, s, linkId, st };
}

test('prepare_caravan refuses malformed cargo by name — unknown resource, fraction, text, negative, too large, not an object — and plans nothing', { skip }, async () => {
  const { w, s, linkId, st } = await connected();
  const plansBefore = Object.keys(s.store.state.plans).length;
  const ask = cargo => s.tool(linkId, 'prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo });
  for (const [cargo, field] of [[{ Stone: 10, Gems: 5 }, 'cargo.Gems'], [{ Stone: 10.5 }, 'cargo.Stone'], [{ Stone: '10' }, 'cargo.Stone'],
    [{ Stone: -1 }, 'cargo.Stone'], [{ Stone: 1_000_001 }, 'cargo.Stone'], [{ stone: 10 }, 'cargo.stone']]) {
    const r = await ask(cargo);
    assert.deepEqual([r.error?.code, r.error?.field], ['BadRequest', field], JSON.stringify(cargo));
  }
  for (const cargo of [[0, 0, 10], 'Stone:10', null]) assert.equal((await ask(cargo)).error?.code, 'BadRequest', JSON.stringify(cargo));
  assert.equal(Object.keys(s.store.state.plans).length, plansBefore, 'no plan made');
  assert.equal(w.script.posts, 0, 'nothing sent');
  // The same request well formed plans exactly what was asked.
  const ok = await ask({ Stone: 10 });
  assert.deepEqual(ok.summary.cargo, { Stone: 10 });
});

test('what ③ sends passes the wallet\'s own ActionRequest parser: vault → village and village → vault', { skip }, async () => {
  const { w, s, linkId, st } = await connected();
  const vault = st.storehouses[0].placeId;
  const village = st.village.placeId;
  for (const [from, to, n] of [[vault, village, 'req-kf-enc-01'], [village, vault, 'req-kf-enc-02']]) {
    const p = await s.tool(linkId, 'prepare_caravan', { from, to, cargo: { Stone: 10 } });
    const r = await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: n });
    assert.equal(r.state, 'accepted', JSON.stringify(r.error ?? {}));
    const sent = w.script.requests.at(-1);
    const parsed = parseActionRequest(sent); // throws on anything the wallet would refuse as malformed
    assert.equal(parsed.action.name, 'SendCaravan');
    assert.deepEqual(parsed.action.holding, [-3, 7, 11]);
    assert.equal(parsed.source, 'mcp');
    assert.ok(parsed.action.route.provinces.length >= 1 && parsed.action.route.provinces.length <= 4);
    if (from === vault) assert.deepEqual([parsed.action.route.src.kind, parsed.action.route.dst.kind, parsed.action.route.dst.site], ['vault', 'holding', 11]);
    else assert.deepEqual([parsed.action.route.src, parsed.action.route.dst.kind], [undefined, 'vault']);
    w.state.caravans += 1;
  }
});

/** An operation whose first attempt left this server and whose answer was never saved (the process stopped). */
async function stoppedBeforeAnswer() {
  const { w, s, linkId, st } = await connected();
  const p = await s.tool(linkId, 'prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 10 } });
  w.script.next = 'unreachable';
  const r = await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-409-01' });
  const op = s.store.state.operations[r.error.operationId];
  // On disk as a stop between "attempt counted and saved" and "answer recorded" leaves it: attempts 1, no outcome known.
  op.unknownSince = null; delete op.error; s.store.save();
  return { w, s, linkId, p, opId: op.id };
}

test('a retry after a stop, answered 409 SendFailed (a saved request without a final response): held, its own signature taken, counted, never re-sent', { skip }, async () => {
  const { w, s, linkId, p, opId } = await stoppedBeforeAnswer();
  w.script.next = 'answer';
  w.script.answer = { status: 409, json: { error: 'this action key has a saved request without a final response; inspect its prior signature', code: 'SendFailed', signature: 'sig-prior-409' } };
  const r = await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-409-01' });
  const o = r.error?.receipt ?? r;
  assert.deepEqual([o.state, o.hold?.code, o.gateway.signature], ['accepted', 'PriorRequestUnresolved', 'sig-prior-409'], JSON.stringify(r).slice(0, 300));
  assert.equal((await s.tool(linkId, 'get_connection')).grant.used, 1, 'counted, not given back');
  const posts = w.script.posts;
  await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-409-01' });
  assert.equal(w.script.posts, posts, 'not re-sent: its signature is followed');
  void opId;
});

test('a retry answered 409 IdempotencyConflict (the key holds a different request): held, nothing of it taken as this request\'s, counted', { skip }, async () => {
  const { w, s, linkId, p } = await stoppedBeforeAnswer();
  w.script.next = 'answer';
  w.script.answer = { status: 409, json: { error: 'this idempotency key was used for a different request', code: 'IdempotencyConflict' } };
  const r = await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-409-01' });
  const o = r.error?.receipt ?? r;
  assert.deepEqual([o.state, o.hold?.code, o.gateway.signature], ['accepted', 'KeyHeldByAnotherRequest', null]);
  const g = (await s.tool(linkId, 'get_connection')).grant;
  assert.equal(g.used + g.reserved, 1, 'counted');
});

test('a true first attempt refused before anything (409 AgentStopped) still fails cleanly and gives the hold back', { skip }, async () => {
  const { w, s, linkId, st } = await connected();
  const p = await s.tool(linkId, 'prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 10 } });
  w.script.next = 'answer';
  w.script.answer = { status: 409, json: { error: 'the agent is stopped (manual mode); the owner must switch it to auto', code: 'AgentStopped' } };
  const r = await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-409-02' });
  assert.deepEqual([r.error?.code, r.error?.receipt?.state], ['AgentStopped', 'failed']);
  const g = (await s.tool(linkId, 'get_connection')).grant;
  assert.equal(g.used + g.reserved, 0);
});
