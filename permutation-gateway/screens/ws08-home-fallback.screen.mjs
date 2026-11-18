// Workstream 08, doc 31 §1 option A (2026-11-18), on the WHOLE game page in a real browser: when every place a first
// village can be put at once is held (60 sites: the nation's 5 provinces of rings 2 and 3), the page goes to the
// program's existing village request instead of stopping at "no land found yet".
//
// The fixture (server.mjs with ws08/full-heartland.mjs, opt-in): the screens world's instant-home Season with rings
// 0 .. 3 open, and the herald files of nation 0's wedge saying that all 60 sites are held (or 59, one left free).
// The viewer is the fixture's dev wallet on 127.0.0.1 (world.mjs storageFor: fixture seeds, as frontier.screen.mjs
// uses them; no real key, no chain). What is checked is what the page SHOWS, in Japanese and English:
//   1. a visitor choosing the full nation: one notice says what beginning will do; the one button is still enabled;
//   2. a Citizen without a village, heartland full: the request's wait view with one line of reason, no planner
//      button — and the page itself asks the relay to file the request (the fixture relay sends nothing and says so,
//      so the card ends in "not gone through" with its retry: that refusal is the fixture's, not the program's);
//   3. the same Citizen with ONE site free: the planner's card and its one button, exactly as before; no fallback line.
// Nothing here shows a request landing or a village being founded: no chain is behind this page.
//
//   cd permutation-gateway/screens && npm ci && node --test ws08-home-fallback.screen.mjs
//   WS08_FALLBACK_OUT=<dir>   where the screenshots go (default: the system's temporary folder)
//   WS08_FALLBACK_PORT=<n>    the fixture's port (default 41700)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import { storageFor, LATEST_UNIX } from './world.mjs';
import { fullHeartland, heartland, SITES } from './ws08/full-heartland.mjs';

const OUT = process.env.WS08_FALLBACK_OUT ?? path.join(tmpdir(), 'wylls-ws08-home-fallback');
const PORT = Number(process.env.WS08_FALLBACK_PORT ?? 41700);
mkdirSync(OUT, { recursive: true });
const NATION = 0;
let srv, browser;
before(async () => {
  srv = await startServer({ port: PORT });
  srv.openRings(4);
  browser = await chromium.launch();
});
after(async () => { srv?.heraldWith(null); await browser?.close(); await srv?.close(); });

const WORDS = {
  ja: { nation: /この国は、すぐに村を置ける本国の土地がいま空いていません。この国で始めると、代わりに空いている土地へ村の申し込みを出します（村が決まるまで約11〜21分）。本国に空きのある国なら、すぐに村を置けます。/,
    request: /すぐに村を置ける本国の土地は、いま空いていません。代わりに、空いている土地へ村の申し込みを出します。/, dead: /入植できる土地がまだ見つかりません/, planner: /最初の村を置いています/, begin: /村を築いて始める/ },
  en: { nation: /This nation has no free site right now in its heartland, where a first village is placed at once\. If you begin with this nation, a village request is sent to open land instead \(about 11 to 21 minutes until the village is decided\)\. A nation with free sites in its heartland places your village at once\./,
    request: /The heartland, where a first village is placed at once, has no free site right now\. A village request is sent to open land instead\./, dead: /No available land was found yet/, planner: /Placing your first village/, begin: /Found a village and begin/ },
};
const text = loc => loc.evaluate(e => (e.innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim());
function initScript({ storage }) { try { for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); } catch { /* no storage */ } }

/** The page for a viewer stage and language; `problems` collects console errors, page errors and HTTP errors. */
async function open({ stage, lang, viewport = { width: 1440, height: 900 } }) {
  srv.stage(stage);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: lang === 'ja' ? 'ja-JP' : 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' });
  await context.addInitScript(initScript, { storage: storageFor(srv.viewer, { stage, lang }) });
  const page = await context.newPage(), problems = [];
  await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(`${srv.url}/frontier/index.html`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
  return { context, page, problems };
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

test('the fixture: 60 sites of the nation\'s home rings, all held (or all but one)', () => {
  assert.equal(heartland(NATION).length * SITES, 60);
});

for (const lang of ['ja', 'en']) {
  test(`${lang}: a visitor choosing a nation whose heartland is full is told what beginning does; the button is enabled`, { timeout: 120_000 }, async () => {
    srv.heraldWith(fullHeartland({ faction: NATION }));
    const { context, page, problems } = await open({ stage: 'none', lang });
    try {
      await page.locator(`[data-act="pick-faction"][data-f="${NATION}"]`).first().click();
      const note = page.locator('[data-home-fallback="nation"]');
      await note.waitFor({ timeout: 20_000 });
      assert.match(await text(note), WORDS[lang].nation);
      const panel = await text(page.locator('.nation-confirm'));
      assert.doesNotMatch(panel, WORDS[lang].dead, 'not the planner\'s dead end');
      assert.equal(await page.locator('.nation-confirm .notice.error').count(), 0, 'not an error');
      assert.equal(await page.locator('.nation-confirm [data-act="home-confirm"]').isEnabled(), true, 'the one button begins');
      // the notice can be read: it is in view, and its ink is not its ground (it once wore a light box under light ink)
      const look = await note.evaluate(e => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return { w: r.width, h: r.height, ink: c.color, ground: c.backgroundColor }; });
      assert.ok(look.w > 100 && look.h > 10, JSON.stringify(look));
      assert.match(look.ground, /rgba\(0, 0, 0, 0\)|transparent/, `the plate's own ground (${look.ground})`);
      await shot(page, `01-visitor-full-nation-${lang}.png`);
      await page.setViewportSize({ width: 390, height: 844 });
      await note.scrollIntoViewIfNeeded();
      assert.equal(await note.isVisible(), true, 'on a phone too');
      await shot(page, `01b-visitor-full-nation-phone-${lang}.png`);
      await page.setViewportSize({ width: 1440, height: 900 });
      // another nation, whose home rings have room: no such notice
      await page.locator('[data-act="pick-faction"][data-f="3"]').first().click();
      await page.waitForFunction(() => !document.querySelector('[data-home-fallback]') && !document.querySelector('[data-homes="loading"]'));
      assert.equal(await page.locator('.nation-confirm [data-act="home-confirm"]').isEnabled(), true);
      await shot(page, `02-visitor-other-nation-${lang}.png`);
    } finally { await context.close(); }
    assert.deepEqual(problems, []);
  });

  test(`${lang}: a Citizen without a village, heartland full: the village request's wait view with its reason, and the page files the request`, { timeout: 120_000 }, async () => {
    srv.heraldWith(fullHeartland({ faction: NATION }));
    const before = srv.requests.length;
    const { context, page, problems } = await open({ stage: 'joined', lang });
    try {
      const card = page.locator('section[aria-labelledby="join-sites"]');
      const line = card.locator('[data-home-fallback="request"]');
      await line.waitFor({ timeout: 30_000 });
      assert.match(await text(line), WORDS[lang].request);
      assert.equal(await card.locator('[data-act="home-confirm"]').count(), 0, 'no planner button: it has nowhere to place');
      const said = await text(card);
      assert.doesNotMatch(said, WORDS[lang].dead); assert.doesNotMatch(said, WORDS[lang].planner);
      // the page went on to the request by itself: it asked the relay to send one (the fixture relay sends nothing)
      await page.waitForFunction(() => !!document.querySelector('section[aria-labelledby="join-sites"] [data-act="auto-ticket"]'), null, { timeout: 30_000 });
      const posts = srv.requests.slice(before).filter(r => r.method === 'POST' && r.path.startsWith('/gw/'));
      assert.ok(posts.length >= 1, `the request was handed to the relay (${JSON.stringify(posts)})`);
      assert.match(await text(line), WORDS[lang].request, 'the reason stays above the refusal');
      await shot(page, `03-citizen-full-request-card-${lang}.png`);
      await card.screenshot({ path: path.join(OUT, `04-citizen-full-request-card-only-${lang}.png`) });
      if (lang === 'en') assert.doesNotMatch(await text(card), /[぀-ヿ一-鿿]/, 'no Japanese left in the English card');
    } finally { await context.close(); }
    assert.deepEqual(problems, []);
  });

  test(`${lang}: the same Citizen with one site free: the planner's card and button, unchanged; no fallback line`, { timeout: 120_000 }, async () => {
    const last = heartland(NATION).at(-1);
    srv.heraldWith(fullHeartland({ faction: NATION, open: { p: last.p, q: last.q, site: 7 } }));
    const before = srv.requests.length;
    const { context, page, problems } = await open({ stage: 'joined', lang });
    try {
      const card = page.locator('section[aria-labelledby="join-sites"]');
      await card.locator('[data-act="home-confirm"]').waitFor({ timeout: 30_000 });
      // the candidates have been read: the one free site is the one selected
      const sel = await page.waitForFunction(async () => { const { FS } = await import('/frontier/fstate.mjs'); const c = FS.homeChoice; return c && !c.loading && c.selected ? { p: c.selected.p, q: c.selected.q, site: c.selected.site, n: c.candidates.length, error: c.error ?? null } : null; }, null, { timeout: 30_000 });
      assert.deepEqual(await sel.jsonValue(), { p: last.p, q: last.q, site: 7, n: 1, error: null });
      const said = await text(card);
      assert.match(said, WORDS[lang].planner); assert.match(said, WORDS[lang].begin);
      assert.equal(await page.locator('[data-home-fallback]').count(), 0);
      assert.equal(await card.locator('[data-act="auto-ticket"]').count(), 0);
      assert.equal(srv.requests.slice(before).filter(r => r.method === 'POST' && r.path.startsWith('/gw/')).length, 0, 'nothing is sent: the planner waits for the press');
      await page.waitForTimeout(2500);   // (the map's first drawing: the shot is evidence, the checks above do not wait on it)
      await shot(page, `05-citizen-one-free-planner-${lang}.png`);
    } finally { await context.close(); }
    assert.deepEqual(problems, []);
  });
}
