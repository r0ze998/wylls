// The mint page against the REAL resident program and the REAL Metaplex
// Core binary on a loopback solana-test-validator (approved local
// environment), over real JSON-RPC. Skipped when the validator, the Core
// binary or the program build is missing, or Playwright is not installed.
//
// Keys: the browser test wallet is a seed in localStorage (the same seed in
// Node gives the same key, so the test can act as that wallet off-page);
// everything is funded by the validator's faucet and thrown away.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { localnetAvailable, TEST_PROGRAM_ID } from '../src/localnet.mjs';
import { keypair, fromHex } from '../src/crypto.mjs';
import { customCode, mintResidentIx, opIx, pdas, setPriceIx, setSessionIx, signedTx, transferResidentIx, decodeResidentAccount } from '../src/resident-ix.mjs';

let pw = null;
try { pw = createRequire(import.meta.url)('playwright'); } catch { /* skipped */ }
const skip = !pw ? 'playwright not installed' : !localnetAvailable() ? 'localnet prerequisites missing (ENV-RECORD §1)' : false;

const SEED_A = 'a1'.repeat(32);
const SEED_B = 'b2'.repeat(32);
let s = null;   // the shared stack: validator + world + server + browser
async function stackUp() {
  const { localnetMintStack } = await import('../src/mint-demo.mjs');
  const st = await localnetMintStack({ priceLamports: 100_000_000n });
  const { server, url } = await st.start();
  const browser = await pw.chromium.launch();
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  return { ...st, server, url, browser, post, close: async () => { await browser.close(); server.close(); await st.stop(); } };
}
async function open(seed, { reject = false } = {}) {
  const ctx = await s.browser.newContext();
  await ctx.addInitScript(({ seed, reject }) => { try { localStorage.setItem('wylls-testwallet-seed', seed); if (reject) localStorage.setItem('wylls-testwallet-reject', '1'); else localStorage.removeItem('wylls-testwallet-reject'); localStorage.setItem('wylls-testwallet-chain', 'solana:localnet'); } catch {} }, { seed, reject });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('console.error', m.text().slice(0, 300)); });
  await page.goto(`${s.url}/web/mint.html`);
  await page.waitForFunction(() => globalThis.__testWallet?.address);
  const address = await page.evaluate(() => globalThis.__testWallet.address);
  return { ctx, page, address };
}
const t = (page, id) => page.getByTestId(id);
const connect = async page => { await page.locator('[data-wallet]').first().click(); await page.waitForFunction(() => document.querySelector('[data-testid="address"]').textContent.length > 20); };
const waitStatus = (page, re, ms = 30000) => page.waitForFunction(re => new RegExp(re).test(document.querySelector('[data-testid="status"]').textContent), re.source, { timeout: ms });
const pendingOf = page => page.evaluate(() => localStorage.getItem(`wylls-mint-pending:${globalThis.__testWallet.address}`));
/** Send an instruction from Node as `signers[0]` (fee payer) to the real RPC; returns the status or throws the preflight error. */
async function sendIx(ix, signers) {
  const bh = await s.rpc.latestBlockhash();
  const tx = signedTx({ feePayer: signers[0].publicKey, blockhash: bh.blockhash, instructions: [ix], signers });
  const sig = await s.rpc.send(tx.wire);
  return { signature: sig, status: await s.rpc.confirm(sig) };
}

before(async () => { if (!skip) s = await stackUp(); });
after(async () => { if (s) await s.close(); });

test('real program, happy path: the page derives the PDAs, the wallet signs one MintResident, the chain confirms, the server verifies the real asset and resident accounts; a reload shows the same', { skip }, async () => {
  const { page, address } = await open(SEED_A);
  assert.match(await t(page, 'network').textContent(), /real program/);
  assert.doesNotMatch(await t(page, 'network').textContent(), /模擬/);
  await s.post('/mock/airdrop', { address, lamports: '1000000000' });
  await connect(page);
  await waitStatus(page, /mint できます/);
  const before = await s.rpc.balance(address);
  await t(page, 'mint').click();
  await waitStatus(page, /waitlist 登録完了/, 60000);
  const asset = await t(page, 'asset').textContent();
  const sig = await t(page, 'signature').textContent();
  const st = await s.rpc.confirm(sig);
  assert.equal(st.err, null, 'the transaction the page shows is confirmed on the real chain');
  // The real accounts: Core asset owned by A; resident PDA of the real program bound to it, generation 0.
  const a = await s.rpc.account(asset);
  assert.equal(a.owner, 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
  const r = decodeResidentAccount((await s.rpc.account(pdas(TEST_PROGRAM_ID).resident(asset))).data);
  assert.deepEqual([r.asset, r.gen], [asset, 0]);
  assert.equal(await s.rpc.balance(s.world.treasury), 100_000_000n, 'the treasury got the test price');
  const spent = before - (await s.rpc.balance(address));
  assert.ok(spent > 100_000_000n && spent < 110_000_000n, `price + rents + fee: ${spent}`);
  const status = await (await fetch(`${s.url}/mint/status?wallet=${address}&asset=${asset}`)).json();
  assert.deepEqual([status.registered, status.isHolder, status.bound, status.gen], [true, true, true, 0]);
  await page.reload();
  await page.waitForFunction(() => globalThis.__testWallet?.address);
  await connect(page);
  await waitStatus(page, /登録済み/);
  assert.equal(await pendingOf(page), null);
  await page.context().close();
});

test('real program, rollback: a stale price is refused by the program in preflight; nothing is charged, no asset, no resident; a fresh price mints', { skip }, async () => {
  const { page, address } = await open('c3'.repeat(32));
  await s.post('/mock/airdrop', { address, lamports: '1000000000' });
  await connect(page);
  await waitStatus(page, /mint できます/);
  // The page's config fetch returns the old price while the chain's config already moved: the program refuses PriceChanged.
  const stale = await (await fetch(`${s.url}/mint/config`)).json();
  await sendIx(setPriceIx({ program: TEST_PROGRAM_ID, authority: s.world.setup.publicKey, price: 120_000_000n }), [s.world.setup]);
  await page.route('**/mint/config', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(stale) }));
  const before = await s.rpc.balance(address);
  await t(page, 'mint').click();
  await waitStatus(page, /価格が変わりました/, 30000);
  assert.equal(await s.rpc.balance(address), before, 'a preflight refusal costs nothing');
  assert.equal(await pendingOf(page), null);
  const mine = await (await fetch(`${s.url}/mint/mine?wallet=${address}`)).json();
  assert.equal(mine.residents.length, 0);
  // Back to the live config: the mint goes through at the new price.
  await page.unroute('**/mint/config');
  await t(page, 'recheck').click();
  await waitStatus(page, /mint できます/);
  await t(page, 'mint').click();
  await waitStatus(page, /waitlist 登録完了/, 60000);
  await sendIx(setPriceIx({ program: TEST_PROGRAM_ID, authority: s.world.setup.publicKey, price: 100_000_000n }), [s.world.setup]);
  await page.context().close();
});

test('real program, lost answer and unknown result: the signature recorded before the send resolves it; no second mint while undecided', { skip }, async () => {
  const { page, address } = await open('d4'.repeat(32));
  await s.post('/mock/airdrop', { address, lamports: '1000000000' });
  await connect(page);
  await waitStatus(page, /mint できます/);
  await s.post('/mock/knobs', { dropSendResponse: true, hideStatuses: true });
  await t(page, 'mint').click();
  await waitStatus(page, /結果がまだ分かりません.*再課金・再発行はしません/, 60000);
  assert.equal(await t(page, 'mint').isDisabled(), true);
  await t(page, 'mint').click({ force: true });
  const mine1 = await (await fetch(`${s.url}/mint/mine?wallet=${address}`)).json();
  assert.equal(mine1.residents.length, 1, 'the one transaction landed on the real chain');
  await s.post('/mock/knobs', { hideStatuses: false });
  await t(page, 'recheck').click();
  await waitStatus(page, /waitlist 登録完了/, 60000);
  assert.equal((await (await fetch(`${s.url}/mint/mine?wallet=${address}`)).json()).residents.length, 1);
  await page.context().close();
});

test('real program, double click: one transaction, one asset', { skip }, async () => {
  const { page, address } = await open('e5'.repeat(32));
  await s.post('/mock/airdrop', { address, lamports: '1000000000' });
  await connect(page);
  await waitStatus(page, /mint できます/);
  await t(page, 'mint').click({ clickCount: 2, delay: 10 });
  await page.evaluate(() => document.querySelector('[data-testid="mint"]').click());
  await waitStatus(page, /waitlist 登録完了/, 60000);
  assert.equal((await (await fetch(`${s.url}/mint/mine?wallet=${address}`)).json()).residents.length, 1);
  await page.context().close();
});

test('real program, A→B→A with nothing observing: old session, old pre-signed operations of A and B stay dead; the page reads the new generation', { skip }, async () => {
  const { page, address } = await open(SEED_A);               // A minted in the first test
  const A = keypair(fromHex(SEED_A));
  assert.equal(A.publicKey, address, 'the Node key is the browser wallet');
  const B = keypair(fromHex(SEED_B));
  await s.post('/mock/airdrop', { address: B.publicKey, lamports: '1000000000' });
  await s.post('/mock/airdrop', { address, lamports: '500000000' });
  const mine = await (await fetch(`${s.url}/mint/mine?wallet=${address}`)).json();
  const asset = mine.residents[0].asset;
  const K = keypair();
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await sendIx(setSessionIx({ program: TEST_PROGRAM_ID, owner: A.publicKey, asset, session: K.publicKey, expiry: now + 86_400 }), [A])).status.err, null);
  // Pre-signed operations against generation 0 (the fee payer is A for K's op, as a relay would sponsor it).
  const bh = await s.rpc.latestBlockhash();
  const preA = signedTx({ feePayer: A.publicKey, blockhash: bh.blockhash, instructions: [opIx({ program: TEST_PROGRAM_ID, actor: A.publicKey, asset, gen: 0, nonce: 1 })], signers: [A] });
  const preK = signedTx({ feePayer: A.publicKey, blockhash: bh.blockhash, instructions: [opIx({ program: TEST_PROGRAM_ID, actor: K.publicKey, asset, gen: 0, nonce: 2 })], signers: [A, K] });
  // A → B → A on the real program; the relay (the companion server) is told nothing.
  assert.equal((await sendIx(transferResidentIx({ program: TEST_PROGRAM_ID, owner: A.publicKey, asset, collection: s.world.collection, to: B.publicKey }), [A])).status.err, null);
  const stB = await (await fetch(`${s.url}/mint/status?wallet=${B.publicKey}&asset=${asset}`)).json();
  assert.deepEqual([stB.registered, stB.gen], [true, 1]);
  assert.equal((await (await fetch(`${s.url}/mint/status?wallet=${address}&asset=${asset}`)).json()).registered, false, 'A is out while B holds');
  const K2 = keypair();
  assert.equal((await sendIx(setSessionIx({ program: TEST_PROGRAM_ID, owner: B.publicKey, asset, session: K2.publicKey, expiry: now + 86_400 }), [B])).status.err, null);
  const preK2 = signedTx({ feePayer: B.publicKey, blockhash: (await s.rpc.latestBlockhash()).blockhash, instructions: [opIx({ program: TEST_PROGRAM_ID, actor: K2.publicKey, asset, gen: 1, nonce: 3 })], signers: [B, K2] });
  assert.equal((await sendIx(transferResidentIx({ program: TEST_PROGRAM_ID, owner: B.publicKey, asset, collection: s.world.collection, to: A.publicKey }), [B])).status.err, null);
  // Everything from before is refused by the real program (preflight): A's op → StaleGen, K's and K2's → NotOwner; nothing lands.
  const refused = async wire => { try { await s.rpc.send(wire); return null; } catch (e) { return customCode(e.data ?? e.message); } };
  assert.equal(await refused(preA.wire), 1004, 'StaleGen');
  assert.equal(await refused(preK.wire), 1003, 'NotOwner');
  assert.equal(await refused(preK2.wire), 1003, 'NotOwner');
  const live = await sendIx(opIx({ program: TEST_PROGRAM_ID, actor: K.publicKey, asset, gen: 2, nonce: 4 }), [A, K]).catch(e => ({ err: customCode(e.data ?? e.message) }));
  assert.equal(live.err, 1003, 'the old session key is nobody\'s session in generation 2');
  const r = decodeResidentAccount((await s.rpc.account(pdas(TEST_PROGRAM_ID).resident(asset))).data);
  assert.deepEqual([r.gen, r.ops, r.session], [2, 0, '11111111111111111111111111111111']);
  // The page, with nothing told, reads generation 2 and A as the holder from the chain.
  await connect(page);
  await waitStatus(page, /登録済み/);
  const stA = await (await fetch(`${s.url}/mint/status?wallet=${address}&asset=${asset}`)).json();
  assert.deepEqual([stA.registered, stA.gen], [true, 2]);
  await page.context().close();
});

test('real program, landed rollback: the payment leg executes, the Core create fails, the whole transaction is reverted on the real chain; the treasury has nothing, the payer lost only the fee, no resident account', { skip }, async () => {
  const P = keypair(fromHex('f6'.repeat(32)));
  await s.post('/mock/airdrop', { address: P.publicKey, lamports: '1000000000' });
  const asset = keypair();
  // Core's CreateV1 allocates the asset account; an address that already holds lamports makes that fail, after the payment leg ran.
  await s.rpc.airdrop(asset.publicKey, 1_000_000); for (let i = 0; i < 40 && (await s.rpc.balance(asset.publicKey)) === 0n; i++) await new Promise(r => setTimeout(r, 250));
  const treasuryBefore = await s.rpc.balance(s.world.treasury);
  const payerBefore = await s.rpc.balance(P.publicKey);
  const bh = await s.rpc.latestBlockhash();
  const tx = signedTx({ feePayer: P.publicKey, blockhash: bh.blockhash, instructions: [mintResidentIx({ program: TEST_PROGRAM_ID, payer: P.publicKey, treasury: s.world.treasury, asset: asset.publicKey, collection: s.world.collection, price: 100_000_000n })], signers: [P, asset] });
  const sig = await s.rpc.send(tx.wire, { skipPreflight: true });     // no preflight: the failure lands on the chain as a failed transaction
  const st = await s.rpc.confirm(sig);
  assert.notEqual(st.err, null, `the transaction failed on chain: ${JSON.stringify(st.err)}`);
  assert.equal(await s.rpc.balance(s.world.treasury), treasuryBefore, 'the payment leg was rolled back');
  assert.equal(payerBefore - (await s.rpc.balance(P.publicKey)), 10_000n, 'only the network fee is gone (two signatures: payer and asset)');
  assert.equal(await s.rpc.account(pdas(TEST_PROGRAM_ID).resident(asset.publicKey)), null, 'no resident account');
  assert.equal((await s.rpc.account(asset.publicKey))?.owner ?? '11111111111111111111111111111111', '11111111111111111111111111111111', 'no asset was created');
});
