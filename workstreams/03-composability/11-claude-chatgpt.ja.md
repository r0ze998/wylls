# 11 Claude／ChatGPT から MCP で WYLLS を操作する経路

作業日 2026-10-30。保存済みの成果（tag `ws03-handoff-v2` = `47b05ac6`）から**分けて**、この後の commit に追加作業を置く。差分は §7。

書き方の区別は 10 と同じ：**実行**（この作業機で動かした）、**コード**（読んだだけ）、**資料**（公式資料を読んだ。実機では試していない）、**未確認**。

**ChatGPT と Claude の実機では、何も実行していない。** 画面も確認の表示も見ていない。以下の「対応」は、資料とローカルの試験から言えることだけである。

## 0. 目標と前提

- **目標：** 本人が Claude または ChatGPT から、次の 5 段階を自分で進められること。
  1. 村の状況を読む
  2. 不足を確かめる
  3. 隊商を準備する
  4. 許した範囲で送る
  5. 結果を確かめる
- **Gemma は前提にしない。** MCP サーバーはモデルを呼ばない。考えるのは接続したクライアントのモデル（Claude、ChatGPT）である。relay の runner が使うモデル（Gemma など）は⑤の範囲で、この経路とは関係しない。
- **MCP は自動運転も推論費用の精算もしない。**
  - 離席中にモデルを呼んで操作するのは⑤（runner と `meterInference`）。
  - MCP からの書込は、本人の会話の中で、本人が送付を求めたときだけ起きる。
  - MCP の書込にも⑤の予算・方針・mode は掛かる（§3）。

## 1. クライアントと接続方式（公式資料、2026-10-30 に読んだ）

### 1.1 対応表

| クライアント | 接続方式 | 公開 HTTPS | 認証 | リダイレクト URI | このサーバーの今の対応 | 出典 |
|---|---|---|---|---|---|---|
| **Claude Code**（CLI） | `claude mcp add --transport http <name> <url>`。401 を受けると `/mcp` か `claude mcp login` で OAuth を始める | **不要の見込み**。資料は、トークン端点が `localhost`・`127.0.0.1`・`::1` なら http でよいと明記している。MCP サーバーの URL 自体が http でよいかは書かれていない（**未確認**） | DCR、または CIMD（自動で判別）、または事前登録 | loopback：`http://localhost:<任意の番号>/callback`。番号は毎回変わる。localhost と 127.0.0.1 の両方を番号を見ずに受ける必要がある | **合う（コード）**。DCR あり。loopback は localhost・127.0.0.1・[::1] を番号を問わず受ける（`auth.mjs` の `LOOPBACK`）。401 で `resource_metadata` を返す。トークン端点は form-urlencoded を受ける | https://code.claude.com/docs/en/mcp 、 https://claude.com/docs/connectors/building/authentication |
| **Claude の web・Desktop・mobile**（custom connector） | Customize（または組織の設定）→ Connectors → 追加。Anthropic のクラウドからサーバーに届く | **必要**。「must be reachable over the public internet from Anthropic's IP ranges」（`160.79.104.0/21`） | DCR、CIMD（2 つの値を広告したときだけ）、Anthropic が保持するクライアント | `https://claude.ai/api/mcp/auth_callback`（固定） | **合わない**。このリダイレクト URI を許していない。公開用の候補として §6 に置く（今は変えない） | https://support.claude.com/en/articles/11175166 、 claude.com/docs/connectors/building（同上） |
| Claude Desktop のローカル設定（`claude_desktop_config.json`） | ローカルの MCP サーバー（stdio） | 不要 | — | — | **使えない**。このサーバーは HTTP と OAuth で、stdio の入口を持たない（`server.mjs` は stdio の呼び出しをすべて断る作り）。橋渡しの道具は第三者の物なので使わない | 同上（support 記事） |
| **ChatGPT** | ChatGPT Plugins → 「Add custom MCP server」 | **必要**（公開 HTTPS か Secure MCP Tunnel） | OAuth（DCR か CIMD）か、認証なし | `https://chatgpt.com/connector_platform_oauth_redirect` ほか | **合う（コード）**。リダイレクト URI は許している。CIMD は未実装（DCR を使う） | 10 §5.1 |

### 1.2 Claude 側の追加の要件と、このサーバー

| 要件（資料） | このサーバー | 判定 |
|---|---|---|
| sign-in を始めるには 401 が要る。200 に付けた `WWW-Authenticate` は無視される | `/mcp` はトークンが無ければ 401 と `resource_metadata` を返す | 合う（試験） |
| protected resource の `resource` は、利用者が入力した URL と完全に一致すること | `resource` は `<issuer>/mcp`。既定の issuer は `http://127.0.0.1:41960` | **注意**：`localhost` の URL で登録すると一致しない。`http://127.0.0.1:41960/mcp` をそのまま入れる |
| `authorization_servers` は先頭の 1 つだけを使う | 1 つだけ | 合う |
| PKCE S256、`code_challenge_methods_supported` | S256 だけ | 合う（試験） |
| リフレッシュトークンは回転させる。無効なときは `invalid_grant` | 回転し、再利用は接続を取り消す。誤りは `invalid_grant` | 合う（試験） |
| `offline_access` が `scopes_supported` にあれば、それを足して要求する | 載せていない。それでもリフレッシュトークンは出す | 問題は見込めないが**未確認** |
| 発見・登録・トークンの端点は 10 秒以内に応える | ローカルで即時。同意の時だけ relay を呼ぶ | 実機では**未確認** |
| 同意画面に、リダイレクト先の host をはっきり出す。loopback だけのときは注意を足す（MCP の認可仕様） | **今回足した**：戻り先の host と loopback の注意（試験 `consent shows where it sends the owner back …`） | 合う（試験） |
| ツールの結果の大きさ：hosted は約 15 万字、Claude Code は 25,000 トークン。時間：hosted は 1 回 240 秒 | 結果は数 KB。`send_caravan` は relay の応答を待つだけ | 合う見込み |

### 1.3 ローカルでできる検証と、承認が要る検証

| 検証 | 必要なもの | 承認 |
|---|---|---|
| 公式 MCP SDK のクライアントで、OAuth から 5 段階まで（模擬チェーン） | この作業機だけ | **不要（実行済み）** |
| ローカルの実チェーンで 5 段階と、取消の後の確認（E2E、14 記録点） | この作業機だけ | **不要（実行済み）**（§5） |
| Claude Code から、同じ機械の `http://127.0.0.1:<port>/mcp` に接続する | Claude Code に MCP サーバーを登録し、OAuth の接続を作る。同意画面での試験用ウォレットの署名 | **要る**：OAuth 接続の作成とウォレットの署名（§8） |
| Claude の web・Desktop・mobile | 公開 HTTPS、Claude の callback を許す変更、custom connector の追加 | **要る**：外部公開、設定の変更、接続の作成 |
| ChatGPT | 公開 HTTPS か Secure MCP Tunnel、custom MCP の作成、プランの確認 | **要る**（10 §5.3） |

## 2. ツールの一覧：実装済み・模擬・未実装

| 段階 | 操作 | 入口 | 状態 | 模擬に頼る部分 |
|---|---|---|---|---|
| 接続 | 誰のために動くか | `get_connection` | **実装済み**。実チェーンで実行した | 上限の表示は② MOCK |
| 1 | 村の状況を読む | `get_village_status` | **実装済み**。実チェーンで実行した | なし（⑤の予算は読むだけ） |
| 2 | 不足を確かめる | `check_resource_shortfall` | **実装済み**。実チェーンで実行した | なし |
| 3 | 隊商を準備する | `prepare_caravan` | **実装済み**。実チェーンで実行した | なし |
| 4 | 許した範囲で送る | `send_caravan` | **実装済み。ただしパッチ 0005 が要る**。実チェーンで実行した | 接続の上限は② MOCK。⑤の予算・方針・mode は本物 |
| 5 | 結果を確かめる | `get_operation_status`、`list_operations` | **実装済み**。実チェーンで実行した | 受領証の形は④ MOCK。到着量の欄（`arrival.quantity`）も MOCK |
| 取消の後 | 所有者が自分の操作の結果を見る | HTTP の `GET /owner`（画面）、`POST /owner/statement`、`POST /owner/operations`（**MCP のツールではない**） | **今回、ローカルで実装した**。実チェーンで実行した（§4） | 取消の 3 区分は④の報告に合わせた MOCK の形 |
| — | 接続を取り消す | ChatGPT・Claude 側で外す、`/oauth/revoke`、`/link/revoke`（所有者の署名） | 実装済み | — |
| — | 倉庫の建設、襲撃の決定、そのほかの行動 | なし | **未実装** | — |
| — | 送った隊商を取り消す | なし | **作れない**（チェーンに呼び戻しの命令が無い） | — |
| — | 押し出しの通知（MCP Events） | なし | **未実装**（今は問い合わせ） | — |
| — | CIMD、本番の認可サーバー | なし | **未実装** | — |
| — | Claude の hosted callback | `WYLLS_MCP_REDIRECT_PROFILES=claude`（既定では無効） | **実装済み（既定は無効）**。実機は未実行（[12](12-device-runbook.ja.md)） | — |
| — | 接続の前の要件の確認 | `bin/wylls-mcp-preflight.mjs` | **実装済み**。Claude Code の要件は通る（[12 §1](12-device-runbook.ja.md)） | — |
| — | 離席中の自動操作 | なし（⑤の runner） | **MCP の範囲外** | — |

## 3. ④⑤との契約と、同時に動いた時の責任分担

### 3.1 本人の MCP 操作と、離席中の自動操作が同時に起きたとき（コード）

| 資源 | 二重に使わない仕組み | 責任 | 根拠 |
|---|---|---|---|
| 隊商の通し番号 | チェーンが `x.seq == Citizen.CARAVANS` を求め、送るたびに 1 増やす。同じ番号の 2 本目は取引ごと失敗する。③は計画の時の番号を持ち、送る前に今の番号と比べる（違えば `PlanStale`） | **チェーン**（最後の守り）。③は早めに断るだけ | `caravan.rs:695`、`:799`。`server.mjs` の `PlanStale` |
| 村の資源 | 送る取引の中で、出発地から積荷を引く。足りなければ取引が失敗する | **チェーン** | `caravan.rs` の `h.pay` |
| ⑤の予算（試験用 USDC） | relay の 1 プロセスが状態ファイルの唯一の書き手（lock ファイル）。保留は同期で取る。runner も MCP も同じ `AgentGateway.submit` を通る | **⑤** | `lock.mjs`、`gateway.mjs:430` |
| 冪等キー | MCP は `ws03:<link>:<requestId>`、runner は自分の鍵。名前の空間が分かれている | ③と⑤ | `server.mjs`、`runner.mjs:439` |
| 送り手の区別 | MCP は `source: 'mcp'`、runner は `'ai'` | ⑤が記録する | `contract.mjs` の `SOURCES` |
| ② MOCK の上限 | 接続ごとの数え。runner は使わない | ③（MOCK） | `ports.mjs` |
| **mode** | **1 つの mode を全員で共有する。** manual にすると、runner も本人の MCP の送付も止まる（`AgentStopped`）。auto のあいだは、relay で runner が動いていれば、本人の操作と並んで runner も動く | **⑤の判断が要る**（§3.3） | `gateway.mjs:411`、`runner.mjs:520` |

**結論：** 通し番号・資源・予算が二重に使われることは、チェーンと⑤が防ぐ。③が守るのは接続の上限と自分の操作の記録だけで、別の台帳は持たない。
残る問題は、本人の操作と runner の両方が通ると、片方の計画がもう片方に先を越されて失敗すること（`PlanStale`、またはチェーンでの失敗）である。結果は失敗として正しく返るが、利用者にはうれしくない。

### 3.2 ④に求める契約（④の資料が無いので、③の MOCK の形と照らした案）

| 項目 | ③の今（MOCK） | ④（報告） | ④に決めてほしいこと |
|---|---|---|---|
| 状態 | requested / accepted / processing / completed / failed。`hold`（今回追加：`CapabilityUnavailable`） | 一覧は未受領 | 状態名と、保留の表し方 |
| 取消 | 接続ごとの `cancellation`：`newRequests: stopped` → `awaitingReconciliation: [操作]` → `state: reconciling / done`（今回追加） | 新規要求の停止・署名済み要求の照合待ち・取消完了 | 照合待ちの持ち主（④か⑤か）と、照会の API |
| 到着量 | `arrival: {transportEnded, settled, quantity: {state: unverified / none, sent?, basis}}`（今回追加）。量は主張しない | 実入荷量の未検証を独立の状態にする | 量を検証する方法（倉庫は決着の前後の差、村は生産と重なる） |
| 費用 | ② MOCK の上限：確保 → 消費／戻す・解く。費用は⑤ | 予約・確定・未確定・解放 | ⑤の保留との対応（③は費用を持たない） |
| 識別子 | `op_` + SHA-256(link, requestId)。gateway の冪等キー | — | 生成の規則 |

### 3.3 ⑤に求める契約

1. **mode を送り手ごとに分けるか決める。** 例：「runner だけ止める（本人の MCP は通す）」状態。今は manual が両方を止めるので、本人が会話で送る間 runner を止めるには、本人の送付も止まる。
2. **SendCaravan を代理人の行動にするか**（パッチ 0005）と、⑤の 0001 との照合（§3.4）。
3. **予算の超過・残高不足の拒否コード**（`BudgetExceeded`、`InsufficientBalance`、`DailyLimitReached`）を保つこと。③はそのまま返す。
4. **推論費用。** MCP の呼び出しには推論の料金が掛からない（考えるのはクライアント側のモデル）。MCP の操作に料金を付ける場合は、⑤の価格表（`prices.game.SendCaravan`）で扱う。③は精算しない。
5. **runner と本人の計画の競合**（§3.1）を、⑤の側で避けるか（例：本人の送付の後しばらく runner を休ませる）決める。

### 3.4 取得できなかった資料（別の仕様は作っていない）

| 担当 | 指定の commit | 結果（2026-10-30） | 必要なもの |
|---|---|---|---|
| ⑤ | `ba3c180b` | 2026-10-30 に再確認。この clone に無い。origin を取得しても無い。GitHub の commit 照会は "No commit found"、commit 検索は 0 件 | その commit（push か bundle）。特に：⑤のパッチ 0001 の本体。それが変える `permutation-gateway/src/frontier/agent/` のファイル（`contract.mjs`、`gateway.mjs`、`runner.mjs`、`ledger.mjs` のうち該当するもの）とその試験。AI staking の資料 |
| ④ | `2e536b6b`（最新の指定。前回は `bd415e7`） | 同じく無い（2026-10-30 に再確認。`git fetch origin 2e536b6b` は "couldn't find remote ref"、GitHub も無し） | RunReceipt の契約（状態、取消の 3 区分、照合の API、到着量の未検証の表し方、費用の 4 区分）の文書かコード |
| ② | `dc3bd3d`（前回の指定） | 同じく無い | session と財布の命令の一覧（10 §3.1.1 の照合用） |

④につなぐ口の提案は [patches/0006](patches/0006-receipt-port.md)（未確定）。

**パッチ 0005 と⑤の 0001 の照合は、⑤の資料が無いため行っていない。** 資料が来たら、次の点を比べる。

- `ACTION_GROUPS` に SendCaravan をどう入れるか（群の名前、既定で許すか）。
- `accountsFor` の SendCaravan の口座の並び（S1 の seed tag）。
- 出発地・宛先・経路の検査（`action.route`）。
- runner の候補に入れるか。
- 価格表の扱い。
- 試験の重なり。

## 4. 取消の後の確認経路と、復号に失敗した時の予約（今回、ローカルで実装）

### 4.1 取消の後も、所有者が結果を確かめる経路

- **認証：** 誰でも見られる形にはしない。所有者のウォレットの署名を要する。
- **署名する文：**

  ```text
  "Wylls MCP owner operations v1\n" + canonical({type: "wylls-mcp-owner-operations/1", aud: <このサーバーの /mcp>, owner, at})
  ```

  - `at` は今から 10 分以内でなければならない。
  - 同じ署名は 1 回しか使えない（使った署名のハッシュを期限まで覚える）。
  - 別のサーバー向けの署名（`aud` 違い）は通らない。
- **入口：**
  - `GET /owner`：ブラウザのウォレットで署名する画面。CSP に nonce、`no-store`、frame 禁止。
  - `POST /owner/statement`：署名する文を返す。何も保存しない。
  - `POST /owner/operations`：結果を返す。
  - 未認証の経路と同じく、アドレスごとに速度制限を掛ける。
- **返すもの：** その所有者の接続（取り消したものも含む）と、最近の操作 50 件の受領証。トークンも capability も含まない。他の所有者の操作は出さない。
- **照合のしかた：** 取り消された接続の、終わっていない操作を、次のように進める。
  - 試行の記録が 0 の操作：何も送っていないと確かめられる（試行の数は、送る前にストアに書く）。`failed`（`GrantRevoked`）にし、上限の確保を返す。
  - それ以外の操作：チェーンと herald で終わりまで追う（capability は要らない）。
  - 接続ごとの `cancellation` は、`reconciling` から `done` に進む。
- **残ること：** これは③の HTTP の画面で、Claude や ChatGPT の画面ではない。最終的な置き場（④の受領証か⑤の代理人ページ）は④⑤の判断（§3.2）。

### 4.2 復号に失敗した時（封印の鍵が違う再起動）

- **原因を示す保留：** capability を開けないとき、操作は `requested` のまま `hold: {code: "CapabilityUnavailable", since}` を付けて返す（`isError`）。新しい試行はしない。上限の確保も解かない。再送しても同じ保留になる。
- **起動時の警告：** 開けない capability の数をログに出す（数だけで、値は出さない。`auth.sealCheck()`）。
- **復旧：**
  - 運用者が正しい鍵で起動し直す → 同じ requestId で 1 回だけ送られる（試験）。
  - 鍵が戻らないとき → 所有者が接続を取り消す → §4.1 で照合する。試行の記録が 0 なら解放し、それ以外は追う。所有者は capability の rotate もする。
- **無条件には解放しない。** 解放するのは、送っていないと確かめられた時（試行 0、チェーンでの失敗・期限切れ、`NotSent`）だけである。

### 4.3 10 §7（統合を止める条件）の今

| # | 条件 | 今 |
|---|---|---|
| 1 | 取消の後、照合待ちが見えない | **ローカルでは対応した**（§4.1、実チェーンの E2E で確かめた）。最終的な置き場は④⑤の判断。統合の条件としては**残す** |
| 2 | 復号鍵の違いで、`requested` と予約が残る | **ローカルでは対応した**（§4.2、模擬の試験）。実チェーンでは試していない。**残す**（④⑤との接続の後に確かめる） |
| 3 | 倉庫の記録だけでは実入荷量を証明できない | **未解決のまま、欄で明示した**（`arrival.quantity.state: unverified`）。量の検証そのものは未実装。**残す** |
| 4 | ②④⑤の最新の成果物との接続は未検証 | **変わらない**（§3.4）。**残す** |
| 5 | session 鍵の命令の範囲を②の資料と照合していない | **変わらない**。**残す** |

## 5. 試験の結果（2026-10-30、この作業機）

| 試験 | 結果 |
|---|---|
| MCP の契約試験（パッチ無し） | 36 件：17 通過・19 省略・0 失敗 |
| MCP の契約試験（パッチ 0005 を当てた gateway） | 36 件：35 通過・1 省略・0 失敗 |
| 新しい試験（`test/owner.test.mjs`、5 件） | 所有者の照会（署名、1 回限り、期限、`aud`、他人の操作が出ない、画面に秘密が無い）、同意画面の戻り先、復号の失敗による保留と正しい鍵での再開、取消の後の照合（試行 0 の解放、送った物の追跡、reconciling → done）、到着量（delivered は unverified、lost は none）。パッチ有りで 5 通過、パッチ無しで 2 通過・3 省略 |
| gateway の試験（パッチ 0005） | 102/102 |
| **ローカルの実チェーン E2E** | **PASS、14 記録点**（season 96）。前回の 13 に、**取消の後の所有者の確認**を足した。caravan の接続を取り消した後、署名つきの照会で、2 本の隊商が `completed`・`delivered`・量 `unverified`、取消が `done` と返った。[results/mcp-local-stack.json](results/mcp-local-stack.json) は今回の記録で置き換えた（前回の season 93 の記録は `47b05ac6` に残る） |
| E2E のスクリプトの修正 | 倉庫の場所の選び方が、keep と野営地のタイルを避けていなかった。season 95 で、この準備の段階（BuildVault の `VaultSite`）が失敗した。プログラムと同じ条件で避けるようにした。MCP の動作とは関係しない |

**追加（同日、次の commit）：** 試験は 42 件になった。パッチ有りで 41 通過・1 省略・0 失敗、パッチ無しで 21 通過・21 省略・0 失敗。足した試験は次の 6 件。
- 結果不明のまま復号に失敗した操作：解放せず、チェーンの答えが出てから解放する。
- 送った後に答えが失われ、復号に失敗し、接続も取り消した操作：隊商の痕跡で決まり、解放しない。
- redirect profile。
- preflight（3 件）。

実チェーンの E2E は再実行していない。送付の経路は変えていないため。

省略した試験は合格に数えない。書込の試験はパッチ 0005 が要る。

## 6. 外部公開用の設定の候補（今は変えない）

- **ChatGPT 用：** リダイレクト URI を ChatGPT の 2 つに限る（10 §5.3）。
- **Claude の hosted 用：** `https://claude.ai/api/mcp/auth_callback` を許す。
- **共通：** loopback（Claude Code 用）を残すかは、公開の範囲しだいで決める。外に出すサーバーでは、loopback を外すか、別の issuer にするのが安全。
- **CIMD：** `client_id_metadata_document_supported` と、`token_endpoint_auth_methods_supported` に `none` を足す。Claude と ChatGPT の両方が推奨している。未実装。

## 7. 47b05ac6 からの差分

| ファイル | 変更 |
|---|---|
| `mcp/src/auth.mjs` | 所有者の署名つき照会（`ownerQuery`、1 回限り）、`sealCheck` |
| `mcp/src/server.mjs` | 復号の失敗を保留にする。`ownerOperations`（取消の後の照合）。`arrivalOf` |
| `mcp/src/ports.mjs` | 受領証に `arrival` と `hold` を足す。`cancellationOf` |
| `mcp/src/http.mjs` | `/owner` の 3 経路。同意画面に戻り先と loopback の注意。capability の言い方を直す |
| `mcp/src/store.mjs` | `seen`（使った署名のハッシュ） |
| `mcp/bin/wylls-mcp.mjs` | 起動時の封印の検査 |
| `mcp/test/owner.test.mjs` | 新しい試験 5 件 |
| `mcp/e2e/local-stack.mjs` | 取消の後の確認と到着量の記録点。倉庫の場所の選び方の修正 |
| `results/mcp-local-stack.json`、`results/mcp-tests.log` | 今回の結果 |
| `11-claude-chatgpt.ja.md`（この文書）、`10-handoff.ja.md` §7、`README.ja.md` | 文書 |

## 8. 最初に実機で通すクライアント（推奨）

**推奨：Claude Code**（CLI）を、ローカルの stack と同じ機械で使う。

**理由：**

- トンネルも公開 HTTPS も要らない見込み（loopback の OAuth。トークン端点は 127.0.0.1 でよいと資料にある）。外に何も出さずに済む。
- このサーバーの OAuth が、すでに Claude Code の要件に合う（DCR、番号を問わない loopback、401 の発見、回転するリフレッシュトークン）。設定を変えずに試せる。
- ChatGPT はプランの条件が未確認で、公開の経路も要る。Claude の hosted は公開 HTTPS とコールバックの変更が要る。

**準備済み：**

- 5 段階のツール。取消の後の確認。保留の扱い。同意画面の戻り先の表示。
- 試験（模擬と実チェーン）。
- 起動の手順（09 §2.1、`mcp/e2e/README.md`）。

**手順（承認の後に行う。今は実行しない）：**

1. ローカルの stack とパッチ 0005 の relay を立てる。MCP サーバーを `WYLLS_MCP_TEST_AS=1 … node bin/wylls-mcp.mjs` で起動する。
2. `claude mcp add --transport http wylls-local http://127.0.0.1:41960/mcp`（scope は local）。
3. `/mcp` から sign-in する。ブラウザの同意画面で、**試験用の**ウォレットで 2 回署名する。
4. 会話で 5 段階を進める。取消の後は `GET /owner` で確かめる。
5. 終わったら `claude mcp remove wylls-local`。あわせて接続の取消、capability の rotate、SetSession による session の失効、stack の停止をする。

**阻害条件：**

- Claude Code が http の MCP サーバーの URL を受けるかは**未確認**（資料に書かれていない）。
- 同意画面の署名には、ブラウザのウォレット拡張（試験用）が要る。拡張での署名は**未確認**。
- ②④⑤の資料が無いため、統合はできない（§3.4）。
- 10 §7 の条件 3〜5 は残る。

**必要な承認：**

- Claude Code に MCP サーバーを登録し、OAuth の接続を作ること（ローカルの試験用の認可サーバー）。
- 試験用ウォレットで署名すること（実資産のウォレットは使わない）。
- 使う Claude のアカウントとプラン（費用はプランの範囲。追加の課金はしない）。
- 終了時に失効を確かめる手順。

ChatGPT と Claude の hosted は、Claude Code で通った後に、10 §5.3 と §6 の承認で進める。
