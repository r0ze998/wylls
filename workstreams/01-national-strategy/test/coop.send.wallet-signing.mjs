// 【鍵が要る：未実施】ウォレット（ゲームの Dev Wallet のコード）で署名し、偽の中継が手数料の鍵で署名する経路の試験。
// 2026-11-08 の方針（鍵の生成・導出・署名をしない）で、coop.send.test.mjs から分けた。.test.mjs ではないので、node --test の一括では走らない。
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
import { fakeChain, txJson } from './coop-chain.mjs';
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
  ch.season();
  const request = { id: 'r1', requester: a.address, need: { wood: 200, stone: 200 }, to: { ...HOME_A } };
  return { a, b, seedB, ch, request };
}

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
  ch.setClock(() => t);
  const board = createBoard({ herald: null, programId, seasonId: '90', dataDir: dir, now: () => t, reader: ch.reader, fetchHerald: async () => ({ status: 200, json: { v: 1, moving: [], vaults: [], ended: [] } }) });
  const put = async (who, rec) => { t += 1; return board.submit(await signRecord(who, { v: 1, season, at: t, ...rec })); };
  const id = (await put(a, { kind: 'request', goalId: 'crossing-storehouse-v1', need: { wood: 200, stone: 200 }, to: HOME_A, nation: 0, expiresAt: t + 86400, nonce: 'x' })).id;
  { const r = await put(b, { kind: 'respond', request: id, answer: 'accept', offer: { wood: 200 }, nation: 2 }); assert.ok(r.ok, r.why); }
  const request = (await board.view({})).requests[0];
  t += 30;   // 応じてから送るまでの間（±TIMING_MARGIN 秒の境界の外）
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

