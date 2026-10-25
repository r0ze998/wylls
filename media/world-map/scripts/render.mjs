// Render the world map's layers to PNG files with the pre-installed Chromium:
//   node media/world-map/scripts/render.mjs --data season-94.json --scale 1.25 --lang ja --out media/world-map/out/v1
// Writes <out>/<layer>.png for every layer, <out>/composite-*.png, and <out>/info.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const data = arg('data', 'season-94.json'), scale = arg('scale', '1.25'), lang = arg('lang', 'ja'), out = arg('out', 'media/world-map/out/latest'), port = Number(arg('port', '41781'));
const extra = arg('extra', '2'), layers = arg('layers', 'base,land,life,realms,grid,routes,labels,names'), region = arg('region', '');
mkdirSync(out, { recursive: true });
const server = await serve(port);
const browser = await chromium.launch({ args: ['--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('page:', m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('pageerror:', e.message));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/media/world-map/render/index.html?data=${data}&demo=${arg('demo', '')}&scale=${scale}&lang=${lang}&extra=${extra}&layers=${layers}${region ? `&region=${region}` : ''}`);
await page.waitForFunction(() => document.title === 'ready', null, { timeout: 30 * 60_000 });
const info = await page.evaluate(() => window.WORLD.info);
console.log(`painted ${info.width}×${info.height} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const name of layers.split(',')) {
  // in pieces: a data URL of a large canvas is held as one string
  const b64 = await page.evaluate(n => new Promise(r => window.WORLD.layers[n].toBlob(b => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(b); }, 'image/png')), name);
  writeFileSync(join(out, `${name}.png`), Buffer.from(b64, 'base64'));
  console.log(`${name}.png`);
}
writeFileSync(join(out, 'info.json'), JSON.stringify({ ...info, lang, rendered: new Date().toISOString() }, null, 2));
await browser.close(); server.close();
