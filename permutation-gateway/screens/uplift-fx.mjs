// Frames of the effects' set pieces (docs/design/uplift/07-HUD-TEXT-FX): the page's own demo switch (`?fx=<name>&fxt=<s>`,
// fx/demo.mjs: the real compositions on labelled sample data, the clock frozen at `t`), on the frozen fixture world,
// one picture per (effect, time), and a contact sheet per effect. Not a test; a camera for judging motion on paper.
//
//   node uplift-fx.mjs [--tree <checkout root>] [--out <dir>] [--only bell,landed] [--vp desk|phone] [--motion full|reduced]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const tree = resolve(arg('tree', '../..'));
const out = resolve(arg('out', '../../.local/shots/fx'));
const only = (arg('only', '') || '').split(',').filter(Boolean);
const vpId = arg('vp', 'desk');
const motion = arg('motion', 'full');
const VP = { desk: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } }[vpId];
const S = join(tree, 'permutation-gateway/screens');
const { startServer } = await import(pathToFileURL(join(S, 'server.mjs')).href);
const W = await import(pathToFileURL(join(S, 'world.mjs')).href);

/** The set pieces and the moments worth judging (seconds after the start). */
const FX = {
  bell: [0.15, 0.5, 1.0, 1.6],
  turn: [0.4, 1.4, 2.6, 4.0],
  action: [0.3, 1.2, 2.4],
  landed: [0.1, 0.35, 0.9],
  refused: [0.1, 0.3, 0.9],
  seal: [0.3, 1.0, 2.2],
  built: [0.1, 0.4, 1.2],
  harvest: [0.2, 0.7, 1.4],
  muster: [0.2, 0.8],
  promotion: [0.3, 1.0, 2.0],
  arrive: [0.3, 1.0],
  battle: [0.6, 2.0, 3.6, 5.6, 6.8],
  reveal: [0.4, 1.2],
  camp: [0.4, 1.2],
  village: [0.4, 1.4],
  'village-lost': [0.4, 1.4],
};

function initScript({ storage }) {
  let s = 0x2545f491;
  Math.random = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
  try { for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); } catch { /* no storage */ }
}

const srv = await startServer();
const browser = await chromium.launch();
mkdirSync(out, { recursive: true });
const index = [];
try {
  for (const [name, times] of Object.entries(FX)) {
    if (only.length && !only.includes(name)) continue;
    for (const t of times) {
      srv.stage('holding');
      const phone = VP.width < 760;
      const ctx = await browser.newContext({ viewport: VP, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1, locale: 'ja-JP', timezoneId: 'UTC', reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
      await ctx.addInitScript(initScript, { storage: W.storageFor(srv.viewer, { stage: 'holding', lang: 'ja', intro: false, live: false }) });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.setFixedTime(new Date(W.LATEST_UNIX * 1000 + 500));
      await page.goto(`${srv.url}/frontier/index.html?fx=${encodeURIComponent(name)}&fxt=${t}${motion === 'reduced' ? '&fxmotion=reduced' : ''}`);
      await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading', null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2600);
      // (the demo seeks to `fxt` once the scene is mounted; seek again so a late start does not move the frame)
      await page.evaluate(async t => { for (let i = 0; i < 20 && !window.__fx; i++) await new Promise(r => setTimeout(r, 100)); try { window.__fx?.seek?.(t); } catch { /* none */ } }, t);
      await page.waitForTimeout(400);
      const file = `${name}-${String(t).replace('.', '_')}-${vpId}${motion === 'reduced' ? '-reduced' : ''}.png`;
      await page.screenshot({ path: join(out, file) });
      index.push({ name, t, file, errors });
      console.log(`${file}${errors.length ? ` errors: ${errors.join(' | ')}` : ''}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await srv.close();
  writeFileSync(join(out, 'fx.json'), `${JSON.stringify(index, null, 1)}\n`);
}
