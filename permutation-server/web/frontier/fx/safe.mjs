// Where an effect may put words (UX-DESIGN §11.14): every screen-space effect
// (a title, a caption, a floating number) stays inside the part of the map
// the HUD leaves free, on every size of screen.
//
//   freeOf(doc, stage) → {bounds, centre, boxes, place(cx, cy, w, h, pad)}
//
//   bounds   the map on screen without the bands that run across it (the top
//            strip; the dock or a phone's sheet; an open drawer; a phone's
//            two columns of buttons)
//   centre   the largest stage-like rectangle around the map's middle line
//            that no piece of the HUD touches (the dial hangs into the top of
//            it, the plate and the minimap stand in its corners): where a
//            title goes and what a battle is sized to
//   place    a box of w × h that wants its middle at (cx, cy): moved as
//            little as it takes to lie inside `bounds` and off every piece
//   span     the free stretch of a horizontal band y0..y1 around the middle
//            line (what a title across the map may fill at that height)
//
// The HUD says it itself where it can: `globalThis.__wyllsHud.noGo()` is the
// list of its pieces on screen (hud/insets.mjs noGoRects: the same list the
// map's labels keep out of), each with an id; HUD_IDS says which of them stand
// always and which step back for a set piece. A page may instead give one
// rectangle, `__wyllsHud.freeRect()` (client px, `{left, top, right, bottom}`
// or `{left, top, width, height}`); then that rectangle is all three. Without
// either it is measured from the elements the HUD is known to have
// (HUD_PIECES). Pure given its inputs (`freeFrom`), so it is tested without a
// page.

/**
 * The pieces of the HUD that stand over the map, by selector (frontier.css; hud/hud.mjs), in three kinds:
 * `fixed` always there (the strip, the dial, the dock, a sheet or drawer, the notices, a milestone's banner);
 * `ghost` the corner pieces that step back while a set piece has the stage (fx.css `body[data-fx-piece]`);
 * `soft` things that stand on the map itself (a caption keeps off them, a title does not care).
 */
export const HUD_PIECES = Object.freeze({
  fixed: ['#topbar', '#bell-pill', '.dial-top', 'nav.tabs', '#feed', '#panel', '#mile-banner'],
  ghost: ['#hud-tl', '#rail', '#minimap', '#lenses', '.map-tools'],
  soft: ['.home-pointer'],
});
/**
 * The same kinds for the HUD's own list (`__wyllsHud.noGo()`, ids of hud/insets.mjs NO_GO): what is not named
 * here is `fixed`. The two plaques of the top strip count as one band across the map (`strip`): words never
 * go between them, though the map shows there.
 */
export const HUD_IDS = Object.freeze({
  ghost: ['search', 'search-field', 'todo', 'todo-list', 'plate', 'lenses', 'minimap', 'map-tools'],
  strip: ['plaque-left', 'plaque-right'],
  // on a phone the notices stand over the middle of the map, between its two columns of buttons: there they step
  // back for a set piece as the corner pieces do (fx.css); on a wide screen they stand at the side and stay
  narrowGhost: ['notices'],
});
/** Below this width of the map the page is a phone's (frontier.css: the sheet, the two columns of buttons, the notices in the middle). */
export const NARROW = 760;

/** Any rectangle shape as `{left, top, right, bottom, width, height}` (null when it is not one). */
export function normRect(r) {
  if (!r) return null;
  const left = Number(r.left ?? r.x), top = Number(r.top ?? r.y);
  const right = Number(r.right ?? left + Number(r.width)), bottom = Number(r.bottom ?? top + Number(r.height));
  if (![left, top, right, bottom].every(Number.isFinite) || right - left < 1 || bottom - top < 1) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** A column of the HUD stands at most this far from the map's side (the HUD's own inset from the edge). */
const SIDE_GAP = 16;
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** The bands and columns of `boxes` cut off `st`, and what is left of them as pieces: `{bounds, pieces}`. */
function carve(st, boxes, band) {
  let { left, top, right, bottom } = st;
  const pieces = [];
  const midY = (st.top + st.bottom) / 2, midX = (st.left + st.right) / 2;
  for (const b of boxes) {
    if (b.width >= st.width * band) { if ((b.top + b.bottom) / 2 < midY) top = Math.max(top, b.bottom); else bottom = Math.min(bottom, b.top); }
    else if (b.height >= st.height * 0.5 && b.width < st.width * 0.4 && (b.left <= st.left + SIDE_GAP || b.right >= st.right - SIDE_GAP)) { if ((b.left + b.right) / 2 < midX) left = Math.max(left, b.right); else right = Math.min(right, b.left); }
    else pieces.push(b);
  }
  if (right - left < 40) { left = st.left; right = st.right; }
  if (bottom - top < 40) { top = st.top; bottom = st.bottom; }
  const bounds = rect(left, top, right, bottom);
  return { bounds, pieces: pieces.filter(b => overlaps(b, bounds)) };
}

/**
 * Among the rectangles inside `bounds` that hold its middle line and touch no piece, the one that is largest
 * as a stage: at least half the map wide, and its width counts only up to 1.6 of its height (so a tall stage
 * between two corner pieces wins over a low one that runs the whole width).
 */
function stageOf(bounds, pieces) {
  const xs = [...new Set([bounds.left, bounds.right, ...pieces.flatMap(b => [b.left, b.right])].filter(x => x >= bounds.left && x <= bounds.right))].sort((a, b) => a - b);
  const cx = (bounds.left + bounds.right) / 2, minW = Math.min(bounds.width, Math.max(160, bounds.width * 0.5));
  let best = null, score = -1;
  for (const x0 of xs) for (const x1 of xs) {
    if (!(x0 < cx && x1 > cx) || x1 - x0 < minW) continue;
    const cut = pieces.filter(b => b.left < x1 - 0.5 && b.right > x0 + 0.5).sort((a, b) => a.top - b.top);
    let y = bounds.top;
    const gap = (y0, y1) => { const w = x1 - x0, h = y1 - y0; if (h < 40) return; const sc = Math.min(w, 1.6 * h) * h + w * 0.01; if (sc > score) { score = sc; best = rect(x0, y0, x1, y1); } };
    for (const b of cut) { if (b.top > y) gap(y, Math.min(b.top, bounds.bottom)); y = Math.max(y, b.bottom); }
    if (y < bounds.bottom) gap(y, bounds.bottom);
  }
  return best ?? bounds;
}

/**
 * The answers from a stage rectangle and the HUD's boxes (all client px; a box may carry `kind`: 'fixed'
 * (default), 'ghost' or 'soft', see HUD_PIECES). A box that runs across at least `band` of the stage's width
 * is a band (it cuts the top or the bottom off); one that runs down at least half its height along a side is
 * a column (it cuts that side off); the rest are pieces to keep off.
 *
 *   bounds  the map without its bands and columns                      (a caption is kept inside it)
 *   centre  the stage around the middle line free of every piece        (a title; everyday)
 *   stage   the same when the ghost pieces have stepped back            (a set piece: a battle and its title)
 *   place   a box moved off every piece, soft ones too
 *   span    the free stretch of a band of heights (`{stage: true}`: without the ghost pieces)
 */
export function freeFrom(stageRect, boxes = [], { band = 0.6 } = {}) {
  const st = normRect(stageRect) ?? rect(0, 0, 0, 0);
  const all = boxes.map(b => { const r = normRect(b); return r ? { ...rect(Math.max(r.left, st.left), Math.max(r.top, st.top), Math.min(r.right, st.right), Math.min(r.bottom, st.bottom)), kind: b.kind ?? 'fixed' } : null; }).filter(b => b && b.width > 1 && b.height > 1);
  const hard = all.filter(b => b.kind !== 'soft'), fixed = all.filter(b => b.kind === 'fixed'), soft = all.filter(b => b.kind === 'soft');
  const day = carve(st, hard, band), set = carve(st, fixed, band);
  const bounds = day.bounds, keepOff = [...day.pieces, ...soft.filter(b => overlaps(b, bounds))];
  return { bounds, centre: stageOf(bounds, day.pieces), stage: stageOf(set.bounds, set.pieces), boxes: keepOff,
    place: (x, y, w, h, pad = 6, from = null) => placeBox(x, y, w, h, bounds, keepOff, pad, from),
    // (for what belongs to a set piece that has the stage: off the pieces that stay, inside what they leave)
    placeStage: (x, y, w, h, pad = 6, from = null) => placeBox(x, y, w, h, set.bounds, set.pieces, pad, from),
    span: (y0, y1, { stage = false } = {}) => (stage ? spanOf(y0, y1, set.bounds, set.pieces) : spanOf(y0, y1, bounds, day.pieces)) };
}

/** The free stretch `{left, right, width}` of the band y0..y1 that holds the middle line of `bounds` (the widest one when a piece stands on the line). */
export function spanOf(y0, y1, bounds, boxes = []) {
  const cx = (bounds.left + bounds.right) / 2;
  const cut = boxes.filter(o => o.top < y1 - 0.5 && o.bottom > y0 + 0.5).sort((a, b) => a.left - b.left);
  const gaps = [];
  let x = bounds.left;
  for (const o of cut) { if (o.left > x) gaps.push([x, Math.min(o.left, bounds.right)]); x = Math.max(x, o.right); }
  if (x < bounds.right) gaps.push([x, bounds.right]);
  const g = gaps.find(([a, b]) => a <= cx && b >= cx) ?? gaps.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0] ?? [bounds.left, bounds.right];
  return { left: g[0], right: g[1], width: g[1] - g[0] };
}

/** Whether the segment a→b passes through rectangle `o` (a leader that would cross a piece of the HUD). */
function crosses(a, b, o) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - o.left], [dx, o.right - a.x], [-dy, a.y - o.top], [dy, o.bottom - a.y]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t1 - t0 > 0.02;
}

/**
 * The middle of a `w` × `h` box that wants to be at (cx, cy): inside `bounds`
 * (a box larger than it is centred on it) and moved off every piece by the
 * shortest way that stays inside. `from` (the point its leader starts at): a
 * way that would put a piece between the box and that point comes last.
 */
export function placeBox(cx, cy, w, h, bounds, boxes = [], pad = 6, from = null) {
  const b = normRect(bounds);
  if (!b) return { x: cx, y: cy, moved: false };
  const hw = w / 2 + pad, hh = h / 2 + pad;
  const clampX = x => (b.width < hw * 2 ? (b.left + b.right) / 2 : Math.min(b.right - hw, Math.max(b.left + hw, x)));
  const clampY = y => (b.height < hh * 2 ? (b.top + b.bottom) / 2 : Math.min(b.bottom - hh, Math.max(b.top + hh, y)));
  let x = clampX(cx), y = clampY(cy);
  for (let pass = 0; pass < 3; pass++) {
    let hit = false;
    for (const o of boxes) {
      if (!(x - hw < o.right && x + hw > o.left && y - hh < o.bottom && y + hh > o.top)) continue;
      // the four ways out, shortest first; one that leaves the bounds is not a way
      const cost = ([nx, ny]) => Math.hypot(nx - x, ny - y) + (from && crosses(from, { x: nx, y: ny }, o) ? 1e4 : 0);
      const ways = [[o.left - hw, y], [o.right + hw, y], [x, o.top - hh], [x, o.bottom + hh]]
        .filter(([nx, ny]) => Math.abs(clampX(nx) - nx) < 0.5 && Math.abs(clampY(ny) - ny) < 0.5)
        .sort((p, q) => cost(p) - cost(q));
      if (ways.length) { [x, y] = ways[0]; hit = true; }
    }
    if (!hit) break;
  }
  return { x, y, moved: Math.abs(x - cx) > 0.5 || Math.abs(y - cy) > 0.5 };
}

const visible = (el, win) => {
  if (!el || el.hidden) return false;
  try { const s = win?.getComputedStyle?.(el); return !s || (s.display !== 'none' && s.visibility !== 'hidden'); } catch { return true; }
};

/** The HUD's boxes on a page (client px): every known piece that is shown and has a size. */
export function hudBoxes(doc = globalThis.document, st = null) {
  const out = [];
  if (!doc?.querySelectorAll) return out;
  const win = doc.defaultView;
  const narrow = !!st && st.width < NARROW;
  for (const [kind, sels] of Object.entries(HUD_PIECES)) for (const sel of sels) {
    let list = [];
    try { list = [...doc.querySelectorAll(sel)]; } catch { list = []; }
    for (const el of list) {
      if (!visible(el, win)) continue;
      // a closed drawer keeps its box off screen or folded: it covers nothing
      if (el.id === 'panel' && el.dataset?.drawer === 'closed' && win?.getComputedStyle?.(el).position !== 'absolute') continue;
      const r = normRect(el.getBoundingClientRect?.());
      if (r && r.width > 2 && r.height > 2) out.push({ ...r, kind: narrow && sel === '#feed' ? 'ghost' : kind });
    }
  }
  return out;
}

/**
 * The HUD's boxes from its own list (`__wyllsHud.noGo()`), or null when the page gives none: each piece with its
 * kind, the strip's plaques as one band across `st`, and the map's own soft things measured beside them.
 */
export function hudOwnBoxes(doc = globalThis.document, st = null) {
  let list = null;
  try { list = globalThis.__wyllsHud?.noGo?.(); } catch { list = null; }
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  let strip = null;
  const narrow = !!st && st.width < NARROW;
  for (const b of list) {
    const r = normRect(b);
    if (!r) continue;
    if (HUD_IDS.strip.includes(b.id)) { strip = Math.max(strip ?? -Infinity, r.bottom); continue; }
    out.push({ ...r, kind: HUD_IDS.ghost.includes(b.id) || (narrow && HUD_IDS.narrowGhost.includes(b.id)) ? 'ghost' : 'fixed' });
  }
  if (strip !== null && st && strip > st.top + 1) out.push({ left: st.left, top: st.top, right: st.right, bottom: strip, width: st.width, height: strip - st.top, kind: 'fixed' });
  if (doc?.querySelectorAll) for (const sel of HUD_PIECES.soft) {
    let els = [];
    try { els = [...doc.querySelectorAll(sel)]; } catch { els = []; }
    for (const el of els) { if (!visible(el, doc.defaultView)) continue; const r = normRect(el.getBoundingClientRect?.()); if (r && r.width > 2 && r.height > 2) out.push({ ...r, kind: 'soft' }); }
  }
  return out;
}

/**
 * What the HUD leaves free of `stage` (an element or a rectangle) on a page: from the one rectangle the page
 * gives (`freeRect`), else from the HUD's own list of its pieces (`noGo`), else measured by selector.
 */
export function freeOf(doc = globalThis.document, stage = null) {
  const st = normRect(stage?.getBoundingClientRect ? stage.getBoundingClientRect() : stage) ?? normRect({ left: 0, top: 0, width: doc?.defaultView?.innerWidth ?? 0, height: doc?.defaultView?.innerHeight ?? 0 });
  let own = null;
  try { own = normRect(globalThis.__wyllsHud?.freeRect?.()); } catch { own = null; }
  if (own && own.width >= 40 && own.height >= 40) return { bounds: own, centre: own, stage: own, boxes: [], hud: true, place: (x, y, w, h, pad = 6) => placeBox(x, y, w, h, own, [], pad), span: () => ({ left: own.left, right: own.right, width: own.width }) };
  if (!st) { const z = rect(0, 0, 0, 0); return { bounds: z, centre: z, stage: z, boxes: [], place: (x, y) => ({ x, y, moved: false }), span: () => ({ left: 0, right: 0, width: 0 }) }; }
  const listed = hudOwnBoxes(doc, st);
  return listed ? { ...freeFrom(st, listed), hud: 'list' } : freeFrom(st, hudBoxes(doc, st));
}
