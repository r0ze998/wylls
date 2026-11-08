// Workstream 07: the four conquest reads of the original whole game page on workstream 19's REAL herald answers for
// workstream 08's S1 world (frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json, 19's a41d1cd2, stage
// "grown"; the four answers are the same at every stage), as a connected player with no key (screens/ws07/nokey-page.mjs:
// the test wallet carries the golden's wallet address, nothing else), on a desktop and a phone.
//
// The same relay as ws07-grow-s1 (every /h/ path from the golden with its recorded status and body; any other /h/ path
// 404 NotFound, asserted never to happen here). What each read is and what the page must make of it, by its existing
// rules (controller.mjs refreshConquest · refreshKeepEvents · wantKeepHistory; screens/conquest.mjs) — the expectation is
// taken from the golden's status, never assumed:
//   - /h/conquest/0.json (refreshKeepEvents → herald.conquestDay → parseConquestDay): 200 → FS.conquest.events is the
//     day's events as the page's own parser reads them (a41d1cd2: none); a 404 would leave it [] as well, so the read
//     itself is asserted to have answered 200.
//   - /h/control/latest.bin: 404 NotYet (no bell resolved in this world). herald.get maps a 404 to NotFound; at a bell
//     within the first reveal window and with no control read before, refreshConquest says "loading", never the error
//     line 領土の最新情報を取得できませんでした. A 200 would be "ready" with its bell.
//   - /h/standings/latest.json: 404 NotYet. No standings: no "provinces held" strip under the top bar, and the territory
//     tab says the score is being read (確定した得点を読み込んでいます / its continuous-world wording) — no table, no
//     number, not the read-failure line. A 200 would be the page's territoryStandings of it, drawn as the table.
//   - /h/keep/4,0.json, asked when (4,0) is selected (wantKeepHistory): 404 NoSuchKeep. A FIXTURE GAP (19): the fixture
//     writes (4,0)'s keep into the Province bytes but not the KEEP (PLACED) record the program's OpenProvince emits, so a
//     real chain would answer 200. Asserted only: the page handles the router's 404 (the history entry carries no
//     holders, no 砦の履歴 section, no error) — NOT that (4,0) has no keep. When 19's fixture carries the record, the
//     200 branch checks the ledger rows against the page's own keepHistory of the golden body.
//   - the keep panel of (4,0) (inspector, renderKeep) comes from the Province record's keep (keepFromProvince), not from
//     /h/keep: its garrison and holder are asserted equal to what the page derives from that record. (Its first refresh
//     reads the village's Province before FS.conquest exists, so the keep enters FS.conquest.keeps on the next poll,
//     at most 10 s later — waited for, by the page's own poll; not a claim about the page's correctness.)
// No request but reads, no page error, no console error but the router's 404s, no key use. Nothing is ordered, sealed,
// signed or sent; no march is composed.
//
// Run from this folder: node --test ws07-conquest-s1.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json', import.meta.url)));
const STAGE = 'grown';
const A = GOLDEN.stages[STAGE];
const P = { conquest: '/h/conquest/0.json', control: '/h/control/latest.bin', standings: '/h/standings/latest.json', keep: '/h/keep/4,0.json' };
const KEEP_TILE = { p: 4, q: 0, tile: 1 };
for (const [k, p] of Object.entries(P)) assert.ok(A[p] && [200, 404].includes(A[p].status), `the golden carries the router's answer for ${k} (${p})`);
const ROUTER_404 = new Set(Object.entries(A).filter(([, a]) => a.status === 404).map(([p]) => p));

let srv, relay, browser, base;
const missing = new Set();
before(async () => {
  srv = await startServer({ keyless: true });
  relay = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/h/')) {
      const a = A[u.pathname];
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
  while (Date.now() < end) { if (await page.evaluate(fn, arg)) return; await page.waitForTimeout(250); }
  throw new Error('until: timed out');
}
/** What the page holds of the four reads, and what its own parsers make of the golden's bodies (no value made up here). */
const conquestState = page => page.evaluate(async bodies => {
  const { FS } = await import('/frontier/fstate.mjs');
  const { parseConquestDay } = await import('/frontier/herald.mjs');
  const { territoryStandings, keepFromProvince, mergeKeepEvents } = await import('/frontier/fconquest.mjs');
  const { worldContinues } = await import('/frontier/clock.mjs');
  const cq = FS.conquest, json = v => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x)));
  const prov = FS.provinces.get('4,0')?.province ?? null;
  return {
    status: cq?.status ?? null, error: cq?.error ?? null, control: cq?.control ? { bell: cq.control.bell } : null,
    standings: json(cq?.standings ?? null), events: json(cq?.events ?? null),
    wantEvents: json(mergeKeepEvents([], bodies.conquest ? parseConquestDay(bodies.conquest).events : [])),  // (as refreshKeepEvents stores them)
    wantStandings: bodies.standings ? json(territoryStandings(bodies.standings)) : null,
    keep: json(cq?.keeps?.get?.('4,0') ?? null), keepOfProvince: json(prov ? keepFromProvince(prov) : null),
    history: json(cq?.history?.get?.('4,0') ?? null),
    nowBell: FS.nowBell, fresh: FS.nowBell <= 1 + Math.ceil(Number(FS.season?.revealWindow ?? 600) / Number(FS.season?.bellSecs ?? 600)),
    continuous: worldContinues(FS.season), faction: FS.citizen?.faction ?? null,
    strips: document.querySelectorAll('.ps').length,
  };
}, { conquest: A[P.conquest].status === 200 ? A[P.conquest].body : null, standings: A[P.standings].status === 200 ? A[P.standings].body : null });

for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  test(`19's S1 herald, the four conquest reads @ ${vp.name}: conquest day, control and standings as the page's rules say; the (4,0) keep panel and the router's keep 404 (a fixture gap, not "no keep")`, { timeout: 240_000 }, async () => {
    const phone = vp.width < 760;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, locale: 'ja-JP', timezoneId: 'UTC' });
    await NK.prepare(ctx, { wallet: GOLDEN.wallet }, { lang: 'ja' });
    const page = await ctx.newPage();
    const press = loc => (phone ? loc.tap() : loc.click());
    const errors = [], posts = [], notFound = new Set(), answered = new Map();
    page.on('pageerror', e => errors.push(e.message));
    // (the router's 404s are the only console errors allowed: "Failed to load resource … 404")
    page.on('console', m => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    page.on('response', r => { const path = new URL(r.url()).pathname; if (r.status() === 404) notFound.add(path); if (Object.values(P).includes(path)) answered.set(path, [...(answered.get(path) ?? []), r.status()]); });
    const seasonRec = GOLDEN.stages.before['/h/season'].body;  // (the same clock as ws07-grow-s1)
    await page.clock.setFixedTime(new Date(Number(seasonRec.latestUnix) * 1000 + 500));
    await page.goto(`${base}/frontier/index.html?at=${KEEP_TILE.p},${KEEP_TILE.q},${KEEP_TILE.tile},${phone ? '0.55' : '1.0'}`);
    await until(page, async () => { const { FS } = await import('/frontier/fstate.mjs'); return FS.meStatus === 'ready' && (FS.holdings?.length ?? 0) > 0; }, null, { timeout: 30_000 });
    // the conquest refresh has read control, standings and the conquest day (events set by refreshKeepEvents)
    await until(page, async () => Array.isArray((await import('/frontier/fstate.mjs')).FS.conquest?.events), null, { timeout: 30_000 });
    for (const k of ['conquest', 'control', 'standings']) assert.deepEqual([...new Set(answered.get(P[k]) ?? [])], [A[P[k]].status], `${k}: read, and answered as the golden records (${A[P[k]].status})`);

    let s = await conquestState(page);
    // conquest day 0
    assert.equal(A[P.conquest].status, 200, '(a41d1cd2: the conquest day answers 200)');
    assert.deepEqual(s.events, s.wantEvents, 'the keep events are the day\'s, as the page\'s own parser reads them');
    // control
    if (A[P.control].status === 404) {
      assert.equal(s.fresh, true, `(the first reveal window: bell ${s.nowBell})`);
      assert.deepEqual([s.status, s.error, s.control], ['loading', null, null], 'no control snapshot yet: "loading", never the read-failure line');
    } else {
      assert.equal(s.status, 'ready');
      assert.ok(Number.isInteger(s.control?.bell), 'a control snapshot with its bell');
    }
    // standings
    if (A[P.standings].status === 404) {
      assert.equal(s.standings, null, 'no standings record: none held');
      assert.equal(s.strips, 0, 'no "provinces held" strip (no number made up)');
    } else assert.deepEqual(s.standings, s.wantStandings, 'the standings as the page\'s territoryStandings reads them');

    // the territory tab: what it says of the score
    await press(page.locator('[data-act="tab"][data-tab="territory"]:visible').first());
    await until(page, () => !!document.querySelector('#panel .conquest-standings'));
    const standingsText = (await page.locator('#panel .conquest-standings').innerText()).replace(/\s+/g, ' ');
    assert.doesNotMatch(standingsText, /読み込めませんでした/, 'not the read-failure line');
    if (s.standings === null) {
      assert.match(standingsText, s.continuous ? /州・時間の記録を読み込んでいます。/ : /確定した得点を読み込んでいます。/, `the score is being read (${standingsText.slice(0, 120)})`);
      assert.equal(await page.locator('#panel .conquest-scores').count(), 0, 'no score table');
    } else assert.equal(await page.locator('#panel .conquest-scores tbody tr').count(), 6, 'the six nations\' rows');
    if (s.status === 'loading') assert.equal(await page.locator('#panel [data-act="cq-refresh"]').isDisabled(), true, 'refresh waits while loading (the page\'s rule)');
    assert.doesNotMatch(await page.locator('#panel').innerText(), /領土の最新情報を取得できませんでした/);

    // back to the map; the (4,0) keep from its Province record (the page's next poll, at most 10 s)
    const map = page.locator('[data-act="tab"][data-tab="map"]:visible').first();
    if (await map.count()) await press(map);
    await until(page, async () => (await import('/frontier/fstate.mjs')).FS.conquest?.keeps?.has?.('4,0'), null, { timeout: 30_000 });
    s = await conquestState(page);
    assert.ok(s.keepOfProvince, 'the (4,0) Province record carries a keep');
    assert.deepEqual({ tile: s.keep.tile, holder: s.keep.holder, troops: s.keep.troops }, { tile: s.keepOfProvince.tile, holder: s.keepOfProvince.holder, troops: s.keepOfProvince.troops }, 'the page\'s keep is the Province record\'s');
    assert.equal(s.keep.tile, KEEP_TILE.tile);

    // select the keep's tile (in view, above the sheet on a phone), as a player does
    for (let i = 0; i < 12; i++) {
      const p = await tileAt(page, KEEP_TILE), bottom = await page.evaluate(() => Math.min(innerHeight, document.getElementById('hand')?.getBoundingClientRect().top ?? innerHeight, ...[...document.querySelectorAll('#panel')].map(e => e.getBoundingClientRect()).filter(r => r.height > 0 && r.width >= innerWidth - 2).map(r => r.top))) - 40;
      const top = 40 + await page.evaluate(() => Math.max(150, ...[...document.querySelectorAll('.banner.error')].map(e => e.getBoundingClientRect()).filter(r => r.height > 0).map(r => r.bottom)));
      if (p.x > 40 && p.x < vp.width - 40 && p.y > top && p.y < bottom) break;
      await page.locator('#frontier-map').focus();
      const key = p.x >= vp.width - 40 ? 'ArrowRight' : p.x <= 40 ? 'ArrowLeft' : p.y <= top ? 'ArrowUp' : 'ArrowDown';
      for (let k = 0; k < 3; k++) await page.keyboard.press(key);
      await page.waitForTimeout(400);
    }
    const at = await tileAt(page, KEEP_TILE);
    if (phone) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
    await until(page, async t => { const s = (await import('/frontier/fstate.mjs')).FS.selected; return s?.p === t.p && s?.q === t.q && s?.idx === t.tile; }, KEEP_TILE);
    // the keep panel: its garrison and holder as the record says
    await until(page, () => !!document.querySelector('#panel-body .conquest-keep'));
    const want = await page.evaluate(async k => {
      const { factionName } = await import('/frontier/fi18n.mjs');
      const { fmtNum } = await import('/lang.mjs');
      const { FS } = await import('/frontier/fstate.mjs');
      return { troops: fmtNum(k.troops), holder: k.holder === FS.citizen?.faction ? 'あなたの国が保持' : `${k.holder < 6 ? factionName(k.holder) : '中立'}が保持` };
    }, s.keep);
    assert.equal((await page.locator('#panel-body .conquest-keep .kp-def .num').innerText()).trim(), want.troops, 'the garrison of the record');
    assert.equal((await page.locator('#panel-body .conquest-keep .kp-holder').innerText()).trim(), want.holder, 'the holder of the record');

    // /h/keep/4,0.json, asked for the selected province
    await until(page, async () => (await import('/frontier/fstate.mjs')).FS.conquest?.history?.has?.('4,0'), null, { timeout: 20_000 });
    assert.deepEqual([...new Set(answered.get(P.keep) ?? [])], [A[P.keep].status], `keep 4,0: read, and answered as the golden records (${A[P.keep].status})`);
    s = await conquestState(page);
    if (A[P.keep].status === 404) {
      // the router's 404 (a fixture gap: no KEEP record in the fixture) — handled: no ledger, no error. Not "no keep".
      assert.deepEqual(Object.keys(s.history).sort(), ['asOf'], 'the 404 kept as "read at this bell", with no holders');
      assert.equal(await page.locator('#panel-body .kp-history').count(), 0, 'no 砦の履歴 from a 404');
    } else {
      const rows = await page.evaluate(async body => { const { keepHistory } = await import('/frontier/screens/conquest.mjs'); const h = keepHistory(body); return h ? (h.all ?? h.rows).length : 0; }, A[P.keep].body);
      assert.equal(await page.locator('#panel-body .kp-history .kp-hist li').count(), rows, 'the ledger rows of the record');
    }

    assert.deepEqual([...missing].sort(), [], 'every /h/ path the page asked for is in the golden');
    assert.deepEqual([...notFound].filter(p => !ROUTER_404.has(p)).sort(), [], 'every 404 is the router\'s own (from the golden)');
    assert.deepEqual(posts, [], 'no request but reads');
    assert.deepEqual(errors, [], 'no page error, and no console error but the router\'s 404s');
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });
}
