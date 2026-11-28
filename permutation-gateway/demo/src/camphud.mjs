// The walletless demo's camp markers (demo-npc-camps): a tent over every standing bandit camp of the in-page world, with
// its defenders, drawn over the page's map. Bundled into the page (src/page-app.mjs), so it shares the page's map; it
// reads the in-page world directly (`__wyllsDemo.world()` → `camps()`): no request, nothing signed, nothing the page's
// own code depends on.
//
// Why a marker of its own: the page draws a camp only on a tile in sight (map/sprites.mjs: survey level 3), and the
// demo's camps stand away from every village (web/frontier/democamps.mjs), so most are under the fog. The marker shows
// where each camp is and how many defend it — the map's tile card (in sight) adds its loot — so a first-time player can
// pick one (Q-NPC-7: the camps are shown through the fog).
import { FrontierMap } from '../../../permutation-server/web/frontier/map/fmap.mjs';
import { tileHex } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { project } from '../../../permutation-server/web/map.mjs';

const CSS = `
.demo-camp{position:fixed;z-index:2;pointer-events:none;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;font:700 11px/1 system-ui,sans-serif}
.demo-camp svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
.demo-camp span{margin-top:1px;padding:1px 4px;border-radius:4px;background:rgba(58,20,14,.9);color:#ffd9c2;white-space:nowrap}
`;

/** The tent (one colour: a neutral camp is no nation's). */
export const TENT_SVG = '<svg width="24" height="20" viewBox="0 0 24 20" aria-hidden="true"><path d="M12 1.5 1.5 18.5h21z" fill="#8a3b25" stroke="#3a140e" stroke-width="1.3" stroke-linejoin="round"/><path d="M12 6.5 8 18.5h8z" fill="#2a0f0a"/><path d="M12 1.5v-1" stroke="#3a140e" stroke-width="1.3"/></svg>';

/** The markers to draw: every standing camp of the world's camps record `[{p, q, tile, troops}]`. */
export const markersOf = rec => (rec?.v === 1 && Array.isArray(rec.camps) ? rec.camps.filter(c => c.up).map(c => ({ p: c.p, q: c.q, tile: c.tile, troops: c.troops })) : []);

/** Start the markers (once; the page's document). */
export function startCampHud(doc = globalThis.document) {
  if (!doc || doc.getElementById('demo-camp-style')) return;
  const style = doc.createElement('style');
  style.id = 'demo-camp-style'; style.textContent = CSS;
  doc.head.appendChild(style);
  const layer = doc.createElement('div');
  layer.id = 'demo-camps';
  doc.body.appendChild(layer);
  let map = null, last = [];
  // the page's map instance (its draw is wrapped once to learn it, as the goal card's flags do; the wraps chain)
  const P = FrontierMap.prototype, draw = P.draw;
  P.draw = function (...a) { map = this; return draw.apply(this, a); };
  function place() {
    if (!map || typeof map.project !== 'function' || !last.length) { if (layer.innerHTML) layer.innerHTML = ''; return; }
    const out = [];
    for (const c of last) {
      const h = tileHex(c.p, c.q, c.tile), w = project(h.q, h.r), s = map.project(w.x, w.y);
      // (not under the page's top bar, nor off screen)
      if (!s || !Number.isFinite(s.x) || s.x < 0 || s.y < 132 || s.x > innerWidth || s.y > innerHeight) continue;
      // (only where the map itself is on top: not over a drawer, a report, a card or the HUD — the markers take no
      //  pointer events, so the hit test sees what is under them)
      if (map.canvas && doc.elementFromPoint && doc.elementFromPoint(s.x, s.y - 8) !== map.canvas) continue;
      out.push(`<div class="demo-camp" data-camp="${c.p},${c.q},${c.tile}" style="left:${Math.round(s.x)}px;top:${Math.round(s.y)}px">${TENT_SVG}<span>${Number(c.troops)}</span></div>`);
    }
    const next = out.join('');
    if (layer.innerHTML !== next) layer.innerHTML = next;
  }
  async function poll() {
    try { const live = await globalThis.__wyllsDemo?.world?.(); last = markersOf(live?.camps ? live.camps() : null); } catch { /* the world is not made yet (or is reloading): the next poll */ }
  }
  setInterval(poll, 1000);
  poll();
  const frame = () => { try { place(); } catch { /* the map is being rebuilt */ } globalThis.requestAnimationFrame(frame); };
  globalThis.requestAnimationFrame(frame);
}
