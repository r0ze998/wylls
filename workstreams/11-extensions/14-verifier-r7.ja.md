# 14 検証器 r7: ④の現在版への統合用の差分、②⑳の新しい命令・記録との照合（2026-11-06）

**起点。** ⑪ `claude/kind-fermat-earbxe` @ `c8d694bd2b3ac4a08e3ad5633bf1d8b623be32f8`。**④の現在版** `claude/gallant-ride-cunptv` @ `8e96f24df4aa4ed51277fa42de6a354a21cd2bc6`（統合候補 `ef63544c` の後に 20 commit。検証器・ABI・規則・Frontier プログラムへの変更はない）。照合した他担当: ⑳ `claude/funny-wozniak-cy4n64` @ `dc55f15966d3256b118d645c36ba4591a41e6b3f`、② `preserve/ws02-rights-dc3bd3d` @ `dc3bd3d9`（②の GitHub 上の最新。他のブランチに②のコードはない）、④の割当て `workstreams/04-execution/contracts/ABI-ALLOCATION-20261106.ja.md`（暫定）。

**採用していないもの（変わらず、有効化していない）:** 案 B、Burn、運営の緊急停止、新しい世界効果、運営の権限。**鍵の生成・導出・署名を伴う試験は行っていない**（§4）。

## 1. ④へ渡す差分

| 使い方 | パッチ | 当て先 | SHA-256 |
|---|---|---|---|
| **推奨（1 つで済む）** | `patches/0006-verify-v0e-evidence-and-records-on-ws04-8e96f24d.patch` | `8e96f24d`（`ef63544c` にも当たる） | `81841f83b984ee8f340609db64bf055fe7323471fac7563af32a430e78d3f391` |
| 0004・0005 を当て済みの木 | `patches/0007-verify-v0e-unverified-record-after-0005.patch` | 0004 → 0005 の後 | `0ee4510c4e8982d4f1364d173a5d789523c523e49d6ad335cd8048a793dd1aa5` |

- `8e96f24d` に 0006 を当てた木と、0004 → 0005 → 0007 の順に当てた木は同じ。どちらも `git add -A && git write-tree` で tree は **`d72a025c16a62650920a495f9f1a1a9e756e42a2`**。試験した木とも `diff -r` で一致する。
- 変更は `frontier-node/crates/verify` の中だけ（5 ファイル、追加 775 行、削除 0）。`checks/mod.rs` は V0 の後に V0E を呼ぶ 5 行だけ。⑱の V0（`checks/v0_coverage.rs`）と既存の検査は変えていない。0004・0005 は**④の現在版に修正なしで当たった**（`checks/mod.rs`・`codes.rs` の周辺に④の変更がない）ので、0004・0005 自体は書き換えていない。
- 0001 は当てない（取り下げ済み）。0003 は統合候補に適用済み。

## 2. ②⑳の新しい命令・記録との照合

| 対象 | コードの事実 | 今の検証器（`8e96f24d`＋0006）の判定 | 試験（記録済みの取引を書き換え、署名し直さない） |
|---|---|---|---|
| ② の命令 0xD0–0xD5（IssueGrant〜CloseGrant） | `frontier-abi/src/v2/rights.rs` の `tag`。`v2::Ix` の**外**で、コアの `dispatch` が `Ix` の前に振り分ける（`permutation-frontier/src/lib.rs`） | ⑱の V0 が **FAIL `UnknownInstruction`**（`v2::Ix` に無い） | `an_instruction_of_a_new_band_is_not_a_pass` |
| ⑳ の命令 0xE0–0xE2（CreateResidentPolicy、JoinResident、ResidentAct） | `frontier-abi/src/resident_wire.rs`。0xE0–0xE7 が⑳の帯。これも `v2::Ix` の**外**で、コアの `dispatch` が先に振り分ける | 同上（FAIL）。⑳を合わせた試験の木でも同じ（192 件で PASS 0） | 同上 |
| ⑪ の命令 0xE8–0xED（案 B、未採用）、試験用の 0xFE | 実装なし | 同上（FAIL） | 同上（全体 192 件で PASS 0） |
| ② の記録 114–119 | ④が割り当てたが、②のコード（`dc3bd3d`）は**記録を出さない** | ABI の表に無い種別は `decode` が `UnknownKind` → V1 **FAIL `Undecodable`** | `a_record_of_a_new_kind_is_not_a_pass`（114–119・130・135–144 の 17 種、204 件で PASS 0） |
| ⑳ の記録 130 RESIDENT_JOINED | ⑳の `frontier-abi/src/v2/log.rs` に追加（鎖の link なし）。④の現在版の ABI には無い | ④の版では同上（FAIL）。⑳を合わせると解読でき、conquest の記録として集まる → 0006 の **V0E `UnverifiedRecord`**（後述）、M1 の Season ではさらに V1 FAIL | ⑳を合わせた試験の木で、正しい形の RESIDENT_JOINED（key は asset の resident ID）を入れた 12 件で PASS 0、V0E が全件で `UnverifiedRecord` |
| ⑪ の記録 135–144 | 未実装 | ABI に無いので FAIL | 上と同じ試験 |

**r7 で見つけた PASS の経路（④の版に既にある）。** ABI が知っている記録種別を、それを出していない取引のログに 1 つ書き足す試験（780 件）で、**DIVERT（60）が 12 件 PASS** した（他の種別は鎖・解読・V15 などで FAIL）。V13 は DIVERT を TRANSIT_SETTLED の決済の中でしか読まない（`checks/v13_payments.rs` 183–189 行）。DIVERT はほかの命令の支払い（`pay_or_divert`、`permutation-frontier/src/init.rs`）でも出るが、そこでは**どの検査も判定していない**。

**0006 で足した判定（V0E `UnverifiedRecord`、UNVERIFIABLE）:**

1. TRANSIT_SETTLED の無い成功した取引の DIVERT。判定する検査が無いので PASS にしない（FAIL にもしない。プログラムは正しく払ったかもしれない）。
2. `MODELLED_CQ_KINDS`（80–88、90–103。④の版の conquest 種別すべて）に無い conquest 種別の記録。後の ABI が足した種別（⑳の 130 など）は、検査がそれを扱い、この一覧に名前を足すまで PASS にならない。一覧はわざと数の列挙にしてある。
3. 仕掛け: 試験 `every_conquest_kind_the_abi_knows_is_modelled` は、ABI の conquest 種別がこの一覧に無いと失敗する。⑳を合わせた木では、狙いどおり「conquest kind 130 is not modelled」で失敗した。統合する人は、⑳の記録を判定する検査を足すか、記録が UNVERIFIABLE のままになることを受け入れるかを決めるまで先に進めない。

記録済みの fixture（land、march-synth、march-program）は PASS のままで、V0E は何も報告しない（`the_fixtures_have_nothing_for_v0e`）。

**照合で分かったこと（統合への注意）:**

- ②・⑳の命令は `v2::Ix` の外にあり、コアのプログラムは実際に実行する。統合後、⑱の V0 はこれらの**正しい取引も FAIL** にする（PASS にはしない）。②・⑳を採用するときは、`v2::Ix`（または V0 が読む表）にタグを足し、`supported()` に入れるまでは `UnverifiedInstruction`（UNVERIFIABLE）にする必要がある。担当: ④（ABI の表）、⑱（V0）、②⑳（それぞれの検査）。
- ⑳の `ResidentAct`（0xE2）は内側に v2 命令のデータを包む。V0 は外側のタグしか見ない。内側の命令を判定するまでは UNVERIFIABLE とするのが V0 の考え方に合う。担当は⑳・⑱。
- ⑳のブランチは古い基点 `92142932` から分かれていて、⑱の V0 を含まない。④の版に試しに合わせると `frontier-abi/src/v2/error.rs`（④の `ContinuousWorld = 94` と⑳の 170–175）と `frontier-node/crates/findex/src/lib.rs` が衝突する。⑪は試験のために scratch の中だけで解決した（error.rs は両方を残し、findex は④の側を採った）。この解決は push していない。
- S1・conquest の Season の記録済み fixture で、作るのに署名が要らないものは無い（`coverage.rs` は署名して作る）。なので、**S1 の Season で RESIDENT_JOINED を入れる場合**は実行していない。そこを覆うのは 2 と 3 の仕掛け。

## 3. ③・④・⑯・⑱・②・⑳との分担（r6 から増えたもの）

| 残り | 担当 |
|---|---|
| ②・⑳のタグを ABI の表に入れ、V0 の `supported()` を決める（入れないと正しい取引が FAIL） | ④・⑱、②・⑳ |
| RESIDENT_JOINED を命令（JoinResident）と結び付けて判定する検査。その後で `MODELLED_CQ_KINDS` に 130 を足す | ⑳・④ |
| TRANSIT_SETTLED 以外の DIVERT を、送金と DefencePool の `diverted_total` で判定するか | ④ |
| ⑳と④の版の衝突（error.rs、findex）の解決 | ④・⑳ |
| CPI の内側の命令、post-state の無い closer、archive の真正性、P1 の採否 | r6 と同じ（[13](13-verifier-r6.ja.md) §3） |

## 4. 試験（2026-11-06）

**鍵の生成・導出・署名を伴う試験は行っていない。** 実行しなかったもの: `tamper`、`coverage`、`record`、`fixtures::march_fixture_is_fresh`（r6 と同じ理由）。新しい試験は記録済みの取引の message とログを書き換えるだけで、署名し直さない（検証器は署名を再検査しない）。⑳の resident ID は literal の asset id の SHA-256（鍵ではない）。

| 対象 | 結果 | ログ |
|---|---|---|
| `8e96f24d`＋0006: lib 13、unit 8、fixtures 8（1 件除外）、camp_clear 3、missing_state 2、open_items 3、evidence 8、new_bands 5 | **50 件通過**。fmt・clippy `-D warnings`（`-p verify --no-deps --all-targets`、Rust 1.95.0）通過 | `results/verify-after-r7.log` |
| 新しい帯の命令（16 タグ）・記録（17 種）・知っている記録の書き足し | 192＋204＋390 件で **PASS 0** | `results/verify-new-bands-r7.log` |
| 0006 の前（`8e96f24d`＋0004＋0005） | 知っている記録の書き足し 780 件のうち **DIVERT の 12 件が PASS** | 同上 |
| ⑳を合わせた試験の木（scratch のみ）＋0006 | タグ 192 件で PASS 0。RESIDENT_JOINED 12 件で PASS 0（V0E `UnverifiedRecord`）。仕掛けの試験は 130 で失敗（狙いどおり） | 同上、`results/ws20_resident_probe.rs.txt` |

creation-bridge と ext-kernel のコードは r6 から変えていない（r6 の結果は [13](13-verifier-r6.ja.md) §4）。

## 5. ⑯が取得できるもの

すべてブランチ `claude/kind-fermat-earbxe` の `workstreams/11-extensions/` の下にある（commit の SHA は引渡しの報告に書く）。

- `patches/0006-…patch`、`patches/0007-…patch`（SHA-256 は §1）
- `14-verifier-r7.ja.md`（この文書）
- `results/verify-after-r7.log`、`results/verify-new-bands-r7.log`、`results/ws20_resident_probe.rs.txt`

再現:

```sh
git worktree add /tmp/w4 8e96f24df4aa4ed51277fa42de6a354a21cd2bc6
cd /tmp/w4 && git apply <path>/0006-verify-v0e-evidence-and-records-on-ws04-8e96f24d.patch
git add -A && git write-tree        # d72a025c16a62650920a495f9f1a1a9e756e42a2
cd frontier-node && cargo +1.95.0 test --locked -p verify --lib --test unit --test camp_clear \
  --test missing_state --test open_items --test evidence --test new_bands
cargo +1.95.0 test --locked -p verify --test fixtures -- --skip march_fixture_is_fresh
```

## 6. r8: RESIDENT_JOINED（kind 130）の扱い（2026-11-06、④の依頼）

④は r7（0004→0005→0007）を候補 `claude/gallant-ride-cunptv` @ `4c65aaa229cea9ba2a57229cac78cc2715c5df7d` に入れた（HEAD `3187205a`）。この候補には⑳の RESIDENT_JOINED が入っているので、仕掛けの試験 `every_conquest_kind_the_abi_knows_is_modelled` が狙いどおり「conquest kind 130 is not modelled」で失敗した。④は 130 を扱う検査を⑪と⑳で決めるよう求めた。

**コードの事実（候補の木）。**
- RESIDENT_JOINED を出すのは JoinResident（0xE1）だけ。出す場所は `permutation-frontier/src/proc/resident.rs` 331–346 行で、payload は asset、faction、shard、generation、join_bell。
- JoinResident のデータは `tag ‖ generation u32 LE ‖ faction u8`（`resident_wire::decode`）。
- 検証器のうち V9 は記録の key が asset の resident ID かを見て、V12 は探索の下限を与える。どちらも、記録をそれを出した命令と結び付けてはいない。
- 0xE1 は `v2::Ix` の外にあるので、⑱の V0 が FAIL `UnknownInstruction` にする。

**r8 の判定（パッチ 0008）。**
- 130 は `MODELLED_CQ_KINDS` に入れず、新しい `CONDITIONAL_CQ_KINDS` に入れる。
- 130 は、同じ取引の最上位に JoinResident があり、その generation と faction が記録と一致するときだけ「判定される側」に数える。その命令は V0 が、key は V9 が、下限は V12 が見る。
- それ以外の場所にある 130、または一致しない 130 は、V0E `UnverifiedRecord`（UNVERIFIABLE）のまま。
- 仕掛けの試験は「`MODELLED` か `CONDITIONAL` のどちらかにあること」を求める形に変えた。⑳が後で記録と命令の照合を検査に入れたら、130 を `MODELLED_CQ_KINDS` に移せる。

| パッチ | 当て先 | SHA-256 | 当てた後の tree |
|---|---|---|---|
| `patches/0008-verify-v0e-resident-joined-beside-its-join-on-ws04-4c65aaa2.patch` | `4c65aaa2`（HEAD `3187205a` にも当たる） | `e71b7892329ccbf44dda028026ce2de4cffd3d7c42b5514782ae08698e5cf98f` | `4c65aaa2` に当てると `7774a6e9560a514771635ee2bef0e88546c89a7d`、`3187205a` に当てると `04f87fb3fbdb21ccfed15a7bd83b318b7e02083a` |

**試験。** 候補＋0008 で許された試験は **55 件通過**した（lib 17、unit 8、fixtures 8（1 件除外）、camp_clear 3、missing_state 2、open_items 3、evidence 8、new_bands 6）。fmt と clippy `-D warnings` も通った（Rust 1.95.0）。ログは `results/verify-after-r8.log`。

新しい試験 `a_resident_joined_without_its_join_is_unverifiable` は land の 6 取引で次の 3 通りを確かめた。どれも PASS ではない。
- join の無い取引に入れた 130 は `UnverifiedRecord`。
- generation か faction が違う JoinResident の横にある 130 も `UnverifiedRecord`。
- 一致する JoinResident の横にある 130 は、V0E は報告しない。その取引は V0 の FAIL のまま。

鍵の生成・導出・署名は行っていない。resident ID は literal の asset id の SHA-256。

**⑳・④・⑱に残ること。**
- 0xE1 を ABI の表と V0 の `supported()` に入れる。
- 記録の asset・shard・join_bell を、命令の口座（Core asset）・取引の鐘と照合する検査を入れる。
- それが済んだら 130 を `MODELLED_CQ_KINDS` へ移す。
