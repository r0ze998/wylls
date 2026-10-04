// AC1a: one slot, earliest deadline first, admission by rolling p90 (section 3.5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../citizens/mind/scheduler.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seeds = { session: { p50: 50, p90: 80 }, reaction: { p50: 20, p90: 30 }, motion: { p50: 20, p90: 30 }, ballot: { p50: 20, p90: 30 }, reflection: { p50: 20, p90: 30 } };

test('earliest deadline first, ties by kind then AI index', async () => {
  const s = createScheduler({ seedMs: seeds });
  const order = [];
  const t = Date.now();
  const mk = (name, kind, index, off) => s.submit({ kind, index, deadline: t + 5000 + off, run: async () => { order.push(name); await sleep(5); } });
  const blocker = s.submit({ kind: 'session', index: 0, deadline: t + 4000, run: async () => { await sleep(40); } });
  const ps = [mk('late', 'session', 1, 300), mk('ballot', 'ballot', 2, 0), mk('session5', 'session', 5, 0), mk('session2', 'session', 2, 0), mk('motion', 'motion', 9, 0)];
  await Promise.all([blocker, ...ps]);
  assert.deepEqual(order, ['session2', 'session5', 'motion', 'ballot', 'late']);
});

test('a reaction does not pre-empt a session whose deadline is within 2 x p90(session)', async () => {
  const s = createScheduler({ seedMs: seeds });
  const order = [];
  const t = Date.now();
  const blocker = s.submit({ kind: 'session', index: 0, deadline: t + 4000, run: async () => { await sleep(40); } });
  // the reaction's deadline is earlier than the session's, but the session is urgent (within 160 ms)
  const r = s.submit({ kind: 'reaction', index: 1, deadline: t + 150, run: async () => { order.push('reaction'); } });
  const se = s.submit({ kind: 'session', index: 2, deadline: t + 155, run: async () => { order.push('session'); } });
  await Promise.all([blocker, r, se]);
  assert.deepEqual(order, ['session', 'reaction']);
  assert.ok(s.counters.preempt_guard >= 1);
});

test('admission: a job that cannot finish before its deadline goes to autopilot (no_time) without running', async () => {
  const s = createScheduler({ seedMs: seeds });
  let ran = false;
  const r = await s.submit({ kind: 'session', index: 1, deadline: Date.now() + 30, run: async () => { ran = true; } });
  assert.deepEqual([r.status, r.reason], ['dropped', 'no_time']);
  assert.equal(ran, false);
});

test('queue wait counts: a job queued behind an earlier-deadline job is refused when the wait makes it late', async () => {
  const s = createScheduler({ seedMs: { ...seeds, session: { p50: 200, p90: 120 } } });
  const t = Date.now();
  const a = s.submit({ kind: 'session', index: 1, deadline: t + 300, run: async () => { await sleep(30); } });
  const b = await s.submit({ kind: 'session', index: 2, deadline: t + 310, run: async () => {} });
  assert.equal(b.reason, 'no_time', 'wait 200 + p90 120 > 310');
  assert.equal((await a).status, 'done');
});

test('a job past its deadline while queued is dropped, not started', async () => {
  const s = createScheduler({ seedMs: { ...seeds, session: { p50: 1, p90: 2 } } });
  const t = Date.now();
  let ran = false;
  const a = s.submit({ kind: 'session', index: 1, deadline: t + 60, run: async () => { await sleep(90); } });
  const b = s.submit({ kind: 'session', index: 2, deadline: t + 70, run: async () => { ran = true; } });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 'timeout', 'the running job was aborted at its deadline');
  assert.equal(rb.reason, 'no_time');
  assert.equal(ran, false);
});

test('the deadline aborts a running job; timeout is reported', async () => {
  const s = createScheduler({ seedMs: { ...seeds, session: { p50: 1, p90: 2 } } });
  let aborted = false;
  const r = await s.submit({ kind: 'session', index: 1, deadline: Date.now() + 60, run: ({ signal }) => new Promise((res) => { signal.addEventListener('abort', () => { aborted = true; res('x'); }); }) });
  assert.equal(r.status, 'timeout');
  assert.equal(aborted, true);
});

test('p50 and p90 are rolling over 50 calls and seeded from the probe', async () => {
  const s = createScheduler({ seedMs: { ...seeds, session: { p50: 6100, p90: 6700 } }, window: 50 });
  assert.equal(s.p50('session'), 6100);
  assert.equal(s.p90('session'), 6700);
  const fake = createScheduler({ seedMs: { ...seeds, session: { p50: 10, p90: 12 } }, window: 50 });
  for (let i = 0; i < 60; i++) await fake.submit({ kind: 'session', index: 1, deadline: Date.now() + 5000, run: async () => { await sleep(i < 30 ? 1 : 4); } });
  assert.ok(fake.p50('session') < 10, `seed aged out, p50 now ${fake.p50('session')}`);
  assert.equal(fake.latencies().session.n, 50);
});

test('a thrown job is reported as error and the queue keeps going', async () => {
  const s = createScheduler({ seedMs: seeds });
  const a = await s.submit({ kind: 'session', index: 1, deadline: Date.now() + 5000, run: async () => { throw new Error('boom'); } });
  assert.equal(a.status, 'error');
  const b = await s.submit({ kind: 'session', index: 1, deadline: Date.now() + 5000, run: async () => 7 });
  assert.equal(b.value, 7);
});
