// The HUD's icons (UX design section 6): one authored SVG sprite,
// art/ui/icons.svg, used through <svg><use href>. No Unicode glyph stands in
// for an icon anywhere in the shell: a glyph depends on the device's fonts,
// a sprite does not. The sprite sits beside the three pages (index, practice,
// spectate), so the reference is relative to the document, as in their HTML.
//
// THE HANDOVER ICONS (owner's pack of 2026-10-10, art/README.md): where the season runs the conquest program
// (art/pack.mjs artPackOn) the eight resources and the state marks are the pack's illustrated pictures,
// art/ui/illustrated/<key>-<32|64|128>.webp, in place of the line glyphs. `icon()` swaps them itself for the
// glyph names in ART_OF below, so every strip, cost, card and notice that draws a resource gets the picture and no
// caller changes; `artIcon(key)` gives one of the thirteen by its own name. Navigation and action icons stay the
// sprite's. The pictures' sizes are in art/art.css (linked by script the first time one is drawn).
import { s1On } from '../fs1.mjs';
import { raw } from '../../util.mjs';
import { artPackOn, linkArtCss } from '../art/pack.mjs';

/** The sprite, relative to the page. */
export const SPRITE = 'art/ui/icons.svg';

/** The symbols of the sprite (art/ui/icons.svg), for the tests and for a typo to fail early. */
export const ICONS = Object.freeze([
  'grain', 'wood', 'stone', 'ore', 'horse', 'coin', 'tome', 'crown',
  'bell', 'hourglass', 'alert',
  'sword', 'swords', 'banner', 'flag', 'shield', 'seal', 'scout', 'hammer', 'quill', 'crate', 'moon', 'check',
  'home', 'tent', 'mountain', 'chart', 'compass', 'pin', 'eye', 'search', 'person',
  'speaker', 'speaker-off', 'plus', 'minus', 'close', 'next', 'chevron', 'more', 'scroll', 'lock', 'play', 'flank', 'return',
  'layers', 'list',
  'helmet', 'ranks', 'march', 'tierup', 'disband', 'wall', 'info',
]);

const CLS = /^[\w -]*$/;

/** The thirteen illustrated icons of the handover pack: eight resources, five states. */
export const ART_ICONS = Object.freeze([
  'food', 'wood', 'stone', 'ore', 'horse', 'gold', 'science', 'influence',
  'troops', 'stamina', 'walls', 'works', 'territory',
]);
/** The folder of the pictures, relative to the page (as SPRITE is). */
export const ART_DIR = 'art/ui/illustrated';
/** The glyphs of the sprite that an illustrated icon replaces where the pack is shown: the eight resources, the wall, the helmet of the troops. */
export const ART_OF = Object.freeze({ grain: 'food', wood: 'wood', stone: 'stone', ore: 'ore', horse: 'horse', coin: 'gold', tome: 'science', crown: 'influence', wall: 'walls', helmet: 'troops' });
/** The resources by their names (fi18n RESOURCE_ORDER) and the illustrated icon of each. */
export const RESOURCE_ART = Object.freeze({ Food: 'food', Wood: 'wood', Stone: 'stone', Ore: 'ore', Horses: 'horse', Gold: 'gold', Science: 'science', Influence: 'influence' });

/**
 * One of the thirteen illustrated icons as trusted markup, whether or not the pack is shown (a caller that asks for
 * it by name wants the picture): decorative, the words beside it carry the name and the value. An unknown key is the
 * sprite's crate. The file is the 32 px one, the 64 and 128 px ones for denser screens.
 */
export function artIcon(key, cls = '') {
  if (!ART_ICONS.includes(key)) return icon('crate', cls);
  linkArtCss();
  const base = `${ART_DIR}/${key}`;
  return raw(`<img class="ic ic-art ic-art-${key}${cls && CLS.test(cls) ? ` ${cls}` : ''}" src="${base}-32.webp" srcset="${base}-32.webp 1x, ${base}-64.webp 2x, ${base}-128.webp 4x" width="32" height="32" alt="" aria-hidden="true" decoding="async">`);
}

/** A resource's icon by the resource's name: the picture where the pack is shown, else the sprite's glyph; the crate for a name that is no resource. */
export function resourceIcon(resource, cls = '') {
  // S1: the Horses slot holds arms (no illustrated arms picture yet: the sprite's swords).
  if (resource === 'Horses' && s1On()) return icon('swords', cls);
  return artPackOn() && RESOURCE_ART[resource] ? artIcon(RESOURCE_ART[resource], cls) : icon(RESOURCE_ICON[resource] ?? 'crate', cls);
}

/** An icon as trusted markup: decorative (the control beside it carries the name). */
export function icon(name, cls = '') {
  // (the walls of a village are asked for as a shield in the colour class of the walls: screens/holding.mjs resCoin)
  const art = ART_OF[name] ?? (name === 'shield' && /\bres-c-Walls\b/.test(cls) ? 'walls' : null);
  if (art && artPackOn()) return artIcon(art, cls);
  const id = ICONS.includes(name) ? name : 'compass';
  return raw(`<svg class="ic${cls && CLS.test(cls) ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="${SPRITE}#${id}"/></svg>`);
}

/** The eight resources (fi18n RESOURCE_ORDER) and their icons. */
export const RESOURCE_ICON = Object.freeze({ Food: 'grain', Wood: 'wood', Stone: 'stone', Ore: 'ore', Horses: 'horse', Gold: 'coin', Science: 'tome', Influence: 'crown' });

/** The map buttons (map/fmap.mjs MAP_TOOLS ids) and their icons. */
// (`wide`: the recorded world's key, map/widemode.mjs — a book of records beside its word, like the world chart's sheet)
export const MAP_TOOL_ICON = Object.freeze({ in: 'plus', out: 'minus', home: 'home', chart: 'chart', world: 'chart', wide: 'tome' });

/**
 * Give the map buttons their icons (a DOM page only): the map class mounts
 * `[data-map]` buttons with a text glyph; the shell swaps the glyph for the
 * sprite icon and leaves the button, its name and its handler alone.
 */
export function iconizeMapTools(root = globalThis.document) {
  for (const b of root?.querySelectorAll?.('.map-btn[data-map]') ?? []) {
    const name = MAP_TOOL_ICON[b.dataset.map];
    if (!name || b.querySelector('svg.ic')) continue;
    const tpl = root.createElement ? root.createElement('template') : b.ownerDocument.createElement('template');
    tpl.innerHTML = String(icon(name));
    // (a key that says its name in a word keeps that word beside the icon: map/fmap.mjs `.map-btn-text`)
    const word = b.querySelector('.map-btn-text');
    b.replaceChildren(tpl.content, ...(word ? [word] : []));
  }
}

/**
 * (fix-loop5, B-13) An illustrated icon whose picture did not load — the page's server was out of reach for a moment
 * (loop-play5: 36 `ERR_CONNECTION_REFUSED` for `art/ui/illustrated/*-32.webp` during a launcher blip) — stayed blank:
 * the resource strip read 「1,240 1,030 820」 with no icons until a reload, as Chromium keeps the failed picture. A failed
 * `img.ic-art` is asked again, with a retry mark in its address, up to ART_RETRIES times a few seconds apart; then it
 * gives way to the sprite's glyph. `doc`: the page's document (none: nothing is watched). → the way to stop watching.
 */
export const ART_RETRIES = 3, ART_RETRY_MS = 4000;
export function watchArtIcons(doc = globalThis.document, { later = (f, ms) => setTimeout(f, ms) } = {}) {
  if (!doc?.addEventListener) return () => {};
  const onError = e => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList?.contains('ic-art')) return;
    const n = Number(img.dataset.artTry ?? 0);
    if (n >= ART_RETRIES) {
      // (the sprite's glyph of the same thing: ART_OF maps glyph → picture; the crate when none)
      const key = /\bic-art-([\w-]+)/.exec(img.className)?.[1] ?? '';
      const glyph = Object.keys(ART_OF).find(g => ART_OF[g] === key && ICONS.includes(g)) ?? 'crate';
      const cls = img.className.split(/\s+/).filter(c => c && c !== 'ic' && !c.startsWith('ic-art')).join(' ');
      const tpl = doc.createElement('template');
      tpl.innerHTML = `<svg class="ic${cls && CLS.test(cls) ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="${SPRITE}#${glyph}"/></svg>`;
      if (tpl.content.firstChild) img.replaceWith(tpl.content.firstChild);
      return;
    }
    img.dataset.artTry = String(n + 1);
    later(() => {
      if (!img.isConnected) return;
      const again = u => (u ? u.replace(/([?&])r=\d+/, '').replace(/(\.webp)(\?)?/, `$1?r=${n + 1}&`).replace(/[?&]$/, '') : u);
      const set = img.getAttribute('srcset');
      if (set) img.setAttribute('srcset', set.split(',').map(x => { const [u, d] = x.trim().split(/\s+/); return `${again(u)} ${d ?? ''}`.trim(); }).join(', '));
      img.setAttribute('src', again(img.getAttribute('src')));
    }, ART_RETRY_MS * (n + 1));
  };
  doc.addEventListener('error', onError, true);
  return () => doc.removeEventListener('error', onError, true);
}
