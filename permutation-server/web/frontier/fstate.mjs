// The Frontier page's store and render scheduler (the pattern of v9's
// state.mjs, which is v9-shaped and stays untouched). Update code changes
// FS and calls invalidate('part', …); each part re-renders once, in the
// order registered, at the end of the current task. Renderers only read FS
// and write the DOM; one failing renderer never stops the others. A
// language switch re-renders every part.
import { onLangChange } from '../lang.mjs';

export const FS = {
  // ---- pins and the season (fchainio.setPin, herald.season)
  mode: 'play',          // 'play' | 'practice' | 'spectate'
  pin: null,             // {programId, cluster, seasonId, addresses}
  record: null,          // the herald's season record (JSON conveniences: display only)
  season: null,          // the Season account, decoded from its bytes
  beacon: null,          // checkBeacon() result: {ok, kind: 'quicknet'|'test'}
  // ---- time
  chain: null,           // ChainClock
  clock: null,           // seasonClock(season)
  // ---- the viewer
  wallet: null,          // connected wallet (wallet.mjs shape) or null
  session: null,         // fsession key or null
  citizen: null,         // decoded Citizen or null
  holdings: [],          // decoded Holdings
  meStatus: 'loading',   // loading | ready | error: an unread account is never "not joined"
  meError: null,
  meAnswered: false,     // the viewer's record answered at least once (found or "not joined"); reset with the viewer
  homeChoice: null,      // decoded land candidates and current selected site
  homeGrant: null,       // confirmed first holding, until the player starts building
  // ---- the viewer's wide (captured, unverified) inventory: never inside `holdings` (fwide.mjs)
  wideHoldings: null,    // parseWideInventory's result, or null while unknown
  wideStatus: 'loading', // loading | ready | unavailable | error: an unread inventory is never "no wide villages"
  wideError: null,
  wideSelect: null,      // {inventorySlot, key} of the wide village the village screen shows, or null (the legacy one)
  expeditionCompose: null, // isolated geometry/plaintext preparation, never an executable march
  expeditionPreview: null, // isolated read-only original-host inspection; never a map location, order or history
  conquest: null,        // v3 territory controls and authoritative nation score
  homeFocus: null,       // one-shot camera request; no ownership is inferred from it
  book: [],              // marchbook entries
  // ---- the map
  overviews: new Map(),  // ring → decoded overview
  overviewTaken: new Map(), // ring → the Province count the season record showed when its overview was taken (map/world.mjs overviewRings)
  overviewsBooted: false, // the boot's own overview load is done: later season polls load the rings that newly want one
  world: null,           // the world's extent from the season record (map/world.mjs worldOf): set by applySeasonRecord only
  worldRings: null,      // ring → Set of "p,q" on chain, for a ring only partly created (map/world.mjs)
  provinces: new Map(),  // "P,Q" → parsed envelope
  view: { lod: 'world', fog: true, showAll: false },
  selected: null,        // {kind: 'province'|'tile', p, q, idx?}
  // ---- status
  error: null,           // {code, text}
  stale: { behind: null, stale: false },
};

/** The holding the play screens act on: the one chosen in the rail (FS.activeHolding), else the first. */
export function activeHolding(fs = FS) {
  const hs = fs.holdings ?? [];
  const i = Number.isInteger(fs.activeHolding) && fs.activeHolding >= 0 && fs.activeHolding < hs.length ? fs.activeHolding : 0;
  return hs[i] ?? null;
}

const renderers = new Map();
const dirty = new Set();
let scheduled = false;
/**
 * A render that invalidates is rendered again in the next microtask. When every render invalidates (a countdown that
 * has run out in a part of the page that is not drawn again, an order refused at once on every draw), that is a chain
 * of microtasks with no end: the page's task never finishes, nothing is painted or clicked, and the tab stands still
 * with its last picture. So: after FLUSH_STREAK renders in one task with no pause between them, the following ones
 * are asked for with a timer for FLUSH_STORM_MS (FLUSH_PACE_MS apart): the page stays alive, and the parts that
 * keep asking are named once in the console. Renders that settle, as all of the page's own do, never get there.
 */
export const FLUSH_STREAK = 24, FLUSH_STORM_MS = 2000, FLUSH_PACE_MS = 16;
let streak = 0, streakTimer = false, stormUntil = 0, stormTold = false;
const clockNow = () => globalThis.performance?.now?.() ?? Date.now();

/** Register renderers as [name, fn] pairs; they run in this order. */
export function registerRenderers(list) { for (const [name, fn] of list) renderers.set(name, fn); }

/** Mark parts for re-render ('all' for every part). */
export function invalidate(...parts) {
  for (const p of parts) {
    if (p === 'all') for (const k of renderers.keys()) dirty.add(k);
    else dirty.add(p);
  }
  if (scheduled) return;
  scheduled = true;
  if (streak >= FLUSH_STREAK && stormUntil <= clockNow()) {
    stormUntil = clockNow() + FLUSH_STORM_MS;
    if (!stormTold) { stormTold = true; try { console.warn(`render loop: ${[...dirty].join(', ')} asked to be drawn again ${streak} times without a pause; drawing by timer`); } catch { /* no console */ } }
  }
  if (stormUntil > clockNow()) setTimeout(flush, FLUSH_PACE_MS); else queueMicrotask(flush);
}
/** (tests) Whether renders are paced by a timer now, and the count of renders in the current task. */
export const flushState = () => ({ storm: stormUntil > clockNow(), streak });
export const invalidateAll = () => invalidate('all');
onLangChange(invalidateAll);

/** Run the renderers of the invalid parts now. */
export function flush() {
  scheduled = false;
  // (renders counted in this task: the timer below runs once the task ends, so only a chain with no pause adds up)
  streak++;
  if (!streakTimer) { streakTimer = true; setTimeout(() => { streakTimer = false; streak = 0; }, 0); }
  for (const [name, fn] of renderers) {
    if (!dirty.delete(name)) continue;
    try { fn(FS); } catch (e) { console.error(`render ${name}:`, e); }
  }
}
