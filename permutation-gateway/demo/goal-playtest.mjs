#!/usr/bin/env node
// Headless playtests of the demo's single-player goal (demogoal.mjs, liveworld `goal`) in Node: the very world the
// page plays (same rules kernel, same seed), on a hand-moved clock, with a scripted player. No browser, no server, no
// key (the keyless viewer; the player's orders go through the world's own instructions: liveworld `order` and
// `testPlay`). Prints one line per game and, with --log, the castles' changes and the waves.
//
//   node goal-playtest.mjs [--games 5] [--strategy active|human|normal|slow|thin|careful|idle|turtle|all] [--nation 0..5|all] [--turns 200]
//                          [--seeds 1,2,3] [--log] [--set key=value,...]   (DEMO_GOAL overrides, e.g. --set holdBells=12,waveEvery=6)
// 'normal' and 'slow' are human-paced players (demo-goal-polish-1): they start late (picking a nation, reading the guide),
// look at the game only every few turns (jittered by --seeds), do at most 3 orders a look and attack the NEAREST castle
// they outnumber (not the best one). The game length is tuned on 'normal' (target 15–20 min = 75–100 turns at 12 s).
// 'thin' and 'careful' (demo-dgp1-waves, Q-DGP-1) play at the 'normal' pace but keep 150 troops on a castle they took,
// or twice the card's "next wave ≈ N" (the late AI waves are tuned so that no game of the three is left without a result).
import { parseArgs } from 'node:util';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import { TILE_OFFSETS, tileHex, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';

const { values: opt } = parseArgs({ strict: false, args: import.meta.url === `file://${process.argv[1]}` ? process.argv.slice(2) : [], options: {
  games: { type: 'string', default: '6' }, strategy: { type: 'string', default: 'all' }, nation: { type: 'string', default: 'all' },
  turns: { type: 'string', default: '220' }, seeds: { type: 'string', default: '1' }, log: { type: 'boolean', default: false }, set: { type: 'string', default: '' }, json: { type: 'string' },
} });
const over = Object.fromEntries(opt.set.split(',').filter(Boolean).map(kv => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
const TURN_SECS = 12;
const NAMES = ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'];

/** The human-paced players' timing: [first look (turns after the village), [min, max] turns between two looks]. */
export const PACE = { normal: [12, [3, 6]], slow: [18, [5, 8]], thin: [12, [3, 6]], careful: [12, [3, 6]] };
/** The troops a human-paced player keeps on each castle it took, from the card's next wave (default: × 1.25). */
const GUARD = { thin: () => 150, careful: w => Math.max(150, Math.round(w * 2)) };

export async function game({ nation, strategy, turns, set = over, seed = 1 }) {
  let real = 1_000_000;
  const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true,
    turn: TURN_SECS, delay: 3, landMs: 400, wall: () => real, goal: Object.keys(set).length ? set : true });
  live.seen();
  const step = ms => { real += ms; live.clock(); };
  step(4_000);
  const j = live.testPlay.join(nation);
  if (!j?.ok) throw new Error(`join: ${JSON.stringify(j)}`);
  const start = live.summary(), T0 = start.turn, t0 = real;
  const events = [];
  let lastHolders = null, orders = 0, refused = {};
  const pst = { quota: 38, used: 0, day1: 144, built: new Set(), dest: new Map(), far: new Set(), t0: T0, rnd: rng(seed * 7919 + nation * 104729 + 17), next: null };
  const me = () => live.summary().me;
  const ord = (name, d, pv) => { const r = live.order(name, d, pv); if (r.ok) orders++; else refused[`${name}:${r.code}`] = (refused[`${name}:${r.code}`] ?? 0) + 1; return r; };
  for (let k = 0; k < turns; k++) {
    step(TURN_SECS * 1000 * 0.5);           // mid-turn: after the turn's resolve and the neighbours' orders
    const s = live.summary(), g = s.goal, b = s.turn;
    const holders = g.castles.map(c => c.holder);
    if (lastHolders) g.castles.forEach((c, i) => { if (holders[i] !== lastHolders[i]) events.push({ turn: b - T0, castle: NAMES[c.nation], from: lastHolders[i] === null ? '-' : NAMES[lastHolders[i]], to: c.holder === null ? '-' : NAMES[c.holder] }); });
    lastHolders = holders;
    if (g.result) {
      return { nation: NAMES[nation], strategy, seed, result: g.result.state, by: g.result.nations.map(n => NAMES[n]).join('+'), turns: g.result.bell - g.posted, realMin: ((g.result.bell - g.posted) * TURN_SECS / 60).toFixed(1), orders, refused, events, waves: live.goalLog().filter(x => x.kind === 'wave') };
    }
    play(live, s, ord, strategy, pst);
    step(TURN_SECS * 1000 * 0.5);
  }
  const g = live.goal();
  return { nation: NAMES[nation], strategy, seed, result: 'none', turns, realMin: (turns * TURN_SECS / 60).toFixed(1), orders, refused, events, progress: g.progress.map(x => `${NAMES[x.nation]}:${x.captured}/${x.capturedLong}`).join(' '), waves: live.goalLog().filter(x => x.kind === 'wave') };
}

/**
 * The scripted player (what a first-time player can do from the page): a farm, an ore mine and a gold mine first, then
 * train what the stores pay for, form hosts, march on the rival castle whose standing defenders it outnumbers (nearest
 * first), keep a host on what it took and send reinforcements when one is attacked. It spends at most the relay's
 * quota (38 orders, +40 at the game day's turn).
 */
/** A small deterministic generator (mulberry32) for the human-paced players' jitter. */
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function play(live, s, ord, strategy, st) {
  const m = s.me, g = s.goal, b = s.turn;
  if (!m) return;
  const quota = () => st.quota + (b >= st.day1 ? 40 : 0) - st.used;
  let looks = Infinity;
  const pace = PACE[strategy];
  if (pace) {
    // a human-paced look: the first after `pace[0]` turns (±3), then every pace[1] turns; at most 3 orders a look
    if (st.next === null) st.next = st.t0 + pace[0] + Math.floor(st.rnd() * 7) - 3;
    if (b < st.next) return;
    st.next = b + pace[1][0] + Math.floor(st.rnd() * (pace[1][1] - pace[1][0] + 1));
    looks = 3;
  }
  const go = (name, d, pv) => { if (quota() < 1 || looks < 1) return { ok: false, code: 'Quota' }; const r = ord(name, d, pv); if (r.ok) { st.used++; looks--; } return r; };
  if (strategy === 'idle') return;
  // 'human': a first-time player — starts 6 turns late (reading the page) and acts every third turn
  if (strategy === 'human' && (b - st.t0 < 6 || (b - st.t0) % 3 !== 0)) return;
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
  // (a human-paced player reads the card's "next wave: about N troops a host" and keeps that much and a quarter more on
  //  each castle it took)
  const guard = GUARD[strategy] ? GUARD[strategy](g.waveTroops ?? 0) : pace ? Math.max(150, Math.round((g.waveTroops ?? 0) * 1.25)) : 150;
  const defend = g.castles.filter(c => c.holder === mine && c.nation !== mine && ours(c) < guard && !coming(c));
  const attack = g.castles.filter(c => c.nation !== mine && c.holder !== mine && !coming(c) && !st.far.has(`${c.p},${c.q}`)).sort((a, c) => d(a) - d(c));
  const send = (h, c) => {
    if (quota() < 1 || looks < 1) return false;
    const r = live.testPlay.march(h.id, { p: c.p, q: c.q, tile: c.tile });
    if (r.ok) { st.used++; looks--; st.dest.set(h.id, `${c.p},${c.q},${c.tile}`); } else if (r.code === 'Path') st.far.add(`${c.p},${c.q}`);
    if (process.env.DEBUG) console.log(`      t${b} march ${h.troops} → ${c.p},${c.q}/${c.tile} (foes ${foes(c)}): ${r.ok ? `arrive ${r.arrive}` : r.code}`);
    return r.ok;
  };
  const pool = [...ready];
  for (const c of defend) {
    if (!pace) { const h = pool.shift(); if (!h) break; send(h, c); continue; }
    let sent = ours(c);
    while (sent < guard && pool.length) { const h = pool.shift(); if (send(h, c)) sent += h.troops; }
  }
  // attack: the nearest rival castle the ready hosts together outnumber (1.3 × its standing defenders + 50), all at once
  for (const c of attack) {
    const want = pace ? foes(c) * 1.15 + 20 : foes(c) * 1.3 + 50, total = pool.reduce((a, h) => a + h.troops, 0);
    if (total < want) continue;
    let sent = 0;
    while (sent < want && pool.length) { const h = pool.shift(); if (send(h, c)) sent += h.troops; }
    break;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

async function main() {
  const strategies = opt.strategy === 'all' ? ['active', 'idle'] : opt.strategy.split(',');
  const nations = opt.nation === 'all' ? [0, 1, 2, 3, 4, 5] : opt.nation.split(',').map(Number);
  const seeds = opt.seeds.split(',').map(Number);
  const out = [];
  let n = 0;
  for (const strategy of strategies) for (const seed of seeds) for (const nation of nations.slice(0, Number(opt.games))) {
    n++;
    const t = Date.now();
    const r = await game({ nation, strategy, turns: Number(opt.turns), seed });
    out.push(r);
    const waves = r.waves.filter(w => w.ok);
    console.log(`${r.strategy.padEnd(6)} s${seed} ${r.nation.padEnd(8)} → ${r.result.padEnd(4)} ${r.by ? `(${r.by}) ` : ''}after ${r.turns} turns = ${r.realMin} min; player orders ${r.orders}; castle changes ${r.events.length}; AI wave marches ${waves.length} (raids on player ${waves.filter(w => w.target === 'raid').length}); ${r.progress ?? ''} [${((Date.now() - t) / 1000).toFixed(0)} s]`);
    if (opt.log) { for (const e of r.events) console.log(`    t+${e.turn}: ${e.castle}'s castle ${e.from} → ${e.to}`); console.log(`    refused ${JSON.stringify(r.refused)}`); }
  }
  if (opt.json) (await import('node:fs')).writeFileSync(opt.json, JSON.stringify(out, null, 1));
}
