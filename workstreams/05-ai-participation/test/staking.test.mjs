// AI staking on the local world: the owner's one budget for model calls and game spending, the agent's
// scope, the stop and the way back to manual play. The money, the stop, the versions and the delegation are
// the real agent wallet's (relay routes, AgentGateway, AgentLedger, Custody over the gateway tests' scripted
// chain); the program's effects are emulated; every model is a scripted stand-in or a fake loopback server.
// Game prices here are TEST VALUES (the shipped price table is empty).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunJournal } from '../src/adapters.mjs';
import { modelDecider } from '../src/deciders.mjs';
import { NATION, createLocalWorld, northernRequests, scriptedLlm } from '../src/local-world.mjs';
import { participate, tool, verifyPending } from '../src/participate.mjs';
import { BudgetGuard, statement, trace } from '../src/staking/budget.mjs';
import { startFakeModelServer } from '../src/staking/fake-model-server.mjs';
import { caravanOutcome } from '../src/staking/outcomes.mjs';
import { PriceBook, TEST_BOOK } from '../src/staking/pricing.mjs';
import { createProvider, parseModelConfig } from '../src/staking/providers.mjs';
import { StakingSession } from '../src/staking/session.mjs';
import { llmDecider } from '../../../permutation-gateway/src/frontier/agent/runner.mjs';

const BASE = northernRequests()[0];
/** n requests for 100 spearmen each, from the officer the owner follows. */
const board = n => Array.from({ length: n }, (_, i) => ({ ...BASE, id: `R-${i + 1}`, title: `守り 第${i + 1}陣`, ask: { kind: 'train', unit: 0, n: 100 } }));
/** A scripted model that answers the first open request with what it asks. */
const answerFirst = body => { const u = JSON.parse(body.messages[1].content); const r = u.requests[0]; return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: r.ask.n }, reason: 'defend the north' }] : [], skipped: [] }; };
const scope = (w, over = {}) => ({ mandateId: 'stake', purpose: '北方拠点の守り', nation: NATION, from: ['Aster-officer'], allowed: ['Train'], partial: true,
  limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 6000, Ore: 2000, Gold: 1000 }, troopsPerRequest: 100 }, expiresAt: w.state.clock + 86_400, ...over });
const STORES = { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 };

async function session({ requests = board(4), gamePrices = { Train: '15000' }, budget = { deposit: '100000', total: '60000', perDay: '60000', callsPerDay: 20 }, mandate = {}, answer = answerFirst, model = 'scripted', providerDeps = null, priceBook = TEST_BOOK() } = {}) {
  const w = await createLocalWorld({ balance: '0', requests, gamePrices, stores: { ...STORES } });
  const s = new StakingSession({ world: w, model, priceBook, providerDeps: providerDeps ?? { answer } });
  await s.setBudget(budget);
  await s.setScope({ allowed: ['economy'], mandate: scope(w, mandate) });
  await s.start();
  return { w, s };
}

// ------------------------------------------------------------------ the owner's flow

test('the flow: budget → scope → auto → actions and costs → the budget limit stops it → back to manual; the books balance', async () => {
  const { w, s } = await session();
  const t1 = await s.tick();
  assert.equal(t1.report.items[0].outcome, 'sent');
  assert.deepEqual(t1.verified.map(v => v.outcome), ['contributed']);
  let st = s.statement();
  assert.deepEqual(st.balance.settled, { inference: '10000', game: '15000', network: '0' });
  assert.equal(st.balance.available, '75000');
  await s.tick();
  // Third turn: the model call fits (50,000 + 10,000), the training's 15,000 does not: the relay refuses it, nothing is sent.
  const t3 = await s.tick();
  assert.equal(t3.report.status, 'stopped-by-budget');
  assert.deepEqual([t3.report.items[0].outcome, t3.report.items[0].code], ['refused', 'BudgetExceeded']);
  // Fourth: the model call itself no longer fits: no call is made, nothing is charged.
  const calls = s.provider.calls.length;
  const t4 = await s.tick();
  assert.deepEqual([t4.report.status, t4.report.stoppedBy, t4.report.charged], ['stopped-by-budget', 'BudgetExceeded', '0']);
  assert.equal(s.provider.calls.length, calls);
  st = s.statement();
  assert.deepEqual(st.balance.settled, { inference: '30000', game: '30000', network: '0' });
  assert.equal(st.sound, true);
  assert.equal(w.state.reserve.Spearman, 200);
  const stop = await s.stop();
  assert.equal(stop.mode, 'manual');
  const back = await s.backToManual();
  assert.deepEqual([back.mode, back.delegated], ['manual', false]);
  // The agent's requests are refused now, also with its token: nothing is sent.
  const before = w.sentCount();
  const v = (await tool(w.mcp(), 'agent_view')).structuredContent;
  const act = await tool(w.mcp(), 'agent_act', { requestId: 'after-manual-1', policyVersion: v.policy.version, modeEpoch: v.modeEpoch, action: { name: 'Train', fields: { unit: 0, n: 100 } } });
  assert.equal(act.structuredContent.error.code, 'AgentStopped');
  assert.equal(w.sentCount(), before);
  const out = await s.withdraw({ all: true });
  assert.deepEqual([out.final.state, out.final.amount, out.balance.withdrawn, out.balance.available], ['done', '40000', '40000', '0']);
  assert.deepEqual(w.books(), [], 'deposited = spent + withdrawn');
});

// ------------------------------------------------------------------ concurrency, retries, restarts

test('concurrent runs: the relay\'s budget and the executor\'s caps are each used once, never twice', async () => {
  // Relay: a budget for two trainings (25,000 each: one call 10,000 + one training 15,000), five runs at once.
  const { w, s } = await session({ requests: board(5), budget: { deposit: '100000', total: '50000', perDay: '50000', callsPerDay: 20 } });
  // Each run answers a different request (different agent_act requestIds), but the transactions themselves are the same
  // Train: only distinct fee payers keep them from being byte-identical (diag/staking-race.mjs), so each send gets its own.
  const distinctPayers = world => { let d = 0; world.relay.pool.randomIndex = n => (d++) % n; };
  distinctPayers(w);
  const pick = i => body => { const u = JSON.parse(body.messages[1].content); const r = u.requests.find(q => q.id === `R-${i}`); return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'mine' }] : [], skipped: [] }; };
  const runs = await Promise.all([1, 2, 3, 4, 5].map(i => participate({
    mcp: w.mcp(), world: w.publicWorld, txState: w.txState, meter: w.meter, mandate: s.mandate, decider: modelDecider({ llm: scriptedLlm(pick(i)) }), journal: new RunJournal(), runId: `c${i}`,
    staking: { guard: new BudgetGuard(), priceBook: s.priceBook, modelCfg: s.modelCfg, gamePrices: s.terms.prices.game, onBudgetLimit: 'stop' },
  })));
  const v = w.view();
  const spentAndHeld = BigInt(v.balance.reserved) + BigInt(v.balance.spent.inference) + BigInt(v.balance.spent.game);
  assert.ok(spentAndHeld <= 50_000n, `never past the budget: ${spentAndHeld}`);
  assert.deepEqual(w.books(), []);
  const sent = runs.flatMap(r => r.items).filter(i => i.outcome === 'sent').length;
  const calls = runs.filter(r => r.charged === '10000').length;
  assert.equal(BigInt(calls) * 10_000n + BigInt(sent) * 15_000n, spentAndHeld, 'every charge and hold is one call or one sent training');
  // Each run either paid one call, or was stopped by the budget before calling (nothing paid).
  for (const r of runs) assert.ok(r.charged === '10000' || (r.charged === '0' && r.stoppedBy === 'BudgetExceeded'), JSON.stringify([r.charged, r.stoppedBy]));
  assert.ok(calls >= 2 && calls <= 5, `calls: ${calls}`);
  assert.equal(w.sentCount(), sent, 'what was sent is what was held');
  // Executor: one guard shared by five concurrent runs, a game cap of 30,000 a day (two trainings), the relay's budget large.
  const x = await session({ requests: board(5), budget: { deposit: '1000000', total: '1000000', perDay: '1000000', callsPerDay: 50 }, mandate: { budget: { perDay: { game: '30000' } } } });
  distinctPayers(x.w);
  const guard = new BudgetGuard({ caps: x.s.mandate.budget, now: () => x.w.state.clock * 1000 });
  // Five different requests, each run answering a different one.
  const reps = await Promise.all([1, 2, 3, 4, 5].map(i => participate({
    mcp: x.w.mcp(), world: x.w.publicWorld, txState: x.w.txState, meter: x.w.meter, mandate: x.s.mandate, decider: modelDecider({ llm: scriptedLlm(pick(i)) }), journal: new RunJournal(), runId: `g${i}`,
    staking: { guard, priceBook: TEST_BOOK(), modelCfg: parseModelConfig({ provider: 'scripted', model: 'scripted-stand-in' }), gamePrices: x.s.terms.prices.game, onBudgetLimit: 'stop' },
  })));
  const sentG = reps.flatMap(r => r.items).filter(i => i.outcome === 'sent').length;
  assert.equal(sentG, 2, 'exactly the cap');
  assert.equal(reps.flatMap(r => r.items).filter(i => i.code === 'CategoryDayLimit').length, 3);
  assert.equal(x.w.sentCount(), 2);
});

test('a lost answer after the send, a model timeout and a relay restart during a call: nothing is charged or sent twice', async () => {
  // The relay sent the training but its answer is lost on the way back: the retry (same requestId) is the recorded result.
  const { w, s } = await session();
  const real = w.fetch;
  let lost = 0;
  w.fetch = async (url, init) => { const res = await real(url, init); if (init?.method === 'POST' && url.endsWith('/f/agent/action') && lost++ === 0) throw new Error('socket hang up'); return res; };
  const t = await s.tick();
  assert.equal(t.report.items[0].outcome, 'sent');
  assert.equal(t.report.items[0].attempts, 2);
  assert.equal(w.sentCount(), 1, 'one transaction on the chain');
  const st = s.statement();
  assert.deepEqual(st.balance.settled, { inference: '10000', game: '15000', network: '0' }, 'one call, one training: charged once each');
  // A model call that times out is a call (charged once, as the owner decided); a retry is a second call, held and capped like the first.
  const m = await session({ budget: { deposit: '100000', total: '100000', perDay: '100000', callsPerDay: 2 }, answer: () => { throw new Error('timeout'); } });
  m.s.modelRetries = 5;
  const r = await m.s.tick();
  assert.equal(m.s.provider.calls.length, 2, 'the owner\'s two calls a day, not six');
  assert.deepEqual([r.report.status, r.report.stoppedBy, r.report.charged], ['stopped-by-budget', 'CallLimitReached', '20000']);
  assert.equal(m.w.sentCount(), 0);
  // The relay restarts while a call is running: the hold becomes unresolved (reserved, not charged); the late answer is charged once.
  const x = await session();
  let release;
  const gate = new Promise(res => { release = res; });
  const pending = x.w.meter(() => gate.then(() => ({ proposals: [], notes: [] })), { key: 'restart-call', free: false, model: 'scripted-stand-in' });
  await new Promise(res => setImmediate(res));
  x.w.relay.gateway.recover(); // what a restart does to a running call
  assert.equal(x.w.view().holds.find(h => h.key === 'restart-call').state, 'unresolved');
  assert.equal(x.w.view().balance.spent.inference, '0');
  x.w.relay.gateway.recover(); // a second restart changes nothing
  release();
  await pending;
  assert.equal(x.w.view().balance.spent.inference, '10000', 'charged once');
  assert.deepEqual(x.w.books(), []);
});

test('the executor restarts: its caps are rebuilt from its journal, so a restart does not reopen a spent cap', async () => {
  const { w, s } = await session({ mandate: { budget: { total: { game: '15000' } } }, budget: { deposit: '1000000', total: '1000000', perDay: '1000000', callsPerDay: 20 } });
  await s.tick();
  assert.equal(s.statement().balance.settled.game, '15000');
  // A new executor process: a new guard, seeded from the same journal.
  const s2 = new StakingSession({ world: w, model: 'scripted', priceBook: TEST_BOOK(), providerDeps: { answer: answerFirst }, journal: s.journal });
  s2.mandate = s.mandate;
  s2.policy = s.policy;
  await s2.start();
  const t = await s2.tick();
  assert.deepEqual([t.report.status, t.report.items[0]?.code], ['stopped-by-budget', 'CategoryTotalLimit']);
  assert.equal(s2.statement().balance.settled.game, '15000');
});

test('the model call is paid and the game action then fails on chain: the call stays charged, the game hold is given back, the trace says so', async () => {
  const { w, s } = await session();
  w.faults.txFail = 6017;
  const t = await s.tick();
  assert.equal(t.report.items[0].outcome, 'sent');
  assert.deepEqual(t.verified.map(v => v.outcome), ['failed']);
  const st = s.statement();
  assert.deepEqual(st.balance.settled, { inference: '10000', game: '0', network: '0' });
  assert.equal(st.balance.available, '90000');
  assert.ok(st.lines.some(l => l.type === 'release' && l.category === 'game' && l.reason === 'failed'));
  const tr = s.trace()[0];
  assert.equal(tr.inference[0].charged, '10000');
  assert.deepEqual([tr.items[0].accepted.outcome, tr.items[0].gameCost.state, tr.items[0].final.outcome], ['sent', 'released', 'failed']);
  assert.deepEqual(s.journal.memory().map(m => m.outcome), ['failed'], 'remembered as a failure');
  assert.deepEqual(w.books(), []);
});

// ------------------------------------------------------------------ limits and permissions

test('over the limits, outside the scope, an expired or revoked permission: refused, with nothing sent or charged for the action', async () => {
  // Per call: a training priced above the owner's per-call cap for game spending.
  const a = await session({ gamePrices: { Train: '25000' }, mandate: { budget: { perCall: { game: '20000' } } } });
  const ta = await a.s.tick();
  assert.deepEqual([ta.report.items[0].outcome, ta.report.items[0].code], ['refused', 'PerCallLimit']);
  assert.equal(a.w.sentCount(), 0);
  assert.equal(a.s.statement().balance.settled.game, '0');
  // Per call for the model: a price book whose quote is over the owner's per-call cap for inference: no call at all.
  const b = await session({ mandate: { budget: { perCall: { inference: '5000' } } } });
  const tb = await b.s.tick();
  assert.deepEqual([tb.report.status, tb.report.stoppedBy, tb.report.charged], ['stopped-by-budget', 'PerCallLimit', '0']);
  assert.equal(b.s.provider.calls.length, 0);
  // An action outside the scope (the model proposes Build; only Train is delegated).
  const c = await session({ answer: body => { const r = JSON.parse(body.messages[1].content).requests[0]; return { proposals: [{ request: r.id, action: 'Build', fields: { item: 0 }, reason: 'farm' }], skipped: [] }; } });
  const tc = await c.s.tick();
  assert.equal(tc.report.items[0].code, 'NotWhatWasAsked');
  assert.equal(c.w.sentCount(), 0);
  // A village not in the mandate's targets.
  const d = await session({ mandate: { targets: { villages: [[9, 9, 1]] } } });
  const td = await d.s.tick();
  assert.deepEqual(td.report.blocked.map(x => x.code), ['VillageNotInMandate']);
  // The mandate's permission expired: no call, no action.
  const e = await session({ mandate: { expiresAt: 1 } });
  const te = await e.s.tick();
  assert.deepEqual([te.report.status, te.report.blocked.map(x => x.code), e.s.provider.calls.length], ['blocked', ['MandateExpired'], 0]);
  // The on-chain delegation expired.
  const f = await session();
  f.w.sessionExpiresAt(f.w.state.clock - 1);
  const tf = await f.s.tick();
  assert.deepEqual(tf.report.blocked.map(x => x.code), ['SessionNotDelegated']);
  // An insufficient balance: the relay refuses the model call's hold; nothing runs.
  const g = await session({ budget: { deposit: '5000', total: '100000', perDay: '100000', callsPerDay: 20 } });
  const tg = await g.s.tick();
  assert.deepEqual([tg.report.status, tg.report.stoppedBy, g.s.provider.calls.length], ['stopped-by-budget', 'InsufficientBalance', 0]);
});

test('stopping the agent right after it started: a decision made during the stop is not sent; the running call is paid and shown as not cancellable', async () => {
  let w;
  const { w: world, s } = await session({ answer: async body => {
    // The owner stops while the model is thinking.
    const st = statement(w.view());
    s_running.push(st.inFlight.map(h => [h.category, h.state, h.cancellable]));
    await w.ownerSetMode('manual');
    return answerFirst(body);
  } });
  w = world;
  const s_running = [];
  const t = await s.tick();
  assert.deepEqual(s_running, [[['inference', 'running', false]]]);
  assert.equal(t.report.items[0].outcome, 'skipped');
  assert.equal(t.report.items[0].code, 'StaleObservation');
  assert.equal(w.sentCount(), 0, 'nothing slipped through');
  assert.deepEqual(s.statement().balance.settled, { inference: '10000', game: '0', network: '0' });
  // In-flight display at a stop: a game hold already sending is not cancellable.
  const x = await session();
  x.w.faults.txUnknown = true;
  await x.s.tick();
  const stop = await x.s.stop();
  assert.deepEqual(stop.inFlightAtStop.map(h => [h.category, h.state, h.cancellable]), [['game', 'sending', false]]);
  assert.deepEqual(stop.inFlightAfter.map(h => [h.category, h.state]), [['game', 'sending']], 'the stop does not undo a send');
});

test('accepted is not landed, landed is not the effect, a caravan off the road is not arrived', async () => {
  const { w, s } = await session();
  w.faults.txUnknown = true;
  const t = await s.tick();
  assert.equal(t.report.items[0].outcome, 'sent');
  assert.deepEqual(t.verified.map(v => v.outcome), ['unknown']);
  assert.deepEqual(s.journal.memory(), []);
  assert.equal(s.trace()[0].items[0].gameCost.state, 'reserved', 'the game price is reserved until the chain answers');
  // Caravans (the herald's h/caravans.json shape; the agent cannot send one today).
  const car = { ownerTag: '42', seq: 3, src: { kind: 1 }, cargo: [0, 900, 0, 0, 0, 0, 0, 0], raided: false };
  assert.equal(caravanOutcome({ before: { moving: [] }, now: { moving: [car] }, ownerTag: '42', seq: 3 }).state, 'departed');
  assert.equal(caravanOutcome({ before: { moving: [car] }, now: { moving: [{ ...car, raided: true, cargo: [0, 0, 0, 0, 0, 0, 0, 0] }] }, ownerTag: '42', seq: 3 }).state, 'raided');
  assert.equal(caravanOutcome({ before: { moving: [car] }, now: { moving: [] }, ownerTag: '42', seq: 3 }).state, 'settled-unconfirmed');
  assert.equal(caravanOutcome({ before: { moving: [car] }, now: { moving: [{ ownerTag: '77', seq: 0, src: { kind: 3 }, cargo: [0, 400, 0, 0, 0, 0, 0, 0] }] }, ownerTag: '42', seq: 3, cargo: car.cargo }).state, 'possibly-taken');
  const arrived = caravanOutcome({ before: { moving: [car] }, now: { moving: [] }, ownerTag: '42', seq: 3, cargo: car.cargo, destBefore: [0, 100, 0, 0, 0, 0, 0, 0], destNow: [0, 1000, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual([arrived.state, arrived.final], ['arrived', true]);
});

// ------------------------------------------------------------------ the model, its provider and its price

test('the model is configuration: presets, loopback only, an external provider never sends; configured name, self-reported alias and self-reported file are recorded apart, none as verified', async () => {
  assert.equal(parseModelConfig('gemma-4-26b-local').model, 'gemma-4-26b-a4b-it');
  assert.equal(parseModelConfig({ provider: 'local-openai', url: 'http://127.0.0.1:9', model: 'qwen-local' }).model, 'qwen-local');
  assert.throws(() => parseModelConfig({ provider: 'local-openai', url: 'https://api.example.com', model: 'x' }), /loopback only/);
  let fetched = 0;
  const ext = parseModelConfig({ provider: 'external', vendor: 'some-api', model: 'big', credentialEnv: 'SOME_API_KEY' });
  assert.throws(() => createProvider(ext, { fetch: () => { fetched++; } }), e => e.code === 'ProviderNotEnabled');
  assert.equal(fetched, 0, 'no request to an outside host');
  // A fake loopback server that calls itself gemma-4-26b-a4b-it (as the pinned script names every GGUF) but loaded a Gemma 3 file.
  const srv = await startFakeModelServer({ alias: 'gemma-4-26b-a4b-it', modelPath: '/models/private/gemma-3-4b-it-Q4_K_M.gguf', answer: answerFirst });
  try {
    const { w, s } = await session({ model: { provider: 'local-openai', url: srv.url, model: 'gemma-4-26b-a4b-it' }, providerDeps: {} });
    // The server's own words: a file NAME is not the weights. No hash is taken, so nothing is marked verified.
    assert.deepEqual(s.identity, { reportedAlias: 'gemma-4-26b-a4b-it', modelFile: 'gemma-3-4b-it-Q4_K_M.gguf', source: 'server report', assurance: 'self-reported by the server (alias / file name; not verified)', verified: false });
    const t = await s.tick();
    assert.equal(t.report.items[0].outcome, 'sent');
    const plan = s.journal.entries.find(e => e.step === 'plan');
    assert.deepEqual([plan.configuredModel, plan.servedModel, plan.reportedAlias, plan.modelFile], ['gemma-4-26b-a4b-it', 'gemma-4-26b-a4b-it', 'gemma-4-26b-a4b-it', 'gemma-3-4b-it-Q4_K_M.gguf']);
    assert.equal(JSON.stringify(s.journal.entries).includes('/models/private'), false, 'only the file\'s base name is kept');
    // What the model server received: no capability token, no owner address, no agent key.
    const sent = JSON.stringify(srv.seen);
    for (const secret of [w.capability, w.owner, w.agentKey]) assert.equal(sent.includes(secret), false);
  } finally { await srv.close(); }
});

test('the shared runner records the configured alias as "the model": what the relay\'s ledger calls Gemma is the alias, not a check of the weights', async () => {
  // Pinning current behaviour of permutation-gateway/src/frontier/agent/runner.mjs (unchanged here): the decider's name comes from the alias.
  const llm = { alias: 'gemma-4-26b-a4b-it', async complete() { return { ok: true, content: JSON.stringify({ action: 'rest', fields: {}, reason: 'nothing' }), usage: null, model: 'something-else' }; } };
  const d = llmDecider({ llm });
  assert.equal(d.name, 'model:gemma-4-26b-a4b-it');
  const w = await createLocalWorld();
  const m = await w.meter(() => d.decide(w.view()), { key: 'alias-check', free: false, model: d.name });
  assert.equal(m.ok, true);
  const line = w.view().history.find(h => h.type === 'spend' && h.key === 'alias-check');
  assert.equal(line.model, 'model:gemma-4-26b-a4b-it', 'the ledger line names the configured alias; the served model is not read');
});

test('prices are TEST or PROPOSED, a cost is rounded up and never above its quote, a conversion needs a stated rate; the session refuses a book that disagrees with the relay', async () => {
  assert.throws(() => new PriceBook({ version: 'x', entries: [], status: 'PRODUCTION' }), /never a production one/);
  const book = new PriceBook({ version: 'p1', status: 'PROPOSED', settlement: 'ledger-metered',
    entries: [{ match: { provider: 'local-openai' }, unit: 'tokens', currency: 'USD', promptPerMillion: '150000', completionPerMillion: '600000' }],
    rates: { USD: { baseUnitsPerUnit: '1000000', source: 'TEST 1 USD = 1 test USDC', status: 'TEST' } } });
  const cfg = parseModelConfig({ provider: 'local-openai', url: 'http://127.0.0.1:9', model: 'm', maxTokens: 400 });
  const q = book.quote(cfg, { maxPromptTokens: 4000 });
  assert.equal(q.amount, '840'); // 4000 × 0.15 + 400 × 0.60 micro-USD, rounded up
  assert.equal(book.cost(cfg, { prompt_tokens: 1001, completion_tokens: 1 }, q).amount, '151');
  assert.equal(book.cost(cfg, { prompt_tokens: 999_999, completion_tokens: 999_999 }, q).amount, '840', 'never above the quote');
  assert.equal(book.cost(cfg, null, q).amount, '840', 'no usage report: the quote');
  const noRate = new PriceBook({ version: 'p2', status: 'PROPOSED', entries: [{ match: { provider: 'local-openai' }, unit: 'tokens', currency: 'EUR', promptPerMillion: '1', completionPerMillion: '1' }] });
  assert.throws(() => noRate.quote(cfg), e => e.code === 'NoRate');
  // A book quoting another fixed price than the relay charges is refused at start.
  const w = await createLocalWorld({ balance: '0' });
  const s = new StakingSession({ world: w, model: 'scripted', providerDeps: { answer: answerFirst }, priceBook: new PriceBook({ version: 'bad', entries: [{ match: { provider: 'scripted' }, unit: 'call', amount: '1' }] }) });
  await s.setScope({ allowed: ['economy'], mandate: scope(w) });
  await assert.rejects(s.start(), e => e.code === 'PriceBookMismatch');
});

test('money in and out on the local mock balance: a deposit credits once, a withdrawal takes only what is available and waits for the chain', async () => {
  const { w, s } = await session({ budget: { deposit: '100000', total: '100000', perDay: '100000', callsPerDay: 20 } });
  // The same deposit signature again is not credited twice (the real Custody's rule).
  const sig = w.view().history.find(h => h.type === 'deposit').signature;
  const again = await w.relay.gateway.deposit(w.agentId, sig);
  assert.deepEqual([again.credited, again.already], [false, true]);
  assert.equal(w.view().balance.deposited, '100000');
  // A training sent and not yet answered: its 15,000 stays reserved through a withdrawal of everything.
  w.faults.txUnknown = true;
  await s.tick();
  const out = await s.withdraw({ all: true });
  assert.equal(out.final.state, 'done');
  assert.deepEqual([out.balance.reserved, out.balance.withdrawn, out.mode], ['15000', '75000', 'manual'], 'everything else left; a full withdrawal stops the agent');
  assert.deepEqual(w.books(), []);
});

test('a trace joins what the agent thought, asked, what was accepted, what finally happened and what it cost', async () => {
  const { s } = await session();
  await s.tick();
  const [t] = s.trace();
  assert.equal(t.thought.by, 'model:scripted-stand-in');
  assert.equal(t.thought.proposals[0].reason, 'defend the north');
  assert.deepEqual(t.inference.map(i => [i.charged, i.relayLine]), [['10000', 'settled']]);
  const it = t.items[0];
  assert.equal(it.request.action.name, 'Train');
  assert.equal(it.accepted.outcome, 'sent');
  assert.deepEqual(it.gameCost, { state: 'settled', amount: '15000' });
  assert.equal(it.final.outcome, 'contributed');
});

// ------------------------------------------------------------------ guarantees (2026-10-30 corrections): what holds, and what does not

test('a stop in three stages: new work stops; what was signed, sent or running waits for its answer; only unused reservations come back', async () => {
  const { w, s } = await session();
  // One training sent with no chain answer yet, and a model call running when the owner stops.
  w.faults.txUnknown = true;
  await s.tick();
  let release;
  const gate = new Promise(r => { release = r; });
  const running = w.meter(() => gate.then(() => ({ proposals: [], notes: [] })), { key: 'running-at-stop', free: false, model: 'scripted-stand-in' });
  await new Promise(r => setImmediate(r));
  const stop = await s.stop();
  const rep = stop.report;
  assert.equal(rep.stage1_stop.mode, 'manual');
  assert.ok(rep.stage1_stop.modeEpoch.after > rep.stage1_stop.modeEpoch.before);
  assert.deepEqual(rep.stage2_reconcile.waiting.map(x => [x.category, x.state]).sort(), [['game', 'sending'], ['inference', 'running']]);
  assert.match(rep.stage2_reconcile.note, /取り消さない/);
  assert.deepEqual(rep.stage3_release.notReleased.length, 2, 'the stop released neither the send nor the running call');
  // A held (before-send) reservation is released by the stop itself.
  const x = await session();
  x.w.relay.gateway.ledger.hold(x.w.agentId, { category: 'game', amount: '7000', key: 'held-at-stop', policyVersion: 3, modeEpoch: 1 });
  const xs = await x.s.stop();
  assert.deepEqual(xs.report.stage3_release.released.map(r => [r.category, r.amount, r.key]), [['game', '7000', 'held-at-stop']]);
  release();
  await running;
  assert.equal(w.view().balance.spent.inference, '20000', 'the running call is charged when it returns, after the stop');
  assert.deepEqual(w.books(), []);
});

test('undecided money is never released or withdrawn by itself: an unknown send across reconciles and a restart, a running call through a full withdrawal', async () => {
  const { w, s } = await session();
  w.faults.txUnknown = true;
  await s.tick();
  // Past its lifetime: the node shows no status. Reconcile marks it undecided (the scripted node keeps no history proof), never releases it.
  w.relay.chain.height = 1_000;
  for (let i = 0; i < 3; i++) await w.reconcile();
  w.relay.gateway.recover(); // a relay restart: sending holds wait for reconcile
  const v = w.view();
  const h = v.holds.find(x => x.category === 'game');
  assert.equal(h.state, 'sending');
  const c = s.costs();
  assert.equal(BigInt(c.reserved.sending) + BigInt(c.undecided.send), 15_000n, 'still reserved (sending or undecided), not released');
  const out = await s.withdraw({ all: true });
  assert.equal(out.balance.reserved, '15000', 'a full withdrawal leaves it reserved');
  assert.equal(out.balance.withdrawn, String(100_000 - 10_000 - 15_000));
  assert.deepEqual(w.books(), []);
});

test('two executor processes do NOT share the executor\'s caps (the limit of a single-process guard); the relay\'s one ledger still holds the whole budget', async () => {
  const { w, s } = await session({ requests: board(4), budget: { deposit: '1000000', total: '60000', perDay: '60000', callsPerDay: 50 } });
  // The relay draws each send's fee payer at random (crypto.randomInt) from 150. Both runs send the same Train with the same
  // accounts and the fixture's one blockhash: with the same payer the two transactions are byte-identical and the relay's
  // replay guard refuses the second as Duplicate (about 1 run in 150; diag/staking-race.mjs). That case has its own test
  // below; here each send gets a payer of its own, the condition this test's claim is about.
  let draw = 0;
  w.relay.pool.randomIndex = n => (draw++) % n;
  const pick = i => body => { const u = JSON.parse(body.messages[1].content); const r = u.requests.find(q => q.id === `R-${i}`); return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'mine' }] : [], skipped: [] }; };
  // The owner's executor cap: one training (15,000) of game spending a day. Two processes, two guards.
  const caps = { perDay: { game: '15000' } };
  const run = (i, guard) => participate({ mcp: w.mcp(), world: w.publicWorld, txState: w.txState, meter: w.meter, mandate: s.mandate, decider: modelDecider({ llm: scriptedLlm(pick(i)) }), journal: new RunJournal(), runId: `p${i}`,
    staking: { guard, priceBook: TEST_BOOK(), modelCfg: parseModelConfig({ provider: 'scripted', model: 'scripted-stand-in' }), gamePrices: s.terms.prices.game, onBudgetLimit: 'stop' } });
  const [a, b] = await Promise.all([run(1, new BudgetGuard({ caps })), run(2, new BudgetGuard({ caps }))]);
  const sent = [...a.items, ...b.items].filter(i => i.outcome === 'sent').length;
  assert.equal(sent, 2, 'each process kept its own count: the executor cap of one was used twice');
  // The relay's budget is one ledger: 2 × (10,000 + 15,000) = 50,000 of 60,000; a third training cannot pass it from any process.
  const c = await run(3, new BudgetGuard({ caps }));
  assert.equal(c.status, 'stopped-by-budget');
  const v = w.view();
  assert.ok(BigInt(v.balance.reserved) + BigInt(v.balance.spent.inference) + BigInt(v.balance.spent.game) <= 60_000n);
});

test('two identical sends in one blockhash window with the same fee payer: today the relay refuses the second as Duplicate (no game price, the budget holds); with the proposed patch 0002 both are sent', async () => {
  const { w, s } = await session({ requests: board(4), budget: { deposit: '1000000', total: '60000', perDay: '60000', callsPerDay: 50 } });
  w.relay.pool.randomIndex = () => 0; // the collision the random draw makes about once in 150 runs, made certain
  const pick = i => body => { const u = JSON.parse(body.messages[1].content); const r = u.requests.find(q => q.id === `R-${i}`); return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'mine' }] : [], skipped: [] }; };
  const caps = { perDay: { game: '15000' } };
  const run = (i, guard) => participate({ mcp: w.mcp(), world: w.publicWorld, txState: w.txState, meter: w.meter, mandate: s.mandate, decider: modelDecider({ llm: scriptedLlm(pick(i)) }), journal: new RunJournal(), runId: `p${i}`,
    staking: { guard, priceBook: TEST_BOOK(), modelCfg: parseModelConfig({ provider: 'scripted', model: 'scripted-stand-in' }), gamePrices: s.terms.prices.game, onBudgetLimit: 'stop' } });
  // The proposed relay patch 0002 builds the colliding one again (a fresh blockhash read here, another payer in production).
  const gw = await import('../../../permutation-gateway/src/frontier/agent/gateway.mjs');
  const rebuilds = Number.isInteger(gw.DUPLICATE_REBUILDS);
  const [a, b] = await Promise.all([run(1, new BudgetGuard({ caps })), run(2, new BudgetGuard({ caps }))]);
  const items = [...a.items, ...b.items];
  const v = w.view();
  if (rebuilds) {
    assert.deepEqual(items.map(i => i.outcome), ['sent', 'sent'], 'patch 0002: both sent');
    assert.equal(w.sentCount(), 2);
    assert.equal(v.balance.reserved, '30000');
  } else {
    assert.deepEqual(items.map(i => i.outcome).sort(), ['refused', 'sent']);
    assert.equal(items.find(i => i.outcome === 'refused').code, 'Duplicate');
    assert.equal(w.sentCount(), 1, 'one transaction left the relay');
    assert.equal(v.balance.spent.game, '0');
    assert.equal(v.balance.reserved, '15000', 'only the sent training is held (until the chain answers)');
  }
  assert.ok(BigInt(v.balance.reserved) + BigInt(v.balance.spent.inference) + BigInt(v.balance.spent.game) <= 60_000n);
  assert.deepEqual(w.books(), []);
});

test('the session slot is the Citizen\'s, not the village\'s: delegating to the owner\'s second agent ends the first one\'s delegation, for all its villages', async () => {
  const { w } = await createLocalWorld().then(world => ({ w: world }));
  const second = await w.ownerCreateAgent([-3, 8, 2]);
  assert.equal((await tool(w.mcp(), 'agent_view')).structuredContent.delegation.delegated, true);
  w.ownerDelegateTo(second.agentKey);
  const first = (await tool(w.mcp(), 'agent_view')).structuredContent;
  assert.equal(first.delegation.delegated, false, 'one Citizen, one session key');
  // The first agent's actions are refused by the relay's delegation check; nothing is sent.
  const n = w.sentCount();
  const act = await tool(w.mcp(), 'agent_act', { requestId: 'slot-check-1', policyVersion: first.policy.version, modeEpoch: first.modeEpoch, action: { name: 'Harvest', fields: {} } });
  assert.equal(act.structuredContent.error.code, 'SessionNotDelegated');
  assert.equal(w.sentCount(), n);
  // On chain the session key is checked only against the Citizen (actor == SESSION, not expired): no village or instruction field exists.
  const { decodeAccount } = await import('../../../permutation-gateway/client/src/frontier/codec.mjs');
  const { A } = await import('../../../permutation-gateway/test/agent-wallet-fixtures.mjs');
  const fields = Object.keys(decodeAccount('Citizen', w.relay.chain.accounts.get(A.citizen(w.owner)).data));
  assert.ok(fields.includes('SESSION') && fields.includes('SESSION_EXPIRY'));
  assert.equal(fields.some(f => /SESSION_(SCOPE|IX|HOLDING|LIMIT)/.test(f)), false);
});
