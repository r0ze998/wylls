// A reusable map-art consumer for leader actors. The current game has army
// actors and UI leaders only; this does not replace a soldier or invent an actor.
import { motionSelection, motionSpriteUrl, motionSpriteFrame, LEADER_SPRITE_CELL, LEADER_SPRITE_ANCHOR, LEADER_SPRITE_CELL_U, LEADER_DRAW_SCALE } from '../leader-motion-data.mjs';

const images = new Map();
let redraw = () => {};
export function onLeaderMotionLoad(fn) { redraw = typeof fn === 'function' ? fn : () => {}; }

export function leaderMotionSheet(leader, motion = 'idle') {
  const selected = motionSelection(leader, motion), url = motionSpriteUrl(selected.leader.key, selected.motion.key);
  if (images.has(url)) return images.get(url).ready ? images.get(url).image : null;
  if (typeof Image === 'undefined') return null;
  const image = new Image(), record = { image, ready: false, failed: false };
  images.set(url, record);
  image.onload = () => {
    record.ready = image.width === LEADER_SPRITE_CELL * selected.motion.frames && image.height === LEADER_SPRITE_CELL;
    record.failed = !record.ready;
    redraw();
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
