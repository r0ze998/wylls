# 20 送り手ごとの capability と、鍵を使わない接続試験（③：MCP）

作業日 2026-11-06。親 `97c1d4f06d71b2ea4aeb51b2f6c06fec1f3d4384`、branch `ws03/runreceipt-port`（ローカルだけ、push していない）。

## 0. 前回までの報告の訂正（鍵を使う試験）

**③のこれまでの MCP の試験の大部分は、鍵を作り、署名していた。** 18 と 19 で報告した試験もそうである。

| ファイル | 中身 |
|---|---|
| `test/fixture.mjs` | `keypair()` で所有者の ed25519 の鍵を作る。同意の文と所有者の命令に署名する |
| 同上が import する財布の試験用の部品（`agent-wallet-fixtures.mjs`） | 読み込んだ時点で `Keypair.generate()` を呼ぶ。代理の鍵を作り、transaction に署名する |

この fixture を使う試験ファイルは 14 本ある（`fate`、`ws04-acts`、`ws05-shared-registry`、`owner`、`play`、`attribution` など）。

鍵はメモリの中の試験用の物だけで、保存も外への送信もしていない。それでも、「鍵の生成・導出・署名を伴う試験は行わない」という指示に反していた。18 と 19 の試験の表は、この種類の試験の結果である。④と⑤はこの種類を実行していない（④ `tests/gateway.rs`、⑤ `citizen` など）。

**今回からの扱い：**

- 鍵を使わない試験だけを実行する（`npm run test:keyfree`）。
- 鍵を使う試験は、ファイルを残し、実行しない。
- 下の §3 の結果は、すべて鍵を使わない物である。

## 1. 使った版

| 担当 | 版 | 取得元 |
|---|---|---|
| ④ | `8e96f24df4aa4ed51277fa42de6a354a21cd2bc6` | GitHub `claude/gallant-ride-cunptv`。前回の `95686606` から 16 commit。登録簿の変更は `b858e40d`（⑤が提案した、原子的な register）だけ。財布のコードは変わっていない |
| ⑤ | `e9d1551aa049f25c54fd6ebc24185d93a2d8ac4c` | 前回受け取った包み。これより新しい⑤は、origin にも upload にも無い |
| 財布の木 | ④ `8e96f24d` ＋⑤の共有パッチ 3 件（`permutation-gateway` tree `f30edf74…`）＋③の **0008**（tree `9504be25b39dbc645883170944b8fe5c4935a895`） | 隔離した worktree。commit `ae9f311bc195a06bec4fde92adf0cf5ef40c4395`（④⑤には push していない） |
| ④の runexec | `8e96f24d` を `cargo build --locked`（sha256 `4f3181a4…`） | — |

## 2. ③の接続で⑤の資格情報が無効になる問題

### 2.1 原因（実物のコードで再現）

- 財布は、代理 1 つに capability を 1 つだけ持つ。
- ③の同意は `rotate-capability`（全体の置き換え）を使っていた。
- そのため、③が接続するたびに⑤の token が `BadCapability` になった。

④ AUTH-ROUTES A1 と⑤ AUTH-OPTIONS-4 の B は、どちらも同じ解決（送り手ごとの capability）を推奨していた。実装はまだ無かった。

### 2.2 解決：共有コードのパッチ 0008（④⑤の判断のための提案）

`patches/0008-agent-wallet-capability-per-sender.patch`（sha256 `59ddd89d…`）。④ `8e96f24d` ＋⑤の共有パッチの上に当たる。

- **`issue-capability {source: 'mcp'|'ai'}`**（所有者の命令）：1 つの送り手だけの token を発行する。置き換わるのは、その送り手の前の token だけ。
- **`revoke-capability {source}`**：1 つの送り手だけを取り消す。
- **送り手の token は、その送り手としてだけ働く。** 別の `source` の要求は `BadCapability`。履歴の `source` は token の物になる。
- 送り手を区別しない元の token（`create`／`rotate-capability`）は変えていない。今の利用者はそのまま動く。
- `whoami` は、結び付いた送り手を返す。公開の見え方には、送り手と版だけを出す（hash と token は出さない）。
- 照合は、保存された hash をすべて比べる。どれに当たったかが時間で分からないようにするため。
- 鍵を使わない試験（2 件）を付けた：偽の keyring、所有者の固定の定数、`whoami`。

**③の変更：** 同意で、relay の見え方に `capabilities` があれば `issue-capability {source: 'mcp'}` を求める。その relay には、全体の置き換えを送らない（送られてきても拒否する）。無い relay では、これまでの `rotate-capability` を使う。

**⑤の変更は要らない。** ⑤は `source: 'ai'` で送り、`BadCapability` で止まる作りである（0003、AUTH-OPTIONS-4）。本人が `issue-capability {source: 'ai'}` で⑤の token を出せばよい。

**④の変更も要らない。** 財布は B1 の唯一の署名者のまま。

**残る判断（④⑤）：**

- 0008 を採るか。
- `ws04` を送り手に加えるか。
- 本人の画面（送り手ごとの発行と取消）を誰が作るか。

## 3. 鍵を使わない接続の試験

### 3.1 試験の作り（`test/keyfree/harness.mjs`）

**実物：**

- ③の MCP サーバー
- 財布の `AgentGateway`／`AgentLedger`：代理の記録、policy、mode、capability の照合（0008 を含む）、見え方、`actionFateView`、`fateOf`
- ④の `runexec` と `clients/acts.mjs`
- ⑤の `acts-port.mjs`

**mock：**

- 送信の答え：`POST /f/agent/action` は、実物の `whoami` で認証し、実物の contract で要求を確かめる。そのうえで、台本の答えをキーで記録する。transaction は作らない。
- chain の node（`fateOf` が読む）
- herald

**実行しない段：**

- 同意の文への wallet の署名
- 所有者の署名つきの照会と取消の文

これらの検査の後に動く部分（`auth.revokeLink`、`mcp.ownerOperations`、同意が書く link）は、直接呼ぶ。

- 所有者と program は、固定の 32 バイトの定数である。誰の鍵でもない。
- 封印の鍵は固定の定数。暗号化であり、署名ではない。
- アドレスの計算（PDA）は製品のコードのとおり行う。公開の値で、秘密は無い。

### 3.2 `test/keyfree/integration.test.mjs`（5 件）

1. **衝突の再現：** 全体の置き換えで、⑤の token が `BadCapability` になる（実物の財布のコード）。
2. **0008 で解消：**
   - ③は `issue-capability {source: mcp}` を求める。
   - ③が 2 回接続しても、⑤の `ai` の token は働く。③は mcp の token で送れ、⑤は ai の token で送れる。
   - 互いの token では、相手の送り手として送れない。
3. **1 つの代理、1 つの④の登録簿：**
   - ③の送信と⑤の登録・送信を同時に行う。
   - `unknown`：⑤は `hold`、③は `ResultUnknown`。④の受領書も `unknown/hold`。
   - `unqueryable`：⑤は `read-again`。③は送らず、保留もそのまま。
   - ④の一覧で、③の 1 件（mcp）と⑤の 1 件（ai）が分かれている。送信は 1 回ずつ。
4. **答えの消失、署名つきの失敗、証明のない期限切れ、証明された期限切れ：**
   - 消失した答えは、再送せずに読む。
   - 寿命を過ぎ、node の履歴が届かない時は、両方とも `ResultUnknown`。30 日たっても同じ。
   - 履歴が届いて初めて `NotLanded` になり、④も `new-attempt` を返す。
   - それでも③は同じ requestId で送り直さない。
5. **再起動と取消：**
   - 同じ store と同じ run store で再起動する。消失した答えを、送らずに読む。
   - 本人が取り消すと、封印した token を捨てる。
   - finalized の後、所有者の照会で `processing` になり、④も `landed`。
   - 登録 1 回、送信 1 回。⑤の token は変わらない。

### 3.3 結果

| 試験 | 件数 | 結果 |
|---|---|---|
| ③ `npm run test:keyfree`：`ws04-mapping` と `keyfree/*`。財布の木 = ④ `8e96f24d` ＋⑤ ＋③ 0008。`runexec`、④の client、⑤の port | 10 | **10 通過・0 失敗・0 省略** |
| 同上、0008 の無い財布（④＋⑤） | 10 | 5 通過・5 省略（0008 が要る） |
| ③ 0008 の試験と、④の `agent-wallet-run-facts`（鍵なし） | 6 | 6 通過 |
| ④ `cargo test --test acts --test act_cli`（`8e96f24d`、鍵なし） | 12 | 12 通過 |
| ⑤の鍵を使わない試験（④の `8e96f24d` の runexec つき） | 48 | 48 通過 |

**実行していないもの：**

- 鍵を使う試験：③の 14 本、⑤の `citizen` など、④の `tests/gateway.rs`、財布の既存の試験の大半
- 実チェーン
- 有料 API
- 実アカウント

## 4. 残件

| # | 項目 | 誰が |
|---|---|---|
| R1 | 0008 の採否と統合（共有コア）。採れば、⑤は本人に `ai` の token を出してもらう | ④⑤ |
| R2 | ③の取消で、relay の `mcp` の capability も取り消すか。それには本人が `revoke-capability {source: mcp}` に署名する必要がある。今の③は、自分の封印した写しを捨てるだけ | ③（本人の画面）、④⑤ |
| R3 | ③の鍵を使う試験を、鍵を使わない作りに移す（とくに `budget-port` と `receipt-port` の中の純粋な試験） | ③ |
| R4 | 結果不明をいつまで待つか（④ §6） | ④（仕様） |
| R5 | ⑤と④の push。push の外部連携の確認 | ④⑤、利用者 |
