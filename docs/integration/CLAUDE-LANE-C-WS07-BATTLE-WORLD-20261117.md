# ⑦ 始まっている戦いの場面と、終わったあとのカメラの戻り（Lane C、2026-11-17）

- 固定の起点：`391e39de2769e499ce50e49701cb0b29a5eadd9c`（観戦の要求ごとの出自の束。保護します）。
- ブランチ：`claude/lane-c-ws07-battle-world-20261117`（独立。共通の集約は D だけが行います）。
- 範囲：
  - `app.mjs`：`playBattle` のカメラの部分、`endOtherWorldBattles`、`autoBattles` の一行、`followBattles` の `still`、import 一つ。
  - `fx/battle.mjs`：`cancelStagedPlay` と、各登録への `play` の追加。
  - `fx/stage.mjs` と `fx/sheetfx.mjs`：`battle:end` の受け手。
  - 前の回帰二つ：一致を直しました。
- 試験・import・構文確認・ページ・実際の世界・guard・runner：**どれも実行していません**。回帰は書いただけで、実行していません。

## 照合した実際の経路

- **`playBattle(focus)` のカメラ**：`camKeep.keep('battle')` で位置をとっておきます（最初の一回が `back` か `drop` まで有効）。`mapRef.flyTo` のあと、`battleBack = setTimeout(() => camKeep.back('battle', { slack: Infinity }))` で戻ります。`back` が見るのは `camKeep.touch()` の回数だけです（`slack: Infinity` のため）。`touch` は、ページの捕捉の受け手が呼びます：6px を超えるドラッグ・ホイール・キー・地図のボタン。
- **場面**：`startBattle` で場面を始め、`FS.battles` に入れ（地図の描画、`battleTiles` で人物を隠す）、`fxEmit('battle')` を送ります。
  - `fx/stage.mjs` の `stageBattle` は、`dur` の間、暗くする効果・場面・題字を描きます。`play.off` は見ません。
  - `fx/sheetfx.mjs` はシートの人物を描きます。登録の前なら `play.off` を見ます。
- **地図**：`setView` が自動でなければ `moves++` します。`pointerdown`・ホイール・キーで `touchedAt = clock()` になります（地図の「人が触れている」の印）。飛んでいるカメラを指で止めるだけの操作は `userMoved` を立てますが、`moves` は増やさず、`touchedAt` は変えます。

## 実際の欠陥

1. **終わりの時計が世界を確かめませんでした。** A でとっておいた位置へ、B に変わったあとで戻っていました。さらに、`keep` は最初の一回が有効なので、B の戦いは A の位置をとっておいたままにし、その時計も A の位置へ戻りました（前の世界の記憶が、新しい世界の戻りを汚していました）。
2. **始まっている場面が残りました。** A の場面は、世界が変わったあとも B の地図に描かれました（`FS.battles` と、効果の層の `dur` の間）。
3. **飛行を止めるだけの指の操作が見えていませんでした。** `camKeep.touch` も `moves` も増えないので、戦いのあとの戻りや観戦の追従が、止めたカメラをまた動かしていました。

## 変更

- **場面に世界を持たせます**：`play.world = world`（尋ねたときの世界）。
- **とっておいた位置**：
  - `battleKeepWorld` が今の世界と違えば、時計を止め、`camKeep.drop('battle')` で手放してから、今の世界でとっておきます。
  - とっておいた時の `map.touchedAt` を記します。
  - 時計が戻るのは、同じ世界で、しかも `touchedAt` が変わっていないときだけです。そうでなければ手放し、カメラは動かしません。
- **`endOtherWorldBattles`**：`autoBattles` が世界の変化を見たときに呼びます。ほかの世界の印がある場面を `FS.battles` から外し、`endBattle` と `fxEmit('battle:end', { play })` を行います。
- **効果の層**：
  - `fx/battle.mjs` の `cancelStagedPlay(play)`：その場面の登録だけを取り消します（三つの登録が `play` を持つようにしました）。
  - `fx/stage.mjs` と `fx/sheetfx.mjs`：`battle:end` で、その場面の分だけを取り消します。同じ場所の別の場面は残します。
- **追従の `still`**：`map.touchedAt` が同じであることも条件にしました。

## 守れることの範囲（言い過ぎないように）

- **観戦の自動の追従の切り替え（`auto: false`）と、開いた報告**：追従は、要求を待つ間も守ります（前の束）。
- **人のカメラ操作**：地図の二つの記録で見分けます。
  - `moves`：ドラッグ・ホイール・ピンチ・キーやボタン・名前で頼む移動
  - `touchedAt`：指で触れた（止めるだけを含む）・ホイール・地図のキー

  タイルを選ぶだけのタップも `touchedAt` を変えるので、そのときも戻りや追従を取り消します（取り消す側に倒れます）。地図の外の HUD の操作は、地図の記録には入りません。
- **自動の追従をずっと止める仕様は採っていません**：次の新しい衝突では、また働きます。
- **世界が変わってから場面が終わるまで**：最大で約 1 秒です。`autoBattles` は、地図の人物の層を一秒ごとに作るときに呼ばれるからです。

## 変えていないこと（逆レビュー）

- **同じ世界の中**：場面の終わりで戻ること（人が触れていなければ）・明示の「見る」・最新の場面を優先すること・前の束の `null` と `false` の区別は、これまでどおりです。
- **時計と非同期の経路**：
  - 終わりの時計は、`battleBack = null` を先に書いてから判断します。
  - `playBattle` の待ちは一度だけです。
  - 効果の層の取り消しは、同期の受け手です。シートの人物は、登録の前なら `play.off` で止まり、登録のあとなら `battle:end` で止まります。
- **変数の範囲**：
  - `battleKeepWorld`・`battleTouched` は app のモジュール変数です。
  - `scenePlays` は `installSheetFx` の中の変数です。
  - `cancelStagedPlay` は battle.mjs の `staged` を使います。
- **禁止の範囲**：支払い・賞金・claim・paidJoin・faucet・資産・権限・送信には触れていません。新しい文言もありません。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-battle-world-text.test.mjs`：鍵を使わず、文字として読みます。

| 番号 | 確かめること |
|---|---|
| T1 | 場面の世界 |
| T2 | とっておいた位置と時計 |
| T3 | ほかの世界の場面を終えること |
| T4 | 効果の層の取り消し |
| T5 | 追従の `touchedAt` |
| T6 | 頼っている既存の決まり |

前の回帰 `spectate-source`・`spectate-world` の一致も直しました。「止めるだけの操作は見えない」という記述は、`touchedAt` で見えるようになったことを反映しました。三つの回帰について、文字列と順序が元のコードにあることを、文字の照合で確かめました。

## 次の集約のための一覧（D 向け）

起点は `391e39de` です。先端と各ファイルの値（blob）は、push のあとに確かめます。モードはすべて 100644 です。

- `permutation-server/web/frontier/app.mjs`（変更）
- `permutation-server/web/frontier/fx/battle.mjs`（変更）
- `permutation-server/web/frontier/fx/stage.mjs`（変更）
- `permutation-server/web/frontier/fx/sheetfx.mjs`（変更）
- `permutation-gateway/test/web-frontier-ws07-battle-world-text.test.mjs`（追加）
- `permutation-gateway/test/web-frontier-ws07-spectate-source-text.test.mjs`（一致を直した）
- `permutation-gateway/test/web-frontier-ws07-spectate-world-text.test.mjs`（一致を直した）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（訂正と追記）
- `docs/integration/CLAUDE-LANE-C-WS07-BATTLE-WORLD-20261117.md`（この報告）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。
