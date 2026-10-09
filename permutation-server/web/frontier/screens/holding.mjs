// The village drawer (web design §7.4; contract §5.10, I-29, I-56; UX design
// sections 1 and 6): short parchment cards with the common action first —
//   the village (name, tier, state, shield);
//   its stores as a ruled ledger (a line per resource: amount, cap, rate), and "harvest";
//   building: the queue, the three buildings that can go up now, the rest
//     behind a fold;
//   the troops: the reserve, then the action that makes sense now (muster
//     when there is a reserve, else train), the other behind a fold;
//   the rest (garrison, vigil hours, the village's details) as folds.
// The stores are settled lazily as the kernel does; training is immediate
// (I-56); a mustered host joins the roster from the next bell. Every action
// says why it cannot run now, with a "catch up" nudge when the province
// lags (NotResident).
import { activeHolding } from '../fstate.mjs';
import { html, raw } from '../../util.mjs';
import { icon, RESOURCE_ICON } from '../hud/icons.mjs';
import { L, Lh, fmtNum } from '../../lang.mjs';
import { RESOURCES, RESOURCE_ORDER, UNITS, TIERS, BUILDINGS, HOLDING_STATES, errorText, factionName } from '../fi18n.mjs';
import { storesAt, holdingFacts, BUILD_ITEMS, UNIT_ORDER, SETTLER, actionBlocks, baseProduction, ticketTimes } from '../fland.mjs';
import { holdingName } from '../people/ui.mjs';
import { miniCardUrl, MINI_KINDS } from '../people/minis.mjs';
import { span, NEAR_FULL_SECS } from '../hud/hud.mjs';
import { termButton } from '../hud/glossary.mjs';
import { inTime, row, dueHtml } from './shell.mjs';
import { countdown } from '../clock.mjs';
import { cardHead, label, fold, chip, stamp } from './parts.mjs';
import { villageDrawn, provinceCoords } from '../hud/place.mjs';

/** How many buildings stand in sight before the fold. */
export const BUILD_SHOWN = 3;

/**
 * The − / + buttons and presets around a count (UI plan B4: no typing for
 * the common amounts). The input stays a plain number field (keyboard and
 * screen readers); `max` caps the presets ("all" when it is known).
 */
const steps = (name, { d = 100, presets = [100, 500, 1000], max = null } = {}) => html`<span class="stepper" role="group" aria-label="${L`数を変える`}">
  <button type="button" class="btn small" data-act="step" data-name="${name}" data-d="${-d}" aria-label="${L`${fmtNum(d)} 減らす`}">${icon('minus')}</button>
  <button type="button" class="btn small" data-act="step" data-name="${name}" data-d="${d}" aria-label="${L`${fmtNum(d)} 増やす`}">${icon('plus')}</button>
  ${presets.filter(v => max === null || v <= max).map(v => html`<button type="button" class="btn small" data-act="step-set" data-name="${name}" data-v="${v}">${fmtNum(v)}</button>`)}
  ${max !== null && max > 0 ? html`<button type="button" class="btn small" data-act="step-set" data-name="${name}" data-v="${max}">${L`全部（${fmtNum(max)}）`}</button>` : ''}</span>`;

const costText = cost => cost.map((c, i) => (c ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(c)}` : null)).filter(Boolean).join(' · ');

/** Why an action is blocked, as text, with the catch-up offer for a lagging province. */
/**
 * When a provisional village becomes final, said with a time (the second review: "once every request from the same
 * turn is decided" gave none): by the clock when the page has the request's turn, else by how long it can take at
 * the most (24 turns: fland.mjs ticketTimes).
 */
export function provisionalNote(FS, h) {
  let by = null;
  try { by = FS?.clock && Number.isInteger(h?.ticketBell) ? ticketTimes(FS.clock, h.ticketBell).cohortEndsBy : null; } catch { by = null; }
  // (the time says what it is: how long from now, then the clock; `dueHtml`)
  return by ? Lh`同じターンの申し込みがすべて決まると確定します。遅くとも${dueHtml(by, FS.chain?.now?.() ?? null)}です。` : L`同じターンの申し込みがすべて決まると確定します（遅くとも申し込みから約 4 時間）。`;
}

export function blockedLine(blocks) {
  if (!blocks.length) return '';
  const lag = blocks.includes('NotResident');
  return html`<p class="blocked">${blocks.map(errorText).join(' / ')}${lag ? html` <button type="button" class="btn small" data-act="nudge">${L`追いつかせる`}</button>` : ''}</p>`;
}

/** Seconds the n-th copy of a building takes (catalog `build_secs`: 1 h × (1 + n/2)). */
export const buildSecs = n => 3_600 + 1_800 * n;

/**
 * The build cards (UI plan E2, Civ VII's yield preview): per item `{item,
 * resource, perHour, cost, copies, secs, short: [{resource, need}]}` —
 * `copies` the ones already built (production above the tier's base) or
 * queued, `short` what the stores lack for the first copy's cost (later
 * copies cost more: the program's duplicate cost; the card says so).
 */
export function buildCards(h, stores) {
  const base = baseProduction(Number(h.tier ?? 0));
  const have = Object.fromEntries(stores.map(s => [s.resource, s.value]));
  return BUILD_ITEMS.map(b => {
    const r = RESOURCE_ORDER.indexOf(b.resource);
    const above = r >= 0 && h.production?.[r] !== undefined ? Number(BigInt(h.production[r]) - (base[r] ?? 0n)) / 1000 : 0;
    const queued = (h.queue ?? []).filter(x => Number(x.doneAt) > 0 && x.kind === b.item).length;
    const copies = (b.perHour > 0 ? Math.max(0, Math.round(above / b.perHour)) : 0) + queued;
    const short = (b.cost ?? []).map((c, i) => ({ resource: RESOURCE_ORDER[i], need: c - (have[RESOURCE_ORDER[i]] ?? 0) })).filter(x => x.need > 0);
    return { item: b.item, resource: b.resource, perHour: b.perHour, cost: b.cost, copies, secs: buildSecs(copies), short };
  });
}

/** The viewer's local clock time of a UTC hour today ("09:00"). */
const localHour = hr => { const d = new Date(Date.UTC(2026, 0, 1, hr, 0)); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** The panel's view model (numbers the tests read): stores, facts, the actions' blocks. */
export function holdingModel(FS) {
  const h = activeHolding(FS);
  if (!h) return null;
  const now = FS.chain?.now() ?? 0;
  const env = FS.provinces?.get(`${h.p},${h.q}`);
  const ctx = { holding: h, citizen: FS.citizen, province: env?.province ?? null, nowBell: FS.nowBell ?? 0, now };
  return {
    holding: h,
    stores: storesAt(h, now, RESOURCE_ORDER),
    facts: holdingFacts(h, FS.season, now),
    blocks: Object.fromEntries(['Harvest', 'Build', 'Train', 'Muster', 'Garrison'].map(n => [n, actionBlocks(n, ctx)])),
  };
}

/** A resource's mark on parchment: the strip's icon on a dark coin. */
export const resCoin = resource => html`<span class="res-coin">${icon(RESOURCE_ICON[resource] ?? (resource === 'Walls' ? 'shield' : 'crate'), `res-c-${resource}`)}</span>`;

/**
 * One store as a line of the ledger (UX design 11.12: resources on ink rules, not cards): the mark and the
 * name, the amount, the cap, the hourly rate. A full store is said in a word (stamped) and in the amount's ink.
 */
function storeRow(s) {
  const full = s.cap > 0 && s.value >= s.cap;
  const near = !full && s.cap > 0 && s.perHour > 0 && ((s.cap - s.value) / s.perHour) * 3600 <= NEAR_FULL_SECS;
  return html`<tr class="ledger-row${full ? ' ledger-full' : near ? ' ledger-near' : ''}">
    <th scope="row">${icon(RESOURCE_ICON[s.resource] ?? 'crate', 'ledger-ic')}<span class="ledger-name">${RESOURCES[s.resource]}</span></th>
    <td class="ledger-val">${fmtNum(s.value)}</td>
    <td class="ledger-cap"><span aria-hidden="true">/ </span>${fmtNum(s.cap)}</td>
    <td class="ledger-rate">${full ? stamp(L`満杯`, 'bad') : s.perHour > 0 ? L`+${fmtNum(s.perHour)}/時` : html`<span aria-hidden="true">—</span>`}</td></tr>`;
}
/** The stores as a ruled ledger: a line per resource. */
export function renderLedger(stores) {
  return html`<table class="ledger"><caption class="visually-hidden">${L`資源`}</caption>
    <thead><tr><th scope="col">${L`品目`}</th><th scope="col">${L`在庫`}</th><th scope="col">${L`上限`}</th><th scope="col">${L`毎時`}</th></tr></thead>
    <tbody>${stores.map(storeRow)}</tbody></table>`;
}

/** One building as a row: what it gives, how long, what it costs, and the one button. */
function buildRow(c, blocked) {
  const name = BUILDINGS[c.resource];
  const cost = c.cost ? costText(c.cost) : L`石材を使う`;
  return html`<li class="build-row${c.short.length ? ' short' : ''}">${resCoin(c.resource)}
    <span class="br-main"><strong>${name}</strong><span class="br-yield">${c.perHour ? L`${RESOURCES[c.resource]} +${c.perHour}/時` : L`守りを固める`}</span></span>
    <span class="br-meta">${icon('hourglass')}${span(c.secs)} · ${cost}${c.copies ? html` <span class="br-nth">${L`（${fmtNum(c.copies + 1)}つ目は高くなります）`}</span>` : ''}</span>
    ${c.short.length ? html`<span class="br-short">${L`足りない：${c.short.map(x => `${RESOURCES[x.resource]} ${fmtNum(x.need)}`).join(' · ')}`}</span>` : ''}
    <button type="button" class="btn small br-go" data-act="build" data-item="${c.item}" aria-label="${L`${name}を建てる`}" ${raw(blocked ? 'disabled' : '')}>${L`建てる`}</button></li>`;
}

/** The units as pictures to choose from (radio buttons named `unit`: the forms read `form.elements.unit.value`). */
function unitPicks(f, list, legend) {
  return html`<div class="unit-picks" role="radiogroup" aria-label="${legend}">${list.map((x, k) => html`<label class="unit-pick"><input type="radio" name="unit" value="${x.unit}" ${raw(k === 0 ? 'checked' : '')}>
    <img class="unit-card f${f}" src="${miniCardUrl(f, MINI_KINDS[x.unit])}" alt="" width="44" height="55" loading="lazy" decoding="async">
    <span class="unit-name">${UNITS[UNIT_ORDER[x.unit]]}</span>${x.troops !== undefined ? html`<span class="unit-n">${fmtNum(x.troops)}</span>` : ''}</label>`)}</div>`;
}

export function render(FS) {
  const m = holdingModel(FS);
  if (!m) return html`<p>${L`まだ村がありません。`}</p>`;
  const { holding: h, facts: f } = m;
  const faction = Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : 0;
  const full = m.stores.filter(s => s.cap > 0 && s.value >= s.cap);
  const building = f.queue.filter(q => q.doneIn > 0);
  const queueFull = building.length >= 4;
  const cards = buildCards(h, m.stores);
  const blockedOf = c => !!(m.blocks.Build.length || queueFull || c.short.length);
  // what can go up now first; the catalog's order otherwise
  const order = [...cards].sort((a, b) => Number(blockedOf(a)) - Number(blockedOf(b)) || a.item - b.item);
  const shown = order.slice(0, BUILD_SHOWN), rest = order.slice(BUILD_SHOWN);
  const reserve = f.reserve.filter(r => r.unit !== SETTLER);
  const musterable = reserve.reduce((a, r) => a + r.troops, 0);
  const vigil = FS.citizen?.vigilStartMin ?? 0;
  const vigilHour = Math.floor(vigil / 60);

  const head = html`<section class="vcard village-head" aria-labelledby="holding-title">
    ${cardHead({ id: 'holding-title', ic: 'home', pic: villageDrawn(faction, h.tier), title: holdingName(h), sub: [TIERS[h.tier] ?? '', factionName(faction)].filter(Boolean).join(' · '), side: stamp(HOLDING_STATES[f.state], f.state === 'final' ? 'ok' : 'warn') })}
    ${f.shieldLeft > 0 || f.dormantIn <= 0 || f.state === 'provisional' ? html`<ul class="fact-chips">
      ${f.shieldLeft > 0 ? html`<li>${chip(L`保護 あと ${countdown(f.shieldLeft)}`, 'info', 'shield')}${termButton('shield')}</li>` : ''}
      ${f.dormantIn <= 0 ? html`<li>${chip(L`休眠中`, 'bad', 'moon')}${termButton('dormant')}</li>` : ''}
      ${f.state === 'provisional' ? html`<li class="fact-note">${provisionalNote(FS, h)}</li>` : ''}</ul>` : ''}
  </section>`;

  const stores = html`<section class="vcard" id="hp-harvest" aria-labelledby="hp-harvest-h">
    ${cardHead({ id: 'hp-harvest-h', ic: 'crate', title: L`資源`, side: full.length ? html`<span class="c-count c-count-bad">${L`満杯 ${fmtNum(full.length)}`}</span>` : '' })}
    ${renderLedger(m.stores)}
    <div class="actions"><button type="button" class="btn primary" data-act="harvest" ${raw(m.blocks.Harvest.length ? 'disabled' : '')}>${icon('grain')}${L`収穫する`}</button>
      ${full.length ? html`<span class="muted">${L`${full.map(s => RESOURCES[s.resource]).join(' / ')}が満杯：これ以上は増えません`}</span>` : ''}</div>
    ${blockedLine(m.blocks.Harvest)}</section>`;

  const build = html`<section class="vcard" id="hp-build" aria-labelledby="hp-build-h">
    ${cardHead({ id: 'hp-build-h', ic: 'hammer', title: L`建設`, side: html`<span class="c-count${queueFull ? ' c-count-warn' : ''}">${L`建設中 ${fmtNum(building.length)}/4`}</span>` })}
    ${f.queue.length ? html`<ul class="queue">${f.queue.map(q => html`<li>${icon(q.doneIn > 0 ? 'hourglass' : 'check')}<strong>${BUILDINGS[BUILD_ITEMS[q.kind]?.resource] ?? `#${q.kind}`}</strong><span class="queue-t">${q.doneIn > 0 ? L`あと ${span(q.doneIn)}` : L`完成`}</span></li>`)}</ul>` : html`<p class="muted">${L`建設の列は空です`}</p>`}
    <ul class="build-list">${shown.map(c => buildRow(c, blockedOf(c)))}</ul>
    ${rest.length ? fold('v-build', L`ほかの建物（${fmtNum(rest.length)}）`, html`<ul class="build-list">${rest.map(c => buildRow(c, blockedOf(c)))}</ul>`) : ''}
    ${queueFull ? html`<p class="blocked">${L`建設の列がいっぱいです（4つまで）`}</p>` : ''}
    ${blockedLine(m.blocks.Build)}</section>`;

  const trainForm = html`<form class="vform" id="hp-train" data-form="train">
    ${unitPicks(faction, UNIT_ORDER.map((u, unit) => ({ unit })).filter(x => x.unit !== SETTLER), L`兵種`)}
    <div class="count-row"><label class="count-label" for="f-n">${L`人数`}</label><input id="f-n" name="n" type="number" min="1" step="1" value="100" inputmode="numeric">${steps('n')}</div>
    <div class="actions"><button type="submit" class="btn primary" ${raw(m.blocks.Train.length ? 'disabled' : '')}>${L`訓練する`}</button><span class="muted">${L`訓練はすぐに終わり、兵は控えに入ります。`}</span></div>
    ${blockedLine(m.blocks.Train)}</form>`;
  const musterForm = html`<form class="vform" id="hp-muster" data-form="muster">
    ${reserve.length ? unitPicks(faction, reserve, L`兵種`) : ''}
    <div class="count-row"><label class="count-label" for="f-troops">${L`兵数（100〜30,000）`}</label><input id="f-troops" name="troops" type="number" min="100" max="30000" step="1" value="100" inputmode="numeric">${steps('troops', { max: reserve.length === 1 ? Math.min(30000, reserve[0].troops) || null : null })}</div>
    <div class="actions"><button type="submit" class="btn primary" ${raw(m.blocks.Muster.length || !reserve.length ? 'disabled' : '')}>${icon('banner')}${L`編成する`}</button><span class="muted">${L`新しい軍勢が使えるのは、次の鐘からです。`}</span></div>
    ${!reserve.length ? html`<p class="blocked">${L`控えの兵がいません：先に訓練しましょう`}</p>` : ''}
    ${blockedLine(m.blocks.Muster)}</form>`;
  // the action that makes sense now stands open; the other waits behind a fold
  const musterFirst = musterable >= 100;
  const troops = html`<section class="vcard" aria-labelledby="hp-troops-h">
    ${cardHead({ id: 'hp-troops-h', ic: 'sword', title: L`兵`, side: html`<span class="c-count">${L`控え ${fmtNum(musterable)}`}</span>` })}
    ${label(musterFirst ? L`軍勢を編成する` : L`兵を訓練する`)}
    ${musterFirst ? musterForm : trainForm}
    ${fold(musterFirst ? 'v-train' : 'v-muster', musterFirst ? L`兵を訓練する` : L`軍勢を編成する`, musterFirst ? trainForm : musterForm)}</section>`;

  const others = html`<section class="vcard vcard-folds" aria-label="${L`そのほか`}">
    ${fold('v-garrison', html`${icon('shield')}${L`守備隊を増やす`}`, html`<form class="vform" id="hp-garrison" data-form="garrison">
      <div class="count-row"><label class="count-label" for="f-delta">${L`増員（控えの兵から）`}</label><input id="f-delta" name="delta" type="number" min="1" step="1" value="100" inputmode="numeric">${steps('delta', { max: musterable || null })}</div>
      <div class="actions"><button type="submit" class="btn primary" ${raw(m.blocks.Garrison.length ? 'disabled' : '')}>${L`守備隊を増やす`}</button>${termButton('garrison')}</div>
      <p class="muted">${L`守備隊は増やすことだけできます（引き上げはまだできません）。`}</p>
      ${blockedLine(m.blocks.Garrison)}</form>`)}
    ${fold('v-vigil', html`${icon('moon')}${L`夜番の時間`}<span class="fold-val">${L`${String(vigilHour).padStart(2, '0')}:${String(vigil % 60).padStart(2, '0')} から（UTC）`}</span>`, html`<form class="vform" data-form="vigil">
      <label class="field">${L`開始（UTC の時）`}<select name="hour">${Array.from({ length: 24 }, (_, hr) => html`<option value="${hr}" ${raw(hr === vigilHour ? 'selected' : '')}>${L`${String(hr).padStart(2, '0')}:00 UTC（あなたの時刻 ${localHour(hr)}）`}</option>`)}</select></label>
      <div class="actions"><button type="submit" class="btn">${L`変える`}</button>${termButton('vigil')}</div>
      <p class="muted">${L`変更は24時間以上あとの最初の UTC 0時から有効で、週に1回までです。`}</p></form>`)}
    ${fold('v-facts', html`${icon('scroll')}${L`村の詳細`}`, html`<dl class="facts">
      ${row(L`場所`, provinceCoords(h.p, h.q))}
      ${row(L`段階`, html`${TIERS[h.tier] ?? h.tier} · ${HOLDING_STATES[f.state]}${termButton('tier')}`)}
      ${f.state === 'provisional' ? row(L`確定`, f.finalTs ? Lh`早くて${dueHtml(f.finalTs, FS.chain?.now?.() ?? null)}` : L`同じターンの申し込みがすべて決まってから`) : ''}
      ${f.shieldLeft > 0 ? row(L`保護`, L`残り ${countdown(f.shieldLeft)}`) : ''}
      ${row(L`休眠まで`, html`${f.dormantIn > 0 ? inTime(f.dormantIn) : L`休眠中`}${termButton('dormant')}`)}
    </dl>`)}</section>`;

  return [head, stores, build, troops, others];
}
