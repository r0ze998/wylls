// Workstream 12 demo: the same second request replayed over five histories.
//   node workstreams/12-memory/demo/run-demo.mjs [--json OUT]
// Deterministic (no network, no clock, no randomness): the output file is byte-identical across runs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ARMS, A, SECOND_BELL, runArm } from '../fixtures/scenario.mjs';
import { renderBlock, summarize } from '../src/index.mjs';
import { canonical, sha256hex } from '../src/records.mjs';

const inputs = {};
const out = { contract: 'wylls.memory12.demo/v1', bell: SECOND_BELL, arms: {} };
for (const name of Object.keys(ARMS)) {
  const { m, ids, res } = await runArm(name);
  const k = m.knowledge(A, SECOND_BELL);
  out.arms[name] = {
    first_exchange: ids,
    commitments: k.commitments.map(c => ({ id: c.id, debtor: c.debtor, state: c.state, false_claim: c.false_claim, authority: c.authority, contract: c.contract, sources: c.sources })),
    reliability_B: k.reliability.B ? { E: k.reliability.B.E, r: k.reliability.B.r, s: k.reliability.B.s } : { E: 0.5, r: 0, s: 0 },
    choice: res.answer.choice, without_memory: res.explanation.without_memory, memory_changed_choice: res.explanation.memory_changed_choice,
    cite: res.answer.cite, why: res.answer.why, terms: res.explanation.terms, ineligible: res.explanation.ineligible,
    memory_block: renderBlock(summarize(k)),
    decision_input_sha256: sha256hex(canonical(res.input)),
  };
  inputs[name] = res.input;
  const a = out.arms[name];
  console.log(`\n== ${name}`);
  console.log(`   B reliability E=${a.reliability_B.E} (r=${a.reliability_B.r}, s=${a.reliability_B.s})`);
  for (const [id, t] of Object.entries(a.terms)) console.log(`   ${id.padEnd(8)} goods ${t.goods} + travel ${t.travel} + risk ${t.risk} (E=${t.E}) = ${t.cost}`);
  for (const x of a.ineligible) console.log(`   ${x.id.padEnd(8)} ineligible: ${x.reason}`);
  console.log(`   -> ${a.choice}  (without memory: ${a.without_memory}; memory changed the choice: ${a.memory_changed_choice})`);
  console.log(`   cites ${a.cite.join(', ') || '(none)'}`);
  if (a.memory_block) console.log(a.memory_block.split('\n').map(l => `   ${l}`).join('\n'));
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
