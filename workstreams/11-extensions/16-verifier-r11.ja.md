# 16 検証器 r11: JoinResident の証明口座の正規アドレス（2026-11-06）

**許可の範囲（オーナー、2026-11-06）。** PDA と `create_with_seed` で公開アドレスを計算することは、試験のコードでもプログラムの中でも許可された。鍵ペアの生成・導出と署名は、固定 seed、共通のセットアップ、CI を含めて、引き続き禁止。

**起点。** ⑳の `claude/funny-wozniak-cy4n64` @ `b2f7beccd…`（以下 `b2f7becc`）。これは④の候補 `6984acfa` に、次を足したもの:
- ⑳ `4b233e4a`（V28）
- ⑳ `b2f7becc`（`fclient::addr` の resident 用の PDA の関数）
- ④向けの文書のパッチ 1 件（`6702b0e2`）

0011 は `fclient::addr::{resident_policy, resident_link, resident_account}` を使うので、`b2f7becc` が要る。

## 1. 実装（パッチ 0011。`checks/v27_residents.rs` だけ）

JoinResident の口座 `[owner] [payer] [season] [frontier] [citizen] [system] [policy] [link] [asset] [resident] [join_gate?]` のうち、r9 で照合したもの（Season 2、Frontier 3、Citizen 4）に、次を足した。どれもプログラムの `resident_binding::canonical` と同じ seed で計算する。

| 口座 | 正しいアドレス | 違うとき |
|---|---|---|
| policy（6） | `["nft-resident-policy"]` を Frontier プログラムで PDA にしたもの | FAIL `NonCanonicalAddress` |
| link（7） | `["nft-citizen-link", season, asset]` を Frontier プログラムで PDA にしたもの（Season ごとに 1 つ） | FAIL `NonCanonicalAddress` |
| resident（9） | `["resident", asset]` を、policy が指す resident program で PDA にしたもの | FAIL `NonCanonicalAddress` |

- **policy の中身（resident program）の取り方:**
  1. archive 中の成功した CreateResidentPolicy の命令データ（その口座 1 が policy）
  2. 1 が無ければ、archive にある policy 口座の状態（post-state か最終状態。Frontier プログラムが所有し、`resident_policy::read` で読めるもの。一度だけ書かれる）
- **どちらも無いとき:** resident の口座は判定しない。UNVERIFIABLE `MissingData` にする（PASS にはしない）。所有者が Frontier プログラムでない口座は policy として扱わない。
- **r9 の検査は変えていない:** 記録、時刻、Citizen と link の post-state、重複。

## 2. 試験

**禁止操作が無いことの確認（試験を走らせる前に、呼び出し先までたどった）。**

- **PDA の計算:** `solana-address 2.6.1` の `find_program_address` → `try_find_program_address` → `create_program_address`。中身は seed と program の SHA-256 と、曲線上の点かどうかの確認（`CompressedEdwardsY::decompress`）だけ。鍵ペア、乱数、署名は無い。
- **`with_seed`:** SHA-256 だけ。
- **`verify()` の本体（`lib.rs`、`checks/`、`world.rs`、`facts.rs`、`input.rs` など）と、lib の `#[cfg(test)]` の試験:** `Keypair`、`TestKey`、`sign`、`new_unique`、`tx::build`、`fixture::` を使わない。検証器は記録済みの BLS 署名を**確かめる**だけで、署名を作らない。
- **鍵ペアと署名を使うコード:**
  - lib の `src/fixture/`（固定 seed の `Keypair::new_from_array` と、`TestKey` による署名）、`src/tamper.rs`、`tests/common/mod.rs` の `world`・`record`・`try_send`
  - これらを呼ぶ試験は `record.rs`、`tamper.rs`、`coverage.rs`、`fixtures::march_fixture_is_fresh`。**どれも走らせていない。**
- **走らせた結合試験（unit、camp_clear、missing_state、open_items、evidence、new_bands、fixtures）:** `tests/common` から呼ぶのは、記録済み JSON を読む `land`・`march`・`march_program`・`fixture`・`show` だけ。`unit.rs` は、記録済みの BLS 署名の 1 byte を反転させる（署名し直しはしない）。
- **CI:** 起動していない（push は `[skip ci]`）。

**新しい試験（V27、lib）。**
- `the_resident_proof_accounts_are_canonical`:
  - 正常例: policy、link、resident が PDA にある → 所見 0 件。
  - policy、link、resident をそれぞれ別のアドレスに差し替える → FAIL。
  - 別の resident program の resident 口座 → FAIL。
  - 別の Season の link → FAIL。
- `a_policy_the_archive_does_not_show_leaves_the_resident_unverifiable`:
  - policy が archive に無い → UNVERIFIABLE `MissingData`。
  - policy 口座の所有者が違う → UNVERIFIABLE `MissingData`。
  - CreateResidentPolicy が archive にある → policy をそこから取り、所見 0 件。
- r9 の 5 件は、正常例を正規アドレスに合わせて、すべて通った。

**許された全試験**（`b2f7becc`＋0010＋0011）: **72 件通過**。内訳は lib 33（⑳の V28 と⑪の V27 7 件を含む）、unit 8、fixtures 8（1 件除外）、camp_clear 3、missing_state 2、open_items 3、evidence 8、new_bands 7。fmt と clippy `-D warnings` も通った。ログは `results/verify-after-r11.log`。

## 3. ⑲の履歴判定との整合

⑲の `history.rs`（bundle `ws19-on-6984acfa-r2` / `c022f4fc`）は GitHub に無く、⑪は取得できていない。なので**実際のコードと合わせては試していない**。⑲が伝えてきた規則と照らし合わせた結果が次のとおり。

| 項目 | ⑲の規則 | 0011 の判定 |
|---|---|---|
| V27 の FAIL は self_contained（履歴が不完全でも、FAIL なら verdict は FAIL） | V27 はすべて self_contained | 足した 3 つの住所は、命令の口座、program、Season、asset から決まり、取引の中だけで決まる。resident の FAIL は policy の値にも依存する。policy は一度だけ書かれ、join が成功したときには既にあった（プログラムが読む）ので、archive にある値が join のときの値と同じになる |
| UNVERIFIABLE | そのまま | policy が archive に無いとき `MissingData`。履歴が完全かどうかに関わらず PASS にならない |
| V0 の Undecodable | self_contained から外した（⑪ r10 §7 の指摘） | 0011 は V0 を変えていない |

**未確認:** ⑲の `history.rs` と 0011 を同じ木に入れて試験すること。④が両方を統合したときに確かめる。

## 4. 当てる順（④向け）

| 順 | 何 | 当て先 | SHA-256 |
|---|---|---|---|
| 1 | ⑪ `patches/0010-verify-v0-allocated-tag-without-program-version-on-ws04-6984acfa.patch` | `6984acfa` | `6c8fe8342e4f0a8f45a0d7ef24bba5c608a34ef59b9fddd896d77a47e1cc691a` |
| 2 | ⑳ `4b233e4a`、`b2f7becc`（`claude/funny-wozniak-cy4n64`） | 1 の後（⑳の変更は V0 と new_bands に触れないので、順は入れ替えてもよい） | — |
| 3 | ⑪ `patches/0011-verify-v27-resident-proof-accounts-canonical-after-ws20-b2f7becc.patch` | 2 の後（`fclient::addr` の関数が要る） | `f59e1ab5c870d8adb9147611481f19152d1e843d2df464767dd37425073f253c` |

`b2f7becc`＋0010＋0011 の tree は `9a9e49e0b1e38b516d29b9a6cff6afa386b7538a`（試験した木）。

## 5. 実装・試験・未確認の区別（④・⑯向け）

| 区分 | 中身 |
|---|---|
| **実装した** | V27 の policy、link、resident の正規アドレスの照合。policy の中身の取り方（CreateResidentPolicy の命令、または archive の状態）。policy が無いときは UNVERIFIABLE |
| **試験した** | 上の新しい試験 2 件と、r9 の 5 件（正規アドレスに合わせたもの）。許された全試験。fmt と clippy `-D warnings`（Rust 1.95.0）。どれも鍵ペアと署名を使わない（呼び出し先まで確かめた） |
| **未確認** | NFT 版の Season を丸ごと `verify()` に通して PASS になること（記録済みの fixture が無い。作るには鍵ペアと署名が要る）。⑲の `history.rs` と同じ木で試すこと。CI。チェーン上の動作。asset（Core）の所有者と guard、resident program の現在の世代（archive に証拠が無い。r9 §2 と同じ） |
