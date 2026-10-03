// Loaded before app.mjs on the game page (the herald's --inject-script puts it there): offers the
// playtest guest key as a wallet and puts the invitation the friend arrived with into the join form.
// Plain and small on purpose; the game's own files are not touched.
import { createKey, GUEST_NAME, guestWallet, INVITE_KEY, readKey, register, store } from './guestkey.mjs';

async function wallet() {
  const have = readKey() ?? (await createKey()).key; // a friend who skipped the start page still gets a key
  register(guestWallet(have));
  // The game reconnects silently to the wallet it used last (wallet.mjs lastWalletName): a friend with no
  // other wallet goes straight to choosing a nation, with no "connect a wallet" step.
  try { if (!globalThis.localStorage.getItem('ps-wallet')) globalThis.localStorage.setItem('ps-wallet', GUEST_NAME); } catch { /* storage blocked */ }
}
wallet().catch(e => console.warn(`${GUEST_NAME}: not available (${e?.message ?? e})`));

// The invitation from the start page, in the join form's field (the page reads FS.joinDraft.invite).
const invite = store.get(INVITE_KEY);
if (invite) {
  import('../fstate.mjs').then(({ FS }) => { FS.joinDraft = { ...(FS.joinDraft ?? {}), invite }; }).catch(() => {});
}
