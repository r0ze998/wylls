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
// A stopped run where nothing took place, said by every field: its attempts decided as no effect (expired, failed),
// no receipt, no fee open, not in flight.
const NOTHING = { attempts: VIEW.attempts.map((a, i) => ({ ...a, status: i ? 'failed' : 'expired' })), receipts: [], in_flight: false, fees: { charged: 5000, released: 5000, reserved: 0, unconfirmed: 0 } };
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
  assert.equal(fateOfRun(stopped('Failed', { ...NOTHING, effects: [], sent: false, outcome: { ...VIEW.outcome, effects: [] } })).fate, 'failed');
  assert.equal(fateOfRun(stopped('Expired', { ...NOTHING, effects: [], sent: false, outcome: null })).fate, 'failed');
  assert.equal(fateOfRun(stopped('Cancelled', { ...NOTHING, effects: [], sent: false, outcome: { ...VIEW.outcome, effects: [] } })).fate, 'cancelled');
  assert.equal(fateOfRun(stopped('Failed', { ...NOTHING, attempts: [], effects: [], sent: false, outcome: null })).fate, 'failed', 'no attempt at all');
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

// ---- R3 (workstream 16's audit; not observed in 157 real views): no effect listed, but traces of a send ------------
test('stopped with no effect listed but a trace of a send (attempt, fee, in_flight, receipt): unknown, never failed or cancelled', () => {
  const none = { effects: [], sent: false, outcome: { ...VIEW.outcome, effects: [] } };
  const with_ = (name, o) => [name, o];
  const traces = [
    ...['intent', 'sent', 'unknown', 'rejected', 'superseded', 'landed'].map(status => with_(`an attempt ${status}`, { ...NOTHING, attempts: [{ ...VIEW.attempts[1], status }] })),
    with_('fees.unconfirmed > 0', { ...NOTHING, fees: { ...NOTHING.fees, unconfirmed: 5000 } }),
    with_('fees.reserved > 0', { ...NOTHING, fees: { ...NOTHING.fees, reserved: 5000 } }),
    with_('in_flight', { ...NOTHING, in_flight: true }),
    with_('a receipt', { ...NOTHING, receipts: [VIEW.receipts[1]] }),
  ];
  for (const state of ['Failed', 'Expired', 'Cancelled']) {
    for (const [name, o] of traces) {
      const f = fateOfRun(stopped(state, { ...o, ...none }));
      assert.equal(f.fate, 'unknown', `${state}, ${name}`);
      assert.match(f.why, /a send may have taken effect/, `${state}, ${name}`);
    }
  }
});

test('R3 in a resident: a stopped run with an undecided attempt is held; the action is not handed over again', async () => {
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
  Object.assign(runs.get(first), stopped('Failed', { ...NOTHING, effects: [], sent: false, outcome: { ...VIEW.outcome, effects: [] }, attempts: [{ ...VIEW.attempts[1], status: 'sent' }], fees: { ...NOTHING.fees, reserved: 5000 } }), { run_id: first, spec: runs.get(first).spec });
  await run(env, 60);
  const action = JSON.stringify(runs.get(first).spec.action);
  assert.deepEqual([...new Set(accepts.filter(a => JSON.stringify(a.action) === action).map(a => a.run_id))], [first]);
  assert.ok(['sent', 'unresolved'].includes(ren.state.journal[first].state), ren.state.journal[first].state);
});

// ---- workstream 16's own R3 inputs (claude/dreamy-ramanujan-ijj8qj @ 82df9208, probes/fixtures/v16-r3-inputs.json):
// a real `runexec run view` (runexec from workstream 4 20db3313) edited into 12 stopped views with no effect listed
// but a trace of a send. Copied once into test/fixtures/ws16-r3-inputs.json.
const R3 = JSON.parse(readFileSync(new URL('./fixtures/ws16-r3-inputs.json', import.meta.url), 'utf8'));

test("workstream 16's 12 R3 inputs: none is read as failed or cancelled", () => {
  const cases = Object.entries(R3.cases);
  assert.equal(cases.length, 12);
  for (const [name, v] of cases) assert.equal(fateOfRun(v).fate, 'unknown', name);
});

// Workstream 16's 157 real views (fixtures/v16-real-views-20db3313.jsonl on the same commit), read in place when
// WS16_REAL_VIEWS points at the file: the safe-side rule changes none of them.
const REAL = process.env.WS16_REAL_VIEWS;
test("workstream 16's 157 real views: no real view reads as unknown because of R3", { skip: REAL ? false : 'set WS16_REAL_VIEWS' }, () => {
  const views = readFileSync(REAL, 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(x => x.view ?? x); // each line: {…, view}
  assert.equal(views.length, 157);
  const r3 = views.map(v => [v.run_id, v.state, fateOfRun(v)]).filter(([, , f]) => /a send may have taken effect/.test(f.why ?? ''));
  assert.deepEqual(r3, []);
  const noEffect = views.filter(v => ['Failed', 'Expired', 'Cancelled'].includes(v.state)).map(v => fateOfRun(v).fate).filter(f => f === 'failed' || f === 'cancelled');
  assert.ok(noEffect.length > 0, 'the real no-effect stops still read as failed / cancelled');
});
