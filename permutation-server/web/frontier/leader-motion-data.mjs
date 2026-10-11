/** Accepted six-color leaders; movement assets are separate from prior designs. */
// (Ported from the other line of work, values unchanged; `colorName` and `label` are that line's preview labels,
// written as escapes here because this client's language test allows Japanese only through L`…`:
// red, sky cyan, yellow, purple, white, orange; idle, walk, attack, hit.)
import { artPackOn } from './art/pack.mjs';

export const MOTION_LEADERS = Object.freeze([
  { key: 'aster', nation: 'Aster', colorName: '\u8d64', color: '#CC303B' },
  { key: 'borealis', nation: 'Borealis', colorName: '\u6c34\u8272', color: '#31BEDB' },
  { key: 'cinder', nation: 'Cinder', colorName: '\u9ec4\u8272', color: '#EAC21B' },
  { key: 'dunmar', nation: 'Dunmar', colorName: '\u7d2b', color: '#A34CD8' },
  { key: 'ember', nation: 'Ember', colorName: '\u767d', color: '#EDEEE7' },
  { key: 'fjordal', nation: 'Fjordal', colorName: '\u30aa\u30ec\u30f3\u30b8', color: '#F19232' },
].map((leader, faction) => Object.freeze({ ...leader, faction })));

export const LEADER_MOTIONS = Object.freeze([
  { key: 'idle', clip: 'Idle', label: '\u5f85\u6a5f', frames: 4, duration: 2, loop: true },
  { key: 'walk', clip: 'Walk', label: '\u6b69\u884c', frames: 8, duration: 1, loop: true },
  { key: 'attack', clip: 'Attack', label: '\u653b\u6483', frames: 8, duration: .8, loop: false },
  { key: 'hit', clip: 'Hit', label: '\u88ab\u5f3e', frames: 4, duration: .55, loop: false },
].map(motion => Object.freeze(motion)));

export const LEADER_MOTION_PACK = 'motion-v1';
// ---- The handover sheets (owner's pack of 2026-10-10, art/README.md). Where the season runs the conquest program
// (art/pack.mjs artPackOn) the characters are drawn from art/leaders3d/motion-v2/: the pack's new clips Idle_Action,
// Attack_Action, Hit_Action and Victory_Action for all six, and its walks (Aster's corrected walk, Walk_Kimodo; the
// other five the Walk the pack keeps for them). Same cells, anchor and draw scale as the first pack. The table above
// stays the first pack's: the lengths a scene's choreography is timed by (people/battle.mjs CHARACTER_CLIP,
// people/onboard.mjs) are read from it and do not change with the sheets; a clip is drawn by its share of its own
// length, so the pack's attack (1 s in the model) plays across the time the scene gives it. `victory` exists in
// this pack only: asked of the first pack it is the idle (motionSelection's fallback).
export const LEADER_MOTIONS_V2 = Object.freeze([
  { key: 'idle', clip: 'Idle_Action', label: '\u5f85\u6a5f', frames: 4, duration: 2, loop: true },
  { key: 'walk', clip: 'Walk', label: '\u6b69\u884c', frames: 8, duration: 1, loop: true },
  { key: 'attack', clip: 'Attack_Action', label: '\u653b\u6483', frames: 8, duration: 1, loop: false },
  { key: 'hit', clip: 'Hit_Action', label: '\u88ab\u5f3e', frames: 4, duration: .55, loop: false },
  { key: 'victory', clip: 'Victory_Action', label: '\u52dd\u5229', frames: 12, duration: 1.7, loop: false },
].map(motion => Object.freeze(motion)));
export const LEADER_MOTION_PACK_V2 = 'motion-v2';
/** Aster's walk in the handover pack is the corrected one (the pack's own table of walks, folder 02: Walk_Kimodo); the other five keep Walk. */
const ASTER_WALK_V2 = Object.freeze({ ...LEADER_MOTIONS_V2[1], clip: 'Walk_Kimodo' });
/** The motions of the pack that is shown now, and its folder under art/leaders3d/. */
export const leaderMotions = () => (artPackOn() ? LEADER_MOTIONS_V2 : LEADER_MOTIONS);
export const leaderMotionPack = () => (artPackOn() ? LEADER_MOTION_PACK_V2 : LEADER_MOTION_PACK);
export const LEADER_SPRITE_CELL = 256;
export const LEADER_SPRITE_ANCHOR = Object.freeze([.5, .76]);
export const LEADER_SPRITE_CELL_U = (2 / .95) * 1.15;
// Measured separately from the real game army actors. Updated by sprite audit.
export const LEADER_DRAW_SCALE = 1.30;
export const LEADER_TILE_FOOT = 14;

export function motionSelection(leader, motion) {
  const list = leaderMotions();
  const who = MOTION_LEADERS.find(item => item.key === leader) ?? MOTION_LEADERS[0];
  const what = list.find(item => item.key === motion || item.clip === motion) ?? list[0];
  return { leader: who, motion: list === LEADER_MOTIONS_V2 && what.key === 'walk' && who.key === 'aster' ? ASTER_WALK_V2 : what };
}
// ---- A cue: a one-shot clip a standing character plays once (the victory pose of the handover pack).
// The painters of the board and of the battle scene ask for the idle of a character that stands; while a cue is live
// for that nation's character (and, when the cue names a place, for a figure standing near it) the painter
// (people/leader-motion.mjs paintLeaderMotion) draws the cue's clip in place of the idle, by the effects clock.
// Whoever knows the moment sets it (fx/sheetfx.mjs: a battle the records say was won, a keep the records say the
// viewer's nation took); nothing here decides that a moment happened. Only where the handover pack is shown: the
// first pack has no such clip.
const cues = new Map();   // leader key → {motion, t0, secs, near: {x, y, r} | null}
const cueClock = () => { const t = globalThis.__fxNow?.(); return Number.isFinite(t) ? t : (globalThis.performance?.now?.() ?? Date.now()) / 1000; };
/**
 * Cue a character's one-shot: `cueLeaderMotion('aster', 'victory', {at, secs, near})`. `at`: when it begins on the
 * effects clock (default now); `secs`: how long it plays (default the clip's own length); `near: {x, y, r}` (world
 * px): only a figure whose feet are within `r` of that point plays it (a battle's own stage), without it every
 * standing figure of that character does. Returns the cue, or null where the pack is not shown or the clip is unknown.
 */
export function cueLeaderMotion(leader, motion = 'victory', { at = null, secs = null, near = null } = {}) {
  if (!artPackOn()) return null;
  const selected = motionSelection(leader, motion);
  if (selected.motion.key !== motion || selected.motion.loop) return null;
  const cue = { motion, t0: Number.isFinite(at) ? at : cueClock(), secs: secs > 0 ? secs : selected.motion.duration, near: near && Number.isFinite(near.x) && Number.isFinite(near.y) && near.r > 0 ? { x: near.x, y: near.y, r: near.r } : null };
  cues.set(selected.leader.key, cue);
  return cue;
}
/** Take a character's cue away (a scene was cancelled). */
export function clearLeaderCue(leader) { return cues.delete(motionSelection(leader, 'idle').leader.key); }
/** The cue of `key` that is live or still to come (the painter asks for its sheet ahead of the pose), or null; one long over is forgotten. */
export function leaderCuePending(key, now = cueClock()) {
  const cue = cues.get(key);
  if (!cue) return null;
  if (now - cue.t0 >= cue.secs + 30) { cues.delete(key); return null; }   // (a rewound demo clock may still replay a recent one)
  return now - cue.t0 < cue.secs ? cue : null;
}
/** The cue a standing figure of `key` at world (x, y) plays now: `{motion, share}` or null. */
export function leaderCueAt(key, x, y, now = cueClock()) {
  const cue = cues.get(key);
  if (!cue) return null;
  const age = now - cue.t0;
  if (age < 0 || age >= cue.secs) return null;
  if (cue.near && Math.hypot(x - cue.near.x, y - cue.near.y) > cue.near.r) return null;
  return { motion: cue.motion, share: age / cue.secs };
}

// (The .glb models are not shipped with the play client: the redesign has no 3D viewer. The URL is kept for the preview page of the other line of work.)
export const motionModelUrl = key => new URL(`./art/leaders3d/${LEADER_MOTION_PACK}/models/${motionSelection(key).leader.key}.glb`, import.meta.url).href;

// ---- The two sets of sheets (2026-10-10; DECISIONS ZQ3, docs/frontier/art/leaders3d/STAGE.md).
// `1x` is the owner's package as delivered, byte for byte: frames of 256 px. `2x` is the same clips rendered from the
// owner's own models by the owner's own script (source/render_motion.py, its 512 px map view: the same camera,
// lights, head pitch, anchor and cell), frames of 512 px, and the idle sampled 8 times across its 2 s instead of 4, so
// that the breath shows on a figure drawn large. A painter asks for the set its drawn size calls for.
export const LEADER_SHEET_SETS = Object.freeze({
  '1x': Object.freeze({ key: '1x', folder: 'sprite', cell: LEADER_SPRITE_CELL, frames: Object.freeze({}) }),
  '2x': Object.freeze({ key: '2x', folder: 'sprite@2x', cell: LEADER_SPRITE_CELL * 2, frames: Object.freeze({ idle: 8 }) }),
});
/**
 * From this many device px of a drawn cell (the size it is drawn at times the device pixel ratio) the 2x set is asked
 * for: four fifths of a 1x frame's own size. Below it a 1x frame is reduced and stays sharp; from there on it would
 * be shown near its own size or enlarged, and is soft. The hero frame of an ordinary screen draws a cell of about
 * 220 px, a dense screen twice that.
 */
export const LEADER_SHEET_2X_FROM = 205;
/** The set a cell drawn `devicePx` wide calls for: '1x' | '2x'. */
export const motionSheetSet = devicePx => (Number.isFinite(devicePx) && devicePx >= LEADER_SHEET_2X_FROM ? '2x' : '1x');
const inSet = new Map();
/** A motion as a set holds it: the same clip and length, with the number of frames that set's sheet has. */
export function motionInSet(motion, set = '1x') {
  const frames = LEADER_SHEET_SETS[set]?.frames[motion.key];
  if (!frames || frames === motion.frames) return motion;
  const id = `${set}|${motion.key}|${motion.clip}`;
  if (!inSet.has(id)) inSet.set(id, Object.freeze({ ...motion, frames }));
  return inSet.get(id);
}
export const motionSpriteUrl = (key, clip = 'idle', set = '1x') => {
  const selected = motionSelection(key, clip), folder = (LEADER_SHEET_SETS[set] ?? LEADER_SHEET_SETS['1x']).folder;
  return new URL(`./art/leaders3d/${leaderMotionPack()}/${folder}/${selected.leader.key}_${selected.motion.key}.webp`, import.meta.url).href;
};

/**
 * How large a player's character stands on the board (the owner's decision of 2026-10-10, "make it larger"; DECISIONS
 * ZQ1): this many times the size the package was approved at (LEADER_DRAW_SCALE of a host's token unit, the ratio
 * of game-fit.png, at which the figure was about 38 px tall at the hero frame and did not read as the protagonist).
 * One number for every place a character stands on the board: people/onboard.mjs (beside a village, at the landing,
 * by the standard in the wait view) and people/battle.mjs (behind a line). LEADER_DRAW_SCALE itself stays the
 * package's.
 */
export const BOARD_CHARACTER_SCALE = 2;
/**
 * A standing character breathes (2026-10-10; DECISIONS ZQ4). The package's Idle clip is nearly still: across its 2 s
 * no figure's outline moves by a whole pixel of a 512 px frame, so on the board it read as a still however many
 * frames were shown. The painter therefore draws a standing figure a little taller and narrower about its feet on a
 * slow sine: `rise` of its height at the top of the breath, `narrow` of its width, once every `secs` (the clip's own
 * length). This is the client's, not the package's: 0 for `rise` and `narrow` shows the frames as they are. Reduced
 * motion never breathes.
 */
export const LEADER_BREATH = Object.freeze({ rise: 0.03, narrow: 0.012, secs: 2 });
/**
 * A character's figure inside its cell, measured on the 2x sheets (all six, every frame of the idle and the walk):
 * the head's top is `up` of the cell above the feet's anchor, the toes `down` below it, and the body reaches `half`
 * to either side; an attack reaches `reach` forward.
 */
export const LEADER_FIGURE = Object.freeze({ up: 0.34, down: 0.095, half: 0.15, reach: 0.19 });

/** Elapsed share can loop or end on its final image, never wrap a one-shot. */
export function motionSpriteFrame(motion, share = 0, looping = motion.loop) {
  const elapsed = Number.isFinite(share) ? share : 0;
  const progress = looping ? ((elapsed % 1) + 1) % 1 : Math.max(0, Math.min(1, elapsed));
  // Cycles omit the duplicate end frame; one-shots sample both endpoints.
  if (motion.loop) return !looping && progress === 1 ? 0
    : Math.min(motion.frames - 1, Math.floor(progress * motion.frames));
  return Math.round(progress * (motion.frames - 1));
}
