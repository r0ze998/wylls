# 08 ホスト試験で確かめた範囲と、オンチェーンの保証の区別（r3）

**結論: オンチェーンで保証されていることは、この担当の成果にはまだ一つもない。** 下の「ホスト」は Rust の試験で確かめたことで、Solana のランタイム（署名検証、口座の所有と書込権限、CU、取引の大きさ、ログの切り詰め）を一切通していない。「既存の検証器」は基準 commit の `frontier-node/crates/verify` に記録済みの fixture を与えた結果で、これもチェーンを動かしていない。

案 B、Burn、運営の停止権限は**採用していない**（2026-10-30 の指示）。以下は「採用するならこう動くはず」の試作の性質である。

## 1. 拡張の試作（`ext-kernel`）

| 性質 | ホストで確かめたこと | オンチェーンで成り立つために要ること（未実施） |
|---|---|---|
| 未知・不足を PASS にしない | 2 つの正直な履歴に 1,254 個の改変（記録の削除・重複・入替、各欄、manifest の全 byte、証拠の各部分の欠落）を加え、PASS は 0（`n01`）。知らない版・語彙、欠けたデータは FAIL ではなく UNVERIFIABLE（`n02`、`v03`） | 検証器に渡す archive（記録、前後の状態、登録の履歴、Grant の更新）を、チェーンから欠けなく取り出す索引。ログの切り詰めで receipt が欠けないこと（未測定） |
| 返却は一度だけ、資源は閉じ込められない | 出口は「停止」「利用者の Grant の終了」「コアの版の変更」のどれかで開き、返却後に instance を閉じる（`e01`–`e05`）。利用者・作者・時間の 7 種の操作の 5 手の全組合せ 16,807 通りで、毎手 Holding＋預かり＝最初の量、最後に利用者だけの操作で全量が戻り、第三者の再実行は PASS（`e06`、出口 578 回・fulfil 794 回を含む） | ExtWithdraw 命令と instance の closed 欄の実装、口座の所有と署名の検査（[patches/0002](patches/0002-core-extension-instructions.md)） |
| 分割書込み | 未完成・1 byte の欠落・5 片の 120 通りの順序・同じ片の重複・既存の byte を変える片・違う内容・正しい hash の不正な manifest・他人の buffer・範囲外を扱い、hash の確認と公開の検査を通るまで登録されず、その id の呼出しは `NotRegistered`（`b01`–`b07`） | 1,232 B の取引に載る片の大きさ、buffer 口座の rent、片の書込命令の CU（未測定） |
| 継続世界（r4） | 期間の境界 4 種（変化なし・規則の変更・Holding の作り直し・Holding の一時的な不在）、再起動と再送、30 年の空白、20,000 回の呼出しを 10 窓に分けた検証、時刻・seq・欄の上限、2,001 人目の拒否（`c01`–`c06`、`g01`–`g04`） | 拡張の口座の根を期間で変わらないものにし、ExtWithdraw を期間の状態で拒否しない実装（④）。コアの CloseHolding（終了 72 時間後）を継続世界でどう扱うか（④・⑩） |
| 決定性・保存則・権限 | 前回までの `f01`–`f03`、`r01`–`r11`、`v01`–`v04` | 同上 |

## 2. 既存の再生検証器（共有コア、パッチは未適用）

| 入力 | 基準 commit の検証器 | パッチを当てた後（一時 worktree） | パッチ |
|---|---|---|---|
| 成功した取引に知らないタグの Frontier 命令 | **PASS** | UNVERIFIABLE（V2 `MissingData`） | 0001 |
| Frontier を別のプログラムの中から呼んだ取引（CPI。message の最上位は別のプログラム、ログは `invoke [2]`）、135 取引を 1 つずつ | 確認した取引（tx#0）は **PASS**（V2 の警告のみ） | 135 件すべて UNVERIFIABLE か FAIL、すべて V2 `MissingData` | 0001 |
| Holding の post-state を 1 つ落とす（fixture の 8 個を 1 つずつ） | 確認した例（tx#88）は **PASS** | 8 件すべて非 PASS（V7 `MissingData`） | 0003 |
| post-state のない archive（公開 RPC 由来） | UNVERIFIABLE（ただし V11 の切符の検査が理由で、V7 は黙って戻る） | V7 も `MissingData` を出す | 0003 |
| 既存の試験（lib 12、camp_clear 3、fixtures 9、tamper 58、unit 8） | 通過 | 通過（追加の 5 件も通過、計 95） | — |

ログ: `results/verify-before-r3.log`、`results/verify-after-r3.log`。探索用の試験は `results/ws11_probe.rs.txt`。

## 3. 残る未確認の範囲（パッチを当てても）

**CPI について**
- パッチ 0001 は「CPI で呼ばれた」ことを UNVERIFIABLE にするだけで、内側の命令を判定しない。判定するには、索引が `meta.innerInstructions` を保存し、検証器が内側の命令を集める必要がある（③ [patches/0002](https://github.com/r0ze998/wylls/blob/2f8ec700/workstreams/03-composability/patches/0002-verify-inner-instructions.md)、未実装）。
- 判定はログの `Program <id> invoke [n]` の行による。ログが切り詰められた取引（ログの上限を超えた場合）では CPI を見落としうる（未測定）。
- message の最上位の命令が別のプログラムなのに、ログが Frontier を深さ 1 で示すような「ありえない archive」は、パッチ後も PASS になりうる（探索用試験で 134 件 PASS）。実際のチェーンからは生じないので、archive の真正性（RPC・索引の信頼）の問題として残す。既存の検証器は署名を再検査しない設計（`tamper.rs` 179–181 行）。

**V7 について**
- パッチ 0003 が見るのは Holding だけ。Province、Citizen、Caravan などの post-state の欠落について、同じ網羅の確認はしていない（V7 の Province 側には `has_post` のときの `missing` がある：`v7_replay.rs` 467、641 行）。
- Holding だと分かるのは、archive のどこか（post-state か最終状態）にその口座の Holding の内容がある場合だけ。両方とも欠けた Holding は見分けられない。
- 1 つずつ落とす網羅を確かめた fixture は land の 1 つ（Holding の post-state 8 個）だけ。march の fixture（`march-program`、`march-synth`、w6s7 の 2 つ）では、パッチを当てても既存の試験が通ることだけを確かめた。`fixtures/verify/` に S1（隊商・金庫・建物）の fixture はなく、S1 の Holding 書込についてはパッチの効果を確かめていない。
