# 共通コア・共有 UI への変更案（未適用）

④は共通コアと共有 UI を変更していない。以下は、④の実行器をより強く、または簡単にするための**案**である。適用するかどうかは、各担当とレビューが決める。差分は説明用の抜粋で、ビルドもテストもしていない。

## P1 SettleCaravan の記録に「入った量」を載せる（program・abi・fclient）

**問題**：vault は `CAP` を超える分を黙って捨てる（`permutation-frontier/src/proc/caravan.rs:1005`）。しかし `CARAVAN_SETTLED` には元の cargo が記録される（`:1037`）。そのため、記録だけでは何が届いたか分からない。④は今、到着を「未確認」として `Partial` にしている（`capacity_clip_gives_partial`）。

**案**：`CARAVAN_SETTLED` の payload に `credited [u32;8]`（整数単位）を追加し、`l2` の log の版を上げる。holding（上限なし）では cargo と等しくなる。

```diff
 // proc/caravan.rs settle_caravan, vault branch
-            for (r, c) in cargo.iter().enumerate() {
-                let have = Ro(&vd).i64(VA::store(r))?;
-                let to = have.saturating_add(*c).min(cap.max(have));
-                Rw(&mut vd).set_i64(VA::store(r), to)?;
-            }
+            for (r, c) in cargo.iter().enumerate() {
+                let have = Ro(&vd).i64(VA::store(r))?;
+                let to = have.saturating_add(*c).min(cap.max(have));
+                credited[r] = to - have;
+                Rw(&mut vd).set_i64(VA::store(r), to)?;
+            }
 …
-        .bytes(&cargo_log(&cargo))
+        .bytes(&cargo_log(&cargo))
+        .bytes(&cargo_log(&credited))
```

影響：verify V23 の replay、herald の表示、findex、fclient の `CqEvent::CaravanSettled`、log の長さの表（`frontier-abi::log`）、CU の測定。

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
