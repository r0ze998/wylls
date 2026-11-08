# 12 検証器の残件: CPI・途中で切れたログ・Holding 以外の口座・証拠不足（r5、2026-11-05）

**対象。** 統合ブランチの先端 `integration/ws09-13-v16-d0949fd4`（commit `d0949fd4`、2026-11-05）。ここでは⑪のパッチ 0003（V7 の Holding）が適用済みで、⑱の V0（`checks/v0_coverage.rs`）が入っている。

**0001 は再適用しない。** ⑱の V0 は、知らないタグの成功した命令を **FAIL**（`UnknownInstruction`: 固定したプログラムはそれを拒否するので、成功したなら別のプログラムが動いた）とする。⑪の 0001 はこれを UNVERIFIABLE としていたので食い違う。⑱の判定を正とし、0001 の「知らないタグ」の部分は取り下げた。0001 のもう一方（CPI）は V0 が扱っていない（V0 は最上位の命令だけを見る）ので、新しいパッチ 0004 で扱う。

## 1. 調べたこと（統合の先端、修正前）

記録済みの fixture（`land`、`march-program`）の 1 取引または 1 口座だけを変えて、検証の結果を数えた（`results/verify-evidence-before-r5.log`、探索の記録は `results/verify-probe-r5.log`）。

| 証拠の欠け方 | 修正前に PASS になった数 | 既にあった扱い |
|---|---|---|
| Frontier が別のプログラムの中から呼ばれた（CPI。message の最上位は別のプログラム、ログは `invoke [2]`） | **140 件中 137 件** | V2 の警告だけ。V0 は最上位だけを見る |
| 実行時にログが切られた（`Log truncated`） | **345 件中 141 件** | なし（検証器にも fclient にも切れたログの扱いがない） |
| 成功した呼出しのログがまるごと無い | **345 件中 141 件** | 連鎖する記録を書く命令だけ V1 が FAIL（ChainGap）。PostBeacon・PostSeed などは PASS |
| Holding 以外のプログラム口座の post-state を 1 つ落とす | **72 件中 33 件**（Citizen、Frontier、JoinShard、Province、ProvinceFund、Season、RingSeed の一部） | Holding は 0003（V7）だけ |
| 連鎖しない口座（BeaconLog、SeedCache など）の最終状態を落とす | PASS | **穴ではない**: どの検査もその最終状態を読まないので、落としても判定されていたものは隠れない。連鎖する口座（Citizen、Province、Holding、Season など）の最終状態の欠落は既に V1 が UNVERIFIABLE |

## 2. 直したこと（パッチ 0004、未適用、統合の先端に当たる）

⑱の V0 の考え方（固定したプログラムが拒否するはずのものは FAIL、判定できないものは UNVERIFIABLE）に合わせ、**判定に要る証拠**を見る検査 V0E（`checks/v0_evidence.rs`）を足した。⑱の V0 の検査と試験（`coverage.rs` は V0 の所見の一覧を完全一致で見る）には手を入れない。

| コード（すべて UNVERIFIABLE） | 条件（成功した取引） |
|---|---|
| `MissingLogs` | 最上位でプログラムを呼び、ログにプログラムの呼出しが一行もない（切られたのでもない） |
| `TruncatedLogs` | プログラムを呼び、ログに `Log truncated` がある |
| `UnverifiedInnerInstruction` | ログに `Program <id> invoke [n]`（n > 1）がある。内側の命令は archive に無い |
| `MissingPostState` | post-state のある archive で、既知のプログラム口座（Holding 以外。Holding は V7）を書込可で持ち、その post-state が無い。**post-state が一つも無い取引は、命令がすべて `Close…` なら報告しない**（記録済みの `march-program` で CloseArrivalDay・CloseArrivalSlot の 90 取引が post-state なしで記録されている。口座を閉じる取引の記録の仕方で、偽の陽性になった） |

**FAIL にしない理由。** プログラムは CPI で呼ばれてよく（`top_level_only` でない命令）、ログが切れても取引は正しく動いている。証拠が無いだけなので「検証できない」と言う。

### 結果（`results/verify-evidence-after-r5.log`）

| 証拠の欠け方 | 修正後に PASS になった数 |
|---|---|
| CPI | 140 件中 **0** |
| 切れたログ | 345 件中 **0** |
| ログ無し | 345 件中 **0** |
| Holding 以外の post-state の欠落 | 72 件中 **0** |

既存の試験もすべて通過: lib 13、unit 8、tamper 58、fixtures 9、camp_clear 3、missing_state 2（0003）、coverage 5（⑱。知らないタグは FAIL のまま）、open_items 3、追加の evidence 5、計 **106 件**。記録済みの 3 fixture は PASS のままで、V0E の所見は出ない。`cargo fmt --check` と `cargo clippy -p verify --all-targets --no-deps -D warnings`（Rust 1.95.0、CI と同じ）通過。

## 3. 直していないこと・できないこと

| 残り | 理由 | 誰 |
|---|---|---|
| CPI の内側の命令の**判定** | 索引が `innerInstructions` を保存し、検証器が内側の命令を集める必要がある（③のパッチ 0002）。V0E は「判定できない」と言うまで | ③・④ |
| `post-state` の無い closer の取引 | 記録の仕方を変えるか（closer にも `None` の post-state を書く）、例外のままにするか | ④（索引・localnet） |
| 連鎖しない口座の最終状態の照合 | その種類の再生モデルが無い（V0 の `supported` と同じ範囲の問題） | ⑱・④ |
| 継続世界での検証（静かな終わりが無い） | ⑬の `open_items.rs` が現状を記録済み。窓ごとの検証は④の提案 | ④・⑧ |
| **統合の先端で `cargo clippy --workspace -D warnings` が通らない** | `crates/keeper/src/journal.rs` 431・464 行の `type_complexity`（Rust 1.95.0 の clippy）。⑪は触っていない。CI の frontier-node の job はこの検査を workspace 全体で行う | 統合担当 |

## 4. 0001・0003・0004 の扱い

| パッチ | 状態 |
|---|---|
| 0001（V2: 知らないタグ・CPI を UNVERIFIABLE） | **再適用しない。** 知らないタグは⑱の V0 の FAIL が正。CPI は 0004 が置き換える |
| 0003（V7: Holding の post-state の欠落） | 統合の先端に適用済み |
| 0004（V0E: 証拠の欠落） | 新規・未適用。`d0949fd4` に `git apply --check` で当たる |
