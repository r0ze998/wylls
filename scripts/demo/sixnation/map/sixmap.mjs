// TEST-ONLY six-nation map timelapse, one command (owner feedback t358u: ONE map, little text):
//
//   node scripts/demo/sixnation/map/sixmap.mjs --out <new evidence dir> [--seed 2002] [--days 7] [--seconds 100]
//        [--fps 30] [--agents 1000] [--bots 0.99] [--every 2] [--sim <frontier-sim binary>] [--trace <trace.json>]
//
//   1. plays one season in frontier-sim (`timelapse`: the MC conquest rules, campaign policy, bot profile cq — the
//      same season as `mapmove --seed N` on those flags) and keeps its read-only map trace (trace.json);
//   2. draws the whole world on one 1920×1080 canvas in headless Chromium (render.mjs: the client's palette and
//      sigils), one picture per video frame, piped straight into ffmpeg (H.264, yuv420p) → map.mp4;
//   3. takes still frames across the video (frames/*.png) and writes manifest.json (seed, command lines, sha256 of the
//      simulator, the trace and the video, per-still statistics).
// No server, no port, no chain, no key, no network: the page is served from memory through Playwright's request routing.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs, simArgs, frameCount, bellAt, stillFrames, dayOf, ffmpegEncodeArgs, ffmpegStillArgs } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://sixmap.test';
const log = (...a) => console.log(`[sixmap ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const which = cmd => { try { return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8' }).trim() || null; } catch { return null; } };
const git = (root, ...a) => { try { return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };
const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css' };

function loadPlaywright(root) {
  for (const p of [path.join(root, 'permutation-gateway/screens/package.json'), path.join(HERE, 'package.json')]) {
    try { return createRequire(p)('playwright-core'); } catch { /* next */ }
  }
  throw new Error('playwright-core not found: npm install --prefix permutation-gateway/screens (Chromium: npx playwright-core install chromium)');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
    c.on('error', reject);
    c.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}`))));
  });
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`sixmap: ${e.message}`); return e.code === 'NonTestCluster' ? 3 : 64; }
  const root = path.resolve(o.root ?? path.join(HERE, '../../../..'));
  const sim = path.resolve(o.sim ?? path.join(root, 'frontier-sim/target/release/frontier-sim'));
  const n = frameCount(o);
  if (o.dryRun) {
    console.log(JSON.stringify({ sim, simArgs: simArgs(o, '<out>/trace.json'), frames: n, seconds: o.seconds, fps: o.fps, stills: stillFrames(o), encode: ffmpegEncodeArgs(o, '<out>/map.mp4') }, null, 2));
    return 0;
  }
  const ffmpeg = which('ffmpeg');
  if (!ffmpeg) { console.error('sixmap: ffmpeg not found'); return 69; }
  const out = path.resolve(o.out);
  if (fs.existsSync(out) && fs.readdirSync(out).length) { console.error(`sixmap: ${out} is not empty; give a new directory`); return 64; }
  fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
  const t0 = Date.now();

  // 1. the season
  const trace = path.join(out, 'trace.json');
  if (o.trace) fs.copyFileSync(path.resolve(o.trace), trace);
  else {
    if (!fs.existsSync(sim)) { console.error(`sixmap: ${sim} missing: (cd frontier-sim && cargo build --release)`); return 66; }
    log('season:', sim, simArgs(o, trace).join(' '));
    await run(sim, simArgs(o, trace));
  }

  // 2. the pictures
  const { chromium } = loadPlaywright(root);
  const browser = await chromium.launch({ headless: true });
  let enc;
  const video = path.join(out, 'map.mp4');
  const stats = [];
  let info;
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    // Every request goes to memory or to the repo's own files; nothing leaves the machine.
    await page.route('**/*', async r => {
      const u = new URL(r.request().url());
      if (u.origin !== ORIGIN) return r.abort();
      let file = null;
      if (u.pathname === '/trace.json') file = trace;
      else if (u.pathname.startsWith('/web/')) file = path.join(root, 'permutation-server/web', path.normalize(u.pathname.slice(5)));
      else file = path.join(HERE, path.normalize(u.pathname.slice(1)));
      const ok = file && (file.startsWith(path.join(root, 'permutation-server/web')) || file.startsWith(HERE) || file === trace) && fs.existsSync(file) && fs.statSync(file).isFile();
      if (!ok) return r.fulfill({ status: 404, body: 'not found' });
      return r.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) });
    });
    await page.goto(`${ORIGIN}/render.html`);
    await page.waitForFunction(() => window.sixmap);
    info = await page.evaluate(u => window.sixmap.load(u), `${ORIGIN}/trace.json`);
    log('trace:', JSON.stringify(info));
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
    enc = spawn(ffmpeg, ffmpegEncodeArgs(o, video), { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((res, rej) => { enc.on('exit', c => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))); enc.on('error', rej); });
    const canvas = page.locator('#c');
    for (let i = 0; i < n; i++) {
      const b = bellAt(i, o, info.endBell);
      await page.evaluate(x => window.sixmap.draw(x), b);
      const png = await canvas.screenshot({ type: 'png', animations: 'disabled' });
      if (!enc.stdin.write(png)) await new Promise(r => enc.stdin.once('drain', r));
      if (i % (o.fps * 10) === 0) log(`frame ${i}/${n} bell ${b.toFixed(1)}`);
      if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
    }
    enc.stdin.end();
    await done;
    for (const i of stillFrames(o)) { const b = bellAt(i, o, info.endBell); stats.push({ frame: i, t: +(i / o.fps).toFixed(2), drawnBell: +b.toFixed(1), day: dayOf(b, 144, info.days), ...(await page.evaluate(x => window.sixmap.stats(x), b)) }); }
  } finally {
    await browser.close();
    if (enc && enc.exitCode === null && !enc.stdin.writableEnded) enc.kill('SIGTERM');
  }

  // 3. stills and the manifest
  const stills = [];
  for (const [k, s] of stats.entries()) {
    const file = path.join(out, 'frames', `${String(k + 1).padStart(2, '0')}-t${String(Math.round(s.t)).padStart(3, '0')}s-day${s.day}.png`);
    await run(ffmpeg, ffmpegStillArgs(video, s.frame, file));
    stills.push({ file: path.relative(out, file), ...s });
  }
  const probe = which('ffprobe') ? JSON.parse(execFileSync(which('ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration,size', '-of', 'json', video], { encoding: 'utf8' })) : null;
  const manifest = {
    what: 'TEST-only six-nation map timelapse: one map of the whole world from a frontier-sim season (MC conquest rules, bots). Not a chain, not a live world.',
    seed: o.seed, options: o, commit: git(root, 'rev-parse', 'HEAD'), dirty: !!git(root, 'status', '--porcelain', '--', 'frontier-sim', 'scripts/demo/sixnation/map'),
    sim: o.trace ? null : { path: sim, sha256: sha256(sim), args: simArgs(o, 'trace.json') },
    trace: { sha256: sha256(trace), bytes: fs.statSync(trace).size, ...info },
    video: { file: 'map.mp4', sha256: sha256(video), bytes: fs.statSync(video).size, frames: n, fps: o.fps, seconds: o.seconds, probe },
    stills,
    versions: { node: process.version, ffmpeg: execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n')[0], chromium: 'playwright-core chromium (headless)' },
    elapsedSeconds: Math.round((Date.now() - t0) / 1000),
    network: 'none (page served from memory; every other request aborted)', ports: 'none',
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`wrote ${video} (${(manifest.video.bytes / 1e6).toFixed(1)} MB) and ${stills.length} stills in ${manifest.elapsedSeconds} s`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(c => process.exit(c), e => { console.error(e); process.exit(1); });
