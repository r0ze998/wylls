#!/usr/bin/env node
// Runs every experiment on the same seeds for every proposal (paired) and
// writes results/summary.json, results/RESULTS.md and a per-seed CSV of the
// main comparison.
//
//   node run.mjs                 # all experiment groups, 30 seeds
//   node run.mjs --seeds 5       # quick
//   node run.mjs --only core     # core | exploits | sensitivity | retention
//   node run.mjs --out DIR --first-seed 101

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE } from './params.mjs';
import { PROPOSALS } from './proposals.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { run } from './world.mjs';
import * as M from './metrics.mjs';
import { mean, median, shareWithin, summarize } from './stats.mjs';
import { pairedSummary } from './paired.mjs';
import { renderMarkdown, HEADLINE } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function withOverrides(proposal, P) {
  const p = structuredClone(proposal);
  if (P.protectionOverride !== undefined && P.protectionOverride !== null) {
    p.newcomer.protectionH = P.protectionOverride;
    p.newcomer.lateExtraH = 0;
  }
  // levers that only exist where the world continues across the cut (B1, B2)
  if (p.boundary === 'reset_war') {
    if (P.demobOverride !== undefined && p.id === 'B2') p.demobilize = P.demobOverride;
    if (P.demobRefundOverride !== undefined && p.id === 'B2') p.demobRefund = P.demobRefundOverride;
    if (P.theaterOverride !== undefined) p.forts.rotateTheater = P.theaterOverride;
    if (P.fortStockOverride !== undefined) p.rights.fortSupply = P.fortStockOverride;
  }
  if (P.upkeepOverride === 'off') p.upkeep = null;
  if (P.upkeepOverride === 'on') p.upkeep = { freeFarms: 8, rate: 0.8, exp: 1.5 };
  return p;
}

/** One world → the scalar measurements used everywhere (definitions: ../09-metrics.ja.md). */
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
  const ex = M.exposure(w);
  for (const k of ['1', '2', '4', '12']) {
    out[`expo.rate${k}`] = ex[k]?.rate ?? NaN;
    out[`expo.per${k}`] = ex[k]?.perExposed ?? NaN;
  }
  const rt = M.rights(w);
  for (const [k, v] of Object.entries(rt)) out[`rights.${k}`] = v;
  const ret = M.retention(w);
  for (const [k, v] of Object.entries(ret)) out[`ret.${k}`] = v;
  const dm = M.demobImpact(w);
  for (const [k, v] of Object.entries(dm)) out[`demob.${k}`] = v;
  out['events.organicDefeats'] = M.organicDefeats(w);
  out['events.quits'] = w.events.quits;
  if (w.scenario.focusNation !== undefined) out['focus.share'] = M.nationShare(w, w.scenario.focusNation);
  if (w.scenario.id === 'proxy') for (const [k, v] of Object.entries(M.proxies(w))) out[`proxy.${k}`] = v;
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
    out['x.altCostPaid'] = mean(w.agents.filter((a) => a.cohort === 'alt').map((a) => a.altCostPaid || 0));
    out['x.altFounded'] = mean(w.agents.filter((a) => a.cohort === 'alt').map((a) => (a.joinT !== null ? 1 : 0)));
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

export function experiment(name, scenarioId, overrides, seeds, measureFn = measure, only = null) {
  const P = { ...BASE, ...overrides };
  const res = {};
  for (const [pid, prop] of Object.entries(PROPOSALS)) {
    if (only && !only.includes(pid)) continue;
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

// Pairs reported with their per-seed difference distribution (first minus second).
export const PAIRS = [
  ['B2', 'A'],
  ['B2', 'B1'],
  ['B1', 'P0'],
  ['B2', 'P0'],
  ['A', 'P0'],
  ['C', 'B2'],
];

export function paired(e, keys) {
  const out = {};
  for (const [x, y] of PAIRS) {
    if (!e.res[x] || !e.res[y]) continue;
    for (const k of keys) {
      if (!e.res[x][k]) continue;
      out[`${x}-${y}:${k}`] = pairedSummary(e.res[x][k].raw, e.res[y][k].raw, `${e.name}:${x}-${y}:${k}`);
    }
  }
  return out;
}

// The rule for "A overtakes B2" in the leaving-and-returning grid. Written down in the code
// before the grid was run (2026-10-30), so the tolerances could not be tuned to its outcome.
// A metric counts against B2 when the mean paired difference (B2 - A) is beyond the tolerance in
// A's favour AND the 95 % bootstrap interval excludes zero.
export const REVERSAL_RULE = [
  { key: 'conc.winnerRepeat', worse: 'higher', tol: 0.1, label: '首位の連続率' },
  { key: 'conc.bottomNextShare', worse: 'lower', tol: 0.03, label: '最下位国の次単位シェア' },
  { key: 'ret.newcomers', worse: 'lower', tol: 0.1, label: '途中・終盤参加者の継続率' },
  { key: 'ret.humans', worse: 'lower', tol: 0.1, label: '人間全体の継続率' },
  { key: 'mid.contrib7dRel', worse: 'lower', tol: 0.1, label: '途中参加の7日貢献比' },
];

export function reversal(e) {
  const flags = [];
  for (const r of REVERSAL_RULE) {
    if (!e.res.B2?.[r.key] || !e.res.A?.[r.key]) continue;
    const s = pairedSummary(e.res.B2[r.key].raw, e.res.A[r.key].raw, `${e.name}:rev:${r.key}`);
    const against = r.worse === 'higher' ? s.mean > r.tol && s.lo > 0 : s.mean < -r.tol && s.hi < 0;
    flags.push({ ...r, ...s, against });
  }
  return flags;
}

// Leaving, coming back and playing less. Nothing here is measured: each family is a different
// assumption about why people leave, so a conclusion that holds in only one family is an artefact of it.
//   none      – nobody leaves except on defeat (qd)
//   flat      – everyone has the same 1 %/day chance to leave, whatever happens to them
//   rel05/15  – leaving grows with how far the village is below the median human village
//   dec05/15  – leaving grows with how far the village is below its own best in this unit (losses, not rank)
//   dec15k    – as dec15, but a world reset (P0, A) counts as the person's own loss
// Playing less (halving sessions) uses the same gap and rate as leaving.
const QUIT_FAMILIES = {
  none: { quitBase: 0, quitHazard: 0, freqDrop: 0 },
  flat: { quitBase: 0.01, quitHazard: 0, freqDrop: 0 },
  rel05: { quitModel: 'relative', quitHazard: 0.05, freqDrop: 0.05 },
  rel15: { quitModel: 'relative', quitHazard: 0.15, freqDrop: 0.15 },
  dec05: { quitModel: 'decline', quitHazard: 0.05, freqDrop: 0.05 },
  dec15: { quitModel: 'decline', quitHazard: 0.15, freqDrop: 0.15 },
  dec15k: { quitModel: 'decline', quitHazard: 0.15, freqDrop: 0.15, quitPeakAcrossResets: true },
};
const RETENTION_GRID = (() => {
  const list = [];
  for (const [fam, ov] of Object.entries(QUIT_FAMILIES)) {
    for (const q of [0, 0.25, 0.5]) {
      for (const r of [0, 0.5]) list.push([`ret/${fam}/qd${q}/r${r}`, 'standard', { ...ov, quitOnDefeat: q, returnProb: r }]);
    }
  }
  return list;
})();

export const EXPERIMENTS = {
  core: () => {
    const list = [];
    for (const mix of ['mixed', 'coop', 'raider']) {
      for (const sc of ['standard', 'small_nation', 'ai_heavy', 'dominant']) list.push([`core/${sc}/${mix}`, sc, { behaviourMix: mix }]);
    }
    list.push(['core/proxy/mixed', 'proxy', {}]);
    return list;
  },
  exploits: () => [
    ['exploit/alts', 'alts', {}],
    ['exploit/alts_control', 'alts_control', {}],
    ['exploit/alts+receiptEnds', 'alts', { receiptEndsProtection: true }],
    ['exploit/alts_none', 'alts_none', {}],
    ['exploit/alts_split', 'alts_split', {}],
    ['exploit/alts_ai', 'alts_ai', {}],
    ['exploit/alts_control+cost300', 'alts_control', { altFoundCost: 300 }],
    ['exploit/alts_control+cost1000', 'alts_control', { altFoundCost: 1000 }],
    ['exploit/alts_control+cost3000', 'alts_control', { altFoundCost: 3000 }],
    ['exploit/alts_split+cost1000', 'alts_split', { altFoundCost: 1000 }],
    ['exploit/alts_ai+cost1000', 'alts_ai', { altFoundCost: 1000 }],
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
    ['sens/upkeepOnAll', 'standard', { upkeepOverride: 'on' }],
    ['sens/B2-demob1', 'standard', { demobOverride: 1 }],
    ['sens/B2-demob4', 'standard', { demobOverride: 4 }],
    ['sens/B2-refund50', 'standard', { demobRefundOverride: 0.5 }],
    ['sens/rush48', 'standard', { rushHours: 48 }],
    ['sens/rush48/dominant', 'dominant', { rushHours: 48 }],
    ['sens/B-stock-return', 'standard', { fortStockOverride: 'return' }],
    ['sens/B-stock-stay', 'standard', { fortStockOverride: 'stay' }],
    ['sens/B-stock-destroy', 'standard', { fortStockOverride: 'destroy' }],
    ['sens/B-theater-random', 'standard', { theaterOverride: true }],
    ['sens/B-theater-underdog', 'standard', { theaterOverride: 'underdog' }],
    ['sens/B-theater-underdog/dominant', 'dominant', { theaterOverride: 'underdog' }],
    ['sens/window3', 'standard', { opWindowHours: 3 }],
    ['sens/window12', 'standard', { opWindowHours: 12 }],
    ['sens/standingOrders', 'standard', { standingOrders: true }],
    ['sens/cap24', 'standard', { collectCapHours: 24 }],
    ['sens/jitter0', 'standard', { sessionJitter: 0 }],
    ['sens/skip0', 'standard', { sessionSkip: 0 }],
    ['sens/raid0.5', 'standard', { raidPower: 0.5 }],
    ['sens/raid2', 'standard', { raidPower: 2 }],
    ['sens/ai8', 'standard', { aiActsPerDay: 8 }],
    ['sens/bandwagon', 'standard', { newcomerNation: 'bandwagon', switchProb: 0.3 }],
    ['sens/balanced', 'standard', { newcomerNation: 'balanced' }],
    ['sens/farmGrowth1.2', 'standard', { farmCostGrowth: 1.2 }],
    ['sens/raider+raid2', 'standard', { behaviourMix: 'raider', raidPower: 2 }],
  ],
  retention: () => RETENTION_GRID,
};

export const PAIRED_KEYS = HEADLINE.filter((h) => h[2]).map((h) => h[0]).concat(['ret.humans', 'ret.newcomers', 'ret.defeated']);

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

const CSV_KEYS = ['mid.firstOpH', 'mid.contrib7dRel', 'late.firstOpH', 'defeated.lostFrac', 'defeated.toContribH', 'defeated.to50H', 'returner.lossFrac', 'returner.toContribH', 'conc.lastGini', 'conc.winnerRepeat', 'conc.firstWinnerLaterShare', 'conc.bottomNextShare', 'conc.distinctWinners', 'conn.rel1', 'conn.rel2', 'conn.rel4', 'expo.rate1', 'expo.rate2', 'expo.rate12', 'rights.voided', 'rights.returned'];

function perSeedCsv(e, seeds) {
  const rows = ['experiment,proposal,seed,metric,value'];
  for (const [p, m] of Object.entries(e.res)) {
    for (const k of CSV_KEYS) {
      if (!m[k]) continue;
      m[k].raw.forEach((v, i) => rows.push(`${e.name},${p},${seeds[i]},${k},${Number.isFinite(Number(v)) ? Number(v).toFixed(4) : String(v)}`));
    }
  }
  return rows.join('\n') + '\n';
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
      const e = { group, ...experiment(name, sc, ov, seeds, fn) };
      e.paired = paired(e, PAIRED_KEYS);
      if (group === 'retention' || name === 'core/standard/mixed' || group === 'sensitivity') e.reversal = reversal(e);
      all.push(e);
      process.stderr.write(`${name} done (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
    }
  }
  mkdirSync(o.out, { recursive: true });
  const meta = { seeds: seeds.length, firstSeed: o.firstSeed, base: BASE, proposals: PROPOSALS, reversalRule: REVERSAL_RULE, generatedBy: 'node run.mjs ' + process.argv.slice(2).join(' ') };
  const slim = all.map((e) => ({ ...e, res: Object.fromEntries(Object.entries(e.res).map(([p, m]) => [p, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, raw: undefined }]))])) }));
  const round = (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
  writeFileSync(join(o.out, 'summary.json'), JSON.stringify({ meta, experiments: slim }, round));
  writeFileSync(join(o.out, 'RESULTS.md'), renderMarkdown(meta, all));
  const main = all.find((e) => e.name === 'core/standard/mixed');
  if (main) writeFileSync(join(o.out, 'per-seed-core-standard-mixed.csv'), perSeedCsv(main, seeds));
  process.stderr.write(`wrote ${o.out}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
