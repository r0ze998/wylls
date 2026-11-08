// Workstream 07: the WHOLE page on an S1 season, in Chromium — a MIXED FIXTURE (混成 fixture): an S1 Season with the
// fixture's M1 accounts. The same flow on S1 accounts throughout is ws07-s1-pure.screen.mjs; neither is a chain.
// The fixture server (server.mjs, an M1 world) is put behind a small relay that answers, in its place:
//   /h/season                       the fixture's Season re-encoded at layout 2 with program_version 4 (S1)
//   /h/caravans.json, structures.json, nations.json
//                                   S1 feeds in the herald's shapes (two caravans of the viewer's, one past its turn)
//   /h/events                       the fixture's events and, after them, S1 records built from the v2 log table
//                                   (to the viewer's village: food 400 sent, 352 settled; to a storehouse: wood 300)
// Everything else — the viewer's Citizen, Holding and Provinces — is the fixture's M1 world (layout 1), so this is
// the page booted on an S1 season with S1 feeds, not an S1 world: no S1 account (layout-2 Holding or Province) and
// nothing recorded on a chain. What it shows: the away summary on the page's first look and "seen" by keyboard, a
// reload that keeps the mark; in the village drawer the S1 card with a caravan's arrival not verified; and, with
// workstreams 04, 05 and 01's sources registered as MOCKS, their states and the cooperation slot in the same card.
//
// Run from this folder: node --test ws07-s1-page.screen.mjs (WS07_SHOTS=<dir> also writes the screenshots there).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import * as W from './world.mjs';
import { decodeAccount, encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { LOGS } from '../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';

const SHOTS = process.env.WS07_SHOTS ?? null;
let srv, relay, base, browser, viewerTag = null;
const feeds = { caravans: null, structures: { v: 1, structures: [], sightings: [] }, nations: { v: 1, stances: Array.from({ length: 6 }, () => Array(6).fill(0)), proposals: [], expelled: [], domesticRaids: [] } };
let extra = [];

function body(name, bell, fields = {}) {
  const spec = LOGS.kinds.find(k => k.name === name), parts = [...spec.key, ...spec.payload];
  const b = new Uint8Array(6 + parts.reduce((a, f) => a + f.len, 0) + 1), v = new DataView(b.buffer);
  b[0] = 1; b[1] = spec.kind; v.setUint32(2, bell, true);
  let o = 6;
  for (const f of parts) { const x = fields[f.name]; if (x instanceof Uint8Array) b.set(x.subarray(0, f.len), o); else if (x !== undefined) { if (f.len === 8) v.setBigUint64(o, BigInt(x), true); else if (f.len === 4) v.setInt32(o, Number(x), true); else if (f.len === 2) v.setUint16(o, Number(x), true); else if (f.len === 1) b[o] = Number(x); } o += f.len; }
  return toBase64(b);
}
const cargo = arr => { const b = new Uint8Array(32), v = new DataView(b.buffer); arr.forEach((n, i) => v.setUint32(i * 4, n, true)); return b; };

before(async () => {
  srv = await startServer({ keyless: true });
  srv.stage('holding');
  const rec = W.seasonRecord();
  const s1Season = encodeAccount('Season', { ...decodeAccount('Season', Buffer.from(rec.bytes_b64, 'base64'), { profile: 1 }), PROGRAM_VERSION: 4, LAYOUT_VERSION: 2 }, { profile: 2 });
  const events = W.events(), last = BigInt(events.at(-1).seq);
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  relay = createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), path = u.pathname;
    if (path === '/h/season') return json(res, { ...rec, headSeq: String(last + BigInt(extra.length)), bytes_b64: Buffer.from(s1Season).toString('base64') });
    const m = /^\/h\/(caravans|structures|nations)\.json$/.exec(path);
    if (m && feeds[m[1]]) return json(res, feeds[m[1]]);
    if (path === '/h/events') {
      const after = BigInt(u.searchParams.get('after') ?? '0'), all = [...events, ...extra].filter(e => BigInt(e.seq) > after);
      return json(res, { v: 1, events: all, next: all.at(-1)?.seq ?? String(after), full: false });
    }
    const t = new URL(srv.url);
    const p = request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(p);
  });
  await new Promise(r => relay.listen(0, '127.0.0.1', r));
  // (workstream 07: the keyless whole page — ws07/nokey-page.mjs: not a loopback host, a test wallet with no key)
  base = NK.pageBase(relay.address().port);
  browser = await chromium.launch({ ...NK.launchOptions(relay.address().port), ...(process.env.WS07_CHROME ? { executablePath: process.env.WS07_CHROME } : {}) });
  // the viewer's tag and village, as the page reads them (a first load with the feeds empty)
  const ctx = await context({ width: 1440, height: 900 });
  const page = await ctx.newPage();
  await page.goto(`${base}/frontier/`);
  await untilPage(page, fsReady);
  const who = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); const { ownTag } = await import('/frontier/people/ui.mjs'); const h = FS.holdings[0]; return { tag: String(ownTag(FS)), bell: FS.nowBell, p: h.p, q: h.q, tile: h.tile, faction: FS.citizen.faction }; });
  await NK.assertKeyless(ctx, assert);
  await ctx.close();
  viewerTag = who.tag;
  const place = (kind, tile) => ({ kind, p: who.p, q: who.q, at: 2, gen: 1, tile });
  const road = { raided: false, path: Array(12).fill(0), provinces: [[who.p, who.q]], arriveTs: 0, src: place(1, who.tile), dst: place(2, 40) };
  feeds.caravans = { v: 1, vaults: [{ p: who.p, q: who.q, tile: 40, ownerTag: who.tag, faction: who.faction, gen: 1 }], moving: [
    { ...road, ownerTag: who.tag, seq: 2, faction: who.faction, steps: 7, cargo: [400, 0, 0, 0, 0, 0, 0, 0], runs: [{ p: who.p, q: who.q, firstBell: who.bell - 3, n: 2 }] },
    { ...road, ownerTag: who.tag, seq: 3, faction: who.faction, steps: 9, cargo: [0, 200, 0, 0, 0, 0, 0, 0], runs: [{ p: who.p, q: who.q, firstBell: who.bell, n: 6 }] }] };
  const s = n => String(last + BigInt(n));
  extra = [
    // to the viewer's village: sent 400, settled 352 (verified: a village takes in the record's cargo, holding.rs credit)
    { seq: s(1), slot: 1, sig: null, body_b64: body('CARAVAN_SENT', who.bell - 6, { owner_tag: who.tag, seq: 1, faction: who.faction, dst: 1, cargo: cargo([400, 0, 0, 0, 0, 0, 0, 0]) }) },
    { seq: s(2), slot: 2, sig: null, body_b64: body('CARAVAN_SETTLED', who.bell - 2, { owner_tag: who.tag, seq: 1, outcome: 0, dst: 1, cargo: cargo([352, 0, 0, 0, 0, 0, 0, 0]) }) },
    // to a storehouse: the record keeps the whole cargo whatever the vault's cap cut (not verified)
    { seq: s(3), slot: 3, sig: null, body_b64: body('CARAVAN_SENT', who.bell - 6, { owner_tag: who.tag, seq: 4, faction: who.faction, dst: 2, cargo: cargo([0, 300, 0, 0, 0, 0, 0, 0]) }) },
    { seq: s(4), slot: 4, sig: null, body_b64: body('CARAVAN_SETTLED', who.bell - 1, { owner_tag: who.tag, seq: 4, outcome: 0, dst: 2, cargo: cargo([0, 300, 0, 0, 0, 0, 0, 0]) }) },
  ];
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); relay?.close(); await srv?.close(); });

/** Wait until `check` (a page function: it reads the page's own modules, not the DOM) answers true. */
async function untilPage(page, check, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(check).catch(() => false)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${check}`);
    await page.waitForTimeout(250);
  }
}
const fsReady = async () => { const { FS } = await import('/frontier/fstate.mjs'); return FS.holdings?.length > 0 && FS.nowBell > 0 && !!FS.citizen; };
const s1Feeds = async () => { const { FS } = await import('/frontier/fstate.mjs'); return (FS.s1?.caravans?.moving?.length ?? 0) > 0; };
async function context(viewport) {
  const ctx = await browser.newContext({ viewport });
  await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
  return ctx;
}
// (the drawer is drawn again when the feeds come in: a card caught between two drawings is taken again)
const shot = async (target, name) => {
  if (!SHOTS) return;
  for (let i = 0; ; i++) {
    try { await target.screenshot({ path: join(SHOTS, `${name.replace('ws07-s1-page-', 'ws07-s1-mixed-')}.png`), timeout: 5000 }); return; } catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 300)); }
  }
};
const s1On = page => page.evaluate(async () => (await import('/frontier/fs1.mjs')).s1On());

const SIZES = [{ name: 'pc', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }];
for (const size of SIZES) {
  test(`${size.name} [mixed fixture: S1 Season, M1 accounts]: the page boots on an S1 season, tells what happened while away, and "seen" by keyboard holds over a reload`, async () => {
    const ctx = await context({ width: size.width, height: size.height });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${base}/frontier/`);
    const seen = page.locator('[data-act="away-seen"]:visible');
    await page.locator('[data-act="away-seen"]').first().waitFor({ state: 'attached', timeout: 30000 });
    assert.equal(await s1On(page), true, 'the page plays the S1 rules');
    const feedText = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return (FS.feed ?? []).filter(x => x.away || x.awayOf).map(x => x.text).join('\n'); });
    assert.match(feedText, /直近 144 ターン/);
    assert.match(feedText, /送付記録の数量に対して一部が入りました：食料 352 以上。送付記録の数量：食料 400。比べた基準は送付記録の数量です/, 'to a village: verified against the send record, said so');
    assert.match(feedText, /到着しましたが、入った量は確認できません（[^）]*最大 [0-9,]*）。倉庫は上限を超えた分を切り捨てます/, 'to a storehouse: not verified');
    assert.doesNotMatch(feedText, /全量が入りました：木材 300|村に入った量：木材 300|全量が入りました：木材 300 以上|村に入った量：木材 300 以上|隊商が着きました：木材 300/);
    await shot(page, `ws07-s1-page-away-${size.name}`);
    // (a phone shows one notice over the map, the newest — here the turn's card —: the away summary waits under it, and
    // a line under the strip says there is something not yet seen and opens the summary in the list under その他 —
    // the player does not have to find その他 by themselves. A desktop shows the summary over the map, and no line)
    const entry = page.locator('#away-entry');
    if (size.name === 'phone') {
      assert.equal(await seen.count(), 0, 'on a phone the away summary waits under the newest notice');
      await entry.waitFor({ state: 'visible', timeout: 15000 });
      assert.match(await entry.innerText(), /留守中の未確認の出来事 \d+ 件/);
      await shot(page, `ws07-s1-page-away-${size.name}-entry`);
      // closing the notice over it with × confirms nothing: the line stays
      await page.locator('[data-act="turn-dismiss"]:visible, [data-act="feed-dismiss"]:visible').first().click();
      assert.equal(await entry.isVisible(), true, 'still there after ×');
      await entry.focus();
      await page.keyboard.press('Enter');
      await seen.first().waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.act), 'away-seen', 'the list opens at the summary, its "seen" in focus');
      await shot(page, `ws07-s1-page-away-${size.name}-list`);
    } else assert.equal(await entry.isVisible().catch(() => false), false, 'no line on a wide screen');
    assert.equal(await seen.count(), 1, '"seen" is on screen');
    await seen.first().focus();
    await page.keyboard.press('Enter');
    if (size.name === 'phone') { await page.waitForTimeout(300); assert.equal(await page.locator('#away-entry:visible').count(), 0, '"seen" takes the line away'); }
    const key = await page.evaluate(() => Object.keys(localStorage).find(k => k.startsWith('ws07-return:') && k !== 'ws07-return:last'));
    assert.ok(key, 'the mark is saved');
    const mark = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);
    assert.equal(mark.confirmedSeq, extra.at(-1).seq);
    await page.reload();
    await untilPage(page, fsReady);
    await page.waitForTimeout(4000);
    assert.equal(await page.locator('[data-act="away-seen"]').count(), 0, 'nothing new after the mark: no summary');
    assert.equal(await page.locator('#away-entry:visible').count(), 0, 'and no line');
    assert.deepEqual(errors, []);
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });

  test(`${size.name} [mixed fixture: S1 Season, M1 accounts]: in the village drawer, the S1 card says a caravan past its turn is overdue, not arrived; with 04, 05 and 01 registered (mocks) their states too`, async () => {
    const ctx = await context({ width: size.width, height: size.height });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${base}/frontier/`);
    await untilPage(page, s1Feeds);
    await page.locator('[data-tab="holding"]').first().click();
    const card = page.locator('.s1-card');
    await card.waitFor({ state: 'attached', timeout: 15000 });
    assert.equal(await card.locator('[data-key="arrival:overdue"]').count(), 1);
    assert.match(await card.innerText(), /到着予定のターン \d+ を過ぎました。読み込んだ時点では、まだ決着していません/);
    assert.doesNotMatch(await card.innerText(), /到着済み/, 'past the turn is not arrived');
    assert.equal(await card.locator('[data-key^="cancel:"], [data-key^="cost:"], [data-key="manual"], [data-act="coop-open"]').count(), 0, 'nothing registered: nothing added');
    await card.scrollIntoViewIfNeeded();
    await shot(card, `ws07-s1-page-card-${size.name}`);
    // the owners' sources, registered in the page as MOCKS
    await page.evaluate(async () => {
      const { registerStatusSource } = await import('/frontier/hud/statussources.mjs');
      const { registerCoopEntry } = await import('/frontier/hud/coopentry.mjs');
      registerStatusSource('caravanCancel', (fs, c) => (c.seq === 3 ? { stage: 'stopNew' } : null));
      registerStatusSource('villageCosts', () => ({ costs: [{ phase: 'reserved', amounts: [100, 0, 0, 0, 0, 0, 0, 0] }], committedInHave: true }));
      registerStatusSource('manualPlay', () => ({ signedPending: 1 }));
      registerCoopEntry({ id: 'mock-coop', title: () => '国と協力する（mock）', state: () => ({ available: false, why: '卓が開くのはターン 700 から（mock）' }), open: () => {} });
    });
    await page.locator('[data-tab="map"]').first().click().catch(() => {});
    await page.locator('[data-tab="holding"]').first().click();
    await card.locator('[data-key="manual"]').waitFor({ state: 'attached', timeout: 15000 });
    const keys = await card.locator('[role="status"]').evaluateAll(xs => xs.map(x => x.dataset.key));
    assert.deepEqual(keys, ['manual', 'cost:reserved', 'arrival:overdue', 'cancel:stopNew']);
    assert.equal(await card.locator('[data-act="coop-open"]').isDisabled(), true);
    assert.match(await card.innerText(), /卓が開くのはターン 700 から（mock）/);
    await card.scrollIntoViewIfNeeded();
    await shot(card, `ws07-s1-page-card-mock-${size.name}`);
    assert.deepEqual(errors, []);
    await NK.assertKeyless(ctx, assert);
    await ctx.close();
  });
}
