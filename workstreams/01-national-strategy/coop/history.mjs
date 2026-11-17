// 依頼の記録（2026-11-17）：板の view の一つの依頼（goal.mjs coopView の requests[]）について、板が持っている記録を読むだけで並べる。
//   送信：sending の記録と、板が表示の度に確かめる結果（board.mjs sendingStatus → chain.mjs sendOutcome。確かめていなければ unknown）
//   結び付け：links（record.mjs の fold）。着地した送信が、この依頼に結び付いているか
//   到着と算入：arrivals（arrival.mjs・goal.mjs：結び付けた隊商の到着、counted は数えた量の下限、null は数えていない）
// 依頼の状態（受付中・取り消し・期限切れ）や、応答の取り下げにかかわらず出す。板の記録は追記で保存されるので、読み込み直し・
// 板の再起動の後も同じものが出る。ここは読むだけ：送らない・結び付けない・確かめ直さない（結び付けの記録を出す followSend は使わない）。
// 分からないものは分からないと言う（送っていない・成功・0 にしない）。数えていない到着に量を作らない。

import { caravanKeyOf } from './arrival.mjs';

/** chain.mjs sendOutcome の結果の言葉。着地は到着ではない。 */
export const OUTCOME_JA = Object.freeze({
  landed: '着地した（取引の中身が計画と一致。到着ではない）',
  failed: 'プログラムが断った（物は動いていない）',
  mismatch: '取引の中身が計画と違う（この依頼の送信としては数えない）',
  // （2026-11-17 訂正）根拠は sendOutcome の expired：自分の取引がいま読めず、その blockhash がもう有効でない（blockhashValid が false）。
  // これからその blockhash で着地しないことであって、過去に物が動かなかったこと・取引が無かったことではない
  expired: '自分の取引はいま見えず、その blockhash はもう有効でない（この取引はこれから着地しない。過去に物が動いたかは、これだけでは言えない）',
  'seq-taken': '番号を別の送信が使った可能性（自分の取引は見えない）',
  unknown: '結果が分からない（まだ確かめられない。送っていないとは言わない）',
});

/**
 * → {sendings: null | [{mine, responder, seq, src, cargo, status, known, why, link: 'linked'|'unlinked'|null}],
 *    arrivals: null | [{ownerTag, seq, state, counted (null は数えていない), why, final}]}
 * null は、その欄が板の答えにない・読めない（ないとは言わない）。
 */
export function requestHistory(q, me) {
  const linked = new Set((Array.isArray(q?.links) ? q.links : []).filter(l => l?.caravan).map(l => caravanKeyOf(l.caravan)));
  const sendings = !Array.isArray(q?.sendings) ? null : q.sendings.map(z => {
    const o = z?.outcome && typeof z.outcome.status === 'string' ? z.outcome : { status: 'unknown', why: '板の答えに結果がない' };
    const k = z?.caravan ? caravanKeyOf(z.caravan) : null;
    return {
      mine: !!me && z?.responder === me, responder: z?.responder ?? null, seq: z?.caravan?.seq ?? null, src: z?.src ?? null, cargo: z?.cargo ?? null,
      status: o.status, known: Object.prototype.hasOwnProperty.call(OUTCOME_JA, o.status), why: o.why ?? null,
      link: o.status !== 'landed' ? null : k && linked.has(k) ? 'linked' : 'unlinked',
    };
  });
  const arrivals = !Array.isArray(q?.arrivals) ? null : q.arrivals.map(x => ({
    ownerTag: x?.caravanId?.ownerTag ?? null, seq: x?.caravanId?.seq ?? null, state: x?.state ?? 'unknown',
    counted: x?.counted && typeof x.counted === 'object' ? x.counted : null, why: x?.notCountedWhy ?? null, final: x?.countFinal ?? null, raw: x,
  }));
  return { sendings, arrivals };
}
