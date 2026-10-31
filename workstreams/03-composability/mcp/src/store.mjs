// A small JSON store for the MCP server's own records (OAuth clients,
// links, token hashes, plans, operations). One file, written atomically
// (temporary file, fsync, rename) after every change, so a restart reads
// the last complete state. Without a file it lives in memory (tests).
// Nothing here is a secret in the clear: tokens are kept as SHA-256
// hashes and the agent capability only sealed (seal.mjs).
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, readSync, existsSync, chmodSync, fstatSync } from 'node:fs';
import path from 'node:path';

export const EMPTY = Object.freeze({ v: 1, clients: {}, links: {}, codes: {}, tokens: {}, refresh: {}, nonces: {}, seen: {}, plans: {}, operations: {} });

export class JsonStore {
  constructor(file = null) {
    this.file = file;
    this.state = structuredClone(EMPTY);
    if (file && existsSync(file)) this.state = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(file, 'utf8')) };
    this.writes = 0;
    // Finished operations leave the file the server rewrites after every change for an append-only archive beside it
    // (`<file>.archive.jsonl`): a world that never resets keeps every operation, and rewriting all of them on each
    // change would grow without bound. Lines are only ever appended; none is rewritten or removed. In memory: an
    // index of where each line is (id, link, request, time), not the operations themselves.
    this.archiveFile = file ? `${file}.archive.jsonl` : null;
    this.archived = new Map();
    this.memoryArchive = file ? null : [];
    if (this.archiveFile && existsSync(this.archiveFile)) this.#indexArchive();
  }

  #indexArchive() {
    const buf = readFileSync(this.archiveFile);
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue;
      if (i > start) {
        // A line cut by a crash mid-append is skipped (its operation is still in the main file: see archive()).
        try { this.#remember(JSON.parse(buf.subarray(start, i).toString('utf8')), start, i - start); } catch { /* torn line */ }
      }
      start = i + 1;
    }
  }

  #remember(op, offset, length) {
    this.archived.set(op.id, { offset, length, linkId: op.linkId, requestId: op.requestId, createdAt: op.createdAt });
  }

  /**
   * Moves a finished operation to the archive: appended and synced first, then removed from the main state (the caller
   * saves). A crash between the two leaves it in both; the main state's copy is the one read, and the archive's line
   * is a duplicate of the same final record.
   */
  archive(op) {
    const line = `${JSON.stringify(op)}\n`;
    if (!this.archiveFile) { this.memoryArchive.push(line); this.#remember(op, this.memoryArchive.length - 1, -1); delete this.state.operations[op.id]; return; }
    mkdirSync(path.dirname(this.archiveFile), { recursive: true });
    const fd = openSync(this.archiveFile, 'a', 0o600);
    try {
      const offset = fstatSync(fd).size;
      writeSync(fd, line);
      fsyncSync(fd);
      this.#remember(op, offset, Buffer.byteLength(line) - 1);
    } finally { closeSync(fd); }
    delete this.state.operations[op.id];
  }

  /** An operation by id: the main state's, else the archive's (read from its line), else null. */
  operation(id) {
    if (this.state.operations[id]) return this.state.operations[id];
    const at = this.archived.get(id);
    if (!at) return null;
    if (!this.archiveFile) return JSON.parse(this.memoryArchive[at.offset]);
    const fd = openSync(this.archiveFile, 'r');
    try {
      const b = Buffer.alloc(at.length);
      readSync(fd, b, 0, at.length, at.offset);
      return JSON.parse(b.toString('utf8'));
    } finally { closeSync(fd); }
  }

  /** The newest operations of these links, main and archived together (main wins a duplicate), at most `limit`. */
  operationsOf(linkIds, limit) {
    const ids = new Set(linkIds);
    const hot = Object.values(this.state.operations).filter(o => ids.has(o.linkId));
    const seen = new Set(hot.map(o => o.id));
    const cold = [...this.archived].filter(([id, x]) => ids.has(x.linkId) && !seen.has(id)).map(([id, x]) => ({ id, createdAt: x.createdAt }));
    const all = [...hot, ...cold].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
    return all.map(o => (o.state ? o : this.operation(o.id)));
  }

  /** Writes the whole state (synchronous: no other change can interleave). */
  save() {
    this.writes++;
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}
