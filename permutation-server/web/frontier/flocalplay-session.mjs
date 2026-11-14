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
import { CIV_NAMES } from '../i18n.mjs';

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

export const CONTEST_PAIR_MODE = 'contest-pair-v1';
const NATION_KEYS = ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'];
const nationName = n => CIV_NAMES[NATION_KEYS[n]] ?? `#${n}`;
/**
 * TEST-ONLY contest pair: the launcher's pair answer, checked again here (fail closed): the mode, the
 * role this page was given at its start, the WORLD it is about (`scope`: the herald and the end this page verified at its
 * own start — the same herald, the same instance, start, life and end — and that end not yet reached at `nowMs`), and
 * every number of the target. → `{state: 'pending' | 'predicted' | 'ready' | 'not_ready', nation, opponentNation, fort,
 * home}` or `{state: 'unavailable'}`.
 */
export function pairGuideView(body, role, scope, nowMs) {
  const p = body?.pair, t = p?.target;
  if (!p || typeof p !== 'object' || p.mode !== CONTEST_PAIR_MODE || (role !== 'first' && role !== 'second') || p.role !== role || !t || typeof t !== 'object') return { state: 'unavailable' };
  const w = p.world, e = w?.expiry, mine = scope?.expiry;
  const sameWorld = w && typeof w === 'object' && typeof scope?.herald === 'string' && w.herald === scope.herald && e && typeof e === 'object' && mine && typeof mine === 'object'
    && typeof mine.instance === 'string' && mine.instance.length > 0 && ['schema', 'instance', 'startedAt', 'ttlMs', 'expiresAt'].every(k => e[k] === mine[k])
    && Number.isFinite(e.expiresAt) && Number.isFinite(nowMs) && nowMs < e.expiresAt;
  if (!sameWorld) return { state: 'unavailable' };
  if (t.state === 'pending') return { state: 'pending' };
  const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi, pq = v => int(v, -1000, 1000);
  const ok = ['predicted', 'ready', 'not_ready'].includes(t.state) && int(t.nation, 0, 5) && int(t.opponentNation, 0, 5) && t.nation !== t.opponentNation
    && t.fort && pq(t.fort.p) && pq(t.fort.q) && int(t.fort.tile, 0, 60) && t.home && pq(t.home.p) && pq(t.home.q) && int(t.home.site, 0, 255) && int(t.home.tile, 0, 60);
  if (!ok) return { state: 'unavailable' };
  return { state: t.state, nation: t.nation, opponentNation: t.opponentNation, fort: { p: t.fort.p, q: t.fort.q, tile: t.fort.tile }, home: { p: t.home.p, q: t.home.q, site: t.home.site, tile: t.home.tile } };
}
/** The pair's guide in sentences for the SECOND player (who may defend): null for no view. The choice of nation stays free. */
export function pairGuideText(view) {
  if (!view || typeof view !== 'object') return null;
  if (view.state === 'unavailable') return L`二人用の対戦の情報を確認できませんでした（何も送信していません）。少ししてから、もう一度押してください。`;
  if (view.state === 'pending') return L`二人用の対戦はまだ決まっていません。相手が村を置くと、争う砦と国が決まります。少ししてから、もう一度確認してください。`;
  const nation = nationName(view.nation), opp = nationName(view.opponentNation);
  if (view.state === 'ready') return L`二人用の試験：相手（${opp}）の軍勢は 州 ${view.fort.p},${view.fort.q} の砦（${nation} が保持）に向かいます。あなたは ${nation} として、州 ${view.home.p},${view.home.q} の村からこの砦を守れます。二人の道を、世界の記録で確かめました。`;
  const base = L`二人用の試験：相手（${opp}）の軍勢は 州 ${view.fort.p},${view.fort.q} の砦（${nation} が保持）に向かいます。国を選ぶとき ${nation} を選ぶと、あなたはこの砦を守る側になります（標準の村候補は 州 ${view.home.p},${view.home.q} です）。ほかの国も選べますが、そのときは二人の争奪は用意されません。`;
  if (view.state === 'not_ready') return `${base} ${L`ただし、この世界では二人の争奪を用意できませんでした。終了して、新しい世界から始めてください。`}`;
  return base;
}

/** One notice per document: a second mount returns the first. */
const mounted = new WeakMap();

/**
 * `doc` / `win`: the page's (tests pass stand-ins); `onCheck`: the gate's keeper ask (optional). →
 * `{destroyed(), unmount(), isDestroyed(), …}`, or null without a document.
 */
export function mountSessionNotice({ doc = globalThis.document, win = globalThis.window, onCheck = null, demo = null, onPair = null } = {}) {
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
  // (a TEST-ONLY capture demo world says so on a fourth line, all session: its synthetic clock and its test participants)
  const isDemo = Number.isInteger(demo) && demo >= 10 && demo <= 60;
  const items = [el('li', 'local-play-session-point'), el('li', 'local-play-session-point'), el('li', 'local-play-session-point'), ...(isDemo ? [el('li', 'local-play-session-point local-play-session-demo')] : [])];
  list.append(...items);
  const gone = el('p', 'local-play-session-gone'); gone.hidden = true;
  box.append(title, short, list, gone);
  const asks = typeof onCheck === 'function';
  const check = asks ? el('button', 'local-play-session-check') : null, said = asks ? el('p', 'local-play-session-keeper') : null;
  if (asks) { check.type = 'button'; said.hidden = true; box.append(check, said); }
  // (TEST-ONLY contest pair, the second player only: the fort and nation to meet over, read on the player's own press)
  const pairs = typeof onPair === 'function';
  const pairCheck = pairs ? el('button', 'local-play-session-check local-play-session-pair') : null, pairSaid = pairs ? el('p', 'local-play-session-keeper local-play-session-pair-said') : null;
  if (pairs) { pairCheck.type = 'button'; pairSaid.hidden = true; box.append(pairCheck, pairSaid); }
  box.append(fold);
  let destroyed = false, live = true, end = null, moved = false, asking = false, answer = null, folded = false, pairAsking = false, pairAnswer = null;
  const label = () => {
    title.textContent = L`この試験世界について`;
    items[0].textContent = L`鍵はこのページのメモリにだけあります。再読み込み・タブを閉じると失われ、この世界は続けられません。`;
    items[1].textContent = end !== null ? L`この世界は ${endTimeText(end.expiresAt)} ごろに自動的に終わります（開始サービスが決めた時刻。この端末の時計で表示）。`
      : L`自動終了の予定時刻は、このページでは確認できません。開始サービスで決めた時間で終わります（既定は開始から2時間）。`;
    items[2].textContent = L`世界が終わると、その世界の進行は保存されません。`;
    if (isDemo) items[3].textContent = L`この世界は試験用の攻略デモです。時計は ${demo} 倍の合成時計で、ほかの村は試験参加者です（自然な世界の時間ではありません）。`;
    gone.textContent = L`このページの試験用の鍵は破棄されました。このページからこの世界は続けられません。新しい鍵や新しい世界は自動では作りません。`;
    short.textContent = L`鍵はこのページのメモリにだけあります。再読み込みすると、この世界は続けられません。`;
    fold.textContent = folded ? L`詳しく見る` : L`たたむ`;
    fold.setAttribute?.('aria-expanded', folded ? 'false' : 'true');
    if (asks) { check.textContent = asking ? L`確認しています…` : L`世界の進行を確認`; const t = keeperText(answer); said.textContent = t ?? ''; said.hidden = t === null; }
    if (pairs) { pairCheck.textContent = pairAsking ? L`確認しています…` : L`二人の対戦の国と砦を確認`; const t = pairGuideText(pairAnswer); pairSaid.textContent = t ?? ''; pairSaid.hidden = t === null; }
  };
  const paint = () => {
    const f = folded && !destroyed;
    list.hidden = destroyed || f; short.hidden = !f; gone.hidden = !destroyed; fold.hidden = destroyed;
    if (asks) { check.hidden = destroyed || f; check.disabled = asking; if (destroyed || f) said.hidden = true; }
    if (pairs) { pairCheck.hidden = destroyed || f; pairCheck.disabled = pairAsking; if (destroyed || f) pairSaid.hidden = true; }
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
  if (pairs) pairCheck.addEventListener?.('click', () => {
    if (!live || destroyed || pairAsking) return;
    pairAsking = true; label(); paint();
    Promise.resolve().then(onPair).then(v => v, () => ({ state: 'unavailable' })).then(v => {
      pairAsking = false;
      if (!live) return;
      if (v !== null && v !== undefined) pairAnswer = v;
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
