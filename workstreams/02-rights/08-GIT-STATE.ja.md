# ② 作業と保全：git の状態の変更、復元方法、push の前の調査

**状態：** 記録だけ。**自動では戻さない**（別の作業が始まっている可能性がある）。push・force push・merge・配備はしていない。

## 1. 変えたもの（前 → 後）

| 対象 | 変更前 | 変更後 | いつ・どのコマンドで |
|---|---|---|---|
| 主 checkout `/home/user/wylls` の HEAD | ブランチ `claude/modest-wozniak-xcc7d8`（@ `9214293`、作業木はきれい）。この branch は、セッション開始時に環境が `9214293` から作ったもの | **detached HEAD @ `9214293`**（= `main`）。ファイルは変えていない | 2026-10-29 22:28:55 UTC、`git checkout --detach main` |
| ブランチ `claude/modest-wozniak-xcc7d8` | `9214293`（= `main`。この branch に固有の commit はなかった） | 基準 `4cd901d` + ②の commit（v0 の3件、v1 の追加。先端は README を参照） | 22:28:55、`git branch -f claude/modest-wozniak-xcc7d8 4cd901d`。22:56:13 に、自分の未 push の commit を整理するため `reset --soft 4cd901d` を1回 |
| worktree | なし | `/home/user/wylls/.worktrees/02-rights`（このブランチ） | 22:28:55、`git worktree add` |
| `.git/info/exclude` | 既定の内容（コメント行だけ） | 末尾に `.worktrees/` の1行を追加 | 22:28 |
| remote-tracking の参照 | `origin/main`、`origin/claude/modest-wozniak-xcc7d8`（どちらも `9214293`） | `refs/remotes/origin/pr22`（`a4fc78c`）と `refs/remotes/origin/integrate/claude-consolidation-20261029`（`a4fc78c`）を fetch で追加 | 22:28、10-30 |
| 作業木の外のもの | — | rustup の 1.89.0 と 1.95.0（rustfmt・clippy を含む）、cargo の build ディレクトリ、`permutation-gateway/node_modules`（`npm ci --ignore-scripts`。`.gitignore` 済み） | 各テストの実行時 |

`origin/claude/modest-wozniak-xcc7d8` は、**リモートではすでに存在しない**（10-30 に `git ls-remote` で確認）。ローカルの追跡参照（`9214293`）は古いまま残っている。`fetch --prune` はしていない。

## 2. 復元の方法（実行していない）

前提：他のセッションがこの branch・worktree・主 checkout を使っていないことを、先に確認すること。

1. ②の成果を残す：`git branch preserve/02-rights-<日付> claude/modest-wozniak-xcc7d8`。パッチは `workstreams/02-rights/patches/` にもある。
2. worktree を外す：`git worktree remove /home/user/wylls/.worktrees/02-rights`（未 commit の変更がないこと）。
3. branch の位置を戻す：`git branch -f claude/modest-wozniak-xcc7d8 9214293`。
4. 主 checkout をブランチに戻す：`git -C /home/user/wylls switch claude/modest-wozniak-xcc7d8`。
5. `.git/info/exclude` の末尾の `.worktrees/` の行を消す。
6. 追加した参照が不要なら：`git update-ref -d refs/remotes/origin/pr22`。`origin/integrate/...` は `git fetch --prune` の対象になる。

## 3. push の前の調査（push はしていない）

| 項目 | 事実（2026-10-30） |
|---|---|
| リモートの `claude/modest-wozniak-xcc7d8` | **存在しない**（削除済み） |
| リモートの `main` | `9214293` |
| リモートの `integrate/claude-consolidation-20261029`、`refs/pull/22/head` | `a4fc78c`（基準 `4cd901d` の子。`docs/DEVELOPMENT-HANDOFF.ja.md` だけを変えた commit） |
| 基準 `4cd901d` との関係 | `9214293`（main）→ … → `4cd901d` → `a4fc78c`。**基準とその祖先6件（`f6c7b7b`…`4cd901d`）は、リモートにすでにある**（統合候補と PR #22） |
| 新しく公開される履歴 | **②の commit だけ**（`git log HEAD --not --remotes=origin` で確認）。stop hook の「9件」は、古い追跡参照 `9214293` から数えた数で、6件はリモートにすでにある |
| 新しく公開される内容 | `frontier-abi/src/v2/{mod.rs, rights.rs}`、`permutation-frontier/src/{error.rs, init.rs, lib.rs, prologue.rs, host_test.rs, proc/mod.rs, proc/rights.rs, proc/rights_tests.rs}`、`permutation-frontier/svm-tests/tests/rights.rs`、`frontier-node/crates/verify/tests/rights_replay.rs`、`workstreams/02-rights/**` |
| push した場合 | リモートに新しい branch ができる（force は要らない）。main・統合候補・PR #22 は変わらない。統合候補の先端 `a4fc78c` は、この branch に含まれない（docs だけの差） |
| 公開の注意 | `rights_replay.rs` と 05 の文書は、**サーバーの制限を迂回できる経路**（セッション鍵の seed を持つ者の直接送信）を説明している。これは既存の設計文書（`docs/agent-wallet/DESIGN.md:106`）が公開で書いている内容と同じで、未修正の脆弱性の再現手順ではない。それでも公開の判断は、利用者に委ねる |
