# 継続世界への対応（⑲の担当範囲：MagicBlock の委任・commit・解除、公開 RPC の追従と復旧）

2026-10-31 の方針訂正（シーズン制を廃止し、世界が継続する）を受けた報告です。範囲は⑲の担当だけです。共有コア（口座・版・識別子・実行経路）は④が、継続世界の横断設計は⑧が、それぞれ統合します。⑲は独自の World／Period の正本や移行処理を作っていません。

## 1. 残っていたシーズン依存

| 箇所 | 依存 | 根拠 |
|---|---|---|
| 旧版の委任（permutation-chain） | 委任は Running の間だけ、対象ごとにシーズンに 1 回だけ（`Season::delegated` のビット。戻した対象は二度と送らない）。解除は「最後の tick の後」に決まった順で（`meta.finished`）。脱出は「実行期限の後」か、シーズンの Finalized／Aborted の後だけ。Running 中にロールバックすると FinishSeason が拒否し、シーズンは返金で終わる | `permutation-chain/src/processor/delegation.rs:73-84,207-219`、`escape.rs:138-170,220-` |
| 旧版の commit の担当 | crank の commit は「最後の tick の直後まで」。解除が始まったら、もう commit しない | `delegation.rs:220-228` |
| findex のアドレス文脈 | `Findex::open(program, season_id)` が、Season PDA から、ログが示す口座の住所を求める（`addr_ctx`）。RpcPoll はプログラム全体を追うので期間に依存しないが、索引の住所は 1 つの Season ID に結び付く | `findex/src/lib.rs:44-75` |
| herald の取り込み | `--season ID` が必須。fold は `season_of(data) == cfg.season_id` の口座だけを捕まえる | `herald/src/main.rs:119`、`fold.rs:432-437` |
| 検証器の「最終状態」 | 最終の口座の head が、再生した head と**完全に一致**することを要求する（違えば HEAD_MISMATCH）。静かに終わったシーズンの後でしか成り立たない。世界が続くと、保存の終わりから最終状態を読むまでの間の書込みで失敗する。委任中の口座（所有者 DLP）も失敗する | `verify/src/checks/v1_chains.rs:286-297` |
| 検証器の読取り | Clock は既定の確定度（finalized）で、口座は `confirmed`＋minContextSlot で読み、100 件ごとに別の slot になりうる。1 つの時点の写しではない | `verify/src/input.rs:260-278` |
| findex の保存量 | アーカイブは追記だけで、保持期限も圧縮もない。SQLite の索引も同じ。世界の寿命の間、増え続ける | `findex/src/archive.rs`（retention なし） |
| findex の取引版 | `maxSupportedTransactionVersion: 0` で取る。委任を使うと、v1 取引でプログラムの履歴取得が止まる（実測） | `fclient/src/rpc.rs:153-166` |

## 2. 変更した挙動

| 変更 | 場所 |
|---|---|
| **委任セッションを期間から切り離した。** セッションが閉じるのは、commit の予算・検証者の交代・保守のときだけ。戦期の境界は計画器の入力にない。終了したセッションの後は再委任し、板の `(seq, head)` は一本の鎖で続く。旧版の「一度だけ」「シーズンの終わりに解除」「シーズン後の脱出」は使わない | `frontier-er/src/plan.rs`、`program/src/lib.rs` |
| **板は終わりの時刻を持たない。** 世界の ID だけを持つ（S1 の連鎖ヘッダでは `season_id` の位置）。脱出（ロールバック）の後も同じ板で書込みと再委任が続く。何も没収されない（失うのは commit していない ER の書込みだけで、印とログで記録する） | `frontier-er/src/board.rs`、`program/src/lib.rs` |
| **検証者の交代を、世界を作り直さずにできるようにした。** 「退く検証者」を一時的に信頼し、対象を戻してから新しい検証者に委任する | `guard.rs`（`Policy.retiring`）、`plan.rs` |
| **公開 RPC の履歴欠落で止まるようにした。** 欠落を黙って保存しない。長く追従するほど、ノードの刈り込みに当たる | `findex/src/ingest.rs` |
| **minContextSlot の読取りに印を付けられるようにした。** 取引直後の状態だと保証できない読取りを、検証済みに昇格させない | `findex/src/provenance.rs` |
| **ER が書込みを失ったら止めるようにした**（実測に基づく）。high-water と、`(seq, head)` の compare-and-set | `guard.rs`、`board.rs` |

## 3. 試験で確認したこと

| 層 | 確認 |
|---|---|
| mock | 10 戦期（1440 bell）の間、毎 bell 書き、12 bell ごとに keeper が動く。10 以上のセッションで、どのセッションも commit は 9 回以下。最後に戻した base の head は、すべての書込みの再生と一致し、口座の大きさは一定。期間の境界をまたぐセッションで何も起きない。セッション終了を予約した直後に keeper を再起動しても、二重にも欠けもしない。検証者の交代 |
| ローカル（LiteSVM＋実物の委任プログラム 3 種） | 脱出の後も同じ板で書込みと再委任が続く |
| ローカル（base＋ER） | 1 つの板で、委任 → ER → commit → 解除 → base で書込み → 再委任 → ER の停止と再開 → 解除 → 再委任、と続けて seq 1→16。ER のストレージを失うと停止する（ErRegressed） |
| findex | 履歴欠落の試験（修正前は失敗）。workspace 全体の試験が通る |

**通過できることと、長く続けられることは別に検証する方針**ですが、⑲の範囲で長期について確かめたのは mock の 1440 bell だけです。ローカルで長時間は走らせていません。

## 4. 移行や仕様判断が残る点

| 項目 | 判断する人 | 提案 |
|---|---|---|
| Season PDA を世界の識別子として使い続けるか | ④・⑧ | ④の案（統合枝 `ws04/integration-20261030`、`docs/CONTINUITY.ja.md`、2026-10-31 に④から受領）では、今の Season PDA を世界の口座として使い続け、すべての住所をそこから導く。この候補の板は、別のプログラムの PDA `["wylls-er-board", le64 world_id, authority]` で、Season PDA とは結び付いていない。S1 のプログラムに取り込むなら、seed を `["wylls-er-board", Season PDA]` にする（authority の検査は、Season の authority を読む形にする）（委任には PDA であることが必要で、`create_with_seed` の住所は使えない） |
| 検証器の「最終状態」の意味 | ④・⑯ | 静かな終わりを前提にしない「checkpoint」の比較。(a) 最終状態の head の seq が再生と同じなら一致を要求する。(b) より先なら「保存より先の部分は未検証」と報告し、失敗にしない。(c) 所有者が DLP なら「委任中：最後の commit まで」と報告する。もう 1 つの方法：口座の読取り（context slot）を先に記録し、保存をその slot まで進めてから比べる |
| findex の取引版と、委任された口座の履歴 | ④（fclient は共有コア） | `maxSupportedTransactionVersion` を 1 以上で要求する。v1 の取引は解釈できなくても記録だけはする。委任対象を持つなら、その口座のアドレスでも履歴を取る（commit の finalize はそこにしか現れない） |
| findex の確定度 | ④ | `confirmed` で保存し、後から取り消せない。`finalized` で取るか、確定したことの印を後で付ける |
| findex・アーカイブの長期の増加 | ④・⑧ | 区切りごとの封印と外部保管。索引を作り直せる範囲の取り決め。期間ではなく大きさや時間で区切る |
| ER の履歴保持期間 | 未確認（公開 ER） | ER の書込みを検証するには、ER のログを保持期間内に取り込む必要がある。保持期間が分かるまでは「未検証」 |
| 長く続けたときの費用 | ⑰・運用 | セッション費と commit 費。delegated fee payer を使うかどうか |
| 板の用途 | 所有者 | 決めていない。価値・所有・得点は置かない |
