// Comparing the cases from the same initial state. Every scenario is a set of
// parameter overrides; each (scenario, seed) is run once per case with the
// same world, people and random stream, so differences come from the tower
// alone. Paired measures compare a village with itself in case A.
import { createSim, run, summarize, CASES } from './model.mjs';

/** The situations the brief asks to try (all numbers provisional). */
export const SCENARIOS = Object.freeze([
  { id: 'base', name: '基本（依頼は自国だけに見える前提＝①の「国の卓」Q8案(a)。大国2・中国2・小国2、途中参加2割、資源の少ない人2割5分、協力しない人2割、妨害2、退出3）', over: {} },
  { id: 'dispersed', name: '分散配置（⑧の仮置き：輪2〜8）＝近くの人と遠くの人', over: { placement: 'dispersed' } },
  { id: 'late_poor', name: '途中参加と資源の少ない人が多い（各4割）', over: { lateShare: 0.4, poorShare: 0.4 } },
  { id: 'no_coop', name: '協力しない人が半分', over: { selfishShare: 0.5 } },
  { id: 'monopoly', name: '大国0が塔を独占しにいく（自国だけ護衛・他国を中央で襲う）', over: { monopolist: 0 } },
  { id: 'alliance', name: '固定連合（国0と国1は互いとしか取引しない）', over: { alliance: [0, 1] } },
  { id: 'brink', name: '達成目前の妨害（妨害者4、達成8割から襲う）', over: { saboteurs: 4, sabotage: 'brink' } },
  { id: 'leavers', name: '参加者の退出（8村が7日目に去る）', over: { leavers: 8 } },
  { id: 'transport', name: '輸送の失敗が多い（1州あたり5%）', over: { lossPerProvince: 0.05 } },
  { id: 'world_visible', name: '依頼が全国に見える前提＝①の現行の依頼の板（20505891 の coop/：国で絞らず全件を返す。3f3c8478 でも同じ）', over: { requestVisibility: 'world' } },
  { id: 'keep', name: 'C：期限なし・返金なし（進捗が残る）', over: { refund: 'keep' } },
  { id: 'members', name: 'C：中継の倉は出した人だけが使える', over: { access: 'contributors' } },
]);

/** One (scenario, seed): the three cases from the same start, with paired measures against A. */
export function runTriple(over, seed) {
  const sims = Object.fromEntries(CASES.map(c => { const s = createSim({ ...over, seed, case: c }); run(s); return [c, s]; }));
  const out = {};
  for (const c of CASES) {
    const sum = summarize(sims[c]);
    sum.paired = paired(sims.A, sims[c]);
    out[c] = sum;
  }
  return out;
}

/**
 * A village in case X against itself in case A: the change of its level, for
 * villages that did not take part in the tower in X (can they still advance?),
 * by distance band and by nation size.
 */
export function paired(simA, simX) {
  const part = v => Object.values(v.roles).some(n => n > 0) || v.relayUses > 0 || (v.slots.board ?? 0) > 0;
  const big = Math.max(...simA.P.nations), small = Math.min(...simA.P.nations);
  const delta = f => {
    const ids = simX.villages.filter(f).map(v => v.id);
    if (!ids.length) return null;
    return Math.round(ids.reduce((s, i) => s + simX.villages[i].level - simA.villages[i].level, 0) / ids.length * 100) / 100;
  };
  const band = r => (r <= 2 ? 'near' : r <= 4 ? 'mid' : 'far');
  return {
    nonParticipants: delta(v => !part(v) && v.profile !== 'saboteur'),
    participants: delta(v => part(v)),
    near: delta(v => band(v.ring) === 'near'), mid: delta(v => band(v.ring) === 'mid'), far: delta(v => band(v.ring) === 'far'),
    bigNation: delta(v => simX.P.nations[v.nation] === big), smallNation: delta(v => simX.P.nations[v.nation] === small),
    late: delta(v => v.late), poor: delta(v => v.poor), selfish: delta(v => v.profile === 'selfish'),
  };
}

/** Means over seeds of every numeric leaf (null where a seed had no value). */
export function meanOf(list) {
  const walk = (xs) => {
    const first = xs.find(x => x !== null && x !== undefined);
    if (first === undefined) return null;
    if (typeof first === 'number') { const v = xs.filter(x => typeof x === 'number'); return Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100) / 100; }
    if (Array.isArray(first)) return first.every(x => typeof x === 'number') && xs.every(x => Array.isArray(x) && x.length === first.length) ? first.map((_, i) => walk(xs.map(x => x[i]))) : null;
    if (typeof first === 'object') { const o = {}; for (const k of Object.keys(first)) o[k] = walk(xs.map(x => (x ? x[k] : null))); return o; }
    return first;
  };
  return walk(list);
}

/** A scenario over `seeds`: per case, the means of the summaries. */
export function runScenario(sc, seeds) {
  const triples = seeds.map(s => runTriple(sc.over, s));
  const out = { id: sc.id, name: sc.name, seeds: seeds.length };
  for (const c of CASES) {
    out[c] = meanOf(triples.map(t => t[c]));
    out[c].ci95 = Object.fromEntries(Object.entries(KEY).map(([k, g]) => [k, ci(triples.map(t => g(t[c])))]));
    if (c === 'C') out[c].completedStageShare = { one: share(triples, t => t.C.tower.stages >= 1), all: share(triples, t => t.C.tower.stages >= 3) };
  }
  return out;
}
/** Measures whose seed-to-seed spread is reported (95% interval of the mean, normal approximation). */
export const KEY = Object.freeze({
  level: x => x.level.all, nonParticipants: x => x.paired.nonParticipants, participants: x => x.paired.participants,
  near: x => x.paired.near, far: x => x.paired.far, smallNation: x => x.paired.smallNation, bigNation: x => x.paired.bigNation,
  late: x => x.paired.late, poor: x => x.paired.poor, selfish: x => x.paired.selfish, cross: x => x.trades.cross, lost: x => x.logistics.lostCaravans,
});
export function ci(xs) {
  const v = xs.filter(x => typeof x === 'number');
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  const h = 1.96 * sd / Math.sqrt(v.length);
  return [Math.round((m - h) * 100) / 100, Math.round((m + h) * 100) / 100];
}
const share = (xs, f) => Math.round(xs.filter(f).length / xs.length * 100) / 100;
