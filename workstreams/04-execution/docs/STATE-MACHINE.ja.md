# Run の状態機械

実装：`src/model.rs`（状態、遷移表 `allowed`、所有表 `ownership`、`CancelPhase`、`Verification`）、`src/executor.rs`（各状態の処理）。この文書はその説明であり、食い違う場合はコードとテストが正しい。

## 前提：一回のトランザクションとして巻き戻さない

Run は何十 bell にもわたり、段階ごとに別々の正本の変化が起きる（施設の使用、隊商の作成、settle）。**前の段階を取り消す命令は存在しない。** そのため、取消と期限切れは「その時点で止める」ことを意味し、止めた時点で何が起きていたかを記録する（`outcome.effects`）。

## 状態（15）

| 状態 | 日本語 | 意味 |
|---|---|---|
| `Accepted` | 受付 | 保存済み。材料を待つ |
| `Reserved` | 予約 | 材料と利用権の単位を、run store 内で予約済み |
| `FacilityRequested` | 実行要求 | 施設要求に署名し、ワイヤのバイト列を記録済み。**送信されたかどうかは不明** |
| `FacilitySubmitted` | 送信済み | 実行経路が受け取った。**確定ではない** |
| `FacilityConfirmed` | 確定 | 要求キーの正本の記録を読んだ。記録の署名が自分のもので、中身が spec と一致した |
| `ShipRequested` | 実行要求（発送） | seq を固定した SendCaravan に署名し、記録済み |
| `ShipSubmitted` | 送信済み（発送） | 実行経路が受け取った。**輸送開始ではない** |
| `InTransit` | 輸送中 | 自分の署名が着地し、記録の中身（送り元、宛先、資源、量）が spec と一致した |
| `Arrived` | 到着 | settle を観測した |
| `Fulfilled` | 履行完了 | 検証できた入荷量が依頼量以上 |
| `Partial` | 部分履行 | 検証できた入荷量が依頼量より少ない（損耗、容量） |
| `DeliveredUnverified` | 到着量未検証 | DELIVERED だが、入った量を検証できない（vault で、記録に `credited` が無い）。**全量とも部分とも扱わず、到着量 0 や全損とも扱わない**（実際の量は不明。①⑥の算入量は 0。[HANDOFF](HANDOFF.ja.md) §2） |
| `Failed` | 失敗 | 理由は `detail.reason` |
| `Cancelled` | 取消 | 署名済みの要求がすべて決着した後に、取消が完了した |
| `Expired` | 期限切れ | 同上の条件で、期限による |

**保留（held）は状態ではない**。どの状態にも重ねられる印で、自動処理を止める。理由は `WalletRequired`、`Indeterminate`、`PortUnavailable`、`Inconsistent(…)`。

## 遷移表（`model::allowed`）

| 元の状態 | 遷移先 | 条件 |
|---|---|---|
| Accepted | Reserved | 正本の在庫 − 他の run の予約 ≥ 材料、かつ利用権の残り ≥ 必要量 + 他の予約 |
| Accepted | Failed | 入荷の隊商が失われた、利用権が無い・失効した、在庫の場所が自分のものでない |
| Accepted | Cancelled / Expired | 取消・期限（この時点では何も署名していない） |
| Reserved | FacilityRequested | 署名の直前に、利用権・施設の世代・在庫をもう一度確認する。予算の範囲内で署名し、`unless_cancelled` を条件に記録してから送信する |
| Reserved | Accepted | 署名の直前の確認で在庫が足りない |
| Reserved | Failed / Cancelled / Expired | 利用権の失効・不足、施設が無い、予算切れ、取消、期限 |
| Facility* | FacilitySubmitted | 送信の応答が Accepted |
| Facility* | FacilityConfirmed | 要求キーの正本の記録を読めた。署名が自分のもので、中身が一致した |
| Facility* | Reserved | 記録が無く、**すべての attempt が決着した**（③-R4 の条件での Absent、または失敗として着地。照会不能は決着ではない） |
| Facility* | Failed | 同上で、確定的な拒否があった（事前検査での拒否は、有効期間の終わりまで保留：`pending`） |
| Facility* | Cancelled / Expired | 同上で、取消・期限 |
| FacilityConfirmed | ShipRequested | 宛先の世代が同じ、正本の在庫 ≥ 荷、この store で同じ owner の送信が飛んでいない（事前確認 + CAS の条件 `sole_owner_send`）。この条件で seq を固定し、署名し、記録してから送信する |
| FacilityConfirmed | Failed | 宛先の世代変更、正本の在庫 < 荷 |
| FacilityConfirmed | Cancelled / Expired | 取消・期限。**産出物は在庫の場所に残る**（`effects` に施設の使用が記録される） |
| Ship* | ShipSubmitted | 送信の応答が Accepted |
| Ship* | InTransit | この seq の**自分の署名**が着地した（status、または署名を名指しする `CaravanSent`）。かつ、その記録の中身が spec と一致した |
| Ship* | FacilityConfirmed | すべての attempt が決着し、何も効かなかった。または、**別の署名による `CaravanSent`** がこの seq を使った（新しい確認の後に固定し直す）。`WalletRequired` の場合は保留を付ける |
| Ship* | Failed / Cancelled / Expired | 確定的な拒否・取消・期限。すべての attempt が決着した後に限る |
| InTransit | Arrived | caravan が閉じ、settle の記録（feed または entity 履歴）を読めた |
| InTransit | Failed | caravan の所有者が変わった（take） |
| Arrived | Fulfilled / Partial / DeliveredUnverified / Failed | [到着量の判定](#到着量の判定) |

同じ状態への遷移（詳細の更新：待ち、保留、取消の段階、ポートの誤り）は、終端以外で許す。終端からはどこへも遷移しない。

## 署名済みの要求：store では止められないもの

### 何が守られ、何が守られないか

| 守られること | 仕組み | 依存先 |
|---|---|---|
| 古い snapshot や lease を失った実行者が**書き込む**こと | `(version, lease_owner, lease_epoch)` の CAS | DB |
| 古い実行者が**新しく署名する**こと | 署名の後の記録が CAS を通らなければ、送信しない | DB |
| 一つの要求キーが**二度効く**こと | 要求キー（seq、`fac:`）を正本が拒否する | 実チェーン（seq）／MOCK（`fac:`、P3） |
| **署名済みのバイト列が有効期間の後に着地する**こと | blockhash の有効期間 | 実チェーン（Solana の 151 slot）。模擬正本は同じ規則を模倣する |

| **守られないこと** | 理由 |
|---|---|
| 署名済みのバイト列を持つ古い実行者（停止から復帰したもの、別の RPC へ送ったコピー）が、**有効期間内に送信して着地させる**こと | chain は run store を見ない。送信の直前に DB を確認しても、確認と送信の間に取消や引継ぎが入りうる（`stale_bytes_sent_after_cancel_within_validity_land_and_are_reported`） |

### 取消の三段階と限界

1. **新規要求の停止**（`StoppingNew`）：取消の印を付け、version を進める。以後、新しい要求には署名しない（`unless_cancelled`）。署名済みのバイト列の再送もしない。
2. **署名済み要求の確認待ち**（`AwaitingSigned{until}`）：署名済みの attempt が有効期間（`until`）まで着地しうる。状態は `*Requested`／`*Submitted` のままにして、「取り消した」とは表示しない。
3. **取消完了**（`Completed{effects}`、状態 `Cancelled`）：すべての attempt が決着した（Absent か着地）。取消の前に着地したものがあれば、`effects` に記録する（例：`facility_used fac:r1`。材料は使われ、産出物は在庫の場所にある）。

`InTransit` 以降の取消は `Ineffective` として記録し、run は道の結果に従う（呼び戻しの命令が無い）。

**限界**：取消は、成立しうる要求を取り消せない。取消の完了は、最後の署名済みのバイト列の有効期間（最大でおよそ 151 slot）が過ぎるまで遅れうる。その間に着地した変化は、取消の完了の表示に必ず含める。

### 事前検査での拒否は終わりではない

事前検査（preflight）で拒否された要求は、その RPC からは転送されない。しかし同じ署名済みのバイト列は、有効期間内なら別の経路で着地しうる（条件が戻った場合など）。そのため、確定的な拒否でも `pending` として記録するだけにし、有効期間の終わりまで失敗にしない（`preflight_refusal_is_not_final_while_bytes_are_valid`、`preflight_refusal_fails_only_after_validity`）。

## 別の送信経路と owner の連番

store の中での owner ごとの直列化（`sole_owner_send`）は、**その store を使う実行者どうしにしか効かない**。手作業、別のサービス、別の store の実行者は、同じ owner の seq を先に使いうる。

- `(owner, seq)` が一致するだけでは、自分の送信とみなさない。自分の署名が着地したこと（status）か、自分の署名を名指しする `CaravanSent` が必要である。
- 自分の署名であっても、記録の中身（送り元、宛先、資源、量）が spec と一致しなければ、`Inconsistent` として保留にする。成功とはせず、再送もしない。
- 別の署名の `CaravanSent` がこの seq を使ったと分かれば、自分の attempt はもう効かない（program が seq を拒否する）。ただし失敗として着地しうるので、手数料は未確定（`superseded`）として残す。新しい確認からやり直す。中身が同じ送付を別の経路が先にした場合、産出物が無くなっていれば `OutputShort` で失敗する。成功とは数えない（`identical_send_by_another_route_is_not_ours`）。
- 何の記録も無く、status も使えないときは、推測しない（`Indeterminate`、`owner_and_seq_alone_prove_nothing`）。

## 到着量の判定

`CARAVAN_SETTLED` の `cargo` は**入荷量ではない**（vault は `CAP` を超える分を黙って捨てる。`proc/caravan.rs:1005`）。判定は settle の記録と規則だけで行い、**宛先の残高の差は使わない**（他の入出庫が並行するため、差から当該隊商の入荷量は分からない）。

| 場合 | 正本で起きること | 判定 | `verification` |
|---|---|---|---|
| 記録に `credited` がある（P1） | 記録どおり | 依頼量以上なら Fulfilled、少なければ Partial、0 なら Failed | Recorded |
| holding へ DELIVERED、`credited` 無し | `Accrual::add` は上限なしで全量を加える（holding.rs:296）。加算は milli 単位で、記録の cargo は整数に切り捨てた値（proc/caravan.rs:401-407 `cargo_log`） | cargo を入荷量の**下限**とする（資源ごとに 1 未満多く入っていうる）。下限が依頼量以上なら Fulfilled、少なければ Partial | RuleDerived |
| vault へ DELIVERED、`credited` 無し | 容量を超えた分は捨てられ、記録されない | **DeliveredUnverified**（`cargo_logged` は上限） | Unverifiable |
| 容量超過（`credited` あり） | 超過分が失われる | Partial | Recorded |
| 襲撃・take | caravan は襲撃者のもの。settle は別の宛先 | Failed（Raided）、0 | KnownZero |
| 襲撃・burn | 空のまま進み、cargo 0 で settle | Failed（LostInTransit）、0 | KnownZero |
| 宛先の世代変更 | outcome LOST | Failed（DestinationChanged）、0 | KnownZero |
| 占領ロック（capture-locked holding） | settle が `CapturePending` で拒否され、待つ | `InTransit` のまま。解除後に上の規則で判定 | — |
| 他の入出庫が並行 | 残高が動く | 判定に影響しない（残高を読まない） | — |

## 模擬正本の fencing の監査：実チェーンに無い機能を与えていないか

| 模擬正本（`sim.rs`）の振る舞い | 実チェーンにあるか |
|---|---|
| 有効期間（`valid_until`）を過ぎた署名を拒否する | ある（blockhash の有効期間） |
| 同じ署名の再送は一度しか効かない | ある（署名の重複排除） |
| SendCaravan の seq の不一致を拒否する | ある（`proc/caravan.rs:695`、`BadData`） |
| 他人宛ての session 送信を拒否する | ある（`WalletRequired`）。模擬正本は wallet と session を区別しない |
| 施設要求の要求キーの重複を `AlreadyDone` で拒否する | **無い**。施設の命令自体が無い（P3）。この保証は MOCK だけのもの |
| 事前検査で拒否した署名を消す | 実チェーンでは RPC が転送しないだけ。**模擬正本も、同じバイト列が後で送られれば実行する**（④は有効期間まで着地しうると扱う） |
| settle の `credited` を記録する | **無い**（P1）。`settle_without_credit` で現行の振る舞いも試している |
| 状態の全履歴を常に返す | 実チェーンでは保存期間に依存する。`status_unavailable` で欠落も試している |
| 1 つの Mutex で直列に処理する | 実チェーンは並行だが、各 tx は原子的。④の判断は tx の原子性にだけ依存し、模擬正本の直列性には依存しない（stress は複数スレッドで実行している） |
