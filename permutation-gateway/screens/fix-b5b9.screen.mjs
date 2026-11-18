// The loop-play report B5–B9 (2026-11-18), in a real browser on the keyless screens fixture (no chain, no key, no relay,
// no launcher). Fixture checks of what the page SHOWS in each fixed state — the state is put into the page (FS) where
// the fixture's sample world has none (local play, a conquest season, a reach list), as conquest-press.screen.mjs and
// local-march-maptap.screen.mjs do; the cards, styles and redraws are the page's own. Not evidence of a live launcher
// world: the launcher's stop is not replayed here (the gate's question and the launcher's answer are pinned in
// test/web-frontier-fix-b6-b9.test.mjs and test/web-frontier-world-ended.test.mjs).
//   B5  a world confirmed ended: the dial stands at the herald's last turn and says "world ended", the banner says so,
//       the clock no longer follows this machine's time, and the map is handed the herald's own turn for "arrived".
//   B6  the host bar's local-play line names the refused order.
//   B7  the nation tab lists the viewer's own contested keep as "Defend".
//   B8  on the title, the one "Choose a nation" in the document is the visible key; it can be found by role and pressed.
//   B9  the nation tab's empty reach list says it is still being worked out.
// Run from this folder: [FIX_B5B9_PORT=41700] [SHOT_DIR=…] node --test fix-b5b9.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import { LATEST_UNIX, HOME } from './world.mjs';

const PORT = Number(process.env.FIX_B5B9_PORT ?? 0), SHOTS = process.env.SHOT_DIR ?? null;
let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true, port: PORT });
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { await browser?.close(); await srv?.close(); });

const T0 = LATEST_UNIX * 1000 + 500;
async function open(lang, { stage = 'holding', title = false } = {}) {
  srv.stage(stage);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: lang === 'en' ? 'en-US' : 'ja-JP', timezoneId: 'UTC' });
  await NK.prepare(ctx, srv.viewer, { lang });
  // (the title: a first visit — the "title seen" mark of the returning player is taken away again before the page reads it)
  if (title) await ctx.addInitScript(() => { try { localStorage.removeItem('ps-fintro:v1'); } catch { /* none */ } });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.clock.setFixedTime(new Date(T0));
  await page.goto(`${base}/frontier/index.html?at=${HOME.p},${HOME.q},${HOME.tile},1.0`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
  return { ctx, page, errors, posts };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const sent = posts => posts.filter(x => !x.endsWith('/f/nudge'));
const dial = page => page.evaluate(() => document.getElementById('bell-chip').textContent.replace(/\s+/g, ' ').trim());
const frames = (page, n = 6) => page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r)); }, n);

// ------------------------------------------------------------------ B5
for (const lang of ['en', 'ja']) test(`B5 (${lang}): a world confirmed ended — the dial stands at the herald's last turn, the banner says the world ended, the clock stops`, { timeout: 120_000 }, async () => {
  const { ctx, page, errors, posts } = await open(lang);
  try {
    const turn0 = Number(/\d+/.exec(await dial(page))[0]);
    // the fault's own state first: this machine's clock runs on 6600 s with no newer sample — the page's turn runs ahead
    // of the herald's (the fixture's herald goes on answering with the same sample)
    await page.clock.setFixedTime(new Date(T0 + 6_600_000));
    await page.evaluate(async () => { const { invalidate } = await import('/frontier/fstate.mjs'); invalidate('chip'); });
    await page.waitForFunction(t => Number(/\d+/.exec(document.getElementById('bell-chip').textContent)?.[0]) === t + 11, turn0);
    const ahead = await page.evaluate(async () => {
      const { FrontierMap } = await import('/frontier/map/fmap.mjs');
      const P = FrontierMap.prototype, draw = P.draw;
      P.draw = function (...a) { window.__map = this; return draw.apply(this, a); };
      for (let i = 0; i < 80 && !window.__map; i++) { window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 50)); }
      const { FS } = await import('/frontier/fstate.mjs');
      const { bellAt } = await import('/frontier/clock.mjs');
      return { seenBell: window.__map?.source?.()?.seenBell ?? null, clockBell: bellAt(FS.clock.genesisTs, FS.chain.now()) };
    });
    assert.equal(ahead.clockBell, turn0 + 11, 'the extrapolated clock is ahead');
    assert.equal(ahead.seenBell, turn0, 'the map is handed the herald\'s own turn for "arrived", not the extrapolated one');
    await shot(page, `b5-before-ahead-of-the-herald-${lang}`);
    // (the "new turn" announcement the jump set off plays on the effects' own clock — fx/clock.mjs —, which this test's
    //  fixed time holds still: the clock is stepped ten seconds by hand, as that module provides for a test, so the
    //  announcement ends as it would on a running clock)
    await page.evaluate(async () => { const { clock } = await import('/frontier/fx/clock.mjs'); clock.freeze(); clock.step(10); clock.play(); });
    await frames(page, 30);
    // the end, confirmed (the page's own function, as the watch calls it once the launcher said WorldNotFound)
    await page.evaluate(async () => { const { worldEnded } = await import('/frontier/app.mjs'); worldEnded(); });
    await frames(page);
    const word = lang === 'en' ? 'ended' : '終了済み';
    assert.equal(await dial(page), lang === 'en' ? `Turn ${turn0} · ${word}` : `ターン ${turn0} · ${word}`, 'the last turn the herald reported, and that the world is over');
    const banner = page.locator('#stale-banner');
    assert.equal(await banner.isVisible(), true);
    assert.equal((await banner.textContent()).trim(), lang === 'en'
      ? 'This world has ended. Its turns no longer advance and no order can be sent. To play on, open the start page again and start a new world.'
      : 'この世界は終了しました。ターンはもう進まず、命令も送れません。新しい世界は、開始ページを開き直して始めてください。');
    assert.equal(await banner.getAttribute('data-ended'), '1');
    assert.equal(await banner.locator('[data-act="state-reread"]').count(), 0, 'no re-read key: nothing is left to read');
    assert.equal(await page.getByRole('status').filter({ hasText: lang === 'en' ? 'This world has ended.' : 'この世界は終了しました。' }).count(), 1, 'said to a screen reader too');
    // this machine's clock goes on for another 100 minutes: the world's does not
    await page.clock.setFixedTime(new Date(T0 + 12_600_000));
    await page.evaluate(async () => { const { invalidate } = await import('/frontier/fstate.mjs'); invalidate('chip', 'panel', 'rail'); });
    await frames(page);
    assert.match(await dial(page), new RegExp(`${turn0} · ${word}$`), 'the dial does not tick');
    const state = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); const { bellAt } = await import('/frontier/clock.mjs');
      return { halted: FS.chain.halted, bell: bellAt(FS.clock.genesisTs, FS.chain.now()), nowBell: FS.nowBell, stale: FS.stale?.stale ?? null, error: FS.error?.code ?? null }; });
    assert.deepEqual(state, { halted: true, bell: turn0, nowBell: turn0, stale: false, error: null });
    assert.equal(await page.locator('#error-line').isVisible(), false, 'no "could not connect" beside it');
    await shot(page, `b5-world-ended-${lang}`);
    assert.deepEqual(sent(posts), [], 'nothing sent'); assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

// ------------------------------------------------------------------ B6
for (const lang of ['en', 'ja']) test(`B6 (${lang}): the host bar's local-play line names the refused order; March is offered`, { timeout: 120_000 }, async () => {
  const { ctx, page, errors, posts } = await open(lang);
  try {
    const host = await page.evaluate(async () => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      for (let i = 0; i < 120 && ![...FS.provinces.values()].some(e => (e.province?.entries ?? []).some(x => x.state === 1)); i++) await new Promise(r => setTimeout(r, 250));
      const pv = [...FS.provinces.values()].map(e => e.province).find(p => (p.entries ?? []).some(e => e.state === 1));
      const e = pv?.entries.find(x => x.state === 1);
      if (!e) return null;
      // (test-only, in this page: local play with its march trial open for this host — the state of the report's worlds)
      FS.localPlay = Object.freeze({ address: 'W', programId: 'P', seasonAddress: 'S', cluster: 'localnet' });
      Object.defineProperty(FS, 'localMarchFor', { configurable: true, enumerable: false, value: () => ({ open: true }) });
      FS.selected = { p: pv.p, q: pv.q, idx: e.tile };
      FS.hand = { host: String(e.id) };
      invalidate('panel', 'map', 'rail');
      return String(e.id);
    });
    assert.ok(host, 'a host of the viewer stands in the fixture');
    const note = page.locator('.hand-note-why');
    await note.first().waitFor({ timeout: 10_000 });
    const said = (await note.allTextContents()).map(s => s.trim());
    const want = lang === 'en' ? 'In local play, “Dissolve” cannot be sent yet (read only).' : 'ローカルプレイでは、「解散」はまだ送れません（読み取りのみ）。';
    assert.deepEqual(said, [want], 'the one line, naming the order');
    const plainLine = lang === 'en' ? 'In local play, this order cannot be sent yet (read only).' : 'ローカルプレイでは、まだ命令を送れません（読み取りのみ）。';
    const march = page.locator('.hand-btn.hand-march'), dissolve = page.locator('.hand-btn.hand-dissolve');
    assert.notEqual(await march.getAttribute('aria-disabled'), 'true', 'March is offered');
    assert.equal(await dissolve.getAttribute('aria-disabled'), 'true');
    assert.equal(await dissolve.getAttribute('title'), plainLine, 'the refused button itself keeps the plain sentence');
    assert.equal(await page.locator('.hand-btn .hand-why').filter({ hasText: plainLine }).count(), 0, 'not clipped inside a button');
    await shot(page, `b6-host-bar-names-the-refused-order-${lang}`);
    assert.deepEqual(sent(posts), [], 'nothing sent'); assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

// ------------------------------------------------------------------ B7, B9
/** The nation tab with a conquest season and a reach list put into the page (test-only): `rows`, `keepsPending`. */
async function nationTab(page, { rows, keepsPending = 0 }) {
  await page.evaluate(async ({ rows, keepsPending }) => {
    const { FS, invalidate } = await import('/frontier/fstate.mjs');
    const route = { hexes: 12, provinces: [{ p: 0, q: 0 }, { p: 1, q: 0 }], secs: 1500 };
    FS.sample = false; FS.season = { ...FS.season, programVersion: 3, conquestParams: { keepBells: 72 } };
    const me = FS.citizen.faction, other = (me + 1) % 6;
    FS.conquest = { status: 'ready', keeps: new Map(), history: new Map(), events: [], standings: null, final: null, keepsPending,
      reach: { key: 'test', ok: true, home: false, unreachable: [], rows: rows.map(r => ({ p: r.p, q: r.q, tile: 30, holder: r.defend ? me : other, troops: r.troops, origin: { p: 0, q: 0, tile: 20, unit: 0 }, route, ...(r.defend ? { defend: true } : {}) })) } };
    FS.tab = 'territory';
    invalidate('panel', 'tabs', 'rail');
  }, { rows, keepsPending });
  await page.locator('#conquest-reach-title').waitFor({ timeout: 10_000 });
}
for (const lang of ['en', 'ja']) test(`B7 (${lang}): the nation tab offers the viewer's own contested keep as "Defend", apart from the other nations' keeps`, { timeout: 120_000 }, async () => {
  const { ctx, page, errors, posts } = await open(lang);
  try {
    await nationTab(page, { rows: [{ p: 4, q: -2, troops: 0, defend: true }, { p: 3, q: 1, troops: 100 }] });
    const defend = page.locator('.kr-rows-defend .kr-row-defend');
    assert.equal(await defend.count(), 1);
    assert.equal(await defend.getAttribute('data-keep-defend'), '4,-2');
    const text = (await defend.innerText()).replace(/\s+/g, ' ');
    assert.match(text, lang === 'en' ? /Province 4,-2 · Held by your nation · 0 defenders/ : /州 4,-2 · あなたの国が保持 · 守備兵 0/);
    assert.match(text, lang === 'en' ? /Defend · staying on the tile stops their hold/ : /守りに向かう · マスに残れば占拠を止めます/);
    assert.equal(await page.locator('#conquest-defend-title').innerText(), lang === 'en' ? 'Keeps of your nation that another nation is taking' : '他国が占拠を進めている、あなたの国の砦');
    // the list is named for a screen reader, and the way there is a real, visible key
    assert.equal(await page.getByRole('list', { name: await page.locator('#conquest-defend-title').innerText() }).count(), 1);
    assert.equal(await defend.getByRole('button').isVisible(), true);
    const others = page.locator('.kr-rows:not(.kr-rows-defend) .kr-row');
    assert.equal(await others.count(), 1, 'the other nations\' list holds only theirs');
    assert.doesNotMatch(await others.first().innerText(), lang === 'en' ? /Defend|Province 4,-2/ : /守りに向かう|州 4,-2/);
    await page.locator('.conquest-reach').scrollIntoViewIfNeeded();
    await shot(page, `b7-own-contested-keep-defend-${lang}`);
    assert.deepEqual(sent(posts), [], 'nothing sent'); assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
for (const lang of ['en', 'ja']) test(`B9 (${lang}): an empty reach list says it is still being worked out while keeps cannot be placed yet; then says none`, { timeout: 120_000 }, async () => {
  const { ctx, page, errors, posts } = await open(lang);
  try {
    const none = lang === 'en' ? 'No keep of another nation is within reach now.' : 'いま届く他国の砦はありません。';
    await nationTab(page, { rows: [], keepsPending: 2 });
    const box = page.locator('.conquest-reach');
    assert.equal((await box.locator('.kr-loading').innerText()).trim(), lang === 'en' ? 'Finding the keeps you can reach…' : '届く砦を調べています…');
    assert.ok(!(await box.innerText()).includes(none), 'never "no keep within reach" while keeps are still to be placed');
    await box.scrollIntoViewIfNeeded();
    await shot(page, `b9-reach-list-loading-${lang}`);
    // every ring read: the empty list is the answer
    await nationTab(page, { rows: [], keepsPending: 0 });
    await page.waitForFunction(t => document.querySelector('.conquest-reach')?.innerText.includes(t), none, { timeout: 10_000 });
    assert.equal(await box.locator('.kr-loading').count(), 0);
    assert.deepEqual(sent(posts), [], 'nothing sent'); assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

// ------------------------------------------------------------------ B8
for (const lang of ['en', 'ja']) test(`B8 (${lang}): on the title the one "Choose a nation" is the visible key — found by role, pressed by Playwright, and it leads to the nation choice`, { timeout: 120_000 }, async () => {
  const { ctx, page, errors, posts } = await open(lang, { stage: 'none', title: true });
  try {
    const name = lang === 'en' ? 'Choose a nation' : '国を選ぶ';
    await page.waitForFunction(() => document.body.dataset.title === 'up');
    const go = page.locator('.intro-go');
    await go.waitFor({ state: 'visible', timeout: 15_000 });
    assert.match((await go.innerText()).trim(), new RegExp(`^${name}`), 'the title\'s key says it');
    // the document holds no other key of that name, hidden or not: by the name, by the act, by the role
    assert.equal(await page.locator('[data-act="join-open"]').count(), 0, 'no hidden plate key under the title');
    const named = await page.evaluate(n => [...document.querySelectorAll('button')].filter(b => b.textContent.trim().startsWith(n)).map(b => ({ act: b.dataset.act, visibility: getComputedStyle(b).visibility })), name);
    assert.deepEqual(named, [{ act: 'intro-close', visibility: 'visible' }]);
    const byRole = page.getByRole('button', { name });
    assert.equal(await byRole.count(), 1, 'one in the accessibility tree');
    assert.equal(await byRole.isVisible(), true);
    await shot(page, `b8-title-one-visible-key-${lang}`);
    // pressed as Playwright presses (its own visibility and hit checks, no coordinates given)
    await byRole.click({ timeout: 10_000 });
    await page.waitForFunction(() => document.body.dataset.title === undefined);
    // the nation choice stands: its keys are real, visible buttons (six nations)
    await page.locator('[data-act="pick-faction"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await page.locator('[data-act="pick-faction"]').count(), 6);
    await page.waitForTimeout(900);   // (the curtain lifts: .6 s)
    const after = await page.evaluate(() => ({ joinKeys: [...document.querySelectorAll('[data-act="join-open"]')].map(b => getComputedStyle(b).visibility), doc: document.body.dataset.doc ?? null, kind: document.body.dataset.kind ?? null }));
    assert.ok(after.joinKeys.every(v => v === 'visible'), `a plate key that is there is visible: ${JSON.stringify(after)}`);
    await shot(page, `b8-after-press-nation-choice-${lang}`);
    assert.deepEqual(sent(posts), [], 'nothing sent'); assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
