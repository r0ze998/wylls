// The mint's pending record on the page (Chromium, mock chain, no validator): two tabs of one wallet pressing "Mint"
// at once make ONE NFT and one payment; a record left by another network (a restarted local world) is set aside and
// said on screen instead of blocking the page; a browser that cannot save the record sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright.mjs';
import { mockMintStack } from '../src/mint-demo.mjs';

const pw = loadPlaywright();
const skip = pw ? false : 'playwright not installed';

async function rig() {
  const s = mockMintStack();
  const { url, server } = await s.start();
  const browser = await pw.chromium.launch();
  const close = async () => { await browser.close(); server.closeAllConnections?.(); server.close(); };
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { try { localStorage.setItem('wylls-testwallet-seed', 'd'.repeat(64)); } catch {} });
    const open = async () => {
      const page = await ctx.newPage();
      await page.goto(`${url}/web/mint.html`);
      await page.waitForFunction(() => globalThis.__testWallet?.address);
      return page;
    };
    const page = await open();
    const address = await page.evaluate(() => globalThis.__testWallet.address);
    const post = (p, data) => page.request.post(`${url}${p}`, { data }).then(r => r.json());
    await post('/mock/airdrop', { address, lamports: '900000000' });
    const connect = async pg => { await pg.locator('[data-wallet]').first().click(); };
    const waitS = (pg, re, timeout = 30_000) => pg.waitForFunction(src => new RegExp(src).test(document.querySelector('[data-testid="status"]').textContent), re.source, { timeout });
    const state = () => post('/mock/state', {});
    return { page, open, address, post, connect, waitS, state, close };
  } catch (e) { await close(); throw e; }
}

test('mint: two tabs of one wallet press "Mint" at once → one NFT, one transaction', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    const p2 = await r.open();
    for (const pg of [r.page, p2]) { await r.connect(pg); await r.waitS(pg, /Ready to mint/); }
    await Promise.all([r.page.getByTestId('mint').click(), p2.getByTestId('mint').click()]);
    const done = /Your pass is ready|You hold the pass|Another tab is minting/;
    for (const pg of [r.page, p2]) await r.waitS(pg, done);
    const st = await r.state();
    assert.deepEqual([st.sent.length, st.assets.length], [1, 1], 'one payment, one NFT');
    const texts = [await r.page.getByTestId('status').textContent(), await p2.getByTestId('status').textContent()];
    assert.equal(texts.filter(t => /Your pass is ready/.test(t)).length, 1, texts.join(' | '));
  } finally { await r.close(); }
});

test('mint: a record left by another network is set aside (said on screen); minting works', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    await r.page.evaluate(a => localStorage.setItem(`wylls-mint-pending:${a}`, JSON.stringify({ v: 1, genesis: 'OtherGenesis1111111111111111111111111111111', wallet: a, signature: '5'.repeat(88), asset: 'X', lastValidBlockHeight: 99999999, sentAt: 1 })), r.address);
    await r.connect(r.page);
    await r.waitS(r.page, /Ready to mint/);
    assert.match(await r.page.evaluate(a => localStorage.getItem(`wylls-mint-pending:${a}:set-aside`), r.address), /OtherGenesis/);
    assert.match(await r.page.getByTestId('record-note').textContent(), /A mint recorded on another network \(genesis OtherGen…\) was set aside/);
    assert.equal(await r.page.evaluate(a => localStorage.getItem(`wylls-mint-pending:${a}`), r.address), null);
    await r.page.getByTestId('mint').click();
    await r.waitS(r.page, /Your pass is ready/);
    assert.deepEqual([(await r.state()).sent.length, (await r.state()).assets.length], [1, 1]);
  } finally { await r.close(); }
});

test('mint: a record from before the record carried its network is still resolved (never set aside)', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    await r.page.evaluate(a => localStorage.setItem(`wylls-mint-pending:${a}`, JSON.stringify({ signature: '5'.repeat(88), asset: '11111111111111111111111111111112', lastValidBlockHeight: 99999999, sentAt: 1 })), r.address);
    await r.connect(r.page);
    await r.waitS(r.page, /result is not known yet/);
    assert.notEqual(await r.page.evaluate(a => localStorage.getItem(`wylls-mint-pending:${a}`), r.address), null, 'kept: still undecided');
    assert.equal(await r.page.getByTestId('mint').isDisabled(), true);
  } finally { await r.close(); }
});

test('mint: the browser cannot save the record → nothing sent, nothing charged', { skip, timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    await r.connect(r.page);
    await r.waitS(r.page, /Ready to mint/);
    await r.page.evaluate(() => { const o = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('wylls-mint-pending:')) throw new DOMException('quota', 'QuotaExceededError'); return o.call(this, k, v); }; });
    await r.page.getByTestId('mint').click();
    await r.waitS(r.page, /cannot save the mint record.*Nothing was sent/);
    const st = await r.state();
    assert.deepEqual([st.sent.length, st.assets.length], [0, 0]);
  } finally { await r.close(); }
});
