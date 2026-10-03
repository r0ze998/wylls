// The playtest's guest key (PT-B): a test-only Wallet Standard wallet whose Ed25519 key lives in this
// browser (localStorage), so a friend without a Solana wallet can play. Nothing here is a real
// wallet: the key is random, holds nothing, signs only for the Wylls local test chain
// (`solana:localnet`), and is lost with the browser's site data unless it was saved. It exists only on
// pages served with the playtest boot script (the herald's `--inject-script`); no page file of the
// game is edited. The game finds it like any wallet (wallet.mjs discovery) and lists it as
// "Guest key (test only)".
//
// Stored: `ps-guest-key-v1` = {"seed": hex32, "pub": hex32} (the public half is kept so the wallet
// can be built without waiting for WebCrypto).
import { decode as fromBase58, encode as toBase58 } from '../../sdk/base58.mjs';
import { fromHex, randomBytes, toHex } from '../../sdk/bytes.mjs';
import { parseTransaction, wireTransaction } from '../../sdk/solana-tx.mjs';
import { keyFromSeed, publicKeyOf } from '../../session.mjs';

export const GUEST_NAME = 'Guest key (test only)';
export const KEY = 'ps-guest-key-v1';
export const INVITE_KEY = 'ps-playtest-invite-v1';
export const BACKUP_TAG = 'WYLLS-GUEST-KEY-1';
const CHAIN = 'solana:localnet';
const ICON = `data:image/svg+xml;base64,${globalThis.btoa?.('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#8a5a14"/><text x="16" y="22" font-size="16" text-anchor="middle" fill="#fff" font-family="sans-serif">G</text></svg>') ?? ''}`;

/**
 * PT-E: LINE, Instagram, Facebook, X, Kakao, WeChat, Naver, Snapchat, TikTok and Android WebViews. Their
 * storage is not the browser's, and saving or copying a key often fails there.
 */
export const inAppBrowser = (ua = globalThis.navigator?.userAgent ?? '') => /\bLine\/|Instagram|FBAN|FBAV|FB_IAB|FBIOS|Twitter|KAKAOTALK|MicroMessenger|; wv\)|\bNAVER\(|Snapchat|TikTok|musical_ly/i.test(ua);

const mem = new Map();
/** localStorage with a memory fallback; `persisted` says whether the last write reached disk. */
export const store = {
  get(k) { try { const v = globalThis.localStorage?.getItem(k); if (v != null) return v; } catch { /* blocked */ } return mem.get(k) ?? null; },
  set(k, v) { mem.set(k, v); try { globalThis.localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { mem.delete(k); try { globalThis.localStorage?.removeItem(k); } catch { /* blocked */ } },
};

/** The stored key `{seed, pub}` (hex), or null. */
export function readKey() {
  try {
    const j = JSON.parse(store.get(KEY) ?? 'null');
    return /^[0-9a-f]{64}$/.test(j?.seed ?? '') && /^[0-9a-f]{64}$/.test(j?.pub ?? '') ? j : null;
  } catch { return null; }
}

/** Make a new random key and keep it; `{key: {seed, pub}, persisted}`. */
export async function createKey(seedHex = toHex(randomBytes(32))) {
  const pub = toHex(await publicKeyOf(fromHex(seedHex)));
  const key = { seed: seedHex, pub };
  return { key, persisted: store.set(KEY, JSON.stringify(key)) };
}

/** The base58 address (the wallet's public key) of a stored key. */
export const addressOf = key => toBase58(fromHex(key.pub));

/** The text a person saves: one line carries the key. */
export const backupText = key => `Wylls playtest guest key (TEST ONLY: it holds nothing and works only on the Wylls test world)\n`
  + `Address: ${addressOf(key)}\nKey: ${BACKUP_TAG}:${key.seed}\n`
  + 'Anyone who has this key can play as you in the test. Keep it private. Paste it back on the start page ("I already have a key") to continue on another browser or after clearing site data.\n';

/** The seed hex in a pasted backup (the tagged line, or a bare 64-hex string), or null. */
export function parseBackup(text) {
  const t = String(text ?? '');
  const m = new RegExp(`${BACKUP_TAG}:([0-9a-fA-F]{64})`).exec(t) ?? /^\s*([0-9a-fA-F]{64})\s*$/.exec(t);
  return m ? m[1].toLowerCase() : null;
}

/**
 * A Wallet Standard wallet for `key` (`{seed, pub}`): connect, signMessage, signTransaction for
 * `solana:localnet` only; it never asks (a test key), exactly like the dev wallet. The Ed25519 signing
 * key is made on first use.
 */
export function guestWallet(key) {
  const publicKeyBytes = fromHex(key.pub);
  const address = toBase58(publicKeyBytes);
  const account = Object.freeze({ address, publicKey: publicKeyBytes, chains: [CHAIN], features: ['solana:signTransaction', 'solana:signMessage'] });
  let signer = null;
  const sign = async bytes => (signer ??= await keyFromSeed(fromHex(key.seed))).sign(bytes);
  return {
    version: '1.0.0', name: GUEST_NAME, icon: ICON, chains: [CHAIN], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': {
        version: '1.0.0', supportedTransactionVersions: ['legacy'],
        signTransaction: (...inputs) => Promise.all(inputs.map(async ({ transaction }) => {
          const tx = parseTransaction(transaction);
          const i = tx.signers.indexOf(address);
          if (i < 0) throw new Error('the guest key is not a signer of this transaction');
          const sigs = tx.signatures.slice();
          sigs[i] = await sign(tx.message);
          return { signedTransaction: wireTransaction(tx.message, sigs) };
        })),
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: (...inputs) => Promise.all(inputs.map(async ({ message }) => ({ signedMessage: Uint8Array.from(message), signature: await sign(message) }))),
      },
    },
  };
}

/** Offer `wallet` to the page by the Wallet Standard's two events (either order works). */
export function register(wallet, target = globalThis.window) {
  if (!target) return;
  const give = api => { try { api.register(wallet); } catch (e) { console.warn('guest key: registration failed', e); } };
  try { target.addEventListener('wallet-standard:app-ready', e => give(e.detail)); } catch { /* no events */ }
  try { target.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: give })); } catch { /* no events */ }
}

export { fromBase58 };
