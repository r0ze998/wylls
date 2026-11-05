# 02 引き渡し契約（⑨・④向け）：保管・輸送・利用の最小基盤

基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`。この文書は**提案**です。番号（命令タグ、口座種別、エラー番号、ログ種別）は 4cd901de で空いている次の番号を仮に置いたもので、割り当ては④が決めます。カーネル（`custody/src/lot.rs`、`custody/src/layout.rs`）とモデル（`custody/src/model/`）は実装・試験済み、プログラムへの組込みは [patches/](patches/) の差分案です（[04-results.ja.md](04-results.ja.md) に何を実行したかを分けて書く）。

## 0. 一言で

- **区画（Lot）**：所有者 A の、一つの資源の、ある倉（その世代）にある物。倉の `STORES`（倉の持ち主の一般在庫）とは**別の口座**に記録する。S1 の命令で倉を使うもの（SendCaravan の出発元、配達、CloseVault）は `STORES` しか読まないので、保管者 B の通常在庫・生産・売却・別の貸出に混ざらない。
- **保管の隊商（custody caravan）**：既存の Caravan 口座に「保管品」印を付けたもの。隊商は運ぶ人（運搬者 C）のもので、国・塔・柵・襲撃・護衛は C の国で扱う。積荷は A のもので、届く先は A の区画だけ。
- **注文（Order）**：区画の中の予約枠。運搬の許可（ship）と、加工への消費の許可（use）。**予約（注文を出す）と実物の移動（発送・消費）を分ける**二段階方式。
- 初期は **鉱石のみ**（`ENABLED_RESOURCES = 1 << Ore`）。NFT・市場・通貨・手数料・保険・貸付・担保は追加しない。

## 1. 五つの役割をどこに書くか

| 役割 | 記録場所 | 権限の確かめ方 |
|---|---|---|
| 所有者 | `Lot.OWNER_CITIZEN` / `OWNER_TAG`、隊商の `CUSTODY_OWNER_TAG` | 署名した Citizen の鍵と一致 |
| 保管者 | 倉の `OWNER_CITIZEN`（**毎回倉から読む**。区画の `CUSTODIAN_TAG` は記録用） | 倉の持ち主の財布署名 |
| 運搬者 | 隊商の `OWNER_CITIZEN` / `FACTION`（S1 と同じ）、運搬注文の `GRANTEE` | 注文の受け手の財布署名 |
| 利用者 | 利用注文の `GRANTEE`、`PURPOSE` | 注文の受け手の財布署名 |
| 所在 | 区画の倉（P,Q,tile）と `VAULT_GEN`、または区画の `INBOUND`（向かってくる隊商） | 倉の世代が区画と同じこと |

## 2. データ形式

### 2.1 Lot（新しい口座。576 B、ABI v2 の chained 形式）

種別（仮）：AccountKind 23、EntityKind 13（4cd901de で次に空いている番号）。アドレスの seed：`cl ‖ hex(P i16 ‖ Q i16 ‖ tile u8 ‖ gen u8 ‖ owner_tag u64 ‖ resource u8)`（生の鍵 15 B、seed 32 B ちょうど。Season PDA の `init_with_seed`、倉の `va` seed と同じ作り方）。**倉の世代を seed に含める**ので、押収後（`GEN += 1`）に同じ所有者のための区画を開いても古い区画と別の口座になる。

| 欄 | Off | 型 | 意味 |
|---|---|---|---|
| header | 0 | 64 | chained ヘッダ（MAGIC `PSF1CLOT`） |
| P, Q, TILE | 64, 66, 68 | i16, i16, u8 | 倉の場所 |
| VAULT_GEN | 69 | u8 | 開いたときの倉の世代。違えば押収済み |
| RESOURCE | 70 | u8 | `Resource`（初期は Ore=3 のみ） |
| STATE | 71 | u8 | 0 なし、1 開、2 没収済み |
| OWNER_CITIZEN | 72 | [u8;32] | 所有者 |
| OWNER_TAG | 104 | u64 | 所有者の `citizen_tag` |
| CUSTODIAN_TAG | 112 | u64 | 開いた時の保管者（記録用） |
| QUOTA | 120 | i64 | 保管者が約束した容量（milli） |
| HELD | 128 | i64 | 保管中（milli） |
| IN_TOTAL / OUT_TOTAL / CONSUMED / FORFEITED | 136–160 | i64×4 | 累計（保存則用） |
| NONCE | 168 | u32 | 注文を出すたびに +1（再送・古い要求の拒否） |
| OPENED_BELL | 172 | u32 | |
| ORDERS[4] | 176 | 64 B×4 | 注文枠（下表） |
| INBOUND[4] | 432 | 24 B×4 | 向かってくる隊商（下表） |
| RENT_TO | 528 | [u8;32] | 閉じた時の rent の返却先 |
| RSV | 560 | 16 | 予約 |

注文（64 B）：`KIND u8`（0 空、1 運搬、2 利用）、`PURPOSE u16 @2`、`ID u32 @4`（設定時の NONCE）、`EXPIRES_BELL u32 @8`（この鐘以後は無効）、`DST place @12`（8 B、運搬の宛先の倉と世代）、`GRANTEE [u8;32] @20`、`QTY_LEFT i64 @56`（予約の残り）。

到着予定（24 B）：`CARAVAN_TAG u64`、`SEQ u32 @8`、`LIVE u8 @12`、`QTY i64 @16`（塔の摩耗後に積んだ量）。

### 2.2 既存口座の改定（口座は大きくしない。予約領域から取る）

| 口座 | 欄 | Off | 意味 |
|---|---|---|---|
| Vault（512 B、`RSV @232` 280 B から） | `CUSTODY_QUOTA [i64;8]` | 232 | 区画に約束した容量の合計。**`STORES[r] + CUSTODY_QUOTA[r] ≤ CAP`** |
| | `CUSTODY_LOTS u16` | 296 | 開いている区画の数（CloseVault は 0 を要求） |
| Caravan（320 B、`RSV @296` 24 B 全部） | `CUSTODY u8` | 296 | 0 通常、1 保管品（A の区画行き）、2 襲撃で奪われた保管品 |
| | `CUSTODY_RESOURCE u8` | 297 | |
| | `CUSTODY_OWNER_TAG u64` | 304 | 積荷の所有者 |
| | `TAKEN_BY_TAG u64` | 312 | 奪った者の `citizen_tag`（J2 で `OWNER_TAG` は運搬者の seed のまま残るため、別に要る） |

Vault の `RSV` は契約で「stage 2: shares」用とされている。札（持ち分）を後で入れる余地は 280−66 = 214 B 残る。

## 3. 状態遷移

### 3.1 区画

```
            OpenLot(保管者)                    ReconcileLot(誰でも, 倉の GEN ≠ VAULT_GEN)
  (なし) ─────────────────▶ 開 ──────────────────────────────────────▶ 没収済み
                            │  ▲                                         │
          CloseLot(所有者か │  │ SetLotQuota / 預入 / 注文 / 発送 / 消費   │ CloseLot(誰でも,
          保管者, 空のとき) ▼  │                                         ▼  到着予定なし)
                          (閉) ◀───────────────────────────────────── (閉)
```

- 「空」＝ `HELD = 0`、到着予定なし、有効な注文なし。
- 押収（SeizeVault）は区画の口座に触れない（何個あるか分からないため）。区画は**倉の世代が違う時点で凍結**され（`Forfeited` で全操作拒否）、ReconcileLot で没収が**確定**する。

### 3.2 注文（区画の中）

```
  空 ──SetLotOrder(所有者, NONCE 一致, 利用可能 ≥ 量)──▶ 有効(QTY_LEFT)
  有効 ──発送/消費(受け手, 量 ≤ QTY_LEFT)──▶ 有効(減る) … 0 で空
  有効 ──RevokeLotOrder(所有者)──▶ 空（残りの予約を解放）
  有効 ──鐘が EXPIRES_BELL に達する──▶ 期限切れ（予約は自動で消える。番人不要）
  有効 ──ReconcileLot の没収──▶ 空（無効）
```

**利用可能 = HELD − 有効な注文の QTY_LEFT の合計**。注文を出す時点で利用可能を超えれば拒否するので、同じ物を二つの依頼に確保できない。所有者自身の発送も利用可能の範囲だけ。

### 3.3 保管の隊商

```
 DepositLot(所有者: 一般在庫→区画) ┐
 ShipLot(所有者 or 運搬者: 区画→区画)┴─▶ 移動中(CUSTODY=1)  … 宛先区画の INBOUND に予約
   移動中 ──(鐘の始めに敵がいる)──▶ 襲撃中（不明）
   襲撃中 ──焼く──▶ 移動中（積荷 0）
   襲撃中 ──奪う(J2)──▶ CUSTODY=2, 持ち主=襲撃者 ──SettleCaravan──▶ 襲撃者の一般在庫
   移動中 ──到着・SettleCustody──▶ 宛先区画の HELD（倉が押収済みなら DestinationGone の損失）
   CUSTODY=2 または閉じた ──ReconcileLot(宛先区画)──▶ 到着予定を消し Raided の損失
 ShipLot(所有者: 区画→自分の村/倉) ─▶ 通常の隊商（A のもの）→ SettleCaravan で A の一般在庫
```

### 3.4 物の状態の区別

| 区別 | 条件 | 動かせる者 |
|---|---|---|
| **保管** | 開いた区画の HELD（予約分を含む） | 所有者、注文の受け手（範囲内） |
| **輸送中** | CUSTODY=1 の隊商、到着前、襲撃なし | だれも（S1 の隊商は呼び戻せない） |
| **不明** | 襲撃が開いて未決定／到着済みで未精算／奪われて区画が未照合 | だれも（精算・照合で確定する） |
| **凍結** | 倉が押収され区画が未照合 | だれも（照合は誰でも可）。**期間の切替（戦期の終了など）は凍結の理由にならない**（[06](06-continuity.ja.md)） |
| **損失確定** | `CUSTODY_LOSS` 記録（原因・量・相手） | — |

損失の原因：`Worn`（塔の摩耗、出発時）、`Burned`（焼かれた）、`Raided`（奪われた、相手＝襲撃者）、`DestinationGone`（宛先が押収済み、相手＝新しい持ち主）、`Seized`（区画の倉が押収、相手＝押収者）。**取り戻せない物を記録なしに消すことはない。**

## 4. 命令（新設 11、既存の改定 4）

[patches/](patches/) の実装に合わせた表です（口座表は `frontier-abi/src/v2/prologue.rs` の `accounts_of`、データは `v2/ix.rs`）。P は S1 の player prologue `[actor s] [payer s,w] [season r] [citizen w]`。量は整数単位（u32、×1,000 で milli）。

| タグ（仮） | 命令 | 署名 | 口座 | 内容 |
|---|---|---|---|---|
| 0xC1 | OpenLot(resource, quota) | 保管者・財布 | P + `[vault w] [owner_citizen r] [lot w] [system]` | 区画を作る。所有者≠保管者。`STORES + CUSTODY_QUOTA + quota ≤ CAP` |
| 0xC2 | SetLotQuota(quota) | 保管者・財布 | P + `[vault w] [lot w]` | 容量の変更。`HELD + 到着予定` 未満には下げられない |
| 0xC3 | DepositLot(seq, qty, steps, path, fee) | 所有者・財布 | P + `[src w] [vault r] [lot w] [caravan w] [system] [path_province w ×1..4]` | 自分の村か倉の一般在庫から区画へ。到着予定の容量を予約し、CUSTODY=1 の隊商（所有者が運ぶ）を作る |
| 0xC4 | SetLotOrder(slot, nonce, kind, qty, expires_bell, dst_p, dst_q, dst_tile, dst_gen, purpose) | 所有者・財布 | P + `[vault r] [lot w] [grantee_citizen r] [dst_vault r]` | 予約。運搬の宛先は別の倉（その世代、いま立っているもの）。利用注文では `dst_vault` を読まない。期間は最大 `MAX_ORDER_BELLS` |
| 0xC5 | RevokeLotOrder(slot, id) | 所有者（session 可） | P + `[lot w]` | 取消し。狭めるだけなので session 鍵でも可 |
| 0xC6 | ShipLot(seq, slot, id, qty, steps, path, fee) | 所有者（`slot = 0xFF`）か運搬注文の受け手・財布 | P + `[vault w] [lot w] [dst_vault r] [dst_lot w] [caravan w] [system] [path_province w ×1..4]` | 区画→同じ所有者・資源の別の区画。署名者の隊商（CUSTODY=1）、宛先区画に到着予定を予約 |
| 0xC7 | SettleCustody(beneficiary) | 誰でも | `[fee_payer s] [season] [caravan w] [dst_vault r] [lot w] [beneficiary w] [rent_to w] [path_province r ×1..4]` | 到着後・全鐘解決・襲撃なし：区画へ。倉が押収済みなら損失記録。手数料と rent は SettleCaravan と同じ。隊商を閉じる |
| 0xC8 | ConsumeLot(slot, id, qty, purpose) | 利用注文の受け手・財布 | P + `[vault r] [lot w]` | 消費。⑨は自分の加工命令の中で同じカーネル関数を呼ぶ（§7） |
| 0xC9 | ReconcileLot | 誰でも | `[fee_payer s] [season] [vault w] [lot w] [caravan r ×0..4]` | 押収後の没収、奪われた（または閉じた）隊商の到着予定の消去。何も変わらなければ拒否 |
| 0xCA | CloseLot | 所有者か保管者（開）、誰でも（没収済み） | P + `[vault w] [lot w] [rent_to w]` | 空の区画を閉じる（`CLOSE` を記録） |
| 0xCB | WithdrawLot(seq, qty, dst_kind, dst_p, dst_q, dst_at, dst_gen, steps, path, fee) | 所有者（session 可） | P + `[vault w] [lot w] [dst r] [caravan w] [system] [path_province w ×1..4]` | 区画→所有者自身の村か倉。**通常の隊商**（所有者のもの）で、SettleCaravan でそこの一般在庫へ |

ShipLot と WithdrawLot を分けたのは、宛先の口座の種類（Lot か Holding/Vault か）が違い、口座表の型を一つに決めるため。

既存の改定：

| 命令 | 改定 |
|---|---|
| SettleCaravan (0xB2) | `CUSTODY=1` の隊商を拒否（新エラー `CustodyCaravan`）。倉への配達は `CAP − CUSTODY_QUOTA` まで（区画の容量を一般在庫が食わない） |
| RaidCaravan / DefaultRaid (0xB3, 0xB6) | 奪うとき `CUSTODY 1→2`、`TAKEN_BY_TAG` に襲撃者。焼くときは変えない |
| CloseVault (0xB5) | `CUSTODY_LOTS = 0` かつ `CUSTODY_QUOTA` が全部 0 を要求（保管者は預かり品の上で倉を閉じられない） |
| SeizeVault (0xB4) | 変更なし（区画は世代の不一致で凍結し、照合で没収） |

**なぜ S1 の贈与隊商にそのまま載らないか**（コードを読んだ結果）：SendCaravan の出発元は署名者自身の場所の一般在庫で（`s.owner != citizen` は `NotOwner`）、SettleCaravan は積荷を宛先の一般在庫へ足す（倉なら `STORES`）。このため (1) 他人の倉にある A の物を出す命令がない、(2) 届いた物は宛先の持ち主のものになる、(3) 運ぶ人と物の持ち主が同じ欄（`OWNER_CITIZEN`）。区画（新しい会計区分）、隊商の保管品印、保管品専用の精算が要る。

## 5. 署名の要約

- **財布が要る**：保管者の OpenLot・SetLotQuota、所有者の DepositLot・SetLotOrder・他人の区画への ShipLot、運搬者の ShipLot、利用者の ConsumeLot。S1 の「他人への送りは財布」（§3.3 plan §1-11）と同じ考え方：盗まれた session 鍵では他人に物を渡せない。
- **session 鍵でよい**：所有者の RevokeLotOrder（狭めるだけ）、所有者が区画から自分の場所へ引き出す ShipLot（自分の場所間の移動と同じ）。
- **誰でも**：SettleCustody、ReconcileLot、没収済み区画の CloseLot（keeper の仕事）。
- **再送**：DepositLot と ShipLot は `seq = Citizen.CARAVANS` を要求（SendCaravan と同じ）、SetLotOrder は `nonce = Lot.NONCE` を要求。同じ要求を二度送ると二度目は `Stale`。精算は状態で一度きり。

## 6. 保存則

区画ごと（どの段階でも、`Lot::balanced`）：

```
IN_TOTAL = HELD + OUT_TOTAL + CONSUMED + FORFEITED
有効な注文の QTY_LEFT の合計 ≤ HELD
HELD + 到着予定の合計 ≤ QUOTA          （開いている区画）
Σ 区画の QUOTA = 倉の CUSTODY_QUOTA、開いている区画の数 = CUSTODY_LOTS
STORES + CUSTODY_QUOTA ≤ CAP          （OpenLot・SetLotQuota が守る）
```

所有者ごと（ログと口座から、`World::custody_balance`）：

```
Σ 預け入れ（出発時の量）
  = Σ HELD + Σ 到着予定 + Σ 引き出し（自分の場所へ出した量）+ Σ 消費
    + Σ 損失（Worn + Burned + Raided + DestinationGone + Seized）
```

量は milli 単位、移動は整数単位（1,000 の倍数）に限る。塔の摩耗は S1 の `structure::wear_i64`（損失は切り捨て、残りは切り上げ）をそのまま使う。

## 7. ⑨（加工）への接続

- ⑨の加工命令が「A の区画の鉱石を使う」場合、その命令の中で `custody::consume(&vault, &mut lot, &user, slot, id, qty, purpose, bell)` を呼ぶ（同じトランザクション、同じ口座の書込みなので原子的）。区画と倉の口座を⑨の口座表に加える。
- `PURPOSE`（u16）の番号は⑨が決める。0 は「どの加工でも」。
- **できた物の持ち主は⑨の決定事項**。この基盤は消費までを保証する。所有者 A に戻すなら、⑨側で「A の区画へ入れる」関数が要る（`begin_inbound` / `finish_inbound` と同じ保存則で、`IN_TOTAL` に加える新しい入口。今回は作っていない）。
- 物理的な位置：区画は倉にあり、工房は村にある。加工のためにまず区画から工房のある場所へ運ぶか、倉の区画から直接使えるかは⑨の決定。

## 8. イベント（CqKind 104–112、ハッシュ連鎖は既存の `cqlog::emit`）

| 種別 | キー | 内容（payload） | 連鎖する口座 |
|---|---|---|---|
| LOT_OPENED 104 | 区画の生の鍵 15 B | custodian_tag 8、quota 8 | Citizen（保管者）、Vault、Lot |
| LOT_QUOTA 105 | 区画 15 B | quota 8 | Vault、Lot |
| LOT_INBOUND 106 | 隊商 key（tag 8 ‖ seq 4） | 宛先区画 15、sent 8、worn 8、from_lot 1（0 一般在庫、1 区画） | Lot（宛先） |
| LOT_SHIPPED 107 | 隊商 key | 出発区画 15、sent 8、worn 8、to_lot 1（0 は引き出し）、order_id 4（所有者は `u32::MAX`）、carrier_tag 8 | Lot（出発） |
| LOT_SETTLED 108 | 隊商 key | 区画 15、delivered 8、burned 8、dest_gone 8 | Lot |
| LOT_ORDER 109 | 区画 15 B | slot 1、id 4、kind 1、grantee_tag 8、qty 8、expires_bell 4、dst 8、purpose 2 | Lot |
| LOT_REVOKED 110 | 区画 15 B | slot 1、id 4、released 8 | Lot |
| LOT_CONSUMED 111 | 区画 15 B | id 4、user_tag 8、qty 8、purpose 2 | Lot |
| LOT_LOSS 112 | 区画 15 B | cause 1、qty 8、to_tag 8、caravan_tag 8、caravan_seq 4 | Lot（`Seized` のときは Vault も） |
| （CLOSE、M1 の種別） | `[23] ‖ 区画 15 B`（16 B の CLOSE key） | 既存の CLOSE と同じ | Lot |

隊商そのものの記録は S1 のまま：DepositLot・ShipLot・WithdrawLot は SendCaravan と同じ `CARAVAN_SENT` を出し（Citizen、出発元、Province、Caravan に連鎖）、襲撃は `CARAVAN_RAIDED`、SettleCustody は `LOT_SETTLED` と隊商の `CLOSE` を出す（`CARAVAN_SETTLED` は出さない。宛先の一般在庫に入ったと読まれないため）。

モデルの `Event`（`custody/src/model/mod.rs`）がこの内容をそのまま持つ。

## 9. エラー

M1 の 99 が既に使われているので、新しい番号は **94–98 の5つ**だけにし（`CqError` は 62 から連番、M1 と重ならないことを試験が確かめる）、残りは既存の番号に寄せました。カーネルの `CustodyError` からの対応（`proc/custody.rs` の `cerr`）：

| カーネル | プログラムの番号 |
|---|---|
| `Capacity` | **94 `CustodyCapacity`**（新） |
| `NoSlot` | **95 `CustodyNoSlot`**（新） |
| `Expired` | **96 `OrderExpired`**（新） |
| `Forfeited` | **97 `LotForfeited`**（新） |
| `NotEmpty` | **98 `LotNotEmpty`**（新。区画のある倉の CloseVault もこれ） |
| `NotAuthorized` | `NotOwner`（M1） |
| `WalletRequired` | `WalletRequired`（81） |
| `Insufficient` | `Insufficient`（M1） |
| `InTransit` | `CaravanEarly`（83、keeper は待つ） |
| `State` | `AlreadyDone`（M1） |
| `Resource` / `Quantity` / `Order` / `Stale` / `SelfDealing` | `BadData`（M1。SendCaravan の `seq` 違いと同じ） |
| 保管品の隊商を SettleCaravan に、通常の隊商を SettleCustody に | `BadAccount`（M1） |

99 より後に番号を足すかどうかは④の判断です。

## 10. ④（統合）へ：コア以外に必要なこと（未実装）

1. **検証器（frontier-node/crates/verify）**：新しい検査（V26 custody）でカーネルを再実行。改ざん分類の案：保管品を一般在庫へ精算（SettleCaravan に CUSTODY=1）、署名なしに HELD が減る、予約超過、押収なしの没収、記録のない損失、到着予定を超える容量。
2. **keeper**：到着後の SettleCustody（SettleCaravan と同じ条件）、`CARAVAN_RAIDED` の take が CUSTODY の隊商なら宛先区画の ReconcileLot、`VAULT_SEIZED` のあと、その倉の区画すべての ReconcileLot。
3. **herald**：区画の一覧（倉ごと・所有者ごと）と §3.4 の区別。画面は区画口座と隊商口座の状態から区別を出し、表示名を変えるだけの模擬にしない。
4. **relay**：新タグの分類と、財布が要る命令の判定。
5. **予算**：CU・口座数・データ長の測定（SBF ビルドで）。
6. **ルールセットのハッシュ**：`custody::write_tables` を S1 のハッシュに入れるかどうか（入れると S1 のハッシュが変わる）。
