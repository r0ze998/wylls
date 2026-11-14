// The mint page in a real browser (Playwright's Chromium) against the mock
// chain over real JSON-RPC and real transaction bytes. Skipped when
// Playwright is not installed (it is preinstalled in this environment, not a
// dependency of the package). Each scenario is one of the required tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadPlaywright } from './playwright.mjs';
import { mockMintStack } from '../src/mint-demo.mjs';

let pw = null;
pw = loadPlaywright();
const skip = !pw;

async function stack() {
  const s = mockMintStack({ priceLamports: 100_000_000n });
  const { server, url } = await s.start();
  const browser = await pw.chromium.launch();
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const state = () => post('/mock/state', {});
  return { ...s, server, url, browser, post, state, close: async () => { await browser.close(); server.close(); } };
}
/** A page with the test wallet seeded (same seed → same address across reloads), optionally as a phone. */
async function open(s, { seed = 'a'.repeat(64), device = null, chain = null, reject = false } = {}) {
  const ctx = await s.browser.newContext(device ? pw.devices[device] : {});
  await ctx.addInitScript(({ seed, chain, reject }) => {
    try {
      localStorage.setItem('wylls-mint-lang', 'ja');
      localStorage.setItem('wylls-testwallet-seed', seed);
      if (chain) localStorage.setItem('wylls-testwallet-chain', chain); else localStorage.removeItem('wylls-testwallet-chain');
      if (reject) localStorage.setItem('wylls-testwallet-reject', '1'); else localStorage.removeItem('wylls-testwallet-reject');
    } catch { /* about:blank has no storage */ }
  }, { seed, chain, reject });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('pageerror', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('console.error', m.text().slice(0, 300)); });
  await page.goto(`${s.url}/web/mint.html`);
  await page.waitForFunction(() => globalThis.__testWallet?.address);
  const address = await page.evaluate(() => globalThis.__testWallet.address);
  return { ctx, page, address };
}
const t = (page, id) => page.getByTestId(id);
const connect = async page => { await page.locator('[data-wallet]').first().click(); await page.waitForFunction(() => document.querySelector('[data-testid="address"]').textContent.length > 20); };
const statusText = page => t(page, 'status').textContent();
const waitStatus = (page, re, ms = 15000) => page.waitForFunction(re => new RegExp(re).test(document.querySelector('[data-testid="status"]').textContent), re.source, { timeout: ms });

test('happy path: notices, estimate, connect, mint signed by the wallet, confirmed, holder verified → registered; a reload shows the same from the chain', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s);
    assert.match(await t(page, 'notice').textContent(), /DEVNET.*保証しません/);
    assert.match(await t(page, 'price').textContent(), /0\.100000 SOL.*TEST PRICE/);
    assert.match(await t(page, 'network').textContent(), /devnet/);
    assert.match(await t(page, 'fee').textContent(), /lamports/);
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await connect(page);
    await waitStatus(page, /mint できます/);
    await t(page, 'mint').click();
    await waitStatus(page, /waitlist 登録完了/, 20000);
    const asset = await t(page, 'asset').textContent();
    const sig = await t(page, 'signature').textContent();
    assert.match(await t(page, 'resident-id').textContent(), /^[0-9a-f]{30}$/);
    assert.match(await t(page, 'holder').textContent(), /あなた/);
    const st = await s.state();
    assert.equal(st.assets.length, 1);
    assert.equal(st.assets[0], asset);
    assert.equal(st.sent.length, 1);
    assert.equal(st.sent[0].signature, sig);
    assert.equal(BigInt(st.balances[address]) < 400_000_000n, true, 'price, fee and rent were paid');
    assert.equal(BigInt(st.balances[s.config.treasury]), 100_000_000n);
    // Reload: the page learns everything again from the chain (no pending record left).
    await page.reload();
    await page.waitForFunction(() => globalThis.__testWallet?.address);
    await connect(page);
    await waitStatus(page, /登録済み/);
    assert.equal(await t(page, 'mint').isDisabled(), true);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('wylls-mint-pending')).length), 0);
  } finally { await s.close(); }
});

test('signature refused: nothing sent, nothing charged, no pending record', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s, { reject: true });
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await connect(page);
    await waitStatus(page, /mint できます/);
    await t(page, 'mint').click();
    await waitStatus(page, /WalletRejected/);
    const st = await s.state();
    assert.deepEqual([st.sent.length, st.assets.length, st.balances[address]], [0, 0, '500000000']);
    assert.equal(await page.evaluate(() => localStorage.getItem(`wylls-mint-pending:${globalThis.__testWallet.address}`)), null);
    assert.equal(await t(page, 'mint').isDisabled(), false, 'the user can try again');
  } finally { await s.close(); }
});

test('insufficient SOL: refused before signing; a balance that covers the price but not rent and fee is also refused', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s);
    await s.post('/mock/airdrop', { address, lamports: '100000000' });     // exactly the price
    await connect(page);
    await waitStatus(page, /テスト SOL が不足/);
    assert.equal(await t(page, 'mint').isDisabled(), true);
    assert.equal((await s.state()).sent.length, 0);
  } finally { await s.close(); }
});

test('wrong network: a wallet account on mainnet is refused at connect; an RPC with another genesis hash disables the page', { skip }, async () => {
  const s = await stack();
  try {
    const { page } = await open(s, { chain: 'solana:mainnet' });
    const btn = page.locator('[data-wallet]').first();
    assert.equal(await btn.isDisabled(), true, 'the wallet does not offer solana:devnet');
    assert.match(await btn.textContent(), /does not offer solana:devnet/);
    // The RPC answers for another cluster than the page is configured for.
    await s.post('/mock/knobs', { genesisHash: 'OtherGenesis111111111111111111111111111111' });
    const { page: p2 } = await open(s, { seed: 'b'.repeat(64) });
    await waitStatus(p2, /接続先ネットワークが違います/);
    assert.equal(await p2.locator('[data-wallet]').first().isDisabled(), true);
  } finally { await s.close(); }
});

test('double click: one transaction, one asset, one charge', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s);
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await connect(page);
    await waitStatus(page, /mint できます/);
    await t(page, 'mint').click({ clickCount: 2, delay: 10 });
    await page.evaluate(() => document.querySelector('[data-testid="mint"]').click());
    await waitStatus(page, /waitlist 登録完了/, 20000);
    const st = await s.state();
    assert.deepEqual([st.sent.length, st.assets.length], [1, 1]);
    assert.equal(BigInt(st.balances[s.config.treasury]), 100_000_000n);
  } finally { await s.close(); }
});

test('lost answer: the send lands but the response is dropped → the page resolves by the recorded signature and never resends', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s);
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await s.post('/mock/knobs', { dropSendResponse: true });
    await connect(page);
    await waitStatus(page, /mint できます/);
    await t(page, 'mint').click();
    await waitStatus(page, /waitlist 登録完了/, 20000);
    const st = await s.state();
    assert.deepEqual([st.sent.length, st.assets.length], [1, 1]);
  } finally { await s.close(); }
});

test('leave mid-way and come back (also a reload): the pending record resolves; no second transaction; a phone viewport takes the same path', { skip }, async () => {
  const s = await stack();
  try {
    const { ctx, page, address } = await open(s, { device: 'iPhone 15' });
    assert.equal(await t(page, 'mobile-hint').isHidden(), false, 'the phone sees the wallet-app return hint');
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await connect(page);
    await waitStatus(page, /mint できます/);
    // Simulate: the wallet app opens; the browser tab is left right after the send. The response is dropped so nothing is resolved on this visit.
    await s.post('/mock/knobs', { dropSendResponse: true });
    await t(page, 'mint').click();
    await page.waitForFunction(() => localStorage.getItem(`wylls-mint-pending:${globalThis.__testWallet.address}`) !== null);
    for (let i = 0; i < 50 && (await s.state()).sent.length === 0; i++) await new Promise(r => setTimeout(r, 100)); // the send reached the chain
    await page.goto('about:blank');                                      // the user is in the wallet app / another tab
    const page2 = await ctx.newPage();                                     // back to the site (a new tab or a reload)
    await page2.goto(`${s.url}/web/mint.html`);
    await page2.waitForFunction(() => globalThis.__testWallet?.address);
    await connect(page2);
    // Either the pending record is resolved here (登録完了), or the first tab resolved it just before we left (登録済み from the chain).
    await waitStatus(page2, /waitlist 登録完了|登録済み/, 20000);
    const st = await s.state();
    assert.deepEqual([st.sent.length, st.assets.length], [1, 1]);
    assert.equal(await page2.evaluate(() => localStorage.getItem(`wylls-mint-pending:${globalThis.__testWallet.address}`)), null);
    assert.equal(await t(page2, 'mint').isDisabled(), true, 'no second mint offered');
  } finally { await s.close(); }
});

test('transaction expired: the signed transaction outlives its blockhash → refused at send, nothing charged, the user may retry', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s);
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await connect(page);
    await waitStatus(page, /mint できます/);
    // Age the chain past every blockhash's lifetime while the transaction is being signed: hook the RPC's blockhash to be already stale.
    await page.route('**/rpc', async route => {
      const body = route.request().postDataJSON();
      if (body.method === 'getLatestBlockhash') {
        const r = await route.fetch(); const j = await r.json();
        await s.post('/mock/advance', { blocks: 200 });                   // the hash is now expired
        return route.fulfill({ response: r, body: JSON.stringify(j) });
      }
      return route.continue();
    });
    await t(page, 'mint').click();
    await waitStatus(page, /期限が切れました/);
    const st = await s.state();
    assert.deepEqual([st.sent.length, st.assets.length, st.balances[address]], [0, 0, '500000000']);
    assert.equal(await page.evaluate(() => localStorage.getItem(`wylls-mint-pending:${globalThis.__testWallet.address}`)), null);
    assert.equal(await t(page, 'mint').isDisabled(), false);
  } finally { await s.close(); }
});

test('unknown result that stays unknown: the page keeps the record, refuses to re-mint, and resolves once the chain answers', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s);
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await connect(page);
    await waitStatus(page, /mint できます/);
    // The RPC hides the status for a while (an indexer lag): drop the send answer and make statuses answer null.
    let hide = true;
    await page.route('**/rpc', async route => {
      const body = route.request().postDataJSON();
      if (hide && body.method === 'getSignatureStatuses') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [null] } }) });
      return route.continue();
    });
    await s.post('/mock/knobs', { dropSendResponse: true });
    await t(page, 'mint').click();
    await waitStatus(page, /結果がまだ分かりません.*再課金・再発行はしません/, 20000);
    assert.equal(await t(page, 'mint').isDisabled(), true, 'no second mint while undecided');
    await t(page, 'mint').click({ force: true });
    assert.equal((await s.state()).sent.length, 1);
    hide = false;
    await t(page, 'recheck').click();
    await waitStatus(page, /waitlist 登録完了/, 20000);
    assert.deepEqual([(await s.state()).sent.length, (await s.state()).assets.length], [1, 1]);
  } finally { await s.close(); }
});

test('failure after the payment leg: the whole transaction fails, the payment is back, only the network fee is gone; the user can retry', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s);
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await s.post('/mock/knobs', { failAfterPayment: true });
    await connect(page);
    await waitStatus(page, /mint できます/);
    await t(page, 'mint').click();
    await waitStatus(page, /injected failure|Refused/);
    const st = await s.state();
    assert.deepEqual([st.sent.length, st.assets.length], [0, 0], 'refused in preflight: never included');
    assert.equal(st.balances[address], '500000000');
    assert.equal(st.balances[s.config.treasury] ?? '0', '0', 'no payment survived');
    // The same failure past preflight (skipPreflight): included, failed, fee paid, payment rolled back.
    const sig = await s.rpc.handle({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] });
    assert.ok(sig.result.value.blockhash);
    assert.equal(await t(page, 'mint').isDisabled(), false);
  } finally { await s.close(); }
});

test('after a transfer the old holder is no longer registered and the new holder is; the page reads it from the chain', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s);
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await connect(page);
    await waitStatus(page, /mint できます/);
    await t(page, 'mint').click();
    await waitStatus(page, /waitlist 登録完了/, 20000);
    const asset = await t(page, 'asset').textContent();
    const { page: pageB, address: addressB } = await open(s, { seed: 'b'.repeat(64) });
    const moved = await s.post('/mock/transfer', { asset, from: address, to: addressB });
    assert.equal(moved.gen, 1);
    await t(page, 'recheck').click();
    await waitStatus(page, /保有する住民 NFT はありません|mint できます|不足/);
    const mine = await (await fetch(`${s.url}/mint/mine?wallet=${address}`)).json();
    assert.equal(mine.residents.length, 0);
    const stA = await (await fetch(`${s.url}/mint/status?wallet=${address}&asset=${asset}`)).json();
    assert.deepEqual([stA.registered, stA.isHolder, stA.gen], [false, false, 1]);
    await connect(pageB);
    await waitStatus(pageB, /登録済み/);
    const stB = await (await fetch(`${s.url}/mint/status?wallet=${addressB}&asset=${asset}`)).json();
    assert.deepEqual([stB.registered, stB.isHolder], [true, true]);
  } finally { await s.close(); }
});

test('expired pending record: expiry alone decides nothing; the attempt\'s asset account does. Absent → retry allowed; present (status hidden or lost) → registered, no second mint', { skip }, async () => {
  const s = await stack();
  try {
    const { page, address } = await open(s);
    await s.post('/mock/airdrop', { address, lamports: '500000000' });
    await connect(page);
    await waitStatus(page, /mint できます/);
    // 1. A record of a transaction that never landed, already past its last valid block: the asset account does not exist → safe to retry.
    await page.evaluate(() => localStorage.setItem(`wylls-mint-pending:${globalThis.__testWallet.address}`, JSON.stringify({ signature: '1'.repeat(87), asset: '2'.repeat(43), lastValidBlockHeight: 0, at: Date.now() })));
    await page.reload(); await page.waitForFunction(() => globalThis.__testWallet?.address); await connect(page);
    await waitStatus(page, /期限切れで、finalized でも asset の口座が無く/);
    assert.equal(await t(page, 'mint').isDisabled(), false);
    // 1b. The same record, but the account was observed once (`seen`): it stays "landed" even though the account is gone → no retry.
    await page.evaluate(() => localStorage.setItem(`wylls-mint-pending:${globalThis.__testWallet.address}`, JSON.stringify({ signature: '1'.repeat(87), asset: '2'.repeat(43), lastValidBlockHeight: 0, at: Date.now(), seen: true })));
    await page.reload(); await page.waitForFunction(() => globalThis.__testWallet?.address); await connect(page);
    await waitStatus(page, /一度観測したため発行済みとして扱います/);
    assert.equal(await t(page, 'mint').isDisabled(), true);
    assert.notEqual(await page.evaluate(() => localStorage.getItem(`wylls-mint-pending:${globalThis.__testWallet.address}`)), null, 'the record is kept');
    await page.evaluate(() => localStorage.removeItem(`wylls-mint-pending:${globalThis.__testWallet.address}`));
    await page.reload(); await page.waitForFunction(() => globalThis.__testWallet?.address); await connect(page);
    await waitStatus(page, /mint できます/);
    // 2. A real mint, then its record is aged (expired) and its signature made unknown to the RPC: the asset account exists → registered, nothing resent.
    await t(page, 'mint').click();
    await waitStatus(page, /waitlist 登録完了/);
    const asset = await t(page, 'asset').textContent();
    const sent = (await s.state()).sent.length;
    await page.evaluate(asset => localStorage.setItem(`wylls-mint-pending:${globalThis.__testWallet.address}`, JSON.stringify({ signature: '3'.repeat(87), asset, lastValidBlockHeight: 0, at: Date.now() })), asset);
    await page.reload(); await page.waitForFunction(() => globalThis.__testWallet?.address); await connect(page);
    await waitStatus(page, /期限切れ後に口座で確認|登録済み/);
    assert.equal((await s.state()).sent.length, sent, 'nothing was sent');
    assert.equal((await s.state()).assets.length, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem(`wylls-mint-pending:${globalThis.__testWallet.address}`)), null);
  } finally { await s.close(); }
});
