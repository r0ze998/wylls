# 実行の契約：送信の結果をそろえる（④、2026-11-06）

基点：統合候補 `integration/ws09-13-v16-d0949fd4` の `ef63544c727490fc6801d30affd11c5b7106c480`（④の `a967f5f1` までを含む）。この候補に入っている修正（⑱の Reveal・keeper の手数料計上・`landed()` と `GET /f/tx` の finalized 判定・503 の情報漏れ）は作り直していない。

## 1. 一つの言葉：送信のあとに起きうること

署名済みの送信について、どの担当も次の七つだけを使う。名前は代理の財布の `GET /f/agent/fate` の `state` と同じ。

| state | 意味 | 確定か | 再送してよいか |
|---|---|---|---|
| `not-sent` | 何も送られていない（拒否、または送る前に失敗） | 確定 | 新しい試行として可（同じキーの再送は replay） |
| `landed` | finalized で、誤りなし | 確定 | 不可 |
| `failed` | finalized で、誤りあり（手数料は払った、効果なし） | 確定 | 規則による（新しい試行） |
| `expired` | 寿命（lastValidBlockHeight）を過ぎ、ノードの履歴がその範囲を覆っていて、取引が無いと示せた | 確定 | 新しい試行として可 |
| `pending` | まだ確定していない。`commitment`（processed／confirmed）は進み具合で、判断に使わない | 未確定 | 不可（待つ） |
| `unknown` | 結果不明：寿命は過ぎたが、着地しなかったと示せない（履歴が欠けている等） | 未確定 | 不可（保留。推測しない） |
| `unqueryable` | 照会不能：ノードや記録を読めなかった。取引については何も言っていない | 未確定 | 不可（読めるまで待つ） |

規則：
- 確定させるのは finalized と、証明された寿命切れだけ。confirmed は戻りうる。時間の経過は証拠ではない。
- `unknown` と `unqueryable` は別のもの。前者は「答えたが証明できない」、後者は「答えられなかった」。どちらも失敗ではない。
- 確定した state は変えない。食い違う後の読みは `conflict` として残し、適用しない（④の `acts`）。

## 2. 各担当の言葉との対応

| ここ | 代理の財布 `GET /f/agent/fate`（今回追加） | ④ Run（`SigStatus`） | `GET /f/tx/{sig}`（統合候補の現行） | ⑬ 住民の実行ポート `fate` | ⑤ RunReceipt `acts[].fate` |
|---|---|---|---|---|---|
| `not-sent` | `not-sent` | `Absent` | （署名が無いので照会しない） | `cancelled`（提案） | `null`（送っていない） |
| `landed` | `landed` | `Landed` | `landed` | `landed` | `landed` |
| `failed` | `failed` | `Failed` | `failed` | `failed` | `failed` |
| `expired` | `expired` | `Absent` | **区別しない（`unknown`）** | `cancelled`（提案） | `expired` |
| `pending` | `pending` | `Pending` | **`unknown`** | `pending` | `unknown` |
| `unknown` | `unknown` | `Unavailable`（`Indeterminate` で保留） | `unknown` | `unknown` | `unknown` |
| `unqueryable` | `unqueryable` | `Err(PortError::Unavailable)` | 送信記録のある署名は `unknown`、無い署名は 5xx | 例外を投げる（⑬ R5） | `unknown` |

`GET /f/tx` の `unknown` は「未確定・結果不明・読めない」をまとめた粗い答えで、安全側だが区別がつかない。区別が要る呼び出し側（④、⑤、⑬）は `GET /f/agent/fate` を使う。`GET /f/tx` は変えていない。

## 3. 今回つないだもの（コード）

### 3.1 代理の財布（共有コード、追加だけ）

- `ActionResult` に `sent`（署名済みのバイト列が出たか）と、出た場合の `signature`・`lastValidBlockHeight`・`slotFloor`・`signedAt` を付ける。**送った後に失敗した `failed` にも付ける**（以前は署名が無く、④は保留するしかなかった）。履歴の記録にも同じ欄を残す。
- `GET /f/agent/fate?id=&key=`（読むだけ、公開、20/2 の制限）：履歴の記録と、reconcile と同じ規則（`fate.mjs`）による答え。
- `fate.mjs` の答えに `commitment`（ノードが報告した段階）と `queryFailed`（読めなかった）を足す。`fate` の値は変えていない。
- 変えたファイル：`agent/contract.mjs`・`agent/fate.mjs`・`agent/gateway.mjs`・`routes/agent.mjs`・`app.mjs`。試験 `test/agent-wallet-run-facts.test.mjs`（4 件、鍵を使わない）。

### 3.2 ④の Run（③の SendCaravan、MCP から代理の財布を通るもの）

- `GatewayPort` が上の欄を読む。送った後の失敗も署名で追い、`GET /fate` の答えで決める（§2 の表）。古い財布（`sent` 欄なし）は以前どおり保留。
- 送る前の失敗（`sent: false`）は拒否として終わらせず `Absent` にする（一時的な障害で Run を失敗させない。executor は新しい試行を作れる）。
- `GatewayPort::facts(handle)`：一つの試行の state・署名・寿命・署名時刻・commitment。
- 試験 `tests/gateway_facts.rs`（7 件）：橋の代わりに台本の stub（鍵なし、署名なし、frontier-abi で SendCaravan のバイト列を組む）。finalized で一度だけ届く、送った後の失敗を署名で追い二重送信しない、結果不明は保留、照会不能は結果ではない、証明された寿命切れの後に新しい試行が一つ、送る前の失敗は Absent、古い財布は保留。

### 3.3 ⑤・⑬ の行動を Run に登録する（`src/acts.rs`）

- `acts::register(agent, idempotencyKey, source, 呼び出し側の runId)` → `run4Id`（`act-` ＋ sha256(agent ‖ 0 ‖ key) の 16 桁。同じ行動はいつも同じ id）。同じキーで別の source・runId は拒否（混ぜない）。
- `acts::refresh(store, reader, run4Id)`：財布の fate を読み、記録して受領書を返す。読めなければ `unqueryable`（分かっていた署名は残す）。確定した state は変えない。
- 受領書（`p04-acts/0.1`）は⑤の RunReceipt が④に求めた欄（`run4Id`・`signedAt`・`cancel.until`）を同じ名前で持つ。`cancel` は `before-sign/NotSent`、`sent/Irrevocable`（`until` は lastValidBlockHeight、**slot ではなくブロック高**）、`signed-unsent/NotSupported`（財布は署名と送信を一度に行うので、④は止められない）。
- 保持：行を消さない（`retentionBells: null` を受領書で宣言）。⑬ の R1（確定後 144 ベル以上）・R2（宣言）を満たす。財布自身の記憶は短い（履歴は代理ごとに直近 500 件、画面は 50 件）ので、④が写しを持つ。
- 試験 `tests/acts.rs`（6 件、台本の reader、鍵なし）。

### 3.4 古い試験を現コードに合わせた（再実装なし）

- `e2e-native/tests/legacy_season_claims.rs`：InitPool が有限の世界の進行中だけ pool を開くようになった（統合 `2c29496f`・`c5750a20` の `season_ends`）ので、模擬の Season に genesis・ベル長・参加締切を入れた。4 件とも合格に戻った。
- `e2e-native/tests/error_codes.rs`：「次の空き番号は 94」を固定していたのを、「使っている最大の番号の次で、隙間がない」に変えた（⑧の ContinuousWorld が 94 を使ったので、統合候補では 95）。番号の採用は別の判断のまま。
- `tests/gateway.rs` の無視される試験（橋が鍵を作るので実行していない）を新しい契約に書き換えた：送った後の失敗は署名で追われ、一度だけ届く。

## 4. 照合した結果（⑬・⑰・⑲）

- **⑬ 保持期間**：⑬ の `08-retention-contract.ja.md`（branch `claude/eager-cerf-k74z5s`）は、確定後 1 ゲーム日以上の保持・宣言・忘れたキーは `KeyExpired`・`unknown` と記録なしの区別を④に求める。④の `acts` は消さないので R1〜R3 を満たし、R4（`unknown`）・R5（記録なしは `Err`／`null`、読めないは `unqueryable`→例外）も区別する。ただし⑬ の `fate` の言葉には `expired`・`unqueryable` が無い（§2 の提案は `cancelled`／例外）。
- **⑰ finalized 判定**：統合候補の `landed()` と `GET /f/tx` は finalized だけで決めるよう直っている（⑰ の指摘 1〜3 は解消）。`fate.mjs` も同じ規則。残る差は §2 の `GET /f/tx` の粗さだけ。
- **⑲ 履歴の欠落**：④の executor は feed の欠落を警告にするだけで、状態は正本の読みで決める（記録が無いことを起きていない根拠にしない）。⑲ の検出できない3つの場合（初回の取得、cursor が無い・古い、途中だけの欠落）があるので、「欠落の警告が無い」ことも完全な履歴の証明にしない。`expired` の証明は findex ではなく、RPC の `getFirstAvailableBlock` が送信前の slot を覆うことによる（`fate.mjs`）。

## 5. まだつながっていないところ

| 項目 | 状態 |
|---|---|
| ⑤ の自動運転から `acts::register` を呼ぶ | 未接続。⑤ の model-api（`45cba41e`）は統合候補に入っていない。④の受領書は⑤の欄名に合わせてあり、⑤ の local adapter を④の `acts` に替える差分が要る |
| ⑬ の実行ポートを④の `acts` で実装する | 未接続（⑬ の `resident/ports/execution.mjs` は模擬の世界に向いている） |
| ③ の MCP サーバー（`acdcd0bf`） | 統合候補に入っていない。MCP は財布の `POST /f/agent/action` を呼ぶので、§3.1 の欄は追加の変更なしで届く |
| 実チェーン・SBF | 未実行。財布の模擬チェーンと④の模擬世界だけ |
| 鍵を作る・導出する・署名する試験 | 実行していない：財布の既存試験（`npm test` の大半）、④の `tests/gateway.rs`（9 件、無視される）、橋、keeper の `play` |
| 財布の `failed` で `sent: true` の行動の自動決着 | 値の付いた行動は reconcile が決める。値の無い行動（多くのゲーム行動）は reconcile の対象外で、`GET /f/agent/fate` で読むだけ |

## 6. 決めてほしいこと（ゲームの仕様）

- **結果不明のまま残った行動を、AI 住民・代理はどうするか。** 今は安全側で、確定するまで同じ行動を選ばず待つ（⑬ S5）。結果不明が長く続くと、その住民・代理はその行動をずっと控える。待つ上限（例：1 ゲーム日）を過ぎたら「起きなかったもの」として次の行動に進んでよいか、それとも運営が着地か失敗かを決めるまで止めておくか。
  - 進んでよいとすると、実際には着地していた場合に、同じ行動が二度起きうる（例：同じ荷を二度送る）。
  - 止めておくと、障害の間はその住民・代理が動かない。
