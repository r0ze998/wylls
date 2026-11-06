// node workstreams/14-central-tower/proto/batch.mjs [seeds]
// Runs every scenario × case over the seeds and writes results/RESULTS.json.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SCENARIOS, runScenario } from './compare.mjs';
import { DEFAULTS } from './model.mjs';

const n = Number(process.argv[2] ?? 30);
const seeds = Array.from({ length: n }, (_, i) => i + 1);
const out = { generatedBy: 'proto/batch.mjs', seeds: n, defaults: { ...DEFAULTS, rules: undefined }, scenarios: [] };
for (const sc of SCENARIOS) { out.scenarios.push(runScenario(sc, seeds)); process.stderr.write(`${sc.id} `); }
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'RESULTS.json'), JSON.stringify(out, null, 1) + '\n');
process.stderr.write('\n');
