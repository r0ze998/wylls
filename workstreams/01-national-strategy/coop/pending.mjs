// 結果の分からない送信・着地したのに結び付けていない送信を見つける（板と画面で同じ規則）。
//
// 送る人が隊商の取引に署名すると、中継へ出す前に板へ sending の記録を残す（record.mjs）。板・画面が再起動しても記録は残るので、
// 同じ依頼への次の署名・送付は、前の送信の結果が分かるまで止める。止めるのは次の二つ：
//   'unknown'          結果が分からない（chain.mjs sendOutcome が unknown。期限切れ・失敗・不一致・番号の取られが分かれば解ける）
//   'landed-unlinked'  着地した（取引の中身が計画と一致した）のに、その隊商をまだ依頼に結び付けていない。
//                      画面を閉じた・板が再起動した後にここで止めないと、同じ物をもう一度送れてしまう。結び付ければ解ける。
// 鍵・署名・住所の導出を使わない（記録と、確かめた結果の表だけを見る）。

import { caravanKeyOf } from './arrival.mjs';

/**
 * q：依頼（record.mjs の fold の形：links、sendings）、signer：送る人のウォレット、outcomeOf(z) → sendOutcome の結果（なければ unknown）。
 * 止める送信があれば {kind, sending, why}、なければ null。
 */
export function pendingSendOf(q, signer, outcomeOf) {
  const linked = new Set((q.links ?? []).map(l => caravanKeyOf(l.caravan)));
  for (const z of q.sendings ?? []) {
    if (z.responder !== signer) continue;
    const o = outcomeOf(z) ?? { status: 'unknown' };
    if (o.status === 'unknown') return { kind: 'unknown', sending: z, why: `結果の分からない送信（隊商 #${z.caravan.seq}）が残っている。着地・失敗・期限切れが分かるまで次を送らない` };
    if (o.status === 'landed' && !linked.has(caravanKeyOf(z.caravan))) return { kind: 'landed-unlinked', sending: z, why: `着地した隊商 #${z.caravan.seq} をまだこの依頼に結び付けていない。結び付けるまで次を送らない（同じ物を二度送らない）` };
  }
  return null;
}
