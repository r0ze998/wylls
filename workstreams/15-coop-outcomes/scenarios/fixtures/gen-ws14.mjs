#!/usr/bin/env node
// Regenerates scenarios/fixtures/ws14-7d7f2143.json from ⑭'s own code. ⑭'s
// files are not in this branch; extract them first (read only, nothing of ⑭
// is changed):
//   git archive 7d7f2143d6f2696a3bc323d1d619b1d6961a7b18 workstreams/14-central-tower | tar -x -C <dir>
//   node workstreams/15-coop-outcomes/scenarios/fixtures/gen-ws14.mjs <dir>/workstreams/14-central-tower
// Output: ⑭'s real `toFacts(sim)` for cases B and C, and the `period.boundary`
// facts of the same run (toFacts leaves those out).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '');
const { createSim, run } = await import(`${dir}/proto/model.mjs`);
const { toFacts } = await import(`${dir}/proto/adapters.mjs`);
export const PARAMS = { seed: 1, days: 10, periodHours: 72 };
const out = {
  source: {
    repo: 'r0ze998/wylls', branch: 'preserve/ws14-7d7f2143', commit: '7d7f2143d6f2696a3bc323d1d619b1d6961a7b18',
    code: 'workstreams/14-central-tower/proto/model.mjs createSim/run, proto/adapters.mjs toFacts',
    params: PARAMS, note: 'Produced by ⑭\'s model: simulation facts, not chain records. periodHours is ⑭\'s placeholder (undecided).',
  },
};
for (const c of ['B', 'C']) {
  const sim = createSim({ ...PARAMS, case: c });
  run(sim);
  out[c] = { facts: toFacts(sim), boundaries: sim.facts.filter(x => x.kind === 'period.boundary') };
}
writeFileSync(new URL('./ws14-7d7f2143.json', import.meta.url), `${JSON.stringify(out)}\n`);
console.log('B', out.B.facts.events.length, 'C', out.C.facts.events.length);
