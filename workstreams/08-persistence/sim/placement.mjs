#!/usr/bin/env node
// The placement study (../16-placement.ja.md). Small, targeted cells instead of a full grid: in
// each condition every placement runs on the same seeds, so differences between placements are
// paired. The world-structure rule is fixed to B2 except in the interaction cells.
//
//   node placement.mjs                      # all cells, 30 seeds -> ../results/placement/
//   node placement.mjs --seeds 5 --only main
//   node placement.mjs --out DIR --first-seed 101
//
// Placement identifiers (not the world proposals A/B/C):
//   PL-W   clustered in the own wedge (the code's PlaceHome rule)            = 配置A
//   PL-Gk  groups of k villages of one nation, groups scattered              = 配置B
//   PL-S   every village scattered, nation ignored                           = 配置C

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE } from './params.mjs';
import { PROPOSALS } from './proposals.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { run } from './world.mjs';
import { measure } from './run.mjs';
import * as M from './metrics.mjs';
import { summarize, mean } from './stats.mjs';
import { pairedSummary } from './paired.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const PLACEMENTS = {
  'PL-W': { placement: 'PL-W' },
  'PL-G2': { placement: 'PL-G', group: 2, spread: 1 },
  'PL-G3': { placement: 'PL-G', group: 3, spread: 1 },
  'PL-G5': { placement: 'PL-G', group: 5, spread: 1 },
  'PL-G3s3': { placement: 'PL-G', group: 3, spread: 3 },
  'PL-S': { placement: 'PL-S', group: 1, spread: 0 },
};

const W_G3_S = ['PL-W', 'PL-G3', 'PL-S'];

// [condition id, label, overrides, world proposal, scenario, placements]
export const CELLS = {
  main: () => [
    ['dense', '本拠の範囲＝環2〜3（現行の中心地、密）、移動2h/州', { homeRingMax: 3 }, 'B2', 'standard', ['PL-W', 'PL-G2', 'PL-G3', 'PL-G5', 'PL-S']],
    ['sparse', '本拠の範囲＝環2〜5（疎）、移動2h/州', { homeRingMax: 5 }, 'B2', 'standard', ['PL-W', 'PL-G2', 'PL-G3', 'PL-G5', 'PL-G3s3', 'PL-S']],
  ],
  distance: () => [
    ['dense-h4', '密、移動4h/州', { homeRingMax: 3, hoursPerProvince: 4 }, 'B2', 'standard', W_G3_S],
    ['sparse-h1', '疎、移動1h/州', { homeRingMax: 5, hoursPerProvince: 1 }, 'B2', 'standard', W_G3_S],
    ['sparse-h4', '疎、移動4h/州', { homeRingMax: 5, hoursPerProvince: 4 }, 'B2', 'standard', W_G3_S],
    ['sparse-mid', '疎、目標を各国の正面（くさびの中央）に置く', { homeRingMax: 5, objectiveLayout: 'mid' }, 'B2', 'standard', W_G3_S],
    ['sparse-nohelp', '疎、隣の仲間の守りの助けなし', { homeRingMax: 5, allyHelp: 0 }, 'B2', 'standard', W_G3_S],
  ],
  populations: () => [
    ['sparse-small', '疎、少人数の国（国5は人3）', { homeRingMax: 5 }, 'B2', 'small_nation', W_G3_S],
    ['sparse-large', '疎、人数の多い国（国0は人+4・初期物資2倍）', { homeRingMax: 5 }, 'B2', 'dominant', W_G3_S],
    ['sparse-ai', '疎、AI の多い国（国5は人2・AI 8）', { homeRingMax: 5 }, 'B2', 'ai_heavy', W_G3_S],
  ],
  robustness: () => [
    ['sparse-rel05', '疎、他人との差でやめる（rel05、敗北で25%、半数が戻る）', { homeRingMax: 5, quitModel: 'relative', quitHazard: 0.05, freqDrop: 0.05, quitOnDefeat: 0.25, returnProb: 0.5 }, 'B2', 'standard', W_G3_S],
    ['sparse-dec15', '疎、自分の損でやめる（dec15、同上）', { homeRingMax: 5, quitModel: 'decline', quitHazard: 0.15, freqDrop: 0.15, quitOnDefeat: 0.25, returnProb: 0.5 }, 'B2', 'standard', W_G3_S],
    ['sparse-bandwagon', '疎、新人は勝っている国を選び、負けた人の30%が移る', { homeRingMax: 5, newcomerNation: 'bandwagon', switchProb: 0.3 }, 'B2', 'standard', W_G3_S],
    ['sparse-reroll', '疎、出現場所の引き直し（各国3人、6候補）', { homeRingMax: 5 }, 'B2', 'reroll', W_G3_S],
    ['sparse-reroll-ctl', '疎、対照（同じ3人が引き直さない）', { homeRingMax: 5 }, 'B2', 'reroll_control', W_G3_S],
    ['sparse-alts', '疎、別の村3つ（時間は無制限）', { homeRingMax: 5 }, 'B2', 'alts_control', W_G3_S],
    ['sparse-alts-none', '疎、対照（別の村なし）', { homeRingMax: 5 }, 'B2', 'alts_none', W_G3_S],
  ],
  localops: () => [
    ['dense-local', '密、局地の作戦（各目標に近い仲間が2人以上なら、その目標にも作戦を開く）', { homeRingMax: 3, opMode: 'local' }, 'B2', 'standard', W_G3_S],
    ['sparse-local', '疎、局地の作戦', { homeRingMax: 5, opMode: 'local' }, 'B2', 'standard', W_G3_S],
    ['sparse-h4-local', '疎、移動4h/州、局地の作戦', { homeRingMax: 5, hoursPerProvince: 4, opMode: 'local' }, 'B2', 'standard', W_G3_S],
    ['sparse-large-local', '疎、人数の多い国、局地の作戦', { homeRingMax: 5, opMode: 'local' }, 'B2', 'dominant', W_G3_S],
    ['sparse-C-local', '疎、世界の構造＝C、局地の作戦', { homeRingMax: 5, opMode: 'local' }, 'C', 'standard', W_G3_S],
  ],
  interaction: () => [
    ['sparse-P0', '疎、世界の構造＝P0（現行。単位ごとに配置し直す）', { homeRingMax: 5 }, 'P0', 'standard', W_G3_S],
    ['sparse-A', '疎、世界の構造＝A（単位ごとに配置し直す）', { homeRingMax: 5 }, 'A', 'standard', W_G3_S],
    ['sparse-B1', '疎、世界の構造＝B1', { homeRingMax: 5 }, 'B1', 'standard', W_G3_S],
    ['sparse-C', '疎、世界の構造＝C', { homeRingMax: 5 }, 'C', 'standard', W_G3_S],
  ],
};

export function measurePlacement(w) {
  const out = measure(w);
  for (const [k, v] of Object.entries(M.placement(w))) out[`pl.${k}`] = v;
  const rr = w.agents.filter((a) => a.rerollGroup);
  if (rr.length) {
    const days = w.horizon / 24;
    out['x.rrContrib'] = mean(rr.map((a) => a.contribValue / days));
    out['x.rrAllies1'] = mean(rr.filter((a) => a.snapshots.spawn).map((a) => a.snapshots.spawn.allies1));
    out['x.rrFortDist'] = mean(rr.filter((a) => a.snapshots.spawn).map((a) => a.snapshots.spawn.fortDist));
    out['x.rrWealth'] = mean(rr.map((a) => w.periodResults[w.P.periods - 1].wealthById[a.id] || 0));
  }
  if (w.scenario.id.startsWith('alts')) out['x.ownerWealth'] = mean(M.ownerWealth(w, 'abuser', 1));
  return out;
}

export function runCell([id, label, ov, pid, sc, pls], seeds) {
  const res = {};
  for (const pl of pls) {
    const P = { ...BASE, geo: true, ...PLACEMENTS[pl], ...ov };
    const per = seeds.map((seed) => measurePlacement(run(P, PROPOSALS[pid], SCENARIOS[sc], seed)));
    const agg = {};
    for (const k of Object.keys(per[0])) agg[k] = { ...summarize(per.map((x) => x[k])), raw: per.map((x) => x[k]) };
    res[pl] = agg;
  }
  const paired = {};
  const pairs = [];
  for (const a of pls) if (a !== 'PL-W' && pls.includes('PL-W')) pairs.push([a, 'PL-W']);
  if (pls.includes('PL-S') && pls.includes('PL-G3')) pairs.push(['PL-S', 'PL-G3']);
  for (const [x, y] of pairs) {
    for (const k of Object.keys(res[x])) {
      if (!res[y][k]) continue;
      paired[`${x}-${y}:${k}`] = pairedSummary(res[x][k].raw, res[y][k].raw, `${id}:${x}-${y}:${k}`);
    }
  }
  return { id, label, overrides: ov, proposal: pid, scenario: sc, placements: pls, pairs, res, paired };
}

export const KEYS = [
  ['pl.nearestAlly', '初期：最も近い仲間までの距離（州）'],
  ['pl.isolated1', '初期：隣接（距離1以内）に仲間がいない割合'],
  ['pl.isolated2', '初期：距離2以内に仲間がいない割合'],
  ['pl.allies1', '初期：距離1以内の仲間の数'],
  ['pl.enemies1', '初期：距離1以内の他国の村の数'],
  ['pl.otherNations1', '初期：距離1以内にいる他国の数（協力の相手の候補）'],
  ['pl.fortDist', '初期：最も近い目標までの距離（州）'],
  ['pl.fortDistSD', '初期の偏り：目標までの距離の人ごとのばらつき（標準偏差）'],
  ['pl.fortRoute', '初期：目標への道のうち他国の勢力下の割合'],
  ['pl.centreSD', '初期の偏り：中央までの距離のばらつき'],
  ['mid.firstOpH', '途中参加：最初の共同作戦まで (h)'],
  ['pl.firstAidDays', '初めて隣の仲間と守りあうまで（日、中央値）'],
  ['pl.aidShare', '期間中に一度でも守りあった人の割合'],
  ['pl.reachRate', '作戦の目標に、決着までに着ける割合'],
  ['pl.supplyHours', '補給の移動時間 (h)'],
  ['pl.supplyLossRate', '補給が途中で奪われた割合'],
  ['pl.corrFortContrib', '配置運：目標までの距離と貢献の相関（負＝近いほど貢献）'],
  ['pl.nearFarRatio', '配置運：目標に近い1/3の人の貢献 ÷ 遠い1/3の人'],
  ['pl.contribGini', '初日組の貢献の偏り（ジニ係数）'],
  ['conc.winnerRepeat', '国：前の首位国が再び首位'],
  ['conc.bottomNextShare', '国：最下位国の次の単位のシェア'],
  ['pl.nationShareSD', '国：砦シェアの国ごとのばらつき'],
  ['pl.nationShareMin', '国：最も弱い国の砦シェア'],
  ['focus.share', '注目国の砦シェア'],
  ['conc.lastGini', '資産のジニ係数'],
  ['mid.contrib7dRel', '途中参加：7日貢献比'],
  ['late.firstOpH', '終盤参加：最初の貢献まで (h)'],
  ['defeated.toContribH', '敗北→再び貢献 (h)'],
  ['returner.lossFrac', '10日不在：損失の割合'],
  ['returner.toContribH', '復帰→初貢献 (h)'],
  ['conn.rel1', '1日1回の人の貢献（1日12回＝1）'],
  ['ret.humans', '人間の継続率'],
  ['ret.newcomers', '新規の継続率'],
  ['x.rrContrib', '引き直し対象の3人：1日あたりの貢献'],
  ['x.rrAllies1', '引き直し対象の3人：初期の隣の仲間'],
  ['x.rrWealth', '引き直し対象の3人：最後の資産'],
  ['x.ownerWealth', '別の村を持つ本人の資産'],
];

function fmt(v) {
  if (v === undefined || v === null) return '—';
  const x = Number(v);
  if (Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return '∞';
  const a = Math.abs(x);
  return a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(2);
}
function sgn(v) {
  const s = fmt(v);
  return Number(v) > 0 ? '+' + s : s;
}

export const ACROSS = [
  ['sparse-reroll', 'sparse-reroll-ctl', ['x.rrContrib', 'x.rrAllies1', 'x.rrFortDist', 'x.rrWealth']],
  ['sparse-alts', 'sparse-alts-none', ['x.ownerWealth']],
];

export function render(meta, cells, across = []) {
  const out = ['# 配置の比較（自動生成）', ''];
  out.push(`生成：\`${meta.generatedBy}\`、seed ${meta.firstSeed}〜${meta.firstSeed + meta.seeds - 1}（${meta.seeds}本）。同じ条件の中では、全配置が同じ seed を使う（対になった比較）。`);
  out.push('');
  out.push('配置の記号：PL-W＝同国が自国のくさびにまとまる（現行の規則）、PL-Gk＝k人の小集団が散る（s3＝同国の集団どうしを3州以上離す）、PL-S＝国に関係なく散る。世界の構造の案（P0、A、B1、B2、C）とは別の記号。');
  out.push('値は seed ごとの値の平均 [10%点–90%点]。差は「左−右」の seed ごとの差：平均 [平均の95%ブートストラップ区間]、＊は区間が0を含まない。抽象モデルの値で、実プレイヤーの予測ではない。中央の塔の効果は入れていない。解釈は ../../16-placement.ja.md。');
  for (const c of cells) {
    out.push('', `## ${c.id}：${c.label}`, '', `世界の構造：${c.proposal}、人口：${c.scenario}`, '');
    out.push(`| 指標 | ${c.placements.join(' | ')} | ${c.pairs.map(([x, y]) => `${x}−${y}`).join(' | ')} |`);
    out.push(`|---|${c.placements.map(() => '---').join('|')}|${c.pairs.map(() => '---').join('|')}|`);
    for (const [k, label] of KEYS) {
      if (!c.res[c.placements[0]][k] || c.res[c.placements[0]][k].finite === 0) continue;
      const cells1 = c.placements.map((p) => {
        const s = c.res[p][k];
        return s.finite === 0 ? '∞' : `${fmt(s.mean)} [${fmt(s.p10)}–${fmt(s.p90)}]`;
      });
      const cells2 = c.pairs.map(([x, y]) => {
        const s = c.paired[`${x}-${y}:${k}`];
        if (!s || !s.n) return '—';
        return `${sgn(s.mean)}${s.lo > 0 || s.hi < 0 ? '＊' : ''} [${sgn(s.lo)}, ${sgn(s.hi)}]`;
      });
      out.push(`| ${label} | ${cells1.join(' | ')} | ${cells2.join(' | ')} |`);
    }
  }
  if (across.length) {
    out.push('', '## 悪用と対照（同じ配置・同じ seed の対）', '', '| 比較 | 配置 | 指標 | 悪用 | 対照 | 差 [95%] |', '|---|---|---|---|---|---|');
    for (const a of across) out.push(`| ${a.x} − ${a.y} | ${a.placement} | ${a.key} | ${fmt(a.mx)} | ${fmt(a.my)} | ${sgn(a.mean)}${a.lo > 0 || a.hi < 0 ? '＊' : ''} [${sgn(a.lo)}, ${sgn(a.hi)}] |`);
  }
  out.push('');
  return out.join('\n');
}

function parseArgs(argv) {
  const o = { seeds: 30, only: null, out: join(here, '..', 'results', 'placement'), firstSeed: 1 };
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
  const cells = [];
  const t0 = Date.now();
  for (const [group, make] of Object.entries(CELLS)) {
    if (o.only && o.only !== group) continue;
    for (const def of make()) {
      cells.push({ group, ...runCell(def, seeds) });
      process.stderr.write(`${def[0]} done (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
    }
  }
  // the same placement across two cells on the same seeds: an exploit against its control
  const across = [];
  for (const [x, y, keys] of ACROSS) {
    const cx = cells.find((c) => c.id === x);
    const cy = cells.find((c) => c.id === y);
    if (!cx || !cy) continue;
    for (const pl of cx.placements) {
      for (const k of keys) {
        if (!cx.res[pl][k] || !cy.res[pl][k]) continue;
        across.push({ x, y, placement: pl, key: k, mx: cx.res[pl][k].mean, my: cy.res[pl][k].mean, ...pairedSummary(cx.res[pl][k].raw, cy.res[pl][k].raw, `${x}-${y}:${pl}:${k}`) });
      }
    }
  }
  mkdirSync(o.out, { recursive: true });
  const meta = { seeds: seeds.length, firstSeed: o.firstSeed, placements: PLACEMENTS, generatedBy: 'node placement.mjs ' + process.argv.slice(2).join(' ') };
  const slim = cells.map((c) => ({ ...c, res: Object.fromEntries(Object.entries(c.res).map(([p, m]) => [p, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, raw: undefined }]))])) }));
  const round = (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
  writeFileSync(join(o.out, 'summary.json'), JSON.stringify({ meta, cells: slim, across }, round));
  writeFileSync(join(o.out, 'RESULTS.md'), render(meta, cells, across));
  process.stderr.write(`wrote ${o.out}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
