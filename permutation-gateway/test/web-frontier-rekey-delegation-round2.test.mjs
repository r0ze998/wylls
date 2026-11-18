// Q16-3 round 2 (verify-pr61): every path that can replace a delegated key, not only the play page's key card.
//   F1 the agent page's "hand the key to the agent" replaced ③'s courier key with no warning, and called it "(you)";
//      its "take the key back" sent on a view drawn earlier; re-issuing the connection token stopped its holder at once.
//   F2 the play page's action bar replaced the key in one press (a village owner never sees the drawer's key card).
//   F3 after a consented replacement the card still said "another key" until the next poll.
// No key is made here: the off-curve key is a well-known program id, on-curve keys are found among fixed byte strings.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { encode as toBase58 } from '../../permutation-server/web/sdk/base58.mjs';
import { isOnCurve } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import * as A from '../../permutation-server/web/frontier/fagent.mjs';
import * as D from '../../permutation-server/web/frontier/fdelegation.mjs';
import { PROGRAM, SEASON_ID } from '../screens/world.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const JP = /[぀-ヿ一-鿿]/;
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const COURIER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const onCurveKeys = (() => { const out = []; for (let i = 1; out.length < 3; i++) { const k = toBase58(Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j * 7) & 255)); if (isOnCurve(k)) out.push(k); } return out; })();
const [AGENT, DEVICE, OTHER] = onCurveKeys;
const short = k => `${k.slice(0, 4)}…${k.slice(-4)}`;
const view = (session, over = {}) => ({ ok: true, agentId: 'a1', agentKey: AGENT, village: [3, 0, 0], mode: 'manual', modeEpoch: 1, owner: 'OwnerWallet',
  policy: { allowed: ['Harvest'], budget: { total: '1', perDay: '1' }, version: 1 }, balance: { available: '0', reserved: '0', unresolved: '0', pendingWithdraw: '0', withdrawn: '0', deposited: '0', spent: { inference: '0', network: '0', game: '0' } },
  delegation: { citizen: true, delegated: session === AGENT, session, expiry: 2_000, now: 1_000 }, history: [], senderCapabilities: { mcp: { version: 2 } }, ...over });

afterEach(() => { setLang('ja'); setRelay(''); });

test('F1 model: a courier\'s key on the agent page is "held elsewhere", never "(you)"; the hand-over is bound to the key shown', () => {
  assert.equal(isOnCurve(COURIER), false);
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const card = String(A.renderDelegation(view(COURIER), { own: [DEVICE, 'OwnerWallet'] }));
    const words = plain(card);
    assert.doesNotMatch(words, /（あなた）|\(you\)/, `${lang}: the courier's key is not named as the owner's`);
    assert.match(card, /role="alert"/);
    assert.match(card, new RegExp(`data-act="delegate-replace" data-key="${COURIER}"`));
    assert.doesNotMatch(card, /data-act="delegate"/, 'no plain hand-over over a delegation');
    assert.ok(words.includes(short(COURIER)));
    if (lang === 'ja') {
      assert.match(words, /プログラムが持つ鍵です（配送の委任など）/);
      assert.match(words, /いま登録されている鍵は使えなくなります。その鍵に任せていた操作（配送の委任など）は止まります/);
      assert.match(words, /何もしなければ、その委任はそのまま続きます/);
    } else {
      assert.match(words, /held by a program \(a delivery delegation, for example\)/);
      assert.match(words, /makes the currently registered key unusable/);
      assert.match(words, /If you do nothing, that delegation stays/);
      assert.doesNotMatch(words, JP, words);
    }
  }
  setLang('ja');
  // another device's key: warned too, not claimed to be a program's
  const other = plain(A.renderDelegation(view(OTHER), { own: [DEVICE] }));
  assert.match(other, /別の鍵/); assert.doesNotMatch(other, /プログラムが持つ鍵/);
  // the owner's own key (this device's, or the wallet), the agent's key, no key: as before
  assert.match(plain(A.renderDelegation(view(DEVICE), { own: [DEVICE] })), /鍵はあなたのものです/);
  assert.match(String(A.renderDelegation(view(DEVICE), { own: [DEVICE] })), /data-act="delegate"/);
  assert.match(String(A.renderDelegation(view(AGENT))), /data-act="revoke"/);
  assert.equal(A.heldElsewhere(view('11111111111111111111111111111111')), null, 'no key registered');
  assert.equal(A.heldElsewhere(view(COURIER, { delegation: { citizen: true, delegated: false, session: COURIER, expiry: 5, now: 10 } })).expired, true);
  // the check the page sends by
  assert.deepEqual(A.handOverCheck(view(COURIER), { own: [DEVICE] }).code, 'SessionHeldElsewhere');
  assert.deepEqual(A.handOverCheck(view(COURIER), { own: [DEVICE], key: OTHER }).code, 'SessionHeldElsewhere', 'a consent for another key is not a consent');
  assert.equal(A.handOverCheck(view(COURIER), { own: [DEVICE], key: COURIER }).ok, true);
  assert.equal(A.handOverCheck(view(DEVICE), { own: [DEVICE] }).ok, true);
  assert.equal(A.handOverCheck(view(COURIER), { revoke: true }).ok, false, 'taking back from the agent while the courier holds the key');
  assert.equal(A.handOverCheck(view(AGENT), { revoke: true }).ok, true);
  assert.equal(A.handOverCheck({ agentKey: AGENT }).ok, false, 'an unread delegation sends nothing');
});

/** The agent page mounted on a fake root; the relay answers `chainSession()` as the Citizen's session at each read. */
async function mountPage(chainSession) {
  setRelay('http://relay.test');
  const posted = [], sent = [];
  const realFetch = globalThis.fetch, realInterval = globalThis.setInterval;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/f/agent/terms')) return { ok: true, status: 200, json: async () => ({ ok: true, mint: 'M' }) };
    if (u.includes('/f/agent?id=')) return { ok: true, status: 200, json: async () => view(chainSession()) };
    if (u.endsWith('/f/agent/command')) { const b = JSON.parse(init.body); posted.push(b.command.op); return { ok: true, status: 200, json: async () => ({ ok: true, agent: view(chainSession()), capability: { token: `tok${posted.length}`, version: posted.length } }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const listeners = {};
  const root = { innerHTML: '', addEventListener(t, fn) { listeners[t] = fn; }, text() { return plain(this.innerHTML); },
    async click(act, data = {}) { assert.ok(this.innerHTML.includes(`data-act="${act}"`), `no ${act}: ${this.text().slice(0, 400)}`); await this.act(act, data); },
    // (an action the page runs without its button on screen: reading the agent again — the page's own `open`)
    async act(act, data = {}) { await listeners.click({ target: { closest: () => ({ dataset: { act, ...data } }) } }); } };
  const wallet = { list: () => [], chainOf: c => `solana:${c}`, discover() {}, onChange() {}, signMessage: async () => ({ signature: new Uint8Array(64).fill(1) }) };
  const herald = { season: async () => ({ ok: true, record: { programId: PROGRAM, cluster: 'localnet', season: SEASON_ID, latestUnix: 1_000 } }), pin() {} };
  globalThis.setInterval = () => 0;
  let S;
  try {
    S = await A.mountAgentPage({ root, wallet, fsession: {}, herald, prize: null, chain: { setSessionOnChain: async o => { sent.push(o.sessionKey); return { ok: true, signature: 'sig12345678' }; } } });
  } finally { globalThis.setInterval = realInterval; }
  S.wallet = { address: 'OwnerWallet' };
  S.session = { publicKey: DEVICE };
  S.view = view(chainSession());
  return { S, root, sent, posted, restore: () => { globalThis.fetch = realFetch; } };
}

test('F1 page: "hand the key to the agent" over the courier\'s key sends nothing; only the consent for the key shown sends, and it is read fresh', async () => {
  let session = COURIER;
  const x = await mountPage(() => session);
  try {
    await x.root.act('open', { id: 'a1' });
    assert.match(x.root.text(), /別の鍵/);
    assert.doesNotMatch(x.root.text(), /（あなた）/);
    // the old button (a stale page, a forged dataset): refused, nothing sent, the warning shown
    await x.root.click('delegate-replace', { key: OTHER }).catch(() => {});
    assert.deepEqual(x.sent, [], 'a consent for another key sends nothing');
    assert.match(x.root.text(), /鍵は変更していません/);
    assert.equal(x.S.note?.tone, 'bad');
    // the view drawn says "yours", but the chain now names the courier: the press reads it fresh and sends nothing
    session = DEVICE; await x.root.act('open', { id: 'a1' });
    assert.match(x.root.innerHTML, /data-act="delegate"/);
    session = COURIER;
    await x.root.click('delegate');
    assert.deepEqual(x.sent, [], 'the hand-over is checked against the chain as it is now');
    assert.match(x.root.innerHTML, /data-act="delegate-replace" data-key="BPFL/);
    // the consent for the key shown: one SetSession, to the agent's key, and the page says what stopped
    await x.root.click('delegate-replace', { key: COURIER });
    assert.deepEqual(x.sent, [AGENT]);
    assert.match(x.S.note.text, /その委任を止めて、鍵を代理人に渡しました/);
    assert.ok(x.S.note.text.includes(short(COURIER)));
    // taking the key back from the agent while the chain now names someone else's key: nothing sent
    x.sent.length = 0;
    session = AGENT; await x.root.act('open', { id: 'a1' });
    assert.match(x.root.innerHTML, /data-act="revoke"/);
    session = COURIER;
    await x.root.click('revoke');
    assert.deepEqual(x.sent, []);
    assert.match(x.S.note.text, /いま代理人のものではありません/);
    session = AGENT; await x.root.act('open', { id: 'a1' });
    await x.root.click('revoke');
    assert.deepEqual(x.sent, [DEVICE], 'with the agent holding it: back to this device\'s key');
    // the plain hand-over where the key is the owner's own: as before, no warning
    x.sent.length = 0; session = DEVICE;
    await x.root.act('open', { id: 'a1' });
    await x.root.click('delegate');
    assert.deepEqual(x.sent, [AGENT]);
  } finally { x.restore(); }
});

test('F1 page (③ capability): re-issuing the connection token warns first, says per-sender tokens stay, and can be declined', async () => {
  const x = await mountPage(() => AGENT);
  try {
    x.S.capability = { token: 'tok0', version: 1 };
    await x.root.act('open', { id: 'a1' });
    x.S.capability = { token: 'tok0', version: 1 }; // (open clears it; the page shows it once after creation)
    x.posted.length = 0;
    x.S.capability = { token: 'tok0', version: 1 };
    await x.root.act('redraw');
    await x.root.click('rotate');
    assert.deepEqual(x.posted, [], 'the first press sends no command');
    assert.match(x.root.text(), /それを使って接続している外部の AI や MCP は止まります/);
    assert.match(x.root.text(), /送り手ごとのトークン（mcp）は再発行しても変わりません/);
    await x.root.click('rotate-cancel');
    assert.deepEqual(x.posted, []);
    assert.match(x.S.note.text, /再発行しませんでした/);
    await x.root.click('rotate');
    await x.root.click('rotate');
    assert.deepEqual(x.posted, ['rotate-capability']);
    assert.match(x.S.note.text, /新しいトークンを渡し直してください/);
    setLang('en');
    x.S.rotateAsk = true;
    const en = plain(A.renderCapability(null, { asking: true, view: view(AGENT) }));
    assert.match(en, /external AI or MCP connected with it stops/);
    assert.doesNotMatch(en, JP, en);
  } finally { x.restore(); }
});

test('F2: the action bar of a village owner opens the whole warning first; keep is offered; nothing replaces in one press', () => {
  const d = D.delegatedTo({ sessionProblem: 'SessionMismatch', citizen: { session: COURIER, sessionExpiry: 10n ** 12n }, agents: [], now: 1 });
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const bar = String(D.handNote(d));
    assert.match(bar, /data-act="session-review"/);
    assert.doesNotMatch(bar, /data-act="session-replace"/, `${lang}: no one-press replacement on the bar`);
    const review = String(D.handNote(d, { review: true }));
    assert.match(review, /data-act="session-keep"/);
    assert.match(review, new RegExp(`data-act="session-replace" data-key="${COURIER}"`));
    assert.ok(review.indexOf('session-keep') < review.indexOf('session-replace'), 'keep first');
    assert.match(review, /role="alert"/);
    assert.ok(plain(review).includes(short(COURIER)));
    const kept = String(D.handNote(d, { kept: true }));
    assert.doesNotMatch(kept, /session-replace/);
    for (const t of [bar, review, kept]) { const w = plain(t); if (lang === 'en') assert.doesNotMatch(w, JP, w); else assert.match(w, JP); }
  }
});

test('F2 + F3 on the play page: the bar\'s review and keep send nothing; after the consented replacement the card is gone at once', async () => {
  const wallet = await import('../../permutation-server/web/wallet.mjs');
  const { keyFromSeed } = await import('../../permutation-server/web/session.mjs');
  const C = await import('../../permutation-server/web/frontier/controller.mjs');
  const { FS } = await import('../../permutation-server/web/frontier/fstate.mjs');
  const io = await import('../../permutation-server/web/frontier/fchainio.mjs');
  const fsession = await import('../../permutation-server/web/frontier/fsession.mjs');
  const join = await import('../../permutation-server/web/frontier/screens/join.mjs');
  const { NO_TICKET } = await import('../../permutation-server/web/frontier/fland.mjs');
  const { decode } = await import('../../permutation-server/web/sdk/base58.mjs');
  const ownerKey = await keyFromSeed(new Uint8Array(32).fill(0x3c));
  await wallet.connect(wallet.devWallet(ownerKey), { chain: 'solana:localnet' });
  io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: SEASON_ID });
  io.setRelay('http://relay.test');
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  C.useTransport({ submit: async o => { sent.push(o.name); return { ok: true, signature: 'sigR2' }; }, track: async () => ({ ok: true, state: 'landed', slot: 1 }) });
  try {
    Object.assign(FS, { wallet: { address: ownerKey.publicKey }, session: null, sessionProblem: null, delegation: null, agentWallet: false, keyKept: null, keyReview: null, notice: null, resident: null, citizen: null });
    C.applyMeResult({ ok: true, record: {}, citizen: { session: decode(COURIER), sessionExpiry: 10n ** 12n, faction: 0, flags: 0, ticketEscrow: 0n, ticketBell: NO_TICKET, holding: [], ticketSites: [] }, holdings: [], slots: [] });
    await new Promise(r => setTimeout(r, 20));
    await C.ACTIONS['session-review']();
    assert.equal(FS.keyReview, COURIER);
    await C.ACTIONS['session-keep']();
    assert.equal(FS.keyReview, null); assert.equal(FS.keyKept, COURIER);
    assert.deepEqual(sent, []);
    await C.ACTIONS.session();
    assert.deepEqual(sent, [], 're-make the key: still nothing replaced');
    await C.ACTIONS['session-replace']({ key: COURIER });
    assert.deepEqual(sent, ['SetSession']);
    assert.equal(FS.sessionProblem, null);
    const card = String(join.render({ ...FS, land: { stage: 'joined' } }));
    assert.doesNotMatch(card, /別の鍵に操作を任せています/, 'F3: the old holder\'s card is gone once the replacement landed');
    assert.equal(D.registeredKey(FS.citizen), FS.session.publicKey);
  } finally {
    globalThis.fetch = realFetch; C.useTransport(null); if (FS.session) fsession.forget(FS.session); await wallet.disconnect().catch(() => {});
  }
});
