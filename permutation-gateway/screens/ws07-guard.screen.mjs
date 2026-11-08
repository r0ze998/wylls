// Workstream 07: the BROWSER key guard of screens/ws07/nokey-page.mjs is installed — shown without calling any
// guarded entry. (The Node guard, tools/nokeys.mjs / NOKEYS_LOG, is a separate thing: it guards the
// test process and the fixture server; this file checks only what runs in the page.)
//
// In a page opened as every keyless whole-page test opens it (NK.launchOptions + NK.prepare), checked by SOURCE TEXT
// ONLY — no guarded entry is ever called (workstream 16, REPORT §29.38 A: calling keyFromSeed / publicKeyOf or the
// subtle generate·derive·sign·importKey entries, even with zero bytes against an installed guard, is a key-API
// self-test; earlier versions of this file did that and their results are not evidence):
//   - the page is a secure context (WebCrypto present: the flag is honoured by the full Chromium);
//   - web/session.mjs, as served, ends with NK.SESSION_GUARD, and its keyFromSeed / publicKeyOf are the replacement
//     bodies (their source says 'key use blocked', not the real one);
//   - every guarded crypto.subtle method's source is the replacement (not '[native code]'); Worker is the refusal;
//   - the test wallet's signMessage and signTransaction are the refusal (by source);
//   - the page booted, and reloaded, with the key-use record EMPTY.
// The second test shows the proof fails with the guard missing — still calling nothing key-shaped (it imports
// /session.mjs for its source only; its top level calls no key function).
// Scope: the page realm only. Node (the repo guard, scripts/ci/no-keys-guard.mjs) is separate; Worker realms are not
// guarded, only refused (the page makes a Worker only to seal, which no keyless test does).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import { LATEST_UNIX } from './world.mjs';

/**
 * The guard's sentinels, read from the outside (a page function): what is served and what is installed, by source text.
 * NOTHING key-shaped is called here. → {secure, subtle, ok: [...], bad: [...]}.
 */
const SENTINELS = async guardText => {
  const out = { secure: isSecureContext, subtle: !!crypto.subtle, ok: [] , bad: [] };
  const say = (ok, what) => (ok ? out.ok : out.bad).push(what);
  let served = '';
  try { served = await (await fetch('/session.mjs', { cache: 'no-store' })).text(); } catch { served = ''; }
  say(served.endsWith(guardText), 'session.mjs served with the guard');
  const S = await import('/session.mjs');   // (its top level calls no key function: audited by workstream 16)
  for (const f of ['keyFromSeed', 'publicKeyOf']) say(String(S[f]).includes(`key use blocked: ${f}`) && !String(S[f]).includes('subtle()'), `session.mjs ${f} is the refusal`);
  for (const m of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'unwrapKey', 'importKey']) {
    const src = String(crypto.subtle?.[m]);
    say(!!crypto.subtle && !src.includes('[native code]') && src.includes('key use blocked'), `subtle.${m} is the refusal`);
  }
  say(String(globalThis.Worker).includes('worker blocked'), 'Worker is the refusal');
  return out;
};

let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  srv.stage('holding');
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { await browser?.close(); await srv?.close(); });

test('the browser guard is installed, proven by source text only (no guarded entry is called)', { timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ locale: 'ja-JP', timezoneId: 'UTC' });
  await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
  await page.goto(`${base}/frontier/index.html`);
  await page.waitForFunction(() => document.body.dataset.stage && document.body.dataset.stage !== 'loading');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ws07:keyUses') ?? '[]')), [], 'the page booted with no key use');

  // ---- 1. the proof, from the outside: nothing key-shaped is called here
  // (installed by Playwright's own evaluate: the page's CSP does not allow eval)
  await page.evaluate(`window.__ws07sentinels = ${SENTINELS.toString()};`);
  const proof = await page.evaluate(g => window.__ws07sentinels(g), NK.SESSION_GUARD);
  assert.deepEqual([proof.secure, proof.subtle], [true, true], 'a secure context with WebCrypto');
  assert.deepEqual(proof.bad, [], 'the guard is installed: every sentinel holds (nothing was called)');
  assert.equal(proof.ok.length, 10);

  // (workstream 16, REPORT §29.38 A: the guarded entries are NOT called to see them refuse — calling keyFromSeed /
  // publicKeyOf / subtle generate·derive·sign·importKey, even with zero bytes against an installed guard, is a key-API
  // self-test and is not done. The proof is the sentinels above, by source text only.)
  // the test wallet's two sign functions are the refusal — read by source, never called
  const w = await page.evaluate(() => {
    const got = [];
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: x => got.push(x) } }));
    const wal = got.find(x => x.name === 'Test Wallet (no keys)');
    return { found: !!wal, srcs: [String(wal?.features['solana:signMessage']?.signMessage), String(wal?.features['solana:signTransaction']?.signTransaction)] };
  });
  assert.equal(w.found, true);
  assert.ok(w.srcs.every(x => x.includes('signs nothing')), 'the wallet\'s sign functions are the refusal (by source; not called)');

  // a reload keeps the record (the guard is installed again before the page's own scripts)
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.stage && document.body.dataset.stage !== 'loading');
  assert.equal(await page.evaluate(async () => String((await import('/session.mjs')).keyFromSeed).includes('key use blocked')), true, 'installed again after a reload');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ws07:keyUses') ?? '[]')), [], 'still no key use (nothing key-shaped was called)');
  await ctx.close();
});

test('fail-closed: with the guard missing, the proof fails — and nothing key-shaped is called to find out', { timeout: 60_000 }, async () => {
  // (no game code runs: the document is /session.mjs itself, shown as text, on the same origin; it is imported for its source)
  for (const [name, setup, bad] of [
    ['no guard at all', async () => {}, 10],
    ['the init script without the session.mjs route', async ctx => ctx.addInitScript(NK.init, NK.initArg(srv.viewer, { lang: 'ja' })), 3],
  ]) {
    const ctx = await browser.newContext();
    await setup(ctx);
    const page = await ctx.newPage();
    await page.goto(`${base}/session.mjs`);
    await page.evaluate(`window.__ws07sentinels = ${SENTINELS.toString()};`);
    const proof = await page.evaluate(g => window.__ws07sentinels(g), NK.SESSION_GUARD);
    assert.equal(proof.bad.length, bad, `${name}: ${bad} sentinels fail (${JSON.stringify(proof.bad)})`);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ws07:keyUses') ?? '[]')), [], `${name}: nothing was called`);
    await ctx.close();
  }
});
