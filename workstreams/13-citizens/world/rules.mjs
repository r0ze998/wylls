// The test world's figures. Each one is the game's own, read from the Rust
// rules or the gateway (test/rules-pinned.test.mjs reads the sources and
// fails when one moves); what the test world leaves out is listed in
// SIMPLIFIED and in ../05-results.ja.md. Units are whole units unless the
// name says milli.
import { CATALOG_S1, RESOURCES_S1 } from '../../../permutation-gateway/src/frontier/agent/runner.mjs';
import { QUOTA } from '../../../permutation-gateway/src/frontier/quota.mjs';

/** One turn (bell) of chain time: runner.mjs BELL_SECS, web clock.mjs. */
export const BELL_SECS = 600;
export const BELLS_PER_DAY = 144;
export const MILLI = 1000;

/** Store slots in Resource order (holding.rs Resource::ALL; slot 4 is Arms under S1, arms.rs ARMS). */
export const RESOURCES = RESOURCES_S1;
/** Science and Influence are pledge-only (holding.rs pledge_only): never moved by a caravan. */
export const MOVABLE = Object.freeze(['Food', 'Wood', 'Stone', 'Ore', 'Arms', 'Gold']);

/** A first holding's starter kit (catalog.rs STARTER_KIT): what every joiner, person or AI, is credited at founding. */
export const STARTER_KIT = Object.freeze([300, 300, 200, 100, 0, 100, 0, 0]);
/** A Hamlet's base production per hour (catalog.rs BASE_PROD; tier bonus 0). */
export const BASE_PROD = Object.freeze([40, 30, 20, 15, 0, 15, 5, 0]);
/** A Hamlet's storage cap per resource (holding.rs Tier::storage_cap, 2,000 units). */
export const HAMLET_CAP = 2000;

/** The S1 build catalog the agent wallet tells its model (runner.mjs CATALOG_S1, pinned against arms.rs). */
export const BUILDINGS = CATALOG_S1.build;

/** A flat hex for a foot host (travel.rs FLAT_HEX_SECS), and a caravan's slowdown (caravan.rs CARAVAN_SLOW_BPS). */
export const FLAT_HEX_SECS = 120;
export const CARAVAN_SLOW_BPS = 15_000;
export const CARAVAN_HEX_SECS = FLAT_HEX_SECS * CARAVAN_SLOW_BPS / 10_000;
/** Lamports a caravan escrows for its settlement (caravan.rs CARAVAN_FEE). */
export const CARAVAN_FEE = 50_000;

/** The on-chain action bucket every citizen has (frontier-abi presets.rs: bucket_rate_per_h 30, bucket_burst 60). */
export const BUCKET = Object.freeze({ perHour: 30, burst: 60 });
/** The relay's sponsored transactions per citizen and game day (quota.mjs D4: 40 on days 0–6). */
export const RELAY_PER_DAY = QUOTA.earlyPerDay;

/** What the test world does not model (stated so no result is read as the full game). */
export const SIMPLIFIED = Object.freeze([
  'one village per participant, Hamlet tier, no upkeep, no troops, no marches, no sealed information',
  'a build finishes BUILD_BELLS after it is ordered and adds its per_hour production',
  'a caravan walks a straight flat route: hex distance x CARAVAN_HEX_SECS, rounded up to whole bells',
  'a raid is a scripted public event on a named route, not a host on a tile',
  'the caravan fee is charged and not refunded at settlement',
  'actions are applied at the next bell by the test world, not by the Frontier program',
  'a workshop does not use up ore and wood (CATALOG_S1 uses_per_hour is not applied)',
]);
export const BUILD_BELLS = 6;

/** Hex distance on axial coordinates. */
export function hexDistance(a, b) {
  const dq = a.q - b.q, dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Bells a caravan needs between two villages (at least one). */
export function caravanBells(a, b) {
  return Math.max(1, Math.ceil(hexDistance(a, b) * CARAVAN_HEX_SECS / BELL_SECS));
}

/** Production per bell in milli-units for a resource index: base plus finished buildings. */
export function prodPerBellMilli(resIndex, buildings) {
  let perHour = BASE_PROD[resIndex];
  for (const item of buildings) {
    const b = BUILDINGS.find(x => x.item === item);
    if (b && b.produces === RESOURCES[resIndex]) perHour += b.per_hour;
  }
  return Math.floor(perHour * MILLI * BELL_SECS / 3600);
}

export const resIndex = name => {
  const i = RESOURCES.indexOf(name);
  if (i < 0) throw new Error(`unknown resource ${name}`);
  return i;
};
