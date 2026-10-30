// The AI-staking demo, end to end on the local world:
//   予算設定 → 許可範囲設定 → 自動開始 → 操作と費用の確認 → 上限到達で停止 → 手動復帰 (→ 未使用分の引出し)
//
//   node workstreams/05-ai-participation/demo/run-staking-demo.mjs [--out <dir>]
//
// REAL (shared code, unchanged): owner commands (signed, verified), the ledger (deposit, holds, settlement,
// withdrawal), the relay's budget and call cap, the stop, the policy versions, the on-chain delegation check,
// the MCP server, GET /f/tx, the relay's reconcile. SCRIPTED/FAKE: the chain (the gateway tests' fake), the
// program's effects, the nation's board, and the model — a fake OpenAI-compatible server on 127.0.0.1 that
// answers from a script (it calls itself gemma-4-26b-a4b-it and reports a Gemma 3 file, to show the three
// names apart). Game prices are TEST VALUES. No outside network, no paid API, test USDC only.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunJournal } from '../src/adapters.mjs';
import { NATION, createLocalWorld, northernRequests } from '../src/local-world.mjs';
import { startFakeModelServer } from '../src/staking/fake-model-server.mjs';
import { TEST_BOOK } from '../src/staking/pricing.mjs';
import { StakingSession } from '../src/staking/session.mjs';

const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 ? process.argv[argOut + 1] : fileURLToPath(new URL('../logs/staking/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const write = (name, v) => writeFileSync(join(OUT, name), JSON.stringify(v, null, 2) + '\n');
const line = s => process.stdout.write(s + '\n');

const base = northernRequests()[0];
const board = [1, 2, 3, 4, 5].map(i => ({ ...base, id: `R-${i}`, title: `北方拠点の守り 第${i}陣：槍兵100`, ask: { kind: 'train', unit: 0, n: 100 } }));
const srv = await startFakeModelServer({
  alias: 'gemma-4-26b-a4b-it', modelPath: '/models/gemma-3-4b-it-Q4_K_M.gguf',
  answer: body => { const u = JSON.parse(body.messages[1].content); const r = u.requests[0]; return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: r.ask.n }, reason: 'the owner asked to defend the northern outpost; one batch fits the limits' }] : [], skipped: [] }; },
});
try {
  const w = await createLocalWorld({ balance: '0', requests: board, gamePrices: { Train: '15000' }, stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
  const journalFile = join(OUT, 'staking.journal.jsonl');
  rmSync(journalFile, { force: true });
  const s = new StakingSession({ world: w, model: { provider: 'local-openai', url: srv.url, model: 'gemma-4-26b-a4b-it' }, priceBook: TEST_BOOK(), journal: new RunJournal({ file: journalFile, now: () => w.state.clock * 1000 }) });
  const steps = [];
  const snap = (step, extra = {}) => { const st = s.statement(); steps.push({ step, ...extra, balance: st.balance, inFlight: st.inFlight, sound: st.sound }); return st; };

  // 1. 予算設定
  await s.setBudget({ deposit: '100000', total: '60000', perDay: '60000', callsPerDay: 10 });
  snap('1 budget', { policy: s.policy });
  // 2. 許可範囲設定
  await s.setScope({ allowed: ['economy'], mandate: { mandateId: 'stake-demo', purpose: '北方拠点の守りに、蓄えの範囲で槍兵を出す', nation: NATION, from: ['Aster-officer'], allowed: ['Train'], partial: true,
    limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 600, Ore: 200, Gold: 100 }, troopsPerRequest: 100 },
    budget: { perCall: { inference: '10000', game: '15000' } }, targets: { villages: [w.view().village] }, expiresAt: w.state.clock + 86_400 } });
  snap('2 scope', { policyAllowed: s.policy.allowed, mandate: s.mandate });
  // 3. 自動開始
  const started = await s.start();
  snap('3 start', { configuredModel: started.configuredModel, provider: started.provider, identity: started.identity, quote: started.quote, relayPrices: started.relayPrices });
  // 4–5. 操作と費用の確認、上限到達で停止
  const ticks = [];
  for (let i = 0; i < 6; i++) {
    const { report, verified } = await s.tick();
    ticks.push({ runId: report.runId, status: report.status, stoppedBy: report.stoppedBy ?? null, charged: report.charged, items: report.items.map(it => ({ request: it.requestId, outcome: it.outcome, code: it.code ?? null })), verified: verified.map(v => v.outcome) });
    snap(`4 tick ${i + 1}`, { tick: ticks.at(-1) });
    if (report.status === 'stopped-by-budget' && ticks.filter(t => t.status === 'stopped-by-budget').length >= 2) break;
  }
  // 6. 手動復帰
  const stop = await s.stop();
  snap('5 stop', { inFlightAtStop: stop.inFlightAtStop });
  const manual = await s.backToManual();
  snap('6 manual', { delegated: manual.delegated, session: manual.session });
  const out = await s.withdraw({ all: true });
  const final = snap('7 withdraw', { withdrawal: out.final });

  write('staking.report.json', {
    label: 'LOCAL FIXTURE. REAL: owner commands, ledger, budget, call cap, stop, versions, delegation check, MCP, GET /f/tx, reconcile. FAKE: chain (scripted), program effects (emulated), board (fixture), model (a fake loopback server answering from a script). Game prices: TEST VALUES.',
    model: { configured: s.modelCfg, identity: s.identity }, priceBook: s.priceBook.toJSON(), steps, ticks, trace: s.trace(), books: w.books(), finalStatement: final,
  });
  line(`# AI staking demo (local fixture; fake model server; scripted chain) → ${relative(process.cwd(), OUT) || '.'}`);
  line(`model: configured ${s.modelCfg.model} via ${s.modelCfg.provider}; the server SELF-REPORTS alias ${s.identity.reportedAlias}, file name ${s.identity.modelFile} (not verified: no file hash)`);
  for (const t of ticks) line(`${t.runId}: ${t.status}${t.stoppedBy ? ` (${t.stoppedBy})` : ''}, charged ${t.charged}; ${t.items.map(i => `${i.request}=${i.outcome}${i.code ? `(${i.code})` : ''}`).join(' ') || 'no proposal'}; checked against the mock chain and mock effect: ${t.verified.join(' ') || '-'}`);
  line(`settled: inference ${final.balance.settled.inference}, game ${final.balance.settled.game}; withdrawn ${final.balance.withdrawn} of ${final.balance.deposited} test-USDC base units (6 decimals; no USDC moved: scripted chain); books ${w.books().length ? 'UNSOUND' : 'sound'}; agent ${manual.mode}, key ${manual.session}`);
} finally { await srv.close(); }
