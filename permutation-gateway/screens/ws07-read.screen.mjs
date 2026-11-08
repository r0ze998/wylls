// Workstream 07: when the viewer's own record (/h/me) cannot be read, the WHOLE game page says so — it does not show a
// returning player the nation choice as if they had never joined. As a connected player with no key
// (screens/ws07/nokey-page.mjs), on a phone and on a desktop:
//   1. /h/me answers 503 from the first load: no banner and no "国を選んで始める"; the plate says 記録をまだ読み込めていません
//      with 読み込み直す (hud/hud.mjs renderPlate's 'unreachable', which a failed read never reached before: FS.land
//      is always set, so hud/drawer.mjs viewerState said 'known' and the join flow opened);
//   2. the record answers again and 読み込み直す is pressed: the village, as before;
//   3. a read that fails later, after the village was shown (two refreshes): the village stays; no nation choice.
// No request but reads, no page error, no key use. Nothing is ordered or signed.
//
// Run from this folder: node --test ws07-read.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import { LATEST_UNIX } from './world.mjs';

let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  srv.stage('holding');
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { await browser?.close(); await srv?.close(); });

const seen = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  const vis = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null).length;
  return { me: FS.meStatus, banners: vis('.banner-pick'), startJoin: vis('[data-act="join"]'), joinOpen: vis('[data-act="join-open"]'), reload: vis('[data-act="reload"]'),
    plate: (document.querySelector('.plate')?.textContent ?? '').replace(/\s+/g, ' ').trim(), stage: document.body.dataset.stage };
});

for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  test(`the viewer's record not read @ ${vp.name}: said, never the nation choice; read again: the village; a later failure keeps it`, { timeout: 120_000 }, async () => {
    const phone = vp.width < 760;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
    await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
    let fail = true;
    await ctx.route(/\/h\/me\//, r => (fail ? r.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"Unavailable"}' }) : r.fallback()));
    const page = await ctx.newPage();
    const errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    // (the 503s asked for here are the only console errors expected: "Failed to load resource … 503")
    page.on('console', m => { if (m.type() === 'error' && !/status of 503/.test(m.text())) errors.push(m.text()); });
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
    await page.goto(`${base}/frontier/index.html`);
    await page.waitForFunction(async () => (await import('/frontier/fstate.mjs')).FS.meStatus === 'error');
    await page.locator('[data-act="reload"]:visible').first().waitFor();

    // 1. not read: said, with 読み込み直す; no nation choice, no join
    let s = await seen(page);
    assert.equal(s.me, 'error');
    assert.deepEqual([s.banners, s.startJoin, s.joinOpen], [0, 0, 0], 'never the nation choice or a join for a record not read');
    assert.match(s.plate, /記録をまだ読み込めていません/);
    assert.equal(s.reload, 1);

    // 2. read again: the village
    fail = false;
    await (phone ? page.locator('[data-act="reload"]:visible').first().tap() : page.locator('[data-act="reload"]:visible').first().click());
    await page.waitForFunction(async () => (await import('/frontier/fstate.mjs')).FS.meStatus === 'ready');
    await page.waitForFunction(() => /ラマール/.test(document.querySelector('.plate')?.textContent ?? '') && document.body.dataset.stage === 'final');
    s = await seen(page);
    assert.deepEqual([s.banners, s.reload, s.stage], [0, 0, 'final'], 'the village, as before');

    // 3. a later failure (two refreshes): the village stays
    fail = true;
    await page.evaluate(async () => { const c = await import('/frontier/controller.mjs'); await c.refresh(); await c.refresh(); });
    s = await seen(page);
    assert.equal(s.me, 'error');
    assert.deepEqual([s.banners, s.startJoin], [0, 0], 'no nation choice');
    assert.match(s.plate, /ラマール/, 'what was read stays');
    fail = false;

    assert.deepEqual(posts, [], 'no request but reads');
    assert.deepEqual(errors, [], 'no page error');
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });
}

// The village's own province not read (/h/province/2,0 503): its hosts are read from that record, so "no Scout host"
// is not known. The guide's next thing used to offer 斥候隊を編成する (Muster: a second Scout host from the reserve) as
// if the village had none; now it offers no Train or Muster until the province is read. Read again: the Scout that
// is there is offered to explore (探索する土地を選ぶ).
for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  test(`the village's province not read @ ${vp.name}: no Train or Muster offered as if it had no Scout; read again: its Scout`, { timeout: 120_000 }, async () => {
    const phone = vp.width < 760;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
    await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
    let fail = true;
    await ctx.route(/\/h\/province\/2,0\//, r => (fail ? r.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"Unavailable"}' }) : r.fallback()));
    const page = await ctx.newPage();
    const errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/status of 503/.test(m.text())) errors.push(m.text()); });
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
    await page.goto(`${base}/frontier/index.html`);
    await page.waitForFunction(() => document.body.dataset.stage === 'final');
    const offered = () => page.evaluate(() => [...document.querySelectorAll('[data-act]')].filter(e => e.offsetParent !== null).map(e => e.dataset.act)
      .filter(a => ['home-scout-muster', 'home-scout-train', 'explore-open'].includes(a)));
    // give the page its reads (the province is asked for and refused), then look
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(async () => (await import('/frontier/fstate.mjs')).FS.provinces.has('2,0')), false, 'the province was not read');
    assert.deepEqual(await offered(), [], 'no Train or Muster offered while the hosts are not known');
    // the troops screen says the record is not read, never "no hosts"
    const tab = page.locator('[data-act="tab"][data-tab="hosts"]:visible').first();
    await (phone ? tab.tap() : tab.click());
    await page.waitForFunction(() => /記録をまだ読み込めていません/.test(document.getElementById('panel-body')?.textContent ?? ''));
    assert.doesNotMatch(await page.locator('#panel-body').textContent(), /軍勢はいません/);

    fail = false;
    await page.evaluate(async () => { const c = await import('/frontier/controller.mjs'); await c.refresh(); });
    await page.waitForFunction(async () => (await import('/frontier/fstate.mjs')).FS.provinces.has('2,0'));
    // (the troops screen, read: its hosts are listed)
    await page.waitForFunction(() => !!document.querySelector('#panel-body .hosts'), null, { timeout: 15_000 });
    const map = page.locator('[data-act="tab"][data-tab="map"]:visible').first();
    if (await map.count()) await (phone ? map.tap() : map.click());
    await page.waitForFunction(() => [...document.querySelectorAll('[data-act="explore-open"]')].some(e => e.offsetParent !== null), null, { timeout: 15_000 });
    const after = await offered();
    assert.ok(after.includes('explore-open') && !after.includes('home-scout-muster') && !after.includes('home-scout-train'), `read: the Scout that is there (${after})`);

    assert.deepEqual(posts, [], 'no request but reads');
    assert.deepEqual(errors, [], 'no page error');
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });
}
