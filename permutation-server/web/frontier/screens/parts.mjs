// The parts every drawer card and document is built from (UX design
// sections 1 and 6): a parchment card's head, a fold ("details": what is
// not the common action waits behind it), a bar, a ring, a chip. Markup
// only: no style attribute anywhere (the page's CSP allows none), so a
// bar's length and a ring's share are SVG geometry and everything else is a
// class of frontier.css.
import { html, raw } from '../../util.mjs';
import { icon } from '../hud/icons.mjs';

const pct = (value, max) => (max > 0 ? Math.max(0, Math.min(100, (Number(value) / Number(max)) * 100)) : 0);
const word = s => String(s ?? '').replace(/[^\w -]/g, '');

/**
 * A card's head: a mark (or a picture: `pic`, a URL), the title in the serif (the `h3` carries `id` for
 * `aria-labelledby`), a line under it and what stands at the right (a chip,
 * a count, a small button).
 */
export function cardHead({ id, ic = null, pic = null, title, sub = '', side = '' }) {
  // (`pic` `{village: {faction, tier, walls}}`: the village as the map draws it, painted into the canvas after the
  // card is on the page: map/village.mjs paintVillagePics; a string is a picture's address)
  const v = pic && typeof pic === 'object' ? pic.village : null;
  const shown = v ? html`<span class="c-pic c-pic-vil"><canvas class="c-vil" width="216" height="168" data-vil="${Number(v.faction) | 0},${Number(v.tier) | 0},${v.walls ? 1 : 0}" aria-hidden="true"></canvas></span>` : pic ? html`<span class="c-pic"><img src="${pic}" alt="" width="176" height="208" decoding="async"></span>` : null;
  return html`<header class="c-head">${shown ? shown : ic ? html`<span class="c-ic">${icon(ic)}</span>` : ''}<span class="c-titles"><h3 ${raw(id ? `id="${word(id)}"` : '')}>${title}</h3>${sub ? html`<span class="c-sub">${sub}</span>` : ''}</span>${side ? html`<span class="c-side">${side}</span>` : ''}</header>`;
}

/** A small heading inside a card (a label with a hairline to the right). */
export const label = (text, side = '') => html`<h4 class="c-label"><span>${text}</span>${side}</h4>`;

/**
 * A fold: `summary` is always in sight, `body` opens on demand. `key` names
 * it (`data-fold`): the page keeps an opened fold open across its periodic
 * re-renders (app.mjs keepState).
 */
export function fold(key, summary, body, { open = false, cls = '' } = {}) {
  return html`<details class="fold${cls ? ` ${word(cls)}` : ''}" data-fold="${word(key)}" ${raw(open ? 'open' : '')}><summary><span class="fold-sum">${summary}</span>${icon('chevron', 'fold-mark')}</summary><div class="fold-body">${body}</div></details>`;
}

/** A chip: a short state word. `tone`: '' | ok | warn | bad | info | you. */
export const chip = (text, tone = '', ic = null) => html`<span class="chip${tone ? ` chip-${word(tone)}` : ''}">${ic ? icon(ic) : ''}${text}</span>`;

/**
 * A state as a stamped word (UX design 11.12: a status is a word pressed on the paper, not a rounded pill): ink in
 * the tone's colour inside a double rule, a little askew, its ink uneven. `tone`: '' | ok | warn | bad | info.
 */
export const stamp = (text, tone = '') => html`<span class="stamp-word${tone ? ` stamp-${word(tone)}` : ''}"><span class="stamp-ink">${text}</span></span>`;

/** A horizontal bar filled to `value / max` (decorative: the number stands beside it). */
export function bar(value, max, cls = '') {
  return raw(`<svg class="bar${cls ? ` ${word(cls)}` : ''}" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="bar-bg" width="100" height="4"/><rect class="bar-fg" width="${pct(value, max).toFixed(1)}" height="4"/></svg>`);
}

/**
 * Two lengths on one track: what was there before (`before / max`) and what
 * is left (`after / max`); the part between them is the loss.
 */
export function lossBar(before, after, max, cls = '') {
  const b = pct(before, max), a = pct(Math.min(after ?? before, before), max);
  return raw(`<svg class="bar bar-loss${cls ? ` ${word(cls)}` : ''}" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="bar-bg" width="100" height="8"/><rect class="bar-lost" width="${b.toFixed(1)}" height="8"/><rect class="bar-fg" width="${a.toFixed(1)}" height="8"/></svg>`);
}

/**
 * A ring that fills clockwise to `share` (0–1); `share` null draws the
 * waiting ring (a quarter arc that turns: frontier.css `.ring-wait`; it
 * stands still under reduced motion and the text beside it says the state).
 */
export function ring(share = null, cls = '') {
  const wait = share === null || share === undefined;
  const k = wait ? 25 : Math.max(0, Math.min(1, Number(share))) * 100;
  return raw(`<svg class="ring${wait ? ' ring-wait' : ''}${cls ? ` ${word(cls)}` : ''}" viewBox="0 0 36 36" aria-hidden="true" focusable="false"><circle class="ring-bg" cx="18" cy="18" r="15" fill="none"/><circle class="ring-fg" cx="18" cy="18" r="15" fill="none" pathLength="100" stroke-dasharray="${k.toFixed(1)} 100" transform="rotate(-90 18 18)"/></svg>`);
}

/** A stepper: one value between an earlier and a later press. `prev` / `next`: `{act, data, label, disabled}`. */
export function stepper({ prev, next, value, cls = '', label: name = '' }) {
  const attrs = d => raw(Object.entries(d ?? {}).map(([k, v]) => `data-${word(k)}="${String(v).replace(/[^\w.-]/g, '')}"`).join(' '));
  const btn = (x, ic, c) => html`<button type="button" class="step-btn ${c}" data-act="${x.act}" ${attrs(x.data)} aria-label="${x.label}" ${raw(x.disabled ? 'disabled' : '')}>${icon(ic)}</button>`;
  return html`<div class="stepper-row${cls ? ` ${word(cls)}` : ''}" role="group" ${raw(name ? `aria-label="${String(name).replace(/[<>&"]/g, '')}"` : '')}>${btn(prev, 'chevron', 'step-prev')}<span class="step-value">${value}</span>${btn(next, 'chevron', 'step-next')}</div>`;
}
