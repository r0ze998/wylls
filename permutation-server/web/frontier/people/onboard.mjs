// A player's character on the board (UX design 13.2; owner decision of
// 2026-10-09: "the six are the players"). In normal play:
//
//   the viewer's own   stands beside the viewer's active village: upright on
//                      the tilted board, at the size the owner's package was
//                      approved at (leader-motion-data.mjs LEADER_DRAW_SCALE,
//                      1.30 of a host's figure, as in game-fit.png), the idle
//                      loop, a gold ring on the ground at its feet
//   another player's   stands beside that player's village only while that
//                      village is selected (no ring: gold means "yours")
//   the landing        when the viewer's first village lands, the character
//                      walks to its place while the colour floods (the walk
//                      sheet), then stands
//   the wait           before the first village, while the viewer has joined a
//                      nation: the viewer's own stands beside the nation's
//                      standard in the home wedge, in the spot the map keeps
//                      clear for it (`paintWaitCharacter`; the map calls it
//                      where it paints the standard)
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
// token to `paintCharacter` here. No hook of map/** was added for it.
//
// The sheets (art/leaders3d/motion-v1/sprite, 256 px frames) are fetched
// lazily: the viewer's own nation's idle sheet as soon as the page knows the
// nation (`warmCharacter`, before the opening flight ends), the walk sheet
// when a landing is on its way, another nation's idle sheet when its village
// is selected. A figure comes in over FADE_IN seconds from the first frame
// its sheet is here, so it never pops in. Reduced motion (fx/motion.mjs) is
// a complete mode: the figure is the first frame of its idle sheet, it does
// not walk, and it is there at once.
import { RADIUS, FLATTEN, project } from '../../map.mjs';
import { tileHex } from '../fgeo.mjs';
import { MOTION_LEADERS, LEADER_MOTIONS, LEADER_DRAW_SCALE, LEADER_SPRITE_CELL_U } from '../leader-motion-data.mjs';
import { paintLeaderMotion, leaderMotionSheet, onLeaderMotionLoad } from './leader-motion.mjs';
import { YOURS } from './leader-art.mjs';
import { standing } from '../map/tilt.mjs';
import { VILLAGE } from '../map/village.mjs';
import { HERO, VILLAGE_SCALE, VILLAGE_AT } from '../map/plates.mjs';
import { motion as motionLevel } from '../fx/motion.mjs';
import { on as busOn } from '../fx/bus.mjs';

const clip = key => LEADER_MOTIONS.find(m => m.key === key);
const ok = f => Number.isInteger(f) && f >= 0 && f < 6;
const keyOf = f => MOTION_LEADERS[f].key;
const clamp01 = x => Math.max(0, Math.min(1, x));
const smooth = k => { const x = clamp01(k); return x * x * (3 - 2 * x); };
const fxSecs = () => { try { const t = globalThis.__fxNow?.(); if (Number.isFinite(t)) return t; } catch { /* the page's own time */ } return (globalThis.performance?.now?.() ?? Date.now()) / 1000; };

/** A figure comes in over this many seconds from the first frame its sheet is here (never a pop). */
export const FADE_IN = 0.3;
/**
 * Where a character stands by a village of tier `tier` (0 hamlet … 3 stronghold), in hex radii (world px / RADIUS)
 * from the tile's centre (x to the right, y down the board), first choice first. Chosen from pictures of the hero
 * frame, the selection's frame and the landing, 1440 × 900 and 390 × 844. A village is a ring of houses inside a
 * palisade (map/village.mjs VILLAGE.ring by tier, times the scale it is drawn at: map/plates.mjs); the character
 * stands outside the palisade at its right-hand foot, `CHARACTER_OUT` beyond the ring:
 *   own    the viewer's own village is drawn large (HERO): its hosts stand before the gate on either side
 *          (HERO.hosts), its standard beside the ring to the right (HERO.standard: the character stands below the
 *          pole's foot, never on it), a building's scaffold to the left, its plate above. The right-hand foot is
 *          clear of all of them; if hosts stand there, the left-hand foot, then the ground before the gate.
 *   other  another village keeps inside its tile, its hosts before it (people/units.mjs SPOTS_HOLDING): the
 *          right-hand foot is outside the palisade and outside the selection's hexagon.
 */
export const CHARACTER_OUT = Object.freeze({ x: 0.3, y: 0.25, fall: 0.85 });
export function characterSpots(own, tier = 1) {
  const t = Math.max(0, Math.min(3, Number.isInteger(tier) ? tier : 1));
  const scale = own ? HERO.scale : VILLAGE_SCALE, cy = (own ? HERO.at.y : VILLAGE_AT.y) / RADIUS;
  const rx = VILLAGE.ring[t] * scale, ry = rx * FLATTEN * 0.8;
  const x = rx + CHARACTER_OUT.x, y = cy + ry * CHARACTER_OUT.fall + CHARACTER_OUT.y;
  return [[x, y], [-x + 0.06, y + 0.02], [0.03, cy + ry + 0.62]];
}
/** A character keeps this far (hex radii) from every host that stands on its village. */
export const CHARACTER_CLEAR = 0.5;
/**
 * The landing's walk: the character comes in from `from` (hex radii from its place: from the left and a little
 * nearer the viewer, so that it walks the way its sheet faces), beginning `delay` s after the landing begins (the
 * colour floods from 0.12 s: map/ownland.mjs LANDING) and arriving `secs` later; it is seen from the first step.
 */
export const LANDING_WALK = Object.freeze({ from: Object.freeze([-1.5, 0.42]), delay: 0.12, secs: 1.9, fade: 0.35 });

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
/** Fetch a nation's sheet ahead of its use (`motion`: 'idle' | 'walk'); says whether it is here already. */
export function warmCharacter(faction, motion = 'idle') {
  if (!ok(faction)) return false;
  if (!wired) {
    wired = true;
    // a sheet that arrives: one more frame of the animated layer (the map's own tick; nothing where there is no map)
    onLeaderMotionLoad(() => { try { globalThis.__wyllsMap?.tick?.(); } catch { /* no map on this page */ } });
  }
  // (reduced motion never walks: the walk sheet is not fetched)
  if (motion === 'walk' && motionLevel() !== 'full') return false;
  const idle = !!leaderMotionSheet(keyOf(faction), 'idle');
  return motion === 'idle' ? idle : !!leaderMotionSheet(keyOf(faction), motion) && idle;
}

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
/**
 * The place of a character by a village whose tile's centre is `centre` (world px): the first of its spots that
 * keeps CHARACTER_CLEAR from every token already standing on that tile (`taken`: `[{x, y}]`), else the first.
 */
export function characterSpot(centre, own, taken = [], tier = 1) {
  const spots = characterSpots(own, tier);
  const at = ([dx, dy]) => ({ x: centre.x + dx * RADIUS, y: centre.y + dy * RADIUS });
  const clear = p => taken.every(t => Math.hypot(t.x - p.x, (t.y - p.y) / FLATTEN) >= CHARACTER_CLEAR * RADIUS);
  return spots.map(at).find(clear) ?? at(spots[0]);
}

/**
 * The tokens of the characters that stand in province (p, q): one for each character whose village is drawn there
 * (`villages`: the tiles with a village in this frame; `heroTiles`: the viewer's own, drawn large), none on a tile
 * a battle scene has (`skipTiles`). `tokens`: the hosts' tokens of the province (the characters keep clear of them).
 * A token: `{x, y, p, q, tile, faction, kind: 'character', character: {key, own, id, at: village key}, hosts: []}`.
 */
export function characterTokens({ p, q, tokens = [], villages = new Set(), heroTiles = null, skipTiles = new Set() } = {}) {
  const out = [];
  for (const c of list) {
    if (c.p !== p || c.q !== q || skipTiles.has(c.tile)) continue;
    const hero = !!heroTiles?.has(c.tile);
    if (!hero && !villages.has(c.tile)) continue;
    const h = tileHex(p, q, c.tile);
    if (!h) continue;
    const centre = project(h.q, h.r);
    const spot = characterSpot(centre, hero, tokens.filter(t => t.tile === c.tile), c.tier);
    out.push({ x: spot.x, y: spot.y, p, q, tile: c.tile, faction: c.faction, kind: 'character', troops: null, n: 0, status: null, face: 1, alpha: 1, own: false, hosts: [],
      character: { key: keyOf(c.faction), own: c.own, id: idOf(c), at: `${p},${q},${c.tile}`, pending: c.pending } });
  }
  return out;
}

// ------------------------------------------------------------------ painting
const seen = new Map();   // character id → the clock's seconds of the first frame its sheet was here
const waits = new Map();  // character id → since when it waits for its village's landing to begin
/** A character waits at most this long (s) for a reported landing to begin. */
export const PENDING_MAX = 8;
/**
 * The ring on the ground at a character's feet. The viewer's own: the ring that says "yours", bright gold with an
 * ivory core on a dark keyline (UX design 13.3). Another player's (`own` false): a thinner ivory ring on the same
 * keyline, the colour of a selection that is not the viewer's (UX design 5.2), so the figure reads on any ground.
 */
export function paintYoursRing(ctx, x, y, s, alpha = 1, own = true) {
  if (!ctx?.ellipse) return;
  const rx = s * 0.4, ry = rx * 0.5;
  ctx.save();
  ctx.globalAlpha *= alpha;
  for (const [w, c] of own ? [[0.11, YOURS.key], [0.066, YOURS.gold], [0.018, YOURS.core]] : [[0.085, YOURS.key], [0.04, '#f4efe0']]) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = c; ctx.lineWidth = s * w; ctx.stroke();
  }
  ctx.restore();
}

/**
 * Paint a character token (people/units.mjs paintToken hands it here): `s` the token height (the unit a host's
 * figure is drawn in), `t` the wall clock in seconds, `up(x, y)` what the tilt asks of a thing that stands there
 * (null on a flat board). The shadow and the ring lie on the ground; the figure stands on them. Returns whether a
 * figure was drawn (false until its sheet is here: nothing is drawn in its place).
 */
export function paintCharacter(ctx, tok, { s, t = 0, up = null, now = fxSecs(), level = motionLevel() } = {}) {
  const c = tok?.character;
  if (!c || !ctx?.save || !(s > 0)) return false;
  const full = level === 'full';
  // (a landing the page has reported and the map has not begun yet: the land is not in its colour, nobody walks yet)
  const age = full ? landingAge(c.at, now) : null;
  if (full && c.pending && age === null) {
    // (never for long: a map that does not say the landing began, a page whose map is elsewhere, shows the figure after PENDING_MAX)
    if (!waits.has(c.id)) waits.set(c.id, now);
    if (now - waits.get(c.id) < PENDING_MAX) return false;
  }
  const pose = characterPose(age, t, { full });
  if (!leaderMotionSheet(c.key, 'idle')) return false;
  if (pose.motion === 'walk') leaderMotionSheet(c.key, 'walk');
  if (!seen.has(c.id)) seen.set(c.id, now);
  const alpha = (full ? clamp01((now - seen.get(c.id)) / FADE_IN) : 1) * pose.alpha * (tok.alpha ?? 1);
  if (alpha <= 0.01) return true;
  const W = LANDING_WALK, x = tok.x + W.from[0] * RADIUS * pose.walk, y = tok.y + W.from[1] * RADIUS * pose.walk;
  // on the ground: a soft shadow, and for the viewer's own the ring
  ctx.save();
  ctx.globalAlpha *= 0.3 * alpha; ctx.fillStyle = '#0a120f';
  ctx.beginPath(); ctx.ellipse?.(x + s * 0.05, y + s * 0.02, s * 0.32, s * 0.12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  paintYoursRing(ctx, x, y, s, alpha, c.own);
  let drawn = false;
  standing(ctx, up?.(x, y) ?? null, x, y, () => { drawn = paintLeaderMotion(ctx, x, y, s, { leader: c.key, motion: pose.motion, share: pose.share, looping: pose.looping, face: 1, alpha, own: false }); });
  return drawn;
}

/** How tall a character's figure is drawn for a token height `s` (world px): about 0.33 of its sheet's cell, measured on the files. */
export const characterHeight = s => s * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE * 0.33;

// ------------------------------------------------------------------ the wait for the village (UX design 13.6)
/**
 * How much of the room the map keeps beside the standard the figure fills (its height as a share of the room's):
 * chosen from pictures of the wait view at 1440 × 900 and 390 × 844, so that the figure stands a head under the
 * standard's cloth and reads as a person at the wedge's framing.
 */
export const WAIT_FILL = 0.94;
/** How far up the room the feet stand, as a share of the token unit: the half height of the ring on the ground, so the ring keeps inside the room. */
export const WAIT_LIFT = 0.2;
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
  if (!warmCharacter(faction, 'idle')) return false;
  const full = level === 'full';
  if (!waitSeen.has(id)) waitSeen.set(id, now);
  const alpha = full ? clamp01((now - waitSeen.get(id)) / FADE_IN) : 1;
  // (the token unit that gives a figure of the wanted height: `characterHeight` the other way round; the feet a
  // little up the room, so that the ring on the ground keeps inside it and clear of the tag under the standard)
  const s = spot.box.h * WAIT_FILL / characterHeight(1), x = spot.x, y = spot.y - s * WAIT_LIFT;
  // on the ground: a soft shadow and the ring; on them, upright as the standard is, the figure
  ctx.save();
  ctx.globalAlpha *= 0.3 * alpha; ctx.fillStyle = '#0a120f';
  ctx.beginPath(); ctx.ellipse?.(x + s * 0.05, y + s * 0.02, s * 0.32, s * 0.12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  paintYoursRing(ctx, x, y, s, alpha, true);
  let drawn = false;
  standing(ctx, up?.(x, y) ?? null, x, y, () => { drawn = paintLeaderMotion(ctx, x, y, s, { leader: key, motion: 'idle', share: full ? now / clip('idle').duration : 0, looping: true, face: 1, alpha, own: false }); });
  return drawn;
}
