# patches：コアへの差分（④向け、未適用）

基準 `4cd901de9f8e0d6c0b2016851d30595c4a70aa46` の上に `git am` で順に当たる9件。適用後は作業ブランチ `workstream/10-custody-core` の先端 `96fe6abff2004d05967854c4edc75c10ce2af7a4`（tree `0d022429fab0ec00c0e245a71d0169fe628ebeeb`）と同一になる（fresh checkout で確認）。ハッシュは [SHA256SUMS](SHA256SUMS)。

**配備候補ではない。** 既定のビルドは S1 プログラム（`RULESET_HASH_V3`、版 4）で custody タグを拒否する。custody は `--features custody-preview`（`RULESET_HASH_V4`、版 5）だけで動き、そのビルドは `build-frontier.sh` が配備用として拒否する。SBF ビルドと LiteSVM は未実行。

| # | 対象 | 内容 | 確かめたこと |
|---|---|---|---|
| 0001 | `permutation-rules` | custody カーネル（[../scripts/core-kernel.py](../scripts/core-kernel.py) が `custody/src/{lot,layout}.rs` から生成）、`KERNEL_VERSIONS_V4` / `ruleset_hash_v4`（規則 13）。S1 の V3 は不変 | test、clippy、fmt |
| 0002 | `frontier-abi` | Lot 口座、Vault・Caravan の予約領域から custody 欄、タグ 0xC1–0xCB、データ、口座表、仮の予算、記録 104–112、エラー 94–98、ベクタ再生成 | test（ベクタ鮮度を含む）、clippy、fmt |
| 0003 | `permutation-frontier` | `proc/custody.rs`（11 命令）と S1 命令の改定 | ホスト test、clippy |
| 0004 | `frontier-node` | fclient・herald の網羅 match に custody 種別の分岐 | check |
| **0005** | ABI・プログラム・ビルドスクリプト | **版の分離**：`PROGRAM_VERSION_CUSTODY`=5・`RULESET_HASH_V4` を固定、feature `custody-preview`（ハッシュ・版・dispatch を同時に切替、マーカー `PSF_CUSTODY_PREVIEW_BUILD`）、既定ビルドは custody タグを `BadData`・改定はコンパイル外。倉の一般在庫を書く箇所の一覧試験 | 両ビルドで test・clippy |
| **0006** | `frontier-node/crates/verify` | **V26 ガード**：custody の痕跡は custody のないシーズンで FAIL、custody シーズンで UNVERIFIABLE。修正前は偽の `OpenLot` が PASS だった | `tests/custody.rs` 6 件（修正前 4 件失敗）、fclient・herald・verify・keeper 329 件通過 |
| **0007** | LiteSVM ハーネス、JS クライアント | 0002/0003 が壊していた2点の修正：ハーネスの網羅 registry（custody は `Pending`）、`frontier-abi/vectors` から生成される JS の ABI ファイル（リポジトリのスクリプトで再生成） | harness `cargo check --tests` と coverage 試験、`sync-web-sdk.mjs --check`、gateway の JS 試験が基準と同一結果 |
| **0008** | `permutation-rules` | カーネルの説明の訂正：区画の没収は⑩の提案（採用済み決定は段階2の札が対象）。コードは不変、ハッシュも不変 | test |
| **0009** | `permutation-rules`、プログラム | 世界の継続（[../06-continuity.ja.md](../06-continuity.ja.md)）：カーネルの累計を検査つきに（`Overflow`）、期間の語彙 `SeasonOver` を削除。表は不変で `RULESET_HASH_V4` も不変 | 既定・preview の両ビルドで test・clippy |
| **0010** | `frontier-node/crates/verify` | V26 の再判定（[../09-v26-state.ja.md](../09-v26-state.ja.md)）：custody シーズンで区画・倉の口座だけで決まる法則を再判定（破れていれば FAIL、未決の規則は UNVERIFIABLE、シーズンは PASS にならない）。`tests/custody_state.rs` | verify 103 件通過、変異 6 件検出、stable clippy `-D warnings` |

前回渡した `823bb71d`（0001–0004）は、custody を v3 を名乗るバイナリで実行し、ハーネスのコンパイルと JS の生成物を壊し、検証器は custody の痕跡を PASS にしていた。0005–0007 がそれを直し、0008 は押収の扱いの説明を直し、0009 は終わらない世界での累計を扱い、0010（2026-11-05）は V26 の再判定を足す。0001–0010 を 4cd901de に順に当てると tree `3d80c5b1e6bdfe968898007bb9c3077c3d49a20f`（ブランチ `workstream/10-custody-core-v26` @ `5bb79786efccdf29e9c9d79749ba4694a37c7488`）。

## 適用と確認

```sh
git fetch <bundle> 'refs/heads/workstream/*:refs/heads/workstream/*'   # または
git checkout -b try-custody 4cd901de && git am patches/*.patch
cargo test -p permutation-rules -p frontier-abi -p permutation-frontier
cargo test -p permutation-frontier --features custody-preview
(cd frontier-node && cargo test --locked -p fclient -p herald -p verify -p keeper)      # Rust 1.95.0
(cd permutation-frontier/svm-tests && cargo test --locked --test coverage)
(cd permutation-gateway && node scripts/sync-web-sdk.mjs --check)
```

## ④が決めること

1. 番号（タグ、口座種別 23、記録 104–112、エラー 94–98、V26、版 5）を②⑨⑪と照合。エラーは 99 の手前で尽きる。
2. custody を正式な版にする条件（LiteSVM 試験、CU 測定、V26 本体、keeper・herald）と、そのときマーカーを外すこと。
3. relay（custody 命令は sponsor の形に入れていない）。
4. [../05-integration-review.ja.md](../05-integration-review.ja.md) と [../03-rules-and-conflicts.ja.md](../03-rules-and-conflicts.ja.md) §5 の判断。
