// Keyboard, sheet and focus behaviour in Chromium (web design §7.1, §10;
// UX design section 6): the drawer (closed when nothing is selected or
// open; the phone sheet rests at its peek, a dock press lifts it, "Map"
// closes it, Escape collapses it with focus on the handle; on desktop it
// slides in from the right and Escape puts it away), the full-bleed map
// (at least 80% of a 1440 × 900 screen is map with nothing open), the map
// by keyboard (+/−, H home, the buttons),
// the language toggle by keyboard, and a visible focus ring. Same fixture
// server as the matrix (127.0.0.1, port 0).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import { storageFor, LATEST_UNIX, HOME, CAMP_TILE } from './world.mjs';

let browser, srv;
before(async () => { srv = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(t, { width = 390, height = 844, stage = 'holding', page: file = 'index.html', query = '' } = {}) {
  srv.stage(stage);
  const phone = width < 760;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
  t.after(() => context.close());
  await context.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storageFor(srv.viewer, { stage, lang: 'ja' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
  await page.goto(`${srv.url}/frontier/${file}${query}`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? ''));
  t.after(() => assert.deepEqual(errors, [], 'no page or console error'));
  return page;
}
const sheet = page => page.locator('#panel').getAttribute('data-sheet');
/**
 * Where a point of the flat picture is seen (viewport px): the board is tilted (map/tilt.mjs), and the canvas says
 * its angle in `data-tilt`. A press meant for a tile goes where the tile is seen.
 */
const seenAt = (page, x, y) => page.evaluate(async ([x, y]) => {
  const { tiltGeo } = await import('/frontier/map/tilt.mjs');
  const cv = document.getElementById('frontier-map'), r = cv.getBoundingClientRect();
  const p = tiltGeo({ width: cv.clientWidth, height: cv.clientHeight }, Number(cv.dataset.tilt || 0)).toBox(x - r.left, y - r.top);
  return { x: p.x + r.left, y: p.y + r.top };
}, [x, y]);
const tap = async (page, x, y) => { const p = await seenAt(page, x, y); await page.mouse.click(p.x, p.y); };
/** The page's map (the instance is caught at its next picture). */
const mapOf = page => page.evaluate(async () => {
  if (window.__map) return true;
  const { FrontierMap } = await import('/frontier/map/fmap.mjs');
  const P = FrontierMap.prototype, draw = P.draw;
  P.draw = function (...a) { window.__map = this; return draw.apply(this, a); };
  for (let i = 0; i < 80 && !window.__map; i++) { document.getElementById('frontier-map').dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 50)); }
  return !!window.__map;
});

/**
 * Where a tile is seen now (viewport px), once the camera has come to rest: `at` is `{p, q, tile}` or a hex
 * `{q, r}`. Selecting a host lights its reach and the camera eases out until the reach's edge is in the picture
 * (UX brief §11.7), so a press meant for a tile is aimed at the tile, never at a place on the screen.
 */
const tileAt = async (page, at) => {
  await mapOf(page);
  return page.evaluate(async at => {
    const m = window.__map, frame = () => new Promise(r => requestAnimationFrame(r));
    // at rest: no move under way and none asked for, for a few frames in a row (the drawer slides in and the reach is framed again in what is left)
    for (let still = 0, i = 0; still < 10 && i < 400; i++) { await frame(); still = m.cam.moving || m.reachFly ? 0 : still + 1; }
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const h = Number.isInteger(at.tile) ? tileHex(at.p, at.q, at.tile) : at, c = project(h.q, h.r);
    return m.project(c.x, c.y);
  }, at);
};
const tapTile = async (page, at) => { const p = await tileAt(page, at); await page.mouse.click(p.x, p.y); };

const drawer = page => page.locator('#panel').getAttribute('data-drawer');

// Rewritten with the redesign (UX design section 6): the sheet rested at half with the map tab's panel in it;
// now the drawer is closed at load and the sheet rests at its peek (the plate and the to-do lines).
test('the phone sheet: it rests at the peek with the drawer closed; a dock press opens it to half; the handle cycles; "Map" closes; Escape collapses it', { timeout: 60_000 }, async t => {
  const page = await open(t);
  const handle = page.locator('[data-sheet-handle]');
  await handle.waitFor();
  assert.equal(await drawer(page), 'closed', 'nothing selected or open');
  assert.equal(await sheet(page), 'peek');
  assert.equal(await handle.getAttribute('aria-expanded'), 'false');
  assert.equal(await handle.getAttribute('aria-controls'), 'panel-body');
  // at rest the sheet shows the village plate and the one "next thing" under it, whole, and with the tab bar takes about a
  // quarter of the screen (wave 2, UX design 11.11: it was the sheet alone at 20–30%, 32% with the tab bar)
  await page.locator('#panel-body [data-act="home"]').waitFor();
  const peek = await page.locator('#panel').boundingBox();
  const foot = (844 - peek.y) / 844;
  assert.ok(foot > 0.22 && foot < 0.29, `the sheet and the tab bar take ${Math.round(844 - peek.y)} px of 844`);
  const next = await page.locator('#panel-body .next-row-go').boundingBox();
  assert.ok(next && next.y + next.height <= peek.y + peek.height + 0.5, 'the next thing is whole inside the peek');
  assert.equal(await page.locator('#panel-body .todo').isVisible(), false, 'the to-do lines wait for a raised sheet');
  // over the map: at most five controls (the search and the layers button, home and the world chart; no plus and minus on a touch screen)
  const floating = await page.evaluate(() => [...document.querySelectorAll('main button')].filter(b => !b.closest('#panel') && b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden').map(b => b.id || b.dataset.map || b.className));
  assert.ok(floating.length <= 5, `floating controls: ${floating.join(', ')}`);
  assert.deepEqual(floating.filter(x => x === 'in' || x === 'out'), []);
  // one layers button opens the four lenses by name; choosing one puts the list away
  await page.locator('.lens-toggle').click();
  assert.equal(await page.locator('.lens-toggle').getAttribute('aria-expanded'), 'true');
  // (hud-4: the fourth lens shows where a village could go; it read 「入植」 and reads 「空き地」 / "Free sites" now)
  // (fix pass 2: the way to the map's legend stands with the lenses, the fifth row of the list)
  assert.deepEqual(await page.locator('.lens-list .lens:visible .lens-text').allTextContents(), ['領土', '軍事', '地形', '空き地', '地図の見かた']);
  await page.locator('.lens[data-lens="war"]').click();
  assert.equal(await page.locator('.lens-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.lens-list').isVisible(), false);
  assert.equal(await page.locator('.lens[data-lens="war"]').getAttribute('aria-pressed'), 'true');
  // (fix pass 2: the strip no longer scrolls sideways, it ended in half an icon at the plaque's point) the most
  // pressing resources stand whole, the last carries how many more there are, and a press opens them all
  const strip = await page.locator('#res-strip').evaluate(el => ({ n: el.querySelectorAll('[data-res]').length, cut: el.scrollWidth > el.clientWidth + 1, more: el.querySelector('.res:last-child .res-more-n')?.textContent ?? '', all: [...el.querySelectorAll('[data-res]')].every(b => b.dataset.r === '*') }));
  assert.ok(strip.n >= 1 && strip.n <= 2 && !strip.cut, `the strip holds ${strip.n} resources, none cut: ${!strip.cut}`);
  assert.match(strip.more, /^\+\d+$/, 'the last token says how many more there are');
  assert.equal(strip.all, true, 'each opens every resource');
  await handle.click();
  assert.equal(await sheet(page), 'half');
  await handle.click();
  assert.equal(await sheet(page), 'full');
  assert.equal(await handle.getAttribute('aria-label'), 'パネルを小さくする');
  await handle.click();
  assert.equal(await sheet(page), 'peek');
  await page.locator('#tabs [data-tab="holding"]').click();
  assert.equal(await drawer(page), 'open');
  assert.equal(await sheet(page), 'half', 'a dock press opens the sheet');
  assert.equal(await page.locator('#tabs [data-tab="holding"]').getAttribute('aria-current'), 'page');
  await page.locator('#holding-title').waitFor();
  await page.locator('#panel-body [data-act="harvest"]').focus();
  await page.keyboard.press('Escape');
  assert.equal(await sheet(page), 'peek');
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-sheet-handle')), true, 'focus returns to the handle');
  // the open tab pressed while the sheet is low lifts it; "Map" closes the drawer
  await page.locator('#tabs [data-tab="holding"]').click();
  assert.equal(await sheet(page), 'half');
  await page.locator('#tabs [data-tab="map"]').click();
  assert.equal(await drawer(page), 'closed');
  assert.equal(await sheet(page), 'peek');
  assert.equal(await page.locator('#holding-title').count(), 0);
  assert.equal(await page.locator('#tabs [data-tab="map"]').getAttribute('aria-current'), 'page');
});

/** A real touch drag on the handle (CDP touch events: pointerdown/up, no click), `dy` px in 8 steps. */
async function touchDrag(page, dy) {
  // the sheet's height eases to its new state (visual only): the handle is measured where it comes to rest
  await page.locator('#panel').evaluate(el => Promise.all(el.getAnimations().map(x => x.finished.catch(() => {}))));
  const box = await page.locator('[data-sheet-handle]').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const at = yy => [{ x, y: yy, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(y) });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(y + (dy * i) / 8) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('a touch drag moves the sheet one step and the next single tap still works (wave-5 review)', { timeout: 60_000 }, async t => {
  const page = await open(t);
  const handle = page.locator('[data-sheet-handle]');
  await handle.waitFor();
  assert.equal(await sheet(page), 'peek');
  await touchDrag(page, -80);
  assert.equal(await sheet(page), 'half', 'dragging up expands one step');
  await touchDrag(page, -80);
  assert.equal(await sheet(page), 'full');
  // Past the drag's own click window, one genuine tap changes the state.
  await page.waitForTimeout(450);
  await handle.tap();
  assert.equal(await sheet(page), 'peek', 'the first tap after a drag is not swallowed');
  await touchDrag(page, -80);
  assert.equal(await sheet(page), 'half');
  await touchDrag(page, 80);
  assert.equal(await sheet(page), 'peek', 'dragging down collapses one step');
});

test('a mouse drag that ends off the handle still moves the sheet (pointer capture)', { timeout: 60_000 }, async t => {
  const page = await open(t, { width: 700, height: 900 });
  const handle = page.locator('[data-sheet-handle]');
  await handle.waitFor();
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  assert.equal(await sheet(page), 'peek');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y - 160, { steps: 8 });
  await page.mouse.up();
  assert.equal(await sheet(page), 'half', 'released far from the 44-px handle');
});

// Rewritten with hud-4 (UX design 11.13: the relay counter leaves the play screen and surfaces only when low): the
// line stood on the "More" tab itself and read 「中継 残り N 回」; it stands under "More → details" now, in the turn
// sheet, and says what the player can still do, 「送れる操作 残り N 回」.
test('on a phone the sponsored actions left are read under "More → details" (the chip shows only when low; wave-5 review D5)', { timeout: 60_000 }, async t => {
  const page = await open(t);
  assert.equal(await page.locator('#quota-chip').isVisible(), false, 'the chip waits');
  await page.locator('#tabs [data-tab="more"]').click();
  const line = page.locator('#panel-body [data-quota-line]');
  await line.waitFor({ state: 'attached' });
  assert.equal(await line.isVisible(), false, 'not on the play screen: it waits behind the details');
  await page.locator('#panel-body details[data-fold="more-details"] > summary').click();
  await line.waitFor();
  assert.match(await line.textContent(), /送れる操作 残り \d+ 回/);
  assert.doesNotMatch(await page.locator('#panel-body').innerText(), /中継 残り|第\d+鐘/);
});

// Rewritten with the redesign: on desktop the panel was a permanent column that Escape left alone; it is a drawer now.
test('the desktop drawer: closed at load, a dock press slides it in, Escape and "Map" put it away; the map has at least 80% of the screen', { timeout: 60_000 }, async t => {
  const page = await open(t, { width: 1440, height: 900 });
  assert.equal(await page.locator('[data-sheet-handle]').isVisible(), false);
  assert.equal(await drawer(page), 'closed');
  assert.equal(await page.locator('#panel').isVisible(), false, 'nothing selected or open: no panel');
  // the canvas is full-bleed, and with nothing open the HUD leaves at least 80% of the viewport to it
  await page.locator('#rail [data-act="home"]').waitFor();
  const share = await page.evaluate(() => {
    let map = 0, all = 0;
    for (let y = 2; y < innerHeight; y += 4) for (let x = 2; x < innerWidth; x += 4) { all++; if (document.elementFromPoint(x, y)?.id === 'frontier-map') map++; }
    const c = document.getElementById('frontier-map').getBoundingClientRect();
    return { map: map / all, canvas: [c.left, c.top, c.width, c.height] };
  });
  assert.deepEqual(share.canvas, [0, 0, 1440, 900], 'the canvas is the whole viewport');
  assert.ok(share.map >= 0.8, `map share ${share.map.toFixed(3)}`);
  await page.locator('#tabs [data-tab="holding"]').click();
  assert.equal(await drawer(page), 'open', 'the state is set at once (the slide is visual)');
  await page.locator('#holding-title').waitFor();
  const box = await page.locator('#panel').boundingBox();
  assert.ok(box.x > 1440 / 2 && box.x + box.width <= 1440, 'it stands at the right');
  await page.locator('#panel-body [data-act="harvest"]').focus();
  await page.keyboard.press('Escape');
  assert.equal(await drawer(page), 'closed', 'Escape puts the drawer away');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'frontier-map', 'the keyboard is back on the map');
  await page.locator('#panel').waitFor({ state: 'hidden' });
  // a selection on the map opens it; the dock's "Map" closes it
  await page.locator('#tabs [data-tab="more"]').click();
  // (hud-4: the turn sheet moved under "More → details"; the chronicle is the card of "More" that is always in sight)
  await page.locator('#chronicle-title').waitFor();
  await page.locator('#tabs [data-tab="map"]').click();
  assert.equal(await drawer(page), 'closed');
  await page.locator('#panel .panel-close').waitFor({ state: 'hidden' });
});

// UX brief §4 (the first view used to be the whole world at world LOD): a player with a village opens on that
// village; M and the world chart button go to the far view and back; every key acts on the logical view at once
// (the picture travels behind it), so the LOD is read right after each press.
test('the map by keyboard: it opens on the viewer\'s village; M is the world chart and back; + and − zoom, H goes home, the buttons work with Enter', { timeout: 60_000 }, async t => {
  const page = await open(t);
  const lod = () => page.locator('#frontier-map').getAttribute('data-lod');
  const view = () => page.evaluate(async ([p, q, tile]) => {
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const { coveredInsets } = await import('/frontier/map/fmap.mjs');
    const cv = document.getElementById('frontier-map'), h = tileHex(p, q, tile);
    return { home: project(h.q, h.r), covered: coveredInsets(cv).bottom, height: cv.clientHeight, width: cv.clientWidth };
  }, [HOME.p, HOME.q, HOME.tile]);
  // the opening: the village's tile, as soon as the page knows whose village it is
  await page.locator('#frontier-map[data-lod="tile"]').waitFor();
  assert.equal(await lod(), 'tile', 'the opening view is the viewer\'s village, not the world');
  await page.locator('#frontier-map').focus();
  // M: the far view at once (logically), M again: back to the village
  await page.keyboard.press('m');
  assert.equal(await lod(), 'world', 'M: the world chart');
  assert.equal(await page.locator('[data-map="chart"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-map="chart"]').getAttribute('aria-label'), 'もとの場所へ戻る');
  // (rewritten with UX brief §11.2: it was exactly four steps to the province level. The far view now fits the opened
  // world to the picture and is the world's level at any size; the province level begins a step or two further in)
  // (the picture flies there; once it has arrived the chart lies flat: the board's tilt is for the near views)
  await page.waitForFunction(() => document.getElementById('frontier-map').dataset.tilt === '0.00', null, { timeout: 5000 });
  let steps = 0;
  while (steps < 4 && (await lod()) === 'world') { await page.keyboard.press('+'); steps++; }
  assert.equal(await lod(), 'province', `the province level, ${steps} step(s) in from the far view`);
  await page.keyboard.press('h');
  assert.equal(await lod(), 'tile', 'home: the holding up close, on its tile');
  // on a phone the village is centred in the part of the map the sheet leaves free
  const v = await view();
  assert.ok(v.covered > 100, `the sheet covers ${v.covered} px of the map`);
  // the picture arrives where the logical view already is (a flight takes 1.2 s at most)
  await page.waitForTimeout(1500);
  await page.locator('#frontier-map[data-terrain="ready"]').waitFor();
  // the seat's frame (UX design 12.1): the village is seen in the part of the map the sheet leaves free, in the middle
  // across and a little below the middle down (the far rows and their horizon are above it); a tap there selects its tile
  const seat = await page.evaluate(async ([p, q, tile]) => {
    const { tileHex } = await import('/frontier/fgeo.mjs'); const { project } = await import('/map.mjs'); const { freeBox } = await import('/frontier/map/camera.mjs'); const { SEAT_DROP } = await import('/frontier/map/fmap.mjs');
    const m = window.__wyllsMap, h = tileHex(p, q, tile), w = project(h.q, h.r), s = m.size(), f = freeBox(s, m.inset());
    return { seen: m.project(w.x, w.y, { box: true }), want: { x: s.width / 2 + f.x, y: s.height / 2 + f.y + SEAT_DROP * f.height }, free: f, size: s, client: m.project(w.x, w.y) };
  }, [HOME.p, HOME.q, HOME.tile]);
  assert.ok(Math.hypot(seat.seen.x - seat.want.x, seat.seen.y - seat.want.y) < 1, `the village is seen at ${seat.seen.x.toFixed(1)}, ${seat.seen.y.toFixed(1)}; the seat's place is ${seat.want.x.toFixed(1)}, ${seat.want.y.toFixed(1)}`);
  assert.ok(seat.seen.y > seat.size.height / 2 + seat.free.y && seat.seen.y < seat.size.height - v.covered - 40, 'below the middle of the free part and well above the sheet');
  await page.mouse.click(seat.client.x, seat.client.y);
  const sel = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return FS.selected; });
  assert.deepEqual([sel?.p, sel?.q, sel?.idx], [HOME.p, HOME.q, HOME.tile], 'the village sits in the free part of the map above the sheet');
  // (wave 2, UX design 11.11: a touch screen has no plus and minus buttons — two fingers zoom there; the keys still do,
  // and the buttons are checked on a desktop below)
  assert.equal(await page.locator('[data-map="in"]').isVisible(), false);
  assert.equal(await page.locator('[data-map="out"]').isVisible(), false);
  await page.locator('#frontier-map').focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('+');
  assert.equal(await lod(), 'tile');
  for (let i = 0; i < 16; i++) await page.keyboard.press('-');
  assert.equal(await lod(), 'world', 'zooming out still reaches the world view');
  await page.locator('[data-map="chart"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await lod(), 'tile', 'from the far view the world chart button goes home');
  assert.equal(await page.locator('.map-tools').getAttribute('aria-label'), '地図の操作');
  // a desktop (a mouse): the plus and minus buttons are there and work with Enter
  const wide = await open(t, { width: 1440, height: 900 });
  const lodW = () => wide.locator('#frontier-map').getAttribute('data-lod');
  await wide.locator('#frontier-map[data-lod="tile"]').waitFor();
  await wide.locator('[data-map="out"]').focus();
  for (let i = 0; i < 16; i++) await wide.keyboard.press('Enter');
  assert.equal(await lodW(), 'world');
  await wide.locator('[data-map="in"]').focus();
  for (let i = 0; i < 16; i++) await wide.keyboard.press('Enter');
  assert.equal(await lodW(), 'tile', 'the buttons zoom with Enter');
});

test('the language toggle by keyboard, and a visible focus ring on every focusable control', { timeout: 60_000 }, async t => {
  const page = await open(t);
  await page.locator('#lang-box [data-lang-toggle]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.locator('[data-map="in"]').getAttribute('aria-label'), 'Zoom in');
  await page.keyboard.press(' ');
  await page.waitForFunction(() => document.documentElement.lang === 'ja');
  // Tab through the page from the top: every stop shows an outline.
  await page.evaluate(() => document.activeElement?.blur());
  const stops = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => { const el = document.activeElement; const s = getComputedStyle(el); return { tag: el.tagName, what: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20), outline: s.outlineStyle, width: parseFloat(s.outlineWidth) }; }));
  }
  const bare = stops.filter(s => s.tag !== 'BODY' && (s.outline === 'none' || s.width < 2));
  assert.deepEqual(bare, [], 'focus is visible');
  assert.ok(stops.some(s => s.tag === 'CANVAS'), 'the map is a tab stop');
});

// The step counts of the UI plan (§5, Civ's "how many clicks"): from a host selected on the map to "seal and
// depart" in at most 3 presses, and the next to-do item in 1. Presses are real clicks on the page and the canvas.
test('step counts: a selected host to "seal and depart" in 3 presses; the next to-do in 1', { timeout: 90_000 }, async t => {
  // 1.0 (it was 1.4): the drawer stands over the right 400 px of the map now, and the camp tile must stay left of it
  const Z = 1.0;
  // the camera on the viewer's home tile, where the fixture's ready host stands (?at=P,Q,TILE,ZOOM)
  const page = await open(t, { width: 1440, height: 900, query: `?at=${HOME.p},${HOME.q},${HOME.tile},${Z}` });
  await page.locator('#frontier-map[data-lod="tile"]').waitFor();
  // the host selected: a press on its tile (the selection itself is not counted)
  // (rewritten with UX brief §11.7: the presses were aimed at fixed places on the screen; a selection now eases the
  // camera out to the lit reach, so each press is aimed at its tile where the map shows it: tapTile)
  await tapTile(page, HOME);
  await page.locator('#panel-body [data-act="compose"]').first().waitFor();
  let presses = 0;
  presses++; await page.locator('#panel-body [data-act="compose"]').first().click();
  await page.locator('#mc-title').waitFor();
  presses++; await tapTile(page, { ...HOME, tile: CAMP_TILE });
  const send = page.locator('[data-act="march-send"]:not([disabled])');
  await send.waitFor({ timeout: 15_000 });
  presses++;
  assert.equal(presses, 3, 'march with this host, the destination tile, seal and depart');
  // the next to-do: one press on the pill moves to the item
  const pill = page.locator('#attn-pill');
  await pill.waitFor();
  const where = () => page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return JSON.stringify([FS.tab, FS.selected]); });
  await page.locator('[data-act="compose-close"]').first().click();
  const before = await where();
  await pill.click();
  assert.notEqual(await where(), before, 'the pill took the player to the item');
});

// UX brief §5.2 and §5.3: the map itself is the control. Selecting the viewer's village lights what its host can
// do at once; a tap on a lit tile is the order (two presses from nothing to the order card); a tap on a tile no
// march can reach is answered on the map and keeps the host; the same tile again takes the next host; off screen,
// a button at the map's edge points home and flies there.
test('the land: lit tiles on selection, a tap is the order, a refusal on the map, the pointer home', { timeout: 90_000 }, async t => {
  // (integration: zoom 1.0, not 1.4: a selection opens the inspector in the drawer over the right 396 px of the map,
  // and the camp tile must stay left of it, as in the step-count test above)
  const Z = 1.0;
  const page = await open(t, { width: 1440, height: 900, query: `?at=${HOME.p},${HOME.q},${HOME.tile},${Z}` });
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  const box = await page.locator('#frontier-map').boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // (rewritten with UX brief §11.7: every press on a tile was aimed at a fixed place on the screen, counted from
  // the camera the test had set; selecting the village now eases the camera out to its reach, so each press is
  // aimed at its tile where the map shows it, once the camera rests: tapTile. What is asserted is unchanged.)
  const home = () => tapTile(page, HOME);
  // where things are, from the page's own rules module: the camp, and the nearest tile no host can stand on
  const where = await page.evaluate(async ([p, q, from, camp]) => {
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const { kernel } = await import('/frontier/wasm.mjs');
    const { FS } = await import('/frontier/fstate.mjs');
    const k = await kernel();
    const seed = FS.record.rings.find(r => r.d === 2).seed;
    const g = k.call('generate_province', { ring_seed: Uint8Array.from(seed.match(/../g), x => parseInt(x, 16)), p, q }).value;
    const at = i => (h => project(h.q, h.r))(tileHex(p, q, i)), a = at(from);
    const off = i => ({ x: at(i).x - a.x, y: at(i).y - a.y });
    let wet = null;
    for (let i = 0; i < 61; i++) if (!((BigInt(g.passableMask) >> BigInt(i)) & 1n)) { const o = off(i); if (!wet || Math.hypot(o.x, o.y) < Math.hypot(wet.x, wet.y)) wet = { ...o, tile: i }; }
    return { camp: off(camp), wet };
  }, [HOME.p, HOME.q, HOME.tile, CAMP_TILE]);
  assert.ok(where.wet, 'the home province has a tile no host can stand on');
  const state = () => page.evaluate(async () => {
    const { FS } = await import('/frontier/fstate.mjs');
    return { sel: FS.selected ? [FS.selected.p, FS.selected.q, FS.selected.idx] : null, actor: FS.actor?.i ?? 0, note: FS.mapNote?.text ?? null, noteTile: FS.mapNote?.tile ?? null,
      compose: FS.compose ? { host: String(FS.compose.host.id), dest: FS.compose.dest ? [FS.compose.dest.p, FS.compose.dest.q, FS.compose.dest.tile] : null } : null, explore: FS.explore ? [...FS.explore.tiles] : null, tab: FS.tab ?? 'map' };
  });
  // 1. the village: selected, nothing composed yet
  await home();
  assert.deepEqual((await state()).sel, [HOME.p, HOME.q, HOME.tile]);
  assert.equal((await state()).compose, null, 'selecting composes nothing');
  // 1b. its reach is lit and the camera has eased out to it: the reach's box is in the part of the picture nothing covers
  const framed = await page.evaluate(async () => {
    const m = window.__map, frame = () => new Promise(r => requestAnimationFrame(r));
    for (let still = 0, i = 0; still < 10 && i < 400; i++) { await frame(); still = m.cam.moving || m.reachFly ? 0 : still + 1; }
    const { reachBox } = await import('/frontier/map/actions.mjs');
    const { hudInsets } = await import('/frontier/hud/insets.mjs');
    const b = reachBox(m.source().actions), ins = hudInsets(), w = m.canvas.clientWidth, h = m.canvas.clientHeight;
    const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => m.project(x, y, { box: true }));
    return { zoom: m.view.zoom, lod: m.lod, inside: pts.every(p => p.x >= ins.left && p.x <= w - ins.right && p.y >= ins.top && p.y <= h - ins.bottom), held: !!m.reachFit?.held };
  });
  assert.ok(framed.zoom < Z && framed.lod === 'tile', `the camera eased out (zoom ${framed.zoom.toFixed(2)}) and the tiles are still tiles`);
  assert.equal(framed.inside, true, 'the whole reach is in the free part of the picture');
  // 2. a tile no host can stand on: said on the map (and in the live line), the host stays selected
  await tapTile(page, { ...HOME, tile: where.wet.tile });
  await page.waitForFunction(async () => !!(await import('/frontier/fstate.mjs')).FS.mapNote);
  let s = await state();
  assert.deepEqual([s.note, s.noteTile, s.sel, s.compose], ['ここへは届きません', where.wet.tile, [HOME.p, HOME.q, HOME.tile], null], 'refused on the map; the village stays selected');
  assert.equal(await page.locator('#map-summary').textContent(), 'ここへは届きません');
  // 3. the village again: the next host standing there (the Scout); again: back to the first
  await home();
  assert.equal((await state()).actor, 1);
  await home();
  assert.equal((await state()).actor, 0);
  // 4. the Scout: a sky-blue neighbour is picked for its exploration, and the explore card comes to the map tab
  await home();
  assert.equal((await state()).actor, 1);
  const east = await page.evaluate(async ([p, q, tile]) => { const { tileHex } = await import('/frontier/fgeo.mjs'); const h = tileHex(p, q, tile); return { q: h.q + 1, r: h.r }; }, [HOME.p, HOME.q, HOME.tile]);
  await tapTile(page, east);
  s = await state();
  assert.equal(s.explore?.length, 1, 'one tile picked for the exploration');
  await page.locator('#explore-title').waitFor();
  assert.equal(s.tab, 'map');
  // 5. back to the first host; the camp, a lit tile: the order card, with the destination, in one press (two from nothing)
  await home();
  assert.equal((await state()).actor, 0);
  await tapTile(page, { ...HOME, tile: CAMP_TILE });
  await page.locator('#mc-title').waitFor();
  await page.locator('[data-act="march-send"]:not([disabled])').waitFor({ timeout: 15_000 });
  s = await state();
  assert.deepEqual([s.compose.dest, s.tab], [[HOME.p, HOME.q, CAMP_TILE], 'map'], 'the camp is the destination, composed on the map');
  await page.locator('[data-act="compose-close"]').first().click();
  // 6. Escape on the map lets the selection go
  await page.locator('#frontier-map').focus();
  await page.keyboard.press('Escape');
  assert.equal((await state()).sel, null);
  // 7. the pointer home: hidden while the village is in view; shown with the distance once it is not; a press flies home
  // (rewritten with UX brief §11.3: the camera went east, into the cloud sea, until the village left the picture; the
  // pan now stops where the sea would take a third of the picture, and the village, which stands near the land's
  // eastern edge, never leaves it that way. The camera goes west instead, and the pointer shows on the east side.)
  const pointer = page.locator('[data-map="home-pointer"]');
  assert.equal(await pointer.isHidden(), true);
  for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowLeft');
  await pointer.waitFor({ state: 'visible' });
  assert.match(await pointer.getAttribute('aria-label'), /^自分の村へ移動（\d+ マス先）$/);
  const pb = await pointer.boundingBox();
  assert.ok(pb.width >= 44 && pb.height >= 44, 'a 44-px target');
  assert.ok(pb.x + pb.width / 2 > centre.x, 'on the side the village lies');
  await pointer.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-map="home-pointer"]').hidden, null, { timeout: 5000 });
});

// hud-2 (UX design 8.2, 8.3): the outcome of an action is said at the map, and documents stand over it.
test('a refusal is a toast at the map with "try again"; the report is a wide sheet over the map that a press outside puts away', { timeout: 90_000 }, async t => {
  const page = await open(t, { width: 1440, height: 900, query: `?at=${HOME.p},${HOME.q},${HOME.tile},1.0` });
  const posts = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/f/relay')) posts.push(r.url()); });
  await page.locator('#tabs [data-tab="holding"]').click();
  await page.locator('#panel-body [data-act="harvest"]').click();
  // the fixture relay refuses every write: the refusal stands at the map, not in a box inside the drawer
  const toast = page.locator('#feed .tx-refused[role="alert"]');
  await toast.waitFor();
  assert.equal(await page.locator('#panel-body .notice.error').count(), 0, 'no box in the scrolled panel');
  // the stack makes room for the drawer and the toast slides in (visual only): measured where they come to rest
  await page.evaluate(() => Promise.all(['feed', 'panel'].flatMap(id => { const el = document.getElementById(id); return [el, ...el.querySelectorAll('*')].flatMap(x => x.getAnimations()); }).map(a => a.finished.catch(() => {}))));
  const box = await toast.boundingBox(), drawerBox = await page.locator('#panel').boundingBox();
  assert.ok(box.x + box.width <= drawerBox.x, 'the toast stands over the map, beside the drawer');
  const before = posts.length;
  assert.ok(before >= 1, 'the action was sent once');
  await toast.locator('[data-act="notice-retry"]').click();
  for (let i = 0; i < 50 && posts.length <= before; i++) await page.waitForTimeout(100);
  assert.ok(posts.length > before, '"try again" sends the same action once more');
  await page.locator('#feed .tx-refused [data-act="notice-close"]').click();
  await page.locator('#feed .tx-refused:not(.leaving)').waitFor({ state: 'detached' });
  // the report: a wide document, centred, with the outcome stamp and the two sides face to face
  await page.locator('#tabs [data-tab="marches"]').click();
  await page.locator('#panel-body [data-act="report-open"]').first().click();
  await page.locator('#panel[data-doc="wide"] #report-title').waitFor();
  await page.locator('#panel .stamp').waitFor();
  await page.locator('#panel').evaluate(el => Promise.all(el.getAnimations().map(x => x.finished.catch(() => {}))));
  const doc = await page.locator('#panel').boundingBox();
  assert.ok(doc.width >= 700, `a wide sheet: ${Math.round(doc.width)} px`);
  assert.ok(Math.abs(doc.x + doc.width / 2 - 720) <= 2, 'centred over the map');
  assert.equal(await page.locator('#panel .vs-side').count(), 2);
  assert.equal(await page.evaluate(() => document.body.dataset.doc), 'wide');
  // a press on the dimmed map behind it puts it away, and selects nothing
  await page.mouse.click(120, 700);
  assert.equal(await drawer(page), 'closed');
  assert.equal(await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return [FS.report, FS.selected]; }).then(JSON.stringify), '[null,null]');
});

// hud-2 (UX design 7.2): joining is choosing one of six standing banners; the map is told which nation is looked at.
test('the nation choice: six banners along the foot of the map, one choice, one confirm; the map hears which nation is looked at', { timeout: 60_000 }, async t => {
  const page = await open(t, { width: 1440, height: 900, stage: 'none' });
  await page.locator('#panel[data-doc="stage"] .banner-pick').first().waitFor();
  assert.equal(await page.locator('.banner-pick').count(), 6);
  await page.locator('#panel').evaluate(el => Promise.all(el.getAnimations().map(x => x.finished.catch(() => {}))));
  // (wave 2, UX design 11.9: it asked for the upper 35%; the heading and the banners now keep to the lower half)
  const stage = await page.locator('#panel').boundingBox(), head = await page.locator('.nations-head').boundingBox();
  assert.ok(Math.min(stage.y, head.y) >= 900 / 2 - 1, `the heading and the banners keep to the lower half of the screen (top at ${Math.round(Math.min(stage.y, head.y))})`);
  // no creed is cut: nothing in the stage is clamped or ends in an ellipsis
  const cut = await page.evaluate(() => [...document.querySelectorAll('.nations *')].filter(el => { const s = getComputedStyle(el); return s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none'); }).length);
  assert.equal(cut, 0, 'no clamped text in the nation choice');
  assert.equal(await page.locator('[data-act="join"]').isDisabled(), true, 'nothing to confirm yet');
  await page.evaluate(() => { window.__nation = []; addEventListener('wylls:nation-focus', e => window.__nation.push(e.detail.faction)); });
  await page.locator('[data-nation="1"]').hover();
  await page.locator('[data-nation="3"]').focus();
  await page.locator('[data-nation="2"]').click();
  assert.deepEqual(await page.evaluate(() => window.__nation), [1, 3, 2], 'hover, focus and choice each name the nation');
  // the keyboard's place is shown by the banner itself (a brass pointer over it, its rim), not by a web outline
  const focus = await page.locator('[data-nation="3"]').evaluate(el => { el.focus(); const s = getComputedStyle(el), a = getComputedStyle(el, '::after'); return { outline: s.outlineColor, mark: a.content, h: parseFloat(a.height) }; });
  assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(focus.outline), `no visible web outline on a banner: ${focus.outline}`);
  assert.equal(await page.locator('[data-nation="2"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.banner-pick[aria-pressed="true"]').count(), 1);
  // the chosen banner: lifted, marked, and the confirm line says its leader and creed in full
  assert.equal(await page.locator('.banner-pick[aria-pressed="true"] .bn-mark').count(), 1);
  await page.mouse.move(700, 200);
  assert.match(await page.locator('.nc-item:visible .nc-pitch').textContent(), /突撃歩兵/);
  assert.equal(await page.locator('[data-act="join"]').isDisabled(), false, 'one confirm');
  assert.equal(await page.locator('[data-act="pick-province"], [data-act="toggle-site"], [data-act="file-ticket"]').count(), 0, 'no site picker');
});

// ------------------------------------------------------------------ the tilted board (UX brief §4, §11.1)
// The ground lies in #map-stage under one CSS transform; the map knows the same transform in numbers (map/tilt.mjs).
// These tests hold the two together in a real browser: the canvas is where the numbers say, and every input (a tap,
// a hover, a drag, the wheel, the keys, a press on the minimap, a pinch) lands on the tile that is seen there.
const mapCall = (page, body, arg) => page.evaluate(`(async (arg) => { const m = window.__map; ${body} })(${JSON.stringify(arg ?? null)})`);

test('the tilted board: the ground canvas is where the numbers say; a tap, a hover, a drag, the wheel, the keys and the minimap land on what is seen', { timeout: 120_000 }, async t => {
  const page = await open(t, { width: 1440, height: 900, query: `?at=${HOME.p},${HOME.q},${HOME.tile},1.3` });
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  assert.equal(await mapOf(page), true, 'the page has a map');
  // the angle: the constant of map/tilt.mjs at the near view, on the stage as a custom property and as a real transform
  const tilt = await page.evaluate(async () => {
    const { TILT } = await import('/frontier/map/tilt.mjs');
    const stage = document.getElementById('map-stage'), cv = document.getElementById('frontier-map');
    return { deg: TILT.deg, mark: cv.dataset.tilt, prop: stage.style.getPropertyValue('--map-tilt'), transform: getComputedStyle(stage).transform, inline: stage.getAttribute('style') ?? '', overlay: getComputedStyle(cv).transform };
  });
  assert.equal(Number(tilt.mark), tilt.deg);
  assert.equal(tilt.prop, `${tilt.deg.toFixed(2)}deg`, 'one custom property carries the angle');
  assert.match(tilt.transform, /^matrix3d\(/, 'the stage is really tilted');
  assert.equal(tilt.overlay, 'none', 'the canvas that takes the input and carries the labels lies flat');
  // the browser's own geometry against the map's numbers: the tilted ground canvas's box on screen is the box of
  // its four corners as the map projects them
  const boxes = await mapCall(page, `
    const g = m.groundLayout(), r = document.getElementById('map-ground').getBoundingClientRect(), c = m.canvas.getBoundingClientRect(), geo = m.geo();
    const pts = [[g.left, g.top], [g.left + g.width, g.top], [g.left + g.width, g.top + g.height], [g.left, g.top + g.height]].map(([x, y]) => geo.toBox(x, y));
    const xs = pts.map(p => p.x + c.left), ys = pts.map(p => p.y + c.top);
    return { dom: [r.left, r.top, r.right, r.bottom], math: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], view: [c.width, c.height] };`);
  boxes.dom.forEach((v, i) => assert.ok(Math.abs(v - boxes.math[i]) < 0.75, `the ground canvas's box, side ${i}: the browser says ${v.toFixed(2)}, the map ${boxes.math[i].toFixed(2)}`));
  assert.ok(boxes.dom[0] <= 0.5 && boxes.dom[1] <= 0.5 && boxes.dom[2] >= boxes.view[0] - 0.5, 'and it covers the picture (the far corners too)');
  // a tap: on tiles all over the picture, each where the map says it is seen
  const tiles = await mapCall(page, `
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const h = tileHex(arg.p, arg.q, arg.tile), out = [];
    for (const [dq, dr] of [[0, 0], [2, -4], [-5, -3], [4, 3], [-3, 4], [6, -5], [-6, 1]]) {
      const w = project(h.q + dq, h.r + dr), c = m.project(w.x, w.y), flat = { x: (w.x - m.view.x) * m.view.zoom + m.canvas.clientWidth / 2, y: (w.y - m.view.y) * m.view.zoom + m.canvas.clientHeight / 2 };
      out.push({ q: h.q + dq, r: h.r + dr, x: c.x, y: c.y, off: Math.hypot(c.x - flat.x, c.y - flat.y) });
    }
    return out;`, HOME);
  assert.ok(Math.max(...tiles.map(x => x.off)) > 30, 'far from the middle a tile is seen tens of px from its flat place: the mapping matters');
  const selected = () => page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); const { tileHex } = await import('/frontier/fgeo.mjs'); const s = FS.selected; if (!s || !Number.isInteger(s.idx)) return null; const h = tileHex(s.p, s.q, s.idx); return [h.q, h.r]; });
  for (const x of tiles.slice(1)) {
    if (x.x < 330 || x.x > 1100 || x.y < 120 || x.y > 640) continue;   // (under the HUD's corners: not a press on the map)
    await page.locator('#frontier-map').focus(); await page.keyboard.press('Escape');
    await page.mouse.click(x.x, x.y);
    assert.deepEqual(await selected(), [x.q, x.r], `a tap at ${Math.round(x.x)}, ${Math.round(x.y)} selects the tile seen there`);
  }
  await page.keyboard.press('Escape');
  // a hover: the tile under the mouse is the tile seen there
  const far = tiles[2];
  await page.mouse.move(far.x, far.y);
  await page.waitForTimeout(60);
  assert.deepEqual(await mapCall(page, 'return m.hover ? [m.hover.q, m.hover.r] : null;'), [far.q, far.r]);
  // a drag: the land follows the pointer (the point of the world under it at the press is under it at the release)
  const A = { x: 560, y: 300 }, B = { x: 760, y: 520 };
  const under = await mapCall(page, 'return m.unproject(arg.x, arg.y);', A);
  await page.mouse.move(A.x, A.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(A.x + (B.x - A.x) * i / 10, A.y + (B.y - A.y) * i / 10); await page.waitForTimeout(16); }
  await page.waitForTimeout(220);   // (held still before the release: no glide)
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await mapCall(page, 'return m.project(arg.x, arg.y);', under);
  assert.ok(Math.hypot(after.x - B.x, after.y - B.y) < 2.5, `after the drag the same land is under the pointer (${after.x.toFixed(1)}, ${after.y.toFixed(1)})`);
  // the wheel: the point under the pointer stays under it, out through the zooms where the board's angle changes, and back
  // (over the middle of the world, where the pan's limit stays out of it: near the land's edge a zoom out lets the land slide in)
  await mapCall(page, 'm.setView({ x: 0, y: 0, zoom: 1.3 }); return true;');
  await page.waitForTimeout(120);
  const P = { x: 770, y: 420 };
  await page.mouse.move(P.x, P.y);
  let turned = 0;
  for (const dy of [420, 420, -300, -300, -300]) {
    const w = await mapCall(page, 'return { ...m.unproject(arg.x, arg.y, { logical: true }), deg: m.tiltDeg(m.view.zoom) };', P);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(200);
    await page.waitForFunction(() => !window.__map.cam.moving, null, { timeout: 5000 });
    const now = await mapCall(page, 'return { ...m.project(arg.x, arg.y), deg: m.tiltDeg(m.view.zoom), zoom: m.view.zoom, moving: m.cam.moving };', w);
    assert.equal(now.moving, false);
    assert.ok(Math.hypot(now.x - P.x, now.y - P.y) < 1.5, `wheel ${dy}: the point under the pointer stayed (off by ${Math.hypot(now.x - P.x, now.y - P.y).toFixed(2)} px at zoom ${now.zoom.toFixed(2)}, the board at ${now.deg.toFixed(1)}°, was ${w.deg.toFixed(1)}°)`);
    if (Math.abs(now.deg - w.deg) > 2) turned++;
  }
  assert.ok(turned >= 2, 'the board\'s angle did change on the way out and back');
  // the keys: an arrow moves the land by 80 px of the flat picture; H brings the village to the middle of the free part, as it is seen
  await page.locator('#frontier-map').focus();
  const v0 = await mapCall(page, 'return { ...m.view };');
  await page.keyboard.press('ArrowLeft');
  const v1 = await mapCall(page, 'return { ...m.view };');
  assert.ok(Math.abs((v0.x - v1.x) * v0.zoom - 80) < 1e-6 && v1.y === v0.y);
  await page.keyboard.press('h');
  await page.waitForTimeout(200);
  await page.waitForFunction(() => !window.__map.cam.moving, null, { timeout: 8000 });
  const home = await mapCall(page, `
    const { tileHex } = await import('/frontier/fgeo.mjs'); const { project } = await import('/map.mjs'); const { freeBox } = await import('/frontier/map/camera.mjs'); const { SEAT_DROP } = await import('/frontier/map/fmap.mjs');
    const h = tileHex(arg.p, arg.q, arg.tile), w = project(h.q, h.r), s = m.size(), f = freeBox(s, m.inset());
    return { seen: m.project(w.x, w.y, { box: true }), want: { x: s.width / 2 + f.x, y: s.height / 2 + f.y + SEAT_DROP * f.height } };`, HOME);
  // (the seat's frame, UX design 12.1: a little below the middle of what the HUD leaves free)
  assert.ok(Math.hypot(home.seen.x - home.want.x, home.seen.y - home.want.y) < 1, 'H: the village at the seat\'s place in what the HUD leaves free');
  // Enter picks the tile in the middle of the canvas (the board turns about that point: it is the view's own)
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  const mid = await mapCall(page, `const { inverseHex } = await import('/map.mjs'); const w = m.unproject(m.canvas.clientWidth / 2, m.canvas.clientHeight / 2, { box: true }); return inverseHex(w.x, w.y).split(',').map(Number);`);
  assert.deepEqual(await selected(), mid);
  await page.keyboard.press('Escape');
  // the minimap: a press flies the middle of the picture to that place; its frame is the four corners of the picture
  // (the drawer has just closed: the minimap slides back to its corner first)
  await page.waitForFunction(() => document.body.dataset.drawer === 'closed');
  let mini = await page.locator('#minimap-canvas').boundingBox();
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(120); const next = await page.locator('#minimap-canvas').boundingBox(); const still = Math.abs(next.x - mini.x) < 0.01 && Math.abs(next.y - mini.y) < 0.01; mini = next; if (still && i > 1) break; }
  const press = { x: mini.x + mini.width * 0.42, y: mini.y + mini.height * 0.56 };
  const want = await page.evaluate(async ([px, py]) => {
    const { frameOf } = await import('/frontier/hud/minimap.mjs'); const { FS } = await import('/frontier/fstate.mjs');
    const r = document.getElementById('minimap-canvas').getBoundingClientRect();
    return frameOf(Math.max(1, FS.record?.rings?.length ?? 1) + 1, r.width).toWorld(px - r.left, py - r.top);
  }, [press.x, press.y]);
  await page.mouse.click(press.x, press.y);
  await page.waitForTimeout(200);
  await page.waitForFunction(() => !window.__map.cam.moving, null, { timeout: 8000 });
  const got = await mapCall(page, 'return { at: m.unproject(m.canvas.clientWidth / 2, m.canvas.clientHeight / 2, { box: true }), view: { ...m.view }, quad: m.viewQuad() };');
  // (the camera goes there unless the pan's limit holds it back: the press was made well inside the land)
  assert.ok(Math.hypot(got.at.x - want.x, got.at.y - want.y) < 2, `the middle of the picture is the place pressed (${Math.hypot(got.at.x - want.x, got.at.y - want.y).toFixed(2)} world px away)`);
  assert.ok(got.quad[1].x - got.quad[0].x > got.quad[2].x - got.quad[3].x + 50, 'the frame the minimap draws is a trapezoid: more of the world along the far edge');
  // out at the far view the board lies flat, and a tap still lands
  await page.locator('#frontier-map').focus();
  await page.keyboard.press('m');
  await page.waitForFunction(() => document.getElementById('frontier-map').dataset.tilt === '0.00', null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.getElementById('map-stage').style.getPropertyValue('--map-tilt')), '0.00deg');
});

test('the flat fallback: ?tilt=0 has no transform, no overscan, and taps land as they always did', { timeout: 60_000 }, async t => {
  const page = await open(t, { width: 1440, height: 900, query: `?at=${HOME.p},${HOME.q},${HOME.tile},1.3&tilt=0` });
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  assert.equal(await mapOf(page), true);
  const flat = await page.evaluate(() => {
    const stage = document.getElementById('map-stage'), g = document.getElementById('map-ground').getBoundingClientRect(), c = document.getElementById('frontier-map');
    return { transform: getComputedStyle(stage).transform, flag: stage.hasAttribute('data-flat'), ground: [g.left, g.top, g.width, g.height], canvas: [c.clientWidth, c.clientHeight], mark: c.dataset.tilt, haze: getComputedStyle(document.getElementById('map-dress'), '::before').opacity };
  });
  assert.equal(flat.transform, 'none');
  assert.equal(flat.flag, true);
  assert.deepEqual(flat.ground, [0, 0, ...flat.canvas], 'the ground canvas is the map\'s own box');
  assert.equal(flat.mark, '0.00');
  assert.equal(Number(flat.haze), 0, 'no haze without a far edge');
  const x = await mapCall(page, `
    const { tileHex } = await import('/frontier/fgeo.mjs'); const { project } = await import('/map.mjs');
    const h = tileHex(arg.p, arg.q, arg.tile), w = project(h.q + 3, h.r - 4), c = m.project(w.x, w.y);
    return { q: h.q + 3, r: h.r - 4, x: c.x, y: c.y, flat: { x: (w.x - m.view.x) * m.view.zoom + 720, y: (w.y - m.view.y) * m.view.zoom + 450 } };`, HOME);
  assert.ok(Math.abs(x.x - x.flat.x) < 1e-6 && Math.abs(x.y - x.flat.y) < 1e-6, 'project is the flat formula');
  await page.mouse.click(x.x, x.y);
  const sel = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); const { tileHex } = await import('/frontier/fgeo.mjs'); const h = tileHex(FS.selected.p, FS.selected.q, FS.selected.idx); return [h.q, h.r]; });
  assert.deepEqual(sel, [x.q, x.r]);
});

test('a pinch on a phone zooms about the point between the fingers, on the tilted board', { timeout: 60_000 }, async t => {
  const page = await open(t, { query: `?at=${HOME.p},${HOME.q},${HOME.tile},0.9` });
  await page.locator('#frontier-map[data-lod="tile"]').waitFor();
  assert.equal(await mapOf(page), true);
  await page.waitForTimeout(300);
  const cdp = await page.context().newCDPSession(page);
  const mid = { x: 190, y: 260 };
  const before = await mapCall(page, 'return { w: m.unproject(arg.x, arg.y, { logical: true }), zoom: m.view.zoom, deg: m.tiltDeg(m.view.zoom) };', mid);
  assert.ok(before.deg > 10, 'tilted');
  const touch = (type, gap) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: mid.x - gap, y: mid.y - gap * 0.4, id: 1 }, { x: mid.x + gap, y: mid.y + gap * 0.4, id: 2 }] });
  await touch('touchStart', 40);
  for (const gap of [46, 54, 62, 70, 80]) { await touch('touchMove', gap); await page.waitForTimeout(30); }
  await touch('touchEnd');
  await page.waitForTimeout(500);
  const after = await mapCall(page, 'return { at: m.project(arg.x, arg.y, { logical: true }), zoom: m.view.zoom };', before.w);
  assert.ok(after.zoom > before.zoom * 1.5 && after.zoom < before.zoom * 2.4, `the fingers went from 80 to 160 px apart: zoom ${before.zoom} to ${after.zoom.toFixed(3)}`);
  assert.ok(Math.hypot(after.at.x - mid.x, after.at.y - mid.y) < 6, `the land between the fingers stayed between them (off by ${Math.hypot(after.at.x - mid.x, after.at.y - mid.y).toFixed(2)} px)`);
});
