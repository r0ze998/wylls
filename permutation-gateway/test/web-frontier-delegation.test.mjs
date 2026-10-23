// The play page while the village is handed to the owner's agent (web/frontier/fdelegation.mjs; PLAN-NEXT stage 2):
// the key mismatch is told apart from "this device has no game key" only when the Citizen's session key is one of
// the owner's agents' keys; the card links the agent page and takes the key back through the page's own `session`
// action; a refusal says why; taking the key back says the agent stays in auto on the server. Both languages.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import { AGENT_PAGE, delegatedTo, loadAgents, refusalNote, renderDelegated, takenBackNote } from '../../permutation-server/web/frontier/fdelegation.mjs';

afterEach(() => { setLang('ja'); setRelay(''); });

const agentKp = Keypair.generate();
const agentKey = agentKp.publicKey.toBase58();
const citizen = { session: agentKp.publicKey.toBytes() };
const agents = [{ agentId: 'a1', agentKey, mode: 'auto', village: [1, 2, 3] }, { agentId: 'a2', agentKey: Keypair.generate().publicKey.toBase58(), mode: 'manual' }];

test('delegatedTo: only a key mismatch whose session key is one of the owner\'s agents\' keys', () => {
  assert.deepEqual(delegatedTo({ sessionProblem: 'SessionMismatch', citizen, agents }), { agentId: 'a1', agentKey, mode: 'auto', village: [1, 2, 3] });
  assert.equal(delegatedTo({ sessionProblem: 'SessionMismatch', citizen, agents: [agents[1]] }), null, 'another key (not this owner\'s agent): the usual card');
  assert.equal(delegatedTo({ sessionProblem: 'SessionExpired', citizen, agents }), null, 'an expired session is not a hand-over');
  assert.equal(delegatedTo({ sessionProblem: 'NoSession', citizen, agents }), null);
  assert.equal(delegatedTo({ sessionProblem: null, citizen, agents }), null);
  assert.equal(delegatedTo({ sessionProblem: 'SessionMismatch', citizen: { session: new Uint8Array(32) }, agents }), null, 'no session registered');
  assert.equal(delegatedTo({ sessionProblem: 'SessionMismatch', citizen, agents: null }), null, 'no agent wallet on this relay');
  assert.equal(delegatedTo({ sessionProblem: 'SessionMismatch', citizen: { session: agentKey }, agents: [{ ...agents[0], mode: 'weird' }] }).mode, 'manual', 'a base58 session; an unknown mode reads as not auto');
});

test('loadAgents: the relay\'s public list; a relay without the agent wallet is "not enabled", never an error', async () => {
  setRelay('http://relay.test');
  const seen = [];
  const ok = await loadAgents('Owner1', { fetch: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ owner: 'Owner1', agents }) }; } });
  assert.deepEqual(ok, { enabled: true, agents });
  assert.match(seen[0], /\/f\/agent\/by-owner\?owner=Owner1$/);
  const off = await loadAgents('Owner1', { fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'not enabled', code: 'AgentWalletDisabled' }) }) });
  assert.deepEqual(off, { enabled: false, agents: [] });
  const down = await loadAgents('Owner1', { fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(down, { enabled: false, agents: [] });
  assert.deepEqual(await loadAgents(null), { enabled: false, agents: [] });
});

test('the card: what holds the key, the take-back through the page\'s own session action, the agent page; JA and EN', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const auto = String(renderDelegated({ mode: 'auto' }));
    const stopped = String(renderDelegated({ mode: 'manual' }));
    assert.match(auto, /data-act="session"/, `${lang}: the take-back is the existing session action (wallet-signed SetSession)`);
    assert.match(auto, new RegExp(`href="${AGENT_PAGE}"`), `${lang}: the agent page is linked`);
    if (lang === 'ja') {
      assert.match(auto, /代理人に任せています/);
      assert.match(auto, /いま代理人（自動）が行っています/);
      assert.match(auto, /サーバー上では自動のまま/);
      assert.match(stopped, /代理人は停止中/);
      assert.doesNotMatch(stopped, /サーバー上では自動のまま/);
    } else {
      assert.match(auto, /Handed to your agent/);
      assert.match(auto, /stays in auto on the server/);
      assert.match(stopped, /the agent is stopped/);
      assert.doesNotMatch(auto, /[぀-ヿ一-鿿]/, 'no Japanese left in English');
    }
  }
});

test('a refusal while delegated says why; taking the key back says what it did not do', () => {
  const d = { mode: 'auto' };
  assert.match(refusalNote(d, 'Auth'), /代理人に任せているため/);
  assert.match(refusalNote(d, 'SessionMismatch'), /代理人に任せているため/);
  assert.equal(refusalNote(d, 'QuotaExceeded'), null, 'other refusals keep their own words');
  assert.equal(refusalNote(null, 'Auth'), null, 'not delegated: unchanged');
  assert.match(takenBackNote({ mode: 'auto' }), /まだ自動です/);
  assert.equal(takenBackNote({ mode: 'manual' }), '鍵を取り戻しました。');
  setLang('en');
  assert.match(refusalNote(d, 'Auth'), /handed to your agent/);
  assert.match(takenBackNote({ mode: 'auto' }), /still in auto on the server/);
});

test('the controller: a herald record whose session is the agent\'s key shows the card; a refused Harvest says why; the key back clears it', async () => {
  const { webcrypto } = await import('node:crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const C = await import('../../permutation-server/web/frontier/controller.mjs');
  const { FS } = await import('../../permutation-server/web/frontier/fstate.mjs');
  const io = await import('../../permutation-server/web/frontier/fchainio.mjs');
  const joinScreen = await import('../../permutation-server/web/frontier/screens/join.mjs');
  const { statusOf } = await import('../../permutation-server/web/frontier/hud/status.mjs');
  const { PROGRAM, SEASON_ID } = await import('../screens/world.mjs');
  io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: SEASON_ID });
  io.setRelay('http://relay.test');
  const owner = Keypair.generate().publicKey.toBase58();
  const mine = Keypair.generate();
  const reads = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    reads.push(String(url));
    if (String(url).includes('/f/agent/by-owner')) return { ok: true, status: 200, json: async () => ({ owner, agents }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    Object.assign(FS, { wallet: { address: owner }, session: { publicKey: mine.publicKey.toBase58(), publicKeyBytes: mine.publicKey.toBytes() }, sessionProblem: null, delegation: null, agentWallet: undefined, notice: null });
    const { NO_TICKET } = await import('../../permutation-server/web/frontier/fland.mjs');
    const citizenRec = { session: agentKp.publicKey.toBytes(), sessionExpiry: 10n ** 12n, faction: 0, flags: 0, ticketEscrow: 0n, ticketBell: NO_TICKET, holding: [], ticketSites: [] };
    C.applyMeResult({ ok: true, record: {}, citizen: citizenRec, holdings: [], slots: [] });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(FS.sessionProblem, 'SessionMismatch');
    assert.equal(FS.agentWallet, true);
    assert.deepEqual([FS.delegation?.agentId, FS.delegation?.mode], ['a1', 'auto']);
    assert.ok(reads.some(u => u.endsWith(`/f/agent/by-owner?owner=${owner}`)));
    // Read again at most every AGENTS_REFRESH_MS.
    const n = reads.length;
    C.applyMeResult({ ok: true, record: {}, citizen: citizenRec, holdings: [], slots: [] });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(reads.length, n, 'throttled');
    const card = String(joinScreen.render({ ...FS, land: { stage: 'joined' } }));
    assert.match(card, /代理人に任せています/);
    assert.doesNotMatch(card, /鍵を作り直す/, 'not the "regenerate the key" card');
    // A refused send while delegated: the toast says why.
    C.useTransport({ submit: async () => ({ ok: false, code: 'Auth', error: 'the transaction would fail: Auth (4)' }) });
    FS.holdings = [{ p: 1, q: 2, site: 3, state: 2 }];
    await C.ACTIONS.harvest().catch(() => {});
    const st = statusOf(FS);
    assert.equal(st?.state, 'refused');
    assert.match(st.text, /必要な署名がありません/);
    assert.match(st.text, /代理人に任せているため/);
    // The key back (the chain names this device's key again): the usual state, no card, no note.
    C.applyMeResult({ ok: true, record: {}, citizen: { ...citizenRec, session: mine.publicKey.toBytes() }, holdings: [], slots: [] });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(FS.sessionProblem, null);
    assert.equal(FS.delegation, null);
  } finally {
    globalThis.fetch = realFetch;
    C.useTransport(null);
  }
});
