# ⑦ 失敗のあとの読み直し・表示の回復・鎖の時計（Lane C、2026-11-17）

- 固定の起点：`c545dc22c4ec6e404df11172c1e4fbc2937392f3`（シーズンの記録の答えの順番を訂正した束）。この起点とそれより前は保護します。
- ブランチ：`claude/lane-c-ws07-season-recovery-20261117`（独立。共通の集約は D だけが行います）。
- 範囲：
  - `app.mjs`：`seasonError` と `seasonRecovered` を新しく加え、`loadSeason` の誤りの書き込み三か所、回復の一行、世界が変わったときの時計の一行を変えました。
  - 前の束の回帰 `web-frontier-ws07-season-order-text.test.mjs`：失敗の行の一致だけを直しました。
- 試験・import・構文確認・ページ起動・実際の世界：**どれもしていません**。回帰は書いただけで、実行していません。

## 照合した実際の経路

- **読み直しの経路**：次の三つは、どれも `loadSeason` を呼びます。`poll-loop.mjs` が一度に一つにまとめるので、`loadSeason` 同士は重なりません。
  - `seasonLoop`：30 秒ごと。`pollCap` による上限があります。
  - 再読み込みのボタン：`onReread` → `seasonLoop.wake()`。
  - ページをもう一度表示したとき：`visibilitychange`・`pageshow` → `wake`。
- **答えの順番**：古い答えは、成功でも失敗でも `seasonStale` で先に戻ります（`c545dc22`）。そのため、古い失敗が新しい成功を汚すことはありません。この点は成り立っていました。
- **`FS.error` を読む側**：次のものです。
  - `renderStatus`：誤りの行、および「読み込み中…」を出すかどうか
  - `hud/drawer.mjs`：`unreachable`
  - `screens/chronicle.mjs`：`unread`
  - `hud/hud.mjs`：読み込みの状態
- **時計**：`FS.chain` は `boot` で一度だけ作られます。`observe` は、スロットの低い標本を「遅れて届いた古い答え」として捨てます。`now()` は `floor` より前に戻りません。`staleness` は、標本がないと `{behind: null, stale: false}` を返し、遅れの表示は出ません。

## 実際にあった欠陥

1. **成功しても、読み込みの誤りが消えませんでした。** `loadSeason` は、失敗・固定の拒否・ビーコンの不一致で `FS.error` を立てます。しかし、成功の経路は一度も `FS.error` を消していませんでした。一度シーズンの記録を読めなかったページは、回復したあとも誤りの行を出し続けました（`renderStatus`）。読み込み状態の表示も「読めない」側に寄ったままでした（`drawer`・`hud`）。
2. **固定の世界が変わったあと、時計が止まりました。** たとえばローカルの環境を立て直してスロットが小さくなると、新しい世界の標本はすべて「古い答え」として捨てられました。`now()` も前の世界の時刻から戻りません。このため、ターンの表示・遅れの表示・秒数の表示が前の世界の時計のまま止まり、遅れの表示がずっと出ていました。

## 変更

- **`seasonError(e)`**：シーズンの読み込みの誤りを、`source: 'season'` の印付きで立てます。別の操作の誤り（印のないもの。controller のローカルプレイの接続先の変化など）があるときは、上書きしません。
- **`seasonRecovered()`**：シーズンの印がある誤りだけを消します。`loadSeason` の中で、固定が受け入れられたあと、ビーコンを確かめる前に呼びます。そのあとでビーコンが合わなければ、また立てます。この区間には待ちがないので、画面に一瞬だけ誤りが消えて見えることもありません。
- **時計**：`adoptPinnedWorld()` の戻り値（世界が変わったか）を受け取ります。変わったときだけ、`setAccelerated`・`observe`・`declare` の前に `FS.chain = new ChainClock()` で作り直します。標本は、その直後に記録から取ります。最初の固定と同じ世界の固定では、時計をそのまま続けます。`FS.chain` を長く持ち続けている箇所はないことを grep で確かめました。どの箇所も `FS.chain` を毎回読み直しています（`setClockPace`・`setTermsPace` の関数を含む）。

## 変えていないこと（逆レビュー）

- **古い答え**：成功でも失敗でも何も変えません（`c545dc22`）。新しい失敗でも、これまでどおり確かめ中の画面と送り出しの下書きを消します（`clearInspection` と `clearOutbound` はそのまま）。
- **ほかの読み込みとの関係**：同じ世界の通常の読み込み、世界の切り替え、読み直し、答えの順番（`askSeason`・`seasonStale`・`takeSeason`）、`refreshOverviews` の扱いは変えていません。`refreshOverviews` は `FS.error` に触れません。
- **時計の意味**：時計の意味・速さの見積もり・宣言された速さ・遅れの判定（`STALE_AFTER`）・ゲームの判定は変えていません。標本のない時計は、これまでどおり「わからない」で、新しいとは言いません。
- **文言**：日本語にも英語にも、新しい文言はありません（誤りの文章はこれまでのものです）。
- **例外**：`loadSeason` の待ちは一度だけです。`seasonError` と `seasonRecovered` は、例外を投げない代入だけです。
- **変数の範囲**：
  - `worldChanged` は `loadSeason` の中だけで使います。
  - `seasonError` と `seasonRecovered` は app のモジュールの関数で、ほかの名前と衝突しません。
- **禁止の範囲**：支払い・賞金・claim・paidJoin・faucet・資産・権限・送信には触れていません。

## 回帰（書いただけ、実行していない）

`permutation-gateway/test/web-frontier-ws07-season-recovery-text.test.mjs`：鍵を使わず、文字として読みます。

| 番号 | 確かめること |
|---|---|
| E1 | 印付きで立てること。`loadSeason` に直接の書き込みが残っていないこと |
| E2 | 回復の位置と、別の操作の誤りに印がないこと |
| E3 | 読む側が変わっていないこと |
| C1 | 時計が止まった理由 |
| C2 | 世界が変わったときだけ時計を作り直し、その順序が正しいこと |
| C3 | 標本のない時計は「わからない」のままであること |

三つの回帰（この束・`season-order`・`overviews`）について、書いた文字列と順序が元のコードにあることを、文字の照合で確かめました。

## 未決（範囲外）

1. **別の操作の誤りが立っている間**：シーズンの失敗は、誤りの行には出ません（先に立っていた、より重い誤りを出し続けます）。両方を並べて出す表示は、今回は作っていません。
2. **作り直したあとの速さの見積もり**：速い時計では、標本が二つそろうまで見積もりができません。これはこれまでの動きです。宣言された速さがあれば、すぐに決まります。

## 次の集約のための一覧（D 向け）

起点は `c545dc22` です。先端と各ファイルの値（blob）は、push のあとに確かめます。モードはすべて 100644 です。

- `permutation-server/web/frontier/app.mjs`（変更）
- `permutation-gateway/test/web-frontier-ws07-season-recovery-text.test.mjs`（追加）
- `permutation-gateway/test/web-frontier-ws07-season-order-text.test.mjs`（失敗の行の一致）
- `workstreams/07-player-experience/CONTRACTS.ja.md`（追記）
- `docs/integration/CLAUDE-LANE-C-WS07-SEASON-RECOVERY-20261117.md`（この報告）

利用者が消した媒体 25 件は、復元も上書きも stage もしていません。
