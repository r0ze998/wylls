// The pages with a wallet that is NOT the page's own dev wallet: a test extension registered the way a browser
// extension registers (Wallet Standard `wallet-standard:register-wallet` / `app-ready`), whose "approval window" is
// this script (approve or reject each request, and a log of what each request asked). It rehearses stage 6
// (docs/agent-wallet/RUNBOOK-STAGE6-WALLET.ja.md §2–3) before a person does it with a real extension:
//
//   §2  the chooser lists unusable wallets with the reason (no solana:localnet, no signMessage) and the usable one;
//   §3a the play page joins with the extension (its message signature for the game key, its signature for the join);
//   §3b the agent page: connect, create, deposit, policy, hand the key over, auto, back to manual, take it back,
//       withdraw everything, each signed by the extension;
//   §3c four refusals in the "approval window" (create, deposit, hand-over, back to manual): nothing changes.
//
// What it does NOT show: how a real extension (Phantom, Backpack, Solflare …) displays these requests, whether it
// lists solana:localnet at all, or what its own simulation says. That is stage 6 itself (a person, a real extension).
//
// Needs a running stack with the agent wallet and its runner (no model needed), as agent-manual.live.mjs:
//   LIVE_HERALD=http://127.0.0.1:41740 node --test live/agent-extension.live.mjs
// Test assets only. The extension's key is generated for the run and never leaves this process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { toHex } from '../../../permutation-server/web/sdk/bytes.mjs';
import { createHerald } from '../../../permutation-server/web/frontier/herald.mjs';
import { setPin } from '../../../permutation-server/web/frontier/fchainio.mjs';
import { ata } from '../../../permutation-server/web/sdk/frontier/prize.mjs';

const HERALD = (process.env.LIVE_HERALD ?? 'http://127.0.0.1:41740').replace(/\/$/, '');
const RPC = process.env.LIVE_RPC ?? HERALD.replace(/:(\d+)$/, (_, p) => `:${Number(p) - 30}`);
const OUT = process.env.LIVE_OUT ?? fileURLToPath(new URL('../artifacts/live/agent-extension/', import.meta.url));
const PLAY = `${HERALD}/frontier/frontier/index.html`;
const AGENT = `${HERALD}/frontier/frontier/agent.html`;
const EXT = 'Test Extension';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { herald: HERALD, steps: [], prompts: [], console: [] };

let browser;
let ctx;
const key = Keypair.generate();
const owner = key.publicKey.toBase58();
// The "approval window": the next answers, in order ('approve' when the queue is empty).
const answers = [];
const answerNext = (...a) => answers.push(...a);

before(async () => {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  await ctx.exposeBinding('__testExtension', async ({ page }, kind, b64) => prompt(page, kind, Buffer.from(b64, 'base64')));
  await ctx.addInitScript(extensionScript, { address: owner, publicKey: [...key.publicKey.toBytes()], name: EXT });
});
after(async () => { report.chromium = browser?.version?.() ?? null; writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2)); await browser?.close(); });

// ---- the extension (in the page): three wallets; only the first can be used on localnet
function extensionScript({ address, publicKey, name }) {
  const b64 = u8 => btoa(String.fromCharCode(...u8));
  const u8 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const ask = async (kind, bytes) => {
    const r = await window.__testExtension(kind, b64(bytes));
    if (!r.ok) { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
    return u8(r.b64);
  };
  const account = Object.freeze({ address, publicKey: Uint8Array.from(publicKey), chains: ['solana:localnet'], features: ['solana:signTransaction', 'solana:signMessage'] });
  const make = (n, { chains, signMessage = true }) => ({
    version: '1.0.0', name: n, icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#4a6"/></svg>'),
    chains, accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { await ask('connect', new Uint8Array(0)); return { accounts: [account] }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signTransaction: (...inputs) => Promise.all(inputs.map(async ({ transaction }) => ({ signedTransaction: await ask('signTransaction', transaction) }))) },
      ...(signMessage ? { 'solana:signMessage': { version: '1.0.0',
        signMessage: (...inputs) => Promise.all(inputs.map(async ({ message }) => ({ signedMessage: message, signature: await ask('signMessage', message) }))) } } : {}),
    },
  });
  const wallets = [make(name, { chains: ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet'] }),
    make('Mainnet Only Wallet', { chains: ['solana:mainnet', 'solana:devnet', 'solana:testnet'] }),
    make('No Sign Message Wallet', { chains: ['solana:localnet'], signMessage: false })];
  const register = api => { try { api.register(...wallets); } catch (e) { console.warn(e); } };
  window.addEventListener('wallet-standard:app-ready', e => register(e.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
}

// ---- the "approval window" (in this process): what was asked, the answer, the signature
function shortvec(b, o) { let v = 0, s = 0, i = o; for (;;) { const x = b[i++]; v |= (x & 0x7f) << s; if (!(x & 0x80)) return [v, i]; s += 7; } }
function legacy(wire) {
  const [n, at] = shortvec(wire, 0);
  const message = wire.subarray(at + 64 * n);
  const [signers] = [message[0]];
  let [nk, o] = shortvec(message, 3);
  const keys = [];
  for (let i = 0; i < nk; i++, o += 32) keys.push(new PublicKey(message.subarray(o, o + 32)).toBase58());
  o += 32; // recent blockhash
  const [ni, o2] = shortvec(message, o);
  o = o2;
  const programs = [];
  for (let i = 0; i < ni; i++) {
    programs.push(keys[message[o++]]);
    const [na, oa] = shortvec(message, o); o = oa + na;
    const [nd, od] = shortvec(message, o); o = od + nd;
  }
  return { n, at, message, signers: keys.slice(0, signers), feePayer: keys[0], programs };
}
async function prompt(page, kind, bytes) {
  const answer = answers.shift() ?? 'approve';
  const entry = { at: new Date().toISOString(), page: new URL(page.url()).pathname.split('/').pop(), kind, answer };
  if (kind === 'signMessage') entry.firstLine = Buffer.from(bytes).toString('utf8').split('\n')[0].slice(0, 120);
  if (kind === 'signTransaction') {
    const t = legacy(bytes);
    Object.assign(entry, { feePayer: t.feePayer === owner ? 'this wallet' : t.feePayer, signers: t.signers.length, programs: t.programs });
  }
  report.prompts.push(entry);
  if (answer !== 'approve') return { ok: false };
  if (kind === 'connect') return { ok: true, b64: '' };
  if (kind === 'signMessage') return { ok: true, b64: Buffer.from(nacl.sign.detached(bytes, key.secretKey)).toString('base64') };
  const t = legacy(bytes);
  const i = t.signers.indexOf(owner);
  assert.ok(i >= 0, 'the extension is a signer of what it is asked to sign');
  const signed = Uint8Array.from(bytes);
  signed.set(nacl.sign.detached(t.message, key.secretKey), t.at + 64 * i);
  return { ok: true, b64: Buffer.from(signed).toString('base64') };
}

// ---- helpers (as agent-manual.live.mjs)
const json = async (url, body) => (await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const rpc = (method, params) => json(RPC, { jsonrpc: '2.0', id: 1, method, params });
async function until(label, fn, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1000); }
  throw new Error(`timed out: ${label}`);
}
const textOf = page => page.innerText('body');
async function waitText(page, part, ms = 60_000) {
  try {
    return await until(`the page says "${part}"`, async () => ((await textOf(page)).includes(part) ? true : null), ms);
  } catch (e) {
    await page.screenshot({ path: `${OUT}/failed-${Date.now()}.png` }).catch(() => {});
    throw new Error(`${e.message}; the page said: ${(await textOf(page).catch(() => '')).replace(/\s+/g, ' ').slice(0, 600)}`);
  }
}
async function step(page, name, details = {}) {
  const file = `${String(report.steps.length + 1).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
  report.steps.push({ name, screenshot: file, ...details });
  console.log(`${file}: ${name}${details.note ? ' — ' + details.note : ''}`);
}
const watch = page => page.on('console', m => { if (m.type() === 'error') report.console.push({ page: page.url().split('/').pop(), text: m.text().slice(0, 300) }); });
const view = id => json(`${HERALD}/gw/f/agent?id=${id}`);
const lastPrompt = () => report.prompts[report.prompts.length - 1];
/**
 * The owner's test USDC (base units): their associated token account's amount (SPL layout: u64 at byte 64), read with
 * getAccountInfo (the local chain's RPC has no getTokenAccountsByOwner). No account yet reads 0; an RPC error throws.
 */
async function walletUsdc(mint) {
  const r = await rpc('getAccountInfo', [ata(owner, mint), { encoding: 'base64' }]);
  if (r.error) throw new Error(`getAccountInfo: ${JSON.stringify(r.error)}`);
  if (!r.result?.value) return 0n;
  return Buffer.from(r.result.value.data[0], 'base64').readBigUInt64LE(64);
}

test('a wallet that is not the page\'s own: the chooser, joining, the agent page signed by it, and its refusals', { timeout: 30 * 60_000 }, async () => {
  const terms = await json(`${HERALD}/gw/f/agent/terms`);
  assert.equal(terms.enabled, true, 'the stack runs the agent wallet');
  const herald = createHerald({ base: HERALD });
  const season = await until('the season open for joining', async () => { const r = await herald.season(); return r.ok && r.record.rings?.length >= 5 && Number(r.record.latestUnix) >= Number(r.record.genesisTs) ? r : null; }, 600_000);
  const pin = setPin({ programId: season.record.programId, cluster: season.record.cluster, seasonId: season.record.season, seasonAddress: season.record.seasonAddress, rulesetHash: toHex(season.season.rulesetHash) });
  herald.pin(season.record.season, pin.addresses);

  // ---- §2: the agent page's chooser — the usable extension, and the two unusable ones with their reasons
  const agent = await ctx.newPage();
  watch(agent);
  await agent.goto(AGENT);
  await waitText(agent, `${EXT}でつなぐ`);
  const rows = await agent.locator('.agent-wallets li').allInnerTexts();
  const row = n => rows.find(r => r.includes(n)) ?? '';
  assert.match(row('Mainnet Only Wallet'), /このネットワーク（solana:localnet）に対応していません/);
  assert.match(row('No Sign Message Wallet'), /メッセージの署名に対応していません/);
  assert.equal(await agent.locator(`button[data-act="connect"][data-key="${EXT}"]`).isDisabled(), false);
  assert.equal(await agent.locator('button[data-act="connect"][data-key="Mainnet Only Wallet"]').isDisabled(), true);
  // (and it looks it: an unusable wallet's button is greyed, not the same as the usable one)
  const opacity = sel => agent.locator(sel).evaluate(e => Number(getComputedStyle(e).opacity));
  assert.ok(await opacity('button[data-act="connect"][data-key="Mainnet Only Wallet"]') < 0.7 && await opacity(`button[data-act="connect"][data-key="${EXT}"]`) === 1, 'the unusable wallet is greyed');
  await step(agent, 'chooser', { rows, note: 'the extension is offered; a mainnet-only wallet and one without signMessage are listed with the reason and cannot be pressed' });

  // ---- §3a: the play page joins with the extension
  const play = await ctx.newPage();
  watch(play);
  await play.goto(PLAY);
  await play.locator('[data-act="intro-close"]').first().click();
  await play.locator('button[data-act="connect"]', { hasText: EXT }).first().click();
  await play.locator('[data-act="pick-faction"][data-f="0"]').first().click();
  await play.locator('[data-act="home-confirm"]').first().click();
  const home = await until('the village', async () => { const r = await herald.me(owner); const h = r.ok ? r.holdings?.[0] : null; return h && h.state === 2 ? h : null; }, 240_000);
  await play.locator('[data-act="mile-close"]').first().click().catch(() => {});
  const joinPrompts = report.prompts.filter(p => p.page === 'index.html').map(p => p.kind);
  assert.ok(joinPrompts.includes('connect') && joinPrompts.includes('signMessage') && joinPrompts.includes('signTransaction'), JSON.stringify(joinPrompts));
  const village = [home.p, home.q, home.site];
  await step(play, 'joined', { owner, village, prompts: joinPrompts, note: 'joined with the extension: connect, a message signature (the game key), a transaction signature (the join)' });

  // ---- §3b/§3c on the agent page
  await agent.reload();
  await agent.locator(`button[data-act="connect"][data-key="${EXT}"]`).click();
  await waitText(agent, `ウォレット ${owner.slice(0, 8)}`);
  const fillCreate = async () => {
    await agent.fill('form[data-form="create"] [name="village"]', village.join(','));
    await agent.fill('form[data-form="create"] [name="total"]', '1');
    await agent.fill('form[data-form="create"] [name="perDay"]', '0.5');
  };
  // R1: the create's message signature refused → no agent
  await fillCreate();
  answerNext('reject');
  await agent.locator('form[data-form="create"] button[type="submit"]').click();
  await waitText(agent, 'ウォレットで取り消されました');
  assert.equal(lastPrompt().kind, 'signMessage');
  assert.match(lastPrompt().firstLine, /^Wylls agent wallet command v1/);
  await sleep(1500);
  assert.equal((await json(`${HERALD}/gw/f/agent/by-owner?owner=${owner}`)).agents.length, 0, 'R1: no agent was made');
  assert.equal(await agent.inputValue('form[data-form="create"] [name="village"]'), village.join(','), 'R1: what the owner typed is still there');
  await step(agent, 'r1-create-refused', { note: 'R1: the message signature refused in the extension; no agent' });
  // 2: create
  await agent.locator('form[data-form="create"] button[type="submit"]').click();
  await waitText(agent, 'この一度だけ表示');
  const agentId = (await json(`${HERALD}/gw/f/agent/by-owner?owner=${owner}`)).agents[0].agentId;
  await step(agent, 'created', { agentId, prompt: lastPrompt() });
  // R2: the deposit's transaction signature refused → nothing deposited
  const usdcBefore = await walletUsdc(terms.mint);
  assert.ok(usdcBefore >= 1_000_000n, `the wallet holds test USDC to deposit (${usdcBefore})`);
  await agent.fill('form[data-form="deposit"] [name="amount"]', '1');
  answerNext('reject');
  await agent.locator('form[data-form="deposit"] button[type="submit"]').click();
  await waitText(agent, 'ウォレットで取り消されました');
  assert.equal(lastPrompt().kind, 'signTransaction');
  await sleep(1500);
  assert.equal((await view(agentId)).balance.deposited, '0', 'R2: nothing deposited');
  assert.equal(await walletUsdc(terms.mint), usdcBefore, 'R2: the wallet\'s test USDC unchanged');
  await step(agent, 'r2-deposit-refused', { prompt: lastPrompt(), note: 'R2: the transaction signature refused; nothing moved' });
  // 3: deposit
  await agent.locator('form[data-form="deposit"] button[type="submit"]').click();
  await waitText(agent, '預け入れました（1）', 120_000);
  const dep = lastPrompt();
  assert.equal(dep.kind, 'signTransaction');
  assert.notEqual(dep.feePayer, 'this wallet', 'the relay pays the deposit\'s fee');
  assert.equal((await view(agentId)).balance.deposited, '1000000');
  assert.equal(usdcBefore - await walletUsdc(terms.mint), 1_000_000n, 'the deposit left the extension\'s wallet');
  await step(agent, 'deposited', { prompt: dep, note: 'the deposit signed by the extension; the relay paid the fee' });
  // 4: policy
  await agent.locator('form[data-form="policy"] button[type="submit"]').click();
  await waitText(agent, '保存しました（版 2）');
  await step(agent, 'policy', { prompt: lastPrompt() });
  // R3: the hand-over (SetSession) refused → the chain's delegation unchanged
  answerNext('reject');
  await agent.locator('[data-act="delegate"]').click();
  await waitText(agent, 'ウォレットで取り消されました');
  assert.equal(lastPrompt().kind, 'signTransaction');
  await sleep(1500);
  assert.equal((await view(agentId)).delegation?.delegated, false, 'R3: the chain does not name the agent key');
  await step(agent, 'r3-delegate-refused', { prompt: lastPrompt(), note: 'R3: SetSession refused; the delegation unchanged' });
  // 5: hand the key over
  await agent.locator('[data-act="delegate"]').click();
  await waitText(agent, '鍵を代理人に渡しました', 120_000);
  await until('the chain names the agent key', async () => (await view(agentId)).delegation?.delegated === true, 60_000);
  await step(agent, 'delegated', { prompt: lastPrompt() });
  // 6: auto, and the agent acts
  await agent.locator('[data-act="mode"][data-mode="auto"]').click();
  await waitText(agent, '自動にしました');
  const acted = await until('the agent acted', async () => { const v = await view(agentId); return v.history?.find(h => h.type === 'action' && h.source === 'ai' && h.status === 'sent') ? v : null; }, 240_000);
  await step(agent, 'auto-acted', { action: acted.history.find(h => h.type === 'action' && h.source === 'ai')?.name });
  // R4: back to manual refused → still auto
  answerNext('reject');
  await agent.locator('[data-act="mode"][data-mode="manual"]').click();
  await waitText(agent, 'ウォレットで取り消されました');
  await sleep(1500);
  assert.equal((await view(agentId)).mode, 'auto', 'R4: still auto');
  await step(agent, 'r4-manual-refused', { prompt: lastPrompt(), note: 'R4: the stop refused in the extension; the agent stays in auto' });
  // 7: back to manual
  await agent.locator('[data-act="mode"][data-mode="manual"]').click();
  await waitText(agent, '停止中：あなたが手動に戻しました');
  // 8: take the key back
  await agent.locator('[data-act="revoke"]').click();
  await waitText(agent, '鍵を取り戻しました', 120_000);
  await until('the chain no longer names the agent key', async () => (await view(agentId)).delegation?.delegated === false, 60_000);
  await step(agent, 'stopped-and-revoked', { prompt: lastPrompt() });
  // 9: everything back to the extension's wallet
  const beforeWithdraw = await walletUsdc(terms.mint);
  await agent.locator('[data-act="withdraw-all"]').click();
  await waitText(agent, '引き出しを送りました', 120_000);
  const fin = await until('the withdrawal landed', async () => { const v = await view(agentId); return v.balance.available === '0' && v.balance.pendingWithdraw === '0' ? v : null; });
  const b = fin.balance;
  assert.equal(BigInt(b.deposited), BigInt(b.withdrawn) + BigInt(b.spent.inference) + BigInt(b.spent.game) + BigInt(b.spent.network) + BigInt(b.reserved), 'the books balance');
  const afterWithdraw = await until('the wallet received it', async () => { const u = await walletUsdc(terms.mint); return u > beforeWithdraw ? u : null; }, 60_000);
  assert.equal(afterWithdraw - beforeWithdraw, BigInt(b.withdrawn), 'the wallet got back what the ledger says was withdrawn');
  await step(agent, 'withdrawn', { balance: b, wallet: { before: String(beforeWithdraw), after: String(afterWithdraw) } });
  report.summary = { owner, agentId, prompts: report.prompts.length, refused: report.prompts.filter(p => p.answer !== 'approve').length, balance: b };
});
