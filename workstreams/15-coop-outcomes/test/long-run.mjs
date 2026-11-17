// Long-run check, separate from passing a boundary: a world that never ends
// over many evaluation windows. Records, per block of windows, the time to
// judge a window and the size of the saved world; checks the goods balance
// at every boundary and a restart at every 10th. Writes results/long-run.json.
// Run: node workstreams/15-coop-outcomes/test/long-run.mjs [windows]
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { longWorld } from '../scenarios/long.mjs';
import { evaluateSeries } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { normalize } from '../src/ledger.mjs';
import { buildWorld, snapshotOf, PATH_KEEP } from '../src/world.mjs';

export function runLong(windows) {
  const input = longWorld({ windows });
  const t = performance.now();
  const s = evaluateSeries(RULESETS.B, input, { restartCheck: 10 });
  const total = performance.now() - t;
  // Size of the saved world at a few points (the world's state, not its event log).
  const norm = normalize(input.events, input.state.streams);
  const sizes = [];
  for (const k of [Math.floor(windows / 4), Math.floor(windows / 2), windows - 1]) {
    const W = buildWorld({ state: input.state, events: norm.events.filter(e => e.at < input.windows[k].endsAt), costs: RULESETS.B.costs, jointGoals: {} });
    const snap = snapshotOf(W);
    const parts = Object.fromEntries(Object.entries(snap).map(([key, v]) => [key, JSON.stringify(v).length]).filter(([, n]) => n > 4000));
    sizes.push({ window: k, bytes: JSON.stringify(snap).length, parts, lots: snap.lots.length, emptyLots: snap.lots.filter(l => l.qty === 0).length, ships: snap.ships.length, keepHistory: snap.keepHistory.length, maxPath: Math.max(...snap.lots.map(l => l.path.length)) });
  }
  return { windows, events: input.events.length, totalMs: Math.round(total), perWindowMs: Math.round(total / windows * 10) / 10, sizes, boundaries: s.boundaries.length, allBalanced: s.boundaries.every(b => b.balanced), restartChecked: s.boundaries.filter(b => b.restartMatches !== null).length, restartAllMatch: s.boundaries.every(b => b.restartMatches !== false), achievedBuilds: s.verdicts.flatMap(v => v.achievements.national).filter(n => n.status === 'achieved').length };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const small = runLong(40);
  const large = runLong(Number(process.argv[2] ?? 160));
  const out = { note: 'Local measurement on this machine (Node, no chain). Judging a window resumes from the latest checkpoint, so it does not replay the history; its cost still grows with the saved world (completed projects with their inputs, lot aliases, settled ids; see parts). Goods in the live state are bounded by holders x resources x origins.', PATH_KEEP, small, large, perWindowRatio: Math.round(large.perWindowMs / small.perWindowMs * 100) / 100 };
  writeFileSync(new URL('../results/long-run.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify(out, null, 1));
  assert.ok(small.allBalanced && large.allBalanced, 'goods balance at every boundary');
  assert.ok(small.restartAllMatch && large.restartAllMatch, 'restart matches at the checked boundaries');
  assert.ok(large.sizes.every(s => s.maxPath <= PATH_KEEP + 1), 'paths stay bounded');
  // Not constant (stored history still grows: completed projects with their inputs, id aliases; see
  // docs/07); the check is that judging a window no longer replays the whole history.
  const historyRatio = large.windows / small.windows;
  assert.ok(out.perWindowRatio < historyRatio, `time per window grew ${out.perWindowRatio}x for ${historyRatio}x the history`);
}
