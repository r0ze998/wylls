// One llama slot, one queue (contract section 3.5): earliest deadline first, ties by kind (session,
// motion, ballot, reaction, reflection) then AI index; a reaction never pre-empts a session whose
// deadline is within 2 x p90(session); admission drops a job to autopilot ("no_time") when
// now + queue_wait + p90(kind) > deadline. p50/p90 are rolling over the last 50 calls of the kind,
// seeded from AC1a's step-0 probe (config.scheduler.seed_ms), so the first decisions of a run are
// admitted against measured numbers, not zeros.
const KIND_ORDER = ['session', 'motion', 'ballot', 'reaction', 'reflection'];
const WINDOW = 50;

function pctOf(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export function createScheduler({ now = Date.now, seedMs = {}, window = WINDOW, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const windows = {};
  for (const k of KIND_ORDER) {
    const seed = seedMs[k] ?? { p50: 6000, p90: 9000 };
    windows[k] = [seed.p50, seed.p50, seed.p50, seed.p50, seed.p50, seed.p90, seed.p90, seed.p90, seed.p90, seed.p90];
  }
  const counters = { submitted: 0, done: 0, dropped_no_time: 0, errors: 0, timeouts: 0, preempt_guard: 0 };
  const queue = [];
  let running = null; // {job, startedAt}
  let seqNo = 0;

  const p50 = (k) => pctOf(windows[k] ?? windows.session, 50);
  const p90 = (k) => pctOf(windows[k] ?? windows.session, 90);

  function record(kind, ms) {
    const w = windows[kind] ?? (windows[kind] = []);
    w.push(ms);
    while (w.length > window) w.shift();
  }

  const cmp = (a, b) =>
    a.deadline - b.deadline ||
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    a.index - b.index ||
    a.seq - b.seq;

  function waitEstimate(job) {
    let w = 0;
    if (running) w += Math.max(0, p50(running.job.kind) - (now() - running.startedAt));
    for (const q of queue) if (cmp(q, job) < 0) w += p50(q.kind);
    return w;
  }

  function pickNext() {
    // drop expired jobs first
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].deadline <= now()) {
        const [j] = queue.splice(i, 1);
        counters.dropped_no_time += 1;
        j.resolve({ status: 'dropped', reason: 'no_time', waited_ms: now() - j.submittedAt });
      }
    }
    if (!queue.length) return null;
    queue.sort(cmp);
    let pick = queue[0];
    if (pick.kind === 'reaction') {
      // a reaction never pre-empts a session that is about to run out of time
      const urgent = queue.find((j) => j.kind === 'session' && j.deadline - now() <= 2 * p90('session'));
      if (urgent) {
        pick = urgent;
        counters.preempt_guard += 1;
      }
    }
    queue.splice(queue.indexOf(pick), 1);
    return pick;
  }

  async function pump() {
    if (running) return;
    const job = pickNext();
    if (!job) return;
    running = { job, startedAt: now() };
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      ac.abort();
    }, Math.max(1, job.deadline - now()));
    let out;
    try {
      const value = await job.run({ signal: ac.signal, deadline: job.deadline, startedAt: running.startedAt, waited_ms: running.startedAt - job.submittedAt });
      out = { status: timedOut ? 'timeout' : 'done', value };
      if (timedOut) counters.timeouts += 1;
      else counters.done += 1;
    } catch (e) {
      counters.errors += 1;
      out = { status: 'error', error: String(e?.message ?? e).slice(0, 200) };
    } finally {
      clearTimer(timer);
    }
    record(job.kind, now() - running.startedAt);
    running = null;
    job.resolve(out);
    queueMicrotask(pump);
  }

  return {
    p50,
    p90,
    counters,
    queueState: () => ({ n: queue.length + (running ? 1 : 0), oldest_ms: queue.length ? Math.max(...queue.map((j) => now() - j.submittedAt)) : 0, running: running?.job.kind ?? null }),
    /**
     * job: {kind, index, deadline (ms), run(ctx) -> value}. Resolves {status:'done'|'timeout'|'error'|'dropped', ...}.
     * 'dropped' with reason 'no_time' means: do not call the model, run autopilot.
     */
    submit(job) {
      counters.submitted += 1;
      const j = { ...job, seq: seqNo++, submittedAt: now() };
      if (!KIND_ORDER.includes(j.kind)) throw new Error(`scheduler kind ${j.kind}`);
      if (now() + waitEstimate(j) + p90(j.kind) > j.deadline) {
        counters.dropped_no_time += 1;
        return Promise.resolve({ status: 'dropped', reason: 'no_time', waited_ms: 0, estimate_ms: waitEstimate(j) + p90(j.kind) });
      }
      return new Promise((resolve) => {
        j.resolve = resolve;
        queue.push(j);
        queueMicrotask(pump);
      });
    },
    kinds: KIND_ORDER,
    latencies: () => Object.fromEntries(KIND_ORDER.map((k) => [k, { p50: p50(k), p90: p90(k), n: windows[k].length }])),
  };
}
