// Headless playtest of the demo's travelers (screens/travelers.mjs): for every province a player's first village can
// stand in (ring 2: the join places it in its nation's ring-2 provinces) and for a grid of walk / reach / limit numbers,
// how soon a traveler first visits, how often, for how long, and what a player who buys ore at every visit gets.
//
//   node travelers-playtest.mjs [--turns 100] [--from 45] [--grid] [--json out.json]
//
// (`--turns 100` ≈ a 20-minute demo game at 12 s a turn; `--from`: the turn the player has joined by.)
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import * as TV from '../screens/travelers.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const TURNS = Number(arg('turns', 100)), FROM = Number(arg('from', 45)), GRID = process.argv.includes('--grid');

const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, territory: true, paused: true, nations: true, landClaim: true, stage: 'none', travelers: true });
const passable = (p, q, t) => { const pv = live.province(p, q); return !!pv && ((pv.passableMask >> BigInt(t)) & 1n) === 1n; };
const villages = live.summary().neighbours.map(n => ({ p: n.village[0], q: n.village[1], tile: n.tile }));
const homes = ringProvinces(2);

function run(rules) {
  const list = TV.planTravelers({ passable, villages }, rules);
  const rows = homes.map(home => {
    let first = null, visits = 0, covered = 0, lens = [], cur = new Map(), ore = 0, food = 0;
    for (let b = FROM; b < FROM + TURNS; b++) {
      let any = false;
      for (const t of list) {
        const v = TV.visitAt(t.loop, t.offset, b, home, rules);
        if (v === null) { if (cur.has(t.id)) { lens.push(cur.get(t.id)); cur.delete(t.id); } continue; }
        any = true;
        if (!cur.has(t.id)) { cur.set(t.id, 0); visits++; const r = TV.ratesOf(t, v, 1, rules); ore += rules.lotsPerVisit * r.lot; food += rules.lotsPerVisit * r.buy; }
        cur.set(t.id, cur.get(t.id) + 1);
      }
      if (any) { covered++; if (first === null) first = b - FROM; }
    }
    for (const n of cur.values()) lens.push(n);
    return { home: `${home.p},${home.q}`, first, visits, covered: covered / TURNS, meanLen: lens.length ? lens.reduce((a, x) => a + x, 0) / lens.length : 0, minLen: lens.length ? Math.min(...lens) : 0, ore, food };
  });
  const loops = list.map(t => ({ id: t.id, stops: t.loop.stops.length, length: t.loop.length, tiles: t.loop.legs.reduce((a, l) => a + l.path.length - 1, 0) }));
  const agg = k => rows.map(r => r[k]);
  const firsts = agg('first').map(x => (x === null ? Infinity : x));
  return { rules, loops, rows, worstFirst: Math.max(...firsts), meanFirst: firsts.reduce((a, x) => a + x, 0) / firsts.length, minVisits: Math.min(...agg('visits')), maxVisits: Math.max(...agg('visits')),
    meanCovered: agg('covered').reduce((a, x) => a + x, 0) / rows.length, minLen: Math.min(...agg('minLen')), meanLen: agg('meanLen').reduce((a, x) => a + x, 0) / rows.length, maxOre: Math.max(...agg('ore')), minOre: Math.min(...agg('ore')) };
}

const out = [];
const grid = GRID ? { speed: [2, 3, 4], rest: [1, 2, 3], reach: [0, 1], lotsPerVisit: [3, 4] } : { speed: [TV.TRAVELERS_V1.speed], rest: [TV.TRAVELERS_V1.rest], reach: [TV.TRAVELERS_V1.reach], lotsPerVisit: [TV.TRAVELERS_V1.lotsPerVisit] };
for (const speed of grid.speed) for (const rest of grid.rest) for (const reach of grid.reach) for (const lotsPerVisit of grid.lotsPerVisit) {
  const r = run({ ...TV.TRAVELERS_V1, speed, rest, reach, lotsPerVisit });
  out.push(r);
  console.log(`speed ${speed} rest ${rest} reach ${reach} lots ${lotsPerVisit} | loops ${r.loops.map(l => `${l.id}:${l.length}t/${l.tiles}tiles`).join(' ')} | first worst ${r.worstFirst} mean ${r.meanFirst.toFixed(1)} | visits ${r.minVisits}-${r.maxVisits} | covered ${(100 * r.meanCovered).toFixed(0)}% | visit len min ${r.minLen} mean ${r.meanLen.toFixed(1)} | ore if buying every visit ${r.minOre}-${r.maxOre}`);
}
if (!GRID) for (const x of out[0].rows) console.log(`  home ${x.home.padEnd(6)} first ${String(x.first).padStart(3)} visits ${String(x.visits).padStart(2)} covered ${(100 * x.covered).toFixed(0).padStart(3)}% len min ${x.minLen} mean ${x.meanLen.toFixed(1)} ore ${x.ore} for food ${x.food}`);
const j = arg('json', null);
if (j) writeFileSync(j, JSON.stringify(out, null, 1));
