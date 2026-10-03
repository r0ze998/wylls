// PT-B: the playtest guest key (permutation-server/web/frontier/playtest/guestkey.mjs): a Wallet
// Standard wallet the game's own discovery (wallet.mjs) accepts for solana:localnet, in either
// registration order; it signs messages and transactions like the dev wallet; the stored key survives a
// "reload" (a second read) and a pasted backup restores it; nothing about it leaks into the backup text
// beyond the key itself. WebCrypto Ed25519 as in the browser (Node 20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKey, guestWallet, GUEST_NAME, readKey, register, backupText, parseBackup, addressOf, store, KEY } from '../../permutation-server/web/frontier/playtest/guestkey.mjs';
import * as W from '../../permutation-server/web/wallet.mjs';
import { verify } from '../../permutation-server/web/session.mjs';
import { compileMessage, parseTransaction, wireTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { encode as b58 } from '../../permutation-server/web/sdk/base58.mjs';

const SYSTEM = '11111111111111111111111111111111';
const PROG = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

test('a new key is kept, read back, and has the address its public half names', async () => {
  assert.equal(readKey(), null);
  const { key, persisted } = await createKey();
  assert.equal(persisted, false, 'no localStorage in Node: kept in memory, and the page is told it did not persist');
  assert.deepEqual(readKey(), key);
  assert.match(key.seed, /^[0-9a-f]{64}$/);
  assert.equal(addressOf(key), b58(Buffer.from(key.pub, 'hex')));
});

test('the game accepts it for solana:localnet and refuses it for mainnet; it connects, signs a message and a transaction', async () => {
  const key = readKey();
  const w = guestWallet(key);
  assert.equal(w.name, GUEST_NAME);
  assert.equal(W.unsupported(w, 'solana:localnet'), null);
  assert.notEqual(W.unsupported(w, 'solana:mainnet'), null, 'it does not sign for other chains');
  const { accounts } = await w.features['standard:connect'].connect();
  assert.equal(accounts[0].address, addressOf(key));
  const msg = new TextEncoder().encode('Wylls test message');
  const [{ signature, signedMessage }] = await w.features['solana:signMessage'].signMessage({ account: accounts[0], message: msg });
  assert.deepEqual([...signedMessage], [...msg]);
  assert.equal(await verify(addressOf(key), msg, signature), true);
  // A transaction naming the key as a signer is signed in its slot; a stranger's is refused.
  const tx = { feePayer: SYSTEM, recentBlockhash: SYSTEM, instructions: [{ programId: PROG, keys: [{ pubkey: addressOf(key), isSigner: true, isWritable: false }], data: new Uint8Array(1) }] };
  const message = compileMessage(tx);
  const wire = wireTransaction(message, {});
  const [{ signedTransaction }] = await w.features['solana:signTransaction'].signTransaction({ account: accounts[0], transaction: wire, chain: 'solana:localnet' });
  const parsed = parseTransaction(signedTransaction);
  const i = parsed.signers.indexOf(addressOf(key));
  assert.ok(i >= 0);
  assert.equal(await verify(addressOf(key), parsed.message, parsed.signatures[i]), true);
  const other = compileMessage({ ...tx, instructions: [{ ...tx.instructions[0], keys: [{ pubkey: SYSTEM, isSigner: true, isWritable: false }] }] });
  await assert.rejects(() => w.features['solana:signTransaction'].signTransaction({ account: accounts[0], transaction: wireTransaction(other, {}), chain: 'solana:localnet' }), /not a signer/);
});

test('discovery works in both orders of the Wallet Standard handshake and the wallet is listed for localnet', async () => {
  const w = guestWallet(readKey());
  // (a) the wallet registers first, the app announces afterwards
  const t1 = new EventTarget();
  register(w, t1);
  W.discover(t1);
  assert.deepEqual(W.list('solana:localnet').map(e => [e.name, e.why]), [[GUEST_NAME, null]]);
});

test('discovery, other order: the app is listening before the wallet registers', async () => {
  // A fresh module instance would be needed to reset wallet.mjs; the handshake itself is what is checked: the app's
  // register-wallet listener receives a callback and registers.
  const got = [];
  const t = new EventTarget();
  t.addEventListener('wallet-standard:register-wallet', e => e.detail({ register: w => got.push(w.name) }));
  register(guestWallet(readKey()), t);
  assert.deepEqual(got, [GUEST_NAME]);
  // and the other direction: app-ready after registration
  const t2 = new EventTarget();
  const got2 = [];
  register(guestWallet(readKey()), t2);
  t2.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: w => got2.push(w.name) } }));
  assert.deepEqual(got2, [GUEST_NAME]);
});

test('a saved backup restores the same key; a bare 64-hex string works; junk does not', async () => {
  const key = readKey();
  const text = backupText(key);
  assert.ok(text.includes(key.seed) && text.includes(addressOf(key)));
  assert.equal(parseBackup(text), key.seed);
  assert.equal(parseBackup(key.seed.toUpperCase()), key.seed);
  assert.equal(parseBackup('hello'), null);
  assert.equal(parseBackup(`${key.seed}00`), null);
  store.del(KEY);
  assert.equal(readKey(), null);
  const again = await createKey(parseBackup(text));
  assert.deepEqual(again.key, key, 'the same seed gives the same public half');
});

test('PT-E: in-app browsers (LINE, Instagram, Facebook, X, Kakao, WeChat, Android WebView) are recognised; the real ones are not', async () => {
  const { inAppBrowser } = await import('../../permutation-server/web/frontier/playtest/guestkey.mjs');
  const IN = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.8.0',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 Line/14.8.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 330.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/460.0]',
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/460.0]',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Twitter for iPhone',
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 KAKAOTALK 10.4.0',
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 MicroMessenger/8.0.47',
  ];
  const OUT = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    '',
  ];
  for (const ua of IN) assert.equal(inAppBrowser(ua), true, ua);
  for (const ua of OUT) assert.equal(inAppBrowser(ua), false, ua);
});

test('PT-E: the start page keeps the invitation in the address bar until Start, survives a malformed fragment, and offers the key before Start', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../permutation-server/web/frontier/playtest/landing.mjs', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../permutation-server/web/frontier/playtest/index.html', import.meta.url), 'utf8');
  // the fragment is removed only in the Start handler (after the click), never while reading it
  const take = src.slice(src.indexOf('function takeInvite()'), src.indexOf('let invite = takeInvite()'));
  assert.ok(!/replaceState/.test(take), 'takeInvite does not touch the address bar');
  assert.match(src.slice(src.indexOf("$('go').addEventListener")), /replaceState/);
  // a malformed percent escape is an invalid invitation, not an exception at module level
  assert.match(take, /try \{ raw = decodeURIComponent\(raw\); \} catch \{ return '!'; \}/);
  assert.match(take, /store\.set\(INVITE_KEY, raw\)/, 'a valid-looking invitation is also kept in this browser');
  // order on the page: key box, then the Start box, then the explanations
  const at = id => html.indexOf(`id="${id}"`);
  assert.ok(at('key-box') > 0 && at('key-box') < at('go') && at('go') < at('about'), 'the key box comes before the Start button');
  assert.ok(src.includes('inAppBrowser()'), 'the page checks for an in-app browser first');
  assert.ok(!/10〜20分|10 to 20 minutes/.test(src), 'the wait is 11 to 21 minutes everywhere');
});
