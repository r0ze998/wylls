// Tiles you can act on light up (UX brief §5.2).
//
// Selecting one of the viewer's own hosts on the map (on its village, or
// wherever it stands) lights at once what it can do, with no panel button
// first:
//
//   march reach     pale teal-white where it can go, ember red where a camp, a
//                   village of a hostile nation or a hostile host stands, gold
//                   for the way back to one of the viewer's own villages
//   explore         sky blue: the tiles a Scout can explore from where it stands
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
import { UNITS, errorText } from '../fi18n.mjs';
import { SCOUT, UNIT_ORDER, actionBlocks, exploreTargets, hostsIn } from '../fland.mjs';
import { DEPART_STAMINA, freeTransitSlot } from '../fmarch.mjs';
import { reachSteps, reachTiles } from '../hud/reach.mjs';
import { YOU, fxNow } from './chart.mjs';
import { upright } from './tilt.mjs';

/** The kinds of lit tile, in the order a tile takes them (the first that applies). */
export const ACTION_KINDS = Object.freeze(['explore', 'home', 'attack', 'move']);
/** Their colours (the brief's --sky, --you, --ember, --reach): the fill (`alpha`: its strength in the band inside the rim; `veil`: over the whole tile), and the brighter rim. */
export const ACTION_COLOURS = Object.freeze({
  move: Object.freeze({ fill: [216, 243, 234], rim: [240, 255, 250], alpha: 0.38, veil: 0.1 }),
  attack: Object.freeze({ fill: [226, 85, 61], rim: [255, 150, 120], alpha: 0.5, veil: 0.34 }),
  home: Object.freeze({ fill: [243, 213, 138], rim: [255, 236, 178], alpha: 0.46, veil: 0.3 }),
  explore: Object.freeze({ fill: [127, 196, 232], rim: [186, 228, 252], alpha: 0.5, veil: 0.3 }),
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
 * The lit tiles of one acting host: `{tiles: [{p, q, tile, hq, hr, d, kind}],
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
      add({ p: t.p, q: t.q, tile: t.tile, d: t.d, kind: kindOf(prov, t.tile, { faction, level: levelOf(t.p, t.q, t.tile), own, nowBell }) });
    }
  }
  for (const idx of explore) add({ p: origin.p, q: origin.q, tile: idx, d: 1, kind: 'explore' });
  return { tiles, byHex };
}

/** The host's name on the map: its unit and troops ("槍兵 600"). */
export const actorText = a => `${UNITS[UNIT_ORDER[a.unit]] ?? ''} ${fmtNum(a.troops)}`.trim();
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

/** The band of light inside a lit tile's rim (world px): the fill is strongest there and lets the land show in the middle. */
const BAND = 12;
const groupsOf = new WeakMap();
/** The lit tiles as paths, by kind and by kind and ring (made once per model): each `{rim, band}`. */
function groups(A) {
  if (typeof Path2D === 'undefined') return null;
  const hit = groupsOf.get(A);
  if (hit) return hit;
  const byKind = new Map(), byRing = new Map();
  const make = (kind, d) => ({ kind, d, rim: new Path2D(), band: new Path2D() });
  let maxD = 0;
  for (const t of A.tiles) {
    const c = project(t.hq, t.hr);
    const rk = `${t.kind}|${t.d}`;
    if (!byKind.has(t.kind)) byKind.set(t.kind, make(t.kind, 0));
    if (!byRing.has(rk)) byRing.set(rk, make(t.kind, t.d));
    for (const x of [byKind.get(t.kind), byRing.get(rk)]) { hexInto(x.rim, c.x, c.y, INSET); hexInto(x.band, c.x, c.y, INSET + BAND / 2); }
    if (t.d > maxD) maxD = t.d;
  }
  const v = { byKind, byRing, maxD };
  groupsOf.set(A, v);
  return v;
}

/** How much of ring d shows `age` ms after the tiles were lit (the roll-out). */
export const rollAt = (age, d) => Math.max(0, Math.min(1, (age - d * ROLL_RING_MS) / ROLL_FADE_MS));

/**
 * The lit tiles on the ground (after the land, before what stands on it):
 * each a cell of light: a veil over the whole tile, a band of the full fill
 * inside its rim, an outer glow and the rim itself, rolling out ring by ring
 * and then breathing. `dim` < 1 while a destination is chosen (the route
 * reads over them). Returns whether the roll-out is still running.
 */
export function paintActionGround(g, A, { zoom = 1, now = fxNow(), still = false, dim = 1, base = false } = {}) {
  const G = A?.tiles?.length ? groups(A) : null;
  if (!G || !g?.save) return false;
  const k = lineScale(zoom), age = now - A.t0;
  const rolled = still || base || age >= G.maxD * ROLL_RING_MS + ROLL_FADE_MS;
  // (`base`: the tiles fully out and without their breath, for a layer that is kept; paintActionPulse lays the breath over it)
  const breath = base ? 0 : still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 1000 * 2.4);
  g.save();
  g.lineJoin = 'round';
  const one = (x, show) => {
    const C = ACTION_COLOURS[x.kind];
    if (!C || show <= 0) return;
    g.globalAlpha = C.veil * show * dim; g.fillStyle = rgba(C.fill, 1); g.fill(x.rim);
    g.globalAlpha = (C.alpha + 0.08 * breath) * show * dim; g.strokeStyle = rgba(C.fill, 1); g.lineWidth = BAND; g.stroke(x.band);
    g.strokeStyle = rgba(C.rim, 1);
    g.globalAlpha = 0.22 * show * dim; g.lineWidth = 7.5 * k; g.stroke(x.rim);
    g.globalAlpha = (0.82 + 0.18 * breath) * show * dim; g.lineWidth = 2.5 * k; g.stroke(x.rim);
  };
  if (rolled) for (const kind of ['move', 'home', 'attack', 'explore']) { const x = G.byKind.get(kind); if (x) one(x, 1); }
  else for (const x of G.byRing.values()) one(x, rollAt(age, x.d));
  g.restore();
  return !rolled;
}

/** Whether the roll-out of `A` is over at `now`. */
export function rolledOut(A, now = fxNow()) {
  let maxD = 0;
  for (const t of A?.tiles ?? []) if (t.d > maxD) maxD = t.d;
  return now - (A?.t0 ?? 0) >= maxD * ROLL_RING_MS + ROLL_FADE_MS;
}

/** The breath of the lit tiles alone, over tiles painted with `base`: their rims brighten and fade. */
export function paintActionPulse(g, A, { zoom = 1, now = fxNow(), dim = 1 } = {}) {
  const G = A?.tiles?.length ? groups(A) : null;
  if (!G || !g?.save) return;
  const k = lineScale(zoom), breath = 0.5 + 0.5 * Math.sin(now / 1000 * 2.4);
  g.save();
  g.lineJoin = 'round';
  for (const [kind, x] of G.byKind) {
    g.strokeStyle = rgba(ACTION_COLOURS[kind].rim, 1);
    g.globalAlpha = 0.2 * breath * dim; g.lineWidth = 7.5 * k; g.stroke(x.rim);
    g.globalAlpha = 0.3 * breath * dim; g.lineWidth = 2.5 * k; g.stroke(x.rim);
  }
  g.restore();
}

/** A small mark for what a lit tile is (colour is never the only sign): crossed blades, a house, an eye, or a tick for a chosen tile. */
function mark(g, kind, x, y, s) {
  g.beginPath();
  if (kind === 'attack') {
    g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s);
    g.moveTo(x - s * 1.05, y + s * 0.35); g.lineTo(x - s * 0.35, y + s * 1.05); g.moveTo(x + s * 1.05, y + s * 0.35); g.lineTo(x + s * 0.35, y + s * 1.05);
  } else if (kind === 'home') {
    g.moveTo(x - s * 1.1, y - s * 0.05); g.lineTo(x, y - s * 1.05); g.lineTo(x + s * 1.1, y - s * 0.05);
    g.moveTo(x - s * 0.72, y - s * 0.3); g.lineTo(x - s * 0.72, y + s); g.lineTo(x + s * 0.72, y + s); g.lineTo(x + s * 0.72, y - s * 0.3);
  } else if (kind === 'chosen') {
    g.moveTo(x - s, y + s * 0.05); g.lineTo(x - s * 0.25, y + s * 0.8); g.lineTo(x + s * 1.05, y - s * 0.75);
  } else {
    g.moveTo(x - s * 1.2, y); g.quadraticCurveTo(x, y - s * 1.25, x + s * 1.2, y); g.quadraticCurveTo(x, y + s * 1.25, x - s * 1.2, y);
    g.moveTo(x + s * 0.38, y); g.arc(x, y, s * 0.38, 0, Math.PI * 2);
  }
}

/**
 * Over what stands on the land: a thin outline of every lit tile (a wood
 * never hides that it is lit) and a small mark on the tiles that are more
 * than a move.
 */
export function paintActionTop(g, A, { zoom = 1, now = fxNow(), still = false, dim = 1 } = {}) {
  const G = A?.tiles?.length ? groups(A) : null;
  if (!G || !g?.save) return;
  const k = lineScale(zoom), age = still ? Infinity : now - A.t0;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const [kind, x] of G.byKind) { g.globalAlpha = 0.5 * dim * rollAt(age, 1); g.strokeStyle = rgba(ACTION_COLOURS[kind].rim, 1); g.lineWidth = 1 * k; g.stroke(x.rim); }
  const chosen = new Set(A.chosen ?? []);
  for (const t of A.tiles) {
    const picked = t.kind === 'explore' && chosen.has(t.tile);
    if (t.kind === 'move') continue;
    const show = rollAt(age, t.d);
    if (show <= 0) continue;
    const c = project(t.hq, t.hr), r = 9.5 * k, x = c.x, y = c.y + RADIUS * FLATTEN * 0.56;
    const C = ACTION_COLOURS[t.kind];
    g.globalAlpha = show * dim;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = picked ? rgba(C.rim, 1) : 'rgba(14,22,20,.9)'; g.fill();
    g.strokeStyle = rgba(C.rim, 1); g.lineWidth = 1.5 * k; g.stroke();
    mark(g, picked ? 'chosen' : t.kind, x, y, r * 0.46);
    g.strokeStyle = picked ? '#10201c' : rgba(C.rim, 1); g.lineWidth = 1.7 * k; g.stroke();
  }
  g.restore();
}

/** The hexagon under the pointer, on the ground: bright, and in the tile's colour when the tile is lit. */
export function paintHoverGround(g, hex, { zoom = 1, kind = null } = {}) {
  if (!hex || !g?.save) return;
  const k = lineScale(zoom), c = project(hex.q, hex.r), C = kind ? ACTION_COLOURS[kind] : null;
  g.save();
  g.lineJoin = 'round';
  g.beginPath(); hexPoints(c.x, c.y, INSET).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
  g.globalAlpha = C ? 0.5 : 0.2; g.fillStyle = C ? rgba(C.rim, 1) : '#ffffff'; g.fill();
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
 * A route as a ribbon over the land: `hexes` `[{q, r}]` from the host to the
 * tile. Ink under it, the colour of what it leads to, light running along it
 * the way the host would go, an arrowhead at the end.
 */
export function paintRibbon(g, hexes, { zoom = 1, kind = 'move', own = false, now = fxNow(), still = false } = {}) {
  if (!g?.save || !(hexes?.length > 1)) return;
  const pts = hexes.map(h => project(h.q, h.r));
  const k = lineScale(zoom), col = own ? [243, 213, 138] : ACTION_COLOURS[kind]?.rim ?? ACTION_COLOURS.move.rim;
  const n = pts.length, a = pts[n - 2], b = pts[n - 1];
  const ang = Math.atan2(b.y - a.y, b.x - a.x), head = 11 * k;
  // the line stops short of the last tile's centre: the arrowhead and the tile's own mark have the room
  const end = { x: b.x - Math.cos(ang) * head * 0.9, y: b.y - Math.sin(ang) * head * 0.9 };
  const trace = () => {
    g.beginPath(); g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n - 1; i++) { const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }; g.quadraticCurveTo(pts[i].x, pts[i].y, i === n - 2 ? end.x : m.x, i === n - 2 ? end.y : m.y); }
    if (n === 2) g.lineTo(end.x, end.y);
  };
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  trace(); g.globalAlpha = 0.62; g.strokeStyle = 'rgba(12,20,18,1)'; g.lineWidth = 9.5 * k; g.stroke();
  trace(); g.globalAlpha = 1; g.strokeStyle = rgba(col, 1); g.lineWidth = 5 * k; g.stroke();
  g.setLineDash([5 * k, 11 * k]); g.lineDashOffset = still ? 0 : -(now / 34) * k;
  trace(); g.globalAlpha = 0.9; g.strokeStyle = '#ffffff'; g.lineWidth = 1.8 * k; g.stroke();
  g.setLineDash([]);
  // the arrowhead
  g.translate(b.x - Math.cos(ang) * head * 0.2, b.y - Math.sin(ang) * head * 0.2); g.rotate(ang);
  g.beginPath(); g.moveTo(head * 0.55, 0); g.lineTo(-head * 0.75, -head * 0.72); g.lineTo(-head * 0.4, 0); g.lineTo(-head * 0.75, head * 0.72); g.closePath();
  g.globalAlpha = 1; g.fillStyle = rgba(col, 1); g.fill(); g.strokeStyle = 'rgba(12,20,18,.85)'; g.lineWidth = 1.4 * k; g.stroke();
  g.restore();
}

/** The tones of a tag on the map: `[plate, text, rim]`. */
const TAG_TONES = Object.freeze({
  plain: ['rgba(14,22,20,.93)', '#f4efe0', 'rgba(244,239,224,.5)'],
  you: ['rgba(14,22,20,.93)', YOU, YOU],
  refuse: ['rgba(60,16,10,.95)', '#ffe9e2', '#ff8a6a'],
  warn: ['rgba(46,34,8,.95)', '#ffe7ae', '#e0a83d'],
});

/**
 * A short line on the map at world point (x, y): a dark plate, screen sized.
 * `place` 'above' or 'below' the point by `gap` screen px; `shake` (px) moves
 * it sideways (a refusal). Returns its box in world px.
 */
export function paintTag(g, x, y, text, { zoom = 1, tone = 'plain', place = 'above', gap = 10, size = 12.5, shake = 0, alpha = 1, anchor = null } = {}) {
  // `anchor` {x, y}: the place on the board the tag belongs to (its tile): the tag stands upright around it (map/tilt.mjs)
  if (!g?.save || !text) return null;
  const k = 1 / zoom, [plate, ink, rim] = TAG_TONES[tone] ?? TAG_TONES.plain;
  g.save();
  g.font = `700 ${size * k}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const tw = (g.measureText?.(text)?.width ?? text.length * size * k * 0.6) + 18 * k, th = (size + 10) * k;
  const cx = x + shake * k, top = place === 'below' ? y + gap * k : y - gap * k - th;
  upright(g, anchor?.x ?? x, anchor?.y ?? y, () => {
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
  tooFar: n => L`遠すぎます（${fmtNum(n)}歩まで）`,
  unopened: () => L`まだひらいていない土地です`,
  wait: () => L`ルールを読み込んでいます`,
});
/** The route's arrival, as the ribbon's tag says it. */
export const arrivalText = bell => L`到着：ターン ${fmtNum(bell)}`;
