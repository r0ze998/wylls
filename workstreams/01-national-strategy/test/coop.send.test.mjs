// 依頼に応じて送る：既存の S1 の隊商の道（SendCaravan）を、ゲームの画面と同じコードで計画し、署名の無い取引の中身を偽のチェーンに載せて、
// 送信の結果（sendOutcome）・板の sending の記録・結び付けを確かめる。鍵の生成・導出・署名をしない（2026-11-08。nokey.mjs）。
// ウォレットで署名して中継へ送る経路（sendPlanned → fplay.submit）は coop.send.wallet-signing.mjs（鍵が要るので未実施）。
// 本物のチェーンでの実行は未実施（docs 17章 17-4b）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerTagOf } from '../coop/record.mjs';
import { fixedSigner, unsignedRecord, createBoard } from './nokey.mjs';
import { planSend } from '../coop/send.mjs';
import { fakeChain, txJson } from './coop-chain.mjs';
import { parseTransaction, wireTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { decodeIxData } from '../../../permutation-server/web/sdk/frontier/codec.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { PRESETS as V2 } from '../../../permutation-server/web/sdk/frontier/abi-v2-presets.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';

const programId = b58(new Uint8Array(32).fill(3));
const season = { programId, seasonId: '90' };
const RULESET_V3 = V2.ruleset_hash_v3;
const HOME_A = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
const HOME_B = { p: 4, q: 0, site: 5, gen: 1 };

async function world() {
  const a = await fixedSigner(new Uint8Array(32).fill(11));
  const seedB = new Uint8Array(32).fill(22);
  const b = await fixedSigner(seedB);
  const ch = fakeChain(programId, '90');
  ch.citizen(a, 0, { holdings: [{ ...HOME_A }] });
  ch.citizen(b, 2, { caravans: 3, holdings: [HOME_B] });
  ch.holding(HOME_A, a, 0, { tile: 20 });
  ch.holding(HOME_B, b, 2, { tile: 11 });
  for (const [p, q] of [[4, 0], [5, 0], [5, -1], [4, -1], [3, 0], [3, 1], [4, 1], [3, -1], [2, 0], [2, 1]]) ch.province(p, q);
  ch.season();
  const request = { id: 'r1', requester: a.address, need: { wood: 200, stone: 200 }, to: { ...HOME_A } };
  return { a, b, seedB, ch, request };
}

test('計画：送り元・道・番号をチェーンの口座から決め、ゲームと同じ関数で SendCaravan の口座と欄を作る', async () => {
  const { b, ch, request } = await world();
  const p = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 120 } });
  assert.ok(p.ok, p.why);
  assert.equal(p.fields.seq, 3, '番号は Citizen の CARAVANS');
  assert.deepEqual(p.src, { kind: 'holding', ...HOME_B });
  assert.deepEqual(p.dst, HOME_A);
  assert.equal(p.cargo[1], 120);
  assert.ok(p.plan.dirs.length > 0 && p.plan.provinces[0].p === 4, '道は送り元の州から');
  const A = seasonAddresses(programId, '90');
  assert.equal(p.accounts.caravan, A.of('Caravan', { ownerTag: BigInt(ownerTagOf(season, b.address)), seq: 3 }));
  assert.equal(p.accounts.actor, b.address, 'ほかの人あてなので、署名する actor はウォレット');
  assert.deepEqual(p.caravan, { ownerTag: ownerTagOf(season, b.address), seq: 3 });
});

test('計画を断る：依頼にない資源・依頼より多い量・自分の依頼・届け先が依頼した人の村でない・道がない・チェーンなし', async () => {
  const { a, b, ch, request } = await world();
  const plan = cargo => planSend({ reader: ch.reader, season, wallet: b.address, request, cargo });
  assert.equal((await plan({ ore: 5 })).code, 'NotRequested');
  assert.equal((await plan({ wood: 201 })).code, 'BadAmount');
  assert.equal((await plan({})).code, 'NoCargo');
  assert.equal((await planSend({ reader: ch.reader, season, wallet: a.address, request, cargo: { wood: 1 } })).code, 'OwnRequest');
  assert.equal((await planSend({ reader: null, season, wallet: b.address, request, cargo: { wood: 1 } })).code, 'NoChain');
  const other = { ...request, to: { ...HOME_A, gen: 2 } };
  assert.equal((await planSend({ reader: ch.reader, season, wallet: b.address, request: other, cargo: { wood: 1 } })).code, 'BadDestination');
  const far = fakeChain(programId, '90');
  far.citizen(b, 2, { holdings: [HOME_B] }); far.holding(HOME_B, b, 2, { tile: 11 }); far.holding(HOME_A, a, 0, { tile: 20 }); far.citizen(a, 0);
  assert.equal((await planSend({ reader: far.reader, season, wallet: b.address, request, cargo: { wood: 1 } })).code, 'NoPath', '州が読めなければ道がない');
});

test('国籍：国から追放されている間は、その国の一員として数えない', async () => {
  const { a, ch } = await world();
  const { citizenOf } = await import('../coop/chain.mjs');
  ch.citizen(a, 0, { expelledSince: 1_790_000_000 });
  const c = await citizenOf(ch.reader, season, a.address);
  assert.equal(c.status, 'unverified');
  assert.equal(c.expelled, true);
  assert.match(c.why, /追放/);
});

test('板の RPC の入口は読むだけ：送る・署名を求める方法は断る', async () => {
  const { createServer, READ_METHODS } = await import('../coop/board.mjs');
  const calls = [];
  const rpc = http.createServer(async (req, res) => { let b = ''; for await (const c of req) b += c; calls.push(JSON.parse(b).method); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1,"result":null}'); });
  await new Promise(r => rpc.listen(0, '127.0.0.1', r));
  const board = createBoard({ herald: null, programId, seasonId: '90', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-rpc-')), rpc: `http://127.0.0.1:${rpc.address().port}` });
  const srv = createServer(board, { herald: null });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const m of ['sendTransaction', 'requestAirdrop', 'simulateTransaction']) {
      assert.equal((await fetch(`${base}/coop/rpc`, { method: 'POST', body: JSON.stringify({ method: m, params: [] }) })).status, 403, m);
    }
    for (const m of READ_METHODS) assert.equal((await fetch(`${base}/coop/rpc`, { method: 'POST', body: JSON.stringify({ method: m, params: ['x'] }) })).status, 200, m);
    assert.deepEqual(calls, [...READ_METHODS], '読む方法だけが RPC に届いた');
  } finally { srv.close(); rpc.close(); }
});

test('テストの記録の書き方は、ABI の見本（abi-v2-logs.mjs の vector）と同じバイト列になる', async () => {
  const { LOGS } = await import('../../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs');
  const { decodeRecord } = await import('../../../permutation-server/web/frontier/flog.mjs');
  const { ps2Body } = await import('./coop-chain.mjs');
  for (const name of ['CARAVAN_SETTLED', 'CARAVAN_RAIDED', 'CARAVAN_SENT']) {
    const k = LOGS.kinds.find(x => x.name === name);
    const want = Buffer.from(k.vector.body, 'hex');
    const r = decodeRecord(want);
    const fields = Object.fromEntries([...k.key, ...k.payload].map(f => [f.name, r[f.name]]));
    assert.equal(Buffer.from(ps2Body(name, r.logBell, fields)).toString('hex'), k.vector.body, name);
  }
});

// ------------------------------------------------------------------ 送る前の見込み・競合・結果不明・結び付けの前の到着（2026-10-30）

import { sendOutcome } from '../coop/chain.mjs';
import { buildShape } from '../../../permutation-server/web/frontier/fplay.mjs';

/**
 * 「プログラムのように振る舞う」偽のチェーン（署名をしない。2026-11-08 に、中継と手数料の鍵で署名していた programRelay から差し替えた）：
 * 計画から、ゲームと同じ fplay.buildShape で署名の無い取引の中身を作り、署名の欄には決まったバイト列（署名ではない）を入れる。
 * SendCaravan の番号が Citizen の CARAVANS と同じで、在庫が足りれば隊商を作って番号を進め、違えば失敗した取引として記録する
 * （caravan.rs:695 の BadData、Insufficient）。land=false なら何も載せない（中継は受け取ったが載らない）。
 * 中継・ウォレットの署名の経路（fplay.submit）はここでは通らない（coop.send.wallet-signing.mjs、鍵が要るので未実施）。
 */
function programChain(ch, b, stock, { land = true } = {}) {
  let caravans = 3, n = 0;
  const FEE = b58(new Uint8Array(32).fill(9)), BH = b58(new Uint8Array(32).fill(5));
  return {
    close() {},
    send(planned) {
      n += 1;
      const shape0 = buildShape({ programId, name: planned.name, accounts: planned.accounts, fields: planned.fields, feePayer: FEE, blockhash: BH, profile: 3 });
      const tx = parseTransaction(wireTransaction(shape0.message));
      const feeSig = b58(new Uint8Array(64).fill(100 + n)), walletSig = b58(new Uint8Array(64).fill(200 - n));   // 署名ではない
      const signature = feeSig;
      if (!land) return { ok: true, signature, walletSig };
      const ix = tx.instructions.find(i => tx.accountKeys[i.programIdIndex] === programId);
      const d = decodeIxData(ix.data, 3);
      const cargo = Array.from({ length: 8 }, (_, i) => new DataView(d.cargo.buffer, d.cargo.byteOffset).getUint32(4 * i, true));
      const sigs = tx.signers.map(k => (k === FEE ? feeSig : walletSig));
      const shape = { signature, ...txJson(tx, sigs) };
      const caravanAddr = seasonAddresses(programId, '90').of('Caravan', { ownerTag: BigInt(ownerTagOf(season, b.address)), seq: Number(d.seq) });
      const bad = Number(d.seq) !== caravans ? 'BadData' : cargo.some((v, i) => v > (stock[i] ?? 0)) ? 'Insufficient' : null;
      if (bad) { ch.tx([caravanAddr], [], { err: { InstructionError: [1, { Custom: bad }] }, ...shape }); return { ok: true, signature, walletSig }; }
      cargo.forEach((v, i) => { stock[i] -= v; });
      ch.caravanSent(b, ownerTagOf(season, b.address), caravans, { kind: 1, p: Number(d.dst_p), q: Number(d.dst_q), site: Number(d.dst_at), gen: Number(d.dst_gen) }, cargo, { ...shape, src: HOME_B });
      caravans += 1;
      ch.citizen(b, 2, { caravans, holdings: [HOME_B] });
      return { ok: true, signature, walletSig };
    },
  };
}

test('見込み：送る前に送り元の不足量を出す（ゲームと同じ在庫の計算）。不足があっても計画は止めず、最終判定はプログラム', async () => {
  const { b, ch, request } = await world();
  ch.holding(HOME_B, b, 2, { tile: 11, stores: [0, 150, 30] });
  const p = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 200, stone: 20 }, now: 1_790_000_000 });
  assert.ok(p.ok);
  assert.deepEqual(p.estimate.have, { wood: 150, stone: 30 });
  assert.deepEqual(p.estimate.shortfall, { wood: 50 });
  assert.match(p.estimate.final, /プログラム/);
});

test('在庫の競合：見込みでは足りても、先に別の送信が在庫を使えば、プログラムが断り（failed）、結び付けない', async () => {
  const { b, seedB, ch, request } = await world();
  ch.holding(HOME_B, b, 2, { tile: 11, stores: [0, 150] });
  const stock = [0, 150, 0, 0, 0, 0, 0, 0];
  const relay = programChain(ch, b, stock);
  try {
    const p1 = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 100 }, now: 1_790_000_000 });
    assert.deepEqual(p1.estimate.shortfall, {});
    const r1 = relay.send(p1);
    assert.equal((await sendOutcome(ch.reader, season, { wallet: b.address, ...p1 }, r1.signature)).status, 'landed');
    // 二つ目：計画の時点の見込みは古い（在庫 150 のまま）。番号は進んだので計画し直すが、在庫は 50 しかない
    const p2 = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 100 }, now: 1_790_000_000 });
    assert.deepEqual(p2.estimate.shortfall, {}, '見込みは村の口座の記録（偽のチェーンは在庫を書き換えない）');
    const r2 = relay.send(p2);
    assert.ok(r2.ok, '中継は受け取る（判定はプログラム）');
    const o2 = await sendOutcome(ch.reader, season, { wallet: b.address, ...p2 }, r2.signature);
    assert.equal(o2.status, 'failed');
    assert.match(o2.why, /Insufficient/);
  } finally { relay.close(); }
});

test('隊商の番号の競合：同じ番号で計画した二つの送信は、先に着いた方だけが成功し、後は失敗（BadData）。自分の取引の署名で区別する', async () => {
  const { b, seedB, ch, request } = await world();
  ch.holding(HOME_B, b, 2, { tile: 11, stores: [0, 500] });
  const relay = programChain(ch, b, [0, 500, 0, 0, 0, 0, 0, 0]);
  try {
    const p1 = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 100 } });
    const p2 = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 120 } });
    assert.equal(p1.fields.seq, p2.fields.seq, '同じ番号で計画された');
    const r1 = relay.send(p1);
    const r2 = relay.send(p2);
    assert.equal((await sendOutcome(ch.reader, season, { wallet: b.address, ...p1 }, r1.signature)).status, 'landed');
    const o2 = await sendOutcome(ch.reader, season, { wallet: b.address, ...p2 }, r2.signature);
    assert.equal(o2.status, 'failed');
    assert.match(o2.why, /BadData/);
    // 番号 #3 の隊商はチェーンにある（同じ持ち主・同じ番号）が、それは p1 のもの。p2 は自分の取引の署名で「失敗」と分かる
    const { caravanAccount } = await import('../coop/chain.mjs');
    assert.equal((await caravanAccount(ch.reader, season, p2.caravan)).status, 'found', '(owner, seq) が同じ隊商はある');
    assert.notEqual(r1.signature, r2.signature);
  } finally { relay.close(); }
});

test('送信結果不明：中継は受け取ったが取引が見えない間は unknown。番号が別の送信で進めば seq-taken（推測で結び付けない）', async () => {
  const { b, seedB, ch, request } = await world();
  ch.holding(HOME_B, b, 2, { tile: 11, stores: [0, 500] });
  const relay = programChain(ch, b, [0, 500, 0, 0, 0, 0, 0, 0], { land: false });
  try {
    const p = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 100 } });
    const r = relay.send(p);
    assert.ok(r.ok);
    assert.equal((await sendOutcome(ch.reader, season, { wallet: b.address, ...p }, r.signature)).status, 'unknown');
    assert.equal((await sendOutcome(ch.reader, season, { wallet: b.address, ...p }, null)).status, 'unknown', '署名も分からない（通信の失敗）');
    // ゲームの画面から別の隊商を送り、番号 #3 が使われた
    ch.caravanSent(b, ownerTagOf(season, b.address), 3, { kind: 1, p: 8, q: 1, site: 0, gen: 1 }, [10, 0, 0, 0, 0, 0, 0, 0]);
    ch.citizen(b, 2, { caravans: 4, holdings: [HOME_B] });
    const o = await sendOutcome(ch.reader, season, { wallet: b.address, ...p }, r.signature);
    assert.equal(o.status, 'seq-taken');
  } finally { relay.close(); }
});

test('結び付けの前の到着：応じた後に送った隊商は、着いて口座が閉じた後でも元の送信の記録で結び付けて数える。応じる前の送信は断る', async () => {
  const { a, b, ch } = await world();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-early-'));
  let t = 1_790_000_000;
  ch.setClock(() => t);
  const board = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: () => t, reader: ch.reader, fetchHerald: async () => ({ status: 200, json: { v: 1, moving: [], vaults: [], ended: [] } }) });
  const put = async (who, rec) => { t += 1; return board.submit(await unsignedRecord(who, { v: 1, season, at: t, ...rec })); };
  const tag = ownerTagOf(season, b.address);
  // 応じる前に送って着いた隊商（#1）
  ch.caravanSent(b, tag, 1, HOME_A, [0, 50, 0, 0, 0, 0, 0, 0]);
  ch.caravanSettled(tag, 1, 0, HOME_A, [0, 50, 0, 0, 0, 0, 0, 0]);
  t += 1000;
  const id = (await put(a, { kind: 'request', goalId: 'crossing-storehouse-v1', need: { wood: 200 }, to: HOME_A, nation: 0, expiresAt: t + 86400, nonce: 'e' })).id;
  { const r = await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 }); assert.ok(r.ok, r.why); }
  // 応じた後に送り、結び付ける前に着いた隊商（#2）
  t += 10;
  ch.caravanSent(b, tag, 2, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]);
  ch.caravanSettled(tag, 2, 0, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]);
  assert.match((await put(b, { kind: 'link', request: id, caravan: { ownerTag: tag, seq: 1 } })).why, /応じる前に送った/);
  { const r = await put(b, { kind: 'link', request: id, caravan: { ownerTag: tag, seq: 2 } }); assert.ok(r.ok, r.why); }
  const v = await board.view({});
  assert.equal(v.arrivals[0].state, 'delivered');
  assert.equal(v.arrivals[0].verification, 'RuleDerived');
  assert.equal(v.joint[0].progress[0].verified, 200);
  // 他人（a）は、b の隊商を結び付けられない（元の送り主の印が違う）
  assert.match((await put(a, { kind: 'link', request: id, caravan: { ownerTag: tag, seq: 2 } })).why, /送った人|自分の依頼|応じていない/);
});

// ------------------------------------------------------------------ 送信の中身の一致・受諾の後の送信・結果不明の保持・規則の版（2026-10-30）

import { timingOf, recipientOf, TIMING_MARGIN, RECIPIENT_RULE } from '../coop/goal.mjs';

test('送信の中身：自分の署名で成功していても、命令・送り元・届け先・資源・量のどれかが依頼の計画と違えば landed にしない', async () => {
  const { b, seedB, ch, request } = await world();
  ch.holding(HOME_B, b, 2, { tile: 11, stores: [0, 500, 500] });
  const relay = programChain(ch, b, [0, 500, 500, 0, 0, 0, 0, 0]);
  try {
    const p = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 100, stone: 50 } });
    const r = relay.send(p);
    const base = { wallet: b.address, caravan: p.caravan, src: p.src, dst: p.dst, cargo: p.cargo };
    assert.equal((await sendOutcome(ch.reader, season, base, r.signature)).status, 'landed');
    const check = async (over, re) => { const o = await sendOutcome(ch.reader, season, { ...base, ...over }, r.signature); assert.equal(o.status, 'mismatch', JSON.stringify(over)); assert.match(o.why, re); };
    await check({ cargo: [0, 100, 60, 0, 0, 0, 0, 0] }, /荷が計画と違う/);
    await check({ cargo: [0, 100, 50, 1, 0, 0, 0, 0] }, /荷が計画と違う/);
    await check({ dst: { ...p.dst, gen: 2 } }, /届け先/);
    await check({ dst: { ...p.dst, site: 3 } }, /届け先/);
    await check({ src: { ...p.src, site: 6 } }, /送り元/);
    await check({ caravan: { ...p.caravan, seq: 4 } }, /隊商の口座|番号/);
    await check({ wallet: (await fixedSigner(new Uint8Array(32).fill(66))).address }, /署名者ではない/);
    // 別のプログラムの命令だけの取引（同じ署名の別取引を作る）
    const A = seasonAddresses(programId, '90');
    const other = b58(new Uint8Array(32).fill(8));
    const t = await ch.reader.transaction(r.signature);
    ch.tx([A.of('Caravan', { ownerTag: BigInt(p.caravan.ownerTag), seq: p.caravan.seq })], [], { signature: 'foreign-sig', message: { ...t.message, accountKeys: t.message.accountKeys.map(k => (k === programId ? other : k)) }, signatures: t.signatures });
    assert.match((await sendOutcome(ch.reader, season, base, 'foreign-sig')).why, /対象のプログラムの命令が 0 個/);
  } finally { relay.close(); }
});

test('受諾の後の送信：送信の blockTime と、板が応答を受け取った時刻の差が ±5 秒以内は前後を証明できず保留（数えない）', async () => {
  assert.equal(TIMING_MARGIN, 5);
  assert.equal(timingOf(1000, 990).status, 'after');
  assert.equal(timingOf(1000, 1005).status, 'boundary');
  assert.equal(timingOf(1000, 995).status, 'boundary');
  assert.equal(timingOf(1000, 1006).status, 'before');
  assert.equal(timingOf(null, 990).status, 'unknown');
  assert.equal(timingOf(1000, null).status, 'unknown', '古い形の記録（受け取った時刻がない）');
  // 板で：応じた直後（3秒後）に送った隊商は、結び付けはできるが数えない
  const { a, b, ch } = await world();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-tim-'));
  let t = 1_790_000_000;
  ch.setClock(() => t);
  const board = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: () => t, reader: ch.reader, fetchHerald: async () => ({ status: 200, json: { v: 1, moving: [], vaults: [], ended: [] } }) });
  const put = async (who, rec) => { t += 1; return board.submit(await unsignedRecord(who, { v: 1, season, at: t, ...rec })); };
  const id = (await put(a, { kind: 'request', goalId: 'crossing-storehouse-v1', need: { wood: 200 }, to: HOME_A, nation: 0, expiresAt: t + 86400, nonce: 't' })).id;
  await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 });
  t += 3;
  const tag = ownerTagOf(season, b.address);
  ch.caravanSent(b, tag, 3, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0], { src: HOME_B });
  { const r = await put(b, { kind: 'link', request: id, caravan: { ownerTag: tag, seq: 3 } }); assert.ok(r.ok, r.why); }
  ch.caravanSettled(tag, 3, 0, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]);
  const v = await board.view({});
  assert.equal(v.arrivals[0].timing.status, 'boundary');
  assert.equal(v.arrivals[0].counted, null);
  assert.match(v.arrivals[0].notCountedWhy, /証明できない（保留）/);
  assert.equal(v.joint[0].progress[0].verified, 0);
});

test('結果不明の送信は板の記録（sending）に残り、板を作り直しても、同じ依頼への次の送信の記録を断る。期限切れ・失敗・着地で解ける', async () => {
  const { a, b, ch } = await world();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-pend-'));
  let t = 1_790_000_000;
  const mk = () => createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: () => t, reader: ch.reader, fetchHerald: async () => ({ status: 200, json: { v: 1, moving: [], vaults: [], ended: [] } }) });
  let board = mk();
  const put = async (who, rec) => { t += 1; return board.submit(await unsignedRecord(who, { v: 1, season, at: t, ...rec })); };
  const id = (await put(a, { kind: 'request', goalId: 'crossing-storehouse-v1', need: { wood: 200 }, to: HOME_A, nation: 0, expiresAt: t + 86400, nonce: 'p' })).id;
  await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 });
  const tag = ownerTagOf(season, b.address);
  const sig = n => b58(new Uint8Array(64).fill(n));
  const sending = (n, seq) => ({ kind: 'sending', request: id, caravan: { ownerTag: tag, seq }, walletSig: sig(n), blockhash: b58(new Uint8Array(32).fill(n)), cargo: { wood: 200 }, src: HOME_B });
  { const r = await put(b, sending(1, 3)); assert.ok(r.ok, r.why); }
  const r2 = await put(b, sending(2, 3));
  assert.equal(r2.ok, false);
  assert.match(r2.why, /結果の分からない送信/);
  // 板を作り直しても残る
  board = mk();
  assert.match((await put(b, sending(3, 3))).why, /結果の分からない送信/);
  assert.equal((await board.view({ viewer: b.address })).requests[0].sendings[0].outcome.status, 'unknown');
  // 同じ記録の再送は、二度目として断る
  assert.match((await board.submit(board.records.find(r => r.kind === 'sending'))).why, /二度|結果の分からない/);
  // blockhash が切れた → もう着地しない → 次を送れる
  ch.expired.add(b58(new Uint8Array(32).fill(1)));
  { const r = await put(b, sending(4, 3)); assert.ok(r.ok, r.why); }
  // 応じていない人の sending、他人の鍵の隊商は断る
  assert.match((await put(a, { ...sending(5, 3), caravan: { ownerTag: ownerTagOf(season, a.address), seq: 0 } })).why, /応じていない|自分/);
  assert.match((await put(b, { ...sending(6, 3), caravan: { ownerTag: ownerTagOf(season, a.address), seq: 0 } })).why, /鍵|結果の分からない/);
});

test('規則の版：シーズンの規則の hash が、受取人の決め方を確かめた版（S1 の RULESET_HASH_V3）と違う・読めないなら、受取人は未検証で数えない', async () => {
  assert.equal(RECIPIENT_RULE.rulesetHash, V2.ruleset_hash_v3);
  const arrival = { state: 'delivered', dstGen: 1 };
  const now = { status: 'found', gen: 1, ownerCitizen: 'X' };
  assert.equal(recipientOf(arrival, now, 'X', { status: 'verified', rulesetHash: V2.ruleset_hash_v3 }).status, 'verified');
  assert.match(recipientOf(arrival, now, 'X', { status: 'verified', rulesetHash: '00'.repeat(32) }).why, /版/);
  assert.match(recipientOf(arrival, now, 'X', { status: 'unverified', why: 'シーズンの口座がない' }).why, /規則の版を確かめられない/);
  // 板で：シーズンの口座が別の規則
  const { seasonRules } = await import('../coop/chain.mjs');
  const { ch } = await world();
  ch.season('11'.repeat(32), 4);
  const r = await seasonRules(ch.reader, season);
  assert.equal(r.rulesetHash, '11'.repeat(32));
  assert.equal(r.programVersion, 4);
});
