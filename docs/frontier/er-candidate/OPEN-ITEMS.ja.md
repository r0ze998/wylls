# ④への提示：findex 修正（A）の検証と、残る 5 点（⑲）

2026-10-31。**仕様は決めていません。** 各項目は「現状／再現方法／最小変更案／互換性」で示します。採否は④の判断です。

パッチは次の 4 つで、互いに独立しています（D だけは A に依存します）。

| パッチ | 内容 |
|---|---|
| A | findex の修正 |
| B | S1 とは別のプログラムの ER 候補 |
| C | 文書 |
| D | 再現の試験だけ |

S1 の既存口座を ER に委任する決定はしていません。

## 0. A（findex の修正）を④の統合候補で検証する

| 項目 | 内容 |
|---|---|
| A の中身 | ①公開 RPC の履歴欠落で pull を止める（何も保存しない）。②slot 内の順序の違いを欠落と誤らない（カーソルに最後の slot の署名を保存。古いカーソルも読める）。③`provenance::post_checks`（追加だけで、既存の動作は変えない）。④**取引の途中の失敗で、その前の取引を失っていた不具合を直す**（今回の再現で見つけた。基点 `4cd901de` の未修正コードでも再現する） |
| 検証の手順 | `docs/frontier/er-candidate/verify-A.sh <④の worktree> <patches のディレクトリ>`。A と D を当て、findex の試験、検証器の再現の試験、frontier-node の workspace 全体の試験を走らせる |
| ⑲の側で確かめたこと | A と D は、基点 `4cd901de` にも、`origin/main` の `92142932` にも単独で当たる。当てた後、frontier-node の workspace 全体の試験が通る。④の統合枝 `ws04/integration-20261030` は remote にないので、⑲の側では当てていない |

### 履歴欠落の検出の限界（A を使う人へ）

**検出が通っても、完全な履歴の証明にはなりません。** findex の記録に「ない」ことを、その出来事が「起きていない」（送っていない、着地していない）根拠にしてはいけません。④・⑫・⑮で記録を根拠に使う場合も同じです。

検出できない場合は次の 3 つです。

1. 初回の取得（カーソルがない）。
2. カーソルがない、読めない、または古い形式（最後の slot の署名がない）。
3. ノードが最後に保存した署名は持っていて、途中だけ欠けている。1 つのノードからは見抜けません。

完全性が必要なら、別のノードや完全な履歴を持つ取得元と突き合わせる必要があります。この限界は、コードの説明（`findex/src/ingest.rs` の冒頭）と RECOVERY §5 にも書きました。

## 1. version 1 の取引

| 項目 | 内容 |
|---|---|
| 現状 | fclient の `getTransaction` は `maxSupportedTransactionVersion: 0` を送る（`fclient/src/rpc.rs:157`）。v1 の取引で -32015 になり、RpcPoll はそこで毎回止まる。それより後は保存されない。A の修正前は、同じ取引の束でそれより前の取引も失っていた。`fclient::tx::from_wire` は legacy 専用 |
| 再現方法 | 偽の RPC：`findex/tests/open_items.rs` の `a_version_1_transaction_stops_every_pull`。実物：ローカルの base＋MagicBlock ER で一巡した後に `rpc_poll_against_a_live_node`（`results/local-findex-live.txt`） |
| 最小変更案 | ①`maxSupportedTransactionVersion` を 1 にする（この行の 1 か所）。②解釈できない取引も、取引のバイト列とログはそのまま保存する。`from_wire` に失敗したら、書き込み口座は空、`fee_payer` はなし、post-state はなし（provenance では扱わない）とする。PS2 の記録はログから取れるので、取引の版に依存しない |
| 互換性 | Agave 3.1.9 の RPC は、legacy 取引に対して 1・2 を受け付け、legacy として返した（ローカルで確認）。repo のローカルノード（`localnet/src/server.rs:515`）は、このパラメータを読まない。保存形式は変わらない（取引のバイト列は base64） |

## 2. 委任した口座の commit を追う索引の対象

| 項目 | 内容 |
|---|---|
| 現状 | RpcPoll は、プログラムのアドレスだけを `getSignaturesForAddress` で追う。commit の finalize（v1、最上位は委任プログラム）は、委任した口座のアドレスにしか現れない。そのため、base の口座の内容が、保存されていない取引で変わる。解除（callback を含む）は、プログラムのアドレスに現れる |
| 再現方法 | `frontier-er/svm-tests/probe-history.sh`（ローカルの base＋ER）。`results/local-history-probe.jsonl`：プログラムのアドレスで 5 件、板のアドレスで 6 件（commit の finalize は後者だけ） |
| 最小変更案 | 委任した口座ごとに、2 つ目の取得元（同じ RpcPoll を口座のアドレスで）を追加し、署名で重複を除いて合流させる。S1 は今、何も委任していないので、採用されるまで変更は不要 |
| 互換性 | プログラム以外の取引が保存に入る。`findex::records` はプログラムの枠だけを読むので、索引と herald は影響を受けない。2 つの取得元を合流させたときの順序は、slot の順になる。同じ slot の中の全体の順序は、`getSignaturesForAddress` からは決まらない（判断が要る） |

## 3. `confirmed` で保存した記録の取り消し

| 項目 | 内容 |
|---|---|
| 現状 | 取得は `confirmed` で、保存は追記だけ。fork から外れた取引も残り、取り消しの印はない。A を当てていると、次の pull は「history gap」で止まる（安全側に止まるが、名前は正確ではない）。基点のコードでは、止まらずに先へ進む |
| 再現方法 | `findex/tests/open_items.rs` の `a_confirmed_transaction_dropped_from_its_fork_stays_archived` |
| 最小変更案 | 保存用の取得を `finalized` にする（`getSignaturesForAddress`・`getTransaction` の commitment の 2 か所）。`confirmed` は表示用（herald の WS など）だけにする。別案として、`confirmed` で保存し、後で確定の印を付ける方法もあるが、変更が大きい |
| 互換性 | 形式は変わらない。保存が数十 slot 遅れる（`finalized` の遅れ）。ローカルの feed（`frontier_feed`）には影響しない |

## 4. 継続世界での checkpoint の検証

| 項目 | 内容 |
|---|---|
| 現状 | 検証器の V1 は、最終状態の head が、再生した head と完全に一致することを要求する（`verify/src/checks/v1_chains.rs:286-297`）。保存の終わりより後に読んだ最終状態や、委任プログラムが持つ口座は HeadMismatch になる。最終状態の読取りは、Clock と口座で確定度が違い、100 件ごとに slot が違いうる（`verify/src/input.rs:260-278`） |
| 再現方法 | `verify/tests/open_items.rs`：記録したシーズンはそのまま PASS。末尾の 1 割を除いた前半だけを再生すると FAIL（HeadMismatch）。連鎖する口座 1 つの所有者を委任プログラムにすると HeadMismatch |
| 最小変更案 | 検証器に checkpoint モードを足す。①最終状態の seq が再生と同じなら、一致を要求する（今と同じ）。②先に進んでいるなら「保存より先は未検証」と報告し、失敗にしない。③所有者が委任プログラムなら「委任中：最後の commit まで」と報告し、seq が同じときだけ head を比べる。④読取りの context slot が、保存の最後の slot 以上であることを要求する |
| 互換性 | 既定のモードは今のまま（記録済みの試験と CI は PASS のまま）。新しい報告の番号は、④の登録表で決める |

## 5. archive の増大

| 項目 | 内容 |
|---|---|
| 現状 | 追記だけで、保持期限・圧縮・外部保管がない（`findex/src/archive.rs`）。SQLite の索引も同じ。封印した区切り（segment）には、manifest に sha256 がある |
| 再現方法（計測） | `findex/tests/open_items.rs` の `archive_bytes_per_transaction`：ログだけの取引で約 2.4 KB/件、Province＋Citizen の post-state 付き（公開 RPC で `Enriched` が取る形）で約 9.6 KB/件（合成した記録での計測）。100 万件なら約 2.4〜9.6 GB。世界が続いたときの取引の頻度は分からないので、年あたりの量は④・⑧の見積もりに掛けて求める |
| 最小変更案 | 封印済みの区切りを外部に保管し、手元では manifest の hash だけを持つ。区切りごとに圧縮する。herald の checkpoint から再起動すれば、古い区切りを読まずに済む。区切り方は期間ではなく、大きさか時間で決める |
| 互換性 | manifest の形式を保てば、既存の検証（hash）は使える。圧縮した区切りを読む側（`read_after`）の変更が要る |

## 6. ほかの位置づけ（変えていない）

- ER のストレージを消したときの、commit していない書込みの消失：**検出して停止できる**（ErRegressed）。消失を防ぐことも、復元することもできない。
- 9,000 slot 後の脱出：LiteSVM で確認した。**実際の ER では未確認**。
- 書き手の規則と板の用途は未決。
- 公開 devnet への配備、新しい鍵、他担当の環境への導入（Agave 4.2.2 を含む）は、それぞれ別に確認が要る。

## 7. 保存した履歴と後続の履歴・再起動・保存失敗の整合（2026-11-03 追記）

既存のローカル fixture で独立に検証しました。fixture は、偽の JSON-RPC ノード、herald の `mini_season`、ディスクの書込み拒否（次の区切りファイルの位置にディレクトリを置く）です。自動 rollback、checkpoint の正本、S1 口座の委任は扱っていません。

### 既に解決済み（既存の試験）

| 場合 | 試験 |
|---|---|
| group commit の途中で落ちて再起動する。同じファイルができ、索引は 0 からではなく巻き戻る | `herald/tests/fold.rs` の `ingest_restart_and_crash_give_the_same_files`、`a_crash_inside_a_group_commit_re_ingests_and_gives_the_same_files`、`a_crash_inside_a_group_commit_rolls_the_index_back_not_from_zero` |
| checkpoint から再起動する（conquest を含む） | `herald/tests/cq_fold.rs` の `cq_fold_restarts_from_checkpoints` |
| 取得の途中で失敗する（以前に修正済み） | `findex/tests/open_items.rs` の `a_failure_mid_batch_loses_nothing` |
| confirmed の記録が fork から外れる | `findex/tests/open_items.rs` の `a_confirmed_transaction_dropped_from_its_fork_stays_archived` |

### 今回見つけて直した不具合（独立 patch：commit 0be5f9f、`findex/src/lib.rs`・`ingest.rs`）

1. **保存に失敗したのに、取り込みを続けていた。** pull でカーソルが進んだ後に、archive（または索引）の保存が失敗すると、`Findex::ingest` はエラーを返します。しかし herald の取り込みループは、次の呼び出しでそのまま先を取ります。その結果、保存できなかった取引を飛ばして、後の取引が保存されていました。
   - 最小再現：取引 1・2 を保存した後、3 の保存だけを失敗させる。ディスクが戻った直後に同じプロセスで続けると、archive は `[1, 2, 4]` になる。
   - 修正：保存に一度失敗したら、store を開き直すまで取り込みをすべて拒否する。開き直すと、永続化されたカーソルから再開する。
2. **同じポーラーで再開すると、再び飛ばしていた。** `RpcPoll::restore` は、取得したが保存していない署名を「見た」状態のまま残していました。同じポーラーで再開すると、そこでページングが止まり、同じ取引を再び飛ばしていました。
   - 最小再現：上の再現で、開き直した後も同じポーラーを使うと `[1, 2, 4]`。
   - 修正：カーソルが示すものだけを既知とする。

修正後は、どちらも `[1, 2, 3, 4]` になります。

### 追加した試験（commit 1e577a8）

| 試験 | 確かめること | 区分 |
|---|---|---|
| `findex/tests/consistency.rs` の `a_failed_save_stops_until_reopened_then_resumes_without_a_gap` | 保存に失敗したら止まる（以後の取り込みは "reopen" のエラー）。開き直すと抜けも重複もなく再開する | 検出・停止・復旧 |
| `a_crash_inside_a_group_commit_re_pulls_the_tail_from_the_node` | RPC を取得元にして group commit の途中で落ちると、永続化されていない末尾をノードから取り直す | 復旧 |
| `a_restart_then_a_disagreeing_history_stops` | 再起動したとき、archive の最後の取引がノードの履歴にもうなければ、"history gap" で止まる。archive の記録は取り消さない（自動 rollback はしない） | 検出・停止 |
| `limit_a_middle_transaction_that_leaves_history_is_not_noticed` | archive の途中の取引が後で履歴から消えても、気付かない（現状の挙動として固定） | 証明できない |
| `limit_the_first_pull_cannot_see_pruned_history` | 初回の取得では、刈り込まれた古い履歴が欠けていても気付かない（現状の挙動として固定） | 証明できない |
| `herald/tests/consistency.rs` の `a_checkpoint_ahead_of_the_archive_is_discarded_and_the_fold_redone` | archive を古い写しに戻すと、それより先を覆う checkpoint は捨てられ、archive から fold し直す。最後は一度に fold した場合と同じファイルになる | 検出・復旧 |

### 検出・停止・復旧できる範囲

| 区分 | 範囲 |
|---|---|
| 検出して停止する | archive の最後の取引に、後続の履歴がつながらない（刈り込み、fork から外れた、再起動中に変わった）。保存の失敗（archive・索引）。v1 の取引（毎回そこで止まる） |
| 自動で復旧する | group commit の途中で落ちる（再起動すると、ノードから末尾を取り直す）。checkpoint が archive より先にある（fold し直す）。取得の途中の失敗（取れた分を保存し、次の pull で再試行する） |
| 人が復旧する | 保存の失敗（原因を直して store を開き直す）。履歴が食い違う（長い履歴を持つノードに切り替えるか、archive の扱いを決める。自動 rollback は採用していない） |
| 証明できない（検出されない） | 初回の取得、またはカーソルがない・読めない・古い形式のとき。archive の途中の取引が後で履歴から消えたとき。ノードが最後の署名を持ったまま途中だけ欠けているとき。同じ署名の取引の中身がノードによって違うとき（同じ署名は取り直さない） |

findex の記録に「ない」ことも、「ある」ことも、完全な履歴の証明にはなりません。

### 残件

- herald は、findex が止まったことを標準エラーにしか出さない（読み手向けの状態表示はない。④の判断）。
- 索引の保存が失敗する場合は、archive の失敗と同じ経路で止めた。ただし、索引の失敗だけを起こす試験はない（SQLite に失敗させる手段がない）。
- §1〜§5 の 5 点は変わらない。

## 8. ④の最新候補との照合と追加（2026-11-05）

### 照合した候補（完全 SHA で固定）

| 項目 | 値 |
|---|---|
| ④の統合候補 | `d0949fd417180b11704de5690ab0dfb6e5ef3148`（tree `7198d7d962b35044fd0ace7e3ba7604061c1c66c`、2026-11-05）。GitHub の `integration/ws09-13-v16-d0949fd4`、`claude/great-babbage-3ogkqu`、`claude/eager-cerf-k74z5s` の共通の祖先 |
| ⑲の A＋D の取込み | `6b670edb`「integrate locally: 18 v3 fix and 19 A+D on 4.g」 |
| 保存失敗で止める（⑲の E と同じ目的） | `e11bf897`（④）。archive・索引・commit の失敗で poison し、開き直しが必要になる。herald はループを終える（終了コード 2）。索引だけの失敗の試験（`store_failure.rs` の `index_failure_requires_reopen_and_catches_up_from_the_archive`）もある |
| restore で「見た」署名を忘れる | 候補の `ingest.rs` にある（⑲の E と同じ） |
| 保存は finalized の履歴だけにする（残件 3） | `69c572b6`（④）。fork から外れた confirmed の取引は保存されない（`dropped_confirmed_fork_is_not_archived`） |

**⑲の E（`0be5f9f`）は、候補では e11bf897 に置き換わっています。候補に E を当てないでください（二重適用）。** E・F・G は、⑲のブランチ（`38c056e5`）にそのまま残しています。

### 候補の上に加えたもの（ブランチ `ws19/on-d0949fd4`、ローカル）

| commit | 内容 | 再現・試験 |
|---|---|---|
| `b4d4c5f5…`（findex） | **archive の区切りの中の記録が壊れていると、黙って短く読まれていた不具合を直した。** `for_each_after`（herald の再起動の追いつきと、索引の作り直しが使う）は、封印した区切りの中の記録が壊れていると、そこで読むのをやめて次の区切りへ進んでいた。修正後は、区切りが manifest どおりのバイト数・件数・連続した seq を返さなければ、区切りの名前を挙げてエラーにする | 最小再現：10 件のうち、最初の区切りの 2 件目のバイトを 1 つ変えると、修正前は `[1, 3, 4, …, 10]` が返る。`findex/tests/no_hidden_gap.rs` の 4 件（壊れた記録、なくなった区切り、1 件抜けて整った区切り、索引の作り直し）。修正前は 3 件失敗、修正後は全件成功 |
| `e6fb0ee1…`（herald） | **`/h/status` に `ingest` を足した。** 状態（`ok` / `failing` / `stopped`）、最後のエラー、連続失敗の数、いつから、を返す。履歴欠落や v1 取引で pull が失敗し続けても、これまでは標準エラーにしか出ず、画面は古いまま正常に見えていた。成功した pull で消える。checkpoint には入れない。store が壊れた（poison）ときは `stopped` とし、これまでどおりループを終える | `herald/tests/ingest_health.rs` の 2 件。`tests/server.rs` で `ingest.state == "ok"` も確かめる |
| `0d0730b4…`（試験） | ⑲の F（`1e577a8`）の試験を変更なしで移した | 候補の poison の実装の上でも、5＋1 件が成功する |

frontier-node の workspace 全体（候補＋上の 3 commit）：**883 件成功、失敗 0**（2026-11-05）。これは⑲の側の結果で、④が統合版で再実行するまでは統合の成功ではありません。

### 欠落を隠さないという契約（圧縮・封印・checkpoint）

- **archive を読むとき：** 区切りが manifest どおりに読めなければエラーにする（上の修正）。なくなった区切りもエラーになる（既存の挙動を試験で固定）。`verify()` は、長さ・sha256・記録・seq の連続を確かめる（既存）。
- **checkpoint：** archive の commit の後でしか取らない（既存）。保存されている archive より先を覆う checkpoint は捨てて、fold をやり直す（F で試験）。
- **圧縮：** 候補の archive には、圧縮・保持期限・外部保管がまだない。後で入れるときも、上の 2 つを守ること。つまり、区切りごとに manifest の範囲（`first_seq`・`last_seq`・件数）と hash を持ち、読み手は範囲の全件かエラーかのどちらかしか受け取らない。試験 `no_hidden_gap.rs` がこの契約を固定する。

### 残件（④の判断。変わっていないもの）

- v1 取引：候補の fclient も `maxSupportedTransactionVersion: 0` のまま。
- 委任した口座の commit を追う索引の対象：未対応（S1 は委任していない）。
- 継続世界の checkpoint 検証：候補の検証器も、最終状態との完全一致を要求したまま。
- archive の増大：未対応。
- 証明できない条件：初回の取得、カーソルがない・読めない・古い形式、途中の取引が後で消える、途中だけ欠けたノード。§7 と同じで、変わっていない。
- 候補に以前からある clippy の警告：`findex/tests/store_failure.rs:80`（`&PathBuf`）、`keeper/src/journal.rs:431`（型が複雑）。⑲は手を入れていない。
