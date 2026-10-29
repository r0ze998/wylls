# 資源と権利の不変条件

ネットワーク越しの「exactly once」は約束しない。保証するのは次のことだけである。**要求を識別し、正本で確認し、重複を拒否することで、一つの要求による資源の変化を一度までに抑える**。各不変条件について、強制している仕組みと、それを検査するテストを示す。テストはすべて模擬世界（MOCK）での結果であり、実チェーンでは検査していない（[TEST-REPORT](TEST-REPORT.ja.md)）。

## 資源

| # | 不変条件 | 強制する仕組み | 検査 |
|---|---|---|---|
| R1 | 一つの run の施設要求が効くのは**一度まで** | 要求キー `fac:<run_id>` は全 attempt で同じ。canonical な側が二度目を拒否する（`AlreadyDone`、③への要件） | `SimWorld::audit`（キーごとの効果は 1 以下）。全テストで実行 |
| R2 | 一つの seq の SendCaravan が効くのは**一度まで** | seq を固定して記録してから送る。chain が `seq ≠ Citizen.CARAVANS` を拒否する（`proc/caravan.rs:695`） | 同上。`seq_taken_by_another_send` |
| R3 | 一つの run が作る caravan は**一つまで** | 新しい seq を固定するのは、前の seq の attempt がすべて決着した（有効期間切れで不在、失敗、他人が使った）後だけ | 変異 M4 を `cancels_race_executors` が検出する。`assert_fulfilled`（宛先にちょうど 3） |
| R4 | 資源は台帳の外で増減しない（保存則） | 模擬世界の台帳（投入 + 産出 − 消費 − 損耗・容量超過・襲撃 − 手作業の消費） | `audit()` を全テストで実行 |
| R5 | 送信の応答を確定として扱わない | `Accepted` は `*Submitted` に進めるだけ。確定は正本の読み取り（要求キー、署名の着地、entity 履歴） | 変異 M2 を 3 つのテストが検出する |
| R6 | Receipt を残量の証明として使わない | 次の段階の直前に、正本の在庫（`free_stock`）と利用権（`rights_free`）を必ず読む | `stock_spent_after_reservation_goes_back_to_waiting`、`rights_expired_before_send` |
| R7 | 着いた量を依頼量と仮定しない | `credited` があればその値を使う。なければ「未確認」と記録し、Fulfilled にしない | `capacity_clip_gives_partial`、変異 M8 |
| R8 | 取消された run は発送しない | 送信を伴う遷移は `cancel_requested = 0` を条件にする。取消は version を進める | `cancel_*`、`cancels_race_executors`（取消された run の SendCaravan の着地は 0） |
| R9 | 期限の後に新しい attempt へ署名しない | `stop_if_due` を署名の前に評価する | `expired_attempt_never_lands`、`late_landing_after_deadline` |

## 利用権

| # | 不変条件 | 仕組み | 検査 |
|---|---|---|---|
| P1 | 失効した利用権では施設を使わない | 送る直前に `Rights::check` を呼ぶ。canonical な側は、施設の使用と同じ原子的な処理の中で、もう一度検査する（②③への要件） | `rights_expired_before_send`（attempt 0）、`rights_expire_while_in_flight`（着地時に拒否） |
| P2 | 同じ利用権を、複数の run で残量以上に使う計画を立てない | 利用権の単位を予約する（`ResKind::Rights`） | `right_units_are_reserved_across_runs`（2 本目は署名前に失敗する） |
| P3 | 利用権の消費は施設の使用と一緒にだけ起きる | 施設要求の canonical な効果に含める（MOCK、②③への要件） | `audit` |

## 実行の不変条件

| # | 不変条件 | 仕組み | 検査 |
|---|---|---|---|
| E1 | 一つの run を同時に進められる実行者は一つ | lease を条件付き UPDATE で取る。期限切れで引き継ぐと epoch が増える | `second_executor_cannot_claim_a_held_lease` |
| E2 | 古い snapshot や lease を失った実行者は、何も書かず、何も送らない | すべての書き込みは `(version, lease_owner, lease_epoch)` の CAS。送信は CAS が成功した後にだけ行う | `stale_snapshot_writes_and_sends_nothing`、`zombie_executor_is_fenced`、`same_executor_id_twice_is_fenced_by_epoch`（変異 M1、M5） |
| E3 | 送信する前に、署名済みの要求を永続化する | `AttemptIntent` を状態の遷移と同じ transaction で書く | `stop_and_restart_at_every_point`（`*.before_send`） |
| E4 | 一つの owner の seq を固定している run は一つ | 遷移の条件 `sole_owner_send`（同じ owner の `Ship{Requested,Submitted}` が無いこと）を CAS に含める | 変異 M9 を stress テストが検出する |
| E5 | 遷移は表の範囲内。終端の run は予約を持たない | `Store::transition` が表を検査する。終端へ進むときは `ReleaseAll` | `check_store`（全 store を走査） |
| E6 | どの run も無制限には再試行・支出しない | `max_attempts`（各段階）、`max_fee`（署名の時点で悲観的に数え、着地しないと確定したら戻す）、`max_port_errors`、期限 | `attempts_are_bounded`、`fee_budget_is_bounded`、`port_down_holds_then_resumes` |
| E7 | 判断できないときは推測せず止める | 状態の履歴、entity 履歴、feed がすべて無ければ、決められた回数だけ見直してから保留にする | `indeterminate_is_held_then_resumed`、`transient_indeterminate_is_retried_not_held` |
| E8 | 自動実行は物流と施設操作に限る | `Request` で表せるのは 2 種類だけ。命令の許可表 `policy::AUTOMATABLE = [SendCaravan]` | `policy::tests::no_military_instruction_is_automatable` |

## 保証しないこと

- **送信の回数を一回にすること**。同じ署名済みバイト列の再送と、有効期間切れの後の新しい attempt は起きる。それでも効果は一度までになる（R1〜R3）。
- **手数料をゼロにすること**。着地して失敗した attempt（例：seq の不一致）には手数料がかかる。その分は `fee_committed` に残り、`max_fee` の範囲内に収まる。
- **他人や手作業の操作を止めること**。予約は助言にすぎない。手作業で在庫を使われた場合、run は待つか失敗するが、資源は壊れない。
- **輸送中の荷を守ること**。襲撃は遊びの一部であり、run は失敗として記録する。
