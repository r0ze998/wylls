# 共通コア・共有 UI への変更案（未適用）

④は共通コアと共有 UI を変更していない。以下は、④の実行器をより強く、または簡単にするための**案**である。適用するかどうかは、各担当とレビューが決める。差分は説明用の抜粋で、ビルドもテストもしていない。

## P1 SettleCaravan の記録に、加算した量・失った量・識別子を、資源の更新と同じ計算から載せる（program・abi・fclient・findex）

**問題**：vault は `CAP` を超える分を黙って捨てる（`permutation-frontier/src/proc/caravan.rs:1005`）。しかし `CARAVAN_SETTLED` には元の cargo が記録される（`:1037`）。記録だけでは何が入ったか分からない。④は現在、vault 宛てで `credited` が無い到着を `DeliveredUnverified` にしている（`vault_record_without_credit_is_unverified_even_if_balance_matches`）。

**案**（未適用）：

1. **同じ計算から記録する**：資源を書き込むループの中で、各資源について `credited[r] = to − have`、`lost[r] = cargo[r] − credited[r]` を求める。記録は、書き込んだ値から作る（別の計算で作らない）。こうすれば、記録と残高の更新が同じ instruction の中で食い違えない。
2. **単位・精度・丸め・範囲を、次の二つの案のどちらか一つに決める。二つを混ぜない**（一つの記録の中で、また記録の版をまたいで、同じ欄名に別の意味を持たせない）。前提：program の内部の量は milli 単位の `i64`（1 単位＝1000。holding の `Accrual`、vault の `VA::store`・`CAP`、caravan の `CV::cargo`）。今の記録の `cargo` は `cargo_log`：`floor(max(v,0) / 1000)` を `u32` に飽和させた値（`proc/caravan.rs:401-407`）。

   **案 A：milli のまま記録する（正確な量）**

   | 欄 | 型・単位 | 精度・丸め | 範囲・関係 |
   |---|---|---|---|
   | `cargo_milli [i64;8]` | milli | 正確（丸めなし） | settle の時点の積荷（損耗の後）。`0 ≤ cargo_milli ≤ 送付量 × 1000` |
   | `credited_milli [i64;8]` | milli | 正確 | 宛先に書き込んだ差分 `to − have`。`0 ≤ credited_milli ≤ cargo_milli` |
   | `lost_milli [i64;8]` | milli | 正確 | `cargo_milli − credited_milli`。**`credited_milli + lost_milli = cargo_milli` が常に成り立つ** |
   | `loss_cause u8` | — | — | `0` なし、`1` 容量超過、`2` 宛先なし・世代違い（全量 lost） |

   - ④の扱い：`Recorded` は**正確な量**。依頼量 × 1000 以上なら Fulfilled（証明）、未満なら**未達を証明できる** Partial、0 なら KnownZero。④の `Settle` port に `credited_milli` を足す（今の `credited: Res` は整数なので、そのままでは受けられない）。
   - 記録の長さ：+200 バイト程度（3 × 64＋1。CU と log の長さの表に影響）。

   **案 B：整数に切り捨てて記録する（下限）**

   | 欄 | 型・単位 | 精度・丸め | 範囲・関係 |
   |---|---|---|---|
   | `credited_floor [u32;8]` | 整数単位 | `floor(credited_milli / 1000)`（`cargo_log` と同じ丸め・同じ飽和） | `0 ≤ credited_floor ≤ cargo`（記録の cargo）。**実際の加算量の下限**：資源ごとに 1 未満多く入っていうる |
   | `loss_cause u8` | — | — | 案 A と同じ |

   - `lost` は記録しない。切り捨てた値どうしでは `credited + lost = cargo` が成り立たず、和の関係を約束できないため（混ぜない）。
   - ④の扱い：今の実装のまま。`Recorded` は下限で、下限が依頼量以上なら Fulfilled、未満なら Partial（未達の証明ではない）、**0 でも KnownZero にしない**（`fraction_below_one_unit_is_not_known_zero`）。
   - 記録の長さ：+33 バイト。

   どちらの案でも：値は資源を書き込むループの中で、書き込んだ値から作る（別の計算で作らない）。識別子は既存の `owner_tag ‖ seq` に加えて、宛先の `Place`（kind、p、q、at、**gen**）を載せる。burn（CARAVAN_RAIDED）は今も caravan の milli を 0 にするので、burn の記録があれば 0 は正確である（案に関係なく KnownZero）。

3. holding 宛ては上限なしで加算するので、案 A なら `credited_milli = cargo_milli`、案 B なら `credited_floor = cargo`（今の記録の cargo と同じ値で、新しい情報は無い）。④は今、holding を `RuleDerived`（整数の下限）として扱っている。
4. 選ぶ基準：①⑮が「目標に届かなかった」と**証明**したいなら案 A が要る（案 B と今の記録では、下限が目標未満でも未達とは言えない。複数の隊商の端数を足すと届いているかもしれない）。達成の証明だけでよいなら案 B で足りる。

```diff
 // proc/caravan.rs settle_caravan, vault branch（説明用の抜粋。ビルドしていない）
-            for (r, c) in cargo.iter().enumerate() {
-                let have = Ro(&vd).i64(VA::store(r))?;
-                let to = have.saturating_add(*c).min(cap.max(have));
-                Rw(&mut vd).set_i64(VA::store(r), to)?;
-            }
+            for (r, c) in cargo.iter().enumerate() {
+                let have = Ro(&vd).i64(VA::store(r))?;
+                let to = have.saturating_add(*c).min(cap.max(have));
+                Rw(&mut vd).set_i64(VA::store(r), to)?;
+                credited_milli[r] = to - have;    // what the write added (milli)
+                lost_milli[r] = *c - credited_milli[r]; // option A only
+            }
 …
-        .bytes(&cargo_log(&cargo))
+        .bytes(&cargo_log(&cargo))
+        // option A: cargo_milli, credited_milli, lost_milli as i64 LE (exact)
+        // option B: cargo_log(&credited_milli) only (floor, a lower bound)
+        .u8(loss_cause)
```

影響：verify V23 の replay（案 A なら `credited_milli + lost_milli = cargo_milli` と、残高の変化 = `credited_milli` の検査を追加できる。案 B では下限の検査だけ）、herald の表示、findex、fclient の `CqEvent::CaravanSettled`、log の長さの表（`frontier-abi::log`）、CU の測定、①の進捗と⑥の成果の計上（検証済みの量だけを数える。CONTRACTS §7、§9）。

**適用しない**：共有コアへの変更なので、program の担当とレビューの判断を待つ。

## P2 SendCaravan の seq 不一致を専用のコードにする（program・abi）

**問題**：`x.seq != Citizen.CARAVANS` は `BadData` になる（`proc/caravan.rs:695`）。これは cargo が空の場合などと区別できない。

**案**：`CqError::SeqTaken` を追加し、`err::is_done` の対象にする（AlreadyDone と同じ扱い）。④は正本の読み取りで判断しているので必須ではないが、監視と調査の助けになる。

## P3 施設の使用を、要求キー付きの一つの命令にする（②③・program）

**問題**：施設の使用と利用権の命令が存在しない。

**案**（④からの要件。設計は②③が決める）：
- `UseFacility(key: [u8;32], facility, recipe, inputs, rights_ref)`：材料の消費、利用権の検査と消費、産出を**一つの transaction の中で原子的に**行う。
- `key` を PDA の seed にした記録の account（または既存の account の使用済みの集合）で、二度目を `AlreadyDone` で拒否する。`facility_use(key)` で記録を引けるようにする。
- log `FACILITY_USED{key, consumed, produced, rights_units}` を追加する。

## P4 共有 UI：発送と到着、積んだ量と届いた量を分ける（web）

**案**：隊商の依頼の進捗を、STATE-MACHINE の表示の表に合わせる。「発送を受け付けた（未確定）」「輸送中 n 個（積んだ量）」「到着 n 個（届いた量。未確認ならその旨）」。部分輸送の時間を、不足分が全部そろう時間として表示しない。④は UI のファイルに触れていない。

## P5 keeper に実チェーン用の adapter を追加する（frontier-node、④の次の段階）

**案**：`fclient::ports::ChainPort` の上に、④の `Chain` trait を実装する（`KeeperChain`）。
- `place`：`accounts([holding|vault], min_slot)` を decode し、holding は `stock_at(now)` で精算する。
- `caravan_seq`：Citizen v2 の `CARAVANS @313`。
- `caravan`：`cv ‖ owner_tag ‖ seq` の account。
- `prepare`：署名者は session key。許可表 `policy::AUTOMATABLE` にある命令だけを組み立てる。`valid_until = blockhash の slot + 151`。
- `status`：`statuses`。有効期間を過ぎて `None` なら `Absent`。
- `events`、`caravan_history`：feed と findex の entity 索引。

trait が同期なので、tokio の runtime の上では `block_on` で包むか、trait を async にする。どちらにするかは frontier-node の担当と決める。

## P6 session key に命令の範囲を持たせる（program・agent wallet）

**問題**：Citizen の session key は一つで、有効期限はあるが**命令の範囲が無い**（`frontier-abi/src/prologue.rs:1120-1131`）。物流だけを任せたい実行者や agent の鍵でも、session 可の命令すべて（Depart、RaidCaravan など）に署名できる。④の許可表と agent wallet の許可リストは off-chain の制限で、seed を持つ者は RPC へ直接送って回避できる（`docs/agent-wallet/DESIGN.md`）。

**案**（未適用）：Citizen に `SESSION_SCOPE`（命令の bitmask、または命令群の id）を加え、`SetSession`（wallet の署名）で設定する。prologue で `by_session` の場合に、命令が範囲の中にあるかを検査する。④の実行器には `SendCaravan` だけの範囲を渡す。

影響：Citizen の layout（予約領域を使う）、`SetSession` の引数、prologue の検査、agent wallet の `SetSession` の呼び出し、全命令の CU。①⑤の判断が必要。
