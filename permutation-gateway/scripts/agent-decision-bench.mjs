// The model's judgement by situation (docs/agent-wallet/DESIGN.md §12.2): the same prompt the relay's runner
// builds (runner.mjs promptOf, with the village's state as the observer reads it from the herald), over
// prepared situations — a village that should build, one that should train, one that should rest — put to the
// real local model (the pinned llama-server, citizens/llama/start-pinned.sh) through the same decider
// (llmDecider: temperature 0, the JSON schema, the candidate check). Nothing is sent to a chain; no USDC moves;
// the only cost is the local model's time. The report names the model (/props), every prompt, answer, reason,
// token counts and latency, and whether the answer is in the expected set and affordable.
//
//   AGENT_BENCH_LLM=http://127.0.0.1:41901 AGENT_BENCH_OUT=.local/agent-wallet-e2e/bench-1 node permutation-gateway/scripts/agent-decision-bench.mjs
//   AGENT_BENCH_HERALD=http://127.0.0.1:41640 AGENT_BENCH_OWNER=<wallet> AGENT_BENCH_VILLAGE=p,q,site   adds the live village as a situation.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlm } from '../citizens/mind/llm.mjs';
import { AgentObserver, affordable, llmDecider, promptOf, ruleDecider, threatOf } from '../src/frontier/agent/runner.mjs';

const llmUrl = process.env.AGENT_BENCH_LLM ?? 'http://127.0.0.1:41901';
if (!['127.0.0.1', 'localhost'].includes(new URL(llmUrl).hostname)) throw new Error('a local model only');
const outDir = path.resolve(process.env.AGENT_BENCH_OUT ?? fileURLToPath(new URL(`../../.local/agent-wallet-e2e/bench-${new Date().toISOString().replace(/[:.]/g, '-')}`, import.meta.url)));
mkdirSync(outDir, { recursive: true });
const repeats = Number(process.env.AGENT_BENCH_REPEATS ?? 1);

const ALL = ['Harvest', 'Train', 'Build', 'SetVigil'];
const base = { tier: 'Hamlet', store_cap: 2000, production_per_hour: { Food: 40, Wood: 30, Stone: 20, Ore: 15, Gold: 15, Science: 5 }, upkeep_per_hour: {}, queue: [], free_queue_slots: 4, walls: 0, reserve_troops: {}, marches_out: 0, garrison: 0, hosts: [], province: { other_hosts: [], camp: null }, vigil_start_min: 0 };
const st = (over, more = {}) => { const s = { ...base, ...over, province: { ...base.province, ...(over.province ?? {}) }, ...more }; const threat = threatOf(s); return threat ? { ...s, threat } : s; };
/**
 * The situations. `expect` is the set of answers a careful player would give; `avoid` what would be a plain mistake.
 * Stores are whole units; a Hamlet's cap is 2,000. Costs: CATALOG (a building ≈ 80–140 units; a batch of 100 troops
 * 60 Food + Ore + Gold).
 */
const SITUATIONS = [
  { name: 'build: rich stores, empty queue, no threat', expect: ['Build'], avoid: ['rest', 'Train'],
    state: st({ stores: { Food: 1500, Wood: 1200, Stone: 900, Ore: 300, Gold: 200, Science: 40 } }) },
  { name: 'build: early village, one building affordable, nothing under way', expect: ['Build'], avoid: ['Train'],
    state: st({ stores: { Food: 300, Wood: 300, Stone: 200, Ore: 100, Gold: 100, Science: 30 } }) },
  { name: 'train: a hostile host and a camp in the province, nothing at home, stores cover a batch', expect: ['Train'], avoid: ['rest', 'Build'],
    state: st({ stores: { Food: 900, Wood: 100, Stone: 50, Ore: 300, Gold: 200 }, queue: [{ what: 'Wood building', done_in_s: 5400 }, { what: 'Stone building', done_in_s: 9000 }], free_queue_slots: 2, province: { other_hosts: [{ unit: 'Horseman', troops: 300, faction: 1 }], camp: { troops: 200 } } }) },
  { name: 'train: a hostile host at the gate, the garrison and reserve empty, stores thin but a batch affordable', expect: ['Train'], avoid: ['Build'],
    state: st({ stores: { Food: 120, Wood: 20, Stone: 10, Ore: 40, Gold: 30 }, province: { other_hosts: [{ unit: 'Spearman', troops: 150, faction: 3 }], camp: null } }) },
  { name: 'rest: stores nearly empty, every queue slot busy, no threat', expect: ['rest', 'Harvest'], avoid: ['Build', 'Train'],
    state: st({ stores: { Food: 30, Wood: 10, Stone: 5 }, queue: [{ what: 'Food building', done_in_s: 3000 }, { what: 'Wood building', done_in_s: 6000 }, { what: 'walls', done_in_s: 7200 }, { what: 'tier-up', done_in_s: 20000 }], free_queue_slots: 0 }) },
  { name: 'rest: rich stores but no free queue slot and no threat', expect: ['rest', 'Harvest'], avoid: ['Build', 'Train'],
    state: st({ stores: { Food: 1500, Wood: 1200, Stone: 900, Ore: 300, Gold: 200 }, queue: [{ what: 'Food building', done_in_s: 3000 }, { what: 'Wood building', done_in_s: 6000 }, { what: 'Stone building', done_in_s: 7200 }, { what: 'Gold building', done_in_s: 9000 }], free_queue_slots: 0 }) },
  { name: 'rest: a threat but nothing affordable (Food 20)', expect: ['rest', 'Harvest'], avoid: ['Train', 'Build'],
    state: st({ stores: { Food: 20, Wood: 5 }, province: { other_hosts: [{ unit: 'Archer', troops: 200, faction: 1 }], camp: null } }) },
  { name: 'defended already: a hostile host, but 400 troops in the reserve and 300 in the garrison; stores rich', expect: ['Build', 'rest', 'Harvest'], avoid: ['Train'],
    state: st({ stores: { Food: 1200, Wood: 900, Stone: 700, Ore: 200, Gold: 150 }, reserve_troops: { Spearman: 400 }, garrison: 300, province: { other_hosts: [{ unit: 'Archer', troops: 100, faction: 1 }], camp: null } }) },
];

const view = (allowed = ALL) => ({ agentId: 'bench', village: [3, 0, 2], policy: { version: 1, allowed, budget: { total: '1000000', perDay: '500000' } }, modeEpoch: 1, history: [], balance: { available: '900000', spent: { inference: '100000', network: '0', game: '0' } } });

async function main() {
  const llm = createLlm({ url: llmUrl });
  const props = await (await fetch(`${llmUrl}/props`)).json().catch(() => null);
  const models = await (await fetch(`${llmUrl}/v1/models`)).json().catch(() => null);
  const model = { mode: 'real', url: llmUrl, alias: models?.data?.[0]?.id ?? null, modelPath: props?.model_path ?? props?.default_generation_settings?.model ?? null, n_ctx: props?.default_generation_settings?.n_ctx ?? null, settings: { temperature: 0, top_k: 1, seed: 7, max_tokens: 160, response_format: 'json_schema (strict)' } };
  if (!model.alias) throw new Error(`no model at ${llmUrl}`);
  const decider = llmDecider({ llm, alias: model.alias });
  const autopilot = ruleDecider();
  const situations = [...SITUATIONS];
  if (process.env.AGENT_BENCH_HERALD && process.env.AGENT_BENCH_OWNER && process.env.AGENT_BENCH_VILLAGE) {
    const village = process.env.AGENT_BENCH_VILLAGE.split(',').map(Number);
    const obs = await new AgentObserver({ heraldUrl: process.env.AGENT_BENCH_HERALD }).observe({ owner: process.env.AGENT_BENCH_OWNER, village });
    if (obs.ok && obs.state) situations.push({ name: `live: the village ${village.join(',')} on ${process.env.AGENT_BENCH_HERALD} at turn ${obs.bell}`, expect: null, avoid: [], state: obs.state, live: true });
  }
  const report = { mode: 'agent-decision-bench', testAssetsOnly: true, chain: 'none (prompts only)', startedAt: new Date().toISOString(), model, repeats, autopilot: { name: autopilot.name, answers: 'Harvest when allowed, always (free)' }, situations: [] };
  let right = 0, wrong = 0, invalid = 0;
  for (const sit of situations) {
    const v = view();
    const names = ALL;
    const obs = { bell: 12, triggers: ['event'], state: sit.state };
    const prompt = promptOf(v, names, obs);
    const runs = [];
    for (let i = 0; i < repeats; i++) {
      const t0 = Date.now();
      let r;
      try { r = { ok: true, ...(await decider.decide(v, obs)) }; } catch (e) { r = { ok: false, error: String(e.message ?? e), tokens: e.tokens ?? null }; }
      const ms = Date.now() - t0;
      const answer = r.ok ? (r.choice ? r.choice.name : 'rest') : null;
      const ok = r.ok && (sit.expect === null || sit.expect.includes(answer)) && !sit.avoid.includes(answer) && affordable(r.choice, sit.state);
      runs.push({ answer, fields: r.choice?.fields ?? null, reason: r.reason ?? null, tokens: r.tokens ?? null, ms, affordable: r.ok ? affordable(r.choice, sit.state) : null, error: r.error ?? null, verdict: !r.ok ? 'invalid' : sit.expect === null ? 'recorded' : ok ? 'right' : 'wrong' });
      if (!r.ok) invalid++; else if (sit.expect !== null) { if (ok) right++; else wrong++; }
      console.log(`${sit.name}: ${answer}${r.choice?.fields ? ' ' + JSON.stringify(r.choice.fields) : ''} (${ms} ms) — ${runs.at(-1).verdict}${r.reason ? ': ' + r.reason : ''}${r.error ? ': ' + r.error : ''}`);
    }
    report.situations.push({ name: sit.name, live: !!sit.live, expect: sit.expect, avoid: sit.avoid, state: sit.state, promptChars: JSON.stringify(prompt).length, prompt, autopilot: (await autopilot.decide(v))?.name ?? 'rest', runs });
  }
  report.summary = { situations: situations.length, judged: right + wrong, right, wrong, invalid, live: situations.filter(s => s.live).length };
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const rows = report.situations.map(s => `| ${s.name} | ${s.expect ? s.expect.join('/') : '(live)'} | ${s.runs.map(r => `${r.answer ?? 'invalid'}${r.fields ? ' ' + JSON.stringify(r.fields) : ''}`).join('; ')} | ${s.runs.map(r => r.verdict).join('; ')} | ${s.runs.map(r => r.ms).join('; ')} | ${s.autopilot} |`);
  writeFileSync(path.join(outDir, 'report.md'), `# Decision bench — ${model.alias}\n\n${model.modelPath ?? ''}; temperature 0, seed 7, JSON schema. ${report.summary.right}/${report.summary.judged} judged right, ${report.summary.invalid} invalid.\n\n| situation | expected | model | verdict | ms | autopilot |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
  console.log(`bench: ${report.summary.right}/${report.summary.judged} right, ${report.summary.invalid} invalid; ${path.join(outDir, 'report.json')}`);
}
await main();
