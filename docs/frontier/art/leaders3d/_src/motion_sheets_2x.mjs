// The sharp set of the six characters' map sheets: art/leaders3d/motion-v1/sprite@2x (frames of 512 px).
//
// Nothing here draws or poses anything: the frames are rendered by the owner's own script, unmodified
// (package 「6人の動き」, source/render_motion.py, mode `render`), from the owner's own models. That script
// already renders two pictures of every "map" frame with one camera, one set of lights, the same head
// pitch (36 degrees), the same wrapper scale and turn, the same anchor and cell: the sprite cell at
// 256 px (what the package's sheets were assembled from) and a review frame at 512 px. This tool asks it
// for the review frames at the instants a sheet needs and puts them in a row.
//
//   node motion_sheets_2x.mjs render   <package dir> <work dir>
//   node motion_sheets_2x.mjs assemble <work dir> <out dir (…/frontier/art/leaders3d/motion-v1/sprite@2x)> [quality=75]
//   node motion_sheets_2x.mjs compare  <work dir> <package dir>/sprite
//
// render    runs Blender four times, once a clip, each with the --review-fps that makes the script's own
//           sampling of the review frames land on the sheet's instants (it takes count = round(duration × fps)
//           frames; a loop at i / count of its length, a one-shot at i / (count − 1)):
//             idle    2.0 s  × 4  = 8 frames  (the package's sheet has 4: every second one of these)
//             walk    1.0 s  × 8  = 8 frames  (as the package's sheet)
//             attack  0.8 s  × 10 = 8 frames  (as the package's sheet)
//             hit     0.55 s × 7  = 4 frames  (3.85, rounded; as the package's sheet)
//           The script writes only under <work dir> (--output); the package is opened and never saved (the
//           script itself checks each model's digest before and after).
// assemble  <work dir>/renders/<key>/<clip>/map/frame-NNN.png in a row (ffmpeg hstack, no resampling), encoded
//           as lossy WebP with a lossless alpha plane (cwebp -q <quality> -m 6 -alpha_q 100 -sharp_yuv).
// compare   proves the 2x frames are the package's pictures: each 512 px frame halved (a 2 × 2 box in linear
//           light, premultiplied) against the package's 256 px frame of the same instant, and the 256 px cells
//           this run rendered against the package's (the same script on this machine: the noise floor).
//
// Needs Blender (the version the package was made with: 5.2), ffmpeg and cwebp on this machine; nothing is
// installed or downloaded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BLENDER = process.env.BLENDER || '/opt/homebrew/bin/blender';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const CWEBP = process.env.CWEBP || '/opt/homebrew/bin/cwebp';
const KEYS = ['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal'];
// [clip, frames in the 2x sheet, --review-fps that yields them, frames in the package's sheet]
const CLIPS = [['idle', 8, 4, 4], ['walk', 8, 8, 8], ['attack', 8, 10, 8], ['hit', 4, 7, 4]];
const pad = i => String(i).padStart(3, '0');
const [mode, a, b, c] = process.argv.slice(2);

if (mode === 'render') {
  const pkg = a, work = b;
  mkdirSync(work, { recursive: true });
  for (const [clip, , fps] of CLIPS) {
    const out = execFileSync(BLENDER, ['-b', '--python', `${pkg}/source/render_motion.py`, '--', 'render', '--models', `${pkg}/models`, '--output', work, '--clips', clip, '--review-fps', String(fps)], { maxBuffer: 1 << 28 }).toString();
    console.log(out.split('\n').filter(l => l.startsWith('MOTION RENDER')).join('\n'));
  }
} else if (mode === 'assemble') {
  const work = a, out = b, q = c ?? '75';
  const rows = mkdtempSync(join(tmpdir(), 'wylls-rows-'));
  mkdirSync(out, { recursive: true });
  let total = 0;
  for (const k of KEYS) for (const [clip, n] of CLIPS) {
    const row = `${rows}/${k}_${clip}.png`, file = `${out}/${k}_${clip}.webp`;
    const ins = Array.from({ length: n }, (_, i) => ['-i', `${work}/renders/${k}/${clip}/map/frame-${pad(i)}.png`]).flat();
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...ins, '-filter_complex', `hstack=inputs=${n}`, '-pix_fmt', 'rgba', row]);
    execFileSync(CWEBP, ['-quiet', '-q', q, '-m', '6', '-alpha_q', '100', '-sharp_yuv', row, '-o', file]);
    total += statSync(file).size;
    console.log(`${k}_${clip}.webp`, `${512 * n}x512`, statSync(file).size);
  }
  rmSync(rows, { recursive: true, force: true });
  console.log('total', total);
} else if (mode === 'compare') {
  const work = a, owner = b;
  const raw = (f, w, h) => { const buf = execFileSync(FFMPEG, ['-loglevel', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 }); if (buf.length !== w * h * 4) throw new Error(`${f}: not ${w} x ${h}`); return buf; };
  const toLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }, toSrgb = v => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  const LUT = Float64Array.from({ length: 256 }, (_, i) => toLin(i));
  /** straight RGBA bytes → linear light, premultiplied (rgb 0..1 × a, a 0..1) */
  const lin = (d, n) => { const o = new Float64Array(n * 4); for (let i = 0; i < n; i++) { const al = d[i * 4 + 3] / 255; o[i * 4] = LUT[d[i * 4]] * al; o[i * 4 + 1] = LUT[d[i * 4 + 1]] * al; o[i * 4 + 2] = LUT[d[i * 4 + 2]] * al; o[i * 4 + 3] = al; } return o; };
  /** a 2 × 2 box: w × h → w/2 × h/2 */
  const box = (f, w, h) => { const W = w / 2, H = h / 2, o = new Float64Array(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let ch = 0; ch < 4; ch++) { const i = (y * 2 * w + x * 2) * 4 + ch; o[(y * W + x) * 4 + ch] = (f[i] + f[i + 4] + f[i + w * 4] + f[i + w * 4 + 4]) / 4; } return o; };
  /** linear premultiplied → what a screen shows of it over black, 0..255, and its alpha 0..255 */
  const disp = (f, n) => { const o = new Float64Array(n * 4); for (let i = 0; i < n; i++) { const al = f[i * 4 + 3]; for (let ch = 0; ch < 3; ch++) o[i * 4 + ch] = al > 0 ? toSrgb(f[i * 4 + ch] / al) * al : 0; o[i * 4 + 3] = al * 255; } return o; };
  /** |x − y| over the pixels either picture covers: the mean of the four channels (of 255), the largest, the share of pixels off by more than 8 */
  const diff = (x, y, n) => { let cov = 0, sum = 0, max = 0, big = 0, ax = 0, ay = 0; for (let i = 0; i < n; i++) { ax += x[i * 4 + 3]; ay += y[i * 4 + 3]; if (!(x[i * 4 + 3] > 1 || y[i * 4 + 3] > 1)) continue; cov++; let m = 0; for (let ch = 0; ch < 4; ch++) { const e = Math.abs(x[i * 4 + ch] - y[i * 4 + ch]); sum += e; if (e > m) m = e; } if (m > max) max = m; if (m > 8) big++; } return { mean: sum / (cov * 4), max, big: big / cov, area: Math.abs(ax - ay) / ay }; };
  const rows = [];
  for (const k of KEYS) for (const [clip, n2, , n1] of CLIPS) {
    const sheet = raw(`${owner}/${k}_${clip}.webp`, 256 * n1, 256);
    for (let i = 0; i < n1; i++) {
      const cell = Buffer.alloc(256 * 256 * 4);
      for (let y = 0; y < 256; y++) sheet.copy(cell, y * 1024, (y * 256 * n1 + i * 256) * 4, (y * 256 * n1 + i * 256 + 256) * 4);
      const O = lin(cell, 65536), j = i * (n2 / n1);
      const mine = lin(raw(`${work}/renders/${k}/${clip}/map/frame-${pad(j)}.png`, 512, 512), 262144), halved = box(mine, 512, 512);
      const next = box(lin(raw(`${work}/renders/${k}/${clip}/map/frame-${pad((j + 1) % n2)}.png`, 512, 512), 262144), 512, 512);
      const q = f => box(box(f, 256, 256), 128, 128);
      rows.push({ clip,
        halved: diff(disp(O, 65536), disp(halved, 65536), 65536),                       // the 2x frame at the package's size
        at64: diff(disp(q(O), 4096), disp(q(halved), 4096), 4096),                      // both reduced to 64 px: the same picture without its finest detail
        nextAt64: diff(disp(q(O), 4096), disp(q(next), 4096), 4096),                    // against the NEXT 2x frame: what a different pose measures
        rerun: diff(disp(O, 65536), disp(lin(raw(`${work}/cells/${k}/${clip}/sprite/frame-${pad(i)}.png`, 256, 256), 65536), 65536), 65536) });   // this machine's 256 px cell
    }
  }
  const agg = (key, of = rows) => ({ frames: of.length, mean: +(of.reduce((s, r) => s + r[key].mean, 0) / of.length).toFixed(2), worstFrame: +Math.max(...of.map(r => r[key].mean)).toFixed(2), max: +Math.max(...of.map(r => r[key].max)).toFixed(1), over8: +(of.reduce((s, r) => s + r[key].big, 0) / of.length).toFixed(4), area: +(of.reduce((s, r) => s + r[key].area, 0) / of.length).toFixed(5) });
  console.log(JSON.stringify({ unit: 'mean |difference| of premultiplied RGBA, of 255, over the pixels either picture covers', rerun256: agg('rerun'), halved512: agg('halved'), bothAt64: agg('at64'),
    differentPoseAt64: Object.fromEntries(CLIPS.map(([clip]) => [clip, agg('nextAt64', rows.filter(r => r.clip === clip)).mean])), samePoseAt64: Object.fromEntries(CLIPS.map(([clip]) => [clip, agg('at64', rows.filter(r => r.clip === clip)).mean])) }, null, 1));
} else {
  console.error('usage: node motion_sheets_2x.mjs render|assemble|compare … (see the head of this file)');
  process.exit(2);
}
