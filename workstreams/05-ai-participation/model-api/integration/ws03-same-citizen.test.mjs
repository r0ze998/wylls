// ⑤'s autopilot and ③'s REAL MCP server (received package ws03-handoff-v4, HEAD acdcd0bf) on ONE agent of ONE Citizen.
// Not part of the default suite: it needs the received ③ tree and a gateway tree with ③'s patch 0005.
//
//   WS03_MCP=<③ tree>/workstreams/03-composability/mcp  WS03_GATEWAY_ROOT=<gateway tree with 0005>/permutation-gateway \
//     node --test workstreams/05-ai-participation/model-api/integration/ws03-same-citizen.test.mjs
//
// The world is ③'s test world (the real relay routes and AgentGateway over the gateway tests' scripted chain, a fake
// herald): [SIMULATED CHAIN]. The model is ⑤'s HTTP fixture on 127.0.0.1. No outside network, no key, test assets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MCP = process.env.WS03_MCP;
const GW = process.env.WS03_GATEWAY_ROOT;
const skip = !MCP || !GW ? 'needs WS03_MCP and WS03_GATEWAY_ROOT (the received ③ tree and a gateway tree with patch 0005)' : false;

const load = async () => {
  const f = await import(pathToFileURL(path.join(MCP, 'test/fixture.mjs')).href);
  const { createAgentMcp } = await import(pathToFileURL(path.join(GW, 'mcp/agent-mcp.mjs')).href);
  const { RunJournal } = await import('../../src/adapters.mjs');
  const { NATION, northernRequests } = await import('../../src/local-world.mjs');
  const { tool } = await import('../../src/participate.mjs');
  const { anthropicAdapter } = await import('../src/adapters.mjs');
  const { apiDecider } = await import('../src/api-decider.mjs');
  const { Autopilot } = await import('../src/autopilot.mjs');
  const { CitizenBoundary, actorOf } = await import('../src/citizen-boundary.mjs');
  const { loopbackTransport } = await import('../src/http-transport.mjs');
  const { DecisionRegistry } = await import('../src/inference.mjs');
  const { FIXTURE_BOOK } = await import('../src/price-book.mjs');
  const { localReceiptPort } = await import('../src/run-receipt.mjs');
  const { conformance } = await import('../src/run-receipt.conformance.mjs');
  const { RunCostMock } = await import('../src/run-cost.mjs');
  const { startHttpFixture } = await import('../fixture/http-fixture.mjs');
  return { f, createAgentMcp, RunJournal, NATION, northernRequests, tool, anthropicAdapter, apiDecider, Autopilot, CitizenBoundary, actorOf, loopbackTransport, DecisionRegistry, FIXTURE_BOOK, localReceiptPort, conformance, RunCostMock, startHttpFixture };
};

/** ⑤'s side over ③'s world: the public reads participate() needs, from ③'s fixture world. */
function fiveOver(L, w, capability, { script }) {
  const STORES = { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 };
  const NOW = L.f.NOW;
  const board = L.northernRequests(NOW).slice(0, 1).map(r => ({ ...r, ask: { kind: 'train', unit: 0, n: 100 } }));
  const mcp = () => L.createAgentMcp({ relay: L.f.RELAY, agentId: w.agent.agentId, capability: capability(), fetch: w.fetch, source: 'ai' });
  const world = {
    agentId: w.agent.agentId, capability: capability(), mcp,
    publicWorld: { clockSec: () => NOW, bell: () => 30, village: () => ({ stores: { ...STORES }, reserve_troops: { Spearman: 0 }, free_queue_slots: 2 }), requests: () => board.map(x => ({ ...x })) },
    txState: async sig => (await L.f.fx.call(w.r.public, 'GET', `/f/tx/${sig}`)).json,
  };
  return { world, mcp };
}

test('③\'s consent rotates the agent\'s one capability: ⑤ holding the earlier token is refused (BadCapability), nothing sent', { skip }, async () => {
  const L = await load();
  const w = await L.f.world({ allowed: ['transport', 'economy'] });
  const fiveToken = w.agent.capability;
  const five = L.createAgentMcp({ relay: L.f.RELAY, agentId: w.agent.agentId, capability: fiveToken, fetch: w.fetch, source: 'ai' });
  const v = (await L.tool(five, 'agent_view')).structuredContent;
  assert.equal(v.agentId, w.agent.agentId, '⑤ reads with its token before ③ connects');
  const s = await L.f.server(w);
  try {
    const c = await L.f.connect(s, w); // the owner grants ③ the caravan scope: signs rotate-capability
    assert.ok(c.access_token);
    // agent_view is a public read: it still answers, and still says auto and delegated. Only the act is refused.
    const view = (await L.tool(five, 'agent_view')).structuredContent;
    assert.equal(view.mode, 'auto');
    assert.equal(view.delegation?.delegated, true);
    const act = await L.tool(five, 'agent_act', { requestId: 'p05.after-rotate-1', policyVersion: v.policy.version, modeEpoch: v.modeEpoch, action: { name: 'Harvest', fields: {} } });
    assert.equal(act.structuredContent.error?.code, 'BadCapability');
    assert.equal(w.r.chain.sent.length, 0);
  } finally { await s.close(); }
});

test('with one shared capability (the only way both can act on one agent today): ③ sends a caravan while ⑤\'s model thinks — ⑤ sees ws03:… after its mark and does not act (OwnerActed)', { skip }, async () => {
  const L = await load();
  const w = await L.f.world({ allowed: ['transport', 'economy'] });
  // TEST-ONLY: capture the capability ③'s server received from the rotation, to stand for "the owner gives ⑤ the same
  // token". ③ seals it and no product path hands it to ⑤; this is the hypothesis under test, not a supported flow.
  let shared = w.agent.capability;
  w.state.intercept = async (u, init) => { if (u.pathname === '/f/agent/action' && init.body) { const b = JSON.parse(init.body); if (b.capability) shared = b.capability; } return null; };
  const s = await L.f.server(w);
  const c = await L.f.connect(s, w);
  const three = L.f.client(s, c.access_token);
  // One ③ read and a no-op send attempt would capture the token; capture it by a rotation-free read path instead:
  // the first ③ write below; until then ⑤ cannot act, so ⑤'s first tick starts after ③ has written once.
  const st = (await three.tool('get_village_status')).structuredContent;
  const plan1 = (await three.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 50 } })).structuredContent;
  const sent1 = (await three.tool('send_caravan', { planId: plan1.planId, requestId: 'req-5x3-00001' })).structuredContent;
  assert.equal(sent1.state, 'accepted', JSON.stringify(sent1).slice(0, 300));
  assert.notEqual(shared, w.agent.capability, 'the token ⑤ holds now is the rotated one');
  w.state.caravans += 1; // the chain's CARAVANS after ③'s first caravan (the fake herald serves it)

  let during = null;
  const srv = await L.startHttpFixture(async body => {
    // ③ sends a second caravan while ⑤'s model is thinking.
    const p2 = (await three.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 60 } })).structuredContent;
    during = (await three.tool('send_caravan', { planId: p2.planId, requestId: 'req-5x3-00002' })).structuredContent;
    const u = JSON.parse(body.messages.find(m => m.role === 'user').content);
    const r = u.requests[0];
    return { answer: { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'one batch' }] : [], skipped: [] } };
  });
  try {
    const { world } = fiveOver(L, w, () => shared, {});
    const costs = new L.RunCostMock({ available: '100000', caps: { total: '1000000' }, now: () => L.f.NOW * 1000 });
    let ap;
    const citizen = new L.CitizenBoundary({ ownerQuotaReserve: 1 });
    const decider = L.apiDecider({ adapter: L.anthropicAdapter, model: 'claude-fixture-model', transport: L.loopbackTransport({ baseUrl: srv.url }), book: L.FIXTURE_BOOK(), costs, registry: new L.DecisionRegistry(), runId: () => ap.currentRun, sleep: async () => {}, citizen });
    const view = async () => (await L.tool(world.mcp(), 'agent_view')).structuredContent;
    const receipts = L.localReceiptPort({ view, txState: world.txState, costs });
    const v0 = await view();
    const mandate = { mandateId: 'ws03-x', version: 1, agentId: w.agent.agentId, basedOnPolicyVersion: v0.policy.version, purpose: '北方の守り', nation: L.NATION, from: ['Aster-officer'], allowed: ['Train'], partial: true,
      limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 600, Ore: 200, Gold: 100 }, troopsPerRequest: 100 }, expiresAt: L.f.NOW + 3_600, revokedAt: null };
    ap = new L.Autopilot({ world, mandate, decider, journal: new L.RunJournal({ now: () => L.f.NOW * 1000 }), citizen, receipts, mcp: world.mcp, tokenCheck: await (await import('./ws03-harness.mjs')).tokenCheckFor() });
    await ap.start({ by: 'owner' });
    const t = await ap.tick();
    assert.equal(during?.state, 'accepted', `③'s second caravan: ${JSON.stringify(during).slice(0, 200)}`);
    assert.equal(t.inference.status, 'ok');
    assert.equal(t.game[0].code, 'OwnerActed', JSON.stringify(t.game));
    assert.match(ap.journal.entries.find(e => e.step === 'guard' && e.code === 'OwnerActed').reason, /ws03:.*③ ws03/);
    assert.equal(w.r.chain.sent.length, 2, 'only ③\'s two caravans');
    const acts = (await view()).history.filter(h => h.type === 'action');
    assert.ok(acts.every(h => /^ws03:/.test(h.key)), JSON.stringify(acts.map(h => h.key)));
    assert.match(L.actorOf(acts[0]), /③/);
    assert.deepEqual(L.conformance(t.receipt), []);
    // Next tick: ③'s caravans are before the mark now; ⑤ acts, recorded as ai:p05.… (patch 0003) or mcp:p05.… (without).
    const t2 = await ap.tick();
    assert.equal(t2.game[0].outcome, 'sent', JSON.stringify(t2.game));
    const five = (await view()).history.find(h => h.type === 'action' && /p05\./.test(h.key));
    assert.match(five.key, /^(ai|mcp):p05\./);
    ap.stop({ by: 'test' });
  } finally { await srv.close(); await s.close(); }
});

test('the other way round: if the owner rotates the token for ⑤, ③\'s sealed token stops working (③ cannot send)', { skip }, async () => {
  const L = await load();
  const w = await L.f.world({ allowed: ['transport', 'economy'] });
  const s = await L.f.server(w);
  try {
    const c = await L.f.connect(s, w);
    const three = L.f.client(s, c.access_token);
    // The owner rotates again (as they would to hand ⑤ a token): the relay keeps only the newest.
    const rot = await L.f.fx.call(w.r.public, 'POST', '/f/agent/command', { body: L.f.fx.ownerCommand(w.owner, 'rotate-capability', { agentId: w.agent.agentId, params: {} }) });
    assert.equal(rot.status, 200, JSON.stringify(rot.json));
    const st = (await three.tool('get_village_status')).structuredContent;
    const plan = (await three.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 50 } })).structuredContent;
    const r = (await three.tool('send_caravan', { planId: plan.planId, requestId: 'req-rot-00001' })).structuredContent;
    assert.ok(['BadCapability', 'CapabilityUnavailable'].includes(r.error?.code ?? r.hold?.code ?? r.receipt?.hold?.code), JSON.stringify(r).slice(0, 300));
    assert.equal(w.r.chain.sent.length, 0);
  } finally { await s.close(); }
});
