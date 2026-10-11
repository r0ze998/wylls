// Sprite-sheet effects: the six effects of the owner's handover pack (Wylls-Claude-Handoff 07, 2026-10-10;
// art/README.md) on the effects layer. The other files of fx/ draw every effect by code; this one plays the pack's
// rendered clips (24 frames a second, 256 px cells in atlases of 8 columns, straight alpha, their ground point at the
// tile's centre and their scale the tile's width) in the map's world space, so they follow pan, zoom and the tilt.
//
//   select          a tile is selected on this page          the outline rises and stays until the selection goes
//   depart          a host left (the records say so)         low dust where it stood: never a road or a heading
//   impact          a contact of a staged battle             a short spark of metal between the lines
//   hit             the side that lost that exchange         a burst at its line (only where its losses are known)
//   build_complete  a building finished (the records)        the brass ring round the village
//   capture         a keep was taken (the capture's record)  the new holder's colour runs round the hexagon
//
// Each hangs on what the page already says on the effects bus (fx/bus.mjs). They follow the records; the one that also
// follows the viewer's own confirmed order is the departure's dust, as the page's own column does:
//
//   moment {kind: 'depart'} and board:left   → depart          (people/moments.mjs: a host seen in state 3; map/fmap.mjs)
//   march:sealed (the viewer's own Depart is confirmed)  → depart, under the column that fx/stage.mjs sets off on the
//                                              same event; the record of that host's leaving, which the herald serves
//                                              up to a turn later, then plays nothing more (SHEET_DEPART_ON_SEAL)
//   moment {kind: 'built'}                   → build_complete  (a construction the page tracked is done)
//   battle {play, focus, zoom}               → impact and hit at the scene's own contacts (people/battle.mjs
//                                              BATTLE_HITS), and the victory pose of the winner's character
//   keep:captured {p, q, from, to, turn, mine, tile?} → capture in the colour of `to` on the keep's tile, and the
//                                              victory pose of the viewer's character when `mine`
//   the page's selection (FS.selected, a tile at the near view) → select
//
// A battle and a capture stay two moments: `battle` never plays the capture, `keep:captured` never plays a blow.
// Only where the handover pack is shown (art/pack.mjs artPackOn: a conquest season); elsewhere this file adds nothing.
// Reduced motion shows a clip's poster frame for a fifth of a second (the selection: its last frame, held); with
// effects off nothing is added (these are decoration: the words and numbers of a moment are other effects').
//
// `?fx=art-…` plays each of them alone under the demo tag (fx/demo.mjs makes the tag for any `?fx=`): see ART_SAMPLES.
import { RADIUS, project, inverseHex } from '../../map.mjs';
import { tileHex } from '../fgeo.mjs';
import { FS } from '../fstate.mjs';
import { keepFromProvince } from '../fconquest.mjs';
import { NATION_KEYS } from '../palette.mjs';
import { artPackOn, forceArtPack } from '../art/pack.mjs';
import { fx as pageFx } from './engine.mjs';
import { bus as pageBus } from './bus.mjs';
import { REDUCED_FADE } from './motion.mjs';
import { stood } from './draw.mjs';
import { PHASE, BATTLE_HITS, battlePlan, battleStage, battleFit, battleVerdict, startBattle } from '../people/battle.mjs';
import { battleFrame } from './battle.mjs';
import { MOTION_LEADERS, cueLeaderMotion } from '../leader-motion-data.mjs';
import { paintMini, MINI_KINDS, preloadMinis } from '../people/minis.mjs';

/** The clips as the pack's clip.json files give them (frames at 24 a second; `poster`: the frame a still shows). */
export const SHEET_CLIPS = Object.freeze({
  select: Object.freeze({ frames: 18, secs: 0.75, poster: 17, hold: true, layer: 'ground' }),
  depart: Object.freeze({ frames: 24, secs: 1, poster: 13, layer: 'top' }),
  impact: Object.freeze({ frames: 12, secs: 0.5, poster: 3, layer: 'top', upright: true }),
  hit: Object.freeze({ frames: 15, secs: 0.625, poster: 6, layer: 'top', upright: true }),
  build_complete: Object.freeze({ frames: 24, secs: 1, poster: 11, layer: 'top' }),
  capture: Object.freeze({ frames: 30, secs: 1.25, poster: 22, nations: true, layer: 'top' }),
});
export const SHEET_FPS = 24;
export const SHEET_COLS = 8;
/** A cell's ground point (the tile's centre) and the tile's width, as shares of the cell (clip.json: [128, 143.5982] and 138.5641 of 256). */
export const SHEET_ANCHOR = Object.freeze([128 / 256, 143.5982 / 256]);
export const SHEET_TILE = 138.5641 / 256;
/** A tile's width in world px (point-up hexagons of RADIUS). */
export const TILE_WIDTH = Math.sqrt(3) * RADIUS;
/** The atlases' cell sizes (px); the larger one from this many device px of a drawn cell. */
export const SHEET_SIZES = Object.freeze([128, 256]);
export const SHEET_2X_FROM = 150;
export const SHEET_PACK = 'first-v1';
/**
 * Whether the dust of the viewer's own departure plays when the sealed Depart is confirmed (`march:sealed`: the event
 * on which fx/stage.mjs sets the column off and the board's character steps out), under the column's feet. The
 * herald's record of that host's leaving (`board:left`, the `depart` moment) comes up to a turn later, when the tile
 * is long empty; with this on it then plays nothing more for that host. `false`: the dust waits for the record alone.
 */
export const SHEET_DEPART_ON_SEAL = true;

const BASE = new URL(`../art/vfx/${SHEET_PACK}/`, import.meta.url);
const nation = f => Number.isInteger(f) && f >= 0 && f < 6;
/** The file of a clip: `capture/<nation key>/atlas-<size>.webp`, the others `…/neutral/…`. */
export const sheetUrl = (effect, size = 256, f = null) => new URL(`${effect}/${SHEET_CLIPS[effect]?.nations ? NATION_KEYS[nation(f) ? f : 0] : 'neutral'}/atlas-${SHEET_SIZES.includes(size) ? size : 256}.webp`, BASE).href;

/** The frame of a clip `age` seconds after its start at a motion level, or null when nothing of it shows. */
export function sheetFrame(effect, age, mode = 'full') {
  const c = SHEET_CLIPS[effect];
  if (!c || mode === 'off' || !(age >= 0)) return null;
  if (mode === 'reduced') return c.hold ? c.frames - 1 : age < REDUCED_FADE ? c.poster : null;
  if (age >= c.secs) return c.hold ? c.frames - 1 : null;
  return Math.min(c.frames - 1, Math.floor(age * SHEET_FPS));
}

// ---- the atlases: asked for the first time a clip is drawn, checked against the layout, kept
const sheets = new Map();
let onArrive = () => {};
function sheet(effect, size, f) {
  const url = sheetUrl(effect, size, f);
  const have = sheets.get(url);
  if (have) return have;
  const c = SHEET_CLIPS[effect], rec = { img: null, ok: false, failed: false };
  if (typeof Image === 'undefined') return rec;   // (no pictures here, a test: nothing is asked for and nothing is remembered)
  sheets.set(url, rec);
  const img = new Image();
  rec.img = img;
  img.onload = () => {
    rec.ok = !img.width || (img.width === size * SHEET_COLS && img.height === size * Math.ceil(c.frames / SHEET_COLS));
    rec.failed = !rec.ok;
    if (rec.ok) onArrive();
  };
  img.onerror = () => { rec.failed = true; };
  img.src = url;
  return rec;
}
/** Start loading the atlases of these effects (the 256 px one, which the play zoom draws; `sizes` for others; a nation's capture when `f` is one). */
export function preloadSheets(effects = Object.keys(SHEET_CLIPS), f = null, sizes = [256]) {
  for (const e of effects) if (SHEET_CLIPS[e] && (!SHEET_CLIPS[e].nations || nation(f))) for (const size of sizes) sheet(e, size, f);
}
/** The atlas to draw a cell `devicePx` wide from: the size it calls for, the other one while that is on its way; null until one is here. */
function pick(effect, devicePx, f) {
  const want = devicePx >= SHEET_2X_FROM ? 256 : 128, other = want === 256 ? 128 : 256;
  const had = size => sheets.get(sheetUrl(effect, size, f)) ?? null;
  // a smaller cell is drawn from the finer atlas when that one has been asked for: nothing more is fetched for it
  if (want === 128 && had(256) && !had(128)) { const r = had(256); if (r.ok) return { img: r.img, size: 256 }; if (!r.failed) return null; }
  const a = sheet(effect, want, f);
  if (a.ok) return { img: a.img, size: want };
  // meanwhile the other size if it is here; it is fetched as a stand-in only when the wanted one failed
  const o = had(other) ?? (a.failed ? sheet(effect, other, f) : null);
  return o?.ok ? { img: o.img, size: other } : null;
}

/**
 * Draw one frame of a clip with its ground point at world (x, y): `{age, f (the nation of a capture), tileWidth
 * (world px the clip's tile spans: a tile of the map by default), mode, alpha, glow (0..1: a blurred halo of the frame
 * under it), gain (0..1: the frame once more as light), dense (the frame drawn this many times: dust that must show on
 * grass), px (device px per world unit, when the context cannot say)}`. The three strengthen a clip without redrawing it.
 * Returns whether it drew (false until an atlas is here, and when the clip is over).
 */
export function paintSheet(ctx, effect, { x, y, age = 0, f = null, tileWidth = TILE_WIDTH, mode = 'full', alpha = 1, gain = 0, glow = 0, dense = 1, px = null } = {}) {
  const frame = sheetFrame(effect, age, mode);
  if (frame === null || !Number.isFinite(x) || !Number.isFinite(y) || !ctx?.drawImage) return false;
  const w = tileWidth / SHEET_TILE;
  const t = ctx.getTransform?.(), scale = Number.isFinite(px) ? px : t && Number.isFinite(t.a) ? Math.hypot(t.a, t.b ?? 0) : 1;
  const got = pick(effect, w * scale, f);
  if (!got) return false;
  const cell = got.size, sx = (frame % SHEET_COLS) * cell, sy = Math.floor(frame / SHEET_COLS) * cell;
  const fade = mode === 'reduced' && !SHEET_CLIPS[effect].hold ? Math.max(0, Math.min(1, (REDUCED_FADE - age) / 0.05)) : 1;
  const a = (Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1) * Math.max(0, Math.min(1, alpha * fade));
  const put = () => ctx.drawImage(got.img, sx, sy, cell, cell, x - w * SHEET_ANCHOR[0], y - w * SHEET_ANCHOR[1], w, w);
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  // a soft halo of the frame's own colour under it (where the context can blur): a thin line carries over painted land
  if (glow > 0 && 'filter' in ctx) {
    ctx.filter = `blur(${Math.max(1.5, Math.min(7, w * scale * 0.014)).toFixed(1)}px)`;
    ctx.globalAlpha = a * Math.min(1, glow); put(); put();
    ctx.filter = 'none';
  }
  ctx.globalAlpha = a; put();
  for (let k = 1; k < dense; k++) put();
  // and the frame once more as light
  if (gain > 0) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a * Math.min(1, gain); put(); }
  ctx.restore();
  return true;
}

const worldOf = at => {
  if (!at) return null;
  if (Number.isFinite(at.x) && Number.isFinite(at.y)) return { x: at.x, y: at.y };
  const h = [at.p, at.q, at.tile].every(Number.isInteger) ? tileHex(at.p, at.q, at.tile) : Number.isInteger(at.q) && Number.isInteger(at.r) && !Number.isInteger(at.p) ? at : null;
  return h ? project(h.q, h.r) : null;
};

/**
 * How each clip is strengthened on the board (paintSheet's glow, gain and dense; `scale`: drawn that much larger). The pack's clips are quiet outlines
 * and small bursts, rendered alone over plain grass; over the painted board, its villages and its territory colours
 * they need to carry, and the owner's standing complaint is that effects were weak. The selection's look is for its
 * rise only (the tile lights up as it is picked); the frame that stays is drawn plain, under the bright ring the map
 * itself keeps on the selected hexagon.
 */
export const SHEET_LOOK = Object.freeze({
  select: Object.freeze({ glow: 0.9, gain: 0.55, dense: 1 }),
  depart: Object.freeze({ glow: 0.5, gain: 0.12, dense: 3, scale: 1.45 }),
  impact: Object.freeze({ glow: 0.6, gain: 0.6, dense: 1 }),
  hit: Object.freeze({ glow: 0.4, gain: 0.35, dense: 1 }),
  build_complete: Object.freeze({ glow: 0.9, gain: 0.5, dense: 1 }),
  capture: Object.freeze({ glow: 1, gain: 0.6, dense: 2 }),
});

/**
 * Play a clip on an engine: `playSheet(fx, 'capture', {p, q, tile | q, r | x, y, f, delay, seed, tileWidth, hold})`.
 * `hold` (the selection): seconds the last frame stays after the rise (default: until cancelled, as a still effect).
 * Returns the handles of what was added (`[]` where the pack is not shown, off stage, or with effects off).
 */
export function playSheet(fx, effect, { delay = 0, seed = null, f = null, tileWidth = TILE_WIDTH, hold = null, look = SHEET_LOOK[effect], at = null, ...where } = {}) {
  const c = SHEET_CLIPS[effect], pos = worldOf(where);
  if (!c || !pos || !fx?.mounted) return [];
  const mode = fx.motionLevel?.() ?? 'full';
  if (mode === 'off') return [];
  if (c.nations && !nation(f)) return [];
  preloadSheets([effect], f);
  // (`scale` of the look: the clip drawn that much larger about its ground point: the dust of a departure spreads past its tile's rim)
  const width = tileWidth * (look?.scale ?? 1);
  const draw = (ctx, age, m) => {
    const go = () => paintSheet(ctx, effect, { ...pos, age, f, tileWidth: width, mode: m, ...(m === 'full' ? look : null) });
    return c.upright ? stood(ctx, pos.x, pos.y, go) : go();
  };
  const id = seed ?? `sheet|${effect}|${Math.round(pos.x)},${Math.round(pos.y)}`;
  const out = [];
  const rise = mode === 'reduced' ? (c.hold ? 0 : REDUCED_FADE) : c.secs;
  const t0 = Number.isFinite(at) ? { at, delay } : { delay };
  if (rise > 0) out.push(fx.add({ name: `sheet-${effect}`, layer: c.layer, dur: rise, seed: id, mode, ...t0, draw: (ctx, s) => draw(ctx, s.t, mode) }));
  // the selection stays on its last frame: a still effect, drawn with every map paint and never keeping the frame loop awake
  if (c.hold) out.push(fx.add({ name: `sheet-${effect}-held`, layer: c.layer, dur: hold > 0 ? hold : 86400, still: true, seed: id, mode, ...(Number.isFinite(at) ? { at, delay: delay + rise } : { delay: delay + rise }), draw: ctx => (c.upright ? stood(ctx, pos.x, pos.y, () => paintSheet(ctx, effect, { ...pos, age: c.secs, f, tileWidth: width, mode })) : paintSheet(ctx, effect, { ...pos, age: c.secs, f, tileWidth: width, mode })) }));
  return out.filter(Boolean);
}

// ---------------------------------------------------------------- a staged battle: the contacts and the winner's pose
/**
 * The cues of a scene's plan (people/battle.mjs battlePlan), in scene seconds: at each contact of each fought tile an
 * `impact` between the lines, and a `hit` on the side that lost that exchange when the records give its losses.
 * These are the scene's own contacts (a presentation of a confirmed battle), not single blows of the record.
 */
export function battleSheetCues(plan) {
  const out = [];
  for (const T of plan?.tiles ?? []) {
    if (!T.fight) continue;
    BATTLE_HITS.forEach((h, j) => {
      out.push({ effect: 'impact', at: h, tile: T.idx, where: 'contact', j });
      const w = T.wins?.[j], loser = w ? T.sides.find(s => s.sgn === -w) : null;
      if (loser && Number.isFinite(loser.loss) && loser.loss > 0) out.push({ effect: 'hit', at: h + 0.02, tile: T.idx, where: loser.sgn < 0 ? 'left' : 'right', j });
    });
  }
  return out;
}
/** The victory pose in a scene: `{faction, at (scene s), secs}` for the nation the fates say holds the tile after a fight, else null (a standoff, a ruin, an unopposed arrival, a camp's win). */
export function battleVictoryCue(scene) {
  const v = battleVerdict(scene);
  if (!['taken', 'cleared', 'held'].includes(v.kind) || !nation(v.winner)) return null;
  return { faction: v.winner, at: PHASE.fates + 0.6, secs: 1.7 };
}
/** A scene figure's height the pack's clips were drawn against (world px of a figure for which the clip's tile is one map tile wide). */
const FIGURE_REF = 46;

/**
 * The sprites of a staged battle, added beside fx/battle.mjs stageBattle's own (same clock, same layout): returns the
 * handles. The scene's time runs as stageBattle's does (`t0 + s.t × speed`); the place of each cue is worked out
 * at the zoom of the frame it is drawn in, as the scene's figures are.
 */
export function playBattleSheets(fx, play, { focus = false, at = null } = {}) {
  const scene = play?.scene;
  if (!scene || !fx?.mounted) return [];
  const mode = fx.motionLevel?.() ?? 'full';
  if (mode !== 'full') return [];
  const plan = battlePlan(scene), cues = battleSheetCues(plan);
  const speed = play.speed > 0 ? play.speed : 1, t0 = plan.residents ? PHASE.deploy : 0, dur = (PHASE.end - t0) / speed;
  const frame = focus ? battleFrame(fx) : null, layout = frame?.layout ?? null;
  const now = Number.isFinite(at) ? at : fx.clock.now();
  const id = `sheet|battle|${scene.p},${scene.q}@${scene.bell}`;
  const out = [];
  if (cues.length) {
    preloadSheets(['impact', 'hit']);
    out.push(fx.add({ name: 'sheet-battle', layer: 'top', dur, seed: id, at: now, draw(ctx, s) {
      const ts = t0 + s.t * speed, fit = battleFit(s.stage?.width ?? s.size.width);
      for (const c of cues) {
        const age = (ts - c.at) / speed;
        if (age < 0 || age >= SHEET_CLIPS[c.effect].secs) continue;
        const T = plan.tiles.find(x => x.idx === c.tile), st = battleStage(T, s.zoom, fit, layout);
        // (a clip's burst sits a little over its ground point: the ground point goes a fifth of a figure up, so the burst is at chest height)
        const lift = st.s * 0.2, p = c.where === 'contact' ? { x: st.cx, y: st.cy - lift } : c.where === 'left' ? { x: st.left.x, y: st.left.y - lift } : { x: st.right.x, y: st.right.y - lift };
        const tileWidth = TILE_WIDTH * (st.s / FIGURE_REF) * (c.effect === 'impact' ? 1.5 : 1.25);
        stood(ctx, p.x, p.y, () => paintSheet(ctx, c.effect, { ...p, age, tileWidth, ...SHEET_LOOK[c.effect] }));
      }
    } }));
  }
  // the winner's character strikes its pose once the last blow has landed (the fates decide who that is)
  const v = battleVictoryCue(scene);
  if (v) {
    const T = plan.tiles.find(x => x.fight) ?? plan.tiles[0], c = T?.c ?? null;
    cueLeaderMotion(MOTION_LEADERS[v.faction].key, 'victory', { at: now + Math.max(0, (v.at - t0) / speed), secs: v.secs / speed, near: c ? { x: c.x, y: c.y, r: RADIUS * 9 } : null });
  }
  return out.filter(Boolean);
}

// ---------------------------------------------------------------- the page's events
const keepTileOf = (p, q) => {
  const keeps = FS.conquest?.keeps, k = keeps instanceof Map ? keeps.get(`${p},${q}`) : keeps?.[`${p},${q}`];
  if (Number.isInteger(k?.tile) && k.tile >= 0 && k.tile < 61) return k.tile;
  const pv = FS.provinces?.get?.(`${p},${q}`)?.province, kp = pv ? keepFromProvince(pv) : null;
  return Number.isInteger(kp?.tile) ? kp.tile : null;
};

/** A keep was taken: the new holder's colour runs round the keep's tile; the viewer's character strikes its pose when the viewer's nation took it. */
export function playCapture(fx, e = {}) {
  if (![e.p, e.q].every(Number.isInteger) || !nation(e.to)) return [];
  const tile = Number.isInteger(e.tile) ? e.tile : keepTileOf(e.p, e.q);
  if (!Number.isInteger(tile)) return [];
  const out = playSheet(fx, 'capture', { p: e.p, q: e.q, tile, f: e.to, seed: `sheet|capture|${e.p},${e.q}@${e.turn ?? ''}`, delay: e.delay ?? 0 });
  if (e.mine && out.length) cueLeaderMotion(MOTION_LEADERS[e.to].key, 'victory', { at: fx.clock.now() + (e.delay ?? 0) + 0.45 });
  return out;
}

let installed = null;
/**
 * Hang the sprites on the bus (once for the page; a test gives its own engine and bus). Every handler asks first
 * whether the pack is shown and the engine mounted, so on the basic game and the sample world nothing is added.
 */
export function installSheetFx(fx = pageFx, { bus = pageBus } = {}) {
  if (fx === pageFx && installed) return installed;
  const offs = [], live = () => fx.mounted && artPackOn();
  const on = (type, fn) => offs.push(bus.on(type, p => { if (live()) fn(p ?? {}); }));
  const recent = new Map();   // "what|where" → clock time: one thing is not played twice
  const once = (key, secs = 8) => { const now = fx.clock.now(); for (const [k, t] of recent) if (now - t > 60) recent.delete(k); if (now - (recent.get(key) ?? -Infinity) < secs) return false; recent.set(key, now); return true; };
  const onMap = at => { const w = worldOf(at); return !!w && fx.onStage(w.x, w.y, 80); };
  const near = () => (fx.map?.drawnLod ?? fx.map?.lod ?? 'tile') === 'tile';

  const sealed = new Set();   // the hosts whose dust rose when their sealed Depart was confirmed: their record plays nothing more
  on('march:sealed', a => {
    const at = a.tile;
    if (!SHEET_DEPART_ON_SEAL || !at || ![at.p, at.q, at.tile].every(Number.isInteger)) return;
    if (a.host) { sealed.add(String(a.host)); if (sealed.size > 200) sealed.delete(sealed.values().next().value); }
    // (the column sets off 0.42 s after the seal comes down: fx/stage.mjs playSealed)
    if (near() && onMap(at) && once(`depart|${at.p},${at.q},${at.tile}`)) playSheet(fx, 'depart', { p: at.p, q: at.q, tile: at.tile, delay: 0.42, seed: `sheet|depart|${a.host ?? a.id ?? ''}` });
  });
  on('moment', m => {
    if (![m.p, m.q, m.tile].every(Number.isInteger) || !near() || !onMap(m)) return;
    if (m.kind === 'depart' && !sealed.has(String(m.id ?? '')) && once(`depart|${m.p},${m.q},${m.tile}`)) playSheet(fx, 'depart', { p: m.p, q: m.q, tile: m.tile, seed: `sheet|depart|${m.id ?? ''}|${m.p},${m.q},${m.tile}` });
    if (m.kind === 'built' && once(`built|${m.p},${m.q},${m.tile}`)) playSheet(fx, 'build_complete', { p: m.p, q: m.q, tile: m.tile, delay: 0.1, tileWidth: TILE_WIDTH * (m.own === false ? 1 : 1.25), seed: `sheet|built|${m.p},${m.q},${m.site ?? m.tile}` });
  });
  // the viewer's own host is on its sealed march (the map's own records): the same dust, once
  on('board:left', a => { if ([a.p, a.q, a.tile].every(Number.isInteger) && !sealed.has(String(a.host ?? '')) && near() && onMap(a) && once(`depart|${a.p},${a.q},${a.tile}`)) playSheet(fx, 'depart', { p: a.p, q: a.q, tile: a.tile, seed: `sheet|depart|${a.host ?? ''}` }); });
  // (added a moment after fx/stage.mjs has staged the scene, at the same clock time, so the sprites are drawn over its figures)
  const scenes = new Map();   // "p,q" → the handles of the sprites of the scene playing there (a scene staged again replaces them)
  on('battle', p => {
    const sc = p.play?.scene;
    if (!sc) return;
    const at = fx.clock.now(), key = `${sc.p},${sc.q}`;
    // (a start the stage has called off — fx/stage.mjs, `battle:ask` — is not played, and what plays there is left alone)
    Promise.resolve().then(() => { if (p.play.off) return; for (const h of scenes.get(key) ?? []) h.cancel?.(); scenes.set(key, live() ? playBattleSheets(fx, p.play, { focus: !!p.focus, at }) : []); });
  });
  on('keep:captured', e => { if (once(`capture|${e.p},${e.q}@${e.turn ?? ''}`, 30)) playCapture(fx, e); });

  // the selection: FS.selected is this page's own input (a tile at the near view). It is compared at every map paint;
  // a change puts the old outline away and raises the new one. A poll that leaves the selection alone restarts nothing.
  let selKey = null, selHandles = [];
  const selNow = () => {
    const s = FS.selected;
    // (a tile is selected when the selection names one: the map's own pick carries no `kind`, a province chosen as a whole no `idx`)
    if (!live() || !s || s.kind === 'province' || ![s.p, s.q, s.idx].every(Number.isInteger) || (FS.view?.lod ?? 'tile') !== 'tile' || FS.compose) return null;
    return `${s.p},${s.q},${s.idx}`;
  };
  const syncSelection = () => {
    const key = selNow();
    if (key === selKey) return;
    selKey = key;
    for (const h of selHandles) h.cancel?.();
    selHandles = [];
    if (key) { const [p, q, tile] = key.split(',').map(Number); selHandles = playSheet(fx, 'select', { p, q, tile, seed: `sheet|select|${key}` }); }
  };
  const offPaint = fx.onPaint?.('ground', () => { Promise.resolve().then(syncSelection); return 0; }) ?? (() => {});
  onArrive = () => { try { fx.kick?.(); fx.map?.tick?.() ?? fx.map?.invalidate?.(); } catch { /* no map */ } };

  const handle = { off() { offs.forEach(f => f()); offPaint(); for (const h of selHandles) h.cancel?.(); if (installed === handle) installed = null; }, syncSelection };
  if (fx === pageFx) installed = handle;
  return handle;
}

// ---------------------------------------------------------------- the demo samples (`?fx=art-…`, under the demo tag)
const ring6 = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
/**
 * The samples: `run(fx, c)` adds what the sample shows at clock 0; `c` = `{at: {q, r} (the demo tile), f (the
 * viewer's nation, 0 without one), nations}`. They are samples: the page's records are not touched.
 */
export const ART_SAMPLES = Object.freeze({
  'art-select': { secs: 2.6, run: (fx, c) => playSheet(fx, 'select', { ...c.at, at: 0, hold: 1.6 }) },
  'art-depart': { secs: 1.6, run: (fx, c) => playSheet(fx, 'depart', { ...c.at, at: 0 }) },
  'art-impact': { secs: 1.2, run: (fx, c) => playSheet(fx, 'impact', { ...c.at, at: 0 }) },
  'art-hit': { secs: 1.2, run: (fx, c) => playSheet(fx, 'hit', { ...c.at, at: 0 }) },
  'art-built': { secs: 1.6, run: (fx, c) => playSheet(fx, 'build_complete', { ...c.at, at: 0, tileWidth: TILE_WIDTH * 1.25 }) },
  'art-capture': { secs: 2, run: (fx, c) => playSheet(fx, 'capture', { ...c.at, at: 0, f: c.f }) },
  // the six colours of the capture on the six tiles round the demo tile
  'art-capture-six': { secs: 2, run: (fx, c) => ring6.flatMap(([dq, dr], f) => playSheet(fx, 'capture', { q: c.at.q + dq, r: c.at.r + dr, at: 0, f })) },
  // the six effects side by side: the selection on the demo tile, the other five round it
  'art-effects': { secs: 2.4, run: (fx, c) => [...playSheet(fx, 'select', { ...c.at, at: 0, hold: 1.4 }), ...['depart', 'impact', 'hit', 'build_complete', 'capture'].flatMap((e, i) => playSheet(fx, e, { q: c.at.q + ring6[i][0], r: c.at.r + ring6[i][1], at: 0, f: c.f }))] },
  // the page's own path for a capture: the bus event the board says for a capture record (here a sample one), the viewer's nation taking the demo tile
  'art-keep': { secs: 3, run: (fx, c) => { const l = c.loc; return l ? playCapture(fx, { p: l.p, q: l.q, tile: l.idx, from: (c.f + 2) % 6, to: c.f, turn: 0, mine: true }) : playSheet(fx, 'capture', { ...c.at, at: 0, f: c.f }); } },
  // the page's own path for a battle: the bus event, so the scene is staged by fx/stage.mjs and the sprites and the winner's pose come from here
  'art-battle': { secs: 7.4, run: (fx, c) => {
    const l = c.loc; if (!l) return [];
    const scene = { p: l.p, q: l.q, bell: 0, tiles: [{ idx: l.idx, hex: c.at, attackers: [{ id: 'a1', faction: c.f, unit: 0, stance: 1, before: 900, after: 760, fate: 'Stays', kind: 'arrival' }, { id: 'a2', faction: c.f, unit: 1, stance: 1, before: 320, after: 290, fate: 'Stays', kind: 'arrival' }],
      defenders: [{ id: 'd1', faction: (c.f + 2) % 6, unit: 3, stance: 0, before: 520, after: 0, fate: 'Destroyed', kind: 'resident' }] }] };
    pageBus.emit('battle', { play: startBattle(scene), focus: false, zoom: null, viewerFaction: c.f });
    return [];
  } },
  // the victory pose alone: every standing character of the viewer's nation on the board strikes it
  'art-victory': { secs: 2.4, run: (fx, c) => { cueLeaderMotion(MOTION_LEADERS[c.f].key, 'victory', { at: 0.3 }); return []; } },
  // the soldiers: the eight kinds of the six nations in rows by the demo tile, standing and then stepping, through THE host painter
  'art-mobs': { secs: 6, run: (fx, c) => {
    for (let f = 0; f < 6; f++) preloadMinis(f);
    const o = project(c.at.q, c.at.r), u = RADIUS * 0.66;
    return [fx.add({ name: 'art-mobs', layer: 'top', dur: 6, at: 0, seed: 'art-mobs', draw(ctx, s) {
      for (let f = 0; f < 6; f++) for (let k = 0; k < 8; k++) {
        const x = o.x + (k - 3.5) * RADIUS * 1.05 + (f % 2) * RADIUS * 0.5, y = o.y + (f + 1.6) * RADIUS * 1.1;   // (below the demo tile: the village there stays in sight)
        const walking = s.t > 2, face = s.t > 4 ? -1 : 1;
        stood(ctx, x, y, () => paintMini(ctx, x, y, u, MINI_KINDS[k], { faction: f, face, walking, step: (s.t * 1.8 + k * 0.13) % 1, own: f === c.f && k === 0 }));
      }
    } })].filter(Boolean);
  } },
});

/** Start the samples the address names (`?fx=art-select,art-capture&fxat=…&fxt=…&fxnation=…`): after fx/demo.mjs has made the tag and reset the clock. */
export function startArtDemo({ fx = pageFx, search = globalThis.location?.search ?? '', win = globalThis } = {}) {
  let q;
  try { q = new URLSearchParams(search); } catch { return null; }
  const names = String(q.get('fx') ?? '').split(',').map(s => s.trim()).filter(n => ART_SAMPLES[n]);
  if (!names.length) return null;
  forceArtPack(true);   // (a sample of the pack shows the pack, on any page: the demo tag says it is a sample)
  const fxat = String(q.get('fxat') ?? '').split(',').map(Number), fxt = q.has('fxt') ? Math.max(0, Number(q.get('fxt')) || 0) : null;
  const fN = Number(q.get('fxnation'));
  const context = () => {
    const map = fx.map;
    let at = null, loc = null;
    if (fxat.length >= 3 && fxat.every(Number.isInteger)) { at = tileHex(fxat[0], fxat[1], fxat[2]); loc = { p: fxat[0], q: fxat[1], idx: fxat[2] }; }
    else if (fxat.length === 2 && fxat.every(Number.isInteger)) at = { q: fxat[0], r: fxat[1] };
    else {
      const own = (() => { try { return (map?.source?.()?.own ?? []).find(o => Number.isInteger(o.tile)); } catch { return null; } })();
      if (own) { at = tileHex(own.p, own.q, own.tile); loc = { p: own.p, q: own.q, idx: own.tile }; }
      else { const v = fx.view(); const [hq, hr] = inverseHex(v.x, v.y).split(',').map(Number); at = { q: hq, r: hr }; }
    }
    const mine = FS.citizen?.faction;
    return { at: { q: at.q, r: at.r }, loc, f: nation(fN) && q.has('fxnation') ? fN : nation(mine) ? mine : 0 };
  };
  const length = Math.max(...names.map(n => ART_SAMPLES[n].secs));
  let handles = [], key = '';
  const spawn = () => {
    for (const h of handles) h.cancel?.();
    const c = context();
    key = `${c.at.q},${c.at.r},${c.f}`;
    handles = names.flatMap(n => ART_SAMPLES[n].run(fx, c) ?? []);
    fx.kick?.();
  };
  const restart = () => { fx.clock.seek(0); spawn(); if (fxt !== null) fx.clock.seek(fxt); else fx.clock.play(); fx.kick?.(); };
  const begin = () => {
    restart();
    win.setInterval?.(() => {
      const c = context();
      if (`${c.at.q},${c.at.r},${c.f}` !== key) { const st = fx.clock.state(); fx.clock.seek(0); spawn(); fx.clock.seek(st.t); if (!st.frozen) fx.clock.play(); return; }
      if (!fx.clock.frozen && fx.clock.now() > length + 0.8) restart();
    }, 200);
  };
  // (fx/demo.mjs is loaded on demand and clears the engine when it starts: these samples begin once its handle exists)
  let tries = 0;
  // (with `&fxcam=` the demo switch places the camera 0.6 s after it starts and clears the engine once more then)
  const wait = () => { if (win.__fx || tries++ > 100) win.setTimeout?.(begin, q.has('fxcam') ? 900 : 30); else win.setTimeout?.(wait, 100); };
  wait();
  return { names, restart };
}

// The page: one import (app.mjs) hangs the sprites on the bus; the samples start only for an address that names one.
if (typeof globalThis.document !== 'undefined') {
  installSheetFx();
  try { if (new URLSearchParams(globalThis.location?.search ?? '').has('fx')) { const wait = () => { if (pageFx.mounted) startArtDemo(); else globalThis.setTimeout?.(wait, 150); }; wait(); } } catch { /* no address */ }
}
