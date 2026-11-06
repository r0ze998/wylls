#!/usr/bin/env node
// Runs every fixed scenario under A, B and C and writes the comparison
// (results/compare.json and results/compare.ja.md). Deterministic.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const names = readdirSync(join(root, 'scenarios')).filter(f => f.endsWith('.json')).sort();
const ST = { achieved: '達成', not_achieved: '未達', indeterminate: '判定不能' };
const rows = [];
for (const f of names) {
  const input = JSON.parse(readFileSync(join(root, 'scenarios', f), 'utf8'));
  const row = { scenario: f.slice(0, -5), description: input.description };
  for (const k of ['A', 'B', 'C']) {
    const v = evaluate(RULESETS[k], input);
    const j = v.achievements.joint[0];
    const passive = Object.entries(v.options.byActor).filter(([, o]) => o.independent === 0).map(([a]) => a);
    row[k] = { verdictHash: v.verdictHash, closeAt: v.window.closeAt, closedBy: v.window.closedBy, winners: v.scores.leaderAtClose.nations, standingStatus: v.scores.status, prize: v.prize.status, worldEnds: v.world.ends,
      joint: j ? { status: j.status, at: j.achievedAt, reasons: j.reasons.map(r => r.code) } : null,
      awards: v.awards.length, noIndependentOption: passive, optionsAt: v.options.at };
  }
  rows.push(row);
}
writeFileSync(join(root, 'results', 'compare.json'), `${JSON.stringify(rows, null, 1)}\n`);
const cell = x => `${x.closeAt}${x.closedBy === 'schedule' ? '' : '＊'} / ${x.winners.join('+')}${x.standingStatus === 'decided' ? '' : '（判定不能）'} / ${x.joint ? `${ST[x.joint.status]}${x.joint.at !== null ? `@${x.joint.at}` : ''}` : '—'}`;
const md = ['# 3案の比較（生成：`node bin/compare.mjs`）', '',
  '各欄：評価期間が閉じた鐘（＊は共同達成で評価期間だけを閉じた。世界はどの案でも終わらない）/ その時点で要塞の規則で先頭の国（賞金ではない。賞金は A の旧経路の互換確認だけで、B・C は未決）/ 共同目標。数字は暫定の置き値での模型の結果で、人間で確かめていない。', '',
  '| シナリオ | A | B | C | C の判定の理由 |', '|---|---|---|---|---|',
  ...rows.map(r => `| ${r.scenario} | ${cell(r.A)} | ${cell(r.B)} | ${cell(r.C)} | ${r.C.joint?.reasons.join(', ') ?? ''} |`), '',
  '選択肢：どのシナリオ・どの案でも、待つ・従う以外の選択肢がない参加者は ' + (rows.every(r => ['A', 'B', 'C'].every(k => !r[k].noIndependentOption.length)) ? 'いなかった（評価期間が閉じた後も、世界の中の選択肢は残る）。' : 'いた（compare.json を見よ）。'),
  '世界：どの行・どの案でも `world.ends` は ' + (rows.every(r => ['A', 'B', 'C'].every(k => r[k].worldEnds === false)) ? 'false（評価期間を閉じても世界は終わらない）。' : 'true の行がある（不具合）。'),
  '複数の評価期間をまたぐ確認は boundary-crossing（表は最後の評価期間 W2 だけを示す）と test/continuity.test.mjs、長期は results/long-run.json。', ''];
writeFileSync(join(root, 'results', 'compare.ja.md'), md.join('\n'));
console.log(md.join('\n'));
