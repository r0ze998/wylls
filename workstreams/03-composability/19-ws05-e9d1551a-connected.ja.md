# 19 ⑤ e9d1551a と④の実登録簿への接続（③：MCP）

作業日 2026-11-06。親 `8d99336f40a98369f86e0dac40b629d71067e1fe`、branch `ws03/runreceipt-port`（ローカルだけ、push していない）。

## 0. 受け取った物と復元

| 担当 | 受け取った物 | 確認 | 復元先 |
|---|---|---|---|
| ⑤ | `ws05-e9d1551a-delivery.tar.gz`（SHA-256 `f7dfecf720102be754c9e98069bc6d891baea3385b6e5ad2f069f4daece5c39b`） | ファイル全体が一致。同梱の `SHA256SUMS` も全行 OK | `ws05-since-45cba41e.bundle` を origin の `45cba41e` の上に fetch。`e9d1551aa049f25c54fd6ebc24185d93a2d8ac4c`、tree `a20da6e25bf57ec49f1479cc7d9222c05ad23d43`（⑤の記載と一致）。変更は `workstreams/05-ai-participation/` の中だけ |
| ④ | GitHub `claude/gallant-ride-cunptv` `9568660675ad5464dcd2ce1a0f266f5a7dfb39cb` | 前回と同じ | `runexec` を `cargo build --locked` |
| 財布（共有コード） | ④ `95686606` に、⑤の共有パッチ 3 件（`shared-patches-on-ws04/`：0002c、0003、0004b）を `git am` で当てた | `permutation-gateway` の tree `f30edf74b3198634e6b13b92840b0405f0c2e539`（⑤の記載と一致） | ③の試験の `WS03_GATEWAY_ROOT` |

⑤の `proposal-for-ws04/0001`（④の register を原子的にする）は、④が判断する物なので当てていない。

## 1. 実物とmockの区別

| 部品 | 実物か | 中身 |
|---|---|---|
| 中継と代理の財布のコード（`/f/agent/action`、`/f/agent/fate`、`ActionResult` の `sent` と署名の事実） | **実物** | ④ `95686606` に⑤のパッチを当てた木。fixture は、プロセスの中から呼ぶ |
| ④の登録簿（`runexec act register\|status\|list`、SQLite の run store） | **実物** | ④の `runexec` のバイナリ。④の `clients/acts.mjs` |
| ⑤の登録の口（`loadFourActsPort`、`registerBeforeSend`、`txStateFromActs`） | **実物** | ⑤ `e9d1551a` の `model-api/src/acts-port.mjs` |
| ③の MCP サーバー | **実物** | このコード |
| chain | **mock** | 財布の試験用の台本の chain（`agent-wallet-fixtures.mjs`）。finalized・失敗・寿命・履歴は、試験で設定する |
| herald | **mock** | ③の fixture の台本 |
| 財布の fate の答え | 実物（例外は下の 2 件） | runexec は、127.0.0.1 の口から本物の `GET /f/agent/fate` を読む |
| 　台本にした fate①：⑤の 3 つの行動の fate | **mock** | ⑤の自動運転は、この試験では送らない |
| 　台本にした fate②：③の「証明つき expired」 | **mock** | 台本の chain では、証明を作れない |
| ⑤の自動運転・モデル・実チェーン・実アカウント | **使っていない** | — |

## 2. ③の接続（今回の変更）

- **④の登録簿の UNIQUE 競合：** ⑤が見つけた④の `register` の競合を扱う。同じ新しいキーを同時に登録すると、負けた方が `BadRequest UNIQUE constraint failed` になる。③は、この 1 種類だけを 1 回だけ登録し直す（⑤と同じ扱い）。登録は冪等なので安全である。ほかの誤りは、これまでどおり送らずに返す。
- それ以外は 18 のとおり。照会は財布の fate で、送らない。登録は④の client で、source は `mcp`、run は③の操作。
- ③と⑤のキーは交わらない。
  - ③：`ws03:<link>:<requestId>`、run は③の操作 id
  - ⑤：`ai:<requestId>`、run は `p05-autopilot:<agentId>`

## 3. 試験（2026-11-06）

### 3.1 新しい試験：`test/ws05-shared-registry.test.mjs`（2 件）

**1 件目：** ③と⑤が、1 つの代理と 1 つの④の登録簿を共有する。③は④の client、⑤は⑤の実物の port を使う。

- ③：送った後に答えが失われる → 再試行は送らずに読む（`pending`）→ 再起動（同じ store と同じ run store）→ 取消 → finalized → 所有者の照会で `processing`、④の受領書も `landed`。run4Id は最後まで 1 つ。
- ⑤：同じ時に 3 つの行動を登録する（並行）。
  - `unknown` は `hold`。
  - `unqueryable` は `read-again`。
  - 証明つき `expired` だけが `new-attempt`。
  - ③の一連の処理の後も、`unknown` は `hold` のまま。
- ④の一覧：③の run には③の 1 件（mcp）、⑤の run には⑤の 3 件（ai）。交わらない。
- 送信 1 回、transaction 1 本。

**2 件目：** ④の UNIQUE 競合を 1 回だけ再登録し、その後に 1 回だけ送る（④の client の代わりに stub）。

### 3.2 全体

| 構成 | 件数 | 通過 | 省略 | 失敗 |
|---|---|---|---|---|
| D：④ `95686606` ＋⑤の共有パッチ（財布の木 `f30edf74`）、④の `runexec` と client、⑤ `e9d1551a` の port | **83** | **82** | **1** | **0** |
| A：共有パッチ無し（③の基点の木） | 83 | 35 | 48 | 0 |

- D の省略：パッチ 0005 が無い時だけの試験。

**⑤自身の試験：** ⑤の手順どおり、鍵を使わないものだけを③の環境で実行した。

- 対象：`model-api`、`http`、`relay-tree`、`multiprocess`、`longrun`、`acts-fate`、`acts-port`、`acts-runexec`。`acts-runexec` は④の `runexec` と client を使う。
- 結果：48/48。
- 実行の前に、各試験ファイルと、`participate.mjs` までの import に、鍵を作る・導出する・署名する行が無いことを grep と目視で確かめた。

**実行していないもの：**

- 鍵の生成・導出・署名を伴う試験。たとえば次のもの：
  - ⑤：`citizen`、`autopilot`、`integration/*`、`continuing`
  - 財布：パッチに付く試験（`agent-wallet-duplicate-bytes`、`whoami`、`mcp`）
  - ④：`tests/gateway.rs`
- 実チェーン
- 有料 API
- 実アカウント

## 4. 未送信とみなさない物（③と⑤で同じ）

| state | ③ | ⑤（実物の port の答え） |
|---|---|---|
| `unknown` | 保留 `ResultUnknown`。予約は数えたまま。送らない | `hold`、`newAttemptAllowed: false` |
| `unqueryable` | 何も変えない。送らない（例外は、財布が答え、このキーの記録を持たない時だけ。財布はキーを捨てないので、その送信は replay か、最初が届かなかった時の最初の送信） | `read-again` |
| 証明のない期限切れ（relay `/f/tx` の `expired`） | 読まない（④の契約では `unknown`） | `GET /f/tx` の `expired` は確定にしない |
| 署名つき `failed` | 署名で追う。送らない | 送られた物として追う |

## 5. 残件

| # | 項目 | 誰が |
|---|---|---|
| R1 | ⑤の `proposal-for-ws04/0001`（register を原子的にする）の採否。採れば、③と⑤の 1 回の再登録は要らなくなる | ④ |
| R2 | capability は代理 1 つに 1 つ。③の同意（`rotate-capability`）で⑤の token が無効になる（⑤ `HANDOFF-3` §5・§6）。送り手ごとの capability にするかは④の統合判断。③の同意の流れが変わるかもしれない | ④（③の判断事項） |
| R3 | ⑤の `HANDOFF-3` §3 の欄（③の接頭辞 `ws03:`、source `mcp`、⑤の印を尊重するか、本人の取り分）の合意 | ③⑤ |
| R4 | 結果不明が続いた時に、いつまで待つか（④ §6） | ④（仕様） |
| R5 | ⑤と④の branch の push。⑤は GitHub に `45cba41e` までしかない | ④⑤ |
| R6 | `claude/modest-goldberg-c180fk` への push で、外部連携が動かないことの確認 | 利用者 |
