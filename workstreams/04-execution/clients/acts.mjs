// Workstream 04's act registry, for workstreams 03 (MCP), 05 (autopilot) and 13 (residents).
//
// The registry is workstream 04's run store (SQLite); this client runs its command
// `runexec act …` (no shell, arguments as a list) and returns the JSON it prints. It
// registers acts and reads their state; it never sends, signs or holds a key. Sending stays
// the agent wallet's (`POST /f/agent/action`); the state comes from the wallet's read-only
// `GET /f/agent/fate`, read by runexec on 127.0.0.1.
//
//   const acts = createActsClient({ bin: '/path/to/runexec', db: '/path/to/runs.db', gatewayPort: 8790 });
//   const r = await acts.register({ agentId, key: 'ai:p05.r1', source: 'ai', runId: 'p05-run-1' });
//   // … then POST /f/agent/action with the same idempotencyKey …
//   const s = await acts.status({ agentId, key: 'ai:p05.r1' });     // reads the wallet, records, answers
//   if (s.newAttemptAllowed) { /* only then: a NEW attempt under a NEW key */ }
//
// The seven states (docs/EXECUTION-CONTRACT-20261106.ja.md §1): not-sent, landed, failed, expired
// (final); pending (wait); unknown = result unknown (hold: it may have landed, never send again);
// unqueryable = could not ask (read again; says nothing about the act). Before the first read the
// state is `registered`. `next` says the same as one word: done | new-attempt | wait | hold | read-again.
import { execFile } from 'node:child_process';

export const SOURCES = Object.freeze(['ai', 'mcp', 'browser', 'resident']);

/** A refusal from the command: `code` is BadRequest | NoRecord | Conflict | StoreError | Spawn. */
export class ActsError extends Error {
  constructor(code, message, exit) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20, shell: false }, (err, stdout) => {
      const line = String(stdout ?? '').trim().split('\n').at(-1) ?? '';
      let v = null;
      try { v = line ? JSON.parse(line) : null; } catch { v = null; }
      if (!err) return v ? resolve(v) : reject(new ActsError('StoreError', 'runexec printed no JSON', 0));
      if (v?.error) return reject(new ActsError(v.error, v.message ?? v.error, err.code));
      reject(new ActsError('Spawn', String(err.message ?? err), err.code));
    });
  });
}

/**
 * @param {object} o
 * @param {string} o.bin          the runexec binary
 * @param {string} o.db           the run store (the same file the run executor uses)
 * @param {number} [o.gatewayPort] the agent wallet's port on 127.0.0.1 (omit: answer from the store only)
 * @param {boolean} [o.bridge]    workstream 04's test bridge (`/fate?key=`) instead of the wallet's route
 * @param {number} [o.timeoutMs]
 */
export function createActsClient({ bin, db, gatewayPort = null, bridge = false, timeoutMs = 15_000 }) {
  if (!bin || !db) throw new Error('bin and db are required');
  const base = ['act'];
  const tail = ['--db', db];
  const who = q => (q.run4Id ? ['--run4', q.run4Id] : ['--agent', q.agentId, '--key', q.key]);
  return {
    /** Registers an act before (or after) its POST /f/agent/action. Idempotent; Conflict for another source/run. */
    register({ agentId, key, source, runId = null, slot = 0 }) {
      if (!SOURCES.includes(source)) return Promise.reject(new ActsError('BadRequest', `source must be one of ${SOURCES.join(', ')}`, 2));
      const a = [...base, 'register', '--agent', agentId, '--key', key, '--source', source, '--slot', String(slot), ...(runId ? ['--run', runId] : []), ...tail];
      return run(bin, a, timeoutMs);
    },
    /**
     * The act's receipt. With a gateway port (and `read` not false) the wallet is read once and the answer
     * recorded; a failed read is `unqueryable` with what was known kept. Rejects NoRecord for an act never registered.
     */
    status(q, { read = true } = {}) {
      const g = read && gatewayPort ? ['--gateway', String(gatewayPort), ...(bridge ? ['--bridge'] : [])] : [];
      return run(bin, [...base, 'status', ...who(q), ...g, ...tail], timeoutMs);
    },
    /** Every act registered under a caller's run id. */
    list(runId) {
      return run(bin, [...base, 'list', '--run', runId, ...tail], timeoutMs);
    },
  };
}

/** True only when nothing happened and a NEW attempt (new key) may be made: not-sent, expired. */
export const mayStartNewAttempt = r => r?.newAttemptAllowed === true;

/**
 * Workstream 13's execution port `status(key)` from a receipt (13's 03-contracts §3, 08-retention-contract R4/R5):
 * fate pending | landed | failed | cancelled | unknown. `cancelled` = nothing took effect and it never will
 * (not-sent, expired). Could not ask → throws (R5: a temporary inability is an exception, never null).
 * Use `statusFor13` to get `null` for "no record".
 */
export function toWs13Status(r) {
  const fate = { landed: 'landed', failed: 'failed', expired: 'cancelled', 'not-sent': 'cancelled', pending: 'pending', registered: 'pending', unknown: 'unknown' }[r.state];
  if (!fate) throw new ActsError('Unqueryable', `the act's state could not be read: ${r.why ?? r.lastReadError ?? r.state}`, 0);
  return { requestId: r.idempotencyKey, agentId: r.agentId, status: r.state === 'not-sent' ? 'refused' : 'sent', signature: r.signature ?? undefined, fate, fateError: r.state === 'failed' ? (r.why ?? 'failed') : undefined, retentionBells: r.retention?.retentionBells ?? null };
}

/** 13's `status(key)`: null only when the key was never registered (R5), else toWs13Status (throws when unreadable). */
export async function statusFor13(client, agentId, key) {
  try {
    return toWs13Status(await client.status({ agentId, key }));
  } catch (e) {
    if (e instanceof ActsError && e.code === 'NoRecord') return null;
    throw e;
  }
}

/** Workstream 05's RunReceipt act fields that only 04 gives (p05-port/0.1 `from4`), from a receipt. */
export function toP05Act(r) {
  return {
    run4Id: r.run4Id, idempotencyKey: r.idempotencyKey, source: r.source, signature: r.signature ?? null,
    signedAt: r.signedAt ?? null, fate: r.state, commitment: r.commitment ?? null, cancellable: false,
    cancel: { stage: r.cancel?.stage ?? null, result: r.cancel?.result ?? null, until: r.cancel?.until ?? null },
  };
}
