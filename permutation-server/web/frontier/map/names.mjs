// Names before coordinates (UX brief §5.3): what a selected place is called
// wherever a person reads it (the inspector's title, the map's live line, the
// hover tip). "ラマールの町 — アステル" first; "州 2,0" stays as the small
// print for those who want it.
//
// The names are read from the inspector's own model of the selection
// (hud/inspect.mjs inspectModel), which already follows the survey: a village
// the viewer has not surveyed has no name here either.
import { L } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { holdingName } from '../people/ui.mjs';

const TERRAIN_NAME = { Grassland: () => L`草原`, Plains: () => L`平原`, Forest: () => L`森`, Hills: () => L`丘`, Mountain: () => L`山`, Water: () => L`水` };

/** The name of a village with its nation: 「ラマールの町 — アステル」. */
export const villageLine = (place, tier, faction) => (Number.isInteger(faction) ? `${holdingName(place, tier ?? 0)} \u2014 ${factionName(faction)}` : holdingName(place, tier ?? 0));

/**
 * What the selection `m` (inspectModel's) is called: a village by its name
 * and nation, a camp or a Free City by what it is, the Concord by its name,
 * any other tile by its land, a province by its ring.
 */
export function placeName(m) {
  if (!m) return '';
  const t = m.tile, site = t?.site;
  if (site?.state === 'holding') return villageLine({ p: m.p, q: m.q, site: site.index }, site.tier, site.faction);
  if (t?.camp || site?.state === 'camp') return L`蛮族の野営地`;
  if (site?.state === 'freeCity') return L`自由都市`;
  if (t?.terrain && TERRAIN_NAME[t.terrain]) return TERRAIN_NAME[t.terrain]();
  if (!t && m.p === 0 && m.q === 0) return L`大協約`;
  return t ? L`州 ${m.p},${m.q}` : m.opened === false ? L`第${m.ring}輪（まだひらいていません）` : L`第${m.ring}輪の州`;
}

/** The small print: where it is, by its province (a tile's number is never shown on the play screen: UX brief §6). */
export const placeWhere = m => (!m ? '' : L`州 ${m.p},${m.q}`);
