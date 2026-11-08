# 実 Core／LiteSVM 試験の実施可否（2026-10-31、v0.3）

**結論：現在の承認済み環境では実施できないため、止めた。** 模擬試験の結果を「実 Core で保証済み」とは扱わない。以下に、必要なものと理由を示す。

## 1. 環境の現状（確認したこと）

| 項目 | 状態 | 確認方法 |
|---|---|---|
| Solana CLI（`solana`、`solana program dump`） | 無し | `which solana` |
| SBF ツールチェーン（`cargo-build-sbf` 3.1.9） | 無し（`~/.local/share/solana` が存在しない） | `ls` |
| LiteSVM クレート（`litesvm = "=0.16.0"`、`permutation-frontier/svm-tests` が pin） | ソース未取得（cargo のレジストリキャッシュに無い） | `ls ~/.cargo/registry/cache` |
| Metaplex Core プログラム本体（`.so`） | 無し。mainnet の programdata 口座から取得するか、`mpl-core` をソースから SBF ビルドする必要 | — |
| `mpl-core` クライアントクレート（命令の組み立て） | 未取得 | — |
| mainnet RPC への到達 | HTTP 200（`getHealth`） | `curl`（読み取りのみ） |
| host の `cargo check`／`cargo test -p frontier-abi` | 可能（既存 lockfile の依存のみ） | 実行済み（patches/README） |

## 2. 実 Core 試験に必要なもの（いずれも新規導入に当たるため未実施）

1. **Core プログラムのバイナリ**：mainnet から `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` の programdata を取得（約数百 KB、`getAccountInfo` の base64）、または `metaplex-foundation/mpl-core` を SBF ビルド（SBF ツールが要る）。外部サービスからのバイナリ取得と、その検証方法（公式リリースのハッシュ）を決める必要がある。
2. **LiteSVM と `mpl-core` クレート**：新しいテストクレート（または `svm-tests` への追加）とその依存の取得。既存の lockfile には無い依存の導入。
3. **検証したい命令**：`CreateV1`（Permanent Freeze Delegate ＋ Permanent Transfer Delegate 付き、authority = テスト PDA）、owner の `TransferV1`（→ frozen で拒否されること）、Permanent Transfer Delegate 署名の `TransferV1`（→ forceApprove で通ること）、`ApprovePluginAuthority`／`RevokePluginAuthority` で永続プラグインの authority を変えられないこと、Oracle 付き asset の譲渡拒否。
4. **我々のプログラム側（`TransferResident` の CPI、`HOLDER_GEN`）**：Frontier プログラムの SBF ビルドと LiteSVM（`permutation-frontier/svm-tests/run.sh`）。SBF ツール（Agave 3.1.9）の導入が要る。
5. 鍵：全て LiteSVM 内のテスト鍵で足りる。**新しい永続鍵や外部アカウントは不要**。

## 3. 資料で確認できたこと（実行確認ではない）

- `permanent_transfer_delegate.rs` の `validate_transfer`：`resolved_authorities` に自分の authority が含まれれば `force_approve!()`。frozen 状態は見ない。
- `lifecycle.rs`：内部プラグインの結果集約で `ForceApproved` は即時 return（`Rejected` より優先）。外部プラグイン（Oracle）は `ForceApproved` を返せない（`unreachable!()`）。
- docs/core/plugins/permanent-transfer-delegate：「Uses `forceApprove` - can transfer even when frozen」。docs/core/plugins/transfer-delegate：「Frozen Assets cannot be transferred by delegates」「Transfer Delegate authority is automatically revoked after any transfer」。
- `plugins/utils.rs`：「currently we are blocking adding LifecycleHook and LinkedLifecycleHook external plugin adapters as they are still in development」→ Core の譲渡時 CPI（LifecycleHook）は**使えない**。

よって「Permanent Freeze ＋ Permanent Transfer Delegate で owner の譲渡を止め、プログラムだけが動かせる」はソース上整合しているが、実行で確かめていない。
