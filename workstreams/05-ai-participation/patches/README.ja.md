# ⑤から共有コアへの変更案（未適用）

⑤は共有コードを直接変えていません。ここにあるのは、統合する担当が判断するための差分です。

## 0001 代理の財布の、細かい上限と実測の請求

`0001-agent-wallet-staking-limits.patch`：`permutation-gateway/src/frontier/agent/` の4ファイルと、新しいテスト1ファイル。

| 足すもの | 場所 | 既存への影響 |
|---|---|---|
| `budget.perCall`：1回の確保の上限（モデル1回、値段のある行動1回） | `policy.mjs`、`ledger.mjs` `hold()` | 書かなければ今と同じ |
| `budget.byCategory`：`inference`・`game` ごとの `total`・`perDay` | 同上。1日の使用額をカテゴリ別に数える `day.byCategory` | 書かなければ今と同じ。古い状態ファイルは、日付が変わるか確保の時に `byCategory` が足される |
| `expiresAt`：本人の許可の終わり（unix ms） | `policy.mjs`、`gateway.mjs` `#gate`・`meterInference` | 書かなければ今と同じ |
| `meterInference({price, actual, served})`：見積りで確保し、実測（≤ 確保）で確定。答えたモデルを `servedModel` として記録 | `gateway.mjs` | 渡さなければ今と同じ固定額 |
| エラーコード `PerCallLimit`・`CategoryLimit`・`PolicyExpired` | `contract.mjs` | 追加だけ |

### 確かめたこと

- `git apply --check`：基準 `7ac94cc1`（＝共通基準 `4cd901de` と共有コードは同じ）にそのまま当たる。
- 使い捨ての git worktree に当てて `npm test`（`permutation-gateway`）：**2,534 件、通過 2,533、失敗 0、スキップ 1**（Gemma 4 のモデルファイルがない）。新しいテスト5件を含む。記録：`../logs/staking/patch-0001-gateway-tests.txt`。

### 適用の条件

1. **上限の仕組みの設計と形をそろえること。** 上限の欄名（`perCall`・`byCategory`・`expiresAt`）は⑤の仮の物です。②の現行案（StockSwap）はこの仕組みではありません（[GUARANTEES](../GUARANTEES.ja.md) §1）。誰が設計するか決まってから、それに合わせて書き直します。
   - **このパッチが縛るのは、中継を通る送りだけです。** 代理の鍵（seed）を持つ者が RPC へ直接送る取引は縛れません。鎖の session 鍵にも範囲はありません。
   - ③のパッチ 0005（隊商、未取得）とは、`contract.mjs`・`gateway.mjs` で重なる見込みです。0005 を受け取ってから、隔離したコピーで適用順を決めます。③の `2f8ec700` のパッチ 0001 とは重なりません（確認済み）。
2. 代理の財布の担当のレビュー。特に次の2点。
   - 期限の確認は `#gate` の時点だけで、送る直前（`beforeSend`）にはしない。数秒の差で期限を越えうる。
   - 1日の使用額をカテゴリ別に数えるのは、このパッチの後に確定した分から。
3. 画面の表示文：新しいエラーコードの文（`fi18n.mjs`、`lang/en-frontier*.mjs`）。このパッチには入っていない。
4. 中継の runner（`runner.mjs`）がサーバーの自己申告のモデル名を記録するには、別の変更が要る（`servedModel` は自己申告で、検証ではない。検証にはファイルのハッシュの照合が要る）（`llmDecider` が答えの `model` を返し、`meterInference` に `served` を渡す）。AI住人と共有の `citizens/mind/llm.mjs` も変えることになるので、AI住人の担当と相談する。
5. 本番の価格・上限の既定値は入れない（このパッチは欄を足すだけで、値は持ち主と運営が決める）。
