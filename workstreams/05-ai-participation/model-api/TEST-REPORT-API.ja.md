# テストの結果（2026-10-30、③・④の実物を受領した後。再改訂）

**外部通信なし。** モデルの相手は 127.0.0.1 の HTTP fixture だけです。キーは読まず、作らず、設定していません。実資金・課金・push・merge・deploy はしていません。鎖はすべて試験用の偽物（scripted chain）です。

## ⑤のブランチ（共有コードは変えていない）

| コマンド | 結果 |
|---|---|
| `node --test workstreams/05-ai-participation/model-api/test/*.test.mjs` | **48 件、通過 48、失敗 0**（3回連続） |
| `node --test workstreams/05-ai-participation/test/*.test.mjs` | **37 件、通過 37、失敗 0**（3回連続） |
| `node workstreams/05-ai-participation/model-api/demo/run-api-demo.mjs` | 完了。各回の RunReceipt は適合 |

## 共有コードのパッチを当てた、使い捨ての worktree

| 当てた物（順に） | 試験 | 結果 |
|---|---|---|
| ③ 0005 → ⑤ 0002b → 0001 → 0003 | `permutation-gateway` 全体 | **2,543 件、通過 2,542、失敗 0、スキップ 1**（Gemma のモデルファイルがない） |
| 同上 | `agent-wallet-*`・`frontier-relay*` | 111/111 |
| 同上 | ③の MCP（`WS03_GATEWAY_ROOT`） | 42 件：通過 40、スキップ 1、**未実行 1**（`sdk-client.test.mjs`：依存 `@modelcontextprotocol/sdk` が無く、読み込みで止まる。runner は fail と数える。中身は実行されていない）。**全件成功ではない** |
| 同上（`permutation-gateway` のツリー `98f52eb2…`） | ⑤ 37 件・model-api 48 件 | すべて通過 |
| 同上 | **③との統合**（③の本物のサーバー）：`ws03-same-citizen` 3 件、`same-citizen-contention` 6 件 | **9/9** |
| ⑤ 0002・0003（0005 なし） | `permutation-gateway` 全体 | 2,533 件、通過 2,532、失敗 0、スキップ 1（前回） |

## 受領した④の試験（使い捨ての clone、`2e536b6b`）

| コマンド | 結果 |
|---|---|
| `cargo test --locked`（`workstreams/04-execution`） | **62 件すべて通過**。ツールチェーンは rustup が自動で取得し（許可を得ていない取得）、crate は `cargo fetch --locked` で取得した（`TOOLCHAIN-RECORD.ja.md`） |

## 内訳（model-api、48 件）

| ファイル | 件数 |
|---|---|
| `test/model-api.test.mjs` | 11 |
| `test/http.test.mjs` | 12 |
| `test/autopilot.test.mjs` | 11 |
| `test/citizen.test.mjs` | 14（追加：token の確かめ方（代理・所有者・範囲・有効性、モデルを呼ぶ前）、token を残さない、門で断られる確かめ、止めても未確定の費用は戻らない、取消の根拠、再起動後の run id の続き） |

## 実行していないもの

- ③の `sdk-client.test.mjs`（依存が無い）と、③の実チェーンの E2E（validator が要る）
- 本物の LLM・課金 API、本番の利用レポートとの照合
- ④の Run・Receipt を⑤から実際に呼ぶこと（呼び方が決まっていない）
- 2つ目のプロセスでの実行
