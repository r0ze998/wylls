// Shared set-up for the integration tests over ③'s REAL MCP server and test world (received ws03-handoff-v4, acdcd0bf).
// Needs WS03_MCP (③'s workstreams/03-composability/mcp) and WS03_GATEWAY_ROOT (a permutation-gateway tree with ③'s
// patch 0005). The world is ③'s test world: the real relay routes and AgentGateway over the gateway tests' scripted
// chain, a fake herald [SIMULATED CHAIN]. The model is ⑤'s HTTP fixture on 127.0.0.1. Test assets only.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MCP = process.env.WS03_MCP;
export const GW = process.env.WS03_GATEWAY_ROOT;
/** The gateway tree under test, as the operator states it (git rev-parse of the applied tree; see RESTORE). */
export const GW_TREE = process.env.WS03_GATEWAY_TREE ?? null;
export const skip = !MCP || !GW ? 'needs WS03_MCP and WS03_GATEWAY_ROOT (the received ③ tree and a gateway tree with patch 0005)' : false;
export const tokenCheckFor = async () => { const { ProbeBudget } = await import('../src/access-check.mjs'); return { probe: { enabled: true, relayTree: GW_TREE, budget: new ProbeBudget({ perDay: 20 }) } }; };

export async function load() {
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
}

/** ⑤'s side over ③'s world: the public reads participate() needs, from ③'s fixture world. */
export function fiveOver(L, w, capability) {
  const STORES = { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 };
  const NOW = L.f.NOW;
  const board = L.northernRequests(NOW).slice(0, 2).map((r, i) => ({ ...r, id: `N-${i + 1}`, ask: { kind: 'train', unit: 0, n: 100 } }));
  const mcp = () => L.createAgentMcp({ relay: L.f.RELAY, agentId: w.agent.agentId, capability: capability(), fetch: w.fetch, source: 'ai' });
  const world = {
    agentId: w.agent.agentId, mcp,
    publicWorld: { clockSec: () => NOW, bell: () => 30, village: () => ({ stores: { ...STORES }, reserve_troops: { Spearman: 0 }, free_queue_slots: 2 }), requests: () => board.map(x => ({ ...x })) },
    txState: async sig => (await L.f.fx.call(w.r.public, 'GET', `/f/tx/${sig}`)).json,
  };
  return { world, mcp };
}

/** ⑤'s autopilot over ③'s world, with the model answering `script` from the HTTP fixture. */
export async function autopilotOver(L, w, capability, { script, budget = {} }) {
  const srv = await L.startHttpFixture(script);
  const { world } = fiveOver(L, w, capability);
  const costs = new L.RunCostMock({ available: '100000', caps: { total: '1000000', ...budget }, now: () => L.f.NOW * 1000 });
  let ap;
  const citizen = new L.CitizenBoundary({ ownerQuotaReserve: 1 });
  const decider = L.apiDecider({ adapter: L.anthropicAdapter, model: 'claude-fixture-model', transport: L.loopbackTransport({ baseUrl: srv.url }), book: L.FIXTURE_BOOK(), costs, registry: new L.DecisionRegistry(), runId: () => ap.currentRun, sleep: async () => {}, citizen });
  const view = async () => (await L.tool(world.mcp(), 'agent_view')).structuredContent;
  const receipts = L.localReceiptPort({ view, txState: world.txState, costs });
  const v0 = await view();
  const mandate = { mandateId: 'ws03-x', version: 1, agentId: w.agent.agentId, basedOnPolicyVersion: v0.policy.version, purpose: '北方の守り', nation: L.NATION, from: ['Aster-officer'], allowed: ['Train'], partial: true,
    limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 600, Ore: 200, Gold: 100 }, troopsPerRequest: 100 }, expiresAt: L.f.NOW + 3_600, revokedAt: null };
  const journal = new L.RunJournal({ now: () => L.f.NOW * 1000 });
  ap = new L.Autopilot({ world, mandate, decider, journal, citizen, receipts, mcp: world.mcp, tokenCheck: await tokenCheckFor() });
  return { ap, srv, costs, receipts, view, world, decider, journal, mandate };
}

/** The model's answer: one batch of spearmen for the first open request. */
export const trainFirst = body => {
  const u = JSON.parse(body.messages.find(m => m.role === 'user').content);
  const r = u.requests[0];
  return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'one batch' }] : [], skipped: [] };
};

/**
 * ③'s world with the capability ③'s server received captured (TEST-ONLY: stands for "the owner gives every client the
 * same token", the only way several clients act on one agent today — not a supported flow), and ③'s last SendCaravan
 * request body (to build a ④-executor stand-in's request from).
 */
export async function sharedWorld(L, opts = {}) {
  const w = await L.f.world({ allowed: ['transport', 'economy'], ...opts });
  const cap = { token: w.agent.capability, lastCaravan: null };
  w.state.intercept = async (u, init) => {
    if (u.pathname === '/f/agent/action' && init.body) { const b = JSON.parse(init.body); if (b.capability) cap.token = b.capability; if (b.request?.action?.name === 'SendCaravan') cap.lastCaravan = b.request; }
    return null;
  };
  const s = await L.f.server(w);
  const c = await L.f.connect(s, w);
  const three = L.f.client(s, c.access_token);
  return { w, s, three, cap };
}

/**
 * A STAND-IN for ④'s executor sending through the relay (④'s real executor is Rust over its own simulated canon and is
 * not run here). It sends ③'s caravan action again under ④-style keys `ws04:<run>:<attempt>`, source ai.
 */
export function fourStandIn(L, w, cap) {
  return {
    kind: 'STAND-IN for ④ executor (relay submit, ws04: keys); not ④\'s code',
    async send(runId, attempt, { seq = null, policyVersion = null, modeEpoch = null } = {}) {
      const base = cap.lastCaravan;
      if (!base) throw new Error('no caravan request captured yet');
      const request = { ...base, source: 'ai', idempotencyKey: `ws04:${runId}:${attempt}`, ...(policyVersion ? { policyVersion } : {}), ...(modeEpoch !== null ? { modeEpoch } : {}),
        action: { ...base.action, fields: { ...base.action.fields, ...(seq !== null ? { seq } : {}) } } };
      const res = await L.f.fx.call(w.r.public, 'POST', '/f/agent/action', { body: { capability: cap.token, request } });
      return res.json;
    },
  };
}

/** ③'s plan → send, through ③'s real MCP tools. */
export async function threeSend(three, requestId, cargo = { Stone: 50 }) {
  const st = (await three.tool('get_village_status')).structuredContent;
  const plan = (await three.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo })).structuredContent;
  return { plan, send: async () => (await three.tool('send_caravan', { planId: plan.planId, requestId })).structuredContent };
}
