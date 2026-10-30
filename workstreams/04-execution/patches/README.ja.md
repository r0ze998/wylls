# 共通コア・共有 UI への変更案（未適用）

④は共通コアと共有 UI を変更していない。以下は、④の実行器をより強く、または簡単にするための**案**である。適用するかどうかは、各担当とレビューが決める。差分は説明用の抜粋で、ビルドもテストもしていない。

## P1 SettleCaravan の記録に、加算した量・失った量・識別子を、資源の更新と同じ計算から載せる（program・abi・fclient・findex）

**問題**：vault は `CAP` を超える分を黙って捨てる（`permutation-frontier/src/proc/caravan.rs:1005`）。しかし `CARAVAN_SETTLED` には元の cargo が記録される（`:1037`）。記録だけでは何が入ったか分からない。④は現在、vault 宛てで `credited` が無い到着を `DeliveredUnverified` にしている（`vault_record_without_credit_is_unverified_even_if_balance_matches`）。

**案**（未適用）：

1. **同じ計算から記録する**：資源を書き込むループの中で、各資源について `credited[r] = to − have`、`lost[r] = cargo[r] − credited[r]` を求める。記録は、書き込んだ値から作る（別の計算で作らない）。こうすれば、記録と残高の更新が同じ instruction の中で食い違えない。
2. **欄**（整数単位。`cargo_log` と同じ符号化）：
   - `credited [u32;8]`：宛先に実際に加えた量。
   - `lost [u32;8]`：失った量。`cargo = credited + lost` が常に成り立つ。
   - `loss_cause u8`：`0` なし、`1` 容量超過（vault の `CAP`）、`2` 宛先なし・世代違い（outcome LOST。全量が lost）。
   - 識別子：既存の `owner_tag ‖ seq`（caravan の seed）に加えて、宛先の `Place`（kind、p、q、at、**gen**）と、送信の署名（または `CaravanSent` の log 位置）への参照。これにより、入荷記録と送付記録を名前で結べる。
3. holding 宛ては上限なしで加算するので `credited = cargo`、`lost = 0`（現行の規則から導ける。④は `RuleDerived` として扱っている）。
4. 襲撃（`CARAVAN_RAIDED`）の burn も同じ形で `lost` と `loss_cause = 3`（burn）を記録すると、損失の会計が一つの形にそろう（任意）。

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
+                credited[r] = to - have;          // what the write added
+                lost[r] = *c - credited[r];       // what it dropped
+            }
 …
-        .bytes(&cargo_log(&cargo))
+        .bytes(&cargo_log(&cargo))
+        .bytes(&cargo_log(&credited))
+        .bytes(&cargo_log(&lost))
+        .u8(loss_cause)
```

影響：verify V23 の replay（`credited + lost = cargo` と、残高の変化 = `credited` の検査を追加できる）、herald の表示、findex、fclient の `CqEvent::CaravanSettled`、log の長さの表（`frontier-abi::log`）、CU の測定、①の進捗と⑥の成果の計上（検証済みの量だけを数える。CONTRACTS §7、§9）。

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
