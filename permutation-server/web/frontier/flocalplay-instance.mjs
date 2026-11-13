// LOCAL PLAY — the launcher world's automatic end, CONFIRMED before it is shown (a read; nothing else).
//
// The launcher states a world's end with the runner instance it believes the world runs on (`expiry`, kept from its
// start answer). That statement alone is never shown as the end: its own `instance` proves nothing. The end is shown
// only when the relay of THIS page's verified herald (same origin, `/gw`) answers the context route's read-only
// instance schema with exactly `{wallet, instance}` — the page's own wallet, and the instance the runner itself stated
// in that answer (the relay checks it against its pin; see local-play-act.mjs `LOCAL_ACT_INSTANCE_SCHEMA`) — and that
// instance is the statement's. Then `expiryView` decides as before.
// Every other case leaves the end unknown and changes nothing else: an older relay (its context route refuses the
// schema), no economy routes (404), no pinned instance, a failure or timeout, a malformed or longer answer, another
// wallet or instance. It is ONE bounded same-origin POST after the world was verified, never repeated by itself; it
// starts, stops, extends or makes nothing and never asks for a signature. The page going away or becoming another
// wallet or herald while it is awaited drops the answer (`still()`), and a notice whose key was discarded shows none.
import { expiryView } from './flocalplay-expiry.mjs';

export const WORLD_INSTANCE_PATH = '/gw/f/local-play/act/context';
export const WORLD_INSTANCE_SCHEMA = 'frontier-local-play-act-instance-v1';
export const WORLD_INSTANCE_TIMEOUT_MS = 8000;
const HEX64 = /^[0-9a-f]{64}$/;
const exact = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));

/**
 * The runner instance the relay confirms for `wallet`, or null. `origin`: the verified herald's exact origin.
 * `request`: the page's fetch (tests pass a stub).
 */
export async function readWorldInstance({ origin, wallet, request, timeoutMs = WORLD_INSTANCE_TIMEOUT_MS }) {
  let exactOrigin = null;
  try { exactOrigin = new URL(origin).origin; } catch { return null; }
  if (exactOrigin !== origin || typeof wallet !== 'string' || wallet === '' || typeof request !== 'function') return null;
  const abort = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await request(`${origin}${WORLD_INSTANCE_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: WORLD_INSTANCE_SCHEMA }), signal: abort.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
        if (abort.signal.aborted || !response?.ok) return null;
        const body = await response.json();
        if (abort.signal.aborted) return null;
        if (!exact(body, ['wallet', 'instance']) || body.wallet !== wallet || typeof body.instance !== 'string' || !HEX64.test(body.instance) || /^0{64}$/.test(body.instance)) return null;
        return body.instance;
      })(),
      new Promise(resolve => { timer = setTimeout(() => { abort.abort(); resolve(null); }, Math.max(1, Math.min(WORLD_INSTANCE_TIMEOUT_MS, timeoutMs))); }),
    ]);
  } catch { return null; } finally { clearTimeout(timer); abort.abort(); }
}

/**
 * After the gate verified a launcher world: confirm its end and hand the view to `notice.showEnd` (the standing
 * notice). `expiry`: the launcher's statement as kept. `still()`: whether the page is still that wallet and herald.
 * → the view handed on, or null when nothing was handed on.
 */
export async function confirmWorldEnd({ expiry, origin, wallet, request, notice, still = () => true, now = () => Date.now(), timeoutMs }) {
  if (!notice || typeof notice.showEnd !== 'function') return null;
  // (only a well-formed statement that names an instance is worth asking about; this uses the statement's own instance
  //  to decide whether to ASK, never as confirmed)
  if (expiryView(expiry, expiry?.instance ?? null, now()).state !== 'known') return null;
  const instance = await readWorldInstance({ origin, wallet, request, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  if (!still() || notice.isDestroyed?.()) return null;
  const view = expiryView(expiry, instance, now());
  notice.showEnd(view);
  return view;
}
