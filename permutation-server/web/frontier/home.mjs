// First-home planning. Only decoded open Provinces supply candidates; the
// program rechecks occupancy and ownership when PlaceHome lands.
import { candidateProvinces, freeSitesOf, COHORT_BELLS } from './fland.mjs';
import { ringOf, wedgeOf } from './fgeo.mjs';
import { hash32 } from './fjoin.mjs';

export const HOME_GRANTED = 32;
export const INTRO_BUILD_AVAILABLE = 2;
export const instantHomeEnabled = season => ((Number(season?.layoutVersion ?? 1) === 1 && Number(season?.programVersion) === 2) || (Number(season?.layoutVersion) === 2 && Number(season?.programVersion) >= 3));
export const sameHome = (a, b) => !!a && !!b && a.p === b.p && a.q === b.q && a.site === b.site;
export const homeKey = (scope, wallet = 'visitor') => `wylls-home:v1:${scope.cluster}:${scope.programId}:${scope.seasonId}:${wallet}`;
const validSite = s => !!s && Number.isInteger(s.p) && Number.isInteger(s.q) && Number.isInteger(s.site) && s.site >= 0 && s.site < 12 && ringOf(s.p, s.q) >= 2;

export function loadHome(storage, key) {
  let v;
  try { v = JSON.parse(storage.get(key) ?? 'null'); } catch { /* unavailable storage */ }
  if (!v || v.v !== 1) return { v: 1, selected: null, pending: null, seen: null };
  return { v: 1, selected: validSite(v.selected) ? v.selected : null,
    pending: v.pending && ['Join', 'PlaceHome'].includes(v.pending.kind) && typeof v.pending.signature === 'string' ? v.pending : null,
    seen: typeof v.seen === 'string' ? v.seen : null };
}
export function saveHome(storage, key, patch) {
  const v = { ...loadHome(storage, key), ...patch, v: 1 };
  storage.set(key, JSON.stringify(v));
  return loadHome(storage, key);
}
export const grantId = h => `${h.p},${h.q},${h.site},${h.gen}`;

/** Unsettled legacy tickets retain their claim on a whole Province. */
export function homeSites(province, { faction = null, nowBell = 0, ringsOpen = Infinity } = {}) {
  if (!province || ringOf(province.p, province.q) < 2 || ringOf(province.p, province.q) >= ringsOpen) return [];
  const f = wedgeOf(province.p, province.q);
  if (f === null || (faction !== null && f !== faction)) return [];
  if ((province.ticketCohorts ?? []).some(c => c.filed > c.settled && nowBell < c.bell + COHORT_BELLS)) return [];
  return freeSitesOf(province).map(s => ({ ...s, faction: f, gen: province.siteMirror[s.site].gen ?? 0 }));
}

/** At most 24 reads, different nations before joining, different places after. */
export async function planHomes({ overviews, read, faction = null, nowBell = 0, ringsOpen = Infinity, seed = '', rotation = 0, max = 3 }) {
  const factions = faction === null ? Array.from({ length: 6 }, (_, i) => (i + rotation) % 6) : [faction];
  const lists = factions.map(f => candidateProvinces(overviews, f).sort((a, b) => a.ring - b.ring || hash32(`${seed}|${a.p},${a.q}`) - hash32(`${seed}|${b.p},${b.q}`)));
  const candidates = [];
  let reads = 0, failures = 0;
  for (let round = 0; reads < 24 && lists.some(l => l[round]); round++) {
    const batch = lists.map(l => l[round]).filter(Boolean).slice(0, 24 - reads);
    const results = await Promise.allSettled(batch.map(p => read(p.p, p.q)));
    reads += batch.length;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== 'fulfilled' || !r.value) { failures++; continue; }
      const sites = homeSites(r.value, { faction, nowBell, ringsOpen }).sort((a, b) => hash32(`${seed}|${a.p},${a.q},${a.site}`) - hash32(`${seed}|${b.p},${b.q},${b.site}`));
      if (sites.length) candidates.push(sites[0]);
      if (candidates.length >= max) return { candidates, error: null, reads };
    }
  }
  return { candidates, error: candidates.length ? null : failures ? 'Unavailable' : 'NoFreeHome', reads };
}
