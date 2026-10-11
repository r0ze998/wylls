// The painters of the banner rule's PROTOTYPE on the board (PROTOTYPE-SPEC.md
// section 7; "Standing Ground" is a design, not in the program). They draw
// what proto/board-model.mjs read from the sample world's records, in the
// redesign's language (UX design 3 and 5): gold is "yours" and nothing else,
// a nation is its colour and its sigil, land arrives the way the landing's
// flood arrives.
//
//   the viewer's land     the village's land and the viewer's banners' land are ONE shape: the band of the nation's
//                         colour and the gold rail close round their union (map/ownland.mjs paints it; this file
//                         adds the full-strength wash under a banner's own tiles)
//   a nation-mate's land  the quieter wash, a plain rim, no gold
//   another nation's      its colour, solid under its banners
//   the commons           a pale hatch of the colour of the nation that holds the province
//   a frayed banner       its patch hatched instead of filled, its rim dashed
//   a banner              a pole with a square cloth carrying the sigil. Firm: a stiff cloth hung from a yard, a
//                         stone foot. Loose: a pennon that moves. A border banner: a notch on the pole in the colour
//                         of the nation it faces. The viewer's own: the gold finial of the village's standard
//   where one can rise    a dotted gold edge on each tile
//   choosing              a dashed gold flower on the candidate, its tail as footprints, 「+7マス・1ターン」
//   a trail               footprints behind the host that walked it
//   a claim in progress   a pole rising, a ring dial of the turns left, the flower faint
//   a threat              a ring dial in ember that fills turn by turn, the patch's border hatched in ember
//
// Pure parts first (the timelines of the moments), then the painters, which
// are context-tolerant (tests draw into recorders). Line widths are screen px
// before the zoom's own scale; everything else is world px.
import { FLATTEN, RADIUS, hexPoints, project } from '../../map.mjs';
import { PROTO_LINE, landShape } from './ownland.mjs';
import { outerLoops } from './actions.mjs';
import { YOURS, fxNow, strokeYours } from './chart.mjs';
import { SIGILS, provinceCorners } from './layers.mjs';
import { NATION_FILL, NATION_INK, NATION_LAND, NATION_ON, nationPale } from '../palette.mjs';
import { paintGlyph } from './glyphs.mjs';

const INK = 'rgba(14,22,20,';
const IVORY = '#fff6e2';
/** Ember: the colour of a threat (the reach's attack colour is the same red). */
export const EMBER = '#ff6a4a';
const clamp01 = x => Math.max(0, Math.min(1, x));
const outCubic = k => 1 - Math.pow(1 - clamp01(k), 3);
const lineScale = zoom => (0.72 + 0.28 * Math.min(1.8, Math.max(0.3, zoom))) / zoom;
const rgba = (hex, a) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const mix = (hex, to, k) => { const n = parseInt(String(hex).slice(1), 16) || 0, c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v, i) => Math.round(v + (to[i] - v) * clamp01(k))); return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`; };
/** A colour `k` of the way to white, and to black. */
export const lighten = (hex, k) => mix(hex, [255, 255, 255], k);
export const darken = (hex, k) => mix(hex, [0, 0, 0], k);
const outBack = k => { const x = clamp01(k) - 1, c = 1.70158; return 1 + (c + 1) * x * x * x + c * x * x; };
/** The gold of "yours" as a line on the land (brighter than the rail's gold: it is read over red, green and parchment alike), and the dark it lies on. */
export const GOLD = PROTO_LINE.colour;
const GOLD_UNDER = PROTO_LINE.dark;
/** The ember of an alarm said in words: a chip's solid ground when little time is left. */
export const ALARM = '#c2410c';
/** The colour a nation's land is drawn in (a white nation's land takes its slate: palette.mjs NATION_LAND). */
export const landColour = f => NATION_LAND[f] ?? '#8a8f86';
const clothColour = f => NATION_FILL[f] ?? '#8a8f86';

/**
 * How the prototype's land looks (presentation only: none of these is a number of the rule).
 *   mine      the wash under the viewer's own banner tiles, on top of which the land's band and gold rail are laid
 *   mate      a nation-mate's banner land      other   another nation's banner land
 *   village   the rim of another village's land (its wash is the board's own, map/sprites.mjs)
 *   commons   the hatch: its strength for the viewer's nation and for another's, the gap between lines (world px)
 *   frayed    the hatch of a frayed patch (denser, the other way)
 *   rise      the dotted gold edge of a tile where a banner can rise
 *   flower    the dashed gold flower of a candidate
 *   walkSoon  a banner whose walk is due within this many turns shows a fraying pennon (the board's own choice of
 *             when to begin warning; the rule's limits themselves come with the record: `walk.dueIn`, `walk.strikeIn`)
 */
export const PROTO_LOOK = Object.freeze({
  // the fill of land that is somebody's (the art critic, 2026-10-11: one wash read red-brown on plains, olive on
  // grass, brown on forest, purple on a lake). Two passes a tile, both plain paint: `level`, parchment that brings
  // dark ground up toward the plains' own lightness (how strong, by the ground), then the nation's colour lightened
  // `lighten` toward white at `wash`. Water takes no fill: an inner line of the nation's colour `water.width` wide.
  fill: Object.freeze({ level: '#e8dcc0', levelBy: Object.freeze({ grassland: 0.4, forest: 0.46, hills: 0.3, mountain: 0.3, plains: 0.15 }), levelElse: 0.15, lighten: 0.15, wash: 0.5, water: Object.freeze({ width: 4, alpha: 0.8 }) }),
  // how much of that fill each kind of land takes, and its rim
  mine: Object.freeze({ fill: 1, village: 0.62 }),
  // (a nation-mate's: half the viewer's, a thin dark rim, no glow; another nation's: its colour, a rim darker than
  // its fill — a light yellow line round Cinder's land read as the viewer's gold)
  mate: Object.freeze({ fill: 0.48, rim: 1.5, under: 0, alpha: 0.9, darken: 0.3 }),
  other: Object.freeze({ fill: 0.9, rim: 2, under: 4, alpha: 1, darken: 0.4 }),
  village: Object.freeze({ rim: 1.4, alpha: 0.7 }),
  commons: Object.freeze({ ours: 0.3, theirs: 0.26, gap: RADIUS * 0.4, width: 1.8 }),
  frayed: Object.freeze({ alpha: 0.5, gap: RADIUS * 0.2, width: 2 }),
  rise: Object.freeze({ dash: Object.freeze([1, 6]), width: 2.4, alpha: 0.9, inset: 6, dot: 3.4, dotAlpha: 0.7 }),
  // the flower of a place being chosen: gold dashes that march, the nation's colour inside it breathing, the tail fainter
  flower: Object.freeze({ dash: Object.freeze([9, 6]), width: 3, fill: Object.freeze([0.16, 0.3]), tail: 0.14, breath: 1.4, march: 12 }),
  // a claim in progress: its land faint (it is not owned yet: an outline and a breath of the colour)
  claim: Object.freeze({ fill: 0.1 }),
  // the gold line of the viewer's land while the prototype is on (map/ownland.mjs paints it): screen px before the zoom's own scale
  line: PROTO_LINE,
  // the watch's rim and the reach's outlines beside land in the nation's colour: cream, thin (map/hostmarks.mjs)
  quiet: Object.freeze({ colour: '#f3e9cf', alpha: 0.55, width: 1.5 }),
  trail: Object.freeze({ band: 7, alpha: 0.55, core: 2, fill: 0.12, steps: 1.6 }),
  threat: Object.freeze({ hatch: 0.38, stripe: 6, drift: 10, outline: 3, ring: 4, pulse: 1.2, pulseFast: 0.6, fastAt: 3, alarmAt: 2 }),
  walkSoon: 48,
});

// ------------------------------------------------------------------ the moments' timelines (pure)
/**
 * A banner is raised (ms from the record's arrival). The art critic's reading of the first cut: the colour was taken
 * away at the record, the ground stood bare, and the payoff came one to two seconds later. Now nothing is cleared and
 * everything is fast: the pole falls in `drop` and lands as the colour reaches its tile (`poleAt`); the tail's tiles
 * come one every `tail` before that, the far end first; the tiles round the pole together `ringGap` after it; each
 * tile arrives over-bright (`hot`) and settles in `settle`. The gold line is drawn round the new land from `lineAt`
 * in `line`; the number rises from the pole at its landing; the sentence's chip comes at `chipAt`.
 */
export const RAISE = Object.freeze({ drop: 180, poleAt: 180, tail: 60, ringGap: 60, tileIn: 70, settle: 350, hot: 0.8, flash: 0.35, lineAt: 300, line: 250, glow: 420,
  dust: 300, sparks: 480, pop: 450, popFrom: 1.6, number: 900, numberRise: 44, chipAt: 450, chip: 4200, hush: 2000,
  // (a banner widened by a tile: the tile at once, the line round it, the chip)
  dress: Object.freeze({ lineAt: 120, chipAt: 300 }) });
/** When the gold line has closed round the new land (ms): until then the viewer's land is drawn as it was. */
export const raiseCloseAt = (n = 7, { dress = false } = {}) => (dress ? RAISE.dress.lineAt : RAISE.lineAt) + RAISE.line;
/** How long a raise lasts (ms), its chip included. */
export const raiseMs = (n = 7, { dress = false } = {}) => (dress ? RAISE.dress.chipAt : RAISE.chipAt) + RAISE.chip;
/** When tile `i` of `n` (in flood order: `tail` tiles of the tail from its far end, the pole, the tiles round it) takes the colour (ms). */
export function raiseTileAt(i, n = 7, tail = 0) {
  const T = RAISE, tl = Math.max(0, Math.min(tail, n - 1)), pole = Math.max(T.poleAt, tl * T.tail);
  return i < tl ? pole - (tl - i) * T.tail : i === tl ? pole : pole + T.ringGap;
}
/**
 * Where a raise is `t` ms after it began, over `n` tiles in flood order of which the first `tail` are the tail:
 * `{pole: {shown, lift (1 high … 0 down), alpha, pop (the cloth's scale)}, dust 0..1 | null, sparks 0..1 | null,
 * tile(i) → {in 0..1 (arrived), hot 1..0 (over-bright, settling)}, line 0..1 | null (the gold line being drawn),
 * closed (the gold line is round the new land), close 0..1 (its glow fading), number 0..1 | null, chip 0..1 | null,
 * done}`. `dress`: one tile added to a banner (no pole, no number).
 */
export function raiseAt(t, n = 7, tail = 0, { dress = false } = {}) {
  const T = RAISE, at = dress ? () => 0 : i => raiseTileAt(i, n, tail);
  const land = dress ? 0 : Math.max(T.poleAt, Math.max(0, Math.min(tail, n - 1)) * T.tail), start = land - T.drop;
  const lineAt = dress ? T.dress.lineAt : T.lineAt, closeAt = lineAt + T.line, chipAt = dress ? T.dress.chipAt : T.chipAt;
  const k = (t - start) / T.drop;
  const tile = i => { const u = t - at(i); return { in: clamp01(u / T.tileIn), hot: u <= 0 ? 0 : 1 - outCubic(u / T.settle) }; };
  const span = (from, len) => (t >= from && t < from + len ? (t - from) / len : null);
  return { pole: { shown: !dress && t >= Math.min(0, start), lift: k >= 1 ? 0 : 1 - clamp01(k) * clamp01(k), alpha: clamp01((t - start) / 60 + 0.4), pop: t < land ? T.popFrom : T.popFrom + (1 - T.popFrom) * outBack((t - land) / T.pop) },
    dust: dress ? null : span(land, T.dust), sparks: dress ? null : span(land, T.sparks), tile,
    line: span(lineAt, T.line), closed: t >= closeAt, close: t < closeAt ? 0 : clamp01((t - closeAt) / T.glow),
    number: dress ? null : span(land, T.number), chip: span(chipAt, T.chip), done: t >= raiseMs(n, { dress }) };
}
/** A trail is inked: one tile every `TRAIL.tile` ms from its far end to the host, then it stays; it fades over `TRAIL.fade` ms when its host leaves. */
export const TRAIL = Object.freeze({ tile: 120, pop: 220, fade: 700, words: 5200 });
/** How much of each of `n` trail tiles is inked `t` ms after the trail's record came: `i → 0..1`. */
export const trailAt = (t, i) => clamp01((t - i * TRAIL.tile) / TRAIL.pop);
/**
 * Land is lost (ms). The first cut recoloured the land quietly; a loss is a moment:
 *   `take`  at the record a white flash on the pole's tile and a shake of the board; the gold line turns ember and
 *           breaks up in `line`; the taker's colour floods from the pole in `flood`; the cloth is swapped in `cloth`
 *   `pull`  the pole falls in `fall`, faster as it goes; where it hits, dust and a small shake; then all the tiles
 *           drain together in `drain`; the gold line draws back in `back`; the fallen flag fades in `fade`
 * The words come with the flash (take) or after the number that sinks from the pole (pull).
 */
export const LOSS = Object.freeze({
  take: Object.freeze({ flash: 120, shake: 200, shakePx: 5, line: 400, flood: 350, tileFade: 140, cloth: 200, wordsAt: 0 }),
  pull: Object.freeze({ fall: 350, shake: 160, shakePx: 3, dust: 380, drain: 400, back: 300, fade: 600, number: 900, numberSink: 30, wordsAt: 600 }),
  words: 5200 });
const takes = kind => kind === 'taken' || kind === 'take';
export const lossMs = (n = 7, kind = 'pulled') => (takes(kind) ? LOSS.take.wordsAt : LOSS.pull.wordsAt) + LOSS.words;
/** When the land's new state is simply there (the still ground may be painted from the records again). */
export const lossSettledAt = (n = 7, kind = 'pulled') => (takes(kind) ? Math.max(LOSS.take.flood, LOSS.take.line) : LOSS.pull.fall + Math.max(LOSS.pull.drain, LOSS.pull.fade));
/**
 * Where a loss is `t` ms after it began over `n` tiles (a take: nearest the pole first; a pull: any order):
 * `{flash 0..1 (falling), shake (px, signed), fall 0..1 (the pole), dust 0..1 | null, cloth: {old 1..0, next 0..1},
 * tile(i) → 0..1 of the old colour left, line 0..1 | null (the old gold line breaking up or drawing back), flag
 * 1..0 (the fallen flag), number 0..1 | null, words 0..1 | null, done}`.
 */
export function lossAt(t, n = 7, kind = 'pulled') {
  const span = (from, len) => (t >= from && t < from + len ? (t - from) / len : null);
  const wob = (from, len, px) => { const k = span(from, len); return k === null ? 0 : Math.sin(k * Math.PI * 5) * px * (1 - k); };
  if (takes(kind)) {
    const T = LOSS.take, step = n > 1 ? (T.flood - T.tileFade) / (n - 1) : 0;
    return { flash: t < 0 ? 0 : 1 - clamp01(t / T.flash), shake: wob(0, T.shake, T.shakePx), fall: 0, dust: null, cloth: { old: 1 - clamp01(t / (T.cloth / 2)), next: clamp01((t - T.cloth / 2) / (T.cloth / 2)) },
      tile: i => 1 - clamp01((t - i * step) / T.tileFade), line: span(0, T.line), flag: 0, number: null, words: span(T.wordsAt, LOSS.words), done: t >= lossMs(n, kind) };
  }
  const T = LOSS.pull, k = clamp01(t / T.fall);
  return { flash: 0, shake: wob(T.fall, T.shake, T.shakePx), fall: k * k, dust: span(T.fall, T.dust), cloth: { old: 1, next: 0 },
    tile: () => 1 - clamp01((t - T.fall) / T.drain), line: span(0, T.back), flag: 1 - clamp01((t - T.fall) / T.fade), number: span(T.fall, T.number), words: span(T.wordsAt, LOSS.words), done: t >= lossMs(n, kind) };
}

// ------------------------------------------------------------------ shapes
const shapes = new Map();
const hexInto = (path, t, inset = 0) => { const c = project(t.q, t.r); hexPoints(c.x, c.y, inset).forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath(); };
/**
 * The shape of a set of tiles `[{q, r}]` (made once per set): `{fill, edge (every loop), outer (the outside only), len (the outside's length, world px),
 * box {x0, y0, x1, y1}, top {x, y}, foot {x, y}, key}`, or null without Path2D.
 */
export function patchShape(tiles) {
  if (typeof Path2D === 'undefined' || !tiles?.length) return null;
  const key = tiles.map(t => `${t.q},${t.r}`).join(';');
  const hit = shapes.get(key);
  if (hit) return hit;
  const shape = landShape(tiles.map(t => ({ q: t.q, r: t.r, d: 0 })));
  const fill = new Path2D(), edge = new Path2D(), outer = new Path2D();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, top = null, foot = null;
  for (const t of tiles) {
    hexInto(fill, t);
    const c = project(t.q, t.r);
    x0 = Math.min(x0, c.x - RADIUS); x1 = Math.max(x1, c.x + RADIUS); y0 = Math.min(y0, c.y - RADIUS * FLATTEN); y1 = Math.max(y1, c.y + RADIUS * FLATTEN);
    if (!top || c.y < top.y) top = { x: c.x, y: c.y }; if (!foot || c.y > foot.y) foot = { x: c.x, y: c.y };
  }
  const trace = (path, loop) => { loop.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath(); };
  for (const loop of shape.loops) trace(edge, loop);
  let len = 0;
  for (const loop of outerLoops(shape.loops)) { trace(outer, loop); loop.forEach(([x, y], i) => { const [bx, by] = loop[(i + 1) % loop.length]; len += Math.hypot(bx - x, by - y); }); }
  const v = { fill, edge, outer, len, box: { x0, y0, x1, y1 }, top: { x: top.x, y: top.y - RADIUS * FLATTEN }, foot: { x: foot.x, y: foot.y + RADIUS * FLATTEN }, key };
  if (shapes.size > 160) shapes.clear();
  shapes.set(key, v);
  return v;
}
const hatches = new Map();
/** Diagonal lines across a box, `gap` world px apart (`back`: leaning the other way), as one path (made once). */
function hatchPath(box, gap, back = false) {
  const key = `${Math.round(box.x0)},${Math.round(box.y0)},${Math.round(box.x1)},${Math.round(box.y1)}|${gap}|${back ? 1 : 0}`;
  let p = hatches.get(key);
  if (p) return p;
  p = new Path2D();
  const h = box.y1 - box.y0, lean = h * 0.9, step = gap * 1.35;
  // (the lines keep their places in the world, so two patches side by side are hatched as one cloth)
  const from = Math.floor((box.x0 - lean) / step) * step;
  for (let x = from; x <= box.x1 + lean; x += step) { if (back) { p.moveTo(x, box.y0); p.lineTo(x + lean, box.y1); } else { p.moveTo(x + lean, box.y0); p.lineTo(x, box.y1); } }
  if (hatches.size > 160) hatches.clear();
  hatches.set(key, p);
  return p;
}

// ------------------------------------------------------------------ land
/** A hatch of `colour` over a set of tiles (the commons; a frayed patch): lines clipped to the tiles. */
export function paintHatch(g, tiles, { zoom = 1, colour = '#888', alpha = 0.2, gap = PROTO_LOOK.commons.gap, width = PROTO_LOOK.commons.width, back = false } = {}) {
  const S = g?.save ? patchShape(tiles) : null;
  if (!S || !(alpha > 0)) return;
  g.save();
  g.clip?.(S.fill);
  g.globalAlpha = alpha; g.strokeStyle = colour; g.lineCap = 'butt';
  // (never a hairline from afar, never a rope close up)
  g.lineWidth = Math.max(width, 1.1 / zoom);
  g.stroke(hatchPath(S.box, gap, back));
  g.restore();
}
const hexPath = (g, c, inset = 0) => { g.beginPath(); hexPoints(c.x, c.y, inset).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
/** How strong the parchment under the colour is on a kind of ground (PROTO_LOOK.fill). */
export const levelOf = name => PROTO_LOOK.fill.levelBy[name] ?? PROTO_LOOK.fill.levelElse;
/** The colour of land a nation holds: its land colour, lightened (PROTO_LOOK.fill). */
export const fillColour = f => lighten(landColour(f), PROTO_LOOK.fill.lighten);
/**
 * The fill of one tile of land that is somebody's: parchment that levels the ground, then the nation's colour
 * (plain paint, both). On water no fill: a line of the colour just inside the tile's edge. `share`: how much of the
 * whole fill (PROTO_LOOK.mine / .mate / .other); `k`: how far it has arrived (0..1); `hot` 0..1: over-bright, as a
 * flood's front arrives (the colour toward RAISE.hot, a white flash over it). `terrainAt(q, r)` names the ground.
 */
export function paintLandTile(g, tile, { nation = 0, terrainAt = null, share = 1, k = 1, hot = 0, alpha = 1, zoom = 1 } = {}) {
  if (!g?.save || !tile || !(k > 0) || !(alpha > 0)) return;
  const F = PROTO_LOOK.fill, c = project(tile.q, tile.r), ground = terrainAt?.(tile.q, tile.r) ?? null, col = fillColour(nation);
  g.save();
  if (ground === 'water') {
    hexPath(g, c); g.clip?.();
    hexPath(g, c);
    g.globalAlpha = Math.min(1, F.water.alpha * Math.min(1, share + 0.3) + 0.2 * hot) * k * alpha; g.strokeStyle = col; g.lineJoin = 'round'; g.lineWidth = 2 * F.water.width * lineScale(zoom); g.stroke();
    if (hot > 0) { g.globalAlpha = RAISE.flash * hot * k * alpha; g.fillStyle = '#ffffff'; g.fill(); }
  } else {
    hexPath(g, c);
    g.globalAlpha = levelOf(ground) * Math.min(1, share * 1.15) * k * alpha; g.fillStyle = F.level; g.fill();
    const wash = F.wash * share;
    g.globalAlpha = (wash + (Math.max(wash, RAISE.hot) - wash) * hot) * k * alpha; g.fillStyle = col; g.fill();
    if (hot > 0) { g.globalAlpha = RAISE.flash * hot * k * alpha; g.fillStyle = '#ffffff'; g.fill(); }
  }
  g.restore();
}
/**
 * A patch of land that is somebody's: every tile filled (paintLandTile), and, unless `rim` is 0, one rim round the
 * patch, darker than its fill. `look` = PROTO_LOOK.mate | .other, or `{fill, rim: 0}` for the viewer's own (its
 * rim is the gold line: map/ownland.mjs). `frayed`: hatched instead of filled, the rim dashed.
 */
export function paintPatch(g, tiles, { zoom = 1, nation = 0, look = PROTO_LOOK.other, frayed = false, alpha = 1, far = false, terrainAt = null } = {}) {
  const S = g?.save ? patchShape(tiles) : null;
  if (!S || !(alpha > 0)) return;
  const k = lineScale(zoom), col = landColour(nation);
  g.save();
  g.lineJoin = 'round';
  if (frayed) paintHatch(g, tiles, { zoom, colour: col, alpha: PROTO_LOOK.frayed.alpha * alpha, gap: PROTO_LOOK.frayed.gap, width: PROTO_LOOK.frayed.width, back: true });
  else if (look.fill > 0) for (const t of tiles) paintLandTile(g, t, { nation, terrainAt, share: look.fill * (far ? 1.15 : 1), alpha, zoom });
  if (look.rim > 0) {
    if (look.under > 0) { g.globalAlpha = 0.6 * alpha; g.strokeStyle = `${INK}1)`; g.lineWidth = look.under * k; g.stroke(S.outer); }
    if (frayed) g.setLineDash?.([6 * k, 5 * k]);
    // (never lighter than the fill: light yellow and gold belong to the viewer alone)
    g.globalAlpha = (look.alpha ?? 1) * alpha; g.strokeStyle = darken(nationPale(nation) ? clothColour(nation) : col, look.darken ?? 0.4); g.lineWidth = look.rim * k; g.stroke(S.outer);
    g.setLineDash?.([]);
  }
  g.restore();
}
/** One tile of a flood: the waiting breath of the colour until the front reaches it, then the fill arriving over-bright and settling (`state` = raiseAt(…).tile(i)). */
export function paintFloodTile(g, tile, { nation = 0, terrainAt = null, share = 1, state = { in: 1, hot: 0 }, zoom = 1 } = {}) {
  if (!g?.save || !tile) return;
  if (state.in < 1) { const c = project(tile.q, tile.r); g.save(); hexPath(g, c); g.globalAlpha = PROTO_LOOK.claim.fill * (1 - state.in); g.fillStyle = landColour(nation); g.fill(); g.restore(); }
  if (state.in > 0) paintLandTile(g, tile, { nation, terrainAt, share, k: state.in, hot: state.hot, zoom });
}
/** One tile of land that is being lost: `left` 0..1 of the old holder's fill still on it. */
export function paintDrainTile(g, tile, { nation = 0, terrainAt = null, share = 1, left = 1, zoom = 1 } = {}) {
  if (left > 0) paintLandTile(g, tile, { nation, terrainAt, share, k: left, zoom });
}
/** The gold line itself along a path, as the viewer's land wears it under the prototype: gold `line.gold` wide on its dark underlay. */
export function strokeGold(g, path, { zoom = 1, alpha = 1, colour = GOLD, dash = null, offset = 0 } = {}) {
  if (!g?.save || !path || !(alpha > 0)) return;
  const k = lineScale(zoom), Ln = PROTO_LOOK.line;
  g.save();
  g.lineJoin = 'round'; g.lineCap = dash ? 'butt' : 'round';
  if (dash) { g.setLineDash?.(dash); if ('lineDashOffset' in g) g.lineDashOffset = offset; }
  g.globalAlpha = Ln.underAlpha * alpha; g.strokeStyle = GOLD_UNDER; g.lineWidth = Ln.under * k; g.stroke(path);
  g.globalAlpha = alpha; g.strokeStyle = colour; g.lineWidth = Ln.gold * k; g.stroke(path);
  g.setLineDash?.([]); if ('lineDashOffset' in g) g.lineDashOffset = 0;
  g.restore();
}
/**
 * The gold line being drawn round new land of the viewer's (`line` 0..1: how far round), then its glow fading
 * (`close` 0..1). `tiles`: the new patch while the line is drawn, the whole land once it has closed.
 */
export function paintClose(g, tiles, { zoom = 1, line = null, close = 0 } = {}) {
  const S = g?.save ? patchShape(tiles) : null;
  if (!S) return;
  const s = lineScale(zoom);
  if (line !== null) {
    const e = outCubic(line), on = Math.max(1, S.len * e);
    g.save();
    g.lineJoin = 'round';
    g.setLineDash?.([on, S.len * 2]);
    g.globalAlpha = 0.45; g.strokeStyle = GOLD; g.lineWidth = 14 * s; g.stroke(S.outer);
    g.setLineDash?.([]);
    g.restore();
    strokeGold(g, S.outer, { zoom, dash: [on, S.len * 2] });
    return;
  }
  if (close >= 1) return;
  const a = 1 - close;
  g.save();
  g.lineJoin = 'round';
  g.globalAlpha = 0.5 * a; g.strokeStyle = GOLD; g.lineWidth = (10 + 16 * close) * s; g.stroke(S.outer);
  g.globalAlpha = 0.9 * a; g.strokeStyle = YOURS.core; g.lineWidth = 2.2 * s; g.stroke(S.outer);
  g.restore();
}
/**
 * The old gold line of land the viewer has just lost (`k` 0..1). `how` 'break': it turns ember and breaks up, the
 * gaps growing as it fades (a banner taken); 'back': it draws back along itself and is gone (a banner pulled down).
 */
export function paintLineLost(g, tiles, { zoom = 1, k = 0, how = 'break' } = {}) {
  const S = g?.save ? patchShape(tiles) : null;
  if (!S || k >= 1) return;
  const s = lineScale(zoom);
  if (how === 'back') { const on = Math.max(0.01, S.len * (1 - outCubic(k))); strokeGold(g, S.outer, { zoom, dash: [on, S.len * 2], alpha: 1 - 0.3 * k }); return; }
  const gap = 14 * s * k, dash = Math.max(2 * s, 16 * s * (1 - 0.6 * k));
  strokeGold(g, S.outer, { zoom, colour: mix(GOLD, [255, 106, 74], Math.min(1, k * 2.5)), dash: gap > 0.01 ? [dash, gap] : null, alpha: 1 - k });
}
/** The dotted gold edge of each tile where a banner can rise. */
export function paintRiseEdges(g, tiles, { zoom = 1, alpha = 1 } = {}) {
  if (!g?.save || typeof Path2D === 'undefined' || !tiles?.length) return;
  const key = `rise|${tiles.length}|${tiles[0].q},${tiles[0].r}|${tiles[tiles.length - 1].q},${tiles[tiles.length - 1].r}`;
  let p = shapes.get(key);
  if (!p) { p = new Path2D(); for (const t of tiles) hexInto(p, t, PROTO_LOOK.rise.inset); if (shapes.size > 160) shapes.clear(); shapes.set(key, p); }
  const k = lineScale(zoom), R = PROTO_LOOK.rise;
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.setLineDash?.([R.dash[0] * k, R.dash[1] * k]);
  g.globalAlpha = 0.55 * alpha; g.strokeStyle = YOURS.key; g.lineWidth = (R.width + 1.6) * k; g.stroke(p);
  g.globalAlpha = R.alpha * alpha; g.strokeStyle = YOURS.gold; g.lineWidth = R.width * k; g.stroke(p);
  g.setLineDash?.([]);
  // (and a gold dot in the middle of each: the choice is seen before the pointer is over it)
  const r = R.dot / zoom;
  for (const t of tiles) { const c = project(t.q, t.r); g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2); g.globalAlpha = 0.6 * alpha; g.fillStyle = YOURS.key; g.fill(); g.beginPath(); g.arc(c.x, c.y, r * 0.72, 0, Math.PI * 2); g.globalAlpha = R.dotAlpha * alpha; g.fillStyle = GOLD; g.fill(); }
  g.restore();
}
/**
 * The flower of a candidate: the land a banner there would take, in the nation's colour breathing, a dashed gold
 * line marching round it; the tail the route would bring fainter inside the same line.
 * `faint`: a claim in progress — not owned yet: a breath of the colour and a thin line of it while the count runs,
 * dashed gold once the count is done (`ready`).
 */
export function paintFlower(g, tiles, tail = [], { zoom = 1, now = fxNow(), still = false, faint = false, ready = false, nation = 0, alpha = 1 } = {}) {
  const extra = tail.filter(t => !tiles.some(x => x.q === t.q && x.r === t.r)), all = [...tiles, ...extra];
  const S = g?.save ? patchShape(all) : null;
  if (!S) return;
  const k = lineScale(zoom), F = PROTO_LOOK.flower, col = landColour(nation);
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'butt';
  if (faint) {
    g.globalAlpha = PROTO_LOOK.claim.fill * alpha; g.fillStyle = col; g.fill(S.fill);
    if (!ready) {
      g.globalAlpha = 0.4 * alpha; g.strokeStyle = `${INK}1)`; g.lineWidth = 3 * k; g.stroke(S.outer);
      g.globalAlpha = 0.8 * alpha; g.strokeStyle = col; g.lineWidth = 1.4 * k; g.stroke(S.outer);
    }
  } else {
    const beat = still ? 0.5 : 0.5 + 0.5 * Math.sin((now / 1000) * (2 * Math.PI / F.breath));
    const head = patchShape(tiles), rest = extra.length ? patchShape(extra) : null;
    g.fillStyle = col;
    if (head) { g.globalAlpha = (F.fill[0] + (F.fill[1] - F.fill[0]) * beat) * alpha; g.fill(head.fill); }
    if (rest) { g.globalAlpha = F.tail * alpha; g.fill(rest.fill); }
  }
  g.restore();
  if (!faint || ready) strokeGold(g, S.outer, { zoom, alpha: (faint ? 0.9 : 1) * alpha, dash: [F.dash[0] * k, F.dash[1] * k], offset: still ? 0 : -((now / 1000) * F.march * (faint ? 0.5 : 1)) * k });
}
/** A tile a banner of the viewer's can be widened onto today: a small gold bud with "+1" (screen sized), on the tile's middle. */
export function paintBud(g, tile, { zoom = 1, now = fxNow(), still = false } = {}) {
  if (!g?.save || !tile) return;
  const k = 1 / zoom, c = project(tile.q, tile.r), r = 9 * k, beat = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 1000 * 2.4);
  g.save();
  g.beginPath(); g.arc(c.x, c.y, r + 2.5 * k * beat, 0, Math.PI * 2); g.globalAlpha = 0.25 * (1 - beat * 0.5); g.fillStyle = YOURS.gold; g.fill();
  g.globalAlpha = 1; g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2); g.fillStyle = 'rgba(13,24,22,.94)'; g.fill(); g.strokeStyle = YOURS.gold; g.lineWidth = 1.6 * k; g.stroke();
  g.fillStyle = YOURS.gold; g.font = `700 ${10 * k}px system-ui, -apple-system, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText?.('+1', c.x, c.y + 0.5 * k);
  g.restore();
}
/** A tile where no banner can rise, as the choosing shows it: a quiet ember hexagon (its glyph and its sentence stand over it: paintRefusalGlyph). */
export function paintRefusedTile(g, tile, { zoom = 1, alpha = 1 } = {}) {
  if (!g?.save || !tile) return;
  const k = lineScale(zoom), c = project(tile.q, tile.r);
  g.save();
  g.lineJoin = 'round';
  g.beginPath(); hexPoints(c.x, c.y, 5).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
  g.globalAlpha = 0.16 * alpha; g.fillStyle = EMBER; g.fill();
  g.setLineDash?.([4 * k, 4 * k]);
  g.globalAlpha = 0.75 * alpha; g.strokeStyle = `${INK}1)`; g.lineWidth = 4 * k; g.stroke();
  g.globalAlpha = alpha; g.strokeStyle = '#ff9d86'; g.lineWidth = 2 * k; g.stroke();
  g.setLineDash?.([]);
  g.restore();
}
/** The glyph of a refusal on a dark disc (screen sized), centre (x, y): `eye` not surveyed, `full` a limit is reached, `short` something is lacking, `bar` not here. */
export function paintRefusalGlyph(g, x, y, glyph, { zoom = 1, alpha = 1 } = {}) {
  if (!g?.save) return;
  const k = 1 / zoom, r = 11 * k;
  g.save();
  g.globalAlpha = alpha;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = 'rgba(46,14,9,.95)'; g.fill(); g.strokeStyle = '#ff9d86'; g.lineWidth = 1.5 * k; g.stroke();
  const ink = '#ffe9e2';
  if (glyph === 'eye') { paintGlyph(g, 'eye', x, y, r * 1.45, { colour: ink, weight: 2 }); g.strokeStyle = ink; g.lineWidth = 1.7 * k; g.lineCap = 'round'; g.beginPath(); g.moveTo(x - r * 0.55, y + r * 0.55); g.lineTo(x + r * 0.55, y - r * 0.55); g.stroke(); }
  else if (glyph === 'full') { paintGlyph(g, 'banner', x, y, r * 1.4, { colour: ink, weight: 2 }); g.strokeStyle = ink; g.lineWidth = 1.7 * k; g.lineCap = 'round'; g.beginPath(); g.moveTo(x - r * 0.55, y + r * 0.55); g.lineTo(x + r * 0.55, y - r * 0.55); g.stroke(); }
  else if (glyph === 'short') { g.strokeStyle = ink; g.lineWidth = 2.2 * k; g.lineCap = 'round'; g.beginPath(); g.moveTo(x - r * 0.5, y); g.lineTo(x + r * 0.5, y); g.stroke(); }
  else { g.strokeStyle = ink; g.lineWidth = 2 * k; g.lineCap = 'round'; g.beginPath(); g.arc(x, y, r * 0.52, 0, Math.PI * 2); g.moveTo(x - r * 0.37, y + r * 0.37); g.lineTo(x + r * 0.37, y - r * 0.37); g.stroke(); }
  g.restore();
}

// ------------------------------------------------------------------ the trail
/**
 * A trail as ground that will become land: each tile takes a breath of the nation's colour, and a band of it runs
 * through the tiles' middles to the host (`at`), a dashed gold core in it. `ink(i)` 0..1: how much of tile i is
 * inked (from the far end to the host); `gold`: the viewer's own (another's has no gold core).
 */
export function paintTrailBand(g, tiles, { zoom = 1, at = null, nation = 0, gold = true, ink = () => 1, alpha = 1 } = {}) {
  if (!g?.save || !tiles?.length || !(alpha > 0)) return;
  const T = PROTO_LOOK.trail, k = lineScale(zoom), col = landColour(nation);
  const pts = tiles.map(t => project(t.q, t.r)), end = at ? project(at.q, at.r) : null;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  tiles.forEach((t, i) => { const a = ink(i) * alpha; if (a > 0) { hexPath(g, pts[i]); g.globalAlpha = T.fill * a; g.fillStyle = col; g.fill(); } });
  // (the band: tile by tile, each piece from its tile's middle to the next one's, so it is inked as the tiles are)
  const seg = (a, b, w, style, al, dash = null) => { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.setLineDash?.(dash ?? []); g.globalAlpha = al; g.strokeStyle = style; g.lineWidth = w; g.stroke(); };
  pts.forEach((c, i) => {
    const a = ink(i) * alpha, to = pts[i + 1] ?? end;
    if (!(a > 0) || !to) return;
    const b = { x: c.x + (to.x - c.x) * Math.min(1, ink(i)), y: c.y + (to.y - c.y) * Math.min(1, ink(i)) };
    seg(c, b, (T.band + 2.5) * k, `${INK}1)`, 0.45 * a);
    seg(c, b, T.band * k, col, T.alpha * a);
    if (gold) seg(c, b, T.core * k, GOLD, 0.95 * a, [5 * k, 4 * k]);
  });
  g.setLineDash?.([]);
  g.restore();
}
/**
 * A host's trail: a pair of footprints on each tile, in the order it was walked (the last one beside the host),
 * each turned the way the column went. `ink(i)` 0..1: how much of tile i is inked; `alpha` of the whole.
 */
export function paintFootprints(g, tiles, { zoom = 1, at = null, nation = 0, mine = false, ink = () => 1, alpha = 1, scale = PROTO_LOOK.trail.steps } = {}) {
  if (!g?.save || !tiles?.length || !(alpha > 0)) return;
  const pts = tiles.map(t => project(t.q, t.r)), end = at ? project(at.q, at.r) : null;
  const col = mine ? GOLD : clothColour(nation), s = RADIUS * 0.15 * scale;
  g.save();
  pts.forEach((c, i) => {
    const a = ink(i) * alpha;
    if (!(a > 0)) return;
    const to = pts[i + 1] ?? end ?? (pts[i - 1] ? { x: 2 * c.x - pts[i - 1].x, y: 2 * c.y - pts[i - 1].y } : { x: c.x + 1, y: c.y });
    const ang = Math.atan2((to.y - c.y) / FLATTEN, to.x - c.x), pop = 0.7 + 0.3 * Math.min(1, ink(i) * 1.4);
    // two steps on a tile: left a little behind, right a little ahead, lying on the ground (flattened as the board is)
    for (const [along, side] of [[-0.34, -0.2], [0.22, 0.2]]) {
      const x = c.x + (Math.cos(ang) * along - Math.sin(ang) * side) * RADIUS, y = c.y + (Math.sin(ang) * along + Math.cos(ang) * side) * RADIUS * FLATTEN;
      g.save();
      g.translate(x, y); g.scale(1, FLATTEN); g.rotate(ang); g.scale(pop, pop);
      // the sole and the heel of a boot
      const print = () => { g.beginPath(); g.ellipse?.(s * 0.5, 0, s * 0.95, s * 0.52, 0, 0, Math.PI * 2); g.ellipse?.(-s * 0.95, 0, s * 0.42, s * 0.4, 0, 0, Math.PI * 2); };
      print(); g.globalAlpha = 0.7 * a; g.lineWidth = s * 0.5; g.strokeStyle = `${INK}1)`; g.stroke();
      print(); g.globalAlpha = 0.95 * a; g.fillStyle = col; g.fill();
      g.restore();
    }
  });
  g.restore();
}

// ------------------------------------------------------------------ the banner on its pole
/** How tall a banner's pole is (world px) at `zoom`: a part of the board close up, never smaller than a small flag on screen; a little lower than the village's standard. */
export const bannerUnit = zoom => Math.max(RADIUS * 0.92, 20 / zoom);
function sigilPath(g, shape, x, y, r) {
  const pts = n => Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [x + Math.cos(a) * r, y + Math.sin(a) * r]; });
  g.beginPath();
  if (shape === 'circle' || shape === 'ring') g.arc(x, y, r * 0.86, 0, Math.PI * 2);
  else if (shape === 'cross') { const w = r * 0.36; [[-w, -r], [w, -r], [w, -w], [r, -w], [r, w], [w, w], [w, r], [-w, r], [-w, w], [-r, w], [-r, -w], [-w, -w]].forEach(([px, py], i) => (i ? g.lineTo(x + px, y + py) : g.moveTo(x + px, y + py))); g.closePath(); }
  else { const c = shape === 'triangle' ? pts(3) : shape === 'square' ? pts(4).map(([px, py]) => [x + ((px - x) - (py - y)) * 0.62, y + ((py - y) + (px - x)) * 0.62]) : shape === 'diamond' ? pts(4) : pts(6); c.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); }
}
/**
 * A banner at world point (x, y), the foot of its pole. `u` its height unit (bannerUnit).
 *   firm      a stiff square cloth hung from a yard, the pole on a stone foot; else a pennon that moves
 *   mine      the gold finial and the gold ring at its foot (the viewer's mark); else an ink ball
 *   frayed    the cloth is torn along its fly edge (`fray` 0..1: how far a walk that is due has gone toward that)
 *   notches   `[{nation, side (−1 left, 1 right)}]`: a border banner's notch on the pole, in the colour of the nation it faces
 *   lift      1 high above the ground … 0 on it (the drop of a raise); `dust` 0..1 or null
 *   fall      0 upright … 1 lying (a banner pulled down)
 *   rise      0..1: a pole still going up (a claim in progress): that much of its height, the cloth furled
 *   ghost     another nation's claim in progress: drawn thin and half there
 */
export function paintBanner(g, x, y, { u = RADIUS, zoom = 1, nation = 0, mine = false, firm = true, frayed = false, fray = 0, notches = [], now = fxNow(), still = false, lift = 0, alpha = 1, dust = null, sparks = null, pop = 1, fall = 0, rise = null, ghost = false, near = false, half = false, cloth = 1 } = {}) {
  // `sparks` 0..1: gold sparks flying from the foot as the pole lands; `pop`: the cloth's scale (it lands large and settles)
  // `ghost`: another nation's claim in progress, `near`: little time is left (it is drawn nearly whole)
  // `half`: a claim of the viewer's whose count is done: the cloth is out half way and sways
  if (!g?.save || !(alpha > 0)) return;
  const col = clothColour(nation), dark = NATION_INK[nation] ?? '#3a3a34', lw = Math.max(1 / zoom, u * 0.03);
  const t = still ? 0.8 : now / 1000;
  const full = u * 1.56, H = full * (rise === null ? 1 : 0.3 + 0.7 * clamp01(rise)), up = lift * u * 2.4;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  if (dust !== null && dust >= 0 && dust < 1) {
    const e = 1 - Math.pow(1 - dust, 2);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5, dx = Math.cos(a) * u * (0.12 + 0.55 * e), dy = Math.sin(a) * u * (0.12 + 0.55 * e) * FLATTEN * 0.8 - u * 0.08 * e * (i % 2);
      g.globalAlpha = 0.6 * Math.pow(1 - dust, 0.7) * alpha; g.fillStyle = i % 2 ? '#f4ead0' : '#dccca4';
      g.beginPath(); g.ellipse?.(x + dx, y + dy, u * (0.1 + 0.18 * e), u * (0.07 + 0.1 * e), 0, 0, Math.PI * 2); g.fill();
    }
    // the ring of dust on the ground: out to six tenths of a tile
    const rr = RADIUS * 0.6 * e;
    g.globalAlpha = 0.75 * (1 - dust) * alpha; g.strokeStyle = '#f4ead0'; g.lineWidth = Math.max(lw * 2.4, RADIUS * 0.09 * (1 - dust)); g.beginPath(); g.ellipse?.(x, y, rr, rr * FLATTEN, 0, 0, Math.PI * 2); g.stroke();
    if (mine) { g.globalAlpha = 0.85 * (1 - dust) * alpha; g.strokeStyle = GOLD; g.lineWidth = lw * 1.8; g.beginPath(); g.ellipse?.(x, y, rr * 1.18, rr * 1.18 * FLATTEN, 0, 0, Math.PI * 2); g.stroke(); }
  }
  if (sparks !== null && sparks >= 0 && sparks < 1) {
    // eight gold sparks thrown up from the foot, falling back
    const e = outCubic(sparks);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.3, d = u * (0.25 + 0.75 * e) * (0.8 + 0.4 * ((i * 7) % 5) / 4), h = u * (1.5 * sparks - 1.9 * sparks * sparks) * (0.7 + 0.5 * ((i * 3) % 4) / 3);
      const sx = x + Math.cos(a) * d, sy = y + Math.sin(a) * d * FLATTEN - h, r = Math.max(1.4 / zoom, u * 0.045 * (1 - 0.6 * sparks));
      g.globalAlpha = (1 - sparks) * alpha; g.fillStyle = i % 2 ? GOLD : '#fff6d8'; g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.fill();
    }
  }
  const A = alpha * (ghost ? (near ? 0.9 : 0.66) : 1);
  // its shadow, and the viewer's ring at its foot
  g.globalAlpha = 0.32 * A * (1 - 0.6 * lift) * (1 - fall); g.fillStyle = '#0c1210';
  g.beginPath(); g.ellipse?.(x + u * 0.14, y + u * 0.03, u * 0.26, u * 0.09, 0, 0, Math.PI * 2); g.fill();
  if (mine && !lift && !fall) {
    g.beginPath(); g.ellipse?.(x, y, u * 0.2, u * 0.2 * 0.5, 0, 0, Math.PI * 2);
    g.globalAlpha = 0.9 * A; g.strokeStyle = YOURS.key; g.lineWidth = lw * 2.6; g.stroke(); g.globalAlpha = A; g.strokeStyle = YOURS.gold; g.lineWidth = lw * 1.5; g.stroke();
  }
  g.globalAlpha = A;
  g.translate(x, y - up);
  if (fall > 0) g.rotate((Math.PI / 2) * (fall * fall) * 0.98);
  // (a ghost banner: the pole is whole and stands on a dark edge two px wide, so it is found on any ground)
  if (ghost) { g.strokeStyle = 'rgba(12,18,16,.9)'; g.lineWidth = u * 0.07 + 4 / zoom; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -H); g.stroke(); }
  // the foot: a stone block under a firm banner
  if (firm && rise === null && !ghost) { g.fillStyle = '#8f8a78'; g.strokeStyle = '#161d1a'; g.lineWidth = lw; g.beginPath(); g.rect?.(-u * 0.11, -u * 0.09, u * 0.22, u * 0.1); g.fill(); g.stroke(); }
  // the pole
  g.strokeStyle = '#161d1a'; g.lineWidth = u * (firm ? 0.095 : 0.07); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -H); g.stroke();
  g.strokeStyle = mine ? '#b08a3c' : '#8a7a58'; g.lineWidth = u * (firm ? 0.045 : 0.032); g.beginPath(); g.moveTo(0, -u * 0.02); g.lineTo(0, -H + u * 0.02); g.stroke();
  g.setLineDash?.([]);
  // a border banner's notch: a peg on the pole toward the border, in the colour of the nation across it
  notches.slice(0, 2).forEach((n, i) => {
    const ny = -H * (0.34 + 0.13 * i), s = n.side < 0 ? -1 : 1;
    g.beginPath(); g.moveTo(0, ny - u * 0.06); g.lineTo(s * u * 0.2, ny); g.lineTo(0, ny + u * 0.06); g.closePath();
    g.fillStyle = clothColour(n.nation); g.fill(); g.strokeStyle = '#161d1a'; g.lineWidth = lw; g.stroke();
  });
  const top = -H + u * 0.08;
  if (rise !== null && half) {
    // the count is done: the cloth is out half way from the pole's head and sways, waiting for the order
    const w = u * 0.42, h = u * 0.36, sway = Math.sin(t * 2.2) * u * 0.035;
    const shape = () => { g.beginPath(); g.moveTo(0, top); g.lineTo(-w + sway, top + u * 0.04 + sway * 0.6); g.lineTo(-w * 0.72 + sway, top + h * 0.5); g.lineTo(-w + sway, top + h + sway * 0.4); g.lineTo(0, top + h * 0.9); g.closePath(); };
    shape(); g.fillStyle = col; g.fill(); g.strokeStyle = '#161d1a'; g.lineWidth = lw; g.stroke();
    g.strokeStyle = GOLD; g.lineWidth = lw * 1.4; g.beginPath(); g.moveTo(0, top + h * 0.95); g.lineTo(0, top - u * 0.02); g.stroke();
  } else if (rise !== null) {
    // furled: the cloth bound to the pole until the banner is raised
    g.fillStyle = col; g.strokeStyle = '#161d1a'; g.lineWidth = lw;
    g.beginPath(); g.ellipse?.(u * 0.035, top + u * 0.16, u * 0.065, u * 0.2, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.strokeStyle = IVORY; g.beginPath(); g.moveTo(-u * 0.04, top + u * 0.1); g.lineTo(u * 0.11, top + u * 0.13); g.moveTo(-u * 0.04, top + u * 0.21); g.lineTo(u * 0.11, top + u * 0.24); g.stroke();
  } else if (cloth > 0) {
    if (pop !== 1) { g.translate(0, top); g.scale(pop, pop); g.translate(0, -top); }
    const tear = frayed ? 1 : clamp01(fray), sg = SIGILS[nation] ?? 'ring';
    let shapeCloth, light, shade, sx, sy, sr;
    if (firm) {
      // a firm banner: a square cloth hung from a yard across the pole's head, its foot cut to a swallow tail; it hardly moves
      const w = u * 0.66, h = u * 0.74 * cloth, sway = Math.sin(t * 1.1) * u * 0.012;
      g.strokeStyle = '#161d1a'; g.lineWidth = u * 0.06; g.beginPath(); g.moveTo(-w / 2 - u * 0.05, top); g.lineTo(w / 2 + u * 0.05, top); g.stroke();
      shapeCloth = () => {
        g.beginPath(); g.moveTo(-w / 2, top); g.lineTo(w / 2, top); g.lineTo(w / 2 + sway, top + h);
        // (a walk that is due, a frayed banner: the foot is torn into threads)
        if (tear > 0) { const n = 6; for (let i = 1; i < n; i++) g.lineTo(w / 2 - (w * i) / n + sway, top + h - (i % 2 ? h * 0.3 * tear : 0)); }
        else g.lineTo(sway, top + h * 0.8);
        g.lineTo(-w / 2 + sway, top + h); g.closePath();
      };
      light = () => { g.beginPath(); g.moveTo(-w / 2, top + u * 0.06); g.lineTo(w / 2, top + u * 0.06); };
      shade = () => { g.beginPath(); g.moveTo(w / 2 - u * 0.04, top); g.lineTo(w / 2 - u * 0.04 + sway, top + h); };
      sx = sway * 0.4; sy = top + h * 0.42; sr = u * 0.19;
    } else {
      // a loose banner: a pennon flying from the pole's head, away from the host that stands beside it; it moves
      const w = u * 0.9, h = u * 0.46 * cloth, N = 8;
      const wave = xr => Math.sin(t * 2.6 - xr * 5.2) * u * 0.06 * xr + Math.sin(t * 1.3 - xr * 2.1) * u * 0.02 * xr;
      const upper = [], lower = [];
      for (let i = 0; i <= N; i++) { const xr = i / N; upper.push([-xr * w, top + xr * u * 0.05 + wave(xr)]); lower.push([-xr * w, top + h - xr * h * 0.5 + wave(xr)]); }
      shapeCloth = () => {
        g.beginPath(); upper.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
        if (tear > 0) { const [ex, ey] = upper[N], [, fy2] = lower[N], steps = 5; for (let i = 1; i < steps; i++) g.lineTo(ex + (i % 2 ? w * 0.22 * tear : 0), ey + (fy2 - ey) * (i / steps)); }
        for (let i = N; i >= 0; i--) g.lineTo(lower[i][0], lower[i][1]);
        g.closePath();
      };
      light = () => { g.beginPath(); upper.forEach(([px, py], i) => (i ? g.lineTo(px, py + u * 0.04) : g.moveTo(px, py + u * 0.04))); };
      shade = () => { g.beginPath(); lower.forEach(([px, py], i) => (i ? g.lineTo(px, py - u * 0.03) : g.moveTo(px, py - u * 0.03))); };
      sx = -w * 0.3; sy = top + h * 0.42 + wave(0.3); sr = u * 0.125;
    }
    shapeCloth(); g.globalAlpha = A * (frayed ? 0.72 : 1); g.fillStyle = col; g.fill();
    g.save(); shapeCloth(); g.clip?.();
    g.globalAlpha = 0.22 * A; g.strokeStyle = '#fff6e2'; g.lineWidth = u * 0.08; light(); g.stroke();
    g.globalAlpha = 0.26 * A; g.strokeStyle = dark; g.lineWidth = u * 0.09; shade(); g.stroke();
    g.restore();
    g.globalAlpha = A; shapeCloth(); g.strokeStyle = '#161d1a'; g.lineWidth = ghost ? Math.max(lw, 2 / zoom) : lw; if (ghost && !near) g.setLineDash?.([u * 0.1, u * 0.06]); g.stroke(); g.setLineDash?.([]);
    // the sigil (a nation is never told by its colour alone)
    if (cloth > 0.6) {
      sigilPath(g, sg, sx, sy, sr);
      if (sg === 'ring') { g.strokeStyle = IVORY; g.lineWidth = lw * 2.2; g.stroke(); } else { g.fillStyle = NATION_ON[nation] ?? IVORY; g.fill(); g.strokeStyle = dark; g.lineWidth = lw * 0.9; g.stroke(); }
    }
    if (pop !== 1) { g.translate(0, top); g.scale(1 / pop, 1 / pop); g.translate(0, -top); }
  }
  // the finial: the viewer's jewel, or an ink ball
  const fy = -H - u * 0.07, fr = u * 0.115;
  if (mine) {
    const loz = s => { g.beginPath(); g.moveTo(0, fy - fr * 1.25 * s); g.lineTo(fr * 0.82 * s, fy); g.lineTo(0, fy + fr * 1.08 * s); g.lineTo(-fr * 0.82 * s, fy); g.closePath(); };
    loz(1); g.fillStyle = YOURS.gold; g.fill(); g.strokeStyle = YOURS.key; g.lineWidth = lw * 1.3; g.stroke();
    loz(0.42); g.fillStyle = YOURS.core; g.fill();
  } else { g.beginPath(); g.arc(0, fy + fr * 0.3, fr * 0.6, 0, Math.PI * 2); g.fillStyle = ghost ? rgba(col, 0.8) : '#2a302c'; g.fill(); g.strokeStyle = '#161d1a'; g.lineWidth = lw; g.stroke(); }
  g.restore();
}

// ------------------------------------------------------------------ dials and rings
/**
 * A ring dial of turns (screen sized), centre (x, y): the ring fills by `share` (0..1), one notch a turn when there
 * are few, the turns left in the middle (a tick when none are). `colour`: ember for a threat, gold for the viewer's
 * own count, a nation's colour for its claim. `r`: the ring's radius, `arc` its width (screen px). `bump` 1..0: the
 * count has just changed (the dial lands large and settles; `sparks` fly from it for a threat).
 */
export function paintTurnDial(g, x, y, { zoom = 1, share = 0, left = null, total = null, colour = EMBER, r = 13, arc = 4, alpha = 1, now = fxNow(), still = false, pulse = false, bump = 0, sparks = false, alarm = false } = {}) {
  if (!g?.save || !(alpha > 0)) return;
  const grow = 1 + 0.3 * clamp01(bump) * clamp01(bump);
  const k = grow / zoom, R = r * k, a0 = -Math.PI / 2, TAU = Math.PI * 2;
  const beat = pulse && !still ? 0.5 + 0.5 * Math.sin(now / 1000 * 4.2) : 0;
  g.save();
  g.globalAlpha = alpha; g.lineCap = 'butt';
  if (sparks && bump > 0) {
    const e = 1 - bump;
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + 0.5, d = R + (5 + 16 * outCubic(e)) / zoom; g.globalAlpha = alpha * bump; g.fillStyle = i % 2 ? colour : '#ffd9c2'; g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, (2.4 - 1.2 * e) / zoom, 0, TAU); g.fill(); }
    g.globalAlpha = alpha;
  }
  if (pulse) { g.globalAlpha = alpha * (0.2 + 0.25 * beat); g.strokeStyle = colour; g.lineWidth = (3 + 3 * beat) * k; g.beginPath(); g.arc(x, y, R + (4.5 + 2.5 * beat) * k, 0, TAU); g.stroke(); g.globalAlpha = alpha; }
  g.fillStyle = 'rgba(4,10,9,.4)'; g.beginPath(); g.arc(x, y + 1.4 * k, R + (arc / 2 + 1.6) * k, 0, TAU); g.fill();
  g.fillStyle = 'rgba(13,24,22,.96)'; g.beginPath(); g.arc(x, y, R + (arc / 2 + 1.2) * k, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,250,240,.2)'; g.lineWidth = arc * k; g.beginPath(); g.arc(x, y, R, 0, TAU); g.stroke();
  g.strokeStyle = colour; g.beginPath(); g.arc(x, y, R, a0, a0 + TAU * Math.max(0.02, clamp01(share))); g.stroke();
  if (Number.isInteger(total) && total > 1 && total <= 12) {
    g.strokeStyle = 'rgba(13,24,22,.95)'; g.lineWidth = 1 * k;
    for (let i = 0; i < total; i++) { const a = a0 + (TAU * i) / total; g.beginPath(); g.moveTo(x + Math.cos(a) * (R - (arc / 2 + 0.3) * k), y + Math.sin(a) * (R - (arc / 2 + 0.3) * k)); g.lineTo(x + Math.cos(a) * (R + (arc / 2 + 0.3) * k), y + Math.sin(a) * (R + (arc / 2 + 0.3) * k)); g.stroke(); }
  }
  g.fillStyle = '#fff6e2'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const f = r / 13;
  // (`alarm`: the count of a threat. Done, it shows an exclamation mark: the tick of a count of the viewer's own read as good news over a banner that could fall at any moment)
  if (left === 0 && alarm) { g.fillStyle = '#fff6e2'; g.beginPath(); g.moveTo(x - 1.5 * f * k, y - 5.4 * f * k); g.lineTo(x + 1.5 * f * k, y - 5.4 * f * k); g.lineTo(x + 0.9 * f * k, y + 1.5 * f * k); g.lineTo(x - 0.9 * f * k, y + 1.5 * f * k); g.closePath(); g.fill(); g.beginPath(); g.arc(x, y + 4.2 * f * k, 1.4 * f * k, 0, TAU); g.fill(); }
  else if (left === 0) { g.strokeStyle = colour; g.lineWidth = 2.2 * f * k; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); g.moveTo(x - 3.6 * f * k, y + 0.3 * f * k); g.lineTo(x - 0.8 * f * k, y + 3 * f * k); g.lineTo(x + 3.9 * f * k, y - 2.9 * f * k); g.stroke(); }
  else if (left !== null) { g.font = `800 ${(left > 99 ? 8.2 : left > 9 ? 10.2 : 11.6) * f * k}px system-ui, -apple-system, sans-serif`; g.fillText?.(String(left), x, y + 0.5 * k); }
  g.restore();
}
/**
 * A threat on the ground: the land at stake (`tiles`) under a hatch of the threatening nation's colour that drifts,
 * a dashed outline of that colour round it, and on the pole's tile a ring of it with a dark edge and a ring that
 * opens and fades again and again (faster when `fast`: little time is left). `colour`: the threatening nation's
 * (gold for the viewer's own count on another's banner).
 */
export function paintThreatGround(g, tiles, pole, { zoom = 1, now = fxNow(), still = false, colour = EMBER, alpha = 1, fast = false, held = false } = {}) {
  const S = g?.save ? patchShape(tiles) : null;
  if (!S) return;
  const T = PROTO_LOOK.threat, k = lineScale(zoom), t = still ? 0 : now / 1000;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'butt';
  // the hatch: stripes of the colour that drift across the land at stake
  g.save(); g.clip?.(S.fill);
  const step = T.stripe * 2.4 * k, h = S.box.y1 - S.box.y0, lean = h * 0.9, shift = (t * T.drift * k) % step;
  g.beginPath();
  for (let x = Math.floor((S.box.x0 - lean) / step) * step + shift - step; x <= S.box.x1 + lean; x += step) { g.moveTo(x + lean, S.box.y0); g.lineTo(x, S.box.y1); }
  g.globalAlpha = 0.55 * T.hatch * alpha; g.strokeStyle = `${INK}1)`; g.lineWidth = (T.stripe + 1.6) * k; g.stroke();
  g.globalAlpha = T.hatch * 1.6 * alpha; g.strokeStyle = colour; g.lineWidth = T.stripe * k; g.stroke();
  g.restore();
  // the outline of what would be lost
  // (`held`: the land at stake is the viewer's and wears the gold line. The outline is then drawn INSIDE the land, a
  // band of the threat's colour within the gold line's underlay, never over it: Cinder's yellow dashes over the gold
  // line read as the line itself gone thin and dark. The board strokes the gold line again after every threat.)
  const inner = held ? PROTO_LOOK.line.under / 2 : 0;
  if (held) { g.save(); g.clip?.(S.fill); }
  g.globalAlpha = 0.6 * alpha; g.strokeStyle = `${INK}1)`; g.lineWidth = (held ? 2 * (T.outline + inner + 1) : T.outline + 2) * k; g.stroke(S.outer);
  g.setLineDash?.([8 * k, 5 * k]); if ('lineDashOffset' in g) g.lineDashOffset = -t * T.drift * k;
  g.globalAlpha = alpha; g.strokeStyle = colour; g.lineWidth = (held ? 2 * (T.outline + inner) : T.outline) * k; g.stroke(S.outer);
  g.setLineDash?.([]); if ('lineDashOffset' in g) g.lineDashOffset = 0;
  if (held) g.restore();
  if (pole) {
    const c = project(pole.q, pole.r), rx = RADIUS * 0.74, period = fast ? T.pulseFast : T.pulse, ph = still ? 0.4 : (t % period) / period;
    // the ring that opens and fades
    g.beginPath(); g.ellipse?.(c.x, c.y, rx * (1 + 0.35 * ph), rx * (1 + 0.35 * ph) * FLATTEN, 0, 0, Math.PI * 2);
    g.globalAlpha = 0.8 * (1 - ph) * alpha; g.strokeStyle = colour; g.lineWidth = T.ring * k; g.stroke();
    g.beginPath(); g.ellipse?.(c.x, c.y, rx, rx * FLATTEN, 0, 0, Math.PI * 2);
    g.globalAlpha = 0.9 * alpha; g.strokeStyle = 'rgba(12,18,16,1)'; g.lineWidth = (T.ring + 2) * k; g.stroke();
    g.globalAlpha = alpha; g.strokeStyle = colour; g.lineWidth = T.ring * k; g.stroke();
  }
  g.restore();
}
/** A flash of white on a tile (`k` 1..0). */
export function paintTileFlash(g, tile, k, alpha = 0.7) {
  if (!g?.save || !tile || !(k > 0)) return;
  g.save(); hexPath(g, project(tile.q, tile.r)); g.globalAlpha = alpha * clamp01(k); g.fillStyle = '#ffffff'; g.fill(); g.restore();
}
/** A ring of `colour` opening on the ground from a tile's middle to `reach` tiles (`k` 0..1), fading. */
export function paintPulseRing(g, tile, k, { zoom = 1, colour = GOLD, reach = 1 } = {}) {
  if (!g?.save || !tile || !(k >= 0) || k >= 1) return;
  const c = project(tile.q, tile.r), e = outCubic(k), rx = RADIUS * Math.sqrt(3) * reach * e, s = lineScale(zoom);
  g.save();
  g.beginPath(); g.ellipse?.(c.x, c.y, rx, rx * FLATTEN, 0, 0, Math.PI * 2);
  g.globalAlpha = 0.35 * (1 - k); g.strokeStyle = colour; g.lineWidth = 12 * s; g.stroke();
  g.globalAlpha = 0.95 * (1 - k); g.lineWidth = 3 * s; g.stroke();
  g.restore();
}
/**
 * A number that leaves the pole (screen sized, at world point (x, y)): large, in `colour` with a dark outline,
 * moving `travel` screen px over its life (`k` 0..1; negative `travel` rises), fading at the end.
 */
export function paintBigNumber(g, x, y, text, k, { zoom = 1, colour = GOLD, size = 30, travel = -44 } = {}) {
  if (!g?.save || !text || k === null || k < 0 || k >= 1) return;
  const s = 1 / zoom, e = outCubic(k), pop = k < 0.12 ? 0.6 + 0.4 * (k / 0.12) : 1;
  g.save();
  g.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
  g.font = `800 ${size * pop * s}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const ty = y + travel * e * s;
  g.lineJoin = 'round'; g.strokeStyle = '#171006'; g.lineWidth = 6 * s; g.strokeText?.(text, x, ty);
  g.fillStyle = colour; g.fillText?.(text, x, ty);
  g.restore();
}

// ------------------------------------------------------------------ from afar
/**
 * A province on the world chart under the prototype: its outline in the colour of the nation that holds it, and the
 * province filled like a gauge from its foot by who holds how many of its tiles (`shares`: `[{nation, tiles}]`, the
 * holder first; `total` tiles). The viewer's own nation's part carries the gold rail on its upper edge when `mark`.
 */
export function paintProvinceGauge(g, prov, { zoom = 1, viewer = null, alpha = 1 } = {}) {
  if (!g?.save || !prov?.shares?.length) return;
  const pts = provinceCorners(prov.p, prov.q, 3 / zoom), k = 1 / zoom;
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  for (const [x, y] of pts) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  const trace = () => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
  g.save();
  g.lineJoin = 'round';
  g.save(); trace(); g.clip?.();
  let at = y1;
  for (const s of prov.shares) {
    const h = (y1 - y0) * (s.tiles / Math.max(1, prov.total)), holder = s.nation === prov.holder;
    // (the holder's part is its commons and its own land together: pale; another nation's land in the province: solid)
    g.globalAlpha = (holder ? 0.2 : 0.62) * alpha; g.fillStyle = landColour(s.nation);
    g.fillRect?.(x0, at - h, x1 - x0, h);
    if (!holder) { g.globalAlpha = 0.9 * alpha; g.strokeStyle = `${INK}.9)`; g.lineWidth = 1.2 * k; g.beginPath(); g.moveTo(x0, at - h); g.lineTo(x1, at - h); g.stroke(); }
    at -= h;
  }
  g.restore();
  trace();
  g.globalAlpha = 0.7 * alpha; g.strokeStyle = `${INK}1)`; g.lineWidth = 4.2 * k; g.stroke();
  g.globalAlpha = alpha; g.strokeStyle = nationPale(prov.holder) ? clothColour(prov.holder) : landColour(prov.holder); g.lineWidth = 2.2 * k; g.stroke();
  if (viewer !== null && prov.mineHere > 0) strokeYours(g, null, 1.6 * k, { alpha, dash: [5 * k, 4 * k] });
  g.restore();
}
/** A banner from the middle distance: a small square of its nation's colour on a pin (screen sized), gold-rimmed when it is the viewer's. */
export function paintBannerPip(g, x, y, { zoom = 1, nation = 0, mine = false, frayed = false } = {}) {
  if (!g?.save) return;
  const k = 1 / zoom, s = 7 * k;
  g.save();
  g.strokeStyle = '#161d1a'; g.lineWidth = 2 * k; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - s * 2.1); g.stroke();
  g.beginPath(); g.rect?.(x, y - s * 2.1, s * 1.15, s);
  g.globalAlpha = frayed ? 0.6 : 1; g.fillStyle = clothColour(nation); g.fill(); g.globalAlpha = 1;
  if (mine) { g.strokeStyle = YOURS.key; g.lineWidth = 2.6 * k; g.stroke(); g.strokeStyle = YOURS.gold; g.lineWidth = 1.4 * k; g.stroke(); }
  else { g.strokeStyle = '#161d1a'; g.lineWidth = 1 * k; g.stroke(); }
  g.restore();
}
