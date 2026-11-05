// Workstream 07: the page's own S1 village card (screens/s1.mjs) in Chromium, on S1 data in the herald's shapes
// (screens/ws07/s1-card.html). What it shows: a caravan past its arrival turn says its amount is not verified, one
// still on the road says nothing of it; with nothing registered there is no cancel, cost, manual or cooperation line;
// with workstreams 04, 05 and 01's sources registered as MOCKS (theirs were not received) each says its state with a
// symbol and words, the cooperation button is disabled with its reason, reachable by keyboard, and opens once when it
// may. Phone and desktop widths, Japanese and English, forced colours. Not the whole page (its S1 world needs
// layout-v2 fixtures these screens do not have) and not chain data.
//
// Run from this folder: node --test ws07-s1-card.screen.mjs (WS07_SHOTS=<dir> also writes the screenshots there).
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
  base = `http://127.0.0.1:${srv.address().port}/permutation-gateway/screens/ws07/s1-card.html`;
  browser = await chromium.launch(process.env.WS07_CHROME ? { executablePath: process.env.WS07_CHROME } : {});
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); srv?.close(); });

const SIZES = [{ name: 'phone', width: 390, height: 844 }, { name: 'pc', width: 1440, height: 900 }];
async function open(size, query) {
  const c = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  const page = await c.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}?${query}`);
  await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
  return { c, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

for (const size of SIZES) {
  test(`${size.name}: the S1 village card says a caravan past its turn is overdue and not settled — never arrived —, and nothing else is added`, async () => {
    const { c, page, errors } = await open(size, 'mock=0');
    const rows = page.locator('#card .list li');
    const text = await page.locator('#card').innerText();
    assert.doesNotMatch(text, /到着済み|着きました/, 'past the turn is not arrived');
    assert.match(text, /ターン 306 に到着/);
    assert.equal(await page.locator('#card [data-key="arrival:overdue"]').count(), 1, 'one caravan is past its turn, one is still on the road');
    assert.match(await rows.filter({ hasText: '到着予定のターン' }).innerText(), /到着予定のターン 292 を過ぎました。読み込んだ時点では、まだ決着していません/);
    assert.equal(await page.locator('#card [data-key^="cancel:"], #card [data-key^="cost:"], #card [data-key="manual"], #card [data-act="coop-open"]').count(), 0, 'nothing registered: as before');
    assert.ok(await noSideScroll(page));
    await shot(page, `ws07-s1-card-plain-${size.name}`);
    assert.deepEqual(errors, []);
    await c.close();
  });

  test(`${size.name}: with 04, 05 and 01 registered (mocks) each says its state; the cooperation button is disabled with its reason`, async () => {
    for (const l of ['ja', 'en']) {
      const { c, page, errors } = await open(size, `mock=1&lang=${l}`);
      const keys = await page.locator('#card [role="status"]').evaluateAll(xs => xs.map(x => x.dataset.key));
      assert.deepEqual(keys, ['manual', 'cost:reserved', 'cost:committed', 'cost:unsettled', 'arrival:overdue', 'cancel:awaitSigned']);
      const btn = page.locator('#card [data-act="coop-open"]');
      assert.equal(await btn.isDisabled(), true);
      const t = await page.locator('#card').innerText();
      if (l === 'ja') {
        assert.match(t, /使える量（未確定の費用を最大で引いた見込み）：食料 1,100/);
        assert.match(t, /卓が開くのはターン 700 から（mock）/);
      } else assert.match(t, /The table opens at turn 700 \(mock\)/);
      await page.emulateMedia({ forcedColors: 'active' });
      assert.equal((await page.locator('#card .ws07-sym').allInnerTexts()).length, 6, 'the symbols stay without colour');
      assert.ok(await noSideScroll(page));
      await shot(page, `ws07-s1-card-mock-${l}-${size.name}`);
      assert.deepEqual(errors, []);
      await c.close();
    }
  });

  test(`${size.name}: the cooperation button, when 01 says it may be pressed, is reached by keyboard and opens once per press`, async () => {
    const { c, page, errors } = await open(size, 'mock=1&coop=open');
    const btn = page.locator('#card [data-act="coop-open"]');
    assert.equal(await btn.isDisabled(), false);
    await btn.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.act), 'coop-open');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.body.dataset.coopOpened), '1');
    await btn.click();
    assert.equal(await page.evaluate(() => document.body.dataset.coopOpened), '2');
    assert.deepEqual(errors, []);
    await c.close();
  });
}
