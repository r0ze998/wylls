// The banner rule's PROTOTYPE on the board: what the map keeps between frames
// and what each of its passes draws (PROTOTYPE-SPEC.md section 7; the rule is
// a design, not in the program). The map (map/fmap.mjs) owns one ProtoBoard
// and hands it the model of proto/board-model.mjs through `map.setProto`;
// with no model nothing here is called and the map draws what it drew before.
//
// Every moment is driven by a record: a moment starts when the model that the
// records gave differs from the one before it (a banner that was not there, a
// banner that is gone, a banner under another nation, a trail that is new),
// never from an order's own answer. What a page finds when it opens is simply
// there: nothing is played for it. A province whose record arrives for the
// first time is simply there too.
//
// Said once on the effects bus, for the HUD (the plate that counts, the list):
//   `proto:land`  {kind: 'raise' | 'dress' | 'taken' | 'pulled' | 'lapsed', key, p, q, slot, nation, from, n (tiles),
//                  mine (the viewer's land grew), wasMine (the viewer's land was lost), pole: {p, q, tile}}
//   `proto:trail` {host, p, q, n, mine}
import { FLATTEN, RADIUS, project } from '../../map.mjs';
import { hexDistance, provinceCentre } from '../fgeo.mjs';
import { landShape } from './ownland.mjs';
import { paintTag } from './actions.mjs';
import { paintBellTag } from './hostmarks.mjs';
import { YOURS, fxNow } from './chart.mjs';
import { standing, upright } from './tilt.mjs';
import { emit as fxEmit } from '../fx/bus.mjs';
import { bannerOfHex, floodOrder, protoLandAt } from '../proto/board-model.mjs';
import { EMBER, GOLD, LOSS, PROTO_LOOK, RAISE, TRAIL, bannerUnit, landColour, lossAt, lossMs, lossSettledAt, paintBanner, paintBannerPip, paintBigNumber, paintBud, paintClose, paintDrainTile, paintFloodTile, paintFlower, paintFootprints, paintHatch,
  paintLandTile, paintLineLost, paintPatch, paintProvinceGauge, paintPulseRing, paintRefusalGlyph, paintRefusedTile, paintRiseEdges, paintThreatGround, paintTileFlash, paintTrailBand, paintTurnDial, patchShape, raiseAt, raiseCloseAt, raiseMs, strokeGold, trailAt } from './protoland.mjs';
import { NATION_FILL } from '../palette.mjs';
import { PROTO_WORDS, refusalGlyph, refusalWords, tagged } from './protowords.mjs';

/**
 * Where a banner's pole stands on its tile (world px from the tile's centre): about a third of a tile to the upper
 * left, clear of the host that stands on the tile, of the character that leads it and of its pill (the village's
 * standard stands to the right of its village). It stood beside the host's feet, behind the character's picture.
 */
export const POLE_AT = Object.freeze({ x: -RADIUS * 0.8, y: -RADIUS * 0.42 });
/** How long a dial's number stays large after its count has changed (ms), and how long the ring opens when a count is done. */
export const DIAL_BUMP_MS = 250, READY_RING_MS = 500;
/** The colour a threat is drawn in: the threatening nation's own cloth (ember for a nation that is not known). A threat in ember was the red nation's own colour. */
const foeColour = f => NATION_FILL[f] ?? EMBER;
const isRaise = m => m.kind === 'raise' || m.kind === 'dress';
/** How wide a line of words is on screen, about (px): wide characters count whole, others six tenths. */
const wordsWide = (text, size) => [...String(text)].reduce((a, ch) => a + (ch.codePointAt(0) > 0x2e7f ? 1 : 0.6), 0) * size + 22;
/** How long the words of a hover stay after the pointer has left (ms), and how long a new banner's state is said. */
export const PROTO_SAY_MS = 4200;
const same = (a, b) => !!a && !!b && a.q === b.q && a.r === b.r;
const poleXY = h => { const c = project(h.q, h.r); return { x: c.x + POLE_AT.x, y: c.y + POLE_AT.y, cx: c.x, cy: c.y }; };

export class ProtoBoard {
  constructor({ tick = () => {}, invalidate = () => {} } = {}) {
    this.tick = tick; this.invalidate = invalidate;
    this.model = null;
    /** The moments that play: key → {kind, key, t0, tiles (in the order they change), pole, nation, from, mine, wasMine, n, calm}. */
    this.moments = new Map();
    /** When each trail was first seen (ms; −∞: the page opened with it), and the trails that have just gone (they fade). */
    this.trailSeen = new Map(); this.trailGone = [];
    this.preview = null;
    /** What each dial last showed and when it changed (key → {left, at}), and when each of the viewer's counts was first seen done (key → ms). */
    this.dials = new Map(); this.readySeen = new Map();
    /** Whether the board says a banner's state under the pointer itself (the page may say it in its own tip instead: then false). */
    this.words = true;
    this.landMemo = null;
  }
  get on() { return !!this.model?.on; }

  /** A new model from the records (or null: the prototype is off). `now`: the effects clock (ms); `still`: reduced motion. */
  set(model, { now = fxNow(), still = false } = {}) {
    const prev = this.model;
    if (!model?.on) {
      if (!prev) return false;
      this.model = null; this.moments.clear(); this.trailSeen.clear(); this.trailGone = []; this.preview = null; this.landMemo = null; this.dials.clear(); this.readySeen.clear();
      this.invalidate();
      return true;
    }
    if (prev && prev.rev === model.rev) { this.model = model; return false; }
    this.model = model; this.landMemo = null;
    this.diff(prev, model, now, still);
    this.invalidate();
    return true;
  }

  /** What changed between two models: the moments, said once (see the head of this file). */
  diff(prev, model, now, still) {
    // (a count of the viewer's that the page opens with done has no ring to open: only one that is seen to finish)
    for (const r of model.rising) if (r.mine && r.dial) { const was = this.readySeen.get(r.key); if (!r.dial.ready) this.readySeen.set(r.key, null); else if (was === undefined) this.readySeen.set(r.key, -Infinity); else if (was === null) this.readySeen.set(r.key, still ? -Infinity : now); }
    for (const k of [...this.readySeen.keys()]) if (!model.rising.some(r => r.key === k)) this.readySeen.delete(k);
    if (!prev) { for (const t of model.trails) this.trailSeen.set(t.key, -Infinity); return; }
    const had = new Set(prev.provinces.map(p => p.key)), has = new Set(model.provinces.map(p => p.key));
    const was = new Map(prev.banners.map(b => [b.key, b])), is = new Map(model.banners.map(b => [b.key, b]));
    // (the record that names what happened to a banner: the newest of its events)
    const said = new Map();
    for (const e of model.events) if (e.key) said.set(e.key, e);
    const start = m => {
      this.moments.set(m.key, { ...m, t0: now, calm: !!still, n: m.tiles.length });
      fxEmit('proto:land', { kind: m.kind, key: m.key, p: m.p, q: m.q, slot: m.slot, nation: m.nation ?? null, from: m.from ?? null, n: m.tiles.length, mine: !!m.mine, wasMine: !!m.wasMine, pole: m.pole ? { p: m.pole.p, q: m.pole.pq, tile: m.pole.idx } : null });
    };
    for (const [key, b] of is) {
      const o = was.get(key), pk = `${b.p},${b.q}`;
      if (!had.has(pk)) continue;
      if (!o) start({ kind: 'raise', key, p: b.p, q: b.q, slot: b.slot, tiles: floodOrder(b.tiles, b.pole), tail: b.pole ? b.tiles.filter(t => hexDistance(t.q, t.r, b.pole.q, b.pole.r) > 1).length : 0, pole: b.pole, nation: b.nation, mine: b.mine, mate: b.mate });
      else if (o.nation !== b.nation || o.mine !== b.mine) start({ kind: 'taken', key, p: b.p, q: b.q, slot: b.slot, tiles: [...b.tiles].sort((x, y) => hexDistance(x.q, x.r, b.pole.q, b.pole.r) - hexDistance(y.q, y.r, b.pole.q, b.pole.r)), pole: b.pole, nation: b.nation, from: o.nation, mine: b.mine, mate: b.mate, wasMine: o.mine, wasMate: o.mate, firm: o.firm });
      else if (b.tiles.length > o.tiles.length) { const add = b.tiles.filter(t => !o.tiles.some(x => same(x, t))); if (add.length) start({ kind: 'dress', key, p: b.p, q: b.q, slot: b.slot, tiles: add, tail: 0, pole: b.pole, nation: b.nation, mine: b.mine, mate: b.mate }); }
    }
    for (const [key, o] of was) {
      if (is.has(key) || !has.has(`${o.p},${o.q}`)) continue;
      const op = said.get(key)?.op;
      // (the far tiles first, the pole's own last: the colour drains toward the pole as it falls)
      // (`byViewer`: the record says a host of the viewer's pulled down another's banner: the board says so at the pole)
      // (`own`: the record is the viewer's own taking down of a banner of the viewer's — no loss, no alarm, no shake;
      // `frayed`: the land was a hatch already, and drains from that, not from a colour it no longer had)
      const ev = said.get(key) ?? null, own = op === 'STRIKE' && o.mine && ev?.by !== null && ev?.by !== undefined && String(ev.by) !== 'keeper';
      start({ kind: op === 'STRIKE' ? 'lapsed' : 'pulled', key, p: o.p, q: o.q, slot: o.slot, tiles: [...o.tiles].sort((x, y) => hexDistance(y.q, y.r, o.pole.q, o.pole.r) - hexDistance(x.q, x.r, o.pole.q, o.pole.r)), pole: o.pole, from: o.nation, wasMine: o.mine, wasMate: o.mate, firm: o.firm,
        byViewer: !o.mine && op === 'PULL' && !!ev?.mine, own, frayed: !!o.frayed });
    }
    const trails = new Map(model.trails.map(t => [t.key, t]));
    for (const t of model.trails) if (!this.trailSeen.has(t.key)) { this.trailSeen.set(t.key, had.has(`${t.p},${t.q}`) ? now : -Infinity); if (had.has(`${t.p},${t.q}`)) fxEmit('proto:trail', { host: t.host, p: t.p, q: t.q, n: t.tiles.length, mine: t.mine }); }
    for (const t of prev.trails) if (!trails.has(t.key)) { this.trailSeen.delete(t.key); if (!still) this.trailGone.push({ trail: t, t0: now }); }
  }

  /** A moment's own time (ms): under reduced motion the pictures are at their end at once and only the words run. */
  at(m, fx) {
    const age = fx - m.t0;
    if (!m.calm) return age;
    if (isRaise(m)) return raiseCloseAt(m.n, { dress: m.kind === 'dress' }) + RAISE.glow + age;
    return lossSettledAt(m.n, m.kind) + age;
  }
  /** Drop the moments that are over. Returns whether any still plays. */
  prune(fx) {
    for (const [key, m] of this.moments) {
      const t = this.at(m, fx), done = isRaise(m) ? t >= raiseMs(m.n, { dress: m.kind === 'dress' }) : t >= lossMs(m.n, m.kind);
      if (done || t < -50) { this.moments.delete(key); this.landMemo = null; }
    }
    this.trailGone = this.trailGone.filter(x => fx - x.t0 < TRAIL.fade && fx >= x.t0);
    return this.moments.size > 0 || this.trailGone.length > 0;
  }
  /** The banners whose land still changes hands on the board (a flood runs, a taking turns the colour): the still ground leaves them to the moment. */
  flooding(fx) {
    const out = [];
    for (const m of this.moments.values()) { const t = this.at(m, fx); if (isRaise(m) ? t < raiseCloseAt(m.n, { dress: m.kind === 'dress' }) : m.kind === 'taken' && t < LOSS.take.flood) out.push(m); }
    return out;
  }
  /** Of those, the banners whose new land is not the viewer's shape yet (the gold line has not closed round it). */
  pending(fx) { return this.flooding(fx).filter(m => isRaise(m) || m.mine); }
  /** What the still ground was painted from: it is painted again when this changes. */
  staticKey(fx, F) { return `${this.model?.rev ?? ''}|${this.flooding(fx).map(m => m.key).join(',')}|${this.riseShown(F) ? 1 : 0}`; }
  /**
   * Whether a moment of the viewer's own has only just begun (`RAISE.hush` ms): other words near it are put away so
   * the moment is read alone. `hex`: only within two tiles of that place; none: anywhere.
   */
  hush(fx, hex = null) {
    for (const m of this.moments.values()) if ((m.mine || m.wasMine) && m.pole && fx - m.t0 < RAISE.hush && fx >= m.t0 && (!hex || hexDistance(hex.q, hex.r, m.pole.q, m.pole.r) <= 2)) return true;
    return false;
  }
  /** How far the board is shaken now (px, signed): a banner of the viewer's taken or pulled down, a banner the viewer took. */
  shakeAt(fx) {
    let px = 0;
    for (const m of this.moments.values()) if (!isRaise(m) && !m.calm && !m.own && (m.wasMine || m.mine)) px += lossAt(this.at(m, fx), m.n, m.kind).shake;
    return Math.abs(px) < 0.05 ? 0 : px;
  }
  /** A dial's count has just changed: 1 falling to 0 over DIAL_BUMP_MS (0 for a dial seen for the first time). */
  bumpOf(key, left, fx, still) {
    const d = this.dials.get(key);
    if (!d) { this.dials.set(key, { left, at: -Infinity }); return 0; }
    if (d.left !== left) { d.left = left; d.at = fx; }
    const k = still ? 0 : 1 - (fx - d.at) / DIAL_BUMP_MS;
    return k > 0 && k <= 1 ? k : 0;
  }
  /** Whether the tiles where a banner can rise are edged: under the land lens, and while a place for a host is being chosen. */
  riseShown(F) { return !!this.model?.canRise.length && ((F.src?.lens ?? 'realm') === 'land' || (F.A?.mode === 'pick' && F.A.kind === 'muster')); }

  /**
   * The viewer's land as the map's own-land painter takes it (map/ownland.mjs): ONE land, the village's land and the
   * viewer's banners' land together, so the band and the gold rail close round their union. While a raise floods, the
   * new tiles are not in it yet. `villages`: the viewer's villages (for the land's key and a provisional rim).
   * Null while the prototype is off or the records show no land of the viewer's.
   */
  mineLands(villages = [], fx = fxNow()) {
    const M = this.model;
    if (!M?.on || !M.mine?.tiles.length) return null;
    const pend = this.pending(fx), sig = `${M.rev}|${pend.map(m => `${m.key}:${m.kind}`).join(',')}|${villages.map(v => `${v.p},${v.q},${v.tile},${v.state ?? ''}`).join(';')}`;
    if (this.landMemo?.sig === sig) return this.landMemo.lands;
    const wait = new Set(pend.flatMap(m => m.tiles.map(t => `${t.q},${t.r}`)));
    const far = Math.max(1, ...M.mine.tiles.map(t => t.d ?? 0)) + 1;
    const tiles = M.mine.tiles.filter(t => !wait.has(`${t.q},${t.r}`)).map(t => ({ q: t.q, r: t.r, d: t.village ? t.d ?? 0 : far }));
    const v0 = villages.find(v => M.mine.tiles.some(t => t.village === `${v.p},${v.q},${v.tile}`)) ?? villages[0] ?? null;
    const lands = tiles.length ? [{ key: v0 ? `${v0.p},${v0.q},${v0.tile}` : 'proto', village: v0, tiles, shape: landShape(tiles), provisional: v0?.state === 1, proto: true }] : [];
    this.landMemo = { sig, lands };
    return lands;
  }
  /** The outer edge of the viewer's whole land as the records give it (made once per model): what the gold line runs along. */
  mineOuter() {
    const M = this.model;
    if (!M?.mine?.tiles.length) return null;
    if (this.edgeMemo?.rev !== M.rev) this.edgeMemo = { rev: M.rev, path: patchShape(M.mine.tiles)?.outer ?? null };
    return this.edgeMemo.path;
  }
  /**
   * Where the counts that matter most stand (world px, the middle of each dial): a threat on a banner of the viewer's,
   * another nation's banner about to rise on the nation's ground. The pointer home keeps off them as it keeps off
   * the viewer's land (on a phone its pill lay on the count of the threat the camera had just flown to).
   */
  alarmSpots(z, tall = 1) {
    const M = this.model, out = [];
    if (!M?.on) return out;
    const u = bannerUnit(z), spot = h => { const p = poleXY(h); out.push({ x: p.x, y: p.y - u * 1.72 * tall - 22 / z }); };
    for (const b of M.banners) if (b.pole && b.mine && b.contested?.dial && !b.contested.byViewer) spot(b.pole);
    for (const r of M.rising) if (r.enemyHere && r.dial) spot(r.at);
    return out;
  }
  /** A path of everything but the viewer's land (for a clip): the watch's dashed rim is drawn only outside the land the gold line holds. */
  outsideMine(box) {
    const M = this.model;
    if (!M?.mine?.tiles.length || typeof Path2D === 'undefined' || !box) return null;
    if (this.outMemo?.rev === M.rev) return this.outMemo.path;
    const S = patchShape(M.mine.tiles);
    let p = null;
    if (S) {
      // (everything: a rectangle far larger than any world this map draws; less the land: the clip is taken even-odd)
      p = new Path2D();
      p.rect(-4e6, -4e6, 8e6, 8e6);
      if (p.addPath) p.addPath(S.fill); else p = null;
    }
    this.outMemo = { rev: M.rev, path: p };
    return p;
  }

  // ------------------------------------------------------------------ on the ground
  /** What does not move: the commons, the fill of every piece of land that is somebody's (the viewer's own under its gold line), other villages' rims, the tiles where a banner can rise. */
  groundStill(g, F) {
    const M = this.model;
    if (!M?.on) return;
    const { z, fx } = F, C = PROTO_LOOK.commons, terrainAt = F.terrainAt ?? null;
    const wait = new Set(this.flooding(fx).map(m => m.key));
    for (const c of M.commons) paintHatch(g, c.tiles, { zoom: z, colour: landColour(c.nation), alpha: c.ours ? C.ours : C.theirs });
    for (const v of M.villages) {
      // (the viewer's own village land: the same colour as its banner land, lighter, and not over the village itself)
      if (v.mine) paintPatch(g, v.tiles.filter(t => !v.centre || !same(t, v.centre)), { zoom: z, nation: v.nation ?? 0, look: { fill: PROTO_LOOK.mine.village, rim: 0 }, terrainAt });
      else paintPatch(g, v.tiles, { zoom: z, nation: v.nation ?? 0, look: { fill: 0, rim: PROTO_LOOK.village.rim, under: 3, alpha: PROTO_LOOK.village.alpha } });
    }
    for (const b of M.banners) {
      if (wait.has(b.key)) continue;
      if (b.mine) {
        // the viewer's own: one colour on any ground (the gilded rim and the gold line come with the land itself); frayed: a hatch
        if (b.frayed) paintHatch(g, b.tiles, { zoom: z, colour: landColour(b.nation), alpha: PROTO_LOOK.frayed.alpha, gap: PROTO_LOOK.frayed.gap, width: PROTO_LOOK.frayed.width, back: true });
        else paintPatch(g, b.tiles, { zoom: z, nation: b.nation, look: { fill: PROTO_LOOK.mine.fill, rim: 0 }, terrainAt });
      } else paintPatch(g, b.tiles, { zoom: z, nation: b.nation ?? 0, look: b.mate ? PROTO_LOOK.mate : PROTO_LOOK.other, frayed: b.frayed, terrainAt });
    }
    if (this.riseShown(F)) paintRiseEdges(g, M.canRise, { zoom: z });
  }
  /** The viewer's land as a set of "q,r" (made once per model). */
  heldSet() {
    const M = this.model;
    if (this.heldMemo?.rev !== M.rev) this.heldMemo = { rev: M.rev, set: new Set((M.mine?.tiles ?? []).map(t => `${t.q},${t.r}`)) };
    return this.heldMemo.set;
  }
  /** How much of the fill a banner's land takes, by whose it is. */
  shareOf(mine, mate) { return mine ? PROTO_LOOK.mine.fill : mate ? PROTO_LOOK.mate.fill : PROTO_LOOK.other.fill; }
  /** What moves on the ground: floods and drains, the gold line drawn or lost, trails, a claim's faint land, a threat's hatch and ring, the flower of a place being chosen. Sets `F.live` / `F.rolling`. */
  groundLive(g, F) {
    const M = this.model;
    if (!M?.on) return;
    const { z, fx, still } = F, terrainAt = F.terrainAt ?? null;
    if (this.prune(fx)) F.rolling = true;
    for (const m of this.moments.values()) {
      const t = this.at(m, fx);
      if (isRaise(m)) {
        const R = raiseAt(t, m.n, m.tail ?? 0, { dress: m.kind === 'dress' }), share = this.shareOf(m.mine, m.mate);
        if (!R.closed) m.tiles.forEach((tile, i) => paintFloodTile(g, tile, { nation: m.nation ?? 0, terrainAt, share, state: R.tile(i), zoom: z }));
        // (the dashed gold line of the claim stays round the land until the whole line is drawn over it: nothing is taken away at the record)
        if (m.mine && !R.closed) strokeGold(g, patchShape(m.tiles)?.outer ?? null, { zoom: z, alpha: 0.9, dash: PROTO_LOOK.flower.dash.map(d => d * ((0.72 + 0.28 * Math.min(1.8, Math.max(0.3, z))) / z)) });
        if (m.mine && R.line !== null) paintClose(g, m.tiles, { zoom: z, line: R.line });
        else if (m.mine && R.closed && R.close < 1) paintClose(g, M.mine.tiles, { zoom: z, close: R.close });
      } else {
        const Ls = lossAt(t, m.n, m.kind), took = m.kind === 'taken';
        // (the old holder's colour leaves; a taker's comes tile by tile from the pole, its front bright)
        if (m.frayed && !took) { const k = 1 - Math.max(0, Math.min(1, t / lossSettledAt(m.n, m.kind))); if (k > 0) paintHatch(g, m.tiles, { zoom: z, colour: landColour(m.from ?? 0), alpha: PROTO_LOOK.frayed.alpha * k, gap: PROTO_LOOK.frayed.gap, width: PROTO_LOOK.frayed.width, back: true }); }
        else if (took ? t < LOSS.take.flood : t < lossSettledAt(m.n, m.kind)) m.tiles.forEach((tile, i) => {
          const left = Ls.tile(i);
          paintDrainTile(g, tile, { nation: m.from ?? 0, terrainAt, share: this.shareOf(m.wasMine, m.wasMate), left, zoom: z });
          if (took && left < 1) paintLandTile(g, tile, { nation: m.nation ?? 0, terrainAt, share: this.shareOf(m.mine, m.mate), k: 1 - left, hot: left > 0 ? left * 0.7 : 0, zoom: z });
        });
        if (took && Ls.flash > 0 && m.pole) paintTileFlash(g, m.pole, Ls.flash);
        if (m.wasMine && Ls.line !== null) paintLineLost(g, m.tiles, { zoom: z, k: Ls.line, how: took ? 'break' : 'back' });
      }
    }
    // trails: each host's own last steps, as ground that will become land
    // (a trail of the viewer's is drawn only where it is not land yet: once its host has raised, the steps are land;
    // another's trail is small and quiet: light yellow and gold are the viewer's alone)
    const held = this.heldSet();
    for (const tr of M.trails) {
      const t0 = this.trailSeen.get(tr.key) ?? -Infinity, age = fx - t0, ink = i => (still || !Number.isFinite(age) ? 1 : trailAt(age, i));
      if (tr.mine) {
        const open = tr.tiles.filter(t => !held.has(`${t.q},${t.r}`));
        if (!open.length) continue;
        const whole = open.length === tr.tiles.length;
        paintTrailBand(g, open, { zoom: z, at: whole ? tr.at : null, nation: tr.nation ?? M.viewer.nation ?? 0, ink: whole ? ink : () => 1 });
        paintFootprints(g, open, { zoom: z, at: whole ? tr.at : null, nation: tr.nation ?? 0, mine: true, ink: whole ? ink : () => 1 });
      } else paintFootprints(g, tr.tiles, { zoom: z, at: tr.at, nation: tr.nation ?? 0, mine: false, ink, alpha: 0.7, scale: 1 });
      if (!still && Number.isFinite(age) && age < tr.tiles.length * TRAIL.tile + TRAIL.pop) F.rolling = true;
    }
    for (const x of this.trailGone) paintFootprints(g, x.trail.tiles, { zoom: z, at: x.trail.at, nation: x.trail.nation ?? 0, mine: x.trail.mine, alpha: 1 - (fx - x.t0) / TRAIL.fade });
    for (const r of M.rising) {
      // a claim in progress of the viewer's own: the land it would take, faint (not owned yet); the count done: a gold ring opens once, and the line is dashed gold
      if (r.mine) {
        paintFlower(g, r.flower.length ? r.flower : [r.at], r.tail, { zoom: z, now: fx, still, faint: true, ready: !!r.dial?.ready, nation: r.nation ?? 0 });
        const seen = this.readySeen.get(r.key), k = Number.isFinite(seen) ? (fx - seen) / READY_RING_MS : null;
        if (k !== null && k >= 0 && k < 1) { paintPulseRing(g, r.at, k, { zoom: z }); F.rolling = true; }
        if (r.dial?.ready) F.live = true;
      // another nation's claim on ground of the viewer's nation: the land at stake under that nation's colour
      } else if (r.enemyHere) {
        paintThreatGround(g, r.flower.length || r.tail.length ? [...r.flower, ...r.tail.filter(t => !r.flower.some(x => same(x, t)))] : [r.at], r.at, { zoom: z, now: fx, still, colour: foeColour(r.nation), fast: (r.dial?.left ?? 99) <= PROTO_LOOK.threat.fastAt });
        F.live = true;
      }
    }
    // a threat on a banner of the viewer's (the threatening nation's colour), and the viewer's own count on another's banner (gold)
    let onMine = false;
    for (const b of M.banners) {
      const c = b.contested;
      if (!c || (!b.mine && !c.byViewer)) continue;
      // (a banner in the middle of its own moment — it is being taken, it has just been taken — wears no threat)
      if (this.moments.has(b.key)) continue;
      paintThreatGround(g, b.tiles, b.pole, { zoom: z, now: fx, still, colour: c.byViewer ? GOLD : foeColour(c.nation), fast: (c.dial?.left ?? 99) <= PROTO_LOOK.threat.fastAt, held: b.mine });
      if (b.mine) onMine = true;
      F.live = true;
    }
    // the gold line of "yours" stays on top and whole: a threat's hatch and outline lie on the land, under the line
    if (onMine) strokeGold(g, this.mineOuter(), { zoom: z });
    const P = this.preview;
    if (P?.at) {
      if (P.ok) {
        const nation = M.viewer.nation ?? 0;
        paintFlower(g, P.tiles.length ? P.tiles : [P.at], P.tail, { zoom: z, now: fx, still, nation });
        if (P.tail.length) { paintTrailBand(g, P.tail, { zoom: z, at: P.at, nation, alpha: 0.9 }); paintFootprints(g, P.tail, { zoom: z, at: P.at, mine: true, alpha: 0.9 }); }
      } else paintRefusedTile(g, P.at, { zoom: z });
      F.live = true;
    }
  }

  // ------------------------------------------------------------------ what stands on the board
  /** The notches of a border banner: for each nation it faces, the side of the pole that looks toward that nation's nearest province. */
  notchesOf(b) {
    if (!b.border.length || !b.pole) return [];
    const at = project(b.pole.q, b.pole.r);
    return b.border.map(n => {
      let best = null;
      for (const pv of this.model.provinces) if (pv.holder === n) { const c = provinceCentre(pv.p, pv.q), w = project(c.q, c.r), d = Math.hypot(w.x - at.x, w.y - at.y); if (!best || d < best.d) best = { d, x: w.x }; }
      return { nation: n, side: best && best.x < at.x ? -1 : 1 };
    });
  }
  /** Over what stands on the land (the tile view): every banner on its pole, a pole rising where a claim runs, a ghost banner where another nation's does. */
  top(g, F) {
    const M = this.model;
    if (!M?.on) return;
    const { z, fx, still } = F, u = bannerUnit(z), soon = PROTO_LOOK.walkSoon;
    const stand = (h, draw) => { const p = poleXY(h); standing(g, F.up?.(p.x, p.y) ?? null, p.x, p.y, () => draw(p)); };
    for (const b of M.banners) {
      if (!b.pole) continue;
      const m = this.moments.get(b.key), t = m ? this.at(m, fx) : 0;
      let lift = 0, alpha = 1, dust = null, sparks = null, pop = 1, cloth = 1;
      if (m?.kind === 'raise') { const R = raiseAt(t, m.n, m.tail ?? 0); if (!R.pole.shown) continue; lift = R.pole.lift; alpha = R.pole.alpha; dust = R.dust; sparks = m.mine ? R.sparks : null; pop = R.pole.pop; }
      // (taken: the old cloth comes down, then the new one is run up — a fifth of a second)
      else if (m?.kind === 'taken') { const c = lossAt(t, m.n, 'taken').cloth; if (c.old > 0) continue; cloth = Math.max(0.05, c.next); }
      const fray = !b.frayed && b.walk.dueIn !== null && b.walk.dueIn <= soon ? 1 - Math.max(0, b.walk.dueIn) / soon : 0;
      stand(b.pole, p => paintBanner(g, p.x, p.y, { u: u * (b.mine ? 1 : 0.9), zoom: z, nation: b.nation ?? 0, mine: b.mine, firm: b.firm, frayed: b.frayed, fray, notches: this.notchesOf(b), now: fx, still, lift, alpha, dust, sparks, pop, cloth }));
      F.live = true;
    }
    for (const m of this.moments.values()) {
      if (!m.pole || isRaise(m)) continue;
      const Ls = lossAt(this.at(m, fx), m.n, m.kind), own = { u: u * (m.wasMine ? 1 : 0.9), zoom: z, nation: m.from ?? 0, mine: !!m.wasMine, firm: m.firm !== false, now: fx, still: true };
      if (m.kind === 'taken') { if (Ls.cloth.old > 0) stand(m.pole, p => paintBanner(g, p.x, p.y, { ...own, cloth: Math.max(0.05, Ls.cloth.old) })); }
      // (pulled down, lapsed: the pole falls faster and faster, dust where it hits, and the fallen flag is soon gone)
      else if (Ls.fall < 1 || Ls.flag > 0) stand(m.pole, p => paintBanner(g, p.x, p.y, { ...own, fall: Ls.fall, dust: Ls.dust, alpha: Ls.fall < 1 ? 1 : Ls.flag }));
    }
    for (const r of M.rising) {
      if (!r.mine && !r.enemyHere) continue;
      const near = (r.dial?.left ?? 99) <= PROTO_LOOK.threat.alarmAt;
      stand(r.at, p => paintBanner(g, p.x, p.y, { u: u * 0.9, zoom: z, nation: r.nation ?? 0, mine: r.mine, firm: false, now: fx, still, ...(r.mine ? { rise: r.dial?.share ?? 0, half: !!r.dial?.ready } : { ghost: true, near, rise: null, cloth: 0.6 + 0.4 * (r.dial?.share ?? 0) }) }));
      F.live = true;
    }
  }

  // ------------------------------------------------------------------ words and dials (upright, over the board)
  /** The words and the dials of the prototype, on the label canvas. `hid(hex)`: a tile whose pile is put away. */
  over(o, F, hid = () => false) {
    const M = this.model;
    if (!M?.on) return;
    const { z, fx, still } = F, pass = F.pass ?? null, u = bannerUnit(z), secs = M.turnSecs, tall = F.up ? 1.12 : 1;
    // a dial over a pole, with one short line above it. The two are placed as one piece: together they slide out from
    // under the HUD (the label pass), so a dial is never left behind the chip that names it, or under the top of a phone
    const dial = (h, D, { key, colour, r = 16, pulse = false, sparks = false, alarm = false, text = '', tone = 'plain', bell = false, size = 12.5, wrap = 0 }) => {
      if (!h || !D || hid(h)) return;
      const p = poleXY(h), y0 = p.y - u * 1.72 * tall - (r + 4) / z, bump = this.bumpOf(key, D.left, fx, still);
      if (bump > 0) F.rolling = true;
      // (`wrap`: a share of the picture's width; words wider than that stand in two lines, as paintTag lays them)
      const room = wrap > 0 && pass?.bounds?.w > 0 ? pass.bounds.w * wrap : 0, wide = text ? wordsWide(text, size) : 0, two = room > 0 && wide > room;
      const tw = text ? (two ? Math.min(wide, room + 18) : wide) / z : 0, th = text ? (two ? Math.min(size, 12) * 2.7 + 8 : size + 10) / z : 0, dw = (2 * r + 8) / z, w = Math.max(tw, dw), top = y0 - dw / 2 - (text ? th + 4 / z : 0);
      const mv = pass?.place?.(p.x, p.y, { x: p.x - w / 2, y: top, w, h: dw + (text ? th + 4 / z : 0) }, { keep: true, hud: alarm }) ?? { dx: 0, dy: 0 };
      const x = p.x + mv.dx, y = y0 + mv.dy;
      upright(o, p.x, p.y, () => paintTurnDial(o, x, y, { zoom: z, share: D.share, left: D.left, total: D.total, colour, r, now: fx, still, pulse, bump, sparks, alarm }));
      if (!text) return;
      if (bell) paintBellTag(o, x, y - (r + 2) / z, text, { zoom: z, place: 'above', gap: 4, accent: colour, anchor: { x: p.x, y: p.y }, size });
      // (the piece has its place already: the tag is given the picture's width alone, for its two lines)
      else paintTag(o, x, y - (r + 2) / z, text, { zoom: z, tone, place: 'above', gap: 4, size, anchor: { x: p.x, y: p.y }, wrap, pass: two ? { bounds: pass.bounds, place: () => ({ dx: 0, dy: 0 }) } : null });
    };
    const hot = h => (F.hover && same(F.hover, h)) || (F.selHex && same(F.selHex, h));
    const alarmAt = PROTO_LOOK.threat.alarmAt;
    for (const b of M.banners) {
      const c = b.contested, D = c?.dial;
      if (c && D && b.mine && !c.byViewer) {
        // (the whole sentence for the banner under the pointer or in hand, in two lines where it is long: on a phone the one line ran off both sides of the screen; else the count alone, and, the count done, what can happen now)
        const full = b.tiles.some(hot), pull = !!c.onlyPull;
        dial(b.pole, D, { key: `th:${b.key}`, colour: foeColour(c.nation), r: 18, pulse: true, sparks: true, alarm: true, wrap: 0.7, tone: D.left <= alarmAt ? 'alarm' : 'refuse', text: full ? tagged(D.left > 0 ? PROTO_WORDS.threat(D.left, secs, pull) : PROTO_WORDS.threatReady(pull)) : D.left > 0 ? PROTO_WORDS.turnsLeft(D.left, secs) : PROTO_WORDS.threatReady(pull) });
      } else if (c && D && c.byViewer) dial(b.pole, D, { key: `tk:${b.key}`, colour: GOLD, tone: 'you', text: D.left > 0 ? PROTO_WORDS.taking(D.left, secs) : PROTO_WORDS.takingReady() });
      // a walk that is due, a frayed banner: said under the viewer's own banner
      if (b.mine && b.pole && !hid(b.pole) && !this.moments.has(b.key)) {
        const due = b.walk.dueIn, text = b.frayed ? PROTO_WORDS.frayed(Math.max(0, b.walk.strikeIn ?? 0)) : due !== null && due <= PROTO_LOOK.walkSoon ? PROTO_WORDS.walkSoon(Math.max(0, due)) : '';
        if (text) { const c0 = project(b.pole.q, b.pole.r); paintTag(o, c0.x, c0.y + RADIUS * FLATTEN * 0.9, text, { zoom: z, tone: 'warn', place: 'below', gap: 3, size: 11.5, anchor: c0, pass, wrap: 0.7 }); }
      }
    }
    // (several hosts of the viewer's counting at once stand close together: each keeps its dial, and the sentence is
    // said for the one under the pointer or in hand — two sentences side by side lay over one another; and for the two
    // seconds of a moment of the viewer's own, the sentences near it are put away: the moment is read alone)
    const many = M.rising.filter(r => r.mine && r.dial).length > 1;
    for (const r of M.rising) {
      const D = r.dial;
      if (!D) continue;
      if (r.mine) dial(r.at, D, { key: `rs:${r.key}`, colour: GOLD, bell: true, text: (many && !hot(r.at)) || this.hush(fx, r.at) ? '' : D.left > 0 ? PROTO_WORDS.rising(D.left, secs) : PROTO_WORDS.risingReady(r.n ?? 0) });
      else if (r.enemyHere) dial(r.at, D, { key: `fo:${r.key}`, colour: foeColour(r.nation), r: 18, pulse: true, sparks: true, alarm: true, wrap: 0.7, tone: D.left <= alarmAt ? 'alarm' : 'warn', text: PROTO_WORDS.enemyRising(r.nation ?? 0, D.left) });
    }
    // the moments' words: the number that leaves the pole, the chip of a raise, what was lost
    for (const m of this.moments.values()) {
      if (!m.pole) continue;
      const t = this.at(m, fx), p = poleXY(m.pole), head = p.y - u * 1.72 * tall;
      if (isRaise(m)) {
        const R = raiseAt(t, m.n, m.tail ?? 0, { dress: m.kind === 'dress' });
        if (!m.mine) continue;
        if (R.number !== null && !m.calm) { upright(o, p.x, p.y, () => paintBigNumber(o, p.x, head + 6 / z, `+${m.n}`, R.number, { zoom: z, size: 30, travel: -RAISE.numberRise })); F.rolling = true; }
        if (R.chip === null) continue;
        const a = Math.min(1, R.chip * 30, (1 - R.chip) * 6), up = (still ? 1 : Math.min(1, R.chip * 12)) * 12 / z;
        paintBellTag(o, p.x, head - up - (R.number !== null && !m.calm ? 30 / z : 0), m.kind === 'dress' ? PROTO_WORDS.dressed(m.n) : PROTO_WORDS.raised(m.n), { zoom: z, place: 'above', gap: 6, accent: GOLD, alpha: a, anchor: { x: p.x, y: p.y }, pass, size: 14 });
      } else {
        const Ls = lossAt(t, m.n, m.kind);
        if (m.wasMine && Ls.number !== null && !m.calm && !m.own) { upright(o, p.x, p.y, () => paintBigNumber(o, p.x, head + 10 / z, `\u2212${m.n}`, Ls.number, { zoom: z, colour: '#ff8a5a', size: 26, travel: LOSS.pull.numberSink })); F.rolling = true; }
        if (Ls.words === null) continue;
        const a = Math.min(1, Ls.words * 60 + (m.kind === 'taken' ? 1 : 0), (1 - Ls.words) * 7);
        const text = m.own ? PROTO_WORDS.struck(m.n) : m.wasMine ? (m.kind === 'taken' ? PROTO_WORDS.taken(m.nation ?? 0) : m.kind === 'lapsed' ? PROTO_WORDS.lapsed(m.n) : PROTO_WORDS.pulled(m.n)) : m.kind === 'taken' && m.mine ? PROTO_WORDS.tookTheirs(m.n) : m.byViewer ? PROTO_WORDS.pulledTheirs() : '';
        const loss = m.wasMine && !m.own;
        if (text) paintTag(o, p.x, head, text, { zoom: z, tone: loss ? 'alarm' : m.own ? 'plain' : 'you', place: 'above', gap: 6, size: loss ? 15 : 13, alpha: a, anchor: { x: p.x, y: p.y }, pass, wrap: 0.7 });
      }
    }
    // where a banner of the viewer's can be widened today: a bud on each such tile (the order itself is the host's action bar's)
    for (const b of M.buds) if (!hid(b) && !this.preview) { const c = project(b.q, b.r); upright(o, c.x, c.y, () => paintBud(o, b, { zoom: z, now: fx, still })); F.live = true; }
    // the place being chosen: what a banner there would bring, or why none can rise (said once, on the tile)
    const P = this.preview;
    if (P?.at && !hid(P.at)) {
      const c = project(P.at.q, P.at.r), top = c.y - RADIUS * FLATTEN * 0.9;
      // (the place of a host whose own count already says what its banner brings: that fact is said once, by the count)
      if (P.ok) { if (!M.rising.some(r => r.mine && r.dial && same(r.at, P.at))) paintTag(o, c.x, top, PROTO_WORDS.gain(P.size, P.waitTurns, secs), { zoom: z, tone: 'you', place: 'above', gap: 5, size: 13.5, anchor: c, pass }); }
      else {
        paintTag(o, c.x, top, P.words, { zoom: z, tone: 'refuse', place: 'above', gap: 5, size: 12, anchor: c, pass, wrap: 0.7 });
        upright(o, c.x, c.y, () => paintRefusalGlyph(o, c.x, c.y, P.glyph, { zoom: z }));
      }
    }
    // a trail of the viewer's, named while it is new and under the pointer (its first clause on the board: the whole sentence is the feed's)
    for (const tr of M.trails) {
      if (!tr.mine || !tr.tiles.length || tr.tiles.every(t => this.heldSet().has(`${t.q},${t.r}`))) continue;
      const age = fx - (this.trailSeen.get(tr.key) ?? -Infinity), under = tr.tiles.some(hot);
      if (!under && !(age < TRAIL.words)) continue;
      const far = tr.tiles[0], c = project(far.q, far.r);
      paintTag(o, c.x, c.y + RADIUS * FLATTEN * 0.8, under ? PROTO_WORDS.trail() : PROTO_WORDS.trailShort(), { zoom: z, tone: 'plain', place: 'below', gap: 3, size: 11.5, alpha: under || still ? 1 : Math.max(0, Math.min(1, (TRAIL.words - age) / 500)), anchor: c, pass, wrap: 0.7 });
    }
    // what the land under the pointer (or the selected tile) is, said at the banner's own top
    // (not while a battle has the stage, nor while something plays within three tiles of the tile — a battle the page stages
    // where it happens puts the label piles of its own tiles away, map.hideLabelsAt —: 「試作 · 国の共有地」 of the selected
    // tile lay over the strength bars of the camp's battle beside it, the English recording of 2026-10-11)
    const stir = h => { if (!h) return false; for (let dq = -3; dq <= 3; dq++) for (let dr = Math.max(-3, -dq - 3); dr <= Math.min(3, -dq + 3); dr++) if (hid({ q: h.q + dq, r: h.r + dr })) return true; return false; };
    if (this.words && !F.A && !P && !F.piece && !stir(F.hover ?? F.selHex ?? null)) {
      const h = F.hover ?? F.selHex ?? null, at = h ? protoLandAt(M, h.q, h.r) : null;
      const line = at ? this.landLine(at) : '';
      if (line && at.kind === 'banner' && !(at.banner.contested && (at.banner.mine || at.banner.contested.byViewer))) {
        const S = patchShape(at.banner.tiles);
        if (S) paintTag(o, S.foot.x, S.foot.y, tagged(line), { zoom: z, tone: at.mine ? 'you' : 'plain', place: 'below', gap: 5, size: 12, anchor: S.foot, pass, wrap: 0.7 });
      } else if (line && F.selHex && same(F.selHex, h)) { const c = project(h.q, h.r); paintTag(o, c.x, c.y + RADIUS * FLATTEN, tagged(line), { zoom: z, tone: 'plain', place: 'below', gap: 20, size: 12, anchor: c, pass, wrap: 0.7 }); }
    }
  }
  /** The one line that names a piece of land under the prototype (`at` = protoLandAt), without the tag. */
  landLine(at) {
    const M = this.model, fall = Number(M?.numbers?.FALL_LOOSE ?? NaN);
    if (!at) return '';
    if (at.kind === 'banner') {
      const b = at.banner;
      if (b.mine) { const first = b.firm ? PROTO_WORDS.yoursFirm(b.walk.every ?? 0) : PROTO_WORDS.yoursLoose(b.walk.every ?? 0); return b.border.length ? `${first} · ${PROTO_WORDS.border(Number.isFinite(fall) ? fall : 0)}` : first; }
      return b.mate ? PROTO_WORDS.mate(null) : PROTO_WORDS.bannerOf(b.nation ?? 0);
    }
    if (at.kind === 'village') return at.mine ? PROTO_WORDS.villageLand(at.village.tiles.length) : PROTO_WORDS.villageOf(at.nation ?? 0);
    if (at.kind === 'commons') return at.ours ? PROTO_WORDS.commonsOurs() : PROTO_WORDS.commonsOf(at.nation ?? 0);
    return '';
  }

  // ------------------------------------------------------------------ from afar
  /** The far views: at the middle distance every banner's land as a patch with a pip on its pole; on the world chart each province outlined in its holder's colour and filled like a gauge. */
  far(g, F) {
    const M = this.model;
    if (!M?.on) return;
    const { z } = F;
    if (F.lod === 'world') { for (const pv of M.provinces) paintProvinceGauge(g, pv, { zoom: z, viewer: M.viewer.nation }); return; }
    for (const b of M.banners) if (!b.mine) paintPatch(g, b.tiles, { zoom: z, nation: b.nation ?? 0, look: b.mate ? PROTO_LOOK.mate : PROTO_LOOK.other, frayed: b.frayed, far: true, terrainAt: F.terrainAt ?? null });
    for (const b of M.banners) if (b.pole) { const c = project(b.pole.q, b.pole.r); paintBannerPip(g, c.x, c.y, { zoom: z, nation: b.nation ?? 0, mine: b.mine, frayed: b.frayed }); }
  }

  // ------------------------------------------------------------------ for the page
  /** The banner that holds hex (q, r): `{p, q, slot, mine, nation}`, or null. */
  bannerAtHex(q, r) { const b = bannerOfHex(this.model, q, r); return b ? { p: b.p, q: b.q, slot: b.slot, mine: b.mine, nation: b.nation } : null; }
  /** The banner `{p, q, slot}` of the model, or null. */
  banner(ref) { return ref ? (this.model?.banners ?? []).find(b => b.p === ref.p && b.q === ref.q && b.slot === ref.slot) ?? null : null; }
  /**
   * Show what a banner raised at a place would bring (the preview route's answer, with the place it was asked for):
   * `{ok: true, tiles: [idx], trail: [idx], size, price, waitTurns, p, q, tile}` or `{ok: false, code, need, p, q,
   * tile}`; null puts it away. `hexOf(p, q, idx)` gives a tile's hex.
   */
  setPreview(answer, hexOf) {
    const was = this.preview;
    if (!answer || !this.on || !Number.isInteger(answer.p) || !Number.isInteger(answer.q) || !Number.isInteger(answer.tile)) { this.preview = null; if (was) this.tick(); return false; }
    const h = i => { const x = hexOf(answer.p, answer.q, Number(i)); return x ? { q: x.q, r: x.r, p: answer.p, pq: answer.q, idx: Number(i) } : null; };
    const at = h(answer.tile);
    this.preview = answer.ok
      ? { ok: true, at, tiles: (answer.tiles ?? []).map(h).filter(Boolean), tail: (answer.trail ?? []).map(h).filter(Boolean), size: Number(answer.size ?? (answer.tiles ?? []).length), price: answer.price ?? null, waitTurns: Number(answer.waitTurns ?? 0) }
      : { ok: false, at, code: String(answer.code ?? ''), words: refusalWords(answer, this.model?.me ?? null), glyph: refusalGlyph(answer) };
    this.tick();
    return true;
  }
}
