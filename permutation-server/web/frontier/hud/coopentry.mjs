// The way in to nations' cooperation (workstream 07): one slot in the S1
// village card, under the nation's council, that workstream 01 fills. The
// rules of cooperation between nations and of the central tower are 01's;
// this file decides none of them. With no entry registered the slot is
// empty and the page is as it was.
//
// 01 registers `{id, title, state(FS) → {available, why?} | {hidden: true}, open(FS), detail?(FS) → {lines, links?} | null}`:
// `title` the button's words (in the page's language), `state` whether it
// can be pressed now and, when not, why (shown under it) — or `hidden` when
// the thing it opens is not on this server at all —, `open` what
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
  if (st.hidden === true) return '';
  const why = st.available ? '' : html`<p class="blocked">${st.why ? String(st.why) : L`いまは使えません（理由を受け取れていません）`}</p>`;
  // (2026-11-17) the entry may say more under its button (`detail(FS)` → `{lines}` or null): 01's lines about this village
  let d = null;
  try { d = typeof entry.detail === 'function' ? entry.detail(FS) : null; } catch { d = null; }
  const detail = d && Array.isArray(d.lines) && d.lines.length ? html`<div class="coop-detail">${d.lines.map(x => html`<p>${String(x)}</p>`)}</div>` : '';
  // (2026-11-17) and links into what it opens (`detail(FS).links` → [{href, text}]): a path on this origin only, in a new tab
  const sameOrigin = h => typeof h === 'string' && h.startsWith('/') && !h.startsWith('//') && !h.includes('\\');
  const links = d && Array.isArray(d.links) ? d.links.filter(x => x && sameOrigin(x.href) && typeof x.text === 'string') : [];
  const linkRow = links.length ? html`<div class="coop-links">${links.map(x => html`<a class="btn small" href="${x.href}" target="_blank" rel="noopener">${x.text}</a>`)}</div>` : '';
  return html`<div class="ws07-coop" data-coop="${entry.id}"><button type="button" class="btn" data-act="coop-open" data-id="${entry.id}" ${raw(st.available ? '' : 'disabled')}>${String(entry.title())}</button>${why}${detail}${linkRow}</div>`;
}

/**
 * (fix-loop8, LP8-3) The places the entry names as caravan destinations for this viewer (`destinations(FS)` →
 * `[{kind: 'holding', p, q, site, gen, coop: {id, need}}]`): 01's board knows them from requests this viewer accepted —
 * the request names its destination itself, a public record of the board. [] with no entry, no such hook, or a hook
 * that throws. Nothing is read here: the entry answers from what it has read.
 */
export function coopDestinations(FS) {
  if (!entry || typeof entry.destinations !== 'function') return [];
  let d;
  try { d = entry.destinations(FS); } catch { return []; }
  return Array.isArray(d) ? d : [];
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
