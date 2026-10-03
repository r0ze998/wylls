// Opens the playtest start page in fresh browser profiles for each invitation state and prints what a
// friend would read (JA and EN), with a screenshot per state. PT-B; localhost/rehearsal only.
//   node scripts/playtest/landing-states.mjs --herald https://wylls.test:41131 --used CODE --valid CODE [--shots DIR]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const H = new URL(arg('herald', 'https://wylls.test:41131'));
const SHOTS = arg('shots', '');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const cases = [['valid', arg('valid', '')], ['used', arg('used', '')], ['invalid', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'], ['garbled', 'not%20a%20code!!'], ['none', '']];
const browser = await chromium.launch(H.protocol === 'https:' ? { args: [`--host-resolver-rules=MAP ${H.hostname} 127.0.0.1`] } : {});
let bad = 0;
for (const lang of ['en', 'ja']) for (const [name, code] of cases) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: lang === 'en' ? 'en-US' : 'ja-JP' });
  const page = await ctx.newPage();
  await page.goto(`${H.origin}/frontier/frontier/playtest/${code ? `#${code}` : ''}`);
  await page.waitForFunction(() => { const t = document.getElementById('card-title')?.textContent ?? ''; return t && !/…|Checking|確認しています/.test(t); }, null, { timeout: 20_000 }).catch(() => {});
  const r = await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.getElementById('card-title').textContent, body: document.getElementById('card-body').textContent, go: !document.getElementById('go').hidden, retry: !document.getElementById('retry').hidden, hash: location.hash, overflow: document.documentElement.scrollWidth > innerWidth }));
  console.log(`${lang} ${name.padEnd(8)} -> ${r.title} | go=${r.go} retry=${r.retry} hash-after=${JSON.stringify(r.hash)} overflowX=${r.overflow}`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${lang}-${name}.png`), fullPage: false });
  if (r.hash || r.overflow) bad++;
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
