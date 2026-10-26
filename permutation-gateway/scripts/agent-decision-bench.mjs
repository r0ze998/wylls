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
//   AGENT_BENCH_REPEATS=3           every situation that many times (temperature 0: the answers should repeat)
//   AGENT_BENCH_RULES=mc | s1 | all  which situations: the ten MC ones (the default, as every earlier run), the four S1 ones
//                                    (profile 3: the model is told the S1 catalog, arms and the workshop, and is judged by it), or both
//   AGENT_BENCH_VARIANT=catalog-reversed | stores-reversed   the same situations with the catalog, or the stores, listed in
//                                    reverse order — an order-bias check (the relay never varies the order; this is diagnosis, not tuning)
// Two scores, kept apart: the model's judgement (its answer against what a careful player would do, over ALL situations,
// a refused answer counted as wrong) and the code's safety (how many wrong answers the decider refused before the chain;
// the autopilot then plays free).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLlm } from '../citizens/mind/llm.mjs';
import { AgentObserver, affordable, catalogFor, llmDecider, promptOf, ruleDecider, threatOf } from '../src/frontier/agent/runner.mjs';

// Run as a script; imported (the tests read the situations), nothing runs.
const asScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const llmUrl = process.env.AGENT_BENCH_LLM ?? 'http://127.0.0.1:41901';
if (asScript && !['127.0.0.1', 'localhost'].includes(new URL(llmUrl).hostname)) throw new Error('a local model only');
const outDir = path.resolve(process.env.AGENT_BENCH_OUT ?? fileURLToPath(new URL(`../../.local/agent-wallet-e2e/bench-${new Date().toISOString().replace(/[:.]/g, '-')}`, import.meta.url)));
const repeats = Number(process.env.AGENT_BENCH_REPEATS ?? 1);
const variant = process.env.AGENT_BENCH_VARIANT ?? 'plain';
// AGENT_BENCH_STRICT=1: the opt-in strict schema (one branch per action, required fields and ranges; runner.mjs decisionSchema)
const strictSchema = process.env.AGENT_BENCH_STRICT === '1';
const rules = process.env.AGENT_BENCH_RULES ?? 'mc';
if (!['mc', 's1', 'all'].includes(rules)) throw new Error(`AGENT_BENCH_RULES: mc, s1 or all (not ${rules})`);
/** The prompt options of a situation's rules (its catalog reversed under the catalog-reversed variant). */
const promptOptionsFor = profile => {
  const cat = catalogFor(profile);
  return variant === 'catalog-reversed' ? { catalog: { build: [...cat.build].reverse(), train: [...cat.train].reverse() } } : variant === 'stores-reversed' ? { reverseStores: true } : {};
};

const ALL = ['Harvest', 'Train', 'Build', 'SetVigil'];
const base = { tier: 'Hamlet', store_cap: 2000, production_per_hour: { Food: 40, Wood: 30, Stone: 20, Ore: 15, Gold: 15, Science: 5 }, upkeep_per_hour: {}, queue: [], free_queue_slots: 4, walls: 0, reserve_troops: {}, marches_out: 0, garrison: 0, hosts: [], province: { other_hosts: [], camp: null }, vigil_start_min: 0 };
const st = (over, more = {}) => { const s = { ...base, ...over, province: { ...base.province, ...(over.province ?? {}) }, ...more }; const threat = threatOf(s); return threat ? { ...s, threat } : s; };
/**
 * The situations. `expect` is the set of answers a careful player would give; `avoid` what would be a plain mistake.
 * Stores are whole units; a Hamlet's cap is 2,000. Costs: CATALOG (a building ≈ 80–140 units; a batch of 100 troops
 * 60 Food + Ore + Gold).
 */
export const SITUATIONS = [
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
  // The Food question (§12.2): is "a Food building first" reasoning or a bias? Food at its cap wastes every Food building's
  // output; a careful player builds something else. Stone is the scarcest input here.
  { name: 'food at the cap (1990 of 2000), wood and stone plentiful, no threat: a Food building would waste its output', expect: ['Build'], avoid: ['rest', 'Train'], fields: { Build: f => f.item !== 0 },
    state: st({ stores: { Food: 1990, Wood: 900, Stone: 900, Ore: 300, Gold: 300, Science: 50 } }) },
  { name: 'food short (production 40 against an upkeep of 60: a shortfall), wood and stone plentiful, no threat', expect: ['Build'], avoid: ['rest', 'Train'], fields: { Build: f => f.item === 0 },
    state: st({ stores: { Food: 40, Wood: 900, Stone: 900, Ore: 300, Gold: 300 }, upkeep_per_hour: { Food: 60 }, food_shortfall: 120 }) },
].map(x => ({ ...x, profile: 2 }));

/**
 * The S1 situations (profile 3, permutation-rules arms.rs): store slot 4 is Arms; Pikeman, Crossbowman and Knight
 * also cost arms per batch (50, 70, 40); the workshop (item 8) turns ore and wood into arms. Each is judged by the S1
 * catalog (catalogFor(3)): an answer the S1 stores cannot pay is wrong, as on chain.
 */
const S1 = { production_per_hour: { Food: 40, Wood: 30, Stone: 20, Ore: 18, Gold: 15, Science: 5 } };
export const SITUATIONS_S1 = [
  { name: 'S1 train without arms: a hostile host at the gate, nothing at home, no arms; a basic batch is affordable, a strong one is not', expect: ['Train'], avoid: ['rest', 'Build'], fields: { Train: f => f.unit <= 2 },
    state: st({ ...S1, stores: { Food: 400, Wood: 100, Stone: 50, Ore: 200, Gold: 100 }, province: { other_hosts: [{ unit: 'Horseman', troops: 300, faction: 1 }], camp: null } }) },
  { name: 'S1 train with arms: knights and a camp in the province, nothing at home, 150 arms from a workshop; any affordable batch defends', expect: ['Train'], avoid: ['rest', 'Build'],
    state: st({ ...S1, production_per_hour: { ...S1.production_per_hour, Arms: 4 }, stores: { Food: 600, Wood: 100, Stone: 50, Ore: 300, Gold: 200, Arms: 150 }, province: { other_hosts: [{ unit: 'Knight', troops: 400, faction: 2 }], camp: { troops: 200 } } }) },
  // The S1 counterpart of "food at the cap": ore piles up at the cap with nothing to turn it into; a workshop makes it arms.
  { name: 'S1 workshop: ore at the cap (1990 of 2000) and rising, no workshop, no arms, no threat; the other stores plentiful', expect: ['Build'], avoid: ['rest', 'Train'], fields: { Build: f => f.item === 8 },
    state: st({ ...S1, production_per_hour: { ...S1.production_per_hour, Ore: 30 }, stores: { Food: 1500, Wood: 900, Stone: 900, Ore: 1990, Gold: 300, Science: 50 } }) },
  { name: 'S1 rest: a threat but nothing affordable (Food 20, no arms)', expect: ['rest', 'Harvest'], avoid: ['Train', 'Build'],
    state: st({ ...S1, stores: { Food: 20, Wood: 5, Ore: 10 }, province: { other_hosts: [{ unit: 'Pikeman', troops: 200, faction: 1 }], camp: null } }) },
].map(x => ({ ...x, profile: 3 }));

const view = (allowed = ALL) => ({ agentId: 'bench', village: [3, 0, 2], policy: { version: 1, allowed, budget: { total: '1000000', perDay: '500000' } }, modeEpoch: 1, history: [], balance: { available: '900000', spent: { inference: '100000', network: '0', game: '0' } } });

async function main() {
  mkdirSync(outDir, { recursive: true });
  const llm = createLlm({ url: llmUrl });
  const props = await (await fetch(`${llmUrl}/props`)).json().catch(() => null);
  const models = await (await fetch(`${llmUrl}/v1/models`)).json().catch(() => null);
  const model = { mode: 'real', url: llmUrl, alias: models?.data?.[0]?.id ?? null, modelPath: props?.model_path ?? props?.default_generation_settings?.model ?? null, n_ctx: props?.default_generation_settings?.n_ctx ?? null, settings: { temperature: 0, top_k: 1, seed: 7, max_tokens: 160, response_format: 'json_schema (strict)' } };
  if (!model.alias) throw new Error(`no model at ${llmUrl}`);
  model.settings.schema = strictSchema ? 'strict (per action)' : 'loose (the measured runs\' schema)';
  // One decider per rules: each tells the model its own catalog (and reverses it under the catalog-reversed variant).
  const deciders = { 2: llmDecider({ llm, alias: model.alias, promptOptions: promptOptionsFor(2), strictSchema }), 3: llmDecider({ llm, alias: model.alias, promptOptions: promptOptionsFor(3), strictSchema }) };
  const autopilot = ruleDecider();
  const situations = [...(rules === 's1' ? [] : SITUATIONS), ...(rules === 'mc' ? [] : SITUATIONS_S1)];
  if (process.env.AGENT_BENCH_HERALD && process.env.AGENT_BENCH_OWNER && process.env.AGENT_BENCH_VILLAGE) {
    const village = process.env.AGENT_BENCH_VILLAGE.split(',').map(Number);
    const obs = await new AgentObserver({ heraldUrl: process.env.AGENT_BENCH_HERALD }).observe({ owner: process.env.AGENT_BENCH_OWNER, village });
    if (obs.ok && obs.state) situations.push({ name: `live: the village ${village.join(',')} on ${process.env.AGENT_BENCH_HERALD} at turn ${obs.bell}`, expect: null, avoid: [], state: obs.state, live: true, profile: obs.profile ?? 2 });
  }
  const report = { mode: 'agent-decision-bench', testAssetsOnly: true, chain: 'none (prompts only)', startedAt: new Date().toISOString(), model, repeats, variant, rules, autopilot: { name: autopilot.name, answers: 'Harvest when allowed, always (free)' }, situations: [] };
  let right = 0, wrong = 0, refused = 0, total = 0;
  for (const sit of situations) {
    const v = view();
    const names = ALL;
    const obs = { bell: 12, triggers: ['event'], state: sit.state, profile: sit.profile };
    const decider = deciders[sit.profile >= 3 ? 3 : 2];
    const catalog = catalogFor(sit.profile);
    const prompt = promptOf(v, names, obs, promptOptionsFor(sit.profile));
    const runs = [];
    for (let i = 0; i < repeats; i++) {
      const t0 = Date.now();
      let r;
      try { r = { ok: true, ...(await decider.decide(v, obs)) }; } catch (e) { r = { ok: false, error: String(e.message ?? e), tokens: e.tokens ?? null }; }
      const ms = Date.now() - t0;
      // The model's judgement: its answer against the expectation (a refused answer is a wrong judgement); the code's part: refused or accepted.
      const answer = r.ok ? (r.choice ? r.choice.name : 'rest') : (r.error?.match(/model: (\w+)/)?.[1] ?? null);
      const fieldsOk = !r.choice || !sit.fields?.[r.choice.name] || sit.fields[r.choice.name](r.choice.fields);
      const judged = sit.expect !== null;
      const ok = r.ok && judged && sit.expect.includes(answer) && !sit.avoid.includes(answer) && fieldsOk && affordable(r.choice, sit.state, catalog);
      const judgement = !judged ? 'recorded' : ok ? 'right' : 'wrong';
      runs.push({ answer, fields: r.choice?.fields ?? null, reason: r.reason ?? null, tokens: r.tokens ?? null, ms, affordable: r.ok ? affordable(r.choice, sit.state, catalog) : null, error: r.error ?? null, judgement, code: r.ok ? 'accepted' : 'refused (the autopilot plays free)' });
      if (judged) { total++; if (ok) right++; else wrong++; }
      if (!r.ok) refused++;
      console.log(`${sit.name}: ${answer}${r.choice?.fields ? ' ' + JSON.stringify(r.choice.fields) : ''} (${ms} ms) — ${judgement}${r.ok ? '' : ', refused by the code'}${r.reason ? ': ' + r.reason : ''}${r.error ? ': ' + r.error : ''}`);
    }
    const answers = runs.map(x => `${x.answer}${x.fields ? JSON.stringify(x.fields) : ''}`);
    report.situations.push({ name: sit.name, rules: sit.profile >= 3 ? 'S1' : 'MC', live: !!sit.live, expect: sit.expect, avoid: sit.avoid, state: sit.state, promptChars: JSON.stringify(prompt).length, prompt, autopilot: (await autopilot.decide(v))?.name ?? 'rest', runs, sameAnswerEveryTime: new Set(answers).size === 1 });
  }
  report.summary = { situationsJudged: total / Math.max(1, repeats), runsJudged: total, judgement: { right, wrong, note: 'the model\'s answers against the expectation; a refused answer counts as wrong' }, safety: { refusedByCode: refused, note: 'wrong answers the decider refused before the chain (Train n<1, unaffordable); the autopilot then plays free' }, live: situations.filter(s => s.live).length, repeats, variant, rules, byRules: Object.fromEntries(['MC', 'S1'].map(k => [k, (() => { const rs = report.situations.filter(x => x.rules === k && !x.live).flatMap(x => x.runs); return { right: rs.filter(x => x.judgement === 'right').length, judged: rs.length }; })()])) };
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const rows = report.situations.map(s => `| ${s.name} | ${s.expect ? s.expect.join('/') : '(live)'} | ${s.runs.map(r => `${r.answer ?? '?'}${r.fields ? ' ' + JSON.stringify(r.fields) : ''}`).join('; ')} | ${s.runs.map(r => r.judgement).join('; ')} | ${s.runs.map(r => r.code === 'accepted' ? 'accepted' : 'refused').join('; ')} | ${s.runs.map(r => r.ms).join('; ')} | ${s.autopilot} |`);
  const sm = report.summary;
  writeFileSync(path.join(outDir, 'report.md'), `# Decision bench — ${model.alias} (${variant}, ${repeats}×, rules ${rules})\n\n${model.modelPath ?? ''}; temperature 0, seed 7, JSON schema: ${model.settings.schema}.\n\nBy rules: MC ${sm.byRules.MC.right}/${sm.byRules.MC.judged}, S1 ${sm.byRules.S1.right}/${sm.byRules.S1.judged} right.\n\nThe model's judgement: ${sm.judgement.right} of ${sm.runsJudged} judged runs as a careful player would (a refused answer counts as wrong). The code's safety: ${sm.safety.refusedByCode} answer(s) refused before the chain; the autopilot plays free then.\n\n| situation | expected | model | judgement | code | ms | autopilot |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
  console.log(`bench (${variant}, ${repeats}×): judgement ${sm.judgement.right}/${sm.runsJudged} right; ${sm.safety.refusedByCode} refused by the code; ${path.join(outDir, 'report.json')}`);
}
if (asScript) await main();
