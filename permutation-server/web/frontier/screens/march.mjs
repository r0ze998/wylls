// The march composer's model (web design §7.6; contract §5.11, §8.3, §9.4,
// I-08, I-27, I-32): the choices a march offers — the retreat ratio from a
// list whose first choice is "never" (0), exactly the three tip presets (no
// zero tip), the four stances — the march under composition as the rules
// check reads it, and the route's line. The order itself is one document,
// written on the map: hud/marchcard.mjs. On the Marches screen this module
// only says how an order is started, or leads back to the one in progress.
import { activeHolding } from '../fstate.mjs';
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { STANCES as STANCE_TEXT, UNITS } from '../fi18n.mjs';
import { STANCES } from '../seal.mjs';
import { RETREAT_CHOICES, tipOptions } from '../fmarch.mjs';
import { UNIT_ORDER } from '../fland.mjs';
import { icon } from '../hud/icons.mjs';

const RETREAT_TEXT = {
  never: () => L`撤退しない`,
  x2: () => L`守り手が自軍の2倍を超えたら撤退`,
  'x1.5': () => L`守り手が自軍の1.5倍を超えたら撤退`,
  x1: () => L`守り手が自軍を超えたら撤退`,
  'x0.5': () => L`守り手が自軍の半分を超えたら撤退`,
  custom: () => L`倍率を指定する`,
};
const TIP_TEXT = { standard: () => L`標準`, decisive: () => L`確実`, maximum: () => L`最大` };

/** The composer's choices as the markup offers them (the tests read these). */

/** The route line with singular and plural forms (wave-5 review: "1 provinces"). */
export function routeLine(route) {
  const n = route.hexes;
  const p = route.provinces.length;
  const m = Math.ceil(route.secs / 60);
  if (n === 1 && p === 1) return L`1 マス · 1 州 · 約 ${m} 分`;
  if (p === 1) return L`${n} マス · 1 州 · 約 ${m} 分`;
  return L`${n} マス · ${p} 州 · 約 ${m} 分`;
}

export function composerChoices(FS) {
  const season = FS.season;
  return {
    retreat: RETREAT_CHOICES.map(c => ({ id: c.id, bps: c.bps, text: RETREAT_TEXT[c.id]() })),
    tips: season ? tipOptions(season).map(o => ({ ...o, text: TIP_TEXT[o.id]() })) : [],
    stances: STANCES.map((s, i) => ({ value: i, id: s, text: STANCE_TEXT[s] })),
  };
}

/** The march under composition as checkMarch reads it. */
export function composerMarch(FS) {
  const c = FS.compose ?? {};
  const h = activeHolding(FS);
  const env = h ? FS.provinces?.get(`${h.p},${h.q}`) : null;
  const host = c.host ?? null;
  return {
    season: FS.season, nowBell: FS.nowBell ?? 0, resolvedNext: env?.province.resolvedNext ?? null, province: env?.province ?? null, now: FS.chain?.now() ?? 0, holding: h ?? null, host,
    dest: c.dest ?? null, route: c.route ?? null, earliest: c.earliest ?? null, arriveBell: c.arriveBell ?? null,
    stance: c.stance ?? 0, retreat: { choice: c.retreat ?? 'never', ratio: c.ratio ?? null }, tip: c.tip ?? null,
  };
}

/**
 * The Marches screen's line about composing: an order in progress leads
 * back to its document on the map; otherwise how one is started.
 */
export function render(FS) {
  const c = FS.compose;
  if (!c?.host) return html`<p class="muted how-line">${icon('banner')}${L`軍勢のカードか地図の軍勢で「進軍させる」を押すと、命令を書けます。`}</p>`;
  return html`<section class="vcard draft-card" aria-labelledby="march-title"><h3 id="march-title">${L`書きかけの命令：${UNITS[UNIT_ORDER[c.host.unit]] ?? ''} ${fmtNum(c.host.troops)}`}</h3>
    <div class="actions"><button type="button" class="btn primary" data-act="sel-open">${icon('seal')}${L`命令を続ける`}</button><button type="button" class="btn quiet" data-act="compose-close">${L`やめる`}</button></div></section>`;
}
