#!/usr/bin/env node
// Headless playtests of the demo's single-player goal (demogoal.mjs, liveworld `goal`) in Node: the very world the
// page plays (same rules kernel, same seed), on a hand-moved clock, with a scripted player. No browser, no server, no
// key (the keyless viewer; the player's orders go through the world's own instructions: liveworld `order` and
// `testPlay`). Prints one line per game and, with --log, the castles' changes and the waves.
//
//   node goal-playtest.mjs [--games 5] [--strategy active|idle|turtle|all] [--nation 0..5|all] [--turns 200] [--log]
//                          [--set key=value,...]   (DEMO_GOAL overrides, e.g. --set holdBells=12,waveEvery=6)
import { parseArgs } from 'node:util';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import { TILE_OFFSETS, tileHex, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';

const { values: opt } = parseArgs({ options: {
  games: { type: 'string', default: '6' }, strategy: { type: 'string', default: 'all' }, nation: { type: 'string', default: 'all' },
  turns: { type: 'string', default: '220' }, log: { type: 'boolean', default: false }, set: { type: 'string', default: '' }, json: { type: 'string' },
} });
const over = Object.fromEntries(opt.set.split(',').filter(Boolean).map(kv => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
const TURN_SECS = 12;
const NAMES = ['Cinder', 'Borealis', 'Verdant', 'Tide', 'Dunmar', 'Aster'];

async function game({ nation, strategy, turns }) {
  let real = 1_000_000;
  const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true,
    turn: TURN_SECS, delay: 3, landMs: 400, wall: () => real, goal: Object.keys(over).length ? over : true });
  live.seen();
  const step = ms => { real += ms; live.clock(); };
  step(4_000);
  const j = live.testPlay.join(nation);
  if (!j?.ok) throw new Error(`join: ${JSON.stringify(j)}`);
  const start = live.summary(), T0 = start.turn, t0 = real;
  const events = [];
  let lastHolders = null, orders = 0, refused = {};
  const pst = { quota: 38, used: 0, day1: 144, built: new Set(), dest: new Map(), far: new Set() };
  const me = () => live.summary().me;
  const ord = (name, d, pv) => { const r = live.order(name, d, pv); if (r.ok) orders++; else refused[`${name}:${r.code}`] = (refused[`${name}:${r.code}`] ?? 0) + 1; return r; };
  for (let k = 0; k < turns; k++) {
    step(TURN_SECS * 1000 * 0.5);           // mid-turn: after the turn's resolve and the neighbours' orders
    const s = live.summary(), g = s.goal, b = s.turn;
    const holders = g.castles.map(c => c.holder);
    if (lastHolders) g.castles.forEach((c, i) => { if (holders[i] !== lastHolders[i]) events.push({ turn: b - T0, castle: NAMES[c.nation], from: lastHolders[i] === null ? '-' : NAMES[lastHolders[i]], to: c.holder === null ? '-' : NAMES[c.holder] }); });
    lastHolders = holders;
    if (g.result) {
      return { nation: NAMES[nation], strategy, result: g.result.state, by: g.result.nations.map(n => NAMES[n]).join('+'), turns: g.result.bell - g.posted, realMin: ((g.result.bell - g.posted) * TURN_SECS / 60).toFixed(1), orders, refused, events, waves: live.goalLog().filter(x => x.kind === 'wave') };
    }
    play(live, s, ord, strategy, pst);
    step(TURN_SECS * 1000 * 0.5);
  }
  const g = live.goal();
  return { nation: NAMES[nation], strategy, result: 'none', turns, realMin: (turns * TURN_SECS / 60).toFixed(1), orders, refused, events, progress: g.progress.map(x => `${NAMES[x.nation]}:${x.captured}/${x.capturedLong}`).join(' '), waves: live.goalLog().filter(x => x.kind === 'wave') };
}

/**
 * The scripted player (what a first-time player can do from the page): a farm, an ore mine and a gold mine first, then
 * train what the stores pay for, form hosts, march on the rival castle whose standing defenders it outnumbers (nearest
 * first), keep a host on what it took and send reinforcements when one is attacked. It spends at most the relay's
 * quota (38 orders, +40 at the game day's turn).
 */
function play(live, s, ord, strategy, st) {
  const m = s.me, g = s.goal, b = s.turn;
  if (!m) return;
  const quota = () => st.quota + (b >= st.day1 ? 40 : 0) - st.used;
  const go = (name, d, pv) => { if (quota() < 1) return { ok: false, code: 'Quota' }; const r = ord(name, d, pv); if (r.ok) st.used++; return r; };
  if (strategy === 'idle') return;
  for (const [i, item] of [0, 3, 0].entries()) if (!st.built.has(i) && go('Build', { item }, { p: m.village[0], q: m.village[1] }).ok) st.built.add(i);
  // train: the most Spearmen the stores pay for (a hundred at a time), when at least 200 are affordable
  for (const n of [1000, 800, 600, 400, 300, 200]) if (go('Train', { unit: 0, n }, null).ok) break;
  const reserve = live.summary().me.reserve[0];
  if (reserve >= 200) go('Muster', { unit: 0, troops: Math.min(reserve, 30_000), tile: m.tile }, { p: m.village[0], q: m.village[1] });
  if (process.env.DEBUG && b % 3 === 0) console.log(`    t${b} res ${JSON.stringify(live.summary().me.stores.slice(0,6))} reserve ${live.summary().me.reserve[0]} hosts ${JSON.stringify(live.summary().me.hosts.map(h => [h.troops, h.province.join(','), h.tile, h.stamina, h.state, h.readyBell]))}`);
  if (strategy === 'turtle') return;
  const mine = g.player, home = tileHex(m.village[0], m.village[1], m.tile);
  const standing = c => live.province(c.p, c.q).entries.filter(e => e.state === 1 && e.tile === c.tile);
  const foes = c => standing(c).filter(e => e.faction !== mine).reduce((a, e) => a + Math.floor(e.troops / 1000), 0);
  const ours = c => standing(c).filter(e => e.faction === mine).reduce((a, e) => a + Math.floor(e.troops / 1000), 0);
  const onCastle = h => g.castles.find(c => c.p === h.province[0] && c.q === h.province[1] && c.tile === h.tile);
  const ready = m.hosts.filter(h => h.state === 1 && h.unit === 0 && h.stamina >= 74 && h.readyBell <= b && !m.marches.some(x => x.host === h.id) && h.troops >= 100 && !onCastle(h))
    .sort((a, b2) => b2.troops - a.troops);
  const d = c => { const h = tileHex(c.p, c.q, c.tile); return hexDistance(h.q, h.r, home.q, home.r); };
  const coming = c => m.marches.filter(x => st.dest.get(x.host) === `${c.p},${c.q},${c.tile}`).length;
  // defend: a castle of ours with fewer than 150 of ours standing and nothing on its way; then attack what we outnumber
  const defend = g.castles.filter(c => c.holder === mine && c.nation !== mine && ours(c) < 150 && !coming(c));
  const attack = g.castles.filter(c => c.nation !== mine && c.holder !== mine && !coming(c) && !st.far.has(`${c.p},${c.q}`)).sort((a, c) => d(a) - d(c));
  const send = (h, c) => {
    if (quota() < 1) return false;
    const r = live.testPlay.march(h.id, { p: c.p, q: c.q, tile: c.tile });
    if (r.ok) { st.used++; st.dest.set(h.id, `${c.p},${c.q},${c.tile}`); } else if (r.code === 'Path') st.far.add(`${c.p},${c.q}`);
    if (process.env.DEBUG) console.log(`      t${b} march ${h.troops} → ${c.p},${c.q}/${c.tile} (foes ${foes(c)}): ${r.ok ? `arrive ${r.arrive}` : r.code}`);
    return r.ok;
  };
  const pool = [...ready];
  for (const c of defend) { const h = pool.shift(); if (!h) break; send(h, c); }
  // attack: the nearest rival castle the ready hosts together outnumber (1.3 × its standing defenders + 50), all at once
  for (const c of attack) {
    const want = foes(c) * 1.3 + 50, total = pool.reduce((a, h) => a + h.troops, 0);
    if (total < want) continue;
    let sent = 0;
    while (sent < want && pool.length) { const h = pool.shift(); if (send(h, c)) sent += h.troops; }
    break;
  }
}

const strategies = opt.strategy === 'all' ? ['active', 'idle'] : opt.strategy.split(',');
const nations = opt.nation === 'all' ? [0, 1, 2, 3, 4, 5] : opt.nation.split(',').map(Number);
const out = [];
let n = 0;
for (const strategy of strategies) for (const nation of nations) {
  if (n++ >= Number(opt.games) * strategies.length) break;
  const t = Date.now();
  const r = await game({ nation, strategy, turns: Number(opt.turns) });
  out.push(r);
  const waves = r.waves.filter(w => w.ok);
  console.log(`${r.strategy.padEnd(6)} ${r.nation.padEnd(8)} → ${r.result.padEnd(4)} ${r.by ? `(${r.by}) ` : ''}after ${r.turns} turns = ${r.realMin} min; player orders ${r.orders}; castle changes ${r.events.length}; AI wave marches ${waves.length} (raids on player ${waves.filter(w => w.target === 'raid').length}); ${r.progress ?? ''} [${((Date.now() - t) / 1000).toFixed(0)} s]`);
  if (opt.log) { for (const e of r.events) console.log(`    t+${e.turn}: ${e.castle}'s castle ${e.from} → ${e.to}`); console.log(`    refused ${JSON.stringify(r.refused)}`); }
}
if (opt.json) (await import('node:fs')).writeFileSync(opt.json, JSON.stringify(out, null, 1));
