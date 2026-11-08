# 16 V26：隊商を動かす custody の 5 命令の再生（区画の側と記録）（2026-11-08）

既存のルールは変えていない（カーネル・プログラム・ABI の番号は不変）。返却の記録・版・資源の種類・押収・NFT の権限は決めていない（④の採番待ち）。

## 0. 起点

| もの | 完全 SHA | tree |
|---|---|---|
| ④の統合候補（最新） | `claude/gallant-ride-cunptv` `af41e617218f3a93d94c7374d125ac61fd69833d` | `18663848b7262f42edfe0eefac5825f166c5895d` |
| 同、作業開始時 | `20db3313adf25481b714798759b1fdd0cb917275` | `b2304c4fa25e53bb15f1dbbffd42d6042c878957` |

`af41e617` は ⑩の 0001（V26 の単命令の再生）と 0002（`proc/custody.rs` の補助関数の `pub(crate)`。⑨ `fe2e94d0` 経由）を**取り込み済み**（確認した：`custody_replay.rs` があり、`proc/custody.rs` は ⑩の 0002 の後と同じ）。残る差分は今回の 0003・0004 だけ。

## 1. 洗い出し：5 命令の未実装部分と必要な証拠

| 命令 | プログラムがすること | 区画の側（⑩のカーネル） | それ以外 | 必要な証拠 |
|---|---|---|---|---|
| DepositLot 0xC4 | 所有者（財布）の自分の場所から隊商を出し、区画に到着枠を取る | `begin_inbound`（隊商の摩耗後の積荷で） | 経路・塔の摩耗・到着時刻・経路の州の枠（`send`、SendCaravan と同じ）、持ち物（Holding）からの支払い（V7） | 前：Citizen（財布・session・`CARAVANS`）、区画、倉、出どころ。後：区画、隊商、出どころの倉 |
| ShipLot 0xC7 | 所有者か運ぶ注文の受け手が、同じ所有者・資源の別の区画へ送る | `spend_ship`（出す区画）、`begin_inbound`（受ける区画） | 同上（経路など） | 前：Citizen、両方の区画と倉。後：両方の区画、隊商 |
| WithdrawLot 0xCC | 所有者（session 可）が自分の場所へ引き出す（普通の隊商） | `spend_ship`（`OwnPlace`） | 同上。着いた後の SettleCaravan は V23 | 前：Citizen、区画、倉、行き先。後：区画、隊商 |
| SettleCustody 0xC8 | 着いた custody の隊商の積荷を区画へ（倉が押収・閉鎖なら DestinationGone） | `finish_inbound` | 経路の州の解決（`RESOLVED_NEXT`）と襲撃の状態、手数料・家賃の送金 | 前：隊商、区画、倉（閉じていればその記録）。後：区画、隊商 |
| ReconcileLot 0xCA | 押収された倉の区画の没収、奪われた・閉じた隊商の到着枠の解放 | `forfeit`、`drop_inbound` | なし（区画と倉だけを書く） | 前：区画、倉（閉じていればその記録）、列挙した隊商（閉じていればその記録）。後：区画、倉 |

## 2. 実装したこと（既存の記録と口座の状態だけで判定できる所）

### 2.1 区画の側（patch 0003）

| 命令 | 確かめること | 違えば |
|---|---|---|
| 送る 3 命令 | 署名者が Citizen の財布か期限内の session（DepositLot は財布だけ）、隊商の番号が Citizen の `CARAVANS`、隊商の口座が署名者のその番号の隊商の住所（公開の導出 `create_with_seed`）、隊商の custody の印・資源・所有者（WithdrawLot は印なし）、積荷 ≤ 送った量で他の資源なし、倉の出どころは送った量だけ減る、WithdrawLot の行き先は署名者自身の立っている場所で名指しのもの、カーネルの段階と残った区画 | FAIL `CustodyReplayMismatch` |
| SettleCustody | 隊商が移動中・custody・到着済み、家賃の受け取りが隊商のもの、区画が隊商の行き先の区画の住所、倉の住所、倉が前にある／**入力で閉じたと示されている**（DestinationGone）、`finish_inbound` と残った区画、隊商が閉じたこと | FAIL |
| ReconcileLot | 押収（倉の世代が進んだ）なら没収と倉の数、列挙した隊商が区画の待つものであること、奪われた（印 2）か**入力で閉じたと示されている**こと、何も変わらないなら拒否、残った区画 | FAIL |

**証拠不足は PASS にしない**：前後の状態が入力にない、口座が「閉じた」と入力で示されていない（記録がないことを閉鎖とみなさない）なら UNVERIFIABLE `CustodyReplayIncomplete`。

### 2.2 記録（patch 0004、既存の種類 `frontier_abi::v2::log` だけ）

| 命令 | 照らし合わせる記録 |
|---|---|
| DepositLot | `LOT_INBOUND`（送った量・摩耗・from_lot 0）、`LOT_LOSS` Worn |
| ShipLot | `LOT_SHIPPED`（送った量・摩耗・to_lot 1・注文 id（所有者は `u32::MAX`）・運び手）、受ける区画の `LOT_INBOUND`（from_lot 1）、`LOT_LOSS` Worn |
| WithdrawLot | `LOT_SHIPPED`（to_lot 0）、`LOT_LOSS` Worn |
| SettleCustody | `LOT_SETTLED`（届いた・焼けた・行き先なし）、`LOT_LOSS` Burned、DestinationGone（倉の持ち主） |
| ReconcileLot | `LOT_LOSS` Seized（押収した者）、Raided（奪った者。印 2 の隊商の `TAKEN_BY_TAG`、閉じた隊商は 0） |

同じ種類・鍵で中身が違う記録、カーネルの出さない損失の記録は FAIL。期待する記録が見えないときは UNVERIFIABLE（記録が切れている可能性。`Log truncated` はこの検査には届かない）。

### 2.3 判定のまとめ

| 命令 | 区画・記録が一致したとき |
|---|---|
| ReconcileLot | **完全な一致**（所見なし） |
| DepositLot・ShipLot・WithdrawLot | UNVERIFIABLE：経路・塔の摩耗・到着・経路の枠は再生していない（DepositLot は持ち物からの支払いも） |
| SettleCustody | UNVERIFIABLE：経路の州の解決と襲撃の状態、手数料・家賃 |

ガードの `CustodyUnverified` も残るので、custody のシーズンは引き続き PASS にならない。ガードの文は「(V26 does not replay the caravans' routes or the records yet)」に直した（記録は一部照らし合わせるようになったが、すべてではない）。

## 3. 保留（理由つき）

| # | 内容 | 理由 | 必要なもの |
|---|---|---|---|
| H1 | 送る 3 命令の経路・摩耗・到着・経路の枠 | V23（`checks/v23_caravans.rs`）の `route`・`check_caravan`・`check_slots` が同じ規則を SendCaravan に対して持つが、**非公開**。⑩が同じものを書くと二重になり、V23 の担当の領域を変えることになる | V23 の担当（④）の同意のうえ、それらを `pub(crate)` にする差分（挙動は変えない）。同意があれば⑩が差分を出す |
| H2 | SettleCustody の経路の州の解決・襲撃の状態 | 同上（V23 の `slots_of` が非公開）。州の口座の前の状態は入力にある | H1 と同じ |
| H3 | DepositLot の持ち物（Holding）からの支払い | V7（`crate::holding`）の担当 | V7 の担当との取り決め |
| H4 | 手数料・家賃の送金（lamports） | 口座の lamports の前後を比べる必要。⑩の custody の規則ではない | ④ |
| H5 | 返却の記録（⑨の ClaimJob の `return_unused`） | 記録の種類の番号は④の採番 | ④の採番 |
| H6 | 単命令（OpenLot など）の記録（`LOT_OPENED`・`LOT_QUOTA`・`LOT_ORDER`・`LOT_REVOKED`・`LOT_CONSUMED`）の照合 | 既存の種類で可能。今回は 5 命令に絞った | ⑩の次の作業（新しい仕様は不要） |

## 4. ⑨との分担

⑨の `857a04f4`（工房の加工能力：DepositToJob・ClaimJob、tag 0xF6・0xF9）は区画を ⑩の `consume`・`return_unused` で動かすが、今回の 5 命令（隊商）とは重ならない。⑨は `frontier-node/crates/verify` の `holding.rs` だけを変え、⑩の `v26_custody.rs`・`codes.rs`・`mod.rs`・試験は変えていない（確認した）。⑨の命令の V26 での再生は⑨の命令の形が決まった後（ドキュメント 15 §7）。

## 5. 試験（鍵の生成・導出・署名なし。固定 seed もなし）

`tests/custody_replay_caravans.rs`（11 件）：状態は固定のバイト列とカーネルの出力、住所は公開の導出（`create_with_seed`）、`verify()` を通す試験は記録済みの取引のメッセージに命令を入れ（署名し直さない）、記録は `Program data:` の行として入れる。

| 試験 | 確かめたこと |
|---|---|
| `what_the_kernel_writes_replays_to_the_lots_side` | 7 例（Deposit・Ship・Withdraw・Settle・Reconcile 3 種）が期待どおり（送る・精算は UNVERIFIABLE の理由つき、調停は一致） |
| `a_lot_one_unit_off_is_a_mismatch` | 区画の HELD が 1 単位違う、受ける区画の到着枠が違う：FAIL |
| `the_caravan_a_send_left_is_checked` | 積荷が多い、印が違う、番号が Citizen の次でない、隊商の住所が違う：FAIL。隊商の後の状態がない：UNVERIFIABLE |
| `a_send_the_program_refuses_is_a_mismatch` | session の預け入れ、出どころの倉が減らない、session で別の区画へ、別の所有者の区画、持つより多く、自分のものでない行き先：FAIL |
| `a_settlement_the_program_refuses_is_a_mismatch` | 到着前、custody でない、家賃の受け取り・区画の住所が違う、隊商が閉じない：FAIL |
| `a_settlement_to_a_closed_vault_delivers_nothing_and_an_unknown_one_is_not_judged` | 閉じたと示された倉：DestinationGone で一致。それなのに届けた：FAIL。入力にも閉鎖にもない倉：UNVERIFIABLE |
| `a_reconciliation_the_program_refuses_is_a_mismatch` | まだ custody の隊商（InTransit）、待っていない隊商、何も変わらない、押収で倉の数が変わらない：FAIL。列挙した隊商が入力にない：UNVERIFIABLE |
| `missing_evidence_is_never_a_fail` | どの例でも、どの口座の前後を除いても FAIL にならない |
| `the_records_are_the_kernels` | どの記録を除いても UNVERIFIABLE、1 単位変えると FAIL、余分な損失の記録は FAIL |
| `verify_replays_a_landed_reconciliation_and_fails_a_tampered_one` | `verify()` を通して：記録つきの調停は再生の所見 0 件（完全な一致）、区画を変えるとその取引に FAIL 1 件 |
| `verify_keeps_a_settlement_unverifiable_when_its_lot_side_matches` | `verify()` を通して：記録つきの精算は理由つきの UNVERIFIABLE 1 件 |

**変異 21 件をすべて検出**（区画の側 15・記録 6）：積荷を送った量とみなす、番号を見ない、隊商の住所を見ない、session の規則を見ない、出どころの減りを見ない、受ける区画を比べない、行き先の持ち主を見ない、到着を見ない、閉鎖を不明とみなす、倉がいつもあるとみなす、custody の隊商を奪われたとみなす、変化なしを許す、没収の倉を比べない、開いた隊商を許す、部分一致を完全一致とする、記録の中身を比べない、損失を比べない、見えない記録を FAIL にする、摩耗の損失を落とす、奪った者を 0 にする（試験の奪った者に 0 でない tag を入れて検出）、行き先なしの持ち主を変える。

| 起点 | 実行した試験 | 結果 |
|---|---|---|
| `20db3313` + 0001〜0004（`915e5e15`） | permutation-frontier（既定 110、`custody-preview` 111、`nft-experimental` の check）、`frontier-node` の check、verify の `custody` 6・`custody_history` 8・`custody_replay` 10・`custody_replay_caravans` 11・`custody_state` 7・`new_bands` 10・lib の `v0_` 1、stable の clippy `-D warnings`、stable の rustfmt | すべて通過 |
| `af41e617` + 0003・0004（`8199dc35`） | `frontier-node` の check、verify の `custody` 6・`custody_history` 8・`custody_replay` 10・`custody_replay_caravans` 11・`custody_state` 7・`new_bands` 10・lib の `v0_` 1、stable の clippy `-D warnings`、stable の rustfmt | すべて通過 |

実行していない：LiteSVM・SBF・`tamper.rs`・`record.rs`・`coverage.rs`・`fixtures.rs`・`tests/common` の `world()` など、鍵の生成・導出・署名を伴うもの。

## 6. ④への適用方法

`af41e617` の上で `git am workstreams/10-custody/patches-candidate/0003-*.patch 0004-*.patch`（`sha256sum -c SHA256SUMS`）。結果は `6e50cc75…`、`8199dc35…`（tree `fd033ff2b1807ccfc876ff81706d2930588a5556`）。または⑩の担当ブランチの merge の第 2 親として保存した commit を cherry-pick。変えるのは `frontier-node/crates/verify` の `checks/v26_custody.rs` と試験だけ（`codes.rs`・`mod.rs` は変えない）。確認：`cargo test --locked -p verify --test custody --test custody_state --test custody_history --test custody_replay --test custody_replay_caravans`（42 件）。

## 7. 追補：16576826 の上の 0005（2026-11-08）

④の統合候補 `16576826084a8ea7bd6b12b845d50b97f3d14904` は⑩の 0001〜0004 を含む（`v26_custody.rs`・`custody_replay_caravans.rs` の blob が⑩のものと同じであることを確認した）。その上に `patches-candidate/0005`：commit `0075d356ba519bdf2af80843b30db71e71725c4b`（tree `79e331928a97e25f8b406774284939d27308a185`）。④の先端 `4d44f021` にも `git apply --check` で当たる（その間の commit は⑩のファイルに触れていない）。

| 変えたこと | 前 | 後 |
|---|---|---|
| 単命令の記録 | OpenLot・SetLotQuota・SetLotOrder・RevokeLotOrder・ConsumeLot は区画と倉が一致すれば所見なし（記録は見ていない） | `LOT_OPENED`・`LOT_QUOTA`・`LOT_ORDER`（受け手の tag はその Citizen から）・`LOT_REVOKED`（カーネルが解放した量）・`LOT_CONSUMED` を照らし合わせ、区画の `LOT_LOSS` がないこと。記録が見えなければ UNVERIFIABLE（完全な一致には記録が要る）。CloseLot の CLOSE（鎖と lamports）は比べない |
| 矛盾する記録 | 同じ種類・鍵の記録が 2 つあり、片方が一致すれば通っていた | FAIL（プログラムは 1 命令に 1 つ） |
| 住所 | 区画・倉の住所を見ていなかった：同じ状態を別の口座に置いても一致した（**欠陥**） | 区画は `addr::lot`、倉は `addr::vault`（公開の導出）、単命令の倉は区画の倉、OpenLot の区画は新しい区画の住所、運ぶ注文の宛先と預け入れの出どころの倉も（プログラムの確認と同じ） |
| 下がった CONSUMED | 履歴の検査は通し、V26 の所見は何も出なかった（ガードの痕跡だけ） | `CustodyHistoryUnexplained`（UNVERIFIABLE）：「CONSUMED fell by …: a return of unused goods, which no record shows yet」。返却の記録の種類は④の採番待ち（決めていない） |

試験（鍵の生成・導出・署名なし、固定 seed なし）：`custody` 6・`custody_history` 9・`custody_replay` 14・`custody_replay_caravans` 13・`custody_state` 7（49 件）、`new_bands` 10、lib の `v0_` 1、`frontier-node` の check、stable の clippy `-D warnings`、rustfmt：すべて通過（16576826 + 0005）。変異 7 件（区画の住所・倉が区画のもの・二重の記録・下がった CONSUMED の注記・新しい区画の住所・隊商の区画の住所・単命令の記録）をすべて検出。

④へ：V23 の `route`・`check_caravan`・`check_slots`・`slots_of` を `pub(crate)` にするかは引き続き④の判断（§3 H1・H2）。⑩は V23 のファイルを変えていない。

## 8. 追補：c260c438 の上の 0006（送る 3 命令の経路、2026-11-08）

④が `c260c438` で V23 の `route`・`check_caravan`・`check_slots`・`slots_of`・`worn_cargo`・`Routed` を `pub(crate)` にした（意味は変えていない。H1 の解消）。その上に `patches-candidate/0006`：commit `3fd1db24dc51b028945cbe78b32c54977bd6e95c`（tree `c4e78493362a7fffde805edb6e9e041415cde26b`）。④の先端 `bb41fc0d` にも当たる（その間の verify の変更は V27 だけ）。

DepositLot・ShipLot・WithdrawLot を、proc::custody の `send`（SendCaravan と同じ）として判定する：手数料が `CARAVAN_FEE` 以上、最初の経路の州が出発地の州（公開の住所）、V23 の `route`（経路の州の前の状態・Citizen の faction・Season の stances による `Walker::of`）、塔の摩耗、各区間の枠（`check_slots`）、Caravan（`check_caravan`：持ち主・番号・faction・出発地・行き先・送った積荷の摩耗後・手数料・出発・到着・最後の枠の鐘）、Citizen の隊商の番号が 1 進むこと。

| 結果 | 判定 |
|---|---|
| 区画の側・記録・経路がすべて一致 | **完全な一致**（所見なし）。持ち物（Holding）からの預け入れは UNVERIFIABLE（支払いは V7） |
| 経路が規則と違う | FAIL `CustodyReplayMismatch` |
| Season・経路の州の前後・出どころ・Citizen の後が入力にない | UNVERIFIABLE「the route is not judged: …」。既定値で補わない |

SettleCustody の経路の州の解決・襲撃・手数料・家賃、預け入れの持ち物からの支払いは引き続き UNVERIFIABLE（④の (b)：共有で済むものではない。州の条件の写しは設計を④に送ってから）。

試験（鍵の生成・導出・署名なし）：lib の `send_route_tests` 3 件（一つの州の中の ShipLot。歩みが区間の枠を書く：完全な一致／到着が 1 秒遅い・枠がない・番号が進まない・行き先に着かない経路・手数料が足りない・最初の州が違う：FAIL／Season・州の前後・Citizen の後がない：判定しない）。隊商の試験の fixture は有効な手数料と州の住所に直した。`custody` 6・`custody_history` 9・`custody_replay` 14・`custody_replay_caravans` 13・`custody_state` 7、lib の v26・v23・v24・v0 13、`new_bands` 10、`frontier-node` の check、stable の clippy、rustfmt：すべて通過（c260c438 + 0006）。変異 8 件（Caravan を見ない・枠を見ない・番号を見ない・手数料を見ない・最初の州を見ない・Season の欠落を見ない・経路の誤りを証拠不足とする・枠の後の欠落を見ない）をすべて検出。
