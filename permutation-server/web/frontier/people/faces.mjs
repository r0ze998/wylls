// A player's face (UX design 13.1; owner decision of 2026-10-09: "the six
// are the players"). Every player of a nation, a person or an AI citizen
// alike and with no mark, looks like that nation's character, so the face of
// a player is a function of the player's NATION, not of the player:
//
//   playerFace(faction, {size, own})        markup: the hexagon icon up to 64 px, the portrait card above
//   paintPlayerFace(ctx, faction, x, y, d)  the same icon on a canvas (a map tag), `d` px across
//
// `own` marks the viewer's own face with the gold ring (never by colour
// alone: the ring is a second hexagon outside the icon's own frame, and the
// places that show it also say "you" in words). A side that is no nation (a
// camp, an unknown owner) has no face: both return nothing for it.
//
// The flat generated portraits (people/avatar.mjs avatarSvg) are no longer
// shown on any screen of this client; a player's own NAME stays the player's
// (people/identity.mjs, unchanged).
import { leaderSvg, leaderHexImage } from './leaders.mjs';
import { YOURS } from './leader-art.mjs';

const nation = f => Number.isInteger(f) && f >= 0 && f < 6;
/** The smallest a face is shown (CSS px): under it the icon is a blot of colour. */
export const FACE_MIN = 30;

/** A player's face as markup: their nation's character, `size` px wide (never under FACE_MIN); '' for no nation. */
export function playerFace(faction, { size = 36, own = false, title = null, shape = 'auto' } = {}) {
  if (!nation(faction)) return '';
  return leaderSvg(faction, { size: Math.max(FACE_MIN, size), own: !!own, title, shape });
}

/**
 * A player's face on a canvas: the hexagon icon `d` units across with its top left at (x, y); the gold ring round
 * it for the viewer's own. Returns false until the picture has loaded (the caller draws its stand-in), or for no nation.
 */
export function paintPlayerFace(ctx, faction, x, y, d, { own = false } = {}) {
  if (!nation(faction) || !ctx?.drawImage) return false;
  const img = leaderHexImage(faction);
  if (!img) return false;
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  if (own) {
    const k = YOURS.inset, u = d / 100;
    ctx.drawImage(img, x + 49.7 * (1 - k) * u, y + 48.2 * (1 - k) * u, d * k, d * k);
    const pts = [[49.6, 1], [92.4, 26.6], [92.4, 70.3], [49.6, 95.5], [7, 70.3], [7, 26.6]];
    ctx.lineJoin = 'round';
    for (const [w, c] of [[11, YOURS.key], [6.5, YOURS.gold], [1.6, YOURS.core]]) {
      ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * u, y + py * u) : ctx.moveTo(x + px * u, y + py * u))); ctx.closePath();
      ctx.strokeStyle = c; ctx.lineWidth = w * u; ctx.stroke();
    }
  } else ctx.drawImage(img, x, y, d, d);
  ctx.restore();
  return true;
}
