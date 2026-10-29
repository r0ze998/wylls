// Renders results/RESULTS.md from the experiment list. Numbers are across
// seeds: mean, and [p10–p90] of the per-seed values. "∞" = never happened
// within the run (censored); the share of finite seeds is shown when < all.

export const HEADLINE = [
  ['mid.firstOpH', '途中参加：参加を決めてから初貢献まで (h, 中央値)', 'low'],
  ['mid.within72', '途中参加：72h以内に共同作戦へ貢献した割合', 'high'],
  ['mid.kinds24', '途中参加：24h後に実行可能な貢献の種類数 (0-5)', 'high'],
  ['mid.contrib7dRel', '途中参加：最初7日の貢献量（同期間の初日組=1）', 'high'],
  ['late.waitToFoundH', '終盤参加：村を持てるまでの待ち (h)', 'low'],
  ['late.firstOpH', '終盤参加：初貢献まで (h)', 'low'],
  ['defeated.lostFrac', '敗北：失った資産の割合', 'low'],
  ['defeated.toContribH', '敗北：再び共同作戦へ貢献するまで (h)', 'low'],
  ['defeated.to50H', '敗北：敗北前の能力の50%に戻るまで (h)', 'low'],
  ['returner.lossFrac', '10日不在：不在中に失った資産の割合', 'low'],
  ['returner.defeatedAway', '10日不在：不在中に敗北した割合', 'low'],
  ['returner.toContribH', '10日不在：復帰後の初貢献まで (h)', 'low'],
  ['conc.lastGini', '集中：最終単位末の資産ジニ係数', 'low'],
  ['conc.lastMilitaryTop', '集中：最大国の軍事力シェア（最終単位末）', 'low'],
  ['conc.meanWinnerShare', '集中：各単位の首位国の砦保持シェア', 'low'],
  ['conc.winnerRepeat', '固定：前単位の首位国が再び首位の率', 'low'],
  ['conc.firstWinnerLaterShare', '固定：第1単位の勝者の、以後の砦シェア', 'low'],
  ['conc.bottomNextShare', '回復：最下位国の次の単位の砦シェア（均等=0.17）', 'high'],
  ['conc.distinctWinners', '多様性：4単位で首位になった国の数', 'high'],
  ['conn.rel1', '接続：1日1回の人の貢献（1日12回の人=1）', 'high'],
  ['conn.rel2', '接続：1日2回の人の貢献（同上）', 'high'],
  ['conn.rel4', '接続：1日4回の人の貢献（同上）', 'high'],
  ['conn.relAI', '接続：常時稼働AIの貢献（同上）', null],
  ['rights.caravanValue', '境界：区切りの瞬間に輸送中の物資（全区切り合計）', null],
  ['rights.fortSupply', '境界：区切りの瞬間に砦に預けられた物資', null],
  ['rights.voided', '境界：区切りで失効した物資（全区切り合計）', 'low'],
  ['rights.returned', '境界：区切りで送り主に戻した物資', null],
];

const PIDS = ['P0', 'A', 'B', 'C'];

export function fmt(v, key = '') {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') v = Number(v);
  if (Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return '∞';
  if (/H$|Value|voided|returned|Wealth|kits|protH|contrib$|Raided|fedRank|fedFarms/.test(key)) return String(Math.round(v));
  return v.toFixed(2);
}

function cell(s, key) {
  if (!s) return '—';
  const inf = s.finite < s.n ? ` (有限${s.finite}/${s.n})` : '';
  if (s.finite === 0) return '∞';
  return `${fmt(s.mean, key)} [${fmt(s.p10, key)}–${fmt(s.p90, key)}]${inf}`;
}

/** Share of seeds where proposal p is strictly better than P0 on key. */
export function pairedWins(exp, p, key, dir) {
  const a = exp.res[p][key]?.raw;
  const b = exp.res.P0[key]?.raw;
  if (!a || !b || !dir) return null;
  let win = 0;
  let tie = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    if (x === y) tie++;
    else if (dir === 'low' ? x < y : x > y) win++;
  }
  return { win, tie, n: a.length };
}

function table(exp, rows) {
  const lines = [`| 指標 | ${PIDS.join(' | ')} |`, `|---|${PIDS.map(() => '---').join('|')}|`];
  for (const [key, label, dir] of rows) {
    if (!exp.res.P0[key]) continue;
    const cells = PIDS.map((p) => {
      const c = cell(exp.res[p][key], key);
      if (p === 'P0' || !dir) return c;
      const w = pairedWins(exp, p, key, dir);
      return w ? `${c} 〔P0より良 ${w.win}/${w.n}〕` : c;
    });
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

const SHORT = [
  ['mid.firstOpH', '途中参加→初貢献(h)', 'low'],
  ['mid.contrib7dRel', '途中参加の7日貢献比', 'high'],
  ['defeated.toContribH', '敗北→再貢献(h)', 'low'],
  ['defeated.to50H', '敗北→50%回復(h)', 'low'],
  ['returner.lossFrac', '不在の損失率', 'low'],
  ['conc.lastGini', '資産ジニ', 'low'],
  ['conc.winnerRepeat', '首位の連続率', 'low'],
  ['conc.firstWinnerLaterShare', '初代勝者の以後シェア', 'low'],
  ['conc.bottomNextShare', '最下位国の次シェア', 'high'],
  ['conn.rel1', '1日1回/12回', 'high'],
  ['conn.relAI', 'AI/12回', null],
];

function compact(exps, keys) {
  const lines = [`| 条件 | 指標 | ${PIDS.join(' | ')} |`, `|---|---|${PIDS.map(() => '---').join('|')}|`];
  for (const e of exps) {
    for (const [key, label] of keys) {
      if (!e.res.P0[key]) continue;
      lines.push(`| ${e.name} | ${label} | ${PIDS.map((p) => fmt(e.res[p][key].mean, key)).join(' | ')} |`);
    }
  }
  return lines.join('\n');
}

const EXPLOIT_KEYS = {
  alts: [['x.ownerWealth', '本人が持つ全村の資産（第2単位末）'], ['x.ownerRaided', '本村が奪われた量'], ['x.altProtH', '別村の保護時間']],
  churn: [['x.kits', '受け取った初期物資の回数'], ['x.protH', '保護された時間'], ['x.contrib', '共同作戦への貢献'], ['x.endWealth', '終了時の資産']],
  kingmaker: [['x.winnerShare', '首位国の砦シェア'], ['x.winnerRepeat', '首位の連続率'], ['conc.lastGini', '資産ジニ']],
  feeder: [['x.fedWealth', '貢がれた村の資産'], ['x.fedRank', '同村の資産順位'], ['focus.share', '国1の砦シェア'], ['conc.lastGini', '資産ジニ']],
  dominant: [['focus.share', '国0の砦シェア'], ['conc.winnerRepeat', '首位の連続率'], ['conc.firstWinnerLaterShare', '初代勝者の以後シェア'], ['conc.bottomNextShare', '最下位国の次単位シェア']],
};

export function renderMarkdown(meta, all) {
  const out = [];
  out.push('# シミュレーション結果（自動生成）');
  out.push('');
  out.push(`生成：\`${meta.generatedBy}\`、seed ${meta.firstSeed}〜${meta.firstSeed + meta.seeds - 1}（${meta.seeds}本）。全案が同じseedを使う（対になった比較）。`);
  out.push('');
  out.push('値は seed ごとの値の平均と [10%点–90%点]。〔P0より良 k/n〕は、同じseedで現行（P0）より良かった本数。∞ は期間内に起きなかったこと。');
  out.push('エージェントは仮定した行動モデルで、実プレイヤーの予測ではない。解釈は ../05-results.ja.md。');
  out.push('');
  const core = all.filter((e) => e.group === 'core');
  if (core.length) {
    out.push('## 1. 主比較（行動モデル：mixed）');
    for (const e of core.filter((x) => x.name.endsWith('/mixed'))) {
      out.push('');
      out.push(`### ${e.name}`);
      out.push('');
      out.push(table(e, [...HEADLINE, ['focus.share', '注目国の砦シェア（少人数・AI多数・先行国）', null]]));
    }
    out.push('');
    out.push('## 2. 行動モデルを変えたとき（平均のみ）');
    out.push('');
    out.push(compact(core.filter((x) => x.name.startsWith('core/standard/')), SHORT));
  }
  const ex = all.filter((e) => e.group === 'exploits');
  if (ex.length) {
    out.push('');
    out.push('## 3. 壊れる条件（悪用・移転）');
    for (const e of ex) {
      const kind = Object.keys(EXPLOIT_KEYS).find((k) => e.scenario.startsWith(k)) || (e.scenario === 'standard' ? 'kingmaker' : null);
      if (!kind) continue;
      out.push('');
      out.push(`### ${e.name}${Object.keys(e.overrides).length ? ' ' + JSON.stringify(e.overrides) : ''}`);
      out.push('');
      out.push(`| 指標 | ${PIDS.join(' | ')} |`);
      out.push(`|---|${PIDS.map(() => '---').join('|')}|`);
      for (const [k, label] of EXPLOIT_KEYS[kind]) {
        if (!e.res.P0[k]) continue;
        out.push(`| ${label} | ${PIDS.map((p) => cell(e.res[p][k], k)).join(' | ')} |`);
      }
    }
  }
  const sens = all.filter((e) => e.group === 'sensitivity');
  if (sens.length) {
    out.push('');
    out.push('## 4. 感度分析（標準・mixed、平均のみ）');
    out.push('');
    out.push(compact(sens, SHORT));
  }
  out.push('');
  return out.join('\n');
}
