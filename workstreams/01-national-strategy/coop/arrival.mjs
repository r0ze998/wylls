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
//                   'KnownZero'（証拠のある 0 だけ：この隊商の CARAVAN_RAIDED の焼却・奪取、隊商の口座の持ち主が送った人でなくなった（奪取だけが
//                               書き換える）、CARAVAN_SETTLED の LOST。④ QUANTITY-CONTRACT §3 R-1）。記録の cargo が 0 なだけ・別の場所に確定しただけでは 0 としない
//   held          ：'DestinationMismatch'（別の場所に確定・別の行き先へ向かう、襲撃の記録なし）。量を述べない・相手の名前や評判に使わない
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
import { addressesOf } from './ids.mjs';

export const STATE_JA = Object.freeze({
  moving: '輸送中（まだ送り主の物）', delivered: '到着（確定）', misdelivered: '別の場所に着いた（原因を確認中）', misdirected: '別の行き先へ向かっている（原因を確認中）',
  'raided-unconfirmed': '襲われた印がある（焼かれたか奪われたかは記録で確かめていない）', lost: '失われた（行き先がない・世代が違う）',
  'raided-taken': '奪われた（奪った人の物）', 'raided-burned': '焼かれた', unknown: '不明（未検証）',
});

/** ヘラルドの一覧の鍵（ヘラルドは一つの文脈＝シーズンの一覧を出す）。 */
const feedKey = c => `${String(c.ownerTag)}:${Number(c.seq)}`;
/** 隊商の鍵：文脈を含む（Citizen はシーズンごとの口座で、隊商の番号もその Citizen ごとに 0 から。文脈が違えば別の隊商）。 */
const keyOf = c => (c.ctx ? `${c.ctx}:${feedKey(c)}` : feedKey(c));
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
  for (const m of file?.moving ?? []) moving.set(feedKey(m), m);
  const hasEnded = Array.isArray(file?.ended);
  for (const raw of file?.ended ?? []) {
    const e = endedOf(raw);
    if (!e) continue;
    if (e.end === 'settled') settled.set(feedKey(e), e);
    else raided.set(feedKey(e), e);
  }
  return { moving, settled, raided, hasEnded, vaults: file?.vaults ?? [], ctx: file?.ctx ?? null };
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
  // まだ確定・襲撃の記録がない隊商：チェーンの隊商の口座（輸送中なら口座がある）で状態を出す。前の文脈の隊商は今のヘラルドに出ないので、これが要る
  const acc = chainEnd?.account;
  if (chainEnd?.status === 'none' && acc?.status === 'found') {
    const base = { requestId: request.id, caravanId: { ...link.caravan }, owner: { ownerTag: String(link.caravan.ownerTag) }, responder: link.responder, source: 'chain-account', delivered: null, verification: null };
    if (!samePlace(acc.dst, request.to)) {
      // 持ち主（OWNER_CITIZEN）を書き換えるのは奪取だけ（caravan.rs:1282）。持ち主が送った人でなければ奪われた証拠。同じなら原因未確認
      const ctx = typeof link.caravan.ctx === 'string' ? link.caravan.ctx.split('/') : null;
      const sender = ctx?.length === 2 ? addressesOf({ programId: ctx[0], seasonId: ctx[1] }).of('Citizen', { wallet: link.responder }) : null;
      if (sender && acc.ownerCitizen && acc.ownerCitizen !== sender) return { ...base, state: 'raided-taken', delivered: zeros(request.need), verification: 'KnownZero', note: '隊商の口座の持ち主が送った人ではなくなった（奪取だけが書き換える）。依頼の届け先には 0' };
      return { ...base, state: 'misdirected', held: 'DestinationMismatch', note: '隊商の口座の行き先が依頼の届け先と違う（原因を確認中。襲撃の記録はない）。数えない' };
    }
    const ended = ['delivered', 'lost', 'misdelivered', 'raided-taken', 'raided-burned'].includes(h.state);
    return { ...base, state: 'moving', note: `輸送中（チェーンの隊商の口座）。まだ数えない${ended ? `（ヘラルドの写しは「${STATE_JA[h.state] ?? h.state}」で、チェーンと食い違う）` : ''}`, ...(ended ? { heraldDisagrees: h.state } : {}) };
  }
  const why = chainEnd === undefined ? 'チェーンの取引の記録と照合していない（板に --rpc がない）'
    : chainEnd.status === 'none' ? 'チェーンの取引の記録に、この隊商の確定・襲撃はまだない' : chainEnd.why;
  if (['moving', 'misdirected', 'raided-unconfirmed', 'raided-taken', 'raided-burned'].includes(h.state) && h.source === 'herald-moving') return { ...h, delivered: null, verification: null };
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
  // 別の宛先で確定しただけでは「奪われた」「0」としない（襲撃の記録が無い）。④ DestinationMismatch：保留、量を述べない、相手の名前や評判に使わない
  if (!samePlace(st.dst, request.to)) return { ...base, state: 'misdelivered', delivered: null, verification: null, held: 'DestinationMismatch', cargoLogged, dstGen: st.dst.gen, signature: st.signature, note: '依頼の届け先とは別の場所に着いた（原因を確認中。襲撃の記録はない）' };
  const c = creditedOf(st);
  if (c.qty === null) return { ...base, state: 'delivered', delivered: null, verification: c.verification, cargoLogged, dstGen: st.dst.gen, signature: st.signature, note: c.why };
  return { ...base, state: 'delivered', delivered: pick(c.qty), verification: c.verification, basis: c.basis, cargoLogged, dstGen: st.dst.gen, signature: st.signature, note: '村あて（RuleDerived）：記録の cargo は入荷量の下限（資源ごとに 1 未満多く入っていうる）' };
}

/** ヘラルドの一覧だけから作る到着の記録（表示と突き合わせ用。量は呼び出し側で数えない）。 */
function heraldArrival(request, link, feed) {
  const k = feedKey(link.caravan);
  // 別の文脈の隊商は、今のヘラルドの一覧には出ない（ヘラルドはシーズンごと）。チェーンの記録だけで決める
  if (feed.ctx && link.caravan.ctx && link.caravan.ctx !== feed.ctx) feed = { moving: new Map(), settled: new Map(), raided: new Map(), hasEnded: true };
  const base = { requestId: request.id, caravanId: { ...link.caravan }, owner: { ownerTag: String(link.caravan.ownerTag) }, responder: link.responder };
  const raid = feed.raided.get(k);
  const settled = feed.settled.get(k);
  const pick = cargo => Object.fromEntries(Object.keys(request.need).map(r => [r, cargoOf(cargo)[RESOURCES.indexOf(r)] ?? 0]));
  if (raid && raid.choice === 1) return { ...base, state: 'raided-burned', source: 'herald-ended', note: '襲撃で焼かれた。数えない' };
  if (raid && raid.choice === 0) return { ...base, owner: { ownerTag: String(raid.raiderTag ?? '') }, state: 'raided-taken', source: 'herald-ended', note: '襲撃で奪われた（J2：荷車ごと奪った人の物）。数えない' };
  if (settled) {
    if (settled.outcome === 1) return { ...base, state: 'lost', source: 'herald-ended', note: '行き先がない・世代が違うので失われた（caravan.rs LOST）' };
    if (!samePlace(settled.dst, request.to)) return { ...base, state: 'misdelivered', held: 'DestinationMismatch', cargoLogged: pick(settled.cargo), source: 'herald-ended', note: '依頼の届け先とは別の場所に着いた（原因を確認中）。数えない' };
    const c = creditedOf(settled);
    if (c.qty === null) return { ...base, state: 'delivered', cargoLogged: pick(settled.cargo), source: 'herald-ended', note: c.why };
    return { ...base, state: 'delivered', cargoLogged: pick(settled.cargo), source: 'herald-ended', note: 'ヘラルドの写しでは村に確定' };
  }
  const m = feed.moving.get(k);
  if (m) {
    // 一覧の印だけでは焼却・奪取を決めない（1 未満の積荷も 0 と出る。④ QUANTITY-CONTRACT §7 ①(d)）。記録（ended・チェーン）で決める
    if (m.raided) return { ...base, state: 'raided-unconfirmed', source: 'herald-moving', note: '襲われた印がある（一覧）。焼かれたか奪われたかは記録で確かめていない。数えない' };
    // 行き先が違うだけでは奪われたとしない（襲撃の証拠がない）。原因を確認中
    if (!samePlace(m.dst, request.to)) return { ...base, state: 'misdirected', held: 'DestinationMismatch', source: 'herald-moving', note: '行き先が依頼の届け先と違う（原因を確認中）。数えない' };
    return { ...base, state: 'moving', source: 'herald-moving', note: `着く予定：${m.arriveTs ?? '?'}（まだ数えない）` };
  }
  return { ...base, state: 'unknown', source: 'none', note: feed.hasEnded ? '一覧にも確定の記録にもない' : 'このヘラルドは確定の記録（ended）を出していない。到着は未検証（④のパッチ待ち）' };
}

/**
 * 結び付けてよい隊商か（板が link を受け取る前に、ヘラルドの一覧で確かめる）。理由の文字列か null。
 * 輸送中の一覧にあり、持ち主の印が署名した人のもので、行き先が依頼の届け先で、依頼の資源を一つ以上積んでいること。
 */
export function linkProblem(request, caravan, ownerTag, file) {
  const m = indexFeed(file).moving.get(feedKey(caravan));
  if (!m) return 'この隊商は輸送中の一覧にない（送った直後ならヘラルドの更新を待つ）';
  if (String(m.ownerTag) !== String(ownerTag)) return 'この隊商の持ち主ではない';
  if (m.raided) return '襲われた隊商は結び付けない';
  if (!samePlace(m.dst, request.to)) return '行き先が依頼の届け先ではない';
  const c = cargoOf(m.cargo);
  if (!Object.keys(request.need).some(r => c[RESOURCES.indexOf(r)] > 0)) return '依頼の資源を積んでいない';
  return null;
}

/** 依頼ごとの到着の記録の一覧。 */
export function arrivalsOf(state, file, chainEnds = undefined, currentCtx = null) {
  const feed = indexFeed(file ? { ...file, ctx: currentCtx } : file);
  const out = [];
  for (const q of Object.values(state.requests)) for (const l of q.links) out.push(arrivalOf(q, l, feed, chainEnds === undefined ? undefined : (chainEnds[keyOf(l.caravan)] ?? { status: 'unverified', why: 'まだ読んでいない' })));
  return out;
}

export const caravanKeyOf = keyOf;
