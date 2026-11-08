// Workstream 12: the append-only journal.
//
//   const j = Journal.open(path?)      in memory when no path; else replays the JSONL file (a restart)
//   j.append(record) -> {status: 'added'|'duplicate'|'collision'|'refused', id, reason?}
//   j.records()                        every kept record, in append order
//   j.rejected()                       what was refused or collided (kept for audit, never folded)
//   j.sha256()                         hash of the canonical kept list (restart equality)
//
// Rules enforced here, whatever the caller does:
// - nothing is deleted or rewritten; a correction or a rollback is a new record;
// - a fact's id comes from its chain reference, so a duplicate delivery is a no-op and a different body under
//   the same reference is a collision (the first is kept, the second is recorded as rejected);
// - a correction may only target a note OF THE SAME OWNER (an AI cannot "correct" a chain fact or another's words);
// - a rollback fact must name a fact that exists;
// - an allocation must carry a valid ed25519 signature of its signer (the key registry `keys`, tag -> public key
//   hex, comes from the caller: the roster), and a signer's nonce is used once: the same signed operation again is
//   a duplicate, other content under a used nonce is refused (`nonce_reused`).
// Signatures are verified again when a journal is replayed, so an edited file cannot slip an allocation in.
// A torn final line (a crash mid-write) is ignored on reload and counted in `j.torn`. Its bytes are never removed or
// rewritten: the first write after such a reload starts a new line and records a `{torn: {line, sha256}}` marker
// naming it, so later reloads skip exactly that line (and nothing appended after it is fused with it and lost).
// A record is kept in memory only after its line is written: a failed write leaves memory as it was, and the same
// append can be retried (it is not mistaken for a duplicate of a record that never reached the file). A write that
// failed part-way leaves unknown bytes: the next write reads the tail again and names what it finds there first.
// Unreadable lines are taken in runs: a run at the end of the file is a torn tail (one crash, or more crashes while
// naming it); any other run must be named, line and bytes, by the markers right after it, or the journal is refused.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, sha256hex, verifyAllocation } from './records.mjs';

export class Journal {
  constructor(path = null, { keys = {} } = {}) {
    this.path = path;
    this.keys = keys;
    this.list = [];
    this.byId = new Map();
    this.nonces = new Map(); // "signer#nonce" -> allocation id
    this.rejects = [];
    this.torn = 0;
    this.tornTail = null;
    this.openLine = false;
    this.dirty = false;
  }

  static open(path = null, { keys = {} } = {}) {
    const j = new Journal(null, { keys });
    if (path && existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      // a complete last line without its newline (cut right before it): the next write must not run onto it
      j.openLine = text.length > 0 && !text.endsWith('\n');
      const lines = text.split('\n');
      const parse = l => { try { return JSON.parse(l); } catch { return undefined; } };
      const rows = lines.map(l => (l ? parse(l) : null)); // null: empty, undefined: unreadable
      let last = lines.length - 1;
      while (last >= 0 && !lines[last]) last--;
      const unreadable = [];
      // Unreadable lines come in runs (one crash, or a crash while the next write was naming the first). A run that
      // reaches the end of the file is a torn tail. Any other run must be named, line and bytes, by the {torn} markers
      // that follow it (a later write named them); otherwise it is damage, and the journal is refused.
      for (let i = 0; i <= last; i++) {
        if (rows[i] !== undefined) continue;
        let e = i;
        while (e + 1 <= last && (rows[e + 1] === undefined || rows[e + 1] === null)) e++;
        const run = [];
        for (let k = i; k <= e; k++) if (rows[k] === undefined) run.push({ line: k + 1, sha256: sha256hex(lines[k]) });
        if (e === last) { j.torn += run.length; j.tornTail = { lines: run, closed: text.endsWith('\n') }; break; }
        const named = new Set();
        for (let k = e + 1; k <= last && (rows[k] === null || rows[k]?.torn); k++) if (rows[k]?.torn) named.add(`${rows[k].torn.line}|${rows[k].torn.sha256}`);
        const unnamed = run.find(t => !named.has(`${t.line}|${t.sha256}`));
        if (unnamed) throw new Error(`journal: corrupt line ${unnamed.line} in ${path}`);
        j.torn += run.length;
        unreadable.push(...run.map(t => t.line - 1));
        i = e;
      }
      const skip = new Set(unreadable);
      lines.forEach((line, i) => {
        if (!line || skip.has(i) || rows[i] === undefined) return;
        const row = rows[i];
        if (!row || typeof row !== 'object' || !(row.torn || row.rejected || (row.record && typeof row.record === 'object'))) throw new Error(`journal: corrupt line ${i + 1} in ${path}`);
        if (row.torn) return; // the marker itself
        if (row.rejected) { j.rejects.push(row.rejected); return; }
        if (row.record.type === 'allocation') {
          const bad = verifyAllocation(row.record, keys);
          if (bad) throw new Error(`journal: allocation ${row.record.id} on line ${i + 1} fails verification (${bad})`);
        }
        // the same row twice (a write that reached the file although it reported a failure, then its retry):
        // kept once; another body under the same id is a collision, as on append
        const prev = j.byId.get(row.record.id);
        if (prev) { if (row.record.type === 'fact' && prev.body_sha !== row.record.body_sha) j.rejects.push({ id: row.record.id, type: 'fact', reason: 'collision' }); return; }
        j._keep(row.record);
      });
    }
    j.path = path;
    return j;
  }

  /** After a write that failed (possibly part-way), the bytes at the end are unknown: read the tail again. */
  _rescanTail() {
    this.dirty = false;
    if (!existsSync(this.path)) return;
    const text = readFileSync(this.path, 'utf8');
    const lines = text.split('\n');
    let last = lines.length - 1;
    while (last >= 0 && !lines[last]) last--;
    const parse = l => { try { return JSON.parse(l); } catch { return undefined; } };
    const run = [];
    for (let k = last; k >= 0 && (!lines[k] || parse(lines[k]) === undefined); k--) if (lines[k]) run.unshift({ line: k + 1, sha256: sha256hex(lines[k]) });
    this.tornTail = run.length ? { lines: run } : null;
    this.openLine = text.length > 0 && !text.endsWith('\n');
  }

  _write(row) {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    if (this.dirty) this._rescanTail();
    // after a reload that found a torn last line: close it with a newline and name it, in the same write
    const t = this.tornTail;
    const pre = (this.openLine ? '\n' : '') + (t ? t.lines.map(x => `${JSON.stringify({ torn: { line: x.line, sha256: x.sha256 } })}\n`).join('') : '');
    try { (this._appendFile ?? appendFileSync)(this.path, `${pre}${JSON.stringify(row)}\n`); } catch (e) { this.dirty = true; throw e; }
    this.tornTail = null;
    this.openLine = false;
  }
  _keep(rec) { this.list.push(rec); this.byId.set(rec.id, rec); if (rec.type === 'allocation') this.nonces.set(rec.nonce_key, rec.id); }
  _reject(rec, reason) {
    const r = { id: rec?.id ?? null, type: rec?.type ?? null, reason };
    this.rejects.push(r);
    this._write({ rejected: r });
    return { status: reason === 'collision' ? 'collision' : 'refused', id: r.id, reason };
  }

  append(rec) {
    if (rec.type === 'allocation') {
      const bad = verifyAllocation(rec, this.keys);
      if (bad) return this._reject(rec, bad);
    }
    const prev = this.byId.get(rec.id);
    if (prev) {
      if (rec.type === 'fact' && prev.body_sha !== rec.body_sha) return this._reject(rec, 'collision');
      return { status: 'duplicate', id: rec.id };
    }
    if (rec.type === 'allocation' && this.nonces.has(rec.nonce_key)) return this._reject(rec, 'nonce_reused');
    if (rec.type === 'correction') {
      const t = this.byId.get(rec.target);
      if (!t) return this._reject(rec, 'correction_target_unknown');
      if (t.type !== 'note' || t.owner !== rec.owner) return this._reject(rec, 'correction_not_own_note');
    }
    if (rec.type === 'fact' && rec.kind === 'rollback') {
      const t = this.byId.get(rec.data.fact);
      if (!t || t.type !== 'fact') return this._reject(rec, 'rollback_target_unknown');
      // a rollback is seen by exactly those who saw the fact: a public rollback of a private fact would leak it
      if (canonical(t.visibility) !== canonical(rec.visibility)) return this._reject(rec, 'rollback_visibility_mismatch');
    }
    this._write({ record: rec }); // first the file: if this throws, memory is unchanged and the append can be retried
    this._keep(rec);
    return { status: 'added', id: rec.id };
  }

  records() { return [...this.list]; }
  /** The position of a record in append order (what had reached memory before it). */
  indexOf(id) { return this.list.findIndex(r => r.id === id); }
  get(id) { return this.byId.get(id) ?? null; }
  rejected() { return [...this.rejects]; }
  sha256() { return sha256hex(canonical(this.list)); }
}
