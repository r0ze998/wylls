# ⑯ 受領後の検査項目（④⑧⑱⑲、2026-10-31 の指示）

④へ返す形式: **受領したファイル（SHA-256）／実行した tree（完全 HEAD・tree）／実行済・未実行／食い違い（再現入力・期待結果・実際の結果・原因箇所・最小修正候補）**。候補は隔離 worktree に留め、本線に取り込まない。環境・バイナリが無い項目は未実行のまま残す（導入しない）。

## 区別して報告するもの
1. **旧版（④ e7f7909d 基準）**で P3（`end_bell ≤ 4_032`）と P4（境界をまたぐ隊商の永久 `CaravanEarly`）の再現試験が**通る**こと（= 不具合が再現する）。
2. **継続世界候補（⑧、④×⑧）**で、同じ境界を越えて隊商・加工・預かり・未確定取引・封印進軍が**継続する**こと。P2/P3/P4 を候補の tree で再実行し、結果の反転を記録する。
3. **LiteSVM での成功**と、**実ローカルチェーン（frontier-localnet / in-process）での境界・再起動の成功**を分ける。本環境に `cargo-build-sbf` は無いので、前者は候補側の記録を引用するだけ（未実行）になる可能性が高い。後者は `frontier-node/crates/itest` の in-process（native model = 代役）か、候補が同梱する試験で行う。
4. **二重実行が無いこと**（keeper の write 件数・engine の versions・agent wallet の sent 数が境界と再起動の前後で変わらない）と、**余分な取引手数料が無いこと**（payer の lamports 差分 = 期待する fee × 件数。`AlreadyDone`/`OutOfOrder` で終わる重複版の fee も数える）。

## ⑱（修正候補が届いた場合）
- 平文を含む Reveal（取引、または keeper への `POST /v1/reveal` の material）が、**公開可能になる前**（候補の定義する時点。現行は到着ターン開始）に RPC へ送信されないことを、web `marchbook.revealStep` / keeper `reveal_accept` / keeper `play.rs` の Reveal duty の 3 箇所で独立に確かめる。基点の挙動は `v16-public-ops.test.mjs` T18-1（ターン開始で送る）。
- 「公開可能」の定義（round 公開時刻か、anchor の着地か）は候補の文書に従い、⑯は決めない。

## ⑲（正本が届いた場合。別 program のローカル板。S1 全体の MagicBlock 対応や公開 devnet 検証ではない）
- version 1 の解除取引で findex が停止する問題: 該当取引を含む archive を取り込み、停止すること（旧）／取り込めること（修正後）。
- program アドレスだけを追う取り込みが commit を見落とす問題: delegation program 側の取引を含むかで `/h/events` と口座状態が食い違わないこと。
- ER の未 commit 書込み消失: **検出して止まる**ことと、**復元できた**ことを別に記録する。
- 脱出（request/rollback undelegation）: LiteSVM での確認と、実 ER での未確認を分ける。本環境では実 ER は無い（未実行）。
- 履歴欠落検出の限界: 初回取得や途中だけの欠落は見逃しうる（findex `RpcPoll` は `getFirstAvailableBlock` も `until` 署名の存在も確認しない）。検査を通っただけでは完全な履歴や「未発送」の証明にならないと明記する。
