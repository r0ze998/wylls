// The first-play guide with TWO villages, through the real page (2026-11-16; branch claude/first-session-resume-20261116,
// commits 69d288ef…4567130d). FIXTURE REPLAY on the keyless fixture (server.mjs), English at 1440 × 900; not a world.
// Test-only, IN THIS PAGE'S MEMORY (as conquest-press.screen.mjs and Lane A's first-session test do): a conquest
// season (FS.sample false, programVersion 3), the viewer's fixture village as village A, and a second, empty village B
// in the same province (its envelope is the one already read). Each case sets A's state itself, so it does not rest
// on the fixture's own hosts. Cases, with B open:
//   1. A has 200 Spearmen in reserve, no host: the guide's pill names A for "Form a host"; pressed, A is open with its
//      Form-a-host card.
//   2. A has a ready host: the pill is that host's forts card; pressed, A is open, the host in hand, its forts card up.
//   3. One village only (B removed): the pill names no village, as before; pressed, the open village stays.
// Nothing is pressed that sends: the pill opens cards only. The page's poll may re-read the records (30 s idle); each
// case runs well inside that.
//
// Safety, by construction (the setup of land-redraw.screen.mjs, run there 2026-11-16, unchanged):
// - Origin: http://127.0.0.1 (a secure context natively, asserted) with `devWallet=off`; NO
//   `--unsafely-treat-insecure-origin-as-secure`, no TLS, no proxy; `localPlay` is not asked for.
// - Keys: the keyless viewer; ws07/nokey-page.mjs `prepare` and `assertKeyless` unchanged.
// - Network, decided BEFORE anything is sent: Chromium resolves no host name (loopback IP excepted); a gate route,
//   registered last so it runs first, passes only the fixture's exact protocol/host/port with GET or HEAD; anything
//   else is recorded and aborted before it is sent (so nokey-page's Node-side session.mjs route only sees the fixture's
//   own file). Service workers and the seal worker are refused.
// - Storage: Playwright's non-persistent context; the profile on disk is scanned for the page's storage keys.
// - Disk: Chromium's profile and artifacts in FIRST_GUIDE_TMP (absolute, existing, EMPTY); more than 22 GiB free before
//   launch; a monitor every second closes this test's own context/browser/server (once each, no signals) and fails the
//   test at ≤ 22 GiB free or a profile over 300 MiB — per-interval checks, not hard limits; Playwright's own removal
//   of its folders checked after close.
// - Sound: `--mute-audio`; chromiumSandbox true.
// Run alone, from this folder: FIRST_GUIDE_TMP=<empty absolute folder> node --test first-guide-villages.screen.mjs
// Its guard is first-guide-safety.mjs (pure, fail-closed; tested with fake handles in test/web-frontier-first-guide-safety.test.mjs).
// STATUS: written 2026-11-16, NOT RUN (needs the owner's go-ahead).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { statfsSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createGuard, walkFiles, totalSize, scanStorage, waitUntil, runPhases, summarize, verdict } from './first-guide-safety.mjs';

const TMP = process.env.FIRST_GUIDE_TMP ?? '';
const FREE_MIN = 22 * 2 ** 30, PROFILE_MAX = 300 * 2 ** 20, MONITOR_MS = 1000;
const STORED = ['ps-wallet', 'ps-lang', 'ps-fintro', 'ws07:keyUses'];

// the real disk, handed to the pure guard (first-guide-safety.mjs: fail-closed; a gone file adds nothing)
const DISK = { list: dir => readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, dir: e.isDirectory() })), join, size: f => statSync(f).size, read: f => readFileSync(f) };
const freeBytes = () => { const s = statfsSync(TMP); return Number(s.bavail) * Number(s.bsize); };
const profiles = () => readdirSync(TMP).filter(n => n.startsWith('playwright'));   // (playwright_chromiumdev_profile-*, playwright-artifacts-*)
const profileFiles = () => profiles().flatMap(n => walkFiles(join(TMP, n), DISK));
const profileBytes = () => totalSize(profileFiles(), DISK);
function guardDisk() {
  assert.ok(isAbsolute(TMP) && existsSync(TMP), 'FIRST_GUIDE_TMP: an absolute folder that exists');
  assert.deepEqual(readdirSync(TMP), [], 'FIRST_GUIDE_TMP is empty');
  const free = freeBytes();
  assert.ok(Number.isFinite(free) && free > FREE_MIN, `more than 22 GiB free before launch (have ${(free / 2 ** 30).toFixed(2)} GiB)`);
  process.env.TMPDIR = TMP;   // (os.tmpdir() reads it at each call: Playwright's profile and artifacts land here)
}

guardDisk();
const { chromium } = await import('playwright-core');
const { startServer } = await import('./server.mjs');
const NK = await import('./ws07/nokey-page.mjs');
const { LATEST_UNIX, HOME } = await import('./world.mjs');

// this test's own context, browser and server, each adopted through the guard: closed once; one that arrives after a
// trip is closed at once (first-guide-safety.mjs)
const guard = createGuard({ freeBytes, profileBytes, freeMin: FREE_MIN, profileMax: PROFILE_MAX, every: MONITOR_MS, timers: { setInterval, clearInterval } });
let srv = null, browser = null, ctx = null, base = null, origin = null;
const closeAll = () => guard.closeAll();

before(async () => {
  guard.start();
  srv = await guard.adopt('srv', startServer({ keyless: true }));
  srv.stage('holding');
  base = srv.url;   // http://127.0.0.1:<port>
  origin = new URL(base);
  browser = await guard.adopt('browser', chromium.launch({ channel: 'chromium', chromiumSandbox: true, args: ['--mute-audio', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] }));
});
after(async () => { await closeAll(); });


const settle = page => page.waitForTimeout(400);
// (what the page asked for and threw, kept outside openPage so the audit can read them even when the opening failed)
const seen = { blocked: [], posts: [], errors: [] };
let page = null;
const READY_MS = 20_000, READY_EVERY = 250;
async function openPage() {
  ctx = await guard.adopt('ctx', browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB', timezoneId: 'UTC', serviceWorkers: 'block' }));
  await NK.prepare(ctx, srv.viewer, { lang: 'en' });
  await ctx.route('**/seal-worker.mjs', route => route.abort('blockedbyclient'));
  await ctx.route(() => true, route => {
    const r = route.request(), u = new URL(r.url()), m = r.method();
    if (u.protocol === origin.protocol && u.hostname === origin.hostname && u.port === origin.port && (m === 'GET' || m === 'HEAD')) return route.fallback();
    (m === 'GET' || m === 'HEAD' ? seen.blocked : seen.posts).push(`${m} ${u.protocol}//${u.host}${u.pathname}`);
    return route.abort('blockedbyclient');
  });
  page = await ctx.newPage();
  page.on('pageerror', e => seen.errors.push(e.message));
  await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
  await page.goto(`${base}/frontier/index.html?devWallet=off&at=${HOME.p},${HOME.q},${HOME.tile},1.0`);
  assert.equal(await page.evaluate(() => isSecureContext && !!crypto.subtle), true, 'native secure 127.0.0.1, no insecure-origin override');
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
  await page.locator('#frontier-map').waitFor();
}
// (4d12e851: the first run touched the home province before the page had read it) the viewer's village and that
// village's province are in the page — bounded, polled; a page that never gets there fails with the reason
const readiness = () => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  const h = FS.holdings?.[0];
  if (!h) return { ok: false, why: 'no village of the viewer in the page yet' };
  const env = FS.provinces?.get?.(`${h.p},${h.q}`);
  return env?.province ? { ok: true } : { ok: false, why: `the province ${h.p},${h.q} of the viewer's village is not read yet` };
});
const ready = () => waitUntil(readiness, { timeoutMs: READY_MS, everyMs: READY_EVERY, sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now(), what: 'ready (the home province read)' });

// the page's own state, test-only: a conquest season, A = the viewer's village (with `a`), B = an empty second village
// in A's province (when `two`), B open; A's hosts are the fixture's removed and, with `host`, one ready host given
const scene = (page, { a = {}, host = false, two = true }) => page.evaluate(async ({ a, host, two }) => {
  const { FS, invalidate } = await import('/frontier/fstate.mjs');
  const { hostId } = await import('/frontier/faddr.mjs');
  const { hostOfHolding } = await import('/frontier/fland.mjs');
  const now = BigInt(Math.floor(FS.chain?.now?.() ?? 0));
  FS.sample = false; FS.season = { ...FS.season, programVersion: 3, conquestParams: { keepBells: 72 } };
  FS.conquest = { status: 'ready', keeps: new Map(), history: new Map(), events: [], standings: null, final: null };
  FS.ui = { ...(FS.ui ?? {}), guide: 'all', dismissed: [] }; FS.guideOpen = false; FS.compose = null; FS.hand = null; FS.selected = null;
  const A0 = FS.holdings[0];
  const A = { ...A0, ...a, reserve: a.reserve ?? Array(8).fill(0) };
  const key = `${A.p},${A.q}`, env = FS.provinces.get(key);
  if (!env?.province) throw new Error(`the home province ${key} is not read yet`);
  const others = (env.province.entries ?? []).map(e => (e.state >= 1 && e.state <= 3 && hostOfHolding(e.id, A) ? { ...e, state: 0 } : e));
  const id = hostId({ p: A.p, q: A.q, site: A.site, gen: A.gen, seq: 9 });
  const entries = host ? [...others, { ...(others.find(e => e.state === 0) ?? {}), id, unit: 0, state: 1, tile: A.tile, troops: 300000, staminaValue: 120, staminaBell: 0, readyBell: 0, pendOp: 0, fromBell: 1, faction: A.faction }] : others;
  FS.provinces.set(key, { ...env, province: { ...env.province, entries } });
  const free = (env.province.siteMirror ?? []).findIndex((m, i) => i !== A.site && (!m || m.state === 0));
  const B = { ...A, site: free >= 0 ? free : (A.site + 1) % 12, tile: (A.tile + 7) % 61, reserve: Array(8).fill(0), queue: [], production: A.production,
    stores: (A.stores ?? []).map(s => ({ ...s, value: 0n, t0: now })) };
  FS.holdings = two ? [A, B] : [A]; FS.activeHolding = two ? 1 : 0;
  invalidate('all');
  return { a: { p: A.p, q: A.q, site: A.site, tile: A.tile }, host: host ? String(id) : null };
}, { a, host, two });
const pill = page => page.evaluate(() => { const b = document.getElementById('attn-pill'); return b && !b.hidden ? { ...b.dataset } : null; });
const after_ = page => page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return { active: FS.activeHolding, pop: FS.hand?.pop ?? null, host: FS.hand?.host ?? null, sel: FS.selected ? { p: FS.selected.p, q: FS.selected.q, idx: FS.selected.idx } : null }; });

// the main run's phases (first-guide-safety.mjs runPhases): open → ready → cases; the audit ALWAYS, whatever failed before
let MAIN = null;
async function cases() {
  // 1. A trained, no host; B open
  const reserve = Array(8).fill(0); reserve[0] = 200;
  let s = await scene(page, { a: { reserve } }); await settle(page);
  let d = await pill(page);
  assert.deepEqual(d && { act: d.act, pop: d.pop, p: d.p, q: d.q, site: d.site }, { act: 'cg-go', pop: 'muster', p: String(s.a.p), q: String(s.a.q), site: String(s.a.site) }, JSON.stringify(d));
  await page.locator('#attn-pill').click(); await settle(page);
  let r = await after_(page);
  assert.deepEqual([r.active, r.pop, r.sel?.idx], [0, 'muster', s.a.tile], JSON.stringify(r));
  // 2. A has a ready host; B open
  s = await scene(page, { host: true }); await settle(page);
  d = await pill(page);
  assert.deepEqual(d && { act: d.act, pop: d.pop, host: d.host }, { act: 'cg-go', pop: 'keeps', host: s.host }, JSON.stringify(d));
  await page.locator('#attn-pill').click(); await settle(page);
  r = await after_(page);
  assert.deepEqual([r.active, r.pop, r.host], [0, 'keeps', s.host], JSON.stringify(r));
  // 3. one village: nothing named, the open village stays
  s = await scene(page, { a: { reserve }, two: false }); await settle(page);
  d = await pill(page);
  assert.ok(d && d.act === 'cg-go' && d.pop === 'muster' && d.p === undefined, JSON.stringify(d));
  await page.locator('#attn-pill').click(); await settle(page);
  r = await after_(page);
  assert.deepEqual([r.active, r.pop], [0, 'muster'], JSON.stringify(r));
}
// the safety audit: traffic, page errors, keys and storage, the profile — every check runs and every failure is kept
async function audit() {
  const fails = [];
  const check = (name, fn) => { try { fn(); } catch (e) { fails.push(`${name}: ${e?.message ?? e}`); } };
  check('monitor', () => assert.equal(guard.state().tripped, null, 'the monitor tripped'));
  check('requests', () => assert.deepEqual(seen.posts, [], 'a request other than GET or HEAD was asked for (aborted before it was sent)'));
  check('origins', () => assert.deepEqual([...new Set(seen.blocked)], [], 'a request to another origin was asked for (aborted before it was sent)'));
  check('page errors', () => assert.deepEqual(seen.errors, []));
  if (!ctx) fails.push('keys/storage: the browser context never opened — key use and stored seeds are unchecked');
  else { try { await NK.assertKeyless(ctx, assert); } catch (e) { fails.push(`keys/storage: ${e?.message ?? e}`); } }
  try {
    const files = profileFiles();
    const size = totalSize(files, DISK);
    check('profile size', () => assert.ok(size <= PROFILE_MAX, `the temporary profile passed 300 MiB (${(size / 2 ** 20).toFixed(1)} MiB)`));
    const scan = scanStorage(files, STORED, DISK);
    check('profile read', () => assert.deepEqual(scan.unreadable, [], 'a profile file could not be read'));
    check('profile storage', () => assert.deepEqual(scan.leaked, [], 'page storage was found in the profile on disk'));
  } catch (e) { fails.push(`profile: could not be read — ${e?.code ?? e?.message ?? e}`); }
  if (fails.length) throw new Error(fails.join(' | '));
}

test('the first-play guide with two villages: the pill names the village or host that can act, and pressing it opens there (fixture replay)', { timeout: 150_000 }, async () => {
  MAIN = await runPhases([
    { name: 'open', run: openPage },
    { name: 'ready', run: ready },
    { name: 'cases', run: cases },
    { name: 'audit', run: audit, always: true },
  ]);
  const sum = summarize(MAIN);
  console.log(`# phases: ${MAIN.map(r => `${r.name}=${r.ok === null ? 'skipped' : r.ok ? 'ok' : 'FAILED'}`).join(' ')}`);
  if (guard.state().tripped) await closeAll();
  assert.ok(sum.ok, sum.failures.join('\n') || `skipped: ${sum.skipped.join(', ')}`);
});

test('cleanup: this test\'s own context, browser and server closed once and cleanly; Playwright removed its temporary profile and artifacts; and the safety audit passed', async () => {
  await closeAll();
  const st = guard.state();
  console.log(`# monitor: tripped=${st.tripped ?? 'no'}; profile peak ${(st.peak.profile / 2 ** 20).toFixed(1)} MiB; free low ${(st.peak.freeLow / 2 ** 30).toFixed(2)} GiB (sampled every ${MONITOR_MS} ms)`);
  let leftovers;
  try { leftovers = profiles(); } catch (e) { leftovers = [`(the temp folder could not be read: ${e?.code ?? e?.message})`]; }
  const v = verdict({ state: st, leftovers, main: MAIN });
  assert.deepEqual(v, [], v.join('\n'));
});
