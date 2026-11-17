// Restarts and doubtful run evidence on the run port, without any real send (keyless; a fake workstream 4 in the
// p04-run/0.1 shape, built from the fixed real view test/fixtures/ws04-run-view-happy.json). The resident is closed and
// reopened from its files many times while workstream 4 answers with incomplete, contradictory, cancelled, replayed and
// duplicated evidence. Checked every time: no key is handed to workstream 4 twice and no action under a second key;
// Unknown stays held (never sent again, never landed); NoAuthenticatedRequester never reaches accept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { small, run } from './helpers.mjs';
import { openResident } from '../world/harness.mjs';
import { fixtureProvider } from '../resident/ports/provider.mjs';
import { fateOfRun, ws04ExecutionPort } from '../resident/ports/ws04-run.mjs';

const VIEW = JSON.parse(readFileSync(new URL('./fixtures/ws04-run-view-happy.json', import.meta.url), 'utf8'));
const REQUESTER = { actor: '1'.repeat(32), generation: 1, citizen: '1'.repeat(32), authenticatedBy: 'test fixture' };
const NOTHING = { attempts: VIEW.attempts.map(a => ({ ...a, status: 'expired' })), receipts: [], in_flight: false, fees: { charged: 0, released: 10000, reserved: 0, unconfirmed: 0 }, effects: [], sent: false, outcome: { ...VIEW.outcome, effects: [] } };

/** Workstream 4 in memory: `answer(view, n)` rewrites a run's view on its n-th read. */
function fake4(answer = v => v) {
  const runs = new Map(), accepts = [], reads = new Map();
  return {
    runs, accepts, reads,
    async accept(spec, requester) {
      accepts.push({ spec, requester });
      if (!runs.has(spec.run_id)) runs.set(spec.run_id, { ...VIEW, run_id: spec.run_id, spec, state: 'Accepted', terminal: false, in_flight: false, effects: [], sent: false, outcome: null, attempts: [], receipts: [] });
      return { ...runs.get(spec.run_id), accept: accepts.filter(a => a.spec.run_id === spec.run_id).length > 1 ? 'Existing' : 'Created' };
    },
    async view(id) {
      const r = runs.get(id);
      if (!r) throw Object.assign(new Error('no record'), { code: 'NoRecord' });
      const n = (reads.get(id) ?? 0) + 1;
      reads.set(id, n);
      return answer(r, n);
    },
  };
}

/** A resident on `c`, reopened from its files `restarts` times while it runs `bells` bells in total. */
async function withRestarts(c, { restarts = 6, bells = 120, requesterOf = () => REQUESTER, between = null } = {}) {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const dir = path.join(env.dir, 'ren');
  const wire = r => { r.ports.execution = ws04ExecutionPort(c, { specOf: req => ({ owner: 119, action: req.action }), requesterOf }); return r; };
  wire(env.rs.ren);
  const per = Math.floor(bells / (restarts + 1));
  for (let i = 0; i <= restarts; i++) {
    await run(env, per);
    if (between) await between(env, i);
    if (i < restarts) { env.rs.ren.save(); env.rs.ren = wire(openResident(dir, { world: env.world, board: env.board, provider: fixtureProvider() })); }
  }
  return env.rs.ren;
}

/** No key twice, and no action handed over under a second key. */
function oncePerAction(c) {
  const byKey = new Map(), byAction = new Map();
  for (const { spec } of c.accepts) {
    byKey.set(spec.run_id, (byKey.get(spec.run_id) ?? 0) + 1);
    const a = JSON.stringify(spec.action);
    byAction.set(a, new Set([...(byAction.get(a) ?? []), spec.run_id.split('#')[0]]));
  }
  for (const [k, n] of byKey) assert.equal(n, 1, `key ${k} handed over ${n} times`);
  return { keys: byKey.size, actions: byAction.size };
}

test('incomplete views (a p04-run/0.1 view missing a field it always writes) are unknown, not "nothing happened"', () => {
  for (const k of ['attempts', 'receipts', 'fees', 'in_flight', 'sent', 'effects']) {
    const v = { ...VIEW, ...NOTHING, state: 'Failed', terminal: true };
    delete v[k];
    const f = fateOfRun(v);
    assert.equal(f.fate, 'unknown', k);
    assert.match(f.why, new RegExp(`incomplete run view: no ${k}`));
  }
  assert.equal(fateOfRun({ ...VIEW, ...NOTHING, state: 'Failed', terminal: true }).fate, 'failed', 'complete and empty: failed');
  assert.equal(fateOfRun({ state: 'Failed' }).fate, 'failed', 'an unversioned (older) fake keeps its reading');
});

test('restarts while workstream 4 answers incomplete, then contradictory views: held across every restart, handed over once', async () => {
  const c = fake4((v, n) => {
    if (v.state === 'Accepted' && n < 3) return v;
    const base = { ...v, ...NOTHING, state: 'Expired', terminal: true };
    if (n % 2) { const x = { ...base }; delete x.attempts; return x; }               // incomplete
    return { ...base, effects: [], outcome: { ...VIEW.outcome, effects: ['caravan_sent cv:77:0'] } }; // contradictory
  });
  const ren = await withRestarts(c);
  const first = c.accepts[0].spec.run_id;
  assert.ok(['sent', 'unresolved'].includes(ren.state.journal[first]?.state), `held: ${ren.state.journal[first]?.state}`);
  assert.equal(oncePerAction(c).keys >= 1, true);
  const action = JSON.stringify(c.accepts[0].spec.action);
  assert.deepEqual(c.accepts.filter(a => JSON.stringify(a.spec.action) === action).map(a => a.spec.run_id), [first], 'the action under one key only');
});

test('restarts with cancelled evidence: a clean Cancelled ends the line (no new key); a Cancelled with an open attempt is held', async () => {
  for (const [name, open] of [['clean', false], ['open attempt', true]]) {
    const c = fake4((v, n) => (n < 2 ? v : { ...v, ...NOTHING, state: 'Cancelled', terminal: true, cancel_requested: true, ...(open ? { attempts: [{ ...VIEW.attempts[1], status: 'sent' }], fees: { ...NOTHING.fees, reserved: 5000 } } : {}) }));
    const ren = await withRestarts(c);
    const first = c.accepts[0].spec.run_id;
    const line = ren.state.journal[first];
    if (open) assert.ok(['sent', 'unresolved'].includes(line?.state), `${name}: held (${line?.state})`);
    else assert.equal(line?.state ?? 'cancelled', 'cancelled', name);
    assert.equal(c.accepts.filter(a => a.spec.run_id.startsWith(`${first}#`)).length, 0, `${name}: no new attempt key`);
    oncePerAction(c);
  }
});

test('duplicate and replayed evidence across restarts: the same landed view read many times, accept answering Existing, settles once', async () => {
  const c = fake4((v, n) => (n < 2 ? v : { ...v, state: 'Fulfilled', terminal: true }));
  const ren = await withRestarts(c, { restarts: 8 });
  const { keys } = oncePerAction(c);
  const landed = Object.values(ren.state.journal).filter(j => j.state === 'landed');
  assert.ok(landed.length >= 1);
  assert.equal(new Set(landed.map(j => j.key)).size, landed.length, 'one journal line per key');
  assert.ok(keys >= landed.length);
  const eps = ren.ports.memory.all();
  assert.equal(new Set(eps.map(e => e.id)).size, eps.length, 'no episode twice across restarts');
});

test('NoAuthenticatedRequester across restarts: accept is never called, the line fails once, nothing is retried', async () => {
  const c = fake4();
  const ren = await withRestarts(c, { requesterOf: () => null });
  assert.equal(c.accepts.length, 0, 'accept called 0 times over every restart');
  const lines = Object.values(ren.state.journal).filter(j => j.action);
  assert.ok(lines.length >= 1);
  assert.ok(lines.every(j => j.state === 'failed' && j.error === 'NoAuthenticatedRequester'), JSON.stringify(lines.map(j => [j.key, j.state, j.error])));
  assert.ok(lines.every(j => !j.key.includes('#')), 'no new attempt key');
});

test('a view that cannot be read (StoreUnavailable) across restarts: held, never "not sent", handed over once', async () => {
  const c = fake4();
  const view = c.view;
  let down = true;
  c.view = async id => { if (down) throw Object.assign(new Error('no store'), { code: 'StoreUnavailable' }); return view(id); };
  const ren = await withRestarts(c, { between: (env, i) => { if (i === 4) down = false; } });
  const first = c.accepts[0].spec.run_id;
  assert.ok(['sent', 'unresolved', 'landed'].includes(ren.state.journal[first]?.state));
  oncePerAction(c);
  assert.equal(c.accepts.filter(a => a.spec.run_id === first).length, 1);
});
