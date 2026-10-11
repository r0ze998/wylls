// What the HUD covers (UX design sections 4 and 6): the map canvas is
// full-bleed and the strip, the drawer, the dock and the phone sheet float
// over it, so "centre on X" must mean the centre of the part nothing
// covers. One function measures that from the page; the camera (map track)
// and the shell use the same numbers.
//
//   hudInsets()  → {top, right, bottom, left}  CSS px of the canvas covered at each edge
//   freeCentre() → {x, y, width, height}       the free rectangle's centre and size, canvas coordinates
//
// The corner pieces (plate, minimap, objective) are small and are not
// counted: a target may stand beside them. No DOM (tests): all zero.

const rectOf = el => (el?.getBoundingClientRect ? el.getBoundingClientRect() : null);
const shown = (el, view) => {
  if (!el || el.hidden) return false;
  const s = view?.getComputedStyle?.(el);
  return !s || (s.display !== 'none' && s.visibility !== 'hidden');
};

/** The canvas edges the HUD covers, in CSS px: the strip above; the open drawer at the right (desktop); the sheet or the dock below. */
export function hudInsets(doc = globalThis.document) {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  const canvas = doc?.getElementById?.('frontier-map');
  const c = rectOf(canvas);
  if (!c || !c.width || !c.height) return zero;
  const view = doc.defaultView;
  const out = { ...zero };
  const strip = rectOf(doc.getElementById('topbar'));
  if (strip) out.top = Math.max(0, Math.min(c.bottom, strip.bottom) - c.top);
  const panel = doc.getElementById('panel'), p = rectOf(panel);
  const sheet = !!panel && view?.getComputedStyle?.(panel).position === 'absolute';
  if (p && shown(panel, view)) {
    if (sheet) out.bottom = Math.max(0, c.bottom - Math.max(c.top, p.top));
    // a wide document stands over the middle of the map: it is not an edge, and nothing is counted for it
    else if (panel.dataset.drawer === 'open' && !panel.dataset.doc) out.right = Math.max(0, c.right - Math.max(c.left, p.left));
    // the nation choice stands along the foot of the map: the free part is what is above its banners
    else if (panel.dataset.drawer === 'open' && panel.dataset.doc === 'stage') out.bottom = Math.max(out.bottom, c.bottom - Math.max(c.top, p.top));
  }
  const dock = doc.querySelector?.('nav.tabs'), d = rectOf(dock);
  if (d && shown(dock, view) && d.top < c.bottom) out.bottom = Math.max(out.bottom, c.bottom - d.top);
  // the action bar stands where the dock stands while the viewer's own village or host is selected (hud/hand.mjs)
  const bar = doc.getElementById('hand'), b = rectOf(bar);
  if (b && shown(bar, view) && b.height > 0 && b.top < c.bottom) out.bottom = Math.max(out.bottom, c.bottom - b.top);
  // (and its card while a tile is being chosen on the board for it: the board's subject is framed above the card)
  const card = doc.getElementById('hand-pop'), k = rectOf(card);
  if (k && shown(card, view) && card.dataset.mode === 'card' && (card.dataset.pop === 'muster' || card.dataset.pop === 'keeps' || card.dataset.pick === 'dress' || (CARDS_OVER_BOARD.includes(card.dataset.pop) && (view?.innerWidth ?? 1440) >= 760)) && k.height > 0 && k.top < c.bottom) out.bottom = Math.max(out.bottom, c.bottom - k.top);
  // a phone with the prototype rule "banners" on: its chip, its score and the notices under them stand across the top
  // of the map, one under the other. A notice's 見る flew to the banner it told of and set it down under that very
  // notice (the loss states on real records, 2026-10-11: the pole and its count were not in sight). They are counted
  // as covered, as long as a third of the map's height stays free between them and the sheet.
  if (sheet && doc.body?.dataset?.proto) {
    let top = out.top;
    for (const el of [doc.getElementById('proto-chip'), doc.getElementById('proto-score'), ...(doc.querySelectorAll?.('#feed > *') ?? [])]) {
      const r = rectOf(el);
      if (r && shown(el, view) && r.height > 0 && r.width >= c.width * 0.5 && r.bottom > c.top) top = Math.max(top, r.bottom - c.top);
    }
    out.top = Math.max(out.top, Math.min(top, c.height - out.bottom - c.height / 3));
  }
  return out;
}

/** The centre and size of the part of the canvas nothing covers (canvas coordinates, CSS px). */
export function freeCentre(doc = globalThis.document) {
  const canvas = doc?.getElementById?.('frontier-map');
  const c = rectOf(canvas);
  if (!c) return { x: 0, y: 0, width: 0, height: 0 };
  const i = hudInsets(doc);
  const width = Math.max(1, c.width - i.left - i.right), height = Math.max(1, c.height - i.top - i.bottom);
  return { x: i.left + width / 2, y: i.top + height / 2, width, height };
}

/**
 * The HUD's pieces as client rectangles (UX design 11.6, 11.11): `[{id, x, y, width, height}]` of what is shown
 * now — the two plaques and the dial, the search, the to-do tab and its list, the plate, the dock, the minimap with its
 * lens chips, the map's button column, each notice of the stack, a milestone's banner, and the open drawer (the
 * phone's sheet too). The map keeps its labels and anchored marks out of them (`__wyllsMap.setNoGo`, called by
 * app.mjs after layout); the effects keep their words out of them (fx/safe.mjs reads the same list through
 * `__wyllsHud.noGo()`). A wide document or the nation choice covers the map on purpose and is listed as one rectangle.
 */
/**
 * The bar's cards that count as covering the foot of the map: the card of a new host (its tile is chosen on the board
 * above it) and the village's wide cards (training, the promotion), which stood over the village itself at 1440 x 900:
 * the camera keeps the village in the part of the map they leave free (app.mjs setPop).
 */
export const CARDS_OVER_BOARD = Object.freeze(['muster', 'train', 'promote']);
export const NO_GO = Object.freeze([
  ['plaque-left', '#topbar .strip-l'], ['dial', '#bell-pill'], ['plaque-right', '#topbar .strip-r'],
  ['search', '#search-btn'], ['search-field', '#map-search'], ['todo', '#rail .todo-tab'], ['todo-list', '#rail .todo-list'], ['plate', '#rail .plate'], ['dock', 'nav.tabs'], ['hand', '#hand'], ['hand-card', '#hand-pop[data-mode="card"]'], ['hand-fan', '#hand-pop[data-mode="fan"] .fan-tok'],
  ['lenses', '#lenses'], ['minimap', '#minimap-canvas'], ['map-tools', '.map-tools'], ['notices', '#feed > *'], ['banner', '#mile-banner'],
  // (the prototype rule "banners": its fixed chip and its score, present only in a sample world that serves it)
  ['proto-chip', '#proto-chip'], ['proto-chip-map', '.proto-chip-map'], ['proto-score', '#proto-score'], ['drawer', '#panel'],
]);
export function noGoRects(doc = globalThis.document) {
  if (!doc?.querySelector) return [];
  const view = doc.defaultView;
  const out = [];
  for (const [id, sel] of NO_GO) {
    // (the notices are a stack: each one is a piece, the column they stand in is not)
    // (the effects' sample page stands its own notice beside them, fx/demo.mjs: it is a piece like any other)
    const els = id === 'notices' ? [...(doc.querySelectorAll?.(sel) ?? []), ...(doc.querySelectorAll?.('#fx-demo-feed > *') ?? [])] : id === 'hand-fan' ? [...(doc.querySelectorAll?.(sel) ?? [])] : [doc.querySelector(sel)];
    for (const el of els) {
      if (!el || !shown(el, view)) continue;
      if (id === 'drawer' && el.dataset?.drawer !== 'open' && view?.getComputedStyle?.(el).position !== 'absolute') continue;
      const r = rectOf(el);
      if (!r || !(r.width > 0) || !(r.height > 0)) continue;
      out.push({ id, x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
    }
  }
  return out;
}
