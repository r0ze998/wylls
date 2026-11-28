// THE WALLETLESS DEMO'S SINGLE-TILE CLAIM (demo-claim-1, owner Q-WD-4 default: "port the real one-tile claim").
//
// A sample world whose record says `sample.landClaim` (screens/liveworld.mjs option `landClaim`) has no land "taken on
// arrival": the viewer's land is the tiles it CLAIMS, one at a time, from the village card's "Claim a tile", judged by
// the real rule TERRITORY_V1 — never by numbers of the demo's own:
//
//   the judge   frontier-abi world_index/territory.rs `judge_claim` (tile 0-60, not the keep's tile) then
//               permutation-rules frontier/territory.rs `may_claim` — here territory-rules.mjs `mayClaim`, the page's
//               copy checked against the kernel's committed vectors (permutation-rules/vectors/territory-preview.json)
//   the numbers TERRITORY_V1 (flocalplay-territory.mjs, = frontier-abi TERRITORY_V1): 10 ore + 2 % per tile owned,
//               reach 3 provinces from the home, a province of the nation's land or one with an own tile, 1 claim a
//               turn, no claim while upkeep is unpaid; upkeep 0.99 food/h a tile + 0.48 per province beyond 3
//   the codes   proc/wide_territory.rs `territory_err`: the program's error numbers for each refusal
//
// Where the demo differs from the program (said in the season record's `sample.simpler` and in report demo-claim-1):
// the demo's map is rings 0-2 (the program's territory is the wide land, ring 129 and out), so every province of it is
// territory land; the keep's tile is the province's camp tile; the claim is answered by the in-page world at once (no
// transaction is signed or sent); nothing else of the program's territory (conquest of tiles with a keep) is played.
import { mayClaim, SRC_HOME, SRC_OWN, SRC_NATION_LAND } from './territory-rules.mjs';
import { TERRITORY_V1, claimCostV1, tileUpkeepV1 } from './flocalplay-territory.mjs';
import { hexDistance, ringOf } from './fgeo.mjs';

export const PROVINCE_TILES = 61;
/** TERRITORY_V1's kernel parameters in territory-rules.mjs `mayClaim`'s shape (frontier-abi TERRITORY_V1.kernel). */
export const V1_CLAIM_PARAMS = Object.freeze({
  reach: Object.freeze({ range: TERRITORY_V1.range, sources: SRC_HOME | SRC_OWN | SRC_NATION_LAND }),
  cost: TERRITORY_V1.cost,
  claimsPerTurn: TERRITORY_V1.claimsPerTurn,
  claimOwned: false,
  unpaid: Object.freeze({ blockClaims: true }),
});
/** The program's error number for each refusal (proc/wide_territory.rs territory_err; abi.mjs ERRORS). */
export const CLAIM_REFUSAL_CODE = Object.freeze({
  BadTile: 1, KeepTile: 57, NotOpen: 1, AlreadyYours: 52, Owned: 11, Range: 75, TurnLimit: 29, UpkeepUnpaid: 43, Insufficient: 21, Overflow: 19, NotFinal: 24,
});
export const CLAIM_REFUSAL_NAME = Object.freeze({ 1: 'BadData', 57: 'ReservedSite', 52: 'AlreadyDone', 11: 'SiteTaken', 75: 'OutpostRule', 29: 'Cooldown', 43: 'NotEligible', 21: 'Insufficient', 19: 'Overflow', 24: 'NotFinal' });

const refuse = refused => ({ ok: false, refused, programCode: CLAIM_REFUSAL_CODE[refused], code: CLAIM_REFUSAL_NAME[CLAIM_REFUSAL_CODE[refused]] });

/**
 * judge_claim: `{tile, keepTile, owner: 'nobody'|'claimer'|'other', nearest: {home, own?, nationLand?}, owned,
 * claimsThisTurn, upkeepUnpaid, balance (whole ore)}` → `{ok: true, cost}` (whole ore) or `{ok: false, refused,
 * programCode, code}`.
 */
export function judgeTileClaim(c) {
  if (!Number.isInteger(c.tile) || c.tile < 0 || c.tile >= PROVINCE_TILES) return refuse('BadTile');
  if (Number.isInteger(c.keepTile) && c.tile === c.keepTile) return refuse('KeepTile');
  const r = mayClaim(V1_CLAIM_PARAMS, { open: true, owner: c.owner, nearest: c.nearest ?? {}, owned: c.owned, claimsThisTurn: c.claimsThisTurn, upkeepUnpaid: !!c.upkeepUnpaid, balance: c.balance });
  return r.refused ? refuse(r.refused) : { ok: true, cost: Number(r.ok) };
}

/** Provinces between two provinces (the province grid's hex distance). */
export const provinceDistance = (a, b) => hexDistance(Number(a.p), Number(a.q), Number(b.p), Number(b.q));

/** The tiles of a province no claim may take: its village sites and the keep's (the camp's) tile. */
export function blockedTiles(pr) {
  const out = new Set();
  const n = Number(pr?.siteCount ?? 0);
  for (let s = 0; s < n; s++) if (Number.isInteger(pr.sites?.[s])) out.add(pr.sites[s]);
  if (Number.isInteger(pr?.camp?.tile)) out.add(pr.camp.tile);
  return out;
}
/** The keep's tile of a demo province (its camp's), or null. */
export const keepTileOf = pr => (Number.isInteger(pr?.camp?.tile) ? pr.camp.tile : null);

/** A village of `faction` stands in the province (a site mirror in state final or provisional). */
export const nationVillageIn = (pr, faction) => Number.isInteger(faction) && (pr?.siteMirror ?? []).slice(0, Number(pr?.siteCount ?? 0)).some(m => m && (m.state === 1 || m.state === 2) && m.faction === faction);

/**
 * The card's province rows in a `landClaim` demo world (the page's in-browser rule): every province the page has read
 * whose nearest reach source — the first home, a province with a tile of this page's claims, a province with a village
 * of the viewer's nation — is within TERRITORY_V1.range, nearest first. Each row names its first free tile (lowest
 * index: not a site, not the keep's, no owner in the map's read, not one this page claimed), the witness the claim
 * names (the source of the reach when it is not the home) and the distance its upkeep is fixed at.
 *
 * `provinces`: `[{p, q, province, owners}]` (owners: the 61 tile owners of the map's read, 255 = none);
 * `home`: `{p, q}`; `faction`; `ownTiles`: Set of "p,q,tile" this page claimed.
 */
export function sampleClaimRows({ provinces, home, faction, ownTiles = new Set() }) {
  const list = (provinces ?? []).filter(x => x && x.province && Array.isArray(x.owners) && x.owners.length === PROVINCE_TILES);
  const mineIn = x => [...ownTiles].some(k => k.startsWith(`${x.p},${x.q},`) && x.owners[Number(k.split(',')[2])] === faction);
  const own = list.filter(mineIn), nation = list.filter(x => nationVillageIn(x.province, faction));
  const near = (x, from) => (from.length ? Math.min(...from.map(y => provinceDistance(x, y))) : null);
  const rows = [];
  for (const x of list) {
    const nearest = { home: provinceDistance(home, x), own: near(x, own), nationLand: near(x, nation) };
    const reach = Math.min(...[nearest.home, nearest.own, nearest.nationLand].filter(d => d !== null));
    if (reach > TERRITORY_V1.range) continue;
    // the witness the program is told (the kernel takes the home always, and one named source more)
    const src = nearest.home === reach ? null : nearest.own === reach ? 'own' : 'nation';
    const from = src === 'own' ? own : src === 'nation' ? nation : [];
    const w = src ? from.reduce((b, y) => (provinceDistance(x, y) < provinceDistance(x, b) ? y : b)) : null;
    const blocked = blockedTiles(x.province);
    let tile = null;
    for (let i = 0; i < PROVINCE_TILES; i++) if (!blocked.has(i) && x.owners[i] === 255 && !ownTiles.has(`${x.p},${x.q},${i}`)) { tile = i; break; }
    rows.push({ p: x.p, q: x.q, tile, home: nearest.home, mine: mineIn(x), witness: w ? { kind: src, p: w.p, q: w.q } : null,
      upkeepMilli: tileUpkeepV1(nearest.home), ring: ringOf(Number(x.p), Number(x.q)) });
  }
  return rows.sort((a, b) => a.home - b.home || a.ring - b.ring || a.p - b.p || a.q - b.q);
}

/** The next claim's ore while owning `tiles` (kernel claim_cost) and the upkeep one more tile at `dist` adds. */
export const nextClaimOre = tiles => claimCostV1(Math.max(0, Number(tiles) || 0));
export { tileUpkeepV1 };
