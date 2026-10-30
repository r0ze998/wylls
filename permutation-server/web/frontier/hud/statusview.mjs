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
//   arrivalView   a caravan's arrival in five states, none of which says it
//                 arrived when that is not known: past its arrival turn and
//                 not settled; settled with the amount taken in not verified;
//                 a verified part; verified in full; lost
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
/**
 * What is known of a caravan's arrival (workstream 07's five states; 04's own contract was not received, so its names
 * are to be matched against these: REQUESTS.ja.md ④-4). Being past the arrival turn is never "arrived".
 */
export const ARRIVAL_STATES = Object.freeze(['overdue', 'settledUnverified', 'verifiedIntake', 'verifiedPartial', 'verifiedFull', 'lost']);
/**
 * Why a settled arrival's intake is not verified: a storehouse (it cuts what is over its cap, and the record keeps the
 * whole cargo), the destination not readable, a season whose program's rules were not checked, an outcome not read.
 */
export const UNVERIFIED_WHY = Object.freeze(['vault', 'dstUnknown', 'rulesUnknown', 'outcomeUnknown']);
/** Why a known intake is not compared with the send: the send not read; the send named another place (a taken caravan). */
export const COMPARE_WHY = Object.freeze(['sentUnknown', 'dstChanged']);
/** 05: the four kinds of a cost. */
export const COST_PHASES = Object.freeze(['reserved', 'committed', 'unsettled', 'released']);

const count = n => (Number.isInteger(n) && n >= 0 ? n : null);
const isCargo = c => Array.isArray(c) && c.length === 8 && c.every(n => Number.isFinite(n) && n >= 0);
/** Eight whole amounts in the page's resource order, in words ("食料 400・木材 50", or "なし"). */
export const cargoText = c => c.map((n, i) => (n > 0 ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(Math.floor(n))}` : null)).filter(Boolean).join(L`・`) || L`なし`;
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
 * A caravan's arrival. `x`:
 *   {state: 'overdue', bell}                                    past turn `bell`, not concluded
 *   {state: 'settledUnverified', why, recorded?}                concluded; what went in is not verified
 *   {state: 'verifiedIntake', intake, compare}                  what went in is known; not compared with the send
 *   {state: 'verifiedPartial', basis, sent, arrived, wornBps?}  a part of the SEND RECORD's amount went in
 *   {state: 'verifiedFull', basis, sent, arrived, wornBps?}     all of the SEND RECORD's amount went in
 *   {state: 'lost', recorded?}                                  the cargo is lost (its destination was gone)
 * Cargo: eight whole amounts in the page's resource order (the records' units: under one is dropped). The send
 * record's amount is after the towers' wear: "full" is against it, never against what was first loaded, and the
 * first loaded amount and the road's loss are not worked out (`wornBps` is only what the send record says).
 */
export function arrivalView(x) {
  if (!x || !ARRIVAL_STATES.includes(x.state)) return notReceived('arrival', [`state: ${x?.state ?? 'missing'}`]);
  const units = L`数量は記録の単位です（1 未満は切り捨て）`;
  const basis = [L`比べた基準は送付記録の数量です。送付記録の数量は経路の減少を引いたあとの量で、最初に積んだ量と経路の損失は、この記録からは確定しません`,
    ...(Number(x.wornBps) > 0 ? [L`送付記録には経路の減少率 ${fmtNum(Number(x.wornBps) / 100)}% が記されています`] : [])];
  if (x.state === 'overdue') {
    if (!Number.isFinite(x.bell)) return notReceived('arrival', ['bell: missing']);
    return { ok: true, key: 'arrival:overdue', symbol: '…', tone: 'unknown', errors: [],
      text: L`到着予定のターン ${fmtNum(x.bell)} を過ぎました。まだ決着していません`,
      details: [L`着いたかどうかは、決着の記録が出るまでわかりません`] };
  }
  if (x.state === 'settledUnverified') {
    if (!UNVERIFIED_WHY.includes(x.why)) return notReceived('arrival', [`why: ${x.why ?? 'missing'}`]);
    const rec = isCargo(x.recorded) ? cargoText(x.recorded) : null;
    const details = {
      vault: [L`倉庫は上限を超えた分を切り捨てます。決着の記録には元の積荷${rec ? L`（${rec}）` : ''}が載るため、入った量は記録からはわかりません`],
      dstUnknown: [L`行き先を記録から読めないため、入った量は確かめられません`],
      rulesUnknown: [L`このシーズンのプログラムの版では、入った量の確かめ方を確認していません`],
      outcomeUnknown: [L`決着の結果を記録から読めないため、入った量は確かめられません`],
    }[x.why];
    return { ok: true, key: `arrival:settledUnverified:${x.why}`, symbol: '?', tone: 'unknown', errors: [], text: L`決着しました。入った量はまだ確かめられていません`, details };
  }
  if (x.state === 'lost') {
    const rec = isCargo(x.recorded) ? cargoText(x.recorded) : null;
    return { ok: true, key: 'arrival:lost', symbol: '✕', tone: 'loss', errors: [], text: rec ? L`積荷は失われました：${rec}` : L`積荷は失われました`, details: [L`行き先が無くなっていたため、どこにも入っていません（確定）`] };
  }
  if (x.state === 'verifiedIntake') {
    if (!isCargo(x.intake) || !COMPARE_WHY.includes(x.compare)) return notReceived('arrival', [...(isCargo(x.intake) ? [] : ['intake: missing']), ...(COMPARE_WHY.includes(x.compare) ? [] : [`compare: ${x.compare ?? 'missing'}`])]);
    return { ok: true, key: `arrival:verifiedIntake:${x.compare}`, symbol: '○', tone: 'result', errors: [],
      text: L`村に入った量：${cargoText(x.intake)}`,
      details: [x.compare === 'sentUnknown' ? L`送付記録を読めていないため、送った量の全部か一部かは比べられません` : L`送付記録の行き先と決着の行き先が違うため（途中で奪われた隊商など）、送付記録とは比べません`, units] };
  }
  const errors = [...(isCargo(x.arrived) ? [] : ['arrived: missing']), ...(isCargo(x.sent) ? [] : ['sent: missing']), ...(x.basis === 'sentRecord' ? [] : [`basis: ${x.basis ?? 'missing'}`])];
  if (errors.length) return notReceived('arrival', errors);
  if (x.state === 'verifiedPartial') {
    return { ok: true, key: 'arrival:verifiedPartial', symbol: '◐', tone: 'loss', errors: [],
      text: L`送付記録の数量に対して一部が入りました：${cargoText(x.arrived)}`,
      details: [L`送付記録の数量：${cargoText(x.sent)}`, ...basis, L`差の理由は、記録で確かめるまで決めません`, units] };
  }
  return { ok: true, key: 'arrival:verifiedFull', symbol: '●', tone: 'result', errors: [],
    text: L`送付記録の数量に対して全量が入りました：${cargoText(x.arrived)}`, details: [...basis, units] };
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
