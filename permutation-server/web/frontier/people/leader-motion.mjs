// The map's painter of a nation's character (ported from the other line of
// work). The six are the players (DECISIONS ZP1): a player's character stands
// beside that player's village (people/onboard.mjs) and behind that player's
// line in a battle scene (people/battle.mjs); it replaces no soldier and is
// no unit of the game.
import { motionSelection, motionSpriteUrl, motionSpriteFrame, LEADER_SPRITE_CELL, LEADER_SPRITE_ANCHOR, LEADER_SPRITE_CELL_U, LEADER_DRAW_SCALE } from '../leader-motion-data.mjs';

const images = new Map();
const listeners = new Set();
const redraw = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* a painter that is gone */ } } };
/** Ask to be told when a sheet has arrived (or failed); returns the way to stop being told. Every asker is told. */
export function onLeaderMotionLoad(fn) { if (typeof fn !== 'function') return () => {}; listeners.add(fn); return () => listeners.delete(fn); }

export function leaderMotionSheet(leader, motion = 'idle') {
  const selected = motionSelection(leader, motion), url = motionSpriteUrl(selected.leader.key, selected.motion.key);
  if (images.has(url)) return images.get(url).ready ? images.get(url).image : null;
  if (typeof Image === 'undefined') return null;
  const image = new Image(), record = { image, ready: false, failed: false };
  images.set(url, record);
  image.onload = () => {
    const good = image.width === LEADER_SPRITE_CELL * selected.motion.frames && image.height === LEADER_SPRITE_CELL;
    const done = () => { record.ready = good; record.failed = !good; redraw(); };
    // (decoded before it is called ready, where the browser can: the first frame drawn does not wait for the row's decoding)
    if (good && typeof image.decode === 'function') image.decode().then(done, done); else done();
  };
  image.onerror = () => { record.ready = false; record.failed = true; redraw(); };
  image.src = url;
  return null;
}

export function leaderMotionStatus(leader, motion = 'idle') {
  const record = images.get(motionSpriteUrl(leader, motion));
  return record?.ready ? 'ready' : record?.failed ? 'failed' : 'pending';
}

/** Feet at x/y; height is the same token-height unit as paintToken. */
export function paintLeaderMotion(ctx, x, y, height, { leader = 'aster', motion = 'idle', share = 0, looping, face = 1, alpha = 1, own = false } = {}) {
  if (!(Number.isFinite(height) && height > 0)) return false;
  const selected = motionSelection(leader, motion);
  const requested = leaderMotionSheet(selected.leader.key, selected.motion.key);
  // Pending or damaged action sheets retain a decoded idle pose.
  const idle = requested ? null : leaderMotionSheet(selected.leader.key, 'idle');
  const image = requested ?? idle;
  if (!image) return false;
  const clip = requested ? selected.motion : motionSelection(leader, 'idle').motion;
  const frame = motionSpriteFrame(clip, requested ? share : 0, requested ? looping : true);
  const width = height * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y);
  if (face < 0) ctx.scale(-1, 1);
  ctx.drawImage(image, frame * LEADER_SPRITE_CELL, 0, LEADER_SPRITE_CELL, LEADER_SPRITE_CELL,
    -width * LEADER_SPRITE_ANCHOR[0], -width * LEADER_SPRITE_ANCHOR[1], width, width);
  if (own) {
    const radius = height * .292;
    ctx.strokeStyle = '#f3d58a'; ctx.lineWidth = height * .025;
    ctx.beginPath(); ctx.ellipse(0, 0, radius, radius * .76, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
  return true;
}
