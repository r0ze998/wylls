# 09 MCP：接続手順、テスト結果、撮影手順

## 1. テスト結果（2026-10-30、この作業機）

ローカルの MCP クライアントでの結果と、ChatGPT の実機での結果を分けて書く。**ChatGPT の実機では何も実行していない。**

### 1.1 ローカル（実行した）

| 種類 | 何で | 結果 | ログ |
|---|---|---|---|
| 契約の試験（模擬チェーン＋実 HTTP） | `node --test`。relay・AgentGateway・形の検査・drain guard は本物、チェーンと herald は台本 | この repo の gateway（パッチ 0005 無し）：25 件中 14 通過・11 省略（書込が要る試験）・0 失敗。パッチ 0005 を当てた gateway：24 通過・1 省略（パッチ無し専用の 1 件）・0 失敗 | [results/mcp-tests.log](results/mcp-tests.log) |
| 公式 MCP SDK クライアント | `@modelcontextprotocol/sdk` 1.32.1 の Client と Streamable HTTP、SDK 自身の OAuth | 通過（上の 25 件に含む。両方の gateway で） | 同上 |
| ローカルの実チェーン E2E | frontier-stack（frontier-localnet、Frontier プログラム、keeper、herald、パッチ 0005 を当てた relay）。MCP サーバーの HTTP と OAuth を通す | **PASS、13 確認**（season 92、2026-10-30T00:42–00:47 UTC） | [results/mcp-local-stack.json](results/mcp-local-stack.json) |
| gateway のパッチ 0005 | `agent-wallet-*` と `frontier-relay*` の試験 | 適用前 97/97、適用後 102/102 | [results/gateway-patch-0005.log](results/gateway-patch-0005.log) |

実チェーン E2E の中身（transcript より）:

| 段階 | 結果 |
|---|---|
| 所有者 | dev wallet で x402 参加、村を置く（PlaceHome）、倉庫を建てる（BuildVault）。手動のプレイ、所有者の session 鍵 |
| 代理人 | `transport` を許す方針で作成、SetSession（ウォレット署名）で委任、auto |
| 接続 | DCR → 同意（link の文とrotate-capability にウォレット署名）→ PKCE でトークン |
| 隊商 1（村 → 倉庫、食料 100、3 歩） | `requested 00:43:26 → accepted 00:43:26 → processing 00:43:29 → completed 00:46:26`、結末 `delivered`（keeper が受取）。倉庫に食料 100 |
| 不足の確認 | 倉庫が食料の供給元として出る |
| 拒否 | 他人の場所 `NotYourPlace`、読取だけの接続の送付 `InsufficientScope` |
| 隊商 2（倉庫 → 村） | `requested 00:46:26 → … → completed 00:47:23`、`delivered`。同じ requestId の再送は `replayed`（取引は増えない） |
| 上限 | 3 本目は `GrantLimitReached`（② MOCK の上限 2） |
| 秘密 | capability は transcript とログに無い |

時間は 10 倍速のローカル世界の実時間で、本番の所要時間を示さない。

### 1.2 必須の検証と、どの試験で確かめたか

| 検証 | 試験（種類） | 結果 |
|---|---|---|
| 正常系 | `the whole play …`（模擬）、実チェーン E2E | 通過 |
| 他人の村への操作 | `prepare: only the owner's places`、`another player's village …`（gateway の `WrongVillage` まで）（模擬）、E2E の `NotYourPlace`（実） | 通過 |
| 期限切れ・失効した権限 | `tokens expire; the owner's signed revocation …`、`OAuth: … refresh token used twice revokes`、`the owner's signed limits (MOCK grant) … expiry`、`the owner's controls … SetSession / capability rotated`（模擬） | 通過 |
| 予算超過 | `⑤'s budget decides … BudgetExceeded`（模擬）、② MOCK の `GrantLimitReached`（模擬と実） | 通過 |
| 重複送信 | `duplicates …`（並行 3 本で 1 取引）（模擬）、E2E の再送（実） | 通過 |
| 切断後の結果確認 | `a lost connection to the relay …`、`the relay answered but the MCP reply was lost … a restarted server …`（模擬） | 通過 |
| 悪意あるゲーム内文章 | `words in the game are data …`（模擬） | 通過 |
| 閲覧権限のない情報 | `reads never show another player's march`（模擬） | 通過 |
| 秘密を出さない | `secrets: …`（模擬）、E2E（実） | 通過 |

### 1.3 ChatGPT の実機（実行していない）

| 確かめたいこと | 状態 |
|---|---|
| custom MCP server として登録できる | 未実行（公開 HTTPS が要る） |
| OAuth（DCR、同意画面、ウォレット署名、トークン） | 未実行 |
| `send_caravan` に確認が出る | 未実行 |
| 日本語の依頼から、正しい順にツールを呼ぶ | 未実行 |
| 切断・新しい会話から `list_operations` で続きを確認する | 未実行 |

## 2. 接続手順

### 2.1 ローカル（実行した手順）

[mcp/e2e/README.md](mcp/e2e/README.md) に、パッチ 0005 を当てた一時 worktree で stack を立て、E2E を流す手順がある。MCP サーバーだけを起動する場合:

```sh
cd workstreams/03-composability/mcp && npm ci
WYLLS_MCP_TEST_AS=1 WYLLS_MCP_RELAY=http://127.0.0.1:41740/gw WYLLS_MCP_HERALD=http://127.0.0.1:41740 \
  WYLLS_MCP_PORT=41960 node bin/wylls-mcp.mjs
# → http://127.0.0.1:41960/mcp（OAuth: /.well-known/oauth-protected-resource）
```

ローカルの MCP クライアント（公式 SDK、MCP Inspector など）は、この URL に Streamable HTTP で接続し、OAuth を自動で行う。同意画面では、ブラウザのウォレットが所有者のアドレスで署名する。

### 2.2 ChatGPT（未実行。必要な操作とリスク）

1. **公開 HTTPS にする**（Secure MCP Tunnel か開発用トンネル）。`WYLLS_MCP_ISSUER` をその URL にする（`resource` は `<issuer>/mcp`）。リスク：試験用の認可サーバーと、relay と herald への読み出しの経路が外から届く。署名が無ければ接続はできないが、同意画面と DCR は誰でも呼べる。
2. **ChatGPT の web で「Add custom MCP server」**（ワークスペースの権限・プランが要る。未確認）。認証は OAuth、URL は `<issuer>/mcp`。ChatGPT は DCR で登録し、リダイレクト URI は `https://chatgpt.com/connector_platform_oauth_redirect`（許可済み）。
3. **同意**：所有者が同意画面でウォレットのアドレスと代理人 ID を入れ、上限を選び、ウォレットで 2 回署名する（link の文、rotate-capability）。
4. **会話**：`@Wylls` で「村の様子を見て」「倉庫を建てるのに何が足りない？」「倉庫から石を 150 運んで」「隊商は着いた？」。
5. **終了**：ChatGPT から接続を外す、または所有者が `/link/revoke` に署名する。代理人の鍵を戻すのは代理人ページの SetSession。

これらは、公開サーバーの新規公開、外部サービスへの登録（DCR によるクライアント登録）、認証情報の作成にあたるため、この作業では行っていない。実施するなら、上の各段階を誰が行うか、どのネットワークに出すかを先に決める必要がある。

## 3. 撮影手順（動画用）

**原則：** ローカルで動いたものだけを見せる。ChatGPT の画面は、実機で確かめた後でなければ撮らない。ChatGPT の画面を作り込んだり、ローカルのクライアントを ChatGPT に見せかけたりしない。

### 3.1 今撮れるもの（ローカル、約 2 分）

| 場面 | 何を映すか | 字幕（例） |
|---|---|---|
| 1. 接続 | 公式 SDK の小さなクライアント（`test/sdk-client.test.mjs` と同じ手順）が `http://127.0.0.1:41960/mcp` に接続し、401 → OAuth の発見 → 同意 → トークン | 「ローカルのテスト環境。ChatGPT ではありません」 |
| 2. 同意 | 同意画面（スコープと上限）と、所有者の鍵による 2 回の署名（台本の署名。ブラウザのウォレット拡張での署名は未確認なので、そう見せない） | 「接続できるのは、所有者が署名した村だけ」 |
| 3. 村の確認 | `get_village_status`（食料・石材・倉庫・代理人の状態と予算） | 「村の資源と倉庫」 |
| 4. 準備 | `prepare_caravan`（村 → 倉庫、食料 100）の要約（呼び戻せない・襲撃されうる） | 「まだ何も送っていません」 |
| 5. 送る | `send_caravan` → `accepted` | 「送信を受け付けた。まだ着いていない」 |
| 6. 道中 | `get_operation_status` → `processing` と到着予定、ゲーム画面の地図の隊商 | 「道の上」 |
| 7. 到着 | `completed`／`delivered`、倉庫に食料 100 | 「keeper が受け取りを確定した（10 倍速のローカル世界）」 |
| 8. 不足 | `check_resource_shortfall` で村の不足と、それを満たせる自分の倉庫 | 「足りない資源と、それを持つ自分の倉庫」 |
| 9. 戻す・拒否 | 倉庫 → 村の隊商が届く。他人の倉庫を指定すると `NotYourPlace`、上限を超えると `GrantLimitReached` | 「他人の場所は指定できない。上限はサーバーが守る」 |

撮り方: §2.1 で stack と MCP サーバーを立て、`e2e/local-stack.mjs` と同じ順に、クライアントからツールを 1 つずつ呼ぶ（実際に通した順はこの表と同じ）。stack は 10 倍速なので、到着は数分で来る。画面に**「ローカル・テスト資産」「10 倍速」**を常に出す。

### 3.2 ChatGPT の実機が確かめられた後に撮るもの

同じ 9 場面を ChatGPT の会話で。撮る前に §1.3 の各項目を確かめ、確かめられなかった場面は撮らない（例えば確認の表示が出なかったら、出たように編集しない）。
