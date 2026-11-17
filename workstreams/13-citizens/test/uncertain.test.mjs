// Recovery from uncertain results. f637c7a (integration) keeps a send whose reply was lost under its original key;
// these tests cover what follows: a send that never reached the world is re-sent under the SAME key, the port's
// `unknown` is waited out with backoff and never re-sent, a line without a definite answer for a game day becomes
// `unresolved` and still settles when the answer comes, and nothing is re-sent outside the key's retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { small, run } from './helpers.mjs';
import { openResident } from '../world/harness.mjs';
import { UNCLEAR_BEFORE_RESUBMIT } from '../resident/resident.mjs';

const DAY = 144;
const one = (extra = {}) => small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 }, ...extra }] });
const builds = env => env.world.s.events.filter(e => e.kind === 'BuildStarted').length;
const firstBuild = ren => Object.values(ren.state.journal).find(j => j.purpose?.type === 'build');
/** Submits under a line's key or its retry keys (`<key>#a2`…), not other lines that share a prefix (t1 vs t10). */
const sendsOf = (log, key) => log.submits.filter(k => k === key || k.startsWith(`${key}#`));

/** Wraps a port: `lose(n)` makes the next n submits fail in transport BEFORE reaching the world; `fates` overrides status. */
function flaky(real) {
  const log = { submits: [], statuses: 0 };
  let lose = 0, override = null;
  return {
    port: {
      ...real,
      async submit(req) { log.submits.push(req.idempotencyKey); if (lose > 0) { lose--; throw new Error('connection reset before the request arrived'); } return real.submit(req); },
      async status(k) { log.statuses++; return override ? override(k, await real.status(k)) : real.status(k); },
    },
    log, lose: n => { lose = n; }, setStatus: f => { override = f; },
  };
}

test('a send that never reached the world is re-sent under the same key, and lands once', async () => {
  const env = await one();
  const ren = env.rs.ren;
  const f = flaky(ren.ports.execution);
  ren.ports.execution = f.port;
  f.lose(1);
  await run(env, 1);
  const it = firstBuild(ren);
  assert.deepEqual([it.state, it.lastError], ['sent', 'Transport'], 'f637c7a: kept under its key, not failed');
  await run(env, 12);
  assert.equal(builds(env), 1, 'the action happened once');
  assert.deepEqual([...new Set(sendsOf(f.log, it.key))], [it.key], 'never a new key (#a2)');
  assert.equal(f.log.submits.filter(k => k === it.key).length, 2, 'the lost submit and one re-send');
  assert.equal(it.resubmits, 1);
  assert.equal(it.state, 'landed');
  assert.equal(ren.state.counters.actions, 1, 'counted once although submitted twice');
  assert.ok(f.log.statuses < 12, `re-queries back off: ${f.log.statuses} reads`);
});

test(`the port's "unknown" is waited out with backoff and never re-sent; a definite answer settles it`, async () => {
  const env = await one();
  const ren = env.rs.ren;
  const f = flaky(ren.ports.execution);
  ren.ports.execution = f.port;
  let unknownUntil = 60;
  f.setStatus((k, real) => (env.world.bell < unknownUntil && real ? { ...real, fate: 'unknown' } : real));
  await run(env, 59);
  const it = firstBuild(ren);
  assert.equal(it.state, 'sent');
  const readsWhileUnknown = f.log.statuses;
  assert.ok(readsWhileUnknown < 25, `backoff: ${readsWhileUnknown} reads in 59 bells`);
  await run(env, 40);
  assert.equal(it.state, 'landed');
  assert.equal(sendsOf(f.log, it.key).length, 1, 'no re-send for "unknown"');
  assert.equal(env.world.s.events.filter(e => e.kind === 'BuildStarted' && e.item === it.action.fields.item && e.bell <= it.landedBell).length, 1, 'that build happened once');
  void unknownUntil;
});

test('a game day without a definite answer makes the line unresolved: reported, still blocking, and it recovers', async () => {
  const env = await one();
  const ren = env.rs.ren;
  const f = flaky(ren.ports.execution);
  ren.ports.execution = f.port;
  let unknown = true;
  f.setStatus((k, real) => (unknown && real ? { ...real, fate: 'unknown' } : real));
  await run(env, DAY + 40);
  const it = firstBuild(ren);
  assert.equal(it.state, 'unresolved');
  assert.match(it.why, /unknown/);
  const sameAgain = Object.values(ren.state.journal).filter(j => j.action && JSON.stringify(j.action) === JSON.stringify(it.action));
  assert.equal(sameAgain.length, 1, 'the same build is not chosen again while it is unresolved');
  // The journal keeps it however old it gets.
  await run(env, DAY);
  assert.equal(ren.state.journal[it.key].state, 'unresolved');
  // The port answers at last.
  unknown = false;
  await run(env, 40);
  assert.equal(ren.state.journal[it.key].state, 'landed');
  assert.equal(sendsOf(f.log, it.key).length, 1);
});

test('an unresolved promise is reported in owed() and survives a restart', async () => {
  const waitOnly = { decide: async () => ({ choice: 'wait', reason: 'one trade only', mem: [] }) };
  const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 }, provider: waitOnly }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
    async script(bell, me) { for (const r of me.board.requests({ status: 'open' })) if (r.to === me.citizen && (await me.post({ kind: 'reply', re: r.id, decision: 'accept' })).ok) await me.send('SendCaravan', { to: r.from, goods: r.want }); } }] });
  const ren = env.rs.ren;
  const f = flaky(ren.ports.execution);
  ren.ports.execution = f.port;
  f.setStatus((k, real) => (k.includes(':return:') && real ? { ...real, fate: 'unknown' } : real));
  await ren.ports.board.post({ kind: 'request', to: env.ps.Kou.citizen, want: { Wood: 40 }, offer: { Food: 40 }, deadlineBell: env.world.bell + 20 });
  // The switch happens at a re-query, and re-queries back off up to the pulse (36 bells): give it one pulse.
  await run(env, DAY + 40);
  assert.deepEqual(ren.owed().map(o => [o.type, o.state]), [['return', 'unresolved']]);
  const again = openResident(path.join(env.dir, 'ren'), { world: env.world, board: env.board, provider: ren.ports.provider });
  again.ports.execution = f.port;
  env.rs.ren = again;
  await run(env, 10);
  assert.deepEqual(again.owed().map(o => [o.type, o.state]), [['return', 'unresolved']]);
  assert.equal(env.world.s.caravans.filter(k => k.src === again.state.citizen).length, 1, 'one return, not re-sent');
});

test('outside the key retention a lost send is never re-sent (the key may have been forgotten): it becomes unresolved', async () => {
  const env = await one();
  const ren = env.rs.ren;
  const f = flaky(ren.ports.execution);
  ren.ports.execution = { ...f.port, retentionBells: DAY };
  f.lose(1);
  // The port has no record of the key and the resident is stopped (a halt) for longer than the retention.
  await run(env, 1);
  const it = firstBuild(ren);
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(ren.charter.haltFile, 'stop');
  await run(env, DAY + 5);
  unlinkSync(ren.charter.haltFile);
  await run(env, DAY + 10);
  assert.equal(it.state, 'unresolved');
  assert.equal(f.log.submits.filter(k => k === it.key).length, 1, 'not re-sent after the retention window');
  assert.equal(builds(env), 0);
  assert.ok(UNCLEAR_BEFORE_RESUBMIT >= 3);
});
