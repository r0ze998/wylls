// Repaint the nations' old dye in the baked sprites as the new one (the six leaders' clothes, frontier/palette.mjs).
// Run once on 2026-10-09 over art/units, art/specials, art/holdings and art/factions (582 files). Pixels near a
// nation's OLD hue, and saturated enough to be dyed cloth or paint, move to the new hue, saturation and lightness;
// everything else in the picture (skin, wood, leather, steel, the grass base, shadows) is left as it was. Each file
// is decoded, repainted in Chromium (through Playwright) and encoded again with cwebp at the settings of the art's
// own exports, so the files stay the size they were.
//
//   node recolour_nations.mjs <art dir (…/web/frontier/art)> <out dir>      then copy <out dir> over the art dir
//
// It must NOT be run a second time over its own output: the rules below start from the old colours. A sprite that is
// rendered afresh takes the new colours from its own pipeline (docs/frontier/art/units/_src/units3d.py FILL).
// Run it from a folder whose node_modules has playwright-core (permutation-gateway/screens); cwebp must be on PATH.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, basename } from 'node:path';
import { chromium } from 'playwright-core';

/** The sprite names of the six nations in faction order (map/sprites.mjs ART_FACTIONS). */
const ART_FACTIONS = ['ember', 'tide', 'lumen', 'iron', 'stone', 'verdant'];
export const RECOLOUR = [
  // from: the old dye (hue degrees, half band, soft edge, least saturation); to: hue, saturation gain, lightness curve [a, b, gamma]: l' = a + b * l^gamma
  { from: [3, 14, 8, 0.28], to: { hue: 356, sat: 1.28, l: [0, 0.96, 1.04] } },          // Aster: red, a little deeper
  { from: [173, 16, 8, 0.2], to: { hue: 190, sat: 1.45, l: [0.02, 1.3, 0.9] } },       // Borealis: teal -> sky cyan
  { from: [40, 8, 5, 0.5], to: { hue: 49, sat: 1.35, l: [0.0, 1.1, 0.95] } },          // Cinder: ochre -> yellow
  { from: [260, 18, 8, 0.16], to: { hue: 277, sat: 1.9, l: [0.0, 1.08, 1.0] } },       // Dunmar: purple, brighter
  { from: [214, 18, 8, 0.2], to: { hue: 80, sat: 0.1, l: [0.3, 0.74, 0.7] } },         // Ember: blue -> white
  { from: [333, 16, 8, 0.2], to: { hue: 30, sat: 2.1, l: [0.02, 1.1, 0.96] } },        // Fjordal: magenta -> orange
];
const [art, out] = process.argv.slice(2);
if (art && out) {
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const jobs = [];
  for (const set of ['units', 'specials', 'holdings', 'factions']) for (const file of walk(join(art, set))) {
    if (!file.endsWith('.webp')) continue;
    const name = basename(file, '.webp');
    let f = null;
    if (set === 'units') { const m = /^units_(\d)$/.exec(name) ?? /^(\d)_[a-z]+$/.exec(name); if (m) f = Number(m[1]); }
    else { const m = /(?:^|_)(ember|tide|lumen|iron|stone|verdant)(?:_|$)/.exec(name); if (m) f = ART_FACTIONS.indexOf(m[1]); }
    if (f === null) continue;
    const cwebp = /units\/@1x/.test(file) ? ['-q', '76', '-alpha_q', '75', '-alpha_filter', 'best', '-m', '6']
      : /units\/@2x/.test(file) ? ['-q', '74', '-alpha_q', '70', '-alpha_filter', 'best', '-m', '6']
      : /units\/cards/.test(file) ? ['-q', '82', '-alpha_q', '80', '-m', '6']
      : /holdings/.test(file) ? ['-q', '90', '-alpha_q', '92', '-alpha_filter', 'best', '-m', '6']
      : /specials/.test(file) ? ['-q', '90', '-alpha_q', '95', '-alpha_filter', 'best', '-m', '6']
      : ['-q', '82', '-alpha_q', '84', '-alpha_filter', 'best', '-m', '6'];
    jobs.push({ src: file, out: join(out, relative(art, file)), f, cwebp });
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const job of jobs) {
    const data = `data:image/webp;base64,${readFileSync(job.src).toString('base64')}`;
    const b64 = await page.evaluate(async ({ data, rule, q }) => {
      const im = new Image(); im.src = data; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
      const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
      const [h0, band, soft, smin] = rule.from, T = rule.to;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), l = (mx + mn) / 2, dl = mx - mn;
        if (dl < 0.02) continue;
        const s = dl / (1 - Math.abs(2 * l - 1) || 1);
        let h = mx === r ? ((gg - b) / dl) % 6 : mx === gg ? (b - r) / dl + 2 : (r - gg) / dl + 4; h = (h * 60 + 360) % 360;
        let dh = h - h0; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
        const wh = Math.max(0, Math.min(1, (band + soft - Math.abs(dh)) / soft)), ws = Math.max(0, Math.min(1, (s - smin * 0.6) / (smin * 0.4)));
        const w = wh * ws;
        if (w <= 0) continue;
        const nh = (T.hue + dh * 0.5 + 360) % 360, ns = Math.max(0, Math.min(1, s * T.sat)), nl = Math.max(0, Math.min(1, T.l[0] + T.l[1] * Math.pow(l, T.l[2])));
        const cc = (1 - Math.abs(2 * nl - 1)) * ns, x = cc * (1 - Math.abs(((nh / 60) % 2) - 1)), m = nl - cc / 2;
        const [r1, g1, b1] = nh < 60 ? [cc, x, 0] : nh < 120 ? [x, cc, 0] : nh < 180 ? [0, cc, x] : nh < 240 ? [0, x, cc] : nh < 300 ? [x, 0, cc] : [cc, 0, x];
        d[i] = Math.round((r * (1 - w) + (r1 + m) * w) * 255); d[i + 1] = Math.round((gg * (1 - w) + (g1 + m) * w) * 255); d[i + 2] = Math.round((b * (1 - w) + (b1 + m) * w) * 255);
      }
      g.putImageData(id, 0, 0);
      const blob = await new Promise(res => c.toBlob(res, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer()); let s2 = ''; for (let i = 0; i < buf.length; i += 0x8000) s2 += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s2);
    }, { data, rule: RECOLOUR[job.f], q: job.q ?? 0.9 });
    mkdirSync(dirname(job.out), { recursive: true });
    const png = job.out.replace(/\.webp$/, '.png');
    writeFileSync(png, Buffer.from(b64, 'base64'));
    // the same encoder and settings as the art's own exports (cwebp, lossy colour and lossy alpha)
    execFileSync('cwebp', ['-quiet', ...job.cwebp, png, '-o', job.out]);
    rmSync(png);
    console.log(job.out.split('/').slice(-3).join('/'), readFileSync(job.src).length, '->', readFileSync(job.out).length);
  }
  await browser.close();
}
