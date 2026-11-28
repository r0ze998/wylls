// TEST-ONLY capture demo: the fort the demo PREPARED, as this page's launcher names it (fix-lp29-fog-fort; owner r0ze
// 2026-11-28 09:05, Q-LP29-1 (b)).
//
// The demo (`--demo`, `--demo --two`) opens a ring and prepares ONE keep of another nation that the player's march can
// reach (itest capture_demo.rs, its `ready` line). Under the fog of a local test world that keep is usually out of sight,
// so neither the guide nor the keep list named it and the player had to tap an unknown blank tile (loop-play29 BREAK-2).
// The owner's answer: in demo worlds only, the guide and the keep list may NAME the prepared fort even under the fog; its
// defender count stays hidden until the fort is in sight. This module is that exception's whole state:
//   - `demoFortView`  checks the launcher's answer (mode, the world this page verified at its start, every number);
//   - `setDemoFort` / `demoFortNow` hold the one fort (null on every other page: a world that is not a demo, devnet, the
//     walletless Pages demo — nothing there ever sets it);
//   - `startDemoFortAsks` asks the launcher a bounded number of times, spaced, until the demo has chosen its fort (the
//     demo chooses it some minutes after the player's first village; the answer never changes once given), then stops.
// What may pass the fog is decided in map/fog.mjs `guideKeeps`. This module makes no request itself, stores nothing,
// and imports nothing.

export const DEMO_FORT_MODE = 'capture-demo-fort-v1';
/** How often (ms) and how many times the page asks before the demo has chosen its fort: 15 s × 120 = 30 min. */
export const DEMO_FORT_SPACING_MS = 15000, DEMO_FORT_TRIES = 120;

const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const pq = v => int(v, -1000, 1000);

/**
 * The launcher's `/local-play/demo-fort` answer, checked again here (fail closed): the mode, the WORLD it is about
 * (`scope`: the herald and the end this page verified at its own start, that end not yet reached at `nowMs`) and every
 * number. → `{state: 'pending'}`, `{state: 'ready', fort: {p, q, tile}, holder}` or `{state: 'unavailable'}`.
 */
export function demoFortView(body, scope, nowMs) {
  const d = body?.demoFort, t = d?.target;
  if (!d || typeof d !== 'object' || d.mode !== DEMO_FORT_MODE || !t || typeof t !== 'object') return { state: 'unavailable' };
  const w = d.world, e = w?.expiry, mine = scope?.expiry;
  const sameWorld = w && typeof w === 'object' && typeof scope?.herald === 'string' && w.herald === scope.herald && e && typeof e === 'object' && mine && typeof mine === 'object'
    && typeof mine.instance === 'string' && mine.instance.length > 0 && ['schema', 'instance', 'startedAt', 'ttlMs', 'expiresAt'].every(k => e[k] === mine[k])
    && Number.isFinite(e.expiresAt) && Number.isFinite(nowMs) && nowMs < e.expiresAt;
  if (!sameWorld) return { state: 'unavailable' };
  if (t.state === 'pending') return { state: 'pending' };
  if (t.state !== 'ready' || !t.fort || typeof t.fort !== 'object' || !pq(t.fort.p) || !pq(t.fort.q) || !int(t.fort.tile, 0, 60) || !int(t.holder, 0, 5)) return { state: 'unavailable' };
  return { state: 'ready', fort: { p: t.fort.p, q: t.fort.q, tile: t.fort.tile }, holder: t.holder };
}

let fort = null;
const listeners = new Set();
/** The demo's prepared fort `{p, q, tile, holder}` (frozen), or null — always null outside a capture-demo launcher world. */
export const demoFortNow = () => fort;
/** Sets (a checked `demoFortView` 'ready' answer) or clears (null) the fort; listeners hear a change. */
export function setDemoFort(view) {
  const next = view && view.state === 'ready' && view.fort && pq(view.fort.p) && pq(view.fort.q) && int(view.fort.tile, 0, 60) && int(view.holder, 0, 5)
    ? Object.freeze({ p: view.fort.p, q: view.fort.q, tile: view.fort.tile, holder: view.holder }) : null;
  if ((next === null && fort === null) || (next && fort && next.p === fort.p && next.q === fort.q && next.tile === fort.tile && next.holder === fort.holder)) return;
  fort = next;
  for (const f of listeners) { try { f(fort); } catch { /* a listener's fault is its own */ } }
}
/** `fn(fort)` on each change; → its removal. */
export function onDemoFort(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Whether keep `k` (p, q, tile) is the demo's prepared fort. */
export const isDemoFort = k => !!fort && !!k && k.p === fort.p && k.q === fort.q && k.tile === fort.tile;

/**
 * Asks `ask()` (→ a `demoFortView` answer, or `{state: 'stop'}` once the page is another wallet, lost its key, or the
 * launcher says the world is gone or is no demo) at once and then every `spacingMs`, at most `tries` times, one at a time:
 * 'ready' → `set(view)` and stop; 'pending' / 'unavailable' → ask again later; 'stop' → stop. → `stop()`.
 */
export function startDemoFortAsks({ ask, set = setDemoFort, timer = setTimeout, clear = clearTimeout, spacingMs = DEMO_FORT_SPACING_MS, tries = DEMO_FORT_TRIES } = {}) {
  let left = tries, handle = null, over = typeof ask !== 'function';
  const stop = () => { over = true; if (handle !== null) { clear(handle); handle = null; } };
  const once = async () => {
    handle = null;
    if (over || left <= 0) return stop();
    left -= 1;
    let v = null;
    try { v = await ask(); } catch { v = { state: 'unavailable' }; }
    if (over) return;
    if (v?.state === 'ready') { set(v); return stop(); }
    if (v?.state === 'stop' || left <= 0) return stop();
    handle = timer(once, spacingMs);
  };
  once();
  return stop;
}
