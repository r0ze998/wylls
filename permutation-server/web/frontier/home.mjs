// First-home planning. Only decoded open Provinces supply candidates; the
// program rechecks occupancy and ownership when PlaceHome lands.
import { candidateProvinces, freeSitesOf, COHORT_BELLS } from './fland.mjs';
import { ringOf, homeNation } from './fgeo.mjs';
import { hash32 } from './fjoin.mjs';

export const HOME_GRANTED = 32;
export const INTRO_BUILD_AVAILABLE = 2;
export const instantHomeEnabled = season => ((Number(season?.layoutVersion ?? 1) === 1 && Number(season?.programVersion) === 2) || (Number(season?.layoutVersion) === 2 && Number(season?.programVersion) >= 3));
/**
 * (2026-11-18, ⑧ doc 31 §1 option A — a change of the page only; no program, ABI or rule change.)
 * `noFreeHome(choice, faction)`: the candidates reading for THAT nation ended with no place a first village can be put
 * at once (`planHomes` → `NoFreeHome`: every heartland site of the nation is held, or held back by an unsettled
 * request). A reading that failed (`Unavailable`), one still under way, or one for another nation is not this.
 * `heartlandFull(FS)`: that, for a viewer who has joined and has no village, in an instant-home Season. PlaceHome
 * places only in rings 2 .. heartland_max_ring (ReservedSite beyond), so from there the program's village request
 * (FileTicket / SettleTicket — unchanged, and dispatched in these Seasons) is the only way to a first village. While
 * this holds the page files requests (controller autoTicket) and shows the request's wait view instead of the
 * planner's "no land found yet". Not in local play: its relay step serves no FileTicket (flocalplay-act.mjs
 * LOCAL_ACT_NAMES), so nothing could be filed there and the planner's own sentence stays.
 */
export const noFreeHome = (choice, faction) => Number.isInteger(faction) && choice?.error?.code === 'NoFreeHome' && choice.faction === faction;
export const heartlandFull = FS => instantHomeEnabled(FS?.season) && !FS?.localPlay && !!FS?.citizen && !FS?.holdings?.length && noFreeHome(FS.homeChoice, FS.citizen.faction);
export const sameHome = (a, b) => !!a && !!b && a.p === b.p && a.q === b.q && a.site === b.site;
export const homeKey = (scope, wallet = 'visitor') => `wylls-home:v1:${scope.cluster}:${scope.programId}:${scope.seasonId}:${wallet}`;
const validSite = s => !!s && Number.isInteger(s.p) && Number.isInteger(s.q) && Number.isInteger(s.site) && s.site >= 0 && s.site < 12 && ringOf(s.p, s.q) >= 2;

export function loadHome(storage, key) {
  let v;
  try { v = JSON.parse(storage.get(key) ?? 'null'); } catch { /* unavailable storage */ }
  if (!v || v.v !== 1) return { v: 1, selected: null, pending: null, seen: null };
  return { v: 1, selected: validSite(v.selected) ? v.selected : null,
    pending: v.pending && ['Join', 'PlaceHome', 'FileTicket'].includes(v.pending.kind) && typeof v.pending.signature === 'string' ? v.pending : null,
    seen: typeof v.seen === 'string' ? v.seen : null };
}
export function saveHome(storage, key, patch) {
  const v = { ...loadHome(storage, key), ...patch, v: 1 };
  storage.set(key, JSON.stringify(v));
  return loadHome(storage, key);
}
/**
 * The season's FIRST-HOME placement for `homeNation`, or undefined for explicit legacy placement. Missing dispersed
 * evidence never falls back. Placement 2 (⑧ wide land (i): the keeps of every ring start mixed) places first villages
 * exactly as placement 1 does (program: PlaceHome only in the heartland, where 2 is 1; tickets past the heartland keep
 * the wedge rule, `ticket_nation_allowed`), so it is the dispersed rule here; the mixed outer keeps are read from the
 * chain's Keep, never computed from this.
 */
export function seasonPlace(season) {
  const cq = season?.conquestParams ?? season ?? {};
  const placement = Number(cq.placement ?? 0), seed = season?.genesisSeed ?? cq.genesisSeed;
  if (placement === 0) return undefined;
  return { placement: placement === 2 ? 1 : placement, heartlandMaxRing: Number(cq.heartlandMaxRing ?? 3), genesisSeed: seed };
}
export const grantId = h => `${h.p},${h.q},${h.site},${h.gen}`;

/**
 * (TEST-ONLY wide play, LOCAL play only: owner t379u 「広い版がんばれ」) In a local wide-land world (the launcher's
 * `--wide-land`, stated to this page as `FS.localPlay.wideLand`) a first village may also be placed in a SETTLED
 * province outside the heartland (⑭ R3, the program's PlaceHome: `target_used > 0`, `spawn_reach` > 0) — the world's
 * runner settles rim provinces beside the wide land for every nation — and those are offered FIRST (outward), so that
 * a newcomer starts where the wide land can be claimed. The nation of a province there is the mixed placement's (2:
 * ⑧ (c), every ring ≥ 2). Every other world, and every non-local page, is exactly as before.
 */
export const wideLocal = FS => !!FS?.localPlay?.wideLand;
/**
 * (DEVNET PLAY, devnet gap P1: devnet-rim-homes design row "Page's devnet path" (2)) A wide devnet season the page plays
 * itself (controller `FS.devnetWide`: devnet play verified, `rMaxCeiling` 128, opened past ring 128): a first village may
 * also be REQUESTED on an opened rim province of the player's mixed nation (FileTicket: `ticket_nation_allowed_in`,
 * ring < rings_opened), offered outward first. Not the local "settled province" filter: that is PlaceHome's R3 rule,
 * and keeper A's rim duty opens rim provinces unsettled. Never in local play.
 */
export const wideDevnet = FS => !FS?.localPlay && FS?.devnetWide === true;
export function homePlaceOf(FS) {
  const base = seasonPlace(FS?.season);
  if (!base) return base;
  if (wideDevnet(FS)) return { ...base, placement: 2, outward: true, anyOpen: true };
  if (!wideLocal(FS)) return base;
  return { ...base, placement: 2, outward: true };
}
/** The rim's ring and one past it: a wide devnet season offers first villages up to the rim, never in the wide land. */
const PAST_RIM = 129;
/** The rings a first village may be placed in: `homeRingsOpen`, or every open ring in a local wide-land world (R3 above), or up to the rim on a wide devnet season. */
export const homeRingsOf = (FS, ringsOpen) => (wideDevnet(FS) ? PAST_RIM : wideLocal(FS) ? (Number.isInteger(ringsOpen) ? ringsOpen : Infinity) : homeRingsOpen(FS?.season, ringsOpen));
const settledSites = sites => (sites ?? []).some(s => s === 1);
/** Outward candidates (`place.outward`): the nation's provinces with a free site, heartland or settled, farthest ring first. */
function outwardCandidates(overviews, faction, place) {
  const out = [];
  for (const ov of overviews.values()) {
    if (!ov?.provinces || ov.ring < 2) continue;
    for (const pr of ov.provinces) {
      if (homeNation(pr.p, pr.q, place) !== faction) continue;
      const ring = ringOf(pr.p, pr.q);
      if (ring > Number(place.heartlandMaxRing) && !place.anyOpen && !settledSites(pr.sites)) continue;
      const free = pr.sites.filter((s, i) => (s === 0 || s === 3) && pr.owners[i] === 7).length;
      if (free > 0) out.push({ p: pr.p, q: pr.q, ring, free });
    }
  }
  return out.sort((a, b) => b.ring - a.ring || a.p - b.p || a.q - b.q);
}

/**
 * The rings a first village may be placed in, as a count like `ringsOpen` (rings 0 .. n−1): the season's open
 * rings, and on a v2 Season (a conquest block with `heartlandMaxRing`) no further than the heartland, since PlaceHome
 * refuses a ring above `heartland_max_ring` (ReservedSite) whether or not it is open. A map that has grown past the
 * heartland (OpenRing, ExtendFrontier) opens land for marches and outposts, not for first homes: every reader of the
 * home candidates (the planner, the tap on a tile, the nation choice's count, the wait view's site marks) takes this
 * count, so none offers a site the program would refuse. A season without the block (M1 tickets) keeps its open rings.
 */
export function homeRingsOpen(season, ringsOpen) {
  const open = Number.isInteger(ringsOpen) ? Math.max(0, ringsOpen) : 0;
  const hmr = Number(season?.conquestParams?.heartlandMaxRing ?? season?.heartlandMaxRing);
  return Number.isInteger(hmr) && hmr >= 0 ? Math.min(open, hmr + 1) : open;
}

/** Unsettled legacy tickets retain their claim on a whole Province. */
/** `place` = {placement, heartlandMaxRing, genesisSeed} (fgeo `homeNation`); absent: the wedge rule. */
export function homeSites(province, { faction = null, nowBell = 0, ringsOpen = Infinity, place = undefined } = {}) {
  if (!province || ringOf(province.p, province.q) < 2 || ringOf(province.p, province.q) >= ringsOpen) return [];
  // (outward, local wide play: past the heartland only a settled province takes a first village — ⑭ R3)
  if (place?.outward && !place.anyOpen && ringOf(province.p, province.q) > Number(place.heartlandMaxRing) && !(province.siteMirror ?? []).some(m => m?.state === 1)) return [];
  const f = homeNation(province.p, province.q, place);
  if (f === null || (faction !== null && f !== faction)) return [];
  if ((province.ticketCohorts ?? []).some(c => c.filed > c.settled && nowBell < c.bell + COHORT_BELLS)) return [];
  return freeSitesOf(province).map(s => ({ ...s, faction: f, gen: province.siteMirror[s.site].gen ?? 0 }));
}

/** At most 24 reads, different nations before joining, different places after. */
/**
 * `pair` (verify-pr130, LP6-12): 'first' | 'second' for the TEST-ONLY contest pair of a local world, else null. The pair
 * shares one `seed` (controller homeSeed), so both read the same order of provinces AND of sites: both chose the very
 * same site, and the second PlaceHome was refused TicketState (live: one of the two never had a village). A pair takes
 * only provinces with a free site for each of the two, the first role its first site and the second role the next one.
 */
export async function planHomes({ overviews, read, faction = null, nowBell = 0, ringsOpen = Infinity, seed = '', rotation = 0, max = 3, place = undefined, pair = null }) {
  if (place && ((Number(place.placement) !== 1 && !(place.outward && Number(place.placement) === 2)) || !place.genesisSeed || place.genesisSeed.length !== 32)) return { candidates: [], error: 'Unavailable', reads: 0 };
  const factions = faction === null ? Array.from({ length: 6 }, (_, i) => (i + rotation) % 6) : [faction];
  const lists = factions.map(f => (place?.outward ? outwardCandidates(overviews, f, place) : candidateProvinces(overviews, f, place).sort((a, b) => a.ring - b.ring || hash32(`${seed}|${a.p},${a.q}`) - hash32(`${seed}|${b.p},${b.q}`))));
  const candidates = [];
  let reads = 0, failures = 0;
  for (let round = 0; reads < 24 && lists.some(l => l[round]); round++) {
    const batch = lists.map(l => l[round]).filter(Boolean).slice(0, 24 - reads);
    const results = await Promise.allSettled(batch.map(p => read(p.p, p.q)));
    reads += batch.length;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== 'fulfilled' || !r.value) { failures++; continue; }
      const sites = homeSites(r.value, { faction, nowBell, ringsOpen, place }).sort((a, b) => hash32(`${seed}|${a.p},${a.q},${a.site}`) - hash32(`${seed}|${b.p},${b.q},${b.site}`));
      if (pair === 'first' || pair === 'second') { if (sites.length >= 2) candidates.push(sites[pair === 'second' ? 1 : 0]); }
      else if (sites.length) candidates.push(sites[0]);
      if (candidates.length >= max) return { candidates, error: null, reads };
    }
  }
  return { candidates, error: candidates.length ? null : failures ? 'Unavailable' : 'NoFreeHome', reads };
}
