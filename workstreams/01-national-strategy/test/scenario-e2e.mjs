// 依頼 → 応答 → 送出（計画・sending の記録・着地）→ 結び付け → 到着の結果 → 板の再起動 → 照会、を一続きで行う台本。
// 試験（coop.e2e.test.mjs）と、⑮へ渡す fold() の出力（fixtures/ws15-fold-e2e.json）の両方がこれを使う。
//
// 鍵の生成・導出・署名を一つも行わない：
//   - ウォレットは決まった 32 バイトの base58 の文字列（鍵の対ではない）。記録の sig は 'unsigned:<signer>' で、板の verify を
//     その文字列を確かめるだけの関数に差し替える（Ed25519 の verifySig は呼ばない）。
//   - 口座の住所は ids.mjs の tableAddresses（番号を振るだけの表。find_program_address・create_with_seed を呼ばない）。
//   - 送出：本物の planSend（チェーンの口座から送り元・道・番号）と、ゲームと同じ fplay.buildShape で「署名の無い」取引の中身を作る。
//     ウォレットの署名・手数料の鍵の署名の欄には、決まったバイト列（署名ではない）を入れ、偽のチェーンに着地させる。
// 偽物：チェーン（test/coop-chain.mjs）、ヘラルド（空の一覧）、住所、署名。本物：record.mjs の fold、board.mjs、chain.mjs の読み取り・
//   sendOutcome・caravanHistory、arrival.mjs、goal.mjs、ws04.mjs、pending.mjs、store.mjs、send.mjs の planSend、fplay.buildShape。

import fs from 'node:fs';
import path from 'node:path';
import { useAddresses, tableAddresses, ownerTagOf, addressesOf } from '../coop/ids.mjs';
import { createBoard } from '../coop/board.mjs';
import { planSend } from '../coop/send.mjs';
import { fakeChain, txJson } from './coop-chain.mjs';
import { buildShape } from '../../../permutation-server/web/frontier/fplay.mjs';
import { parseTransaction, wireTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';

export const programId = b58(new Uint8Array(32).fill(3));
export const S = { programId, seasonId: '91' };
const goalId = 'crossing-storehouse-v1';
export const HOME_A = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
export const HOME_B = { p: 4, q: 0, site: 5, gen: 1 };
export const ELSEWHERE = { kind: 'holding', p: 2, q: 1, site: 1, gen: 1 };
const wallet = n => ({ address: b58(new Uint8Array(32).fill(n)) });   // 鍵ではない：決まったバイト列の住所
export const W = { A: wallet(11), B: wallet(22), C: wallet(33) };
const fixedBytes = (n, len) => b58(new Uint8Array(len).fill(n));
/** 署名の代わりの印（署名ではない）。板の verify はこれを確かめるだけ。 */
export const UNSIGNED = signer => `unsigned:${signer}`;
export const verifyUnsigned = async rec => rec.sig === UNSIGNED(rec.signer);
const FEE_PAYER = fixedBytes(9, 32), BLOCKHASH = fixedBytes(5, 32);

/** 住所を導出しない表に差し替える（元に戻す関数を返す）。 */
export const noDerivation = () => useAddresses(tableAddresses());

export function makeWorld() {
  const ch = fakeChain(programId, S.seasonId);
  ch.season();
  ch.citizen(W.A, 0, { holdings: [{ ...HOME_A }] });
  ch.citizen(W.B, 2, { caravans: 0, holdings: [HOME_B] });
  ch.citizen(W.C, 1);
  ch.holding(HOME_A, W.A, 0, { tile: 20 });
  ch.holding(HOME_B, W.B, 2, { tile: 11, stores: [0, 500, 500, 0, 0, 0, 0, 0] });
  for (const [p, q] of [[4, 0], [5, 0], [5, -1], [4, -1], [3, 0], [3, 1], [4, 1], [3, -1], [2, 0], [2, 1]]) ch.province(p, q);
  return ch;
}

export function openBoard(dir, ch, clock, opts = {}) {
  return createBoard({ herald: null, programId, seasonId: S.seasonId, dataDir: dir, now: clock, reader: ch.reader, verify: verifyUnsigned,
    fetchHerald: async () => ({ status: 200, json: { v: 1, moving: [], vaults: [], ended: [] } }), segmentBytes: 4096, ...opts });
}

/**
 * 台本を最後まで行う。返すもの：{board（再起動の後の板）, before（再起動の前の照会）, after（再起動の後の照会）, ids（依頼の ID）, steps（各段の結果）}
 * 依頼（すべて A から、届け先は A の村）：
 *   r1 木材 200・石材 200：B が planSend で 120・80 を送り、着地 → 再起動 → 次の送付は止まる → 結び付け → 確定（塔で木材 1 減る：119・80）。
 *          C が 81・120 を送り確定 → 下限 200・200 で「届いた」（fulfilled）
 *   r2 木材 10：B の隊商 2 本（5 と 5 を送り、記録は 5 と 4）→ 下限 9、上限 11 未満 → 判定できない（undetermined）
 *   r3 石材 50：C の隊商が焼かれた（CARAVAN_RAIDED）→ 0 と分かる → 上限 0 → 届かなかった（not-reached）
 *   r4 木材 30：B の隊商が別の村で確定（襲撃の記録なし）→ 原因を確認中（DestinationMismatch）→ 判定できない
 *   r5 木材 1：B が 1 を送り、記録は 0（1 未満の端数）→「0 以上」、Partial、上限 1 → 届かなかった
 */
export async function runScenario(dir) {
  const ch = makeWorld();
  let t = 1_800_000_000;
  const clock = () => t;
  ch.setClock(clock);
  let board = openBoard(dir, ch, clock);
  const steps = {};
  const put = async (who, rec) => { t += 1; return board.submit({ v: 1, season: S, at: t, ...rec, signer: who.address, sig: UNSIGNED(who.address) }); };
  const tag = w => ownerTagOf(S, w.address);
  const req = async (nonce, need) => (await put(W.A, { kind: 'request', goalId, need, to: HOME_A, nation: 0, expiresAt: t + 86400, nonce })).id;
  const accept = (who, id, offer, nation) => put(who, { kind: 'respond', request: id, answer: 'accept', offer, nation });
  const arr = c => ['food', 'wood', 'stone', 'ore', 'arms', 'gold'].map(r => c[r] ?? 0).concat([0, 0]);

  const r1 = await req('r1', { wood: 200, stone: 200 });
  const r2 = await req('r2', { wood: 10 });
  const r3 = await req('r3', { stone: 50 });
  const r4 = await req('r4', { wood: 30 });
  const r5 = await req('r5', { wood: 1 });
  for (const id of [r1, r2, r4, r5]) steps[`acceptB:${id.slice(0, 6)}`] = (await accept(W.B, id, id === r1 ? { wood: 200, stone: 200 } : id === r2 ? { wood: 10 } : id === r4 ? { wood: 30 } : { wood: 1 }, 2)).ok;
  await accept(W.C, r1, { wood: 200, stone: 200 }, 1);
  await accept(W.C, r3, { stone: 50 }, 1);
  t += 30;

  // ---- 送出（r1、B）：本物の planSend → 署名の無い取引の中身 → sending の記録 → 偽のチェーンに着地
  const q1 = board.state().requests[r1];
  const plan = await planSend({ reader: ch.reader, season: S, wallet: W.B.address, request: q1, cargo: { wood: 120, stone: 80 } });
  if (!plan.ok) throw new Error(`planSend: ${plan.why}`);
  steps.plan = { seq: plan.fields.seq, src: plan.src, dst: plan.dst, cargo: plan.cargo, caravan: plan.caravan, estimate: plan.estimate };
  const shape = buildShape({ programId, name: plan.name, accounts: plan.accounts, fields: plan.fields, feePayer: FEE_PAYER, blockhash: BLOCKHASH, profile: 3 });
  const parsed = parseTransaction(wireTransaction(shape.message));
  const walletSig = fixedBytes(77, 64), feeSig = fixedBytes(78, 64);   // 署名ではない：決まったバイト列
  const sending = { kind: 'sending', request: r1, caravan: plan.caravan, walletSig, blockhash: BLOCKHASH, cargo: { wood: 120, stone: 80 }, src: { p: plan.src.p, q: plan.src.q, site: plan.src.site, gen: plan.src.gen } };
  steps.sending = await put(W.B, sending);
  steps.secondSendingBeforeLanding = await put(W.B, { ...sending, walletSig: fixedBytes(79, 64) });
  ch.caravanSent(W.B, plan.caravan.ownerTag, plan.caravan.seq, HOME_A, arr({ wood: 120, stone: 80 }),
    { src: HOME_B, message: txJson(parsed, [feeSig, walletSig]).message, signatures: [feeSig, walletSig], signature: feeSig });

  // ---- 板の再起動（着地の後、結び付けの前に画面を閉じた）→ 照会 → 次の送付は止まる → 結び付け
  board = openBoard(dir, ch, clock);
  const v0 = await board.view({ viewer: W.B.address });
  steps.afterRestartSending = v0.requests.find(q => q.id === r1).sendings.map(z => ({ seq: z.caravan.seq, outcome: z.outcome.status }));
  steps.thirdSendingAfterRestart = await put(W.B, { ...sending, walletSig: fixedBytes(80, 64) });
  steps.link = await put(W.B, { kind: 'link', request: r1, caravan: plan.caravan });

  // ---- 到着の結果
  t += 60;
  ch.caravanSettled(plan.caravan.ownerTag, plan.caravan.seq, 0, HOME_A, arr({ wood: 119, stone: 80 }));   // 塔で木材 1 減った
  const tc = tag(W.C), tb = tag(W.B);
  ch.caravanSent(W.C, tc, 0, HOME_A, arr({ wood: 81, stone: 120 }));
  await put(W.C, { kind: 'link', request: r1, caravan: { ownerTag: tc, seq: 0 } });
  ch.caravanSettled(tc, 0, 0, HOME_A, arr({ wood: 81, stone: 120 }));
  // r2：2 本。記録は 5 と 4（4.5 は切り捨て）
  for (const [seq, sent, logged] of [[1, 5, 5], [2, 5, 4]]) {
    ch.caravanSent(W.B, tb, seq, HOME_A, arr({ wood: sent }));
    await put(W.B, { kind: 'link', request: r2, caravan: { ownerTag: tb, seq } });
    ch.caravanSettled(tb, seq, 0, HOME_A, arr({ wood: logged }));
  }
  // r3：焼かれた
  ch.caravanSent(W.C, tc, 1, HOME_A, arr({ stone: 50 }));
  await put(W.C, { kind: 'link', request: r3, caravan: { ownerTag: tc, seq: 1 } });
  ch.caravanRaided(W.C, tc, 1, 1, W.A, '1', HOME_A, arr({ stone: 50 }));
  // r4：別の村で確定（襲撃の記録なし）
  ch.caravanSent(W.B, tb, 3, HOME_A, arr({ wood: 30 }));
  await put(W.B, { kind: 'link', request: r4, caravan: { ownerTag: tb, seq: 3 } });
  ch.caravanSettled(tb, 3, 0, ELSEWHERE, arr({ wood: 30 }));
  // r5：1 を送り、記録は 0
  ch.caravanSent(W.B, tb, 4, HOME_A, arr({ wood: 1 }));
  await put(W.B, { kind: 'link', request: r5, caravan: { ownerTag: tb, seq: 4 } });
  ch.caravanSettled(tb, 4, 0, HOME_A, arr({ wood: 0 }));
  t += 60;

  const before = await board.view({ viewer: W.A.address });
  const recordsBefore = board.records.length;
  // ---- 再起動の後の照会
  board = openBoard(dir, ch, clock);
  const after = await board.view({ viewer: W.A.address });
  return { board, before, after, recordsBefore, ids: { r1, r2, r3, r4, r5 }, steps, ch, citizenOf: w => addressesOf(S).of('Citizen', { wallet: w.address }) };
}

/** ⑮へ渡す形：fold() の実物の出力と、到着・依頼の充足の照会（量の区間つき）。 */
export function ws15Export(r, foldState) {
  const name = Object.fromEntries(Object.entries(W).map(([k, w]) => [w.address, k]));
  const label = Object.fromEntries(Object.entries(r.ids).map(([k, id]) => [id, k]));
  return {
    v: 1,
    note: '①の fold() の実物の出力（record.mjs createFolder、板の state()）と、同じ板の照会（goal.mjs coopView）の抜き出し。台本は test/scenario-e2e.mjs。'
      + ' ウォレット・住所・owner tag・署名は試験用の決まった値（鍵の生成・導出・署名をしていない。owner tag は導出しない住所の表の番号で、本物の S1 の値ではない）。',
    context: S,
    wallets: name,
    requestLabels: label,
    fold: foldState,
    view: {
      requests: r.after.requests.map(q => ({ id: q.id, label: label[q.id], need: q.need, stateNow: q.stateNow, fulfilment: q.fulfilment })),
      arrivals: r.after.arrivals.map(a => ({ requestId: a.requestId, label: label[a.requestId], caravanId: a.caravanId, responder: name[a.responder] ?? a.responder, state: a.state,
        delivered: a.delivered, verification: a.verification, held: a.held ?? null, cargoLogged: a.cargoLogged ?? null, amount: a.amount, shipped: a.shipped, terminal: a.terminal,
        counted: a.counted, countUpper: a.countUpper, countFinal: a.countFinal, notCountedWhy: a.notCountedWhy })),
      joint: r.after.joint.map(j => ({ host: name[j.host] ?? j.host, progress: j.progress, verdict: j.verdict, done: j.done, why: j.why })),
    },
  };
}

export const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'ws15-fold-e2e.json');
export const writeFixture = obj => fs.writeFileSync(FIXTURE, `${JSON.stringify(obj, null, 1)}\n`);
