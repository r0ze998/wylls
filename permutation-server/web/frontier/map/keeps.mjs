// The keeps of a conquest season on the board (UX design 3, 5, 13 to 15; the
// program's version 3: every province from ring 2 outward has a keep, and a
// hostile host that holds a keep's tile for 72 turns in a row takes the
// province for its nation).
//
// Everything here is read from records of the chain as the herald serves
// them, and from nothing else:
//
//   the control record   who holds each province, who contests its keep and for how many turns
//                        (/h/control: `control`, `contender`, `progress`, `required` — laid on the
//                        overview's provinces by fconquest.mjs applyControl), the keep's tile and
//                        its defenders (/h/overview2: `keepTile`, `keepTroops`)
//   the keep events      `keep_contest`, `keep_broken`, `keep_taken` of /h/conquest/{day}.json
//                        (controller.mjs refreshKeepEvents → `events`)
//
// A battle at a keep and the capture of its province are two records 72
// turns apart; nothing here joins them. The capture is played from the
// capture's own record (`keep_taken`, or the control record's change of
// holder when the day's file has not been read) and never from an order's
// answer.
//
//   KeepBook    the records' reader: what changed since the last reading, as moments (no canvas)
//   KeepBoard   the board's part: the fortress on the keep's tile with its holder's standard, each
//               province in its holder's colour, the keeps a host can reach lit, the contest's ring
//               dial, and the capture (the standard struck and the new one raised, the province's
//               colour flooding from the keep, "+1 province")
//
// On the effects bus (fx/bus.mjs), once a change of the records:
//   `keep:captured`  {p, q, tile, from, to, turn, mine, lost, before, after, donor (the host that went into the keep, where the record the page holds names it; else null)}
//   `keep:contest`   {p, q, held, of, by, mine}
//   `keep:broken`    {p, q, held, of, by, mine}
// (`mine`: the viewer's nation is the one that takes or holds; `lost`: the viewer's nation lost the province;
// `before` / `after`: how many provinces the taking nation held.)
//
// Nothing is drawn unless the season is a conquest season (fmap.mjs asks `on`).
import { project, RADIUS, FLATTEN, hexPoints } from '../../map.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { locate, tileHex, hexDistance, PROVINCE_TILES } from '../fgeo.mjs';
import { FACTION_COLORS, factionName } from '../fi18n.mjs';
import { NATION_LAND, YOURS_MARK } from '../palette.mjs';
import { emit as fxEmit } from '../fx/bus.mjs';
import { fxNow } from './chart.mjs';
import { standing, upright } from './tilt.mjs';
import { paintStandard } from './ownland.mjs';
import { paintTurnDial, paintBigNumber } from './protoland.mjs';
import { paintTag } from './actions.mjs';
import { FORTRESS, fortressSprite, paintFortress } from './village.mjs';
import { provincePixel, PROVINCE_CIRCUMRADIUS } from './layers.mjs';

const GOLD = YOURS_MARK.gold, KEY = YOURS_MARK.key;
const clamp01 = v => Math.max(0, Math.min(1, v));
const outCubic = k => 1 - Math.pow(1 - clamp01(k), 3);
const inCubic = k => Math.pow(clamp01(k), 3);
const nation = f => Number.isInteger(f) && f >= 0 && f < 6;
const keyOf = (p, q) => `${p},${q}`;
const EDGE_DIRS = [[0, -1], [-1, 0], [-1, 1], [0, 1], [1, 0], [1, -1]];

/** How a keep and its province look. Sizes in world px unless said. */
export const KEEP_LOOK = Object.freeze({
  /** The fortress's unit against a tile's corner radius, and the least it is on screen (px): a mark that still reads from afar. */
  unit: 1.3, minPx: 24,
  /** Where its ground's middle stands against the tile's (corner radii): behind the middle and to the left, so a host that holds the tile stands before its gate. */
  at: Object.freeze({ x: -0.46, y: -0.74 }),
  /** The standard on the great tower, against the fortress's unit. */
  standard: 0.62,
  /** The province's wash (a share of the holder's colour over the land) and the band along its edge. */
  wash: Object.freeze({ other: 0.12, mine: 0.19 }),
  edge: Object.freeze({ band: 0.5, bandAlpha: Object.freeze({ other: 0.2, mine: 0.3 }), line: 2.4, lineAlpha: Object.freeze({ other: 0.82, mine: 0.95 }) }),
  /** A keep that can be reached: the breathing ring's radius against the tile's, and its beat (per second). */
  reach: Object.freeze({ r: 1.5, beat: 0.9, dim: 0.58 }),
  /** The contest's dial: radius and width of its ring (screen px), where it hangs against the fortress's unit. */
  dial: Object.freeze({ r: 15, arc: 5, x: -0.98, up: 1.34 }),
  /** The mark of a keep on the world chart (screen px). */
  mark: 6.5,
});

/**
 * The capture's timeline (ms from the moment the record is read). The old standard is struck, the new one is raised
 * with a flash, the province's colour floods from the keep outward ring by ring of tiles in about a second, its
 * edge is redrawn, "+1 province" rises. A loss drains the old colour first (`drain`).
 */
export const CAPTURE = Object.freeze({
  strike: 340, raiseAt: 260, raise: 560, flash: 620,
  floodAt: 320, flood: 980, pop: 300, hot: 420,
  drain: 260,
  edgeAt: 1180, edge: 520,
  numberAt: 620, number: 2700, wordsAt: 820, words: 3900,
  farSettle: 420,
});
/** The capture's number (「+1 province」): its size and its way up (screen px), and how far it may be moved to stay clear of the HUD. */
const BIG = Object.freeze({ size: 46, travel: 56, reach: 260 });
/** How long a capture plays (ms). */
export const captureMs = () => CAPTURE.wordsAt + CAPTURE.words;
/** How long a broken contest's dial falls apart, and how long its words stay (ms). */
export const BREAK = Object.freeze({ ms: 1300, words: 4200 });
/** How long the dial lands large after a turn was added (ms). */
export const DIAL_BUMP_MS = 420;
/** How long the board's answer to a tap on a keep stays (ms). */
export const KEEP_NOTE_MS = 3600;
/** A capture's record is news for this many turns after its own (a turn is settled after it ends; an older one is the season's past). */
export const KEEP_NEWS_TURNS = 8;
/** A change of holder in the control record waits this long for its `keep_taken` record before it is played from the control record itself (ms). */
export const CONTROL_GRACE_MS = 4500;

/**
 * Where a capture is at `t` ms: `{strike (0..1 the old standard falling, null once it is down), raise (0..1 the new
 * one rising, null before), flash (1..0), tile(d, maxD) → {in, hot} (how far the tile at `d` tiles from the keep has
 * taken the new colour, and how hot it still is), drain (0..1: the old colour gone grey; a loss), edge (0..1),
 * number (0..1 or null), words (alpha 0..1), done}`.
 */
export function captureAt(t, { lost = false } = {}) {
  const T = CAPTURE, shift = lost ? T.drain : 0;
  const strike = t < T.strike ? clamp01(t / T.strike) : null;
  const raise = t < T.raiseAt ? null : clamp01((t - T.raiseAt) / T.raise);
  const flash = t < T.raiseAt ? 0 : Math.max(0, 1 - (t - T.raiseAt) / T.flash);
  const tile = (d, maxD) => {
    const at = T.floodAt + shift + (maxD > 0 ? (d / maxD) * (T.flood - T.pop) : 0), k = (t - at) / T.pop;
    return { in: outCubic(k), hot: k <= 0 ? 0 : Math.max(0, 1 - (t - at) / T.hot) };
  };
  const number = t < T.numberAt || t >= T.numberAt + T.number ? null : (t - T.numberAt) / T.number;
  const w = t - T.wordsAt, words = w < 0 ? 0 : w < 180 ? w / 180 : w > T.words - 500 ? clamp01((T.words - w) / 500) : 1;
  return { strike, raise, flash, tile, drain: lost ? clamp01(t / T.drain) : 0, edge: clamp01((t - T.edgeAt - shift) / T.edge), number, words, flooded: t >= T.floodAt + shift + T.flood, done: t >= captureMs() };
}

// ------------------------------------------------------------------ the records' reader
/**
 * The keeps of the provinces' records (`recs`: Map "p,q" → an overview's province with the control record laid on
 * it): `[{key, p, q, tile, holder, troops, contender (0–5 or null), held, of, heartland}]`. A province without a
 * keep, or whose holder the record does not say, is left out.
 */
export function keepRows(recs) {
  const out = [];
  for (const r of recs?.values?.() ?? []) {
    if (!Number.isInteger(r?.keepTile) || r.keepTile < 0 || r.keepTile >= PROVINCE_TILES || !Number.isInteger(r.p) || !Number.isInteger(r.q)) continue;
    const holder = nation(r.control) ? r.control : null;
    const contender = nation(r.contender) && r.contender !== holder ? r.contender : null;
    out.push({ key: keyOf(r.p, r.q), p: r.p, q: r.q, tile: r.keepTile, holder, troops: Number.isFinite(r.keepTroops) ? r.keepTroops : null,
      contender, held: contender !== null && Number.isFinite(r.contestProgress) ? r.contestProgress : 0, of: Number.isFinite(r.contestRequired) && r.contestRequired > 0 ? r.contestRequired : 72, heartland: !!r.heartland });
  }
  return out;
}

/** How many provinces each nation holds by `holderOf(row)`: `[n0 … n5]`. */
export function provinceCounts(rows, holderOf = r => r.holder) {
  const n = [0, 0, 0, 0, 0, 0];
  for (const r of rows) { const h = holderOf(r); if (nation(h)) n[h] += 1; }
  return n;
}

/**
 * The reader of the conquest records. `read({rows, events, viewer, now})` takes the keeps of this reading (`keepRows`)
 * and the keep events known (null while the season's days have not been read), and returns what has changed since
 * the reading before as moments, oldest first:
 *   {kind: 'captured', p, q, tile, from, to, turn, mine, lost, before, after, by: 'record' | 'control', donor}
 *   {kind: 'contest',  p, q, tile, held, of, by, mine, defend, fresh}     (a contest began, or a turn was added to it)
 *   {kind: 'broken',   p, q, tile, held, of, by, mine, defend}            (a contest ended without a capture)
 * What a first reading finds is simply there: no moment. `shown(key)` is the holder the board shows: the record's,
 * except that a capture's own record is believed before the control record has caught up with it, and a change of
 * the control record waits a moment for its capture record (`CONTROL_GRACE_MS`) so that one capture is played once.
 */
export class KeepBook {
  constructor() { this.reset(); }
  reset() { this.rows = new Map(); this.holders = new Map(); this.contests = new Map(); this.ended = new Map(); this.snaps = new Map(); this.seen = null; this.pending = new Map(); this.taken = new Map(); this.first = true; this.viewer = null; }
  /** The holder the board shows for province `key` (0–5), or null. */
  shown(key) { return this.holders.has(key) ? this.holders.get(key) : this.rows.get(key)?.holder ?? null; }
  /** Provinces held by each nation as the board shows them. */
  counts() { return provinceCounts(this.rows.values(), r => this.shown(r.key)); }
  read({ rows = [], events = null, viewer = null, now = 0, bell = null } = {}) {
    const out = [], me = nation(viewer) ? viewer : null;
    this.viewer = me;
    this.rows = new Map(rows.map(r => [r.key, r]));
    // (the overview came before the control record: no holder is known yet, and the reading that brings them is the first)
    if (this.first && !rows.some(r => r.holder !== null)) return out;
    const first = this.first;
    this.first = false;
    // ---- the capture records
    const fresh = [];
    if (Array.isArray(events)) {
      const known = this.seen;
      this.seen = new Set(events.map(e => `${e.kind}:${e.seq}`));
      // (the first sight of the season's events is the record's past, not news)
      if (known && !first) for (const e of events) if (!known.has(`${e.kind}:${e.seq}`)) fresh.push(e);
    }
    const captured = new Set(), broke = new Set();
    const capture = (row, from, to, turn, by, donor = null) => {
      if (!nation(to) || from === to) return;
      const before = provinceCounts(this.rows.values(), r => this.shown(r.key));
      this.holders.set(row.key, to);
      this.taken.set(row.key, { to, turn });
      this.pending.delete(row.key);
      captured.add(row.key);
      const after = provinceCounts(this.rows.values(), r => this.shown(r.key));
      out.push({ kind: 'captured', p: row.p, q: row.q, tile: row.tile, from: nation(from) ? from : null, to, turn: Number.isInteger(turn) ? turn : null, mine: me !== null && to === me, lost: me !== null && from === me,
        before: before[to], after: after[to], lostBefore: nation(from) ? before[from] : null, lostAfter: nation(from) ? after[from] : null, by,
        // (the host that went into the keep with the capture, as the capture's record names it; a capture read from the control record names none)
        donor: donor !== null && donor !== undefined && donor !== '' ? String(donor) : null });
    };
    for (const e of fresh) {
      const row = this.rows.get(keyOf(e.p, e.q));
      if (!row) continue;
      if (e.kind === 'keep_taken') {
        // (a record of the season's past that is read late — the days' files come one by one — is not news; nor is a
        // capture the board already shows, played from the control record or simply there when the page opened)
        if (Number.isInteger(bell) && Number.isInteger(e.bell) && e.bell < bell - KEEP_NEWS_TURNS) continue;
        if (this.shown(row.key) === e.to) { this.taken.set(row.key, { to: e.to, turn: e.bell }); continue; }
        capture(row, nation(e.from) ? e.from : this.shown(row.key), e.to, e.bell, 'record', e.detail?.donor ?? e.donor ?? null);
      } else if (e.kind === 'keep_broken') {
        // the record says the contest ended: the hold is broken now, with the record's own word (the control record
        // that still shows the contender is the turn's before: it does not begin the contest again, `ended`)
        if (Number.isInteger(bell) && Number.isInteger(e.bell) && e.bell < bell - KEEP_NEWS_TURNS) continue;
        const c = this.contests.get(row.key);
        if (!c) continue;
        this.contests.delete(row.key);
        this.ended.set(row.key, { by: c.by, held: c.held });
        broke.add(row.key);
        out.push({ kind: 'broken', p: row.p, q: row.q, tile: row.tile, held: c.held, of: c.of, by: c.by, mine: me !== null && c.by === me, defend: me !== null && this.shown(row.key) === me });
      }
    }
    // ---- the control record
    for (const row of this.rows.values()) {
      // (a province whose holder this reading does not say: the page reads the overviews of a new turn before it lays
      // the control record on them again, and for that moment no province has a holder or a contest. Nothing is known
      // of it then, so nothing of it changes: seen on the local test chain, 2026-10-11, where every contest "ended" at
      // each turn's change and began again a moment later)
      if (row.holder === null) continue;
      const key = row.key, had = this.holders.has(key) ? this.holders.get(key) : undefined;
      // (a holder the record did not say before — the overview came before the control record — is simply there now)
      if (had === undefined || had === null || first) { if (!captured.has(key) && !(had === null && row.holder === null)) this.holders.set(key, row.holder ?? had ?? null); }
      else if (row.holder !== null && row.holder !== had && !captured.has(key)) {
        const t = this.taken.get(key);
        // (the control record has not caught up with a capture the board already shows: the capture's record stands)
        if (t && t.to === had && this.snaps.get(key) === row.holder) { /* still the snapshot from before the capture */ }
        else if (events === null) capture(row, had, row.holder, null, 'control');
        else {
          const p = this.pending.get(key);
          if (!p || p.to !== row.holder) this.pending.set(key, { from: had, to: row.holder, since: now });
          else if (now - p.since >= CONTROL_GRACE_MS) capture(row, had, row.holder, null, 'control');
        }
      } else if (row.holder === had) this.pending.delete(key);
      // (the holder the control record itself last said, whatever the board shows: `snaps`)
      this.snaps.set(key, row.holder);
      // ---- the contest
      const c = this.contests.get(key) ?? null, holder = this.shown(key);
      const by = row.contender !== null && row.contender !== holder ? row.contender : null;
      const gone = this.ended.get(key) ?? null;
      // (the snapshot from before a contest's end was read: the same contender with no fewer turns than it had)
      if (gone && by === gone.by && row.held >= gone.held) continue;
      if (gone) this.ended.delete(key);
      if (by !== null && row.held > 0) {
        const isNew = !c || c.by !== by;
        if (first) this.contests.set(key, { by, held: row.held, of: row.of });
        else if (isNew || row.held !== c.held) {
          this.contests.set(key, { by, held: row.held, of: row.of });
          // (a count that fell back to a lower number under the same contender began again: the record says so with `keep_broken` and a new `keep_contest`)
          out.push({ kind: 'contest', p: row.p, q: row.q, tile: row.tile, held: row.held, of: row.of, by, mine: me !== null && by === me, defend: me !== null && holder === me, fresh: isNew || row.held < c.held });
        }
      } else if (c) {
        this.contests.delete(key);
        if (!first && !captured.has(key) && !broke.has(key) && !this.pending.has(key) && this.taken.get(key)?.to !== c.by) out.push({ kind: 'broken', p: row.p, q: row.q, tile: row.tile, held: c.held, of: c.of, by: c.by, mine: me !== null && c.by === me, defend: me !== null && holder === me });
        broke.delete(key);
      }
    }
    for (const key of [...this.holders.keys()]) if (!this.rows.has(key)) { this.holders.delete(key); this.contests.delete(key); this.ended.delete(key); this.snaps.delete(key); this.pending.delete(key); this.taken.delete(key); }
    return out;
  }
}

// ------------------------------------------------------------------ geometry
const geos = new Map();
/** A province's tiles and outline (world px), kept: `{tiles: [{i, q, r, x, y}], fill (Path2D of every tile), edges: [{a, b, np, nq}] (its outer edge, each piece with the province beyond it), c}`. */
export function provinceGeo(p, q) {
  const k = keyOf(p, q);
  if (geos.has(k)) return geos.get(k);
  const tiles = [], edges = [];
  const fill = typeof Path2D === 'undefined' ? null : new Path2D();
  for (let i = 0; i < PROVINCE_TILES; i++) {
    const h = tileHex(p, q, i), c = project(h.q, h.r), pts = hexPoints(c.x, c.y, -0.3);
    tiles.push({ i, q: h.q, r: h.r, x: c.x, y: c.y });
    if (fill) { pts.forEach(([px, py], j) => (j ? fill.lineTo(px, py) : fill.moveTo(px, py))); fill.closePath(); }
    for (const [dq, dr] of EDGE_DIRS) {
      const at = locate(h.q + dq, h.r + dr);
      if (at.p === p && at.q === q) continue;
      const n = project(h.q + dq, h.r + dr), mx = (c.x + n.x) / 2, my = (c.y + n.y) / 2;
      // the two corners of this hexagon nearest the neighbour: the edge they share
      const near = hexPoints(c.x, c.y, 0).map(pt => ({ pt, d: Math.hypot(pt[0] - mx, pt[1] - my) })).sort((a, b) => a.d - b.d);
      edges.push({ a: near[0].pt, b: near[1].pt, np: at.p, nq: at.q });
    }
  }
  const v = { tiles, fill, edges, c: provincePixel(p, q) };
  geos.set(k, v);
  return v;
}
/** The outer edge of a province as one path: every piece, or only those `keep(edge)` says. */
function edgePath(geo, keep = null) {
  if (typeof Path2D === 'undefined') return null;
  const path = new Path2D();
  for (const e of geo.edges) if (!keep || keep(e)) { path.moveTo(e.a[0], e.a[1]); path.lineTo(e.b[0], e.b[1]); }
  return path;
}

// ------------------------------------------------------------------ painters
/** A keep's fortress with its foot at (x, y): `u` its unit in world px. Drawn from a kept bitmap when one can be made. */
export function paintKeepFortress(g, x, y, u, { faction = null, mine = false, zoom = 1, dpr = 1, alpha = 1 } = {}) {
  if (!g?.save || !(alpha > 0)) return;
  const sp = fortressSprite(u * zoom * dpr, { faction, mine });
  g.save();
  g.globalAlpha = (g.globalAlpha ?? 1) * alpha;
  if (sp?.cv && g.drawImage) { g.imageSmoothingEnabled = true; g.drawImage(sp.cv, x - sp.ox * u, y - sp.oy * u, sp.w * u, sp.h * u); }
  else paintFortress(g, x, y, u, { faction, mine });
  g.restore();
}
/** A keep on the world chart: a small tower in its holder's colour, ringed in gold when it is the viewer's nation's. Screen sized. */
export function paintKeepMark(g, x, y, { zoom = 1, faction = null, mine = false, size = KEEP_LOOK.mark, alpha = 1 } = {}) {
  if (!g?.save || !(alpha > 0)) return;
  const s = size / zoom, col = FACTION_COLORS[faction] ?? '#8b856d';
  g.save();
  g.globalAlpha = (g.globalAlpha ?? 1) * alpha; g.lineJoin = 'round';
  if (mine) { g.strokeStyle = KEY; g.lineWidth = 3.4 / zoom; g.beginPath(); g.arc(x, y - s * 0.25, s * 1.55, 0, Math.PI * 2); g.stroke(); g.strokeStyle = GOLD; g.lineWidth = 1.8 / zoom; g.stroke(); }
  // a crenellated tower: three merlons over a tapering body
  g.beginPath();
  g.moveTo(x - s * 0.72, y + s * 0.6); g.lineTo(x - s * 0.6, y - s * 0.5); g.lineTo(x - s * 0.86, y - s * 0.5); g.lineTo(x - s * 0.86, y - s * 1.15); g.lineTo(x - s * 0.42, y - s * 1.15); g.lineTo(x - s * 0.42, y - s * 0.82);
  g.lineTo(x - s * 0.2, y - s * 0.82); g.lineTo(x - s * 0.2, y - s * 1.15); g.lineTo(x + s * 0.2, y - s * 1.15); g.lineTo(x + s * 0.2, y - s * 0.82); g.lineTo(x + s * 0.42, y - s * 0.82);
  g.lineTo(x + s * 0.42, y - s * 1.15); g.lineTo(x + s * 0.86, y - s * 1.15); g.lineTo(x + s * 0.86, y - s * 0.5); g.lineTo(x + s * 0.6, y - s * 0.5); g.lineTo(x + s * 0.72, y + s * 0.6); g.closePath();
  g.strokeStyle = '#141c19'; g.lineWidth = 2.6 / zoom; g.stroke();
  g.fillStyle = col; g.fill();
  g.fillStyle = 'rgba(20,28,25,.78)'; g.fillRect?.(x - s * 0.17, y - s * 0.12, s * 0.34, s * 0.72);
  g.restore();
}

/**
 * A province as its holder's land: a light wash of the nation's colour that leaves the terrain its own, a soft band
 * of it inside the edge and the edge itself in that colour (only where the province beyond belongs to another
 * holder: a nation's provinces read as one realm). `mine`: the viewer's nation, a little stronger.
 */
export function paintProvinceHold(g, geo, { zoom = 1, faction = 0, mine = false, edges = null, inner = null, alpha = 1, wash = true } = {}) {
  if (!g?.save || !geo?.fill || !nation(faction) || !(alpha > 0)) return;
  const col = NATION_LAND[faction] ?? FACTION_COLORS[faction], W = KEEP_LOOK.wash, E = KEEP_LOOK.edge;
  g.save();
  if (wash) { g.globalAlpha = alpha * (mine ? W.mine : W.other); g.fillStyle = col; g.fill(geo.fill); }
  // (the edge it shares with another province of the same holder: a thin line of the colour, so each province is seen)
  if (inner) { g.globalAlpha = alpha * (mine ? 0.5 : 0.36); g.strokeStyle = col; g.lineWidth = 1.5 / zoom; g.lineCap = 'round'; g.stroke(inner); }
  const path = edges ?? edgePath(geo);
  if (path) {
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.save();
    g.clip(geo.fill);
    g.globalAlpha = alpha * (mine ? E.bandAlpha.mine : E.bandAlpha.other); g.strokeStyle = col; g.lineWidth = RADIUS * E.band * 2; g.stroke(path);
    g.restore();
    g.globalAlpha = alpha * 0.5; g.strokeStyle = 'rgba(16,22,20,.9)'; g.lineWidth = (E.line + 2) / zoom; g.stroke(path);
    g.globalAlpha = alpha * (mine ? E.lineAlpha.mine : E.lineAlpha.other); g.strokeStyle = col; g.lineWidth = E.line / zoom; g.stroke(path);
  }
  g.restore();
}

/** One tile of a province taking a new holder's colour: `k` 0..1 how far it has come in, `hot` 1..0 how bright it still is. */
export function paintFloodHex(g, t, { faction = 0, k = 1, hot = 0, alpha = 1 } = {}) {
  if (!g?.save || !(k > 0)) return;
  const col = NATION_LAND[faction] ?? FACTION_COLORS[faction] ?? '#8a8f86';
  g.save();
  const pts = hexPoints(t.x, t.y, -0.3 + (1 - k) * RADIUS * 0.5);
  g.beginPath(); pts.forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath();
  g.globalAlpha = alpha * k; g.fillStyle = col; g.fill();
  if (hot > 0) { g.globalAlpha = alpha * 0.75 * hot; g.fillStyle = '#fff6da'; g.fill(); g.globalAlpha = alpha * hot; g.strokeStyle = '#fffdf2'; g.lineWidth = 2.2; g.stroke(); }
  g.restore();
}

/** A keep that can be reached: a breathing gold ring on its tile (the ground's own pass). */
export function paintReachRing(g, x, y, { zoom = 1, now = fxNow(), still = false, alpha = 1, hot = false } = {}) {
  if (!g?.save || !(alpha > 0)) return;
  // (`hot`: the keep whose row of the card is under the pointer: a wider ring and a stronger light)
  const R = KEEP_LOOK.reach, beat = still ? 0.5 : 0.5 + 0.5 * Math.sin((now / 1000) * R.beat * (hot ? 1.6 : 1) * Math.PI * 2), r = RADIUS * (R.r + 0.07 * beat) * (hot ? 1.22 : 1);
  g.save();
  g.translate(x, y); g.scale(1, FLATTEN);
  if (g.createRadialGradient) {
    const gr = g.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.5);
    gr.addColorStop(0, 'rgba(255,210,77,0)'); gr.addColorStop(0.6, `rgba(255,210,77,${(hot ? 0.34 + 0.2 * beat : 0.16 + 0.14 * beat) * alpha})`); gr.addColorStop(1, 'rgba(255,210,77,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r * 1.5, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = alpha; g.strokeStyle = KEY; g.lineWidth = Math.max(5.4 / zoom, RADIUS * 0.12) * (hot ? 1.3 : 1); g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = GOLD; g.lineWidth = Math.max(3 / zoom, RADIUS * 0.07) * (hot ? 1.3 : 1); g.stroke();
  g.globalAlpha = alpha * (0.5 + 0.5 * beat); g.strokeStyle = YOURS_MARK.core; g.lineWidth = Math.max(1 / zoom, RADIUS * 0.022); g.stroke();
  // a second ring opening outward and fading: the keep calls
  if (!still) { const o = ((now / 1000) * R.beat * 0.5) % 1; g.globalAlpha = alpha * 0.55 * (1 - o); g.strokeStyle = GOLD; g.lineWidth = Math.max(1.6 / zoom, RADIUS * 0.035); g.beginPath(); g.arc(0, 0, r * (1.05 + 0.55 * o), 0, Math.PI * 2); g.stroke(); }
  g.restore();
}

/**
 * A contest's dial falling apart (`k` 0..1): the dial is struck (a white crack and an ember ring that opens), its
 * ring breaks into six pieces that fly outward, turn and fall, and its dark face drops away. Screen sized.
 */
export function paintDialBreak(g, x, y, k, { zoom = 1, colour = GOLD, share = 0.3, r = KEEP_LOOK.dial.r, arc = KEEP_LOOK.dial.arc, held = null } = {}) {
  if (!g?.save || k === null || k < 0 || k >= 1) return;
  const s = 1 / zoom, e = outCubic(k), TAU = Math.PI * 2, a0 = -Math.PI / 2, filled = TAU * clamp01(share);
  g.save();
  // the face: it holds for a moment, cracked, then drops and fades
  const drop = inCubic(clamp01((k - 0.12) / 0.88)) * 34 * s, fa = 1 - clamp01((k - 0.25) / 0.5);
  if (fa > 0) {
    g.globalAlpha = fa; g.fillStyle = 'rgba(13,24,22,.96)'; g.beginPath(); g.arc(x, y + drop, (r + arc / 2 + 1.2) * s, 0, TAU); g.fill();
    if (held !== null) { g.fillStyle = '#ffb7a3'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `800 ${(held > 9 ? 10.2 : 11.6) * (r / 13) * s}px system-ui, -apple-system, sans-serif`; g.fillText?.(String(held), x, y + drop + 0.5 * s); }
    // the crack across it
    g.strokeStyle = '#fff6e2'; g.lineWidth = 1.6 * s; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(x - r * 0.9 * s, y + drop - r * 0.5 * s); g.lineTo(x - r * 0.2 * s, y + drop - r * 0.05 * s); g.lineTo(x + r * 0.1 * s, y + drop + r * 0.3 * s); g.lineTo(x + r * 0.85 * s, y + drop + r * 0.55 * s); g.stroke();
  }
  // the ring in six pieces: the part that was filled in the contender's colour, the rest pale
  g.lineCap = 'butt';
  for (let i = 0; i < 6; i++) {
    const m0 = a0 + (TAU * i) / 6, m1 = m0 + TAU / 6 - 0.12, mid = (m0 + m1) / 2;
    const d = e * (26 + 16 * ((i * 7) % 3)) * s, fall = k * k * (38 + 10 * (i % 2)) * s, turn = (i % 2 ? 1 : -1) * e * 0.9;
    g.globalAlpha = 1 - inCubic(k);
    g.strokeStyle = mid - a0 <= filled ? colour : 'rgba(255,250,240,.55)'; g.lineWidth = arc * s;
    g.beginPath(); g.arc(x + Math.cos(mid) * d, y + Math.sin(mid) * d + fall, r * s, m0 + turn, m1 + turn); g.stroke();
  }
  // the blow: a white flash at once, an ember ring that opens and is gone
  if (k < 0.3) { g.globalAlpha = 1 - k / 0.3; g.strokeStyle = '#ffffff'; g.lineWidth = 2.6 * s; g.beginPath(); g.arc(x, y, (r + 5 + 30 * k) * s, 0, TAU); g.stroke(); }
  if (k < 0.7) { g.globalAlpha = 0.9 * (1 - k / 0.7); g.strokeStyle = '#ff6a4a'; g.lineWidth = (4 - 3 * k) * s; g.beginPath(); g.arc(x, y, (r + 8 + 74 * outCubic(k / 0.7)) * s, 0, TAU); g.stroke(); }
  g.restore();
}

// ------------------------------------------------------------------ the words
export const holdText = (held, of) => L`砦を保持中 · ${fmtNum(held)} / ${fmtNum(of)} ターン`;
export const holdByText = (f, held, of) => L`${factionName(f)}が砦を保持中 · ${fmtNum(held)} / ${fmtNum(of)} ターン`;
export const holdAgainstText = (f, held, of) => L`${factionName(f)}があなたの国の砦を保持中 · ${fmtNum(held)} / ${fmtNum(of)} ターン`;
export const brokenText = () => L`砦の保持が途切れました`;
export const gainText = () => L`+1 州`;
export const lossText = () => L`−1 州`;
export const countText = (a, b) => L`保有する州 ${fmtNum(a)} → ${fmtNum(b)}`;
export const countOfText = (f, a, b) => L`${factionName(f)}の州 ${fmtNum(a)} → ${fmtNum(b)}`;
export const takenText = (f, turn) => (Number.isInteger(turn) ? L`${factionName(f)}がこの州を奪いました（ターン ${fmtNum(turn)}）` : L`${factionName(f)}がこの州を奪いました`);
export const reachTurnText = bell => L`ターン ${fmtNum(bell)} に到着`;
export const reachWhy = Object.freeze({
  far: () => L`この軍勢では届きません（進軍は4州まで）`,
  heartland: () => L`本国の砦は奪えません`,
  guarded: bell => (Number.isInteger(bell) ? L`奪われた直後で守られています（ターン ${fmtNum(bell)} まで）` : L`奪われた直後で守られています`),
  own: () => L`あなたの国の砦です`,
});

// ------------------------------------------------------------------ the board's part
/**
 * The keeps on the map. The map owns one (`map.keeps`) and calls, each frame: `frame(recs, feed, F)` (read the
 * records), then in its passes `ground`, `top`, `over` at the tile view and `far` from afar.
 */
export class KeepBoard {
  constructor({ invalidate = () => {}, tick = () => {} } = {}) {
    this.book = new KeepBook();
    this.invalidate = invalidate; this.tick = tick;
    this.on = false;
    this.captures = new Map();   // key → {t0, from, to, turn, mine, lost, before, after, maxD}
    this.breaks = new Map();     // key → {t0, by, held, of, mine}
    this.bumps = new Map();      // key → fx ms of the last added turn
    this.reach = null;           // Map key → {p, q, tile, arriveTurn, holder, defenders, reachable, why}
    this.reachOwn = false;       // setKeepReach was called by the page: the default feed is not used
    this.note = null;            // {key, text, at}
    this.sample = null;
    this.sampleReach = null;
    this.sig = null;
    this.want = null;            // a capture the camera should come to: {p, q, tile}
  }
  /**
   * Sample records in the records' own shapes (`{recs: Map, events, viewer, bell, reach?}`; the demo switch alone,
   * fx/keep-demo.mjs), or null to take the sample away. A sample is read at once, as a reading of the records at
   * effects-clock time `at` (ms): a sample given after another is a change of the records, and plays its moments.
   */
  setSample(sample = null, { at = fxNow(), still = false } = {}) {
    if (!sample || !this.sample) { this.book.reset(); this.captures.clear(); this.breaks.clear(); this.bumps.clear(); this.note = null; }
    this.sample = sample; this.sig = null;
    this.sampleReach = sample?.reach?.length ? new Map(sample.reach.map(x => [keyOf(x.p, x.q), { ...x, reachable: !!x.reachable }])) : null;
    if (sample) this.read(sample, at, still);
    this.invalidate();
  }
  /** The reach that is lit: a sample's own, else the page's. */
  get lit() { return this.sampleReach ?? this.reach; }
  /**
   * The keeps a fighting host in hand could march on: `list` = `[{p, q, tile, arriveTurn, holder, defenders,
   * reachable, why, hot?}]` or null (no host in hand). A keep with `reachable` lights (a breathing gold ring, wider with `hot`, its
   * arrival turn); one without stays dim and answers a tap with `why`. Keeps the list does not name are left as they are.
   */
  setReach(list = null, { own = true } = {}) {
    if (own) this.reachOwn = true;
    const next = Array.isArray(list) && list.length ? new Map(list.filter(x => Number.isInteger(x?.p) && Number.isInteger(x?.q)).map(x => [keyOf(x.p, x.q), { ...x, reachable: !!x.reachable }])) : null;
    const sig = next ? [...next.values()].map(x => `${x.p},${x.q},${x.reachable ? 1 : 0},${x.arriveTurn ?? ''}${x.hot ? ',h' : ''}`).join(';') : '';
    if (sig === (this.reachSig ?? '')) return false;
    this.reachSig = sig; this.reach = next;
    this.invalidate();
    return true;
  }
  /** Read the records of this frame. `feed`: `{events, viewer, bell}` from the page (map/keepmount.mjs), else the source's own. */
  frame(recs, feed, { fx = fxNow(), still = false } = {}) {
    if (this.sample) return;   // (a sample's records are read when they are given)
    const src = { recs, events: feed?.events ?? null, viewer: feed?.viewer ?? null, bell: feed?.bell ?? null };
    // (read again only when something of the records moved, or a change of the control record still waits for its capture record)
    const ev = Array.isArray(src.events) ? src.events : null, last = ev?.length ? ev[ev.length - 1] : null;
    let sig = `${src.viewer}|${ev ? `${ev.length}:${last?.seq ?? ''}` : 'x'}|`;
    for (const r of recs?.values?.() ?? []) if (Number.isInteger(r.keepTile)) sig += `${r.p},${r.q}:${r.control}:${r.contender}:${r.contestProgress};`;
    if (sig === this.sig && !this.book.pending.size) return;
    this.sig = sig;
    this.read(src, fx, still);
  }
  /** One reading of the records `src` = `{recs, events, viewer, bell}` at effects-clock time `fx` (ms): what changed is played and said on the bus. */
  read(src, fx = fxNow(), still = false) {
    const rows = keepRows(src.recs), ev = Array.isArray(src.events) ? src.events : null;
    for (const m of this.book.read({ rows, events: ev, viewer: src.viewer, now: fx, bell: src.bell })) {
      const key = keyOf(m.p, m.q);
      if (m.kind === 'captured') {
        const geo = provinceGeo(m.p, m.q), kh = tileHex(m.p, m.q, m.tile);
        const maxD = kh ? geo.tiles.reduce((d, t) => Math.max(d, hexDistance(kh.q, kh.r, t.q, t.r)), 0) : 8;
        // (reduced motion: nothing travels. The province is its new holder's at once, and the line that counts the
        // provinces stands for the rest of its time)
        this.captures.set(key, { ...m, t0: still ? fx - (CAPTURE.edgeAt + CAPTURE.edge + CAPTURE.drain) : fx, maxD });
        this.breaks.delete(key);
        if (m.mine || m.lost) this.want = { p: m.p, q: m.q, tile: m.tile };
        fxEmit('keep:captured', { p: m.p, q: m.q, tile: m.tile, from: m.from, to: m.to, turn: m.turn, mine: m.mine, lost: m.lost, before: m.before, after: m.after, donor: m.donor ?? null });
      } else if (m.kind === 'contest') {
        this.bumps.set(key, fx);
        fxEmit('keep:contest', { p: m.p, q: m.q, held: m.held, of: m.of, by: m.by, mine: m.mine });
      } else if (m.kind === 'broken') {
        this.breaks.set(key, { ...m, t0: fx });
        fxEmit('keep:broken', { p: m.p, q: m.q, held: m.held, of: m.of, by: m.by, mine: m.mine });
      }
    }
  }
  get rows() { return this.book.rows; }
  get viewer() { return this.book.viewer; }
  /** The holder the far wash shows for province `key` (0–5 or null): the old one until a capture's flood has run. */
  farHolder(key, fx = fxNow()) {
    const c = this.captures.get(key);
    if (c && nation(c.from) && !captureAt(fx - c.t0, c).flooded) return c.from;
    return this.book.shown(key);
  }
  /** The capture of province `key` while it plays: `{c, at}` or null. */
  capturing(key, fx) {
    const c = this.captures.get(key);
    if (!c) return null;
    const at = captureAt(fx - c.t0, c);
    if (at.done) { this.captures.delete(key); return null; }
    return { c, at };
  }
  /** Whether anything of the keeps moves this frame (the map keeps painting). */
  live() { return this.captures.size > 0 || this.breaks.size > 0 || !!this.lit || this.book.contests.size > 0 || !!this.note; }
  /** A keep's place: its tile's centre (world px) and its fortress's unit at `zoom`. */
  place(row, zoom) {
    const h = tileHex(row.p, row.q, row.tile);
    if (!h) return null;
    const c = project(h.q, h.r);
    return { x: c.x + KEEP_LOOK.at.x * RADIUS, y: c.y + KEEP_LOOK.at.y * RADIUS * FLATTEN, cx: c.x, cy: c.y, u: Math.max(RADIUS * KEEP_LOOK.unit, KEEP_LOOK.minPx / zoom), q: h.q, r: h.r };
  }
  visible(F, pad = PROVINCE_CIRCUMRADIUS) {
    const s = F.seen;
    return [...this.rows.values()].filter(r => { const g = provinceGeo(r.p, r.q); return !s || (g.c.x > s.x0 - pad && g.c.x < s.x1 + pad && g.c.y > s.y0 - pad && g.c.y < s.y1 + pad); });
  }
  /**
   * The keep whose fortress or tile is at world point (wx, wy) seen at `zoom` on a board where a standing thing
   * rises `rise` times its drawn height (the tilt): `{p, q, tile}` or null.
   */
  at(wx, wy, zoom = 1, rise = 1) {
    let best = null;
    for (const row of this.rows.values()) {
      const P = this.place(row, zoom);
      if (!P) continue;
      const dx = Math.abs(wx - P.x), up = P.y - wy;
      // its tile, or its walls and towers standing over the tile
      const onTile = Math.hypot(wx - P.x, (wy - P.y) / FLATTEN) <= RADIUS * 0.9;
      const onWalls = dx <= P.u * 0.95 && up >= -P.u * 0.5 && up <= P.u * 1.5 * rise;
      if (!onTile && !onWalls) continue;
      const d = Math.hypot(dx, up - P.u * 0.4);
      if (!best || d < best.d) best = { d, row };
    }
    return best ? { p: best.row.p, q: best.row.q, tile: best.row.tile } : null;
  }
  /** A tap on keep `{p, q}` while a host's reach is lit: the board says why a dim keep cannot be marched on. Returns the reach item or null. */
  tapped(at, fx = fxNow()) {
    const it = at && this.lit ? this.lit.get(keyOf(at.p, at.q)) ?? null : null;
    if (!it) return null;
    if (!it.reachable && it.why) { this.note = { key: keyOf(at.p, at.q), text: String(it.why), at: fx }; this.invalidate(); }
    fxEmit('keep:tap', { p: it.p, q: it.q, tile: it.tile ?? null, reachable: it.reachable, why: it.reachable ? null : it.why ?? null });
    return it;
  }

  /** What the resting ground shows of the keeps: it is painted again when this changes (who holds what, which provinces a capture is playing over). */
  groundKey(fx = fxNow()) {
    for (const [key, c] of this.captures) if (captureAt(fx - c.t0, c).done) this.captures.delete(key);
    return `${this.viewer}|${[...this.rows.values()].map(r => this.book.shown(r.key) ?? 'x').join('')}|${[...this.captures.keys()].join(';')}`;
  }
  // ---- the ground: whose land each province is, the flood of a capture, the rings of the keeps in reach
  /** `part`: 'rest' (the provinces at rest: kept with the still ground), 'moving' (a capture's flood, the rings of a reach), or 'all'. */
  ground(g, F, part = 'all') {
    if (!g?.save) return;
    const { z, fx, still } = F, me = this.viewer;
    for (const row of this.visible(F)) {
      const key = row.key, geo = provinceGeo(row.p, row.q), cap = this.capturing(key, fx);
      const holder = this.book.shown(key);
      // (a nation's provinces read as one realm: the edge is drawn where the land beyond has another holder)
      const edgesOf = f => edgePath(geo, e => { const k2 = keyOf(e.np, e.nq); return (this.rows.has(k2) ? this.book.shown(k2) : null) !== f; });
      const innerOf = f => edgePath(geo, e => { const k2 = keyOf(e.np, e.nq); return this.rows.has(k2) && this.book.shown(k2) === f; });
      if (!cap) { if (part !== 'moving' && nation(holder)) paintProvinceHold(g, geo, { zoom: z, faction: holder, mine: holder === me, edges: edgesOf(holder), inner: innerOf(holder) }); continue; }
      if (part === 'rest') continue;
      F.rolling = true;
      const { c, at } = cap, kh = tileHex(row.p, row.q, row.tile), W = KEEP_LOOK.wash;
      // the old holder's colour stays on the tiles the flood has not reached (a loss: it goes grey first), the new one comes in tile by tile
      const rest = c.to === me ? W.mine : W.other, old = c.from === me ? W.mine : W.other;
      for (const t of geo.tiles) {
        const d = kh ? hexDistance(kh.q, kh.r, t.q, t.r) : 0, s = at.tile(d, c.maxD);
        if (s.in < 1 && nation(c.from)) {
          g.save(); g.globalAlpha = old * (1 - s.in) * (1 - 0.55 * at.drain); g.fillStyle = at.drain > 0 ? mixGrey(NATION_LAND[c.from], at.drain) : NATION_LAND[c.from];
          const pts = hexPoints(t.x, t.y, -0.3); g.beginPath(); pts.forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); g.fill(); g.restore();
        }
        if (s.in > 0) paintFloodHex(g, t, { faction: c.to, k: s.in, hot: s.hot, alpha: rest + (0.62 - rest) * s.hot });
      }
      // the edge: the old holder's line goes, the new one is drawn on
      if (nation(c.from) && at.edge < 1) paintProvinceHold(g, geo, { zoom: z, faction: c.from, mine: c.from === me, edges: edgesOf(c.from), alpha: 1 - at.edge, wash: false });
      if (at.edge > 0) {
        paintProvinceHold(g, geo, { zoom: z, faction: c.to, mine: c.to === me, edges: edgesOf(c.to), alpha: at.edge, wash: false });
        // (the line arrives bright)
        if (at.edge < 1) { g.save(); g.globalAlpha = (1 - at.edge) * 0.9; g.strokeStyle = '#fffdf2'; g.lineWidth = 5 / z; g.lineCap = 'round'; const e = edgesOf(c.to); if (e) g.stroke(e); g.restore(); }
      }
    }
  }

  // ---- what stands: the fortress, the standard on it
  top(g, F) {
    if (!g?.save) return;
    const { z, fx, still } = F, me = this.viewer, dpr = F.dpr ?? 1;
    const rows = this.visible(F, RADIUS * 3).map(row => ({ row, P: this.place(row, z) })).filter(x => x.P).sort((a, b) => a.P.y - b.P.y);
    // the keeps a host in hand can reach: a breathing gold ring on the ground round the keep's tile (over the land's props: a wood does not hide it)
    if (this.lit) for (const { row, P } of rows) { const it = this.lit.get(row.key); if (it?.reachable) { paintReachRing(g, (P.cx + P.x) / 2, (P.cy + P.y) / 2, { zoom: z, now: fx, still, hot: !!it.hot }); F.live = true; } }
    for (const { row, P } of rows) {
      const key = row.key, cap = this.capturing(key, fx), holder = this.book.shown(key), mine = holder !== null && holder === me;
      const it = this.lit?.get(key) ?? null, dim = it && !it.reachable ? KEEP_LOOK.reach.dim : 1;
      standing(g, F.up?.(P.x, P.y) ?? null, P.x, P.y, () => {
        const su = P.u * KEEP_LOOK.standard, sx = P.x + FORTRESS.pole.x * P.u, sy = P.y - FORTRESS.pole.up * P.u;
        if (!cap) {
          paintKeepFortress(g, P.x, P.y, P.u, { faction: holder, mine, zoom: z, dpr, alpha: dim });
          if (nation(holder)) paintStandard(g, sx, sy, { u: su, zoom: z, faction: holder, now: fx, still, alpha: dim });
          return;
        }
        const { c, at } = cap, shown = at.raise === null ? c.from : c.to;
        paintKeepFortress(g, P.x, P.y, P.u, { faction: shown, mine: shown !== null && shown === me, zoom: z, dpr });
        // the old standard is struck: it tips over the wall and is gone
        if (at.strike !== null && nation(c.from)) {
          const k = inCubic(at.strike);
          g.save(); g.translate(sx, sy); g.rotate(k * 1.35); g.translate(-sx, -sy);
          paintStandard(g, sx, sy + k * su * 0.5, { u: su, zoom: z, faction: c.from, now: fx, still: true, alpha: 1 - k });
          g.restore();
        }
        // the new one is run up, with a flash at the tower's head
        if (at.raise !== null) {
          const k = outCubic(at.raise);
          paintStandard(g, sx, sy, { u: su * (1 + 0.28 * (1 - k)), zoom: z, faction: c.to, now: fx, still, lift: (1 - k) * 0.16, alpha: clamp01(at.raise * 3) });
          if (at.flash > 0) paintFlash(g, sx, sy - su * 1.1, P.u * (1.1 + 2.2 * (1 - at.flash)), at.flash, c.to === me ? GOLD : FACTION_COLORS[c.to]);
        }
      });
      F.live = true;
    }
  }

  /**
   * The keeps in reach once more, over the dim a host's own reach lays on everything outside it (map/actions.mjs
   * paintReachDim): the ring, the fortress and its standard at their full light. What lights must light.
   */
  lightTop(g, F) {
    if (!g?.save || !this.lit) return;
    const { z, fx, still } = F, me = this.viewer, dpr = F.dpr ?? 1;
    for (const it of this.lit.values()) {
      if (!it.reachable) continue;
      const row = this.rows.get(keyOf(it.p, it.q)), P = row ? this.place(row, z) : null;
      if (!P || this.captures.has(row.key)) continue;
      const s = F.seen;
      if (s && (P.x < s.x0 - RADIUS * 3 || P.x > s.x1 + RADIUS * 3 || P.y < s.y0 - RADIUS * 3 || P.y > s.y1 + RADIUS * 3)) continue;
      const holder = this.book.shown(row.key);
      paintReachRing(g, (P.cx + P.x) / 2, (P.cy + P.y) / 2, { zoom: z, now: fx, still, hot: !!it.hot });
      standing(g, F.up?.(P.x, P.y) ?? null, P.x, P.y, () => {
        paintKeepFortress(g, P.x, P.y, P.u, { faction: holder, mine: holder !== null && holder === me, zoom: z, dpr });
        if (nation(holder)) paintStandard(g, P.x + FORTRESS.pole.x * P.u, P.y - FORTRESS.pole.up * P.u, { u: P.u * KEEP_LOOK.standard, zoom: z, faction: holder, now: fx, still });
      });
    }
  }

  // ---- the words and the dials, upright over the board
  over(o, F, hid = () => false) {
    if (!o?.save) return;
    const { z, fx, still } = F, me = this.viewer, pass = F.pass ?? null, D = KEEP_LOOK.dial, near = z * RADIUS >= 22;
    for (const row of this.visible(F, RADIUS * 3)) {
      const key = row.key, P = this.place(row, z);
      if (!P) continue;
      const anchor = { x: P.x, y: P.y }, rise = F.up ? 1.08 : 1, dx = P.x + D.x * P.u, dy = P.y - D.up * P.u * rise;
      const head = P.y - (FORTRESS.pole.up * P.u + P.u * KEEP_LOOK.standard * 1.5) * rise;
      const cap = this.capturing(key, fx), c = this.book.contests.get(key) ?? null, br = this.breaks.get(key) ?? null;
      // the contest: a ring dial that fills turn by turn, in the contender's colour (gold when it is the viewer's nation)
      // (a battle staged on the keep's own tile has that place for its numbers and its verdict: the dial and its line
      // step back until the scene is over, as every label of the tile does — the line 「砦を保持中 · 1 / 72」 stood across
      // the losses of the very battle that began the hold; the local test chain, 2026-10-11)
      if (c && !cap && !hid({ q: P.q, r: P.r })) {
        const mine = me !== null && c.by === me, defend = me !== null && this.book.shown(key) === me;
        const colour = mine ? GOLD : FACTION_COLORS[c.by] ?? GOLD, t0 = this.bumps.get(key), age = t0 === undefined ? Infinity : fx - t0;
        const bump = still || age >= DIAL_BUMP_MS ? 0 : 1 - age / DIAL_BUMP_MS;
        upright(o, P.x, P.y, () => paintTurnDial(o, dx, dy, { zoom: z, share: c.held / c.of, left: c.held, total: c.of, colour, r: D.r, arc: D.arc, now: fx, still, pulse: defend || (mine && c.of - c.held <= 6), bump, sparks: bump > 0 }));
        if (bump > 0) F.rolling = true;
        if (near) paintTag(o, P.x, head, mine ? holdText(c.held, c.of) : defend ? holdAgainstText(c.by, c.held, c.of) : holdByText(c.by, c.held, c.of), { zoom: z, tone: mine ? 'you' : defend ? 'warn' : 'plain', place: 'above', gap: 6, size: 13, anchor, pass });
        F.live = true;
      }
      // a contest that ended without a capture: the dial falls apart, and the board says so for a few seconds
      if (br) {
        const age = fx - br.t0;
        if (age >= BREAK.words) this.breaks.delete(key);
        else {
          const colour = br.mine ? GOLD : FACTION_COLORS[br.by] ?? GOLD;
          if (!still && age < BREAK.ms) { upright(o, P.x, P.y, () => paintDialBreak(o, dx, dy, age / BREAK.ms, { zoom: z, colour, share: br.held / br.of, held: br.held })); F.rolling = true; }
          paintTag(o, P.x, head, brokenText(), { zoom: z, tone: 'warn', place: 'above', gap: 6, size: 13, alpha: clamp01((BREAK.words - age) / 500), anchor, pass });
          F.live = true;
        }
      }
      // the capture: the number that rises from the keep, and how many provinces the nation holds now
      if (cap) {
        const { c: m, at } = cap, colour = m.mine ? GOLD : m.lost ? '#ff8a5a' : FACTION_COLORS[m.to] ?? GOLD;
        // (the number rises from above the lines that stand over the keep: one line for the viewer's own gain, two otherwise)
        const lines = m.mine ? 1 : 2;
        // the lines first: the label pass gives them their place clear of the HUD, and the number then keeps clear of
        // them (a line that is not yet to be read is laid out all the same, unseen, so that the number knows its place)
        {
          const line = m.lost && Number.isInteger(m.lostBefore) ? countText(m.lostBefore, m.lostAfter) : m.mine ? countText(m.before, m.after) : countOfText(m.to, m.before, m.after);
          const box = at.words > 0 || (at.number !== null && !still) ? paintTag(o, P.x, head, line, { zoom: z, tone: m.mine ? 'you' : m.lost ? 'warn' : 'plain', place: 'above', gap: 8, size: 15, alpha: at.words, anchor, pass }) : null;
          if (box && (m.lost || !m.mine)) paintTag(o, P.x, box.y, takenText(m.to, m.turn), { zoom: z, tone: 'plain', place: 'above', gap: 4, size: 12, alpha: at.words, anchor, pass });
        }
        if (at.number !== null && !still) {
          const text = m.lost ? lossText() : gainText(), y0 = head - (36 + lines * 26) / z;
          // (the number and its way up stay in the part of the picture the HUD leaves free, as every tag of the board
          // does: on the film's frame, 1280 × 720, with the keep in the middle of the picture, 「+1 province」 rose under
          // the top bar and the turn dial and only its last letters were seen; the local test chain, 2026-10-11. Where
          // its own place over the lines is not free it rises beside the fortress, level with the standard — to the
          // right, else to the left —, never over the standard that is being raised or over the lines)
          let nx = P.x, ny = y0;
          if (pass) {
            const w = text.length * BIG.size * 0.58 / z, col = (x, y) => ({ x: x - w / 2, y: y - (BIG.travel + BIG.size * 0.65) / z, w, h: (BIG.travel + BIG.size * 1.15) / z });
            const still0 = mv => !!mv && Math.abs(mv.dx) < 0.01 && Math.abs(mv.dy) < 0.01;
            if (!still0(pass.place(P.x, P.y, col(nx, ny), { solid: false, reach: 0.5 }))) {
              const beside = sgn => { const x = P.x + sgn * ((sgn > 0 ? FORTRESS.box.right : FORTRESS.box.left) * P.u * 0.8 + w / 2 + 10 / z), y = head + (BIG.travel + BIG.size) / z; return still0(pass.place(P.x, P.y, col(x, y), { solid: false, free: true, reach: 0.5 })) ? { x, y } : null; };
              const side = beside(1) ?? beside(-1);
              if (side) { nx = side.x; ny = side.y; }
              else { const mv = pass.place(P.x, P.y, col(nx, ny), { keep: true, hud: true, free: true, solid: false, reach: BIG.reach }); nx += mv?.dx ?? 0; ny += mv?.dy ?? 0; }
            }
          }
          upright(o, P.x, P.y, () => paintBigNumber(o, nx, ny, text, at.number, { zoom: z, colour, size: BIG.size, travel: -BIG.travel }));
        }
        F.rolling = true;
      }
      // a keep in reach says when the host would arrive; a dim one answers a tap with the reason (the answer stays its
      // few seconds whatever the tap did to the hand)
      const it = this.lit?.get(key) ?? null, n = this.note && this.note.key === key ? this.note : null;
      if (cap || hid({ q: P.q, r: P.r })) continue;
      if (n) {
        const age = fx - n.at;
        if (age >= KEEP_NOTE_MS) this.note = null;
        else { paintTag(o, P.x, head, n.text, { zoom: z, tone: 'refuse', place: 'above', gap: 6, size: 12.5, alpha: clamp01((KEEP_NOTE_MS - age) / 400), shake: still ? 0 : Math.sin(age / 28) * 5 * Math.exp(-age / 150), anchor, pass }); F.live = true; }
      } else if (it?.reachable && Number.isInteger(it.arriveTurn) && !c) paintTag(o, P.x, head, reachTurnText(it.arriveTurn), { zoom: z, tone: 'you', place: 'above', gap: 6, size: 12.5, anchor, pass });
    }
  }

  // ---- from afar: the keep as a small fortress at the middle distance and a mark on the world chart, a capture's flood over the province
  far(g, F) {
    if (!g?.save) return;
    const { z, fx, still, lod } = F, me = this.viewer, dpr = F.dpr ?? 1;
    for (const row of this.visible(F)) {
      const key = row.key, P = this.place(row, z), cap = this.capturing(key, fx), geo = provinceGeo(row.p, row.q);
      if (!P) continue;
      // a capture seen from afar: the new holder's colour opens from the keep over the whole province
      if (cap && geo.fill) {
        const { c, at } = cap, col = NATION_LAND[c.to] ?? FACTION_COLORS[c.to], R = PROVINCE_CIRCUMRADIUS * 2.1;
        const k = clamp01((fx - c.t0 - CAPTURE.floodAt) / CAPTURE.flood), after = fx - c.t0 - CAPTURE.floodAt - CAPTURE.flood;
        const alpha = after <= 0 ? 0.72 : 0.72 * (1 - clamp01(after / CAPTURE.farSettle));
        if (k > 0 && alpha > 0) {
          g.save(); g.clip(geo.fill);
          g.globalAlpha = alpha; g.fillStyle = col; g.beginPath(); g.ellipse?.(P.x, P.y, R * outCubic(k), R * outCubic(k) * FLATTEN * 1.3, 0, 0, Math.PI * 2); g.fill();
          if (k < 1) { g.globalAlpha = 0.9 * (1 - k); g.strokeStyle = '#fffdf2'; g.lineWidth = 4 / z; g.beginPath(); g.ellipse?.(P.x, P.y, R * outCubic(k), R * outCubic(k) * FLATTEN * 1.3, 0, 0, Math.PI * 2); g.stroke(); }
          g.restore();
        }
        if (at.flash > 0) paintFlash(g, P.x, P.y, (26 + 60 * (1 - at.flash)) / z, at.flash, c.to === me ? GOLD : col);
        F.rolling = true;
      }
      const holder = cap ? (cap.at.raise === null ? cap.c.from : cap.c.to) : this.book.shown(key), mine = holder !== null && holder === me;
      const it = this.lit?.get(key) ?? null, dim = it && !it.reachable ? KEEP_LOOK.reach.dim : 1;
      // (while a reach is lit the gold ring on the chart is the keeps in reach alone: the viewer's own keeps are told by their colour)
      if (lod === 'world') paintKeepMark(g, P.x, P.y, { zoom: z, faction: holder, mine: mine && !this.lit, alpha: dim });
      else standing(g, F.up?.(P.x, P.y) ?? null, P.x, P.y, () => {
        paintKeepFortress(g, P.x, P.y, P.u, { faction: holder, mine, zoom: z, dpr, alpha: dim });
        if (nation(holder)) paintStandard(g, P.x + FORTRESS.pole.x * P.u, P.y - FORTRESS.pole.up * P.u, { u: P.u * KEEP_LOOK.standard, zoom: z, faction: holder, now: fx, still, alpha: dim });
      });
      // a keep in reach from afar: a gold ring round its mark
      if (it?.reachable) {
        const beat = still ? 0.5 : 0.5 + 0.5 * Math.sin((fx / 1000) * KEEP_LOOK.reach.beat * Math.PI * 2), r = (lod === 'world' ? 13 : 20) / z * (1 + 0.12 * beat);
        g.save(); g.strokeStyle = KEY; g.lineWidth = 4.6 / z; g.beginPath(); g.arc(P.x, P.y - (lod === 'world' ? 2 / z : P.u * 0.3), r, 0, Math.PI * 2); g.stroke(); g.strokeStyle = GOLD; g.lineWidth = 2.6 / z; g.stroke(); g.restore();
        F.live = true;
      }
      // the contest from afar: a small arc round the mark
      const c = this.book.contests.get(key) ?? null;
      if (c && !cap) {
        const colour = me !== null && c.by === me ? GOLD : FACTION_COLORS[c.by] ?? GOLD, r = (lod === 'world' ? 10 : 15) / z, cy = P.y - (lod === 'world' ? 2 / z : P.u * 0.3);
        g.save(); g.lineCap = 'butt';
        g.strokeStyle = 'rgba(13,24,22,.9)'; g.lineWidth = 5 / z; g.beginPath(); g.arc(P.x, cy, r, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = 'rgba(255,250,240,.28)'; g.lineWidth = 3 / z; g.stroke();
        g.strokeStyle = colour; g.beginPath(); g.arc(P.x, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.03, clamp01(c.held / c.of))); g.stroke();
        g.restore();
      }
      // the capture's number over the chart
      if (cap && cap.at.number !== null && !still) {
        const m = cap.c, colour = m.mine ? GOLD : m.lost ? '#ff8a5a' : FACTION_COLORS[m.to] ?? GOLD;
        paintBigNumber(g, P.x, P.y - 26 / z, m.lost ? lossText() : gainText(), cap.at.number, { zoom: z, colour, size: 30, travel: -40 });
      }
    }
  }
}

/** A flash: a burst of light at (x, y), `k` 1..0. */
function paintFlash(g, x, y, r, k, colour = GOLD) {
  if (!g?.save || !(k > 0) || !(r > 0)) return;
  g.save();
  if (g.createRadialGradient) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,253,242,${0.9 * k * k})`); gr.addColorStop(0.35, hexA(colour, 0.5 * k)); gr.addColorStop(1, hexA(colour, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // rays
  g.globalAlpha = k; g.strokeStyle = '#fffdf2'; g.lineCap = 'round'; g.lineWidth = Math.max(0.6, r * 0.035);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + 0.3, r0 = r * (0.3 + 0.3 * (1 - k)), r1 = r * (0.62 + 0.36 * (1 - k)); g.beginPath(); g.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0); g.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1); g.stroke(); }
  g.restore();
}
const rgbOf = hex => { const n = parseInt(String(hex ?? '#888888').slice(1), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hexA = (hex, a) => { const [r, g, b] = rgbOf(hex); return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`; };
/** A colour on its way to grey (`k` 0..1): a province that is being lost. */
function mixGrey(hex, k) { const [r, g, b] = rgbOf(hex), m = Math.round(0.3 * r + 0.59 * g + 0.11 * b); return `rgb(${[r, g, b].map(v => Math.round(v + (m - v) * clamp01(k))).join(',')})`; }
