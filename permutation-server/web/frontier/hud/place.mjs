// A place by its name (UX design 5.3: names instead of coordinates wherever
// a person reads): a tile is what stands on it — a village by its name, a
// barbarian camp, a Free City — else its terrain, with the province as the
// second thing. A tile's number is never shown on the play screen.
// From what the page already holds: the province envelopes (FS.provinces)
// and the rules module's terrain (FS.terrainOf, set by app.mjs at boot).
import { L } from '../../lang.mjs';
import { holdingName } from '../people/ui.mjs';

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

/** A tile's name with its province: 「蛮族の野営地（州 2,0）」. */
export const tilePlace = (FS, p, q, tile) => L`${tileName(FS, p, q, tile)}（州 ${p},${q}）`;
