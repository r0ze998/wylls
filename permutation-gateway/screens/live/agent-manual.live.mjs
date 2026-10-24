// Manual play and the agent wallet in one real browser (Playwright's
// Chromium, headless), through the pages only: the play page joins with its
// dev wallet (x402, test USDC) and the village is played by hand; the owner's
// agent page (same origin, same dev wallet) creates an agent, deposits, hands
// the village's key over and switches to auto; the agent acts; the owner
// stops it, takes the key back, and plays the same village by hand again from
// the play page; then withdraws everything. Each hand-played action is
// checked on the chain (the relay's signature, its status over RPC).
//
// Needs a running stack with the agent wallet and its runner on (the rule
// autopilot is enough: no model), e.g. the conquest command of
// docs/agent-wallet/VERIFY.md §2 with FRONTIER_AGENT_WALLET=1 FRONTIER_AGENT_RUNNER=1.
//
//   LIVE_HERALD=http://127.0.0.1:41340 LIVE_RPC=http://127.0.0.1:41310 node --test live/agent-manual.live.mjs
//
// Not part of `node --test *.screen.mjs` (it needs a running stack). Test assets only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { toHex } from '../../../permutation-server/web/sdk/bytes.mjs';
import { createHerald } from '../../../permutation-server/web/frontier/herald.mjs';
import { setPin } from '../../../permutation-server/web/frontier/fchainio.mjs';

const HERALD = (process.env.LIVE_HERALD ?? 'http://127.0.0.1:41340').replace(/\/$/, '');
const RPC = process.env.LIVE_RPC ?? HERALD.replace(/:(\d+)$/, (_, p) => `:${Number(p) - 30}`);
const OUT = process.env.LIVE_OUT ?? fileURLToPath(new URL('../artifacts/live/agent-manual/', import.meta.url));
const PLAY = `${HERALD}/frontier/frontier/index.html`;
const AGENT = `${HERALD}/frontier/frontier/agent.html`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { herald: HERALD, steps: [], console: [] };

let browser;
let ctx;
before(async () => { mkdirSync(OUT, { recursive: true }); browser = await chromium.launch(); ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' }); });
after(async () => { report.chromium = browser?.version?.() ?? null; writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2)); await browser?.close(); });

const json = async (url, body) => (await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const rpc = (method, params) => json(RPC, { jsonrpc: '2.0', id: 1, method, params });
async function landed(signature, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = (await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).result?.value?.[0];
    if (st?.err) return { ok: false, err: st.err };
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return { ok: true, status: st.confirmationStatus };
    await sleep(500);
  }
  return { ok: false, err: 'timeout' };
}
async function until(label, fn, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1000); }
  throw new Error(`timed out: ${label}`);
}
const watch = page => {
  page.on('console', m => { if (m.type() === 'error') report.console.push({ page: page.url().split('/').pop(), text: m.text().slice(0, 300) }); });
  const sends = [];
  page.on('response', async r => {
    if (r.request().method() !== 'POST' || !/\/gw\/f\/relay$/.test(new URL(r.url()).pathname)) return;
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    sends.push({ status: r.status(), body });
  });
  return sends;
};
async function step(page, name, details = {}) {
  const file = `${String(report.steps.length + 1).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
  report.steps.push({ name, screenshot: file, ...details });
  console.log(`${file}: ${name}${details.note ? ' — ' + details.note : ''}`);
}
const textOf = page => page.innerText('body');
async function waitText(page, part, ms = 60_000) {
  try {
    return await until(`the page says "${part}"`, async () => ((await textOf(page)).includes(part) ? true : null), ms);
  } catch (e) {
    // What the page showed instead (a screenshot next to the report, and the start of its text in the error).
    await page.screenshot({ path: `${OUT}/failed-${Date.now()}.png` }).catch(() => {});
    const seen = (await textOf(page).catch(() => '')).replace(/\s+/g, ' ').slice(0, 600);
    throw new Error(`${e.message}; the page said: ${seen}`);
  }
}
/**
 * The control is shown and its text is light (the bar and the toasts are dark: a link styled for a light card would be
 * there but unreadable). Any CSS colour syntax: painted on a 1×1 canvas and read back.
 */
async function readableOnDark(el, what) {
  assert.ok(await el.isVisible(), `${what} is shown`);
  const { lum, color } = await el.evaluate(e => {
    const color = getComputedStyle(e).color, c = document.createElement('canvas').getContext('2d');
    c.fillStyle = color; c.fillRect(0, 0, 1, 1);
    const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
    return { lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, color };
  });
  assert.ok(lum > 0.6, `${what} is readable (text ${color}, luminance ${lum.toFixed(2)})`);
}
/** Clicks the hand's harvest and returns the relay's answer for it (a new POST /gw/f/relay). */
async function harvestByHand(page, sends) {
  const before = sends.length;
  await page.locator('[data-act="harvest"]').first().click();
  return until('the relay answered the harvest', async () => sends.slice(before).find(s => s.status) ?? null, 60_000);
}

test('a village played by hand, handed to its agent, taken back and played by hand again', { timeout: 30 * 60_000 }, async () => {
  // ---- the play page: connect the dev wallet, choose a nation, join (x402 with test USDC), the village
  // Join only once the season can take it (as the E2E and the page-browser scripts wait): the chain's clock past
  // genesis and every ring published. Earlier, Join is refused WrongStatus ("the season cannot do this now").
  const herald = createHerald({ base: HERALD });
  const season = await until('the season open for joining', async () => { const r = await herald.season(); return r.ok && r.record.rings?.length >= 5 && Number(r.record.latestUnix) >= Number(r.record.genesisTs) ? r : null; }, 600_000);
  const play = await ctx.newPage();
  const playSends = watch(play);
  await play.goto(PLAY);
  await play.locator('[data-act="intro-close"]').first().click();
  await play.locator('[data-act="connect"]').first().click();
  await play.locator('[data-act="pick-faction"][data-f="0"]').first().click();
  await play.locator('[data-act="home-confirm"]').first().click();
  const owner = await until('the connected wallet', () => play.evaluate(async () => (await import('/frontier/wallet.mjs')).connected()?.address ?? null), 30_000);
  // The village as the herald's decoded record has it (the client the pages use).
  const pin = setPin({ programId: season.record.programId, cluster: season.record.cluster, seasonId: season.record.season, seasonAddress: season.record.seasonAddress, rulesetHash: toHex(season.season.rulesetHash) });
  herald.pin(season.record.season, pin.addresses);
  const me = await until('the village', async () => { const r = await herald.me(owner); const h = r.ok ? r.holdings?.[0] : null; return h && h.state === 2 ? h : null; }, 180_000).catch(async e => { await play.screenshot({ path: `${OUT}/failed-village.png` }); report.failedText = (await textOf(play)).slice(0, 1500); throw e; });
  const village = [me.p, me.q, me.site];
  await play.locator('[data-act="mile-close"]').first().click().catch(() => {});
  await step(play, 'joined', { owner, village, note: 'joined through the page (dev wallet, x402 with test USDC); the first village placed' });

  const h1 = await harvestByHand(play, playSends);
  assert.equal(h1.status, 200, JSON.stringify(h1));
  const l1 = await landed(h1.body.signature);
  assert.ok(l1.ok, JSON.stringify(l1));
  await step(play, 'harvest-by-hand', { signature: h1.body.signature, chain: l1.status, note: 'a Harvest from the play page, signed by the page\'s session key, landed on chain' });

  // ---- the agent page (same origin, the same dev wallet): create, deposit, hand the key over, auto
  const agent = await ctx.newPage();
  watch(agent);
  await agent.goto(AGENT);
  await agent.locator('[data-act="connect"]').first().click();
  await waitText(agent, `ウォレット ${owner.slice(0, 8)}`);
  await agent.fill('form[data-form="create"] [name="village"]', village.join(','));
  await agent.fill('form[data-form="create"] [name="total"]', '1');
  await agent.fill('form[data-form="create"] [name="perDay"]', '0.5');
  await agent.locator('form[data-form="create"] button[type="submit"]').click();
  await waitText(agent, 'この一度だけ表示');
  const agentId = (await json(`${HERALD}/gw/f/agent/by-owner?owner=${owner}`)).agents[0].agentId;
  await agent.fill('form[data-form="deposit"] [name="amount"]', '1');
  await agent.locator('form[data-form="deposit"] button[type="submit"]').click();
  await waitText(agent, '預け入れました（1）', 120_000);
  await agent.locator('[data-act="delegate"]').click();
  await waitText(agent, '鍵を代理人に渡しました（確定', 120_000);
  await agent.locator('[data-act="mode"][data-mode="auto"]').click();
  await waitText(agent, '自動にしました');
  await step(agent, 'handed-over', { agentId, note: 'agent created, 1 test USDC deposited, SetSession to the agent key confirmed, auto' });

  // The operator's runner (the free rule autopilot on this stack) acts for the village.
  const acted = await until('the agent acted', async () => { const v = await json(`${HERALD}/gw/f/agent?id=${agentId}`); return v.history?.find(h => h.type === 'action' && h.source === 'ai' && h.status === 'sent') ? v : null; }, 240_000);
  const aiAction = acted.history.find(h => h.type === 'action' && h.source === 'ai' && h.status === 'sent');
  const l2 = await landed(aiAction.signature);
  assert.ok(l2.ok, JSON.stringify(l2));
  await waitText(agent, '行動 Harvest：送信');
  // What the page must say follows the relay's own reading of who drove (view.driver): the free rule autopilot on a
  // stack without a model; the autopilot standing in (with its cause) when a model is configured but failed or was
  // refused; the model when it decided.
  const drv = (await json(`${HERALD}/gw/f/agent?id=${agentId}`)).driver;
  const sentence = drv.state === 'model' ? 'モデルが判断しています' : drv.cause ? '無料の自動運転が代わりに動いています' : '無料の自動運転（ルール）で動いています';
  await waitText(agent, sentence);
  await step(agent, 'agent-acted', { signature: aiAction.signature, chain: l2.status, driver: acted.driver, spent: acted.balance.spent, note: `the agent's Harvest landed (driver: ${acted.driver.state}${acted.driver.cause ? ', ' + acted.driver.cause : ''}); the page said "${sentence}"` });

  // While the agent holds the key, the play page's own key no longer signs for the village. The page says so
  // (web/frontier/fdelegation.mjs) on the village's action bar (a player with a village never sees the drawer's join
  // card): the note, the take-back and the agent page link, readable; a refused send says why.
  await play.reload();
  await play.locator('[data-act="intro-close"]').first().click().catch(() => {});
  await waitText(play, '代理人に任せています', 90_000);
  const note = play.locator('.hand-note-agent');
  for (const sel of ['[data-act="session"]', 'a[data-agent-link]']) await readableOnDark(note.locator(sel).first(), `the action bar's ${sel}`);
  let whileDelegated = null;
  if (await play.locator('[data-act="harvest"]').count()) {
    const h = await harvestByHand(play, playSends).catch(e => ({ error: String(e.message) }));
    whileDelegated = { status: h.status ?? null, code: h.body?.code ?? null, error: h.body?.error ?? h.error ?? null };
    await waitText(play, '代理人に任せているため', 30_000);
    await readableOnDark(play.locator('.toast a[data-agent-link]').first(), 'the refusal\'s agent page link');
  }
  await step(play, 'play-while-delegated', { whileDelegated, note: 'the play page while the agent holds the key: the action bar says the village is handed to the agent, with the take-back and the agent page link; a refused send says why and links the agent page' });

  // ---- take the key back from the play page (its card: the wallet-signed SetSession); the page says the agent stays
  // in auto on the server; then the owner stops it on the agent page and plays by hand again
  await play.locator('[data-act="session"]').first().click();
  await waitText(play, 'サーバー上ではまだ自動です', 120_000);
  const back = await until('the chain no longer names the agent key', async () => { const v = await json(`${HERALD}/gw/f/agent?id=${agentId}`); return v.delegation?.delegated === false ? v : null; }, 60_000);
  assert.equal(back.mode, 'auto', 'taking the key back on the play page does not stop the agent on the server (and the page says so)');
  await step(play, 'taken-back-on-play-page', { delegation: back.delegation, mode: back.mode, note: 'the key taken back from the play page; the page says the agent is still in auto on the server' });
  await agent.reload();
  await agent.locator('[data-act="connect"]').first().click().catch(() => {});
  await agent.locator('[data-act="mode"][data-mode="manual"]').click();
  await waitText(agent, '停止中：あなたが手動に戻しました');
  const stopped = await json(`${HERALD}/gw/f/agent?id=${agentId}`);
  assert.equal(stopped.mode, 'manual');
  await step(agent, 'taken-back', { delegation: stopped.delegation, note: 'the agent stopped on its page after the key came back' });

  await play.reload();
  await play.locator('[data-act="intro-close"]').first().click().catch(() => {});
  await play.waitForTimeout(3000);
  const h3 = await harvestByHand(play, playSends);
  assert.equal(h3.status, 200, JSON.stringify(h3));
  const l3 = await landed(h3.body.signature);
  assert.ok(l3.ok, JSON.stringify(l3));
  await step(play, 'harvest-by-hand-again', { signature: h3.body.signature, chain: l3.status, note: 'the same village played by hand again from the play page after the key came back' });

  // ---- everything back to the owner's wallet
  await agent.locator('[data-act="withdraw-all"]').click();
  await waitText(agent, '引き出しを送りました', 120_000);
  const fin = await until('the withdrawal landed', async () => { const v = await json(`${HERALD}/gw/f/agent?id=${agentId}`); return v.balance.available === '0' && v.balance.pendingWithdraw === '0' ? v : null; });
  const b = fin.balance;
  assert.equal(BigInt(b.deposited), BigInt(b.withdrawn) + BigInt(b.spent.inference) + BigInt(b.spent.game) + BigInt(b.spent.network) + BigInt(b.reserved), 'the books balance');
  await step(agent, 'withdrawn', { balance: b, note: 'everything withdrawn to the owner\'s wallet' });
  report.summary = { owner, village, agentId, manualBefore: h1.body.signature, agent: aiAction.signature, whileDelegated, manualAfter: h3.body.signature, balance: b };
});
