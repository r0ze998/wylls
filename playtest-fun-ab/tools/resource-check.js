// Which resource limits armies? Bot games in version A; average stock of
// each resource at several rounds. Run: node tools/resource-check.js
// Writes logs/RESOURCE-CHECK.ja.md. (This is why version B ties food, not
// only ore and gold, to keeps: see docs/01-HYPOTHESES.ja.md.)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const E = require('../proto/engine.js');
const B = require('../proto/bots.js');

const POL = ['balanced', 'raider', 'counter'];
const AT = [6, 12, 18, 24, 30, 35];
const RES = ['food', 'wood', 'stone', 'ore', 'gold', 'arms'];
const sums = {}; const prod = {}; const tight = {};
const byPol = {}; // policy|resource -> [stock, income] over rounds 12..35
let n = 0;
for (const a of POL) for (const b of POL) for (const c of POL) for (let seed = 1; seed <= 10; seed++) {
  const s = E.newGame({ variant: 'A', seed, policies: [a, b, c] });
  while (!s.over) {
    const rep = E.advance(s, B.decideAll(s));
    if (s.round >= 12) {
      for (const nat of s.nations) for (const r of RES) {
        const k = `${nat.policy}|${r}`;
        if (!byPol[k]) byPol[k] = [0, 0];
        byPol[k][0] += nat.res[r];
        byPol[k][1] += Math.max(1, rep.production[nat.id][r]);
      }
    }
    if (AT.includes(s.round)) {
      for (const nat of s.nations) for (const r of RES) {
        const k = `${s.round}|${r}`;
        const p = Math.max(1, rep.production[nat.id][r]);
        sums[k] = (sums[k] || 0) + nat.res[r];
        prod[k] = (prod[k] || 0) + p;
        // Stock at the end of the round no more than ~1.5 rounds of income:
        // what was there before this round's income was spent.
        if (nat.res[r] <= 1.5 * p) tight[k] = (tight[k] || 0) + 1;
      }
    }
  }
  n += 3;
}
const L = ['# どの資源が兵の数を縛っているか（A 版、ボット同士）', '',
  `- 生成：\`node tools/resource-check.js\`。方針 ${POL.join('・')} の 27 通り × 条件番号 10、国ごとに数えて ${n} 国分の平均`,
  '- 数字は「ラウンドの終わりにたまっている量 ÷ そのラウンドに入った量」。1 前後なら、毎ラウンド入った分をほぼ使い切っている（その資源が兵の数を縛っている）。大きいほど余っている', '',
  `| ラウンド | ${RES.filter(r => r !== 'arms').map(r => E.RES_NAME[r]).join(' | ')} |`, `|---|${RES.filter(r => r !== 'arms').map(() => '---').join('|')}|`];
for (const t of AT) L.push(`| ${t} | ${RES.filter(r => r !== 'arms').map(r => `${(sums[`${t}|${r}`] / prod[`${t}|${r}`]).toFixed(1)} 倍（使い切り ${Math.round(100 * (tight[`${t}|${r}`] || 0) / n)}%）`).join(' | ')} |`);
L.push('', '「使い切り」は、たまっている量がそのラウンドに入った量の 1.5 倍以下だった国の割合です。兵器は工房を建てた国だけが作るので、表から外しています。');
L.push('', '## 方針ごと（ラウンド 12〜36 の平均。たまっている量 ÷ 収入）', '',
  `| 方針 | ${RES.filter(r => r !== 'arms').map(r => E.RES_NAME[r]).join(' | ')} |`, `|---|${RES.filter(r => r !== 'arms').map(() => '---').join('|')}|`);
for (const p of POL) L.push(`| ${p} | ${RES.filter(r => r !== 'arms').map(r => `${(byPol[`${p}|${r}`][0] / byPol[`${p}|${r}`][1]).toFixed(1)} 倍`).join(' | ')} |`);
L.push('', '読み方：どの方針でも、食料が一番たまっていない（収入に対して少ない）なら、兵の数を縛っているのは食料です。raider は毎ラウンド払える限り訓練し、balanced と counter は次の建物の分を少し残します。人間のプレイヤーは違う使い方をするかもしれません。');
const out = path.join(__dirname, '..', 'logs', 'RESOURCE-CHECK.ja.md');
fs.writeFileSync(out, L.join('\n') + '\n');
console.log(L.join('\n'));
