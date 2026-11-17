# ② 第4回：④・⑪を含む検証器との照合（隔離候補）

**状態：** 隔離した候補。採用・統合・配備はしていない。StockSwap の採用、委任の範囲（セッションに何を任せるか）、占領時の所有権、設備能力の貸与は**決めていない**。
**ABI の番号はすべて仮。** 統合の時に④が決める。対象は、命令タグ 0xD0–0xD5、記録の種類 200–205、エラー 200–213、検査名 `VR`、各コード名、seed `gr`。
**起点：** `2c58034a011ce5cfd31c11b4eea375db7dc5ad52`（第3回）。ブランチ `ws02/ps2-verifier-candidate`（ローカル、未 push）。

## 1. 照合した版

| 担当 | commit（完全 SHA） | 検証器の中身 |
|---|---|---|
| ④ | `77c5cbe2398c89559417f8cf18d4065b51455ee6` | `ef63544c`（⑨–⑬・⑱を統合した版）に、gateway と④の文書を足したもの。**検証器のコードは `ef63544c` と同じ**。⑱の V0 と、⑪の 0003（V7 で Holding の欠けを UNVERIFIABLE にする）は入っている。⑪の 0004・0005 は入っていない |
| ⑪ | `c8d694bd2b3ac4a08e3ad5633bf1d8b623be32f8` | branch に入っているのはパッチと文書だけで、コードは `4cd901de` のまま。⑪の README の指示どおり、④へは **0004 → 0005** の順で当てる。<br>SHA-256：<br>• 0004：`258ad759…dd21660`<br>• 0005：`09beb7bc…4067639`<br>どちらも README の値と一致した |

**照合に使った検証器：**
1. `77c5cbe2`
2. ⑪の 0004 と 0005
3. ②の全パッチ

⑱向けの adapter（`after-ws18`）が扱うのは、⑱の V0（未知の命令）との重なり**だけ**である。⑪のログ欠落対策（V0E）を確かめたことにはならない。そこで、ここでは⑪の V0E を実際に当て、②の場面で V0E 自身の指摘が出ることを試験で確かめた（§3 の最後の行）。

## 2. 第4回で直したこと

### 2.1 試験の判定が、何も証明していなかった（第3回の不備）

基準に使った fixture は「M1 の季節を S1 として判定したもの」で、**それ自身の判定が FAIL** になる（V2 の `RulesetMismatch` と V7 の指摘を含む）。そのため、第3回の試験にあった次の判定は、どちらも空の確認だった。
- `verdict != Pass`
- `verdict == Fail`

差分の指摘を見る判定は有効だった。今回、次のように改めた。
- 「PASS にならない」の確かめ方を、**変更そのものが FAIL か UNVERIFIABLE を一つ以上足すこと**（CQ2 の artefact は除く）に変えた（`not_a_pass_by_itself`）。
- 基準が FAIL であることは、試験 `the_base_is_not_a_pass_so_verdicts_alone_prove_nothing` で明示した。

### 2.2 ⑪の規則と食い違わないようにした

⑪の規則は「証拠が欠けた取引は FAIL ではなく UNVERIFIABLE」である。VR と V7 を、⑪の V0E がなくても同じ結論になるように直した（`patches/v3/0001`）。

| 場合 | 第3回 | 第4回 |
|---|---|---|
| Grant 命令に記録がなく、ログが切られている。次のどれか：<br>• `Log truncated` がある<br>• `success` の行がない<br>• program の起動がログにない | FAIL `RightsRecordMissing` と V7 の FAIL。<br>同じ Grant の後の記録も、`RightsRule` で誤って FAIL になる | VR は UNVERIFIABLE（`MissingData`）。<br>その Grant は、欠けた所から後を判定しない。<br>V7 も UNVERIFIABLE |
| 同じ取引で、ログが完全 | FAIL | **FAIL のまま**（`whole_logs_without_the_record_still_fail`） |
| Grant 命令が CPI で呼ばれた（`invoke [n]`、n > 1）。記録はある | FAIL `RightsRecordOrphan` | VR は UNVERIFIABLE。<br>V7 は、書かれた村を FAIL のまま扱う（最上位の命令で説明できない書込み。V7 の既存の扱いで、変えていない） |
| CPI の取引で、ログがない | FAIL `RightsUnexplainedAccount` | 変わらない（FAIL） |
| Grant 命令が書込み可能にした program 口座（Citizen、村）に、事後状態がない | **⑪がなければ見逃し（PASS の経路）**：Citizen の事後状態を落としても、何も指摘しなかった | VR が UNVERIFIABLE とする（⑪の V0E の `MissingPostState` と同じ規則を、自分の命令に適用する） |

## 3. 誤って PASS にしないことの確認

すべて署名なしの試験。各場合は「変更そのものが FAIL か UNVERIFIABLE を足す」ことで確かめた。

| 場合 | ②だけ（④＋②） | ④＋⑪＋②（照合の対象） | 試験 |
|---|---|---|---|
| 未知の命令（`0xD9`）、未知の種類の program 口座 | FAIL：⑱の V0 の `UnknownInstruction` と VR の `UnknownAccount` | 同じ | `an_unknown_instruction_or_account_fails` |
| CPI（ログあり／なし） | UNVERIFIABLE と V7 の FAIL ／ FAIL | 同じ。加えて V0E の `UnverifiedInnerInstruction` ／ `MissingLogs` | `a_grant_instruction_reached_by_cpi_is_never_a_pass` |
| 記録の欠落（ログは完全） | FAIL | 同じ | `a_missing_record_fails`、`whole_logs_without_the_record_still_fail`、`an_issue_without_its_record_is_not_invisible` |
| 記録の欠落（ログが失われた。3通り） | UNVERIFIABLE（VR と V7 は FAIL を出さない） | 同じ。加えて V0E の `TruncatedLogs`・`IncompleteLogs`・`MissingLogs` | `a_grant_record_lost_with_the_logs_is_unverifiable_never_a_pass` |
| 命令のない記録 | FAIL | 同じ | `an_orphan_record_fails` |
| 事後状態の不足：Grant | UNVERIFIABLE | 同じ。**V0E は Grant を知らない**（`AccountKind` の magic だけを読む）。そのため VR だけが見ている | `missing_evidence_is_never_a_pass` |
| 事後状態の不足：村、Citizen | FAIL または UNVERIFIABLE | 同じ。加えて V0E の `MissingPostState`（Citizen） | `post_states_short_of_the_writes_are_never_a_pass` |
| ⑪の V0E が②の場面で実際に働くこと | — | 確認した | `with_v0e_each_lost_evidence_case_has_its_own_finding`（`patches/v3/after-ws11` だけにある） |

**検査の検査：**

| 外した検査 | 照合の対象で | ②だけで |
|---|---|---|
| VR（`mutate-vr`） | 18 件中 15 件が検出しなくなる | 17 件中 14 件 |
| V7（`mutate-v7`） | — | 17 件中 6 件 |

## 4. ④へのパッチと適用順

④の `77c5cbe2` に当てる。最小のパッチは一つにまとめた。

| 順 | パッチ | 内容 |
|---|---|---|
| (1) | ⑪の `0004-verify-v0e-evidence-is-unverifiable.patch` | ⑪の作業。②の範囲ではない |
| (2) | ⑪の `0005-verify-v0e-cpi-only-and-lost-tail.patch` | ⑪の作業 |
| (3) | **`patches/for-ws04/0001-02-rights-candidate-on-77c5cbe2.diff`**（SHA-256 `9de92287…fee3fe0a`） | ②の最小パッチ。次を一つにまとめた：<br>• v1/0001–0003<br>• v2/0001–0003<br>• `v2/after-ws18/0001`（⑱の V0 への adapter）<br>• `v3/0001`<br>LiteSVM の試験（`v1/0004`、`svm-tests/tests/rights.rs`）は含めない（署名を伴い、実行していない） |
| (4) | `patches/v3/after-ws11/0001-test-rights-with-ws11-v0e.diff` | (1)(2) があるときだけ当てる。試験 1 件 |

**順序の確認：**
- 次の二つの順で当て、**同じ tree** `29a5dc6db188e814ecbb0f3759b08cc46d60854c` になることを確かめた。
  - (1)(2)(3)(4) の順
  - (3)(1)(2)(4) の順（②を先に当てる）
- ⑪を当てない場合は、(3) だけを当てればよい。
- 分けたパッチの列（v1 → v2 → after-ws18 → v3）も、`77c5cbe2` にそのまま当たる。

**③と⑧⑩との関係：** 第3回の §3 と同じ。上限の定数（`MAX_KIND`、`MAX_KIND_V2`）と表の末尾は、⑧⑩と同時に入れるなら手で合わせる。生成物 `v2/logs.json` は④が作り直す。

## 5. 検証の範囲

**鍵の生成・導出・署名を伴う試験は実行していない。**
- 照合の対象の検証器にある試験のうち、次の二つは `Keypair` を作って署名する。どちらも**実行していない**。
  - ⑱の `coverage.rs`
  - `record.rs`
- `rights_replay.rs` は試験の共通部品（`common`）を読み込む。ただし、鍵を作るローカルチェーンの関数（`world`、`send`）は呼ばない。
- ⑪の `evidence.rs` と `missing_state.rs` に、鍵も署名もないことを確かめてから実行した。

**照合の対象の tree `29a5dc6d` で実行したもの：**

| 実行したもの | 結果 |
|---|---|
| `verify` の lib（13 件） | 通過 |
| `verify` の `rights_replay`（18 件） | 通過 |
| `verify` の `evidence`（⑪、8 件） | 通過 |
| `verify` の `missing_state`（⑪、2 件） | 通過 |
| fmt、clippy `-D warnings`（`verify`・`fclient`・`herald`） | 通過 |
| frontier-node の全 workspace の `cargo check` | 通過 |
| `permutation-frontier` の rights（39 件）と `events::`（4 件） | 通過 |
| `frontier-abi` の `v2::`（46 件） | 通過 |

**②の branch（`4cd901de` が基準）で実行したもの：**

| 実行したもの | 結果 |
|---|---|
| `rights_replay`（17 件）、lib | 通過 |
| fmt、clippy | 通過 |

**実証していないこと（第3回と同じ）：**
- プログラムが本当に出した記録を、検証器で再生すること（SBF とローカルチェーン。署名を伴う）
- 基準の fixture は、M1 の記録を改めたもの

## 6. 残件

1. 番号の確定（すべて仮）。④が決める。
2. ⑪へ伝えること：
   - V0E の `known` は `AccountKind` の magic だけで口座を数える。そのため、②の Grant（独自の magic `PSF2GRNT`）は数に入らない。②を採用するなら、V0E が Grant も数えるか、VR に任せるかを決める。今は VR が見ている。
   - V0E の `only_closes` は `CloseGrant` を「閉じる命令」と認めない。これは安全側で、PASS の経路ではない。
3. CPI で書かれた村について。V7 は FAIL とする（UNVERIFIABLE ではない）。これは V7 の既存の扱いで、②の範囲では変えていない。⑪の規則に揃えるかどうかは、④・⑪・⑱が決める。
4. 未決定のまま：StockSwap の採用、委任の範囲、占領時の所有権、設備能力の貸与、プログラム版。
