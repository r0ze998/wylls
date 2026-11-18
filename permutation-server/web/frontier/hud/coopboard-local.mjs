// LOCAL PLAY, TEST-ONLY (B13, loop-play2) — workstream 01's co-op board in a world of the local-play launcher.
//
// The launcher started with `--coop-board ws01-board-v1` serves each world's board on ITS origin (the page's) under
// `/coop-world/<the world's proxy port>` (permutation-gateway/src/frontier/local-play-coop-board.mjs). This module
// gives hud/coopboard.mjs that base, and opens ①'s page so that the player can sign ①'s records with the page's own
// memory-only key (fephemeral-wallet.mjs) — the one wallet the player has in local play.
//
// The key is never copied: ①'s page (same origin, a window this page opened) is OFFERED a Wallet Standard wallet
// through the standard's own events, as any wallet is (web/wallet.mjs discovers it unchanged). That wallet is a narrow
// view of the page's key:
//   - it signs a MESSAGE only when the message is one of ①'s records: it starts with ①'s domain line
//     `WYLLS-COOP-V1\n` (workstreams/01-national-strategy/coop/record.mjs messageOf), and is valid UTF-8 JSON after it;
//   - it signs NO transaction (the game's own orders are signed by the game page only);
//   - it has the page key's address (the same player, the same Citizen), and ends with that key.
// ①'s signing format is unchanged; nothing here decides a rule of ①.
import { EPHEMERAL_WALLET_NAME, EPHEMERAL_CHAIN, isLoopbackHost } from '../fephemeral-wallet.mjs';

/** ①'s domain line (record.mjs DOMAIN + '\n'): the only messages the board's view of the key signs. */
export const COOP_DOMAIN_LINE = 'WYLLS-COOP-V1\n';
export const COOP_WALLET_NAME = `${EPHEMERAL_WALLET_NAME} — co-op records only`;
const DOMAIN_BYTES = new TextEncoder().encode(COOP_DOMAIN_LINE);

/** The launcher-origin base of the board of the world behind `herald` (a loopback proxy origin), or null. */
export function localBoardBase(herald) {
  let u;
  try { u = new URL(String(herald)); } catch { return null; }
  if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname) || !/^\d{5}$/.test(u.port) || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return null;
  return `/coop-world/${u.port}`;
}

/** Whether `bytes` is one of ①'s record messages: the domain line, then UTF-8 JSON (an object). */
export function isCoopRecordMessage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length <= DOMAIN_BYTES.length || bytes.length > 16384) return false;
  for (let i = 0; i < DOMAIN_BYTES.length; i++) if (bytes[i] !== DOMAIN_BYTES[i]) return false;
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(DOMAIN_BYTES.length)));
    return !!body && typeof body === 'object' && !Array.isArray(body);
  } catch { return false; }
}

const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };

/**
 * The board's view of the page's memory-only wallet `handle` (fephemeral-wallet.mjs): a Wallet Standard wallet that
 * signs ①'s record messages only, and no transaction. Ends with the handle (destroyed → no account, every call refused).
 */
export function coopRecordsWallet(handle) {
  const inner = handle?.wallet?.features?.['solana:signMessage'];
  if (!handle || typeof handle.address !== 'string' || typeof inner?.signMessage !== 'function') refuse('CoopWalletNoKey', 'no local-play key');
  const address = handle.address;
  const alive = () => { if (handle.destroyed) refuse('CoopWalletEnded', 'the page\'s key has ended'); };
  const account = Object.freeze({
    get address() { return handle.destroyed ? undefined : address; },
    publicKey: Uint8Array.from(handle.publicKey ?? []), chains: Object.freeze([EPHEMERAL_CHAIN]), features: Object.freeze(['solana:signTransaction', 'solana:signMessage']),
  });
  return Object.freeze({
    version: '1.0.0', name: COOP_WALLET_NAME, icon: handle.wallet.icon, chains: Object.freeze([EPHEMERAL_CHAIN]),
    get accounts() { return handle.destroyed ? Object.freeze([]) : Object.freeze([account]); },
    features: Object.freeze({
      'standard:connect': Object.freeze({ version: '1.0.0', connect: async () => { alive(); return { accounts: [account] }; } }),
      'standard:disconnect': Object.freeze({ version: '1.0.0', disconnect: async () => {} }),
      'standard:events': Object.freeze({ version: '1.0.0', on: () => () => {} }),
      // (present so that web/wallet.mjs lists it; it never signs: the game's orders are the game page's own)
      'solana:signTransaction': Object.freeze({ version: '1.0.0', supportedTransactionVersions: Object.freeze(['legacy']),
        signTransaction: async () => refuse('CoopWalletNoTransactions', 'this view of the local-play key signs co-op board records only') }),
      'solana:signMessage': Object.freeze({
        version: '1.0.0',
        signMessage: async (...inputs) => {
          alive();
          const out = [];
          for (const input of inputs) {
            if (input?.account !== undefined && input.account?.address !== address) refuse('CoopWalletAccount', 'not this wallet\'s account');
            if (input?.chain !== undefined && input.chain !== EPHEMERAL_CHAIN) refuse('CoopWalletCluster', 'localnet only');
            const message = Uint8Array.from(input?.message ?? []);   // (one snapshot: what is checked is what is signed)
            if (!isCoopRecordMessage(message)) refuse('CoopWalletNotARecord', 'this view of the local-play key signs co-op board records only');
            const [r] = await inner.signMessage({ message });
            out.push({ signedMessage: Uint8Array.from(message), signature: Uint8Array.from(r.signature) });
          }
          alive();
          return out;
        },
      }),
    }),
  });
}

/**
 * Offer `wallet` to the page in window `target` through the Wallet Standard's events (a register-wallet event now,
 * and an answer to a later app-ready). → a function that withdraws the offer.
 */
export function offerWallet(wallet, target) {
  const offs = [];
  let withdrawn = false;
  const register = api => {
    if (withdrawn) return;
    const off = api?.register?.(wallet);
    if (typeof off === 'function') offs.push(off);
  };
  const onReady = e => register(e.detail);
  target.addEventListener('wallet-standard:app-ready', onReady);
  const Event = target.CustomEvent ?? globalThis.CustomEvent;
  target.dispatchEvent(new Event('wallet-standard:register-wallet', { detail: register }));
  return () => {
    withdrawn = true;
    try { target.removeEventListener('wallet-standard:app-ready', onReady); } catch { /* the window is gone */ }
    for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
  };
}

/**
 * Open ①'s page `href` (same origin) in a new window and offer it the board's view of the key each time a document of
 * that page has loaded there (a reload is offered again); stops when the window is closed or the key ends.
 * → the window, or null (blocked). `open`, `timers` for tests.
 */
export function openBoardWithWallet(href, handle, { open = (...a) => globalThis.open?.(...a), timers = globalThis, every = 250, pagePath = null } = {}) {
  const wallet = coopRecordsWallet(handle);
  const win = open(href, '_blank');
  if (!win) return null;
  let doc = null, withdraw = null;
  const want = pagePath ?? new URL(href, globalThis.location?.href ?? 'http://localhost/').pathname;
  const tick = () => {
    let d = null, ok = false;
    try { d = win.document; ok = !win.closed && d?.readyState === 'complete' && win.location.pathname === want; } catch { ok = false; }
    if (win.closed || handle.destroyed) { withdraw?.(); withdraw = null; timers.clearInterval(timer); return; }
    if (ok && d !== doc) { withdraw?.(); doc = d; withdraw = offerWallet(wallet, win); }
  };
  const timer = timers.setInterval(tick, every);
  return win;
}

/**
 * The options hud/coopboard.mjs `installCoopBoard` takes in a launcher world: `{base, open}`, or null (not a launcher
 * world, or no key) — then the board is looked for on the page's own origin as before.
 */
export function localCoopBoardOptions({ herald, handle, launcher }) {
  if (launcher !== true || !handle || handle.destroyed) return null;
  const base = localBoardBase(herald);
  if (!base) return null;
  return { base, open: href => openBoardWithWallet(href, handle) };
}
