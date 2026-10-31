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
