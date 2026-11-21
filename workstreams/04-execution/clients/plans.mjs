// Workstream 04's plan store (src/plans.rs), for workstream 13's local resident (2026-11-22).
//
// This client runs `runexec plan …` (no shell, arguments as a list) and returns the JSON it prints. It never signs,
// sends or holds a key: the resident does, in its own process, and tells the store each fact in order —
//
//   const plans = createPlansClient({ bin: '/path/to/runexec', db: '/abs/plans.sqlite' });
//   await plans.accept(spec);                                  // p04-plan/0.1
//   const { epoch } = await plans.claim({ plan, holder, leaseMs: 20000 });
//   await plans.intend({ plan, holder, epoch, step, bell });   // BEFORE anything is signed
//   await plans.signed({ plan, holder, epoch, step, signature });   // BEFORE the one submit; a throw here = do not submit
//   await plans.settle({ plan, holder, epoch, step, outcome, signature, code, bookedBell });
//
// Errors are PlansError with the store's code: BadRequest | NotLocalOrder | NoRecord | Conflict | Fenced | NotDue |
// OpenStep | TurnUsed | Exhausted | Stopped | ActivePlan | NotIntended | BadSettle | StoreError | StoreUnavailable,
// or Spawn (no usable answer: read again, never take it for "not recorded"). As acts.mjs: NoRecord counts only with
// runexec's own exit 3 from a process that was not killed.
import { execFile as nodeExecFile } from 'node:child_process';

export class PlansError extends Error {
  constructor(code, message, exit) { super(message); this.code = code; this.exit = exit; }
}

const EXIT_CODES = Object.freeze({ 1: 'StoreError', 2: 'BadRequest', 3: 'NoRecord', 4: 'Conflict', 5: 'StoreUnavailable', 6: 'Fenced', 7: 'Refused' });

function run(bin, args, { timeoutMs, execFile, stdin = null }) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 22, shell: false }, (err, stdout) => {
      const line = String(stdout ?? '').trim().split('\n').at(-1) ?? '';
      let v = null;
      try { v = line ? JSON.parse(line) : null; } catch { v = null; }
      if (!err) return v && !v.error ? resolve(v) : reject(new PlansError('StoreError', 'runexec printed no JSON', 0));
      const exitOk = Number.isInteger(err.code) && !err.killed && !err.signal && EXIT_CODES[err.code];
      if (!exitOk || !v?.error) return reject(new PlansError('Spawn', `runexec gave no usable answer (exit ${err.code ?? null}${err.signal ? `, ${err.signal}` : ''})`, err.code));
      reject(new PlansError(v.error, v.message ?? v.error, err.code));
    });
    if (stdin !== null) { child.stdin?.end(stdin); }
  });
}

/**
 * @param {object} o
 * @param {string} o.bin  the runexec binary
 * @param {string} o.db   the plan store (SQLite; the resident's own file)
 * @param {() => number} [o.nowMs]  the clock the store is told (tests)
 */
export function createPlansClient({ bin, db, nowMs = () => Date.now(), timeoutMs = 15_000, execFile = nodeExecFile }) {
  if (typeof bin !== 'string' || !bin || typeof db !== 'string' || !db) throw new Error('bin and db are required');
  const call = (verb, opts, stdin = null) => {
    const args = ['plan', verb, '--db', db];
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== null) args.push(`--${k}`, String(v));
    return run(bin, args, { timeoutMs, execFile, stdin });
  };
  const now = () => String(Math.floor(nowMs()));
  return Object.freeze({
    accept: spec => call('accept', { spec: '-', 'now-ms': now() }, JSON.stringify(spec)),
    claim: ({ plan, holder, leaseMs }) => call('claim', { plan, holder, 'lease-ms': leaseMs, 'now-ms': now() }),
    intend: ({ plan, holder, epoch, step, bell }) => call('intend', { plan, holder, epoch, step, bell, 'now-ms': now() }),
    signed: ({ plan, holder, epoch, step, signature }) => call('signed', { plan, holder, epoch, step, signature, 'now-ms': now() }),
    settle: ({ plan, holder, epoch, step, outcome, signature, code, bookedBell }) =>
      call('settle', { plan, holder, epoch, step, outcome, signature, code, 'booked-bell': bookedBell, 'now-ms': now() }),
    stop: ({ plan, holder, epoch, why }) => call('stop', { plan, holder, epoch, why, 'now-ms': now() }),
    view: ({ plan }) => call('view', { plan }),
    current: ({ owner, world }) => call('current', { owner, world }),
  });
}
