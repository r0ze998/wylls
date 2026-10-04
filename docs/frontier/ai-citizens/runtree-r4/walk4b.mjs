// Second segment (smoke-r4): the map zoomed in with the Japanese switch kept on (do the canvas labels turn Japanese?), then the council page
// after a later council period closed. Reads only; non-GET requests are recorded and fail the script.
//   node walk4b.mjs OUTDIR RUN_DIR [BASE]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const [OUT, RUN, BASEARG] = process.argv.slice(2);
const BASE = BASEARG ?? 'http://127.0.0.1:41902';
const require = createRequire('/Users/r0ze/.npm/_npx/e41f203b7505f1fb/node_modules/');
const { chromium } = require('playwright');
fs.mkdirSync(OUT, { recursive: true });
const ais = fs.readdirSync(`${RUN}/pub/cards`).filter(f => /^[0-9a-f]{16}\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(`${RUN}/pub/cards/${f}`, 'utf8'))).sort((a, b) => a.index - b.index);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: OUT + '/webm2', size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
const nonGet = [], errs = [];
page.on('request', r => { if (r.method() !== 'GET') nonGet.push(`${r.method()} ${r.url()}`); });
page.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
const w = ms => page.waitForTimeout(ms);
const shot = async name => { await page.screenshot({ path: `${OUT}/runtree-r4b-${name}.png` }); };
const info = { notes: {} };
const bellText = async () => (await page.locator('body').innerText()).match(/(?:Bell|bell|鐘) (\d+)/)?.[1] ?? null;
const zoom = async (sign, n, gap = 1100) => { for (let i = 0; i < n; i++) { await page.locator(`button:has-text("${sign}")`).first().click().catch(() => {}); await w(gap); } };
await page.goto(`${BASE}/frontier/frontier/spectate.html?art=1`, { waitUntil: 'load' }); await w(3000);
await page.locator('#intro button').first().click().catch(() => {}); await w(2000);
await page.getByRole('button', { name: /Military/ }).first().click().catch(() => {}); await w(2000);
info.notes.map_bell = await bellText();
const ai = ais.find(a => a.index === 1000) ?? ais[0];
await page.locator('#map-search-q').fill(ai.name.en.split(' ')[0]); await w(1500);
const res = page.locator('#map-search-results button, .search-results button, [role=listbox] [role=option], #map-search-results li');
if (await res.count()) await res.first().click();
await w(3000);
await zoom('+', 3); await w(4000);
await shot('en-zoomed'); await w(2000);
await page.getByRole('button', { name: '日本語' }).first().click().catch(() => {}); await w(5000);
await shot('ja-zoomed'); await w(6000);
await page.getByRole('button', { name: /軍事/ }).first().click().catch(() => {}); await w(4000);
await shot('ja-zoomed-military'); await w(4000);
await page.getByRole('button', { name: 'EN' }).first().click().catch(() => {}); await w(2000);
await page.goto(`${BASE}/council.html`, { waitUntil: 'load' }); await w(4500);
info.notes.council_bell = await bellText();
await page.locator('#council').evaluate(e => e.scrollIntoView({ block: 'start' })); await w(2500);
const tabs = page.locator('#council-body .tab');
const nt = await tabs.count();
for (let i = 0; i < nt; i++) {
  await tabs.nth(i).click().catch(() => {}); await w(2500);
  const t = await page.locator('#council-body').innerText();
  info.notes[`council_tab_${i}`] = (t.match(/Closed period \d+|Open period \d+/) ?? [''])[0] + ' | ' + (t.match(/Strike Order adopted[^\n]*|No Strike Order adopted[^\n]*|No council this period/) ?? ['?'])[0];
  info.notes[`council_split_${i}`] = (t.match(/Ballots by who cast them[^\n]*/) ?? [''])[0];
  if (i === 0) { await shot('council'); await page.mouse.move(640, 500); await page.mouse.wheel(0, 300); await w(2500); await shot('council-ballots'); await page.mouse.wheel(0, -300); await w(800); }
}
await tabs.nth(0).click().catch(() => {}); await w(3500);
await ctx.close(); await browser.close();
fs.writeFileSync(`${OUT}/walk4b-report.json`, JSON.stringify({ ...info, nonGet, errs, at: new Date().toISOString() }, null, 1));
console.log(JSON.stringify({ ...info, nonGet, errs }, null, 1));
if (nonGet.length) process.exit(1);
