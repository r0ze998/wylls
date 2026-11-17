// 国をまたぐ依頼の画面を本物のブラウザ（Chromium）で押す。鍵の生成・導出・署名をしない版（2026-11-08。coop.browser.mjs から、
// 入力の差し替えで移せる段だけを移した）。
//   - ウォレット：ゲームと同じ wallet.mjs が見つける Wallet Standard のウォレットを、試験が画面に登録する（鍵を持たない。
//     solana:signMessage は決まったバイト列を返すだけ、solana:signTransaction は断る）。Dev Wallet は選ばない（選ぶと鍵の種を作る）。
//   - 板：verify を、その決まったバイト列を確かめるだけの関数にする。口座の住所は本物（PDA の公開の住所の計算）。
//   - 送る：この画面から中継へ送る段（ウォレットの取引の署名・中継の手数料の鍵の署名）は移せない（coop.browser.mjs、未実施）。
//     代わりに、ゲームの村の引き出しから送った隊商を結び付ける段と、sending の記録が残った送信が着地した後に、画面を開き直し・板を
//     作り直してから結び付ける段（再起動の後の未確定送信）を押す。
//   node workstreams/01-national-strategy/test/coop.browser.nokey.mjs [--shots]

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createBoard, createServer, PAGE } from '../coop/board.mjs';
import { ownerTagOf } from '../coop/record.mjs';
import { planSend } from '../coop/send.mjs';
import { fakeChain, txJson } from './coop-chain.mjs';
import { buildShape } from '../../../permutation-server/web/frontier/fplay.mjs';
import { parseTransaction, wireTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { toBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.argv.includes('--shots');

const programId = b58(new Uint8Array(32).fill(3));
const season = { programId, seasonId: '90' };
const A = { address: b58(new Uint8Array(32).fill(11)), fill: 0xa1 }, B = { address: b58(new Uint8Array(32).fill(22)), fill: 0xb2 };   // 鍵ではない
const FILL = { [A.address]: A.fill, [B.address]: B.fill };
const fakeSig = who => toBase64(new Uint8Array(64).fill(FILL[who]));   // 試験のウォレットの「署名」（署名ではない）
const verify = async rec => FILL[rec.signer] !== undefined && rec.sig === fakeSig(rec.signer);
const tagB = ownerTagOf(season, B.address);
const HOME_A = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
const dst = { kind: 1, p: 3, q: 0, at: 2, gen: 1, tile: 20 };
const HOME_B = { p: 4, q: 0, site: 5, gen: 1 };

const file = { v: 1, moving: [], vaults: [], ended: [] };
// 中継：本物と同じく板 → ヘラルドの /gw で届く。ここでは GET /f/relay（手数料を払う住所・blockhash を答えるだけ。署名しない）だけを答える。
// POST（取引を送る）は試験では起きてはならないので、来たら数えて断る。
const relayPosts = [];
const herald = http.createServer((req, res) => {
  if (req.url.startsWith('/h/caravans.json')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(file)); }
  if (req.url === '/gw/f/relay' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, programId, feePayer: b58(new Uint8Array(32).fill(9)), blockhash: b58(new Uint8Array(32).fill(5)), lastValidBlockHeight: 99 })); }
  if (req.url.startsWith('/gw/')) { relayPosts.push(req.url); res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, code: 'NotInThisTest' })); }
  res.writeHead(404); res.end();
});
await new Promise(r => herald.listen(0, '127.0.0.1', r));
const hurl = `http://127.0.0.1:${herald.address().port}`;
const chain = fakeChain(programId, '90');
chain.citizen(A, 0, { holdings: [{ p: 3, q: 0, site: 2, gen: 1 }] }); chain.citizen(B, 2, { caravans: 0, holdings: [HOME_B] });
chain.holding({ p: 3, q: 0, site: 2, gen: 1 }, A, 0, { tile: 20 }); chain.holding(HOME_B, B, 2, { tile: 11, stores: [0, 500, 500] });
for (const [p, q] of [[4, 0], [5, 0], [5, -1], [4, -1], [3, 0], [3, 1], [4, 1], [3, -1], [2, 0], [2, 1]]) chain.province(p, q);
chain.season();
chain.setClock(() => Math.floor(Date.now() / 1000));
const rpc = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const { id, method, params } = JSON.parse(body);
  let result = null;
  if (method === 'getAccountInfo') { const b = await chain.reader.account(params[0]); result = { value: b ? { data: [Buffer.from(b).toString('base64'), 'base64'] } : null }; }
  if (method === 'getSignaturesForAddress') result = await chain.reader.signatures(params[0]);
  if (method === 'getTransaction') {
    const t = await chain.reader.transaction(params[0]);
    result = t ? { slot: t.slot, blockTime: t.blockTime, meta: { err: t.err, logMessages: t.logs },
      transaction: { signatures: t.signatures, message: t.message && { accountKeys: t.message.accountKeys, header: { numRequiredSignatures: t.message.numSigners }, instructions: t.message.instructions } } } : null;
  }
  if (method === 'isBlockhashValid') result = { value: await chain.reader.blockhashValid(params[0]) };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
});
await new Promise(r => rpc.listen(0, '127.0.0.1', r));
const rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
const boardDir = fs.mkdtempSync(join(os.tmpdir(), 'ws01-coop-brnk-'));
const mkBoard = () => createBoard({ herald: hurl, programId, seasonId: '90', dataDir: boardDir, reader: chain.reader, rpc: rpcUrl, verify });
let board = mkBoard();
let srv = createServer(board, { herald: hurl });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const urlOf = (s, q = 'to=3,0,2,1') => `http://127.0.0.1:${s.address().port}${PAGE}?${q}&follow=2`;

const browser = await chromium.launch();
const errors = [], results = [];
const step = async (name, f) => { try { await f(); results.push(['ok', name]); } catch (e) { results.push(['not ok', name, e.message]); } };

/** 画面に、鍵を持たない Wallet Standard のウォレットを登録する（ゲームの wallet.mjs の discover が受け取る）。 */
function walletScript({ address, fill, deferSign = false }) {
  // deferSign：取引の署名を求められたら、署名せずに待つ（window.__signCalls で数え、window.__rejectSign() で断る）。署名したバイト列は返さない
  window.__signCalls = 0;
  const account = { address, publicKey: new Uint8Array(32), chains: ['solana:localnet'], features: ['solana:signTransaction', 'solana:signMessage'] };
  const wallet = {
    version: '1.0.0', name: 'Test Wallet (no keys)', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['solana:localnet'], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => inputs.map(i => ({ signedMessage: i.message, signature: new Uint8Array(64).fill(fill) })) },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: async () => {
        window.__signCalls += 1;
        if (!deferSign) throw new Error('この試験のウォレットは取引に署名しない');
        return new Promise((_, reject) => { window.__rejectSign = () => reject(Object.assign(new Error('User rejected the request'), { code: 4001 })); });
      } },
    },
  };
  window.addEventListener('wallet-standard:app-ready', e => e.detail.register(wallet));
}

async function player(who, nation, server = srv, query = undefined, { deferSign = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript(walletScript, { address: who.address, fill: who.fill, deferSign });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(urlOf(server, query));
  await page.selectOption('#nation', String(nation));
  await page.waitForSelector('#wallet option:has-text("Test Wallet (no keys)")', { state: 'attached' });
  await page.selectOption('#wallet', { label: 'Test Wallet (no keys)' });
  await page.click('#connect');
  await page.waitForSelector('#who:has-text("Test Wallet")');
  return page;
}
const refresh = async page => page.selectOption('#nation', await page.inputValue('#nation'));

try {
  const pa = await player(A, 0);
  const pb = await player(B, 2);

  await step('ウォレットを選ぶ：ブラウザの Wallet Standard のウォレットを並べ、選んだもので署名する。Dev Wallet は選ばない限り鍵の種を作らない', async () => {
    assert.match(await pa.textContent('#who'), new RegExp(`${A.address.slice(0, 4)}…${A.address.slice(-4)}`));
    assert.match(await pa.textContent('#wallet'), /Dev Wallet（ローカル）/, 'localnet では Dev Wallet も選べる');
    assert.equal(await pa.evaluate(() => localStorage.getItem('ps-dev-wallet')), null, '選んでいないので、鍵の種は作られていない');
  });

  await step('A が依頼を出し、B が応じる（物は動かず、数えない）', async () => {
    assert.equal(await pa.inputValue('#toSite'), '2');
    await pa.click('#send');
    await pa.waitForSelector('#msg .ok');
    await refresh(pb);
    await pb.click('[data-act=accept]');
    await pb.waitForSelector('#msg .ok');
    assert.match(await pb.textContent('#requests'), /自分の隊商はまだ見えない/);
    assert.equal(await pb.textContent('[data-testid=joint-wood]'), '0');
  });

  await step('ゲームの村の引き出しから送った隊商（チェーンの口座とヘラルドの一覧に出る）を、B がこの画面で依頼に結び付ける', async () => {
    await new Promise(r => setTimeout(r, 6500));   // 応じてから送るまで（±5 秒の境界の外）
    chain.caravanSent(B, tagB, 0, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0], { src: HOME_B });
    chain.citizen(B, 2, { caravans: 1, holdings: [HOME_B] });
    file.moving.push({ ownerTag: tagB, seq: 0, faction: 2, src: { kind: 1, ...HOME_B, at: 5, tile: 11 }, dst, steps: 3, cargo: [0, 200, 0, 0, 0, 0, 0, 0], arriveTs: 1, runs: [], raided: false, path: Array(12).fill(0), provinces: [[4, 0], [3, 0]] });
    await refresh(pb);
    await pb.click('[data-act=link][data-seq="0"]');
    await pb.waitForSelector('#msg .ok:has-text("結び付けた")');
    await pb.waitForSelector('[data-testid=arrival-state]:has-text("輸送中")');
  });

  await step('到着の後：量は下限（以上）、依頼の充足は「届かなかった」（すべて終わり、石材の上限で証明）、共同の目的は「まだ達成と言えない」', async () => {
    file.moving = [];
    file.ended.push({ ownerTag: tagB, seq: 0, end: 'settled', outcome: 0, dst, cargo: [0, 196, 0, 0, 0, 0, 0, 0] });
    chain.caravanSettled(tagB, 0, 0, HOME_A, [0, 196, 0, 0, 0, 0, 0, 0]);
    await refresh(pa);
    await pa.waitForSelector('[data-testid=arrival-state]:has-text("到着（確定）")');
    assert.equal(await pa.textContent('[data-testid=joint-wood]'), '196');
    assert.equal(await pa.textContent('[data-testid=joint-status]'), 'まだ達成と言えない');
    assert.match(await pa.textContent('[data-testid=arrival-qty]'), /届いた 木材 196 以上・石材 0 以上（規則から）/);
    assert.match(await pa.textContent('[data-testid=arrival-terminal]'), /Partial/, '送った 200 に対し下限 196');
    assert.match(await pa.textContent('[data-testid=arrival-counted]'), /木材 196/);
    assert.equal(await pa.getAttribute('[data-testid=req-fulfilment]', 'data-status'), 'not-reached', 'すべて終わり、石材の上限 1 未満 ≤ 200 で届かなかった（証明）');
    await refresh(pb);
    await pb.waitForSelector('[data-testid=my-verified]:has-text("木材 196")');
    if (shots) await pa.screenshot({ path: join(here, '..', 'screenshots', '09-coop-nokey.jpg'), quality: 70, fullPage: true });
  });

  await step('再起動の後の未確定送信：sending の記録を残した送信が着地した後、板を作り直し画面を開き直すと、送る代わりに「結び付ける」を出し、押すと結び付く', async () => {
    await pa.click('#send');   // 二つ目の依頼
    await pa.waitForSelector('#msg .ok');
    const q2 = Object.values(board.state().requests).sort((x, y) => y.at - x.at)[0];
    await refresh(pb);
    await pb.locator(`[data-req="${q2.id}"] [data-act=accept]`).click();
    await pb.waitForSelector('#msg .ok');
    await new Promise(r => setTimeout(r, 6500));
    // この画面が中継へ出す前に残す sending の記録（画面の送信の途中で閉じた）と、その取引の着地（署名の欄は決まったバイト列）
    const p = await planSend({ reader: chain.reader, season, wallet: B.address, request: q2, cargo: { wood: 200 } });
    assert.ok(p.ok, p.why);
    const shape = buildShape({ programId, name: p.name, accounts: p.accounts, fields: p.fields, feePayer: b58(new Uint8Array(32).fill(9)), blockhash: b58(new Uint8Array(32).fill(5)), profile: 3 });
    const tx = parseTransaction(wireTransaction(shape.message));
    const walletSig = b58(new Uint8Array(64).fill(0x77)), feeSig = b58(new Uint8Array(64).fill(0x78));
    const sending = { v: 1, season, at: Math.floor(Date.now() / 1000), kind: 'sending', request: q2.id, caravan: p.caravan, walletSig, blockhash: b58(new Uint8Array(32).fill(5)), cargo: { wood: 200 }, src: { p: p.src.p, q: p.src.q, site: p.src.site, gen: p.src.gen }, signer: B.address };
    const r = await board.submit({ ...sending, sig: fakeSig(B.address) });
    assert.ok(r.ok, r.why);
    chain.caravanSent(B, tagB, p.caravan.seq, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0], { src: HOME_B, signature: feeSig, ...txJson(tx, tx.signers.map(k => (k === B.address ? walletSig : feeSig))) });
    chain.citizen(B, 2, { caravans: p.caravan.seq + 1, holdings: [HOME_B] });
    // 板を作り直す（同じ記録のフォルダ）、画面も開き直す
    srv.close();
    board = mkBoard();
    srv = createServer(board, { herald: hurl });
    await new Promise(res => srv.listen(0, '127.0.0.1', res));
    const pb2 = await player(B, 2, srv);
    const row = pb2.locator(`[data-req="${q2.id}"]`);
    await row.locator('[data-testid=pending-link]').waitFor();
    assert.equal(await row.locator('[data-act=send]').count(), 0, '送る（署名する）ボタンは出さない');
    await row.locator('[data-testid=pending-link]').click();
    await pb2.waitForSelector('#msg .ok:has-text("結び付けた")');
    await row.locator('[data-testid=pending-link]').waitFor({ state: 'detached' });
    assert.equal(board.state().requests[q2.id].links.length, 1);
    await pb2.context().close();
  });

  await step('A が「自分で進める」で取り消すと、B は新しく結び付けられない', async () => {
    const pa2 = await player(A, 0, srv);
    const first = Object.values(board.state().requests).sort((x, y) => x.at - y.at)[0];
    await pa2.locator(`[data-req="${first.id}"] [data-act=cancel-self]`).click();
    await pa2.waitForSelector('[data-testid=req-state]:has-text("取り消し：自分で進める")');
    assert.equal(board.state().requests[first.id].state, 'cancelled');
    await pa2.context().close();
  });

  await step('入口の届け先が読めない（?to= が壊れている）・空欄：届け先を入れるよう言い、村 (0,0) の 0 番には依頼しない', async () => {
    const before = Object.keys(board.state().requests).length;
    const pz = await player(A, 0, srv, 'to=3,0,x');
    assert.match(await pz.textContent('[data-testid=entry-warn]'), /届け先（\?to=3,0,x）が読めない/, 'ウォレットを接続した後も残る');
    assert.deepEqual(await Promise.all(['#toP', '#toQ', '#toSite', '#toGen'].map(k => pz.inputValue(k))), ['', '', '', '']);
    await pz.click('#send');
    await pz.waitForSelector('#msg .warn:has-text("届け先の村")');
    assert.equal(Object.keys(board.state().requests).length, before, '依頼は出ていない');
    await pz.context().close();
  });

  await step('届け先が依頼した人の村でない依頼：応じた人の画面は理由を出し、送る・結び付けるを出さない', async () => {
    const pa3 = await player(A, 0, srv, 'to=4,0,5,1');   // B の村
    await pa3.click('#send');
    await pa3.waitForSelector('#msg .ok');
    const q = Object.values(board.state().requests).sort((x, y) => y.at - x.at)[0];
    assert.deepEqual(q.to, { kind: 'holding', p: 4, q: 0, site: 5, gen: 1 });
    await pa3.context().close();
    const pb3 = await player(B, 2, srv);
    const row = pb3.locator(`[data-req="${q.id}"]`);
    await row.locator('[data-testid=req-destination]').waitFor();
    assert.match(await row.locator('[data-testid=req-destination]').textContent(), /今の持ち主が、依頼した人ではない/);
    assert.equal(await row.locator('[data-testid=req-destination]').getAttribute('data-status'), 'mismatch');
    await row.locator('[data-act=accept]').click();
    await pb3.waitForSelector('#msg .ok');
    await row.locator('[data-testid=req-destination]').waitFor();
    assert.equal(await row.locator('[data-act=send]').count(), 0);
    assert.equal(await row.locator('[data-act=link]').count(), 0);
    assert.doesNotMatch(await row.textContent(), /ゲームの村の引き出し「交易と防備」からも送れる/);
    await pb3.context().close();
  });

  await step('送るを続けて押す：ウォレットの署名の求めが終わるまで、二つ目の手続き（計画・確認・署名の求め）を始めない。断る・取り消すとボタンが戻る', async () => {
    const pa4 = await player(A, 0, srv);
    await pa4.click('#send');
    await pa4.waitForSelector('#msg .ok');
    const q = Object.values(board.state().requests).sort((x, y) => y.at - x.at)[0];
    await pa4.context().close();
    const pb4 = await player(B, 2, srv, undefined, { deferSign: true });
    const row = pb4.locator(`[data-req="${q.id}"]`);
    await row.locator('[data-act=accept]').click();
    await pb4.waitForSelector('#msg .ok');
    const sendingsBefore = q.sendings.length;
    const signCalls = () => pb4.evaluate(() => window.__signCalls);
    // 1 回目：確認に応じ、ウォレットが署名を求められたまま待つ
    await row.locator('[data-testid=send]').click();
    await pb4.waitForFunction(() => window.__signCalls === 1, null, { timeout: 15000 });
    await row.locator('[data-testid=send-busy]').waitFor();
    assert.equal(await row.locator('[data-testid=send]').isDisabled(), true, '手続きの途中はボタンを押せない');
    // 2 回目：ボタンを無理に押しても（disabled を外して click）、ウォレットへの求めは増えない
    await pb4.evaluate(id => { const b = document.querySelector(`[data-req="${id}"] [data-testid=send]`); b.disabled = false; b.click(); }, q.id);
    await pb4.waitForSelector('#msg .warn:has-text("送る手続きが進んでいる")');
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(await signCalls(), 1, '二つ目の署名の求めを始めない');
    // ウォレットで断る → 手続きが終わり、ボタンが戻る
    await pb4.evaluate(() => window.__rejectSign());
    await pb4.waitForSelector('#msg .bad:has-text("送れなかった")');
    await row.locator('[data-testid=send-busy]').waitFor({ state: 'detached' });
    assert.equal(await row.locator('[data-testid=send]').isDisabled(), false, '断った後はまた押せる');
    // 確認で取り消す → ウォレットへ求めず、ボタンが戻る
    pb4.removeAllListeners('dialog');
    pb4.once('dialog', d => d.dismiss());
    await row.locator('[data-testid=send]').click();
    await pb4.waitForSelector('#msg :text("送らなかった")');
    assert.equal(await signCalls(), 1, '取り消したら署名を求めない');
    assert.equal(await row.locator('[data-testid=send]').isDisabled(), false);
    // もう一度送り、また断る：求めはちょうど 1 回増える（手続きが前の手続きから戻っている）
    pb4.on('dialog', d => d.accept());
    await row.locator('[data-testid=send]').click();
    await pb4.waitForFunction(() => window.__signCalls === 2, null, { timeout: 15000 });
    await pb4.evaluate(() => window.__rejectSign());
    await pb4.waitForSelector('#msg .bad:has-text("送れなかった")');
    assert.equal(await signCalls(), 2);
    assert.deepEqual(relayPosts, [], '中継へは何も送っていない');
    assert.equal(board.state().requests[q.id].sendings.length, sendingsBefore, '署名されていないので sending の記録も無い');
    await pb4.context().close();
  });

  await step('スマホの幅で横にはみ出さない', async () => {
    const pm = await player(A, 0, srv);
    await pm.setViewportSize({ width: 390, height: 900 });
    await refresh(pm);
    const over = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `はみ出し ${over}px`);
    await pm.context().close();
  });

  await step('ページのエラーがない', async () => { assert.deepEqual(errors.filter(e => !/Failed to load resource/.test(e)), []); });
} finally {
  await browser.close();
  srv.close(); herald.close(); rpc.close();
}

for (const [s, n, m] of results) console.log(`${s} - ${n}${m ? `\n  ${m}` : ''}`);
const failed = results.filter(r => r[0] !== 'ok').length;
console.log(`# pass ${results.length - failed}\n# fail ${failed}`);
process.exit(failed ? 1 : 0);
