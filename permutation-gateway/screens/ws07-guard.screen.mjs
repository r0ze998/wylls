// Workstream 07: the BROWSER key guard of screens/ws07/nokey-page.mjs is installed, and refuses at the entry —
// before any derivation runs. (The Node guard, tools/nokeys.mjs / NOKEYS_LOG, is a separate thing: it guards the
// test process and the fixture server; this file checks only what runs in the page.)
//
// In a page opened as every keyless whole-page test opens it (NK.launchOptions + NK.prepare):
//   - the page is a secure context (WebCrypto present: the flag is honoured by the full Chromium);
//   - web/session.mjs, as served, has its key functions replaced: keyFromSeed and publicKeyOf refuse at once, and
//     WebCrypto's digest — the first step of the real publicKeyOf — is NOT called by them (counted);
//   - WebCrypto's generateKey, deriveBits, sign and a pkcs8 importKey refuse;
//   - the test wallet refuses signMessage and signTransaction;
//   - each refusal is recorded in the page (window.__keyUses and localStorage 'ws07:keyUses'), in order.
// The inputs handed to the refused entries are zero bytes and no wallet message is built: nothing is derived,
// generated or signed. This is the only file that calls the guarded entries on purpose; every other keyless test
// asserts that the record stays EMPTY (NK.assertKeyless).
//
// FAIL-CLOSED (workstream 16's audit G1, 2026-11-08): no guarded entry is called until the guard is proven from the
// outside, without calling anything key-shaped — the served web/session.mjs text ends with NK.SESSION_GUARD; the
// module's keyFromSeed / publicKeyOf are the replacement bodies (their source says 'key use blocked', not the real
// one); every guarded crypto.subtle method's source is the replacement (not '[native code]'); the test wallet's two
// sign functions are the refusal; Worker is the refusal. If any check fails the test stops there, having called
// nothing. The calls themselves run in a page function that checks the same sentinels again first and calls nothing
// if one fails. Scope: the page realm only. Node (tools/nokeys.mjs) is separate; Worker realms are not guarded,
// only refused (the page makes a Worker only to seal, which no keyless test does).
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

test('the browser guard is installed and refuses at the entry (no derivation runs); every refusal is recorded', { timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ locale: 'ja-JP', timezoneId: 'UTC' });
  await NK.prepare(ctx, srv.viewer, { lang: 'ja' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
  await page.goto(`${base}/frontier/index.html`);
  await page.waitForFunction(() => document.body.dataset.stage && document.body.dataset.stage !== 'loading');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ws07:keyUses') ?? '[]')), [], 'the page booted with no key use');

  // ---- 1. the proof, from the outside: nothing key-shaped is called here
  // (kept in the page for step 2, installed by Playwright's own evaluate: the page's CSP does not allow eval)
  await page.evaluate(`window.__ws07sentinels = ${SENTINELS.toString()};`);
  const proof = await page.evaluate(g => window.__ws07sentinels(g), NK.SESSION_GUARD);
  assert.deepEqual([proof.secure, proof.subtle], [true, true], 'a secure context with WebCrypto');
  assert.deepEqual(proof.bad, [], 'the guard is installed: every sentinel holds (nothing was called)');
  assert.equal(proof.ok.length, 10);

  // ---- 2. the refusals: the page function checks the sentinels again and calls nothing if one fails
  const r = await page.evaluate(async guardText => {
    const check = typeof window.__ws07sentinels === 'function' ? await window.__ws07sentinels(guardText) : { bad: ['no sentinel check in the page'] };
    if (check.bad.length) return { aborted: check.bad };
    const out = {};
    // count WebCrypto's digest from here on: the real publicKeyOf starts with digest('SHA-512', seed)
    let digests = 0;
    const d = crypto.subtle.digest.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, 'digest', { value: (...a) => { digests++; return d(...a); } });
    const refused = async f => { try { await f(); return 'went through'; } catch (e) { return String(e.message); } };
    const S = await import('/session.mjs');
    const zero = new Uint8Array(32);
    out.keyFromSeed = await refused(() => S.keyFromSeed(zero));
    out.publicKeyOf = await refused(() => S.publicKeyOf(zero));
    out.digestsBySession = digests;
    out.generateKey = await refused(() => crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']));
    out.deriveBits = await refused(() => crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: zero, info: zero }, null, 256));
    out.sign = await refused(() => crypto.subtle.sign({ name: 'Ed25519' }, null, zero));
    out.importPkcs8 = await refused(() => crypto.subtle.importKey('pkcs8', zero, { name: 'Ed25519' }, false, ['sign']));
    out.uses = [...window.__keyUses];
    out.stored = JSON.parse(localStorage.getItem('ws07:keyUses') ?? '[]');
    return out;
  }, NK.SESSION_GUARD);
  assert.equal(r.aborted, undefined, `the page found a sentinel broken and called nothing: ${JSON.stringify(r.aborted)}`);
  assert.equal(r.keyFromSeed, 'key use blocked: keyFromSeed');
  assert.equal(r.publicKeyOf, 'key use blocked: publicKeyOf');
  assert.equal(r.digestsBySession, 0, 'refused at the entry: the derivation\'s first step (digest) never ran');
  for (const k of ['generateKey', 'deriveBits', 'sign']) assert.equal(r[k], `key use blocked: ${k}`);
  assert.equal(r.importPkcs8, 'key use blocked');
  const expected = ['keyFromSeed', 'publicKeyOf', 'generateKey', 'deriveBits', 'sign', 'importKey:pkcs8'];
  assert.deepEqual(r.uses, expected, 'each refusal recorded in the page, in order');
  assert.deepEqual(r.stored, expected, 'and in its storage (kept across reloads)');

  // the test wallet refuses to sign (asked through Wallet Standard's registration, as the page's wallet module is)
  const w = await page.evaluate(async () => {
    const got = [];
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: x => got.push(x) } }));
    const wal = got.find(x => x.name === 'Test Wallet (no keys)');
    // (fail-closed: the two sign functions must be the refusal before either is called)
    const srcs = [String(wal?.features['solana:signMessage']?.signMessage), String(wal?.features['solana:signTransaction']?.signTransaction)];
    if (!srcs.every(x => x.includes('signs nothing'))) return { found: !!wal, aborted: srcs };
    const refused = async f => { try { await f(); return 'went through'; } catch (e) { return String(e.message); } };
    return { found: !!wal, msg: await refused(() => wal.features['solana:signMessage'].signMessage({ message: new Uint8Array(0) })), tx: await refused(() => wal.features['solana:signTransaction'].signTransaction({ transaction: new Uint8Array(0) })), uses: JSON.parse(localStorage.getItem('ws07:keyUses')) };
  });
  assert.equal(w.found, true);
  assert.equal(w.aborted, undefined, 'the wallet\'s sign functions are the refusal (checked before calling)');
  assert.equal(w.msg, 'this test wallet has no key and signs nothing');
  assert.equal(w.tx, 'this test wallet has no key and signs nothing');
  assert.deepEqual(w.uses.slice(-2), ['wallet sign asked', 'wallet sign asked']);

  // a reload keeps the record (the guard is installed again before the page's own scripts)
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.stage && document.body.dataset.stage !== 'loading');
  assert.equal(await page.evaluate(async () => String((await import('/session.mjs')).keyFromSeed).includes('key use blocked')), true, 'installed again after a reload');
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('ws07:keyUses')))).length, expected.length + 2);
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
