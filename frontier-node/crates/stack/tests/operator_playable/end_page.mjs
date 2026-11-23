// PEND (devnet-end-season): what a player's page shows of the season's end. Opens the devnet page the herald serves
// (`--web`), with no wallet, waits until the season is read, and prints one JSON line: the season status words, the
// turn chip, the error banner and a screenshot. TEST only; loopback only.
//
//   node end_page.mjs --herald PORT --out DIR --tag NAME
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../../../permutation-gateway/screens/package.json'));
const { chromium } = require('playwright-core');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg('herald'));
const out = arg('out');
const tag = arg('tag') ?? 'end';
if (!Number.isInteger(port) || port < 41000 || port > 41999) throw new Error('--herald PORT (loopback 41000-41999)');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: process.env.LOCALE ?? 'ja-JP' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/frontier/frontier/`, { waitUntil: 'domcontentloaded' });
const read = () => page.evaluate(() => {
  const t = id => document.getElementById(id)?.textContent?.trim() ?? null;
  const banner = document.getElementById('error-line');
  const chip = document.getElementById('bell-chip');
  const stale = document.getElementById('stale-banner');
  return {
    seasonStatus: t('season-status'),
    errorLine: banner && !banner.hidden ? banner.textContent.trim() : null,
    chip: chip?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    staleBanner: stale && !stale.hidden ? stale.textContent.trim() : null,
    endedWords: [...document.querySelectorAll('body *')].map(e => e.childElementCount === 0 ? e.textContent.trim() : '')
      .filter(x => /受付終了|終了|閉鎖|終えました/.test(x)).slice(0, 8),
  };
});
let seen = null;
const t0 = Date.now();
while (Date.now() - t0 < 90_000) {
  seen = await read();
  if (seen.seasonStatus && !['—', '読み込み中…', ''].includes(seen.seasonStatus)) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(3000);
seen = await read();
const shot = path.join(out, `${tag}.png`);
await page.screenshot({ path: shot });
console.log(JSON.stringify({ tag, ...seen, pageErrors: errors.slice(0, 5), screenshot: shot }));
await browser.close();
