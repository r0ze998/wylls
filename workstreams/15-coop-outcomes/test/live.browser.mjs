// Browser evidence for the production wiring (ruleset B): the game page, reached through ①'s board, shows the
// titles and chronicle the board's /coop/outcomes answers. Not a CI test (needs a herald, Playwright and Chromium).
//
//   frontier-herald --fixture conquest --data <dir> --listen 127.0.0.1:41260 --web permutation-server/web
//   PLAYWRIGHT=<dir with node_modules/playwright-core> node workstreams/15-coop-outcomes/test/live.browser.mjs <out dir>
//
// The board reads the herald's own /h/season and /h/events; for the board's evaluation only, the S1 caravan records of
// test/ps2.mjs sampleWorld() are appended after the herald's last record (FIXTURE: the conquest fixture season has no
// caravans). The page itself reads the herald unchanged. No chain, no wallet, no key (the board's signature check is
// replaced; nothing is submitted).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBoard, createServer } from '../../01-national-strategy/coop/board.mjs';
import { heraldRows, sampleWorld } from './ps2.mjs';

const HERALD = process.env.HERALD ?? 'http://127.0.0.1:41260';
const PORT = Number(process.env.PORT ?? 41261);
const OUT = path.resolve(process.argv[2] ?? 'evidence');
fs.mkdirSync(OUT, { recursive: true });
const req = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT ?? process.cwd()), 'x.js'));
const { chromium } = (() => { try { return req('playwright-core'); } catch { return req('playwright'); } })();

const get = async p => { const r = await fetch(new URL(p, HERALD)); return { status: r.status, json: r.ok ? await r.json() : null }; };
const season = (await get('/h/season')).json;
const own = [];
for (let after = '0'; ;) {
  const { json } = await get(`/h/events?after=${after}`);
  own.push(...json.events);
  after = json.next;
  if (!json.full) break;
}
const last = own.length ? Number(own[own.length - 1].seq) : 0;
const extra = heraldRows(sampleWorld(), last + 1);
const all = [...own, ...extra];
console.log(`herald: program ${season.programId} season ${season.season}; ${own.length} own records + ${extra.length} fixture S1 records`);
const fetchHerald = async p => {
  const m = /^\/h\/events\?after=(\d+)$/.exec(p);
  if (!m) return get(p);
  const page = all.filter(r => BigInt(r.seq) > BigInt(m[1])).slice(0, 200);
  return { status: 200, json: { v: 1, events: page, next: page.length ? String(page[page.length - 1].seq) : m[1], full: page.length === 200 } };
};
const board = createBoard({ herald: HERALD, programId: season.programId, seasonId: String(season.season), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws15-browser-')), fetchHerald, verify: async () => false });
const server = createServer(board, { herald: HERALD });
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;
const answer = await (await fetch(`${base}/coop/outcomes`)).json();
fs.writeFileSync(path.join(OUT, 'coop-outcomes.json'), JSON.stringify(answer, null, 2));
console.log(`/coop/outcomes: ruleset ${answer.ruleset?.id}, ${answer.entries?.length} titles, effects ${JSON.stringify(answer.effects)}`);

const browser = await chromium.launch();
const shots = [];
try {
  for (const [lang, w, h] of [['ja', 1280, 900], ['en', 1280, 900], ['ja', 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: lang === 'en' ? 'en-US' : 'ja-JP' });
    await ctx.addInitScript(l => { try { localStorage.setItem('ps-lang', l); } catch { /* none */ } }, lang);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${base}/frontier/frontier/`, { waitUntil: 'domcontentloaded' });
    // the card stands in the "More" drawer, under the chronicle (app.mjs): open it (behind the title screen, by the tab itself)
    await page.waitForSelector('[data-tab="more"]', { state: 'attached', timeout: 30_000 });
    await page.waitForTimeout(3000);
    // the title screen closes with Escape (intro/title.mjs); then the "More" tab
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelector('[data-tab="more"]')?.click());
    await page.waitForSelector('.coop-titles', { state: 'attached', timeout: 30_000 });
    await page.waitForTimeout(1500);
    const card = page.locator('.coop-titles');
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const file = path.join(OUT, `titles-${lang}-${w}.png`);
    await page.screenshot({ path: file });
    // (the drawer is drawn again on every poll, so the card is clipped from the page rather than waited on to be stable)
    const box = await card.boundingBox();
    if (box) await page.screenshot({ path: path.join(OUT, `titles-card-${lang}-${w}.png`), clip: { x: box.x, y: Math.max(0, box.y), width: box.width, height: Math.min(box.height, h - Math.max(0, box.y)) } });
    const text = await card.innerText();
    shots.push({ lang, width: w, file: path.basename(file), text, errors });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(OUT, 'browser.json'), JSON.stringify(shots, null, 2));
for (const s of shots) console.log(`${s.file}: ${s.text.split('\n').filter(Boolean).length} lines, page errors ${s.errors.length}`);
