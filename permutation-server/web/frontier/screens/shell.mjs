// The play shell (web design §7.1; UX design section 6): the nation and
// quota chips of the top strip, the action dock (Map, Village, Hosts,
// Marches, More: icon-and-label buttons, bottom centre on desktop and the
// tab bar on phones), and the shared bits the screens use (lamports,
// times, the action notice). Renderers are pure: they read the store and
// return markup; app.mjs puts it in the page and routes `data-act` clicks.
//
// W5-E (web design §7.1, §10): on phones (< 760 px) the panel is a bottom
// sheet with three heights — peek, half, full — changed by its handle
// (tap cycles, a drag up or down moves one step), collapsed to peek by
// Escape (focus returns to the handle), and sized to the visual viewport
// so the on-screen keyboard never hides a field. It rests at the peek
// (about a quarter of the screen: the world has the rest); the page's
// drawer state (hud/drawer.mjs, applied by app.mjs through the returned
// `set`) lifts it to half when something opens. `boot` (app.mjs) mounts it
// on every Frontier page; on desktop the handle is hidden and the panel is
// the drawer that slides in from the right.
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum, lang, onLangChange } from '../../lang.mjs';
import { factionName, failureText } from '../fi18n.mjs';
import { countdown } from '../clock.mjs';
import { realTail, termsRate, spanWords } from '../seasonterms.mjs';
import { territoryEnabled } from '../territory.mjs';
import { icon } from '../hud/icons.mjs';

export const TAB_IDS = Object.freeze(['map', 'holding', 'hosts', 'marches', 'more']);
const TAB_TEXT = { map: () => L`地図`, holding: () => L`村`, hosts: () => L`軍勢`, marches: () => L`進軍`, territory: () => L`国と領土`, more: () => L`その他` };
export const tabLabel = id => TAB_TEXT[id]?.() ?? id;

/** Lamports with thousands separators ("14,441 lamports"). */
export const lamports = n => L`${fmtNum(Number(n))} ランポート`;
/**
 * (fix-loop22, LP22-3) The viewer's WALL time (unix seconds) at which chain time `t` comes, or null when it cannot be said:
 * now on the wall, plus the chain seconds left read at the world's pace (seasonterms termsRate: 1 at the natural clock,
 * the TEST world's ×N, null while a fast clock's pace is not known — never a guess). The chain's own clock is NOT the
 * viewer's: a kept 1× local world's Clock was about 116 days and 9 hours behind the wall (loop-play22: "around 10:31" at
 * 19:44), and a ×60 world's runs sixty times as fast. `now` is the chain's "now" (the caller's, else the page's —
 * `setChainNow`); `wall` the viewer's clock in ms (a test passes its own).
 */
export function wallOf(t, now = null, wall = Date.now()) {
  const n = Number.isFinite(now) ? now : chainNow();
  const r = termsRate();
  if (!Number.isFinite(Number(t)) || !Number.isFinite(n) || r === null || !(r >= 1)) return null;
  return wall / 1000 + (Number(t) - n) / r;
}
/** A wall time (unix seconds) as the viewer's local hh:mm (UTC in the title attribute). */
export function clockTime(w) {
  const d = new Date(Number(w) * 1000);
  const loc = lang() === 'en' ? 'en-GB' : 'ja-JP';
  return { local: d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }), utc: d.toISOString().slice(11, 16) };
}
/** A wall time (unix seconds, `wallOf`'s answer) as a <time> element. */
export const wallHtml = w => { const c = clockTime(w); return html`<time datetime="${new Date(Number(w) * 1000).toISOString()}" title="${c.utc} UTC">${c.local}</time>`; };
/**
 * A CHAIN time as the viewer's wall hh:mm (`wallOf`), or null when it cannot be said. (fix-loop22: it printed the chain's
 * own clock, which only a real cluster's chain shares with the viewer.)
 */
export const timeHtml = (t, now = null) => { const w = wallOf(t, now); return w === null ? null : wallHtml(w); };
/** How long `left` chain seconds are, in the world's own minutes: 「約 52 分」 / 「約 3時間58分」. */
const aboutWords = left => { const mins = Math.max(1, Math.round(left / 60)); return mins < 60 ? L`約 ${fmtNum(mins)} 分` : L`約 ${Math.floor(mins / 60)}時間${mins % 60}分`; };
/**
 * The parts of a due time: `{left, about, real, wall}` — chain seconds left (NaN without a "now"), the world's own length,
 * the real length on a faster clock ('' at the natural clock or an unknown pace: seasonterms realTail's words), and the
 * wall time it comes at (null when unknown; on a faster clock only when the real wait is a minute or more: a clock time
 * seconds away says nothing).
 */
/** The highest measured pace still said as the natural clock (no "real time" beside it). */
export const NATURAL_MAX = 1.25;
function dueParts(t, now) {
  const n = Number.isFinite(now) ? now : chainNow();
  const left = Number.isFinite(n) ? Number(t) - n : NaN;
  const r = termsRate();
  // (a kept 1× local world's measured pace wanders a little around 1: that is the natural clock, said as one)
  const fast = r === null || r > NATURAL_MAX;
  const w = left > 0 ? wallOf(t, n) : null;
  const wall = w !== null && (!fast || left / r >= 60) ? w : null;
  return { left, fast, about: left > 0 ? aboutWords(left) : '', real: left > 0 ? realTail(left) : '', wall };
}
/**
 * A chain time said with what it is (UX design 12.6: no bare timer without a label; the second check: the
 * provisional village's card said "(03:30 at the latest)"): how long from `now`, then the viewer's WALL clock time —
 * 「あと約 3時間58分（03:30 ごろ）」. On a faster clock the world's length and its real length (Q-EUA2-4), with the wall
 * time when the real wait is a minute or more. A time already past is 「まもなく」 (fix-loop22, LP22-3: it printed the
 * chain's clock — "around 19:53" at 19:37 in a ×60 world); one that cannot be placed says so.
 */
export function dueHtml(t, now = null) {
  const d = dueParts(t, now);
  if (!(d.left > 0)) return Number.isFinite(d.left) ? L`まもなく` : L`時刻はまだ分かりません`;
  if (d.fast) return d.wall !== null ? Lh`あと${d.about}（実時間で約 ${spanWords(d.left / termsRate())}・${wallHtml(d.wall)} ごろ）` : html`${Lh`あと${d.about}`}${d.real}`;
  return d.wall !== null ? Lh`あと${d.about}（${wallHtml(d.wall)} ごろ）` : Lh`あと${d.about}`;
}
/**
 * (pt-first-battle) `dueHtml` as plain text, for a sentence that is also a tooltip or a screen reader's name: 「あと約 52 分
 * （15:41 ごろ）」; on a faster clock the world's length and its real length. Never the chain's clock.
 */
export function dueText(t, now = null) {
  const d = dueParts(t, now);
  if (!(d.left > 0)) return Number.isFinite(d.left) ? L`まもなく` : L`時刻はまだ分かりません`;
  if (d.fast) return d.wall !== null ? L`あと${d.about}（実時間で約 ${spanWords(d.left / termsRate())}・${clockTime(d.wall).local} ごろ）` : `${L`あと${d.about}`}${d.real}`;
  return d.wall !== null ? L`あと${d.about}（${clockTime(d.wall).local} ごろ）` : L`あと${d.about}`;
}
/** How fast the world's clock runs against the viewer's (1 on a real cluster): the page sets it (`setClockPace`). */
let clockPace = () => 1;
export function setClockPace(fn) { clockPace = typeof fn === 'function' ? () => { try { const r = Number(fn()); return Number.isFinite(r) ? r : 1; } catch { return 1; } } : () => 1; }
export const clockPaceNow = () => clockPace();
/** The chain's "now" (seconds) as the page knows it, for a due time asked without one (app.mjs: `FS.chain.now()`). */
let chainNow = () => NaN;
export function setChainNow(fn) { chainNow = typeof fn === 'function' ? () => { try { const r = Number(fn()); return Number.isFinite(r) ? r : NaN; } catch { return NaN; } } : () => NaN; }
/** "in 6:12" / "6:12 ago". */
export const inTime = secs => (secs >= 0 ? L`あと ${countdown(secs)}` : L`${countdown(-secs)} 前`);

/** The faction chip's text, or null before joining. */
export const factionChip = citizen => (citizen ? factionName(citizen.faction) : null);
/** The quota chip: sponsored transactions left (§8.3; the relay pays their fees), or null. Said as what the player can still do. */
export const quotaChip = q => (q && Number.isFinite(Number(q.left)) ? L`送れる操作 残り ${fmtNum(Number(q.left))} 回` : null);

/** The dock's icons (hud/icons.mjs). */
export const TAB_ICON = Object.freeze({ map: 'chart', holding: 'home', hosts: 'sword', marches: 'banner', territory: 'flag', more: 'scroll' });

/**
 * The dock: `[{id, label, icon, current}]`; Village and Hosts only once the
 * viewer holds land. `open` is what the drawer shows (hud/drawer.mjs): a
 * report or a practice run over a tab leaves no dock button current, and
 * with the drawer closed "Map" is.
 */
export function tabs(FS, open = FS.tab ?? 'map') {
  const land = FS.land?.stage;
  const holds = land === 'provisional' || land === 'final';
  const ids = territoryEnabled(FS) || Number(FS.season?.programVersion ?? 0) >= 3 ? ['map', 'holding', 'hosts', 'marches', 'territory', 'more'] : TAB_IDS;
  return ids.filter(id => holds || !['holding', 'hosts'].includes(id)).map(id => ({ id, label: tabLabel(id), icon: TAB_ICON[id], current: open === id }));
}

export function renderTabs(FS, open) {
  return tabs(FS, open).map(t => html`<button type="button" class="tab" data-act="tab" data-tab="${t.id}" ${raw(t.current ? 'aria-current="page"' : '')}>${icon(t.icon)}<span class="tab-label">${t.label}</span></button>`);
}

/** The last action's outcome line: busy, done or the failure's text (§9.6). */
export function renderNotice(n) {
  if (!n) return '';
  const text = typeof n.text === 'function' ? n.text() : n.text;
  if (n.busy) return html`<p class="notice busy" role="status">${text ?? L`送信中…`}</p>`;
  if (n.ok) return html`<p class="notice ok" role="status">${text ?? L`完了しました`}</p>`;
  return html`<p class="notice error" role="alert">${text ?? failureText(n)}</p>`;
}

/**
 * A faction's colour swatch (colour is never the only signal: the name is
 * next to it). A class, not a style attribute: the CSP allows no inline
 * style (frontier.css `.f0`–`.f6` carry FACTION_COLORS).
 */
export const swatch = f => html`<span class="swatch f${Number.isInteger(f) && f >= 0 && f <= 6 ? f : 6}" aria-hidden="true"></span>`;

/** A labelled definition list row. */
export const row = (dt, dd) => html`<div class="row"><dt>${dt}</dt><dd>${dd}</dd></div>`;

/** The "as of" line every panel carries (web design §4.2). */
export const asOf = (slot, age) => (slot === null || slot === undefined ? '' : Lh`<p class="as-of">スロット ${fmtNum(slot)} 時点（${Math.round(age ?? 0)} 秒前）</p>`);

// ------------------------------------------------------------------ the bottom sheet (phones)
export const SHEET_STATES = Object.freeze(['peek', 'half', 'full']);
/** The next height when the handle is tapped: peek → half → full → peek. */
export const nextSheet = s => SHEET_STATES[(SHEET_STATES.indexOf(s) + 1) % SHEET_STATES.length] ?? 'half';
/** One step up (-1) or down (+1) after a drag of `dy` px (a drag under 24 px is a tap). */
export function dragSheet(s, dy) {
  if (Math.abs(dy) < 24) return null;
  const i = Math.max(0, SHEET_STATES.indexOf(s));
  return SHEET_STATES[Math.min(SHEET_STATES.length - 1, Math.max(0, i + (dy < 0 ? 1 : -1)))];
}
/** The handle's accessible name for a height. */
export const sheetLabel = s => (s === 'full' ? L`パネルを小さくする` : L`パネルを広げる`);
/** How long after a drag a click on the handle is the drag's own (ms). */
export const SUPPRESS_MS = 400;
/** Phones only: the sheet exists below the desktop breakpoint (frontier.css). */
export const PHONE_MAX = 759;

/**
 * Mount the sheet on `#panel` (idempotent): the handle first in the panel,
 * `data-sheet` on the panel, the keyboard, drag and tab rules, and the
 * visual-viewport height in `--vvh`. Returns `{set, state}` or null.
 */
export function mountSheet(doc = globalThis.document, win = globalThis.window) {
  const panel = doc?.getElementById?.('panel');
  if (!panel || panel.querySelector('[data-sheet-handle]')) return null;
  const phone = () => !win?.matchMedia || win.matchMedia(`(max-width: ${PHONE_MAX}px)`).matches;
  const handle = doc.createElement('button');
  handle.type = 'button';
  handle.className = 'sheet-handle';
  handle.dataset.sheetHandle = '';
  handle.setAttribute('aria-controls', 'panel-body');
  panel.prepend(handle);
  // The phone's back button closes a full sheet (UI plan E6): opening it full
  // pushes one history entry; back pops it and the sheet returns to half.
  let pushed = false, skipPop = false;
  const hist = win?.history;
  const set = (s, { fromPop = false } = {}) => {
    if (hist?.pushState && phone()) {
      if (s === 'full' && !pushed) { try { hist.pushState({ psSheet: 'full' }, ''); pushed = true; } catch { /* no history */ } }
      else if (s !== 'full' && pushed) { pushed = false; if (!fromPop) { skipPop = true; try { hist.back(); } catch { skipPop = false; } } }
    }
    panel.dataset.sheet = s;
    handle.setAttribute('aria-expanded', s === 'peek' ? 'false' : 'true');
    handle.setAttribute('aria-label', sheetLabel(s));
  };
  set('peek');
  onLangChange(() => set(panel.dataset.sheet));
  win?.addEventListener?.('popstate', () => {
    if (skipPop) { skipPop = false; return; }
    if (panel.dataset.sheet === 'full') set('half', { fromPop: true });
  });
  // Wave-5 review: a touch drag produces no click, so a drag must not wait
  // for one to clear its state (the next genuine tap was swallowed). The
  // drag ignores only a click that follows it within SUPPRESS_MS; pointer
  // capture keeps a mouse drag that ends off the 44-px handle.
  let drag = null;
  let suppressUntil = 0;
  const now = () => (win?.performance?.now?.() ?? Date.now());
  handle.addEventListener('pointerdown', e => {
    drag = { y: e.clientY, id: e.pointerId };
    try { handle.setPointerCapture?.(e.pointerId); } catch { /* not capturable (synthetic) */ }
  });
  const end = e => {
    const d = drag;
    drag = null;
    try { if (d && handle.hasPointerCapture?.(d.id)) handle.releasePointerCapture(d.id); } catch { /* released */ }
    const to = d && e.type === 'pointerup' ? dragSheet(panel.dataset.sheet, e.clientY - d.y) : null;
    if (to) { set(to); suppressUntil = now() + SUPPRESS_MS; }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('click', () => {
    if (now() < suppressUntil) { suppressUntil = 0; return; }
    set(nextSheet(panel.dataset.sheet));
  });
  panel.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !phone() || panel.dataset.sheet === 'peek') return;
    // A field that handles Escape itself (an open select) keeps it.
    if (e.defaultPrevented) return;
    set('peek');
    handle.focus();
  });
  const vv = win?.visualViewport;
  if (vv) {
    const fit = () => doc.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    vv.addEventListener('resize', fit);
    fit();
  }
  return { set, state: () => panel.dataset.sheet };
}

// app.mjs `boot` mounts the sheet (W6-D, W5-E R3); it no longer mounts itself on import.
