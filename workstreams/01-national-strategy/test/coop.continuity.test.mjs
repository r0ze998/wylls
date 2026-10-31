// 世界の継続（2026-10-31 の方針）：チェーンの文脈（シーズン ID）が変わっても、依頼の板の依頼・応答・結び付け・数えた量が消えず、
// 前の文脈の口座で確かめ続け、二重に数えないこと。固定した短い試験期間で、境界の前後と板の再起動の後を確かめる。
// 文脈の切り替えそのもの（チェーンの移行）は④⑧の担当で、ここでは偽のチェーンを二つ（90 と 91）並べて模す。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { testSigner, signRecord, ownerTagOf } from '../coop/record.mjs';
import { createBoard } from '../coop/board.mjs';
import { fakeChain } from './coop-chain.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { LAYOUTS } from '../../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';

const programId = b58(new Uint8Array(32).fill(3));
const S90 = { programId, seasonId: '90' }, S91 = { programId, seasonId: '91' };
const goalId = 'crossing-storehouse-v1';
const HOME_A = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };

async function people() {
  const mk = async n => testSigner(new Uint8Array(32).fill(n));
  return { a: await mk(11), b: await mk(22), c: await mk(33) };
}

/** 文脈ごとの偽のチェーン。住所は文脈（シーズンの PDA）で違うので、一つの読み手から両方を読める。 */
function twoChains(P) {
  const ch = { 90: fakeChain(programId, '90'), 91: fakeChain(programId, '91') };
  for (const k of ['90', '91']) {
    ch[k].season();
    for (const [w, f] of [[P.a, 0], [P.b, 2], [P.c, 4]]) ch[k].citizen(w, f);
    ch[k].holding(HOME_A, P.a, 0);
  }
  const calls = { account: 0, signatures: 0, transaction: 0 };
  const reader = {
    account: async a => { calls.account++; return (await ch[90].reader.account(a)) ?? ch[91].reader.account(a); },
    signatures: async a => { calls.signatures++; return [...await ch[90].reader.signatures(a), ...await ch[91].reader.signatures(a)]; },
    transaction: async s => { calls.transaction++; return (await ch[90].reader.transaction(s)) ?? ch[91].reader.transaction(s); },
    blockhashValid: async h => ch[90].reader.blockhashValid(h),
  };
  return { ch, reader, calls };
}

/** シーズンの口座の STATUS を ENDED（4）にする（EndSeason の後と同じ。①はこれを理由に何も閉じない）。 */
function endSeason(chain, season) {
  const A = seasonAddresses(programId, season.seasonId);
  const b = chain.reader.account(A.season);
  return b.then(bytes => { const off = LAYOUTS.accounts.find(a => a.kind === 'Season').fields.find(f => f.name === 'STATUS').off; bytes[off] = 4; });
}

function boardAt(dir, reader, clock, current, previous = [], legacyDirs = []) {
  return createBoard({ herald: null, programId, seasonId: current.seasonId, previous, legacyDirs, dataDir: dir, now: clock.now, reader,
    fetchHerald: async () => ({ status: 200, json: { v: 1, moving: [], vaults: [], ended: [] } }) });
}

test('境界をまたぐ：前の文脈で送った隊商が境界の後に着いても数え、前の文脈の依頼は自分の期限まで開き、新しい文脈の依頼と合わせて共同の目的が進む。再起動の後も同じで、二重に数えない', async () => {
  const P = await people();
  const { ch, reader } = twoChains(P);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-cont-'));
  let t = 1_790_000_000;
  const clock = { now: () => t };
  for (const k of ['90', '91']) ch[k].setClock(() => t);
  let board = boardAt(dir, reader, clock, S90);
  const put = async (who, ctx, rec) => { t += 1; return board.submit(await signRecord(who, { v: 1, season: ctx, at: t, ...rec })); };

  // ---- 境界の前（文脈 90）
  const id90 = (await put(P.a, S90, { kind: 'request', goalId, need: { wood: 200, stone: 200 }, to: HOME_A, nation: 0, expiresAt: t + 30 * 86400 - 10, nonce: 'w' })).id;
  { const r = await put(P.b, S90, { kind: 'respond', request: id90, answer: 'accept', offer: { wood: 200 }, nation: 2 }); assert.ok(r.ok, r.why); }
  t += 30;
  const tagB90 = ownerTagOf(S90, P.b.address);
  ch[90].caravanSent(P.b, tagB90, 0, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]);
  { const r = await put(P.b, S90, { kind: 'link', request: id90, caravan: { ownerTag: tagB90, seq: 0 } }); assert.ok(r.ok, r.why); }

  // ---- 境界：文脈 90 は ENDED、新しい文脈 91。板は作り直す（今の文脈 91、前の文脈 90 を読み続ける）
  await endSeason(ch[90], S90);
  t += 3600;
  board = boardAt(dir, reader, clock, S91, [S90]);
  let v = await board.view({});
  assert.equal(v.requests.length, 1, '前の文脈の依頼は残る');
  assert.equal(v.requests[0].stateNow, 'open', '文脈が変わったことでは閉じない（依頼の期限まで）');
  assert.equal(v.arrivals[0].state, 'moving');

  // 境界の後に、前の文脈の隊商が着く（プログラムは ENDED でも SettleCaravan を受ける：caravan.rs:927）
  ch[90].caravanSettled(tagB90, 0, 0, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]);
  v = await board.view({});
  assert.equal(v.arrivals[0].verification, 'RuleDerived');
  assert.deepEqual(v.arrivals[0].counted, { wood: 200, stone: 0 }, '前の文脈の口座と規則で確かめて数える');

  // 新しい依頼は今の文脈（91）で。前の文脈では出せない。前の文脈の依頼への応答を、別の文脈で出すのも断る
  assert.match((await put(P.a, S90, { kind: 'request', goalId, need: { stone: 1 }, to: HOME_A, nation: 0, expiresAt: t + 100, nonce: 'x' })).why, /今の文脈/);
  assert.match((await put(P.c, S91, { kind: 'respond', request: id90, answer: 'accept', offer: { stone: 200 }, nation: 4 })).why, /別の文脈/);
  assert.match((await put(P.c, { programId, seasonId: '77' }, { kind: 'leave', goalId })).why, /知らない文脈/);
  const id91 = (await put(P.a, S91, { kind: 'request', goalId, need: { stone: 200 }, to: HOME_A, nation: 0, expiresAt: t + 86400, nonce: 'y' })).id;
  { const r = await put(P.c, S91, { kind: 'respond', request: id91, answer: 'accept', offer: { stone: 200 }, nation: 4 }); assert.ok(r.ok, r.why); }
  t += 30;
  // 新しい文脈の隊商 #0（Citizen は文脈ごとなので番号はまた 0 から）
  const tagC91 = ownerTagOf(S91, P.c.address);
  ch[91].caravanSent(P.c, tagC91, 0, HOME_A, [0, 0, 200, 0, 0, 0, 0, 0]);
  { const r = await put(P.c, S91, { kind: 'link', request: id91, caravan: { ownerTag: tagC91, seq: 0 } }); assert.ok(r.ok, r.why); }
  ch[91].caravanSettled(tagC91, 0, 0, HOME_A, [0, 0, 200, 0, 0, 0, 0, 0]);
  v = await board.view({});
  const j = v.joint.find(x => x.host === P.a.address);
  assert.deepEqual(j.progress.map(p => [p.resource, p.verified]), [['wood', 200], ['stone', 200]], '共同の目的は文脈をまたいで続く（依頼した人ごと）');
  assert.equal(j.done, true);
  assert.deepEqual(new Set(j.otherNations), new Set([2, 4]), '国は、それぞれの依頼の文脈の Citizen で確かめた');

  // ---- 再起動の後も同じ。数えた到着は2件だけ（二重に数えない）
  const before = JSON.stringify(v.joint);
  board = boardAt(dir, reader, clock, S91, [S90]);
  v = await board.view({});
  assert.equal(JSON.stringify(v.joint), before);
  assert.equal(v.arrivals.filter(a => a.counted).length, 2);
  assert.equal(v.rejected.length, 0, '保存された記録は、読み直しで断られない');
});

test('同じ番号・同じ持ち主の印でも、文脈が違えば別の隊商（鍵に文脈を含む）。一方の結び付けが、他方の結び付けを断らない', async () => {
  const P = await people();
  const { ch, reader } = twoChains(P);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-cont2-'));
  let t = 1_790_000_000;
  const clock = { now: () => t };
  for (const k of ['90', '91']) ch[k].setClock(() => t);
  let board = boardAt(dir, reader, clock, S90);
  const put = async (who, ctx, rec) => { t += 1; return board.submit(await signRecord(who, { v: 1, season: ctx, at: t, ...rec })); };
  const id90 = (await put(P.a, S90, { kind: 'request', goalId, need: { wood: 300 }, to: HOME_A, nation: 0, expiresAt: t + 86400, nonce: 'a' })).id;
  await put(P.b, S90, { kind: 'respond', request: id90, answer: 'accept', offer: { wood: 300 }, nation: 2 });
  t += 30;
  const tag90 = ownerTagOf(S90, P.b.address);
  ch[90].caravanSent(P.b, tag90, 0, HOME_A, [0, 100, 0, 0, 0, 0, 0, 0]);
  assert.ok((await put(P.b, S90, { kind: 'link', request: id90, caravan: { ownerTag: tag90, seq: 0 } })).ok);
  board = boardAt(dir, reader, clock, S91, [S90]);
  const id91 = (await put(P.a, S91, { kind: 'request', goalId, need: { wood: 300 }, to: HOME_A, nation: 0, expiresAt: t + 86400, nonce: 'b' })).id;
  await put(P.b, S91, { kind: 'respond', request: id91, answer: 'accept', offer: { wood: 300 }, nation: 2 });
  t += 30;
  // 偽のチェーンで、91 の B の隊商に、わざと 90 と同じ印・番号を使う（鍵が文脈を含まなければ「もう結び付けた」と誤って断る）
  ch[91].caravanSent(P.b, tag90, 0, HOME_A, [0, 100, 0, 0, 0, 0, 0, 0]);
  const r = await put(P.b, S91, { kind: 'link', request: id91, caravan: { ownerTag: ownerTagOf(S91, P.b.address), seq: 0 } });
  assert.ok(!/もう結び付け/.test(r.why ?? ''), r.why);
  const st = board.state();
  assert.notEqual(st.requests[id90].links[0].caravan.ctx, st.requests[id91].links[0]?.caravan.ctx ?? 'none');
});

test('旧い板（シーズンごとのフォルダ）の記録は読むだけ：取り込んでも書き換えず、前の文脈の依頼として見える', async () => {
  const P = await people();
  const S89 = { programId, seasonId: '89' };
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-legacy-'));
  // 旧い形：記録そのものを1行ずつ（受け取った時刻なし）
  const t0 = 1_789_000_000;
  const req = await signRecord(P.a, { v: 1, season: S89, at: t0, kind: 'request', goalId, need: { wood: 50 }, to: HOME_A, nation: 0, expiresAt: t0 + 86400, nonce: 'old' });
  fs.writeFileSync(path.join(legacy, 'records.jsonl'), `${JSON.stringify(req)}\n`);
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(legacy, 'records.jsonl'))).digest('hex');
  const h0 = hash();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-new-'));
  let t = 1_790_000_000;
  const board = createBoard({ herald: null, programId, seasonId: '91', previous: [S90, S89], legacyDirs: [legacy], dataDir: dir, now: () => t, fetchHerald: async () => ({ status: 200, json: null }) });
  const v = await board.view({});
  assert.equal(v.requests.length, 1);
  assert.equal(v.requests[0].ctx.seasonId, '89');
  assert.equal(v.requests[0].stateNow, 'expired', '依頼は自分の期限で期限切れ（文脈の切り替えとは別）');
  t += 1;
  assert.ok((await board.submit(await signRecord(P.a, { v: 1, season: S91, at: t, kind: 'request', goalId, need: { wood: 1 }, to: HOME_A, nation: 0, expiresAt: t + 100, nonce: 'n' }))).ok);
  assert.equal(hash(), h0, '旧い板のファイルは書き換えない');
  assert.ok(!fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').includes('"old"'), '旧い記録をこちらへ写さない');
  // 前の文脈の一覧に無い文脈の旧い記録は読めない（断って示す）
  const b2 = createBoard({ herald: null, programId, seasonId: '91', previous: [S90], legacyDirs: [legacy], dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-new2-')), now: () => t, fetchHerald: async () => ({ status: 200, json: null }) });
  assert.match((await b2.view({})).rejected[0].why, /知らない文脈/);
});
