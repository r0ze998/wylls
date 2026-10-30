// Limits a resident lives under, and the parties that can stop it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { small, run } from './helpers.mjs';
import { fixtureProvider } from '../resident/ports/provider.mjs';
import { signCommand } from '../../../permutation-gateway/src/frontier/agent/owner-auth.mjs';
import { newKeypair, addressOf } from '../resident/keys.mjs';
import { decisionsOf } from '../demo/report.mjs';

const one = (extra = {}) => small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 }, ...extra }] });
const modeCmd = (owner, mode, nonce = Math.random().toString(36).slice(2, 12)) => ({ op: 'mode', owner: addressOf(owner), agentId: 'ren', nonce, expiresAt: Date.now() + 60_000, params: { mode } });

test('model calls a day: past callsPerDay the fallback decides, every call is charged once, the books balance', async () => {
  const env = await one({ budget: { callsPerDay: 2 } });
  await run(env, 140);
  const ds = decisionsOf(env.rs.ren);
  const asked = ds.filter(d => d.by === 'provider');
  assert.equal(asked.length, 2);
  assert.ok(ds.some(d => d.refusal === 'CallLimitReached' && d.by === 'fallback'));
  const rec = env.rs.ren.ledger.get('ren');
  assert.equal(rec.bal.spent.inference, String(2 * 10000));
  assert.deepEqual(env.rs.ren.ledger.check(), []);
});

test('money: a deposit of three calls pays for three; then the fallback, never an overdraft', async () => {
  const env = await one({ deposit: '30000' });
  await run(env, 140);
  const ds = decisionsOf(env.rs.ren);
  assert.equal(ds.filter(d => d.by === 'provider').length, 3);
  assert.ok(ds.some(d => d.refusal === 'InsufficientBalance'));
  assert.equal(env.rs.ren.ledger.get('ren').bal.available, '0');
});

test('a late or invalid provider is charged, refused, and paused after three failures', async () => {
  for (const [mode, code] of [['slow', 'Late'], ['invalid', 'NotACandidate']]) {
    const env = await one({ provider: fixtureProvider({ mode }), limits: { providerDeadlineMs: 20 } });
    await run(env, 60);
    const ds = decisionsOf(env.rs.ren);
    assert.equal(ds.filter(d => d.refusal === code).length, 3, mode);
    assert.ok(ds.some(d => d.refusal === 'ProviderPaused'), `${mode}: paused`);
    assert.ok(ds.every(d => d.by !== 'provider'));
    assert.deepEqual(env.rs.ren.ledger.check(), []);
  }
});

test('the owner stops it with a signed command; another key or a replay cannot; sent actions are not rolled back, unsent ones are withdrawn', async () => {
  const env = await one();
  await run(env, 2);
  const ren = env.rs.ren;
  const stranger = newKeypair();
  const bad = modeCmd(stranger, 'manual');
  assert.throws(() => ren.command({ command: bad, signature: signCommand(bad, stranger) }), /NotOwner/);
  const cmd = modeCmd(env.operator.keypair, 'manual');
  const sig = signCommand(cmd, env.operator.keypair);
  // A sent action that has not landed yet is withdrawn at the stop.
  const sent = Object.values(ren.state.journal).filter(j => j.state === 'sent');
  ren.command({ command: cmd, signature: sig });
  assert.throws(() => ren.command({ command: cmd, signature: sig }), /already used/);
  const res = await ren.step();
  assert.equal(res.stopped, 'stopped-by-owner');
  for (const j of sent) assert.equal(ren.state.journal[j.key].state, 'cancelled');
  const before = decisionsOf(ren).length;
  await run(env, 20);
  assert.equal(decisionsOf(ren).length, before, 'no decision while stopped');
  // The owner starts it again.
  const on = modeCmd(env.operator.keypair, 'auto');
  ren.command({ command: on, signature: signCommand(on, env.operator.keypair) });
  await run(env, 10);
  assert.ok(decisionsOf(ren).length > before);
});

test('the operator\'s halt file stops it; maxTurns ends it', async () => {
  const env = await one({ limits: { maxTurns: 4 } });
  await run(env, 80);
  assert.equal(decisionsOf(env.rs.ren).length, 4);
  assert.equal((await env.rs.ren.step()).stopped, 'max-turns');
  const env2 = await one();
  writeFileSync(env2.rs.ren.charter.haltFile, 'stop');
  assert.equal((await env2.rs.ren.step()).stopped, 'halted-by-operator');
});

test('a send refused for a passing reason is retried with a growing wait, at most maxRetries times', async () => {
  const env = await one({ limits: { maxRetries: 2, retryBackoffBells: 2 } });
  const ren = env.rs.ren;
  // The relay refuses every send (as when its quota or a breaker trips after the resident looked); the world sees nothing.
  const real = ren.ports.execution;
  const tries = [];
  ren.ports.execution = { ...real, submit: async req => { tries.push([env.world.bell, req.idempotencyKey]); return { ok: false, status: 'refused', error: { code: 'QuotaExceeded', message: 'test' } }; } };
  await run(env, 20);
  const build = Object.values(ren.state.journal).find(j => j.purpose?.type === 'build');
  assert.equal(build.state, 'failed');
  assert.equal(build.attempts, 3);
  assert.equal(build.error, 'QuotaExceeded');
  const mine = tries.filter(t => t[1].startsWith(build.key));
  assert.deepEqual(mine.map(t => t[1]), [build.key, `${build.key}#a2`, `${build.key}#a3`]);
  assert.deepEqual([mine[1][0] - mine[0][0], mine[2][0] - mine[1][0]], [2, 4]);
  // A refusal that will not pass is not retried, and the same build is not chosen again at once:
  // each failure doubles the hold-off (4, 8, 16, then the 36-bell pulse), so failures cost few model calls.
  ren.ports.execution = { ...real, submit: async () => ({ ok: false, status: 'refused', error: { code: 'BadDestination', message: 'test' } }) };
  await run(env, 100);
  const later = Object.values(ren.state.journal).filter(j => j.purpose?.type === 'build' && j.key !== build.key);
  assert.ok(later.length >= 2 && later.every(j => j.attempts === 1 && j.state === 'failed'));
  const bells = decisionsOf(ren).filter(d => d.kind === 'build').map(d => d.bell);
  const holdOffs = [4, 8, 16, 32, 36];
  for (let i = 1; i < bells.length; i++) assert.ok(bells[i] - bells[i - 1] >= holdOffs[Math.min(i - 1, 4)], `gaps ${bells}`);
  assert.ok(bells.length <= 7, `${bells.length} builds chosen in 120 bells: ${bells}`);
  assert.ok(decisionsOf(ren).some(d => d.excluded.some(e => e.reason === 'recent-failure')));
});

test('pacing: decisions are at least wakeEveryBells apart, except a reply to a request addressed to it', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
    async script(bell, me) { if (bell === 5) await me.post({ kind: 'request', to: 'c1', want: { Stone: 900 }, offer: {}, deadlineBell: 60 }); } }] });
  await run(env, 150);
  const ds = decisionsOf(env.rs.ren);
  for (let i = 1; i < ds.length; i++) {
    const gap = ds[i].bell - ds[i - 1].bell;
    assert.ok(gap >= 3 || ds[i].wakes.includes('inbox'), `gap ${gap} at ${ds[i].bell}`);
    assert.ok(gap >= 1);
  }
  // Idle waits stretch the gap (up to the pulse), so a quiet resident costs few calls.
  assert.ok(ds.length < 150 / 3, `${ds.length} decisions in 150 bells`);
});
