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
const herald = http.createServer((req, res) => {
  if (req.url.startsWith('/h/caravans.json')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(file)); }
  res.writeHead(404); res.end();
});
await new Promise(r => herald.listen(0, '127.0.0.1', r));
const hurl = `http://127.0.0.1:${herald.address().port}`;
const board = createBoard({ herald: hurl, programId, seasonId: '90', dataDir: fs.mkdtempSync(join(os.tmpdir(), 'ws01-coop-br-')) });
const srv = createServer(board, { herald: hurl });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}${PAGE}?to=3,0,2,1`;

const browser = await chromium.launch();
const errors = [], results = [];
const step = async (name, f) => { try { await f(); results.push(['ok', name]); } catch (e) { results.push(['not ok', name, e.message]); } };

async function player(seed, nation) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript(hex => localStorage.setItem('ps-dev-wallet', hex), toHex(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
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
    assert.match(await pb.textContent('#requests'), /送るのはゲームの村の引き出し「交易と防備」から/);
    assert.match(await pb.textContent('#requests'), /自分の隊商はまだ見えない/);
    assert.match(await pb.textContent('#requests'), /（国3）：送るつもり/, '応じた人の国（申告）');
    assert.equal(await pb.textContent('[data-testid=joint-wood]'), '0');
  });

  await step('B の隊商がヘラルドに見えたら、結び付けられる（持ち主の印は B のウォレットから）', async () => {
    file.moving.push({ ownerTag: tagB, seq: 0, faction: 2, src: { kind: 1, p: 4, q: 0, at: 5, gen: 1, tile: 11 }, dst, steps: 3, cargo: [0, 200, 0, 0, 0, 0, 0, 0], arriveTs: 1, runs: [], raided: false, path: Array(12).fill(0), provinces: [[4, 0], [3, 0]] });
    await refresh(pb);
    await pb.click('[data-act=link]');
    await pb.waitForSelector('#msg .ok');
    await pb.waitForSelector('[data-testid=arrival-state]:has-text("輸送中")');
  });

  await step('到着の確定の後、共同の目的に木材だけが入り、石材が足りないので未達成。個人の量は B に出る', async () => {
    file.moving = [];
    file.ended.push({ ownerTag: tagB, seq: 0, end: 'settled', outcome: 0, dst, cargo: [0, 196, 0, 0, 0, 0, 0, 0] });
    await refresh(pa);
    await pa.waitForSelector('[data-testid=arrival-state]:has-text("到着（確定）")');
    assert.equal(await pa.textContent('[data-testid=joint-wood]'), '196');
    assert.equal(await pa.textContent('[data-testid=joint-stone]'), '0');
    assert.equal(await pa.textContent('[data-testid=joint-status]'), '未達成');
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

  await step('スマホの幅で横にはみ出さない', async () => {
    await pa.setViewportSize({ width: 390, height: 900 });
    const over = await pa.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `はみ出し ${over}px`);
  });

  await step('ページのエラーがない', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  srv.close(); herald.close();
}

for (const [s, n, m] of results) console.log(`${s} - ${n}${m ? `\n  ${m}` : ''}`);
const failed = results.filter(r => r[0] !== 'ok').length;
console.log(`# pass ${results.length - failed}\n# fail ${failed}`);
process.exit(failed ? 1 : 0);
