# Run の状態機械

実装：`src/model.rs`（状態、遷移表 `allowed`、所有表 `ownership`）、`src/executor.rs`（各状態の処理）。この文書はその説明であり、食い違う場合はコードとテスト（`every_state_has_an_ownership_row_and_terminal_states_are_final`）が正しい。

## 前提：一回のトランザクションとして巻き戻さない

Run は何十 bell にもわたる。途中の段階は、それぞれ別の canonical な変化になる（施設の使用、隊商の作成、settle）。**前の段階を取り消す命令は存在しない**（施設の産出を戻す命令も、隊商を呼び戻す命令もない）。そのため、取消と期限切れは「その時点で止める」ことを意味し、止めた時点で資源がどこにあるかを明記する（下の所有表）。

## 状態

| 状態 | 日本語 | 意味 | 外部への作用 |
|---|---|---|---|
| `Accepted` | 受付 | 保存済み。材料を待つ | なし |
| `Reserved` | 予約 | 材料と利用権の単位を、run store 内で予約済み | なし |
| `FacilityRequested` | 実行要求 | 施設要求に署名し、journal に記録済み（`intent`）。**送信されたかどうかは不明** | 送信前後 |
| `FacilitySubmitted` | 送信済み | 実行経路が受け取った。**確定ではない** | 着地待ち |
| `FacilityConfirmed` | 確定 | 要求キーで正本を読み、施設が使われたことを確認した | — |
| `ShipRequested` | 実行要求（発送） | seq を固定した SendCaravan に署名し、journal に記録済み | 送信前後 |
| `ShipSubmitted` | 送信済み（発送） | 実行経路が受け取った。**輸送開始ではない** | 着地待ち |
| `InTransit` | 輸送中 | 自分の署名が着地し、caravan が自分のものとして存在する | 襲撃を受けうる |
| `Arrived` | 到着 | settle を観測した（結果の判定はまだ） | — |
| `Fulfilled` | 履行完了 | 依頼量の全量が、宛先の同じ世代に入った | 終端 |
| `Partial` | 部分履行 | 一部だけ届いた（損耗、容量）、または入った量を確かめられない | 終端 |
| `Failed` | 失敗 | 理由は `detail.reason` に記録 | 終端 |
| `Cancelled` | 取消 | 取消が、送信中の要求がない時点で効いた | 終端 |
| `Expired` | 期限切れ | 期限が、送信中の要求がない時点で効いた | 終端 |

**保留（held）は状態ではない**。どの状態にも重ねられる印（`runs.held_reason`）で、自動処理を止める。operator が `resume` すると元の状態から再開する。保留の理由は `WalletRequired`、`Indeterminate`、`PortUnavailable`。

## 遷移表（`model::allowed`）

| 元の状態 | 遷移先 | 条件（`executor.rs`） |
|---|---|---|
| Accepted | Reserved | 正本の在庫 − 他の run の予約 ≥ 材料、かつ利用権の残り ≥ 必要量 + 他の予約 |
| Accepted | Failed | 入荷する隊商が奪われた・失われた（`InputLost`）、利用権が無い・失効した、在庫の場所が自分のものでない |
| Accepted | Cancelled / Expired | 取消の要求、期限 |
| Reserved | FacilityRequested | 送る直前に、利用権・施設の世代・在庫を**もう一度**確認し、予算の範囲内で署名し、記録してから送信する（`unless_cancelled`） |
| Reserved | Accepted | 送る直前の確認で在庫が足りない（予約を解放して待つ） |
| Reserved | Failed / Cancelled / Expired | 利用権の失効・不足、施設が無い、予算切れ、取消、期限 |
| Facility{Requested,Submitted} | FacilitySubmitted | 送信の応答が Accepted |
| Facility{Requested,Submitted} | FacilityConfirmed | **要求キーで正本の記録を読めた**（応答の有無と関係なく） |
| Facility{Requested,Submitted} | Reserved | 記録がなく、すべての attempt が「もう着地しない」と決まった（有効期間切れで不在、または事前検査での拒否）。新しい確認からやり直す |
| Facility{Requested,Submitted} | Failed | 確定的な拒否（利用権の失効、材料不足など） |
| Facility{Requested,Submitted} | Cancelled / Expired | **すべての attempt が決着した後に限る** |
| FacilityConfirmed | ShipRequested | 宛先が存在し世代が同じ、正本の在庫 ≥ 荷、同じ owner の送信が他に飛んでいない（`sole_owner_send`）。この条件で seq を固定し、署名し、記録してから送信する |
| FacilityConfirmed | Failed | 宛先の世代変更・消失（`DestinationChanged`）。正本の在庫が荷より少ない（`OutputShort`） |
| FacilityConfirmed | Cancelled / Expired | 取消・期限。**産出物は在庫の場所に残る** |
| Ship{Requested,Submitted} | ShipSubmitted | 送信の応答が Accepted |
| Ship{Requested,Submitted} | InTransit | この seq の**自分の署名が着地した**（または entity 履歴の `CaravanSent` にある署名が自分のもの） |
| Ship{Requested,Submitted} | FacilityConfirmed | どの attempt も着地しないと決まった。または seq を他の送信が使った。新しい確認の後に seq を固定し直す。`WalletRequired` の場合は、保留を付けてここへ戻す |
| Ship{Requested,Submitted} | Failed / Cancelled / Expired | 確定的な拒否。取消・期限は、すべての attempt が決着した後に限る |
| InTransit | Arrived | caravan が閉じ、settle の記録（feed、または entity 履歴）を読めた |
| InTransit | Failed | caravan の所有者が変わった（take：`Raided`） |
| Arrived | Fulfilled / Partial / Failed | 宛先が依頼どおりで `DELIVERED`、かつ入った量（`credited`）が依頼量以上なら Fulfilled。少なければ Partial。0 なら Failed（`LostInTransit`）。宛先が違えば Failed（`Raided`）。`LOST` なら Failed（`DestinationChanged`） |
| 終端 | — | どこにも遷移しない |

同じ状態への遷移（詳細だけを更新するもの。待ち、保留、ポートの誤り）は、終端以外で許す。

**どの経路でも確定を飛ばさない**：`InTransit` に入れるのは `Ship*` からだけ、`FacilityConfirmed` に入れるのは `Facility*` か `Ship*`（やり直し）からだけ（テストで検査している）。

## 各状態で、誰が何を所有し、何が予約され、何を返せるか

| 状態 | 資源の所有（正本） | 予約（run store 内、他の run への助言） | 返せるもの |
|---|---|---|---|
| Accepted | 依頼者：材料（今ある場所に） | なし | すべて（何も動いていない） |
| Reserved | 依頼者：在庫の場所の材料 | 材料と利用権の単位 | すべて（予約を解放するだけ） |
| Facility{Requested,Submitted} | 依頼者：材料。ただし要求が着地すれば消費される | 材料と利用権。要求キーは固定 | **要求の決着まで何も確定しない**。決着後：着地しなければ全部、着地すれば産出物 |
| FacilityConfirmed | 依頼者：在庫の場所の産出物（材料と利用権は消費済み） | 産出物 | 産出物は在庫の場所に残る。材料と利用権は戻らない |
| Ship{Requested,Submitted} | 依頼者：産出物。ただし送信が着地すれば caravan へ移る | 産出物。seq は固定 | 送信の決着まで何も確定しない |
| InTransit | caravan（依頼者のもの。襲撃で襲撃者のものになりうる）。手数料は caravan に預けられている | なし | **何も返せない**（呼び戻しの命令がない） |
| Arrived / Fulfilled / Partial | 宛先の所有者：入った分 | なし | なし |
| Failed / Cancelled / Expired | 最後に確定した段階のまま（`detail.outcome.note` に記録） | なし（解放済み） | 在庫の場所に残ったもの |

予約は、正本の在庫を固定するものではない（chain に lock は無い）。同じ store を使う run どうしで同じ在庫を二重に計画しないための助言にすぎない。手作業の消費など、外からの変化に対しては、送る直前の正本の確認と、canonical な側の原子的な検査で守る。

## 取消と期限

- 取消は印（`cancel_requested`）として記録し、version を一つ進める。古い snapshot からの書き込みは、すべて CAS で失敗する。送信を伴う遷移には `unless_cancelled` の条件が付く。
- **送信中の要求は取り消せない**。決着を待ち、着地すれば記録してから止める（`cancel_while_in_flight`）。
- `InTransit` 以降の取消には効果がない（`cancel_in_transit_is_too_late`）。期限も `InTransit` 以降には適用しない。荷は道の上にあり、待つしかない。
- 期限は、新しい attempt に署名しない時刻である。期限の後に古い attempt が着地した場合は、事実として記録し（`FacilityConfirmed`）、その時点で `Expired` にする。次の段階には進まない（`late_landing_after_deadline`）。

## 発送と到着を混同しない（引き継ぎ文書の確認事項 1）

| 表示してよいこと | 根拠となる状態 |
|---|---|
| 「発送を依頼した」 | ShipRequested |
| 「発送を受け付けた（未確定）」 | ShipSubmitted |
| 「輸送中（n 個）」。n は**実際に積まれた量**（`sent_cargo`、損耗の後） | InTransit |
| 「到着した」 | Arrived 以降 |
| 「届いた（n 個）」。n は `outcome.delivered`。未確認なら、その旨を必ず併記する | Fulfilled / Partial |
