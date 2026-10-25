// Post images from the world map: the same world, data and demo as the master, each post a region
// of it painted at the density its size needs (no picture is enlarged: a close-up is painted at up to
// 2 canvas px per world px, the largest the game's sprites are made for), with and without words.
//
//   node media/world-map/scripts/posts.mjs --data season-92.json --demo demo-1.json --lang ja --out media/world-map/out/posts
//
// The posts are listed in media/world-map/posts.json: an aspect (16:9, 4:5, 1:1), the size of the
// image, what it is centred on (an anchor the render page reports, or x/y in world px) and how much
// of the world it spans (world px across). Words: `labels` (nations, the Concord) and/or `names`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const data = arg('data', 'season-92.json'), demo = arg('demo', 'demo-1.json'), lang = arg('lang', 'ja'), out = arg('out', 'media/world-map/out/posts'), port = Number(arg('port', '41783'));
const only = arg('only', null)?.split(',');
const spec = JSON.parse(readFileSync(join(here, '..', 'posts.json'), 'utf8'));
mkdirSync(out, { recursive: true });
const server = await serve(port);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', e => console.log('pageerror:', e.message));
const base = `http://127.0.0.1:${port}/media/world-map/render/index.html?data=${data}&demo=${demo}&lang=${lang}`;
const render = async (query) => {
  await page.goto(`${base}&${query}`);
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 20 * 60_000 });
  return page.evaluate(() => window.WORLD.info);
};
// the anchors, from a small whole-world paint
const world = await render('scale=0.05&layers=grid');
const A = world.anchors;
const anchor = (name) => {
  if (typeof name === 'object') return name;
  const [kind, i] = String(name).split(':');
  if (kind === 'concord') return A.concord;
  if (kind === 'front') return A.fronts[Number(i)];
  if (kind === 'camp') return A.camps[Number(i)];
  if (kind === 'town') return A.nations[Number(i)].town;
  if (kind === 'nation') return A.nations[Number(i)].centre;
  if (kind === 'world') return { x: world.box.x + world.box.w / 2, y: world.box.y + world.box.h / 2 };
  throw new Error(`unknown anchor ${name}`);
};
const blob = (name) => page.evaluate(n => new Promise(r => window.WORLD.layers[n].toBlob(b => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(b); }, 'image/png')), name);
const made = [];
for (const p of spec.posts) {
  if (only && !only.includes(p.name)) continue;
  const [aw, ah] = p.aspect.split(':').map(Number), W = p.width, H = Math.round(W * ah / aw);
  const c = anchor(p.at), span = p.span, scale = W / span, h = H / scale;
  if (scale > 2.0001) throw new Error(`${p.name}: ${scale.toFixed(2)} px per world px enlarges the sprites; widen its span to ${W / 2}`);
  const region = [c.x - span / 2 + (p.dx ?? 0), c.y - h / 2 + (p.dy ?? 0), span, h].map(v => v.toFixed(1)).join(',');
  const layers = ['base', ...(p.words ?? [])];
  const info = await render(`scale=${scale}&region=${region}&layers=${layers.join(',')}&nameTier=${p.nameTier ?? 1}`);
  const files = {};
  for (const n of layers) { files[n] = join(out, `${p.name}.${n}.png`); writeFileSync(files[n], Buffer.from(await blob(n), 'base64')); }
  made.push({ ...p, size: [info.width, info.height], scale, region, files });
  console.log(`${p.name}: ${info.width}×${info.height} at ${scale.toFixed(2)} px/world px`);
}
writeFileSync(join(out, 'posts.json'), JSON.stringify({ data, demo, lang, posts: made }, null, 2));
await browser.close(); server.close();
