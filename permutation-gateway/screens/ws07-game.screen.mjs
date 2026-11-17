// Workstream 07: the real game page (permutation-server/web/frontier/index.html, the page players open), served by
// the screen suite's FIXTURE server (server.mjs: a fake herald and relay, no chain). It is opened under a name that is
// not a loopback host (wylls.test, mapped to 127.0.0.1 in Chromium): the page's config() offers the dev wallet only on
// a loopback page, and on a localnet season startPlay would otherwise make and keep a random dev key on load. An init
// script blocks and counts every key operation; none is expected (no wallet is connected).
// Checked, in English and Japanese, at a phone's and a PC's size, and after a reload: the join screen's season lines
// (workstream 07's seasonterms) reach the player; with /h/events failing, the chronicle under "More" says the record
// was not read — never "Nothing recorded yet" — and no page error is thrown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';

const SHOTS = process.env.WS07_SHOTS ?? null;
const SIZES = [{ name: 'phone', width: 390, height: 844 }, { name: 'pc', width: 1440, height: 900 }];
let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  base = `http://wylls.test:${new URL(srv.url).port}/frontier/index.html`;
  browser = await chromium.launch({ args: ['--host-resolver-rules=MAP wylls.test 127.0.0.1'], ...(process.env.WS07_CHROME ? { executablePath: process.env.WS07_CHROME } : {}) });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); await srv?.close(); });

function init(lang) {
  try { localStorage.setItem('ps-lang', lang); localStorage.setItem('ps-fintro:v1', '1'); } catch { /* none */ }
  window.__keyUses = [];
  const s = globalThis.crypto?.subtle;
  if (s) {
    for (const m of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'unwrapKey']) Object.defineProperty(s, m, { value: async () => { window.__keyUses.push(m); throw new Error(`key use blocked: ${m}`); } });
    const imp = s.importKey.bind(s);
    Object.defineProperty(s, 'importKey', { value: async (f, d, a, e, u) => { if (f === 'pkcs8' || (u ?? []).includes('sign')) { window.__keyUses.push(`importKey:${f}`); throw new Error('key use blocked'); } return imp(f, d, a, e, u); } });
  }
}
async function open(size, lang, eventsDown) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  await ctx.addInitScript(init, lang);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && /TypeError|frontier (play|refresh|spectate)/.test(m.text())) errors.push(m.text()); });
  if (eventsDown) await page.route('**/h/events*', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"Unavailable"}' }));
  await page.goto(base);
  return { ctx, page, errors };
}
const bodyText = page => page.locator('body').innerText();
async function until(page, re, ms = 20000) { const t0 = Date.now(); for (;;) { const t = await bodyText(page).catch(() => ''); if (re.test(t)) return t; if (Date.now() - t0 > ms) return t; await page.waitForTimeout(250); } }
const noKeys = async page => { assert.deepEqual(await page.evaluate(() => window.__keyUses), []); assert.equal(await page.evaluate(() => localStorage.getItem('ps-dev-wallet')), null, 'no dev key was made'); };

for (const size of SIZES) {
  test(`${size.name}: the game page's join screen says the season's lines in English and Japanese; no key, no dev wallet; a reload says them again`, async () => {
    for (const lang of ['en', 'ja']) {
      const { ctx, page, errors } = await open(size, lang, false);
      try {
        const re = lang === 'en' ? /Joining is open until turn [\d,]+ \(about .+ left\)\. This program \(an old-style season\) takes new orders until turn [\d,]+/ : /参加の受付は第[\d,]+ターンまで.*このプログラム（旧方式のシーズン）が新しい命令を受け付けるのは第[\d,]+ターンまでです/s;
        assert.match(await until(page, re), re);
        if (lang === 'en') assert.doesNotMatch(await bodyText(page), /The world ends|season is over|resets/i);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `ws07-game-join-${lang}-${size.name}.png`) });
        await page.reload();
        assert.match(await until(page, re), re);
        await noKeys(page);
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    }
  });

  test(`${size.name}: /h/events failing, the chronicle under More says the record was not read — never empty — and again after a reload`, async () => {
    const { ctx, page, errors } = await open(size, 'en', true);
    try {
      await page.getByRole('button', { name: /^More/ }).or(page.getByRole('link', { name: /^More/ })).or(page.locator('[data-tab="more"]')).first().click();
      const re = /The record of events could not be loaded \(HTTP503\)\. This does not mean the record is empty/;
      let t = await until(page, re);
      assert.match(t, re);
      assert.doesNotMatch(t, /Nothing recorded yet/);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `ws07-game-more-unread-en-${size.name}.png`) });
      await page.reload();
      await page.getByRole('button', { name: /^More/ }).or(page.getByRole('link', { name: /^More/ })).or(page.locator('[data-tab="more"]')).first().click().catch(() => {});
      t = await until(page, re);
      assert.match(t, re);
      await noKeys(page);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
}
