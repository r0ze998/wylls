# ④への引き継ぎ：⑤が必要とする入力、RunReceipt、署名済み要求と費用、停止と再開（変更提案、2026-10-30 再改訂）

**この文書は提案です。** ⑤は共有コア・共通 API・他担当の仕様を変えていません。決めるのは④（実行経路と費用の契約）です。

**受け取れていない資料（未確認として扱う）：**
- ④ `bd415e7`（Run・取消・照合、費用の区分）
- ③ `47b05ac6`
- ③ `038b86f5`／`1bb0da2e` とパッチ 0005

**③のパッチ 0005 との競合は、解消済みとは扱いません。** 実物が届くまで、§6 の手順は「予定」です。

## 1. 今の⑤の実装が、何を通していて、何と統合していないか

| | 状態 |
|---|---|
| ゲーム操作の送り方 | このリポジトリに**今ある** MCP の `agent_act` → 中継の `POST /f/agent/action`（`AgentGateway`）。同じ `requestId` で聞き直す、`GET /f/tx/{signature}` を読む、中継の reconcile、という今ある仕組みだけを使う |
| ④の Run（実行の単位） | **未統合**（未受領） |
| ④の取消 | **未統合**（未受領）。⑤にあるのは、自分の判断を止めることだけ |
| ④の照合（署名済み要求と費用） | **未統合**（未受領）。⑤は自分では作らない |
| 記録 | 自動運転の状態と、1回ごとの記録に `executionPath`・`fourIntegrated: false` を付ける（`src/autopilot.mjs` `EXECUTION_PATH`） |
| RunReceipt | ⑤の側の **port**（`src/run-receipt.mjs`）と、今の中継から埋める**ローカルの代わり**。④の RunReceipt ではない（§2a） |

## 2. ⑤が④から必要な入力

1. **Run の識別子と、その生き死に：** ⑤の判断キー（`d05-…`）・試行キー（`d05-…#n`）と、④の Run・署名済み要求を結ぶ欄。
2. **署名済み要求の状態を「読むだけ」で返す手段：** 今は、同じ `requestId` で聞き直すと、まだ送っていなければ送ってしまう（MCP-EXTENSIONS `action_status` の提案）。
3. **取消の意味：** 「署名前に止める」「署名済み・未送信を破棄する」「送信済みは取り消せない」の区別と、それぞれの時点で費用がどうなるか。
4. **費用の契約の本文：** 推論の費用（§3）と、ゲーム操作の費用（中継の保留）を、1つの予算の中でどう分けるか。
5. **停止と再開の契約（§5）**：④の「新規の停止 → 署名済みの確認待ち → 成立済みの列挙」に、推論の行をどう入れるか。
6. **パッチ 0005 の差分**（§6）。

## 2a. RunReceipt の port（⑤が読む欄）

⑤は自動運転の1回ごとに、1つの RunReceipt を読みます。④の実物がないので、欄を `RECEIPT_FIELDS` に固定しました。ローカルの代わり（`localReceiptPort`）は、今の中継の読み出しで埋めます。④だけが出せる欄は null のまま、`missingFrom4` に並べます。

| 欄 | 出どころ | ローカルの代わりの埋め方 |
|---|---|---|
| `runId` | 今の中継から | the autopilot tick id (⑤) |
| `run4Id` | **④が必要** | —（④'s own Run id, to join ⑤'s run to ④'s records） |
| `agentId` | 今の中継から | agent_view.agentId |
| `citizen` | 今の中継から | agent_view.citizen |
| `decisionKey` | 今の中継から | the inference record (⑤) |
| `policyVersion` | 今の中継から | agent_view.policy.version at the observation |
| `modeEpoch` | 今の中継から | agent_view.modeEpoch at the observation |
| `seq.observed` | 今の中継から | agent_view.historySeq when the run observed |
| `seq.closed` | 今の中継から | agent_view.historySeq when the run closed |
| `acts[].requestId` | 今の中継から | the agent_act requestId (⑤ journal act-begin) |
| `acts[].idempotencyKey` | 今の中継から | <source>:<requestId>, read back from the relay history |
| `acts[].source` | 今の中継から | relay history entry source |
| `acts[].status` | 今の中継から | agent_act answer (sent | refused | failed | unknown) |
| `acts[].code` | 今の中継から | agent_act error code |
| `acts[].signature` | 今の中継から | agent_act answer |
| `acts[].signedAt` | **④が必要** | —（when the agent key signed (the relay does not expose it)） |
| `acts[].fate` | 今の中継から | GET /f/tx/{signature}: landed | failed | expired | unknown |
| `acts[].gameCharge` | 今の中継から | agent_view.holds by idempotency key (reserved); settled/released only via history |
| `acts[].cancellable` | **④が必要** | —（whether a signed, unsent request can still be dropped） |
| `inference.status` | 今の中継から | api-decider record |
| `inference.attempts` | 今の中継から | api-decider record (keys, outcomes, cost per attempt) |
| `costs.inference` | 今の中継から | RunCostMock classes for this run's keys |
| `costs.game` | 今の中継から | agent_view holds for this run's keys |
| `cancel.stage` | **④が必要** | before-sign only (⑤ stops deciding)（signed-unsent and sent stages are ④'s） |

**適合の確認（`src/run-receipt.conformance.mjs`）：** ④の実装も、同じ確認を通れば⑤はそのまま使えます。
- 形：すべての欄がある（④だけの欄は null 可）
- 順序：`seq.observed ≤ seq.closed`
- 操作：送った操作には署名と、中継の記録から読んだ冪等キーがある。断られた操作にはコードがある。1回の中で同じ署名が2度ない
- 費用：結果不明の推論を、未確定も確定もない（0）として見せない。断られた操作にゲーム代を持たない
- 取消：送った後は取り消せない（`Irrevocable`）。署名済み・未送信の取消は、ローカルでは `NotSupported`（④が要る）

## 3. 推論の費用の契約で、④にそろえてほしい形（⑤の mock、テストで確認）

| 操作 | いつ | 規則 |
|---|---|---|
| `check(amount)` | 呼ぶ前（何も変えない） | 1回・1日・総額の上限と、利用可能額 |
| `reserve(key, amount)` | 送る直前 | 同期で、確認と確保を1度に行う。同じキーは2度確保できない |
| `settle(key, measured)` | 使用量が返った時 | 確保額まで。超えた分は運営の記録 |
| `release(key)` | 送っていないことが確かな時だけ | 未確定は解放できない |
| `undecided(key, why)` | 使用量が返らない時（429・4xx・5xx・時間切れ・切断） | **0 として扱わない** |
| `decide(key, …)` | 外からの答え | 確定と返金には**根拠が必須**（`EvidenceRequired`）。運営の判断だけでは 0 にも返金にもできない。運営ができるのは、確保額での請求（メモ付き）だけ |
| `restart()` | プロセスの再起動 | 呼び出し中は未確定、送る前は解放 |

**照合について（未検証）：** GPT には試行キーを `X-Client-Request-Id` として送ります。送れることは資料にありますが、そのIDで利用・請求の記録を1件ずつ照会できるかは確かめていません。今の照合は fixture の契約です（`src/reconcile.mjs`。`source: 'fixture'` 以外は断る）。Claude には、クライアント側のIDが資料にありません。

## 4. 署名済み要求と費用の関係（今の中継で観察した事実と、④への入力）

**1回の判断にかかる費用は2つで、別々に動きます。**

| | 推論の費用（⑤の mock） | ゲーム操作の費用（中継の台帳） |
|---|---|---|
| 確保 | 呼ぶ前に見積上限で | 中継が `agent_act` を受けた時（価格表の値。出荷時の表は空） |
| 確定 | 使用量が返った時 | 中継の reconcile が、鎖の答え（着地）を見た時 |
| 戻る | 送っていないことが確かな時だけ | 送る前に断られた時、鎖が失敗・期限切れと答えた時 |
| 結果不明 | 未確定のまま確保 | 中継が「結果不明」として確保 |

- **推論は成功、ゲーム操作は断られた：** 推論の費用は払われ、ゲーム代は戻ります。記録も別々です（`inference.status` と `game[].code`）。
- **見つけた中継の振る舞い（④・中継の担当への入力）：** 別々の判断から出た**同じ命令**（同じ口座・同じ欄）が同時に送られると、次のことが起きます。
  - 中継の `BlockhashBook` が blockhash を共有し（同時の読み出し、本番ではさらに 1 秒のキャッシュ）、手数料の支払い者が同じ（1/150）なら、取引のバイト列が同じになります。
  - 再送防止が、2つ目を `Duplicate` で断ります。
  - 安全側の失敗です（送信は1件、ゲーム代は請求されない）。ただし、2つ目の判断の推論の費用は払われ、その依頼への協力は送られません。
  - 再現の手順と記録：`diag/staking-race.mjs`、`logs/diag/`、`MODEL-API.ja.md` §10。
  - ⑤は共有コアを直接変えません。直し方の提案は**パッチ 0002**（別の支払い者で作り直す）です（§5a）。採るか、別の直し方（命令に区別の欄を足す等）にするか、仕様とするかは、④・中継の担当が決めてください。

## 5. 停止と再開の契約（今の⑤の動き）

| 段階 | ⑤がすること | 費用 | ④に求めること |
|---|---|---|---|
| ⑤の停止（`Autopilot.stop`） | その時から、新しい判断も `agent_act` もしない | 送る前の推論の確保はない（確保は送る直前） | — |
| 本人の停止（中継の `mode manual`、本人の署名） | 次の事前確認で `Stopped`。中継も `agent_act` を断る（`AgentStopped`） | 同上 | 中継側の停止と、④の Run の停止の関係 |
| 予算での停止 | 呼ぶ前に、上限か残高が足りなければ止まる（`stopped-by-budget`）。以後の回は何もしない | 呼ばないので確保もない | — |
| 呼び出し中の推論 | 取り消せない | 答えが返れば確定、返らなければ未確定 | — |
| 署名済み・送信済みのゲーム操作 | 取り消せない。⑤は送り直さない | 中継の reconcile が決める | 署名済み・未送信の扱い（§2 の3） |
| 再開 | 本人だけ、メモ付き。中継が `auto`、委任が有効な時だけ始まる。次の回で、予算をもう一度確かめる | 未確定の費用は、止めても再開しても確保のまま | 再開時に、④の未完了の Run をどう扱うか |

**session 鍵：** ⑤は設定も変更もしません。session 鍵は Citizen に1つです。本人の MCP 操作（③）と同じ Citizen を使う場合も、複数の session 鍵は前提にしません。代理の鍵が session でなければ、⑤は始めず、止まります（`NotReady`・`NotDelegated`）。

**1つのプロセス：** 同じプロセスの中の2つ目の自動運転は断ります。2つ目のプロセスは検出しません。複数プロセスで安全とは扱いません。

## 5a. ④向けの共有コードのパッチ（未適用。`patches/README.ja.md`）

| パッチ | 中身 | 確認 |
|---|---|---|
| 0001 | 細かい上限と実測の請求（既存） | 以前の記録 |
| 0002 | 同じバイト列になった別の要求を、別の支払い者で作り直す（§4 の `Duplicate`） | パッチなしで失敗するテストが、パッチありで通る。`permutation-gateway` 2,533 件中 2,532 通過、失敗 0、スキップ 1 |
| 0003 | MCP サーバーが `source`（`mcp`・`ai`）を名乗る。③と⑤の記録を分ける | テスト1件追加。0001〜0003 を一緒に当てて `agent-wallet` 81 件・⑤ 37 件・model-api 41 件が通過 |

## 6. パッチ 0001（⑤）と 0005（③、未受領）：未解消

0001 が触る所：`permutation-gateway/src/frontier/agent/` の4つのファイル。
- `contract.mjs`：エラーコードの追加
- `gateway.mjs`：`#gate`・`meterInference`
- `ledger.mjs`：`hold()`、`day.byCategory`
- `policy.mjs`：`perCall`・`byCategory`・`expiresAt`

0005 は「隊商を代理の経路に足す」と聞いているだけで、触る所は推測です（`contract.mjs` の `ACTION_GROUPS`、`gateway.mjs` の `accountsFor`）。

**0005 が届いたら（予定）：**
1. 隔離したコピーで、両方の順（0001→0005、0005→0001）に `git apply --check` と `npm test`（`permutation-gateway`）を回し、結果を④に渡す。
2. 重なる行があれば、⑤の側（0001）を書き直す。0005 の中身は変えない。
3. 適用の順は④が決める。

自動運転は 0001 なしで動きます。0001 は「細かい上限を中継で強制する」ための物で、自動運転の前提ではありません。

## 7. 再現の手順

```
git checkout claude/ai-participation-model-api
node --test workstreams/05-ai-participation/model-api/test/*.test.mjs   # 41 件
node --test workstreams/05-ai-participation/test/*.test.mjs             # 37 件
node workstreams/05-ai-participation/model-api/demo/run-api-demo.mjs    # 最小の流れ（Claude・GPT）
node workstreams/05-ai-participation/diag/staking-race.mjs --seeds 900 --max-delay-ms 0 --payer random   # 約 1/150 で Duplicate
node workstreams/05-ai-participation/diag/staking-race.mjs --seeds 100 --max-delay-ms 0 --payer same     # 100/100 で Duplicate
node workstreams/05-ai-participation/diag/staking-race.mjs --seeds 100 --max-delay-ms 0 --payer distinct # 0/100
```
