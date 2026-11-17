# ⑦ 賞金・行軍・領土の読み込みを、読んだ世界の中だけで反映する（Lane C、2026-11-17）

- 固定の起点：`5648e7701ba035ba3c3c3fdf1d956f331fe66567`（⑦ 世代の束。保護済み。旧 `ddd418bc` は廃止のまま）
- ブランチ：`claude/lane-c-ws07-refreshers-world-20261117`（独立。共通の集約は D だけが行います）
- 範囲：`permutation-server/web/frontier/controller.mjs` の `refreshPrize`・`readMarches`（`refreshMarches` が呼ぶもの）・`refreshConquest` と、その読み込み専用の補助 `refreshS1`・`refreshKeepEvents`・`wantKeepHistory`。それ以外の関数は変えていません。
- 試験・import・構文確認・ページ起動：**今回はどれもしていません**。回帰は書いただけで、実行していません。

## 何を直したか

起点では、三つの読み込みが待ったあとに書く前に確かめていたのは、次のものだけでした。

| 読み込み | 起点で確かめていたもの | 抜けていたもの |
|---|---|---|
| `refreshPrize` | ウォレットのアドレスだけ | 中継先（relay）、固定の世界とその世代 |
| `readMarches` | ヘラルド・ローカルプレイ・村・帳簿の鍵 | 世代（帳簿の鍵はクラスター・プログラム・シーズンを含むが、何回目の固定かは含まない） |
| `refreshConquest` と補助 | 要求の番号（`useHerald` でも進む） | 世界：同じヘラルドのまま固定し直すと、番号は進まない |

さらに、`FS.conquest` と `FS.s1` は世界が変わっても作り直されませんでした。次のことが起こり得ました。

- 前の世界の順位が新しい世界の順位を「古い」として退ける（`next.bell >= cq.standings.bell`）。
- 前の世界で読んだ日の記録が、新しい世界でも読み済みのまま残る（`eventDays`）。
- 失敗や NotFound のときに、前の世界の隊商・構造物・国家がそのまま残る。

変更は次のとおりです。

- **`refreshPrize`**
  - ウォレット・中継先・世界（`providerWorld()`、世代を含む）を、読む前に取ります。
  - 賞金の情報と成績表は、どちらも待ったあとに `current()` が成り立つときだけ書きます。
  - この理由で捨てた読み込みは、`prizeReadAt` がまだ自分の値のときだけ 0 に戻します。新しいウォレット・中継先・世界ですぐ読み直せるようにするためです。同じ世界の間隔は変えていません。
- **`readMarches`**：読み込みの身元 `at` に `world` を加え、`same()` で比べます。最後の書き込みは、すでに `same()` を条件にしています。
- **`refreshConquest`**
  - `current()`（要求の番号と世界）を一つ作り、待ったあとの確認四か所をすべてこれで行います。
  - 世界が変わったら、`FS.conquest` を `status: 'loading'` から作り直し、`world` の印を付けます。
- **`refreshS1(current, world)`**
  - 待ったあとの確認に、受け取った `current()` を使います。
  - 別の世界の `FS.s1` は捨て、印を付けて作り直します。
- **`refreshKeepEvents(cq, current)`**：待ったあとの確認に、受け取った `current()` を使います。
- **`wantKeepHistory`**：答えを書くのは、`cq.world` が今の世界と同じときだけです。次の `refreshConquest` までの間に、前の世界の状態へ書かないためです。
- **印のない状態**（デモが作るものなど）は `world ?? null` で「世界なし」として比べます。

## 変えていないこと（逆レビューで確かめた範囲）

- **賞金・支払い・参加**
  - `paidJoin`・`faucet`・`payAndJoin`・claim・送金・資産・権限の意味と実行は変えていません。
  - 参加の経路は、今も `FS.prize` で決まります（`if (FS.prize) return paidJoin(...)`）。
  - 世界が変わったときに `FS.prize` を消すことは**していません**。消すと参加の経路が変わるからです（下の未決を見てください）。
- **行軍の送信**：自分で鍵を出す送信（`io.reveal`）と、その帳簿への記録（`recordAttempt`・`saveBook`）は、世界の確認の対象にしていません。送信の意味は変えていません。
- **同じ世界の中**
  - `current()` は、ウォレット・中継先・世界が同じなら、起点の確認と同じ結果になります。
  - 順序・間隔・「読み込み中」と「まだわからない」の出し方は変えていません。
  - 一度に一つの読み込み（`marchesRun`/`marchesNext`）もそのままです。
- **変数の範囲**
  - `providerWorld` はモジュールの関数宣言です（`refreshPrize` より後ろで宣言されていても使えます）。
  - 新しい名前（`relay`・`world`・`current`・`at.world`）は、どれも各関数の中だけのものです。同じ名前の外側の変数を隠していません。
  - `request` は、`refreshConquest` の中の `current()` でだけ使います。
  - `conquestRefresh` が出てくるのは四か所です：宣言・`useHerald`・取得・比較。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-refreshers-world-text.test.mjs`：鍵を使わず、`node:test`・`node:assert`・`node:fs` だけを使い、`controller.mjs` を**文字として**読みます。

| 番号 | 確かめること |
|---|---|
| R1 | 賞金：取得 → 確認 → 書き込みの順。確認は待つたびに一つずつ、計二つ。間隔の制限そのものは変わっていない |
| R2 | 支払い・参加・テストトークンの受け取りが変わっていない |
| R3 | 行軍の身元が世界を持つ。送信は世界の確認の対象外 |
| R4 | 領土：`current()` での確認が四つ。作り直しは「読み込み中」から |
| R5 | 補助が同じ `current()` を使う。S1 と拠点の履歴が世界ごと |
| R6 | 要求の番号だけを見る確認が残っていない |

書いた文字列が、変更後の元のコードにすべてあることは、文字の照合で確かめました。テストとしては実行していません。動きを確かめる試験は、元のコードを読み込むと `fi18n.mjs`・`lang.mjs` も読み込まれるため書いていません。どう扱うかは調整役が決めます。

## 未決（今回の範囲外。決めていただく必要があります）

1. **世界が変わったあとの `FS.prize`**：前の世界の賞金の情報が、新しい世界の最初の読み込みが成功するまで残ります。これを消すと、参加の経路（`if (FS.prize)`）と `paidJoin` の手数料の読み方が変わります。そのため今回は禁止の範囲として触れていません。
2. **参加の途中で世界や中継先が変わったとき**：`paidJoin` の中の `refreshPrize({force:true})` が答えを捨てると、`FS.prize` は前に読んだ値のままです。起点でも、前の世界で読んだ値を使っていた点は同じです。手数料の上限は中継先が確かめます。
3. **`FS.overviews` と `refreshOverviews`**：ヘラルドだけで確かめています。同じヘラルドのまま固定し直したときに印が付きません。今回の三つの関数の外です。
4. **`conquestEnabled` が偽の世界へ移ったとき**：`refreshConquest` が動かないため、前の世界の `FS.conquest` が残ります。表示はその条件で止まるはずですが、確かめていません。
5. **固定がない状態（世界 null）から固定へ移ったとき**：領土の状態が一度だけ作り直されます。通常は、プレイが始まる前に `loadSeason` が固定するので起こりません。

## 次の集約のための一覧（D 向け）

コミットの値、元のコードとファイルの値（blob）、モードは、このブランチの先端で次の四つのファイルについて確かめてください：`git ls-tree <tip> -- <path>`。

- `permutation-server/web/frontier/controller.mjs`（変更、100644）
- `permutation-gateway/test/web-frontier-ws07-refreshers-world-text.test.mjs`（追加、100644）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（追記、100644）
- `docs/integration/CLAUDE-LANE-C-WS07-REFRESHERS-WORLD-20261117.md`（この報告、100644）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。
