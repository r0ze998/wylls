#!/usr/bin/env node
// node bin/eval.mjs <scenario.json> [A|B|C …] [--full]
// Prints each ruleset's verdict summary (or the full verdict with --full).
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { summary } from '../src/summary.mjs';

const args = process.argv.slice(2);
const file = args.find(a => a.endsWith('.json'));
if (!file) { console.error('usage: node bin/eval.mjs <scenario.json> [A|B|C …] [--full]'); process.exit(2); }
const input = JSON.parse(readFileSync(file, 'utf8'));
const which = args.filter(a => /^[ABC]$/.test(a));
for (const k of which.length ? which : ['A', 'B', 'C']) {
  const v = evaluate(RULESETS[k], input);
  console.log(args.includes('--full') ? JSON.stringify(v, null, 1) : JSON.stringify(summary(v), null, 1));
}
