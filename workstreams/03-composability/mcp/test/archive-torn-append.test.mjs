// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Run it only with its own approval.
//
// JsonStore.archive after a torn last line: a record appended after a crash-cut line must be on a line of its own, so
// that after a restart it is still found by id, by requestId (the reconnect guard) and in lists; the bytes already in
// the archive are never changed. KEY-FREE: imports src/store.mjs only (node:fs, node:path); writes only in its own new
// temporary directory; no server, relay, network or key. T6–T8 (archive) and T9–T11 (save) replace fs.writeSync for ONE call (restored in
// `finally`, with syncBuiltinESMExports so store.mjs's imported binding sees it) to make a short or zero-length write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

/** Runs `fn` with fs.writeSync writing at most `cap(len)` bytes of each write (really written, to the real file). */
function withShortWrites(cap, fn) {
  const real = fs.writeSync;
  fs.writeSync = (fd, buf, off = 0, len = buf.length, pos) => real(fd, buf, off, Math.min(len, cap(len)), pos);
  syncBuiltinESMExports();
  try { return fn(); } finally { fs.writeSync = real; syncBuiltinESMExports(); }
}

test('T6 a short write is refused: no index, the operation stays in the main state, the written bytes stay', () => {
  const file = fresh();
  const s = new JsonStore(file);
  archiveOne(s, op('op_1'));
  const before = readFileSync(`${file}.archive.jsonl`);
  s.state.operations.op_2 = op('op_2');
  assert.throws(() => withShortWrites(len => Math.floor(len / 2), () => s.archive(s.state.operations.op_2)), /wrote \d+ of \d+ bytes/);
  assert.equal(s.state.operations.op_2?.id, 'op_2', 'still in the main state');
  const after = readFileSync(`${file}.archive.jsonl`);
  assert.ok(after.subarray(0, before.length).equals(before) && after.length > before.length, 'append-only: half a record added, nothing earlier changed');
  s.save();
  const r = new JsonStore(file);
  assert.equal(r.operation('op_2')?.id, 'op_2', 'read from the main file after a restart');
  assert.deepEqual(r.operationsWithRequestId(['l1'], 'r-op_2'), ['op_2']);
});

test('T7 a zero-length write is refused the same way', () => {
  const file = fresh();
  const s = new JsonStore(file);
  s.state.operations.op_1 = op('op_1');
  assert.throws(() => withShortWrites(() => 0, () => s.archive(s.state.operations.op_1)), /wrote 0 of \d+ bytes/);
  assert.equal(s.state.operations.op_1?.id, 'op_1');
});

test('T8 after a short write, the retry appends on its own line; a restart finds the operation once, by id and requestId', () => {
  const file = fresh();
  const s = new JsonStore(file);
  archiveOne(s, op('op_1', { note: '前' }));
  s.state.operations.op_2 = op('op_2', { note: '途中で切れる記録' });
  assert.throws(() => withShortWrites(len => len - 1, () => s.archive(s.state.operations.op_2)));
  s.save();
  const cut = readFileSync(`${file}.archive.jsonl`);
  assert.notEqual(cut[cut.length - 1], 0x0a, 'the cut tail has no newline');
  s.archive(s.state.operations.op_2); // the next archiveFinished: real writes again
  s.save();
  const after = readFileSync(`${file}.archive.jsonl`);
  assert.ok(after.subarray(0, cut.length).equals(cut), 'nothing earlier changed');
  const r = new JsonStore(file);
  assert.equal(r.operation('op_2')?.note, '途中で切れる記録');
  assert.deepEqual(r.operationsWithRequestId(['l1'], 'r-op_2'), ['op_2'], 'one id, not two');
  assert.deepEqual(r.operationsOf(['l1'], 10).map(o => o.id).sort(), ['op_1', 'op_2']);
});

test('T9 save: a short write throws and the last complete state file is unchanged; the next load reads it', () => {
  const file = fresh();
  const s = new JsonStore(file);
  s.state.operations.op_1 = op('op_1', { note: '保存済み' });
  s.save();
  const snapshot = readFileSync(file);
  s.state.operations.op_2 = op('op_2', { note: '書きかけ ✓' });
  const n = s.writes;
  assert.throws(() => withShortWrites(len => Math.floor(len / 2), () => s.save()), /wrote \d+ of \d+ bytes; the state file was not replaced/);
  assert.equal(s.writes, n + 1, 'the attempt is counted, as before');
  assert.ok(readFileSync(file).equals(snapshot), 'the state file is byte for byte the last complete one');
  assert.equal(s.state.operations.op_2?.id, 'op_2', 'the memory state is kept');
  const r = new JsonStore(file);
  assert.equal(r.operation('op_1')?.note, '保存済み');
  assert.equal(r.operation('op_2'), null, 'the refused save did not reach the file');
});

test('T10 save: a zero-length write throws the same way', () => {
  const file = fresh();
  const s = new JsonStore(file);
  s.save();
  const snapshot = readFileSync(file);
  s.state.operations.op_1 = op('op_1');
  assert.throws(() => withShortWrites(() => 0, () => s.save()), /wrote 0 of \d+ bytes/);
  assert.ok(readFileSync(file).equals(snapshot));
});

test('T11 save: the next save after a refused one writes the whole state (multi-byte text), and a restart reads it', () => {
  const file = fresh();
  const s = new JsonStore(file);
  s.state.operations.op_1 = op('op_1', { note: '村 → 倉' });
  assert.throws(() => withShortWrites(len => len - 1, () => s.save()));
  s.save();
  const r = new JsonStore(file);
  assert.equal(r.operation('op_1')?.note, '村 → 倉');
});

test('T12 archive then a refused save: after a restart the main copy and the archived line are both there, and the main copy is read', () => {
  const file = fresh();
  const s = new JsonStore(file);
  s.state.operations.op_1 = op('op_1', { note: 'main' });
  s.save();
  s.archive(s.state.operations.op_1); // appended and indexed, deleted from memory
  assert.throws(() => withShortWrites(len => Math.floor(len / 2), () => s.save()));
  const r = new JsonStore(file);
  assert.equal(r.operation('op_1')?.note, 'main');
  assert.deepEqual(r.operationsWithRequestId(['l1'], 'r-op_1'), ['op_1'], 'one id');
  assert.deepEqual(r.operationsOf(['l1'], 10).map(o => o.id), ['op_1'], 'no duplicate in lists');
});
