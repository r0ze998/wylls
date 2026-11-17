# ⑦ 報告の「戦いを再生」「見る」：読めるまで報告を残す（Lane C、2026-11-17）

- 固定の起点：`b1e74de48394cd93cc90f9301144f6098a50c949`（戦いの世界の同期の束。保護します）。
- ブランチ：`claude/lane-c-ws07-report-play-20261117`（独立。共通の集約は D だけが行います）。
- 範囲：
  - `app.mjs`：`leaveReport` のすぐ下に `playAsked` を加え、`battle-play` の動作を一行変えました。
  - `screens/report.mjs`：`renderHeadline` のボタンの行だけです。
  - `lang/en-frontier-play.mjs`：末尾に英語のキーを二つ加えただけです。
  - 前の回帰 `spectate-source` の一致。

  共有のファイル（英語の辞書と `report.mjs`）は、書く前に、ファイルの場所と起点の値（blob）を親のセッションに知らせました。主の通常の建設・訓練の画面の部分には触れていません。
- 試験・import・構文確認・ページ・実際の世界・guard・runner：**どれも実行していません**。回帰は書いただけで、実行していません。

## 照合した実際の経路

- **送る場所**：`battle-play` は、次の五か所から送られます：
  - 報告の「戦いを再生」（`screens/report.mjs`）
  - 追跡の一覧（`screens/tracker.mjs`）
  - お知らせの「見る」（`hud/feed.mjs`）
  - 調べる画面（`hud/inspect.mjs`）
  - ターンの一覧（`hud/turnlist.mjs`）
- **起点の動作**：`'battle-play': d => { leaveReport(); closeDialPop(); playBattle(…, { focus: true }); }` です。読む前に報告を閉じ、`playBattle` の結果は使っていませんでした。
- **`playBattle` の結果**（前の束）：
  - true：場面を見せた
  - false：場面がない（衝突を読めない・見せる場面がない）
  - null：世界やヘラルドの変化による取り消し

  例外は、場面を組み立てる中で起こりえます。
- **報告の誤りの表示**：`r.error` は、報告そのものを読めなかったときの表示です（`openReport`）。再生の失敗を出す場所はありませんでした。

## 実際の欠陥

**読む前に報告を閉じていました。** 衝突を読めないと、場面は出ず、報告の情報も、もう一度押す手段（報告のボタン）も失われ、何も表示されませんでした。

## 変更

- **`battle-play`**：`playAsked(p, q, bell)` だけを呼ぶようにしました。
- **`playAsked`**：
  - 押した番号、押したときに開いていた報告、その世界を記します。
  - その報告には `playing` を付けます（「読み込んでいます」）。
  - 結果は `try` の中で受け取ります。例外は失敗として扱います。
  - 答えるのは、最後に押したものだけです。
  - **true**：その報告がまだ開いていれば、閉じます。
  - **false または例外**：その報告がまだ開いていて、世界も同じなら、`playFailed` を付けます。
  - **null**：何もしません。
- **`renderHeadline`**：ボタンの下に、`playing` なら読み込み中の文、`playFailed` なら残したことと、もう一度押せることの文を出します。ボタンはそのままで、押せば読み直します。
- **英語**：二つの文の英語を加えました。禁止の語は使っていません。

## 変えていないこと（逆レビュー）

- **場面そのもの**：`playBattle(focus)` の明示の要求のままで、`auto` も `still` も渡しません。そのため、自動の場面や追従を新しい場面で止める決まりにも、取り消しの条件にも入りません。カメラ・ルール・結果は変えていません。
- **報告の外から押したとき**（お知らせ・追跡・調べる画面・ターンの一覧）：報告がなければ印を付けず、閉じるものもありません（これまでどおり）。読む間に本人が報告を開いたら、それは閉じません。
- **二度押し・別の戦い・読み直し**：最後に押したものだけが報告を閉じ、印を付けます。前に押した分の場面が先に届いた場合は、その場面は（これまでどおり）見せます。同じ州の場面は一つで、後の場面に置き換わります。
- **世界の変化**：`loadSeason` が報告を閉じます。`playBattle` は null を返すので、古い要求が報告を戻したり、印を付けたりすることはありません。
- **変数の範囲**：
  - `playAskSeq` は app のモジュール変数です。
  - `rep`・`world`・`req`・`ok` は `playAsked` の中だけで使います。
  - `reportWorld` は、実行時に読む `const` です。
- **禁止の範囲**：支払い・賞金・claim・資産・権限・送信には触れていません。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-report-play-text.test.mjs`：鍵を使わず、文字として読みます。

| 番号 | 確かめること |
|---|---|
| R1 | 答えを待ってから報告を扱うこと |
| R2 | `playAsked` の順序 |
| R3 | 明示の要求のままであること |
| R4 | 報告の表示 |
| R5 | 英語と禁止の語 |
| R6 | 五か所が同じ動作を送ること |

前の回帰 `spectate-source` の一致（S5）も直しました。文字列と順序が元のコードにあることを、文字の照合で確かめました。

## 残る未完（具体）

1. **報告の外から押して失敗したとき**：お知らせ・追跡・調べる画面・ターンの一覧には、これまでどおり何も出ません。ボタンは残るので、もう一度押せます。そこへ表示を加えるのは、各画面の部分に手を入れることになるので、今回はしていません。
2. **読む間のボタン**：押せないようにはしていません。二度押しは、最後のものだけが答えます。

## 次の集約のための一覧（D 向け）

起点は `b1e74de4` です。先端と各ファイルの値（blob）は、push のあとに確かめます。モードはすべて 100644 です。

- `permutation-server/web/frontier/app.mjs`（変更）
- `permutation-server/web/frontier/screens/report.mjs`（変更）
- `permutation-server/web/lang/en-frontier-play.mjs`（末尾に追加）
- `permutation-gateway/test/web-frontier-ws07-report-play-text.test.mjs`（追加）
- `permutation-gateway/test/web-frontier-ws07-spectate-source-text.test.mjs`（一致を直した）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（追記）
- `docs/integration/CLAUDE-LANE-C-WS07-REPORT-PLAY-20261117.md`（この報告）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。
