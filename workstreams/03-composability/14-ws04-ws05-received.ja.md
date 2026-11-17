# 14 ④⑤の実物の受領と照合、④へ渡す接続差分

作業日 2026-10-30。**この後の訂正は [15](15-attribution-and-quantity.ja.md)：** 到着量（記録は下限）、caravan の通し番号で決めないこと（M3 の NotSent はやめた）、自分の署名による証明。

ブランチ `ws03/runreceipt-port`（ローカルだけ）。受け取った物は作業場所の外（scratchpad の別のディレクトリ）に展開し、中のスクリプトは実行していない。⑤の試験も実行していない（読んだだけ。⑤の試験の結果は⑤の報告による）。

**MOCK と本番の区別。** ③の port は今も `real: false` である。`ws04-mapped` は、③自身の追跡を④の**提案**（CONTRACTS 0.2）の言葉で表したもので、④の実行台帳ではない。④の台帳（Rust、SQLite の run store）と③の間に adapter はまだ無い。

## 1. 受領と復元

| 受領物 | SHA-256（申告と一致） | 中身の検査 | 復元した HEAD |
|---|---|---|---|
| ④ `wylls-ws04-handoff-20261030.tar.gz` | `dc5a8007…31ed04d` | SHA256SUMS：載っている `wylls-ws04-full.bundle` が**同梱されていない**（④の MANIFEST では「別の添付」）。ほかはすべて一致 | `ws04/handoff` = `2e536b6b119d8eaa4e9f4d795e856b696249a664`、tree `0a02f9e07fc7b2e3f2ea7d6ae0c5386c5da41e7a`（④の MANIFEST と一致）。incremental bundle の前提は `4cd901de` だけ。`ws04/v0.1` = `4066a1b6…`、`ws04/v0.2` = `bd415e74…` |
| ⑤ `ai05-model-api-delivery.tar.gz` | `924591c6…c871070` | すべて一致 | `claude/ai-participation-model-api` = `6cdd648cffeabd9a5125f0e788594ab643c738ac`。前提は `ba3c180b` |
| ⑤ `wylls-ws05-preserve-ba3c180b.tar.gz` | `8b3e459b…5a1b8b6` | すべて一致 | `claude/ai-participation-audit-dbzqw0` = `ba3c180b2d6c586b367cbadeb7543e00fcb4e14d`。前提は `4cd901de` |

⑤の連なり（別の空の repo で確かめた）：`4cd901de` → `7ac94cc1` → `5c6b6305` → `ba3c180b` → `21abfc59` → `ffcb2a07` → `6cdd648c`。どちらの bundle も `git bundle verify` が通る。

**基準から③の外に変更があるか：**
- ④：`workstreams/04-execution/` の外は 0 件。
- ⑤：`workstreams/05-ai-participation/` の外は 0 件。
- 共有コアへの変更は、どちらもパッチ（④は案のみ、⑤は 0001）としてだけ存在する。

**不足：** ④の `wylls-ws04-full.bundle`。incremental bundle で足りたので、③の作業には影響しない。

## 2. ③ 0005 と⑤ 0001 の照合（解決）

⑤ 0001 = `patches/0001-agent-wallet-staking-limits.patch`（⑤ `ba3c180b` の保存パッケージ）。`contract.mjs`、`gateway.mjs`、`ledger.mjs`、`policy.mjs` と、試験 1 本を変える。

| 確かめたこと（基準 `4cd901de` の使い捨ての worktree） | 結果 |
|---|---|
| 0005 → 0001、0001 → 0005 の両方の順で `git apply` | どちらも当たる。文字の上の衝突は無い |
| 両方の順でできる tree | 同じ（`f0ab2179…`） |
| 0005 + 0001 + 0007（§4）の 3 通りの順 | どれも当たり、同じ tree（`086ba5e7…`） |
| gateway の `agent-wallet-*` と `frontier-relay*`（0005 + 0001） | 107/107 |
| gateway の全試験（0005 + 0001 + 0007） | **2,539 通過・1 省略・0 失敗**（省略は Gemma のモデルファイル。⑤の報告と同じ） |
| ③の MCP 試験（0005 + 0001 + 0007 の gateway） | 54 件：53 通過・1 省略・0 失敗 |
| **実チェーンの E2E**（0005 + 0001 + 0007 の relay、`ws04-mapped` の port） | **PASS、15 記録点**（season 98）。注：同じ世界での 1 回目は、E2E のスクリプトの期待値が port によって違うことを扱っていなかったため、記録点 15 番で落ちた（§5）。直して同じ世界で再実行した |

**意味の上の重なり：** 0001 が足す拒否コード（`PerCallLimit`、`CategoryLimit`、`PolicyExpired`）は、③の境界の表（`src/budget-port.mjs`）に入れた。

- ③の試験は gateway の `ERR` と照合している。0001 を当てた gateway では 3 つとも入っていること、当てていなければ 3 つとも無いことを求める。
- 1 回目の照合で、③の試験がこの 3 つの未登録を検出した（設計どおり）。
- 0001 の `expiresAt`（許可の期限）は `#gate` の時点だけで確かめる、と⑤自身が書いている。③の接続の期限（② MOCK の上限）とは別のもので、どちらも効く。

**適用の順は④が決める**（⑤ HANDOFF-4 §6 と同じ）。③としては、どちらの順でも同じ結果になる。

## 3. ④の契約（提案 0.2）と③の対応

### 3.1 ④が③に求めること（CONTRACTS §5、③-R1〜R9）と、今の③の経路

③の今の経路：MCP → ⑤の agent wallet（`POST /f/agent/action`）→ relay → チェーン。読みは relay と herald。

| # | ④の要求 | 今の③の経路で | 不一致・不足 | 直す所（④が判断） |
|---|---|---|---|---|
| ③-R1 | 要求キーでの重複拒否と検索 | SendCaravan は (owner_tag, seq)。チェーンが seq を強制する（`caravan.rs:695`） | 施設の命令は無い（④の P3） | — |
| ③-R2 | min_slot 以降の読み、holding は精算した値 | herald の `/h/me`、`/h/caravans.json` | slot の下限を指定できない | herald／relay |
| ③-R3 | 署名を先に確定し、**署名済みのワイヤのバイト列を返す**。④が保存して同じバイト列を再送する。`valid_until` を返す | **できない**。⑤の gateway が署名して送り、③には署名と結果だけを返す（バイト列も `lastValidBlockHeight` も返さない） | **最大の不一致。** ④の Chain port は、③の MCP の経路の上には作れない。gateway／relay の層（⑤の `AgentGateway` か relay）に置く必要がある | ④⑤（共有コア） |
| ③-R4 | status は Landed{fee}/Failed{fee}/Pending/Absent/Unavailable。**Absent は、確定・欠落なしの全期間の履歴でだけ** | relay の `/f/tx` は `landed/failed/expired/unknown`。`expired` は *confirmed* の高さで決めていて、Absent の条件を満たさない。fee も返さない | **③の側を直した**（§4.1）。relay の側はパッチ 0007（§4.2） | ④（0007 の採否） |
| ③-R5 | 事前検査で拒否した物を転送しない。拒否された署名済みのバイト列も、有効期間内は着地しうると扱う | gateway の事前検査。③はバイト列を持たない | ③では扱えない（R3 と同じ） | ④⑤ |
| ③-R6 | 委任された session key。他人宛ては chain が拒否 | 満たしている。③は `NotYourPlace` で先に断り、チェーンは `WalletRequired`。**session は Citizen に 1 つで、③の MCP と⑤の自動運転は同じ代理人の鍵を使う**（⑤ HANDOFF-4 §5 と一致） | session key に命令ごとの範囲は無い（④ P6、③ 10 §3.1.1） | コア |
| ③-R7 | entity 履歴、`CaravanSent` に sig | herald の `/h/events` の行に `sig` がある。entity 履歴は使っていない | 行の `sig` が送付の署名かどうかは確かめていない（**未確認**） | herald／findex |
| ③-R8 | settle の記録に credited／lost | 無い（④の P1） | ③の `ws04-mapped` は vault を Unverifiable にしている | コア（P1） |
| ③-R9 | seq の不一致の専用コード | `BadData` | ④は必須にしていない | コア（P2） |

### 3.2 ③が④の言葉に合わせたもの（`ws04-mapped`、MOCK）

| ④の概念 | ③の写し方 | 根拠 |
|---|---|---|
| 状態（15） | 送付だけの run として：まだ試していない → `Accepted`、試した → `ShipRequested`、relay が送った → `ShipSubmitted`、着地・道中 → `InTransit`、決着 → vault は `DeliveredUnverified`、village は `Fulfilled`、lost/taken/burned → `Failed`（`DestinationChanged`/`Raided`/`LostInTransit`）、試す前に接続を取り消した → `Cancelled` | ④ STATE-MACHINE、`model.rs` |
| 保留の理由 | 結果不明 → `Indeterminate`。capability を開けない → `PortUnavailable`（**ちょうど合う理由が④に無い**。④に追加を提案：`CredentialUnavailable` など） | `model.rs` `Reason` |
| 取消の 3 段階 + 手遅れ | 試していない → `StoppingNew`、試した・送った → `AwaitingSigned{until: null}`、道中 → `Ineffective{at: InTransit}`、終端 → `Completed{effects}` | `model.rs` `CancelPhase` |
| 到着量 | vault → `delivered: null`、`Unverifiable`、`cargo_logged`。village → `RuleDerived`（holding は全量を加える）。lost/taken/burned → `KnownZero` | ④ STATE-MACHINE「到着量の判定」 |
| 費用の 4 区分 | ③は額を知らない。区分だけを示す：試していない・署名の前に断られた → なし、署名して未決 → `reserved`、着地（成功・失敗）・`NotSent` → `unconfirmed`。**`released` には決してしない**（③は Absent を証明できない）。額は `null`（0 ではない） | ④ CONTRACTS §6.2 |

④の source（`model.rs`、`store.rs`）と、この語彙の一致を試験で照合している（`WS04_ROOT` を④の木にすると動く）。

### 3.3 不一致（④に渡す）

| # | 不一致 | ③の扱い | ④に求める判断 |
|---|---|---|---|
| M1 | **R3：署名済みのバイト列と `valid_until` を③は持てない**（⑤の gateway が署名する） | 取消は `AwaitingSigned{until: null}` | Chain port を gateway／relay の層に置くか。⑤の `ActionResult` に `lastValidBlockHeight`（と必要ならバイト列）を足すか |
| M2 | relay の `expired` は Absent ではない | ③は失敗にせず、予約を数えたまま、caravan の通し番号が決める（§4.1） | 0007 の採否。Absent を証明するには、relay が送る前の `slotFloor` を記録する必要がある（0007 の試験で「記録が無いので証明できない」を確かめた） |
| M3 | ③の `NotSent`（通し番号が進まなかった）は、caravan が効かなかったことの証明であって、**費用が掛からなかったことの証明ではない**（失敗として着地した取引は通し番号を進めないが、手数料は払う） | `ws04-mapped` では `unconfirmed`。③の接続の上限（回数）は返す | 費用の区分はこれでよいか |
| M4 | village の到着量：③の local の port は `unverified`、④は `RuleDerived` | `ws04-mapped` は④に従う。local は慎重なまま | 到着量の判定は④の持ち物として、local を④に合わせるか |
| M5 | taken／burned：③の local は `unverified`、④は `KnownZero` | 同上 | 同上 |
| M6 | capability を開けない保留に合う理由が④に無い | `PortUnavailable` で写す | `Reason` に足すか |
| M7 | ④の Run は施設の使用と発送の複数段階。③の MCP の操作は発送 1 回 | 送付だけの run として写す | ③の操作を④の Run として登録する（`run_id` = ③の `requestId`）か、別の種類にするか |

## 4. ③の変更と、④向けのパッチ

### 4.1 ③の中（`ws03/runreceipt-port`）

- relay の `expired` を失敗にしない（`server.mjs`）：予約を数えたまま、結果不明として扱い、時間の後に caravan の通し番号が決める（`NotSent`）。試験 `the relay's "expired" is not proof of absence …`。
- `ws04-mapped` の port（`receipt-port.mjs`）：`WYLLS_MCP_RECEIPT_PORT=ws04-mapped`。local と同じ適合試験を通る。④の本物の adapter はまだ無い（指定すると起動しない）。
- ⑤ 0001 の拒否コード 3 つ（`budget-port.mjs`）。
- E2E：`WS03_E2E_RECEIPT_PORT=ws04-mapped` で、④の語彙を実チェーンで確かめる記録点（`ws04-vocabulary`）。取消の後の照会の期待値を port によって分けた。

### 4.2 ④向けの共有コードのパッチ（適用していない）

[patches/0007-relay-tx-detail-for-ws04.patch](patches/0007-relay-tx-detail-for-ws04.patch)：relay の `GET /f/tx/{sig}?detail=1`。

- **今までの答えは 1 バイトも変えない**（`?detail=1` が無ければ同じ。既存の試験もそのまま通る）。
- `detail` に入るもの：
  - `commitment`
  - `fee`（tx の meta から。分からなければ `null`）
  - `lastValidBlockHeight`
  - `absence: {proven, fate, why}`：⑤の `agent/fate.mjs` の `fateOf` を使う。finalized で、履歴の範囲を示せた時だけ `proven: true`。
- 試験 1 本（`frontier-relay.test.mjs`）。基準の上で 0005・0001 と、どの順でも当たる。
- **限界：** relay は送る前の `slotFloor` を記録していないので、今のままでは `proven` は true にならない。記録を足すかは④（と⑤）の判断。

## 5. E2E の 1 回目の失敗（記録）

season 98 の 1 回目は、記録点 15 番（取消の後の照会）で落ちた。

- 原因：スクリプトが「どの配達も量は `unverified`」を期待していた。これは local の port の答えで、`ws04-mapped` では village の配達が `verified`（RuleDerived）になる。
- サーバーの誤りではない。スクリプトを port によって期待値を変えるように直し、同じ世界で新しい所有者として再実行して PASS した。
- local の port での E2E は、season 97 で PASS している（14 記録点）。

## 6. 残っていること

- ④の台帳との本物の adapter（M1 と M7 の判断の後）。
- ④の full bundle（不要だが、パッケージには不足として記録する）。
- 実機（Claude Code、ChatGPT）は承認の手前で止めたまま（12 §5）。
