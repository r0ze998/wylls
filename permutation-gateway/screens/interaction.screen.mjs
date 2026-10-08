// Keyboard, sheet and focus behaviour in Chromium (web design §7.1, §10):
// the bottom sheet (handle states, Escape back to peek with focus on the
// handle, a tab opens it), the map by keyboard (+/−, H home, the buttons),
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

test('the bottom sheet: the handle cycles its heights, Escape collapses it and returns focus, a tab opens it', { timeout: 60_000 }, async t => {
  const page = await open(t);
  const handle = page.locator('[data-sheet-handle]');
  await handle.waitFor();
  assert.equal(await sheet(page), 'half');
  assert.equal(await handle.getAttribute('aria-expanded'), 'true');
  assert.equal(await handle.getAttribute('aria-controls'), 'panel-body');
  await handle.click();
  assert.equal(await sheet(page), 'full');
  assert.equal(await handle.getAttribute('aria-label'), 'パネルを小さくする');
  await handle.click();
  assert.equal(await sheet(page), 'peek');
  assert.equal(await handle.getAttribute('aria-expanded'), 'false');
  await page.locator('#tabs [data-tab="holding"]').click();
  assert.equal(await sheet(page), 'half', 'choosing a tab opens the sheet');
  await page.locator('#holding-title').waitFor();
  await page.locator('#panel-body [data-act="harvest"]').focus();
  await page.keyboard.press('Escape');
  assert.equal(await sheet(page), 'peek');
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-sheet-handle')), true, 'focus returns to the handle');
});

/** A real touch drag on the handle (CDP touch events: pointerdown/up, no click), `dy` px in 8 steps. */
async function touchDrag(page, dy) {
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
  assert.equal(await sheet(page), 'half');
  await touchDrag(page, -80);
  assert.equal(await sheet(page), 'full', 'dragging up expands one step');
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
  assert.equal(await sheet(page), 'half');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y - 160, { steps: 8 });
  await page.mouse.up();
  assert.equal(await sheet(page), 'full', 'released far from the 44-px handle');
});

test('on a phone the relay quota is read in "More" (the chip is hidden below 760 px; wave-5 review D5)', { timeout: 60_000 }, async t => {
  const page = await open(t);
  assert.equal(await page.locator('#quota-chip').isVisible(), false, 'the chip waits');
  await page.locator('#tabs [data-tab="more"]').click();
  const line = page.locator('#panel-body [data-quota-line]');
  await line.waitFor();
  assert.match(await line.textContent(), /中継 残り \d+ 回/);
});

test('the sheet is a phone thing: on desktop the handle is hidden and Escape leaves the panel alone', { timeout: 60_000 }, async t => {
  const page = await open(t, { width: 1440, height: 900 });
  assert.equal(await page.locator('[data-sheet-handle]').isVisible(), false);
  await page.locator('#tabs [data-tab="holding"]').click();
  await page.locator('#panel-body [data-act="harvest"]').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#holding-title').isVisible(), true);
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
  for (let i = 0; i < 4; i++) await page.keyboard.press('+');
  assert.equal(await lod(), 'province', 'four steps in from the far view');
  await page.keyboard.press('h');
  assert.equal(await lod(), 'tile', 'home: the holding up close, on its tile');
  // on a phone the village is centred in the part of the map the sheet leaves free
  const v = await view();
  assert.ok(v.covered > 100, `the sheet covers ${v.covered} px of the map`);
  // the picture arrives where the logical view already is (a flight takes 1.2 s at most)
  await page.waitForTimeout(1500);
  await page.locator('#frontier-map[data-terrain="ready"]').waitFor();
  // a tap in the middle of the uncovered part selects the village's own tile
  const box = await page.locator('#frontier-map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + (box.height - v.covered) / 2);
  const sel = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return FS.selected; });
  assert.deepEqual([sel?.p, sel?.q, sel?.idx], [HOME.p, HOME.q, HOME.tile], 'the village sits in the middle of the map above the sheet');
  await page.locator('[data-map="in"]').focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Enter');
  assert.equal(await lod(), 'tile');
  await page.locator('[data-map="out"]').focus();
  for (let i = 0; i < 16; i++) await page.keyboard.press('Enter');
  assert.equal(await lod(), 'world', 'zooming out still reaches the world view');
  await page.locator('[data-map="chart"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await lod(), 'tile', 'from the far view the world chart button goes home');
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
  const Z = 1.4;
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

// UX brief §5.2 and §5.3: the map itself is the control. Selecting the viewer's village lights what its host can
// do at once; a tap on a lit tile is the order (two presses from nothing to the order card); a tap on a tile no
// march can reach is answered on the map and keeps the host; the same tile again takes the next host; off screen,
// a button at the map's edge points home and flies there.
test('the land: lit tiles on selection, a tap is the order, a refusal on the map, the pointer home', { timeout: 90_000 }, async t => {
  const Z = 1.4;
  const page = await open(t, { width: 1440, height: 900, query: `?at=${HOME.p},${HOME.q},${HOME.tile},${Z}` });
  await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
  const box = await page.locator('#frontier-map').boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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
  await page.mouse.click(centre.x, centre.y);
  assert.deepEqual((await state()).sel, [HOME.p, HOME.q, HOME.tile]);
  assert.equal((await state()).compose, null, 'selecting composes nothing');
  // 2. a tile no host can stand on: said on the map (and in the live line), the host stays selected
  await page.mouse.click(centre.x + where.wet.x * Z, centre.y + where.wet.y * Z);
  await page.waitForFunction(async () => !!(await import('/frontier/fstate.mjs')).FS.mapNote);
  let s = await state();
  assert.deepEqual([s.note, s.noteTile, s.sel, s.compose], ['ここへは届きません', where.wet.tile, [HOME.p, HOME.q, HOME.tile], null], 'refused on the map; the village stays selected');
  assert.equal(await page.locator('#map-summary').textContent(), 'ここへは届きません');
  // 3. the village again: the next host standing there (the Scout); again: back to the first
  await page.mouse.click(centre.x, centre.y);
  assert.equal((await state()).actor, 1);
  await page.mouse.click(centre.x, centre.y);
  assert.equal((await state()).actor, 0);
  // 4. the Scout: a sky-blue neighbour is picked for its exploration, and the explore card comes to the map tab
  await page.mouse.click(centre.x, centre.y);
  assert.equal((await state()).actor, 1);
  const east = await page.evaluate(async () => { const { project } = await import('/map.mjs'); return project(1, 0); });
  await page.mouse.click(centre.x + east.x * Z, centre.y + east.y * Z);
  s = await state();
  assert.equal(s.explore?.length, 1, 'one tile picked for the exploration');
  await page.locator('#explore-title').waitFor();
  assert.equal(s.tab, 'map');
  // 5. back to the first host; the camp, a lit tile: the order card, with the destination, in one press (two from nothing)
  await page.mouse.click(centre.x, centre.y);
  assert.equal((await state()).actor, 0);
  await page.mouse.click(centre.x + where.camp.x * Z, centre.y + where.camp.y * Z);
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
  const pointer = page.locator('[data-map="home-pointer"]');
  assert.equal(await pointer.isHidden(), true);
  for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowRight');
  await pointer.waitFor({ state: 'visible' });
  assert.match(await pointer.getAttribute('aria-label'), /^自分の村へ移動（\d+ マス先）$/);
  const pb = await pointer.boundingBox();
  assert.ok(pb.width >= 44 && pb.height >= 44, 'a 44-px target');
  assert.ok(pb.x + pb.width / 2 < centre.x, 'on the side the village lies');
  await pointer.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-map="home-pointer"]').hidden, null, { timeout: 5000 });
});
