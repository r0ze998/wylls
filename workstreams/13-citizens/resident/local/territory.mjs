// ⑬ local resident and PLAYER TERRITORY (#209; ws13-territory, 2026-11-25). KEY-FREE.
//
// The world's rule, the same for every player (design record §8: AI residents = players): a single tile of the wide land
// is claimed with the page's own act TerritoryClaim (0xDA op 7, flocalplay-territory.mjs) — 10 ore + 2 % per tile owned
// (rounded down) from the first home, ONE claim a turn; upkeep in food per hour, fixed at the claim; unpaid upkeep →
// no new claims, and after 24 turns one tile returns per turn; a wide village stands only on a site whose tile is the
// claimer's own, with no village on a neighbouring site. This file adds NO rule: it is what this resident reads and how
// it chooses among what a person's page could press.
//
//   reads     its own territory record, the reachable provinces' territory records and captures — the same reader as the
//             read-only MCP tool get_territory_status (③ mcp/src/local-play-territory.mjs): own tiles and summary
//             always, another tile's owner only in its sight (the page's fog)
//   site tile the tile of the site its next wide village will stand on, claimed BEFORE the wide claim (the page's card
//             does the same in two presses)
//   growth    one more tile next to its own, at its own pace (TERRITORY_LIMITS) — the pace is the resident's choice,
//             never looser than the world's one claim a turn and its own one action a turn
//
// THE PACE (loop-play15 LP15-5: operator AI residents bought tiles whenever the ore covered the price and then could not
// train — 174 Train refusals against 32 landed in 38 minutes). Tiles and spearmen are both paid in ore, so this resident
// buys a growth tile only from ore it does not need: the stock beyond its build plan and reserve (brain.mjs assessReal
// `idle`) must cover the tile AND the ore of one training hundred; its land's upkeep stays under a share of its first
// home's food per hour; one growth tile every few turns; a ceiling of tiles. The site tile of its next village is not
// growth: it is bought as soon as the ore covers it (without it no village can be founded at all).
import { seasonAddresses } from '../../../../permutation-server/web/frontier/faddr.mjs';
import { TERRITORY_CLAIM, TERRITORY_V1 } from '../../../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { TILE_OFFSETS, hexDistance } from '../../../../permutation-server/web/frontier/fgeo.mjs';
import { createTerritoryReader, claimNow } from '../../../03-composability/mcp/src/local-play-territory.mjs';

export { TERRITORY_CLAIM, claimNow };
/**
 * The resident's own pace on its land (its choices; the world's rule is one claim a turn):
 *   growthEveryBells 6      at most one growth tile every 6 turns
 *   tilesMax 24             it stops growing by tiles at 24 (the operator AI residents' ceiling, OPERATOR_TILES_MAX)
 *   oreKeepHundreds 1       after a growth tile the idle ore still pays for this many training hundreds
 *   upkeepSharePct 10       its land's upkeep (this tile included) stays within 10 % of its first home's food per hour
 *   blindTries 6            tiles out of its sight it asks for in one province before it leaves that province alone
 */
export const TERRITORY_LIMITS = Object.freeze({ growthEveryBells: 6, tilesMax: 24, oreKeepHundreds: 1, upkeepSharePct: 10, blindTries: 6 });
/** frontier-abi error.rs codes a tile claim is refused with (proc/wide_territory.rs territory_err). */
export const TILE_REFUSALS = Object.freeze({ temporary: Object.freeze([21, 29, 43]), mine: 52 });   // Insufficient, Cooldown (the turn's claim), NotEligible (upkeep unpaid); AlreadyDone

/** The resident's territory memory (inside journal.mjs state, `st.territory`), made when first needed. */
export const territoryMem = st => (st.territory ??= { claims: 0, triedTiles: [], lastClaimBell: null, lastGrowthBell: null, mineTiles: [] });

const tkey = (p, q, tile) => `${p},${q},${tile}`;
const adjacent = (a, b) => { const x = TILE_OFFSETS[a], y = TILE_OFFSETS[b]; return !!x && !!y && hexDistance(x.q, x.r, y.q, y.r) === 1; };
const witnessOf = reach => (reach && reach.kind !== 'home' ? { witness: { kind: reach.kind, p: String(reach.p), q: String(reach.q) } } : {});

/** The TerritoryClaim order for `tile` of province `x` (a view province), paid by the first home `holding`. */
export function tileOrder(holding, x, tile) {
  const v = { holding: { p: holding.p, q: holding.q, site: holding.site }, target: { p: String(x.p), q: String(x.q) }, ...witnessOf(x.reach), ...(x.upkeepVillage ? { village: x.upkeepVillage } : {}) };
  return { name: TERRITORY_CLAIM, v, fields: { tile } };
}

/** Whether tile (p, q, tile) is the resident's: by the record, or by the chain's own "already yours" it remembers. */
const isMine = (x, tile, m) => x.own.includes(tile) || (m.mineTiles ?? []).includes(tkey(x.p, x.q, tile));

/**
 * The site of the resident's next wide village in a territory world, and its tile (pure): among the view's provinces a
 * village claim may name (`targets`: wide.mjs's claim targets, "p,q" → its free sites from the herald or null), nearest
 * the first home first — a site that is free, has no village on a neighbouring site as far as the resident sees, was
 * not tried, and whose tile is its own already or can still be asked for. A site whose tile is already its own comes
 * first. → `{p, q, site, tile, mine, province}` or `{why}`.
 */
export function villageSite(view, st, targets) {
  if (view?.on !== true) return { why: view?.why ?? 'player territory is not read' };
  const m = territoryMem(st), triedSites = new Set(st.wide?.triedClaims ?? []), triedTiles = new Set(m.triedTiles);
  const options = [];
  for (const x of view.provinces) {
    const k = `${x.p},${x.q}`;
    if (!targets.has(k)) continue;
    const free = targets.get(k);   // (the herald's free sites of that province, or null: not known)
    for (const s of x.sites) {
      if (triedSites.has(tkey(x.p, x.q, s.site))) continue;
      if (Array.isArray(free) ? !free.includes(s.site) : s.open === false) continue;
      if (s.village === true || s.crowded === true) continue;
      const mine = isMine(x, s.tile, m);
      if (!mine && (x.taken.includes(s.tile) || triedTiles.has(tkey(x.p, x.q, s.tile)) || !x.reach)) continue;
      options.push({ p: x.p, q: x.q, site: s.site, tile: s.tile, mine, province: x });
    }
  }
  if (!options.length) return { why: 'no free village site within reach whose tile is mine or can still be claimed' };
  return options.find(o => o.mine) ?? options[0];
}

/**
 * The next growth tile (pure): in a province where the resident owns a tile, a tile next to one of its own that is not
 * a village site, not the keep's, not tried — one it sees is free first, else one out of its sight (at most
 * `blindTries` tried tiles a province). → `{p, q, tile, seen, province}` or `{why}`.
 */
export function growthTile(view, st, limits = TERRITORY_LIMITS) {
  if (view?.on !== true) return { why: view?.why ?? 'player territory is not read' };
  const m = territoryMem(st), tried = new Set(m.triedTiles);
  let blind = null;
  for (const x of view.provinces) {
    if (!x.own.length || !x.reach) continue;
    const ok = t => !x.siteTiles.includes(t) && !tried.has(tkey(x.p, x.q, t)) && !isMine(x, t, m) && x.own.some(o => adjacent(o, t));
    const seen = x.free.find(ok);
    if (seen !== undefined) return { p: x.p, q: x.q, tile: seen, seen: true, province: x };
    const triedHere = m.triedTiles.filter(k => k.startsWith(`${x.p},${x.q},`)).length;
    if (!blind && triedHere < limits.blindTries) { const u = x.unseen.find(ok); if (u !== undefined) blind = { p: x.p, q: x.q, tile: u, seen: false, province: x }; }
  }
  return blind ?? { why: 'no free tile next to my own land (as far as I see)' };
}

/**
 * Why a GROWTH tile is not bought now (the resident's own pace; pure) → reasons (empty: buy). `idleOre`: the first
 * home's ore beyond its build plan and reserve; `trainOre100`: the ore of one training hundred; `foodPerHour`: the
 * first home's food per hour; `addMilli`: the upkeep the tile adds (milli-food per hour).
 */
export function growthHolds(view, st, { bell, idleOre, trainOre100, foodPerHour, addMilli, limits = TERRITORY_LIMITS }) {
  const m = territoryMem(st), o = view.own, why = [];
  if (o.tiles >= limits.tilesMax) why.push(`${o.tiles} tiles: my ceiling is ${limits.tilesMax}`);
  if (Number.isInteger(m.lastGrowthBell) && bell < m.lastGrowthBell + limits.growthEveryBells) why.push(`my last growth tile was in turn ${m.lastGrowthBell}: one every ${limits.growthEveryBells} turns`);
  const keep = trainOre100 * limits.oreKeepHundreds;
  if (!(idleOre >= o.nextClaimOre + keep)) why.push(`ore beyond my plan and reserve (${Math.floor(idleOre ?? 0)}) does not cover the tile (${o.nextClaimOre}) and ${limits.oreKeepHundreds} training hundred(s) (${keep}): land does not come before troops`);
  const after = o.upkeepMilliFoodPerHour + addMilli, cap = Math.floor((foodPerHour ?? 0) * 1000 * limits.upkeepSharePct / 100);
  if (after > cap) why.push(`upkeep would be ${(after / 1000).toFixed(3)} food/h, over ${limits.upkeepSharePct} % of my first home's ${foodPerHour ?? 0} food/h`);
  return why;
}

/**
 * After a tile claim (brain.mjs noteOutcome): the memory. `site`: "p,q,tile"; `programCode`: the program's refusal code
 * when the relay named one. A landing: the claim's turn (and the growth pace). "Already yours": remembered as mine. A
 * refusal that passes with time (ore, the turn's claim, unpaid upkeep): nothing but the failure hold. Any other refusal
 * (another player's tile, the keep's, out of reach, not known): that tile is not asked again.
 */
export function noteTile(st, { site, growth = false }, outcome, { bell, programCode = null } = {}) {
  const m = territoryMem(st);
  if (!site || outcome === 'not-sent' || outcome === 'unknown') return st;
  if (outcome === 'landed') { m.claims += 1; m.lastClaimBell = bell; if (growth) m.lastGrowthBell = bell; return st; }
  if (programCode === TILE_REFUSALS.mine) { if (!m.mineTiles.includes(site)) m.mineTiles.push(site); return st; }
  if (TILE_REFUSALS.temporary.includes(programCode)) { if (programCode === 29) m.lastClaimBell = bell; return st; }
  if (!m.triedTiles.includes(site)) m.triedTiles.push(site);
  return st;
}

/**
 * The resident's territory eyes: `look(obs, st)` → the territory view (the reader's; `{on: null, why}` when unread),
 * once per turn and memory change; reads only. Ports: `herald` (its world proxy), `identity` ({programId,
 * seasonAddress}), `read(addresses)` (its relay's read-only account read), `getJson(url)`.
 */
export function createTerritoryEyes({ herald, identity, read, getJson, now = () => Date.now(), deps = {} }) {
  let reader = null, readerKey = null, cache = null;
  async function look(obs, st) {
    if (!obs?.holding || !Number.isInteger(obs.faction)) return null;
    const m = territoryMem(st);
    const memKey = JSON.stringify([obs.bell, obs.holding, obs.wideInv?.villages ?? [], m.claims, m.triedTiles.length, m.mineTiles.length]);
    if (cache?.key === memKey) return cache.value;
    if (!reader || readerKey !== obs.seasonId) {
      const A = seasonAddresses(identity.programId, String(obs.seasonId));
      if (A.season !== identity.seasonAddress) return { on: null, why: 'the herald\'s world is not the one my relay pins' };
      reader = deps.reader ?? createTerritoryReader({ herald, addresses: A, programId: identity.programId, getJson, read, now });
      readerKey = obs.seasonId;
    }
    let value;
    try {
      value = await reader.view({ wallet: identity.address, home: { p: obs.holding.p, q: obs.holding.q, site: obs.holding.site, tile: obs.holding.tile, tier: Number(obs.settled?.tier ?? 0) }, faction: obs.faction,
        villages: (obs.wideInv?.villages ?? []).map(v => ({ p: String(v.p), q: String(v.q), site: v.site })), bell: obs.bell });
    } catch (e) { return { on: null, why: `territory not read: ${String(e?.code ?? e?.message ?? e).slice(0, 120)}` }; }
    if (value.on !== null) cache = { key: memKey, value };
    return value;
  }
  return Object.freeze({ look });
}

/** For logs: the view reduced to what the resident read (numbers, no tile lists). */
export function territorySeen(view) {
  if (!view) return null;
  if (view.on !== true) return { on: view.on, why: view.why ?? null };
  const o = view.own;
  return { on: true, tiles: o.tiles, nextClaimOre: o.nextClaimOre, upkeepFoodPerHour: o.upkeepMilliFoodPerHour / 1000, unpaid: o.unpaid, claimsThisTurn: o.claimsThisTurn,
    provinces: view.provinces.length, mine: o.list.map(x => tkey(x.p, x.q, x.tile)), free: view.provinces.reduce((n, x) => n + x.free.length, 0), unseen: view.provinces.reduce((n, x) => n + x.unseen.length, 0) };
}
export const TERRITORY_RULE = TERRITORY_V1;
