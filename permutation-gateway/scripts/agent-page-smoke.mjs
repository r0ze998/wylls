// The owner's agent page (web/frontier/fagent.mjs) driven end to end
// against a running local stack, without a browser: a small fake DOM holds
// the page's markup and dispatches its clicks and form submits, the real
// wallet module signs with the dev wallet, the real relay and herald answer.
// Covers what the page is for: connect → create → deposit (sponsored) →
// hand the key over (SetSession, confirmed) → auto → the agent acts →
// stop → take the key back (confirmed) → withdraw everything.
//
//   AGENT_PAGE_URL=http://127.0.0.1:41940 node permutation-gateway/scripts/agent-page-smoke.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { ata, joinViaX402 } from '../../permutation-server/web/sdk/frontier/prize.mjs';
import * as wallet from '../../permutation-server/web/wallet.mjs';
import * as fsession from '../../permutation-server/web/frontier/fsession.mjs';
import * as fprize from '../../permutation-server/web/frontier/fprize.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { mountAgentPage } from '../../permutation-server/web/frontier/fagent.mjs';

const base = process.env.AGENT_PAGE_URL ?? 'http://127.0.0.1:41940';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'local-only');
setRelay(`${base}/gw`);
setLang('ja');
// A browser's localStorage and window, enough for the wallet module (the dev wallet keeps its key there).
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.window = globalThis;
globalThis.location = { origin: base, host: new URL(base).host };
globalThis.addEventListener ??= () => {};
globalThis.dispatchEvent ??= () => {};
globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

/** The fake root: markup in, clicks and submits out. */
const listeners = {};
const root = {
  innerHTML: '', __html: undefined,
  addEventListener(type, fn) { listeners[type] = fn; },
  text() { return plain(this.innerHTML); },
  async click(act, data = {}) {
    assert.ok(this.innerHTML.includes(`data-act="${act}"`), `no button ${act} on the page: ${this.text().slice(0, 300)}`);
    await listeners.click({ target: { closest: () => ({ dataset: { act, ...data } }) } });
  },
  async submit(form, values) {
    assert.ok(this.innerHTML.includes(`data-form="${form}"`), `no form ${form} on the page`);
    const elements = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'boolean' ? { checked: v } : { value: String(v) }]));
    await listeners.submit({ target: { closest: () => ({ dataset: { form } }) }, preventDefault() {} });
    void elements;
  },
};
// The page's forms read `f.elements`; our submit passes them through the dataset-only path, so wire the real elements here.
const originalSubmit = root.submit;
root.submit = async function (form, values) {
  const elements = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'boolean' ? { checked: v } : { value: String(v) }]));
  await listeners.submit({ target: { closest: () => ({ dataset: { form }, elements }) }, preventDefault() {} });
};
void originalSubmit;

const herald = createHerald({ base });
const S = await mountAgentPage({ root, wallet, fsession, herald, prize: { ...fprize, ata } });
assert.ok(S.terms, 'the relay has the agent wallet on');
console.log('page: terms read');

// The owner joins the game by hand first (the play page would do this): faucet, x402 join, a home.
await root.click('connect');
assert.ok(S.wallet, root.text());
console.log('page: wallet connected', S.wallet.address);
const faucet = await fprize.faucet(S.wallet.address);
assert.ok(faucet.ok, JSON.stringify(faucet));
const s = await herald.season();
let home = null;
for (const at of ringProvinces(3)) { const r = await herald.province(at.p, at.q); if (r.ok) { const sites = homeSites(r.province, { ringsOpen: s.record.rings.length }); if (sites.length) { home = sites[0]; break; } } }
assert.ok(home, 'a free home');
const session = await fsession.derive({ wallet: S.wallet, cluster: S.pin.cluster, programId: S.pin.programId, seasonId: S.pin.seasonId });
fsession.remember(session);
S.session = session;
const joined = await joinViaX402(`${base}/gw`, { wallet: S.wallet.address, sign: async m => (await S.wallet.signMessage(m)).signature, faction: home.faction, session: session.publicKeyBytes, sessionExpiry: BigInt(s.record.latestUnix) + 7n * 86400n, maxFee: 25_000_000n });
assert.ok(joined.signature, JSON.stringify(joined));
const ctx = { addresses: S.pin.addresses, wallet: S.wallet.address, actor: session.publicKey, faction: home.faction, holding: home, province: home };
const placed = await submit({ name: 'PlaceHome', accounts: accountsFor('PlaceHome', ctx), fields: { p: home.p, q: home.q, site: home.site }, signer: { session } });
assert.ok(placed.ok, JSON.stringify(placed));
assert.ok((await track(placed.signature, { tries: 80, every: 500 })).ok);
let me;
for (let i = 0; i < 120; i++) { me = await herald.me(S.wallet.address); if (me.ok && me.holdings[0]?.state === 2) break; await sleep(500); }
const village = [me.holdings[0].p, me.holdings[0].q, me.holdings[0].site];
console.log('page: owner joined and placed', village);

// Create through the page's form.
await root.submit('create', { village: village.join(','), total: '1', perDay: '0.5' });
assert.ok(S.view?.agentId, root.text());
assert.ok(S.capability?.token, 'the token is shown once');
assert.ok(root.text().includes('この一度だけ表示'), root.text().slice(0, 300));
console.log('page: agent created', S.view.agentId);
// Deposit through the page (sponsored: the wallet signs, the relay pays).
await root.submit('deposit', { amount: '2' });
assert.ok(root.text().includes('預け入れました（2）'), root.text().slice(0, 400));
assert.equal(S.view.balance.available, '2000000');
console.log('page: deposited 2');
// The two states: stopped and not delegated → hand the key over (confirmed on chain) → auto.
assert.ok(root.text().includes('止まっていて、鍵はあなたのものです'), root.text().slice(0, 500));
await root.click('delegate');
assert.equal(S.view.delegation.delegated, true, root.text().slice(0, 500));
assert.ok(root.text().includes('鍵を代理人に渡しました（確定'), root.text().slice(0, 500));
await root.click('mode', { mode: 'auto' });
assert.equal(S.view.mode, 'auto');
assert.ok(root.text().includes('自動で動いています'), root.text().slice(0, 500));
console.log('page: delegated and set to auto');
// The runner acts; the balance goes down by the inference price; the history shows categories.
let acted = null;
for (let i = 0; i < 120; i++) { await sleep(5000); const v = await (await fetch(`${base}/gw/f/agent?id=${S.view.agentId}`)).json(); if (v.history?.some(h => h.type === 'action' && h.source === 'ai' && h.status === 'sent')) { acted = v; break; } }
assert.ok(acted, 'the runner acted');
S.view = acted; await sleep(6000); // the page's own refresh (every 5 s) redraws
const text = root.text();
assert.ok(text.includes('判断') && text.includes('手数料は運営が負担'), text.slice(0, 800));
console.log('page: runner acted; spent', JSON.stringify(acted.balance.spent));
// Stop (server) — the chain's key stays the agent's, and the page says so; then take the key back, confirmed.
await root.click('mode', { mode: 'manual' });
assert.ok(root.text().includes('鍵はまだ代理人のものなので'), root.text().slice(0, 600));
await root.click('revoke');
assert.equal(S.view.delegation.delegated, false, root.text().slice(0, 600));
assert.ok(root.text().includes('鍵を取り戻しました'), root.text().slice(0, 600));
console.log('page: stopped and key taken back');
// Withdraw everything: the page says what can leave and that the agent stops.
await root.click('withdraw-all');
assert.ok(root.text().includes('引き出しを送りました'), root.text().slice(0, 600));
for (let i = 0; i < 40; i++) { await sleep(500); const v = await (await fetch(`${base}/gw/f/agent?id=${S.view.agentId}`)).json(); if (v.balance.pendingWithdraw === '0') { S.view = v; break; } }
assert.equal(S.view.balance.available, '0');
console.log('page: withdrawn', S.view.balance.withdrawn, 'spent', JSON.stringify(S.view.balance.spent));
console.log('agent-page-smoke: ok');
process.exit(0);
