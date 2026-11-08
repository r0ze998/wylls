# AI staking：現在の実装の確定（要件1）

> **2026-10-30 の訂正あり。** 制限の強制場所・session の単位・停止の段階・費用と出金・モデル情報の保証は [GUARANTEES](GUARANTEES.ja.md) が正です。

調べた対象：共通基準 commit `4cd901de`、⑤の commit `7ac94cc1`（共有コードは同じ）。根拠は、ファイル・行番号と、この作業のテスト（`test/staking.test.mjs`）です。秘密情報・APIキーは出力していません（このコードには外部APIのキーを読む所がありません）。

## 結論

**「Gemma で動いている」は、repo の中では確かめられません。**

1. **既定ではモデルを使っていません。** 中継の runner は既定で無効です。有効にしても、`--agent-llm` を渡さなければ、無料の規則（収穫するだけ）が動きます。
2. **記録の「モデル名」は、設定した別名の文字列です。** 実際に動いたモデルではありません。
   - 台帳には `model:gemma-4-26b-a4b-it` と残ります。これは `--agent-llm-alias` の既定値です。
   - サーバーが答えた `model` も、読み込んだファイルも、runner は読みません。
3. **起動スクリプトは、どの GGUF を読み込んでも別名を `gemma-4-26b-a4b-it` にします。** 別名からは中身が分かりません。
4. **実モデルで動かした記録（transcript）は repo に入っていません**（`.local/` に置く作り）。
   - 文書の記載では、10-23 の Linux 環境で実際に動いたのは **Gemma 3 4B** です。Gemma 4 26B はメモリが足りず未実行です。
   - 10-17 の Gemma 4 26B の実行（DESIGN §12）は文書の記載だけで、ここでは確かめられません。
5. **この環境には llama-server もモデルファイルもありません。** 今回、実モデルでは何も動かしていません。

## 根拠

### 起動設定

| 何 | 中身 | 根拠 |
|---|---|---|
| runner の有無 | 既定は無効。`--agent-runner` で有効（`--agent-wallet` が前提） | `permutation-gateway/src/frontier/config.mjs:68`、`:196-198` |
| モデルの URL | 既定は `null`（＝モデルなし）。`--agent-llm` か `FRONTIER_AGENT_LLM_URL` で設定。loopback だけ許す | `config.mjs:70`、`:158`、`:200-203` |
| 別名 | 既定は `'gemma-4-26b-a4b-it'`。`--agent-llm-alias` で変えられる | `config.mjs:72`、`:159` |
| 判断する仕組みの選び方 | URL があればモデル（`llmDecider`）、なければ規則（`ruleDecider`、無料） | `src/frontier/server.mjs:104-105` |
| モデルの料金 | 1回 10,000（＝0.01 テストUSDC、試験値）。成否にかかわらず請求 | `config.mjs:62`、`gateway.mjs:56-57` |
| ゲーム内の USDC 価格 | 表は既定で空（`--agent-game-prices-file` で運営が入れる口だけある） | `config.mjs:64`、`server.mjs:98-99` |

### モデルの呼び出し

| 何 | 中身 | 根拠 |
|---|---|---|
| 呼び出す相手 | `POST <url>/v1/chat/completions`（OpenAI 互換） | `citizens/mind/llm.mjs:83` |
| 答えから読む物 | 本文・usage・timings・`system_fingerprint`。**`model`（サーバーが名乗るモデル）は読まない** | `llm.mjs:97-105` |
| 記録されるモデル名 | 判断する仕組みの名前 `model:${alias}` を、そのまま台帳に渡す | `src/frontier/agent/runner.mjs:363`、`:411`、`gateway.mjs:528` |
| 起動スクリプト | `-m "$MODEL" --alias gemma-4-26b-a4b-it`。どのファイルでも同じ別名。既定のファイルは所有者の Mac のパス | `citizens/llama/start-pinned.sh:9-11` |
| ファイルを確かめる仕組み | AI住人の検査は `/props` の `model_path` を照合する。**代理の runner にはない** | `citizens/bin/llama-check.mjs:111` |
| E2E・ベンチ | 実モデルの時だけ `/props` の `model_path` を transcript に書く。既定は stand-in | `scripts/agent-wallet-e2e.mjs:30-33`、`:130-135`、`scripts/agent-decision-bench.mjs:98-100` |
| 集計 | 「別名は当てにならない。読み込んだファイルが Gemma 4 でなければそう書く」 | `scripts/agent-stage5-summary.mjs:13-14`、`:67` |

**テストで固定：** `test/staking.test.mjs` の「the shared runner records the configured alias」。サーバーが別のモデル名を答えても、台帳の行は `model:gemma-4-26b-a4b-it` になることを確かめています。

### agent の実行経路

| 経路 | 流れ | 根拠 |
|---|---|---|
| 中継の runner | `AgentScheduler.tick` → `runOnce` → `meterInference`（モデル） → `submit({runner: true})` | `runner.mjs:466`、`:399` |
| MCP | `agent_act` → `POST /f/agent/action {capability}` → `submit` | `mcp/agent-mcp.mjs:110-135` |
| ⑤のデモ | MCP の道具 → 同じ `submit`（新しい経路は作っていない） | `src/participate.mjs` |

### 支払い

| 何 | 中身 | 根拠 |
|---|---|---|
| 残高 | 運営が持つテスト用の保管口座と台帳。入金は所有者が署名した送金を確かめて1回だけ記帳 | `custody.mjs`、DESIGN.md §6.1 |
| モデルの料金 | 固定額を確保 → 呼ぶ → 成否にかかわらず確定。再起動・期限切れで「不明」 | `gateway.mjs:512-545`、DESIGN.md §6.5 |
| ゲーム内の支出 | 価格があれば確保 → 送る → 鎖が着地と答えたら確定、失敗なら返す（reconcile） | `gateway.mjs:418-475`、`:546-575` |
| SOL の手数料 | 中継が払い、lamports を記録するだけ | DESIGN.md §6.3 |
| 外部APIへの支払い | **ない**。外部APIを呼ぶ所も、そのキーを読む所もない | `config.mjs:200-203`（loopback だけ） |

### 使える記録

| 記録 | repo にあるか | 中身 |
|---|---|---|
| 台帳の履歴（`agent-wallet.json`） | 実行時に作られる。repo にはない | `spend` の行に `model`（＝別名）、`tokens` |
| E2E の transcript（`.local/agent-wallet-e2e/*/transcript.json`） | **ない** | 実モデルの時は `model.modelPath` |
| STATUS-2026-10-23 の表 | ある（文書） | 実モデルは Gemma 3 4B（Q4_K_M、CPU）。Gemma 4 26B は「この環境のメモリでは動かない」（`STATUS-2026-10-23.ja.md:83-91`） |
| DESIGN §12 | ある（文書） | Gemma 4 26B での実行（10-17、Mac）。transcript は repo にない |

## 前回の⑤の成果と、今回の要件の対応

| 今回の要件 | 状態 | どこで |
|---|---|---|
| 予算：利用可能・処理中・確定を分ける | **実装済み（中継の台帳）**。⑤は明細として見せる | 台帳 `balance`、`src/staking/budget.mjs` `statement()` |
| 推論とゲームの別明細 | **実装済み（台帳のカテゴリ）**。⑤は明細に出す | 同上 |
| 1回の上限 | ⑤の実行層で実装（仮）。中継で強制するのはパッチ 0001（未適用） | `budget.mjs` `BudgetGuard`、`patches/0001` |
| 一定期間・総額の上限 | 全体：**中継で実装済み**（`total`・`perDay`・`callsPerDay`）。カテゴリ別：⑤の実行層（仮）とパッチ 0001 | 同上 |
| 許可する操作 | **中継で実装済み**（行動の種類）。⑤の委任条件で狭める | `policy.mjs`、`adapters.mjs` |
| 対象の村 | **中継で実装済み**（1つの村）。⑤の委任条件にも対象を書ける | `gateway.mjs:415`、`adapters.mjs` |
| 対象の施設 | **未実装**（プログラムに施設の利用がない） | CURRENT-SUPPORT §2 |
| 権限の期限 | 鎖上の委任の期限：**実装済み**。方針の期限：⑤の委任条件（仮）とパッチ 0001 | `gateway.mjs:481`、`patches/0001` |
| 手動／自動、停止、失効、期限切れ、予算不足で止まる | **中継で実装済み**。⑤は「上限で止まる」を選べるようにした | `gateway.mjs:410-416`、`participate.mjs` |
| 停止前に受理済みの操作が取り消せるか | 台帳の状態から⑤が表示（送る前は取消可、送信中・考え中は不可） | `budget.mjs` `statement().inFlight` |
| 考えた内容・要求・受理・結果・費用の追跡 | ⑤の記録と台帳の行をつなぐ | `budget.mjs` `trace()` |
| 残高追加・引出し | **中継のコードで実装済み**。⑤はテスト用の残高で、そのコードを通した。**鎖は模擬で、USDC は動いていない**（[GUARANTEES](GUARANTEES.ja.md) §4・§6） | `session.mjs`、`test/staking.test.mjs` |
| モデル／提供者を設定で切り替え | ⑤で実装（loopback の OpenAI 互換・台本）。外部提供者は宣言だけで、送らない | `src/staking/providers.mjs` |
| 推論費用の計測・換算・精算方法 | ⑤で計測と換算を実装。精算は今の固定額だけが実装済み。ほかは整理だけ | `src/staking/pricing.mjs` |
| 他担当の境界 | 文書化 | [STAKING-BOUNDARIES](STAKING-BOUNDARIES.ja.md) |
