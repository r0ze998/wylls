# ⑯ 独立検証：再現テストの実行手順

場所: `verification/16-independent/`（本文書・一覧・報告・パッチ）と、各クレート／パッケージの試験ディレクトリに置いた `v16_*` / `v16-*` の試験ファイル。基点 `4cd901de`（コードは `main` = `92142932` と同一）に対して、**未修正の状態で失敗する**ものが不具合の再現、**通る**ものが確認済みの挙動。

## 前提

- Rust 1.89（ルート workspace）、Rust 1.95（`frontier-node`、`rust-toolchain.toml` により rustup が取得）、Node 22、`permutation-gateway` で `npm ci` 済み。
- `cargo-build-sbf`（Agave）は不要。LiteSVM の試験（`permutation-frontier/svm-tests`、③ `courier-tests`、`frontier-node/crates/itest`）は**この手順に含まれない**（本環境では実行不能。報告書の「未実行」参照）。

## 試験ファイル

| ファイル | 流れ | 内容 | 未修正の基点での結果 |
|---|---|---|---|
| `frontier-node/crates/herald/tests/v16_caravan_holder.rs` | A, C | 略奪 TAKE 後の feed の持ち主、`raided` の消失、`worn_bps` の欠落、同一鍵の再 SENT が 1 件に留まること | A1・A1c・C2 失敗、A2 成功 |
| `frontier-node/crates/verify/tests/v16_unknown_tag.rs` | 横断 X2, A8 | 予約タグ 0xBF／未知タグ 0xE0 の着地命令が PASS になる、CPI 形（プログラムを口座に挙げるだけ）が WARN 止まり、無改変の fixture は PASS | X2・X2b・A8 失敗、control 成功 |
| `permutation-gateway/test/v16-agent-wallet-replay.test.mjs` | B, X5 | 2,000 件の後の同一 key 再送が再送信になる（B1）、MCP requestId が agent ごと（B7） | B1 失敗、B7 成功 |
| `permutation-gateway/test/v16-agent-wallet-contention.test.mjs` | B | 本人 MCP と運営 runner が同一ティックに 2 行動を送る（B8、仕様未決定の記録） | 成功（挙動の記録） |
| `permutation-gateway/test/v16-web-caravan-holder.test.mjs` | A, C | 画面側: TAKE 後の「道中の隊商」と地図の `own`（A1, A1b）、③ courier の session 鍵を「鍵なし」と誤認（A7） | 3 件失敗 |
| `permutation-gateway/test/v16-web-wallet-switch.test.mjs` | C | ウォレット内のアカウント切替に画面が追従しない（C3、controller の 2 行を**模擬**） | 失敗 |

## 実行

```sh
# Rust（frontier-node workspace）
cd frontier-node
cargo test --locked -p herald --test v16_caravan_holder
cargo test --locked -p verify --test v16_unknown_tag

# Node（gateway と Web）
cd permutation-gateway
node --test test/v16-*.test.mjs
```

## 修正候補パッチの検証（隔離コピー）

```sh
git worktree add --detach /tmp/wt-fix HEAD
cd /tmp/wt-fix && for p in /path/to/verification/16-independent/patches/P*.patch; do git apply "$p"; done
# 既存試験の調整（P3・P5 が要求するもの）は patches/README.ja.md 参照
```

パッチ適用後は、上の ⑯ 試験のうち C3（模擬）を除く全件が通り、`cargo test -p verify`（tamper 58 件を含む全件）・`cargo test -p herald`（cq_fold, fold）・`npm test`（2,536 件、C3 を除き通過）が通る。P3・P5 が要求する既存試験の期待値更新と英訳はパッチに同梱（結果は `logs/patched-*.log`）。
