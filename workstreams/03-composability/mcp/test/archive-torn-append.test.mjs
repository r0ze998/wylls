// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Run it only with its own approval.
//
// JsonStore.archive after a torn last line: a record appended after a crash-cut line must be on a line of its own, so
// that after a restart it is still found by id, by requestId (the reconnect guard) and in lists; the bytes already in
// the archive are never changed. KEY-FREE: imports src/store.mjs only (node:fs, node:path); writes only in its own new
// temporary directory; no server, relay, network or key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';

const fresh = () => path.join(mkdtempSync(path.join(tmpdir(), 'wylls-mcp-torn-')), 'store.json');
const op = (id, extra = {}) => ({ id, requestId: `r-${id}`, linkId: 'l1', state: 'completed', createdAt: new Date(Number(id.slice(3)) * 1000).toISOString(), ...extra });
const archiveOne = (s, o) => { s.state.operations[o.id] = o; s.archive(o); s.save(); };

test('T1 torn tail, then a new archive, then a restart: the new record is found by id, requestId and in lists', () => {
  const file = fresh();
  const s = new JsonStore(file);
  archiveOne(s, op('op_1'));
  appendFileSync(`${file}.archive.jsonl`, '{"id":"op_3","torn'); // a line cut by a crash
  const before = readFileSync(`${file}.archive.jsonl`);
  const s2 = new JsonStore(file);
  archiveOne(s2, op('op_4'));
  const after = readFileSync(`${file}.archive.jsonl`);
  assert.ok(after.subarray(0, before.length).equals(before), 'no byte already there changed');
  assert.equal(after[before.length], 0x0a, 'one newline closes the cut line before the new record');
  const r = new JsonStore(file);
  assert.equal(r.operation('op_4')?.id, 'op_4');
  assert.equal(r.operation('op_1')?.id, 'op_1');
  assert.equal(r.operation('op_3'), null, 'the cut line is still not an operation');
  assert.deepEqual(r.operationsWithRequestId(['l1'], 'r-op_4'), ['op_4'], 'the reconnect guard still sees it');
  assert.deepEqual(r.operationsOf(['l1'], 10).map(o => o.id).sort(), ['op_1', 'op_4']);
});

test('T2 a newline-terminated archive gets no extra newline (no blank lines)', () => {
  const file = fresh();
  const s = new JsonStore(file);
  archiveOne(s, op('op_1'));
  const n1 = readFileSync(`${file}.archive.jsonl`).length;
  archiveOne(s, op('op_2'));
  const buf = readFileSync(`${file}.archive.jsonl`);
  assert.equal(buf.length, n1 + Buffer.byteLength(`${JSON.stringify(op('op_2'))}\n`));
  assert.ok(!buf.includes('\n\n'));
});

test('T3 an empty archive file: no separator', () => {
  const file = fresh();
  writeFileSync(`${file}.archive.jsonl`, '');
  const s = new JsonStore(file);
  archiveOne(s, op('op_1'));
  assert.equal(readFileSync(`${file}.archive.jsonl`, 'utf8'), `${JSON.stringify(op('op_1'))}\n`);
});

test('T4 multi-byte text after a torn tail: byte offsets still read the exact record after a restart', () => {
  const file = fresh();
  const s = new JsonStore(file);
  archiveOne(s, op('op_1', { note: '村から倉へ' }));
  appendFileSync(`${file}.archive.jsonl`, '{"id":"op_9","note":"途中');
  const s2 = new JsonStore(file);
  archiveOne(s2, op('op_5', { note: 'もう一度 ✓' }));
  archiveOne(s2, op('op_6'));
  const r = new JsonStore(file);
  assert.equal(r.operation('op_1').note, '村から倉へ');
  assert.equal(r.operation('op_5').note, 'もう一度 ✓');
  assert.equal(r.operation('op_6').id, 'op_6');
  assert.equal(readFileSync(`${file}.archive.jsonl`, 'utf8').split('\n').filter(l => l === '').length, 1, 'only the final newline ends empty');
});

test('T5 in memory (no file): unchanged', () => {
  const s = new JsonStore(null);
  s.state.operations.op_1 = op('op_1');
  s.archive(s.state.operations.op_1);
  assert.equal(s.operation('op_1').id, 'op_1');
  assert.equal(s.state.operations.op_1, undefined);
});
