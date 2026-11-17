// Workstream 4's run states behind the resident's execution port. The state list and the terminal set are read from
// workstream 4's own source (workstreams/04-execution/src/model.rs), so a change there fails here. The client is a
// FAKE in memory (workstream 4 has no endpoint for the resident yet); the resident's behaviour on top is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { small, run } from './helpers.mjs';
import { fateOfRun, WS04_STATES, WS04_TERMINAL, ws04ExecutionPort } from '../resident/ports/ws04-run.mjs';
import { assertPort } from '../resident/ports/execution.mjs';

// A FIXTURE requester (what a credential layer would hand over; nothing here authenticates anyone).
const FIXTURE_REQUESTER = { actor: '1'.repeat(31) + 'A', generation: 1, citizen: '1'.repeat(31) + 'C', authenticatedBy: 'test fixture: no credential layer' };
const requesterOf = () => FIXTURE_REQUESTER;

const MODEL = readFileSync(new URL('../../04-execution/src/model.rs', import.meta.url), 'utf8');

test('the state list and terminal set are workstream 4\'s (model.rs RunState::ALL, terminal())', () => {
  const all = /pub const ALL: \[RunState; (\d+)\] = \[([^\]]+)\]/s.exec(MODEL);
  assert.ok(all);
  const names = all[2].split(',').map(x => x.trim()).filter(Boolean);
  assert.equal(Number(all[1]), names.length);
  assert.deepEqual(WS04_STATES, names);
  const term = /pub fn terminal\(self\) -> bool \{\s*matches!\(\s*self,\s*([^)]+)\)/s.exec(MODEL);
  assert.deepEqual([...WS04_TERMINAL].sort(), term[1].split('|').map(x => x.trim()).sort());
});

test('mapping: took effect, pending, stopped with and without effects, held, unknown, absent', () => {
  const f = v => fateOfRun(v)?.fate ?? null;
  assert.equal(fateOfRun(null), null);
  for (const s of ['InTransit', 'Arrived', 'Fulfilled', 'Partial', 'DeliveredUnverified']) assert.equal(f({ state: s }), 'landed', s);
  for (const s of ['Accepted', 'Reserved', 'FacilityRequested', 'FacilitySubmitted', 'FacilityConfirmed', 'ShipRequested', 'ShipSubmitted']) assert.equal(f({ state: s }), 'pending', s);
  assert.equal(f({ state: 'Failed' }), 'failed');
  assert.equal(f({ state: 'Expired' }), 'failed');
  assert.equal(f({ state: 'Cancelled' }), 'cancelled');
  assert.equal(f({ state: 'Cancelled', outcome: { effects: [{ kind: 'caravan_sent' }] } }), 'landed', 'cancelled after the caravan left: it took effect');
  assert.equal(f({ state: 'Failed', outcome: { effects: [{}] } }), 'landed');
  assert.equal(f({ state: 'ShipSubmitted', held_reason: 'port_errors' }), 'unknown');
  assert.equal(f({ state: 'Gone' }), 'unknown');
  assert.equal(fateOfRun({ state: 'Partial' }).partial, true);
  assert.equal(fateOfRun({ state: 'DeliveredUnverified' }).unverified, true);
});

/** A fake workstream 4: runs by run_id, idempotent by spec; `step()` advances every open run one state. */
function fake4({ unavailable = () => false } = {}) {
  const runs = new Map();
  const path = ['Accepted', 'Reserved', 'ShipRequested', 'ShipSubmitted', 'InTransit', 'Arrived', 'Fulfilled'];
  return {
    runs,
    async accept(spec) {
      const r = runs.get(spec.run_id);
      if (r) return JSON.stringify(r.spec) === JSON.stringify(spec) ? { kind: 'existing', run: r } : { kind: 'conflict' };
      runs.set(spec.run_id, { spec, state: 'Accepted', outcome: { effects: [] } });
      return { kind: 'accepted' };
    },
    async run(id) { if (unavailable(id)) throw new Error('workstream 4 unavailable'); const r = runs.get(id); return r ? { state: r.state, outcome: r.outcome } : null; },
    step() { for (const r of runs.values()) { const i = path.indexOf(r.state); if (i >= 0 && i < path.length - 1) r.state = path[i + 1]; } },
  };
}
const specOf = req => ({ owner: 'fixture-owner-tag', action: req.action });

test('the port: kept for good, same key replays, another spec under the key is a conflict', async () => {
  const c = fake4();
  const port = ws04ExecutionPort(c, { specOf, requesterOf });
  assert.ok(assertPort('execution', port));
  const req = { idempotencyKey: 'ren:t1:1', action: { name: 'SendCaravan', fields: { to: 'c2', goods: { Food: 40 } } } };
  assert.equal((await port.submit(req)).status, 'sent');
  assert.equal((await port.submit(req)).replayed, true);
  assert.equal((await port.submit({ ...req, action: { name: 'Build', fields: { item: 1 } } })).error.code, 'IdempotencyConflict');
  assert.equal((await port.status('ren:t1:1')).fate, 'pending');
  assert.equal(await port.status('never'), null);
  assert.deepEqual(await port.cancel('ren:t1:1'), { cancelled: false, reason: 'NotSupported' });
});

test('a resident on the fake workstream 4: pending until the caravan leaves, then landed; unavailable reads are waited out', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  let down = 0;
  const c = fake4({ unavailable: () => down > 0 });
  ren.ports.execution = ws04ExecutionPort(c, { specOf, requesterOf });
  await run(env, 1, { each: () => { c.step(); } });
  const it = Object.values(ren.state.journal).find(j => j.action);
  assert.ok(it, 'the resident sent through workstream 4');
  down = 3;
  for (let i = 0; i < 6; i++) { await run(env, 1, { each: () => { if (down > 0) down--; } }); }
  for (let i = 0; i < 12; i++) await run(env, 1, { each: () => c.step() });
  assert.equal(ren.state.journal[it.key].state, 'landed');
  assert.equal([...c.runs.keys()].filter(k => k === it.key).length, 1, 'one run for the key');
  assert.equal(ren.state.counters.actions >= 1, true);
});
