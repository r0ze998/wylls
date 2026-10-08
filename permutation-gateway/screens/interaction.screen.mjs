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
  // at rest the peek is about a quarter of the screen and shows the village plate
  await page.locator('#panel-body [data-act="home"]').waitFor();
  const peek = await page.locator('#panel').boundingBox();
  assert.ok(peek.height / 844 > 0.2 && peek.height / 844 < 0.3, `the peek is ${Math.round(peek.height)} px of 844`);
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

test('on a phone the relay quota is read in "More" (the chip is hidden below 760 px; wave-5 review D5)', { timeout: 60_000 }, async t => {
  const page = await open(t);
  assert.equal(await page.locator('#quota-chip').isVisible(), false, 'the chip waits');
  await page.locator('#tabs [data-tab="more"]').click();
  const line = page.locator('#panel-body [data-quota-line]');
  await line.waitFor();
  assert.match(await line.textContent(), /中継 残り \d+ 回/);
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
  await page.locator('#bell-title').waitFor();
  await page.locator('#tabs [data-tab="map"]').click();
  assert.equal(await drawer(page), 'closed');
  await page.locator('#panel .panel-close').waitFor({ state: 'hidden' });
});

test('the map by keyboard: + and − zoom, H goes to the viewer\'s holding, the buttons work with Enter', { timeout: 60_000 }, async t => {
  const page = await open(t);
  const lod = () => page.locator('#frontier-map').getAttribute('data-lod');
  assert.equal(await lod(), 'world');
  await page.locator('#frontier-map').focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('+');
  assert.equal(await lod(), 'province');
  await page.keyboard.press('h');
  assert.equal(await lod(), 'tile', 'home: the holding up close, on its tile');
  await page.locator('[data-map="in"]').focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Enter');
  assert.equal(await lod(), 'tile');
  await page.locator('#frontier-map[data-terrain="ready"]').waitFor();
  await page.locator('[data-map="out"]').focus();
  for (let i = 0; i < 16; i++) await page.keyboard.press('Enter');
  assert.equal(await lod(), 'world');
  assert.equal(await page.locator('.map-tools').getAttribute('aria-label'), '地図の操作');
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
  const box = await page.locator('#frontier-map').boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const offset = await page.evaluate(async ([p, q, from, to]) => {
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const a = (h => project(h.q, h.r))(tileHex(p, q, from)), b = (h => project(h.q, h.r))(tileHex(p, q, to));
    return { x: b.x - a.x, y: b.y - a.y };
  }, [HOME.p, HOME.q, HOME.tile, CAMP_TILE]);
  // the host selected: a press on its tile (the selection itself is not counted)
  await page.mouse.click(centre.x, centre.y);
  await page.locator('#panel-body [data-act="compose"]').first().waitFor();
  let presses = 0;
  presses++; await page.locator('#panel-body [data-act="compose"]').first().click();
  await page.locator('#mc-title').waitFor();
  presses++; await page.mouse.click(centre.x + offset.x * Z, centre.y + offset.y * Z);
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
  const stage = await page.locator('.banners').boundingBox();
  assert.ok(stage.y > 900 * 0.35, 'the banners leave the upper part of the map to the chart');
  assert.equal(await page.locator('[data-act="join"]').isDisabled(), true, 'nothing to confirm yet');
  await page.evaluate(() => { window.__nation = []; addEventListener('wylls:nation-focus', e => window.__nation.push(e.detail.faction)); });
  await page.locator('[data-nation="1"]').hover();
  await page.locator('[data-nation="3"]').focus();
  await page.locator('[data-nation="2"]').click();
  assert.deepEqual(await page.evaluate(() => window.__nation), [1, 3, 2], 'hover, focus and choice each name the nation');
  assert.equal(await page.locator('[data-nation="2"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.banner-pick[aria-pressed="true"]').count(), 1);
  assert.equal(await page.locator('[data-act="join"]').isDisabled(), false, 'one confirm');
  assert.equal(await page.locator('[data-act="pick-province"], [data-act="toggle-site"], [data-act="file-ticket"]').count(), 0, 'no site picker');
});
