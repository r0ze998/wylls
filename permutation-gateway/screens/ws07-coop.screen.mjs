// Workstream 07: the S1 village card's way to workstream 01's cooperation board (hud/coopboard.mjs, through the card's
// slot), in Chromium, on the card's FIXTURE data (screens/ws07/s1-card.html ?board=1). /coop/config is answered in the
// browser as 01's board would (or not at all). Japanese and English, phone and PC. No wallet, no key: an init script
// blocks and counts key operations (none expected).
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
const SIZES = [{ name: 'phone', width: 390, height: 844 }, { name: 'pc', width: 1440, height: 900 }];
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

function guard() {
  window.__keyUses = [];
  const s = crypto.subtle;
  for (const m of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'unwrapKey']) Object.defineProperty(s, m, { value: async () => { window.__keyUses.push(m); throw new Error('blocked'); } });
  const imp = s.importKey.bind(s);
  Object.defineProperty(s, 'importKey', { value: async (f, d, a, e, u) => { if (f === 'pkcs8' || (u ?? []).includes('sign')) { window.__keyUses.push(`importKey:${f}`); throw new Error('blocked'); } return imp(f, d, a, e, u); } });
}
async function open(size, lang, board) {
  const c = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  await c.addInitScript(guard);
  const page = await c.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/coop/config', r => (board === 'absent' ? r.fulfill({ status: 404, body: '{}' }) : board === 'down' ? r.fulfill({ status: 503, body: '{}' })
    : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ season: board === 'other' ? '8' : '7', goals: [], judges: [] }) })));
  await page.goto(`${base}?board=1&lang=${lang}`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.waitForTimeout(300);
  return { c, page, errors };
}

for (const size of SIZES) {
  test(`${size.name}: with 01's board on this server, the card's button opens it with this village as the destination (en, ja)`, async () => {
    for (const lang of ['en', 'ja']) {
      const { c, page, errors } = await open(size, lang, 'ok');
      try {
        const btn = page.locator('#card [data-act="coop-open"]');
        await btn.waitFor();
        assert.equal(await btn.innerText(), lang === 'en' ? 'Open requests across nations' : '国をまたぐ依頼を開く');
        assert.equal(await btn.isDisabled(), false);
        await btn.scrollIntoViewIfNeeded();
        if (SHOTS) await btn.screenshot({ path: join(SHOTS, `ws07-coop-${lang}-${size.name}.png`) });
        await btn.click();
        assert.equal(await page.evaluate(() => document.body.dataset.coopHref), '/ws01/repo/workstreams/01-national-strategy/coop/?to=0%2C0%2C0%2C1');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.__keyUses), []);
      } finally { await c.close(); }
    }
  });
  test(`${size.name}: no board — nothing; a board not read, or of another Season — said, and not opened`, async () => {
    for (const [board, re] of [['absent', null], ['down', /could not be loaded \(HTTP503\)/], ['other', /another world \(season\)/]]) {
      const { c, page, errors } = await open(size, 'en', board);
      try {
        const btn = page.locator('#card [data-act="coop-open"]');
        if (!re) { assert.equal(await btn.count(), 0, 'no board on this server: the card is as before'); continue; }
        await btn.waitFor();
        assert.equal(await btn.isDisabled(), true);
        assert.match(await page.locator('#card .ws07-coop').innerText(), re);
        assert.equal(await page.evaluate(() => document.body.dataset.coopHref ?? null), null);
        assert.deepEqual(errors, []);
      } finally { await c.close(); }
    }
  });
}
