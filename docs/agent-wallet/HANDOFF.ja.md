# agent wallet：作業の引き継ぎ（2026-10-17 中断時点）

ブランチ `feature/agent-wallet`（worktree `.claude/worktrees/agent-wallet`、`origin/main` 2321d557 から分岐）。push もマージもしていない。

## 依頼の要約
プレイヤーがUSDCを預け、自分のagentの推論・実行費とゲーム内支出に使う（利回りではない）。手動とagent自動を切り替えられるようにする。MCPは将来の入口として、共通の権限・予算・ルール検証を通す。詳細な要件は元の依頼文を参照。

## 確定した決定（所有者が 2026-10-17 に回答）
1. **保管方式**：運営が管理するテスト用カストディ口座＋ゲートウェイの台帳。ローカルのテスト用USDCだけで使う。本番の前に、同じインターフェースのままオンチェーンvaultへ移す。
2. **推論の料金**：モデルを1回呼ぶごとに固定のテスト価格を取る（既定は 10_000 base units = 0.01）。呼んだら成否にかかわらず確定する。autopilotは無料。トークン数は記録だけする。
3. **ゲーム内支出**：`game` 費目と価格表の接続口だけを作る。価格表は空にしておく。既存の行動は無料・資源払いのまま変えない。設計規則「お金はゲームに入れない」（docs/frontier/DESIGN.md:521）も変えない。
4. **出金**：`available` の分はいつでも出金でき、予約中の分は除く。出金先は所有者のwalletに固定する。全額出金ならagentを自動で停止する。待機期間は設けない。

既定にした可逆な方針：SOLの手数料は今までどおりrelayが負担し、台帳にはlamportsを記録するだけにする（USDCへの換算はしない）。機能フラグは既定でoff。

## 調査結果（根拠）
- 書き込みはすべて relay `sponsor()` を通る（permutation-gateway/src/frontier/routes/relay.mjs:92）。順番は、形の許可リスト → 署名 → 再送防止 → クォータ → 共同署名 → シミュレーション → 送信。
- チェーン側の代理署名にはセッション鍵を使える（frontier-abi/src/prologue.rs:1070）。`SetSession` はwalletしか署名できない（permutation-frontier/src/proc/citizen.rs:465）。プログラムの変更は不要。
- 行軍には取消命令がない（permutation-frontier/src/lib.rs のdispatch）。
- 既存のMCP（client/src/mcp.mjs）は旧v9ゲーム向けで、Frontierには対応していない。
- 既存のAI市民はRustのbrainがseedから導いた鍵で動いている。今回は触らない。
- 基準テスト：`cd permutation-gateway && npm ci --ignore-scripts && npm test` → **2371/2371 pass**（変更前）。

## できているもの（`permutation-gateway/src/frontier/agent/`、importだけ確認済み、テストは未作成）
- `contract.mjs`：ActionRequest と ActionResult、エラーコード、行動グループ、委任できない行動（Join, SetSession, PlaceHome, FileTicket, FileOutpost, DeclareSiege, RetireHost）。
- `ledger.mjs`：available / reserved / spent{inference,network,game} / pendingWithdraw / withdrawn の5区分。hold → sending → settle/release の流れ、冪等キー、預入署名の重複防止、不変条件の `check()`、`liabilities()`。
- `owner-auth.mjs`：所有者walletによる署名付きコマンド（canonical JSON、期限は最大10分、nonceは1回限り）。
- `keyring.mjs`：agent鍵（0600のファイル、秘密を外に出さない）、`isAgentKey`。
- `policy.mjs`：allowed（行動名またはグループ名）、budget {total, perDay}。
- `custody.mjs`：預入の検証（オーナーの署名、カストディ口座の増分＝オーナー口座の減少分）、TransferChecked による出金（送信前に署名を記録）、`status()`。

## 残りの作業（この順）
1. **`gateway.mjs` AgentGateway**
   - `createAgent`、`submit(ActionRequest, credential)`、`meterInference`、`setMode`、`withdraw`、`reconcile`、起動時の回復（held は解放し、sending は状態を見て精算）。
   - submit の順：認証（所有者署名、またはcapabilityトークンのハッシュ照合）→ 冪等（同じキーで内容が違えば IdempotencyConflict、処理中なら同じPromiseを返す）→ mode=auto → policyVersion と modeEpoch の一致 → 許可された行動か → 村が一致するか → game価格でhold → チェーン上の session==agentKey かつ期限内 → サーバー側の `accountsFor` と `shapeMessage` で組み立て、agent鍵で署名 → `sponsor()`。
2. **relay.mjs の小さな変更**
   - `sponsor()` に `beforeSend` フックを追加する。送信直前にepochを同期で再確認して markSending する。止まっていれば refund と release をする。
   - `onSent?.({signature, moved})` を渡す。
   - `POST /f/relay` でagent鍵が直接署名したtxを拒否する（AgentKeyDirect）。
   - prize.mjs の `sendOwn` は必要なら export する。
3. **`routes/agent.mjs`**
   - ルート：`POST /f/agent/command`（op = create / policy / mode / withdraw / action / rotate-capability）、`POST /f/agent/deposit`、`POST /f/agent/action`（capability）、`GET /f/agent?id=`、`GET /f/agent/session-terms`、`POST /f/agent/reconcile`（operatorのみ）。
   - app.mjs の PUBLIC と IP_LIMITS に登録する。機能フラグ `--agent-wallet`（config.mjs）を追加し、custodyの鍵ファイルと推論価格を設定できるようにする。server.mjs で状態を別ファイル `agent-wallet.json` に保存するよう配線する。
4. **`runner.mjs`**：決定器（ルール、または llm.mjs のモデル）を meterInference で包み、source 'ai' として submit する。
5. **テスト** `test/agent-wallet-*.test.mjs`（frontier-relay.test.mjs の fakeChain を流用する）
   - 権限違反、上限到達、日次上限、残高不足、20件の同時支出、重複要求、古いpolicyやepoch。
   - 送信前の停止・切替（beforeSend）、出金と処理中の予約の競合。
   - relay・送信の失敗とタイムアウト、出金が不確定になった後のreconcile、再起動からの回復。
   - 秘密が応答・状態ファイル・ログに出ないこと。各ステップの後に `ledger.check()` が空であること。
6. **ローカルE2Eスクリプト**（scripts/agent-wallet-e2e.mjs）：agent作成 → faucet → 入金 → 予算と範囲の設定 → SetSession → 自動行動と課金 → 手動へ切替 → 出金。frontier-stack のビルドが必要（docs/RUNNING.md）。
7. **設計文書** `docs/agent-wallet/DESIGN.md`：本ファイルの内容に加え、SOL→USDC換算の設計案、オンチェーンvaultへの移行、複数プロセス非対応、MCP接続時の残作業を書く。
8. 全テストを再実行し、完了報告（実装、変更ファイル、テスト結果、既存機能への影響、未解決事項、MCPに残る作業）を書く。

## 注意
- 元チェックアウトや他のworktree（`codex/territory-opening` など）には触れない。mainへのマージ・push・本番作業は確認してから行う。
- 未確認：`codex/territory-opening` と gateway の変更が重なるかどうか。
