// 共同の目的の、数えた到着（counted）の資源ごとの集計（goal.mjs coopView の joint の loop から抜き出したもの）。imports なし。
//
// 一つの数えた到着の counted（依頼の資源ごとの整数単位の下限 b）を、
//   perResource[r] += b       … 数えた入荷量の下限の和（共同の目的の判定が読む）
//   records[r]    += 1        … 数えた到着の件数 k（記録が 0 の到着も数える：b＝0 でも実際は［0, 1）。④ QUANTITY-CONTRACT §3・§4 の n）
// に足す。算術は抜き出す前と同じ（`perResource[r] += v`、`records[r] = (records[r] ?? 0) + 1`）。
// どの到着を数えるか（重複の到着を飛ばす、counted が null の到着を数えない）は呼び出し側（goal.mjs）が決める。ここでは決めない。
// perResource・records をその場で書き換える（呼び出し側の h の欄）。

/** counted：{資源: 整数単位の下限}（goal.mjs countOf の counted）。perResource・records：書き換える集計。 */
export function addCounted(perResource, records, counted) {
  for (const [r, v] of Object.entries(counted)) { perResource[r] += v; records[r] = (records[r] ?? 0) + 1; }
}
