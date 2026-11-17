// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
// its own approval. Its import closure is clients/acts.mjs and clients/runs.mjs (node:child_process, node:fs, node:os,
// node:path; no key API). runs.accept writes its spec and requester to a temporary directory and removes it, as it
// always does; execFile is a stand-in shaped like node:child_process's callback, so no process is started.
//
// NoRecord is passed on only as runexec says it: exit 3, not killed, no signal (workstream 4 src/main.rs).
//   N1 exit 3 + NoRecord → NoRecord (unchanged), for acts.status, acts.list, acts.register and runs.accept
//   N2 a NoRecord line with exit 0 → not NoRecord: acts resolves the line as before (workstream 13's
//      fateOfReceipt then refuses it as an unknown state); runs resolves it as before
//   N3 a NoRecord line with exit 1/4/5, a timeout kill (SIGTERM), a signal, exit 3 but killed or signalled, or
//      maxBuffer (killed, string code) → Spawn, never NoRecord
//   N4 spawn failure (ENOENT), no JSON, a cut or non-JSON line → Spawn, as before
//   N5 every other error answer keeps its code (BadRequest, Conflict, StoreError, NotAuthorized), as before; a normal
//      answer (exit 0) resolves, as before; no JSON with exit 0 → StoreError, as before
//   N6 through workstream 13's acts port boundary: status gives null only for N1 (statusFor13, the same rule)
// No key is generated, imported, derived or used; nothing is signed, sent, spawned or fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActsClient, statusFor13 } from './acts.mjs';
import { createRunsClient } from './runs.mjs';

const exited = (code, extra = {}) => Object.assign(new Error(`Command failed: runexec (exit ${code})`), { code, killed: false, signal: null, ...extra });
const line = o => `${JSON.stringify(o)}\n`;
const NO_RECORD = line({ error: 'NoRecord', message: 'no act a/k is registered' });
const stub = (err, stdout) => (bin, args, o, cb) => cb(err, stdout);
const acts = (err, stdout) => createActsClient({ bin: 'runexec', db: 'runs.db', execFile: stub(err, stdout) });
const runs = (err, stdout) => createRunsClient({ bin: 'runexec', db: 'runs.db', rpc: 'http://127.0.0.1:8899', program: '1'.repeat(32), season: '1'.repeat(32), execFile: stub(err, stdout) });
const REQ = { actor: '1'.repeat(31) + 'A', generation: 1, citizen: '1'.repeat(31) + 'C', authenticatedBy: 'test: stand-in' };
const calls = (c) => [
  ['status', () => c.status({ agentId: 'a', key: 'k' })],
  ['list', () => c.list('r1')],
  ['register', () => c.register({ agentId: 'a', key: 'k', source: 'mcp' })],
];
const accept = (r) => r.accept({ run_id: 'r1' }, REQ);

test('N1 runexec\'s own NoRecord', async () => {
  for (const [name, f] of calls(acts(exited(3), NO_RECORD))) await assert.rejects(f(), e => e.code === 'NoRecord' && e.exit === 3, name);
  await assert.rejects(accept(runs(exited(3), NO_RECORD)), e => e.code === 'NoRecord');
});

test('N2 a NoRecord line with exit 0 is not NoRecord (unchanged)', async () => {
  assert.equal((await acts(null, NO_RECORD).status({ agentId: 'a', key: 'k' })).error, 'NoRecord', 'resolved as the line, as before');
  assert.equal((await accept(runs(null, NO_RECORD))).error, 'NoRecord');
});

test('N3 a NoRecord line without exit 3 is Spawn', async () => {
  const cases = [exited(1), exited(4), exited(5), exited(null, { killed: true, signal: 'SIGTERM' }), exited(null, { signal: 'SIGKILL' }),
    exited(3, { killed: true }), exited(3, { signal: 'SIGTERM' }), exited('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', { killed: true, signal: 'SIGTERM' })];
  for (const err of cases) {
    const label = JSON.stringify({ code: err.code, killed: err.killed, signal: err.signal });
    for (const [name, f] of calls(acts(err, NO_RECORD))) await assert.rejects(f(), e => e.code === 'Spawn', `${name} ${label}`);
    await assert.rejects(accept(runs(err, NO_RECORD)), e => e.code === 'Spawn', `accept ${label}`);
  }
});

test('N4 no usable answer is Spawn (unchanged)', async () => {
  const enoent = Object.assign(new Error('spawn runexec ENOENT'), { code: 'ENOENT', errno: -2 });
  for (const [err, out] of [[enoent, ''], [exited(3), ''], [exited(3), '{"error":"NoRec'], [exited(1), 'not json\n']]) {
    await assert.rejects(acts(err, out).status({ agentId: 'a', key: 'k' }), e => e.code === 'Spawn', JSON.stringify(out));
    await assert.rejects(accept(runs(err, out)), e => e.code === 'Spawn', JSON.stringify(out));
  }
});

test('N5 other answers keep their meaning (unchanged)', async () => {
  for (const [code, exit] of [['BadRequest', 2], ['Conflict', 4], ['StoreError', 1]]) {
    await assert.rejects(acts(exited(exit), line({ error: code, message: 'm' })).status({ agentId: 'a', key: 'k' }), e => e.code === code && e.exit === exit, code);
  }
  await assert.rejects(accept(runs(exited(5), line({ error: 'NotAuthorized', message: 'm' }))), e => e.code === 'NotAuthorized');
  const receipt = { receiptVersion: 'p04-acts/0.1', state: 'pending', idempotencyKey: 'k' };
  assert.deepEqual(await acts(null, line(receipt)).status({ agentId: 'a', key: 'k' }), receipt);
  assert.deepEqual(await accept(runs(null, line({ accept: 'Created' }))), { accept: 'Created' });
  await assert.rejects(acts(null, '').status({ agentId: 'a', key: 'k' }), e => e.code === 'StoreError');
  await assert.rejects(accept(runs(null, '')), e => e.code === 'StoreError');
});

test('N6 null ("never registered") only for runexec\'s own NoRecord', async () => {
  assert.equal(await statusFor13(acts(exited(3), NO_RECORD), 'a', 'k'), null);
  for (const err of [exited(1), exited(null, { killed: true, signal: 'SIGTERM' }), exited(3, { signal: 'SIGKILL' })]) {
    await assert.rejects(statusFor13(acts(err, NO_RECORD), 'a', 'k'), e => e.code === 'Spawn');
  }
});
