// Frame times of the map for the visual uplift, before against after: the same frozen fixture, the same moves, the
// map's own probe (map/probe.mjs, ?probe=2: the time includes the browser's painting). Not a test; a stopwatch.
//
//   node uplift-perf.mjs --tree <checkout root> [--vp desk|phone] [--runs 3]
//
// Prints, per scenario, the probe's stats by kind of frame (full | pan | live | far): n, p50, p95, max in ms.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const tree = resolve(arg('tree', '../..'));
const vpId = arg('vp', 'desk');
const runs = Number(arg('runs', 3));
const VP = { desk: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } }[vpId];
const S = join(tree, 'permutation-gateway/screens');
const { startServer } = await import(pathToFileURL(join(S, 'server.mjs')).href);
const W = await import(pathToFileURL(join(S, 'world.mjs')).href);

const srv = await startServer();
const browser = await chromium.launch();
const phone = VP.width < 760;
const results = {};
const scen = {
  rest: async () => new Promise(r => setTimeout(r, 3000)),
  pan: async page => {
    const box = await page.locator('#frontier-map').boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    for (let k = 0; k < 3; k++) { await page.mouse.move(cx, cy); await page.mouse.down(); for (let i = 0; i < 30; i++) await page.mouse.move(cx + Math.sin(i / 5) * 220, cy + Math.cos(i / 7) * 120, { steps: 2 }); await page.mouse.up(); }
    await new Promise(r => setTimeout(r, 1200));
  },
  reach: async page => {
    // a host takes the hand from the hosts drawer: its reach is lit (the lattice is drawn inside it)
    await page.locator('#tabs [data-tab="hosts"]').click().catch(() => {});
    await page.locator('#panel-body button:not([disabled]):has-text("進軍させる")').first().click({ timeout: 5000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3500));
  },
};
try {
  for (const [name, run] of Object.entries(scen)) {
    const all = [];
    for (let i = 0; i < runs; i++) {
      srv.stage('holding');
      const ctx = await browser.newContext({ viewport: VP, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 3 : 2, locale: 'ja-JP', timezoneId: 'UTC' });
      await ctx.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, W.storageFor(srv.viewer, { stage: 'holding', lang: 'ja', intro: false, live: false }));
      const page = await ctx.newPage();
      await page.clock.setFixedTime(new Date(W.LATEST_UNIX * 1000 + 500));
      await page.goto(`${srv.url}/frontier/index.html?probe=2`);
      await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading', null, { timeout: 30000 });
      await page.locator('#frontier-map[data-lod="tile"]').waitFor({ timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2500));
      await page.evaluate(async () => (await import('/frontier/map/probe.mjs')).PROBE.reset());
      await run(page);
      all.push(await page.evaluate(async () => (await import('/frontier/map/probe.mjs')).PROBE.samples.map(s => [s.kind, s.ms])));
      await ctx.close();
    }
    const flat = all.flat(), out = {};
    for (const kind of new Set(flat.map(s => s[0]))) {
      const a = flat.filter(s => s[0] === kind).map(s => s[1]).sort((x, y) => x - y), q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))];
      out[kind] = { n: a.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +a[a.length - 1].toFixed(2) };
    }
    results[name] = out;
    console.log(name, JSON.stringify(out));
  }
} finally {
  await browser.close();
  await srv.close();
}
