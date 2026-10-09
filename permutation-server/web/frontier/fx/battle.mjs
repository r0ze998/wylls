// The battle as a set piece (UX-DESIGN §8.3). people/battle.mjs paints the
// scene itself (figures, arrows, contact flashes, bars, numbers) as a pure
// function of a time; this file puts it on the page:
//
//   the rest of the map dims around the tile (a spotlight on the top canvas),
//     its labels make way and the HUD's corner pieces step back (`fx.piece`)
//   the scene fills the stage the HUD leaves free (battleLayout) and is drawn
//     above the dim at the display's frame rate, on the effects clock
//   each contact throws sparks and textured dust in both nations' colours,
//     shakes the world layer (never the HUD) and sounds
//   at the verdict a title stands over the scene in the winner's colour,
//     under the top strip and inside the free stage on every size of screen
//   afterwards the tile and its neighbours pulse in that colour; a camp that
//     was destroyed burns down
//   from far away, where figures cannot be read, crossed swords pulse on the
//     tile instead
//
// The scene keeps its 7.0 s (people/battle.mjs PHASE); a faster playback
// speed shortens everything together. Every cue is scheduled once, at the
// start, as a function of the clock, so a frozen or rewound clock (the demo
// switch) shows any frame of it.
//
// Reduced motion: no travel, particles or shake; the field as the fates left
// it is shown at once with the losses and the title. Effects off: the title
// and the two loss numbers only.
import { L, fmtNum } from '../../lang.mjs';
import { RADIUS, FLATTEN } from '../../map.mjs';
import { factionName } from '../fi18n.mjs';
import { PHASE, BATTLE_HITS, HIT_POWER, BATTLE_ABOVE, battlePlan, battleStage, battleFit, battleLayout, battleVerdict, paintBattle, preloadBattle, sideColors, crossedSwords } from '../people/battle.mjs';
import { span, lerp, inQuad, outCubic, outExpo, outBack, envelope } from './ease.mjs';
import { REDUCED_FADE } from './motion.mjs';
import { noise1, hashSeed } from './rand.mjs';
import { TONE, rgba } from './effects.mjs';
import { hexMix } from './draw.mjs';

const TAU = Math.PI * 2;
/** Below this many screen px of hex radius the figures give way to the far view's mark. */
export const BATTLE_FAR_R = 17;
/** The zoom the camera takes when it flies to a battle. */
export const BATTLE_ZOOM = 2.1;
/** The height kept over the scene for the verdict's title (screen px): wide stages, and narrow ones. */
export const TITLE_ROOM = Object.freeze({ wide: 128, narrow: 96 });

/** The dust a nation's line kicks up: earth with its colour in it (never grey). */
export const dustColors = col => (col.fill === NEUTRAL_DUST.of ? NEUTRAL_DUST.colors : [hexMix(col.light, '#e4d3ab', 0.3), hexMix(col.fill, '#d6c296', 0.4), hexMix(col.light, '#f1e6c8', 0.55)]);
/** A camp has no nation's colour: its dust is warm earth (its leather mixed with pale dust read as grey smoke over a dimmed map). */
const NEUTRAL_DUST = Object.freeze({ of: sideColors(-1).fill, colors: Object.freeze(['#dcb27a', '#b98a4a', '#efd9ae']) });
/** What the map asks of a thing that stands on its tilted board (map.standAt), for the scene's figures and numbers; null on a flat one. */
const standOf = () => { const map = globalThis.__wyllsMap; return typeof map?.standAt === 'function' ? (x, y) => map.standAt(x, y) : null; };

/**
 * The stage a focused battle is sized to and where its tile's centre belongs on it (client px): the part of
 * the map the HUD leaves free while a set piece plays (its corner pieces step back: fx.css), with room for
 * the title over the scene and the strength bars under it. Null without a page.
 */
export function battleFrame(fx) {
  const free = fx.free?.();
  const st = free?.stage ?? free?.centre;
  if (!st || !(st.width > 40) || !(st.height > 40)) return null;
  const title = st.width < 520 ? TITLE_ROOM.narrow : TITLE_ROOM.wide;
  const layout = battleLayout(st, { title });
  if (!layout) return null;
  const used = title + layout.above + layout.below;
  // the whole block (title, numbers, figures, bars) in the middle of the stage
  const top = st.top + Math.max(0, (st.height - used) / 2);
  return { stage: st, layout, title, x: (st.left + st.right) / 2, y: top + title + layout.above, titleY: top + title / 2 };
}
/** How dark the rest of the map goes: when the camera was sent there, and when the scene plays where the viewer already looks. */
export const BATTLE_DIM = Object.freeze({ focus: 0.66, passing: 0.42 });

const defaultTexts = () => ({
  lossText: n => L`−${fmtNum(n)} 兵`,
  numText: n => fmtNum(n),
  // (the same words as fi18n.mjs FATES: one vocabulary for an outcome, UX design 11.13; the page passes that table)
  fateText: f => ({ Stays: L`戦場に残った`, Withdrew: L`隣へ退いた`, Bounced: L`村へ押し戻された`, Retreated: L`撤退した`, Destroyed: L`壊滅した` })[f] ?? null,
  nameText: side => sideName(side),
});

const sideName = side => {
  const g = [...(side?.groups ?? [])].sort((a, b) => b.before - a.before)[0];
  return !g ? '' : g.kind === 'camp' ? L`蛮族の野営地` : factionName(g.faction);
};

/**
 * The title of a clash for this viewer: `{title, sub, color, tone, won}` or
 * null when there is nothing to announce (nobody stood against the arrivals,
 * both sides remain, or the outcome is not known yet). The words follow the
 * fates of the record; `viewerFaction` only chooses whose words they are.
 */
export function verdictTitle(scene, viewerFaction = null) {
  const v = battleVerdict(scene);
  if (!['taken', 'cleared', 'held', 'ruin'].includes(v.kind)) return null;
  const plan = battlePlan(scene);
  const T = plan.tiles.find(x => x.idx === v.tile) ?? plan.tiles[0];
  const [A, D] = T.sides;
  const inA = viewerFaction !== null && A.groups.some(g => g.faction === viewerFaction);
  const inD = viewerFaction !== null && D.groups.some(g => g.faction === viewerFaction);
  const mine = inA && !inD ? 'attackers' : inD && !inA ? 'defenders' : null;
  const sub = L`${sideName(A)} 対 ${sideName(D)}`;
  const color = v.winner !== null ? sideColors(v.winner).fill : TONE.brass;
  if (v.kind === 'ruin') return { title: L`共倒れ`, sub, color: TONE.brass, tone: 'loss', won: false, verdict: v };
  if (mine && mine === v.side) return { title: v.kind === 'cleared' ? L`野営地を制圧` : v.kind === 'held' ? L`撃退` : L`勝利`, sub, color, tone: 'win', won: true, verdict: v };
  if (mine) {
    const own = (mine === 'attackers' ? A : D).groups.filter(g => g.faction === viewerFaction);
    // destroyed, when most of what the viewer brought was destroyed (a part that turned back unhurt does not soften the word)
    const all = own.reduce((n, g) => n + g.before, 0), gone = own.filter(g => g.fate === 'Destroyed' || g.after === 0).reduce((n, g) => n + g.before, 0);
    const fell = all > 0 && gone * 2 >= all;
    return { title: fell ? L`壊滅` : mine === 'attackers' ? L`撤退` : L`敗北`, sub, color, tone: 'loss', won: false, verdict: v };
  }
  const name = v.winner !== null ? factionName(v.winner) : '';
  return { title: v.kind === 'cleared' ? L`野営地を制圧` : v.kind === 'held' ? L`${name}が守り切った` : L`${name}の勝利`, sub, color, tone: 'brass', won: null, verdict: v };
}

/** The spotlight: everything darkens but a soft disc around (x, y). */
function paintDim(ctx, s, x, y, radius, alpha) {
  if (alpha <= 0.004) return;
  const hw = s.size.width / 2 / s.zoom, hh = s.size.height / 2 / s.zoom;
  const g = ctx.createRadialGradient?.(x, y, radius * 0.62, x, y, radius * 1.75);
  if (g?.addColorStop) {
    g.addColorStop(0, rgba('#081210', 0)); g.addColorStop(0.5, rgba('#081210', alpha * 0.72)); g.addColorStop(1, rgba('#081210', alpha));
    ctx.fillStyle = g;
  } else ctx.fillStyle = rgba('#081210', alpha * 0.5);
  ctx.fillRect(s.view.x - hw - 8, s.view.y - hh - 8, hw * 2 + 16, hh * 2 + 16);
}

/** The far view's mark: crossed swords on a dark disc, a ring beating in the two sides' colours at each contact. */
function paintFar(ctx, s, T, ts, win) {
  const x = T.c.x, y = T.c.y, k = s.px;
  const inn = outBack(span(ts, 0.1, 0.5), 2), out = 1 - span(ts, PHASE.end - 0.5, PHASE.end);
  if (inn <= 0 || out <= 0) return;
  const colA = sideColors(T.sides[0].faction).fill, colB = sideColors(T.sides[1].faction ?? -1).fill;
  ctx.save();
  ctx.globalAlpha = out;
  for (let j = 0; j < BATTLE_HITS.length; j++) {
    const u = ts - BATTLE_HITS[j];
    if (u < 0 || u > 0.7) continue;
    const kk = u / 0.7, r = lerp(20, 62 * Math.sqrt(HIT_POWER[j]), outExpo(kk)) * k;
    ctx.strokeStyle = rgba(j % 2 ? colB : colA, (1 - kk) ** 1.5); ctx.lineWidth = lerp(5, 1.2, kk) * k;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = rgba(TONE.white, 0.8 * (1 - span(kk, 0, 0.3))); ctx.lineWidth = 1.5 * k;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
  }
  const beat = 1 + 0.1 * Math.max(0, ...BATTLE_HITS.map(h => { const u = ts - h; return u >= 0 && u < 0.25 ? 1 - u / 0.25 : 0; }));
  const r = 22 * k * inn * beat;
  const after = ts >= PHASE.fates + 0.3 && win ? span(ts, PHASE.fates + 0.3, PHASE.fates + 0.6) : 0;
  ctx.fillStyle = rgba('#0c1614', 0.92); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  // the rim: half and half in the two sides' colours while it is fought, the holder's when it is decided
  ctx.lineWidth = 3 * k;
  ctx.strokeStyle = colA; ctx.beginPath(); ctx.arc(x, y, r, Math.PI / 2, Math.PI * 1.5); ctx.stroke();
  ctx.strokeStyle = colB; ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  if (after > 0) { ctx.strokeStyle = rgba(win, after); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); }
  ctx.strokeStyle = rgba(TONE.brassHi, 0.9); ctx.lineWidth = 1 * k; ctx.beginPath(); ctx.arc(x, y, r + 2.6 * k, 0, TAU); ctx.stroke();
  crossedSwords(ctx, x, y, r * 0.6);
  ctx.restore();
}

// ------------------------------------------------------------------ burn: a camp burns down
/**
 * `{…position (world x, y), size (world px of the fire's width), dur}`: fire
 * takes the tile, stands, and dies down to embers over a scorched mark;
 * smoke climbs for as long as it burns.
 */
export function burn(a, env) {
  const x = a.x, y = a.y, w = a.size ?? RADIUS * 0.9, dur = Math.max(1.2, a.dur ?? 3.2);
  const seed = hashSeed(env.seed);
  if (env.mode !== 'full') {
    return { layer: 'top', dur: 1.2, draw(ctx, s) {
      const o = envelope(s.t, 1.2, REDUCED_FADE, REDUCED_FADE);
      ctx.fillStyle = rgba('#1a120c', 0.5 * o); ctx.beginPath(); ctx.ellipse?.(x, y, w * 0.6, w * 0.6 * FLATTEN * 0.7, 0, 0, TAU); ctx.fill();
    } };
  }
  env.fx.emit('smoke', { x, y, z: w * 0.5, n: 26, seed: `${env.seed}|smoke`, t: env.now + 0.15, radius: w * 0.3, stagger: dur * 0.85, size: 1.5, life: 1.3, power: 1.2 });
  env.fx.emit('ember', { x, y, z: w * 0.3, n: 34, seed: `${env.seed}|ember`, t: env.now + 0.1, radius: w * 0.35, stagger: dur * 0.8, power: 1.5, size: 1.2 });
  env.fx.emit('spark', { x, y, z: w * 0.2, n: 14, seed: `${env.seed}|pop`, t: env.now + 0.05, power: 0.7, up: 1.2, colors: ['#ffd27a', '#ff8a3c', '#fff6dc'] });
  const tongues = Array.from({ length: 11 }, (_, i) => ({ ox: ((i / 10) - 0.5) * w * 0.86, h: 0.6 + 0.6 * ((i * 37) % 10) / 10, f: 2.4 + ((i * 13) % 7) * 0.4, ph: i * 1.7, wd: 0.13 + 0.07 * ((i * 7) % 5) / 4 }));
  /** One tongue: a teardrop that leans as it climbs, round at the foot. */
  const tongue = (ctx, bx, by, wd, hgt, sway) => {
    ctx.beginPath();
    ctx.moveTo(bx - wd, by);
    ctx.bezierCurveTo(bx - wd * 1.25, by - hgt * 0.38, bx - wd * 0.25 + sway * 0.5, by - hgt * 0.62, bx + sway, by - hgt);
    ctx.bezierCurveTo(bx + wd * 0.5 + sway * 0.5, by - hgt * 0.6, bx + wd * 1.25, by - hgt * 0.34, bx + wd, by);
    ctx.quadraticCurveTo(bx, by + wd * 0.7, bx - wd, by);
    ctx.closePath(); ctx.fill();
  };
  return { layer: 'top', dur, draw(ctx, s) {
    const t = s.t;
    const level = outCubic(span(t, 0, 0.3)) * (1 - inQuad(span(t, dur * 0.5, dur * 0.97)));
    // what it leaves: a scorched mark that stays to the end
    const char = ctx.createRadialGradient?.(x, y + w * 0.04, 0, x, y + w * 0.04, w * 0.62);
    const ca = 0.62 * span(t, 0.2, 1.2) * (1 - span(t, dur - 0.4, dur));
    if (char?.addColorStop) { char.addColorStop(0, rgba('#120c07', ca)); char.addColorStop(0.6, rgba('#17100a', ca * 0.7)); char.addColorStop(1, rgba('#17100a', 0)); ctx.fillStyle = char; } else ctx.fillStyle = rgba('#17100a', ca * 0.5);
    ctx.save(); ctx.translate(x, y + w * 0.04); ctx.scale(1, FLATTEN * 0.7); ctx.translate(-x, -(y + w * 0.04));
    ctx.beginPath(); ctx.arc(x, y + w * 0.04, w * 0.62, 0, TAU); ctx.fill(); ctx.restore();
    if (level <= 0.01) return;
    ctx.globalCompositeOperation = 'lighter';
    // the light it throws on the ground and into the air
    const flick = 0.85 + 0.15 * noise1(t * 9, seed & 255);
    const gl = ctx.createRadialGradient?.(x, y, 0, x, y, w * 1.7);
    if (gl?.addColorStop) { gl.addColorStop(0, rgba('#ff9a3c', 0.5 * level * flick)); gl.addColorStop(0.5, rgba('#e2553d', 0.18 * level * flick)); gl.addColorStop(1, rgba('#e2553d', 0)); ctx.fillStyle = gl; ctx.beginPath(); ctx.ellipse?.(x, y, w * 1.7, w * 1.7 * FLATTEN, 0, 0, TAU); ctx.fill(); }
    const halo = ctx.createRadialGradient?.(x, y - w * 0.45, 0, x, y - w * 0.45, w * 0.95);
    if (halo?.addColorStop) { halo.addColorStop(0, rgba('#ffb347', 0.34 * level * flick)); halo.addColorStop(1, rgba('#e2553d', 0)); ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y - w * 0.45, w * 0.95, 0, TAU); ctx.fill(); }
    // two passes: the red and orange body of the fire, then its yellow-white heart, smaller and lower
    for (const pass of [0, 1]) for (const [i, g] of tongues.entries()) {
      if (pass && i % 2) continue;
      const n = 0.55 + 0.45 * noise1(t * g.f + g.ph, i + 3 + pass * 17);
      const edge = 1 - (Math.abs(g.ox) / (w * 0.5)) ** 2 * 0.6;
      const hgt = w * (pass ? 0.72 : 1.35) * g.h * level * n * edge;
      const bx = x + g.ox * (pass ? 0.7 : 1), by = y + w * 0.05 - (1 - edge) * w * 0.05;
      const sway = noise1(t * 3.1 + g.ph, i + 40) * w * 0.16;
      const wd = w * g.wd * (0.8 + 0.3 * n) * (pass ? 0.62 : 1);
      const fill = ctx.createLinearGradient?.(0, by, 0, by - hgt);
      if (fill?.addColorStop) {
        if (pass) { fill.addColorStop(0, rgba('#fffbe6', 0.95 * level)); fill.addColorStop(0.5, rgba('#ffe08a', 0.7 * level)); fill.addColorStop(1, rgba('#ffb347', 0)); }
        else { fill.addColorStop(0, rgba('#ffc45a', 0.75 * level)); fill.addColorStop(0.35, rgba('#ff8a3c', 0.62 * level)); fill.addColorStop(0.75, rgba('#d8432b', 0.34 * level)); fill.addColorStop(1, rgba('#b02a1c', 0)); }
        ctx.fillStyle = fill;
      } else ctx.fillStyle = rgba('#ffb347', 0.4 * level);
      tongue(ctx, bx, by, wd, hgt, sway);
    }
  } };
}

const staged = new Map();   // "p,q" → the handles of the scene playing there

/**
 * Stage a playing scene (`startBattle`'s `{scene, t0, speed}`) on the
 * effects layer. Options: `focus` (the camera was sent there: a deeper
 * dim), `zoom` (the zoom the scene will be watched at; default the view's
 * now), `viewerFaction`, the three text functions, `seed`. Marks the play
 * `staged` so the map's own painter leaves it to this layer. Returns
 * `{cancel()}` or null when there is no mounted engine.
 */
export function stageBattle(fx, play, { focus = false, zoom = null, viewerFaction = null, lossText, fateText, numText, seed = null, mode = null } = {}) {
  const scene = play?.scene;
  if (!scene || !fx?.mounted) return null;
  const texts = { ...defaultTexts(), ...(lossText ? { lossText } : {}), ...(fateText ? { fateText } : {}), ...(numText ? { numText } : {}) };
  const plan = battlePlan(scene);
  const speed = play.speed > 0 ? play.speed : 1;
  const t0 = plan.residents ? PHASE.deploy : 0;
  const dur = (PHASE.end - t0) / speed;
  const at = ts => Math.max(0, (ts - t0) / speed);
  const id = seed ?? `battle|${scene.p},${scene.q}@${scene.bell}`;
  const key = `${scene.p},${scene.q}`;
  staged.get(key)?.cancel();
  const handles = [];
  const keep = h => { if (h) handles.push(...(Array.isArray(h) ? h : [h])); };
  const level = mode ?? fx.motionLevel?.() ?? 'full';
  const fights = plan.tiles.filter(T => T.fight);
  const main = fights[0] ?? plan.tiles[0];
  const title = fights.length ? verdictTitle(scene, viewerFaction) : null;
  const z = zoom ?? fx.view().zoom;
  // a battle the camera is sent to fills the stage the HUD leaves free; one that plays where the viewer already looks keeps to its tile
  const frame = focus ? battleFrame(fx) : null;
  const layout = frame?.layout ?? null;
  // (how wide the map is on screen: under a tilt the effects' canvas is wider than the picture)
  const fit = battleFit(fx.map?.size?.().width ?? fx.size().width);
  const stage = battleStage(main, z, fit, layout);
  play.staged = true;
  preloadBattle(scene);
  // the camera: the tile's centre where the whole block (title, numbers, figures, bars) sits in the middle of the stage
  if (frame && fx.map?.flyTo && level !== 'off') {
    // (a tilted board says itself which view shows a point at a place on screen: map.viewShowing; a flat one is plain arithmetic)
    let to = null;
    try { to = fx.map.viewShowing?.({ x: stage.cx, y: stage.cy }, frame.x, frame.y, z) ?? null; } catch { to = null; }
    if (!to) {
      const sz = fx.size(), o = fx.anchor(0, 0), v = fx.view(), r = { left: o.x - (sz.width / 2 - v.x * v.zoom), top: o.y - (sz.height / 2 - v.y * v.zoom) };
      to = { x: stage.cx - (frame.x - r.left - sz.width / 2) / z, y: stage.cy - (frame.y - r.top - sz.height / 2) / z, zoom: z };
    }
    try { fx.map.flyTo(to, level === 'full' ? 500 : 1, { exact: true }); } catch { /* a map that cannot fly */ }
  }
  // the title stands over the scene: above the loss numbers, inside the free stage (the banner keeps it there)
  const titleY = (s, h) => {
    const c = s.anchor(stage.cx, stage.cy), px = stage.s * s.zoom;
    const above = c.y - BATTLE_ABOVE * px - 36 - h / 2;
    const fr = (frame ? s.free.stage : null) ?? s.free.centre;
    return above - h / 2 >= fr.top ? above : Math.max(above, fr.top + h / 2 + 4);
  };
  // a number keeps on the free part of the screen (people/battle.mjs paintLosses asks)
  const placer = s => (x, y, hw, hh) => { const a = s.anchor(x, y), at = s.free.place(a.x, a.y, hw * 2 * s.zoom, hh * 2 * s.zoom, 4); return at.moved ? s.unanchor(at.x, at.y) : { x, y }; };
  // the map's labels on the fight's tiles make way for as long as it plays; a battle the camera was sent to has the whole
  // stage (every other label goes and the HUD's corner pieces step back), one that plays in passing does not take it
  const tiles = plan.tiles.map(T => `${scene.p},${scene.q},${T.idx}`);

  if (level === 'off') {
    // numbers and the title only; the map's tokens stay as they are
    play.t0 = -1e9;
    for (const T of fights) for (const side of T.sides) if (side.loss) keep(fx.play('label', { x: T.c.x + side.sgn * RADIUS * 1.1, y: T.c.y, text: texts.lossText(side.loss), color: '#ffb7a3', size: 24, lift: 0.9, dur: 3, seed: `${id}|loss|${side.sgn}`, mode: level }));
    if (title) keep(fx.play('banner', { title: title.title, sub: title.sub, color: title.color, tone: title.tone, y: 0, dur: 2.8, seed: `${id}|title`, mode: level }));
    const h = { cancel() { handles.forEach(x => x.cancel?.()); staged.delete(key); } };
    staged.set(key, h);
    return h;
  }

  if (level === 'reduced') {
    // the field as the fates left it, shown at once
    const hold = Math.min(4.2, Math.max(2.4, dur));
    keep(fx.add({ name: 'battle', layer: 'top', dur: hold, seed: id, mode: level, info: true, draw(ctx, s) {
      const o = envelope(s.t, hold, REDUCED_FADE, REDUCED_FADE);
      if (fights.length) paintDim(ctx, s, stage.cx, stage.cy, stage.s * (layout ? 3.3 : 2.4), (focus ? BATTLE_DIM.focus : BATTLE_DIM.passing) * o);
      ctx.globalAlpha = o;
      if (s.zoom * RADIUS < BATTLE_FAR_R) { for (const T of plan.tiles) if (T.fight) paintFar(ctx, s, T, PHASE.fates + 1, title?.color ?? null); }
      else paintBattle(ctx, play, { zoom: s.zoom, at: PHASE.fates + 1.5, top: true, fit: battleFit(s.stage?.width ?? s.size.width), layout, place: placer(s), up: standOf(), ...texts });
    } }));
    keep(fx.piece('battle', { dur: hold, tiles, stage: !!frame }));
    if (title) keep(fx.play('banner', { title: title.title, sub: title.sub, color: title.color, tone: title.tone, vy: titleY, room: frame ? 'stage' : null, dur: Math.min(hold, 2.8), seed: `${id}|title`, mode: level }));
    const h = { cancel() { handles.forEach(x => x.cancel?.()); staged.delete(key); } };
    staged.set(key, h);
    return h;
  }

  const now = fx.clock.now();
  const dim = fights.length ? (focus ? BATTLE_DIM.focus : BATTLE_DIM.passing) : 0;
  // 1. the rest of the map dims (first, so everything of the scene is drawn over it)
  if (dim > 0) keep(fx.add({ name: 'battle-dim', layer: 'top', dur, seed: id, draw(ctx, s) {
    if (s.zoom * RADIUS < BATTLE_FAR_R) return;
    const a = outCubic(span(s.t, 0, 0.5 / speed)) * (1 - inQuad(span(s.t, dur - 0.75 / speed, dur)));
    // a breath darker at each contact
    const ts = t0 + s.t * speed;
    let punch = 0;
    for (const h of BATTLE_HITS) { const u = ts - h; if (u >= 0 && u < 0.3) punch = Math.max(punch, 1 - u / 0.3); }
    const st = battleStage(main, s.zoom, battleFit(s.stage?.width ?? s.size.width), layout);
    paintDim(ctx, s, st.cx, st.cy - st.s * 0.2, st.s * (layout ? 3.3 : 2.7), Math.min(0.85, dim * a * (1 + 0.12 * punch)));
  } }));
  keep(fx.piece('battle', { dur, tiles, stage: !!frame }));
  // 2. the scene itself
  keep(fx.add({ name: 'battle', layer: 'top', dur, seed: id, draw(ctx, s) {
    const ts = t0 + s.t * speed;
    if (s.zoom * RADIUS < BATTLE_FAR_R) { for (const T of plan.tiles) if (T.fight) paintFar(ctx, s, T, ts, title?.color ?? null); return; }
    paintBattle(ctx, play, { zoom: s.zoom, at: ts, top: true, fit: battleFit(s.stage?.width ?? s.size.width), layout, place: placer(s), up: standOf(), ...texts });
  } }));
  // 3. every contact: sparks in both colours, dust at both lines, the shake, the sound
  for (const T of fights) {
    const st = battleStage(T, z, fit, layout), s = st.s;
    const colA = sideColors(T.sides[0].faction), colB = sideColors(T.sides[1].faction);
    const dustA = dustColors(colA), dustB = dustColors(colB);
    BATTLE_HITS.forEach((h, j) => {
      const p = HIT_POWER[j], t = now + at(h), sd = `${id}|${T.idx}|${j}`, last = j === BATTLE_HITS.length - 1;
      fx.emit('spark', { x: st.cx, y: st.feet.y, z: s * 0.5, n: Math.round(16 * p), seed: `${sd}|a`, t, power: 0.85 * p, dir: 0, spread: Math.PI * 1.3, life: 1.05, colors: [colA.light, colA.fill, '#fff6dc'] });
      fx.emit('spark', { x: st.cx, y: st.feet.y, z: s * 0.5, n: Math.round(16 * p), seed: `${sd}|b`, t, power: 0.85 * p, dir: Math.PI, spread: Math.PI * 1.3, life: 1.05, colors: [colB.light, colB.fill, '#fff6dc'] });
      fx.emit('spark', { x: st.cx, y: st.feet.y, z: s * 0.5, n: Math.round(8 * p), seed: `${sd}|w`, t: t + 0.02, power: 1.5 * p, size: 0.6, life: 0.55, up: 0.5, colors: ['#fff6dc', '#ffe2a0'] });
      // dust at both lines, each in its own nation's colour: a skirt thrown back along the ground and a little hanging over the line
      for (const [side, dir, colors] of [[st.left, Math.PI, dustA], [st.right, 0, dustB]]) {
        fx.emit('dust', { x: side.x, y: side.y + s * 0.16, n: Math.round(8 * p), seed: `${sd}|d${dir ? 1 : 0}`, t, radius: s * 0.4, power: 0.9 * p * (s / 46), up: 0.35, dir, spread: Math.PI * 1.1, size: s / 40, alpha: 0.85, colors });
        fx.emit('dust', { x: side.x, y: side.y + s * 0.1, n: Math.round(2 * p), seed: `${sd}|h${dir ? 1 : 0}`, t: t + 0.04, radius: s * 0.45, power: 0.3 * p, up: 1.1, size: s / 36, alpha: 0.5, life: 1.2, stagger: 0.12, colors });
      }
      if (last) {
        fx.emit('shard', { x: st.cx, y: st.feet.y, n: 9, seed: sd, t, radius: s * 0.2, power: 0.9, up: 0.8, size: 0.7 });
        fx.emit('ember', { x: st.cx, y: st.feet.y, z: s * 0.4, n: 12, seed: sd, t: t + 0.03, radius: s * 0.3, power: 1.3, stagger: 0.2 });
      }
      fx.shake([3, 4, 5, 7.5][j] ?? 4, [150, 160, 180, 240][j] ?? 160, { seed: sd, delay: at(h) });
      fx.sound('clash', { delay: at(h), seed: sd, level: 0.7 + 0.3 * (p / 1.4) });
      if (last) fx.sound('drum', { delay: at(h) + 0.02, seed: sd, level: 0.8 });
    });
  }
  // 4. the verdict across the map, in the holder's colour
  if (title) {
    keep(fx.play('banner', { title: title.title, sub: title.sub, color: title.color, tone: title.tone, vy: titleY, room: frame ? 'stage' : null, dur: Math.max(1.6, 2.5 / speed), delay: at(PHASE.fates + 0.3), seed: `${id}|title` }));
    if (title.won) fx.sound('shimmer', { delay: at(PHASE.fates + 0.3), seed: id });
    // 5. the aftermath: the tile and the land around it pulse in that colour
    if (title.verdict.winner !== null) {
      keep(fx.play('glow', { q: main.q, r: main.r, radius: 1, color: title.color, hold: 1.5 / speed + 0.3, delay: at(PHASE.fates + 0.75), seed: `${id}|after` }));
      keep(fx.play('ripple', { q: main.q, r: main.r, color: sideColors(title.verdict.winner).light, radius: 2.4, delay: at(PHASE.fates + 0.75), seed: `${id}|after` }));
    }
  }
  // 6. a destroyed camp burns down where it stood
  for (const T of fights) {
    const camp = T.sides[1].groups.find(g => g.kind === 'camp');
    if (!camp || !(camp.fate === 'Destroyed' || camp.after === 0)) continue;
    const st = battleStage(T, z, fit, layout);
    keep(fx.play('burn', { x: st.right.x + st.s * 0.45, y: st.cy + st.s * 0.1, size: st.s * 1.7, dur: 3.3 / speed + 0.4, delay: at(PHASE.fates + 0.12), seed: `${id}|burn|${T.idx}` }));
  }
  const h = { cancel() { handles.forEach(x => x.cancel?.()); staged.delete(key); }, title, dur };
  staged.set(key, h);
  return h;
}
