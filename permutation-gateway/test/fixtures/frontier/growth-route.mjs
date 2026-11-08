// Map growth, ring 4 → ring 5: the route and seed/geometry contract (workstream 08), as data.
//
// What this module is: the herald `/h/season` GROWTH FIELDS of one S1 world at four stages of ExtendFrontier
// (chapter 28: effective rMax = max(Season r_max @68, Frontier R_MAX_EXT @66); ceiling = conquest u16 @78, hard
// limit 128), the public ring seeds, two Provinces on either side of the old edge, and what the real S1 rules
// module (frontier-v3.wasm, the kernel `kernelFile` picks for layout 2 / program_version 4) answers there.
// What it is not: account bytes. The S1 Season / Frontier / RingSeed / Province / Holding bytes and the herald
// router's golden responses are workstream 19's Rust fixture (frontier-abi); `withGrowth` overlays these fields on
// such a record so both carry the same stage, seeds and coordinates. Nothing here is a layout-1 (M1) account, and
// nothing here touches a key: the seeds are sha256 of a public label, the same rule as web-frontier-live-map.
//
// Pinned by test/web-frontier-growth-route.test.mjs against the committed frontier-v3.wasm and the page's modules.
import { createHash } from 'node:crypto';

/** Ring d's seed: sha256("ring" + d), hex (public; the existing live-map evidence uses the same rule). */
export const ringSeed = d => createHash('sha256').update(`ring${d}`).digest('hex');
/** The herald's `rings` list for rings 0..n-1 (only seeded rings are listed: views.rs season_json). */
export const seededRings = n => Array.from({ length: n }, (_, d) => ({ d, seed: ringSeed(d) }));
/** The planner's `seeds` argument for the same rings (what app.mjs seedsNow passes). */
export const plannerSeeds = n => seededRings(n).map(r => ({ ring: r.d, seed: r.seed }));

const COUNTS = [1, 6, 12, 18, 24, 30, 36];
/** Season r_max (bytes @68) stays 4 throughout; the growth is Frontier R_MAX_EXT. Ceiling 6: ring 7 is beyond it. */
export const SEASON_R_MAX = 4, CEILING = 6;

/**
 * The four stages, as the herald reports them. `rExt` is Frontier R_MAX_EXT (0: none yet).
 *   before    ring 5 is past the map's edge but under the ceiling            → place 'extendable', no seed, no route
 *   extended  ExtendFrontier(5) landed (log 104): rMax 5, ring 5 not opened → 'unopened', no seed, no route
 *   opened    OpenRing(5) landed, its RingSeed requested, not yet revealed  → 'pending',  no seed, no route
 *   grown     seed revealed and all 30 Provinces of ring 5 created           → 'open', seed listed, route
 * (A partly created ring — some of its Provinces on chain — is web-frontier-world-growth.test.mjs's case.)
 */
export const STAGES = Object.freeze({
  before:   { rExt: 0, ringsOpened: 5, seeded: 5, ringProvinces: COUNTS.slice(0, 5) },
  extended: { rExt: 5, ringsOpened: 5, seeded: 5, ringProvinces: COUNTS.slice(0, 5) },
  opened:   { rExt: 5, ringsOpened: 6, seeded: 5, ringProvinces: [...COUNTS.slice(0, 5), 0] },
  grown:    { rExt: 5, ringsOpened: 6, seeded: 6, ringProvinces: COUNTS.slice(0, 6) },
});
export const STAGE_ORDER = Object.freeze(['before', 'extended', 'opened', 'grown']);

/** The herald `/h/season` growth fields of a stage (views.rs: rMax is the effective one). */
export function growthFields(stage) {
  const s = STAGES[stage];
  if (!s) throw new Error(`unknown stage ${stage}`);
  return {
    rMax: Math.max(SEASON_R_MAX, s.rExt), rings: seededRings(s.seeded), ringsOpened: s.ringsOpened,
    ringProvinces: [...s.ringProvinces], rMaxCeiling: CEILING, rMaxHard: 128, prizeMaxRing: 17, placement: 0, heartlandMaxRing: 3,
  };
}

/**
 * A season record at `stage`: `record`'s other fields (its bytes_b64, clock, ids — e.g. workstream 19's golden
 * response) with the growth fields replaced. The Season bytes are not touched: their r_max stays the world's
 * creation value; the herald's rMax carries the extension (Frontier R_MAX_EXT), as on chain.
 */
export const withGrowth = (record, stage) => ({ ...record, ...growthFields(stage) });

/** The two Provinces on either side of the old edge (ring 4 → ring 5), with what the rules give them. */
export const ORIGIN = Object.freeze({ p: 4, q: 0, tile: 0 });
export const TARGET = Object.freeze({ p: 5, q: 0, tile: 0 });
export const GEOMETRY = Object.freeze({
  '4,0': { ring: 4, wedge: 0, region: 8, centre: { q: 36, r: -16 }, tile0: { q: 32, r: -16 },
    terrainSha256: 'de18bbc8320f96db3c9f0f222b91292d49d92b5f28789ab8c2e7536b69333f53', sites: [4, 33, 49, 53, 0, 11, 13, 17, 26, 28, 38, 43], passableMask: 2305843009188528127n },
  '5,0': { ring: 5, wedge: 0, region: 7, centre: { q: 45, r: -20 }, tile0: { q: 41, r: -20 },
    terrainSha256: 'ab335170b74b22b6c14efb7864f645e721bc97e15617efb1fae788b55858bb51', sites: [18, 28, 45, 30, 53, 1, 4, 17, 48, 12, 35, 50], passableMask: 2305843009213693951n },
});

/** What plan_path answers from ORIGIN to TARGET (unit 0, Spearman; no palisades) with the stage's seeds. */
export const ROUTE = Object.freeze({
  dirs: [0, 0, 0, 0, 1, 1, 0, 1, 1], pathLen: 9, hexes: 9, secs: 1320, provinces: [{ p: 4, q: 0 }, { p: 5, q: 0 }],
});
export const EXPECT = Object.freeze({
  before:   { place: 'extendable', seed5: false, route: 'NoPath' },
  extended: { place: 'unopened',   seed5: false, route: 'NoPath' },
  opened:   { place: 'pending',    seed5: false, route: 'NoPath' },
  grown:    { place: 'open',       seed5: true,  route: ROUTE },
});
