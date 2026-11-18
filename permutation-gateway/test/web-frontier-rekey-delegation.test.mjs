// Q16-3 (owner decision t353u): the re-key screen must not silently drop a delivery delegation.
//
// ③'s courier (workstreams/03-composability/courier) is delegated by the owner's own SetSession: the Citizen's one
// session slot is pointed at the courier's session PDA. The page's "re-make the key" card derives this device's key
// and, when it is not the registered one, sends SetSession — which replaces the courier's key. On a device with no
// stored key the page did not know of the mismatch, called it "this device has no game key", and replaced the
// registered key with no warning. Here: the `session` action never replaces a key registered to someone else; the
// screen warns (both languages), keeps the delegation unless the owner says otherwise, and replaces it only through
// the separate, consented `session-replace`.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as wallet from '../../permutation-server/web/wallet.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { NO_TICKET } from '../../permutation-server/web/frontier/fland.mjs';
import { PROGRAM, SEASON_ID } from '../screens/world.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const C = await import('../../permutation-server/web/frontier/controller.mjs');
const { FS } = await import('../../permutation-server/web/frontier/fstate.mjs');
const io = await import('../../permutation-server/web/frontier/fchainio.mjs');
const fsession = await import('../../permutation-server/web/frontier/fsession.mjs');
const D = await import('../../permutation-server/web/frontier/fdelegation.mjs');
const join = await import('../../permutation-server/web/frontier/screens/join.mjs');

const CHAIN = 'solana:localnet';
const JP = /[぀-ヿ一-鿿]/;
// The courier's session PDA of this Citizen: off the curve, as every program-held key is.
const [COURIER_PDA] = PublicKey.findProgramAddressSync([Buffer.from('session'), Buffer.alloc(32, 7), Buffer.alloc(32, 9)], Keypair.generate().publicKey);
const OTHER_DEVICE = Keypair.generate().publicKey;
const short = k => `${String(k).slice(0, 4)}…${String(k).slice(-4)}`;

const citizenRec = session => ({ session: session.toBytes(), sessionExpiry: 10n ** 12n, faction: 0, flags: 0, ticketEscrow: 0n, ticketBell: NO_TICKET, holding: [], ticketSites: [] });

/** The page of a joined owner on a device with no stored game key, the Citizen's session registered to `registered`. */
async function setup(registered, { agents = null } = {}) {
  const ownerKey = await keyFromSeed(Uint8Array.from(webcrypto.getRandomValues(new Uint8Array(32))));
  await wallet.connect(wallet.devWallet(ownerKey), { chain: CHAIN });
  io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: SEASON_ID });
  io.setRelay('http://relay.test');
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => (String(url).includes('/f/agent/by-owner') && agents
    ? { ok: true, status: 200, json: async () => ({ owner: ownerKey.publicKey, agents }) }
    : { ok: false, status: 404, json: async () => ({}) });
  C.useTransport({ submit: async o => { sent.push(o); return { ok: true, signature: `sig${sent.length}` }; }, track: async () => ({ ok: true, state: 'landed', slot: 1 }) });
  Object.assign(FS, { wallet: { address: ownerKey.publicKey }, session: null, sessionProblem: null, delegation: null, agentWallet: undefined, keyKept: null, notice: null, resident: null, citizen: null });
  C.applyMeResult({ ok: true, record: {}, citizen: citizenRec(registered), holdings: [], slots: [] });
  await new Promise(r => setTimeout(r, 20));
  const screen = () => String(join.render({ ...FS, land: { stage: 'joined' } }));
  const restore = async () => { globalThis.fetch = realFetch; C.useTransport(null); if (FS.session) fsession.forget(FS.session); await wallet.disconnect().catch(() => {}); };
  return { ownerKey, sent, screen, restore };
}
const names = sent => sent.map(o => o.name);

afterEach(() => setLang('ja'));

test('reproduction: a device with no stored key, the courier delegated — "re-make the key" must not replace the courier\'s key', async () => {
  const x = await setup(COURIER_PDA);
  try {
    assert.equal(FS.session, null, 'this device holds no game key');
    // The program-held key is known for a delegation before the wallet is asked for anything.
    const first = x.screen();
    assert.match(first, /別の鍵に操作を任せています/, 'the screen names the delegation up front');
    assert.doesNotMatch(first, /data-act="session"/, 'no plain "re-make the key" button over a delegation');

    // The old button's action (also what the first village's confirm calls): the key is derived, nothing is replaced.
    const r = await C.ACTIONS.session();
    assert.deepEqual(names(x.sent), [], 'no SetSession left the page');
    assert.equal(r?.code, 'SessionHeldElsewhere');
    assert.equal(r?.sent, false);
    assert.equal(FS.sessionProblem, 'SessionMismatch');
    assert.ok(FS.session, 'the device key is derived (a wallet signature of a message, nothing on chain)');
    assert.equal(FS.notice?.ok, false);
    assert.match(FS.notice.text(), /鍵は変更していません/);

    const card = x.screen();
    assert.match(card, /別の鍵に操作を任せています/);
    assert.ok(card.includes(short(COURIER_PDA.toBase58())), 'the registered key is shown');
    assert.match(card, /プログラムが持つ鍵です（配送の委任など）/);
    assert.match(card, /現在登録されている鍵は使えなくなります/);
    assert.match(card, /配送の委任など）は止まります/);
    assert.match(card, /何もしなければ、委任はそのまま続きます/);
    assert.match(card, /data-act="session-keep"/);
    assert.match(card, new RegExp(`data-act="session-replace" data-key="${COURIER_PDA.toBase58()}"`));
    assert.doesNotMatch(card, /data-act="session"/);
    assert.doesNotMatch(card, /鍵を作り直す|この端末には.*鍵がありません/);
  } finally { await x.restore(); }
});

test('keeping the delegation is an explicit choice; replacing it needs the separate consent and says what stopped', async () => {
  const x = await setup(COURIER_PDA);
  try {
    await C.ACTIONS.session();
    // keep: nothing is sent, the card says the delegation goes on, and the choice can be reopened
    await C.ACTIONS['session-keep']();
    assert.deepEqual(names(x.sent), []);
    assert.equal(FS.keyKept, COURIER_PDA.toBase58());
    const kept = x.screen();
    assert.match(kept, /委任を続けています/);
    assert.match(kept, /この端末では見るだけです/);
    assert.doesNotMatch(kept, /data-act="session-replace"/, 'the replace button is behind the reopened warning');
    await C.ACTIONS['session-keep']();
    assert.equal(FS.keyKept, null);
    assert.match(x.screen(), /data-act="session-replace"/);

    // a consent given for another key than the one registered now is not a consent
    const stale = await C.ACTIONS['session-replace']({ key: OTHER_DEVICE.toBase58() });
    assert.equal(stale?.code, 'SessionHeldElsewhere');
    assert.deepEqual(names(x.sent), []);
    // …nor is a call with no key named (a stale control, a shortcut)
    assert.equal((await C.ACTIONS['session-replace']())?.code, 'SessionHeldElsewhere');
    assert.deepEqual(names(x.sent), []);

    // the consented replacement: one SetSession with this device's key, signed by the wallet
    await C.ACTIONS['session-replace']({ key: COURIER_PDA.toBase58() });
    assert.deepEqual(names(x.sent), ['SetSession']);
    assert.deepEqual([...x.sent[0].fields.session], [...FS.session.publicKeyBytes]);
    assert.ok(x.sent[0].signer?.wallet, 'the owner\'s wallet signs');
    assert.equal(FS.notice?.ok, true);
    const said = typeof FS.notice.text === 'function' ? FS.notice.text() : FS.notice.text;
    assert.match(said, /鍵を置き換えました/);
    assert.ok(said.includes(short(COURIER_PDA.toBase58())));
    assert.match(said, /委任し直してください/);
    setLang('en');
    const en = FS.notice.text();
    assert.match(en, /The key was replaced/);
    assert.doesNotMatch(en, JP);
  } finally { await x.restore(); }
});

test('the first village\'s confirm path (ACTIONS.session with a known mismatch) does not replace a delegated key either', async () => {
  const x = await setup(OTHER_DEVICE);
  try {
    // an on-curve key cannot be told from this wallet's own key before the wallet signs: the recovery card, with its promise
    const first = x.screen();
    assert.match(first, /鍵を作り直す/);
    assert.match(first, /黙って置き換えることはありません/);
    await C.ACTIONS.session();
    assert.deepEqual(names(x.sent), []);
    assert.equal(FS.sessionProblem, 'SessionMismatch');
    await C.ACTIONS.session();
    assert.deepEqual(names(x.sent), [], 'a second press, the mismatch now known: still nothing replaced');
    const card = x.screen();
    assert.match(card, /別のアプリや端末に操作を任せている可能性/);
    assert.doesNotMatch(card, /プログラムが持つ鍵です/, 'not claimed to be a program\'s key');
    assert.match(card, /data-act="session-replace"/);
  } finally { await x.restore(); }
});

test('the plain recovery still works: the registered key is this wallet\'s own, or none is registered', async () => {
  const x = await setup(OTHER_DEVICE);
  try {
    // learn this wallet's own key, then register it: "re-make the key" restores it and sends nothing
    await C.ACTIONS.session();
    const mine = FS.session;
    fsession.forget(mine);
    Object.assign(FS, { session: null, sessionProblem: null, delegation: null, notice: null });
    C.applyMeResult({ ok: true, record: {}, citizen: { ...citizenRec(OTHER_DEVICE), session: mine.publicKeyBytes }, holdings: [], slots: [] });
    await new Promise(r => setTimeout(r, 20));
    assert.match(x.screen(), /data-act="session"/);
    await C.ACTIONS.session();
    assert.deepEqual(names(x.sent), []);
    assert.equal(FS.sessionProblem, null);
    assert.equal(FS.session.publicKey, mine.publicKey);
    // an expired own key is renewed without a warning (nobody else's key is replaced)
    C.applyMeResult({ ok: true, record: {}, citizen: { ...citizenRec(OTHER_DEVICE), session: mine.publicKeyBytes, sessionExpiry: 0n }, holdings: [], slots: [] });
    await new Promise(r => setTimeout(r, 20));
    await C.ACTIONS.session();
    assert.deepEqual(names(x.sent), ['SetSession']);
    // no key registered at all: set, without a warning
    x.sent.length = 0;
    C.applyMeResult({ ok: true, record: {}, citizen: { ...citizenRec(OTHER_DEVICE), session: new Uint8Array(32) }, holdings: [], slots: [] });
    await new Promise(r => setTimeout(r, 20));
    await C.ACTIONS.session();
    assert.deepEqual(names(x.sent), ['SetSession']);
  } finally { await x.restore(); }
});

test('the owner\'s agent holding the key is known on a device with no stored key too, and is taken back only by consent', async () => {
  const agent = Keypair.generate().publicKey;
  const x = await setup(agent, { agents: [{ agentId: 'a1', agentKey: agent.toBase58(), mode: 'auto', village: [1, 2, 3] }] });
  try {
    assert.equal(FS.session, null);
    assert.deepEqual([FS.delegation?.agentId, FS.delegation?.mode], ['a1', 'auto']);
    const card = x.screen();
    assert.match(card, /代理人に任せています/);
    assert.doesNotMatch(card, /鍵を作り直す/);
    assert.match(card, new RegExp(`data-act="session-replace" data-key="${agent.toBase58()}"`));
    await C.ACTIONS.session();
    assert.deepEqual(names(x.sent), []);
    await C.ACTIONS['session-replace']({ key: agent.toBase58() });
    assert.deepEqual(names(x.sent), ['SetSession']);
    assert.match(FS.notice.text(), /代理人はサーバー上ではまだ自動です/);
  } finally { await x.restore(); }
});

test('delegatedTo / the card / the bar / the refusal for a key held elsewhere, both languages', () => {
  const citizen = citizenRec(COURIER_PDA), key = COURIER_PDA.toBase58();
  const d = D.delegatedTo({ sessionProblem: 'SessionMismatch', citizen, agents: [], now: 100 });
  assert.deepEqual(d, { agentId: null, agentKey: key, mode: 'foreign', village: null, foreign: true, program: true, expired: false });
  assert.equal(D.delegatedTo({ sessionProblem: 'SessionMismatch', citizen: citizenRec(OTHER_DEVICE), agents: [], now: 100 }).program, false);
  assert.equal(D.delegatedTo({ sessionProblem: 'SessionMismatch', citizen: { ...citizen, sessionExpiry: 50n }, agents: [], now: 100 }).expired, true);
  // no local key: only what is certain is claimed (a program's key); an on-curve key may be this wallet's own
  assert.equal(D.delegatedTo({ sessionProblem: null, hasLocalKey: false, citizen, agents: [] })?.program, true);
  assert.equal(D.delegatedTo({ sessionProblem: null, hasLocalKey: false, citizen: citizenRec(OTHER_DEVICE), agents: [] }), null);
  assert.equal(D.delegatedTo({ sessionProblem: null, citizen, agents: [] }), null, 'the key matches: nothing held elsewhere');
  assert.equal(D.delegatedTo({ sessionProblem: 'SessionMismatch', citizen: { session: new Uint8Array(32) }, agents: [] }), null);

  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const texts = [String(D.renderDelegated(d)), String(D.renderDelegated({ ...d, expired: true })), String(D.renderDelegated(d, { kept: true })),
      String(D.handNote(d)), D.refusalNote(d, 'Auth'), D.takenBackNote(d), String(D.keyHint())];
    for (const t of texts) {
      const words = t.replace(/<[^>]*>/g, ' ');
      if (lang === 'en') assert.doesNotMatch(words, JP, words); else assert.match(words, JP, words);
    }
  }
  setLang('en');
  const en = String(D.renderDelegated(d));
  assert.match(en, /Another key is acting for you/);
  assert.match(en, /held by a program \(a delivery delegation, for example\)/);
  assert.match(en, /currently registered key unusable/);
  assert.match(en, /deliveries delegated to a courier, for example\) stops/);
  assert.match(en, /If you do nothing, the delegation stays as it is/);
  assert.match(String(D.renderDelegated({ ...d, expired: true })), /has expired/);
  assert.match(D.refusalNote(d, 'Auth'), /Another key holds this resident/);
  setLang('ja');

  // the action bar of a player who already has a village
  const bar = String(D.handNote(d));
  assert.match(bar, /別の鍵に操作を任せています/);
  // (round 2, verify-pr61 F2: the bar opens the whole warning first; its replacement is in that view — round2 test)
  assert.match(bar, /data-act="session-review"/);
  assert.doesNotMatch(bar, /data-act="session-replace"/);
  assert.doesNotMatch(bar, /data-agent-link/);
});
