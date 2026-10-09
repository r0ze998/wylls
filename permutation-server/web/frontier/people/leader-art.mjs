// The six leaders' pictures (the owner's art of 2026-10-09, "the six in
// motion" and "the latest leaders"): where each file is, and the markup that
// shows it. Presentation only: the chain has no leader, and nothing here puts
// a leader on the map as an actor (people/leader-motion.mjs is the map's
// painter, used by the effects demo alone).
//
//   art/leaders3d/hex-v1/<key>@128.webp, @256.webp   the hexagon icon (nation-coloured frame, thin gold edge):
//                                                    the crest chip, the plate, standings, the versus band, the legend
//   art/leaders3d/portrait-v1/<key>.webp             the bust from the latest model, 320 px, transparent: the portrait card
//   art/leaders3d/stage-v1/<key>.webp                the leader standing, three-quarter view, 288 × 360, transparent (a still)
//   art/leaders3d/stage-v1/<key>_idle.webp           the same view breathing: 8 frames in a row, 2 s, a loop
//   art/leaders3d/stage-v1/<key>_attack.webp         the flourish: 8 frames, 0.8 s, once, back to the stance
//   art/leaders3d/motion-v1/sprite/<key>_<clip>.webp the package's map sprites (overhead view; leader-motion-data.mjs)
//
// The stage pictures are rendered from the package's own rigged models and
// clips (Idle, Attack) with the package's light recipe, seen from the front
// instead of from above (docs/frontier/art/leaders3d/README.md says how).
//
// Markup is SVG with attributes only (the page's CSP allows no style
// attribute); a picture that has not loaded leaves its place empty, never a
// broken-image mark, and nothing changes size when it arrives.
import { MOTION_LEADERS } from '../leader-motion-data.mjs';
import { NATION_FILL, NATION_DARK, NATION_ON } from '../palette.mjs';
import { sigilPath } from './avatar.mjs';

const BASE = new URL('../art/leaders3d/', import.meta.url);
const ok = f => Number.isInteger(f) && f >= 0 && f < 6;
/** The file key of a nation's leader ('aster' … 'fjordal'); anything else reads as Aster, as the map painter does. */
export const leaderKey = f => MOTION_LEADERS[ok(f) ? f : 0].key;

/** The stage sheets: one cell, where the feet stand in it, and the two clips (frames in a row, seconds, loop or once). */
export const STAGE_CELL = Object.freeze({ w: 288, h: 360 });
export const STAGE_FOOT = Object.freeze([0.5, 0.985]);
export const STAGE_CLIPS = Object.freeze({
  idle: Object.freeze({ key: 'idle', frames: 8, duration: 2, loop: true }),
  attack: Object.freeze({ key: 'attack', frames: 8, duration: 0.8, loop: false }),
});

/** The hexagon icon for a box of `size` CSS px on a screen of up to 2 device px per px: 128 px up to 64, else 256. */
export const leaderHexUrl = (f, size = 64) => new URL(`hex-v1/${leaderKey(f)}@${size > 64 ? 256 : 128}.webp`, BASE).href;
export const leaderPortraitUrl = f => new URL(`portrait-v1/${leaderKey(f)}.webp`, BASE).href;
export const leaderStillUrl = f => new URL(`stage-v1/${leaderKey(f)}.webp`, BASE).href;
export const leaderStageUrl = (f, clip = 'idle') => new URL(`stage-v1/${leaderKey(f)}_${STAGE_CLIPS[clip] ? clip : 'idle'}.webp`, BASE).href;

const esc = s => String(s).replace(/[<>&"]/g, '');
const a11y = title => (title ? `role="img" aria-label="${esc(title)}"` : 'aria-hidden="true" focusable="false"');

/**
 * The hexagon icon as markup, `size` px square. `sigil: true` adds the nation's sigil on a small shield of its
 * colour at the foot (where the icon stands alone for the nation: the sigil carries the identity, never the
 * colour by itself). Decorative unless `title` is given.
 */
export function leaderHex(faction, { size = 40, title = null, sigil = false } = {}) {
  const f = ok(faction) ? faction : 0;
  const badge = sigil ? `<g transform="translate(79 79)"><circle r="17" fill="${NATION_FILL[f]}" stroke="#14110a" stroke-width="3.5"/><circle r="15.2" fill="none" stroke="#f0d48a" stroke-width="1.6"/><path d="${sigilPath(f, 8.6)}" fill="${NATION_ON[f]}"/></g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" class="leader leader-hex" data-leader="${leaderKey(f)}" ${a11y(title)}><image href="${leaderHexUrl(f, size)}" width="100" height="100"/>${badge}</svg>`;
}

/**
 * The leader standing (the stage picture) as markup, `size` px tall and four fifths as wide: a still. The sprite
 * player (people/leader-sprite.mjs `leaderFigure`, which is what a screen calls) moves it: `motion: 'idle'`
 * breathes, `'attack'` plays the flourish once and goes back to breathing, `'still'` stays a still. `once`: a name
 * for one playing of the flourish (the same name does not play again while it stays on the page). `when: 'look'`:
 * it moves only while the thing that holds it (`[data-nation]`) is hovered, focused or chosen. `flip` mirrors it.
 */
export function stageFigureSvg(faction, { size = 120, motion = 'idle', once = null, when = null, flip = false, title = null, shadow = true, cls = '' } = {}) {
  const f = ok(faction) ? faction : 0, { w, h } = STAGE_CELL;
  const m = motion === 'attack' || motion === 'still' ? motion : 'idle';
  const attrs = [`data-leader="${leaderKey(f)}"`, `data-motion="${m}"`, once ? `data-once="${esc(once)}"` : '', when === 'look' ? 'data-when="look"' : '', flip ? 'data-flip="1"' : ''].filter(Boolean).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${Math.round(size * w / h)}" height="${Math.round(size)}" class="lfig${cls ? ` ${esc(cls)}` : ''}" ${attrs} ${a11y(title)}>${shadow ? `<ellipse class="lfig-shadow" cx="${w / 2}" cy="${Math.round(h * STAGE_FOOT[1]) - 6}" rx="74" ry="9" fill="#000" opacity=".34"/>` : ''}<image class="lfig-still" href="${leaderStillUrl(f)}" width="${w}" height="${h}"/></svg>`;
}

/** The nation's sigil on its colour, for a place where the leader's picture stands for the nation (attributes only). */
export const nationTrim = f => (ok(f) ? { fill: NATION_FILL[f], dark: NATION_DARK[f], on: NATION_ON[f] } : { fill: '#8a8a80', dark: '#55554e', on: '#fffaf0' });

// ------------------------------------------------------------------ canvases
const images = new Map();
let redraw = () => {};
/** A canvas painter that uses a leader's hexagon asks to be drawn again when the picture arrives. */
export function onLeaderArtLoad(fn) { redraw = typeof fn === 'function' ? fn : () => {}; }
/** The decoded hexagon icon for a canvas (null until it has loaded; the load starts on the first call). */
export function leaderHexImage(faction, size = 64) {
  const url = leaderHexUrl(faction, size);
  const hit = images.get(url);
  if (hit) return hit.ready ? hit.img : null;
  if (typeof globalThis.Image !== 'function') return null;
  const img = new globalThis.Image(), rec = { img, ready: false };
  images.set(url, rec);
  img.onload = () => { rec.ready = true; try { redraw(); } catch { /* the painter is gone */ } };
  img.onerror = () => { rec.ready = false; };
  img.src = url;
  return null;
}
