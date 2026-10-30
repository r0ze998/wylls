// The way in to nations' cooperation (workstream 07): one slot in the S1
// village card, under the nation's council, that workstream 01 fills. The
// rules of cooperation between nations and of the central tower are 01's;
// this file decides none of them. With no entry registered the slot is
// empty and the page is as it was.
//
// 01 registers `{id, title, state(FS) → {available, why?}, open(FS)}`:
// `title` the button's words (in the page's language), `state` whether it
// can be pressed now and, when not, why (shown under it), `open` what
// pressing it does. The page calls `open` through the HUD action
// `coop-open`.
import { html, raw } from '../../util.mjs';
import { L } from '../../lang.mjs';

let entry = null;

/** 01's entry (one at a time; a second call replaces the first). Returns a function that removes it. */
export function registerCoopEntry(e) {
  if (!e || typeof e.id !== 'string' || typeof e.title !== 'function' || typeof e.state !== 'function' || typeof e.open !== 'function') throw new TypeError('coop entry: {id, title(), state(FS), open(FS)}');
  entry = e;
  return () => { if (entry === e) entry = null; };
}
/** The registered entry, or null. */
export const coopEntry = () => entry;

/** The slot: '' with no entry; else the button, and why it cannot be pressed when it cannot. */
export function renderCoopSlot(FS) {
  if (!entry) return '';
  let st;
  try { st = entry.state(FS) ?? { available: false }; } catch { st = { available: false, why: null }; }
  const why = st.available ? '' : html`<p class="blocked">${st.why ? String(st.why) : L`いまは使えません（理由を受け取れていません）`}</p>`;
  return html`<div class="ws07-coop" data-coop="${entry.id}"><button type="button" class="btn" data-act="coop-open" data-id="${entry.id}" ${raw(st.available ? '' : 'disabled')}>${String(entry.title())}</button>${why}</div>`;
}

/** The HUD action: open the entry if it is the one the button named and it can be pressed now. */
export function openCoop(FS, id) {
  if (!entry || entry.id !== id) return false;
  let st;
  try { st = entry.state(FS); } catch { return false; }
  if (!st?.available) return false;
  entry.open(FS);
  return true;
}
