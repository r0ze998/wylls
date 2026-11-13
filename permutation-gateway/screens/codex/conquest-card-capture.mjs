// Evidence capture of the FIXTURE display (conquest-card-gallery.mjs): full-page PNGs at a desktop and a phone width,
// in Japanese and English, plus a text check of each case. A headless Chromium of its own (a fresh temporary
// profile; never the player's browser or tabs), loading only the loopback fixture page.
//
// No wallet, no key, no signature, no relay, no chain. Run under the no-key guard while the gallery is listening:
//
//   node --import ./permutation-gateway/screens/codex/no-key-node.mjs \
//     permutation-gateway/screens/codex/conquest-card-capture.mjs --port 47311 --out docs/integration/evidence-fable-conquest-card
import { chromium } from '../node_modules/playwright-core/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = name => process.argv[process.argv.indexOf(name) + 1];
const port = Number(arg('--port')), out = path.resolve(arg('--out'));
if (!Number.isInteger(port) || port < 47000 || port > 47999 || !arg('--out')) { console.error('--port 47000-47999 --out <dir>'); process.exit(2); }
await mkdir(out, { recursive: true });
const SIZES = [['desktop', 1280, 900, false], ['mobile', 390, 844, true]];
const browser = await chromium.launch({ headless: true });
const report = { fixture: true, note: 'states written by hand; nothing prepared, signed or sent', port, shots: [], requests: [], cases: {} };
try {
  for (const lang of ['ja', 'en']) for (const [name, width, height, isMobile] of SIZES) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: isMobile ? 2 : 1, isMobile, hasTouch: isMobile });
    const page = await context.newPage();
    // every request the page makes is recorded: only GETs to the loopback fixture are expected
    page.on('request', r => report.requests.push(`${r.method()} ${new URL(r.url()).origin}${new URL(r.url()).pathname}`));
    await page.goto(`http://127.0.0.1:${port}/gallery?lang=${lang}`, { waitUntil: 'networkidle' });
    const file = `conquest-card-${lang}-${name}.png`;
    await page.screenshot({ path: path.join(out, file), fullPage: true });
    // layout facts per case: the card's box, whether anything overflows it sideways, the buttons and their state
    const cases = await page.evaluate(() => [...document.querySelectorAll('.fx-case')].map(el => {
      const pop = el.querySelector('.fx-pop'), box = pop.getBoundingClientRect();
      return { title: el.querySelector('h2').textContent, width: Math.round(box.width), height: Math.round(box.height),
        overflowX: pop.scrollWidth > pop.clientWidth + 1 || [...pop.querySelectorAll('*')].some(x => x.getBoundingClientRect().right > box.right + 1),
        pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        buttons: [...pop.querySelectorAll('button')].map(b => ({ act: b.dataset.act, text: b.textContent.trim(), disabled: b.getAttribute('aria-disabled') === 'true', h: Math.round(b.getBoundingClientRect().height) })),
        text: pop.innerText.replace(/\s+/g, ' ').trim() };
    }));
    report.cases[`${lang}-${name}`] = cases;
    report.shots.push({ file, lang, width, height });
    await context.close();
  }
} finally { await browser.close(); }
report.requests = [...new Set(report.requests)].sort();
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ shots: report.shots.map(s => s.file), requests: report.requests.length }));
