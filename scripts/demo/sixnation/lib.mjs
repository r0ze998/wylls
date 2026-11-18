// TEST-ONLY six-nation recording: the pure, key-free part (argument parsing, the seed's choices, the port plan, the
// launcher's command line, the run summary, the ffmpeg grid and the HTML grid player). No process, no network here.
// sixnation.mjs runs it; test/sixnation.test.mjs tests it.
import path from 'node:path';

export const NATIONS = Object.freeze(['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal']);
/** The only cluster this tool starts: the launcher's own memory-only local chain. */
export const TEST_CLUSTER = 'localnet';
/** Names of public clusters, refused by name so a typo never reads as "localnet" (anything else is refused too). */
const PUBLIC_CLUSTERS = /^(devnet|testnet|mainnet|mainnet-beta)$/i;
export const DEFAULTS = Object.freeze({ seed: 1, minutes: 20, turns: 0, demoScale: 20, portBase: 41300, maxActs: 400, tile: '800x500', cluster: TEST_CLUSTER });
/** Ports the launcher and others keep for themselves (local-play-launcher.mjs parseConfig): never in our plan. */
const RESERVED = [41904, 41905, 41906, 41907, 41970];
/** The plan's span from --port-base: launcher, 2 worlds × 5, 2 × 6 resident relays, then this tool's own (none listen). */
export const SPAN = 32;

const fail = (code, msg) => { throw Object.assign(new Error(`${code}: ${msg}`), { code }); };
const whole = (raw, k, lo, hi) => {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) fail('InvalidArgument', `--${k} must be a whole number`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) fail('InvalidArgument', `--${k} must be ${lo}-${hi}`);
  return n;
};

/**
 * The command line → options. Refuses (throws, code set): an unknown flag, a repeated flag, a missing value, a
 * non-local cluster (`NonTestCluster`), any RPC/URL flag (`NonTestCluster`: the world's chain is the launcher's own),
 * ports outside 41000-41999 or over a reserved port (`InvalidPorts`), relative paths.
 */
export function parseArgs(argv) {
  const flags = new Set(['seed', 'minutes', 'turns', 'demo-scale', 'port-base', 'bins', 'out', 'root', 'max-acts', 'tile', 'cluster', 'dry-run', 'no-grid', 'player-nation']);
  const bare = new Set(['dry-run', 'no-grid']);
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string' || !a.startsWith('--')) fail('InvalidArgument', `unexpected ${a}`);
    const k = a.slice(2);
    if (/^(rpc|url|rpc-url|ws|ws-url|keypair|key|wallet)$/.test(k)) fail('NonTestCluster', `--${k}: this tool never takes a chain address or a key; the world is the launcher's own local chain`);
    if (!flags.has(k)) fail('InvalidArgument', `unknown flag ${a}`);
    if (o[k] !== undefined) fail('InvalidArgument', `${a} given twice`);
    if (bare.has(k)) { o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) fail('InvalidArgument', `${a} needs a value`);
    o[k] = v;
  }
  const cluster = o.cluster ?? TEST_CLUSTER;
  if (cluster !== TEST_CLUSTER) fail('NonTestCluster', PUBLIC_CLUSTERS.test(cluster) ? `${cluster} is a public cluster: TEST local worlds only` : `cluster ${JSON.stringify(cluster)}: only ${TEST_CLUSTER}`);
  const opts = {
    seed: o.seed === undefined ? DEFAULTS.seed : whole(o.seed, 'seed', 0, 0xffffffff),
    minutes: o.minutes === undefined ? DEFAULTS.minutes : whole(o.minutes, 'minutes', 1, 120),
    turns: o.turns === undefined ? DEFAULTS.turns : whole(o.turns, 'turns', 0, 10000),
    demoScale: o['demo-scale'] === undefined ? DEFAULTS.demoScale : whole(o['demo-scale'], 'demo-scale', 10, 60),
    portBase: o['port-base'] === undefined ? DEFAULTS.portBase : whole(o['port-base'], 'port-base', 41000, 41999),
    maxActs: o['max-acts'] === undefined ? DEFAULTS.maxActs : whole(o['max-acts'], 'max-acts', 1, 9999),
    playerNation: o['player-nation'] === undefined ? null : whole(o['player-nation'], 'player-nation', 0, 5),
    cluster, dryRun: !!o['dry-run'], grid: !o['no-grid'],
  };
  const m = /^([1-9][0-9]{2,3})x([1-9][0-9]{2,3})$/.exec(o.tile ?? DEFAULTS.tile);
  if (!m || Number(m[1]) % 2 || Number(m[2]) % 2 || Number(m[1]) > 1920 || Number(m[2]) > 1200) fail('InvalidArgument', '--tile WxH, even numbers, at most 1920x1200');
  opts.tile = { w: Number(m[1]), h: Number(m[2]) };
  const ports = portPlan(opts.portBase);
  if (ports.all.some(p => p < 41000 || p > 41999 || RESERVED.includes(p))) fail('InvalidPorts', `--port-base ${opts.portBase}: the plan's ${SPAN} ports must stay in 41000-41999 and miss ${RESERVED.join(', ')}`);
  for (const k of ['bins', 'out', 'root']) {
    if (o[k] !== undefined && !path.isAbsolute(o[k])) fail('InvalidArgument', `--${k} must be an absolute path`);
    if (o[k] !== undefined) opts[k] = o[k];
  }
  if (!opts.dryRun && !opts.bins) fail('InvalidArgument', '--bins <dir with the 7 playable-lane binaries> is required');
  if (!opts.dryRun && !opts.out) fail('InvalidArgument', '--out <evidence dir> is required');
  return opts;
}

/** The launcher's ports from the base: launcher, world 0 (5), world 1 (5), resident relays 6 + 6 (`--operator-nations`). */
export function portPlan(base) {
  const launcher = base, world = base + 10;
  const w = slot => { const b = world + slot * 5; return { rpc: b, ws: b + 1, herald: b + 2, relay: b + 3, internalHerald: b + 4 }; };
  const relays = Array.from({ length: 12 }, (_, i) => world + 10 + i);
  return Object.freeze({ launcher, world, worlds: [w(0), w(1)], relays, all: Array.from({ length: SPAN }, (_, i) => base + i) });
}

/** A small, well-known 32-bit PRNG (mulberry32): the seed's only use is the choices below. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The seed's choices: the order in which the six residents take the six nations (Fisher-Yates over 0-5; resident i
 * joins `nations[i]`) and the nation the starting page (the "player") joins. Same seed → same choices.
 */
export function seedPlan(seed, playerNation = null) {
  const r = rng(seed);
  const nations = [0, 1, 2, 3, 4, 5];
  for (let i = nations.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [nations[i], nations[j]] = [nations[j], nations[i]]; }
  const player = playerNation ?? Math.floor(r() * 6);
  return Object.freeze({ nations: Object.freeze(nations), player });
}

/** The launcher's argv (TEST-only flags only; the binaries from `bins`; `sha` the .so's sha256). */
export function launcherArgs({ root, bins, data, sha, opts, nations }) {
  const b = f => path.join(bins, f);
  const ports = portPlan(opts.portBase);
  return [path.join(root, 'permutation-gateway/src/frontier/local-play-launcher.mjs'), '--root', root, '--data', data,
    '--runner', b('localnet-expedition-play'), '--natural-runner', b('localnet-natural-play'), '--world-preset', 'local-natural-v1',
    '--economy', 'page-signed-v1', '--march-trial', 'local-march-trial-v1', '--capture-demo', 'capture-demo-v1', '--demo-scale', String(opts.demoScale),
    '--herald', b('frontier-herald'), '--depart', b('frontier-experimental-expedition-depart-prepare'), '--preview', b('frontier-original-expedition-preview'),
    '--resident', b('frontier-experimental-expedition-prepare'), '--artifact', b('permutation_frontier.so'), '--artifact-sha', sha,
    '--world-ttl-minutes', String(opts.minutes + 20), '--port', String(ports.launcher), '--world-port', String(ports.world), '--herald-output', 'compact-v2',
    '--operator-nations', nations.join(','), '--operator-max-acts', String(opts.maxActs)];
}
export const BINARIES = Object.freeze(['localnet-expedition-play', 'localnet-natural-play', 'frontier-herald', 'frontier-experimental-expedition-depart-prepare', 'frontier-original-expedition-preview', 'frontier-experimental-expedition-prepare', 'permutation_frontier.so']);

/** JSON lines → objects (bad lines skipped). */
export const jsonLines = text => String(text ?? '').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(v => v && typeof v === 'object');

/** The turn the herald is on: (chain seconds − genesis) / 600, from `/h/status` and `/h/season`. */
export function turnOf(status, season) {
  const live = Array.isArray(status?.live) ? Number(status.live[1]) : NaN, g = Number(season?.genesisTs);
  return Number.isFinite(live) && Number.isFinite(g) ? Math.floor((live - g) / 600) : null;
}

/**
 * operators.out → per-nation summary: `{nations: [{nation, name, resident, wallet, acts: {"Build:landed": n…},
 * landed, refused, failed, first, last, village, stopped}], residents}`.
 */
export function summarize(lines) {
  const ready = lines.find(l => l.step === 'ready');
  const rows = new Map();
  for (const r of ready?.residents ?? []) rows.set(r.resident, { nation: r.faction, name: NATIONS[r.faction] ?? `nation ${r.faction}`, resident: r.resident, wallet: r.wallet, acts: {}, landed: 0, refused: 0, failed: 0, unknown: 0, first: null, last: null, village: null, stopped: null, sends: 0 });
  for (const l of lines) {
    const row = rows.get(l.resident);
    if (!row) continue;
    if (l.seen?.village) row.village = l.seen.village;
    if (l.step === 'budget' && l.outcome === 'stopped') row.stopped = l.why ?? 'stopped';
    if (l.step !== 'act') continue;
    const k = `${l.act}:${l.outcome}`;
    row.acts[k] = (row.acts[k] ?? 0) + 1;
    if (['landed', 'refused', 'failed', 'unknown'].includes(l.outcome)) row[l.outcome] += 1;
    row.first ??= l.at ?? null; row.last = l.at ?? row.last;
    if (l.budget) row.sends = l.budget.sent;
  }
  const nations = [...rows.values()].sort((a, b) => a.nation - b.nation);
  // (active = joined AND placed a village: a resident that only joined is not playing its nation)
  return { residents: nations.length, allSix: new Set(nations.filter(n => (n.acts['PlaceHome:landed'] ?? 0) > 0).map(n => n.nation)).size === 6, nations };
}

/** The summary as a short markdown table. */
export function summaryMarkdown(sum, extra = {}) {
  const acts = ['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster'];
  const head = `| nation | resident | village (p,q,site) | ${acts.join(' | ')} | refused | failed | sends | stopped |\n|---|---|---|${acts.map(() => '---').join('|')}|---|---|---|---|`;
  const body = sum.nations.map(n => `| ${n.nation} ${n.name} | ${n.resident} | ${n.village ?? '—'} | ${acts.map(a => n.acts[`${a}:landed`] ?? 0).join(' | ')} | ${n.refused} | ${n.failed} | ${n.sends} | ${n.stopped ?? '—'} |`).join('\n');
  const notes = Object.entries(extra).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `Landed commands per nation (operator AI residents; counts of \`landed\` outcomes, from operators.out).\n\n${head}\n${body}\n\nAll six nations with an active resident (joined and placed a village): **${sum.allSix ? 'yes' : 'NO'}**\n${notes ? `\n${notes}\n` : ''}`;
}

/** The grid: `tiles` [{file, offset (s), label}] in reading order, `cols` per row → ffmpeg argv (xstack, H.264). */
export function ffmpegGridArgs(tiles, { cols, w, h, out, duration }) {
  if (!tiles.length || !Number.isInteger(cols) || cols < 1) throw new Error('grid');
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const t of tiles) args.push('-ss', Math.max(0, t.offset).toFixed(3), '-i', t.file);
  const rows = Math.ceil(tiles.length / cols);
  const pads = Array.from({ length: rows * cols - tiles.length }, () => null);
  const parts = tiles.map((_, i) => `[${i}:v]fps=15,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`);
  pads.forEach((_, j) => parts.push(`color=c=black:s=${w}x${h}:r=15[v${tiles.length + j}]`));
  const n = rows * cols;
  const layout = Array.from({ length: n }, (_, i) => `${(i % cols) * w}_${Math.floor(i / cols) * h}`).join('|');
  parts.push(`${Array.from({ length: n }, (_, i) => `[v${i}]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=black[g]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[g]', ...(duration ? ['-t', duration.toFixed(1)] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  return args;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** A self-contained HTML grid player for the per-view webm files (relative paths), started together, offsets applied. */
export function gridHtml(tiles, { cols, title }) {
  const cells = tiles.map((t, i) => `<figure><video id="v${i}" src="${esc(t.rel)}" muted preload="auto" data-offset="${t.offset.toFixed(3)}"></video><figcaption>${esc(t.label)}</figcaption></figure>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;background:#111;color:#ddd;font:13px system-ui}header{padding:6px 10px}main{display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px;padding:4px}figure{margin:0}video{width:100%;display:block;background:#000}figcaption{padding:2px 4px}</style>
<header>${esc(title)} — <button id="play">play / pause</button> <input id="seek" type="range" min="0" max="1000" value="0" style="width:50%"> <span id="t"></span></header>
<main>${cells}</main>
<script>
const vs=[...document.querySelectorAll('video')];const off=v=>Number(v.dataset.offset);
const dur=()=>Math.min(...vs.map(v=>(v.duration||0)-off(v)).filter(Number.isFinite));
const at=s=>vs.forEach(v=>{v.currentTime=Math.max(0,s+off(v));});
document.getElementById('play').onclick=()=>{const p=vs[0].paused;if(p){const s=vs[0].currentTime-off(vs[0]);at(s);vs.forEach(v=>v.play());}else vs.forEach(v=>v.pause());};
document.getElementById('seek').oninput=e=>at(dur()*e.target.value/1000);
setInterval(()=>{const s=vs[0].currentTime-off(vs[0]);document.getElementById('t').textContent=Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');},500);
addEventListener('load',()=>at(0));
</script>
`;
}
