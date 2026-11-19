// B13 (loop-play2): the game page's way to ①'s board in a launcher world (web/frontier/hud/coopboard-local.mjs).
// THIS FILE MAKES NO KEY: the page's memory-only wallet is a stand-in whose "signature" is fixed bytes. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localBoardBase, isCoopRecordMessage, coopRecordsWallet, offerWallet, openBoardWithWallet, localCoopBoardOptions, COOP_DOMAIN_LINE, COOP_WALLET_NAME } from '../../permutation-server/web/frontier/hud/coopboard-local.mjs';

const ADDRESS = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const enc = s => new TextEncoder().encode(s);
const RECORD = enc(`${COOP_DOMAIN_LINE}{"at":1,"kind":"request","signer":"${ADDRESS}"}`);

/** The page's memory-only wallet handle, standing in (fephemeral-wallet.mjs's shape): signs = 64 fixed bytes. */
function handle() {
  const signed = [];
  const h = { address: ADDRESS, destroyed: false, publicKey: new Uint8Array(32),
    wallet: { icon: 'data:image/svg+xml;base64,AA==', features: { 'solana:signMessage': { signMessage: async ({ message }) => { signed.push(Uint8Array.from(message)); return [{ signedMessage: message, signature: new Uint8Array(64).fill(7) }]; } } } } };
  return { h, signed };
}

test("the board's base is the world's proxy port on the launcher's origin; anything else is none", () => {
  assert.equal(localBoardBase('http://localhost:41006'), '/coop-world/41006');
  assert.equal(localBoardBase('http://127.0.0.1:41253'), '/coop-world/41253');
  for (const bad of ['https://localhost:41006', 'http://example.com:41006', 'http://localhost', 'http://localhost:41006/x', 'http://u:p@localhost:41006', 'nope', null]) assert.equal(localBoardBase(bad), null, String(bad));
});

test("only ①'s record messages: the domain line, then a JSON object", () => {
  assert.equal(isCoopRecordMessage(RECORD), true);
  for (const bad of [enc('WYLLS-COOP-V1\n'), enc('WYLLS-COOP-V1\n[1]'), enc('WYLLS-COOP-V1\nnot json'), enc('WYLLS-COOP-V2\n{}'), enc('{"kind":"request"}'),
    Uint8Array.from([...enc(COOP_DOMAIN_LINE), 0xff, 0xfe]), new Uint8Array(20000), 'WYLLS-COOP-V1\n{}']) assert.equal(isCoopRecordMessage(bad), false);
});

test("the board's view of the page key: signs ①'s records only, no transaction, ends with the key", async () => {
  const { h, signed } = handle();
  const w = coopRecordsWallet(h);
  assert.equal(w.name, COOP_WALLET_NAME); assert.deepEqual(w.chains, ['solana:localnet']);
  // (what web/wallet.mjs requires of a wallet to list it: connect, legacy signTransaction, signMessage, the chain)
  assert.equal(typeof w.features['standard:connect'].connect, 'function');
  assert.deepEqual(w.features['solana:signTransaction'].supportedTransactionVersions, ['legacy']);
  const { accounts: [acc] } = await w.features['standard:connect'].connect();
  assert.equal(acc.address, ADDRESS); assert.deepEqual(acc.features, ['solana:signTransaction', 'solana:signMessage']);
  const [out] = await w.features['solana:signMessage'].signMessage({ account: acc, message: RECORD });
  assert.deepEqual([...out.signedMessage], [...RECORD]); assert.equal(out.signature.length, 64);
  assert.equal(signed.length, 1);
  await assert.rejects(w.features['solana:signMessage'].signMessage({ account: acc, message: enc('Sign in to something') }), e => e.code === 'CoopWalletNotARecord');
  await assert.rejects(w.features['solana:signMessage'].signMessage({ account: { address: 'x' }, message: RECORD }), e => e.code === 'CoopWalletAccount');
  await assert.rejects(w.features['solana:signTransaction'].signTransaction({ account: acc, transaction: new Uint8Array(10) }), e => e.code === 'CoopWalletNoTransactions');
  assert.equal(signed.length, 1, 'nothing else reached the key');
  h.destroyed = true;
  assert.deepEqual(w.accounts, []);
  await assert.rejects(w.features['solana:signMessage'].signMessage({ message: RECORD }), e => e.code === 'CoopWalletEnded');
  assert.throws(() => coopRecordsWallet(null), e => e.code === 'CoopWalletNoKey');
});

/** A window standing in for ①'s page: wallet.mjs's own discovery (register-wallet listener, app-ready). */
function boardWindow() {
  const t = new EventTarget();
  const wallets = new Set();
  const api = { register: w => { wallets.add(w); return () => wallets.delete(w); } };
  t.addEventListener('wallet-standard:register-wallet', e => e.detail(api));
  t.CustomEvent = CustomEvent;
  return { t, wallets, ready: () => t.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })) };
}

test('the offer goes through the Wallet Standard events; withdrawn, it is gone', () => {
  const { h } = handle();
  const w = coopRecordsWallet(h);
  const b = boardWindow();
  const withdraw = offerWallet(w, b.t);
  assert.deepEqual([...b.wallets], [w]);
  withdraw();
  assert.equal(b.wallets.size, 0);
  b.ready(); assert.equal(b.wallets.size, 0, 'no answer to a later app-ready once withdrawn');
});

test("①'s page is opened in a window of this origin and offered the wallet when it has loaded, again after a reload", () => {
  const { h } = handle();
  const ticks = [];
  const timers = { setInterval: f => { ticks.push(f); return 1; }, clearInterval: () => { ticks.length = 0; } };
  let b = boardWindow();
  const win = { closed: false, document: { readyState: 'loading' }, location: { pathname: 'blank' }, addEventListener: (...a) => b.t.addEventListener(...a), removeEventListener: (...a) => b.t.removeEventListener(...a), dispatchEvent: e => b.t.dispatchEvent(e), CustomEvent };
  const opened = [];
  const page = '/coop-world/41006/ws01/repo/workstreams/01-national-strategy/coop/';
  assert.equal(openBoardWithWallet(`${page}?to=1,2,3,0`, h, { open: (...a) => { opened.push(a); return win; }, timers, pagePath: page }), win);
  assert.deepEqual(opened, [[`${page}?to=1,2,3,0`, '_blank']], 'not noopener: this page offers the wallet to that window');
  ticks[0](); assert.equal(b.wallets.size, 0, 'not offered before the page is there');
  win.document = { readyState: 'complete' }; win.location.pathname = page;
  ticks[0](); assert.equal(b.wallets.size, 1); assert.equal([...b.wallets][0].name, COOP_WALLET_NAME);
  ticks[0](); assert.equal(b.wallets.size, 1, 'once per document');
  // a reload: a new document, a new discovery
  b = boardWindow(); win.document = { readyState: 'complete' };
  ticks[0](); assert.equal(b.wallets.size, 1);
  win.closed = true; ticks[0](); assert.equal(ticks.length, 0, 'stops with the window');
  assert.equal(openBoardWithWallet(page, h, { open: () => null, timers }), null);
});

test('only a launcher world with a live key gets the options; otherwise the board is looked for as before', () => {
  const { h } = handle();
  const o = localCoopBoardOptions({ herald: 'http://localhost:41006', handle: h, launcher: true });
  assert.equal(o.base, '/coop-world/41006'); assert.equal(typeof o.open, 'function');
  assert.equal(localCoopBoardOptions({ herald: 'http://localhost:41006', handle: h, launcher: false }), null);
  assert.equal(localCoopBoardOptions({ herald: 'http://localhost:41006', handle: null, launcher: true }), null);
  assert.equal(localCoopBoardOptions({ herald: 'http://example.com:41006', handle: h, launcher: true }), null);
});
