// A first village's place drawn on the wide map (2026-11-18): PROVISIONAL, NOT PRODUCTION, NOT ENABLED.
//
// The owner's direction (approved 2026-11-18): joining puts the new village at a place drawn somewhere on the wide
// map of the existing world, nations mixed, no new beginner shield, the map growing by exploration. This file is the
// independent core of that draw, as a provisional implementation:
//
//   * reproducible: the same world draw key (the Season's genesis_seed) and the same citizen key give the same place,
//     whatever order the candidates were read in (each free place gets its own score; the lowest score wins);
//   * no nation is excluded: every free place of every nation in the drawn rings is a candidate;
//   * PREDICTABLE and NOT resistant to many accounts: anyone who knows the world's key can compute any wallet's place
//     before joining, and can make wallets until one lands where it wants. Stated, not solved.
//
// It is NOT the program's rule and never claims to be. The program's PlaceHome (proc/citizen.rs place_home_as) takes a
// place only in rings 2..=heartland_max_ring, below rings_opened, whose home nation (geometry::home_nation; placement 1
// is a nation per heartland Province, never a personal random place) is the Citizen's own nation, at a free or
// released site of a Province with no live ticket cohort. A place drawn here beyond the heartland or of another nation
// would be refused there; `chainView` says so for each draw and never says "accepted".
//
// Kept apart from the existing protections: the capture shield of a new village (`shield_until`, lifecycle
// shield_secs_for) and every other existing rule are untouched; this file adds no beginner shield and removes none.
//
// Inputs are what the page already reads (herald overviews and Province envelopes); nothing is fetched here, no
// clock is read, nothing is stored, signed or sent. Pure functions.
import { sha256 } from '../sdk/sha256.mjs';
import { utf8 } from '../sdk/bytes.mjs';
import { ringOf, ringSize, provinceIndex, homeNation } from './fgeo.mjs';
import { COHORT_BELLS } from './fland.mjs';

export const DRAW_KIND = 'wylls-home-draw/0-provisional';
/** The draw's hash domain; a provisional one (v0), never a program domain. */
export const DRAW_DOMAIN = 'WYLLS-HOME-DRAW-PROVISIONAL-v0';

/**
 * The provisional parameters: explicit, named, NOT production values and not rules of the game. A caller may pass
 * others (`params`); every answer carries the ones it used.
 *   fromRing          the innermost ring drawn: 2, as the existing first-home rings (ring 0 is the Concord, ring 1 the Seats)
 *   nearRings         rings beyond the open map shown as "near": the map may open or extend there later. Shown only;
 *                     never drawn (no land exists there yet)
 *   maxOccupiedBps    density: a Province whose sites are taken at or above this share (basis points) is not drawn into
 *   maxConfirmReads   Province reads used to confirm the drawn place (a place found taken since the overview → the next)
 */
export const PROVISIONAL_PARAMS = Object.freeze({ fromRing: 2, nearRings: 1, maxOccupiedBps: 7500, maxConfirmReads: 8 });
export const PROVISIONAL = Object.freeze({ production: false, enabled: false, kind: DRAW_KIND,
  limits: Object.freeze([
    'provisional: not a rule of the game, not production, not enabled',
    'predictable: the world key and the citizen key give the place before joining',
    'not resistant to many accounts: wallets can be made until one lands where wanted',
    'not the program: PlaceHome checks rings 2..heartland, the nation and the site itself',
  ]) });

/** The answers. */
export const DRAW = Object.freeze({ assigned: 'assigned', full: 'full', unread: 'unread', otherWorld: 'otherWorld', contested: 'contested', held: 'held' });

const int = Number.isInteger;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return b; };
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
function cmpBytes(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

/** The world a draw is for: cluster, program, Season and the page's generation of it. Every field is required. */
export function worldKeyOf(w) {
  if (!isObj(w)) return null;
  const { cluster, programId, seasonId, gen } = w;
  if (typeof cluster !== 'string' || !cluster || typeof programId !== 'string' || !programId || seasonId === undefined || seasonId === null || String(seasonId) === '' || !int(gen) || gen < 0) return null;
  return Object.freeze({ cluster, programId, seasonId: String(seasonId), gen });
}
/** Whether two world keys are the same world. Unknown never equals unknown. */
export const sameWorld = (a, b) => !!a && !!b && a.cluster === b.cluster && a.programId === b.programId && a.seasonId === b.seasonId && a.gen === b.gen;

function params(p) {
  const out = { ...PROVISIONAL_PARAMS, ...(isObj(p) ? p : {}) };
  if (!int(out.fromRing) || out.fromRing < 2) return null;
  if (!int(out.nearRings) || out.nearRings < 0) return null;
  if (!int(out.maxOccupiedBps) || out.maxOccupiedBps < 1 || out.maxOccupiedBps > 10000) return null;
  if (!int(out.maxConfirmReads) || out.maxConfirmReads < 1 || out.maxConfirmReads > 64) return null;
  return Object.freeze(out);
}

/**
 * The score of one place: sha256(domain ‖ world key (32 bytes) ‖ citizen key (utf-8) ‖ 0x00 ‖ le32 P ‖ le32 Q ‖ site).
 * The 0x00 ends the citizen key, so no two (citizen, place) pairs share their bytes.
 */
export function placeScore(drawKey, citizen, p, q, site) {
  return sha256(utf8(DRAW_DOMAIN), drawKey, utf8(citizen), Uint8Array.of(0), le32(p), le32(q), Uint8Array.of(site));
}

/**
 * The rings drawn and the rings shown as near. `world` = map/world.mjs worldOf (ringsOpen, rMax, rMaxCeiling…) and
 * `contiguous` = contiguousRings(world): the rings seeded without a gap from the centre (a sparse world's far ring
 * alone is not "the existing world" of a first village).
 */
export function drawRings(world, contiguous, prm = PROVISIONAL_PARAMS) {
  const p = params(prm);
  if (!p || !isObj(world) || !int(contiguous) || contiguous < 0) return null;
  const drawn = [];
  for (let d = p.fromRing; d < contiguous; d++) drawn.push(d);
  const near = [];
  const top = int(world.rMaxCeiling) ? world.rMaxCeiling : int(world.rMax) ? world.rMax : null;
  for (let d = Math.max(contiguous, p.fromRing); d < contiguous + p.nearRings; d++) if (top === null || d <= top) near.push(d);
  return Object.freeze({ drawn: Object.freeze(drawn), near: Object.freeze(near) });
}

// An overview Province's free sites, by the rule the existing planner uses (fland candidateProvinces): state 0 or 3
// with no owner (7). Anything else, or a malformed record, is not free; a malformed record is reported, not skipped.
// The overview always carries 12 slots, also beyond a Province's siteCount: such a slot is found absent by the
// Province read that confirms a draw (siteNow), and the density here is of the 12 slots (an approximation, stated).
// A Province the overview marks not opened is not land yet: none of its slots is a candidate.
function overviewFree(pr) {
  if (!isObj(pr) || !int(pr.p) || !int(pr.q) || !Array.isArray(pr.sites) || !Array.isArray(pr.owners) || pr.sites.length !== pr.owners.length || pr.sites.length > 12) return null;
  if (pr.opened === false) return { free: [], taken: 0, count: 0 };
  const free = [];
  let taken = 0;
  for (let i = 0; i < pr.sites.length; i++) {
    if ((pr.sites[i] === 0 || pr.sites[i] === 3) && pr.owners[i] === 7) free.push(i);
    else taken++;
  }
  return { free, taken, count: pr.sites.length };
}

/**
 * Candidates from the ring overviews. `overviews`: Map ring → the herald's decoded overview ({ring, bell, seasonId?,
 * provinces}) or an error/null. Every drawn ring must be read and of this Season: one unread ring makes the whole
 * draw unread (a place it holds could have the lowest score), never "no place there".
 * → {ok: true, candidates: [{p, q, site, score}], basis} | {ok: false, kind, why, rings}
 */
export function candidatesFrom({ drawKey, citizen, seasonId, rings, overviews, params: prm }) {
  const p = params(prm);
  const unread = [], other = [], malformed = [], candidates = [], basis = [];
  for (const d of rings) {
    const ov = overviews?.get?.(d);
    if (!isObj(ov) || !Array.isArray(ov.provinces)) { unread.push(d); continue; }
    // (herald.mjs decodeOverview: the Season is `season`, a BigInt; a decoder that names none is not taken as this one)
    const ovSeason = ov.season ?? ov.seasonId;
    if (ovSeason === undefined || ovSeason === null || String(ovSeason) !== String(seasonId)) { other.push(d); continue; }
    if (ov.ring !== undefined && ov.ring !== d) { other.push(d); continue; }
    // a ring only partly on chain: its missing Provinces are not land yet (pending), never free
    if (ov.provinces.length > ringSize(d)) { malformed.push(d); continue; }
    basis.push({ ring: d, bell: int(ov.bell) ? ov.bell : null, provinces: ov.provinces.length });
    for (const pr of ov.provinces) {
      const f = overviewFree(pr);
      if (!f || ringOf(pr.p, pr.q) !== d) { malformed.push(d); continue; }
      if (!f.count || f.taken * 10000 >= p.maxOccupiedBps * f.count) continue;
      for (const site of f.free) candidates.push({ p: pr.p, q: pr.q, site, score: placeScore(drawKey, citizen, pr.p, pr.q, site) });
    }
  }
  if (other.length) return { ok: false, kind: DRAW.otherWorld, why: 'an overview of another Season or ring, or of none named', rings: other };
  if (unread.length || malformed.length) return { ok: false, kind: DRAW.unread, why: unread.length ? 'a drawn ring is not read' : 'a drawn ring is malformed', rings: [...new Set([...unread, ...malformed])].sort((a, b) => a - b) };
  // the order: by score alone (ties, never expected, by place), so the order the rings or Provinces came in never matters
  candidates.sort((a, b) => cmpBytes(a.score, b.score) || provinceIndex(a.p, a.q) - provinceIndex(b.p, b.q) || a.site - b.site);
  return { ok: true, candidates, basis };
}

/**
 * Whether one site of a decoded Province (the herald's /h/province envelope `.province`) is free now by the program's
 * own home_site rule as the page already reads it (home.mjs homeSites): within siteCount, state free (0) or released
 * (3), and no ticket cohort filed beyond its settled count within COHORT_BELLS of its bell.
 * → 'free' | 'taken' | 'cohort' | 'absent' (no such site in this Province) | 'unknown'
 */
export function siteNow(province, site, nowBell) {
  if (!isObj(province) || !int(province.siteCount) || !Array.isArray(province.siteMirror)) return 'unknown';
  if (!int(site) || site < 0 || site >= province.siteCount || site >= 12) return 'absent';
  const m = province.siteMirror[site];
  if (!isObj(m) || !int(m.state)) return 'unknown';
  if (m.state !== 0 && m.state !== 3) return 'taken';
  const cohorts = province.ticketCohorts;
  if (!Array.isArray(cohorts)) return 'unknown';
  // (home.mjs homeSites: a cohort filed beyond its settled count within COHORT_BELLS reserves the Province; the program
  //  holds it while any cohort is not free. A cohort whose shape is not known is not taken as free.)
  for (const c of cohorts) {
    if (!isObj(c) || !int(c.filed) || !int(c.settled) || !int(c.bell)) return 'unknown';
    if (c.filed <= c.settled) continue;
    // an open cohort: whether it still holds the Province depends on the herald's turn; without it, not known
    if (!int(nowBell)) return 'unknown';
    if (nowBell < c.bell + COHORT_BELLS) return 'cohort';
  }
  return 'free';
}

/**
 * The chain's view of a drawn place, as far as the existing rules can be read: never "accepted".
 * `place` = home.mjs seasonPlace(season) ({placement, heartlandMaxRing, genesisSeed}) or undefined for placement 0;
 * `heartlandMaxRing` the Season's (conquestParams); `faction` the Citizen's nation when joined, else null.
 */
export function chainView({ p, q }, { place, heartlandMaxRing, faction = null } = {}) {
  const ring = ringOf(p, q), reasons = [];
  const hmr = int(heartlandMaxRing) ? heartlandMaxRing : null;
  const nation = homeNation(p, q, place ?? {});
  if (hmr === null) reasons.push('the heartland limit is not read');
  else if (ring > hmr) reasons.push(`ring ${ring} is beyond the heartland (ring ${hmr}): PlaceHome refuses it`);
  if (nation === null) reasons.push('the nation of this place is not known');
  else if (faction === null) reasons.push(`PlaceHome takes this place only for nation ${nation}`);
  else if (nation !== faction) reasons.push(`the place is of nation ${nation}, the citizen's is ${faction}: PlaceHome refuses it`);
  const refused = reasons.some(r => r.includes('refuses'));
  return Object.freeze({ placeHome: refused ? 'refused-by-rule' : 'not-checked', nation, ring, reasons: Object.freeze(reasons) });
}

/**
 * The draw. Reads only through `readProvince(p, q)` (→ the herald envelope {province} or an error/null), at most
 * `params.maxConfirmReads` times, one after another. Nothing is written or sent.
 *
 *   world      {cluster, programId, seasonId, gen}: the world this draw is for (worldKeyOf)
 *   season     the decoded Season (genesisSeed 32 bytes, conquestParams.heartlandMaxRing), of this world
 *   extent     map/world.mjs worldOf(record), with `contiguous` = contiguousRings(extent)
 *   citizen    the citizen key (the wallet's address, as its owner gives it): a non-empty string
 *   overviews  Map ring → decoded overview
 *   nowBell    the herald's bell for the cohort rule (never the local clock); null → a found site is 'unknown'
 *
 * → a frozen answer {kind: DRAW.*, kindOf: DRAW_KIND, world, citizen, params, rings, …}
 */
export async function drawHome({ world, season, extent, contiguous, citizen, overviews, readProvince, nowBell = null, faction = null, place, params: prm } = {}) {
  const w = worldKeyOf(world), p = params(prm);
  const base = { kindOf: DRAW_KIND, provisional: PROVISIONAL, world: w, citizen: typeof citizen === 'string' ? citizen : null, params: p };
  const done = o => Object.freeze({ ...base, ...o });
  if (!w) return done({ kind: DRAW.held, why: 'no world (cluster, program, Season and its generation)' });
  if (!p) return done({ kind: DRAW.held, why: 'the provisional parameters are not valid' });
  if (typeof citizen !== 'string' || !citizen || citizen.length > 64) return done({ kind: DRAW.held, why: 'no citizen key' });
  const key = season?.genesisSeed;
  if (!(key instanceof Uint8Array) || key.length !== 32) return done({ kind: DRAW.held, why: "the world's draw key (genesis) is not read" });
  if (season.seasonId !== undefined && String(season.seasonId) !== w.seasonId) return done({ kind: DRAW.otherWorld, why: 'the Season read is another one' });
  if (typeof readProvince !== 'function') return done({ kind: DRAW.held, why: 'no Province reader' });
  const rings = drawRings(extent, contiguous, p);
  if (!rings) return done({ kind: DRAW.held, why: 'the map extent is not read' });
  const withRings = o => done({ rings, ...o });
  if (!rings.drawn.length) return withRings({ kind: DRAW.full, why: 'no ring of the open map is drawn (the map has no ring from ' + p.fromRing + ' yet)' });
  const c = candidatesFrom({ drawKey: key, citizen, seasonId: w.seasonId, rings: rings.drawn, overviews, params: p });
  if (!c.ok) return withRings({ kind: c.kind, why: c.why, unreadRings: c.rings });
  if (!c.candidates.length) return withRings({ kind: DRAW.full, why: 'every drawn ring is read and has no free place under the density limit', basis: c.basis });
  const hmr = Number(season?.conquestParams?.heartlandMaxRing ?? season?.heartlandMaxRing);
  const checked = [];
  for (const cand of c.candidates.slice(0, p.maxConfirmReads)) {
    let r;
    try { r = await readProvince(cand.p, cand.q); } catch { r = null; }
    const pv = r?.province;
    if (!isObj(pv)) return withRings({ kind: DRAW.unread, why: 'the drawn Province is not read now', at: { p: cand.p, q: cand.q, site: cand.site }, checked, basis: c.basis });
    if (pv.seasonId !== undefined && String(pv.seasonId) !== w.seasonId) return withRings({ kind: DRAW.otherWorld, why: 'the Province read is of another Season', checked, basis: c.basis });
    if (pv.p !== cand.p || pv.q !== cand.q) return withRings({ kind: DRAW.unread, why: 'the Province read is another place', checked, basis: c.basis });
    const now = siteNow(pv, cand.site, nowBell);
    checked.push(Object.freeze({ p: cand.p, q: cand.q, site: cand.site, now }));
    if (now === 'unknown') return withRings({ kind: DRAW.unread, why: 'the drawn site cannot be read as free or taken', at: { p: cand.p, q: cand.q, site: cand.site }, checked, basis: c.basis });
    if (now !== 'free') continue; // taken, held by a cohort, or no such site: the next place by score
    const tile = Array.isArray(pv.sites) && int(pv.sites[cand.site]) ? pv.sites[cand.site] : null;
    const gen = int(pv.siteMirror[cand.site]?.gen) ? pv.siteMirror[cand.site].gen : null;
    return withRings({ kind: DRAW.assigned, place: Object.freeze({ p: cand.p, q: cand.q, site: cand.site, tile, gen, ring: ringOf(cand.p, cand.q) }),
      score: hex(cand.score), bell: r?.bell ?? null, checked, basis: c.basis,
      chain: chainView(cand, { place, heartlandMaxRing: int(hmr) ? hmr : null, faction }) });
  }
  // every place confirmed was taken since the overviews (or held by a cohort): the map moved under the draw. Only
  // slots that do not exist: the confirm reads ran out, nothing is said of the places after them
  if (checked.some(x => x.now === 'taken' || x.now === 'cohort')) return withRings({ kind: DRAW.contested, why: 'the places drawn first are taken since the overviews were read', checked, basis: c.basis });
  return withRings({ kind: DRAW.unread, why: 'the confirm reads ran out before a place was confirmed', checked, basis: c.basis });
}

/**
 * A drawn place read again (the same Province, later): still free, taken since, or unknown. Another world, place or
 * citizen is not compared. → {now: 'free'|'takenSince'|'unknown'|'otherDraw'}
 */
export function recheck(drawn, { world, citizen, envelope, nowBell = null } = {}) {
  if (!drawn || drawn.kind !== DRAW.assigned || !sameWorld(drawn.world, worldKeyOf(world)) || drawn.citizen !== citizen) return { now: 'otherDraw' };
  const pv = envelope?.province;
  if (!isObj(pv) || pv.p !== drawn.place.p || pv.q !== drawn.place.q) return { now: 'unknown' };
  if (pv.seasonId !== undefined && String(pv.seasonId) !== drawn.world.seasonId) return { now: 'otherDraw' };
  const s = siteNow(pv, drawn.place.site, nowBell);
  return { now: s === 'free' ? 'free' : s === 'unknown' ? 'unknown' : 'takenSince' };
}
