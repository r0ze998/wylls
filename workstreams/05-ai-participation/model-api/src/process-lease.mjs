// One autopilot per agent ACROSS PROCESSES: a lease file per agent, taken under a file mutex.
//
//   acquire()  refused (AlreadyRunning) while another lease is live: its process is alive AND its heartbeat is fresh.
//              A lease whose process is gone, or whose heartbeat is older than `ttlMs` (a hung process), is taken over
//              with the next epoch.
//   renew()    the heartbeat; throws LeaseLost if the lease is no longer this process's (taken over meanwhile).
//   check()    whether the lease is still this process's and fresh: the fence the cost ledger asks before every
//              reservation, so a process that was taken over cannot reserve (or call a model) any more.
//   release()  on a clean stop.
//
// What it does not do: stop a hung process from finishing a call it already started, or a send the relay already
// accepted; those are held as undecided (cost ledger) and replayed by requestId (relay). It is on one machine's
// filesystem: processes on other machines are not seen (a shared store, ④'s run store, is needed for that).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, withFileMutex, writeDurable } from './file-mutex.mjs';

export class ProcessLease {
  constructor({ dir, agentId, ttlMs = 30_000, now = () => Date.now(), pid = process.pid, isAlive = pidAlive }) {
    Object.assign(this, { dir, agentId, ttlMs, now, pid, isAlive });
    this.file = join(dir, `lease-${String(agentId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    this.leaseId = `${pid}-${randomBytes(6).toString('hex')}`;
    this.epoch = null;
  }

  #read() { try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return null; } }
  #live(l) { return !!l && this.isAlive(l.pid) && this.now() - l.heartbeatAt < this.ttlMs; }
  #mutex(fn) { return withFileMutex(this.file, fn, { pid: this.pid, isAlive: this.isAlive }); }

  acquire() {
    return this.#mutex(() => {
      const cur = this.#read();
      if (cur && cur.leaseId !== this.leaseId && this.#live(cur)) throw Object.assign(new Error(`agent ${this.agentId} has a live autopilot in process ${cur.pid} (epoch ${cur.epoch})`), { code: 'AlreadyRunning', holder: { pid: cur.pid, epoch: cur.epoch } });
      const epoch = (cur?.epoch ?? 0) + (cur?.leaseId === this.leaseId ? 0 : 1);
      const lease = { agentId: this.agentId, leaseId: this.leaseId, pid: this.pid, epoch, heartbeatAt: this.now(), takenOver: cur && cur.leaseId !== this.leaseId ? { pid: cur.pid, epoch: cur.epoch, leaseId: cur.leaseId } : null };
      writeDurable(this.file, JSON.stringify(lease));
      this.epoch = epoch;
      return { ...lease };
    });
  }

  renew() {
    return this.#mutex(() => {
      const cur = this.#read();
      if (!cur || cur.leaseId !== this.leaseId) throw Object.assign(new Error('this process no longer holds the lease'), { code: 'LeaseLost' });
      writeDurable(this.file, JSON.stringify({ ...cur, heartbeatAt: this.now() }));
      return true;
    });
  }

  check() { const cur = this.#read(); return !!cur && cur.leaseId === this.leaseId && this.now() - cur.heartbeatAt < this.ttlMs; }

  release() {
    return this.#mutex(() => { const cur = this.#read(); if (cur?.leaseId === this.leaseId && existsSync(this.file)) unlinkSync(this.file); });
  }

  /** Whether `leaseId` is the live lease of this agent (for the cost ledger's recovery of a crashed holder's items). */
  static liveLeaseIds({ dir, now = () => Date.now(), ttlMs = 30_000, isAlive = pidAlive, files }) {
    const live = new Set();
    for (const f of files) {
      try { const l = JSON.parse(readFileSync(join(dir, f), 'utf8')); if (isAlive(l.pid) && now() - l.heartbeatAt < ttlMs) live.add(l.leaseId); } catch { /* not a lease */ }
    }
    return live;
  }
}
