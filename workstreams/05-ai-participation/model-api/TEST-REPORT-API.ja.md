# テストの結果：動く provider 接続と予算処理（2026-10-30）

**外部通信なし。** モデルの相手は 127.0.0.1 の HTTP fixture だけです。キーは読まず、送らず、作っていません。実資金・課金・push・merge・deploy はしていません。

## 実行したもの

| コマンド | 結果 |
|---|---|
| `node --test workstreams/05-ai-participation/model-api/test/*.test.mjs` | **34 件、通過 34、失敗 0**（3回連続） |
| `node --test workstreams/05-ai-participation/test/*.test.mjs`（既存の⑤） | **36 件、通過 36、失敗 0**（3回連続） |
| `node workstreams/05-ai-participation/model-api/demo/run-api-demo.mjs` | 完了。Claude・GPT とも 1〜7 の段階を通った。記録：`logs/model-api/api-demo.report.json` |
| 既存のデモ `demo/run-demo.mjs`・`demo/run-staking-demo.mjs`（出力は作業用の一時フォルダ） | どちらも終了コード 0 |

**不安定なテスト（既存。今回の変更とは無関係）：** `test/staking.test.mjs` の「two executor processes do NOT share the executor's caps」が、全体を続けて回すと、まれに失敗します。
- 変更を外した状態で 15 回中 1 回、変更ありの状態で計 80 回ほどの中で 1 回、失敗した
- 単独で 40 回回すと、失敗は 0 回
- 2つの実行を並行させるテストで、タイミングに依存していると見ています。原因はまだ特定していません。

## 内訳（model-api、34 件）

| ファイル | 件数 | 確かめたこと |
|---|---|---|
| `test/model-api.test.mjs` | 11 | 契約の形、使用量の対応、料金表、打ち切り・拒否、再試行の既定、時間切れ、送る前の失敗、並行と再起動、事前確認、静的な確認（環境変数・ネットワーク・認証ヘッダー） |
| `test/http.test.mjs` | 12 | 本物の HTTP で：Claude／GPT の要求・応答・使用量・実測の確定、時間切れ（未確定・再試行なし・要求は1回）、切断（ヘッダー前・本文の途中）、429／529／500（既定で再試行しない。許すと新しい確保と二重請求の印）、接続拒否（0、既定で再試行）、GPT の請求系 429、同じ判断の2回目（要求1回・確保1回）、外の宛先と認証ヘッダーを断る |
| `test/autopilot.test.mjs` | 11 | Claude／GPT の最小の流れ（予算→開始→判断→ゲーム操作→費用→上限停止→本人の復帰）、推論の失敗とゲーム操作の拒否を別に記録、形式外の答えを全部捨てる、同じ回の再実行、時間切れの照合（GPT は照合できる・Claude はできない）、事前確認（予算不足・依頼なし・委任なし）、1プロセスの制限、SetSession を持たない、答えの厳密な確認 |

## 実行していないもの

- 本物の Claude・GPT への呼び出し（禁止。承認事項）
- 提供者の本物の利用レポートとの照合（未実装。承認事項）
- `permutation-gateway` の全テスト（共有コードは変えていないため。パッチ 0001 の確認は前回の記録のまま）
- 2つ目のプロセスでの実行（安全と表示しないため、試していない）
