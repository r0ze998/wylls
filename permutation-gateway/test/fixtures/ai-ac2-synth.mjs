// SYNTHETIC herald data for the AC2 episode tests (citizens-memory-*.test.mjs). Every object here is made by hand
// in the shape the real herald serves (`/h/events` rows, `/h/clash/p,q/b` files, `/h/province/p,q/b` envelopes after
// decoding), because the captured fixtures of AC6a (`ai-herald-*`) did not exist yet when AC2 was built. A test
// that depends on these says so in its title ("synthetic"); tests that read real recorded files say "recorded".
//
// Units follow the herald: troops in milli-troops in Province entries and in the clash report; camps in whole troops.
export const MILLI = 1000;

/** A decoded /h/events row. `name` is the decoded kind name. */
export function row(seq, sig, bell, name, key, payload, slot = 1000 + seq) {
  return { seq: String(seq), slot, sig, kind: 0, bell, tx: 0, decoded: { bell, key, name, payload } };
}

/** A hand-made province (the normalised form of herald-view.mjs normProvince). `sites[k]` is the tile of site k. */
export function province({ p, q, sites = [0], mirror = null, entries = [], camp = null }) {
  const m = mirror ?? sites.map(() => ({ state: 0, faction: 6, tier: 0, garrison: 0, shieldUntilBell: 0, gen: 0 }));
  return {
    norm: 'province', p, q, sites, siteCount: sites.length,
    mirror: m.map(x => ({ state: 0, faction: 6, tier: 0, garrison: 0, shieldUntilBell: 0, gen: 0, ...x })),
    entries: entries.map(e => ({ id: String(e.id), faction: e.faction, unit: 1, tile: e.tile, state: e.state ?? 1, troops: e.troops * MILLI })),
    camp: camp ? { tile: camp.tile, state: camp.state ?? 1, troops: camp.troops, gen: camp.gen ?? 1 } : { tile: 0, state: 0, troops: 0, gen: 0 },
  };
}

/** A /h/clash file (decoded fighters, plus the province before the resolve and the gathered inputs). Troops in whole troops here. */
export function clashFile({ p, q, bell, fighters, before, arrivals = [] }) {
  return {
    v: 1, bell, province: [p, q], key: `ci:${p},${q},${bell}`,
    decoded: {
      engagements: fighters.filter(f => f.engaged).length, fates: [],
      fighters: fighters.map(f => ({ id: String(f.id), arrival: !!f.arrival, troops: f.post * MILLI, stamina: 100, fate: f.fate ?? 'Stays', tile: f.tile ?? null, engaged: !!f.engaged })),
    },
    province_before: before,
    inputs: { arrivals: arrivals.map(a => ({ hostId: String(a.id), citizenTag: String(a.tag), faction: a.faction, unit: 1, tile: a.tile, troops: a.troops * MILLI, depMass: a.troops * MILLI, present: 1 })) },
  };
}

/** A tiny herald: province files by (p,q,bell) with a default per (p,q), clash files by key. */
export function fakeHerald({ provinces = {}, clashes = [] } = {}) {
  const cl = new Map(clashes.map(c => [`${c.province[0]},${c.province[1]},${c.bell}`, c]));
  return {
    province: (p, q, b) => provinces[`${p},${q},${b}`] ?? provinces[`${p},${q}`] ?? null,
    clash: (p, q, b) => cl.get(`${p},${q},${b}`) ?? null,
  };
}

/** Decimal u64 of a hex16 tag (the herald writes tags as decimal strings). */
export const dec = hex => BigInt(`0x${hex}`).toString();

/** A deterministic PRNG (mulberry32) for the property tests. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
