# テストの結果（2026-10-30、token の確かめ方の隔離と 0004 の後）

**外部通信なし。** モデルの相手は 127.0.0.1 の HTTP fixture だけです。キーは読まず、作らず、設定していません。実資金・課金・push・merge・deploy・追加の取得はしていません。鎖はすべて試験用の偽物（scripted chain）です。

## ⑤のブランチ（共有コードは変えていない。中継のツリー `560f8659…`）

| コマンド | 結果 |
|---|---|
| `node --test workstreams/05-ai-participation/model-api/test/*.test.mjs` | **51 件、通過 51、失敗 0、スキップ 0**（3回連続） |
| `node --test workstreams/05-ai-participation/test/*.test.mjs` | **37 件、通過 37、失敗 0**（3回連続） |
| `node workstreams/05-ai-participation/model-api/demo/run-api-demo.mjs` | 完了。開始の前の確認は、隔離した probe（このツリーだけ）で通った |

## 共有コードのパッチを当てた、使い捨ての worktree

| 当てた物（順に） | `permutation-gateway` のツリー | 試験 | 結果 |
|---|---|---|---|
| ③ 0005 → ⑤ 0002b → 0001 → 0003 | `98f52eb2…` | `permutation-gateway` 全体 | 2,543 件、通過 2,542、失敗 0、スキップ 1（前回） |
| 同上 | 同上 | ⑤ 37・model-api 51（`RELAY_TREE=98f52eb2…`） | すべて通過。ツリーの確認の試験も通過 |
| 同上 | 同上 | 統合（probe をこのツリーで有効に） | 9/9 |
| ⑤ 0004 だけ | `de408b44…` | `permutation-gateway` 全体 | **2,532 件、通過 2,531、失敗 0、スキップ 1** |
| ③ 0005 → ⑤ 0002b → 0001 → 0003 → 0004 | `ff2efb1f…` | `permutation-gateway` 全体 | **2,546 件、通過 2,545、失敗 0、スキップ 1** |
| 同上 | 同上 | model-api（ツリーの確認の試験を除く 50 件） | 通過 49、**スキップ 1**（probe の試験：`agent_whoami` がある中継では probe を使わないため）。スキップは合格に数えない |
| 同上 | 同上 | ⑤ 37 | すべて通過 |
| 同上 | 同上 | 統合（probe を**無効**にして：`WS03_GATEWAY_TREE=none`） | 9/9。⑤は `agent_whoami` で開始した |
| 同上 | 同上 | `agent_whoami` の経路の確認 | 使われた。冪等の記録は 0 件増。回された token は `BadCapability`。token の値は結果に出ない |

**統合の試験の構成：③ 実サーバー ＋ ⑤ 実コード ＋ ④ 代役 ＋ 模擬チェーン。** ④の Rust の実行器はつないでいません。

**③の MCP の試験：** 42 件のうち、通過 40、スキップ 1、**未実行 1**（`sdk-client.test.mjs`：依存の `@modelcontextprotocol/sdk` が無く、読み込みで止まる。runner は fail と数えるが、中身は実行されていない）。**全件成功ではありません。** 依存は入れていません。

## 受領した④の試験（使い捨ての clone、`2e536b6b`、前回）

`cargo test --locked`：62 件すべて通過。ツールチェーンと crate は前回の取得のまま（`TOOLCHAIN-RECORD.ja.md`）。今回は追加の取得をしていません。

## 内訳（model-api、51 件）

| ファイル | 件数 |
|---|---|
| `test/model-api.test.mjs` | 11 |
| `test/http.test.mjs` | 12 |
| `test/autopilot.test.mjs` | 11 |
| `test/citizen.test.mjs` | 16（追加：本物の中継での probe（冪等の記録が1件・それ以外は増えない・キーの形・同じキーは再生）、冪等の記録の上限で古い要求が2回目の送信になる危険の再現。stub の試験を新しい規則に書き直した） |
| `test/relay-tree.test.mjs` | 1（新規：試験が名乗る中継のツリーと、ディスク上のツリーが同じか） |

## 実行していないもの

- ③の `sdk-client.test.mjs`（依存が無い）と、③の実チェーンの E2E
- ④の Rust の実行器をつないだ試験
- 本物の LLM・課金 API、本番の利用レポートとの照合
- 2つ目のプロセスでの実行
