# 17 ④の実行台帳への接続（③：取消後の照会、送信済み署名と有効期限、再送しない照会）

作業日 2026-11-05。起点 `5740e3392abe1acc25634e827ae6fdac5d086dbc`、ブランチ `ws03/runreceipt-port`（ローカルだけ、push していない）。

## 0. 受け取れているか

| 物 | 状態 | 根拠 |
|---|---|---|
| ⑤ `711d6c49` | **受け取れていない** | この clone、origin のすべての branch（fetch 済み）、送られたファイルのどれにも無い（`git cat-file` で "Not a valid object name"）。origin にある⑤の物は `preserve/ws05-provider-budget-45cba41e`（2026-10-30）だけ |
| ④の実コード | **受け取れている** | origin `preserve/ws04-a967f5f1`（`a967f5f1c64facc32facf07010f39a679c77d80a`、2026-10-31）。`workstreams/04-execution` の Rust の executor（`runexec`）、`src/gateway.rs`、`bridge/agent-gateway-bridge.mjs`、文書 |

④は③のローカルでビルドして動かした（§3）。⑤の 711d6c49 で G-1〜G-3 が入ったかどうかは、③からは確かめられない。

## 1. ④⑤と二重にしないために確かめたこと

- **④の executor は⑤の gateway の利用者**（④ AUTH-ROUTES B1）。④の `src/gateway.rs` は `POST /f/agent/action` で送り、答えが失われた時は⑤の公開の見え方 `GET /f/agent?id=` の履歴から、自分のキーの行を読む（`result_of`）。
- ③も同じ gateway の利用者である。だから③は、**⑤の既にある読み取り専用の見え方を、④と同じ形で読む**ことにした。⑤の gateway も④の executor も変えていない。③の外の変更は 0 件。
- 有効期限は、⑤の `ActionResult` には無い（④ G-1）。⑤の ledger は `markSending` で署名・`lastValidBlockHeight`・`slotFloor` を保存しているが、見え方（`view`）には出さない。③はこれを作らない。③が読めるのは、③のパッチ 0007（relay の `GET /f/tx?detail=1`）の `lastValidBlockHeight` だけである。

## 2. 変更した挙動（③の中だけ）

### 2.1 再送せずに状態を聞く（答えが失われた時）

`game.mjs` `agentRecord(agentId, owner, key)`、`server.mjs` `recover(op)`。

- 試行が記録されていて、自分の署名を知らない操作では、状態の照会（`get_operation_status`）、所有者の照会（`/owner/operations`）、同じ requestId の `send_caravan` のどれでも、まず⑤の `GET /f/agent?id=` を読む。**送らない。** capability も要らない。
- 自分のキー `ws03:<link>:<requestId>` の行だけを見る。所有者が接続の所有者と違えば読まない。

| ⑤の記録 | ③の扱い |
|---|---|
| 履歴の行に署名（`status: sent`） | その署名を自分の物として使う（`gateway.recoveredFrom`）。後は、受け取った答えと同じく自分の署名で決める |
| 行は `failed`、開いている hold に署名（価格のある行動） | hold の署名を使う |
| 行が `refused` | 署名の前に拒否された。このキーでは何も送られていない。失敗にし、予約を返す |
| 行が `failed` で署名が無い | 決めない。返さない（`agentRecord.note` に ④ G-2 と書く） |
| 行が無い | 決めない。返さない（見え方は最後の 50 行だけ。送信と行の間で止まれば行は無い） |
| relay が答えない | 決めない（`agentRecord.read: false`） |

`send_caravan` の再試行も、⑤の記録が答えれば再送しない。記録が答えない時だけ、これまでどおり同じキーで再送する（⑤の replay）。

### 2.2 送信済み署名と有効期限

- 0007 の `detail.lastValidBlockHeight` を `op.lifetime` に記録し、受領証に出す（`lifetime`）。
- ④の取消の段階 `AwaitingSigned.until` に入れる。入れるのは、**この操作の署名が分かっていて、その署名の有効期限が記録された時だけ**。

```json
{ "phase": "AwaitingSigned", "until": { "lastValidBlockHeight": 150, "unit": "block height", "signature": "…", "source": "relay GET /f/tx?detail=1 (patch 0007)" } }
```

- **単位はブロック高であり、slot ではない。** ④の `valid≤` は slot である（§3）。換算は③ではしない（§5 の質問）。
- 0007 が無い relay、または署名を知らない時は `until: null` のまま。

### 2.3 取消後の照会

接続を取り消した後も、所有者の署名つき照会で、§2.1 の読み取りが行われる。試験で、取消後に署名を回復し、送信は 1 回のままであることを確かめた。

## 3. ④の実際の executor（③のローカルで動かした）

- `a967f5f1` を worktree に出し、`cargo build --locked --bin runexec`。依存は crates.io から取得した。鍵、署名、有料 API は使っていない。
- `runexec demo --db <一時ファイル>`、`--scenario crash`、`--scenario raid` を実行した。`status` と `show` で台帳を読んだ。

| 場面 | ④の台帳 |
|---|---|
| happy | `Fulfilled`。Ship の試行 `valid≤14 landed`。費用 charged 10000 |
| crash | `Fulfilled`。送った後に落ちても、試行は 1 回 |
| raid | `Failed`（Raided）。到着量 `KnownZero` |

**④の正本の世界は MOCK（`sim`）である。** gateway の経路（`src/gateway.rs`）は、試験用の橋渡しを経由する。橋渡しの裏の chain は、⑤の試験の台本の chain である。

**③の操作は④の台帳に入っていない。** つながっていない理由は次のとおり。

1. ④の読み取りの口は CLI だけである。`status` は集計の JSON を返し、`show` は人が読む文を返す。run を機械が読む形式が無い。
2. SQLite の表を③が直接読むと、④の内部の形に依存する。だから③は読まない。
3. ③の操作を④の Run として登録するか（M7）は④が決める。

## 4. 試験（2026-11-05）

新しい試験 `test/lost-answer.test.mjs`（5 件）：

- 答えが失われた後、照会は⑤の記録を読み、署名を回復する。`POST /f/agent/action` の数は増えない。chain の transaction は 1 本のまま。回復した署名の `CARAVAN_SENT` で `processing` になる。
- 照会より先に再試行が来ても、記録を先に読み、再送しない。
- 取消後の所有者の照会でも回復する。`AwaitingSigned.until` に有効期限が入る（0007 がある時）。
- 次の場合は決めず、何も返さない：行が無い、`failed` で署名が無い。hold の署名は使う。`refused` は失敗にし、予約を返す。
- `until` は、自分の署名と有効期限の両方がある時だけ入る。

既存の 3 件は、記録が読めない場合を確かめる試験として残した。見え方からこのキーの行を外して確かめる（50 行から押し出された場合にあたる）：

- `attribution` #8
- `owner` 「答えが失われ、復号鍵の違いと取消」
- `play` 「再起動の後の再試行」は、記録から答える形に改めた

| 構成 | 結果 |
|---|---|
| 共有パッチ無し | 69 件：34 通過・35 省略・0 失敗 |
| ③0005 | 69 件：67 通過・2 省略・0 失敗 |
| ③0005 + ⑤0001 + ③0007 | 69 件：67 通過・2 省略・0 失敗 |
| 同上、`WS04_ROOT` = ④ `a967f5f1` | **69 件：68 通過・1 省略・0 失敗**（省略は、0005 が無い時だけの試験） |

実チェーンの E2E は、この版では実行していない。最新の実行は season 100（`5740e339`）。

## 5. 残件と、具体的に必要な物

| # | 必要な物 | 誰から | 使い道 |
|---|---|---|---|
| R1 | ⑤ `711d6c49` の commit（full bundle か、`45cba41e` または `4cd901de` からの incremental bundle）。または origin の branch 名 | ⑤ | G-1〜G-3 が入ったかの確認。入っていれば、0007 に頼らず⑤の答えから `until` を取る |
| R2 | G-1：`ActionResult` と見え方の行に `lastValidBlockHeight`・`slotFloor`。G-2：送信後の `failed` に署名。G-3：キーで結果を読む口（50 行の窓に依らない） | ⑤（④が統合） | 「行が無い」を決められない今の穴（§2.1）を閉じる |
| R3 | `runexec show --json`、または run を機械が読む API | ④ | ③が④の台帳を表の形に依らずに読む |
| R4 | M7 の判断：③の MCP 操作を④の Run として登録するか。するなら、`run_id` と③の `operationId` の対応、登録の口 | ④ | ③の操作を④の台帳に載せる |
| R5 | `AwaitingSigned.until` の単位：ブロック高を slot へ換算する責任 | ④ | ③は換算しない |
| R6 | 外部連携（Vercel、Netlify、GitBook）が `claude/modest-goldberg-c180fk` への push で動かないことの、設定での確認 | 利用者 | push の可否 |

**変えていない物：** 本番の認可サーバー、ChatGPT と Claude への接続（設定も公開もしていない）、共有コア、④⑤のコード、main。
