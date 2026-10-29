# テスト報告

基準 commit：`4cd901de9f8e0d6c0b2016851d30595c4a70aa46`。ツールチェーン：rustc 1.89.0（root の `rust-toolchain.toml`）。実行日：2026-10-29。

## 成功の三つの区別

| 区別 | 状態 | 内容 |
|---|---|---|
| **ローカル成功** | ✅ | run store（実際の SQLite ファイル、WAL、複数の接続とスレッド）、lease と CAS、遷移表、停止と再起動、CLI |
| **模擬成功** | ✅ | 施設の利用権（②）、施設操作と要求キーの一意性、chain の規則（seq、損耗、容量、世代、襲撃、settle、署名の有効期間）。すべて `src/sim.rs` の **MOCK** に対する結果 |
| **実チェーンでの成功** | ⬜ 未実行 | 実チェーン用の adapter が無い。localnet、devnet、本番のどれにも送信していない |

## 実行したコマンド

```sh
cd workstreams/04-execution
cargo test                     # 44 件：通過 44、失敗 0、無視 0
cargo clippy --all-targets     # 警告 0
cargo fmt --check              # 差分 0
for i in $(seq 30); do cargo test -q; done   # 30 回すべて通過（スレッドの stress を含む）
cargo run --bin runexec -- demo --db <tmp> --scenario {happy,lost-response,crash,raid}   # 4 つとも期待どおり（MOCK と明示）
```

## 必須テストとの対応（すべて通過。MOCK の世界に対する結果）

| 必須項目 | テスト |
|---|---|
| 送信前・送信後・確定後の各時点で停止・再起動 | `stop_and_restart_at_every_point`（施設と発送 × 送信前・送信後・確定後の 6 点）、`restart_after_validity_ran_out` |
| 同じイベントの重複 | `duplicated_and_reversed_feed`（Receipt は事実ごとに一件）、stress の 2 件（feed を重複・逆順にしている） |
| 順序逆転 | `duplicated_and_reversed_feed`、`settle_seen_before_send_is_harmless` |
| 履歴の欠落 | `history_gap_is_reconciled_from_entity_history`、`unseen_take_is_found_at_settlement`、`indeterminate_is_held_then_resumed`、`transient_indeterminate_is_retried_not_held`、`seq_taken_seen_in_entity_history` |
| 古い状態 | `stale_snapshot_writes_and_sends_nothing`、`cancel_races_the_send_write`、`same_executor_id_twice_is_fenced_by_epoch` |
| 送信応答は不明だが実際には確定していた | `response_lost_but_committed`（施設と発送の両方。attempt は各 1、手数料は着地した分だけ） |
| 応答が無く、実際にも届いていない | `timeout_without_commit_is_rebroadcast`（同じバイト列の再送。attempt は各 1） |
| 複数の実行者が同時に同じ処理を拾う | `second_executor_cannot_claim_a_held_lease`、`zombie_executor_is_fenced`、`many_executors_many_runs`（4 スレッド × 16 run）、`cancels_race_executors`（3 スレッド × 12 run × 3 seed と、取消のスレッド） |
| 権利失効 | `rights_expired_before_send`（署名する前に失敗）、`rights_expire_while_in_flight`（着地の時点で canonical な側が拒否）、`right_units_are_reserved_across_runs` |
| 材料不足 | `waits_for_inbound_materials`、`inbound_taken_fails_the_run`、`no_materials_expires`、`stock_spent_after_reservation_goes_back_to_waiting` |
| 部分到着 | `wear_gives_partial`（損耗）、`capacity_clip_gives_partial`（容量。`credited` があれば量を測り、無ければ「未確認」とする） |
| 襲撃による損失 | `raids`（take と burn）、`unseen_take_is_found_at_settlement` |
| 宛先の世代変更 | `destination_seized_before_send`（署名前に失敗し、産出物は在庫の場所に残る）、`destination_seized_in_transit`（settle で失われる） |
| 期限切れ後の遅い応答 | `late_landing_after_deadline`（着地を事実として記録し、発送せずに Expired）、`expired_attempt_never_lands` |
| 取消と実行の競合 | `cancel_before_send`、`cancel_races_the_send_write`、`cancel_while_in_flight`、`cancel_in_transit_is_too_late`、`cancels_race_executors` |
| 停止条件 | `attempts_are_bounded`、`fee_budget_is_bounded`、`port_down_holds_then_resumes` |
| その他 | `happy_path_fulfils_with_three_receipts`、`acceptance_is_idempotent`、`send_to_another_player_is_held_for_the_wallet`、`seq_taken_by_another_send`、`every_state_has_an_ownership_row_and_terminal_states_are_final`、`policy::tests::no_military_instruction_is_automatable` |

各テストの最後に、模擬世界の `audit()`（保存則と、要求キーごとの効果が 1 以下であること）と、必要に応じて `check_store()`（遷移が表の範囲内であること、終端の run が予約を持たないこと、予算の範囲内であること）を実行している。

## 変異テスト（テストが欠陥を検出できるかの確認）

安全のための仕組みを一つずつ壊し、テストが失敗することを確かめた。手順：一時的に書き換えて `cargo test` を実行し、元に戻す。

| 変異 | 検出したテスト |
|---|---|
| M1 CAS から version の条件を外す | `stale_snapshot_writes_and_sends_nothing` |
| M2 送信の Accepted を施設の確定として扱う | `happy_path_…`、`duplicated_and_reversed_feed`、`stop_and_restart_at_every_point` |
| M3 同じ署名を再送しない | `timeout_without_commit_is_rebroadcast` |
| M4 前の attempt が決着する前に seq を固定し直す | `cancels_race_executors` |
| M5 lease の epoch による fence を外す | `same_executor_id_twice_is_fenced_by_epoch` |
| M6 送る直前の利用権の確認を省く | `rights_expired_before_send` |
| M7 送る直前の宛先の世代の確認を省く | `destination_seized_before_send` |
| M8 settle の cargo を、入った量として扱う | `capacity_clip_gives_partial` |
| M9 owner ごとの送信の直列化を外す | `cancels_race_executors`、`many_executors_many_runs` |

最初の試行では M3、M5、M6、M7 が検出されなかった。テストに「attempt を署名していない」「epoch だけが違う」場合の検査を加え、すべて検出できるようにした。M4 と M9 はスレッドの stress テストで検出しており、**検出は確率的**である（30 回の反復では毎回検出した）。

## 開発中にテストが見つけた欠陥（修正済み）

1. 同じ在庫の場所を使う 2 本の run で、一方の発送が着地した後も予約が残り、正本の減少と予約が二重に数えられた。その結果、もう一方が誤って `OutputShort` で失敗した。→ 正本の在庫が足りないときだけ失敗にし、他の run の予約が原因なら待つように修正した。
2. 同じ owner の run が並行して同じ seq を固定し、互いに拒否し合って attempt を使い切った。→ owner ごとに seq を固定できる run を一つに限った（CAS の条件として原子的に検査する）。
3. 有効期間を過ぎた attempt の手数料が、確定の時点でもう一度差し引かれていた（二重の払い戻し）。→ 未決の attempt だけを払い戻す。全テストで `fee_committed` と模擬世界の請求額が一致することを検査している。
4. `WalletRequired` で保留になった run が `ShipRequested` に残り、同じ owner の他の run の発送を塞いでいた。→ `FacilityConfirmed` に戻してから保留にする。

## 未実行・不合格

| 項目 | 状態 | 理由 |
|---|---|---|
| 実チェーン（localnet、devnet） | 未実行 | adapter が無い。本番への送信と deploy は依頼の範囲外 |
| 既存の CI（`frontier-node`、`permutation-*`） | 未実行 | ④は共通コアを変更していない。参照はパス依存だけ（`permutation-rules`、`frontier-abi` は読み取りのみ）。ビルドが通ることは、本 crate のビルドで確認した |
| ②の実際の利用権サービス | 未実行 | 契約を受け取っていない（MOCK） |
| 電源断の再現（OS レベル） | 未実行 | 停止は名前付きの停止点（プロセス内）で再現した。SQLite の `synchronous=FULL` による耐久性そのものは検証していない |
| 不合格 | なし | — |
