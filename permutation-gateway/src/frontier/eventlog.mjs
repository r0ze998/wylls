// The relay's append-only event log (PT-A, the playtest): one JSON object per
// line in a local file (mode 0600), nothing else. It records only what the
// relay already holds: when invites were issued (their nonces, which are not
// redeemable codes, and a label such as "bots" or "friends-1"), and when a
// Join was sent (the invite's nonce, the wallet's public key, the
// transaction signature). No address, no name, no e-mail: a wallet is a
// pseudonym and is public on chain anyway. A failed write never fails a
// request (it is counted and reported once).
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export class EventLog {
  constructor(file, { now = Date.now, onError = e => console.error(`frontier relay: event log ${file}: ${e.message}`) } = {}) {
    this.file = file;
    this.now = now;
    this.onError = onError;
    this.errors = 0;
    this.written = 0;
    try { mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { this.fail(e); }
  }

  fail(e) {
    if (this.errors++ === 0) this.onError(e);
  }

  /** One line: `{"t": unix ms, "event": name, ...fields}`. */
  write(event, fields = {}) {
    try {
      appendFileSync(this.file, `${JSON.stringify({ t: this.now(), event, ...fields })}\n`, { mode: 0o600 });
      if (this.written++ === 0) chmodSync(this.file, 0o600);
    } catch (e) {
      this.fail(e);
    }
  }
}

/** The log when none is configured. */
export const NO_EVENTS = Object.freeze({ write() {}, errors: 0, written: 0 });
