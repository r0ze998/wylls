// What the page shows for states other workstreams own (workstream 07): the
// display contract, not the states themselves. Workstream 04 owns the
// cancelling of sends and the arrival of goods; workstream 05 owns the cost
// of an order and the switch back to manual play. Neither's code was in
// hand when this was written, so each view takes a plain object whose
// fields are named here and checks it: a stage it does not know, or a field
// left out, is shown as "not received" and listed in `errors` — never
// filled in by a guess.
//
// Each view is `{ok, key, symbol, text, details: [text], tone, errors}`.
// The symbol and the words carry the state; the tone (a class name) only
// repeats it, so nothing is told by colour alone.
//
//   cancelView    04: new sends stopped → signed requests awaiting the
//                 chain → cancelled, with what had already taken effect
//   arrivalView   04: the arrived amount unverified, a part arrived, all
//                 arrived (an unverified amount is never a partial arrival)
//   costView      05: reserved, committed, unsettled, released
//   spendable     05: what the stores leave free after the costs, said as
//                 uncertain while any cost is unsettled
//   manualView    05: back to manual play; the orders already signed go on
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { RESOURCES } from '../fi18n.mjs';
import { RESOURCE_ORDER } from '../resources.mjs';

/** 04: the three stages of a cancel, in order. */
export const CANCEL_STAGES = Object.freeze(['stopNew', 'awaitSigned', 'cancelled']);
/** 04: what is known of an arrival. */
export const ARRIVAL_STATES = Object.freeze(['unverified', 'partial', 'full']);
/** 05: the four kinds of a cost. */
export const COST_PHASES = Object.freeze(['reserved', 'committed', 'unsettled', 'released']);

const count = n => (Number.isInteger(n) && n >= 0 ? n : null);
const isCargo = c => Array.isArray(c) && c.length === 8 && c.every(n => Number.isFinite(n) && n >= 0);
const cargoText = c => c.map((n, i) => (n > 0 ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(n)}` : null)).filter(Boolean).join(L`・`) || L`なし`;
const notReceived = (key, errors) => ({ ok: false, key, symbol: '?', text: L`状態を受け取れていません`, details: [], tone: 'unknown', errors });

/**
 * 04's cancel. `x`: `{stage, signedPending?: n, settled?: [{text}] | null}`.
 * `settled` is what took effect before the cancel (null: not received yet,
 * [] : nothing took effect).
 */
export function cancelView(x) {
  if (!x || !CANCEL_STAGES.includes(x.stage)) return notReceived('cancel', [`stage: ${x?.stage ?? 'missing'}`]);
  const n = count(x.signedPending);
  if (x.stage === 'stopNew') {
    return { ok: true, key: 'cancel:stopNew', symbol: '‖', tone: 'threat', errors: [],
      text: L`新しい送信を止めました`,
      details: [L`署名済みの要求はまだ止まっていません。チェーンの確認を待ちます`] };
  }
  if (x.stage === 'awaitSigned') {
    return { ok: true, key: 'cancel:awaitSigned', symbol: '⌛', tone: 'threat', errors: n === null ? ['signedPending: missing'] : [],
      text: n === null ? L`署名済みの要求の確認を待っています（件数は受け取っていません）` : L`署名済みの要求 ${fmtNum(n)} 件の確認を待っています`,
      details: [L`確認が済むまで、取消は終わっていません`] };
  }
  const settled = Array.isArray(x.settled) ? x.settled : null;
  return { ok: true, key: 'cancel:cancelled', symbol: '■', tone: 'result', errors: settled === null ? ['settled: missing'] : [],
    text: L`取消が終わりました`,
    details: settled === null ? [L`取消の前に成立した分は、まだ受け取っていません`]
      : settled.length ? [L`取消の前に成立した分は戻りません：`, ...settled.map(s => String(s.text ?? ''))]
      : [L`取消の前に成立した分はありません`] };
}

/**
 * 04's arrival. `x`: `{state, sent?: cargo, arrived?: cargo}` (cargo: eight
 * whole amounts in the page's resource order). An unverified arrival shows
 * no arrived amount at all; a partial one shows the recorded amount and
 * names no cause for the difference.
 */
export function arrivalView(x) {
  if (!x || !ARRIVAL_STATES.includes(x.state)) return notReceived('arrival', [`state: ${x?.state ?? 'missing'}`]);
  if (x.state === 'unverified') {
    return { ok: true, key: 'arrival:unverified', symbol: '?', tone: 'unknown', errors: [],
      text: L`到着量はまだ確かめられていません`,
      details: [L`確かめられるまで、届いた量としては数えません`] };
  }
  const errors = [...(isCargo(x.arrived) ? [] : ['arrived: missing']), ...(x.state === 'partial' && !isCargo(x.sent) ? ['sent: missing'] : [])];
  if (errors.length) return notReceived('arrival', errors);
  if (x.state === 'partial') {
    return { ok: true, key: 'arrival:partial', symbol: '◐', tone: 'loss', errors: [],
      text: L`一部が着きました：${cargoText(x.arrived)}`,
      details: [L`送った量：${cargoText(x.sent)}`, L`差の理由（略奪・道中の減り・置き場の上限）は、記録で確かめるまで決めません`] };
  }
  return { ok: true, key: 'arrival:full', symbol: '●', tone: 'result', errors: [], text: L`全部着きました：${cargoText(x.arrived)}`, details: [] };
}

/** 05's cost. `x`: `{phase, amounts?: cargo}`; an unsettled cost may have no amount yet. */
export function costView(x) {
  if (!x || !COST_PHASES.includes(x.phase)) return notReceived('cost', [`phase: ${x?.phase ?? 'missing'}`]);
  const amt = isCargo(x.amounts) ? cargoText(x.amounts) : null;
  if (x.phase !== 'unsettled' && amt === null) return notReceived('cost', ['amounts: missing']);
  const v = {
    reserved: { symbol: '◇', tone: 'threat', text: L`予約：${amt ?? ''}`, details: [L`まだ支払っていません。使える量からは引いて見せます`] },
    committed: { symbol: '◆', tone: 'result', text: L`確定：${amt ?? ''}`, details: [L`支払いが確定しました`] },
    unsettled: { symbol: '◇?', tone: 'unknown', text: amt === null ? L`未確定（額はまだ決まっていません）` : L`未確定：最大 ${amt}`, details: [L`予約とも確定とも違います。決まるまで支払ったとは言いません`] },
    released: { symbol: '↺', tone: 'gain', text: L`予約の解放：${amt ?? ''}`, details: [L`予約が戻りました。使える量に戻して数えます`] },
  }[x.phase];
  return { ok: true, key: `cost:${x.phase}`, errors: [], ...v };
}

/**
 * What the stores leave free once the costs are counted. `have`: cargo;
 * `costs`: costView inputs; `committedInHave`: whether 05's committed costs
 * have already left `have` (05 must say; undefined is an error, not a
 * guess). → `{ok, free: cargo, uncertain, errors}`.
 */
export function spendable(have, costs = [], { committedInHave } = {}) {
  const errors = [...(isCargo(have) ? [] : ['have: missing']), ...(typeof committedInHave === 'boolean' ? [] : ['committedInHave: missing'])];
  if (errors.length) return { ok: false, free: null, uncertain: true, errors };
  const free = [...have];
  let uncertain = false;
  for (const c of costs) {
    if (!COST_PHASES.includes(c?.phase)) { errors.push(`phase: ${c?.phase ?? 'missing'}`); uncertain = true; continue; }
    if (c.phase === 'released') continue;
    if (c.phase === 'committed' && committedInHave) continue;
    if (!isCargo(c.amounts)) { uncertain = true; continue; }
    // (an unsettled cost is held back at its most; the result says it is uncertain)
    if (c.phase === 'unsettled') uncertain = true;
    c.amounts.forEach((n, i) => { free[i] = Math.max(0, free[i] - n); });
  }
  return { ok: errors.length === 0, free, uncertain, errors };
}

/** 05's switch back to manual play. `x`: `{signedPending?: n}` — the orders already signed, which do not stop. */
export function manualView(x) {
  const n = count(x?.signedPending);
  return { ok: true, key: 'manual', symbol: '✋', tone: 'result', errors: n === null ? ['signedPending: missing'] : [],
    text: L`手動に戻しました`,
    details: [n === null ? L`すでに署名した操作は止まりません（件数は受け取っていません）` : n === 0 ? L`署名済みで進行中の操作はありません` : L`すでに署名した操作 ${fmtNum(n)} 件は止まらずに進みます`] };
}

/** A view as one status line: the symbol and the words first, the details under them (role=status, not colour). */
export function renderStatus(v) {
  return html`<div class="ws07-status tone-${v.tone}" role="status" data-key="${v.key}"><span class="ws07-sym" aria-hidden="true">${v.symbol}</span> <strong>${v.text}</strong>${v.details.length ? html`<ul class="ws07-status-details">${v.details.map(d => html`<li>${d}</li>`)}</ul>` : ''}</div>`;
}
