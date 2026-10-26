// Frame times of the map on a live world (docs/design/uplift/04-VERIFY, 3 回目): the map's own probe (?probe=2) for
// one or more clients served against the same herald (uplift-proxy.mjs), on the spectator page (no wallet). Each run:
// load at tile detail and wait for the terrain, rest, three drags, then the far view. Not a test; a stopwatch. The
// world moves on between runs, so compare clients in the same call and read the medians.
//
//   node uplift-perf-live.mjs <runs> <label>=<url> [<label>=<url> …]
//   e.g. before=http://127.0.0.1:41396/frontier/frontier/spectate.html?intro=0&probe=2&at=1,0,30,0.9
import { chromium } from 'playwright-core';

const runs = Number(process.argv[2]);
const targets = process.argv.slice(3).map(a => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; });
if (!(runs > 0) || !targets.length) { console.error('usage: node uplift-perf-live.mjs <runs> <label>=<url> …'); process.exit(2); }
const browser = await chromium.launch();
const stats = s => { const a = s.slice().sort((x, y) => x - y), q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))]; return a.length ? { n: a.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +a[a.length - 1].toFixed(1) } : null; };
try {
  for (const [label, url] of targets) {
    const all = [], ready = [];
    for (let r = 0; r < runs; r++) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'ja-JP' });
      const page = await ctx.newPage();
      const t0 = Date.now();
      await page.goto(url);
      await page.waitForFunction(() => document.getElementById('frontier-map')?.dataset.terrain === 'ready', null, { timeout: 60000, polling: 50 });
      ready.push(Date.now() - t0);
      await page.waitForTimeout(2500);
      const probe = '/frontier/frontier/map/probe.mjs';
      await page.evaluate(async p => (await import(p)).PROBE.reset(), probe);
      await page.waitForTimeout(2500);
      const box = await page.locator('#frontier-map').boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      for (let k = 0; k < 3; k++) { await page.mouse.move(cx, cy); await page.mouse.down(); for (let i = 0; i < 30; i++) await page.mouse.move(cx + Math.sin(i / 5) * 220, cy + Math.cos(i / 7) * 120, { steps: 2 }); await page.mouse.up(); }
      await page.waitForTimeout(1200);
      await page.locator('#frontier-map').focus(); await page.keyboard.press('m'); await page.waitForTimeout(2500);
      all.push(...await page.evaluate(async p => (await import(p)).PROBE.samples.map(s => [s.kind, s.ms]), probe));
      await ctx.close();
    }
    const out = { ready: stats(ready) };
    for (const kind of new Set(all.map(s => s[0]))) out[kind] = stats(all.filter(s => s[0] === kind).map(s => s[1]));
    console.log(label, JSON.stringify(out));
  }
} finally {
  await browser.close();
}
