// The legend of the survey and its one honest line (UX brief §3): what the
// four materials of the play map mean, that nothing is being kept from the
// viewer (every record is public; the spectator page shows all of it), and
// the two things that cannot be seen yet: a sealed march's destination and
// stance (in the one sentence the order card and the help also say:
// hud/glossary.mjs sealLine, UX design 11.13) and what an exploration finds.
// Markup only; the swatches are classes of frontier.css (no inline style).
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { sealLine } from '../hud/glossary.mjs';
import { icon } from '../hud/icons.mjs';
import { reachSteps } from '../hud/reach.mjs';
import { MAX_PATH_STEPS } from '../seal.mjs';

/** How many tiles about a rested host the lit reach covers (hud/reach.mjs: the preview's cap). */
const REACH_NEAR = reachSteps(Infinity);

/** The four levels: `[{id, name(), text()}]`, nearest first. */
export const SURVEY_LEGEND = Object.freeze([
  { id: 'sight', name: () => L`視界`, text: () => L`あなたの村と軍勢から、いま見えている範囲です。村も軍勢も、そこで起きていることも描きます。` },
  { id: 'surveyed', name: () => L`測量済み`, text: () => L`前に見た範囲です。土地と村を、色を落として描きます。` },
  { id: 'chart', name: () => L`未測量`, text: () => L`まだ見ていない範囲です。地形だけを図にしています。` },
  { id: 'cloud', name: () => L`雲海`, text: () => L`まだひらいていない輪です。土地そのものがまだありません。` },
]);

/**
 * What a selected host can do (map/actions.mjs): `[{id, name(), text()}]`. The reach is one outline; each kind of
 * target also carries its own mark on the map, so the colour is never the only sign.
 */
export const ACTION_LEGEND = Object.freeze([
  { id: 'move', name: () => L`進める`, text: () => L`淡い線で囲んだ内側が、軍勢のまわり ${fmtNum(REACH_NEAR)} マスです。線の外のマスも、道がつながっていれば行き先にできます（${fmtNum(MAX_PATH_STEPS)} マスまで）。` },
  { id: 'attack', glyph: 'swords', name: () => L`攻める`, text: () => L`蛮族の野営地、敵対する国の村や軍勢がいるマスです。` },
  { id: 'home', glyph: 'home', name: () => L`自分の村`, text: () => L`あなたの村へ戻るマスです。` },
  { id: 'explore', glyph: 'eye', name: () => L`探索`, text: () => L`斥候が探索できる隣のマスです。` },
]);
/** The lines of the map: `[{id, name(), text()}]`: the rim of the viewer's own land, and where one province ends. */
export const LINE_LEGEND = Object.freeze([
  { id: 'own', name: () => L`あなたの村のまわり`, text: () => L`国の色の帯と金の線で囲んだ内側が、あなたの村がはたらく土地です。仮の村は線が点線です。` },
  { id: 'province', name: () => L`州の境`, text: () => L`濃い線が州の境です。同じターンに同じ州へ着いた軍勢がぶつかります。` },
]);

/** The help line of the brief: the map draws what was surveyed, nothing is kept back, and only two things cannot be seen yet. */
export const surveyLine = () => L`地図には、あなたが見て測量した範囲を描いています。隠しているのではありません。チェーンの記録はすべて公開で、観戦ページでは全体を見られます。いま見られないものは、次の二つだけです。`;
/** The two things: `[{id, name(), text()}]` — the sealed march in the seal's one sentence, and an exploration's result. */
export const UNSEEN = Object.freeze([
  { id: 'seal', name: () => L`封印した進軍`, text: () => sealLine() },
  { id: 'explore', name: () => L`探索の結果`, text: () => L`そのターンの結果が出るまで、誰にもわかりません。` },
]);

/** The section for the play page's panel: the legend, the line, the way to the whole public world. */
export function renderSurveyHelp() {
  return html`<section class="survey-help" id="survey-help" aria-labelledby="survey-help-title"><h3 id="survey-help-title">${L`地図の見かた`}</h3>
    <ul class="survey-legend">${SURVEY_LEGEND.map(x => html`<li><span class="survey-key survey-${x.id}" aria-hidden="true"></span><span class="survey-what"><strong>${x.name()}</strong> ${x.text()}</span></li>`)}</ul>
    <p class="survey-line">${surveyLine()}</p>
    <ul class="survey-unseen">${UNSEEN.map(x => html`<li><strong>${x.name()}</strong> ${x.text()}</li>`)}</ul>
    <h4>${L`軍勢を選ぶと光るマス`}</h4>
    <ul class="lit-legend">${ACTION_LEGEND.map(x => html`<li><span class="survey-key lit-${x.id}" aria-hidden="true">${x.glyph ? icon(x.glyph) : ''}</span><span class="survey-what"><strong>${x.name()}</strong> ${x.text()}</span></li>`)}</ul>
    <h4>${L`地図の線`}</h4>
    <ul class="lit-legend">${LINE_LEGEND.map(x => html`<li><span class="survey-key line-${x.id}" aria-hidden="true"></span><span class="survey-what"><strong>${x.name()}</strong> ${x.text()}</span></li>`)}</ul>
    <p><a class="survey-all" href="spectate.html">${L`観戦ページで世界全体を見る`}</a></p></section>`;
}
