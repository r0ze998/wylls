# 18 ④の七つの状態と Run 契約への追従（③：MCP）

作業日 2026-11-06。親 `c8e1897407a12cad789be3cdebfff69058fe6fe0`、branch `ws03/runreceipt-port`（ローカルだけ、push していない）。

## 0. 使った版（実際に取得したもの）

| 担当 | 指定 | 取得できたもの | 使い方 |
|---|---|---|---|
| ④ | `77c5cbe2` | `77c5cbe2398c89559417f8cf18d4065b51455ee6`。同じ branch（origin `claude/gallant-ride-cunptv`）の後続 2 commit `b82fafa8f8095f83f157fcf80d2f15943982ebc4`（登録簿の入口）と `9568660675ad5464dcd2ce1a0f266f5a7dfb39cb`（契約 §7：③⑤⑬の呼び方）もある | **最新の `95686606` を使った。** 七つの状態と Run 契約は `77c5cbe2` の §1〜§6 のまま。§7 の登録・照会の入口がその後に足された。基点は統合候補 `ef63544c727490fc6801d30affd11c5b7106c480` |
| ⑤ | `b21a9fa8` | **取得できなかった** | 下記 §5 |

⑤ `b21a9fa8` は、この clone、origin のすべての branch（2026-11-06 に fetch）、GitHub の API（`get_commit`：「No commit found for SHA」）のどれにも無い。

そのため、代理の財布（共有コード）は④の tree にあるものを使った。⑤の branch の版とは照合していない。④はこの財布に次の物を足している：

- `GET /f/agent/fate`
- `ActionResult` の `sent`・`signature`・`lastValidBlockHeight`・`slotFloor`・`signedAt`
- 送った後の `failed` にも署名

③のパッチ 0005（SendCaravan）は、統合候補 `ef63544c` に既に入っている。0007（`/f/tx?detail=1`）は④の tree に無い。④は代わりに `GET /f/agent/fate` を使うよう求めている。だから③は 0007 に頼らない。

## 1. 二重にしないこと

- 状態は、財布の `GET /f/agent/fate?id=&key=` の答えをそのまま使う。読むだけで、送らない。③は七つの状態を判定しない。
- ④の登録簿は、④の `clients/acts.mjs`（`runexec act register|status|list`）を import して使う。CLI の呼び方と受領書の形を③で作り直していない。
- ④⑤のコード、共有コアは変えていない。③の外の変更は 0 件。

## 2. 七つの状態の扱い（`server.mjs` `applyFate`）

| state | ③の操作 | 予約 | 再送 |
|---|---|---|---|
| `landed`（finalized） | 自分の署名の着地 → `processing`（道中） | 使用のまま | しない |
| `failed`（finalized） | 失敗 `TransactionFailed` | 返す | しない（新しい requestId で新しい試行） |
| `expired`（証明つき） | 失敗 `NotLanded` | 返す | しない（同上） |
| `not-sent`（財布の記録） | 失敗。送る前の失敗（`sent: false`）を含む | 返す | しない（同上） |
| `pending` | 待つ。confirmed は判断に使わない | 数えたまま | **しない** |
| `unknown` | 保留 `ResultUnknown`。着地したかもしれない。窓を過ぎても決めない | **数えたまま** | **しない** |
| `unqueryable` | 何も変えない。行動については何も言っていない | 数えたまま | **しない**（例外は下） |

- **署名つきの `failed`**（`sent: true`）：送った後の失敗。`accepted` にし、署名と有効期限を記録し、財布の fate で追う。再送しない。
- **証明のない期限切れ**：④の契約では `unknown` になる。relay の `/f/tx` の `expired` も、fate がある時は読まない。
- **同じキーをもう一度送ってよい場合**は一つだけ。次の三つがそろった時に限る：
  1. 答えが失われた。
  2. 財布が答えた。
  3. その答えが `unqueryable` で、`retained: false`（このキーの記録を持っていない）。

  財布はキーを捨てない（`REQUESTS_MAX` で fail closed）。だからこの送信は、財布の replay か、最初が届いていなかった時の最初の送信になる。
- relay が答えない時、または財布がこの行動を知っていて未決の時は、送らない。`NotResent` を返す。

`ActionResult` の `sent: false`（送る前の失敗）は失敗にし、予約を返す。`sent` の欄が無い古い財布では、これまでどおり結果不明として扱う。

古い財布（`/f/agent/fate` が無い）では、これまでの経路（財布の履歴の見え方、relay の `/f/tx`）を使う。試験では `state.noFate` で再現した。

## 3. ④の登録簿（`acts`、任意）

- 最初の試行の前に `register({agentId, key: ws03:<link>:<requestId>, source: 'mcp', runId: <operationId>})` を呼ぶ。
  - 登録できなければ送らない（`RunRegistryUnavailable`、試行 0 のまま）。
  - 別の run の物と言われれば（`Conflict`）、試行 0 なら失敗にする。
- 照会のたびに `status` を呼ぶ（runexec が財布の fate を 127.0.0.1 で読み、記録する）。受領書に `ws04Act` として出す：`run4Id`、`state`、`next`、`newAttemptAllowed`、`cancel`（`until` はブロック高）。
- 再起動の後、または登録より前の操作では、照会の時に登録する。登録は冪等で、run4Id は同じになる。
- 起動の設定：`WYLLS_MCP_WS04_ACTS`、`WYLLS_MCP_WS04_RUNEXEC`、`WYLLS_MCP_WS04_DB`、`WYLLS_MCP_WS04_GATEWAY_PORT`。設定しなければ使わない。

## 4. 試験（2026-11-06）

### 4.1 新しい試験

`test/fate.test.mjs`（9 件）：④の tree の relay と財布のコード、台本の chain。

- 署名つき failed：再送しない。confirmed では決めない。finalized の着地で道中。
- failed：confirmed では決めない。finalized で失敗にし、予約を返す。
- unknown：寿命を過ぎ、node の履歴が送信の後から始まる。保留し、窓を過ぎても再送も返却もしない。relay の `expired` も無視する。
- 証明つき expired：失敗にし、予約を返す。fate は台本。この chain では証明を作れない。
- unqueryable（node が読めない）：何も変えず、再送しない。
- 答えが失われた：送らずに読む。読む口も落ちていれば `NotResent`。
- 財布に届かなかった（`retained: false`）：同じキーで 1 回だけ送る。
- `sent: false`：失敗にし、予約を返す。
- 答えが失われ、同じ store で再起動し、取り消した：所有者の照会で財布を読む。transaction は 1 本、数えるのは 1 回。

`test/ws04-acts.test.mjs`（3 件）：④の本物の `runexec`（`95686606` を `cargo build --locked`）と、④の `clients/acts.mjs`。

- 登録の内容（source mcp、run = 操作）。④の受領書が `pending/wait` から `landed/done` へ。
- 登録簿が動かない間は送らない。戻った後、1 回だけ登録し、1 回だけ送る。
- 答えが失われ、再試行し、再起動し、取り消した：登録は 1 つ、run4Id は 1 つ、transaction は 1 本。同じ登録は同じ run4Id を返し、別の run では `Conflict`。

### 4.2 既存の試験

古い財布の経路を確かめる試験として残した（`state.noFate`）：

- `lost-answer` の 5 件
- `attribution` の 1 件
- `owner` の 2 件
- `play` の 3 件

`play` の 1 件だけ、期待を改めた。④の `/f/tx` は finalized だけで決めるので、confirmed の失敗に `unknown` を答える。保留していなくても、未決のままであれば合格とした。

### 4.3 結果

| 構成 | 件数 | 通過 | 省略 | 失敗 |
|---|---|---|---|---|
| A：共有パッチ無し（③の基点 `4cd901de` の木） | 81 | 34 | 47 | 0 |
| B：古い財布（基点＋③0005＋⑤0001＋③0007）、`WS04_ROOT` = ④ `a967f5f1` | 81 | 68 | 13 | 0 |
| C：④ `95686606` の木、④の `runexec` とクライアント | **81** | **80** | **1** | **0** |

- B の省略は、fate と④の登録簿の試験。C の省略は、0005 が無い時だけの試験。
- ④の試験のうち、鍵を作らないものも実行した：`clients/acts.test.mjs` 4/4、`permutation-gateway/test/agent-wallet-run-facts.test.mjs` 4/4。

**していないこと：**

- 鍵の生成・導出・署名を伴う試験（④の `tests/gateway.rs`、橋、財布の既存の試験の大半）
- 実チェーンの E2E
- 有料 API
- 実アカウントや ChatGPT・Claude への接続

## 5. 残件

| # | 必要な物 | 誰から |
|---|---|---|
| R1 | ⑤ `b21a9fa8`：origin に push した branch 名、または bundle（`ef63544c` か `45cba41e` から）。届けば、④の tree の財布との差（`fate`・`sent` の欄）を照合する | ⑤ |
| R2 | ④ §6 の判断：結果不明のまま残った行動を、いつまで待つか。③は今、`unknown` を保留のままにし、予約を返さない | ④（ゲームの仕様） |
| R3 | ③の MCP を統合候補に入れるか。③の branch は `4cd901de` の上にある | ④（統合） |
| R4 | `claude/modest-goldberg-c180fk` への push で外部連携（Vercel、Netlify、GitBook）が動かないことの、設定での確認 | 利用者 |
