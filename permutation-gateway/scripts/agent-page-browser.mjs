// The owner's agent page in a REAL browser: Google Chrome (headless, driven
// over the DevTools protocol with the `ws` package — no Playwright, no
// extension), against a running local stack, the dev wallet of the page
// itself (its key is put in the browser's localStorage before the page
// loads). Clicks are mouse events, values are typed, the page's own modules
// sign. This is not the fake-DOM smoke (agent-page-smoke.mjs); it is the
// page as a visitor gets it, CSP and all.
//
// Covers: connect → create → deposit (sponsored) → budget and allowed actions
// (the policy form) → hand the key over (SetSession, confirmed on chain) →
// auto → the runner acts → a refused message signature and a refused
// transaction signature (the wallet rejects at the Wallet Standard boundary)
// → the network down (offline) and back → a reload → a stop while a model
// call is in flight (the stand-in holds the call) and a withdrawal with that
// hold running → the key taken back (confirmed) → everything withdrawn.
// Screenshots and the page's text at every step go to AGENT_PAGE_OUT.
//
// Not covered: a real wallet extension (Phantom, Backpack …) — its approval
// window cannot be driven here; the dev wallet signs in-page instead.
//
//   Start a stack with the agent wallet and its runner on a stand-in model URL this script serves (the E2E's header has
//   the command; FRONTIER_AGENT_LLM_URL=http://127.0.0.1:41698), then:
//   AGENT_PAGE_URL=http://127.0.0.1:41640 AGENT_PAGE_RPC=http://127.0.0.1:41610 AGENT_PAGE_MODEL_PORT=41698 \
//   AGENT_PAGE_OUT=.local/agent-wallet-e2e/browser-1 node permutation-gateway/scripts/agent-page-browser.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { joinViaX402 } from '../../permutation-server/web/sdk/frontier/prize.mjs';
import * as wallet from '../../permutation-server/web/wallet.mjs';
import * as fsession from '../../permutation-server/web/frontier/fsession.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { setPin } from '../../permutation-server/web/frontier/fchainio.mjs';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = process.env.AGENT_PAGE_URL ?? 'http://127.0.0.1:41640';
const rpcUrl = process.env.AGENT_PAGE_RPC ?? 'http://127.0.0.1:41610';
const modelPort = Number(process.env.AGENT_PAGE_MODEL_PORT ?? 41698);
const devtoolsPort = Number(process.env.AGENT_PAGE_DEVTOOLS_PORT ?? 41697);
for (const u of [base, rpcUrl]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(u).hostname), 'local-only');
const outDir = path.resolve(process.env.AGENT_PAGE_OUT ?? fileURLToPath(new URL(`../../.local/agent-wallet-e2e/browser-${new Date().toISOString().replace(/[:.]/g, '-')}`, import.meta.url)));
mkdirSync(outDir, { recursive: true });
const gw = `${base}/gw`;
const pageUrl = `${base}/frontier/frontier/agent.html`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2);
const report = { mode: 'agent-page-real-browser', browser: null, testAssetsOnly: true, base, pageUrl, startedAt: new Date().toISOString(), steps: [], console: [], notVerified: ['a real wallet extension (Phantom, Backpack …): its approval window cannot be driven here; the page\'s dev wallet signs in-page'] };
const save = () => writeFileSync(path.join(outDir, 'report.json'), `${json(report)}\n`);
let n = 0;
const api = async (p, body) => { const r = await fetch(gw + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const agentView = async id => (await api(`/f/agent?id=${id}`)).body;

// ---------------------------------------------------------------- the stand-in model (loopback): Harvest; or held open while `stall` is set
const model = { calls: 0, stall: false, held: [] };
const modelServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    model.calls++;
    assert.equal(body.includes('capability'), false, 'the model never sees a token');
    const answer = a => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: a, fields: {}, reason: 'browser test' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6 } })); };
    if (model.stall) { model.held.push(() => answer('rest')); return; }
    answer('Harvest');
  });
});
await new Promise(r => modelServer.listen(modelPort, '127.0.0.1', r));

// ---------------------------------------------------------------- Chrome over the DevTools protocol
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.handlers = []; ws.on('message', m => this.#on(JSON.parse(m))); }
  #on(msg) {
    if (msg.id && this.waits.has(msg.id)) { const { res, rej } = this.waits.get(msg.id); this.waits.delete(msg.id); if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`)); else res(msg.result); }
    else if (msg.method) for (const h of this.handlers) h(msg);
  }
  send(method, params = {}, sessionId = undefined) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((res, rej) => this.waits.set(id, { res, rej })); }
  on(fn) { this.handlers.push(fn); }
  async waitFor(method, sessionId, ms = 30_000) { return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`no ${method} in ${ms} ms`)), ms); const h = m => { if (m.method === method && (!sessionId || m.sessionId === sessionId)) { clearTimeout(t); this.handlers = this.handlers.filter(x => x !== h); res(m.params); } }; this.on(h); }); }
}
const profile = mkdtempSync(path.join(os.tmpdir(), 'agent-page-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${devtoolsPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1100,1500', 'about:blank'], { stdio: 'ignore' });
let version = null;
for (let i = 0; i < 60 && !version; i++) { await sleep(500); version = await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`).then(r => r.json()).catch(() => null); }
assert.ok(version?.webSocketDebuggerUrl, 'Chrome did not open its DevTools port');
report.browser = { product: version.Browser, protocol: version['Protocol-Version'], headless: true, driver: 'DevTools protocol over ws (no Playwright, no extension)' };
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const cdp = new Cdp(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const S = sessionId;
await cdp.send('Page.enable', {}, S);
await cdp.send('Runtime.enable', {}, S);
await cdp.send('Network.enable', {}, S);
await cdp.send('Log.enable', {}, S);
cdp.on(m => {
  if (m.sessionId !== S) return;
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) report.console.push({ type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
  if (m.method === 'Runtime.exceptionThrown') report.console.push({ type: 'exception', text: String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 300) });
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) report.console.push({ type: `log:${m.params.entry.level}`, text: String(m.params.entry.text).slice(0, 300), source: m.params.entry.source, url: m.params.entry.url ?? null });
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) report.console.push({ type: `http:${m.params.response.status}`, text: m.params.response.url.slice(0, 200) });
});
const evaluate = async (expression, { awaitPromise = true } = {}) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, S);
  if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result?.value;
};
const navigate = async url => { const p = cdp.waitFor('Page.loadEventFired', S, 30_000); await cdp.send('Page.navigate', { url }, S); await p; };
const text = () => evaluate(`document.getElementById('agent-root')?.innerText ?? ''`);
const shot = async name => { const f = `${String(++n).padStart(2, '0')}-${name}.png`; const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, S); writeFileSync(path.join(outDir, f), Buffer.from(r.data, 'base64')); return f; };
const step = async (name, details = {}) => { const t = await text(); const s = { name, ok: true, at: new Date().toISOString(), screenshot: await shot(name), text: t.replace(/\s+/g, ' ').slice(0, 400), ...details }; report.steps.push(s); save(); console.log(`${s.screenshot}: ${name}${details.note ? ' — ' + details.note : ''}`); return s; };
/** The page's own error line (a note with the "bad" tone): its text once it appears. */
const waitBad = async (ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { const t = await evaluate(`document.querySelector('.agent-note.tone-bad')?.innerText ?? ''`); if (t) return t; await sleep(300); } throw new Error('the page showed no error'); };
const waitText = async (part, ms = 60_000) => { const end = Date.now() + ms; let t = ''; while (Date.now() < end) { t = await text(); if (t.includes(part)) return t; await sleep(500); } throw new Error(`the page never said "${part}"; it says: ${t.replace(/\s+/g, ' ').slice(0, 500)}`); };
const selector = (act, data = {}) => `[data-act="${act}"]${Object.entries(data).map(([k, v]) => `[data-${k}="${v}"]`).join('')}`;
const rectOf = async sel => {
  const r = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; })()`);
  assert.ok(r && r.w > 0 && r.h > 0, `no visible element ${sel}`);
  return r;
};
const clickAt = async ({ x, y }) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, S);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, S);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, S);
};
const clickAct = async (act, data = {}) => clickAt(await rectOf(selector(act, data)));
const type = async (sel, value) => {
  await clickAt(await rectOf(sel));
  await evaluate(`document.activeElement && document.activeElement.select && document.activeElement.select()`, { awaitPromise: false });
  await cdp.send('Input.insertText', { text: String(value) }, S);
};
const submitForm = async (form, values) => {
  for (const [name, v] of Object.entries(values)) {
    const sel = `form[data-form="${form}"] [name="${name}"]`;
    if (typeof v === 'boolean') { const checked = await evaluate(`document.querySelector(${JSON.stringify(sel)}).checked`); if (checked !== v) await clickAt(await rectOf(sel)); }
    else await type(sel, v);
  }
  await clickAt(await rectOf(`form[data-form="${form}"] button[type="submit"]`));
};
// The wallet at the Wallet Standard boundary (the page's own module instance): make it refuse, then restore.
const walletRefuses = async (feature, refuse) => evaluate(`(async () => { const w = await import('/frontier/wallet.mjs'); const dev = w.list('solana:localnet').find(e => e.dev).wallet; const f = dev.features[${JSON.stringify(feature)}]; const k = ${JSON.stringify(feature === 'solana:signMessage' ? 'signMessage' : 'signTransaction')}; if (${refuse}) { globalThis.__orig = globalThis.__orig || {}; globalThis.__orig[k] = f[k]; f[k] = () => Promise.reject(Object.assign(new Error('User rejected the request'), { code: 4001 })); } else { f[k] = globalThis.__orig[k]; } return true; })()`);

async function run() {
  // ---- the owner, by the page's own dev wallet key: faucet, join, home (the play page would do this; the agent page starts after it)
  const seed = randomBytes(32);
  const key = await keyFromSeed(seed);
  setRelay(gw);
  const herald = createHerald({ base });
  let s = null;
  for (let i = 0; i < 600 && !s; i++) { const r = await herald.season(); if (r.ok && r.record.rings?.length >= 5 && Number(r.record.latestUnix) >= Number(r.record.genesisTs)) s = r; else await sleep(500); }
  assert.ok(s, 'the season');
  const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  herald.pin(s.record.season, pin.addresses);
  const w = await wallet.connect(wallet.devWallet(key), { chain: 'solana:localnet' });
  const faucet = await api('/f/faucet', { wallet: w.address });
  assert.equal(faucet.status, 200, json(faucet));
  await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [w.address, 1_000_000_000] }) });
  let home = null;
  for (let i = 0; i < 120 && !home; i++) { for (const at of ringProvinces(3)) { const r = await herald.province(at.p, at.q); if (!r.ok) continue; const sites = homeSites(r.province, { ringsOpen: s.record.rings.length }); if (sites.length) { home = sites[0]; break; } } if (!home) await sleep(1000); }
  assert.ok(home, 'a free home');
  // The session key as the page derives it (the message names the page's origin): the same key in the browser.
  const session = await fsession.derive({ wallet: w, cluster: pin.cluster, programId: pin.programId, seasonId: pin.seasonId, origin: base, host: new URL(base).host });
  const joined = await joinViaX402(gw, { wallet: w.address, sign: async m => (await w.signMessage(m)).signature, faction: home.faction, session: session.publicKeyBytes, sessionExpiry: BigInt(s.record.latestUnix) + 7n * 86_400n, maxFee: 25_000_000n });
  assert.ok(joined.signature, json(joined));
  const ctx = { addresses: pin.addresses, wallet: w.address, actor: session.publicKey, faction: home.faction, holding: home, province: home };
  const placed = await submit({ name: 'PlaceHome', accounts: accountsFor('PlaceHome', ctx), fields: { p: home.p, q: home.q, site: home.site }, signer: { session } });
  assert.ok(placed.ok, json(placed));
  assert.ok((await track(placed.signature, { tries: 80, every: 500 })).ok);
  let me = null;
  for (let i = 0; i < 120 && !me; i++) { const r = await herald.me(w.address); if (r.ok && r.holdings[0]?.state === 2) me = r; else await sleep(500); }
  const village = [me.holdings[0].p, me.holdings[0].q, me.holdings[0].site];
  report.owner = { wallet: w.address, village, join: joined.signature };
  console.log('owner ready', w.address, village);

  // ---- the browser: the page once (its dev wallet key is created only on "connect"), the owner's key and the language into
  // localStorage at that origin, then the page again. (Only the agent page is loaded: its console is what the report records.)
  await navigate(pageUrl);
  await evaluate(`localStorage.setItem('ps-dev-wallet', ${JSON.stringify(toHex(seed))}); localStorage.setItem('ps-lang', 'ja'); true`, { awaitPromise: false });
  report.console.length = 0;
  await navigate(pageUrl);
  await waitText('テスト用ウォレットでつなぐ');
  await step('page-loaded', { note: 'the page from the herald, CSP on; the relay has the agent wallet on' });
  await clickAct('connect');
  await waitText(`ウォレット ${w.address.slice(0, 8)}`);
  await step('connected', { note: 'the dev wallet connected by a click; its key was in localStorage' });

  // ---- create (the first budget), deposit, the policy form (budget and allowed actions)
  await submitForm('create', { village: village.join(','), total: '1', perDay: '0.5' });
  await waitText('この一度だけ表示');
  const mine = (await api(`/f/agent/by-owner?owner=${w.address}`)).body.agents;
  assert.equal(mine.length, 1);
  const agentId = mine[0].agentId;
  await step('created', { agentId, note: 'the command was signed by the page\'s wallet; the capability token is shown once' });
  await submitForm('deposit', { amount: '2' });
  await waitText('預け入れました（2）');
  let v = await agentView(agentId);
  assert.equal(v.balance.available, '2000000');
  await step('deposited', { balance: v.balance, note: 'a sponsored deposit: the wallet signed the transfer, the relay paid the fee and credited after the chain confirmed' });
  await submitForm('policy', { 'g-economy': true, 'g-vigil': true, total: '1.5', perDay: '0.6' });
  await waitText('保存しました（版 2）');
  v = await agentView(agentId);
  assert.deepEqual([v.policy.version, v.policy.budget.total, v.policy.budget.perDay, v.policy.allowed.includes('SetVigil')], [2, '1500000', '600000', true]);
  await step('policy-saved', { policy: v.policy, note: 'budget 1.5 / 0.6 a day, economy and vigil allowed' });

  // ---- the key to the agent (SetSession through the relay, wallet-signed), then auto
  assert.ok((await text()).includes('止まっていて、鍵はあなたのものです'), 'the four-state line: stopped, not delegated');
  await clickAct('delegate');
  await waitText('鍵を代理人に渡しました（確定', 120_000);
  v = await agentView(agentId);
  assert.equal(v.delegation.delegated, true);
  await step('delegated', { delegation: v.delegation, note: 'SetSession signed by the wallet, confirmed on chain; the page says so' });
  await clickAct('mode', { mode: 'auto' });
  await waitText('自動で動いています');
  await step('auto', { note: 'the runner is on for this agent' });
  let acted = null;
  for (let i = 0; i < 60 && !acted; i++) { await sleep(2000); const x = await agentView(agentId); if (x.history.some(h => h.type === 'action' && h.source === 'ai' && h.status === 'sent')) acted = x; }
  assert.ok(acted, 'the runner acted');
  await waitText('判断', 20_000);
  await step('runner-acted', { spent: acted.balance.spent, modelCalls: model.calls, note: 'the stand-in model answered Harvest; the page shows the charged call and the free network fee' });

  // ---- refusals at the wallet: a message (an owner command) and a transaction (a deposit)
  await walletRefuses('solana:signMessage', true);
  await clickAct('mode', { mode: 'manual' });
  const said1 = await waitBad();
  assert.ok(said1.includes('取り消されました'), said1);
  v = await agentView(agentId);
  assert.equal(v.mode, 'auto', 'a refused signature changes nothing');
  await step('message-signature-refused', { said: said1, modeStillAuto: v.mode === 'auto', note: 'the wallet rejected the command\'s signature: the page reports it, the agent is still auto' });
  await walletRefuses('solana:signMessage', false);
  await walletRefuses('solana:signTransaction', true);
  const before = (await agentView(agentId)).balance.deposited;
  await submitForm('deposit', { amount: '1' });
  const said2 = await waitBad();
  assert.ok(said2.includes('取り消されました'), said2);
  v = await agentView(agentId);
  assert.equal(v.balance.deposited, before, 'nothing deposited');
  await step('transaction-signature-refused', { said: said2, deposited: v.balance.deposited, note: 'the wallet rejected the deposit transaction: nothing sent, nothing credited' });
  await walletRefuses('solana:signTransaction', false);

  // ---- the network down: a command fails visibly; back up: the page recovers on its own refresh
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  await clickAct('mode', { mode: 'manual' });
  const offlineText = await waitBad(20_000);
  v = await agentView(agentId);
  assert.equal(v.mode, 'auto', 'nothing reached the relay');
  await step('offline', { modeStillAuto: v.mode === 'auto', said: offlineText.replace(/\s+/g, ' ').slice(0, 200), note: 'offline: the command did not go out, the page says the request failed' });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  await sleep(7_000);
  await waitText('自動で動いています');
  await step('online-again', { note: 'back online: the periodic refresh redrew the page' });

  // ---- reload: the page starts over; one click reconnects the same wallet and finds the agent
  await cdp.send('Page.reload', {}, S);
  await cdp.waitFor('Page.loadEventFired', S, 30_000);
  await waitText('テスト用ウォレットでつなぐ');
  await clickAct('connect');
  await waitText('自動で動いています');
  assert.ok(!(await text()).includes('この一度だけ表示'), 'the capability token is not shown again');
  await step('reloaded', { note: 'after a reload: connect again finds the one agent of this wallet; the token is not shown again' });

  // ---- a stop while a model call is in flight: the hold stays running, the call is paid when it returns; a withdrawal meanwhile leaves it
  model.stall = true;
  let running = null;
  for (let i = 0; i < 60 && !running; i++) { await sleep(1000); const x = await agentView(agentId); running = x.holds.find(h => h.category === 'inference' && h.state === 'running') ?? null; }
  assert.ok(running, 'a running inference hold');
  await clickAct('mode', { mode: 'manual' });
  await waitText('止めました');
  v = await agentView(agentId);
  assert.equal(v.mode, 'manual');
  assert.equal(v.holds.find(h => h.id === running.id)?.state, 'running', 'the stop does not give a running call back');
  assert.equal(v.balance.reserved, '10000');
  await step('stopped-in-flight', { hold: running.id, reserved: v.balance.reserved, note: 'stopped while the model works: the call stays reserved, the page shows the reserved amount' });
  await clickAct('withdraw-all');
  await waitText('引き出しを送りました');
  v = await agentView(agentId);
  assert.equal(v.balance.reserved, '10000', 'the running call is not withdrawn');
  await step('withdraw-with-call-in-flight', { balance: v.balance, note: 'everything but the running call left; the call\'s money waits for its result' });
  const spentBefore = BigInt(v.balance.spent.inference);
  model.stall = false;
  for (const release of model.held.splice(0)) release();
  let settled = null;
  for (let i = 0; i < 30 && !settled; i++) { await sleep(1000); const x = await agentView(agentId); if (BigInt(x.balance.spent.inference) > spentBefore && x.balance.reserved === '0') settled = x; }
  assert.ok(settled, 'the late result settled the call');
  await sleep(6_000);
  await step('in-flight-call-settled', { spent: settled.balance.spent, reserved: settled.balance.reserved, note: 'the model answered after the stop: charged once, nothing acted on (the agent is manual)' });

  // ---- the key back (wallet-signed SetSession, confirmed), then the rest withdrawn
  await clickAct('revoke');
  await waitText('鍵を取り戻しました', 120_000);
  v = await agentView(agentId);
  assert.equal(v.delegation.delegated, false);
  await step('revoked', { delegation: v.delegation, note: 'the chain no longer names the agent key' });
  const left = BigInt(v.balance.available);
  if (left > 0n) { await clickAct('withdraw-all'); await waitText('引き出しを送りました'); }
  for (let i = 0; i < 40; i++) { await sleep(500); const x = await agentView(agentId); if (x.balance.pendingWithdraw === '0' && x.balance.available === '0') { v = x; break; } }
  assert.equal(v.balance.available, '0');
  assert.equal(BigInt(v.balance.deposited), BigInt(v.balance.spent.inference) + BigInt(v.balance.withdrawn) + BigInt(v.balance.reserved) + BigInt(v.balance.pendingWithdraw), 'deposited = spent + withdrawn');
  await sleep(6_000);
  await step('withdrawn', { balance: v.balance, note: 'the books balance; the page shows the final balance' });
  report.finishedAt = new Date().toISOString();
  report.summary = { steps: report.steps.length, consoleErrors: report.console.filter(c => c.type !== 'warning' && c.type !== 'log:warning').length, modelCalls: model.calls };
  save();
  console.log(`agent-page-browser: ${report.steps.length} steps; ${report.console.length} console entries; ${outDir}`);
}

try {
  await run();
} catch (e) {
  report.error = String(e?.stack ?? e);
  try { await shot('failed'); } catch { /* no page */ }
  save();
  console.error(report.error);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch { /* closed */ }
  const gone = new Promise(res => { chrome.once('exit', res); setTimeout(res, 5_000); });
  chrome.kill('SIGTERM');
  await gone;
  modelServer.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Chrome's leftovers in the temp dir: harmless */ }
}
