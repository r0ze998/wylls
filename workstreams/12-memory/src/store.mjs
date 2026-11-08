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
// append can be retried (it is not mistaken for a duplicate of a record that never reached the file).
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
  }

  static open(path = null, { keys = {} } = {}) {
    const j = new Journal(null, { keys });
    if (path && existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      const lines = text.split('\n');
      const parse = l => { try { return JSON.parse(l); } catch { return undefined; } };
      lines.forEach((line, i) => {
        if (!line) return;
        const row = parse(line);
        if (row === undefined) {
          const next = parse(lines[i + 1] ?? '');
          // a torn line named by the marker written right after it (an earlier reload saw it torn)
          if (next?.torn && next.torn.line === i + 1 && next.torn.sha256 === sha256hex(line)) { j.torn++; return; }
          if (i === lines.length - 1) { j.torn++; j.tornTail = { line: i + 1, sha256: sha256hex(line) }; return; }
          // as before: an unreadable last line that does end in a newline is also taken as torn (now named, too)
          if (i === lines.length - 2 && lines[lines.length - 1] === '') { j.torn++; j.tornTail = { line: i + 1, sha256: sha256hex(line), closed: true }; return; }
          throw new Error(`journal: corrupt line ${i + 1} in ${path}`);
        }
        if (row.torn) return; // the marker itself
        if (row.rejected) { j.rejects.push(row.rejected); return; }
        if (row.record.type === 'allocation') {
          const bad = verifyAllocation(row.record, keys);
          if (bad) throw new Error(`journal: allocation ${row.record.id} on line ${i + 1} fails verification (${bad})`);
        }
        j._keep(row.record);
      });
    }
    j.path = path;
    return j;
  }

  _write(row) {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    // after a reload that found a torn last line: close it with a newline and name it, in the same write
    const t = this.tornTail;
    const pre = t ? `${t.closed ? '' : '\n'}${JSON.stringify({ torn: { line: t.line, sha256: t.sha256 } })}\n` : '';
    appendFileSync(this.path, `${pre}${JSON.stringify(row)}\n`);
    this.tornTail = null;
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
