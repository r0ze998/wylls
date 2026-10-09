// Tiles you can act on light up (UX brief §5.2).
//
// Selecting one of the viewer's own hosts on the map (on its village, or
// wherever it stands) lights at once what it can do, with no panel button
// first. Reach is one shape (UX brief §11.7): the outer contour of everything
// the host can reach, pale teal with a glow, a light just inside it, and
// everything outside it a little darker. Only the targets keep a hexagon of
// their own, each with its glyph:
//
//   attack          ember red and crossed swords where a camp, a village of a
//                   hostile nation or a hostile host stands (ember for every
//                   nation, as the legend says it; the swords say it too)
//   home            gold and a house: the way back to one of the viewer's villages
//   explore         sky blue and an eye: the tiles a Scout can explore from where it stands
//
// What is lit comes from the rule functions, never from this file:
//   hud/reach.mjs reachTiles   a breadth-first walk over passable tiles, at most
//                              reachSteps(stamina) steps (the near reach, six at most)
//   fland.mjs exploreTargets   the passable, unexplored tiles next to a Scout
//   fland.mjs actionBlocks     whether the host may Depart or Explore now
// Passability is the rules module's (frontier.wasm generate_province, through
// map/terrain.mjs), the same generator the program uses. The lit tiles are the
// near reach, not the whole rule: a march may go further (32 steps, 4
// provinces). So a tap on an unlit tile is put to the planner (fmarch.mjs
// planRoute, the kernel's plan_path) and refused on the map only when the
// planner refuses it (app.mjs).
//
// What a tile is called follows the survey (map/survey.mjs): a camp or a host
// the map does not draw is not announced by an ember tile either.
//
// Pure model first; the painters after it are context-tolerant.
import { FLATTEN, RADIUS, hexPoints, project } from '../../map.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { tileHex } from '../fgeo.mjs';
import { errorText, unitCount } from '../fi18n.mjs';
import { SCOUT, UNIT_ORDER, actionBlocks, exploreTargets, hostsIn } from '../fland.mjs';
import { DEPART_STAMINA, freeTransitSlot } from '../fmarch.mjs';
import { reachSteps, reachTiles } from '../hud/reach.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { YOU, fxNow } from './chart.mjs';
import { upright } from './tilt.mjs';
import { landShape } from './ownland.mjs';
import { paintGlyph } from './glyphs.mjs';
import { ribbon as clothRibbon, smoothPath } from '../fx/draw.mjs';

/** The kinds of lit tile, in the order a tile takes them (the first that applies). */
export const ACTION_KINDS = Object.freeze(['explore', 'home', 'attack', 'move']);
/**
 * Their colours (the brief's --reach, --ember, --you, --sky): `fill` and the brighter `rim`. Move is the reach
 * itself: one contour in its rim colour, never a fill per tile (REACH). A target keeps a hexagon of its own, filled
 * with `veil`.
 */
export const ACTION_COLOURS = Object.freeze({
  move: Object.freeze({ fill: [216, 243, 234], rim: [206, 246, 235] }),
  attack: Object.freeze({ fill: [226, 85, 61], rim: [255, 122, 92], veil: 0.35 }),
  home: Object.freeze({ fill: [243, 213, 138], rim: [255, 236, 178], veil: 0.32 }),
  explore: Object.freeze({ fill: [127, 196, 232], rim: [186, 228, 252], veil: 0.32 }),
});
/** The roll-out: a ring of tiles appears this long after the one before it (ms) and takes this long to come up. */
export const ROLL_RING_MS = 30;
export const ROLL_FADE_MS = 190;
/** A refusal stays on the map this long (ms). */
export const NOTE_MS = 2600;

const int = Number.isInteger;
const NO_BELL = 0xffffffff;
const bit = (mask, i) => { try { return ((BigInt(mask ?? 0) >> BigInt(i)) & 1n) === 1n; } catch { return false; } };
/** Whether nations a and b are not hostile in a province (RELATIONS bit a*8+b; the same nation always). */
const calm = (relations, a, b) => a === b || bit(relations, (a % 8) * 8 + (b % 8));

/**
 * What a reached tile is, for the viewer: 'home' (one of the viewer's own
 * villages), 'attack' (a camp, a hostile nation's village that is not under
 * protection, a hostile host), else 'move'. `level` is the survey's for the
 * tile: below 2 the map draws nothing there, so the tile is a plain move; at
 * 2 it draws villages only.
 */
export function kindOf(prov, idx, { faction = null, level = 3, own = null, nowBell = 0 } = {}) {
  if (!prov || level < 2) return 'move';
  const j = Array.from(prov.sites ?? []).indexOf(idx);
  const m = j >= 0 ? prov.siteMirror?.[j] : null;
  if (m && m.state === 1) {
    if (own?.has(`${prov.p},${prov.q},${idx}`)) return 'home';
    const shielded = m.shieldUntilBell > nowBell && m.shieldUntilBell !== NO_BELL;
    if (!calm(prov.relations, faction, m.faction) && !shielded) return 'attack';
  }
  if (level < 3) return 'move';
  if (prov.camp?.state === 1 && prov.camp.tile === idx) return 'attack';
  if ((prov.entries ?? []).some(e => e.state === 1 && e.tile === idx && !calm(prov.relations, faction, e.faction))) return 'attack';
  return 'move';
}

/**
 * The viewer's hosts standing on tile (p, q, idx) and what each may do now:
 * `[{id, unit, troops, stamina, p, q, tile, holding, holdingIndex, row,
 * march: {ok, blocks}, explore: {ok, blocks, targets} | null}]`, the one that
 * can march with the most troops first. `state` = `{holdings, provinces
 * (Map "P,Q" → {province}), nowBell, now}` (the page's).
 */
export function actorsAt(state, p, q, idx) {
  const prov = state.provinces?.get?.(`${p},${q}`)?.province ?? null;
  if (!prov?.entries || !int(idx)) return [];
  const nowBell = state.nowBell ?? 0, now = state.now ?? 0;
  const out = [];
  (state.holdings ?? []).forEach((holding, holdingIndex) => {
    let rows;
    try { rows = hostsIn(prov, holding, nowBell); } catch { rows = []; }
    for (const row of rows) {
      if (row.tile !== idx || row.state !== 1) continue;
      const ctx = { holding, province: prov, nowBell, now, host: row };
      const mb = [...actionBlocks('Depart', ctx)];
      if ((nowBell < row.readyBell || row.stamina < DEPART_STAMINA) && !mb.includes('Cooldown')) mb.push('Cooldown');
      if (freeTransitSlot(holding) === null) mb.push('TransitState');
      let explore = null;
      if (row.unit === SCOUT) {
        const eb = actionBlocks('Explore', ctx);
        let targets = [];
        try { targets = eb.length ? [] : exploreTargets(prov, row); } catch { targets = []; }
        explore = { ok: !eb.length && targets.length > 0, blocks: eb, targets };
      }
      out.push({ id: String(row.id), unit: row.unit, troops: row.troops, stamina: row.stamina, p, q, tile: idx, holding, holdingIndex, row, march: { ok: !mb.length, blocks: mb }, explore });
    }
  });
  const rank = a => (a.march.ok && a.unit !== SCOUT ? 0 : a.explore?.ok ? 1 : a.march.ok ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || b.troops - a.troops);
}

/**
 * The lit tiles of one acting host: `{tiles: [{p, q, tile, hq, hr, d, kind, lv (the survey's level of the tile)}],
 * byHex: Map "q,r" → tile}`. `provinceOf(p, q)` → the decoded Province or
 * null; `passableOf(p, q)` → the rules module's passable mask of that
 * province or null (an unknown province stops the walk); `levelOf(p, q,
 * idx)` the survey's level of a tile; `own` a Set of the viewer's village
 * tiles "P,Q,idx". `march` false leaves the reach out (a host that cannot
 * depart now); `explore` the tiles a Scout may explore.
 */
export function litTiles({ origin, stamina = 0, faction = null, provinceOf = () => null, passableOf = () => null, levelOf = () => 3, own = null, nowBell = 0, march = true, explore = [] }) {
  const tiles = [], byHex = new Map();
  const add = t => { const h = tileHex(t.p, t.q, t.tile); if (!h) return; const k = `${h.q},${h.r}`; const x = { ...t, hq: h.q, hr: h.r }; if (byHex.has(k)) tiles[tiles.indexOf(byHex.get(k))] = x; else tiles.push(x); byHex.set(k, x); };
  if (march) {
    // the walk asks the rules module what is passable; the Province (when the page holds it) only says what stands there
    const walkOf = (p, q) => {
      const mask = passableOf(p, q);
      if (mask === null || mask === undefined) return null;
      const prov = provinceOf(p, q);
      return { p, q, sites: prov?.sites ?? [], siteMirror: prov?.siteMirror ?? [], entries: prov?.entries ?? [], camp: prov?.camp ?? null, relations: prov?.relations ?? 0, passableMask: mask, loaded: !!prov };
    };
    for (const t of reachTiles({ start: origin, steps: reachSteps(stamina), provinceOf: walkOf, faction })) {
      const prov = provinceOf(t.p, t.q);
      const lv = levelOf(t.p, t.q, t.tile);
      add({ p: t.p, q: t.q, tile: t.tile, d: t.d, lv, kind: kindOf(prov, t.tile, { faction, level: lv, own, nowBell }) });
    }
  }
  for (const idx of explore) add({ p: origin.p, q: origin.q, tile: idx, d: 1, lv: levelOf(origin.p, origin.q, idx), kind: 'explore' });
  return { tiles, byHex };
}

/** The host's name on the map: its unit and troops, counted as everywhere else ("槍兵 600" / "600 Spearmen": fi18n.mjs unitCount). */
export const actorText = a => unitCount(UNIT_ORDER[a.unit], a.troops);
/** Why an acting host lights nothing (the first thing that blocks it), or ''. */
export const blockText = a => { const c = a?.march?.ok || a?.explore?.ok ? null : a?.march?.blocks?.[0] ?? null; return c ? errorText(c) : ''; };

/**
 * The page's actions for its selection, kept between frames.
 * `actions(state)` → the model or null. `state` = the page state (holdings,
 * provinces, nowBell, selected, compose, explore, actor, citizen, survey)
 * plus `now` (chain seconds); `passableOf` and `clock` as above. The model:
 * `{key, mode: 'select' | 'compose', origin: {p, q, tile}, hex: {q, r},
 * actor, actors, index, tiles, byHex, t0 (ms on `clock`), chosen: [idx]
 * (explore tiles picked), dest, note}`.
 */
export function createActions({ passableOf = () => null, clock = fxNow } = {}) {
  let memo = { key: null, model: null, host: null, t0: 0 };
  return function actions(state) {
    if ((state.mode ?? 'play') !== 'play') return null;
    const c = state.compose && !state.compose.sending ? state.compose : null;
    const s = state.selected;
    let origin, actor, actors, index = 0, mode;
    if (c?.host && c.origin && int(c.host.tile)) {
      // a march is being composed: its host stays the actor wherever the selection goes
      mode = 'compose';
      origin = { p: c.origin.p, q: c.origin.q, tile: c.host.tile };
      actors = actorsAt(state, origin.p, origin.q, origin.tile);
      actor = actors.find(a => a.id === String(c.host.id)) ?? { id: String(c.host.id), unit: c.host.unit, troops: c.host.troops, stamina: c.host.staminaValue ?? 120, p: origin.p, q: origin.q, tile: origin.tile, march: { ok: true, blocks: [] }, explore: null };
      actor = { ...actor, march: { ok: true, blocks: [] }, explore: null };
      index = Math.max(0, actors.findIndex(a => a.id === actor.id));
    } else if (s && int(s.p) && int(s.q) && int(s.idx)) {
      mode = 'select';
      origin = { p: s.p, q: s.q, tile: s.idx };
      actors = actorsAt(state, s.p, s.q, s.idx);
      if (!actors.length) { memo = { key: null, model: null, host: null, t0: 0 }; return null; }
      const want = state.actor?.key === `${s.p},${s.q},${s.idx}` ? state.actor.i : 0;
      index = ((want % actors.length) + actors.length) % actors.length;
      actor = actors[index];
    } else { memo = { key: null, model: null, host: null, t0: 0 }; return null; }
    const sv = state.survey && !state.survey.showAll ? state.survey : null;
    const chosen = mode === 'select' && state.explore?.host && String(state.explore.host.id) === actor.id ? [...(state.explore.tiles ?? [])] : [];
    const key = [mode, actor.id, `${origin.p},${origin.q},${origin.tile}`, actor.march.ok ? 1 : 0, actor.explore?.ok ? actor.explore.targets.join('.') : '', state.provinces?.size ?? 0, sv?.rev ?? '', state.nowBell ?? 0,
      state.provinces?.get?.(`${origin.p},${origin.q}`)?.province ? 1 : 0, chosen.join('.'), c?.dest ? `${c.dest.p},${c.dest.q},${c.dest.tile}` : ''].join('|');
    if (memo.key === key && memo.model) return memo.model;
    const own = new Set((state.holdings ?? []).filter(h => int(h.tile)).map(h => `${h.p},${h.q},${h.tile}`));
    const lit = litTiles({ origin, stamina: actor.stamina, faction: state.citizen?.faction ?? null, own, nowBell: state.nowBell ?? 0,
      provinceOf: (p, q) => state.provinces?.get?.(`${p},${q}`)?.province ?? null, passableOf,
      levelOf: sv ? (p, q, idx) => sv.levelOf(p, q, idx) : () => 3,
      march: actor.march.ok, explore: actor.explore?.ok ? actor.explore.targets : [] });
    const t0 = memo.host === `${mode}|${actor.id}` ? memo.t0 : clock();
    const model = { key, mode, origin, hex: tileHex(origin.p, origin.q, origin.tile), actor, actors, index, tiles: lit.tiles, byHex: lit.byHex, t0, chosen, dest: c?.dest ?? null };
    memo = { key, model, host: `${mode}|${actor.id}`, t0 };
    return model;
  };
}

// ------------------------------------------------------------------ painters
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
const hexInto = (path, x, y, inset) => { hexPoints(x, y, inset).forEach(([px, py], i) => (i ? path.lineTo(px, py) : path.moveTo(px, py))); path.closePath(); };
const INSET = 2.4;
const lineScale = zoom => (0.72 + 0.28 * Math.min(1.8, Math.max(0.3, zoom))) / zoom;

/**
 * Reach is one shape (UX brief §11.7): the outer contour of the reach set, an inward light of at most `inner`
 * that is gone `depth` world px inside it, everything outside the set dimmed by `dim`. No frame per tile. `rim`
 * and `glow` are screen px; `target` is how far a target's own hexagon is set in from its tile's edge (world px).
 */
export const REACH = Object.freeze({ rim: 2.5, glow: 8, under: 1.5, inner: 0.15, depth: RADIUS * Math.sqrt(3) * 1.25, steps: 5, dim: 0.18, target: 5.5, hatch: 7 });
/**
 * On the chart a pale line needs something under it to be seen on the parchment: a soft shade of deep teal beside
 * it (never a dark line of its own, which read as a river next to the water tiles), and the tiles take a breath of it.
 */
const CHART_INK = [18, 58, 56];
/** The kinds that are targets: each keeps a hexagon of its own, set in from the tile's edge, and a glyph (colour is never the only sign). */
export const TARGET_KINDS = Object.freeze(['home', 'attack', 'explore']);
/** The glyph of a kind (map/glyphs.mjs, the HUD sprite's own pictures). */
export const KIND_GLYPH = Object.freeze({ attack: 'swords', home: 'home', explore: 'eye', chosen: 'check' });

/**
 * The colours of the lit tiles for a viewer of nation `faction`: the brief's, for every nation. (The first build gave
 * a red, rose or amber nation violet for attack, so that an attack tile would not read as more of its own land; the
 * second review found the legend's ember swatch beside violet tiles, and violet close to another nation's colour. An
 * attack tile is told from the land by its own hexagon, its ember rim and its crossed swords.)
 */
export function actionPalette(faction = null) { void faction; return ACTION_COLOURS; }

/** The band of light inside the contour as strokes clipped to the set, widest first: `[{width, alpha}]` (the same sum as the land's band). */
export function innerSteps({ inner, depth, steps } = REACH) {
  const at = j => inner * Math.pow(1 - (j - 0.5) / steps, 1.3);
  const out = [];
  for (let j = steps; j >= 1; j--) out.push({ width: 2 * depth * (j / steps), alpha: 1 - (1 - at(j)) / (1 - (j === steps ? 0 : at(j + 1))) });
  return out;
}
const INNER = innerSteps();

const shapes = new WeakMap();
/**
 * The reach set of a model as one shape (made once per model): `{shape (ownland.mjs landShape: the set with the
 * host's own tile, its outline as closed loops), fill, edge, hole (the loops, for the dim outside), chart (the
 * set's chart tiles) and chartEdge (the contour along them) or null, targets: Map kind → Path2D of their own
 * hexagons, maxD, centre}`; null without Path2D.
 */
function shapeOf(A) {
  if (typeof Path2D === 'undefined' || !A?.tiles?.length) return null;
  const hit = shapes.get(A);
  if (hit) return hit;
  const tiles = A.tiles.map(t => ({ q: t.hq, r: t.hr, d: t.d }));
  if (A.hex && !A.byHex?.has?.(`${A.hex.q},${A.hex.r}`)) tiles.push({ q: A.hex.q, r: A.hex.r, d: 0 });
  const shape = landShape(tiles);
  const fill = new Path2D(), edge = new Path2D(), targets = new Map();
  const inSet = new Set(tiles.map(t => `${t.q},${t.r}`));
  let chart = null, chartEdge = null, holes = null;
  for (const t of tiles) { const c = project(t.q, t.r); hexInto(fill, c.x, c.y, 0); }
  // the contour is the set's OUTER outline only: a tile inside the reach that the host cannot enter (a peak, a lake)
  // gets no frame of its own (it read as a target), only a light hatch
  const outer = outerLoops(shape.loops);
  for (const loop of outer) { loop.forEach(([x, y], i) => (i ? edge.lineTo(x, y) : edge.moveTo(x, y))); edge.closePath(); }
  const holeTiles = enclosed(tiles, inSet);
  for (const h of holeTiles) { const c = project(h.q, h.r); hexInto(holes ??= new Path2D(), c.x, c.y, 0); }
  const onOuter = new Set(outer.flatMap(loop => loop.map(([x, y]) => `${Math.round(x * 8)},${Math.round(y * 8)}`)));
  for (const t of A.tiles) {
    const c = project(t.hq, t.hr);
    if (TARGET_KINDS.includes(t.kind)) { if (!targets.has(t.kind)) targets.set(t.kind, new Path2D()); hexInto(targets.get(t.kind), c.x, c.y, REACH.target); }
    if ((t.lv ?? 3) >= 2) continue;
    // a chart tile of the set, and the part of the outer contour that runs along it
    hexInto(chart ??= new Path2D(), c.x, c.y, 0);
    const pts = hexPoints(c.x, c.y, 0);
    EDGE_OF.forEach(([dq, dr], k) => {
      if (inSet.has(`${t.hq + dq},${t.hr + dr}`)) return;
      const a = pts[(k + 5) % 6], b = pts[k];
      if (!onOuter.has(`${Math.round(a[0] * 8)},${Math.round(a[1] * 8)}`) || !onOuter.has(`${Math.round(b[0] * 8)},${Math.round(b[1] * 8)}`)) return;
      (chartEdge ??= new Path2D()).moveTo(a[0], a[1]); chartEdge.lineTo(b[0], b[1]);
    });
  }
  const top = outer.flat().reduce((m, p) => (p[1] < m[1] ? p : m), [0, Infinity]);
  const v = { shape, fill, edge, chart, chartEdge, holes, holeCount: holeTiles.length, targets, maxD: shape.maxD, centre: A.hex ? project(A.hex.q, A.hex.r) : shape.centre, top: Number.isFinite(top[1]) ? { x: top[0], y: top[1] } : null };
  shapes.set(A, v);
  return v;
}
/** The loops of an outline that are its outside (every loop that lies inside another is a hole): by area, the largest; a set in two parts keeps both. */
export function outerLoops(loops) {
  if (!loops?.length) return [];
  const area = loop => { let a = 0; for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  const inside = (pt, loop) => { let c = false; for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { const a = loop[i], b = loop[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const sized = loops.map(loop => ({ loop, a: Math.abs(area(loop)) })).sort((x, y) => y.a - x.a);
  return sized.filter((x, i) => !sized.slice(0, i).some(big => inside(x.loop[0], big.loop))).map(x => x.loop);
}
/** The tiles the set encloses without holding them: every tile next to the set from which no way leads out past the set's own reach. */
export function enclosed(tiles, inSet = new Set(tiles.map(t => `${t.q},${t.r}`))) {
  if (!tiles.length) return [];
  const home = tiles.find(t => t.d === 0) ?? tiles[0];
  const far = Math.max(...tiles.map(t => hexSteps(t, home))) + 1;
  const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  const state = new Map();   // "q,r" → true (a way out), false (enclosed)
  const out = [];
  for (const t of tiles) for (const [dq, dr] of DIRS) {
    const start = { q: t.q + dq, r: t.r + dr }, sk = `${start.q},${start.r}`;
    if (inSet.has(sk) || state.has(sk)) continue;
    // flood the tiles outside the set from here: reaching the rim of the search means a way out
    const seen = new Set([sk]), queue = [start];
    let open = false;
    for (let i = 0; i < queue.length && !open; i++) {
      const c = queue[i];
      if (hexSteps(c, home) >= far || state.get(`${c.q},${c.r}`) === true) { open = true; break; }
      for (const [eq, er] of DIRS) { const n = { q: c.q + eq, r: c.r + er }, nk = `${n.q},${n.r}`; if (!inSet.has(nk) && !seen.has(nk)) { seen.add(nk); queue.push(n); } }
    }
    for (const k of seen) state.set(k, open);
    if (!open) for (const c of queue) out.push(c);
  }
  return out;
}
const hexSteps = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
/** The neighbour across the edge between corners k−1 and k of hexPoints (as map/ownland.mjs). */
const EDGE_OF = [[1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1]];

/** The box (world px) around the reach set of `A` with the host's own tile: `{x0, y0, x1, y1}`, or null. */
export function reachBox(A) {
  if (!A?.tiles?.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (q, r) => { const c = project(q, r); x0 = Math.min(x0, c.x - RADIUS); x1 = Math.max(x1, c.x + RADIUS); y0 = Math.min(y0, c.y - RADIUS * FLATTEN); y1 = Math.max(y1, c.y + RADIUS * FLATTEN); };
  for (const t of A.tiles) add(t.hq, t.hr);
  if (A.hex) add(A.hex.q, A.hex.r);
  return { x0, y0, x1, y1 };
}

/** How much of ring d shows `age` ms after the tiles were lit (the roll-out). */
export const rollAt = (age, d) => Math.max(0, Math.min(1, (age - d * ROLL_RING_MS) / ROLL_FADE_MS));
/** How long the roll-out of a set of rings 0..maxD lasts (ms). */
export const rollMs = maxD => maxD * ROLL_RING_MS + ROLL_FADE_MS;
/** The light spreads from the host: clip to a round of this radius (world px) `age` ms after the tiles were lit. */
const rollClip = (g, S, age) => {
  const rx = (age / ROLL_RING_MS + 0.9) * Math.sqrt(3) * RADIUS;
  g.beginPath(); g.ellipse?.(S.centre.x, S.centre.y, rx, rx * FLATTEN, 0, 0, Math.PI * 2); g.clip?.();
};

/**
 * The reach on the ground (after the land, before what stands on it): a light inside the contour that is gone a
 * little way in, the targets' own hexagons, the outer glow and the rim, spreading from the host and then
 * breathing. `dim` < 1 while a destination is chosen (the route reads over it). `palette`: actionPalette of the
 * viewer. Returns whether the roll-out is still running.
 */
export function paintActionGround(g, A, { zoom = 1, now = fxNow(), still = false, dim = 1, base = false, palette = ACTION_COLOURS } = {}) {
  const S = g?.save ? shapeOf(A) : null;
  if (!S) return false;
  const k = lineScale(zoom), age = now - A.t0;
  const rolled = still || base || age >= rollMs(S.maxD);
  // (`base`: the reach fully out and without its breath, for a layer that is kept; paintActionPulse lays the breath over it)
  const breath = base ? 0 : still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 1000 * 2.4);
  const a = dim * (rolled ? 1 : Math.min(1, Math.max(0, age) / 140));
  const M = palette.move;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  if (!rolled) rollClip(g, S, age);
  // the light inside the contour
  g.save();
  g.clip(S.fill);
  g.strokeStyle = rgba(M.fill, 1);
  for (const { width, alpha } of INNER) { g.globalAlpha = alpha * a; g.lineWidth = width; g.stroke(S.edge); }
  g.restore();
  if (S.chart) { g.globalAlpha = 0.09 * a; g.fillStyle = rgba(CHART_INK, 1); g.fill(S.chart); }
  // a tile inside the reach that the host cannot enter: a light hatch, no frame
  if (S.holes) paintHatch(g, S.holes, S.shape, k, 0.2 * a);
  // the targets: a hexagon of their own
  for (const kind of TARGET_KINDS) {
    const path = S.targets.get(kind), C = palette[kind];
    if (!path || !C) continue;
    g.globalAlpha = (C.veil + 0.06 * breath) * a; g.fillStyle = rgba(C.fill, 1); g.fill(path);
    g.globalAlpha = 0.5 * a; g.strokeStyle = 'rgba(12,20,18,1)'; g.lineWidth = 4.2 * k; g.stroke(path);
    g.globalAlpha = 0.95 * a; g.strokeStyle = rgba(C.rim, 1); g.lineWidth = 2 * k; g.stroke(path);
  }
  // the contour (the outer outline alone): a soft shade beside it where it runs over the chart, its glow reaching
  // outward, a thin line of ink under it, the pale rim
  if (S.chartEdge) {
    g.strokeStyle = rgba(CHART_INK, 1);
    g.globalAlpha = 0.1 * a; g.lineWidth = REACH.glow * 1.9 * k; g.stroke(S.chartEdge);
    g.globalAlpha = 0.16 * a; g.lineWidth = REACH.glow * 0.9 * k; g.stroke(S.chartEdge);
  }
  g.strokeStyle = rgba(M.rim, 1);
  g.globalAlpha = (0.1 + 0.06 * breath) * a; g.lineWidth = REACH.glow * 2.2 * k; g.stroke(S.edge);
  g.globalAlpha = (0.22 + 0.1 * breath) * a; g.lineWidth = REACH.glow * k; g.stroke(S.edge);
  g.globalAlpha = 0.55 * a; g.strokeStyle = 'rgba(10,34,30,1)'; g.lineWidth = (REACH.rim + REACH.under) * k; g.stroke(S.edge);
  g.globalAlpha = (0.92 + 0.08 * breath) * a; g.strokeStyle = rgba(M.rim, 1); g.lineWidth = REACH.rim * k; g.stroke(S.edge);
  g.restore();
  return !rolled;
}

/** A light hatch over `path` (tiles the host cannot enter inside its reach): thin strokes of ink, clipped to the tiles. */
function paintHatch(g, path, shape, k, alpha) {
  if (!(alpha > 0) || !g.clip) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of shape.tiles) { const c = project(t.q, t.r); x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y); }
  x0 -= RADIUS * 2; x1 += RADIUS * 2; y0 -= RADIUS * 2; y1 += RADIUS * 2;
  g.save();
  g.clip(path);
  g.globalAlpha = alpha; g.strokeStyle = 'rgba(12,20,18,1)'; g.lineWidth = 1 * k;
  g.beginPath();
  const step = REACH.hatch * k * 1.6, h = y1 - y0;
  for (let x = x0 - h; x < x1; x += step) { g.moveTo(x, y1); g.lineTo(x + h, y0); }
  g.stroke();
  g.restore();
}

/** Whether the roll-out of `A` is over at `now`. */
export function rolledOut(A, now = fxNow()) {
  let maxD = 0;
  for (const t of A?.tiles ?? []) if (t.d > maxD) maxD = t.d;
  return now - (A?.t0 ?? 0) >= rollMs(maxD);
}

/** The breath of the reach alone, over a reach painted with `base`: the contour's glow brightens and fades. */
export function paintActionPulse(g, A, { zoom = 1, now = fxNow(), dim = 1, palette = ACTION_COLOURS } = {}) {
  const S = g?.save ? shapeOf(A) : null;
  if (!S) return;
  const k = lineScale(zoom), breath = 0.5 + 0.5 * Math.sin(now / 1000 * 2.4);
  g.save();
  g.lineJoin = 'round';
  g.strokeStyle = rgba(palette.move.rim, 1);
  g.globalAlpha = 0.16 * breath * dim; g.lineWidth = REACH.glow * 0.8 * k; g.stroke(S.edge);
  g.globalAlpha = 0.22 * breath * dim; g.lineWidth = REACH.rim * k; g.stroke(S.edge);
  for (const kind of TARGET_KINDS) { const path = S.targets.get(kind); if (path) { g.globalAlpha = 0.07 * breath * dim; g.fillStyle = rgba(palette[kind].fill, 1); g.fill(path); } }
  g.restore();
}

/**
 * Everything outside the reach set dims (the reach is lit by contrast, not by a wash): over the land and what
 * stands on it, never over the set. `box` `{x0, y0, x1, y1}` (world px): the part of the world in the picture.
 */
export function paintReachDim(g, A, { box, now = fxNow(), still = false, dim = 1 } = {}) {
  const S = g?.save && box ? shapeOf(A) : null;
  if (!S) return;
  const age = now - A.t0, show = still ? 1 : Math.min(1, Math.max(0, age) / Math.max(1, rollMs(S.maxD)));
  if (!(show > 0)) return;
  const path = new Path2D();
  path.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  path.addPath?.(S.edge);
  g.save();
  g.globalAlpha = REACH.dim * show * dim; g.fillStyle = 'rgba(8,16,15,1)';
  g.fill(path, 'evenodd');
  g.restore();
}

/**
 * Over what stands on the land: the contour once more, thin (a wood never hides where the reach ends), and a
 * badge with its glyph on every target: crossed swords, a house, an eye, or a tick for a tile that was chosen.
 */
export function paintActionTop(g, A, { zoom = 1, now = fxNow(), still = false, dim = 1, palette = ACTION_COLOURS } = {}) {
  const S = g?.save ? shapeOf(A) : null;
  if (!S) return;
  const k = lineScale(zoom), age = still ? Infinity : now - A.t0;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.save();
  if (age < rollMs(S.maxD)) rollClip(g, S, age);
  g.globalAlpha = 0.55 * dim; g.strokeStyle = rgba(palette.move.rim, 1); g.lineWidth = 1.1 * k; g.stroke(S.edge);
  g.restore();
  const chosen = new Set(A.chosen ?? []);
  for (const t of A.tiles) {
    if (!TARGET_KINDS.includes(t.kind)) continue;
    const show = rollAt(age, t.d);
    if (show <= 0) continue;
    const c = project(t.hq, t.hr);
    paintKindBadge(g, c.x, c.y + RADIUS * FLATTEN * 0.5, t.kind === 'explore' && chosen.has(t.tile) ? 'chosen' : t.kind, { zoom, alpha: show * dim, colour: palette[t.kind], filled: t.kind === 'explore' && chosen.has(t.tile) });
  }
  g.restore();
}

/** A target's badge: a dark disc rimmed in the kind's colour with its glyph (`filled`: the disc in the colour, the glyph dark). */
export function paintKindBadge(g, x, y, kind, { zoom = 1, alpha = 1, colour = ACTION_COLOURS.move, filled = false, r = 11 } = {}) {
  if (!g?.save) return;
  const k = lineScale(zoom), rr = r * k;
  g.save();
  g.globalAlpha = alpha * 0.35; g.fillStyle = '#060c0b'; g.beginPath(); g.arc(x, y + 1.5 * k, rr + 1.5 * k, 0, Math.PI * 2); g.fill();
  g.globalAlpha = alpha;
  g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fillStyle = filled ? rgba(colour.rim, 1) : 'rgba(13,24,22,.94)'; g.fill();
  g.strokeStyle = rgba(colour.rim, 1); g.lineWidth = 1.6 * k; g.stroke();
  paintGlyph(g, KIND_GLYPH[kind] ?? KIND_GLYPH.explore, x, y, rr * 1.42, { colour: filled ? '#10201c' : rgba(colour.rim, 1), weight: 2, alpha });
  g.restore();
}

/**
 * The hexagon under the pointer, on the ground: bright, set in from the tile's edge, and in the tile's colour
 * when the tile is lit (the one tile of the reach that shows a frame of its own).
 */
export function paintHoverGround(g, hex, { zoom = 1, kind = null, palette = ACTION_COLOURS } = {}) {
  if (!hex || !g?.save) return;
  const k = lineScale(zoom), c = project(hex.q, hex.r), C = kind ? palette[kind] : null;
  g.save();
  g.lineJoin = 'round';
  g.beginPath(); hexPoints(c.x, c.y, C ? REACH.target * 0.6 : INSET).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
  g.globalAlpha = C ? 0.42 : 0.2; g.fillStyle = C ? rgba(C.rim, 1) : '#ffffff'; g.fill();
  g.globalAlpha = 0.3; g.strokeStyle = '#ffffff'; g.lineWidth = 8 * k; g.stroke();
  g.globalAlpha = 1; g.lineWidth = 2.8 * k; g.stroke();
  g.restore();
}
/** And once more over what stands there, thin. */
export function paintHoverTop(g, hex, { zoom = 1 } = {}) {
  if (!hex || !g?.save) return;
  const k = lineScale(zoom), c = project(hex.q, hex.r);
  g.save();
  g.beginPath(); hexPoints(c.x, c.y, INSET).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
  g.globalAlpha = 0.75; g.strokeStyle = '#ffffff'; g.lineWidth = 1.2 * k; g.stroke();
  g.restore();
}

/** The colours of the selection ring: gold for what is the viewer's own, ivory for everything else. */
export const SELECT_COLOUR = Object.freeze({ own: YOU, other: '#f4efe0' });

/** The selected tile, on the ground: a bright ring (never dark ink) with its glow. */
export function paintSelectionGround(g, hex, { zoom = 1, own = false, now = fxNow(), still = false } = {}) {
  if (!hex || !g?.save) return;
  const k = lineScale(zoom), c = project(hex.q, hex.r), col = own ? SELECT_COLOUR.own : SELECT_COLOUR.other;
  const breath = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 1000 * 3.2);
  g.save();
  g.lineJoin = 'round';
  g.beginPath(); hexPoints(c.x, c.y, 0.5).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
  g.globalAlpha = 0.14 + 0.08 * breath; g.fillStyle = col; g.fill();
  g.globalAlpha = 0.2 + 0.16 * breath; g.strokeStyle = col; g.lineWidth = 11 * k; g.stroke();
  g.globalAlpha = 0.85; g.strokeStyle = 'rgba(14,22,20,1)'; g.lineWidth = 6.4 * k; g.stroke();
  g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 3.4 * k; g.stroke();
  g.restore();
}
export function paintSelectionTop(g, hex, { zoom = 1, own = false } = {}) {
  if (!hex || !g?.save) return;
  const k = lineScale(zoom), c = project(hex.q, hex.r);
  g.save();
  g.lineJoin = 'round';
  g.beginPath(); hexPoints(c.x, c.y, 0.5).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
  g.globalAlpha = 0.9; g.strokeStyle = own ? SELECT_COLOUR.own : SELECT_COLOUR.other; g.lineWidth = 1.5 * k; g.stroke();
  g.restore();
}

/**
 * A route as a ribbon over the land: `hexes` `[{q, r}]` from the host to the tile. One ribbon for one route, from
 * the pointer's first look to the seal (the second review found it lilac under the pointer, cream in the order
 * card and red once sealed): the effects' own flat band of cloth (fx/draw.mjs ribbon) in the nation's colour with
 * a pale hem. While it is a proposal (`proposal`: under the pointer, in the order card) the cloth is half there
 * and its stitches walk toward the far end; once sealed it lies solid and still. An arrowhead at the end.
 */
export function paintRibbon(g, hexes, { zoom = 1, faction = null, proposal = true, now = fxNow(), still = false } = {}) {
  if (!g?.save || !(hexes?.length > 1)) return;
  const pts = hexes.map(h => project(h.q, h.r));
  const px = lineScale(zoom), colour = FACTION_COLORS[faction] ?? YOU;
  const n = pts.length, a = pts[n - 2], b = pts[n - 1];
  const ang = Math.atan2(b.y - a.y, b.x - a.x), head = 12 * px;
  // the cloth stops short of the last tile's centre: the arrowhead and the tile's own mark have the room
  const end = { x: b.x - Math.cos(ang) * head * 1.1, y: b.y - Math.sin(ang) * head * 1.1 };
  const path = smoothPath([...pts.slice(0, -1), end]);
  g.save();
  clothRibbon(g, path, { px, color: colour, level: proposal ? 0.9 : 1, sealed: !proposal, proposal, march: proposal && !still ? now / 1000 : 0 });
  // the arrowhead: the cloth's colour, an ink line round it, a pale edge on its upper side
  g.translate(b.x - Math.cos(ang) * head * 0.25, b.y - Math.sin(ang) * head * 0.25); g.rotate(ang);
  g.beginPath(); g.moveTo(head * 0.6, 0); g.lineTo(-head * 0.8, -head * 0.74); g.lineTo(-head * 0.42, 0); g.lineTo(-head * 0.8, head * 0.74); g.closePath();
  g.lineJoin = 'round';
  g.globalAlpha = 1; g.fillStyle = colour; g.fill(); g.strokeStyle = 'rgba(26,15,12,.85)'; g.lineWidth = 1.3 * px; g.stroke();
  g.beginPath(); g.moveTo(head * 0.6, 0); g.lineTo(-head * 0.8, -head * 0.74); g.strokeStyle = 'rgba(255,246,220,.75)'; g.lineWidth = 1.1 * px; g.stroke();
  g.restore();
}

/** The tones of a tag on the map: `[plate, text, rim]`. */
const TAG_TONES = Object.freeze({
  plain: ['rgba(14,22,20,.93)', '#f4efe0', 'rgba(244,239,224,.5)'],
  you: ['rgba(14,22,20,.93)', YOU, YOU],
  reach: ['rgba(14,30,27,.9)', '#d8f3ea', 'rgba(206,246,235,.6)'],
  refuse: ['rgba(60,16,10,.95)', '#ffe9e2', '#ff8a6a'],
  warn: ['rgba(46,34,8,.95)', '#ffe7ae', '#e0a83d'],
});

/**
 * A short line on the map at world point (x, y): a dark plate, screen sized.
 * `place` 'above' or 'below' the point by `gap` screen px; `shake` (px) moves
 * it sideways (a refusal). Returns its box in world px.
 */
export function paintTag(g, x, y, text, { zoom = 1, tone = 'plain', place = 'above', gap = 10, size = 12.5, shake = 0, alpha = 1, anchor = null, pass = null } = {}) {
  // `anchor` {x, y}: the place on the board the tag belongs to (its tile): the tag stands upright around it (map/tilt.mjs)
  // `pass`: the frame's label pass (map/labelpass.mjs): the tag slides out from under the HUD (it is never left out)
  if (!g?.save || !text) return null;
  const k = 1 / zoom, [plate, ink, rim] = TAG_TONES[tone] ?? TAG_TONES.plain;
  g.save();
  g.font = `700 ${size * k}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const tw = (g.measureText?.(text)?.width ?? text.length * size * k * 0.6) + 18 * k, th = (size + 10) * k;
  const ax = anchor?.x ?? x, ay = anchor?.y ?? y;
  const move = pass?.place(ax, ay, { x: x - tw / 2, y: place === 'below' ? y + gap * k : y - gap * k - th, w: tw, h: th }, { keep: true }) ?? { dx: 0, dy: 0 };
  const cx = x + shake * k + move.dx, top = (place === 'below' ? y + gap * k : y - gap * k - th) + move.dy;
  upright(g, ax, ay, () => {
    g.globalAlpha = alpha;
    g.fillStyle = plate; g.beginPath(); g.roundRect?.(cx - tw / 2, top, tw, th, th / 2); g.fill();
    g.strokeStyle = rim; g.lineWidth = 1.2 * k; g.stroke();
    g.fillStyle = ink; g.fillText(text, cx, top + th / 2 + 0.5 * k);
  });
  g.restore();
  return { x: cx - tw / 2, y: top, w: tw, h: th };
}

/** The mark of a refusal on its tile: an ember ring with a bar through it, fading. */
export function paintRefusal(g, hex, { zoom = 1, age = 0, still = false } = {}) {
  if (!hex || !g?.save) return;
  const k = lineScale(zoom), c = project(hex.q, hex.r);
  const fade = Math.max(0, Math.min(1, (NOTE_MS - age) / 500));
  const pop = still ? 1 : Math.min(1, age / 120);
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); hexPoints(c.x, c.y, INSET).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
  g.globalAlpha = 0.3 * fade * pop; g.fillStyle = 'rgba(226,85,61,1)'; g.fill();
  g.globalAlpha = fade; g.strokeStyle = 'rgba(14,22,20,.8)'; g.lineWidth = 5.5 * k; g.stroke();
  g.strokeStyle = '#ff8a6a'; g.lineWidth = 2.6 * k; g.stroke();
  g.restore();
}

/** The words of the map's own answers (canvas text and the page's live line). */
export const NOTE_TEXT = Object.freeze({
  unreachable: () => L`ここへは届きません`,
  tooFar: n => L`遠すぎます（${fmtNum(n)} マスまで）`,
  unopened: () => L`まだひらいていない土地です`,
  wait: () => L`ルールを読み込んでいます`,
});
/** What the pale line is, said once on the map beside it (the lit reach is the near reach, `n` tiles; a march may go further). */
export const reachText = n => L`近く ${fmtNum(n)} マス · その先も選べます`;
/** Where the reach's own words stand: the top of its contour (world px), or null. */
export const reachTop = A => (typeof Path2D === 'undefined' ? null : shapeOf(A)?.top ?? null);
/** The route's arrival, as the ribbon's tag says it. */
export const arrivalText = bell => L`到着：ターン ${fmtNum(bell)}`;
