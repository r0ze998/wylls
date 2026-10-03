// Opens the playtest start page in fresh browser profiles for each invitation state and prints what a
// friend would read (JA and EN), with a screenshot per state. PT-B; localhost/rehearsal only.
//   node scripts/playtest/landing-states.mjs --herald https://wylls.test:41131 --used CODE --valid CODE [--shots DIR]
// PT-E: the fragment stays in the address bar until Start (so a reload or "open in Safari" keeps the invitation); a malformed
// fragment (%E0%A4%A) is an invalid invitation, never a dead page; a LINE user agent gets the "open in Safari or Chrome" card
// with no Start; the key box comes before the Start button and Start waits for "I saved my key".
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const H = new URL(arg('herald', 'https://wylls.test:41131'));
const SHOTS = arg('shots', '');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const LINE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.8.0';
const cases = [['valid', arg('valid', '')], ['used', arg('used', '')], ['invalid', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'], ['garbled', 'not%20a%20code!!'], ['malformed', '%E0%A4%A'], ['none', ''], ['line', arg('valid', ''), LINE_UA]];
const browser = await chromium.launch(H.protocol === 'https:' ? { args: [`--host-resolver-rules=MAP ${H.hostname} 127.0.0.1`] } : {});
let bad = 0;
for (const lang of ['en', 'ja']) for (const [name, code, ua] of cases) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: lang === 'en' ? 'en-US' : 'ja-JP', ...(ua ? { userAgent: ua } : {}) });
  const page = await ctx.newPage();
  await page.goto(`${H.origin}/frontier/frontier/playtest/${code ? `#${code}` : ''}`);
  await page.waitForFunction(() => { const t = document.getElementById('card-title')?.textContent ?? ''; return t && !/…|Checking|確認しています/.test(t); }, null, { timeout: 20_000 }).catch(() => {});
  const r = await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.getElementById('card-title').textContent, body: document.getElementById('card-body').textContent, go: !document.getElementById('go').hidden,
    goDisabled: document.getElementById('go').getAttribute('aria-disabled') === 'true', retry: !document.getElementById('retry').hidden, copyLink: !document.getElementById('copy-link').hidden, hash: location.hash, overflow: document.documentElement.scrollWidth > innerWidth,
    keyBeforeStart: (() => { const k = document.getElementById('key-box'); const g = document.getElementById('start-box'); return !k.hidden && !!(k.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING); })(), restoreOpen: document.getElementById('restore').open }));
  console.log(`${lang} ${name.padEnd(9)} -> ${r.title} | go=${r.go} disabled=${r.goDisabled} retry=${r.retry} copyLink=${r.copyLink} keyBeforeStart=${r.keyBeforeStart} restoreOpen=${r.restoreOpen} hash-after=${JSON.stringify(r.hash)} overflowX=${r.overflow}`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${lang}-${name}.png`), fullPage: false });
  const want = code ? (code.includes('%') && name !== 'garbled' ? `#${code}` : `#${code}`) : '';
  if (r.hash !== want) { console.log(`  FAIL: the fragment must stay in the address bar until Start (wanted ${JSON.stringify(want)})`); bad++; }
  if (r.overflow) bad++;
  if (name === 'valid' && !(r.go && r.goDisabled && r.keyBeforeStart)) { console.log('  FAIL: Start must show, disabled until the key is saved, below the key box'); bad++; }
  if (name === 'line' && !(r.copyLink && !r.go)) { console.log('  FAIL: an in-app browser gets Copy link and no Start'); bad++; }
  if (['none', 'invalid', 'malformed'].includes(name) && !r.restoreOpen) { console.log('  FAIL: the key box should be open for a visitor without a working invitation'); bad++; }
  if (name === 'malformed' && !/invitation|招待/i.test(r.title + r.body)) { console.log('  FAIL: a malformed fragment is an invalid invitation'); bad++; }
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
