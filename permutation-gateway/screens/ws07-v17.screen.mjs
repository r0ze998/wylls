// Workstream 07: this round's parts of the real client in Chromium (screens/ws07/v17-parts.html), FIXTURE state only:
// workstream 20's NFT card (a list not read, a list, an NFT played), the agent history with workstream 4's seven
// send states, and the chronicle's read states — Japanese and English, phone 390 and PC 1440, after a reload too. An
// init script blocks and counts every key operation (none are expected: nothing here signs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const SHOTS = process.env.WS07_SHOTS ?? null;
const SIZES = [{ name: 'phone', width: 390, height: 844 }, { name: 'pc', width: 1440, height: 900 }];
let srv, base, browser;
before(async () => {
  srv = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path.startsWith('..')) { res.writeHead(403).end(); return; }
    try { const b = await readFile(join(ROOT, path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(b); } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/permutation-gateway/screens/ws07/`;
  browser = await chromium.launch(process.env.WS07_CHROME ? { executablePath: process.env.WS07_CHROME } : {});
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); srv?.close(); });

function guard() {
  window.__keyUses = [];
  const s = crypto.subtle;
  for (const m of ['generateKey', 'deriveKey', 'deriveBits', 'sign', 'unwrapKey']) Object.defineProperty(s, m, { value: async () => { window.__keyUses.push(m); throw new Error(`key use blocked: ${m}`); } });
  const imp = s.importKey.bind(s);
  Object.defineProperty(s, 'importKey', { value: async (fmt, data, alg, ext, uses) => { if (fmt === 'pkcs8' || (uses ?? []).includes('sign')) { window.__keyUses.push(`importKey:${fmt}`); throw new Error('key use blocked'); } return imp(fmt, data, alg, ext, uses); } });
}

for (const size of SIZES) for (const l of ['en', 'ja']) {
  test(`${size.name} ${l}: NFT card, the seven send states and the read states say themselves; nothing overflows; a reload shows the same`, async () => {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    await ctx.addInitScript(guard);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    try {
      await page.goto(`${base}v17-parts.html?lang=${l}`);
      await page.waitForFunction(() => window.ws07?.ready);
      const agentPage = await ctx.newPage();
      agentPage.on('pageerror', e => errors.push(String(e)));
      await agentPage.goto(`${base}v17-agent.html?lang=${l}`);
      await agentPage.waitForFunction(() => window.ws07?.ready);
      const check = async () => {
        const nft = await page.locator('#nft').innerText(), chron = await page.locator('#chron').innerText();
        const agent = await agentPage.locator('#agent').innerText();
        if (l === 'en') {
          assert.match(nft, /The resident NFTs of this wallet could not be loaded \(HTTP503\)\. This does not mean it has none/);
          assert.match(nft, /Play this NFT/); assert.match(nft, /Join with this NFT/); assert.match(nft, /Playing as an NFT/);
          for (const w of ['Not sent', 'Recorded', 'Recorded, but it failed', 'Not recorded before its deadline', 'Waiting to be finalized', 'The outcome is unknown', 'Its state could not be queried']) assert.ok(agent.includes(w), w);
          assert.match(agent, /latest history could not be loaded \(HTTP502\)/);
          assert.match(chron, /Loading the record of events/);
          assert.match(chron, /The record of events could not be loaded \(HTTP503\)\. This does not mean the record is empty/);
          assert.match(chron, /The latest record of events could not be loaded \(network\)/);
          const jp = await page.evaluate(() => [...document.querySelectorAll('#nft, #agent, #chron')].map(e => e.innerText).join('\n').match(/[぀-ヿ一-鿿]+/g) ?? []);
          assert.deepEqual(jp, [], 'no Japanese left in the English parts');
        } else {
          assert.match(nft, /住民NFTを読み込めませんでした（HTTP503）。NFTが無いという意味ではありません/);
          assert.match(agent, /状態を照会できませんでした/);
          assert.match(chron, /記録が空という意味ではありません/);
        }
        assert.equal(await page.locator('#nft [data-act="nft-login"]').count(), 3, 'buttons only from the list read, none from the failed read');
        assert.equal(await page.locator('#nft [data-act="nft-login"][disabled]').count(), 1, 'the NFT with no resident record cannot be pressed');
        assert.equal(await agentPage.locator('#agent [data-key^="send:"]').count(), 7);
        for (const p of [page, agentPage]) assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'no sideways scroll');
      };
      await check();
      if (SHOTS) { await page.screenshot({ path: join(SHOTS, `ws07-v17-${l}-${size.name}.png`), fullPage: true }); await agentPage.screenshot({ path: join(SHOTS, `ws07-v17-agent-${l}-${size.name}.png`), fullPage: true }); }
      await page.reload(); await page.waitForFunction(() => window.ws07?.ready);
      await agentPage.reload(); await agentPage.waitForFunction(() => window.ws07?.ready);
      await check();
      assert.deepEqual(errors, []);
      for (const p of [page, agentPage]) assert.deepEqual(await p.evaluate(() => window.__keyUses), []);
    } finally { await ctx.close(); }
  });
}
