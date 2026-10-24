#!/usr/bin/env node
// Render a Wylls video scene to MP4, frame by frame.
//
//   node render.mjs scenes/01-trailer-ja                 # full render -> out/01-trailer-ja.mp4
//   node render.mjs scenes/01-trailer-ja --stills 0,2.5,7 # PNG stills -> out/stills/01-trailer-ja/t2.50.png
//   node render.mjs scenes/01-trailer-ja --sheet 12       # contact sheet of 12 evenly spaced frames
//   node render.mjs scenes/01-trailer-ja --draft          # quarter-cost preview: half size, 15 fps
//   options: --fps N  --from S --to S  --crf N  --no-audio  --slots N (concurrent full renders, default 3)
//
// The scene page runs with ?render=1: its clock is virtual and advanced by
// WY.seek(t) before each screenshot, so output never depends on machine speed.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..'); // repository root (scenes reach the game's art through it)
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); if (i < 0) return d; const v = args[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };
const sceneArg = args.find(a => !a.startsWith('--') && !/^[\d.,]+$/.test(a));
if (!sceneArg) { console.error('usage: node render.mjs scenes/<name> [--stills t,t] [--sheet n] [--draft]'); process.exit(2); }
const sceneDir = path.resolve(HERE, sceneArg);
const name = path.basename(sceneDir);
const OUT = path.resolve(HERE, flag('out-dir', 'out'));
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ static server over the repository
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.mp4': 'video/mp4', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'max-age=3600' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/${path.relative(ROOT, sceneDir)}/index.html?render=1`;

// ------------------------------------------------------------------ concurrency slots (machine has few cores)
const SLOT_DIR = '/tmp/claude-0/render-slots';
async function takeSlot(n) {
  fs.mkdirSync(SLOT_DIR, { recursive: true });
  for (;;) {
    for (let i = 0; i < n; i++) {
      const d = path.join(SLOT_DIR, 'slot' + i);
      try { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'pid'), String(process.pid)); return d; } catch {
        try { const pid = +fs.readFileSync(path.join(d, 'pid'), 'utf8'); process.kill(pid, 0); } catch { fs.rmSync(d, { recursive: true, force: true }); }
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

const draft = !!flag('draft', false);
const stills = flag('stills', null);
const sheet = flag('sheet', null);
const full = !stills && !sheet;
let slot = null;
if (full) { slot = await takeSlot(+flag('slots', 3)); process.on('exit', () => fs.rmSync(slot, { recursive: true, force: true })); }

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx0 = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
let page = await ctx0.newPage();
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error(`[page ${m.type()}]`, m.text()); });
page.on('pageerror', e => { console.error('[page error]', e.message); });
await page.goto(url, { waitUntil: 'load' });
const meta = await page.evaluate(() => WY.ready());
// resize the viewport to the scene's frame
await page.setViewportSize({ width: meta.width, height: meta.height });
await page.evaluate(() => WY.seek(0));
const fps = +flag('fps', draft ? 15 : meta.fps);
const scale = draft ? 0.5 : 1;
const cdp = await page.context().newCDPSession(page);
async function shot(t, fmt = 'png') {
  await page.evaluate(tt => WY.seek(tt), t);
  const r = await cdp.send('Page.captureScreenshot', { format: fmt, quality: fmt === 'jpeg' ? 95 : undefined, optimizeForSpeed: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: meta.width, height: meta.height, scale } });
  return Buffer.from(r.data, 'base64');
}

const t0 = Date.now();
if (stills || sheet) {
  const dir = path.join(OUT, 'stills', name); fs.mkdirSync(dir, { recursive: true });
  const times = stills ? String(stills).split(',').map(Number) : [...Array(+sheet)].map((_, i) => (meta.duration * (i + 0.5)) / +sheet);
  const files = [];
  for (const t of times) { const f = path.join(dir, `t${t.toFixed(2)}.png`); fs.writeFileSync(f, await shot(t)); files.push(f); console.log(f); }
  if (sheet) {
    const cols = Math.ceil(Math.sqrt(files.length)); const rows = Math.ceil(files.length / cols);
    const w = meta.width > meta.height ? 640 : 360;
    const sheetFile = path.join(OUT, 'stills', `${name}-sheet.jpg`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', ...files.flatMap(f => ['-i', f]), '-filter_complex', files.map((_, i) => `[${i}:v]scale=${w}:-2,drawtext=text='${times[i].toFixed(1)}s':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6[v${i}]`).join(';') + ';' + files.map((_, i) => `[v${i}]`).join('') + `xstack=inputs=${files.length}:layout=${layout(files.length, cols, w, meta)}:fill=black`, '-q:v', '3', sheetFile]);
    console.log(sheetFile);
  }
} else {
  const from = +flag('from', 0), to = +flag('to', meta.duration);
  const nFrames = Math.round((to - from) * fps);
  const tmpVideo = path.join(OUT, `.${name}.video.mp4`);
  const crf = flag('crf', draft ? 26 : 14);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'slow', '-crf', String(crf), '-tune', 'animation', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', tmpVideo], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error('ffmpeg ' + c)))));
  let lastLog = 0;
  for (let i = 0; i < nFrames; i++) {
    const buf = await shot(from + i / fps, 'png');
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (Date.now() - lastLog > 15000) { lastLog = Date.now(); console.log(`${name}: frame ${i + 1}/${nFrames} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
  }
  ff.stdin.end(); await ffDone;
  const final = path.join(OUT, `${name}${draft ? '.draft' : ''}.mp4`);
  let wavFile = null;
  if (meta.hasAudio && !flag('no-audio', false)) {
    const b64 = await page.evaluate(() => WY.renderAudio());
    if (b64) { wavFile = path.join(OUT, `.${name}.wav`); fs.writeFileSync(wavFile, Buffer.from(b64, 'base64')); }
  }
  if (wavFile) {
    const aFrom = from > 0 ? ['-ss', String(from), '-t', String(to - from)] : ['-t', String(to - from)];
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpVideo, ...aFrom, '-i', wavFile, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', 'loudnorm=I=-15:TP=-1.2:LRA=11,aresample=48000', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', final]);
    fs.rmSync(wavFile);
  } else fs.renameSync(tmpVideo, final);
  fs.rmSync(tmpVideo, { force: true });
  console.log(`done ${final} (${nFrames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
await browser.close();
server.close();
if (slot) fs.rmSync(slot, { recursive: true, force: true });

function run(cmd, a) { return new Promise((res, rej) => { const p = spawn(cmd, a, { stdio: 'inherit' }); p.on('close', c => (c === 0 ? res() : rej(new Error(cmd + ' exited ' + c)))); }); }
function layout(n, cols, w, m) { const h = Math.round((w * m.height) / m.width / 2) * 2; return [...Array(n)].map((_, i) => `${(i % cols) * w}_${Math.floor(i / cols) * h}`).join('|'); }
