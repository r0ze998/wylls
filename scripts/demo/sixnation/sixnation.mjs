// TEST-ONLY six-nation bot session + multi-view recording, one command:
//
//   node scripts/demo/sixnation/sixnation.mjs --bins <dir with the 7 playable-lane binaries> --out <evidence dir> \
//     [--seed 1] [--minutes 20] [--turns 0] [--demo-scale 20] [--port-base 41300] [--max-acts 400] [--tile 800x500] \
//     [--player-nation <0-5>] [--no-grid] [--dry-run]
//
// What it does (README.md has the long form):
//   1. refuses anything but the launcher's own memory-only local chain (`--cluster localnet` only; no RPC/URL/key flag),
//      checks its 32 loopback ports are free and the binaries are there, and hashes them;
//   2. starts the TEST local-play launcher DETACHED (its own session: a closing terminal does not end it), natural
//      preset, capture-demo clock ×<demo-scale>, with `--operator-nations <the seed's order of 0-5>`: six operator AI
//      residents (⑤ A), one per nation, memory-only TEST keys made by their own process;
//   3. a headless Chromium page (the "player") opens the launcher, starts the world and joins the seed's nation through
//      the page's own buttons (its key: the page's memory-only local-play wallet);
//   4. records 9 views with Playwright's `recordVideo`: the player, the spectator overview, one spectator per nation
//      (nation filter + camera on that nation's village) and a live summary tile; snapshots every 5 minutes;
//   5. after --minutes (or --turns turns, whichever first) closes the views, ends the launcher (and so every process of
//      the world), checks the ports are free again, and writes: views/*.webm, grid.mp4 (ffmpeg, when found) and
//      grid.html, operators.out/json, summary.{json,md}, manifest.json.
// No real key, no devnet/mainnet, no paid API, no model. Network: loopback, plus the natural runner's public drand
// beacon reads (GET api.drand.sh, BLS-verified; the natural world's genesis round and keeper — not this tool's code).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, seedPlan, portPlan, launcherArgs, BINARIES, NATIONS, jsonLines, turnOf, summarize, summaryMarkdown, ffmpegGridArgs, gridHtml } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[sixnation ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function portFree(port) {
  return new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
}
async function getJson(url, ms = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'error' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
function which(cmd) { try { return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8' }).trim() || null; } catch { return null; } }
function loadPlaywright(root) {
  for (const p of [path.join(root, 'permutation-gateway/screens/package.json'), path.join(HERE, 'package.json')]) {
    try { return createRequire(p)('playwright-core'); } catch { /* next */ }
  }
  throw Object.assign(new Error('playwright-core not found: npm install --prefix permutation-gateway/screens (Chromium: npx playwright-core install chromium)'), { code: 'NoPlaywright' });
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`sixnation: ${e.message}`); return e.code === 'NonTestCluster' ? 3 : 64; }
  const root = opts.root ?? path.resolve(HERE, '../../..');
  const plan = seedPlan(opts.seed, opts.playerNation);
  const ports = portPlan(opts.portBase);
  const dryArgs = launcherArgs({ root, bins: opts.bins ?? '<bins>', data: path.join(opts.out ?? '<out>', 'world-data'), sha: '<sha256 of permutation_frontier.so>', opts, nations: plan.nations });
  if (opts.dryRun) {
    console.log(JSON.stringify({ seed: opts.seed, cluster: opts.cluster, residents: plan.nations.map((n, i) => ({ resident: i, nation: n, name: NATIONS[n] })), player: { nation: plan.player, name: NATIONS[plan.player] }, minutes: opts.minutes, turns: opts.turns, demoScale: opts.demoScale, secondsPerTurn: 600 / opts.demoScale, ports: { launcher: ports.launcher, world: ports.worlds[0], relays: ports.relays.slice(0, 6), span: [ports.all[0], ports.all.at(-1)] }, launcher: dryArgs }, null, 1));
    return 0;
  }
  // 1. preflight
  const out = opts.out; fs.mkdirSync(path.join(out, 'views'), { recursive: true }); fs.mkdirSync(path.join(out, 'snapshots'), { recursive: true });
  if (fs.existsSync(path.join(out, 'manifest.json'))) { console.error('sixnation: --out already holds a run (manifest.json); choose a new directory'); return 64; }
  const missing = BINARIES.filter(b => !fs.statSync(path.join(opts.bins, b), { throwIfNoEntry: false })?.isFile());
  if (missing.length) { console.error(`sixnation: missing in --bins: ${missing.join(', ')}`); return 66; }
  const busy = []; for (const p of ports.all) if (!(await portFree(p))) busy.push(p);
  if (busy.length) { console.error(`sixnation: ports busy: ${busy.join(', ')} (choose another --port-base)`); return 69; }
  const free = fs.statfsSync(out); const freeGiB = (free.bavail * free.bsize) / 1024 ** 3;
  if (freeGiB < 8) { console.error(`sixnation: only ${freeGiB.toFixed(1)} GiB free under --out (needs 8)`); return 69; }
  const pw = loadPlaywright(root);
  const ffmpeg = opts.grid ? which('ffmpeg') : null;
  const hashes = Object.fromEntries(BINARIES.map(b => [b, sha256(path.join(opts.bins, b))]));
  let commit = null, dirty = null;
  try { commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0; } catch { /* not a checkout */ }
  const manifest = { schema: 'wylls-sixnation-recording-v1', test_only: true, cluster: opts.cluster, seed: opts.seed, plan, options: { ...opts, bins: opts.bins, out }, commit, dirty, binaries: hashes, bins: opts.bins,
    node: process.version, platform: `${os.platform()} ${os.release()}`, ffmpeg: ffmpeg ? execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n')[0] : null, ports: { launcher: ports.launcher, world: ports.worlds[0], relays: ports.relays.slice(0, 6) }, startedAt: new Date().toISOString() };
  log(`seed ${opts.seed}: residents ${plan.nations.map(n => NATIONS[n]).join(', ')}; player ${NATIONS[plan.player]}; ${opts.minutes} min at ×${opts.demoScale} (${600 / opts.demoScale} s per turn)`);

  // 2. the launcher, detached
  const data = path.join(out, 'world-data');
  const args = launcherArgs({ root, bins: opts.bins, data, sha: hashes['permutation_frontier.so'], opts, nations: plan.nations });
  const lo = fs.openSync(path.join(out, 'launcher.out'), 'a'), le = fs.openSync(path.join(out, 'launcher.err'), 'a');
  const launcher = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', lo, le] });
  launcher.unref();
  manifest.launcherPid = launcher.pid;
  let browser = null, worldDir = null, cleanedUp = false;
  const views = [];
  const cleanup = async why => {
    if (cleanedUp) return; cleanedUp = true;
    log(`ending (${why})`);
    for (const v of views) { try { await v.ctx.close(); } catch { /* gone */ } }
    try { await browser?.close(); } catch { /* gone */ }
    try { process.kill(launcher.pid, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 60; i++) { try { process.kill(launcher.pid, 0); } catch { break; } await delay(500); }
    try { process.kill(launcher.pid, 'SIGKILL'); } catch { /* gone */ }
    // (the launcher ends its worlds' processes itself; any still alive after it is reported, never left silently)
    const procs = worldDir ? JSON.parse(fs.readFileSync(path.join(worldDir, 'processes.json'), 'utf8')).pids ?? [] : [];
    const alive = procs.filter(p => { try { process.kill(p, 0); return true; } catch { return false; } });
    for (const p of alive) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
    await delay(1500);
    const stillBusy = []; for (const p of ports.all) if (!(await portFree(p))) stillBusy.push(p);
    manifest.cleanup = { why, worldProcessesAliveAfterLauncher: alive, portsBusyAfter: stillBusy };
  };
  const onSignal = s => { cleanup(s).then(() => process.exit(130)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); process.once('SIGHUP', onSignal);

  try {
    for (let i = 0; i < 100; i++) { if (fs.readFileSync(path.join(out, 'launcher.out'), 'utf8').includes('"origin"')) break; if (launcher.exitCode !== null) break; await delay(200); }
    const origin = `http://localhost:${ports.launcher}`;
    if (!(await fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false))) throw new Error(`launcher did not start: ${fs.readFileSync(path.join(out, 'launcher.err'), 'utf8').slice(-800)}`);

    // 3. the player page starts the world and joins the seed's nation
    browser = await pw.chromium.launch({ headless: true });
    const { w, h } = opts.tile;
    const newView = async (name, label, { follow = true } = {}) => {
      const t0 = Date.now();
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'en-US', recordVideo: { dir: path.join(out, 'views', '.raw'), size: { width: w, height: h } } });
      await ctx.addInitScript(text => {
        addEventListener('DOMContentLoaded', () => { const d = document.createElement('div'); d.textContent = text; d.setAttribute('aria-hidden', 'true');
          d.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483647;pointer-events:none;background:rgba(0,0,0,.72);color:#fff;font:600 13px system-ui;padding:3px 8px;border-radius:4px'; document.documentElement.appendChild(d); });
      }, label);
      // (a nation's view stays on its nation: the spectator's camera-follows-battles switch, the page's own stored
      //  choice `ps-fwatch:v1`, is set off in that view's own isolated storage before the page loads)
      if (!follow) await ctx.addInitScript(() => { try { localStorage.setItem('ps-fwatch:v1', '0'); } catch { /* none */ } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
      const v = { name, label, ctx, page, t0, errors };
      views.push(v); return v;
    };
    const player = await newView('player', `player page — joins ${NATIONS[plan.player]} (TEST local-play wallet)`);
    await player.page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await player.page.getByText('Start a new world', { exact: true }).first().click({ timeout: 30000 });
    log('world starting (the natural runner sets up its Season: up to ~3 min)');
    await player.page.locator('[data-act=intro-close]:visible').first().waitFor({ timeout: 300000 });
    // (the residents place their villages BEFORE the player does: once the player's PlaceHome starts the capture demo,
    //  a later PlaceHome in the player's own nation is refused by the program, TicketState 45 — seen in a smoke run)
    worldDir = fs.readdirSync(data).map(d => path.join(data, d)).find(d => fs.existsSync(path.join(d, 'processes.json')));
    if (!worldDir) throw new Error('no world directory');
    for (const until = Date.now() + 240000; ;) {
      const s = summarize(jsonLines(fs.readFileSync(path.join(worldDir, 'operators.out'), 'utf8')));
      if (s.allSix) break;
      if (Date.now() > until) throw new Error(`the residents did not all place a village in 4 min: ${s.nations.map(n => `${n.name}:${n.village ?? '-'}`).join(' ')}`);
      await delay(2000);
    }
    log('all six residents have a village; the player joins');
    await player.page.locator('[data-act=intro-close]:visible').first().click();
    await player.page.locator(`[data-act=pick-faction][data-f="${plan.player}"]`).first().click({ timeout: 30000 });
    await player.page.locator('[data-act=home-confirm]:not([disabled])').first().click({ timeout: 30000 });
    const herald = `http://localhost:${ports.worlds[0].herald}`;
    // (joined = the public herald shows the player's Citizen and a village: the same read the residents use)
    const playerWallet = JSON.parse(fs.readFileSync(path.join(worldDir, 'processes.json'), 'utf8')).wallet;
    let joined = false;
    for (const until = Date.now() + 180000; !joined && Date.now() < until;) {
      const me = await getJson(`${herald}/h/me/${playerWallet}`).catch(() => null);
      joined = !!me?.citizen && Array.isArray(me.holdings) && me.holdings.length > 0;
      if (!joined) await delay(2000);
    }
    if (!joined) throw new Error('the player page did not join (no Citizen and village on the herald after 3 min)');
    log(`player joined ${NATIONS[plan.player]}`);
    let ready = null;
    for (let i = 0; i < 120 && !ready; i++) { ready = jsonLines(fs.readFileSync(path.join(worldDir, 'operators.out'), 'utf8')).find(l => l.step === 'ready'); if (!ready) await delay(500); }
    if (!ready) throw new Error('operator residents not ready');
    const season = await getJson(`${herald}/h/season`);
    const turnNow = async () => turnOf(await getJson(`${herald}/h/status`).catch(() => null), season);
    const startTurn = await turnNow();
    manifest.world = { dir: path.basename(worldDir), herald, startTurn, playerWallet, residents: ready.residents.map(r => ({ resident: r.resident, nation: r.faction, name: NATIONS[r.faction], wallet: r.wallet })) };

    // 4. the spectator views
    const spectate = `${origin}/frontier/frontier/spectate.html?herald=${encodeURIComponent(herald)}`;
    const overview = await newView('overview', 'spectator — whole world');
    const nationViews = [];
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const r = ready.residents.find(x => x.faction === n);
      nationViews.push(Object.assign(await newView(`nation-${n}-${NATIONS[n].toLowerCase()}`, `${NATIONS[n]} — operator AI resident ${r?.resident ?? '?'}${n === plan.player ? ' (+ player, test participants)' : ''}`, { follow: false }), { nation: n, resident: r }));
    }
    const dash = await newView('summary', 'live summary (operators.out + herald)');
    for (const v of [overview, ...nationViews]) await v.page.goto(spectate, { waitUntil: 'domcontentloaded' });
    await delay(8000);
    const focus = async (v, first = false) => {
      try {
        // (DOM clicks: the page's own delegated handlers; an open keep card may hide the filter from a pointer click.
        //  Escape only once, for the title card: later it would shut the spectator's panel; a shut panel is reopened)
        if (first) await v.page.keyboard.press('Escape').catch(() => {});
        await v.page.evaluate(() => { if (!document.querySelector('[data-act=watch-faction]')?.offsetParent) document.querySelector('[data-act=drawer-open]')?.click(); });
        await delay(500);
        const filtered = await v.page.evaluate(f => { const b = document.querySelector(`[data-act=watch-faction][data-f="${f}"]`); b?.click(); return !!b; }, v.nation);
        if (!filtered) throw new Error('no nation filter on the page');
        await delay(800);
        // (the camera is set ONCE, on the nation's own village; later passes only keep the panel and the filter. A later
        //  "go to" would find the village's highlight scrolled away and pick another nation's place)
        if (!first) return;
        const village = summarize(jsonLines(fs.readFileSync(path.join(worldDir, 'operators.out'), 'utf8'))).nations.find(x => x.nation === v.nation)?.village;
        const [p, q] = village ? village.split(',') : [];
        const went = await v.page.evaluate(([p, q, name]) => {
          const all = [...document.querySelectorAll('#panel [data-act=goto]')];
          const b = all.find(x => p !== undefined && x.dataset.p === p && x.dataset.q === q) ?? all.find(x => x.innerText.includes(` of ${name} `));
          b?.click(); return !!b;
        }, [p, q, NATIONS[v.nation]]);
        if (!went) throw new Error("no place of this nation's village on the panel");
      } catch (e) { v.errors.push(`focus: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`); }
    };
    await overview.page.keyboard.press('Escape').catch(() => {});
    for (const v of nationViews) await focus(v, true);
    await player.page.keyboard.press('Escape').catch(() => {});
    const dashHtml = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#14201d;color:#eee;font:14px system-ui;padding:12px}h1{font-size:17px;margin:0 0 6px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #345;padding:3px 5px;text-align:left}small{color:#9ab}</style><h1>WYLLS — six-nation TEST world</h1><div id="d">starting…</div>`;
    await dash.page.setContent(dashHtml);
    const common = Date.now();
    manifest.recordingStartedAt = new Date(common).toISOString();
    log(`recording 9 views; start turn ${startTurn}`);

    // 5. the run
    const end = common + opts.minutes * 60000;
    let lastFocus = Date.now(), lastSnap = 0, turn = startTurn, snapN = 0;
    while (Date.now() < end) {
      if (launcher.exitCode !== null) throw new Error('the launcher ended');
      turn = (await turnNow()) ?? turn;
      if (opts.turns > 0 && turn !== null && startTurn !== null && turn - startTurn >= opts.turns) { log(`reached ${opts.turns} turns`); break; }
      const sum = summarize(jsonLines(fs.readFileSync(path.join(worldDir, 'operators.out'), 'utf8')));
      const el = Math.floor((Date.now() - common) / 1000);
      const rows = sum.nations.map(n => `<tr><td>${n.name}</td><td>${n.village ?? '—'}</td><td>${['Harvest', 'Build', 'Train', 'Muster'].map(a => n.acts[`${a}:landed`] ?? 0).join(' / ')}</td><td>${n.landed}</td><td>${n.refused + n.failed}</td></tr>`).join('');
      await dash.page.evaluate(html => { document.getElementById('d').innerHTML = html; }, `<p>Turn <b>${turn ?? '?'}</b> (start ${startTurn}) · ${Math.floor(el / 60)}:${String(el % 60).padStart(2, '0')} recorded · clock ×${opts.demoScale} (TEST demo clock) · seed ${opts.seed}</p><table><tr><th>nation</th><th>village</th><th>harvest / build / train / muster</th><th>landed</th><th>refused</th></tr>${rows}</table><p><small>Operator AI residents (⑤ A): fixed offline rule, memory-only TEST keys, same page-signed commands as a person. Player page: ${NATIONS[plan.player]}. Local chain only.</small></p>`).catch(() => {});
      if (Date.now() - lastFocus > 120000) { for (const v of nationViews) await focus(v); lastFocus = Date.now(); }
      if (Date.now() - lastSnap > 300000) {
        snapN++; lastSnap = Date.now();
        for (const v of views) await v.page.screenshot({ path: path.join(out, 'snapshots', `${String(snapN).padStart(2, '0')}-${v.name}.jpg`), type: 'jpeg', quality: 60 }).catch(() => {});
      }
      await delay(5000);
    }
    manifest.endTurn = turn;
    manifest.recordingEndedAt = new Date().toISOString();
    const duration = (Date.now() - common) / 1000;
    // close the views (finalises the videos), then the world
    const tiles = [];
    for (const v of views) {
      const video = v.page.video();
      await v.ctx.close();
      const file = path.join(out, 'views', `${v.name}.webm`);
      fs.renameSync(await video.path(), file);
      tiles.push({ name: v.name, file, rel: `views/${v.name}.webm`, label: v.label, offset: (common - v.t0) / 1000, errors: v.errors });
    }
    views.length = 0;
    fs.rmSync(path.join(out, 'views', '.raw'), { recursive: true, force: true });
    for (const f of ['operators.out', 'operators.json', 'processes.json']) fs.copyFileSync(path.join(worldDir, f), path.join(out, f));
    await cleanup('done');

    // 6. outputs
    const order = ['player', 'overview', 'summary', ...[0, 1, 2, 3, 4, 5].map(n => `nation-${n}-${NATIONS[n].toLowerCase()}`)];
    const grid = order.map(n => tiles.find(t => t.name === n)).filter(Boolean);
    fs.writeFileSync(path.join(out, 'grid.html'), gridHtml(grid, { cols: 3, title: `WYLLS six-nation TEST recording — seed ${opts.seed}` }));
    if (ffmpeg) {
      const gw = Math.floor(w * 0.8 / 2) * 2, gh = Math.floor(h * 0.8 / 2) * 2;
      try { execFileSync(ffmpeg, ffmpegGridArgs(grid, { cols: 3, w: gw, h: gh, out: path.join(out, 'grid.mp4'), duration }), { stdio: 'inherit' }); manifest.grid = { file: 'grid.mp4', cols: 3, tile: `${gw}x${gh}` }; }
      catch (e) { manifest.grid = { error: String(e?.message ?? e).slice(0, 300) }; }
    } else manifest.grid = { file: null, why: opts.grid ? 'ffmpeg not found: grid.html plays the per-view webm files together' : '--no-grid' };
    const lines = jsonLines(fs.readFileSync(path.join(out, 'operators.out'), 'utf8'));
    const sum = summarize(lines);
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(sum, null, 1));
    fs.writeFileSync(path.join(out, 'summary.md'), `# Six-nation TEST run — seed ${opts.seed}\n\n${summaryMarkdown(sum, { turns: `${manifest.world.startTurn} → ${manifest.endTurn}`, 'recorded (s)': duration.toFixed(0), player: NATIONS[plan.player], commit })}`);
    manifest.views = tiles.map(t => ({ name: t.name, file: t.rel, label: t.label, offset_s: Number(t.offset.toFixed(3)), bytes: fs.statSync(t.file).size, sha256: sha256(t.file), errors: t.errors.slice(0, 20) }));
    if (manifest.grid?.file) Object.assign(manifest.grid, { bytes: fs.statSync(path.join(out, 'grid.mp4')).size, sha256: sha256(path.join(out, 'grid.mp4')) });
    manifest.durationSeconds = Number(duration.toFixed(1));
    manifest.allSixNations = sum.allSix;
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
    log(`done: ${out} (all six nations acted: ${sum.allSix}; ports busy after: ${manifest.cleanup.portsBusyAfter.length})`);
    return sum.allSix && manifest.cleanup.portsBusyAfter.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(`sixnation: ${e?.stack ?? e}`);
    await cleanup(`error: ${String(e?.message ?? e).slice(0, 200)}`);
    fs.writeFileSync(path.join(out, 'manifest.failed.json'), JSON.stringify(manifest, null, 1));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
