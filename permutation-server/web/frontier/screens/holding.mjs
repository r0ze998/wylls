// The holding panel (web design §7.4; contract §5.10, I-29, I-56): header
// (site, tier, provisional/final, shield, dormancy), the eight stores
// settled lazily as the kernel does, the build queue and the build list
// (first-copy costs), training (immediate, I-56), the trained reserve,
// muster into a host (joins the roster from the next bell), garrison,
// vigil hours, and the transit records. Every action says why it cannot
// run now, with a "catch up" nudge when the province lags (NotResident).
import { activeHolding } from '../fstate.mjs';
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum } from '../../lang.mjs';
import { RESOURCES, RESOURCE_ORDER, UNITS, TIERS, BUILDINGS, HOLDING_STATES, errorText } from '../fi18n.mjs';
import { storesAt, holdingFacts, BUILD_ITEMS, UNIT_ORDER, SETTLER, actionBlocks, baseProduction, queueBuildingItem, trainingQuote, TIER_UPGRADES, projectedHolding } from '../fland.mjs';
import { holdingName } from '../people/ui.mjs';
import { span } from '../hud/hud.mjs';
import { termButton } from '../hud/glossary.mjs';
import { inTime, row, timeHtml } from './shell.mjs';

/**
 * The − / + buttons and presets around a count (UI plan B4: no typing for
 * the common amounts). The input stays a plain number field (keyboard and
 * screen readers); `max` caps the presets ("all" when it is known).
 */
const steps = (name, { d = 100, presets = [100, 500, 1000], max = null } = {}) => html`<span class="stepper" role="group" aria-label="${L`数を変える`}">
  <button type="button" class="btn small" data-act="step" data-name="${name}" data-d="${-d}" aria-label="${L`${fmtNum(d)} 減らす`}">−</button>
  <button type="button" class="btn small" data-act="step" data-name="${name}" data-d="${d}" aria-label="${L`${fmtNum(d)} 増やす`}">+</button>
  ${presets.filter(v => max === null || v <= max).map(v => html`<button type="button" class="btn small" data-act="step-set" data-name="${name}" data-v="${v}">${fmtNum(v)}</button>`)}
  ${max !== null && max > 0 ? html`<button type="button" class="btn small" data-act="step-set" data-name="${name}" data-v="${max}">${L`全部（${fmtNum(max)}）`}</button>` : ''}</span>`;

const costText = cost => cost.map((c, i) => (c ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(c)}` : null)).filter(Boolean).join(' · ');

/** Why an action is blocked, as text, with the catch-up offer for a lagging province. */
export function blockedLine(blocks) {
  if (!blocks.length) return '';
  const lag = blocks.includes('NotResident');
  return html`<p class="blocked">${blocks.map(errorText).join(' / ')}${lag ? html` <button type="button" class="btn small" data-act="nudge">${L`追いつかせる`}</button>` : ''}</p>`;
}

/** Seconds the n-th copy of a building takes (catalog `build_secs`: 1 h × (1 + n/2)). */
export const buildSecs = n => 3_600 + 1_800 * n;
/** The on-chain one-use introductory construction credit belongs to this holding. */
export const introBuildAvailable = h => (Number(h?.flags ?? 0) & 2) !== 0;
export const queueSlots = tier => [2, 3, 4, 4][Number(tier)] ?? 2;
export const storageCap = tier => [2000, 6000, 15000, 40000][Number(tier)] ?? 2000;
export const signedRate = n => `${n >= 0 ? '+' : '−'}${fmtNum(Math.abs(n))}`;
/** QueueItem.kind is an effect enum, not a Build item; arg is the resource. */
export const queueItemLabel = q => { const item = queueBuildingItem(q); return item === 7 ? L`村の昇格` : item !== null ? BUILDINGS[BUILD_ITEMS[item]?.resource] ?? L`建物` : L`維持費の変更`; };

/**
 * The build cards (UI plan E2, Civ VII's yield preview): per item `{item,
 * resource, perHour, cost, copies, secs, short: [{resource, need}]}` —
 * `copies` the ones already built (production above the tier's base) or
 * queued, `short` what the stores lack for the first copy's cost (later
 * copies cost more: the program's duplicate cost; the card says so).
 */
export function buildCards(h, stores, { now = null } = {}) {
  const base = baseProduction(Number(h.tier ?? 0));
  const have = Object.fromEntries(stores.map(s => [s.resource, s.value]));
  return BUILD_ITEMS.map(b => {
    const r = RESOURCE_ORDER.indexOf(b.resource);
    const above = r >= 0 && h.production?.[r] !== undefined ? Number(BigInt(h.production[r]) - (base[r] ?? 0n)) / 1000 : 0;
    const queued = (h.queue ?? []).filter(x => x && Number(x.doneAt) > 0 && x.kind === 1 && x.arg === r).length;
    const copies = (b.perHour > 0 ? Math.max(0, Math.round(above / b.perHour)) : 0) + queued;
    const cost = b.item === 6 ? [0, 0, h.faction === 0 ? 285 : 300, 0, 0, 0, 0, 0] : b.cost?.map(c => Math.floor(c * (2 + copies * copies) / 2)) ?? null;
    const short = (cost ?? []).map((c, i) => ({ resource: RESOURCE_ORDER[i], need: c - (have[RESOURCE_ORDER[i]] ?? 0) })).filter(x => x.need > 0);
    const intro = b.item < 6 && introBuildAvailable(h);
    const wait = now === null ? 0 : Math.max(0, ...(h.queue ?? []).map(q => Number(q?.doneAt ?? 0) - now));
    return { item: b.item, resource: b.resource, perHour: b.perHour, cost, copies, intro, secs: b.item === 6 ? 4 * 3600 : intro ? 60 : buildSecs(copies + 1), wait, short };
  });
}

/** Tier-aware settlement raises base production, storage and queue capacity. */
export function upgradeModel(h, stores, now) {
  const plan = TIER_UPGRADES[h.tier];
  if (!plan) return null;
  const have = Object.fromEntries(stores.map(s => [s.resource, s.value]));
  const short = plan.cost.map((v, i) => ({ resource: RESOURCE_ORDER[i], need: v - (have[RESOURCE_ORDER[i]] ?? 0) })).filter(x => x.need > 0);
  const pending = (h.queue ?? []).some(q => q.kind === 3 && Number(q.doneAt) > 0);
  const wait = Math.max(0, ...(h.queue ?? []).map(q => Number(q?.doneAt ?? 0) - now));
  const before = baseProduction(h.tier), after = baseProduction(h.tier + 1);
  const gains = after.map((v, i) => ({ resource: RESOURCE_ORDER[i], perHour: Number(v - before[i]) / 1000 })).filter(x => x.perHour > 0);
  return { ...plan, next: h.tier + 1, short, pending, wait, slots: queueSlots(h.tier + 1), cap: storageCap(h.tier + 1), gains };
}

/** The viewer's local clock time of a UTC hour today ("09:00"). */
const localHour = hr => { const d = new Date(Date.UTC(2026, 0, 1, hr, 0)); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** The panel's view model (numbers the tests read): stores, facts, the actions' blocks. */
export function holdingModel(FS) {
  const rawHolding = activeHolding(FS);
  if (!rawHolding) return null;
  const now = FS.chain?.now() ?? 0;
  const h = projectedHolding(rawHolding, now);
  const env = FS.provinces?.get(`${h.p},${h.q}`);
  const ctx = { holding: h, citizen: FS.citizen, province: env?.province ?? null, nowBell: FS.nowBell ?? 0, now };
  return {
    holding: h,
    stores: storesAt(h, now, RESOURCE_ORDER),
    facts: holdingFacts(h, FS.season, now),
    blocks: Object.fromEntries(['Harvest', 'Build', 'Train', 'Muster', 'Garrison'].map(n => [n, actionBlocks(n, ctx)])),
  };
}

const PANELS = [
  { id: 'hp-harvest', text: () => L`収穫`, glyph: '❦' }, { id: 'hp-build', text: () => L`建設`, glyph: '⚒' },
  { id: 'hp-train', text: () => L`訓練`, glyph: '⚔' }, { id: 'hp-muster', text: () => L`編成`, glyph: '⚑' }, { id: 'hp-garrison', text: () => L`守備`, glyph: '⛨' },
];

export function render(FS) {
  const m = holdingModel(FS);
  if (!m) return html`<p>${L`まだ村がありません。`}</p>`;
  const { holding: h, facts: f } = m;
  const actionBusy = FS.inFlight > 0 || !!FS.homeActionBusy;
  const state = HOLDING_STATES[f.state];
  const units = UNIT_ORDER.map((u, i) => ({ u, i })).filter(x => x.i !== SETTLER);
  const full = m.stores.filter(s => s.cap > 0 && s.value >= s.cap);
  const slots = queueSlots(h.tier);
  const queueFull = f.queue.length >= slots;
  const cards = buildCards(h, m.stores, { now: FS.chain?.now?.() ?? 0 });
  const first = introBuildAvailable(h);
  const now = FS.chain?.now?.() ?? 0;
  const trainUnit = Number.isInteger(FS.trainingDraft?.unit) ? FS.trainingDraft.unit : 0;
  const trainN = Number.isFinite(FS.trainingDraft?.n) ? FS.trainingDraft.n : 100;
  const training = trainingQuote(h, trainUnit, trainN, now, FS.season?.programVersion);
  const upgrade = upgradeModel(h, m.stores, now);
  const upkeep = (h.upkeep ?? []).map((v, i) => ({ resource: RESOURCE_ORDER[i], perHour: Number(v) / 1000 })).filter(x => x.perHour > 0);
  const buildCard = c => {
    const blocked = actionBusy || m.blocks.Build.length || queueFull || c.short.length;
    return html`<li class="build-card ${c.short.length ? 'short' : ''}${c.intro ? ' intro-build' : ''}"><button type="button" class="btn" data-act="build" data-item="${c.item}" ${raw(blocked ? 'disabled' : '')}>${BUILDINGS[c.resource]}</button>
      <span class="bc-yield">${c.perHour ? html`<span class="res-dot res-c-${c.resource}" aria-hidden="true"></span> ${L`${RESOURCES[c.resource]} +${c.perHour}/時`}` : L`守りを固める`}</span>
      <span class="bc-time">⏱ ${L`工事 ${span(c.secs)}`}${c.intro ? html` <span class="intro-build-badge">${L`初めての建設`}</span>` : c.copies ? html` <span class="muted">${L`（${fmtNum(c.copies + 1)}つ目）`}</span>` : ''}${c.wait > 0 ? html` <span class="muted">${L`完成まで ${span(c.wait + c.secs)}`}</span>` : ''}</span>
      <span class="bc-cost">${c.cost ? costText(c.cost) : L`石材で守りを固める（ターンの始まりの守り手に数えられるのは完成した次のターンから）`}</span>
      ${c.short.length ? html`<span class="bc-short">${L`足りない：${c.short.map(x => `${RESOURCES[x.resource]} ${fmtNum(x.need)}`).join(' · ')}`}</span>` : ''}</li>`;
  };
  return html`<section aria-labelledby="holding-title" class="holding"><h3 id="holding-title">${holdingName(h)} <span class="muted">${L`村 州 ${h.p},${h.q} 区画 ${h.site + 1}`}</span></h3>
    <dl class="facts">
      ${row(L`段階`, html`${TIERS[h.tier] ?? h.tier} · ${state}${termButton('tier')}`)}
      ${f.state === 'provisional' ? row(L`確定`, L`同じターンの入植希望がすべて決まってから`) : ''}
      ${f.shieldLeft > 0 ? row(L`保護`, html`${inTime(f.shieldLeft)}${termButton('shield')}`) : ''}
      ${row(L`休眠まで`, html`${f.dormantIn > 0 ? inTime(f.dormantIn) : L`休眠中`}${termButton('dormant')}`)}
    </dl>
    <nav class="hp-nav" aria-label="${L`村の操作`}">${PANELS.map(x => html`<button type="button" class="hp-chip" data-act="hp-jump" data-id="${x.id}"><span aria-hidden="true">${x.glyph}</span>${x.text()}</button>`)}</nav>

    <section class="hpanel" id="hp-harvest" aria-labelledby="hp-harvest-h"><h4 id="hp-harvest-h">❦ ${L`資源`}</h4>
    <table class="stores"><thead><tr><th scope="col">${L`資源`}</th><th scope="col">${L`量`}</th><th scope="col">${L`毎時`}</th><th scope="col">${L`上限`}</th></tr></thead>
      <tbody>${m.stores.map(s => html`<tr class="${s.cap > 0 && s.value >= s.cap ? 'store-full' : ''}"><th scope="row"><span class="res-dot res-c-${s.resource}" aria-hidden="true"></span> ${RESOURCES[s.resource]}</th><td>${fmtNum(s.value)}${s.cap > 0 && s.value >= s.cap ? html` <span class="flag">${L`満杯`}</span>` : ''}</td><td>${signedRate(s.perHour)}</td><td>${fmtNum(s.cap)}</td></tr>`)}</tbody></table>
    <p class="muted">${L`毎時の収支は、生産から現在の維持費を引いた量です。資源は画面を閉じても増減します。`}</p>
    ${upkeep.length ? html`<p>${L`現在の維持費（毎時）`}: ${upkeep.map(x => `${RESOURCES[x.resource]} ${fmtNum(x.perHour)}`).join(' · ')}</p>` : ''}
    <p><button type="button" class="btn primary" data-act="harvest" ${raw(actionBusy || m.blocks.Harvest.length ? 'disabled' : '')}>${L`収穫する`}</button>
      ${full.length ? html`<span class="muted">${L`${full.map(s => RESOURCES[s.resource]).join(' / ')}が満杯：これ以上は増えません`}</span>` : ''}</p>
    ${blockedLine(m.blocks.Harvest)}</section>

    <section class="hpanel${first ? ' first-build-panel' : ''}" id="hp-build" aria-labelledby="hp-build-h"><h4 id="hp-build-h">⚒ ${first ? L`最初の建設を選ぶ` : L`建設（列は${fmtNum(slots)}つまで）`}</h4>
    ${first ? html`<p>${L`農場で食料を増やすか、伐採所で木材を増やすか。村の最初の仕事を選びましょう。`}</p><p class="muted">${L`最初の生産施設の工事は60秒です。ほかの工事があると順番を待ちます。資源の費用は通常どおりです。`}</p>` : ''}
    ${f.queue.length ? html`<ul class="list hp-queue">${f.queue.map(q => html`<li>${queueItemLabel(q)} · ${q.doneIn > 0 ? html`${L`あと ${span(q.doneIn)}`}` : L`完成`}</li>`)}</ul>` : html`<p class="muted">${L`建設の列は空です`}</p>`}
    <ul class="build-cards">${(first ? cards.slice(0, 2) : cards).map(buildCard)}</ul>
    ${first ? html`<details class="guide-more"><summary>${L`ほかの建物を選ぶ`}</summary><ul class="build-cards">${cards.slice(2).map(buildCard)}</ul></details>` : ''}
    ${queueFull ? html`<p class="blocked">${L`建設の列がいっぱいです（${fmtNum(slots)}つまで）`}</p>` : ''}
    ${blockedLine(m.blocks.Build)}</section>

    ${upgrade ? html`<section class="hpanel upgrade-panel" id="hp-upgrade"><h4>${L`${TIERS[upgrade.next]}へ村を育てる`}</h4>
      <p>${L`資源の上限 ${fmtNum(storageCap(h.tier))} → ${fmtNum(upgrade.cap)} · 建設枠 ${fmtNum(slots)} → ${fmtNum(upgrade.slots)}`}</p>
      <p>${L`村の基礎生産の増加（毎時）`}: ${upgrade.gains.map(x => `${RESOURCES[x.resource]} +${fmtNum(x.perHour)}`).join(' · ')}</p>
      <p>${costText(upgrade.cost)} · ${L`完成まで ${span(upgrade.wait + upgrade.secs)}`}</p>
      ${upgrade.short.length ? html`<p class="blocked">${L`足りない：${upgrade.short.map(x => `${RESOURCES[x.resource]} ${fmtNum(x.need)}`).join(' · ')}`}</p>` : ''}
      <button type="button" class="btn" data-act="build" data-item="7" ${raw(actionBusy || m.blocks.Build.length || queueFull || upgrade.short.length || upgrade.pending ? 'disabled' : '')}>${upgrade.pending ? L`村の昇格を進めています` : L`村を昇格する`}</button>
    </section>` : ''}

    <section class="hpanel" id="hp-train" aria-labelledby="hp-train-h"><h4 id="hp-train-h">⚔ ${L`訓練（すぐに終わります）`}</h4>
    <form class="inline" data-form="train"><label>${L`兵種`}<select name="unit">${units.map(x => html`<option value="${x.i}" ${raw(x.i === trainUnit ? 'selected' : '')}>${UNITS[x.u]}</option>`)}</select></label>
      <label>${L`人数`}<input name="n" type="number" min="1" max="30000" step="1" value="${trainN}" inputmode="numeric"></label>${steps('n', { max: training.max })}
      <p class="training-cost" aria-live="polite">${training.cost ? html`${L`訓練の費用`}: ${costText(training.cost)}` : L`1〜30,000人で人数を決めてください。`}</p>
      <p class="muted">${L`いま訓練できる人数 ${fmtNum(training.max)}（一隊の上限まで）`}</p>
      ${training.short.length ? html`<p class="blocked">${L`足りない：${training.short.map(x => `${RESOURCES[RESOURCE_ORDER[x.resource]]} ${fmtNum(x.need)}`).join(' · ')}`}</p>` : ''}
      <button type="submit" class="btn" ${raw(actionBusy || m.blocks.Train.length || !training.affordable || trainN > 30000 ? 'disabled' : '')}>${L`訓練する`}</button></form>
    <p class="muted">${L`費用は100人単位で切り上げます。訓練した兵は控えに入り、編成すると地図上の軍勢になります。`}</p>
    ${blockedLine(m.blocks.Train)}
    <h4>${L`控えの兵`}</h4>
    ${f.reserve.length ? html`<ul class="list">${f.reserve.map(r => html`<li>${UNITS[UNIT_ORDER[r.unit]]} ${fmtNum(r.troops)}</li>`)}</ul>` : html`<p class="muted">${L`控えの兵はいません`}</p>`}</section>

    <section class="hpanel" id="hp-muster" aria-labelledby="hp-muster-h"><h4 id="hp-muster-h">⚑ ${L`軍勢を編成する`}</h4>
    <form class="inline" data-form="muster"><label>${L`兵種`}<select name="unit">${f.reserve.filter(r => r.unit !== SETTLER).map(r => html`<option value="${r.unit}">${UNITS[UNIT_ORDER[r.unit]]}</option>`)}</select></label>
      <label>${L`兵数（100〜30,000）`}<input name="troops" type="number" min="100" max="30000" step="1" value="100" inputmode="numeric"></label>${steps('troops', { max: Math.min(30000, f.reserve.find(r => r.unit !== SETTLER)?.troops ?? 0) || null })}
      <button type="submit" class="btn" ${raw(actionBusy || m.blocks.Muster.length || !f.reserve.length ? 'disabled' : '')}>${L`編成する`}</button></form>
    ${!f.reserve.length ? html`<p class="blocked">${L`控えの兵がいません：先に訓練しましょう`}</p>` : ''}
    <p class="muted">${L`編成は世界の処理に反映されてから行動できます。目安はゲーム内で約11〜21分です。`}</p>
    ${blockedLine(m.blocks.Muster)}
    <h4>${L`進軍の記録（4つ）`}</h4>
    ${f.transits.length ? html`<ul class="list">${f.transits.map(t => html`<li>${L`枠 ${t.slot + 1}：第${fmtNum(t.arriveBell)}ターンに到着`}</li>`)}</ul>` : html`<p class="muted">${L`進軍中の軍勢はいません`}</p>`}</section>

    <section class="hpanel" id="hp-garrison" aria-labelledby="hp-garrison-h"><h4 id="hp-garrison-h">⛨ ${L`守備隊`}${termButton('garrison')}</h4>
    <form class="inline" data-form="garrison"><label>${L`増員（控えの兵から）`}<input name="delta" type="number" min="1" step="1" value="100" inputmode="numeric"></label>${steps('delta', { max: f.reserve.filter(r => r.unit !== SETTLER).reduce((a, r) => a + r.troops, 0) || null })}
      <button type="submit" class="btn" ${raw(actionBusy || m.blocks.Garrison.length ? 'disabled' : '')}>${L`守備隊を増やす`}</button></form>
    <p class="muted">${L`M1 の守備隊は増やすだけです（引き上げは次の段階で）。`}</p>
    ${blockedLine(m.blocks.Garrison)}
    <h4>${L`夜番の時間`}${termButton('vigil')}</h4>
    <p class="muted">${L`${String(Math.floor((FS.citizen?.vigilStartMin ?? 0) / 60)).padStart(2, '0')}:${String((FS.citizen?.vigilStartMin ?? 0) % 60).padStart(2, '0')} から（UTC）`}</p>
    <form class="inline" data-form="vigil"><label>${L`開始（UTC の時）`}<select name="hour">${Array.from({ length: 24 }, (_, hr) => html`<option value="${hr}" ${raw(hr === Math.floor((FS.citizen?.vigilStartMin ?? 0) / 60) ? 'selected' : '')}>${L`${String(hr).padStart(2, '0')}:00 UTC（あなたの時刻 ${localHour(hr)}）`}</option>`)}</select></label>
      <button type="submit" class="btn" ${raw(actionBusy ? 'disabled' : '')}>${L`変える`}</button></form>
    <p class="muted">${L`変更は24時間以上あとの最初の UTC 0時から有効で、週に1回までです。`}</p></section>
    ${f.finalTs && f.state === 'provisional' ? html`<p class="muted">${Lh`早くても ${timeHtml(f.finalTs)} 以降に確定します。`}</p>` : ''}
  </section>`;
}
