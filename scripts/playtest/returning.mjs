// The "came back" path (PT-B): one browser profile joins through the start page, is closed, and a new
// browser opened on the SAME profile (what a friend's next day looks like) goes to the start page without
// the invitation: it must say "welcome back", continue into the game with the same wallet and in-game key
// (no wallet step, no key prompt), and the game must know the citizen. Then a second, empty profile uses
// the same (now used) invitation: it must be told the invitation is used. Rehearsal stack only.
//   node scripts/playtest/returning.mjs --herald https://wylls.test:41131 --invite CODE [--profile DIR]
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const H = new URL(arg('herald', 'https://wylls.test:41131'));
const INVITE = arg('invite', '');
const PROFILE = arg('profile', mkdtempSync(path.join(os.tmpdir(), 'wylls-profile-')));
const launch = dir => chromium.launchPersistentContext(dir, { ignoreHTTPSErrors: true, args: [`--host-resolver-rules=MAP ${H.hostname} 127.0.0.1`], viewport: { width: 1000, height: 800 } });
const card = p => p.evaluate(() => ({ title: document.getElementById('card-title').textContent, go: !document.getElementById('go').hidden }));
const settle = p => p.waitForFunction(() => { const t = document.getElementById('card-title')?.textContent ?? ''; return t && !/…|Checking|確認しています/.test(t); }, null, { timeout: 20_000 });
let bad = 0;
const expect = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); if (!ok) bad++; };

let ctx = await launch(PROFILE);
let page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(`${H.origin}/frontier/frontier/playtest/#${INVITE}`); await settle(page);
expect('first visit with the invitation: it works', (await card(page)).title.match(/works|確認しました/) !== null);
await page.locator('#saved').check(); // PT-E: Start waits for "I saved my key"
await page.locator('#go').click();
await page.waitForFunction(() => document.querySelector('[data-act="pick-faction"]'), null, { timeout: 30_000 });
expect('the game goes straight to choosing a nation (no wallet step)', !(await page.locator('[data-act="connect"]').count()));
if (await page.locator('[data-act="intro-close"]').count()) await page.locator('[data-act="intro-close"]').click();
await page.locator('[data-act="pick-faction"][data-f="0"]').click();
await page.locator('[data-act="join"]:not([disabled])').click();
await page.waitForFunction(() => /\bok\b/.test(document.querySelector('.notice')?.className ?? '') , null, { timeout: 120_000 });
expect('Join landed', true);
await ctx.close();

ctx = await launch(PROFILE); // "the next day": same profile, no invitation in the link
page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(`${H.origin}/`); await settle(page);
const c2 = await card(page);
expect('next visit without the invitation: welcome back, with a button to continue', /Welcome back|おかえりなさい/.test(c2.title) && c2.go, c2.title);
await page.locator('#go').click();
await page.waitForFunction(() => document.getElementById('bell-chip')?.textContent?.match(/\d/), null, { timeout: 30_000 });
await page.waitForTimeout(4000);
const state = await page.evaluate(`(async () => { const { FS } = await import('./fstate.mjs'); return { wallet: !!FS.wallet, session: !!FS.session, citizen: !!FS.citizen, sessionProblem: FS.sessionProblem ?? null, connectButton: !!document.querySelector('[data-act="connect"]'), sessionButton: !!document.querySelector('[data-act="session"]') }; })()`);
expect('the game knows the wallet, the in-game key and the citizen without asking again', state.wallet && state.session && state.citizen && !state.sessionProblem && !state.connectButton && !state.sessionButton, JSON.stringify(state));
await ctx.close();

const fresh = await launch(mkdtempSync(path.join(os.tmpdir(), 'wylls-profile-')));
page = fresh.pages()[0] ?? await fresh.newPage();
await page.goto(`${H.origin}/frontier/frontier/playtest/#${INVITE}`); await settle(page);
const c3 = await card(page);
expect('an empty profile with the used invitation: told it is used, no start button', /already used|すでに使われて/.test(c3.title) && !c3.go, c3.title);
await fresh.close();
process.exit(bad ? 1 : 0);
