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
    // runId (2026-11-17) is read from the same line, so an archive written before it was indexed gets it on the next
    // start too (#indexArchive): nothing is rewritten or migrated.
    this.archived.set(op.id, { offset, length, linkId: op.linkId, requestId: op.requestId, createdAt: op.createdAt, runId: op.runId ?? null });
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
    // Read and append ('a+': every write still goes to the end). (2026-11-17) A line cut by an earlier crash leaves the
    // file without a final newline: the new record then starts on a line of its own (one newline written before it,
    // in the same write), so the cut bytes stay a separate, skipped line instead of joining the new record into one
    // line that no longer parses after a restart. No byte already in the file is changed or removed.
    const fd = openSync(this.archiveFile, 'a+', 0o600);
    try {
      const size = fstatSync(fd).size;
      let sep = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        if (readSync(fd, last, 0, 1, size - 1) !== 1) throw new Error('archive: the last byte could not be read');
        if (last[0] !== 0x0a) sep = '\n';
      }
      // writeSync answers how many bytes it wrote: a short write is not success. Anything less than the whole
      // separator + record is refused before the sync, the index or the delete, so the operation stays in the main
      // state; the bytes that did reach the file stay (append-only) as a cut tail, which the next archive closes with
      // its separator, as above.
      const bytes = Buffer.from(sep + line, 'utf8');
      const wrote = writeSync(fd, bytes, 0, bytes.length);
      if (wrote !== bytes.length) throw new Error(`archive: wrote ${wrote} of ${bytes.length} bytes; nothing moved`);
      fsyncSync(fd);
      this.#remember(op, size + sep.length, Buffer.byteLength(line) - 1);
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
  /** Operations (main store and archive) of these links sent with `requestId`: one id each, newest first. */
  operationsWithRequestId(linkIds, requestId) {
    const ids = new Set(linkIds);
    const hot = Object.values(this.state.operations).filter(o => ids.has(o.linkId) && o.requestId === requestId).map(o => o.id);
    const cold = [...this.archived].filter(([id, x]) => ids.has(x.linkId) && x.requestId === requestId && !hot.includes(id)).map(([id]) => id);
    return [...hot, ...cold];
  }

  operationsOf(linkIds, limit) {
    const ids = new Set(linkIds);
    const hot = Object.values(this.state.operations).filter(o => ids.has(o.linkId));
    const seen = new Set(hot.map(o => o.id));
    const cold = [...this.archived].filter(([id, x]) => ids.has(x.linkId) && !seen.has(id)).map(([id, x]) => ({ id, createdAt: x.createdAt }));
    const all = [...hot, ...cold].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
    return all.map(o => (o.state ? o : this.operation(o.id)));
  }

  /**
   * These links' operations sent with `runId` (main store and archive together, main wins a duplicate), newest first,
   * at most `limit`, and `total`: how many there are. The run is chosen first (2026-11-17): operationsOf(…, limit)
   * filtered afterwards dropped a run whose operations were older than `limit` operations of other runs. Only the
   * returned archived operations are read from their lines; the rest are counted from the index.
   */
  operationsOfRun(linkIds, runId, limit) {
    const ids = new Set(linkIds);
    const hot = Object.values(this.state.operations).filter(o => ids.has(o.linkId) && o.runId === runId);
    const seen = new Set(hot.map(o => o.id));
    const cold = [...this.archived].filter(([id, x]) => ids.has(x.linkId) && x.runId === runId && !seen.has(id)).map(([id, x]) => ({ id, createdAt: x.createdAt }));
    const all = [...hot, ...cold].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { operations: all.slice(0, limit).map(o => (o.state ? o : this.operation(o.id))), total: all.length };
  }

  /** Writes the whole state (synchronous: no other change can interleave). */
  save() {
    this.writes++;
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      // (2026-11-17) writeSync answers how many bytes it wrote: a short or zero write is refused here, before the
      // rename, so the last complete state file stays as it was and the next load reads it. The partial temporary
      // file is left as it is (it is never read: only `this.file` is loaded; the next save rewrites it with 'w').
      const bytes = Buffer.from(JSON.stringify(this.state), 'utf8');
      const wrote = writeSync(fd, bytes, 0, bytes.length);
      if (wrote !== bytes.length) throw new Error(`store: wrote ${wrote} of ${bytes.length} bytes; the state file was not replaced`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}
