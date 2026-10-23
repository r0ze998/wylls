# 付録E 更新時の再確認と、GitBook への取り込み

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

HEAD が同じでも、未コミットの変更は変わります。照合の前後で指紋を記録し、変わっていたら差分を確かめ直します。並行の作業で GitHub 側のブランチが増えることもあります（この文書の執筆中にも 5 つ増えた）。

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

## E.4 GitBook への取り込み手順

GitBook の公式資料（Git Sync の Content configuration、2026-10-23 に確認）によると、GitBook はリポジトリの中の `.gitbook.yaml` を読み、`root`、`structure.readme`、`structure.summary` で最初のページと目次の場所を決めます。目次（`SUMMARY.md`）では、`##` の見出しがページの組になり、入れ子の箇条書きのリンクが子のページになります。各 Markdown ファイルは `SUMMARY.md` に 1 回だけ出せます。Git Sync を使うときは、`README.md` をリポジトリの側で管理するよう求められています。

**方法 1：Git Sync（推奨）**

1. この原稿のフォルダ `gitbook-design/` を、GitHub のリポジトリに置く（このリポジトリの中の 1 フォルダでも、専用のリポジトリでもよい）。原稿の作成の時点では、GitHub には置いていません。
2. GitBook で新しいスペースを作り、Git Sync で GitHub のリポジトリとブランチをつなぐ。
3. リポジトリの中のフォルダを使う場合は、スペースの設定で、そのフォルダ（`gitbook-design/`）を対象にする。`.gitbook.yaml` の `root: ./` は、そのフォルダからの相対です。
4. 最初の同期の向きは「GitHub → GitBook」を選ぶ。
5. 同期のあと、目次、画像（`images/*.svg`）、表の表示を確かめる。

**方法 2：手で取り込む**

GitBook の取り込み機能（Markdown のファイルやフォルダの取り込み）を使う方法もあります。画面の名前と手順は変わることがあるので、取り込む時点の公式資料で確かめてください。

**この作業でしていないこと。** GitBook のアカウント作成、GitHub 連携の権限追加、push、公開。

## E.5 公開前に外すもの

この原稿は、あなたが設計を判断するための内部資料です。外部に公開する場合は、次を見直してください。

- 第10章と付録D の、内部のブランチ名、commit、作業の記録
- 未決定事項の「推奨」（決定と誤読されうる）
- 賞金、USDC、トークンの記述（法的確認が未了）
