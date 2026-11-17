// Workstream 4's seven states, from the resident's side (keyless: the port is a wrapper over the test world; nothing is
// signed). expired and not-sent mean nothing happened: a NEW attempt under a NEW key (#a2) may follow. unknown means
// the result is unknown: it may have landed, so it is held and never sent again. unqueryable means the port could not
// ask: it is read again, never taken as an answer. pending and registered wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { small, run } from './helpers.mjs';
import { SEND_STATES } from '../resident/resident.mjs';

const one = () => small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
/** The sends of a line (its key and its new attempts) that reached the world. */
const reached = (log, base) => log.forwarded.filter(k => k === base || k.startsWith(`${base}#`));
const firstBuild = ren => Object.values(ren.state.journal).find(j => j.purpose?.type === 'build');

/**
 * The first submit is swallowed (it never reaches the world) and its status is `fate` (or throws, for unqueryable)
 * for as long as `until()` holds; every later submit goes to the world.
 */
function swallowFirst(real, fate, { until = () => true } = {}) {
  const log = { submits: [], forwarded: [], first: null };
  return {
    log,
    port: {
      ...real,
      async submit(req) {
        log.submits.push(req.idempotencyKey);
        if (log.first === null) { log.first = req.idempotencyKey; return { ok: true, status: 'sent', requestId: req.idempotencyKey }; }
        log.forwarded.push(req.idempotencyKey);
        return real.submit(req);
      },
      async status(k) {
        if (k === log.first && until()) {
          if (fate === 'unqueryable') throw Object.assign(new Error('the registry could not read the wallet'), { code: 'Unqueryable' });
          return { ok: true, status: fate === 'not-sent' ? 'refused' : 'sent', fate };
        }
        return k === log.first ? null : real.status(k);
      },
    },
  };
}

test('the resident names the same seven states as workstream 4', () => {
  assert.deepEqual([...SEND_STATES].sort(), ['expired', 'failed', 'landed', 'not-sent', 'pending', 'unknown', 'unqueryable']);
});

for (const fate of ['expired', 'not-sent']) {
  test(`${fate}: nothing happened, so one new attempt under a new key, and the action happens once`, async () => {
    const env = await one();
    const ren = env.rs.ren;
    const f = swallowFirst(ren.ports.execution, fate);
    ren.ports.execution = f.port;
    await run(env, 20);
    const it = firstBuild(ren);
    assert.deepEqual(f.log.submits.filter(k => k === f.log.first || k.startsWith(`${f.log.first}#`)), [f.log.first, `${f.log.first}#a2`]);
    assert.deepEqual(reached(f.log, f.log.first), [`${f.log.first}#a2`], 'the action reached the world once');
    assert.equal(it.state, 'landed');
    // The allowance counts sends, one per key: the expired attempt was a send (conservative; the limit is on attempts).
    assert.deepEqual(it.counted, [f.log.first, `${f.log.first}#a2`]);
  });
}

for (const fate of ['unknown', 'unqueryable']) {
  test(`${fate}: never taken as "did not happen" and never sent again, under any key`, async () => {
    const env = await one();
    const ren = env.rs.ren;
    const f = swallowFirst(ren.ports.execution, fate);
    ren.ports.execution = f.port;
    await run(env, 200);
    const base = f.log.first;
    assert.deepEqual(f.log.submits.filter(k => k === base || k.startsWith(`${base}#`)), [base], 'one send only');
    const it = Object.values(ren.state.journal).find(j => j.key === base);
    assert.ok(['sent', 'unresolved'].includes(it.state), `held: ${it.state}`);
    assert.deepEqual(reached(f.log, base), [], 'held, so nothing under that line reached the world');
  });
}

for (const fate of ['pending', 'registered']) {
  test(`${fate}: waits, then settles on the later answer without a new send`, async () => {
    const env = await one();
    const ren = env.rs.ren;
    let hold = true;
    const f = swallowFirst(ren.ports.execution, fate, { until: () => hold });
    ren.ports.execution = f.port;
    await run(env, 30);
    const base = f.log.first;
    const it = Object.values(ren.state.journal).find(j => j.key === base);
    assert.equal(it.state, 'sent');
    hold = false; // then the registry answers expired: a new attempt follows
    const p = ren.ports.execution;
    ren.ports.execution = { ...p, status: async k => (k === base ? { ok: true, status: 'sent', fate: 'expired' } : p.status(k)) };
    await run(env, 30);
    assert.deepEqual(f.log.submits.filter(k => k === base || k.startsWith(`${base}#`)), [base, `${base}#a2`]);
    assert.deepEqual(reached(f.log, base), [`${base}#a2`]);
  });
}
