// The village screen's own account of the orders given from this village this turn (Lane C, 2026-11-17, ⑦).
//
// The orders a person gives on the village screen — harvest, build, walls, promotion, train, muster, garrison — are
// answered by the controller's order lifecycle (`FS.orders`: controller.mjs orderAnswered / orderUnconfirmed). Until now
// only the turn list read them; the village screen, where they were given and where their results show (the build
// queue, the tier, the stores, the reserve), said nothing once the notice was gone. This module READS `FS.orders` and
// the village's record and says, per order that still needs a word:
//   notSent      refused before anything left this browser (`sent` not true): not sent, with the reason
//   sentFailed   sent, and the chain answered that it failed or expired: sent, did not take effect, with the reason
//   unknown      sent, and the outcome could not be read (refused+sent with `Unconfirmed` / `TxUnqueryable`, or
//                'unconfirmed' with any code but the local hold's): NOT "not sent" and NOT
//                failed — the record decides; the pure re-read of the village (controller rereadVillage) is offered
//   held         local play: sent and held by its signature (`state: 'unconfirmed'`, code LocalActUnconfirmed): the same press asks its outcome
//                and sends nothing again (the controller's own rule; nothing of it is decided here)
//   waiting      accepted, and the village's record read so far does not show it yet
// An accepted order the record already shows is not listed: the queue, the tier and the stores say it.
// Evidence from the record, only where the order itself names it: a building's copy number (`n`, the program's
// copy_number: built + queued + 1) and a promotion's tier. Walls, training, harvest, muster and garrison carry no such
// mark: for them nothing is claimed either way.
// Pure: nothing is sent, saved or asked for here, and no button is enabled or disabled by it.
import { html } from '../../util.mjs';
import { L } from '../../lang.mjs';
import { icon } from '../hud/icons.mjs';
import { BUILDINGS, TIERS, unitCount, clientText } from '../fi18n.mjs';
import { BUILD_ITEMS, UNIT_ORDER } from '../fland.mjs';
import { copyNumber, queueNow, ITEM_TIER_UP } from '../hud/rulebook.mjs';

/** The kinds of order the village screen gives. */
export const VILLAGE_ORDER_KINDS = Object.freeze(['harvest', 'build', 'walls', 'promote', 'train', 'muster', 'garrison']);
/** The codes of a transaction that was sent and whose outcome could not be read (fplay.mjs track). */
export const UNKNOWN_OUTCOME_CODES = Object.freeze(['Unconfirmed', 'TxUnqueryable']);

/** The code of local play's hold: sent, held by its signature, and asked — not sent — by the same press (controller.mjs orderUnconfirmed). */
export const LOCAL_HOLD_CODE = 'LocalActUnconfirmed';

/** What the order was, in a few words. */
export function villageOrderName(o) {
  switch (o.kind) {
    case 'harvest': return L`収穫`;
    case 'build': return L`${BUILDINGS[BUILD_ITEMS[o.item]?.resource] ?? ''}の建設`;
    case 'walls': return L`城壁の工事`;
    case 'promote': return L`${TIERS[o.to] ?? ''}への昇格`;
    case 'train': return Number.isInteger(o.unit) && Number.isFinite(o.n) ? L`${unitCount(UNIT_ORDER[o.unit], o.n)}の訓練` : L`訓練`;
    case 'muster': return Number.isInteger(o.unit) && Number.isFinite(o.troops) ? L`${unitCount(UNIT_ORDER[o.unit], o.troops)}の編成` : L`編成`;
    case 'garrison': return L`守備隊の増員`;
    default: return '';
  }
}

/** Whether the order was given from this village: its province, and — but for a muster, whose tile is where the host forms up — its own tile. */
const ofVillage = (o, h) => !!o?.tile && o.tile.p === h.p && o.tile.q === h.q && (o.kind === 'muster' || o.tile.tile === h.tile);

/**
 * The orders of this village and this turn that still need a word: `[{id, kind, name, cls, code, why, inRecord}]`,
 * newest first. `h` = the village as settled now (holdingModel().settled), `now` = the chain's second.
 * `inRecord`: true / false where the order names its own mark in the record, null where it names none.
 */
export function villageOrdersModel(FS, h, now) {
  if (!h) return [];
  const turn = FS.nowBell ?? null;
  const mine = (FS.orders ?? []).filter(o => VILLAGE_ORDER_KINDS.includes(o.kind) && o.turn === turn && ofVillage(o, h));
  // (two orders for the same building pressed before the record moved carry the same copy number: the record showing
  //  that copy is evidence for the earlier one only — the later one needs one copy more)
  const copies = new Map();
  const need = new Map();
  for (const o of [...mine].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    if (o.kind !== 'build' || !Number.isInteger(o.item) || !Number.isInteger(o.n) || o.state === 'refused' && o.sent !== true) continue;
    const key = `${o.item}|${o.n}`, extra = copies.get(key) ?? 0;
    copies.set(key, extra + 1);
    need.set(o.id, o.n + extra);
  }
  const queued = queueNow(h, now);
  const inRecord = o => {
    if (o.kind === 'build' && need.has(o.id)) return copyNumber(h, o.item) - 1 >= need.get(o.id);
    if (o.kind === 'promote' && Number.isInteger(o.to)) return Number(h.tier ?? 0) >= o.to || queued.some(q => q.item === ITEM_TIER_UP);
    return null;
  };
  const out = [];
  for (const o of mine) {
    const seen = inRecord(o), why = o.why ?? (o.code ? clientText(o.code) : '');
    let cls = null;
    // (corrected 2026-11-17: 'unconfirmed' is the local-play hold ONLY with the hold's own code. Main's order chain —
    //  not adopted at this base — records an ordinary-path unknown outcome as 'unconfirmed' too, with the tracker's
    //  code: there a second press is a NEW order, so it is said as `unknown`, never with the hold's words)
    if (o.state === 'unconfirmed') cls = o.code === LOCAL_HOLD_CODE ? 'held' : 'unknown';
    else if (o.state === 'refused') cls = o.sent !== true ? 'notSent' : UNKNOWN_OUTCOME_CODES.includes(o.code) ? 'unknown' : 'sentFailed';
    else if (o.state === 'accepted') cls = seen === false ? 'waiting' : null;
    if (cls) out.push({ id: o.id, kind: o.kind, name: villageOrderName(o), cls, code: o.code ?? null, why, inRecord: seen });
  }
  return out;
}

/** Whether the pure re-read of the village may be offered from here (the controller's own conditions for starting one). */
export const villageRereadOffered = FS => !!FS.wallet && !FS.proto && FS.mode === 'play' && FS.villageReread?.state !== 'loading';

/**
 * The note under the village's head: one line per order of `villageOrdersModel`; '' when there is none. `rereadShown`:
 * the read note beside it already carries the re-read button (screens/holding.mjs renderHoldingRead) — it is not doubled.
 */
export function renderVillageOrders(FS, h, now, { rereadShown = false } = {}) {
  const list = villageOrdersModel(FS, h, now);
  if (!list.length) return '';
  const line = x => {
    if (x.cls === 'notSent') return html`<p class="notice error vo vo-notsent" data-order="${x.cls}">${icon('flag')}<span>${L`${x.name}：送られていません。`}${x.why ? html`<span class="vo-why"> ${x.why}</span>` : ''}</span></p>`;
    if (x.cls === 'sentFailed') return html`<p class="notice error vo vo-failed" data-order="${x.cls}">${icon('flag')}<span>${L`${x.name}：送信しましたが、成立しませんでした。`}${x.why ? html`<span class="vo-why"> ${x.why}</span>` : ''}</span></p>`;
    if (x.cls === 'held') return html`<p class="notice vo vo-held" data-order="${x.cls}">${icon('hourglass')}<span>${L`${x.name}：送信済みです。結果はまだ確認できていません。同じ命令は送り直しません。同じ命令をもう一度押すと、結果を確認します。`}</span></p>`;
    if (x.cls === 'waiting') return html`<p class="notice vo vo-waiting" data-order="${x.cls}">${icon('hourglass')}<span>${L`${x.name}：受け付けられました。村の記録には、まだ出ていません。次の読み込みで出ます。`}</span></p>`;
    // unknown: said by what the record shows, where the order names its own mark there
    if (x.inRecord === true) return html`<p class="notice vo vo-unknown" data-order="${x.cls}" data-record="yes">${icon('hourglass')}<span>${L`${x.name}：送信の結果は確認できませんでしたが、村の記録には出ています。`}</span></p>`;
    return html`<p class="notice vo vo-unknown" data-order="${x.cls}" data-record="${x.inRecord === false ? 'no' : ''}">${icon('hourglass')}<span>${x.inRecord === false
      ? L`${x.name}：送信済みです。結果はまだ確認できていません（送られていない、という意味ではありません）。村の記録には、まだ出ていません。もう一度命じると、二重になることがあります。`
      : L`${x.name}：送信済みです。結果はまだ確認できていません（送られていない、という意味ではありません）。もう一度命じると、二重になることがあります。村の記録を読み直し、下の数で確かめてください。`}</span></p>`;
  };
  const ask = list.some(x => x.cls === 'unknown' && x.inRecord !== true) && !rereadShown && villageRereadOffered(FS);
  return html`<div class="village-orders" role="status" aria-label="${L`この村から出した命令`}">${list.map(line)}${ask
    ? html`<div class="actions"><button type="button" class="btn small" data-act="village-reread">${icon('return')}${L`村の記録を読み直す`}</button></div>` : ''}</div>`;
}
