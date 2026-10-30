# 07 ChatGPT から WYLLS へ：MCP 接続の入口

作業日 2026-10-30。③の追加要件（MCP 優先）。この文書は「事実（実行して確かめた）」「コードを読んだ結果（未実行）」「提案」を分けて書く。**ChatGPT の実機では何も確かめていない**（§5）。ローカルの MCP クライアントで確かめたことと、ChatGPT で確かめたことは別に書く。

## 1. ChatGPT 側の現状（公式資料、2026-10-30 に読んだもの）

古い ChatGPT plugin（2023 年の仕様）は前提にしない。今の OpenAI の資料では、MCP サーバーを使う統合を「plugins」（Apps SDK の後継の名前。旧仕様とは別物）と呼び、ChatGPT と Codex で共通である。

| 項目 | 内容 | 出典 | 確認 |
|---|---|---|---|
| 接続の方法 | ChatGPT の web で「Add custom MCP server」から URL を登録し、認証方式を選び、危険の警告に同意して plugin として作る | developers.openai.com/plugins/quickstart、/api/docs/guides/custom-mcp-server | 資料を読んだ |
| 使える環境 | 「Use ChatGPT on the web」。ワークスペースの権限と Lockdown が適用される | custom-mcp-server | 資料を読んだ |
| 使えるプラン | Business・Enterprise/Edu で custom MCP が使える、Business では管理者だけが作れる、という記述が検索結果の抜粋にある。help.openai.com は取得できなかった（403） | help.openai.com 12584461（抜粋のみ） | **未確認** |
| 通信方式 | 公開 HTTPS の Streamable HTTP（通常 `/mcp`）。SSE も受け付けるが MCP 仕様では非推奨 | /plugins/deploy/connect-chatgpt、modelcontextprotocol.io | 資料を読んだ |
| localhost | 直接は届かない。Secure MCP Tunnel か開発用トンネルが必要 | /plugins/build/mcp-server | 資料を読んだ |
| 認証 | OAuth（ユーザーの OAuth 2.1）か認証なし。API キーやクライアント資格情報のグラントは使えない | /plugins/build/auth | 資料を読んだ |
| OAuth の要件 | RFC 9728 の protected resource metadata、RFC 8414 の server metadata、PKCE S256 必須、`resource` を authorize と token の両方で送る（`aud` に入れる）、CIMD が推奨・DCR も可、リダイレクト URI は `https://chatgpt.com/connector_platform_oauth_redirect` など | /plugins/build/auth | 資料を読んだ |
| 書込の確認 | 「Write actions by default require confirmation」。`readOnlyHint` が無いツールは書込として確認が出る。会話ごとに「覚える」ことができる | custom-mcp-server | 資料を読んだ |
| ツールの決まり（公開ディレクトリ向け） | `readOnlyHint`・`destructiveHint`・`openWorldHint` を明示、名前は平易な動詞、1 操作 1 ツール、汎用の実行ツールは不可、説明は挙動と一致 | /plugins/plugin-guidelines | 資料を読んだ |
| 方針（公開ディレクトリ向け） | デジタル商品・トークン・クレジットの販売は不可。**送金・暗号資産の送付・投資取引の実行は禁止**。13–17 歳にも適すること | /plugins/plugin-guidelines | 資料を読んだ。私的な custom MCP にどこまで適用されるかは書かれていない |
| 非同期の結果 | MCP Events（webhook による通知）がある。Work チャットの web などに限る | /plugins/build/mcp-events | 資料を読んだ。**未実装** |

**djcows について。** GitHub の利用者 `djcows` は存在するが、公開リポジトリ（`tpot`、`mrna`、`milk`）に MCP の実装は見つからず、関連する動画も見つからなかった。参考にできる実装が特定できないので、この設計には取り入れていない。Billy に正確な URL を確認したい（§8）。

**方針への影響（提案）。** このサーバーは送金・入出金・購入のツールを持たない（`withdraw`、`deposit`、`pay` などの名前は試験で禁止）。隊商はゲーム内の資源の移動で、手数料は relay が払う。ただし WYLLS には実資金の季節（USDC）の計画があるため、公開ディレクトリへの申請前に、方針との関係を法務・運営が判断する必要がある。

## 2. 既存の実装の区分

| 経路 | 場所 | ローカルで呼べる | 別の機械から接続 | ChatGPT 実機 | S1 | 最終結果の追跡 |
|---|---|---|---|---|---|---|
| 代理人の MCP（stdio） | `permutation-gateway/mcp/agent-mcp.mjs` | **可**（試験は模擬チェーン。実チェーンの E2E は同じ HTTP 経路を MCP を介さず叩いた） | **不可**（stdio のサブプロセス。認証は環境変数の capability） | **不可**（ChatGPT は公開 HTTPS と OAuth を要する） | 一部（Harvest など。隊商なし） | 送信の受理（`sent` と署名）まで。到着は追わない |
| 旧 `permutation-mcp` | `permutation-gateway/client/bin/permutation-mcp.mjs` | 旧ゲームサーバー（V5）向け | 不可 | 不可 | **対象外**（旧版） | — |
| relay の HTTP | `/f/agent`、`/f/agent/action`、`/f/relay`、`/f/tx/{sig}` | 可 | relay を公開すれば可（今はローカル） | MCP ではない | 可 | `/f/tx` は着地・失敗だけ。隊商の到着はない |
| herald の HTTP（読取） | `/h/season`、`/h/me/{wallet}`、`/h/caravans.json`、`/h/events` | 可 | 公開すれば可 | MCP ではない | 可 | `/h/events` の CARAVAN_SETTLED・RAIDED で到着が分かる |
| SDK（JS・Rust） | `client/src/frontier/`、`fclient` | 道具であり接続ではない | — | — | 可 | — |
| 代理人の runner（運営の AI） | `src/frontier/agent/runner.mjs` | relay の中だけ | 不可 | 不可 | 可 | — |
| **③の MCP サーバー（今回）** | `workstreams/03-composability/mcp/` | **可**（模擬チェーンの試験 25 件、公式 SDK クライアント、ローカルの実チェーン E2E。§4） | **実装済み・未公開**（Streamable HTTP + OAuth。トンネル・公開はしていない） | **未確認** | 可 | **可**（④の仮契約：要求・受理・処理中・完了・失敗。到着を events で判定） |

「設定やモックだけで実機対応済みとはしない」に従い、ChatGPT の欄は今回のサーバーも含めすべて未確認とする。

## 3. 設計

```text
ChatGPT ──HTTPS(Streamable HTTP /mcp, Bearer)──▶ ③ wylls-mcp ──GET /f/agent, POST /f/agent/action──▶ relay（⑤ 代理人の財布）──▶ チェーン
                                                   │ OAuth（ローカルの試験用認可サーバー）                └ AgentGateway：方針・予算・mode・委任・形の検査
                                                   ├ ② Grant：MOCK（所有者が署名した上限）
                                                   ├ ④ RunReceipt：MOCK（操作の状態）
                                                   └ GET /h/*（herald：自分の村・倉庫・隊商・events）
```

- **書込の経路は一つだけ：** 既存の `AgentGateway.submit`（`POST /f/agent/action`）。③は残高・価格・課金規則を持たない。予算・日次上限・停止・方針の版・オンチェーンの委任は⑤（代理人の財布）が判定する。
- **SendCaravan は今の代理人の行動に無い。** 追加するのが [patches/0005](patches/0005-agent-wallet-sendcaravan.patch)（⑤のファイル。未適用）。これが無い relay では `send_caravan` は `ActionNotAllowed` になり、その理由と必要な対応を返す（試験で確認）。
- **誰の村か（サーバーで検証）：** 接続（link）は、所有者のウォレットが署名した文（このサーバーの `aud`、OAuth クライアント、スコープ、代理人、上限、期限）で作られる。代理人が所有者のものであることを relay の記録で確かめる。以後、ツールは link の所有者の村・倉庫しか読めず、場所は自分の一覧にある `placeId` でしか指定できない（他人の場所は `NotYourPlace`）。gateway もさらに `WrongVillage` で拒否する（二重の防御を試験で確認）。
- **読取と書込の分離：** スコープ `wylls.read`（読むだけ。代理人の鍵を受け取らない）と `wylls.caravan`（隊商）。書込のスコープを許すときだけ、所有者がウォレットで `rotate-capability` の所有者コマンドに署名し、サーバーが relay から代理人の capability を直接受け取って封印する。利用者もモデルもその値を見ない。
- **確認画面と認可の区別：** ChatGPT の確認（`destructiveHint: true` で表示される）は認可ではない。認可は、(1) 所有者の署名つきの link とそのスコープ、(2) link に署名された上限（② MOCK）、(3) ⑤の方針・予算と、所有者が SetSession で与えたオンチェーンの委任、(4) プログラムの規則、の 4 層である。チャットの「はい」を受け取る引数は無い。
- **重複・再送・並行：** `requestId` から操作 ID を決め（link と requestId の SHA-256）、gateway の冪等キーにも使う。同じ requestId は同じ操作を返し、二度送らない（並行 3 本、再起動後、relay 不達の後の再送で確認）。計画（plan）は一度しか使えない。
- **非同期の追跡：** 送信の受理（accepted）と着地（processing）と到着（completed：delivered／lost／taken／burned）を分ける。状態はストアに書いてから relay に送る（再起動で失われない）。`get_operation_status` と `list_operations` で切断後も確認できる。
- **閲覧権限の無い情報：** herald の Province 封筒は到着する行軍の ArrivalSlot を含むが、サーバーは地形と拠点の欄しか使わない（試験で、どの回答にも出ないことを確認）。`/h/me` は所有者自身のウォレットでしか呼ばない。行軍のツールは無い。
- **ゲーム内の文章：** 代理人の履歴の理由などの自由文は `untrusted: true` と注記をつけて返す。サーバーはそれを操作の根拠にしない（書込の引数は計画 ID と requestId だけ）。

## 4. ローカルで確かめたこと（事実）

詳細は [09](09-mcp-run-and-video.ja.md)。

| 種類 | 内容 | 結果 |
|---|---|---|
| 模擬チェーン＋実 HTTP（`node --test`） | relay・AgentGateway・relay の形の検査は本物、チェーンと herald は台本。プロトコル・OAuth 7 件、遊びの経路と攻撃 17 件、公式 SDK クライアント 1 件 | パッチ 0005 を当てた gateway で 24 通過・1 省略（パッチ無し専用の 1 件）。この repo の gateway（パッチ無し）では 14 通過・11 省略（書込が要る試験）。§9 |
| 公式 MCP SDK クライアント（`@modelcontextprotocol/sdk` 1.32.1） | SDK 自身の OAuth（401 → 発見 → DCR → PKCE S256 + resource → トークン）で接続し、ツール一覧と遊びの経路 | 通過（両方の gateway で） |
| ローカルの実チェーン（frontier-stack） | 本物のプログラム・keeper・herald・relay（パッチ 0005 を当てた一時コピー） | [09](09-mcp-run-and-video.ja.md) §2 |

## 5. ChatGPT の実機で必要なこと（未実施）

実機の確認には、次の操作が要る。どれもこの作業の制約（公開サーバーの新規公開、認証情報の新規作成、公開 push をしない）に触れるため、**行っていない**。

| 必要な操作 | 理由 | リスク |
|---|---|---|
| サーバーを公開 HTTPS に出す（Secure MCP Tunnel か開発用トンネル） | ChatGPT は localhost に届かない | ローカルの試験用認可サーバーと relay が外から見える。トンネルの URL が漏れると誰でも同意画面まで来られる（署名が無ければ接続はできない） |
| ChatGPT 側で custom MCP server を登録 | 実機の手順そのもの | ワークスペースの権限・プランが要る（未確認）。登録すると ChatGPT が OAuth クライアントとして登録される（DCR） |
| 所有者のブラウザウォレットでの署名 | 同意画面は `window.solana.signMessage` を使う | ローカルではヘッドレスのため、ブラウザウォレット拡張での署名は試していない（試験は同じバイトをプログラムで署名） |
| 本番の認可サーバー | 今のものは試験用（アカウントなし、ウォレット署名だけ） | 本番運用の前に、既存の ID 基盤か監査済みの実装に置き換える必要 |

## 6. 既存実装との差分

| 項目 | 既存（`agent-mcp.mjs`） | 今回（③ `mcp/`） |
|---|---|---|
| 通信 | stdio | Streamable HTTP（POST /mcp、JSON 応答）。stdio は無し |
| 認証 | 環境変数の capability（その MCP クライアントの機械に置く） | OAuth 2.1。capability はサーバーが封印して保持し、利用者にもモデルにも見せない |
| 対象の決め方 | 起動時の agentId | 所有者の署名つき link。他人の代理人は relay の記録で拒否 |
| 書込 | `agent_act`（汎用、行動名と欄を渡す） | `send_caravan` だけ（計画 ID と requestId）。汎用の実行ツールは無し（ChatGPT の方針） |
| 確認 | 無し | `prepare_caravan` で要約と注意を返し、`send_caravan` は `destructiveHint`（ChatGPT が確認を出す）。認可は確認とは別 |
| 結果 | `sent`／`refused`／`failed` | 要求・受理・処理中・完了（到着の結末）・失敗、識別子で再確認 |
| 上限 | ⑤の予算・方針 | ⑤の予算・方針に加え、link に署名された上限（② MOCK） |
| gateway の変更 | — | SendCaravan を代理人の行動にするパッチ 0005（未適用） |

既存の `agent-mcp.mjs` と⑤の財布はそのまま残す。今回のサーバーは別のプロセスで、gateway の同じ入口を使う。

## 7. 他担当への依頼

[08](08-mcp-contracts.ja.md) §3–§5 に契約案を置いた。

- **②（権利）：** link の上限（行動・回数・1 回あたりの資源・期限）は MOCK `wylls.mock-grant/0`。② の Grant が決まったら、`GrantPort.check/reserve/consume/release` を置き換える。範囲を絞った委任をコアで保証する要求は [patches/0004](patches/0004-core-scoped-delegation.md)。
- **④（実行と結果）：** 操作の状態は MOCK `wylls.mock-run-receipt/0`。④の RunReceipt の契約（状態、識別子、結末、回復の選択肢、通知）を受け取ったら置き換える。必要な項目は 08 §4。
- **⑤（予算・支払い・手動／自動）：** SendCaravan を代理人の行動に加えるか（パッチ 0005）、隊商にゲーム内価格を付けるか、AI staking の前払い残高をどう見せるかは⑤の判断。③は残高台帳を作らない。必要なインターフェースは 08 §5。
- **relay の運用：** MCP サーバーを公開する場合、relay を外に出すか（今は herald の `/gw` 経由でローカル）を決める必要がある。

## 8. 未検証・未実装

- ChatGPT の実機（接続、OAuth、確認の表示、ツールの呼び分け、日本語の会話）。すべて未確認。
- プランと地域の条件（help.openai.com が取得できなかった）。
- CIMD（ChatGPT の推奨する登録方式）。DCR だけ実装。
- MCP Events（非同期の通知）。今は `get_operation_status` を呼び直す（pull）。
- 本番の認可サーバー、トンネル、TLS。
- ブラウザウォレット拡張での同意画面の署名。
- djcows の MCP・動画（特定できなかった）。
- 隊商の ETA は地形と道だけの見積もり（ドクトリンの係数を含まない）。送った後は、チェーンが決めた到着時刻を返す。
