// LOCAL PLAY — the launcher world's standing notice, shown after the gate verified the world (launcher mode only).
//
// What stays true for the whole session, said once and kept on screen: the key lives only in this page's memory (a
// reload or closing the tab loses it and this world cannot be continued); the world ends by itself at a time this page
// cannot confirm (the start service sets it; two hours from its start by default), and its progress is not saved.
// After the page went away (`pagehide` destroyed the key) and came back from the browser's cache, it says only that
// this world cannot be continued from this page.
// The end is said only as `showEnd` is told it (flocalplay-instance.mjs: confirmed against the runner's own instance):
// a known view shows the real end time on this machine's clock; a later view of the same world with another end, or
// none, is not believed and the end is said to be unknown from then on. Once the key was discarded nothing is shown
// but that.
// It reads nothing, sends nothing, starts or stops nothing, makes no key and runs no timer: a display, with its one
// language listener and one window listener removed by `unmount`. With `onCheck` (the gate's), its one key asks the gate
// for the world's keeper on the player's press and shows the answer (`keeperText`); one ask at a time, never repeated.
import { L, onLangChange } from '../lang.mjs';
import { expiryStable } from './flocalplay-expiry.mjs';

export const SESSION_NOTICE_ID = 'local-play-session';
/** An end time on this machine's clock, `YYYY-MM-DD HH:MM` (the same in either language). */
export function endTimeText(ms) {
  const d = new Date(ms), two = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * The keeper's answer in one sentence (`onCheck`'s view): null for no view (nothing changes). Turns "processed
 * through" are the keeper's resolved_next − 1.
 */
export function keeperText(view) {
  if (!view || typeof view !== 'object') return null;
  if (view.state === 'unavailable') return L`世界の進行を確認できませんでした。開始サービスを確認して、もう一度押してください。`;
  if (view.state !== 'reported') return null;
  const k = view.keeper;
  if (!k || typeof k !== 'object') return L`世界の進行役の報告はまだありません。少し待ってから、もう一度確認してください。`;
  const through = Number.isSafeInteger(k.resolvedNext) && k.resolvedNext > 0 ? k.resolvedNext - 1 : null;
  switch (k.state) {
    case 'running': return through !== null ? L`世界の進行役は動いています（ターン ${through} まで処理済み）。` : L`世界の進行役は動いています。`;
    case 'waiting': return through !== null ? L`世界の進行役は、次の処理を待っています（ターン ${through} まで処理済み）。編成や進軍は、処理が進むと反映されます。`
      : L`世界の進行役は、次の処理を待っています。編成や進軍は、処理が進むと反映されます。`;
    case 'stopped': return L`世界の進行役は止まりました。この世界のターンはもう進まず、編成中の軍勢も進軍も進みません。`;
    case 'unknown': return L`世界の進行役は、送った処理の結果を確かめられず止まりました（同じ処理は再送しません）。この世界のターンはもう進みません。`;
    case 'partial': return k.part === 'unknown'
      ? L`世界の進行役は動いていますが、到着地または滞在先の処理の一つは、送った結果を確かめられず止まりました（再送しません）。その処理はもう進みません。`
      : L`世界の進行役は動いていますが、到着地または滞在先の処理の一つは拒否されて止まりました。その処理はもう進みません。`;
    default: return L`世界の進行を確認できませんでした。開始サービスを確認して、もう一度押してください。`;
  }
}

/** One notice per document: a second mount returns the first. */
const mounted = new WeakMap();

/**
 * `doc` / `win`: the page's (tests pass stand-ins); `onCheck`: the gate's keeper ask (optional). →
 * `{destroyed(), unmount(), isDestroyed(), …}`, or null without a document.
 */
export function mountSessionNotice({ doc = globalThis.document, win = globalThis.window, onCheck = null } = {}) {
  if (!doc?.createElement) return null;
  const prior = mounted.get(doc);
  if (prior) return prior;
  const el = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const box = el('section', 'local-play-session'); box.id = SESSION_NOTICE_ID;
  box.setAttribute?.('role', 'status');
  const title = el('p', 'local-play-session-title');
  // (folded on the player's press only — no timer: the key-loss warning stays as one line, and the whole notice comes
  // back when the key is discarded. The first-session review of 2026-11-13: the open notice covered the turn clock all session)
  const short = el('p', 'local-play-session-short'); short.hidden = true;
  const fold = el('button', 'local-play-session-fold'); fold.type = 'button';
  const list = el('ul', 'local-play-session-points');
  const items = [el('li', 'local-play-session-point'), el('li', 'local-play-session-point'), el('li', 'local-play-session-point')];
  list.append(...items);
  const gone = el('p', 'local-play-session-gone'); gone.hidden = true;
  box.append(title, short, list, gone);
  const asks = typeof onCheck === 'function';
  const check = asks ? el('button', 'local-play-session-check') : null, said = asks ? el('p', 'local-play-session-keeper') : null;
  if (asks) { check.type = 'button'; said.hidden = true; box.append(check, said); }
  box.append(fold);
  let destroyed = false, live = true, end = null, moved = false, asking = false, answer = null, folded = false;
  const label = () => {
    title.textContent = L`この試験世界について`;
    items[0].textContent = L`鍵はこのページのメモリにだけあります。再読み込み・タブを閉じると失われ、この世界は続けられません。`;
    items[1].textContent = end !== null ? L`この世界は ${endTimeText(end.expiresAt)} ごろに自動的に終わります（開始サービスが決めた時刻。この端末の時計で表示）。`
      : L`自動終了の予定時刻は、このページでは確認できません。開始サービスで決めた時間で終わります（既定は開始から2時間）。`;
    items[2].textContent = L`世界が終わると、その世界の進行は保存されません。`;
    gone.textContent = L`このページの試験用の鍵は破棄されました。このページからこの世界は続けられません。新しい鍵や新しい世界は自動では作りません。`;
    short.textContent = L`鍵はこのページのメモリにだけあります。再読み込みすると、この世界は続けられません。`;
    fold.textContent = folded ? L`詳しく見る` : L`たたむ`;
    fold.setAttribute?.('aria-expanded', folded ? 'false' : 'true');
    if (asks) { check.textContent = asking ? L`確認しています…` : L`世界の進行を確認`; const t = keeperText(answer); said.textContent = t ?? ''; said.hidden = t === null; }
  };
  const paint = () => {
    const f = folded && !destroyed;
    list.hidden = destroyed || f; short.hidden = !f; gone.hidden = !destroyed; fold.hidden = destroyed;
    if (asks) { check.hidden = destroyed || f; check.disabled = asking; if (destroyed || f) said.hidden = true; }
    if (box.dataset) { box.dataset.state = destroyed ? 'destroyed' : 'live'; box.dataset.end = end !== null ? 'known' : 'unknown'; box.dataset.fold = f ? 'folded' : 'open'; }
  };
  label(); paint();
  fold.addEventListener?.('click', () => { if (!live || destroyed) return; folded = !folded; label(); paint(); });
  if (asks) check.addEventListener?.('click', () => {
    if (!live || destroyed || asking) return;
    asking = true; label(); paint();
    Promise.resolve().then(onCheck).then(v => v, () => ({ state: 'unavailable' })).then(v => {
      asking = false;
      if (!live) return;
      if (v !== null && v !== undefined) answer = v;
      label(); paint();
    });
  });
  const unlabel = onLangChange(() => { if (live) { label(); paint(); } });
  // (back from the browser's cache after the page went away: the key is gone; say so again, change nothing else)
  const onShow = () => { if (live && destroyed) paint(); };
  win?.addEventListener?.('pageshow', onShow);
  (doc.body ?? doc.documentElement)?.append(box);
  const handle = Object.freeze({
    destroyed() { if (!live) return; destroyed = true; paint(); },
    /** A view of the end (`expiryView`): the first known one is shown; then only the same world's same end is kept. */
    showEnd(view) {
      if (!live || destroyed || moved) return;
      if (end === null) { if (view?.state === 'known') end = view; else return; }
      else if (!expiryStable(end, view)) { end = null; moved = true; }
      label(); paint();
    },
    endState: () => (end !== null ? 'known' : 'unknown'),
    isDestroyed: () => destroyed,
    unmount() {
      if (!live) return; live = false;
      unlabel?.(); win?.removeEventListener?.('pageshow', onShow);
      if (typeof box.remove === 'function') box.remove();
      else if (box.parent?.children) { box.parent.children.splice(box.parent.children.indexOf(box), 1); box.parent = null; }
      mounted.delete(doc);
    },
  });
  mounted.set(doc, handle);
  return handle;
}
