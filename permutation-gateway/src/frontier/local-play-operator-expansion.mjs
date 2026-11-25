// TEST-ONLY local wide play (expansion-gameplay-1, owner t491u 2026-11-24: nations should visibly spread across the
// map; design note docs/design/expansion/01-reach-from-land.md). WHERE an operator AI resident files its wide claim.
//
// Operator residents play like players (t481u Q6): the same rule, the same reads. A claim reaches OUTPOST_RANGE (3)
// provinces from the first home — and, since expansion-gameplay-1, from any wide province that is the resident's
// NATION'S LAND (a village of the nation there, or a keep the nation won: frontier-abi world_index/reach.rs, the
// program's own check), named as the claim's reach witness. Which of the reachable provinces to take is the choice:
//
//   - push the frontier: farther from the resident's own home first (a village beside the ones the nation already has
//     moves nothing on the map);
//   - a heading per resident (outward, clockwise along the ring, counter-clockwise), so a nation's residents spread in
//     different directions rather than all piling onto one province;
//   - a province where the nation already has a village counts for less (the program refuses at 50 % of its weight).
//
// The wide land is read from the herald's recorded wide world (the page's own walk, map/wide.mjs loadWide), cached a
// few seconds per process: the opened provinces (the local runner opens more where nations go, itest wide_frontier)
// and their captured bytes (who has a village, who won the keep).
import { createHerald } from '../../../permutation-server/web/frontier/herald.mjs';
import { loadWide, WideWalk, ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { claimTargets, distance, nationLandsOf, OUTPOST_RANGE } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';

/** The three headings a resident may push toward. */
export const HEADINGS = Object.freeze(['outward', 'clockwise', 'counter-clockwise']);
/** A resident's heading by its index (deterministic: residents of one world spread three ways). */
export const headingOf = index => HEADINGS[((Number(index) % 3) + 3) % 3];

/** Milliseconds a read of the wide land is reused. */
export const WIDE_LAND_TTL_MS = 15_000;

/**
 * The wide land reader of one process: `{read()}` → `{opened: [{p, q}], entries: [{p, q, bytes_b64}]}` (decimal strings)
 * or null when the herald serves none yet. One walk at a time; reused for WIDE_LAND_TTL_MS.
 */
export function createWideLandReader({ herald: base, fetch: f = (...a) => globalThis.fetch(...a), now = () => Date.now(), ttlMs = WIDE_LAND_TTL_MS }) {
  const herald = createHerald({ base, fetch: f });
  let cached = null, at = -Infinity, pending = null;
  async function walk() {
    const r = await loadWide(herald, { walk: new WideWalk() });
    if (!r.ok) return null;
    const entries = [];
    for (const e of r.walk.entries.values()) {
      if (e.state !== 'open' || !e.wide || e.ring <= 128n) continue;
      const b64 = e.wide.capture?.bytes_b64;
      entries.push({ p: String(e.p), q: String(e.q), bytes_b64: typeof b64 === 'string' ? b64 : null });
    }
    return { opened: entries.map(e => ({ p: e.p, q: e.q })), entries };
  }
  return {
    async read() {
      if (cached && now() - at < ttlMs) return cached;
      pending ??= walk().then(v => { if (v) { cached = v; at = now(); } return v ?? cached; }).finally(() => { pending = null; });
      return pending;
    },
  };
}

// the angle of (p, q) round the map, as a fraction of a turn (ringPosition: wedge 0–5, then `pos` 0..ring−1 in it)
const turnOf = (p, q) => {
  const rp = ringPosition(BigInt(p), BigInt(q));
  return rp.ring === 0n ? 0 : (rp.wedge * Number(rp.ring) + Number(rp.pos)) / (6 * Number(rp.ring));
};
const ringOf = (p, q) => Number(ringPosition(BigInt(p), BigInt(q)).ring);

/** How well `t` follows `heading` from `home`: provinces outward, or along the ring (signed), ≥ 0. */
export function headingBonus(home, t, heading) {
  // (fix-loop16, `--near`: `{toward: {p, q}}` — each province nearer to that place than home is, counted twice: with the
  //  score's half weight and its push away from home, a province 1 nearer to the place wins over one 1 farther from home)
  if (heading && typeof heading === 'object' && heading.toward) return Math.max(0, 4 * (distance(home, heading.toward) - distance(t, heading.toward)));
  if (heading === 'outward') return Math.max(0, ringOf(t.p, t.q) - ringOf(home.p, home.q));
  let d = turnOf(t.p, t.q) - turnOf(home.p, home.q);
  d -= Math.round(d);
  const steps = d * 6 * ringOf(t.p, t.q);
  return Math.max(0, heading === 'clockwise' ? steps : -steps);
}

/**
 * The claim targets of a resident, best first: claimTargets from `home` over the live opened land and the nation's
 * land (each far target with its `reach` witness), scored by distance from home (the frontier push), the heading's
 * bonus (half weight), minus 3 where the nation already has a village. `wideNow`: createWideLandReader's read.
 */
export function expansionTargets(home, wideNow, faction, { heading = 'outward' } = {}) {
  if (!wideNow) return [];
  const lands = nationLandsOf(wideNow.entries, faction);
  const mine = new Set(lands.map(l => `${l.p},${l.q}`));
  const score = t => distance(home, t) + headingBonus(home, t, heading) / 2 - (mine.has(`${t.p},${t.q}`) ? 3 : 0);
  return claimTargets(home, wideNow.opened, lands)
    .map(t => ({ t, s: score(t) }))
    .sort((a, b) => b.s - a.s || (a.t.p + ',' + a.t.q < b.t.p + ',' + b.t.q ? -1 : 1))
    .map(x => x.t);
}

// (territory-impl, owner 2026-11-24 12:09: the wide province's trailer byte RSV_53 = 4,736 + 53 names its territory rule —
//  frontier-abi world_index/land.rs territory_rule_of; the site tiles are Province v2 SITES @250 × 12, SITE_COUNT @262;
//  the keep's tile KEEP @4480)
const TERRITORY_AT = 4789, SITES_AT = 250, SITE_COUNT_AT = 262, KEEP_TILE_AT = 4480;
const bytesOf = e => {
  const b64 = e?.bytes_b64;
  if (typeof b64 !== 'string') return null;
  return typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(b64, 'base64')) : Uint8Array.from(atob(b64), c => c.charCodeAt(0));
};

/** A wide province's territory facts from its herald capture, or null outside a territory world / unread:
 *  `{siteTiles: [tile] (by site), keepTile}`. */
export function territoryOfBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 4864 || bytes[TERRITORY_AT] !== 1) return null;
  const n = Math.min(bytes[SITE_COUNT_AT], 12);
  return { siteTiles: Array.from(bytes.subarray(SITES_AT, SITES_AT + n)), keepTile: bytes[KEEP_TILE_AT] };
}

/** `targets` (expansionTargets) with each one's territory facts attached when the world plays territory. */
export function withTerritory(targets, wideNow) {
  if (!wideNow?.entries) return targets;
  const by = new Map(wideNow.entries.map(e => [`${e.p},${e.q}`, e]));
  return targets.map(t => {
    let tf = null;
    try { tf = territoryOfBytes(bytesOf(by.get(`${t.p},${t.q}`))); } catch { tf = null; }
    return tf ? { ...t, territory: tf } : t;
  });
}

export { OUTPOST_RANGE };
