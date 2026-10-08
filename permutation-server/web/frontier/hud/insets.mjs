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
    else if (panel.dataset.drawer === 'open') out.right = Math.max(0, c.right - Math.max(c.left, p.left));
  }
  const dock = doc.querySelector?.('nav.tabs'), d = rectOf(dock);
  if (d && shown(dock, view) && d.top < c.bottom) out.bottom = Math.max(out.bottom, c.bottom - d.top);
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
