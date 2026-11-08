# 15 検証器 r9: 正しい NFT 参加（JoinResident）を検証する（2026-11-06）

**起点。** ④の候補 `claude/gallant-ride-cunptv` の HEAD `d0e96d5394d88decf878676f37bc3782654d1045`。ここには⑪の 0004→0005→0007→0008 と、⑳の `9e6b0c01` までが適用されている。⑳の `45d95e31e8ca19c76787e403086550fe94086bc9`（facts と V9 で、RESIDENT_JOINED を自分の JoinResident と結び付け、resident ID ごとに 1 件まで）は**候補にまだ入っていない**ので、この上に当てた。④に適用済みの変更は、0009 に重ねて入れていない。

**採用していないもの（変わらず）:** 案 B、Burn、運営の緊急停止、新しい世界効果、運営の権限。**鍵の生成・導出・署名を伴う試験は、CI を含めて実行していない**（§4）。

## 1. 当てる順

| 順 | 何 | 当て先 | 確認 |
|---|---|---|---|
| 1 | ⑳ `45d95e31`（`claude/funny-wozniak-cy4n64` から cherry-pick） | `d0e96d53` | 衝突なしに当たる |
| 2 | ⑪ `patches/0009-verify-v27-join-resident-on-ws04-d0e96d53-after-ws20-45d95e31.patch` | 1 の後 | SHA-256 `39da19690fa070c019630e100c9535a2fe21f2d95bd5a3dc9bb3a7a2c4f2a823` |

- 1→2 の後の tree（`git add -A && git write-tree`）は `1bec57a040640820c0032549470aab9c9300906c`。試験した木と `diff -r` で一致した。
- 0009 は 1 が無いと当たらない。⑳の `resident_joined_problem`、`resident_joined_findings` と、試験の補助 `joined` を使うため。
- 変更は `frontier-node/crates/verify` の中だけ（5 ファイル、追加 757 行、削除 13 行）。
- 0008 の条件付きの一覧（`CONDITIONAL_CQ_KINDS = [130]`）は**変えていない**。一覧を書き換えて完成とはせず、命令の側から照合する検査（V27）を足した。

## 2. 何を照合するか（0009）

正しい JoinResident は **PASS になりうる**（V0・V0E・V9・V27 のどれも報告しない）。照合の項目は、プログラムの `proc/resident.rs` の `join` が書くものに合わせた。

| 項目 | 照合 | 担当 |
|---|---|---|
| 命令 | **V0**: ⑳の NFT 版プログラム（`program_version` = `0x8000 | 4` = `PROGRAM_VERSION_NFT_S1`）を知っている版に加えた。その Season では、0xE1 はデータが `resident_wire::decode` で Join になれば判定の対象（V27）、ならなければ FAIL `Undecodable`。0xE0・0xE2 は UNVERIFIABLE `UnverifiedInstruction`（判定する検査が無い） | ⑪ |
| 記録との対応 | **V27**: 成功した JoinResident ごとに、自分を表す RESIDENT_JOINED がちょうど 1 件あること。ログが完全なのに無ければ FAIL。ログが欠けたり切れたりしていれば V0E（UNVERIFIABLE）に任せる。2 件以上なら FAIL | ⑪ |
| NFT | asset 口座（8 番目）＝記録の asset、記録の key＝その asset の resident ID（⑳）。Citizen の post-state の resident asset＝asset。link（7 番目）の post-state が `{asset, resident（9 番目）, Citizen（4 番目）}` を結んでいる | ⑳＋⑪ |
| 世代・国 | 命令の generation・faction＝記録の値（⑳）。faction は 6 未満。Citizen の post-state の faction＝記録の値（⑪） | ⑳＋⑪ |
| shard | 記録の shard＝`join_shard_of(asset)`（⑳）。Citizen の post-state の JOIN_SHARD＝記録の値（⑪） | ⑳＋⑪ |
| 時刻 | 記録の join_bell＝記録の bell（⑳）。記録の bell＝取引時刻の bell（`bell_at(genesis_ts, time)`）。`join_close_bell` より前。Citizen の post-state の JOIN_BELL＝記録の bell（⑪） | ⑳＋⑪ |
| 口座 | Season（2 番目）、Frontier（3 番目）、Citizen（4 番目）がこの Season の正しい住所。Citizen は `citizen_by_tag15(resident ID)` にある。違えば FAIL `NonCanonicalAddress`。Citizen の post-state は、magic、season_id、joined、wallet が 0、tag | ⑪ |
| 世界ごとの重複 | 同じ Season（世界）で同じ resident ID の 2 件目の記録は FAIL（⑳ V9）。1 つの取引に同じ join の記録が 2 件あれば FAIL（⑪ V27） | ⑳＋⑪ |
| post-state の欠落 | post-state のある archive で、Citizen か link の post-state が無ければ UNVERIFIABLE `MissingPostState` | ⑪ |

**判定しないもの（archive に証拠が無い）:** Core asset の現在の所有者と transfer guard、resident program の現在の世代。プログラムはこれらを読み取り専用の口座から読むが、archive には残らない。wallet の署名と同じく、ランタイムが受け入れたことを前提にする（検証器はもともと署名を再検査しない）。

## 3. ②の正当な命令への未対応と、偽の命令の区別（V0）

| 場合 | 判定 |
|---|---|
| 知っている版のプログラム（1–4、`0x8004`）の Season で、④が割り当てた帯のタグ（② 0xD0–0xD5、⑳ 0xE0–0xE7（NFT 版の外）、⑪ 0xE8–0xED、⑧ 0xC1、⑩ 0xC2–0xCC、⑨ 0xF0–0xFD）が成功した | FAIL `UnknownInstruction`。詳細に帯の持ち主と「この版は実行しない」を書く（そのプログラムは拒否するので、成功は別のプログラムの実行） |
| 検証器が知らない版のプログラムの Season で、割り当て済みの帯のタグ（例: ②の Grant を実行する将来の版） | UNVERIFIABLE `UnverifiedInstruction`（正当かもしれないが、判定する検査が無い。PASS にも偽造扱いにもしない） |
| どの帯にも無いタグ（0xD6、0xEE、0xFE など） | どの版でも FAIL `UnknownInstruction`（⑱の V0 のまま） |

②のコードは④の候補に入っていない（`frontier-abi/src/v2/rights.rs` が無い）。なので今の候補では、②のタグが成功すれば FAIL になる。

## 4. 試験（2026-11-06）

**鍵の生成・導出・署名を伴う試験は、CI を含めて実行していない。** push は `[skip ci]` を付けて行う。新しい試験は、literal の byte と literal の住所の文脈だけで World を組み立てる。Citizen の住所は `create_with_seed` の SHA-256 の計算で、resident ID は literal の asset id の SHA-256。実行しなかったもの: `tamper`、`coverage`、`record`、`fixtures::march_fixture_is_fresh`。

| 試験 | 中身 |
|---|---|
| `v27_residents::tests::an_honest_join_resident_has_no_finding` | 正常例: 正しい命令・記録・Citizen・link の取引で、V27 と⑳の V9 の所見が 0 件。V0 も判定の対象とする |
| `forged_joins_fail` | 偽造: key の偽造、Citizen・Season・Frontier の住所の差し替え、join の無い取引の記録、別の Citizen を結ぶ link → FAIL |
| `missing_evidence_is_never_a_pass` | 欠落: ログが完全で記録が無い → FAIL。ログが無い・切れている → V27 は報告せず V0E に任せる。Citizen か link の post-state が無い → UNVERIFIABLE |
| `mismatches_fail` | 不一致 11 通り（世代、国、NFT、shard、時刻、join_close の後、Citizen の国・asset・wallet・join bell、国が範囲外）→ どれも FAIL |
| `duplicates_fail` | 重複: 1 取引に同じ join の記録 2 件 → FAIL。同じ Season で同じ NFT の 2 回目の参加 → ⑳の V9 が FAIL |
| `new_bands::tags_outside_abi_v2_are_told_apart` | V0 の区別（§3）: NFT 版の 0xE1／0xE0／0xE2／不正な長さ、S1 版の⑳タグ、②タグが知っている版と知らない版でどう判定されるか、割り当ての無いタグ |
| 許された全試験（d0e96d53＋45d95e31＋0009） | **65 件通過**（lib 26（⑳の facts・V9 の試験と V27 の 5 件を含む）、unit 8、fixtures 8（1 件除外）、camp_clear 3、missing_state 2、open_items 3、evidence 8、new_bands 7）。fmt と clippy `-D warnings`（`-p verify --no-deps --all-targets`、Rust 1.95.0）も通過。結果は `results/verify-after-r9.log` |

**実行していないこと。** NFT 版の Season を丸ごと記録した fixture が無いので、`verify()` に通して正しい参加が全体として PASS になることは確かめていない。そういう fixture を作るには SBF の build とプログラムの実行が要るが、SBF ツールチェーンの導入は承認されていない。合成の fixture も署名して作る。検査ごとの試験と V0 の分類の試験で、その部分を覆った。

## 5. 残り（担当）

| 残り | 担当 |
|---|---|
| ⑳ `45d95e31` と 0009 を候補に入れる（1→2 の順） | ④ |
| `PROGRAM_VERSION_NFT_S1` の正式な値（今は⑳のプログラムの `0x8000 | 4`。④が決めるまでの仮の値） | ④ |
| ResidentAct（0xE2。NFT の Citizen の操作を包む）の内側の命令の判定。今は UNVERIFIABLE なので、NFT の Citizen が操作した Season は PASS にならない | ⑳・⑱ |
| 記録を含む NFT 版の Season の記録済み fixture（SBF の build と実行、または合成。どちらも署名を伴う） | ④・⑳（オーナーの承認が要る） |
| ②を採用するときの、タグの ABI 表への追加と検査 | ②・④・⑱ |

## 6. ⑱が見つけた穴と④の修正（2026-11-06、採用）

- **穴（⑱が見つけた）。** 0009 の V0 は、CreateSeason の `program_version` だけを見て JoinResident を「判定の対象」とした。ところが V27 は `cx.s1` のときしか動かない。期間の終わりに Season が Closed の tombstone になり、V3 の ruleset も設定されていないと `s1` は false になる。すると V27 が動かず、JoinResident は判定されないまま PASS に数えられうる。
- **④の修正。** `claude/gallant-ride-cunptv` の `6984acfa4c0f9919c8c424a9bd5f2d59193d1639` で、patch の SHA-256 は `dcf29ef185feb7d52542dc889806039255be059854031e18b5f46bd2f66707fd`。`judge_outside_v2` に `s1` を渡し、`s1` のときだけ判定の対象にする。そうでなければ UNVERIFIABLE `UnverifiedInstruction` にする。試験には `s1 = false` の場合を足した。
- **⑪の判断。** この修正をそのまま採る。別の版は出さない。V27 を `s1` の外でも動かす案は採らない。理由: `s1` が false の Season では、ほかの S1 の検査（V23–V25）も動いていない。その Season で JoinResident だけを判定しても、全体は PASS にできない。UNVERIFIABLE とするのが正直。
- **0009 との関係。** ⑪の 0009 は変えていない。④の候補では、0009 の後に 6984acfa を当てた状態が正になる。

## 7. r10: プログラムの版が分からない archive での、割り当て済みタグ（2026-11-06、パッチ 0010）

**きっかけ。** ⑲が、取得範囲が完全と示せない履歴の判定（`history.rs`）を作っている。そこで「取得済みの取引の中だけで決まる FAIL」（V0、V27、V9 の RESIDENT_JOINED）は、履歴が欠けていても FAIL のまま残すことになった（⑪の提案を⑲が採用）。

**見つけた穴。** 0009 の V0 は、CreateSeason が archive に無いとき（`program_version` が分からないとき）も、割り当て済みの帯のタグを FAIL にしていた。CreateSeason の無い archive は、途中から始まる履歴で起こりうる。どのプログラムが動いたか分からないのに「偽の命令」と言い切ることになり、「中だけで決まる FAIL」の分類に合わない。

**0010 の直し方。** 割り当て済みのタグを FAIL にするのは、知っている版のときだけにする。版が分からないとき（`None`）は UNVERIFIABLE `UnverifiedInstruction` にする。割り当てのないタグは、これまでどおりどの場合も FAIL。⑳のタグも、NFT 版と分からなければ同じ扱いになる。

| パッチ | 当て先 | SHA-256 | 当てた後の tree |
|---|---|---|---|
| `patches/0010-verify-v0-allocated-tag-without-program-version-on-ws04-6984acfa.patch` | ④の候補 `6984acfa4c0f9919c8c424a9bd5f2d59193d1639` | `6c8fe8342e4f0a8f45a0d7ef24bba5c608a34ef59b9fddd896d77a47e1cc691a` | `9ef386866b616629cabf46d496ddf030f93cb817` |

**試験。** 許された試験 65 件が通過した。`tags_outside_abi_v2_are_told_apart` に `None` の場合を足した。fmt と clippy も通った（`results/verify-after-r10.log`）。鍵の生成・導出・署名は伴わず、CI も起動していない。

**⑲への注意。** V0 の `Undecodable`（データの長さ）は、Season の種類（`v3`）によって v1 と v2 の長さを選ぶ。`v3` は Season 口座か ruleset の設定から決まる。どちらも無い archive では、CreateSeason のように v1 と v2 で長さが違う命令が誤って FAIL になりうる。今の RPC 取得では最終の Season 口座を取るので起こりにくいが、分類のときに覚えておいてほしい。
