# 13 ⑨ `06c817cc` と組み合わせた T5 の解消、V26 の注文の帳簿の再生（2026-11-06）

## 0. 起点と、先端に適用済みか別の親として保存だけか

| もの | 完全 SHA | tree | 担当ブランチ `claude/great-babbage-3ogkqu` の先端での扱い |
|---|---|---|---|
| ⑨ | `06c817cc2704f58b80475ec1f065463ede565aa9`（`claude/elegant-bohr-co2uhr`） | kernel `f2398a2c…`、bridge10 `7d393b43…`、rules `9ffca167…` | ⑨のファイルはこのブランチに入れていない。試験のときに pin から一時ディレクトリへ取り出す |
| ⑩ 本体・アダプター | `c27b95eb28f8ac3f093d84e7a8894affbcdbd556`（T5） | custody `b91cbfdd0da956148cbbecc1f7d639a03999a58c`（前回から不変）、adapter-09 `e6a4fbee376f7d3911899eaca9369574c010b4ae` | **先端に適用済み** |
| ⑩ core | `workstream/10-custody-core-v26` `1624d14a7a1c9e0cc4fbb2bb3586e157dd5464df`（`38a273a9` の上） | `5ac4d339ba6dd934677eced573fc0cf32b1b1283` | **先端には適用していない**。`patches/0013` として置き、commit は先端の merge コミットの第 2 親として保存しただけ |

⑨の `06c817cc` は⑩の前回の差分を**そのまま取り込んでいる**（`01229410`、tree `437c2246`）。⑩はそれを重ねて当てていない：⑨の bridge10 は `06c817cc` の tree のまま使った。

## 1. T5：`connect` と差分試験

⑨の CONNECT-10 §6.2 に残っていた T5 は、⑩のアダプターの `connect`（⑨の bridge が一つの区画表に移る前の代わり）と、古い bridge10（`992f4ba5`）との差分試験だった。⑨の bridge10 が一つの区画表の上で動く今、`connect` は⑨の bridge の写しでしかない。

| したこと | 内容 |
|---|---|
| `connect` を削除 | `adapter-09/src/lib.rs` から。`tests/use_orders.rs`、旧 `diff-bridge10` も削除 |
| アダプター自身の試験を残す | `tests/primitives.rs`：利用は一つの予約・投入につき一度、返却は消費を戻し端数は未返却、取った量より多く返せない、凍結・満杯は未返却のまま、再起動、（`nine-refused` で）⑩の理由が `Refused` に載る |
| `check_between` | `check` から「通過用の置き場に鉱石が残らない」を除いたもの（bridge の操作の途中でも成り立つ部分）。`check` は bridge の操作の間に使う |
| ⑨の bridge10 の上の試験 | `adapter-09/with-bridge10`：⑨の `06c817cc` の kernel・bridge10・rules を `run.sh` が pin から取り出し（tree を確認）、⑩の作業ツリーと組み合わせて動かす。他人の区画からの予約と本人の区画からの予約を同じ区画表に |

### 単一の区画表での確認（⑨の bridge10 の上、毎手に⑩の `check` と⑨の `Bridge::check`、M の区画の `IN_TOTAL` が動かないこと）

| 試験 | 確かめたこと |
|---|---|
| `returns_and_rests_on_the_one_table` | 他人の区画の予約：使わなかった鉱石は整数単位で消費を戻して区画へ、端数は未返却。`CONSUMED = 40 − 返した量`、`HELD = 60 + 返した量`。本人の区画の予約：返却用の容量を通して整数単位で戻り、予約が残らない。区画は 2 つで一つの表 |
| `every_step_replayed_changes_nothing` | 予約・投入・精算・取消・受け取り・分けた受け取りを 1 手ずつ 2 回送り、2 回目は `AlreadyApplied`、⑨＋⑩の状態のバイト列が不変 |
| `a_restart_at_every_step_gives_the_same_bytes` | 毎手の前に保存・復元しても、再起動なしと結果・バイト列が一致 |
| `rests_add_up_and_a_full_lot_is_paid_later` | 端数が足し合わさる。区画が満杯のときの返却は全量が未返却、quota を上げて `pay_owed` で整数単位が入り、端数だけが残る |
| `random_runs_on_one_table_never_count_twice` | 乱択 1,000 種 × 80 手（`run.sh`）：他人の区画からの投入 3,388、鉱石を返した受け取り 907、投入の再送 6,813、再起動 7,163。毎手に不変条件、受け取りの再送は何も動かさない |
| ⑨の bridge を通した変異 3 件 | 「返却を新しい入庫として記録」「端数を整数単位として払う」「払った量を返却として記録しない」：すべて検出 |

## 2. V26：注文の帳簿の再生（core `1624d14a`、patch 0013）

`V26:custody-history` に、区画の口座が記録している注文の帳簿の再生を足した（前後の記録の間）。

| 規則 | 根拠 | 破れたら |
|---|---|---|
| 新しい注文の id は [前の `NONCE`, 今の `NONCE`) にある | `set_order` は id を `NONCE` にして `NONCE` を進める | FAIL |
| 新しい注文の数 ≤ `NONCE` の進み | 同上 | FAIL |
| `NONCE` が同じ間、`CONSUMED` の増え ≤ そこにあった利用注文が減らした量 | 消費は利用注文の受け手だけ、注文の残りから。返却は `CONSUMED` を下げるだけ | FAIL |
| `IN_TOTAL` の増え ≤ その間に消えた到着枠の量 | 隊商は待たれていた量までしか届けない | **UNVERIFIABLE**（`CustodyHistoryUnexplained`）。二つの記録の間に隊商が始まって着いた可能性があり、命令の再生なしには証拠が足りない |

試験（`tests/custody_history.rs` 8 件）：偽の帳簿 3 種が FAIL／説明のつかない入庫は UNVERIFIABLE で FAIL でない、判定は PASS でない／**カーネルの 1〜4 段階を合わせた 9,000 区間で一度も FAIL にならない**（184 区間は区間の中で隊商が始まって着いたので UNVERIFIABLE。FAIL にしない理由そのもの）。変異 3 件を検出。`custody.rs` 6 件、`custody_state.rs` 7 件と合わせて 21 件通過。stable の clippy `-D warnings` 通過。

**証拠不足を PASS にしない**：命令ごとの再生（どの命令か、署名者、量）はまだない（ABI の番号が仮）。custody のシーズンはどの検査が通っても `CustodyUnverified` が残る。

実行した verify の試験は `custody.rs`・`custody_state.rs`・`custody_history.rs` だけ（名前で選んだ）。鍵の生成・導出・署名を伴う試験は実行していない。

## 3. ⑨と④への差分

### ⑨へ：`patches-to-09/0002-*.patch`（`06c817cc` に当たる。当てた後の tree `e751e3be5f59d7e831ac8a3d7020f7227f6a3a1a`）

⑨のコードは変えない。`run.sh` の⑩の pin を `c27b95eb`（custody `b91cbfdd`、adapter-09 `e6a4fbee`）へ、CONNECT-10 の T5 を解決に、§7 の古い pin（`52a43745`）を直す。4 行。**⑨の `run.sh --no-patch` を、当てた `06c817cc` の上で実行し全部通過**（`patches-to-09/run-09-on-06c817cc-pinned-c27b95eb.log`）：kernel 43、bridge10 26（fmt・clippy 込み）、⑨の kernel 上の⑩のアダプター 17（`nine-refused`）。

### ④へ：core の差分 `patches/0001–0013`

| 確認 | 結果 |
|---|---|
| `4cd901de` に順に当てる | tree `5ac4d339…`（`workstream/10-custody-core-v26` @ `1624d14a`）と一致 |
| ⑱の先端 `0bba3f31` に `git am -3` | 全部当たる。`unverifiable` は⑱の 1 つ |
| ④の統合候補 | 0002（ABI の表）でエラー 94 が衝突する（[11](11-abi-request-04.ja.md)）。番号は④の割当待ち |

⑨の kernel の 0003（④向け、ClaimSplit など）は⑩は触っていない。

## 4. 残件

| # | 相手 | 内容 |
|---|---|---|
| 1 | ⑨ | `patches-to-09/0002` の取り込み（pin だけ） |
| 2 | ④ | ABI の番号と版の割当。割当の後、⑩は 0002–0013 を作り直す |
| 3 | ⑩ | V26 の命令ごとの再生（割当の後） |
| 4 | ④・⑱ | ⑱の期待値の試験に custody の 11 命令を足す |
| 5 | 所有者 | 混合材料（`MixedSource`）、区画に木材・兵器を入れるか、倉の押収での区画の扱い。どれも決めていない |
