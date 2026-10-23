// The owner's agent page (web/frontier/fagent.mjs): the models it shows
// (balance apart: available, reserved, unresolved; history by category; the
// server's mode next to the chain's delegation), the commands it signs (the
// relay's verifier accepts them), the sponsored deposit it builds (the
// relay's shape check accepts it), the policy form, and the markup's words.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ata } from '../client/src/frontier/prize.mjs';
import { parseTransaction, wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk } from '../client/src/talk-node.mjs';
import { verifyCommand } from '../src/frontier/agent/owner-auth.mjs';
import * as A from '../../permutation-server/web/frontier/fagent.mjs';
import { setPin, setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { A as ADDR, PROGRAM, relay, call, SEASON_ID } from './agent-wallet-fixtures.mjs';

afterEach(() => { setLang('ja'); setRelay(''); });
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const view = (over = {}) => ({ agentId: 'a1', agentKey: Keypair.generate().publicKey.toBase58(), village: [3, 0, 0], mode: 'auto', modeEpoch: 1,
  policy: { allowed: ['Build', 'Garrison', 'Harvest', 'Muster', 'Train'], budget: { total: '1000000', perDay: '500000' }, version: 1 },
  balance: { available: '9000000', reserved: '10000', unresolved: '10000', pendingWithdraw: '0', withdrawn: '0', deposited: '9040000', spent: { inference: '20000', network: '0', game: '0' } },
  delegation: { citizen: true, delegated: true, session: 'AgentKey1111', expiry: 1 },
  history: [{ at: 1, type: 'deposit', amount: '9040000' }, { at: 2, type: 'spend', category: 'inference', amount: '10000' }, { at: 3, type: 'network', category: 'network', amount: '0', lamports: '10000', paidBy: 'relay' },
    { at: 4, type: 'action', name: 'Harvest', status: 'sent', source: 'ai', signature: 'sig' }, { at: 5, type: 'unresolved', category: 'inference', amount: '10000', reason: 'restart' }, { at: 6, type: 'spend', category: 'inference', amount: '10000', ok: false }],
  ...over });

test('amounts: base units to test USDC and back; the balance model keeps available, reserved and unresolved apart', () => {
  assert.deepEqual(['1500000', '7', '0'].map(A.usdc), ['1.5', '0.000007', '0']);
  assert.deepEqual([A.parseUsdc('1.5'), A.parseUsdc('0.000001'), A.parseUsdc('abc'), A.parseUsdc('1.1234567')], [1_500_000n, 1n, null, null]);
  const m = A.balanceModel(view());
  assert.deepEqual([m.available, m.reserved, m.unresolved, m.withdrawable, m.heldBack], ['9', '0.01', '0.01', '9', true]);
  assert.deepEqual(m.spent, { inference: '0.02', game: '0', network: '0' });
});

test('history: newest first, by category; fees are the operator\'s record, unresolved calls say they wait', () => {
  setLang('en');
  const rows = A.historyRows(view());
  assert.deepEqual(rows.map(r => r.kind), ['spend', 'unresolved', 'action', 'network', 'spend', 'deposit']);
  assert.equal(rows[0].text, 'Decision (a failed call counts once)');
  assert.equal(rows[0].category, 'inference');
  assert.match(rows[1].text, /waiting for the operator/);
  assert.match(rows[3].text, /paid by the operator/);
  assert.equal(rows[3].amount, null, 'no USDC amount on a fee line');
  assert.equal(rows[2].source, 'ai');
  assert.equal(A.categoryName('game'), 'In-game');
});

test('the server\'s mode and the chain\'s delegation are explained together, in all four states', () => {
  setLang('en');
  const say = (mode, delegated) => A.delegationModel(view({ mode, delegation: { citizen: true, delegated, session: 'k', expiry: 1 } }));
  assert.match(say('auto', true).text, /Running on its own/);
  assert.match(say('auto', false).text, /Hand over the key first/);
  assert.match(say('manual', true).text, /Stopped \(on the server\)\. The key is still the agent/);
  assert.match(say('manual', false).text, /the key is yours/);
  assert.deepEqual([say('manual', true).canRevoke, say('manual', true).canDelegate, say('auto', false).canDelegate], [true, false, true]);
  assert.equal(A.delegationModel(view({ delegation: null })).onChain, null);
});

test('the policy form round-trips; a bad form is refused before any signature', () => {
  const f = A.policyForm(view());
  assert.deepEqual([f.groups, f.total, f.perDay], [{ economy: true, explore: false, military: false, vigil: false }, '1', '0.5']);
  const ok = A.parsePolicyForm({ groups: { economy: true, vigil: true }, total: '2', perDay: '1' });
  assert.deepEqual(ok, { ok: true, policy: { allowed: ['economy', 'vigil'], budget: { total: '2000000', perDay: '1000000' } } });
  assert.equal(A.parsePolicyForm({ groups: {}, total: '1', perDay: '1' }).ok, false);
  assert.equal(A.parsePolicyForm({ groups: { economy: true }, total: '1', perDay: '2' }).ok, false);
  assert.equal(A.parsePolicyForm({ groups: { economy: true }, total: 'x', perDay: '1' }).ok, false);
});

test('an owner command the page signs is what the relay verifies; a sponsored deposit the page builds is what the relay accepts', async () => {
  const r = relay();
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  // The wallet's signMessage: raw ed25519 over the bytes (the dev wallet does this).
  const signMessage = async bytes => ({ signature: signTalk(bytes, owner) });
  const command = A.commandFor('create', { owner: o, params: { village: [3, 0, 0], policy: { allowed: ['economy'], budget: { total: '1000000', perDay: '500000' } } } });
  assert.ok(command.expiresAt > Date.now() && command.nonce.length === 24);
  const signed = await A.signCommand(command, signMessage);
  assert.equal(A.canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  const nonces = {};
  assert.equal(verifyCommand(signed, { op: 'create', nonces }).owner, o, 'the relay\'s verifier accepts the page\'s signature');
  const res = await call(r.public, 'POST', '/f/agent/command', { body: signed, ip: '127.0.0.1' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const agentId = res.json.agent.agentId;
  // The deposit: the page's message, signed by the "wallet" (raw ed25519 here), through the relay's sponsored route.
  const terms = (await call(r.public, 'GET', '/f/agent/terms', { ip: '127.0.0.1' })).json;
  const info = (await call(r.public, 'GET', '/f/relay', { ip: '127.0.0.1' })).json;
  const message = A.depositMessage({ owner: o, terms, amount: 2_000_000n, feePayer: info.feePayer, blockhash: info.blockhash, ata });
  const wire = wireTransaction(message, { [o]: signTalk(message, owner) });
  const tx = parseTransaction(wire);
  assert.deepEqual(tx.signers, [info.feePayer, o]);
  const shape = r.custody.checkDepositShape(tx, { owner: o, pool: r.pool });
  assert.deepEqual([shape.amount, shape.createsAta], [2_000_000n, true]);
  const dep = await call(r.public, 'POST', '/f/agent/deposit', { body: { agentId, tx: Buffer.from(wire).toString('base64'), lastValidBlockHeight: info.lastValidBlockHeight }, ip: '127.0.0.1' });
  assert.equal(dep.status, 200, JSON.stringify(dep.json));
  assert.deepEqual([dep.json.credited, dep.json.amount], [true, '2000000']);
  // depositViaRelay end to end with a fetch that answers from the handler.
  setRelay('http://relay');
  setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: String(SEASON_ID), seasonAddress: ADDR.season });
  const f = async (url, init) => {
    const u = new URL(url);
    const res2 = await call(r.public, init?.method ?? 'GET', u.pathname + u.search, { body: init?.body ? JSON.parse(init.body) : undefined, ip: '127.0.0.1' });
    return { ok: res2.status < 400, status: res2.status, json: async () => res2.json, text: async () => JSON.stringify(res2.json) };
  };
  const out = await A.depositViaRelay({ owner: o, terms, amount: 500_000n, ata, signTransaction: async w => wireTransaction(parseTransaction(w).message, { [o]: signTalk(parseTransaction(w).message, owner) }), agentId, fetch: f });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.amount, '500000');
  assert.equal(r.gateway.view(agentId).balance.available, '2500000');
});

test('the markup says what each amount is, in both languages, without the internal words', () => {
  const v = view();
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const all = plain([A.renderBalance(v), A.renderMode(v), A.renderDelegation(v), A.renderMoney(v, { walletBalance: '1000000' }), A.renderPolicy(v), A.renderHistory(v), A.renderCapability({ token: 'tok', version: 1 })].join(''));
    if (lang === 'en') {
      for (const s of ['Available now', 'Reserved (in flight)', 'Waiting for the operator', 'Only "available now" can be withdrawn', 'Running on its own', 'Take the key back', 'Withdraw everything (the agent stops)', 'History (by category)', 'shown only once']) assert.ok(all.includes(s), `${lang}: ${s}`);
      assert.doesNotMatch(all, /[぀-ヿ一-鿿]/, 'no Japanese left in English');
    } else {
      for (const s of ['いま使える', '処理中の予約', '運営の確認待ち', '鍵を取り戻す', '全額引き出す（代理人は止まります）', '履歴（費目別）']) assert.ok(all.includes(s), s);
      assert.doesNotMatch(all, /鐘|精算|口座|区画|ビーコン|キーパー/, 'the play client\'s forbidden words');
    }
  }
});

test('the agent page offers a wallet choice: the test wallet first (made on first use), extensions by name, the unusable ones with the reason', async () => {
  const { walletChoices, renderWallets } = await import('../../permutation-server/web/frontier/fagent.mjs');
  const ext = [{ name: 'Phantom', dev: false, why: null }, { name: 'OldWallet', dev: false, why: 'このネットワーク（solana:localnet）に対応していません' }];
  const rows = walletChoices(ext);
  assert.deepEqual(rows.map(r => [r.key, r.dev, !!r.why]), [['dev', true, false], ['Phantom', false, false], ['OldWallet', false, true]], 'the test wallet is offered before its key exists');
  assert.deepEqual(walletChoices([{ name: 'Dev Wallet (localnet)', dev: true, why: null }, ...ext]).map(r => r.key), ['dev', 'Phantom', 'OldWallet'], 'once enabled it is not offered twice');
  assert.deepEqual(walletChoices(ext, { devOffered: false }).map(r => r.key), ['Phantom', 'OldWallet'], 'not on another cluster');
  const markup = String(renderWallets(ext));
  assert.match(markup, /data-act="connect" data-key="dev"/);
  assert.match(markup, /data-key="Phantom"/);
  assert.match(markup, /data-key="OldWallet" disabled/);
  assert.match(markup, /solana:localnet）に対応していません/);
  setLang('en');
  assert.match(String(renderWallets(ext)), /Connect Phantom/);
});
