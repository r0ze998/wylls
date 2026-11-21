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
import { BUILD_ITEMS, buildItemOf, UNIT_ORDER } from '../fland.mjs';
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
    case 'build': return L`${BUILDINGS[buildItemOf(o.item)?.resource] ?? ''}の建設`;
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

/**
 * (2026-11-17, corrected) Whether an order record was made under the context the page is in NOW — the same viewer,
 * herald and pinned world: its number (`o<n>`, the controller's own count of orders made on this page) is higher than
 * the number that stood when the context last moved (`FS.orderFloor`, controller nextContext). A record made before a
 * change of viewer, herald or world is another context's, whatever its turn and tile. A store without the floor (an
 * older fixture) holds nothing against a record.
 */
export const ofContext = (FS, o) => { const n = Number(String(o?.id ?? '').slice(1)); return !Number.isInteger(FS.orderFloor) || (Number.isInteger(n) && n > FS.orderFloor); };

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
    if (!kinds.includes(o.kind) || o.turn !== turn || !ofVillage(o, h) || !ofContext(FS, o)) continue;
    // (what the record says became of the order — orderOutcome, the one place it is read; an accepted order is listed
    //  only while the village's record is still behind it)
    const outcome = orderOutcome(o), cls = outcome === 'accepted' ? (recordBehind(o, recordFactOf(o, h, now)) ? 'waiting' : null) : outcome;
    if (!cls) continue;
    // (`place`: whose village the record says it was — orderPlace. A muster's or a fort order's record names its own tile:
    //  it is listed as an order of this province, and the line says its village is not in the record)
    out.push({ id: o.id, kind: o.kind, name: villageOrderName(o), cls, code: o.code ?? null, why: o.why ?? (o.code ? clientText(o.code) : ''), fact: cls === 'unknown' ? recordFactOf(o, h, now) : null, place: orderPlace(o, h) });
  }
  return out;
}

/** The kinds of order whose record names a tile of its OWN — where a host forms up, a fort — and not the village it was given from. */
export const OWN_TILE_KINDS = Object.freeze(['muster', 's1-fort']);
/**
 * (2026-11-17, corrected three times) What an order record says of WHERE it was given from, against a village — only
 * what the record itself holds, and nothing reasoned on top of it:
 *   'tile'     the record's tile is the village's own tile, and the record's kind is one whose tile `orderOf` fills
 *              with the tile of the village in hand at the order (train, harvest, build …): it was given while the
 *              village standing on this tile was in hand. The record holds NO site and NO generation — whether that
 *              village is the one standing there now is not proved by it, and is not claimed.
 *   'unknown'  the same province, and either another tile, or a kind whose tile is the order's own (a muster's tile is
 *              where the host forms up — ALSO when that happens to be the village's tile; a fort's order names the
 *              fort): which village gave it is NOT in the record. It is never "this village's".
 *   null       another province, or no tile.
 * (Earlier versions: a muster was this village's whenever the province matched; then whenever its formation tile was
 * the village's tile, with the village's ticket turn read as a founding time. A formation tile is not the source
 * village, and no record field proves a village's generation: neither is used.)
 */
export function orderPlace(o, h) {
  if (!o?.tile || !h || o.tile.p !== h.p || o.tile.q !== h.q) return null;
  return !OWN_TILE_KINDS.includes(o.kind) && o.tile.tile === h.tile ? 'tile' : 'unknown';
}
/**
 * The order record that `match` takes and that still speaks for what the page should say beside THIS village, with
 * what became of it: `{order, outcome, why, turn, carried, place}`, or null. `FS.orders` is newest first. Only records
 * made under the context NOW (ofContext) are read. The outcome is the RECORD's; whose village it was is `place`.
 *   `place: 'tile'` (orderPlace):
 *     - a record whose outcome is NOT CONFIRMED — 'unknown' (sent, not read) or 'held' (local play's hold) — whatever
 *       its turn, the newest such first: a turn going by confirms nothing. `carried`: it is of an earlier turn.
 *     - otherwise the newest record of THIS turn (accepted, sent and failed, not sent).
 *   `place: 'unknown'` — only when no 'tile' record speaks: a not-confirmed record of any turn, or one ACCEPTED this
 *     turn. It is returned as a record of this province whose village is not known, for the caller to say exactly
 *     that; a failed or unsent one says nothing worth a line and is not returned.
 * A fact of the RECORD, read by what the record itself names; not tied to a button press; no state of the village is
 * inferred from it. Limits: the page keeps the last ORDERS_MAX records in memory only; a record names no site and no
 * generation.
 */
export function latestVillageOrder(FS, h, match) {
  if (!h) return null;
  const turn = FS.nowBell ?? null, open = x => { const c = orderOutcome(x); return c === 'unknown' || c === 'held'; };
  const all = (FS.orders ?? []).filter(x => ofContext(FS, x) && match(x)), here = all.filter(x => orderPlace(x, h) === 'tile');
  const o = here.find(open) ?? here.find(x => x.turn === turn) ?? null;
  const loose = o ? [] : all.filter(x => orderPlace(x, h) === 'unknown');
  const far = loose.find(open) ?? loose.find(x => x.turn === turn && orderOutcome(x) === 'accepted') ?? null;
  const pick = o ?? far, outcome = pick ? orderOutcome(pick) : null;
  return outcome ? { order: pick, outcome, why: pick.why ?? (pick.code ? clientText(pick.code) : ''), turn: pick.turn ?? null, carried: pick.turn !== turn, place: o ? 'tile' : 'unknown' } : null;
}

/** Whether the pure re-read of the village may be offered from here (the controller's own conditions for starting one). */
export const villageRereadOffered = FS => !!FS.wallet && !FS.proto && FS.mode === 'play' && FS.villageReread?.state !== 'loading';

/** The record's own fact beside an unknown order: what it holds now, and that it does not say whose order made it. */
function factWords(f) {
  if (!f) return '';
  if (f.kind === 'build') return L`いま読めている村の記録では、${BUILDINGS[buildItemOf(f.item)?.resource] ?? ''}は ${fmtNum(f.count)} つです（建設中を含みます）。この命令で増えたものかどうかは、記録からは分かりません。`;
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
  // (corrected: an order whose record does not name its village — a muster, a fort order — is not said to be this
  //  village's: its line carries that)
  const whose = x => (x.place === 'unknown' ? html`<span class="vo-whose"> ${L`（この州で出した命令です。この村の命令かどうかは、記録からは分かりません。）`}</span>` : '');
  const line = x => {
    if (x.cls === 'notSent') return html`<p class="notice error vo vo-notsent" data-order="${x.cls}">${icon('flag')}<span>${L`${x.name}：送られていません。`}${x.why ? html`<span class="vo-why"> ${x.why}</span>` : ''}${whose(x)}</span></p>`;
    if (x.cls === 'sentFailed') return html`<p class="notice error vo vo-failed" data-order="${x.cls}">${icon('flag')}<span>${L`${x.name}：送信しましたが、成立しませんでした。`}${x.why ? html`<span class="vo-why"> ${x.why}</span>` : ''}${whose(x)}</span></p>`;
    if (x.cls === 'held') return html`<p class="notice vo vo-held" data-order="${x.cls}">${icon('hourglass')}<span>${L`${x.name}：送信済みです。結果はまだ確認できていません。同じ命令は送り直しません。同じ命令をもう一度押すと、結果を確認します。`}${whose(x)}</span></p>`;
    if (x.cls === 'waiting') return html`<p class="notice vo vo-waiting" data-order="${x.cls}">${icon('hourglass')}<span>${L`${x.name}：受け付けられました。いま読めている村の記録には、まだ出ていません。`}${whose(x)}</span></p>`;
    // unknown: the order's result stays unconfirmed whatever the record holds; the record is said as its own fact
    const fact = factWords(x.fact);
    return html`<p class="notice vo vo-unknown" data-order="${x.cls}">${icon('hourglass')}<span>${L`${x.name}：送信済みです。この命令の結果は、まだ確認できていません（送られていない、という意味ではありません）。もう一度命じると、二重になることがあります。`}${fact ? html`<span class="vo-fact"> ${fact}</span>` : ''}${whose(x)}</span></p>`;
  };
  const again = reread ?? { act: 'village-reread', label: L`村の記録を読み直す`, offered: villageRereadOffered(FS) };
  const ask = list.some(x => x.cls === 'unknown' || x.cls === 'waiting') && !rereadShown && again.offered === true;
  return html`<div class="village-orders" role="status" aria-label="${L`この村から出した命令`}">${list.map(line)}${ask
    ? html`<div class="actions"><button type="button" class="btn small" data-act="${again.act}">${icon('return')}${again.label}</button></div>` : ''}</div>`;
}
