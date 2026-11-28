#!/usr/bin/env node
// The demo travelers' smoke (headless Chromium, playwright-core), on the REAL Pages host name by default: dist/ is
// routed in the browser at https://r0ze998.github.io/wylls/ (as smoke.mjs --origin does: no socket, every other request
// refused and counted), so the page runs on a non-loopback secure origin, as players get it.
//
//   node smoke-travelers.mjs [--lang en|ja] [--mobile] [--pre-join] [--nation 1] [--shots DIR] [--origin URL --prefix /wylls/]
//
// Checks: the travelers' button and markers are on the map; a traveler's panel opens from the list and from a marker;
// Talk says its lines in order (EN/JA, never "season"); before joining no trade is offered and nothing is signed but
// the load-time Ed25519 preflight; (without --pre-join) after joining, a visiting traveler trades food ↔ ore through
// the panel at the rates it shows, refuses past the visit's limit, and a reload brings back the travelers' places, the
// trades taken and the next talk line; no request leaves the host, no wallet prompt, no console / page / HTTP error.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { TYPES } from './serve.mjs';

const { values: opt } = parseArgs({ options: {
  dir: { type: 'string', default: new URL('dist', import.meta.url).pathname }, origin: { type: 'string', default: 'https://r0ze998.github.io' }, prefix: { type: 'string', default: '/wylls/' },
  lang: { type: 'string', default: 'en' }, mobile: { type: 'boolean', default: false }, 'pre-join': { type: 'boolean', default: false }, nation: { type: 'string', default: '1' }, shots: { type: 'string' },
} });
const JA = opt.lang === 'ja';
const say = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
if (opt.shots) mkdirSync(opt.shots, { recursive: true });
const TAG = `${opt.lang}${opt.mobile ? '-mobile' : ''}${opt['pre-join'] ? '-prejoin' : ''}`;
const shot = async name => { if (opt.shots) await page.screenshot({ path: `${opt.shots}/trav-${TAG}-${name}.png` }); };

// dist/ at `origin` + `prefix` inside the browser (smoke.mjs routedHost)
const o = new URL(opt.origin).origin, root = resolve(opt.dir) + sep, pre = `/${String(opt.prefix).replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
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

const browser = await chromium.launch({ headless: true });
const view = opt.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } };
const context = await browser.newContext({ ...view, locale: JA ? 'ja-JP' : 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
await context.route('**/*', route);
// signatures: the load-time Ed25519 test (seed 0x07, fixed text) counted apart from every other (smoke.mjs)
await context.addInitScript(() => {
  const S = globalThis.SubtleCrypto?.prototype; if (!S?.sign || !S?.importKey) return;
  const PRE = 'Wylls demo preflight', preKeys = new WeakSet();
  const bytes = d => { try { return d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null; } catch { return null; } };
  // the fixed seeds a pre-join page may import (smoke.mjs): 0x07 the load-time test, 0x11 DEV_SEED, 0x22 SESSION_SEED
  const SEEDS = { 7: 'preflight', 17: 'dev', 34: 'session' };
  const seedOf = d => { const b = bytes(d); if (!b || b.length !== 48) return null; const x = b.subarray(16); return x.every(y => y === x[0]) ? SEEDS[x[0]] ?? null : null; };
  const importKey = S.importKey, generateKey = S.generateKey, sign = S.sign;
  globalThis.__smokeSigns = 0; globalThis.__smokePreflight = 0; globalThis.__smokeOtherKeys = [];
  S.importKey = async function (...a) {
    const k = await importKey.apply(this, a);
    const priv = a[0] === 'pkcs8' || (a[0] === 'jwk' && a[1]?.d != null);
    if (priv) { const seed = a[0] === 'pkcs8' ? seedOf(a[1]) : null; if (seed === 'preflight') preKeys.add(k); else if (!seed) globalThis.__smokeOtherKeys.push(`importKey ${a[0]}`); }
    return k;
  };
  if (generateKey) S.generateKey = function (...a) { globalThis.__smokeOtherKeys.push(`generateKey ${a[0]?.name ?? a[0]}`); return generateKey.apply(this, a); };
  S.sign = function (...a) {
    let txt = null; try { txt = new TextDecoder('utf-8', { fatal: true }).decode(bytes(a[2])); } catch {}
    if (txt === PRE && preKeys.has(a[1])) globalThis.__smokePreflight++; else globalThis.__smokeSigns++;
    return sign.apply(this, a);
  };
});
let page = await context.newPage();
const problems = [];
const watch = p => {
  p.on('pageerror', e => problems.push(`page error: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  p.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
};
watch(page);
const WALLET_PROMPT = /connect a wallet|No wallet found|Install a Solana wallet|Connect a wallet|ウォレットをつな|ウォレットが見つかりません|ウォレットを入れて/;
async function noWalletPrompt(step) {
  const text = await page.locator('body').innerText().catch(() => '');
  const hit = WALLET_PROMPT.exec(text)?.[0] ?? null;
  check(!hit && (await page.locator('[data-act="connect"]').count()) === 0, `${step}: no wallet prompt${hit ? ` (FOUND "${hit}")` : ''}`);
}
const rec = () => page.evaluate(async () => (await globalThis.__wyllsDemo.world()).travelers());
const summary = () => page.evaluate(async () => (await globalThis.__wyllsDemo.world()).summary());
const panelText = () => page.locator('#demo-trav-panel').innerText().then(t => t.replace(/\s+/g, ' ').trim()).catch(() => '');
const click = async sel => { const l = page.locator(sel).first(); await l.waitFor({ state: 'visible', timeout: 8_000 }); await l.click(); };
async function openTraveler(id) {
  if (await page.locator(`#demo-trav-panel:not([hidden]) [data-dt-name="${id}"]`).count()) return;
  await click('#demo-trav-list');
  await click(`#demo-trav-panel [data-dt="open"][data-id="${id}"]`);
  await page.locator(`#demo-trav-panel [data-dt-name="${id}"]`).waitFor({ timeout: 5_000 });
}

// ------------------------------------------------------------------ load → the picker, travelers on the map
const url = `${o}${pre}frontier/index.html${JA ? '?lang=ja' : '?lang=en'}`;
say(`demo travelers smoke: ${url}${opt.mobile ? ' (phone)' : ''}`);
await page.goto(url);
await page.locator('[data-act="pick-faction"]').first().waitFor({ state: 'visible', timeout: 30_000 });
check(new URL(page.url()).origin === o, `the page runs on ${o}`);
await page.locator('#demo-trav-list').waitFor({ state: 'visible', timeout: 10_000 });
check(true, 'the travelers button is shown');
await noWalletPrompt('the nation picker');
const r0 = await rec();
check(r0.travelers.length === 3 && r0.home === null, `three travelers walk the map before joining (${r0.travelers.map(t => `${t.id}@${t.p},${t.q}:${t.tile}`).join(' ')})`);
let marks = 0;
for (let i = 0; i < 20 && !(marks = await page.locator('#demo-travelers .demo-trav').count()); i++) await sleep(300);
say(`    markers on screen: ${marks}`);
await shot('01-picker');
await openTraveler('tamsin');
let txt = await panelText();
check(txt.includes(JA ? '鉱石運びのタムシン' : 'Tamsin, ore carrier') && txt.includes(JA ? '国を選んで村を作って' : 'Pick a nation and found your village'), `the panel before joining: name and "found your village first": "${txt.slice(0, 160)}"`);
check((await page.locator('#demo-trav-panel [data-dt="trade"]').count()) === 0, 'no trade before joining');
const lines = [];
for (let i = 0; i < 4; i++) { await click('#demo-trav-panel [data-dt="talk"]'); await sleep(150); lines.push(await page.locator('#demo-trav-panel [data-dt-line]').innerText()); }
check(lines[0] !== lines[1] && lines[1] !== lines[2] && lines[3] === lines[0], `Talk says the 3 lines in turn, then the first again (${lines.map(l => l.slice(0, 24)).join(' | ')})`);
check(lines.every(l => (JA ? /[ぁ-んァ-ン一-龯]/ : /^[\x20-\x7e’—]+$/).test(l)), `the lines are in ${JA ? 'Japanese' : 'English'}`);
check(!/season|シーズン/i.test(await page.locator('#demo-trav-panel').innerText() + await page.locator('#demo-trav-list').innerText()), 'never "season"');
await shot('02-talk');
const sec0 = await page.evaluate(() => globalThis.__wyllsDemo.section.get('travelers'));
check(sec0?.v === 1 && sec0.talk?.tamsin === 1, `the talk is kept in the save's own section, v 1 (${JSON.stringify(sec0)})`);
// a marker opens its own panel (one on screen)
if (marks) {
  const id = await page.locator('#demo-travelers .demo-trav').first().getAttribute('data-traveler');
  await page.locator('#demo-travelers .demo-trav').first().click({ force: true });
  await sleep(200);
  check(await page.locator(`#demo-trav-panel [data-dt-name="${id}"]`).count() === 1, `tapping the marker of ${id} opens its panel`);
}
await click('#demo-trav-panel [data-dt="close"]');
check(await page.locator('#demo-trav-panel').isHidden(), 'Close hides the panel');

if (opt['pre-join']) {
  const s = await page.evaluate(() => [globalThis.__smokeSigns, globalThis.__smokePreflight, globalThis.__smokeOtherKeys]);
  check(s[0] === 0 && s[1] <= 1, `nothing signed but the load-time preflight (other ${s[0]}, preflight ${s[1]})`);
  check(s[2].length === 0, `no private key but the fixed sample seeds (${s[2].join(', ') || 'none'})`);
} else {
  // ---------------------------------------------------------------- join, then trade with a visiting traveler
  await page.locator('[data-act="pick-faction"]').nth(Number(opt.nation)).click();
  await click('[data-stable="join-go"]:not([disabled])');
  let me = null;
  for (let i = 0; i < 160 && !(me = (await summary()).me); i++) await sleep(250);
  check(!!me, `joined: a village at ${me?.village}`);
  await noWalletPrompt('the village');
  // (a traveler visits within 10 turns of any village: travelers-playtest.mjs; at most ~2 min here)
  let r = null, vis = null;
  for (let i = 0; i < 600; i++) { r = await rec(); vis = r.home && r.travelers.find(t => t.visiting && t.left === r.rules.lotsPerVisit && (t.next === null)); if (vis) break; await sleep(500); }
  check(!!vis, `a traveler visits the village (${vis?.id}, turn ${r?.turn}, rates buy ${vis?.rates?.buy} / sell ${vis?.rates?.sell} food a lot)`);
  if (vis) {
    await openTraveler(vis.id);
    await shot('03a-opened');
    say(`    panel: ${(await panelText()).slice(0, 200)}`);
    await page.locator('#demo-trav-panel [data-dt="trade"][data-side="buy"]').waitFor({ timeout: 8_000 });
    txt = await panelText();
    check(txt.includes(JA ? `鉱石10を食料${vis.rates.buy}で買う` : `Buy 10 ore for ${vis.rates.buy} food`), `the panel shows this visit's buy rate: "${txt.slice(0, 220)}"`);
    await shot('03-trade');
    const s0 = (await summary()).me.stores, signs0 = await page.evaluate(() => globalThis.__smokeSigns);
    await click('#demo-trav-panel [data-dt="trade"][data-side="buy"]:not([disabled])');
    await page.locator('#demo-trav-panel [data-dt-result]').waitFor({ timeout: 5_000 });
    const s1 = (await summary()).me.stores;
    // (whole units as the summary reads them; the stores accrue meanwhile: ±2)
    check(Math.abs(s1[3] - s0[3] - 10) <= 2 && Math.abs(s0[0] - s1[0] - vis.rates.buy) <= 2, `bought 10 ore for ${vis.rates.buy} food (ore ${s0[3]} → ${s1[3]}, food ${s0[0]} → ${s1[0]})`);
    await click('#demo-trav-panel [data-dt="trade"][data-side="sell"]:not([disabled])');
    await sleep(400);
    await click('#demo-trav-panel [data-dt="trade"][data-side="buy"]:not([disabled])');
    await sleep(400);
    const after = (await rec()).travelers.find(t => t.id === vis.id);
    check(after.used === 3 && after.left === 0, `three lots this visit, none left (${after.used}/${after.left})`);
    check(await page.locator('#demo-trav-panel [data-dt="trade"]:disabled').count() === 2, 'the trade buttons are off at the limit');
    const refused = await page.evaluate(async id => (await fetch('/gw/f/sample/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ traveler: id, side: 'buy', lots: 1 }) })).json(), vis.id);
    check(refused.ok === false && refused.code === 'Limit', `a fourth lot is refused (Limit): ${JSON.stringify(refused)}`);
    check((await page.evaluate(() => globalThis.__smokeSigns)) === signs0, 'the trades signed nothing');
    await shot('04-limit');
    // ---------------------------------------------------------------- reload: places, trades and talk come back
    await click('#demo-trav-panel [data-dt="talk"]');
    const before = await page.evaluate(async () => { const l = await globalThis.__wyllsDemo.world(); return { rec: l.travelers(), log: l.travelLog().length, talk: globalThis.__wyllsDemo.section.get('travelers') }; });
    await page.reload();
    await page.locator('#demo-trav-list').waitFor({ state: 'visible', timeout: 30_000 });
    for (let i = 0; i < 60 && !(await page.evaluate(async () => !!(await globalThis.__wyllsDemo.world()).summary().me)); i++) await sleep(250);
    const back = await page.evaluate(async () => { const l = await globalThis.__wyllsDemo.world(); return { rec: l.travelers(), log: l.travelLog().length, talk: globalThis.__wyllsDemo.section.get('travelers'), save: globalThis.__wyllsDemo.save() }; });
    check(back.save.restore === 'resume', `the reload resumed the save (${back.save.restore}, ${back.save.inputs} inputs)`);
    check(back.log === before.log, `the trades came back with the replay (${before.log} → ${back.log})`);
    check(JSON.stringify(back.talk) === JSON.stringify(before.talk), `the talk section came back (${JSON.stringify(back.talk)})`);
    const same = back.rec.turn === before.rec.turn ? back.rec.travelers.every((t, i) => t.p === before.rec.travelers[i].p && t.q === before.rec.travelers[i].q && t.tile === before.rec.travelers[i].tile) : true;
    const sameVisit = back.rec.travelers.find(t => t.id === vis.id);
    check(same, `the travelers stand where they stood (turn ${before.rec.turn} → ${back.rec.turn})`);
    if (sameVisit.visit === after.visit) check(sameVisit.used === 3 && sameVisit.left === 0, `the visit's limit came back (used ${sameVisit.used})`);
    else say(`    (the visit ended during the reload: turn ${back.rec.turn})`);
    await openTraveler(vis.id);
    await click('#demo-trav-panel [data-dt="talk"]');
    const n = before.talk.talk[vis.id];
    const want = (await import('../screens/travelers.mjs')).LINES[vis.id][n][JA ? 'ja' : 'en'];
    check((await page.locator('#demo-trav-panel [data-dt-line]').innerText()) === want, `after the reload Talk goes on with line ${n + 1}`);
    await shot('05-reloaded');
  }
  const s = await page.evaluate(() => [globalThis.__smokeSigns, globalThis.__smokePreflight]);
  say(`    signatures by the demo's in-browser test wallet (join, session): ${s[0]}; preflight ${s[1]}; trades sign nothing`);
}
check(offsite.length === 0, `no request left the host (${offsite.length}${offsite.length ? `: ${offsite.slice(0, 3).join(' ')}` : ''})`);
const blocked = await page.evaluate(() => globalThis.__wyllsDemo.log.blocked.length);
check(blocked === 0, `the world shim refused no request (${blocked})`);
check(problems.length === 0, `no console / page / HTTP errors${problems.length ? `: ${[...new Set(problems)].slice(0, 5).join(' | ')}` : ''}`);
await browser.close();
say(fails.length ? `\n${fails.length} check(s) failed` : '\nall travelers checks passed');
process.exit(fails.length ? 1 : 0);
