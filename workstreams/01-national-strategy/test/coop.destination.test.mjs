// 開いている依頼の届け先が、いま依頼した人の村（同じ世代）かを、板が表示のために確かめる（2026-11-08）。
// 受け取りの規則ではない（記録は断らない）。確かめられない依頼には、画面が送る・結び付けるを出さない（coop-ui.mjs）。
// 鍵の生成・導出・署名をしない（nokey.mjs）。口座の住所は本物（PDA の公開の住所の計算）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixedSigner, unsignedRecord, createBoard } from './nokey.mjs';
import { fakeChain } from './coop-chain.mjs';
import { destinationOf } from '../coop/goal.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';

const programId = b58(new Uint8Array(32).fill(3));
const season = { programId, seasonId: '90' };
const goalId = 'crossing-storehouse-v1';
const HOME_A = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
const HOME_B = { kind: 'holding', p: 4, q: 0, site: 5, gen: 1 };

async function world({ reader = true } = {}) {
  const a = await fixedSigner(new Uint8Array(32).fill(11)), b = await fixedSigner(new Uint8Array(32).fill(22));
  const ch = fakeChain(programId, '90');
  ch.season(); ch.citizen(a, 0, { holdings: [HOME_A] }); ch.citizen(b, 2, { holdings: [HOME_B] });
  ch.holding(HOME_A, a, 0); ch.holding(HOME_B, b, 2);
  const calls = { account: 0 };
  const counted = { ...ch.reader, account: async x => { calls.account += 1; return ch.reader.account(x); } };
  let t = 1_790_000_000;
  const board = createBoard({ herald: null, programId, seasonId: '90', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-dst-')), now: () => t,
    reader: reader ? counted : null, fetchHerald: async () => ({ status: 200, json: { v: 1, moving: [], vaults: [], ended: [] } }) });
  const put = async (who, rec) => { t += 1; return board.submit(await unsignedRecord(who, { v: 1, season, at: t, ...rec })); };
  const req = async (to, nonce) => (await put(a, { kind: 'request', goalId, need: { wood: 10 }, to, nation: 0, expiresAt: t + 3600, nonce })).id;
  return { a, b, ch, board, put, req, calls };
}
const dst = (v, id) => v.requests.find(q => q.id === id).destination;

test('届け先の確かめ：依頼した人の村・同じ世代は verified。他人の村・世代の違う村・無い村は理由つきで mismatch。記録は断らない', async () => {
  const { board, req } = await world();
  const own = await req(HOME_A, 'own');
  const other = await req(HOME_B, 'other');
  const stale = await req({ ...HOME_A, gen: 2 }, 'stale');
  const none = await req({ kind: 'holding', p: 0, q: 0, site: 0, gen: 0 }, 'none');
  for (const id of [own, other, stale, none]) assert.ok(id, '受け取りでは断らない');
  const v = await board.view({});
  assert.deepEqual(dst(v, own), { status: 'verified' });
  assert.match(dst(v, other).why, /今の持ち主が、依頼した人ではない/);
  assert.match(dst(v, stale).why, /世代が違う（依頼 2・今 1/);
  assert.match(dst(v, none).why, /村の口座がない/);
  assert.deepEqual([other, stale, none].map(id => dst(v, id).status), ['mismatch', 'mismatch', 'mismatch']);
});

test('依頼の後に村が占領された（持ち主と世代が変わった）：開いている依頼の届け先は、次の表示から mismatch。チェーンが読めないときは unknown（違うとは言わない）', async () => {
  const { board, req, ch, b } = await world();
  const own = await req(HOME_A, 'own');
  assert.equal(dst(await board.view({}), own).status, 'verified');
  ch.holding({ ...HOME_A, gen: 2 }, b, 2);   // 同じ村の口座を、B の世代 2 として書き直す
  const after = dst(await board.view({}), own);
  assert.deepEqual([after.status, /今の持ち主が、依頼した人ではない/.test(after.why)], ['mismatch', true]);
});

test('チェーンが一時的に読めない：届け先は unknown（違うとは言わない）。読めるようになれば verified に戻る', async () => {
  const { board, req, ch } = await world();
  const own = await req(HOME_A, 'own');
  const real = ch.reader.account;
  ch.reader.account = async () => { throw new Error('RPC down'); };
  const d = dst(await board.view({}), own);
  assert.deepEqual([d.status, /RPC down/.test(d.why)], ['unknown', true]);
  ch.reader.account = real;
  assert.equal(dst(await board.view({}), own).status, 'verified');
});

test('確かめるのは開いている依頼だけ。同じ村は一回の表示で一度だけ読む。チェーンを読まない板では null（分からない）', async () => {
  const { board, req, put, a, calls } = await world();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await req(HOME_A, `n${i}`));
  await put(a, { kind: 'cancel', request: ids[0], reason: 'self' });
  calls.account = 0;
  const v = await board.view({});
  assert.equal(dst(v, ids[0]), null, '取り消した依頼は確かめない');
  assert.ok(ids.slice(1).every(id => dst(v, id).status === 'verified'));
  const villageReads = calls.account;
  assert.ok(villageReads <= 3, `口座を読む回数 ${villageReads}（村 1・Citizen・規則の版）`);
  const nc = await world({ reader: false });
  const id = await nc.req(HOME_A, 'x');
  assert.equal(dst(await nc.board.view({}), id), null);
});

test('destinationOf：読めない（unknown）・口座が無い・持ち主が違う・世代が違う（mismatch）・同じ（verified）', () => {
  const to = { p: 1, q: 1, site: 1, gen: 3 };
  assert.deepEqual(destinationOf({ status: 'unverified', why: 'x' }, to, 'C'), { status: 'unknown', why: 'x' });
  assert.deepEqual(destinationOf({ status: 'unverified', why: '村の口座がない' }, to, 'C').status, 'mismatch');
  assert.equal(destinationOf(null, to, 'C').status, 'unknown');
  assert.match(destinationOf({ status: 'found', ownerCitizen: 'D', gen: 3 }, to, 'C').why, /持ち主/);
  assert.match(destinationOf({ status: 'found', ownerCitizen: 'C', gen: 4 }, to, 'C').why, /世代/);
  assert.deepEqual(destinationOf({ status: 'found', ownerCitizen: 'C', gen: 3 }, to, 'C'), { status: 'verified' });
});
