// Workstream 12 demo: the same second request replayed over seven histories (deterministic reference policy).
//   node workstreams/12-memory/demo/run-demo.mjs [--json OUT]
// Deterministic (no network, no clock, no randomness): the output files are byte-identical across runs.
// This shows what the code-made rule does with the evidence. It is not evidence that a language model would
// understand the memory, nor that people find the result interesting.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ARMS, A, SECOND_BELL, runArm } from '../fixtures/scenario.mjs';
import { renderBlock, summarize } from '../src/index.mjs';
import { canonical, sha256hex } from '../src/records.mjs';
import { reliabilityOf } from '../src/fold.mjs';

const inputs = {};
const out = { contract: 'wylls.memory12.demo/v4', policy: 'reference-v4 (deterministic; not a language model)', bell: SECOND_BELL, arms: {} };
for (const name of Object.keys(ARMS)) {
  const { m, ids, res, reassessed } = await runArm(name);
  const k = m.knowledge(A, SECOND_BELL);
  const rel = reliabilityOf(k, 'B');
  out.arms[name] = {
    first_exchange: ids,
    commitments: k.commitments.map(c => ({ id: c.id, debtor: c.debtor, state: c.state, reasons: c.reasons, coverage_gaps: c.coverage_gaps, delivered: [c.delivered_min, c.delivered_max],
      credit: c.links.map(l => l.credit),
      claims: c.claims.map(x => ({ id: x.id, kind: x.kind, status: x.status, criterion: x.criterion, basis: x.basis })),
      authority: c.authority, contract: c.contract, sources: c.sources })),
    reliability_B: { E: rel.E, r: rel.r, s: rel.s, verified: rel.verified, claims: rel.claims, unresolved: rel.unresolved.length },
    choice: res.answer.choice, without_memory: res.explanation.without_memory, memory_changed_choice: res.explanation.memory_changed_choice,
    memory_delta: res.explanation.memory_delta, cite: res.answer.cite, why: res.answer.why, terms: res.explanation.terms, ineligible: res.explanation.ineligible,
    memory_block: renderBlock(summarize(k)),
    reassessed,
    decision_input_sha256: sha256hex(canonical(res.input)),
  };
  inputs[name] = res.input;
  const a = out.arms[name];
  console.log(`\n== ${name}`);
  console.log(`   B: E=${rel.E} (r=${rel.r}, s=${rel.s}); verified ${JSON.stringify(rel.verified)}; claims ${JSON.stringify(rel.claims)}; unresolved ${rel.unresolved.length}`);
  for (const [id, t] of Object.entries(a.terms)) console.log(`   ${id.padEnd(8)} goods ${t.goods} + travel ${t.travel} + risk ${t.risk} (E=${t.E}) + caution ${t.caution} = ${t.cost}`);
  for (const x of a.ineligible) console.log(`   ${x.id.padEnd(8)} ineligible: ${x.reason}`);
  console.log(`   -> ${a.choice}  (without memory: ${a.without_memory}; memory changed the choice: ${a.memory_changed_choice})`);
  console.log(`   cites ${a.cite.join(', ') || '(none)'}`);
  if (a.memory_block) console.log(a.memory_block.split('\n').map(l => `   ${l}`).join('\n'));
  if (reassessed) {
    console.log(`   reassessed with records observed by bell ${reassessed.observed_by}: reference choice ${reassessed.reference_then} -> ${reassessed.reference_now}`
      + ` (late arrivals used ${reassessed.late_arrivals.length}, later events not used ${reassessed.later_events.length}, backdated excluded ${reassessed.backdated.length}; `
      + `original input reproducible: ${reassessed.then_reproducible})`);
    for (const c of reassessed.changed_commitments) console.log(`     ${c.commitment}: ${c.then} -> ${c.now}`);
  }
}
const i = process.argv.indexOf('--json');
if (i > 0) {
  writeFileSync(process.argv[i + 1], `${JSON.stringify(out, null, 1)}\n`);
  // the exact inputs a model provider (workstream 5) would receive, one file per arm
  const dir = join(dirname(process.argv[i + 1]), 'inputs');
  mkdirSync(dir, { recursive: true });
  for (const [n, input] of Object.entries(inputs)) writeFileSync(join(dir, `${n}.json`), `${JSON.stringify(input, null, 1)}\n`);
}
console.log(`\ndemo sha256 ${sha256hex(canonical(out))}`);
