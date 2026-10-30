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
    row[k] = { verdictHash: v.verdictHash, closeAt: v.period.closeAt, closedBy: v.period.closedBy, winners: v.prize.winners, prizeStatus: v.prize.status,
      joint: j ? { status: j.status, at: j.achievedAt, reasons: j.reasons.map(r => r.code) } : null,
      awards: v.awards.length, noIndependentOption: passive, optionsAt: v.options.at };
  }
  rows.push(row);
}
writeFileSync(join(root, 'results', 'compare.json'), `${JSON.stringify(rows, null, 1)}\n`);
const cell = x => `${x.closeAt}${x.closedBy === 'schedule' ? '' : '＊'} / ${x.winners.join('+')}${x.prizeStatus === 'decided' ? '' : '（判定不能）'} / ${x.joint ? `${ST[x.joint.status]}${x.joint.at !== null ? `@${x.joint.at}` : ''}` : '—'}`;
const md = ['# 3案の比較（生成：`node bin/compare.mjs`）', '',
  '各欄：戦期が閉じた鐘（＊は共同達成による区切り）/ 賞金を受け取る国 / 共同目標。数字は暫定の置き値での模型の結果で、人間で確かめていない。', '',
  '| シナリオ | A | B | C | C の判定の理由 |', '|---|---|---|---|---|',
  ...rows.map(r => `| ${r.scenario} | ${cell(r.A)} | ${cell(r.B)} | ${cell(r.C)} | ${r.C.joint?.reasons.join(', ') ?? ''} |`), '',
  '選択肢：どのシナリオ・どの案でも、待つ・従う以外の選択肢がない参加者は ' + (rows.every(r => ['A', 'B', 'C'].every(k => !r[k].noIndependentOption.length || r[k].optionsAt >= r[k].closeAt)) ? 'いなかった（戦期が閉じた後を除く）。' : 'いた（compare.json を見よ）。'), ''];
writeFileSync(join(root, 'results', 'compare.ja.md'), md.join('\n'));
console.log(md.join('\n'));
