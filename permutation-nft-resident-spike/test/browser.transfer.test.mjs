// The transfer screen on the mint page (Chromium, mock chain, no validator). The mock chain runs TransferResident as
// the program checks it (owner signs and owns the asset; owner, generation and session change together). English is
// the default (no ?lang). What is checked:
// 1. refusals before anything is signed: empty, not base58, wrong length, self, a system account;
//    the review shows the NFT, the sender and the destination; "Transfer" needs the acknowledgement;
//    cancel sends nothing; a wallet that refuses to sign sends nothing; a double click sends ONE transaction;
//    the chain then shows the destination as the owner and the page says this wallet can no longer play it.
// 2. the NFT moved away behind the page's back after the review: refused at send, nothing sent.
// 3. a lost answer (and the RPC also hiding the status): resolved by the asset's owner on the chain, never resent.
// 4. gaps that could send by mistake or report a wrong result: the wallet's network switched after the review; two
//    tabs sending at once; a record left by another network (a restarted local world); a browser that cannot save the
//    record; A→B→A while the answer is lost (the owner is A again, two generations later: never "did not land").
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright.mjs';
import { mockMintStack } from '../src/mint-demo.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

const pw = loadPlaywright();
const skip = pw ? false : 'playwright not installed';
const CJK = /[぀-ヿ一-鿿]/;
const newKey = async () => encode(new Uint8Array(await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign'])).publicKey)));

async function rig() {
  const s = mockMintStack();
  const { url, server } = await s.start();
  const browser = await pw.chromium.launch();
  const close = async () => { await browser.close(); server.closeAllConnections?.(); server.close(); };
  try {
  const ctx = await browser.newContext({ locale: 'ja-JP' });        // a Japanese browser: the page is still English by default
  await ctx.addInitScript(() => { try { localStorage.setItem('wylls-testwallet-seed', 'c'.repeat(64)); } catch {} });
  const page = await ctx.newPage();
  const post = (p, data) => page.request.post(`${url}${p}`, { data }).then(r => r.json());
  const get = p => page.request.get(`${url}${p}`).then(r => r.json());
  const sends = async () => (await post('/mock/state', {})).sent.length;
  const tstatus = () => page.getByTestId('t-status').textContent();
  const waitT = (re, timeout = 20_000) => page.waitForFunction(src => new RegExp(src).test(document.querySelector('[data-testid="t-status"]').textContent), re.source, { timeout });
  await page.goto(`${url}/web/mint.html`);
  await page.waitForFunction(() => globalThis.__testWallet?.address);
  const address = await page.evaluate(() => globalThis.__testWallet.address);
  await post('/mock/airdrop', { address, lamports: '500000000' });
  await page.locator('[data-wallet]').first().click();
  await page.waitForFunction(() => /Ready to mint/.test(document.querySelector('[data-testid="status"]').textContent));
  await page.getByTestId('mint').click();
  await page.waitForFunction(() => /Your pass is ready/.test(document.querySelector('[data-testid="status"]').textContent), null, { timeout: 30_000 });
  await page.getByTestId('t-review').waitFor({ state: 'visible' });
  const asset = await page.getByTestId('t-asset').inputValue();
  const review = async to => { await page.getByTestId('t-to').fill(to); await page.getByTestId('t-review').click(); };
  return { ctx, page, url, address, asset, post, get, sends, tstatus, waitT, review, close };
  } catch (e) { await close(); throw e; }
}

test('transfer: strict checks, review, acknowledgement, cancel, wallet refusal, one send on a double click, chain owner', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  const { page } = r;
  try {
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en', 'English by default, even in a Japanese browser');
    assert.doesNotMatch((await page.evaluate(() => document.body.innerText)).replace('日本語', ''), CJK);
    assert.match(await page.evaluate(() => document.body.innerText), /only the destination wallet can play this resident/);
    const B = await newKey();
    const base = await r.sends();
    // Refusals, each before anything is signed.
    const refusals = [['', /Enter the destination wallet address/], ['not-an-address!', /not a wallet address/], [B.slice(0, 20), /wrong length/],
      [r.address, /cannot transfer to your own wallet/], [(await r.get('/mint/config')).collection, /system's own accounts/]];
    for (const [to, re] of refusals) {
      await r.review(to);
      await r.waitT(re);
      assert.equal(await page.getByTestId('t-confirm').isHidden(), true, `no confirmation for ${to || '(empty)'}`);
    }
    // The review shows exactly what would be sent; "Transfer" waits for the acknowledgement.
    await r.review(B);
    await page.getByTestId('t-confirm').waitFor({ state: 'visible' });
    assert.equal((await page.getByTestId('t-asset-full').textContent()).trim(), r.asset);
    assert.equal((await page.getByTestId('t-from').textContent()).trim(), r.address);
    assert.equal((await page.getByTestId('t-dest').textContent()).trim(), B);
    assert.match(await page.getByTestId('t-dest-note').textContent(), /holds no resident NFT yet/);
    assert.equal(await page.getByTestId('t-send').isDisabled(), true, 'not without the acknowledgement');
    assert.equal(await page.getByTestId('t-to').isDisabled(), true, 'the reviewed destination cannot be edited under the confirmation');
    // Cancel: nothing sent.
    await page.getByTestId('t-cancel').click();
    await r.waitT(/Transfer cancelled\. Nothing was sent/);
    assert.equal(await page.getByTestId('t-confirm').isHidden(), true);
    // The wallet refuses to sign: nothing sent, still the owner.
    await page.evaluate(() => localStorage.setItem('wylls-testwallet-reject', '1'));
    await r.review(B);
    await page.getByTestId('t-ack').check();
    await page.getByTestId('t-send').click();
    await r.waitT(/The wallet did not sign \(WalletRejected\)\. Nothing was sent/);
    assert.equal((await r.get(`/mint/status?wallet=${r.address}&asset=${r.asset}`)).isHolder, true);
    assert.equal(await r.sends(), base, 'nothing reached the chain so far');
    assert.equal(await page.evaluate(a => localStorage.getItem(`wylls-transfer-pending:${a}`), r.address), null, 'no pending record');
    await page.evaluate(() => localStorage.removeItem('wylls-testwallet-reject'));
    // A double click: one transaction.
    await page.getByTestId('t-send').dblclick();
    await r.waitT(/Transferred \(confirmed on the chain\).*This wallet can no longer play this resident/);
    assert.equal(await r.sends(), base + 1, 'exactly one transaction');
    const toB = await r.get(`/mint/status?wallet=${B}&asset=${r.asset}`);
    assert.deepEqual([toB.isHolder, toB.holder, toB.gen], [true, B, 1], 'the chain: B owns it, generation 1');
    assert.equal((await r.get(`/mint/status?wallet=${r.address}&asset=${r.asset}`)).isHolder, false);
    assert.match(await page.getByTestId('mine').textContent(), /holds no resident NFT/);
    assert.equal(await page.getByTestId('t-review').isDisabled(), true, 'nothing left to transfer');
    assert.equal(await page.evaluate(a => localStorage.getItem(`wylls-transfer-pending:${a}`), r.address), null);
  } finally { await r.close(); }
});

test('transfer: the NFT left the wallet after the review → refused at send, nothing sent', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  const { page } = r;
  try {
    const B = await newKey(), C = await newKey();
    await r.review(B);
    await page.getByTestId('t-confirm').waitFor({ state: 'visible' });
    const base = await r.sends();
    await r.post('/mock/transfer', { asset: r.asset, from: r.address, to: C });   // moved behind the page's back
    await page.getByTestId('t-ack').check();
    await page.getByTestId('t-send').click();
    await r.waitT(/not in this wallet now/);
    assert.equal(await r.sends(), base);
    assert.equal((await r.get(`/mint/status?wallet=${C}&asset=${r.asset}`)).isHolder, true);
  } finally { await r.close(); }
});

test('transfer: the answer is lost and the RPC hides the status → decided by the asset owner on the chain, never resent', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  const { page } = r;
  try {
    const B = await newKey();
    await page.route('**/rpc', async route => {
      const body = route.request().postDataJSON();
      if (body.method === 'getSignatureStatuses') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [null] } }) });
      return route.continue();
    });
    await r.review(B);
    await page.getByTestId('t-ack').check();
    const base = await r.sends();
    await r.post('/mock/knobs', { dropSendResponse: true });
    await page.getByTestId('t-send').click();
    await r.waitT(/Transferred \(confirmed on the chain\)/, 40_000);
    assert.equal(await r.sends(), base + 1, 'one send; the lost answer was not answered by a second one');
    assert.equal((await r.get(`/mint/status?wallet=${B}&asset=${r.asset}`)).isHolder, true);
  } finally { await r.close(); }
});

test('transfer: the wallet\'s network switched after the review → refused, nothing sent', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  const { page } = r;
  try {
    const B = await newKey();
    await r.review(B);
    await page.getByTestId('t-ack').check();
    const base = await r.sends();
    await page.evaluate(() => localStorage.setItem('wylls-testwallet-chain', 'solana:mainnet'));   // switched inside the wallet
    await page.getByTestId('t-send').click();
    await r.waitT(/connected wallet or network is not the one you reviewed with.*Nothing was sent/);
    assert.equal(await r.sends(), base);
    assert.equal((await r.get(`/mint/status?wallet=${r.address}&asset=${r.asset}`)).isHolder, true);
  } finally { await r.close(); }
});

test('transfer: two tabs of the same wallet send at once → one transaction', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  const { page } = r;
  try {
    const B = await newKey(), C = await newKey();
    const p2 = await r.ctx.newPage();
    await p2.goto(`${r.url}/web/mint.html`);
    await p2.waitForFunction(() => globalThis.__testWallet?.address);
    await p2.locator('[data-wallet]').first().click();
    await p2.waitForFunction(() => /You hold the pass/.test(document.querySelector('[data-testid="status"]').textContent), null, { timeout: 30_000 });
    await r.review(B);
    await page.getByTestId('t-ack').check();
    await p2.getByTestId('t-to').fill(C);
    await p2.getByTestId('t-review').click();
    await p2.getByTestId('t-confirm').waitFor({ state: 'visible' });
    await p2.getByTestId('t-ack').check();
    const base = await r.sends();
    await Promise.all([page.getByTestId('t-send').click(), p2.getByTestId('t-send').click()]);
    const settled = /Transferred \(confirmed on the chain\)|Another tab is transferring|not in this wallet now/;
    for (const pg of [page, p2]) await pg.waitForFunction(src => new RegExp(src).test(document.querySelector('[data-testid="t-status"]').textContent), settled.source, { timeout: 30_000 });
    assert.equal(await r.sends(), base + 1, 'exactly one transaction from the two tabs');
    const texts = [await page.getByTestId('t-status').textContent(), await p2.getByTestId('t-status').textContent()];
    assert.equal(texts.filter(t => /Transferred/.test(t)).length, 1, `one tab reports the transfer: ${texts.join(' | ')}`);
    const winner = /Transferred/.test(texts[0]) ? B : C;
    assert.equal((await r.get(`/mint/status?wallet=${winner}&asset=${r.asset}`)).isHolder, true, 'the reporting tab\'s destination owns it');
  } finally { await r.close(); }
});

test('transfer: a record left by another network is set aside (said on screen), and the screen works', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  const { page } = r;
  try {
    await page.evaluate(a => localStorage.setItem(`wylls-transfer-pending:${a}`, JSON.stringify({ v: 1, genesis: 'OtherGenesis1111111111111111111111111111111', gen: 0, signature: '5'.repeat(88), asset: 'X', from: a, to: 'Y', lastValidBlockHeight: 99999999 })), r.address);
    await page.getByTestId('recheck').click();
    await r.waitT(/recorded on another network \(genesis OtherGen…\) was set aside/);
    assert.equal(await page.evaluate(a => localStorage.getItem(`wylls-transfer-pending:${a}`), r.address), null);
    assert.match(await page.evaluate(a => localStorage.getItem(`wylls-transfer-pending:${a}:set-aside`), r.address), /OtherGenesis/);
    await r.review(await newKey());
    await page.getByTestId('t-confirm').waitFor({ state: 'visible' });
  } finally { await r.close(); }
});

test('transfer: the browser cannot save the record → nothing sent', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  const { page } = r;
  try {
    await r.review(await newKey());
    await page.getByTestId('t-ack').check();
    await page.evaluate(() => { const o = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('wylls-transfer-pending:')) throw new DOMException('quota', 'QuotaExceededError'); return o.call(this, k, v); }; });
    const base = await r.sends();
    await page.getByTestId('t-send').click();
    await r.waitT(/cannot save the transfer record.*Nothing was sent/);
    assert.equal(await r.sends(), base);
    assert.equal((await r.get(`/mint/status?wallet=${r.address}&asset=${r.asset}`)).isHolder, true);
  } finally { await r.close(); }
});

test('transfer: A→B→A while the answer is lost → "landed and came back", never "did not land"', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  const { page } = r;
  try {
    const B = await newKey();
    await page.route('**/rpc', async route => {
      const body = route.request().postDataJSON();
      if (body.method === 'getSignatureStatuses') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [null] } }) });
      return route.continue();
    });
    await r.review(B);
    await page.getByTestId('t-ack').check();
    const base = await r.sends();
    await r.post('/mock/knobs', { dropSendResponse: true });
    await page.getByTestId('t-send').click();
    for (let i = 0; i < 100 && (await r.sends()) === base; i++) await new Promise(res => setTimeout(res, 50));
    await r.post('/mock/transfer', { asset: r.asset, from: B, to: r.address });        // B sends it back before the page knows
    await r.waitT(/landed, and the resident has since come back to this wallet \(generation 0 → 2\)/, 40_000);
    assert.equal(await r.sends(), base + 1, 'nothing resent');
    assert.doesNotMatch(await r.tstatus(), /did not land/);
  } finally { await r.close(); }
});
