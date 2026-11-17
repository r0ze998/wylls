// Diagnostic for the intermittent test "two executor processes do NOT share the executor's caps"
// (test/staking.test.mjs). It runs the SAME scenario, but with seeded delays injected at the two boundaries where
// the two concurrent runs interleave (the MCP server's HTTP to the relay, and the relay's model-call meter), and
// records for every run: the seed, the delays drawn, the order of the relay calls, every outcome and code, and the
// relay's books. Nothing here changes the code under test.
//
//   node workstreams/05-ai-participation/diag/staking-race.mjs [--seeds 200] [--from 1] [--max-delay-ms 3] [--out file.json]
import { writeFileSync } from 'node:fs';
import { RunJournal } from '../src/adapters.mjs';
import { modelDecider } from '../src/deciders.mjs';
import { NATION, createLocalWorld, northernRequests, scriptedLlm } from '../src/local-world.mjs';
import { participate } from '../src/participate.mjs';
import { BudgetGuard } from '../src/staking/budget.mjs';
import { TEST_BOOK } from '../src/staking/pricing.mjs';
import { parseModelConfig } from '../src/staking/providers.mjs';
import { StakingSession } from '../src/staking/session.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SEEDS = Number(arg('--seeds', 200)), FROM = Number(arg('--from', 1)), MAXD = Number(arg('--max-delay-ms', 3)), OUT = arg('--out', null), PAYER = arg('--payer', 'random');

/** mulberry32: a small seeded PRNG, so that a failing interleaving can be replayed by its seed. */
const prng = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const BASE = northernRequests()[0];
const board = n => Array.from({ length: n }, (_, i) => ({ ...BASE, id: `R-${i + 1}`, title: `守り 第${i + 1}陣`, ask: { kind: 'train', unit: 0, n: 100 } }));
const scope = w => ({ mandateId: 'stake', purpose: '北方拠点の守り', nation: NATION, from: ['Aster-officer'], allowed: ['Train'], partial: true,
  limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 6000, Ore: 2000, Gold: 1000 }, troopsPerRequest: 100 }, expiresAt: w.state.clock + 86_400 });

export async function scenario(seed, maxDelayMs = MAXD, payer = PAYER) {
  const rnd = seed === null ? null : prng(seed);
  const delay = async (tag, events) => { const ms = rnd ? Math.floor(rnd() * (maxDelayMs + 1)) : 0; events.push({ t: tag, ms }); if (ms) await new Promise(r => setTimeout(r, ms)); else await null; };
  const events = [];
  const wall = { start: Date.now(), dayKey: new Date().toISOString().slice(0, 10) };
  const w = await createLocalWorld({ balance: '0', requests: board(4), gamePrices: { Train: '15000' }, stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
  const s = new StakingSession({ world: w, model: 'scripted', priceBook: TEST_BOOK(), providerDeps: { answer: () => ({ proposals: [], skipped: [] }) } });
  await s.setBudget({ deposit: '1000000', total: '60000', perDay: '60000', callsPerDay: 50 });
  await s.setScope({ allowed: ['economy'], mandate: scope(w) });
  await s.start();
  // The relay draws each send's fee payer at random from its pool. `same`: every draw the same payer; `distinct`: each a new one.
  const pool = w.relay.pool;
  const realIndex = pool.randomIndex.bind(pool);
  let k = 0;
  if (payer === 'same') pool.randomIndex = () => 0;
  else if (payer === 'distinct') pool.randomIndex = n => (k++) % n;
  const draws = [];
  const drawIndex = pool.randomIndex.bind(pool);
  pool.randomIndex = n => { const i = drawIndex(n); draws.push(i); return i; };
  const baseFetch = w.fetch;
  const fetchFor = who => async (url, init = {}) => {
    const path = new URL(url).pathname;
    await delay(`${who} → ${init.method ?? 'GET'} ${path}`, events);
    const r = await baseFetch(url, init);
    const body = await r.json();
    events.push({ t: `${who} ← ${path} ${r.status}`, code: body?.error?.code ?? body?.status ?? null });
    return { status: r.status, json: async () => body };
  };
  const meterFor = who => async (fn, opts) => { await delay(`${who} meter`, events); const m = await w.meter(fn, opts); events.push({ t: `${who} meter done`, ok: m.ok, charged: m.charged }); return m; };
  const pick = i => body => { const u = JSON.parse(body.messages[1].content); const r = u.requests.find(q => q.id === `R-${i}`); return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'mine' }] : [], skipped: [] }; };
  const caps = { perDay: { game: '15000' } };
  const { createAgentMcp } = await import('../src/deps.mjs');
  const run = (i, guard) => participate({ mcp: createAgentMcp({ relay: 'http://relay.test', agentId: w.agentId, capability: w.capability, fetch: fetchFor(`p${i}`) }), world: w.publicWorld, txState: w.txState, meter: meterFor(`p${i}`), mandate: s.mandate,
    decider: modelDecider({ llm: scriptedLlm(pick(i)) }), journal: new RunJournal(), runId: `p${i}`,
    staking: { guard, priceBook: TEST_BOOK(), modelCfg: parseModelConfig({ provider: 'scripted', model: 'scripted-stand-in' }), gamePrices: s.terms.prices.game, onBudgetLimit: 'stop' } });
  const [a, b] = await Promise.all([run(1, new BudgetGuard({ caps })), run(2, new BudgetGuard({ caps }))]);
  const items = [...a.items, ...b.items].map(x => ({ request: x.requestId, outcome: x.outcome, code: x.code ?? null }));
  const sent = items.filter(x => x.outcome === 'sent').length;
  const c = await run(3, new BudgetGuard({ caps }));
  const v = w.view();
  const used = BigInt(v.balance.reserved) + BigInt(v.balance.spent.inference) + BigInt(v.balance.spent.game);
  wall.end = Date.now(); wall.dayKeyEnd = new Date().toISOString().slice(0, 10);
  const sends = w.relay.chain.sent.map(tx => ({ feePayer: tx.feePayer?.toBase58?.() ?? String(tx.feePayer ?? ''), signature: Buffer.from(tx.signatures[0]).toString('hex').slice(0, 16) }));
  pool.randomIndex = realIndex;
  return {
    seed, payer, maxDelayMs, wall, events, payerDraws: draws, sends, a: { status: a.status, charged: a.charged, items: a.items.map(x => [x.requestId, x.outcome, x.code ?? null]) }, b: { status: b.status, charged: b.charged, items: b.items.map(x => [x.requestId, x.outcome, x.code ?? null]) },
    c: { status: c.status, stoppedBy: c.stoppedBy ?? null }, books: { available: v.balance.available, reserved: v.balance.reserved, spent: v.balance.spent, used: String(used), day: v.day },
    // The three assertions of the test, apart: the first two are what the test observes, the third is the budget's safety.
    checks: { twoSent: sent === 2, thirdStopped: c.status === 'stopped-by-budget', withinBudget: used <= 60_000n, ledgerSound: w.books().length === 0 },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runs = [];
  for (let k = FROM; k < FROM + SEEDS; k++) runs.push(await scenario(k));
  const fail = runs.filter(r => !Object.values(r.checks).every(Boolean));
  const tally = {};
  for (const r of fail) { const sig = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join('+') + ` | a=${JSON.stringify(r.a.items)} b=${JSON.stringify(r.b.items)} c=${r.c.status}`; tally[sig] = (tally[sig] ?? []).concat(r.seed); }
  const summary = { payer: PAYER, seeds: `${FROM}..${FROM + SEEDS - 1}`, maxDelayMs: MAXD, runs: runs.length, failing: fail.length, budgetUnsafe: runs.filter(r => !r.checks.withinBudget || !r.checks.ledgerSound).length, signatures: tally };
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify({ summary, failing: fail, sample: runs.slice(0, 2) }, null, 2) + '\n');
}
