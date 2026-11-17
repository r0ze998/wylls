# 04 結果：実行したもの・していないもの

## 0'. 2026-10-31 の追加（世界の継続、[06](06-continuity.ja.md)）

| 対象 | 結果 |
|---|---|
| `tests/continuity.rs` 6 件 | 通過：境界を 10 か所・再起動つき・毎段階に入れても終状態が境界なしと一致、押収待ちは境界で変わらない、注文は自分の期限だけで切れる、2,000 周の長期運用で状態が増えない、累計は上限で拒否し巻き戻らない、隊商 id の重なり（コアの事実） |
| 変異試験 | 「累計の巻き戻り」を足して 12 件すべて検出 |
| コア（パッチ 0009） | 既定・`custody-preview` の両ビルドで rules・ABI・プログラムの test と clippy `-D warnings` が通過、`frontier-node` の `cargo check --workspace --all-targets` 通過、カーネルの写しが一致 |

## 0. 2026-10-30 の追加（統合前の指摘への回答、[05](05-integration-review.ja.md)）

| 対象 | 実行したこと | 結果 |
|---|---|---|
| 版の分離 | `permutation-frontier` を既定と `--features custody-preview` の両方で test・clippy `-D warnings` | 既定：95 件通過、custody タグ全部 `BadData`、V3・版 4。preview：96 件通過、V4・版 5・規則 13 |
| `RULESET_HASH_V4` | `frontier-abi` で kernels と一致する固定値の試験 | `2f430c062fbc2f12f587ecfd46c38e572f303aa4cb6abc6b3d781547fdf48635`。V3（`234c0dc2…9aae422d`）は不変 |
| 検証器ガード | `tests/custody.rs`（修正前と後） | 修正前 4/6 失敗：偽の custody 命令・Lot 口座・custody 欄が **PASS**（[results/verify-before-guard.log](results/verify-before-guard.log)）。修正後 6/6 通過 |
| オフチェーン全体 | fclient・herald・verify・keeper の `cargo test --locked` | 329 件通過、失敗 0（[results/frontier-node-tests.log](results/frontier-node-tests.log)） |
| LiteSVM ハーネス | `cargo check --tests`、`cargo test --test coverage`（SBF 不要の静的試験） | **前回の候補ではコンパイルできなかった**（網羅 match）。修正後は通過、custody は `Pending`（[results/svm-coverage.log](results/svm-coverage.log)） |
| JS クライアント | `sync-web-sdk.mjs --check`、gateway の `node --test` を基準 commit と比較 | **前回の候補では生成物が古かった**。再生成後は最新。JS 試験は基準と同一（1858 通過、同じ 83 件が基準でも失敗：環境要因）（[results/gateway-tests.log](results/gateway-tests.log)） |
| `frontier-wasm` | `cargo check --all-targets`、`cargo test` | 通過（16 件） |
| 容量予約 | `tests/capacity.rs` 6 件、`World::check` の不変条件2つ追加、乱択試験の最後に排出 | 通過。300 回の乱択実行すべてで排出後に隊商・予約が残らない |
| 変異試験 | 3 件追加（通常の精算が quota を無視、精算・照合が予約を解放しない） | 計 11 件すべて検出（[results/mutations.log](results/mutations.log)） |

この作業機（Linux、Rust 1.89.0 と 1.95.0）での結果。ログは [results/](results/)（`run.sh` が書く）。

## 1. 確認した（実行した）

### 1.1 カーネルとモデル（`custody/`、独立 workspace）

| 試験 | 件数 | 内容 |
|---|---|---|
| `src/layout.rs` 単体 | 1 + コンパイル時の表検査 | 区画のバイト往復、別世代は別の鍵。区画の欄が口座を隙間なく覆い、倉・隊商の改定が予約領域の中に収まること（`const` 断言） |
| `tests/abuse.rs` | 12 | 保管者の流用（売り送り・注文・発送・消費・倉を閉じる・区画を縮める・容量の二重約束）、保管者自身の配達が区画の容量を食わないこと、開設の署名、運搬者の範囲（宛先違い・自分の村・量超過・session 鍵・id 違い・他人・分割の後）、保管品の隊商は区画にしか精算されないこと、利用者の範囲（量・目的・他人・種類違い）、二重予約、期限、再送（nonce・seq）、並行要求（両方の順序）、到着予定による容量予約と枠の上限、session 鍵の範囲 |
| `tests/failures.rs` | 13 | 奪われた（J2）→不明→照合で `Raided` 確定・襲撃者の一般在庫へ、奪われた隊商が閉じた後の照合、焼かれた→`Burned`、運搬者は自分の荷を奪えない、押収→凍結→照合で `Seized`（注文無効、押収者の一般在庫）、取り返しても区画は戻らない、輸送中の宛先押収→`DestinationGone`（保管者による宛先の閉鎖は拒否）、押収された宛先への注文は使えない、運搬者・保管者・所有者の途中退出、輸送中の権限取消、塔の摩耗→`Worn`、再起動と再送（旧「シーズン終了で凍結」の試験は 2026-10-31 に削除し、`tests/continuity.rs` に置き換え） |
| `tests/property.rs` | 1（300 種 × 400 手 = 12 万手） | 7 割は正しい形、3 割は誰が何をしてもよい要求。各手の後に：区画の保存則・倉の数の一致・保管品の隊商が区画に期待されていること・所有者ごとの保存則、**拒否された要求は世界を一切変えない**、区画の量は所有者か範囲内の受け手か押収（世代が変わったとき）でしか減らない、受け手は与えられた量を超えて動かせない、倉の一般在庫は精算か没収でしか増えない、9 手ごとに再起動の往復。経路ごとの成功回数の下限も検査（[results/tests.log](results/tests.log) に回数）。別に `CUSTODY_SEEDS=3000`（120 万手）でも通った |
| デモ | — | [results/demo.log](results/demo.log)。各段階で不変条件と再起動の一致を確認 |
| `cargo fmt --check`、`cargo clippy --all-targets -D warnings`、`--no-default-features`（`no_std` のカーネルだけ） | — | [results/checks.log](results/checks.log) |

### 1.2 変異試験（試験が本当に落ちるか）

保証を一つずつわざと壊し、試験が必ず落ちることを確かめた（`run.sh`、[results/mutations.log](results/mutations.log)）：受け手の確認なし／予約を保管量で数える（利用可能でなく）／到着予定の容量予約なし／SettleCaravan が保管品の隊商を受け付ける／注文の期限なし／ShipLot の再送防止なし／没収で物が消える／保管者が容量を超えて約束できる。**8 件とも検出**（2026-10-30 に 3 件追加し計 11 件、§0）。 作業中にはこの試験群が実際の誤り（照合時の損失記録が襲撃者でなく運搬者を指す。J2 で `OWNER_TAG` が運搬者の seed のまま残るため）を見つけ、隊商に `TAKEN_BY_TAG` を足して直した。

### 1.3 コア差分（[patches/](patches/)、4cd901de の上）

| 対象 | 実行したこと | 結果 |
|---|---|---|
| `permutation-rules` | `cargo test`、clippy `-D warnings`、fmt | 通過。S1 の `RULESET_HASH_V3` の固定値の試験は変更なしで通る（S1 のハッシュは変わらない） |
| `frontier-abi` | `cargo test`（ABI ベクタは付属の `abi-vectors` で再生成し、鮮度試験が通る）、clippy、fmt | 通過。ABI のオフセットがカーネルと一致する試験、custody の記録の連鎖の試験を追加 |
| `permutation-frontier`（ホスト向け） | `cargo test`（95 件）、clippy `-D warnings`、fmt | 通過 |
| `frontier-node`（Rust 1.95.0） | `cargo check --workspace --all-targets --locked`、fclient・herald・verify・keeper の `cargo test` | check は通過。試験は §1.4 |
| コアの写しとカーネルの一致 | `CORE=… run.sh`（`scripts/core-kernel.py --check`） | 一致 |

### 1.4 オフチェーンの試験

`frontier-node` の fclient・herald・verify・keeper の `cargo test --locked`（Rust 1.95.0、パッチ適用後）：**323 件通過、失敗 0**（ignored は基準 commit でも ignored のもの）。[results/frontier-node-tests.log](results/frontier-node-tests.log)。

## 2. していない（未実行）

- **SBF ビルドと LiteSVM。** Solana のツールチェーン（Agave 3.1.9、`cargo-build-sbf`）の導入を試みたが権限で拒否された。迂回はしていない。したがって、プログラムの差分は**オンチェーンで一度も実行されていない**。CU・口座の読込量・トランザクション長の予算は仮の値（`budgets.rs` の custody 行）。④が `permutation-frontier/svm-tests` に custody の試験を足す必要がある（デモと同じ筋書き、`tests/failures.rs` と同じ障害）。
- 検証器（V26 の再判定と改ざん分類）、keeper（精算・照合の当番）、herald（区画の一覧）、relay（新タグの分類）、Web 画面。差分は既存の網羅的な `match` が壊れないための空の分岐だけ（[02](02-contract.ja.md) §10）。
- `frontier-wasm` と `permutation-gateway` のビルド・試験（wasm32 ターゲットと Node の環境は使っていない）。ABI の追加は列挙の末尾への追加で、wasm に入る規則（`frontier-v3.wasm`）の入力は変えていない（S1 のハッシュは不変）。
- devnet・本番、実際の資金、鍵。

## 3. 測っていないもの

CU、ヒープ、トランザクション長、口座の読込量（すべて SBF ビルドが要る）。
