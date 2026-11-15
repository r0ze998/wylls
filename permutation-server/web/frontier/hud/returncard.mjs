// The expedition return card (2026-11-16): its words and its markup, apart from the inspection card around it
// (hud/hand.mjs expeditionPop), so it can be shown and checked on its own. Display only: it reads the model
// fexpedition-return.mjs originalReturnModel returns (ids only) and says it with L`…` in the shown language. It sends
// nothing, signs nothing and imports nothing beyond the language and markup helpers.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';

/** The card's words: the model holds ids only — the phase, `detail` and each step's id —; these say them in the shown
 * language. Unknown ids say the unavailable words. */
export const returnWords = Object.freeze({
  title: phase => ({
    'expedition-pending': () => L`遠征の処理待ち`,
    resident: () => L`広域に滞在中`,
    'leave-pending': () => L`解散の処理待ち`,
    'return-pending': () => L`予備兵へ戻す準備段階`,
  }[phase] ?? (() => L`帰還の状況を確認できません`))(),
  detail: id => ({
    OriginalDepartureResolution: () => L`出発元の戦闘解決を待っています。広域での滞在はまだ確認していません。`,
    OriginalDepartureSettlement: () => L`出発元の結果を受け取るのを待っています。広域での滞在はまだ確認していません。`,
    RevealOrGatherEvidence: () => L`公開・集計の証拠が必要です。帰還の段階はまだ判断できません。`,
    OriginDestroyedSettlementOrCleanupEvidence: () => L`出発元で失われた軍勢の結果の受け取りと後処理の確認が必要です。帰還完了を意味しません。`,
    DestinationResolveOrSettlementEvidence: () => L`到着先の解決と結果の受け取りの証拠が必要です。帰還の段階はまだ判断できません。`,
    resident: () => L`帰還には、まず広域で軍勢を解散し、そのターンの処理を待ちます。`,
    'leave-pending': () => L`解散の指示が記録されています。対象ターンの処理後にもう一度確認してください。`,
    'return-pending': () => L`解散のターン処理が済んだ記録です。元の村の予備兵に戻ったことは、まだ確認していません。`,
    'no-proposal': () => L`この観測だけでは提案を構築できません。必要な情報を確認し、もう一度観測してください。`,
  }[id] ?? (() => L`同じ軍勢と場所の観測を取り直してください。`))(),
  step: id => ({
    dissolve: () => L`広域で解散を指示`,
    'resolve-leave': () => L`ターン処理を待つ`,
    'return-reserve': () => L`元の村の予備兵に戻す`,
  }[id] ?? (() => ''))(),
});


/** The card itself, for a model of originalReturnModel. */
export function returnCard(returning) {
  return html`<section class="expedition-return" data-return-phase="${returning.phase}" aria-label="${L`帰還の手順`}">
          <p class="pop-line"><strong>${returnWords.title(returning.phase)}</strong></p>
          <p class="pop-line">${returnWords.detail(returning.detail)}</p>
          ${returning.steps.length ? html`<ol>${returning.steps.map(step=>html`<li data-return-step="${step.id}" data-step-state="${step.status}">${step.status==='proposal' ? html`<strong>${returnWords.step(step.id)}</strong>` : returnWords.step(step.id)}</li>`)}</ol>` : ''}
          ${returning.returnUnits !== null ? html`<p class="pop-line">${L`予備兵に戻す人数の候補: ${fmtNum(returning.returnUnits)}人`}</p>
            <p class="pop-line">${L`処理後の予備兵の見込み: ${fmtNum(returning.reserveAfter)}人`}</p>` : ''}
          <p class="pop-line pop-why">${L`帰還の送信はまだ利用できません。予備兵への加算も行っていません。`}</p>
        </section>`;
}
