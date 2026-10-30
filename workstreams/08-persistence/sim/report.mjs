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
  ['expo.rate1', '露出：1日1回の人が、自国の作戦の受付中に一度でも接続していた割合', null],
  ['expo.rate2', '露出：1日2回の人（同上）', null],
  ['expo.rate12', '露出：1日12回の人（同上）', null],
  ['demob.affected', '解散：区切りで兵を削られた村の割合（区切りごとの平均）', null],
  ['demob.lostFrac', '解散：削られた村が失った兵の割合', null],
  ['ret.humans', '継続：参加した人間のうち最後まで続けた割合', 'high'],
  ['ret.newcomers', '継続：途中・終盤参加者のうち最後まで続けた割合', 'high'],
];

const PIDS = ['P0', 'A', 'B1', 'B2', 'C'];

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

function table(exp, rows) {
  const ps = PIDS.filter((p) => exp.res[p]);
  const lines = [`| 指標 | ${ps.join(' | ')} |`, `|---|${ps.map(() => '---').join('|')}|`];
  for (const [key, label] of rows) {
    if (!exp.res.P0?.[key]) continue;
    lines.push(`| ${label} | ${ps.map((p) => cell(exp.res[p][key], key)).join(' | ')} |`);
  }
  return lines.join('\n');
}

function d2(v) {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return '—';
  const x = Number(v);
  const a = Math.abs(x);
  const t = a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(2);
  return x > 0 ? '+' + t : t;
}

/** Paired differences: mean [95% bootstrap interval of the mean] (p10..p90 of per-seed differences) +k/−k/=k. */
export function pairedTable(exp, rows, pairs) {
  const head = pairs.map(([x, y]) => `${x}−${y}`);
  const lines = [`| 指標 | ${head.join(' | ')} |`, `|---|${head.map(() => '---').join('|')}|`];
  for (const [key, label] of rows) {
    const cells = pairs.map(([x, y]) => {
      const s = exp.paired?.[`${x}-${y}:${key}`];
      if (!s || !s.n) return '—';
      const sig = s.lo > 0 || s.hi < 0 ? '＊' : '';
      return `${d2(s.mean)}${sig} [${d2(s.lo)}, ${d2(s.hi)}] (${d2(s.p10)}〜${d2(s.p90)}) +${s.pos}/−${s.neg}/=${s.zero}`;
    });
    if (cells.every((c) => c === '—')) continue;
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
  ['ret.humans', '人間の継続率', 'high'],
  ['ret.newcomers', '新規の継続率', 'high'],
];

function compact(exps, keys, withPairs = false) {
  const extra = withPairs ? ' | B2−A [95%] | B2−B1 [95%]' : '';
  const lines = [`| 条件 | 指標 | ${PIDS.join(' | ')}${extra} |`, `|---|---|${PIDS.map(() => '---').join('|')}${withPairs ? '|---|---' : ''}|`];
  for (const e of exps) {
    for (const [key, label] of keys) {
      if (!e.res.P0?.[key]) continue;
      let row = `| ${e.name} | ${label} | ${PIDS.map((p) => (e.res[p] ? fmt(e.res[p][key].mean, key) : '—')).join(' | ')}`;
      if (withPairs) {
        for (const pr of ['B2-A', 'B2-B1']) {
          const s = e.paired?.[`${pr}:${key}`];
          row += s && s.n ? ` | ${d2(s.mean)}${s.lo > 0 || s.hi < 0 ? '＊' : ''} [${d2(s.lo)}, ${d2(s.hi)}]` : ' | —';
        }
      }
      lines.push(row + ' |');
    }
  }
  return lines.join('\n');
}

const PAIR_ROWS = [
  ['mid.firstOpH', '途中参加→初貢献(h)'],
  ['mid.contrib7dRel', '途中参加の7日貢献比'],
  ['late.firstOpH', '終盤参加→初貢献(h)'],
  ['defeated.lostFrac', '敗北の損失率'],
  ['defeated.toContribH', '敗北→再貢献(h)'],
  ['defeated.to50H', '敗北→50%回復(h)'],
  ['returner.lossFrac', '不在の損失率'],
  ['returner.toContribH', '復帰→初貢献(h)'],
  ['conc.lastGini', '資産ジニ'],
  ['conc.winnerRepeat', '首位の連続率'],
  ['conc.firstWinnerLaterShare', '初代勝者の以後シェア'],
  ['conc.bottomNextShare', '最下位国の次シェア'],
  ['conn.rel1', '1日1回/12回'],
  ['conn.rel2', '1日2回/12回'],
  ['rights.voided', '区切りで失効した物資'],
];
const MAIN_PAIRS = [
  ['B1', 'P0'],
  ['B2', 'B1'],
  ['B2', 'A'],
  ['A', 'P0'],
  ['C', 'B2'],
];

const EXPLOIT_KEYS = {
  alts: [['x.ownerWealth', '本人が持つ全村の資産（第2単位末）'], ['x.ownerRaided', '本村が奪われた量'], ['x.altProtH', '別村の保護時間'], ['x.altCostPaid', '別村1つあたりに払った費用（全単位合計）'], ['x.altFounded', '作られた別村の割合']],
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
  out.push('値は seed ごとの値の平均と [10%点–90%点]。∞ は期間内に起きなかったこと（打ち切り）。指標の定義は ../09-metrics.ja.md。');
  out.push('差の表は「左−右」の seed ごとの差：平均 [平均の95%ブートストラップ区間] (差の10%点〜90%点) 正の本数/負の本数/同じ本数。＊は区間が0を含まない。');
  out.push('区間は同じモデルの乱数のばらつきだけを表す。エージェントは仮定した行動モデルで、実プレイヤーの標本でも予測でもない。解釈は ../05-results.ja.md。');
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
    const main = core.find((x) => x.name === 'core/standard/mixed');
    if (main) {
      out.push('');
      out.push('## 1b. 対になった差（core/standard/mixed）');
      out.push('');
      out.push(pairedTable(main, PAIR_ROWS, MAIN_PAIRS));
    }
    const px = core.find((x) => x.name === 'core/proxy/mixed');
    if (px) {
      out.push('');
      out.push('## 1c. 代理AIつきの人（1日12回の人＝1）');
      out.push('');
      out.push(`| 指標 | ${PIDS.join(' | ')} |`);
      out.push(`|---|${PIDS.map(() => '---').join('|')}|`);
      for (const [k, label] of [['proxy.plain1', '1日1回・代理なし'], ['proxy.proxied1', '1日1回・代理あり'], ['proxy.plain2', '1日2回・代理なし'], ['proxy.proxied2', '1日2回・代理あり'], ['conc.lastGini', '資産ジニ']]) {
        if (px.res.P0[k]) out.push(`| ${label} | ${PIDS.map((p) => cell(px.res[p][k], k)).join(' | ')} |`);
      }
    }
    out.push('');
    out.push('## 2. 行動モデルを変えたとき（平均と、B2−A・B2−B1 の差）');
    out.push('');
    out.push(compact(core.filter((x) => x.name.startsWith('core/standard/')), SHORT, true));
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
    out.push('## 4. 感度分析（標準・mixed。平均と、B2−A・B2−B1 の差）');
    out.push('');
    out.push(compact(sens, [...SHORT, ['demob.affected', '解散で削られた村'], ['demob.lostFrac', '削られた村の兵の損失']], true));
  }
  const ret = all.filter((e) => e.group === 'retention');
  if (ret.length) {
    out.push('');
    out.push('## 5. 離脱・復帰・接続低下の格子（仮定。実測値ではない）');
    out.push('');
    out.push('qd＝敗北時に去る確率、h＝中央値より貧しい分に比例する1日あたりの離脱率（接続を半分にする率も同じ値）、r＝去った人が7〜21日後に戻る確率。');
    out.push('');
    out.push('逆転の判定（実行前にコードに固定）：B2−A の平均が許容幅を超えて A に有利で、かつ95%区間が0を含まない指標に「A」と記す。');
    out.push(meta.reversalRule.map((r) => `${r.label}（${r.worse === 'higher' ? '+' : '−'}${r.tol}）`).join('、') + '。');
    out.push('');
    const keys = [['ret.humans', '人間継続'], ['ret.newcomers', '新規継続'], ['conc.winnerRepeat', '首位連続'], ['conc.bottomNextShare', '最下位次'], ['mid.contrib7dRel', '新規7日比']];
    out.push(`| 条件 | 指標 | ${PIDS.join(' | ')} | B2−A [95%] | 判定 |`);
    out.push(`|---|---|${PIDS.map(() => '---').join('|')}|---|---|`);
    for (const e of ret) {
      for (const [k, label] of keys) {
        const s = e.paired?.[`B2-A:${k}`];
        const flag = e.reversal?.find((r) => r.key === k);
        out.push(`| ${e.name} | ${label} | ${PIDS.map((p) => fmt(e.res[p][k].mean, k)).join(' | ')} | ${s && s.n ? `${d2(s.mean)} [${d2(s.lo)}, ${d2(s.hi)}]` : '—'} | ${flag ? (flag.against ? '**A**' : '') : ''} |`);
      }
    }
  }
  out.push('');
  return out.join('\n');
}
