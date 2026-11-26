// LOCAL PLAY, TEST-ONLY — operator AI residents: the resident's OWN LAND as the herald captured it (owner-answers-logic,
// owner 2026-11-26 10:52 Q-LP19-1 (a); no rule change). Key-free, reads only: beside the food per hour of its first home
// (the caller's, local-play-operator-residents.mjs foodMilliPerHourAt), its own territory summary (herald GET /h/world/wide/territory/player/<its
// own Citizen>) and — only when the summary counts fewer tiles than it remembers — the territory tiles (GET
// /h/world/wide/territory), so the policy (local-play-operator-policy.mjs landTooDear / pruneOwnTiles) can skip a far
// target whose tile upkeep is more than the food surplus and forget the tiles the world let go.
import { heraldTerritoryPlayer, heraldTerritoryRecords, citizenTagOf } from '../../../permutation-server/web/frontier/flocalplay-territory.mjs';

/**
 * (owner-answers-logic, Q-LP19-1 (a)) The resident's own land as the herald captured it, for the policy: `{land, records}`
 * — `land` `{foodMilliPerHour, upkeepMilliPerHour, tiles}` (null when the summary or the food rate is unreadable; a
 * Citizen that never claimed a tile pays 0), `records` the territory tiles (heraldTerritoryRecords), asked for only when
 * the summary counts FEWER tiles than the resident remembers (a tile was let go). FOG RULE: its own Citizen only.
 */
export async function ownLandOf({ citizen, foodMilliPerHour, rememberedTiles, deps }) {
  if (typeof citizen !== 'string' || !deps.territoryPlayer) return { land: null, records: null };
  let player;
  try { player = heraldTerritoryPlayer(await deps.territoryPlayer(citizen), { citizen, tag: citizenTagOf(citizen) }); } catch { player = null; }
  if (!player) return { land: null, records: null };
  const tiles = player.player ? player.player.tiles : 0, upkeep = player.player ? player.player.upkeepMilliPerHour : 0;
  const land = Number.isFinite(foodMilliPerHour) ? { foodMilliPerHour, upkeepMilliPerHour: upkeep, tiles } : null;
  let records = null;
  if (rememberedTiles > tiles && deps.territoryTiles) { try { records = heraldTerritoryRecords(await deps.territoryTiles()); } catch { records = null; } }
  return { land, records };
}
/** `ask()` shared and kept `ms` milliseconds (one answer for every resident of the round; a failure is not kept). */
export function cachedFor(ms, ask, now = () => Date.now()) {
  let at = -Infinity, value = null, pending = null;
  return () => {
    if (now() - at < ms) return Promise.resolve(value);
    pending ??= ask().then(v => { value = v; at = now(); return v; }).finally(() => { pending = null; });
    return pending;
  };
}
