#!/usr/bin/env node
// Screenshots of the mint page's loop (desktop and a phone viewport), as
// evidence of what was run. Default: the mock chain → demo/screens/.
// `--localnet`: the REAL program and the REAL Core binary on a loopback
// solana-test-validator → demo/screens-localnet/. Needs Playwright
// (preinstalled here, not a dependency). Writes *.jpg and INDEX.md.
// A phone VIEWPORT in Chromium is not a real device with a real wallet app.
import { createRequire } from 'node:module';
import { loadPlaywright } from '../test/playwright.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localnetMintStack, mockMintStack } from '../src/mint-demo.mjs';

const pw = loadPlaywright();
if (!pw) throw new Error('no playwright: run npm ci in permutation-gateway/screens');
const localnet = process.argv.includes('--localnet');
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), localnet ? 'screens-localnet' : 'screens');
mkdirSync(out, { recursive: true });
const s = localnet ? await localnetMintStack({}) : mockMintStack(); const { server, url } = await s.start();
const browser = await pw.chromium.launch();
const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const lines = [localnet ? `# mint 画面の記録（実 program ${s.programId} ＋実 Core、ループバック solana-test-validator、Chromium）` : '# mint 画面の記録（模擬チェーン、Chromium）', '', localnet ? '携帯の表示は Chromium の iPhone 15 ビューポートであり、実機＋実ウォレットアプリの試験ではない。' : '', '', '| ファイル | 場面 |', '|---|---|'];
const shot = async (page, name, caption) => { await page.screenshot({ path: path.join(out, `${name}.jpg`), fullPage: true, type: 'jpeg', quality: 72 }); lines.push(`| \`${name}.jpg\` | ${caption} |`); };
const waitStatus = (page, re) => page.waitForFunction(re => new RegExp(re).test(document.querySelector('[data-testid="status"]').textContent), re.source, { timeout: 20000 });

for (const [label, device, seed] of [['desktop', null, 'c'.repeat(64)], ['iphone15', 'iPhone 15', 'd'.repeat(64)]]) {
  const ctx = await browser.newContext(device ? { ...pw.devices[device], deviceScaleFactor: 1 } : { viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(([seed, chain]) => { try { localStorage.setItem('wylls-testwallet-seed', seed); localStorage.setItem('wylls-testwallet-chain', chain); } catch {} }, [seed, localnet ? 'solana:localnet' : 'solana:devnet']);
  const page = await ctx.newPage();
  await page.goto(`${url}/web/mint.html`);
  await page.waitForFunction(() => globalThis.__testWallet?.address);
  const address = await page.evaluate(() => globalThis.__testWallet.address);
  await shot(page, `${label}-1-before`, `${label}：接続前。DEVNET の注意、接続先、試験価格、手数料と口座作成費の見込み`);
  await post('/mock/airdrop', { address, lamports: '500000000' });
  await page.locator('[data-wallet]').first().click();
  await waitStatus(page, /mint できます/);
  await shot(page, `${label}-2-connected`, `${label}：ウォレット接続後。残高と mint 可の状態`);
  await page.getByTestId('mint').click();
  await waitStatus(page, /waitlist 登録完了/);
  await shot(page, `${label}-3-registered`, `${label}：確定と保有確認の後の「waitlist 登録完了」。住民 ID・asset・署名・保有者`);
  await page.reload();
  await page.waitForFunction(() => globalThis.__testWallet?.address);
  await page.locator('[data-wallet]').first().click();
  await waitStatus(page, /登録済み/);
  await shot(page, `${label}-4-reloaded`, `${label}：再読込後、チェーンの読取から登録済みを表示`);
  await ctx.close();
}
writeFileSync(path.join(out, 'INDEX.md'), `${lines.join('\n')}\n\n${localnet ? '全てローカルの solana-test-validator 上（実 program・実 Core バイナリ、実 JSON-RPC）。devnet の実発行は未実施。' : '全て模擬チェーン上。devnet の実発行は未実施。'}アドレスは実行ごとに変わる。\n`);
await browser.close(); server.close(); if (s.stop) await s.stop();
console.log(`screens: ${out}`);
