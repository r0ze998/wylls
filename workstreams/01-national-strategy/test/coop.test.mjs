// 国をまたぐ依頼の接続のテスト：依頼 → 本人の承認 → 隊商（S1 の SendCaravan、送り主のウォレットの署名）→ 到着の確定 → 共同の目的。
// ヘラルドは偽物（`h/caravans.json` の形は、ヘラルドの Rust が書き出した見本 fixtures/herald-caravans-ended.json と同じ）。
// チェーンは使っていない（docs 17章：本物のローカルのチェーンでの一巡は未実施）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { testSigner, signRecord, ownerTagOf, fold, verifySig, recordId } from '../coop/record.mjs';
import { indexFeed, arrivalOf } from '../coop/arrival.mjs';
import { GOALS } from '../coop/goal.mjs';
import { createBoard, createServer, PAGE } from '../coop/board.mjs';
import * as P from '../../../permutation-server/web/frontier/fplay.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { fakeChain as fakeChainOf } from './coop-chain.mjs';
import { parseCaravans } from '../../../permutation-server/web/frontier/herald.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const programId = b58(new Uint8Array(32).fill(3));
const season = { programId, seasonId: '90' };
const goalId = 'crossing-storehouse-v1';
const HOME_A = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };      // 依頼する人（国1）の村
const dstOf = to => ({ kind: 1, p: to.p, q: to.q, at: to.site, gen: to.gen, tile: 20 });

async function people() {
  const mk = async n => testSigner(new Uint8Array(32).fill(n));
  return { a: await mk(11), b: await mk(22), c: await mk(33), d: await mk(44) };
}

/** 偽のヘラルド：隊商の一覧を手で書き換える。 */
function fakeHerald({ ended = true } = {}) {
  const file = { v: 1, moving: [], vaults: [], ...(ended ? { ended: [] } : {}) };
  return {
    file,
    send(owner, seq, cargo, to = HOME_A) {
      file.moving.push({ ownerTag: ownerTagOf(season, owner.address), seq, faction: 2, src: { kind: 1, p: 4, q: 0, at: 5, gen: 1, tile: 11 }, dst: dstOf(to), steps: 3, cargo, arriveTs: 1, runs: [], raided: false, path: Array(12).fill(0), provinces: [[4, 0], [3, 0]] });
    },
    settle(owner, seq, outcome, cargo, to = HOME_A) {
      const tag = ownerTagOf(season, owner.address);
      file.moving = file.moving.filter(m => !(m.ownerTag === tag && m.seq === seq));
      file.ended?.push({ ownerTag: tag, seq, end: 'settled', outcome, dst: dstOf(to), cargo });
    },
    raid(owner, seq, choice, raiderTag = '99') {
      const tag = ownerTagOf(season, owner.address);
      const m = file.moving.find(x => x.ownerTag === tag && x.seq === seq);
      file.ended?.push({ ownerTag: tag, seq, end: 'raided', choice, raiderTag, taken: m.cargo });
      if (choice === 1) { m.raided = true; m.cargo = Array(8).fill(0); }
      else Object.assign(m, { raided: false, dst: { kind: 1, p: 9, q: 9, at: 0, gen: 1, tile: 1 } });   // J2：同じ鍵のまま奪った人の行き先へ
    },
    vault(owner) { file.vaults.push({ p: 3, q: 0, tile: 40, ownerTag: ownerTagOf(season, owner.address), faction: 0, gen: 1 }); },
  };
}

const fakeChain = () => fakeChainOf(programId, '90');

/** 4人の国（チェーンの Citizen）：a=0、b=2、c=4、d=5。a の村 HOME_A。 */
function standardChain(P) {
  const ch = fakeChain();
  for (const [w, f] of [[P.a, 0], [P.b, 2], [P.c, 4], [P.d, 5]]) ch.citizen(w, f);
  ch.holding(HOME_A, P.a, 0);
  return ch;
}

function setup({ ended = true, chain = null, dir = null, clockAt = 1_790_000_000 } = {}) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-coop-'));
  const H = fakeHerald({ ended });
  let t = clockAt;
  const clock = { now: () => t, tick: (s = 60) => { t += s; } };
  const board = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: clock.now, fetchHerald: async () => ({ status: 200, json: structuredClone(H.file) }), reader: chain?.reader ?? null });
  const put = async (who, rec) => { clock.tick(1); return board.submit(await signRecord(who, { v: 1, season, at: clock.now(), ...rec })); };
  return { dir, H, clock, board, put };
}

async function request(put, a, need = { wood: 200, stone: 200 }) {
  const r = await put(a, { kind: 'request', goalId, need, to: HOME_A, nation: 0, expiresAt: 1_790_000_000 + 86400, nonce: 'n1' });
  assert.ok(r.ok, r.why);
  return r.id;
}
const joint = async (board, judgeId) => (await board.view({ judgeId })).joint[0];

test('一巡：依頼 → 応じる → 送り主のウォレットで署名した隊商 → 結び付け → 到着の確定 → 共同の目的（資源ごと）', async () => {
  const { a, b, c } = await people();
  const { H, board, put, clock } = setup({ chain: standardChain(await people()) });
  const id = await request(put, a);

  // 応じるだけでは物は動かず、数えない
  assert.ok((await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 })).ok);
  let j = await joint(board);
  assert.equal(j.progress.find(p => p.resource === 'wood').verified, 0, '応じても0（資源移転も義務もない）');
  assert.equal(H.file.moving.length, 0, '板は隊商を出さない');

  // 本物の S1 の命令の形：他の人の村へ送る SendCaravan は、送り主のウォレットだけが署名者（fplay.mjs、controller.mjs と同じ）
  const A = seasonAddresses(programId, '90');
  const src = { kind: 'holding', p: 4, q: 0, site: 5, gen: 1 };
  const accounts = P.accountsFor('SendCaravan', { addresses: A, wallet: b.address, actor: b.address, profile: 3, seq: 0, src, dst: HOME_A, provinces: [{ p: 4, q: 0 }, { p: 3, q: 0 }] });
  const shape = P.buildShape({ programId, name: 'SendCaravan', accounts, fields: { seq: 0, ...P.placeData(HOME_A), steps: 3, path: new Uint8Array(12), cargo: P.cargoBytes([0, 200, 0, 0, 0, 0, 0, 0]), fee: 50000n }, feePayer: b58(new Uint8Array(32).fill(9)), blockhash: b58(new Uint8Array(32).fill(5)), profile: 3 });
  assert.deepEqual(shape.signers, [b.address], '署名者は送り主のウォレット');
  assert.equal(accounts.caravan, A.of('Caravan', { ownerTag: BigInt(ownerTagOf(season, b.address)), seq: 0 }), '隊商の口座は送り主の印と番号から決まる（板が照らす ownerTag と同じ）');

  // チェーンに載ったとして、ヘラルドの一覧に出る（ここが模擬）
  H.send(b, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  assert.ok((await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } })).ok);
  j = await joint(board);
  assert.equal(j.progress.find(p => p.resource === 'wood').verified, 0, '輸送中は数えない');
  assert.equal(j.unverifiedCaravans, 1);

  // 確定（経路の塔で 200 → 196 に減った）
  H.settle(b, 0, 0, [0, 196, 0, 0, 0, 0, 0, 0]);
  j = await joint(board);
  assert.equal(j.progress.find(p => p.resource === 'wood').verified, 196, '確定の記録の量（目減りの後）');
  assert.equal(j.done, false, '木材196／200、石材0／200');

  // 別の国の人が石材と木材を送る
  assert.ok((await put(c, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 10, stone: 200 }, nation: 4 })).ok);
  H.send(c, 0, [0, 10, 210, 0, 0, 0, 0, 0]);
  assert.ok((await put(c, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, c.address), seq: 0 } })).ok);
  H.settle(c, 0, 0, [0, 10, 210, 0, 0, 0, 0, 0]);
  j = await joint(board, 'arrivals');
  assert.deepEqual(j.progress.map(p => [p.resource, p.verified]), [['wood', 206], ['stone', 210]]);
  assert.equal(j.done, true, '仮A：資源ごとに基準へ届いた');
  assert.deepEqual(new Set(j.otherNations), new Set([2, 4]));

  // 仮B：施設ができたことの観測が要る
  j = await joint(board, 'arrivals-and-facility');
  assert.equal(j.done, false, 'まだ貯蔵庫が見えない');
  clock.tick(60);   // 到着を見た後のポーリングで、初めて貯蔵庫が見える（同じポーリングで両方を初めて見たら、順番は分からないので数えない）
  H.vault(a);
  j = await joint(board, 'arrivals-and-facility');
  assert.equal(j.done, true, '到着の後に依頼した人の貯蔵庫が見えた');
  assert.match(j.why, /使った証拠ではない/, '届いた物で建てたかは分からないと書く');

  // 個人の表示は別：b の確かめた量
  const v = await board.view({ viewer: b.address });
  assert.deepEqual(v.personal.myVerified, { wood: 196 });
  assert.equal(v.nation.nation, 2, 'b の国はチェーンの Citizen から');
  assert.equal(v.nation.deliveredFromNation, 1);
  assert.equal(v.arrivals.find(x => x.responder === b.address).qtyKind, 'lower-bound');
});

test('資源は合計しない：木材だけ400届いても、石材が0なら達成しない', async () => {
  const { a, b } = await people();
  const { H, board, put } = setup({ chain: standardChain(await people()) });
  const id = await request(put, a, { wood: 400, stone: 200 });
  await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 400 }, nation: 2 });
  H.send(b, 0, [0, 400, 0, 0, 0, 0, 0, 0]);
  await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } });
  H.settle(b, 0, 0, [0, 400, 0, 0, 0, 0, 0, 0]);
  const j = await joint(board);
  assert.equal(j.done, false);
  assert.match(j.why, /石材 0／200/);
});

test('取消：依頼した人だけが取り消せ、取消の後は結び付けられない。送った隊商はそのまま届く（数えない）', async () => {
  const { a, b, c } = await people();
  const { H, board, put } = setup({ chain: standardChain(await people()) });
  const id = await request(put, a);
  await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 });
  assert.equal((await put(b, { kind: 'cancel', request: id, reason: 'other' })).why, '依頼した人だけが取り消せる');
  assert.ok((await put(a, { kind: 'cancel', request: id, reason: 'self' })).ok, '自分で進める');
  H.send(b, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  const r = await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } });
  assert.match(r.why, /依頼が開いていない/);
  assert.match((await put(c, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 1 }, nation: 4 })).why, /取り消された/);
  const v = await board.view({ viewer: a.address, nation: 0 });
  assert.equal(v.requests[0].stateNow, 'cancelled');
  assert.equal(v.requests[0].cancel.reason, 'self');
  assert.equal(v.arrivals.length, 0);
});

test('失敗：行き先がない・世代が違う（LOST）と、別の場所への確定は数えない', async () => {
  const { a, b } = await people();
  const { H, board, put } = setup({ chain: standardChain(await people()) });
  const id = await request(put, a);
  await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 });
  H.send(b, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } });
  H.settle(b, 0, 1, [0, 200, 0, 0, 0, 0, 0, 0]);
  const v = await board.view({});
  assert.equal(v.arrivals[0].state, 'lost');
  assert.equal(v.arrivals[0].verifiedQty, null);
  assert.equal(v.joint[0].progress[0].verified, 0);
});

test('略奪：奪われた（J2：奪った人の物）・焼かれた隊商は数えない。確定の記録がなくても、行き先が変われば奪われたとみる', async () => {
  const { a, b, c } = await people();
  const { H, board, put } = setup({ chain: standardChain(await people()) });
  const id = await request(put, a);
  for (const [who, nation] of [[b, 2], [c, 4]]) await put(who, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation });
  H.send(b, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  H.send(c, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } });
  await put(c, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, c.address), seq: 0 } });
  H.raid(b, 0, 0, '99');
  H.raid(c, 0, 1);
  let v = await board.view({});
  const st = Object.fromEntries(v.arrivals.map(x => [x.responder, x]));
  assert.equal(st[b.address].state, 'raided-taken');
  assert.equal(st[b.address].owner.ownerTag, '99', '持ち主は奪った人');
  assert.equal(st[c.address].state, 'raided-burned');
  // 奪われた隊商が奪った人の村に確定しても、依頼の届け先ではないので数えない
  H.settle(b, 0, 0, [0, 200, 0, 0, 0, 0, 0, 0], { kind: 'holding', p: 9, q: 9, site: 0, gen: 1 });
  v = await board.view({});
  assert.equal(v.joint[0].progress[0].verified, 0);

  // ended のないヘラルドでも、行き先が変わった隊商は奪われたとみる
  const feed = indexFeed({ moving: [{ ownerTag: ownerTagOf(season, b.address), seq: 5, dst: { kind: 1, p: 9, q: 9, at: 0, gen: 1 }, cargo: [0, 1, 0, 0, 0, 0, 0, 0], raided: false }] });
  const x = arrivalOf({ id: 'r', need: { wood: 1 }, to: HOME_A }, { responder: b.address, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 5 } }, feed);
  assert.equal(x.state, 'raided-taken');
});

test('相手の退出：抜けた人の応答は取り下げになり、新しい結び付けはできない。抜ける前に送った隊商は届いて数える。別の相手に切り替えられる', async () => {
  const { a, b, d } = await people();
  const { H, board, put } = setup({ chain: standardChain(await people()) });
  const id = await request(put, a);
  await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200, stone: 200 }, nation: 2 });
  H.send(b, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } });
  assert.ok((await put(b, { kind: 'leave', goalId })).ok);
  H.send(b, 1, [0, 0, 200, 0, 0, 0, 0, 0]);
  assert.match((await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 1 } })).why, /応じていない/);
  assert.match((await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { stone: 1 }, nation: 2 })).why, /抜けた人/);
  H.settle(b, 0, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  let v = await board.view({});
  assert.equal(v.requests[0].responses[b.address].withdrawn, true);
  assert.equal(v.joint[0].progress.find(p => p.resource === 'wood').verified, 200, '抜ける前に結び付けた隊商は、届けば数える');
  // 別の相手（d）が石材を送る
  await put(d, { kind: 'respond', request: id, answer: 'accept', offer: { stone: 200 }, nation: 5 });
  H.send(d, 0, [0, 0, 200, 0, 0, 0, 0, 0]);
  assert.ok((await put(d, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, d.address), seq: 0 } })).ok);
  H.settle(d, 0, 0, [0, 0, 200, 0, 0, 0, 0, 0]);
  v = await board.view({});
  assert.equal(v.joint[0].done, true);

  // 依頼した人が抜けると、開いている依頼は取り消しになる
  const id2 = await request(put, a, { wood: 5 });
  void id2;
  await put(a, { kind: 'leave', goalId });
  v = await board.view({});
  assert.equal(v.requests.find(q => q.need.wood === 5).cancel.reason, 'left');
});

test('未検証：確定の記録（ended）を出さないヘラルドでは、一覧から消えた隊商は「不明」で、量を数えない', async () => {
  const { a, b } = await people();
  const { H, board, put } = setup({ ended: false, chain: standardChain(await people()) });
  const id = await request(put, a);
  await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 });
  H.send(b, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } });
  H.settle(b, 0, 0, [0, 200, 0, 0, 0, 0, 0, 0]);   // 一覧から消えるだけ
  const v = await board.view({});
  assert.equal(v.arrivals[0].state, 'unknown');
  assert.match(v.arrivals[0].note, /未検証/);
  assert.equal(v.joint[0].progress[0].verified, 0);
  assert.equal(v.heraldFeed.ended, null);
});

test('結び付けの確かめ：持ち主でない人・行き先の違う隊商・依頼の資源を積まない隊商・二重の結び付けは断る', async () => {
  const { a, b, c } = await people();
  const { H, put } = setup({ chain: standardChain(await people()) });
  const id = await request(put, a);
  await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 });
  await put(c, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 4 });
  H.send(b, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  H.send(b, 1, [0, 200, 0, 0, 0, 0, 0, 0], { kind: 'holding', p: 8, q: 1, site: 0, gen: 1 });
  H.send(b, 2, [100, 0, 0, 0, 0, 0, 0, 0]);
  assert.match((await put(c, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } })).why, /持ち主/);
  assert.match((await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 1 } })).why, /行き先/);
  assert.match((await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 2 } })).why, /資源を積んでいない/);
  assert.ok((await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } })).ok);
  assert.match((await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 0 } })).why, /もう結び付け/);
  assert.match((await put(b, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, b.address), seq: 9 } })).why, /一覧にない/);
});

test('記録の確かめ：署名の改ざん・時刻のずれ・自分の依頼への応答・依頼にない量・知らない目的は断る', async () => {
  const { a, b } = await people();
  const { board, put, clock } = setup({ chain: standardChain(await people()) });
  const id = await request(put, a);
  const signed = await signRecord(b, { v: 1, season, at: clock.now(), kind: 'respond', request: id, answer: 'decline', nation: 2 });
  assert.equal(await verifySig(signed), true);
  assert.equal((await board.submit({ ...signed, answer: 'accept', offer: { wood: 1 } })).why, '署名が合わない');
  assert.equal((await board.submit({ ...signed, signer: a.address })).why, '署名が合わない', '別の人の名で出せない');
  assert.match((await board.submit(await signRecord(b, { v: 1, season, at: clock.now() - 10000, kind: 'leave', goalId }))).why, /時刻/);
  assert.match((await put(a, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 1 }, nation: 0 })).why, /自分の依頼/);
  assert.match((await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { ore: 5 }, nation: 2 })).why, /依頼にない量/);
  assert.match((await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 999 }, nation: 2 })).why, /依頼にない量/);
  assert.match((await put(a, { kind: 'request', goalId: 'tower', need: { wood: 1 }, to: HOME_A, nation: 0, expiresAt: clock.now() + 100, nonce: 'x' })).why, /知らない目的/);
  assert.match((await put(a, { kind: 'request', goalId, need: { wood: 1 }, to: HOME_A, nation: 0, expiresAt: clock.now() + 100, nonce: 'n1' })).ok ? '' : 'x', /^$/, '同じ内容でも時刻が違えば別の依頼');
  // 同じ記録を二度
  const once = await signRecord(b, { v: 1, season, at: clock.now(), kind: 'respond', request: id, answer: 'decline', nation: 2 });
  assert.ok((await board.submit(once)).ok);
  assert.match((await board.submit(once)).why, /二度/);
  // 物々交換・加工の貸出・到着時払いの記録の種類はない
  assert.match((await put(b, { kind: 'swap', request: id })).why, /知らない種類/);
  assert.match((await put(b, { kind: 'payOnArrival', request: id })).why, /知らない種類/);
});

test('期限：期限の過ぎた依頼には応じられず、表示は期限切れ', async () => {
  const { a, b } = await people();
  const { board, put, clock } = setup({ chain: standardChain(await people()) });
  const r = await put(a, { kind: 'request', goalId, need: { wood: 10 }, to: HOME_A, nation: 0, expiresAt: clock.now() + 100, nonce: 'e' });
  clock.tick(200);
  assert.match((await put(b, { kind: 'respond', request: r.id, answer: 'accept', offer: { wood: 10 }, nation: 2 })).why, /期限/);
  assert.equal((await board.view({})).requests[0].stateNow, 'expired');
});

test('記録は追記で保存され、板を作り直しても同じ状態に戻る', async () => {
  const { a, b } = await people();
  const { dir, put, H } = setup({ chain: standardChain(await people()) });
  const id = await request(put, a);
  await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 });
  const again = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: () => 1_790_000_100, fetchHerald: async () => ({ status: 200, json: H.file }) });
  const s = fold(again.records, { goals: GOALS, season });
  assert.equal(s.requests[id].responses[b.address].answer, 'accept');
  assert.equal(s.rejected.length, 0);
  assert.equal(recordId(again.records[0]), id);
});

test('ヘラルドの Rust が書き出した caravans.json（ended つき）を、既存の解析も①の読み取りも受け付ける', () => {
  const file = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/herald-caravans-ended.json'), 'utf8'));
  const parsed = parseCaravans(file);   // 既存の画面の解析（ended は読まないが、拒まない）
  assert.equal(parsed.moving.length, 2);
  const f = indexFeed(file);
  assert.equal(f.hasEnded, true);
  assert.equal(f.settled.get('88:0').cargo[1], 114);
  assert.equal(f.raided.get('88:2').raiderTag, '99');
  // 奪われた隊商（88:2）は、同じ鍵のまま一覧に残っている（ヘラルドの Rust の動き）
  assert.ok(file.moving.some(m => m.ownerTag === '88' && m.seq === 2));
});

test('HTTP：板の入口で、画面・記録・表示が出て、それ以外はヘラルドへ転送される', async () => {
  const { a } = await people();
  const H = fakeHerald();
  const herald = http.createServer((req, res) => {
    if (req.url === '/h/caravans.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(H.file)); }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`herald:${req.url}`);
  });
  await new Promise(r => herald.listen(0, '127.0.0.1', r));
  const hurl = `http://127.0.0.1:${herald.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-coop-http-'));
  const board = createBoard({ herald: hurl, programId, seasonId: '90', dataDir: dir });
  const srv = createServer(board, { herald: hurl });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal(await (await fetch(`${base}/frontier/frontier/`)).text(), 'herald:/frontier/frontier/');
    const page = await fetch(`${base}${PAGE}`);
    assert.match(await page.text(), /国をまたぐ依頼/);
    assert.equal((await fetch(`${base}/ws01/repo/permutation-server/web/sdk/bytes.mjs`)).status, 200);
    assert.equal((await fetch(`${base}/ws01/repo/frontier-node/Cargo.toml`)).status, 404, '決めた場所の外は出さない');
    assert.equal((await fetch(`${base}/ws01/repo/..%2F..%2Fetc/passwd`)).status, 404);
    const rec = await signRecord(a, { v: 1, season, at: Math.floor(Date.now() / 1000), kind: 'request', goalId, need: { wood: 1 }, to: HOME_A, nation: 0, expiresAt: Math.floor(Date.now() / 1000) + 60, nonce: 'h' });
    const r = await (await fetch(`${base}/coop/records`, { method: 'POST', body: JSON.stringify(rec) })).json();
    assert.ok(r.ok, r.why);
    const v = await (await fetch(`${base}/coop/view?nation=0`)).json();
    assert.equal(v.requests.length, 1);
  } finally {
    srv.close(); herald.close();
  }
});

// ------------------------------------------------------------------ 2026-10-30 の確認：入荷量・国籍・重複・再起動

import { creditedOf } from '../coop/arrival.mjs';
import { allocate } from '../coop/goal.mjs';
import { loadRecords } from '../coop/board.mjs';
import { citizenOf, holdingOf } from '../coop/chain.mjs';

/** 依頼 → b が応じる → b の隊商 seq を結び付ける。 */
async function linked(put, H, id, who, seq, cargo, nation = 2) {
  const r1 = await put(who, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200, stone: 200 }, nation });
  assert.ok(r1.ok || /もう|二度/.test(r1.why ?? ''), r1.why);
  H.send(who, seq, cargo);
  return put(who, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, who.address), seq } });
}

test('入荷量：村あては記録の積荷を下限として証明でき、倉あては上限で減りうるので未検証。積荷と入荷量は別に返す', async () => {
  const village = creditedOf({ dst: { kind: 1 }, cargo: [0, 196, 0, 0, 0, 0, 0, 0] });
  assert.equal(village.qtyKind, 'lower-bound');
  assert.match(village.basis, /Holding::credit/);
  const vault = creditedOf({ dst: { kind: 2 }, cargo: [0, 196, 0, 0, 0, 0, 0, 0] });
  assert.equal(vault.qty, null);
  assert.match(vault.why, /上限/);
  assert.equal(creditedOf({ dst: { kind: 7 }, cargo: [] }).qty, null);

  // 依頼の届け先は村だけ（倉あての依頼は、入荷量を証明できないので受け付けない）
  const P = await people();
  const { put, H, board } = setup({ chain: standardChain(P) });
  assert.match((await put(P.a, { kind: 'request', goalId, need: { wood: 1 }, to: { kind: 'vault', p: 3, q: 0, tile: 40, gen: 1 }, nation: 0, expiresAt: 1_790_000_000 + 999, nonce: 'v' })).why, /届け先（村）/);
  // 村あての依頼に結び付けた隊商が、倉に確定した記録（宛先違い）は数えず、積荷だけを示す
  const id = await request(put, P.a);
  assert.ok((await linked(put, H, id, P.b, 0, [0, 200, 0, 0, 0, 0, 0, 0])).ok);
  const tag = ownerTagOf(season, P.b.address);
  H.file.moving = [];
  H.file.ended.push({ ownerTag: tag, seq: 0, end: 'settled', outcome: 0, dst: { kind: 2, p: 3, q: 0, at: 40, gen: 1, tile: 40 }, cargo: [0, 200, 0, 0, 0, 0, 0, 0] });
  const v = await board.view({});
  assert.equal(v.arrivals[0].state, 'misdelivered');
  assert.deepEqual(v.arrivals[0].cargo, { wood: 200, stone: 0 });
  assert.equal(v.arrivals[0].verifiedQty, null);
  assert.equal(v.joint[0].progress[0].verified, 0);
});

test('国籍：申告は使わず、チェーンの Citizen で確かめる。確かめられなければ国をまたぐ協力の達成は確定しない', async () => {
  const P = await people();
  const run = async chain => {
    const { put, H, board } = setup({ chain });
    const id = await request(put, P.a);
    // b は国1（a と同じ）と申告するが、チェーンでは国3
    assert.ok((await linked(put, H, id, P.b, 0, [0, 200, 200, 0, 0, 0, 0, 0], 0)).ok);
    H.settle(P.b, 0, 0, [0, 200, 200, 0, 0, 0, 0, 0]);
    return joint(board);
  };
  // チェーンを読まない板：量は届いても、届け先の村も国も未検証 → 確定しない
  let j = await run(null);
  assert.equal(j.done, false);
  assert.equal(j.progress[0].verified, 0, '届け先の村が依頼した人の物か確かめられない到着は数えない');
  // 村は確かめられるが、b の Citizen がない
  const ch = fakeChain(); ch.citizen(P.a, 0); ch.holding(HOME_A, P.a, 0);
  j = await run(ch);
  assert.equal(j.progress[0].verified, 200);
  assert.equal(j.done, false);
  assert.match(j.why, /国籍未検証/);
  assert.equal(j.otherNations.length, 0);
  // b の Citizen のウォレットが違う（別人の口座）
  const ch2 = fakeChain(); ch2.citizen(P.a, 0); ch2.holding(HOME_A, P.a, 0); ch2.citizen(P.b, 2, { wallet: P.c.address });
  j = await run(ch2);
  assert.match(j.why, /国籍未検証/);
  // 確かめられた：申告（国1）ではなくチェーン（国3）で他国と数える
  j = await run(standardChain(P));
  assert.equal(j.done, true);
  assert.deepEqual(j.otherNations, [2]);
  // 同じ国の人だけからの到着は、量が足りても国をまたぐ協力にならない
  const ch3 = standardChain(P); ch3.citizen(P.b, 0);
  j = await run(ch3);
  assert.equal(j.done, false);
  assert.match(j.why, /他国からの到着が 0／1/);
});

test('届け先の村：持ち主が依頼した人でない・世代が違う村への到着は数えない', async () => {
  const P = await people();
  const A = seasonAddresses(programId, '90');
  const ch = standardChain(P);
  ch.holding(HOME_A, P.c, 4);   // 村の持ち主は c
  assert.match((await holdingOf(ch.reader, season, HOME_A, P.a.address)).why, /持ち主/);
  ch.holding({ ...HOME_A, gen: 2 }, P.a, 0);
  assert.match((await holdingOf(ch.reader, season, HOME_A, P.a.address)).why, /世代/);
  ch.drop(A.of('Citizen', { wallet: P.d.address }));
  assert.match((await citizenOf(ch.reader, season, P.d.address)).why, /口座がない/);
  assert.match((await citizenOf(null, season, P.a.address)).why, /チェーンを読めない/);
  const bad = { account: async () => { throw new Error('connection refused'); } };
  assert.match((await citizenOf(bad, season, P.a.address)).why, /connection refused/);
});

test('重複：同じ隊商は二つ目の依頼に結び付けられない（到着の前・到着の後・再読込・署名の再送・同時の送信）', async () => {
  const P = await people();
  const { put, H, board, dir, clock } = setup({ chain: standardChain(P) });
  const id1 = await request(put, P.a);
  const r2 = await put(P.a, { kind: 'request', goalId, need: { wood: 200 }, to: HOME_A, nation: 0, expiresAt: 1_790_000_000 + 86400, nonce: 'n2' });
  const id2 = r2.id;
  assert.ok((await linked(put, H, id1, P.b, 0, [0, 200, 0, 0, 0, 0, 0, 0])).ok);
  await put(P.b, { kind: 'respond', request: id2, answer: 'accept', offer: { wood: 200 }, nation: 2 });
  const link2 = () => put(P.b, { kind: 'link', request: id2, caravan: { ownerTag: ownerTagOf(season, P.b.address), seq: 0 } });
  // 到着の前
  assert.match((await link2()).why, /もう結び付け/);
  // 到着の後（一覧から消える）
  H.settle(P.b, 0, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  assert.match((await link2()).why, /一覧にない|もう結び付け/);
  // 再読込（板を作り直す）
  const again = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: clock.now, fetchHerald: async () => ({ status: 200, json: structuredClone(H.file) }), reader: standardChain(P).reader });
  H.send(P.b, 0, [0, 200, 0, 0, 0, 0, 0, 0]);   // たとえ一覧に戻って見えても
  clock.tick(1);
  assert.match((await again.submit(await signRecord(P.b, { v: 1, season, at: clock.now(), kind: 'link', request: id2, caravan: { ownerTag: ownerTagOf(season, P.b.address), seq: 0 } }))).why, /もう結び付け/);
  // 署名の再送（同じ記録をもう一度。再読込の後も）
  const first = again.records.find(r => r.kind === 'link');
  assert.match((await again.submit(first)).why, /二度/);
  // 数えるのは一度だけ
  const v = await again.view({});
  assert.equal(v.joint[0].progress.find(p => p.resource === 'wood').verified, 200);

  // 同時の送信：同じ隊商を二つの依頼へ同時に結び付けても、通るのは一つ
  const { put: put2, H: H2, board: b2, clock: c2 } = setup({ chain: standardChain(P) });
  const x1 = await request(put2, P.a);
  const x2 = (await put2(P.a, { kind: 'request', goalId, need: { wood: 200 }, to: HOME_A, nation: 0, expiresAt: 1_790_000_000 + 86400, nonce: 'n3' })).id;
  for (const x of [x1, x2]) await put2(P.c, { kind: 'respond', request: x, answer: 'accept', offer: { wood: 200 }, nation: 4 });
  H2.send(P.c, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  const now = c2.now();
  const recs = await Promise.all([x1, x2].map(x => signRecord(P.c, { v: 1, season, at: now, kind: 'link', request: x, caravan: { ownerTag: ownerTagOf(season, P.c.address), seq: 0 } })));
  const out = await Promise.all(recs.map(r => b2.submit(r)));
  assert.equal(out.filter(o => o.ok).length, 1, out.map(o => o.why).join(' / '));
});

test('重複：履歴が欠けた板が二つ目の結び付けを受けても、割り当ては一つの依頼だけ（後から欠けた記録が戻っても）', async () => {
  const P = await people();
  const { put, H, dir } = setup({ chain: standardChain(P) });
  const id1 = await request(put, P.a);
  const id2 = (await put(P.a, { kind: 'request', goalId, need: { wood: 200 }, to: HOME_A, nation: 0, expiresAt: 1_790_000_000 + 86400, nonce: 'n2' })).id;
  assert.ok((await linked(put, H, id1, P.b, 0, [0, 200, 0, 0, 0, 0, 0, 0])).ok);
  await put(P.b, { kind: 'respond', request: id2, answer: 'accept', offer: { wood: 200 }, nation: 2 });
  // 履歴の欠落：板のファイルから id1 への結び付けの行が消えた
  const file = path.join(dir, 'records.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const linkLine = lines.find(l => JSON.parse(l).kind === 'link');
  fs.writeFileSync(file, `${lines.filter(l => l !== linkLine).join('\n')}\n`);
  let t = 1_790_000_000 + 100;
  const gap = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: () => t, fetchHerald: async () => ({ status: 200, json: structuredClone(H.file) }), reader: standardChain(P).reader });
  t += 1;
  assert.ok((await gap.submit(await signRecord(P.b, { v: 1, season, at: t, kind: 'link', request: id2, caravan: { ownerTag: ownerTagOf(season, P.b.address), seq: 0 } }))).ok, '欠けた板は二つ目を受けてしまう');
  // 欠けた行が後から戻る（ファイルの末尾に）
  fs.appendFileSync(file, `${linkLine}\n`);
  H.settle(P.b, 0, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  const merged = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: () => t, fetchHerald: async () => ({ status: 200, json: structuredClone(H.file) }), reader: standardChain(P).reader });
  const v = await merged.view({});
  assert.equal(v.arrivals.filter(a => a.state === 'delivered' && a.verifiedQty).length, 1, '数えるのは一つだけ');
  assert.equal(v.joint[0].progress.find(p => p.resource === 'wood').verified, 200);
  assert.ok(v.rejected.some(r => r.kind === 'link' && /もう結び付け/.test(r.why)), '戻った行は、記録の順で後なので断られた扱い');

  // allocate そのもの：同じ隊商の二つの到着は、先の結び付けにだけ割り当てる
  const st = { requests: { r1: { id: 'r1', links: [{ caravan: { ownerTag: '5', seq: 0 }, n: 3 }] }, r2: { id: 'r2', links: [{ caravan: { ownerTag: '5', seq: 0 }, n: 1 }] } } };
  const arr = [{ requestId: 'r1', caravanId: { ownerTag: '5', seq: 0 }, state: 'delivered', verifiedQty: { wood: 1 } }, { requestId: 'r2', caravanId: { ownerTag: '5', seq: 0 }, state: 'delivered', verifiedQty: { wood: 1 } }];
  const al = allocate(arr, st);
  assert.equal(al.find(a => a.requestId === 'r2').duplicateOf, undefined);
  assert.equal(al.find(a => a.requestId === 'r1').duplicateOf, 'r2');
  assert.equal(al.find(a => a.requestId === 'r1').verifiedQty, null);
});

test('複数の評価への寄与は重複割当ではない：一つの到着が共同の目的・国の記録・個人の記録に一度ずつ出る', async () => {
  const P = await people();
  const { put, H, board } = setup({ chain: standardChain(P) });
  const id = await request(put, P.a);
  assert.ok((await linked(put, H, id, P.b, 0, [0, 200, 0, 0, 0, 0, 0, 0])).ok);
  H.settle(P.b, 0, 0, [0, 200, 0, 0, 0, 0, 0, 0]);
  const v = await board.view({ viewer: P.b.address });
  assert.equal(v.joint[0].progress[0].verified, 200);
  assert.equal(v.nation.deliveredFromNation, 1);
  assert.deepEqual(v.personal.myVerified, { wood: 200 });
  assert.equal(v.arrivals.length, 1, '到着は一つ');
});

test('再起動：依頼・応答・結び付け・重複防止は記録から戻る。書きかけの最後の行は飛ばして示し、次の記録は新しい行に書く', async () => {
  const P = await people();
  const { put, H, dir, clock } = setup({ chain: standardChain(P) });
  const id = await request(put, P.a);
  assert.ok((await linked(put, H, id, P.b, 0, [0, 200, 0, 0, 0, 0, 0, 0])).ok);
  const file = path.join(dir, 'records.jsonl');
  fs.appendFileSync(file, '{"v":1,"kind":"respo');   // 書きかけで止まった
  const re = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: clock.now, fetchHerald: async () => ({ status: 200, json: structuredClone(H.file) }), reader: standardChain(P).reader });
  assert.equal(re.config().damaged.length, 1);
  assert.equal(loadRecords(file).records.length, 3);
  const v = await re.view({});
  assert.equal(v.requests[0].links.length, 1);
  assert.equal(v.damaged.length, 1, '欠落は表示に出す');
  clock.tick(1);
  assert.ok((await re.submit(await signRecord(P.c, { v: 1, season, at: clock.now(), kind: 'respond', request: id, answer: 'decline', nation: 4 }))).ok);
  const after = loadRecords(file);
  assert.equal(after.records.length, 4, '新しい記録は壊れた行に続けず、次の行に書かれた');
  assert.equal(after.damaged.length, 1);
});

test('再起動：観測の時刻（observed.json）が失われても、仮B は「新しい貯蔵庫が見えた」を誤って達成にしない', async () => {
  const P = await people();
  const { put, H, board, dir, clock } = setup({ chain: standardChain(P) });
  const id = await request(put, P.a);
  for (const [w, seq, f] of [[P.b, 0, 2], [P.c, 0, 4]]) {
    await put(w, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200, stone: 200 }, nation: f });
    H.send(w, seq, [0, 100, 100, 0, 0, 0, 0, 0]);
    await put(w, { kind: 'link', request: id, caravan: { ownerTag: ownerTagOf(season, w.address), seq } });
    H.settle(w, seq, 0, [0, 100, 100, 0, 0, 0, 0, 0]);
  }
  H.vault(P.a);   // 貯蔵庫は、到着と同じポーリングで初めて見える（順番は分からない）
  assert.equal((await joint(board, 'arrivals-and-facility')).done, false);
  assert.equal((await joint(board, 'arrivals')).done, true);
  fs.rmSync(path.join(dir, 'observed.json'));
  clock.tick(600);
  const re = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: clock.now, fetchHerald: async () => ({ status: 200, json: structuredClone(H.file) }), reader: standardChain(P).reader });
  const j = (await re.view({ judgeId: 'arrivals-and-facility' })).joint[0];
  assert.equal(j.done, false, '再起動の後は、到着と貯蔵庫を同じ時刻に初めて見るので、前後が分からない');
  assert.match(j.judgeMeans, /使って建てた証拠ではない/);
});
