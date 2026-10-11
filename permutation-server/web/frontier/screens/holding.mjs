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
import { storesAt, holdingFacts, BUILD_ITEMS, UNIT_ORDER, SETTLER, actionBlocks, ticketTimes, queueBuildingItem, trainingQuote, baseProduction } from '../fland.mjs';
import { settled, buildOffers, promotionOffer, queueNow, queueSlots, trainCost, shortOf, ITEM_TIER_UP } from '../hud/rulebook.mjs';
import { costChips, costWords, shortWords, took, unitGood, whyText } from '../hud/orderparts.mjs';
import { holdingName } from '../people/ui.mjs';
import { miniCardUrl, MINI_KINDS } from '../people/minis.mjs';
import { span, NEAR_FULL_SECS } from '../hud/hud.mjs';
import { termButton } from '../hud/glossary.mjs';
import { row, dueHtml } from './shell.mjs';
import { countdown } from '../clock.mjs';
import { cardHead, label, fold, chip, stamp } from './parts.mjs';
import { villageDrawn, provinceCoords } from '../hud/place.mjs';

export { queueSlots, buildSecs } from '../hud/rulebook.mjs';
export const introBuildAvailable = h => (Number(h?.flags ?? 0) & 2) !== 0;
export const storageCap = tier => [2000, 6000, 15000, 40000][Number(tier)] ?? 2000;
export const signedRate = n => `${n >= 0 ? '+' : '−'}${fmtNum(Math.abs(n))}`;
export const queueItemLabel = q => { const item = queueBuildingItem(q); return item === 7 ? L`村の昇格` : item !== null ? BUILDINGS[BUILD_ITEMS[item]?.resource] ?? L`建物` : L`維持費の変更`; };

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

/**
 * The build cards (UI plan E2, Civ VII's yield preview; UX design 14.2): per thing the village may order built
 * (the six buildings, then the walls) `{item, kind, resource, perHour, n, cost, secs, doneIn, short: [{resource,
 * need}], blocks}` with the program's own numbers for the NEXT copy (hud/rulebook.mjs buildOffers: the n-th copy
 * costs base × (1 + (n−1)²/2) and takes 60 + 30 n minutes; the queue is serial). `copies` = n − 1, the ones built
 * or under way. (The card showed the first copy's cost for every copy, and a first copy as 60 minutes: it takes 90.)
 */
export function buildCards(h, stores, { now = 0, faction = h.faction ?? 0 } = {}) {
  const have = stores.map(s => s.value);
  return buildOffers(h, { now, have, faction }).map(o => ({ ...o, copies: o.n - 1, wait: Math.max(0, o.doneIn - o.secs), short: o.short.map(x => ({ resource: RESOURCE_ORDER[x.r], need: x.need })) }));
}

/** Compatibility view of the shared promotion offer; no second set of prices. */
export function upgradeModel(h, stores, now) {
  h = settled(h, now);
  const offer = promotionOffer(h, { now, have: stores.map(s => s.value) });
  if (!offer) return null;
  const before = baseProduction(h.tier), after = baseProduction(h.tier + 1);
  return { ...offer, next: offer.to, pending: offer.running, wait: Math.max(0, offer.doneIn - offer.secs), slots: offer.gives.slots[1], cap: offer.gives.cap[1],
    short: offer.short.map(x => ({ resource: RESOURCE_ORDER[x.r], need: x.need })),
    gains: after.map((v, i) => ({ resource: RESOURCE_ORDER[i], perHour: Number(v - before[i]) / 1000 })).filter(x => x.perHour > 0) };
}

/** The viewer's local clock time of a UTC hour today ("09:00"). */
const localHour = hr => { const d = new Date(Date.UTC(2026, 0, 1, hr, 0)); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * The panel's view model (numbers the tests read): stores, facts, the actions' blocks. The stores are the ones the
 * program's next instruction will find (hud/rulebook.mjs `settled`: a building that is done already produces).
 * Also what the hand reads (hud/hand.mjs): `have` (whole units by resource index), `offers` (buildCards), `promotion`,
 * `queue` (what is under way, in order) and `slots` (how many things this tier may have under way).
 */
export function holdingModel(FS) {
  const raw0 = activeHolding(FS);
  if (!raw0) return null;
  const now = FS.chain?.now() ?? 0;
  const h = settled(raw0, now);
  const env = FS.provinces?.get(`${h.p},${h.q}`);
  const ctx = { holding: raw0, citizen: FS.citizen, province: env?.province ?? null, nowBell: FS.nowBell ?? 0, now };
  const stores = storesAt(h, now, RESOURCE_ORDER);
  const have = stores.map(s => s.value);
  const faction = Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : 0;
  const promo = promotionOffer(h, { now, have });
  return {
    holding: h, rawHolding: raw0, settled: h, now, faction, programVersion: Number(FS.season?.programVersion ?? 1),
    stores, have,
    facts: holdingFacts(h, FS.season, now),
    blocks: Object.fromEntries(['Harvest', 'Build', 'Train', 'Muster', 'Garrison'].map(n => [n, actionBlocks(n, ctx)])),
    offers: buildCards(h, stores, { now, faction }),
    promotion: promo ? { ...promo, short: promo.short.map(x => ({ resource: RESOURCE_ORDER[x.r], need: x.need })) } : null,
    queue: queueNow(h, now), slots: queueSlots(h.tier),
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
    <td class="ledger-rate">${full ? stamp(L`満杯`, 'bad') : s.perHour !== 0 ? L`${signedRate(s.perHour)}/時` : html`<span aria-hidden="true">—</span>`}</td></tr>`;
}
/** The stores as a ruled ledger: a line per resource. */
export function renderLedger(stores) {
  return html`<table class="ledger"><caption class="visually-hidden">${L`資源`}</caption>
    <thead><tr><th scope="col">${L`品目`}</th><th scope="col">${L`在庫`}</th><th scope="col">${L`上限`}</th><th scope="col">${L`毎時`}</th></tr></thead>
    <tbody>${stores.map(storeRow)}</tbody></table>`;
}

/**
 * One building as a row: what it gives, how long the next copy takes, what the next copy costs (the program's own
 * numbers: hud/rulebook.mjs), and the one button; `why` is the rule that stops it now, in words.
 */
function buildRow(c, why, have) {
  const name = BUILDINGS[c.resource];
  return html`<li class="build-row${c.short.length ? ' short' : ''}">${resCoin(c.resource)}
    <span class="br-main"><strong>${name}</strong><span class="br-yield">${c.perHour ? L`${RESOURCES[c.resource]} +${c.perHour}/時` : L`守り +100`}</span></span>
    <span class="br-meta">${icon('hourglass')}${took(c.secs)}${c.intro ? html` ${stamp(L`初めての建設`, 'ok')}` : ''} · ${costChips(c.cost, have)}${c.kind === 'building' && c.copies ? html` <span class="br-nth">${L`（${fmtNum(c.copies + 1)}つ目）`}</span>` : ''}</span>
    ${c.short.length ? html`<span class="br-short">${shortWords(c.short)}</span>` : ''}
    <button type="button" class="btn small br-go" data-act="build" data-item="${c.item}" aria-label="${L`${name}を建てる`}" ${raw(why ? 'disabled' : '')}>${L`建てる`}</button></li>`;
}

/** The promotion to the next tier as a row of the build card (it takes a place in the same queue). */
function promotionRow(p, why, have) {
  return html`<li class="build-row promo-row${p.short.length ? ' short' : ''}"><span class="res-coin">${icon('tierup')}</span>
    <span class="br-main"><strong>${L`${TIERS[p.to]}への昇格`}</strong><span class="br-yield">${L`産出 +${p.gives.prodPct[1]}% · 蔵 ${fmtNum(p.gives.cap[1])} · 建設 ${p.gives.slots[1]} つ · 村のまわり ${p.gives.radius[1]} マス`}</span></span>
    <span class="br-meta">${icon('hourglass')}${p.running ? L`あと ${took(p.doneIn)}` : took(p.secs)}${p.running ? '' : html` · ${costChips(p.cost, have)}`}</span>
    ${p.short.length && !p.running ? html`<span class="br-short">${shortWords(p.short)}</span>` : ''}
    ${p.running ? stamp(L`昇格中`, 'warn') : html`<button type="button" class="btn small br-go" data-act="build" data-item="${ITEM_TIER_UP}" aria-label="${L`${TIERS[p.to]}への昇格を始める`}" ${raw(why ? 'disabled' : '')}>${L`昇格`}</button>`}</li>`;
}

/**
 * The units as pictures to choose from (radio buttons named `unit`: the forms read `form.elements.unit.value`).
 * `costs`: under each, what a hundred cost and what the kind is good at (the training form).
 */
function unitPicks(f, list, legend, { costs = false, have = null, selected = 0, programVersion = 1 } = {}) {
  return html`<div class="unit-picks${costs ? ' unit-picks-costs' : ''}" role="radiogroup" aria-label="${legend}">${list.map((x, k) => html`<label class="unit-pick"><input type="radio" name="unit" value="${x.unit}" ${raw(x.unit === selected ? 'checked' : '')}>
    <img class="unit-card f${f}" src="${miniCardUrl(f, MINI_KINDS[x.unit])}" alt="" width="44" height="55" loading="lazy" decoding="async">
    <span class="unit-name">${UNITS[UNIT_ORDER[x.unit]]}</span>${x.troops !== undefined ? html`<span class="unit-n">${fmtNum(x.troops)}</span>` : ''}
    ${costs ? html`<span class="unit-good">${unitGood(x.unit)}</span><span class="unit-cost">${L`100人`} ${costChips(trainCost(x.unit, 100, programVersion), have)}</span>` : ''}</label>`)}</div>`;
}

export function render(FS) {
  const m = holdingModel(FS);
  if (!m) return html`<p>${L`まだ村がありません。`}</p>`;
  const { holding: h, facts: f } = m;
  const actionBusy = FS.inFlight > 0 || !!FS.homeActionBusy;
  const first = introBuildAvailable(m.settled);
  const trainUnit = Number.isInteger(FS.trainingDraft?.unit) ? FS.trainingDraft.unit : 0;
  const trainN = Number.isFinite(FS.trainingDraft?.n) ? FS.trainingDraft.n : 100;
  const training = trainingQuote(h, trainUnit, trainN, m.now, m.programVersion);
  const upkeep = (m.settled.upkeep ?? []).map((v, i) => ({ resource: RESOURCE_ORDER[i], perHour: Number(v) / 1000 })).filter(x => x.perHour > 0);
  const faction = Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : 0;
  const full = m.stores.filter(s => s.cap > 0 && s.value >= s.cap);
  const building = m.queue;
  const queueFull = building.length >= m.slots;
  const freeIn = queueFull ? Math.min(...building.map(q => q.doneIn)) : 0;
  const cards = m.offers;
  // why a thing cannot be ordered now, as the rule says it (the program would answer the same)
  const whyOf = c => { const code = m.blocks.Build[0] ?? c.blocks[0] ?? null; if (actionBusy) return L`命令の結果を確認しています。`; return code ? whyText(code, { tier: Number(m.settled.tier ?? 0), freeIn, short: c.short, walls: c.kind === 'walls' }) : null; };
  // what can go up now first; the catalog's order otherwise
  const order = [...cards].sort((a, b) => Number(!!whyOf(a)) - Number(!!whyOf(b)) || a.item - b.item);
  const shown = order.slice(0, first ? 2 : BUILD_SHOWN), rest = order.slice(first ? 2 : BUILD_SHOWN);
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
    <p class="muted">${L`毎時の収支は、生産から現在の維持費を引いた量です。資源は画面を閉じても増減します。`}</p>
    ${upkeep.length ? html`<p>${L`現在の維持費（毎時）`}: ${upkeep.map(x => `${RESOURCES[x.resource]} ${fmtNum(x.perHour)}`).join(' · ')}</p>` : ''}
    <div class="actions"><button type="button" class="btn primary" data-act="harvest" ${raw(actionBusy || m.blocks.Harvest.length ? 'disabled' : '')}>${icon('grain')}${L`収穫する`}</button>
      <span class="muted">${full.length ? L`${full.map(s => RESOURCES[s.resource]).join(' / ')}が満杯：これ以上は増えません。使いましょう` : L`蔵は時間で増えます。収穫は、いまの量を蔵の記録に納めるだけです。`}</span></div>
    ${blockedLine(m.blocks.Harvest)}</section>`;

  const queueName = q => queueItemLabel(q.q);
  const build = html`<section class="vcard" id="hp-build" aria-labelledby="hp-build-h">
    ${cardHead({ id: 'hp-build-h', ic: 'hammer', title: first ? L`最初の建設を選ぶ` : L`建設`, side: html`<span class="c-count${queueFull ? ' c-count-warn' : ''}">${L`建設中 ${fmtNum(building.length)}/${fmtNum(m.slots)}`}</span>` })}
    ${first ? html`<p>${L`農場で食料を増やすか、伐採所で木材を増やすか。村の最初の仕事を選びましょう。`}</p><p class="muted">${L`最初の生産施設の工事は60秒です。ほかの工事があると順番を待ちます。資源の費用は通常どおりです。`}</p>` : ''}
    ${building.length ? html`<ul class="queue">${building.map(q => html`<li>${icon('hourglass')}<strong>${queueName(q)}</strong><span class="queue-t">${q.running ? L`あと ${span(q.doneIn)}` : L`順番待ち（あと ${span(q.doneIn)}）`}</span></li>`)}</ul>` : html`<p class="muted">${L`建設の列は空です`}</p>`}
    <ul class="build-list">${shown.map(c => buildRow(c, whyOf(c), m.have))}</ul>
    ${rest.length ? fold('v-build', L`ほかの建物（${fmtNum(rest.length)}）`, html`<ul class="build-list">${rest.map(c => buildRow(c, whyOf(c), m.have))}</ul>`) : ''}
    ${m.promotion ? html`<ul class="build-list">${promotionRow(m.promotion, whyOf(m.promotion), m.have)}</ul>` : ''}
    ${queueFull ? html`<p class="blocked">${whyText('QueueFull', { tier: Number(m.settled.tier ?? 0), freeIn })}</p>` : ''}
    ${blockedLine(m.blocks.Build)}</section>`;

  // (the cheapest hundred the stores cannot pay for: the button says so instead of sending an order the program refuses)
  const trainShort = training.short.map(x => ({ resource: RESOURCE_ORDER[x.resource], need: x.need }));
  const trainForm = html`<form class="vform" id="hp-train" data-form="train">
    ${unitPicks(faction, UNIT_ORDER.map((u, unit) => ({ unit })).filter(x => x.unit !== SETTLER), L`兵種`, { costs: true, have: m.have, selected: trainUnit, programVersion: m.programVersion })}
    <div class="count-row"><label class="count-label" for="f-n">${L`人数`}</label><input id="f-n" name="n" type="number" min="1" step="1" value="${trainN}" max="30000" inputmode="numeric">${steps('n', { presets: [100, 200, 500], max: training.max })}</div>
    <p class="training-cost" aria-live="polite">${training.cost ? html`${L`訓練の費用`}: ${costChips(training.cost, m.have)}` : L`1〜30,000人で人数を決めてください。`}</p>
    <p class="muted">${L`いま訓練できる人数 ${fmtNum(training.max)}（一隊の上限まで）`}</p>
    <div class="actions"><button type="submit" class="btn primary" ${raw(actionBusy || m.blocks.Train.length || !training.affordable || trainN > 30000 || trainShort.length ? 'disabled' : '')}>${L`訓練する`}</button><span class="muted">${L`訓練はすぐに終わり、兵は控えに入ります。`}</span></div>
    ${trainShort.length ? html`<p class="blocked">${shortWords(trainShort)}</p>` : ''}
    ${blockedLine(m.blocks.Train)}</form>`;
  const musterForm = html`<form class="vform" id="hp-muster" data-form="muster">
    ${reserve.length ? unitPicks(faction, reserve, L`兵種`, { selected: reserve[0]?.unit ?? 0 }) : ''}
    <div class="count-row"><label class="count-label" for="f-troops">${L`兵数（100〜30,000）`}</label><input id="f-troops" name="troops" type="number" min="100" max="30000" step="1" value="100" inputmode="numeric">${steps('troops', { max: reserve.length === 1 ? Math.min(30000, reserve[0].troops) || null : null })}</div>
    <div class="actions"><button type="submit" class="btn primary" ${raw(actionBusy || m.blocks.Muster.length || !reserve.length ? 'disabled' : '')}>${icon('banner')}${L`編成する`}</button><span class="muted">${L`編成は世界の処理に反映されてから行動できます。目安はゲーム内で約11〜21分です。`}</span></div>
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
      <div class="actions"><button type="submit" class="btn primary" ${raw(actionBusy || m.blocks.Garrison.length ? 'disabled' : '')}>${L`守備隊を増やす`}</button>${termButton('garrison')}</div>
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
      ${row(L`休眠まで`, html`${f.dormantIn > 0 ? L`あと ${span(f.dormantIn)}` : L`休眠中`}${termButton('dormant')}`)}
    </dl>`)}</section>`;

  return [head, stores, build, troops, others];
}
