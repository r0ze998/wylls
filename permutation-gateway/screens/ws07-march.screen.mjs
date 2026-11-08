// Workstream 07: the game's own march order, on the WHOLE page, as a connected player with no key
// (screens/ws07/nokey-page.mjs: the fixture server keyless, no seed in storage, a test wallet with the viewer's
// address that refuses to sign, the page on wylls.test, every key operation counted and checked empty).
//
// What is pressed is the page's existing flow (UX design 14.2): the village's tile, a host's chip, a lit tile — the
// order card (#mc-title) with its destination, stance and "seal and depart". Checked on a phone and on a desktop:
//   - the choice: a host in hand, a destination (a passable tile of the home province SEEN on the screen, nearest the
//     village first: on a phone the camp is off the edge); another tile changes the destination and keeps ONE card;
//   - the stance changed and changed back; the card's turn is within its window;
//   - cancel ("compose-close"): the card goes, nothing was sealed or kept; pressed twice, nothing more happens;
//   - repeated presses on the host chip and on the destination tile leave one host in hand and one card;
//   - a refresh of the viewer's record while the card stands (the page's own controller.refresh, twice): the card
//     keeps its host and destination and its turn is not before its window;
//   - back and forward, and a reload: the page comes back whole, with no order card and nothing sealed in storage,
//     and the flow works again from the start.
// "Seal and depart" is NEVER pressed here: pressing it seals the order (timelock encryption) and asks for a session
// signature. This file checks what the page does BEFORE anything is sealed, signed or sent; no request is made to
// the relay (checked). It does not check sealing, signing, sending or the chain.
//
// Run from this folder: node --test ws07-march.screen.mjs
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

/** Where a tile is seen now (viewport px), once the camera rests (as interaction.screen.mjs `tileAt`). */
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
/** A press on a tile: a touch on a phone (a context with touch), a click on a desktop. */
const tapTile = async (page, at) => { const p = await tileAt(page, at); if (page.__touch) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); };
const press = (page, loc) => (page.__touch ? loc.tap() : loc.click());

/** What the page holds: the selection, who has the hand, the order card. */
const state = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  const { subjectOf } = await import('/frontier/hud/hand.mjs');
  const sub = subjectOf(FS), c = FS.compose;
  return {
    who: sub ? (sub.kind === 'village' ? 'village' : String(sub.host.id)) : null,
    compose: c ? { host: String(c.host.id), dest: c.dest ? [c.dest.p, c.dest.q, c.dest.tile] : null, stance: c.stance ?? 0, bell: c.arriveBell ?? null, earliest: c.earliest ?? null, sending: !!c.sending, route: !!c.route } : null,
    nowBell: FS.nowBell ?? null, cards: document.querySelectorAll('#mc-title').length,
    sealed: Object.keys(localStorage).filter(k => /march|book/i.test(k)).map(k => localStorage.getItem(k)).filter(v => /"sealed"|"seal"/.test(v ?? '')).length,
  };
});

/**
 * Passable tiles of the home province (the page's own kernel), other than the village's, nearest the village first,
 * that are SEEN in the free part of the screen now (not under the bar or the dock, not off the edge): the
 * destinations a player can press without moving the camera.
 */
async function seenTiles(page) {
  const all = await page.evaluate(async ([p, q, from]) => {
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const { kernel } = await import('/frontier/wasm.mjs');
    const { FS } = await import('/frontier/fstate.mjs');
    const k = await kernel();
    const seed = FS.record.rings.find(r => r.d === 2).seed;
    const g = k.call('generate_province', { ring_seed: Uint8Array.from(seed.match(/../g), x => parseInt(x, 16)), p, q }).value;
    const at = i => (h => project(h.q, h.r))(tileHex(p, q, i)), a = at(from), h0 = tileHex(p, q, from);
    // (two hexes or more from the village: the village's picture stands over its neighbours, and a press there is the village's)
    const hexes = i => { const h = tileHex(p, q, i), dq = h.q - h0.q, dr = h.r - h0.r; return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2; };
    const out = [];
    for (let i = 0; i < 61; i++) if (hexes(i) >= 2 && ((BigInt(g.passableMask) >> BigInt(i)) & 1n)) out.push({ tile: i, d: Math.hypot(at(i).x - a.x, at(i).y - a.y) });
    return out.sort((x, y) => x.d - y.d).map(x => x.tile);
  }, [HOME.p, HOME.q, HOME.tile]);
  const free = await page.evaluate(() => {
    // (what covers the board's foot: the action bar, the dock, and the drawer or sheet when it shows)
    const tops = ['hand', 'tabs', 'panel'].map(id => document.getElementById(id)).filter(e => e && !e.hidden && e.getBoundingClientRect().height > 0)
      .map(e => e.getBoundingClientRect()).filter(r => r.width < innerWidth * 0.6 ? false : true).map(r => r.top);
    const side = document.getElementById('panel')?.getBoundingClientRect();
    const right = side && side.width > 0 && side.width < innerWidth * 0.6 ? side.left : innerWidth;
    return { w: right, bottom: Math.min(innerHeight, ...tops) - 24, top: 140 };
  });
  const seen = [];
  for (const tile of all) {
    const pt = await tileAt(page, { ...HOME, tile });
    if (pt.x > 24 && pt.x < free.w - 24 && pt.y > free.top && pt.y < free.bottom) seen.push(tile);
  }
  return seen;
}
/** Poll an async page function until it answers true (waitForFunction takes a Promise for a truthy answer). */
async function until(page, fn, arg, { timeout = 15_000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await page.evaluate(fn, arg)) return; await page.waitForTimeout(100); }
  throw new Error('until: timed out');
}
const ready = page => page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');

/** The host in hand and its order card on the camp: the page's own presses. */
async function compose(page, { chipTwice = false, dest = null } = {}) {
  await page.locator('#frontier-map[data-lod="tile"]').waitFor();
  await tapTile(page, HOME);
  await page.locator('#hand [data-hand="build"]').waitFor();
  // (the spearmen: the host that can march on the camp; the phone's bar lists the host in hand first, the Scout)
  const chip = page.locator('#hand .hand-chip[data-host]:not(.hand-back)', { hasText: '槍兵' }).first();
  await press(page, chip);
  if (chipTwice) await press(page, chip).catch(() => {});
  await page.locator('#hand [data-hand="march"][aria-pressed="true"]').waitFor();
  const tiles = dest === null ? await seenTiles(page) : null;
  const to = dest ?? tiles[0];
  assert.ok(Number.isInteger(to), 'a passable tile in view');
  await tapTile(page, { ...HOME, tile: to });
  // (the card's title is in its folded part on a phone, where the card opens as 「進軍の準備」 with its seal and やめる)
  await page.locator('#mc-title').waitFor({ state: 'attached' });
  await page.locator('[data-act="march-send"]:not([disabled])').waitFor({ timeout: 15_000 });
  return { to, tiles };
}

for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  test(`the march order @ ${vp.name}: choose, change, stance, cancel, repeated presses, a refresh, back/forward and a reload — nothing sealed, signed or sent`, { timeout: 180_000 }, async t => {
    const phone = vp.width < 760;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
    await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
    const page = await ctx.newPage();
    page.__touch = phone;
    const errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
    const url = `${base}/frontier/index.html?at=${HOME.p},${HOME.q},${HOME.tile},1.0`;
    await page.goto(url);
    await ready(page);
    assert.deepEqual(await page.evaluate(async () => { const m = await import('/session.mjs'); return [isSecureContext, String(m.keyFromSeed).includes('key use blocked'), String(m.publicKeyOf).includes('key use blocked')]; }),
      [true, true, true], 'a secure context; the page\'s own key functions refuse');

    // 1. the choice: a host in hand (its chip pressed twice: still one host), the camp as the destination
    const first = await compose(page, { chipTwice: true });
    const A = first.to;
    let s = await state(page);
    assert.equal(s.cards, 1, 'one order card');
    assert.deepEqual(s.compose.dest, [HOME.p, HOME.q, A], 'the pressed tile is the destination');
    assert.ok(s.compose.route, 'a road was planned');
    assert.ok(Number.isInteger(s.compose.bell) && s.compose.bell >= s.compose.earliest, `the card's turn ${s.compose.bell} is not before its earliest ${s.compose.earliest}`);
    const host = s.compose.host;

    // 2. another tile changes the destination; the same tile pressed twice keeps one card on it
    // (chosen now, with the card open: the camera has moved for it)
    const other = (await seenTiles(page)).find(x => x !== A);
    assert.ok(Number.isInteger(other), 'a second passable tile in view');
    await tapTile(page, { ...HOME, tile: other });
    await until(page, async t => { const { FS } = await import('/frontier/fstate.mjs'); return FS.compose?.dest?.tile === t && !!FS.compose.route; }, other);
    s = await state(page);
    assert.deepEqual([s.cards, s.compose.host, s.compose.dest], [1, host, [HOME.p, HOME.q, other]], 'another tile: the destination changed, the same host, one card');
    await tapTile(page, { ...HOME, tile: A });
    await tapTile(page, { ...HOME, tile: A });
    await page.locator('[data-act="march-send"]:not([disabled])').waitFor({ timeout: 15_000 });
    s = await state(page);
    assert.equal(s.cards, 1, 'still one order card after repeated taps');
    assert.equal(s.compose?.host, host, 'the same host');
    assert.deepEqual(s.compose?.dest, [HOME.p, HOME.q, A], 'the first tile again');

    // 3. the stance: changed and changed back by the card's own control
    const stances = page.locator('[data-act="mc-stance"]');
    if (await stances.count()) {
      const before = (await state(page)).compose.stance;
      await page.evaluate(async () => { const { ACTIONS } = await import('/frontier/controller.mjs'); ACTIONS['mc-stance']({ v: '2' }); });
      assert.equal((await state(page)).compose.stance, 2, 'the stance changed');
      await page.evaluate(async b => { const { ACTIONS } = await import('/frontier/controller.mjs'); ACTIONS['mc-stance']({ v: String(b) }); }, before);
      assert.equal((await state(page)).compose.stance, before, 'and back');
    }

    // 4. a refresh of the viewer's record while the card stands (twice, as two polls): the card is kept and coherent
    await page.evaluate(async () => { const c = await import('/frontier/controller.mjs'); await c.refresh(); await c.refresh(); });
    s = await state(page);
    assert.equal(s.cards, 1);
    assert.equal(s.compose?.host, host, 'the host kept across a refresh');
    assert.deepEqual(s.compose?.dest, [HOME.p, HOME.q, A], 'the destination kept across a refresh');
    assert.ok(s.compose.bell >= s.compose.earliest, 'the turn is not before its window after a refresh');
    assert.equal(await page.locator('[data-act="march-send"]:not([disabled])').count(), 1, 'still ready to seal (not pressed)');

    // 5. cancel: the card goes; pressed again (no card), nothing happens; nothing was sealed or kept
    await press(page, page.locator('[data-act="compose-close"]:visible').first());
    await page.waitForFunction(() => !document.getElementById('mc-title'));
    assert.equal(await page.locator('[data-act="march-send"]').count(), 0, 'the seal is gone with the card');
    await page.evaluate(async () => { const { ACTIONS } = await import('/frontier/controller.mjs'); ACTIONS['compose-close'](); });
    s = await state(page);
    assert.deepEqual([s.compose, s.cards, s.sealed], [null, 0, 0], 'cancelled: no card, nothing sealed');

    // 6. back and forward (a second entry in this tab's history first), then a reload: whole, with no card
    await page.goto(`${url}&ws07=2`);
    await ready(page);
    await page.goBack(); await ready(page);
    assert.equal(new URL(page.url()).searchParams.get('ws07'), null, 'back to the first entry');
    await page.goForward(); await ready(page);
    assert.equal(new URL(page.url()).searchParams.get('ws07'), '2', 'forward again');
    s = await state(page);
    assert.deepEqual([s.compose, s.cards, s.sealed], [null, 0, 0], 'after back/forward: no card, nothing sealed');
    await compose(page);
    await page.reload(); await ready(page);
    s = await state(page);
    assert.deepEqual([s.compose, s.cards, s.sealed], [null, 0, 0], 'a reload with a card open: the card is not brought back, nothing sealed');
    // and the flow works again from the start
    await compose(page);
    s = await state(page);
    assert.deepEqual([s.cards, s.compose?.dest?.slice(0, 2)], [1, [HOME.p, HOME.q]]);
    await press(page, page.locator('[data-act="compose-close"]:visible').first());

    assert.deepEqual(posts, [], 'no request but reads: nothing sent');
    assert.deepEqual(errors, [], 'no page or console error');
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });
}
