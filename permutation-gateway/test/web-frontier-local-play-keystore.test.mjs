// ⑧ P2 option B (TEST-ONLY, not for production): the page's kept test key and its encrypted march book
// (web/frontier/flocalplay-keystore.mjs, fephemeral-wallet.mjs `keep`). Real WebCrypto (Node's), a fake IndexedDB that
// keeps the very objects it is given (as structured clone keeps a CryptoKey). Test keys of no chain; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as KS from '../../permutation-server/web/frontier/flocalplay-keystore.mjs';
import * as EW from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { localPersistPage, launcherPersisted } from '../../permutation-server/web/frontier/flocalplay.mjs';
import { createLocalMarchSender, useLocalMarchStorage, LOCAL_MARCH_BOOK_KEY } from '../../permutation-server/web/frontier/flocalplay-march.mjs';

const subtle = globalThis.crypto.subtle;
const LOCAL = { cluster: 'localnet', hostname: 'localhost', localPlay: true };
const loc = href => ({ href, hostname: new URL(href).hostname });

/** A minimal IndexedDB: open (with upgrade), transactions, get/put/delete. Values are kept as given. */
function fakeIdb() {
  const dbs = new Map(), opened = [];
  const request = fn => { const r = {}; queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
  return {
    dbs, opened,
    open(name, version) {
      opened.push([name, version]);
      const r = {};
      queueMicrotask(() => {
        let db = dbs.get(name); const fresh = !db;
        if (!db) { db = new Map(); dbs.set(name, db); }
        r.result = {
          objectStoreNames: { contains: n => db.has(n) },
          createObjectStore: n => { db.set(n, new Map()); },
          transaction(store) {
            const m = db.get(store), tx = {};
            tx.objectStore = () => ({ get: k => request(() => m.get(k)), put: (v, k) => { m.set(k, v); return {}; }, delete: k => { m.delete(k); return {}; } });
            setTimeout(() => tx.oncomplete?.(), 0);
            return tx;
          },
          close() {},
        };
        if (fresh) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
}

test('the store: one versioned database, two object stores; refused without IndexedDB', async () => {
  const idb = fakeIdb();
  const store = await KS.openKeyStore({ idb });
  assert.deepEqual(idb.opened, [['wylls-local-play-test-v1', 1]]);
  assert.deepEqual([...idb.dbs.get('wylls-local-play-test-v1').keys()].sort(), ['secrets', 'wallets']);
  await store.put('wallets', 'k', 1); assert.equal(await store.get('wallets', 'k'), 1);
  await store.del('wallets', 'k'); assert.equal(await store.get('wallets', 'k'), null);
  await assert.rejects(KS.openKeyStore({ idb: undefined }), e => e.code === 'NoIndexedDB');
  assert.equal(KS.walletScope(loc('http://localhost:41360/frontier/frontier/index.html?x=1')), 'local-play-wallet:http://localhost:41360');
});

test('the kept wallet: made non-extractable, kept, and the SAME address after a "reload"; never exportable', async () => {
  const store = await KS.openKeyStore({ idb: fakeIdb() }), scope = 'local-play-wallet:http://localhost:41360';
  const keep = { store, scope };
  const first = await EW.createEphemeralWallet({ ...LOCAL, keep });
  assert.equal(first.name, EW.KEPT_WALLET_NAME); assert.equal(first.kept, true); assert.equal(first.reused, false);
  assert.ok(EW.LOCAL_PLAY_WALLET_NAMES.includes(first.wallet.name));
  const rec = await store.get('wallets', scope);
  assert.equal(rec.address, first.address); assert.equal(rec.test_only, true); assert.equal(rec.not_for_production, true);
  assert.equal(rec.privateKey.extractable, false); assert.deepEqual(rec.privateKey.usages, ['sign']); assert.equal(rec.privateKey.algorithm.name, 'Ed25519');
  await assert.rejects(subtle.exportKey('pkcs8', rec.privateKey), 'the kept private key cannot be exported');
  await assert.rejects(subtle.exportKey('jwk', rec.privateKey));
  // (a reload: the page's memory is gone; the browser keeps the CryptoKey)
  EW.destroyEphemeralWallet();
  assert.equal(first.destroyed, true);
  const again = await EW.createEphemeralWallet({ ...LOCAL, keep });
  assert.equal(again.address, first.address, 'the same address, so the same world and village');
  assert.equal(again.reused, true);
  const signed = await again.wallet.features['solana:signMessage'].signMessage({ account: again.wallet.accounts[0], message: Uint8Array.of(1, 2, 3) });
  assert.ok(await subtle.verify('Ed25519', rec.publicKey, signed[0].signature, Uint8Array.of(1, 2, 3)), 'it signs with the kept key');
  EW.destroyEphemeralWallet();
  // (without `keep`: the memory-only wallet, a new address, nothing kept)
  const plain = await EW.createEphemeralWallet(LOCAL);
  assert.equal(plain.name, EW.EPHEMERAL_WALLET_NAME); assert.equal(plain.kept, false); assert.notEqual(plain.address, first.address);
  EW.destroyEphemeralWallet();
  // (forget: the next start makes a new key)
  await KS.forgetLocalPlayKeys(store, scope);
  assert.equal(await store.get('wallets', scope), null);
  const fresh = await EW.createEphemeralWallet({ ...LOCAL, keep });
  assert.notEqual(fresh.address, first.address); assert.equal(fresh.reused, false);
  EW.destroyEphemeralWallet();
});

test('a kept record that is not what this page writes is refused, never used or repaired', async () => {
  const store = await KS.openKeyStore({ idb: fakeIdb() }), scope = 's';
  const extractable = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  await assert.rejects(KS.saveWalletPair(store, scope, { ...extractable, address: 'x' }), e => e.code === 'StoredKeyInvalid', 'an extractable key is never kept');
  const good = await subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const base = { schema: 'frontier-local-play-test-wallet-v1', test_only: true, privateKey: good.privateKey, publicKey: good.publicKey, address: 'not-its-address' };
  for (const [bad, why] of [[{ ...base, privateKey: extractable.privateKey }, 'extractable'], [{ ...base, schema: 'other' }, 'schema'], [{ ...base, test_only: false }, 'not test-only'], [base, 'address mismatch'], ['x', 'not an object']]) {
    await store.put('wallets', scope, bad);
    await assert.rejects(EW.createEphemeralWallet({ ...LOCAL, keep: { store, scope } }), e => e.code === 'StoredKeyInvalid', why);
    EW.destroyEphemeralWallet();
    assert.equal(await store.get('wallets', scope), bad, `${why}: left as it was`);
  }
});

test('the march book (the reveal halves): encrypted with a non-extractable key, bound to its wallet, back after a "reload"', async () => {
  const idb = fakeIdb(), store = await KS.openKeyStore({ idb }), scope = 'local-play-wallet:http://localhost:41360';
  const book = await KS.openSealedBook(store, scope, 'Addr1');
  const entry = JSON.stringify([{ v: 1, host: '7', plain_b64: 'cGxhaW4tc2VjcmV0LWhhbGY=', salt_b64: 'c2FsdA==', state: 'sent', signature: 'sig1' }]);
  book.storage.set(LOCAL_MARCH_BOOK_KEY, entry);
  assert.equal(book.storage.get(LOCAL_MARCH_BOOK_KEY), entry, 'read from memory at once');
  await book.flush();
  const kept = await store.get('secrets', KS.bookScope(scope, 'Addr1'));
  assert.equal(kept.iv.length, 12);
  assert.ok(!Buffer.from(kept.data).toString('latin1').includes('plain_b64'), 'no plaintext at rest');
  const aes = await store.get('secrets', `${KS.bookScope(scope, 'Addr1')}#key`);
  assert.equal(aes.extractable, false); await assert.rejects(subtle.exportKey('raw', aes));
  // (a reload: a new book object reads the kept one)
  const back = await KS.openSealedBook(store, scope, 'Addr1');
  assert.equal(back.storage.get(LOCAL_MARCH_BOOK_KEY), entry);
  // (another wallet's book is another book; a record moved to another wallet's place does not open)
  const other = await KS.openSealedBook(store, scope, 'Addr2');
  assert.equal(other.storage.get(LOCAL_MARCH_BOOK_KEY), null);
  await store.put('secrets', KS.bookScope(scope, 'Addr2'), kept);
  await assert.rejects(KS.openSealedBook(store, scope, 'Addr2'), e => e.code === 'StoredBookInvalid');
  // (a fresh IV per write)
  back.storage.set('x', 'y'); await back.flush();
  assert.notDeepEqual((await store.get('secrets', KS.bookScope(scope, 'Addr1'))).iv, kept.iv);
});

test('the gate\'s words: persist=local on a launcher page only; the start answer\'s persisted is {resumed} exactly', () => {
  const cfg = { mode: 'play', dev: true };
  assert.equal(localPersistPage(cfg, loc('http://localhost:41360/f?localPlay=1&launcher=1&persist=local')), true);
  assert.equal(localPersistPage(cfg, loc('http://localhost:41360/f?localPlay=1&persist=local')), false, 'not a launcher page');
  assert.equal(localPersistPage(cfg, loc('http://localhost:41360/f?localPlay=1&launcher=1&persist=yes')), false);
  assert.equal(localPersistPage(cfg, loc('http://example.com/f?localPlay=1&launcher=1&persist=local')), false, 'not loopback');
  assert.deepEqual(launcherPersisted({ resumed: true }), { resumed: true });
  assert.deepEqual(launcherPersisted({ resumed: false }), { resumed: false });
  for (const bad of [null, undefined, true, {}, { resumed: 'yes' }, { resumed: true, more: 1 }, [true]]) assert.equal(launcherPersisted(bad), null, JSON.stringify(bad));
});

test('the march sender uses the kept book only when the gate set one', () => {
  const deps = { allowed: () => ({ ok: false }), open: () => false, identity: () => null, rulesetHash: () => null, signer: () => null };
  const memory = createLocalMarchSender(deps);
  memory.storage.set('k', 'v');
  assert.equal(createLocalMarchSender(deps).storage.get('k'), null, 'memory-only: each sender its own');
  const kept = new Map(), storage = { get: k => kept.get(k) ?? null, set: (k, v) => { kept.set(k, v); return true; } };
  useLocalMarchStorage(storage);
  try {
    assert.equal(createLocalMarchSender(deps).storage, storage);
    assert.throws(() => useLocalMarchStorage({ get() {} }), e => e.code === 'BadLocalMarchStorage');
  } finally { useLocalMarchStorage(null); }
  assert.notEqual(createLocalMarchSender(deps).storage, storage);
});
