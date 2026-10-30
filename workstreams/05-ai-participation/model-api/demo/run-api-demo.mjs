// The minimal away-mode flow over a provider API, for Claude and for GPT, on fixtures:
//   予算設定 → 自動開始 → 判断 → 許可範囲のゲーム操作 → 費用照合 → 上限停止 → 手動復帰
//
//   node workstreams/05-ai-participation/model-api/demo/run-api-demo.mjs [--out <dir>]
//
// Each stage prints what in it is REAL (this repository's code, unchanged), MOCK (a stand-in for a contract not
// received or not decided) or FIXTURE (scripted data). The "model" is the HTTP fixture on 127.0.0.1: it is not a
// model, and nothing here is a live call, a production price or a production success. No key, no outside network,
// test assets only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunJournal } from '../../src/adapters.mjs';
import { createLocalWorld, northernRequests } from '../../src/local-world.mjs';
import { mandateFor } from '../../test/helpers.mjs';
import { anthropicAdapter, openaiAdapter } from '../src/adapters.mjs';
import { loopbackTransport } from '../src/http-transport.mjs';
import { FIXTURE_BOOK } from '../src/price-book.mjs';
import { RunCostMock } from '../src/run-cost.mjs';
import { DecisionRegistry } from '../src/inference.mjs';
import { apiDecider } from '../src/api-decider.mjs';
import { Autopilot } from '../src/autopilot.mjs';
import { reconcileUndecided } from '../src/reconcile.mjs';
import { startHttpFixture } from '../fixture/http-fixture.mjs';

const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 ? process.argv[argOut + 1] : fileURLToPath(new URL('../../logs/model-api/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const line = s => process.stdout.write(s + '\n');

const BOUNDARY = {
  budget: 'MOCK: RunCostMock stands in for ④\'s cost contract (bd415e7 not received); FIXTURE price book (invented prices; no production model or price)',
  start: 'REAL: relay mode and on-chain delegation read through MCP agent_view (the chain is the gateway tests\' scripted fake). The autopilot never sets the mode or a session key',
  decide: 'FIXTURE: the HTTP fixture on 127.0.0.1 answers in the provider\'s documented shape. Not a model, not a provider, not a live call',
  act: 'REAL: ⑤\'s guard, the EXISTING MCP agent_act and relay checks. NOT ④: ④\'s Run / cancel / reconcile are not received and not integrated. FAKE: the chain and the game\'s effects (emulated)',
  reconcile: 'FIXTURE CONTRACT: measured = fixture usage × fixture book, matched to a fixture provider record. Sending a client request id is documented; querying billing by it is NOT verified in production. Unmatched costs stay held (no 0, no refund on the operator\'s word)',
  stop: 'MOCK: the inference total cap of RunCostMock; the stop itself is ⑤\'s autopilot (REAL code, one process)',
  resume: 'REAL code; the owner is a test keypair; the cap change is on the mock',
};

const userOf = body => JSON.parse((body.messages ?? body.input).find(m => m.role === 'user').content);
const answerFirst = body => { const r = userOf(body).requests[0]; return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'one batch fits the owner\'s limits' }] : [], skipped: [] }; };
const board = () => { const b = northernRequests()[0]; return [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ ...b, id: `R-${i}`, title: `北方拠点の守り 第${i}陣：槍兵100`, ask: { kind: 'train', unit: 0, n: 100 } })); };

async function flow(name, adapter, model) {
  // The second model request times out (the fixture answers after the client's deadline): an undecided cost to reconcile.
  const srv = await startHttpFixture((body, n) => n === 1 ? { delayMs: 250, answer: answerFirst(body) } : { answer: answerFirst(body) });
  const stages = [];
  const stage = (id, title, data) => { stages.push({ stage: id, title, boundary: BOUNDARY[id], ...data }); line(`  [${title}] ${BOUNDARY[id]}`); };
  try {
    const w = await createLocalWorld({ requests: board(), stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
    const costs = new RunCostMock({ available: '200000', caps: {}, now: () => w.state.clock * 1000 });
    const registry = new DecisionRegistry();
    let ap;
    const decider = apiDecider({ adapter, model, transport: loopbackTransport({ baseUrl: srv.url, timeoutMs: 80 }), book: FIXTURE_BOOK(), costs, registry, runId: () => ap.currentRun, sleep: async () => {} });
    const mandate = mandateFor(w, { allowed: ['Train'], limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 600, Ore: 200, Gold: 100 }, troopsPerRequest: 100 } });
    ap = new Autopilot({ world: w, mandate, decider, journal: new RunJournal({ now: () => w.state.clock * 1000 }) });
    line(`\n## ${name}: configured ${model} (fixture id) over ${decider.name}`);

    // 1. 予算設定: the inference cap is set from the first quote below, so that a few calls fit and then the cap stops it.
    stage('budget', '1 予算設定', { available: costs.classes().available, caps: { ...costs.caps }, priceBook: FIXTURE_BOOK().toJSON?.() ?? 'FIXTURE' });
    // 2. 自動開始
    stage('start', '2 自動開始', { status: await ap.start({ by: 'owner' }) });
    // 3–4. 判断 → 許可範囲のゲーム操作
    const t1 = await ap.tick(); w.settle();
    // The owner's inference total cap: what is spent, one more quote, and about two more calls' measured cost.
    costs.caps.total = String(BigInt(costs.classes().settled) + BigInt(decider.records[0].quote) + 3000n);
    stage('decide', '3 判断', { record: t1.inference, capSet: costs.caps.total });
    stage('act', '4 許可範囲のゲーム操作', { game: t1.game, sent: w.sentCount() });
    // 5. 費用照合: the next call times out (undecided); the provider record fixture settles it where the ids match.
    // GPT logs our attempt key (X-Client-Request-Id); Claude has no documented client id, and a timeout leaves no
    // request id, so Claude's undecided call stays held for the operator (and out of what the owner can withdraw).
    w.advance(60);
    const t2 = await ap.tick(); w.settle();
    const undecidedBefore = costs.classes().undecided;
    const key = t2.inference.attempts[0]?.key;
    const rec = reconcileUndecided({ costs, book: FIXTURE_BOOK(), records: decider.records, report: { source: 'fixture', entries: [{ clientRequestId: adapter === openaiAdapter ? key : null, providerRequestId: null, usage: { inputUncached: 900, cacheRead: 0, cacheWrite: {}, output: 120, reasoning: 30, serverTools: {} }, billed: true }] } });
    stage('reconcile', '5 費用照合', { timedOut: t2.inference, undecidedBefore, reconcile: rec, after: costs.classes() });
    await new Promise(r => setTimeout(r, 260));
    // 6. 上限停止
    const ticks = [t1, t2];
    for (let i = 0; i < 10 && ap.state === 'running'; i++) { w.advance(60); ticks.push(await ap.tick()); w.settle(); }
    const before = srv.requests();
    const skipped = await ap.tick();
    stage('stop', '6 上限停止', { state: ap.status(), last: ticks.at(-1), skippedAfterStop: skipped, modelRequestsAfterStop: srv.requests() - before });
    // 7. 手動復帰
    costs.caps.total = String(BigInt(costs.caps.total) + 30000n);
    await ap.resume({ by: 'owner', note: 'the owner raised the inference total cap by 30000' });
    w.advance(60);
    const back = await ap.tick(); w.settle();
    ticks.push(back);
    stage('resume', '7 手動復帰', { status: ap.status(), record: back });
    ap.stop({ by: 'owner' });

    const sum = { provider: adapter.provider, model, ticks: ticks.map(t => ({ runId: t.runId, status: t.status, inference: t.inference?.status, outcome: t.inference?.outcome, game: t.game.map(g => `${g.requestId}=${g.outcome}`).join(' ') })), costs: costs.classes(), overruns: costs.overruns, modelRequests: srv.requests(), gameSends: w.sentCount(), books: w.books().length ? 'UNSOUND' : 'sound' };
    for (const t of sum.ticks) line(`  ${t.runId}: ${t.status}; inference ${t.inference ?? '-'}${t.outcome ? ` (${t.outcome})` : ''}; game ${t.game || '-'}`);
    line(`  costs (test-USDC base units, MOCK): settled ${sum.costs.settled}, undecided ${sum.costs.undecided}, released ${sum.costs.released}, available ${sum.costs.available}; model HTTP requests to the fixture ${sum.modelRequests}; game sends ${sum.gameSends} (scripted chain)`);
    return { summary: sum, stages, autopilotEvents: ap.events, journal: ap.journal.entries };
  } finally { await srv.close(); }
}

line('# away-mode flow over a provider API — LOCAL FIXTURES ONLY (no key, no outside network, no model, test assets)');
const out = { label: 'LOCAL FIXTURE. Not a live call, not a production price, not a production success.', flows: [] };
for (const [name, adapter, model] of [['Claude', anthropicAdapter, 'claude-fixture-model'], ['GPT', openaiAdapter, 'gpt-fixture-model']]) out.flows.push({ name, ...(await flow(name, adapter, model)) });
writeFileSync(join(OUT, 'api-demo.report.json'), JSON.stringify(out, null, 2) + '\n');
line(`\nreport → ${relative(process.cwd(), join(OUT, 'api-demo.report.json'))}`);
