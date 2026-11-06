#!/usr/bin/env node
// Cases and measures for the cooperation harness (../18-coop-victory.ja.md). Every case runs the
// three PROBE objectives (CMP, TRD, COOP) on the same seeds, so differences are paired.
//
//   node coop-run.mjs                  # all cases, 30 seeds -> ../results/coop/
//   node coop-run.mjs --seeds 5 --out DIR --first-seed 101

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCoop, net, STAGES, COOP_BASE } from './coop.mjs';
import { summarize, gini, hhi } from './stats.mjs';
import { pairedSummary } from './paired.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- populations

/**
 * Nations lean to one function each (nation n mostly in STAGES[n % 3]): each lacks two of the
 * three functions and covers them only at secondary cost, so trading across nations pays.
 * `balanced` gives every nation all three functions (control: little to gain from trading).
 */
export function population(P, o = {}) {
  const specs = [];
  for (let n = 0; n < P.nations; n++) {
    const k = o.size?.[n] ?? P.perNation;
    for (let i = 0; i < k; i++) {
      const primary = o.balanced ? STAGES[i % 3] : i === k - 1 && k > 2 ? STAGES[(n + 1) % 3] : STAGES[n % 3];
      specs.push({ nation: n, primary });
    }
  }
  return specs;
}

const DAYS = COOP_BASE.days;

export const CASES = {
  // 1. equals covering each other's gaps (and the control where no nation lacks anything)
  equal: { label: '対等な参加者が互いの不足を補う（各国が1つの機能に偏る）', specs: (P) => population(P) },
  balanced: { label: '対照：どの国も3つの機能を持つ（補う必要が小さい）', specs: (P) => population(P, { balanced: true }) },
  // 2. one owner or one nation holds the facilities
  monoOwner: {
    label: '施設所有者の独占（施設の主力を1人が全部持つ）',
    specs: (P) => {
      const s = population(P);
      for (const x of s) if (x.primary === 'fac') x.primary = 'mine';
      s[0].primary = 'fac';
      s[0].cap = { fac: P.primaryCap * 10, mine: P.secondaryCap, haul: P.secondaryCap };
      s[0].monopolist = true;
      return s;
    },
  },
  monoNation: {
    label: '1国の独占（施設の主力を国1だけが持つ）',
    specs: (P) => {
      const s = population(P);
      for (const x of s) if (x.primary === 'fac' && x.nation !== 1) x.primary = 'mine';
      for (const x of s) if (x.nation === 1) x.primary = 'fac';
      return s;
    },
  },
  // 3. leaving and changing terms
  exitKey: {
    label: '主な施設所有者（国1の施設の主力）が10日目に退出',
    specs: (P) => population(P).map((x) => (x.nation === 1 && x.primary === 'fac' ? { ...x, exitDay: 10, key: true } : x)),
    eventDay: 10,
  },
  exitMono: {
    label: '独占していた施設所有者が10日目に退出',
    specs: (P) => CASES.monoOwner.specs(P).map((x) => (x.monopolist ? { ...x, exitDay: 10, key: true } : x)),
    eventDay: 10,
  },
  raiseKey: {
    label: '国1の施設の主力が10日目に値上げ（上乗せ×4）',
    specs: (P) => population(P).map((x) => (x.nation === 1 && x.primary === 'fac' ? { ...x, raiseAt: { day: 10, factor: 4 }, key: true } : x)),
    eventDay: 10,
  },
  // 4. newcomers and a small nation
  newcomers: {
    label: '途中参加：14日目に各国1人（容量半分、国の偏りと同じ機能）',
    specs: (P) => [
      ...population(P),
      ...[...Array(P.nations).keys()].map((n) => ({ nation: n, primary: STAGES[n % 3], cap: { [STAGES[n % 3]]: P.primaryCap / 2, ...Object.fromEntries(STAGES.filter((s) => s !== STAGES[n % 3]).map((s) => [s, 0])) }, joinDay: 14, newcomer: true })),
    ],
  },
  newcomersGap: {
    label: '途中参加：14日目に各国1人（容量半分、自国に足りない機能）',
    specs: (P) => [
      ...population(P),
      ...[...Array(P.nations).keys()].map((n) => {
        const st = STAGES[(n + 2) % 3];
        return { nation: n, primary: st, cap: Object.fromEntries(STAGES.map((s) => [s, s === st ? P.primaryCap / 2 : 0])), joinDay: 14, newcomer: true };
      }),
    ],
  },
  smallNation: { label: '少人数の国（国5は2人）', specs: (P) => population(P, { size: { 5: 2 } }), focusNation: 5 },
  // 5. people who do not join chains, and transport-only people
  optOut: {
    label: '協力に参加しない人（各国2人は取引せず、自分の生産だけ）',
    specs: (P) => population(P).map((x, i) => (i % P.perNation < 2 ? { ...x, policy: 'solo' } : x)),
  },
  haulOnly: {
    label: '輸送だけの人（各国1人。採掘も施設も持たない）',
    specs: (P) => [...population(P), ...[...Array(P.nations).keys()].map((n) => ({ nation: n, primary: 'haul', cap: { mine: 0, fac: 0, haul: P.primaryCap }, haulOnly: true }))],
  },
  // 6. inflating the evaluation
  inflate: {
    label: '水増し：往復取引の2組、自己取引の別アカウント（3国に1人ずつ、同じ本人）',
    specs: (P) => {
      const s = population(P);
      // two round-trip pairs across nations (each records 5 fake trades a day each way)
      const pair = (a, b) => {
        s[a].wash = b;
        s[b].wash = a;
        s[a].washer = s[b].washer = true;
      };
      pair(1, P.perNation * 3 + 1);
      pair(2, P.perNation * 4 + 2);
      // one person with three accounts, one in each of nations 0, 1, 2, each in a different function
      const owner = s.length;
      for (let n = 0; n < 3; n++) s.push({ nation: n, primary: STAGES[n], owner, alt: true });
      return s;
    },
  },
  // 7. a fixed international coalition shutting others out
  cartel3: {
    label: '固定連合：国0・1・2が連合内だけで取引（外の3国も3機能を持つ）',
    specs: (P) => population(P).map((x) => (x.nation <= 2 ? { ...x, cartel: 1 } : x)),
    outsiders: [3, 4, 5],
  },
  cartel4: {
    label: '固定連合：国0〜3が連合内だけで取引（外の国4・5は採掘の主力を持たない）',
    specs: (P) => population(P).map((x) => (x.nation <= 3 ? { ...x, cartel: 1 } : x)),
    outsiders: [4, 5],
  },
};

// ---------------------------------------------------------------- measures

function mean(xs) {
  const f = xs.filter((x) => Number.isFinite(x));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
}

function maxShare(map) {
  let tot = 0;
  let top = 0;
  for (const v of map.values()) {
    tot += v;
    top = Math.max(top, v);
  }
  return tot > 0 ? top / tot : NaN;
}

export function measureCoop(w, spec, caseDef) {
  const { P, parts, log } = w;
  const out = {};
  const days = P.days;
  const active = (p) => Math.max(0, Math.min(days, p.exitDay, p.leftDay ?? Infinity) - p.joinDay);
  const outside = (p) => P.soloRate * p.cap[p.primary] * active(p);
  const traders = parts.filter((p) => p.policy === 'trade');
  const withSpec = parts.map((p, i) => ({ p, s: spec[i] }));
  // real output
  out.delivered = mean(log.map((d) => d.delivered)) / (P.nations * P.demand);
  out.shortfall = mean(log.map((d) => d.shortfall)) / (P.nations * P.demand);
  // every participant's costs and benefits, against their outside option
  out.benefitShare = mean(traders.map((p) => (net(p) > outside(p) ? 1 : 0)));
  out.netGini = gini(parts.map((p) => Math.max(0, net(p))));
  // the role itself (selling one's function), without the nation's consumption surplus
  const producer = (p) => p.revenue - p.costPaid + p.shared;
  out.producerBenefitShare = mean(traders.map((p) => (producer(p) > outside(p) ? 1 : 0)));
  out.producerRel = mean(traders.map((p) => (outside(p) > 0 ? producer(p) / outside(p) : NaN)));
    out.costPerUnit = mean(traders.filter((p) => p.units).map((p) => p.costPaid / p.units));
  out.marginPerUnit = mean(traders.filter((p) => p.units).map((p) => (p.revenue - p.costPaid) / p.units));
  // who takes the gains (by person, accounts of one owner added together)
  const byOwner = new Map();
  for (const p of parts) byOwner.set(p.owner, (byOwner.get(p.owner) || 0) + Math.max(0, p.revenue - p.costPaid + p.shared));
  const gains = [...byOwner.values()];
  const totG = gains.reduce((a, b) => a + b, 0);
  out.topOwnerShare = totG > 0 ? Math.max(...gains) / totG : NaN;
  // subordination: share of a participant's units whose chain passed through the biggest owner
  const topOwner = [...byOwner.entries()].reduce((m, e) => (e[1] > m[1] ? e : m), [null, -1])[0];
  const through = new Map();
  for (const d of log) for (const c of d.chains) {
    const viaTop = c.members.some((id) => parts[id].owner === topOwner);
    for (const id of c.members) {
      const t = through.get(id) || [0, 0];
      t[0] += viaTop ? 1 : 0;
      t[1]++;
      through.set(id, t);
    }
  }
  out.viaTopOwner = mean(traders.filter((p) => p.owner !== topOwner && through.has(p.id)).map((p) => through.get(p.id)[0] / through.get(p.id)[1]));
  // monopoly: units per function by owner
  for (const [i, st] of STAGES.entries()) {
    const m = new Map();
    for (const d of log) for (const c of d.chains) m.set(parts[c.members[i]].owner, (m.get(parts[c.members[i]].owner) || 0) + 1);
    out[`hhi_${st}`] = hhi([...m.values()]);
  }
  out.hhiMax = Math.max(out.hhi_mine, out.hhi_fac, out.hhi_haul);
  // choice or dependence
  const tr = traders.filter((p) => p.units > 0);
  out.breadth = mean(log.map((d) => (d.decisions ? d.candOwners / d.decisions : NaN)));
    out.partners = mean(tr.map((p) => p.partners.size));
  out.buyers = mean(tr.map((p) => p.buyers.size));
  out.dependency = mean(tr.map((p) => maxShare(p.partners)));
  out.buyerDependency = mean(tr.map((p) => maxShare(p.buyers)));
  out.idle = mean(traders.map((p) => (p.units === 0 ? 1 : 0)));
  const capAll = (p) => STAGES.reduce((x, st) => x + p.cap[st], 0);
  out.utilization = mean(traders.map((p) => p.units / Math.max(1, capAll(p) * active(p))));
  // naive counts next to the real output
  out.tradesPerDay = mean(log.map((d) => d.trades));
  out.washShare = mean(log.map((d) => (d.trades ? d.washTrades / d.trades : 0)));
  out.crossNationTrades = mean(log.map((d) => d.crossNationTrades));
  out.crossNationChains = mean(log.map((d) => d.crossNationChains));
  out.crossOwnerChains = mean(log.map((d) => d.crossOwnerChains));
  // a delivered unit claimed once, or once per goal (shared, nation, and each of three members)
  out.creditPerUnit = P.creditMode === 'each' ? 5 : 1;
  // groups
  const grp = (f) => withSpec.filter(({ s }) => f(s)).map(({ p }) => p);
  const rel = (ps) => mean(ps.map((p) => (outside(p) > 0 ? net(p) / outside(p) : NaN)));
  const g = {
    washers: grp((s) => s.washer),
    alts: grp((s) => s.alt),
    newcomers: grp((s) => s.newcomer),
    haulOnly: grp((s) => s.haulOnly),
    solo: grp((s) => s.policy === 'solo'),
    key: grp((s) => s.key || s.monopolist),
    cartel: grp((s) => s.cartel !== undefined && s.cartel !== null),
  };
  if (g.washers.length || g.alts.length) {
    const sh = (ps) => ps.reduce((a, p) => a + p.shared, 0);
    const allShared = parts.reduce((a, p) => a + p.shared, 0);
    out.washerPoolShare = allShared > 0 ? sh(g.washers) / allShared : 0;
    out.washerPoolShareFair = (g.washers.length / parts.length);
    // chains made only of one person's accounts, with at least two different accounts (self-dealing)
    const altOwner = g.alts[0]?.owner;
    const selfChain = (c) => c.members.every((id) => parts[id].owner === altOwner) && new Set(c.members).size >= 2;
    out.altChainsPerDay = mean(log.map((d) => d.chains.filter(selfChain).length));
    out.altCrossNationPerDay = mean(log.map((d) => d.chains.filter((c) => selfChain(c) && c.members.some((id) => parts[id].nation !== c.buyer)).length));
    out.altNetRel = rel(g.alts);
  }
  if (g.newcomers.length) {
    out.newcomerFirstDays = mean(g.newcomers.map((p) => (p.firstTradeDay === null ? days - p.joinDay : p.firstTradeDay - p.joinDay)));
    out.newcomerNeverShare = mean(g.newcomers.map((p) => (p.firstTradeDay === null ? 1 : 0)));
    out.newcomerUtil = mean(g.newcomers.map((p) => p.units / Math.max(1, capAll(p) * active(p))));
    out.newcomerRel = rel(g.newcomers);
  }
  if (g.haulOnly.length) {
    out.haulOnlyUtil = mean(g.haulOnly.map((p) => p.units / Math.max(1, p.cap.haul * active(p))));
    out.haulOnlyRel = rel(g.haulOnly);
  }
  if (g.solo.length) {
    out.soloRel = rel(g.solo); // = 1 by construction for pure solo (their payoff is the outside option, plus their nation's surplus)
    out.traderRel = rel(traders);
  }
  if (caseDef.focusNation !== undefined) {
    const fn = caseDef.focusNation;
    const ds = log.map((d) => d.chains.filter((c) => c.buyer === fn).length / P.demand);
    out.focusDelivered = mean(ds);
    out.focusRel = rel(parts.filter((p) => p.nation === fn));
  }
  if (caseDef.eventDay !== undefined) {
    const e = caseDef.eventDay;
    const before = mean(log.slice(e - 3, e).map((d) => d.delivered));
    const after = mean(log.slice(e, e + 3).map((d) => d.delivered));
    out.eventDrop = before > 0 ? after / before : NaN;
    let rec = null;
    for (let d = e; d < log.length; d++) if (rec === null && log[d].delivered >= 0.95 * before) rec = d - e;
    out.eventRecoverDays = rec === null ? days - e : rec;
    const unitPrice = (ds) => mean(ds.flatMap((d) => d.chains.map((c) => c.prices.reduce((a, x) => a + x, 0))));
    out.eventPriceRatio = unitPrice(log.slice(e, e + 3)) / unitPrice(log.slice(e - 3, e));
    out.keyRel = rel(g.key);
  }
  if (caseDef.outsiders) {
    const outs = parts.filter((p) => caseDef.outsiders.includes(p.nation));
    out.outsiderRel = rel(outs);
    out.outsiderUtil = mean(outs.map((p) => p.units / Math.max(1, capAll(p) * active(p))));
    out.outsiderDelivered = mean(log.map((d) => d.chains.filter((c) => caseDef.outsiders.includes(c.buyer)).length)) / (caseDef.outsiders.length * P.demand);
    out.cartelRel = rel(g.cartel);
  }
  out.remaining = mean(parts.map((p) => (p.left ? 0 : 1)));
  return out;
}

// ---------------------------------------------------------------- cells

const OBJ = ['CMP', 'TRD', 'COOP'];

export const CELLS = () => {
  const list = [];
  for (const c of Object.keys(CASES)) list.push([c, c, {}, OBJ]);
  // allocation rules of the shared pool, and the double count
  list.push(['inflate-alloc-trades', 'inflate', { allocation: 'trades' }, ['COOP']]);
  list.push(['inflate-alloc-equal', 'inflate', { allocation: 'equal' }, ['COOP']]);
  list.push(['inflate-credit-each', 'inflate', { creditMode: 'each' }, ['COOP']]);
  // the leaving families of 5-6, reused
  for (const fam of ['flat', 'relative', 'decline']) list.push([`equal-leave-${fam}`, 'equal', { quitModel: fam, quitHazard: fam === 'flat' ? 0.01 : 0.05 }, OBJ]);
  // assumptions that might flip a result
  // the assumed "helping a rival costs me" rule: only here can the shared pool change behaviour
  list.push(['equal-reluctant', 'equal', { foreignThreshold: 0.6 }, OBJ]);
  list.push(['equal-reluctant-pool0.5', 'equal', { foreignThreshold: 0.6, sharedPool: 0.5 }, OBJ]);
  list.push(['equal-reluctant-pool5', 'equal', { foreignThreshold: 0.6, sharedPool: 5 }, OBJ]);
  list.push(['monoOwner-reluctant', 'monoOwner', { foreignThreshold: 0.6 }, OBJ]);
  list.push(['newcomersGap-reluctant', 'newcomersGap', { foreignThreshold: 0.6 }, OBJ]);
  list.push(['equal-incumbency', 'equal', { incumbency: 0.15 }, OBJ]);
  list.push(['newcomers-incumbency', 'newcomers', { incumbency: 0.15 }, OBJ]);
  list.push(['equal-pool0.5', 'equal', { sharedPool: 0.5 }, ['COOP']]);
  list.push(['equal-pool5', 'equal', { sharedPool: 5 }, ['COOP']]);
  list.push(['equal-solo0.6', 'equal', { soloRate: 0.6 }, OBJ]);
  list.push(['monoOwner-power0.3', 'monoOwner', { markupPower: 0.3 }, OBJ]);
  list.push(['equal-haul1.0', 'equal', { haulPerDist: 1.0 }, OBJ]);
  return list;
};

export function runCell([id, caseId, ov, objs], seeds) {
  const res = {};
  for (const obj of objs) {
    const P = { ...COOP_BASE, objective: obj, ...ov };
    const spec = CASES[caseId].specs(P);
    const per = seeds.map((seed) => measureCoop(runCoop(P, spec, seed), spec, CASES[caseId]));
    const agg = {};
    for (const k of Object.keys(per[0])) agg[k] = { ...summarize(per.map((x) => x[k])), raw: per.map((x) => x[k]) };
    res[obj] = agg;
  }
  const paired = {};
  for (const [x, y] of [['TRD', 'CMP'], ['COOP', 'TRD'], ['COOP', 'CMP']]) {
    if (!res[x] || !res[y]) continue;
    for (const k of Object.keys(res[x])) if (res[y][k]) paired[`${x}-${y}:${k}`] = pairedSummary(res[x][k].raw, res[y][k].raw, `${id}:${x}-${y}:${k}`);
  }
  return { id, caseId, label: CASES[caseId].label, overrides: ov, objectives: objs, res, paired };
}

export const KEYS = [
  ['delivered', '実際の成果：需要のうち届いた割合'],
  ['benefitShare', '取引した人のうち、国の消費の得も含めて外部の選択肢より得をした割合'],
  ['producerBenefitShare', '取引した人のうち、自分の役割の稼ぎだけで外部の選択肢より得をした割合'],
  ['producerRel', '自分の役割の稼ぎ ÷ 外部の選択肢（平均）'],
  ['netGini', '各人の得の偏り（ジニ係数）'],
  ['topOwnerShare', '最も得をした本人（別アカウントを合算）の取り分'],
  ['hhiMax', '独占度：機能ごとの担い手の HHI（最大の機能）'],
  ['viaTopOwner', '従属：自分の単位のうち、最も稼いだ本人を通った割合（その本人以外の平均）'],
  ['hhi_fac', '独占度：施設'],
  ['breadth', '選択肢：1回の選定で選べた担い手（本人）の数'],
  ['partners', '一緒に組んだ相手（本人）の数'],
  ['dependency', '依存：最も多く組んだ相手への集中（1＝1人だけ）'],
  ['buyerDependency', '依存：最も多い買い手（国）への集中'],
  ['idle', '一度も取引しなかった人の割合'],
  ['utilization', '自分の機能の容量のうち使われた割合'],
  ['tradesPerDay', '素朴な数：1日の取引件数'],
  ['crossNationTrades', '素朴な数：国をまたぐ取引件数（1日）'],
  ['crossOwnerChains', '堅い数：別の本人どうしで国をまたいで届いた単位（1日）'],
  ['washShare', '取引件数のうち往復取引の割合'],
  ['washerPoolShare', '往復取引をした人が得た共同報酬の割合（人数比なら下の値）'],
  ['washerPoolShareFair', '　（往復取引をした人の人数比）'],
  ['altChainsPerDay', '自己取引：同じ本人の別アカウント2つ以上だけで組んだ単位（1日）'],
  ['altCrossNationPerDay', '　そのうち「国をまたぐ協力」に見えるもの（1日）'],
  ['creditPerUnit', '1単位あたりの計上数（1＝二重計上なし）'],
  ['eventDrop', '退出・値上げの直後3日の成果 ÷ 直前3日'],
  ['eventRecoverDays', '直前の95%に戻るまでの日数'],
  ['eventPriceRatio', '直後3日の1単位の価格 ÷ 直前'],
  ['keyRel', '退出・値上げした人の得 ÷ 外部の選択肢'],
  ['newcomerFirstDays', '途中参加：最初の取引までの日数'],
  ['newcomerNeverShare', '途中参加：一度も取引しなかった割合'],
  ['newcomerUtil', '途中参加：容量の使われた割合'],
  ['newcomerRel', '途中参加：得 ÷ 外部の選択肢'],
  ['focusDelivered', '少人数の国：自国の需要の届いた割合'],
  ['focusRel', '少人数の国の人：得 ÷ 外部の選択肢'],
  ['soloRel', '取引しない人：得 ÷ 外部の選択肢'],
  ['traderRel', '取引する人：得 ÷ 外部の選択肢'],
  ['haulOnlyUtil', '輸送だけの人：容量の使われた割合'],
  ['haulOnlyRel', '輸送だけの人：得 ÷ 外部の選択肢'],
  ['outsiderDelivered', '連合の外の国：需要の届いた割合'],
  ['outsiderRel', '連合の外の人：得 ÷ 外部の選択肢'],
  ['outsiderUtil', '連合の外の人：容量の使われた割合'],
  ['cartelRel', '連合の人：得 ÷ 外部の選択肢'],
  ['remaining', '最後まで残った人の割合'],
];

function fmt(v) {
  const x = Number(v);
  if (v === undefined || v === null || Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return '∞';
  const a = Math.abs(x);
  return a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(2);
}
const sgn = (v) => (Number(v) > 0 ? '+' : '') + fmt(v);

export function render(meta, cells) {
  const out = ['# 協力の検査器（自動生成）', ''];
  out.push(`生成：\`${meta.generatedBy}\`、seed ${meta.firstSeed}〜${meta.firstSeed + meta.seeds - 1}（${meta.seeds}本）。目標の規則は全て**検査用の仮の規則（probe）**で、①の協力型の候補ではない。`);
  out.push('CMP＝自国の需要は自国の人だけで満たす（競争型の写し）、TRD＝国をまたぐ取引を許す（共同報酬なし）、COOP＝TRD＋届いた単位ごとの共同報酬。値は seed ごとの平均 [10%点–90%点]。差は同じ seed の対：平均 [95%区間]、＊は区間が0を含まない。解釈は ../../18-coop-victory.ja.md。');
  for (const c of cells) {
    out.push('', `## ${c.id}：${c.label}${Object.keys(c.overrides).length ? ' ' + JSON.stringify(c.overrides) : ''}`, '');
    const pairs = [['TRD', 'CMP'], ['COOP', 'TRD']].filter(([x, y]) => c.res[x] && c.res[y]);
    out.push(`| 指標 | ${c.objectives.join(' | ')} | ${pairs.map(([x, y]) => `${x}−${y}`).join(' | ')} |`);
    out.push(`|---|${c.objectives.map(() => '---').join('|')}|${pairs.map(() => '---').join('|')}|`);
    for (const [k, label] of KEYS) {
      if (!c.res[c.objectives[0]][k] || c.res[c.objectives[0]][k].finite === 0) continue;
      const a = c.objectives.map((o) => `${fmt(c.res[o][k].mean)} [${fmt(c.res[o][k].p10)}–${fmt(c.res[o][k].p90)}]`);
      const b = pairs.map(([x, y]) => {
        const s = c.paired[`${x}-${y}:${k}`];
        return s && s.n ? `${sgn(s.mean)}${s.lo > 0 || s.hi < 0 ? '＊' : ''} [${sgn(s.lo)}, ${sgn(s.hi)}]` : '—';
      });
      out.push(`| ${label} | ${a.join(' | ')} | ${b.join(' | ')} |`);
    }
  }
  out.push('');
  return out.join('\n');
}

function parseArgs(argv) {
  const o = { seeds: 30, out: join(here, '..', 'results', 'coop'), firstSeed: 1 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--seeds') o.seeds = Number(argv[++i]);
    else if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--first-seed') o.firstSeed = Number(argv[++i]);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv);
  const seeds = Array.from({ length: o.seeds }, (_, i) => o.firstSeed + i);
  const t0 = Date.now();
  const cells = [];
  for (const def of CELLS()) {
    cells.push(runCell(def, seeds));
    process.stderr.write(`${def[0]} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
  }
  mkdirSync(o.out, { recursive: true });
  const meta = { seeds: seeds.length, firstSeed: o.firstSeed, base: COOP_BASE, generatedBy: 'node coop-run.mjs ' + process.argv.slice(2).join(' ') };
  const slim = cells.map((c) => ({ ...c, res: Object.fromEntries(Object.entries(c.res).map(([p, m]) => [p, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, raw: undefined }]))])) }));
  const round = (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
  writeFileSync(join(o.out, 'summary.json'), JSON.stringify({ meta, cells: slim }, round));
  writeFileSync(join(o.out, 'RESULTS.md'), render(meta, cells));
  process.stderr.write(`wrote ${o.out}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
