// Lane A (2026-11-16): the first-session path of docs/integration/CLAUDE-FIRST-PLAYABLE-STATUS-20261115.md, in a real
// browser on the keyless screens fixture (no chain, no key, no relay, an ephemeral port): open → choose a nation and
// see Join → the first village placed → Train → Form a host → March → the order card open with its send button.
// At each step it checks what the page SHOWS (English and Japanese, PC 1440 wide) and that nothing leaves the page but
// requests the fixture answers. It presses no button that would send: Join, the Train / Form confirms and the send
// button are only read. What the fixture does in the page's place is said where it does it:
//   * "first village placed": the fixture's viewer record moves from `none` to `holding` (srv.stage) and the page is
//     opened again — the step the program takes on a real Join. This test cannot show a Join landing.
//   * "Send this order": that word is local play's send button (hud/marchcard.mjs localWait). Its last step puts the
//     page in local play IN THE PAGE (FS.localPlay, FS.localMarch; test-only, as local-march-maptap.screen.mjs does).
// Nothing here is evidence of a world, a signature, a landed order or an unaided press.
// Run from this folder: node --test first-session.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import { LATEST_UNIX, HOME } from './world.mjs';

const OUT = process.env.FIRST_SESSION_OUT ?? path.join(tmpdir(), 'wylls-first-session');
mkdirSync(OUT, { recursive: true });
let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { await browser?.close(); await srv?.close(); });

/** The words each step must show, per language (the page's own strings: lang/en-frontier*.mjs and their Japanese keys). */
const WORDS = {
  en: { choose: 'Choose a nation to begin', join: /^Join \S/, train: 'Train', muster: 'Form a host', march: 'March',
    trainGo: /^Train \S/, musterGo: /^Form .*here$/, dest: /Press the destination tile/, seal: 'Seal and depart', send: 'Send this order' },
  ja: { choose: '国を選んで始める', join: /\Sで始める$/, train: '訓練', muster: '編成', march: '進軍',
    trainGo: /\S を訓練する$/, musterGo: /ここに集める$/, dest: /行き先のマスを押/, seal: '封をして出発する', send: '確認した命令で出発' },
};

const text = loc => loc.evaluate(e => (e.innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim());
/** The visible word of a hand-bar button (its word span, without the figure or the reason under it). */
const word = (page, id) => page.locator(`#hand [data-hand="${id}"]`).first().evaluate(b => {
  const w = b.querySelector('.hand-word') ?? b; return (w.innerText ?? w.textContent ?? '').replace(/\s+/g, ' ').trim();
});
const visible = loc => loc.first().evaluate(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; });

async function tileAt(page, at) {
  await page.evaluate(async () => {
    if (window.__map) return;
    const { FrontierMap } = await import('/frontier/map/fmap.mjs');
    const P = FrontierMap.prototype, draw = P.draw;
    P.draw = function (...a) { window.__map = this; return draw.apply(this, a); };
    for (let i = 0; i < 80 && !window.__map; i++) { window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 50)); }
  });
  return page.evaluate(async at => {
    const m = window.__map, frame = () => new Promise(r => requestAnimationFrame(r));
    for (let still = 0, i = 0; still < 10 && i < 400; i++) { await frame(); still = m.cam.moving || m.reachFly ? 0 : still + 1; }
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const h = tileHex(at.p, at.q, at.tile), c = project(h.q, h.r);
    return m.project(c.x, c.y);
  }, at);
}
/** A person-like press: down, a short hold, up, at one point. */
const pressAt = async (page, p) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up(); };
const pressEl = async (page, loc) => { await loc.first().waitFor({ state: 'visible' }); const b = await loc.first().boundingBox(); await pressAt(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }); };

/** Passable tiles of the home province two hexes or more from the village, nearest first, where a canvas is the topmost element. */
async function destinations(page) {
  const all = await page.evaluate(async ([p, q, from]) => {
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const { kernel } = await import('/frontier/wasm.mjs');
    const { FS } = await import('/frontier/fstate.mjs');
    const k = await kernel();
    const seed = FS.record.rings.find(r => r.d === 2).seed;
    const g = k.call('generate_province', { ring_seed: Uint8Array.from(seed.match(/../g), x => parseInt(x, 16)), p, q }).value;
    const at = i => (h => project(h.q, h.r))(tileHex(p, q, i)), a = at(from), h0 = tileHex(p, q, from);
    const hexes = i => { const h = tileHex(p, q, i), dq = h.q - h0.q, dr = h.r - h0.r; return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2; };
    const out = [];
    for (let i = 0; i < 61; i++) if (hexes(i) >= 2 && ((BigInt(g.passableMask) >> BigInt(i)) & 1n)) out.push({ tile: i, d: Math.hypot(at(i).x - a.x, at(i).y - a.y) });
    return out.sort((x, y) => x.d - y.d).map(x => x.tile);
  }, [HOME.p, HOME.q, HOME.tile]);
  const seen = [];
  for (const tile of all) {
    const pt = await tileAt(page, { ...HOME, tile });
    if (pt.x > 24 && pt.y > 140 && await page.evaluate(([x, y]) => x < innerWidth - 24 && y < innerHeight - 24 && document.elementFromPoint(x, y)?.tagName === 'CANVAS', [pt.x, pt.y])) seen.push({ tile, pt });
  }
  return seen;
}

for (const lang of ['en', 'ja']) test(`lane A (${lang} @ 1440): the first session — nation and Join, the first village, Train, Form a host, March, the order card with its send button; nothing sent but what the fixture answers`, { timeout: 180_000 }, async () => {
  const W = WORDS[lang], seen = {};
  srv.stage('none');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: lang === 'en' ? 'en-US' : 'ja-JP', timezoneId: 'UTC' });
  await NK.prepare(ctx, srv.viewer, { lang });
  const page = await ctx.newPage();
  const errors = [], sent = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') { const u = new URL(r.url()); sent.push({ method: r.method(), origin: u.origin, path: u.pathname }); } });
  const from = srv.requests.length;
  const shot = name => page.screenshot({ path: path.join(OUT, `${lang}-${name}.png`) }).catch(() => {});
  try {
    await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));

    // ── 1. open, as a connected player with no village: the nations, and a start button that waits for a choice
    await page.goto(`${base}/frontier/index.html`);
    await page.waitForFunction(() => document.body.dataset.stage !== 'loading');
    const start = page.locator('[data-act="join"], [data-act="home-confirm"]').first();
    await page.locator('[data-act="pick-faction"]').first().waitFor({ state: 'visible', timeout: 30_000 });
    await start.waitFor({ state: 'visible' });
    seen.nations = await page.locator('[data-act="pick-faction"]').count();
    seen.before = { text: await text(start), disabled: await start.isDisabled() };
    assert.ok(seen.nations >= 2, `nations to choose from (${seen.nations})`);
    assert.equal(seen.before.text, W.choose, 'the start button asks for a nation first');
    assert.equal(seen.before.disabled, true, 'and cannot be pressed yet');

    // ── 2. a nation chosen: the button says Join <nation> and can be pressed (it is not pressed: it would ask the wallet)
    await pressEl(page, page.locator('[data-act="pick-faction"][data-f="2"]'));
    await page.locator('[data-act="pick-faction"][data-f="2"][aria-pressed="true"]').waitFor();
    await page.waitForFunction(() => { const b = document.querySelector('[data-act="join"], [data-act="home-confirm"]'); return b && !b.disabled; }, null, { timeout: 15_000 });
    seen.join = { act: await start.getAttribute('data-act'), text: await text(start), disabled: await start.isDisabled() };
    assert.match(seen.join.text, W.join, `the button names the nation: ${seen.join.text}`);
    assert.equal(seen.join.disabled, false, 'Join can be pressed');
    await shot('1-join');

    // ── 3. the first village placed (FIXTURE: the viewer's record says `holding`, as after a landed Join; page opened again)
    srv.stage('holding');
    await page.goto(`${base}/frontier/index.html?at=${HOME.p},${HOME.q},${HOME.tile},1.0`);
    await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
    await page.locator('#frontier-map[data-lod="tile"]').waitFor();
    // (the viewer's record is read a moment after the page stands)
    seen.village = await page.evaluate(async () => {
      const { FS } = await import('/frontier/fstate.mjs');
      for (let i = 0; i < 120 && !(FS.holdings ?? []).length; i++) await new Promise(r => setTimeout(r, 250));
      return (FS.holdings ?? []).map(h => [h.p, h.q, h.tile]);
    });
    assert.deepEqual(seen.village[0], [HOME.p, HOME.q, HOME.tile], 'the page knows the viewer\'s first village');
    assert.equal(await page.locator('[data-act="pick-faction"]').count(), 0, 'no nation choice once the village stands');
    // a press on the village: its action bar, with Train and Form a host
    await pressAt(page, await tileAt(page, HOME));
    await page.locator('#hand [data-hand="build"]').waitFor();
    seen.bar = { train: await word(page, 'train'), muster: await word(page, 'muster') };
    assert.equal(seen.bar.train, W.train, 'the bar says Train');
    assert.equal(seen.bar.muster, W.muster, 'the bar says Form a host');
    await shot('2-village');

    // ── 4. Train: its card, the units, one confirm (read, not pressed)
    await pressEl(page, page.locator('#hand [data-hand="train"]'));
    await page.waitForFunction(() => document.getElementById('hand-pop')?.dataset.pop === 'train');
    await page.locator('#hand-pop .unit-tok').first().waitFor();
    const trainGo = page.locator('#hand-pop .pop-go[data-act="train"]');
    seen.train = { units: await page.locator('#hand-pop .unit-tok').count(), go: await text(trainGo), refused: await trainGo.getAttribute('aria-disabled'), shown: await visible(trainGo) };
    assert.ok(seen.train.units >= 1, 'the units to train');
    assert.match(seen.train.go, W.trainGo, `its confirm: ${seen.train.go}`);
    assert.equal(seen.train.shown, true, 'the confirm is on screen');
    await shot('3-train');

    // ── 5. Form a host: its card, one confirm (read, not pressed)
    await pressEl(page, page.locator('#hand [data-hand="muster"]'));
    await page.waitForFunction(() => document.getElementById('hand-pop')?.dataset.pop === 'muster');
    const musterGo = page.locator('#hand-pop .pop-go').first();
    await musterGo.waitFor();
    seen.muster = { go: await text(musterGo), act: await musterGo.getAttribute('data-act'), refused: await musterGo.getAttribute('aria-disabled'), shown: await visible(musterGo) };
    assert.match(seen.muster.go, W.musterGo, `its confirm: ${seen.muster.go}`);
    assert.equal(seen.muster.act, 'muster', 'an ordinary session\'s Form confirm');
    assert.equal(seen.muster.shown, true, 'the confirm is on screen');
    await shot('4-muster');
    await pressEl(page, page.locator('#hand-pop .pop-x'));
    await page.waitForFunction(() => !document.getElementById('hand-pop')?.dataset.pop);

    // ── 6. March: a host of the village takes the hand; March opens its card; a press on a tile drafts the order
    await pressEl(page, page.locator('#hand .hand-chip[data-host]:not(.hand-back)'));
    await page.locator('#hand [data-hand="march"][aria-pressed="true"]').waitFor();
    seen.marchWord = await word(page, 'march');
    assert.equal(seen.marchWord, W.march, 'the host bar says March');
    await pressEl(page, page.locator('#hand [data-hand="march"]'));
    await page.waitForFunction(() => document.getElementById('hand-pop')?.dataset.pop === 'march');
    seen.marchCard = await text(page.locator('#hand-pop'));
    assert.match(seen.marchCard, W.dest, 'the March card says to press the destination tile');
    const dest = await destinations(page);
    assert.ok(dest.length >= 1, 'a passable tile in sight');
    await pressAt(page, dest[0].pt);
    await page.locator('#mc-title').waitFor({ state: 'attached', timeout: 15_000 });
    const seal = page.locator('section[aria-labelledby="mc-title"] [data-act="march-send"]');
    await seal.waitFor({ state: 'visible', timeout: 15_000 });
    // (the route is found by the page's own planner; the button stands disabled until it is)
    await page.waitForFunction(() => { const b = document.querySelector('section[aria-labelledby="mc-title"] [data-act="march-send"]'); return b && !b.disabled; }, null, { timeout: 20_000 });
    seen.order = { title: await text(page.locator('#mc-title')), seal: await text(seal), disabled: await seal.isDisabled(), shown: await visible(seal), tile: dest[0].tile };
    assert.ok(seen.order.title.length > 0, 'the order card has a title');
    assert.equal(seen.order.seal, W.seal, 'an ordinary session\'s send button');
    assert.equal(seen.order.disabled, false, 'the order can be sent (the planner found the way)');
    assert.equal(seen.order.shown, true, 'the send button is on screen');
    await shot('5-order');

    // ── 7. "Send this order" (TEST-ONLY, in this page: local play with its march trial open, as the launcher's world
    //       gives it — the page's own card is written again; nothing is pressed)
    await page.evaluate(async () => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      FS.localPlay = { address: 'W', programId: 'P', seasonAddress: 'S', cluster: 'localnet', march: { trialEntry: true }, worldEndsAt: Date.now() + 3_600_000 };
      Object.defineProperty(FS, 'localMarch', { configurable: true, get: () => ({ open: true }) });
      Object.defineProperty(FS, 'localMarchFor', { configurable: true, enumerable: false, value: () => ({ open: true }) });
      invalidate('panel', 'map');
    });
    const send = page.locator('section[aria-labelledby="mc-title"] [data-act="march-send-wait"]');
    await send.waitFor({ state: 'visible', timeout: 15_000 });
    seen.send = { text: await text(send), disabled: await send.isDisabled(), shown: await visible(send), title: await text(page.locator('#mc-title')) };
    assert.equal(seen.send.text, W.send, 'local play\'s send button: Send this order');
    assert.equal(seen.send.shown, true, 'it is on screen');
    await shot('6-send');

    // ── nothing left the page but what the fixture answers; no key, no signature asked
    const served = srv.requests.slice(from).filter(r => r.method !== 'GET' && r.method !== 'HEAD');
    seen.sent = sent; seen.served = served;
    const own = new URL(base).origin;
    assert.deepEqual(sent.filter(s => s.origin !== own), [], 'no request to any other host');
    assert.deepEqual(sent.filter(s => !s.path.startsWith('/gw/')), [], 'every non-GET is to the fixture\'s relay');
    assert.equal(served.length, sent.length, 'and each was answered by the fixture');
    await NK.assertKeyless(ctx, assert);
    assert.deepEqual(errors, []);
  } catch (e) {
    await page.screenshot({ path: path.join(OUT, `${lang}-failed.png`), fullPage: true }).catch(() => {});
    writeFileSync(path.join(OUT, `${lang}-failed.html`), await page.content().catch(() => ''));
    throw e;
  } finally {
    writeFileSync(path.join(OUT, `${lang}.json`), `${JSON.stringify({ seen, errors, sent }, null, 2)}\n`);
    await ctx.close();
  }
});
