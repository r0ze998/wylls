// The label pass (UX brief §11.6): where the map's words may stand.
//
// Everything that is read on the map (a village's nameplate, a host's pill, a
// tag, a build ring) asks one pass of the frame for its place. The pass knows
//
//   the no-go rectangles   the HUD's own things over the map (the dial, the
//                          village plate, the dock, the minimap, the button
//                          columns): `map.setNoGo(rects)`, or measured by the
//                          map itself until the page feeds them
//   what is taken          the labels already placed this frame (the more
//                          important are placed first by their painters)
//   what is hidden         the tiles whose label pile is put away while an
//                          effect plays there: `map.hideLabelsAt(tileKey, on)`
//   the kept places        a no-go rectangle marked `hard` (the sample
//                          world's tag, the chip of the prototype rule: the
//                          page's statements of what is true of the whole
//                          screen). No label stands in one, not even a label
//                          that is never left out: it is moved out of it by
//                          the shortest way, however far that is
//
// and answers with a nudge (a label slides out from under the dial instead of
// being cut by it) or with nothing (the label is left out this frame). Pure:
// boxes in, offsets out. Labels are drawn in world px around an anchor on the
// board and stand upright where the tilted board shows that anchor
// (map/tilt.mjs); `screen(x, y)` says where that is, so the pass works in the
// px a person sees.

/** Room kept between a label and what it avoids (px), and how far a label may be moved (px). */
export const LABEL_PASS = Object.freeze({ gap: 5, reach: 96 });
/** A label keeps this far inside the picture's sides (px) when its own place is in the picture. */
const EDGE = 6;

const hits = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** A rectangle in any of the shapes the page has (`{x, y, w, h}`, `{x, y, width, height}`, `{left, top, right, bottom}`) as `{x, y, w, h}`, or null. */
export function rectOf(r) {
  if (!r) return null;
  const x = r.x ?? r.left, y = r.y ?? r.top;
  const w = r.w ?? r.width ?? (Number.isFinite(r.right) ? r.right - x : NaN), h = r.h ?? r.height ?? (Number.isFinite(r.bottom) ? r.bottom - y : NaN);
  return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** The tile key of a place: "P,Q,tile" (what `map.hideLabelsAt` takes). */
export const tileKeyOf = o => (typeof o === 'string' ? o : o && Number.isInteger(o.p) && Number.isInteger(o.q ?? o.pq) && Number.isInteger(o.tile ?? o.idx) ? `${o.p},${o.q ?? o.pq},${o.tile ?? o.idx}` : null);

/**
 * The pass of one frame. `nogo`: `[{x, y, w, h}]` in px from the map's own
 * corner; `screen(x, y)`: where world point (x, y) is seen, in the same px
 * (none: the flat picture, world px times `zoom`); `hidden`: a Set of tile
 * keys; `bounds` `{w, h}`: the picture (a label that would be nudged out of
 * it is not nudged that way).
 *
 *   hiddenAt(key)                     whether that tile's label pile is put away
 *   place(ax, ay, box, opts) → {dx, dy} | null
 *       `box` `{x, y, w, h}` in world px, drawn around the anchor (ax, ay).
 *       The offset to draw it with (world px), or null when it has no place.
 *       opts: `keep` (never left out: it stays where it is when nothing
 *       nearer is free), `solid` (later labels keep clear of it; default
 *       true), `free` (it keeps clear of the no-go rectangles only, not of
 *       other labels), `reach` (px it may move), `hud` (with `keep`: when
 *       nothing is free it stands clear of the HUD first, over another label).
 *   block(ax, ay, box)                something labels keep clear of (a sprite)
 */
export function createLabelPass({ nogo = [], screen = null, zoom = 1, hidden = null, bounds = null, gap = LABEL_PASS.gap } = {}) {
  const taken = [];
  const toScreen = (ax, ay, b) => { const s = screen ? screen(ax, ay) : { x: ax * zoom, y: ay * zoom }; return { x: s.x + (b.x - ax) * zoom, y: s.y + (b.y - ay) * zoom, w: b.w * zoom, h: b.h * zoom }; };
  const inside = b => !bounds || (b.x + b.w > 0 && b.x < bounds.w && b.y + b.h > 0 && b.y < bounds.h);
  const blocker = (b, free) => nogo.find(r => hits(b, r, gap)) ?? (free ? null : taken.find(r => hits(b, r, gap * 0.4))) ?? null;
  // the ways out from under `r`, the shortest first
  const ways = (b, r) => [[0, r.y - gap - (b.y + b.h)], [0, r.y + r.h + gap - b.y], [r.x - gap - (b.x + b.w), 0], [r.x + r.w + gap - b.x, 0]].sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
  return {
    nogo, taken, bounds,
    hiddenAt: key => !!key && !!hidden?.has?.(key),
    place(ax, ay, box, { keep = false, solid = true, free = false, reach = LABEL_PASS.reach, hud = false } = {}) {
      const s = toScreen(ax, ay, box);
      // a label whose own place is in the picture is not cut by the picture's side: it slides in (its leader leans)
      let inX = 0, whole = false;
      if (bounds && s.w + 2 * EDGE <= bounds.w) {
        const a = screen ? screen(ax, ay) : { x: ax * zoom, y: ay * zoom };
        if (a.x >= 0 && a.x <= bounds.w && a.y >= 0 && a.y <= bounds.h) { whole = true; inX = s.x < EDGE ? EDGE - s.x : s.x + s.w > bounds.w - EDGE ? bounds.w - EDGE - s.x - s.w : 0; }
      }
      s.x += inX;
      const done = (dx, dy) => { if (solid) taken.push({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }); return { dx: (dx + inX) / zoom, dy: dy / zoom }; };
      const first = blocker(s, free);
      if (!first) return done(0, 0);
      // one move out from under what covers it; when that lands on something else, one more from there
      let best = null;
      const tryAt = (dx, dy) => { if (Math.hypot(dx, dy) > reach) return null; const b = { x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }; if (!inside(b)) return null; /* (a label that slid in from the side is not nudged back out through it; nor is it nudged half out through the top or the foot of the picture — 「A banner can rise here (+5 tiles)」 stood cut in half by the top of the screen, the English recording of 2026-10-11) */ if (whole && (b.x < EDGE - 0.5 || b.x + b.w > bounds.w - EDGE + 0.5 || b.y < 0 || b.y + b.h > bounds.h)) return null; return blocker(b, free) ? b : (best = !best || Math.hypot(dx, dy) < Math.hypot(best[0], best[1]) ? [dx, dy] : best, null); };
      for (const [dx, dy] of ways(s, first)) {
        const b = tryAt(dx, dy);
        if (!b) continue;
        const next = blocker(b, free);
        if (next) for (const [ex, ey] of ways(b, next)) tryAt(dx + ex, dy + ey);
      }
      if (best) return done(best[0], best[1]);
      if (!keep) return null;
      // `hud`: a label that is never left out and matters more than the labels round it (the count of a threat): with
      // no place free of everything, it takes the nearest place free of the HUD and stands over another label there
      // (on a phone the count's words stayed under the notice that told of the threat, the labels beside it being taken)
      if (hud) {
        let near = null;
        const clearOf = b => !nogo.some(r => hits(b, r, gap));
        const tryHud = (dx, dy) => { if (Math.hypot(dx, dy) > reach) return; const b = { x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }; if (!inside(b) || !clearOf(b)) return; if (!near || Math.hypot(dx, dy) < Math.hypot(near[0], near[1])) near = [dx, dy]; };
        for (const r of nogo) if (hits(s, r, gap)) for (const [dx, dy] of ways(s, r)) { tryHud(dx, dy); const b = { x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }; for (const r2 of nogo) if (hits(b, r2, gap)) for (const [ex, ey] of ways(b, r2)) tryHud(dx + ex, dy + ey); }
        if (near) return done(near[0], near[1]);
      }
      // a label that is never left out stays where it is, under whatever covers it, EXCEPT in a kept place: out of
      // that it goes by the shortest way that lies in the picture (no reach: a dial slid under the chip that says
      // the rule is a design, and a count under the sample world's tag)
      const hard = nogo.filter(r => r.hard && hits(s, r, gap));
      if (!hard.length) return done(0, 0);
      const clear = b => !nogo.some(r => r.hard && hits(b, r, gap));
      let out = null;
      // (first a way that leaves the label WHOLE in the picture, then one that leaves a part of it there, then any: the
      // shortest way out of a chip right under the top of the screen is up, where the screen cuts the label in half)
      const uncut = b => !bounds || (b.x >= 0 && b.y >= 0 && b.x + b.w <= bounds.w && b.y + b.h <= bounds.h);
      const tryOut = (dx, dy, far) => { const b = { x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }; if (!clear(b) || (far === 0 && !uncut(b)) || (far === 1 && !inside(b))) return; if (!out || Math.hypot(dx, dy) < Math.hypot(out[0], out[1])) out = [dx, dy]; };
      for (const far of [0, 1, 2]) {
        for (const r of hard) for (const [dx, dy] of ways(s, r)) { tryOut(dx, dy, far); const b = { x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }; for (const r2 of nogo) if (r2.hard && hits(b, r2, gap)) for (const [ex, ey] of ways(b, r2)) tryOut(dx + ex, dy + ey, far); }
        if (out) break;
      }
      return out ? done(out[0], out[1]) : done(0, 0);
    },
    block(ax, ay, box) { const s = toScreen(ax, ay, box); taken.push(s); return s; },
  };
}

/** A pass that lets everything stand where it is (a painter called without one). */
export const OPEN_PASS = Object.freeze({ nogo: [], taken: [], hiddenAt: () => false, place: () => ({ dx: 0, dy: 0 }), block: () => null });
