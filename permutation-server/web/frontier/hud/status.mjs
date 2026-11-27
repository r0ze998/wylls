// What the action in hand is doing, said at the map (UX design 8.2: pending
// and refused are states with a picture, not only text): while a
// transaction is tracked, a chip with a progress ring; when it landed, the
// same chip with a check for a few seconds; when it was refused, a toast
// with the reason, "try again" and a way to put it away — never only a box
// inside a scrolled panel. One place for all three, first in the map's
// stack of notices (hud/feed.mjs), so there is one live region for it.
//
// The model is read from the store alone: `FS.notice` (the controller's
// busy / done / failed line) and, for a march being sent, its four steps
// (`FS.compose.step`: sealing, saved on this device, sent, on chain) as the
// ring's share. Pure; app.mjs renders it and remembers when it appeared.
import { html, raw } from '../../util.mjs';
import { L } from '../../lang.mjs';
import { failureText, unitCount } from '../fi18n.mjs';
import { UNIT_ORDER } from '../fland.mjs';
import { tileName } from './place.mjs';
import { SEND_STEPS } from '../fmarch.mjs';
import { icon } from './icons.mjs';
import { ring } from '../screens/parts.mjs';
import { AGENT_PAGE } from '../fdelegation.mjs';

/** A landed action's chip stays this long (ms); a refusal stays until it is put away or another action starts. */
export const DONE_MS = 4_000;

const STEP_TEXT = { sealing: () => L`封をしています`, saved: () => L`この端末に保存`, sent: () => L`送信`, onChain: () => L`ゲームに記録` };
const textOf = n => (typeof n?.text === 'function' ? n.text() : n?.text) ?? null;

/**
 * What a refused action left undone, by the action's name (`FS.lastAct`): the thing that was not sent, and for a
 * march where its host still is. (The second review: "That did not work / Not available right now" named neither
 * what had failed nor that nothing was sent and the host was still at home.)
 */
const UNSENT = {
  'march-send': FS => {
    const c = FS?.compose;
    if (!c?.host) return L`進軍は送られていません。`;
    const who = unitCount(UNIT_ORDER[c.host.unit], c.host.troops), where = c.origin ? tileName(FS, c.origin.p, c.origin.q, c.host.tile) : null;
    return where ? L`進軍は送られていません（${who} は${where}にいます）。` : L`進軍は送られていません。`;
  },
  harvest: () => L`収穫はまだされていません。`,
  build: () => L`建設はまだ始まっていません。`,
  train: () => L`訓練はまだされていません。`,
  muster: () => L`編成はまだ命じられていません。`,
  // (fix-loop29: the first village's scout — a Train and a Muster of their own buttons)
  'home-scout-train': () => L`訓練はまだされていません。`,
  'home-scout-muster': () => L`編成はまだ命じられていません。`,
  garrison: () => L`守備隊はまだ増えていません。`,
  dissolve: () => L`解散はされていません。`,
  join: () => L`参加はまだできていません。`,
  session: () => L`ゲーム内の鍵はまだできていません。`,
  'auto-ticket': () => L`村の申し込みはまだ出ていません。`,
  'explore-send': () => L`探索はまだ始まっていません。`,
  'settle-explore': () => L`探索の結果はまだ受け取れていません。`,
  'settle-transit': () => L`進軍の結果はまだ受け取れていません。`,
  // (fix-loop11, LP11-1: a boundary departure the chain refused after it was sent — controller departRefusedNotice; the
  //  live toast first read 「編成はまだ命じられていません。」, the last control pressed being the muster)
  'expedition-depart': () => L`遠征は出発していません。`,
  // (verify-pr184: a W2 step (「次の一手（広い土地）」, by a press or by the card's own wait) refused — controller wideHostStep;
  //  FS.lastAct is another control then, often a form at the rim village)
  'wide-host-step': () => L`広い土地の村の一手はまだ通っていません。`,
};
/**
 * (2026-11-17) A notice of an order that was SENT and whose outcome is not known: local play's (`LocalActUnconfirmed`,
 * controller localActAsk / actOnce), or the ordinary path's answer of `tx.track` (fplay.mjs: `unknown` → `Unconfirmed`,
 * `unqueryable` → `TxUnqueryable`). A refusal before sending carries neither.
 */
export const unconfirmedNotice = n => !!n && !n.ok && !n.busy && !n.waiting
  && (n.code === 'LocalActUnconfirmed' || ((n.code === 'Unconfirmed' || n.code === 'TxUnqueryable') && (n.state === 'unknown' || n.state === 'unqueryable')));

/** The line for a refused action: what was not done (null for an action this table does not know). */
export const unsentText = FS => UNSENT[FS?.lastAct?.name]?.(FS) ?? null;

/**
 * (fix-loop29) `unsent` of a refusal that no remembered send owns: the toast names nothing (no entry above), and no retry.
 * A press that is not one of the page's sends (app.mjs SENDS) leaves `FS.lastAct` as the EARLIER send; a refusal it left
 * was told as that send and its "Try again" re-ran it (loop-play29 BREAK-1: a refused muster said "Nothing has been
 * trained yet." and its retry trained 100 Spearmen).
 */
export const UNSENT_UNNAMED = 'unnamed';
const refusal = n => !!n && n.ok === false && !n.busy && !n.waiting && !n.loss;
/**
 * After a press that is not one of the page's sends: the refusal it left, made to name nothing and offer no retry —
 * unless the press set its own `FS.lastAct` (a send it made by itself: the muster's and the march's wait presses) or the
 * notice already says what it concerns (`unsent`). Null when there is nothing to change.
 */
export function unownedRefusal({ noticeBefore, notice, lastActBefore, lastAct }) {
  if (notice === noticeBefore || !refusal(notice) || lastAct !== lastActBefore || notice.unsent) return null;
  return { ...notice, unsent: UNSENT_UNNAMED, retry: false };
}
/** "Try again": the remembered send (`FS.lastAct`) run once more as it was — its action with its data, or its form with its values. */
export function retryAction(a, { actions, forms }) {
  if (!a) return undefined;
  if (a.kind === 'form') return forms[a.name]?.({ elements: Object.fromEntries(Object.entries(a.values ?? {}).map(([k, v]) => [k, { value: v }])), dataset: { form: a.name } });
  return actions[a.name]?.(a.data ?? {});
}

/**
 * The status to show: null, or `{state: 'busy'|'done'|'refused', text,
 * share (0–1 or null), step, steps, retry}`. `age` is how long the notice
 * has stood (ms): a landed action leaves after DONE_MS. `canRetry`: the
 * page remembers the action that was refused.
 */
export function statusOf(FS, { age = 0, canRetry = false } = {}) {
  const c = FS?.compose;
  if (c?.sending) {
    const i = SEND_STEPS.indexOf(c.step);
    return { state: 'busy', text: STEP_TEXT[c.step]?.() ?? STEP_TEXT.sealing(), share: (Math.max(0, i) + 0.5) / SEND_STEPS.length, step: Math.max(0, i) + 1, steps: SEND_STEPS.length, retry: false };
  }
  const n = FS?.notice;
  if (!n) return null;
  if (n.busy) return { state: 'busy', text: textOf(n) ?? L`送信中…`, share: null, step: null, steps: null, retry: false };
  // (round 45, seen in live33: a local waiting send's own lines carry what they are. `waiting`: the order is held and
  //  will be sent once — a pending state, not a refusal; `unsent`: the action a withdrawn wait concerns, which may not be
  //  the last control pressed (the wait's own button is not one of the page's sends); `retry: false`: "Try again" would
  //  re-run that last control — another order —, so it is not offered)
  if (n.waiting) return { state: 'busy', text: textOf(n) ?? L`送信待ち`, share: null, step: null, steps: null, retry: false };
  // (⑨/⑩ preview, screens/custody.mjs: a LOSS the viewer suffered — told as what happened, never as a refused action, no retry)
  if (n.loss) return { state: 'loss', text: textOf(n), share: null, step: null, steps: null, retry: false };
  if (n.ok) return age > DONE_MS ? null : { state: 'done', text: textOf(n) ?? L`完了しました`, share: 1, step: null, steps: null, retry: false };
  // (2026-11-17) SENT, OUTCOME NOT KNOWN: not a refusal and not "not sent" — its own state, with its own words (the
  // code's text, or the page's line with the signature), never "できませんでした" nor what a refused action left undone.
  // The retry button is offered exactly as before (that rule is the owner's: retry re-runs the last control).
  if (unconfirmedNotice(n)) return { state: 'unconfirmed', what: null, text: textOf(n) ?? failureText(n), share: null, step: null, steps: null, retry: !!canRetry && n.retry !== false, agentLink: false };
  const what = n.unsent ? UNSENT[n.unsent]?.(FS) ?? null : unsentText(FS);
  return { state: 'refused', what, text: textOf(n) ?? failureText(n), share: null, step: null, steps: null, retry: !!canRetry && n.retry !== false, agentLink: !!n.agentLink };
}

/** The status as the first toast of the map's stack (`role` alert for a refusal, status otherwise). */
export function renderStatus(st) {
  if (!st) return '';
  if (st.state === 'refused') {
    return html`<div class="toast tx tx-refused" role="alert">
      <span class="toast-icon">${icon('alert')}</span>
      <span class="toast-text"><span class="toast-kind">${L`できませんでした`}</span>${st.what ? html`<strong class="tx-what">${st.what}</strong> ` : ''}<span class="tx-why">${st.text}</span></span>
      <button type="button" class="toast-x" data-act="notice-close" aria-label="${L`閉じる`}">${icon('close')}</button>
      ${st.retry || st.agentLink ? html`<span class="toast-acts">${st.retry ? html`<button type="button" class="btn small primary" data-act="notice-retry">${icon('return')}${L`もう一度`}</button>` : ''}${st.agentLink ? html`<a class="btn small toast-link" href="${AGENT_PAGE}" data-agent-link="1">${L`代理人のページを開く`}</a>` : ''}</span>` : ''}
    </div>`;
  }
  // (2026-11-17) sent, outcome not known: a status (not an alert), its own words, no "できませんでした"; close and the
  // retry button as before
  if (st.state === 'unconfirmed') {
    return html`<div class="toast tx tx-unconfirmed" role="status">
      <span class="toast-icon">${icon('alert')}</span>
      <span class="toast-text"><span class="tx-why">${st.text}</span></span>
      <button type="button" class="toast-x" data-act="notice-close" aria-label="${L`閉じる`}">${icon('close')}</button>
      ${st.retry ? html`<span class="toast-acts"><button type="button" class="btn small primary" data-act="notice-retry">${icon('return')}${L`もう一度`}</button></span>` : ''}
    </div>`;
  }
  if (st.state === 'loss') {
    return html`<div class="toast tx tx-unconfirmed tx-loss" role="alert">
      <span class="toast-icon">${icon('alert')}</span>
      <span class="toast-text"><span class="tx-why">${st.text}</span></span>
      <button type="button" class="toast-x" data-act="notice-close" aria-label="${L`閉じる`}">${icon('close')}</button>
    </div>`;
  }
  const done = st.state === 'done';
  return html`<div class="toast tx tx-${st.state}" role="status">
    <span class="tx-ring">${done ? raw(`${ring(1)}`) : ring(st.share)}${done ? icon('check', 'tx-mark') : ''}</span>
    <span class="toast-text"><span class="tx-text">${st.text}</span>${st.steps ? html`<span class="toast-stamp">${st.step}/${st.steps}</span>` : ''}</span>
  </div>`;
}
