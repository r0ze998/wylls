// A memory-only TEST wallet for local play: a fresh Ed25519 key that exists only inside this page's WebCrypto.
//
// Only when ALL of these hold, checked at creation: the cluster is `localnet`, the page is served from a loopback
// host, and the caller passes `localPlay: true` (an explicit choice of the dedicated local-play mode). Anything else
// is refused. It is not the dev wallet (web/wallet.mjs), whose seed lives in localStorage: nothing is read from or
// written to localStorage, sessionStorage, a file, a URL or the console here, and no stored key is looked at.
//
// The key: `crypto.subtle.generateKey('Ed25519', extractable = false)`. There is no seed, no private-key bytes and
// no derivation from a signature in JavaScript at any time: only the engine holds the key, and it cannot be exported.
// What leaves this module is the PUBLIC address and signatures.
//
// Lifetime:
//   create    the one live wallet of the page (a second call while one lives returns the same wallet)
//   disconnect (Wallet Standard)  the page forgets the connection; the key stays, a reconnect is the same address
//   destroy   the key reference is dropped: every later connect or signature refuses, for good
//   create again after destroy    a NEW key and a NEW address; the old one cannot be had again
//   reload    the page's memory is gone, and the key with it
// It signs real Ed25519 signatures for a disposable local chain. It is not for a public cluster or real funds.
import { parseTransaction, wireTransaction } from '../sdk/solana-tx.mjs';
import { encode as toBase58 } from '../sdk/base58.mjs';

export const EPHEMERAL_WALLET_NAME = 'Local Play Wallet (memory only)';
export const EPHEMERAL_CHAIN = 'solana:localnet';
const ED25519 = 'Ed25519';
const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNyIgZmlsbD0iIzNjMGMwOCIvPjx0ZXh0IHg9IjE2IiB5PSIyMiIgZm9udC1zaXplPSIxMyIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2YwZDQ4YSIgZm9udC1mYW1pbHk9Im1vbm9zcGFjZSI+TUVNPC90ZXh0Pjwvc3ZnPg==';

const fail = (code, message) => { throw Object.assign(new Error(message ?? code), { code }); };

/** Whether `hostname` is this machine: localhost, a `.localhost` name, 127.0.0.0/8 or ::1. */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every(x => Number(x) <= 255);
}

/**
 * May a memory-only wallet be made here? `{ok: true}` or `{ok: false, code}`:
 *   EphemeralWalletNotChosen  `localPlay` is not exactly `true`
 *   EphemeralWalletCluster    the cluster is not `localnet`
 *   EphemeralWalletHost       the page is not on a loopback host
 */
export function ephemeralWalletAllowed({ cluster, hostname, localPlay } = {}) {
  if (localPlay !== true) return { ok: false, code: 'EphemeralWalletNotChosen' };
  if (cluster !== 'localnet') return { ok: false, code: 'EphemeralWalletCluster' };
  if (!isLoopbackHost(hostname)) return { ok: false, code: 'EphemeralWalletHost' };
  return { ok: true };
}

let live = null;       // the page's one live wallet (a handle), or null
let creating = null;   // the creation under way, shared by callers that ask meanwhile

/** The live wallet's handle, or null. The handle carries the public address and no key. */
export const currentEphemeralWallet = () => live;

/**
 * The page's memory-only wallet: `{name, address, publicKey, wallet, destroyed, destroy(), announce(target), toJSON()}`.
 * `wallet` is the Wallet Standard object; `address` (base58) and `publicKey` (bytes) are public. Refused (a thrown
 * error with a code) unless `ephemeralWalletAllowed`. A call while a wallet lives, or while one is being made,
 * returns that same wallet; it never makes a second key.
 */
export function createEphemeralWallet({ cluster, hostname = globalThis.location?.hostname, localPlay, subtle = globalThis.crypto?.subtle } = {}) {
  const allowed = ephemeralWalletAllowed({ cluster, hostname, localPlay });
  if (!allowed.ok) return Promise.reject(Object.assign(new Error('a memory-only test wallet is for explicitly chosen local play on localnet, on this machine'), { code: allowed.code }));
  if (live) return Promise.resolve(live);
  if (!creating) {
    const mine = epoch;
    const p = make(subtle).then(handle => {
      // destroyed while it was being made: the new key is dropped at once and nobody gets it
      if (mine !== epoch) { handle.destroy(); fail('EphemeralWalletDestroyed', 'the memory-only wallet was destroyed while it was being made'); }
      live = handle; return handle;
    }).finally(() => { if (creating === p) creating = null; });
    creating = p;
  }
  return creating;
}
let epoch = 0;

async function make(subtle) {
  if (!subtle?.generateKey) fail('NoEd25519', 'this page cannot make an Ed25519 key');
  let pair;
  // extractable = false: the private key cannot be exported, wrapped or read; only `sign` may use it
  try { pair = await subtle.generateKey(ED25519, false, ['sign', 'verify']); } catch { fail('NoEd25519', 'this page cannot make an Ed25519 key'); }
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  if (publicKey.length !== 32) fail('NoEd25519', 'unexpected public key');
  const address = toBase58(publicKey);
  // The only reference to the private key, in this closure. `destroy` drops it.
  let key = pair.privateKey;
  pair = null;
  const unregister = new Set();
  const alive = () => { if (key === null) fail('EphemeralWalletDestroyed', 'this memory-only wallet was destroyed'); return key; };
  // A signature is handed out only by a wallet that is alive when it is asked AND when the engine has answered:
  // one made while the wallet was being destroyed is dropped, never returned.
  const sign = async bytes => {
    const signature = new Uint8Array(await subtle.sign(ED25519, alive(), bytes));
    alive();
    return signature;
  };
  // The account object is alive with the wallet: once destroyed it has no address, so a page that was still
  // connecting (web/wallet.mjs awaits `standard:connect`) finds no usable account and connects nothing.
  const account = Object.freeze({
    get address() { return key === null ? undefined : address; },
    publicKey: Uint8Array.from(publicKey), chains: Object.freeze([EPHEMERAL_CHAIN]), features: Object.freeze(['solana:signTransaction', 'solana:signMessage']),
  });
  const mine = input => {
    if (input?.account !== undefined && input.account?.address !== address) fail('EphemeralWalletAccount', 'not this wallet\'s account');
    if (input?.chain !== undefined && input.chain !== EPHEMERAL_CHAIN) fail('EphemeralWalletCluster', 'this wallet signs for localnet only');
  };
  const wallet = Object.freeze({
    version: '1.0.0', name: EPHEMERAL_WALLET_NAME, icon: ICON, chains: Object.freeze([EPHEMERAL_CHAIN]),
    // (no account once destroyed)
    get accounts() { return key === null ? Object.freeze([]) : Object.freeze([account]); },
    features: Object.freeze({
      'standard:connect': Object.freeze({ version: '1.0.0', connect: async () => { alive(); return { accounts: [account] }; } }),
      // (forgetting the connection is the page's; the key stays until `destroy`)
      'standard:disconnect': Object.freeze({ version: '1.0.0', disconnect: async () => {} }),
      'standard:events': Object.freeze({ version: '1.0.0', on: () => () => {} }),
      'solana:signTransaction': Object.freeze({
        version: '1.0.0', supportedTransactionVersions: Object.freeze(['legacy']),
        signTransaction: async (...inputs) => {
          alive();
          const out = [];
          for (const input of inputs) {
            mine(input);
            // one snapshot of the caller's bytes: what is parsed, signed and returned is the same transaction
            const tx = parseTransaction(Uint8Array.from(input.transaction));
            const i = tx.signers.indexOf(address);
            if (i < 0) fail('EphemeralWalletNotSigner', 'this wallet is not a signer of this transaction');
            const signatures = tx.signatures.slice();
            signatures[i] = await sign(tx.message);
            out.push({ signedTransaction: wireTransaction(tx.message, signatures) });
          }
          alive();   // destroyed anywhere during the batch: none of it is returned
          return out;
        },
      }),
      'solana:signMessage': Object.freeze({
        version: '1.0.0',
        signMessage: async (...inputs) => {
          alive();
          const out = [];
          for (const input of inputs) {
            mine(input);
            // one snapshot: the bytes signed are the bytes returned as `signedMessage`, whatever the caller does to its array meanwhile
            const message = Uint8Array.from(input.message);
            out.push({ signedMessage: Uint8Array.from(message), signature: await sign(message) });
          }
          alive();   // destroyed anywhere during the batch: none of it is returned
          return out;
        },
      }),
    }),
  });
  const handle = {
    name: EPHEMERAL_WALLET_NAME, address, wallet,
    get publicKey() { return Uint8Array.from(publicKey); },
    get destroyed() { return key === null; },
    /**
     * Offer the wallet to the page through the Wallet Standard's own events (`wallet-standard:register-wallet`, and
     * an answer to a later `wallet-standard:app-ready`), so web/wallet.mjs lists it like any other wallet with no
     * change to it. Returns a function that withdraws the offer; `destroy` withdraws every offer.
     */
    announce(target = globalThis.window) {
      alive();
      if (!target?.addEventListener || !target.dispatchEvent) fail('EphemeralWalletNoPage', 'no page to announce the wallet to');
      // The way back is in place BEFORE any page code runs: a registration that destroys the wallet, or withdraws
      // the offer, while it is being made is undone the moment the page hands its unregister function back.
      const offs = [];
      let withdrawn = false;
      const undo = off => { try { off(); } catch { /* already gone */ } };
      const onReady = e => register(e.detail);
      const withdraw = () => {
        withdrawn = true;
        target.removeEventListener('wallet-standard:app-ready', onReady);
        for (const off of offs.splice(0)) undo(off);
        unregister.delete(withdraw);
      };
      const register = api => {
        if (withdrawn || key === null) return;
        const off = api?.register?.(wallet);
        if (typeof off !== 'function') return;
        if (withdrawn || key === null) undo(off); else offs.push(off);
      };
      unregister.add(withdraw);
      target.addEventListener('wallet-standard:app-ready', onReady);
      const Event = target.CustomEvent ?? globalThis.CustomEvent;
      target.dispatchEvent(new Event('wallet-standard:register-wallet', { detail: register }));
      return withdraw;
    },
    /** Drop the key for good and withdraw every offer. The next `createEphemeralWallet` makes a new key and address. */
    destroy() {
      key = null;
      for (const withdraw of [...unregister]) withdraw();
      if (live === handle) live = null;
    },
    /** What may be handed to a runner or logged: the name and the public address, nothing else. */
    toJSON() { return { name: EPHEMERAL_WALLET_NAME, address }; },
  };
  return Object.freeze(handle);
}

/** Destroy the live wallet, if any (see `destroy`). → whether there was one. */
export function destroyEphemeralWallet() {
  epoch++;          // a creation under way is dropped when it finishes: its callers are refused
  creating = null;  // and a creation asked for after this is a new one, never that doomed one
  if (!live) return false;
  live.destroy();
  return true;
}
