// What ⑬'s local resident reads (2026-11-22): the PUBLIC herald of its own world proxy, with the page's own herald
// client and codec (permutation-server/web/frontier/herald.mjs), and only what a person's page reads about itself:
//   /h/season          the Season (genesis → the turn; program version → training prices), once per world
//   /h/status          the chain's clock
//   /h/me/<own wallet> its own Citizen and Holdings (never another wallet's)
//   /h/province/P,Q    before it has a village: the free home sites of its own nation (the page's homeSites);
//   /h/overview/*      (external-wide: in a local wide-land world only, before it has a village) the public ring
//                      overviews the page reads there for its outward first-village candidates (public.mjs
//                      publicWideHomes = home.mjs planHomes), read once per turn;
//                      with a village: its OWN province only (how far the world has resolved it: a Muster needs
//                      resolvedNext + 1 >= the turn, frontier-abi prologue.rs resident_ok)
// No other village, no world-wide list, no operator route, no event feed: under fog it knows what a person knows.
// S1 (LP9-4): the Season turns the page's S1 rules on (fs1.mjs setS1, as app.mjs loadSeason does), and the village's
// own Holding says its terrain ore (TERRAIN_ORE, `holding.oreExtra`): the rulebook counts mines above it, as the program.
// KEY-FREE.
import { createHerald } from '../../../../permutation-server/web/frontier/herald.mjs';
import { RESOURCE_ORDER } from '../../../../permutation-server/web/frontier/resources.mjs';
import { storesAt, landState } from '../../../../permutation-server/web/frontier/fland.mjs';
import { settled } from '../../../../permutation-server/web/frontier/hud/rulebook.mjs';
import { setS1, s1On } from '../../../../permutation-server/web/frontier/fs1.mjs';
import { knowVillageOre, terrainOreExtra } from './brain.mjs';
import { bellOf } from '../../../../permutation-gateway/src/frontier/local-play-operator-policy.mjs';
import { chainSecondsOf, publicHomes, publicWideHomes, getJson } from '../../../03-composability/mcp/examples/external-resident/public.mjs';
import { wideInventory } from './wide.mjs';

const ring = (p, q) => Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q));

/**
 * → `observe()` returning `{bell, nowSecs, genesisTs, programVersion, layoutVersion, s1, seasonId, joined, faction,
 * holding: {p, q, site, tile?, oreExtra? (S1)}, settled, stores, homes, reads, wide}` or `{unreadable: why}`. `deps`
 * (tests): `{herald, getJson, publicHomes, publicWideHomes}`.
 * `wide` (external-wide): the launcher said this world is a local wide-land world (its start answer's `wideLand`, as
 * the page is told): the first-village candidates are the page's outward ones there, each `{p, q, site, ticket}`.
 */
// `identity` (external-wide-orders, a wide world): `{programId, seasonAddress}` of its relay — with it a village's
// observation carries `wideInv` (wide.mjs wideInventory: its own wide villages from its own /h/me, the page's parser).
export function createObserver({ base, wallet, wide = false, identity = null, deps = {} }) {
  const h = deps.herald ?? createHerald({ base, fetch: (...a) => globalThis.fetch(...a) });
  const get = deps.getJson ?? getJson;
  const homesOf = deps.publicHomes ?? publicHomes;
  const wideHomesOf = deps.publicWideHomes ?? publicWideHomes;
  let season = null, wideRead = null;   // (wideRead: {bell, homes} — the outward candidates, read once per turn)
  return async function observe() {
    const reads = [];
    if (!season) {
      reads.push('/h/season');
      const s = await h.season();
      if (!s.ok) return { unreadable: `season: ${s.code ?? s.error ?? 'no answer'}`, reads };
      const g = Number(s.season.genesisTs);
      if (!Number.isSafeInteger(g)) return { unreadable: 'season: no genesis', reads };
      setS1(s.season);
      season = { genesisTs: g, programVersion: Number(s.season.programVersion ?? 1), layoutVersion: Number(s.season.layoutVersion ?? 1), seasonId: String(s.season.seasonId), s1: s1On() };
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
    const base0 = { bell, nowSecs, ...season, reads, ...(wide ? { wide: true } : {}) };
    if (!me.citizen) return { ...base0, joined: false, faction: null, holding: null };
    const faction = Number(me.citizen.faction);
    // (a wide village, ring 129+, is another family of orders: not this resident's six)
    const raw = me.holdings.find(x => ring(Number(x.p), Number(x.q)) <= 128) ?? null;
    if (!raw) {
      let homes = [];
      if (wide) {
        reads.push('/h/overview/* + /h/province/* (outward first-village candidates, once per turn)');
        if (wideRead?.bell !== bell) { try { wideRead = { bell, homes: await wideHomesOf(base, faction, { seed: wallet, nowBell: bell }) }; } catch { wideRead = null; } }
        homes = wideRead?.homes ?? [];
      } else {
        reads.push('/h/province/* (own nation, home sites)');
        try { homes = await homesOf(base, faction); } catch { homes = []; }
      }
      // (LP20-4: the citizen's own land stage — 'ticket' while a rim request is open, 'joined' once it has ended without a
      //  village — read from the same /h/me answer as the holdings, so the two never disagree)
      let landStage = null; try { landStage = landState(me.citizen).stage; } catch { landStage = null; }
      return { ...base0, joined: true, faction, holding: null, homes, landStage };
    }
    const tile = Number(raw.tile);
    const holding = { p: Number(raw.p), q: Number(raw.q), site: Number(raw.site), ...(Number.isInteger(tile) && tile >= 0 && tile <= 60 ? { tile } : {}) };
    // (S1: the terrain ore is said before the record is projected: a promotion's base change reads it too)
    if (season.s1) { holding.oreExtra = terrainOreExtra(raw); if (holding.oreExtra !== null) knowVillageOre(holding, holding.oreExtra); }
    let stores = null, st = null;
    try { st = settled(raw, nowSecs); stores = storesAt(raw, nowSecs, RESOURCE_ORDER).map(s => ({ resource: s.resource, value: s.value, perHour: s.perHour, cap: s.cap })); } catch { stores = null; }
    reads.push('/h/province/<own>');
    let province = null;
    try { const pv = await h.province(holding.p, holding.q); if (pv.ok && pv.province) province = { resolvedNext: Number(pv.province.resolvedNext), passableMask: pv.province.passableMask }; } catch { province = null; }
    const wideInv = wide && identity ? wideInventory(me.record, me.citizen, { wallet, programId: identity.programId, seasonAddress: identity.seasonAddress, seasonId: season.seasonId }) : undefined;
    // (external-wide-orders: the page's land stage of its first village — a wide claim needs it final: NotFinal, Custom 24)
    let landStage = null; try { landStage = landState(me.citizen).stage; } catch { landStage = null; }
    return { ...base0, joined: true, faction, holding, settled: st, stores, province, landStage, ...(wideInv ? { wideInv } : {}) };
  };
}
