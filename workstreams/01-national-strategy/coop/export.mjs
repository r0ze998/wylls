// ①の板の状態を、ほかの担当の評価器（⑮ `src/adapters/ws01.mjs` など）へ渡す形。fold() の形は変えない（板・画面が使う）。
//
// 契約「ws01-board v1」（2026-11-08。⑮と合わせる）：
//   {v: 1, contexts: [{programId, seasonId}], requests: [依頼…（at、id の順）], left: {goalId: [wallet]}}
//   依頼：fold() の依頼そのまま（id, ctx, goalId, requester, nation（申告）, need, to, at, expiresAt, state, cancel, responses, links, sendings）
//     state：'open' | 'cancelled'（記録の状態。期限切れは時刻で読む：stateAt(q, now) → 'expired'。'accepted' という状態は無い）
//     links：[{responder, claimedNation（申告。判定に使わない）, caravan: {ownerTag（10 進の文字列）, seq, ctx: '<programId>/<seasonId>'}, at, n（記録の順）, caravanKey}]
//   caravanKey：'<programId>/<seasonId>:<ownerTag>:<seq>'。Citizen はシーズン（文脈）ごとの口座で、隊商の番号もその Citizen ごとに 0 から。
//     だから `${ownerTag}:${seq}` だけでは、文脈をまたいで別の隊商が同じ鍵になる。重複の判定・結び付けの引き当ては caravanKey で行う。
//   同じ隊商の二つ目の結び付けは、板が断る（record.mjs）。記録が欠けた板・別の板を混ぜたときの守りは goal.mjs allocate（n の小さい方を採る）。
//   量は、この形には入れない（①の到着の見え方ではなく、S1 の記録から評価器が読む。二重に数えない）。
//   結び付けた隊商が、依頼の届け先（to：kind 'holding'、p、q、site、gen）とは別の場所に確定したら、その依頼の到着ではない
//     （①は「原因を確認中」。④ QUANTITY-CONTRACT §3）。評価器も、届け先が to と同じときだけ依頼の到着とする。

import { caravanKeyOf } from './arrival.mjs';
import { stateAt } from './record.mjs';

/** fold() の状態 → 契約 ws01-board v1。now を渡すと、各依頼に stateNow（期限切れを反映）を足す。 */
export function boardForEvaluators(state, { contexts = [], now = null } = {}) {
  const requests = Object.values(state.requests)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(q => ({
      ...q,
      ...(now === null ? {} : { stateNow: stateAt(q, now) }),
      links: q.links.map(l => ({ ...l, caravanKey: caravanKeyOf(l.caravan) })),
    }));
  return { v: 1, contexts: contexts.map(c => ({ programId: c.programId, seasonId: String(c.seasonId) })), requests, left: state.left };
}

/** 依頼の届け先と、記録の場所（S1 の log_place を読んだもの：{kind, p, q, site, gen}）が同じか。 */
export const isRequestDestination = (q, place) => Number(place?.kind) === 1 && place.p === q.to.p && place.q === q.to.q && place.site === q.to.site && place.gen === q.to.gen;
