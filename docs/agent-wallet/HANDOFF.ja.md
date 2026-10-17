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

## 3回目（2026-10-17）に増えたもの
- イベント駆動の呼出制御（DESIGN.md §7.1）：observer が herald の公開記録を意味のある項目だけで digest 化し、owner/event/turn/result のトリガーがある時だけ呼ぶ。最小間隔・同時呼出防止・回数上限（運営 `--agent-max-calls-per-day`、所有者 `policy.budget.callsPerDay`）・rest 後のターン単位バックオフ。既定値は提案値（本番仕様ではない）。
- 計測（§12.1）：同条件で 7 分あたり 50 回 → 5 回。
- 未確定請求（§6.5）：期限解放ルールを `--agent-unresolved-release-ms` の裏に実装、既定 off。推奨 1 時間。settle は by/evidence/日時を記録し `GET /f/agent/unresolved` に settlements を出す。
- 統合前確認：`docs/agent-wallet/INTEGRATION-REVIEW.md`（7 ファイルの機能単位の判定、未コミット 143 件の棚卸しと取り込み候補）。
- 実ブラウザ：Chrome 拡張が未接続のため未実施（§13）。

## 4回目（2026-10-17）に増えたもの
- 所有者の決定を記録（DESIGN.md §13）：統合先は main、実ブラウザ検証前はマージしない、territory-opening は消さず art/VFX は別トラック；1 時間解放は localnet で先に検証（本番規則ではない）；イベント駆動は継続、owner 変更にも連打対策、上限は常に適用。
- 追加確認 2 点（`test/agent-wallet-caps.test.mjs`）：(1) settle の操作者は認証情報から記録する（`by = {via:'operator-token', token:<指紋8桁>, ip}`、本文の by は `claimedBy`）。トークンは 1 本なので「どのトークン・どのアドレスか」までで、人の特定には名前付きトークンが要る。(2) 予約解放（停止・TTL・期限・運営返金）で `day.calls` は戻らない。上限はすり抜けない。
- 見つけて直したもの：view の日付が hold まで繰り越されず、UTC 日付が変わるとスケジューラの上限が前日の回数を読んで二度と呼ばなくなる（修正＋テスト）；observer が herald の province 形（`{bytes, slots}`）を読んでおらず、run6・7 では州の変化（到着・camp）が一度も event にならなかった（修正＋fixture を実形に）。
- owner 連打対策：`--agent-owner-call-gap-ms`（提案値 10 秒）。owner 変更は最小間隔を飛ばせるが、この間隔に 1 回。変更は落とさない。上限はトリガーより先に判定。
- 1 時間解放の localnet 検証（§6.5、run8、`AGENT_E2E_SCENARIO=unresolved`）：呼出中に relay を kill -9 → 2.6 秒で再起動 → unresolved → 停止・全額出金で 10,000 だけ予約が残る → 3,601 秒後に解放 → 回数は 1 のまま → `callsPerDay:1` で auto にしてもモデルは呼ばれず autopilot の無料 Harvest → 残りを出金し `deposited = withdrawn`。
- モデルに村の状態を渡す（§7.2）：倉庫・生産・建設列・城壁・予備兵・守備・州の敵勢と camp・派生の threat 行、行動の説明と価格表。コードが `Train n<1` と倉庫で払えない答えを拒否。
- 場面別の判断比較（§12.2、`scripts/agent-decision-bench.mjs`、bench-1〜4）：8 場面で 6/8 → 7/8 → 7/8 → 7/7（1 件はコードが拒否）。実世界 run9（run7 と同条件）：呼出 11 回・0.11・行動 8 件送信（Build 2、Train 4、autopilot Harvest 2）、QueueFull 1。費用は時間ではなく活動に比例（約 0.014/行動）。
- `docs/agent-wallet/VERIFY.md`：独立に検証する手順。
- 実ブラウザ：拡張未接続（3 回目）で未実施。

## 5回目（2026-10-17）に増えたもの
- 実ブラウザ検証（§10）：Playwright は未導入だが Google Chrome 155 があり、`scripts/agent-page-browser.mjs` が DevTools プロトコル（`ws`）で headless Chrome を駆動する。偽 DOM ではなく herald が配る実ページ（CSP 有効）を、実クリック・実入力・ページ自身の dev wallet 署名で 18 手順（接続→作成→入金→予算と許可行動→委任→自動→行動→署名拒否 2 種→通信断と復帰→再読み込み→呼出中の停止と出金→遅延結果の課金→委任解除→全額出金）。スクリーンショットと本文は `.local/agent-wallet-e2e/browser-{1,2,3}/`。未検証：実ウォレット拡張（Phantom 等）の署名承認。
- 回帰テスト（`test/agent-wallet-regression.test.mjs`）：UTC 日付変更の前後・再起動・前日から続く推論で日次上限が正しく更新されすり抜けないこと；herald の実レスポンス形（fixtures に実採取）で州への到着・camp の出現と兵数変化が event になり、静かなターンは event にならず、変化なしでは呼出が増えないこと。DESIGN §12.1 に run6・7 の制約（州イベント未検知）を追記。
- 評価の整理（§12.2）：判断（拒否も分母に含む）と安全（コードの拒否）を分離。bench-5 は 10 場面×3 回、カタログ逆順・倉庫逆順でも同一回答（順序バイアスではない）。Food 優先は Food が上限 1990/2000 でも Food を選ぶ「モデルの先入観」で、観測・候補順・文言の偏りではない（§12.2）。実世界は run10a–c（同条件 3 回）で呼出・費用・モデル行動・無料 autopilot 行動・拒否・rest を分けて記録。「費用は活動に比例」「約 0.014/行動」は観測値であって一般則ではない。
- 範囲維持：1 時間解放は localnet 用・既定 off、名前付きトークンなし（単一トークンでは個人を特定できない制約は残す）、監査記録・状態ファイル・ログにトークン本体が出ないテスト、城壁・tier-up は保留、territory と art/VFX は無変更。
- §13 に提案設定の一覧（根拠つき、本番確定ではない）。

## 残っていること（DESIGN.md §9–§11）
- ブラウザ UI（所有者コマンドの署名、入金取引の組み立て、SetSession の受け渡し、残高表示）。
- MCP サーバー本体（`POST /f/agent/action` を呼ぶだけ。ツール定義・冪等キー・capability の保管）。
- オンチェーン vault への移行、複数プロセス非対応、SOL→USDC 換算は設計のみ。
- `codex/territory-opening` との統合：DESIGN.md §8.1。territory-opening には prize pool（テスト USDC の mint・faucet・x402）が無く、agent wallet はそれを前提にするため cherry-pick は意味上の衝突で止まる。統合先は main（fast-forward）を推奨。main×territory の衝突 189 ファイルは本ブランチとは無関係に存在する。

## 注意
- 元チェックアウトや他の worktree には触れない。main へのマージ・push・本番作業は確認してから。
- E2E の実行には `frontier-node`・`permutation-frontier`（test-beacon）・`permutation-prize` のビルドが要る（docs/RUNNING.md §2）。
