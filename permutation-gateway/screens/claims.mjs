// "Standing Ground", the banner rule: A DESIGN, NOT A RULE OF THE PROGRAM.
//
// The owner asked on 2026-10-10 for land that becomes yours as you move. No
// rule of the program does that, so a rule was designed (CLAIM-RULE.md,
// revision 2) and is shown as a LABELLED PROTOTYPE in the sample world
// (liveworld.mjs, option `claims`; PROTOTYPE-SPEC.md). Nothing in this file
// is in the program, the rules crate or the ABI, and nothing of it is sent
// to a chain. liveworld.mjs says of itself "nothing here is a rule of its
// own"; this file is the one stated exception, kept apart for that reason.
//
// Pure functions, no state: the function set a later
// `frontier-abi/src/claim_model.rs` would have. Every function takes the
// province as last resolved (`pv`), the province's land record (`land`) and
// what it judges, and gives back a verdict or a NEW land record with one log
// record. Nothing here reads a clock: `r` is `pv.resolvedNext`, the first
// turn not yet resolved, and a change counts from turn `r`.
//
// The reduced form the sample world shows (PROTOTYPE-SPEC section 2) is not
// written into the functions: it comes in as parameters on `pv`:
//   pv.holderNation  the nation that holds the province's keep. The sample
//                    world has no keeps and passes the wedge's nation.
//   pv.heartland     true where no foreign banner may rise and a foreign host
//                    raises, takes, tends and denies nothing. The sample world
//                    passes true for the viewer's home province only.
//   pv.faces         six entries, one per border row (fgeo DIRECTIONS):
//                    `{open, ring, holderNation, banners: [6]}` of the province
//                    that row faces, or null where there is none.
//   pv.entries       the roster as resolved, each entry with `inTransit` (a
//                    march of its Holding that is not settled names it) and
//                    `holder` (the key of the player it belongs to).
//
// Numbers: ONE table, copied from claim-rule-constants.json (revision 2).
// Nothing else may hold a copy; the page reads them from the season record.
import { TILE_OFFSETS, DIRECTIONS, hexDistance, tileHex, locate } from '../../permutation-server/web/frontier/fgeo.mjs';

export const RULE = Object.freeze({ rule: 'standing-ground', version: 'design-2026-10-10-r2', revision: 2 });

/** The numbers of the rule (claim-rule-constants.json; the key each comes from is beside it). */
export const NUMBERS = Object.freeze({
  STAND_HOME: 1,                 // stand_tolls.raise_home_ground
  STAND_ABROAD: 12,              // stand_tolls.raise_under_another_nations_keep
  FALL_LOOSE: 36,                // stand_tolls.fall_loose, fall_border_banner_to_the_neighbour_it_faces
  FALL_FIRM: 72,                 // stand_tolls.fall_firm
  OWN_WEDGE_FACTOR: 0.5,         // stand_tolls.own_wedge_factor (halved counts round up)
  TAKE_OVER_STAND: 1,            // stand_tolls.take_over_by_a_nation_mate_after_the_grace
  FLOOR_HOME: 100,               // troop_floor.home_ground
  FLOOR_ABROAD: 500,             // troop_floor.elsewhere
  FLOWER: 7,                     // patch.flower (the pole and its six neighbours)
  TRAIL_MAX: 3,                  // patch.trail_max
  TRAIL_STEPS: 4,                // patch.trail (the host's own last four route tiles)
  PATCH_MAX: 12,                 // patch.max
  MIN_PATCH: 3,                  // patch.min
  REACH: 2,                      // patch.reach_from_pole_for_flower_and_dressing
  DENY_FACTOR: 2,                // patch.never (fewer than twice its troops)
  DRESS_PER_DAY: 1,              // patch.dress_per_banner_per_game_day
  ELBOW_MAX: 4,                  // elbow_room.up_to_tiles
  ELBOW_LOCK: 432,               // elbow_room.own_strike_locked_turns
  CAP_BY_TIER: Object.freeze([3, 5, 7, 9]),   // caps.banners_by_tier_of_the_first_village
  PER_PROVINCE: 2,               // caps.banners_per_citizen_per_province
  SLOTS: 16,                     // caps.slots_per_province
  SITE_POLES: 2,                 // caps.poles_beside_one_empty_site
  TOWN_AGE: 144,                 // caps.abroad_needs
  CEILING_ABROAD: 24,            // where.ceiling_abroad_tiles_per_nation_per_province_village_land_included
  KEEP_SHARE: 24,                // score.paid_ceiling_without_the_keep
  FREE_BANNERS: 3,               // works.free_banners
  PRICE_THEN: Object.freeze([4, 8, 12, 16, 20, 24]),   // works.then
  PRICE_ABROAD_STEP: 8,          // works.abroad
  WALK_LOOSE: 144,               // walk.loose_every_turns
  WALK_FIRM: 432,                // walk.firm_every_turns
  WALK_LOOSE_TROOPS: 500,        // walk.loose_by
  GRACE: 72,                     // walk.strike_after_limit_plus_turns
  STUMP_TILES: 3,                // walk.stump
  STUMP_AGE: 144,                // walk.stump
  EXPLORE_PER_DAY: 5,            // works.explore_tiles_per_citizen_per_game_day
  WALK_PAY: 2,                   // works.first_tend_or_dressing_of_a_game_day_pays
  ROOM_FULL: 8,                  // making_room.when (a nation's eight places)
  ROOM_STALE: 36,                // making_room.stale_tolls
  ROOM_FAIR_SHARE: 2,            // making_room.a_host_gives_way_if (two more hosts than the newcomer's owner)
  TILES: 61,                     // score.per_province_per_turn
  DAY: 144,                      // the game day in turns (CLAIM-RULE section 2)
});
const N = NUMBERS;
const MILLI = 1000, SCOUT = 6, ROSTER = 1, MUSTER_PENDING = 2, OPEN = 0xff, BANNER0 = 16;

// ------------------------------------------------------------------ the ground's geometry (fgeo)
const INDEX = new Map(TILE_OFFSETS.map((o, i) => [`${o.q},${o.r}`, i]));
const NB = TILE_OFFSETS.map(o => DIRECTIONS.map(([dq, dr]) => INDEX.get(`${o.q + dq},${o.r + dr}`) ?? -1));
/** The tiles next to `tile` inside its province. */
export const neighbours = tile => NB[tile].filter(x => x >= 0);
/** Steps between two tiles of one province. */
export const steps = (a, b) => hexDistance(TILE_OFFSETS[a].q, TILE_OFFSETS[a].r, TILE_OFFSETS[b].q, TILE_OFFSETS[b].r);
/** The six border rows of a province: `BORDER_ROWS[d]` are the tiles that touch the province in fgeo DIRECTIONS[d] (five a row). */
export const BORDER_ROWS = Object.freeze(DIRECTIONS.map(([dp, dq]) => Object.freeze([...Array(N.TILES).keys()].filter(t => {
  const h = tileHex(0, 0, t);
  return DIRECTIONS.some(([a, b]) => { const l = locate(h.q + a, h.r + b); return l.p === dp && l.q === dq; });
}))));
const bit = (mask, tile) => ((BigInt(mask) >> BigInt(tile)) & 1n) === 1n;
const passable = (pv, tile) => bit(pv.passableMask, tile);
const explored = (pv, tile) => bit(pv.exploredMask, tile);
const dayOf = r => Math.floor(r / N.DAY);
const fighting = e => e.unit !== SCOUT;
/** In the roster of the province as resolved (it fights and denies; it may still have an order pending). */
const present = (e, r) => !!e && e.state === ROSTER && e.fromBell <= r;
const liveCamp = pv => (pv.camp && pv.camp.state === 1 ? pv.camp.tile : -1);
const nearCamp = (pv, tile) => { const c = liveCamp(pv); return c >= 0 && (c === tile || NB[tile].includes(c)); };
const siteIndex = (land, tile) => land.sites.indexOf(tile);
/** Is `nation` a stranger in a heartland here (it raises, takes, tends and denies nothing)? */
const strangerInHeartland = (pv, nation) => !!pv.heartland && nation !== pv.holderNation;
/** Abroad: neither home ground nor the homeland. With no keeps the two are one question. */
export const abroad = (pv, nation) => pv.holderNation !== nation && (pv.wedge ?? pv.holderNation) !== nation;
const homeGround = (pv, nation) => pv.holderNation === nation;

// ------------------------------------------------------------------ the land record
const blank = () => ({ used: false, frayed: false, elbow: false, pole: 0, nation: 0, tiles: [], raisedTurn: 0, tendedTurn: 0, dressDay: -1, holder: null });
/**
 * A province's land with nothing claimed: `sites` the tiles of its sites, `turn` the first turn it counts.
 * `claim[t]`: 0xFF open ground (an empty site's tile too: `kindOf` tells them apart), 0..11 land of the village on
 * that site, 16..31 banner slot. `names`: the tile-turns carried in each holder's name (display only).
 */
export function newLand(sites, turn) {
  return { claim: new Uint8Array(N.TILES).fill(OPEN), banners: Array.from({ length: N.SLOTS }, blank), trails: new Map(), counted: [0, 0, 0, 0, 0, 0], villageTiles: new Array(12).fill(0),
    villageNation: new Array(12).fill(null), villageHolder: new Array(12).fill(null), totals: [0, 0, 0, 0, 0, 0], names: {}, cursor: turn, opened: turn, sites: [...sites] };
}
export function cloneLand(land) {
  return { ...land, claim: Uint8Array.from(land.claim), banners: land.banners.map(b => ({ ...b, tiles: [...b.tiles] })), trails: new Map([...land.trails].map(([k, v]) => [k, { ...v, tiles: [...v.tiles] }])),
    counted: [...land.counted], villageTiles: [...land.villageTiles], villageNation: [...land.villageNation], villageHolder: [...land.villageHolder], totals: [...land.totals], names: { ...land.names }, sites: [...land.sites] };
}
/** `counted`: village land and banner tiles that are not frayed, per nation, before the keep's share. */
function recount(land) {
  land.counted = [0, 0, 0, 0, 0, 0];
  land.villageTiles = new Array(12).fill(0);
  for (let t = 0; t < N.TILES; t++) { const c = land.claim[t]; if (c < 12) { land.villageTiles[c]++; land.counted[land.villageNation[c]]++; } }
  for (const b of land.banners) if (b.used && !b.frayed) land.counted[b.nation] += b.tiles.length;
  return land;
}
/** A land record with its counts made anew from its claim map and its banners (for a record put together by hand). */
export const recounted = land => recount(cloneLand(land));
/** The tiles each holder has that count now: `{key: n}` (village land, banner tiles that are not frayed). */
function inNames(land) {
  const out = {};
  land.villageTiles.forEach((n, s) => { if (n && land.villageHolder[s] !== null) out[land.villageHolder[s]] = (out[land.villageHolder[s]] ?? 0) + n; });
  for (const b of land.banners) if (b.used && !b.frayed && b.holder !== null) out[b.holder] = (out[b.holder] ?? 0) + b.tiles.length;
  return out;
}

/** What a tile is: `{kind: 'site'}` (an empty site), `'open'`, `'village'` with its `site`, `'banner'` with its `slot` (`'green'`, keep green, is not used in the sample world). */
export function kindOf(land, tile) {
  const c = land.claim[tile];
  if (c < 12) return { kind: 'village', site: c };
  if (c >= BANNER0 && c < BANNER0 + N.SLOTS) return { kind: 'banner', slot: c - BANNER0 };
  return siteIndex(land, tile) >= 0 ? { kind: 'site', site: siteIndex(land, tile) } : { kind: 'open' };
}
const isOpen = (land, tile) => land.claim[tile] === OPEN && siteIndex(land, tile) < 0;

/** A host stands: in the roster, from a turn that is resolved, no order pending, its march (if any) settled. */
export function stands(pv, e, r = pv.resolvedNext) { return present(e, r) && e.pendOp === 0 && !e.inTransit; }
const stood = (e, r) => r - e.fromBell;

/** The hostile fighting hosts of the roster on `tile`, for `nation` (none in a heartland where they are strangers). */
function hostileOn(pv, tile, nation, r) {
  return pv.entries.filter(x => present(x, r) && fighting(x) && x.faction !== nation && x.tile === tile && !strangerInHeartland(pv, x.faction));
}
/** Why `tile` is denied to a planter of `nation` with `troops` (milli), or null: a hostile fighting host on it; one next to it that the planter does not outnumber two to one. */
function deniedWhy(pv, tile, nation, troops, r) {
  if (pv.heartland) return null;
  if (hostileOn(pv, tile, nation, r).length) return 'host';
  for (const k of neighbours(tile)) if (hostileOn(pv, k, nation, r).some(h => troops < N.DENY_FACTOR * h.troops)) return 'near';
  return null;
}
const hostileWithin2 = (pv, tile, nation, r) => !pv.heartland && pv.entries.some(x => present(x, r) && fighting(x) && x.faction !== nation && steps(x.tile, tile) <= 2);

/** The host's trail record, when it is valid: it came to this tile by a march and stayed, and has not been moved since. */
function trailOf(land, e) { const t = land.trails.get(String(e.id)); return t && t.stamp === e.fromBell && t.tile === e.tile ? t : null; }
/** Surveyed for this host: the tile is in the province's explored mask, or the host marched here and stayed. */
export function surveyedFor(pv, land, e) { return explored(pv, e.tile) || !!trailOf(land, e); }

/** The flower of a banner on the host's tile: `{tiles, denied: [{tile, why}]}`; the pole first, then its open neighbours (passable or not). */
export function flower(pv, land, e, r = pv.resolvedNext) {
  const tiles = [e.tile], denied = [];
  for (const j of neighbours(e.tile)) {
    const k = kindOf(land, j);
    if (k.kind !== 'open') { denied.push({ tile: j, why: k.kind }); continue; }
    if (liveCamp(pv) === j) { denied.push({ tile: j, why: 'camp' }); continue; }
    const why = deniedWhy(pv, j, e.faction, e.troops, r);
    if (why) { denied.push({ tile: j, why }); continue; }
    tiles.push(j);
  }
  return { tiles, denied };
}
/** The trail: walking back along the host's own last steps from the pole, up to three tiles, stopping at the first that cannot be added. */
export function trail(pv, land, e, flowerTiles, r = pv.resolvedNext) {
  const rec = trailOf(land, e), out = [];
  if (!rec) return out;
  for (const k of rec.tiles.slice(0, N.TRAIL_STEPS)) {
    if (flowerTiles.includes(k)) continue;   // already in the flower: the walk goes on
    if (out.length >= N.TRAIL_MAX || flowerTiles.length + out.length >= N.PATCH_MAX) break;
    if (!isOpen(land, k) || !passable(pv, k) || liveCamp(pv) === k || hostileWithin2(pv, k, e.faction, r)) break;
    out.push(k);
  }
  return out;
}
/** The banners (slots) a holder has in this province, and the banner tiles under them. */
const slotsOf = (land, key) => land.banners.map((b, slot) => (b.used && b.holder === key ? slot : -1)).filter(s => s >= 0);
const bannerTilesOf = (land, key) => land.banners.reduce((a, b) => a + (b.used && b.holder === key ? b.tiles.length : 0), 0);
const nationLand = (land, nation) => land.villageTiles.reduce((a, n, s) => a + (land.villageNation[s] === nation ? n : 0), 0) + land.banners.reduce((a, b) => a + (b.used && b.nation === nation ? b.tiles.length : 0), 0);
const nationBanners = (land, nation) => land.banners.filter(b => b.used && b.nation === nation).length;
/** The hostile fighting host standing on a banner's pole (the banner is contested, frozen), or null. */
export function contested(pv, land, slot, r = pv.resolvedNext) {
  const b = land.banners[slot];
  if (!b?.used) return null;
  return hostileOn(pv, b.pole, b.nation, r).sort((x, y) => x.fromBell - y.fromBell || (BigInt(x.id) < BigInt(y.id) ? -1 : 1))[0] ?? null;
}

/**
 * Elbow room for a first banner (B9): the tiles the order names, judged on the result. `{ok, tiles, from}` or
 * `{ok: false, why}`: first (the planter holds a banner), home (not on home ground or in the homeland), used
 * (once a season), tile (not an outer tile of a nation-mate's banner at the pole or next to it), contested, size
 * (open ground already gives four, or the result is over four), giver (a giver would hold fewer banner tiles here
 * than the planter, or a patch would fall under three).
 */
function elbowRoom(pv, land, e, holder, open, named, r) {
  if (!named?.length) return { ok: true, tiles: [], from: [] };
  if (holder.bannersHeld > 0) return { ok: false, why: 'first' };
  if (abroad(pv, holder.nation)) return { ok: false, why: 'home' };
  if (holder.elbowUsed) return { ok: false, why: 'used' };
  const tiles = [...new Set(named)];
  if (open.length >= N.ELBOW_MAX || open.length + tiles.length > N.ELBOW_MAX) return { ok: false, why: 'size' };
  const taken = new Map(), from = [];
  for (const t of tiles) {
    const k = kindOf(land, t), b = k.kind === 'banner' ? land.banners[k.slot] : null;
    if (!b || b.nation !== holder.nation || b.holder === holder.key || b.pole === t || !(t === e.tile || NB[e.tile].includes(t))) return { ok: false, why: 'tile' };
    if (contested(pv, land, k.slot, r)) return { ok: false, why: 'contested' };
    taken.set(k.slot, (taken.get(k.slot) ?? 0) + 1);
    from.push({ tile: t, slot: k.slot, holder: b.holder });
  }
  const size = open.length + tiles.length;
  for (const [slot, n] of taken) {
    const b = land.banners[slot], lost = from.filter(x => x.holder === b.holder).length;
    if (b.tiles.length - n < N.MIN_PATCH || bannerTilesOf(land, b.holder) - lost < size) return { ok: false, why: 'giver' };
  }
  return { ok: true, tiles, from };
}

/** The patch a banner raised now by this host would hold: `{pole, flower, trail, elbow, size, denied}` (elbow tiles only when the order names them). */
export function patch(pv, land, e, holder, elbow = [], r = pv.resolvedNext) {
  const f = flower(pv, land, e, r);
  // (a pole that stands on a nation-mate's outer tile is the pole's own tile all the same: elbow room names it)
  const tr = trail(pv, land, e, f.tiles, r);
  const open = [...f.tiles.filter(t => t === e.tile ? isOpen(land, t) : true), ...tr];
  const el = elbowRoom(pv, land, e, holder, open, elbow, r);
  const tiles = [...new Set([e.tile, ...open, ...(el.ok ? el.tiles : [])])];
  return { pole: e.tile, flower: f.tiles, trail: tr, elbow: el.ok ? el.tiles : [], elbowFrom: el.ok ? el.from : [], elbowWhy: el.ok ? null : el.why, tiles, size: tiles.length, denied: f.denied };
}

/** The price of a holder's next banner in this province, in Works. */
export function price(pv, land, holder) {
  if (abroad(pv, holder.nation)) return N.PRICE_ABROAD_STEP * (1 + nationBanners(land, holder.nation));
  const over = holder.bannersHeld - N.FREE_BANNERS;
  return over < 0 ? 0 : N.PRICE_THEN[Math.min(over, N.PRICE_THEN.length - 1)];
}
/** The turns a host must have stood to raise here, and the troops it must have at the act. */
export const standToRaise = (pv, nation) => (homeGround(pv, nation) ? N.STAND_HOME : Math.max(1, Math.ceil(N.STAND_ABROAD * ((pv.wedge ?? pv.holderNation) === nation ? N.OWN_WEDGE_FACTOR : 1))));
export const floorFor = (pv, nation) => (homeGround(pv, nation) ? N.FLOOR_HOME : N.FLOOR_ABROAD);
export const capOf = holder => N.CAP_BY_TIER[Math.max(0, Math.min(3, holder.tier ?? 0))];
/** May `nation` come in over border row `d` (it holds the keep or a banner in the province that row faces)? */
const entersOver = (pv, d, nation) => { const f = pv.faces?.[d]; return !!f && f.open !== false && (f.ring ?? 2) >= 2 && (f.holderNation === nation || (f.banners?.[nation] ?? 0) > 0); };
/** Does a patch of `nation` touch land that nation already holds in the province? */
const touchesOwn = (land, tiles, nation) => tiles.some(x => neighbours(x).some(j => { const k = kindOf(land, j); return (k.kind === 'village' && land.villageNation[k.site] === nation) || (k.kind === 'banner' && land.banners[k.slot].nation === nation && !tiles.includes(j)); }));
/** Where a banner may be raised (B7), for the place alone: null, or why not (`ring`, `heartland`, `town`, `touch`). */
function placeWhy(pv, land, holder, pole, tiles) {
  if ((pv.ring ?? 2) < 2) return 'ring';
  if (strangerInHeartland(pv, holder.nation)) return 'heartland';
  if (!abroad(pv, holder.nation)) return null;
  if (!((holder.tier ?? 0) >= 1 && holder.townOk)) return 'town';
  if (touchesOwn(land, tiles, holder.nation)) return null;
  for (let d = 0; d < 6; d++) if (BORDER_ROWS[d].includes(pole) && entersOver(pv, d, holder.nation)) return null;
  return 'touch';
}
const no = (code, need = null, extra = {}) => ({ ok: false, code, need, ...extra });

/**
 * May this host's owner raise a banner where it stands? `{ok: true, tiles, pole, flower, trail, elbow, size, price,
 * waitTolls: 0, stand, firm}` or `{ok: false, code, need}`. What stands in the way for good is said before the
 * count: a host that only has to wait (it has not stood its count, or is still forming) is answered `StandLonger`
 * with `need: {tolls, atTurn}` (`atTurn`: the value `r` must reach) and the patch it would raise (`tiles`, `size`,
 * `price`). `opts`: `{elbow: [tiles], minTiles, maxWorks}`.
 */
export function canRaise(pv, land, e, holder, r = pv.resolvedNext, opts = {}) {
  // (a host that is forming, or stands from a turn not yet resolved, is in the province: it has to wait, like one that has not stood its count)
  if (!e || !(e.state === ROSTER || e.state === MUSTER_PENDING)) return no('NotResident');
  if (e.pendOp !== 0) return no('HostBusy');
  if (e.inTransit) return no('InTransit');
  if (!fighting(e)) return no('Scouts');
  const tile = e.tile, k = kindOf(land, tile), elbow = opts.elbow ?? [];
  if (k.kind === 'site' || (k.kind === 'village' && land.sites[k.site] === tile) || nearCamp(pv, tile)) return no('SiteOrCamp', { why: nearCamp(pv, tile) ? 'camp' : 'site' });
  if (!passable(pv, tile)) return no('NotOpen', { why: 'impassable' });
  if (k.kind === 'village') return no('NotOpen', { why: 'village' });
  if (k.kind === 'banner' && !elbow.includes(tile)) return no('NotOpen', { why: 'banner', slot: k.slot });
  // (two hostile hosts never stand on one tile once a turn is resolved; a preview of a tile an enemy holds is told so)
  if (hostileOn(pv, tile, holder.nation, r).some(x => BigInt(x.id) !== BigInt(e.id))) return no('NotOpen', { why: 'enemy' });
  const early = placeWhy(pv, land, holder, tile, []);
  if (early && early !== 'touch') return no('NotHere', { why: early });
  if (!surveyedFor(pv, land, e)) return no('NotSurveyed');
  // an empty site keeps room: at most two poles may stand next to it
  for (const j of neighbours(tile)) { const s = siteIndex(land, j); if (s >= 0 && land.villageNation[s] === null && neighbours(j).filter(x => land.banners.some(b => b.used && b.pole === x)).length >= N.SITE_POLES) return no('SiteRoom', { site: s }); }
  const floor = floorFor(pv, holder.nation);
  if (e.troops < floor * MILLI) return no('TooFew', { troops: floor, have: Math.floor(e.troops / MILLI) });
  const p = patch(pv, land, e, holder, elbow, r);
  if (elbow.length && p.elbowWhy) return no('ElbowNotAllowed', { why: p.elbowWhy });
  if (p.size < N.MIN_PATCH) return no('PatchTooSmall', { tiles: N.MIN_PATCH, have: p.size });
  if (placeWhy(pv, land, holder, tile, p.tiles)) return no('NotHere', { why: 'touch' });
  const cap = capOf(holder);
  if (holder.bannersHeld >= cap) return no('CapReached', { cap, held: holder.bannersHeld });
  if (slotsOf(land, holder.key).length >= N.PER_PROVINCE) return no('PerProvince', { perProvince: N.PER_PROVINCE });
  if (abroad(pv, holder.nation) && nationLand(land, holder.nation) + p.size > N.CEILING_ABROAD) return no('CeilingReached', { ceiling: N.CEILING_ABROAD, have: nationLand(land, holder.nation) });
  if (!land.banners.some(b => !b.used)) return no('SlotsFull');
  const cost = price(pv, land, holder);
  if ((holder.works ?? 0) < cost) return no('WorksShort', { works: cost, have: holder.works ?? 0, short: cost - (holder.works ?? 0) });
  const stand = standToRaise(pv, holder.nation), would = { tiles: p.tiles, pole: tile, flower: p.flower, trail: p.trail, elbow: p.elbow, size: p.size, price: cost, stand, firm: homeGround(pv, holder.nation) };
  if (e.state !== ROSTER || stood(e, r) < stand) return no('StandLonger', { tolls: stand - stood(e, r), atTurn: e.fromBell + stand }, { ...would, waitTolls: stand - stood(e, r) });
  if ((opts.minTiles ?? 0) > p.size || (opts.maxWorks ?? Infinity) < cost) return no('Changed', { tiles: p.size, works: cost });
  return { ok: true, ...would, waitTolls: 0, elbowFrom: p.elbowFrom };
}

// ------------------------------------------------------------------ the score
/** What each nation is paid for this province a turn: its counted tiles, at most 24 without the keep; the keep holder also takes the rest of the 61. */
export function paid(land, holderNation) {
  const out = land.counted.map((n, i) => (i === holderNation ? 0 : Math.min(n, N.KEEP_SHARE)));
  out[holderNation] = N.TILES - out.reduce((a, b) => a + b, 0);
  return out;
}
function accrueIn(land, holderNation, toTurn) {
  const dt = toTurn - land.cursor;
  if (dt <= 0) return land;
  paid(land, holderNation).forEach((n, i) => { land.totals[i] += n * dt; });
  for (const [key, n] of Object.entries(inNames(land))) land.names[key] = (land.names[key] ?? 0) + n * dt;
  land.cursor = toTurn;
  return land;
}
/** The totals brought forward to `toTurn`: `paid × (toTurn − cursor)`, the cursor moved. A new land record. */
export const accrue = (land, holderNation, toTurn) => accrueIn(cloneLand(land), holderNation, toTurn);

// ------------------------------------------------------------------ firm and loose, the fall, the walk
/** A banner is firm while its nation holds the province's keep (the sample world: in its own nation's wedge), loose elsewhere. */
export const firm = (pv, banner) => banner.nation === pv.holderNation;
/** The nations a banner is loose toward by its border rows (a border banner), its own nation left out. */
export function borderToward(pv, land, slot) {
  const b = land.banners[slot], out = new Set();
  if (!b?.used || pv.heartland) return [];
  for (let d = 0; d < 6; d++) if (BORDER_ROWS[d].some(t => b.tiles.includes(t))) for (let n = 0; n < 6; n++) if (n !== b.nation && entersOver(pv, d, n)) out.add(n);
  return [...out].sort();
}
/**
 * The turns a host of `attackerNation` must stand on the pole to take or pull down the banner: 72 firm, 36 loose (36
 * also for a border banner faced by that nation), halved and rounded up for the wedge's own nation. With `fromBell`
 * (the turn the host stands from) also the turn at which it may act: `{tolls, firm, border, own, atTurn}`.
 */
export function fallTolls(pv, land, slot, attackerNation, fromBell = null) {
  const b = land.banners[slot], isFirm = firm(pv, b), border = borderToward(pv, land, slot).includes(attackerNation), own = (pv.wedge ?? pv.holderNation) === attackerNation;
  const tolls = Math.max(1, Math.ceil((isFirm && !border ? N.FALL_FIRM : N.FALL_LOOSE) * (own ? N.OWN_WEDGE_FACTOR : 1)));
  return { tolls, firm: isFirm, border, own, atTurn: fromBell === null ? null : fromBell + tolls };
}
/** The turn from which the banner may be frayed (its clock + 144 loose, + 432 firm) and the turn from which it may be struck (+ 72). */
export function walkDue(pv, land, slot) {
  const b = land.banners[slot], isFirm = firm(pv, b), limit = isFirm ? N.WALK_FIRM : N.WALK_LOOSE;
  return { clock: b.tendedTurn, firm: isFirm, limit, frayAt: b.tendedTurn + limit, strikeAt: b.tendedTurn + limit + N.GRACE };
}

// ------------------------------------------------------------------ the acts: each brings the totals to r, then changes the land, and writes one record
const begin = (pv, land, r) => accrueIn(cloneLand(land), pv.holderNation, r);
const record = (op, pv, r, slot, b, more = {}) => ({ op, turn: r, p: pv.p, q: pv.q, slot, pole: b?.pole ?? null, nation: b?.nation ?? null, holder: b?.holder ?? null, tiles: b ? [...b.tiles] : [], from: null, works: 0, by: null, ...more });
const freeBanner = (land, slot) => { for (const t of land.banners[slot].tiles) if (land.claim[t] === BANNER0 + slot) land.claim[t] = OPEN; land.banners[slot] = blank(); };

/**
 * A village takes its land (B2): its site and, with `ring`, each neighbour that is open ground or an outer tile of a
 * nation-mate's banner that is not contested (never a site, another village's land, another nation's banner, a pole).
 * `{ok, land, log}`; the log is a HEARTH record.
 */
export function hearth(pv, land, { site, nation, holder, ring = true }, r = pv.resolvedNext) {
  const L = begin(pv, land, r), tile = L.sites[site], tiles = [tile], from = [];
  L.claim[tile] = site; L.villageNation[site] = nation; L.villageHolder[site] = holder;
  if (ring) for (const j of neighbours(tile)) {
    const k = kindOf(L, j);
    if (k.kind === 'banner') {
      const b = L.banners[k.slot];
      if (b.nation !== nation || b.pole === j || contested(pv, L, k.slot, r)) continue;
      b.tiles = b.tiles.filter(x => x !== j); from.push({ tile: j, slot: k.slot, holder: b.holder });
    } else if (k.kind !== 'open') continue;
    L.claim[j] = site; tiles.push(j);
  }
  recount(L);
  return { ok: true, land: L, log: { op: 'HEARTH', turn: r, p: pv.p, q: pv.q, slot: null, site, pole: tile, nation, holder, tiles, from: null, fromTiles: from, works: 0, by: holder } };
}

/** Raise the banner `canRaise` allows: `{ok, land, log, price}` (the log is a RAISE record; `log.fromTiles` are the tiles elbow room took), or the refusal. */
export function raise(pv, land, e, holder, r = pv.resolvedNext, opts = {}) {
  const c = canRaise(pv, land, e, holder, r, opts);
  if (!c.ok) return c;
  const L = begin(pv, land, r), slot = L.banners.findIndex(b => !b.used);
  for (const x of c.elbowFrom) L.banners[x.slot].tiles = L.banners[x.slot].tiles.filter(t => t !== x.tile);
  for (const t of c.tiles) L.claim[t] = BANNER0 + slot;
  const b = L.banners[slot] = { used: true, frayed: false, elbow: c.elbow.length > 0, pole: e.tile, nation: holder.nation, tiles: [...c.tiles], raisedTurn: r, tendedTurn: r, dressDay: -1, holder: holder.key };
  recount(L);
  return { ok: true, land: L, price: c.price, slot, elbowUsed: c.elbow.length > 0,
    log: record('RAISE', pv, r, slot, b, { works: c.price, by: holder.key, host: String(e.id), flower: c.flower, trail: c.trail, elbow: c.elbow, fromTiles: c.elbowFrom, firm: c.firm }) };
}

/**
 * Widen a banner by one tile (B8), once a game day: a passable, open, explored tile within two steps of the pole and
 * next to the patch, not denied to the host that stands by, with a host of the holder (scouts too) on it or next to it.
 */
export function dress(pv, land, e, holder, r = pv.resolvedNext, { slot, tile } = {}) {
  const b = land.banners[slot];
  if (!b?.used || b.holder !== holder.key) return no('NotYours');
  if (contested(pv, land, slot, r)) return no('Contested');
  if (b.dressDay === dayOf(r)) return no('DressedToday', { day: dayOf(r) + 1, turn: (dayOf(r) + 1) * N.DAY });
  if (b.tiles.length >= N.PATCH_MAX) return no('PatchFull', { max: N.PATCH_MAX });
  if (!(tile >= 0 && tile < N.TILES) || !isOpen(land, tile) || !passable(pv, tile) || liveCamp(pv) === tile) return no('NotOpen');
  if (!explored(pv, tile)) return no('NotSurveyed');
  if (steps(tile, b.pole) > N.REACH || !neighbours(tile).some(j => b.tiles.includes(j))) return no('TooFar', { reach: N.REACH });
  if (!stands(pv, e, r) || e.holder !== holder.key || !(e.tile === tile || NB[tile].includes(e.tile))) return no('NoHostBeside');
  if (deniedWhy(pv, tile, b.nation, e.troops, r)) return no('Denied', { why: deniedWhy(pv, tile, b.nation, e.troops, r) });
  if (abroad(pv, b.nation) && nationLand(land, b.nation) + 1 > N.CEILING_ABROAD) return no('CeilingReached', { ceiling: N.CEILING_ABROAD });
  const L = begin(pv, land, r), B = L.banners[slot];
  L.claim[tile] = BANNER0 + slot; B.tiles.push(tile); B.dressDay = dayOf(r);
  if (firm(pv, B)) { B.tendedTurn = r; B.frayed = false; }   // dressing a firm banner counts as walking it
  recount(L);
  return { ok: true, land: L, walked: true, log: record('DRESS', pv, r, slot, B, { by: holder.key, host: String(e.id), tile }) };
}

/** What stops a take (so that only pulling down is left), or null: cap, perProvince, ceiling, town, place. */
export function takeStop(pv, land, slot, holder) {
  const b = land.banners[slot], home = !abroad(pv, holder.nation);
  if (!home && !((holder.tier ?? 0) >= 1 && holder.townOk)) return 'town';
  if (!home && !touchesOwn(land, b.tiles, holder.nation) && ![0, 1, 2, 3, 4, 5].some(d => BORDER_ROWS[d].some(t => b.tiles.includes(t)) && entersOver(pv, d, holder.nation))) return 'place';
  if (holder.bannersHeld >= capOf(holder)) return 'cap';
  if (slotsOf(land, holder.key).length >= N.PER_PROVINCE) return 'perProvince';
  if (!home && nationLand(land, holder.nation) + b.tiles.length > N.CEILING_ABROAD) return 'ceiling';
  return null;
}
/** May this host take or pull down the banner on whose pole it stands? `{ok, tolls, atTurn, stop}` (`stop`: why only pulling down is left, or null) or the refusal. */
export function canFell(pv, land, e, holder, r = pv.resolvedNext, { slot } = {}) {
  const b = land.banners[slot];
  if (!present(e, r)) return no('NotResident');
  if (!b?.used || e.tile !== b.pole) return no('NotOnPole');
  if (b.nation === holder.nation) return no('SameNation');
  if (e.pendOp !== 0) return no('HostBusy');
  if (e.inTransit) return no('InTransit');
  if (!fighting(e)) return no('Scouts');
  if (strangerInHeartland(pv, holder.nation)) return no('Heartland');
  const floor = floorFor(pv, holder.nation), f = fallTolls(pv, land, slot, holder.nation, e.fromBell), stop = takeStop(pv, land, slot, holder);
  if (e.troops < floor * MILLI) return no('TooFew', { troops: floor, have: Math.floor(e.troops / MILLI) }, { tolls: f.tolls, atTurn: f.atTurn, stop });
  if (stood(e, r) < f.tolls) return no('StandLonger', { tolls: f.tolls - stood(e, r), atTurn: f.atTurn }, { tolls: f.tolls, atTurn: f.atTurn, stop });
  return { ok: true, tolls: f.tolls, atTurn: f.atTurn, stop };
}
/** Take the banner (the whole patch, in the taker's name), or pull it down with a note when a take is not allowed here. */
export function take(pv, land, e, holder, r = pv.resolvedNext, { slot } = {}) {
  const c = canFell(pv, land, e, holder, r, { slot });
  if (!c.ok) return c;
  if (c.stop) return { ...pullDown(pv, land, e, holder, r, { slot }), note: c.stop };
  const L = begin(pv, land, r), B = L.banners[slot], old = { nation: B.nation, holder: B.holder };
  Object.assign(B, { nation: holder.nation, holder: holder.key, raisedTurn: r, tendedTurn: r, frayed: false, elbow: false });
  recount(L);
  return { ok: true, land: L, taken: true, old, log: record('TAKE', pv, r, slot, B, { from: old.nation, fromHolder: old.holder, by: holder.key, host: String(e.id) }) };
}
/** Pull the banner down: its patch returns to open ground. */
export function pullDown(pv, land, e, holder, r = pv.resolvedNext, { slot } = {}) {
  const c = canFell(pv, land, e, holder, r, { slot });
  if (!c.ok) return c;
  const L = begin(pv, land, r), B = L.banners[slot], old = { nation: B.nation, holder: B.holder };
  const log = record('PULL', pv, r, slot, B, { from: old.nation, fromHolder: old.holder, by: holder.key, host: String(e.id), note: c.stop });
  freeBanner(L, slot); recount(L);
  return { ok: true, land: L, taken: false, old, log };
}
/** A nation-mate whose host has stood one turn on the pole of a banner past its grace takes it over (a take under that player's own cap). */
export function takeOver(pv, land, e, holder, r = pv.resolvedNext, { slot } = {}) {
  const b = land.banners[slot];
  if (!b?.used || !stands(pv, e, r) || e.tile !== b.pole || b.nation !== holder.nation || !fighting(e)) return no('NotOnPole');
  if (stood(e, r) < N.TAKE_OVER_STAND) return no('StandLonger', { tolls: N.TAKE_OVER_STAND - stood(e, r), atTurn: e.fromBell + N.TAKE_OVER_STAND });
  const w = walkDue(pv, land, slot);
  if (r < w.strikeAt) return no('NotPastGrace', { turn: w.strikeAt });
  if (b.holder !== holder.key && holder.bannersHeld >= capOf(holder)) return no('CapReached', { cap: capOf(holder), held: holder.bannersHeld });
  if (b.holder !== holder.key && slotsOf(land, holder.key).length >= N.PER_PROVINCE) return no('PerProvince', { perProvince: N.PER_PROVINCE });
  const L = begin(pv, land, r), B = L.banners[slot], old = { nation: B.nation, holder: B.holder };
  Object.assign(B, { holder: holder.key, raisedTurn: r, tendedTurn: r, frayed: false, elbow: false });
  recount(L);
  return { ok: true, land: L, old, log: record('TAKEOVER', pv, r, slot, B, { from: old.nation, fromHolder: old.holder, by: holder.key, host: String(e.id) }) };
}
/**
 * Walk a banner (B13). Loose: a fighting host of 500 or more of the banner's nation standing in the patch (a
 * nation-mate's too). Firm: any host of the holder, scouts too, in the patch or next to it. In both the host must have
 * arrived since the banner was last walked.
 */
export function tend(pv, land, e, holder, r = pv.resolvedNext, { slot } = {}) {
  const b = land.banners[slot];
  if (!b?.used) return no('TooLate');
  if (!stands(pv, e, r)) return no(e && e.inTransit ? 'InTransit' : e && e.pendOp ? 'HostBusy' : 'NotResident');
  if (strangerInHeartland(pv, holder.nation)) return no('Heartland');
  if (firm(pv, b)) {
    if (b.holder !== holder.key || e.holder !== holder.key) return no('NotYours');
    if (!(b.tiles.includes(e.tile) || b.tiles.some(t => NB[t].includes(e.tile)))) return no('NotBeside');
  } else {
    if (b.nation !== holder.nation || e.faction !== b.nation) return no('NotYours');
    if (!b.tiles.includes(e.tile)) return no('NotInPatch');
    if (!fighting(e) || e.troops < N.WALK_LOOSE_TROOPS * MILLI) return no('TooFew', { troops: N.WALK_LOOSE_TROOPS, have: Math.floor(e.troops / MILLI) });
  }
  if (!(e.fromBell > b.tendedTurn)) return no('NotArrivedSince', { since: b.tendedTurn });
  const L = begin(pv, land, r), B = L.banners[slot], was = B.frayed;
  B.tendedTurn = r; B.frayed = false;
  recount(L);
  return { ok: true, land: L, walked: true, log: record('TEND', pv, r, slot, B, { by: holder.key, host: String(e.id), restored: was }) };
}
/** Mark a banner past its limit as frayed: from `r` its tiles pay the keep holder (anyone may send it; `by` says who did). */
export function fray(pv, land, r = pv.resolvedNext, { slot, by = null } = {}) {
  const b = land.banners[slot];
  if (!b?.used || b.frayed || r < walkDue(pv, land, slot).frayAt) return no('NotDue', b?.used && !b.frayed ? { turn: walkDue(pv, land, slot).frayAt } : null);
  const L = begin(pv, land, r), B = L.banners[slot];
  B.frayed = true;
  recount(L);
  return { ok: true, land: L, log: record('FRAY', pv, r, slot, B, { by }) };
}
/**
 * Strike a banner: its tiles return to open ground. `reason`: `own` (its holder, never while contested, nor inside
 * the 432 turns after a raise with elbow room), `grace` (72 turns past its limit), `stump` (under three tiles and a
 * clock 144 turns old).
 */
export function strike(pv, land, r = pv.resolvedNext, { slot, reason = 'own', holder = null, by = null } = {}) {
  const b = land.banners[slot];
  if (!b?.used) return no(reason === 'own' ? 'NotYours' : 'NotDue');
  if (reason === 'own') {
    if (!holder || b.holder !== holder.key) return no('NotYours');
    if (contested(pv, land, slot, r)) return no('Contested');
    if (b.elbow && r < b.raisedTurn + N.ELBOW_LOCK) return no('ElbowLocked', { turn: b.raisedTurn + N.ELBOW_LOCK });
  } else if (reason === 'grace') {
    if (r < walkDue(pv, land, slot).strikeAt) return no('NotDue', { turn: walkDue(pv, land, slot).strikeAt });
  } else if (reason === 'stump') {
    if (!(b.tiles.length < N.STUMP_TILES && r - b.tendedTurn >= N.STUMP_AGE)) return no('NotDue', b.tiles.length < N.STUMP_TILES ? { turn: b.tendedTurn + N.STUMP_AGE } : null);
  } else return no('NotDue');
  const L = begin(pv, land, r), B = L.banners[slot], old = { nation: B.nation, holder: B.holder };
  const log = record('STRIKE', pv, r, slot, B, { from: old.nation, fromHolder: old.holder, reason, by: by ?? holder?.key ?? null });
  freeBanner(L, slot); recount(L);
  return { ok: true, land: L, old, log };
}

/** Write a host's trail (SettleTransit, on the fate Stays): `tiles`, nearest the arrival tile first, stamped with the entry's `fromBell`. `{land, log}`; the log is a TRAIL record. */
export function writeTrail(pv, land, e, tiles, r = pv.resolvedNext) {
  const L = cloneLand(land), kept = tiles.slice(0, N.TRAIL_STEPS);
  L.trails.set(String(e.id), { stamp: e.fromBell, tile: e.tile, nation: e.faction, tiles: kept });
  return { ok: true, land: L, log: { op: 'TRAIL', turn: r, p: pv.p, q: pv.q, slot: null, pole: e.tile, nation: e.faction, holder: e.holder ?? null, tiles: kept, from: null, works: 0, by: e.holder ?? null, host: String(e.id) } };
}
/** The trail records that are still their host's: `[{host, nation, tile, tiles}]`. */
export function trails(pv, land) {
  return [...land.trails].map(([id, t]) => { const e = pv.entries.find(x => String(x.id) === id && x.state === ROSTER); return e && trailOf(land, e) ? { host: id, nation: t.nation, tile: t.tile, tiles: [...t.tiles] } : null; }).filter(Boolean);
}

/**
 * Making room in a full province (B14): the host of `nation` that gives way to a newcomer of `newcomerOwner` bound for
 * `tile`, or null (nobody has to: the eight places are not full; or nobody qualifies). The sample world does not call
 * it. `pv.keepTile`: the keep's tile, whose host never gives way.
 */
export function giveWay(pv, land, nation, newcomerOwner, tile, r = pv.resolvedNext) {
  const mine = pv.entries.filter(e => (e.state === ROSTER || e.state === MUSTER_PENDING) && e.faction === nation);
  if (mine.length < N.ROOM_FULL) return null;
  const relief = pv.entries.some(x => present(x, r) && fighting(x) && x.faction !== nation && x.tile === tile);
  const count = key => mine.filter(e => e.holder === key).length, onPole = e => land.banners.some(b => b.used && b.pole === e.tile);
  const ok = mine.filter(e => e.tile !== (pv.keepTile ?? -1) && (relief || count(e.holder) >= count(newcomerOwner) + N.ROOM_FAIR_SHARE || (!onPole(e) && present(e, r) && stood(e, r) >= N.ROOM_STALE)));
  ok.sort((a, b) => Number(onPole(a)) - Number(onPole(b)) || Number(fighting(a)) - Number(fighting(b)) || a.fromBell - b.fromBell || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return ok[0] ?? null;
}
