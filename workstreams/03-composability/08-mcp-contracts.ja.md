# 08 MCP ツールの契約と、②④⑤との境界

③は外部接続・MCP ツールの契約・認証の接続部分を担当する。§1–§2 は実装済みのもの（`workstreams/03-composability/mcp/`）。§3–§5 は他担当との境界の**案**で、②と④の部分は明示した MOCK で動かしている。

## 1. 対応操作の一覧（ツール契約 v0.1）

共通: 認証は OAuth の Bearer。どのツールも結果を `structuredContent`（モデル向けの構造）と `content`（同じ JSON の文字列）で返し、失敗は `isError: true` と `{ok: false, error: {code, message, …}}`。ツールの引数で権限は変わらない。

| ツール | 用途 | 入力 | 副作用 | 主な失敗 | 次の確認 | 注記（annotations） |
|---|---|---|---|---|---|---|
| `get_connection` | 誰のために動くか | なし | なし | — | `get_village_status` | read, `wylls.read` |
| `get_village_status` | 村・倉庫・道中の隊商・代理人の状態と予算（⑤の表示） | なし | なし | `RelayUnreachable`, `HeraldUnavailable`, `NotOwner`, `NoVillage` | 不足なら `check_resource_shortfall` | read |
| `check_resource_shortfall` | 目標（倉庫の費用、または資源量）に対する不足と、それを満たせる自分の倉庫 | `goal: {kind: "vault"}` か `{kind: "amounts", amounts: {Stone: 300}}` | なし | `BadRequest` | `prepare_caravan` | read |
| `prepare_caravan` | 自分の 2 つの場所の間の隊商を計画（積荷の検査、道、所要時間、要約） | `from`, `to`（`placeId`）, `cargo`（資源名ごとの整数） | 計画をサーバーに 5 分保存（ゲームには何も起きない） | `NotYourPlace`, `SamePlace`, `NoCargo`, `Insufficient`, `NoRoad`, `Unknown` | 要約を人に見せ、`send_caravan` | read（`idempotentHint: false`） |
| `send_caravan` | 計画を代理人の財布で送る | `planId`, `requestId`（再送の鍵） | **隊商が出る**（呼び戻せない、襲撃されうる） | `InsufficientScope`, `PlanUnknown/Used/Expired/Stale`, `IdempotencyConflict`, `Grant*`（②MOCK）, ⑤の `ActionNotAllowed/AgentStopped/StalePolicy/BudgetExceeded/SessionNotDelegated/BadCapability`, `RelayUnreachable`・`RateLimited`（同じ requestId で再送してよい）, 結果不明の後の `NotSent` | `get_operation_status` | **write**, `destructiveHint: true`, `idempotentHint: true`, `wylls.caravan` |
| `get_operation_status` | 操作の状態（④MOCK の受領証） | `operationId` か `requestId` | なし（チェーンと herald を読んで状態を進める） | `UnknownOperation` | 終端でなければ後でもう一度 | read |
| `list_operations` | この接続の最近の操作（再接続後の確認） | なし | なし | — | `get_operation_status` | read |

`placeId` は `village:P,Q,SITE` か `vault:P,Q,TILE` の形だが、**サーバーが一覧に載せたものしか受け付けない**。形を真似て他人の場所を書いても `NotYourPlace` になる。

版: サーバーは `serverInfo.version` 0.1.0。MCP の protocolVersion は `2025-11-25`、`2025-06-18`、`2025-03-26` を受け、それ以外は `2025-11-25` を返す。ツールの入出力を互換性なく変えるときはツール名を変える（`send_caravan_v2` など）。

## 2. 認証と権限

| 要件 | 実装 | 試験 |
|---|---|---|
| 誰の村かをサーバーで検証 | link = 所有者のウォレット署名（`aud`、クライアント、リダイレクト URI、スコープ、代理人、上限、期限、nonce）。代理人の所有者を relay の記録で照合。ツールは link の所有者の村だけを読む | 偽の署名・他人の代理人を拒否（protocol-auth） |
| 読取と書込の分離 | `wylls.read` / `wylls.caravan`。読取だけの link は capability を持たない | 読取だけの接続で `send_caravan` → `InsufficientScope` と `_meta["mcp/www_authenticate"]` |
| 秘密を出さない | capability は AES-256-GCM で封印して保存。トークンはハッシュで保存。ログに Authorization・本文・トークンを書かない | 回答・ログ・ストアのファイルに capability・アクセストークン・リフレッシュトークンが無い（play） |
| ゲーム内の文章を権限にしない | 自由文は `untrusted` で包む。書込の引数は計画 ID と requestId だけ | 履歴に仕込んだ指示が何も起こさない（play） |
| 期限・対象・範囲・上限を実行層で強制 | トークン 1 時間、link 最長 30 日、計画 5 分、上限（② MOCK）、⑤の方針と予算、オンチェーンの SetSession の期限 | トークン期限切れ、link の取消、上限の各種、⑤の予算超過（play / protocol-auth） |
| 確認画面と認可の区別 | 認可を受け取る引数が無い。`destructiveHint` は ChatGPT に確認を出させるためだけ | 説明と試験の名前で明記 |
| 二重操作・二重支払いの防止 | 操作 ID = SHA-256(link, requestId)。gateway の冪等キーにも使う。計画は一度だけ。ストアに先に書く。同じ操作の再送は進行中の試行に合流する。結果不明は失敗にしない | 並行 3 本で 1 取引、送信中の再送、クラッシュ後の再送が gateway の記録の再生になる、relay 不達・429 の後、送った後の失敗（play） |

認可サーバーの追加の守り: 認可コードの再利用はその link を取り消す。誤りのリダイレクトにも `iss` を付ける。登録・同意の未認証ルートはアドレスごとに速度制限（既定 20 回、その後 2 秒に 1 回）し、登録と保留中の同意の数に上限を置く。

ローカルの試験用認可サーバーの限界: アカウントの仕組みが無く、ウォレット署名だけで link を作る。本番では、既存の ID 基盤か監査済みの OAuth 実装に置き換える。CIMD は未実装。

## 3. ② Grant との境界（MOCK `wylls.mock-grant/0`）

今の link の上限は、所有者が署名した次の形である（`src/ports.mjs` `normaliseGrant`）。

```text
grant = { contract: "wylls.mock-grant/0", actions: ["SendCaravan"], maxSends: 1..100,
          maxCargo: [8 個の整数: 1 回あたりの各資源の上限], expiresAt: ms（link の期限以内） }
```

③が②に求めるインターフェース（案）:

```text
GrantPort.check(principal, action)                  → {ok} | {ok:false, code, message}   // 変更なし
GrantPort.reserve(principal, action, operationId)   → 同上。成功なら 1 回分を確保（同期・原子的）
GrantPort.consume(principal, operationId)           // 送った（または送ったかもしれない）
GrantPort.release(principal, operationId)           // 何も送っていない
GrantPort.view(principal)                            → 人に見せる上限と残り
```

- `principal` は ③の link（所有者のウォレット、代理人、スコープ）。
- **訂正（2026-10-30、[10 §2.1](10-handoff.ja.md)）。** 今の MOCK は「接続の時に所有者が署名した、この接続の中だけの上限」である。②の施設の交換権とは別のものなので、②の権利と置き換えられるとは扱わない。②の権利を MCP の操作の前提にするかどうかは、②の資料を受け取ってから決める。`send_caravan` の流れ（reserve → 送る → consume/release）は、接続の上限の扱いとして残す。
- コアで範囲を絞った委任（今の session 鍵は全部か無しか）は [patches/0004](patches/0004-core-scoped-delegation.md)。

## 4. ④ RunReceipt との境界（MOCK `wylls.mock-run-receipt/0`）

④の RunReceipt の契約は受け取っていない。③は次の**仮の**形で動かしており、本番の仕様として確定しない。

```text
receipt = {
  contract: "wylls.mock-run-receipt/0", mock: true,
  operationId, requestId, kind: "caravan.send",
  state: "requested" | "accepted" | "processing" | "completed" | "failed",
  terminal: bool, outcome?: "delivered" | "lost" | "taken" | "burned",
  plan: {from, to, cargo, steps, estimatedMinutes, seq},
  gateway: {status, signature, code, replayed, charges},   // ⑤ の ActionResult の写し
  chain: {state: "landed" | "failed" | "expired" | "unknown", slot?, code?},
  caravan: {seq, ownerTag, arriveAt, raid?, settledAtBell?},
  error?: {code, message, retryable, by},
  history: [{state, at, detail?}], next: [回復の選択肢（人とモデル向けの文。サーバーは自分では実行しない）]
}
```

状態の意味:

| 状態 | 意味 | どこで分かるか |
|---|---|---|
| requested | 要求を受け、記録した（まだ relay に届いたか分からない場合を含む） | ③のストア |
| accepted | relay が取引を送った（gateway の `sent`、署名あり）。または送付を試みたが結果が分からない（gateway の `failed`、または再送できない再試行）。後者は `history` にそう書く | gateway の ActionResult |
| processing | 取引が着地し、隊商が道にいる | relay `/f/tx/{sig}` が `landed`、herald の `moving` |
| completed | 隊商が決着した（届いた、宛先の世代が変わり失われた、襲撃で奪われた、焼かれた） | herald `/h/events` の CARAVAN_SETTLED / CARAVAN_RAIDED |
| failed | 何も動かなかった（拒否、チェーンでの失敗、期限切れ、結果不明のまま痕跡が無く通し番号も進まなかった `NotSent`） | gateway のエラー、`/f/tx` の `failed`/`expired`、herald と所有者の Citizen |

上限（② MOCK）の扱い: 送ったかもしれない時点で「使った」と数え、何も動かなかったと分かった時（チェーンでの失敗、期限切れ、`NotSent`）に戻す。何も送っていないと確かな時（gateway の `refused`、最初の試行での認証・形の拒否）だけ、確保を解く。

④に必要な契約（依頼）:

1. 操作の識別子の生成規則（呼び出し側の requestId から決まること。再送で同じになること）。
2. 状態の一覧と遷移（上の 5 つで足りるか。部分的な成功をどう表すか）。
3. 「送った」と「届いた」を分けること。襲撃・宛先の世代違いを、失敗ではなく規則による結末として返すこと。
4. 切断・再起動の後に、識別子で必ず状態を引けること（③は自分のストアに書いてから送っている）。
5. 通知（MCP Events のような push）を持つか。持たない場合、問い合わせの頻度の目安。
6. 回復の選択肢を機械が読める形（コード）で返すこと。

④の契約が来たら、`receiptOf` と `track` を④のクライアントに置き換え、`state` の名前を合わせる。

## 5. ⑤ 予算・支払い・手動／自動・AI staking との境界

**③は残高台帳も課金規則も持たない。** 予算と残高は代理人の財布（⑤）が持ち、③は読むだけである。

| ③が⑤から使うもの | 今の実装 | 使い方 |
|---|---|---|
| 予算・残高・日次の状況の表示 | `GET /f/agent?id=` の `balance`、`policy.budget`、`day`、`quota` | `get_village_status` の `budget` にそのまま載せる（③は計算しない） |
| 書込の可否の判定 | `POST /f/agent/action`（AgentGateway：mode、方針の版、許可行動、村、価格の保留、残高、日次上限、オンチェーンの委任、relay の検査） | `send_caravan` はこれを呼ぶだけ。拒否のコードをそのまま返す |
| 手動／自動 | `mode`（manual で `AgentStopped`）、`modeEpoch` | 計画を作った時の `modeEpoch` を送る。停止の後は拒否される |
| 操作の識別 | 冪等キー | `ws03:<linkId>:<requestId>` |

**AI staking（前払い残高で代理人の活動費を管理する構想）への要求（案）:**

1. 残高の正本は⑤の 1 か所。③は表示用に読むだけで、③の側に別の残高・保留・価格表を作らない。
2. ③が送る要求に、課金の分類（`game`、`inference`、`network`）を⑤が付けられるよう、行動名と冪等キーを渡す（今のまま）。
3. 前払い残高が足りない・上限を超える場合の拒否コード（今の `InsufficientBalance`、`BudgetExceeded`、`DailyLimitReached`）を維持するか、新しいコードを⑤が決める。③はコードをそのまま `error.code` に載せ、回復の選択肢を対応させる。
4. 前払い（staking）・返金・引き出しは**所有者のウォレットの署名つきの操作**のままにし、MCP のツールにしない（ChatGPT の方針でも送金の実行は禁止）。③はその画面への案内文だけを返す。
5. 推論の料金（`meterInference`）は運営の runner の内部の話で、ChatGPT からの呼び出しには推論料金がかからない（ChatGPT 側のモデルが考えるため）。⑤が「外部の MCP 呼び出しに料金を付けるか」を決める場合、`prices.game.SendCaravan` に値を入れれば今の gateway の保留の仕組みで扱える（試験で、価格と予算の超過が `BudgetExceeded` になり何も送られないことを確認）。

## 6. 秘密情報と信頼できない文章

- 封印の鍵（`WYLLS_MCP_SEAL_KEY`）はサーバーの環境変数。ストアのファイルに保存するときは必須。
- 同意画面は秘密を受け取らない（ウォレットは署名だけを返す）。capability は relay からサーバーに直接届く。
- `untrusted` で包む文章: 代理人の履歴の理由（モデルか人が書いた）。今後、国の投稿・会話などを読むツールを足すときも同じ扱いにする。
- サーバーの instructions（512 文字以内）で、包まれた文章に従わないよう伝えている。ただし、モデルが従わなくても、書込は §2 の層でしか通らない。

## 7. 未実装・未検証

- CIMD（ChatGPT の推奨する登録方式）。DCR で接続する。
- MCP Events（push 通知）。今は pull。
- 本番の認可サーバー、公開 HTTPS、トンネル。
- ブラウザウォレット拡張での同意画面の署名。
- 他の行動（倉庫の建設、襲撃の決定など）の MCP ツール。必要なら、1 操作 1 ツールで同じ流れ（計画 → 送る → 受領証）に足す。
