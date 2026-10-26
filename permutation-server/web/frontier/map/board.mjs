// The board's records (UX design 14.3, 14.4): what the viewer's own hosts,
// marches, village queue and stores say, read once into one plain bundle for
// every painter of the map. Nothing here is a rule of the game and nothing is
// invented: each field is a picture of a record the page holds.
//
//   hosts      the viewer's hosts in the provinces the page has loaded (province entries in states 1 to 3)
//   lead       the host the player's character leads: the lowest host id alive of the active village
//   place      where that character is (`characterPlace`)
//   marches    the viewer's own marches (the march book of this browser and the Holding's transit records)
//   watch      the land each standing host afield watches (its sight: map/survey.mjs SIGHT)
//   work       the active village at work: its queue, what it has built, what has grown since the last settling
//
// The words for what these draw are fixed (UX design 14.1): 村のまわり (the
// village's worked land), 軍勢が押さえているマス (the tile a host stands on),
// 見張っている土地 (the land a standing host watches), 測量した土地 (surveyed
// land). None of it is territory: under these rules nothing a player does
// changes who holds land.
//
// Pure functions; no DOM, no clock of its own.
import { hostParts } from '../faddr.mjs';
import { DIRECTIONS, hexDistance, locate, tileHex } from '../fgeo.mjs';
import { BUILD_ITEMS, QUEUE_KIND, accrualAt, baseProduction, hostsIn, queueItem, WORKSHOP, TIER_BONUS_PCT } from '../fland.mjs';
import { s1On, seasonBase, oreExtraFor } from '../fs1.mjs';
import { DEPART_STAMINA, RULES } from '../fmarch.mjs';
import { conquestEnabled, keepFromProvince } from '../fconquest.mjs';
import { RESOURCE_ORDER } from '../resources.mjs';

const int = Number.isInteger;
const big = v => { try { return BigInt(v); } catch { return null; } };
/** The unit byte of a Scout host (fland.mjs SCOUT). */
const SCOUT = 6;
/** How far a standing host watches, in tiles (map/survey.mjs SIGHT: a test holds the two together). */
export const WATCH = Object.freeze({ host: 2, scout: 3 });
export const watchRadius = unit => (unit === SCOUT ? WATCH.scout : WATCH.host);

// ------------------------------------------------------------------ hosts
/** Whether a roster entry stands on its tile at turn `nowBell`: in the roster, or mustered for a turn that has begun. */
export const isStanding = (row, nowBell = 0) => row?.state === 1 || (row?.state === 2 && int(row.fromBell) && row.fromBell <= nowBell);
/** Whether a host is forming up: mustered for the next turn (the board shows a ghost of it). */
export const isForming = (row, nowBell = 0) => row?.state === 2 && !isStanding(row, nowBell);

/**
 * The viewer's hosts in the provinces the page holds: `[{id (text), holding (index), key ("P,Q,site"), village: {p,
 * q, tile}, p, q, tile, unit, troops, state, standing, forming, sealed, stamina, readyBell, fromBell, home (it stands
 * on its own village's tile)}]`, by id. `fs` = `{holdings, provinces: Map "P,Q" → {province}, nowBell, marches}`.
 * A host on a march of the viewer's that no roster holds any more is a row too (`road: true`, `sealed`, at the tile
 * it left from): see the note in the function.
 */
export function ownHostRows(fs) {
  const nowBell = fs?.nowBell ?? 0, seen = new Map();
  (fs?.holdings ?? []).forEach((h, holding) => {
    if (!h || !int(h.p) || !int(h.q)) return;
    for (const env of fs.provinces?.values?.() ?? []) {
      const pv = env?.province;
      if (!pv?.entries) continue;
      let rows = [];
      try { rows = hostsIn(pv, h, nowBell); } catch { rows = []; }
      // (a conquest season: the province's keep stands on one of its tiles; a host on THAT tile is the one that
      // fights its defenders, holds it and, with the capture, goes into it)
      let keepTile = null;
      try { keepTile = keepFromProvince(pv)?.tile ?? null; } catch { keepTile = null; }
      for (const r of rows) {
        const id = String(r.id);
        const row = { id, holding, key: `${h.p},${h.q},${h.site}`, village: { p: h.p, q: h.q, tile: h.tile }, p: pv.p, q: pv.q, tile: r.tile, unit: r.unit, troops: r.troops, state: r.state,
          stamina: r.stamina, readyBell: r.readyBell ?? 0, fromBell: r.fromBell ?? 0 };
        row.standing = isStanding(row, nowBell); row.forming = isForming(row, nowBell); row.sealed = r.state === 3;
        row.home = pv.p === h.p && pv.q === h.q && r.tile === h.tile;
        if (int(keepTile) && r.tile === keepTile) row.onKeep = true;
        // (a host is in one roster: a second entry of the same id is kept only when it stands and the first did not)
        const had = seen.get(id);
        if (!had || (row.standing && !had.standing)) seen.set(id, row);
      }
    }
  });
  // what the rosters said of each host when it was last seen in one (its unit and troops): a picture's memory only
  for (const r of seen.values()) lastSeen.set(r.id, { unit: r.unit, troops: r.troops });
  // A host whose Depart has landed (the march book says so: `landed`, or the seal already being opened) is on the
  // road, whatever the roster the page holds still says of it: the page reads a province once and again when
  // something asks, and the origin's roster went on showing the host standing at home for a turn or two after the
  // order (seen on the local test chain, 2026-10-11: the character stood by its village while its own marker walked
  // the ribbon, and `board:left` was said two turns late; and on a march of two turns the stale roster outlived the
  // road, so the host "arrived" where it had set out from). Only where that roster shows it on the very tile it set
  // out from: a host that has arrived stands on another tile and is the roster's. An order kept without its route
  // is believed until its arrival turn begins.
  // (a conquest season's board: any other season reads its rosters as it did)
  for (const m of conquestEnabled(fs?.season) ? fs?.marches ?? [] : []) {
    const e = m?.entry ?? null, row = e && e.host !== undefined && e.host !== null ? seen.get(String(e.host)) : null;
    if (!row || !row.standing || !(e.state === 'landed' || e.state === 'revealing')) continue;
    const r0 = e.route, from = r0 && int(r0.p) && int(r0.q) && int(r0.tile) ? r0 : null, arrive = e.arriveBell ?? m?.transit?.arriveBell ?? null;
    if (from ? row.p !== from.p || row.q !== from.q || row.tile !== from.tile : !int(arrive) || nowBell >= arrive) continue;
    seen.set(row.id, { ...row, state: 3, standing: false, forming: false, sealed: true });
  }
  // A host on the road that is in no roster the page holds. The origin's entry is freed when the departure turn is
  // resolved (SettleDeparture) and the destination's is written only when the arrival turn is: in between the
  // host is named by the Holding's transit record and by this browser's march book alone (the page's `marches`).
  // It is alive, and still the village's first host if it was: without this row the character jumped to the next
  // host for the length of the march, and a host whose seal was open stood nowhere (found with the sample world).
  for (const m of fs?.marches ?? []) {
    const raw = m?.entry?.host ?? (m?.transit ? m.transit.hostId : null);
    if (raw === null || raw === undefined) continue;
    const id = String(raw);
    if (seen.has(id)) continue;
    // (the arrival turn is resolved and no roster holds the host: it did not stay there — destroyed, or on its way
    // home through the settle: no longer a host on the road)
    if (m.facts?.pipeline === 'resolved') continue;
    const hp = hostParts(raw);
    const holding = hp ? (fs.holdings ?? []).findIndex(h => h && h.p === hp.p && h.q === hp.q && h.site === hp.site) : -1;
    if (holding < 0) continue;
    const h = fs.holdings[holding], r0 = m.entry?.route, acct = m.slot?.account ?? null, was = lastSeen.get(id) ?? null;
    const from = r0 && int(r0.p) && int(r0.q) && int(r0.tile) ? r0 : h;
    seen.set(id, { id, holding, key: `${h.p},${h.q},${h.site}`, village: { p: h.p, q: h.q, tile: h.tile }, p: from.p, q: from.q, tile: from.tile,
      unit: int(acct?.unit) ? acct.unit : was?.unit ?? 0, troops: acct && acct.depMass !== undefined ? Math.floor(Number(acct.depMass) / 1000) : was?.troops ?? null,
      state: 3, stamina: null, readyBell: 0, fromBell: 0, standing: false, forming: false, sealed: true, home: false, road: true });
  }
  return [...seen.values()].sort((a, b) => { const x = big(a.id) ?? 0n, y = big(b.id) ?? 0n; return x < y ? -1 : x > y ? 1 : 0; });
}
const lastSeen = new Map();

/**
 * The hosts of the village on site `site` of province (p, q) in the provinces the page holds, whoever owns it:
 * `[{id, p, q, tile, unit, state, standing, sealed, fromBell}]` (the public roster entries whose id names that
 * site). For another player's character: only what the loaded provinces say, and `away`: the hosts the public
 * DEPART records say are on the road (`[{host, p, q, tile}]`: people/scene.mjs awayAt).
 */
export function siteHostRows(provinces, { p, q, site }, nowBell = 0, away = []) {
  const out = [];
  for (const env of provinces?.values?.() ?? []) {
    const pv = env?.province ?? env;
    for (const e of pv?.entries ?? []) {
      if (!(e.state >= 1 && e.state <= 3)) continue;
      const h = hostParts(e.id);
      if (!h || h.p !== p || h.q !== q || h.site !== site) continue;
      const row = { id: String(e.id), p: pv.p, q: pv.q, tile: e.tile, unit: e.unit, state: e.state, fromBell: e.fromBell ?? 0 };
      row.standing = isStanding(row, nowBell); row.sealed = e.state === 3;
      out.push(row);
    }
  }
  // (a host of that village the public DEPART records say is on the road, in no roster the page holds: alive and
  // away. Nothing of where it goes is read: a departure's record carries its origin and its arrival turn only)
  for (const d of away ?? []) {
    const h = hostParts(d.host);
    if (!h || h.p !== p || h.q !== q || h.site !== site || out.some(r => r.id === String(d.host))) continue;
    out.push({ id: String(d.host), p: d.p, q: d.q, tile: d.tile, unit: 0, state: 3, fromBell: 0, standing: false, sealed: true, road: true });
  }
  return out;
}

/**
 * The host a player's character leads (UX design 14.3): the lowest host id alive of the village, among the hosts
 * that stand or are on a sealed march (a host still forming up is not yet on the board). Public and stable: every
 * viewer who holds the same records names the same host. `rows`: the hosts of ONE village. Null with none.
 */
export function leadOf(rows, nowBell = 0) {
  let best = null, bid = null;
  for (const r of rows ?? []) {
    if (!(isStanding(r, nowBell) || r.state === 3)) continue;
    const id = big(r.id);
    if (id === null) continue;
    if (bid === null || id < bid) { best = r; bid = id; }
  }
  return best;
}

// ------------------------------------------------------------------ marches
/**
 * The hexes of a planned route `{p, q, tile, dirs}` (the march book's own record), origin first: `[{q, r}]`.
 * A direction the table does not know ends the route there.
 */
export function routeHexes(route) {
  const h = route && Array.isArray(route.dirs) ? tileHex(route.p, route.q, route.tile) : null;
  if (!h) return [];
  const out = [{ q: h.q, r: h.r }];
  let q = h.q, r = h.r;
  for (const d of route.dirs) { const v = DIRECTIONS[d]; if (!v) break; q += v[0]; r += v[1]; out.push({ q, r }); }
  return out;
}
/** The tiles of a route as `[{p, q, tile}]` (province and tile index), origin first. */
export const routeTiles = route => routeHexes(route).map(h => { const at = locate(h.q, h.r); return { p: at.p, q: at.q, tile: at.idx }; });

/** The states of a march book entry in which its seal is open (the destination is public). */
const OPEN_STATES = new Set(['revealed', 'settled']);
/**
 * The viewer's own marches, from the page's list (controller.mjs refreshMarches: `[{entry, transit, facts, dest}]`):
 * `[{host, departBell, arriveBell, route, hexes: [{q, r}], dest: {p, q, tile} | null, known (this browser holds the
 * sealed order: the destination may be drawn, for this viewer only), arrived (the arrival turn has begun), open (the
 * seal is open: the destination is public and the host is drawn on it)}]`.
 */
export function ownMarches(fs) {
  const nowBell = fs?.nowBell ?? 0, out = [];
  for (const m of fs?.marches ?? []) {
    const e = m?.entry ?? null, t = m?.transit ?? null;
    const host = e?.host ?? (t ? String(t.hostId) : null);
    if (host === null || host === undefined) continue;
    const arriveBell = e?.arriveBell ?? t?.arriveBell ?? null, departBell = e?.departBell ?? null;
    const d = m.dest && int(m.dest.p) && int(m.dest.q) && int(m.dest.tile) ? { p: m.dest.p, q: m.dest.q, tile: m.dest.tile } : null;
    const known = !!e && !!d;
    let hexes = known ? routeHexes(e.route) : [];
    // (an order kept without its route, an older entry of the march book: a straight line from the village it left to its destination)
    if (known && hexes.length < 2) {
      const hp = hostParts(host), from = hp ? (fs.holdings ?? []).find(h => h && h.p === hp.p && h.q === hp.q && h.site === hp.site && int(h.tile)) : null;
      const a = from ? tileHex(from.p, from.q, from.tile) : null, b = tileHex(d.p, d.q, d.tile);
      hexes = a && b ? [{ q: a.q, r: a.r }, { q: b.q, r: b.r }] : [];
    }
    const arrived = int(arriveBell) && nowBell >= arriveBell;
    out.push({ host: String(host), departBell: int(departBell) ? departBell : null, arriveBell: int(arriveBell) ? arriveBell : null, route: known ? e.route ?? null : null, hexes, dest: known ? d : null, known,
      arrived, open: known && arrived && (!!m.facts?.slotPresent || OPEN_STATES.has(e.state)) });
  }
  return out;
}

/** How far a march is along its way at chain time `now` (0 at the start of its departure turn, 1 from its arrival turn's start). */
export function marchShare(m, { genesisTs = 0, now = 0, bellSecs = 600 } = {}) {
  if (!int(m?.departBell) || !int(m?.arriveBell) || !(m.arriveBell > m.departBell)) return m?.arrived ? 1 : 0;
  const t0 = genesisTs + bellSecs * m.departBell, t1 = genesisTs + bellSecs * m.arriveBell;
  return Math.max(0, Math.min(1, (now - t0) / (t1 - t0)));
}

// ------------------------------------------------------------------ where the character is
/**
 * Where a player's character is (UX design 14.3). A character has no account in the rules: its place is a picture
 * of the records of the host it leads (`leadOf`).
 *
 *   village   `{p, q, tile}`: the player's village
 *   rows      the hosts of that village (`ownHostRows` filtered, or `siteHostRows`)
 *   marches   the viewer's own marches (`ownMarches`); none for another player's character
 *   own       the character is the viewer's own
 *
 * Returns `{at, host, p, q, tile}` (and `unit`, `alone` while the lead stands):
 *   'home'     no host leads it afield: it stands by its standard (no host alive, or the lead stands on the village)
 *   'host'     the lead stands on another tile: it stands at its head there
 *   'arrived'  the lead's own march has arrived and its seal is open: it stands at the destination with the host
 *              (the viewer's own only: the destination is in this browser's march book)
 *   'march'    the lead is on a sealed march this browser holds the order of: a marker on the viewer's own ribbon
 *   'away'     the lead is on a sealed march and nothing more may be drawn (another player's, or an order this
 *              browser does not hold): the character is not on the board
 */
export function characterPlace({ village, rows = [], marches = [], nowBell = 0, own = false } = {}) {
  const home = { at: 'home', host: null, p: village?.p, q: village?.q, tile: village?.tile };
  const lead = leadOf(rows, nowBell);
  if (!lead) return home;
  if (isStanding(lead, nowBell)) {
    // (`unit`, `alone`: the lead's unit, and whether it is the only standing host of that unit of this village on its
    // tile: the walk out with a departing column is told by the march's own word, which names the tile and the unit)
    const alone = !rows.some(r => r !== lead && r.id !== lead.id && isStanding(r, nowBell) && r.unit === lead.unit && r.p === lead.p && r.q === lead.q && r.tile === lead.tile);
    if (lead.p === village?.p && lead.q === village?.q && lead.tile === village?.tile) return { ...home, host: lead.id, unit: lead.unit, alone };
    // (`keep`: the tile is a keep's own: the character stands beside the fortress there, people/onboard.mjs KEEP_SPOT)
    return { at: 'host', host: lead.id, p: lead.p, q: lead.q, tile: lead.tile, unit: lead.unit, alone, ...(lead.onKeep ? { keep: true } : {}) };
  }
  const m = own ? marches.find(x => x.host === lead.id) ?? null : null;
  if (m?.known && m.open) return { at: 'arrived', host: lead.id, p: m.dest.p, q: m.dest.q, tile: m.dest.tile };
  if (m?.known) return { at: 'march', host: lead.id, p: lead.p, q: lead.q, tile: lead.tile };
  // The capture of a keep (a conquest season): the host that held the keep's tile goes into the keep with the capture,
  // and the roster of the turn it was taken in keeps its entry on that tile, state 3, with no march of the viewer's
  // behind it (the local test chain, 2026-10-11: province -3,4 after turn 345, the host that took it, state 3 on tile
  // 18, and no entry of it after turn 346). A sealed host with no order of this browser was read as "away", and the
  // viewer's character stood by its village while its province was taken. The record puts the host on the keep's
  // tile: the character stands beside that keep, as it stood through the hold, until the roster no longer has it.
  if (own && lead.state === 3 && lead.onKeep && !lead.road) return { at: 'host', host: lead.id, p: lead.p, q: lead.q, tile: lead.tile, unit: lead.unit, alone: false, keep: true, inKeep: true };
  return { at: 'away', host: lead.id, p: lead.p, q: lead.q, tile: lead.tile };
}

// ------------------------------------------------------------------ watched land
/**
 * The land the viewer's standing hosts watch (UX design 14.4): one entry for each host that stands away from its
 * own village (a host on its village watches nothing the village does not), `[{id, unit, q, r, radius, tiles: [{q,
 * r, d}]}]`. `open(q, r)`: whether a hex lies in an open ring (land that does not exist yet is not watched).
 * Hosts on the same tile are one entry (the widest watch).
 */
export function watchOf(rows, { nowBell = 0, open = () => true } = {}) {
  const byTile = new Map();
  for (const r of rows ?? []) {
    if (!isStanding(r, nowBell) || r.home) continue;
    const h = tileHex(r.p, r.q, r.tile);
    if (!h) continue;
    const key = `${h.q},${h.r}`, radius = watchRadius(r.unit), had = byTile.get(key);
    if (!had || radius > had.radius) byTile.set(key, { id: had ? had.id : r.id, unit: r.unit, q: h.q, r: h.r, radius });
  }
  return [...byTile.values()].map(w => ({ ...w, tiles: discTiles(w.q, w.r, w.radius).filter(t => open(t.q, t.r)) }));
}
/** The hexes within `n` tiles of (q, r): `[{q, r, d}]`. */
export function discTiles(q, r, n) {
  const out = [];
  for (let dq = -n; dq <= n; dq++) for (let dr = Math.max(-n, -dq - n); dr <= Math.min(n, -dq + n); dr++) out.push({ q: q + dq, r: r + dr, d: hexDistance(0, 0, dq, dr) });
  return out;
}

// ------------------------------------------------------------------ stamina
/**
 * A host's stamina as a ring (UX design 14.2): `{share (0..1 of the cap), need (where a march's cost stands on the
 * ring), ready (a march can be paid now), wait (turns until it can: one point returns a turn), notches (the ring's
 * marks, one for every `step` points)}`. A march costs 74 of 120 whatever its length (fmarch.mjs DEPART_STAMINA).
 */
export function staminaRing(stamina, { need = DEPART_STAMINA, cap = RULES.STAMINA_CAP, step = 10 } = {}) {
  const s = Math.max(0, Math.min(cap, Number(stamina) || 0));
  return { stamina: s, cap, share: s / cap, need: need / cap, ready: s >= need, wait: Math.max(0, Math.ceil(need - s)), notches: Math.round(cap / step) };
}
/** Whether a host can be given an order this turn (the brass pip): it stands, its rest is over, and it can pay a march or is a Scout. */
export const canAct = (row, nowBell = 0) => !!row && row.state === 1 && nowBell >= (row.readyBell ?? 0) && (row.stamina >= DEPART_STAMINA || row.unit === SCOUT);

// ------------------------------------------------------------------ the village at work
/**
 * How many of each building a village has (item 0 to 5: fland.mjs BUILD_ITEMS), read from what it produces above
 * its tier's base (a Holding keeps its production, not a list of buildings): `[n0, …, n5]`.
 * On an S1 season the ore base is the village's terrain ore (fs1.mjs s1OreBase): `oreExtra` is what its terrain adds
 * (map/sprites.mjs oreAround); without it the mines are not counted (0): the terrain's own ore read as mines drew
 * mines a village never built (the independent review of 2026-10-24).
 */
export function buildingsOf(holding, { oreExtra = null } = {}) {
  const out = [0, 0, 0, 0, 0, 0];
  if (!holding?.production) return out;
  const s1 = s1On(), tier = holding.tier ?? 0;
  // (`oreExtra` given, or the map's reading registered with fs1.mjs)
  const base = seasonBase(baseProduction(tier), holding, { oreExtra: oreExtra ?? oreExtraFor(holding), bonusPct: TIER_BONUS_PCT[tier] ?? 0 });
  for (const b of BUILD_ITEMS) {
    // the store's index of the building's resource (none for the walls)
    const i = RESOURCE_ORDER.indexOf(b.resource);
    if (i < 0 || !(b.perHour > 0)) continue;
    const p = big(holding.production[i]) ?? 0n;
    if (base[i] === null) continue;   // (S1 ore without the terrain: not known, not drawn)
    // (a fixture or an older record may keep the building's production alone, without the base; not on S1, whose
    // record always carries its base)
    const over = p >= base[i] ? p - base[i] : s1 ? 0n : p;
    out[b.item] = Math.max(0, Math.min(12, Number(over / BigInt(b.perHour * 1000))));
  }
  // S1: the workshops, as the rules count them (permutation-rules arms.rs `workshops_built`: the arms production over
  // one workshop's; no base production makes arms). The seventh entry: map/village.mjs draws a forge for it.
  if (s1) {
    const arms = big(holding.production[4]) ?? 0n;
    out.push(arms > 0n ? Math.min(12, Number(arms / BigInt(WORKSHOP.perHour * 1000))) : 0);
  }
  return out;
}

/**
 * A village at work at chain time `now` (UX design 14.2, 14.4):
 *   queue     `[{slot, item (0–6 | null), kind ('build' | 'walls' | 'tier'), doneAt, startAt, share (0..1)}]`: what
 *             is under way, in queue order (the queue is serial: an item starts when the one before it ends)
 *   built     `buildingsOf`
 *   walls     wall points
 *   grown     what has grown since the last settling, in whole units by store (`[food, wood, stone, ore, horses,
 *             gold, science, influence]`), and `sheaves`: how full the fields are shown (0..1: an hour's growth of
 *             food fills them), `full`: a store stands at its cap
 */
export function villageWork(holding, now = 0, { starts = null, oreExtra = null } = {}) {
  if (!holding) return null;
  // (`oreExtra`: the village's terrain ore on S1, as buildingsOf takes it; without it a S1 village's mines read 0)
  const queue = [], built = buildingsOf(holding, { oreExtra }), ahead = [0, 0, 0, 0, 0, 0];
  let prev = null;
  (holding.queue ?? []).forEach((q, slot) => {
    const doneAt = Number(q?.doneAt ?? 0);
    if (!(doneAt > 0) || !(doneAt > now) || !q.kind) return;
    const kind = q.kind === QUEUE_KIND.TIER_UP ? 'tier' : q.kind === QUEUE_KIND.WALLS ? 'walls' : 'build';
    const item = queueItem(q);
    // the record keeps when an item is done, not when it began. The queue is serial: an item begins when the one
    // before it ends; the first began `span` before its end (the rules' times: the n-th copy of a building 3,600 +
    // 1,800 n seconds; walls 14,400; a promotion 6, 12 or 24 hours by tier)
    const copy = kind === 'build' && item !== null && item < 6 ? built[item] + ahead[item] + 1 : 1;
    if (kind === 'build' && item !== null && item < 6) ahead[item]++;
    const span = kind === 'walls' ? 14400 : kind === 'tier' ? [21600, 43200, 86400][Math.min(2, holding.tier ?? 0)] : 3600 + 1800 * copy;
    const startAt = starts?.[slot] ?? (prev ?? doneAt - span);
    const total = Math.max(60, doneAt - startAt);
    queue.push({ slot, item, kind, doneAt, startAt, share: Math.max(0, Math.min(1, (now - startAt) / total)) });
    prev = doneAt;
  });
  const grown = [];
  let full = false;
  for (const a of holding.stores ?? []) {
    let g = 0;
    try { g = Number((accrualAt(a, now) - BigInt(a.value)) / 1000n); if (BigInt(a.rate) > 0n && accrualAt(a, now) >= BigInt(a.cap)) full = true; } catch { g = 0; }
    grown.push(Math.max(0, g));
  }
  const perHour = (() => { try { return Number(BigInt(holding.stores?.[0]?.rate ?? 0)) / 1000; } catch { return 0; } })();
  const sheaves = perHour > 0 ? Math.max(0, Math.min(1, (grown[0] ?? 0) / perHour)) : 0;
  return { queue, built, walls: Number(holding.walls ?? 0), tier: holding.tier ?? 0, grown, sheaves, full };
}

// ------------------------------------------------------------------ the bundle
/**
 * Everything the board draws of the viewer's own records, for one page state `fs` (`{holdings, provinces,
 * marches, nowBell, activeHolding, citizen}`; plain data: it can be compared as text):
 *   hosts, marches   as above
 *   lead             the id of the host the viewer's character leads, or null
 *   place            `characterPlace` for the viewer's active village
 *   explores         the tiles of an exploration still to be answered: `[{p, q, tile, host}]`
 *   routes           the tiles of the routes of the viewer's marches that have arrived: `[{p, q, tile}]` (they
 *                    become surveyed: map/survey.mjs)
 *   work             the active village's own record for `villageWork` (its tier, production, queue and stores)
 *   arrivals         hosts whose seal is open and that are not in a roster there yet: `[{id, p, q, tile, unit, troops}]`
 *                    (drawn standing on their destination, and seeing from it)
 */
export function boardRecords(fs) {
  const nowBell = fs?.nowBell ?? 0, holdings = fs?.holdings ?? [];
  const hosts = ownHostRows(fs), marches = ownMarches(fs);
  const ai = int(fs?.activeHolding) && fs.activeHolding >= 0 && fs.activeHolding < holdings.length ? fs.activeHolding : 0;
  const active = holdings[ai] ?? null;
  const village = active && int(active.tile) ? { p: active.p, q: active.q, tile: active.tile } : null;
  const mine = village ? hosts.filter(h => h.holding === ai) : [];
  const place = village ? characterPlace({ village, rows: mine, marches, nowBell, own: true }) : null;
  const explores = [];
  for (const h of holdings) {
    const e = h?.explore;
    if (e?.state && int(e.p) && int(e.q)) for (const t of Array.from(e.tiles ?? [])) if (int(t) && t < 61) explores.push({ p: e.p, q: e.q, tile: t, host: e.host !== undefined && e.host !== null ? String(e.host) : null });
  }
  const routes = [], arrivals = [];
  for (const m of marches) {
    if (!m.known || !m.arrived) continue;
    for (const t of routeTiles(m.route)) routes.push(t);
    const row = hosts.find(h => h.id === m.host);
    // (a host that already stands in a roster is drawn from the roster)
    if (m.open && row && row.sealed) arrivals.push({ id: m.host, p: m.dest.p, q: m.dest.q, tile: m.dest.tile, unit: row.unit, troops: row.troops, stamina: row.stamina });
  }
  // the active village at work: what `villageWork` reads, as plain data (the painters ask it for the time on screen)
  const work = active ? { p: active.p, q: active.q, site: active.site, tile: active.tile, tier: active.tier ?? 0, walls: Number(active.walls ?? 0), production: Array.from(active.production ?? [], String),
    queue: Array.from(active.queue ?? [], q => ({ doneAt: String(q?.doneAt ?? 0), kind: q?.kind ?? 0, arg: q?.arg ?? 0 })),
    stores: Array.from(active.stores ?? [], a => ({ value: String(a.value ?? 0), rate: String(a.rate ?? 0), cap: String(a.cap ?? 0), t0: String(a.t0 ?? 0), frac: String(a.frac ?? 0) })) } : null;
  return { nowBell, hosts, marches, lead: place?.host ?? null, place, village, explores, routes, arrivals, work };
}
