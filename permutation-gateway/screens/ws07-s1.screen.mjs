// Workstream 07: the page's own S1 parts in Chromium, fed S1 records (screens/ws07/s1-parts.html). Not the whole
// page — its S1 world needs layout-v2 fixtures these screens do not have — and not chain data: the records are built
// from the v2 log table. What it shows: the away summary's notices, "seen" by mouse and by keyboard, a reload, a
// double press, a refused write, a gap and a read that failed; and the display contract's states, at a phone's and
// a desktop's width, in Japanese and English, with nothing told by colour alone.
//
// Run from this folder: node --test ws07-s1.screen.mjs (WS07_SHOTS=<dir> also writes the screenshots there).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const SHOTS = process.env.WS07_SHOTS ?? null;
let srv, base, browser;

before(async () => {
  srv = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path.startsWith('..')) { res.writeHead(403).end(); return; }
    try { const b = await readFile(join(ROOT, path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(b); } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/permutation-gateway/screens/ws07/s1-parts.html`;
  browser = await chromium.launch(process.env.WS07_CHROME ? { executablePath: process.env.WS07_CHROME } : {});
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); srv?.close(); });

const SIZES = [{ name: 'phone', width: 390, height: 844 }, { name: 'pc', width: 1440, height: 900 }];
async function open(size, query, ctx = null) {
  const c = ctx ?? await browser.newContext({ viewport: { width: size.width, height: size.height } });
  const page = await c.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}?${query}`);
  await page.waitForSelector('body[data-ready="1"]');
  return { c, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

for (const size of SIZES) {
  test(`${size.name}: a first look lists the viewer's S1 losses, keeps a taken caravan's arrival apart, and "seen" moves the mark once`, async () => {
    const { c, page, errors } = await open(size, 's=first');
    const text = await page.locator('#feed').innerText();
    assert.match(text, /隊商が積荷ごと奪われました/);
    assert.match(text, /あなたが送った隊商の到着が記録されました.*受け取ったのは奪った側です/s, 'a caravan whose send was not read: holder unknown');
    assert.doesNotMatch(text, /隊商が着きました：木材 300/, 'the taken caravan\'s arrival is not the sender\'s');
    assert.match(text, /確認すると、第340ターンまでを確認済みにします/);
    await shot(page, `ws07-s1-first-${size.name}`);
    assert.ok(await noSideScroll(page));
    // keyboard: the "seen" button is reachable and pressed by Enter
    const seen = page.locator('[data-act="away-seen"]');
    await seen.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.act), 'away-seen');
    await page.keyboard.press('Enter');
    assert.equal((await page.evaluate(() => window.ws07.marks())).confirmedSeq, '108');
    assert.equal(await page.locator('[data-act="away-seen"]').count(), 0, 'the notices went with "seen"');
    // reload: the mark holds; nothing new, no "seen"
    await page.reload(); await page.waitForSelector('body[data-ready="1"]');
    assert.match(await page.locator('#feed').innerText(), /新しく確認する記録はありません/);
    assert.equal(await page.locator('[data-act="away-seen"]').count(), 0);
    assert.deepEqual(errors, []);
    await c.close();
  });

  test(`${size.name}: a double press moves the mark once; a refused write keeps the notice and says so`, async () => {
    const one = await open(size, 's=first');
    await one.page.locator('[data-act="away-seen"]').dblclick();
    assert.equal((await one.page.evaluate(() => window.ws07.marks())).confirmedSeq, '108');
    await one.c.close();
    const two = await open(size, 's=first&store=refuse');
    await two.page.locator('[data-act="away-seen"]').click();
    const t = await two.page.locator('#feed').innerText();
    assert.match(t, /確認の位置を保存できませんでした。次に開いたときも同じ範囲が出ます/);
    assert.equal(await two.page.evaluate(() => window.ws07.marks()), null, 'nothing was saved');
    await shot(two.page, `ws07-s1-refused-${size.name}`);
    assert.deepEqual([...one.errors, ...two.errors], []);
    await two.c.close();
  });

  test(`${size.name}: a gap offers no "seen", and a read that failed confirms only what it read`, async () => {
    const g = await open(size, 's=gap');
    const gt = await g.page.locator('#feed').innerText();
    assert.match(gt, /確認した位置のあとの記録の一部を読めていません/);
    assert.match(gt, /欠けた記録を読めるまで、確認の位置は進めません/);
    assert.equal(await g.page.locator('[data-act="away-seen"]').count(), 0);
    assert.equal(await g.page.locator('[data-act="feed-dismiss"]').count() > 0, true, '× still closes it');
    await shot(g.page, `ws07-s1-gap-${size.name}`);
    await g.c.close();
    const f = await open(size, 's=fail');
    const ft = await f.page.locator('#feed').innerText();
    assert.match(ft, /記録の読み込みが途中で失敗しました/);
    assert.match(ft, /読めた第305ターンまでを確認済みにします/);
    await shot(f.page, `ws07-s1-failed-${size.name}`);
    await f.page.locator('[data-act="away-seen"]').click();
    assert.equal((await f.page.evaluate(() => window.ws07.marks())).confirmedSeq, '104');
    assert.deepEqual([...g.errors, ...f.errors], []);
    await f.c.close();
  });

  test(`${size.name}: the display contract says each state with a symbol and words, in Japanese and English`, async () => {
    for (const l of ['ja', 'en']) {
      const { c, page, errors } = await open(size, `s=first&lang=${l}`);
      const rows = page.locator('#contract [role="status"]');
      assert.equal(await rows.count(), 11);
      const syms = await page.locator('#contract .ws07-sym').allInnerTexts();
      assert.deepEqual(syms, ['‖', '⌛', '■', '?', '◐', '◇', '◆', '◇?', '↺', '✋', '?']);
      const t = await page.locator('#contract').innerText();
      if (l === 'ja') { assert.match(t, /到着量はまだ確かめられていません/); assert.match(t, /状態を受け取れていません/); }
      else assert.doesNotMatch(t, /[぀-ヿ一-鿿]/, 'English words throughout');
      // nothing by colour alone: the same rows in greyscale still carry their symbols and words
      await page.emulateMedia({ forcedColors: 'active' });
      assert.equal((await page.locator('#contract .ws07-sym').allInnerTexts()).length, 11);
      await shot(page, `ws07-s1-contract-${l}-${size.name}`);
      assert.ok(await noSideScroll(page));
      assert.deepEqual(errors, []);
      await c.close();
    }
  });
}
