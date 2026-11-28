#!/usr/bin/env node
// Headless playtests of the demo's NPC camps (web/frontier/democamps.mjs, liveworld `camps`) in Node: the very world the
// page plays (same rules kernel, same seed, the demo's options), on a hand-moved clock, with a scripted player. No
// browser, no server, no key (the keyless viewer; orders through the world's own instructions: liveworld `order`,
// `campsTest`). One line per game: camps cleared, loot, troops lost to camps, stores and army at the end.
//
//   node camps-playtest.mjs [--nation 0..5|all] [--turns 75] [--strategy hunter|none|reckless|all] [--ratio 1.5]
//                           [--set key=value,...] [--log] [--json out.json]
//   (--set: DEMO_CAMPS overrides, e.g. --set baseTroops=150,perProvince=60,regrowBells=15; lootMilli as food:ore:gold)
import { parseArgs } from 'node:util';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import { tileHex, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';

const { values: opt } = parseArgs({ strict: false, args: import.meta.url === `file://${process.argv[1]}` ? process.argv.slice(2) : [], options: {
  nation: { type: 'string', default: 'all' }, turns: { type: 'string', default: '75' }, strategy: { type: 'string', default: 'hunter' },
  ratio: { type: 'string', default: '1.5' }, chunk: { type: 'string', default: '300' }, set: { type: 'string', default: '' }, log: { type: 'boolean', default: false }, json: { type: 'string' },
} });
const parseSet = text => Object.fromEntries(text.split(',').filter(Boolean).map(kv => {
  const [k, v] = kv.split('=');
  if (k === 'lootMilli') { const [food, ore, gold] = v.split(':').map(Number); return [k, { food, ore, gold }]; }
  if (k === 'rings') return [k, v.split(':').map(Number)];
  return [k, Number(v)];
}));
const TURN_SECS = 12;
export const NAMES = ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'];

export async function game({ nation, strategy = 'hunter', turns = 75, ratio = 1.5, set = {}, log = false, chunk = 300 }) {
  let real = 1_000_000;
  const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true,
    turn: TURN_SECS, delay: 3, landMs: 400, wall: () => real, camps: Object.keys(set).length ? set : true });
  live.seen();
  const step = ms => { real += ms; live.clock(); };
  step(4_000);
  const j = live.campsTest.join(nation);
  if (!j?.ok) throw new Error(`join: ${JSON.stringify(j)}`);
  const T0 = live.summary().turn;
  const st = { built: new Set(), dest: new Map(), far: new Set(), sent: 0, used: 0, chunk };
  for (let k = 0; k < turns; k++) {
    step(TURN_SECS * 1000 * 0.5);
    const s = live.summary();
    if (strategy !== 'none') play(live, s, st, strategy, ratio, log);
    step(TURN_SECS * 1000 * 0.5);
  }
  const s = live.summary(), clears = live.campsLog().filter(x => x.kind === 'cleared');
  const mine = clears.filter(x => x.winner?.viewer);
  const loot = mine.reduce((a, x) => ({ food: a.food + x.loot.food, ore: a.ore + x.loot.ore, gold: a.gold + x.loot.gold }), { food: 0, ore: 0, gold: 0 });
  const army = s.me.reserve[0] + s.me.hosts.filter(h => h.unit === 0).reduce((a, h) => a + h.troops, 0);
  return { nation: NAMES[nation], strategy, turns, cleared: mine.length, byOthers: clears.length - mine.length, sent: st.sent, fights: st.fights ?? [], loot,
    stores: s.me.stores.slice(0, 6), army, clears: mine.map(x => ({ bell: x.bell - T0, defenders: x.defenders, host: x.winner.troops, survivors: x.winner.survivors, loot: x.loot })), backs: live.campsLog().filter(x => x.kind === 'back').length, firstClear: mine.length ? mine[0].bell - T0 : null, camps: live.camps() };
}

/**
 * The scripted player (what the page lets anyone do): a farm and an ore mine, then train what the stores pay for, form
 * one host, and march it on the nearest camp it outnumbers `ratio` to 1 (strategy 'hunter'); 'reckless' marches on the
 * nearest camp whatever it holds. It keeps the host's result to measure losses.
 */
function play(live, s, st, strategy, ratio, log) {
  const m = s.me, b = s.turn;
  if (!m) return;
  for (const [i, item] of [0, 3].entries()) if (!st.built.has(i) && live.order('Build', { item }, { p: m.village[0], q: m.village[1] }).ok) st.built.add(i);
  for (const n of [1000, 800, 600, 500, 400, 300, 200, 100]) if (live.order('Train', { unit: 0, n }, null).ok) break;
  const reserve = live.summary().me.reserve[0];
  // (a host marches about once in 30 turns — 74 stamina of 120, one a turn back —, so the troops go out as several hosts)
  if (reserve >= st.chunk) live.order('Muster', { unit: 0, troops: Math.min(reserve, Math.max(st.chunk, Math.floor(reserve / 100) * 100)), tile: m.tile }, { p: m.village[0], q: m.village[1] });
  const home = tileHex(m.village[0], m.village[1], m.tile);
  const camps = live.camps().camps.filter(c => c.up);
  const d = c => { const h = tileHex(c.p, c.q, c.tile); return hexDistance(h.q, h.r, home.q, home.r); };
  const ready = m.hosts.filter(h => h.state === 1 && h.unit === 0 && h.stamina >= 74 && h.readyBell <= b && h.troops >= 100 && !m.marches.some(x => x.host === h.id)).sort((a, c) => c.troops - a.troops);
  const going = new Set([...st.dest.entries()].filter(([h]) => m.marches.some(x => x.host === h)).map(([, k]) => k));
  for (const h of ready) {
    const targets = camps.filter(c => !going.has(`${c.p},${c.q}`) && !st.far.has(`${c.p},${c.q}`) && (strategy === 'reckless' || h.troops >= c.troops * ratio)).sort((a, c) => d(a) - d(c));
    for (const c of targets) {
      const r = live.campsTest.march(h.id, { p: c.p, q: c.q, tile: c.tile });
      if (r.ok) {
        st.sent++; st.dest.set(h.id, `${c.p},${c.q}`); going.add(`${c.p},${c.q}`);
        (st.fights ??= []).push({ bell: b, host: h.troops, camp: c.troops, p: c.p, q: c.q, arrive: r.arrive });
        if (log) console.log(`    t${b} march ${h.troops} → camp ${c.p},${c.q} (${c.troops}): arrive ${r.arrive}`);
        break;
      }
      if (r.code === 'Path') st.far.add(`${c.p},${c.q}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

async function main() {
  const nations = opt.nation === 'all' ? [0, 1, 2, 3, 4, 5] : opt.nation.split(',').map(Number);
  const strategies = opt.strategy === 'all' ? ['hunter', 'reckless', 'none'] : opt.strategy.split(',');
  const out = [];
  for (const strategy of strategies) for (const nation of nations) {
    const t = Date.now();
    const r = await game({ nation, strategy, turns: Number(opt.turns), ratio: Number(opt.ratio), set: parseSet(opt.set), log: opt.log, chunk: Number(opt.chunk) });
    out.push(r);
    console.log(`${strategy.padEnd(8)} ${r.nation.padEnd(8)} cleared ${r.cleared} (first t+${r.firstClear ?? '-'}) of ${r.sent} sent; others ${r.byOthers}; back ${r.backs}; loot f${r.loot.food}/o${r.loot.ore}/g${r.loot.gold}; end stores f${r.stores[0]} o${r.stores[3]} g${r.stores[5]}; army ${r.army} [${((Date.now() - t) / 1000).toFixed(0)} s]`);
  }
  if (opt.json) (await import('node:fs')).writeFileSync(opt.json, JSON.stringify(out, null, 1));
}
