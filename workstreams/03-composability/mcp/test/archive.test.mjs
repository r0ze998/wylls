// A continuing world never resets the operation history: finished operations move from the file the server rewrites
// on every change to an append-only archive, and stay readable (by id, by requestId, in lists and in the owner's
// view) across restarts. Unfinished ones never move. The archive's bytes are never rewritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PATCHED, client, connect, encodeCaravanRecord, server, world } from './fixture.mjs';
import { JsonStore } from '../src/store.mjs';

const needsPatch = PATCHED ? false : 'needs patch 0005 in the gateway tree (WS03_GATEWAY_ROOT)';
const settle = (w, op) => w.state.events.push({ seq: String(w.state.events.length + 1), sig: 'keeper', kind: 92, bell: 40, tx: 1, slot: 90,
  body_b64: encodeCaravanRecord('CARAVAN_SETTLED', { bell: 40, ownerTag: BigInt(op.caravan.ownerTag), seq: op.caravan.seq, payload: { outcome: 0 } }).toString('base64') });

test('finished operations move to the archive after the archive delay and stay readable; unfinished ones stay; a retry is still a replay; a restart reads both', { skip: needsPatch }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const storeFile = path.join(dir, 'store.json');
  const sealKey = randomBytes(32).toString('base64url');
  const clock = { t: Date.now() };
  const w = await world();
  const s1 = await server(w, { storeFile, sealKey, clock, archiveAfterMs: 5 * 60_000 });
  let closed = false;
  try {
  const c = await connect(s1, w);
  const m = client(s1, c.access_token);
  const st = (await m.tool('get_village_status')).structuredContent;
  const plan = n => m.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: n } }).then(r => r.structuredContent);
  const pa = await plan(100);
  const a = (await m.tool('send_caravan', { planId: pa.planId, requestId: 'req-arch-a-01' })).structuredContent;
  settle(w, (await m.tool('get_operation_status', { operationId: a.operationId })).structuredContent);
  const done = (await m.tool('get_operation_status', { operationId: a.operationId })).structuredContent;
  assert.equal(done.state, 'completed');
  w.state.caravans = 1;
  // B: unfinished (unknown outcome).
  const pb = await plan(50);
  w.state.fail = u => u.pathname === '/f/agent/action';
  await m.tool('send_caravan', { planId: pb.planId, requestId: 'req-arch-b-01' });
  w.state.fail = null;
  clock.t += 6 * 60_000; // past the archive delay, within the token's hour
  await m.tool('get_connection'); // any call moves what is due
  assert.equal(s1.store.state.operations[a.operationId], undefined, 'A left the main store');
  assert.ok(s1.store.state.operations[Object.keys(s1.store.state.operations).find(k => s1.store.state.operations[k].requestId === 'req-arch-b-01')], 'B, unfinished, stayed');
  assert.equal(s1.store.state.plans[pa.planId], undefined, 'A\'s plan went with it');
  const archivedBytes = readFileSync(`${storeFile}.archive.jsonl`);
  assert.equal(archivedBytes.toString('utf8').trim().split('\n').length, 1);
  // Readable as before, by id and by requestId; listed; a retry is the same operation, nothing sent again.
  const byId = (await m.tool('get_operation_status', { operationId: a.operationId })).structuredContent;
  assert.deepEqual(byId, done);
  assert.deepEqual((await m.tool('get_operation_status', { requestId: 'req-arch-a-01' })).structuredContent, done);
  assert.deepEqual((await m.tool('list_operations')).structuredContent.operations.map(o => o.requestId).sort(), ['req-arch-a-01', 'req-arch-b-01']);
  const sent = w.r.chain.sent.length;
  const again = (await m.tool('send_caravan', { planId: pa.planId, requestId: 'req-arch-a-01' })).structuredContent;
  assert.deepEqual([again.operationId, again.state, again.replayed], [a.operationId, 'completed', true]);
  assert.equal(w.r.chain.sent.length, sent);
  await s1.close(); closed = true;
  // A restart: the archive is indexed, the operation read back exactly; earlier archive bytes are never rewritten.
  const s2 = await server(w, { storeFile, sealKey, clock, archiveAfterMs: 5 * 60_000 });
  try {
    s2.auth.issuer = s1.issuer; s2.auth.resource = `${s1.issuer}/mcp`;
    const m2 = client(s2, c.access_token);
    assert.deepEqual((await m2.tool('get_operation_status', { operationId: a.operationId })).structuredContent, done);
    assert.deepEqual(readFileSync(`${storeFile}.archive.jsonl`).subarray(0, archivedBytes.length), archivedBytes);
  } finally { await s2.close(); }
  } finally { if (!closed) await s1.close(); }
});

test('the archive survives a torn last line (a crash mid-append) and an operation left in both places (the main copy is read)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-mcp-'));
  const file = path.join(dir, 'store.json');
  const s = new JsonStore(file);
  const op = (id, state) => ({ id, requestId: `r-${id}`, linkId: 'l1', state, createdAt: new Date(Number(id.slice(3)) * 1000).toISOString() });
  s.state.operations.op_1 = op('op_1', 'completed');
  s.state.operations.op_2 = op('op_2', 'completed');
  s.archive(s.state.operations.op_1);
  s.save();
  // A crash after the archive line was synced but before the main file was saved: op_2 in both.
  const dup = { ...s.state.operations.op_2 };
  s.archive(s.state.operations.op_2);
  s.state.operations.op_2 = { ...dup, note: 'main copy' };
  s.save();
  appendFileSync(`${file}.archive.jsonl`, '{"id":"op_3","torn'); // a line cut by a crash
  const r = new JsonStore(file);
  assert.equal(r.operation('op_1').state, 'completed');
  assert.equal(r.operation('op_2').note, 'main copy', 'the main state wins a duplicate');
  assert.equal(r.operation('op_3'), null, 'a torn line is not an operation');
  assert.deepEqual(r.operationsOf(['l1'], 10).map(o => o.id).sort(), ['op_1', 'op_2'], 'no duplicate in lists');
});
