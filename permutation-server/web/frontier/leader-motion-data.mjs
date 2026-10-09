/** Accepted six-color leaders; movement assets are separate from prior designs. */
// (Ported from the other line of work, values unchanged; `colorName` and `label` are that line's preview labels,
// written as escapes here because this client's language test allows Japanese only through L`…`:
// red, sky cyan, yellow, purple, white, orange; idle, walk, attack, hit.)
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
export const LEADER_SPRITE_CELL = 256;
export const LEADER_SPRITE_ANCHOR = Object.freeze([.5, .76]);
export const LEADER_SPRITE_CELL_U = (2 / .95) * 1.15;
// Measured separately from the real game army actors. Updated by sprite audit.
export const LEADER_DRAW_SCALE = 1.30;
export const LEADER_TILE_FOOT = 14;

export function motionSelection(leader, motion) {
  return {
    leader: MOTION_LEADERS.find(item => item.key === leader) ?? MOTION_LEADERS[0],
    motion: LEADER_MOTIONS.find(item => item.key === motion || item.clip === motion) ?? LEADER_MOTIONS[0],
  };
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
  const id = `${set}|${motion.key}`;
  if (!inSet.has(id)) inSet.set(id, Object.freeze({ ...motion, frames }));
  return inSet.get(id);
}
export const motionSpriteUrl = (key, clip = 'idle', set = '1x') => {
  const selected = motionSelection(key, clip), folder = (LEADER_SHEET_SETS[set] ?? LEADER_SHEET_SETS['1x']).folder;
  return new URL(`./art/leaders3d/${LEADER_MOTION_PACK}/${folder}/${selected.leader.key}_${selected.motion.key}.webp`, import.meta.url).href;
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
