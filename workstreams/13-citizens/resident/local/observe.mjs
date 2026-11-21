// What ⑬'s local resident reads (2026-11-22): the PUBLIC herald of its own world proxy, with the page's own herald
// client and codec (permutation-server/web/frontier/herald.mjs), and only what a person's page reads about itself:
//   /h/season          the Season (genesis → the turn; program version → training prices), once per world
//   /h/status          the chain's clock
//   /h/me/<own wallet> its own Citizen and Holdings (never another wallet's)
//   /h/province/P,Q    only before it has a village: the free home sites of its own nation (the page's homeSites)
// No other village, no world-wide list, no operator route, no event feed: under fog it knows what a person knows.
// KEY-FREE.
import { createHerald } from '../../../../permutation-server/web/frontier/herald.mjs';
import { RESOURCE_ORDER } from '../../../../permutation-server/web/frontier/resources.mjs';
import { storesAt } from '../../../../permutation-server/web/frontier/fland.mjs';
import { settled } from '../../../../permutation-server/web/frontier/hud/rulebook.mjs';
import { bellOf } from '../../../../permutation-gateway/src/frontier/local-play-operator-policy.mjs';
import { chainSecondsOf, publicHomes, getJson } from '../../../03-composability/mcp/examples/external-resident/public.mjs';

const ring = (p, q) => Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q));

/**
 * → `observe()` returning `{bell, nowSecs, genesisTs, programVersion, seasonId, joined, faction, holding, settled,
 * stores, homes, reads}` or `{unreadable: why}`. `deps` (tests): `{herald, getJson, publicHomes}`.
 */
export function createObserver({ base, wallet, deps = {} }) {
  const h = deps.herald ?? createHerald({ base, fetch: (...a) => globalThis.fetch(...a) });
  const get = deps.getJson ?? getJson;
  const homesOf = deps.publicHomes ?? publicHomes;
  let season = null;
  return async function observe() {
    const reads = [];
    if (!season) {
      reads.push('/h/season');
      const s = await h.season();
      if (!s.ok) return { unreadable: `season: ${s.code ?? s.error ?? 'no answer'}`, reads };
      const g = Number(s.season.genesisTs);
      if (!Number.isSafeInteger(g)) return { unreadable: 'season: no genesis', reads };
      season = { genesisTs: g, programVersion: Number(s.season.programVersion ?? 1), seasonId: String(s.season.seasonId) };
      h.pin?.(season.seasonId);
    }
    reads.push('/h/status');
    let nowSecs;
    try { nowSecs = chainSecondsOf(await get(`${base}/h/status`)); } catch (e) { return { unreadable: `status: ${e.message}`, reads }; }
    const bell = bellOf(season.genesisTs, nowSecs);
    if (bell === null) return { unreadable: 'no chain clock', reads };
    reads.push('/h/me/<own>');
    const me = await h.me(wallet);
    if (!me.ok) return { unreadable: `me: ${me.code ?? me.error ?? 'no answer'}`, reads };
    const base0 = { bell, nowSecs, ...season, reads };
    if (!me.citizen) return { ...base0, joined: false, faction: null, holding: null };
    const faction = Number(me.citizen.faction);
    // (a wide village, ring 129+, is another family of orders: not this resident's six)
    const raw = me.holdings.find(x => ring(Number(x.p), Number(x.q)) <= 128) ?? null;
    if (!raw) {
      reads.push('/h/province/* (own nation, home sites)');
      let homes = [];
      try { homes = await homesOf(base, faction); } catch { homes = []; }
      return { ...base0, joined: true, faction, holding: null, homes };
    }
    const tile = Number(raw.tile);
    const holding = { p: Number(raw.p), q: Number(raw.q), site: Number(raw.site), ...(Number.isInteger(tile) && tile >= 0 && tile <= 60 ? { tile } : {}) };
    let stores = null, st = null;
    try { st = settled(raw, nowSecs); stores = storesAt(raw, nowSecs, RESOURCE_ORDER).map(s => ({ resource: s.resource, value: s.value, perHour: s.perHour, cap: s.cap })); } catch { stores = null; }
    return { ...base0, joined: true, faction, holding, settled: st, stores };
  };
}
