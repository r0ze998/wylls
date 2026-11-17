// node workstreams/14-central-tower/proto/report.mjs
// Writes results/RESULTS.ja.md from results/RESULTS.json (made by batch.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
const R = JSON.parse(readFileSync(join(dir, 'RESULTS.json'), 'utf8'));
const f = x => (x === null || x === undefined ? '—' : String(x));
const ci = (x, k) => (x.ci95?.[k] ? ` [${x.ci95[k][0]}, ${x.ci95[k][1]}]` : '');
const ROWS = [
  ['村の育ちの平均', x => f(x.level.all) + ci(x, 'level')],
  ['Aと比べた変化：塔に関わらなかった村', x => f(x.paired.nonParticipants) + ci(x, 'nonParticipants')],
  ['〃：関わった村', x => f(x.paired.participants) + ci(x, 'participants')],
  ['〃：近い村（輪2）', x => f(x.paired.near) + ci(x, 'near')],
  ['〃：遠い村（輪5以上）', x => f(x.paired.far) + ci(x, 'far')],
  ['〃：小国／大国', x => `${f(x.paired.smallNation)} ／ ${f(x.paired.bigNation)}`],
  ['〃：途中参加／資源少／協力しない', x => `${f(x.paired.late)} ／ ${f(x.paired.poor)} ／ ${f(x.paired.selfish)}`],
  ['他国との取引（件）', x => f(x.trades.cross) + ci(x, 'cross')],
  ['中央の環（0〜1）を通った荷の割合（面積比）', x => `${f(x.logistics.innerShare)}（${f(x.logistics.innerAreaShare)}）`],
  ['大協約の州を通った荷の割合', x => f(x.logistics.centreShare)],
  ['失った荷車', x => f(x.logistics.lostCaravans) + ci(x, 'lost')],
  ['払われなかった依頼', x => f(x.trades.defaulted)],
  ['1回の取引あたりの発送回数：近い／遠い', x => `${f(x.bands?.near?.sendsPerTrade)} ／ ${f(x.bands?.far?.sendsPerTrade)}`],
  ['C：完成段階の平均（3まで）', x => f(x.tower?.stages)],
  ['C：1段階以上／全段階が完成した種の割合', x => (x.completedStageShare ? `${x.completedStageShare.one} ／ ${x.completedStageShare.all}` : '—')],
  ['C：期限切れ／休止（回）', x => (x.tower ? `${x.tower.lapses} ／ ${x.tower.dormantEvents}` : '—')],
  ['C：出した国の数／集中度 HHI（6国均等=0.17）', x => (x.tower ? `${x.tower.contributorNations} ／ ${x.tower.contributionByNation.hhi}` : '—')],
  ['C：国ごとの出した量の割合（国0〜5、村数 10/10/6/6/3/3）', x => (x.tower ? x.tower.contributionByNation.shares.join(' / ') : '—')],
  ['C：役割の回数（運ぶ/差し出す/運び手/護衛/維持費）', x => (x.tower ? ['give', 'pledge', 'carry', 'escort', 'upkeep'].map(r => x.tower.roles[r]).join(' / ') : '—')],
  ['C：役割の多様さ（bit、最大2.32）／一人の仕事のうち同じ役割の割合', x => (x.tower ? `${x.tower.roleEntropyBits} ／ ${x.tower.meanMonotony}` : '—')],
  ['C：中継の交換のうち建設に加わっていない人の割合', x => f(x.tower?.freeRideShare)],
  ['C：中央付近での襲撃／うち達成目前（8割以上）', x => (x.tower ? `${x.tower.raids} ／ ${x.tower.raidsAtBrink}` : '—')],
];
let md = `# 比較結果（模型の出力）\n\n\`proto/batch.mjs ${R.seeds}\` で種 1〜${R.seeds} を走らせ、\`proto/report.mjs\` が書いた表です。手で数字を書き換えないでください。\n\n`
  + '- 各状況で、A・B・C を**同じ種（同じ土地・人・さいころ）**から走らせた平均です。角かっこは平均の95%区間（正規近似）。\n'
  + '- 「Aと比べた変化」は、同じ村が案Aのときと比べて「村の育ち」がいくつ変わったか。\n'
  + '- 模型の結果は人間にとっての面白さの証拠ではありません。数字はすべて仮です。\n\n';
for (const s of R.scenarios) {
  md += `## ${s.name}（\`${s.id}\`）\n\n| 測定 | A 基準 | B 掲示 | C 中継の倉 |\n|---|---:|---:|---:|\n`;
  for (const [l, g] of ROWS) md += `| ${l} | ${['A', 'B', 'C'].map(c => { try { return g(s[c]); } catch { return '—'; } }).join(' | ')} |\n`;
  md += '\n';
}
writeFileSync(join(dir, 'RESULTS.ja.md'), md);
console.log('wrote RESULTS.ja.md');
