// (page-not-open-yet) In a real browser on the keyless screens fixture (no chain, no key, no wallet; the dev wallet is
// off): what the game page shows while the herald says the world is not created yet, JA and EN, and what it shows after.
// The fixture's herald has a world, so the test answers /h/season in its place (page.route), exactly as a herald does
// before the world is created: 503 {"ok":false,"code":"NoSeasonYet"}. It then lets the fixture answer.
//   1 not open yet, no file: the calm banner and the plate say "not open yet … soon"; no red line, no "check your
//     connection", no status code, no "season"
//   2 the operator's file beside the page ({v:1, opensAt}): the time is named, in the reader's zone (Asia/Tokyo here)
//   3 a real failure after that (the connection refused) is still the red line "could not connect", and the calm
//     banner is gone; "not open" again takes the red line away
//   4 the world is there: the page opens it by itself (no reload) — the banner goes, the turn dial runs
// Nothing here is evidence of a chain or of a real herald: the real herald's answer was checked by hand on localnet
// (the run's report). Run from this folder: WORLD_NOT_OPEN_PORT=<free port> node --test world-not-open.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';

const OUT = process.env.WORLD_NOT_OPEN_OUT ?? path.join(tmpdir(), 'wylls-world-not-open');
mkdirSync(OUT, { recursive: true });
const OPENS = 4_070_000_000;   // (2098-12-21 11:33:20 UTC = 20:33 in Tokyo: "not yet" whenever this runs)
let srv, browser;
before(async () => { srv = await startServer({ keyless: true, port: Number(process.env.WORLD_NOT_OPEN_PORT ?? 0) }); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

const W = {
  ja: { banner: '世界はまだ開いていません。まもなく開きます。開いたら、このページに自動で表示されます。', title: '世界はまだ開いていません', soon: 'まもなく開きます。', when: /^世界はまだ開いていません。12月21日 20:33 JST 以降に開きます。開いたら、このページに自動で表示されます。$/, net: '通信できませんでした' },
  en: { banner: 'The world is not open yet. It opens soon. This page shows it automatically once it opens.', title: 'The world is not open yet', soon: 'It opens soon.', when: /^The world is not open yet\. It opens on or after Dec 21, 8:33 PM GMT\+9\. This page shows it automatically once it opens\.$/, net: null },
};
const NEVER = /season|シーズン|HTTP|503|connection|通信の状態|読めません|cannot be read/i;

const shown = page => page.evaluate(() => {
  const vis = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const e = document.getElementById('error-line'), s = document.getElementById('stale-banner'), p = document.querySelector('.plate');
  return { error: vis(e) ? e.textContent : null, banner: vis(s) ? s.textContent : null, notOpen: s?.dataset?.notOpen ?? null,
    plate: p ? (p.innerText ?? '').replace(/\s+/g, ' ').trim() : null, plateClass: p?.className ?? '', keys: p ? p.querySelectorAll('button').length : 0,
    body: (document.body.innerText ?? ''), dial: (document.getElementById('bell-chip')?.innerText ?? '').replace(/\s+/g, ' ').trim() };
});
/** The season poll asks again at once when the page is shown again (app.mjs seasonLoop): no 30 s wait in a test. */
const pollNow = page => page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
const until = async (page, f, what) => {
  let last = null;
  for (let i = 0; i < 100; i++) { last = await shown(page); if (f(last)) return last; await page.waitForTimeout(200); }
  assert.fail(`${what}: ${JSON.stringify({ ...last, body: undefined })}`);
};

for (const lang of ['en', 'ja']) {
  test(`${lang}: not open yet → the time → a real failure → the world opens by itself`, async () => {
    const w = W[lang];
    const ctx = await browser.newContext({ locale: lang === 'en' ? 'en-US' : 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(l => { try { localStorage.setItem('ps-lang', l); localStorage.setItem('ps-fintro:v1', '1'); } catch { /* none */ } }, lang);
    const page = await ctx.newPage();
    let mode = 'notopen', file = null, asked = 0;
    await page.route('**/h/season', route => {
      asked++;
      if (mode === 'notopen') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"NoSeasonYet","ok":false}' });
      if (mode === 'refused') return route.abort('connectionrefused');
      return route.continue();
    });
    await page.route('**/frontier/world-open.json', route => (file ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(file) }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"NotFound","ok":false}' })));
    const url = `${srv.url}/frontier/?devWallet=off`;

    // 1 not open yet, no file
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    let s = await until(page, x => x.banner === w.banner, '1 the calm banner');
    assert.equal(s.error, null, 'no red line'); assert.equal(s.notOpen, '1');
    assert.ok(s.plate.includes(w.title) && s.plate.includes(w.soon), s.plate);
    assert.match(s.plateClass, /plate-notopen/); assert.equal(s.keys, 0, 'the plate has no key');
    assert.doesNotMatch(s.body, NEVER);
    await page.screenshot({ path: path.join(OUT, `1-not-open-${lang}.png`) });

    // 2 the operator's file: a page opened then names the time
    file = { v: 1, opensAt: OPENS };
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    s = await until(page, x => !!x.banner && w.when.test(x.banner), '2 the time');
    assert.equal(s.error, null); assert.ok(!s.plate.includes(w.soon), s.plate); assert.doesNotMatch(s.body, NEVER);
    await page.screenshot({ path: path.join(OUT, `2-time-${lang}.png`) });

    // 3 a real failure is still the red line; "not open" again takes it away
    mode = 'refused'; await pollNow(page);
    s = await until(page, x => !!x.error, '3 the red line');
    if (w.net) assert.equal(s.error, w.net); else assert.match(s.error, /connect|reach/i);
    assert.equal(s.banner, null, 'the calm banner is gone'); assert.ok(!s.plate.includes(w.title), s.plate);
    await page.screenshot({ path: path.join(OUT, `3-refused-${lang}.png`) });
    mode = 'notopen'; await pollNow(page);
    s = await until(page, x => !x.error && !!x.banner && w.when.test(x.banner), '3 not open again');

    // 4 the world is there: opened by itself
    const before = asked;
    mode = 'world'; await pollNow(page);
    s = await until(page, x => x.banner === null && !x.plate?.includes(w.title) && /\d/.test(x.dial), '4 the world opens');
    assert.equal(s.error, null); assert.ok(asked > before);
    assert.ok(!s.body.includes(w.title), 'nothing says "not open" any more');
    await page.screenshot({ path: path.join(OUT, `4-open-${lang}.png`) });
    await ctx.close();
  });
}
