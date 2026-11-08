# ⑤：④の登録簿（acts）と `GET /f/agent/fate` への接続（2026-11-05）

（続き：④ `95686606` の実物の登録簿への接続は `ACTS-REAL-5.ja.md`。）

起点は ⑤ `2c10626f`。④は GitHub の `claude/gallant-ride-cunptv` の `77c5cbe2398c89559417f8cf18d4065b51455ee6` を読んだ。④の新しい物は `0a5473af`（コード）と `77c5cbe2`（`docs/EXECUTION-CONTRACT-20261106.ja.md`）。

## 1. ④で増えた物（読んだ物）

| 物 | 中身 |
|---|---|
| 中継の `ActionResult` | `sent`（署名済みのバイト列が出たか）。出た場合は `signature`・`lastValidBlockHeight`・`slotFloor`・`signedAt`。**送った後に失敗した `failed` にも付く** |
| `GET /f/agent/fate?id=&key=` | 冪等のキーで、1つの行動の state を答える：`not-sent`・`landed`・`failed`・`expired`・`pending`・`unknown`（結果不明）・`unqueryable`（照会不能）。読むだけ |
| `acts.rs`（④の実行器、Rust、SQLite） | 代理の行動を `run4Id`（`act-` ＋ sha256(agent ‖ 0 ‖ key) の先頭16桁）で登録する。確定した state は変えない。食い違う読みは `conflict` として残す。行は消さない。受領証は `p04-acts/0.1` |
| まだ無い物 | `acts` を**別のプロセスから呼ぶ口**（HTTP・コマンド）。ライブラリの関数だけ |

## 2. ⑤で直した物：二重送信の穴が2つ

| 穴 | 以前 | 今 |
|---|---|---|
| 中継の `failed` | 「送っていない」として予約を戻し、次の回に**新しい requestId で送り直した** | `sent: false` だけが「送っていない」。`sent: true`（署名あり）と、`sent` を言わない古い中継の `failed` は**送られた物として追う**。予約も数も残す。送り直さない |
| `GET /f/tx` の `expired` | 確定とみなし、予約を戻して送り直した | **証明ではない**（confirmed の高さだけで決めている）。結果不明として保留する。送り直してよいのは、`GET /f/agent/fate` の `expired`（履歴で証明された物）・`failed`（finalized）・`not-sent` だけ |

`participate.mjs`（⑤のコード）の変更：`resultOf` が `sent` と署名の事実を読む。`mayHaveLeft()` を足した。`verifyPending` が requestId を txState に渡し、`fateState` を記録する。`unknown`・`unqueryable`・`pending` は**別々に記録**し、どれも保留する。

## 3. 足した物（model-api）

| ファイル | 中身 |
|---|---|
| `src/fate-reader.mjs` | `GET /f/agent/fate` の読み手（fetch は注入）。7つの state を確かめる。HTTP の失敗・形の崩れた答えは `unqueryable`（答えとして扱わない）。④の Run の言葉（`IN_RUN4`）。`txStateFromFate`（証明された終わりだけが final）、`txStateFromTx`（`GET /f/tx` の弱さをそのまま示す） |
| `src/acts-registry.mjs` | **④ `acts.rs` と同じ契約のローカル実装**：同じ `run4Id`、登録の冪等、別の source・runId は拒否、確定は不変、`conflict`、読めない時は分かっている事実を残す、`p04-acts/0.1` の受領証、消さない。ファイルの mutex の中で1つの取引として扱う（複数のプロセスで共有できる）。違い：`registeredSlot` は null（⑤は slot を読まない）。受領証の `provenance` にそう書く |
| `src/status-query.mjs`（0.2） | 読み手がある時は④の7つの state で答える。`validUntil` は `lastValidBlockHeight`（**ブロック高**。slot ではない）、`signedAt`、`run4Id`、`terminal`（証明された終わりだけ）、`mayRetry`。読み手が無い時は 0.1 の答え（`GET /f/tx`）で、そう明記する |
| `src/autopilot.mjs` | `acts`・`fate`・`actSource`（`mcp`／`ai`、MCP のキーの前置き）を渡せる。各回で、中継に届いた行動を `run4Id` で登録し、fate を読む。まだ確定しない行動は、回ごとに最大8件読み直す（中継の制限は 20 burst・2/秒）。`actStatus(requestId)` は③への答え |
| `src/run-receipt.mjs` | `GET /f/tx` の `expired` を確定の fate にしない。fate の読み手があれば、`signedAt` と `cancel.until`（`{lastValidBlockHeight}`）を埋める |

**行動の範囲は広げていません。** 自動運転は物流（隊商）を送りません（以前のとおり）。

## 4. ④との照合

| 確認 | 結果 |
|---|---|
| `run4Id` | ⑤の `run4IdOf('agent1','ai:p05.r1')` = `act-008445dbab443860`。期待値は `sha256sum` で別に計算した（⑤のコードからではない） |
| ④の `actionFateView` → ⑤の `readFate`・登録簿 | ④の木（77c5cbe2＋⑤のパッチ）の関数をそのまま使い、9つの形（記録なし・拒否・古い failed・pending・照会不能・結果不明・期限切れ・着地・失敗）で state が保たれることを確かめた（一度きりの確認。鍵なし） |
| ⑤の共有パッチ | 0001 は④の木に**もう入っている**。0003 はそのまま当たる。0002b と 0004 は④の変更とぶつかったので作り直した（`patches/on-ws04-77c5cbe2/`：0002c・0003・0004b）。当てた後の `permutation-gateway` は `f30edf74b3198634e6b13b92840b0405f0c2e539` |
| ④の `agent-wallet-run-facts.test.mjs`（鍵を使わない、4件） | パッチを当てた④の木で 4/4 通過 |

衝突の中身：0002b の作り直しの繰り返しの中に、④が足した `signed = {…}`（署名の事実）を入れた。0004 の公開の道の一覧に、④の `GET /f/agent/fate` と⑤の `POST /f/agent/whoami` を並べた。

## 5. まだつながっていない所

| 項目 | 状態・④に必要な物 |
|---|---|
| ④の登録簿に⑤が書く | **未接続。** ④の `acts` は Rust のライブラリで、外の口が無い。⑤は同じ契約をローカルに持つ。④が `runexec acts register|refresh|receipt`（コマンド）か HTTP を出せば、⑤の `FileActsRegistry` をその呼び出しに替える（受領証の形は同じ） |
| `registeredSlot` | ⑤は slot を読まないので null。④の口が slot を自分で読むか、⑤に読ませるか |
| ⑤の基準の中継 | ⑤のブランチの中継（`560f8659…`）には `sent`・`GET /f/agent/fate` が無い。fate の読み手は④の木の中継でだけ働く。古い中継では、⑤は `GET /f/tx` の答え（弱い方）で動き、`failed` を追い、`expired` を保留する |
| 結果不明が続いた時 | ⑤は**ずっと保留**（送り直さない）。下の §7 |
| 鍵を作る試験 | 実行していない：⑤の `autopilot`・`citizen`・`continuing`（T1〜T4）・`multiprocess-world`・`participation`・`staking`・`integration/*`、パッチに付く中継の試験（`agent-wallet-duplicate-bytes`・`agent-wallet-whoami`・`agent-wallet-mcp`） |
| 自動運転を通した登録の試験 | 自動運転の通しの試験は鍵を作る fixture を使うので、実行していない。登録・読み直しは、部品ごとと participate の stub（鍵なし）で試した |

## 6. 試験（鍵を作らない・導出しない・署名しない物だけ）

実行の前に、各試験ファイルとその共通の準備（import の閉包）を読み、最上位で鍵を作る・導出する・署名する行が無いことを確かめた。`continuing.test.mjs` は鍵を作る local world を読み込むので、その中の鍵を使わない T5 を `longrun.test.mjs` に移し、そちらだけを実行した。

| 試験 | 件数 | 結果 |
|---|---|---|
| `model-api`・`http`・`relay-tree` | 11・12・1 | 通過 |
| `multiprocess`（P1〜P4、P6） | 5 | 通過 |
| `longrun`（T5） | 1 | 通過 |
| `acts-fate`（A1〜A8、新） | 8 | 通過 |
| ④の `agent-wallet-run-facts`（④＋⑤の木） | 4 | 通過 |

## 7. 決めてほしいこと

- **結果不明（`unknown`）のまま残った代理の行動を、いつまで待つか**（④の §6 と同じ問い）。
  - 今の⑤は、確定するまで待ち、同じ依頼への協力を送り直しません。
  - 待つ上限（例：1ゲーム日）を過ぎたら「起きなかった」として進むと、実は着地していた場合に同じ行動が二度起きます。
  - 止めておくと、障害の間その代理は同じ依頼に協力しません。
- 以前の問い（⑤の行動を④の Run として扱うか）は、④が「代理の行動を act の Run として登録する」形（`acts`）を出したので、⑤はそれに合わせました。違う形がよければ教えてください。
