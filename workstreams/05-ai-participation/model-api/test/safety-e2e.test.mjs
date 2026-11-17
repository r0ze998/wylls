// The whole autopilot in real PROCESSES (start → tick → participate → act), killed and restarted, two at once,
// stopped by the owner: one execution per decision and one reservation per model call, whatever happens.
//   E1 the relay's answer is lost after it executed → the next process replays the same requestId: 1 execution
//   E2 the process dies inside the act (relay executed, answer never heard) → restart replays: 1 execution
//   E3 the process dies while the model call is in flight → restart: that cost UNDECIDED (not released, not 0)
//   E4 the model's answer is lost (sent, no reply) → UNDECIDED and kept through a restart; nothing sent on it
//   E5 two processes start at once → one runs (AlreadyRunning for the other): 1 execution
//   E6 the owner stops between the model's answer and the act → nothing sent; resumed → 1 execution
//   E7 an act whose answer was lost, then the owner stops and resumes → replayed, never sent again
// MOCKS (said in every record of the worker): the relay is a file-backed stub of agent_act's idempotency, the model
// is the fixture transport, the world is fixed data. ⑤'s own code runs for the autopilot, participate, the cost
// ledger, the process lease, the journal and the acts registry (⑤'s substitute, or ④'s REAL one when RUNEXEC_BIN and
// FOUR_ACTS_CLIENT are set). No key is generated, derived or used; nothing is signed; no network; no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./procs/autopilot-worker.mjs', import.meta.url));
const dirOf = () => mkdtempSync(join(tmpdir(), 'p05-e2e-'));
const run = (dir, mode, ticks = 2, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [WORKER, dir, mode, String(ticks)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  p.on('error', reject);
  p.on('close', (code, signal) => resolve({ code, signal, err, ...(out.trim() ? JSON.parse(out.trim().split('\n').at(-1)) : {}) }));
});
const relayOf = dir => JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8'));
const owner = (dir, mode) => { const s = relayOf(dir); s.mode = mode; s.modeEpoch += 1; writeFileSync(join(dir, 'relay.json'), JSON.stringify(s)); };
/** Every model call reserved once, nothing left reserved or calling; returns the items by state. */
function costsOk(r) {
  const states = r.costs.items.map(([, s]) => s);
  assert.equal(new Set(r.costs.items.map(([k]) => k)).size, r.costs.items.length, 'one reservation per call key');
  assert.ok(!states.includes('reserved') && !states.includes('calling'), `nothing left in flight: ${states}`);
  return { settled: states.filter(s => s === 'settled').length, undecided: states.filter(s => s === 'undecided').length };
}
const scenario = (name, fn) => test(name, { timeout: 120_000 }, async () => { const dir = dirOf(); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } });

scenario('E1 the relay\'s answer is lost after it executed: the next process replays the same requestId — 1 execution, 1 model call', async dir => {
  const a = await run(dir, 'lose-act-response', 1);
  assert.equal(a.code, 0, a.err);
  assert.deepEqual(a.ticks[0].game, [['unknown', 'RelayUnreachable']], 'three tries with the same requestId, no answer heard');
  assert.equal(a.relay.executions, 1, 'the relay executed it once (the retries were replays)');
  const b = await run(dir, 'normal', 2);
  assert.equal(b.code, 0, b.err);
  assert.deepEqual([b.relay.executions, b.relay.keys], [1, 1]);
  assert.deepEqual(costsOk(b), { settled: 1, undecided: 0 });
});

scenario('E2 the process dies inside the act (the relay executed, the answer never heard): restart replays — 1 execution', async dir => {
  const a = await run(dir, 'die-in-act', 1);
  assert.equal(a.signal, 'SIGKILL');
  assert.equal(relayOf(dir).executions, 1);
  const b = await run(dir, 'normal', 2);
  assert.equal(b.code, 0, b.err);
  assert.equal(b.start, 'running', 'the dead process\'s lease is taken over');
  assert.deepEqual([b.relay.executions, b.relay.keys], [1, 1]);
  assert.deepEqual(costsOk(b), { settled: 1, undecided: 0 });
});

scenario('E3 the process dies while the model call is in flight: restart keeps that cost UNDECIDED (not released, not 0); one execution', async dir => {
  const a = await run(dir, 'die-in-model', 1);
  assert.equal(a.signal, 'SIGKILL');
  const b = await run(dir, 'normal', 2);
  assert.equal(b.code, 0, b.err);
  assert.equal(b.relay.executions, 1);
  assert.deepEqual(costsOk(b), { settled: 1, undecided: 1 });
  assert.ok(BigInt(b.costs.classes.undecided) > 0n, 'the undecided cost is held at its amount');
});

scenario('E4 the model\'s answer is lost (sent, no reply): UNDECIDED, nothing sent on it, kept through a restart', async dir => {
  const a = await run(dir, 'lose-model-response', 1);
  assert.equal(a.code, 0, a.err);
  assert.equal(a.relay.executions, 0, 'no decision, no act');
  assert.deepEqual(costsOk(a), { settled: 0, undecided: 1 });
  const held = a.costs.classes.undecided;
  const b = await run(dir, 'normal', 2);
  assert.equal(b.relay.executions, 1);
  assert.deepEqual(costsOk(b), { settled: 1, undecided: 1 });
  assert.equal(b.costs.classes.undecided, held, 'the restart did not release or zero it');
});

scenario('E5 two processes start at once: one runs, the other is refused — 1 execution', async dir => {
  // The first creates the shared files; then two start together.
  await run(dir, 'normal', 0);
  const [x, y] = await Promise.all([run(dir, 'normal', 3, { HOLD_MS: '1500' }), run(dir, 'normal', 3, { HOLD_MS: '1500' })]);
  assert.deepEqual([x, y].map(r => r.start ?? r.error).sort(), ['AlreadyRunning', 'running'], 'exactly one runs while the other is alive');
  const last = relayOf(dir);
  assert.deepEqual([last.executions, Object.keys(last.executed).length], [1, 1], 'one execution however the two interleaved');
});

scenario('E6 the owner stops between the model\'s answer and the act: nothing sent; resumed: 1 execution', async dir => {
  const a = await run(dir, 'owner-stops-before-act', 1);
  assert.equal(a.code, 0, a.err);
  assert.equal(a.relay.executions, 0);
  assert.deepEqual(a.ticks[0].game, [['skipped', 'StaleObservation']]);
  assert.deepEqual(costsOk(a), { settled: 1, undecided: 0 }, 'the call that was made is a cost; reserved once');
  owner(dir, 'auto');
  const b = await run(dir, 'normal', 2);
  assert.equal(b.relay.executions, 1);
  assert.deepEqual(costsOk(b), { settled: 2, undecided: 0 }, 'a new decision under the new mode epoch: its own call, reserved once');
});

scenario('E7 an act whose answer was lost, then the owner stops and resumes: replayed by its requestId, never sent again', async dir => {
  await run(dir, 'lose-act-response', 1);
  owner(dir, 'manual');
  const stopped = await run(dir, 'normal', 1);
  assert.equal(stopped.error, 'NotReady', 'stopped: the autopilot does not start');
  owner(dir, 'auto');
  const b = await run(dir, 'normal', 2);
  assert.equal(b.code, 0, b.err);
  assert.deepEqual([b.relay.executions, b.relay.keys], [1, 1]);
  assert.deepEqual(costsOk(b), { settled: 1, undecided: 0 });
});
