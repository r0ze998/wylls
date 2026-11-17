// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
// its own approval. Its import closure is resident/ports/ws04-run.mjs alone (no imports of its own: no key API).
//
// runViewClient answers NoRecord — which ws04ExecutionPort.status reads as "never accepted here" (null) — only for
// runexec's own NoRecord: exit 3, not killed, no signal, last line {"error":"NoRecord"} (workstream 4 src/main.rs).
// execFile is a stand-in shaped like node:child_process's callback; no process is started.
//   E1 exit 0 with a view → the view (unchanged)
//   E2 exit 3 + NoRecord → NoRecord; through the port: null (unchanged)
//   E3 a NoRecord line with exit 1, 4 or 5, a timeout kill, a signal, exit 3 but killed or signalled, or exit 0 →
//      Spawn; through the port: thrown, never null
//   E4 other error answers keep their own codes (StoreUnavailable exit 5, StoreError exit 1, BadRequest) (unchanged)
//   E5 no usable last line → Spawn (unchanged)
// No key is generated, imported, derived or used; nothing is signed, sent, spawned or fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runViewClient, ws04ExecutionPort } from '../resident/ports/ws04-run.mjs';

const exited = (code, extra = {}) => Object.assign(new Error(`Command failed: runexec (exit ${code})`), { code, killed: false, signal: null, ...extra });
const client = (err, stdout) => runViewClient({ bin: 'runexec', db: 'runs.db', execFile: (bin, args, o, cb) => cb(err, stdout) });
const line = o => `${JSON.stringify(o)}\n`;
const NO_RECORD = line({ error: 'NoRecord', message: 'no run r is accepted in the store at runs.db' });
const portOf = view => ws04ExecutionPort({ accept: async () => ({}), view }, { specOf: () => ({}) });

test('E1 a view', async () => {
  const v = await client(null, line({ view_version: 'p04-run/0.1', run_id: 'r', state: 'Accepted' }))('r');
  assert.equal(v.run_id, 'r');
});

test('E2 runexec\'s own NoRecord', async () => {
  await assert.rejects(client(exited(3), NO_RECORD)('r'), e => e.code === 'NoRecord');
  assert.equal(await portOf(client(exited(3), NO_RECORD)).status('r'), null);
});

test('E3 a NoRecord line without exit 3 is no answer', async () => {
  const cases = [exited(1), exited(4), exited(5), exited(null, { killed: true, signal: 'SIGTERM' }), exited(null, { signal: 'SIGKILL' }), exited(3, { killed: true }), exited(3, { signal: 'SIGTERM' }), null];
  for (const err of cases) {
    const label = JSON.stringify(err ? { code: err.code, killed: err.killed, signal: err.signal } : 'exit 0');
    await assert.rejects(client(err, NO_RECORD)('r'), e => e.code === 'Spawn', label);
    await assert.rejects(portOf(client(err, NO_RECORD)).status('r'), e => e.code === 'Spawn', `port: ${label}`);
  }
});

test('E4 other error answers keep their codes', async () => {
  await assert.rejects(client(exited(5), line({ error: 'StoreUnavailable', message: 'no store' }))('r'), e => e.code === 'StoreUnavailable');
  await assert.rejects(client(exited(1), line({ error: 'StoreError', message: 'bad store' }))('r'), e => e.code === 'StoreError');
  await assert.rejects(client(exited(2), line({ error: 'BadRequest', message: 'bad id' }))('r'), e => e.code === 'BadRequest');
  await assert.rejects(portOf(client(exited(5), line({ error: 'StoreUnavailable' }))).status('r'), e => e.code === 'StoreUnavailable');
});

test('E5 no usable last line', async () => {
  for (const out of ['', '\n', '{"error":"NoRec', 'not json\n']) {
    await assert.rejects(client(exited(3), out)('r'), e => e.code === 'Spawn', JSON.stringify(out));
  }
});
