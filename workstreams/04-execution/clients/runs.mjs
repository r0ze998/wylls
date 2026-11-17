// Workstream 04's run intake for the gateway (workstream 04, 2026-11-07): hands a caravan run and
// the requester the gateway authenticated to `runexec run accept` (no shell, arguments as a list).
//
// The gateway's credential layer (workstreams 03/05) establishes WHO asks: it verifies the
// request's signature and hands over the signer's key, the pass generation the request was signed
// for, and the Citizen the requester acts for. This client never signs, verifies or holds a key; it
// only passes those three facts on, with `authenticatedBy` naming the layer that verified them.
// runexec then reads the pass from the chain (`--rpc`, the game program and the Season) and admits
// the run only from the pass's current holder (the owner, or its live session in this generation):
// after an NFT transfer the old owner and the old session are refused (NotAuthorized, exit 5,
// nothing written). A run accepted before a transfer runs to its end (the owner's decision).
//
//   const runs = createRunsClient({ bin, db, rpc: 'http://127.0.0.1:8899', program, season });
//   const r = await runs.accept(spec, { actor, generation, citizen, authenticatedBy: 'gateway:ed25519-session' });
//   // r.accept is Created | Existing; r.detail… carries the check that admitted it
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A refusal: `code` is BadRequest | NotAuthorized | Conflict | StoreError | Spawn. */
export class RunsError extends Error {
  constructor(code, message, exit) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The requester file `run accept --requester` reads; throws BadRequest when a fact is missing. */
export function requesterFile({ actor, generation, citizen, authenticatedBy }) {
  if (typeof actor !== 'string' || !B58.test(actor)) throw new RunsError('BadRequest', 'requester.actor must be a base58 address (the authenticated signer)', 2);
  if (typeof citizen !== 'string' || !B58.test(citizen)) throw new RunsError('BadRequest', 'requester.citizen must be a base58 address (the Citizen acted for)', 2);
  if (!Number.isInteger(generation) || generation < 0 || generation > 0xffffffff) throw new RunsError('BadRequest', 'requester.generation must be the pass generation the request was signed for (u32)', 2);
  if (typeof authenticatedBy !== 'string' || !authenticatedBy.trim()) throw new RunsError('BadRequest', 'requester.authenticatedBy must name the credential layer that verified the signer', 2);
  return JSON.stringify({ actor, generation, citizen, authenticatedBy });
}

// (2026-11-17) runexec answers NoRecord only with exit 3 (workstream 4 src/main.rs: an opened store holds no such act or
// run). Before, the code was taken from the last JSON line whatever the exit, so a killed or timed-out process, a
// signal, an output over maxBuffer or another exit code whose last line said NoRecord was passed on as NoRecord —
// which a caller may take as "no such record" (workstream 13's ports answer it as null). Such an answer is
// now Spawn (no answer: read again), like a process that printed nothing usable. runexec's own NoRecord (exit 3, not
// killed, no signal), a normal answer (exit 0) and every other error code are unchanged. (Workstreams 6 and 13 apply
// the same rule to `run view`: 06 src/connect/ports.mjs, 13 resident/ports/ws04-run.mjs.)
const runexecNoRecord = err => err?.code === 3 && !err.killed && !err.signal;
const noRecordWithoutExit3 = err => `runexec said NoRecord without its exit 3 (exit ${err?.code ?? null}${err?.signal ? `, signal ${err.signal}` : ''}${err?.killed ? ', killed' : ''}): no answer`;

/**
 * @param {object} o
 * @param {string} o.bin      the runexec binary
 * @param {string} o.db       the run store
 * @param {string} o.rpc      http:// JSON-RPC endpoint the pass is read from (a local node or a loopback proxy)
 * @param {string} o.program  the game program (base58)
 * @param {string} o.season   the Season (base58)
 * @param {Function} [o.execFile] node:child_process execFile (the default); a stand-in only for a test
 */
export function createRunsClient({ bin, db, rpc, program, season, timeoutMs = 15_000, execFile = nodeExecFile }) {
  if (!bin || !db || !rpc || !program || !season) throw new Error('bin, db, rpc, program and season are required');
  return {
    accept(spec, requester, { slot = 0 } = {}) {
      let body;
      try {
        body = requesterFile(requester);
      } catch (e) {
        return Promise.reject(e);
      }
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ws04-run-'));
      const specPath = path.join(dir, 'spec.json');
      const reqPath = path.join(dir, 'requester.json');
      writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
      writeFileSync(reqPath, body, { mode: 0o600 });
      const args = ['run', 'accept', '--db', db, '--spec', specPath, '--slot', String(slot),
        '--requester', reqPath, '--rpc', rpc, '--program', program, '--season', season];
      return new Promise((resolve, reject) => {
        execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20, shell: false }, (err, stdout) => {
          rmSync(dir, { recursive: true, force: true });
          const line = String(stdout ?? '').trim().split('\n').at(-1) ?? '';
          let v = null;
          try { v = line ? JSON.parse(line) : null; } catch { v = null; }
          if (!err) return v ? resolve(v) : reject(new RunsError('StoreError', 'runexec printed no JSON', 0));
          if (v?.error === 'NoRecord' && !runexecNoRecord(err)) return reject(new RunsError('Spawn', noRecordWithoutExit3(err), err.code));
          if (v?.error) return reject(new RunsError(v.error, v.message ?? v.error, err.code));
          reject(new RunsError('Spawn', String(err.message ?? err), err.code));
        });
      });
    },
  };
}
