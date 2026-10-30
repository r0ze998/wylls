# テスト報告

- 基準 commit：`4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（変更していない）
- ツールチェーン：rustc 1.89.0（root の `rust-toolchain.toml`）
- 版：④ 0.2（2026-10-30）

## 何が検証されたか（三つの区別）

| 区別 | 状態 | 内容 |
|---|---|---|
| **ローカル（実際の SQLite）** | ✅ | run store（WAL、複数の接続とスレッド）、lease と CAS、遷移表、名前付きの停止点での停止と再起動、費用の帳簿、CLI |
| **模擬正本（MOCK）** | ✅ | 施設の利用権（②）、施設操作と要求キーの一意性、chain の規則（seq、wallet、損耗、容量、世代、襲撃、settle、占領ロック、署名の有効期間、事前検査）。すべて `src/sim.rs` に対する結果 |
| **実チェーン** | ⬜ 未実行 | adapter が無い。localnet、devnet、本番のいずれにも送信していない。program の LiteSVM テストも、SBF のツールチェーンが無いため実行していない |

**62 件・30 回の通過は、実チェーンでの安全性を示すものではない。** 各保証が何に依っているかは [INVARIANTS](INVARIANTS.ja.md) の「依存先」の列を参照。模擬正本が実チェーンに無い fencing を与えていないかの監査は [STATE-MACHINE](STATE-MACHINE.ja.md) の最後の表を参照。

## 実行したコマンドと結果

```sh
cd workstreams/04-execution
cargo test                     # 62 件：通過 62、失敗 0、無視 0
cargo clippy --all-targets     # 警告 0
cargo fmt --check              # 差分 0
for i in $(seq 30); do cargo test -q; done   # 30 回すべて通過（stress を含む）
python3 -I <scratchpad>/mut/run.py           # 変異 15 件：下記
```

| テストファイル | 件数 | 内容 |
|---|---|---|
| `src/policy.rs`（単体） | 1 | 自動化を許す命令の表 |
| `tests/faults.rs` | 38 | 前回からのもの（費用と結果の型を新しい契約に合わせて更新） |
| `tests/concurrency.rs` | 8 | +3：`late_ship_landing_is_waited_for_not_resent`（M4）、`second_run_of_an_owner_waits_for_the_seq`（M9）、`per_owner_rule_holds_between_check_and_write`（M9b） |
| `tests/signed.rs` | 6 | 新規：署名済みの要求と取消 |
| `tests/routes.rs` | 4 | 新規：別の送信経路と owner の seq |
| `tests/arrival.rs` | 5 | 新規：入荷量の判定 |

## 今回追加したテスト（すべて決定的。実行の順序をテストが制御する）

| 依頼項目 | テスト | 確認すること |
|---|---|---|
| 3. 古い実行者の送信と取消 | `stale_bytes_sent_after_cancel_within_validity_land_and_are_reported` | A が署名して停止する。取消の後に B が引き継ぐ（B は再送しない）。A が有効期間内に送信すると着地する。取消は `AwaitingSigned` を経て `Completed{effects:[facility_used]}` になり、在庫の変化と一致する |
| 同上 | `stale_bytes_sent_after_validity_are_refused` | 有効期間の後の送信は chain が拒否する。取消は効果なしで完了し、手数料は released |
| 同上 | `new_attempt_only_after_stale_bytes_expired` | 引継ぎの後、新しい署名は、前のバイト列の有効期間が過ぎてからしか作らない。古いバイト列は後で拒否される |
| 同上 | `preflight_refusal_is_not_final_while_bytes_are_valid`、`preflight_refusal_fails_only_after_validity` | 事前検査での拒否の後も、同じバイト列は着地しうる。失敗にするのは有効期間の後だけ |
| 同上 | `cancel_in_transit_is_recorded_ineffective` | 輸送中の取消は `Ineffective` |
| 4. 別の送信経路 | `identical_send_by_another_route_is_not_ours` | 手作業の同じ中身の送付が seq を使った。自分のものとせず、成功にせず、再送もしない（`OutputShort`） |
| 同上 | `owner_and_seq_alone_prove_nothing` | 署名を名指しする記録が無ければ、`(owner, seq)` と中身が一致しても `Indeterminate` |
| 同上 | `executor_on_another_store_takes_the_seq` | 別の store の実行者と seq が衝突した。失敗として着地した attempt の手数料は charged になり、固定し直して双方とも完了する |
| 同上 | `our_signature_with_other_content_is_held` | 自分の署名でも中身が違えば `Inconsistent` で保留（記録は store に注入した。模擬正本は嘘をつかないため） |
| 5. 入荷量 | `vault_record_without_credit_is_unverified_even_if_balance_matches` | 残高が一致していても `DeliveredUnverified` |
| 同上 | `concurrent_movements_at_the_destination_do_not_change_the_verdict` | 宛先の入出庫が並行しても判定は変わらない |
| 同上 | `holding_destination_is_rule_derived`、`capture_locked_destination_waits`、`known_zero_outcomes` | 規則による検証、占領ロック、0 と分かる場合 |
| 7. 確率的にしか検出できなかった変異 | `late_ship_landing_is_waited_for_not_resent`、`second_run_of_an_owner_waits_for_the_seq`、`per_owner_rule_holds_between_check_and_write` | M4、M9、M9b を決定的に検出する。M9b は、テスト用の hook（`Executor::hook`、`ship.before_pin`）で、B の確認と書き込みの間に A の一歩を挟んで再現した |

前回からの必須テスト（停止・再起動、重複、順序逆転、履歴の欠落、古い状態、応答の消失、複数の実行者、権利失効、材料不足、部分到着、襲撃、世代変更、遅い応答、取消の競合）は、引き続きすべて通過している。

## 変異テスト（15 件、すべて検出）

一時的にコードを書き換え、`cargo test` を実行して、元に戻した（`<scratchpad>/mut/run.py`）。

| 変異 | 検出したテスト（決定的なもの） |
|---|---|
| M1 CAS から version を外す | `stale_snapshot_writes_and_sends_nothing` |
| M2 Accepted を施設の確定とみなす | `happy_path_…`、`stop_and_restart_at_every_point` ほか 8 件 |
| M3 同じ署名を再送しない | `timeout_without_commit_is_rebroadcast`、`new_attempt_only_after_stale_bytes_expired` |
| M4 決着前に seq を固定し直す | `late_ship_landing_is_waited_for_not_resent` ほか |
| M5 epoch の fence を外す | `same_executor_id_twice_is_fenced_by_epoch` |
| M6 署名前の利用権の確認を省く | `rights_expired_before_send` |
| M7 署名前の宛先の世代の確認を省く | `destination_seized_before_send` |
| M8 settle の cargo を credited とみなす | `capacity_clip_gives_partial` |
| M9 owner ごとの規則を外す（事前確認と CAS） | `second_run_of_an_owner_waits_for_the_seq`、`per_owner_rule_holds_between_check_and_write` |
| M9b CAS の条件だけを外す | `per_owner_rule_holds_between_check_and_write` |
| M10 取消の後も再送する | `stale_bytes_sent_after_cancel_*`（2 件） |
| M11 事前検査の拒否を即座に確定する | `preflight_refusal_fails_only_after_validity` |
| M12 seq の記録なら誰のものでも自分とみなす | `identical_send_by_another_route_is_not_ours` ほか 3 件 |
| M13 中身の照合を外す | `our_signature_with_other_content_is_held` |
| M14 credited の無い vault 宛てを全量とみなす | `vault_record_without_credit_is_unverified_even_if_balance_matches` ほか 2 件 |

前回、M4 と M9 は stress テストでしか検出できなかった。今回は、どちらも決定的なテストで検出できる。stress テスト（`many_executors_many_runs`、`cancels_race_executors`）は、スレッドの組み合わせを広く探すために残している。

## 開発中にテストが見つけた欠陥（今回修正したもの）

1. 事前検査で拒否された attempt を、ただちに「着地しない」と扱っていた。同じバイト列の別のコピーが有効期間内に着地しうる。→ 有効期間の終わりまで未決として扱う。
2. 取消の後も、別の実行者が署名済みのバイト列を再送していた。→ 取消または期限の後は再送しない。
3. `(owner, seq)` の記録と status から「自分の送信」を判断しており、中身を照合していなかった。→ 署名と中身の両方を照合する。
4. vault 宛ての `credited` が無い場合に、残高と容量から結果を推測していた。→ `DeliveredUnverified` にし、残高を読まない。
5. 有効期間を過ぎた attempt の手数料を「返った」として扱い、status の履歴が使えない場合も同じだった。→ 予約・確定・未確定・解放の帳簿にし、`Absent` を確認したときだけ解放する。
6. 模擬正本の feed が、欠落の後に cursor をログの末尾より先へ進めていた（模擬正本の欠陥）。→ 修正した。

## 未実行・残る保証の範囲

| 項目 | 状態 | 理由・範囲 |
|---|---|---|
| 実チェーン（localnet、devnet） | 未実行 | adapter が無い（P5）。本番への送信と deploy は範囲外 |
| program の LiteSVM テスト（`g13_s1_send_caravan_refusals` など） | 未実行 | SBF の platform-tools が無い。署名の要件はソースを読んで確認した（[SIGNATURES](SIGNATURES.ja.md)） |
| 既存の CI（`frontier-node`、`permutation-*`） | 未実行 | 共通コアを変更していない。参照は path での読み取りだけ |
| ②の利用権サービス、③の実行経路 | 未実行 | 契約が未受領（模擬） |
| OS の停止、電源断、fsync の失敗 | 未検証 | 停止はプロセスの中の名前付きの停止点だけで再現した。SQLite の `synchronous=FULL` の耐久性は別の範囲 |
| 署名済みのバイト列を、ワイヤとして本当に同じものとして再送できること | 模擬のみ | 模擬正本の `wire` は要求の JSON。実際の tx のバイト列を保存し再送できることは③の要件（③-R3） |
| 不合格 | なし | — |
