// Before/after pictures for the visual uplift (docs/design/uplift/): the same
// scenes, the same frozen fixture world, the same viewports, for any checkout
// of the client. Not a test; a camera.
//
//   node uplift-shots.mjs --tree <checkout root> --out <dir> [--only s01,s04] [--vp desk,phone] [--lang ja|en]
//
// The fixture server, its world and its storage come from the checkout named
// by --tree (so an older client is photographed against its own fixture);
// Playwright comes from this folder. The clock is fixed at the fixture's
// latest moment, Math.random is seeded, and nothing is sent anywhere.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const tree = resolve(arg('tree', '../..'));
const out = resolve(arg('out', 'artifacts/uplift'));
const only = (arg('only', '') || '').split(',').filter(Boolean);
const vps = (arg('vp', 'desk,phone') || '').split(',');
const lang = arg('lang', 'ja');
const VIEWPORTS = { desk: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

const S = join(tree, 'permutation-gateway/screens');
const { startServer } = await import(pathToFileURL(join(S, 'server.mjs')).href);
const W = await import(pathToFileURL(join(S, 'world.mjs')).href);

function initScript({ storage }) {
  let s = 0x2545f491;
  Math.random = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
  try { for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); } catch { /* no storage */ }
}

const mapOf = page => page.evaluate(async () => {
  if (window.__map) return true;
  const { FrontierMap } = await import('/frontier/map/fmap.mjs');
  const P = FrontierMap.prototype, draw = P.draw;
  P.draw = function (...a) { window.__map = this; return draw.apply(this, a); };
  for (let i = 0; i < 80 && !window.__map; i++) { window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 50)); }
  return !!window.__map;
});
const tileAt = async (page, at) => {
  await mapOf(page);
  return page.evaluate(async at => {
    const m = window.__map, frame = () => new Promise(r => requestAnimationFrame(r));
    for (let still = 0, i = 0; still < 10 && i < 400; i++) { await frame(); still = m.cam.moving || m.reachFly ? 0 : still + 1; }
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const h = tileHex(at.p, at.q, at.tile), c = project(h.q, h.r);
    return m.project(c.x, c.y);
  }, at);
};
const tapTile = async (page, at) => { const p = await tileAt(page, at); await page.mouse.click(p.x, p.y); };
/** Out by `n` steps: the map's own button (a phone has none: pinch, or the map's − key, two of which are about one button step). */
const zoomOut = async (page, n) => {
  const b = page.locator('button[aria-label="地図を縮小"], button[aria-label="Zoom out"]').first();
  for (let i = 0; i < n; i++) {
    if (await b.isVisible()) await b.click();
    else { await page.locator('#frontier-map').focus(); await page.keyboard.press('-'); await page.keyboard.press('-'); }
    await page.waitForTimeout(900);
  }
};
const settle = async (page, ms = 900) => { await page.waitForTimeout(ms); await mapOf(page).catch(() => {}); await page.evaluate(() => new Promise(r => { let n = 0; const f = () => (++n > 20 ? r() : requestAnimationFrame(f)); f(); })); };

/** The scenes: `[id, title, run(page, vp)]`; each starts from a fresh page on the viewer's home. */
const SCENES = [
  ['s01-rest', 'the map at rest, nothing selected', async () => {}],
  ['s02-village', 'the village selected', async page => { await tapTile(page, W.HOME); await page.locator('#hand [data-hand="build"]').waitFor({ timeout: 8000 }).catch(() => {}); }],
  ['s03-host', 'a host in hand, its reach lit', async page => {
    await tapTile(page, W.HOME);
    await page.locator('#hand .hand-chip[data-host]:not(.hand-back)').first().click({ timeout: 8000 }).catch(() => {});
  }],
  ['s04-compose', 'a march written to the camp', async page => {
    await tapTile(page, W.HOME);
    await page.locator('#hand .hand-chip[data-host]:not(.hand-back)').first().click({ timeout: 8000 }).catch(() => {});
    await tapTile(page, { ...W.HOME, tile: W.CAMP_TILE });
    await page.locator('#mc-title').waitFor({ timeout: 8000 }).catch(() => {});
    // (on a phone the camp may lie under the sheet: the same order through the card's own coordinates form)
    if (!(await page.locator('.mc-dest-name').count())) {
      await page.locator('#tabs [data-tab="hosts"]').click().catch(() => {});
      await page.locator('#panel-body button[data-act="compose"]:not([disabled])').first().click({ timeout: 5000 }).catch(() => {});
      await page.evaluate(({ p, q, tile }) => { const f = document.querySelector('form[data-form="dest"]'); if (!f) return; f.querySelector('[name=p]').value = p; f.querySelector('[name=q]').value = q; f.querySelector('[name=tile]').value = tile; f.requestSubmit(); }, { ...W.HOME, tile: W.CAMP_TILE });
    }
    await page.locator('[data-act="march-send"]:not([disabled])').waitFor({ timeout: 15000 }).catch(() => {});
  }],
  ['s05-far', 'the world chart', async page => { await page.locator('#frontier-map').focus(); await page.keyboard.press('m'); }],
  ['s06-holding', 'the village drawer', async page => { await page.locator('#tabs [data-tab="holding"]').click(); }],
  ['s07-hosts', 'the hosts drawer', async page => { await page.locator('#tabs [data-tab="hosts"]').click(); }],
  ['s08-more', 'the more drawer', async page => { await page.locator('#tabs [data-tab="more"]').click(); }],
  ['s10-compare', 'a march on a defended village: the outlook and the stances compared', async page => {
    await page.locator('#tabs [data-tab="hosts"]').click().catch(() => {});
    await page.locator('#panel-body button[data-act="compose"]:not([disabled])').first().click({ timeout: 5000 }).catch(() => {});
    await page.evaluate(() => { const f = document.querySelector('form[data-form="dest"]'); if (!f) return; f.querySelector('[name=p]').value = 2; f.querySelector('[name=q]').value = 0; f.querySelector('[name=tile]').value = 26; f.requestSubmit(); });
    await page.locator('.mc-compare .mcc-row, .mc-outlook').first().waitFor({ timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.locator('.mc-compare, .picks-4').first().scrollIntoViewIfNeeded().catch(() => {});
  }],
  // The village's lens on an S1 season: the page is told the season plays S1 (fs1.mjs setS1; the fixture's season does
  // not), then the village is selected: the hills and mountains near it carry what they add to its ore. A SAMPLE of how
  // an S1 season shows it, on the fixture's land.
  ['s12-mid', 'one step out from the rest (several provinces in view)', async page => { await zoomOut(page, 1); }],
  ['s13-mid2', 'two steps out from the rest', async page => { await zoomOut(page, 2); }],
  ['s11-orelens', 'the village lens on an S1 season (sample)', async page => {
    await page.evaluate(async () => { (await import('/frontier/fs1.mjs')).setS1({ layoutVersion: 2, programVersion: 4 }); });
    await tapTile(page, W.HOME);
  }],
  // A SAMPLE of the herald's S1 feeds laid into the page (the fixture serves none, and no S1 world can be started
  // locally yet: docs/design/uplift/00-SCOPE 2): a vault, an enemy tower and palisade, the viewer's fort and a cart of
  // ore on the home province, to see how the stage-1 things stand on the board. Not a record of any season.
  ['s09-s1sample', 'stage-1 things (sample feed)', async page => {
    await page.evaluate(async ({ p, q }) => {
      const { FS } = await import('/frontier/fstate.mjs');
      const { parseCaravans, parseStructures } = await import('/frontier/herald.mjs');
      // (each thing on a tile the rules would allow: passable, not a village site, not the camp; the sample once stood
      // the fort on a lake)
      const tr = FS.terrainOf?.(p, q);
      const sites = new Set(tr?.sites ?? []), dry = t => tr && !/water|lake|sea|ocean|mountain/i.test(String(tr.names?.[tr.terrain?.[t]] ?? ''));
      const fit = (...want) => want.find(t => dry(t) && !sites.has(t) && t !== 32) ?? want[0];
      const T = { vault: fit(21, 20, 28), tower: fit(40, 47, 46), palisade: fit(41, 34, 48), fort: fit(33, 27, 34, 25, 36) };
      const pl = (kind, t) => ({ kind, p, q, at: 2, gen: 1, tile: t });
      FS.s1 = { nations: null, error: null,
        caravans: parseCaravans({ v: 1, moving: [{ ownerTag: '1', seq: 0, faction: 0, src: pl(1, T.vault), dst: pl(3, T.fort), steps: 4, cargo: [0, 0, 0, 3000, 0, 0, 0, 0], arriveTs: 1800030000, runs: [{ p, q, firstBell: (FS.nowBell ?? 40) - 1, n: 3 }], raided: false }], vaults: [{ p, q, tile: T.vault, ownerTag: '1', faction: 0, gen: 1 }] }),
        structures: parseStructures({ v: 1, sightings: [], structures: [
          { p, q, tile: T.tower, kind: 1, faction: 3, ownerTag: '7', gen: 1, notify: 0, cover: [], sent: 0 },
          { p, q, tile: T.palisade, kind: 2, faction: 3, ownerTag: '7', gen: 2, notify: 0, cover: [], sent: 0 },
          { p, q, tile: T.fort, kind: 3, faction: 0, ownerTag: '1', gen: 3, notify: 0, cover: [], sent: 0 }] }) };
      window.dispatchEvent(new Event('resize'));
    }, W.HOME);
  }, '?at=2,0,30,1.5'],
];

const srv = await startServer();
const browser = await chromium.launch();
const shots = [];
mkdirSync(out, { recursive: true });
try {
  for (const vpId of vps) {
    const vp = VIEWPORTS[vpId];
    const phone = vp.width < 760;
    for (const [id, title, run, query = ''] of SCENES) {
      if (only.length && !only.includes(id)) continue;
      srv.stage('holding');
      const context = await browser.newContext({ viewport: vp, isMobile: phone, hasTouch: phone, locale: lang === 'ja' ? 'ja-JP' : 'en-GB', timezoneId: 'UTC', deviceScaleFactor: 1 });
      await context.addInitScript(initScript, { storage: W.storageFor(srv.viewer, { stage: 'holding', lang, intro: false, live: false }) });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.setFixedTime(new Date(W.LATEST_UNIX * 1000 + 500));
      const t0 = Date.now();
      await page.goto(`${srv.url}/frontier/index.html${query}`);
      await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading', null, { timeout: 30000 });
      await page.locator('#frontier-map[data-lod="tile"]').waitFor({ timeout: 15000 }).catch(() => {});
      await settle(page, 1500);
      try { await run(page, vp); } catch (e) { errors.push(`scene: ${e.message}`); }
      await settle(page, 1400);
      const file = `${id}-${vpId}.png`;
      await page.screenshot({ path: join(out, file) });
      shots.push({ id, title, vp: vpId, file, ms: Date.now() - t0, errors });
      console.log(`${file} ${errors.length ? `errors: ${errors.join(' | ')}` : 'ok'}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await srv.close();
  writeFileSync(join(out, 'shots.json'), `${JSON.stringify({ tree, lang, shots }, null, 1)}\n`);
}
