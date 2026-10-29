// A kept-open game page for the UI check. Start it once; then send steps
// and take screenshots without reloading:
//
//   PROFILE=<dir> node session.mjs            (listens on 127.0.0.1:41999)
//   curl -s localhost:41999 -d '{"steps":[{"button":"建てる"}],"out":"shots/x.png"}'
//
// Steps: {"button": name} (accessible name), {"text": t}, {"xy": [x, y]},
// {"key": k}, {"wait": ms}, {"eval": "js"} (returns its value).
// The reply lists the page's errors since the last call and the visible
// buttons (names), to know what to press next.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PW = path.resolve(import.meta.dirname, '../../agent-wallet/permutation-gateway/screens/node_modules/playwright-core');
const { chromium } = require(PW);

const url = process.env.URL || 'http://ui.localhost:41940/frontier/frontier/';
const ctx = await chromium.launchPersistentContext(process.env.PROFILE, {
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  viewport: { width: 1280, height: 800 },
  locale: 'ja-JP',
});
const page = ctx.pages()[0] || await ctx.newPage();
let errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(6000);

async function run(cmd) {
  const values = [];
  for (const s of cmd.steps || []) {
    if (s.button) await page.getByRole('button', { name: s.button, exact: !!s.exact }).first().click({ timeout: 8000 });
    else if (s.text) await page.getByText(s.text).first().click({ timeout: 8000 });
    else if (s.xy) await page.mouse.click(s.xy[0], s.xy[1]);
    else if (s.key) await page.keyboard.press(s.key);
    else if (s.eval) values.push(await page.evaluate(s.eval));
    if (s.goto) await page.goto(s.goto, { waitUntil: 'load' });
    await page.waitForTimeout(s.wait || 1200);
  }
  if (cmd.out) {
    mkdirSync(path.dirname(path.resolve(import.meta.dirname, cmd.out)), { recursive: true });
    await page.screenshot({ path: path.resolve(import.meta.dirname, cmd.out) });
  }
  const buttons = await page.$$eval('button', bs => bs.filter(b => b.offsetParent && !b.disabled)
    .map(b => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
  const out = { ok: true, values, errors, buttons: [...new Set(buttons)].slice(0, 80) };
  errors = [];
  return out;
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    let r;
    try { r = await run(JSON.parse(body || '{}')); } catch (e) { r = { ok: false, error: String(e).split('\n')[0], errors }; errors = []; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(r));
  });
}).listen(Number(process.env.PORT || 41999), '127.0.0.1', () => console.log(`session ready on ${process.env.PORT || 41999}`));
