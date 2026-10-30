// 依頼に応じて送る：既存の S1 の隊商の道（SendCaravan）を、ゲームの画面と同じコードで組み立て、ウォレットで署名して中継へ送る。
// チェーンは偽物（口座のバイト列を v2 の配置で書いたもの）、中継も偽物（受け取った取引の署名を確かめ、手数料を払う鍵で署名を返す）。
// 本物のチェーンでの実行は未実施（docs 17章 17-4b）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testSigner, signRecord, ownerTagOf } from '../coop/record.mjs';
import { planSend, sendPlanned } from '../coop/send.mjs';
import { createBoard } from '../coop/board.mjs';
import { fakeChain } from './coop-chain.mjs';
import { parseTransaction, wireTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { decodeIxData } from '../../../permutation-server/web/sdk/frontier/codec.mjs';
import { devWallet } from '../../../permutation-server/web/wallet.mjs';
import { keyFromSeed, verify } from '../../../permutation-server/web/session.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { PRESETS as V2 } from '../../../permutation-server/web/sdk/frontier/abi-v2-presets.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';

const programId = b58(new Uint8Array(32).fill(3));
const season = { programId, seasonId: '90' };
const RULESET_V3 = V2.ruleset_hash_v3;
const HOME_A = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
const HOME_B = { p: 4, q: 0, site: 5, gen: 1 };

/** ゲームの Dev Wallet（wallet.mjs devWallet・session.mjs keyFromSeed）で取引に署名する。 */
async function devSigner(seed) {
  const key = await keyFromSeed(seed);
  const w = devWallet(key);
  return {
    address: key.publicKey,
    signTransaction: async wire => (await w.features['solana:signTransaction'].signTransaction({ transaction: wire }))[0].signedTransaction,
  };
}

/** 偽の中継：GET /f/relay で手数料を払う鍵と blockhash、POST /f/relay で受け取った取引の署名を確かめ、手数料の鍵で署名して返す。 */
async function fakeRelay(onTx) {
  const fee = await testSigner(new Uint8Array(32).fill(9));
  const got = [];
  const srv = http.createServer(async (req, res) => {
    const json = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === '/f/relay') return json({ ok: true, programId, feePayer: fee.address, blockhash: b58(new Uint8Array(32).fill(5)), lastValidBlockHeight: 99 });
    if (req.method === 'POST' && req.url === '/f/relay') {
      let body = ''; for await (const c of req) body += c;
      const wire = Buffer.from(JSON.parse(body).tx, 'base64');
      const tx = parseTransaction(new Uint8Array(wire));
      // 手数料の鍵以外の署名者が、みな正しく署名しているか
      for (let i = 0; i < tx.signers.length; i++) {
        if (tx.signers[i] === fee.address) continue;
        if (!(await verify(tx.signers[i], tx.message, tx.signatures[i]))) return json({ ok: false, code: 'BadSignature', error: `${tx.signers[i]} の署名が合わない` });
      }
      const feeSig = await fee.signMessage(tx.message);
      got.push({ tx, wire: wireTransaction(tx.message, { ...Object.fromEntries(tx.signers.map((s, i) => [s, tx.signatures[i]])), [fee.address]: feeSig }) });
      await onTx?.(tx);
      return json({ ok: true, signature: b58(feeSig) });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, got, close: () => srv.close(), fee };
}

async function world() {
  const a = await testSigner(new Uint8Array(32).fill(11));
  const seedB = new Uint8Array(32).fill(22);
  const b = await testSigner(seedB);
  const ch = fakeChain(programId, '90');
  ch.citizen(a, 0, { holdings: [{ ...HOME_A }] });
  ch.citizen(b, 2, { caravans: 3, holdings: [HOME_B] });
  ch.holding(HOME_A, a, 0, { tile: 20 });
  ch.holding(HOME_B, b, 2, { tile: 11 });
  for (const [p, q] of [[4, 0], [5, 0], [5, -1], [4, -1], [3, 0], [3, 1], [4, 1], [3, -1], [2, 0], [2, 1]]) ch.province(p, q);
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

test('送る：送る人のウォレット（ゲームの Dev Wallet のコード）だけが署名し、中継が手数料の鍵で署名した取引は SendCaravan で、荷と届け先が依頼のとおり', async () => {
  const { b, seedB, ch, request } = await world();
  const relay = await fakeRelay();
  try {
    const p = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 120, stone: 80 } });
    const r = await sendPlanned(p, { relay: relay.url, season, rulesetHash: RULESET_V3, wallet: await devSigner(seedB) });
    assert.ok(r.ok, r.error);
    assert.equal(relay.got.length, 1);
    const tx = relay.got[0].tx;
    assert.deepEqual(new Set(tx.signers), new Set([relay.fee.address, b.address]), '署名者は手数料の鍵と送る人のウォレットだけ');
    const ix = tx.instructions.find(i => tx.accountKeys[i.programIdIndex] === programId);
    const d = decodeIxData(ix.data, 3);
    assert.equal(d.name, 'SendCaravan');
    const f = d;
    assert.equal(Number(f.seq), 3);
    assert.equal(Number(f.dst_p), 3); assert.equal(Number(f.dst_q), 0); assert.equal(Number(f.dst_at), 2); assert.equal(Number(f.dst_gen), 1);
    const cargo = f.cargo instanceof Uint8Array ? f.cargo : Uint8Array.from(f.cargo);
    const dv = new DataView(cargo.buffer, cargo.byteOffset);
    assert.equal(dv.getUint32(4, true), 120, '木材');
    assert.equal(dv.getUint32(8, true), 80, '石材');
    assert.equal(dv.getUint32(0, true) + dv.getUint32(12, true) + dv.getUint32(16, true), 0, 'ほかの資源は積まない');
  } finally { relay.close(); }
});

test('送る：別の人の鍵で署名した取引は、ゲームのコードが送る前に止める（中継に届かない）', async () => {
  const { b, ch, request } = await world();
  const relay = await fakeRelay();
  try {
    const p = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 10 } });
    const wrong = await devSigner(new Uint8Array(32).fill(77));
    const r = await sendPlanned(p, { relay: relay.url, season, rulesetHash: RULESET_V3, wallet: wrong });
    assert.equal(r.ok, false);
    assert.equal(relay.got.length, 0);
  } finally { relay.close(); }
});

test('一巡（模擬のチェーン）：依頼 → 応じる → この画面から送る → チェーンに載る → 結び付け（隊商の口座で確かめる）→ 確定 → 数える', async () => {
  const { a, b, seedB, ch, request: _r } = await world();
  void _r;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-send-'));
  let t = 1_790_000_000;
  const board = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: () => t, reader: ch.reader, fetchHerald: async () => ({ status: 200, json: { v: 1, moving: [], vaults: [], ended: [] } }) });
  const put = async (who, rec) => { t += 1; return board.submit(await signRecord(who, { v: 1, season, at: t, ...rec })); };
  const id = (await put(a, { kind: 'request', goalId: 'crossing-storehouse-v1', need: { wood: 200, stone: 200 }, to: HOME_A, nation: 0, expiresAt: t + 86400, nonce: 'x' })).id;
  { const r = await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 }); assert.ok(r.ok, r.why); }
  const request = (await board.view({})).requests[0];
  // 中継が受け取ったら、チェーンに載ったとして隊商の口座を作る（ここが模擬）
  const relay = await fakeRelay(async () => ch.caravanSent(b, ownerTagOf(season, b.address), 3, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]));
  try {
    const p = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 200 } });
    const s = await sendPlanned(p, { relay: relay.url, season, rulesetHash: RULESET_V3, wallet: await devSigner(seedB) });
    assert.ok(s.ok, s.error);
    { const r = await put(b, { kind: 'link', request: id, caravan: p.caravan }); assert.ok(r.ok, r.why); }
    let v = await board.view({});
    assert.equal(v.joint[0].progress[0].verified, 0, '輸送中は数えない');
    ch.caravanSettled(p.caravan.ownerTag, 3, 0, HOME_A, [0, 196, 0, 0, 0, 0, 0, 0]);
    v = await board.view({});
    assert.equal(v.arrivals[0].source, 'chain-log');
    assert.equal(v.joint[0].progress[0].verified, 196);
  } finally { relay.close(); }
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

/**
 * 「プログラムのように振る舞う」偽の中継：受け取った SendCaravan の番号が Citizen の CARAVANS と同じで、在庫が足りれば
 * 隊商を作って番号を進め、違えば失敗した取引として記録する（caravan.rs:695 の BadData、Insufficient）。land=false なら何も載せない。
 */
async function programRelay(ch, b, stock, { land = true } = {}) {
  let caravans = 3;
  return fakeRelay(async tx => {
    if (!land) return;
    const ix = tx.instructions.find(i => tx.accountKeys[i.programIdIndex] === programId);
    const d = decodeIxData(ix.data, 3);
    const cargo = Array.from({ length: 8 }, (_, i) => new DataView(d.cargo.buffer, d.cargo.byteOffset).getUint32(4 * i, true));
    const signature = b58(await (await testSigner(new Uint8Array(32).fill(9))).signMessage(tx.message));
    const bad = Number(d.seq) !== caravans ? 'BadData' : cargo.some((v, i) => v > (stock[i] ?? 0)) ? 'Insufficient' : null;
    if (bad) { ch.tx([], [], { err: { InstructionError: [1, { Custom: bad }] }, signature }); return; }
    cargo.forEach((v, i) => { stock[i] -= v; });
    ch.caravanSent(b, ownerTagOf(season, b.address), caravans, { kind: 1, p: Number(d.dst_p), q: Number(d.dst_q), site: Number(d.dst_at), gen: Number(d.dst_gen) }, cargo, { signature });
    caravans += 1;
    ch.citizen(b, 2, { caravans, holdings: [HOME_B] });
  });
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
  const relay = await programRelay(ch, b, stock);
  try {
    const p1 = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 100 }, now: 1_790_000_000 });
    assert.deepEqual(p1.estimate.shortfall, {});
    const r1 = await sendPlanned(p1, { relay: relay.url, season, wallet: await devSigner(seedB) });
    assert.equal((await sendOutcome(ch.reader, season, { wallet: b.address, ...p1 }, r1.signature)).status, 'landed');
    // 二つ目：計画の時点の見込みは古い（在庫 150 のまま）。番号は進んだので計画し直すが、在庫は 50 しかない
    const p2 = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 100 }, now: 1_790_000_000 });
    assert.deepEqual(p2.estimate.shortfall, {}, '見込みは村の口座の記録（偽のチェーンは在庫を書き換えない）');
    const r2 = await sendPlanned(p2, { relay: relay.url, season, wallet: await devSigner(seedB) });
    assert.ok(r2.ok, '中継は受け取る（判定はプログラム）');
    const o2 = await sendOutcome(ch.reader, season, { wallet: b.address, ...p2 }, r2.signature);
    assert.equal(o2.status, 'failed');
    assert.match(o2.why, /Insufficient/);
  } finally { relay.close(); }
});

test('隊商の番号の競合：同じ番号で計画した二つの送信は、先に着いた方だけが成功し、後は失敗（BadData）。自分の取引の署名で区別する', async () => {
  const { b, seedB, ch, request } = await world();
  ch.holding(HOME_B, b, 2, { tile: 11, stores: [0, 500] });
  const relay = await programRelay(ch, b, [0, 500, 0, 0, 0, 0, 0, 0]);
  try {
    const p1 = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 100 } });
    const p2 = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 120 } });
    assert.equal(p1.fields.seq, p2.fields.seq, '同じ番号で計画された');
    const w = await devSigner(seedB);
    const r1 = await sendPlanned(p1, { relay: relay.url, season, wallet: w });
    const r2 = await sendPlanned(p2, { relay: relay.url, season, wallet: w });
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
  const relay = await programRelay(ch, b, [0, 500, 0, 0, 0, 0, 0, 0], { land: false });
  try {
    const p = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 100 } });
    const r = await sendPlanned(p, { relay: relay.url, season, wallet: await devSigner(seedB) });
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
  const put = async (who, rec) => { t += 1; return board.submit(await signRecord(who, { v: 1, season, at: t, ...rec })); };
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
