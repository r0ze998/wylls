import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, simArgs, frameCount, bellAt, stillFrames, dayOf, ffmpegEncodeArgs, ffmpegStillArgs, DEFAULTS } from '../lib.mjs';

test('defaults and --out', () => {
  const o = parseArgs(['--out', '/tmp/x']);
  assert.equal(o.seed, DEFAULTS.seed);
  assert.equal(o.out, '/tmp/x');
  assert.throws(() => parseArgs([]), /--out/);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('refuses every chain, RPC and key flag (exit 3 code)', () => {
  for (const f of ['--cluster', '--rpc', '--url', '--ws', '--key', '--keypair', '--wallet', '--devnet', '--mainnet', '--rpc=http://x']) {
    assert.throws(() => parseArgs(['--out', '/tmp/x', f, 'v']), e => e.code === 'NonTestCluster', f);
  }
});

test('bad numbers and unknown flags', () => {
  assert.throws(() => parseArgs(['--out', 'x', '--fps', '5']), e => e.code === 'BadArg');
  assert.throws(() => parseArgs(['--out', 'x', '--days', '0']), e => e.code === 'BadArg');
  assert.throws(() => parseArgs(['--out', 'x', '--seconds', '4']), e => e.code === 'BadArg');
  assert.throws(() => parseArgs(['--out', 'x', '--what']), /unknown/);
});

test('the frontier-sim line is the mapmove season of the seed', () => {
  const o = parseArgs(['--out', 'x', '--seed', '7']);
  assert.deepEqual(simArgs(o, 't.json'), ['timelapse', '--rules', 'mc', '--policy', 'campaign', '--bot-profile', 'cq', '--agents', '1000', '--bots', '0.99', '--days', '7', '--seed', '7', '--every', '2', '--out', 't.json']);
});

test('video clock: intro hold, one speed, outro hold, monotone', () => {
  const o = parseArgs(['--out', 'x', '--seconds', '100', '--fps', '30']);
  const n = frameCount(o), end = 1008;
  assert.equal(n, 3000);
  assert.equal(bellAt(0, o, end), 0);
  assert.equal(bellAt(Math.round(o.intro * o.fps), o, end), 0);
  assert.equal(bellAt(n - 1, o, end), end - 1);
  assert.equal(bellAt(Math.round((o.seconds - o.outro) * o.fps), o, end), end - 1);
  let prev = -1;
  for (let i = 0; i < n; i++) { const b = bellAt(i, o, end); assert.ok(b >= prev); prev = b; }
});

test('stills: frame numbers spread over the video, inside it; the day is the HUD\'s', () => {
  const o = parseArgs(['--out', 'x']);
  const f = stillFrames(o);
  assert.equal(f.length, o.frames);
  assert.ok(f[0] > o.intro * o.fps && f.at(-1) < frameCount(o));
  for (let k = 1; k < f.length; k++) assert.ok(f[k] > f[k - 1]);
  assert.equal(dayOf(0, 144, 7), 1);
  assert.equal(dayOf(143.9, 144, 7), 1);
  assert.equal(dayOf(144, 144, 7), 2);
  assert.equal(dayOf(1007, 144, 7), 7);
});

test('ffmpeg lines: H.264 yuv420p from a PNG pipe; one still', () => {
  const o = parseArgs(['--out', 'x']);
  const a = ffmpegEncodeArgs(o, 'm.mp4');
  for (const s of ['image2pipe', 'libx264', 'yuv420p', '+faststart']) assert.ok(a.includes(s), s);
  assert.equal(a.at(-1), 'm.mp4');
  assert.deepEqual(ffmpegStillArgs('m.mp4', 105, 'f.png').slice(-9), ['-i', 'm.mp4', '-vf', 'select=eq(n\\,105)', '-fps_mode', 'passthrough', '-frames:v', '1', 'f.png']);
});
