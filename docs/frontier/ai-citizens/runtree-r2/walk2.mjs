// Walkthrough video of the AI stack's screens (smoke-r2): the latest client on the loopback herald.
//   node walk2.mjs OUTDIR [BASE] [PLAYWRIGHT_NODE_MODULES]      -> OUTDIR/*.webm (Playwright recordVideo), no audio
// Reads only; the local dev wallet is connected for the nation step and nothing is signed or sent.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const [OUT, BASEARG, PW] = process.argv.slice(2);
const BASE = BASEARG ?? 'http://127.0.0.1:41902';
const require = createRequire((PW ?? '/Users/r0ze/.npm/_npx/e41f203b7505f1fb/node_modules') + '/');
const { chromium } = require('playwright');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
const nonGet = [];
page.on('request', r => { if (r.method() !== 'GET') nonGet.push(`${r.method()} ${r.url()}`); });
const w = ms => page.waitForTimeout(ms);
const search = async q => {
  await page.locator('#map-search-q').fill(q); await w(1500);
  const res = page.locator('#map-search-results button, .search-results button, [role=listbox] [role=option], #map-search-results li');
  if (await res.count()) await res.first().click();
  await w(3000);
  await page.waitForFunction(() => !/Loading the province|州の詳細を読み込/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  await w(1500);
};
await page.goto(`${BASE}/frontier/frontier/spectate.html?art=1`, { waitUntil: 'load' }); await w(3000);
await page.locator('#intro button').first().click().catch(() => {}); await w(2500);
await page.getByRole('button', { name: /Military/ }).first().click().catch(() => {}); await w(2000);
for (const name of ['Semeto', 'Marao']) {
  await search(name);
  for (let i = 0; i < 3; i++) { await page.locator('button:has-text("+")').first().click().catch(() => {}); await w(1200); }
  await w(4500);
  for (let i = 0; i < 3; i++) { await page.locator('button:has-text("−")').first().click().catch(() => {}); await w(700); }
}
for (let i = 0; i < 3; i++) { await page.locator('button:has-text("−")').first().click().catch(() => {}); await w(900); }
await page.getByRole('button', { name: 'Realms' }).first().click().catch(() => {}); await w(3000);
await page.getByRole('button', { name: '日本語' }).first().click().catch(() => {}); await w(4500);
await page.getByRole('button', { name: 'EN' }).first().click().catch(() => {}); await w(2500);
// the Join tab and the nation step (local dev wallet; nothing is signed)
await page.getByText('Join', { exact: true }).first().click().catch(() => {}); await w(3000);
const dev = page.getByRole('button', { name: /Dev Wallet/ }).first();
if (await dev.count()) { await dev.click(); await w(3500); await page.mouse.move(1100, 500); for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 400); await w(1300); } }
// the council page
await page.goto(`${BASE}/council.html`, { waitUntil: 'load' }); await w(4500);
const cards = page.locator('li button, .citizens button');
for (let i = 1; i < Math.min(await cards.count(), 3); i++) { await cards.nth(i).click().catch(() => {}); await w(2200); }
await page.mouse.move(640, 500);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 380); await w(1600); }
await page.mouse.move(1030, 500);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 380); await w(1400); }
await w(1500);
await ctx.close(); await browser.close();
console.log(JSON.stringify({ files: fs.readdirSync(OUT), nonGet }));
if (nonGet.length) process.exit(1);
