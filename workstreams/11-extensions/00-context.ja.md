# 00 前提と確認した状態（2026-10-30）

## 1. 基準と作業場所

| 項目 | 値 |
|---|---|
| 基準 commit | `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（Document consolidated development handoff。`origin/integrate/claude-consolidation-20261029` と `origin/claude/modest-goldberg-c180fk` の祖先） |
| 確認時の `origin/main` | `921429322d5aecd1a3df0dd8d82c405c87dd985a`（基準はこの上に試遊キットの文書だけを足したもの） |
| 作業ブランチ | `claude/kind-fermat-earbxe`（このセッション専用の clone。基準 commit から作り直した。開始時は `main` と同じで、独自の commit はなかった） |
| 未 commit の変更 | 開始時になし（`git status` が空） |
| 共有コアへの変更 | **なし**。変更案は [patches/](patches/) に分離 |
| push・merge・deploy | していない |

## 2. AGENTS とスキル

- リポジトリに `AGENTS.md`・`CLAUDE.md`・`.claude/skills` は**存在しない**（全 remote branch を `git ls-tree` で確認）。名前に AGENTS を含むのは `docs/frontier/ai-agents/AI-AGENTS-PLAN.md`（AI エージェント参加の計画で、作業規約ではない）だけ。
- 作業規約として読んだもの: `docs/DEVELOPMENT-HANDOFF.ja.md`（基準 commit で追加）、`Cargo.toml`（ワークスペースと overflow-checks の方針）、`.github/workflows/ci.yml`（Agave 3.1.9、Rust 1.89.0／1.95.0、`clippy -D warnings`）、`frontier-abi/Cargo.toml`（依存は integrator の管理、I-55）。
- 「新しい世界効果はコア側が追加する」という方針は、この依頼文に書かれたもので、決定ログ（`docs/design/redesign/99-decisions.ja.md`）には該当する行がない（検索した結果）。

## 3. 他の担当の状態（読んだだけ。変更していない）

GitHub に push されているのは③だけ。②④⑤⑥⑨⑩は各セッションのコンテナ内にあり、この作業機からは中身を読めない。各セッションの要約（`list_sessions` と最終応答）から分かったこと:

| 担当 | 状態 | ⑪との関係 |
|---|---|---|
| ③ 外部接続 | `origin/claude/modest-goldberg-c180fk` @ `2f8ec700`。courier（SendCaravan の CPI 転送、仮の委任）、LiteSVM 試験、パッチ案 0001–0004 | 案 A の基準と実証として利用（作り直していない） |
| ④ 非同期実行 | 要約では「担当パッチをローカル統合し全テスト通過、実チェーン確認は未実施」。SBF 環境待ち | Receipt を Run の結果に入れる想定で契約を送付（§5） |
| ⑥ 創作・公開・再利用 | 要約では commit `517796dc`（基準 4cd901de）、パッケージ r2 の SHA256 `7d3a0e99…`、統合指示待ち | 登録簿の最小欄を契約として送付（§5）。⑥の版管理は作り直していない |
| ② 権利（Grant） | 要約では `workstreams/02-rights/HANDOFF.ja.md` に契約を集約 | Grant を `GrantAdapter` で差し替え可能にした。内容は未照合 |
| ⑨⑩ 資源・権限・保管 | 作業中 | escrow を⑩の保管の契約で表せるかを未決として記録（[01](01-contract.ja.md) §7） |

## 4. 実行できなかったこと

- **Agave 3.1.9（cargo-build-sbf、solana-test-validator）の導入は、自動許可の判定で拒否された**（外部から取得したコードの実行）。導入元は CI と同じ `https://release.anza.xyz/v3.1.9/install`（取得したスクリプトの SHA-256 は `81d4fecf853abcd8ae4c5670c5dfc83235f8f36b6f092019ea3fdbc5c6de4564`。実行していない）。このため SBF ビルド・LiteSVM・validator での試験はしていない。承認があれば、[patches/0002](patches/0002-core-extension-instructions.md) の組込みと CU の実測に進める。
- 第三者の拡張コードは**取得もインストールも実行もしていない**。案 B の試作では、作者 A・利用者 B・第三者 C はすべて試験の中の鍵で、拡張の「コード」は manifest の byte 列（データ）だけ。
- 調査で読んだ OSS（BOLT、Metaplex Core、Transfer Hook、MUD、Dojo、Swig、Lighthouse）は固定 SHA の raw ファイルを読んだだけで、clone・ビルド・実行していない（[10](10-research.ja.md)）。

## 5. 他の担当への受け渡し

- 2026-10-30、[01 契約](01-contract.ja.md) の要点を④と⑥のセッションへメッセージで送った（情報提供のみ、作業の変更は求めていない）。返信はこの文書の作成時点で受け取っていない。
