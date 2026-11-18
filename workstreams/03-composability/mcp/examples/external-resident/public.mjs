// What the external resident reads, and how it sends: the SAME public routes a page uses, through its own world proxy.
// KEY-FREE (signing is the caller's `signer`). Nothing here is privileged: the herald's public `/h/*`, the relay's
// public `/gw/f/local-play/info`, and the page's own page-signed economy (`/gw/f/local-play/act/*`, built and checked by
// the page's own flocalplay-act.mjs). The proxy admits a write only from the launcher page's Origin, which a page sends
// by itself; this client states the same Origin (it is a page-equivalent client of that launcher, not an operator).
import { decodePrefix } from '../../../../../permutation-server/web/frontier/fcodec.mjs';
import { createHerald } from '../../../../../permutation-server/web/frontier/herald.mjs';
import { seasonPlace, homeSites } from '../../../../../permutation-server/web/frontier/home.mjs';
import { ringOf, homeNation } from '../../../../../permutation-server/web/frontier/fgeo.mjs';
import { postLocalAct } from '../../../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { parseTransaction, wireTransaction } from '../../../../../permutation-server/web/sdk/solana-tx.mjs';

const loopback = u => { try { const x = new URL(u); return x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname); } catch { return false; } };
export async function getJson(url, { fetch: f = globalThis.fetch, ms = 5000 } = {}) {
  if (!loopback(url)) throw new Error('loopback only');
  const r = await f(url, { signal: AbortSignal.timeout(ms), redirect: 'error' });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.json();
}

/**
 * The launcher's own page route, as a page presses it: `POST /local-play/start {wallet}` (public address only), with
 * the launcher page's Origin. → its answer (`{herald, external: {role: 'resident'}}` once admitted to a running world;
 * `{residentWaiting: true}` before).
 */
export async function askWorld(launcher, wallet, { fetch: f = globalThis.fetch } = {}) {
  if (!loopback(launcher)) throw new Error('loopback only');
  const r = await f(`${launcher}/local-play/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: launcher }, body: JSON.stringify({ wallet }), signal: AbortSignal.timeout(240000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.error ?? `HTTP ${r.status}`), { status: r.status, code: j?.error });
  return j;
}

/** `GET /h/me/{wallet}` → `{joined, faction, holding}` (decoded with the page's codec), or null when unreadable. */
export function selfView(me) {
  if (!me || typeof me !== 'object' || me.v !== 1) return null;
  if (me.citizen === null) return { joined: false, faction: null, holding: null };
  let c; try { c = decodePrefix('Citizen', Buffer.from(String(me.citizen?.bytes_b64 ?? ''), 'base64'), { profile: 2 }); } catch { return null; }
  const faction = Number(c?.faction); if (!Number.isInteger(faction)) return null;
  for (const row of Array.isArray(me.holdings) ? me.holdings : []) {
    try {
      const h = decodePrefix('Holding', Buffer.from(String(row?.bytes_b64 ?? ''), 'base64'), { profile: 2 });
      const p = Number(h.p), q = Number(h.q), site = Number(h.site), tile = Number(h.tile);
      if ([p, q, site].every(Number.isSafeInteger)) return { joined: true, faction, holding: { p, q, site, ...(Number.isInteger(tile) && tile >= 0 && tile <= 60 ? { tile } : {}) } };
    } catch { /* not a holding this rule reads */ }
  }
  return { joined: true, faction, holding: null };
}

/** The chain's clock as the herald saw it last (`/h/status` live[1]), as the page counts rule times. */
export const chainSecondsOf = s => { const t = Array.isArray(s?.live) ? Number(s.live[1]) : NaN; return Number.isSafeInteger(t) && t > 0 ? t : null; };

/**
 * Free first-home sites of `faction`, read as the page reads them: the Season (placement, heartland), then each
 * heartland province of that nation (rings 2..heartlandMaxRing) from `/h/province/P,Q/latest`, its free sites by the
 * page's own `homeSites`. → `[{p, q, site}]`, nearest ring first. A province the herald does not serve is skipped.
 */
export async function publicHomes(heraldBase, faction, { fetch: f = globalThis.fetch, max = 12 } = {}) {
  const h = createHerald({ base: heraldBase, fetch: (...a) => f(...a) });
  const s = await h.season();
  if (!s.ok) return [];
  const place = seasonPlace(s.season), hmr = Number(place?.heartlandMaxRing ?? s.season?.conquestParams?.heartlandMaxRing ?? 3);
  const out = [];
  for (let r = 2; r <= hmr && out.length < max; r++) {
    for (let p = -r; p <= r && out.length < max; p++) for (let q = -r; q <= r && out.length < max; q++) {
      if (ringOf(p, q) !== r || homeNation(p, q, place) !== faction) continue;
      const pv = await h.province(p, q);
      if (!pv.ok || !pv.province) continue;
      for (const x of homeSites(pv.province, { faction, place })) out.push({ p: x.p, q: x.q, site: x.site });
    }
  }
  return out;
}

/**
 * The page's `post` for `/gw/f/local-play/act/*` with the launcher page's Origin (what a browser adds by itself).
 * `onRefusal(answer)`: the relay's refusal body, for the log.
 */
export const pagePost = (launcherOrigin, { fetch: f = globalThis.fetch, onRefusal = () => {} } = {}) => (origin, path, body) => postLocalAct(origin, path, body, { fetch: async (url, init) => {
  const res = await f(url, { ...init, headers: { ...init.headers, origin: launcherOrigin } });
  if (!res.ok) { try { onRefusal(await res.clone().json()); } catch { /* not JSON */ } }
  return res;
} });

/** The key as the page's local-play signer looks (wallet-standard shape): signs exactly the one transaction it is handed, of this address only. */
export function walletShaped(key) {
  const account = Object.freeze({ address: key.address });
  return Object.freeze({
    destroyed: false, address: key.address,
    wallet: Object.freeze({ features: Object.freeze({
      'standard:connect': Object.freeze({ connect: async () => ({ accounts: [account] }) }),
      'solana:signTransaction': Object.freeze({ signTransaction: async ({ transaction }) => {
        const tx = parseTransaction(Uint8Array.from(transaction));
        if (tx.signers.length !== 1 || tx.signers[0] !== key.address) throw new Error('not my transaction: one signer, me');
        return [{ signedTransaction: wireTransaction(tx.message, [key.signMessage(tx.message)]) }];
      } }),
    }) }),
  });
}
