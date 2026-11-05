#!/usr/bin/env node
// The minimal demo, in the local test world only (MOCK world, fixture
// provider: no chain, no model, no network, nothing billed).
//
//   node workstreams/13-citizens/demo/run-demo.mjs --out DIR [--bells 160] [--restart-at 70] [--crash after-submit]
//
// Two residents and two scripted people play `--bells` bells. With
// --restart-at every process-held object is dropped at that bell and rebuilt
// from the files (the world, the board, each resident, each person's key);
// with --crash the first resident throws at that point of its next decision
// and is reopened from its files. Writes DIR/summary.json and
// DIR/transcript.md.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertNoApiKeys } from '../../../permutation-gateway/citizens/mind/guards.mjs';
import { fixtureProvider } from '../resident/ports/provider.mjs';
import { openResident, openWorld } from '../world/harness.mjs';
import { makeOperator, people, writeCharters } from './scenario.mjs';
import { summarise, transcript } from './report.mjs';

function args(argv) {
  const o = { out: null, bells: 160, restartAt: null, crash: null, provider: 'goal' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--out') { o.out = v; i++; } else if (k === '--bells') { o.bells = Number(v); i++; } else if (k === '--restart-at') { o.restartAt = Number(v); i++; } else if (k === '--crash') { o.crash = v; i++; } else if (k === '--provider') { o.provider = v; i++; } else throw new Error(`unknown flag ${k}`);
  }
  if (!o.out) throw new Error('--out DIR is required');
  return o;
}

/** Opens (or reopens) every part of the run from `root`. */
export function openAll(root, operator, { provider = 'goal', crash = null, wrapMemory = null } = {}) {
  const w = openWorld(path.join(root, 'world'));
  const who = crash?.resident ?? 'asa';
  const asa = openResident(path.join(root, 'asa'), { world: w.world, board: w.board, provider: fixtureProvider({ mode: provider }), crash: who === 'asa' ? crash : null, wrapMemory });
  const ren = openResident(path.join(root, 'ren'), { world: w.world, board: w.board, provider: fixtureProvider({ mode: provider }), crash: who === 'ren' ? crash : null, wrapMemory });
  const ids = { asa: () => asa.state.citizen, ren: () => ren.state.citizen };
  const p = people(w.world, w.board, ids, root);
  return { ...w, asa, ren, ...p, operator };
}

/** `wrapMemory(port, resident)`: see world/harness.mjs openResident; applied at every (re)open, crash reopens included. */
export async function runDemo({ out, bells = 160, restartAt = null, crash = null, provider = 'goal', boundaries = [], wrapMemory = null }) {
  assertNoApiKeys(process.env);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const operator = makeOperator();
  writeCharters(out, operator);
  // --crash X stops Asa at X of its fourth decision; a test may pass {resident, at, turn?, key?} instead.
  let all = openAll(out, operator, { provider, crash: typeof crash === 'string' ? { at: crash, turn: 4 } : crash, wrapMemory });
  all.asa.setSiblings([all.ren.address]);
  all.ren.setSiblings([all.asa.address]);
  all.asa.fund('mock-deposit-asa-1', '400000');
  all.ren.fund('mock-deposit-ren-1', '400000');
  all.kou.join(); all.mio.join();
  const timeline = [];
  const restarts = [];
  for (let b = 0; b < bells; b++) {
    if (restartAt !== null && b === restartAt) {
      all.save();
      all = openAll(out, operator, { provider, wrapMemory });
      restarts.push({ bell: all.world.bell, why: 'every object rebuilt from files' });
    }
    for (const p of [all.kou, all.mio]) await p.act(all.world.bell);
    for (const r of [all.asa, all.ren]) {
      let res;
      try { res = await r.step(); }
      catch (e) {
        if (!String(e.message).startsWith('crash injected')) throw e;
        restarts.push({ bell: all.world.bell, resident: r.id, why: e.message });
        all.save();
        const dir = r.dir;
        const again = openResident(dir, { world: all.world, board: all.board, provider: fixtureProvider({ mode: provider }), wrapMemory });
        if (r === all.asa) all.asa = again; else all.ren = again;
        res = await again.step();
      }
      timeline.push({ resident: r.id, ...res });
    }
    // A boundary marker (test fixture) is public before the bell's actions land, like any event of the bell.
    if (boundaries.includes(all.world.bell)) all.world.operator.markBoundary(`test-boundary-${all.world.bell}`);
    all.world.operator.tick();
    all.save();
  }
  const summary = summarise(all, { restarts });
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(out, 'transcript.md'), transcript(all, summary));
  return { all, summary, timeline };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv);
  const { summary } = await runDemo(o);
  console.log(JSON.stringify(summary.mechanical, null, 2));
}
