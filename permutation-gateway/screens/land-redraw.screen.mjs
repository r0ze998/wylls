// Lane C G2 (2026-11-16): with REDUCED MOTION the board has no breathing frames (map/fmap.mjs invalidateSoon only while
// !still), and local play's sync reads redraw only the panel. A land record changed that way must still reach the
// board (app.mjs renderHudTick → landRevision → map redraw), not only the land chip. FIXTURE REPLAY on the keyless
// fixture (server.mjs), English at 1440 × 900; not a world.
//
// Safety, by construction (nothing below is relaxed for the test):
// - Origin: the page is opened on http://127.0.0.1 — a secure context natively (asserted) — with `devWallet=off`
//   (frontier/config.mjs: an opt-out only), so no dev wallet, no key. NO `--unsafely-treat-insecure-origin-as-secure`,
//   no TLS, no proxy. `localPlay` is not asked for (flocalplay.mjs needs `localPlay=1`).
// - Keys: the keyless viewer and ws07/nokey-page.mjs `prepare` unchanged (WebCrypto key operations and session.mjs key
//   functions refuse and are counted; the test wallet signs nothing); `assertKeyless` before close.
// - Network, decided BEFORE anything is sent: Chromium resolves no host name at all (`--host-resolver-rules`, the
//   loopback IP excepted), and a gate route — registered LAST, so Playwright runs it FIRST — lets through only requests
//   whose protocol, host and port are exactly the fixture server's (`srv.url`) and whose method is GET or HEAD; anything
//   else is recorded and aborted before it is sent. (nokey-page.mjs `prepare`'s session.mjs route fetches from Node,
//   past Chromium's resolver: the gate runs before it, so it only ever sees the fixture's own session.mjs.) Service
//   workers and the seal worker are refused.
// - Storage: the browser context is Playwright's non-persistent one; the page's localStorage (language, title seen,
//   the test wallet's name, the key-use log) lives in it and goes with it. Checked: the profile folder holds none of
//   those keys before close.
// - Disk: Chromium's temporary profile and artifacts go to LAND_REDRAW_TMP (an absolute, existing, EMPTY folder you
//   name). Before launch the volume must have MORE than 22 GiB free. While running, a monitor checks every second; if
//   the free space falls to 22 GiB or below, or the profile passes 300 MiB, it closes this test's own context, browser
//   and server (each once; no signal to any process) and the test fails. These are checks every MONITOR_MS, not hard
//   limits: up to one interval's writing can pass them before the close. After close, Playwright's own removal of what
//   it made is checked (nothing else is deleted).
// - Sound: `--mute-audio` (the page sounds only after a gesture; none is made).
// Run alone, from this folder: LAND_REDRAW_TMP=<empty absolute folder> node --test land-redraw.screen.mjs
// STATUS: run once 2026-11-16 on the owner's go-ahead, with the fix (integration e84049ed): 2/2. The control run on the
//   unchanged app.mjs has NOT been made, so this does not yet show that the old page failed the same check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { statfsSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const TMP = process.env.LAND_REDRAW_TMP ?? '';
const FREE_MIN = 22 * 2 ** 30, PROFILE_MAX = 300 * 2 ** 20, MONITOR_MS = 1000;
const STORED = ['ps-wallet', 'ps-lang', 'ps-fintro', 'ws07:keyUses'];

const freeBytes = () => { const s = statfsSync(TMP); return Number(s.bavail) * Number(s.bsize); };
function guardDisk() {
  assert.ok(isAbsolute(TMP) && existsSync(TMP), 'LAND_REDRAW_TMP: an absolute folder that exists');
  assert.deepEqual(readdirSync(TMP), [], 'LAND_REDRAW_TMP is empty');
  const free = freeBytes();
  assert.ok(free > FREE_MIN, `more than 22 GiB free before launch (have ${(free / 2 ** 30).toFixed(2)} GiB)`);
  process.env.TMPDIR = TMP;   // (os.tmpdir() reads it at each call: Playwright's profile and artifacts land here)
}
const walk = dir => { try { return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])); } catch { return []; } };
const profiles = () => readdirSync(TMP).filter(n => n.startsWith('playwright'));   // (playwright_chromiumdev_profile-*, playwright-artifacts-*)
const profileBytes = () => profiles().flatMap(n => walk(join(TMP, n))).reduce((a, f) => { try { return a + statSync(f).size; } catch { return a; } }, 0);

guardDisk();
const { chromium } = await import('playwright-core');
const { startServer } = await import('./server.mjs');
const NK = await import('./ws07/nokey-page.mjs');
const { LATEST_UNIX, HOME } = await import('./world.mjs');

let srv = null, browser = null, ctx = null, base = null, origin = null, monitor = null, tripped = null, peak = { profile: 0, freeLow: Infinity };
// (each of this test's own handles is closed at most once, whoever asks first; nothing outside them is touched)
let closing = null;
const closeAll = () => (closing ??= (async () => {
  if (monitor) { clearInterval(monitor); monitor = null; }
  const c = ctx, b = browser, s = srv; ctx = null; browser = null; srv = null;
  await c?.close().catch(() => {}); await b?.close().catch(() => {}); await s?.close().catch(() => {});
})());
function watch() {
  monitor = setInterval(() => {
    if (tripped) return;
    let free = Infinity, prof = 0;
    try { free = freeBytes(); } catch { /* unread: no trip */ }
    prof = profileBytes();
    peak = { profile: Math.max(peak.profile, prof), freeLow: Math.min(peak.freeLow, free) };
    if (free <= FREE_MIN) tripped = `free space ${(free / 2 ** 30).toFixed(2)} GiB ≤ 22 GiB`;
    else if (prof > PROFILE_MAX) tripped = `profile ${(prof / 2 ** 20).toFixed(1)} MiB > 300 MiB`;
    if (tripped) closeAll();
  }, MONITOR_MS);
  monitor.unref?.();
}

before(async () => {
  srv = await startServer({ keyless: true });
  srv.stage('holding');
  base = srv.url;   // http://127.0.0.1:<port>
  origin = new URL(base);
  watch();
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true, args: ['--mute-audio', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
});
after(async () => { await closeAll(); });

test('reduced motion: a land record changed with a panel-only redraw reaches the board, as the chip (fixture replay)', { timeout: 150_000 }, async () => {
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB', timezoneId: 'UTC', serviceWorkers: 'block', reducedMotion: 'reduce' });
  const blocked = [], posts = [], errors = [];
  try {
    await NK.prepare(ctx, srv.viewer, { lang: 'en' });
    await ctx.route('**/seal-worker.mjs', route => route.abort('blockedbyclient'));
    // the gate, registered last (run first): the fixture's exact origin, GET or HEAD only — else recorded and aborted
    await ctx.route(() => true, route => {
      const r = route.request(), u = new URL(r.url()), m = r.method();
      if (u.protocol === origin.protocol && u.hostname === origin.hostname && u.port === origin.port && (m === 'GET' || m === 'HEAD')) return route.fallback();
      (m === 'GET' || m === 'HEAD' ? blocked : posts).push(`${m} ${u.protocol}//${u.host}${u.pathname}`);
      return route.abort('blockedbyclient');
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
    await page.goto(`${base}/frontier/index.html?devWallet=off&at=${HOME.p},${HOME.q},${HOME.tile},1.0`);
    assert.equal(await page.evaluate(() => isSecureContext && !!crypto.subtle), true, 'native secure 127.0.0.1, no insecure-origin override');
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
    await page.locator('#frontier-map[data-lod="tile"]').waitFor();
    await page.evaluate(async () => {
      const { FrontierMap } = await import('/frontier/map/fmap.mjs');
      const P = FrontierMap.prototype, draw = P.draw;
      P.draw = function (...a) { window.__map = this; return draw.apply(this, a); };
      for (let i = 0; i < 80 && !window.__map; i++) { window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 50)); }
    });
    await page.waitForTimeout(1500);

    // an open tile of the home province, 2–3 hexes from the village, in sight (as land-arrival.screen.mjs A)
    const tiles = await page.evaluate(async ([p, q, from]) => {
      const { tileHex } = await import('/frontier/fgeo.mjs');
      const { kernel } = await import('/frontier/wasm.mjs');
      const { FS } = await import('/frontier/fstate.mjs');
      const { keepFromProvince } = await import('/frontier/fconquest.mjs');
      const k = await kernel();
      const seed = FS.record.rings.find(r => r.d === 2).seed;
      const g = k.call('generate_province', { ring_seed: Uint8Array.from(seed.match(/../g), x => parseInt(x, 16)), p, q }).value;
      const h0 = tileHex(p, q, from), hexes = i => { const h = tileHex(p, q, i), dq = h.q - h0.q, dr = h.r - h0.r; return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2; };
      const pv = FS.provinces.get(`${p},${q}`)?.province;
      let keep = null; try { keep = keepFromProvince(pv)?.tile ?? null; } catch { keep = null; }
      const sites = new Set((pv?.siteMirror ?? []).filter(x => x && x.state !== 0 && Number.isInteger(x.tile)).map(x => x.tile));
      const out = [];
      for (let i = 1; i < 61; i++) if (i !== keep && !sites.has(i) && hexes(i) >= 2 && hexes(i) <= 3 && ((BigInt(g.passableMask) >> BigInt(i)) & 1n)) out.push(i);
      return out;
    }, [HOME.p, HOME.q, HOME.tile]);
    const pointOf = at => page.evaluate(async at => {
      const { tileHex } = await import('/frontier/fgeo.mjs');
      const { project } = await import('/map.mjs');
      const h = tileHex(at.p, at.q, at.tile), c = project(h.q, h.r), s = window.__map.project(c.x, c.y);
      return { ...s, canvas: document.elementFromPoint(s.x, s.y)?.tagName === 'CANVAS' };
    }, at);
    let T = null;
    for (const t of tiles) { const q = await pointOf({ p: HOME.p, q: HOME.q, tile: t }); if (q.canvas && q.x > 200 && q.x < 1240 && q.y > 160 && q.y < 760) { T = t; break; } }
    assert.ok(T !== null, 'a passable tile in sight');
    const pts = await page.evaluate(async at => {
      const { tileHex } = await import('/frontier/fgeo.mjs');
      const { project, RADIUS } = await import('/map.mjs');
      const h = tileHex(at.p, at.q, at.tile), c = project(h.q, h.r), m = window.__map;
      return [[0, 0], ...[0, 1, 2, 3, 4, 5].map(k => [Math.cos(k * Math.PI / 3) * RADIUS * 0.45, Math.sin(k * Math.PI / 3) * RADIUS * 0.45])].map(([dx, dy]) => m.project(c.x + dx, c.y + dy));
    }, { p: HOME.p, q: HOME.q, tile: T });
    const sample = () => page.evaluate(P => P.flatMap(({ x, y }, k) => [...document.querySelectorAll('canvas')].map((cv, i) => {
      const b = cv.getBoundingClientRect();
      if (!b.width || x < b.left || x > b.right || y < b.top || y > b.bottom) return null;
      let g = null; try { g = cv.getContext('2d', { willReadFrequently: true }); } catch {} if (!g) return null;
      const cx = Math.round((x - b.left) * cv.width / b.width), cy = Math.round((y - b.top) * cv.height / b.height);
      const d = g.getImageData(cx - 3, cy - 3, 7, 7).data, s = [0, 0, 0, 0];
      for (let k = 0; k < d.length; k += 4) for (let j = 0; j < 4; j++) s[j] += d[k + j];
      return { i: `${k}:${i}`, rgba: s.map(v => v / 49) };
    }).filter(Boolean)), pts);
    const differs = (a, b) => a.some(x => { const y = b.find(z => z.i === x.i); return y && Math.hypot(...[0, 1, 2].map(j => x.rgba[j] - y.rgba[j])) > 2; });

    const bare = await sample();
    // the land record changed as local play's sync reads change it: the province replaced, ONLY the panel invalidated
    const set = await page.evaluate(async ([p, q, T]) => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const { LAND, parseLand } = await import('/frontier/land.mjs');
      const { toBase64 } = await import('/sdk/bytes.mjs');
      const me = FS.citizen?.faction;
      const b = new Uint8Array(LAND.SIZE), dv = new DataView(b.buffer);
      b.set([...LAND.MAGIC].map(c => c.charCodeAt(0)), 0);
      dv.setUint16(LAND.VERSION, 1, true); dv.setUint32(LAND.NEXT_BELL, (FS.nowBell ?? 0) + 1, true);
      dv.setInt16(LAND.P, p, true); dv.setInt16(LAND.Q, q, true);
      b.fill(255, LAND.OWNER, LAND.OWNER + LAND.TILES); b.fill(255, LAND.BY, LAND.BY + LAND.TILES);
      b[LAND.OWNER + T] = me;
      const land = parseLand({ key: `ld:${p},${q}`, bytes: toBase64(b) }, { p, q });
      FS.provinces.set(`${p},${q}`, { ...FS.provinces.get(`${p},${q}`), land });
      invalidate('panel');
      return { ok: !!land, at: performance.now() };
    }, [HOME.p, HOME.q, T]);
    assert.ok(set.ok, 'the record parses');
    // the chip first (every HUD tick), then the board — within 2 s, far inside the next poll (30 s idle)
    await page.waitForFunction(() => Number(document.querySelector('#land-chip-box .land-chip')?.dataset.landClaimed ?? 0) >= 1, null, { timeout: 2000 });
    let after = bare;
    for (let i = 0; i < 10 && !differs(after, bare); i++) { await page.waitForTimeout(200); after = await sample(); }
    assert.ok(differs(after, bare), 'the board changed at the tile within 2 s of a panel-only redraw');

    assert.equal(tripped, null, 'the monitor never tripped');
    assert.deepEqual(posts, [], 'no request other than GET or HEAD (each was aborted before it was sent)');
    assert.deepEqual(errors, []);
    assert.deepEqual([...new Set(blocked)], [], 'no request to any origin other than the fixture\'s (each was aborted before it was sent)');
    await NK.assertKeyless(ctx, assert);
    // the profile: within its limit, and none of the page's storage written into it
    const files = profiles().flatMap(n => walk(join(TMP, n)));
    const size = files.reduce((a, f) => { try { return a + statSync(f).size; } catch { return a; } }, 0);
    assert.ok(size <= PROFILE_MAX, `the temporary profile stays under 300 MiB (${(size / 2 ** 20).toFixed(1)} MiB)`);
    const leaked = files.filter(f => { try { const s = readFileSync(f); return STORED.some(k => s.includes(k)); } catch { return false; } });
    assert.deepEqual(leaked, [], 'no page storage in the profile on disk');
  } finally {
    if (tripped) await closeAll();
  }
});

test('cleanup: this test\'s own context, browser and server closed once; Playwright removed its temporary profile and artifacts', async () => {
  await closeAll();
  console.log(`# monitor: tripped=${tripped ?? 'no'}; profile peak ${(peak.profile / 2 ** 20).toFixed(1)} MiB; free low ${(peak.freeLow / 2 ** 30).toFixed(2)} GiB (sampled every ${MONITOR_MS} ms)`);
  assert.equal(tripped, null, tripped ?? '');
  assert.deepEqual(profiles(), [], JSON.stringify(readdirSync(TMP)));
});
