// The six leaders' pictures (the owner's art of 2026-10-09, "the six in
// motion" and "the latest leaders"): where each file is, and the markup that
// shows it. Presentation only: the chain has no leader, and nothing here puts
// a leader on the map as an actor (people/leader-motion.mjs is the map's
// painter, used by the effects demo alone).
//
//   art/leaders3d/hex-v1/<key>@128.webp              the hexagon icon (nation-coloured frame, thin gold edge), 128 px:
//                                                    the crest chip, the plate, standings, the versus band, the legend
//   art/leaders3d/portrait-v1/<key>.webp             the bust from the latest model, 320 px, transparent: the portrait card
//   art/leaders3d/stage-v1/<key>.webp                the leader standing, three-quarter view, 288 × 360, transparent (a still)
//   art/leaders3d/stage-v1/<key>_idle.webp           the same view breathing: 4 frames in a row, 2 s, a loop
//   art/leaders3d/stage-v1/<key>_attack.webp         the flourish: 8 frames, 0.8 s, once, back to the stance
//   art/leaders3d/motion-v1/sprite/<key>_<clip>.webp the package's map sprites (overhead view; leader-motion-data.mjs)
//
// The stage pictures are rendered from the package's own rigged models and
// clips (Idle, Attack) with the package's light recipe, seen from the front
// instead of from above (docs/frontier/art/leaders3d/STAGE.md says how).
//
// Markup carries attributes only (the page's CSP allows no style attribute);
// a picture that has not loaded leaves its place empty, never a broken-image
// mark, and nothing changes size when it arrives.
//
// The servers send every file with `Cache-Control: no-store`, so a picture
// named in markup would be fetched again each time that markup is written
// again, and would blink. So markup names no file on a page: the standing
// figure is a canvas, and an icon or a bust is an SVG <image> that carries its
// file as `data-art`; the sprite player (people/leader-sprite.mjs) holds the
// pictures (one fetch a file a page, none for a part of the page that is put
// away), paints the canvases and gives each <image> its picture as a data URL.
// Once a picture is held, markup carries it at once. Without a page (tests)
// markup names the file itself.
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
  idle: Object.freeze({ key: 'idle', frames: 4, duration: 2, loop: true }),
  attack: Object.freeze({ key: 'attack', frames: 8, duration: 0.8, loop: false }),
});

/** The hexagon icon (one file a leader, 128 px: sharp up to 64 CSS px on a screen of 2 device px per px; no screen shows it larger). */
export const leaderHexUrl = f => new URL(`hex-v1/${leaderKey(f)}@128.webp`, BASE).href;
export const leaderPortraitUrl = f => new URL(`portrait-v1/${leaderKey(f)}.webp`, BASE).href;
export const leaderStillUrl = f => new URL(`stage-v1/${leaderKey(f)}.webp`, BASE).href;
export const leaderStageUrl = (f, clip = 'idle') => new URL(`stage-v1/${leaderKey(f)}_${STAGE_CLIPS[clip] ? clip : 'idle'}.webp`, BASE).href;

// ------------------------------------------------------------------ pictures in markup, read once
const held = new Map();   // url → a data URL once read; a promise meanwhile; null when it cannot be had
let wanted = () => {};
/** The player says how it is woken when markup asks for a picture (people/leader-sprite.mjs). */
export function onArtWanted(fn) { wanted = typeof fn === 'function' ? fn : () => {}; }
const onPage = () => typeof globalThis.document === 'object' && typeof globalThis.fetch === 'function' && typeof globalThis.FileReader === 'function';
/** The picture at `url` as a data URL if this page holds it, else null. */
export const heldArt = url => (typeof held.get(url) === 'string' ? held.get(url) : null);
/** Read the picture at `url` once: a promise of its data URL (null when it cannot be had). */
export function holdArt(url) {
  const hit = held.get(url);
  if (hit !== undefined) return Promise.resolve(hit);
  const p = globalThis.fetch(url).then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then(blob => new Promise((done, fail) => { const fr = new globalThis.FileReader(); fr.onload = () => done(String(fr.result)); fr.onerror = fail; fr.readAsDataURL(blob); }))
    .then(data => { held.set(url, data); return data; }, () => { held.set(url, null); return null; });
  held.set(url, p);
  return p;
}
/**
 * An SVG `<image>` for the picture at `url` (`attrs`: its geometry). On a page it carries the picture itself once
 * held, else `data-art` for the player to fill; without a page (tests) it names the file.
 */
export function artImage(url, attrs = '') {
  const data = heldArt(url);
  if (data) return `<image href="${data}" ${attrs}/>`;
  if (!onPage()) return `<image href="${url}" ${attrs}/>`;
  try { wanted(); } catch { /* no player: the place stays empty */ }
  return `<image data-art="${url}" ${attrs}/>`;
}

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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" class="leader leader-hex" data-leader="${leaderKey(f)}" ${a11y(title)}>${artImage(leaderHexUrl(f), 'width="100" height="100"')}${badge}</svg>`;
}

/**
 * The leader standing (the stage picture) as markup: a canvas of one stage cell (288 × 360) that the sprite player
 * paints (people/leader-sprite.mjs `leaderFigure`, which is what a screen calls); the stylesheet gives it its size
 * where it stands (people/leaders.css `.lfig`: 120 px tall unless its place says otherwise). `motion: 'idle'`
 * breathes, `'attack'` plays the flourish once and goes back to breathing, `'still'` stays a still. `once`: a name
 * for one playing of the flourish (the same name does not play again while it stays on the page). `when: 'look'`:
 * it moves only while the thing that holds it (`[data-nation]`) is hovered, focused or chosen. `shadow: false`
 * leaves out the shadow under the feet. Decorative unless `title` names it. (A figure is never mirrored: Aster's
 * badge, Cinder's clasp and Ember's emblem sit on one side, as the owner's models have them.)
 */
export function stageFigure(faction, { motion = 'idle', once = null, when = null, title = null, shadow = true, cls = '' } = {}) {
  const f = ok(faction) ? faction : 0, { w, h } = STAGE_CELL;
  const m = motion === 'attack' || motion === 'still' ? motion : 'idle';
  const attrs = [`data-leader="${leaderKey(f)}"`, `data-motion="${m}"`, once ? `data-once="${esc(once)}"` : '', when === 'look' ? 'data-when="look"' : '', shadow ? '' : 'data-shadow="0"'].filter(Boolean).join(' ');
  return `<canvas class="lfig${cls ? ` ${esc(cls)}` : ''}" width="${w}" height="${h}" ${attrs} ${a11y(title)}></canvas>`;
}

/** The nation's sigil on its colour, for a place where the leader's picture stands for the nation (attributes only). */
export const nationTrim = f => (ok(f) ? { fill: NATION_FILL[f], dark: NATION_DARK[f], on: NATION_ON[f] } : { fill: '#8a8a80', dark: '#55554e', on: '#fffaf0' });

// ------------------------------------------------------------------ canvases
const images = new Map();
let redraw = () => {};
/** A canvas painter that uses a leader's hexagon asks to be drawn again when the picture arrives. */
export function onLeaderArtLoad(fn) { redraw = typeof fn === 'function' ? fn : () => {}; }
/**
 * The decoded hexagon icon for a canvas (null until it has loaded; the load starts on the first call). On a page
 * the picture is decoded from what the page holds (`holdArt`: the one fetch that also serves the icon in markup),
 * so the map's tag and the crest chip never fetch the same file twice.
 */
export function leaderHexImage(faction) {
  const url = leaderHexUrl(faction);
  const hit = images.get(url);
  if (hit) return hit.ready ? hit.img : null;
  if (typeof globalThis.Image !== 'function') return null;
  const img = new globalThis.Image(), rec = { img, ready: false };
  images.set(url, rec);
  img.onload = () => { rec.ready = true; try { redraw(); } catch { /* the painter is gone */ } };
  img.onerror = () => { rec.ready = false; };
  if (onPage()) holdArt(url).then(data => { if (data) img.src = data; });
  else img.src = url;
  return null;
}
