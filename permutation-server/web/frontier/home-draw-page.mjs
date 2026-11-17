// The provisional first-village draw page (2026-11-18): NOT PRODUCTION, NOT ENABLED.
//
// Off unless BOTH hold: the page is on a loopback host (config.mjs `dev`) and its address carries
// `?provisional=home-draw`. Otherwise it says so and reads nothing. It is not linked from the play page and does not
// replace the normal join: it never imports the controller, the join or home placement (confirmHome, PlaceHome), the
// wallet, a signer or a sender. Reads are the herald's GETs only (/h/season, /h/overview/{ring}, /h/province/{P},{Q}).
// The wallet is an address the visitor types; it is only the draw's citizen key and is never asked to sign.
import { config } from './config.mjs';
import { createHerald } from './herald.mjs';
import { worldOf, contiguousRings } from './map/world.mjs';
import { bellAt } from './clock.mjs';
import { seasonPlace } from './home.mjs';
import { drawRings, PROVISIONAL_PARAMS } from './fhome-draw.mjs';
import { createDrawView } from './fhome-draw-view.mjs';
import { homeDrawHtml } from './screens/home-draw.mjs';

export const GATE_PARAM = 'provisional', GATE_VALUE = 'home-draw';
/** Up to this many ring overviews in flight at once. */
const IN_FLIGHT = 4;

/** Whether the page may run: a loopback page with the explicit flag. Nothing else switches it on. */
export function gateOpen(loc = globalThis.location, cfg = config(loc)) {
  if (!cfg?.dev) return false;
  try { return new URL(loc?.href ?? '').searchParams.get(GATE_PARAM) === GATE_VALUE; } catch { return false; }
}

// A world's key changes the page's generation of it, so an answer for an earlier pin of the same Season is not the
// same world (A → B → A are three).
function worldTracker() {
  let last = null, gen = 0;
  return rec => {
    const k = [rec?.cluster, rec?.programId, rec?.season].map(x => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('|');
    if (k !== last) { last = k; gen++; }
    return { cluster: rec?.cluster, programId: rec?.programId, seasonId: rec?.season, gen };
  };
}

async function readRings(herald, rings) {
  const out = new Map(), queue = [...rings];
  const worker = async () => { for (let d = queue.shift(); d !== undefined; d = queue.shift()) { try { out.set(d, await herald.overview(d)); } catch { out.set(d, null); } } };
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, rings.length) }, worker));
  return out;
}

export async function start(doc = globalThis.document, loc = globalThis.location) {
  const root = doc.getElementById('home-draw-root');
  if (!root) return;
  const cfg = config(loc, doc);
  if (!gateOpen(loc, cfg)) { root.textContent = 'This test page is not switched on.'; return; }
  const herald = createHerald({ base: cfg.herald });
  const view = createDrawView();
  const worldOfRecord = worldTracker();
  const paint = () => { const out = doc.getElementById('home-draw-out'); if (out) out.innerHTML = homeDrawHtml(view.state()); };
  root.innerHTML = '<form id="home-draw-form"><label>Wallet address <input id="home-draw-wallet" autocomplete="off" spellcheck="false" size="48"></label> <button type="submit">Draw</button></form><div id="home-draw-out"></div>';
  const input = doc.getElementById('home-draw-wallet');
  input.addEventListener('input', () => { view.setWallet(input.value.trim()); paint(); });
  doc.getElementById('home-draw-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    view.setWallet(input.value.trim());
    const s = await herald.season();
    if (!s.ok) { view.setWorld(null); paint(); return; }
    herald.pin(s.record.season);
    view.setWorld(worldOfRecord(s.record));
    paint();
    const extent = worldOf(s.record), contiguous = contiguousRings(extent);
    const rings = drawRings(extent, contiguous, PROVISIONAL_PARAMS);
    const overviews = rings ? await readRings(herald, rings.drawn) : new Map();
    // the herald's own time (latestUnix), never this device's clock
    const t = Number(s.record.latestUnix), g = Number(s.record.genesisTs);
    const nowBell = Number.isSafeInteger(t) && Number.isSafeInteger(g) && t > 0 ? bellAt(g, t) : null;
    await view.ask({ season: s.season, record: s.record, extent, contiguous, overviews, nowBell,
      readProvince: (p, q) => herald.province(p, q), place: seasonPlace(s.season), faction: null });
    paint();
  });
  paint();
}

if (globalThis.document && globalThis.location) start().catch(() => {});
