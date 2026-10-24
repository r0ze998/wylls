// The visual uplift's order card under the states the brief names (docs/design/uplift/04-VERIFY): the keyboard,
// reduced motion, no rules kernel, the relay down, English on a 360-px phone, and the card without colour. Each state
// is one fresh page on the frozen fixture world, the same march (the hosts drawer → a defended village), a check that
// fails loudly and a picture. Not part of the gate; a camera with assertions.
//
//   node uplift-states.mjs [--out <dir>] [--only kbd,motion]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as W from './world.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const out = resolve(arg('out', '../../.local/shots/states'));
const only = (arg('only', '') || '').split(',').filter(Boolean);

function initScript({ storage }) {
  let s = 0x2545f491;
  Math.random = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
  try { for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); } catch { /* no storage */ }
}

/** The march to the defended village (2, 0, tile 26), through the card's own coordinates form. */
async function compose(page) {
  await page.locator('#tabs [data-tab="hosts"]').click();
  await page.locator('#panel-body button[data-act="compose"]:not([disabled])').first().click({ timeout: 8000 });
  await page.evaluate(() => { const f = document.querySelector('form[data-form="dest"]'); f.querySelector('[name=p]').value = 2; f.querySelector('[name=q]').value = 0; f.querySelector('[name=tile]').value = 26; f.requestSubmit(); });
  await page.locator('.mc-outlook').first().waitFor({ timeout: 12000 });
}
const waitCompare = page => page.locator('.mc-compare .mcc-row').first().waitFor({ timeout: 15000 });

const STATES = [
  ['kbd', 'the stances compared, by keyboard: the arrows move the choice', {}, async (page, ok) => {
    await compose(page); await waitCompare(page);
    const rows = page.locator('.mc-compare .mcc-row');
    const before = await rows.evaluateAll(r => r.findIndex(x => x.getAttribute('aria-checked') === 'true'));
    await rows.nth(before).focus();
    // (the comparison stays standing through the change: it fell back to the plain pictures while the new stance's own
    // forecast was made, and the focus went with it: the independent review of 2026-10-24)
    const watch = page.evaluate(async () => { let gone = 0; for (let i = 0; i < 90; i++) { await new Promise(r => requestAnimationFrame(r)); if (!document.querySelector('.mc-compare')) gone++; } return gone; });
    await page.keyboard.press('ArrowDown');
    const gone = await watch;
    ok(gone === 0, `the comparison stood in every frame after the change (${gone} frames without it)`);
    await page.waitForTimeout(400);
    const after = await page.locator('.mc-compare .mcc-row').evaluateAll(r => r.findIndex(x => x.getAttribute('aria-checked') === 'true'));
    const focused = await page.evaluate(() => document.activeElement?.closest?.('.mcc-row')?.dataset.v ?? null);
    ok(after === (before + 1) % 4, `ArrowDown moved the choice ${before} → ${after}`);
    ok(focused !== null && Number(focused) === after, `the focus followed the choice (on ${focused})`);
    await page.keyboard.press('Home'); await page.waitForTimeout(300);
    ok(await page.locator('.mc-compare .mcc-row').first().getAttribute('aria-checked') === 'true', 'Home chose the first stance');
  }],
  ['newdest', 'a new destination: the last one\'s forecast is never shown beside the new defenders', {}, async (page, ok) => {
    await compose(page); await waitCompare(page);
    await page.locator('.mc-outlook .mo-fc').filter({ hasText: /\d/ }).waitFor({ timeout: 15000 });
    const before = (await page.locator('.mc-outlook .mo-fc').innerText()).replace(/\s+/g, ' ');
    const beforeName = await page.locator('.mc-dest-name').innerText();
    // to the camp of the home province (another defended tile), sampled in the frames right after the change
    const seen = await page.evaluate(async ({ p, q, tile }) => {
      const f = document.querySelector('form[data-form="dest"]');
      f.querySelector('[name=p]').value = p; f.querySelector('[name=q]').value = q; f.querySelector('[name=tile]').value = tile; f.requestSubmit();
      const out = [];
      for (let i = 0; i < 30; i++) { await new Promise(r => requestAnimationFrame(r)); out.push([document.querySelector('.mc-dest-name')?.textContent ?? '', document.querySelector('.mc-outlook .mo-fc')?.textContent?.replace(/\s+/g, ' ') ?? '']); }
      return out;
    }, { p: W.HOME.p, q: W.HOME.q, tile: W.CAMP_TILE });
    const oldNums = before.match(/\d[\d,]*〜?[\d,]*/)?.[0];
    const moved = seen.filter(([name]) => name && name !== beforeName);
    const stale = moved.filter(([, fc]) => fc.includes(oldNums));
    ok(!!oldNums && moved.length > 0, `the card moved to the new destination in ${moved.length} of ${seen.length} frames (old forecast ${oldNums})`);
    ok(!stale.length, `the old destination's forecast never stood beside the new one (${stale.length} frames)`);
  }],
  ['motion', 'reduced motion: nothing in the card moves', { reducedMotion: 'reduce' }, async (page, ok) => {
    await compose(page); await waitCompare(page);
    const moving = await page.evaluate(() => [...document.querySelectorAll('.mc-compare *, .mc-outlook *, .state-tag')].filter(e => {
      const s = getComputedStyle(e);
      const dur = x => x.split(',').some(t => parseFloat(t) > 0.01);
      return (s.animationName !== 'none' && dur(s.animationDuration)) || dur(s.transitionDuration);
    }).map(e => e.className).slice(0, 5));
    ok(moving.length === 0, `no animation or transition under reduced motion (${moving.join(' | ') || 'none'})`);
  }],
  ['nokernel', 'no rules kernel: the outlook stands, no forecast is made up', { block: '**/*.wasm' }, async (page, ok) => {
    await compose(page);
    await page.waitForTimeout(3000);
    const t = await page.locator('.mc-outlook').first().innerText();
    ok(!(await page.locator('.mc-compare .mcc-row').count()), 'no stance comparison without the kernel');
    ok(!/残る兵\s*\d/.test(t), 'no troops left forecast without the kernel');
    ok(/ターン/.test(t), `the arrival is still said (${t.replace(/\s+/g, ' ').slice(0, 80)})`);
  }],
  ['relaydown', 'the relay down at send: an error that says so; nothing kept as sent', { failRelay: true }, async (page, ok) => {
    await compose(page); await waitCompare(page);
    await page.locator('[data-act="march-send"]:not([disabled])').click({ timeout: 10000 });
    await page.waitForTimeout(3000);
    const body = await page.locator('body').innerText();
    ok(/できません|失敗|つながりません|もう一度|送れません/.test(body), 'the failure is said in words');
    const kept = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ps-ffc:')).map(k => localStorage.getItem(k)).join(''));
    ok(!kept || kept === '{}' || kept === '[]', `no forecast kept for a march that was not sent (${(kept || '').slice(0, 60)})`);
  }],
  ['en360', 'English on a 360-px phone: the card fits, the rows are big enough to touch', { vp: { width: 360, height: 780 }, phone: true, lang: 'en' }, async (page, ok) => {
    await compose(page); await waitCompare(page);
    await page.locator('.mc-compare').scrollIntoViewIfNeeded();
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - innerWidth,
      cut: [...document.querySelectorAll('.mc-compare *, .mc-outlook *')].filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').map(e => e.className).slice(0, 5),
      rows: [...document.querySelectorAll('.mcc-row')].map(r => Math.round(r.getBoundingClientRect().height)) }));
    ok(m.doc <= 0, `no sideways scroll (${m.doc} px over)`);
    ok(!m.cut.length, `nothing clipped in the outlook or the comparison (${m.cut.join(' | ') || 'none'})`);
    ok(m.rows.every(h => h >= 44), `rows at least 44 px high (${m.rows.join(', ')})`);
  }],
  ['report', 'the report beside what this device forecast at departure: 予測 and 確定 apart, a miss said in words', { kept: { min: 540, max: 580 } }, async (page, ok) => {
    await page.locator('#tabs [data-tab="marches"]').click();
    await page.locator('#panel-body [data-act="report-open"]').first().click({ timeout: 10000 });
    await page.locator('#panel .rep-predict').waitFor({ timeout: 10000 });
    const t = (await page.locator('#panel .rep-predict').innerText()).replace(/\s+/g, ' ');
    ok(/予測/.test(t) && /確定/.test(t), `both columns are named (${t.slice(0, 90)})`);
    ok(/540〜580/.test(t), 'the kept range is shown as kept');
    ok(/520/.test(t), 'the record\'s number is shown');
    ok(/予測の幅の外/.test(t), 'a result outside the range is said in words');
  }],
  ['report-none', 'the report on a device that kept no forecast: the result alone, no forecast made up', {}, async (page, ok) => {
    await page.locator('#tabs [data-tab="marches"]').click();
    await page.locator('#panel-body [data-act="report-open"]').first().click({ timeout: 10000 });
    await page.locator('#panel #report-title').waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    ok(!(await page.locator('#panel .rep-predict').count()), 'no forecast section');
  }],
  ['landscape', 'a phone held sideways (844 × 390): the card and its send button stay reachable', { vp: { width: 844, height: 390 }, phone: true }, async (page, ok) => {
    await compose(page); await waitCompare(page);
    const m = await page.evaluate(() => {
      const send = document.querySelector('[data-act="march-send"]')?.getBoundingClientRect();
      return { doc: document.documentElement.scrollWidth - innerWidth, send: send && { top: Math.round(send.top), bottom: Math.round(send.bottom), h: Math.round(send.height) }, vh: innerHeight };
    });
    ok(m.doc <= 0, `no sideways scroll (${m.doc} px over)`);
    ok(!!m.send && m.send.bottom <= m.vh && m.send.top >= 0, `the send button is on screen (${JSON.stringify(m.send)} of ${m.vh})`);
    ok(!!m.send && m.send.h >= 40, 'the send button is big enough to touch');
  }],
  ['grey', 'the card without colour: states still differ by shape and word', { grey: true }, async (page, ok) => {
    await compose(page); await waitCompare(page);
    // (the page's CSP refuses an injected style sheet; a CSSOM change is the browser's own)
    await page.evaluate(() => { document.documentElement.style.filter = 'grayscale(1)'; });
    const tags = await page.locator('.mc-card .state-tag, .mc .state-tag, #panel .state-tag').allInnerTexts();
    ok(tags.length > 0 && tags.every(t => t.trim().length > 0), `every state tag has a word (${tags.join(', ')})`);
  }],
];

const srv = await startServer();
const browser = await chromium.launch();
const results = [];
mkdirSync(out, { recursive: true });
let failed = 0;
try {
  for (const [id, title, o, run] of STATES) {
    if (only.length && !only.includes(id)) continue;
    srv.stage('holding');
    const vp = o.vp ?? { width: 1440, height: 900 }, lang = o.lang ?? 'ja';
    const context = await browser.newContext({ viewport: vp, isMobile: !!o.phone, hasTouch: !!o.phone, locale: lang === 'ja' ? 'ja-JP' : 'en-GB', timezoneId: 'UTC', deviceScaleFactor: 1, reducedMotion: o.reducedMotion ?? 'no-preference' });
    const storage = W.storageFor(srv.viewer, { stage: 'holding', lang, intro: false, live: false });
    // (a forecast this device kept when the viewer's host left for the report's turn: hud/forecastbook.mjs)
    if (o.kept) storage[`ps-ffc:${W.SEASON_ID}`] = JSON.stringify([{ host: String(W.HOSTS.free), bell: W.REPORT_BELL, stance: 3, start: 600, runs: 8, fates: { Stays: 8 }, ...o.kept }]);
    await context.addInitScript(initScript, { storage });
    if (o.block) await context.route(o.block, r => r.abort());
    if (o.failRelay) await context.route(/\/f\/(relay|tx)/, r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"code":"Unavailable"}' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.setFixedTime(new Date(W.LATEST_UNIX * 1000 + 500));
    await page.goto(`${srv.url}/frontier/index.html`);
    await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading', null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const checks = [];
    const ok = (c, what) => { checks.push({ ok: !!c, what }); if (!c) failed++; };
    try { await run(page, ok); } catch (e) { ok(false, `scene: ${e.message.split('\n')[0]}`); }
    ok(!errors.length, `no page errors (${errors.join(' | ') || 'none'})`);
    await page.screenshot({ path: join(out, `${id}.png`) });
    results.push({ id, title, checks });
    for (const c of checks) console.log(`${c.ok ? 'ok    ' : 'FAIL  '} ${id}: ${c.what}`);
    await context.close();
  }
} finally {
  await browser.close();
  await srv.close();
  writeFileSync(join(out, 'states.json'), `${JSON.stringify(results, null, 1)}\n`);
}
process.exit(failed ? 1 : 0);
