// The walletless demo's NPC camps (owner r0ze 2026-11-28 16:21 「中立の野営地・盗賊、倒すと報酬、行軍と戦闘は既存のもの」):
// bandit camps on the demo map that a player marches on and beats for loot. PURE: no world, no clock, no DOM — the
// sample world (permutation-gateway/screens/liveworld.mjs, option `camps`) keeps the state and calls these; the page
// reads the same numbers from the world record (`sample.camps`) to say a camp's loot before the march.
//
// What is the program's and what is the demo's (code wins):
//   - a camp IS the program's camp: the Province's one Camp record (tile, troops, gen; frontier-abi Camp), a neutral
//     garrison of the clash (permutation-rules clash_model; the page's kernel resolves it), cleared when an arrival
//     beats it (`camp_mask`, the camp's Works to the winner: prog/transit.rs) — nothing of the march or the clash is new;
//   - the program opens a camp in each province of ring ≥ 2 and re-rolls it once a game day (camp.rs place, chance one
//     half, 100–400 troops). The demo sets NEXT_CHECK_DAY to "never" (so the kernel and the world both skip the day's
//     check) and places, scales and regrows its camps by the rules below;
//   - the loot (food, ore, gold into the winner's first village) is the demo's alone: the program pays only Works.
// Every number is DEMO_CAMPS (reported with its playtests in reports/demo-npc-camps.md).

export const DEMO_CAMPS = Object.freeze({
  /** Rings that get a camp, one a province (the demo map is rings 0–2; ring 0 is the open middle). */
  rings: Object.freeze([1, 2]),
  /** A camp's troops when it (re)appears: base + perProvince × provinces from the player's first village. */
  baseTroops: 300,
  perProvince: 200,
  /** Before the player has a village: the distance taken (the middle of the map's 0–4). */
  defaultDistance: 2,
  /** Each time a camp comes back it is this much stronger (basis points, compounding), capped. */
  regrowBps: 2_000,
  capTroops: 1_500,
  /** Turns after a camp is cleared before it comes back (on the same tile, once nobody stands on it). 0: never. */
  regrowBells: 20,
  /** The loot, per defender the camp had when the clash that cleared it began (milli-units per troop). */
  lootMilli: Object.freeze({ food: 300, ore: 100, gold: 50 }),
  /** A ring-1 camp keeps at least this many tiles from the province's centre tile (where the flag castle goes). */
  centreGap: 3,
});

export const NEVER = 0xffff_ffff;   // Camp.NEXT_CHECK_DAY (u32): the day's check never comes
const RES = Object.freeze({ food: 0, ore: 3, gold: 5 });
const hexD = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
const bitOn = (mask, t) => ((BigInt(mask) >> BigInt(t)) & 1n) === 1n;

/** A deterministic 32-bit mix of integers (FNV-1a over their decimal text): the tie-break of a camp's tile. */
export function mix(...xs) {
  let h = 0x811c9dc5;
  for (const ch of xs.join(',')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/**
 * The camp tile of a province (`pv`: p, q, ring, passableMask, sites, siteCount; `offsets`: fgeo TILE_OFFSETS): the
 * passable tile 1..60 that is not a village site and is farthest from every site (taken or free: a new home goes on a
 * free one); in ring 1 at least `centreGap` from the centre tile (the flag castle's place). Ties by mix(p, q, tile).
 * → a tile index, or -1.
 */
export function campTile(pv, offsets, rules = DEMO_CAMPS) {
  const sites = Array.from(pv.sites).slice(0, pv.siteCount);
  let best = -1, bestScore = -1, bestTie = 0;
  for (let t = 1; t < offsets.length; t++) {
    if (!bitOn(pv.passableMask, t) || sites.includes(t)) continue;
    if (pv.ring === 1 && hexD(offsets[t], { q: 0, r: 0 }) < rules.centreGap) continue;
    const score = sites.length ? Math.min(...sites.map(s => hexD(offsets[t], offsets[s]))) : 9;
    const tie = mix(pv.p, pv.q, t);
    if (score > bestScore || (score === bestScore && tie < bestTie)) { best = t; bestScore = score; bestTie = tie; }
  }
  return best;
}

/** A camp's troops (whole troops) at `distance` provinces from the player's village, on its `comeback`-th return (0: first). */
export function campTroops(distance, comeback = 0, rules = DEMO_CAMPS) {
  const d = Number.isInteger(distance) && distance >= 0 ? distance : rules.defaultDistance;
  return Math.min(rules.capTroops, Math.round((rules.baseTroops + rules.perProvince * d) * ((10_000 + rules.regrowBps) / 10_000) ** Math.max(0, comeback)));
}

/** The loot of beating a camp of `troops` defenders: `{food, ore, gold}` whole units. */
export function lootOf(troops, rules = DEMO_CAMPS) {
  const n = Math.max(0, Math.floor(Number(troops) || 0));
  return { food: Math.floor((n * rules.lootMilli.food) / 1000), ore: Math.floor((n * rules.lootMilli.ore) / 1000), gold: Math.floor((n * rules.lootMilli.gold) / 1000) };
}

/** The store index of each loot resource (rules.mjs RES: Food 0, Ore 3, Gold 5). */
export const LOOT_RES = RES;

/** The camp mask's winner (prog/transit.rs: the arrival at the lowest set position stays): its position 0..23, or -1. */
export const maskWinner = mask => (mask ? 31 - Math.clz32(mask & -mask) : -1);

/** What the page reads of the camps rule (`sample.camps` of the world record): `{v, loot, regrowBells}`, or null. */
export function campsOn(FS) {
  const c = FS?.sample?.camps;
  return c && c.v === 1 && c.lootMilli && typeof c.lootMilli === 'object' ? c : null;
}
