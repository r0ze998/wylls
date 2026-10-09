// A place by its name (UX design 5.3: names instead of coordinates wherever
// a person reads): a tile is what stands on it — a village by its name, a
// barbarian camp, a Free City — else its terrain, with the province as the
// second thing. A tile's number is never shown on the play screen.
// From what the page already holds: the province envelopes (FS.provinces)
// and the rules module's terrain (FS.terrainOf, set by app.mjs at boot).
import { L } from '../../lang.mjs';
import { holdingName } from '../people/ui.mjs';
import { factionName } from '../fi18n.mjs';
import { ringOf, wedgeOf } from '../fgeo.mjs';
import { homeWedge } from '../fland.mjs';

export const TERRAIN_TEXT = { Grassland: () => L`草原`, Plains: () => L`平原`, Forest: () => L`森`, Hills: () => L`丘`, Mountain: () => L`山`, Water: () => L`水` };
export const terrainName = id => TERRAIN_TEXT[id]?.() ?? (id ? String(id) : null);

/**
 * What a tile is: `{kind: 'holding'|'camp'|'freeCity'|'land', name, terrain}`
 * (`name` null when nothing is known of it yet).
 */
export function tileWhat(FS, p, q, tile) {
  const prov = FS?.provinces?.get?.(`${p},${q}`)?.province ?? null;
  let t = null;
  try { t = FS?.terrainOf?.(p, q) ?? null; } catch { t = null; }
  const terrain = t && Number.isInteger(tile) ? terrainName(t.names?.[t.terrain?.[tile]]) : null;
  if (prov?.camp?.state === 1 && prov.camp.tile === tile) return { kind: 'camp', name: L`蛮族の野営地`, terrain };
  const sites = t?.sites ?? (prov ? Array.from(prov.sites ?? []) : []);
  const j = Number.isInteger(tile) ? sites.indexOf(tile) : -1;
  const m = j >= 0 ? prov?.siteMirror?.[j] : null;
  if (m?.state === 1) return { kind: 'holding', name: holdingName({ p, q, site: j }, m.tier ?? 0), terrain, site: j, faction: m.faction };
  if (m?.state === 3) return { kind: 'freeCity', name: L`自由都市`, terrain };
  return { kind: 'land', name: terrain, terrain };
}

/** A tile's name alone: 「蛮族の野営地」, 「ラマールの町」, 「森」; 「土地」 when nothing is known. */
export const tileName = (FS, p, q, tile) => tileWhat(FS, p, q, tile).name ?? L`土地`;

/** A tile's name with its province: 「蛮族の野営地（州 2,0）」 (for "details": the play screen reads the name alone). */
export const tilePlace = (FS, p, q, tile) => L`${tileName(FS, p, q, tile)}（州 ${p},${q}）`;

/** The nation on whose side of the frontier a province lies (its wedge), or null for the Concord. */
export function sideOf(p, q) {
  const w = wedgeOf(p, q);
  if (w === null) return null;
  for (let f = 0; f < 6; f++) if (homeWedge(f) === w) return f;
  return null;
}

/**
 * A province in words a person reads (UX design 11.13: names before coordinates; a province has no name of its
 * own): the Concord by its name; a province where the viewer has a village by that village, 「ラマールの町のある州」;
 * any other by the nation on whose side of the frontier it lies and its ring, 「シンダー方面・第2輪の州」. The
 * coordinates stay under "details" (`provinceCoords`). `own: false` skips the village form (for a line that already
 * names the village and says where it stands).
 */
export function provinceName(FS, p, q, { own: byVillage = true } = {}) {
  if (p === 0 && q === 0) return L`大協約`;
  const own = byVillage ? (FS?.holdings ?? []).find(h => h.p === p && h.q === q) : null;
  if (own) return L`${holdingName(own)}のある州`;
  const f = sideOf(p, q), d = ringOf(p, q);
  return f === null ? L`第${d}輪の州` : L`${factionName(f)}方面・第${d}輪の州`;
}

/** A province by its coordinates: the small print of "details". */
export const provinceCoords = (p, q) => L`州 ${p},${q}`;

/**
 * The painted village of a nation at a tier, as the map draws it (the same
 * sprites: art/holdings, named as map/sprites.mjs names them — tier, open or
 * walled, the nation's art name; a Stronghold is always walled). For the
 * village's card and the inspector: the player sees their own village, not
 * an icon. `null` for a nation or tier the art does not have.
 */
const PIC_NATIONS = ['ember', 'tide', 'lumen', 'iron', 'stone', 'verdant'];
const PIC_TIERS = ['hamlet', 'town', 'city', 'stronghold'];
export function villagePic(faction, tier = 0, { walls = false } = {}) {
  const n = PIC_NATIONS[faction], t = PIC_TIERS[Number(tier)] ?? PIC_TIERS[0];
  if (!n) return null;
  return new URL(`../art/holdings/@2x/${t}_${t === 'stronghold' || walls ? 'w' : 'o'}_${n}.webp`, import.meta.url).href;
}

/** The same village as the map draws it now (map/village.mjs), for a card's head: `{village: {faction, tier, walls}}`, or null for no nation. */
export const villageDrawn = (faction, tier = 0, { walls = false } = {}) => (Number.isInteger(faction) && faction >= 0 && faction < 6 ? { village: { faction, tier: Number(tier) || 0, walls: !!walls } } : null);
