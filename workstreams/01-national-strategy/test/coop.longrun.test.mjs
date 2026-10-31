// 長く続く世界で記録が増え続けても扱えるか（境界を通れることとは別に確かめる）。
// 板の記録（追記）を大きくして、読み直し（再起動）・表示・新しい記録の受け取りの時間と、チェーンを読む回数を測る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testSigner, signRecord, ownerTagOf, recordId } from '../coop/record.mjs';
import { createBoard } from '../coop/board.mjs';
import { fakeChain } from './coop-chain.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';

const programId = b58(new Uint8Array(32).fill(3));
const S = { programId, seasonId: '91' };
const goalId = 'crossing-storehouse-v1';
const HOME = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
const ms = f => { const t = process.hrtime.bigint(); const r = f(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };

test('記録 2 万件の板：読み直し・表示・受け取りの時間とメモリ（記録を全部やり直さない）', async () => {
  const A = await testSigner(new Uint8Array(32).fill(11)), B = await testSigner(new Uint8Array(32).fill(22));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-long-'));
  // 保存済みの履歴：依頼 5000 件、それぞれに応答・取り下げ・取消（4 件ずつ）。読み直しでは署名を確かめない（受け取った時に確かめた）
  const lines = [];
  let t = 1_700_000_000;
  for (let i = 0; i < 5000; i++) {
    const req = { v: 1, kind: 'request', season: S, at: t, goalId, need: { wood: 10 }, to: HOME, nation: 0, expiresAt: t + 3600, nonce: `n${i}`, signer: A.address, sig: 'x' };
    const id = recordId(req);
    lines.push(req,
      { v: 1, kind: 'respond', season: S, at: t + 1, request: id, answer: 'accept', offer: { wood: 10 }, nation: 2, signer: B.address, sig: 'x' },
      { v: 1, kind: 'withdraw', season: S, at: t + 2, request: id, signer: B.address, sig: 'x' },
      { v: 1, kind: 'cancel', season: S, at: t + 3, request: id, reason: 'self', signer: A.address, sig: 'x' });
    t += 10;
  }
  fs.writeFileSync(path.join(dir, 'records.jsonl'), lines.map((rec, i) => JSON.stringify({ rec, receivedAt: 1_700_000_000 + i })).join('\n') + '\n');
  const bytes = fs.statSync(path.join(dir, 'records.jsonl')).size;
  const now = Math.floor(Date.now() / 1000);
  const [board, loadMs] = ms(() => createBoard({ herald: null, programId, seasonId: '91', dataDir: dir, now: () => now, fetchHerald: async () => ({ status: 200, json: null }) }));
  assert.equal(Object.keys(board.state().requests).length, 5000);
  assert.equal(board.state().rejected.length, 0);
  const t0 = process.hrtime.bigint();
  const v = await board.view({ viewer: A.address });
  const viewMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(v.requests.length, 5000);
  // 新しい記録の受け取り：全部を畳み込み直さないので、履歴の大きさに比例しない
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) {
    const r = await board.submit(await signRecord(A, { v: 1, season: S, at: now, kind: 'request', goalId, need: { wood: 1 }, to: HOME, nation: 0, expiresAt: now + 3600, nonce: `live${i}` }));
    assert.ok(r.ok, r.why);
  }
  const submitMs = Number(process.hrtime.bigint() - t1) / 1e6 / 50;
  const heapMb = process.memoryUsage().heapUsed / 1e6;
  console.log(`# 記録 ${lines.length} 件・${(bytes / 1e6).toFixed(1)} MB（1件 ${Math.round(bytes / lines.length)} B）：読み直し ${loadMs.toFixed(0)} ms、表示 ${viewMs.toFixed(0)} ms、受け取り 1件 ${submitMs.toFixed(1)} ms、heap ${heapMb.toFixed(0)} MB`);
  assert.ok(loadMs < 15000, `読み直し ${loadMs} ms`);
  assert.ok(viewMs < 5000, `表示 ${viewMs} ms`);
  assert.ok(submitMs < 200, `受け取り ${submitMs} ms`);
});

test('チェーンを読む回数：終わった隊商・確かめた国・規則の版は覚え、2回目の表示では届け先の村の今の口座（同じ村は一度）だけを読む', async () => {
  const P = { a: await testSigner(new Uint8Array(32).fill(11)), b: await testSigner(new Uint8Array(32).fill(22)) };
  const ch = fakeChain(programId, '91');
  ch.season(); ch.citizen(P.a, 0); ch.citizen(P.b, 2); ch.holding(HOME, P.a, 0);
  const calls = { account: 0, signatures: 0, transaction: 0 };
  const reader = Object.fromEntries(Object.entries(ch.reader).map(([k, f]) => [k, async (...x) => { calls[k] = (calls[k] ?? 0) + 1; return f(...x); }]));
  let t = 1_790_000_000;
  ch.setClock(() => t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-long2-'));
  const board = createBoard({ herald: null, programId, seasonId: '91', dataDir: dir, now: () => t, reader, fetchHerald: async () => ({ status: 200, json: null }) });
  const put = async (who, rec) => { t += 1; return board.submit(await signRecord(who, { v: 1, season: S, at: t, ...rec })); };
  const tag = ownerTagOf(S, P.b.address);
  const N = 60;
  for (let i = 0; i < N; i++) {
    const id = (await put(P.a, { kind: 'request', goalId, need: { wood: 10 }, to: HOME, nation: 0, expiresAt: t + 86400, nonce: `r${i}` })).id;
    await put(P.b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 10 }, nation: 2 });
    t += 10;
    ch.caravanSent(P.b, tag, i, HOME, [0, 10, 0, 0, 0, 0, 0, 0]);
    const r = await put(P.b, { kind: 'link', request: id, caravan: { ownerTag: tag, seq: i } });
    assert.ok(r.ok, r.why);
    ch.caravanSettled(tag, i, 0, HOME, [0, 10, 0, 0, 0, 0, 0, 0]);
  }
  for (const k of Object.keys(calls)) calls[k] = 0;
  const v1 = await board.view({});
  const first = { ...calls };
  for (const k of Object.keys(calls)) calls[k] = 0;
  const v2 = await board.view({});
  const second = { ...calls };
  assert.equal(v1.joint[0].progress[0].verified, N * 10);
  assert.equal(JSON.stringify(v2.joint), JSON.stringify(v1.joint));
  console.log(`# 依頼 ${N} 件（確定済み）：1回目 ${JSON.stringify(first)}、2回目 ${JSON.stringify(second)}`);
  assert.equal(second.signatures ?? 0, 0, '終わった隊商の取引は読み直さない');
  assert.equal(second.transaction ?? 0, 0);
  assert.equal(second.account, 1, '届け先の村（全部同じ村）を一度だけ読む');
});
