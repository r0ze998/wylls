// Workstream 07: the wide village (chosen-march's read-only captured village) chosen on the WHOLE game page, as a
// connected player with no key (screens/ws07/nokey-page.mjs), on a phone and on a desktop.
//
// The fixture server answers the viewer's /h/me through ws07/wide-stage.mjs's OPT-IN rewrite (srv.meWith): inventory
// slot 2 holds a captured wide village at a coordinate past 2^53. Only this file installs it. Workstream 04's condition
// — the default stage stays byte-identical — is checked first: the default answers hash to the value recorded before
// the hook existed, with the hook unset and again after it was set and removed.
//
// On the page: the W2 pip (desktop rail; phone resting sheet) → the village drawer shows the wide card (read-only,
// captured, unverified); pressed twice: one card; two record refreshes: the selection is kept; "ふつうの村に戻る":
// the ordinary village again; back/forward and a reload: the page whole, nothing selected, the pip there; an
// envelope of another world: the inventory refused, said with 再試行, no pip. No request but reads, no page or console
// error, no key use (NK.assertKeyless). Nothing is ordered: a wide village takes no order (fwide.wideRefusal, unit
// tested). This checks what the page shows from fixture records, not the herald's wide index or a chain.
//
// Run from this folder: node --test ws07-wide.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import * as W from './world.mjs';
import { wideMe } from './ws07/wide-stage.mjs';

/** The default answers of every stage, before the hook existed (recorded at 6de240aa, keyless viewer). */
const DEFAULT_SHA = '8e00cf59e5a91705454cab58b12bccdf63c8d2aa18de08587bea64ea9cee0e5b';

let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { srv?.meWith(null); await browser?.close(); await srv?.close(); });

async function defaultHash() {
  const paths = v => [`/h/me/${v.wallet}`, '/h/season', '/h/province/2,0/latest', '/h/events', '/coop/config', '/h/overview/2/latest.bin', '/h/roster/2/latest.bin'];
  const all = createHash('sha256');
  for (const st of W.STAGES) {
    srv.stage(st);
    for (const p of paths(srv.viewer)) { const r = await fetch(srv.url + p); all.update(`${st} ${p} ${r.status} `).update(Buffer.from(await r.arrayBuffer())); }
  }
  return all.digest('hex');
}

test('the default stage is byte-identical: unset, and set then removed', async () => {
  assert.equal(await defaultHash(), DEFAULT_SHA, 'the hook unset');
  srv.meWith(wideMe(srv.viewer));
  assert.notEqual(await defaultHash(), DEFAULT_SHA, '(set: the holding stage\'s /h/me differs, as it should)');
  srv.meWith(null);
  assert.equal(await defaultHash(), DEFAULT_SHA, 'removed again');
});

const ready = page => page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
const state = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  return { status: FS.wideStatus, error: FS.wideError?.code ?? null, sel: FS.wideSelect?.inventorySlot ?? null, cards: document.querySelectorAll('#wide-v-title').length,
    pips: [...document.querySelectorAll('[data-act="wide-select"]')].filter(e => e.offsetParent !== null).map(e => e.dataset.slot),
    statusLine: document.querySelector('.wide-inventory-status')?.textContent.trim() ?? null };
});

for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  test(`the wide village @ ${vp.name}: chosen, kept, back to the ordinary village; back/forward, a reload; another world refused`, { timeout: 150_000 }, async () => {
    const phone = vp.width < 760;
    srv.stage('holding');
    srv.meWith(wideMe(srv.viewer));
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
    await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
    const page = await ctx.newPage();
    const press = loc => (phone ? loc.tap() : loc.click());
    const errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.clock.setFixedTime(new Date(W.LATEST_UNIX * 1000 + 500));
    const url = `${base}/frontier/index.html`;
    await page.goto(url); await ready(page);
    const pip = page.locator('[data-act="wide-select"][data-slot="2"]:visible').first();
    await pip.waitFor();
    let s = await state(page);
    assert.deepEqual([s.status, s.sel, s.cards, s.pips, s.statusLine], ['ready', null, 0, ['2'], null], 'the inventory read: one pip, nothing chosen, no status line');

    // chosen (pressed twice: one card, still slot 2)
    await press(pip);
    await page.locator('#wide-v-title').waitFor();
    if (await pip.count()) await press(pip);
    s = await state(page);
    assert.deepEqual([s.sel, s.cards], [2, 1], 'the wide village on the village screen, once');
    const card = await page.locator('#wide-v-title').textContent();
    assert.match(card, /9007199254740993/, 'its coordinate whole (past 2^53)');
    assert.match(await page.locator('#panel').textContent(), /読み取り専用/);

    // two refreshes of the viewer's record: kept
    await page.evaluate(async () => { const c = await import('/frontier/controller.mjs'); await c.refresh(); await c.refresh(); });
    s = await state(page);
    assert.deepEqual([s.status, s.sel, s.cards], ['ready', 2, 1], 'kept across refreshes');

    // back to the ordinary village
    await press(page.locator('[data-act="wide-close"]:visible').first());
    await page.waitForFunction(() => !document.getElementById('wide-v-title'));
    s = await state(page);
    assert.deepEqual([s.sel, s.cards], [null, 0], 'the ordinary village again');
    assert.match(await page.locator('#panel').textContent(), /ラマール/, 'its own card');

    // back/forward, then a reload with the wide village chosen: whole, nothing chosen, the pip there
    await page.goto(`${url}?ws07=2`); await ready(page);
    await page.goBack(); await ready(page);
    await page.goForward(); await ready(page);
    assert.equal(new URL(page.url()).searchParams.get('ws07'), '2');
    await pip.waitFor();
    await press(pip);
    await page.locator('#wide-v-title').waitFor();
    await page.reload(); await ready(page);
    await pip.waitFor();
    s = await state(page);
    assert.deepEqual([s.status, s.sel, s.cards, s.pips], ['ready', null, 0, ['2']], 'after a reload: the pip, nothing chosen');

    // an envelope of another world: refused, said with 再試行, no pip (never "no wide villages")
    srv.meWith(wideMe(srv.viewer, { status: 'error' }));
    await page.reload(); await ready(page);
    await page.waitForFunction(() => !!document.querySelector('.wide-inventory-status'));
    s = await state(page);
    assert.deepEqual([s.status, s.error, s.pips], ['error', 'WorldMismatch', []]);
    assert.match(s.statusLine, /遠方の村の情報を読み込めません（WorldMismatch）。保有地がないことを意味しません。/);
    if (phone) {
      // (the line stands after the "next thing" in the resting sheet: 780acac7)
      const order = await page.evaluate(() => { const n = document.querySelector('#panel-body .next-row-go'), w = document.querySelector('#panel-body .wide-inventory-status'); return n && w ? !!(n.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING) : null; });
      assert.notEqual(order, false, 'the status line is not above the next thing');
    }
    srv.meWith(null);

    assert.deepEqual(posts, [], 'no request but reads');
    assert.deepEqual(errors, [], 'no page or console error');
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });
}
