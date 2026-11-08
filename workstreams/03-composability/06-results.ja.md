# 06 テスト結果と測定

実行日 2026-10-29、この作業機（Linux、4 コア）。Agave 3.1.9（cargo-build-sbf、platform-tools v1.52）、Rust 1.95.0（試験）／1.89.0（SBF の内部）、LiteSVM 0.16.0、Node 22。Frontier の SBF ビルドは `scripts/build-frontier.sh`（release: `file_sha256 2bbc1557…7ad`、`so_len 1,392,304`、deployable yes。test-beacon: `so_len 1,392,824`、deployable no）。courier: 通常版 54,576 B（`sha256 53e5a9c8…983f`）、hostile 試験版 57,288 B。ログは [results/](results/)。

実行の種類:
- **実チェーン（LiteSVM）**: 両プログラムの SBF ビルドを LiteSVM 0.16 で実行（署名検証あり、実際の CPI、ランタイムの権限検査、ハーネスの SIMD-0186 強制）。時間経過の部分は明記して作り込む。
- **ローカル validator**: `solana-test-validator` 3.1.9（ローカル）。
- **模擬**: relay の判定関数を直接呼ぶ。チェーンなし。
- **チェーンなし**: 表の生成、ホストの単体試験。

## 1. 必須テストと結果

| 必須項目 | 試験 | 種類 | 結果 | 拒否した層とコード |
|---|---|---|---|---|
| 正当な署名 | `t01_signed_send_through_the_courier_equals_the_direct_call` | 実チェーン | **通過** | — 着地。書込先5口座が直接呼出しとバイト単位で一致、出発元の減算は1回 |
| 署名なし | `t02_unsigned_or_wrong_signer_is_refused_by_the_core` | 実チェーン | **通過** | Frontier `Auth`（actor が署名しない／他人が actor） |
| 署名なし（水増し） | `t11_a_hostile_wrapper_cannot_go_around_the_core`（3） | 実チェーン、hostile 版 | **通過** | ランタイム `PrivilegeEscalation` |
| 他人の出発元 | `t03_someone_elses_source_is_refused` | 実チェーン | **通過** | Frontier `NotOwner`（他人の Holding）、`Auth`（他人の wallet） |
| 権限不足 session | `t04_session_key_limits_hold_through_the_courier` | 実チェーン | **通過** | Frontier `WalletRequired`（他人宛）、`Auth`（session でない鍵）、`SessionExpired` |
| 権限不足（委任） | `t13_delegation_limits` | 実チェーン | **通過** | courier `CargoOverCap`、`MandateExhausted`、`MandateExpired`、`MandateMismatch`／Frontier `WalletRequired`、`Auth`（所有者が SetSession で戻した後）、`SessionExpired` |
| 誤った PDA・所有プログラム | `t05_wrong_pda_or_owning_program_is_refused` | 実チェーン | **通過** | Frontier `BadAddress`（Caravan の seq 違い、Frontier 所有の Season 偽コピー）、`BadAccount`（他プログラム所有の出発元）／courier `WrongFrontier`（偽 Frontier、System 所有の Season。CPI 前） |
| 誤った PDA（委任） | `t13`（偽の委任口座）、`t14_mandate_setup_is_the_owners_alone` | 実チェーン | **通過** | courier `MandateMismatch`、`NotWallet` |
| 不足または不正なアカウント | `t06_missing_or_malformed_accounts_are_refused` | 実チェーン | **通過** | Frontier `TooManyAccounts`（不足・過剰）、`BadAccount`（読取専用の出発元、偽 System）／courier `Accounts`、`BadInstruction` |
| 重複要求 | `t07_duplicate_requests_do_not_multiply` | 実チェーン | **通過** | Frontier `BadData`（同じ seq：再送でも同一取引内でも）。同一取引内の重複は取引ごと戻り何も動かない。二重の受取は `BadAccount`、配達は1回 |
| 到着前の処理 | `t08_no_receipt_before_arrival` | 実チェーン（到着・解決は作り込み） | **通過** | Frontier `BadAccount`（送付と受取の同居）、`CaravanEarly`（到着前、到着時刻後でも解決前） |
| 接続先の版不一致 | `t09_version_mismatch_is_refused_before_the_cpi` | 実チェーン | **通過** | courier `InterfaceVersion`、`FrontierVersion`（program_version 5、ruleset 違い。CPI 前）、`BadInstruction`／直接呼出しは Frontier `RulesetMismatch` |

## 2. その他の試験

| 試験 | 種類 | 結果 | 内容 |
|---|---|---|---|
| `t10_transport_raid_and_generation_rules_hold` | 実チェーン（襲撃の枠と解決は作り込み） | **通過** | courier で送った隊商を R が襲撃して奪い、R の Holding に届く（A の金庫は 0）。宛先の世代が変わると `LOST`。BuildVault と同一取引の送付は `BadAccount` |
| `t11_a_hostile_wrapper_cannot_go_around_the_core`（1, 2） | 実チェーン、hostile 版 | **通過** | Frontier 口座のデータ書込 `ExternalAccountDataModified`、lamport 引出 `ExternalAccountLamportSpend`。何も動かない |
| `t12_delegated_send_lands_without_the_owners_signature` | 実チェーン | **通過** | 署名は cranker の1つだけ。所有者の残高は不変、cranker は手数料のみ、purse が rent と fee、受取後は fee の分だけ減る |
| `t14_mandate_setup_is_the_owners_alone` | 実チェーン | **通過** | 登録・取消は wallet だけ。取消後は `MandateMismatch` |
| `t20_measure_direct_signed_and_delegated`、`t21_measure_delegation_setup_and_settle` | 実チェーン | **通過** | 下の測定 |
| `drill_cpi_target_programdata_counts` | ローカル validator | **通過** | 下の §4 |
| `matrix_generate` | チェーンなし | **通過** | 全命令表の生成と、`top_level_only` の 13 命令の固定 |
| `relay-check/relay-shape.test.mjs`（4件） | 模擬 | **通過** | [05](05-relay.ja.md) |
| courier の単体試験（2件） | チェーンなし | **通過** | 既定の Frontier id、委任口座の配置 |
| コアの既存試験（変更なし）: `caravan` 18、`g01_loaded_limit` 14、`g02_prefund` 10、`g13_season_beacon` 5、`harness` 6 | 実チェーン | **通過**（53件） | 今回のビルドで基準を確認 |
| 同上をパッチ案 0001 を当てた一時 worktree で | 実チェーン | **通過**（53件） | パッチ案が既存の試験を壊さない |

**開発中の失敗（記録）。** 最初の実行で `t08` と `t10` が失敗した。期待を「同一取引で合成できる」としていたが、実際は口座の読取／書込の宣言の衝突で `BadAccount` になった。これはコアの規則どおりの挙動で、試験の期待を事実に合わせて直し、[03](03-composition.ja.md) に発見として記録した。最終の実行で失敗している試験はない。

## 3. 未実行・確認していないこと

- コアの svm-tests 全体、`frontier-abi`・`permutation-rules`・`frontier-node` の全試験、CI。実行したのは上の5ファイルだけ。
- 実際の Frontier プログラムを validator に置いた試験（3.1.9 に BLS12-381 の syscall がなく、コアの演習と同じく置けない）。validator 演習は Frontier と同じ大きさの probe で代用。
- 検証器（`verify`）・索引（`findex`）・Herald・keeper に courier の取引を通すこと（[patches/0002](patches/0002-verify-inner-instructions.md) はコードを読んだ結果）。
- keeper が実際に解決した襲撃・到着（作り込みで代用。keeper 経由はコアの `g13_s1_clash_*` が担う）。
- 複数 Province にまたがる courier の送付（courier では1 Province のみ。2 Province の送付はコアの試験が直接呼出しで確認）。
- relay の起動と送信（判定関数のみ）。devnet・mainnet（禁止事項）。

## 4. 測定（ローカル条件。本番の費用・性能を保証しない）

### SendCaravan 1回（1 Province、積荷 2 種、`results/measure-sendcaravan.json`）

| 経路 | CU | CU 上限（表） | 取引の大きさ | 読込量（validator の規則） | 読込量（ハーネスの数え方） | relay の `L(kind)` | 手数料 | payer から出た lamports |
|---|---|---|---|---|---|---|---|---|
| 直接 | 27,809 | 140,000 | 515 B | 1,754,527 B | 1,754,527 B | 1,835,008 B | 5,000 | 2,325,840 |
| courier・所有者署名 | 34,023（+6,214） | 140,000 | 550 B | 1,809,312 B | 64,307 B | 1,835,008 B | 5,000 | 2,325,840 |
| courier・委任 | 39,127（+11,318） | 140,000 | 648 B | 1,809,592 B | 64,587 B | 1,835,008 B | 5,000（cranker） | 2,325,840（purse） |

- payer から出る 2,325,840 lamports は Caravan の口座（320 B）の rent 2,275,840 と受取の fee 50,000（`CARAVAN_FEE`）。rent は受取時に payer（`RENT_TO`）へ戻り、fee は受け取った者へ行く（`t12`）。利用者の正味の負担は fee 50,000 と手数料。
- 取引の大きさの上限（契約）は 1,000 B。
- 「ハーネスの数え方」は CPI 先の Frontier の ProgramData（1,744,941 B）を数えない（§5）。

### 委任の準備と受取（`results/measure-delegation-setup.json`）

| 操作 | CU | lamports |
|---|---|---|
| RegisterMandate（courier） | 8,562 | 委任口座 152 B の rent 1,422,400（取消で全額戻る） |
| SetSession（Frontier、wallet） | 5,240 | 手数料のみ |
| 委任の SendCaravan | 39,127 | 上表 |
| SettleCaravan | 11,274 | 受取人は fee 50,000 − 手数料 5,000 = +45,000 |
| RevokeMandate（courier） | 999 | +1,422,400 |

## 5. validator 演習（`results/drill-cpi-loaded.json`）

`solana-test-validator` 3.1.9。Frontier の release `.so`（1,392,304 B）と同じ大きさに詰めた probe（ProgramData 1,740,845 B）と courier の hostile 版（ProgramData 57,333 B）を置き、通る最小の読込上限を二分探索した。

| 取引 | 最小の読込上限 | 結果 |
|---|---|---|
| (a) probe を直接呼ぶ | 1,741,159 B | 着地 |
| (b) courier が probe を CPI で呼ぶ | 1,798,656 B | 着地（validator 上の CPI の成功） |
| (c) courier が probe を口座として並べるだけ | 1,798,656 B | courier が `WrongFrontier`（9002）で拒否（読込は通過） |

(b) は courier と probe の ProgramData の和（1,798,178 B）を超える。**CPI で呼ばれるか並べられた LoaderV3 プログラムの ProgramData も読込量に数えられる。** コアのハーネス `Chain::loaded_size` はトップレベルで呼ばれたプログラムの分しか数えないため、CPI の取引を実際より約 1.74 MB 少なく見積もる。courier-tests は validator の規則（`loaded_validator_rule`）で読込上限を求めており、ハーネスの修正は [patches/0001](patches/0001-harness-loaded-size-listed-programs.patch)。
