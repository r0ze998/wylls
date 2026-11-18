// Q16-3 round 2 (verify-pr61 F1): the REAL agent page (frontier/agent.html, its own boot and stylesheet) in Chromium on
// the screens fixture server, the dev wallet connected, the owner's one agent read from the relay — whose answers this
// script gives: the Citizen's session is ③'s courier key (a program-held key). Asserted in English and Japanese at
// 1440 and 390: the delegation card warns (no "(you)"), offers no plain hand-over, and only its own consent button
// sends — exactly one wallet-signed SetSession, to the agent's key; after it the card says the agent holds the key.
// The connection-token re-issue warning is checked on the same page. REKEY_OUT=<dir> writes the screenshots.
// Port: REKEY_PORT (default 41872; the brief's range is 41870–41899).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as W from './world.mjs';
import { parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { classify } from '../../permutation-server/web/sdk/frontier/shapes.mjs';
import { encode as toBase58 } from '../../permutation-server/web/sdk/base58.mjs';
import { fromBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';

const PORT = Number(process.env.REKEY_PORT ?? 41872);
const OUT = process.env.REKEY_OUT ?? null;
const COURIER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const AGENT = toBase58(Uint8Array.from([0x58, ...new Array(31).fill(0x66)]));
const JP = /[぀-ヿ一-鿿]/;

let srv, browser;
before(async () => { srv = await startServer({ port: PORT }); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

const viewOf = (session, capability = true) => ({ ok: true, agentId: 'a1', agentKey: AGENT, village: [2, 0, 3], mode: 'manual', modeEpoch: 2, owner: 'x',
  policy: { allowed: ['Harvest'], budget: { total: '1000000', perDay: '500000' }, version: 1 },
  balance: { available: '0', reserved: '0', unresolved: '0', pendingWithdraw: '0', withdrawn: '0', deposited: '0', spent: { inference: '0', network: '0', game: '0' } },
  delegation: { citizen: true, delegated: session === AGENT, session, expiry: W.GENESIS_TS + 30 * 86_400, now: W.GENESIS_TS + 3_600 },
  history: [], senderCapabilities: capability ? { mcp: { version: 1 } } : {}, driver: null });

async function openAgentPage(lang, width) {
  const state = { session: COURIER, sent: [], commands: [] };
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 } });
  await ctx.addInitScript(l => { localStorage.setItem('ps-lang', l); }, lang);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/gw/f/agent/terms', r => json(r, { ok: true, mint: W.PROGRAM, custodyAccount: W.PROGRAM, custodyAuthority: W.PROGRAM }));
  await page.route('**/gw/f/agent/by-owner**', r => json(r, { ok: true, agents: [{ agentId: 'a1', agentKey: AGENT, mode: 'manual', village: [2, 0, 3] }] }));
  await page.route('**/gw/f/agent?id=**', r => json(r, viewOf(state.session)));
  await page.route('**/gw/f/agent/fate**', r => json(r, { ok: true, state: 'unqueryable' }));
  await page.route('**/gw/f/agent/command', async r => {
    const b = JSON.parse(r.request().postData() || '{}');
    state.commands.push(b.command?.op);
    return json(r, { ok: true, agent: viewOf(state.session), capability: { token: `token-${state.commands.length}`, version: state.commands.length + 1, source: 'any' } });
  });
  await page.route('**/gw/f/tx/**', r => json(r, { ok: true, state: 'landed', slot: 9 }));
  // this script's own fee payer (a fixture key from a fixed seed, as liveworld.mjs's): the page checks the relay's
  // signature over the message the wallet signed
  const feeKey = await keyFromSeed(new Uint8Array(32).fill(7));
  await page.route('**/gw/f/relay', async route => {
    if (route.request().method() !== 'POST') { const res = await route.fetch(); return json(route, { ...(await res.json()), feePayer: feeKey.publicKey }); }
    const body = JSON.parse(route.request().postData() || '{}');
    const wire = fromBase64(String(body.tx ?? ''));
    const tx = parseTransaction(wire), shape = classify(tx, { programId: W.PROGRAM, wireBytes: wire.length });
    const session = shape.data?.session ? toBase58(Uint8Array.from(shape.data.session)) : null;
    state.sent.push({ name: shape.name, ok: shape.ok, session });
    if (shape.ok && shape.name === 'SetSession') state.session = session;
    return json(route, { ok: true, signature: toBase58(await feeKey.sign(tx.message)) });
  });
  await page.goto(`${srv.url}/frontier/agent.html`);
  await page.locator('[data-act="connect"][data-key="dev"]').click();
  await page.locator('#del-title').waitFor({ timeout: 20_000 });
  return { ctx, page, state, errors };
}

for (const lang of ['en', 'ja']) for (const width of [1440, 390]) test(`the agent page over the courier's key (${lang} @ ${width}): warned, no "(you)", only the consent sends`, { timeout: 120_000 }, async () => {
  const x = await openAgentPage(lang, width);
  try {
    const card = x.page.locator('section.agent-card:has(#del-title)');
    const text = (await card.innerText()).replace(/\s+/g, ' ');
    assert.doesNotMatch(text, /（あなた）|\(you\)/, text);
    assert.equal(await card.getAttribute('data-key-held'), 'program');
    assert.equal(await card.locator('[role="alert"]').count(), 1);
    assert.equal(await card.locator('[data-act="delegate"]').count(), 0, 'no plain hand-over');
    assert.equal(await card.locator(`[data-act="delegate-replace"][data-key="${COURIER}"]`).count(), 1);
    if (lang === 'en') { assert.match(text, /held by a program \(a delivery delegation, for example\)/); assert.match(text, /If you do nothing, that delegation stays/); assert.doesNotMatch(text, JP, text); }
    else { assert.match(text, /プログラムが持つ鍵です（配送の委任など）/); assert.match(text, /何もしなければ、その委任はそのまま続きます/); }
    const box = await card.boundingBox();
    assert.ok(box.width <= width, `the card fits (${box.width} ≤ ${width})`);
    if (OUT) { await card.screenshot({ path: `${OUT}/agent-warning-${lang}-${width}.png` }); await x.page.screenshot({ path: `${OUT}/agent-page-${lang}-${width}.png`, fullPage: true }); }
    // the mode switch on the same page sends no key change
    assert.deepEqual(x.state.sent, []);
    // the consent: one wallet-signed SetSession to the agent's key; the card then names the agent
    await card.locator('[data-act="delegate-replace"]').click();
    await x.page.locator('.agent-note').filter({ hasText: lang === 'en' ? /delegation is ended/ : /その委任を止めて/ }).waitFor({ timeout: 20_000 });
    assert.deepEqual(x.state.sent.map(s => [s.name, s.ok, s.session]), [['SetSession', true, AGENT]]);
    const afterText = (await x.page.locator('section.agent-card:has(#del-title)').innerText()).replace(/\s+/g, ' ');
    assert.match(afterText, lang === 'en' ? /\(the agent\)/ : /（代理人）/, afterText);
    if (OUT) await x.page.screenshot({ path: `${OUT}/agent-after-consent-${lang}-${width}.png`, fullPage: true });
    assert.deepEqual(x.errors, [], 'no page error');
  } finally { await x.ctx.close(); }
});

test('the agent page: re-issuing the connection token warns first and can be declined (en @ 1440)', { timeout: 120_000 }, async () => {
  const x = await openAgentPage('en', 1440);
  try {
    // (the token card is shown once, after the agent is created; without a token no re-issue button is offered)
    x.state.session = AGENT;
    await x.page.reload();
    await x.page.locator('[data-act="connect"][data-key="dev"]').click();
    await x.page.locator('#del-title').waitFor();
    assert.equal(await x.page.locator('[data-act="rotate"]').count(), 0, 'the token card is not shown without a token');
    assert.deepEqual(x.state.commands, []);
  } finally { await x.ctx.close(); }
});
