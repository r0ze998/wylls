// Workstream 07: the spectator page in English when /h/events cannot be read (workstream 08's finding). The page is
// served by the screen suite's fixture server (server.mjs: a FIXTURE herald, not a chain and not a recorded run); the
// events route is made to fail in the browser (HTTP 503, or the connection aborted). Checked: no page error, the
// record is said as not read — not as empty —, an earlier read stays and is said as older, and the page recovers.
// No wallet is connected and no storage holds a key; an init script blocks and counts every key operation (none).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';

// (screenshots only when WS07_SHOTS names a directory: nothing is written into the tree)
const OUT = process.env.WS07_SHOTS ? new URL(`file://${process.env.WS07_SHOTS.replace(/\/?$/, '/')}`) : null;
const SIZES = [{ name: 'phone', width: 390, height: 844 }, { name: 'pc', width: 1440, height: 900 }];
let srv, browser;
before(async () => { srv = await startServer(); browser = await chromium.launch(process.env.WS07_CHROME ? { executablePath: process.env.WS07_CHROME } : {}); if (OUT) await mkdir(OUT, { recursive: true }); });
after(async () => { await browser?.close(); await srv?.close(); });

/** English, the title card seen, NO wallet and no session key; every key operation blocked and counted. */
function init() {
  try { localStorage.setItem('ps-lang', 'en'); localStorage.setItem('ps-fintro:v1', '1'); } catch { /* no storage */ }
  window.__keyUses = [];
  const s = crypto.subtle;
  for (const m of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'unwrapKey']) { const f = s[m]; Object.defineProperty(s, m, { value: async (...a) => { window.__keyUses.push(m); throw new Error(`key use blocked: ${m}`); } }); void f; }
  const imp = s.importKey.bind(s);
  Object.defineProperty(s, 'importKey', { value: async (fmt, data, alg, ext, uses) => { if (fmt === 'pkcs8' || (uses ?? []).includes('sign')) { window.__keyUses.push(`importKey:${fmt}`); throw new Error('key use blocked'); } return imp(fmt, data, alg, ext, uses); } });
}

async function open(size, mode) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && /frontier|TypeError/.test(m.text())) errors.push(m.text()); });
  const state = { mode };
  await page.route('**/h/events*', route => (state.mode === 'down' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"Unavailable"}' })
    : state.mode === 'abort' ? route.abort('connectionreset') : route.continue()));
  await page.goto(`${srv.url}/frontier/spectate.html`);
  return { ctx, page, errors, state };
}
const panel = page => page.locator('#panel-body').innerText();
async function until(page, re, ms = 15000) { const t0 = Date.now(); for (;;) { const t = await panel(page).catch(() => ''); if (re.test(t)) return t; if (Date.now() - t0 > ms) return t; await page.waitForTimeout(250); } }

for (const size of SIZES) {
  for (const mode of ['down', 'abort']) {
    test(`${size.name}, events ${mode === 'down' ? 'HTTP 503' : 'connection reset'} from the start: no page error; the record is said as not read, never as empty`, async () => {
      const { ctx, page, errors } = await open(size, mode);
      try {
        const t = await until(page, /record of events could not be loaded/);
        assert.match(t, /The record of events could not be loaded \((HTTP503|network)\)\. This does not mean the record is empty/);
        assert.match(t, /whether there was a clash is not known/);
        assert.doesNotMatch(t, /No clash yet|No highlights yet|Nothing recorded yet/);
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.__keyUses), [], 'no key operation');
        if (OUT) await page.screenshot({ path: new URL(`spectate-unread-${mode}-en-${size.name}.png`, OUT).pathname });
      } finally { await ctx.close(); }
    });
  }
  test(`${size.name}, events read, then failing, then back: what was read stays and is said as older; the line goes once read again`, async () => {
    const { ctx, page, errors, state } = await open(size, 'up');
    try {
      await page.locator('[data-act="report-open"]').first().waitFor({ timeout: 15000 });
      const before = await panel(page);
      assert.doesNotMatch(before, /could not be loaded/);
      state.mode = 'down';
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const t = await until(page, /latest record of events could not be loaded/, 45000);
      assert.match(t, /The latest record of events could not be loaded \(HTTP503\)\. What is shown here is what was loaded before/);
      assert.ok(await page.locator('[data-act="report-open"]').count() > 0, 'the clashes read before are still listed');
      if (OUT) await page.screenshot({ path: new URL(`spectate-stale-en-${size.name}.png`, OUT).pathname });
      state.mode = 'up';
      const back = await until(page, /^(?![\s\S]*record of events could not be loaded)/, 45000);
      assert.doesNotMatch(back, /could not be loaded/);
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => window.__keyUses), []);
    } finally { await ctx.close(); }
  });
}
