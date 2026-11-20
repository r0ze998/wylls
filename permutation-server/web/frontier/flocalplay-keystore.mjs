// TEST-ONLY, NOT FOR PRODUCTION (⑧ P2 option B, owner decision 2026-11-18): the browser side of a RESUMABLE local
// world. Only for a page served by the local-play launcher that was itself started with `--persist local-persist-v1`
// (the launcher addresses its page with `persist=local`), on localnet, on a loopback host, in explicitly chosen local
// play — the same conditions as the memory-only wallet (fephemeral-wallet.mjs) plus that word.
//
// What is kept, in this browser's IndexedDB (database `wylls-local-play-test-v1`), per launcher origin:
//   wallets  the player's TEST key pair: the private key a NON-EXTRACTABLE WebCrypto Ed25519 CryptoKey (generated
//            with `extractable = false`; stored by structured clone, so no JavaScript ever sees its bytes, and it
//            cannot be exported after a reload either), the public key, and the public address.
//   secrets  a NON-EXTRACTABLE AES-GCM-256 key (the same way) and, per wallet, the page's march book encrypted with it
//            (AES-GCM, a fresh 96-bit IV per write, the scope as additional data). The march book holds the sealed
//            marches' reveal halves (plaintext and salt; never k or σ): so a reload keeps them.
// Nothing here is written to localStorage, sessionStorage, a cookie, a URL or the console, and no key or secret byte
// leaves WebCrypto or this module. A page script of the same origin can still USE the keys (sign, decrypt) while the
// page runs: that is what non-extractable means, and why this is for disposable local test chains only.
// `forgetLocalPlayKeys` deletes this origin's entries (the next start makes a new key and a new world).
//
// References compared (2026-11-18): builderz-labs/mission-control `src/lib/device-identity.ts` (Ed25519, extractable
// false, CryptoKey in IndexedDB), element-hq/element-web `apps/web/src/utils/tokens/pickling.ts` (secret bytes wrapped
// by a non-extractable AES-GCM key kept in IndexedDB), dfinity/icp-js-core `identity/ecdsa.ts` (non-extractable by
// default), anza-xyz/wallet-adapter `unsafe-burner` (memory-only keypair: the baseline this replaces for TEST worlds).

export const KEYSTORE_DB = 'wylls-local-play-test-v1';
export const KEYSTORE_VERSION = 1;
const WALLETS = 'wallets', SECRETS = 'secrets';
const ED25519 = 'Ed25519', AES = 'AES-GCM';
export const PERSIST_PAGE_WORD = 'local';

const fail = (code, message) => { throw Object.assign(new Error(message ?? code), { code }); };
const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error ?? new Error('IndexedDB')); });
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error('IndexedDB')); tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted')); });

/**
 * Opens (creating once) the TEST key store. `idb` is `globalThis.indexedDB` (tests pass a fake). `db`
 * (devnet-page-war): another database of the same two stores — the devnet page's march book (fdevnetbook.mjs), which
 * keeps no key pair; local play's is the default, unchanged.
 */
export async function openKeyStore({ idb = globalThis.indexedDB, db: name = KEYSTORE_DB } = {}) {
  if (!idb?.open) fail('NoIndexedDB', 'this browser keeps no IndexedDB here (private mode?): the key cannot be kept');
  const open = idb.open(name, KEYSTORE_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const s of [WALLETS, SECRETS]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
  };
  let db;
  try { db = await req(open); } catch { fail('NoIndexedDB', 'the key store cannot be opened'); }
  const get = async (store, key) => { const tx = db.transaction(store, 'readonly'); const v = await req(tx.objectStore(store).get(key)); await done(tx); return v ?? null; };
  const put = async (store, key, value) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); await done(tx); };
  const del = async (store, key) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); await done(tx); };
  return Object.freeze({ get, put, del, close: () => db.close() });
}

/** The scope of one launcher's persisted test wallet: its page origin (`http://localhost:<port>`), exactly. */
export function walletScope(loc = globalThis.location) {
  const u = new URL(loc.href);
  return `local-play-wallet:${u.origin}`;
}

/** Whether a stored private key is what this module stores: a private Ed25519 CryptoKey that can only sign and can never be exported. */
export function storedPrivateKeyOk(k) {
  return !!k && typeof k === 'object' && k.type === 'private' && k.extractable === false && k.algorithm?.name === ED25519
    && Array.isArray(k.usages) && k.usages.length === 1 && k.usages[0] === 'sign';
}
const storedAesKeyOk = k => !!k && typeof k === 'object' && k.type === 'secret' && k.extractable === false && k.algorithm?.name === AES
  && Array.isArray(k.usages) && k.usages.length === 2 && k.usages.includes('encrypt') && k.usages.includes('decrypt');

/**
 * The persisted test key pair of `scope`: `{privateKey, publicKey, address}`, or null when none is kept. A record that
 * is not exactly what `saveWalletPair` writes (another shape, an extractable or another kind of key, an address that is
 * not the public key's) is refused with `StoredKeyInvalid`, never used and never repaired.
 */
export async function loadWalletPair(store, scope, { subtle = globalThis.crypto?.subtle, encode } = {}) {
  const v = await store.get(WALLETS, scope);
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || v.schema !== 'frontier-local-play-test-wallet-v1' || v.test_only !== true || !storedPrivateKeyOk(v.privateKey)
    || v.publicKey?.type !== 'public' || typeof v.address !== 'string') fail('StoredKeyInvalid', 'the kept test key is not one this page made');
  const raw = new Uint8Array(await subtle.exportKey('raw', v.publicKey));
  if (raw.length !== 32 || (encode && encode(raw) !== v.address)) fail('StoredKeyInvalid', 'the kept test key does not match its address');
  return { privateKey: v.privateKey, publicKey: v.publicKey, address: v.address };
}

/** Keeps `pair` (a non-extractable private key only: anything else is refused) for `scope`. */
export async function saveWalletPair(store, scope, { privateKey, publicKey, address }) {
  if (!storedPrivateKeyOk(privateKey)) fail('StoredKeyInvalid', 'only a non-extractable signing key is kept');
  await store.put(WALLETS, scope, { schema: 'frontier-local-play-test-wallet-v1', test_only: true, not_for_production: true, privateKey, publicKey, address, savedAt: Date.now() });
}

/** Deletes `scope`'s kept key pair and every march book and book key kept for that origin's wallets. */
export async function forgetLocalPlayKeys(store, scope) {
  const pair = await store.get(WALLETS, scope).catch(() => null);
  await store.del(WALLETS, scope);
  if (pair?.address) { await store.del(SECRETS, bookScope(scope, pair.address)); await store.del(SECRETS, `${bookScope(scope, pair.address)}#key`); }
}

export const bookScope = (scope, address) => `${scope}|book|${address}`;
const text = new TextEncoder(), untext = new TextDecoder();

/**
 * The march book of one wallet, kept encrypted (the reveal halves a sealed march needs). → `{storage, ready, flush}`:
 *   storage  the march book's synchronous storage shape (`get(k)`, `set(k, v)`): reads come from memory; every `set`
 *            is written through (encrypted) in order, after the previous write;
 *   flush()  resolves when every write so far is kept (or rejects with the first failure).
 * `ready` is the loaded book: create this BEFORE the page boots and await it.
 */
export async function openSealedBook(store, scope, address, { subtle = globalThis.crypto?.subtle, random = n => globalThis.crypto.getRandomValues(new Uint8Array(n)) } = {}) {
  const key = bookScope(scope, address), ad = text.encode(key);
  let aes = await store.get(SECRETS, `${key}#key`);
  if (aes === null || aes === undefined) {
    // extractable = false: the book's key can encrypt and decrypt here, and can never be read or exported
    aes = await subtle.generateKey({ name: AES, length: 256 }, false, ['encrypt', 'decrypt']);
    await store.put(SECRETS, `${key}#key`, aes);
  } else if (!storedAesKeyOk(aes)) fail('StoredKeyInvalid', 'the kept book key is not one this page made');
  const memory = new Map();
  const sealed = await store.get(SECRETS, key);
  if (sealed !== null && sealed !== undefined) {
    if (!(sealed?.iv instanceof Uint8Array) || sealed.iv.length !== 12 || !(sealed?.data instanceof Uint8Array)) fail('StoredBookInvalid', 'the kept march book is not one this page wrote');
    let plain;
    try { plain = untext.decode(await subtle.decrypt({ name: AES, iv: sealed.iv, additionalData: ad }, aes, sealed.data)); } catch { fail('StoredBookInvalid', 'the kept march book cannot be opened'); }
    let entries; try { entries = JSON.parse(plain); } catch { fail('StoredBookInvalid', 'the kept march book cannot be read'); }
    if (!Array.isArray(entries) || !entries.every(e => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string')) fail('StoredBookInvalid', 'the kept march book cannot be read');
    for (const [k, v] of entries) memory.set(k, v);
  }
  let chain = Promise.resolve(), failure = null;
  const write = () => {
    const snapshot = JSON.stringify([...memory]);
    chain = chain.then(async () => {
      const iv = random(12);
      const data = new Uint8Array(await subtle.encrypt({ name: AES, iv, additionalData: ad }, aes, text.encode(snapshot)));
      await store.put(SECRETS, key, { iv, data });
    }).catch(e => { failure ??= e; });
    return chain;
  };
  const storage = Object.freeze({ get: k => (memory.has(k) ? memory.get(k) : null), set: (k, v) => { memory.set(k, String(v)); write(); return true; } });
  return { storage, flush: async () => { await chain; if (failure) throw failure; } };
}
