// 依頼の充足の「数えた量」の言い方（表示だけ。判定は ws04.mjs fulfilmentOf のまま）。imports なし。
//
// fulfilmentOf の upperExclusive（すべて終わったときだけ。資源ごと）は、到着ごとの「数えられうる量の上限（未満）」の和
// （goal.mjs countOf：下限の到着は b+1、量を確認できない到着は cargo_logged+1、受取人・時刻が未検証の到着も b+1、
// 0 と分かる・数えないと決まった到着は 0）。正の項は 1 以上なので、和が 0 になるのは、その資源の項がすべて「ちょうど 0」のときだけ。
// そのとき数えた量はちょうど 0 で、「上限 0 未満」（0 より少ない）ではない。和が正なら、数えた量はその値「未満」。
//   - 上限が無い（終わっていない隊商がある）：下限だけを言う
//   - 上限が正：「下限 b、上限 u 未満」（これまでと同じ文）
//   - 上限が 0：「ちょうど 0」
// 例：下限 {wood: 9}・上限 {wood: 11} → 「数えた量の下限 木材 9、上限 木材 11 未満」
//     下限 {stone: 0}・上限 {stone: 0}（焼かれた隊商だけ）→ 「数えた量 石材 ちょうど 0（どの隊商も数えられないと決まった）」

const list = (o, keys, ja) => keys.map(r => `${ja[r] ?? r} ${o[r]}`).join('・');

/** f：fulfilmentOf の結果（lower・upperExclusive）、ja：資源の日本語名。返すのは「数えた量…」の文。 */
export function fulfilBoundsText(f, ja) {
  const lower = f?.lower ?? {};
  const keys = Object.keys(lower);
  if (!keys.length) return '数えた量の下限 —';
  const U = f.upperExclusive ?? null;
  const exact = U ? keys.filter(r => U[r] === 0) : [];
  const ranged = keys.filter(r => !exact.includes(r));
  const parts = [];
  if (ranged.length) parts.push(`数えた量の下限 ${list(lower, ranged, ja)}${U ? `、上限 ${list(U, ranged, ja)} 未満` : ''}`);
  if (exact.length) parts.push(`数えた量 ${exact.map(r => `${ja[r] ?? r} ちょうど 0`).join('・')}（どの隊商も数えられないと決まった）`);
  return parts.join('、');
}

/**
 * 共同の目的の精度の言い方（表示だけ）。progress：goal.mjs coopView の joint[].progress（{resource, underBy}）。
 * underBy＝数えた到着の件数 k。記録は1件ずつ切り捨てなので、本当の量は表示より k 未満多いことがある（④ QUANTITY-CONTRACT §4：［Σb, Σb＋n））。
 * k＝0（明示の 0）の資源は数えた到着がなく、数えた量はちょうど 0：「0 未満多い」とは言わない。
 * k が 0 以上の安全な整数でない（欠けた・null・負・小数・NaN・文字列など）、または要素そのものが無い・形が違うときは、
 * 精度が分からない：0 と言わない（推し量らない）。
 */
const kOf = p => (p && typeof p === 'object' && Number.isSafeInteger(p.underBy) && p.underBy >= 0 ? p.underBy : null);
const nameOf = (p, ja) => {
  const r = p && typeof p === 'object' && typeof p.resource === 'string' && p.resource ? p.resource : null;
  return r === null ? '（資源名なし）' : ja?.[r] ?? r;
};
export function jointPrecisionText(progress, ja) {
  const ps = Array.isArray(progress) ? progress : [];
  const some = ps.filter(p => kOf(p) > 0), zero = ps.filter(p => kOf(p) === 0), unknown = ps.filter(p => kOf(p) === null);
  const parts = [];
  if (some.length) parts.push(`記録は到着1件ごとにミリ単位を切り捨てた値なので、本当の量は表示より ${some.map(p => `${nameOf(p, ja)} ${p.underBy} 未満`).join('・')} 多いことがある（件数ぶん）`);
  if (zero.length) parts.push(`${zero.map(p => nameOf(p, ja)).join('・')}は数えた到着がなく、数えた量はちょうど 0`);
  if (unknown.length) parts.push(`${unknown.map(p => nameOf(p, ja)).join('・')}は数えた到着の件数が示されていないので、精度が分からない`);
  return ['整数単位', ...parts].join('。');
}
