// Workstream 07: the game's own map and march order across a ring the world GROWS into, on the WHOLE page, as a
// connected player with no key (screens/ws07/nokey-page.mjs), on a phone and on a desktop.
//
// Workstream 08 verified, with the real frontier.wasm route planner, a march from ring 4 into a ring added by map growth
// once that ring's seed is known, and none before (test/web-frontier-live-map.test.mjs). This file takes the same path
// through the existing page. The fixture world seeds rings 0–2 (rMax 16); the viewer's village is in ring 2, so its
// next ring, 3, is the ring that grows here: the server's OPT-IN `openRings(4)` adds ring 3's seed to the season record
// (the fixture's own pattern, ring d's seed = byte d+1 repeated) and lets ring 3's overview and roster answer, as a
// herald does once the ring is opened. No terrain, rule or route is made here: the page's kernel plans from the seed.
//
//   before growth: ring 3 is unopened — a tap with the spearmen in hand is answered "まだひらいていない土地です" and no
//                  order card opens; the inspector says 第3輪（まだひらいていません）, never known empty land;
//   the world grows while the page is open: the page's own 30 s season poll (app.mjs loadSeason → applySeasonRecord)
//                  brings ring 3 in, no reload;
//   after growth:  the inspector names the tile's terrain and its ring-3 province (unsurveyed); the spearmen in hand
//                  and a ring-3 tile give the order card with a route from the home province into ring 3, its arrival
//                  turn, and "seal and depart" enabled — NOT pressed; another ring-3 tile changes the destination;
//                  cancel; back/forward and a reload: ring 3 stays open, no card.
// A response for another world is not stamped onto this one (map/world.mjs overviewTaken: web-frontier-world-growth).
// The default server (openRings unset) is byte-identical (checked first). No request but reads, no page or console
// error, no key use. Nothing is sealed, signed or sent: no march has left, and none has arrived.
//
// Run from this folder: node --test ws07-grow.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import * as W from './world.mjs';

/** The default answers of every stage (recorded at 6de240aa; ws07-wide.screen.mjs checks the same value). */
const DEFAULT_SHA = '8e00cf59e5a91705454cab58b12bccdf63c8d2aa18de08587bea64ea9cee0e5b';
/** The ring-3 provinces next to the viewer's village (ring 2, province 2,0). */
const RING3 = [{ p: 3, q: 0 }, { p: 3, q: -1 }, { p: 2, q: 1 }];

let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { srv?.openRings(null); await browser?.close(); await srv?.close(); });

async function defaultHash() {
  const paths = v => [`/h/me/${v.wallet}`, '/h/season', '/h/province/2,0/latest', '/h/events', '/coop/config', '/h/overview/2/latest.bin', '/h/roster/2/latest.bin'];
  const all = createHash('sha256');
  for (const st of W.STAGES) {
    srv.stage(st);
    for (const p of paths(srv.viewer)) { const r = await fetch(srv.url + p); all.update(`${st} ${p} ${r.status} `).update(Buffer.from(await r.arrayBuffer())); }
  }
  return all.digest('hex');
}

test('the default server is byte-identical: openRings unset, and set then removed', async () => {
  assert.equal(await defaultHash(), DEFAULT_SHA);
  srv.openRings(4);
  assert.equal((await (await fetch(`${srv.url}/h/season`)).json()).rings.length, 4, '(set: ring 3 is opened)');
  assert.equal((await fetch(`${srv.url}/h/overview/3/latest.bin`)).status, 200);
  srv.openRings(null);
  assert.equal((await fetch(`${srv.url}/h/overview/3/latest.bin`)).status, 404);
  assert.equal(await defaultHash(), DEFAULT_SHA, 'removed again');
});

/** Where a tile is seen now (viewport px), once the camera rests. */
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
/** Poll an async page function until it answers true. */
async function until(page, fn, arg, { timeout = 15_000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await page.evaluate(fn, arg)) return; await page.waitForTimeout(200); }
  throw new Error('until: timed out');
}
const ready = page => page.waitForFunction(() => document.body.dataset.stage === 'final');
const state = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  const c = FS.compose;
  return { rings: FS.record?.rings?.length ?? 0, note: FS.mapNote?.text ?? null, sel: FS.selected ? [FS.selected.p, FS.selected.q, FS.selected.idx] : null,
    compose: c ? { dest: c.dest ? [c.dest.p, c.dest.q, c.dest.tile] : null, route: c.route?.provinces?.map(x => `${x.p},${x.q}`) ?? null, bell: c.arriveBell ?? null, earliest: c.earliest ?? null } : null,
    panel: (document.getElementById('panel-body')?.innerText ?? '').replace(/\s+/g, ' ') };
});

for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  test(`the map grows by a ring @ ${vp.name}: unopened before, in by the page's own poll, a march order into it (not sent)`, { timeout: 240_000 }, async () => {
    const phone = vp.width < 760;
    srv.stage('holding');
    srv.openRings(null);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
    await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
    const page = await ctx.newPage();
    const tap = async at => { const p = await tileAt(page, at); if (phone) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); };
    const press = loc => (phone ? loc.tap() : loc.click());
    const errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.clock.setFixedTime(new Date(W.LATEST_UNIX * 1000 + 500));
    const url = `${base}/frontier/index.html?at=${W.HOME.p},${W.HOME.q},${W.HOME.tile},0.8`;
    await page.goto(url); await ready(page);
    const spearmen = async () => {
      await tap(W.HOME);
      await page.locator('#hand [data-hand="build"]').waitFor();
      await press(page.locator('#hand .hand-chip[data-host]:not(.hand-back)', { hasText: '槍兵' }).first());
      await page.locator('#hand [data-hand="march"][aria-pressed="true"]').waitFor();
    };
    const clear = () => page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); FS.compose = null; FS.selected = null; FS.hand = null; FS.mapNote = null; FS.inspectOpen = false; });

    // ring-3 tiles seen in the free part of the screen with the spearmen in hand (two hexes or more from the village)
    await spearmen();
    const seen = [];
    const free = await page.evaluate(() => {
      const tops = ['hand', 'tabs'].map(id => document.getElementById(id)).filter(e => e && !e.hidden && e.getBoundingClientRect().height > 0).map(e => e.getBoundingClientRect().top);
      return { w: innerWidth, bottom: Math.min(innerHeight, ...tops) - 24 };
    });
    for (const pv of RING3) for (let t = 0; t < 61; t++) { const p = await tileAt(page, { ...pv, tile: t }); if (p.x > 24 && p.x < free.w - 24 && p.y > 140 && p.y < free.bottom) seen.push({ ...pv, tile: t }); }
    assert.ok(seen.length, 'ring-3 tiles in view');

    // ---- before growth: unopened, never known empty land
    let s = await state(page);
    assert.equal(s.rings, 3);
    await tap(seen[0]);
    await until(page, async () => !!(await import('/frontier/fstate.mjs')).FS.mapNote);
    s = await state(page);
    assert.deepEqual([s.note, s.compose], ['まだひらいていない土地です', null], 'refused on the map: no order card into an unopened ring');
    await clear();
    await tap(seen[0]);
    await until(page, async () => /まだひらいていません/.test(document.getElementById('panel-body')?.innerText ?? ''));
    await clear();

    // ---- the world grows while the page is open: in by the page's own season poll (every 30 s), no reload
    srv.openRings(4);
    await until(page, async () => (await import('/frontier/fstate.mjs')).FS.record.rings.length === 4, null, { timeout: 45_000 });
    // the tiles the page's kernel can reach in ring 3 now (its own route planner, from ring 3's seed)
    const reach = await page.evaluate(async tiles => {
      const { FS } = await import('/frontier/fstate.mjs');
      const { kernel } = await import('/frontier/wasm.mjs');
      const { planRoute } = await import('/frontier/fmarch.mjs');
      const { ownHosts } = await import('/frontier/hud/hand.mjs');
      const k = await kernel();
      const host = ownHosts(FS).find(r => r.unit === 0 && r.state === 1);
      const seeds = FS.record.rings.map(r => ({ ring: r.d, seed: r.seed }));
      return tiles.filter(t => planRoute(k, { from: { p: host.p, q: host.q, tile: host.tile }, to: t, unit: 0, seeds }).ok);
    }, seen);
    assert.ok(reach.length >= 2, `ring-3 tiles in reach and in view (${JSON.stringify(reach.slice(0, 4))})`);
    const [A, B] = reach;

    // the inspector: the tile's terrain and its ring-3 province (never "unopened" now)
    await tap(A);
    await until(page, async () => /第3輪の州/.test(document.getElementById('panel-body')?.innerText ?? ''));
    s = await state(page);
    assert.doesNotMatch(s.panel, /まだひらいていません/);
    assert.match(s.panel, /^\S+ \S+方面・第3輪の州/, `the tile's terrain, then its ring-3 province (${s.panel.slice(0, 60)})`);
    await clear();

    // the order card into ring 3: route from the home province, arrival turn, seal enabled (not pressed)
    await spearmen();
    await tap(A);
    await until(page, async () => !!(await import('/frontier/fstate.mjs')).FS.compose?.route);
    await page.locator('[data-act="march-send"]:not([disabled])').waitFor({ timeout: 15_000 });
    s = await state(page);
    assert.deepEqual(s.compose.dest, [A.p, A.q, A.tile]);
    assert.equal(s.compose.route[0], `${W.HOME.p},${W.HOME.q}`, 'from the village\'s province');
    assert.equal(s.compose.route.at(-1), `${A.p},${A.q}`, 'into the grown ring');
    assert.equal((await page.evaluate(async ([p, q]) => (await import('/frontier/fgeo.mjs')).ringOf(p, q), [A.p, A.q])), 3);
    assert.ok(Number.isInteger(s.compose.bell) && s.compose.bell >= s.compose.earliest, 'an arrival turn in its window');

    // another ring-3 tile: the destination changes (one card)
    await tap(B);
    await until(page, async b => { const c = (await import('/frontier/fstate.mjs')).FS.compose; return c?.dest?.p === b.p && c.dest.q === b.q && c.dest.tile === b.tile && !!c.route; }, B);
    assert.equal(await page.locator('#mc-title').count(), 1);

    // cancel
    await press(page.locator('[data-act="compose-close"]:visible').first());
    await page.waitForFunction(() => !document.getElementById('mc-title'));
    assert.equal((await state(page)).compose, null);

    // back/forward and a reload: ring 3 stays open (the herald says so), no card
    await page.goto(`${url}&ws07=2`); await ready(page);
    await page.goBack(); await ready(page);
    await page.goForward(); await ready(page);
    await page.reload(); await ready(page);
    await until(page, async () => (await import('/frontier/fstate.mjs')).FS.record?.rings?.length === 4);
    s = await state(page);
    assert.equal(s.compose, null, 'no card after a reload');

    srv.openRings(null);
    assert.deepEqual(posts, [], 'no request but reads: nothing sent');
    assert.deepEqual(errors, [], 'no page or console error');
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });
}
