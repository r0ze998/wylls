# 03 契約：住民、④⑤⑫の差し替え口、世界と掲示板

型の正本は各ファイル先頭のコメント。ここは要点と、他の担当が差し替えるときの条件。

## 1. 住民（`resident/resident.mjs`）と charter

住民のディレクトリに置くもの：`charter.json`（所有者が書く）、`resident.key`（住民が初回に作る。0600）、`state.json`（journal・予算台帳・カウンタ。一つのファイル）、`episodes.jsonl`（記憶、ローカル adapter のとき）、`decisions.jsonl`（判断の記録）。

`charter.json` の項目：`id, name, goal, pos, owner{name,address}, funder, stoppedBy[], siblings[]（同じ所有者の住民のアドレス）, limits, budget, haltFile, undecided{aiDisclosure, prizeEligibility, productionHeadcount, fundingCollection}, lifetime`。

**目的は職業ではない。** `goals.mjs` の目的は「成長（自分の村の生産）」と「活用（自分に要らない在庫を必要な所へ）」の重みと計画の深さ・待てる時間だけで、候補を作るコードは全住民で同じ。どちらの住民も建設・依頼・引受・断り・待機のすべてをできる。所有者は `policy` コマンドで目的を替えられる。

1ターン（`step()`）：観測 → 停止の確認 → journal の未完了を世界に問い合わせて完了させる → 公開事実から記憶を作る → 約束の返送（code の義務）→ 起きる理由の判定 → 候補 → provider（予算の保留つき）または fallback → 検証 → 送る予定を journal に保存 → 送る。

## 2. ⑤ provider の契約（`resident/ports/provider.mjs`）

```
ProviderRequest  { v:1, purpose:'resident.decide', residentId, turn, bell, system, user,
                   candidates:[{id, kind, summary, score}], handles:['M1',…], schema, limits:{maxOutputTokens, deadlineMs} }
ProviderResponse { choice, reason, mem:[handles], usage:{inputTokens, outputTokens}, provider, model }
```

- `schema` の `choice` は今回の候補 id の enum。候補にない id、JSON でない応答、期限切れはすべて拒否（`NotACandidate`・`Shape`・`Late`）し、fallback が決める。拒否が3回続くと pulse の間 provider を呼ばない。
- 呼ぶ前に `AgentLedger.hold(category:'inference')`、応答の有無にかかわらず `settle`（呼んだ分は課金）。1日の回数・総額・日額のどれかで止まる。
- `fromChatProvider(chat, {provider, model})`：⑤の provider オブジェクト（`complete({system, user, schema, maxOutputTokens}) → {text, usage, model}`）をこの契約に合わせる。今回は偽の chat で試験しただけで、Claude・GPT の API は呼んでいない。
- **⑤に確認が要る点（食い違い）**：AI 市民の契約と `guards.mjs` は「有料 API の鍵をどのプロセスにも置かない」。⑤が Claude/GPT を使うなら、その鍵を持つのは⑤の provider プロセスであって住民ではない、という分け方が要る（住民の `run-demo.mjs` は鍵があれば起動を拒否する）。

## 3. ④ 実行・取消の契約（`resident/ports/execution.mjs`）

```
submit(ActionRequest) → ActionResult       同じキーと同じ本文なら記録済みの結果を replayed:true で返す
status(idempotencyKey) → ActionResult & {fate:'pending'|'landed'|'failed'|'cancelled', fateError} | null
cancel(idempotencyKey) → {cancelled, reason?}   届く前だけ。届いたものは戻さない
ActionRequest = {agentId, source:'resident', idempotencyKey, policyVersion, modeEpoch, action:{name, fields}}
```

エージェント財布の ActionRequest/ActionResult（`contract.mjs`）と同じ形。違いは `source: 'resident'`（パッチ 0002）と、`holding` を持たないこと（住民は自分の村しか動かせない）。住民が再起動後に頼るのは `status(key)` だけなので、④の実装はキーごとの結果を再起動をまたいで返せることが条件。

## 4. ⑫ 記憶の契約（`resident/ports/memory.mjs`）

```
append(episode) → boolean   同じ id は二度目以降 false（再起動で同じ事実を学び直しても増えない）
recall({focus, bell}) → episodes（古い順）
all() → episodes
episode = {id, bell, kind, importance, entities[], text{en,ja}, facts}   （AI 市民の §5.2 の形）
```

信頼度 `trustOf` は記憶から毎回計算する（守った +1、返した +1、破った −2）。したがって⑫の実装に替えても、同じエピソードを保てば行動は同じ（`ports.test.mjs` で、別実装に差し替えても判断列が一致することを確認）。住民には自分の adapter しか渡さない。

## 5. 世界と掲示板（模擬。実環境への写し方は提案）

- **世界**（`world/testworld.mjs`）：`join({body, sig})`、`view(viewerKey)`（公開部分は閲覧者によらず同一、`me` は本人の上限だけ）、`submit({body, sig})`（キーは送信者ごとの名前空間）、`status`、`cancel`。運営の操作（時間を進める、襲撃を仕込む）は `world.operator` にだけあり、参加者の ports には入らない。
- **掲示板**（`world/board.mjs`）：`request{to|null, want, offer, deadlineBell, openIfDeclined}`、`reply{re, decision:'accept'|'decline', reason, alternative}`。規則：1依頼に1人1返答、返答への返答はない、断れるのは宛先だけ（全員宛てには沈黙が答え）、引受は先着1人、送信者ごとに 3/ターン・40/日、未完了の依頼は1人3件まで。状態（open・claimed・fulfilled・lapsed・expired・declined、返送の有無）は**自己申告でなく世界の隊商の到着記録から**導く。
- **提案（未実装）**：実環境では、掲示板を citizens の social 層の新しい署名記録種として置き、判定は herald の隊商の記録から行う。隊商にはメモがないので、依頼との対応は「引受後に出発し、期限までに着いた、引受人から依頼者への、望みを満たす積荷」で取る（模擬と同じ規則）。
