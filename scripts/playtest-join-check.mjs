#!/usr/bin/env node
// One friend joins through the herald, as a real browser (PT-A selftest).
//
//   node scripts/playtest-join-check.mjs --herald http://127.0.0.1:41117 --invite CODE
//        [--faction 1] [--lang en|ja] [--shots DIR] [--wait-min 25]
//
// Opens the game page the herald serves (/frontier/frontier/index.html) in headless
// Chromium, connects the wallet the page offers, picks a nation, types the invite
// into the join screen's field, presses Join, and waits until the page reports the
// Join landed. Then checks, from outside the page, that the herald knows the wallet
// (`/h/me/<wallet>`). Exits 0 only then. Nothing is edited in the page; the invite
// is a one-time code and is spent. Local use only: it refuses any herald that is
// not 127.0.0.1 / localhost.
//
// playwright-core is found through PLAYWRIGHT_CORE_DIR, or in the sibling worktrees'
// permutation-gateway/screens/node_modules (no install is made here); Chromium is the
// one in ~/Library/Caches/ms-playwright.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const HERALD = String(arg('herald', '')).replace(/\/$/, '');
const INVITE = arg('invite', '');
const FACTION = Number(arg('faction', 1));
const LANG = arg('lang', 'en');
const SHOTS = arg('shots', '');
const WAIT_MS = Number(arg('wait-min', 25)) * 60_000;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(HERALD)) { console.error('--herald http://127.0.0.1:PORT is required (local only)'); process.exit(2); }
if (/:(4185|4190|4191|4194|41[3-9]\d\d)$/.test(HERALD)) { console.error(`refusing ${HERALD}: not a playtest port`); process.exit(2); }

function findPlaywright() {
  const cands = [];
  if (process.env.PLAYWRIGHT_CORE_DIR) cands.push(process.env.PLAYWRIGHT_CORE_DIR);
  cands.push(path.join(HERE, '../permutation-gateway/screens/node_modules/playwright-core'));
  const wts = path.resolve(HERE, '../..');
  try { for (const d of readdirSync(wts)) cands.push(path.join(wts, d, 'permutation-gateway/screens/node_modules/playwright-core')); } catch { /* not in a worktree */ }
  const hit = cands.find(c => existsSync(path.join(c, 'package.json')));
  if (!hit) throw new Error('playwright-core not found: set PLAYWRIGHT_CORE_DIR to a playwright-core directory');
  return createRequire(path.join(hit, 'package.json'))('./index.js');
}
const { chromium } = findPlaywright();

const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: LANG === 'en' ? 'en-US' : 'ja-JP' });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push(`page error: ${String(e.message).slice(0, 160)}`));
page.on('response', async r => {
  if (r.status() < 400 || !/\/gw\//.test(r.url())) return;
  let b = '';
  try { b = (await r.text()).slice(0, 160); } catch { /* gone */ }
  problems.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()} ${b}`);
  log('HTTP', problems.at(-1));
});
const shot = async id => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${id}.png`) }).catch(() => {}); };
const has = sel => page.locator(sel).count().then(n => n > 0);
const notice = () => page.evaluate(() => { const x = document.querySelector('.notice'); return x ? { cls: x.className, text: x.textContent.trim() } : null; });
const fs = expr => page.evaluate(`(async () => { const { FS } = await import('./fstate.mjs'); return (${expr}); })()`).catch(() => null);
const waitSel = async (sel, what, timeout = 120_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await has(sel)) return; await sleep(600); }
  await shot(`timeout-${what.replace(/\W+/g, '-')}`);
  throw new Error(`timed out waiting for ${what} (${sel})`);
};

let code = 1;
try {
  await page.goto(`${HERALD}/frontier/frontier/index.html`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? ''), null, { timeout: 60_000 });
  if ((await page.evaluate(() => document.documentElement.lang)) !== LANG) {
    await page.locator('#lang-box [data-lang-toggle]').click();
    await page.waitForFunction(l => document.documentElement.lang === l, LANG);
  }
  await sleep(1200);
  for (const sel of ['[data-act="intro-close"]', '[data-act="ob-dismiss"]']) if (await has(sel)) await page.locator(sel).first().click().catch(() => {});
  await shot('01-start');
  await waitSel('[data-act="connect"]:not([disabled])', 'a wallet button');
  await page.locator('[data-act="connect"]:not([disabled])').first().click();
  await waitSel(`[data-act="pick-faction"][data-f="${FACTION}"]`, 'the nation cards');
  await page.locator(`[data-act="pick-faction"][data-f="${FACTION}"]`).first().click();
  const gated = await has('input[data-bind="invite"]');
  log(`the join screen ${gated ? 'asks' : 'does not ask'} for an invite`);
  if (gated) await page.locator('input[data-bind="invite"]').fill(INVITE);
  await shot('02-join-form');
  let joined = false;
  const refusals = [];
  const end = Date.now() + WAIT_MS;
  while (!joined && Date.now() < end) {
    await waitSel('[data-act="join"]:not([disabled])', 'the Join button');
    await page.locator('[data-act="join"]:not([disabled])').first().click();
    await sleep(800);
    const t0 = Date.now();
    while (Date.now() - t0 < 240_000) {
      const n = await notice();
      if (n && !/\bbusy\b/.test(n.cls)) {
        if (/\bok\b/.test(n.cls)) joined = true; else refusals.push(n.text);
        log('notice', JSON.stringify(n));
        break;
      }
      await sleep(500);
    }
    // A season that has not opened its first bell refuses Join; a player presses it again.
    if (!joined) await sleep(15_000);
  }
  if (!joined) throw new Error(`Join never landed (${JSON.stringify(refusals)})`);
  await shot('03-joined');
  const wallet = await fs('FS.wallet?.address');
  if (!wallet) throw new Error('the page has no wallet address');
  // From outside the page: the herald knows this wallet's citizen.
  let me = null;
  for (let i = 0; i < 30 && !me; i++) {
    const r = await fetch(`${HERALD}/h/me/${wallet}`).catch(() => null);
    if (r?.ok) { const j = await r.json().catch(() => null); if (j?.citizen) me = j; }
    if (!me) await sleep(2000);
  }
  if (!me) throw new Error(`the herald does not know wallet ${wallet} after the Join`);
  log('joined; the herald knows the wallet (citizen on chain):', JSON.stringify({ quota: me.quota, holdings: me.holdings?.length }));
  console.log(JSON.stringify({ ok: true, wallet, refusals, problems, seconds: Math.round((Date.now() - T0) / 1000) }));
  code = 0;
} catch (e) {
  console.error('FAILED:', e.message);
  await shot('failed');
  console.error(JSON.stringify({ ok: false, error: e.message, problems }));
} finally {
  await browser.close();
}
process.exit(code);
