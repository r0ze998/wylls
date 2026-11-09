// The village screen's wide village (read-only): what the captured
// WideHolding bytes say, with their provenance and their age said honestly
// (fwide.mjs; docs/frontier/map-growth/WIDE-HOLDING-VILLAGE-UI-20261108.md).
// Takes the place of the legacy village's cards while `FS.wideSelect` names
// a wide inventory slot; the legacy village and its actions are untouched
// and come back with one press (or any legacy selection).
//
// What the cards show is the record as captured: the stores' recorded
// amounts (no production added since, no settle estimated), the queue's
// recorded due times (no countdown), the reserve's recorded counts. Each
// card says so. The captured slot stands against the fold's latest slot as
// a slot count; the age in time is unknown (a capture carries no clock).
// There is no action here: no builder, trainer, muster, march, caravan or
// nudge takes a wide village (fwide.mjs wideRefusal), and the only wide
// instructions are not enabled.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { RESOURCES, UNITS, TIERS, BUILDINGS, HOLDING_STATES } from '../fi18n.mjs';
import { UNIT_ORDER, HOLDING_STATE, queueBuildingItem, BUILD_ITEMS } from '../fland.mjs';
import { icon, RESOURCE_ICON } from '../hud/icons.mjs';
import { cardHead, stamp, chip, fold } from './parts.mjs';
import { lamports } from './shell.mjs';
import { selectedWide, wideSlots } from '../fwide.mjs';

/** An exact amount of stored milli-units as "123.456" (never a Number: 2^53 and above survive). */
export function formatMilli(s) {
  let v = BigInt(String(s));
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / 1000n, frac = v % 1000n;
  return `${neg ? '−' : ''}${whole.toString()}.${frac.toString().padStart(3, '0')}`;
}
/** A recorded chain time (seconds) as its UTC clock text, or the raw figure when it is not a plausible time. */
export function recordedTime(s) {
  const v = BigInt(String(s));
  if (v <= 0n || v > 253402300799n) return String(v);
  return new Date(Number(v) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
const coordText = (p, q) => `P ${String(p)}, Q ${String(q)}`;
const fact = (k, v) => html`<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`;

/**
 * The view model (what the tests read): `{kind: 'none'}` while no wide village is selected; else the slot's
 * `status` and, for a captured one, the identity, provenance, currentness and the record's economy, all of it
 * with `executable: false`.
 */
export function wideModel(FS) {
  const e = selectedWide(FS);
  if (!e) return { kind: 'none' };
  const base = { kind: 'wide', inventorySlot: e.inventorySlot, status: e.status, executable: false, readOnly: true };
  if (!e.holding) return base;
  const h = e.holding, x = h.economy;
  return {
    ...base,
    holding: h,
    title: L`遠方の村 第${String(h.ring)}輪（枠 ${fmtNum(h.inventorySlot)}）`,
    stores: x.stores.map(s => ({ resource: s.resource, value: formatMilli(s.value), cap: formatMilli(s.cap), rate: formatMilli(s.rate), settledAt: recordedTime(s.t0) })),
    queue: x.queue.filter(q => q.inUse).map(q => ({ ...q, item: queueBuildingItem(q), doneAt: recordedTime(q.doneAt) })),
    reserve: x.reserve.map((n, unit) => ({ unit, troops: n })).filter(r => r.troops > 0),
    currentness: h.currentness,
  };
}

const queueLabel = q => (q.item === 7 ? L`村の昇格` : q.item !== null && q.item !== undefined ? BUILDINGS[BUILD_ITEMS[q.item]?.resource] ?? L`建物` : L`維持費の変更`);

/** The read-only notice every wide card stands under. */
export const noExecutionNote = () => html`<p class="blocked wide-noexec">${icon('alert')}${L`読み取り専用：この村には命令を送れません（収穫・建設・訓練・編成・進軍・隊商・追いつかせる のどれも）。表示は捕捉された村の記録から読んだもので、現在の状態でも所有の証明でもありません。`}</p>`;

export function render(FS) {
  const m = wideModel(FS);
  if (m.kind === 'none') return '';
  const back = html`<div class="actions"><button type="button" class="btn" data-act="wide-close">${icon('return')}${L`ふつうの村に戻る`}</button></div>`;
  if (m.status === 'not-captured') {
    return [html`<section class="vcard wide-village" aria-labelledby="wide-v-title">
      ${cardHead({ id: 'wide-v-title', ic: 'home', title: L`遠方の村（枠 ${fmtNum(m.inventorySlot)}）`, side: stamp(L`捕捉なし`, 'warn') })}
      <p>${L`この枠は遠方の村に充てられていますが、その記録は捕捉されていません。空の枠でも 0 でもなく、不明です。`}</p>
      ${noExecutionNote()}${back}</section>`];
  }
  if (m.status === 'ambiguous') {
    return [html`<section class="vcard wide-village" aria-labelledby="wide-v-title">
      ${cardHead({ id: 'wide-v-title', ic: 'home', title: L`遠方の村（枠 ${fmtNum(m.inventorySlot)}）`, side: stamp(L`不定`, 'bad') })}
      <p>${L`同じ枠に複数の捕捉記録が一致しました。どれも表示しません。`}</p>
      ${noExecutionNote()}${back}</section>`];
  }
  const h = m.holding, x = h.economy, c = m.currentness;
  const state = HOLDING_STATE[x.state] ?? 'none';
  const head = html`<section class="vcard village-head wide-village" aria-labelledby="wide-v-title">
    ${cardHead({ id: 'wide-v-title', ic: 'home', title: m.title, sub: `${coordText(h.p, h.q)} · ${L`村の場所 ${fmtNum(h.site)} · 世代 ${fmtNum(h.generation)}`}`, side: stamp(L`捕捉・未検証`, 'warn') })}
    <ul class="fact-chips">
      <li>${chip(L`読み取り専用`, 'info', 'eye')}</li>
      <li>${chip(L`現在性：未確認`, 'warn', 'hourglass')}</li>
      <li>${chip(L`経過時間：不明`, '', 'moon')}</li>
    </ul>
    ${noExecutionNote()}<div class="actions"><button type="button" class="btn" data-act="wide-map">${L`記録の地図で場所を見る（未検証・読み取り専用）`}</button></div>${back}</section>`;

  const provenance = html`<section class="vcard wide-village" aria-labelledby="wide-v-prov">
    ${cardHead({ id: 'wide-v-prov', ic: 'scroll', title: L`出どころ` })}
    <dl class="facts">
      ${fact(L`場所（正確な座標）`, coordText(h.p, h.q))}
      ${fact(L`世界`, html`<code title="${h.world}">${h.world.slice(0, 16)}…</code>`)}
      ${fact(L`シーズン`, h.season)}
      ${fact(L`所有者（市民）`, html`<code>${h.ownerCitizen}</code>`)}
      ${fact(L`記録の場所`, html`<code>${h.capture.address}</code>`)}
      ${fact(L`捕捉スロット`, String(c.capturedSlot))}
      ${fact(L`配信元の最新スロット`, String(c.latestSlot))}
      ${fact(L`スロット差`, L`${String(c.slotsBehind)} スロット（時間ではありません）`)}
      ${fact(L`捕捉の時点`, h.capture.postState === 'transaction' ? L`取引直後` : L`取引以降（正確な過去の状態ではありません）`)}
      ${fact(L`保管番号`, String(h.capture.archiveSequence))}
      ${fact(L`検証`, L`履歴未検証（捕捉記録のみ）`)}
      ${fact(L`経過時間`, L`不明（捕捉記録に時刻はありません）`)}
      ${fact(L`軍勢の識別`, h.hostIdentity === 0 ? L`未割り当て（この村から軍勢は出せません）` : L`完全参照 v1`)}
      ${fact(L`開いている進軍の記録`, fmtNum(h.openTransits))}
    </dl></section>`;

  const stores = html`<section class="vcard wide-village" aria-labelledby="wide-v-stores">
    ${cardHead({ id: 'wide-v-stores', ic: 'crate', title: L`資源（捕捉時の記録値）` })}
    <p class="muted">${L`蔵の記録そのままです。生産の加算や決済の見積もりはしていません。毎時の値は記録上の率です。`}</p>
    <p class="muted wide-ledger-hint">${L`表は横にスクロールできます`}</p>
    <div class="wide-ledger-scroll" tabindex="0" role="region" aria-label="${L`資源（捕捉時の記録値）`}"><table class="ledger"><caption class="visually-hidden">${L`資源`}</caption>
      <thead><tr><th scope="col">${L`品目`}</th><th scope="col">${L`記録値`}</th><th scope="col">${L`上限`}</th><th scope="col">${L`記録上の毎時`}</th><th scope="col">${L`決済時刻（UTC）`}</th></tr></thead>
      <tbody>${m.stores.map(s => html`<tr class="ledger-row"><th scope="row">${icon(RESOURCE_ICON[s.resource] ?? 'crate', 'ledger-ic')}<span class="ledger-name">${RESOURCES[s.resource]}</span></th>
        <td class="ledger-val">${s.value}</td><td class="ledger-cap">${s.cap}</td><td class="ledger-rate">${s.rate}</td><td class="ledger-t0">${s.settledAt}</td></tr>`)}</tbody></table></div>
    ${x.foodShortfall !== '0' ? html`<p class="muted">${L`食料の不足（記録）：${formatMilli(x.foodShortfall)}`}</p>` : ''}</section>`;

  const build = html`<section class="vcard wide-village" aria-labelledby="wide-v-build">
    ${cardHead({ id: 'wide-v-build', ic: 'hammer', title: L`建設（捕捉時の記録）`, side: html`<span class="c-count">${L`建設中 ${fmtNum(m.queue.length)}`}</span>` })}
    <dl class="facts">
      ${fact(L`段階`, `${TIERS[x.tier] ?? x.tier} · ${HOLDING_STATES[state]}`)}
      ${fact(L`城壁（記録）`, fmtNum(x.walls))}
    </dl>
    ${m.queue.length ? html`<ul class="queue">${m.queue.map(q => html`<li>${icon('hourglass')}<strong>${queueLabel(q)}</strong><span class="queue-t">${L`記録上の完了予定 ${q.doneAt}（UTC）`}</span></li>`)}</ul>` : html`<p class="muted">${L`記録上、建設の列は空です`}</p>`}
    <p class="muted">${L`残り時間は表示しません：記録の時点が今ではないためです。`}</p></section>`;

  const troops = html`<section class="vcard wide-village" aria-labelledby="wide-v-troops">
    ${cardHead({ id: 'wide-v-troops', ic: 'sword', title: L`兵（捕捉時の控え）`, side: html`<span class="c-count">${L`控え ${fmtNum(m.reserve.reduce((a, r) => a + r.troops, 0))}`}</span>` })}
    ${m.reserve.length ? html`<ul class="reserve-list">${m.reserve.map(r => html`<li>${UNITS[UNIT_ORDER[r.unit]] ?? r.unit} ${fmtNum(r.troops)}</li>`)}</ul>` : html`<p class="muted">${L`記録上、控えの兵はいません`}</p>`}
    <p class="muted">${L`訓練も編成もここからはできません。`}</p></section>`;

  const more = html`<section class="vcard vcard-folds wide-village" aria-label="${L`そのほか`}">
    ${fold('wide-v-raw', html`${icon('scroll')}${L`記録のそのほかの値`}`, html`<dl class="facts">
      ${fact(L`創設（記録上の時刻）`, recordedTime(x.foundedTs))}
      ${fact(L`最後の所有者の操作（記録上の時刻）`, recordedTime(x.lastOwnerAction))}
      ${fact(L`保護の期限（記録上の時刻）`, recordedTime(x.shieldUntil))}
      ${fact(L`確定（記録上の時刻）`, recordedTime(x.finalTs))}
      ${fact(L`預かり`, lamports(x.escrow))}
      ${fact(L`生産（記録上の毎時）`, x.production.map((v, i) => `${RESOURCES[x.stores[i].resource]} ${formatMilli(v)}`).join(' · '))}
      ${fact(L`維持費（記録上の毎時）`, x.upkeep.map((v, i) => `${RESOURCES[x.stores[i].resource]} ${formatMilli(v)}`).join(' · '))}
    </dl>`)}</section>`;
  return [head, provenance, stores, build, troops, more];
}

/** Failed or unavailable wide reads are visible beside both layouts, never silently an empty inventory. */
export function renderWideInventoryStatus(FS) {
  if (FS?.mode !== 'play' || !FS.citizen || !['error', 'unavailable'].includes(FS.wideStatus)) return '';
  const failed = FS.wideStatus === 'error';
  const message = failed
    ? L`遠方の村の情報を読み込めません（${FS.wideError?.code ?? 'Unavailable'}）。保有地がないことを意味しません。`
    : L`この配信元では遠方の村の情報を取得できません。保有地の有無は不明です。`;
  return html`<section class="blocked wide-inventory-status" role="status"><p>${message}</p>${failed ? html`<button type="button" class="btn small" data-act="me-retry">${L`再試行`}</button>` : ''}</section>`;
}

/**
 * The rail's wide pips beside the village plate (hud/hud.mjs renderRail): one press per wide inventory slot,
 * marked by its state; nothing while the inventory is unknown, unavailable or has no wide slot. Never a legacy pip.
 */
export function renderWidePips(FS) {
  if (FS?.mode !== 'play') return '';
  const slots = wideSlots(FS);
  if (!slots.length) return '';
  const sel = FS.wideSelect?.inventorySlot ?? null;
  const label = e => (e.status === 'captured-unverified' ? L`遠方の村（枠 ${fmtNum(e.inventorySlot)}・捕捉・未検証・読み取り専用）`
    : e.status === 'not-captured' ? L`遠方の村（枠 ${fmtNum(e.inventorySlot)}・捕捉なし）` : L`遠方の村（枠 ${fmtNum(e.inventorySlot)}・不定）`);
  return html`<span class="plate-pips wide-pips" role="group" aria-label="${L`遠方の村（読み取り専用）`}">${slots.map(e => html`<button type="button" class="plate-pip wide-pip wide-pip-${e.status === 'captured-unverified' ? 'captured' : e.status === 'not-captured' ? 'missing' : 'ambiguous'}" data-act="wide-select" data-slot="${e.inventorySlot}" aria-current="${sel === e.inventorySlot ? 'true' : 'false'}" aria-label="${label(e)}" title="${label(e)}"><span aria-hidden="true">W${e.inventorySlot}</span></button>`)}</span>`;
}
