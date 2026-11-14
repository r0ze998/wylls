#!/usr/bin/env node
// The English screen check of a local NFT world (frontier-stack `up --nft-pass`; runbook §5):
// a wallet without a pass sees the link to the mint page → it mints there → back in the game it
// re-reads its NFTs, picks a nation, joins with the NFT and builds its first village (PlaceHome through
// ResidentAct) → the pass goes A→B (TransferResident: by default from the mint page's transfer screen, A's
// wallet signing; `--transfer-via node` sends it from Node instead) → A's page no longer offers it, B's
// page plays the same Citizen.
//
//   node permutation-nft-resident-spike/demo/nft-world-screen-check.mjs --out <dir>
//        [--game http://127.0.0.1:41040/frontier/frontier/] [--mint http://127.0.0.1:41090/web/mint.html]
//        [--rpc http://127.0.0.1:41010] [--resident <program id>] [--transfer-via page|node]
//
// Test keys only: two fresh random seeds, kept in this process and the browser contexts' localStorage
// (the game page's Dev Wallet `ps-dev-wallet`, the mint page's test wallet `wylls-testwallet-seed`), never
// written to disk or printed. Loopback URLs only. Screenshots and a step log go to --out (keep it local).
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadPlaywright } from '../test/playwright.mjs';
import { keypair } from '../src/crypto.mjs';
import { RpcClient } from '../src/rpc-client.mjs';
import { TEST_PROGRAM_ID } from '../src/localnet.mjs';
import { decodeConfigAccount, pdas, signedTx, transferResidentIx } from '../src/resident-ix.mjs';
import { loopbackRpc } from '../src/mint-demo.mjs';
import { createHash } from 'node:crypto';
import { base58 } from '../src/crypto.mjs';
import { FrontierAddresses } from '../../permutation-gateway/client/src/frontier/addresses.mjs';
import { residentCitizen } from '../../permutation-gateway/client/src/frontier/resident.mjs';
import { citizenMark } from '../../permutation-gateway/src/frontier/resident-chain-gate.mjs';
import { LAYOUTS as V2 } from '../../permutation-gateway/client/src/frontier/abi-v2-layouts.mjs';
import { decodeResidentAccount } from '../src/resident-ix.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GAME = loopbackRpc(arg('--game', 'http://127.0.0.1:41040/frontier/frontier/')) + '/';
const MINT = loopbackRpc(arg('--mint', 'http://127.0.0.1:41090/web/mint.html'));
const RPC = loopbackRpc(arg('--rpc', 'http://127.0.0.1:41010'));
const RESIDENT = arg('--resident', TEST_PROGRAM_ID);
const FRONTIER = arg('--frontier', base58(new Uint8Array(32).fill(0x4e)));
const SEASON = BigInt(arg('--season', '7'));
const TRANSFER_VIA = arg('--transfer-via', 'page');
// --human-forms: Train and Muster as a person does them (one click into the field, keyboard typing, the world's own
// redraws arriving while the field has focus, one click on the button), with no retry: a form, value or focus lost
// under a redraw fails the run instead of being worked around.
const HUMAN_FORMS = process.argv.includes('--human-forms');
if (!['page', 'node'].includes(TRANSFER_VIA)) { console.error('--transfer-via page|node'); process.exit(2); }
const field = (kind, name) => V2.accounts.find(a => a.kind === kind).fields.find(f => f.name === name);
const chainLog = [];
const OUT = arg('--out');
if (!OUT) { console.error('--out <dir> is required (screenshots and the step log stay local)'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const pw = loadPlaywright();
if (!pw) { console.error('no playwright: (cd permutation-gateway/screens && npm ci)'); process.exit(2); }
const log = [];
const step = (name, detail = '') => { const line = `${new Date().toISOString().slice(11, 19)} ${name}${detail ? ` — ${detail}` : ''}`; log.push(line); console.log(line); };
const seedA = randomBytes(32).toString('hex'), seedB = randomBytes(32).toString('hex');
const A = keypair(Buffer.from(seedA, 'hex')), B = keypair(Buffer.from(seedB, 'hex'));

const browser = await pw.chromium.launch();
async function gamePage(seed, name) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(s => { try { localStorage.setItem('ps-dev-wallet', s); localStorage.setItem('ps-lang', 'en'); } catch { /* about:blank */ } }, seed);
  await ctx.addInitScript(installPressMonitor);
  const page = await ctx.newPage();
  page.on('pageerror', e => step(`${name} pageerror`, e.message));
  pages.push({ page, name });
  await page.goto(GAME);
  return page;
}
/**
 * The press monitor, in every game page from its first script: pointerdown / pointerup / click with the target's
 * action, whether it is in the drawer (#panel-body: the press gate's scope) or a hand pop-up (#hand, #hand-pop), still
 * in the page, disabled (aria-disabled or disabled), the element at the press point (an overlay shows there), the
 * drawer's scroll; and every replacement of the drawer's body content (a redraw). Read back with `pressLog(page)`.
 */
function installPressMonitor() {
  globalThis.__press = { events: [], redraws: [] };
  const where = t => (t?.closest?.('#panel-body') ? 'drawer' : t?.closest?.('#hand-pop') ? 'hand-pop' : t?.closest?.('#hand') ? 'hand' : 'page');
  const note = e => {
    const t = e.target instanceof Element ? e.target : null, a = t?.closest?.('[data-act]') ?? t;
    const at = Number.isFinite(e.clientX) ? document.elementFromPoint(e.clientX, e.clientY) : null;
    globalThis.__press.events.push({ type: e.type, t: Math.round(performance.now()), act: a?.dataset?.act ?? a?.tagName ?? null, item: a?.dataset?.item ?? null, where: where(t), connected: !!t?.isConnected,
      disabled: !!(a?.disabled || a?.getAttribute?.('aria-disabled') === 'true'), atPoint: at ? (at.closest('[data-act]')?.dataset.act ?? at.id ?? at.tagName) : null, atPointWhere: where(at), x: e.clientX ?? null, y: e.clientY ?? null, scroll: document.getElementById('panel-body')?.scrollTop ?? null });
    if (globalThis.__press.events.length > 400) globalThis.__press.events.shift();
  };
  for (const type of ['pointerdown', 'pointerup', 'click']) addEventListener(type, note, true);
  addEventListener('DOMContentLoaded', () => {
    const body = document.getElementById('panel-body');
    if (body) new MutationObserver(() => { globalThis.__press.redraws.push(Math.round(performance.now())); if (globalThis.__press.redraws.length > 400) globalThis.__press.redraws.shift(); }).observe(body, { childList: true });
  });
}
const pages = [];
const pressLog = page => page.evaluate(() => globalThis.__press ?? null).catch(() => null);
/** Everything about a page at a failure: screenshot, DOM, the press monitor's log. */
async function failureDump(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}-failure.png`), fullPage: true }).catch(() => {});
  writeFileSync(path.join(OUT, `${name}-failure.html`), await page.content().catch(() => ''));
  writeFileSync(path.join(OUT, `${name}-press-log.json`), `${JSON.stringify(await pressLog(page), null, 2)}\n`);
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }); };
const text = page => page.evaluate(() => document.body.innerText);
async function waitText(page, re, ms, name) {
  try { await page.waitForFunction(r => new RegExp(r).test(document.body.innerText), re.source, { timeout: ms }); }
  catch { await shot(page, `${name}-failed`); writeFileSync(path.join(OUT, `${name}-failed.txt`), await text(page)); throw new Error(`${name}: /${re.source}/ did not appear`); }
}
async function connectDevWallet(page, name) {
  // The entrance first shows an intro ("Choose a nation"); closing it opens the join drawer with the wallets.
  const intro = page.locator('[data-act="intro-close"]');
  try { await intro.first().waitFor({ state: 'visible', timeout: 15_000 }); await intro.first().click(); } catch { /* no intro */ }
  const btn = page.locator('[data-act="connect"]', { hasText: 'Dev Wallet' });
  try { await btn.first().waitFor({ state: 'visible', timeout: 30_000 }); } catch { /* already connected */ }
  if (await btn.count()) { await btn.first().click(); step(`${name}: connected the Dev Wallet`); }
}

/** The village tab of the drawer (the bottom bar's `holding` tab). */
async function openVillage(page) {
  // The dock's Village tab (#tabs), as the fixture screen tests press it, then wait until the village is what the
  // drawer shows (#holding-title). World 5's press log: `.first()` of every [data-act="tab"][data-tab="holding"]
  // pressed another element at (388, 574), the drawer stayed on "Selection" and Build was pressed where no Build
  // was on screen (the map was under the point).
  const tab = page.locator('#tabs [data-tab="holding"]');
  if (await tab.count()) await tab.first().click();
  else { const any = page.locator('[data-act="tab"][data-tab="holding"]').first(); if (await any.count()) await any.click(); }
  await page.locator('#holding-title').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
}
const REFUSALS = /This resident NFT is not in this wallet now|ResidentHolderChanged|ResidentGenerationStale|holder could not be confirmed/;

/** One village order from the drawer (`what`: build | train | muster); returns the page's text after the answer. */
async function villageOrder(page, name, what, { okText, waitEnabledMs = 120_000 } = {}) {
  await openVillage(page);
  let go;
  if (what === 'build') go = page.locator('[data-act="build"][data-item].br-go:not([disabled])').first();
  else {
    const form = page.locator(what === 'train' ? '#hp-train' : '#hp-muster');
    await form.waitFor({ state: 'attached', timeout: 30_000 });
    const field = form.locator(what === 'train' ? '#f-n' : '#f-troops');
    if (await field.count()) await field.fill('100');
    go = form.locator('button[type="submit"]');
  }
  const t0 = Date.now();
  const openFold = async () => { if (what === 'build') return; const f = page.locator(`details:has(${what === 'train' ? '#hp-train' : '#hp-muster'}):not([open]) > summary`); if (await f.count()) await f.first().click().catch(() => {}); };
  await openFold();
  while (!(await go.count()) || !(await go.isVisible().catch(() => false)) || await go.isDisabled()) {
    await openFold();
    if (Date.now() - t0 > waitEnabledMs) { await shot(page, `${name}-disabled`); throw new Error(`${name}: ${what} stayed unavailable`); }
    await page.waitForTimeout(3_000);
  }
  // The drawer re-renders on its own (the world's polling): a click on a node that was just replaced is retried on a
  // fresh lookup (and the count is filled again); a click is one order, so only a click that never landed is retried.
  for (let i = 0; ; i++) {
    try {
      await openVillage(page);
      if (HUMAN_FORMS && what === 'build') { await humanPress(page, '[data-act="build"][data-item].br-go:not([disabled])'); break; }
      if (what !== 'build') {
        const form = page.locator(what === 'train' ? '#hp-train' : '#hp-muster');
        // the village card shows one of the two forms open and the other in a fold, and which one depends on the
        // village's state: open the fold when the form is inside it
        const fold = page.locator(`details:has(${what === 'train' ? '#hp-train' : '#hp-muster'}):not([open]) > summary`);
        if (await fold.count()) await fold.first().click({ timeout: 5_000 });
        const field = form.locator(what === 'train' ? '#f-n' : '#f-troops');
        if (await field.count()) await field.fill('100', { timeout: 5_000 });
        go = form.locator('button[type="submit"]');
      }
      await go.click({ timeout: 5_000 });
      break;
    } catch (e) {
      if (i >= 5 || HUMAN_FORMS) {   // (--human-forms: one click, no retry)
        await shot(page, `${name}-click-failed`);
        const ids = await page.evaluate(() => [...document.querySelectorAll('[id^="hp-"], [data-act="tab"]')].map(e => `${e.id || e.dataset.tab}${e.closest('details:not([open])') ? '(folded)' : ''}${e.getAttribute('aria-selected') === 'true' ? '(selected)' : ''}`).join(' '));
        writeFileSync(path.join(OUT, `${name}-click-failed.txt`), `${ids}\n\n${await text(page)}`);
        throw e;
      }
      await page.waitForTimeout(1_000);
    }
  }
  await page.waitForFunction(([ok, bad]) => new RegExp(ok).test(document.body.innerText) || new RegExp(bad).test(document.body.innerText), [okText.source, REFUSALS.source], { timeout: 120_000 });
  return page.evaluate(() => document.body.innerText);
}

/**
 * One troops form as a person uses it, no retry (HUMAN_FORMS): open the village tab, open the form's fold if it is
 * folded (a person's click on its summary), click into the count, select it, type `value`; then keep the focus there
 * while the page redraws itself (the world's polling; a redraw replaces the form node, counted with a mark on the node)
 * until `redraws` redraws have happened and, for Train, the reserve has crossed 100 when it started below (the case
 * that used to swap the forms), or `holdMs` passed. Every 2 s it records the form's place, the value, the focus and the
 * fold. Then ONE click on the form's button. Returns the record; throws when the form, the value or the focus was lost.
 */
async function humanForm(page, name, what, value, { redraws = 2, holdMs = 240_000 } = {}) {
  const formSel = what === 'train' ? '#hp-train' : '#hp-muster', fieldSel = `${formSel} ${what === 'train' ? '#f-n' : '#f-troops'}`;
  await openVillage(page);
  const card = page.locator('section:has(#hp-troops-h)');
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  const reserveNow = async () => Number(((await card.locator('.c-count').first().textContent()) ?? '').replace(/[^\d]/g, '')) || 0;
  const r0 = await reserveNow();
  const state = () => page.evaluate(([formSel, fieldSel]) => {
    const f = document.querySelector(formSel), i = document.querySelector(fieldSel), s = document.querySelector('#hp-troops-h')?.closest('section');
    const forms = s ? [...s.querySelectorAll('form[data-form]')].map(x => `${x.dataset.form}${x.closest('details:not([open])') ? '(folded)' : ''}`) : [];
    return { redraws: globalThis.__redraws ?? 0, value: i?.value ?? null, focused: !!i && document.activeElement === i, folded: !!f?.closest('details:not([open])'), visible: !!i && i.offsetParent !== null, forms };
  }, [formSel, fieldSel]);
  const before = await state();
  if (before.folded) { await page.locator(`details:has(${formSel}) > summary`).first().click(); }
  const field = page.locator(fieldSel);
  await field.click();
  await field.press('ControlOrMeta+a');
  await page.keyboard.type(String(value), { delay: 80 });
  await page.evaluate(formSel => {
    globalThis.__redraws = 0;
    const tag = () => { const f = document.querySelector(formSel); if (f && !f.__probe) { if (globalThis.__probeOn) globalThis.__redraws++; f.__probe = 1; globalThis.__probeOn = true; } };
    globalThis.__probeOn = false; tag(); clearInterval(globalThis.__probeTimer); globalThis.__probeTimer = setInterval(tag, 50);
  }, formSel);
  const samples = [];
  const t0 = Date.now();
  for (;;) {
    await page.waitForTimeout(2_000);
    const st = { t: Math.round((Date.now() - t0) / 1000), reserve: await reserveNow(), ...(await state()) };
    samples.push(st);
    if (st.value !== String(value) || !st.focused || st.folded || !st.visible) {
      await shot(page, `${name}-lost`);
      writeFileSync(path.join(OUT, `${name}-lost.json`), `${JSON.stringify({ before, samples }, null, 2)}\n`);
      throw new Error(`${name}: the ${what} form lost ${st.value !== String(value) ? `its value (${st.value})` : !st.focused ? 'the focus' : 'its place (folded or hidden)'} after ${st.redraws} redraws`);
    }
    const crossed = what !== 'train' || r0 >= 100 || st.reserve >= 100;
    if (st.redraws >= redraws && crossed) break;
    if (Date.now() - t0 > holdMs) break;
  }
  await page.evaluate(() => clearInterval(globalThis.__probeTimer));
  await shot(page, `${name}-held`);
  const last = samples.at(-1);
  await humanPress(page, `${formSel} button[type="submit"]`);   // one press, no retry
  // held = the focus, value and place survived at least `redraws` redraws (a hold that ran out of time with fewer is
  // NOT a hold); crossed100 = the case that used to swap the forms happened during the hold (else: not observed)
  return { reserveAtStart: r0, before, samples, held: last, heldUnderRedraws: last.redraws >= redraws, redrawsWanted: redraws, crossed100: r0 < 100 && last.reserve >= 100 };
}

/**
 * A person's press on the button `sel` (--human-forms): bring it into view, then mouse down, ~120 ms, mouse up at its
 * centre — no actionability waits, no retry. A redraw that replaces the node puts the new one at the same place; the
 * page holds its drawer redraws while the press is down (app.mjs makePressGate), so the press ends on the node it
 * began on. Throws when there is no such button on screen.
 */
async function humanPress(page, sel) {
  const box = await page.evaluate(sel => { const el = document.querySelector(sel); if (!el || el.disabled) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, sel);
  if (!box) throw new Error(`no enabled ${sel} on screen to press`);
  // A person presses what they see standing still: wait (up to 3 s) until the button's centre has not moved for
  // 250 ms AND the element at that point is the button (the drawer slides in after a tab press: world 5 pressed the
  // map under a drawer still on its way). Looking, not a retry: nothing is pressed until then, and only once.
  const again = await page.evaluate(async sel => {
    const t0 = performance.now(); let last = null, since = performance.now();
    for (;;) {
      const el = document.querySelector(sel), r = el?.getBoundingClientRect();
      const c = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      const top = c ? document.elementFromPoint(c.x, c.y) : null;
      const hit = !!(top && el && (top === el || el.contains(top)));
      if (!c || !last || Math.abs(c.x - last.x) > 0.5 || Math.abs(c.y - last.y) > 0.5 || !hit) since = performance.now();
      last = c;
      if (c && hit && performance.now() - since >= 250) return { ...c, waitedMs: Math.round(performance.now() - t0) };
      if (performance.now() - t0 > 3000) return c ? { ...c, waitedMs: Math.round(performance.now() - t0), unsettled: true, hit } : null;
      await new Promise(r => requestAnimationFrame(r));
    }
  }, sel);
  const at = again ?? box;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const log = await pressLog(page);
  const tail = log ? { events: log.events.slice(-6), redrawsLast2s: log.redraws.filter(x => x > (log.events.at(-1)?.t ?? 0) - 2000).length } : null;
  writeFileSync(path.join(OUT, `press-${sel.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}-${Date.now()}.json`), `${JSON.stringify({ sel, at, tail }, null, 2)}\n`);
}

/** Harvest from the village screen (a player instruction; for an NFT, inside ResidentAct). Returns the page's answer. */
async function harvest(page, name, { waitEnabledMs = 180_000 } = {}) {
  const btn = page.locator('[data-act="harvest"]').first();
  if (!(await btn.isVisible().catch(() => false))) await openVillage(page);
  await btn.waitFor({ state: 'visible', timeout: 30_000 });
  const t0 = Date.now();
  while (await btn.isDisabled() && Date.now() - t0 < waitEnabledMs) await page.waitForTimeout(3_000);
  if (await btn.isDisabled()) { await shot(page, `${name}-harvest-disabled`); throw new Error(`${name}: Harvest stayed disabled for ${waitEnabledMs / 1000} s`); }
  await btn.click();
  await page.waitForFunction(() => /Harvest written into the stores|This resident NFT is not in this wallet now|ResidentHolderChanged|ResidentGenerationStale|holder could not be confirmed|refus/i.test(document.body.innerText), null, { timeout: 120_000 });
  return page.evaluate(() => document.body.innerText);
}

/** What the chain says about the pass now: the asset's owner, the resident generation, the NFT Citizen and its village. */
async function snapshot(label, asset) {
  const rpc = new RpcClient(RPC);
  const addrs = new FrontierAddresses({ programId: FRONTIER, seasonId: SEASON });
  const citizenKey = residentCitizen(addrs, asset);
  const [assetAcc, residentAcc, citizen] = await Promise.all([rpc.account(asset), rpc.account(pdas(RESIDENT).resident(asset)), rpc.account(citizenKey)]);
  const c = citizen ? Buffer.from(citizen.data) : null;
  const href = field('Citizen', 'HOLDING').off;
  const ref = c ? { p: c.readInt16LE(href), q: c.readInt16LE(href + 2), site: c[href + 4], gen: c[href + 5] } : null;
  const holdingKey = ref ? addrs.holding(ref.p, ref.q, ref.site) : null;
  const holding = holdingKey ? await rpc.account(holdingKey) : null;
  const h = holding ? Buffer.from(holding.data) : null;
  const st = field('Holding', 'STORES');
  const stores = h ? Array.from({ length: st.len / 8 }, (_, i) => h.readBigUInt64LE(st.off + 8 * i).toString()) : null;
  const snap = {
    label, at: new Date().toISOString(),
    assetOwner: assetAcc ? base58(Uint8Array.from(assetAcc.data).slice(1, 33)) : null,
    generation: residentAcc ? decodeResidentAccount(residentAcc.data)?.gen ?? null : null,
    citizen: citizenKey, citizenMark: c ? citizenMark(c) : null, citizenSha256: c ? createHash('sha256').update(c).digest('hex') : null,
    holding: holdingKey, holdingRef: ref,
    holdingOwnerCitizen: h ? base58(h.subarray(field('Holding', 'OWNER_CITIZEN').off, field('Holding', 'OWNER_CITIZEN').off + 32)) : null,
    lastOwnerAction: h ? h.readBigInt64LE(field('Holding', 'LAST_OWNER_ACTION').off).toString() : null,
    stores, holdingSha256: h ? createHash('sha256').update(h).digest('hex') : null,
  };
  chainLog.push(snap);
  writeFileSync(path.join(OUT, 'chain.json'), `${JSON.stringify(chainLog, null, 2)}\n`);
  return snap;
}
const storesTotal = s => (s.stores ?? []).reduce((t, v) => t + BigInt(v), 0n);

let failed = null;
try {
  // 1. A without a pass: the link to the mint page.
  const a = await gamePage(seedA, 'A');
  await connectDevWallet(a, 'A');
  await waitText(a, /This wallet holds no resident NFT \(entry pass\)/, 60_000, '1-no-pass');
  const href = await a.locator('[data-act-link="nft-mint"]').getAttribute('href');
  if (href !== `${MINT}?lang=en`) throw new Error(`the mint link is ${href}, not ${MINT}?lang=en (the game is in English)`);
  await shot(a, '1-no-pass'); step('1 no pass: the join card links to the mint page', href);

  // 2. Mint on the mint page with the same key.
  const mctx = await browser.newContext();
  await mctx.addInitScript(s => { try { localStorage.setItem('wylls-testwallet-seed', s); localStorage.setItem('wylls-mint-lang', 'en'); } catch { /* */ } }, seedA);
  const m = await mctx.newPage();
  await m.goto(MINT);
  await m.waitForFunction(() => globalThis.__testWallet?.address);
  if (await m.evaluate(() => globalThis.__testWallet.address) !== A.publicKey) throw new Error('the mint page wallet is not A');
  await fetch(new URL('/mock/airdrop', MINT), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: A.publicKey, lamports: '2000000000' }) });
  await m.locator('[data-wallet]').first().click();
  await waitText(m, /Ready to mint/, 60_000, '2-mint-ready');
  await m.getByTestId('mint').click();
  await waitText(m, /Your pass is ready/, 120_000, '2-minted');
  const asset = (await m.getByTestId('asset').textContent())?.trim();
  await shot(m, '2-minted'); step('2 minted on the mint page', asset);

  // 3. Back in the game: check again → choose a nation → join with the NFT.
  await a.locator('[data-act="nft-reload"]').click();
  await waitText(a, /Join with this NFT|Choose a nation/, 60_000, '3-listed');
  await a.locator('[data-act="pick-faction"]').first().click();
  await waitText(a, /Join with this NFT/, 30_000, '3-pick');
  await a.locator('[data-act="nft-login"]').first().click();
  await waitText(a, /Playing as an NFT|first village|Build the village/i, 180_000, '3-joined');
  await shot(a, '3-joined'); step('3 joined with the NFT (JoinResident)');

  // 4. Act: the first village (PlaceHome inside ResidentAct, signed by A's wallet).
  const home = a.locator('[data-act="home-confirm"]');
  if (await home.count()) {
    await home.first().click();
    await a.waitForFunction(() => !document.querySelector('[data-act="home-confirm"]'), null, { timeout: 180_000 });
  }
  await shot(a, '4-acted');
  let sA = await snapshot('after A\'s first village', asset);
  for (let i = 0; i < 40 && !sA.holdingOwnerCitizen; i++) { await a.waitForTimeout(3_000); sA = await snapshot('after A\'s first village', asset); }
  if (sA.assetOwner !== A.publicKey || sA.generation !== 0 || !sA.citizenMark?.nft || sA.holdingOwnerCitizen !== sA.citizen) throw new Error(`after A's village the chain says ${JSON.stringify(sA)}`);
  step('4 acted (first village): on chain the NFT Citizen holds it, owner A, generation 0', sA.holding);
  // --probe-redraws: on A's village tab, 20 s of watching how often the village panel's controls are replaced and
  // what text changes between two redraws (read only: no click), then stop.
  if (process.argv.includes('--probe-redraws')) {
    await openVillage(a);
    await a.waitForTimeout(2_000);
    const probe = await a.evaluate(async () => {
      const pick = () => document.querySelector('#hp-build [data-act="build"]') ?? document.querySelector('[data-act="harvest"]');
      const card = () => document.querySelector('#hp-build')?.closest('[data-key], section, div') ?? document.body;
      let node = pick(), replaced = 0, texts = [], last = card()?.innerText ?? '';
      const t0 = performance.now(), times = [];
      await new Promise(res => { const iv = setInterval(() => {
        const n = pick();
        if (n && n !== node) { replaced++; times.push(Math.round(performance.now() - t0)); const now = card()?.innerText ?? ''; if (now !== last && texts.length < 6) { const a = last.split('\n'), b = now.split('\n'); texts.push(b.filter((l, i) => l !== a[i]).slice(0, 4)); } last = now; node = n; }
        if (performance.now() - t0 > 20_000) { clearInterval(iv); res(); }
      }, 20); });
      return { replaced, times: times.slice(0, 40), changedLines: texts, target: pick()?.outerHTML?.slice(0, 160) ?? null };
    });
    writeFileSync(path.join(OUT, 'redraw-probe.json'), `${JSON.stringify(probe, null, 2)}\n`);
    step('probe: village controls replaced', `${probe.replaced} times in 20 s; changed lines ${JSON.stringify(probe.changedLines).slice(0, 300)}`);
    throw new Error('probe done (not a failure of the product)');
  }
  // 4b. A reload with the remembered wallet still offers the pass (the boot's silent reconnect reads the NFT list).
  await a.reload();
  await connectDevWallet(a, 'A');
  await waitText(a, /Play this NFT|Playing as an NFT|This is your village|Harvest/, 60_000, '4b-reload');
  const login = a.locator('[data-act="nft-login"]');
  if (await login.count() && await login.first().isVisible()) {
    await login.first().click();
  }
  await a.locator('[data-act="harvest"]').first().waitFor({ state: 'visible', timeout: 90_000 });
  await shot(a, '4b-reload'); step('4b reload: the pass is offered again');

  // 5. Transfer A→B (TransferResident), then A's page no longer offers the pass; B's plays it.
  if (TRANSFER_VIA === 'page') {
    // The mint page's transfer screen, A's wallet signing: a refusal first (to itself), then the review and the send.
    await m.reload();
    await m.locator('[data-wallet]').first().click();
    await waitText(m, /You hold the pass/, 60_000, '5-mint-holds');
    await m.getByTestId('t-to').fill(A.publicKey);
    await m.getByTestId('t-review').click();
    await m.waitForFunction(() => /cannot transfer to your own wallet/.test(document.querySelector('[data-testid="t-status"]').textContent), null, { timeout: 30_000 });
    step('5 transfer screen: a transfer to itself is refused before signing');
    await m.getByTestId('t-to').fill(B.publicKey);
    await m.getByTestId('t-review').click();
    await m.getByTestId('t-confirm').waitFor({ state: 'visible', timeout: 30_000 });
    const shown = { asset: (await m.getByTestId('t-asset-full').textContent()).trim(), from: (await m.getByTestId('t-from').textContent()).trim(), to: (await m.getByTestId('t-dest').textContent()).trim() };
    if (shown.asset !== asset || shown.from !== A.publicKey || shown.to !== B.publicKey) throw new Error(`the transfer review shows ${JSON.stringify(shown)}`);
    await shot(m, '5-transfer-review');
    await m.getByTestId('t-ack').check();
    await m.getByTestId('t-send').click();
    await m.waitForFunction(() => /Transferred \(confirmed on the chain\)/.test(document.querySelector('[data-testid="t-status"]').textContent), null, { timeout: 120_000 });
    await shot(m, '5-transfer-done');
    step('5 TransferResident A→B from the mint page\'s transfer screen', (await m.getByTestId('t-status').textContent()).trim());
  } else {
    const rpc = new RpcClient(RPC);
    const cfg = decodeConfigAccount((await rpc.account(pdas(RESIDENT).config)).data);
    const { blockhash } = await rpc.latestBlockhash();
    const tx = signedTx({ feePayer: A.publicKey, blockhash, instructions: [transferResidentIx({ program: RESIDENT, owner: A.publicKey, asset, collection: cfg.collection, to: B.publicKey })], signers: [A] });
    const st = await rpc.confirm(await rpc.send(tx.wire));
    if (!st || st.err) throw new Error(`TransferResident failed: ${JSON.stringify(st?.err)}`);
    step('5 TransferResident A→B (from Node)');
  }
  // 5a. A's page, still open as the NFT's player from before the transfer, acts: refused before anything is signed.
  const s0 = await snapshot('after the transfer, before A acts', asset);
  if (s0.assetOwner !== B.publicKey || s0.generation !== 1) throw new Error(`after the transfer the chain says owner ${s0.assetOwner}, generation ${s0.generation}`);
  if (s0.holdingOwnerCitizen !== s0.citizen) throw new Error('the village is not the NFT Citizen\'s');
  const aText = await harvest(a, '5a-a-acts');
  await shot(a, '5a-a-refused');
  if (!/This resident NFT is not in this wallet now/.test(aText)) throw new Error('A was not shown the refusal after the transfer');
  const s1 = await snapshot('after A\'s refused action', asset);
  for (const k of ['assetOwner', 'generation', 'citizenSha256', 'holdingSha256', 'lastOwnerAction']) {
    if (JSON.stringify(s1[k]) !== JSON.stringify(s0[k])) throw new Error(`A's refused action changed ${k} on chain`);
  }
  step('5a A (stale page) acts: refused on screen, nothing changed on chain', 'This resident NFT is not in this wallet now.');
  // 5a2. The same stale page tries to build: refused the same way, the chain unchanged.
  // (--human-forms: one look and one click, no retry. A page that no longer offers Build at all — the village's
  // controls gone after the refusal — is recorded as that, not as a refusal message.)
  let aBuild, aBuildHow = 'refused';
  if (HUMAN_FORMS) {
    await openVillage(a);
    await a.waitForTimeout(1_500);
    const go = a.locator('[data-act="build"][data-item].br-go:not([disabled])');
    if (!(await go.count()) || !(await go.first().isVisible().catch(() => false))) { aBuildHow = 'not offered'; aBuild = await text(a); }
    else {
      await humanPress(a, '[data-act="build"][data-item].br-go:not([disabled])');
      await a.waitForFunction(([ok, bad]) => new RegExp(ok).test(document.body.innerText) || new RegExp(bad).test(document.body.innerText), ['building begun', REFUSALS.source], { timeout: 120_000 });
      aBuild = await text(a);
    }
  } else aBuild = await villageOrder(a, '5a2-a-build', 'build', { okText: /building begun/ });
  await shot(a, '5a2-a-build-refused');
  if (/building begun/.test(aBuild) || (aBuildHow === 'refused' && !REFUSALS.test(aBuild))) throw new Error('A\'s build after the transfer was not refused');
  const s1b = await snapshot('after A\'s refused build', asset);
  for (const k of ['assetOwner', 'generation', 'citizenSha256', 'holdingSha256', 'lastOwnerAction']) {
    if (JSON.stringify(s1b[k]) !== JSON.stringify(s0[k])) throw new Error(`A's refused build changed ${k} on chain`);
  }
  step(aBuildHow === 'refused' ? '5a2 A (stale page) builds: refused on screen, nothing changed on chain' : '5a2 A (stale page): Build is no longer offered (no build button), nothing changed on chain');
  await a.reload();
  await connectDevWallet(a, 'A');
  await waitText(a, /This wallet holds no resident NFT|Enter with a resident NFT/, 60_000, '5-a-after');
  if (/Play this NFT/.test(await text(a))) throw new Error('A is still offered the pass after the transfer');
  await shot(a, '5-a-after'); step('5 A: the pass is no longer offered');
  const b = await gamePage(seedB, 'B');
  await connectDevWallet(b, 'B');
  await waitText(b, /Play this NFT/, 60_000, '5-b-listed');
  await b.locator('[data-act="nft-login"]').first().click();
  // (B's Citizen has a village: the join drawer, which carries the "Playing as an NFT" card, closes; the village shows)
  await b.locator('[data-act="harvest"]').first().waitFor({ state: 'visible', timeout: 90_000 });
  await shot(b, '5-b-plays'); step('5 B plays the same Citizen');
  // 6. B changes state from the screen: a harvest (ResidentAct signed by B's wallet at the new generation).
  const s2 = await snapshot('before B harvests', asset);
  const bText = await harvest(b, '6-b-acts');
  await shot(b, '6-b-acted');
  if (!/Harvest written into the stores/.test(bText)) throw new Error('B\'s harvest did not go through');
  let s3 = await snapshot('after B harvests', asset);
  for (let i = 0; i < 20 && s3.holdingSha256 === s2.holdingSha256; i++) { await b.waitForTimeout(1_500); s3 = await snapshot('after B harvests', asset); }
  if (s3.holdingSha256 === s2.holdingSha256) throw new Error('B\'s harvest did not change the village on chain');
  if (!(storesTotal(s3) > storesTotal(s2))) throw new Error(`the stores did not grow: ${storesTotal(s2)} → ${storesTotal(s3)}`);
  if (BigInt(s3.lastOwnerAction) <= BigInt(s2.lastOwnerAction)) throw new Error('LAST_OWNER_ACTION did not move');
  if (s3.assetOwner !== B.publicKey || s3.generation !== 1 || s3.holdingOwnerCitizen !== s3.citizen) throw new Error('owner, generation or village owner changed');
  step('6 B harvested: the stores grew on chain', `${storesTotal(s2)} → ${storesTotal(s3)}, last owner action ${s2.lastOwnerAction} → ${s3.lastOwnerAction}, owner B, generation 1`);
  // 7. B's drawer shows no nation choice once its Citizen has answered.
  await b.waitForTimeout(3_000);
  if (/Choose a nation to begin/.test(await text(b))) { await shot(b, '7-b-nation-choice'); throw new Error('B still sees the nation choice'); }
  step('7 B: no nation choice beside its village');
  // 8–10. B's village orders from the drawer, each checked on chain (the village's bytes move; owner B, generation 1).
  // With --human-forms, Train and Muster go through humanForm (typed counts 120 and 100, no retry).
  const human = {};
  for (const [n, what, ok, label] of [[8, 'build', /building begun/, 'built'], [9, 'train', /trained: they joined the reserve/, HUMAN_FORMS ? 'trained 120 (typed)' : 'trained 100'], [10, 'muster', /ordered to form up/, 'mustered 100']]) {
    if (HUMAN_FORMS && what !== 'build') {
      const before = await snapshot(`before B ${what}`, asset);
      const rec = await humanForm(b, `${n}-b-${what}`, what, what === 'train' ? 120 : 100);
      human[what] = rec;
      writeFileSync(path.join(OUT, 'human-forms.json'), `${JSON.stringify(human, null, 2)}\n`);
      await b.waitForFunction(([ok, bad]) => new RegExp(ok).test(document.body.innerText) || new RegExp(bad).test(document.body.innerText), [ok.source, REFUSALS.source], { timeout: 120_000 });
      const out = await text(b);
      await shot(b, `${n}-b-${what}`);
      if (!ok.test(out)) throw new Error(`B's ${what} did not go through`);
      let after = await snapshot(`after B ${what}`, asset);
      for (let i = 0; i < 20 && after.holdingSha256 === before.holdingSha256; i++) { await b.waitForTimeout(1_500); after = await snapshot(`after B ${what}`, asset); }
      step(`${n} B ${label}: one click after holding the typed count`, `${rec.heldUnderRedraws ? `focus, value and place kept through ${rec.held.redraws} redraws` : `NOT CONFIRMED under redraws: only ${rec.held.redraws} redraw(s) seen before the hold's time ran out`}; reserve ${rec.reserveAtStart} → ${rec.held.reserve}${what === 'train' ? (rec.crossed100 ? ' (crossed 100 during the hold)' : ' (did NOT cross 100 during the hold: that case is not confirmed here)') : ''}; forms ${rec.held.forms.join(' ')}; value ${rec.held.value}`);
      continue;
    }
    const before = await snapshot(`before B ${what}`, asset);
    const out = await villageOrder(b, `${n}-b-${what}`, what, { okText: ok });
    await shot(b, `${n}-b-${what}`);
    if (!ok.test(out)) throw new Error(`B's ${what} did not go through`);
    let after = await snapshot(`after B ${what}`, asset);
    for (let i = 0; i < 20 && after.holdingSha256 === before.holdingSha256; i++) { await b.waitForTimeout(1_500); after = await snapshot(`after B ${what}`, asset); }
    if (after.holdingSha256 === before.holdingSha256) throw new Error(`B's ${what} did not change the village on chain`);
    if (after.assetOwner !== B.publicKey || after.generation !== 1 || after.holdingOwnerCitizen !== after.citizen) throw new Error(`owner, generation or village owner changed after B's ${what}`);
    step(`${n} B ${label}: the village changed on chain`, `owner B, generation 1, last owner action ${before.lastOwnerAction} → ${after.lastOwnerAction}`);
  }
  // 11. B marches (Depart inside ResidentAct, B's wallet signing: fresident.marchSubmitFor). The host formed by the muster
  // is ready once the world has processed the formation; the destination is given by coordinates (the drawer's
  // "Choose by coordinates"), tiles of the same province tried in turn until the route is planned.
  const provinceSha = async (p, q) => { const acc = await new RpcClient(RPC).account(new FrontierAddresses({ programId: FRONTIER, seasonId: SEASON }).province(p, q)); return acc ? createHash('sha256').update(Buffer.from(acc.data)).digest('hex') : null; };
  const hostsTab = b.locator('[data-act="tab"][data-tab="hosts"]');
  const t11 = Date.now();
  let compose = b.locator('[data-act="compose"]:not([disabled])');
  while (!(await compose.count())) {
    if (Date.now() - t11 > 15 * 60_000) { await shot(b, '11-host-not-ready'); writeFileSync(path.join(OUT, '11-host-not-ready.txt'), await text(b)); throw new Error('11: the host stayed unready for 15 min'); }
    if (await hostsTab.count()) await hostsTab.first().click();
    await b.waitForTimeout(10_000);
    compose = b.locator('[data-act="compose"]:not([disabled])');
  }
  await shot(b, '11-host-ready'); step('11 B: the host is formed and may march', `${Math.round((Date.now() - t11) / 1000)} s after the muster`);
  const s11a = await snapshot('before B departs', asset);
  const { p: P, q: Q } = s11a.holdingRef;
  const prov11a = await provinceSha(P, Q);
  await compose.first().click();
  const destForm = b.locator('form[data-form="dest"]');
  await destForm.waitFor({ state: 'attached', timeout: 30_000 });
  const send = b.locator('[data-act="march-send"]');
  let dest = null;
  for (const tile of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter(t => t !== s11a.holdingRef.site)) {
    if (!(await destForm.isVisible())) await b.locator('details:has(form[data-form="dest"]) > summary').first().click();
    await destForm.locator('input[name="p"]').fill(String(P));
    await destForm.locator('input[name="q"]').fill(String(Q));
    await destForm.locator('input[name="tile"]').fill(String(tile));
    await destForm.locator('button[type="submit"]').click();
    await b.waitForTimeout(2_500);
    if (await send.count() && !(await send.first().isDisabled())) { dest = { p: P, q: Q, tile }; break; }
  }
  if (!dest) { await shot(b, '11-no-route'); writeFileSync(path.join(OUT, '11-no-route.txt'), await text(b)); throw new Error('11: no destination tile in the home province got a route'); }
  await shot(b, '11-march-order');
  await send.first().click();
  await b.waitForFunction(() => /Sealed and on its way\. It arrives on turn|Departed\. The turn changed|did not work|not in this wallet now|NftNotHeld|refus/i.test(document.body.innerText), null, { timeout: 180_000 });
  const t11out = await text(b);
  await shot(b, '11-b-depart');
  const arrive = /It arrives on turn ([\d,]+)/.exec(t11out)?.[1] ?? /arrival moved from turn [\d,]+ to turn ([\d,]+)/.exec(t11out)?.[1];
  if (!arrive) throw new Error(`11: B's march was not sent: ${(t11out.match(/.{0,80}(did not work|refus|NftNotHeld).{0,120}/i) ?? [''])[0]}`);
  let s11b = await snapshot('after B departs', asset);
  let prov11b = await provinceSha(P, Q);
  for (let i = 0; i < 20 && prov11b === prov11a && s11b.holdingSha256 === s11a.holdingSha256; i++) { await b.waitForTimeout(1_500); s11b = await snapshot('after B departs', asset); prov11b = await provinceSha(P, Q); }
  if (prov11b === prov11a && s11b.holdingSha256 === s11a.holdingSha256) throw new Error('11: the march changed neither the province nor the village on chain');
  if (s11b.assetOwner !== B.publicKey || s11b.generation !== 1) throw new Error('11: owner or generation changed with the march');
  step('11 B departed (Depart inside ResidentAct, B\'s wallet): the chain changed', `to (${dest.p},${dest.q}) tile ${dest.tile}, arrives on turn ${arrive}; province ${prov11a?.slice(0, 12)} → ${prov11b?.slice(0, 12)}, village ${s11a.holdingSha256.slice(0, 12)} → ${s11b.holdingSha256.slice(0, 12)}; owner B, generation 1`);

  // 12. A screen-level signal of the march's result: the host stops being away and the province changes again. This
  // does not prove the reveal (the world's own processing changes the province too): demo/nft-world-tx-evidence.mjs
  // reads the REVEAL and settlement transactions of this host. Waited for up to 25 min; if it does not come, the step is recorded as not confirmed.
  const t12 = Date.now();
  let back = false, prov12 = prov11b;
  while (Date.now() - t12 < 25 * 60_000) {
    await b.waitForTimeout(15_000);
    if (await hostsTab.count()) await hostsTab.first().click();
    const tx12 = await text(b);
    prov12 = await provinceSha(P, Q);
    if (!/Away on a march/.test(tx12) && prov12 !== prov11b) { back = true; break; }
  }
  await shot(b, '12-b-result');
  const s12 = await snapshot('after the march result', asset);
  if (back) step('12 screen signal only: the host is no longer away and the province changed again (the reveal itself is proven only by demo/nft-world-tx-evidence.mjs)', `${Math.round((Date.now() - t12) / 1000)} s after the send; owner ${s12.assetOwner === B.publicKey ? 'B' : s12.assetOwner}, generation ${s12.generation}`);
  else step('12 NOT CONFIRMED: no march result within 25 min', `province ${prov11b?.slice(0, 12)} → ${prov12?.slice(0, 12)}; see 12-b-result.png`);
} catch (e) {
  failed = e.message;
  for (const { page, name } of pages) await failureDump(page, `FAILED-${name}`);
  step('FAILED', e.message);
} finally {
  writeFileSync(path.join(OUT, 'steps.log'), `${log.join('\n')}\n`);
  await browser.close();
}
process.exit(failed ? 1 : 0);
