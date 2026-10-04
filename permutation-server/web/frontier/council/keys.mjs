// The presenter's key on the council page (contract §9.2, §11.5 AC7: "It signs with the viewer's Frontier session
// key"). The page signs talk, ballot and call-read records with a citizen's in-game SESSION key, which acts inside the
// season and cannot move tokens from a wallet (fsession.mjs). Two ways to get it, both local to this browser:
//   1. paste the seat key file (`frontier-bots --export-seat-key`: JSON with `session_keypair_b58`), or a Wylls key
//      backup text, or 64 hex digits;
//   2. take the key the Frontier client saved in this browser's localStorage under `ps-fsession:<cluster>:<program>:
//      <season>:<wallet>` (the main client opened through the same origin leaves it there).
// The key is held in memory only and never stored by this page. The seat file also holds the WALLET keypair: this
// module reads the session key out of it and throws the rest away; no wallet secret is kept, shown or sent. No
// wallet address or key text is ever printed on the page (§9.4: no wallet or key text on screen).
//
// The Ed25519 primitive is injected (`keyFromSeed` of web/session.mjs, loaded lazily by main.mjs), so this module
// imports only aisocial.mjs and runs under node in the tests.
import { fromBase58, toBase58, fromHex } from './aisocial.mjs';

/** An unsuccessful answer `{ok:false, code}` (the codes are the page's own words, see lang.mjs `err.*` and `keys.err.*`). */
const refused = code => ({ ok: false, code });
export const STORE_PREFIX = 'ps-fsession:';
const HEX64 = /(?:^|[^0-9a-f])([0-9a-f]{64})(?![0-9a-f])/i;

/**
 * `parseKeyText(text)` → `{ok:true, seed (32 bytes), wallet|null, session|null, source}` or `{ok:false, code}` with code
 * 'empty' | 'format' | 'mismatch'. `session` is the base58 public key the file claims (checked when it can be).
 */
export function parseKeyText(text) {
  const s = String(text ?? '').trim();
  if (!s) return refused('empty');
  if (s.startsWith('{')) {
    let j;
    try { j = JSON.parse(s); } catch { return refused('format'); }
    if (!j || typeof j !== 'object' || typeof j.session_keypair_b58 !== 'string') return refused('format');
    let kp;
    try { kp = fromBase58(j.session_keypair_b58); } catch { return refused('format'); }
    if (kp.length !== 64) return refused('format');
    const seed = kp.slice(0, 32);
    const pub = toBase58(kp.slice(32));
    if (typeof j.session === 'string' && j.session !== pub) return refused('mismatch');
    return { ok: true, seed, wallet: typeof j.wallet === 'string' ? j.wallet : null, session: pub, source: 'seat-file' };
  }
  const m = s.match(HEX64);
  if (!m) return refused('format');
  const wallet = (s.match(/^Wallet:\s*([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/m) ?? [])[1] ?? null;
  const session = (s.match(/^Session:\s*([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/m) ?? [])[1] ?? null;
  return { ok: true, seed: fromHex(m[1].toLowerCase()), wallet, session, source: /^Wylls key/m.test(s) ? 'backup' : 'hex' };
}

/** The Frontier client's saved session keys for one season: `[{wallet, seedHex}]` (storage errors give an empty list). */
export function findSavedKeys(storage, { cluster, programId, seasonId }) {
  const prefix = `${STORE_PREFIX}${cluster}:${programId}:${seasonId}:`;
  const out = [];
  try {
    for (let i = 0; i < (storage?.length ?? 0); i++) {
      const k = storage.key(i);
      if (typeof k !== 'string' || !k.startsWith(prefix)) continue;
      const wallet = k.slice(prefix.length);
      const hex = storage.getItem(k);
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) && /^[0-9a-f]{64}$/i.test(hex ?? '')) out.push({ wallet, seedHex: hex.toLowerCase() });
    }
  } catch { /* storage unavailable */ }
  return out;
}

/**
 * Make the signer: `{wallet, publicKey, sign(bytes) → Promise<Uint8Array>}`, or `{ok:false, code}`. `keyFromSeed(seed)`
 * is web/session.mjs's (`{publicKey (base58), sign}`); it refuses a seed that is not 32 bytes. When the key's file
 * stated its public key, it must equal the one derived.
 */
export async function makeSigner(parsed, keyFromSeed) {
  if (!parsed?.ok) return refused(parsed?.code ?? 'format');
  if (typeof keyFromSeed !== 'function') return refused('nosubtle');
  let k;
  try { k = await keyFromSeed(parsed.seed); } catch { return refused('nosubtle'); }
  if (parsed.session && parsed.session !== k.publicKey) return refused('mismatch');
  if (!parsed.wallet) return refused('no_wallet');
  return { ok: true, wallet: parsed.wallet, publicKey: k.publicKey, sign: k.sign };
}

/** Which of the roster's people the signer is: 'seat' | 'ai' | 'other' (an AI key would be a mistake; the page refuses it, see signerRefusal). */
export function signerKind(index, signer) {
  const id = index.identify({ wallet: signer.wallet });
  return id.kind === 'seat' ? 'seat' : id.kind === 'ai' ? 'ai' : 'other';
}

/**
 * The refusal code for a signer the page must not use: 'ai_key' when its wallet is an AI citizen of the roster (the page
 * would sign origin-0 "human" records as that AI, and the roster would badge them as AI), else null. FB4: main.mjs calls
 * this when a key is adopted and again whenever the roster is (re)loaded.
 */
export function signerRefusal(index, signer) {
  return signer && signerKind(index, signer) === 'ai' ? 'ai_key' : null;
}

/**
 * Which saved Frontier key to use: only the presenter seat's. A saved key of any other wallet is never taken without
 * the person asking for it (they can paste it): `{ok:true, key}` | `{ok:false, code:'nosaved'|'noseat'}`.
 */
export function chooseSavedKey(found, index) {
  if (!Array.isArray(found) || !found.length) return refused('nosaved');
  const seat = index?.seat?.wallet;
  const key = seat ? found.find(k => k.wallet === seat) : null;
  return key ? { ok: true, key } : refused('noseat');
}

/** The faction the signer votes in, when the roster knows it (the seat); else null and the page asks the viewer. */
export function signerFaction(index, signer) {
  const id = index.identify({ wallet: signer.wallet });
  return id.kind === 'seat' || id.kind === 'ai' ? id.entry.faction : null;
}
