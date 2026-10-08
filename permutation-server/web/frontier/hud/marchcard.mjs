// The sealed order (UI plan B1–B4; UX design sections 1 and 6; Civ's
// move-and-attack preview): a march is written on the map as one document.
// Choose a host ("march" on its card or in the inspector), tap a tile — the
// destination is set at once — and the order shows everything the decision
// needs in one place:
//   where to (the place by its name, the way and its length), sealed: only
//   this browser knows it until the arrival turn ends;
//   the arrival turn as a stepper over the window, with the local time;
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
import { STANCES as STANCE_TEXT, UNITS, clientText, failureText, factionName } from '../fi18n.mjs';
import { STANCES } from '../seal.mjs';
import { RETREAT_CHOICES, arrivalWindow, checkMarch, troopsOf, SEND_STEPS } from '../fmarch.mjs';
import { UNIT_ORDER } from '../fland.mjs';
import { bellStart } from '../clock.mjs';
import { composerMarch, composerChoices, routeLine } from '../screens/march.mjs';
import { clockTime, swatch } from '../screens/shell.mjs';
import { fold, label, stepper, bar } from '../screens/parts.mjs';
import { DIRECTIONS, tileHex } from '../fgeo.mjs';
import { termButton } from './glossary.mjs';
import { tileName } from './place.mjs';
import { STANCE_PIC, RETREAT_PIC, sealPic } from './pictos.mjs';
import { miniCardUrl, MINI_KINDS } from '../people/minis.mjs';

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
const STEP_TEXT = { sealing: () => L`封をしています`, saved: () => L`この端末に保存`, sent: () => L`送信`, onChain: () => L`チェーンに記録` };

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
  return { residents, garrison, camp, total: residents.reduce((a, r) => a + r.troops, 0) + garrison + camp };
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
  const c = FS.compose;
  if (!c || !FS.season) return null;
  const w = arrivalWindow(FS.season, FS.nowBell ?? 0, c.earliest);
  return { ...w, value: Math.min(w.max, Math.max(w.min, c.arriveBell ?? w.min)) };
}

const FATE_SHORT = { Stays: () => L`戦場に残る`, Withdrew: () => L`隣へ退く`, Bounced: () => L`押し戻される`, Retreated: () => L`撤退する`, Destroyed: () => L`壊滅する` };
/** The rules' forecast (hud/forecast.mjs): troops left worst–best, how often each fate came up. */
export function renderForecast(fc) {
  if (!fc) return '';
  if (fc.pending) return html`<p class="muted mc-fc">${L`ルールで結果の幅を計算しています…`}</p>`;
  if (!fc.ok) return '';
  const fates = Object.entries(fc.fates).sort((a, b) => b[1] - a[1]);
  return html`<div class="mc-fc"><p><strong>${fc.troops.min === fc.troops.max ? L`残る兵 ${fmtNum(fc.troops.min)}` : L`残る兵 ${fmtNum(fc.troops.min)}〜${fmtNum(fc.troops.max)}`}</strong> <span class="muted">${L`（出発時 ${fmtNum(fc.troops.start)}）`}</span></p>
    <ul class="mc-fates">${fates.map(([k, n]) => html`<li class="mc-fate-${k}">${bar(n, fc.runs)}<span>${FATE_SHORT[k]?.() ?? k}</span><span class="muted">${L`${fmtNum(n)}/${fmtNum(fc.runs)}回`}</span></li>`)}</ul>
    <p class="muted">${L`この戦いのルールで${fmtNum(fc.runs)}通りの乱数を試した幅です。ほかの到着軍勢は封の中なので数えていません。`}${fc.certain ? '' : html` ${L`この鐘は野営地の見直しがあるため、守り手が変わるかもしれません。`}`}</p></div>`;
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
  const m = composerMarch(FS);
  const unit = UNITS[UNIT_ORDER[c.host.unit]] ?? '';
  const w = bellWindow(FS);
  const at = w && FS.clock ? clockTime(bellStart(FS.clock.genesisTs, w.value)) : null;
  const def = c.dest ? defendersAt(FS, c.dest) : null;
  const odds = c.dest && def ? oddsWord(c.host.troops, def.total) : null;
  const problems = c.dest ? checkMarch(m).filter(p => p !== 'NoDestination') : [];
  const busy = !!c.sending;
  const stance = STANCES[m.stance] ?? 'Hold';
  const ch = composerChoices(FS);
  const from = tileName(FS, c.origin.p, c.origin.q, c.host.tile);
  const faction = FS.citizen?.faction;
  const headBlock = html`<header class="order-head">${sealPic(46)}<span class="order-titles"><span class="order-kicker">${L`封をした命令`}</span>
    <h3 id="mc-title">${L`進軍：${unit} ${fmtNum(c.host.troops)}`}</h3><span class="c-sub">${L`${from}（州 ${c.origin.p},${c.origin.q}）から`}</span></span>
    ${Number.isInteger(faction) && MINI_KINDS[c.host.unit] ? html`<img class="unit-card order-unit f${faction}" src="${miniCardUrl(faction, MINI_KINDS[c.host.unit])}" alt="" width="40" height="50" decoding="async">` : ''}</header>`;
  const quick = (c.quick ?? []).filter(q => !(q.p === c.origin.p && q.q === c.origin.q && q.tile === c.host.tile));
  const quickList = quick.length ? html`${label(L`近くの行き先`)}<ul class="quick-dest">${quick.map(q => html`<li><button type="button" class="btn small" data-act="dest-quick" data-p="${q.p}" data-q="${q.q}" data-tile="${q.tile}">${icon(q.kind === 'camp' ? 'tent' : 'home')}${L`${tileName(FS, q.p, q.q, q.tile)}（州 ${q.p},${q.q}）`}</button></li>`)}</ul>` : '';
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
  const sides = def ? Math.max(c.host.troops, def.total, 1) : 1;
  const destName = tileName(FS, c.dest.p, c.dest.q, c.dest.tile);
  const stanceText = STANCE_TEXT[stance];
  const sum = html`<button type="button" class="order-sum" data-act="order-open" aria-label="${w ? L`命令のまとめ：${destName}へ、ターン ${fmtNum(w.value)} に到着、構えは${stanceText}` : L`命令のまとめ：${destName}へ、構えは${stanceText}`}">
    <span class="os-main">${icon('pin', 'os-ic')}<strong class="os-dest">${destName}</strong></span>${w ? html`<span class="os-part">${icon('bell', 'os-ic')}${L`ターン ${fmtNum(w.value)}`}</span>` : ''}<span class="os-part">${icon('shield', 'os-ic')}${stanceText}</span>${icon('chevron', 'os-go')}</button>`;
  return html`<section class="order" aria-labelledby="mc-title"><div class="order-body" data-scroll="order">${headBlock}
    ${label(L`行き先`)}
    <div class="mc-dest"><strong class="mc-dest-name">${destName}</strong>
      <span class="mc-route">${L`州 ${c.dest.p},${c.dest.q}`} · ${c.route ? routeLine(c.route) : c.routeError ? clientText(c.routeError) : L`道のりを探しています…`}</span>
      <span class="mc-sealed">${icon('lock')}<span>${L`行き先と構えは、到着のターンが終わるまであなたにしか見えません。`}</span></span></div>
    ${w ? html`${label(L`到着`)}${stepper({ cls: 'mc-bell', label: L`到着のターン`,
      prev: { act: 'mc-bell', data: { d: -1 }, label: L`1ターン早く`, disabled: w.value <= w.min },
      next: { act: 'mc-bell', data: { d: 1 }, label: L`1ターン遅く`, disabled: w.value >= w.max },
      value: html`<strong class="mc-bell-v">${icon('bell')}${L`ターン ${fmtNum(w.value)} に到着`}</strong>${at ? html`<span class="muted">${L`${at.local} ごろ`}</span>` : ''}` })}` : ''}
    ${label(L`構え`, termButton('stance'))}
    ${stancePicks(m.stance)}
    ${label(L`撤退`, termButton('retreat'))}
    ${retreatPicks(m.retreat.choice)}
    <p class="pick-line">${custom ? L`倍率を指定しています：${m.retreat.ratio ?? '—'}` : retreatLine(m.retreat.choice)}</p>
    ${label(L`見込み`)}
    ${def ? html`<div class="mc-odds mc-odds-${odds.id}">
      <p class="mc-odds-head"><strong>${odds.text}</strong><span class="muted">${L`兵数を比べた目安です`}</span></p>
      <dl class="versus"><div><dt>${L`あなた`}</dt><dd>${bar(c.host.troops, sides, 'bar-own')}<span>${fmtNum(c.host.troops)}</span></dd></div>
        <div><dt>${L`守り`}</dt><dd>${bar(def.total, sides, 'bar-foe')}<span>${fmtNum(def.total)}</span></dd></div></dl>
      ${fold('o-odds', L`守り手と結果の幅`, html`
        ${def.residents.length || def.garrison || def.camp ? html`<ul class="list mc-def">${def.residents.map(r => html`<li>${swatch(r.faction)}${factionName(r.faction)} ${fmtNum(r.troops)}</li>`)}${def.garrison ? html`<li>${L`守備隊 ${fmtNum(def.garrison)}`}</li>` : ''}${def.camp ? html`<li>${L`蛮族 ${fmtNum(def.camp)}`}</li>` : ''}</ul>` : html`<p class="muted">${L`いまは守り手がいません。`}</p>`}
        <p class="muted">${L`あなた ${fmtNum(c.host.troops)}（${STANCE_TEXT[stance]}）対 守り ${fmtNum(def.total)}。実際は鐘の始まりの顔ぶれと乱数で決まります。`}</p>
        ${renderForecast(c.forecast)}`)}
    </div>` : html`<p class="muted">${L`行き先の州の中身を読み込むと、守り手が出ます。`}</p>`}
    ${fold('o-more', L`詳しい設定`, html`
      ${label(L`開封のチップ`, termButton('seal'))}
      <div class="tip-picks" role="radiogroup" aria-label="${L`開封のチップ`}">${ch.tips.map(t => html`<label class="choice"><input type="radio" name="tip" data-bind="tip" value="${String(t.lamports)}" ${raw(String(t.lamports) === String(m.tip) ? 'checked' : '')}>${t.text ?? TIP_TEXT[t.id]?.()}</label>`)}</div>
      <p class="muted">${L`到着のターンに封を開ける手続きへの報酬で、多いほど優先されます。費用は中継が立て替えます（テスト用で、価値はありません。内訳は「その他」の詳細にあります）。`}</p>
      ${label(L`撤退の倍率を自分で決める`)}
      <div class="actions"><button type="button" class="btn small" role="radio" aria-checked="${custom ? 'true' : 'false'}" data-act="mc-retreat" data-v="custom">${RETREAT_SHORT.custom()}</button>
        ${custom ? html`<label class="count-field">${L`倍率（守り手 ÷ 自軍、0.0001〜6）`}<input data-bind="ratio" type="number" step="0.05" min="0.0001" max="6" value="${m.retreat.ratio ?? ''}"></label>` : ''}</div>
      ${label(L`座標で指定する`)}${coordsForm(c)}`)}
    ${problems.length ? html`<ul class="problems">${problems.map(p => html`<li>${failureText({ code: p })}</li>`)}</ul>` : ''}
    ${busy || c.step ? html`<ol class="send-track" aria-label="${L`送信の段階`}">${SEND_STEPS.map(s => html`<li class="${c.step === s ? 'now' : SEND_STEPS.indexOf(s) < SEND_STEPS.indexOf(c.step) ? 'done' : ''}">${STEP_TEXT[s]()}</li>`)}</ol>` : ''}</div>
    ${foot(sum, html`<button type="button" class="btn primary seal-btn" data-act="march-send" ${raw(problems.length || busy || !c.route ? 'disabled' : '')}>${icon('seal')}${L`封をして出発する`}</button>
      <button type="button" class="btn quiet" data-act="compose-close">${L`やめる`}</button>`)}
  </section>`;
}
