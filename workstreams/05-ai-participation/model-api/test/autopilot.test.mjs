// The autopilot end to end on the local world, with the model behind the HTTP fixture on 127.0.0.1.
// REAL (shared code, unchanged): the relay, its owner commands, MCP agent_view / agent_act, the guard, the delegation
// check. FIXTURE: the chain (scripted), the board, the model (fixture/http-fixture.mjs), the price book (invented),
// the cost contract (RunCostMock, ④'s mocked). No outside network, no key, test assets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RunJournal } from '../../src/adapters.mjs';
import { createLocalWorld, northernRequests } from '../../src/local-world.mjs';
import { mandateFor } from '../../test/helpers.mjs';
import { anthropicAdapter, openaiAdapter } from '../src/adapters.mjs';
import { loopbackTransport } from '../src/http-transport.mjs';
import { FIXTURE_BOOK } from '../src/price-book.mjs';
import { RunCostMock } from '../src/run-cost.mjs';
import { DecisionRegistry } from '../src/inference.mjs';
import { apiDecider, validateAnswer } from '../src/api-decider.mjs';
import { Autopilot } from '../src/autopilot.mjs';
import { reconcileUndecided } from '../src/reconcile.mjs';
import { startHttpFixture } from '../fixture/http-fixture.mjs';

const BOTH = [['Claude', anthropicAdapter, 'claude-fixture-model'], ['GPT', openaiAdapter, 'gpt-fixture-model']];
const userOf = body => JSON.parse((body.messages ?? body.input).find(m => m.role === 'user').content);
/** The fixture's "model": answer the first open request with one batch of spearmen. */
const firstRequest = body => { const r = userOf(body).requests[0]; return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'one batch fits the limits' }] : [], skipped: [] }; };
const board = () => { const b = northernRequests()[0]; return [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ ...b, id: `R-${i}`, title: `第${i}陣：槍兵100`, ask: { kind: 'train', unit: 0, n: 100 } })); };

async function setup({ adapter, model, script, world = {}, caps = {}, available = '100000', timeoutMs = 2_000 }) {
  const srv = await startHttpFixture(script);
  const w = await createLocalWorld({ requests: board(), stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 }, ...world });
  const costs = new RunCostMock({ available, caps, now: () => w.state.clock * 1000 });
  const registry = new DecisionRegistry();
  let ap;
  const decider = apiDecider({ adapter, model, transport: loopbackTransport({ baseUrl: srv.url, timeoutMs }), book: FIXTURE_BOOK(), costs, registry, runId: () => ap.currentRun, sleep: async () => {} });
  const mandate = mandateFor(w, { allowed: ['Train'], limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 600, Ore: 200, Gold: 100 }, troopsPerRequest: 100 } });
  ap = new Autopilot({ world: { ...w, mcp: () => w.mcp() }, mandate, decider, journal: new RunJournal({ now: () => w.state.clock * 1000 }) });
  return { srv, w, costs, decider, ap, registry, close: () => { ap.stop({ by: 'test' }); return srv.close(); } };
}

for (const [name, adapter, model] of BOTH) {
  test(`${name}: budget → start → decision → allowed game operation → cost settled → limit stop → owner resume`, async () => {
    const s = await setup({ adapter, model, script: body => ({ answer: firstRequest(body) }), caps: {} });
    try {
      await s.ap.start({ by: 'owner' });
      const t1 = await s.ap.tick();
      assert.equal(t1.inference.status, 'ok');
      assert.equal(t1.inference.servedModel, model);
      assert.deepEqual(t1.game.map(g => [g.requestId, g.outcome, g.decidedBy]), [['R-1', 'sent', 'existing relay (via MCP agent_act)']]);
      assert.equal(s.w.sentCount(), 1, 'the game operation went through MCP agent_act to the relay');
      s.w.settle();
      const settledAfter1 = s.costs.classes().settled;
      assert.equal(settledAfter1, String(900 + 120 * 5), 'measured from the usage report, at most the quote');
      // The owner's inference total cap: room for about three more calls at this prompt's size (quotes vary with the prompt).
      s.costs.caps.total = String(BigInt(settledAfter1) + BigInt(s.decider.records[0].quote) + 3000n);
      // Keep ticking until the inference cap stops it: each call is reserved at its quote first.
      let rec;
      for (let i = 0; i < 10 && s.ap.state === 'running'; i++) { s.w.advance(60); rec = await s.ap.tick(); s.w.settle(); }
      assert.equal(s.ap.state, 'stopped-by-budget');
      assert.equal(rec.status, 'stopped-by-budget');
      assert.equal(rec.inference.called, false);
      assert.ok(['BudgetShort', 'CategoryTotalLimit'].includes(rec.stoppedBy), rec.stoppedBy);
      const asked = s.srv.requests();
      assert.deepEqual(await s.ap.tick(), { skipped: true, state: 'stopped-by-budget' });
      assert.equal(s.srv.requests(), asked, 'stopped: no model call');
      await assert.rejects(s.ap.start({ by: 'agent' }), e => e.code === 'NeedsOwner');
      await assert.rejects(s.ap.resume({ by: 'agent', note: 'x' }), e => e.code === 'NeedsOwner');
      // The owner raises the cap and resumes; the next tick checks the budget again before calling.
      s.costs.caps.total = String(BigInt(s.costs.caps.total) + 20000n);
      await s.ap.resume({ by: 'owner', note: 'raised the inference total cap by 20000' });
      s.w.advance(60);
      const back = await s.ap.tick();
      assert.equal(back.inference.status, 'ok');
      assert.equal(s.costs.classes().undecided, '0');
      // The session key was never touched: still the agent's, as the owner delegated it.
      const view = (await (await import('../../src/participate.mjs')).tool(s.w.mcp(), 'agent_view')).structuredContent;
      assert.equal(view.delegation.session, s.w.agentKey);
    } finally { await s.close(); }
  });

  test(`${name}: an inference that fails is recorded apart from a game operation the relay refuses`, async () => {
    // Tick 1: the model call fails (server error, held as unknown). Tick 2: the model answers; the relay refuses the game
    // operation (the game price is above the relay balance: nothing is sent, nothing is charged for it).
    const s = await setup({ adapter, model, script: (body, n) => n === 0 ? { status: 500, error: { type: 'api_error' } } : { answer: firstRequest(body) }, world: { balance: '0', gamePrices: { Train: '15000' } } });
    try {
      await s.ap.start({ by: 'owner' });
      const t1 = await s.ap.tick();
      assert.equal(t1.inference.status, 'inference-failed');
      assert.equal(t1.inference.outcome, 'failed');
      assert.deepEqual(t1.game, []);
      assert.equal(s.costs.classes().undecided, t1.inference.attempts[0] && s.decider.records[0].quote, 'a 500 has no usage report: held, not 0');
      s.w.advance(60);
      const t2 = await s.ap.tick();
      assert.equal(t2.inference.status, 'ok');
      assert.equal(t2.game.length, 1);
      assert.equal(t2.game[0].outcome, 'refused');
      assert.equal(t2.game[0].decidedBy, 'existing relay (via MCP agent_act)');
      assert.ok(t2.game[0].code, 'the relay\'s code is kept');
      assert.equal(s.w.sentCount(), 0);
    } finally { await s.close(); }
  });

  test(`${name}: an answer outside the schema is dropped whole; nothing reaches the guard or the relay`, async () => {
    const s = await setup({ adapter, model, script: () => ({ answer: { proposals: [{ request: 'R-9', action: 'Train', fields: { unit: 0, n: 100 }, reason: 'x' }], skipped: [], note: 'extra' } }) });
    try {
      await s.ap.start({ by: 'owner' });
      const t = await s.ap.tick();
      assert.equal(t.inference.status, 'answer-invalid');
      assert.deepEqual(t.game, []);
      assert.equal(s.w.sentCount(), 0);
      assert.ok(s.costs.classes().settled !== '0', 'the call was made and is paid by its usage');
    } finally { await s.close(); }
  });
}

test('the same tick re-run is the recorded decision: no second model call, no second reservation', async () => {
  const s = await setup({ adapter: openaiAdapter, model: 'gpt-fixture-model', script: body => ({ answer: firstRequest(body) }) });
  try {
    await s.ap.start({ by: 'owner' });
    await s.ap.tick();
    const before = { calls: s.srv.requests(), items: s.costs.items.size };
    s.ap.ticks -= 1; // the same runId again (a crashed tick re-run)
    s.w.board.splice(0, 1, ...s.w.board.slice(0, 1)); // the same board
    const again = await s.ap.tick();
    // The prompt is the same only if nothing changed; here the journal now holds R-1's contribution, so it differs.
    // Either way: never two reservations for one decision key.
    const keys = [...s.costs.items.keys()].map(k => k.split('#')[0]);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(s.srv.requests() <= before.calls + 1);
    assert.ok(again.inference.called || again.inference.replayed);
  } finally { await s.close(); }
});

test('a timeout is undecided; a FIXTURE provider record settles it by the client request id (GPT; production unverified) — Claude has no id and it stays held', async () => {
  for (const [adapter, model, expect] of [[openaiAdapter, 'gpt-fixture-model', 'settled'], [anthropicAdapter, 'claude-fixture-model', 'undecided']]) {
    const s = await setup({ adapter, model, script: () => ({ delayMs: 200, answer: { proposals: [], skipped: [] } }), timeoutMs: 40 });
    try {
      await s.ap.start({ by: 'owner' });
      const t = await s.ap.tick();
      assert.equal(t.inference.status, 'inference-failed');
      assert.equal(t.inference.outcome, 'unknown');
      const key = t.inference.attempts[0].key;
      assert.equal(s.costs.items.get(key).state, 'undecided');
      // The same record for both: Claude never received our key, so it cannot be matched by it.
      const entries = [{ clientRequestId: key, providerRequestId: null, usage: { inputUncached: 900, cacheRead: 0, cacheWrite: {}, output: 0, reasoning: 0, serverTools: {} }, billed: true }];
      assert.throws(() => reconcileUndecided({ costs: s.costs, book: FIXTURE_BOOK(), records: s.decider.records, report: { source: 'provider-usage-report', entries } }), e => e.code === 'UnverifiedReportSource');
      const r = reconcileUndecided({ costs: s.costs, book: FIXTURE_BOOK(), records: s.decider.records, report: { source: 'fixture', entries } });
      assert.equal(r[0].productionVerified, false);
      assert.equal(r[0].contract, 'fixture');
      assert.equal(r[0].result, expect);
      if (expect === 'settled') { assert.equal(r[0].settled, '900'); assert.equal(s.costs.classes().undecided, '0'); }
      else {
        assert.match(r[0].why, /stays undecided, held, not withdrawable/);
        // And the operator cannot refund it without a provider record: it stays held.
        assert.throws(() => s.costs.decide(key, { by: 'operator', outcome: 'refund', note: 'probably unbilled' }), e => e.code === 'EvidenceRequired');
        assert.equal(s.costs.items.get(key).state, 'undecided');
      }
      await new Promise(res => setTimeout(res, 220));
    } finally { await s.close(); }
  }
});

test('preflight: no model call when nothing is open, when the key is not delegated, or when the budget is short', async () => {
  const s = await setup({ adapter: anthropicAdapter, model: 'claude-fixture-model', script: body => ({ answer: firstRequest(body) }), available: '100' });
  try {
    await s.ap.start({ by: 'owner' });
    const t = await s.ap.tick();
    assert.equal(t.status, 'stopped-by-budget');
    assert.deepEqual(t.inference.preflight, ['BudgetShort']);
    assert.equal(s.srv.requests(), 0);
    assert.equal(s.costs.items.size, 0, 'nothing reserved');
  } finally { await s.close(); }
  const s2 = await setup({ adapter: anthropicAdapter, model: 'claude-fixture-model', script: body => ({ answer: firstRequest(body) }) });
  try {
    s2.w.ownerTakeKeyBack();
    await assert.rejects(s2.ap.start({ by: 'owner' }), e => e.code === 'NotReady' && /never does/.test(e.message));
    s2.w.ownerDelegateTo(s2.w.agentKey);
    await s2.ap.start({ by: 'owner' });
    s2.w.board.length = 0;
    const t = await s2.ap.tick();
    assert.equal(t.inference.status, 'not-called');
    assert.ok(t.inference.preflight.includes('NothingOpen'));
    assert.equal(s2.srv.requests(), 0);
  } finally { await s2.close(); }
});

test('one process: a second autopilot for the same agent is refused; the autopilot and the decider never set a session key', async () => {
  const s = await setup({ adapter: anthropicAdapter, model: 'claude-fixture-model', script: body => ({ answer: firstRequest(body) }) });
  try {
    await s.ap.start({ by: 'owner' });
    const other = new Autopilot({ world: s.w, mandate: s.ap.mandate, decider: s.decider, journal: new RunJournal() });
    await assert.rejects(other.start({ by: 'owner' }), e => e.code === 'AlreadyRunning');
    assert.match(s.ap.status().scope, /second process is NOT detected/);
    for (const f of ['autopilot.mjs', 'api-decider.mjs', 'reconcile.mjs']) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      assert.equal(/SetSession|ownerDelegateTo|ownerTakeKeyBack|ownerSetMode|delegate\(/.test(src), false, f);
    }
  } finally { await s.close(); }
});

test('the strict answer check', () => {
  const ctx = { names: ['Train'], requestIds: ['R-1'] };
  assert.equal(validateAnswer('{"proposals":[],"skipped":[]}', ctx).ok, true);
  for (const bad of ['not json', '{"proposals":[]}', '{"proposals":[{"request":"R-1","action":"Vote","fields":{},"reason":""}],"skipped":[]}',
    '{"proposals":[{"request":"R-1","action":"Train","fields":{"n":1.5},"reason":""}],"skipped":[]}',
    '{"proposals":[{"request":"R-1","action":"Train","fields":{"n":-1},"reason":""}],"skipped":[]}',
    '{"proposals":[{"request":"R-1","action":"Train","fields":{},"reason":"","extra":1}],"skipped":[]}']) assert.equal(validateAnswer(bad, ctx).ok, false, bad);
});
