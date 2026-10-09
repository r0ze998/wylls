// Assemble the leaders' stage sheets, stills, portraits and hexagon icons as WebP (lossy, with alpha).
// The encoder is Chromium's own (canvas.toBlob('image/webp')), driven through Playwright, so no image
// library is needed. Large reductions are stepped down by halves before the last resample.
//
//   node stage_sheets.mjs <frames dir> <previews dir> <hex icons dir> <out dir (…/frontier/art/leaders3d)>
//
//   <frames dir>    what stage_render.py wrote: <key>/<clip>/frame-000.png … (576 × 720, transparent)
//   <previews dir>  the latest models' preview renders: <key>-portrait.png (900 × 900, transparent)
//   <hex icons dir> the six hexagon icons: <key>.png (1254 × 1254, transparent)
//
// Run it from a folder whose node_modules has playwright-core (permutation-gateway/screens).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';

const [frames, previews, hex, out] = process.argv.slice(2);
const KEYS = ['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal'];
const CELL = { w: 288, h: 360 }, CLIPS = [['idle', 8], ['attack', 8]];
const jobs = [];
for (const k of KEYS) {
  jobs.push({ out: `${out}/portrait-v1/${k}.webp`, w: 320, h: 320, q: 0.84, parts: [{ src: `${previews}/${k}-portrait.png`, dx: 0, dy: 0, dw: 320, dh: 320 }] });
  jobs.push({ out: `${out}/hex-v1/${k}@256.webp`, w: 256, h: 256, q: 0.86, parts: [{ src: `${hex}/${k}.png`, dx: 0, dy: 0, dw: 256, dh: 256 }] });
  jobs.push({ out: `${out}/hex-v1/${k}@128.webp`, w: 128, h: 128, q: 0.88, parts: [{ src: `${hex}/${k}.png`, dx: 0, dy: 0, dw: 128, dh: 128 }] });
  jobs.push({ out: `${out}/stage-v1/${k}.webp`, w: CELL.w, h: CELL.h, q: 0.86, parts: [{ src: `${frames}/${k}/idle/frame-000.png`, dx: 0, dy: 0, dw: CELL.w, dh: CELL.h }] });
  for (const [clip, n] of CLIPS) jobs.push({ out: `${out}/stage-v1/${k}_${clip}.webp`, w: CELL.w * n, h: CELL.h, q: 0.8,
    parts: Array.from({ length: n }, (_, i) => ({ src: `${frames}/${k}/${clip}/frame-${String(i).padStart(3, '0')}.png`, dx: i * CELL.w, dy: 0, dw: CELL.w, dh: CELL.h })) });
}
const browser = await chromium.launch();
const page = await browser.newPage();
for (const job of jobs) {
  const data = Object.fromEntries([...new Set(job.parts.map(p => p.src))].map(f => [f, `data:image/png;base64,${readFileSync(f).toString('base64')}`]));
  const b64 = await page.evaluate(async ({ job, data }) => {
    const ims = {};
    for (const [k, d] of Object.entries(data)) { const im = new Image(); im.src = d; await im.decode(); ims[k] = im; }
    const c = document.createElement('canvas'); c.width = job.w; c.height = job.h;
    const g = c.getContext('2d');
    for (const p of job.parts) {
      const im = ims[p.src];
      let cur = document.createElement('canvas'); cur.width = im.width; cur.height = im.height; cur.getContext('2d').drawImage(im, 0, 0);
      while (cur.width / 2 >= p.dw && cur.height / 2 >= p.dh) {
        const n = document.createElement('canvas'); n.width = Math.round(cur.width / 2); n.height = Math.round(cur.height / 2);
        const ng = n.getContext('2d'); ng.imageSmoothingQuality = 'high'; ng.drawImage(cur, 0, 0, n.width, n.height); cur = n;
      }
      g.imageSmoothingQuality = 'high'; g.drawImage(cur, p.dx, p.dy, p.dw, p.dh);
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/webp', job.q));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { job, data });
  mkdirSync(dirname(job.out), { recursive: true });
  writeFileSync(job.out, Buffer.from(b64, 'base64'));
  console.log(job.out, `${job.w}x${job.h}`, Buffer.from(b64, 'base64').length);
}
await browser.close();
