// The map's painter of a nation's character (ported from the other line of
// work). The six are the players (DECISIONS ZP1): a player's character stands
// beside that player's village (people/onboard.mjs) and behind that player's
// line in a battle scene (people/battle.mjs); it replaces no soldier and is
// no unit of the game.
import { motionSelection, motionSpriteUrl, motionSpriteFrame, motionSheetSet, motionInSet, LEADER_SHEET_SETS, LEADER_BREATH, LEADER_SPRITE_ANCHOR, LEADER_SPRITE_CELL_U, LEADER_DRAW_SCALE } from '../leader-motion-data.mjs';

const images = new Map();
const listeners = new Set();
const redraw = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* a painter that is gone */ } } };
/** Ask to be told when a sheet has arrived (or failed); returns the way to stop being told. Every asker is told. */
export function onLeaderMotionLoad(fn) { if (typeof fn !== 'function') return () => {}; listeners.add(fn); return () => listeners.delete(fn); }

/**
 * A sheet of one set ('1x': the owner's 256 px frames; '2x': the 512 px frames, leader-motion-data.mjs
 * LEADER_SHEET_SETS), asked for the first time it is wanted and never again; null until it is decoded.
 */
export function leaderMotionSheet(leader, motion = 'idle', set = '1x') {
  const selected = motionSelection(leader, motion), S = LEADER_SHEET_SETS[set] ?? LEADER_SHEET_SETS['1x'];
  const url = motionSpriteUrl(selected.leader.key, selected.motion.key, S.key);
  if (images.has(url)) return images.get(url).ready ? images.get(url).image : null;
  if (typeof Image === 'undefined') return null;
  const image = new Image(), record = { image, ready: false, failed: false };
  images.set(url, record);
  image.onload = () => {
    const good = image.width === S.cell * motionInSet(selected.motion, S.key).frames && image.height === S.cell;
    const done = () => { record.ready = good; record.failed = !good; redraw(); };
    // (decoded before it is called ready, where the browser can: the first frame drawn does not wait for the row's decoding)
    if (good && typeof image.decode === 'function') image.decode().then(done, done); else done();
  };
  image.onerror = () => { record.ready = false; record.failed = true; redraw(); };
  image.src = url;
  return null;
}

export function leaderMotionStatus(leader, motion = 'idle', set = '1x') {
  const record = images.get(motionSpriteUrl(leader, motion, set));
  return record?.ready ? 'ready' : record?.failed ? 'failed' : 'pending';
}

/**
 * The sheet to draw a cell `devicePx` wide from: `{image, set}` or null. The set the size calls for is asked for
 * (lazily: nothing is fetched before something is drawn that large). While it is on its way the other set is drawn
 * if it is here already; a finer sheet that has been asked for is used for a smaller figure too (nothing more is
 * fetched for it; until it is here a 1x sheet that is here already is drawn); the other set is asked for as a
 * stand-in only when the wanted one failed.
 */
export function leaderMotionPick(leader, motion = 'idle', devicePx = 0) {
  const selected = motionSelection(leader, motion), k = selected.leader.key, m = selected.motion.key;
  const want = motionSheetSet(devicePx), other = want === '2x' ? '1x' : '2x';
  const here = set => { const r = images.get(motionSpriteUrl(k, m, set)); return r?.ready ? r.image : null; };
  // (a finer sheet that has been asked for serves a smaller figure too: here, it is drawn; on its way, the 1x sheet is
  // drawn if that one is here already, and nothing more is fetched: a figure that is on screen stays on screen)
  if (want === '1x') {
    const fine = images.get(motionSpriteUrl(k, m, '2x'));
    if (fine && !fine.failed) { if (fine.ready) return { image: fine.image, set: '2x' }; const coarse = here('1x'); return coarse ? { image: coarse, set: '1x' } : null; }
  }
  const wanted = leaderMotionSheet(k, m, want);
  if (wanted) return { image: wanted, set: want };
  const alt = here(other) ?? (leaderMotionStatus(k, m, want) === 'failed' ? leaderMotionSheet(k, m, other) : null);
  return alt ? { image: alt, set: other } : null;
}
/** Device px per unit of a context (its transform's scale; 1 where the context cannot say). */
export const contextScale = ctx => { const t = ctx?.getTransform?.(); const k = t && Number.isFinite(t.a) ? Math.hypot(t.a, t.b ?? 0) : 1; return k > 0 ? k : 1; };
/** How wide a character's cell is drawn for a height unit `height` (the context's own units). */
export const leaderCellWidth = height => height * LEADER_SPRITE_CELL_U * LEADER_DRAW_SCALE;

/** How far a standing character's breath has risen `t` seconds on the clock: 0 (out) … 1 (in), a slow sine of LEADER_BREATH.secs. */
export const leaderBreath = t => (Number.isFinite(t) ? 0.5 - 0.5 * Math.cos((t / LEADER_BREATH.secs) * Math.PI * 2) : 0);

/**
 * Feet at x/y; height is the same token-height unit as paintToken. The sheet's set follows the size drawn on the
 * device (`px` overrides the context's own scale). `breath` (0 … 1, `leaderBreath`): the picture is drawn that much
 * of LEADER_BREATH taller and narrower about its feet; 0 is the frame as it is.
 */
export function paintLeaderMotion(ctx, x, y, height, { leader = 'aster', motion = 'idle', share = 0, looping, face = 1, alpha = 1, own = false, px = null, breath = 0 } = {}) {
  if (!(Number.isFinite(height) && height > 0)) return false;
  const selected = motionSelection(leader, motion);
  const width = leaderCellWidth(height), devicePx = Number.isFinite(px) ? px : width * contextScale(ctx);
  const requested = leaderMotionPick(selected.leader.key, selected.motion.key, devicePx);
  // Pending or damaged action sheets retain a decoded idle pose.
  const picked = requested ?? leaderMotionPick(selected.leader.key, 'idle', devicePx);
  if (!picked) return false;
  const S = LEADER_SHEET_SETS[picked.set];
  const clip = motionInSet(requested ? selected.motion : motionSelection(leader, 'idle').motion, picked.set);
  const frame = motionSpriteFrame(clip, requested ? share : 0, requested ? looping : true);
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y);
  if (face < 0) ctx.scale(-1, 1);
  if (breath > 0) ctx.scale(1 - LEADER_BREATH.narrow * breath, 1 + LEADER_BREATH.rise * breath);
  // (a 512 px frame drawn small is reduced with the browser's better filter: a plain one skips rows and glitters)
  if (S.cell > devicePx) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
  // (measured 2026-10-10, the map's own probe at rest on a 1440 screen: the figure costs 0.3 to 0.45 ms of a frame of
  // some 12.4 ms, its shadow nothing that can be measured; drawn from a copy of the frame reduced once the frame took
  // 12.7 to 12.8 ms, so the sheet is drawn directly)
  ctx.drawImage(picked.image, frame * S.cell, 0, S.cell, S.cell,
    -width * LEADER_SPRITE_ANCHOR[0], -width * LEADER_SPRITE_ANCHOR[1], width, width);
  if (own) {
    const radius = height * .292;
    ctx.strokeStyle = '#f3d58a'; ctx.lineWidth = height * .025;
    ctx.beginPath(); ctx.ellipse(0, 0, radius, radius * .76, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
  return true;
}

/**
 * The shadow a character lays on the ground it stands on (`u`: the height unit the figure is drawn in): a soft pool under
 * the feet, darkest where they touch and gone at its edge, drawn a little towards the lower right as the board's
 * light has it. A context that has no gradients gets a flat one.
 */
export function paintContactShadow(ctx, x, y, u, alpha = 1) {
  if (!ctx?.ellipse) return;
  const rx = u * 0.36, ry = u * 0.15, cx = x + u * 0.05, cy = y + u * 0.03;
  ctx.save();
  const grad = ctx.createRadialGradient?.(0, 0, 0, 0, 0, 1);
  if (grad?.addColorStop) {
    grad.addColorStop(0, 'rgba(10,18,15,.5)'); grad.addColorStop(0.45, 'rgba(10,18,15,.3)'); grad.addColorStop(1, 'rgba(10,18,15,0)');
    ctx.globalAlpha *= alpha; ctx.translate(cx, cy); ctx.scale(rx, ry); ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.globalAlpha *= 0.3 * alpha; ctx.fillStyle = '#0a120f';
    ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.9, ry * 0.8, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
