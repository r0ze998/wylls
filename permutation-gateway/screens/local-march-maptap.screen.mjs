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
