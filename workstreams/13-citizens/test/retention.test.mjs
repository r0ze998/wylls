// The resident and workstream 4's key retention (08-retention-contract.ja.md). The execution port below keeps a key
// only for the declared minimum (one game day after its fate is final), then forgets it, and in the worst case
// EXECUTES a forgotten key again when it is submitted. Against such a port, a resident that re-created an old return
// after pruning its journal would pay twice; these tests pin that it never does, and that nothing unsent is counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { small, run } from './helpers.mjs';
import { openResident } from '../world/harness.mjs';
import { REQUIRED_KEY_RETENTION_BELLS } from '../resident/ports/execution.mjs';

const DAY = 144;
const waitOnly = { decide: async () => ({ choice: 'wait', reason: 'retention test', mem: [] }) };

/**
 * Wraps a resident's test-world port. A key the resident uses maps to a world key `<key>~<generation>`; once the
 * key's fate has been final for `retention` bells it is forgotten, and a later submit under it starts a new
 * generation, i.e. a new action in the world (`reexecute`), or is refused with KeyExpired (the contract).
 */
function forgetfulPort(inner, world, { retention = REQUIRED_KEY_RETENTION_BELLS, reexecute = true } = {}) {
  const keys = new Map(); // resident key -> {gen, finalAt}
  const log = { submits: [], forgotten: 0, refusedExpired: 0 };
  const worldKey = k => `${k}~${keys.get(k).gen}`;
  const forgetIfOld = async k => {
    const e = keys.get(k);
    if (!e) return;
    const s = await inner.status(worldKey(k));
    if (s && ['landed', 'failed', 'cancelled'].includes(s.fate)) e.finalAt ??= world.bell;
    if (e.finalAt != null && world.bell - e.finalAt > retention) { keys.set(k, { gen: e.gen + 1, finalAt: null, forgotten: true }); log.forgotten++; }
  };
  return {
    kind: 'forgetful (test)', retentionBells: retention, log,
    async status(k) {
      await forgetIfOld(k);
      const e = keys.get(k);
      if (!e || e.forgotten) return null;
      return inner.status(worldKey(k));
    },
    async submit(req) {
      const k = req.idempotencyKey;
      await forgetIfOld(k);
      if (!keys.has(k)) keys.set(k, { gen: 0, finalAt: null });
      const e = keys.get(k);
      if (e.forgotten && !reexecute) { log.refusedExpired++; return { ok: false, status: 'refused', error: { code: 'KeyExpired', message: 'forgotten key' } }; }
      e.forgotten = false;
      log.submits.push([world.bell, k]);
      return inner.submit({ ...req, idempotencyKey: worldKey(k) });
    },
    async cancel(k) { return inner.cancel(keys.has(k) ? worldKey(k) : k); },
  };
}

/** Ren asks Kou for wood, offering food; Kou serves at once. Optionally the road back to Kou is raided. */
async function owingRen({ raid }) {
  const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 }, provider: waitOnly }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
    async script(bell, me) {
      for (const r of me.board.requests({ status: 'open' })) {
        if (r.to === me.citizen && (await me.post({ kind: 'reply', re: r.id, decision: 'accept' })).ok) await me.send('SendCaravan', { to: r.from, goods: r.want });
      }
    } }] });
  const ren = env.rs.ren;
  ren.ports.execution = forgetfulPort(ren.ports.execution, env.world);
  if (raid) env.world.operator.raidRoute(ren.state.citizen, env.ps.Kou.citizen);
  const req = (await ren.ports.board.post({ kind: 'request', to: env.ps.Kou.citizen, want: { Wood: 40 }, offer: { Food: 40 }, deadlineBell: env.world.bell + 20 })).id;
  return { env, ren, req };
}

const returnsSent = (env, ren) => env.world.s.caravans.filter(k => k.src === ren.state.citizen).length;

/** Runs `days` game days and records the resident's counted actions for each day. */
async function days(env, ren, n) {
  const perDay = [];
  for (let d = 0; d < n; d++) { await run(env, DAY); perDay.push(ren.state.counters.day === Math.floor((env.world.bell - 1) / DAY) ? ren.state.counters.actions : 0); }
  return perDay;
}

test('a raided return is paid once, even when the executor forgets its key and would execute it again', async () => {
  const { env, ren, req } = await owingRen({ raid: true });
  const perDay = await days(env, ren, 4);
  assert.equal(returnsSent(env, ren), 1, 'one return caravan in four days');
  assert.equal(ren.ports.execution.log.submits.length, 1, 'the resident submitted the return once');
  assert.ok(ren.ports.execution.log.forgotten >= 1 || ren.ports.execution.log.submits.length === 1);
  assert.equal(env.board.statusOf(env.board.s.posts.find(p => p.id === req)).returned, 'not-returned', 'the board still sees the debt unpaid');
  assert.ok(ren.state.returns[req], 'the return marker stays while the board counts the debt unpaid');
  assert.deepEqual(perDay, [1, 0, 0, 0], 'one action on the day it was sent, none for the days after (no phantom)');
});

test('a paid return clears its marker once the board settles it; nothing is re-created or re-sent afterwards', async () => {
  const { env, ren, req } = await owingRen({ raid: false });
  const perDay = await days(env, ren, 4);
  assert.equal(env.board.statusOf(env.board.s.posts.find(p => p.id === req)).returned, 'returned');
  assert.equal(returnsSent(env, ren), 1);
  assert.equal(ren.ports.execution.log.submits.length, 1);
  assert.equal(ren.state.returns[req], undefined, 'the marker went when the board settled the debt');
  assert.deepEqual(perDay, [1, 0, 0, 0]);
});

test('a restart after the journal and the executor have both forgotten: still one payment, no phantom action', async () => {
  const { env, ren, req } = await owingRen({ raid: true });
  await days(env, ren, 2);
  const port = ren.ports.execution;
  const again = openResident(path.join(env.dir, 'ren'), { world: env.world, board: env.board, provider: waitOnly });
  again.ports.execution = port;
  env.rs.ren = again;
  const perDay = await days(env, again, 2);
  assert.equal(returnsSent(env, again), 1);
  assert.equal(port.log.submits.length, 1);
  assert.ok(again.state.returns[req]);
  assert.deepEqual(perDay, [0, 0]);
});

test('a port that keeps keys for less than one game day is refused before the resident sends anything', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  ren.ports.execution = forgetfulPort(ren.ports.execution, env.world, { retention: REQUIRED_KEY_RETENTION_BELLS - 1 });
  await assert.rejects(ren.step(), /needs at least 144 bells/);
  const undeclared = { ...ren.ports.execution };
  delete undeclared.retentionBells;
  ren.ports.execution = undeclared;
  await assert.rejects(ren.step(), /undeclared/);
  assert.equal(env.world.s.queue.length, 0);
});
