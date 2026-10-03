// How hard does ONE open game page hit the public origin? (PT-B) Opens the game page through the
// tunnel stand-in, counts the requests per 10-second window for a minute or more, and the status
// codes seen (a 429 here would mean the per-address limits are too tight for a normal player).
//   node scripts/playtest/page-load.mjs --herald https://wylls.test:41131 [--seconds 90] [--tabs 1] [--hidden]
import { chromium } from 'playwright-core';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const H = new URL(arg('herald', 'https://wylls.test:41131'));
const SECONDS = Number(arg('seconds', 90));
const TABS = Number(arg('tabs', 1));
const browser = await chromium.launch(H.protocol === 'https:' ? { args: [`--host-resolver-rules=MAP ${H.hostname} 127.0.0.1`] } : {});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
const t0 = Date.now();
const windows = {}; const codes = {}; const byKind = {};
const kind = u => { const p = new URL(u).pathname; return p.startsWith('/h/ws') ? 'ws' : p.startsWith('/h/') ? p.split('/').slice(0, 3).join('/') : p.startsWith('/gw/') ? p.split('/').slice(0, 4).join('/') : 'static'; };
for (let i = 0; i < TABS; i++) {
  const page = await ctx.newPage();
  page.on('response', r => { const w = Math.floor((Date.now() - t0) / 10_000); windows[w] = (windows[w] ?? 0) + 1; codes[r.status()] = (codes[r.status()] ?? 0) + 1; if (w >= 1) byKind[kind(r.url())] = (byKind[kind(r.url())] ?? 0) + 1; });
  await page.goto(`${H.origin}/frontier/frontier/index.html`);
}
await new Promise(r => setTimeout(r, SECONDS * 1000));
console.log(JSON.stringify({ tabs: TABS, seconds: SECONDS, requestsPer10s: windows, statusCodes: codes, afterFirst10sByKind: byKind }, null, 1));
await browser.close();
