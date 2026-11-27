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
// No legacy action takes a wide village here: no builder, trainer, muster,
// march, caravan or nudge (fwide.mjs wideRefusal). The one exception is the
// TEST-ONLY local wide-land world's own host card (「広い土地の軍勢（テスト）」,
// controller `wide-host-step`: train, muster, march), and the header says so
// there (fix-loop6 LP6-6, localWideNote). And on a devnet season the page plays itself, the wide village's own acts
// card (devnet-p17, 「この遠方の村への命令」: harvest, build, train, muster — wallet-paid, two presses; devnetWideNote).
import { html, raw } from '../../util.mjs';
import { fogNow } from '../map/fog.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { RESOURCES, UNITS, TIERS, BUILDINGS, HOLDING_STATES, factionName } from '../fi18n.mjs';
import { UNIT_ORDER, HOLDING_STATE, queueBuildingItem, BUILD_ITEMS, buildItemOf } from '../fland.mjs';
import { RESOURCE_ORDER } from '../resources.mjs';
import { icon, RESOURCE_ICON } from '../hud/icons.mjs';
import { cardHead, stamp, chip, fold } from './parts.mjs';
import { lamports } from './shell.mjs';
import { selectedWide, wideSlots } from '../fwide.mjs';
import { devnetWideVillageOn } from '../fdevnetplay.mjs';
import { solText } from '../fdevnet-outpost.mjs';
import { WIDE_HARVEST, WIDE_BUILD, WIDE_TRAIN, WIDE_MUSTER, WIDE_UNITS, WIDE_VILLAGE_MAX_TROOPS } from '../fdevnet-wide-village.mjs';
import { WIDE_BUILD_ITEM_MAX, WIDE_MIN_HOST_TROOPS } from '../flocalplay-wide-host.mjs';

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

const queueLabel = q => (q.item === 7 ? L`村の昇格` : q.item !== null && q.item !== undefined ? BUILDINGS[buildItemOf(q.item)?.resource] ?? L`建物` : L`維持費の変更`);

/** The read-only notice every wide card stands under. */
export const noExecutionNote = () => html`<p class="blocked wide-noexec">${icon('alert')}${L`読み取り専用：この村には命令を送れません（収穫・建設・訓練・編成・進軍・隊商・追いつかせる のどれも）。表示は捕捉された村の記録から読んだもので、現在の状態でも所有の証明でもありません。`}</p>`;

/**
 * (fix-loop6, LP6-6) The notice in a local wide-land world, where the card below DOES send (train, muster, march): the
 * header said 「読み取り専用：この村には命令を送れません（…訓練・編成・進軍…）」 right above it.
 */
export const localWideNote = () => html`<p class="blocked wide-noexec">${icon('alert')}${L`この村の記録の表示は読み取り専用です。命令は、下の「広い土地の軍勢（テスト）」だけが送ります（訓練・編成・進軍）。収穫・建設・隊商・追いつかせる は、この村には送れません。`}</p>`;

/** (devnet-p17) The notice on a devnet season, where the card below DOES send the village's own four acts. */
export const devnetWideNote = () => html`<p class="blocked wide-noexec">${icon('alert')}${L`この村の記録の表示は読み取り専用です。命令は、下の「この遠方の村への命令」だけが送ります（収穫・建設・訓練・編成）。進軍・隊商・追いつかせる は、この村には送れません。`}</p>`;

/** (devnet-p17) Whether the devnet wide village acts card stands on this page (devnet play carries all four acts). */
export const wideActsOn = FS => !!FS?.devnetPlay && !FS.localPlay && devnetWideVillageOn(FS.devnetPlay);

const unitName = u => UNITS[UNIT_ORDER[u]] ?? String(u);
const itemName = item => (item === 7 ? L`村の昇格` : item === 6 ? BUILDINGS.Walls : BUILDINGS[buildItemOf(item)?.resource] ?? L`建物`);
/** (devnet-p17) The act in the page's words, with its figures (the preview's and the result's title). */
export function wideActLabel(name, fields = {}) {
  if (name === WIDE_HARVEST) return L`収穫`;
  if (name === WIDE_BUILD) return L`建設：${itemName(fields.item)}`;
  if (name === WIDE_TRAIN) return L`訓練：${unitName(fields.unit)} ${fmtNum(fields.n)}`;
  if (name === WIDE_MUSTER) return L`編成：${unitName(fields.unit)} ${fmtNum(fields.troops)}（マス ${fmtNum(fields.tile)}）`;
  return name;
}
/** (devnet-p17) The result read back, line by line (the record's own figures); [] while nothing is read yet. */
export function wideActResultLines(res) {
  if (!res) return [];
  if (!res.changed) return [L`遠方の村の記録は、まだ変わって見えません。チェーンには記録されています。次の読み込みで表示されます。`];
  const out = [];
  for (const r of res.reserve ?? []) out.push(L`控えの${unitName(r.unit)}：${fmtNum(r.from)} → ${fmtNum(r.to)}`);
  if (res.queue) out.push(L`建設の列：${fmtNum(res.queue.from)} → ${fmtNum(res.queue.to)}`);
  if (res.walls) out.push(L`城壁：${fmtNum(res.walls.from)} → ${fmtNum(res.walls.to)}`);
  if (res.tier) out.push(L`村の段階：${TIERS[res.tier.from] ?? res.tier.from} → ${TIERS[res.tier.to] ?? res.tier.to}`);
  for (const x of (res.stores ?? []).slice(0, 4)) out.push(L`${RESOURCES[x.resource] ?? x.resource}：${formatMilli(x.from)} → ${formatMilli(x.to)}`);
  if (!out.length) out.push(L`遠方の村の記録が更新されました（最後の操作の時刻）。`);
  return out;
}

/**
 * (devnet-p17, devnet gap P17) The devnet wide village acts card: harvest, build, train, muster — each its own small
 * form whose first press (「費用を確認」, FORMS 'wide-act-preview') reads everything again and says what the wallet pays;
 * the second (「署名して送る」, 'wide-act-send') sends ONE wallet-signed act; then the result read back. '' when off.
 */
export function wideActsCard(FS, m) {
  if (!wideActsOn(FS) || m?.kind !== 'wide' || !m.holding) return '';
  // (a preview or result of another wide village — the rail switched — is not this card's)
  const pv0 = FS.wideActPreview ?? null, here = pv0?.village && pv0.village.p === String(m.holding.p) && pv0.village.q === String(m.holding.q) && pv0.village.site === Number(m.holding.site);
  const x = m.holding.economy, pv = here ? pv0 : null, busy = !!FS.homeActionBusy || (FS.inFlight ?? 0) > 0;
  const dis = busy || pv?.step === 'preview' ? 'disabled' : '';
  const reserve = WIDE_UNITS.map(u => ({ unit: u, troops: Number(x.reserve?.[u] ?? 0) }));
  const musterUnit = reserve.find(r => r.troops >= WIDE_MIN_HOST_TROOPS)?.unit ?? 0;
  // (verify-pr151: only THIS village's province's tiles — another wide village's province read earlier is not offered)
  const wp = FS.wideActProvince, tiles = wp && wp.p === String(m.holding.p) && wp.q === String(m.holding.q) ? wp.passable : null;
  const unitSelect = (id, sel, list = WIDE_UNITS) => html`<select id="${id}" name="unit">${list.map(u => html`<option value="${u}" ${raw(u === sel ? 'selected' : '')}>${unitName(u)}</option>`)}</select>`;
  const form = (act, body, hint) => html`<form class="vform wide-act" data-form="wide-act-preview" data-wide-act="${act}"><input type="hidden" name="act" value="${act}">${body}
    <div class="actions"><button type="submit" class="btn" data-wide-preview="${act}" ${raw(dis)}>${L`費用を確認`}</button>${hint ? html`<span class="muted">${hint}</span>` : ''}</div></form>`;
  const forms = [
    form(WIDE_HARVEST, html`<h4>${L`収穫`}</h4>`, L`蔵の生産を記録に入れます。`),
    form(WIDE_BUILD, html`<h4>${L`建設`}</h4><label for="wa-item">${L`建物`}</label><select id="wa-item" name="wide_item">${Array.from({ length: WIDE_BUILD_ITEM_MAX + 1 }, (_, i) => html`<option value="${i}">${itemName(i)}</option>`)}</select>`,
      L`費用は村の蔵から払います。`),
    form(WIDE_TRAIN, html`<h4>${L`訓練`}</h4><label for="wa-tunit">${L`兵種`}</label>${unitSelect('wa-tunit', 0)}<label for="wa-n">${L`人数`}</label><input id="wa-n" name="n" type="number" min="1" max="${WIDE_VILLAGE_MAX_TROOPS}" step="1" value="100" inputmode="numeric">`,
      L`費用は村の蔵から払い、兵はすぐ控えに入ります。`),
    form(WIDE_MUSTER, html`<h4>${L`編成`}</h4><label for="wa-munit">${L`兵種`}</label>${unitSelect('wa-munit', musterUnit)}<label for="wa-troops">${L`兵数（100〜30,000）`}</label><input id="wa-troops" name="troops" type="number" min="${WIDE_MIN_HOST_TROOPS}" max="${WIDE_VILLAGE_MAX_TROOPS}" step="1" value="${Math.max(WIDE_MIN_HOST_TROOPS, Math.min(reserve[musterUnit].troops, 1000))}" inputmode="numeric">
      <label for="wa-tile">${L`マス`}</label><select id="wa-tile" name="tile"><option value="-1">${L`自動（通れる最初のマス）`}</option>${(tiles ?? []).map(t => html`<option value="${t}">${fmtNum(t)}</option>`)}</select>`,
      L`村が確定し、州の前のターンが決着していると編成できます。控えの兵 ${fmtNum(reserve.reduce((a, r) => a + r.troops, 0))}。`),
  ];
  let status = '';
  if (pv?.step === 'preview') {
    const c = pv.cost;
    status = html`<div class="wide-act-preview" role="status" data-wide-act-step="preview" data-total="${String(c.total)}">
      <p><strong>${wideActLabel(pv.name, pv.fields)}</strong></p>
      <p>${L`ウォレットが払う額：最大 ${solText(c.total)} SOL（devnet の SOL）`}</p>
      <ul class="muted"><li>${L`手数料（署名1つ）：${solText(c.fee)} SOL`}</li>${pv.rosterNew ? html`<li>${L`この州で最初の編成：軍勢の名簿（3,248 バイト）の家賃 ${solText(c.deposit)} SOL。名簿はこの世界が続くあいだ残ります。`}</li>` : ''}</ul>
      ${(pv.warn ?? []).includes('WideProvinceLag') ? html`<p class="blocked">${L`この村の州の記録は ${fmtNum(Number(pv.province?.resolvedNext ?? 0))} ターンまで決着しています（いまはターン ${fmtNum(Number(FS.nowBell ?? 0))}）。チェーンに断られたら送られず、手数料もかかりません。少し待ってからもう一度どうぞ。`}</p>` : ''}
      <p class="muted">${L`送る前にチェーンが内容を確かめます。断られたら送られず、何も払いません。`}</p>
      <div class="actions"><button type="button" class="btn primary" data-act="wide-act-send" ${raw(busy ? 'disabled' : '')}>${L`署名して送る`}</button><button type="button" class="btn ghost" data-act="wide-act-cancel">${L`やめる`}</button></div></div>`;
  } else if (pv?.step === 'sent') {
    const lines = wideActResultLines(pv.result);
    status = html`<div class="wide-act-result" role="status" data-wide-act-step="${pv.result ? 'result' : 'sent'}" data-changed="${pv.result ? String(!!pv.result.changed) : ''}">
      <p><strong>${wideActLabel(pv.name, pv.fields)}</strong> — ${L`チェーンに記録されました。`}</p>
      ${lines.length ? html`<ul>${lines.map(t => html`<li>${t}</li>`)}</ul>` : html`<p class="muted">${icon('hourglass')}${L`遠方の村の記録を読み直しています…`}</p>`}
      <p class="muted"><code title="${pv.signature}">${String(pv.signature).slice(0, 16)}…</code></p></div>`;
  }
  return html`<section class="vcard wide-village" id="wide-acts" aria-labelledby="wide-acts-h">
    ${cardHead({ id: 'wide-acts-h', ic: 'hammer', title: L`この遠方の村への命令`, side: stamp(L`devnet・ウォレット払い`, 'info') })}
    <p>${L`命令ごとに、あなたのウォレットが1回だけ署名し、手数料を払います（この州で最初の編成なら、軍勢の名簿の家賃も）。まず「費用を確認」で払う額を見てから送ります。`}</p>
    ${status}${forms}</section>`;
}

/**
 * (fix-loop5, L5-1) What the wide host card is waiting for (controller `wideHostWait`): the page sends nothing while it
 * waits and asks again by itself about once a turn, so the player does not press again and again.
 */
export function wideHostWaitLine(w) {
  if (!w) return '';
  const why = w.reason === 'lag' && Number.isFinite(Number(w.lag))
    ? L`この村の州の決着が ${fmtNum(Number(w.lag))} ターン遅れています。追いつくまでは、どの命令も通りません。`
    : w.reason === 'host' ? L`軍勢が整列中か休んでいます。進軍できるようになるまで待ちます。`
    : w.reason === 'village' ? L`広い土地の村がまだ確定していません。`
    : w.reason === 'march' ? L`軍勢の進軍の結果を待っています。`
    // (fix-loop7, LP7-5: the host stands on the keep and the hold counts: followed to its end)
    : w.reason === 'hold' ? (Number.isFinite(Number(w.hold?.required)) && Number.isFinite(Number(w.hold?.progress))
      ? L`砦の占拠を見守っています（あと ${fmtNum(Math.max(0, Number(w.hold.required) - Number(w.hold.progress)))} ターン）。奪えたか、占拠が止まったかを、ここに出します。`
      : L`砦の占拠を見守っています。奪えたか、占拠が止まったかを、ここに出します。`)
    : L`送るあいだにターンが変わりました（州の決着待ち）。次のターンにもう一度送ります。`;
  // (fix-loop8, LP8-5: after a capture the page only LOOKS: the next cycle is the person's to start)
  // (fix-loop10, LP10-2: a host that only joined a hold, or arrived at a keep already its nation's, did not take the keep)
  if (w.reason === 'captured' && (w.hold?.already || w.hold?.shared)) return html`<p class="wide-host-wait" role="status" data-wide-host-wait="captured" data-wide-host-joined="${w.hold.already ? 'already' : w.hold.shared}">${icon('hourglass')}${L`この村の軍勢は、その砦のマスに着いています。この村から次の軍勢を出せるのは、その進軍の記録が締めくくられ、州の決着が追いついたあとです（負荷が高いと数十ターンかかります）。このページが約 1 ターンごとに確かめ、次の一手を送れるようになったらボタンでお知らせします（自動では送りません）。`}</p>`;
  if (w.reason === 'captured') return html`<p class="wide-host-wait" role="status" data-wide-host-wait="captured">${icon('hourglass')}${L`砦を奪った軍勢は、その砦に残って守っています。この村から次の軍勢を出せるのは、その進軍の記録が締めくくられ、州の決着が追いついたあとです（負荷が高いと数十ターンかかります）。このページが約 1 ターンごとに確かめ、次の一手を送れるようになったらボタンでお知らせします（自動では送りません）。`}</p>`;
  return html`<p class="wide-host-wait" role="status" data-wide-host-wait="${w.reason}">${icon('hourglass')}${why} ${L`このページが約 1 ターンごとに自動で確かめ、送れるようになったら一手を送ります。押し直す必要はありません（押しても何も送りません）。`}</p>`;
}

/**
 * (fix-loop6, LP6-15 / LP6-5) What the wide host card says of the planner's last answer (controller `wideHostSayOf`), in
 * the page's language — it showed the planner's English log words in both languages — and, for a march, where it is:
 * on its way, standing on the keep (with the keep's hold count), being decided, or gone. '' for nothing to say; an answer
 * with no words of its own here is said generically (its log words stay in the card's title).
 */
/**
 * (fix-loop7, LP7-5) The end of this page's own hold of a keep (controller followWideHold): taken, or lost and why. ''
 * while the hold still counts (the march line says the count) or when there is no hold.
 */
export function wideHoldOutcomeText(hold) {
  if (!hold?.outcome || !hold.to) return '';
  const where = `${hold.to.p},${hold.to.q}`;
  // (fix-loop10, LP10-2: whose capture it was — flocalplay-wide-plan.mjs followWideHold `already` / `shared`. loop-play10: the
  //  card credited this village's 100 troops with a keep the player's expedition had held for 70 turns)
  if (hold.outcome === 'taken' && hold.already) return [L`結果：州 ${where} の砦は、この村の軍勢が着いたときにはすでにあなたの国のものでした（ターン ${fmtNum(Number(hold.at ?? 0))} に確認）。この軍勢が奪ったのではありません。`,
    hold.shared === 'expedition' ? L`あなたの遠征の軍勢が先に着いていた砦です。` : ''].filter(Boolean).join(' ');
  if (hold.outcome === 'taken' && hold.shared === 'expedition') return L`結果：州 ${where} の砦はあなたの国のものになりました（ターン ${fmtNum(Number(hold.at ?? 0))} に確認）。あなたの遠征の軍勢が先に着いて占拠を進めていた砦です。この村の軍勢だけで奪ったのではありません。`;
  if (hold.outcome === 'taken' && hold.shared === 'nation') return L`結果：州 ${where} の砦はあなたの国のものになりました（ターン ${fmtNum(Number(hold.at ?? 0))} に確認）。あなたの国の別の軍勢が先に占拠を進めていた砦です。この村の軍勢だけで奪ったのではありません。`;
  if (hold.outcome === 'taken') return L`結果：州 ${where} の砦を奪いました。砦はあなたの国のものです（ターン ${fmtNum(Number(hold.at ?? 0))} に確認）。`;
  if (hold.why === 'held-by-other') return L`結果：州 ${where} の砦は奪えませんでした。軍勢は砦のマスに立っていますが、占拠を進めているのはあなたの国ではなくなりました（砦は${factionName(hold.holder)}が保持）。`;
  return L`結果：州 ${where} の砦は奪えませんでした。軍勢が砦のマスからいなくなり、占拠が止まりました（ターン ${fmtNum(Number(hold.at ?? 0))} に確認。戦いに敗れたか、押し戻されました）。`;
}

export function wideHostSayText(say) {
  if (!say) return '';
  const at = x => (x ? `${x.p},${x.q}` : '?');
  // (fix-loop7, LP7-5: the hold's end, once known, is what the card says — whatever the planner waits for next)
  const ended = wideHoldOutcomeText(say.hold);
  // (verify-pr162: at the TEST cap the last result AND why no more — before the plain result below, which returned
  //  first and hid the cap's words whenever the last march's hold had ended, taken or lost: seen live at turn 601)
  if (say.wait === 'cap' && say.kind !== 'decision') {
    const m = say.march;
    const last = ended || (m?.phase === 'gone' ? L`結果：軍勢は州 ${at(m.to)} に残れませんでした（戦いに敗れました）。` : '');
    return [last, L`この村からの広い土地の中の進軍は、テスト世界では ${fmtNum(Number(say.cap ?? 2))} 回までです。これ以上の進軍は計画しません（辺境の村からの遠征は続けられます）。`].filter(Boolean).join(' ');
  }
  if (ended && say.kind !== 'decision') return ended;
  // (fix-loop11, LP11-1 audit: the last march was sent, its outcome not known then, and the chain refused it afterwards —
  //  it never left: the count of marches is taken back and the village's host is still at home)
  if (say.wait === 'refused') return Number(say.programCode) === 26
    ? L`前の進軍はチェーンで断られました（送るあいだにターンが変わりました。NotResident）。軍勢は村にいます。次のターンにもう一度送ります。`
    : L`前の進軍はチェーンで断られました（上の知らせに理由があります）。軍勢は村にいます。進軍の回数には数えません。`;
  // (and while the hold counts, a wait for the village's own province does not hide it)
  const counting = say.hold && !say.hold.outcome && say.hold.to && Number.isFinite(Number(say.hold.progress))
    ? L`あなたの国が州 ${say.hold.to.p},${say.hold.to.q} の砦を占拠中です：${fmtNum(Number(say.hold.progress))} / ${fmtNum(Number(say.hold.required))} ターン。` : '';
  if (counting && say.kind === 'wait' && say.wait === 'lag') return L`この村の州の決着が ${fmtNum(Number(say.lag ?? 0))} ターン遅れています。` + ' ' + counting;
  if (say.kind === 'decision') {
    // (fix-loop9, LP9-1: a new host after a lost march — the result first, then the step that starts the new host)
    if (say.rebuild && (say.name === 'WideTrain' || say.name === 'WideMuster')) {
      // (w2-wipeout, D-verify-pr137-3: also when the host was wiped out — no survivor home — or became the garrison of
      //  the keep it took. The hold's own end, when followed, is said by the line under this one — wide-host-held)
      const garrison = say.ended === 'garrison' || say.hold?.outcome === 'taken';
      const lost = ended || say.march?.phase !== 'gone' ? ''
        : garrison ? L`結果：州 ${at(say.march.to)} の砦はあなたの国のものになりました。`
        : L`結果：軍勢は州 ${at(say.march.to)} に残れませんでした（戦いに敗れました）。`;
      const home = Number(say.home?.troops ?? 0) > 0 ? L`生き残った兵 ${fmtNum(Number(say.home.troops))} が村に戻っています。兵 100 未満の軍勢は進軍できないため、新しい軍勢を作ります。`
        : garrison ? L`砦を奪った軍勢は、砦の守備兵としてそこに残りました。この村に軍勢はいないため、次の砦へ向かう新しい軍勢を作ります。`
        : say.ended === 'wiped' ? L`軍勢は全滅しました：生き残った兵はなく、村に戻った兵はいません。この村に軍勢はいないため、新しい軍勢を作ります。`
        : L`進軍できる軍勢が村にいないため、新しい軍勢を作ります。`;
      const step = say.name === 'WideTrain' ? L`次の一手：槍兵 ${fmtNum(Number(say.n ?? 0))} を訓練します（兵 100 そろうと編成できます）。` : L`次の一手：槍兵 ${fmtNum(Number(say.troops ?? 0))} の新しい軍勢を編成します。`;
      return [lost, home, step].filter(Boolean).join(' ');
    }
    if (say.name === 'WideTrain') return L`広い土地の村で槍兵 ${fmtNum(Number(say.n ?? 0))} を訓練します。`;
    if (say.name === 'WideMuster') return L`広い土地の村で槍兵 ${fmtNum(Number(say.troops ?? 0))} の軍勢を編成します。`;
    // (fix-loop16, LP16-5: a keep of no nation is said so — 「中立が保持」 / "held by Neutral" was a third name for it)
    if (say.name === 'WideDepart' && say.to?.holder === 6) return L`軍勢（兵 ${fmtNum(Number(say.troops ?? 0))}）が州 ${at(say.to)} の砦へ進軍します（どの国のものでもない砦）。到着はターン ${fmtNum(Number(say.arrive ?? 0))} です。`;
    if (say.name === 'WideDepart') return L`軍勢（兵 ${fmtNum(Number(say.troops ?? 0))}）が州 ${at(say.to)} の砦へ進軍します（${factionName(say.to?.holder)}が保持）。到着はターン ${fmtNum(Number(say.arrive ?? 0))} です。`;
    return L`次の一手を送ります。`;
  }
  const m = say.march;
  // (fix-loop11, LP11-4: the TEST cap's words ride along while the capped march is still followed — on its way, being
  //  decided, or standing beside a keep it does not take. loop-play11: march #2 stood beside Dunmar's keep (60 vs 61) and
  //  never ended, so the cap line the guide promised after the second march never came)
  const capLine = say.cap ? ' ' + L`この村からの広い土地の中の進軍は、テスト世界では ${fmtNum(Number(say.cap))} 回までです。これ以上の進軍は計画しません（辺境の村からの遠征は続けられます）。` : '';
  if (m && capLine) return marchLine(m, at) + capLine;
  // (fix-loop9, LP9-1: this village has sent the TEST cap of wide marches — said above, before the hold's own result)
  if (m) return marchLine(m, at);
  if (say.wait === 'march') return L`軍勢は進軍に出ています。`;
  if (say.wait === 'lag') return L`この村の州の決着が ${fmtNum(Number(say.lag ?? 0))} ターン遅れています。`;
  if (say.wait === 'host') return L`軍勢が整列中か休んでいます。`;
  if (say.wait === 'village') return L`広い土地の村がまだ確定していません。`;
  // (fix-loop16, LP16-2: the chain refused the training for the village's stores — what it costs, why a new village is
  //  short, and when to press again; before, the card went back to 「訓練します」 with nothing said)
  if (say.wait === 'stores') return wideStoresShortText(say);
  return L`いまは送れる一手がありません。`;
}

/**
 * (fix-loop16, LP16-2) A wide village's training refused for its stores (program code 21): the cost of the batch, that a
 * new village starts with empty stores which fill by the hour, and when to press again. `say.cost`: fland trainingCost.
 */
export function wideStoresShortText(say) {
  const cost = (say?.cost ?? []).map((n, i) => (n > 0 ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(n)}` : null)).filter(Boolean).join(' · ');
  return L`広い土地の村の蔵が、槍兵 ${fmtNum(Number(say?.n ?? 100))} の訓練の費用（${cost}）にまだ足りません。出したばかりの村の蔵は空から始まり、時間ごとに少しずつたまります（鉱山のない村の鉱石は1時間に 4）。30 ターンほど待ってから、もう一度「次の一手（広い土地）」を押してください。`;
}
/** Where the last wide march is (its `phase`), in the page's words. */
function marchLine(m, at) {
  {
    if (m.phase === 'out') return L`軍勢は州 ${at(m.to)} の砦へ進軍中です。到着はターン ${fmtNum(m.arrive)} です（いまはターン ${fmtNum(m.nowBell)}）。`;
    if (m.phase === 'stands') {
      const k = m.keep, mine = k && k.contender === m.faction, held = k && k.holder === m.faction;
      const keep = !k ? '' : held ? L`砦はあなたの国のものです。` : mine ? L`あなたの国が砦を占拠中です：${fmtNum(k.progress)} / ${fmtNum(k.required)} ターン。` : L`砦は${factionName(k.holder)}が保持しています（あなたの国は占拠できていません）。`;
      return L`結果：軍勢（兵 ${fmtNum(m.troops)}）は州 ${at(m.to)} に立っています。` + keep;
    }
    if (m.phase === 'settling') return L`到着ターン ${fmtNum(m.arrive)} を過ぎました。到着先での決着を待っています（州の決着が遅れると数ターンかかります）。`;
    if (m.phase === 'gone') return L`結果：軍勢は州 ${at(m.to)} に残れませんでした（戦いに敗れました）。`;
    return L`到着先の州 ${at(m.to)} の記録をまだ読めていません。`;
  }
}

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
  // (TEST-ONLY wide -> wide marches, local wide-land worlds only, Q-W2 owner t385u: the one press that raises this wide
  //  village's host and marches it onto a neighbouring keep — controller `wide-host-step`; the program opens the march
  //  only in the local land lane, devnet unchanged)
  const hostCard = FS.localPlay?.wideLand ? html`<section class="vcard wide-village" id="wide-host" aria-labelledby="wide-host-h">
    ${cardHead({ id: 'wide-host-h', ic: 'flag', title: L`広い土地の軍勢（テスト）`, side: stamp(L`ローカル専用`, 'warn') })}
    <p>${L`押すたびに一手：槍兵を訓練 → 軍勢を編成 → 隣の州の砦へ進軍（広い土地の中どうし）。砦の上に決まった回数とどまると砦を奪います。`}</p>
    ${/* (fix-loop16, LP15-9(e): while the card waits for the province to catch up, the wait line below says the same sentence — 「この村の州の決着が N ターン遅れています。」 was printed twice) */ ''}
    ${FS.ui?.wideHostSay && !(FS.ui.wideHostSay.kind === 'wait' && FS.ui.wideHostSay.wait === 'lag' && FS.ui?.wideHost?.waiting?.reason === 'lag' && !FS.ui.wideHostSay.hold) ? html`<p class="wide-host-why" role="status" title="${FS.ui.wideHostWhy ?? ''}">${wideHostSayText(FS.ui.wideHostSay)}</p>` : FS.ui?.wideHostSay ? '' : FS.ui?.wideHostWhy ? html`<p class="wide-host-why" role="status">${FS.ui.wideHostWhy}</p>` : ''}
    ${FS.ui?.wideHostSay?.kind === 'decision' && FS.ui.wideHostSay.hold?.outcome ? html`<p class="wide-host-held" role="status">${wideHoldOutcomeText(FS.ui.wideHostSay.hold)}</p>` : ''}
    ${FS.ui?.wideHostReady && !FS.ui?.wideHost?.waiting ? html`<p class="wide-host-ready" role="status" data-wide-host-ready="${FS.ui.wideHostReady === 'rebuild' ? 'rebuild' : 'next'}">${FS.ui.wideHostReady === 'rebuild' ? L`次の一手を送れます（新しい軍勢づくり）。自動では送りません。押すと上の一手を送ります。` : L`次の一手を送れます（新しい軍勢の訓練から）。押すと送ります。`}</p>` : ''}
    ${wideHostWaitLine(FS.ui?.wideHost?.waiting)}
    <div class="actions">${FS.ui?.wideHost?.waiting
      ? html`<button type="button" class="btn" data-act="wide-host-step" disabled aria-disabled="true">${L`待っています…（押す必要はありません）`}</button><button type="button" class="btn ghost" data-act="wide-host-stop">${L`待つのをやめる`}</button>`
      : html`<button type="button" class="btn" data-act="wide-host-step">${L`次の一手（広い土地）`}</button>`}</div></section>` : '';
  // (devnet-p17: on a devnet season the page plays itself, the village's own four acts — harvest, build, train, muster)
  const actsCard = hostCard ? '' : wideActsCard(FS, m);
  const head = html`<section class="vcard village-head wide-village" aria-labelledby="wide-v-title">
    ${cardHead({ id: 'wide-v-title', ic: 'home', title: m.title, sub: `${coordText(h.p, h.q)} · ${L`村の場所 ${fmtNum(h.site)} · 世代 ${fmtNum(h.generation)}`}`, side: stamp(L`捕捉・未検証`, 'warn') })}
    <ul class="fact-chips">
      <li>${hostCard || actsCard ? chip(L`記録は読み取り専用`, 'info', 'eye') : chip(L`読み取り専用`, 'info', 'eye')}</li>
      <li>${chip(L`現在性：未確認`, 'warn', 'hourglass')}</li>
      <li>${chip(L`経過時間：不明`, '', 'moon')}</li>
    </ul>
    ${hostCard ? localWideNote() : actsCard ? devnetWideNote() : noExecutionNote()}${fogNow().on ? '' : html`<div class="actions"><button type="button" class="btn" data-act="wide-map">${L`記録の地図で場所を見る（未検証・読み取り専用）`}</button></div>`}${back}</section>`;

  const provenance = html`<section class="vcard wide-village" aria-labelledby="wide-v-prov">
    ${cardHead({ id: 'wide-v-prov', ic: 'scroll', title: L`出どころ` })}
    <dl class="facts">
      ${fact(L`場所（正確な座標）`, coordText(h.p, h.q))}
      ${fact(L`世界`, html`<code title="${h.world}">${h.world.slice(0, 16)}…</code>`)}
      ${fact(L`世界の番号`, h.season)}
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
    <p class="muted">${actsCard ? L`訓練と編成は「この遠方の村への命令」から送ります。` : L`訓練も編成もここからはできません。`}</p></section>`;

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
  return [head, ...(hostCard ? [hostCard] : []), ...(actsCard ? [actsCard] : []), provenance, stores, build, troops, more];
}

/** Failed or unavailable wide reads are visible beside both layouts, never silently an empty inventory. */
export function renderWideInventoryStatus(FS) {
  if (FS?.mode !== 'play' || !FS.citizen || !['error', 'unavailable'].includes(FS.wideStatus)) return '';
  const failed = FS.wideStatus === 'error';
  // (PR #46 verification, 2026-11-18: a local-play world confirmed ended — flocalplay-ended.mjs — is not read any more:
  //  its network failure is not said as a second error with a Retry beside the banner that says the world ended)
  if (failed && FS.worldEnded && FS.wideError?.code === 'network') return '';
  // (walletless demo: a sample world has no wide land at all — not "unknown": nothing to say)
  if (!failed && FS.sample) return '';
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
