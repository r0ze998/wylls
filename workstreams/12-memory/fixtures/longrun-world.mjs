// Workstream 12: a growing continuing world for the long-run test and tools/longrun.mjs.
import { PLACE_A, newMemory, promise, caravanFacts, allocate, coverage } from './scenario.mjs';

/** n partitions of 200 world bells; in each, B promises A 100 wood and delivers it (every 10th: not sent, proven). */
export function growWorld(n, { path = null, decisionsEvery = 0 } = {}) {
  const partitions = {};
  for (let i = 1; i <= n; i++) partitions[`p${i}`] = { program: 'FrontierFixtureProgram111111111111111111111', season: i };
  const m = newMemory({ path, partitions });
  const decisions = [];
  for (let i = 1; i <= n; i++) {
    const base = (i - 1) * 200, part = `p${i}`, place = { ...PLACE_A, partition: part };
    const p = promise(m, { bell: base + 10, due: base + 60, place, text: false });
    if (i % 10 === 0) coverage(m, { partition: part, from: base, to: base + 199, bell: base + 199 });
    else {
      allocate(m, { ref: p.accept, partition: part, seq: 1, bell: base + 12 });
      caravanFacts(m, { dst: place, seq: 1, depart: base + 12, settle: base + 40 });
    }
    if (decisionsEvery && i % decisionsEvery === 0) decisions.push({ bell: base + 199 });
  }
  return { m, partitions, decisions };
}
