// A small cross-process mutex and a durable write, for ⑤'s files shared between processes (the process lease and the
// cost ledger). Synchronous on purpose: a reservation is check-and-hold in one step, as in RunCostMock.
//
// The mutex is a file created exclusively (`wx`) holding the owner's pid. A mutex whose owner is gone (crashed) or that
// is older than `staleMs` is taken over — the same rule as the relay's own state-file lock (agent/lock.mjs).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withFileMutex(path, fn, { timeoutMs = 10_000, staleMs = 10_000, isAlive = pidAlive, pid = process.pid } = {}) {
  const m = `${path}.mutex`;
  mkdirSync(dirname(m), { recursive: true });
  const t0 = Date.now();
  for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
    try {
      const fd = openSync(m, 'wx', 0o600);
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = NaN, age = 0;
      try { holder = Number(readFileSync(m, 'utf8').trim()); age = Date.now() - statSync(m).mtimeMs; } catch { continue; } // gone meanwhile: retry
      if ((Number.isSafeInteger(holder) && holder > 0 && holder !== pid && !isAlive(holder)) || age > staleMs) {
        const aside = `${m}.stale.${pid}.${Date.now()}`;
        try { renameSync(m, aside); unlinkSync(aside); } catch { /* another process took it over first */ }
        continue;
      }
      if (Date.now() - t0 > timeoutMs) throw Object.assign(new Error(`${m} is held by ${holder}`), { code: 'MutexTimeout' });
      sleepSync(wait);
    }
  }
  try { return fn(); } finally { try { if (Number(readFileSync(m, 'utf8').trim()) === pid) unlinkSync(m); } catch { /* already gone */ } }
}

/** Write `data` to `path` so that a reader sees the old file or the new one, never a torn one. */
export function writeDurable(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export { pidAlive, sleepSync };
