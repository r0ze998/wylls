# 付録E 更新時の再確認と、GitBook との同期

## E.1 最新の作業ツリーで照合するときのコマンド

読み取りだけのコマンドです。作業ツリーを変えません。

```sh
cd <最新の作業ツリー>
git branch --show-current
git rev-parse HEAD
git status --porcelain=v1 | wc -l
git status --porcelain=v1 | sha256sum | cut -c1-16     # 未コミットの状態の指紋
git diff HEAD | sha256sum | cut -c1-16                  # 差分の指紋
git worktree list
git ls-remote origin 'refs/heads/*'                     # GitHub 側のブランチ（並行の作業）
git merge-base --is-ancestor <この文書が見たブランチの commit> HEAD && echo 含む
```

HEAD が同じでも、未コミットの変更は変わることがあります。そのため、照合の前後で指紋を記録し、変わっていたら差分を確かめ直します。

並行の作業で、GitHub 側のブランチが増えることもあります（この文書の執筆中にも 5 つ増えた）。

## E.2 更新のたびに再確認する項目

| 項目 | 見る場所 | 本文 |
|---|---|---|
| 決定の追加と覆し | `docs/design/redesign/99-decisions.ja.md` | 00、各章 |
| 設計書のまとめ | `docs/design/redesign/27-design-v1.ja.md` | 各章 |
| 段階の実装の進み | `docs/frontier/stage1*/`（メモと契約書） | 第10章、第11章、付録C |
| 兵器、工房、強い兵、地形の鉱石の数値 | `permutation-rules/src/frontier/arms.rs`、`holding.rs` | 第2章、第7章 |
| 倉、荷車、襲撃の規則と数値 | `permutation-rules/src/frontier/caravan.rs`、`permutation-frontier/src/proc/caravan.rs` | 第2章、第4章 |
| 見張り塔、柵、砦、国の構えと止める規則 | `permutation-rules/src/frontier/structure.rs`（`ad391ee` で `tower.rs` から改名）、`docs/frontier/stage1e/` | 第2章、第10章 |
| 新参の守り | `permutation-rules/src/frontier/holding.rs`（`shield_secs`） | 第2章、第10章 |
| 賞金の勝者の規則 | `permutation-prize/src/lib.rs` | 第7章、第10章 |
| AI 予算、代理、MCP | `docs/agent-wallet/`、`permutation-gateway/src/frontier/agent/` | 第6章 |
| 旧い設計書の扱い | `docs/GAME-DESIGN.ja.md`、`docs/DESIGN-OVERVIEW.ja.md`、`README.md` | 第10章 G9 |
| 比較の根拠と補給網の候補 | `docs/design/redesign/17a-*.ja.md`、`27a-*.ja.md`、`README.ja.md`（`docs/eve-eternum-supply-design`） | README、第3章、第8章、第9章、第11章 |
| 地図（hex、州、道） | `frontier-abi/src/layout/province.rs`、`permutation-rules/src/frontier/travel.rs` | 第2章、第5章 |
| EVE Frontier の現行の版 | `evefrontier/world-contracts` の main と dev、docs.evefrontier.com | 第8章 |
| Eternum の現行の版 | `BibliothecaDAO/eternum`、docs.realms.party | 第8章 |

## E.3 原稿の検査

```sh
# リンク切れ、画像の参照、目次、状態のタグを調べる
python3 tools/check_links.py .
```

検査スクリプトは、このフォルダの `tools/check_links.py` にあります。GitBook の目次には載りません。

検査の内容：

- `SUMMARY.md` のすべてのリンク先が存在する
- 各ページの相対リンクと画像の参照先が存在する
- ページ内の見出しへのリンク（`#...`）を使っていない（日本語の見出しの自動の名前は GitBook の規則に左右されるため）
- 各 Markdown ファイルが `SUMMARY.md` に 1 回だけ出る
- 状態のタグが凡例（00 章）のどれかである

結果は [付録D](d-sources.md) の D.5 に記録します。

## E.4 GitBook との同期

### いまの設定

この原稿は、GitBook の既存の Space と Git Sync でつながっています。設定はオーナーが GitBook の画面で行いました（2026-10-23）。

| 項目 | 値 |
|---|---|
| GitBook の Space | https://app.gitbook.com/o/FcvpoE8iury0Zgap5SeA/s/SPkIhn4ZKXj0gdWUg4fM/ |
| リポジトリ | `r0ze998/wylls` |
| ブランチ | `claude/determined-ride-engpa4` |
| Project directory | `gitbook-design`（このフォルダが Space の根になる） |
| 最初の同期の向き | GitHub → GitBook（画面の表示は「Content in GitHub will replace content in GitBook.」） |
| 最初の同期で入った版 | commit `11559d0`（読みやすさの改訂） |

経緯：最初は、commit `dbde3ac` の原稿を ZIP で手で取り込みました。その後、改訂版を GitHub に置いてから Git Sync をつなぎ、最初の同期で Space の中身を GitHub の原稿で置き換えました。同期の後も、ブランチに GitBook からの commit は増えていません（向きが GitHub → GitBook だったため）。main（`2321d55`）は変わっていません。

### 原稿の形式

GitBook は、Project directory の中の `.gitbook.yaml` を読みます。この原稿の設定は `root: ./`、`structure.readme: README.md`、`structure.summary: SUMMARY.md` です。

- `README.md` が最初のページ、`SUMMARY.md` が目次になります。
- 目次では、`##` の見出しがページの組になり、箇条書きのリンクがページになります。
- 各 Markdown ファイルは、`SUMMARY.md` に 1 回だけ載せられます。載せていないファイルは表示されません。
- 画像は `images/` の SVG を、本文から相対パスで参照します。

### 同期の後の運用

Git Sync は双方向です。

- **GitHub で直したとき。** ブランチ `claude/determined-ride-engpa4` の `gitbook-design/` に push すれば、GitBook に自動で反映されます。
- **GitBook で直したとき。** Change request を Merge すると、その変更がこのブランチに commit されます。GitHub で原稿を直す前に、必ずブランチの最新を取り込んでください（`git pull origin claude/determined-ride-engpa4`）。取り込まずに直すと、GitBook での変更を上書きするおそれがあります。
- **README は GitHub で直します。** GitBook の画面で README を直すと、衝突やページの重複が起きることがあると、GitBook の資料に書かれています。
- **ページを足すときは目次にも載せます。** GitHub で新しいファイルを足したら、`SUMMARY.md` に 1 回だけ載せ、E.3 の検査を通してから push します。
- **GitBook が新しいファイルを作ることがあります。** GitBook の資料によると、既存のファイルを上書きしないために、別名の Markdown を作る場合があります。そのときは目次と中身を確かめ、重複を整理します。

### 同期の設定を変えるとき

- **ブランチを付け替える（例：main にマージした後）。** Git Sync の設定でブランチを選び直します。付け替えの前に、新しいブランチに同じ原稿があることを確かめてください。main へのマージは、オーナーの指示があるまでしません。
- **設定をやり直す。** 想定外のエラーが続くときは、連携を外して有効にし直し、設定し直す方法が GitBook の資料に案内されています。やり直すときも、最初の同期の向きを確かめてください。
- **同期をやめる。** Git Sync の画面の「Remove Git Sync」で外せます。外すと、それ以降の GitHub の変更は GitBook に反映されません。

> **注意。** 最初の同期を GitHub → GitBook でやり直すと、Space の中身は GitHub の原稿で置き換わります。空のブランチやフォルダを選ぶと、空で置き換わります。綴りを間違えたブランチ名は、新しい空のブランチとして作られることがあります（画面に「If the branch doesn't exist, it'll be created during the sync.」とある）。

### 確認できていないこと

- GitBook の GitHub App に与えた権限の細部と、プランの条件。設定はオーナーの画面で行ったため、この文書では確かめていません。
- GitBook の Space の公開の設定。取り込み時点では非公開でした。同期で公開設定を変える操作はしていませんが、確認はオーナーの画面で行います。

### 手で取り込む方法（参考）

Git Sync を使わない場合は、`gitbook-design/` を ZIP にして、GitBook の取り込み機能で入れる方法もあります。既存の Space に重ねて取り込むと、ページが重複するおそれがあります。今は Git Sync を使っているので、この方法は使いません。

## E.5 公開前に外すもの

この原稿は、あなたが設計を判断するための内部資料です。外部に公開する場合は、次を見直してください。

- 第10章と付録D の、内部のブランチ名、commit、作業の記録
- 未決定事項の「推奨」（決定と誤読されうる）
- 賞金、USDC、トークンの記述（法的確認が未了）
