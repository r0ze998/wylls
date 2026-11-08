# 24 「③ and ⑤ on one agent」の間欠的な失敗の調査（③：MCP）

作業日 2026-11-08。branch `claude/modest-goldberg-c180fk`。

## 0. 前提

- 報告：④の 4d44f021 の上の並列の実行で、この試験が 1 回だけ失敗した。その後、candidate で 9 回、baseline（16576826）で 5 回実行し、再現しなかった。
- ④の報告そのもの（失敗のログ、厳密な試験名、実行の条件）は、repository に無い。④に回収を依頼した（未着）。
- この名前に当たる③の試験は 2 つある。
  - `keyfree/integration.test.mjs`「③ and ⑤ on one agent and one ④ registry: …」。③自身の記録（22 §3）でも 8 回中 1 回落ち、原因は未確定だった。
  - `keyfree/run.test.mjs`「③ (mcp, a ⑥ run) and ⑤ (ai, …) on one agent and one registry, …」

## 1. 静的な確認

**import：**

- harness（鍵なし、PDA なし）
- 財布の `AgentGateway`（偽の keyring）
- ④の `clients/acts.mjs`
- ⑤の `acts-port.mjs`

鍵を作る・導出する・署名する呼び出しは無い（3 つのガードの下で実行した）。

**subprocess：** ④の `runexec act register|status|list` だけ。SQLite に書くこと、127.0.0.1 の fate の口への GET だけで、鍵も署名も使わない（④ `acts.rs` と `main.rs` を読んだ）。

**共有状態：**

- 試験ごとに新しい `mkdtemp` の run store を作る。
- fate の口は試験ごとに 127.0.0.1 の空き port（`listen(0)`）。
- 試験の間で状態は共有しない。

**並列性：** 試験の中で、③の送信（その中で `runexec act register`）と、⑤の `registerBeforeSend`（`runexec act register`）を `Promise.all` で同時に始める。2 つの別のプロセスが、**作ったばかりの同じ SQLite のファイル**を、同時に初めて開く。

## 2. 切り分け（鍵なしの限定実行、④ 16576826 の runexec）

| 条件 | `StoreError: database is locked` |
|---|---|
| 2 つの `act register`（キーは別）が、新しい run store を同時に初めて開く | **6/80、9/200** |
| 8 つが同時 | 0/160 |
| 先に 1 回開いてから（`act register`）、2 つが同時 | 0/200 |
| 先に 1 回開いてから（`act list`、行を書かない）、2 つが同時 | 0/300 |

**原因として示せたこと：**

- ④の `Store::open` は、開くたびに `PRAGMA journal_mode=WAL` と `CREATE TABLE IF NOT EXISTS` を行う。
- 新しいファイルへの最初の同時の open で、busy timeout（10 秒）があっても `database is locked` が返る。
- 試験では、この答えは次のどちらかになり、85 行目の `assert.deepEqual([r3.state, g5.ok, …])` が落ちる。
  - ③の `RunRegistryUnavailable`（`r3.state` が無い）
  - ⑤の `ok: false`（`ActsUnavailable`）

**示せていないこと：**

- 4d44f021 の 1 回が、これだったこと。ログが無い。
- 試験の単位では、旧い作りでも 6 並列 48 回で 0 回だった。③の登録は、計画・capability・文脈の非同期の段の後に始まり、⑤の登録と数ミリ秒の内に重なることがまれなため。

**残る仮説（確認していない）：**

- 負荷の高い時の `runexec` の起動の遅れ（client の既定の timeout は 15 秒）。
- fate の口の応答の遅れ。

## 3. 直したこと（③の試験だけ。リトライも timeout の延長もしない）

- `harness.mjs` に `openRunStore` を足した。新しい run store を、③と⑤が同時に使う前に 1 回だけ開く（`runexec act list`。行は書かない）。`integration.test.mjs` と `run.test.mjs` の setup で使う。
- `registry-busy.test.mjs`（新）：④の登録簿が `StoreError: database is locked` を返した時、③が何も送らず `RunRegistryUnavailable`（同じ requestId で再試行）を返し、再試行では 1 回だけ登録して 1 回だけ送ることを、決定的に確かめる。登録簿の答えは台本で、実物の runexec と同じ形にした。
- `run-store-cold-open.sh`：④向けの再現の script。③の試験の一式には含めない。

**③の製品のコードは変えていない。** 登録できない時に送らないのは、もともとの動き（21）である。

**④の側（④の判断）：** `Store::open` の最初の同時の open での `database is locked`。

- 例：WAL への切り替えと表の作成を 1 か所で済ませる。
- 例：その段の `SQLITE_BUSY` を待つ。

③は④のコードを変えない。

## 4. 試験（鍵なし、PDA なし。⑤・④・③のガード）

| 試験 | 結果 |
|---|---|
| `run-guarded.sh`、16576826 に③の directory を入れた木 | 33/33 を 2 回 |
| 同じく、checkpoint 95b0ab22 | 33/33 |
| 2 つの「one agent」の試験（新しい setup）、6 並列で 48 回 | 失敗 0 |
| 旧い setup の integration の試験、6 並列で 48 回 | 失敗 0（試験の単位では再現せず） |

**状態：** 試験の単位での 4d44f021 の失敗は、**再現していない（inconclusive）**。そのうえで、試験がこの競合に偶然依存しないようにした。
