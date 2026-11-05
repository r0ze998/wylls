// ⑤'s acts as ④'s act runs: the registry contract of ④ 77c5cbe2 `workstreams/04-execution/src/acts.rs`
// (receipt `p04-acts/0.1`), followed rule for rule so that ⑤'s autopilot registers, reads and answers the same way.
//
// ④'s registry is a Rust library inside ④'s run executor (SQLite). It has no HTTP or command-line entry yet, so a
// JavaScript process cannot write into ④'s store. Until ④ opens one, this is the LOCAL ADAPTER of the same contract:
//   run4Id      `act-` + the first 16 hex of sha256(agentId ‖ 0x00 ‖ idempotencyKey)  (the same id ④ computes)
//   register    idempotent for the same (agent, key, source, runId); another source or runId under a key is REFUSED
//   refresh     one GET /f/agent/fate read, recorded:
//                 - a failed read: `unqueryable` beside the facts already known (a final state is not touched)
//                 - a final state (landed, failed, expired, not-sent) never changes; a contradicting read is kept as
//                   `conflict` for the operator, not applied
//                 - facts already known (signature, lastValidBlockHeight, slotFloor, signedAt) are kept when a later
//                   read lacks them (the wallet keeps only its latest entries)
//   receipt     ④'s receipt fields and names (run4Id, signedAt, cancel.until = {lastValidBlockHeight}, retention)
//   retention   nothing is deleted (retentionBells: null)
// Differences from ④'s, stated in every receipt (`provenance`): the store is a JSON file under ⑤'s file mutex, and
// `registeredSlot` is null (⑤ reads no slot; ④'s register takes one).
//
// Several processes may share the directory: every change is one transaction under the file mutex, written whole.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileMutex, writeDurable } from './file-mutex.mjs';
import { FINAL_STATES } from './fate-reader.mjs';

export const ACTS_RECEIPT_VERSION = 'p04-acts/0.1';
export const RETENTION_BELLS = null;
const FACT_KEYS = ['signature', 'lastValidBlockHeight', 'slotFloor', 'signedAt'];

/** ④'s act run id: stable for (agent, key). */
export function run4IdOf(agentId, key) {
  return `act-${createHash('sha256').update(Buffer.from(String(agentId), 'utf8')).update(Buffer.from([0])).update(Buffer.from(String(key), 'utf8')).digest('hex').slice(0, 16)}`;
}

const err = (code, message) => Object.assign(new Error(message), { code });

export class FileActsRegistry {
  /** @param {object} o  @param {string} o.dir  @param {Function} [o.now] */
  constructor({ dir, now = () => Date.now() }) {
    mkdirSync(dir, { recursive: true });
    Object.assign(this, { dir, now, file: join(dir, 'acts.json'), lock: join(dir, 'acts.json.mutex') });
    this.provenance = '⑤ local adapter of ④ acts.rs (④\'s registry has no external entry yet)';
  }

  #load() { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { v: 1, acts: {} }; }
  #tx(fn) { return withFileMutex(this.lock, () => { const s = this.#load(); const out = fn(s); if (out?.write !== false) writeDurable(this.file, JSON.stringify(s)); return out?.value; }); }

  register({ agentId, key, source, runId = null }) {
    if (!agentId || !key || !source) throw err('BadAct', 'agent id, idempotency key and source are required');
    const id = run4IdOf(agentId, key);
    return this.#tx(s => {
      const r = s.acts[id];
      if (r) {
        if (r.source !== source || r.runId !== runId) throw err('ActConflict', `${id} is registered for source ${r.source} run ${r.runId}, not ${source} ${runId}`);
        return { value: id, write: false };
      }
      s.acts[id] = { run4Id: id, agentId, key, source, runId, registeredSlot: null, registeredAt: this.now(), state: 'registered', facts: {} };
      return { value: id };
    });
  }

  get(id) { const r = this.#load().acts[id]; return r ? structuredClone(r) : null; }
  byRun(runId) { return Object.values(this.#load().acts).filter(r => r.runId === runId).sort((a, b) => a.registeredAt - b.registeredAt || (a.run4Id < b.run4Id ? -1 : 1)); }
  open() { return Object.values(this.#load().acts).filter(r => !FINAL_STATES.includes(r.state)); }

  /**
   * One fate read, recorded by ④'s rules. `read` is a fateReader (never throws; a failed read is `unqueryable` with
   * `readError`), or a function that throws: both count as a failed read.
   */
  async refresh(id, read) {
    const row = this.get(id);
    if (!row) throw err('NoAct', `no act ${id}`);
    let v = null, readError = null;
    try { v = await read(row.agentId, row.key); } catch (e) { readError = String(e?.message ?? e); }
    if (v && v.state === 'unqueryable' && v.readError) readError = v.why ?? v.readError;
    this.#tx(s => {
      const r = s.acts[id];
      const wasFinal = FINAL_STATES.includes(r.state);
      if (readError !== null || !v) {
        if (wasFinal) return { write: false };
        r.facts = { ...r.facts, lastReadError: readError ?? 'no answer' };
        r.state = 'unqueryable';
        return {};
      }
      const state = v.state ?? 'unqueryable';
      if (wasFinal) {
        if (state !== r.state && state !== 'unqueryable') { r.facts = { ...r.facts, conflict: { state, why: v.why ?? null } }; return {}; }
        return { write: false };
      }
      const f = { ...v };
      for (const k of FACT_KEYS) if ((f[k] === null || f[k] === undefined) && r.facts[k] !== null && r.facts[k] !== undefined) f[k] = r.facts[k];
      r.facts = f;
      r.state = state;
      return {};
    });
    return this.receipt(id);
  }

  /** ④'s receipt (`p04-acts/0.1`) for one act, plus `provenance`. */
  receipt(id) {
    const r = this.get(id);
    if (!r) throw err('NoAct', `no act ${id}`);
    const f = r.facts ?? {};
    const fin = FINAL_STATES.includes(r.state);
    const sent = r.state !== 'not-sent' && (f.sent === true || typeof f.signature === 'string');
    const cancel = r.state === 'not-sent' ? { stage: 'before-sign', result: 'NotSent', until: null }
      : sent ? { stage: 'sent', result: 'Irrevocable', until: { lastValidBlockHeight: f.lastValidBlockHeight ?? null }, phase: fin ? 'Completed' : 'AwaitingSigned' }
        : { stage: 'signed-unsent', result: 'NotSupported', why: 'the gateway signs and sends in one step; 04 cannot stop a request it has handed over' };
    return {
      receiptVersion: ACTS_RECEIPT_VERSION, provenance: this.provenance,
      run4Id: r.run4Id, runId: r.runId, agentId: r.agentId, idempotencyKey: r.key, source: r.source, registeredSlot: r.registeredSlot,
      state: r.state, final: fin,
      signature: f.signature ?? null, signedAt: f.signedAt ?? null, lastValidBlockHeight: f.lastValidBlockHeight ?? null, slotFloor: f.slotFloor ?? null,
      commitment: f.commitment ?? null, why: f.why ?? null, lastReadError: f.lastReadError ?? null, conflict: f.conflict ?? null,
      cancellable: false, cancel, retention: { retentionBells: RETENTION_BELLS, deleted: false },
    };
  }
}
