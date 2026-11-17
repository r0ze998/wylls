// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with its
// own approval, through the repository's key-free guard.
//
// get_run_status chooses the run before it limits (store.mjs operationsOfRun, server.mjs runStatus):
//   R1 1000 newer operations of another run do not push an older run out (the old read, operationsOf(…, 1000) then a
//      filter, returned nothing for it)
//   R2 the same run beyond the limit: the newest `limit`, newest first, and `total` says how many there are
//   R3 an operation both in the main store and in the archive (a crash between archive and save) is returned once, the
//      main store's copy
//   R4 after a restart the archive's index carries runId (read from the lines already there; nothing rewritten)
//   R5 a stored archive line that cannot be read makes the read throw: never an empty or shorter run
//   R6 another link's operations of the same runId are not returned
//   R7 server.mjs: runStatus uses operationsOfRun with RUN_OPERATIONS (1000) and says when it was cut; the old
//      read-then-filter is gone
// FILES: each case uses its own new directory under os.tmpdir() (mkdtempSync) for the store and its archive, as
// archive-torn-append.test.mjs does; nothing else is written. KEY-FREE: imports node:test, node:assert/strict, node:fs,
// node:os, node:path and ../src/store.mjs (node:fs and node:path only); server.mjs is read as text. No network, no
// child process, no environment variable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';

const fresh = () => path.join(mkdtempSync(path.join(tmpdir(), 'wylls-mcp-run-first-')), 'store.json');
const at = n => new Date(Date.UTC(2026, 10, 1) + n * 1000).toISOString();
const op = (id, n, extra = {}) => ({ id, requestId: `r-${id}`, linkId: 'l1', state: 'completed', createdAt: at(n), steps: [], ...extra });
const archiveOne = (s, o) => { s.state.operations[o.id] = o; s.archive(o); };

test('R1 another run\'s newer operations do not push a run out', () => {
  const s = new JsonStore(null);
  archiveOne(s, op('op_a', 0, { runId: 'run-aaaaaaaa' }));
  for (let i = 1; i <= 1000; i++) s.state.operations[`op_b${i}`] = op(`op_b${i}`, i, { runId: 'run-bbbbbbbb' });
  assert.deepEqual(s.operationsOf(['l1'], 1000).filter(o => o.runId === 'run-aaaaaaaa'), [], 'the old read: pushed out');
  const r = s.operationsOfRun(['l1'], 'run-aaaaaaaa', 1000);
  assert.deepEqual([r.operations.map(o => o.id), r.total], [['op_a'], 1]);
});

test('R2 the same run beyond the limit', () => {
  const s = new JsonStore(null);
  for (let i = 1; i <= 1002; i++) s.state.operations[`op_${i}`] = op(`op_${i}`, i, { runId: 'run-aaaaaaaa' });
  const r = s.operationsOfRun(['l1'], 'run-aaaaaaaa', 1000);
  assert.equal(r.total, 1002);
  assert.equal(r.operations.length, 1000);
  assert.deepEqual([r.operations[0].id, r.operations.at(-1).id], ['op_1002', 'op_3'], 'newest first; the two oldest left out');
});

test('R3 main and archive: once, the main copy', () => {
  const s = new JsonStore(null);
  const o = op('op_1', 1, { runId: 'run-aaaaaaaa' });
  archiveOne(s, o);
  s.state.operations.op_1 = { ...o, note: 'main' }; // as after a crash between archive() and the save that removes it
  const r = s.operationsOfRun(['l1'], 'run-aaaaaaaa', 10);
  assert.deepEqual([r.operations.map(x => x.id), r.operations[0].note, r.total], [['op_1'], 'main', 1]);
});

test('R4 a restart indexes runId from the lines already there', () => {
  const file = fresh();
  const s = new JsonStore(file);
  archiveOne(s, op('op_1', 1, { runId: 'run-aaaaaaaa' }));
  archiveOne(s, op('op_2', 2));
  s.save();
  const before = readFileSync(`${file}.archive.jsonl`);
  const r = new JsonStore(file);
  assert.deepEqual(r.operationsOfRun(['l1'], 'run-aaaaaaaa', 10).operations.map(o => o.id), ['op_1']);
  assert.ok(readFileSync(`${file}.archive.jsonl`).equals(before), 'the archive is not rewritten');
});

test('R5 a line that cannot be read throws', () => {
  const file = fresh();
  const s = new JsonStore(file);
  archiveOne(s, op('op_1', 1, { runId: 'run-aaaaaaaa' }));
  s.save();
  const r = new JsonStore(file);
  const bytes = readFileSync(`${file}.archive.jsonl`);
  writeFileSync(`${file}.archive.jsonl`, Buffer.alloc(bytes.length, 0x7a)); // the indexed line is now not JSON
  assert.throws(() => r.operationsOfRun(['l1'], 'run-aaaaaaaa', 10), SyntaxError);
});

test('R6 another link\'s operations are not this link\'s', () => {
  const s = new JsonStore(null);
  s.state.operations.op_1 = op('op_1', 1, { runId: 'run-aaaaaaaa' });
  s.state.operations.op_2 = op('op_2', 2, { runId: 'run-aaaaaaaa', linkId: 'l2' });
  archiveOne(s, op('op_3', 3, { runId: 'run-aaaaaaaa', linkId: 'l2' }));
  assert.deepEqual(s.operationsOfRun(['l1'], 'run-aaaaaaaa', 10).operations.map(o => o.id), ['op_1']);
});

test('R7 runStatus chooses the run first and says when it was cut', () => {
  const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /export const RUN_OPERATIONS = 1000;/);
  assert.match(src, /const \{ operations: ops, total \} = store\.operationsOfRun\(\[principal\.linkId\], runId, RUN_OPERATIONS\);/);
  assert.match(src, /\.\.\.\(total > ops\.length \? \{ operationsTruncated: true, operationsTotal: total \} : \{\}\)/);
  assert.doesNotMatch(src, /operationsOf\(\[principal\.linkId\], 1000\)\.filter\(op => op\.runId === runId\)/);
});
