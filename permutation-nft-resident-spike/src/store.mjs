// State persistence: one JSON file written atomically (tmp + rename, as the
// relay's createStateStore), or memory only. Every module keeps its records
// under its own key of `state`, so one file holds the registry, the
// credentials, the world and the entry desk together and a restart reloads
// them all at the same point.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const replacer = (_, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v);
const reviver = (_, v) => (v && typeof v === 'object' && typeof v.$big === 'string' ? BigInt(v.$big) : v);

export class MemoryStore {
  constructor(state = {}) { this.state = state; this.saves = 0; }
  save() { this.saves++; }
  /** A second store over a copy of this state, as a process restarted from the same file would see it. */
  reopen() { return new MemoryStore(JSON.parse(JSON.stringify(this.state, replacer), reviver)); }
}

export class FileStore {
  constructor(file) {
    this.file = file;
    this.saves = 0;
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'), reviver) : {};
  }
  save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, replacer, 2));
    renameSync(tmp, this.file);
    this.saves++;
  }
  reopen() { return new FileStore(this.file); }
}
