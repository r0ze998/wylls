// Pure parts of the six-nation map timelapse (sixmap.mjs): argument parsing, the video clock and the ffmpeg lines.
export const DEFAULTS = Object.freeze({
  seed: 2002, days: 7, agents: 1000, bots: 0.99, every: 2, seconds: 100, fps: 30, intro: 1.5, outro: 4,
  rules: 'mc', policy: 'campaign', botProfile: 'cq', crf: 20, frames: 8,
});

const REFUSED = ['--cluster', '--rpc', '--url', '--ws', '--key', '--keypair', '--wallet', '--devnet', '--mainnet'];

export function parseArgs(argv) {
  const o = { ...DEFAULTS, out: null, sim: null, trace: null, root: null, dryRun: false };
  const num = (k, v, lo, hi, int = true) => {
    const n = Number(v);
    if (!Number.isFinite(n) || (int && !Number.isInteger(n)) || n < lo || n > hi) throw Object.assign(new Error(`${k}: ${v} is not a number in ${lo}..${hi}`), { code: 'BadArg' });
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (REFUSED.some(r => a === r || a.startsWith(`${r}=`))) throw Object.assign(new Error(`${a}: this tool reads a local simulation only; no chain, RPC or key flag`), { code: 'NonTestCluster' });
    switch (a) {
      case '--seed': o.seed = num(a, v, 0, 2 ** 53); i++; break;
      case '--days': o.days = num(a, v, 1, 28); i++; break;
      case '--agents': o.agents = num(a, v, 60, 50000); i++; break;
      case '--bots': o.bots = num(a, v, 0, 1, false); i++; break;
      case '--every': o.every = num(a, v, 1, 36); i++; break;
      case '--seconds': o.seconds = num(a, v, 10, 1800, false); i++; break;
      case '--fps': o.fps = num(a, v, 10, 60); i++; break;
      case '--crf': o.crf = num(a, v, 10, 40); i++; break;
      case '--frames': o.frames = num(a, v, 2, 30); i++; break;
      case '--out': o.out = v; i++; break;
      case '--sim': o.sim = v; i++; break;
      case '--trace': o.trace = v; i++; break;
      case '--root': o.root = v; i++; break;
      case '--dry-run': o.dryRun = true; break;
      default: throw Object.assign(new Error(`unknown argument ${a}`), { code: 'BadArg' });
    }
  }
  if (!o.dryRun && !o.out) throw Object.assign(new Error('--out <new evidence dir> is required'), { code: 'BadArg' });
  if (o.seconds <= o.intro + o.outro + 1) throw Object.assign(new Error('--seconds is too short for the intro and outro'), { code: 'BadArg' });
  return o;
}

/** The frontier-sim command line of the trace. */
export function simArgs(o, out) {
  return ['timelapse', '--rules', o.rules, '--policy', o.policy, '--bot-profile', o.botProfile, '--agents', String(o.agents),
    '--bots', String(o.bots), '--days', String(o.days), '--seed', String(o.seed), '--every', String(o.every), '--out', out];
}

/** Video frames and the season bell each one shows: an intro hold on the first bell, the season at one speed, an outro hold. */
export function frameCount(o) { return Math.round(o.seconds * o.fps); }
export function bellAt(i, o, endBell) {
  const t = i / o.fps, run = o.seconds - o.intro - o.outro;
  const u = Math.max(0, Math.min(1, (t - o.intro) / run));
  return u * (endBell - 1);
}
/** Video frame indices of the still frames: evenly over the run, the first just after the intro, the last in the outro. */
export function stillFrames(o) {
  const n = o.frames, run = o.seconds - o.intro - o.outro;
  return Array.from({ length: n }, (_, k) => Math.round((o.intro + 0.2 + (run - 0.2) * (k / (n - 1)) + (k === n - 1 ? 1 : 0)) * o.fps));
}
/** The day the HUD shows at bell b (render.mjs hud). */
export const dayOf = (b, bellsPerDay, days) => Math.min(days, Math.floor(b / bellsPerDay) + 1);

export function ffmpegEncodeArgs(o, out) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(o.fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(o.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
}
/** One still: video frame number `t` exactly (decoded, not a keyframe seek). */
export function ffmpegStillArgs(video, t, out) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${t})`, '-fps_mode', 'passthrough', '-frames:v', '1', out];
}
