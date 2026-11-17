# ② 第3回：PS2 記録と検証器対応（隔離候補）

**状態：** 隔離した候補。採用・統合・配備はしていない。StockSwap の正式採用、占領時の所有権、設備能力の貸与は決めていない（`HANDOFF.ja.md` §0、§5）。
**起点：** GitHub に保存された `dc3bd3d93465eebb65f1815eb702ca779cc31827`（`preserve/ws02-rights-dc3bd3d`）。
**ブランチ：** `ws02/ps2-verifier-candidate`（ローカル、未 push）。

## 1. 扱った二つの問題

| 問題（第2回で再現） | この候補での扱い | 確かめたテスト |
|---|---|---|
| 交換が記録なしで村を書くため、V7 が `HoldingReplayMismatch` で FAIL する | 全命令が記録を一つ出す。V7 は、Grant 命令が書いた村を、記録の量（touch なしの settle、その後に pay または credit）から組み立て直す | `the_honest_flow_adds_no_finding`（正しい流れは新しい指摘を出さない）、`an_amount_the_holdings_did_not_move_fails` |
| Grant だけの操作（発行・閉鎖など）を検証器が見逃す | 新しい検査 VR が、Grant 命令・記録・Grant 口座・未知の口座を突き合わせる | `an_issue_without_its_record_is_not_invisible`（第2回の見逃しが FAIL になる） |

**不正・未知・証拠不足を PASS にしない：**

| 場合 | 結果 | テスト |
|---|---|---|
| 記録がない | FAIL `RightsRecordMissing`、V7 も FAIL | `a_missing_record_fails`、`an_unrecorded_swap_still_fails_holding_continuity` |
| 規則が拒む記録（seq など） | FAIL `RightsRule` | `a_record_the_rules_refuse_fails` |
| 記録と食い違う Grant 口座 | FAIL `RightsStateMismatch` | `a_grant_account_unlike_its_records_fails` |
| 記録と食い違う村の書き込み | FAIL `HoldingReplayMismatch`（V7） | `an_amount_the_holdings_did_not_move_fails` |
| 命令のない記録 | FAIL `RightsRecordOrphan` | `an_orphan_record_fails` |
| 未知の命令（権利の区画の未定義タグ）、未知の種類の program 口座 | FAIL `UnknownInstruction`、`UnknownAccount` | `an_unknown_instruction_or_account_fails` |
| 事後状態がない（証拠不足） | UNVERIFIABLE（`MissingData`）。判定は PASS にならない | `missing_evidence_is_never_a_pass` |
| 記録済みの既存 fixture（4本） | VR の指摘なし（誤検出なし） | `vr_finds_nothing_on_the_recorded_fixtures` |

**検査の検査：**
- `mutate-vr` で VR を外すと、VR に依存する10件のテストが検出しなくなる。
- `mutate-v7` で V7 を外すと、V7 に依存する3件のテストが検出しなくなる。
- どちらの検出器も、実際に役目を果たしている。

## 2. 実装

| 部分 | 内容 | ファイル |
|---|---|---|
| ABI | 記録の種類 6 つを共有の v2 ログ表に追加。番号 200–205 は**仮**。CQ1 が記録をこの表でしか読めないため。各記録が chain する entity の表（`chains_of`）も追加：発行は issuer の Citizen、予約・実行は grantee の Citizen と受取口と施設、解放は戻した村だけ、取消は issuer と戻した村、閉鎖はなし。同じ種類の任意リンクは区別できないので、任意（optional）のリンクは使わない | `frontier-abi/src/v2/log.rs`、`frontier-abi/src/v2/rights.rs`（`record` モジュール：payload の符号化と解読） |
| プログラム | 6 命令すべてが記録を一つ出す（`events::emit_v2`）。記録の幅の表の上限を 205 に上げた（`events::MAX_KIND_V2`、`cqlog::MAX_KIND`） | `permutation-frontier/src/proc/rights.rs`、`events.rs`、`proc/conquest.rs` |
| 検証器 | 検査 VR（名前は仮）と、V7 の Grant 用の分岐。コード：`RightsMalformed`、`RightsRecordMissing`、`RightsRecordOrphan`、`RightsRule`、`RightsStateMismatch`、`RightsUnexplainedAccount`、`UnknownAccount`、`UnknownInstruction` | `frontier-node/crates/verify/src/checks/vr_rights.rs`、`v7_replay.rs`、`mod.rs`、`codes.rs`、`Cargo.toml`（feature `mutate-vr`） |
| 網羅的な match | fclient の `conquest::parse` と herald の fold に、新しい種類を「征服の事象ではない」として明示する分岐を追加（ワイルドカードは使っていない） | `fclient/src/conquest.rs`、`herald/src/conquest.rs` |

## 3. 番号と版の照合（④⑧⑩、参考に⑨⑱）

確認した commit：
- ④：`preserve/ws04-a967f5f1`
- ⑧：`preserve/ws08-cont-verify-b519cd18`（`ws08-continuous-e3d773df` と `ws08-persistence-ca67d40e` も読んだ）
- ⑩・⑱・⑨：`integration/ws09-13-v16-d0949fd4`（`ef63544c`）

②の番号は、すべて**統合時に再確認する割当案**のまま。

| 種類 | ②（この候補） | ⑧ | ⑩ | ⑨（提案） | ⑱ | 判定 |
|---|---|---|---|---|---|---|
| 命令タグ | 0xD0–0xD5（v2 の表の外で振り分け） | 0xC1 | 0xC1–0xCB | 0xC1–0xCE | なし | 数の衝突なし（0xC1 の衝突は⑧⑨⑩の間） |
| 記録の種類 | 200–205（共有表に追加） | 104 | 104–112 | — | なし | 数の衝突なし。**上限の定数**（`MAX_KIND`・`MAX_KIND_V2`）は文字が衝突する：②は 205、⑧は 104、⑩は 112。値は最大のものにすればよい。`CQ_SPECS` の件数の試験（②は 29）も、足し合わせが要る |
| エラー | 200–213（独自の `RightsError`、`codes_are_the_contract_table` の外） | 94 | 94–98 | 24–27（⑨の核の中） | なし | 衝突なし。ただし⑩の案 (a)「100 以上」が 200 番台を選べば重なる |
| AccountKind | **なし**（独自の magic `PSF2GRNT`）。第2回の「採用時に 23」は**撤回**：⑩が 23 Lot を使う | なし | 23 Lot | — | なし | 衝突を避けた |
| EntityKind | なし（Grant は chain しない） | なし | 13 Lot | — | なし | 衝突なし |
| seed | `gr` | なし | `cl` | — | — | 衝突なし |
| 検証器の検査名 | `VR:rights`（V 番号を使わない） | — | V26 | — | V0 | 衝突なし |
| 検証器のコード | `UnknownInstruction` は⑱と同じ名前・同じ意味 | — | — | — | `UnknownInstruction` ほか | ⑱の後に入れるなら、②の定数と代替の分岐を消す（§4 の adapter） |
| プログラム版 | 変えない（4） | 変えない | preview で 5 | — | 既知の版を 1–4 に固定 | ②は 4 のまま。版の判断は統合側（`06-EVENTS.ja.md` §5） |
| ④の registry | `program_version_s1 = 4` と一致 | | | | | — |

## 4. ④へのパッチ

| パッチ | 当てる先 | 内容 |
|---|---|---|
| `patches/v1/0001–0004` | `4cd901de` | 第2回までのコア・host の実行環境・再現・LiteSVM（既存） |
| `patches/v2/0001` | v1 の後 | 記録（ABI・プログラム・host テスト） |
| `patches/v2/0002` | その後 | 検証器 VR・V7・fclient・herald・テスト |
| `patches/v2/0003` | その後 | テスト fixture の修正（書込み可能な全口座を事後状態に載せる） |
| `patches/v2/after-ws18/0001-adapter-to-ws18-v0.diff` | ⑱の V0 を含む枝で、v2 の後 | ②の `UnknownInstruction` 定数と代替の分岐を消す。⑱の V0 が、S1 シーズンでは Grant タグを VR に渡す（それ以外では未知として FAIL） |

**当てた結果（ビルドと署名なしのテストで確認）：**

| 当てた先 | 結果 |
|---|---|
| `4cd901de` + v1 + v2 | 全部当たる。ブランチ `41bacca` と同じコードになる |
| ⑧ `b519cd18` + v1 + v2 | v1 は当たる。v2/0001 は `log.rs`・`events.rs`・`proc/conquest.rs` で衝突する（上の上限定数と、表の末尾の追記） |
| 統合 `ef63544c` + v1 + v2 + adapter | 全部当たる。ビルドは通る。②の検証器テスト 12 件と⑱の V0 の単体テストは通る。**adapter なしでは**、定数の二重定義でビルドが通らない |

## 5. 生成物の扱い（未実施、④の作業）

- 新しい種類で `frontier-abi/vectors/v2/logs.json` が古くなる（`abi-vectors -- --check` が「stale: v2/logs.json」）。そこから作る web SDK（`abi-v2-logs.mjs`）も同じ。
- ⑧⑩も同じ表を変えるので、②では作り直していない。統合の後に、④が `scripts/cq-regen.sh` で一度に作り直す。それまで CI の `abi-vectors --check` は失敗する。

## 6. 検証の範囲

**鍵の生成・導出・署名を伴う試験は実行していない。**
- **検証器のテスト：**
  - 取引は署名なし。メッセージの前に、取引ごとに違う置き換えバイトを置いただけ（検証器は署名を確かめない）。
  - 口座の鍵は、記録済み fixture の 32 バイト値をそのまま使った。
  - 第2回の `rights_replay.rs` は鍵を使って署名していた。それを、この版で**置き換えた**。
- **プログラムの host テスト：** 固定の 32 バイト値だけを使う。署名の判定は `is_signer` フラグだけ。
- **実行していないもの：**
  - LiteSVM・SBF・svm-tests の全件
  - 各 crate の全件テスト（beacon・BLS のテスト鍵を使うものを含むため）
  - ⑱の統合テスト群（署名の有無を確かめていない）

| 実行したもの | 結果 |
|---|---|
| `permutation-frontier` の rights（39 件：新しい 4 件を含む）、`events::`（4 件） | 通過 |
| `frontier-abi` の `v2::rights`（5 件）、`v2::log::`（5 件。全種類の entity 表を含む） | 通過 |
| `verify --test rights_replay`（12 件） | 通過（②の枝でも、統合 + adapter でも） |
| `verify --features mutate-vr`／`mutate-v7` | 依存するテストが検出しなくなる（10 件／3 件） |
| fmt、clippy `-D warnings`（`permutation-frontier`、`frontier-abi`、`verify`、`fclient`、`herald`）、frontier-node の全 workspace の `cargo check`、svm-tests の `cargo check` | 通過 |
| `abi-vectors -- --check` | `v2/logs.json` が stale（想定どおり。§5） |

**この候補で実証していないこと：**
- **プログラムが本当に出した記録を、検証器が読むこと。** 検証器のテストの記録と事後状態は、テストが共有 ABI と検証器の村の符号化で組み立てた。プログラム側が同じ符号化で出すことは、host テストで確かめた。二つをつなぐ本物の記録（ローカルチェーンでの SBF 実行）は、署名を伴うので実行していない。
- **基準の土台：** M1 の記録済み季節を、S1 の設定にして、施設に武具 100 を足したもの。差分だけを判定している。土台そのものにある指摘（CQ2 の `SeasonIdentity` が取引ごとに 1 件）は、テストの中で明示して除いた。

## 7. 残件

1. **番号の確定**：tag・記録の種類・エラー・検査名。④が統合の時に決める。
2. **生成物の作り直し**（§5）。
3. **⑱の後に入れる場合は adapter を当てる。** ⑧と同時なら、上限定数と表の末尾を手で合わせる。
4. **本物の記録での再生の確認**：SBF のビルドとローカルチェーンでの記録。署名を伴うので、対象と準備を事前に確認してから実行する。
5. **未決定のまま**：StockSwap の採用、占領時の預かりの所有権、凍結した預かりの扱い、設備能力の貸与（⑨）、セッションの委任範囲、プログラム版。
