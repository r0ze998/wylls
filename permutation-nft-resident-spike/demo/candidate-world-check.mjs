#!/usr/bin/env node
// The English screen check of a LOCAL TEST CANDIDATE world (conquest lane + NFT residents; program [0x4C; 32], version
// 0xC804; NOT an allocation, never deployable), started by the local-play launcher with `--lane-candidate`:
//
//   start      the game page opens local play through its own gate (`?localPlay=1&launcher=1`): the page makes its
//              memory-only wallet B, shows B's public address, and the launcher starts B's world
//   mint       the mint page's test wallet A (a fresh random seed, in that browser context only) mints a pass
//   transfer   A transfers the pass to B on the mint page's transfer screen (TransferResident, A signing)
//   join       back in the game, B re-reads its passes (the village screen's NFT card), picks a nation and joins with the
//              NFT (JoinResident through the world relay); the page then plays as the NFT's Citizen
//   (not yet:  build / train / muster as the NFT (0xE2), the march / territory (0xDD), the pass sold away from B and the
//              old / new owner — listed in the doc as not done)
//
// Every stage is checked on screen AND on the chain (the world's loopback RPC): the asset's Core owner, the resident
// record's generation, the NFT Citizen's resident mark. Test keys only (A's seed and the page's own memory-only key);
// nothing is written to disk but screenshots, the step log and the JSON summary in --out (keep it local).
//
//   node permutation-nft-resident-spike/demo/candidate-world-check.mjs --out <dir>
//        --game http://127.0.0.1:41920/frontier/frontier/ --mint http://127.0.0.1:41995/web/mint.html --rpc http://127.0.0.1:41980
//        [--stages start,mint,transfer,join]
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadPlaywright } from '../test/playwright.mjs';
import { keypair, base58 } from '../src/crypto.mjs';
import { RpcClient } from '../src/rpc-client.mjs';
import { decodeResidentAccount, pdas } from '../src/resident-ix.mjs';
import { loopbackRpc } from '../src/mint-demo.mjs';
import { residentCitizen, decodeAssetOwner } from '../../permutation-gateway/client/src/frontier/resident.mjs';
import { citizenMark } from '../../permutation-gateway/src/frontier/resident-chain-gate.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out');
if (!OUT) { console.error('--out <dir> is required (screenshots and the step log stay local)'); process.exit(2); }
const GAME = new URL(loopbackRpc(arg('--game', 'http://127.0.0.1:41920/frontier/frontier/')));
GAME.searchParams.set('localPlay', '1'); GAME.searchParams.set('launcher', '1');
const MINT = loopbackRpc(arg('--mint', 'http://127.0.0.1:41995/web/mint.html'));
const RPC = loopbackRpc(arg('--rpc', 'http://127.0.0.1:41980'));
const STAGES = new Set(arg('--stages', 'start,mint,transfer,join').split(','));
const CANDIDATE = base58(new Uint8Array(32).fill(0x4c));
mkdirSync(OUT, { recursive: true });

const pw = loadPlaywright();
if (!pw) { console.error('no playwright: (cd permutation-gateway/screens && npm ci)'); process.exit(2); }
const log = [], summary = { candidate: CANDIDATE, stages: {}, notDone: ['build/train/muster as the NFT (0xE2)', 'march / territory (0xDD)', 'pass sold away from B: old owner refused / new owner acts'] };
const step = (name, detail = '') => { const line = `${new Date().toISOString().slice(11, 19)} ${name}${detail ? ` — ${detail}` : ''}`; log.push(line); console.log(line); };
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {}); };
const text = page => page.evaluate(() => document.body.innerText);
async function waitText(page, re, ms, name) {
  try { await page.waitForFunction(r => new RegExp(r).test(document.body.innerText), re.source, { timeout: ms }); }
  catch { await shot(page, `${name}-failed`); writeFileSync(path.join(OUT, `${name}-failed.txt`), await text(page)); throw new Error(`${name}: /${re.source}/ did not appear`); }
}
/** Press as a person does: the element still for 250 ms and itself at its centre, then ONE press; never at an old position. */
async function humanPress(page, sel) {
  const at = await page.evaluate(async sel => {
    const t0 = performance.now(); let last = null, since = performance.now();
    for (;;) {
      const el = document.querySelector(sel); if (el && !el.disabled) el.scrollIntoView({ block: 'center' });
      const r = el?.getBoundingClientRect(), c = r && r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      const top = c ? document.elementFromPoint(c.x, c.y) : null, hit = !!(top && el && !el.disabled && (top === el || el.contains(top)));
      if (!c || !last || Math.abs(c.x - last.x) > 0.5 || Math.abs(c.y - last.y) > 0.5 || !hit) since = performance.now();
      last = c;
      if (c && hit && performance.now() - since >= 250) return c;
      if (performance.now() - t0 > 5000) return null;
      await new Promise(r => requestAnimationFrame(r));
    }
  }, sel);
  if (!at) { await shot(page, `press-refused-${sel.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}`); throw new Error(`${sel}: not still / not at its centre within 5 s; not pressed`); }
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up(); await page.waitForTimeout(300);
}

const rpc = new RpcClient(RPC);
/** The chain's word on the pass: the asset's Core owner, the record's generation, the NFT Citizen and its mark. */
async function chainOf(asset, residentProgram) {
  const a = await rpc.account(asset), owned = a ? decodeAssetOwner(Uint8Array.from(a.data)) : null;
  const rec = await rpc.account(pdas(residentProgram).resident(asset)).catch(() => null);
  const citizenAt = residentCitizen(seasonAddresses(CANDIDATE, '11'), asset);
  const c = await rpc.account(citizenAt);
  return { owner: owned ? base58(owned.owner) : null, generation: rec ? decodeResidentAccount(rec.data)?.generation ?? null : null,
    citizen: citizenAt, citizenExists: !!c, citizenProgram: c?.owner ?? null, mark: c ? citizenMark(Uint8Array.from(c.data)) : null };
}

const browser = await pw.chromium.launch();
let failed = null, B = null, asset = null, residentProgram = null;
try {
  // start: the gate makes B's memory-only wallet; the launcher starts B's candidate world
  const gctx = await browser.newContext();
  await gctx.addInitScript(() => { try { localStorage.setItem('ps-lang', 'en'); } catch { /* */ } });
  const g = await gctx.newPage();
  g.on('pageerror', e => step('game pageerror', e.message));
  await g.goto(GAME.toString());
  await g.locator('#local-play-address').waitFor({ state: 'visible', timeout: 60_000 });
  await g.waitForFunction(() => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(document.getElementById('local-play-address')?.textContent?.trim() ?? ''), null, { timeout: 60_000 });
  B = (await g.locator('#local-play-address').textContent()).trim();
  await shot(g, '0-gate'); step('start: the gate shows the world\'s wallet B', B);
  await humanPress(g, '#local-play-connect');
  // the gate closes when the world is handed over; a refusal is said on the gate at once (data-phase="refused"):
  // fail then with the gate's own words and a screenshot, never wait out the timeout
  const gateEnd = await g.waitForFunction(() => {
    const el = document.getElementById('local-play-gate');
    if (!el) return { closed: true };
    if (el.dataset.phase === 'refused') return { refused: true, status: document.getElementById('local-play-status')?.textContent?.trim() ?? '' };
    return null;
  }, null, { timeout: 15 * 60_000, polling: 1000 }).then(h => h.jsonValue());
  if (gateEnd.refused) { await shot(g, '0-gate-refused'); throw new Error(`start: the gate refused the world: ${gateEnd.status}`); }
  await shot(g, '0-world'); step('start: B\'s candidate world is open (the gate closed)');
  summary.stages.start = { ok: true, wallet: B };

  // mint: A's test wallet on the mint page
  const mctx = await browser.newContext();
  const seedA = randomBytes(32).toString('hex'), A = keypair(Buffer.from(seedA, 'hex'));
  await mctx.addInitScript(s => { try { localStorage.setItem('wylls-testwallet-seed', s); localStorage.setItem('wylls-mint-lang', 'en'); } catch { /* */ } }, seedA);
  const m = await mctx.newPage();
  await m.goto(MINT);
  await m.waitForFunction(() => globalThis.__testWallet?.address);
  if (await m.evaluate(() => globalThis.__testWallet.address) !== A.publicKey) throw new Error('the mint page wallet is not A');
  const cfg = await (await fetch(new URL('/mint/config', MINT))).json();
  residentProgram = cfg.programs?.resident ?? null;
  if (!residentProgram) throw new Error('the mint page names no resident program');
  if (STAGES.has('mint')) {
    await fetch(new URL('/mock/airdrop', MINT), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: A.publicKey, lamports: '2000000000' }) });
    await m.locator('[data-wallet]').first().click();
    await waitText(m, /Ready to mint/, 60_000, '1-mint-ready');
    await m.getByTestId('mint').click();
    await waitText(m, /Your pass is ready/, 180_000, '1-minted');
    asset = (await m.getByTestId('asset').textContent())?.trim();
    const c1 = await chainOf(asset, residentProgram);
    if (c1.owner !== A.publicKey) throw new Error(`after the mint the asset's owner is ${c1.owner}, not A`);
    await shot(m, '1-minted'); step('mint: A holds the pass on the chain', `${asset}, generation ${c1.generation}`);
    summary.stages.mint = { ok: true, asset, chain: c1 };
  }

  // transfer: A → B on the mint page's transfer screen
  if (STAGES.has('transfer')) {
    await m.reload(); await m.locator('[data-wallet]').first().click();
    await waitText(m, /You hold the pass/, 60_000, '2-mint-holds');
    await m.getByTestId('t-to').fill(B);
    await m.getByTestId('t-review').click();
    await m.getByTestId('t-confirm').waitFor({ state: 'visible', timeout: 30_000 });
    const shown = { asset: (await m.getByTestId('t-asset-full').textContent()).trim(), to: (await m.getByTestId('t-dest').textContent()).trim() };
    if (shown.asset !== asset || shown.to !== B) throw new Error(`the transfer review shows ${JSON.stringify(shown)}`);
    await m.getByTestId('t-ack').check(); await m.getByTestId('t-send').click();
    await m.waitForFunction(() => /Transferred \(confirmed on the chain\)/.test(document.querySelector('[data-testid="t-status"]').textContent), null, { timeout: 120_000 });
    const c2 = await chainOf(asset, residentProgram);
    if (c2.owner !== B) throw new Error(`after the transfer the asset's owner is ${c2.owner}, not B`);
    await shot(m, '2-transferred'); step('transfer: B holds the pass on the chain', `generation ${c2.generation}`);
    summary.stages.transfer = { ok: true, chain: c2 };
  }

  // join: the village screen's NFT card → re-read → nation → join with the NFT
  if (STAGES.has('join')) {
    await g.locator('#tabs [data-tab="holding"]').waitFor({ state: 'visible', timeout: 60_000 });
    if (!(await g.locator('#tabs [data-tab="holding"][aria-current="page"]').count())) await humanPress(g, '#tabs [data-tab="holding"]');
    await g.locator('[data-local-nft]').first().waitFor({ state: 'visible', timeout: 60_000 });
    if (await g.locator('[data-local-nft="none"] [data-act="nft-reload"]').count()) await humanPress(g, '[data-local-nft="none"] [data-act="nft-reload"]');
    await g.locator('[data-local-nft="nations"] [data-act="pick-faction"]').first().waitFor({ state: 'visible', timeout: 60_000 });
    await shot(g, '3-nft-card'); step('join: the village screen offers the pass (the NFT card)');
    await humanPress(g, '[data-local-nft="nations"] [data-act="pick-faction"]');
    await humanPress(g, `[data-act="nft-login"][data-asset="${asset}"]`);
    await g.locator('[data-act="nft-logout"]').waitFor({ state: 'visible', timeout: 180_000 });
    const c3 = await chainOf(asset, residentProgram);
    if (!c3.citizenExists || c3.citizenProgram !== CANDIDATE || !c3.mark?.nft || c3.mark.asset !== asset) throw new Error(`after the join the NFT Citizen is ${JSON.stringify(c3)}`);
    await shot(g, '3-joined'); step('join: the NFT\'s Citizen exists on the chain with this asset\'s mark; the page plays as the NFT', c3.citizen);
    summary.stages.join = { ok: true, chain: c3 };
  }
} catch (e) {
  failed = e.message; step('FAILED', e.message);
} finally {
  summary.failed = failed; summary.log = log;
  writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(OUT, 'steps.log'), `${log.join('\n')}\n`);
  await browser.close();
}
process.exit(failed ? 1 : 0);
