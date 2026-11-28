// test-gaps-10: PR-CI tests for #311 (the capture demo's fog-fort exception, owner Q-LP29-1 (b)), for what verify-pr311
// checked only in a browser:
//   #12/#13  a kept or wide world, or any launcher without the capture demo, gets the page's demo-fort asks answered
//            404 NotADemo, and the page then STOPS asking (one ask, no fort, nothing named);
//   #1       a capture-demo world: the page asks while the demo has not chosen, stops at ready, and holds the fort;
//            503 / a wrong world / a malformed answer keep it asking (bounded); another wallet stops it;
//   B2       the asks start only on a launcher page whose start answer carried a valid captureDemo;
//   #5       the exception does not reach the order card's forecast: a fogged fort stays OutOfSight (no odds).
// The launcher side is real: WorldManager + createLauncherServer, over HTTP on 127.0.0.1, first free port in
// 41550–41599. Its worlds are stand-ins, with no runner, herald or chain. The page side is the page's own code:
// flocalplay.mjs's `checkDemoFort`, `launcherRefusal`, `LAUNCHER_CODES` and `launcherCaptureDemo`. They are taken from
// its source TEXT and run with stand-ins for the gate's state. flocalplay.mjs is not imported, because its imports
// reach the ephemeral wallet and the key store. fdemofort.mjs (it imports nothing) is imported for demoFortView,
// setDemoFort and startDemoFortAsks.
// THIS FILE MAKES NO KEY: the wallets are fixed base58 strings, and nothing is signed or sent to any chain.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { WorldManager, createLauncherServer, demoFortSummary } from '../src/frontier/local-play-launcher.mjs';
import * as DF from '../../permutation-server/web/frontier/fdemofort.mjs';

afterEach(() => DF.setDemoFort(null));
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const FLP = src('flocalplay.mjs');

/** From `marker` (inclusive) to its matching closing brace: strings, template literals and comments skipped. */
function block(text, marker) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `flocalplay.mjs has ${marker}`);
  assert.equal(text.indexOf(marker, at + 1), -1, `one ${marker}`);
  let i = text.indexOf('{', at + marker.length - 1), depth = 0, quote = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); continue; }
    if (ch === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 1; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) break;
  }
  return text.slice(at, i + 1);
}
const CODES = block(FLP, 'const LAUNCHER_CODES = Object.freeze({') + ');';
const launcherRefusal = new Function(`${CODES}\nconst launcherWorlds = () => [];\n${block(FLP, 'async function launcherRefusal(response) {')}\nreturn launcherRefusal;`)();
const launcherCaptureDemo = new Function(`${block(FLP, 'export function launcherCaptureDemo(v) {').replace(/^export /, '')}\nreturn launcherCaptureDemo;`)();
const CHECK = block(FLP, 'const checkDemoFort = async (wallet, scope) => {');
/** The page's checkDemoFort over stand-ins for the gate's closure (launcher, handle, state, askLauncher, now). */
const makeCheck = env => new Function('launcher', 'handle', 'state', 'askLauncher', 'demoFortView', 'now', `${CHECK};\nreturn checkDemoFort;`)(
  env.launcher, env.handle, env.state, env.askLauncher, DF.demoFortView, env.now);

// the page's askLauncher, as flocalplay.mjs maps an answer (pinned below): ok → body; else launcherRefusal → {launcher, code}
function pageAsk(port, asked) {
  return (route, body, failure) => new Promise((resolve) => {
    asked.push(route);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', agent: false, headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => { d += c; });
      res.on('end', async () => {
        const response = { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(d) };
        if (response.ok) { let answer = null; try { answer = await response.json(); } catch { /* none */ } return resolve({ ok: true, body: answer }); }
        const refusal = await launcherRefusal(response);
        resolve({ ok: false, launcher: refusal.launcher, code: refusal.code === 'LauncherFailed' ? failure : refusal.code });
      });
    });
    req.on('error', () => resolve({ ok: false, launcher: null, code: failure }));
    req.end(JSON.stringify(body));
  });
}

const A = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', C = 'Avexj6jFeyqKwd6V9Y8M7PVSqQEWmFJXAnAroC1wv3FJ';
const EXPIRY = { schema: 'frontier-local-play-world-expiry-v1', startedAt: Date.now(), ttlMs: 2700000, expiresAt: Date.now() + 2700000, instance: 'a'.repeat(64) };
const HERALD = 'http://localhost:41551';
const SCOPE = { herald: HERALD, expiry: EXPIRY };
const READY_LINE = { schema: 'frontier-localnet-capture-demo-v1', demo_step: 'ready', test_only: true, synthetic_clock_scale: 60, test_participants: 38,
  ring: 4, player_nation: 5, provinces_opened: [], refused: [], pair: null, new_ring_reachable: [{ p: -1, q: -3, keep_holder: 4, keep_tile: 58, route_steps: 13, from_tile: 41 }] };
const fakeWorld = over => ({ herald: HERALD, stop: async () => {}, expiry: EXPIRY, keeper: async () => null, ...over });

/** The first port in 41550–41599 a loopback server can bind (bound and released). */
async function freePort() {
  for (let port = 41550; port <= 41599; port++) {
    const probe = http.createServer();
    const ok = await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => resolve(true)); });
    if (ok) { await new Promise(r => probe.close(r)); return port; }
  }
  throw new Error('no free port in 41550–41599');
}

/** A launcher (config) with one started world for A, its HTTP server on 127.0.0.1, and its close. */
async function launcherWith(config, world) {
  const m = new WorldManager(config, async () => fakeWorld(world));
  await m.start(A);
  const port = await freePort();
  const { server } = createLauncherServer({ port, web: '/nonexistent' }, m);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { m, port, close: async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); await m.close(); } };
}

/** The page's asks (fdemofort startDemoFortAsks with checkDemoFort as `ask`), timers run at once; → what happened. */
async function pageAsks(port, { tries = 6, handle = { address: A, destroyed: false }, mutate = null } = {}) {
  const asked = [], sets = [];
  const env = { launcher: true, handle, state: { herald: HERALD }, askLauncher: pageAsk(port, asked), now: () => Date.now() };
  const check = makeCheck(env);
  let timers = 0, scheduled = 0, inflight = 0;
  const stop = DF.startDemoFortAsks({
    ask: async () => { inflight++; try { const v = await check(A, SCOPE); mutate?.(asked.length, env); return v; } finally { inflight--; } },
    set: v => { sets.push(v); DF.setDemoFort(v); },
    timer: fn => { timers++; scheduled++; setImmediate(() => { scheduled--; fn(); }); return timers; }, clear: () => {}, spacingMs: 1, tries,
  });
  // the loop is over when no ask is under way and none is scheduled (startDemoFortAsks schedules right after an answer)
  for (let idle = 0; idle < 3;) { await new Promise(r => setTimeout(r, 2)); idle = inflight === 0 && scheduled === 0 ? idle + 1 : 0; }
  stop();
  return { asked, sets, timers };
}

test('#311 launcher ↔ page: a world that is not a capture demo (plain, wide, kept) answers 404 NotADemo and the page stops after ONE ask (verify-pr311 #12/#13)', async () => {
  for (const config of [{}, { wideLand: true }, { persist: true }, { coexist: true }]) {
    const l = await launcherWith(config, {});
    try {
      const r = await pageAsks(l.port);
      assert.equal(r.asked.length, 1, `${JSON.stringify(config)}: one ask`);
      assert.deepEqual(r.asked, ['/local-play/demo-fort']);
      assert.equal(r.timers, 0, 'no further ask scheduled');
      assert.deepEqual(r.sets, []); assert.equal(DF.demoFortNow(), null, 'no fort: the guide and the keep list read viewKeeps exactly');
      // what the page read from the refusal
      const asked = [];
      assert.deepEqual(await pageAsk(l.port, asked)('/local-play/demo-fort', { wallet: A }, 'LauncherDemoFortFailed'), { ok: false, launcher: 'NotADemo', code: 'LauncherDemoFortFailed' });
    } finally { await l.close(); }
  }
});

test('#311 launcher ↔ page: a capture demo — pending asks again, ready sets the fort and stops; the page holds exactly the launcher\'s fort (verify-pr311 #1)', async () => {
  let reads = 0;
  const l = await launcherWith({ captureDemo: { scale: 60 } }, { captureDemo: { scale: 60 }, demoFort: async () => demoFortSummary(++reads < 3 ? [] : [READY_LINE]) });
  try {
    const r = await pageAsks(l.port);
    assert.equal(r.asked.length, 3, 'pending, pending, ready');
    assert.equal(r.sets.length, 1);
    assert.deepEqual(DF.demoFortNow(), { p: -1, q: -3, tile: 58, holder: 4 });
    assert.ok(Object.isFrozen(DF.demoFortNow()));
  } finally { await l.close(); }
});

test('#311 launcher ↔ page: 503 (no answer yet), an invalid ready line, or another world\'s herald keep the page asking, bounded; nothing is set', async () => {
  const worlds = [
    ['reader answers nothing → 503 DemoFortUnavailable', { demoFort: async () => null }],
    ['the demo\'s ready line is invalid (the player\'s own nation)', { demoFort: async () => demoFortSummary([{ ...READY_LINE, player_nation: 4 }]) }],
    ['another herald than the one this page verified', { herald: 'http://localhost:41552', demoFort: async () => demoFortSummary([READY_LINE]) }],
  ];
  for (const [what, w] of worlds) {
    const l = await launcherWith({ captureDemo: { scale: 60 } }, { captureDemo: { scale: 60 }, ...w });
    try {
      const one = await pageAsk(l.port, [])('/local-play/demo-fort', { wallet: A }, 'LauncherDemoFortFailed');
      if (w.demoFort.toString().includes('null')) assert.deepEqual(one, { ok: false, launcher: 'DemoFortUnavailable', code: 'LauncherDemoFortFailed' }, what);
      else { assert.equal(one.ok, true, what); assert.deepEqual(DF.demoFortView(one.body, SCOPE, Date.now()), { state: 'unavailable' }, what); }
      const r = await pageAsks(l.port, { tries: 4 });
      assert.equal(r.asked.length, 4, `${what}: asked until the last try`);
      assert.deepEqual(r.sets, [], what); assert.equal(DF.demoFortNow(), null, what);
    } finally { await l.close(); }
  }
});

test('#311 launcher ↔ page: another address (WorldNotFound) stops at once; a page that changed wallet or lost its key stops without asking', async () => {
  const l = await launcherWith({ captureDemo: { scale: 60 } }, { captureDemo: { scale: 60 }, demoFort: async () => demoFortSummary([]) });
  try {
    const asked = [];
    const check = makeCheck({ launcher: true, handle: { address: C, destroyed: false }, state: { herald: HERALD }, askLauncher: pageAsk(l.port, asked), now: () => Date.now() });
    assert.deepEqual(await check(C, SCOPE), { state: 'stop' }, 'the launcher has no world for C');
    assert.equal(asked.length, 1);
    // the page's wallet changes after the first (pending) ask: the next ask stops without a request
    const r = await pageAsks(l.port, { mutate: (n, env) => { if (n === 1) env.handle.address = C; } });
    assert.equal(r.asked.length, 1);
    const gone = await pageAsks(l.port, { handle: { address: A, destroyed: true } });
    assert.equal(gone.asked.length, 0, 'a destroyed key: no request at all');
    const notLauncher = [];
    assert.deepEqual(await makeCheck({ launcher: false, handle: { address: A }, state: { herald: HERALD }, askLauncher: pageAsk(l.port, notLauncher), now: Date.now })(A, SCOPE), { state: 'stop' });
    assert.equal(notLauncher.length, 0, 'not a launcher page: never asks');
  } finally { await l.close(); }
});

test('#311 gate (verify-pr311 B2): the asks start only on a launcher page whose start answer carried a valid captureDemo; the page\'s ask mapping is as run above', () => {
  assert.equal(launcherCaptureDemo({ scale: 60 }), 60);
  assert.equal(launcherCaptureDemo({ scale: 10 }), 10);
  for (const v of [undefined, null, {}, { scale: 9 }, { scale: 61 }, { scale: 60, extra: 1 }, { scale: '60' }, [60]]) assert.equal(launcherCaptureDemo(v), null, JSON.stringify(v));
  assert.match(FLP, /claimedDemo = launcherCaptureDemo\(body\?\.captureDemo\);\n\s+if \(\(claimedDemo !== null\) !== demoPage \|\| \(body\?\.captureDemo !== undefined && claimedDemo === null\)\) return \{ ok: false, code: 'LauncherWorldMismatch' \};/);
  const starts = [...FLP.matchAll(/startDemoFortAsks\(/g)].length;
  assert.equal(starts, 1, 'one start of the asks');
  assert.match(FLP, /if \(launcher && claimedDemo !== null\) \{ const asked = handle\.address; startDemoFortAsks\(\{ ask: \(\) => checkDemoFort\(asked, \{ herald: base, expiry: claimedEnd \}\), set: setDemoFort \}\); \}/);
  // the page's askLauncher maps a refusal as pageAsk does above
  assert.match(FLP, /const refusal = await launcherRefusal\(response\);\n\s+return \{ ok: false, launcher: refusal\.launcher, code: refusal\.code === 'LauncherFailed' \? failure : refusal\.code \};/);
  assert.match(FLP, /if \(response\?\.ok\) \{ let answer = null; try \{ answer = await response\.json\(\); \} catch \{ \/\* no body \*\/ \} return \{ ok: true, body: answer \}; \}/);
});

test('#311 scope: only the guide, the keep list and their reach read the exception; the order card\'s forecast stays OutOfSight under the fog (verify-pr311 #5)', () => {
  const walk = (dir, rel = '') => readdirSync(new URL(dir, WEB), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}${e.name}/`, `${rel}${e.name}/`) : e.name.endsWith('.mjs') ? [`${rel}${e.name}`] : []);
  const files = walk('./');
  const users = files.filter(f => f !== 'fdemofort.mjs' && /fdemofort\.mjs|guideKeeps|demoFortNow|isDemoFort|demoFort\b/.test(src(f))).sort();
  assert.deepEqual(users, ['controller.mjs', 'flocalplay.mjs', 'hud/keephand.mjs', 'map/fog.mjs', 'screens/conquestguide.mjs']);
  const ctl = src('controller.mjs');
  const calls = [...ctl.matchAll(/guideKeeps\(/g)].map(m => ctl.slice(ctl.lastIndexOf('\nexport function ', m.index), m.index).match(/^\nexport function (\w+)/)[1]);
  assert.deepEqual(calls, ['wantKeepReach', 'wantHostReach'], 'controller.mjs: the two reach lists only');
  // the forecast's sight rule is the survey's alone (app.mjs updateForecast): no demo exception, no guideKeeps
  const app = src('app.mjs');
  const fc = app.slice(app.indexOf('function updateForecast('), app.indexOf('function updateForecast(') + 4000);
  assert.match(fc, /if \(FS\.survey && !FS\.survey\.showAll && FS\.survey\.levelOf\(c\.dest\.p, c\.dest\.q, c\.dest\.tile\) < 3\) \{\n\s+c\.forecast = \{ key, ok: false, why: 'OutOfSight' \};/);
  assert.match(src('hud/marchcard.mjs'), /fc\?\.why === 'OutOfSight' \? cell\(/, 'the card says no forecast for an unseen place');
});
