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

## 0002 同じバイト列になった別の要求を、別の支払い者で作り直す（④・中継の担当へ）

`0002-agent-wallet-rebuild-on-byte-collision.patch`：`gateway.mjs` と、新しいテスト `agent-wallet-duplicate-bytes.test.mjs`。

- **直す問題：** 別々の要求から出た同じ命令（同じ口座・同じ欄）が同時に作られると、blockhash が共有されます（`BlockhashBook` が同時の読み出しを1回にまとめ、本番では 1 秒キャッシュする）。そこで乱数で選ぶ支払い者が同じだと（1/150）、取引のバイト列が同じになり、再送防止が2つ目を `Duplicate` で断っていました。この要求の冪等キーは新しいのに、です。
- **変更：** 送信前の `Duplicate` は別の要求の取引なので、この要求は何も送られていません。そこで、使った支払い者を避けて作り直します（最大 `DUPLICATE_REBUILDS = 2` 回）。同じ要求の2回目（冪等キーが同じ）は今までどおり1回の送信で、作り直しの対象ではありません。
- **確かめたこと：**
  - パッチなしでは、新しいテストの1件目が `Duplicate` で失敗し、パッチありでは通る。
  - 支払い者が変えられない場合は、今までどおり `Duplicate`（送信1件、請求なし）。
  - `permutation-gateway` の全テスト（0002・0003 を当てた状態）：2,533 件、通過 2,532、失敗 0、スキップ 1（Gemma のモデルファイルがない）。
  - ⑤の全テストを、支払い者を常に同じにして実行：パッチなしでは2件失敗、パッチありでは 37/37 通過。
- **決めてほしいこと：** 直し方（支払い者を避ける、命令に区別の欄を足す等）と、作り直しの回数。

## 0003 MCP サーバーが、誰の操作かを名乗る（`source`）（④・MCP の担当へ）

`0003-agent-mcp-source.patch`：`mcp/agent-mcp.mjs` と、`agent-wallet-mcp.test.mjs` に1件。

- **直す問題：** MCP の `agent_act` は `source: 'mcp'` に固定で、冪等キーも `mcp:<requestId>` でした。同じ代理で、本人の MCP クライアント（③）と⑤の自動運転が動くと、中継の記録で区別できるのは requestId の接頭辞（⑤は `p05.`）だけでした。
- **変更：** `createAgentMcp({ source })`：既定は `'mcp'`、自動運転は `'ai'`。冪等キーは `<source>:<requestId>`。既存の呼び出しは変わりません。
- **確かめたこと：** 同じ requestId を2つのサーバーから送ると、`ai:…` と `mcp:…` の別の記録になる（テスト）。`agent-wallet` のテスト 81 件は、0001・0002・0003 を一緒に当てても通過。

## 当てる順と組み合わせ

- 0001・0002・0003 は、それぞれ単独でも、3つ一緒でも、`git apply --check` が通ります（基準 `6cdd648c` の共有コード）。
- 3つを当てた状態で、⑤のテスト 37 件、model-api のテスト 41 件が通過。
- ③のパッチ 0005 は未受領です。0005 との重なりは、**確かめていません**（解消済みとは扱いません）。
