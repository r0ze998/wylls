// PLAYER TERRITORY as ONE player sees it in a local-play TEST world (ws13-territory, 2026-11-25). KEY-FREE, read-only.
//
// The rules are #209's (owner 2026-11-24 12:09 / 13:15; the page's own module flocalplay-territory.mjs: TERRITORY_V1,
// claimCostV1, tileUpkeepV1, the two records' decoders and addresses). Nothing here is a rule and nothing is sent:
// this file only READS, for the read-only local-play MCP server (local-play-game.mjs, tool get_territory_status) and
// for workstream 13's resident (resident/local/territory.mjs), and answers one question — "what does THIS player know
// about its own land and the land it could claim?":
//
//   its own summary     the territory player record of its own Citizen ('wu', 320 B): tiles, upkeep per hour, unpaid
//                       since, the claims of this turn → the next claim's price (10 ore + 2 % per tile owned, rounded
//                       down) and whether a claim can be asked now
//   its own tiles       the tiles its Citizen tag owns in the territory province records ('wn', 672 B) of the provinces
//                       a claim of its could reach (its first home, a province where it owns a tile, its nation's land)
//   claimable tiles     in those provinces: tiles nobody owns and that are not the keep's — but ONLY where the player
//                       SEES the tile (below). A tile out of its sight is listed as `unseen`: its owner is not said
//                       (it may be free or another player's; a claim on it is the program's to refuse, exactly as the
//                       page's "Claim a tile" row, which also names a tile without knowing).
//
// FOG (the page's player view, map/fog.mjs — presentation, every account is public on the chain): a tile is in sight
// when it is within the sight of one of the player's own villages (map/survey.mjs SIGHT.village), of a nation-mate's
// village, or of a province its nation holds (FOG_RULES.nationVillage / territory) — the page's own numbers. The
// anchors are read only from the provinces this reader captured (the reachable ones): a smaller sight than the page's,
// never a larger one (own hosts and nation-mates' villages elsewhere are not counted). What is NEVER hidden: the
// player's own tiles and summary, and the land's fixed layout (which tile is a village site, which is the keep's — the
// page's claim card reads the same from the herald's capture, in sight or not). What is hidden out of sight: who owns a
// tile, and whether a site has a village.
//
// Reads (both the page's own): the herald's public `/h/world/wide/route` (at most four province captures a request),
// and `read(addresses)` → Uint8Array | null per address — the relay's read-only account read
// (`frontier-local-play-act-wide-read-v1`: one getMultipleAccounts, program-owned accounts only, nothing sent).
import { TERRITORY_V1, claimCostV1, tileUpkeepV1, territoryProvinceAddress, territoryPlayerAddress, decodeTerritoryProvince, decodeTerritoryPlayer, citizenTagOf, nearerOwnVillage } from '../../../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { distance, isNationLandBytes, FIRST_WIDE_RING } from '../../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { ringPosition } from '../../../../permutation-server/web/frontier/map/wide.mjs';
import { tileHex, provinceCentre, hexDistance, TILE_OFFSETS } from '../../../../permutation-server/web/frontier/fgeo.mjs';
import { SIGHT } from '../../../../permutation-server/web/frontier/map/survey.mjs';
import { FOG_RULES } from '../../../../permutation-server/web/frontier/map/fog.mjs';

export const TERRITORY_VIEW_KIND = 'wylls-local-territory-view/1';
/** The relay's read-only account read (gateway local-play-act.mjs LOCAL_ACT_WIDE_READ_SCHEMA / _MAX). */
export const WIDE_READ_SCHEMA = 'frontier-local-play-act-wide-read-v1', WIDE_READ_MAX = 16;
/** The herald's `/h/world/wide/route` takes at most this many provinces a request (herald wide.rs MAX_ROUTE_COORDS). */
export const ROUTE_MAX = 4;
/** Provinces one view reads at most (the reachable ones, nearest the home first), and the rounds reach is followed. */
export const VIEW_LIMITS = Object.freeze({ provinces: 40, rounds: 3, captureTtlMs: 8_000 });
/** frontier-abi world_index/territory.rs SITE_NEIGHBOUR_TILES: a village may not stand next to a village (TQ-6 (b)). */
export const SITE_NEIGHBOUR_TILES = 3;

// a wide province's captured bytes (Province v2, 4,864 B): SITES @250 × 12, SITE_COUNT @262, the site mirror @296 × 64
// (STATE @0: 0 free, 1 a village, 3 released; FACTION @1), the keep @4480 (tile, holder), the territory rule @4789
const CAPTURE_BYTES = 4864, SITES_AT = 250, SITE_COUNT_AT = 262, MIRROR_AT = 296, MIRROR_BYTES = 64, KEEP_AT = 4480, TERRITORY_AT = 4789, NO_TILE = 0xff;
const SITE_FREE = [0, 3], SITE_VILLAGE = 1;

const key = (p, q) => `${p},${q}`;
const isWide = (p, q) => { try { return ringPosition(BigInt(p), BigInt(q)).ring >= FIRST_WIDE_RING; } catch { return false; } };
const b64 = s => (typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), c => c.charCodeAt(0)));

/** The wide provinces within `range` of `centre` (`{p, q}`, numbers or decimal strings) → `[{p, q}]` decimal strings. */
export function wideDisc(centre, range = TERRITORY_V1.range) {
  const out = [], cp = BigInt(centre.p), cq = BigInt(centre.q);
  for (let dp = -range; dp <= range; dp++) for (let dq = Math.max(-range, -dp - range); dq <= Math.min(range, -dp + range); dq++) {
    const p = cp + BigInt(dp), q = cq + BigInt(dq);
    if (isWide(p, q)) out.push({ p: String(p), q: String(q) });
  }
  return out;
}

/**
 * A captured wide province's facts for territory, or null (not a capture, or a province of a world without territory):
 * `{siteTiles: [tile] by site, siteStates: [state], siteFactions: [faction], keepTile, keepHolder, bytes}`.
 */
export function captureFacts(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== CAPTURE_BYTES || bytes[TERRITORY_AT] !== 1) return null;
  const n = Math.min(bytes[SITE_COUNT_AT], 12);
  const siteTiles = Array.from(bytes.subarray(SITES_AT, SITES_AT + n)), siteStates = [], siteFactions = [];
  for (let i = 0; i < n; i++) { siteStates.push(bytes[MIRROR_AT + i * MIRROR_BYTES]); siteFactions.push(bytes[MIRROR_AT + i * MIRROR_BYTES + 1]); }
  return { siteTiles, siteStates, siteFactions, keepTile: bytes[KEEP_AT] === NO_TILE ? null : bytes[KEEP_AT], keepHolder: bytes[KEEP_AT + 1], bytes };
}

/** Whether two tiles of one province are neighbours for TQ-6 (b) (≤ SITE_NEIGHBOUR_TILES apart). */
export function tilesNear(a, b, n = SITE_NEIGHBOUR_TILES) {
  const x = TILE_OFFSETS[a], y = TILE_OFFSETS[b];
  return !!x && !!y && hexDistance(x.q, x.r, y.q, y.r) <= n;
}

/**
 * The player's sight anchors `[{q, r, radius}]` (hexes) from what was captured: its own villages (`home` `{p, q, tile,
 * tier}`; `villages` `[{p, q, site}]` with their site's tile from the capture), nation-mates' villages and the
 * provinces its nation's keep holds among `caps` (Map "p,q" → captureFacts).
 */
export function sightAnchors({ home, villages = [], faction, caps }) {
  const out = [];
  const at = (p, q, tile, radius) => { const h = Number.isInteger(tile) ? tileHex(Number(p), Number(q), tile) : provinceCentre(Number(p), Number(q)); if (h) out.push({ q: h.q, r: h.r, radius }); };
  if (home) at(home.p, home.q, home.tile, SIGHT.village(Number.isInteger(home.tier) ? home.tier : 0));
  for (const v of villages) at(v.p, v.q, caps.get(key(v.p, v.q))?.siteTiles?.[v.site], SIGHT.village(0));
  for (const [k, c] of caps) {
    if (!c) continue;
    const [p, q] = k.split(',');
    if (c.keepHolder === faction) { const ctr = provinceCentre(Number(p), Number(q)); out.push({ q: ctr.q, r: ctr.r, radius: FOG_RULES.territory }); }
    c.siteStates.forEach((s, i) => { if (s === SITE_VILLAGE && c.siteFactions[i] === faction) at(p, q, c.siteTiles[i], FOG_RULES.nationVillage(0)); });
  }
  return out;
}
/** Whether tile `tile` of province (p, q) is within one of `anchors`. */
export function tileInSight(anchors, p, q, tile) {
  const h = tileHex(Number(p), Number(q), tile);
  return !!h && anchors.some(a => hexDistance(a.q, a.r, h.q, h.r) <= a.radius);
}

/**
 * One province of the view (pure). `cap`: captureFacts; `rec`: decodeTerritoryProvince's answer or null (no record:
 * nobody has claimed there); `tag`: the player's Citizen tag (decimal string); `seen(tile)` → in sight.
 * → `{own, free, taken, unseen, sites}`: tile indices (the keep's tile is in none of them); `sites` by site:
 * `{site, tile, mine, village, crowded}` — `village` true / false, or null out of sight; `crowded` (a village on a
 * neighbouring site: the program refuses ReservedSite) true / false, or null when a neighbouring site is out of sight
 * and none in sight has a village.
 */
export function provinceTiles(cap, rec, tag, seen) {
  const own = [], free = [], taken = [], unseen = [];
  for (let t = 0; t < 61; t++) {
    if (t === cap.keepTile) continue;
    const o = rec?.owners?.[t] ?? null;
    if (o !== null && o === tag) own.push(t);
    else if (!seen(t)) unseen.push(t);
    else if (o === null) free.push(t);
    else taken.push(t);
  }
  const sites = cap.siteTiles.map((tile, site) => {
    const inSight = seen(tile), state = cap.siteStates[site];
    let crowded = false, blind = false;
    cap.siteTiles.forEach((u, j) => {
      if (j === site || !tilesNear(tile, u)) return;
      if (!seen(u)) blind = true; else if (cap.siteStates[j] === SITE_VILLAGE) crowded = true;
    });
    return { site, tile, mine: own.includes(tile), village: inSight ? state === SITE_VILLAGE : null, open: inSight ? SITE_FREE.includes(state) : null, crowded: crowded ? true : blind ? null : false };
  });
  return { own, free, taken, unseen, sites };
}

/** The reach of a claim on `t` (`{p, q}`): from the home, else the nearest province where the player owns a tile
 * (witness 'own'; the province itself counts), else its nation's land (witness 'nation', never the target itself). */
export function reachOf(home, t, { ownAt = [], lands = [] } = {}) {
  if (distance(home, t) <= TERRITORY_V1.range) return { kind: 'home' };
  const near = (list, self) => list.filter(l => (self || key(l.p, l.q) !== key(t.p, t.q)) && distance(l, t) <= TERRITORY_V1.range)
    .sort((a, b) => distance(a, t) - distance(b, t) || (key(a.p, a.q) < key(b.p, b.q) ? -1 : 1))[0] ?? null;
  const o = near(ownAt, true); if (o) return { kind: 'own', p: String(o.p), q: String(o.q) };
  const n = near(lands, false); if (n) return { kind: 'nation', p: String(n.p), q: String(n.q) };
  return null;
}

/** The upkeep distance a tile at `t` would be fixed at (TQ-2: from the nearest own village, the first home included). */
export function upkeepDistance(home, t, villages = []) {
  const v = nearerOwnVillage(home, t, villages);
  return { dist: v ? distance(v, t) : distance(home, t), village: v };
}

/**
 * The reader of one world: `view({wallet, home, faction, villages, bell})` → the territory view (below), reading the
 * player record, the reachable provinces' captures and their territory records. `addresses`: the page's
 * `seasonAddresses(programId, seasonId)` (`.season`, `.of('Citizen', {wallet})`). `getJson(url)` → the herald's JSON;
 * `read(addresses)` → `[Uint8Array | null]`. Captures are reused for VIEW_LIMITS.captureTtlMs; records are read each time.
 *
 * The view:
 *   {kind, on: true, bell, rule, own: {record, tiles, list: [{p, q, tile, upkeepDistance, upkeepMilliFoodPerHour}],
 *     listComplete, nextClaimOre, upkeepMilliFoodPerHour, unpaid, unpaidSinceBell, decayFromBell, claimsThisTurn,
 *     claimsPerTurn, tag}, provinces: [{p, q, distance, reach, upkeepDistance, upkeepVillage, tileUpkeepMilliFoodPerHour,
 *     keepTile, siteTiles, own, free, taken, unseen, sites}], sight: {anchors}, reads}
 *   {kind, on: false, why}   a world without player territory (no captured province plays the rule)
 *   {kind, on: null, why}    not known (nothing readable within reach)
 */
export function createTerritoryReader({ herald, addresses, programId, getJson, read, now = () => Date.now(), limits = VIEW_LIMITS }) {
  const base = String(herald).replace(/\/+$/, '');
  const capCache = new Map();   // "p,q" → {at, facts | null, raw: bytes | null}
  async function captures(list) {
    const t = now(), want = list.filter(c => !(capCache.has(key(c.p, c.q)) && t - capCache.get(key(c.p, c.q)).at < limits.captureTtlMs));
    for (let i = 0; i < want.length; i += ROUTE_MAX) {
      const part = want.slice(i, i + ROUTE_MAX);
      let j = null;
      try { j = await getJson(`${base}/h/world/wide/route?at=${encodeURIComponent(part.map(c => key(c.p, c.q)).join(';'))}`); } catch { j = null; }
      const got = new Map();
      for (const r of Array.isArray(j?.route) ? j.route : []) { try { if (typeof r?.capture?.bytes_b64 === 'string') got.set(key(r.p, r.q), b64(r.capture.bytes_b64)); } catch { /* unreadable */ } }
      // (no answer at all: not cached — asked again next time; an answer without that province: not opened yet)
      if (j) for (const c of part) { const raw = got.get(key(c.p, c.q)) ?? null; capCache.set(key(c.p, c.q), { at: t, raw, facts: raw ? captureFacts(raw) : null }); }
    }
    return list.map(c => capCache.get(key(c.p, c.q)) ?? null);
  }
  async function readMany(list) {
    const out = [];
    for (let i = 0; i < list.length; i += WIDE_READ_MAX) out.push(...await read(list.slice(i, i + WIDE_READ_MAX)));
    return out;
  }
  return Object.freeze({
    async view({ wallet, home, faction, villages = [], bell = null }) {
      const reads = { captures: 0, records: 0 };
      const citizen = addresses.of('Citizen', { wallet }), tag = citizenTagOf(citizen);
      const homeAt = { p: String(home.p), q: String(home.q) };
      // the reachable provinces, round by round: the home's disc, then the discs of where the player owns a tile and of its nation's land
      const caps = new Map(), recs = new Map(), raws = new Map();
      let frontier = wideDisc(homeAt), answered = 0;
      for (const v of villages) for (const c of wideDisc(v, 0)) frontier.push(c);   // (its own wide villages' provinces: the sight's anchors)
      if (!frontier.length) return { kind: TERRITORY_VIEW_KIND, on: null, bell, why: `the first home is more than ${TERRITORY_V1.range} provinces from the wide land and the owner has no wide village: no tile is within reach (player territory is on the wide land)`, reads };
      for (let round = 0; round < limits.rounds && frontier.length && caps.size < limits.provinces; round++) {
        const todo = [];
        for (const c of frontier.sort((a, b) => distance(homeAt, a) - distance(homeAt, b) || (key(a.p, a.q) < key(b.p, b.q) ? -1 : 1))) {
          if (caps.has(key(c.p, c.q)) || todo.some(x => key(x.p, x.q) === key(c.p, c.q))) continue;
          if (caps.size + todo.length >= limits.provinces) break;
          todo.push(c);
        }
        const got = await captures(todo);
        reads.captures += todo.length;
        const fresh = [];
        todo.forEach((c, i) => { if (got[i]) answered++; caps.set(key(c.p, c.q), got[i]?.facts ?? null); raws.set(key(c.p, c.q), got[i]?.raw ?? null); if (got[i]?.facts) fresh.push(c); });
        if (fresh.length) {
          const rows = await readMany(fresh.map(c => territoryProvinceAddress(addresses.season, programId, c.p, c.q)));
          reads.records += fresh.length;
          fresh.forEach((c, i) => recs.set(key(c.p, c.q), rows[i] ? decodeTerritoryProvince(rows[i]) : null));
        }
        frontier = [];
        for (const c of fresh) {
          const mine = (recs.get(key(c.p, c.q))?.owners ?? []).some(o => o === tag), land = isNationLandBytes(raws.get(key(c.p, c.q)), faction);
          if (mine || land) frontier.push(...wideDisc(c));
        }
      }
      const provs = [...caps.entries()].filter(([, f]) => f).map(([k, f]) => { const [p, q] = k.split(','); return { p, q, cap: f, rec: recs.get(k) ?? null }; });
      if (!provs.length) {
        return answered ? { kind: TERRITORY_VIEW_KIND, on: false, bell, why: 'no opened wide province within reach plays the player-territory rule', reads }
          : { kind: TERRITORY_VIEW_KIND, on: null, bell, why: 'no wide province within reach could be read from the herald', reads };
      }
      const [plBytes] = await read([territoryPlayerAddress(addresses.season, programId, citizen)]);
      const pl = plBytes ? decodeTerritoryPlayer(plBytes) : null;
      if (plBytes && (!pl || pl.citizenTag !== tag)) return { kind: TERRITORY_VIEW_KIND, on: null, bell, why: 'my territory record is not readable', reads };
      const anchors = sightAnchors({ home, villages, faction, caps: new Map(provs.map(x => [key(x.p, x.q), x.cap])) });
      const ownAt = provs.filter(x => (x.rec?.owners ?? []).some(o => o === tag)).map(x => ({ p: x.p, q: x.q }));
      const lands = provs.filter(x => isNationLandBytes(x.cap.bytes, faction)).map(x => ({ p: x.p, q: x.q }));
      const list = [], provinces = [];
      for (const x of provs) {
        const reach = reachOf(homeAt, x, { ownAt, lands });
        const tiles = provinceTiles(x.cap, x.rec, tag, t => tileInSight(anchors, x.p, x.q, t));
        for (const t of tiles.own) { const d = x.rec.dist[t]; list.push({ p: x.p, q: x.q, tile: t, upkeepDistance: d, upkeepMilliFoodPerHour: tileUpkeepV1(d) }); }
        if (!reach && !tiles.own.length) continue;   // (captured for the sight only: not a province a claim of mine reaches)
        const u = upkeepDistance(homeAt, x, villages);
        provinces.push({ p: x.p, q: x.q, distance: distance(homeAt, x), reach, upkeepDistance: u.dist, upkeepVillage: u.village, tileUpkeepMilliFoodPerHour: tileUpkeepV1(u.dist),
          keepTile: x.cap.keepTile, siteTiles: x.cap.siteTiles, ...tiles });
      }
      provinces.sort((a, b) => a.distance - b.distance || (key(a.p, a.q) < key(b.p, b.q) ? -1 : 1));
      const tilesN = pl?.tiles ?? 0, since = pl?.unpaid ? pl.unpaidSince : null;
      return { kind: TERRITORY_VIEW_KIND, on: true, bell,
        rule: { claimOre: { base: TERRITORY_V1.cost.base, perOwnedBps: TERRITORY_V1.cost.perOwnedBps }, upkeepMilliFoodPerHour: { perTile: TERRITORY_V1.upkeep.flat, perProvinceBeyond: TERRITORY_V1.upkeep.perDistance, freeProvinces: TERRITORY_V1.upkeep.freeDistance },
          range: TERRITORY_V1.range, claimsPerTurn: TERRITORY_V1.claimsPerTurn, decayAfterTurns: TERRITORY_V1.decayAfterBells },
        own: { record: pl ? 'read' : 'none', tag, tiles: tilesN, list, listComplete: list.length === tilesN, nextClaimOre: claimCostV1(tilesN), upkeepMilliFoodPerHour: pl?.upkeepMilliPerHour ?? 0,
          unpaid: pl?.unpaid === true, unpaidSinceBell: since, decayFromBell: since === null ? null : since + TERRITORY_V1.decayAfterBells,
          claimsThisTurn: pl && Number.isInteger(bell) && pl.lastClaimBell === bell ? pl.claimsInBell : 0, claimsPerTurn: TERRITORY_V1.claimsPerTurn },
        provinces, sight: { anchors: anchors.length }, reads };
    },
  });
}

/**
 * Whether the player may ask for a claim now, by what it read (pure; the program decides): `view` (on), `ore` the
 * first home's ore (whole units, or null when not read). → `{ok, why: [..]}`.
 */
export function claimNow(view, { ore = null } = {}) {
  const why = [];
  if (view?.on !== true) return { ok: false, why: [view?.why ?? 'player territory is not read'] };
  const o = view.own;
  if (o.claimsThisTurn >= o.claimsPerTurn) why.push(`this turn's claim is used (${o.claimsPerTurn} a turn)`);
  if (o.unpaid) why.push(`my land's upkeep is unpaid since turn ${o.unpaidSinceBell}: the world refuses new claims (a tile returns from turn ${o.decayFromBell}, one a turn)`);
  if (Number.isFinite(ore) && ore < o.nextClaimOre) why.push(`the next tile costs ${o.nextClaimOre} ore; my first home has ${Math.floor(ore)}`);
  return { ok: why.length === 0, why };
}
