// Shared set-up for the workstream-13 tests: a fresh directory, a world, residents and people.
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCharter } from '../resident/resident.mjs';
import { fixtureProvider } from '../resident/ports/provider.mjs';
import { openResident, openWorld, Person } from '../world/harness.mjs';
import { makeOperator } from '../demo/scenario.mjs';

export const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ws13-'));
export const ROOT = new URL('../../../', import.meta.url).pathname;
export const src = rel => readFileSync(path.join(ROOT, rel), 'utf8');

/** A small world: residents (by spec) and people, all joined. */
export async function small({ residents = [], people = [], dir = tmp() } = {}) {
  const operator = makeOperator();
  const w = openWorld(path.join(dir, 'world'));
  const rs = {};
  for (const r of residents) {
    createCharter(path.join(dir, r.id), { id: r.id, name: r.name ?? r.id, goal: r.goal ?? 'surplus-use', pos: r.pos, owner: { name: 'op', address: operator.address }, limits: r.limits, budget: r.budget });
    rs[r.id] = openResident(path.join(dir, r.id), { world: w.world, board: w.board, provider: r.provider ?? fixtureProvider(), crash: r.crash ?? null });
    rs[r.id].fund(`dep-${r.id}`, r.deposit ?? '1000000');
    await rs[r.id].step(); // joins
  }
  const ps = {};
  for (const p of people) { ps[p.name] = new Person({ ...p, world: w.world, board: w.board }); ps[p.name].join(); }
  return { dir, operator, ...w, rs, ps };
}

/** Runs `n` bells: people act, residents step, the world ticks. */
export async function run(env, n, { each = null } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    for (const p of Object.values(env.ps)) await p.act(env.world.bell);
    for (const r of Object.values(env.rs)) out.push({ id: r.id, ...(await r.step()) });
    if (each) await each(env);
    env.world.operator.tick();
  }
  return out;
}
