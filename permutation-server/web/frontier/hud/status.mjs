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
import { failureText } from '../fi18n.mjs';
import { SEND_STEPS } from '../fmarch.mjs';
import { icon } from './icons.mjs';
import { ring } from '../screens/parts.mjs';

/** A landed action's chip stays this long (ms); a refusal stays until it is put away or another action starts. */
export const DONE_MS = 4_000;

const STEP_TEXT = { sealing: () => L`封をしています`, saved: () => L`この端末に保存`, sent: () => L`送信`, onChain: () => L`チェーンに記録` };
const textOf = n => (typeof n?.text === 'function' ? n.text() : n?.text) ?? null;

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
  if (n.ok) return age > DONE_MS ? null : { state: 'done', text: textOf(n) ?? L`完了しました`, share: 1, step: null, steps: null, retry: false };
  return { state: 'refused', text: textOf(n) ?? failureText(n), share: null, step: null, steps: null, retry: !!canRetry };
}

/** The status as the first toast of the map's stack (`role` alert for a refusal, status otherwise). */
export function renderStatus(st) {
  if (!st) return '';
  if (st.state === 'refused') {
    return html`<div class="toast tx tx-refused" role="alert">
      <span class="toast-icon">${icon('alert')}</span>
      <span class="toast-text"><span class="toast-kind">${L`できませんでした`}</span>${st.text}</span>
      <button type="button" class="toast-x" data-act="notice-close" aria-label="${L`閉じる`}">${icon('close')}</button>
      ${st.retry ? html`<span class="toast-acts"><button type="button" class="btn small primary" data-act="notice-retry">${icon('return')}${L`もう一度`}</button></span>` : ''}
    </div>`;
  }
  const done = st.state === 'done';
  return html`<div class="toast tx tx-${st.state}" role="status">
    <span class="tx-ring">${done ? raw(`${ring(1)}`) : ring(st.share)}${done ? icon('check', 'tx-mark') : ''}</span>
    <span class="toast-text"><span class="tx-text">${st.text}</span>${st.steps ? html`<span class="toast-stamp">${st.step}/${st.steps}</span>` : ''}</span>
  </div>`;
}
