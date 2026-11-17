# ⑦ 行軍の札：計画を読む → 判断する → 読めなければ調べ直す → やめて地図へ戻る（Lane C、2026-11-17）

- 固定の起点：`09490021ccee64368b2ef5ef5238f571077bf1f5`（下書きの同一性の訂正。保護します）。
- ブランチ：`claude/lane-c-ws07-march-card-retry-20261117`（独立。共通の集約は D だけが行います）。
- 扱う範囲：下書きと、読むことだけです。送信そのもの・`pendingDriver`・権限・手数料・資産・行軍の判定の決まりは、変えても実行してもいません。
- 試験・import・構文確認・ページ・実際の世界・guard・runner：**どれも実行していません**。回帰は書いただけで、実行していません。実際に動かして確かめたことはありません。

## 追った実際の利用側

- **道のりの要求**：`controller.setDestination`。呼ぶのは次の入口です：
  - `dest-from-map`
  - `dest-quick`
  - 座標の入力
  - `march-home`
  - `march-to`
- **札**（`hud/marchcard.mjs`）：
  - 行き先の行は、次の順に決まります：`c.route` があれば道のり → `c.routeError` があればその文 → どちらもなければ「道のりを探しています…」。
  - 着くターンは `composerArrival` から求めます。
  - 送信のボタンは、どちらも `c.route` を必要とします（ローカルプレイの「確認した命令で出発」も、通常の「封をして出発する」も）。
  - 「やめる」は `compose-close` です。
- **見込み**（`forecast`）：`app.mjs` の側で、`forecastKey` と `FS.compose === c` によって守られています。今回は変えていません。

## 実際の欠陥

1. **道のりを求める途中で例外になると、札が「道のりを探しています…」のまま変わりませんでした。** `setDestination` は、規則のモジュールを待ったあとの `planRoute`・`earliestBell`・`arrivalWindow` を、守らずに呼んでいました。例外になると、下書きには道のりも断りも入りません。わからない状態が、ずっと「探している」に見えていました。調べ直す手段もありませんでした。
2. **規則のモジュールを読めなかったとき、同じ下書きから調べ直せませんでした。** 文は出ますが、調べ直すには、同じマスを地図で選び直すか、座標を入れ直すしかありませんでした。
3. **道のりだけが先に書かれていました。** `c.route` を書いたあとで、いちばん早いターンと着くターンを求めていました。その途中で例外になると、道のりは出ているのに、着くターンは前のまま、という食い違いが残りました。

## 変更

- **`controller.setDestination`**
  - 要求のたびに、`routeUnread = false` に戻します。
  - 規則のモジュールがなければ、これまでの `routeError` に加えて、`routeUnread = true` を付けます。
  - 道のりの計算を `try` で包みます。
    - 「道がない」という答え（`!r.ok`）は、これまでどおり、断りとして書きます（`routeUnread` は付けません）。
    - 道のり・いちばん早いターン・着くターンは、先に求めてから、まとめて書きます。
    - 例外のときは、`route = null`、`routeError`、`routeUnread = true` とします。
  - 待ちは一度だけです。待ったあとの同一性の確認（下書きと行き先）は、前の束のままです。
- **`ACTIONS['dest-retry']`**（新しい一行）：下書きが指している行き先の座標で、もう一度 `setDestination` を呼びます。新しい行き先のオブジェクトなので、新しい要求です。送信中は、何もしません。
- **`hud/marchcard.mjs`**：道のりがなく、`routeUnread` のとき、行き先の行の下に、文と「道のりをもう一度調べる」のボタンを出します（送信中は、押せません）。
- **英語**：二つの文を、辞書の末尾に加えました。

## 変えていないこと（逆レビュー）

- **下書きの入力**：`setDestination` が消すのは、道のり・断り・いちばん早いターン・「時間が進んだ」の印だけです。構え・撤退・倍率・心づけ・「村へ戻す」の印・軍勢・村には触れません。調べ直しても、残ります。
- **着くターン**：道のりが出たときは、これまでどおり、いちばん早いターンに合わせます（どの行き先の選択でも同じ決まりです）。
- **取り消し・選び直し・続けての要求・世界の変化**：待ったあとの同一性の確認により、古い答えは、しまった下書きにも、新しい下書きにも、新しい行き先にも書かれません。ページの側の入口は、行き先のオブジェクトで自分の要求を見分けます。そのため、調べ直しのあとでは、前の要求は何も言いません。
- **送信**：`march-send`・`march-send-wait`・`pendingDriver`・送信前の確認は、そのままです。道のりがわからない下書きは、送信できません。
- **主の範囲・D の範囲**：`orderOf`〜`actOnce`・`providerWorld`・`viewerKey`・通常の操作・協力の部分・MCP には触れていません。`app.mjs` も変えていません。

## 集約のときの共有の部分（D 向け）

親のセッションに、書く前に知らせました。

- **`controller.mjs`**：`setDestination` と、`ACTIONS` の `'dest-quick'` のすぐ下の `'dest-retry'` の一行だけです。
- **`lang/en-frontier-play.mjs`**：末尾への追加だけです。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-march-card-retry-text.test.mjs`（P1–P7）：鍵を使わず、文字として読みます。前の回帰 `march-plan-flow` の M4 の一致を直しました。行軍の導線の五つの回帰について、文字列と順序が元のコードにあることを、文字の照合で確かめました。

## 実際に動かして確かめていないこと・仕様の境界

1. **実際の画面**：札の文とボタンの見え方、押したときの動きは、確かめていません。
2. **道のりがわからない間の着くターンの表示**：札は、これまでどおり、道のりがなくても着くターンの選び（`composerArrival` の範囲）を出します。今回は、「着くターンは、道のりがわかってから決まります」と添えるにとどめました。その間、選びを隠すか、押せなくするかは、札の設計の判断なので、広げていません。
3. **見込み（`forecast`）が読めなかったとき**：これまでの表示のままです（`app.mjs` の側で、今回の範囲の外です）。

## 次の集約のための一覧（D 向け）

起点は `09490021` です。先端と各ファイルの値（blob）は、push のあとに確かめます。モードはすべて 100644 です。

- `permutation-server/web/frontier/controller.mjs`（変更）
- `permutation-server/web/frontier/hud/marchcard.mjs`（変更）
- `permutation-server/web/lang/en-frontier-play.mjs`（末尾に追加）
- `permutation-gateway/test/web-frontier-ws07-march-card-retry-text.test.mjs`（追加）
- `permutation-gateway/test/web-frontier-ws07-march-plan-flow-text.test.mjs`（M4 の一致）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（追記）
- `docs/integration/CLAUDE-LANE-C-WS07-MARCH-CARD-RETRY-20261117.md`（この報告）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。
