# ⑦ 観戦の追従と戦いの場面は、一つの世界の中だけで（Lane C、2026-11-17）

- 固定の起点：`30d6c549ff14f841bc10e749b3f8b94a584caac9`（遅れた開始の束）。この起点とそれより前は保護します。
- ブランチ：`claude/lane-c-ws07-spectate-world-20261117`（独立。共通の集約は D だけが行います）。
- 範囲：`app.mjs` の `playBattle`・`autoBattles`・`followBattles` だけです。
- 試験・import・構文確認・ページ・実際の世界・guard・runner：**どれも実行していません**。回帰は書いただけで、実行していません。

## 照合した実際の経路

- **観戦の流れ**：`startSpectate` の `tick` は、`refreshPlay`（controller の `refresh`。中で `refreshChronicle`）→ `spectateBells` → `followBattles` の順に進みます。失敗した回は `catch` に入り、追いません。
- **`followBattles`**：記録の中の最新の衝突を `watchSeen` と比べます。新しければ `playBattle(focus)` を呼び、それが false を返したら、代わりの位置へ `mapRef.flyTo` します。
- **`playBattle`**：`await heraldRef.clash(...)` のあとで、場面を組み立て、その州の `FS.provinces` と合わせます。`focus` ならカメラを動かします（`camKeep` と `flyTo`）。そして `FS.battles` と効果の層へ渡します。呼ぶのは次の四か所と、この束の追従です：
  - ターンの場面
  - 報告の「見る」（`leaveReport` のあと）
  - 見本の画面
  - `autoBattles`
- **`refreshChronicle`**：世界（世代を含む）が変わったら、記録を捨てて `FS.chronicleWorld` を記します（前の束）。
- **報告（`openReport`）**：もとから `reportWorld` で世界を確かめています。この束では変えていません。

## 実際の欠陥

1. **`watchSeen` に世界がありませんでした。** A → B のあと、B の記録の最初の衝突は A の最後の衝突と違うので、「新しい戦い」としてカメラが飛び、場面が始まりました（新しい世界の最初の読み込みで、偽の知らせが出ていました）。A → B → A でも同じです。
2. **`playBattle` は、待ったあとに世界を確かめていませんでした。** 世界が変わる前に尋ねた衝突でも、答えが届くと、前の世界の入力と新しい世界の州を合わせて場面を見せ、カメラを前の世界の座標へ動かしました。追従の場合は、false のときの代わりの `flyTo` も、前の世界の場所へ飛びました。答えを待つ間に観戦の自動の追従が切られたり、報告が開かれたりしても、カメラは奪われました。
3. **`autoBattles` の `battleSeen`（「州 → 最後に見た決着のターン」）にも世界がありませんでした。** 前の世界の値より新しい世界のターンが大きいと、同じ座標の州を「新しい」として場面を見せました。

## 変更

- **`followBattles`**
  - `momentWorld()` の世界のために読んだ記録（`FS.chronicleWorld`）のときだけ比べます。
  - 世界が変わったら `watchSeen` を空にします。最初に見えた衝突は基準にするだけで、知らせにしません。
  - `still`（同じ世界・自動の追従が入っている・報告が開いていない）を `playBattle` に渡します。代わりの位置への `flyTo` も、`still()` が成り立つときだけです。
- **`playBattle`**
  - 尋ねる前に、世界とヘラルドを取ります。待ったあと、世界かヘラルドが違うか、`still` が成り立たなければ false を返します。場面・`FS.battles`・カメラの移動・効果の層のどれより前に確かめます。
  - 待ちは一度だけです。`still` を渡すのは追従だけで、ほかの呼び出し元は世界とヘラルドだけを確かめます。
- **`autoBattles`**：世界が変わったら `battleSeen` を空にします。`world` の印がある別の世界の州の記録は見ません。印のない州の記録は、これまでどおり見ます。

## 変えていないこと（逆レビュー）

- **本人の操作は奪いません**：観戦の自動の追従・本人が開いた報告・報告の「見る」の動きは、これまでどおりです。「見る」は先に報告を閉じてから呼ぶので、`still` は渡しません。
- **同じ世界の中**：新しい衝突の追従・場面・カメラの移動は、これまでどおりです。
- **読み込みの失敗と、わからない状態**：失敗した回は追いません。記録がまだないときは、何も比べません。
- **変数の範囲**：
  - `world`・`source`・`still` は、それぞれの関数の中だけで使います。
  - `watchWorld` と `battleSeenWorld` は、app のモジュール変数です。
- **禁止の範囲**：支払い・賞金・claim・paidJoin・faucet・資産・権限・送信には触れていません。新しい文言もありません。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-spectate-world-text.test.mjs`：鍵を使わず、文字として読みます。

| 番号 | 確かめること |
|---|---|
| W1 | 追従が、一つの世界の記録だけで比べること |
| W2 | `still` と、代わりの飛行の条件 |
| W3 | `playBattle` が、待ったあとに確かめる順序 |
| W4 | `autoBattles` |
| W5 | まわりが変わっていないこと |

文字列と順序が元のコードにあることを、文字の照合で確かめました。

## 残る未完（具体）

1. **答えを待つ間に本人が動かしたカメラ**：衝突の答えを待つ間に、本人が地図を動かしても、追従は（これまでどおり）その衝突へ飛びます。観戦の自動の追従は、もともと飛ぶ機能です。「本人が動かしたあとは飛ばない」という決まりは今の仕様になく、加えると仕様を広げるので、していません。
2. **`playBattle` の中の、場面の組み立ての例外**（`battleScene` など）：これまでどおり、呼んだ側の `.then` には届きません。

## 次の集約のための一覧（D 向け）

起点は `30d6c549` です。先端と各ファイルの値（blob）は、push のあとに確かめます。モードはすべて 100644 です。

- `permutation-server/web/frontier/app.mjs`（変更）
- `permutation-gateway/test/web-frontier-ws07-spectate-world-text.test.mjs`（追加）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（追記）
- `docs/integration/CLAUDE-LANE-C-WS07-SPECTATE-WORLD-20261117.md`（この報告）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。
