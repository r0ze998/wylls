// 到着の確認（④との契約の形）：依頼に結び付けた隊商が、いま何の状態で、どれだけ確かめて届いたか。
//
// 入力はヘラルドの `h/caravans.json`。
//   - `moving`・`vaults` は今のヘラルドにある（frontier-node/crates/herald/src/caravan.rs）。
//   - `ended`（隊商の確定 CARAVAN_SETTLED と襲撃 CARAVAN_RAIDED の記録）は、今のヘラルドにはない。
//     ①の提案パッチ（proposals/0002-herald-caravan-ended.patch、④へ渡す）で足す。
//     `ended` がないヘラルドでは、一覧から消えた隊商は「不明（未検証）」になり、量は数えない。
//
// 契約の形（1本の隊商ごと）：
//   { requestId, caravanId: {ownerTag, seq}, owner: {ownerTag}, state, verifiedQty, source, note }
//   state: 'moving'（輸送中・送り主の物） | 'delivered'（依頼の届け先に確定） | 'misdelivered'（別の場所に確定）
//        | 'lost'（行き先がない・世代が違う） | 'raided-taken'（奪われた。J2：奪った人の物） | 'raided-burned'（焼かれた）
//        | 'unknown'（一覧にも確定の記録にもない：未検証）
//   verifiedQty: 依頼の資源ごとの、確定の記録の量（経路の塔の目減りの後。依頼の量を上限にしない生の量） | null（未検証）
//   source: 'herald-ended' | 'herald-moving' | 'none'

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

const samePlace = (dst, to) => dst && Number(dst.kind) === 1 && Number(dst.p) === to.p && Number(dst.q) === to.q && Number(dst.at) === to.site && Number(dst.gen) === to.gen;

/** 結び付けた1本の隊商の到着の記録（契約の形）。 */
export function arrivalOf(request, link, feed) {
  const k = keyOf(link.caravan);
  const base = { requestId: request.id, caravanId: { ...link.caravan }, owner: { ownerTag: String(link.caravan.ownerTag) }, responder: link.responder };
  const raid = feed.raided.get(k);
  const settled = feed.settled.get(k);
  const pick = cargo => Object.fromEntries(Object.keys(request.need).map(r => [r, cargoOf(cargo)[RESOURCES.indexOf(r)] ?? 0]));
  if (raid && raid.choice === 1) return { ...base, state: 'raided-burned', verifiedQty: null, source: 'herald-ended', note: '襲撃で焼かれた。数えない' };
  if (raid && raid.choice === 0) return { ...base, owner: { ownerTag: String(raid.raiderTag ?? '') }, state: 'raided-taken', verifiedQty: null, source: 'herald-ended', note: '襲撃で奪われた（J2：荷車ごと奪った人の物）。数えない' };
  if (settled) {
    if (settled.outcome === 1) return { ...base, state: 'lost', verifiedQty: null, source: 'herald-ended', note: '行き先がない・世代が違うので失われた（caravan.rs LOST）' };
    if (!samePlace(settled.dst, request.to)) return { ...base, state: 'misdelivered', verifiedQty: null, source: 'herald-ended', note: '依頼の届け先とは別の場所に確定した。数えない' };
    return { ...base, state: 'delivered', verifiedQty: pick(settled.cargo), source: 'herald-ended', note: '確定の記録の量（経路の塔の目減りの後）' };
  }
  const m = feed.moving.get(k);
  if (m) {
    if (m.raided) return { ...base, state: cargoOf(m.cargo).every(x => x === 0) ? 'raided-burned' : 'raided-taken', verifiedQty: null, source: 'herald-moving', note: '襲われた（一覧の印）。数えない' };
    // 奪われると、同じ隊商の ID のまま奪った人の行き先へ向かう（caravan.rs の RaidCaravan は同じ鍵で CARAVAN_SENT を出し、
    // ヘラルドの一覧はそれで書き換わる）。行き先が依頼の届け先と違えば、奪われたとみる。
    if (!samePlace(m.dst, request.to)) return { ...base, state: 'raided-taken', verifiedQty: null, source: 'herald-moving', note: '行き先が依頼の届け先と違う（奪われて行き先が変わったとみられる）。数えない' };
    return { ...base, state: 'moving', verifiedQty: null, source: 'herald-moving', note: `着く予定：${m.arriveTs ?? '?'}（まだ数えない）` };
  }
  return { ...base, state: 'unknown', verifiedQty: null, source: 'none', note: feed.hasEnded ? '一覧にも確定の記録にもない' : 'このヘラルドは確定の記録（ended）を出していない。到着は未検証（④のパッチ待ち）' };
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
export function arrivalsOf(state, file) {
  const feed = indexFeed(file);
  const out = [];
  for (const q of Object.values(state.requests)) for (const l of q.links) out.push(arrivalOf(q, l, feed));
  return out;
}
