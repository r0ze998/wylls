# 資源と権利の不変条件

ネットワーク越しの「exactly once」は約束しない。保証するのは次のことだけである。**要求を識別し、正本で確認し、重複を拒否することで、一つの要求による資源の変化を一度までに抑える。**

「依存先」の列は、その保証が何に依っているかを示す。
- **DB**：run store（実際の SQLite）だけで成り立つ。ローカルで検証済み。
- **模擬**：模擬正本（`src/sim.rs`）の振る舞いに依る。実チェーンが同じ規則を持つかどうかは、[STATE-MACHINE](STATE-MACHINE.ja.md) の監査表を参照。
- **実チェーン**：実チェーンの規則に依る。コードでは確認したが、**実チェーンでは未検証**。

検査のテストはすべて、DB は実物、正本は模擬で実行した。

## 資源

| # | 不変条件 | 仕組み | 依存先 | 検査 |
|---|---|---|---|---|
| R1 | 施設要求は一度までしか効かない | 要求キー `fac:<run_id>` を全 attempt で共有する。正本が二度目を拒否する | **模擬**（実チェーンに施設の命令は無い。P3） | `audit()`（全テスト） |
| R2 | 一つの seq の SendCaravan は一度までしか効かない | seq を固定し、記録してから送る。chain が seq の不一致を拒否する | 実チェーン（`proc/caravan.rs:695`）＋DB | `audit()`、`seq_taken_*`、`executor_on_another_store_takes_the_seq` |
| R3 | 一つの run が作る caravan は一つまで | 前の seq の attempt がすべて決着してから、新しい seq を固定する | DB＋実チェーン（status、有効期間） | `late_ship_landing_is_waited_for_not_resent`（M4） |
| R4 | 資源は台帳の外で増減しない | 模擬正本の台帳 | 模擬 | `audit()` |
| R5 | 送信の応答を確定として扱わない | 確定は、自分の署名と中身を正本で確認してから | DB（実行器の論理） | M2 |
| R6 | Receipt を残量の証明として使わない | 次の段階の直前に、正本の在庫と利用権を読む | DB＋正本の読み取り | `stock_spent_after_reservation_goes_back_to_waiting` |
| R7 | 入荷量を依頼量や残高の差で推測しない | `credited` か規則（holding）だけを使う。それ以外は `DeliveredUnverified` | DB（判定の論理）。holding の規則は実チェーンのコード | `vault_record_without_credit_is_unverified_even_if_balance_matches`、`concurrent_movements_*`、M8、M14 |
| R8 | `(owner, seq)` だけで自分の送信とみなさない。中身も照合する | 自分の署名の着地、または署名を名指しする記録。中身の不一致は保留 | DB（論理）＋③（記録に sig が載ること） | `identical_send_by_another_route_is_not_ours`、`owner_and_seq_alone_prove_nothing`、`our_signature_with_other_content_is_held`（M12、M13） |
| R9 | 取消を完了として表示した後に、その run の変化は起きない。完了の前に起きた変化は表示に含める | 取消の完了は、すべての attempt の決着（有効期間後の Absent か着地）を待つ | **実チェーン**（blockhash の有効期間）＋DB | `stale_bytes_sent_after_cancel_*`（M10） |
| R10 | 期限の後に新しい attempt に署名しない | `stop_if_due` を署名の前に評価する | DB | `expired_attempt_never_lands`、`late_landing_after_deadline` |

## 利用権

| # | 不変条件 | 仕組み | 依存先 | 検査 |
|---|---|---|---|---|
| P1 | 失効した利用権では施設を使わない | 署名の直前の検査。正本での原子的な再検査 | DB＋**②の要件（未受領、模擬）** | `rights_expired_before_send`（M6）、`rights_expire_while_in_flight` |
| P2 | 同じ利用権を、残量を超えて計画しない | 利用権の単位を予約する | DB（同じ store の中だけ） | `right_units_are_reserved_across_runs` |
| P3 | 利用権の消費は施設の使用と一緒にだけ起きる | 施設要求の正本での効果 | **模擬**（②③の要件） | `audit()` |

## 実行

| # | 不変条件 | 仕組み | 依存先 | 検査 |
|---|---|---|---|---|
| E1 | 一つの run を同時に進められる実行者は一つ | lease の条件付き UPDATE | DB | `second_executor_cannot_claim_a_held_lease` |
| E2 | 古い snapshot や lease を失った実行者は、書き込まず、新しく署名しない | CAS（version、owner、epoch） | DB | `stale_snapshot_*`（M1）、`same_executor_id_twice_is_fenced_by_epoch`（M5） |
| E3 | **既に署名したバイト列は、DB では止められない**。止めるのは有効期間と要求キー | 上の R2、R9 | 実チェーン | `zombie_executor_is_fenced`、`stale_bytes_*`、`new_attempt_only_after_stale_bytes_expired` |
| E4 | 送信する前に、署名済みのバイト列を永続化する | `AttemptIntent` を状態の遷移と同じ transaction で書く | DB（OS の停止は未検証。RUNBOOK §6） | `stop_and_restart_at_every_point` |
| E5 | 一つの store の中で、owner の seq を固定している run は一つ | 事前確認＋CAS の条件 `sole_owner_send` | DB（**別の経路には効かない**。R8 で扱う） | `second_run_of_an_owner_waits_for_the_seq`（M9）、`per_owner_rule_holds_between_check_and_write`（M9b） |
| E6 | 遷移は表の範囲内。終端の run は予約を持たない | `Store::transition` の検査、`ReleaseAll` | DB | `check_store` |
| E7 | 無制限に再試行・支出しない | `max_attempts`、`max_fee`（予約＋確定＋未確定）、`max_port_errors`、期限 | DB | `attempts_are_bounded`、`fee_budget_is_bounded`、`port_down_holds_then_resumes` |
| E8 | 判断できないときは推測しない | 決められた回数だけ見直してから保留 | DB | `indeterminate_is_held_then_resumed`、`transient_indeterminate_is_retried_not_held` |
| E9 | 自動実行は物流と施設操作に限る | `Request` の型と許可表 | DB（**off-chain の制限**。session key 自体は範囲を持たない。SIGNATURES §3） | `policy::tests::…` |

## 保証しないこと

- 送信を一回にすること。同じバイト列の再送と、有効期間の後の新しい attempt は起きる。
- 手数料をゼロにすること。失敗として着地した attempt には手数料がかかる。
- 署名済みの要求を取り消すこと（R9、E3）。
- 他人・手作業・別の store の操作を止めること。予約と owner ごとの直列化は、同じ store の中でしか効かない。
- 輸送中の荷を守ること。
- **実チェーンでの成立。** 上の「実チェーン」と書いた保証は、コードを読んで確認しただけである。
