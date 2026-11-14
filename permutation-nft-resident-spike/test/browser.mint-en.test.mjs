// The mint page in English (Chromium, mock chain, no validator): `?lang=en`, no Japanese left on the page but the
// toggle's own label, TEST labels kept, the whole mint flow, a reload, and the toggle back to Japanese.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright.mjs';
import { mockMintStack } from '../src/mint-demo.mjs';

const pw = loadPlaywright();
const skip = pw ? false : 'playwright not installed';
const CJK = /[぀-ヿ一-鿿]/;

test('English: notices, TEST price, connect, mint, registered; a reload; the toggle back to Japanese', { skip, timeout: 120_000 }, async () => {
  const s = mockMintStack();
  const { url, server } = await s.start();
  const browser = await pw.chromium.launch();
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { try { localStorage.setItem('wylls-testwallet-seed', 'b'.repeat(64)); } catch {} });
    const page = await ctx.newPage();
    await page.goto(`${url}/web/mint.html?lang=en`);
    await page.waitForFunction(() => globalThis.__testWallet?.address);
    const address = await page.evaluate(() => globalThis.__testWallet.address);
    const t = id => page.getByTestId(id).textContent();
    const body = () => page.evaluate(() => document.body.innerText);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.match(await page.title(), /Wylls resident NFT — test mint/);
    assert.match(await t('notice'), /A DEVNET TEST\. No entry right or money value is promised\. Use test SOL only\./);
    assert.match(await t('price'), /0\.100000 SOL .* — TEST PRICE — a test value, not a real price/);
    assert.match(await t('fee'), /^about .* \(2 signatures\)$/);
    assert.match(await body(), /The price is a TEST value/);
    await page.request.post(`${url}/mock/airdrop`, { data: { address, lamports: '500000000' } });
    await page.locator('[data-wallet]').first().click();
    await page.waitForFunction(() => /Ready to mint/.test(document.querySelector('[data-testid="status"]').textContent));
    const visible = (await body()).replace('日本語', '');
    assert.doesNotMatch(visible, CJK, `Japanese left on the English page: ${visible.match(new RegExp(`.{0,20}${CJK.source}.{0,20}`))?.[0]}`);
    await page.getByTestId('mint').click();
    await page.waitForFunction(() => /Your pass is ready/.test(document.querySelector('[data-testid="status"]').textContent), null, { timeout: 30_000 });
    await page.reload();
    await page.locator('[data-wallet]').first().click();
    await page.waitForFunction(() => /You hold the pass/.test(document.querySelector('[data-testid="status"]').textContent), null, { timeout: 30_000 });
    assert.doesNotMatch((await body()).replace('日本語', ''), CJK, 'still English after the reload (the choice was kept)');
    // The toggle switches to Japanese (and keeps it).
    assert.equal((await t('lang')).trim(), '日本語');
    await Promise.all([page.waitForEvent('load'), page.getByTestId('lang').click()]);
    assert.match(await body(), /接続先と費用の見込み/);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    server.close();
  }
});
