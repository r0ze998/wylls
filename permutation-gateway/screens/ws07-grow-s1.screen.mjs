// Workstream 07: the original whole game page on workstream 19's REAL herald answers for workstream 08's S1 world
// (frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json, 32e13f7c: the router's output for season 71,
// layout 2, ring 4 → 5 at 08's stages before · extended · opened · grown), as a connected player with no key
// (screens/ws07/nokey-page.mjs: the test wallet carries the golden's wallet address, nothing else), phone and desktop.
//
// A relay answers every /h/ path the golden has with its recorded status and body (b64 bodies as bytes) and any other
// /h/ path 404 NotFound, as the router does (19's s1Herald in web-frontier-map-contract does the same for the client
// alone); the page's own files come from the screens server. The viewer's Holding is at (4,0) site 0 and its host
// (spearmen) on (4,0) tile 0. At each stage, after a reload, through the page's own presses:
//   - the host's tile takes the host in hand (its march, return and dissolve in the bar);
//   - (5,0) tile 0 pressed with the host in hand: before growth the page answers on the map with the place's state
//     and opens no order card; grown, the order card opens with 08's route to the step (directions, 1320 s, (4,0) →
//     (5,0)) — planned by the page's own S1 kernel from the golden's ring seeds;
//   - the card's arrival turn lies in the golden Season's lead window (19's fc6b923b, lead 2..72); the page's beacon
//     check passes (the golden carries drand quicknet's public chain hash and key); "seal and depart" is enabled and
//     NEVER pressed. (An earlier golden had a zero lead window and a non-quicknet beacon; neither is judged on here.)
//   - cancel (やめる); a reload keeps the stage.
// What is not real here: paths the golden lacks (events, rosters, rings 0–2 overviews, neighbour provinces) answer 404 as the
// router would, and their console lines are the only errors allowed. Nothing is sealed, signed or sent.
//
// Run from this folder: node --test ws07-grow-s1.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import * as G from '../test/fixtures/frontier/growth-route.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json', import.meta.url)));
const HOST_TILE = { p: 4, q: 0, tile: 0 }, TARGET = { p: 5, q: 0, tile: 0 };
/** What the page says on the map for a press on (5,0) with the host in hand, before growth. */
const REFUSED = { extendable: /まだ地図の外/, unopened: /まだひらいていない土地です/, pending: /生まれるところです/ };

let srv, relay, browser, base, stage = 'before';
const missing = new Set();
before(async () => {
  srv = await startServer({ keyless: true });
  relay = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/h/')) {
      const a = GOLDEN.stages[stage][u.pathname];
      if (!a) { missing.add(u.pathname); res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"ok":false,"code":"NotFound"}'); }
      if (a.body?.b64 !== undefined) { res.writeHead(a.status, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }); return res.end(Buffer.from(a.body.b64, 'base64')); }
      res.writeHead(a.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(a.body));
    }
    const t = new URL(srv.url);
    const pr = request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(pr);
  });
  await new Promise(r => relay.listen(0, r));
  base = NK.pageBase(relay.address().port);
  browser = await chromium.launch(NK.launchOptions(relay.address().port));
});
after(async () => { await browser?.close(); relay?.close(); await srv?.close(); });

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
  while (Date.now() < end) { if (await page.evaluate(fn, arg)) return; await page.waitForTimeout(200); }
  throw new Error(`until: timed out (${JSON.stringify(await state(page).catch(e => e.message))})`);
}
const state = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  const { subjectOf } = await import('/frontier/hud/hand.mjs');
  const W = await import('/frontier/map/world.mjs');
  const s = subjectOf(FS), c = FS.compose;
  return { place5: W.placeNow(FS, 5, 0), who: s ? (s.kind === 'village' ? 'village' : String(s.host.id)) : null, note: FS.mapNote?.text ?? null,
    lead: [FS.season?.minLead, FS.season?.maxLead],
    compose: c ? { dest: c.dest ? [c.dest.p, c.dest.q, c.dest.tile] : null, route: c.route ? { dirs: [...c.route.dirs], secs: c.route.secs, provinces: c.route.provinces.map(x => ({ p: x.p, q: x.q })) } : null } : null };
});

for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  test(`19's S1 herald answers, 08's stages @ ${vp.name}: the host at (4,0) in hand, (5,0) refused until grown, then 08's route in the order card (not sealed)`, { timeout: 300_000 }, async () => {
    const phone = vp.width < 760;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
    await NK.prepare(ctx, { wallet: GOLDEN.wallet }, { lang: 'ja' });
    const page = await ctx.newPage();
    const tap = async at => { const p = await tileAt(page, at); if (phone) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); };
    const press = loc => (phone ? loc.tap() : loc.click());
    const bringIntoView = async at => {
      for (let i = 0; i < 12; i++) {
        // (below any error banner the page shows at the top of the map)
        const p = await tileAt(page, at), w = vp.width, top = 40 + await page.evaluate(() => Math.max(150, ...[...document.querySelectorAll('.banner.error')].map(e => e.getBoundingClientRect()).filter(r => r.height > 0).map(r => r.bottom))), bottom = await page.evaluate(() => Math.min(innerHeight, document.getElementById('hand')?.getBoundingClientRect().top ?? innerHeight)) - 40;
        if (p.x > 40 && p.x < w - 40 && p.y > top && p.y < bottom) return;
        // (the map pans by its keys, UX design 6: focus the board, an arrow per step)
        await page.locator('#frontier-map').focus();
        const key = p.x >= w - 40 ? 'ArrowRight' : p.x <= 40 ? 'ArrowLeft' : p.y <= top ? 'ArrowUp' : 'ArrowDown';
        for (let k = 0; k < 3; k++) await page.keyboard.press(key);
        await page.waitForTimeout(400);
      }
      const p = await tileAt(page, at);
      assert.ok(p.x > 0 && p.x < vp.width, `the target in view (${Math.round(p.x)},${Math.round(p.y)})`);
    };
    const errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    // (the router's 404 for paths the golden lacks are the only console errors allowed: "Failed to load resource … 404")
    page.on('console', m => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    const seasonRec = GOLDEN.stages.before['/h/season'].body;
    await page.clock.setFixedTime(new Date(Number(seasonRec.latestUnix) * 1000 + 500));
    const url = `${base}/frontier/index.html?at=${HOST_TILE.p},${HOST_TILE.q},${HOST_TILE.tile},${phone ? '0.55' : '1.0'}`;

    for (const st of G.STAGE_ORDER) {
      stage = st;
      await page.goto(url);
      await until(page, async () => { const { FS } = await import('/frontier/fstate.mjs'); return FS.meStatus === 'ready' && (FS.holdings?.length ?? 0) > 0; }, null, { timeout: 30_000 });
      await until(page, async n => (await import('/frontier/fstate.mjs')).FS.record?.rings?.length === n, GOLDEN.stages[st]['/h/season'].body.rings.length);
      // the host's tile: the host in hand (the page's own hosts list says it is there)
      await until(page, async id => (await import('/frontier/hud/hand.mjs')).ownHosts((await import('/frontier/fstate.mjs')).FS).some(r => String(r.id) === id), String(GOLDEN.host));
      // (the rules module loaded first: a press before it is answered "ルールを読み込んでいます", as the page means it to)
      await until(page, async () => !!(await import('/frontier/fstate.mjs')).FS.kernel, null, { timeout: 30_000 });
      const inHand = () => page.evaluate(async id => { const { FS } = await import('/frontier/fstate.mjs'); const s = (await import('/frontier/hud/hand.mjs')).subjectOf(FS); return s?.kind === 'host' && String(s.host.id) === id; }, String(GOLDEN.host));
      // (the host's tile pressed until the host has the hand — a press there may first select the tile or the village)
      for (let i = 0; i < 3 && !(await inHand()); i++) { await tap(HOST_TILE); await page.waitForTimeout(600); }
      assert.equal(await inHand(), true, `${st}: the host at (4,0) tile 0 in hand`);
      await page.locator('#hand [data-hand="march"]').first().waitFor();
      // (5,0) tile 0 — on a phone it lies off the right edge: the map is dragged until it is in view, as a player pans
      // (the host stays in hand)
      await bringIntoView(TARGET);
      await tap(TARGET);
      const want = G.EXPECT[st];
      if (want.place !== 'open') {
        await until(page, async () => !!(await import('/frontier/fstate.mjs')).FS.mapNote);
        const s = await state(page);
        assert.equal(s.place5, want.place, `${st}: (5,0) is ${want.place}`);
        assert.match(s.note, REFUSED[want.place], `${st}: said on the map (${s.note})`);
        assert.equal(s.compose, null, `${st}: no order card into a ring not grown`);
        continue;
      }
      // grown: the order card with 08's route, by the page's own kernel. The map's planner loads on the first route
      // asked for: a first press may be answered "ルールを読み込んでいます" (always on a phone: no pointer hovers first);
      // the press again then asks for the route again and opens the card (it used to select the tile and drop the host)
      await until(page, async () => { const { FS } = await import('/frontier/fstate.mjs'); return !!FS.compose || !!FS.mapNote; });
      const waited = (await state(page)).note === 'ルールを読み込んでいます';
      if (phone) assert.equal(waited, true, 'on a phone the first press meets the planner loading');
      if (waited) {
        await page.waitForTimeout(1500);
        await tap(TARGET);
      }
      await until(page, async () => !!(await import('/frontier/fstate.mjs')).FS.compose?.route);
      const s = await state(page);
      assert.equal(s.place5, 'open');
      assert.deepEqual(s.compose.dest, [TARGET.p, TARGET.q, TARGET.tile]);
      assert.deepEqual(s.compose.route, { dirs: G.ROUTE.dirs, secs: G.ROUTE.secs, provinces: G.ROUTE.provinces }, '08\'s route to the step');
      await page.locator('#mc-title').waitFor({ state: 'attached' });
      await until(page, async () => Number.isInteger((await import('/frontier/fstate.mjs')).FS.compose?.arriveBell));
      // the arrival: the golden Season's lead window (19's fc6b923b: CreateSeason's MC_LOCAL_7D write, lead 2..72) holds
      // the card's turn
      const arr = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); const c = FS.compose; return { bell: c.arriveBell, earliest: c.earliest, minLead: Number(FS.season.minLead), maxLead: Number(FS.season.maxLead), now: FS.nowBell ?? 0, beacon: FS.error?.code ?? null }; });
      assert.ok(arr.maxLead > 0, `a lead window (${arr.minLead}..${arr.maxLead})`);
      assert.ok(arr.bell >= arr.earliest && arr.bell <= arr.now + arr.maxLead, `the card's turn ${arr.bell} in its window (earliest ${arr.earliest})`);
      assert.doesNotMatch(await page.locator('#panel').innerText(), /そのターンには着けません/);
      // the page's own beacon check passes on this golden (drand quicknet's public chain hash and key): the card is
      // ready to seal — "seal and depart" enabled, and NEVER pressed. (Nothing in the page's check is loosened or hidden.)
      assert.equal(arr.beacon, null, 'the page\'s beacon check passes (quicknet)');
      await page.locator('[data-act="march-send"]:not([disabled])').waitFor({ timeout: 15_000 });
      // cancel; a reload keeps the stage and no card
      await press(page.locator('[data-act="compose-close"]:visible').first());
      await page.waitForFunction(() => !document.getElementById('mc-title'));
      await page.reload();
      await until(page, async () => (await import('/frontier/fstate.mjs')).FS.record?.rings?.length === 6);
      assert.equal((await state(page)).compose, null);
      assert.equal((await state(page)).place5, 'open');
    }

    assert.deepEqual(posts, [], 'no request but reads');
    assert.deepEqual(errors, [], 'no page error, and no console error but the router\'s 404s');
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });
}
