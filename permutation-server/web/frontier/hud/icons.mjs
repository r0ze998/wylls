// The HUD's icons (UX design section 6): one authored SVG sprite,
// art/ui/icons.svg, used through <svg><use href>. No Unicode glyph stands in
// for an icon anywhere in the shell: a glyph depends on the device's fonts,
// a sprite does not. The sprite sits beside the three pages (index, practice,
// spectate), so the reference is relative to the document, as in their HTML.
import { raw } from '../../util.mjs';

/** The sprite, relative to the page. */
export const SPRITE = 'art/ui/icons.svg';

/** The symbols of the sprite (art/ui/icons.svg), for the tests and for a typo to fail early. */
export const ICONS = Object.freeze([
  'grain', 'wood', 'stone', 'ore', 'horse', 'coin', 'tome', 'crown',
  'bell', 'hourglass', 'alert',
  'sword', 'swords', 'banner', 'flag', 'shield', 'seal', 'scout', 'hammer', 'quill', 'crate', 'moon', 'check',
  'home', 'tent', 'mountain', 'chart', 'compass', 'pin', 'eye', 'search', 'person',
  'speaker', 'speaker-off', 'plus', 'minus', 'close', 'next', 'chevron', 'more', 'scroll', 'lock', 'play', 'flank', 'return',
]);

const CLS = /^[\w -]*$/;

/** An icon as trusted markup: decorative (the control beside it carries the name). */
export function icon(name, cls = '') {
  const id = ICONS.includes(name) ? name : 'compass';
  return raw(`<svg class="ic${cls && CLS.test(cls) ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="${SPRITE}#${id}"/></svg>`);
}

/** The eight resources (fi18n RESOURCE_ORDER) and their icons. */
export const RESOURCE_ICON = Object.freeze({ Food: 'grain', Wood: 'wood', Stone: 'stone', Ore: 'ore', Horses: 'horse', Gold: 'coin', Science: 'tome', Influence: 'crown' });

/** The map buttons (map/fmap.mjs MAP_TOOLS ids) and their icons. */
export const MAP_TOOL_ICON = Object.freeze({ in: 'plus', out: 'minus', home: 'home', chart: 'chart', world: 'chart' });

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
    b.replaceChildren(tpl.content);
  }
}
