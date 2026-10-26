// How long one full picture of each direction takes to paint (after its images have arrived), median of 15.
//   node docs/design/uplift/preview/measure.mjs [--base http://127.0.0.1:41390]
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../permutation-gateway/screens/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:41390';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
for (const dir of ['A', 'B', 'C']) for (const frame of ['rest', 'select']) {
  await page.goto(`${base}/docs/design/uplift/preview/index.html?dir=${dir}&frame=${frame}`);
  await page.waitForTimeout(2500);
  const ms = [];
  for (let i = 0; i < 15; i++) {
    ms.push(await page.evaluate(() => new Promise(r => { const f = document.querySelector('.pv-stage'); f._draw(); requestAnimationFrame(() => requestAnimationFrame(() => r(Number(f.dataset.ms)))); })));
  }
  ms.sort((a, b) => a - b);
  console.log(`${dir} ${frame}: median ${ms[7].toFixed(1)} ms, max ${ms[14].toFixed(1)} ms (2784×1656 device px, uncached)`);
}
await browser.close();
