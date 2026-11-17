// Round 44, in a real browser on the keyless screens fixture (no chain, no key, no relay): the local-play test-world box
// ("About this test world", flocalplay-session.mjs) must not cover the page's notices. Seen in live33 (1280 × 800, a
// drawer open): a notice with its "Try again" button stood under the box. The box is mounted with the module's own
// mountSessionNotice and laid out by local play's own stylesheet (flocalplay.css, linked as flocalplay.mjs links it); the notice is the page's own refusal notice (FS.notice, set by the test; the page draws it — a fixture
// check of the stacking, not evidence of a live notice). Nothing is sent: every non-GET request is counted.
// Run from this folder: node --test local-play-session-feed.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import { LATEST_UNIX, HOME } from './world.mjs';

let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  srv.stage('holding');
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { await browser?.close(); await srv?.close(); });

for (const lang of ['en', 'ja']) test(`round 44 (${lang}): with a drawer open, a notice of #feed stands above the test-world box where the two overlap`, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: lang === 'en' ? 'en-US' : 'ja-JP', timezoneId: 'UTC' });
  await NK.prepare(ctx, srv.viewer, { lang });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  try {
    await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
    await page.goto(`${base}/frontier/index.html?at=${HOME.p},${HOME.q},${HOME.tile},1.0`);
    await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
    // the drawer: the Marches tab, pressed as a person would (the feed moves left of it)
    await page.locator('[data-tab="marches"]').first().click();
    await page.waitForFunction(() => document.body.dataset.drawer === 'open');
    const probe = await page.evaluate(async () => {
      // (local play links its own stylesheet, flocalplay.css — flocalplay.mjs —, which places the box: linked the same way)
      const sheet = document.createElement('link'); sheet.rel = 'stylesheet'; sheet.href = '/frontier/flocalplay.css';
      await new Promise(r => { sheet.onload = r; sheet.onerror = r; document.head.append(sheet); });
      const { mountSessionNotice } = await import('/frontier/flocalplay-session.mjs');
      mountSessionNotice({ doc: document, win: window });
      // (the page's own refusal notice — FS.notice, drawn by hud/status.mjs into #feed — as the waiting send's
      //  cancellation was in live33; the page renders it, nothing is drawn by hand)
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      FS.notice = { ok: false, code: 'Unconfirmed', text: 'The waiting send is cancelled because the order changed (its arrival turn, for example). The order was not sent. Check it, then press again.' };
      invalidate('panel');
      for (let i = 0; i < 40 && !document.querySelector('#feed .toast'); i++) await new Promise(r => setTimeout(r, 50));
      const t = document.querySelector('#feed .toast');
      if (!t) return { overlap: false, missing: true };
      await new Promise(r => setTimeout(r, 400));
      // (where the notice and the box overlap — in live33 the notice's message, under the box's lower edge — the topmost
      // element is read at the middle of that overlap; "Try again" itself stands lower, below the box)
      const box = document.getElementById('local-play-session').getBoundingClientRect(), n = t.getBoundingClientRect();
      const ix = { left: Math.max(box.left, n.left), right: Math.min(box.right, n.right), top: Math.max(box.top, n.top), bottom: Math.min(box.bottom, n.bottom) };
      const overlap = ix.right > ix.left + 4 && ix.bottom > ix.top + 4;
      // (the box takes no pointer — pointer-events: none — so a hit test would pass through it; for this one reading the
      //  box takes the pointer, so the hit test answers which of the two is painted on top, then it is put back)
      const boxEl = document.getElementById('local-play-session'), pe = boxEl.style.pointerEvents;
      boxEl.style.pointerEvents = 'auto';
      const top = overlap ? document.elementFromPoint((ix.left + ix.right) / 2, (ix.top + ix.bottom) / 2) : null;
      boxEl.style.pointerEvents = pe;
      return { overlap, area: Math.round((ix.right - ix.left) * (ix.bottom - ix.top)), topInNotice: !!top?.closest?.('.toast'), topIsBox: !!top?.closest?.('#local-play-session'),
        parent: document.getElementById('local-play-session').parentElement.tagName, boxPosition: getComputedStyle(document.getElementById('local-play-session')).position };
    });
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/session-feed-${lang}.png` });
    assert.equal(probe.boxPosition, 'fixed', 'the box is laid out by local play\'s own stylesheet');
    assert.equal(probe.overlap, true, 'the fixture lays the notice under the box (as in live33)');
    assert.equal(probe.topIsBox, false, `the box is not on top of the notice (${JSON.stringify(probe)})`);
    assert.equal(probe.topInNotice, true, `where they overlap, the notice is on top (${JSON.stringify(probe)})`);
    assert.deepEqual(posts.filter(x => !x.endsWith('/f/nudge')), [], 'nothing sent');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
