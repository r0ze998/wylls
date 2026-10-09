// The survey model (UX brief §3): what the play map draws for this viewer.
//
// Nothing here is a rule of the game and nothing is kept from anyone: every
// account is public and the spectator page shows all of it. The play map
// draws what the viewer has surveyed, and this file is the one place that
// says what that is. Every surface asks it: the tile view, the far views,
// the minimap, labels, hover tips, the inspector and search.
//
//   L0 cloud sea   the ring is not open (the land does not exist yet)
//   L1 chart       an open ring the viewer never had in sight: terrain only
//   L2 surveyed    seen before, not in sight now: the land and its villages, muted
//   L3 in sight    within sight of the viewer's villages and hosts now: everything
//
// Sight is counted in tiles around anchors (SIGHT, presentation parameters):
// the viewer's villages by tier, own hosts by kind, the candidate sites of an
// open ticket. Tiles the viewer explored (and their six neighbours) and the
// destinations of the viewer's own marches stay surveyed. Everything that
// was ever in sight this season stays surveyed too: that memory is rebuilt
// from the records on every load and a compact set kept on this device is
// merged in (a convenience of this device, never a record).
//
// Pure functions; no DOM, no clock of its own. `buildSurvey` makes the
// lookup once for a set of anchors (never per tile, never per frame);
// `createSurveyor` keeps the last one, the device's memory and the tiles
// that have just come into sight for the first time (the reveal).
import { DIRECTIONS, PROVINCE_TILES, hexDistance, locate, ringOf, tileHex } from '../fgeo.mjs';

export const L0 = 0, L1 = 1, L2 = 2, L3 = 3;
/** The levels' names, by number. */
export const LEVELS = Object.freeze(['cloud', 'chart', 'surveyed', 'sight']);
/** The fog names the province-level painters know (map/layers.mjs fogLevel), by level. */
export const FOG_OF_LEVEL = Object.freeze(['unopened', 'distant', 'known', 'sight']);
/** Tiles a village works, by tier (the rules kernel's worked_radius; the territory wash uses the same). */
export const WORKED_RADIUS = Object.freeze([1, 2, 2, 3]);
/** The unit byte of a Scout host. */
export const SCOUT_UNIT = 6;
/**
 * How far things see, in tiles (presentation parameters, not rules): a
 * village 3 + its worked radius (a hamlet 4), a combat host 2, a Scout 3, a
 * candidate site of an open ticket 1 (a small disc). An explored tile keeps
 * itself and its six neighbours surveyed; a march's destination likewise.
 */
export const SIGHT = Object.freeze({
  village: tier => 3 + (WORKED_RADIUS[tier] ?? WORKED_RADIUS[0]),
  host: 2,
  scout: 3,
  candidate: 2,
  explored: 1,
  destination: 1,
});
/** A tile first seen dissolves out of the chart over this long (ms), later by this much per tile of distance. */
export const REVEAL_MS = 900;
export const REVEAL_STAGGER_MS = 80;
/** The device's memory holds at most this many provinces (the oldest are dropped). */
export const MEMORY_PROVINCES = 512;

const OFF = 2048, SPAN = 4096;
/** One number for a tile's hex (the open world is far inside ±2047). */
export const hexKey = (q, r) => (q + OFF) * SPAN + (r + OFF);
export const keyHex = k => ({ q: Math.floor(k / SPAN) - OFF, r: (k % SPAN) - OFF });

const int = Number.isInteger;
const place = o => (o && int(o.p) && int(o.q) && int(o.tile) ? tileHex(o.p, o.q, o.tile) : null);

/**
 * The anchors of a viewer, as hexes: `[{q, r, radius, level, kind}]`.
 * `villages` `[{p, q, tile, tier}]`, `hosts` `[{p, q, tile, unit}]`,
 * `candidates`, `explored` and `destinations` `[{p, q, tile}]`. Anything
 * without a whole tile is left out (a candidate whose province has no
 * terrain yet has no tile).
 */
export function anchorsOf({ villages = [], hosts = [], candidates = [], explored = [], destinations = [] } = {}) {
  const out = [];
  const add = (o, radius, level, kind) => { const h = place(o); if (h) out.push({ q: h.q, r: h.r, radius, level, kind }); };
  for (const v of villages) add(v, SIGHT.village(v.tier ?? 0), L3, 'village');
  for (const h of hosts) add(h, h.unit === SCOUT_UNIT ? SIGHT.scout : SIGHT.host, L3, 'host');
  for (const c of candidates) add(c, SIGHT.candidate, L3, 'candidate');
  for (const e of explored) add(e, SIGHT.explored, L2, 'explored');
  for (const d of destinations) add(d, SIGHT.destination, L2, 'destination');
  return out;
}

/**
 * The lookup for one set of anchors.
 *
 * `ringsOpen` rings 0..ringsOpen-1 exist; `showAll` (the spectator and
 * practice pages): every open tile is in sight; `anchors` from anchorsOf;
 * `memory` a Set of hexKey: tiles that were in sight before.
 *
 * Returns `{ringsOpen, showAll, levelAt(q, r), levelOf(p, q, idx),
 * province(p, q), tiles, away, anchors, count}`:
 *   levelAt / levelOf   0..3 for a tile
 *   province            `{kind, max, min, sig, sig2}` of a province, where kind is
 *                       'cloud' (ring not open), 'chart' (nothing surveyed in it or
 *                       next to it), 'sight' (all of it and its rim in sight) or 'mixed';
 *                       `sig` changes with any level in or around it, `sig2` only
 *                       when a tile in or around it becomes surveyed or stops being so
 *   tiles               Map hexKey → 2 | 3 (every surveyed tile; empty with showAll)
 *   away                Map hexKey → tiles from the nearest anchor that sees it
 */
export function buildSurvey({ ringsOpen = 1, showAll = false, anchors = [], memory = null } = {}) {
  const tiles = new Map(), away = new Map();
  const open = (q, r) => { const at = locate(q, r); return ringOf(at.p, at.q) < ringsOpen; };
  if (!showAll) {
    for (const a of anchors) {
      const n = a.radius;
      for (let dq = -n; dq <= n; dq++) for (let dr = Math.max(-n, -dq - n); dr <= Math.min(n, -dq + n); dr++) {
        const q = a.q + dq, r = a.r + dr, k = hexKey(q, r);
        if ((tiles.get(k) ?? 0) < a.level) tiles.set(k, a.level);
        if (a.level === L3) { const d = hexDistance(0, 0, dq, dr); if (!(away.get(k) <= d)) away.set(k, d); }
      }
    }
    for (const k of memory ?? []) if (!tiles.has(k)) tiles.set(k, L2);
    // what lies in a ring that is not open does not exist yet
    for (const k of [...tiles.keys()]) { const h = keyHex(k); if (!open(h.q, h.r)) { tiles.delete(k); away.delete(k); } }
  }
  const levelAt = (q, r) => {
    if (showAll) return open(q, r) ? L3 : L0;
    return tiles.get(hexKey(q, r)) ?? (open(q, r) ? L1 : L0);
  };
  const provinces = new Map();
  const province = (p, q) => {
    const pk = `${p},${q}`;
    const hit = provinces.get(pk);
    if (hit) return hit;
    let v;
    if (ringOf(p, q) >= ringsOpen) v = { kind: 'cloud', max: L0, min: L0, sig: '0', sig2: '0' };
    else if (showAll) v = { kind: 'sight', max: L3, min: L3, sig: '3', sig2: '3' };
    else {
      let max = L1, min = L3, near = false, rim = L3, sig = '', sig2 = '';
      for (let i = 0; i < PROVINCE_TILES; i++) {
        const h = tileHex(p, q, i);
        const lv = tiles.get(hexKey(h.q, h.r)) ?? L1;
        if (lv > max) max = lv;
        if (lv < min) min = lv;
        sig += lv; sig2 += lv >= L2 ? 1 : 0;
        // the rim: tiles of other provinces next to this one (a soft edge reaches one tile across a border)
        for (const [dq, dr] of DIRECTIONS) {
          const nq = h.q + dq, nr = h.r + dr, at = locate(nq, nr);
          if (at.p === p && at.q === q) continue;
          const nl = levelAt(nq, nr);
          if (nl >= L2) near = true;
          if (nl !== L0 && nl < rim) rim = nl;
          sig += nl; sig2 += nl >= L2 ? 1 : 0;
        }
      }
      const kind = max < L2 && !near ? 'chart' : min === L3 && rim === L3 ? 'sight' : 'mixed';
      v = kind === 'chart' ? { kind, max, min, sig: '1', sig2: '1' } : kind === 'sight' ? { kind, max, min, sig: '3', sig2: '3' } : { kind, max, min, sig, sig2 };
    }
    provinces.set(pk, v);
    return v;
  };
  const levelOf = (p, q, idx) => { const h = int(idx) ? tileHex(p, q, idx) : null; return h ? levelAt(h.q, h.r) : province(p, q).max; };
  let n3 = 0;
  for (const lv of tiles.values()) if (lv === L3) n3++;
  return { ringsOpen, showAll, levelAt, levelOf, province, tiles, away, anchors, count: { surveyed: tiles.size, sight: n3 } };
}

/** The survey of a page with no viewer (the spectator, practice): every open tile in sight. */
export const openSurvey = ringsOpen => buildSurvey({ ringsOpen, showAll: true });

// ------------------------------------------------------------------ the device's memory
/** The storage key of a wallet's surveyed tiles in a season (beside `ps-fui:` and `ps-fmarch:`). */
export const memoryKey = ({ cluster, programId, seasonId }, wallet) => `ps-fsurvey:${cluster}:${programId}:${seasonId}:${wallet}`;

/** A Set of hexKey as text: `{"v":1,"t":{"P,Q":"<16 hex digits: the province's 61 tiles as bits>"}}`. */
export function packMemory(keys, limit = MEMORY_PROVINCES) {
  const by = new Map();
  for (const k of keys) {
    const h = keyHex(k), at = locate(h.q, h.r), pk = `${at.p},${at.q}`;
    by.set(pk, (by.get(pk) ?? 0n) | (1n << BigInt(at.idx)));
  }
  const t = {};
  for (const [pk, bits] of [...by].slice(-limit)) t[pk] = bits.toString(16);
  return JSON.stringify({ v: 1, t });
}

/** The Set a stored text holds (damaged text: an empty set). */
export function unpackMemory(text) {
  const out = new Set();
  try {
    const v = JSON.parse(text ?? 'null');
    if (!v || v.v !== 1 || typeof v.t !== 'object' || v.t === null) return out;
    for (const [pk, hex] of Object.entries(v.t).slice(0, MEMORY_PROVINCES)) {
      const m = /^(-?\d{1,4}),(-?\d{1,4})$/.exec(pk);
      if (!m || typeof hex !== 'string' || !/^[0-9a-f]{1,16}$/.test(hex)) continue;
      const p = Number(m[1]), q = Number(m[2]), bits = BigInt(`0x${hex}`);
      for (let i = 0; i < PROVINCE_TILES; i++) if ((bits >> BigInt(i)) & 1n) { const h = tileHex(p, q, i); out.add(hexKey(h.q, h.r)); }
    }
  } catch { /* an empty memory */ }
  return out;
}

/** localStorage when it works (else the memory lasts as long as the page). */
export const browserStorage = {
  get(k) { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } },
  set(k, v) { try { globalThis.localStorage.setItem(k, v); return true; } catch { return false; } },
};

/** Add every tile in sight to `memory` (a Set); returns how many were new. */
export function remember(memory, survey) {
  let n = 0;
  for (const [k, lv] of survey.tiles) if (lv === L3 && !memory.has(k)) { memory.add(k); n++; }
  return n;
}

// ------------------------------------------------------------------ the reveal
/**
 * The tiles of `next` that are in sight and were not surveyed in `prev`:
 * Map hexKey → the time its dissolve starts (ms), `now` for the nearest to
 * the anchor that sees them and REVEAL_STAGGER_MS later per tile further out.
 */
export function revealPlan(prev, next, now = 0) {
  const fresh = [];
  for (const [k, lv] of next.tiles) if (lv === L3 && !prev?.tiles?.has(k)) fresh.push([k, next.away.get(k) ?? 0]);
  if (!fresh.length) return new Map();
  const first = Math.min(...fresh.map(x => x[1]));
  return new Map(fresh.map(([k, d]) => [k, now + (d - first) * REVEAL_STAGGER_MS]));
}

/** How far a tile's dissolve is at `now`: 0 (still chart) to 1 (painted), or null when it has none. */
export function revealAt(reveals, k, now) {
  const t0 = reveals?.get(k);
  if (t0 === undefined) return null;
  return Math.max(0, Math.min(1, (now - t0) / REVEAL_MS));
}

// ------------------------------------------------------------------ the page's surveyor
const sigOf = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v));

/**
 * The survey of the page's viewer, kept between frames: `surveyor(input)`
 * returns the same object until the input changes. `input`:
 *   {mode: 'play' | other, ringsOpen, ready, wallet, scope: {cluster, programId, seasonId} | null,
 *    villages, hosts, candidates, explored, destinations, hostIds: [id], home, faction, stage}
 * A page that is not the play page gets the open survey. `ready` false: the
 * viewer's record has not answered yet (nothing is remembered or revealed).
 * The returned survey also carries `reveals` (Map hexKey → start, on the
 * clock given as `now()`), `ownHosts` (a Set of host ids as text), `home`
 * (`{p, q, tile}` | null), `faction`, `stage`, and `rev`, a number that
 * changes with every new survey.
 */
export function createSurveyor({ storage = browserStorage, now = () => 0 } = {}) {
  let last = null, lastSig = null, memKey = null, memory = new Set(), seen = false, rev = 0;
  let reveals = new Map();
  return function surveyor(input = {}) {
    const ringsOpen = Math.max(1, input.ringsOpen ?? 1);
    const play = (input.mode ?? 'play') === 'play';
    const body = play ? { ringsOpen, ready: !!input.ready, wallet: input.wallet ?? null, scope: input.scope ?? null, villages: input.villages ?? [], hosts: input.hosts ?? [],
      candidates: input.candidates ?? [], explored: input.explored ?? [], destinations: input.destinations ?? [], hostIds: input.hostIds ?? [], home: input.home ?? null,
      faction: input.faction ?? null, stage: input.stage ?? 'none' } : { ringsOpen, open: true };
    const sig = sigOf(body);
    if (sig === lastSig && last) return last;
    lastSig = sig;
    let survey;
    if (!play) survey = openSurvey(ringsOpen);
    else {
      const key = body.scope && body.wallet ? memoryKey(body.scope, body.wallet) : null;
      if (key !== memKey) { memKey = key; memory = key ? unpackMemory(storage.get(key)) : new Set(); seen = false; reveals = new Map(); }
      survey = buildSurvey({ ringsOpen, anchors: anchorsOf(body), memory });
      if (body.ready) {
        // what comes into sight after the first picture dissolves out of the chart (the first picture is what the records say)
        const t = now();
        if (seen && last && !last.showAll) for (const [k, t0] of revealPlan(last, survey, t)) reveals.set(k, t0);
        for (const [k, t0] of reveals) if (t - t0 > REVEAL_MS * 2) reveals.delete(k);
        seen = true;
        if (remember(memory, survey) > 0 && key) storage.set(key, packMemory(memory));
      }
    }
    survey.rev = ++rev;
    survey.reveals = reveals;
    survey.ownHosts = new Set((body.hostIds ?? []).map(String));
    survey.home = body.home ?? null;
    survey.faction = body.faction ?? null;
    survey.stage = body.stage ?? null;
    survey.candidates = (body.candidates ?? []).filter(c => int(c.tile));
    survey.villages = body.villages ?? [];
    last = survey;
    return survey;
  };
}
