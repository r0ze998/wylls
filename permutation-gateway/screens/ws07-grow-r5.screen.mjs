// Workstream 07: workstream 08's ring 4 → grown ring 5 contract (test/fixtures/frontier/growth-route.mjs, 6507c519)
// on the WHOLE game page, as a connected player with no key (screens/ws07/nokey-page.mjs), on a phone and a desktop.
//
// The fixture server's season record goes through 08's `withGrowth(record, stage)` (srv.seasonWith, opt-in): the
// growth fields of one of four stages (before · extended · opened · grown: rMax, the seeded rings with seed
// sha256("ring"+d), ringsOpened, ringProvinces, ceiling 6, hard 128). Its other fields (the screens world's M1 Season
// bytes, clock, ids) are the fixture's own; a ring's overview answers once the record lists its seed (the screens
// fixture's synthetic overview: owners are not 19's golden yet). At each stage, after a reload, the page:
//   - says what (4,0) … (7,0) are (map/world.mjs placeNow) exactly as 08's EXPECT: (5,0) extendable · unopened ·
//     pending · open; (4,0) open throughout; (6,0) extendable and (7,0) beyond the ceiling;
//   - names (5,0) tile 0 in the inspector by that state — and only when grown, by its terrain (never known empty land);
//   - plans (4,0) tile 0 → (5,0) tile 0 with ITS OWN kernel and ring seeds: NoPath until grown, then 08's ROUTE
//     (directions, seconds, provinces) to the step.
// The world grows while the page is open (opened → grown): the page's own season poll brings (5,0) in, no reload;
// a reload keeps it. What this does not do: an order card from a host at (4,0) — the screens world's viewer has no
// host there; that needs workstream 19's S1 golden (a Holding and hosts at (4,0), layout-2 Provinces). Nothing is
// sealed, signed or sent; no march has left. No request but reads, no page or console error, no key use.
//
// Run from this folder: node --test ws07-grow-r5.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import * as W from './world.mjs';
import * as G from '../test/fixtures/frontier/growth-route.mjs';

let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  srv.stage('holding');
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { srv?.seasonWith(null); await browser?.close(); await srv?.close(); });

const STATE_WORDS = { extendable: /第5輪（広げられるが、まだ地図の外）/, unopened: /第5輪（まだひらいていません）/, pending: /第5輪（生まれるところです）/, open: /^\S+ \S+方面・第5輪の州/ };

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
async function until(page, fn, arg, { timeout = 15_000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await page.evaluate(fn, arg)) return; await page.waitForTimeout(250); }
  throw new Error('until: timed out');
}
/** What the page says of the four provinces, and its own kernel's route ORIGIN → TARGET. */
const look = page => page.evaluate(async ([O, T]) => {
  const { FS } = await import('/frontier/fstate.mjs');
  const Wd = await import('/frontier/map/world.mjs');
  const { kernel } = await import('/frontier/wasm.mjs');
  const { planRoute } = await import('/frontier/fmarch.mjs');
  const places = Object.fromEntries([[4, 0], [5, 0], [6, 0], [7, 0]].map(([p, q]) => [`${p},${q}`, Wd.placeNow(FS, p, q)]));
  const k = await kernel();
  const r = planRoute(k, { from: O, to: T, unit: 0, seeds: FS.record.rings.map(x => ({ ring: x.d, seed: x.seed })) });
  return { places, route: r.ok ? { dirs: [...r.route.dirs], secs: r.route.secs, provinces: r.route.provinces.map(x => ({ p: x.p, q: x.q })) } : r.code };
}, [G.ORIGIN, G.TARGET]);

for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  test(`08's growth stages @ ${vp.name}: (5,0) extendable → unopened → pending → open, its inspector, and the page kernel's route`, { timeout: 300_000 }, async () => {
    const phone = vp.width < 760;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
    await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
    const page = await ctx.newPage();
    const errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.clock.setFixedTime(new Date(W.LATEST_UNIX * 1000 + 500));
    const url = `${base}/frontier/index.html?at=${G.TARGET.p},${G.TARGET.q},${G.TARGET.tile},1.0`;
    const inspect = async () => {
      const p = await tileAt(page, G.TARGET);
      if (phone) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
      await until(page, async () => /第5輪/.test(document.getElementById('panel-body')?.innerText ?? ''));
      return (await page.locator('#panel-body').innerText()).replace(/\s+/g, ' ').trim();
    };

    for (const stage of G.STAGE_ORDER) {
      srv.seasonWith(r => G.withGrowth(r, stage));
      await page.goto(url);
      await page.waitForFunction(() => document.body.dataset.stage === 'final');
      await until(page, async n => (await import('/frontier/fstate.mjs')).FS.record?.rings?.length === n, G.growthFields(stage).rings.length);
      const s = await look(page);
      const want = G.EXPECT[stage];
      assert.deepEqual(s.places, { '4,0': 'open', '5,0': want.place, '6,0': 'extendable', '7,0': 'beyondCeiling' }, `${stage}: what the page says the provinces are`);
      if (want.route === 'NoPath') assert.equal(s.route, 'NoPath', `${stage}: no route into ring 5`);
      else assert.deepEqual(s.route, { dirs: G.ROUTE.dirs, secs: G.ROUTE.secs, provinces: G.ROUTE.provinces }, `${stage}: 08's route, by the page's kernel`);
      const panel = await inspect();
      assert.match(panel, STATE_WORDS[want.place], `${stage}: the inspector (${panel.slice(0, 60)})`);
      if (want.place !== 'open') assert.match(panel, /^\S+方面・第5輪の州/, `${stage}: no terrain named before the ring is grown`);
    }

    // the world grows while the page is open: opened → grown by the page's own season poll (no reload)
    srv.seasonWith(r => G.withGrowth(r, 'opened'));
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.stage === 'final');
    assert.equal((await look(page)).places['5,0'], 'pending');
    srv.seasonWith(r => G.withGrowth(r, 'grown'));
    await until(page, async () => (await import('/frontier/fstate.mjs')).FS.record.rings.length === 6, null, { timeout: 45_000 });
    let s = await look(page);
    assert.equal(s.places['5,0'], 'open', 'grown by the poll');
    assert.deepEqual(s.route.dirs, G.ROUTE.dirs);
    // a reload keeps it
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.stage === 'final');
    await until(page, async () => (await import('/frontier/fstate.mjs')).FS.record?.rings?.length === 6);
    s = await look(page);
    assert.equal(s.places['5,0'], 'open');

    srv.seasonWith(null);
    assert.deepEqual(posts, [], 'no request but reads');
    assert.deepEqual(errors, [], 'no page or console error');
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });
}
