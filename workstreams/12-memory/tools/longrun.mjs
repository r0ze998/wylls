// Workstream 12: measure how the memory behaves as a continuing world grows (machine-dependent timings; not a
// test). Writes results/longrun.json.   node workstreams/12-memory/tools/longrun.mjs [N ...]
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { growWorld } from '../fixtures/longrun-world.mjs';
import { A, newMemory } from '../fixtures/scenario.mjs';

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const rows = [];
for (const n of sizes.length ? sizes : [250, 500, 1000, 2000, 4000]) {
  const dir = mkdtempSync(join(tmpdir(), 'm12lr-'));
  const path = join(dir, 'journal.jsonl');
  let t = performance.now();
  const { m, partitions } = growWorld(n, { path });
  const buildMs = performance.now() - t;
  t = performance.now();
  const again = newMemory({ path, partitions });
  const replayMs = performance.now() - t;
  t = performance.now();
  const k = again.knowledge(A, n * 200);
  const foldMs = performance.now() - t;
  const rel = k.reliability.B;
  rows.push({ partitions: n, world_bells: n * 200, records: m.journal.records().length, journal_bytes: statSync(path).size,
    build_ms: Math.round(buildMs), replay_ms: Math.round(replayMs), fold_ms: Math.round(foldMs),
    evidence_items: rel.evidence.length, E: rel.E, r: rel.r, s: rel.s });
  console.log(JSON.stringify(rows.at(-1)));
}
const out = { note: 'machine-dependent timings; correctness is asserted in test/longrun.test.mjs', node: process.version, cpu: cpus()[0]?.model ?? null, rows };
writeFileSync(new URL('../results/longrun.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
