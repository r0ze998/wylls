// One Citizen, two clients: a stand-in for the owner's own MCP client (③, NOT ③'s code: a second MCP server on the
// same agent with requestIds 'o3.…') and ⑤'s autopilot, with the model behind the HTTP fixture on 127.0.0.1.
// Also the RunReceipt port (local adapter; ④'s is not received) and its conformance checks.
// No outside network, no key, test assets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RunJournal } from '../../src/adapters.mjs';
import { createAgentMcp } from '../../src/deps.mjs';
import { createLocalWorld, northernRequests } from '../../src/local-world.mjs';
import { tool } from '../../src/participate.mjs';
import { mandateFor } from '../../test/helpers.mjs';
import { anthropicAdapter, openaiAdapter } from '../src/adapters.mjs';
import { apiDecider } from '../src/api-decider.mjs';
import { Autopilot } from '../src/autopilot.mjs';
import { CitizenBoundary, actorOf } from '../src/citizen-boundary.mjs';
import { loopbackTransport } from '../src/http-transport.mjs';
import { DecisionRegistry } from '../src/inference.mjs';
import { FIXTURE_BOOK } from '../src/price-book.mjs';
import { RECEIPT_FIELDS, localReceiptPort } from '../src/run-receipt.mjs';
import { checkCancel, checkCosts, conformance } from '../src/run-receipt.conformance.mjs';
import { RunCostMock } from '../src/run-cost.mjs';
import { startHttpFixture } from '../fixture/http-fixture.mjs';

const BOTH = [['Claude', anthropicAdapter, 'claude-fixture-model'], ['GPT', openaiAdapter, 'gpt-fixture-model']];
const userOf = body => JSON.parse((body.messages ?? body.input).find(m => m.role === 'user').content);
const answerFirst = body => { const r = userOf(body).requests[0]; return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'one batch' }] : [], skipped: [] }; };
const board = () => { const b = northernRequests()[0]; return [1, 2, 3].map(i => ({ ...b, id: `R-${i}`, title: `第${i}陣`, ask: { kind: 'train', unit: 0, n: 100 } })); };
/** Whether the shared MCP server takes a `source` (the proposed patch 0003 applied). */
const MCP_HAS_SOURCE = /source = 'mcp'/.test(readFileSync(new URL('../../../../permutation-gateway/mcp/agent-mcp.mjs', import.meta.url), 'utf8'));

async function setup({ adapter, model, script, citizen = new CitizenBoundary({ ownerQuotaReserve: 1 }), timeoutMs = 2_000 }) {
  const srv = await startHttpFixture(script);
  const w = await createLocalWorld({ requests: board(), stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
  const costs = new RunCostMock({ available: '100000', now: () => w.state.clock * 1000 });
  let ap;
  const decider = apiDecider({ adapter, model, transport: loopbackTransport({ baseUrl: srv.url, timeoutMs }), book: FIXTURE_BOOK(), costs, registry: new DecisionRegistry(), runId: () => ap.currentRun, sleep: async () => {}, citizen });
  const mandate = mandateFor(w, { allowed: ['Train'], limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 600, Ore: 200, Gold: 100 }, troopsPerRequest: 100 } });
  const view = async () => (await tool(w.mcp(), 'agent_view')).structuredContent;
  const receipts = localReceiptPort({ view, txState: w.txState, costs });
  // ⑤ acts through its own MCP server, declaring source ai (taken only where patch 0003 is applied; ignored otherwise).
  const fiveMcp = () => createAgentMcp({ relay: 'http://relay.test', agentId: w.agentId, capability: w.capability, fetch: w.fetch, source: 'ai' });
  ap = new Autopilot({ world: w, mandate, decider, journal: new RunJournal({ now: () => w.state.clock * 1000 }), citizen, receipts, mcp: fiveMcp });
  // The owner's own MCP client on the same agent (the ③ stand-in): the default source mcp, its own requestIds.
  const owner = createAgentMcp({ relay: 'http://relay.test', agentId: w.agentId, capability: w.capability, fetch: w.fetch });
  const ownerAct = async id => { const v = await view(); return (await tool(owner, 'agent_act', { requestId: `o3.${id}`, policyVersion: v.policy.version, modeEpoch: v.modeEpoch, action: { name: 'Harvest', fields: {} } })).structuredContent; };
  return { srv, w, costs, decider, ap, receipts, view, ownerAct, close: () => { ap.stop({ by: 'test' }); return srv.close(); } };
}

for (const [name, adapter, model] of BOTH) {
  test(`${name}: the owner's own MCP acts while ⑤'s model is thinking — ⑤ does not act on that observation (OwnerActed); the receipt shows both seq marks`, async () => {
    let s;
    s = await setup({ adapter, model, script: async body => { await s.ownerAct('during-0001'); return { answer: answerFirst(body) }; } });
    try {
      await s.ap.start({ by: 'owner' });
      const t = await s.ap.tick();
      assert.equal(t.inference.status, 'ok', 'the model call succeeded');
      assert.equal(t.game[0].outcome, 'skipped');
      assert.equal(t.game[0].code, 'OwnerActed');
      assert.equal(s.w.sentCount(), 1, 'only the owner\'s Harvest was sent');
      const r = t.receipt;
      assert.ok(r.seq.closed > r.seq.observed);
      assert.deepEqual(r.acts, [], 'nothing of ⑤ reached agent_act');
      assert.deepEqual(conformance(r), []);
      // The next tick observes again (the owner's act is now before the mark) and acts.
      s.w.advance(60);
      const t2 = await s.ap.tick();
      assert.equal(t2.game[0].outcome, 'sent');
      assert.deepEqual(conformance(t2.receipt), []);
    } finally { await s.close(); }
  });
}

test('attribution: ⑤\'s act is told from the owner\'s by its key prefix; the relay\'s source tells them apart only with patch 0003', async () => {
  const s = await setup({ adapter: openaiAdapter, model: 'gpt-fixture-model', script: body => ({ answer: answerFirst(body) }) });
  try {
    await s.ownerAct('before-0001');
    await s.ap.start({ by: 'owner' });
    const t = await s.ap.tick();
    assert.equal(t.game[0].outcome, 'sent');
    const acts = (await s.view()).history.filter(h => h.type === 'action');
    const five = acts.find(h => /p05\./.test(h.key));
    const three = acts.find(h => /o3\./.test(h.key));
    assert.equal(actorOf(five), 'autopilot (⑤)');
    assert.match(actorOf(three), /another MCP client/);
    if (MCP_HAS_SOURCE) assert.deepEqual([five.source, three.source], ['ai', 'mcp']);
    else assert.deepEqual([five.source, three.source], ['mcp', 'mcp'], 'without patch 0003 the relay records both as mcp');
    assert.equal(t.receipt.acts[0].idempotencyKey, five.key);
    assert.equal(t.receipt.acts[0].source, five.source);
  } finally { await s.close(); }
});

test('the owner\'s reserves of the shared quota and day budget: no model call that could only eat into them', async () => {
  const q = await setup({ adapter: anthropicAdapter, model: 'claude-fixture-model', script: body => ({ answer: answerFirst(body) }), citizen: new CitizenBoundary({ ownerQuotaReserve: 40 }) });
  try {
    await q.ap.start({ by: 'owner' });
    const t = await q.ap.tick();
    assert.equal(t.inference.status, 'not-called');
    assert.ok(t.inference.preflight.includes('QuotaReservedForOwner'));
    assert.equal(q.srv.requests(), 0);
    assert.equal(q.costs.items.size, 0);
  } finally { await q.close(); }
  const b = await setup({ adapter: anthropicAdapter, model: 'claude-fixture-model', script: body => ({ answer: answerFirst(body) }), citizen: new CitizenBoundary({ ownerQuotaReserve: 0, ownerBudgetReserve: '1000001' }) }); // the day budget is 1,000,000: the owner keeps more than is left
  try {
    await b.ap.start({ by: 'owner' });
    const t = await b.ap.tick();
    assert.ok(t.inference.preflight.includes('BudgetReservedForOwner'));
    assert.equal(b.srv.requests(), 0);
  } finally { await b.close(); }
});

test('seq: entries after the mark that are not ⑤\'s are the owner\'s; a window that no longer reaches the mark is a gap', () => {
  const c = new CitizenBoundary();
  const v = (seq, history) => ({ historySeq: seq, history, quota: { left: 10 }, policy: { budget: {} } });
  const observed = v(10, [{ seq: 10, type: 'mode' }]);
  assert.deepEqual(c.beforeAct(observed, v(12, [{ seq: 11, type: 'action', key: 'mcp:p05.abc', source: 'mcp' }, { seq: 12, type: 'hold' }])), { ok: true });
  const owner = c.beforeAct(observed, v(11, [{ seq: 11, type: 'action', key: 'mcp:o3.x', source: 'mcp' }]));
  assert.equal(owner.code, 'OwnerActed');
  assert.equal(c.beforeAct(observed, v(11, [{ seq: 11, type: 'policy' }])).code, 'OwnerActed');
  assert.equal(c.beforeAct(observed, v(80, [{ seq: 31, type: 'hold' }])).code, 'HistoryGap');
});

test('RunReceipt (local adapter): fields, fates, cancel stages, and what only ④ can give', async () => {
  const s = await setup({ adapter: openaiAdapter, model: 'gpt-fixture-model', script: body => ({ answer: answerFirst(body) }) });
  try {
    await s.ap.start({ by: 'owner' });
    const t = await s.ap.tick();
    const r0 = t.receipt;
    assert.equal(r0.provenance, 'local adapter (④ RunReceipt not received)');
    assert.equal(r0.acts[0].fate, 'unknown');
    s.w.settle();
    const r = await s.receipts.refreshFates(r0.runId);
    assert.equal(r.acts[0].fate, 'landed');
    assert.deepEqual(conformance(r), []);
    assert.deepEqual(checkCancel(s.receipts, r.runId), []);
    assert.equal(s.receipts.cancel(r.runId, 'signed-unsent').result, 'NotSupported');
    assert.deepEqual(r.missingFrom4, Object.entries(RECEIPT_FIELDS).filter(([, f]) => f.from4).map(([k]) => k));
    assert.ok(r.missingFrom4.includes('run4Id') && r.missingFrom4.includes('acts[].cancellable'));
    assert.equal(r.run4Id, null);
  } finally { await s.close(); }
});

test('RunReceipt: an undecided inference is shown as undecided, never 0; the checker catches a receipt that hides it', async () => {
  const s = await setup({ adapter: anthropicAdapter, model: 'claude-fixture-model', script: () => ({ delayMs: 200, answer: { proposals: [], skipped: [] } }), timeoutMs: 40 });
  try {
    await s.ap.start({ by: 'owner' });
    const t = await s.ap.tick();
    assert.equal(t.inference.outcome, 'unknown');
    assert.equal(t.receipt.costs.inference.undecided, s.decider.records[0].quote);
    assert.deepEqual(checkCosts(t.receipt), []);
    const hidden = structuredClone(t.receipt);
    hidden.costs.inference.undecided = '0';
    assert.equal(checkCosts(hidden).length, 1);
    await new Promise(res => setTimeout(res, 220));
  } finally { await s.close(); }
});

test('the owner rotates the capability (as granting ③\'s MCP does): ⑤\'s one paid call ends in BadCapability and the autopilot stops; no more model calls until the owner resumes', async () => {
  const s = await setup({ adapter: openaiAdapter, model: 'gpt-fixture-model', script: body => ({ answer: answerFirst(body) }) });
  try {
    await s.ap.start({ by: 'owner' });
    await s.w.ownerRotate(); // the relay keeps one capability per agent: ⑤'s token is now the old one
    const v = await s.view();
    assert.equal(v.mode, 'auto', 'agent_view is public: it does not show the rotation');
    const t = await s.ap.tick();
    assert.equal(t.inference.status, 'ok');
    assert.equal(t.game[0].code, 'BadCapability');
    assert.equal(s.w.sentCount(), 0);
    assert.equal(s.ap.state, 'stopped-capability');
    const calls = s.srv.requests();
    assert.deepEqual(await s.ap.tick(), { skipped: true, state: 'stopped-capability' });
    assert.equal(s.srv.requests(), calls, 'stopped: no further model call');
    await assert.rejects(s.ap.start({ by: 'owner' }), e => e.code === 'NeedsOwner');
  } finally { await s.close(); }
});

test('④\'s names: cancel phases StoppingNew → AwaitingSigned → Completed{effects}; inference costs in ④\'s four class names (names only, a separate ledger)', async () => {
  const s = await setup({ adapter: anthropicAdapter, model: 'claude-fixture-model', script: body => ({ answer: answerFirst(body) }) });
  try {
    await s.ap.start({ by: 'owner' });
    const t = await s.ap.tick();
    const id = t.receipt.runId;
    assert.equal(s.receipts.cancel(id, 'before-sign').phase, 'StoppingNew');
    // The training was sent and has no fate yet: it may still land.
    assert.equal(s.receipts.cancelPhase(id).phase, 'AwaitingSigned');
    assert.equal(s.receipts.cancelPhase(id).until, null, 'valid_until is ④\'s');
    s.w.settle();
    const r = await s.receipts.refreshFates(id);
    assert.equal(r.cancel.phase, 'Completed');
    assert.deepEqual(s.receipts.cancelPhase(id).effects.map(e => e.action?.name), ['Train'], 'what landed before the stop is an effect, not undone');
    assert.deepEqual(conformance(r), []);
    const four = s.costs.fourClasses();
    assert.deepEqual(Object.keys(four), ['unit', 'reserved', 'charged', 'unconfirmed', 'released']);
    assert.equal(four.charged, s.costs.classes().settled);
    assert.equal(r.costs.inferenceIn4Names.charged, r.costs.inference.settled);
  } finally { await s.close(); }
});

test('the autopilot never proposes SendCaravan, even when the mandate and the relay would allow it (arrival can be unverifiable)', async () => {
  const { NOT_FOR_AUTOPILOT } = await import('../src/api-decider.mjs');
  assert.ok(NOT_FOR_AUTOPILOT.includes('SendCaravan'));
  let seen = null;
  const s = await setup({ adapter: openaiAdapter, model: 'gpt-fixture-model', script: body => { seen = userOf(body); return { answer: answerFirst(body) }; } });
  try {
    s.ap.mandate = { ...s.ap.mandate, allowed: [...s.ap.mandate.allowed, 'SendCaravan'] };
    await s.ap.start({ by: 'owner' });
    await s.ap.tick();
    assert.ok(seen, 'the model was asked');
    assert.equal(Object.keys(seen.commands).includes('SendCaravan'), false);
  } finally { await s.close(); }
});

test('after a BadCapability stop, resume needs the MCP over the owner\'s new token', async () => {
  const s = await setup({ adapter: openaiAdapter, model: 'gpt-fixture-model', script: body => ({ answer: answerFirst(body) }) });
  try {
    await s.ap.start({ by: 'owner' });
    const token = await s.w.ownerRotate();
    await s.ap.tick();
    assert.equal(s.ap.state, 'stopped-capability');
    await assert.rejects(s.ap.resume({ by: 'owner', note: 'new token' }), e => e.code === 'NeedsToken');
    await s.ap.resume({ by: 'owner', note: 'handed the autopilot the rotated token', mcp: () => createAgentMcp({ relay: 'http://relay.test', agentId: s.w.agentId, capability: token, fetch: s.w.fetch, source: 'ai' }) });
    s.w.advance(60);
    const t = await s.ap.tick();
    assert.equal(t.game[0].outcome, 'sent');
  } finally { await s.close(); }
});
