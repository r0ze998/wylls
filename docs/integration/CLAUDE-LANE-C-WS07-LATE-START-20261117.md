# ⑦ 遅れた開始・途中の失敗のあとも、プレイは読み続ける（Lane C、2026-11-17）

- 固定の起点：`a79f36afb1c94565c9a5fb230298c58adc9cf0fa`（一部だけ反映した読み込みの束）。この起点とそれより前は保護します。
- ブランチ：`claude/lane-c-ws07-late-start-20261117`（独立。共通の集約は D だけが行います）。
- 範囲：
  - `controller.mjs` の `startPlay`（最初の読み込みを守る `try` と、二度目の同期の守り）
  - `hud/drawer.mjs` の `viewerState`（一行）
  - `app.mjs` の `startWithSeason`
  - 前の束の回帰 `web-frontier-ws07-season-partial-text.test.mjs`（S2・S3 の一致）
- 試験・import・構文確認・ページ・実際の世界・guard・runner：**どれも実行していません**。回帰は書いただけで、実行していません。

## 実際の関数から確かめたこと

- **`startPlay` の戻り値**：値を返しません（`async` で `undefined`）。前半で、ウォレットの出来事の受け手（`wallet.onChange`）を登録します。そのあと次の順に進みます：
  1. 前回のウォレットへの静かな再接続
  2. `fsession.restore`（`catch` がない）
  3. `kernelOrNull`（`catch` がある）
  4. `syncConnectedWallet`（中の `refresh` に `catch` がない）
  5. `await refresh()`
  6. ローカルプレイの本人確認
  7. `walletEventsReady = true`
  8. 二度目の同期
  9. プレイの読み込みの繰り返しを作る

  `refresh` は、`loadEnvelope`・`refreshMarches`・`refreshConquest`・`refreshChronicle`・`refreshHomes` を待ちます。プレイの繰り返し自身も、`refresh` を `try` で包んでいます。つまり **`refresh` は例外になりうる** という前提です。
- **ページの側の流れ**：`.catch(console…).then(() => { FS.playReady = true; FS.viewerMissed = !!FS.wallet && !FS.land; })` のあと、`.finally(() => viewerKnown = true)` です。
- **`FS.land`**：ウォレットを受け入れた時点で、`landState(null)`（`{stage: 'none'}`）が入ります。そのため `viewerMissed` は、ほとんど偽になります。

## 実際の欠陥

1. **最初の読み込みの例外で、プレイが二度と読まなくなりました。** 再接続・同期・最初の `refresh` のどこかが例外になると、`startPlay` はそこで終わりました。このとき次のことが起きていました：
   - `walletEventsReady` が真にならず、ウォレットの切り替えも追われない。
   - プレイの読み込みの繰り返しが作られず、ページは二度と読まない。
   - それでもページの側は `playReady = true` にしていた。
2. **答えを待つ間が「未参加」に見えました。** `viewerState` は `FS.land` があると `known` を返します。そのため、次のときに `known`・`stage: 'none'` となり、参加の流れが開けました（`joinOpen` は `playReady` と `known` で決まります）。村を持つ人に、国の選択が出ることがありました。
   - ウォレットを切り替えて、その記録の答えが来る前
   - 開始の最初の読み込みが、記録を尋ねる前に例外になったあと
3. **`startWithSeason` が、始める前に「済み」と記していました**（`a79f36af`）。そのため、中の同期の手順（練習の設定・観戦の開始・協力の掲示板）が例外になると、やり直されませんでした。起動時の呼び出しは `try` の外なので、その例外で `boot` が止まり、シーズンの読み込みの繰り返しも始まりませんでした。

## 変更

- **`startPlay`**
  - 再接続から最初の `refresh` までを一つの `try` にしました。失敗は `console.error('frontier first read:')` に記し、開始を続けます。
  - ローカルプレイの本人確認は、そのあとも行います。市民をまだ読めていなければ、固定だけを確かめます（`localPlayIdentityOk` は、市民が null なら固定だけを見ます）。
  - `walletEventsReady`、二度目の同期（`try`）、プレイの読み込みの繰り返しは、必ず行います。
  - 戻り値と、ページの側の流れは変えていません。
- **`viewerState`**：`unreachable` の判断のすぐあと、`FS.land` の判断より前に、一行を加えました。ウォレットがあり、`meStatus === 'loading'` で、まだ答えがなく、市民も村もなければ `pending` です。
  - 既存の試験（`web-frontier-wave3-hud`・`ws07-me-answered`）の場合は、`meStatus` が未定義か、答えのあとです。そのため、どれも結果は変わりません（文字で照合）。
- **`startWithSeason`**
  - 手順ごとに `started` へ印を付け、実行し終えてから記します。
  - 観戦・協力の掲示板・プレイは、一度しか実行しません。プレイは `startPlay` を呼ぶ前に記します。`async` なので、同期の例外は出ません。
  - 協力の掲示板は、それだけを `try` で包みます。失敗してもプレイを止めず、次の成功した読み込みで入れ直します。
  - 全体も `try` で包みます。`seasonStarted` は、すべての手順が済んだときだけ真にします。環の概要の読み込みは、繰り返しても同じ要求が一つにまとまります。

## 照合して、欠陥がなかったもの

- **最初の地図**（`map/fmap.mjs` の `open`）：本人がカメラを動かすまで（`cam.userMoved`）、毎回、開く位置を計画し直します。主題が変われば向け直します（`openKey`）。遅れて始まっても、村が届けば `home` になり、本人が動かしたカメラは奪いません。起動に失敗したとき `viewerKnown = true` で開き、まず全体の地図が出ることは、これまでどおりです（直すと仕様を広げることになるので、していません）。
- **世界の切り替え・A → B → A・答えの順番・回復**：今回、触れていません。

## 変えていないこと（逆レビュー）

- **成功したときの順序と内容**：同じです。
- **変数の範囲**：
  - `last`・`entry`・`c`・`restored` は `try` の中だけで使います（あとでは使いません）。
  - `started` と `seasonStarted` は `boot` の中の変数です。
- **禁止の範囲**：支払い・賞金・claim・paidJoin・faucet・資産・権限・送信には触れていません。新しい文言もありません。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-late-start-text.test.mjs`：鍵を使わず、文字として読みます。

| 番号 | 確かめること |
|---|---|
| P1 | 最初の読み込みの守りと、そのあとに必ず来る手順。守られていない待ちが残っていないこと |
| P2 | 戻り値と、ページの側の流れが変わっていないこと |
| V1 | `pending` の行の位置 |
| B1 | 手順ごとの印と、一度しか実行しないこと |
| M1 | 最初の地図が変わっていないこと |

文字列と順序が元のコードにあることを、文字の照合で確かめました（この束、`season-partial`、`season-recovery`）。

## 残る未完（具体）

1. **`startPlay` の、守りの `try` より前の部分**：`useHerald`・`loadUi`・`wallet.discover`・`listWallets` です。同期の処理で、例外は起こりにくいと見ていますが、示せてはいません。例外になれば、これまでどおり開始はそこで終わります。
2. **起動に失敗したあとの最初の地図**：まず全体の地図を出し、村が届いてから村へ向かいます。待ってから開く形（UX §12.3）は、起動に失敗した場合には採っていません。
3. **`viewerMissed`**：`FS.land` が常に入っているので、事実上いつも偽です。本当に答えがなかったときは、`meStatus`・`meAnswered` が判断します。この欄の扱いは、今回は変えていません。

## 次の集約のための一覧（D 向け）

起点は `a79f36af` です。先端と各ファイルの値（blob）は、push のあとに確かめます。モードはすべて 100644 です。

- `permutation-server/web/frontier/controller.mjs`（変更）
- `permutation-server/web/frontier/app.mjs`（変更）
- `permutation-server/web/frontier/hud/drawer.mjs`（変更）
- `permutation-gateway/test/web-frontier-ws07-late-start-text.test.mjs`（追加）
- `permutation-gateway/test/web-frontier-ws07-season-partial-text.test.mjs`（S2・S3 の一致）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（追記）
- `docs/integration/CLAUDE-LANE-C-WS07-LATE-START-20261117.md`（この報告）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。
