// One writer per agent-wallet state file (docs/agent-wallet/DESIGN.md §9):
// the ledger's safety is one process's event loop, so a second relay process
// on the same file would let two processes spend the same balance. The lock
// is a file next to the state, created exclusively, holding the owner's pid;
// a lock whose process is gone is taken over (after a crash), a live one is
// refused. Released when the relay stops.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * Takes the lock `${statePath}.lock` for this process, or throws naming the holder.
 * Returns `{path, release()}`.
 */
export function lockStateFile(statePath, { pid = process.pid, isAlive = alive } = {}) {
  const path = `${statePath}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try { if (Number(readFileSync(path, 'utf8').trim()) === pid) unlinkSync(path); } catch { /* gone already */ }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = NaN;
      try { holder = Number(readFileSync(path, 'utf8').trim()); } catch { /* unreadable: treat as held */ }
      if (Number.isSafeInteger(holder) && holder > 0 && holder !== pid && !isAlive(holder)) {
        // The holder crashed: move its lock aside (atomic) and try once more.
        try { renameSync(path, `${path}.stale-${holder}`); } catch { /* another process took it over first */ }
        continue;
      }
      throw new Error(`the agent wallet state ${statePath} is in use by process ${Number.isNaN(holder) ? '(unknown)' : holder}; one relay process per state file`);
    }
  }
  throw new Error(`the agent wallet state ${statePath}: could not take its lock`);
}
