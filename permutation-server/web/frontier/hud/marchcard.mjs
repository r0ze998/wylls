// The sealed order (UI plan B1–B4; UX design sections 1 and 6; Civ's
// move-and-attack preview): a march is written on the map as one document.
// Choose a host ("march" on its card or in the inspector), tap a tile — the
// destination is set at once — and the order shows everything the decision
// needs in one place:
//   where to (the place by its name and how far it is), sealed: nobody else
//   can open the seal until the arrival turn ends (`SEAL_LINE`, the one
//   sentence the legend and the help also say);
//   the arrival turn as a stepper over the window, with the local time, and
//   one line that reconciles it with the length of the way (marches arrive
//   together as a turn begins: a short way still waits for its turn);
//   the four stances and the retreat sizes as pictures to choose from;
//   the defenders frozen at the destination as the bell starts (from the
//   province the page holds), a rough odds word from the troop ratio
//   (honestly labelled a guide) and the rules' forecast behind a fold;
//   "seal and depart" under a wax seal.
// What few need waits behind one fold: the tip preset, a retreat ratio of
// one's own, the destination by coordinates (keyboard and screen readers).
import { html, raw } from '../../util.mjs';
import { icon } from './icons.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { STANCES as STANCE_TEXT, unitCount, clientText, failureText, factionName } from '../fi18n.mjs';
import { STANCES } from '../seal.mjs';
import { RETREAT_CHOICES, arrivalWindow, checkMarch, troopsOf, SEND_STEPS, DEPART_STAMINA, staminaAt } from '../fmarch.mjs';
import { UNIT_ORDER } from '../fland.mjs';
import { bellStart, bellAt } from '../clock.mjs';
import { composerMarch, composerArrival, composerChoices, routeLine, marchTiming, NO_ROUTE } from '../screens/march.mjs';
import { swatch } from '../screens/shell.mjs';
import { keepFor, reachLink } from '../screens/conquest.mjs';
import { territoryEnabled } from '../territory.mjs';
import { fold, label, stepper, bar } from '../screens/parts.mjs';
import { DIRECTIONS, tileHex } from '../fgeo.mjs';
import { termButton, sealLine } from './glossary.mjs';
import { marchLine as protoMarchLine } from './proto.mjs';
import { previewOf as protoPreviewOf, fights as protoFights, turnWallSecs as protoTurnSecs, aboutTime as protoAbout, ownArrivalAt as protoOwnArrivalAt } from '../proto/hand-model.mjs';
import { tileName, provinceCoords } from './place.mjs';
import { conquestOn, crest, holdTurns } from './keephand.mjs';
import { STANCE_PIC, RETREAT_PIC, sealPic } from './pictos.mjs';
import { miniCardUrl, MINI_KINDS } from '../people/minis.mjs';
import { compareKey, forecastKey } from './forecast.mjs';

const BEATS = { Assault: 'Flank', Flank: 'Brace', Brace: 'Assault' };
const RETREAT_SHORT = { never: () => L`撤退しない`, x2: () => L`2倍で撤退`, 'x1.5': () => L`1.5倍で撤退`, x1: () => L`同数で撤退`, 'x0.5': () => L`半分で撤退`, custom: () => L`倍率を指定する` };
/** The same in a word or two, under the picture (the group's name says "retreat"). */
const RETREAT_TAG = { never: () => L`しない`, x2: () => L`2倍`, 'x1.5': () => L`1.5倍`, x1: () => L`同数`, 'x0.5': () => L`半分` };
const RETREAT_LONG = {
  never: () => L`守り手が何人いても戦います。`,
  x2: () => L`守り手が自軍の2倍を超えていたら、戦わずに引き返します（損失なし）。`,
  'x1.5': () => L`守り手が自軍の1.5倍を超えていたら、戦わずに引き返します（損失なし）。`,
  x1: () => L`守り手が自軍を超えていたら、戦わずに引き返します（損失なし）。`,
  'x0.5': () => L`守り手が自軍の半分を超えていたら、戦わずに引き返します（損失なし）。`,
  custom: () => L`守り手が自軍のこの倍率を超えていたら、戦わずに引き返します（損失なし）。`,
};
const TIP_TEXT = { standard: () => L`標準`, decisive: () => L`確実`, maximum: () => L`最大` };
const STEP_TEXT = { sealing: () => L`封をしています`, saved: () => L`この端末に保存`, sent: () => L`送信`, onChain: () => L`ゲームに記録` };

/** The route as hexes (axial q, r) from the origin tile, following the planner's directions. */
export function routeHexes(c) {
  if (!c?.route?.dirs || !c.origin || !c.host) return [];
  const s = tileHex(c.origin.p, c.origin.q, c.host.tile);
  if (!s) return [];
  const out = [{ q: s.q, r: s.r }];
  let q = s.q, r = s.r;
  for (const d of c.route.dirs) { const v = DIRECTIONS[d]; if (!v) break; q += v[0]; r += v[1]; out.push({ q, r }); }
  return out;
}

/**
 * The defenders frozen at the destination (the province the page holds):
 * `{residents: [{faction, troops}], garrison, camp, total}` in whole troops.
 * A guide only: the roster freezes at the start of the arrival bell.
 */
export function defendersAt(FS, dest) {
  const prov = dest ? FS.provinces?.get(`${dest.p},${dest.q}`)?.province : null;
  if (!prov) return null;
  const residents = (prov.entries ?? []).filter(e => e.state === 1 && e.tile === dest.tile && e.faction !== FS.citizen?.faction).map(e => ({ faction: e.faction, troops: troopsOf(e.troops) }));
  const j = Array.from(prov.sites ?? []).indexOf(dest.tile);
  const m = j >= 0 ? prov.siteMirror?.[j] : null;
  const garrison = m && m.state === 1 && m.faction !== FS.citizen?.faction ? troopsOf(m.garrison) : 0;
  const camp = prov.camp?.state === 1 && prov.camp.tile === dest.tile ? Number(prov.camp.troops) : 0;
  const k = territoryEnabled(FS) ? null : keepFor(FS, dest.p, dest.q);
  const keep = k?.tile === dest.tile && k.holder !== FS.citizen?.faction ? Number(k.troops ?? 0) : 0;
  return { residents, garrison, camp, keep, total: residents.reduce((a, r) => a + r.troops, 0) + garrison + camp + keep };
}

/** A guide word from the troop ratio (attacker ÷ defenders): no defenders → "unopposed". */
export function oddsWord(mine, theirs) {
  if (!theirs) return { id: 'free', text: L`守り手なし` };
  const k = mine / theirs;
  if (k >= 2) return { id: 'strong', text: L`優勢` };
  if (k >= 1.25) return { id: 'edge', text: L`やや優勢` };
  if (k >= 0.8) return { id: 'even', text: L`互角` };
  if (k >= 0.5) return { id: 'weak', text: L`やや不利` };
  return { id: 'bad', text: L`不利` };
}

/** The arrival options the stepper walks: the window from the earliest bell. */
export function bellWindow(FS) {
  const a = composerArrival(FS);
  return a ? { min: a.min, max: a.max, value: a.value } : null;
}

/** The fates of fi18n.mjs FATES in the future tense (the same words: one vocabulary for an outcome). */
const FATE_SHORT = { Stays: () => L`戦場に残る`, Withdrew: () => L`隣へ退く`, Bounced: () => L`村へ押し戻される`, Retreated: () => L`撤退する`, Destroyed: () => L`壊滅する` };
/** The rules' forecast (hud/forecast.mjs): troops left worst–best, how often each fate came up. */
export function renderForecast(fc) {
  if (!fc) return '';
  if (fc.pending) return html`<p class="muted mc-fc">${L`ルールで結果の幅を計算しています…`}</p>`;
  if (!fc.ok) return '';
  const fates = Object.entries(fc.fates).sort((a, b) => b[1] - a[1]);
  return html`<div class="mc-fc"><p><strong>${fc.troops.min === fc.troops.max ? L`残る兵 ${fmtNum(fc.troops.min)}` : L`残る兵 ${fmtNum(fc.troops.min)}〜${fmtNum(fc.troops.max)}`}</strong> <span class="muted">${L`（出発時 ${fmtNum(fc.troops.start)}）`}</span></p>
    <ul class="mc-fates">${fates.map(([k, n]) => html`<li class="mc-fate-${k}">${bar(n, fc.runs)}<span>${FATE_SHORT[k]?.() ?? k}</span><span class="muted">${L`${fmtNum(n)}/${fmtNum(fc.runs)}回`}</span></li>`)}</ul>
    <p class="muted">${L`ルールで${fmtNum(fc.runs)}回試した結果の幅です。ほかの軍勢の到着は封印中のため、数えていません。`}${fc.certain ? '' : html` ${L`このターンは野営地の見直しがあるため、守り手が変わるかもしれません。`}`}</p></div>`;
}

/**
 * The order's forecast as the card may show it: the one made for the order as it stands (its key), else "being
 * made" while a route is still coming, else none. A new destination keeps the old forecast object until its own is
 * made (the route is found first); the independent review of 2026-10-24 found the outlook showing the last
 * destination's 残る兵 beside the new one's defenders, and for good when the new route failed.
 */
export const forecastNow = c => (c?.forecast && c.forecast.key === forecastKey(c) ? c.forecast : c?.forecast && !c.routeError ? { pending: true } : null);

/**
 * The stances compared as the card may show them: by their own key alone, which leaves the stance out, so choosing a
 * stance keeps the table standing (and the keyboard's focus on its row). They waited for the chosen stance's own
 * forecast too, and fell back to the plain pictures while it was made (the same review).
 */
export const compareNow = c => (c?.compare && c.compare.key === compareKey(c) ? c.compare : null);

/** A forecast's range of troops left, as words: "310〜470" or "388". */
const leftText = fc => (fc.troops.min === fc.troops.max ? fmtNum(fc.troops.min) : L`${fmtNum(fc.troops.min)}〜${fmtNum(fc.troops.max)}`);
/** A forecast's most frequent fate. */
const topFate = fc => Object.entries(fc.fates ?? {}).sort((a, b) => b[1] - a[1])[0] ?? null;

/**
 * The order's outlook (docs/design/uplift/02-CORE-FLOW: what the decision needs, in one look before the details):
 * when it arrives, what it costs the host, who is there, and the rules' forecast, tagged 予測 so it is never read as
 * a result. Each cell says where its figure comes from in one short line.
 */
export function outlook({ w, awayLine, stam, nowB, def, odds, fc, sight }) {
  const cell = (k, v, note, cls = '') => html`<div class="mo-cell ${cls}"><span class="mo-k">${k}</span><strong class="mo-v">${v}</strong>${note ? html`<span class="mo-n">${note}</span>` : ''}</div>`;
  const next = stam !== null && stam >= DEPART_STAMINA ? L`次はターン ${fmtNum(nowB + Math.max(0, 2 * DEPART_STAMINA - stam))} から` : '';
  const foe = def ? (def.total ? L`守り ${fmtNum(def.total)}` : L`守り手なし`) : L`わからない`;
  const foeNote = def ? (def.total ? odds?.text ?? '' : '') : sight < 3 ? L`見えていない土地` : '';
  // (a forecast of a march nobody opposes says only that the host arrives whole: no cell for it)
  const fcCell = !def?.total ? '' : fc?.pending ? cell(html`<span class="state-tag state-forecast">${L`予測`}</span>`, L`計算中…`, '', 'mo-fc')
    : fc?.ok ? cell(html`<span class="state-tag state-forecast">${L`予測`}</span>`, L`残る兵 ${leftText(fc)}`, L`ルールで ${fmtNum(fc.runs)} 回試した幅`, 'mo-fc')
    : fc?.why === 'OutOfSight' ? cell(html`<span class="state-tag state-forecast">${L`予測`}</span>`, L`出しません`, L`見えていない土地です（ほかの軍勢がいるかわかりません）`, 'mo-fc')
    : fc ? cell(html`<span class="state-tag state-forecast">${L`予測`}</span>`, L`見込みはまだ出せません`, L`行き先の州の記録がそろうと出ます`, 'mo-fc') : '';
  return html`<div class="mc-outlook" role="group" aria-label="${L`この命令の見通し`}">
    ${w ? cell(L`到着`, L`ターン ${fmtNum(w.value)}`, awayLine) : ''}
    ${cell(L`費用`, L`体力 −${fmtNum(DEPART_STAMINA)}`, next)}
    ${cell(L`相手`, foe, foeNote)}
    ${fcCell}</div>`;
}

/**
 * The four stances compared by the rules' forecast (hud/forecast.mjs compareStances): each row is the stance's
 * button, with what it is strong against, the range of troops left and the fate that came up most. The chosen
 * stance's row is pressed. Falls back to the plain pictures while the comparison is not there.
 */
export function stanceCompare(value, cmp) {
  const rows = cmp?.rows;
  if (!rows?.length || !rows.some(r => r.ok)) return stancePicks(value);
  const cap = s => (BEATS[s] ? L`${STANCE_TEXT[BEATS[s]]}に強い` : L`相性なし`);
  // (the whole table is a forecast: the tag stands over it, not on one column, so 「戦場に残る」 is never read as a
  // result: the design review of 2026-10-24)
  return html`<div class="mc-compare" role="radiogroup" aria-label="${L`構えを比べる（予測）`}">
    <p class="mcc-cap"><span class="state-tag state-forecast">${L`予測`}</span><span>${L`構えごとに、ルールで試した見込み`}</span></p>
    <div class="mcc-head" aria-hidden="true"><span>${L`構え`}</span><span>${L`残る兵`}</span><span>${L`多かった結果`}</span></div>
    ${rows.map(r => {
      const s = STANCES[r.stance], f = r.ok ? topFate(r) : null;
      return html`<button type="button" class="mcc-row" role="radio" aria-checked="${r.stance === value ? 'true' : 'false'}" data-act="mc-stance" data-v="${r.stance}">
        <span class="mcc-stance">${STANCE_PIC[s]?.() ?? ''}<span><b>${STANCE_TEXT[s]}</b><small>${cap(s)}</small></span></span>
        <span class="mcc-left">${r.ok ? leftText(r) : '—'}</span>
        <span class="mcc-fate">${f ? html`${FATE_SHORT[f[0]]?.() ?? f[0]} <small>${L`${fmtNum(r.runs)}回中${fmtNum(f[1])}回`}</small>` : '—'}</span></button>`;
    })}
    ${rows.every(r => r.ok && r.troops.min === rows[0].troops?.min && r.troops.max === rows[0].troops?.max) ? html`<p class="mcc-same">${L`この相手には、構えを変えても結果の幅は同じです。`}</p>` : ''}
    <p class="muted mcc-note">${L`構えごとに、ルールで ${fmtNum(rows[0].runs ?? 0)} 回ずつ試した幅です。同じターンに着くほかの進軍は封印中のため、数えていません。`}</p></div>`;
}

/** The stances as pictures: `{act}` makes them buttons (the order), else radio buttons bound to `bind` (a form). */
export function stancePicks(value, { act = 'mc-stance', bind = null } = {}) {
  const cap = s => (BEATS[s] ? L`${STANCE_TEXT[BEATS[s]]}に強い` : L`相性なし`);
  return html`<div class="picks picks-4" role="radiogroup" aria-label="${L`構え`}">${STANCES.map((s, i) => (bind
    ? html`<label class="pick"><input type="radio" name="stance" data-bind="${bind}" value="${i}" ${raw(i === value ? 'checked' : '')}>${STANCE_PIC[s]?.() ?? ''}<span class="pick-name">${STANCE_TEXT[s]}</span><span class="pick-note">${cap(s)}</span></label>`
    : html`<button type="button" class="pick" role="radio" aria-checked="${i === value ? 'true' : 'false'}" data-act="${act}" data-v="${i}">${STANCE_PIC[s]?.() ?? ''}<span class="pick-name">${STANCE_TEXT[s]}</span><span class="pick-note">${cap(s)}</span></button>`))}</div>`;
}

/** The retreat sizes as pictures (the five presets): buttons of the order, or radio buttons bound to `bind`. */
export function retreatPicks(value, { act = 'mc-retreat', bind = null } = {}) {
  const list = RETREAT_CHOICES.filter(r => r.id !== 'custom');
  return html`<div class="picks picks-5" role="radiogroup" aria-label="${L`撤退`}">${list.map(r => (bind
    ? html`<label class="pick" title="${RETREAT_SHORT[r.id]()}"><input type="radio" name="retreat" data-bind="${bind}" value="${r.id}" aria-label="${RETREAT_SHORT[r.id]()}" ${raw(r.id === value ? 'checked' : '')}>${RETREAT_PIC[r.id]?.() ?? ''}<span class="pick-name" aria-hidden="true">${RETREAT_TAG[r.id]()}</span></label>`
    : html`<button type="button" class="pick" role="radio" aria-checked="${r.id === value ? 'true' : 'false'}" aria-label="${RETREAT_SHORT[r.id]()}" title="${RETREAT_SHORT[r.id]()}" data-act="${act}" data-v="${r.id}">${RETREAT_PIC[r.id]?.() ?? ''}<span class="pick-name" aria-hidden="true">${RETREAT_TAG[r.id]()}</span></button>`))}</div>`;
}
export const retreatLine = id => RETREAT_LONG[id]?.() ?? '';

/** The destination by coordinates (the list alternative of the map: keyboard and screen readers). */
function coordsForm(c) {
  return html`<form class="inline" data-form="dest"><label>P<input name="p" type="number" inputmode="numeric" value="${c.dest?.p ?? ''}"></label><label>Q<input name="q" type="number" inputmode="numeric" value="${c.dest?.q ?? ''}"></label>
    <label>${L`マス`}<input name="tile" type="number" min="0" max="60" inputmode="numeric" value="${c.dest?.tile ?? ''}"></label><button type="submit" class="btn">${L`決める`}</button></form>`;
}

/** The order (the drawer while a march is composed). */
export function render(FS) {
  const c = FS.compose;
  if (!c?.host) return '';
  const w = composerArrival(FS);
  const m = composerMarch(FS, w);
  // how far off the arrival is, in minutes from now: the one other time on the card, and it counts as the dial does
  // (the second review: the arrival turn, a bare clock time and the road's minutes stood beside a dial at 9:12)
  const nowTs = FS.chain?.now?.() ?? null;
  const away = w && FS.clock && Number.isFinite(nowTs) ? Math.max(1, Math.round((bellStart(FS.clock.genesisTs, w.value) - nowTs) / 60)) : null;
  // (the banner prototype says its counts by the sample world's own, faster clock — 「（約16秒）」 — and this card said
  // the same wait in the game's minutes beside them, 「約 19 分後」: two clocks on one screen. While the prototype is
  // on, this line is said in the clock its lines use)
  // (counted in whole turns from the turn that runs now, so the words change at a toll and not every second: a card
  // whose words change every second is laid out again every second, under the finger that presses its seal)
  const wallTurn = FS.proto ? protoTurnSecs(FS) : null;
  const awayWall = w && Number.isInteger(FS.nowBell) && wallTurn !== null ? Math.max(1, w.value - FS.nowBell) * wallTurn : null;
  const awayLine = !FS.proto ? (away !== null ? L`約 ${fmtNum(away)} 分後` : '') : awayWall !== null ? L`${protoAbout(awayWall)}後` : '';
  // (the forecast follows the survey like every other surface: of a tile the viewer does not have in sight the card
  // says no number of defenders. The second review: 「守り手なし · 守り 0」 for a tile the map draws as unsurveyed)
  const sight = c.dest && FS.survey && !FS.survey.showAll ? FS.survey.levelOf(c.dest.p, c.dest.q, c.dest.tile) : 3;
  // (a conquest keep's holder and defenders are the season's public record: on the keep's own tile they are said even
  // of land the viewer does not see; the hosts that may stand there are not, and the card says so)
  const destKeep = c.dest && !territoryEnabled(FS) ? (k => (k && k.tile === c.dest.tile ? k : null))(keepFor(FS, c.dest.p, c.dest.q)) : null;
  const keepOnly = !!destKeep && sight < 3 && destKeep.holder !== FS.citizen?.faction;
  const def = c.dest && sight >= 3 ? defendersAt(FS, c.dest) : keepOnly ? { residents: [], garrison: 0, camp: 0, keep: Number(destKeep.troops ?? 0), total: Number(destKeep.troops ?? 0) } : null;
  const odds = c.dest && def ? oddsWord(c.host.troops, def.total) : null;
  const problems = c.dest ? checkMarch(m).filter(p => p !== 'NoDestination') : [];
  const busy = !!c.sending;
  const timing = marchTiming(FS, m.arriveBell);
  // when the result is known, in turns like the dial and the arrival, and the wait in the arrival line's own clock:
  // 「結果はターン 46 ごろ（約 40 分後）」. It said 「結果の目安まで 40:26（ゲーム内）」: a second kind of time on the card,
  // ticking every second, with a note that only a faster test clock needs (07-HUD-TEXT-FX). ごろ: the result is drawn at
  // the arrival turn's end plus the reveal window, rounded to a beacon round (fland.mjs ticketTimes)
  const resultTurn = timing && FS.clock ? bellAt(FS.clock.genesisTs, timing.resultAbout) : null;
  const resultWait = !timing ? ''
    : !FS.proto ? L`約 ${fmtNum(Math.max(1, Math.round(timing.resultIn / 60)))} 分後`
    : wallTurn !== null && Number.isInteger(resultTurn) && Number.isInteger(FS.nowBell) ? L`${protoAbout(Math.max(1, resultTurn - FS.nowBell) * wallTurn)}後` : '';
  const resultLine = !Number.isInteger(resultTurn) ? '' : resultWait ? L`結果はターン ${fmtNum(resultTurn)} ごろ（${resultWait}）` : L`結果はターン ${fmtNum(resultTurn)} ごろ`;
  const stance = STANCES[m.stance] ?? 'Hold';
  const ch = composerChoices(FS);
  const from = tileName(FS, c.origin.p, c.origin.q, c.host.tile);
  const faction = FS.citizen?.faction;
  const headBlock = html`<header class="order-head">${sealPic(46)}<span class="order-titles"><span class="order-kicker">${L`封をした命令`}</span>
    <h3 id="mc-title">${L`進軍：${unitCount(UNIT_ORDER[c.host.unit], c.host.troops)}`}</h3><span class="c-sub">${L`${from}から`}</span></span>
    ${Number.isInteger(faction) && MINI_KINDS[c.host.unit] ? html`<img class="unit-card order-unit f${faction}" src="${miniCardUrl(faction, MINI_KINDS[c.host.unit])}" alt="" width="40" height="50" decoding="async">` : ''}</header>`;
  const quick = (c.quick ?? []).filter(q => !(q.p === c.origin.p && q.q === c.origin.q && q.tile === c.host.tile));
  // a nearby destination by its name; only two of the same name are told apart by their provinces
  const quickNames = quick.map(q => tileName(FS, q.p, q.q, q.tile));
  const quickText = (q, i) => (quickNames.filter(n => n === quickNames[i]).length > 1 ? L`${quickNames[i]}（${provinceCoords(q.p, q.q)}）` : quickNames[i]);
  const quickList = quick.length ? html`${label(L`近くの行き先`)}<ul class="quick-dest">${quick.map((q, i) => html`<li><button type="button" class="btn small" data-act="dest-quick" data-p="${q.p}" data-q="${q.q}" data-tile="${q.tile}">${icon(q.kind === 'camp' ? 'tent' : 'home')}${quickText(q, i)}</button></li>`)}</ul>` : '';
  // the order's last lines stay in sight whatever the drawer's height (UX design 11.12): one line that sums the order
  // up — where to, the arrival turn, the stance — then the seal; a press on the line shows the whole order
  const foot = (sum, acts) => html`<footer class="order-foot">${sum}<div class="actions order-acts">${acts}</div></footer>`;
  if (!c.dest) {
    return html`<section class="order order-empty" aria-labelledby="mc-title"><div class="order-body" data-scroll="order">${headBlock}
      <p class="mc-hint">${icon('pin')}${L`地図で行き先のマスを選んでください。`}</p>
      <p class="muted">${L`光っているマスが、この軍勢の届く目安です。`}</p>
      ${quickList}
      ${fold('o-coords', L`座標で指定する`, coordsForm(c))}</div>
      ${foot(html`<button type="button" class="order-sum order-sum-empty" data-act="order-open">${icon('pin', 'os-ic')}<span class="os-main">${L`行き先はまだ決まっていません`}</span>${icon('chevron', 'os-go')}</button>`,
        html`<button type="button" class="btn" data-act="compose-close">${L`やめる`}</button>`)}
    </section>`;
  }
  const custom = m.retreat.choice === 'custom';
  // the prototype rule "banners" (only in a sample world that serves it): what arriving there would let this host do, said before the seal
  const protoLine = FS.proto && w && c.route && protoFights(c.host) && !c.home ? protoMarchLine(FS, { arrive: w.value, dest: c.dest, forecast: forecastNow(c), crowd: protoOwnArrivalAt(FS, c.dest, w.value, c.host.id), shift: c.protoShift && c.protoShift.to === w.value ? c.protoShift : null, answer: protoPreviewOf(FS, { host: String(c.host.id), p: c.dest.p, q: c.dest.q, tile: c.dest.tile }) }) : '';
  const sides = def ? Math.max(c.host.troops, def.total, 1) : 1;
  const destName = destKeep ? (destKeep.holder === FS.citizen?.faction ? L`あなたの国の砦` : L`${factionName(destKeep.holder)}の砦`) : tileName(FS, c.dest.p, c.dest.q, c.dest.tile);
  const stanceText = STANCE_TEXT[stance];
  // a conquest season, the destination is a keep's tile: the keep by its province, its holder, the defenders its record
  // carries and what holding the tile brings (hud/keephand.mjs); the forecast below counts those defenders
  const keepLine = destKeep && conquestOn(FS) ? html`<span class="mc-keep kh-n${destKeep.holder <= 5 ? destKeep.holder : 6}">${crest(destKeep.holder, 22)}<span>${destKeep.holder === FS.citizen?.faction
    ? L`${provinceCoords(c.dest.p, c.dest.q)}の砦 · あなたの国が保持 · 記録の守備兵 ${fmtNum(Number(destKeep.troops ?? 0))}`
    : L`${provinceCoords(c.dest.p, c.dest.q)}の砦 · 記録の守備兵 ${fmtNum(Number(destKeep.troops ?? 0))} · マスを ${fmtNum(holdTurns(FS, destKeep))} ターン保てば州を奪取`}</span></span>` : '';
  // what the march costs this host, said before the seal: a march takes the same stamina wherever it goes and a point
  // returns a turn, so the host cannot march again, or come home, for a long while (it was said only afterwards, on
  // the host's bar: found by the independent check of wave 5)
  // (said in the outlook's cost cell since the uplift: 「次はターン N から」)
  const nowB = FS.nowBell ?? 0, stam = c.host && Number.isFinite(c.host.staminaValue) ? staminaAt(c.host, nowB) : Number.isFinite(c.host?.stamina) ? c.host.stamina : null;
  // (the page moved the arrival turn on with the clock, controller.mjs `composeTick`: said where the turn is named,
  // until the player chooses a turn of their own)
  const movedLine = w && c.moved && c.route && c.moved.to === w.value
    ? html`<p class="mc-moved" role="status">${icon('hourglass')}<span>${L`時間が進んだので、到着はターン ${fmtNum(c.moved.to)} になりました（さきほどまではターン ${fmtNum(c.moved.from)}）。`}</span></p>` : '';
  // (the merge's play of 2026-10-11, on a phone: the page's own order cards open as the low sheet, which shows the
  // card's foot only. There the turn in the summary changed from 51 to 52 with nothing said: the line above was in
  // the folded part. The same sentence stands in the foot while the sheet is folded on a phone (frontier.css
  // `.mc-moved-foot`); it is hidden from assistive technology there, which has the line above)
  const movedFoot = movedLine ? html`<p class="mc-moved mc-moved-foot" aria-hidden="true">${icon('hourglass')}<span>${L`時間が進んだので、到着はターン ${fmtNum(c.moved.to)} になりました（さきほどまではターン ${fmtNum(c.moved.from)}）。`}</span></p>` : '';
  const fcNow = forecastNow(c);
  const sum = html`<button type="button" class="order-sum" data-act="order-open" aria-label="${w ? L`命令のまとめ：${destName}へ、ターン ${fmtNum(w.value)} に到着、構えは${stanceText}` : L`命令のまとめ：${destName}へ、構えは${stanceText}`}">
    <span class="os-main">${icon('pin', 'os-ic')}<strong class="os-dest">${destName}</strong></span>${w ? html`<span class="os-part">${icon('bell', 'os-ic')}${L`ターン ${fmtNum(w.value)}`}</span>` : ''}<span class="os-part">${icon('shield', 'os-ic')}${stanceText}</span>${icon('chevron', 'os-go')}</button>`;
  return html`<section class="order" aria-labelledby="mc-title"><div class="order-body" data-scroll="order">${headBlock}
    ${label(L`行き先`)}
    <div class="mc-dest"><strong class="mc-dest-name">${destName}</strong>
      <span class="mc-route">${c.route ? routeLine(c.route) : c.routeError ? clientText(c.routeError) : L`道のりを探しています…`}${!c.route && NO_ROUTE.includes(c.routeError) && !territoryEnabled(FS) ? html` ${reachLink(FS)}` : ''}</span>
      ${keepLine}
      <span class="mc-sealed">${icon('lock')}<span>${sealLine()}</span></span></div>
    ${outlook({ w, awayLine, stam, nowB, def, odds, fc: fcNow, sight })}
    ${w ? html`${label(L`到着`)}${stepper({ cls: 'mc-bell', label: L`到着のターン`,
      prev: { act: 'mc-bell', data: { d: -1 }, label: L`1ターン早く`, disabled: w.value <= w.min },
      next: { act: 'mc-bell', data: { d: 1 }, label: L`1ターン遅く`, disabled: w.value >= w.max },
      value: html`<strong class="mc-bell-v">${icon('bell')}${L`ターン ${fmtNum(w.value)} に到着`}</strong>${awayLine ? html`<span class="muted">${awayLine}</span>` : ''}` })}
      ${movedLine}
      <p class="muted mc-when">${c.route ? L`進軍は、ターンの始まりにそろって到着します。いちばん早くてターン ${fmtNum(w.min)} です。` : L`進軍は、ターンの始まりにそろって到着します。`}</p>` : ''}
    ${resultLine ? html`<p class="muted mc-result-time">${resultLine}</p>` : ''}
    ${label(def?.total ? L`構えを比べる` : L`構え`, termButton('stance'))}
    ${def?.total ? stanceCompare(m.stance, compareNow(c)) : stancePicks(m.stance)}
    ${label(L`撤退`, termButton('retreat'))}
    ${retreatPicks(m.retreat.choice)}
    <p class="pick-line">${custom ? L`倍率を指定しています：${m.retreat.ratio ?? '—'}` : retreatLine(m.retreat.choice)}</p>
    ${label(L`見込み`)}
    ${def ? html`<div class="mc-odds mc-odds-${odds.id}">
      <p class="mc-odds-head"><strong>${odds.text}</strong><span class="muted">${L`兵数を比べた目安です`}</span></p>
      <dl class="versus"><div><dt>${L`あなた`}</dt><dd>${bar(c.host.troops, sides, 'bar-own')}<span>${fmtNum(c.host.troops)}</span></dd></div>
        <div><dt>${L`守り`}</dt><dd>${bar(def.total, sides, 'bar-foe')}<span>${fmtNum(def.total)}</span></dd></div></dl>
      ${fold('o-odds', L`守り手と結果の幅`, html`
        ${def.residents.length || def.garrison || def.camp || def.keep ? html`<ul class="list mc-def">${def.residents.map(r => html`<li>${swatch(r.faction)}${factionName(r.faction)} ${fmtNum(r.troops)}</li>`)}${def.garrison ? html`<li>${L`守備隊 ${fmtNum(def.garrison)}`}</li>` : ''}${def.camp ? html`<li>${L`蛮族 ${fmtNum(def.camp)}`}</li>` : ''}${def.keep ? html`<li>${L`砦の守備兵`} ${fmtNum(def.keep)}</li>` : ''}</ul>` : html`<p class="muted">${L`いまは守り手がいません。`}</p>`}
        <p class="muted">${L`あなた ${fmtNum(c.host.troops)}（${STANCE_TEXT[stance]}）対 守り ${fmtNum(def.total)}。実際の結果は、到着のターンが始まるときにそこにいる守り手と、戦いの運で決まります。`}</p>
        ${renderForecast(fcNow)}`)}
      ${keepOnly ? html`<p class="muted mc-unseen">${L`砦の守備兵は記録のとおりです。ほかの軍勢がいるかどうかは、ここからはわかりません。`}</p>` : ''}
    </div>` : html`<p class="muted mc-unseen">${sight < 2 ? L`未測量の土地です。守り手は、ここからはわかりません。` : sight < 3 ? L`いまは見えていない土地です。守り手は、ここからはわかりません。` : L`行き先のようすを読み込むと、守り手が出ます。`}</p>`}
    ${fold('o-more', L`詳しい設定`, html`
      ${label(L`開封のチップ`, termButton('seal'))}
      <div class="tip-picks" role="radiogroup" aria-label="${L`開封のチップ`}">${ch.tips.map(t => html`<label class="choice"><input type="radio" name="tip" data-bind="tip" value="${String(t.lamports)}" ${raw(String(t.lamports) === String(m.tip) ? 'checked' : '')}>${t.text ?? TIP_TEXT[t.id]?.()}</label>`)}</div>
      <p class="muted">${L`封を開けてもらうための報酬で、多いほど優先されます。費用はゲーム側が立て替えます（テスト用で、価値はありません。内訳は「その他」の詳細にあります）。`}</p>
      ${label(L`撤退の倍率を自分で決める`)}
      <div class="actions"><button type="button" class="btn small" role="radio" aria-checked="${custom ? 'true' : 'false'}" data-act="mc-retreat" data-v="custom">${RETREAT_SHORT.custom()}</button>
        ${custom ? html`<label class="count-field">${L`倍率（守り手 ÷ 自軍、0.0001〜6）`}<input data-bind="ratio" type="number" step="0.05" min="0.0001" max="6" value="${m.retreat.ratio ?? ''}"></label>` : ''}</div>
      ${label(L`座標で指定する`)}${coordsForm(c)}`)}
    ${problems.length ? html`<ul class="problems">${problems.map(p => html`<li>${failureText({ code: p })}</li>`)}</ul>` : ''}
    ${problems.includes('NotResident') ? html`<button type="button" class="btn small" data-act="nudge" data-p="${c.origin.p}" data-q="${c.origin.q}">${L`この州の処理を進める`}</button>` : ''}
    ${busy || c.step ? html`<ol class="send-track" aria-label="${L`送信の段階`}">${SEND_STEPS.map(s => html`<li class="${c.step === s ? 'now' : SEND_STEPS.indexOf(s) < SEND_STEPS.indexOf(c.step) ? 'done' : ''}">${STEP_TEXT[s]()}</li>`)}</ol>` : ''}</div>
    ${foot(html`${FS.notice && FS.notice.ok === false && !FS.notice.busy && FS.lastAct?.name === 'march-send' ? html`<p class="order-unsent" role="status">${icon('alert')}<span>${L`まだ送られていません。もう一度、封をして出発してください。`}</span></p>` : ''}${movedFoot}${protoLine}${sum}${!busy && !c.step && !problems.length && c.route && w ? html`<p class="order-irrev">${icon('lock')}<span>${L`送ったら取り消せません。行き先と構えはターン ${fmtNum(w.value)} が終わるまで封印されます。`}</span></p>` : ''}`, html`<button type="button" class="btn primary seal-btn" data-act="march-send" ${raw(problems.length || busy || !c.route ? 'disabled' : '')}>${icon('seal')}${L`封をして出発する`}</button>
      <button type="button" class="btn quiet" data-act="compose-close">${L`やめる`}</button>`)}
  </section>`;
}
