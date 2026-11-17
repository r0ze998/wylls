// Browser check of the comparison page (Playwright and Chromium): it loads,
// a story can be played to the end through the offered options, and the
// page's verdicts equal the evaluator's on the same events. This shows the
// page works; it says nothing about whether people understand or enjoy it.
// Run: node workstreams/15-coop-outcomes/test/play.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { serve } from '../play/serve.mjs';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';

// The machine's Playwright is found through require (it is not a dependency of this repo).
const { chromium } = createRequire(import.meta.url)('playwright');

const server = await serve(0);
const url = `http://127.0.0.1:${server.address().port}/workstreams/15-coop-outcomes/play/`;
const browser = await chromium.launch();
const results = [];
const check = async (name, f) => { try { await f(); results.push(`ok ${name}`); } catch (e) { results.push(`not ok ${name}: ${e.message}`); } };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await check('loads without errors and offers four stories', async () => {
    assert.equal(await page.locator('#story option').count(), 4);
    assert.deepEqual(errors, []);
  });
  await check('no horizontal scroll at phone width', async () => {
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= 390, `scrollWidth ${w}`);
  });
  await page.selectOption('#story', 'chapter-no-sabotage');
  await page.selectOption('#actor', 'n4-0');
  await page.click('#start');
  await page.waitForSelector('.choices button');
  await check('the first stop offers independent options, not only wait', async () => {
    const kinds = await page.locator('.choices button:not([disabled])').evaluateAll(bs => bs.map(b => b.dataset.kind));
    assert.ok(kinds.includes('wait'));
    assert.ok(kinds.some(k => k !== 'wait' && k !== 'contribute'), kinds.join(','));
  });
  // Play: contribute, then raid if offered, then use a foreign structure if offered, else wait.
  for (const prefer of [['contribute'], ['raid', 'wait'], ['use-foreign-structure', 'wait'], ['build-own', 'wait']]) {
    for (const k of prefer) {
      const b = page.locator(`.choices button[data-kind="${k}"]:not([disabled])`).first();
      if (await b.count()) { await b.click(); break; }
    }
  }
  await check('the story ends with three verdict cards', async () => {
    assert.match(await page.locator('h2').innerText(), /結果/);
    assert.equal(await page.locator('.card').count(), 3);
  });
  await check('the page\'s verdicts equal the evaluator\'s on the same events', async () => {
    const input = await page.evaluate(() => { const g = window.__ws15.game; return { state: g.base.state, events: [...g.base.events, ...g.extra] }; });
    const shown = await page.locator('.hash').innerText();
    for (const k of ['A', 'B', 'C']) assert.ok(shown.includes(`${k}: ${evaluate(RULESETS[k], input).verdictHash.slice(0, 12)}`), k);
    assert.deepEqual(errors, []);
  });
  await page.screenshot({ path: new URL('../results/play-phone.png', import.meta.url).pathname, fullPage: true });
} finally {
  await browser.close();
  server.close();
}
console.log(results.join('\n'));
if (results.some(r => r.startsWith('not ok'))) process.exit(1);
