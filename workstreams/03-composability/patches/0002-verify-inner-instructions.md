# 0002 再生検証器と索引が CPI の Frontier 命令を扱う（案、未実行）

## 事実（コードを読んだ結果。実行はしていない）

- 索引 `findex` は `getSignaturesForAddress(program)` と `getTransaction` で取引を集め、`tx`（wire）、`logs`、`err`、`code`、`units`、`fee`、`post` を保存する（`frontier-node/crates/findex/src/archive.rs:133`、`ingest.rs:7`）。CPI で Frontier を呼んだ取引も Frontier の id を口座に含むので**集められる**見込み。ただし `meta.innerInstructions` は保存しない。
- 検証器は wire の取引から**トップレベルの** Frontier 命令だけを `tx.ixs` に集める（`frontier-node/crates/verify/src/world.rs:337-350`）。記録は `fclient::log::bodies_from_logs` が入れ子のフレームも Frontier のものとして読む（`world.rs:363`）。
- このため courier の取引は、記録（CARAVAN_SENT）とポスト状態の変化はあるのに、それを判定する命令が `tx.ixs` にない。V2 は「取引がプログラムを呼んでいない」警告を出し（`checks/v2_program.rs:67`）、V23 は SendCaravan を判定せず（`checks/v23_caravans.rs:1104`）、V7 の Holding の書込照合（`checks/v7_replay.rs:1084-1130`）は書いた命令を見つけられない。結果がどの検査の失敗になるかは**確かめていない**。

## 変更案

1. `findex`: `getTransaction` の `meta.innerInstructions` を保存する（archive の JSON に `inner: [[index, programIdIndex, accounts, data], …]` を追加。旧 archive は `inner` 無し＝空として読む）。
2. `verify/src/world.rs`: `tx.ixs` に内側の Frontier 命令も入れる。`Ix` に `stack_height`（または `outer_index`）を持たせ、トップレベルとの区別を残す。
3. 各検査: 命令の位置（`index`）を使う箇所は、内側の命令の順序（外側の命令内の出現順）で並べる。トップレベル限定の命令（`top_level_only`）が内側に現れたら改竄として報告する（プログラムが拒否するはずなので）。
4. 試験: courier-tests の `t01` 相当の取引を archive に入れ、`verify` と `tamper` が通る／検出することを確かめる。

## なぜ必要か

外部プログラムの CPI を正式な遊び方として受け入れると、検証器が公開の季節を再判定できなくなる。合格地点(1)の確認（オンチェーンの規則が保たれること）とは別に、検証の約束（README「A verifier can replay a season's transaction log」）を保つために要る。
