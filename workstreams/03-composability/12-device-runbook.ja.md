# 12 実機接続の手順と、直前に要る承認

作業日 2026-10-30。**この文書の手順は、まだ一度も実行していない。** Claude と ChatGPT の画面は見ていない。ローカルで確かめたのは、サーバーが各クライアントの資料の要件を満たすかどうか（preflight、§1）までである。

## 0. 順番

1. **Claude Code**（同じ機械。外部公開なし）← 最初
2. ChatGPT（Secure MCP Tunnel か公開 HTTPS）
3. Claude の web・Desktop・mobile（公開 HTTPS と、Claude のコールバックの許可）

最初に通すのは「読取」と「本人の場所の間の隊商」だけ。他人宛ての送付は、S1 では所有者のウォレットの署名が要る（`caravan.rs:727` の `WalletRequired`）。この経路では作らず、③は `NotYourPlace` で断る（試験）。他人宛ての承認の経路を省略する作りにはしない。

## 1. 接続の設定（ローカルで用意済み）

| 設定 | 値 | 既定 |
|---|---|---|
| `WYLLS_MCP_REDIRECT_PROFILES` | `chatgpt`、`claude`、`loopback` の組み合わせ | `chatgpt,loopback`（今までと同じ） |
| Claude Code 用 | `loopback`（localhost と 127.0.0.1、番号は問わない） | 既定に含まれる |
| ChatGPT 用 | `chatgpt`（`https://chatgpt.com/connector_platform_oauth_redirect` ほか） | 既定に含まれる |
| Claude の hosted 用 | `claude`（`https://claude.ai/api/mcp/auth_callback`） | **含まない**（公開の承認の後に付ける） |
| 外部に出す時の候補 | 使うクライアントの profile だけにして、`loopback` を外す | — |

**preflight**（`node bin/wylls-mcp-preflight.mjs <URL> <client>`）は、動いているサーバーを、そのクライアントの資料の要件と照らす。

- 照らす項目：401 と `resource_metadata`、`resource` が入力した URL と一致すること、S256、DCR、そのクライアントのリダイレクトで登録できること、トークン端点。
- loopback のサーバーにだけ使える。OAuth のクライアントを登録するため。

この作業機での結果（[results/mcp-preflight.log](results/mcp-preflight.log)）:

| クライアント | 結果 | 通らない項目 |
|---|---|---|
| claude-code | **通る** | — |
| chatgpt | 通らない | `scheme`（公開 HTTPS が要る。設計どおり） |
| claude | 通らない | `scheme` と、コールバックの登録（既定の profile に入っていない。設計どおり） |

## 2. Claude Code での手順（承認の後に行う）

前提：ローカルの stack とパッチ 0005 の relay（`mcp/e2e/README.md` の手順 1〜2）。Claude Code が入った、同じ機械。

```sh
# 1. MCP サーバー（試験用の認可サーバー、ストアと封印の鍵はこの機械の中だけ）
cd workstreams/03-composability/mcp
export WYLLS_MCP_SEAL_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"   # 画面にもログにも出さない
WYLLS_MCP_TEST_AS=1 WYLLS_MCP_RELAY=http://127.0.0.1:41740/gw WYLLS_MCP_HERALD=http://127.0.0.1:41740 \
  WYLLS_MCP_PORT=41960 WYLLS_MCP_STORE=$HOME/.local/wylls-mcp/store.json node bin/wylls-mcp.mjs &

# 2. 直前の確認（Claude Code の要件）
node bin/wylls-mcp-preflight.mjs http://127.0.0.1:41960/mcp claude-code     # exit 0 であること

# 3. 登録（scope は local。URL は resource と完全に同じ 127.0.0.1 の形で）
claude mcp add --transport http wylls-local http://127.0.0.1:41960/mcp

# 4. Claude Code の中で /mcp → wylls-local → sign-in。ブラウザに同意画面が開く
#    → 戻り先が http://localhost:<番号> と表示されることを確かめる
#    → 試験用ウォレットのアドレスと代理人 ID、上限（回数 1〜2、期限 1 時間）を入れ、ウォレットで 2 回署名する
```

会話で確かめること（それぞれ、確かめられたものだけを記録する）:

| # | 依頼の例 | 期待 |
|---|---|---|
| 1 | 「村の様子を見て」 | `get_village_status` が呼ばれる |
| 2 | 「倉庫を建てるのに何が足りない？」 | `check_resource_shortfall` |
| 3 | 「倉庫から村へ石を 100 運ぶ準備をして」 | `prepare_caravan`。要約が出て、まだ送らない |
| 4 | 「送って」 | `send_caravan` の前に、Claude Code がツールの使用の許可を求めるか（**未確認**：資料の該当部分を読めていない） |
| 5 | 「隊商は着いた？」 | `get_operation_status`。`processing` から `completed`、量は `unverified` |
| 6 | 「他の人の倉庫に送って」 | `NotYourPlace`。ウォレットなしでは送れないと説明されること |
| 7 | 履歴に仕込んだ指示（試験用） | 従わないこと（**モデルの耐性は、ここで初めて確かめる**） |

## 3. 終了と失効の確かめ方（毎回）

| # | 操作 | 確かめること |
|---|---|---|
| 1 | `claude mcp logout wylls-local`（資料：資格情報を消す）、続けて `claude mcp remove wylls-local` | `claude mcp list` に無い |
| 2 | 所有者が `/link/revoke` に署名する | `/mcp` が 401。`GET /owner` で、取消が `done` か、照合待ちが終端まで進むこと |
| 3 | 所有者が capability を rotate する（owner command） | relay で古い capability が `BadCapability` |
| 4 | 所有者のウォレットで SetSession（別の鍵か零） | 代理人の行動がチェーンで `Auth` |
| 5 | MCP サーバーと stack を止め、ストアと封印の鍵を消す | ファイルが無い。鍵はシェルの履歴にも無い |

## 4. ChatGPT と Claude の hosted（Claude Code の後）

- **ChatGPT：** 10 §5.3 の手順。preflight の `scheme` を通すには、Secure MCP Tunnel か公開 HTTPS が要る。
- **Claude の hosted：** 公開 HTTPS（Anthropic の `160.79.104.0/21` から届くこと）と、`WYLLS_MCP_REDIRECT_PROFILES=claude`（外に出すなら `loopback` を外す）。Customize → Connectors で追加する。

## 5. 実機接続の直前に要る承認（今回は求めるだけで、実行しない）

### Claude Code（最初）

| 承認 | 中身 | 費用・範囲 |
|---|---|---|
| A1 | Claude Code に MCP サーバーを 1 つ登録し、OAuth の接続を 1 つ作る（相手はこの機械の試験用の認可サーバー） | 外には出ない。終了時に §3 で消す |
| A2 | 同意画面で、**試験用の**ウォレットで署名する（link の文と rotate-capability の 2 回）。ブラウザのウォレット拡張を使う | 本番の資産を持つウォレットは使わない |
| A3 | 使う Claude のアカウント（Claude Code が使えるプラン） | プランの範囲。追加の課金はしない |
| A4 | 試験のデータ：ローカルの stack（試験用 USDC、10 倍速）だけ | 本番のネットワークには送らない |
| A5 | 上限：送付 1〜2 回、期限 1 時間 | ③の接続の上限と⑤の方針 |
| A6 | 終了の時の失効の確認（§3 の 5 項目）を誰が行うか | — |

### ChatGPT と Claude の hosted（その後）

| 承認 | 中身 |
|---|---|
| B1 | 外部公開の方法（Secure MCP Tunnel か公開 HTTPS）と、出す範囲（MCP サーバーだけ。relay と herald はループバックのまま） |
| B2 | ChatGPT のワークスペース・プラン（未確認）、または Claude のプラン。そこで custom MCP（connector）を作る |
| B3 | redirect profile の変更（`claude` を足す、`loopback` を外す） |
| B4 | A2〜A6 と同じ（試験用ウォレット、試験データ、上限、終了の確認） |

## 6. 実機の前に残る阻害条件

- ②④⑤の最新の成果物が手元に無い（④ `2e536b6b`、⑤ `ba3c180b`、② `dc3bd3d`）。統合はできない。ローカルの実機の試しには影響しない。
- Claude Code が http の MCP URL を受けるか（資料に書かれていない）。
- ブラウザのウォレット拡張での署名。
- 10 §7 の条件 3〜5。
