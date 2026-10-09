// A player's character on the board (UX design 13.2; owner decisions of
// 2026-10-09, "the six are the players", and of 2026-10-10, "make it larger").
// In normal play:
//
//   the viewer's own   stands beside the viewer's active village: upright on
//                      the tilted board, to the right of the village's
//                      standard, the idle loop, a soft shadow and a gold ring
//                      on the ground at its feet. It is the protagonist of
//                      the picture: about as tall as the town's tower
//   another player's   stands beside that player's village only while that
//                      village is selected (an ivory ring: gold means
//                      "yours"), as large against that village as the
//                      viewer's is against the viewer's own
//   the landing        when the viewer's first village lands, the standard
//                      falls, then the character comes forward to its place
//                      beside it (the walk sheet), then stands
//   the wait           before the first village, while the viewer has joined a
//                      nation: the viewer's own stands beside the nation's
//                      standard in the home wedge, in the spot the map keeps
//                      clear for it (`paintWaitCharacter`; the map calls it
//                      where it paints the standard)
//
// One size. A character has one size in the world wherever it stands on the
// board (`CHARACTER_UNIT`: leader-motion-data.mjs BOARD_CHARACTER_SCALE, 2,
// times the size the owner's package was approved at). Beside a village that
// is not drawn at the hero's scale it is drawn in that village's proportion
// (`villageShare`); beside the standard of the wait view it is as tall against
// that standard as against its village's (`STANDARD_SHARE`); behind a line in
// a battle scene it keeps the same size (people/battle.mjs CHARACTER_STAND).
//
// Where it stands (`characterSpots`, `characterSpot`): a body clear of the
// palisade, the standard's pole, a building's scaffold and the hosts, on open
// ground: the map says which hex is open (no water, wood or mountain, nothing
// built or camped on it), and with no open tile next door the character stands
// on its own village's tile.
//
// This presents real things (a player and that player's village) and invents
// no event: the character never leaves its village, never marches and is no
// unit of the game. The walk is the landing's alone.
//
// How it reaches the board. The page says who stands where
// (`setBoardCharacters`, each frame, from app.mjs peopleSource); the tile
// painter's token pass (map/sprites.mjs: one figure per group, sorted by
// depth, cut behind what stands in front, repainted on the animated layer
// only) asks people/units.mjs `provinceTokens`, which adds one token for each
// character of the province (`characterTokens`); `paintToken` hands such a
// token to `paintCharacter` here. The map gives the token pass two things for
// it: which ground is open, and the hex the character's feet are on (what
// stands in front of THAT hex is in front of it); it draws a character further
// out than it draws the hosts' figures (map/sprites.mjs CHARACTER_FIGURE_MIN_R).
//
// The sheets (art/leaders3d/motion-v1: `sprite`, the owner's 256 px frames, and
// `sprite@2x`, the same clips at 512 px with an eight-frame idle) are chosen
// by the size drawn on the device (people/leader-motion.mjs leaderMotionPick)
// and fetched lazily: the viewer's own nation's idle sheet as soon as the page
// knows the nation (`warmCharacter`, in the set the hero frame of this screen
// calls for, before the opening flight ends), the walk sheet when a landing is
// on its way, another nation's idle sheet when its village is selected. A
// figure comes in over FADE_IN seconds from the first frame its sheet is here,
// so it never pops in. A standing figure breathes (leader-motion-data.mjs
// LEADER_BREATH: the package's idle clip is nearly still). Reduced motion
// (fx/motion.mjs) is a complete mode: the figure is the first frame of its
// idle sheet, it does not walk or breathe, and it is there at once.
import { RADIUS, FLATTEN, project, inverseHex } from '../../map.mjs';
import { tileHex } from '../fgeo.mjs';
import { MOTION_LEADERS, LEADER_MOTIONS, LEADER_SPRITE_ANCHOR, LEADER_FIGURE, BOARD_CHARACTER_SCALE, motionSheetSet } from '../leader-motion-data.mjs';
import { paintLeaderMotion, paintContactShadow, leaderMotionPick, leaderCellWidth, contextScale, leaderBreath, onLeaderMotionLoad } from './leader-motion.mjs';
import { YOURS } from './leader-art.mjs';
import { standing } from '../map/tilt.mjs';
import { VILLAGE } from '../map/village.mjs';
import { HERO, VILLAGE_SCALE, VILLAGE_AT } from '../map/plates.mjs';
import { motion as motionLevel } from '../fx/motion.mjs';
import { on as busOn } from '../fx/bus.mjs';
import { heroZoom } from '../map/opening.mjs';
import { STANDARD_UNIT } from '../map/ownland.mjs';

const clip = key => LEADER_MOTIONS.find(m => m.key === key);
const ok = f => Number.isInteger(f) && f >= 0 && f < 6;
const keyOf = f => MOTION_LEADERS[f].key;
const clamp01 = x => Math.max(0, Math.min(1, x));
const smooth = k => { const x = clamp01(k); return x * x * (3 - 2 * x); };
const fxSecs = () => { try { const t = globalThis.__fxNow?.(); if (Number.isFinite(t)) return t; } catch { /* the page's own time */ } return (globalThis.performance?.now?.() ?? Date.now()) / 1000; };

/** A figure comes in over this many seconds from the first frame its sheet is here (never a pop). */
export const FADE_IN = 0.3;
/**
 * The size rule (the owner's decision of 2026-10-10, "make it larger"): wherever a character stands on the board it
 * has one size in the world, BOARD_CHARACTER_SCALE times the size the package was approved at (leader-motion-data.mjs:
 * the one number; the package's own LEADER_DRAW_SCALE is inside the painter as before). The package's size was
 * measured against a host's token unit at an ordinary zoom (TOKEN_UNIT of a hex radius), so the unit a character is
 * drawn in is `CHARACTER_UNIT` world px. At the hero frame of a 1440 screen the figure is then about as tall as the
 * tower of the viewer's town. Close in, where the map draws the hosts' figures a little larger for the eye (the
 * zoom's boost), a character keeps its size against its village and its standard.
 */
export const CHARACTER_SCALE = BOARD_CHARACTER_SCALE;
/** A host's token unit at an ordinary zoom, in hex radii (map/sprites.mjs: RADIUS × 0.66, times the zoom's boost close in). */
export const TOKEN_UNIT = 0.66;
export const CHARACTER_UNIT = RADIUS * TOKEN_UNIT * CHARACTER_SCALE;
/**
 * A character is as large as the village it stands beside is drawn: the viewer's own village is the hero of the
 * picture, drawn HERO.scale times its art, and the viewer's character is drawn at the full size beside it; another
 * player's village keeps inside its tile (VILLAGE_SCALE), and that player's character is drawn in the same
 * proportion to it (at the full size it stood as tall as that whole village: a giant). `villageShare(own)` is that
 * proportion; where a character stands by no village (the wait, a battle) it is 1.
 */
export const villageShare = own => (own ? 1 : VILLAGE_SCALE / HERO.scale);
/** The unit a character is drawn in (world px) beside a village drawn at `share` of the hero's scale. */
export const characterUnit = (share = 1) => CHARACTER_UNIT * share;
/**
 * A character's body in hex radii, beside a village of `share`: `cell` the side of its sheet's cell as drawn, `up`
 * the head's top above the feet, `down` the toes below them, `half` its reach to either side (leader-motion-data.mjs
 * LEADER_FIGURE, measured on the sheets).
 */
export function characterBody(share = 1) {
  const cell = leaderCellWidth(characterUnit(share)) / RADIUS;
  return { cell, up: LEADER_FIGURE.up * cell, down: LEADER_FIGURE.down * cell, half: LEADER_FIGURE.half * cell };
}
/**
 * Where a character stands by a village of tier `tier` (0 hamlet … 3 stronghold), in hex radii (world px / RADIUS)
 * from the tile's centre (x to the right, y down the board), first choice first; `unit`: a host's token unit in hex
 * radii (it grows close in: the hosts' figures are wider there, and the spots level with them are further out).
 * Chosen from pictures of the hero frame, the selection's frame and the landing, 1440 × 900 and 390 × 844, with the
 * figure at the size of 2026-10-10.
 * A village is a ring of houses inside a palisade (map/village.mjs VILLAGE.ring by tier, times the scale it is drawn
 * at: map/plates.mjs). The character is taller than a house and stands outside the palisade, a body's width clear of it:
 *   own    the viewer's own village is drawn large (HERO) and reaches into the tiles beside it; its standard stands
 *          at its right-hand side (HERO.standard), a building's scaffold at its left (HERO.scaffold), its hosts
 *          before the gate on either side (HERO.hosts), its plate above. The character stands to the right of the
 *          standard's pole, on the ground of the tile next door: the village, its standard, its player. If it
 *          cannot stand there (`characterSpot`), then to the left beyond the scaffold, then level with the hosts
 *          before the gate, outside the right-hand one and outside the left-hand one, and last on the village's own
 *          tile at the foot of the gate road (there, and only there, it stands before the front houses).
 *   other  another village keeps inside its tile, its hosts before it (people/units.mjs SPOTS_HOLDING): the
 *          right-hand side clear of the hosts, the left-hand side, level with the hosts outside them on either
 *          side, and last its own tile's foot.
 * Every spot but the last is on a neighbouring tile; the last is on the village's own.
 */
export const CHARACTER_OUT = Object.freeze({ gap: 0.1, pole: 0.14, scaffold: 0.5, fall: 0.62, host: 0.05, front: 0.08, foot: 0.72 });
/** Where the hosts of a village that is not the viewer's stand furthest out (hex radii; people/units.mjs SPOTS_HOLDING: a test holds the two together). */
export const OTHER_HOSTS = Object.freeze({ x: 0.5, y: 0.75 * FLATTEN * 1.6 });
export function characterSpots(own, tier = 1, unit = TOKEN_UNIT) {
  const t = Math.max(0, Math.min(3, Number.isInteger(tier) ? tier : 1));
  const scale = own ? HERO.scale : VILLAGE_SCALE, cy = (own ? HERO.at.y : VILLAGE_AT.y) / RADIUS;
  const rx = VILLAGE.ring[t] * scale, ry = rx * FLATTEN * 0.8, O = CHARACTER_OUT, B = characterBody(villageShare(own));
  // a host's figure is a token unit wide: the character stands a body clear of the outermost one
  const hostX = own ? Math.max(...HERO.hosts[2].map(([x]) => Math.abs(x))) : OTHER_HOSTS.x, hostY = own ? Math.max(...HERO.hosts[2].map(([, y]) => y)) * FLATTEN * 1.6 : OTHER_HOSTS.y;
  const clearOfHosts = hostX + unit * 0.62 + O.host + B.half;
  const right = Math.max(rx + O.gap + B.half, own ? HERO.standard.x / RADIUS + O.pole + B.half : clearOfHosts);
  const left = Math.max(rx + O.gap + B.half, own ? -HERO.scaffold.x / RADIUS + O.scaffold + B.half : clearOfHosts);
  const y = cy + ry * O.fall, front = hostY + O.front;
  return [[right, y], [-left, y], [clearOfHosts, front], [-clearOfHosts, front], [0.03, O.foot - B.down * 0.5]];
}
/**
 * Whether a character whose feet stand at `p` (world px) would cover a host's figure whose feet stand at `t`
 * (`unit`: a host's token unit in world px; `share`: `villageShare`): the two bodies' boxes, the host's a token unit
 * tall and wide.
 */
export function coversHost(p, t, unit = TOKEN_UNIT * RADIUS, share = 1) {
  const B = characterBody(share), m = unit * 0.12;
  return Math.abs(p.x - t.x) < B.half * RADIUS + unit * 0.5 + m && p.y - B.up * RADIUS < t.y + unit * 0.1 + m && p.y + B.down * RADIUS > t.y - unit * 1.05 - m;
}
/**
 * The landing's walk. The standard drops first (map/ownland.mjs LANDING: it is on the ground about a second after
 * the landing begins); then the character comes forward to its place beside it: from `from` (hex radii from its
 * place: from behind and a little to the left, so that it walks the way its sheet faces, towards the viewer and to
 * the right, and passes behind the standard's cloth, never through the place the standard falls on), beginning
 * `delay` s after the landing begins and arriving `secs` later, at a walking pace for a figure of its size (the walk
 * clip's two steps a second). It is seen from the first step (`fade`). Where the ground it would start from is not
 * open (water, a wood, a mountain: `characterSpot`'s rule), it starts `short` of the way out, on the tile it will
 * stand on; a character whose place is on its village's own tile comes from `home` (from the left, before the gate).
 */
export const LANDING_WALK = Object.freeze({ from: Object.freeze([-0.45, -1.55]), home: Object.freeze([-1.4, 0.3]), short: 0.45, delay: 1.0, secs: 1.3, fade: 0.3 });
/** Where the landing's walk to the place `spot` (`characterSpot`) begins, in hex radii from it (`open`: `characterSpot`'s). */
export function walkFrom(spot, open = null) {
  const W = LANDING_WALK;
  if (spot?.home) return W.home;
  const start = hexAt(spot.x + W.from[0] * RADIUS, spot.y + W.from[1] * RADIUS);
  return !open || open(start.q, start.r) ? W.from : Object.freeze([W.from[0] * W.short, W.from[1] * W.short]);
}

// ------------------------------------------------------------------ who stands where (the page says)
let list = [];
/**
 * The characters on the board now: `[{p, q, tile, faction, own, tier}]` (the village's province and tile, the
 * player's nation, whether it is the viewer's own, the village's tier). The page calls this with what is true now; an empty list clears the board.
 */
export function setBoardCharacters(next) {
  list = (Array.isArray(next) ? next : []).filter(c => c && Number.isInteger(c.p) && Number.isInteger(c.q) && Number.isInteger(c.tile) && ok(c.faction))
    .map(c => ({ p: c.p, q: c.q, tile: c.tile, faction: c.faction, own: !!c.own, pending: !!c.pending, tier: Number.isInteger(c.tier) ? c.tier : 1 }));
  const live = new Set(list.map(idOf));
  for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
  for (const id of waits.keys()) if (!live.has(id)) waits.delete(id);
  for (const c of list) warmCharacter(c.faction, c.pending ? 'walk' : 'idle');
}
export const boardCharacters = () => list;
const idOf = c => `${c.p},${c.q},${c.tile},${c.faction}`;

// ------------------------------------------------------------------ the sheets
let wired = false;
/** A sheet that arrives: one more frame of the animated layer (the map's own tick; nothing where there is no map). Asked for once a page. */
function wire() {
  if (wired) return;
  wired = true;
  onLeaderMotionLoad(() => { try { globalThis.__wyllsMap?.tick?.(); } catch { /* no map on this page */ } });
}
/** Fetch a nation's sheet ahead of its use (`motion`: 'idle' | 'walk'); says whether it is here already. */
export function warmCharacter(faction, motion = 'idle') {
  if (!ok(faction)) return false;
  wire();
  // (reduced motion never walks: the walk sheet is not fetched)
  if (motion === 'walk' && motionLevel() !== 'full') return false;
  // (the set the hero frame of this screen calls for, or a finer one the figure was last drawn from: the page opens
  // on a flight from afar, and a sheet asked for at the size of its first frames would be asked for twice)
  const px = Math.max(drawnPx ?? 0, heroCellPx());
  const idle = !!leaderMotionPick(keyOf(faction), 'idle', px);
  return motion === 'idle' ? idle : !!leaderMotionPick(keyOf(faction), motion, px) && idle;
}
let drawnPx = null;
const noteDrawn = px => { if (px > 0) drawnPx = px; };
/** The device px of a character's cell at the hero frame of this screen (map/opening.mjs heroZoom): what is fetched ahead of the first frame. */
export function heroCellPx(dpr = globalThis.devicePixelRatio || 1) { return leaderCellWidth(CHARACTER_UNIT) * heroZoom(dpr) * dpr; }
/** The set of sheets a character on the board is drawn from at the hero frame of a screen of device pixel ratio `dpr`. */
export const heroSheetSet = dpr => motionSheetSet(heroCellPx(dpr));

// ------------------------------------------------------------------ the landing (the walk begins when the map says the land floods)
const landings = new Map();   // "P,Q,tile" → the effects clock's seconds when that village's landing began
/** A village's landing began (`fx` bus `landing`, said by the map when the colour starts to flood). */
export function noteLanding(key, at = fxSecs()) { if (typeof key === 'string') { if (landings.size > 16) landings.clear(); landings.set(key, at); } }
/** Seconds since the landing of village `key` began, or null when none was seen on this page. */
export const landingAge = (key, now = fxSecs()) => (landings.has(key) ? now - landings.get(key) : null);
try { busOn('landing', p => { if (p && Number.isInteger(p.p) && Number.isInteger(p.q) && Number.isInteger(p.tile)) noteLanding(`${p.p},${p.q},${p.tile}`); }); } catch { /* no bus: nothing walks */ }

/**
 * What a character does `age` seconds after its village's landing began (null: no landing): `{motion, share,
 * looping, walk (1 → 0: how much of the way is still to go), alpha}`. A pure function of the time. After the walk,
 * and with no landing, it stands and breathes on the clock `t`.
 */
export function characterPose(age, t = 0, { full = true } = {}) {
  const idle = clip('idle'), walk = clip('walk'), W = LANDING_WALK;
  if (!full) return { motion: 'idle', share: 0, looping: true, walk: 0, alpha: 1 };
  if (age !== null && age < W.delay + W.secs) {
    const u = age - W.delay;
    if (u < 0) return { motion: 'walk', share: 0, looping: true, walk: 1, alpha: 0 };
    // (an even pace, eased only over the last steps: a walk that slides to a stop reads as skating)
    const k = u / W.secs, go = k < 0.8 ? k * 1.0625 : 0.85 + 0.15 * smooth((k - 0.8) / 0.2);
    return { motion: 'walk', share: u / walk.duration, looping: true, walk: 1 - clamp01(go), alpha: clamp01(u / W.fade) };
  }
  return { motion: 'idle', share: t / idle.duration, looping: true, walk: 0, alpha: 1 };
}

// ------------------------------------------------------------------ tokens (people/units.mjs provinceTokens)
/** The hex a world point stands on: `{q, r}`. */
export function hexAt(x, y) { const [q, r] = String(inverseHex(x, y)).split(',').map(Number); return { q, r }; }
/**
 * The place of a character by a village whose tile's centre is `centre` (world px): the first of its spots
 * (`characterSpots`) at which it covers no host that stands there (`taken`: the hosts' tokens, `[{x, y}]`) and
 * whose ground it can stand on: `open(q, r)` says whether the hex is open ground (grass, plains or hills in the
 * viewer's survey with nothing built or camped on it: map/sprites.mjs; with no such function every hex is open). The
 * last spot is on the village's own tile, where it may always stand: with water, a wood or a mountain on every side
 * the character stands at the foot of its own gate road. Returns `{x, y, hex: {q, r}, home}` (`home`: on its own tile).
 */
export function characterSpot(centre, own, taken = [], tier = 1, { unit = TOKEN_UNIT, open = null } = {}) {
  const spots = characterSpots(own, tier, unit), here = hexAt(centre.x, centre.y);
  const at = ([dx, dy]) => { const x = centre.x + dx * RADIUS, y = centre.y + dy * RADIUS, hex = hexAt(x, y); return { x, y, hex, home: hex.q === here.q && hex.r === here.r }; };
  const clear = p => taken.every(t => !coversHost(p, t, unit * RADIUS, villageShare(own)));
  const ground = p => p.home || !open || !!open(p.hex.q, p.hex.r);
  const all = spots.map(at), last = all[all.length - 1];
  return all.find(p => clear(p) && ground(p)) ?? (ground(last) ? last : all[0]);
}

/**
 * The tokens of the characters that stand in province (p, q): one for each character whose village is drawn there
 * (`villages`: the tiles with a village in this frame; `heroTiles`: the viewer's own, drawn large), none on a tile
 * a battle scene has (`skipTiles`). `tokens`: the hosts' tokens of the province (a character covers none of them);
 * `unit`: a host's token unit in hex radii at this zoom; `open(q, r)`: whether a hex is open ground (`characterSpot`).
 * A token: `{x, y, p, q, tile, hex: {q, r} (where its feet stand: the map cuts it behind what stands in front of
 * THAT hex), faction, kind: 'character', character: {key, own, id, at: village key, home, share: `villageShare`, from: `walkFrom`},
 * hosts: []}`.
 */
export function characterTokens({ p, q, tokens = [], villages = new Set(), heroTiles = null, skipTiles = new Set(), unit = TOKEN_UNIT, open = null } = {}) {
  const out = [];
  for (const c of list) {
    if (c.p !== p || c.q !== q || skipTiles.has(c.tile)) continue;
    const hero = !!heroTiles?.has(c.tile);
    if (!hero && !villages.has(c.tile)) continue;
    const h = tileHex(p, q, c.tile);
    if (!h) continue;
    const centre = project(h.q, h.r);
    const spot = characterSpot(centre, hero, tokens.filter(t => !t.character), c.tier, { unit, open });
    out.push({ x: spot.x, y: spot.y, p, q, tile: c.tile, hex: spot.hex, faction: c.faction, kind: 'character', troops: null, n: 0, status: null, face: 1, alpha: 1, own: false, hosts: [],
      character: { key: keyOf(c.faction), own: c.own, id: idOf(c), at: `${p},${q},${c.tile}`, pending: c.pending, home: spot.home, share: villageShare(hero), from: walkFrom(spot, open) } });
  }
  return out;
}

// ------------------------------------------------------------------ painting
const seen = new Map();   // character id → the clock's seconds of the first frame its sheet was here
const waits = new Map();  // character id → since when it waits for its village's landing to begin
/** A character waits at most this long (s) for a reported landing to begin. */
export const PENDING_MAX = 8;
/**
 * The ring on the ground at a character's feet, `u` the unit the figure is drawn in (`characterUnit`): as wide as
 * the figure's stance. The viewer's own: the ring that says "yours", bright gold with an ivory core on a dark keyline
 * (UX design 13.3). Another player's (`own` false): a thinner ivory ring on the same keyline, the colour of a
 * selection that is not the viewer's (UX design 5.2), so the figure reads on any ground. The line is as heavy as a
 * host's ring would be on a figure of that size's square root: a ring twice as wide is not twice as thick.
 */
export const RING = Object.freeze({ rx: 0.4, ry: 0.5 });
export function paintYoursRing(ctx, x, y, u, alpha = 1, own = true) {
  if (!ctx?.ellipse) return;
  const rx = u * RING.rx, ry = rx * RING.ry, w = u / Math.sqrt(CHARACTER_SCALE);
  ctx.save();
  ctx.globalAlpha *= alpha;
  for (const [k, c] of own ? [[0.11, YOURS.key], [0.066, YOURS.gold], [0.018, YOURS.core]] : [[0.085, YOURS.key], [0.04, '#f4efe0']]) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = c; ctx.lineWidth = w * k; ctx.stroke();
  }
  ctx.restore();
}
/**
 * Paint a character token (people/units.mjs paintToken hands it here): `s` a host's token height at this zoom (the
 * figure is drawn in its own unit, `characterUnit`: it does not grow with the hosts' close in), `t` the wall clock in seconds, `up(x, y)` what the tilt asks of a thing that stands
 * there (null on a flat board). The shadow and the ring lie on the ground; the figure stands on them. Returns
 * whether a figure was drawn (false until its sheet is here: nothing is drawn in its place).
 */
export function paintCharacter(ctx, tok, { s, t = 0, up = null, now = fxSecs(), level = motionLevel() } = {}) {
  const c = tok?.character;
  if (!c || !ctx?.save || !(s > 0)) return false;
  const u = characterUnit(c.share ?? 1);
  const full = level === 'full';
  // (a landing the page has reported and the map has not begun yet: the land is not in its colour, nobody walks yet)
  const age = full ? landingAge(c.at, now) : null;
  if (full && c.pending && age === null) {
    // (never for long: a map that does not say the landing began, a page whose map is elsewhere, shows the figure after PENDING_MAX)
    if (!waits.has(c.id)) waits.set(c.id, now);
    if (now - waits.get(c.id) < PENDING_MAX) return false;
  }
  const pose = characterPose(age, t, { full });
  const px = leaderCellWidth(u) * contextScale(ctx);
  noteDrawn(px); wire();
  if (!leaderMotionPick(c.key, 'idle', px)) return false;
  if (pose.motion === 'walk') leaderMotionPick(c.key, 'walk', px);
  if (!seen.has(c.id)) seen.set(c.id, now);
  const alpha = (full ? clamp01((now - seen.get(c.id)) / FADE_IN) : 1) * pose.alpha * (tok.alpha ?? 1);
  if (alpha <= 0.01) return true;
  const from = c.from ?? LANDING_WALK.from, x = tok.x + from[0] * RADIUS * pose.walk, y = tok.y + from[1] * RADIUS * pose.walk;
  return paintStanding(ctx, x, y, u, { key: c.key, own: c.own, pose, alpha, up, breath: full && pose.motion === 'idle' ? leaderBreath(t) : 0 });
}
/** A character standing at (x, y) in the unit `u`: its shadow and its ring on the ground, the figure upright on them. */
function paintStanding(ctx, x, y, u, { key, own, pose, alpha = 1, up = null, breath = 0 }) {
  paintContactShadow(ctx, x, y, u, alpha);
  paintYoursRing(ctx, x, y, u, alpha, own);
  let drawn = false;
  standing(ctx, up?.(x, y) ?? null, x, y, () => { drawn = paintLeaderMotion(ctx, x, y, u, { leader: key, motion: pose.motion, share: pose.share, looping: pose.looping, face: 1, alpha, own: false, breath }); });
  return drawn;
}

/** How tall a character's figure stands above its feet when it is drawn in the unit `u` (the same length as `u`): LEADER_FIGURE.up of its cell, measured on the files. */
export const characterHeight = u => leaderCellWidth(u) * LEADER_FIGURE.up;
/** The box a character's whole picture needs about its feet, beside a village of `share`: `{cell, ax, ay}` (the cell's side and the feet's place in it, as shares). The map's scratch for a token is that large. */
export const characterCell = (share = 1) => ({ cell: leaderCellWidth(characterUnit(share)), ax: LEADER_SPRITE_ANCHOR[0], ay: LEADER_SPRITE_ANCHOR[1] });

// ------------------------------------------------------------------ the wait for the village (UX design 13.6)
/**
 * The size rule by a standard: in the wait view the board is seen from afar and there are no hosts to measure by,
 * so the character is as tall against the nation's standard as the viewer's character is against the standard of
 * its own village at the hero frame (`STANDARD_SHARE` of the pole, which is 1.5 standard units: map/ownland.mjs).
 * The map keeps a room for it beside the standard (map/waitview.mjs WAIT_SPOT: a test holds the room tall enough).
 */
export const STANDARD_POLE = 1.5;
export const STANDARD_SHARE = characterHeight(CHARACTER_UNIT) / (STANDARD_POLE * STANDARD_UNIT);
/** How far up the room the feet stand, as a share of the figure's unit: the half height of the ring on the ground, so the ring keeps inside the room. */
export const WAIT_LIFT = 0.2;
/** The unit the wait's character is drawn in beside a standard of unit `su` (world px). */
export const waitCharacterUnit = su => (STANDARD_SHARE * STANDARD_POLE * su) / characterHeight(1);
const waitSeen = new Map();   // "wait|nation" → the clock's seconds of the first frame its sheet was here
/**
 * The viewer's own character in the wait for the village: it stands in the spot the map keeps clear beside the
 * nation's standard (map/waitview.mjs `waitSpotAt`: `{x, y, box}` in world px; the map calls this where it paints the
 * standard, with `up(x, y)`: what the tilt asks of a thing that stands there, null on a flat board). A player who has joined a nation and waits for a village is real; nothing
 * here says a village exists. The figure breathes on the idle sheet, with the ring that says "yours" on the ground
 * at its feet; under reduced motion it is the sheet's first frame, there at once. Returns whether a figure was drawn
 * (false until its sheet is here: the spot stays empty, and the map is asked for one more frame when it comes).
 */
export function paintWaitCharacter(ctx, spot, { faction, up = null, now = fxSecs(), level = motionLevel() } = {}) {
  if (!ctx?.save || !spot?.box || !ok(faction)) return false;
  const key = keyOf(faction), id = `wait|${faction}`;
  const full = level === 'full';
  // (the standard's unit is the spot's `u`; a spot that does not say it is measured by its room)
  const u = waitCharacterUnit(spot.u > 0 ? spot.u : spot.box.h / 1.48), x = spot.x, y = spot.y - u * WAIT_LIFT;
  wire();
  if (!leaderMotionPick(key, 'idle', leaderCellWidth(u) * contextScale(ctx))) return false;
  if (!waitSeen.has(id)) waitSeen.set(id, now);
  const alpha = full ? clamp01((now - waitSeen.get(id)) / FADE_IN) : 1;
  noteDrawn(leaderCellWidth(u) * contextScale(ctx));
  // on the ground: a soft shadow and the ring; on them, upright as the standard is, the figure
  return paintStanding(ctx, x, y, u, { key, own: true, pose: { motion: 'idle', share: full ? now / clip('idle').duration : 0, looping: true }, alpha, up, breath: full ? leaderBreath(now) : 0 });
}
