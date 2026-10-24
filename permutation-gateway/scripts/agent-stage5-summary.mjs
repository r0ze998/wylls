// Stage 5's record tables (docs/agent-wallet/RUNBOOK-STAGE5-GEMMA4.ja.md §4) from the files the runbook writes, so
// nothing is copied by hand:
//
//   <dir>/bench-off/report.json, <dir>/bench-on/report.json    (agent-decision-bench.mjs)
//   <dir>/<run>/transcript.json                                 (agent-wallet-e2e.mjs, AGENT_E2E_OUT)
//   <dir>/<run>/finalized.json                                  (agent-finalized-count.mjs)
//   <dir>/<run>/verify.txt                                      (frontier-stack verify)
//   <dir>/<run>/season.json                                     (the herald's /h/season: which ruleset the season runs)
//
//   node permutation-gateway/scripts/agent-stage5-summary.mjs [--dir .local/stage5] > .local/stage5/summary.md
//
// Which schema a run had is read from the files (the bench's model.settings.schema, the relay's terms.runner.schema),
// never from the directory's name. Which model answered is the llama-server's own model_path, not the alias (the
// pinned script names every model gemma-4-26b-a4b-it). A missing file is said in the table, not filled in.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PRESETS as V2 } from '../client/src/frontier/abi-v2-presets.mjs';
import { PRESETS as V1 } from '../client/src/frontier/abi-presets.mjs';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const dir = path.resolve(arg('dir') ?? '.local/stage5');
const read = f => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const usdc = base => (base == null ? '—' : (Number(base) / 1e6).toFixed(2));
const or = (v, d = '—') => (v == null ? d : v);
const models = new Set();
/** Which rules a season runs, from the ruleset hash the herald reports (never from the run's name). */
const seasonKind = file => {
  const j = read(file);
  if (!j) return '(no season.json)';
  const h = String(JSON.stringify(j).match(/"rulesetHash":"([0-9a-f]{64})"/)?.[1] ?? '');
  return h === V2.ruleset_hash_v3 ? 'S1' : h === V2.ruleset_hash ? 'MC' : h === V1.ruleset_hash ? 'M1' : `? (${h.slice(0, 8) || 'no hash'})`;
};
const out = [`# Stage 5 summary (${dir})`, ''];

// ---- the decision bench
const benches = readdirSync(dir).map(d => path.join(dir, d, 'report.json')).map(f => ({ f, r: read(f) })).filter(x => x.r?.mode === 'agent-decision-bench');
out.push('## Decision bench', '', '| dir | schema | judgement (right / judged) | refused by the code | same answer every time (situations) | median ms per call | repeats |', '|---|---|---|---|---|---|---|');
for (const { f, r } of benches) {
  models.add(r.model?.modelPath ?? '(model path not reported)');
  const runs = r.situations.flatMap(s => s.runs ?? []);
  const same = r.situations.filter(s => s.sameAnswerEveryTime).length;
  out.push(`| ${path.basename(path.dirname(f))} | ${r.model?.settings?.schema ?? '?'} | ${r.summary.judgement.right} / ${r.summary.runsJudged} | ${r.summary.safety.refusedByCode} | ${same} / ${r.situations.length} | ${or(median(runs.map(x => x.ms)))} | ${r.repeats} |`);
}
if (!benches.length) out.push('| (no bench report found) | | | | | | |');

// ---- the live windows
const runs = readdirSync(dir).filter(d => statSync(path.join(dir, d)).isDirectory() && existsSync(path.join(dir, d, 'transcript.json'))).sort();
out.push('', '## Live windows', '', '"Sent by the model" and the counts beside it are the E2E\'s measurement window; "finalized (whole run)" asks the chain about every action the model chose over the agent\'s whole history (agent-finalized-count.mjs), so it can be larger.', '',
  '| run | season | schema | E2E checks | calls | decision fees (test USDC) | sent by the model | finalized (whole run) | failed on chain (whole run) | refused by the code | rests | autopilot standing in | verifier |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const run of runs) {
  const t = read(path.join(dir, run, 'transcript.json'));
  const fin = read(path.join(dir, run, 'finalized.json'));
  const verify = existsSync(path.join(dir, run, 'verify.txt')) ? readFileSync(path.join(dir, run, 'verify.txt'), 'utf8') : null;
  models.add(t.model?.modelPath ?? '(model path not reported)');
  const checks = t.checks ?? [];
  const w = t.window ?? {}, b = w.breakdown ?? {};
  const f = Array.isArray(fin) ? fin.reduce((a, x) => ({ checked: a.checked + x.modelSentChecked, finalized: a.finalized + x.finalized, failed: a.failed + x.failedOnChain, other: a.other + x.notFound + x.notYetFinal }), { checked: 0, finalized: 0, failed: 0, other: 0 }) : null;
  const verdict = verify ? (/\*\*PASS\*\*|verify: PASS/.test(verify) ? 'PASS' : /FAIL/.test(verify) ? 'FAIL' : '?') : '(no verify.txt)';
  out.push(`| ${run} | ${seasonKind(path.join(dir, run, 'season.json'))} | ${t.terms?.runner?.schema ?? '(not reported)'} | ${checks.filter(c => c.ok).length}/${checks.length}${t.finishedAt ? '' : ' (unfinished)'} | ${or(w.modelCalls)} | ${usdc(w.costBaseUnits)} | ${or(b.modelActionsSent)} | ${f ? `${f.finalized}/${f.checked}${f.other ? ` (${f.other} not found or not final)` : ''}` : '(no finalized.json)'} | ${f ? f.failed : '—'} | ${or(b.callsRefusedByCode)} | ${or(b.rests)} | ${or(b.autopilotActionsFree)} | ${verdict} |`);
}
if (!runs.length) out.push('| (no run found) | | | | | | | | | | | | |');

// ---- which model answered
out.push('', '## The model file the llama-server loaded', '', ...[...models].map(m => `- \`${m}\`${/gemma-4/i.test(m) ? '' : ' — **not a Gemma 4 file: these numbers are not stage 5\'s**'}`), '');
console.log(out.join('\n'));
