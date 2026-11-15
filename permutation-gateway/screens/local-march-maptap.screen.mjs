// Round 28, in a real browser on the keyless screens fixture (no chain, no key, no relay): local play's map tap says the
// refusal ON THE MAP before any order is drafted when the host's own march answer is closed, and drafts the order as
// before when it is open. Test-only, in this page: the page is put in local play and given a per-host march answer
// (FS.localMarchFor, the function the controller exposes); nothing can be sent — the check also counts every non-GET
// request. The tap is a mouse click at the tile's position on screen (computed, as in ws07-march); a fixture check, not
// evidence of an unaided press. Run from this folder: node --test local-march-maptap.screen.mjs
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
const tapTile = async (page, at) => { const p = await tileAt(page, at); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up(); };

/** Passable tiles of the home province two hexes or more from the village, seen in the free part of the screen. */
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
    const hexes = i => { const h = tileHex(p, q, i), dq = h.q - h0.q, dr = h.r - h0.r; return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2; };
    const out = [];
    for (let i = 0; i < 61; i++) if (hexes(i) >= 2 && ((BigInt(g.passableMask) >> BigInt(i)) & 1n)) out.push({ tile: i, d: Math.hypot(at(i).x - a.x, at(i).y - a.y) });
    return out.sort((x, y) => x.d - y.d).map(x => x.tile);
  }, [HOME.p, HOME.q, HOME.tile]);
  const free = await page.evaluate(() => {
    const tops = ['hand', 'tabs', 'panel'].map(id => document.getElementById(id)).filter(e => e && !e.hidden && e.getBoundingClientRect().height > 0)
      .map(e => e.getBoundingClientRect()).filter(r => r.width >= innerWidth * 0.6).map(r => r.top);
    const side = document.getElementById('panel')?.getBoundingClientRect();
    const right = side && side.width > 0 && side.width < innerWidth * 0.6 ? side.left : innerWidth;
    return { w: right, bottom: Math.min(innerHeight, ...tops) - 24, top: 140 };
  });
  const seen = [];
  for (const tile of all) { const pt = await tileAt(page, { ...HOME, tile }); if (pt.x > 24 && pt.x < free.w - 24 && pt.y > free.top && pt.y < free.bottom) seen.push(tile); }
  return seen;
}
const look = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  const n = FS.mapNote;
  return { compose: FS.compose ? String(FS.compose.host.id) : null, note: n ? String(typeof n.say === 'function' ? n.say() : n.text ?? '') : null, cards: document.querySelectorAll('#mc-title').length, asked: window.__asked ?? [] };
});

test('round 28: local play — a map tap says the refusal on the map and drafts nothing when the host\'s own march answer is closed; open, the order card as before', { timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ja-JP', timezoneId: 'UTC' });
  await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  try {
    await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
    await page.goto(`${base}/frontier/index.html?at=${HOME.p},${HOME.q},${HOME.tile},1.0`);
    await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
    await page.locator('#frontier-map[data-lod="tile"]').waitFor();
    await tapTile(page, HOME);
    await page.locator('#hand [data-hand="build"]').waitFor();
    await page.locator('#hand .hand-chip[data-host]:not(.hand-back)', { hasText: '槍兵' }).first().click();
    await page.locator('#hand [data-hand="march"][aria-pressed="true"]').waitFor();
    const tiles = await seenTiles(page);
    assert.ok(tiles.length >= 2, 'two passable tiles in view');
    // (test-only: local play, and the host's own march answer closed — what the controller's localMarchFor answers when
    //  the march trial is closed for this host)
    await page.evaluate(async () => {
      const { FS } = await import('/frontier/fstate.mjs');
      window.__open = false; window.__asked = [];
      FS.localPlay = { address: 'W', programId: 'P', seasonAddress: 'S', cluster: 'localnet' };
      Object.defineProperty(FS, 'localMarch', { configurable: true, get: () => ({ open: window.__open }) });
      Object.defineProperty(FS, 'localMarchFor', { configurable: true, enumerable: false, value: (holding, hostId) => { window.__asked.push([holding?.site ?? null, String(hostId)]); return { open: window.__open }; } });
    });
    await tapTile(page, { ...HOME, tile: tiles[0] });
    await page.waitForTimeout(700);
    const closed = await look(page);
    assert.equal(closed.compose, null, 'no order drafted');
    assert.equal(closed.cards, 0, 'no order card');
    assert.equal(closed.note, 'ローカルプレイでは、まだ命令を送れません（読み取りのみ）。', 'the refusal is on the map');
    assert.ok(closed.asked.length >= 1, 'the per-host march answer was asked');
    // open: the order card as before (another tile: a second tap on the tile just answered selects it, by design)
    await page.evaluate(() => { window.__open = true; });
    await tapTile(page, { ...HOME, tile: tiles[1] });
    await page.locator('#mc-title').waitFor({ state: 'attached', timeout: 15_000 });
    const open = await look(page);
    assert.ok(open.compose, 'the order is drafted when the answer is open');
    assert.deepEqual(posts, [], 'nothing was sent');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

for (const [lang, said] of [['en', /still resolving the last turn/], ['ja', /この州はまだ前のターンの決着が済んでいません/]]) test(`round 35 (${lang}): in march mode, a tap on a tile while the province is still behind says why on the map and keeps the host in hand (it fell through to a plain tile selection, with no word)`, { timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: lang === 'en' ? 'en-US' : 'ja-JP', timezoneId: 'UTC' });
  await NK.prepare(ctx, srv.viewer, { lang });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  try {
    await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
    await page.goto(`${base}/frontier/index.html?at=${HOME.p},${HOME.q},${HOME.tile},1.0`);
    await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
    await page.locator('#frontier-map[data-lod="tile"]').waitFor();
    await tapTile(page, HOME);
    await page.locator('#hand [data-hand="build"]').waitFor();
    await page.locator('#hand .hand-chip[data-host]:not(.hand-back)', { hasText: /Spear|槍兵/ }).first().click();
    await page.locator('#hand [data-hand="march"][aria-pressed="true"]').waitFor();
    // the player presses March: its card opens ("Press the destination tile …") — the tap that follows is a destination
    await page.locator('#hand [data-hand="march"]').click();
    await page.waitForFunction(() => document.getElementById('hand-pop')?.dataset.pop === 'march');
    const tiles = await seenTiles(page);
    assert.ok(tiles.length >= 1, 'a passable tile in view');
    // (test-only, in this page: the host's province two turns behind — the program refuses a Depart then: NotResident —
    //  held there by the test for the tap: the page's own province reads are paused while it lasts)
    const pt = await tileAt(page, { ...HOME, tile: tiles[0] });
    const at = await page.evaluate(async () => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const H = await import('/frontier/hud/hand.mjs');
      const sub = H.subjectOf(FS), key = `${sub.host.p},${sub.host.q}`, env = FS.provinces.get(key);
      const behind = { ...env, province: { ...env.province, resolvedNext: FS.nowBell - 3 } };
      // (a getter keeps the behind province in place even if a read writes the map entry again)
      const map = FS.provinces, get = map.get.bind(map);
      map.get = k => (k === key ? behind : get(k));
      invalidate('panel', 'map');
      await new Promise(r => setTimeout(r, 300));
      return { host: String(sub.host.id), check: H.marchCheck(FS, H.subjectOf(FS).host).code };
    });
    assert.equal(at.check, 'NotResident', 'the fixture holds the province behind');
    assert.equal(await page.evaluate(() => document.getElementById('hand-pop')?.dataset.pop ?? ''), 'march', 'the March card is still open');
    const host = at.host;
    await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
    await page.waitForTimeout(700);
    const after = await page.evaluate(async () => {
      const { FS } = await import('/frontier/fstate.mjs');
      const { subjectOf } = await import('/frontier/hud/hand.mjs');
      const n = FS.mapNote, sub = subjectOf(FS);
      return { note: n ? String(typeof n.say === 'function' ? n.say() : n.text ?? '') : null, compose: !!FS.compose, hand: sub?.kind === 'host' ? String(sub.host.id) : sub?.kind ?? null, selected: FS.selected?.idx ?? null };
    });
    assert.equal(after.compose, false, 'no order drafted');
    assert.match(String(after.note), said, `the reason is said on the map: ${after.note}`);
    // round 37: the host's own tag already says this reason under the host: the map says it ONCE (that tag, shaking), not
    // a second tag at the tapped tile. Read from the canvas: every drawn text of the reason, grouped by animation frame;
    // in no frame is it drawn at two places (the old code drew two tags in every frame while the note showed)
    const drawn = await page.evaluate(async src => {
      const re = new RegExp(src), rows = [];
      let frame = 0, on = true;
      const tick = () => { frame += 1; if (on) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const protos = [globalThis.CanvasRenderingContext2D?.prototype, globalThis.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean);
      const kept = protos.map(P => P.fillText);
      protos.forEach((P, i) => { P.fillText = function (t, x, y, ...r) { if (re.test(String(t))) rows.push({ frame, y: Math.round(y) }); return kept[i].call(this, t, x, y, ...r); }; });
      const { invalidate } = await import('/frontier/fstate.mjs');
      invalidate('map');
      await new Promise(r => setTimeout(r, 450));
      on = false; protos.forEach((P, i) => { P.fillText = kept[i]; });
      const per = new Map();
      for (const r of rows) { if (!per.has(r.frame)) per.set(r.frame, new Set()); per.get(r.frame).add(r.y); }
      return { calls: rows.length, frames: per.size, most: Math.max(0, ...[...per.values()].map(x => x.size)) };
    }, said.source);
    assert.ok(drawn.calls > 0, `the reason is drawn on the map (${JSON.stringify(drawn)})`);
    assert.equal(drawn.most, 1, `the reason is drawn at one place in each frame, not two (${JSON.stringify(drawn)})`);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/maptap-note-${lang}.png` });
    assert.equal(after.hand, host, 'the host stays in hand');
    // (the only request: the page's own catch-up request for a lagging province, made by an ordinary session whenever it
    //  sees one — not an order; the test held the province behind)
    assert.deepEqual(posts.filter(x => !x.endsWith('/f/nudge')), [], 'no order sent');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
