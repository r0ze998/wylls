// Screenshot helper for the UI check: opens the game in the system Chrome
// with a persistent profile (so the same test wallet and village are used
// on every run), performs a few steps, and saves one PNG.
//
//   node shot.mjs <out.png> '<steps json>'
//
// Steps: {"button": "名前"} clicks a button by its accessible name,
// {"text": "文字"} clicks the first element showing that text,
// {"xy": [x, y]} clicks a point, {"wait": ms}, {"key": "Escape"}.
// Uses playwright-core from another worktree of this repository (no install).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PW = path.resolve(import.meta.dirname, '../../agent-wallet/permutation-gateway/screens/node_modules/playwright-core');
const { chromium } = require(PW);

const out = process.argv[2];
const steps = JSON.parse(process.argv[3] || '[]');
const url = process.env.URL || 'http://ui.localhost:41940/frontier/frontier/';
const profile = process.env.PROFILE;
if (!out || !profile) throw new Error('usage: PROFILE=<dir> node shot.mjs <out.png> [steps]');

mkdirSync(path.dirname(out), { recursive: true });
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  locale: 'ja-JP',
});
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(process.env.SETTLE || 6000));
for (const s of steps) {
  if (s.button) await page.getByRole('button', { name: s.button }).first().click({ timeout: 8000 });
  else if (s.text) await page.getByText(s.text).first().click({ timeout: 8000 });
  else if (s.xy) await page.mouse.click(s.xy[0], s.xy[1]);
  else if (s.key) await page.keyboard.press(s.key);
  if (s.wait) await page.waitForTimeout(s.wait);
  else await page.waitForTimeout(1200);
}
await page.screenshot({ path: out });
console.log(JSON.stringify({ out, errors }));
await ctx.close();
