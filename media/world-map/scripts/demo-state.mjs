// A DEMO population for the world map (制作上の補完, not a record): villages on the real free sites
// of a recorded season, a few standing hosts, two contested frontier keeps with a clash on each,
// and a host at a barbarian camp. On main no populated S1 world can be recorded (the bots'
// joins are refused under S1), so the map's people come from here, by the rules' own shapes:
//
//   villages   only on sites the record has free (state 0), in rings 2–4 of their own nation's
//              wedge (the heartland and the frontier; ring 1's sites are reserved and stay
//              empty, the Concord has none), denser toward the Concord, towns and cities
//              more often in the heartland. Each nation has its own seeded share and spread.
//   hosts      standing (state 1) at some villages, and the two fronts' forces on and beside
//              a ring-4 keep between two neighbouring nations: the attackers' stance assault or
//              flank, the holders' brace, one broken host in disarray.
//   contests   the keep's contender and a share of the progress the rules count to take it.
//
//   node media/world-map/scripts/demo-state.mjs season-92 demo-1 [seed]
// writes media/world-map/data/demo-1.json. The same seed makes the same demo.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wedgeOf, DIRECTIONS, hexDistance, TILE_OFFSETS, tileHex } from '../../../permutation-server/web/frontier/fgeo.mjs';

const [season = 'season-92', name = 'demo-1', seedArg = '7'] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const world = JSON.parse(readFileSync(join(here, '..', 'data', `${season}.json`), 'utf8'));
let s = Number(seedArg) >>> 0 || 7;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const pick = xs => xs[Math.floor(rnd() * xs.length)];

// each nation's own temper: how many of its sites are settled, how far it has grown
const NATION = Array.from({ length: 6 }, () => ({ share: 0.32 + rnd() * 0.22, growth: 0.25 + rnd() * 0.55 }));
const SHARE_BY_RING = { 2: 0.6, 3: 0.46, 4: 0.28 };
const villages = [], hosts = [], contests = [], clashes = [];
let hostId = 1;
const byKey = new Map(world.provinces.map(p => [`${p.p},${p.q}`, p]));
// keeps and camps stand clear: no village within two tiles of a keep (whichever province it is in) or on a camp's tile
const keepHexes = world.provinces.filter(p => p.keep && p.keep.tile < 61).map(p => tileHex(p.p, p.q, p.keep.tile));
const clearOfKeeps = (p, tile) => { const h = tileHex(p.p, p.q, tile); return keepHexes.every(k => hexDistance(h.q, h.r, k.q, k.r) > 2) && !(p.camp && p.camp.tile === tile); };
for (const p of world.provinces) {
  if (p.ring < 2 || p.wedge > 5) continue;
  const f = p.wedge, N = NATION[f];
  const free = p.sitesMirror.map((m, j) => ({ m, j })).filter(x => x.m.state === 0 && clearOfKeeps(p, p.sites[x.j]));
  const want = Math.round(free.length * SHARE_BY_RING[p.ring] * (N.share / 0.43));
  // spread out: prefer sites far from the ones already taken
  const taken = [];
  const dist = j => { const a = TILE_OFFSETS[p.sites[j]]; return taken.length ? Math.min(...taken.map(t => { const b = TILE_OFFSETS[p.sites[t]]; return hexDistance(a.q, a.r, b.q, b.r); })) : 9; };
  const pool = free.slice();
  for (let n = 0; n < want && pool.length; n++) {
    pool.sort((a, b) => dist(b.j) - dist(a.j) + (rnd() - 0.5) * 2.5);
    const { j } = pool.shift();
    taken.push(j);
    const r = rnd() * (1 + N.growth) - (p.ring - 2) * 0.32;
    const tier = r > 1.25 ? 3 : r > 0.95 ? 2 : r > 0.55 ? 1 : 0;
    villages.push({ p: p.p, q: p.q, site: j, faction: f, tier, walls: tier >= 1 && rnd() < 0.35, garrison: Math.round((tier + 1) * (40 + rnd() * 120)) });
    // a standing host at some villages: its nation's own kinds
    if (rnd() < 0.18 + tier * 0.08) hosts.push({ id: hostId++, p: p.p, q: p.q, tile: p.sites[j], faction: f, unit: pick([0, 0, 1, 2, 3, 4, 5]), troops: 100 * (2 + Math.floor(rnd() * 9)) });
  }
}

// two fronts: a ring-4 keep of one nation that its neighbour in the next wedge attacks
const fronts = [[0, 1], [3, 4]];
for (const [holder, attacker] of fronts) {
  const ring4 = world.provinces.filter(p => p.ring === 4 && p.wedge === holder && p.keep && p.keep.tile < 61);
  // the keep nearest the attacker's wedge: a neighbour province is the attacker's
  const target = ring4.find(p => DIRECTIONS.some(([dp, dq]) => { const n = byKey.get(`${p.p + dp},${p.q + dq}`); return n && n.wedge === attacker; })) ?? ring4[0];
  if (!target) continue;
  contests.push({ p: target.p, q: target.q, contender: attacker, progress: 24 + Math.floor(rnd() * 30) });
  const at = TILE_OFFSETS[target.keep.tile], arrivals = [];
  const near = (k) => TILE_OFFSETS.map((o, i) => ({ i, d: hexDistance(o.q, o.r, at.q, at.r) })).filter(x => x.d === k).map(x => x.i);
  const ring1 = near(1);
  const add = (tile, faction, unit, troops, stance, fate = 'Stays') => {
    if (!Number.isInteger(tile) || tile < 0 || tile > 60) return;
    const id = hostId++;
    hosts.push({ id, p: target.p, q: target.q, tile, faction, unit, troops });
    arrivals.push({ hostId: String(id), present: true, tile, faction, stance, fate: fate === 'Stays' ? 0 : 5 });
  };
  add(target.keep.tile, holder, 3, 600, 3);
  add(ring1[0], holder, 1, 400, 3);
  add(ring1[2], attacker, 0, 900, 1);
  add(ring1[3], attacker, 2, 500, 2);
  add(ring1[4], attacker, 4, 300, 1, 'Destroyed');
  clashes.push({ p: target.p, q: target.q, arrivals });
}
// one host at a barbarian camp in the heartland's edge of each of two nations
for (const f of [2, 5]) {
  const p = world.provinces.find(x => x.ring === 3 && x.wedge === f && x.camp);
  if (!p) continue;
  const o = TILE_OFFSETS[p.camp.tile], nb = TILE_OFFSETS.findIndex(x => hexDistance(x.q, x.r, o.q, o.r) === 1);
  if (nb < 0) continue;
  const id = hostId++;
  hosts.push({ id, p: p.p, q: p.q, tile: nb, faction: f, unit: 2, troops: 500 });
  clashes.push({ p: p.p, q: p.q, arrivals: [{ hostId: String(id), present: true, tile: nb, faction: f, stance: 2, fate: 0 }] });
}

const out = { note: 'DEMO population (制作上の補完): villages, hosts and contests composed on a recorded season\'s real sites; not a record of play', season, seed: Number(seedArg), nations: NATION, villages, hosts, contests, clashes };
writeFileSync(join(here, '..', 'data', `${name}.json`), JSON.stringify(out, null, 1));
console.log(`${name}.json: ${villages.length} villages (${[0, 1, 2, 3].map(t => villages.filter(v => v.tier === t).length).join('/')} by tier), ${hosts.length} hosts, ${contests.length} contests`);
