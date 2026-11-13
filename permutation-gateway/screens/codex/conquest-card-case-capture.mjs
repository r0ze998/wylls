// Evidence capture of NAMED CASES of the FIXTURE display (conquest-card-gallery.mjs): one PNG per case, per language
// and width, taken of that case's own element (title, note and card), so each image is readable by itself. The
// gallery page scrolls inside a container, so a "full page" shot holds only its first screen; this takes elements.
// A headless Chromium of its own (a fresh temporary profile; never the player's browser or tabs), loading only the
// loopback fixture page.
//
// No wallet, no key, no signature, no relay, no chain. Run under the no-key guard while the gallery is listening:
//
//   node --import ./permutation-gateway/screens/codex/no-key-node.mjs \
//     permutation-gateway/screens/codex/conquest-card-case-capture.mjs --port 47314 --cases T,U,V --out <dir>
import { chromium } from '../node_modules/playwright-core/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = name => process.argv[process.argv.indexOf(name) + 1];
const port = Number(arg('--port')), out = path.resolve(arg('--out') ?? ''), wanted = String(arg('--cases') ?? '').split(',').filter(x => /^[A-Z][0-9]?$/.test(x));
if (!Number.isInteger(port) || port < 47000 || port > 47999 || !arg('--out') || !wanted.length) { console.error('--port 47000-47999 --cases T,U,V --out <dir>'); process.exit(2); }
await mkdir(out, { recursive: true });
const SIZES = [['desktop', 1280, 900, false], ['mobile', 390, 844, true]];
const browser = await chromium.launch({ headless: true });
const report = { fixture: true, note: 'states written by hand; nothing prepared, signed or sent; one element screenshot per named case', port, cases: wanted, shots: [], requests: [] };
try {
  for (const lang of ['ja', 'en']) for (const [name, width, height, isMobile] of SIZES) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: isMobile ? 2 : 1, isMobile, hasTouch: isMobile });
    const page = await context.newPage();
    page.on('request', r => report.requests.push(`${r.method()} ${new URL(r.url()).origin}${new URL(r.url()).pathname}`));
    await page.goto(`http://127.0.0.1:${port}/gallery?lang=${lang}`, { waitUntil: 'networkidle' });
    for (const id of wanted) {
      const el = page.locator('.fx-case').filter({ has: page.locator('h2', { hasText: new RegExp(`^${id}\\. `) }) });
      if (await el.count() !== 1) throw new Error(`case ${id}: ${await el.count()} elements`);
      const file = `case-${id}-${lang}-${name}.png`;
      await el.scrollIntoViewIfNeeded();
      await el.screenshot({ path: path.join(out, file) });
      const box = await el.boundingBox();
      report.shots.push({ file, case: id, lang, viewport: width, cssWidth: Math.round(box.width), cssHeight: Math.round(box.height), text: (await el.locator('.fx-pop').innerText()).replace(/\s+/g, ' ').trim() });
    }
    await context.close();
  }
} finally { await browser.close(); }
report.requests = [...new Set(report.requests)].sort();
await writeFile(path.join(out, 'cases-report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ shots: report.shots.length, requests: report.requests }));
