# 17 検証器 r13: 公開統合候補 cf517b55 での ABI と coverage の契約（2026-11-08）

**起点。** ④の公開統合候補 `claude/gallant-ride-cunptv` @ `cf517b558d1303a84dba618550f40cb460b7ad99`。⑪の 0010、0011、0012（`6cd6dd14`）と、④の `52c0bd45`（合成 march の既知の 6 件を正確に固定）が入っている。

**守っていること（変わらず）:**
- 鍵ペアの生成・導出と署名は使わない。固定 seed、CI、呼び出し先を含む。
- 公開アドレスの計算（PDA、with_seed）だけを使う。
- 試験は、呼び出し先まで監査したものだけを走らせる。
- 実取引、本番配備、有料 API は使わない。
- 未決のルールは決めない。
- 案 B、Burn、運営の緊急停止は有効化しない。

## 1. 照合したこと（候補の木）

| 契約 | 候補での事実 | 判定 |
|---|---|---|
| 命令（`v2::Ix`）すべてに V0 の答えがあるか | 0xC0 FastForward、0xC1 ExtendFrontier（⑧、V26 の map-growth が S1 で扱う）、0xC2–0xCC は⑩の custody 11 命令。`supported()` が扱わないのは CloseMarch、FastForward と custody 11 命令 | 扱わない命令は `UnverifiedInstruction`（UNVERIFIABLE）。⑱の試験（`every_abi_tag_has_a_coverage_answer`）と、⑪の鍵なしの試験（§2）で確かめた |
| conquest の記録の種別（80–113、130） | 80–88、90–104 は `MODELLED`。104（FRONTIER_EXTENDED）は V26 の map-growth が ExtendFrontier と照合する。105–113 は `GUARDED`（⑩の V26 の guard）。130 は `CONDITIONAL`（V27） | 仕掛けの試験が通る。扱わない種別は `UnverifiedRecord` のまま |
| ABI の外のタグ | ② 0xD0–0xD5 と ⑨ 0xF0–0xFD は、プログラムに入っていない（`rights.rs` が無く、⑨のプログラムのコードも無い）。⑳ 0xE0–0xE2 は NFT 版だけで実行される。**wide-world の草案 0xD6–0xDA**（`frontier-abi/src/world_index/wide_ix.rs`）は割当てが無く、`wide-world-experimental` の build だけが実行し、その build は自分の版のビットを持つ | §2 の r13 の修正 |
| プログラムの版 | 1–4、⑳の NFT 版 `0x8004` を知っている。custody-preview（版 5、`RULESET_HASH_V4`）と wide の実験版は知らない | 知らない版の Season は `UnknownProgramVersion`（UNVERIFIABLE） |
| 合成 march の既知の 6 件 | ④の `52c0bd45`。V11 の `TicketPlacementMismatch` を、ちょうど 6 件（bell 0）だけ許す。ほかの所見や欠けた所見があれば、試験が落ちる | `march_synth_passes_but_for_its_six_impossible_tickets` と `the_fixtures_have_nothing_for_v0e` が候補で通る。**新しい退行は無い**。古い 2 件の失敗は直し直していない |

**合成 march の注意。** 合成 march の fixture は、今はそれ自体が FAIL になる（6 件）。なので、その fixture の上で「PASS にならない」と確かめる試験は、何を足しても通ってしまう。⑱の `coverage.rs` がこれに当たる。しかも `coverage.rs` の `with_ix` は、固定 seed の鍵ペアで署名するので、走らせられない。そこで、PASS する記録済みの `land` の取引をその場で書き換える（署名し直さない）、鍵なしの同等の試験を作った（§2）。

## 2. 実装（パッチ 0013。`checks/v0_coverage.rs` と `tests/new_bands.rs`）

**V0 の判定の修正。** 偽造とする（FAIL にする）のは、検証器が知っている版のプログラムのときだけにした。0010 では割り当て済みのタグについてこう直した。r13 では、すべてのタグ外の命令と空の命令に広げた。

| 場合 | これまで | r13 |
|---|---|---|
| どの帯にも無いタグ（0xD6–0xDA の wide の草案、0xEE、0xFE など）。版を知らない、または archive に版が無い | FAIL `UnknownInstruction` | UNVERIFIABLE `UnverifiedInstruction`（どのプログラムが動いたか分からない。wide の実験版は、正しい取引でも偽造と言われていた） |
| 同じタグ。知っている版（1–4、`0x8004`） | FAIL | FAIL のまま（そのプログラムは拒否する） |
| 空の命令（タグが無い） | どの版でも FAIL | 知っている版なら FAIL、それ以外なら UNVERIFIABLE |

- どの場合も PASS にはならない。⑲の self_contained（V0 の FAIL は、取得済みの中だけで決まる）とも合う。FAIL が出るのは、archive が示す知っている版のときだけになる。
- 割当てを決めたわけではない。wide の帯は割り当てていないまま。

**鍵なしの試験（`tests/new_bands.rs` に追加）。**

| 試験 | 中身 |
|---|---|
| `every_abi_v2_tag_has_a_v0_answer_on_a_recorded_season` | `land`（M1）の、CreateSeason ではない取引の命令を、ABI v2 の全タグに書き換える。扱わない命令は `UnverifiedInstruction` で、PASS にならない（30 件以上）。範囲より短いデータは `Undecodable` の FAIL（M1 の命令は v1 の長さで見る） |
| `an_unknown_program_version_is_never_a_pass_keyfree` | CreateSeason の版を 5、`0x8005`、`0xFFFF` に書き換える → `UnknownProgramVersion`、PASS にならない（⑱の試験のうち、もともと鍵なしのもの） |
| `no_tag_or_an_unknown_tag_under_a_known_program_fails` | 知っている版で、空の命令と、0xEE、0xFE、0xD6 は FAIL `UnknownInstruction` |
| `tags_outside_abi_v2_are_told_apart`（更新） | 帯の無いタグ（0xD6、0xDA、0xEE、0xFE）。知らない版、版が無い、`0x4004` では UNVERIFIABLE。S1 と NFT 版では FAIL |

## 3. 試験（`results/verify-after-r13.log`）

**呼び出し先の監査。**
- lib の `#[cfg(test)]` の試験と、走らせた結合試験に、鍵ペアと署名は無い。
- 候補で増えたものも確かめた。④の `tests/common` の `MARCH_SYNTH_IMPOSSIBLE_TICKETS` と `assert_only_the_impossible_tickets` は、文字列を比べるだけ。
- 走らせていないもの: `record`、`tamper`、`coverage`、`fixtures::march_fixture_is_fresh`、⑩・⑲・⑳ の新しい試験ファイル（`custody*`、`history`、`ledger_history`、`resident_ledger`）。他担当の領域で、監査もしていない。
- CI は起動していない（`[skip ci]`）。

**0013 を当てる前の候補（`cf517b55` に鍵なしの試験だけを足したもの）:** 88 件通過。合成 march の 6 件の固定も含む。

**0013 を当てた後:** **89 件通過**。内訳は lib 47、camp_clear 3、evidence 8、missing_state 2、new_bands 10、open_items 3、unit 8、fixtures 8（`march_synth_passes_but_for_its_six_impossible_tickets` を含む。`march_fixture_is_fresh` は除外）。fmt と clippy `-D warnings`（Rust 1.95.0）も通った。

## 4. 当て方（④向け）

| パッチ | 当て先 | SHA-256 | tree |
|---|---|---|---|
| `patches/0013-verify-v0-forgery-only-under-a-known-program-and-keyfree-coverage-on-cf517b55.patch` | `cf517b558d1303a84dba618550f40cb460b7ad99` | `84fdbe7b2b588f2516fa3eeb376af466fef72b5ab5f68a601c5aee18582eae35` | `9ab02b5a78f23f849c13847e0f44f1f86b5fff4b` |

## 5. 変更の大きさ

2 ファイル、追加 183 行、削除 21 行（`v0_coverage.rs` の判定 2 か所と文書、`new_bands.rs` の試験）。ほかの検査と、⑱の `coverage.rs` は変えていない。

## 6. 残り（依存待ち）

| 残り | 担当 |
|---|---|
| ⑩の V26 が custody を再生したら、105–113 を `GUARDED` から `MODELLED` に移し、custody の命令を `supported()` に入れる | ⑩（着手済み）・④ |
| ResidentAct（0xE2）の内側の命令 | ⑳・⑱ |
| NFT 版の Season の記録済み fixture（署名が要る） | オーナーの承認 |
| wide の帯 0xD6–0xDA の割当てと、その版の扱い | ④（割当て）・wide の担当 |
| 合成 march の作り直し（署名が要る） | ④・オーナーの承認 |
| `coverage.rs` を鍵なしにすること（`with_ix` を、記録済みの取引の書き換えにする） | ⑱。⑪は同等の鍵なしの試験を new_bands に置いた |

## 7. r14: ResidentAct（0xE2）を V28 に渡す（2026-11-08、パッチ 0014、⑳の提案を採用）

**⑳の `b2bd9711`（`cf517b55` の上）。**
- `world::unwrap_resident` は、成功した ResidentAct の内側のプレイヤー命令を、別の命令として `Tx::ixs` に並べる。口座は act の口座から証明口座 4 つを除いたもので、プログラムの `proc::resident::act` が内側の命令に渡す `accounts[..n-4]` と同じ。
- V28 は残りを判定する。所有者、所有者だけの命令、証明口座、正規アドレス、join、後の Citizen。

**⑪の確認。**
- 検査はどれも、Citizen を口座の位置で読む。actor の wallet で Citizen を引く検査は無い（`ctx.citizen(`、`key(0)` での照合が無い）。wallet と actor を比べるのは V23 の 1 か所だけで、⑳はそこを NFT 用に直した。
- なので、内側の命令は wallet の Citizen と同じ検査で判定される。
- 所有者の判定は、resident の feed（Input の欄）が未決のあいだ UNVERIFIABLE のまま（④の割当て rev 6）。**NFT の Citizen が操作した Season は、まだ PASS にならない。**

**0014。** `judge_outside_v2` で、0xE2 を「判定の対象」（`None`）にする。条件は 2 つで、両方を満たすときだけ。
- V28 が動く（`s1`）。
- 内側のタグを act が実行する（`resident_wire::act_runs`）。

それ以外は UNVERIFIABLE。たとえば内側が CreateSeason や SetSession のとき、または `s1` でないとき。NFT 版の外では、知っている版が拒否するので FAIL。内側の命令そのものは、V0 が自分の命令として判定する（長さ、`supported`）。

| パッチ | 当て先 | SHA-256 | tree |
|---|---|---|---|
| `patches/0014-verify-v0-resident-act-left-to-v28-after-ws20-b2bd9711.patch` | ⑳ `b2bd9711`（`cf517b55` の上）に 0013 を当てた後 | `f8763979f44bcb20814f185dcaac7f2db092c22254db639f9a7a908ad123b10d` | `b2bd9711`＋0013＋0014 で `38e164a8a82b212f69e02f3ac341f1c35541933c`（試験した木と一致） |

**試験**（`results/verify-after-r14.log`）。
- `b2bd9711`＋0013＋0014 で **92 件通過**。内訳は lib 50（⑳の V28 を含む）、camp_clear 3、evidence 8、missing_state 2、new_bands 10、open_items 3、unit 8、fixtures 8（6 件の固定を含む）。
- fmt と clippy も通った。
- lib と結合試験に、鍵ペアと署名が無いことを確かめた（⑳の新しい試験を含む）。
- 新しい場合（`tags_outside_abi_v2_are_told_apart`）:
  - Harvest を内側に持ち `s1` → `None`
  - Harvest を内側に持つが `s1` でない → UNVERIFIABLE
  - 内側が SetSession か CreateSeason → UNVERIFIABLE
  - S1 版 → FAIL

**未確認。** NFT の Citizen が操作する Season を丸ごと `verify()` に通すこと（記録済みの fixture が無い。作るには署名が要る）。

## 8. r15: V0E は ABI v2 のすべての口座の種類を見る（2026-11-08、パッチ 0015、②が見つけた）

**穴（②が見つけ、⑪がコードで確かめた）。**
- `v0_evidence::program_kind` は、v1 の `frontier_abi::layout::AccountKind`（M1 の 17 種類）で口座の magic を読んでいた。
- そのため、S1 の口座（MarchState、Vault、Caravan、Structure、Nation、Lot）が次の状態でも、`MissingPostState` が出なかった。
  - 前の取引の事後状態で、その口座が知られている。
  - 後の成功した取引が、その口座を書込み可能で持つ。
  - その取引の事後状態に、その口座が無い。
- これは PASS になりうる経路だった。

**0015。** `frontier_abi::v2::layout::AccountKind` に替えた。Holding は今までどおり除く（V7 が見る）。

**回帰の試験**（`evidence::a_written_s1_account_without_its_post_state_is_not_a_pass`。鍵なし）。
- `land` の記録済みの取引をその場で書き換える。前の取引の事後状態に、literal の S1 の口座を置く。後の取引では、その口座を書込み可能のまま、事後状態から外す。
- Citizen（対照）と、S1 の 6 種類で確かめる。
- 修正の前は落ち、修正の後は通る。

| パッチ | 当て先 | SHA-256 | tree |
|---|---|---|---|
| `patches/0015-verify-v0e-every-abi-v2-account-kind-on-cf517b55.patch` | `cf517b55`（0013、0014 とは別のファイル。順は問わない） | `68b6a039a048f7029f0ec599220d1cd710ac174f9562ec6baf4dc9da9e3dac1d` | `cf517b55`＋0015 で `0cceeca4bf1a717cb3d0626332366d7be0a8d291` |

**試験**（`results/verify-after-r15.log`）。
- `cf517b55`＋0015 で **87 件通過**。内訳は lib 47、camp_clear 3、evidence 9、missing_state 2、new_bands 7、open_items 3、unit 8、fixtures 8。
- fmt と clippy も通った。

**②の V0 と V0E の変更**（②のブランチ `claude/modest-wozniak-xcc7d8` @ `d0da1d02`、未統合）は review した。
- Grant の命令と記録を「判定の対象」にするのは、V27 と同じ形。条件は、版が `runs_grants` で、S1 の検査（VR）が動くこと。妥当。
- ただし、②の v0_coverage の差分は 0013 の前の木を基にしているので、衝突する。②には 0013 の上で作り直すよう伝えた。
