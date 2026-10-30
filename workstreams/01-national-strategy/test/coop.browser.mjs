// 国をまたぐ依頼の画面を本物のブラウザ（Chromium）で押す。2人（別々の Dev Wallet）で、依頼 → 応じる → 隊商の結び付け
// → 到着の確定 → 共同の目的、と取消を確かめる。ヘラルドは偽物（隊商の一覧を手で書き換える）。チェーンは使わない。
//   node workstreams/01-national-strategy/test/coop.browser.mjs [--shots]

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createBoard, createServer, PAGE } from '../coop/board.mjs';
import { testSigner, ownerTagOf } from '../coop/record.mjs';
import { fakeChain, txJson } from './coop-chain.mjs';
import { parseTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { verify } from '../../../permutation-server/web/session.mjs';
import { toHex } from '../../../permutation-server/web/sdk/bytes.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.argv.includes('--shots');

const programId = b58(new Uint8Array(32).fill(3));
const season = { programId, seasonId: '90' };
const seedA = new Uint8Array(32).fill(11), seedB = new Uint8Array(32).fill(22);
const A = await testSigner(seedA), B = await testSigner(seedB);
const tagB = ownerTagOf(season, B.address);
const dst = { kind: 1, p: 3, q: 0, at: 2, gen: 1, tile: 20 };

const file = { v: 1, moving: [], vaults: [], ended: [] };
// 偽のヘラルド：h/caravans.json と、本物のヘラルドと同じく /gw/* を中継へ転送する（server.rs gw）
let relayPort = 0;
const herald = http.createServer((req, res) => {
  if (req.url.startsWith('/h/caravans.json')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(file)); }
  if (req.url.startsWith('/gw/')) {
    const fwd = http.request({ host: '127.0.0.1', port: relayPort, method: req.method, path: req.url.slice(3), headers: { 'content-type': req.headers['content-type'] ?? 'application/json' } }, r => { res.writeHead(r.statusCode, { 'content-type': 'application/json' }); r.pipe(res); });
    return req.pipe(fwd);
  }
  res.writeHead(404); res.end();
});
await new Promise(r => herald.listen(0, '127.0.0.1', r));
const hurl = `http://127.0.0.1:${herald.address().port}`;
// 偽のチェーン（口座のバイト列は v2 の配置）：A の村 (3,0)#2、B の村 (4,0)#5、道の州
const chain = fakeChain(programId, '90');
const HOME_B = { p: 4, q: 0, site: 5, gen: 1 };
chain.citizen(A, 0, { holdings: [{ p: 3, q: 0, site: 2, gen: 1 }] }); chain.citizen(B, 2, { caravans: 0, holdings: [HOME_B] });
chain.holding({ p: 3, q: 0, site: 2, gen: 1 }, A, 0, { tile: 20 }); chain.holding(HOME_B, B, 2, { tile: 11, stores: [0, 150, 500] });
for (const [p, q] of [[4, 0], [5, 0], [5, -1], [4, -1], [3, 0], [3, 1], [4, 1], [3, -1], [2, 0], [2, 1]]) chain.province(p, q);
chain.season();
chain.setClock(() => Math.floor(Date.now() / 1000));   // 取引の blockTime は今の時刻（板の受け取った時刻と比べる）
// 偽の RPC（読むだけ。画面は板の /coop/rpc を通して読む）
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
// 偽の中継（本物と同じく CORS の見出しなし・OPTIONS なし。画面からは同じ入口の /gw でしか届かない）：
// 受け取った取引の署名を確かめ、手数料の鍵で署名して返す。受け取ったらチェーンに載ったとする（模擬）
const fee = await testSigner(new Uint8Array(32).fill(9));
const relayed = [];
let landing = true;   // false：中継は受け取るが、チェーンに載らない（結果不明）
const relay = http.createServer(async (req, res) => {
  const json = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method === 'OPTIONS') { res.writeHead(404); return res.end(); }
  if (req.method === 'GET' && req.url === '/f/relay') return json({ ok: true, programId, feePayer: fee.address, blockhash: b58(new Uint8Array(32).fill(5)), lastValidBlockHeight: 99 });
  let body = ''; for await (const c of req) body += c;
  const tx = parseTransaction(new Uint8Array(Buffer.from(JSON.parse(body).tx, 'base64')));
  const i = tx.signers.indexOf(B.address);
  if (i < 0 || !(await verify(B.address, tx.message, tx.signatures[i]))) return json({ ok: false, code: 'BadSignature', error: 'B の署名がない' });
  relayed.push(tx);
  if (!landing) return json({ ok: true, signature: b58(await fee.signMessage(tx.message)) });
  const seq = relayed.filter(x => x.landed).length;
  tx.landed = true;
  const signature = b58(await fee.signMessage(tx.message));
  const sigs = tx.signers.map((k, i) => (k === fee.address ? signature : b58(tx.signatures[i])));
  chain.caravanSent(B, tagB, seq, { kind: 1, p: 3, q: 0, site: 2, gen: 1 }, [0, 200, 200, 0, 0, 0, 0, 0], { signature, ...txJson(tx, sigs), src: HOME_B });
  chain.citizen(B, 2, { caravans: seq + 1, holdings: [HOME_B] });
  file.moving.push({ ownerTag: tagB, seq, faction: 2, src: { kind: 1, ...HOME_B, at: 5, tile: 11 }, dst, steps: 3, cargo: [0, 200, 0, 0, 0, 0, 0, 0], arriveTs: 1, runs: [], raided: false, path: Array(12).fill(0), provinces: [[4, 0], [3, 0]] });
  return json({ ok: true, signature });
});
await new Promise(r => relay.listen(0, '127.0.0.1', r));
relayPort = relay.address().port;
const boardDir = fs.mkdtempSync(join(os.tmpdir(), 'ws01-coop-br-'));
const board = createBoard({ herald: hurl, programId, seasonId: '90', dataDir: boardDir, reader: chain.reader,
  rpc: `http://127.0.0.1:${rpc.address().port}` });   // 中継は既定の /gw（同じ入口）
const srv = createServer(board, { herald: hurl });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}${PAGE}?to=3,0,2,1`;

const browser = await chromium.launch();
const errors = [], results = [], dialogs = [];
const step = async (name, f) => { try { await f(); results.push(['ok', name]); } catch (e) { results.push(['not ok', name, e.message]); } };

async function player(seed, nation) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript(hex => localStorage.setItem('ps-dev-wallet', hex), toHex(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.selectOption('#nation', String(nation));
  await page.click('#connect');
  await page.waitForSelector('#who:has-text("Dev Wallet")');
  return page;
}
const refresh = async page => page.selectOption('#nation', await page.inputValue('#nation'));   // 表示を読み直す

try {
  const pa = await player(seedA, 0);
  const pb = await player(seedB, 2);

  await step('Dev Wallet の住所が、テストの鍵と同じ（ゲームと同じ鍵の置き場所 ps-dev-wallet）', async () => {
    assert.match(await pa.textContent('#who'), new RegExp(`${A.address.slice(0, 4)}…${A.address.slice(-4)}`));
  });

  await step('A が依頼を出す（届け先は ?to= で入る：⑦の入口）', async () => {
    assert.equal(await pa.inputValue('#toSite'), '2');
    await pa.click('#send');
    await pa.waitForSelector('#msg .ok');
    await pa.waitForSelector('[data-req] [data-testid=req-state]:has-text("受付中")');
  });

  await step('B が応じても、物は動かず、数えない', async () => {
    await refresh(pb);
    await pb.click('[data-act=accept]');
    await pb.waitForSelector('#msg .ok');
    assert.match(await pb.textContent('#requests'), /この画面から送る（.*ウォレットで署名）[\s\S]*ゲームの村の引き出し「交易と防備」からも送れる/);
    assert.match(await pb.textContent('#requests'), /自分の隊商はまだ見えない/);
    assert.match(await pb.textContent('#requests'), /（国3）：送るつもり/, '応じた人の国（申告）');
    assert.equal(await pb.textContent('[data-testid=joint-wood]'), '0');
  });

  await step('B が「この画面から送る」：ゲームと同じコードで SendCaravan を組み立て、B の Dev Wallet で署名して中継へ。載ったら自動で結び付ける', async () => {
    await new Promise(r => setTimeout(r, 6500));   // 応じてから送るまで（±5 秒の境界の外。受諾の後の送信と証明できるように）
    await refresh(pb);
    await pb.click('[data-act=send]');
    await pb.waitForSelector('#msg .ok:has-text("結び付けた")', { timeout: 15000 });
    assert.equal(relayed.length, 1, '中継に届いた取引は1つ');
    assert.match(dialogs.at(-1), /不足（見込み）：木材 50/, '送る前に、送り元の不足の見込みを出す（在庫 150、荷 200）');
    assert.match(dialogs.at(-1), /最終判定は、送信の時にプログラム/);
    assert.ok(relayed[0].signers.includes(B.address) && !relayed[0].signers.includes(A.address), '署名者は送る人（B）と手数料の鍵だけ');
    await pb.waitForSelector('[data-testid=arrival-state]:has-text("輸送中")');
  });

  await step('到着の確定の後、共同の目的に木材だけが入り、石材が足りないので未達成。個人の量は B に出る', async () => {
    file.moving = [];
    file.ended.push({ ownerTag: tagB, seq: 0, end: 'settled', outcome: 0, dst, cargo: [0, 196, 0, 0, 0, 0, 0, 0] });
    chain.caravanSettled(tagB, 0, 0, { kind: 1, p: 3, q: 0, site: 2, gen: 1 }, [0, 196, 0, 0, 0, 0, 0, 0]);   // 正本：チェーンの取引の記録
    await refresh(pa);
    await pa.waitForSelector('[data-testid=arrival-state]:has-text("到着（確定）")');
    assert.equal(await pa.textContent('[data-testid=joint-wood]'), '196');
    assert.equal(await pa.textContent('[data-testid=joint-stone]'), '0');
    assert.equal(await pa.textContent('[data-testid=joint-status]'), '未達成');
    assert.match(await pa.textContent('[data-testid=joint-why]'), /石材 0／200/);
    assert.match(await pa.textContent('[data-testid=arrival-qty]'), /木材 196・石材 0（規則から）/, '④の分類（RuleDerived）');
    assert.match(await pa.textContent('[data-testid=arrival-recipient]'), /依頼した人（世代 1）/);
    assert.match(await pa.textContent('[data-testid=arrival-counted]'), /木材 196/);
    assert.match(await pa.textContent('#judgeMeans'), /使って建てた証拠ではない/, '判定の意味を画面に出す');
    assert.match(await pa.textContent('[data-testid=my-nation]'), /国1（チェーンの Citizen で確かめた）/);
    await refresh(pb);
    await pb.waitForSelector('[data-testid=my-verified]:has-text("木材 196")');
    if (shots) await pa.screenshot({ path: join(here, '..', 'screenshots', '09-coop.jpg'), quality: 70, fullPage: true });
  });

  await step('A が「自分で進める」で取り消すと、B は新しく結び付けられない', async () => {
    await pa.click('[data-act=cancel-self]');
    await pa.waitForSelector('[data-testid=req-state]:has-text("取り消し：自分で進める")');
    await refresh(pb);
    await pb.waitForSelector('[data-testid=req-state]:has-text("取り消し")');
    assert.equal(await pb.locator('[data-act=link]').count(), 0);
    assert.equal(await pb.locator('[data-act=accept]').count(), 0);
  });

  await step('結果不明の送信：再読込しても、板を作り直しても残り、次の署名・送付をしない。blockhash が切れると送り直せる', async () => {
    // 新しい依頼に B が応じ、送るが、チェーンに載らない
    await pa.click('#send');
    await pa.waitForSelector('#msg .ok');
    await refresh(pb);
    const req2 = pb.locator('[data-req]').filter({ hasText: '受付中' });
    await req2.locator('[data-act=accept]').click();
    await pb.waitForSelector('#msg .ok');
    await new Promise(r => setTimeout(r, 6500));
    landing = false;
    const before = relayed.length;
    await pb.goto(`${url}&follow=2`);
    await pb.selectOption('#nation', '2'); await pb.click('#connect'); await pb.waitForSelector('#who:has-text("Dev Wallet")');
    await pb.locator('[data-req]').filter({ hasText: '受付中' }).locator('[data-act=send]').click();
    await pb.waitForSelector('#msg .warn:has-text("結果がまだ分からない")', { timeout: 20000 });
    assert.equal(relayed.length, before + 1, '中継へは1回だけ');
    // 再読込
    await pb.reload();
    await pb.click('#connect'); await pb.waitForSelector('#who:has-text("Dev Wallet")');
    await pb.waitForSelector('[data-testid=pending-send]');
    await pb.click('[data-testid=pending-send]');
    await pb.waitForSelector('#msg .warn:has-text("結果がまだ分からない")', { timeout: 20000 });
    assert.equal(relayed.length, before + 1, '再読込の後も、確かめ直すだけで再署名・再送はしない');
    // 板を作り直す（同じ記録のフォルダ、別の入口）
    const board2 = createBoard({ herald: hurl, programId, seasonId: '90', dataDir: boardDir, reader: chain.reader, rpc: `http://127.0.0.1:${rpc.address().port}` });
    const srv2 = createServer(board2, { herald: hurl });
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const ctx2 = await browser.newContext(); await ctx2.addInitScript(hex => localStorage.setItem('ps-dev-wallet', hex), toHex(seedB));
    const p2 = await ctx2.newPage(); p2.on('pageerror', e => errors.push(String(e)));
    await p2.goto(`http://127.0.0.1:${srv2.address().port}${PAGE}?to=3,0,2,1&follow=2`);
    await p2.click('#connect'); await p2.waitForSelector('#who:has-text("Dev Wallet")');
    await p2.waitForSelector('[data-testid=pending-send]');
    // blockhash が切れた → もう着地しない → 送り直せる
    chain.expired.add(relayed.at(-1).recentBlockhash);
    await p2.reload(); await p2.click('#connect'); await p2.waitForSelector('#who:has-text("Dev Wallet")');
    await p2.waitForSelector('[data-req]:has-text("受付中") [data-act=send]:has-text("この画面から送る")');
    assert.equal(await p2.locator('[data-testid=pending-send]').count(), 0);
    srv2.close(); await ctx2.close();
  });

  await step('スマホの幅で横にはみ出さない', async () => {
    await pa.setViewportSize({ width: 390, height: 900 });
    const over = await pa.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `はみ出し ${over}px`);
  });

  await step('ページのエラーがない', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  srv.close(); herald.close(); rpc.close(); relay.close();
}

for (const [s, n, m] of results) console.log(`${s} - ${n}${m ? `\n  ${m}` : ''}`);
const failed = results.filter(r => r[0] !== 'ok').length;
console.log(`# pass ${results.length - failed}\n# fail ${failed}`);
process.exit(failed ? 1 : 0);
