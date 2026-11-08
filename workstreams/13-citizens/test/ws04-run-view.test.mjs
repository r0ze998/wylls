// A stopped run's view whose effect fields disagree (a defensive review of the run port; not observed in
// workstream 4 cf517b55, whose view builds both effect lists from the same facts).
// The fixture test/fixtures/ws04-run-view-happy.json is a real `runexec run view` (p04-run/0.1) of runexec's own
// demo-happy run (runexec built from 7d2fbe0d, whose src/view.rs is cf517b55's), copied once and only edited here.
// Rule checked: a contradictory view is unknown (held: never sent again, never claimed as landed); a consistent one
// keeps its meaning; an unknown view_version is not interpreted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { small, run } from './helpers.mjs';
import { fateOfRun, ws04ExecutionPort } from '../resident/ports/ws04-run.mjs';

const VIEW = JSON.parse(readFileSync(new URL('./fixtures/ws04-run-view-happy.json', import.meta.url), 'utf8'));
const stopped = (state, o) => ({ ...VIEW, state, terminal: true, ...o });
const SENT = ['facility_used', 'caravan_sent'], SENT_OUT = ['facility_used fac:demo-happy', 'caravan_sent cv:77:0'];

test('the fixture is a real p04-run/0.1 view and reads as landed', () => {
  assert.equal(VIEW.view_version, 'p04-run/0.1');
  assert.equal(VIEW.state, 'Fulfilled');
  assert.equal(fateOfRun(VIEW).fate, 'landed');
});

test('stopped with contradictory effect fields: unknown, never failed', () => {
  const cases = [
    ['Failed: effects [] but outcome.effects has caravan_sent', stopped('Failed', { effects: [], sent: false, outcome: { ...VIEW.outcome, effects: ['caravan_sent cv:77:0'] } })],
    ['Expired: the same', stopped('Expired', { effects: [], sent: false, outcome: { ...VIEW.outcome, effects: ['caravan_sent cv:77:0'] } })],
    ['Failed: sent true, no effects anywhere', stopped('Failed', { effects: [], sent: true, outcome: null })],
    ['Expired: effects has caravan_sent, sent false', stopped('Expired', { effects: ['caravan_sent'], sent: false, outcome: null })],
    ['Cancelled: outcome.effects has caravan_sent, effects only facility_used', stopped('Cancelled', { effects: ['facility_used'], sent: false, outcome: { ...VIEW.outcome, effects: SENT_OUT } })],
  ];
  for (const [name, v] of cases) {
    const f = fateOfRun(v);
    assert.equal(f.fate, 'unknown', name);
    assert.match(f.why, /contradictory run view/, name);
  }
});

test('stopped with consistent fields keeps its meaning: effects → landed; none → failed / cancelled', () => {
  assert.deepEqual([fateOfRun(stopped('Failed', { effects: SENT, sent: true, outcome: { ...VIEW.outcome, effects: SENT_OUT } })).fate], ['landed']);
  assert.equal(fateOfRun(stopped('Failed', { effects: [], sent: false, outcome: { ...VIEW.outcome, effects: [] } })).fate, 'failed');
  assert.equal(fateOfRun(stopped('Expired', { effects: [], sent: false, outcome: null })).fate, 'failed');
  assert.equal(fateOfRun(stopped('Cancelled', { effects: [], sent: false, outcome: { ...VIEW.outcome, effects: [] } })).fate, 'cancelled');
  // a facility used but no caravan, said the same by every field: something took place (landed), not a contradiction
  assert.equal(fateOfRun(stopped('Failed', { effects: ['facility_used'], sent: false, outcome: { ...VIEW.outcome, effects: ['facility_used fac:demo-happy'] } })).fate, 'landed');
});

test('an unknown view_version is not interpreted', () => {
  const f = fateOfRun({ ...VIEW, view_version: 'p04-run/0.2' });
  assert.equal(f.fate, 'unknown');
  assert.match(f.why, /unknown run view version/);
});

test('a resident reading such a view does not act again: one accept for the action, the line held', async () => {
  const accepts = [], runs = new Map();
  const c = {
    async accept(spec) { accepts.push(spec); if (!runs.has(spec.run_id)) runs.set(spec.run_id, { ...VIEW, run_id: spec.run_id, spec, state: 'Accepted', terminal: false, effects: [], sent: false, outcome: null }); return { ...runs.get(spec.run_id), accept: 'Created' }; },
    async view(id) { const r = runs.get(id); if (!r) throw Object.assign(new Error('no record'), { code: 'NoRecord' }); return r; },
  };
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  ren.ports.execution = ws04ExecutionPort(c, { specOf: req => ({ owner: 119, action: req.action }), requesterOf: () => ({ actor: '1'.repeat(32), generation: 1, citizen: '1'.repeat(32), authenticatedBy: 'test fixture' }) });
  await run(env, 1);
  const first = [...runs.keys()][0];
  // the run stops; its view says a caravan left in outcome.effects but not at the top
  Object.assign(runs.get(first), { state: 'Expired', terminal: true, effects: [], sent: false, outcome: { ...VIEW.outcome, effects: ['caravan_sent cv:77:0'] } });
  await run(env, 60);
  const action = JSON.stringify(runs.get(first).spec.action);
  const same = accepts.filter(a => JSON.stringify(a.action) === action).map(a => a.run_id);
  assert.deepEqual([...new Set(same)], [first], `the same action was handed to workstream 4 only under its first key (${same})`);
  assert.equal(accepts.filter(a => a.run_id === first).length, 1, 'submitted once');
  assert.ok(['sent', 'unresolved'].includes(ren.state.journal[first].state), `held: ${ren.state.journal[first].state}`);
});
