// Q16-3 round 3 (verify-pr61 F4): the play page's action bar while ③'s courier holds the village's key, on the REAL
// page (frontier/index.html with its own stylesheets) in the screens fixture server's live sample world: the viewer
// owns a village and keeps its device key; the Citizen's session is rewritten to the courier's key (a program-held
// key). The village is selected; the bar's note is read in all three states (closed, review, kept) and every button
// and line in it must be readable: text contrast ≥ 4.5:1 against what is actually painted behind it (its own
// background, else the nearest painted ancestor's; a gradient counts by its worst stop). English and Japanese.
// Port: REKEY_BAR_PORT (default 41878; the brief's range is 41870–41899). REKEY_OUT=<dir> writes the screenshots.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as W from './world.mjs';
import { encode as toBase58, decode as fromBase58 } from '../../permutation-server/web/sdk/base58.mjs';
import { fromBase64, toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { CONTRAST } from './contrast.mjs';

const PORT = Number(process.env.REKEY_BAR_PORT ?? 0); // (0: the system's; a run held to a range sets it)
const OUT = process.env.REKEY_OUT ?? null;
const COURIER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const JP = /[぀-ヿ一-鿿]/;
let browser;
after(async () => { await browser?.close(); });

async function openVillage(lang) {
  const srv = await startServer({ port: PORT });
  srv.stage('holding');
  const state = { registered: COURIER, posts: [] };
  srv.live(true, { landMs: 500 });
  browser ??= await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const storage = W.storageFor(srv.viewer, { stage: 'holding', lang });
  await ctx.addInitScript(values => { if (localStorage.getItem('ps-lang') === null) for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v); }, storage);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  // the viewer's Citizen as the herald serves it, its session the courier's key (found by the fixture session's bytes)
  await page.route('**/h/me/**', async route => {
    const res = await route.fetch(); const rec = await res.json();
    if (rec?.citizen?.bytes_b64) {
      const bytes = fromBase64(rec.citizen.bytes_b64), was = fromBase58(srv.viewer.session);
      let at = -1; for (let i = 0; i + 32 <= bytes.length && at < 0; i++) if (was.every((b, j) => bytes[i + j] === b)) at = i;
      if (at >= 0) bytes.set(fromBase58(state.registered), at);
      rec.citizen.bytes_b64 = toBase64(bytes);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rec) });
  });
  await page.route('**/gw/f/relay', async route => { if (route.request().method() === 'POST') state.posts.push(route.request().postData()); return route.fallback(); });
  await page.goto(`${srv.url}/frontier/index.html`);
  await page.waitForTimeout(6000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await page.mouse.click(720, 480);
  const note = page.locator('#hand .hand-note-agent');
  await note.waitFor({ timeout: 30_000 });
  return { srv, ctx, page, note, state, errors, close: async () => { await ctx.close(); await srv.close(); } };
}

for (const lang of ['en', 'ja']) test(`the action bar over the courier's key (${lang}): every button and line is readable, in all three states`, { timeout: 180_000 }, async () => {
  const x = await openVillage(lang);
  try {
    const states = [['closed', null], ['review', 'session-review'], ['kept', 'session-keep']];
    for (const [name, press] of states) {
      if (press) { await x.note.locator(`[data-act="${press}"]`).click(); await x.page.waitForTimeout(500); }
      const rows = await x.page.evaluate(CONTRAST, '#hand .hand-note-agent');
      assert.ok(rows?.length, `${name}: the note is drawn`);
      for (const r of rows) assert.ok(r.contrast >= 4.5, `${lang} ${name}: "${r.text}" (${r.act ?? r.tag}) contrast ${r.contrast} < 4.5 (${r.paint})`);
      const words = rows.map(r => r.text).join(' ');
      if (lang === 'en') assert.doesNotMatch(words, JP, words); else assert.match(words, JP);
      const acts = rows.filter(r => r.act).map(r => r.act);
      assert.deepEqual(acts, { closed: ['session-review'], review: ['session-keep', 'session-replace'], kept: ['session-keep'] }[name], `${name}: ${acts}`);
      if (OUT) {
        await x.page.locator('#hand').screenshot({ path: `${OUT}/play-bar-${name}-${lang}-1440.png` });
        if (name === 'review') await x.page.screenshot({ path: `${OUT}/play-page-bar-review-${lang}-1440.png` });
      }
    }
    assert.deepEqual(x.state.posts, [], 'reading, reviewing and keeping send nothing');
    assert.deepEqual(x.errors, [], 'no page error');
  } finally { await x.close(); }
});
