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

## 7. 登録簿の入口（2026-11-06 追加）：③・⑤・⑬ が使う方法

登録簿（`src/acts.rs`）は④の Run の保存先（SQLite）にある。外のプロセスからは、④の既存の操作用コマンド `runexec` の `act` サブコマンドで使う。網を待ち受けるサーバーは足していない（新しい認証や公開の口は増えない）。JS からは `clients/acts.mjs` が同じコマンドを呼ぶ（shell を使わず、引数は配列）。

### 7.1 コマンド（1 行の JSON を標準出力に出す）

```text
runexec act register --db <runs.db> --agent <agentId> --key <idempotencyKey> --source ai|mcp|browser|resident [--run <呼び出し側の runId>] [--slot <n>]
runexec act status   --db <runs.db> (--run4 <run4Id> | --agent <agentId> --key <key>) [--gateway <127.0.0.1 の port> [--bridge]]
runexec act list     --db <runs.db> --run <呼び出し側の runId>
```

| 終了コード | `error` | 意味 |
|---|---|---|
| 0 | — | 受領書（§3.3）。`state`・`next`・`newAttemptAllowed` を含む |
| 2 | `BadRequest` | 引数の誤り（source が許可外、port が数でない等） |
| 3 | `NoRecord` | その行動は登録されていない（状態ではない。⑬ の `null`） |
| 4 | `Conflict` | 同じキーが別の source・runId で登録済み（混ぜない） |
| 1 | `StoreError` | 保存先を開けない等 |

- `status --gateway <port>`：代理の財布の `GET /f/agent/fate?id=&key=` を 127.0.0.1 で一度読み、記録して答える。読めなければ `unqueryable`（分かっていた署名・寿命は残す）。`--gateway` が無ければ保存済みの答えを返し、何も読まない。**どの場合も送信しない。**
- 応答は Node の chunked 形式でも読める（財布の応答はこの形。今回見つけて直した。それまでの④の読み取りは本物の財布では常に失敗していた）。

### 7.2 次にしてよいこと（`next`）

| state | `next` | `newAttemptAllowed` | してよいこと |
|---|---|---|---|
| `registered` | `wait` | false | 送信の後に `status` を読む |
| `pending` | `wait` | false | 待つ |
| `unknown`（結果不明） | `hold` | false | **再送しない**。着地していたかもしれない。確定を待つか運営に回す |
| `unqueryable`（照会不能） | `read-again` | false | 後で読み直す。行動については何も言っていない |
| `landed`・`failed` | `done` | false | 終わり |
| `expired`・`not-sent` | `new-attempt` | true | 新しいキーでの新しい試行だけ（同じキーは財布の replay） |

### 7.3 各担当の使い方

- **⑤（自動運転、`source: ai`）**：行動ごとに `register({agentId, key: 'ai:<requestId>', source: 'ai', runId})` → 財布へ `POST /f/agent/action`（同じ idempotencyKey）→ `status(…)`。RunReceipt の `from4` の欄は `toP05Act(receipt)`（`run4Id`・`signedAt`・`cancel.until`）。新しい試行は `mayStartNewAttempt(receipt)` が true のときだけ。
- **③（MCP、`source: mcp`）**：同じ。MCP の `agent_act` の結果の `requestId` をキーに `register` し、`agent_status` 相当の照会は `status` で返す。
- **⑬（住民、`source: resident`）**：実行ポートの `status(key)` を `statusFor13(client, agentId, key)` にする。登録されていないキーは `null`、読めないときは例外（R5）、`expired`・`not-sent` は `cancelled`、結果不明は `unknown`（R4、再送の理由にしない）。保持は無期限（`retentionBells: null`、R1・R2）。
- 共通：`bin` は `workstreams/04-execution` で `cargo build --release --bin runexec` したもの、`db` は④の実行器と同じ保存先、`gatewayPort` は財布（中継）の 127.0.0.1 の port。

### 7.4 試験（鍵を作らない・導出しない・署名しない）

- `tests/act_cli.rs`（5 件）：本物の `runexec` を別のプロセスとして起動し、台本の `GET /f/agent/fate` に向けて、登録の冪等・拒否のコード・七つの state と `next`・読めない財布・確定後の食い違いを確かめる。
- `clients/acts.test.mjs`（4 件、`RUNEXEC_BIN` を指定したときに実行）：JS の client を本物のバイナリと Node の台本サーバー（chunked で答える）に向けて、⑤・⑬ の対応づけまで確かめる。
- `src/gateway.rs` の単体試験（chunked の解読）。

## 8. Run の入口（2026-11-07 追加）：⑥の荷車だけの Run と ⑬ の実行ポートが使う方法

④の Run（`RunSpec`、`src/model.rs`）を外のプロセスから受け付け、保存されている状態を読むコマンド。登録簿（§7）と同じく `runexec` の subcommand で、網を待ち受けるサーバーも、新しい認証の口も足していない。**受付は依頼の保存であり、送信ではない。** 署名も送信もしない。送るかどうかは、同じ store を見る実行器（`Executor`）が、正本を読み直してから決める。

### 8.1 コマンド（1 行の JSON を標準出力に出す）

```text
runexec run accept --db <runs.db> --spec <spec.json | -> [--slot <n>]
runexec run view   --db <runs.db> --run <run_id>
```

| 終了コード | `error` | 意味 |
|---|---|---|
| 0 | — | `accept`：受け付けた（`accept: "Created"`）か、同じ `run_id` に同じ spec が既にある（`accept: "Existing"`、`replayed: true`。何も書かない）。`view`：保存されている Run |
| 2 | `BadRequest` | 引数の誤り（知らない option、値の無い option、二度与えた option、`--slot` が数でないか `i64::MAX`＝9223372036854775807 を超える：store は slot を SQLite の整数で持つ）、または spec の誤り（JSON でない、object でない、**同じ名前の欄が一つの object に二度ある**（serde は後の方を黙って採る。名前は decode して比べる）、`RunSpec` に無い欄がある（`null` でも。例外は spec が省略する `facility` の `null` だけ）、欄の型が違う、`run_id` が空か 128 byte 超、実行器の受付と同じ検査：荷が空、送り元と宛先が同じ tile、荷車だけの Run に材料・出来上がり・使用権がある、`max_attempts` が 1..=16 の外）。**store を開く前に拒否する**（新しい store は作られない） |
| 3 | `NoRecord` | `view`：**開いて読めた run store に**、その `run_id` の Run が無い（状態ではない。⑬ の `null`）。これだけが「受け付けられていない」の答え |
| 4 | `Conflict` | `accept`：同じ `run_id` に別の spec が保存されている（digest が違う）。混ぜない。別の spec は別の `run_id` で出す |
| 5 | `StoreUnavailable` | `view`：path に store が無い、または届かない（消えた・mount されていない・path の誤り・権限）。**Run について何も言っていない**。そこで受け付けて送ったかもしれない Run が「無かった」ことの証拠にはならない。store は作らない |
| 1 | `StoreError` | store はあるが開けない・読めない（database でないファイル、`runs` 表の無い database、SQLite の誤り）。これも Run について何も言っていない |

- **5 と 1 は答えではない**（§1 の `unqueryable` と同じ扱い）：呼び出し側はこれを `not-sent`・「受け付けられていない」と読まず、**再送しない**。読み直すか、運営に回す。⑬ の `client.run(runId)` は `NoRecord` だけを `null` にし、`StoreUnavailable`・`StoreError` は例外にする（R5）。
- `view` は**読むだけ**：store を読み取り専用で開き（`Store::open_read_only`）、作らず、表の作成や移行の文を一つも実行せず、何も書かない（SQLite が WAL を読むために `-shm`／`-wal` を作ることはある。database 本体は変わらない）。`accept` だけが `Store::open`（表の作成を含む）を使う。
- `view` の欄は**一つの snapshot**：Run の行・遷移・attempt・Receipt・費用を一つの読み取り transaction（`Store::read_snapshot`、WAL の snapshot）で読む。実行器が横で書いていても、別の時点が混ざることはない（`src/view.rs`。`accept` の答えも同じ関数）。
- `--spec` は **1 MiB（1,048,576 byte）まで**（file も標準入力も）。それを超える入力と UTF-8 でない入力は、読みながら拒否し、store を開かない。`RunSpec` は数百 byte。

- `--spec`：`RunSpec` の JSON（`-` で標準入力）。欄は `src/model.rs` の `RunSpec` のとおり（`run_id`・`owner`・`stock`・`inbound`・`facility`・`inputs`・`outputs`・`rights_units`・`ship`・`deadline_slot`・`budget`）。**荷車だけの Run は `facility` を省く（または `null`）**。`inputs`・`outputs` は全部 0、`rights_units` は 0。施設のある spec は今までどおりの JSON で、保存される文字列も digest も変わらない。
- `--slot <n>`（既定 0）：受付の slot。`created_slot` と最初の `next_check` になる（実行器はこの slot 以降に見る）。
- `accept` は、実行器の `Executor::accept` と同じ検査（`executor::validate_spec`）を通す。したがって、ここで受け付けた spec を実行器が後から `accept` すると `Existing` になり、`Conflict` にはならない（`tests/run_cli.rs` で確かめている）。
- 同じ spec の再送は `Existing`（`version`・`next_check` は変わらない）。重複した Run は作られない。

### 8.2 `view` の欄（`accept` の答えも同じ欄に `accept`・`replayed` を足したもの）

| 欄 | 内容 |
|---|---|
| `view_version` | `p04-run/0.1` |
| `run_id`・`cargo_only` | id と、荷車だけの Run か |
| `state`・`terminal`・`in_flight` | 15 の状態（STATE-MACHINE）と、終端か、署名済みの要求が着地しうるか |
| `held_reason` | 保留の理由（`null`：保留なし）。⑬ の `fateOfRun` が読む欄 |
| `cancel_requested`・`cancel_phase` | 取消の要求と段階（`StoppingNew`・`AwaitingSigned`・`Completed`・`Ineffective`） |
| `version`・`next_check` | 保存されている版と、次に見る slot |
| `spec`・`spec_digest` | 保存されている spec と digest |
| `detail`・`reason`・`outcome` | 保存されている detail、失敗・保留の理由、終端の結果（`delivered`・`verification`・`cargo_logged`・`effects`・`note`） |
| `sent`・`settled`・`effects` | **Receipt から**：`caravan_sent`（自分の署名と中身を正本で確認した発送）、`caravan_settled`（決着の記録）があるか。`effects` は Receipt の種類の列。受付だけでは全部 false／空。状態からは推定しない |
| `fees` | `reserved`・`charged`・`unconfirmed`・`released`（CONTRACTS §6.2） |
| `transitions`・`attempts`・`receipts` | 遷移（実行者と理由つき）、attempt（段階・要求キー・署名・有効期限・手数料・状態）、Receipt |

⑬ の `resident/ports/ws04-run.mjs` の `fateOfRun` が読む `state`・`held_reason`・`outcome.effects` は、この欄の名前のまま。`client.run(runId)` は `view` を呼び、`NoRecord` だけを `null` に、`StoreUnavailable`・`StoreError` を例外にする（R5：答えられないことを「無い」にしない）。

### 8.3 試験（`tests/run_cli.rs`。鍵を作らない・導出しない・署名しない）

本物の `runexec` を別のプロセスとして起動し、固定の JSON（⑥の荷車だけの Run：鉄 4 を自分の倉から自分の金庫へ。作る Run：鉄 5 → 武器 3 を金庫へ）で確かめる：受付・閲覧・同じ spec の再送（file と標準入力）が重複を作らないこと、既存の `cancel`・`show` がその Run に効くこと、施設のある spec の保存文字列と digest が変わらないこと、同じ id の別の spec（量が違う・施設の有無が違う）が `Conflict` で何も変えないこと、壊れた JSON・知らない欄（`facilty`）・型違い・受付の検査・option の誤りがすべて store を作る前に拒否されること、読めた store に無い id が `NoRecord`、path に store が無い（消した・移した後を含む）場合が `StoreUnavailable`、database でないファイルが `StoreError` であること、`view` の読みの途中で別の接続が commit した遷移が答えに混ざらないこと（`run_view_at` の hook で決定的に）、実行器が 7 つの Run を運ぶ横で別 thread の読み手が取る view がすべて一つの時点であること（`version` と遷移の数、状態と最後の遷移、発送の Receipt と InTransit、attempt の数）、`--spec` が 1 MiB ちょうどは受け付けられ 1 byte 超・4 MiB・UTF-8 でないものが file・標準入力とも store を作る前に拒否されること、`view` が store を作らず既存の store の byte を変えず `runs` 表の無い database や空のファイルに表を作らないこと、`facility: null` が同じ Run（replay）で他の `null` の欄（入れ子を含む）は拒否されること、同じ名前の欄の二度目（入れ子・JSON の escape で書いた名前を含む）が拒否されること、`--slot` が `i64::MAX` を超えると拒否され `i64::MAX` ちょうどは保存されること、受け付けた Run を模擬の世界の実行器（途中で再起動）が `Existing` として引き取り Fulfilled まで運び、別のプロセスの `view` がその結果（`sent`・`settled`・`outcome.delivered`・attempt の `landed`・手数料）を読むこと。

### 8.4 まだ無いもの

- JS の client（`clients/acts.mjs` に相当する `run accept`／`view` の wrapper）と、⑥の計画→`RunSpec` の adapter（INTEGRATION-20261106c §3 のとおり、⑥の新しい版を待つ）。
- ⑥の Receipt の欄（`manifest`・`planHash`・`run`・`outputs`・`port`・`beneficiary`）。`view` は④の Run の欄だけを出す。
- `run cancel` の JSON 版。取消は既存の `runexec cancel`（文字列の出力）で、段階は `view` の `cancel_phase` で読む。
