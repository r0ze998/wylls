#!/usr/bin/env node
// The walletless demo's smoke (headless Chromium, playwright-core): the built static bundle (dist/) served by a plain
// static server under a path prefix, played through the page's own controls.
//
//   node smoke.mjs [--dir dist] [--port 0] [--prefix /play/] [--lang en|ja] [--shots DIR] [--loop] [--headed]
//                  [--origin https://r0ze998.github.io --prefix /wylls/ --path frontier/index.html] [--mobile] [--act]
//
// --origin: no server; the browser fetches dist/ AT THAT ORIGIN (Playwright routes it, a missing path gets dist/404.html
// as GitHub Pages answers): the page runs on the real host name, not a loopback one, in a secure context. Every other
// request is refused and counted. A fresh profile, no extension, no injected wallet (fix-demo-wallet-p0: every earlier
// run was on 127.0.0.1, where the page offers its test Dev Wallet by the loopback host name; GitHub Pages is not one).
// --path: the entry under the prefix ('' = the prefix itself, which redirects to frontier/index.html).
// --mobile: a phone viewport (390×844, touch). --act: after the village, one order (train) must be accepted.
// Always: no wallet prompt ("connect a wallet", "No wallet found", ウォレットをつなぐ…) at any step, and the page plays
// as the demo's own Dev Wallet.
//
// The page runs from its esbuild bundle: the page's modules are reached through __wyllsDemo.modules (the bundle's
// own instances; importing fstate.mjs by URL would load a second, idle copy).
// Asserts: cold load → the nation picker answers within 10 s; one click → a village (time measured); no request
// leaves the static host (no devnet, no RPC, no herald/relay server: every /h and /gw read is answered in the page);
// no console error, no page error, no HTTP error. With --loop (the 1–3 min loop): train, form a host, march it on the
// province's camp, the clash is resolved (the rules kernel) and its report opens; the land owned by the viewer's nation.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { serveStatic, TYPES } from './serve.mjs';

/** dist/ served at `origin` + `prefix` inside the browser (no socket): `{url, route, offsite, close()}`. */
function routedHost(origin, prefix) {
  const o = new URL(origin).origin, root = resolve(opt.dir) + sep, pre = `/${String(prefix).replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  const offsite = [];
  const file = async rel => { const full = normalize(join(root, rel)); return full.startsWith(root) && (await stat(full).catch(() => null))?.isFile() ? full : null; };
  const route = async r => {
    const u = new URL(r.request().url());
    if (u.origin !== o) { if (!/^(?:data|blob):/.test(u.protocol)) offsite.push(u.href); return r.abort('blockedbyclient'); }
    let rel = u.pathname.startsWith(pre) ? decodeURIComponent(u.pathname.slice(pre.length)) : null;
    if (rel !== null && (rel === '' || rel.endsWith('/'))) rel += 'index.html';
    const full = rel === null ? null : await file(rel);
    if (full) return r.fulfill({ status: 200, contentType: TYPES[extname(full)] ?? 'application/octet-stream', body: await readFile(full) });
    const nf = await file('404.html');
    return r.fulfill({ status: 404, contentType: nf ? TYPES['.html'] : 'text/plain', body: nf ? await readFile(nf) : 'not found' });
  };
  return { url: `${o}${pre}`, route, offsite, close: async () => {} };
}

const { values: opt } = parseArgs({ options: {
  dir: { type: 'string', default: new URL('dist', import.meta.url).pathname }, port: { type: 'string', default: '0' }, prefix: { type: 'string', default: '/play/' },
  lang: { type: 'string', default: 'en' }, shots: { type: 'string' }, loop: { type: 'boolean', default: false }, headed: { type: 'boolean', default: false },
  origin: { type: 'string' }, path: { type: 'string', default: '' }, mobile: { type: 'boolean', default: false }, act: { type: 'boolean', default: false },
  width: { type: 'string', default: '1440' }, height: { type: 'string', default: '900' }, budget: { type: 'string', default: '10000' }, nation: { type: 'string', default: '1' },
} });
const JA = opt.lang === 'ja';
const say = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
if (opt.shots) mkdirSync(opt.shots, { recursive: true });
const TAGNAME = `${opt.lang}${opt.mobile ? '-mobile' : ''}${opt.path ? '-' + opt.path.replace(/\W+/g, '_') : ''}`;
const shot = async (page, name) => { if (opt.shots) await page.screenshot({ path: `${opt.shots}/${TAGNAME}-${name}.png` }); };

const srv = opt.origin ? routedHost(opt.origin, opt.prefix) : await serveStatic({ dir: opt.dir, port: Number(opt.port), prefix: opt.prefix });
const browser = await chromium.launch({ headless: !opt.headed });
const view = opt.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: Number(opt.width), height: Number(opt.height) } };
const context = await browser.newContext({ ...view, locale: JA ? 'ja-JP' : 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
if (srv.route) await context.route('**/*', srv.route);
const page = await context.newPage();
const problems = [], offsite = [], seen = [];
page.on('pageerror', e => problems.push(`page error: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('request', r => { const u = new URL(r.url()); seen.push(u.href); if (!(u.protocol === 'data:' || u.protocol === 'blob:' || u.href.startsWith(srv.url))) offsite.push(u.href); });

const demo = fn => page.evaluate(fn);
const summary = () => page.evaluate(async () => (await globalThis.__wyllsDemo.world()).summary());
const turnNow = async () => (await summary()).turn;
const mod = name => `new URL(${JSON.stringify(name)}, location.href).href`;
async function press(sel, { timeout = 8_000 } = {}) {
  const l = page.locator(sel).first(), t0 = Date.now();
  for (;;) {
    try { await l.waitFor({ state: 'attached', timeout: 1_000 }); await l.evaluate(el => el.scrollIntoView({ block: 'center' })); await l.click({ timeout: 1_500 }); return true; } catch { if (Date.now() - t0 > timeout) return false; await sleep(150); }
  }
}
const tab = async name => {
  const open = await page.evaluate(async ([n, m]) => { const { FS } = globalThis.__wyllsDemo.modules['fstate.mjs'] ?? await import(eval(m)); return FS.tab === n && document.getElementById('panel')?.dataset.drawer === 'open'; }, [name, mod('fstate.mjs')]);
  return open || press(`#tabs [data-tab="${name}"]`);
};
const unfold = key => page.evaluate(k => { const d = document.querySelector(`details[data-fold="${k}"]`); if (d && !d.open) d.open = true; return !!d; }, key);
async function orders() { return page.evaluate(async () => (await globalThis.__wyllsDemo.world()).orders.map(o => ({ name: o.name, ok: o.ok, code: o.code ?? null }))); }
async function order(what, name, doIt) {
  const before = (await orders()).length;
  let pressed = false;
  for (let attempt = 0; attempt < 3 && !pressed; attempt++) {
    if (attempt) { await page.keyboard.press('Escape').catch(() => {}); await press('[data-act="drawer-close"]', { timeout: 1_500 }); await sleep(800); }
    pressed = await doIt();
  }
  if (pressed === false) { say(`    ${what}: NOT PRESSED`); return false; }
  for (let i = 0; i < 60; i++) { if ((await orders()).length > before) break; await sleep(100); }
  const o = (await orders()).slice(before).find(x => x.name === name);
  say(`    ${what}: ${o ? (o.ok ? 'accepted' : `REFUSED ${o.code}`) : 'NOT SENT'}`);
  return !!o?.ok;
}
const UNIT = ['Spearman', 'Archer', 'Horseman', 'Pikeman', 'Crossbowman', 'Knight', 'Scout'];
/** Fill one of the village drawer's forms and press its submit in the same task (the drawer re-renders every second). */
async function fillAndSubmit(formId, fold, unit, field, n, timeout = 25_000) {
  const t0 = Date.now();
  for (;;) {
    await tab('holding');
    await unfold(fold);
    const ok = await page.evaluate(([id, unit, field, n]) => {
      const f = document.getElementById(id); if (!f) return false;
      const r = f.querySelector(`input[name="unit"][value="${unit}"]`); if (!r) return false;
      r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
      f.elements[field].value = String(n); f.elements[field].dispatchEvent(new Event('input', { bubbles: true }));
      const b = f.querySelector('button[type="submit"]'); if (!b || b.disabled) return false;
      b.scrollIntoView({ block: 'center' }); b.click(); return true;
    }, [formId, unit, field, n]);
    if (ok) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(300);
  }
}
const train = (unit, n) => order(`train ${n} ${UNIT[unit]}`, 'Train', () => fillAndSubmit('hp-train', 'v-train', unit, 'n', n));
const muster = (unit, troops) => order(`form a host of ${troops} ${UNIT[unit]}`, 'Muster', () => fillAndSubmit('hp-muster', 'v-muster', unit, 'troops', troops));
const marchCamp = host => order('march the host on the camp (sealed in this browser)', 'Depart', async () => {
  await tab('hosts');
  if (!(await press(`[data-act="compose"][data-host="${host}"]:not([disabled])`))) return false;
  await page.locator('#mc-title').waitFor({ timeout: 8_000 }).catch(() => {});
  if (!(await press('[data-act="dest-quick"]'))) return false;
  return press('[data-act="march-send"]:not([disabled])', { timeout: 25_000 });
});
/** Where a tile is seen now (viewport px), once the camera rests (playthrough.mjs's tileAt, with page-relative imports). */
async function tileAt(at) {
  return page.evaluate(async at => {
    const rel = n => new URL(n, location.href).href;
    if (!window.__map) {
      const mods = globalThis.__wyllsDemo.modules;
      const { FrontierMap } = mods['map/fmap.mjs'] ?? await import(rel('map/fmap.mjs'));
      const P = FrontierMap.prototype, draw = P.draw;
      P.draw = function (...a) { window.__map = this; return draw.apply(this, a); };
      for (let i = 0; i < 80 && !window.__map; i++) { window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 50)); }
    }
    const m = window.__map, frame = () => new Promise(r => requestAnimationFrame(r));
    for (let still = 0, i = 0; still < 10 && i < 400; i++) { await frame(); still = m.cam.moving || m.reachFly ? 0 : still + 1; }
    const mods2 = globalThis.__wyllsDemo.modules;
    const { tileHex } = mods2['fgeo.mjs'] ?? await import(rel('fgeo.mjs'));
    const { project } = mods2['../map.mjs'] ?? await import(rel('../map.mjs'));
    const h = tileHex(at.p, at.q, at.tile), c = project(h.q, h.r);
    return m.project(c.x, c.y);
  }, at);
}
/** An open tile of the viewer's province next to the village (passable, no village, no camp, nobody on it). */
const openTileNearHome = () => page.evaluate(async () => {
  const live = await globalThis.__wyllsDemo.world(), me = live.summary().me, [p, q] = me.village, pv = live.province(p, q);
  const { TILE_OFFSETS, hexDistance } = globalThis.__wyllsDemo.modules['fgeo.mjs'] ?? await import(new URL('fgeo.mjs', location.href).href);
  const home = TILE_OFFSETS[me.tile], d = t => hexDistance(TILE_OFFSETS[t].q, TILE_OFFSETS[t].r, home.q, home.r);
  const free = [...Array(61).keys()].filter(t => ((pv.passableMask >> BigInt(t)) & 1n) && !pv.sites.slice(0, pv.siteCount).includes(t) && !(pv.camp.state === 1 && pv.camp.tile === t) && !pv.entries.some(e => e.state && e.tile === t));
  const t = free.sort((a, b) => d(a) - d(b))[0];
  return t === undefined ? null : { p, q, tile: t };
});
const marchTile = (host, at) => order(`march the host to the open tile ${at.tile} (land)`, 'Depart', async () => {
  await tab('hosts');
  if (!(await press(`[data-act="compose"][data-host="${host}"]:not([disabled])`))) { say('      (no compose button for the host)'); await shot(page, 'x-land-compose'); return false; }
  await page.locator('#mc-title').waitFor({ timeout: 8_000 }).catch(() => {});
  const xy = await tileAt(at);
  await page.mouse.move(xy.x, xy.y); await page.mouse.down(); await sleep(90); await page.mouse.up();
  await sleep(600);
  await shot(page, 'x-land-picked');
  const ok = await press('[data-act="march-send"]:not([disabled])', { timeout: 25_000 });
  if (!ok) say(`      (the send button stayed disabled after a tap at ${Math.round(xy.x)},${Math.round(xy.y)})`);
  return ok;
});
const ownTiles = async () => { const s = await summary(); const [p, q] = s.me.village, t = s.territory?.find(x => x.p === p && x.q === q); return t ? t.owners.filter(o => o === s.me.nation).length : 0; };
async function untilTurn(b, into = 0.35) {
  for (let i = 0; i < 600; i++) {
    const s = await summary();
    if (s.turn > b || (s.turn === b && s.into >= into * 600)) return s;
    await sleep(250);
  }
  throw new Error(`turn ${b} never came`);
}

// the page's wallet prompts (frontier/screens/join.mjs walletButtons/renderWallets, en-frontier*.mjs): never in the demo
const WALLET_PROMPT = /connect a wallet|No wallet found|Install a Solana wallet|Connect a wallet|ウォレットをつな|ウォレットが見つかりません|ウォレットを入れて/;
async function noWalletPrompt(step) {
  const text = await page.locator('body').innerText().catch(() => '');
  const hit = WALLET_PROMPT.exec(text)?.[0] ?? null;
  const buttons = await page.locator('[data-act="connect"]').count();
  check(!hit && buttons === 0, `${step}: no wallet prompt${hit || buttons ? ` (FOUND "${hit}", ${buttons} connect button(s))` : ''}`);
}

// ------------------------------------------------------------------ cold load → the nation picker
say(`walletless demo smoke: ${srv.url} (${opt.lang})`);
const t0 = Date.now();
await page.goto(srv.url + opt.path);
await page.locator('[data-act="pick-faction"]').first().waitFor({ state: 'visible', timeout: 30_000 });
const tPicker = Date.now() - t0;
check(tPicker <= Number(opt.budget), `cold load → nation picker in ${tPicker} ms (budget ${opt.budget} ms)`);
await shot(page, '01-picker');
check(new URL(page.url()).origin === new URL(srv.url).origin && /\/frontier\/index\.html$/.test(new URL(page.url()).pathname), `the game page is open: ${page.url()}`);
check(await page.evaluate(() => !globalThis.solana && !globalThis.phantom && !globalThis.backpack && !globalThis.solflare), 'a clean browser: no injected wallet provider');
await noWalletPrompt('the nation picker');
const pre = (await page.locator('[data-demo-label]').first().innerText().catch(() => '')).trim();
check(JA ? pre === '体験版・ウォレット不要' : pre === 'Playable demo · no wallet needed', `the pre-join screen says what it is: "${pre}"`);
const preText = await page.locator('body').innerText();
check(!/1,008|1008/.test(preText), 'the pre-join screen does not show the test-world end turn (1,008)');
const nation = Number(opt.nation);
await page.locator('[data-act="pick-faction"]').nth(nation).click();
const go = page.locator('[data-stable="join-go"]:not([disabled])').first();
const goSeen = await go.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
await noWalletPrompt('a nation picked');
if (!goSeen) { await shot(page, 'x-no-start-button'); check(false, 'the start button appears once a nation is picked'); await browser.close(); say(`\n${fails.length} check(s) failed`); process.exit(1); }
const tReady = Date.now() - t0;
await go.click();
let me = null;
for (let i = 0; i < 160 && !me; i++) { await sleep(250); me = (await summary()).me; }
await page.locator('#tabs [data-tab="holding"]').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
const tVillage = Date.now() - t0;
check(!!me, `one click → own village (button ready at ${tReady} ms, village at ${tVillage} ms after load)`);
check(tVillage <= Number(opt.budget) + 5_000, `village within ${Number(opt.budget) + 5_000} ms of the cold load`);
await sleep(1500);
await shot(page, '02-village');
await noWalletPrompt('the village');
const signer = await page.evaluate(() => { const w = globalThis.__wyllsDemo.modules['fstate.mjs']?.FS?.wallet; return w ? { name: w.name, dev: !!w.dev } : null; });
check(signer?.dev === true, `the guest plays as the demo's in-browser test wallet, no extension (${JSON.stringify(signer)})`);
if (opt.act) {
  const ok = await train(0, 20);
  check(ok, 'one order from the village (train 20 Spearmen) was accepted');
  await sleep(800);
  await shot(page, '03-act');
  await noWalletPrompt('after the order');
}
check(await page.evaluate(() => { const b = document.querySelector('.wide-btn[data-map="wide"]'); return !b || b.hidden; }), 'no "Records" (recorded wide world) button in the demo');
const tag = (await page.locator('#sample-tag').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check(JA ? tag.includes('体験版') : tag.includes('Playable demo'), `the demo says what it is: "${tag}"`);
const wantLive = await page.evaluate(() => globalThis.__wyllsDemo.config.liveUrl || '');
const live = (await page.locator('#sample-tag a.sample-live').count()) ? await page.locator('#sample-tag a.sample-live').getAttribute('href') : null;
check(wantLive ? live === wantLive && live.startsWith('https://') : live === null, wantLive ? `the tag links the live world (${live})` : `no live-world link without --live-url (${live})`);
const s0 = await summary();
check(s0.neighbours.length >= 6 && new Set(s0.neighbours.map(n => n.nation)).size === 6, `all six nations have a village on the map (${s0.neighbours.map(n => n.nation).join(',')})`);

// ------------------------------------------------------------------ the loop: train → host → camp → battle → report
const result = { tPicker, tReady, tVillage };
if (opt.loop) {
  const T = s0.turn;
  say(`  village founded in turn ${T} (${me.state === 1 ? 'provisional' : 'final'})`);
  const tLoop = Date.now();
  await train(0, 400);
  // a provisional hamlet trains but does not muster: the village is final after the first toll
  for (let i = 0; i < 240 && (await summary()).me.state !== 2; i++) await sleep(250);
  await untilTurn((await summary()).turn, 0.2);
  await muster(0, 300);
  await muster(0, 100);
  const free = () => summary().then(s => s.me.hosts.filter(h => h.unit === 0 && h.state === 1 && !s.me.marches.some(x => x.host === h.id)));
  let hosts = [];
  for (let i = 0; i < 400 && hosts.length < 2; i++) { hosts = await free(); if (hosts.length < 2) await sleep(250); }
  check(hosts.length >= 2, `two hosts stand in the roster (${hosts.map(h => h.troops).join(' + ')})`);
  await untilTurn((await summary()).turn, 0.2);
  await shot(page, '03-host');
  const big = hosts.sort((a, b) => b.troops - a.troops)[0]?.id, small = hosts[1]?.id;
  const tilesBefore = await ownTiles();
  const field = await openTileNearHome();
  const sentLand = small && field && await marchTile(small, field);
  check(!!sentLand, `the march onto open land was accepted (tile ${field?.tile})`);
  const sent = big && await marchCamp(big);
  check(!!sent, 'the march on the camp was accepted');
  await shot(page, '04-march');
  // the clash: the camp's record (kind 41 CLASH at the home province) and the report the page opens
  let clash = null;
  for (let i = 0; i < 900 && !clash; i++) {
    clash = await page.evaluate(async () => (await globalThis.__wyllsDemo.world()).records().find(r => r.kind === 41 && r.fields.engagements > 0) ?? null);
    if (!clash) await sleep(250);
  }
  check(!!clash, `the clash at the camp was resolved (turn ${clash?.bell})`);
  await sleep(2500);
  await shot(page, '05-after-clash');
  const opened = await press(`[data-act="report-open"], [data-act="open-report"], #feed [data-act*="report"]`, { timeout: 15_000 });
  await sleep(1200);
  const doc = await page.locator('#panel').innerText().catch(() => '');
  check(opened, `the battle report opened from the notice`);
  await shot(page, '06-report');
  let tilesAfter = await ownTiles();
  for (let i = 0; i < 240 && tilesAfter <= tilesBefore; i++) { await sleep(250); tilesAfter = await ownTiles(); }
  check(tilesAfter > tilesBefore, `the nation's land in the home province grew ${tilesBefore} → ${tilesAfter} tiles`);
  await press('[data-act="drawer-close"]', { timeout: 2_000 }).catch(() => {});
  await tab('territory'); await sleep(1500);
  await shot(page, '07-land');
  // the land logistics horizon: the viewer's land costs food each turn; the village card says how long the food lasts
  let horizon = '';
  for (let i = 0; i < 120 && !horizon; i++) {
    await tab('holding');
    horizon = (await page.locator('#hp-land-food-horizon').first().innerText({ timeout: 500 }).catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!horizon) await sleep(500);
  }
  check(!!horizon, `the land logistics horizon card is on the village card: "${horizon.slice(0, 160)}"`);
  await page.locator('#hp-land-food-horizon').first().evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await sleep(400);
  await shot(page, '08-horizon');
  result.horizon = horizon;
  result.loopMs = Date.now() - tLoop;
  check(result.loopMs <= 180_000, `the loop (train → host → camp battle → report) took ${(result.loopMs / 1000).toFixed(0)} s`);
  const s1 = await summary();
  result.camp = s1.camp; result.territory = s1.territory?.find(t => t.p === me.village[0] && t.q === me.village[1]);
  say(`  camp now ${JSON.stringify(s1.camp)}; report text: ${doc.replace(/\s+/g, ' ').slice(0, 200)}`);
}

// ------------------------------------------------------------------ the request log
const blocked = await demo(() => globalThis.__wyllsDemo.log.blocked);
const errors = await demo(() => globalThis.__wyllsDemo.log.errors);
if (srv.offsite) offsite.push(...srv.offsite);
check(offsite.length === 0, `no request left the static host (${offsite.length}${offsite.length ? `: ${offsite.slice(0, 3).join(' ')}` : ''})`);
check(blocked.length === 0, `the page asked for no other origin (${blocked.length})`);
const chainy = seen.filter(u => { const x = new URL(u); return /devnet|mainnet|solana|helius|quicknode|triton/i.test(x.hostname) || x.port === '8899' || x.port === '8900' || /^\/(?:.*\/)?(h|gw|coop)\//.test(x.pathname.slice(new URL(srv.url).pathname.length - 1)); });
check(chainy.length === 0, `no devnet / RPC / herald / relay request over the network (${chainy.slice(0, 3).join(' ')})`);
check(errors.length === 0, `the in-page world answered every read (${errors.join(' | ')})`);
check(problems.length === 0, `no console / page / HTTP errors${problems.length ? `: ${[...new Set(problems)].slice(0, 5).join(' | ')}` : ''}`);
result.requests = seen.length;
if (opt.shots) writeFileSync(`${opt.shots}/${TAGNAME}-result.json`, JSON.stringify({ ...result, fails }, null, 1));
say(JSON.stringify(result));
await browser.close();
await srv.close();
say(fails.length ? `\n${fails.length} check(s) failed` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
