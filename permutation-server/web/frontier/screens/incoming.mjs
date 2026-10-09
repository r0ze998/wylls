// Incoming-arrival warnings (web design §7.7): departures are public
// (origin and arrival turn, never the destination), so for each hostile
// departure that could reach one of the viewer's villages by its arrival
// turn the panel says "on turn b, up to N hosts (M troops) may arrive at
// <village>; where they are going is sealed". The reach test is the kernel's `reachable`
// (optimistic: a "no" is certain, a "yes" is only a warning); without the
// rules module the panel says the warnings are unavailable.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { holdingName } from '../people/ui.mjs';
import { provinceName } from '../hud/place.mjs';
import { icon } from '../hud/icons.mjs';
import { cardHead, chip } from './parts.mjs';

/** The village a warning is about, by its name (`FS` gives its tier); without the store, the province in words. */
const villageOf = (w, FS) => { const h = (FS?.holdings ?? []).find(o => o.p === w.holding.p && o.q === w.holding.q && (w.holding.site === undefined || o.site === w.holding.site)); return h ? holdingName(h) : provinceName(FS, w.holding.p, w.holding.q); };

/** One warning line. The destinations of those hosts are sealed: the line says so and names none. */
export const warningText = (w, FS = null) => L`ターン ${fmtNum(w.bell)} に、${villageOf(w, FS)}へ最大 ${w.hosts} の軍勢（${fmtNum(w.troops)} 兵）が来るかもしれません。行き先は封印中です。`;

export function render(FS) {
  const w = FS.incoming;
  if (w === null || w === undefined) return html`<p class="muted how-line">${icon('alert')}${L`ルールを読み込めていないため、来襲の恐れを調べられません。`}</p>`;
  if (!w.length) return html`<p class="muted how-line">${icon('shield')}${L`いまのところ、あなたの村に届きそうな他国の軍勢は出ていません。`}</p>`;
  return html`<section class="vcard incoming-card" aria-labelledby="incoming-title">
    ${cardHead({ id: 'incoming-title', ic: 'alert', title: L`来襲の恐れ`, side: chip(fmtNum(w.length), 'bad') })}
    <ul class="list incoming">${w.map(x => html`<li class="warn">${warningText(x, FS)}</li>`)}</ul></section>`;
}
