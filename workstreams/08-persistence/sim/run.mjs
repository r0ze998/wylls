#!/usr/bin/env node
// Runs every experiment on the same seeds for every proposal (paired) and
// writes results/summary.json and results/RESULTS.md.
//
//   node run.mjs                 # all experiments, 30 seeds
//   node run.mjs --seeds 5       # quick
//   node run.mjs --only core     # core | exploits | sensitivity
//   node run.mjs --out DIR

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE } from './params.mjs';
import { PROPOSALS } from './proposals.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { run } from './world.mjs';
import * as M from './metrics.mjs';
import { mean, median, shareWithin, summarize } from './stats.mjs';
import { renderMarkdown } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function withOverrides(proposal, P) {
  const p = structuredClone(proposal);
  if (P.protectionOverride !== undefined && P.protectionOverride !== null) {
    p.newcomer.protectionH = P.protectionOverride;
    p.newcomer.lateExtraH = 0;
  }
  if (P.demobOverride !== undefined && p.boundary === 'reset_war') p.demobilize = P.demobOverride;
  if (P.theaterOverride !== undefined && p.boundary === 'reset_war') p.forts.rotateTheater = P.theaterOverride;
    if (P.upkeepOverride === 'off') p.upkeep = null;
  if (P.upkeepOverride === 'on') p.upkeep = { freeFarms: 8, rate: 0.8, exp: 1.5 };
  return p;
}

/** One world → the scalar measurements used everywhere. */
export function measure(w) {
  const U = w.periodLen;
  const out = {};
  for (const c of ['mid', 'late']) {
    const xs = M.newcomers(w, c);
    const ref = M.day1Contrib7d(w, xs.length ? w.agents.find((a) => a.cohort === c).plannedJoinT : U);
    out[`${c}.firstOpH`] = median(xs.map((x) => x.firstOpH));
    out[`${c}.within24`] = shareWithin(xs.map((x) => x.firstOpH), 24);
    out[`${c}.within72`] = shareWithin(xs.map((x) => x.firstOpH), 72);
    out[`${c}.waitToFoundH`] = median(xs.map((x) => x.waitToFoundH));
    out[`${c}.kinds24`] = mean(xs.map((x) => x.kinds24));
    out[`${c}.contrib7dRel`] = ref > 0 ? mean(xs.map((x) => x.contrib7d)) / ref : NaN;
  }
  const d = M.defeats(w);
  out['defeated.lostFrac'] = mean(d.map((x) => x.lostFrac));
  out['defeated.toContribH'] = median(d.map((x) => x.toContribH));
  out['defeated.to50H'] = median(d.map((x) => x.to50H));
  out['defeated.contribWithin72'] = shareWithin(d.map((x) => x.toContribH), 72);
  const r = M.returners(w);
  out['returner.lossFrac'] = mean(r.map((x) => x.lossFrac));
  out['returner.farmsKept'] = mean(r.map((x) => x.farmsKept));
  out['returner.defeatedAway'] = mean(r.map((x) => x.defeatedWhileAway));
  out['returner.toContribH'] = median(r.map((x) => x.toContribH));
  const c = M.concentration(w);
  for (const [k, v] of Object.entries(c)) out[`conc.${k}`] = v;
  const con = M.connection(w);
  out['conn.relAI'] = con.ai?.rel ?? NaN;
  for (const k of ['1', '2', '3', '4', '6', '12']) {
    out[`conn.rel${k}`] = con[k]?.rel ?? NaN;
    out[`conn.raided${k}`] = con[k]?.raidedPerDay ?? NaN;
  }
  const rt = M.rights(w);
  for (const [k, v] of Object.entries(rt)) out[`rights.${k}`] = v;
  out['events.organicDefeats'] = M.organicDefeats(w);
  if (w.scenario.focusNation !== undefined) out['focus.share'] = M.nationShare(w, w.scenario.focusNation);
  return out;
}

function measureExploit(w, id) {
  const out = measure(w);
  if (id.startsWith('alts')) {
    const k = 1; // end of the second unit
    const ow = M.ownerWealth(w, 'abuser', k);
    out['x.ownerWealth'] = mean(ow);
    out['x.ownerRaided'] = mean(w.agents.filter((a) => a.cohort === 'abuser').map((a) => a.raidedLoss));
    out['x.altProtH'] = mean(w.agents.filter((a) => a.cohort === 'alt').map((a) => a.protectionHours));
  }
  if (id === 'churn' || id === 'churn_control') {
    const cs = M.churners(w);
    out['x.kits'] = mean(cs.map((x) => x.kits));
    out['x.protH'] = mean(cs.map((x) => x.protH));
    out['x.contrib'] = mean(cs.map((x) => x.contrib));
    out['x.endWealth'] = mean(cs.map((x) => x.endWealth));
  }
  if (id === 'feeder' || id === 'feeder_control') {
    const f = M.fed(w);
    out['x.fedWealth'] = f.wealth;
    out['x.fedRank'] = f.rank;
    out['x.fedFarms'] = f.farms;
  }
  if (id === 'kingmaker' || id === 'standard') {
    out['x.winnerShare'] = out['conc.meanWinnerShare'];
    out['x.winnerRepeat'] = out['conc.winnerRepeat'];
  }
  return out;
}

export function experiment(name, scenarioId, overrides, seeds, measureFn = measure) {
  const P = { ...BASE, ...overrides };
  const res = {};
  for (const [pid, prop] of Object.entries(PROPOSALS)) {
    const perSeed = [];
    for (const seed of seeds) {
      const w = run(P, withOverrides(prop, P), SCENARIOS[scenarioId], seed);
      perSeed.push(measureFn(w, scenarioId));
    }
    const keys = Object.keys(perSeed[0]);
    const agg = {};
    for (const k of keys) agg[k] = { ...summarize(perSeed.map((x) => x[k])), raw: perSeed.map((x) => x[k]) };
    res[pid] = agg;
  }
  return { name, scenario: scenarioId, overrides, seeds: seeds.length, res };
}

export const EXPERIMENTS = {
  core: () => {
    const list = [];
    for (const mix of ['mixed', 'coop', 'raider']) {
      for (const sc of ['standard', 'small_nation', 'ai_heavy', 'dominant']) list.push([`core/${sc}/${mix}`, sc, { behaviourMix: mix }]);
    }
    return list;
  },
  exploits: () => [
    ['exploit/alts', 'alts', {}],
    ['exploit/alts_control', 'alts_control', {}],
    ['exploit/alts+receiptEnds', 'alts', { receiptEndsProtection: true }],
    ['exploit/alts_none', 'alts_none', {}],
    ['exploit/churn', 'churn', {}],
    ['exploit/churn_control', 'churn_control', {}],
    ['exploit/kingmaker', 'kingmaker', {}],
    ['exploit/kingmaker_control', 'standard', {}],
    ['exploit/feeder', 'feeder', {}],
    ['exploit/feeder_control', 'feeder_control', {}],
    ['exploit/dominant+bandwagon', 'dominant', { newcomerNation: 'bandwagon', switchProb: 0.3 }],
  ],
  sensitivity: () => [
    ['sens/base', 'standard', {}],
    ['sens/period7', 'standard', { periodDays: 7, periods: 8 }],
    ['sens/period28', 'standard', { periodDays: 28, periods: 2 }],
    ['sens/protection0', 'standard', { protectionOverride: 0 }],
    ['sens/protection168', 'standard', { protectionOverride: 168 }],
    ['sens/upkeepOff', 'standard', { upkeepOverride: 'off' }],
    ['sens/B-noDemob', 'standard', { demobOverride: 0 }],
    ['sens/B-noDemob/dominant', 'dominant', { demobOverride: 0 }],
    ['sens/B-underdog', 'standard', { theaterOverride: 'underdog' }],
    ['sens/B-underdog/dominant', 'dominant', { theaterOverride: 'underdog' }],
    ['sens/upkeepOnAll', 'standard', { upkeepOverride: 'on' }],
    ['sens/window3', 'standard', { opWindowHours: 3 }],
    ['sens/window12', 'standard', { opWindowHours: 12 }],
    ['sens/standingOrders', 'standard', { standingOrders: true }],
    ['sens/cap24', 'standard', { collectCapHours: 24 }],
    ['sens/raid0.5', 'standard', { raidPower: 0.5 }],
    ['sens/raid2', 'standard', { raidPower: 2 }],
    ['sens/ai8', 'standard', { aiActsPerDay: 8 }],
    ['sens/bandwagon', 'standard', { newcomerNation: 'bandwagon', switchProb: 0.3 }],
    ['sens/balanced', 'standard', { newcomerNation: 'balanced' }],
    ['sens/farmGrowth1.2', 'standard', { farmCostGrowth: 1.2 }],
    ['sens/coop-raider', 'standard', { behaviourMix: 'raider', raidPower: 2 }],
  ],
};

function parseArgs(argv) {
  const o = { seeds: 30, only: null, out: join(here, '..', 'results'), firstSeed: 1 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--seeds') o.seeds = Number(argv[++i]);
    else if (argv[i] === '--only') o.only = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--first-seed') o.firstSeed = Number(argv[++i]);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv);
  const seeds = Array.from({ length: o.seeds }, (_, i) => o.firstSeed + i);
  const all = [];
  const t0 = Date.now();
  for (const [group, make] of Object.entries(EXPERIMENTS)) {
    if (o.only && o.only !== group) continue;
    for (const [name, sc, ov] of make()) {
      const fn = group === 'exploits' ? measureExploit : measure;
      all.push({ group, ...experiment(name, sc, ov, seeds, fn) });
      process.stderr.write(`${name} done (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
    }
  }
  mkdirSync(o.out, { recursive: true });
  const meta = { seeds: seeds.length, firstSeed: o.firstSeed, base: BASE, proposals: PROPOSALS, generatedBy: 'node run.mjs ' + process.argv.slice(2).join(' ') };
  const slim = all.map((e) => ({ ...e, res: Object.fromEntries(Object.entries(e.res).map(([p, m]) => [p, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, raw: undefined }]))])) }));
  writeFileSync(join(o.out, 'summary.json'), JSON.stringify({ meta, experiments: slim }, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v)));
  writeFileSync(join(o.out, 'RESULTS.md'), renderMarkdown(meta, all));
  process.stderr.write(`wrote ${o.out}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
