// Fog of war for LOCAL TEST worlds (owner t387u / t387s1100, 2026-11-19) and, since fog-devnet, for the DEVNET page
// path (a devnet wide season's play page): a Civ-style player view.
//
// Presentation only. Every account stays public on the chain and nothing here is a rule of the game: the page simply
// does not SHOW what its viewer could not see. The survey (map/survey.mjs) already says, tile by tile, what the viewer
// has in sight (L3), has seen before (L2), and has never seen (L1). This file adds, for local test worlds and devnet play
// pages (`fogModeOf`):
//
//   vision     the viewer's own villages and hosts (the survey's anchors) AND the viewer's own nation: every village of
//              a nation-mate and every province the nation holds sees round itself (nationSources → survey anchors).
//              Alliances share nothing: only the viewer's own nation counts.
//   last-known what the viewer saw of a province or a keep the last time it was in sight (owners of its sites, its keep and
//              holder, a wide province's villages), kept per world and player on this device (createFogMemory). Out of
//              sight, the page shows THAT, never the live record. Never seen: nothing but the blank chart.
//   units      other nations' hosts, marches, clashes, contests and incoming columns: only inside CURRENT vision; no
//              ghosts are kept.
//
// The page keeps the raw records as they are (its own logic, legality checks and orders read them); every surface that
// SHOWS the map reads the fogged copies made here (map source, 全体図, the wide land, keeps and the keep lists, the
// inspector, the minimap, feeds and alarms). The copies are made when the records or the survey change, never per frame
// (cached per ring and per record object, keyed by the survey's `rev`).
//
// THE SWITCHES, one per mode: `LOCAL_FOG` (local test worlds, `FS.localPlay`) and `DEVNET_FOG` (fog-devnet, owner t387u:
// the DEVNET page path #110/#118/#121/#122 — a page whose pinned season is on the cluster 'devnet', its data read from
// the herald and the gateway, not from a local relay). false = that mode looks exactly as before. Every other page (a
// localnet or S1 season that is not local play, practice, spectate) never uses this file's masks: `fogActive` is false.
// The fog's mode is `fogModeOf(FS)`: 'local' | 'devnet' | null.
import { L2, L3, SIGHT, browserStorage, keyHex } from './survey.mjs';
import { PROVINCE_RADIUS, PROVINCE_TILES, TILE_OFFSETS, locate, provinceCentre } from '../fgeo.mjs';
import { demoFortNow } from '../fdemofort.mjs';

/** THE switch of the local test world's fog of war (one constant; false turns every mask here off in local worlds). */
export const LOCAL_FOG = true;
/**
 * THE switch of the DEVNET page's fog of war (fog-devnet; one constant; false: a devnet page shows the full map as
 * before). On for any play page whose pinned season (FS.pin, from the herald's season record) is on cluster 'devnet' and
 * that is not local play — whether or not the gateway's devnet play routes answered (FS.devnetPlay): a viewer of a devnet
 * season sees the same player view in either case.
 */
export const DEVNET_FOG = true;

/**
 * The choices the owner left open (report fog-local.md, "choices for r0ze"), each in one place:
 *   nationVillage   how far a nation-mate's village sees (tiles): the same as one's own of its tier (tier unknown from the
 *                   overview: a hamlet's, 3 + 1 = 4)
 *   territory       how far a province the nation holds sees, from its centre tile: the whole province (radius 4) and
 *                   2 tiles beyond its edge (Civ: one's borders and a little past them are always visible)
 *   incomingTurns   an incoming enemy column (a public departure that could reach a village of the viewer's) is told only
 *                   once its origin is in sight, or once it is at most this many turns from arriving (it is then inside
 *                   the village's own sight: a column walks about one tile a turn and a village sees 4–6 tiles)
 *   memoryProvinces most provinces whose last-known record is kept on the device (oldest dropped first)
 *   blankChart      never-seen land is plain paper (no terrain wash, lattice or glyph), on the map and on 全体図
 */
export const FOG_RULES = Object.freeze({
  nationVillage: tier => SIGHT.village(Number.isInteger(tier) ? tier : 0),
  territory: PROVINCE_RADIUS + 2,
  incomingTurns: 3,
  memoryProvinces: 4096,
  blankChart: true,
});

const int = Number.isInteger;
const NONE = 7, NO_KEEP = null;
const nation = f => int(f) && f >= 0 && f <= 5;

/**
 * The fog's world of this page: 'local' (a local test world: `FS.localPlay`), 'devnet' (a play page pinned to a devnet
 * season: `FS.pin.cluster`, else the herald record's `cluster`), or null. The play page only; the switches are not read.
 */
export function fogModeOf(fs) {
  if ((fs?.mode ?? 'play') !== 'play') return null;
  if (fs?.localPlay) return 'local';
  const cluster = fs?.pin?.cluster ?? fs?.record?.cluster ?? null;
  return cluster === 'devnet' ? 'devnet' : null;
}
/** Whether the mode's switch is on (`fogModeOf`'s answer). */
export const fogSwitchOn = mode => (mode === 'local' ? LOCAL_FOG : mode === 'devnet' ? DEVNET_FOG : false);
/** Whether the fog of war applies to this page: the play page of a local test world or of a devnet season, its switch on. */
export const fogActive = fs => fogSwitchOn(fogModeOf(fs));

// ------------------------------------------------------------------ vision: the viewer's nation
/**
 * The vision sources of the viewer's NATION (besides the viewer's own villages and hosts, which the survey has):
 * `{villages: [{p, q, tile, tier}], territory: [{p, q}]}`. `overviews` the RAW overviews (ring → {provinces}), `wide`
 * the RAW wide land (map/wideland.mjs wideLandOf: cells with `holder`, `villages`, `terrain`), `faction` the viewer's,
 * `terrainOf(p, q)` → {sites} for a legacy province. `own` (a Set of "p,q,tile") leaves out the viewer's own villages.
 * Reading the raw records is right here: they are the viewer's own nation's, which the viewer always sees.
 */
export function nationSources({ overviews = null, wide = null, faction = null, terrainOf = null, own = null, control = null } = {}) {
  const villages = [], territory = [], held = new Set();
  if (!nation(faction)) return { villages, territory };
  const hold = (p, q) => { const k = `${p},${q}`; if (!held.has(k)) { held.add(k); territory.push({ p, q }); } };
  // (the held provinces from the control snapshot itself — `control` [{p, q, control}], FS.conquest.control.provinces —:
  //  the copy laid on the overviews (fconquest.mjs applyControl) is missing from a ring's overview read again until the
  //  next control read lays it on, and the nation's own land must not blink out of sight meanwhile)
  for (const c of Array.isArray(control) ? control : []) if (c?.control === faction && int(c.p) && int(c.q)) hold(c.p, c.q);
  for (const o of overviews?.values?.() ?? []) for (const r of o?.provinces ?? []) {
    if (r.control === faction) hold(r.p, r.q);
    const sites = terrainOf?.(r.p, r.q)?.sites ?? null;
    if (!sites) continue;
    for (let j = 0; j < 12; j++) {
      if (r.owners?.[j] !== faction || r.sites?.[j] !== 1 || !int(sites[j])) continue;
      if (own?.has(`${r.p},${r.q},${sites[j]}`)) continue;
      villages.push({ p: r.p, q: r.q, tile: sites[j], tier: 0 });
    }
  }
  for (const c of wide?.cells ?? []) {
    if (c.holder === faction) hold(c.p, c.q);
    const sites = c.terrain?.sites ?? null;
    for (const v of c.villages ?? []) if (v.nation === faction && sites && int(sites[v.site]) && !own?.has(`${c.p},${c.q},${sites[v.site]}`)) villages.push({ p: c.p, q: c.q, tile: sites[v.site], tier: 0 });
  }
  return { villages, territory };
}

/** The anchors (map/survey.mjs anchorsOf shape) of nationSources' answer. */
export function nationAnchors({ villages = [], territory = [] } = {}) {
  const out = [];
  for (const v of villages) {
    const c = provinceCentre(v.p, v.q);
    const h = tileAt(v.p, v.q, v.tile, c);
    if (h) out.push({ q: h.q, r: h.r, radius: FOG_RULES.nationVillage(v.tier), level: L3, kind: 'nation' });
  }
  for (const t of territory) { const c = provinceCentre(t.p, t.q); out.push({ q: c.q, r: c.r, radius: FOG_RULES.territory, level: L3, kind: 'territory' }); }
  return out;
}
const tileAt = (p, q, idx, c = provinceCentre(p, q)) => { const o = TILE_OFFSETS[idx]; return o ? { q: c.q + o.q, r: c.r + o.r } : null; };

// ------------------------------------------------------------------ last-known memory
/** The storage key of a player's last-known records in one world (beside map/survey.mjs memoryKey). `seasonAddress`
 * (fog-devnet: the devnet page passes its pinned Season account) also keys a season re-created under the same program
 * and Season id, so one season's memory never shows in another; local worlds key as before. */
export const fogMemoryKey = ({ cluster, programId, seasonId }, wallet, seasonAddress = null) =>
  `ps-ffog:v1:${cluster}:${programId}:${seasonId}${seasonAddress ? `@${seasonAddress}` : ''}:${wallet}`;

/**
 * The device's last-known records: `{use(key), get(pk), put(pk, snap), rev(), save(), size()}`. A snapshot is plain
 * data (`{o, s, oc, sk, k, w}`: owners, site states, occupiers, site kinds, keep, wide village list). `use(key)` loads
 * the memory of one world and player (null: memory-only, nothing stored). `save()` writes it back when it changed.
 */
export function createFogMemory({ storage = browserStorage, limit = FOG_RULES.memoryProvinces } = {}) {
  let key = null, map = new Map(), rev = 0, dirty = false;
  const load = k => {
    const out = new Map();
    if (!k) return out;
    try {
      const v = JSON.parse(storage.get(k) ?? 'null');
      if (v && v.v === 1 && v.m && typeof v.m === 'object') for (const [pk, snap] of Object.entries(v.m).slice(-limit)) if (/^-?\d{1,6},-?\d{1,6}$/.test(pk) && snap && typeof snap === 'object') out.set(pk, snap);
    } catch { /* damaged: an empty memory */ }
    return out;
  };
  return {
    use(k) { if (k === key) return; key = k ?? null; map = load(key); rev++; dirty = false; },
    get: pk => map.get(pk) ?? null,
    put(pk, snap) {
      const old = map.get(pk);
      if (old && JSON.stringify(old) === JSON.stringify(snap)) return false;
      map.delete(pk); map.set(pk, snap);
      while (map.size > limit) map.delete(map.keys().next().value);
      rev++; dirty = true;
      return true;
    },
    rev: () => rev,
    size: () => map.size,
    save() { if (!dirty || !key) return false; dirty = false; return storage.set(key, JSON.stringify({ v: 1, m: Object.fromEntries(map) })); },
  };
}

// ------------------------------------------------------------------ the masks
/**
 * The highest survey level of each province with anything surveyed in it: Map "p,q" → 2 | 3, made once per survey from
 * its surveyed tiles (thousands of provinces are never visited one by one: a province not in it was never seen). The
 * survey's own `province()` summary also reads every tile's rim, which costs ~0.1 ms a province.
 */
const maxCache = new WeakMap();
export function provinceMaxes(survey) {
  let m = maxCache.get(survey);
  if (m) return m;
  m = new Map();
  for (const [k, lv] of survey.tiles ?? []) {
    const h = keyHex(k), at = locate(h.q, h.r), pk = `${at.p},${at.q}`;
    if ((m.get(pk) ?? 0) < lv) m.set(pk, lv);
  }
  if (survey && typeof survey === 'object') maxCache.set(survey, m);
  return m;
}
/** A province's highest level for the masks: 3 in sight, 2 seen before, 1 never (a spectator's open survey: 3). */
const maxOf = (survey, p, q) => (survey.showAll ? L3 : provinceMaxes(survey).get(`${p},${q}`) ?? 1);

const blankSites = () => Array(12).fill(0);
const blankOwners = () => Array(12).fill(NONE);

/**
 * One overview province record as the viewer may see it (`rec` the raw record; `survey` the page's; `mem` the memory;
 * `sites` the province's site tiles, or null when its terrain is not known yet; `viewer` the viewer's nation). Never
 * seen: no village, camp, keep, host or clash. Seen before: the last-known sites and keep, no host and no clash. Partly
 * in sight: each site and the keep live where its tile is in sight (its last-known value elsewhere); the province's
 * hosts and clash flag live (its record's unit is the province). Without terrain: the province as one piece.
 * Writes what is in sight into `mem` (the last-known of the next time).
 */
export function fogProvince(rec, { survey, mem = null, sites = null, viewer = null, bell = null } = {}) {
  const pk = `${rec.p},${rec.q}`, pv = { max: maxOf(survey, rec.p, rec.q) };
  const out = { ...rec };
  delete out.v1;   // the record's raw bytes are never needed by a painter
  const own = nation(viewer) ? viewer : null;
  const hosts = Array(7).fill(0);
  if (own !== null && Array.isArray(rec.hosts)) hosts[own] = rec.hosts[own] ?? 0;
  if (pv.max < L2 && !(own !== null && (rec.control === own || (rec.owners ?? []).some((f, j) => f === own && rec.sites?.[j] === 1)))) {
    Object.assign(out, { owners: blankOwners(), sites: blankSites(), hosts, clash: false, occupiers: blankOwners(), siegeStates: blankSites(), siteKinds: Array(12).fill(3),
      keepTile: NO_KEEP, keepTroops: 0, immune: Array(12).fill(false), control: undefined, contender: undefined, contestProgress: undefined, contestRequired: undefined, heartland: undefined, fog: 'unseen' });
    return out;
  }
  const inSight = pv.max === L3;
  const tileSeen = idx => int(idx) && survey.levelOf(rec.p, rec.q, idx) === L3;
  const old = mem?.get(pk) ?? null;
  const snap = { o: [...(old?.o ?? blankOwners())], s: [...(old?.s ?? blankSites())], oc: [...(old?.oc ?? blankOwners())], sk: [...(old?.sk ?? Array(12).fill(3))], k: old?.k ?? null };
  let changed = !old;
  // (the viewer's own nation's villages and keeps are always the viewer's to know, wherever they are)
  const ours = j => own !== null && rec.owners?.[j] === own && rec.sites?.[j] === 1;
  for (let j = 0; j < 12; j++) {
    const live = ours(j) || (sites ? tileSeen(sites[j]) : inSight);
    if (!live) continue;
    const o = rec.owners?.[j] ?? NONE, s = rec.sites?.[j] ?? 0, oc = rec.occupiers?.[j] ?? NONE, sk = rec.siteKinds?.[j] ?? 3;
    if (snap.o[j] !== o || snap.s[j] !== s || snap.oc[j] !== oc || snap.sk[j] !== sk) { snap.o[j] = o; snap.s[j] = s; snap.oc[j] = oc; snap.sk[j] = sk; changed = true; }
  }
  const keepLive = (own !== null && rec.control === own) || (rec.keepTile !== null && rec.keepTile !== undefined ? tileSeen(rec.keepTile) : inSight);
  if (keepLive && (rec.keepTile !== null && rec.keepTile !== undefined || rec.control !== undefined)) {
    // (fix-loop14, found live with LP14-3: an overview record can reach this pass without `control` / `heartland` — it
    //  carries the keep's tile and troops, the holder is laid over it from the control record — and this wrote the
    //  holder as null over the one remembered (here or by fogKeeps, from the keep itself). Whichever write came last
    //  before the keep left sight won: the device then remembered {c: null}, and the World goals card and the keep
    //  board said 「持ち主なし · 前に見たときの持ち主です」 of a keep last seen under Borealis. What a record does not
    //  say is kept as it was remembered)
    const k = { t: rec.keepTile ?? null, n: rec.keepTroops ?? 0, c: rec.control ?? snap.k?.c ?? null, h: rec.heartland ?? snap.k?.h ?? null };
    if (JSON.stringify(k) !== JSON.stringify(snap.k && { t: snap.k.t, n: snap.k.n, c: snap.k.c, h: snap.k.h })) { snap.k = { ...k, b: int(bell) ? bell : null }; changed = true; }
  }
  if (mem && (inSight || keepLive || snap.o.some((f, j) => ours(j))) && changed) mem.put(pk, snap);
  // (verify-pr117, L5-6 follow-up: the province's clash flag — the map's red ring, the minimap dot, the inspector's
  //  「このターンに衝突あり」 — follows the clash rule of clashSeen below: the keep tile in sight (else the whole province),
  //  or the viewer's nation there. One rim tile in sight no longer marks another nation's clash)
  const clashLive = inSight && ((own !== null && (rec.control === own || snap.o.some((f, j) => ours(j)))) || clashSeen({ p: rec.p, q: rec.q, keepTile: rec.keepTile ?? null }, { survey }));
  Object.assign(out, { owners: snap.o, sites: snap.s, occupiers: snap.oc, siteKinds: snap.sk, hosts: inSight ? rec.hosts : hosts, clash: clashLive ? !!rec.clash : false, fog: inSight ? 'sight' : 'memory' });
  if (!inSight) { out.siegeStates = blankSites(); out.immune = Array(12).fill(false); }
  else if (sites) {
    // (a site out of sight in a province partly in sight: no live siege on it)
    out.siegeStates = (rec.siegeStates ?? blankSites()).map((v, j) => (tileSeen(sites[j]) ? v : 0));
  }
  if (keepLive) return out;
  const k = snap.k;
  Object.assign(out, { keepTile: k ? k.t : NO_KEEP, keepTroops: k ? k.n : 0, control: k ? k.c ?? undefined : undefined, heartland: k ? k.h ?? undefined : undefined,
    contender: undefined, contestProgress: undefined, contestRequired: undefined });
  return out;
}

/** An overview (`{ring, bell, provinces, …}`) as the viewer may see it: fogProvince for each of its provinces. */
export function fogOverview(ov, { survey, mem = null, terrainOf = null, viewer = null } = {}) {
  if (!ov?.provinces) return ov;
  return { ...ov, provinces: ov.provinces.map(r => fogProvince(r, { survey, mem, sites: terrainOf?.(r.p, r.q)?.sites ?? null, viewer, bell: ov.bell })) };
}

/**
 * A wide land (map/wideland.mjs wideLandOf's answer) as the viewer may see it: a province never seen is left out (it
 * stays under the cloud); one seen before keeps its terrain and its last-known keep nation and villages; one in sight is
 * live. `relayout(cells)` rebuilds the borders (wideland.mjs landOfCells). → a land of the same shape.
 */
export function fogWideLand(land, { survey, mem = null, viewer = null, relayout = null } = {}) {
  if (!land?.cells) return land;
  const cells = [];
  for (const c of land.cells) {
    const pv = { max: maxOf(survey, c.p, c.q) }, mine = nation(viewer) && (c.holder === viewer || (c.villages ?? []).some(v => v.nation === viewer));
    if (pv.max < L2 && !mine) continue;
    const pk = `w:${c.key}`, sites = c.terrain?.sites ?? null;
    const old = mem?.get(pk) ?? null;
    const seen = idx => int(idx) && survey.levelOf(c.p, c.q, idx) === L3;
    const inSight = pv.max === L3 || (nation(viewer) && c.holder === viewer);
    // villages: per site where the terrain says where its tile is
    const byOld = new Map((old?.v ?? []).map(([s, n]) => [s, n]));
    const live = new Map((c.villages ?? []).map(v => [v.site, v.nation]));
    const vs = new Map();
    for (let j = 0; j < 12; j++) {
      const look = (nation(viewer) && live.get(j) === viewer) || (sites ? seen(sites[j]) : inSight);
      if (look) { if (live.has(j)) vs.set(j, live.get(j)); }
      else if (byOld.has(j)) vs.set(j, byOld.get(j));
    }
    const holder = inSight ? c.holder ?? null : old ? old.h ?? null : null;
    const snap = { h: holder, v: [...vs].sort((a, b) => a[0] - b[0]) };
    if (mem && inSight && JSON.stringify(snap) !== JSON.stringify(old)) mem.put(pk, snap);
    const villages = snap.v.map(([site, n]) => ({ site, nation: n }));
    // (territory-video-2: the keep and the hosts standing on the land, map/widemarks.mjs. The keep's tile is the land's
    //  own (it does not move); its holder is the one remembered and a contest is seen only in sight. A host is seen on a
    //  tile in sight, or when it is the viewer's nation's own)
    // (verify-pr197: a province seen only from afar (L2) and never in sight has no remembered holder: its holder is not
    //  known, which is not "no nation's" — no keep is drawn for it and its plate says nothing, as fogKeeps leaves a keep
    //  never seen out)
    const holderKnown = inSight || !!old;
    const keep = !c.keep || !holderKnown ? null : inSight && seen(c.keep.tile) ? c.keep : { tile: c.keep.tile, holder, contender: null, progress: 0, required: c.keep.required, troops: null };
    const hosts = inSight ? (c.hosts ?? []).filter(h => (nation(viewer) && h.faction === viewer) || seen(h.tile)) : (c.hosts ?? []).filter(h => nation(viewer) && h.faction === viewer);
    cells.push({ ...c, holder, holderKnown, villages, holdings: villages.length, keep, hosts, fog: inSight ? 'sight' : 'memory' });
  }
  const out = relayout ? relayout(cells, land) : { ...land, cells, byKey: new Map(cells.map(c => [c.key, c])), count: cells.length };
  return Object.freeze({ ...out, key: `${land.key}|fog:${survey.rev ?? 0}:${cells.length}` });
}

const unitless = new WeakMap();
/**
 * (verify-pr197) The wide land of a fogged page before its first village stands (the fog's mask is not on yet: the
 * viewer has no vision at all): no host standing on it and no keep being taken is shown — nothing that moves, as the
 * fog shows units only in current vision. Kept per land (the map asks every frame). → a land of the same shape.
 */
export function wideLandUnitless(land) {
  if (!land?.cells) return land;
  let out = unitless.get(land);
  if (out) return out;
  const cells = land.cells.map(c => ({ ...c, hosts: [], keep: c.keep ? { ...c.keep, contender: null, progress: 0, troops: null } : null }));
  out = Object.freeze({ ...land, cells, byKey: new Map(cells.map(c => [c.key, c])) });
  unitless.set(land, out);
  return out;
}

/**
 * The keeps of a conquest season (`Map "p,q" → Keep`, fconquest.mjs keepFromProvince) as the viewer may see them: a keep
 * whose tile is in sight is live (and remembered); one seen before is its last-known holder and garrison, uncontested
 * (a contest is a host on it: in sight only); one never seen is left out.
 */
export function fogKeeps(keeps, { survey, mem = null, viewer = null } = {}) {
  if (!keeps?.entries) return keeps;
  const out = new Map();
  for (const [key, k] of keeps) {
    if (!k || !int(k.p) || !int(k.q)) continue;
    // (the viewer's own nation's keeps: always known)
    const lv = nation(viewer) && k.holder === viewer ? L3 : int(k.tile) ? survey.levelOf(k.p, k.q, k.tile) : maxOf(survey, k.p, k.q);
    const pk = `${k.p},${k.q}`;
    if (lv === L3) {
      out.set(key, k);
      if (mem) { const old = mem.get(pk); const snap = { ...(old ?? { o: blankOwners(), s: blankSites(), oc: blankOwners(), sk: Array(12).fill(3) }), k: { t: k.tile ?? null, n: k.troops ?? 0, c: k.holder ?? null, h: k.heartland ?? null, b: int(k.asOfBell) ? k.asOfBell : null } }; mem.put(pk, snap); }
      continue;
    }
    const was = mem?.get(pk)?.k ?? null;
    if (lv < L2 || !was || !int(was.t)) continue;
    out.set(key, { ...k, tile: was.t, holder: nation(was.c) || was.c === 6 ? was.c : NONE, troops: was.n ?? 0, heartland: was.h ?? false, contender: NONE, progress: 0, asOfBell: int(was.b) ? was.b : null, fog: 'memory' });
  }
  return out;
}

/**
 * Other nations' marches and columns: a public DEPART-like record `{origin_p, origin_q, origin_tile, faction}` is told
 * only when its origin is in sight now (its column is then seen setting out) — or the viewer's own nation's.
 */
export function departureSeen(d, { survey, viewer = null } = {}) {
  if (nation(viewer) && d?.faction === viewer) return true;
  const p = Number(d?.origin_p ?? d?.p), q = Number(d?.origin_q ?? d?.q), t = Number(d?.origin_tile ?? d?.tile);
  if (!int(p) || !int(q)) return false;
  return int(t) ? survey.levelOf(p, q, t) === L3 : maxOf(survey, p, q) === L3;
}

/** The incoming warnings (fmarch.mjs incomingWarnings) the viewer may be told: see FOG_RULES.incomingTurns. */
export function fogIncoming(list, { nowBell = 0, departures = [], survey, viewer = null } = {}) {
  if (!Array.isArray(list)) return list;
  const seenBells = new Set(departures.filter(d => departureSeen(d, { survey, viewer })).map(d => d.arrive_bell));
  return list.filter(w => int(w?.bell) && (w.bell - nowBell <= FOG_RULES.incomingTurns || seenBells.has(w.bell)));
}

/**
 * Whether a chronicle record (herald events: `{name, p, q, tile?, host_id?, faction?}` or `{record: …}`) may be told:
 * one with no place, the viewer's own (`mine(record)`), or one whose place is in sight now. Positions out of sight —
 * another nation's village placed, a march set out, a clash — are not told (no "something happened somewhere").
 */
export function recordSeen(x, { survey, mine = () => false, keepTileOf = () => null } = {}) {
  const r = x?.record ?? x;
  if (!r) return false;
  if (mine(r)) return true;
  const p = Number(r.p ?? r.origin_p ?? r.dest_p), q = Number(r.q ?? r.origin_q ?? r.dest_q);
  if (!int(p) || !int(q)) return true;
  const t = Number(r.tile ?? r.origin_tile ?? r.dest_tile);
  if (int(t) && t >= 0 && t < PROVINCE_TILES) return survey.levelOf(p, q, t) === L3;
  // (verify-pr117, L5-6 follow-up: a CLASH record — keyed by province and turn, no tile — : the chronicle's 「…で衝突が
  //  決着した」 and its 「報告」, the recent clashes list, follow the clash rule of clashSeen: its keep tile in sight, else
  //  the whole province; one rim tile in sight is not enough. The viewer's own (a village there: `mine`) was told above)
  if (r.name === 'CLASH') return clashSeen({ p, q, keepTile: keepTileOf(p, q) }, { survey });
  return maxOf(survey, p, q) === L3;
}

/**
 * (fix-loop5, L5-6) Whether a CLASH of province (p, q) — its report, its replay, its scene played on the map — may be
 * offered or read under the fog. Always without fog, and always when it is the viewer's own (`mine`: a village of the
 * viewer's there, a march of the viewer's arriving at it). Otherwise only while its place is in sight NOW (#93: other
 * nations' clashes show only inside current vision; seen before is not enough): the keep tile when the province has a
 * keep (a keep's clash is fought on it), else the whole province. A province with only a few rim tiles in sight is not
 * enough (loop-play5: such a province offered 「戦いを再生」 and the full AI-vs-AI report).
 */
export function clashSeen({ p, q, keepTile = null, mine = false } = {}, { survey } = {}) {
  if (mine) return true;
  if (!survey || survey.showAll) return true;
  if (!int(p) || !int(q)) return false;
  if (int(keepTile) && keepTile >= 0 && keepTile < PROVINCE_TILES) return survey.levelOf(p, q, keepTile) === L3;
  return survey.province(p, q).kind === 'sight';
}

// ------------------------------------------------------------------ the page's fog
let current = null;

/**
 * The fog of the page, kept between frames: `fogger(input)` → the fog view `{on, survey, overviews, wide, keeps(map),
 * incoming(list, ctx), seen(record)}` or `{on: false}`. `input`: {active, survey, overviews (RAW Map), wide (RAW land),
 * keeps, viewer, terrainOf, relayout, memKey}. Rings are fogged again only when their raw object or the survey changed.
 * The last view is also kept for modules that are not handed it (`fogNow()`).
 */
export function createFogger({ storage = browserStorage } = {}) {
  const mem = createFogMemory({ storage });
  const rings = new Map();   // ring → {raw, rev, out}
  let wideCache = { raw: null, rev: -1, out: null }, keepCache = { raw: null, rev: -1, out: null };
  let lastRev = -1, view = { on: false };
  return function fogger(input = {}) {
    if (!input.active || !input.survey || input.survey.showAll) { view = { on: false }; current = view; return view; }
    const sv = input.survey;
    mem.use(input.memKey ?? null);
    const rev = `${sv.rev}|${input.terrainRev ?? ''}`;
    const overviews = new Map();
    for (const [ring, raw] of input.overviews ?? []) {
      const hit = rings.get(ring);
      if (hit && hit.raw === raw && hit.rev === rev) { overviews.set(ring, hit.out); continue; }
      const out = fogOverview(raw, { survey: sv, mem, terrainOf: input.terrainOf, viewer: input.viewer });
      rings.set(ring, { raw, rev, out });
      overviews.set(ring, out);
    }
    for (const ring of [...rings.keys()]) if (!input.overviews?.has?.(ring)) rings.delete(ring);
    if (input.wide !== wideCache.raw || wideCache.rev !== rev) wideCache = { raw: input.wide, rev, out: input.wide ? fogWideLand(input.wide, { survey: sv, mem, viewer: input.viewer, relayout: input.relayout }) : null };
    const keepsOf = keeps => {
      if (!keeps) return keeps;
      // (the page's keep map is filled in place: its size is part of the key)
      const kr = `${rev}|${keeps.size ?? ''}`;
      if (keeps !== keepCache.raw || keepCache.rev !== kr) keepCache = { raw: keeps, rev: kr, out: fogKeeps(keeps, { survey: sv, mem, viewer: input.viewer }) };
      return keepCache.out;
    };
    if (sv.rev !== lastRev) { lastRev = sv.rev; mem.save(); }
    view = { on: true, survey: sv, overviews, wide: wideCache.out, keeps: keepsOf, memory: mem,
      incoming: (list, ctx = {}) => fogIncoming(list, { ...ctx, survey: sv, viewer: input.viewer }),
      seen: (record, mine) => recordSeen(record, { survey: sv, mine, keepTileOf: (p, q) => keepTileIn(input.overviews, p, q) }),
      clashSeen: x => clashSeen(x, { survey: sv }),
      departureSeen: d => departureSeen(d, { survey: sv, viewer: input.viewer }) };
    current = view;
    return view;
  };
}

/** The page's last fog view (`{on: false}` before one was made, and on every page without fog). */
export const fogNow = () => current ?? { on: false };
/** Test hook: forget the page's fog view. */
export const resetFogNow = () => { current = null; };

/** The overviews a surface that SHOWS the map reads: the fogged ones under the fog, else the page's own. */
export const viewOverviews = fs => { const f = fogNow(); return f.on && f.overviews ? f.overviews : fs?.overviews; };
/** The keeps a surface that SHOWS them reads (FS.conquest.keeps, fogged under the fog). */
export const viewKeeps = keeps => { const f = fogNow(); return f.on ? f.keeps(keeps) : keeps; };
/**
 * (fix-lp29-fog-fort, owner r0ze 2026-11-28 09:05, Q-LP29-1 (b)) The keeps the GUIDE and the KEEP LIST read: `viewKeeps`,
 * plus the one demo exception — the capture demo's prepared fort (fdemofort.mjs `demoFortNow`, set only on a launcher
 * capture-demo page from the launcher's checked answer; null everywhere else, so every other world reads exactly
 * `viewKeeps`). The fort is marked `demoFort: true`. In sight (or seen before) it is the fog's own entry, count included;
 * out of sight it is named by its position and the holder the demo chose it for, with NO defender count (`troops` absent),
 * no contest and `fog: 'demo'`. It passes only when the page's own records hold that province's keep on the same tile.
 * The map, the minimap, the keep panel and every other surface keep reading `viewKeeps`: nothing is drawn under the fog.
 */
let guideCache = { viewed: null, raw: null, fort: null, out: null };
export const guideKeeps = keeps => {
  const viewed = viewKeeps(keeps), fort = demoFortNow();
  if (!fort || !(keeps instanceof Map) || !(viewed instanceof Map)) return viewed;
  const key = `${fort.p},${fort.q}`, k = keeps.get(key);
  if (!k || k.tile !== fort.tile) return viewed;
  if (guideCache.viewed === viewed && guideCache.raw === k && guideCache.fort === fort) return guideCache.out;
  const out = new Map(viewed), shown = viewed.get(key);
  out.set(key, shown ? { ...shown, demoFort: true }
    : { p: k.p, q: k.q, tile: k.tile, holder: fort.holder, heartland: !!k.heartland, ...(int(k.consolidatedUntil) ? { consolidatedUntil: k.consolidatedUntil } : {}), asOfBell: null, fog: 'demo', demoFort: true });
  guideCache = { viewed, raw: k, fort, out };
  return out;
};
/** Whether a clash (report, replay, scene) of `{p, q, keepTile, mine}` may be offered (always, without fog). */
export const viewClash = x => { const f = fogNow(); return !f.on || !f.clashSeen || f.clashSeen(x); };
/**
 * (verify-pr117) Whether tile `tile` of (p, q) is at least at survey level `min` now (L3: in sight now; L2: surveyed,
 * the last-known of terrain and what stood there). No tile: the province's best level. Always without fog.
 */
export const viewTile = (p, q, tile, min = L3) => {
  const f = fogNow();
  if (!f.on || !f.survey || f.survey.showAll) return true;
  if (!int(p) || !int(q)) return false;
  return int(tile) && tile >= 0 && tile < PROVINCE_TILES ? f.survey.levelOf(p, q, tile) >= min : maxOf(f.survey, p, q) >= min;
};
/** The keep tile of (p, q) as the raw overviews carry it (null: no keep, or the province not in an overview read). */
export const keepTileIn = (overviews, p, q) => { for (const o of overviews?.values?.() ?? []) { const r = o?.provinces?.find?.(x => x.p === p && x.q === q); if (r) return r.keepTile ?? null; } return null; };
/** Whether a chronicle/feed record may be shown (always, without fog). */
export const viewRecord = (record, mine = () => false) => { const f = fogNow(); return !f.on || f.seen(record, mine); };
