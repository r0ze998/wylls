// A small JSON store for the MCP server's own records (OAuth clients,
// links, token hashes, plans, operations). One file, written atomically
// (temporary file, fsync, rename) after every change, so a restart reads
// the last complete state. Without a file it lives in memory (tests).
// Nothing here is a secret in the clear: tokens are kept as SHA-256
// hashes and the agent capability only sealed (seal.mjs).
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

export const EMPTY = Object.freeze({ v: 1, clients: {}, links: {}, codes: {}, tokens: {}, refresh: {}, nonces: {}, seen: {}, plans: {}, operations: {} });

export class JsonStore {
  constructor(file = null) {
    this.file = file;
    this.state = structuredClone(EMPTY);
    if (file && existsSync(file)) this.state = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(file, 'utf8')) };
    this.writes = 0;
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
