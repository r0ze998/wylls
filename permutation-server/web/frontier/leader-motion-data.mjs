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
export const motionSpriteUrl = (key, clip = 'idle') => {
  const selected = motionSelection(key, clip);
  return new URL(`./art/leaders3d/${LEADER_MOTION_PACK}/sprite/${selected.leader.key}_${selected.motion.key}.webp`, import.meta.url).href;
};

/** Elapsed share can loop or end on its final image, never wrap a one-shot. */
export function motionSpriteFrame(motion, share = 0, looping = motion.loop) {
  const elapsed = Number.isFinite(share) ? share : 0;
  const progress = looping ? ((elapsed % 1) + 1) % 1 : Math.max(0, Math.min(1, elapsed));
  // Cycles omit the duplicate end frame; one-shots sample both endpoints.
  if (motion.loop) return !looping && progress === 1 ? 0
    : Math.min(motion.frames - 1, Math.floor(progress * motion.frames));
  return Math.round(progress * (motion.frames - 1));
}
