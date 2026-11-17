# ⑦ 地図の範囲・環の概要と、領土が無効の世界の表示を、読んだ世界の中だけで反映する（Lane C、2026-11-17）

- 固定の起点：`9216ff3c8108013ac08d0ad8e5d1ae911e86595f`（賞金・行軍・領土の束。保護済み。その起点 `5648e770` も保護済み）
- ブランチ：`claude/lane-c-ws07-overviews-world-20261117`（独立。共通の集約は D だけが行います）
- 範囲：
  - `controller.mjs`：`refreshOverviews`、新しく加えた `adoptPinnedWorld` と `dropOtherWorldConquest`、`refreshConquest` の入口一行
  - `map/overviews.mjs`：共有の読み込み列
  - `app.mjs`：`loadSeason` に一行、`loadOverviews` に `source`、import 一つ
- 試験・import・構文確認・ページ起動・実際の世界：**今回はどれもしていません**。回帰は書いただけで、実行していません。

## 確かめた実際の経路と穴

1. **`refreshOverviews` の相乗りとキャッシュ**：`bell` とヘラルドだけで判断していました。同じヘラルドのまま固定し直すと（`loadSeason` は読むたびに `setPin` を呼びます）、前の世界で完了した `bell` を新しい世界でも「完了」とみなしていました。
2. **シーズンの記録の答え**：ヘラルドだけを確かめて `applySeasonRecord`（記録・範囲・環の一覧）と `FS.season` に反映していました。
3. **共有の読み込み列**：区別していたのは読み込み側（ヘラルド・方式）と範囲だけでした。二つの世界の範囲が同じなら、前の世界の答えが待ち時間を越えて新しい世界の `FS.overviews` に書かれました。外側の待ちのあとで確かめても、**中ではもう書かれています**。
4. **世界が変わったあと**：前の世界の `FS.overviews`・`overviewTaken`・`worldRings` が残りました。新しい世界の州の数が `overviewTaken` と同じ環は、読み直されず、前の世界の概要が見えたままでした。
5. **領土が無効の世界に移ったとき**：`refreshConquest` は入口で戻るため、前の世界の `FS.conquest` と `FS.s1` が残りました。次の利用側は、有効かを確かめずに読むので、**実際に漏れます**：
   - `hud/feed.mjs`：拠点の出来事
   - `fx/sheetfx.mjs`：拠点のマス
   - `screens/report.mjs`：拠点への賭け
   - `hud/inspect.mjs`：S1 の印
   - `s1walk.mjs`：構造物と関係

   なお、`map/keepmount.mjs` は `enabled` で止まります。

## 変更

- **`refreshOverviews`**
  - 相乗り・キャッシュ・要求に、世界 `w` を加えます。
  - `same()`（ヘラルドと世界）で、待ったあとの三か所をすべて確かめます。
  - 読み込み列に `source: providerWorld` を渡します。
  - 完了の印には `overviewWorld` を記します。
- **`map/overviews.mjs`**
  - 読み込みごとに `key`（作ったときの世界）を持たせます。
  - `keyGone` が真のとき、その読み込みは：
    - 始めずに false で終わります（`start`）。
    - 答えを保存しません（`.then`。`FS.overviews.set` より前）。
    - 片付けで false で終わります（`finally`）。
  - `source` の値が変わったら、読み込み側が替わったときと同じ処理をします。待っているものは false で終わり、飛んでいるものは上限の数に数えたまま、戻ってきたら捨てます。
  - `source` を渡さない呼び出し方（既存の試験など）は、`key` が変わらないので、これまでと同じです。
- **`adoptPinnedWorld`**
  - `loadSeason` が、固定の直後、記録を反映する前に呼びます。
  - 世界（世代を含む）が前回の読み込みと違うときだけ、次のものを忘れます：
    - `FS.overviews`（中身だけ。地図が同じ入れ物を持っているため）
    - `overviewTaken`、`worldRings`
    - 完了の印
    - 領土と S1
  - 最初の固定と、同じ世界の固定では、何もしません。
- **`refreshConquest`**：入口で `dropOtherWorldConquest(providerWorld())` を呼んでから、有効かを確かめます。

## 変えていないこと（逆レビュー）

- **同じ世界の中**：次のものはどれも変わりません：
  - 同時に四つまでの読み込み（`OVERVIEW_IN_FLIGHT=4`）と、優先の並び
  - `rebase` と、範囲の比較・読み直し
  - 一部だけ読めたときに完了にしないこと
  - 失敗しても最後に読めたものを残すこと
  - 「まだわからない」の出し方
- **禁止の範囲**：賞金・支払い・参加・claim・faucet・送金・資産・権限・ルールには触れていません。
- **変数の範囲**
  - `overviewWorld` と `readsWorld` はモジュールの `let` です。使うのは実行時だけなので、宣言より前に使う問題はありません。
  - `providerWorld` と `dropOtherWorldConquest` は関数宣言です。
  - `refreshOverviews` の中の `world` は内側の `FS.world` のままです。要求の世界は `w` と `request.world` で、名前が衝突しません。
  - `app` の `momentWorld` は、`controller.providerWorld` と同じ文字列です。`FS.pin` は `setPin` が返した、固定そのものです。
- **前の束の回帰**（`web-frontier-ws07-refreshers-world-text.test.mjs`）が見ている文字列は残しています。`refreshConquest` の中の作り直しの行もそのままで、入口の削除と重なっていても害はありません。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-overviews-world-text.test.mjs`：鍵を使わず、`node:test`・`node:assert`・`node:fs` だけを使い、文字として読みます。

| 番号 | 確かめること |
|---|---|
| O1 | `refreshOverviews` の順序と、ヘラルドだけを見る確認が残っていないこと |
| O2 | 読み込み列の `key`、`keyGone`、取り消し |
| O3 | 同じ世界の中では変わらないこと |
| O4 | `loadSeason` の順序と、両方の呼び出し側が同じ世界を渡すこと |
| O5 | `adoptPinnedWorld` |
| O6 | 領土が無効の世界でも、前の世界のものを捨ててから確かめること、と確かめずに読む利用側 |

書いた文字列と順序が元のコードにあることは、文字の照合で確かめました。テストとしては実行していません。読み込み列の動きを確かめる試験（`map/overviews.mjs` は `fi18n.mjs` を読み込みません）を書くかどうかは、調整役が決めます。

## 未決（範囲外）

1. **`loadSeason` 自身のシーズン記録**：固定を決める答えなので、世界の確認の対象ではありません。二つの `loadSeason` が同時に走った場合は確かめていません。
2. **`fagent.mjs` の `setPin`**：エージェント側の固定です。同じページで固定し直す経路はないと見ていますが、確かめていません。この場合も、読み込み列と `refreshConquest` の確認は効きます。
3. **`applySeasonRecord` の、一部だけ読んだ環の読み込み**：`FS.record` が同じものかどうかで守られています。今回は変えていません。

## 次の集約のための一覧（D 向け）

起点 `9216ff3c`、先端は push のあとに確かめます（`git ls-tree <tip> -- <path>`）。モードはすべて 100644 です。

- `permutation-server/web/frontier/controller.mjs`（変更）
- `permutation-server/web/frontier/map/overviews.mjs`（変更）
- `permutation-server/web/frontier/app.mjs`（変更）
- `permutation-gateway/test/web-frontier-ws07-overviews-world-text.test.mjs`（追加）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（追記）
- `docs/integration/CLAUDE-LANE-C-WS07-OVERVIEWS-WORLD-20261117.md`（この報告）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。
