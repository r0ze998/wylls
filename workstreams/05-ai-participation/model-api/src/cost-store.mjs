// The inference cost ledger shared BETWEEN PROCESSES on one machine: the same rules as RunCostMock (it is one, re-read
// and written back), but every operation runs under a file mutex on the ledger file, so two processes cannot both take
// the last unit of a cap or of the balance, and a reservation is never lost between processes.
//
//   - every reservation records its holder (the process lease, process-lease.mjs); with a lease, a reservation is
//     refused unless the lease is still this process's (LeaseLost): a process that was taken over cannot spend
//   - recoverStale(): items whose holder is no longer a live lease get the restart rule — calling → UNDECIDED (the
//     provider may have billed), reserved-but-not-called → released. Never released, never 0, for anything sent
//   - writes are durable (fsync, then rename): a reader sees the old ledger or the new one, never a torn one
//
// Still a MOCK of ④'s cost contract (in test-USDC base units, model inference only), and one machine only: processes
// on other machines need a shared store (④'s run store). The relay's own ledger (game prices) is apart and unchanged.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessLease } from './process-lease.mjs';
import { RunCostMock } from './run-cost.mjs';
import { withFileMutex, writeDurable } from './file-mutex.mjs';

const big = v => BigInt(v ?? 0);

export class FileCostLedger {
  /**
   * @param {object} o
   * @param {string} o.dir             the directory shared by the processes (ledger.json, lease files)
   * @param {object} [o.init]          {available, caps} for a ledger that does not exist yet
   * @param {ProcessLease} [o.lease]   this process's lease (reservations are fenced by it)
   */
  constructor({ dir, init = null, lease = null, now = () => Date.now() }) {
    Object.assign(this, { dir, lease, now });
    this.file = join(dir, 'ledger.json');
    this.status = 'MOCK of ④ (cost contract): shared between processes on one machine, file-locked';
    if (init) withFileMutex(this.file, () => { if (!existsSync(this.file)) writeDurable(this.file, JSON.stringify(new RunCostMock({ ...init, now }).toJSON())); });
    this.m = this.#load();
  }

  #load() { return RunCostMock.fromJSON(JSON.parse(readFileSync(this.file, 'utf8')), { now: this.now, applyRestart: false }); }
  /** One transaction: read the ledger, apply `fn`, write it back (unless read only). */
  #tx(fn, { write = true } = {}) {
    return withFileMutex(this.file, () => {
      const m = this.#load();
      const r = fn(m);
      if (write) writeDurable(this.file, JSON.stringify(m.toJSON()));
      this.m = m;
      return r;
    });
  }
  #fence() { if (this.lease && !this.lease.check()) throw Object.assign(new Error('this process no longer holds the agent\'s lease: no reservation'), { code: 'LeaseLost' }); }

  reserve(key, amount) {
    return this.#tx(m => {
      this.#fence();
      const it = m.reserve(key, amount);
      m.items.get(key).holder = this.lease?.leaseId ?? null;
      return { ...it, holder: this.lease?.leaseId ?? null };
    });
  }
  calling(key) { return this.#tx(m => m.calling(key)); }
  settle(key, measured, note) { return this.#tx(m => m.settle(key, measured, note)); }
  release(key, reason) { return this.#tx(m => m.release(key, reason)); }
  undecided(key, why) { return this.#tx(m => m.undecided(key, why)); }
  decide(key, o) { return this.#tx(m => m.decide(key, o)); }
  setGameReserve(a) { return this.#tx(m => m.setGameReserve(a)); }
  compact(o) { return this.#tx(m => m.compact(o)); }
  /** Change caps (the owner's act): persisted for every process. */
  setCaps(caps) { return this.#tx(m => { Object.assign(m.caps, caps); return { ...m.caps }; }); }

  check(amount) { return this.#tx(m => m.check(amount), { write: false }); }
  classes() { return this.#tx(m => m.classes(), { write: false }); }
  fourClasses() { return this.#tx(m => m.fourClasses(), { write: false }); }
  get items() { return this.#tx(m => m.items, { write: false }); }
  get caps() { return { ...this.#tx(m => m.caps, { write: false }) }; }
  get overruns() { return this.m.overruns; }

  /**
   * After a crash: items held by a process whose lease is no longer live get the restart rule (calling → undecided,
   * reserved → released). Items without a holder (written by a lease-less process) are left alone.
   */
  recoverStale({ ttlMs = 30_000, isAlive } = {}) {
    const files = readdirSync(this.dir).filter(f => /^lease-.*\.json$/.test(f));
    const live = ProcessLease.liveLeaseIds({ dir: this.dir, now: this.now, ttlMs, ...(isAlive ? { isAlive } : {}), files });
    if (this.lease) live.add(this.lease.leaseId);
    return this.#tx(m => {
      const out = { undecided: [], released: [] };
      for (const it of m.items.values()) {
        if (!it.holder || live.has(it.holder)) continue;
        if (it.state === 'calling') { Object.assign(it, { state: 'undecided', why: `holder ${it.holder} gone while calling` }); out.undecided.push(it.key); }
        else if (it.state === 'reserved') { m.available += big(it.amount); Object.assign(it, { state: 'released', reason: `holder ${it.holder} gone before calling` }); out.released.push(it.key); }
      }
      return out;
    });
  }
}
