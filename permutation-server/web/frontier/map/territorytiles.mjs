// PLAYER TERRITORY ON THE MAP (territory-map, owner decisions 2026-11-25 09:33 JST, inbox
// 2026-11-25-0933-r0ze-no-rec-items-decided.md items 3, 5, 6):
//
//   5  Q-LP15-2 (b) / T-9 / OQ-1  the tiles a player owns are DRAWN on the map, and the border follows them tile by tile;
//   6  OQ-3                       only the tiles actually owned are coloured (never a whole province); who holds a province
//                                 is shown by its keep's icon alone;
//   3  Q-LP15-3 (b) / Q-W13T-2 (b) the viewer's own tiles are always in view (not hidden by the fog of war).
//
// Where the owners come from: the territory province record of a wide province ('wn', 672 B, 'PSFXWTN1'; frontier-abi
// world_index/territory.rs TerritoryProvince: OWNER @104, 61 × u64 Citizen tags, 0 = nobody). (territory-map-2, owner
// 2026-11-25 12:04 Q-TM-4 (c)) The herald publishes them: `GET /h/world/wide/territory` (herald wide_territory.rs: every
// captured record with an owned tile, as tile → Citizen tag; one answer per change, shared by every viewer, ETag/gzip).
// The page reads that (`heraldTerritoryOwners`). Only a herald without the route (an older build: 404 / 503
// WideWorldUnavailable) sends a local test world's page back to its play relay's read-only account read
// (`frontier-local-play-act-wide-read-v1`, at most 16 addresses a request, program-owned accounts only, NOTHING is signed
// or sent). The page keeps only the provinces `territoryCandidates` names (its tiles' reach, the land in sight) of what
// it read, as before; the rest of the answer is dropped on arrival.
//
// Whose nation a tag is: a record names an owner by Citizen tag only (the first 8 bytes of the Citizen address, LE).
// The page learns tag → nation from what it already has: the captured wide villages (Holding OWNER_CITIZEN @72, FACTION
// @112), the heartland roster (people/roster.mjs: a site's tag) with the overview's owner of that site, and its own
// Citizen. A tag none of them names is drawn as "a player's land, nation not known" (grey), never guessed.
//
// FOG (map/fog.mjs, presentation only — every account is public on the chain): the viewer's own tiles are always drawn
// (decision 3) and give sight of THEMSELVES (the tile, not its neighbours: `ownTileAnchors`, radius 0 — "always in view
// (not hidden by fog)" says the tile itself; a wider sight would be a new rule, not asked); another player's tile is
// drawn while that tile is in sight now (survey level L3) — and (territory-map-2, owner 2026-11-25 12:04 Q-TM-1 (b)) a
// tile seen before keeps the owner it had when it was last in sight, drawn FADED (map/fog.mjs "last-known": what the
// viewer saw is kept, the live record only in sight). The memory is written only from tiles in sight
// (`rememberTerritory`), kept per world and player on this device beside the fog's own (`territoryMemoryKey`), and a
// tile in sight again shows its owner now (free → forgotten). Never-seen tiles stay hidden. The viewer's own tiles are
// always current, so they are never remembered; a remembered tile the live record now names as the viewer's is dropped.
//
// Look (#205's national border, per tile): each owned tile washed in its nation's land colour, and round the union of a
// nation's tiles its colour band with a dark seam on the edge, inside its land (wideland.mjs nationBands — the same
// mitred bands, here over tile hexes). From far (the world view and the chart) the tiles are small: the wash only. The
// keep of a province held by a nation is drawn as its icon in that nation's colour (keeps.mjs paintKeepMark) at every
// level; map/widemarks.mjs draws it at the province and tile views, `paintFarKeeps` from farther.
import { project, hexPoints } from '../../map.mjs';
import { tileHex, ringOf, PROVINCE_TILES } from '../fgeo.mjs';
import { NATION_LAND, NATION_DARK } from '../palette.mjs';
import { L3 } from './survey.mjs';
import { createFogMemory } from './fog.mjs';
import { heraldTerritoryRecords } from '../flocalplay-territory.mjs';
import { paintKeepMark } from './keeps.mjs';
import { nationBands, cellsIn, cellGrow, PATH_CHUNK } from './wideland.mjs';

/** frontier-abi TerritoryProvince: size, magic and the owners (61 × u64 LE @104). */
export const TERRITORY_PROVINCE_BYTES = 672, OWNERS_AT = 104;
/** The relay's read-only account read (gateway local-play-act.mjs LOCAL_ACT_WIDE_READ_SCHEMA / _MAX). */
export const TERRITORY_READ_SCHEMA = 'frontier-local-play-act-wide-read-v1', TERRITORY_READ_MAX = 16;
/** The herald's territory route (herald wide_territory.rs), and the largest answer the page takes (bytes). */
export const TERRITORY_HERALD_PATH = '/h/world/wide/territory', TERRITORY_HERALD_MAX_BYTES = 4 * 1024 * 1024;
/** How a remembered (last-seen, out of sight now) tile is drawn: its wash and border at these fractions of a current one's. */
export const FADED = Object.freeze({ wash: 0.4, band: 0.4 });
/** How often the land is read again (ms; a claim is at most one a turn, a turn at ×60 is 10 s), and the most provinces a read asks for. */
export const TERRITORY_POLL_MS = 10_000, TERRITORY_MAX_PROVINCES = 160;
/** How far (provinces) a claim reaches from a village or an owned tile (TERRITORY_V1.range): where the viewer's tiles can be. */
export const CLAIM_REACH = 3;
/** The value of a tile no one owns (or whose owner is not shown), and of one whose owner's nation is not known. */
export const NOBODY = -1, UNKNOWN_NATION = 6;
/** The colours of a player's land whose nation is not known. */
export const UNKNOWN_LAND = '#9a9a92', UNKNOWN_DARK = '#4a4a44';
/** The look of the tiles by level of detail (CSS px): `wash` the owned tile's fill alpha, `band`/`seam` the border's. */
export const TILE_LOOK = Object.freeze({
  tile: Object.freeze({ wash: 0.42, band: 4, seam: 1.5 }),
  // (the province view: one band in the nation's colour, no separate seam — measured live with every tile of 108 wide
  //  provinces owned in a six-nation mosaic, ~4,600 rim sides in view: each band layer costs ~5.7 ms a paint there)
  province: Object.freeze({ wash: 0.62, band: 2.4, seam: 0 }),
  world: Object.freeze({ wash: 0.9, band: 0, seam: 0 }),
  chart: Object.freeze({ wash: 0.92, band: 0, seam: 0 }),
});
// the tile hex's six neighbours, in the order of hexPoints' sides (side i joins corners i and i+1, facing i × 60°)
const SIDE_STEP = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const nation = n => Number.isInteger(n) && n >= 0 && n < 6;
const u64le = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true);

/** A territory province record's bytes → its 61 owners (Citizen tags as decimal strings, null = nobody), or null. */
export function territoryOwners(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== TERRITORY_PROVINCE_BYTES) return null;
  if (String.fromCharCode(...bytes.subarray(0, 8)) !== 'PSFXWTN1') return null;
  const out = [];
  for (let i = 0; i < PROVINCE_TILES; i++) { const t = u64le(bytes, OWNERS_AT + 8 * i); out.push(t === 0n ? null : t.toString()); }
  return out;
}

const DEC_TAG = /^[1-9]\d{0,19}$/;
/**
 * The herald's territory answer (`GET /h/world/wide/territory`, herald wide_territory.rs) → Map "p,q" → 61 owners (Citizen
 * tags as decimal strings, null = nobody), or null when it is not one (flocalplay-territory.mjs heraldTerritoryRecords:
 * a wrong version, season, world or program — `pins` as far as the page knows them —, a tag or tile out of range).
 */
export function heraldTerritoryOwners(json, pins = {}) {
  const recs = heraldTerritoryRecords(json, pins);
  return recs ? new Map([...recs].map(([k, r]) => [k, r.owners])) : null;
}

/**
 * Tag → nation from what the page has (pure): `cells` the RAW wide land's cells, their `owners` ([{tag, nation}], the
 * captured wide villages: wideland.mjs villageOwner), `roster` ([{p, q, site, tag}], people/roster.mjs entries) with `siteNation(p, q, site)` (the
 * overview's owner of that site), and the viewer's own `{tag, nation}`. → Map tag (decimal string) → nation 0–5.
 */
export function tagNations({ cells = [], roster = [], siteNation = () => null, own = null } = {}) {
  const out = new Map();
  for (const c of cells) for (const o of c?.owners ?? []) if (o?.tag && nation(o.nation)) out.set(o.tag, o.nation);
  for (const r of roster) {
    if (r?.tag === null || r?.tag === undefined) continue;
    const n = siteNation(r.p, r.q, r.site), tag = String(r.tag);
    if (nation(n) && !out.has(tag)) out.set(tag, n);
  }
  if (own?.tag && nation(own.nation)) out.set(String(own.tag), own.nation);
  return out;
}

/** Province steps between two wide provinces `{p, q}` (numbers). */
export const provinceSteps = (a, b) => ringOf(a.p - b.p, a.q - b.q);

/**
 * The provinces to read, in order (pure): `cells` the territory provinces of the wide land (cells with `territory`),
 * `ownAt` the keys where the viewer owned tiles at the last read, `anchors` [{p, q}] the viewer's own villages (wide ones
 * and its home), `sight(cell)` whether the province has a tile in sight now (null: no fog — none is "in sight"). The
 * viewer's tiles lie within CLAIM_REACH of a village or of another of its tiles (T-2 reach), so those come first; then
 * the provinces in sight, nearest an anchor first. → keys, at most `max`.
 */
export function territoryCandidates({ cells = [], ownAt = [], anchors = [], sight = null, max = TERRITORY_MAX_PROVINCES } = {}) {
  const terr = cells.filter(c => c?.territory);
  const byKey = new Map(terr.map(c => [c.key, c]));
  const out = [], have = new Set();
  const add = k => { if (out.length < max && byKey.has(k) && !have.has(k)) { have.add(k); out.push(k); } };
  for (const k of ownAt) add(k);
  const centres = [...anchors.filter(a => Number.isInteger(a?.p) && Number.isInteger(a?.q)), ...[...ownAt].map(k => byKey.get(k)).filter(Boolean)];
  const near = c => centres.reduce((m, a) => Math.min(m, provinceSteps(a, c)), Infinity);
  const ranked = terr.map(c => ({ c, d: near(c) })).sort((a, b) => a.d - b.d || (a.c.key < b.c.key ? -1 : 1));
  for (const { c, d } of ranked) if (d <= CLAIM_REACH) add(c.key);
  if (typeof sight === 'function') for (const { c } of ranked) if (sight(c)) add(c.key);
  return out;
}

/**
 * Keeps the territory of the provinces `candidates()` names read in the background: `{now(), reload(), stop()}`.
 * `reads()` → `{all() → Map key → owners | null, ownTag}` (the herald's route: one GET for the whole world, of which only
 * the candidates are kept), or `{read(addresses) → [Uint8Array | null], province(p, q) → address, ownTag}` (the relay's
 * account read, 16 a request), or null (no wide world, no Citizen yet: nothing is read and the land is forgotten).
 * `now()` → `{rev, ownRev, owners: Map key → [tag | null] × 61, known, ownTag, ownAt: [key], read: [key], at}` (`read`:
 * the provinces the last answer covered). A read that fails keeps the last answer. `onChange()` runs when what was
 * read changed. Never throws; never signs or sends.
 *
 * (territory-map-2: no leak through the data path) `keep(p, q, tile, tag)` — the page's fog: whether the viewer may
 * know who owns that tile now (in sight) — filters every answer as it arrives: the state keeps the owner of the
 * viewer's own tiles and of the tiles `keep` admits, and nothing of the others (null, as a free tile). `known` (Map key
 * → [tile]) names the tiles whose owner — or freedom — the state knows; without `keep` (no fog) every tile is known
 * and `known` is null. The page reloads when its sight changes, so a tile coming into sight is read within moments.
 */
export function mountTerritoryTiles({ reads = () => null, candidates = () => [], keep = null, onChange = () => {}, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = t => clearTimeout(t), everyMs = TERRITORY_POLL_MS } = {}) {
  // (`ownRev` moves only when the viewer's own tiles do — they are the survey's anchors, item 3 —; `rev` on any change)
  let state = { rev: 0, ownRev: 0, owners: new Map(), known: null, ownTag: null, ownAt: [], read: [], at: 0 }, timer = null, stopped = false, busy = false, again = false, sig = '', ownSig = '';
  const later = ms => { if (stopped) return; if (timer) clearTimer(timer); timer = setTimer(tick, ms); };
  /** One province's raw owners as the state may keep them: `{kept, known}`. */
  const admit = (k, o, ownTag) => {
    const [p, q] = k.split(',').map(Number), kept = new Array(PROVINCE_TILES).fill(null), known = [];
    for (let i = 0; i < PROVINCE_TILES; i++) {
      const t = o?.[i] ?? null;
      let ok = t !== null && !!ownTag && t === ownTag;
      if (!ok) { if (typeof keep !== 'function') ok = true; else { try { ok = !!keep(p, q, i, t); } catch { ok = false; } } }
      if (ok) { known.push(i); kept[i] = t; }
    }
    return { kept, known };
  };
  const publish = (owners, ownTag, read = [], known = null) => {
    const ownAt = [...owners].filter(([, o]) => ownTag && o.includes(ownTag)).map(([k]) => k).sort();
    const ks = known ? [...known].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, l]) => `${k}:${l.join('.')}`).join(';') : '*';
    const s = `${ownTag}|${[...read].sort().join(';')}|${ks}|${[...owners].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, o]) => `${k}:${o.map(t => t ?? '').join(',')}`).join(';')}`;
    if (s === sig) { state = { ...state, at: Date.now(), read }; return; }
    sig = s;
    const os = `${ownTag}|${ownAt.map(k => `${k}:${owners.get(k).map((t, i) => (t === ownTag ? i : '')).join(',')}`).join(';')}`;
    const ownRev = os === ownSig ? state.ownRev : state.ownRev + 1;
    ownSig = os;
    state = { rev: state.rev + 1, ownRev, owners, known, ownTag, ownAt, at: Date.now(), read };
    try { onChange(); } catch { /* the page's own */ }
  };
  const take = (keys, rawOf, ownTag) => {
    const owners = new Map(), known = typeof keep === 'function' ? new Map() : null;
    for (const k of keys) {
      const o = rawOf(k);
      const a = admit(k, Array.isArray(o) && o.length === PROVINCE_TILES ? o : null, ownTag);
      if (a.kept.some(t => t !== null)) owners.set(k, a.kept);
      if (known && a.known.length) known.set(k, a.known);
    }
    publish(owners, ownTag, keys, known);
  };
  async function tick() {
    if (stopped) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      let r = null;
      try { r = reads(); } catch { r = null; }
      if (!r) { if (state.owners.size || state.ownTag) { sig = ''; ownSig = ''; state = { rev: state.rev + 1, ownRev: state.ownRev + 1, owners: new Map(), known: null, ownTag: null, ownAt: [], read: [], at: 0 }; onChange(); } return; }
      let keys = [];
      try { keys = candidates({ ownAt: state.ownTag === r.ownTag ? state.ownAt : [] }) ?? []; } catch { keys = []; }
      const owners = new Map();
      if (typeof r.all === 'function') {
        // (the herald's whole answer: only the candidates are kept — the land neither within the viewer's reach nor in sight is dropped here)
        const all = await r.all();
        if (stopped) return;
        if (!(all instanceof Map)) return; // (a failed read keeps the last answer)
        take(keys, k => all.get(k) ?? null, r.ownTag ?? null);
        return;
      }
      for (let i = 0; i < keys.length; i += TERRITORY_READ_MAX) {
        const part = keys.slice(i, i + TERRITORY_READ_MAX);
        const addrs = part.map(k => { const [p, q] = k.split(','); return r.province(p, q); });
        const got = await r.read(addrs);
        if (stopped) return;
        if (!Array.isArray(got) || got.length !== part.length) return; // (a failed read keeps the last answer)
        part.forEach((k, j) => { const o = got[j] ? territoryOwners(got[j]) : null; if (o && o.some(t => t !== null)) owners.set(k, o); });
      }
      take(keys, k => owners.get(k) ?? null, r.ownTag ?? null);
    } catch { /* the relay did not answer: the last answer stays */ } finally { busy = false; later(again ? 0 : everyMs); again = false; }
  }
  later(0);
  return {
    now: () => state,
    reload: () => later(0),
    stop: () => { stopped = true; if (timer) clearTimer(timer); timer = null; },
  };
}

/**
 * The sight the viewer's own tiles give (decision 3): one anchor per own tile, the tile itself (radius 0), in sight
 * (L3) — map/survey.mjs anchorsOf `extraAnchors`. `owners` Map key → tags, `ownTag` the viewer's.
 */
export function ownTileAnchors(owners, ownTag) {
  const out = [];
  if (!ownTag || !owners) return out;
  for (const [k, o] of owners) {
    const [p, q] = k.split(',').map(Number);
    if (!Number.isInteger(p) || !Number.isInteger(q)) continue;
    o.forEach((t, i) => { if (t === ownTag) { const h = tileHex(p, q, i); out.push({ q: h.q, r: h.r, radius: 0, level: L3, kind: 'own-tile' }); } });
  }
  return out;
}

// ------------------------------------------------------------------ last-seen owners (territory-map-2, Q-TM-1 (b))
/** The device storage key of the viewer's remembered tile owners in one world: the fog's own key (map/fog.mjs
 * fogMemoryKey — world, season and wallet) under its own prefix. null: nothing is stored (memory lasts as long as the page). */
export const territoryMemoryKey = fogKey => (typeof fogKey === 'string' && fogKey.startsWith('ps-ffog:') ? `ps-fterr:${fogKey.slice('ps-ffog:'.length)}` : null);
/** The memory of last-seen owners: map/fog.mjs createFogMemory (`use(key)`, `get(pk)`, `put(pk, snap)`, `save()`), a
 * province's snapshot `{o: [[tile, tag], ...]}` — the tiles of OTHER players the viewer last saw owned there. */
export const createTerritoryMemory = opts => createFogMemory(opts);
/** A province's remembered owners from `mem` → Map tile → tag (empty when none). */
export const rememberedOf = (mem, key) => new Map((mem?.get?.(key)?.o ?? []).filter(x => Array.isArray(x) && Number.isInteger(x[0]) && x[0] >= 0 && x[0] < PROVINCE_TILES && typeof x[1] === 'string' && DEC_TAG.test(x[1])));

/**
 * Writes what the viewer sees now into the memory (pure but for `mem`): for each province the last answer covered
 * (`read`, `owners` as mountTerritoryTiles' state), each tile in sight now (`seen(p, q, tile)`, survey L3) is
 * remembered with its owner now, or forgotten when it is free; a tile out of sight is left as it was. The viewer's own
 * tiles (`ownTag`) are always drawn as they are now, so they are never remembered (and a remembered tile now the
 * viewer's is dropped). `known` (the reader's: Map key → [tile], or null = all) — a tile in sight now that the last
 * answer did not know (it came into sight since) is left as it was until the next read. → whether the memory changed.
 */
export function rememberTerritory(mem, { owners = new Map(), read = [], ownTag = null, seen = () => false, known = null } = {}) {
  if (!mem?.put) return false;
  let changed = false;
  for (const k of new Set([...read, ...owners.keys()])) {
    const [p, q] = String(k).split(',').map(Number);
    if (!Number.isInteger(p) || !Number.isInteger(q)) continue;
    const raw = owners.get(k) ?? null, m = rememberedOf(mem, k), before = JSON.stringify([...m].sort((a, b) => a[0] - b[0]));
    const kn = known ? new Set(known.get(k) ?? []) : null;
    for (let i = 0; i < PROVINCE_TILES; i++) {
      const t = raw?.[i] ?? null;
      if (t !== null && t === ownTag) { m.delete(i); continue; }
      if (!seen(p, q, i) || (kn && !kn.has(i))) continue;
      if (t === null) m.delete(i); else m.set(i, t);
    }
    const o = [...m].sort((a, b) => a[0] - b[0]);
    if (JSON.stringify(o) === before || (!o.length && !mem.get(k))) continue;
    if (mem.put(k, { o })) changed = true;
  }
  return changed;
}

/**
 * The land with its tiles' owners as the viewer may see them (pure): each cell of `land` (the wide land the map shows,
 * fogged under the fog) gets `tiles` ([NOBODY | nation 0–5 | UNKNOWN_NATION] × 61), `mine` (the tiles the viewer
 * owns) and `faded` (the tiles drawn from memory); the land gets `territory` `{tiles, mine, faded, nations}` (counts)
 * and `geo` (the tiles' hexes and rim sides by cell, for paintTerritoryTiles). `fogged`: whether the fog is on;
 * `seen(p, q, tile)` whether a tile is in sight now. The viewer's own tiles are always shown; another's in sight now,
 * and under the fog, out of sight, the owner it had when last seen (`remembered(key)` → Map tile → tag: Q-TM-1 (b)),
 * faded; never under a fog page that has no vision yet (`hidden`). `known` (the reader's, Map key → [tile] or null =
 * all): a tile in sight that the last answer does not know yet shows its memory until it is read. Cells without an
 * owned tile shown are passed as they are.
 */
export function territoryLand(land, { owners = null, tagNation = new Map(), ownTag = null, viewer = null, fogged = false, hidden = false, seen = () => true, remembered = null, known = null } = {}) {
  const recall = fogged && !hidden && typeof remembered === 'function' ? remembered : null;
  if (!land?.cells || (!owners?.size && !recall)) return land;
  const hexes = new Map(); // hexKey → nation (the union per nation, across provinces)
  const hk = (q, r) => `${q},${r}`;
  const shown = new Map(); // cell key → {tiles, mine}
  let nTiles = 0, nMine = 0, nFaded = 0;
  const nations = new Set();
  for (const c of land.cells) {
    const o = owners?.get(c.key) ?? null, mem = recall ? recall(c.key) : null, kn = known ? new Set(known.get(c.key) ?? []) : null;
    if (!o && !mem?.size) continue;
    const tiles = new Array(PROVINCE_TILES).fill(NOBODY), mine = [], faded = [];
    let any = false;
    for (let i = 0; i < PROVINCE_TILES; i++) {
      let t = o?.[i] ?? null, stale = false;
      const own = t !== null && !!ownTag && t === ownTag;
      if (!own && (hidden || (fogged && (!seen(c.p, c.q, i) || (kn && !kn.has(i)))))) {
        // (out of sight: the owner when last seen, faded — never the record now; a tile never seen has none)
        t = mem?.get(i) ?? null;
        if (t === null || t === ownTag) continue;
        stale = true;
      } else if (t === null) continue;
      const n = own && nation(viewer) ? viewer : tagNation.get(t) ?? UNKNOWN_NATION;
      tiles[i] = nation(n) ? n : UNKNOWN_NATION;
      if (own) { mine.push(i); nMine++; }
      if (stale) { faded.push(i); nFaded++; }
      const h = tileHex(c.p, c.q, i);
      hexes.set(hk(h.q, h.r), tiles[i]);
      nations.add(tiles[i]); nTiles++; any = true;
    }
    if (any) shown.set(c.key, { tiles, mine, faded });
  }
  if (!shown.size) return land;
  const cells = land.cells.map(c => {
    const s = shown.get(c.key);
    if (!s) return c;
    // (each owned tile's hex in world px, and the sides of it where the land beyond is not the same nation's: the rim)
    const geo = [], fadedSet = new Set(s.faded);
    s.tiles.forEach((n, i) => {
      if (n === NOBODY) return;
      const h = tileHex(c.p, c.q, i), at = project(h.q, h.r), corners = hexPoints(at.x, at.y), rim = [];
      SIDE_STEP.forEach(([dq, dr], k) => { if (hexes.get(hk(h.q + dq, h.r + dr)) !== n) rim.push({ a: corners[k], b: corners[(k + 1) % 6] }); });
      geo.push({ tile: i, nation: n, faded: fadedSet.has(i), x: at.x, y: at.y, cx: c.x, cy: c.y, corners, rim });
    });
    return { ...c, tiles: s.tiles, mine: s.mine, faded: s.faded, geo };
  });
  const byKey = new Map(cells.map(c => [c.key, c]));
  return Object.freeze({ ...land, cells, byKey, territory: Object.freeze({ tiles: nTiles, mine: nMine, faded: nFaded, nations: [...nations].sort((a, b) => a - b) }), key: `${land.key}|tt:${nTiles}:${nMine}:${nFaded}` });
}

const landOf = n => (nation(n) ? NATION_LAND[n] : UNKNOWN_LAND);
const darkOf = n => (nation(n) ? NATION_DARK[n] : UNKNOWN_DARK);
// the band quads of one nation's rim at one width: computed again only when the tiles or the width change
const bandCache = new WeakMap();
function bandsOf(group, width, key) {
  let per = bandCache.get(group);
  if (!per) { per = new Map(); bandCache.set(group, per); }
  const k = `${key}|${width.toFixed(4)}`;
  let q = per.get(k);
  if (!q) { if (per.size > 8) per.clear(); q = nationBands(group, width); per.set(k, q); }
  return q;
}
const groupCache = new WeakMap();

/**
 * Paints the owned tiles of the cells of `land` in `seen` (world px; `ctx` in the map's world transform) at `zoom`, level
 * `level` (wideland.mjs wideLevel): each tile washed in its nation's land colour, and (at the province and tile views)
 * each nation's border round the union of its tiles — its colour band and a dark seam, inside its land. From far the
 * cells are enlarged about their centre (wideland.mjs cellGrow), the tiles with them. `view` (the picture's world
 * corners, as wideland.mjs holdersInView) names the nations whose tiles stand in the picture: the legend's. A tile
 * drawn from memory (last seen, out of sight now: Q-TM-1 (b)) is painted at FADED of a current one's wash and border.
 * → `{tiles, fills, nations, mine, faded}` (`faded`: remembered tiles in the picture).
 */
export function paintTerritoryTiles(ctx, land, { seen, zoom = 1, level = 'world', view = null } = {}) {
  const look = TILE_LOOK[level];
  if (!ctx?.fill || !look || !land?.territory) return { tiles: 0, fills: 0, nations: [], mine: 0, faded: 0 };
  const cells = cellsIn(land, seen).filter(c => c.geo?.length);
  if (!cells.length) return { tiles: 0, fills: 0, nations: [], mine: 0, faded: 0 };
  const grow = level === 'chart' || level === 'world' ? cellGrow(zoom) : 1, z = Math.max(zoom, 1e-9);
  let groups = groupCache.get(land);
  if (!groups) { groups = new Map(); groupCache.set(land, groups); }
  const gk = cells.map(c => c.key).join(';');
  let by = groups.get(gk);
  if (!by) {
    // (one group per nation and freshness: a nation's current tiles, then its remembered ones — the rims are the union's)
    by = new Map();
    for (const c of cells) for (const g of c.geo) { const k = g.nation * 2 + (g.faded ? 1 : 0); if (!by.has(k)) by.set(k, []); by.get(k).push(g); }
    if (groups.size > 4) groups.clear();
    groups.set(gk, by);
  }
  let fills = 0, tiles = 0, mine = 0, faded = 0;
  const inView = new Set();
  const inside = Array.isArray(view) && view.length >= 3 ? (x, y) => insideConvex(view, x, y) : () => true;
  ctx.save();
  for (const [gk2, group] of [...by].sort((a, b) => a[0] - b[0])) {
    const n = gk2 >> 1, old = (gk2 & 1) === 1;
    ctx.fillStyle = landOf(n); ctx.globalAlpha = look.wash * (old ? FADED.wash : 1);
    for (let i = 0; i < group.length; i += PATH_CHUNK) {
      ctx.beginPath();
      for (const g of group.slice(i, i + PATH_CHUNK)) {
        const cx = g.cx, cy = g.cy;
        g.corners.forEach(([x, y], j) => { const X = cx + (x - cx) * grow, Y = cy + (y - cy) * grow; return j ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
        ctx.closePath();
      }
      ctx.fill(); fills++;
    }
    tiles += group.length;
    for (const g of group) {
      const vis = inside(g.x, g.y);
      if (vis && !inView.has(n)) inView.add(n);
      if (vis && old) faded++;
    }
    if (look.band > 0) {
      ctx.globalAlpha = old ? FADED.band : 1;
      for (const [style, width] of [[landOf(n), look.band], [darkOf(n), look.seam]]) {
        if (!(width > 0)) continue;
        const quads = bandsOf(group, width / z, gk);
        ctx.fillStyle = style;
        for (let i = 0; i < quads.length; i += PATH_CHUNK) {
          ctx.beginPath();
          for (const q of quads.slice(i, i + PATH_CHUNK)) { ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]); ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]); ctx.closePath(); }
          ctx.fill(); fills++;
        }
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  for (const c of cells) mine += c.mine?.length ?? 0;
  return { tiles, fills, nations: [...inView].sort((a, b) => a - b), mine, faded };
}
/** Whether the world point (x, y) lies inside the convex polygon `poly` ([{x, y}], either winding). */
function insideConvex(poly, x, y) {
  let pos = false, neg = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], k = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (k > 0) pos = true; else if (k < 0) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

/**
 * From far (the world view and the chart, where map/widemarks.mjs draws no keep): the keep of each province a NATION
 * holds as its icon in that nation's colour (keeps.mjs paintKeepMark), on its own tile, the cell enlarged as wideland.mjs
 * draws it — who holds a province is said by its keep, not by colouring the province (decision 6). `viewer` the
 * viewer's nation (its keeps ringed). A keep whose holder the fog does not know is not drawn. → the number of marks.
 */
export function paintFarKeeps(ctx, land, { seen, zoom = 1, level = 'world', viewer = null } = {}) {
  if (!ctx?.save || !(level === 'world' || level === 'chart')) return 0;
  const grow = cellGrow(zoom);
  let n = 0;
  for (const c of cellsIn(land, seen)) {
    const h = c.keep?.holder ?? null;
    if (c.holderKnown === false || !nation(h) || !Number.isInteger(c.keep?.tile)) continue;
    const t = tileHex(c.p, c.q, c.keep.tile), at = project(t.q, t.r);
    paintKeepMark(ctx, c.x + (at.x - c.x) * grow, c.y + (at.y - c.y) * grow, { zoom, faction: h, mine: nation(viewer) && h === viewer, size: level === 'chart' ? 7 : 9 });
    n++;
  }
  return n;
}
