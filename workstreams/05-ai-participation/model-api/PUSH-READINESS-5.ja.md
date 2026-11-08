# ⑤：GitHub への push の前の確認（2026-10-31）

**結論：push は保留しています。** Vercel・Netlify・GitBook の3つの連携が、担当ブランチへの push で、自動の deploy・意図しない公開・課金を起こさないことを、**設定から確かめられませんでした。** 変更は消していません。ローカルのブランチにあります。

## 確かめられたこと

| 項目 | 結果 | 方法 |
|---|---|---|
| remote | `origin` = `https://github.com/r0ze998/wylls` | `git remote -v` |
| 担当ブランチ | `claude/ai-participation-provider-budget`。⑤の成果（`ba3c180b`、`6cdd648c`、`9f1209c4`、`45cba41e`、`29365e60`、`7e5dc572`、`5d41e51b` と、この確認のコミット）は、すべてこの1本の祖先にある | `git merge-base --is-ancestor` |
| remote にまだ無いコミット | 12 件（この確認のコミットを含む）。⑤のブランチは、まだ1本も remote に無い | `git rev-list HEAD --not --remotes=origin`、`git ls-remote` |
| 変えたファイル | すべて `workstreams/05-ai-participation/` の中（共有コード・workflow・root の設定は変えていない） | `git diff --name-only` |
| workflow | `.github/workflows/ci.yml` と `doctrine-balance.yml` は、main と**同じ blob**（担当ブランチ固有の差分なし） | `git rev-parse <ref>:<path>` |
| CI の中身 | `ci.yml`：全ブランチの push と pull request で、build と test だけ。`permissions: contents: read`。deploy・publish・secrets を使う手順は無い。`doctrine-balance.yml` は手動の起動だけ | 本文を読んだ |
| deploy の設定ファイル | `vercel.json`・`netlify.toml`・`_redirects`・`.gitbook.yaml`・`book.json`・`SUMMARY.md` は、main にもこのブランチにも無い | `git ls-tree` |
| 混入の確認 | 秘密鍵・token・API キーの形、`node_modules`、`.env`、鍵のファイル、DB、ビルドの出力、500 KB を超えるファイル、メールアドレス、記録の中の token の値：**どれも無い**。この環境の絶対パス（`TOOLCHAIN-RECORD.ja.md` の `~/.rustup` など）は、一般の書き方に直した | `git diff` と記録のファイルへの grep |
| 外部の連携の痕跡（間接の証拠） | 最近の pull request（#22 `integrate/claude-consolidation-20261029`、#21）の先端のコミットに、commit status は 0 件。check run は GitHub Actions の CI だけ（Vercel・Netlify・GitBook の check や deploy の status は無い） | GitHub API（読み取り） |

## 確かめられなかったこと（push を止めている理由）

| 連携 | 確かめる必要があること | 確かめられなかった理由 |
|---|---|---|
| Vercel | このリポジトリにつながっているか。preview の deploy をどのブランチで作るか（既定では、すべてのブランチの push で preview が作られる）。公開の範囲（preview の URL が誰に見えるか）。課金のプラン | Vercel のダッシュボードと、GitHub App のインストールの対象リポジトリは、この環境の GitHub の権限では読めない。Vercel にはログインできない（新しい資格情報は使わない） |
| Netlify | 同上（branch deploy・deploy preview の設定、build の分数の課金） | 同上 |
| GitBook | Git Sync の対象のリポジトリとブランチ、同期の向き、公開の設定 | 同上 |

**上の「間接の証拠」は、確認の代わりになりません。** 連携が main だけを対象にしている、または GitHub に status を出さない設定なら、痕跡は残りません。逆に、⑤のブランチ名のような新しいブランチで、初めて preview が作られることもありえます。

## push を進めるために必要なこと（どれか1つ）

1. リポジトリの所有者が、3つの連携の設定（対象のリポジトリ・ブランチ・自動 deploy・公開の範囲）を確かめ、担当ブランチへの push が何も起こさないことを示す。
2. 3つの連携を、このリポジトリの対象から外す。または、ブランチの push を無視する設定にする（例：Vercel の Ignored Build Step、Netlify の branch deploy を「なし」、GitBook の Git Sync を対象外）。

確認が取れたら、次を実行します（通常の push だけ。force・main・統合ブランチへの push はしない）。

```
git push -u origin claude/ai-participation-provider-budget
git ls-remote origin refs/heads/claude/ai-participation-provider-budget   # ローカルの HEAD と同じ完全 SHA であること
```
