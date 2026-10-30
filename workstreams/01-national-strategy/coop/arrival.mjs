// 到着の確認（④との契約の形）：依頼に結び付けた隊商が、いま何の状態で、どれだけ確かめて届いたか。
//
// 入力はヘラルドの `h/caravans.json`。
//   - `moving`・`vaults` は今のヘラルドにある（frontier-node/crates/herald/src/caravan.rs）。
//   - `ended`（隊商の確定 CARAVAN_SETTLED と襲撃 CARAVAN_RAIDED の記録）は、今のヘラルドにはない。
//     ①の提案パッチ（proposals/0002-herald-caravan-ended.patch、④へ渡す）で足す。
//     `ended` がないヘラルドでは、一覧から消えた隊商は「不明（未検証）」になり、量は数えない。
//
// 到着量は④の契約（wylls-ws04-handoff-20261030、HEAD 2e536b6b の CONTRACTS §1・§9、STATE-MACHINE「到着量の判定」、HANDOFF §2）の
// 言葉と意味に合わせる（2026-10-30 の照合）。①は独自の「検証済み」を作らない。
//   delivered     ：検証できた量（依頼の資源ごと、整数単位）。null は「分からない」。0 は「0 と分かっている」（別の意味）
//   verification  ：'Recorded'（settle の記録に credited がある：④の提案 P1。今のプログラムには無いので①は作らない）
//                   'RuleDerived'（村あて DELIVERED：Holding::credit は上限なしで全量を加える）
//                   'Unverifiable'（倉あて DELIVERED で credited が無い：CAP で切り捨てた量が記録にない）
//                   'KnownZero'（LOST・襲撃の奪取と焼却・依頼の届け先とは別の場所への確定）
//                   null（まだ終わっていない、またはチェーンの記録を読めていない）
//   cargoLogged   ：CARAVAN_SETTLED の cargo。上限であり入荷量ではない。進捗に足さない
// 村あての RuleDerived の根拠（実際の加算処理との対応）：
//   caravan.rs settle_caravan：DELIVERED で宛先が holding のとき、cargo の各資源について h.credit(now, r, c)（c はミリ単位、c > 0 だけ）
//   holding.rs:774-783 Holding::credit：settle(now) の後に stores[r].add(now, amount)
//   holding.rs:296-300 Accrual::add：value = value.saturating_add(amount.max(0))（上限で切らない。「may exceed the cap」）
//   caravan.rs:402-409 cargo_log：記録はミリ単位の cargo を 1000 で割った切り捨て
//   → 加えられたミリ単位の量は記録の値 ×1000 以上、(値＋1)×1000 未満。整数単位では記録の値が入荷量（切り捨て）。
//   倉あて（caravan.rs settle_caravan の vault 分岐）：to = min(have + c, max(cap, have)) で切り捨て、記録は元の cargo → Unverifiable。
// 届け先の村の「到着時の持ち主」は goal.mjs で別に扱う（今の口座の持ち主と分ける）。

import { RESOURCES } from './record.mjs';

export const STATE_JA = Object.freeze({
  moving: '輸送中（まだ送り主の物）', delivered: '到着（確定）', misdelivered: '別の場所に到着', lost: '失われた（行き先がない・世代が違う）',
  'raided-taken': '奪われた（奪った人の物）', 'raided-burned': '焼かれた', unknown: '不明（未検証）',
});

const keyOf = c => `${String(c.ownerTag)}:${Number(c.seq)}`;
const cargoOf = a => (Array.isArray(a) ? a.map(x => Number(x) || 0) : [0, 0, 0, 0, 0, 0, 0, 0]);

/** `ended` の1件を読む（形が違えば null）。提案パッチの形：{ownerTag, seq, end: 'settled'|'raided', outcome?, dst?, cargo?, choice?, raiderTag?, taken?} */
function endedOf(e) {
  if (!e || typeof e !== 'object' || !/^\d+$/.test(String(e.ownerTag)) || !Number.isInteger(e.seq)) return null;
  if (e.end === 'settled' && [0, 1].includes(e.outcome) && e.dst && Array.isArray(e.cargo)) return e;
  if (e.end === 'raided' && [0, 1].includes(e.choice)) return e;
  return null;
}

/** ヘラルドのファイルから、隊商の ID ごとの手がかりを引く。 */
export function indexFeed(file) {
  const moving = new Map(), settled = new Map(), raided = new Map();
  for (const m of file?.moving ?? []) moving.set(keyOf(m), m);
  const hasEnded = Array.isArray(file?.ended);
  for (const raw of file?.ended ?? []) {
    const e = endedOf(raw);
    if (!e) continue;
    if (e.end === 'settled') settled.set(keyOf(e), e);
    else raided.set(keyOf(e), e);
  }
  return { moving, settled, raided, hasEnded, vaults: file?.vaults ?? [] };
}

/** 確定の記録と規則から、宛先に加算された量（④の delivered・verification）。 */
export function creditedOf(settled) {
  const kind = Number(settled.dst?.kind);
  if (kind === 1) return { qty: cargoOf(settled.cargo), verification: 'RuleDerived', basis: 'CARAVAN_SETTLED の cargo（整数単位・切り捨て）。Holding::credit → Accrual::add は上限なしで全量を加える（holding.rs:296-300, 774-783、caravan.rs settle_caravan の holding 分岐、cargo_log:402-409）' };
  if (kind === 2) return { qty: null, verification: 'Unverifiable', why: '倉あては CAP で切り捨てられ、加算した量（credited）が記録にない（④の提案 P1 は未適用）。到着量は分からない（最大は cargo）' };
  return { qty: null, verification: 'Unverifiable', why: '宛先の種類が分からない' };
}

const zeros = need => Object.fromEntries(Object.keys(need).map(r => [r, 0]));

const samePlace = (dst, to) => dst && Number(dst.kind) === 1 && Number(dst.p) === to.p && Number(dst.q) === to.q && Number(dst.at) === to.site && Number(dst.gen) === to.gen;

/**
 * 結び付けた1本の隊商の到着の記録（契約の形）。
 * 量を数えるのは、チェーンの取引の記録（CARAVAN_SETTLED、chain.mjs caravanEndFromChain）を読めたときだけ（source 'chain-log'）。
 * ヘラルドの一覧（moving・ended）は、輸送中・終わったことの表示と、チェーンの記録との突き合わせにだけ使い、量は数えない。
 * `chainEnd`：caravanEndFromChain の結果。undefined はチェーンを読まない板（量はすべて未検証）。
 */
export function arrivalOf(request, link, feed, chainEnd) {
  const h = heraldArrival(request, link, feed);
  if (chainEnd?.status === 'settled' || chainEnd?.status === 'raided') {
    const c = chainArrival(request, link, chainEnd);
    const agree = !['delivered', 'lost', 'misdelivered', 'raided-taken', 'raided-burned'].includes(h.state) || h.state === c.state;
    return agree ? c : { ...c, note: `${c.note}（ヘラルドの写しは「${STATE_JA[h.state] ?? h.state}」で、チェーンの記録と食い違う）`, heraldDisagrees: h.state };
  }
  const why = chainEnd === undefined ? 'チェーンの取引の記録と照合していない（板に --rpc がない）'
    : chainEnd.status === 'none' ? 'チェーンの取引の記録に、この隊商の確定・襲撃はまだない' : chainEnd.why;
  if (['moving', 'raided-taken', 'raided-burned'].includes(h.state) && h.source === 'herald-moving') return { ...h, delivered: null, verification: null };
  return { ...h, delivered: null, verification: null, note: `${h.note}。${why}。量は分からない（数えない）` };
}

/** チェーンの取引の記録から作る到着の記録（④の分類）。 */
function chainArrival(request, link, end) {
  const base = { requestId: request.id, caravanId: { ...link.caravan }, owner: { ownerTag: String(link.caravan.ownerTag) }, responder: link.responder, source: 'chain-log' };
  const pick = cargo => Object.fromEntries(Object.keys(request.need).map(r => [r, cargoOf(cargo)[RESOURCES.indexOf(r)] ?? 0]));
  const known0 = { delivered: zeros(request.need), verification: 'KnownZero' };
  if (end.raided) {
    const r = end.raided;
    if (r.choice === 1) return { ...base, state: 'raided-burned', ...known0, cargoLogged: null, signature: r.signature, note: '襲撃で焼かれた（CARAVAN_RAIDED）。0 と分かっている' };
    return { ...base, owner: { ownerTag: r.raiderTag }, state: 'raided-taken', ...known0, cargoLogged: null, signature: r.signature, note: '襲撃で奪われた（CARAVAN_RAIDED。J2：奪った人の物）。依頼の届け先には 0' };
  }
  const st = end.settled;
  const cargoLogged = pick(st.cargo);
  if (st.outcome !== 0) return { ...base, state: 'lost', ...known0, cargoLogged, dstGen: st.dst.gen, signature: st.signature, note: '行き先がない・世代が違うので失われた（CARAVAN_SETTLED の LOST）。0 と分かっている' };
  if (!samePlace(st.dst, request.to)) return { ...base, state: 'misdelivered', ...known0, cargoLogged, dstGen: st.dst.gen, signature: st.signature, note: '依頼の届け先とは別の場所に確定した。依頼の届け先には 0' };
  const c = creditedOf(st);
  if (c.qty === null) return { ...base, state: 'delivered', delivered: null, verification: c.verification, cargoLogged, dstGen: st.dst.gen, signature: st.signature, note: c.why };
  return { ...base, state: 'delivered', delivered: pick(c.qty), verification: c.verification, basis: c.basis, cargoLogged, dstGen: st.dst.gen, signature: st.signature, note: '村あて（RuleDerived）：記録の cargo が整数単位の入荷量' };
}

/** ヘラルドの一覧だけから作る到着の記録（表示と突き合わせ用。量は呼び出し側で数えない）。 */
function heraldArrival(request, link, feed) {
  const k = keyOf(link.caravan);
  const base = { requestId: request.id, caravanId: { ...link.caravan }, owner: { ownerTag: String(link.caravan.ownerTag) }, responder: link.responder };
  const raid = feed.raided.get(k);
  const settled = feed.settled.get(k);
  const pick = cargo => Object.fromEntries(Object.keys(request.need).map(r => [r, cargoOf(cargo)[RESOURCES.indexOf(r)] ?? 0]));
  if (raid && raid.choice === 1) return { ...base, state: 'raided-burned', source: 'herald-ended', note: '襲撃で焼かれた。数えない' };
  if (raid && raid.choice === 0) return { ...base, owner: { ownerTag: String(raid.raiderTag ?? '') }, state: 'raided-taken', source: 'herald-ended', note: '襲撃で奪われた（J2：荷車ごと奪った人の物）。数えない' };
  if (settled) {
    if (settled.outcome === 1) return { ...base, state: 'lost', source: 'herald-ended', note: '行き先がない・世代が違うので失われた（caravan.rs LOST）' };
    if (!samePlace(settled.dst, request.to)) return { ...base, state: 'misdelivered', cargoLogged: pick(settled.cargo), source: 'herald-ended', note: '依頼の届け先とは別の場所に確定した。数えない' };
    const c = creditedOf(settled);
    if (c.qty === null) return { ...base, state: 'delivered', cargoLogged: pick(settled.cargo), source: 'herald-ended', note: c.why };
    return { ...base, state: 'delivered', cargoLogged: pick(settled.cargo), source: 'herald-ended', note: 'ヘラルドの写しでは村に確定' };
  }
  const m = feed.moving.get(k);
  if (m) {
    if (m.raided) return { ...base, state: cargoOf(m.cargo).every(x => x === 0) ? 'raided-burned' : 'raided-taken', source: 'herald-moving', note: '襲われた（一覧の印）。数えない' };
    // 奪われると、同じ隊商の ID のまま奪った人の行き先へ向かう（caravan.rs の RaidCaravan は同じ鍵で CARAVAN_SENT を出し、
    // ヘラルドの一覧はそれで書き換わる）。行き先が依頼の届け先と違えば、奪われたとみる。
    if (!samePlace(m.dst, request.to)) return { ...base, state: 'raided-taken', source: 'herald-moving', note: '行き先が依頼の届け先と違う（奪われて行き先が変わったとみられる）。数えない' };
    return { ...base, state: 'moving', source: 'herald-moving', note: `着く予定：${m.arriveTs ?? '?'}（まだ数えない）` };
  }
  return { ...base, state: 'unknown', source: 'none', note: feed.hasEnded ? '一覧にも確定の記録にもない' : 'このヘラルドは確定の記録（ended）を出していない。到着は未検証（④のパッチ待ち）' };
}

/**
 * 結び付けてよい隊商か（板が link を受け取る前に、ヘラルドの一覧で確かめる）。理由の文字列か null。
 * 輸送中の一覧にあり、持ち主の印が署名した人のもので、行き先が依頼の届け先で、依頼の資源を一つ以上積んでいること。
 */
export function linkProblem(request, caravan, ownerTag, file) {
  const m = indexFeed(file).moving.get(keyOf(caravan));
  if (!m) return 'この隊商は輸送中の一覧にない（送った直後ならヘラルドの更新を待つ）';
  if (String(m.ownerTag) !== String(ownerTag)) return 'この隊商の持ち主ではない';
  if (m.raided) return '襲われた隊商は結び付けない';
  if (!samePlace(m.dst, request.to)) return '行き先が依頼の届け先ではない';
  const c = cargoOf(m.cargo);
  if (!Object.keys(request.need).some(r => c[RESOURCES.indexOf(r)] > 0)) return '依頼の資源を積んでいない';
  return null;
}

/** 依頼ごとの到着の記録の一覧。 */
export function arrivalsOf(state, file, chainEnds = undefined) {
  const feed = indexFeed(file);
  const out = [];
  for (const q of Object.values(state.requests)) for (const l of q.links) out.push(arrivalOf(q, l, feed, chainEnds === undefined ? undefined : (chainEnds[keyOf(l.caravan)] ?? { status: 'unverified', why: 'まだ読んでいない' })));
  return out;
}

export const caravanKeyOf = keyOf;
