// The legend of the survey and its one honest line (UX brief §3): what the
// four materials of the play map mean, that nothing is being kept from the
// viewer (every record is public; the spectator page shows all of it), and
// the two things that really cannot be seen by anyone until their time.
// Markup only; the swatches are classes of frontier.css (no inline style).
import { html } from '../../util.mjs';
import { L } from '../../lang.mjs';

/** The four levels: `[{id, name(), text()}]`, nearest first. */
export const SURVEY_LEGEND = Object.freeze([
  { id: 'sight', name: () => L`視界`, text: () => L`あなたの村と軍勢から、いま見えている範囲です。村も軍勢も、そこで起きていることも描きます。` },
  { id: 'surveyed', name: () => L`測量済み`, text: () => L`前に見た範囲です。土地と村を、色を落として描きます。` },
  { id: 'chart', name: () => L`未測量`, text: () => L`まだ見ていない範囲です。地形だけを図にしています。` },
  { id: 'cloud', name: () => L`雲海`, text: () => L`まだひらいていない輪です。土地そのものがまだありません。` },
]);

/**
 * The lit tiles of a selected host (map/actions.mjs): `[{id, name(), text()}]`. Each kind also carries a small
 * mark on the map, so the colour is never the only sign.
 */
export const ACTION_LEGEND = Object.freeze([
  { id: 'move', name: () => L`進める`, text: () => L`軍勢が近くで進めるマスです。光っていないマスも、タップすれば届くかどうかを確かめます。` },
  { id: 'attack', name: () => L`攻める`, text: () => L`蛮族の野営地、敵対する国の村や軍勢がいるマスです。` },
  { id: 'home', name: () => L`自分の村`, text: () => L`あなたの村へ戻るマスです。` },
  { id: 'explore', name: () => L`探索`, text: () => L`斥候が探索できる隣のマスです。` },
]);

/** The help line of the brief. */
export const surveyLine = () => L`地図には、あなたが見て測量した範囲を描いています。隠しているのではありません。チェーンの記録はすべて公開で、観戦ページでは全体を見られます。本当に見えないのは、封印した進軍の行き先と構え（到着のターンが終わるまで）と、探索の結果（そのターンの乱数が出るまで）だけです。`;

/** The section for the play page's panel: the legend, the line, the way to the whole public world. */
export function renderSurveyHelp() {
  return html`<section class="survey-help" aria-labelledby="survey-help-title"><h3 id="survey-help-title">${L`地図の見かた`}</h3>
    <ul class="survey-legend">${SURVEY_LEGEND.map(x => html`<li><span class="survey-key survey-${x.id}" aria-hidden="true"></span><span class="survey-what"><strong>${x.name()}</strong> ${x.text()}</span></li>`)}</ul>
    <p class="survey-line">${surveyLine()}</p>
    <h4>${L`軍勢を選ぶと光るマス`}</h4>
    <ul class="survey-legend">${ACTION_LEGEND.map(x => html`<li><span class="survey-key lit-${x.id}" aria-hidden="true"></span><span class="survey-what"><strong>${x.name()}</strong> ${x.text()}</span></li>`)}</ul>
    <p><a class="survey-all" href="spectate.html">${L`観戦ページで世界全体を見る`}</a></p></section>`;
}
