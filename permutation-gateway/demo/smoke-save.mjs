#!/usr/bin/env node
// The walletless demo's save and browser-notice smoke (demo-polish-2; Q-WD-6, Q-WD-8). Headless Chromium on the built
// static bundle (dist/) under a path prefix:
//
//   node smoke-save.mjs [--dir dist] [--port 0] [--prefix /wylls/] [--lang en|ja] [--shots DIR] [--only save,long,bad,reset,crypto] [--long 300] [--width 1440 --height 900]
//
//   save    join, train, wait a turn → reload: the same village, hosts, land and orders, the same turn, the same in-game
//           key; an order after the reload is accepted; a second reload too; the reload reaches the village as fast as
//           a cold load does
//   long    a save whose clock is --long turns on (an hour of play at 300): the reload catches up in the cold load's time
//   bad     a damaged save, a save of another world build, a save whose replay differs: each starts a fresh world and
//           the picker says so in a short note
//   reset   "Start over" asks first (dismiss: nothing changes), then clears the world (the nation picker again)
//   crypto  a browser without WebCrypto Ed25519 (crypto.subtle stubbed): a notice that names the browsers to use and no
//           join button; a page not on https: its own notice
// Every part: no request leaves the static host, no /h or /gw request over the network, no console / page / HTTP error,
// and no "season" in the demo's words.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { serveStatic } from './serve.mjs';

const { values: opt } = parseArgs({ options: {
  dir: { type: 'string', default: new URL('dist', import.meta.url).pathname }, port: { type: 'string', default: '0' }, prefix: { type: 'string', default: '/wylls/' },
  lang: { type: 'string', default: 'en' }, shots: { type: 'string' }, only: { type: 'string', default: 'save,long,bad,reset,crypto' }, long: { type: 'string', default: '300' }, nation: { type: 'string', default: '1' },
  budget: { type: 'string', default: '10000' }, width: { type: 'string', default: '1440' }, height: { type: 'string', default: '900' },
} });
const JA = opt.lang === 'ja';
const PARTS = new Set(opt.only.split(','));
const say = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); return ok; };
if (opt.shots) mkdirSync(opt.shots, { recursive: true });
const result = { lang: opt.lang };

const srv = await serveStatic({ dir: opt.dir, port: Number(opt.port), prefix: opt.prefix });
const browser = await chromium.launch({ headless: true });

/** A fresh browser profile (its own localStorage) with the request and error watch of smoke.mjs. */
async function open({ init = null } = {}) {
  const context = await browser.newContext({ viewport: { width: Number(opt.width), height: Number(opt.height) }, locale: JA ? 'ja-JP' : 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const w = { context, page, problems: [], offsite: [], network: [], dialogs: [] };
  page.on('pageerror', e => w.problems.push(`page error: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') w.problems.push(`console: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400) w.problems.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('request', r => {
    const u = new URL(r.url());
    if (!(u.protocol === 'data:' || u.protocol === 'blob:' || u.href.startsWith(srv.url))) w.offsite.push(u.href);
    else if (/^\/(?:.*\/)?(h|gw|coop)\//.test(u.pathname.slice(new URL(srv.url).pathname.length - 1))) w.network.push(u.pathname);
  });
  return w;
}
async function closeChecks(w, what) {
  const log = await w.page.evaluate(() => ({ blocked: globalThis.__wyllsDemo.log.blocked, errors: globalThis.__wyllsDemo.log.errors })).catch(() => ({ blocked: [], errors: ['(page gone)'] }));
  check(w.offsite.length === 0 && log.blocked.length === 0, `${what}: no request left the static host (${w.offsite.length + log.blocked.length})`);
  check(w.network.length === 0, `${what}: no herald / relay / coop request over the network (${w.network.slice(0, 3).join(' ')})`);
  check(log.errors.length === 0, `${what}: the in-page world answered every read (${log.errors.join(' | ')})`);
  check(w.problems.length === 0, `${what}: no console / page / HTTP errors${w.problems.length ? `: ${[...new Set(w.problems)].slice(0, 4).join(' | ')}` : ''}`);
  await w.context.close();
}
const shot = async (page, name) => { if (opt.shots) await page.screenshot({ path: `${opt.shots}/${opt.lang}-${name}.png` }); };
const summary = page => page.evaluate(async () => (await globalThis.__wyllsDemo.world()).summary());
const orders = page => page.evaluate(async () => (await globalThis.__wyllsDemo.world()).orders.map(o => ({ name: o.name, ok: o.ok, code: o.code ?? null })));
const saveState = page => page.evaluate(() => globalThis.__wyllsDemo.save());
const savedBlob = page => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('wylls-demo-save')); } catch { return null; } });
const noSeason = async (page, what) => {
  const text = await page.evaluate(() => [document.getElementById('sample-tag')?.innerText ?? '', document.getElementById('sample-tag')?.title ?? '', document.querySelector('[data-demo-reset]')?.getAttribute('data-confirm') ?? '',
    ...[...document.querySelectorAll('[data-demo-crypto], [data-demo-restore], .nc-note')].map(e => e.innerText)].join(' '));
  check(!/season|シーズン/i.test(text), `${what}: no "season" in the demo's words`);
};
async function untilTurn(page, b, into = 0.2) {
  for (let i = 0; i < 600; i++) { const s = await summary(page); if (s.turn > b || (s.turn === b && s.into >= into * 600)) return s; await sleep(250); }
  throw new Error(`turn ${b} never came`);
}
async function picker(page) { await page.locator('[data-act="pick-faction"]').first().waitFor({ state: 'visible', timeout: 30_000 }); }
async function join(page) {
  await picker(page);
  await page.locator('[data-act="pick-faction"]').nth(Number(opt.nation)).click();
  const go = page.locator('[data-stable="join-go"]:not([disabled])').first();
  await go.waitFor({ state: 'visible', timeout: 30_000 });
  await go.click();
  let me = null;
  for (let i = 0; i < 160 && !me; i++) { await sleep(250); me = (await summary(page)).me; }
  return me;
}
/** Train n spearmen through the village drawer (the page's own form and button). */
async function train(page, n) {
  const before = (await orders(page)).length;
  const t0 = Date.now();
  for (;;) {
    await page.locator('#tabs [data-tab="holding"]').first().click({ timeout: 2_000 }).catch(() => {});
    await page.evaluate(() => { const d = document.querySelector('details[data-fold="v-train"]'); if (d && !d.open) d.open = true; });
    const ok = await page.evaluate(n => {
      const f = document.getElementById('hp-train'); if (!f) return false;
      const r = f.querySelector('input[name="unit"][value="0"]'); if (!r) return false;
      r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
      f.elements.n.value = String(n); f.elements.n.dispatchEvent(new Event('input', { bubbles: true }));
      const b = f.querySelector('button[type="submit"]'); if (!b || b.disabled) return false;
      b.click(); return true;
    }, n);
    if (ok) break;
    if (Date.now() - t0 > 25_000) return null;
    await sleep(300);
  }
  for (let i = 0; i < 60; i++) { if ((await orders(page)).length > before) break; await sleep(100); }
  return (await orders(page)).slice(before).find(o => o.name === 'Train') ?? null;
}
/** What must be the same after a reload: the village, its hosts, reserve, queue and marches, every province's land, the orders taken, the turn. */
const snap = async page => {
  const s = await summary(page), me = s.me;
  return {
    turn: s.turn,
    me: me && { village: me.village, nation: me.nation, state: me.state, tier: me.tier, reserve: me.reserve, hosts: me.hosts.map(h => `${h.id}:${h.troops}:${h.tile}:${h.state}`).sort(), queue: me.queue.map(q => `${q.kind}:${q.arg}`), marches: me.marches, works: me.works },
    neighbours: s.neighbours.map(n => `${n.village}:${n.hosts.length}`),
    territory: s.territory, records: s.records,
    orders: (await orders(page)).map(o => `${o.name}:${o.ok}:${o.code}`),
  };
};
const keyOf = page => page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('ps-fsession') || k === 'ps-dev-wallet').sort());
const villageShown = page => page.locator('#tabs [data-tab="holding"]').first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);

// ------------------------------------------------------------------ save → reload → the same world
if (PARTS.has('save')) {
  say(`\n[save] ${srv.url} (${opt.lang})`);
  const w = await open(), { page } = w;
  const t0 = Date.now();
  await page.goto(srv.url);
  const me = await join(page);
  await villageShown(page);
  const cold = Date.now() - t0;
  check(!!me, `joined: village ${me?.village} (cold load → village ${cold} ms)`);
  const st0 = await saveState(page);
  check(st0.on && st0.restore === 'none', `a new world is saved in this browser (${JSON.stringify(st0)})`);
  const tagBtn = (await page.locator('#sample-tag [data-demo-reset]').innerText().catch(() => '')).trim();
  check(tagBtn === (JA ? '最初から' : 'Start over'), `the demo tag has "${tagBtn}"`);
  await noSeason(page, 'save');
  const tr = await train(page, 200);
  check(!!tr?.ok, `train 200 accepted (${JSON.stringify(tr)})`);
  await untilTurn(page, (await summary(page)).turn + 1, 0.3);
  const tr2 = await train(page, 50);
  check(!!tr2?.ok, `a second order in the next turn accepted (${JSON.stringify(tr2)})`);
  await sleep(1500);
  await shot(page, '01-before-reload');
  const before = await snap(page), keyBefore = await keyOf(page);
  const blob = await savedBlob(page);
  check(!!blob && blob.events.filter(e => e.k === 'post').length >= 3, `the save holds the join and the orders (${blob?.events.length} inputs, ${JSON.stringify(blob ?? '').length} chars)`);
  result.saveChars = JSON.stringify(blob ?? '').length;
  // reload 1
  const t1 = Date.now();
  await page.reload();
  const shown = await villageShown(page);
  let after = null;
  for (let i = 0; i < 80; i++) { after = await snap(page).catch(() => null); if (after?.me) break; await sleep(100); }
  const warm = Date.now() - t1;
  result.coldMs = cold; result.resumeMs = warm;
  check(shown && !!after?.me, `reload → own village again in ${warm} ms (cold load to village was ${cold} ms)`);
  check(warm <= Math.max(cold, Number(opt.budget)), `the reload resumes no slower than a cold load reaches the village (${warm} ≤ ${Math.max(cold, Number(opt.budget))} ms)`);
  const st1 = await saveState(page);
  check(st1.restore === 'resume' && st1.on, `the world was restored from the save (${JSON.stringify(st1)})`);
  check(JSON.stringify(after.me) === JSON.stringify(before.me), `the same village, hosts, reserve, queue and marches: ${JSON.stringify(after.me).slice(0, 220)}`);
  if (JSON.stringify(after.me) !== JSON.stringify(before.me)) say(`      before ${JSON.stringify(before.me)}\n      after  ${JSON.stringify(after.me)}`);
  check(JSON.stringify(after.territory) === JSON.stringify(before.territory), 'the same land in every province');
  check(JSON.stringify(after.neighbours) === JSON.stringify(before.neighbours), 'the same neighbour villages and hosts');
  check(JSON.stringify(after.orders) === JSON.stringify(before.orders), `the same orders taken (${after.orders.length})`);
  check(after.turn === before.turn, `the same turn (${before.turn} → ${after.turn})`);
  check(after.records >= before.records, `the world's log continues (${before.records} → ${after.records} records)`);
  check(JSON.stringify(await keyOf(page)) === JSON.stringify(keyBefore), 'the same guest wallet and in-game key in this browser');
  await sleep(1500);
  await shot(page, '02-after-reload');
  const tr3 = await train(page, 30);
  check(!!tr3?.ok, `an order after the reload is accepted (signed by the kept key: ${JSON.stringify(tr3)})`);
  await untilTurn(page, (await summary(page)).turn + 1, 0.3);
  const before2 = await snap(page);
  await page.reload();
  await villageShown(page);
  let after2 = null;
  for (let i = 0; i < 80; i++) { after2 = await snap(page).catch(() => null); if (after2?.me) break; await sleep(100); }
  check(JSON.stringify(after2?.me) === JSON.stringify(before2.me) && after2?.turn === before2.turn && JSON.stringify(after2?.territory) === JSON.stringify(before2.territory), `a second reload: the same world again (turn ${before2.turn} → ${after2?.turn}, ${after2?.orders.length} orders)`);
  // the clock runs on after a resume
  const tA = (await summary(page)).turn;
  await untilTurn(page, tA + 1, 0.05);
  check(true, `the clock runs on after the resume (turn ${tA} → ${(await summary(page)).turn})`);
  await closeChecks(w, 'save');
}

// ------------------------------------------------------------------ a long session: the replay's catch-up
// (the save of a short session with its clock moved on by --long turns: the reload replays the join and the order, then
// catches the world up through every turn, as after an hour of play)
if (PARTS.has('long')) {
  const turns = Number(opt.long);
  say(`\n[long] ${srv.url} (${opt.lang}): ${turns} turns`);
  const w = await open(), { page } = w;
  const t0 = Date.now();
  await page.goto(srv.url);
  await join(page);
  await villageShown(page);
  const cold = Date.now() - t0;
  await train(page, 40);
  await sleep(800);
  const blob = await savedBlob(page), turnBefore = (await summary(page)).turn;
  const moved = JSON.stringify({ ...blob, w: blob.w + turns * 12_000 });
  await page.evaluate(t => sessionStorage.setItem('dp2-inject', t), moved);
  await w.context.addInitScript(() => { const t = sessionStorage.getItem('dp2-inject'); if (t !== null) { localStorage.setItem('wylls-demo-save', t); sessionStorage.removeItem('dp2-inject'); } });
  const t1 = Date.now();
  await page.reload();
  const shown = await villageShown(page);
  let me = null;
  for (let i = 0; i < 400 && !me; i++) { me = (await summary(page).catch(() => ({}))).me; if (!me) await sleep(50); }
  const warm = Date.now() - t1, turnAfter = (await summary(page)).turn;
  result.long = { turns, coldMs: cold, resumeMs: warm, turnBefore, turnAfter };
  check(shown && !!me && (await saveState(page)).restore === 'resume', `${turns} turns later: the village again in ${warm} ms (cold load to village ${cold} ms)`);
  check(turnAfter >= turnBefore + turns, `the world caught up: turn ${turnBefore} → ${turnAfter}`);
  check(warm <= Math.max(cold, Number(opt.budget)), `resume within the cold load's time to the village (${warm} ≤ ${Math.max(cold, Number(opt.budget))} ms)`);
  await closeChecks(w, 'long');
}

// ------------------------------------------------------------------ a damaged / old / differing save → a fresh world, said
if (PARTS.has('bad')) {
  say(`\n[bad] ${srv.url} (${opt.lang})`);
  const w = await open(), { page } = w;
  await page.goto(srv.url);
  const me = await join(page);
  check(!!me, 'joined');
  await train(page, 40);
  await sleep(800);
  const good = await savedBlob(page);
  const cases = [
    ['corrupt', '{"v":1,"world":"x", "events": [', 'corrupt'],
    ['corrupt shape', JSON.stringify({ ...good, events: [{ w: 5, k: 'post', m: 'POST', p: '/etc/passwd', b: null, r: '0' }] }), 'corrupt'],
    ['old world build', JSON.stringify({ ...good, world: '0000000000000000' }), 'old'],
    ['old format', JSON.stringify({ ...good, v: 0 }), 'old'],
    ['replay differs', JSON.stringify({ ...good, events: good.events.map((e, i) => (e.k === 'post' && i === good.events.findIndex(x => x.k === 'post') ? { ...e, r: 'deadbeef' } : e)) }), 'failed'],
  ];
  for (const [name, text, want] of cases) {
    // the page writes its save again on pagehide: the damaged one is put in place by a script that runs before any other
    await page.evaluate(t => { sessionStorage.setItem('dp2-inject', t); }, text);
    await w.context.addInitScript(() => { const t = sessionStorage.getItem('dp2-inject'); if (t !== null) { localStorage.setItem('wylls-demo-save', t); sessionStorage.removeItem('dp2-inject'); } });
    await page.reload();
    await picker(page);
    let st = null;
    for (let i = 0; i < 40; i++) { st = await saveState(page); if (st.restore === want) break; await sleep(150); }
    const note = page.locator(`[data-demo-restore="${want}"]`);
    await note.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    const noteText = (await note.first().innerText().catch(() => '')).trim();
    const fresh = (await summary(page)).me === null;
    check(st?.restore === want && fresh && !!noteText, `${name}: a fresh world (no village), the picker says so: "${noteText}"`);
    await shot(page, `03-bad-${want}`);
    await noSeason(page, name);
    const ls = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ps-fsession')));
    check(ls.length === 0, `${name}: the old in-game key was cleared with the save (${ls.length})`);
    // back to a real world for the next case
    const again = await join(page);
    await train(page, 40);
    await sleep(600);
    Object.assign(good, await savedBlob(page));
    check(!!again, `${name}: a new village can be founded after it`);
  }
  await closeChecks(w, 'bad');
}

// ------------------------------------------------------------------ Start over
if (PARTS.has('reset')) {
  say(`\n[reset] ${srv.url} (${opt.lang})`);
  const w = await open(), { page } = w;
  await page.goto(srv.url);
  const me = await join(page);
  check(!!me, 'joined');
  await sleep(1000);
  let asked = null;
  page.once('dialog', d => { asked = d.message(); d.dismiss(); });
  await page.locator('#sample-tag [data-demo-reset]').click();
  await sleep(1200);
  check(!!asked && (await summary(page)).me !== null && !!(await savedBlob(page)), `dismissing "${asked}" keeps the world and its save`);
  check(JA ? /最初から/.test(asked ?? '') : /Start the demo over/.test(asked ?? ''), 'the question says what it does');
  page.once('dialog', d => { asked = d.message(); d.accept(); });
  await page.locator('#sample-tag [data-demo-reset]').click();
  await page.waitForLoadState('load');
  await picker(page);
  await sleep(800);
  const s = await summary(page), blob = await savedBlob(page);
  check(s.me === null && (!blob || blob.events.every(e => e.k === 'seen')), `accepting starts a new world: the nation picker, no village, an empty save (${blob ? blob.events.length : 'none'})`);
  check((await saveState(page)).restore === 'none' && !(await page.locator('[data-demo-restore]').count()), 'no "could not be restored" note after a chosen start-over');
  await shot(page, '04-after-start-over');
  await closeChecks(w, 'reset');
}

// ------------------------------------------------------------------ no WebCrypto Ed25519 / not https
if (PARTS.has('crypto')) {
  const stubs = {
    NoEd25519: () => {
      const S = globalThis.crypto.subtle, ed = a => (typeof a === 'string' ? a : a?.name) === 'Ed25519';
      for (const f of ['importKey', 'generateKey', 'sign', 'verify', 'exportKey', 'deriveBits']) {
        const real = S[f]?.bind(S);
        if (real) S[f] = (...args) => (args.some(ed) ? Promise.reject(new DOMException('Unrecognized algorithm name', 'NotSupportedError')) : real(...args));
      }
    },
    InsecureContext: () => { Object.defineProperty(globalThis, 'isSecureContext', { get: () => false }); },
  };
  for (const [code, init] of Object.entries(stubs)) {
    say(`\n[crypto ${code}] ${srv.url} (${opt.lang})`);
    const w = await open({ init }), { page } = w;
    await page.goto(srv.url);
    await picker(page);
    await page.locator('[data-act="pick-faction"]').nth(Number(opt.nation)).click();
    const notice = page.locator(`[data-demo-crypto="${code}"]`);
    const shown = await notice.first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    const text = (await notice.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    check(shown, `${code}: the picker shows the notice: "${text}"`);
    if (code === 'NoEd25519') check(JA ? /Chrome または Edge 137 以降、Firefox 129 以降、Safari 17 以降/.test(text) : /Chrome or Edge 137 or later, Firefox 129 or later, or Safari 17 or later/.test(text), `${code}: it names the browsers that work`);
    else check(/https/.test(text), `${code}: it says to open the https address`);
    await sleep(1500);
    check((await page.locator('[data-stable="join-go"]').count()) === 0, `${code}: no join button to fail`);
    check((await summary(page)).me === null && (await orders(page)).length === 0, `${code}: nothing was sent`);
    await noSeason(page, code);
    await shot(page, `05-${code}`);
    // (the page's own load is not an error: the stub refuses quietly; an error here would be the page failing loudly)
    await closeChecks(w, code);
  }
}

if (opt.shots) writeFileSync(`${opt.shots}/${opt.lang}-save-result.json`, JSON.stringify({ ...result, fails }, null, 1));
say(JSON.stringify(result));
await browser.close();
await srv.close();
say(fails.length ? `\n${fails.length} check(s) failed` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
