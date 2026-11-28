#!/usr/bin/env node
// The walletless demo's single-player goal, played to its end in headless Chromium (playwright-core): the built dist/
// AT the Pages host name (routed in the browser, as smoke.mjs --origin), a fresh profile, no wallet extension.
//
//   node smoke-goal.mjs --path win|lose [--nation 1] [--lang en|ja] [--fast 4] [--shots DIR] [--reload]
//                       [--origin https://r0ze998.github.io --prefix /wylls/] [--url https://r0ze998.github.io/wylls/]
//
// win   the page's own controls only: train (village drawer), form hosts, open a march (Hosts → March), press the goal
//       card's "March here" on a rival castle, seal and send — until the result screen says Victory.
// lose  join and do nothing: the AI nations' waves reach the goal first — until the result screen says Defeat.
// --fast N  the waits run N times faster: while no march of the player's is out it steps the world's clock a turn at a
//           time (__wyllsDemo.world().advance(), the sample world's own test step) instead of waiting 12 s. 1 = real time.
// --reload  once the player's nation holds a captured castle (win) or a rival does (lose), reload the page mid-hold:
//           the castles, their holders and every hold timer must be what they were (the save, #308).
// --url     play a LIVE deployment instead of dist/ (the independent verifier's run on GitHub Pages).
// Always: no wallet prompt, no request leaves the host (0 service requests: every /h /gw read answered in the page),
// no console / page / HTTP error, the result screen shows the time and "Play again" starts a new world.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { TYPES } from './serve.mjs';

const { values: opt } = parseArgs({ options: {
  dir: { type: 'string', default: new URL('dist', import.meta.url).pathname }, path: { type: 'string', default: 'win' }, nation: { type: 'string', default: '1' },
  lang: { type: 'string', default: 'en' }, fast: { type: 'string', default: '4' }, shots: { type: 'string' }, reload: { type: 'boolean', default: false },
  origin: { type: 'string', default: 'https://r0ze998.github.io' }, prefix: { type: 'string', default: '/wylls/' }, url: { type: 'string' },
  minutes: { type: 'string', default: '60' }, headed: { type: 'boolean', default: false }, mobile: { type: 'boolean', default: false },
} });
const JA = opt.lang === 'ja', FAST = Math.max(1, Number(opt.fast) || 1), WIN = opt.path === 'win';
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
if (opt.shots) mkdirSync(opt.shots, { recursive: true });
const TAG = `${opt.path}-${opt.lang}${opt.mobile ? '-mobile' : ''}`;
const shot = async (page, name) => { if (opt.shots) await page.screenshot({ path: `${opt.shots}/${TAG}-${name}.png` }).catch(() => {}); };

// ------------------------------------------------------------------ the host: dist/ at the Pages origin, or a live URL
const pre = `/${String(opt.prefix).replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const base = opt.url ?? `${new URL(opt.origin).origin}${pre}`;
const hostOrigin = new URL(base).origin;
const offsite = [];
async function route(r) {
  const u = new URL(r.request().url());
  if (u.origin !== hostOrigin) { if (!/^(?:data|blob):/.test(u.protocol)) offsite.push(u.href); return r.abort('blockedbyclient'); }
  if (opt.url) return r.continue();
  const root = resolve(opt.dir) + sep;
  let rel = u.pathname.startsWith(pre) ? decodeURIComponent(u.pathname.slice(pre.length)) : null;
  if (rel !== null && (rel === '' || rel.endsWith('/'))) rel += 'index.html';
  const full = rel === null ? null : normalize(join(root, rel));
  if (full && full.startsWith(root) && (await stat(full).catch(() => null))?.isFile()) return r.fulfill({ status: 200, contentType: TYPES[extname(full)] ?? 'application/octet-stream', body: await readFile(full) });
  const nf = normalize(join(root, '404.html'));
  return r.fulfill({ status: 404, contentType: TYPES['.html'], body: await readFile(nf).catch(() => 'not found') });
}

const browser = await chromium.launch({ headless: !opt.headed });
const view = opt.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } };
const context = await browser.newContext({ ...view, locale: JA ? 'ja-JP' : 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
await context.route('**/*', route);
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push(`page error: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('dialog', d => { problems.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });

const W = () => page.evaluate(async () => { const live = await globalThis.__wyllsDemo.world(); return { s: live.summary(), g: live.goal() }; });
const WALLET_PROMPT = /connect a wallet|No wallet found|Install a Solana wallet|ウォレットをつな|ウォレットが見つかりません|ウォレットを入れて/;
async function noWalletPrompt(step) {
  const text = await page.locator('body').innerText().catch(() => '');
  const hit = WALLET_PROMPT.exec(text)?.[0] ?? null, buttons = await page.locator('[data-act="connect"]').count();
  check(!hit && buttons === 0, `${step}: no wallet prompt${hit || buttons ? ` (FOUND "${hit}", ${buttons})` : ''}`);
}
async function press(sel, { timeout = 8_000 } = {}) {
  const l = page.locator(sel).first(), t0 = Date.now();
  for (;;) {
    try { await l.waitFor({ state: 'attached', timeout: 1_000 }); await l.evaluate(el => el.scrollIntoView({ block: 'center' })); await l.click({ timeout: 1_500 }); return true; } catch { if (Date.now() - t0 > timeout) return false; await sleep(150); }
  }
}
const tab = async name => {
  const open = await page.evaluate(n => { const FS = globalThis.__wyllsDemo.modules['fstate.mjs']?.FS; return FS?.tab === n && document.getElementById('panel')?.dataset.drawer === 'open'; }, name);
  return open || press(`#tabs [data-tab="${name}"]`);
};
const unfold = key => page.evaluate(k => { const d = document.querySelector(`details[data-fold="${k}"]`); if (d && !d.open) d.open = true; return !!d; }, key);
const orders = () => page.evaluate(async () => (await globalThis.__wyllsDemo.world()).orders.map(o => ({ name: o.name, ok: o.ok, code: o.code ?? null })));
async function order(what, name, doIt) {
  const before = (await orders()).length;
  let pressed = false;
  for (let attempt = 0; attempt < 3 && !pressed; attempt++) {
    if (attempt) { await page.keyboard.press('Escape').catch(() => {}); await press('[data-act="drawer-close"]', { timeout: 1_500 }); await sleep(600); }
    pressed = await doIt();
  }
  if (!pressed) { say(`    ${what}: NOT PRESSED`); return false; }
  for (let i = 0; i < 60; i++) { if ((await orders()).length > before) break; await sleep(100); }
  const o = (await orders()).slice(before).find(x => x.name === name);
  say(`    ${what}: ${o ? (o.ok ? 'accepted' : `REFUSED ${o.code}`) : 'NOT SENT'}`);
  return !!o?.ok;
}
async function fillAndSubmit(formId, fold, unit, field, n, timeout = 20_000) {
  const t0 = Date.now();
  for (;;) {
    await tab('holding'); await unfold(fold);
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
const train = n => order(`train ${n} Spearmen`, 'Train', () => fillAndSubmit('hp-train', 'v-train', 0, 'n', n));
const muster = n => order(`form a host of ${n} Spearmen`, 'Muster', () => fillAndSubmit('hp-muster', 'v-muster', 0, 'troops', n));
/** A march from the page: Hosts → the host's March → the goal card's "March here" on the castle → seal and send. */
const marchCastle = (host, c) => order(`march host ${host} on ${c.nation}'s castle (${c.p},${c.q}/${c.tile}) from the goal card`, 'Depart', async () => {
  await tab('hosts');
  if (!(await press(`[data-act="compose"][data-host="${host}"]:not([disabled])`))) return false;
  await page.locator('#mc-title').waitFor({ timeout: 8_000 }).catch(() => {});
  if (!(await press(`#demo-goal li[data-castle="${c.nation}"] [data-act="dest-quick"]`, { timeout: 6_000 }))) { say('      (no "March here" on the goal card)'); return false; }
  await sleep(500);
  return press('[data-act="march-send"]:not([disabled])', { timeout: 20_000 });
});
/** Wait `turns` turns: real time, or with --fast the world's own test step every 12 s / FAST. */
async function wait(turns = 1) {
  // (never while a march of the player's is out: the page reveals it itself in its arrival turn, which a step could skip)
  for (let i = 0; i < turns; i++) {
    const out = await page.evaluate(async () => ((await globalThis.__wyllsDemo.world()).summary().me?.marches.length ?? 0) > 0);
    if (FAST <= 1 || out) { await sleep(12_000); continue; }
    await sleep(12_000 / FAST);
    await page.evaluate(async () => { (await globalThis.__wyllsDemo.world()).advance(); });
  }
}
const castlesText = g => g.castles.map(c => `${c.nation}:${c.holder ?? '-'}@${c.since}`).join(' ');

// ------------------------------------------------------------------ load → pick a nation → the village
say(`demo goal smoke (${opt.path}, ${opt.lang}, nation ${opt.nation}, fast ×${FAST}): ${base}`);
const t0 = Date.now();
await page.goto(base + `?lang=${opt.lang}`);
await page.locator('[data-act="pick-faction"]').first().waitFor({ state: 'visible', timeout: 30_000 });
await noWalletPrompt('the nation picker');
const preCard = (await page.locator('#demo-goal').innerText().catch(() => '')).replace(/\s+/g, ' ');
check(JA ? /旗の城/.test(preCard) : /flag castles/.test(preCard), `the goal card is on the picker: "${preCard.slice(0, 120)}"`);
check(!/season|シーズン/i.test(preCard), 'the goal card never says "season"');
await shot(page, '01-picker');
await page.locator('[data-act="pick-faction"]').nth(Number(opt.nation)).click();
await page.locator('[data-stable="join-go"]:not([disabled])').first().click({ timeout: 30_000 });
let start = null;
for (let i = 0; i < 120 && !(start?.g.posted); i++) { await sleep(250); start = await W(); }
check(start?.g.posted !== null && start?.g.player === Number(opt.nation), `joined: the goal is posted at turn ${start?.g.posted} for nation ${start?.g.player}`);
await sleep(2500);
await noWalletPrompt('the village');
const card = (await page.locator('#demo-goal').innerText()).replace(/\s+/g, ' ');
check(/3/.test(card) && (JA ? /20ターン/.test(card) : /20 turns/.test(card)), `the goal card states the goal: "${card.slice(0, 160)}"`);
check((await page.locator('#demo-goal li[data-castle]').count()) === 6, 'the goal card lists the six flag castles');
await shot(page, '02-village');

// ------------------------------------------------------------------ play
const deadline = Date.now() + Number(opt.minutes) * 60_000;
let reloaded = !opt.reload, result = null, built = 0, marches = 0;
const dest = new Map();
while (Date.now() < deadline) {
  const { s, g } = await W();
  if (g.result) { result = g.result; break; }
  const mine = g.player, me = s.me, b = s.turn;
  // --reload: mid-hold (a hold is counting), the page is loaded again and must show the same castles and timers
  const counting = g.progress.find(x => (WIN ? x.nation === mine : x.nation !== mine) && x.castles.some(c => c.longAt > b && b - c.from >= 2));
  if (!reloaded && counting) {
    reloaded = true;
    const before = castlesText(g), turnBefore = b;
    await shot(page, '05-before-reload');
    await page.reload();
    await page.locator('#demo-goal li[data-castle]').first().waitFor({ timeout: 30_000 });
    const after = await W();
    const same = after.g.castles.every((c, i) => c.holder === g.castles[i].holder && c.since === g.castles[i].since);
    check(same && after.g.posted === g.posted && after.s.turn >= turnBefore, `reload mid-hold (turn ${turnBefore} → ${after.s.turn}): castles, holders and hold starts kept (${before} | ${castlesText(after.g)})`);
    const p0 = g.progress.find(x => x.nation === counting.nation), p1 = after.g.progress.find(x => x.nation === counting.nation);
    check(p1 && p1.castles.length === p0.castles.length && p1.castles.every((c, i) => c.from === p0.castles[i].from && c.longAt === p0.castles[i].longAt), `the hold timers of ${counting.nation} survive the reload (${JSON.stringify(p1?.castles.map(c => [c.from, c.longAt]))})`);
    await shot(page, '06-after-reload');
    continue;
  }
  if (WIN && me) {
    // the economy and the army, through the village drawer: a farm and an ore mine first, then Spearmen
    if (built < 2) { const item = built === 0 ? 0 : 3; if (await order(`build ${item === 0 ? 'a farm' : 'an ore mine'}`, 'Build', async () => { await tab('holding'); await unfold('v-build'); return press(`#hp-build [data-item="${item}"], [data-act="build"][data-item="${item}"], form#hp-build button[value="${item}"]`, { timeout: 4_000 }); })) built++; else built = 2; }
    const food = me.stores[0], ore = me.stores[3], gold = me.stores[5];
    const can = Math.floor(Math.min(food / 60, ore / 20, gold / 10)) * 100;
    if (can >= 200) await train(Math.min(can, 1000));
    const { s: s2 } = await W();
    if (s2.me.reserve[0] >= 200 && s2.me.state === 2) await muster(s2.me.reserve[0]);
    // march: defend a captured castle nobody of ours stands on, else the nearest rival castle the ready hosts outnumber
    const { s: s3, g: g3 } = await W(), m3 = s3.me;
    const onCastle = h => g3.castles.some(c => c.p === h.province[0] && c.q === h.province[1] && c.tile === h.tile);
    const ready = m3.hosts.filter(h => h.state === 1 && h.unit === 0 && h.stamina >= 74 && h.readyBell <= s3.turn && !m3.marches.some(x => x.host === h.id) && h.troops >= 100 && !onCastle(h)).sort((a, c) => c.troops - a.troops);
    const foes = await page.evaluate(async cs => { const live = await globalThis.__wyllsDemo.world(); return cs.map(c => live.province(c.p, c.q).entries.filter(e => e.state === 1 && e.tile === c.tile && e.faction !== c.me).reduce((a, e) => a + Math.floor(e.troops / 1000), 0)); }, g3.castles.map(c => ({ ...c, me: mine })));
    const ours = await page.evaluate(async cs => { const live = await globalThis.__wyllsDemo.world(); return cs.map(c => live.province(c.p, c.q).entries.filter(e => e.state === 1 && e.tile === c.tile && e.faction === c.me).reduce((a, e) => a + Math.floor(e.troops / 1000), 0)); }, g3.castles.map(c => ({ ...c, me: mine })));
    const coming = c => m3.marches.some(x => dest.get(x.host) === c.nation);
    const targets = [...g3.castles.map((c, i) => ({ ...c, i })).filter(c => c.holder === mine && c.nation !== mine && ours[c.i] < 150 && !coming(c)),
      ...g3.castles.map((c, i) => ({ ...c, i })).filter(c => c.nation !== mine && c.holder !== mine && !coming(c) && !dest.get(`far${c.nation}`))];
    for (const c of targets) {
      const want = c.holder === mine ? 1 : foes[c.i] * 1.3 + 50;
      if (ready.reduce((a, h) => a + h.troops, 0) < want) continue;
      let sent = 0;
      while (sent < want && ready.length) {
        const h = ready.shift();
        if (await marchCastle(h.id, c)) { sent += h.troops; marches++; dest.set(h.id, c.nation); if (marches === 1) await shot(page, '03-first-march'); }
        else { dest.set(`far${c.nation}`, true); break; }
      }
      break;
    }
    await press('[data-act="drawer-close"]', { timeout: 1_000 });
  }
  const { g: g4, s: s4 } = await W();
  say(`  turn ${s4.turn - g4.posted}: castles ${castlesText(g4)}; mine ${g4.progress.find(x => x.nation === mine)?.captured ?? 0}; rivals ${g4.progress.filter(x => x.nation !== mine && x.captured).map(x => `${x.nation}:${x.captured}/${x.reachAt === null ? '-' : x.reachAt - s4.turn}`).join(' ')}`);
  if ((s4.turn - g4.posted) % 10 === 0) await shot(page, `04-turn-${String(s4.turn - g4.posted).padStart(3, '0')}`);
  await wait(1);
}

// ------------------------------------------------------------------ the result screen
check(!!result, `the game ended: ${JSON.stringify(result)}`);
check(result?.state === (WIN ? 'won' : 'lost'), `the ${opt.path} path ends in ${WIN ? 'a win' : 'a loss'} (${result?.state})`);
const box = page.locator('#demo-result');
const shown = await box.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
check(shown, 'the result screen is shown');
const txt = (await box.innerText().catch(() => '')).replace(/\s+/g, ' ');
const want = WIN ? (JA ? /勝利/ : /Victory/) : (JA ? /敗北/ : /Defeat/);
check(want.test(txt) && (JA ? /かかった時間/ : /Time:/).test(txt) && (JA ? /もう一度遊ぶ/ : /Play again/).test(txt), `the result screen: "${txt}"`);
check(!/season|シーズン/i.test(txt), 'the result screen never says "season"');
const g5 = (await W()).g;
say(`  result after ${result ? result.bell - g5.posted : '?'} turns (${result ? (((result.bell - g5.posted) * 12) / 60).toFixed(1) : '?'} min at the demo clock); ${marches} marches from the page`);
await shot(page, '07-result');
await noWalletPrompt('the result screen');
// Play again: a new world (the save cleared), the picker again, no question asked
await page.locator('#demo-result [data-demo-reset="now"]').click();
await page.waitForEvent('load', { timeout: 30_000 }).catch(() => {});
await page.locator('[data-act="pick-faction"]').first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => check(true, 'Play again: a new world, the nation picker again'), () => check(false, 'Play again: a new world, the nation picker again'));
const again = await W();
check(again.g.posted === null && again.g.result === null && !again.s.me, `Play again cleared the game (posted ${again.g.posted}, result ${JSON.stringify(again.g.result)})`);
check(!(await page.locator('#demo-result').count()), 'no result screen on the new world');
await shot(page, '08-play-again');

// ------------------------------------------------------------------ the request log
const blocked = await page.evaluate(() => globalThis.__wyllsDemo.log.blocked);
const errors = await page.evaluate(() => globalThis.__wyllsDemo.log.errors);
check(offsite.length === 0, `no request left the host (${offsite.length}${offsite.length ? `: ${offsite.slice(0, 3).join(' ')}` : ''})`);
check(blocked.length === 0, `the page asked for no other origin (${blocked.length})`);
check(errors.length === 0, `the in-page world answered every read (${errors.join(' | ')})`);
check(problems.length === 0, `no console / page / HTTP errors / dialogs${problems.length ? `: ${[...new Set(problems)].slice(0, 5).join(' | ')}` : ''}`);
const out = { path: opt.path, lang: opt.lang, nation: Number(opt.nation), fast: FAST, result, turns: result ? result.bell - g5.posted : null, marches, wallMs: Date.now() - t0, fails };
if (opt.shots) writeFileSync(`${opt.shots}/${TAG}-result.json`, JSON.stringify(out, null, 1));
say(JSON.stringify(out));
await browser.close();
say(fails.length ? `\n${fails.length} check(s) failed` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
