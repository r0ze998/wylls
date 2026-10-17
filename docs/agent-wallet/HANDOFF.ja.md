# agent wallet：作業の引き継ぎ（2026-10-17 完了時点）

ブランチ `feature/agent-wallet`（worktree `.claude/worktrees/agent-wallet`、`origin/main` 2321d557 から分岐）。push もマージもしていない。設計は `docs/agent-wallet/DESIGN.md`、完了報告はセッションの最終メッセージ。

## 依頼の要約
プレイヤーがUSDCを預け、自分のagentの推論・実行費とゲーム内支出に使う（利回りではない）。手動とagent自動を切り替えられるようにする。MCPは将来の入口として、共通の権限・予算・ルール検証を通す。

## 確定した決定（所有者が 2026-10-17 に回答）
1. **保管方式**：運営が管理するテスト用カストディ口座＋ゲートウェイの台帳。ローカルのテスト用USDCだけで使う。本番の前に、同じインターフェースのままオンチェーンvaultへ移す（DESIGN.md §9）。
2. **推論の料金**：モデルを1回呼ぶごとに固定のテスト価格（既定 10_000 base units = 0.01）。呼んだら成否にかかわらず確定。autopilotは無料。トークン数は記録だけ。
3. **ゲーム内支出**：`game` 費目と価格表の接続口だけ。価格表は空。既存の行動は無料・資源払いのまま。
4. **出金**：`available` の分はいつでも。予約中の分は除く。出金先は所有者のwalletに固定。全額出金ならagentを自動停止。待機期間なし。

既定にした可逆な方針：SOLの手数料は relay が負担し、台帳には lamports を記録するだけ（USDC換算の設計案は DESIGN.md §6.3）。機能フラグ `--agent-wallet` / `--agent-runner` は既定で off。

## できているもの
- `permutation-gateway/src/frontier/agent/`：`contract.mjs`、`policy.mjs`、`ledger.mjs`、`owner-auth.mjs`、`keyring.mjs`、`custody.mjs`、`gateway.mjs`（AgentGateway：共通の入口）、`runner.mjs`（autopilot／モデル決定器／スケジューラ）。
- `routes/agent.mjs`（`/f/agent/*`）、`app.mjs` への登録、`relay.mjs` の `beforeSend`・`onSent({signature, moved})`・`AgentKeyDirect`、`config.mjs` のフラグ、`server.mjs` の配線（別ファイル `agent-wallet.json`、カストディ鍵、鍵ディレクトリ、reconcile タイマー、runner）。
- テスト `test/agent-wallet-{fixtures,gateway,money,runner,server}.*.mjs`。
- ローカル E2E `scripts/agent-wallet-e2e.mjs`（ヘッダに起動手順）。2026-10-17 に `frontier-stack` の使い捨てワールド（run `agent-e2e-2`、season 92）で 17 チェック通過。
- Web クライアントは `AgentKeyDirect` の文言だけ追加。所有者向け UI は未着手。

## 2回目のレビュー後（2026-10-17）に増えたもの
- 未確定の推論 hold（再起動・TTL）：返金も課金も推測しない `unresolved` 状態、運営の決定ルート `POST /f/agent/settle`、運営側の原価記録 `GET /f/agent/unresolved`（DESIGN.md §6.5）。
- 立替入金 `POST /f/agent/deposit {tx}`（ブラウザの経路）、`GET /f/agent/by-owner`。
- 所有者ページ `web/frontier/agent.html` + `fagent.mjs`（§10）。実ブラウザでの確認は未実施（拡張が未接続）。`scripts/agent-page-smoke.mjs` で stack 相手に通し確認済み。
- Gemma 実モデルでの E2E（§12）と、その結果見つけた「rest も課金される」問題への runner のバックオフ（§7）。
- territory-opening との機能差分の計測（§8.2）。

## 残っていること（DESIGN.md §9–§11）
- ブラウザ UI（所有者コマンドの署名、入金取引の組み立て、SetSession の受け渡し、残高表示）。
- MCP サーバー本体（`POST /f/agent/action` を呼ぶだけ。ツール定義・冪等キー・capability の保管）。
- オンチェーン vault への移行、複数プロセス非対応、SOL→USDC 換算は設計のみ。
- `codex/territory-opening` との統合：DESIGN.md §8.1。territory-opening には prize pool（テスト USDC の mint・faucet・x402）が無く、agent wallet はそれを前提にするため cherry-pick は意味上の衝突で止まる。統合先は main（fast-forward）を推奨。main×territory の衝突 189 ファイルは本ブランチとは無関係に存在する。

## 注意
- 元チェックアウトや他の worktree には触れない。main へのマージ・push・本番作業は確認してから。
- E2E の実行には `frontier-node`・`permutation-frontier`（test-beacon）・`permutation-prize` のビルドが要る（docs/RUNNING.md §2）。
