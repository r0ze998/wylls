# ②権利・③命令契約・④Run への接続（仮アダプター）

**状態：3つとも仮アダプターです。** 2026-10-29 の時点で、②（権利）・③（命令契約）・④（Run）の契約は届いていません（どのブランチにも `workstreams/02-*`・`03-*`・`04-*` はない）。そこで、**今の共有コードがすでに守っていること**だけから組み、別の Grant や Run の仕組みは作っていません。正式な契約が届いたら、この3つを差し替えます。広げて正式版にするものではありません。

コード：`src/adapters.mjs`（`ADAPTER_STATUS` に、それぞれ仮であることを書いてある）。

## ② 権利 → `grantFrom(view, mandate, nowSec)`

| 入力 | どこから | 信頼 |
|---|---|---|
| mode、`policy.version`、`modeEpoch`、許可した行動 | `agent_view`（中継の記録） | 中継が守る |
| 鎖上の委任（session key と期限） | `agent_view` の `delegation`（中継が鎖から読む） | 鎖が守る |
| 本人の委任条件（目的と上限） | 持ち主が自分の代理のために書く JSON | 代理の側だけで効く（下の注意） |

**本人の委任条件（仮）：**

```js
{ mandateId, version, agentId,
  basedOnPolicyVersion,          // 書いたときの中継の方針の版。変わったら代理は止まり、本人の見直しを待つ
  purpose,                       // 目的（モデルには本人の文として渡す）
  nation, from: [依頼を書いた人], // どの国の、誰の依頼に従うか（空なら国の誰にでも）
  allowed: ['Train', …],         // 中継の方針との共通部分だけが効く
  partial: true,                 // 上限に収まる分だけの協力を許すか
  limits: { perRequest: {Food: 120, …}, perDay: {Food: 300, …}, troopsPerRequest: 200 },
  expiresAt, revokedAt }          // 世界の時計（unix 秒）
```

**守ること：**
- **狭めるだけ。** `allowed` は中継の方針との共通部分。方針にない行動は、委任条件に書いても `deniedByPolicy` に出て、使えない（テスト「the mandate can only narrow」）。
- 書いていない資源の上限は **0**（使えない）。
- 方針の版が変わったら止まる（`MandatePolicyChanged`）。期限切れ・取消・別の代理用も止まる。

**注意（なぜ仮か）：** 委任条件は署名されていません。代理の側（持ち主の手元の runner）だけで効き、中継には伝わりません。中継が強制するのは、今までどおり方針（USDC の予算・行動の種類）・mode・版・委任です。そのため、委任条件のファイルを書き換えられる人は、**中継の方針の範囲の中でだけ**上限を緩められます。中継の方針を超えることはできません。資源の上限・期限・従う相手を中継か鎖で強制する形が要ります（設計の決定：24 の3章「代理の札」をチェーンの上に置く。未実装）。

### 接続案（訂正 2026-10-30）
**②の現行案は StockSwap（交換の権利、未採用）で、この制限ではありません**（共有された報告の要約。コード未確認）。下は、誰が作るか決まっていない仕組みへの接続案です（[GUARANTEES](GUARANTEES.ja.md) §1）。
1. その仕組みが、少なくとも次を持つこと：対象の村、許す命令、資源ごとの1件・1日の上限、期限、取消、版。
2. 代理の側の `grantFrom` は、それを読むだけにする（今の `mandate` の代わり）。`basedOnPolicyVersion` はその版に置き換える。
3. 中継（`AgentGateway.#gate`）か鎖が確かめる。中継で確かめても、代理の鍵を持つ者が RPC へ直接送る取引には効かない。鎖で確かめるなら、session 鍵に範囲を持たせる変更が要る（今の Citizen には範囲の欄がない）。

## ③ 命令契約 → `CommandContract`

コードから読みます（手で一覧を書かない）：

| 欄 | 読み方 |
|---|---|
| 命令がプログラムにあるか | `ixOf(name, 3)`（S1 の ABI） |
| 代理に任せられる行動か | `AGENT_ACTIONS`・`NEVER_DELEGATED`（`contract.mjs`） |
| 代理の経路で組み立てられるか | `accountsFor` を試しに呼ぶ（`gateway.mjs`） |
| 本人の決定で代理に任せない | `DECIDED_NOT_FOR_PROXY`（Vote：29 の E2） |
| プログラムにない | `NOT_IMPLEMENTED`（施設の利用、共同作戦への登録） |
| 欄の範囲 | runner の厳密な schema の範囲（Train の unit 0〜5、n 1〜10,000 など） |

`check(command)` の答え：`UnknownCommand`（**作らない**）、`NotDelegable`、`DecidedNotForProxy`、`WalletRequired`（他人への隊商）、`NoAgentPath`、`NotImplemented`、`BadFields`。断るときは、理由と本人の判断を返します。

### ③への接続案
1. ③の契約が、命令ごとに「誰が署名するか（財布／session key）」「代理に任せられるか」「欄と範囲」「資源の費用」を持つこと。今は費用を runner の `CATALOG_S1` から読んでいる（情報用。決めるのはプログラム）。
2. 隊商（SendCaravan）を代理に開くなら、③で「自分の倉どうし（session key で可）」と「他人宛て（財布が要る）」を分けて書く。代理の経路は前者だけ足せる（鎖はすでに許している）。

## ④ Run → `RunJournal`

1回の参加を、追記だけの記録にします（JSONL）。段階：

`observe → grant → plan → guard → act-begin → act-result（または act-error） → verify → memory`

| 守ること | どう守るか | テスト |
|---|---|---|
| 二重に送らない | `requestId` は（代理・依頼・命令・委任条件の版・試行の回数）から決まる。同じ試行の再送は同じ id。中継が記録した結果を返す | duplicates、restart |
| 途中で死んでも続けられる | `act-begin` があって `act-result` がない物を、次の回に同じ id で頼み直す（送っていれば `replayed`、送っていなければ1回だけ送る） | restart in the middle |
| 失敗を成功と記憶しない | 「協力した」の記憶は、鎖が着地と言い（`GET /f/tx`）、**かつ**世界に効果が見えたときだけ。`remember()` は確かめていない成功を受け付けない | unknown result、failed action |
| 断られた物を、理由が消えた後に再挑戦できる | 断られた・失敗した後の試行は新しい id（中継が昔の拒否を返し続けないように） | failed action |
| 1日の上限 | 始めた試行の費用を記録から数える。中継が断った物は数えず、結果が不明な物・後で失敗した物は数える（控えめ） | day limit、unreadable delegation |
| 取り消した後に送り直さない | 再起動の再開は、委任が有効なときだけ。無効なら「不明」のまま保留する（中継に、送らずに確かめる道具がまだないため） | restart under a revoked mandate |

### ④への接続案
1. ④の Run が、「始めた」「中継の答え」「鎖の答え」「効果」を別々の状態として持つこと。今の ActionResult の `sent` は「中継が送った」で、着地でも効果でもない（`contract.mjs` の説明どおり）。
2. 効果の確認（兵が増えた、荷が着いた）は、herald の公開記録から読む。今のデモは fixture の世界で確かめている（下の「本物と模擬」）。
3. ④の Run が届いたら、`RunJournal` は捨て、`participate()` の `J(...)` を Run への書き込みに置き換える。

## 本物と模擬（このデモで）

| 本物（共有コードをそのまま） | 模擬・fixture |
|---|---|
| 中継の route、代理の財布（資格・重複・mode・版・許可・村・料金の確保・委任の確認・取引の組み立てと署名・中継の形の確認と模擬実行）、MCP サーバー、`GET /f/tx` | 鎖（ゲームのテストの scripted chain：署名を確かめ、送った物を記録するが、ゲームのプログラムは動かさない）。プログラムの効果（Train の支払いと兵の増加）は `settle()` が真似る。国の依頼板（どこにもない）。モデル（台本の stand-in） |
