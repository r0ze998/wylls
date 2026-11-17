# ⑦ 行軍の追跡：読めていないことを言い、一件ずつ読み直す（Lane C、2026-11-17）

- 固定の起点：`4b70799cdf68124b49a08cd4b1277b7f160fea7c`（広い地図の読み込みの印。保護します）。
- ブランチ：`claude/lane-c-ws07-march-track-read-20261117`（独立。共通の集約は D だけが行います。Lane C は、共通の集約を更新していません）。
- 扱う範囲：読むことと、表示だけです。**封を開ける送信（self-reveal・`io.reveal`）・結果の受け取り（settle）・送信の条件・頻度・権限・帳簿の保存の決まりは、変えても実行してもいません。**
- 試験・import・構文確認・ページ・実際の世界・guard・runner：**どれも実行していません**。回帰は書いただけで、実行していません。実際に動かして確かめたことはありません。

## 追った実際の経路

- **`controller.refreshMarches` → `readMarches`**：名前は読み込みですが、次のことも行います：
  - 帳簿を読む。
  - 到着のターン以降に、到着先の州の記録（`slotOf`）とターンの記録（`bellFacts`）を読む。
  - 条件が合えば、**封を開ける送信（`io.reveal`）を行い、帳簿に記す。**
  - 最後に、帳簿を保存し、`FS.marches` を書く。

  そのため、新しい読み直しのボタンからは、この関数を呼びません。
- **`screens/tracker.mjs`**：`FS.marches` の一件ずつを、進み具合（出発・到着・結果）として出します。結果が出た進軍には、「報告」「戦いを再生」「地図で見る」を出します。
- **結果の受け取り（`settleTransit`）**：`FS.marches` の一件の `entry` と `transit` を使います。

## 実際の欠陥

1. **一覧が空のとき、いつも「進軍中の軍勢はいません」と出ていました。** 次のときも、「いない」と出ていました：
   - 読み手の記録を読めず、`readMarches` まで進まなかったとき
   - 読み手を切り替えた直後
   - 世界が変わった直後
2. **到着先の記録を読めなかったことが、「まだ」と区別できませんでした。**
   - `slotOf` は、読み込みの失敗も、「そのターンの記録ではない」も、同じ `{env: null, slot: null}` で返していました。
   - `bellFacts` は、失敗も、「まだ記録がない」も、同じ空の事実で返していました。
   - そのため、追跡の札は、読めなかった進軍を、「鍵を待っている」「封がまだ」のように出していました。帳簿のない進軍は、「未確認」のままでした。
3. **世界が変わっても、前の世界の進軍の一覧が残りました**（次の `readMarches` が書くまで）。

## 変更

- **`controller.mjs`**
  - `slotOf`・`bellFacts`：これまでの戻り値に、`failed`（NotFound 以外の失敗）と `code` を**加えるだけ**です。`env`・`slot`・`facts`・`record` は、これまでと同じ値です。
  - `readMarches`：
    - 二つの読み込みの結果を変数に受け、各進軍に `unread`（どの読み込みが届かなかったか、符号）を付けます。帳簿のない進軍には、読み込みに使った行き先（`readDest`）も持たせます。
    - 最後の書き込みの横で、`FS.marchesRead` を記します。
    - **封を開ける送信の判断と実行、結果の受け取りの条件の行は、変えていません**（回帰で、その区間に新しい印が出てこないことを確かめます）。
  - `resetViewer`・`adoptPinnedWorld`：一覧を空にし、`FS.marchesRead = null` にします。帳簿は世界ごとの鍵で保存されているので、触れません。
  - `rereadMarchFacts`（新しい、純粋な読み込み）：
    - 対象は、`unread` の付いた一件です。到着のターン以降だけ読みます。
    - `slotOf` と `bellFacts` を呼び、その一件の `facts.pipeline`・`facts.slotPresent`・`unread` だけを書きます。
    - 帳簿・`io.reveal`・`slot`・`env`・`record`・`entry`・`transit`・`settleReady` には、触れません。
    - 書くのは、ヘラルド・ローカルプレイ・村・帳簿の鍵・世界・一覧・その一件が同じで、最後に押した要求のときだけです。
- **`app.mjs`**：`march-reread` の動作（一行）と、import を加えました。
- **`screens/tracker.mjs`**：一覧が空のときの文を分け、読めなかった進軍に、文とボタンを出します。
- **英語**：五つの文を、辞書の末尾に加えました。

## 封の中身と行き先

- 読み直しが尋ねるのは、`readMarches` がその進軍のためにすでに尋ねた、同じ州・同じターンだけです。到着のターンより前は、尋ねません。
- 文に出すのは、失敗の符号だけです。行き先や構えは、これまでどおり、この端末の札の中だけに出ます。新しく外へ出すものは、ありません。

## 変えていないこと（逆レビュー）

- **封を開ける送信・結果の受け取り・帳簿**：
  - `revealStep` の入力（`seen`・`pl`）は、同じ値です。
  - `settleReady` の式は、同じです。
  - 帳簿の保存の位置と内容も、同じです。
  - `rereadMarchFacts` は、これらを呼ばず、書きません。
- **同じ読み込みの通常の動き**：これまでどおり、`readMarches` は読み込みのたびに（通常は 10 秒ごと）全体を読み直します。読めなかった進軍は、そこでも自動で読み直されます。ボタンは、その一件を、今すぐ表示だけ読み直すためのものです。
- **世界・村・軍勢・行軍の同一性**：`rereadMarchFacts` の確認は、`readMarches` の `same()` と同じ項目に、一覧・その一件・押した番号を加えたものです。
- **ほかの利用側**：
  - `onboarding.mjs` と `app.mjs` の衝突の一覧は、`facts.pipeline` を表示のために読みます。読み直しで正しい値に近づくだけです。
  - `settleTransit` が読む `entry` と `transit` は、変えていません。
- **主・D の範囲**：`orderOf`〜`actOnce`・`providerWorld`・`viewerKey`・協力の部分・ターンの一覧・状態・MCP には触れていません。

## 集約のときの共有の部分（D 向け）

親のセッションに、書く前に知らせました。

- **`controller.mjs`**：次の箇所です。
  - `resetViewer` の一行
  - `adoptPinnedWorld` の数行
  - `slotOf`・`bellFacts` の戻り値
  - `readMarches` の印の行
  - その下の、新しい `rereadMarchFacts`
- **`app.mjs`**：controller の import の一語と、`HUD_ACTIONS` の `'march-reread'` の一行です。
- **`screens/tracker.mjs`**：一覧が空のときの文と、進軍ごとの一か所です。
- **`lang/en-frontier-play.mjs`**：末尾への追加だけです。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-march-track-read-text.test.mjs`（T1–T7）：鍵を使わず、文字として読みます。文字列と順序が元のコードにあることを、文字の照合で確かめました。前の回帰 `refreshers-world` の `readMarches` の順序も、そのまま成り立ちます。

## 実際に動かして確かめていないこと・残る境界

1. **実際の画面**：追跡の札の文とボタン、読み直しのあとの表示は、確かめていません。
2. **読み直しのあとの `slot`・`env`**：表示（進み具合）は更新しますが、結果の受け取りに使う `slot`・`env` は、次の `readMarches` まで前のままです（わざと変えていません）。「結果を受け取る」のボタンが出るかどうかは、これまでどおり `readMarches` が決めます。
3. **帳簿のない進軍で、行き先がわからないもの**：読み込みを始めていないので、`unread` は付きません。これまでどおり「未確認」です。行き先を外から決める仕組みは、採っていません。
4. **「報告」「戦いを再生」のボタン**：結果が出た（`resolved`）進軍にだけ出ます（これまでどおり）。読めていない進軍には、読み直しのボタンだけを出します。

## 次の集約のための一覧（D 向け）

起点は `4b70799c` です。先端と各ファイルの値（blob）は、push のあとに確かめます。モードはすべて 100644 です。

- `permutation-server/web/frontier/controller.mjs`（変更）
- `permutation-server/web/frontier/app.mjs`（変更）
- `permutation-server/web/frontier/screens/tracker.mjs`（変更）
- `permutation-server/web/lang/en-frontier-play.mjs`（末尾に追加）
- `permutation-gateway/test/web-frontier-ws07-march-track-read-text.test.mjs`（追加）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（追記）
- `docs/integration/CLAUDE-LANE-C-WS07-MARCH-TRACK-READ-20261117.md`（この報告）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。
