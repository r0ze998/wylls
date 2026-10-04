// Shared render helpers: the small pieces every panel prints the same way. Everything is built with the `h` builder
// of dom.mjs (text nodes only). `ctx` is `{h, t, lang, index, resolve}`:
//   h        makeH(document)
//   t        a translator bound to the current language (lang.mjs `t`)
//   lang     'en' | 'ja'
//   index    makeRosterIndex(roster) from badges.mjs
//   resolve  (tag, lang, full) → derived name | null  (identity.mjs; optional)
import { badgeOf, badgedSegments, displayNameOf, tagKey } from './badges.mjs';
import { pick } from './lang.mjs';

/** A badge pill. The short text is visible; the long label is the title and the accessible name. */
export function badgeEl(ctx, b, { long = false } = {}) {
  if (!b || b.look === 'none') return null;
  const { h, t } = ctx;
  return h('span', { class: `badge badge-${b.look}`, title: t(b.labelKey), 'aria-label': t(b.labelKey) }, long ? t(b.labelKey) : t(b.shortKey));
}

/** `name` plus its badge (from the roster only), for an actor `{tag?, wallet?}`. */
export function actorEl(ctx, who, { origin = null, fallback = null, long = false } = {}) {
  const { h, t, index, lang, resolve } = ctx;
  const b = badgeOf(index, who, { origin });
  const id = index.identify(who);
  const name = id.kind === 'seat' ? t('roster.seat_heading') : displayNameOf(index, who, lang, { resolve, fallback });
  return h('span', { class: 'actor' },
    h('span', { class: 'actor-name' }, name || t('badge.unlabelled')),
    ' ',
    badgeEl(ctx, b, { long }),
    b.noteKey ? h('span', { class: 'note-chip' }, t(b.noteKey)) : null);
}

/** A code-written line (an episode's text) with the roster badge after each citizen name it contains. */
export function lineEl(ctx, text, entities, { cls = 'line' } = {}) {
  const { h, lang, index, resolve, t } = ctx;
  const body = pick(text, lang);
  const segs = badgedSegments(body, entities, index, lang, { resolve });
  return h('span', { class: cls }, segs.map(s => (s.badge
    ? [' ', h('span', { class: `badge badge-${s.badge}`, title: t(s.labelKey), 'aria-label': t(s.labelKey) }, t(s.shortKey))]
    : s.text)));
}

/** "(p,q)" */
export const placeText = (t, p, q) => t('page.at', { p, q });

/** `n` as a whole number (the page prints integers only). */
export const int = v => (Number.isFinite(Number(v)) ? String(Math.trunc(Number(v))) : '?');

/** Replace `{name}` tokens of an already translated string by DOM nodes (a badge, a name), keeping the text around them. */
export function tplNodes(s, nodes) {
  const out = [];
  let last = 0;
  for (const m of String(s).matchAll(/\{(\w+)\}/g)) {
    out.push(s.slice(last, m.index));
    out.push(nodes[m[1]] ?? m[0]);
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out;
}

/** A key/value row. */
export function kv(ctx, k, v, cls = 'kv') {
  const { h } = ctx;
  return h('div', { class: cls }, h('span', { class: 'k' }, k), ' ', h('span', { class: 'v' }, v));
}

/** A heading with an id for the in-page tab bar. */
export function panelHead(ctx, id, titleKey) {
  const { h, t } = ctx;
  return h('h2', { id: `${id}-title` }, t(titleKey));
}

export { tagKey };
