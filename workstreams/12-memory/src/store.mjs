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
// - a rollback fact must name a fact that exists.
// A torn final line (a crash mid-write) is ignored on reload and counted in `j.torn`.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, sha256hex } from './records.mjs';

export class Journal {
  constructor(path = null) {
    this.path = path;
    this.list = [];
    this.byId = new Map();
    this.rejects = [];
    this.torn = 0;
  }

  static open(path = null) {
    const j = new Journal(null);
    if (path && existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line) return;
        let row;
        try { row = JSON.parse(line); } catch {
          if (i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1] === '')) { j.torn++; return; }
          throw new Error(`journal: corrupt line ${i + 1} in ${path}`);
        }
        if (row.rejected) j.rejects.push(row.rejected); else j._keep(row.record);
      });
    }
    j.path = path;
    return j;
  }

  _write(row) {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(row)}\n`);
  }
  _keep(rec) { this.list.push(rec); this.byId.set(rec.id, rec); }
  _reject(rec, reason) {
    const r = { id: rec?.id ?? null, type: rec?.type ?? null, reason };
    this.rejects.push(r);
    this._write({ rejected: r });
    return { status: reason === 'collision' ? 'collision' : 'refused', id: r.id, reason };
  }

  append(rec) {
    const prev = this.byId.get(rec.id);
    if (prev) {
      if (rec.type === 'fact' && prev.body_sha !== rec.body_sha) return this._reject(rec, 'collision');
      return { status: 'duplicate', id: rec.id };
    }
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
    this._keep(rec);
    this._write({ record: rec });
    return { status: 'added', id: rec.id };
  }

  records() { return [...this.list]; }
  get(id) { return this.byId.get(id) ?? null; }
  rejected() { return [...this.rejects]; }
  sha256() { return sha256hex(canonical(this.list)); }
}
