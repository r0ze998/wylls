// The wide land's key (territory-video-3, owner 2026-11-24 on the territory recording: 「それは隠れてて見にくいな」 — the
// wide land's colours ARE the nation holding each province's keep, but nothing on the screen said which colour was whose).
//
// (territory-map, owner 2026-11-25 OQ-3: only the tiles players own are coloured now, and a province's holder is its keep's
// icon — the rows name the nations whose tiles are in the picture, and one line says what the keep's colour means.)
// A small legend over the map, beside the map tools, while the wide land is drawn: "Your nation" in the viewer's colour,
// each other nation whose land is DRAWN in this frame by colour and name, and "No nation" when unheld land is drawn.
// It lists only holders the map itself just painted (map/wideland.mjs paintWideLand → `holders`, read from the fogged
// land under the fog of war), so it never names a nation the player has not seen hold land. Markup only; no pointer
// events; the label pass steps around it (hud/insets.mjs NO_GO 'wide-legend'). The swatches are frontier.css classes in
// the land colours of palette.mjs NATION_LAND / NATION_DARK (a test holds the two together).
import { L } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { NATION_LAND, NATION_DARK } from '../palette.mjs';
import { NEUTRAL, NEUTRAL_LAND } from './wideland.mjs';
import { UNKNOWN_NATION, UNKNOWN_LAND, UNKNOWN_DARK } from './territorytiles.mjs';

export const WIDE_LEGEND_ID = 'wide-legend';
const nation = f => Number.isInteger(f) && f >= 0 && f < 6;

/**
 * (territory-map, owner 2026-11-25 items 5/6) The legend's rows for the land the map draws now: `nations` the nations
 * whose OWNED TILES stand in the picture (map/territorytiles.mjs paintTerritoryTiles; UNKNOWN_NATION: a player's tiles
 * whose nation the page does not know), `keeps` whether a keep held by a nation stands in it (its icon is in that
 * nation's colour: who holds the province), `faded` whether a remembered tile (last seen, out of sight now) is in it.
 * → `[{key, colour, edge, text}]`: the viewer's nation first, the other nations in their order, the land of an unknown
 * nation, the faded line, then the keep's line. Unowned land is not coloured, so it has no row.
 */
export function territoryLegendRows(nations, { viewer = null, keeps = false, faded = false } = {}) {
  const ns = [...new Set((Array.isArray(nations) ? nations : []).filter(h => nation(h) || h === UNKNOWN_NATION))];
  const rows = [];
  if (nation(viewer) && ns.includes(viewer)) rows.push({ key: `n${viewer}`, colour: NATION_LAND[viewer], edge: NATION_DARK[viewer], text: L`あなたの国（${factionName(viewer)}）` });
  for (const h of ns.filter(h => nation(h) && h !== viewer).sort((a, b) => a - b)) rows.push({ key: `n${h}`, colour: NATION_LAND[h], edge: NATION_DARK[h], text: factionName(h) });
  if (ns.includes(UNKNOWN_NATION)) rows.push({ key: 'unknown', colour: UNKNOWN_LAND, edge: UNKNOWN_DARK, text: L`国のわからないプレイヤーの土地` });
  // (territory-map-2, Q-TM-1 (b): a tile out of sight shows the owner it had when last seen, faded — said once when one is in the picture)
  if (faded && rows.length) rows.push({ key: 'faded', colour: null, edge: null, text: L`薄い色：前に見たときの持ち主（いまは見えていません）` });
  if (keeps) rows.push({ key: 'keep', colour: null, edge: null, text: L`城の色：その州を持つ国` });
  return rows;
}

/**
 * (before territory-map: the provinces were coloured by their keep's nation) The legend's rows for the `holders` drawn (nations 0–5, NEUTRAL 6) and the `viewer`'s nation (pure):
 * `[{key, colour, edge, text}]` — the viewer's nation first, then the other nations in their order, then no nation.
 * Empty when nothing was drawn.
 */
export function wideLegendRows(holders, viewer = null) {
  const hs = [...new Set((Array.isArray(holders) ? holders : []).filter(h => nation(h) || h === NEUTRAL))];
  const rows = [];
  if (nation(viewer) && hs.includes(viewer)) rows.push({ key: `n${viewer}`, colour: NATION_LAND[viewer], edge: NATION_DARK[viewer], text: L`あなたの国（${factionName(viewer)}）` });
  for (const h of hs.filter(h => nation(h) && h !== viewer).sort((a, b) => a - b)) rows.push({ key: `n${h}`, colour: NATION_LAND[h], edge: NATION_DARK[h], text: factionName(h) });
  if (hs.includes(NEUTRAL)) rows.push({ key: 'none', colour: NEUTRAL_LAND, edge: '#5d5848', text: L`どの国にも属さない土地` });
  return rows;
}

/**
 * Mounts the legend in `doc` (once): `{update(drawn, viewer), unmount()}`. `drawn` is the map's last wide-land paint
 * (`{holders, shown}`, or null when no wide land was drawn; `shown`, the holders of the land in the picture, wins when
 * present): the box is shown only when it has rows, and rewritten only when they change (many frames a second).
 */
export function mountWideLegend({ doc = globalThis.document, parent = null, onLang = null } = {}) {
  if (!doc?.createElement) return null;
  const box = doc.createElement('section');
  box.id = WIDE_LEGEND_ID; box.className = 'wide-legend'; box.hidden = true;
  box.setAttribute?.('aria-label', L`土地の持ち主`);
  (parent ?? doc.querySelector?.('main') ?? doc.body)?.append(box);
  let last = null, drawnNow = null, viewerNow = null;
  const write = () => {
    // (verify-pr205: the holders of the land in the picture, `shown`; `holders` is all the frame painted, margin included)
    // (territory-map: the nations whose owned tiles are in the picture, and the keeps' line when a nation's keep is)
    const rows = drawnNow ? territoryLegendRows(drawnNow.nations ?? [], { viewer: viewerNow, keeps: (drawnNow.keeps ?? []).length > 0, faded: (drawnNow.territory?.faded ?? 0) > 0 }) : [];
    const key = `${L`土地の持ち主`}|${rows.map(r => `${r.key}:${r.text}`).join(',')}`;
    if (key === last) return rows;
    last = key;
    box.hidden = rows.length === 0;
    box.setAttribute?.('aria-label', L`土地の持ち主`);
    box.textContent = '';
    if (!rows.length) return rows;
    const title = doc.createElement('p'); title.className = 'wide-legend-title'; title.textContent = L`土地の持ち主`;
    const list = doc.createElement('ul'); list.className = 'wide-legend-rows';
    for (const r of rows) {
      const li = doc.createElement('li'); li.className = 'wide-legend-row'; if (li.dataset) li.dataset.key = r.key;
      // (the swatch's colours are classes of frontier.css, no inline style: .wide-legend-swatch[data-key])
      const sw = doc.createElement('span'); sw.className = 'wide-legend-swatch'; sw.setAttribute?.('data-key', r.key);
      const tx = doc.createElement('span'); tx.className = 'wide-legend-text'; tx.textContent = r.text;
      li.append(sw, tx); list.append(li);
    }
    box.append(title, list);
    return rows;
  };
  const unlang = typeof onLang === 'function' ? onLang(() => { last = null; write(); }) : null;
  return {
    el: box,
    update(drawn, viewer = null) { drawnNow = drawn ?? null; viewerNow = viewer; return write(); },
    unmount() { unlang?.(); box.remove?.(); },
  };
}
