// Pictures of the comparison page (for the document and for review): every direction in every frame.
//   node docs/design/uplift/preview/shoot.mjs --base http://127.0.0.1:41390 --out <dir> [--only A:rest,B:select] [--width 1440]
// Playwright is taken from permutation-gateway/screens (npm ci there; its Chromium is cached by `npm run browser`).
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../permutation-gateway/screens/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('base', 'http://127.0.0.1:41390');
const out = resolve(arg('out', '.local/shots/directions'));
const width = Number(arg('width', 1440));
const only = (arg('only', '') || '').split(',').filter(Boolean);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: Math.round(width * 0.62) }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
for (const dir of ['A', 'B', 'C', 'all']) for (const frame of ['rest', 'select', 'result']) {
  if (only.length && !only.includes(`${dir}:${frame}`)) continue;
  await page.goto(`${base}/docs/design/uplift/preview/index.html?dir=${dir}&frame=${frame}`);
  await page.waitForTimeout(2500);
  const el = dir === 'all' ? page.locator('#stages') : page.locator('.pv-board').first();
  await el.screenshot({ path: join(out, `${dir}-${frame}.png`) });
  console.log(`${dir}-${frame}.png`);
}
console.log(errors.length ? `errors:\n${[...new Set(errors)].join('\n')}` : 'no errors');
await browser.close();
