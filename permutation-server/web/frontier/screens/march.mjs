// The march composer's model (web design §7.6; contract §5.11, §8.3, §9.4,
// I-08, I-27, I-32): the choices a march offers — the retreat ratio from a
// list whose first choice is "never" (0), exactly the three tip presets (no
// zero tip), the four stances — the march under composition as the rules
// check reads it, and the route's line. The order itself is one document,
// written on the map: hud/marchcard.mjs. On the Marches screen this module
// only says how an order is started, or leads back to the one in progress.
import { activeHolding } from '../fstate.mjs';
import { html } from '../../util.mjs';
import { L } from '../../lang.mjs';
import { STANCES as STANCE_TEXT, unitCount } from '../fi18n.mjs';
import { STANCES } from '../seal.mjs';
import { RETREAT_CHOICES, tipOptions, arrivalWindow, earliestBell, DEPART_MARGIN_SECS } from '../fmarch.mjs';
import { UNIT_ORDER, holdingByRef, ticketTimes } from '../fland.mjs';
import { bellStart, bellAt } from '../clock.mjs';
import { icon } from '../hud/icons.mjs';

/** The planner's answers that mean "no legal route" (fmarch.planRoute): the order card then offers the reach list (hud/marchcard.mjs). */
export const NO_ROUTE = Object.freeze(['NoPath', 'Path']);

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

/** The minutes a route takes on foot (rounded up): said once, in the order's line about the arrival turn. */
export const routeMinutes = route => Math.ceil(Number(route?.secs ?? 0) / 60);

/**
 * How far the destination is, in one short line: 「4 マス先」 / "4 tiles away" (singular and plural forms). The
 * minutes of the way are not here: the order says them once, where it explains the arrival turn (UX design 11.13).
 */
export function routeLine(route) {
  const n = route.hexes;
  return n === 1 ? L`1 マス先` : L`${n} マス先`;
}

export function composerChoices(FS) {
  const season = FS.season;
  return {
    retreat: RETREAT_CHOICES.map(c => ({ id: c.id, bps: c.bps, text: RETREAT_TEXT[c.id]() })),
    tips: season ? tipOptions(season).map(o => ({ ...o, text: TIP_TEXT[o.id]() })) : [],
    stances: STANCES.map((s, i) => ({ value: i, id: s, text: STANCE_TEXT[s] })),
  };
}

/**
 * The draft's current arrival choice. An expired choice follows the first
 * reachable turn; a still-valid later choice stays put. Every surface and
 * the sender use this same value. Once sealing starts its timing is fixed.
 */
export function composerArrival(FS) {
  const c = FS.compose;
  if (!c || !FS.season) return null;
  if (c.sending && c.sendingArrival) return c.sendingArrival;
  const now = FS.chain?.now?.() ?? 0;
  const nowBell = FS.clock && FS.chain ? bellAt(FS.clock.genesisTs, now) ?? 0 : FS.nowBell ?? 0;
  const fresh = FS.clock && FS.kernel && c.route ? earliestBell(FS.kernel, {
    genesisTs: FS.clock.genesisTs, departTs: now + DEPART_MARGIN_SECS, secs: c.route.secs,
  }) : null;
  const earliest = fresh ?? c.earliest ?? null;
  const w = arrivalWindow(FS.season, nowBell, earliest);
  return { ...w, value: Math.min(w.max, Math.max(w.min, c.arriveBell ?? w.min)), earliest, nowBell, now };
}

/** The march under composition as checkMarch reads it. */
export function composerMarch(FS, arrival = composerArrival(FS)) {
  const c = FS.compose ?? {};
  const h = c.holding ? holdingByRef(FS.holdings,c.holding) : activeHolding(FS);
  const origin = c.origin ?? h;
  const env = origin ? FS.provinces?.get(`${origin.p},${origin.q}`) : null;
  const host = c.host ?? null;
  return {
    season: FS.season, nowBell: arrival?.nowBell ?? FS.nowBell ?? 0, resolvedNext: env?.province.resolvedNext ?? null, province: env?.province ?? null, now: arrival?.now ?? FS.chain?.now() ?? 0, holding: h ?? null, host,
    dest: c.dest ?? null, route: c.route ?? null, earliest: arrival?.earliest ?? c.earliest ?? null, arriveBell: arrival?.value ?? c.arriveBell ?? null,
    stance: c.stance ?? 0, retreat: { choice: c.retreat ?? 'never', ratio: c.ratio ?? null }, tip: c.tip ?? null,
  };
}

/** Arrival starts a shared turn; resolution follows its end and reveal window. */
export function marchTiming(FS, arriveBell) {
  if (!FS.clock || !Number.isInteger(arriveBell)) return null;
  const now = FS.chain?.now?.() ?? 0;
  const arrivalAt = bellStart(FS.clock.genesisTs, arriveBell);
  const resultAbout = ticketTimes(FS.clock, arriveBell).resultAbout;
  return { arrivalAt, resultAbout, arrivalIn: Math.max(0, arrivalAt - now), resultIn: Math.max(0, resultAbout - now) };
}

/**
 * The Marches screen's line about composing: an order in progress leads
 * back to its document on the map; otherwise how one is started.
 */
export function render(FS) {
  const c = FS.compose;
  if (!c?.host) return html`<p class="muted how-line">${icon('banner')}${L`軍勢のカードか地図の軍勢で「進軍させる」を押すと、命令を書けます。`}</p>`;
  return html`<section class="vcard draft-card" aria-labelledby="march-title"><h3 id="march-title">${L`書きかけの命令：${unitCount(UNIT_ORDER[c.host.unit], c.host.troops)}`}</h3>
    <div class="actions"><button type="button" class="btn primary" data-act="sel-open">${icon('seal')}${L`命令を続ける`}</button><button type="button" class="btn quiet" data-act="compose-close">${L`やめる`}</button></div></section>`;
}
