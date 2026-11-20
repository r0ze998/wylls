// DEVNET PLAY (devnet-page-war) — the page's MARCH BOOK on a devnet season, kept ENCRYPTED in this browser.
//
// A sealed march's reveal half (its plaintext and salt; never the IBE key k or σ — marchbook.mjs `entryOf`) is the
// only secret the page holds on devnet: the wallet holds the key, the chain holds the seal. It stays private until
// T(arrive) is published (after that the seal opens for anyone, and keeper A reveals from the public round itself);
// the page hands it to the keeper (`POST /gw/f/reveal` → keeper A's `/v1/reveal`) only once T(arrive) is published
// (controller.mjs readMarches, ⑱), so a keeper that missed the round can still reveal inside the window.
//
// The book is the kept-world pattern of local play's persisted TEST worlds (flocalplay-keystore.mjs `openSealedBook`),
// in its own IndexedDB database: a NON-EXTRACTABLE AES-GCM-256 key (WebCrypto, `extractable = false`, stored by
// structured clone: no script can read or export it, before or after a reload), the book encrypted with it, a fresh
// 96-bit IV per write, the book's scope as additional data. One book per (program, Season, wallet): the scope names
// all three. A reload of the page, or a new tab of the same origin, reads the same book. Nothing is written to
// localStorage, a cookie, a URL or the console. (The ordinary page keeps the book in plain localStorage,
// marchbook.mjs `browserStorage`: devnet play replaces that, nothing else.)
//
// What non-extractable does not do: a script of the same origin may still USE the key while the page runs (decrypt
// the book). The reveal half is a secret for at most one turn and grants nothing but an early reveal.
import { openKeyStore, openSealedBook } from './flocalplay-keystore.mjs';

export const DEVNET_BOOK_DB = 'wylls-devnet-play-v1';
/** The book's scope: the devnet program, the Season account and the wallet (all base58). */
export const devnetBookScope = ({ programId, seasonAddress }) => `devnet-play-book:${programId}:${seasonAddress}`;

/**
 * Opens the devnet march book of `wallet` for the verified devnet play `dp` (fdevnetplay.mjs): → `{storage, flush,
 * wallet, scope}` (`storage` is the march book's synchronous shape, reads from memory, every write encrypted through in
 * order; `flush()` resolves once every write so far is kept). Throws `NoIndexedDB` / `StoredBookInvalid`.
 */
export async function openDevnetBook(dp, wallet, { idb = globalThis.indexedDB, subtle, random } = {}) {
  const store = await openKeyStore({ idb, db: DEVNET_BOOK_DB });
  const scope = devnetBookScope(dp);
  const book = await openSealedBook(store, scope, wallet, { ...(subtle ? { subtle } : {}), ...(random ? { random } : {}) });
  return Object.freeze({ storage: book.storage, flush: book.flush, wallet, scope });
}
