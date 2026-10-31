// Wallet Standard in the browser, the minimum the mint page needs:
// discovery (both events of the standard), connect for a chain, and
// `signTransaction` of a legacy wire transaction. The same two events and
// feature names as permutation-server/web/wallet.mjs, without its i18n and
// session modules. Nothing here holds a key.
const wallets = new Set();
const listeners = new Set();
let current = null;

const api = Object.freeze({ register: (...ws) => { for (const w of ws) if (w && w.features) wallets.add(w); for (const f of listeners) f(); return () => ws.forEach(w => wallets.delete(w)); } });

export function start() {
  if (start.done) return; start.done = true;
  globalThis.addEventListener?.('wallet-standard:register-wallet', e => { try { e.detail?.(api); } catch (err) { console.error(err); } });
  try { globalThis.dispatchEvent?.(new CustomEvent('wallet-standard:app-ready', { detail: api })); } catch { /* no DOM */ }
}
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const registerLocal = w => api.register(w);

/** Why a wallet cannot be used for `chain`, or null. */
export function unsupported(w, chain) {
  if (!w.chains?.includes(chain)) return `does not offer ${chain}`;
  if (typeof w.features?.['standard:connect']?.connect !== 'function') return 'no standard:connect';
  if (typeof w.features?.['solana:signTransaction']?.signTransaction !== 'function') return 'no solana:signTransaction';
  return null;
}
export const list = chain => [...wallets].map(w => ({ wallet: w, name: String(w.name), icon: w.icon, why: unsupported(w, chain) }));

/** Connect `wallet` for `chain`; the account must be usable on that chain (a wallet on another network is refused here, before anything is built or signed). */
export async function connect(wallet, chain) {
  const why = unsupported(wallet, chain);
  if (why) throw Object.assign(new Error(`${wallet.name}: ${why}`), { code: 'WalletUnsupported' });
  let accounts;
  try { accounts = (await wallet.features['standard:connect'].connect())?.accounts; } catch (e) { throw rejection(e); }
  const account = [...(accounts?.length ? accounts : wallet.accounts ?? [])].find(a => !a.chains?.length || a.chains.includes(chain));
  if (!account) throw Object.assign(new Error(`${wallet.name} has no account for ${chain}; switch the wallet's network`), { code: 'WrongNetwork' });
  current = { wallet, account, chain };
  for (const f of listeners) f();
  return connected();
}
export const connected = () => (current ? { name: String(current.wallet.name), address: current.account.address, chain: current.chain } : null);
export async function disconnect() { const c = current; current = null; try { await c?.wallet.features['standard:disconnect']?.disconnect?.(); } catch { /* ignore */ } for (const f of listeners) f(); }

/** The connected account signs the wire transaction (other signatures may already be in place or empty); returns the wallet's wire bytes. */
export async function signTransaction(wire) {
  if (!current) throw Object.assign(new Error('no wallet connected'), { code: 'NoWallet' });
  let out;
  try {
    [out] = await current.wallet.features['solana:signTransaction'].signTransaction({ account: current.account, transaction: wire, chain: current.chain });
  } catch (e) { throw rejection(e); }
  if (!out?.signedTransaction) throw Object.assign(new Error('the wallet returned no transaction'), { code: 'WalletError' });
  return Uint8Array.from(out.signedTransaction);
}
const rejection = e => Object.assign(new Error(String(e?.message ?? e)), { code: e?.code === 4001 || /reject|denied|cancel|closed/i.test(String(e?.message ?? e)) ? 'WalletRejected' : 'WalletError', cause: e });
