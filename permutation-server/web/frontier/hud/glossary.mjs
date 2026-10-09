// Terms explained where they appear (UI plan E3; Civ's nested tooltips and
// Civilopedia, kept to one level as Old World teaches): a small "?" next to
// a term opens a short definition with a link to the glossary in More. A
// definition never holds another term button — one level, no rabbit hole.
import { html } from '../../util.mjs';
import { L } from '../../lang.mjs';
import { icon } from './icons.mjs';

/**
 * The seal in ONE sentence, the same wherever it is said (UX design 11.13): the order card (hud/marchcard.mjs), the
 * map's legend (map/legend.mjs) and this help. The rule (docs/frontier/DESIGN.md, "Marching with a sealed
 * destination"): the seal is locked to the end of the arrival turn, so nobody else can open it before; the sender's
 * own device may reveal from the start of that turn, when the turn's arrivals and defenders are already fixed. So
 * the sentence speaks of who can OPEN the seal, never of "only you see it until the turn ends".
 */
export const sealLine = () => L`行き先と構えは封印され、到着のターンが終わるまで、ほかの人には開けられません。`;

export const TERMS = Object.freeze({
  // the one line that ties the bell to the turn (every number on the screen is a turn's; the bell is what tolls)
  bell: { name: () => L`ターンと鐘`, text: () => L`10分ごとの区切りがターンです。鐘が鳴るたびにターンが進みます。同じターンに同じ州へ着いた軍勢の衝突は、まとめて一度に決まります。守り手に数えられるのは、ターンの始まりにそこにいた軍勢です。` },
  stance: { name: () => L`構え`, text: () => L`進軍の戦い方です。突撃は側撃に、側撃は迎撃に、迎撃は突撃に強く、待機の構えには相性がありません。` },
  retreat: { name: () => L`撤退の倍率`, text: () => L`守り手の兵が自軍のこの倍率を超えていたら、戦わずに引き返します（損失なし）。` },
  seal: { name: () => L`封`, text: () => `${sealLine()}${L`ほかの人に見えるのは、出発したこと、出発地、兵の数、到着のターンです。到着のターンが始まると、あなたの端末が先に封を開けることがあります。そのときにはもう、そのターンの到着も守り手も変えられません。`}` },
  dormant: { name: () => L`休眠`, text: () => L`領主が長く何もしないと村は休眠し、さらに放っておくと手放されます。何か操作すれば延びます。` },
  ring: { name: () => L`輪`, text: () => L`大協約を中心にした州の輪です。シーズンが進むと外側の輪がひらきます。` },
  garrison: { name: () => L`守備隊`, text: () => L`村に残る守り手です。ターンの始まりにいた分が数えられ、攻め手に反撃します。城壁があると強くなります。` },
  vigil: { name: () => L`夜番`, text: () => L`毎日決まった時間、あなたが眠っている間も守りを固める時間帯です。` },
  shield: { name: () => L`保護`, text: () => L`村ができてしばらくは攻められません。保護が切れるまでの時間です。` },
  tier: { name: () => L`段階`, text: () => L`集落・町・都市・城塞の四つです。上がるほど生産と守りが増えます。` },
});

/** The "?" button after a term (`key` in TERMS). */
export const termButton = key => (TERMS[key] ? html`<button type="button" class="term-q" data-act="term" data-term="${key}" aria-label="${L`${TERMS[key].name()}とは`}" aria-haspopup="dialog">?</button>` : '');

/** The popover's body for one term. */
export function renderTerm(key) {
  const t = TERMS[key];
  if (!t) return '';
  return html`<div class="res-pop-head"><strong>${t.name()}</strong><span></span><button type="button" class="btn small pop-x" data-act="term-close" aria-label="${L`閉じる`}">${icon('close')}</button></div>
    <p>${t.text()}</p><p><button type="button" class="btn small" data-act="glossary-open">${L`用語集を開く`}</button></p>`;
}

/** The glossary (More): every term and its definition. */
export function renderGlossary() {
  return html`<section aria-labelledby="glossary-title" id="glossary"><h3 id="glossary-title">${L`用語集`}</h3>
    <dl class="glossary">${Object.values(TERMS).map(t => html`<div><dt>${t.name()}</dt><dd>${t.text()}</dd></div>`)}</dl></section>`;
}
