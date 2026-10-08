// The names on the far view, laid out so that none covers another.
//
// The far view names the nations over the heart of their lands, the Concord
// at the centre and the viewer's own village under its beacon. With six
// nations around a small world their hearts lie close together and the names
// ran into each other. `layoutLabels` places them one by one, the most
// important first; a name that would cover one already placed moves along its
// own direction (outward from the Concord for a nation) until it is clear,
// and stays where it was when nowhere near is clear. Pure: sizes in screen px,
// positions in world px, the text measured by the caller.

/** Gap kept between two names (screen px). */
export const LABEL_GAP = 5;
/** How far a name may move, in steps of its own height. */
export const LABEL_STEPS = 9;

const overlaps = (a, b, gap) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;

/**
 * Place `items`: `[{text, x, y (world px), w, h (screen px), priority,
 * dir: {x, y} | null, fixed}]` at `zoom` (screen px per world px). Returns
 * the items in the order given, each with its final `x`, `y` (world px) and
 * `moved` (screen px it was moved). `fixed` items never move (an item with no
 * text is a mark the names keep clear of: the beacon's pip).
 */
export function layoutLabels(items, { zoom = 1, gap = LABEL_GAP, steps = LABEL_STEPS } = {}) {
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => (b.it.priority ?? 0) - (a.it.priority ?? 0) || a.i - b.i);
  const placed = [], out = new Array(items.length);
  for (const { it, i } of order) {
    const sx = it.x * zoom, sy = it.y * zoom;
    const boxAt = (dx, dy) => ({ x0: sx + dx - it.w / 2, x1: sx + dx + it.w / 2, y0: sy + dy - it.h / 2, y1: sy + dy + it.h / 2 });
    const free = b => !placed.some(p => overlaps(b, p, gap));
    let dx = 0, dy = 0;
    if (!it.fixed && !free(boxAt(0, 0))) {
      const len = Math.hypot(it.dir?.x ?? 0, it.dir?.y ?? 0);
      const ux = len > 1e-6 ? it.dir.x / len : 0, uy = len > 1e-6 ? it.dir.y / len : 1;
      const stride = it.h * 0.6 + gap;
      // a step further each time: along its direction, straight up, straight down, against its direction
      search: for (let n = 1; n <= steps; n++) for (const [vx, vy] of [[ux, uy], [0, -1], [0, 1], [-ux, -uy]]) {
        const tx = vx * stride * n, ty = vy * stride * n;
        if (free(boxAt(tx, ty))) { dx = tx; dy = ty; break search; }
      }
    }
    placed.push(boxAt(dx, dy));
    out[i] = { ...it, x: it.x + dx / zoom, y: it.y + dy / zoom, moved: Math.hypot(dx, dy) };
  }
  return out;
}
