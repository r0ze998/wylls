# ⑦ シーズンの記録の答えを、尋ねた順に反映する（Lane C、2026-11-17）

- 固定の起点：`70b4462b713aedd77f6bf26c9795260443a1b391`（地図の範囲・環の概要の束）。この起点と、それより前の `9216ff3c`・`5648e770` は保護します。
- ブランチ：`claude/lane-c-ws07-season-world-20261117`（独立。共通の集約は D だけが行います）。
- 範囲：
  - `controller.mjs`：`askSeason`・`takeSeason`・`seasonStale`・`recordOfPin` を新しく加え、`refreshOverviews` のシーズンの記録の部分を変えました。
  - `app.mjs`：`loadSeason` の入口と import を変えました。
  - 前の束の回帰 `web-frontier-ws07-overviews-world-text.test.mjs`：import の一致だけを広げました（この束が import に名前を加えるため）。
- 試験・import・構文確認・ページ起動・実際の世界：**どれもしていません**。回帰は書いただけで、実行していません。

## 先に確かめた経路（実際に起こるかどうか）

- **起動**：`boot` は `await loadSeason(herald)` を一度待ちます。シーズンの読み込みの繰り返し（`createPollLoop`）は、そのあとに `start` します。
- **繰り返しの直列化**：`poll-loop.mjs` は、一度に一つずつしか読みません（`if (busy) { again = true; return; }`）。そのため **`loadSeason` 同士は重なりません**。
- **ヘラルド**：ページに一つです（`createHerald({ base: cfg.herald })`）。`season()` は `no-store` の普通の GET で、二つの要求を一つにまとめず、順番も付けません。12 秒で時間切れになります。
- **もう一か所の読み込み**：`controller.refreshOverviews` も `herald.season()` を尋ね、記録・範囲・環の一覧・`FS.season` を反映します。プレイの読み込み（`refreshConquest`）、出撃の計画、帰還地の計画から、`loadSeason` とは別の繰り返しで呼ばれます。前の束で、世界と世代は確かめるようにしましたが、**同じ世界の中の順番**は確かめていませんでした。
- **実際に起こる上書き**：二つの方向があります。
  - 先に尋ねた `refreshOverviews` の答えが遅く届き、新しい `loadSeason` の記録・範囲・`FS.season` を古いものに戻します。このとき固定・時計・ビーコンは新しいままなので、互いに食い違います。
  - その逆に、先に尋ねた `loadSeason` の答えが、あとの `refreshOverviews` の答えを上書きします。古い答えの失敗も、`FS.error` を立て、確かめ中の画面と送り出しの下書きを消します。
- 起こらないものは作っていません。`loadSeason` 同士、別のヘラルド、再起動による重なりは、上の理由で起こりません。

## 変更

- **答えの順番**：尋ねるたびに番号を一つ進めます（`askSeason`）。答えは、それよりあとに尋ねた答えがまだ反映されていないときだけ反映します（`takeSeason`）。
- **`loadSeason`**
  - 古い答えは、成功でも失敗でも `return true` で何も変えません（`seasonStale`。失敗の処理と固定より前で確かめます）。
  - 新しい失敗は、これまでどおりです。
  - ~~新しい答えは、何かを書く前に記します。~~ **誤り**：すべてを書き終えたあとで記します（下の「訂正」を見てください）。
- **`refreshOverviews`**：記録が固定している世界のもの（`recordOfPin`）で、しかも最新の答え（`takeSeason`）のときだけ反映します。固定・ビーコン・時計は、これまでどおり `loadSeason` だけが決めます。
- **`recordOfPin`**：次のものを比べます。読めない記録は false です。
  - クラスター（`'localnet'` を既定）
  - プログラム
  - シーズン（`String(BigInt(...))`。`seasonAddresses` と同じ形）
  - 記録が名乗るなら、シーズンの口座

## 変えていないこと（逆レビュー）

- **同じ世界の通常の読み込み**：番号は一つずつ増え、毎回反映されます。止まるのは、あとに尋ねた答えがすでに反映されているときだけです。
- **世界の切り替え**：最新の答えになった時点で反映されます。古い答えに止められることはありません。
- ~~**固定に失敗したとき**：番号は記しますが、何も反映しません（これまでどおり `FS.error`）。~~ **誤り**：固定に失敗したときは番号を記しません（下の「訂正」）。
- **`fagent.mjs` の `setPin`**：エージェント自身の状態（`S.pin`）に書き、ページの `FS` には書きません。今回は変えていません。
- **`flocalplay.mjs` の `season()`**：起動前の確認で、`FS` には反映しません。
- **一部だけ読んだ環の `applySeasonRecord`**：これまでどおり `worldRevision` と `FS.record` の同一性で守られています。古い記録が反映されなければ、その読み込みも書きません。
- **変数の範囲**
  - `seasonAsked` と `seasonTaken` は controller のモジュール変数です。
  - `app` の `seq` は `loadSeason` の中だけで使います。
  - `refreshOverviews` の `seq` は内側の `try` の中だけで使います。
  - 加えた名前は、既存の名前と衝突しません（grep で確認）。
- **禁止の範囲**：賞金・支払い・参加・claim・faucet・送金・資産・権限・ルールには触れていません。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-season-order-text.test.mjs`：鍵を使わず、`node:test`・`node:assert`・`node:fs` だけを使い、文字として読みます。

| 番号 | 確かめること |
|---|---|
| Q1 | なぜ起こるのか：ヘラルドの `no-store`、起動の順序、繰り返しの直列化、もう一か所の読み込み |
| Q2 | 番号 |
| Q3 | `loadSeason` の順序 |
| Q4 | `refreshOverviews` と `recordOfPin` |
| Q5 | 支払い・参加の文字がないこと |

書いた文字列と順序が元のコードにあることは、文字の照合で確かめました。テストとしては実行していません。

## 未決（範囲外）

1. **`loadSeason` の古い答えを捨てた回**：その回は `FS.chain.observe`（鎖の時計を進める唯一の読み込み）も、時計も動きません。次の読み込み（30 秒以内）で戻ります。`refreshOverviews` の読み込みは、ターンに一度ほどです。
2. **`recordOfPin` の形の比較**：プログラムは文字列として比べます。ヘラルドが別の形でプログラムを書いた場合、`refreshOverviews` は記録を反映しなくなるだけで、`loadSeason` は反映を続けます。
3. **`refreshOverviews` が反映したとき**：`FS.season` は新しくなりますが、`FS.clock` は次の `loadSeason` まで前のままです。これは起点からの動きです。

## 次の集約のための一覧（D 向け）

起点は `70b4462b` です。先端と各ファイルの値（blob）は、push のあとに `git ls-tree <tip> -- <path>` で確かめてください。モードはすべて 100644 です。

- `permutation-server/web/frontier/controller.mjs`（変更）
- `permutation-server/web/frontier/app.mjs`（変更）
- `permutation-gateway/test/web-frontier-ws07-season-order-text.test.mjs`（追加）
- `permutation-gateway/test/web-frontier-ws07-overviews-world-text.test.mjs`（import の一致だけを広げた）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（追記）
- `docs/integration/CLAUDE-LANE-C-WS07-SEASON-ORDER-20261117.md`（この報告）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。

## 訂正（2026-11-17、同じ日、ブランチ `claude/lane-c-ws07-season-order-fix-20261117`。起点 `4aac4aed`。`4aac4aed` は保留）

**誤り**：`4aac4aed` の `loadSeason` は、`setPin` で固定を確かめる**前**に `takeSeason(seq)` を実行していました。そのため、固定が拒否されると（`PinMismatch`・`RulesetMismatch`）、何も反映していないのに反映済みの番号が進みました。その結果、先に尋ねた有効な答え（`refreshOverviews` の分）が古いものとして捨てられました。このため、上に書いた「失敗は何も記録しない」は、`4aac4aed` では成り立っていませんでした。`refreshOverviews` も、条件の中で `takeSeason` を実行していました。そのため `applySeasonRecord` が例外で終わっても番号が進み、一部だけ書いたことを成功として扱っていました。

**直したこと**

- **確認と記しを分けました**：答えが古いかどうかは `seasonStale(seq)` で確かめます。反映済みとして記す `takeSeason(seq)` は、すべてを書き終えたあとだけ実行します。
- **`loadSeason`**
  - 待つのは読み込みの一度だけです（`await` は一つ）。古さの確認から最後の `takeSeason(seq); return true;` まで、途中で一度も待ちません。そのため、ほかの答えが確認と書き込みの間に入ることはありません。
  - 次のときは、どれも記さずに戻ります：
    - 古い答え（何もせず `true`）
    - 失敗（`false`。これまでどおり）
    - 固定の拒否（`false`。これまでどおり `FS.error`）
    - 書き込み中の例外（繰り返しの処理が受け止めます）
- **`refreshOverviews`**
  - 条件を `!seasonStale(seq)` にしました。`applySeasonRecord` と `FS.season` を書いたあとで `takeSeason(seq)` を実行します。この間も一度も待ちません。
  - 例外は、これまでどおり `catch { keep the last record }` が受け止め、何も記しません。
- **それぞれの場合の扱い**（既存の契約と照合しました）
  - **同時に届いた答え**：あとに尋ねた答えを反映したあと、先に尋ねた答えは成功でも失敗でも何も変えません。
  - **固定の拒否**：記さないので、先に尋ねた有効な答えが、あとから反映されることがあります。その答えも、固定している世界のものであることを確かめてから反映します。
  - **一部だけ書いたあとの例外**：記さないので、成功とは扱いません。一部だけ書かれた状態は、これまでと同じです。
- **回帰**：`web-frontier-ws07-season-order-text.test.mjs` を直しました（書いただけで、実行していません）。
  - Q3：順序を、固定の確認 → 拒否なら戻る → すべてを書く → 記す、に変えました。
  - Q4：`!seasonStale(seq)` と、書き込みのあとの `takeSeason` を確かめます。
  - Q6（新規）：待つのは一度だけ、記すのは一か所だけ、記しが成功の直前の最後の手順であること、`refreshOverviews` が条件の中で記していないことを確かめます。
  - 文字列と順序が元のコードにあることは、文字の照合で確かめました。
- **契約**：`CONTRACTS.ja.md` の「番号」の項を直し、「反映済みの記し方」と「記さない場合」を加えました。
