# 13 検証器 r6: 0004 の照合と、残っていた PASS の経路（2026-11-06）

**起点。** GitHub の `claude/kind-fermat-earbxe` @ `2aceaf4770878d001457f29eb6007bc70f07de8b`。**統合候補** `integration/ws09-13-v16-d0949fd4` は先端が `ef63544c727490fc6801d30affd11c5b7106c480` に進んでいた（2026-11-06。検証器への変更は fclient の 1 行と findex の試験だけで、⑱の V0 と 0003 はそのまま）。

**採用していないもの（変わらず、有効化していない）:** 案 B、Burn、運営の緊急停止、新しい世界効果。

## 1. 0004 の照合（統合候補 `ef63544c`）

- 0004 は `ef63544c` に `git apply --check` で当たり、当てた木で 0004 の試験（`tests/evidence.rs`）はすべて通る（§4）。
- **⑯の P1（`claude/dreamy-ramanujan-ijj8qj` の `verification/16-independent/patches/P1-verify-unknown-tag-and-cpi-shape.patch`）との関係:**
  - P1 は基点 `4cd901de` 向けで、**`ef63544c` には当たらない**（`codes.rs` が⑱の V0 の追加と衝突）。
  - P1 の「知らないタグ・予約タグ → FAIL `UnknownInstruction`」は、統合候補では⑱の V0 が同じ判定で実装済み。
  - P1 の「CPI 形（プログラムを口座に挙げるが最上位で呼ばない）→ UNVERIFIABLE」は、0004 の V0E が**ログの `invoke [n]`（n > 1）**で判定する部分と重なる。P1 はログを見ないので、ログが「プログラムは動いていない」と示す取引（無害な言及）も UNVERIFIABLE にする。0004 は見逃していた逆の場合（**ログが無い CPI だけの取引**）を r6 で塞いだ（§2）。
  - P1b（判定の無い既知タグに WARN）は、⑱の V0 の `UnverifiedInstruction`（UNVERIFIABLE）が上位互換。
  - したがって統合候補では、⑱の V0 ＋ 0004 ＋ 0005 で P1 の 3 項目を覆う。P1 を当てるかは④・⑯の判断（⑪は P1 を変えていない）。

## 2. 残っていた PASS の経路と r6（パッチ 0005、0004 の上に当てる）

同じ試験ファイルを、`ef63544c`＋0004 の木（修正前）と `ef63544c`＋0004＋0005 の木（修正後）で走らせた。

| 経路 | 修正前（0004 まで）に PASS | 修正後 | r6 の判定 |
|---|---|---|---|
| CPI だけの取引（プログラムは口座に名があり最上位で呼ばれない）で、**ログが無い** | **140 件中 7 件** | 0 | `MissingLogs`（ログが無いので、動いたかどうかも分からない） |
| ログの末尾が `Log truncated` の印なしに失われた（最後の `Program data:` 行から後を削り、記録が少なくとも 1 つ消える） | **338 件中 134 件** | 0 | 新しいコード `IncompleteLogs`（成功した取引では、プログラムの呼出しはどれも `Program <id> success` で終わる。終わりの行が足りない） |
| 0004 で塞いだもの（CPI、印つきの切断、ログ無し、Holding 以外の post-state） | 0 | 0 | 変更なし |
| **対照:** プログラムを口座に挙げるだけで、ログが「動いていない」と示す取引 | — | V0E は**報告しない** | 無害（V2 の警告のまま）。P1 より狭い |

記録済みの 3 fixture（land、march-synth、march-program）は PASS のままで、V0E の所見は出ない（`IncompleteLogs` の偽陽性なし）。

## 3. ③・④・⑯との分担

| 残り | 理由 | 担当 |
|---|---|---|
| CPI の**内側の命令の判定**（UNVERIFIABLE を PASS／FAIL にする） | 索引（findex）が `meta.innerInstructions` を保存し、検証器が内側の命令を集める必要がある。③のパッチ 0002（方針）が出発点 | **③**（courier と内側の命令の形）＋**④**（findex・verify の共有コア） |
| post-state の無い closer の取引（CloseArrivalDay・CloseArrivalSlot） | 記録側で `None` の post-state を書けば例外が要らない | **④**（localnet・findex） |
| archive の真正性（message とログの食い違い、署名の再検査なし） | 既存の検証器の設計（`tamper.rs` 179–181 行） | **④** |
| P1 の採否 | 統合候補に当たらない。⑱の V0＋0004＋0005 との重なりは §1 | **④・⑯** |
| ログの上限（ランタイムが `Log truncated` を付ける量）に近い取引の扱い | `Log truncated` は V0E が UNVERIFIABLE にする。上限に当たらないよう命令ごとの記録量を抑えるかは設計判断 | ④ |

## 4. 試験（2026-11-06）

**鍵の生成・導出・署名を伴う試験は行っていない。** 実行しなかったもの: `tamper`（`t10` が `TestKey::new()`、`t20_injected` が `Keypair::new_from_array` と `tx::build` で署名）、⑱の `coverage`（取引を組み立てて署名）、`record`（localnet で鍵を作って署名）、`fixtures::march_fixture_is_fresh`（合成 fixture を作り直し、署名する）。creation-bridge の `k03`–`k07`（⑥の署名の**検証**を含む）も今回は走らせていない（コードは r5 から変えていない。r5 では通過）。

| 対象 | 結果 | ログ |
|---|---|---|
| 検証器（`ef63544c`＋0004＋0005）: lib 13、unit 8、fixtures 8（1 件除外）、camp_clear 3、missing_state 2、open_items 3、evidence 8 | **45 件通過**、fmt・clippy `-D warnings`（`-p verify --no-deps`、Rust 1.95.0）通過。証拠の欠けた 1,380 件で PASS 0 | `results/verify-evidence-after-r6.log` |
| 同、0004 まで（修正前） | 上表の 7 件・134 件が PASS | `results/verify-evidence-before-r6.log` |
| creation-bridge: `k01`・`k02`・`k08`–`k11` と doctest 3 件（公開状態と実行状態が相互に変換できないこと: 変換は 2 件ともコンパイルできない、同じ import は通る） | **6 件＋3 件通過**、fmt・clippy 通過 | `results/creation-bridge-tests-r6.log` |
| ext-kernel | 43 件通過、fmt・clippy 通過 | `results/ext-kernel-tests-r6.log` |

**⑥との契約。** ⑥の GitHub 上の木は `517796dc` のまま（`workstreams/06-creation` の tree `a4a20f03…` は 1 種類だけ）なので、r5 の契約（期待値は⑥のこの commit から生成）はそのまま有効。r6 で足したのは、⑥の公開状態（listed／suspended／withdrawn）と⑪の実行状態（Active／Paused／Revoked）が**別の型で、どちらの向きにも変換できない**ことの契約試験（`k11` と doctest）。

## 5. ④へ渡すもの

| 順 | パッチ | 当て先 | SHA-256 |
|---|---|---|---|
| 1 | `patches/0004-verify-v0e-evidence-is-unverifiable.patch` | `integration/ws09-13-v16-d0949fd4`（`ef63544c` で確認） | `258ad75901a637c97f4df06655b2d01b4f744a255eff8bbeacfb6ff22dd21660` |
| 2 | `patches/0005-verify-v0e-cpi-only-and-lost-tail.patch` | 1 の後 | `09beb7bce149c3628f516f1b6285c090e9f159ea1b7fb916fcd0e304f4067639` |

`ef63544c` に 1→2 の順で当てた木が、試験した木と一致することを `diff -r` で確かめた。0001 は当てない（⑱の V0 と食い違う。取り下げ済み）。0003 は統合候補に適用済み。
