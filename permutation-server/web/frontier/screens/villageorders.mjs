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
//                'unconfirmed' with any code but the local hold's): NOT "not sent" and NOT failed, and NOT resolved by
//                anything this page can read; the pure re-read of the village (controller rereadVillage) is offered
//   held         local play: sent and held by its signature (`state: 'unconfirmed'`, code LocalActUnconfirmed): the
//                same press asks its outcome and sends nothing again (the controller's own rule; not decided here)
//   waiting      accepted (the chain confirmed it), and the village's record read so far is still behind it
// An accepted order the record is not behind is not listed: the queue, the tier and the stores say it.
//
// WHAT THE RECORD CAN AND CANNOT SAY (corrected 2026-11-17 — the first version called an unknown order "in the record"
// when the count of a building had reached its number, and matched orders to copies by number and order):
//   - the record holds counts and a queue, never which order made them. A count that reached an order's number is NOT
//     proof that THAT order took effect (another order, another tab, an agent may have built it). So for an `unknown`
//     order the record is said as a FACT OF ITS OWN — "the record now has N of this building, the queue included" /
//     "a promotion is in the queue" — beside, never instead of, "the result of this order is not confirmed".
//   - `waiting` is the one inference made, and it is about the READ, not about any order's success: an order the
//     chain CONFIRMED raised the count to at least its own number, so a record still below that number has not caught
//     up. Only the order's own number is used; no other order — failed, unknown or accepted — is counted with it, and
//     a record at or above the number is not claimed to show this order.
// Walls, training, harvest, muster and garrison carry no number of their own: nothing of the record is said for them.
// Pure: nothing is sent, saved or asked for here, and no button is enabled or disabled by it.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { icon } from '../hud/icons.mjs';
import { BUILDINGS, TIERS, unitCount, clientText } from '../fi18n.mjs';
import { BUILD_ITEMS, UNIT_ORDER } from '../fland.mjs';
import { copyNumber, queueNow, ITEM_TIER_UP } from '../hud/rulebook.mjs';

/** The kinds of order the village screen gives. */
export const VILLAGE_ORDER_KINDS = Object.freeze(['harvest', 'build', 'walls', 'promote', 'train', 'muster', 'garrison']);
/** The kinds of order the trade card gives (screens/s1.mjs): a caravan, spearmen into a fort. Neither names a mark of its own in a record. */
export const S1_ORDER_KINDS = Object.freeze(['s1-caravan', 's1-fort']);
/** The codes of a transaction that was sent and whose outcome could not be read (fplay.mjs track). */
export const UNKNOWN_OUTCOME_CODES = Object.freeze(['Unconfirmed', 'TxUnqueryable']);
/** The code of local play's hold: sent, held by its signature, and asked — not sent — by the same press (controller.mjs orderUnconfirmed). */
export const LOCAL_HOLD_CODE = 'LocalActUnconfirmed';

/**
 * What an order record says became of the order — the ONE place the lifecycle's records are classed (the village's
 * note, the trade card's, the first village's guide):
 *   'notSent'     refused before anything left this browser (`sent` not true)
 *   'sentFailed'  sent, and the chain answered that it failed or expired
 *   'unknown'     sent, outcome not read: refused with `sent` and a tracker's code, or 'unconfirmed' with any code but
 *                 the local hold's (the shape of main's order chain for the ordinary path) — never "not sent"
 *   'held'        local play: sent and held by its signature ('unconfirmed' with the hold's own code); the same press
 *                 asks its outcome and sends nothing again
 *   'accepted'    the chain confirmed it
 * null for a record in no such state.
 */
export function orderOutcome(o) {
  if (o?.state === 'unconfirmed') return o.code === LOCAL_HOLD_CODE ? 'held' : 'unknown';
  if (o?.state === 'refused') return o.sent !== true ? 'notSent' : UNKNOWN_OUTCOME_CODES.includes(o.code) ? 'unknown' : 'sentFailed';
  return o?.state === 'accepted' ? 'accepted' : null;
}

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
    case 's1-caravan': return L`隊商の出発`;
    case 's1-fort': return L`要塞への槍兵`;
    default: return '';
  }
}

/** Whether the order was given from this village: its province, and — but for a muster, whose tile is where the host forms up, and a fort's, whose tile is the fort — its own tile. */
const ofVillage = (o, h) => !!o?.tile && o.tile.p === h.p && o.tile.q === h.q && (o.kind === 'muster' || o.kind === 's1-fort' || o.tile.tile === h.tile);

/**
 * What the village's record, as read now, holds of the thing an order names — a fact of the record, never of the order:
 * a building → `{kind: 'build', item, count}` (built and queued, counted together); a promotion → `{kind: 'promote', tier, queued}`;
 * any other order → null.
 */
export function recordFactOf(o, h, now) {
  if (o.kind === 'build' && Number.isInteger(o.item) && BUILD_ITEMS[o.item]) return { kind: 'build', item: o.item, count: copyNumber(h, o.item) - 1 };
  if (o.kind === 'promote') return { kind: 'promote', tier: Number(h.tier ?? 0), queued: queueNow(h, now).some(q => q.item === ITEM_TIER_UP) };
  return null;
}
/** Whether the record read so far is still behind an order the chain CONFIRMED: below the order's own number / tier. Its own number only. */
export function recordBehind(o, fact) {
  if (!fact) return false;
  if (fact.kind === 'build') return Number.isInteger(o.n) && fact.count < o.n;
  return Number.isInteger(o.to) && fact.tier < o.to && !fact.queued;
}

/**
 * The orders of this village and this turn that still need a word: `[{id, kind, name, cls, code, why, fact}]`, in the
 * order of `FS.orders` (newest answer first). `h` = the village as settled now (holdingModel().settled), `now` = the
 * chain's second. `fact`: recordFactOf, kept only for the classes that say it (`unknown`).
 */
export function villageOrdersModel(FS, h, now, kinds = VILLAGE_ORDER_KINDS) {
  if (!h) return [];
  const turn = FS.nowBell ?? null;
  const out = [];
  for (const o of FS.orders ?? []) {
    if (!kinds.includes(o.kind) || o.turn !== turn || !ofVillage(o, h)) continue;
    // (what the record says became of the order — orderOutcome, the one place it is read; an accepted order is listed
    //  only while the village's record is still behind it)
    const outcome = orderOutcome(o), cls = outcome === 'accepted' ? (recordBehind(o, recordFactOf(o, h, now)) ? 'waiting' : null) : outcome;
    if (!cls) continue;
    out.push({ id: o.id, kind: o.kind, name: villageOrderName(o), cls, code: o.code ?? null, why: o.why ?? (o.code ? clientText(o.code) : ''), fact: cls === 'unknown' ? recordFactOf(o, h, now) : null });
  }
  return out;
}

/**
 * The newest order record of this village and this turn that `match` takes, with what became of it: `{order, outcome,
 * why}`, or null. `FS.orders` is newest first. It is a fact of the RECORD — "the last such order given from this village
 * this turn was …" —, read by what the record itself names (its kind, its unit, its village's tile, its turn); it is
 * not tied to any button press or plan, and no later state of the village is inferred from it.
 */
export function latestVillageOrder(FS, h, match) {
  if (!h) return null;
  const turn = FS.nowBell ?? null;
  const o = (FS.orders ?? []).find(x => x.turn === turn && ofVillage(x, h) && match(x)) ?? null;
  const outcome = o ? orderOutcome(o) : null;
  return outcome ? { order: o, outcome, why: o.why ?? (o.code ? clientText(o.code) : '') } : null;
}

/** Whether the pure re-read of the village may be offered from here (the controller's own conditions for starting one). */
export const villageRereadOffered = FS => !!FS.wallet && !FS.proto && FS.mode === 'play' && FS.villageReread?.state !== 'loading';

/** The record's own fact beside an unknown order: what it holds now, and that it does not say whose order made it. */
function factWords(f) {
  if (!f) return '';
  if (f.kind === 'build') return L`いま読めている村の記録では、${BUILDINGS[BUILD_ITEMS[f.item]?.resource] ?? ''}は ${fmtNum(f.count)} つです（建設中を含みます）。この命令で増えたものかどうかは、記録からは分かりません。`;
  return f.queued ? L`いま読めている村の記録では、昇格の工事が列にあります。この命令によるものかどうかは、記録からは分かりません。`
    : L`いま読めている村の記録では、段階は${TIERS[f.tier] ?? ''}です。昇格の工事は列にありません。`;
}

/**
 * The note under the village's head: one line per order of `villageOrdersModel`; '' when there is none. `rereadShown`:
 * the read note beside it already carries the re-read button (screens/holding.mjs renderHoldingRead) — it is not doubled.
 * `kinds` and `reread` (`{act, label, offered}`): the trade card's own orders and its own re-read (screens/s1.mjs);
 * by default the village's orders and the village's re-read.
 */
export function renderVillageOrders(FS, h, now, { rereadShown = false, kinds = VILLAGE_ORDER_KINDS, reread = null } = {}) {
  const list = villageOrdersModel(FS, h, now, kinds);
  if (!list.length) return '';
  const line = x => {
    if (x.cls === 'notSent') return html`<p class="notice error vo vo-notsent" data-order="${x.cls}">${icon('flag')}<span>${L`${x.name}：送られていません。`}${x.why ? html`<span class="vo-why"> ${x.why}</span>` : ''}</span></p>`;
    if (x.cls === 'sentFailed') return html`<p class="notice error vo vo-failed" data-order="${x.cls}">${icon('flag')}<span>${L`${x.name}：送信しましたが、成立しませんでした。`}${x.why ? html`<span class="vo-why"> ${x.why}</span>` : ''}</span></p>`;
    if (x.cls === 'held') return html`<p class="notice vo vo-held" data-order="${x.cls}">${icon('hourglass')}<span>${L`${x.name}：送信済みです。結果はまだ確認できていません。同じ命令は送り直しません。同じ命令をもう一度押すと、結果を確認します。`}</span></p>`;
    if (x.cls === 'waiting') return html`<p class="notice vo vo-waiting" data-order="${x.cls}">${icon('hourglass')}<span>${L`${x.name}：受け付けられました。いま読めている村の記録には、まだ出ていません。`}</span></p>`;
    // unknown: the order's result stays unconfirmed whatever the record holds; the record is said as its own fact
    const fact = factWords(x.fact);
    return html`<p class="notice vo vo-unknown" data-order="${x.cls}">${icon('hourglass')}<span>${L`${x.name}：送信済みです。この命令の結果は、まだ確認できていません（送られていない、という意味ではありません）。もう一度命じると、二重になることがあります。`}${fact ? html`<span class="vo-fact"> ${fact}</span>` : ''}</span></p>`;
  };
  const again = reread ?? { act: 'village-reread', label: L`村の記録を読み直す`, offered: villageRereadOffered(FS) };
  const ask = list.some(x => x.cls === 'unknown' || x.cls === 'waiting') && !rereadShown && again.offered === true;
  return html`<div class="village-orders" role="status" aria-label="${L`この村から出した命令`}">${list.map(line)}${ask
    ? html`<div class="actions"><button type="button" class="btn small" data-act="${again.act}">${icon('return')}${again.label}</button></div>` : ''}</div>`;
}
