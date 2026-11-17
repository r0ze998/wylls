import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { small, run } from './helpers.mjs';
import { openResident } from '../world/harness.mjs';
import { fixtureProvider } from '../resident/ports/provider.mjs';

for (const response of ['throw', 'transport-result']) test(`an ambiguous ${response} keeps the original key until its fate is known`, async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  const real = ren.ports.execution;
  const submitted = [];
  let hiddenStatuses = 2;
  let loseReply = true;
  ren.ports.execution = {
    ...real,
    async status(key) {
      if (hiddenStatuses-- > 0) return null;
      return real.status(key);
    },
    async submit(req) {
      submitted.push(req.idempotencyKey);
      const answer = await real.submit(req);
      if (loseReply) {
        loseReply = false;
        if (response === 'throw') throw new Error('reply lost after acceptance');
        return { ok: false, status: 'failed', error: { code: 'Transport', message: 'reply lost after acceptance' } };
      }
      return answer;
    },
  };

  await run(env, 1);
  const first = Object.values(ren.state.journal).find(it => it.purpose?.type === 'build');
  assert.ok(first, 'the first build was attempted');
  assert.equal(first.state, 'sent', 'an ambiguous response remains pending');
  assert.equal(first.sendKey, first.key);
  assert.equal(first.attempts, 1);

  // A process restart must reload the same pending key, even if status is still unavailable.
  const reopened = openResident(path.join(env.dir, 'ren'), { world: env.world, board: env.board, provider: fixtureProvider() });
  env.rs.ren = reopened;
  const afterRestart = reopened.state.journal[first.key];
  assert.deepEqual([afterRestart.state, afterRestart.sendKey, afterRestart.attempts], ['sent', first.key, 1]);
  const restartedPort = reopened.ports.execution;
  let unavailable = 1;
  reopened.ports.execution = {
    ...restartedPort,
    async status(key) { return unavailable-- > 0 ? null : restartedPort.status(key); },
    async submit(req) { submitted.push(req.idempotencyKey); return restartedPort.submit(req); },
  };
  await run(env, 8);
  assert.equal(submitted.filter(key => key.startsWith(first.key)).length, 1, 'no new key is sent for the same action');
  assert.equal(afterRestart.state, 'landed', 'the original key is reconciled after status recovers');
});
