#!/usr/bin/env node
// The English screen check of a local NFT world (frontier-stack `up --nft-pass`; runbook §5):
// a wallet without a pass sees the link to the mint page → it mints there → back in the game it
// re-reads its NFTs, picks a nation, joins with the NFT and builds its first village (PlaceHome through
// ResidentAct) → the pass goes A→B (TransferResident from Node) → A's page no longer offers it, B's
// page plays the same Citizen.
//
//   node permutation-nft-resident-spike/demo/nft-world-screen-check.mjs --out <dir>
//        [--game http://127.0.0.1:41040/frontier/frontier/] [--mint http://127.0.0.1:41090/web/mint.html]
//        [--rpc http://127.0.0.1:41010] [--resident <program id>]
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
  const page = await ctx.newPage();
  page.on('pageerror', e => step(`${name} pageerror`, e.message));
  await page.goto(GAME);
  return page;
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

/** Harvest from the village screen (a player instruction; for an NFT, inside ResidentAct). Returns the page's answer. */
async function harvest(page, name, { waitEnabledMs = 180_000 } = {}) {
  const btn = page.locator('[data-act="harvest"]').first();
  if (!(await btn.isVisible().catch(() => false))) await page.locator('[data-act="tab"]', { hasText: 'Village' }).first().click();
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

  // 5. Transfer A→B from Node (TransferResident), then A's page no longer offers the pass; B's plays it.
  const rpc = new RpcClient(RPC);
  const cfg = decodeConfigAccount((await rpc.account(pdas(RESIDENT).config)).data);
  const { blockhash } = await rpc.latestBlockhash();
  const tx = signedTx({ feePayer: A.publicKey, blockhash, instructions: [transferResidentIx({ program: RESIDENT, owner: A.publicKey, asset, collection: cfg.collection, to: B.publicKey })], signers: [A] });
  const st = await rpc.confirm(await rpc.send(tx.wire));
  if (!st || st.err) throw new Error(`TransferResident failed: ${JSON.stringify(st?.err)}`);
  step('5 TransferResident A→B');
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
} catch (e) {
  failed = e.message;
  step('FAILED', e.message);
} finally {
  writeFileSync(path.join(OUT, 'steps.log'), `${log.join('\n')}\n`);
  await browser.close();
}
process.exit(failed ? 1 : 0);
