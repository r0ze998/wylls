// The memory-only local-play test wallet (web/frontier/fephemeral-wallet.mjs).
// THIS FILE MAKES AND USES KEYS: fresh, non-extractable Ed25519 test keys inside this process's WebCrypto, to check
// real signatures. It is therefore run WITHOUT the no-key guard (screens/codex/no-key-node.mjs), and only this file:
//   node --test ./permutation-gateway/test/web-frontier-ephemeral-wallet.test.mjs
// No key is read from anywhere, none is written anywhere, none is printed. No network, chain or wallet extension.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as EW from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { compileMessage, wireTransaction, parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { decode as fromB58, encode as toB58 } from '../../permutation-server/web/sdk/base58.mjs';

const LOCAL = { cluster: 'localnet', hostname: '127.0.0.1', localPlay: true };
const codeOf = p => Promise.resolve(p).then(() => null, e => e.code ?? String(e));
/** Ed25519 verification with nothing but the public address. */
const verify = async (address, message, signature) => crypto.subtle.verify('Ed25519',
  await crypto.subtle.importKey('raw', fromB58(address), 'Ed25519', false, ['verify']), Uint8Array.from(signature), Uint8Array.from(message));
beforeEach(() => { EW.destroyEphemeralWallet(); });

test('it is made only for explicitly chosen local play: localnet, a loopback page, localPlay === true', async () => {
  assert.deepEqual(EW.ephemeralWalletAllowed(LOCAL), { ok: true });
  for (const hostname of ['localhost', 'LOCALHOST', 'play.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) assert.equal(EW.ephemeralWalletAllowed({ ...LOCAL, hostname }).ok, true, hostname);
  const refused = [
    [{ ...LOCAL, localPlay: undefined }, 'EphemeralWalletNotChosen'], [{ ...LOCAL, localPlay: false }, 'EphemeralWalletNotChosen'], [{ ...LOCAL, localPlay: 'true' }, 'EphemeralWalletNotChosen'], [{ ...LOCAL, localPlay: 1 }, 'EphemeralWalletNotChosen'],
    [{ ...LOCAL, cluster: 'devnet' }, 'EphemeralWalletCluster'], [{ ...LOCAL, cluster: 'mainnet-beta' }, 'EphemeralWalletCluster'], [{ ...LOCAL, cluster: 'testnet' }, 'EphemeralWalletCluster'], [{ ...LOCAL, cluster: undefined }, 'EphemeralWalletCluster'], [{ ...LOCAL, cluster: 'Localnet' }, 'EphemeralWalletCluster'],
    ...['wylls.test', 'example.com', '192.168.1.5', '10.0.0.1', '0.0.0.0', '128.0.0.1', '127.0.0.1.example.com', 'localhost.example.com', 'notlocalhost', '127.0.0.256', '', undefined, null, 127].map(hostname => [{ ...LOCAL, hostname }, 'EphemeralWalletHost']),
    [{}, 'EphemeralWalletNotChosen'], [undefined, 'EphemeralWalletNotChosen'],
  ];
  for (const [options, code] of refused) {
    assert.deepEqual(EW.ephemeralWalletAllowed(options), { ok: false, code }, JSON.stringify(options));
    // (no key is asked of WebCrypto for a refused request)
    assert.equal(await codeOf(EW.createEphemeralWallet({ ...(options ?? {}), hostname: options?.hostname ?? 'example.com', subtle: { generateKey() { assert.fail('a refused request makes no key'); } } })), code === 'EphemeralWalletHost' || options?.hostname === undefined ? (EW.ephemeralWalletAllowed({ ...(options ?? {}), hostname: options?.hostname ?? 'example.com' }).code) : code);
  }
  assert.equal(EW.currentEphemeralWallet(), null);
});

test('a fresh non-extractable key: real Ed25519 signatures that verify with the public address alone', async () => {
  const asked = [];
  const subtle = { generateKey: (...a) => { asked.push(a); return crypto.subtle.generateKey(...a); }, exportKey: (...a) => crypto.subtle.exportKey(...a), sign: (...a) => crypto.subtle.sign(...a) };
  const w = await EW.createEphemeralWallet({ ...LOCAL, subtle });
  assert.deepEqual(asked, [['Ed25519', false, ['sign', 'verify']]], 'one key, asked as NOT extractable');
  assert.equal(fromB58(w.address).length, 32); assert.equal(toB58(w.publicKey), w.address);
  assert.equal(w.wallet.name, EW.EPHEMERAL_WALLET_NAME); assert.deepEqual([...w.wallet.chains], ['solana:localnet']);
  const account = w.wallet.accounts[0];
  assert.equal(account.address, w.address); assert.deepEqual([...account.features], ['solana:signTransaction', 'solana:signMessage']);
  assert.deepEqual((await w.wallet.features['standard:connect'].connect()).accounts, [account]);
  // a message
  const message = new TextEncoder().encode('wylls local play: a message to sign');
  const [signed] = await w.wallet.features['solana:signMessage'].signMessage({ account, message });
  assert.equal(signed.signature.length, 64); assert.deepEqual([...signed.signedMessage], [...message]);
  assert.equal(await verify(w.address, message, signed.signature), true, 'a real signature of this message');
  assert.equal(await verify(w.address, new TextEncoder().encode('another message'), signed.signature), false);
  const flipped = Uint8Array.from(signed.signature); flipped[0] ^= 1; assert.equal(await verify(w.address, message, flipped), false);
  // a transaction: this wallet pays, another key co-signs; only this wallet's slot is filled
  const other = toB58(new Uint8Array(32).fill(7)), program = toB58(new Uint8Array(32).fill(9));
  const compiled = compileMessage({ feePayer: w.address, recentBlockhash: toB58(new Uint8Array(32).fill(3)), instructions: [
    { programId: program, keys: [{ pubkey: w.address, isSigner: true, isWritable: true }, { pubkey: other, isSigner: true, isWritable: false }], data: Uint8Array.of(1, 2, 3) }] });
  const [{ signedTransaction }] = await w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(compiled), chain: 'solana:localnet' });
  const tx = parseTransaction(signedTransaction);
  assert.deepEqual(tx.signers, [w.address, other]); assert.deepEqual([...tx.message], [...compiled], 'the message is not altered');
  assert.equal(await verify(w.address, tx.message, tx.signatures[0]), true, 'a real signature over the transaction message');
  assert.ok(tx.signatures[1].every(b => b === 0), 'the other signer\'s slot is left empty');
  // what it refuses to sign
  const foreign = compileMessage({ feePayer: other, recentBlockhash: toB58(new Uint8Array(32).fill(3)), instructions: [{ programId: program, keys: [], data: Uint8Array.of(1) }] });
  assert.equal(await codeOf(w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(foreign) })), 'EphemeralWalletNotSigner');
  assert.equal(await codeOf(w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(compiled), chain: 'solana:mainnet' })), 'EphemeralWalletCluster');
  assert.equal(await codeOf(w.wallet.features['solana:signMessage'].signMessage({ account: { address: other }, message })), 'EphemeralWalletAccount');
  assert.equal(await codeOf(w.wallet.features['solana:signMessage'].signMessage({ account, message, chain: 'solana:devnet' })), 'EphemeralWalletCluster');
});

test('one wallet per page: repeated and concurrent calls return it; destroy ends it; the next one is a new key', async () => {
  let made = 0;
  const subtle = { generateKey: (...a) => { made++; return crypto.subtle.generateKey(...a); }, exportKey: (...a) => crypto.subtle.exportKey(...a), sign: (...a) => crypto.subtle.sign(...a) };
  const [a, b, c] = await Promise.all([EW.createEphemeralWallet({ ...LOCAL, subtle }), EW.createEphemeralWallet({ ...LOCAL, subtle }), EW.createEphemeralWallet({ ...LOCAL, subtle })]);
  assert.equal(a, b); assert.equal(b, c); assert.equal(made, 1, 'three concurrent calls made one key');
  assert.equal(await EW.createEphemeralWallet({ ...LOCAL, subtle }), a); assert.equal(made, 1); assert.equal(EW.currentEphemeralWallet(), a);
  // disconnect (Wallet Standard) keeps the key: the same address signs again
  const account = a.wallet.accounts[0], message = Uint8Array.of(1, 2, 3);
  await a.wallet.features['standard:disconnect'].disconnect();
  assert.equal(a.destroyed, false); assert.deepEqual((await a.wallet.features['standard:connect'].connect()).accounts, [account]);
  assert.equal(await verify(a.address, message, (await a.wallet.features['solana:signMessage'].signMessage({ account, message }))[0].signature), true);
  // a request that is refused while a wallet lives does not hand it out
  assert.equal(await codeOf(EW.createEphemeralWallet({ ...LOCAL, cluster: 'devnet', subtle })), 'EphemeralWalletCluster');
  // destroy
  assert.equal(EW.destroyEphemeralWallet(), true); assert.equal(a.destroyed, true); assert.equal(EW.currentEphemeralWallet(), null); assert.equal(EW.destroyEphemeralWallet(), false);
  assert.equal(await codeOf(a.wallet.features['solana:signMessage'].signMessage({ account, message })), 'EphemeralWalletDestroyed');
  assert.equal(await codeOf(a.wallet.features['standard:connect'].connect()), 'EphemeralWalletDestroyed');
  assert.throws(() => a.announce(new EventTarget()), e => e.code === 'EphemeralWalletDestroyed');
  a.destroy(); assert.equal(a.destroyed, true, 'destroying twice is harmless');
  // a new one
  const d = await EW.createEphemeralWallet({ ...LOCAL, subtle });
  assert.equal(made, 2); assert.notEqual(d, a); assert.notEqual(d.address, a.address, 'a new key and a new address');
  assert.equal(a.destroyed, true, 'the old wallet stays destroyed'); assert.equal(d.destroyed, false);
  // destroyed while it is being made: nobody gets that key, and the next creation is another one
  d.destroy();
  let release; const slow = { ...subtle, generateKey: async (...x) => { made++; await new Promise(r => { release = r; }); return crypto.subtle.generateKey(...x); } };
  const pending = EW.createEphemeralWallet({ ...LOCAL, subtle: slow }), joined = EW.createEphemeralWallet({ ...LOCAL, subtle: slow });
  await new Promise(r => setImmediate(r)); EW.destroyEphemeralWallet(); release();
  assert.equal(await codeOf(pending), 'EphemeralWalletDestroyed'); assert.equal(await codeOf(joined), 'EphemeralWalletDestroyed'); assert.equal(EW.currentEphemeralWallet(), null);
  const e = await EW.createEphemeralWallet({ ...LOCAL, subtle }); assert.equal(e.destroyed, false); assert.equal(made, 4);
  // an engine without Ed25519 is a clear refusal
  e.destroy();
  assert.equal(await codeOf(EW.createEphemeralWallet({ ...LOCAL, subtle: { generateKey: async () => { throw new Error('NotSupported'); } } })), 'NoEd25519');
  assert.equal(await codeOf(EW.createEphemeralWallet({ ...LOCAL, subtle: null })), 'NoEd25519');
});

test('nothing is stored, printed or exposed: no storage access, no console output, no key in anything handed out', async () => {
  const touched = [], printed = [], saved = {};
  const trap = name => new Proxy({}, { get: (_, k) => { touched.push(`${name}.${String(k)}`); return () => null; }, set: (_, k) => { touched.push(`${name}.${String(k)}=`); return true; },
    has: (_, k) => { touched.push(`${name} has ${String(k)}`); return false; }, ownKeys: () => { touched.push(`${name} keys`); return []; } });
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore']) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { configurable: true, value: trap(name) }); }
  const con = {}; for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) { con[k] = console[k]; console[k] = (...a) => { printed.push([k, ...a]); }; }
  try {
    const w = await EW.createEphemeralWallet(LOCAL), account = w.wallet.accounts[0];
    await w.wallet.features['standard:connect'].connect();
    await w.wallet.features['solana:signMessage'].signMessage({ account, message: Uint8Array.of(1) });
    const off = w.announce(new EventTarget()); off();
    // everything reachable from the handle: no CryptoKey, no private field, only public values
    const seen = new Set(), keys = [];
    (function walk(x, path) {
      if (x === null || (typeof x !== 'object' && typeof x !== 'function') || seen.has(x)) return; seen.add(x);
      assert.ok(!(x instanceof CryptoKey), `a CryptoKey is reachable at ${path}`);
      for (const k of Reflect.ownKeys(x)) { keys.push(`${path}.${String(k)}`); let v; try { v = x[k]; } catch { continue; } if (!(v instanceof Uint8Array)) walk(v, `${path}.${String(k)}`); }
    })(w, 'wallet');
    assert.ok(!keys.some(k => /secret|private|seed|pkcs8|mnemonic/i.test(k)), keys.join(' '));
    assert.deepEqual(JSON.parse(JSON.stringify(w)), { name: EW.EPHEMERAL_WALLET_NAME, address: w.address }, 'what a runner may be handed: the name and the public address');
    assert.deepEqual(Object.keys(EW).sort(), ['EPHEMERAL_CHAIN', 'EPHEMERAL_WALLET_NAME', 'createEphemeralWallet', 'currentEphemeralWallet', 'destroyEphemeralWallet', 'ephemeralWalletAllowed', 'isLoopbackHost']);
    assert.ok(Object.isFrozen(w) && Object.isFrozen(w.wallet) && Object.isFrozen(w.wallet.features) && Object.isFrozen(account));
    w.destroy();
  } finally {
    for (const [name, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, name, d); else delete globalThis[name]; }
    Object.assign(console, con);
  }
  assert.deepEqual(touched, [], 'no storage of any kind was touched'); assert.deepEqual(printed, [], 'nothing was printed');
  // the source itself: no storage, console, URL, file or seed-derivation API, and not the stored dev wallet
  const src = readFileSync(new URL('../../permutation-server/web/frontier/fephemeral-wallet.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|location\.(href|search|hash)|history\.|URLSearchParams|fetch\(|importKey|pkcs8|keyFromSeed|seedOf|randomBytes|getRandomValues|enableDevWallet|DEV_KEY|wrapKey|exportKey\('(?!raw')/);
  assert.match(code, /generateKey\(ED25519, false, \['sign', 'verify'\]\)/);
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort(), ['../sdk/base58.mjs', '../sdk/solana-tx.mjs']);
});

/** The page's own wallet layer (web/wallet.mjs), started once on one event target for this file. */
let pageLayer = null;
async function pageWallet() {
  if (!pageLayer) { const wallet = await import('../../permutation-server/web/wallet.mjs'), page = new EventTarget(); wallet.discover(page); pageLayer = { wallet, page }; }
  return pageLayer;
}
/** Run `fn(store)` with a plain in-memory localStorage in place (web/wallet.mjs remembers the last wallet's name there). */
async function withStorage(fn) {
  const store = new Map(), saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); } } });
  try { return await fn(store); } finally { if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete globalThis.localStorage; }
}
/** A WebCrypto whose `sign` finishes its work and then waits for the test: `signing[i]()` releases the i-th signature. */
function slowSigner() {
  const signing = [];
  return { signing, subtle: { generateKey: (...a) => crypto.subtle.generateKey(...a), exportKey: (...a) => crypto.subtle.exportKey(...a),
    sign: async (...a) => { const signature = await crypto.subtle.sign(...a); await new Promise(release => signing.push(release)); return signature; } } };
}
const until = async cond => { for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setImmediate(r)); assert.ok(cond(), 'the awaited moment came'); };

test('a wallet destroyed while a signature is being made returns no signature: message, transaction and batch', async () => {
  const message = new TextEncoder().encode('sign me');
  // one message
  { const s = slowSigner(), w = await EW.createEphemeralWallet({ ...LOCAL, subtle: s.subtle }), account = w.wallet.accounts[0];
    const pending = w.wallet.features['solana:signMessage'].signMessage({ account, message });
    await until(() => s.signing.length === 1); w.destroy(); s.signing[0]();
    assert.equal(await codeOf(pending), 'EphemeralWalletDestroyed', 'the engine did sign; the destroyed wallet does not hand it out'); }
  // one transaction
  { const s = slowSigner(), w = await EW.createEphemeralWallet({ ...LOCAL, subtle: s.subtle }), account = w.wallet.accounts[0];
    const compiled = compileMessage({ feePayer: w.address, recentBlockhash: toB58(new Uint8Array(32).fill(3)), instructions: [{ programId: toB58(new Uint8Array(32).fill(9)), keys: [], data: Uint8Array.of(1) }] });
    const pending = w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(compiled) });
    await until(() => s.signing.length === 1); EW.destroyEphemeralWallet(); s.signing[0]();
    assert.equal(await codeOf(pending), 'EphemeralWalletDestroyed'); }
  // a batch: destroyed after the first signature, before the second: nothing of the batch is returned
  { const s = slowSigner(), w = await EW.createEphemeralWallet({ ...LOCAL, subtle: s.subtle }), account = w.wallet.accounts[0];
    const pending = w.wallet.features['solana:signMessage'].signMessage({ account, message }, { account, message: Uint8Array.of(2) });
    await until(() => s.signing.length === 1); s.signing[0](); await until(() => s.signing.length === 2);
    w.destroy(); s.signing[1]();
    assert.equal(await codeOf(pending), 'EphemeralWalletDestroyed', 'not even the first, finished signature'); }
  // a batch: destroyed after the LAST signature was made, before the batch was returned
  { const s = slowSigner(), w = await EW.createEphemeralWallet({ ...LOCAL, subtle: s.subtle }), account = w.wallet.accounts[0];
    const pending = w.wallet.features['solana:signMessage'].signMessage({ account, message });
    await until(() => s.signing.length === 1);
    // (released and destroyed in the same turn: the signature resolves, then the batch's own last check runs)
    s.signing[0](); w.destroy();
    assert.equal(await codeOf(pending), 'EphemeralWalletDestroyed'); }
  // the bytes signed are the bytes returned, whatever the caller does to its own array while the engine works
  { const s = slowSigner(), w = await EW.createEphemeralWallet({ ...LOCAL, subtle: s.subtle }), account = w.wallet.accounts[0];
    const mine = Uint8Array.from(message), pending = w.wallet.features['solana:signMessage'].signMessage({ account, message: mine });
    mine.fill(0); await until(() => s.signing.length === 1); mine.fill(255); s.signing[0]();
    const [out] = await pending;
    assert.deepEqual([...out.signedMessage], [...message], 'the snapshot taken when it was asked');
    assert.equal(await verify(w.address, out.signedMessage, out.signature), true, 'and the signature is of exactly those bytes');
    assert.equal(await verify(w.address, mine, out.signature), false); w.destroy(); }
});

test('an offer made to a page that destroys or withdraws the wallet while registering leaves nothing registered', async () => {
  // the page's register() destroys the wallet before it returns its unregister function
  { const w = await EW.createEphemeralWallet(LOCAL), registered = new Set(), page = new EventTarget();
    page.addEventListener('wallet-standard:register-wallet', e => e.detail({ register: x => { registered.add(x); w.destroy(); return () => registered.delete(x); } }));
    w.announce(page);
    assert.equal(w.destroyed, true); assert.equal(registered.size, 0, 'the dead wallet was taken back out at once'); }
  // the page's register() withdraws the offer (re-entry) before it returns
  { const w = await EW.createEphemeralWallet(LOCAL), registered = new Set(), page = new EventTarget(); let withdraw = null;
    page.addEventListener('wallet-standard:register-wallet', e => e.detail({ register: x => { registered.add(x); withdraw?.(); w.destroy(); return () => registered.delete(x); } }));
    withdraw = w.announce(page); assert.equal(registered.size, 0); }
  // a later app-ready whose register() destroys the wallet
  { const w = await EW.createEphemeralWallet(LOCAL), registered = new Set(), page = new EventTarget();
    w.announce(page);
    page.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: { register: x => { registered.add(x); w.destroy(); return () => registered.delete(x); } } }));
    assert.equal(registered.size, 0);
    // and after the destroy no later app is offered the dead wallet
    page.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: { register: x => { registered.add(x); return () => registered.delete(x); } } }));
    assert.equal(registered.size, 0, 'a destroyed wallet answers no later app'); }
  // the real page layer: a change listener that destroys the wallet the moment it is registered
  await withStorage(async () => {
    const { wallet, page } = await pageWallet(), w = await EW.createEphemeralWallet(LOCAL);
    const stop = wallet.onChange(() => { if (!w.destroyed) w.destroy(); });
    try { w.announce(page); } finally { stop(); }
    assert.equal(w.destroyed, true);
    assert.equal(wallet.list('solana:localnet').some(x => x.name === EW.EPHEMERAL_WALLET_NAME), false, 'the page lists no dead wallet');
  });
});

test('a wallet destroyed while the page is connecting to it is not connected afterwards and is not remembered', async () => {
  await withStorage(async store => {
    const { wallet, page } = await pageWallet();
    for (const silent of [false, true]) {
      const w = await EW.createEphemeralWallet(LOCAL);
      w.announce(page);
      const entry = wallet.list('solana:localnet').find(x => x.name === EW.EPHEMERAL_WALLET_NAME);
      assert.ok(entry && entry.why === null);
      // the page's real connect: it awaits the wallet's standard:connect; the wallet is destroyed right after the call
      const connecting = wallet.connect(entry, { chain: 'solana:localnet', silent });
      w.destroy();
      const outcome = await connecting.then(v => ({ value: v }), e => ({ code: e.code }));
      if (silent) assert.deepEqual(outcome, { value: null }, 'a silent connect answers "not connected"'); else assert.ok(['WalletGone', 'NoAccount'].includes(outcome.code), `refused: ${JSON.stringify(outcome)}`);
      assert.equal(wallet.connected(), null, 'no stale connection came back after the await');
      assert.equal(store.size, 0, 'and the dead wallet\'s name was not written as the last wallet');
      assert.equal(wallet.lastWalletName(), null);
      assert.equal(wallet.list('solana:localnet').some(x => x.name === EW.EPHEMERAL_WALLET_NAME), false);
    }
    // destroyed while connected: the page's connection ends with it, and signing through the page is refused
    const w = await EW.createEphemeralWallet(LOCAL); w.announce(page);
    await wallet.connect(wallet.list('solana:localnet').find(x => x.name === EW.EPHEMERAL_WALLET_NAME), { chain: 'solana:localnet' });
    assert.equal(wallet.connected().address, w.address);
    w.destroy();
    assert.equal(wallet.connected(), null, 'the page is no longer connected to a destroyed wallet');
    assert.equal(await codeOf(wallet.signMessage(Uint8Array.of(1))), 'NoWallet');
    await wallet.disconnect();
    // an EPHEMERAL wallet that stays offered connects as before (the page layer's guard does not touch it)
    const plain = await EW.createEphemeralWallet(LOCAL); plain.announce(page);
    const ok = await wallet.connect(wallet.list('solana:localnet').find(x => x.name === EW.EPHEMERAL_WALLET_NAME), { chain: 'solana:localnet' });
    assert.equal(ok.address, plain.address); assert.equal(wallet.lastWalletName(), EW.EPHEMERAL_WALLET_NAME);
    await wallet.disconnect(); plain.destroy();
    // an ORDINARY wallet (an independent keyless mock of an extension, nothing of this module): offered, connected,
    // remembered and withdrawn exactly as the page layer always did; and withdrawn mid-connect it is not connected
    const mockOf = name => { const account = { address: toB58(new Uint8Array(32).fill(name.length)), publicKey: new Uint8Array(32), chains: ['solana:localnet'], features: ['solana:signTransaction', 'solana:signMessage'] };
      return { version: '1.0.0', name, icon: '', chains: ['solana:localnet'], accounts: [account], features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) }, 'standard:disconnect': { version: '1.0.0', disconnect: async () => {} }, 'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: async () => { throw new Error('no key'); } }, 'solana:signMessage': { version: '1.0.0', signMessage: async () => { throw new Error('no key'); } } } }; };
    const offer = mock => { let off = null; page.dispatchEvent(Object.assign(new Event('wallet-standard:register-wallet'), { detail: api => { off = api.register(mock); } })); return off; };
    const ext = mockOf('Mock Extension'), offExt = offer(ext);
    const viaExt = await wallet.connect(wallet.list('solana:localnet').find(x => x.name === 'Mock Extension'), { chain: 'solana:localnet' });
    assert.equal(viaExt.address, ext.accounts[0].address); assert.equal(wallet.lastWalletName(), 'Mock Extension', 'an ordinary wallet is remembered as before');
    await wallet.disconnect(); offExt();
    const gone = mockOf('Mock Extension Two'), offGone = offer(gone);
    const racing = wallet.connect(wallet.list('solana:localnet').find(x => x.name === 'Mock Extension Two'), { chain: 'solana:localnet' });
    offGone();
    assert.equal(await codeOf(racing), 'WalletGone', 'an ordinary wallet withdrawn while connecting is not connected either');
    assert.equal(wallet.connected(), null); assert.equal(wallet.lastWalletName(), null);
    // a wallet handed to connect() directly, never offered to the page, is outside the guard: connected as before
    const direct = mockOf('Mock Direct Wallet');
    assert.equal((await wallet.connect(direct, { chain: 'solana:localnet' })).address, direct.accounts[0].address);
    await wallet.disconnect();
  });
});

test('the page meets it through the Wallet Standard events, and web/wallet.mjs lists, connects and signs with it unchanged', async () => {
  const store = new Map();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); } } });
  try {
    const { wallet, page } = await pageWallet();
    const w = await EW.createEphemeralWallet(LOCAL);
    const withdraw = w.announce(page);
    const entry = wallet.list('solana:localnet').find(x => x.name === EW.EPHEMERAL_WALLET_NAME);
    assert.ok(entry && entry.why === null && entry.dev === false, 'listed as an ordinary usable wallet, not as the dev wallet');
    assert.ok(wallet.list('solana:devnet').find(x => x.name === EW.EPHEMERAL_WALLET_NAME).why, 'and not usable on another cluster');
    const connected = await wallet.connect(entry, { chain: 'solana:localnet' });
    assert.equal(connected.address, w.address); assert.equal(wallet.connected().address, w.address);
    const message = new TextEncoder().encode('through the page\'s own wallet layer');
    const { signature, signedMessage } = await wallet.signMessage(message);
    assert.deepEqual([...signedMessage], [...message]); assert.equal(await verify(w.address, message, signature), true);
    // what the page's wallet layer stored: the wallet's NAME for a later reconnect, and no key material
    assert.deepEqual([...store.values()], [EW.EPHEMERAL_WALLET_NAME]);
    assert.ok(![...store.values(), ...store.keys()].some(v => /^[0-9a-f]{64}$/.test(v) || v.includes(w.address)));
    assert.equal(store.has('ps-dev-wallet'), false, 'the stored dev wallet was neither read into nor written by this');
    // an app that becomes ready later is answered too
    const later = [];
    page.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: { register: x => { later.push(x); return () => { later.splice(later.indexOf(x), 1); }; } } }));
    assert.deepEqual(later, [w.wallet]);
    // destroy withdraws the wallet from the page and ends signing
    await wallet.disconnect();
    w.destroy();
    assert.equal(wallet.list('solana:localnet').some(x => x.name === EW.EPHEMERAL_WALLET_NAME), false, 'withdrawn from the list'); assert.deepEqual(later, []);
    withdraw();
  } finally { if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete globalThis.localStorage; }
});

for (const order of ['the old creation finishes first', 'the new creation finishes first']) {
  test(`create, destroy, create before the first key exists (${order}): the old callers are refused, the new ones share one key, no third is begun`, async () => {
    EW.destroyEphemeralWallet();
    const gates = []; let begun = 0;
    const slow = { generateKey: async (...x) => { const n = begun++; await new Promise(r => { gates[n] = r; }); return crypto.subtle.generateKey(...x); },
      exportKey: (...x) => crypto.subtle.exportKey(...x), sign: (...x) => crypto.subtle.sign(...x), verify: (...x) => crypto.subtle.verify(...x) };
    const old = EW.createEphemeralWallet({ ...LOCAL, subtle: slow }), oldJoined = EW.createEphemeralWallet({ ...LOCAL, subtle: slow });
    await until(() => begun === 1);
    assert.equal(EW.destroyEphemeralWallet(), false, 'nothing lives yet; the creation under way is dropped');
    const fresh = EW.createEphemeralWallet({ ...LOCAL, subtle: slow }), freshJoined = EW.createEphemeralWallet({ ...LOCAL, subtle: slow });
    await until(() => begun === 2);
    assert.equal(fresh, freshJoined, 'the second generation is one promise'); assert.notEqual(fresh, old);
    const oldCodes = Promise.all([codeOf(old), codeOf(oldJoined)]);
    if (order.startsWith('the old')) {
      gates[0](); assert.deepEqual(await oldCodes, ['EphemeralWalletDestroyed', 'EphemeralWalletDestroyed']);
      assert.equal(EW.currentEphemeralWallet(), null, 'the doomed key is nobody\'s');
      // a creation asked for now joins the one still being made: it is not a third generation
      const late = EW.createEphemeralWallet({ ...LOCAL, subtle: slow });
      assert.equal(late, fresh); await new Promise(r => setImmediate(r)); assert.equal(begun, 2, 'no third key is begun');
      gates[1](); const w = await fresh; assert.equal(await late, w); assert.equal(await freshJoined, w);
      assert.equal(EW.currentEphemeralWallet(), w); assert.equal(w.destroyed, false);
    } else {
      gates[1](); const w = await fresh; assert.equal(await freshJoined, w); assert.equal(EW.currentEphemeralWallet(), w);
      gates[0](); assert.deepEqual(await oldCodes, ['EphemeralWalletDestroyed', 'EphemeralWalletDestroyed']);
      assert.equal(EW.currentEphemeralWallet(), w, 'the old creation finishing late does not take the live wallet away'); assert.equal(w.destroyed, false);
      assert.equal(await EW.createEphemeralWallet({ ...LOCAL, subtle: slow }), w);
    }
    assert.equal(begun, 2, 'two keys were begun in all');
    EW.destroyEphemeralWallet();
  });
}
