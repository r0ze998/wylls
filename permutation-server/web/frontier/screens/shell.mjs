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
import { icon } from '../hud/icons.mjs';

export const TAB_IDS = Object.freeze(['map', 'holding', 'hosts', 'marches', 'more']);
const TAB_TEXT = { map: () => L`地図`, holding: () => L`村`, hosts: () => L`軍勢`, marches: () => L`進軍`, more: () => L`その他` };
export const tabLabel = id => TAB_TEXT[id]?.() ?? id;

/** Lamports with thousands separators ("14,441 lamports"). */
export const lamports = n => L`${fmtNum(Number(n))} ランポート`;
/** A chain time as the viewer's local hh:mm (UTC in the title attribute). */
export function clockTime(t) {
  const d = new Date(Number(t) * 1000);
  const loc = lang() === 'en' ? 'en-GB' : 'ja-JP';
  return { local: d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }), utc: d.toISOString().slice(11, 16) };
}
export const timeHtml = t => { const c = clockTime(t); return html`<time datetime="${new Date(Number(t) * 1000).toISOString()}" title="${c.utc} UTC">${c.local}</time>`; };
/** "in 6:12" / "6:12 ago". */
export const inTime = secs => (secs >= 0 ? L`あと ${countdown(secs)}` : L`${countdown(-secs)} 前`);

/** The faction chip's text, or null before joining. */
export const factionChip = citizen => (citizen ? factionName(citizen.faction) : null);
/** The quota chip: sponsored transactions left (§8.3; the relay pays their fees), or null. Said as what the player can still do. */
export const quotaChip = q => (q && Number.isFinite(Number(q.left)) ? L`送れる操作 残り ${fmtNum(Number(q.left))} 回` : null);

/** The dock's icons (hud/icons.mjs). */
export const TAB_ICON = Object.freeze({ map: 'chart', holding: 'home', hosts: 'sword', marches: 'banner', more: 'scroll' });

/**
 * The dock: `[{id, label, icon, current}]`; Village and Hosts only once the
 * viewer holds land. `open` is what the drawer shows (hud/drawer.mjs): a
 * report or a practice run over a tab leaves no dock button current, and
 * with the drawer closed "Map" is.
 */
export function tabs(FS, open = FS.tab ?? 'map') {
  const land = FS.land?.stage;
  const holds = land === 'provisional' || land === 'final';
  return TAB_IDS.filter(id => holds || !['holding', 'hosts'].includes(id)).map(id => ({ id, label: tabLabel(id), icon: TAB_ICON[id], current: open === id }));
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
