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
import { storageFor, LATEST_UNIX, HOME, CAMP_TILE, HOSTS } from './world.mjs';

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
  // (the page is ready when the dial counts AND the viewer's record has answered: since wave 3 the dial counts while
  // the play page still says `data-stage="loading"`, and the layout settles a moment later; a press aimed at a box
  // measured in between missed, e.g. the sheet's handle)
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
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
  assert.deepEqual(await page.locator('.lens-list .lens:visible .lens-text').allTextContents(), ['国の色', '軍事', '地形', '空き地', '地図の見かた']);
  await page.locator('.lens[data-lens="war"]').click();
  assert.equal(await page.locator('.lens-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.lens-list').isVisible(), false);
  assert.equal(await page.locator('.lens[data-lens="war"]').getAttribute('aria-pressed'), 'true');
  // (fix pass 2: the strip no longer scrolls sideways, it ended in half an icon at the plaque's point) the most
  // pressing resources stand whole, the last carries how many more there are, and a press opens them all
  // (on a phone: a list mark and the count, never a bare 「+N」 beside a stock, 07-HUD-TEXT-FX)
  const strip = await page.locator('#res-strip').evaluate(el => ({ n: el.querySelectorAll('[data-res]').length, cut: el.scrollWidth > el.clientWidth + 1, more: el.querySelector('.res:last-child .res-more-n')?.innerText.trim() ?? '', mark: !!el.querySelector('.res:last-child .res-more-s .res-more-ic'), all: [...el.querySelectorAll('[data-res]')].every(b => b.dataset.r === '*') }));
  assert.ok(strip.n >= 1 && strip.n <= 2 && !strip.cut, `the strip holds ${strip.n} resources, none cut: ${!strip.cut}`);
  assert.match(strip.more, /^\d+$/, 'the last token says how many more there are');
  assert.ok(strip.mark, 'beside a list mark');
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
// Rewritten with the board-first hand (UX design 14.2): the village's tile selected the inspector, whose "march this
// host" button was the first of three presses; now the village has the action bar, its host is chosen by its chip
// there (the selection, not counted), and with the host in hand the board is armed: the destination tile, then the seal.
test('step counts: a selected host to "seal and depart" in 2 presses; the next to-do in 1', { timeout: 90_000 }, async t => {
  // 1.0 (it was 1.4): the drawer stands over the right 400 px of the map now, and the camp tile must stay left of it
  const Z = 1.0;
  // the camera on the viewer's home tile, where the fixture's ready host stands (?at=P,Q,TILE,ZOOM)
  const page = await open(t, { width: 1440, height: 900, query: `?at=${HOME.p},${HOME.q},${HOME.tile},${Z}` });
  await page.locator('#frontier-map[data-lod="tile"]').waitFor();
  // the host selected: a press on its tile (the selection itself is not counted)
  // (rewritten with UX brief §11.7: the presses were aimed at fixed places on the screen; a selection now eases the
  // camera out to the lit reach, so each press is aimed at its tile where the map shows it: tapTile)
  await tapTile(page, HOME);
  await page.locator('#hand [data-hand="build"]').waitFor();
  await page.locator('#hand .hand-chip[data-host]:not(.hand-back)').first().click();
  await page.locator('#hand [data-hand="march"][aria-pressed="true"]').waitFor();
  let presses = 0;
  presses++; await tapTile(page, { ...HOME, tile: CAMP_TILE });
  await page.locator('#mc-title').waitFor();
  const send = page.locator('[data-act="march-send"]:not([disabled])');
  await send.waitFor({ timeout: 15_000 });
  presses++;
  assert.equal(presses, 2, 'the destination tile, seal and depart');
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
// Rewritten with the board-first hand (UX design 14.2): the village's tile gives the village the action bar and
// lights nothing; a host standing there takes the hand by a second tap on the tile (or its chip in the bar), and
// THEN its reach is lit. The same tile again goes on: the village, each host, the village. What a tap means with a
// host in hand is unchanged, and a refusal now names the rule (mountains and water).
test('the land: lit tiles when a host has the hand, a tap is the order, a refusal on the map with its rule, the pointer home', { timeout: 90_000 }, async t => {
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
    const { subjectOf } = await import('/frontier/hud/hand.mjs');
    const sub = subjectOf(FS);
    return { sel: FS.selected ? [FS.selected.p, FS.selected.q, FS.selected.idx] : null, who: sub ? (sub.kind === 'village' ? 'village' : sub.host.unit) : null, lit: !!window.__map?.source?.().actions, note: FS.mapNote?.text ?? null, noteTile: FS.mapNote?.tile ?? null,
      compose: FS.compose ? { host: String(FS.compose.host.id), dest: FS.compose.dest ? [FS.compose.dest.p, FS.compose.dest.q, FS.compose.dest.tile] : null } : null, explore: FS.explore ? [...FS.explore.tiles] : null, tab: FS.tab ?? 'map' };
  });
  // 1. the village: selected, nothing composed yet
  await home();
  let s = await state();
  assert.deepEqual([s.sel, s.who, s.compose], [[HOME.p, HOME.q, HOME.tile], 'village', null], 'the village has the hand; selecting composes nothing');
  await mapOf(page);
  assert.equal((await state()).lit, false, 'nothing is lit for a village');
  assert.equal(await page.locator('#hand').isVisible(), true);
  assert.equal(await drawer(page), 'closed', 'the action bar, not a drawer');
  // 1a. the tile again: the host standing there takes the hand (the spearmen: the one that can march, with most troops)
  await home();
  assert.equal((await state()).who, 0);
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
  s = await state();
  assert.deepEqual([s.note, s.noteTile, s.sel, s.who, s.compose], ['山や水のマスには進めません', where.wet.tile, [HOME.p, HOME.q, HOME.tile], 0, null], 'refused on the map with the rule; the host stays in hand');
  assert.equal(await page.locator('#map-summary').textContent(), '山や水のマスには進めません');
  // 3. the tile again: the next host standing there (the Scout); again: the village; again: the first host
  await home();
  assert.equal((await state()).who, 6);
  await home();
  assert.equal((await state()).who, 'village');
  await home();
  assert.equal((await state()).who, 0);
  // 4. the Scout: a sky-blue neighbour is picked for its exploration, and the explore card stands above the bar
  await home();
  assert.equal((await state()).who, 6);
  const east = await page.evaluate(async ([p, q, tile]) => { const { tileHex } = await import('/frontier/fgeo.mjs'); const h = tileHex(p, q, tile); return { q: h.q + 1, r: h.r }; }, [HOME.p, HOME.q, HOME.tile]);
  await tapTile(page, east);
  s = await state();
  assert.equal(s.explore?.length, 1, 'one tile picked for the exploration');
  await page.locator('#hand-pop[data-pop="explore"] [data-act="explore-send"]').waitFor();
  assert.equal(await page.locator('#hand-pop .hand-chip.picked').count(), 1, 'the picked tile is named in the card');
  assert.deepEqual([s.tab, await drawer(page)], ['map', 'closed']);
  // 5. back to the first host (through the village); the camp, a lit tile: the order card, with the destination, in one press
  await home();
  await home();
  assert.equal((await state()).who, 0);
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
  // (run in a browser at the integration of 2026-10-11: on a season with an immediate first village — the fixture's — the
  // one confirm is 「…で始める」 `home-confirm`, which joins and places the village; `join` is the older season's button)
  const confirm = page.locator('[data-act="join"], [data-act="home-confirm"]');
  assert.equal(await confirm.count(), 1, 'one confirm on the plate');
  assert.equal(await confirm.isDisabled(), true, 'nothing to confirm yet');
  await page.evaluate(() => { window.__nation = []; addEventListener('wylls:nation-focus', e => window.__nation.push(e.detail.faction)); });
  await page.locator('[data-nation="1"]').hover();
  await page.locator('[data-nation="3"]').focus();
  await page.locator('[data-nation="2"]').click();
  assert.deepEqual(await page.evaluate(() => window.__nation), [1, 3, 2], 'hover, focus and choice each name the nation');
  // the keyboard's place is shown by the banner itself (a brass pointer over it, its rim), not by a web outline
  // (the banner is found and read in one step in the page: the plate is drawn again a moment after a choice — the fee and
  // the pool arrive — and a handle taken before that was a banner no longer on the page, whose style read as nothing)
  await page.waitForFunction(() => document.querySelector('[data-act="join"], [data-act="home-confirm"]')?.disabled === false);
  const focus = await page.evaluate(() => { const el = document.querySelector('[data-nation="3"]'); el.focus(); const s = getComputedStyle(el), a = getComputedStyle(el, '::after'); return { outline: s.outlineColor, mark: a.content, h: parseFloat(a.height) }; });
  assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(focus.outline), `no visible web outline on a banner: ${focus.outline}`);
  assert.equal(await page.locator('[data-nation="2"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.banner-pick[aria-pressed="true"]').count(), 1);
  // the chosen banner: lifted, marked, and the confirm line says its leader and creed in full
  assert.equal(await page.locator('.banner-pick[aria-pressed="true"] .bn-mark').count(), 1);
  await page.mouse.move(700, 200);
  assert.match(await page.locator('.nc-item:visible .nc-pitch').textContent(), /突撃歩兵/);
  assert.equal(await confirm.isDisabled(), false, 'one confirm');
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

// ------------------------------------------------------------------ the real pipeline on the sample world (UX design 12.4, 14.5)
// `srv.live(true)` (liveworld.mjs): a sample world that keeps going under the M1 rules. Its clock runs from the page's
// first /h/season (a turn every `turn` wall seconds, the whole game clock scaled with it), its relay takes every order
// a village owner has and refuses what the program refuses, and what the turns resolve comes back in the herald's own
// shapes. No demo switch: the page's own triggers play (the toll, the turn's results in order, the battle from the
// clash report, the building, the accepted and the refused answer), in real time.
//
// Two stand-ins for what the page does not do by itself yet on a sample world's clock (hooks for the hand; each is
// one call, never an order):
//   sync()  the page estimates a localnet clock's rate from two /h/season samples and takes the second 30 s after
//           load; the season record says the rate (`sample.rate`), and sync() gives it to the page's clock.
//   poll()  the page reads its own data every 10 or 30 s; a sample turn is shorter, so poll() calls the
//           controller's own refresh() (as the page's timer would).
async function openLive(t, { width = 1440, height = 900, stage = 'holding', ...opts } = {}) {
  srv.stage(stage);
  const world = srv.live(true, { landMs: 500, ...opts });
  t.after(() => srv.live(false));
  const phone = width < 760;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
  t.after(() => context.close());
  // (with the march book of this device: the page knows where the viewer's sealed march went)
  await context.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storageFor(srv.viewer, { stage, lang: 'ja', live: true }));
  const page = await context.newPage();
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('request', r => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
  await page.goto(`${srv.url}/frontier/index.html`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
  const sync = () => page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); const r = await (await fetch('/h/season')).json(); FS.chain.observe(r.latestUnix, r.latestSlot); FS.chain.rate = r.sample.rate; });
  const poll = () => page.evaluate(async () => { const c = await import('/frontier/controller.mjs'); await c.refresh(); });
  await sync();
  // every event of the effects bus, in order, with what the assertions below read of it
  await page.evaluate(async () => {
    const { on } = await import('/frontier/fx/bus.mjs');
    window.__ev = [];
    on('*', (p, type) => window.__ev.push({ type, at: performance.now(), name: p?.name ?? null, kind: p?.kind ?? null, turn: p?.turn ?? null, focus: p?.focus ?? null,
      tile: p?.tile && typeof p.tile === 'object' ? p.tile.tile : p?.tile ?? null, fresh: Array.isArray(p?.fresh) ? p.fresh.map(x => [String(x.id).split(':')[0], x.tile ?? null, !!x.plays]) : null, points: Array.isArray(p?.points) ? p.points.length : null,
      scene: p?.play?.scene ? { p: p.play.scene.p, q: p.play.scene.q, bell: p.play.scene.bell, tiles: (p.play.scene.tiles ?? []).map(x => x.idx) } : null }));
  });
  t.after(() => assert.deepEqual(errors, [], 'no page error, console error or failed request'));
  const events = (type = null) => page.evaluate(ty => window.__ev.filter(e => !ty || e.type === ty), type);
  const until = async (type, pred = () => true, ms = 30_000) => { const t0 = Date.now(); for (;;) { const e = (await events(type)).find(pred); if (e) return e; if (Date.now() - t0 > ms) throw new Error(`no ${type} event within ${ms} ms`); await page.waitForTimeout(40); } };
  /** Press one of the drawer's own controls: brought into the middle of the scrolling panel first (it re-renders every second). */
  const press = async sel => { const l = page.locator(sel).first(); await l.waitFor({ state: 'attached' }); for (let i = 0; ; i++) { try { await l.evaluate(el => el.scrollIntoView({ block: 'center' })); await l.click({ timeout: 2000 }); return; } catch (e) { if (i >= 5) throw e; await page.waitForTimeout(150); } } };
  /** Wait until a function of the page's store answers true (an async function: the store is a module of the page). */
  const store = async (fn, ms = 20_000) => { const t0 = Date.now(); for (;;) { if (await page.evaluate(`(async () => { const { FS } = await import('/frontier/fstate.mjs'); return !!(${fn})(FS); })()`)) return; if (Date.now() - t0 > ms) throw new Error(`the page's store never showed: ${fn}`); await page.waitForTimeout(80); } };
  /** Wait for the world's turn `b`, `into` game seconds in (75: the province has caught up, the turn before last is resolved), then let the page read it. */
  const turn = async (b, into = 75) => { const at = world.tollAt + 600 * (b - 43) + into; while (world.now() < at) await page.waitForTimeout(Math.min(200, Math.max(15, ((at - world.now()) / world.rate) * 1000))); await poll(); };
  /** The hosts the board drew in its last picture: `[{p, q, tile, hosts: [id], faction, troops, status, own}]` (map/sprites.mjs keeps them). */
  const tokens = () => page.evaluate(() => (globalThis.__wyllsMap?.art?.tokens ?? []).map(x => ({ p: x.p, q: x.q, tile: x.tile, hosts: x.hosts, faction: x.faction, troops: x.troops, status: x.status ?? null, own: !!x.own })));
  /** The token of host `id` once the board draws it (and `ok(token)` holds), or the last one seen. */
  const drawn = async (id, ok = () => true, ms = 8_000) => { const t0 = Date.now(); for (;;) { const k = (await tokens()).find(x => x.hosts.includes(String(id))) ?? null; if ((k && ok(k)) || Date.now() - t0 > ms) return k; await page.waitForTimeout(100); } };
  return { page, world, posts, events, until, press, store, sync, poll, turn, tokens, drawn };
}
/**
 * Seal the order on the card as a player does, on a clock that runs fast: `presses` it took.
 * Rewritten 2026-10-11 (it was one press and a wait for `march:sealed`; that expectation was wrong on a fast clock).
 * In a turn's last seconds the earliest arrival turn moves on (fmarch.mjs `departMargin`); the card follows it and
 * says so, and a press in the very moment of the change is refused by the page before anything is sealed, or is lost
 * when the card is drawn again under it. With a turn of 5 or 8 s on a busy machine the press landed there now and
 * then (logged: nothing reached the world, the page said 「そのターンには着けません」 and offered the next turn), and
 * the test then waited a minute for a seal nobody had asked for again. Now the test does what the card offers:
 * it checks that the refusal was the page's own, that the card says the order was not sent and names a later turn,
 * and presses the seal again. What reaches the world is asserted by the caller: one Depart, accepted.
 * `{presses, named}`: `named` is what the card said at the press that sealed (`cardTurn`).
 */
/** The order card's arrival turn as the page holds it and as the card says it, and its note of a turn that moved. */
const cardTurn = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  const c = FS.compose, num = s => { const m = /ターン\s*([\d,]+)/.exec(s ?? ''); return m ? Number(m[1].replace(/,/g, '')) : null; };
  return { arrive: c?.arriveBell ?? null, shown: num(document.querySelector('.mc-bell-v')?.textContent), moved: c?.moved ?? null, note: document.querySelector('.mc-moved')?.textContent ?? '' };
});
/**
 * The card is left open until the next turn has begun and its province has caught up (added 2026-10-11): the card
 * follows the clock — it names a turn that can still be reached, the same in its words and in what it will seal,
 * and where that turn moved it says from which turn — and the seal is then pressed with a whole turn ahead (a press
 * in a turn's last second is the page's and the world's to refuse; on a turn of 5 or 8 s that second came often).
 */
async function sealNextTurn(live) {
  const { page, world, turn } = live;
  const before = await cardTurn(page);
  assert.equal(before.shown, before.arrive, 'the card says the turn it will seal');
  await turn(world.turn() + 1);
  await page.locator('[data-act="march-send"]:not([disabled])').first().waitFor({ timeout: 30_000 });
  const after = await cardTurn(page);
  assert.equal(after.shown, after.arrive, 'after the toll the card still says the turn it will seal');
  assert.ok(after.arrive >= world.turn() + 2 && after.arrive >= before.arrive, `the turn it names can be reached: ${JSON.stringify(after)} in turn ${world.turn()}`);
  if (after.arrive !== before.arrive) {
    assert.deepEqual([after.moved?.to, after.moved?.from <= before.arrive], [after.arrive, true], 'the card holds where its turn moved from');
    assert.match(after.note, new RegExp(`到着はターン ${after.arrive} になりました`), 'and says so where the turn is named');
  }
  return sealOnCard(live);
}
async function sealOnCard({ page, world, press, events }, ms = 60_000) {
  const departs = async type => (await events(type)).filter(e => e.name === 'Depart').length;
  const t0 = Date.now();
  for (let presses = 1; ; presses++) {
    assert.ok(presses <= 4, 'the card offers its seal again a few times at the most');
    const busy0 = await departs('action:busy'), refused0 = await departs('action:refused'), pressed = Date.now();
    await page.locator('[data-act="march-send"]:not([disabled])').first().waitFor({ timeout: 30_000 });
    const named = await cardTurn(page);
    await press('[data-act="march-send"]:not([disabled])');
    for (;;) {
      if ((await events('march:sealed')).length) return { presses, named };
      if (Date.now() - t0 > ms) throw new Error(`no march:sealed event within ${ms} ms`);
      if (await departs('action:refused') > refused0) {
        assert.deepEqual(world.orders.filter(o => o.name === 'Depart' && !o.ok), [], 'refused by the page before sealing: the world was asked nothing it refused');
        const offer = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return { moved: FS.compose?.moved ?? null, unsent: !!document.querySelector('.order-unsent'), note: document.querySelector('.mc-moved')?.textContent ?? '' }; });
        assert.ok(offer.unsent, 'the card says the order was not sent');
        assert.ok(offer.moved && offer.moved.to > offer.moved.from && /ターン/.test(offer.note), `the card names the later turn it now offers: ${JSON.stringify(offer)}`);
        break;
      }
      // (no order was asked for: the card was drawn again under the press)
      if (await departs('action:busy') === busy0 && Date.now() - pressed > 3000) break;
      await page.waitForTimeout(40);
    }
  }
}
const strip = (page, res) => page.locator(`#res-strip [data-res="${res}"] .res-val`).first().textContent().then(s => Number(String(s).replace(/[^\d]/g, '')));
const mine = world => world.summary().me;

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`the real turn @ ${vp.width}: the toll's banner; then what the turn resolved, in order: the march at the camp unsealed and its battle played once from the clash report; the host stands on the camp's tile; the building`, { timeout: 120_000 }, async t => {
    // (a turn every 20 s, the first toll 4 s after load: the world's defaults but for the delay)
    const { page, world, events, until, drawn } = await openLive(t, { ...vp, delay: 4 });
    const phone = vp.width < 760;
    assert.match(await page.locator('#bell-chip').textContent(), /ターン\s*42/);
    assert.equal(await page.locator('#bell-toll').isHidden(), true, 'no banner before the toll');
    const food0 = await strip(page, 'Food');
    // (a key press is the gesture that lets the page sound; every sound the effects ask for is noted with whether it sounded)
    await page.locator('#frontier-map').focus();
    await page.keyboard.press('Shift');
    await page.evaluate(() => { const a = window.__fxAudio, play = a.play.bind(a); window.__snd = []; a.play = (name, o) => { const ok = play(name, o); window.__snd.push([name, ok]); return ok; }; });
    // ---- the toll: the page's own clock turns; the banner element carries the words, the dial says the new turn
    const toll = page.locator('#bell-toll.fx-banner-host');
    await toll.waitFor({ state: 'visible', timeout: 20_000 });
    assert.match((await toll.textContent()).replace(/\s+/g, ''), /ターン43新しいターン/);
    assert.match(await page.locator('#bell-chip').textContent(), /ターン\s*43/);
    assert.equal(await page.locator('#bell-pill.toll').count(), 1, 'the dial swings');
    assert.equal(world.turn(), 43, 'the world turned with the page');
    const box = await toll.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= vp.width + 0.5 && box.y > 40, `the banner is on the map (${Math.round(box.x)}, ${Math.round(box.y)}, ${Math.round(box.width)} wide)`);
    // ---- what the turn resolved: the clash of turn 41 at the camp (the rules kernel's), a little into the turn. The
    // page reads it at its own next poll: one card, never single notices beside it
    const card = page.locator('#feed .turn-strip');
    await card.waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await card.locator('.turn-row').count(), 2);
    assert.match(await card.locator('.turn-row').nth(0).textContent(), /への進軍の封が開けられました/);
    assert.match(await card.locator('.turn-row').nth(1).textContent(), /の衝突が決着しました（ターン 41 の到着）/);
    assert.equal(await page.locator('#feed .toast-march, #feed .toast-battle').count(), 0, 'the results are not also single notices');
    const feed = (await events('feed'))[0];
    assert.deepEqual(feed.fresh.map(x => [x[0], x[1]]), [['rv', CAMP_TILE], ['rs', CAMP_TILE]], 'the arrival and its battle are on the camp\'s tile');
    const res = (await events('turn:results'))[0];
    let battle;
    if (!phone) {
      assert.deepEqual(res.fresh.map(x => [x[0], x[2]]), [['rv', false], ['rs', true]], 'the battle is its own result');
      // ---- the battle: started once, when its turn came (after the arrival), by the results and not by the poll; staged from the clash report
      battle = await until('battle');
      const scene = await until('turn:scene');
      assert.ok(battle.at >= scene.at && scene.at - feed.at >= 600, `the scene's cue came ${Math.round(scene.at - feed.at)} ms after the results`);
      assert.equal(battle.focus, false, 'no camera move unless asked for');
    } else {
      // ---- on a phone the camp is not on the stage the viewer is looking at: its battle is marked in the card and
      // not played in passing; the row's 見る sends the camera and plays it
      assert.deepEqual(res.fresh.map(x => [x[0], x[2]]), [['rv', false], ['rs', false]], 'off the stage: marked, not played');
      await page.waitForTimeout(1500);
      assert.equal((await events('battle')).length, 0);
      await card.locator('.turn-row').nth(1).locator('[data-act="battle-play"]').click();
      battle = await until('battle');
      assert.equal(battle.focus, true, 'the camera goes to the battle that was asked for');
      // the scene has the stage: the card steps back for it (it stood over the fight)
      await page.waitForFunction(() => document.body.dataset.fxPiece === 'battle');
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('feed')).opacity), '0');
    }
    assert.deepEqual(battle.scene, { p: HOME.p, q: HOME.q, bell: 41, tiles: [CAMP_TILE] }, 'the scene is the report\'s: turn 41, on the camp\'s tile');
    assert.ok(srv.requests.some(r => r.path === `/h/clash/${HOME.p},${HOME.q}/41` && r.code === 200), 'the report was read from the herald');
    // ---- the host that won stands on the camp's tile, with what the kernel left it; the camp is gone
    const host = mine(world).hosts.find(h => h.id === String(HOSTS.marching));
    assert.deepEqual([host.tile, host.state], [CAMP_TILE, 1]);
    assert.ok(host.troops > 300 && host.troops < 400);
    const token = await drawn(HOSTS.marching, x => x.tile === CAMP_TILE);
    assert.deepEqual([token?.tile, token?.own, token?.troops], [CAMP_TILE, true, host.troops], 'the board draws the host where it arrived');
    assert.equal(world.summary().camp.state, 0);
    // ---- the stores grow by the clock and nothing else: no gift at the toll
    const food1 = await strip(page, 'Food');
    assert.ok(food1 >= food0 && food1 - food0 < 40, `food ${food0} to ${food1}`);
    // ---- the building is done 360 game seconds (twelve wall seconds) into the turn, by the page's clock: its moment and its notice, named by what it is
    const built = await until('moment', e => e.kind === 'built', 40_000);
    assert.equal(built.tile, HOME.tile);
    assert.ok(built.at - (await events('bell'))[0].at > 11_000, 'not before its time');
    // (a phone shows one notice at a time, the turn's card first: the building's is there behind it)
    await page.locator('#feed .toast-build').waitFor({ state: phone ? 'attached' : 'visible' });
    assert.match(await page.locator('#feed .toast-build').textContent(), /伐採場が完成しました/);
    // ---- nothing fired twice
    await page.waitForTimeout(1200);
    const all = await events();
    assert.equal(all.filter(e => e.type === 'bell').length, 1);
    assert.equal(all.filter(e => e.type === 'battle').length, 1, 'the clash played once (not again in passing)');
    assert.equal(all.filter(e => e.type === 'moment' && e.kind === 'built').length, 1);
    assert.equal(all.filter(e => e.type === 'turn:results').length, 1);
    // ---- and it was heard: the bell at the toll, the unsealing, the battle's four blows, the building
    const snd = await page.evaluate(() => window.__snd);
    assert.deepEqual(snd.filter(x => x[0] === 'bell'), [['bell', true]], 'the bell sounded once');
    assert.equal(snd.filter(x => x[0] === 'clash' && x[1]).length, phone ? 5 : 4, 'four blows (and, on the phone, the one of the result\'s mark before the scene was asked for)');
    assert.ok(snd.some(x => x[0] === 'shimmer' && x[1]) && snd.some(x => x[0] === 'confirm' && x[1]), `the unsealing and the building: ${JSON.stringify(snd)}`);
    if (phone) { await page.waitForFunction(() => !document.body.dataset.fxPiece, null, { timeout: 15_000 }); assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('feed')).opacity), '1', 'the card is back when the scene is over'); }
  });
}

test('an accepted order: the pending chip and the ring on the tile, then the landed state; the herald shows it (a build at the rule\'s cost, a muster with its moment)', { timeout: 90_000 }, async t => {
  // (a turn of ten minutes, as on a chain: nothing but the orders happens)
  const { page, world, posts, events, until, press } = await openLive(t, { turn: 600, delay: 400, landMs: 1100 });
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  await page.locator('#tabs [data-tab="holding"]').click();
  await page.locator('#holding-title').waitFor();
  const wood0 = await strip(page, 'Wood');
  // ---- Build: a farm (item 0)
  await press('[data-act="build"][data-item="0"]:not([disabled])');
  const chip = page.locator('#feed .tx-busy');
  await chip.waitFor();
  assert.match(await chip.textContent(), /送信中/);
  await page.waitForFunction(() => window.__ev.some(e => e.type === 'action:sent'));
  // the ring and its caption stand on the village's tile while the transaction is followed (HUD nodes of the effects layer)
  assert.ok(await page.locator('#fx-hud .fx-tag').count() >= 1, 'the caption over the tile');
  await page.locator('#feed .tx-done').waitFor({ timeout: 15_000 });
  // (each kind of order answers in its own words now: it said "recorded on chain" for every one)
  assert.match(await page.locator('#feed .tx-done').textContent(), /農場の建設を始めました/);
  assert.deepEqual((await events()).filter(e => e.type.startsWith('action:')).map(e => [e.type, e.name, e.tile]), [['action:busy', 'Build', HOME.tile], ['action:sent', 'Build', HOME.tile], ['action:landed', 'Build', HOME.tile]]);
  assert.equal(posts.filter(p => p === '/gw/f/relay').length, 1);
  assert.deepEqual(world.orders.map(o => [o.name, o.ok]), [['Build', true]]);
  // the herald's next answer: two buildings under way, each by its own name, and the farm's wood paid: the town's
  // second farm, so one and a half times the first's 80 (the rule: base x (1 + 0.5 (n − 1)²))
  await page.waitForFunction(() => document.querySelectorAll('#panel-body .queue li').length === 2, null, { timeout: 15_000 });
  assert.deepEqual((await page.locator('#panel-body .queue li strong').allTextContents()).sort(), ['伐採場', '農場'].sort());
  // (the strip counts down to it)
  await page.waitForFunction(want => Number((document.querySelector('#res-strip [data-res="Wood"] .res-val')?.textContent ?? '').replace(/[^\d]/g, '')) === want, wood0 - 120, { timeout: 10_000 });
  // ---- Muster: 200 spearmen; the host stands muster-pending and its moment plays
  await page.locator('#f-troops').fill('200');
  await press('#hp-muster button[type="submit"]:not([disabled])');
  await until('action:landed', e => e.name === 'Muster');
  const muster = await until('moment', e => e.kind === 'muster', 15_000);
  assert.equal(muster.tile, HOME.tile);
  await page.locator('#tabs [data-tab="hosts"]').click();
  await page.locator('#panel-body .host-card').nth(2).waitFor();
  assert.equal(await page.locator('#panel-body .host-card').count(), 3, 'the mustered host is listed with the two that stand at the village (the one at the camp is in its march until that is settled)');
  assert.deepEqual(world.orders.map(o => [o.name, o.ok]), [['Build', true], ['Muster', true]]);
});

test('seal and depart is accepted and shown; a second march in the turn too; with the action bucket empty the next is refused: a toast at the map with "try again", and the retry sends once more', { timeout: 150_000 }, async t => {
  const { page, world, posts, events, until, press, store } = await openLive(t, { turn: 600, delay: 400, landMs: 900 });
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  const compose = async host => {
    await page.locator('#tabs [data-tab="hosts"]').click();
    await press(`[data-act="compose"][data-host="${host}"]:not([disabled])`);
    await page.locator('#mc-title').waitFor();
    await press('[data-act="dest-quick"]');
    await page.locator('[data-act="march-send"]:not([disabled])').first().waitFor({ timeout: 20_000 });
  };
  // ---- the free host marches on the camp: sealed in this browser, sent, landed
  await compose(HOSTS.free);
  await press('[data-act="march-send"]:not([disabled])');
  const sealed = await until('march:sealed', () => true, 60_000);
  assert.equal(sealed.tile, HOME.tile);
  assert.ok(sealed.points >= 3, `the ribbon follows the road (${sealed.points} points), not a straight line`);
  await page.locator('#feed .tx-done').waitFor();
  assert.match(await page.locator('#feed .tx-done').textContent(), /出発しました/);
  assert.deepEqual(world.orders.map(o => [o.name, o.ok]), [['Depart', true]]);
  // the herald shows the march in the Holding, and this device holds the sealed order
  await store(FS => (FS.holdings?.[0]?.transit ?? []).filter(x => x.state === 1).length === 1 && (FS.book ?? []).some(e => e.state === 'landed' && e.departBell === 42));
  assert.equal((await events('action:refused')).length, 0);
  // ---- the bucket of the program: 60 actions stored, 30 an hour. The village spends what is left (58 harvests,
  // given straight to the world: no page sends them)
  for (let i = mine(world).bucket; i > 0; i--) assert.equal(world.order('Harvest').ok, true);
  assert.equal(mine(world).bucket, 0);
  // ---- the Scout's march: refused by the program; nothing is on chain
  await compose(HOSTS.scout);
  const before = posts.filter(p => p === '/gw/f/relay').length;
  await press('[data-act="march-send"]:not([disabled])');
  const toast = page.locator('#feed .tx-refused[role="alert"]');
  await toast.waitFor({ timeout: 30_000 });
  assert.match(await toast.textContent(), /進軍は送られていません（斥候 100 は.*にいます）/);
  assert.match(await toast.textContent(), /操作の上限に達しました/);
  assert.equal((await events('action:refused')).length, 1);
  assert.equal(posts.filter(p => p === '/gw/f/relay').length, before + 1);
  assert.deepEqual(world.orders.map(o => [o.name, o.ok, o.code ?? null]), [['Depart', true, null], ['Depart', false, 'Bucket']]);
  // the toast stands over the map, beside the drawer; the order card still offers the seal
  await page.evaluate(() => Promise.all(['feed', 'panel'].flatMap(id => { const el = document.getElementById(id); return [el, ...el.querySelectorAll('*')].flatMap(x => x.getAnimations()); }).map(a => a.finished.catch(() => {}))));
  const box = await toast.boundingBox(), drawerBox = await page.locator('#panel').boundingBox();
  assert.ok(box.x + box.width <= drawerBox.x + 1, 'beside the drawer');
  assert.equal(await page.locator('[data-act="march-send"]:not([disabled])').count() >= 1, true);
  // ---- "try again" sends the same order once more (and is refused again: the bucket is still empty)
  await toast.locator('[data-act="notice-retry"]').click();
  await page.waitForFunction(() => window.__ev.filter(e => e.type === 'action:refused').length === 2, null, { timeout: 30_000 });
  assert.equal(posts.filter(p => p === '/gw/f/relay').length, before + 2);
  await page.locator('#feed .tx-refused[role="alert"] [data-act="notice-retry"]').waitFor();
  // nothing more is on its way, and this device keeps the refused order as failed
  await store(FS => (FS.book ?? []).some(e => e.state === 'failed'));
  await store(FS => (FS.holdings?.[0]?.transit ?? []).filter(x => x.state === 1).length === 1);
});

test('a host is mustered onto a chosen tile: it forms there on the board, is in the roster from the next turn, and takes orders once that turn is settled', { timeout: 120_000 }, async t => {
  const { page, world, until, poll, turn, drawn } = await openLive(t, { turn: 6, delay: 5 });
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  await turn(43);
  // a passable tile two hexes from the village (the village drawer's form names the village's own tile: the tile
  // is chosen here as the hand will choose it, and the order goes out through the page's own transport, signed
  // by the page's own key)
  const tile = await page.evaluate(async home => {
    const { FS } = await import('/frontier/fstate.mjs');
    const { TILE_OFFSETS, hexDistance } = await import('/frontier/fgeo.mjs');
    const pv = FS.provinces.get(`${home.p},${home.q}`).province, o = TILE_OFFSETS[home.tile];
    return [...Array(61).keys()].find(i => ((BigInt(pv.passableMask) >> BigInt(i)) & 1n) && !pv.sites.includes(i) && i !== pv.camp.tile && hexDistance(o.q, o.r, TILE_OFFSETS[i].q, TILE_OFFSETS[i].r) === 2);
  }, HOME);
  assert.ok(Number.isInteger(tile) && tile !== HOME.tile);
  const sent = await page.evaluate(async ([home, tile]) => {
    const { FS } = await import('/frontier/fstate.mjs');
    const io = await import('/frontier/fchainio.mjs');
    const { submit, track, accountsFor } = await import('/frontier/fplay.mjs');
    const v = { addresses: io.pinned().addresses, wallet: FS.wallet.address, actor: FS.session.publicKey, faction: FS.citizen.faction, holding: { p: home.p, q: home.q, site: home.site } };
    const r = await submit({ name: 'Muster', accounts: accountsFor('Muster', v), fields: { unit: 0, troops: 200, tile }, signer: { session: FS.session } });
    return r.ok ? (await track(r.signature)).state : r.code;
  }, [HOME, tile]);
  assert.equal(sent, 'landed');
  assert.deepEqual(world.orders.map(o => [o.name, o.ok]), [['Muster', true]]);
  const id = mine(world).hosts.find(h => h.tile === tile).id;
  // ---- this turn: forming on its tile; the board plays its moment there and draws it there
  await poll();
  // (the host that arrived at the camp this turn is a new host on a tile too, and the page plays the same moment for it)
  const moment = await until('moment', e => e.kind === 'muster' && e.tile === tile, 15_000);
  assert.equal(moment.tile, tile, 'the muster\'s moment is on the chosen tile');
  let token = await drawn(id);
  assert.deepEqual([token?.tile, token?.status, token?.own, token?.troops], [tile, 'muster', true, 200]);
  assert.deepEqual([mine(world).hosts.find(h => h.id === id).state, mine(world).hosts.find(h => h.id === id).fromBell, mine(world).reserve[0]], [2, 44, 100]);
  await tapTile(page, { ...HOME, tile });
  // (rewritten at the integration of wave 5: an own host's tile opens its action bar; its details are behind the bar's (i))
  await page.locator('#hand [data-act="hand-info"]').click();
  await page.locator('.insp-hosts').first().waitFor({ state: 'attached', timeout: 10_000 });
  assert.match(await page.locator('.insp-hosts').first().textContent(), /槍兵 200.*（次のターンから）/s, 'the inspector names the host on that tile');
  // ---- the next turn: in the roster from now on by the rules (it would fight here); the Province still carries it as forming
  await turn(44);
  assert.equal(world.turn(), 44);
  assert.equal(mine(world).hosts.find(h => h.id === id).fromBell, 44);
  // (added at the integration of wave 5: from its own turn the board draws it standing, as the rules count it,
  // although the Province's entry is still "forming"; the page offers no order for it yet)
  assert.equal(mine(world).hosts.find(h => h.id === id).state, 2);
  token = await drawn(id, x => x.status !== 'muster');
  assert.deepEqual([token?.tile, token?.status], [tile, null], 'drawn standing from its turn');
  // ---- the turn after: its own turn is resolved, the Province says roster; the page offers the march
  await turn(45);
  assert.deepEqual([mine(world).hosts.find(h => h.id === id).state, mine(world).hosts.find(h => h.id === id).tile], [1, tile]);
  token = await drawn(id, x => x.status !== 'muster');
  assert.deepEqual([token?.tile, token?.status], [tile, null], 'it stands on its tile');
  await page.locator('#tabs [data-tab="hosts"]').click();
  await page.locator(`[data-act="compose"][data-host="${id}"]:not([disabled])`).waitFor({ timeout: 10_000 });
});

test('a march to an empty tile, through the page\'s own order card: sealed, revealed by this device in its arrival turn, and the host is drawn on the tile where it stays', { timeout: 180_000 }, async t => {
  const live = await openLive(t, { turn: 8, delay: 7 });
  const { page, world, events, press, poll, turn, drawn, store } = live;
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  await turn(43);
  // an open tile three hexes from the village
  const pv = world.province(HOME.p, HOME.q);
  const { TILE_OFFSETS, hexDistance } = await import('../../permutation-server/web/frontier/fgeo.mjs');
  const o = TILE_OFFSETS[HOME.tile];
  const dest = [...Array(61).keys()].find(i => ((pv.passableMask >> BigInt(i)) & 1n) && !pv.sites.includes(i) && i !== CAMP_TILE && !pv.entries.some(e => e.state && e.tile === i) && hexDistance(o.q, o.r, TILE_OFFSETS[i].q, TILE_OFFSETS[i].r) === 2);
  // ---- the order: the host's card, the tile on the map, the seal
  await page.locator('#tabs [data-tab="hosts"]').click();
  await press(`[data-act="compose"][data-host="${HOSTS.free}"]:not([disabled])`);
  await page.locator('#mc-title').waitFor();
  await tapTile(page, { ...HOME, tile: dest });
  await page.locator('[data-act="march-send"]:not([disabled])').first().waitFor({ timeout: 20_000 });
  // A player may leave the order open: the displayed arrival and the sealed
  // order must both follow the reachable window, without nudging the stepper.
  const draftedAt = world.turn();
  await turn(draftedAt + 3);
  await page.locator('[data-act="march-send"]:not([disabled])').first().waitFor({ timeout: 20_000 });
  assert.doesNotMatch(await page.locator('.order').textContent(), /そのターンには着けません|結果の目安まで 0:00/);
  const sealed = await sealNextTurn(live);
  assert.deepEqual(world.orders.map(o => [o.name, o.ok]), [['Depart', true]]);
  const march = mine(world).marches.find(m => m.host === String(HOSTS.free));
  const arrive = march.arriveBell;
  assert.equal(arrive, sealed.named.arrive, 'sealed for the turn the card named when its seal was pressed');
  assert.ok(arrive >= march.departBell + 2, 'two turns at the least');
  assert.equal(march.revealed, false);
  // nothing of its destination is in the public record
  const dep = world.records().filter(r => r.kind === 30 && r.fields.host_id === HOSTS.free).at(-1).fields;
  assert.ok(!('tile' in dep) && dep.seal.length === 165);
  // ---- its arrival turn: the page reveals its own order (the page's poll does it: nothing else knows the destination)
  await turn(arrive, 30);
  for (let i = 0; i < 20 && !mine(world).marches.find(m => m.host === String(HOSTS.free))?.revealed; i++) { await page.waitForTimeout(200); await poll(); }
  assert.deepEqual(world.reveals.filter(r => r.by === 'self').map(r => [r.ok, r.code]), [[true, null]], 'the page\'s own self-reveal was taken');
  assert.equal(mine(world).marches.find(m => m.host === String(HOSTS.free)).revealed, true);
  // ---- two turns on its arrival turn is resolved: the host stays on the tile
  await turn(arrive + 2);
  const host = mine(world).hosts.find(h => h.id === String(HOSTS.free));
  assert.deepEqual([host.province, host.tile, host.state, host.troops], [[HOME.p, HOME.q], dest, 1, 600]);
  const token = await drawn(HOSTS.free, x => x.tile === dest);
  assert.deepEqual([token?.p, token?.q, token?.tile, token?.own, token?.troops], [HOME.p, HOME.q, dest, true, 600], 'the board draws the host on the tile where it arrived');
  // (the inspector stands in the map's own drawer: the marches drawer the departure opened is put away first)
  await page.locator('#tabs [data-tab="map"]').click();
  await tapTile(page, { ...HOME, tile: dest });
  // Selecting an own host opens its action bar; its details are behind the bar's "more" action.
  await page.locator('#hand [data-act="hand-info"]').click();
  await page.locator('.insp-hosts').first().waitFor({ state: 'attached', timeout: 10_000 });
  assert.match(await page.locator('.insp-hosts').first().textContent(), /槍兵 600/);
  assert.ok((await events('feed')).some(e => (e.fresh ?? []).some(x => x[0] === 'rv' && x[1] === dest)), 'the arrival was announced on its tile');
  // ---- a turn later the march is settled (the host can be ordered from where it stands) and the page's book says so
  await turn(arrive + 3, 30);
  assert.equal(mine(world).marches.some(m => m.host === String(HOSTS.free)), false);
  await store(`FS => (FS.book ?? []).some(e => e.host === '${HOSTS.free}' && e.state === 'settled')`);
});

test('a new owner trains, forms a host and marches on the camp through the page\'s own controls: the clash is the rules kernel\'s, its battle plays from the report, and the host stands on the camp\'s tile', { timeout: 240_000 }, async t => {
  // (a hamlet just landed, with stores that pay for 400 Spearmen: the starter kit buys 500 at most, of which a camp of 250 leaves little)
  const live = await openLive(t, { stage: 'provisional', turn: 5, delay: 4, stores: [2_000, 300, 200, 500, 0, 500, 0, 0] });
  const { page, world, events, until, press, poll, turn, drawn, store } = live;
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  assert.deepEqual([mine(world).state, mine(world).hosts.length], [1, 0], 'provisional, no hosts');
  // ---- Train (a provisional village may): 400 Spearmen, in the reserve at once
  await page.locator('#tabs [data-tab="holding"]').click();
  await page.locator('#hp-train').waitFor();
  await page.locator('#f-n').fill('400');
  await press('#hp-train button[type="submit"]:not([disabled])');
  await until('action:landed', e => e.name === 'Train');
  assert.equal(mine(world).reserve[0], 400);
  // ---- the village is final a little into the next turn: Muster (the form is the page's; it names the village's tile)
  await turn(43, 100);
  await page.locator('#hp-muster').waitFor();
  await page.locator('#f-troops').fill('400');
  await press('#hp-muster button[type="submit"]:not([disabled])');
  // (when the order does not land, the failure says what the world was asked and what the page said: this step failed
  // once in a loaded run with nothing to go on)
  await until('action:landed', e => e.name === 'Muster', 40_000).catch(async e => {
    const said = await page.evaluate(() => (document.getElementById('feed')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 240)).catch(() => '');
    throw new Error(`${e.message}; the world in turn ${world.turn()} was asked ${JSON.stringify(world.orders.map(o => [o.name, o.ok, o.code ?? null, o.turn]))}; the page's events ${JSON.stringify((await events()).filter(x => /^action:/.test(x.type)).map(x => [x.type, x.name]))}; the page said: ${said}`);
  });
  assert.equal(mine(world).state, 2, 'the first resident action made it final');
  const id = mine(world).hosts[0].id;
  // ---- two turns on the host stands in the roster: the order card, the camp, the seal (a host formed by Muster marches)
  await turn(45);
  await page.locator('#tabs [data-tab="hosts"]').click();
  await press(`[data-act="compose"][data-host="${id}"]:not([disabled])`);
  await page.locator('#mc-title').waitFor();
  await press('[data-act="dest-quick"]');
  await page.locator('[data-act="march-send"]:not([disabled])').first().waitFor({ timeout: 20_000 });
  const sealed = await sealNextTurn(live);
  assert.deepEqual(world.orders.filter(o => o.name === 'Depart').map(o => o.ok), [true]);
  const arrive = mine(world).marches[0].arriveBell;
  assert.equal(arrive, sealed.named.arrive, 'sealed for the turn the card named when its seal was pressed');
  // ---- its arrival turn: this device reveals; two turns on the kernel has resolved the clash
  await turn(arrive, 30);
  for (let i = 0; i < 20 && !mine(world).marches[0]?.revealed; i++) { await page.waitForTimeout(200); await poll(); }
  assert.deepEqual(world.reveals.filter(r => r.by === 'self').map(r => r.ok), [true]);
  // (the page also stages a scene for a neighbour's arrival on an empty tile: a CLASH record with no engagement is
  // still a "battle" to it. That reading is the page's to mend; what is asserted here is this march's own clash.)
  assert.deepEqual((await events('battle')).filter(b => b.scene?.bell === arrive), [], 'no battle of this march before its arrival turn is resolved');
  await turn(arrive + 2);
  const battle = await until('battle', b => b.scene?.bell === arrive, 40_000);
  assert.deepEqual(battle.scene, { p: HOME.p, q: HOME.q, bell: arrive, tiles: [CAMP_TILE] }, 'the battle is the report\'s: the arrival turn, on the camp\'s tile');
  assert.ok(srv.requests.some(r => r.path === `/h/clash/${HOME.p},${HOME.q}/${arrive}` && r.code === 200), 'the report was read from the herald');
  const clash = world.records().filter(r => r.kind === 41 && r.fields.bell === arrive);
  assert.deepEqual(clash.map(r => r.fields.engagements), [1]);
  // ---- the camp is taken; the host stands on its tile with what the kernel left it; the page draws it there
  assert.equal(world.summary().camp.state, 0);
  const host = mine(world).hosts.find(h => h.id === id);
  assert.deepEqual([host.tile, host.state], [CAMP_TILE, 1]);
  assert.ok(host.troops > 300 && host.troops < 400, `${host.troops} of 400 are left`);
  const token = await drawn(id, x => x.tile === CAMP_TILE);
  assert.deepEqual([token?.tile, token?.own, token?.troops], [CAMP_TILE, true, host.troops]);
  // ---- a turn later the march is settled: the camp's 10 Works are the owner's
  await turn(arrive + 3, 30);
  assert.equal(mine(world).works, 10);
  await store(`FS => Number(FS.citizen?.works ?? 0) === 10`);
});

// ------------------------------------------------------------------ after landing: the board-first hand (UX design 14.2)
// Selecting the viewer's own village stands its action bar where the dock stands (on a phone above the tab bar,
// with the sheet put away); its orders are given from there and on the board: the build fan over the village with
// the rule's own numbers, one tap orders; a new host forms up on the tile that is tapped; each order answers in
// its own words, is said on the effects bus with its kind and tile, and stands in the list of this turn.
for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`the hand @ ${vp.width}: the village's bar in the dock's place, the build fan with real numbers, a host formed on a tapped tile, this turn's list`, { timeout: 120_000 }, async t => {
    const { page, world, events, until, store } = await openLive(t, { ...vp, delay: 600, landMs: 700 });
    const phone = vp.width < 760;
    await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
    const press = sel => (phone ? page.locator(sel).first().tap() : page.locator(sel).first().click());
    const tapAt = async at => { const p = await tileAt(page, at); if (phone) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); };
    // ---- the bar: in the dock's place, five orders, each a target of 56 px (44 on a phone at the least)
    assert.equal(await page.locator('#hand').isHidden(), true, 'no bar while nothing of the viewer\'s is selected');
    const dock0 = await page.locator('#tabs').boundingBox();
    await tapAt(HOME);
    const bar = page.locator('#hand');
    await bar.waitFor();
    assert.equal(await page.evaluate(() => document.body.dataset.hand), 'village');
    assert.deepEqual(await bar.locator('.hand-btn .hand-word').allTextContents(), ['建てる', '訓練', '編成', '収穫', '昇格']);
    assert.equal(await drawer(page), 'closed', 'no drawer: the board keeps the screen');
    if (phone) assert.equal(await page.locator('#panel').isHidden(), true, 'the sheet makes way for the bar');
    else {
      // the bar stands where the dock stood; the dock tucks up behind the bar's top left corner as a strip of its five
      // marks (it stays the page's navigation, and its labels stay its buttons' names)
      await page.waitForFunction(() => { const d = document.getElementById('tabs').getBoundingClientRect(), b = document.getElementById('hand').getBoundingClientRect(); return Math.abs(d.bottom - b.top) <= 8 && d.left >= b.left; }, null, { timeout: 5000 });
      const barBox = await bar.boundingBox(), dock = await page.locator('#tabs').boundingBox();
      assert.ok(Math.abs(barBox.x + barBox.width / 2 - (dock0.x + dock0.width / 2)) <= 2 && barBox.y + barBox.height >= dock0.y + dock0.height - 2, 'the bar is in the dock\'s place');
      assert.ok(dock.width < dock0.width && dock.height < 40 && dock.x + dock.width <= barBox.x + barBox.width, `the dock as a strip: ${JSON.stringify(dock)}`);
      assert.deepEqual(await page.locator('#tabs .tab').evaluateAll(els => els.map(el => el.textContent.trim())), ['地図', '村', '軍勢', '進軍', 'その他']);
    }
    const sizes = await bar.locator('.hand-btn').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), r.left >= 0 && r.right <= innerWidth]; }));
    assert.ok(sizes.every(([w, h, inside]) => h >= 56 && w >= (innerWidthOf(vp) < 760 ? 44 : 100) && inside), `the buttons: ${JSON.stringify(sizes)}`);
    assert.match(await bar.locator('[data-hand="muster"] .hand-fig').textContent(), /400/, 'the reserve that can form up');
    // by keyboard: the bar's buttons are reachable, and the arrows move along them
    if (!phone) {
      await bar.locator('[data-hand="build"]').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.hand), 'train');
      await page.keyboard.press('ArrowLeft');
    }
    // ---- build: the fan over the village (a list on a phone), the next copy's real time and cost; one tap orders
    await press('#hand [data-hand="build"]');
    const pop = page.locator('#hand-pop');
    await pop.locator('.fan-tok').first().waitFor();
    assert.equal(await pop.getAttribute('data-mode'), phone ? 'card' : 'fan');
    assert.equal(await pop.locator('.fan-tok').count(), 7);
    // The live town already has a farm, so this is its second copy.
    assert.match(await pop.locator('.fan-tok[data-item="0"]').getAttribute('aria-label'), /農場を建てる：食料 \+12\/時、2時間、木材 120 · 石材 60/);
    if (!phone) {
      // each token stands around the village's place on the page, none under the HUD's own pieces
      const village = await tileAt(page, HOME);
      // The tokens fan out in sequence; measure their resting layout after every entrance has finished.
      await page.waitForFunction(() => [...document.querySelectorAll('#hand-pop .fan-tok')].every(el => el.getAnimations().filter(a => a.animationName === 'fan-out').every(a => !a.pending && a.playState !== 'running')), null, { timeout: 5000 });
      const boxes = await pop.locator('.fan-tok').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom }; }));
      const barTop = (await bar.boundingBox()).y;
      assert.ok(boxes.every(b => Math.hypot(b.x - village.x, b.y - village.y) > 120 && Math.hypot(b.x - village.x, b.y - village.y) < 360 && b.top > 60 && b.bottom < barTop), `around the village: ${JSON.stringify(boxes.map(b => [Math.round(b.x - village.x), Math.round(b.y - village.y)]))}`);
    }
    await press('#hand-pop .fan-tok[data-item="0"]');
    const built = await until('order:accepted', e => e.kind === 'build', 20_000);
    assert.equal(built.tile, HOME.tile);
    assert.match(await page.locator('#feed .tx-done').first().textContent(), /農場の建設を始めました/);
    await page.waitForFunction(() => document.getElementById('hand-pop').hidden, null, { timeout: 10_000 });
    // (the bar shows the queue: the fixture's woodcutter and the farm; a town has three places)
    await page.waitForFunction(() => document.querySelectorAll('#hand .hand-ring.on').length === 2 && document.querySelectorAll('#hand .hand-ring').length === 3, null, { timeout: 15_000 });
    // ---- form a host: the tiles of the home province are offered, a tapped tile is where it gathers, one confirm
    await press('#hand [data-hand="muster"]');
    await pop.locator('[data-act="muster"]').waitFor();
    assert.equal(await pop.locator('[data-act="muster"]').getAttribute('data-troops'), '300', 'the whole reserve of the kind');
    const pick = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return { kind: FS.hand?.pick?.kind ?? null, n: FS.hand?.pick?.tiles.length ?? 0, tiles: FS.hand?.pick?.tiles.map(t => t.tile) ?? [] }; });
    assert.equal(pick.kind, 'muster');
    assert.ok(pick.n > 20 && pick.n < 61, `the passable tiles of the home province (${pick.n})`);
    const east = await page.evaluate(async ([p, q, tile, offered]) => { const { tileNeighbours } = await import('/frontier/fland.mjs'); return tileNeighbours(tile).find(i => offered.includes(i)); }, [HOME.p, HOME.q, HOME.tile, pick.tiles]);
    await tapAt({ ...HOME, tile: east });
    await page.waitForFunction(async tile => (await import('/frontier/fstate.mjs')).FS.hand?.tile === tile, east);
    assert.equal(await pop.locator('[data-act="muster"]').getAttribute('data-tile'), String(east));
    assert.deepEqual(await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return [FS.selected.idx, document.body.dataset.hand]; }), [HOME.tile, 'village'], 'the tap chose a tile: the village keeps the hand');
    await press('#hand-pop [data-act="muster"]');
    const formed = await until('order:accepted', e => e.kind === 'muster', 20_000);
    assert.equal(formed.tile, east, 'the order names the tile the host gathers on');
    assert.match(await page.locator('#feed .tx-done').first().textContent(), /槍兵 300 の編成を命じました。次のターンに整列します/);
    await store(FS => [...FS.provinces.values()].some(e => e.province.entries.some(x => x.state === 2)));
    // ---- an order the rules would refuse is not sent: the button says why where it stands
    await page.waitForFunction(() => /100/.test(document.querySelector('#hand [data-hand="muster"] .hand-fig')?.textContent ?? ''), null, { timeout: 15_000 });
    // ---- this turn's list: both orders, and what the next bell brings
    await press('#hand [data-act="hand-turn"]');
    const list = page.locator('#dial-pop .turn-list');
    await list.waitFor();
    const rows = await list.locator('.tl-row .tl-text').allTextContents();
    assert.ok(rows.some(x => /農場を建設中/.test(x)) && rows.some(x => /槍兵 300 を編成 — 次のターンに整列します/.test(x)), `the orders of this turn: ${JSON.stringify(rows)}`);
    assert.ok(rows.some(x => /槍兵 300 が整列し、動かせるようになります/.test(x)), 'the next bell: the host forms up');
    // Unlike the still fixture, the live world's seeded march reached the camp before this turn began.
    const seededMarch = mine(world).marches.find(m => m.host === String(HOSTS.marching));
    assert.ok(seededMarch && seededMarch.arriveBell < world.turn(), 'the seeded march has already arrived');
    assert.equal(rows.some(x => /あなたの.*が.*に着きます/.test(x)), false, 'a past arrival is not promised again at the next bell');
    await press('#dial-pop [data-act="dial-close"]');
    // ---- the selection goes: the dock is back
    await press('#hand [data-act="hand-close"]');
    await page.waitForFunction(() => document.getElementById('hand').hidden);
    assert.equal(await page.evaluate(() => document.body.dataset.hand), '');
    if (phone) assert.equal(await page.locator('#panel').isVisible(), true);
    else await page.waitForFunction(d0 => { const d = document.getElementById('tabs').getBoundingClientRect(); return Math.abs(d.left - d0.x) <= 1 && Math.abs(d.top - d0.y) <= 1 && Math.abs(d.width - d0.width) <= 1; }, dock0, { timeout: 5000 });   // the dock is back where it stood
    assert.deepEqual(world.orders.map(o => [o.name, o.ok]), [['Build', true], ['Muster', true]]);
    assert.equal((await events('order:refused')).length, 0);
  });
}
const innerWidthOf = vp => vp.width;

// ------------------------------------------------------------------ the banner rule's PROTOTYPE (integration of 2026-10-10)
// "Standing Ground" is a DESIGN: not in the program, the rules crate or the ABI, and nothing of it is sent to a chain.
// The sample world plays it only when it is started with `claims` (the boot parameter claims=1), and wherever the
// page shows anything of it the label is on screen. These two tests hold that switch from the page's side: on, the
// label stands from the first frame and a banner raised through the page's own controls comes back as a record that
// the board and the plate show; off (every other test of this file), nothing of it is on screen and nothing is asked.
const PROTO_LABEL = '試作ルール：旗（設計のみ・プログラム未実装）';
const protoSeen = page => page.evaluate(() => {
  const vis = el => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0;
  const chip = document.getElementById('proto-chip'), score = document.getElementById('proto-score'), tag = document.getElementById('sample-tag'), plate = document.querySelector('.plate-proto');
  return { chip: vis(chip) ? chip.textContent : null, body: document.body.dataset.proto ?? null, tag: vis(tag) ? tag.textContent.replace(/\s+/g, ' ').trim() : null, score: vis(score) ? score.textContent.replace(/\s+/g, ' ').trim() : null,
    plate: plate && vis(plate) ? plate.textContent.replace(/\s+/g, ' ').trim() : null, tags: document.querySelectorAll('.proto-tag').length, board: !!globalThis.__wyllsMap?.proto?.on, mine: globalThis.__wyllsMap?.proto?.model?.mine?.total ?? null,
    asked: performance.getEntriesByType('resource').map(e => new URL(e.name).pathname).filter(p => /^\/(h|gw\/f)\/proto\//.test(p)) };
});
for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`the banner prototype @ ${vp.width} (a design; the sample world started with claims): the label from the first frame, village land on the plate, a banner raised through the page: its record floods the board and the plate counts`, { timeout: 150_000 }, async t => {
    const { page, world, posts, store, turn } = await openLive(t, { ...vp, turn: 6, delay: 5, claims: true });
    await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
    await store('FS => FS.proto && FS.proto.me && FS.proto.lands.size > 0');
    // ---- the first frame: the label (the record's own words and nothing else), the sample tag, the score with its note, village land as a record
    let s = await protoSeen(page);
    assert.equal(s.chip, PROTO_LABEL, 'the fixed chip says the record\'s label');
    assert.equal(s.chip, (await (await fetch(`${srv.url}/h/season`)).json()).sample.proto.claims.label.ja);
    assert.equal(s.body, 'banners'); assert.match(s.tag, /見本の世界/);
    assert.match(s.score, /試作/); assert.match(s.score, /この得点は試作の計算です。チェーンの記録ではありません。/, 'the score is never called a chain record');
    assert.match(s.plate, /試作.*あなたの土地 7マス.*旗 0\/5/, 'village land, counted from its record');
    assert.equal(s.board, true); assert.equal(s.mine, 7, 'the board draws the same land the plate counts');
    assert.ok(s.asked.every(p => p === '/h/proto/standings' || p === '/h/proto/preview'), 'read-only routes of the prototype');
    // ---- the host that won the camp may raise once its turn is settled: the guide's one button brings its card
    await turn(44, 110);
    await store('FS => (FS.proto.me.hosts ?? []).some(h => h.raise && h.raise.ok)', 30_000);
    const guide = page.locator('#attn-pill:visible, .next-row-go:visible').first();
    await guide.waitFor({ timeout: 10_000 });
    assert.match((await guide.textContent()).replace(/\s+/g, ' '), /旗のガイド（試作）.*旗を立てる/);
    await guide.click();
    const go = page.locator('#hand-pop [data-act="proto-raise"]:not([aria-disabled="true"])').first();
    await go.waitFor({ timeout: 15_000 });
    assert.match(await page.locator('#hand-pop').textContent(), /設計中のルールの試作です。プログラムにはまだなく、チェーンには何も送りません。/);
    const size = Number(await go.getAttribute('data-min'));
    assert.ok(size >= 3);
    await go.click();
    // ---- the world wrote the record; the page shows it from the record (the plate, the board, the feed), under the label
    await store(`FS => (FS.proto.me.banners ?? []).length === 1 && FS.proto.me.tiles === ${7 + size}`, 20_000);
    assert.deepEqual(world.orders.filter(o => o.name.startsWith('ProtoLand')).map(o => [o.name, o.ok]), [['ProtoLand:raise', true]]);
    assert.ok(posts.includes('/gw/f/proto/land'), 'the order went to the sample world\'s own route');
    const lands = world.summary().proto.lands['2,0'].filter(b => b.nation === 0);
    assert.deepEqual(lands.map(b => b.tiles), [size], 'the sample world holds the banner');
    await page.waitForFunction(n => globalThis.__wyllsMap?.proto?.model?.mine?.total === n, 7 + size, { timeout: 15_000 });
    await page.waitForFunction(n => new RegExp(`あなたの土地 ${n}マス`).test(document.querySelector('.plate-proto')?.textContent ?? ''), 7 + size, { timeout: 15_000 });
    // (on a phone the plate rests under the host's bar: the bar is put down first)
    if (vp.width < 760) { await page.locator('#hand [data-act="hand-close"]').first().click(); await page.locator('.plate-proto').first().waitFor({ state: 'visible', timeout: 5000 }); }
    s = await protoSeen(page);
    assert.equal(s.chip, PROTO_LABEL, 'the label is still on screen with banner land on the board');
    assert.match(s.plate, new RegExp(`あなたの土地 ${7 + size}マス（村7・旗${size}）.*旗 1/5`));
    const log = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return FS.proto.log.filter(r => !r.premise).map(r => [r.op, r.by]); });
    assert.ok(log.some(([op]) => op === 'RAISE'), 'the moment is the record\'s: a RAISE in the log the page read');
  });
}
// The kept place (the loss states on real records, 2026-10-11): the chip that says the banner rule is a design and the
// sample world's tag say what is true of the whole screen. In the film a caption's dot lay on the chip's first
// character; on a phone the tag ran under the dial and the chip lay on a button; the stores' pop-over opened over both.
// Nothing of the page may meet them, at either size, in either language, with any card open; and the board keeps its
// labels out of them, a label that is never left out too.
const keptSeen = page => page.evaluate(() => {
  const box = e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const hit = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
  const shown = o => !o.hidden && o.getClientRects().length > 0 && getComputedStyle(o).visibility !== 'hidden' && Number(getComputedStyle(o).opacity) > 0;
  const others = ['#feed > *', '#hand-pop', '#hand', '#panel', '.map-tip', '#mile-banner', '.dial-pop', '.res-pop', '.home-pointer', '.fx-hud .fx-tag-plate', '.fx-hud .fx-tag-dot', '.banner', '#proto-score', '#objective', '.todo-list', '#lenses', '#minimap', '.map-tools', '#search-btn', '#bell-pill', '#topbar .strip-l', '#topbar .strip-r'];
  const out = {};
  for (const id of ['proto-chip', 'sample-tag']) {
    const e = document.getElementById(id);
    if (!e || !shown(e)) { out[id] = null; continue; }
    const b = box(e), over = [];
    for (const sel of others) for (const o of document.querySelectorAll(sel)) if (o !== e && !o.contains(e) && shown(o) && hit(b, box(o))) over.push(sel);
    out[id] = { ...b, text: e.textContent.replace(/\s+/g, ' ').trim(), whole: e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1 && b.x >= 0 && b.y >= 0 && b.x + b.w <= innerWidth && b.y + b.h <= innerHeight, over };
  }
  const m = globalThis.__wyllsMap, c = document.getElementById('frontier-map').getBoundingClientRect();
  m.nogoNow = null;
  out.hard = m.nogoBoxes().filter(r => r.hard).map(r => ({ x: r.x + c.left, y: r.y + c.top, w: r.w, h: r.h }));
  // a label that is never left out, wanted right on the chip: where the board's label pass puts it
  const chip = out['proto-chip'];
  if (chip) {
    const z = m.cam.drawn.zoom, w = m.unproject(chip.x + chip.w / 2, chip.y + chip.h / 2), box0 = { x: w.x - 70 / z, y: w.y - 11 / z, w: 140 / z, h: 22 / z };
    const mv = m.labelPass(z).place(w.x, w.y, box0, { keep: true }), s = m.project(w.x, w.y);
    out.label = { x: s.x - 70 + mv.dx * z, y: s.y - 11 + mv.dy * z, w: 140, h: 22 };
    out.labelOnChip = hit(out.label, chip);
  }
  return out;
});
for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`the kept place @ ${vp.width}: the prototype's chip and the sample world's tag are whole, nothing of the page meets them (the stores' pop-over and the dial's card open too, in Japanese and in English), and the board's labels keep out of them`, { timeout: 120_000 }, async t => {
    const { page, store } = await openLive(t, { ...vp, paused: true, claims: true });
    await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
    await store('FS => FS.proto && FS.proto.me && FS.proto.lands.size > 0');
    const check = async (where, label) => {
      const k = await keptSeen(page);
      assert.ok(k['proto-chip'], `${where}: the chip is on screen`); assert.ok(k['sample-tag'], `${where}: the sample tag is on screen`);
      assert.equal(k['proto-chip'].text, label, `${where}: the chip says the record's label`);
      for (const id of ['proto-chip', 'sample-tag']) { assert.equal(k[id].whole, true, `${where}: ${id} is whole (not cut, in the picture)`); assert.deepEqual(k[id].over, [], `${where}: nothing meets ${id}`); }
      assert.equal(k.hard.length, 2, `${where}: the map keeps both places`);
      for (const id of ['proto-chip', 'sample-tag']) assert.ok(k.hard.some(r => r.x <= k[id].x && r.y <= k[id].y && r.x + r.w >= k[id].x + k[id].w && r.y + r.h >= k[id].y + k[id].h), `${where}: the kept place holds all of ${id}`);
      assert.equal(k.labelOnChip, false, `${where}: a label that is never left out is moved out of the chip`);
      return k;
    };
    const cards = async (where, label) => {
      await check(where, label);
      await page.locator('[data-act="res-open"]').first().click();
      await page.locator('.res-pop').first().waitFor({ state: 'visible', timeout: 5000 });
      await check(`${where}, the stores' pop-over open`, label);
      await page.keyboard.press('Escape');
      await page.locator('.res-pop').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      await page.locator('#bell-pill').click();
      await page.locator('.dial-pop').first().waitFor({ state: 'visible', timeout: 5000 });
      await check(`${where}, the dial's card open`, label);
      await page.locator('.dial-pop [data-act="dial-close"]').first().click();
    };
    await cards('ja', PROTO_LABEL);
    // the chip is the page's top layer: above the effects' layer, a milestone's banner and every pop-over
    const zs = await page.evaluate(() => ({ chip: Number(getComputedStyle(document.getElementById('proto-chip')).zIndex), fx: Number(getComputedStyle(document.querySelector('.fx-hud')).zIndex), top: Number(getComputedStyle(document.getElementById('topbar')).zIndex) }));
    assert.ok(zs.chip > zs.fx && zs.chip > zs.top, `the chip (${zs.chip}) lies above the effects (${zs.fx}) and the strip (${zs.top})`);
    await page.evaluate(async () => { (await import('/lang.mjs')).setLang('en'); });
    await page.waitForFunction(() => /^Prototype rule/.test(document.getElementById('proto-chip')?.textContent ?? ''), null, { timeout: 10_000 });
    await page.waitForTimeout(400);
    await cards('en', 'Prototype rule: banners (design only, not in the program)');
  });
}
// (the phone pass of 2026-10-11: the training card stood over the label and over the guide's line; the sample world's
// tag ran under the turn dial's bell. Both are what says, on a phone, that this is a sample world playing a design)
test('the banner prototype on a phone: no card of the hand reaches the label or the guide\'s line, the sample tag ends before the dial\'s bell, and the guide\'s step stands in two lines', { timeout: 120_000 }, async t => {
  const { page, store } = await openLive(t, { width: 390, height: 844, turn: 6, delay: 5, claims: true });
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  await store('FS => FS.proto && FS.proto.me && FS.proto.lands.size > 0');
  /** Whether nothing lies over an element (three points along its middle), and where it stands. */
  const seen = sel => page.evaluate(sel => {
    const c = document.querySelector(sel);
    if (!c || c.hidden || !c.getClientRects().length) return null;
    const was = c.style.pointerEvents; c.style.pointerEvents = 'auto';
    const r = c.getBoundingClientRect(), y = r.top + r.height / 2;
    const over = [r.left + 6, r.left + r.width / 2, r.right - 6].map(x => document.elementFromPoint(x, y)).filter(e => e && e !== c && !c.contains(e)).map(e => e.id || String(e.className));
    c.style.pointerEvents = was;
    return { over, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, sel);
  // ---- the sample tag and the label at rest
  const tag = await seen('#sample-tag'), chip = await seen('#proto-chip');
  assert.deepEqual(tag.over, [], 'nothing lies over the sample world\'s tag');
  assert.deepEqual(chip.over, [], 'nothing lies over the label');
  const bell = await page.evaluate(() => { const r = document.querySelector('#bell-pill .dial-bell')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, bottom: r.bottom } : null; });
  assert.ok(!bell || tag.right <= bell.left + 1 || tag.top >= bell.bottom, `the tag ends before the dial's bell (${Math.round(tag.right)} / ${Math.round(bell?.left ?? 0)})`);
  // ---- the guide's one button: the new host's card; the guide's step is the strip under the label, on two lines
  await page.locator('.next-row-go:visible').first().click();
  await page.locator('#hand-pop[data-pop="muster"]').waitFor({ timeout: 10_000 });
  const strip = page.locator('#proto-score .proto-strip');
  await strip.waitFor({ timeout: 5000 });
  const lines = await strip.evaluate(el => { const k = el.querySelector('.ps-k').getBoundingClientRect(), t = el.querySelector('.ps-t'), tr = t.getBoundingClientRect(); return { under: tr.top >= k.bottom - 2, cut: t.scrollWidth > t.clientWidth + 1, text: el.textContent.replace(/\s+/g, ' ').trim() }; });
  assert.equal(lines.under, true, 'the step\'s name stands under the guide\'s own');
  assert.equal(lines.cut, false, 'and is not cut');
  assert.match(lines.text, /旗のガイド（試作） 2\/6\s*軍勢を編成する\s*編成する/);
  // ---- the tallest card of the hand, the training card: it stops under the guide's line, and the label is in sight
  // (the bar's buttons step aside while a place for the new host is chosen on the board: that card is put away first)
  await page.locator('#hand-pop .pop-x').first().click();
  await page.locator('#hand [data-pop="train"]').first().click();
  await page.locator('#hand-pop[data-pop="train"]').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const card = await page.locator('#hand-pop').boundingBox(), line = await strip.boundingBox();
  const chip2 = await seen('#proto-chip');
  assert.deepEqual(chip2.over, [], 'the training card does not lie over the label');
  assert.ok(card.y >= chip2.bottom, `the card begins under the label (${Math.round(card.y)} / ${Math.round(chip2.bottom)})`);
  assert.ok(card.y >= line.y + line.height - 1, `and under the guide's line (${Math.round(card.y)} / ${Math.round(line.y + line.height)})`);
  assert.deepEqual((await seen('#sample-tag')).over, [], 'the sample tag stays in sight too');
  // ---- (the merge of 2026-10-11) the same in English: the label is two lines there and the guide's line stands lower
  // (the loss pass), so the card that stops under the guide's line (the phone pass) must stop lower too: merged, the
  // training card lay 2 px over the foot of the guide's line
  await page.evaluate(async () => { (await import('/lang.mjs')).setLang('en'); });
  await page.waitForFunction(() => /^Prototype rule/.test(document.getElementById('proto-chip')?.textContent ?? ''), null, { timeout: 10_000 });
  await page.locator('#hand-pop[data-pop="train"]').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const cardEn = await page.locator('#hand-pop').boundingBox(), lineEn = await strip.boundingBox(), chipEn = await seen('#proto-chip');
  assert.deepEqual(chipEn.over, [], 'English: the training card does not lie over the label');
  assert.ok(lineEn.y >= chipEn.bottom - 1, `English: the guide's line stands under the two-line label (${Math.round(lineEn.y)} / ${Math.round(chipEn.bottom)})`);
  assert.ok(cardEn.y >= lineEn.y + lineEn.height - 1, `English: the card begins under the guide's line (${Math.round(cardEn.y)} / ${Math.round(lineEn.y + lineEn.height)})`);
  assert.deepEqual((await seen('#sample-tag')).over, [], 'English: the sample tag stays in sight');
});

test('the banner prototype is off unless the world is started with it: no label, no score, no plate line, no banner land, and nothing of it is asked for', { timeout: 60_000 }, async t => {
  const { page, world, store } = await openLive(t, { turn: 6, delay: 5 });
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  await store('FS => !!FS.citizen && FS.provinces.size > 0');
  assert.equal(world.summary().proto ?? null, null);
  assert.equal((await (await fetch(`${srv.url}/h/season`)).json()).sample.proto, undefined);
  const s = await protoSeen(page);
  assert.deepEqual([s.chip, s.body, s.score, s.plate, s.tags, s.board, s.mine], [null, null, null, null, 0, false, null]);
  assert.deepEqual(s.asked, [], 'no route of the prototype is asked for');
  assert.match(s.tag, /見本の世界/);
  assert.equal(await page.evaluate(async () => (await import('/frontier/fstate.mjs')).FS.proto ?? null), null);
  assert.ok(!/領土|あなたの土地/.test(await page.evaluate(() => document.body.innerText)), 'the words for land that is one\'s own are the prototype\'s alone');
});
