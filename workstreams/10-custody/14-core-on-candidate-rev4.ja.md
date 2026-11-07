# 14 core 0001–0013 を④の統合候補と割当 rev 4 へ（2026-11-07）

`563407d9` は core を**別の親として保存しただけ**で、統合の木には入っていなかった（確認済み）。今回、core の差分を④の統合候補の上で**実際に当てて**、④の ABI の割当（`workstreams/04-execution/contracts/ABI-ALLOCATION-20261106.ja.md`、rev 4。rev 5・6 は⑩に関係なし、rev 6 で V26 は⑩に割当済み）の番号に合わせた。⑨と接続済みの部分（`workstreams/10-custody/` の本体・アダプター・`with-bridge10`・⑨への差分）は作り直していない。

## 1. 起点と結果

| もの | 完全 SHA | tree |
|---|---|---|
| ④の統合候補（起点） | `integrate/ws09-10-audit-20261107` `c1e8137e2446a9c1e83e41fc6c74900a5090fe03` | — |
| ⑩ core（rev 4、統合候補の上） | ブランチ `workstream/10-custody-core-r4` `45cea676bab5b0dbc02037d2d6f3c0c7e0326823` | `4bd0ff02623c1e1ff8bb7132f05d8b4d38a804fd` |
| 差分 | `patches-r4/0001–0014`（`git format-patch c1e8137e..`、`SHA256SUMS`） | `c1e8137e` に `git am` で当てると同じ tree `4bd0ff02…`（確認した） |

## 2. 適用順

`c1e8137e` に `git am` で順に当てる（`patches-r4/`）。前の版（`patches/0001–0013`、`4cd901de` の上）と同じ順で、番号と統合候補の変化に合わせて手で解いた。

| # | 内容 | 統合候補で変えたこと |
|---|---|---|
| 0001 | rules のカーネル `custody.rs` | なし（そのまま当たった） |
| 0002 | ABI：口座・命令・記録・エラー | **番号を rev 4 へ**：tag 0xC2–0xCC（⑧の 0xC1 の後）、記録 105–113（⑧の 104 の後）、エラー 100–104（⑧の 94 を避ける）。`CqError::ALL` は番号順、未割当の範囲 `105..=169`。`is_custody()` の範囲を 0xC2–0xCC に（古い範囲のままだと ⑧ の ExtendFrontier を custody と数え、WithdrawLot を外していた）。ベクタを `abi-vectors` で作り直した。AccountKind 23・entity 13・seed `cl` は変えない |
| 0003 | プログラムの custody 命令と S1 の改定 | 命令の dispatch は⑧の ExtendFrontier と並べる。`MAX_KIND_V2` は統合候補の 134（105–113 を含む）。プレイヤーの前処理は⑳の `player_as(…, &Auth::Wallet)`（統合候補で `holding::player` がなくなった）。記録の幅の試験は 104–134 の種類（⑧ 104、⑩ 105–113、⑳ 130）を述べる |
| 0004 | オフチェーン（fclient・herald）の分岐 | なし |
| 0005 | 版の分離（`custody-preview`：V4・版 5） | ⑳の `nft-experimental`（版 `0x8000 \| S1`）と並べる。**両方を同時に有効にするとコンパイルエラー**（その版は未決、④の割当 §2.6） |
| 0006 | 検証器 V26 のガード | 統合候補の `v26_growth`・`v27_residents`・`v28_resident_acts` と並べる。`Ctx::unverifiable` は⑱のものを使う（二つ目を足さない） |
| 0007 | ハーネスの登録と JS の生成物 | ⑧の ExtendFrontier の登録と並べる。JS（gateway の client、web sdk）は `sync-web-sdk.mjs` で作り直した（OpenLot は tag 194 = 0xC2） |
| 0008・0009 | カーネルの説明、累計の検査 | なし |
| 0010 | V26 の口座の再判定 | なし |
| 0011 | V26 の補助関数を `Ctx` から外す、法則 2 つ | **⑱の `Ctx::unverifiable` を消さない**（元の 0011 は⑩が足した同名の関数を消していた。統合候補ではそれが⑱のもの）。`fail_or_unverifiable` だけを `v26_custody.rs` へ |
| 0012 | カーネルの `return_unused`、V26 の履歴 | なし |
| 0013 | V26 の注文の帳簿の再生 | なし |
| 0014 | 説明の番号 | 0001–0013 が足した説明に残っていた 0xC1–0xCB・104–112 を rev 4 の番号に（説明だけ） |

## 3. 試験（統合候補の上、鍵の生成・導出・署名を伴う試験は実行していない）

| 対象 | 結果 |
|---|---|
| `permutation-rules` | 通過 |
| `frontier-abi` | 109 件ほか通過。ベクタ 17 ファイルが最新（`abi-vectors --check`） |
| `permutation-frontier`（S1 の build） | 104 件通過 |
| `permutation-frontier --features custody-preview` | 105 件通過 |
| `permutation-frontier --features nft-experimental` | `cargo check --all-targets` だけ（⑳の住民の試験は署名を使い得るので実行していない） |
| `custody-preview` と `nft-experimental` を同時に | 意図どおりコンパイルエラー（版が未決） |
| clippy `-D warnings` | rules・ABI は 0 件。プログラムは 1 件（2 行）：⑧の `map_growth_runtime_tests.rs` の `needless_range_loop`。**⑩の差分は触れていないファイルで、統合候補に元からある** |
| JS の生成物 | 最新（`sync-web-sdk.mjs --check`） |
| カーネルの写し | ⑩の本体（`custody/src/lot.rs`）と一致（`core-kernel.py --check`） |
| `frontier-node` | `cargo check --workspace --all-targets --locked` 通過 |
| 検証器の custody の試験（名前で選んだ） | `custody.rs` 6、`custody_state.rs` 7、`custody_history.rs` 8 件通過 |
| ⑱の `every_abi_tag_has_a_coverage_answer`（名前で選んだ、署名なし） | **失敗**（予想どおり）：モデルのない命令に custody の 11 命令が加わる。挙動は正しい（V0 が UnverifiedInstruction にする）。⑱の期待値の更新が要る（U4） |
| LiteSVM ハーネス | `cargo check --tests` だけ（実行は鍵を作り署名するのでしていない） |

実行していない：LiteSVM・SBF・`tamper.rs`・`record.rs`・`coverage.rs` など、鍵の生成・導出・署名を伴う試験。

## 4. ⑧との番号の衝突と、残る衝突

| 空間 | ⑧ | ⑩（前） | ⑩（rev 4） | 状態 |
|---|---|---|---|---|
| 命令 tag | 0xC1 ExtendFrontier | 0xC1–0xCB | 0xC2–0xCC | **解消** |
| 記録 kind | 104 FRONTIER_EXTENDED | 104–112 | 105–113 | **解消** |
| エラー | 94 ContinuousWorld | 94–98 | 100–104 | **解消** |
| 検証器の検査名 | `V26:map-growth`（統合候補の `v26_growth.rs`、`const V = "V26"`） | `V26:custody-*` | 変えていない | **残る**。④の割当 rev 6 は V26 を⑩としているが、統合候補のコードでは⑧の地図の拡張も V26。所見のコード（`CustodyLotBroken` など）は重ならないので、両方が同時に動いても判定は混ざらないが、所見の `check` 欄は同じ "V26"。どちらかの番号を変えるのは④の判断（⑩は⑧のコードを変えていない） |

## 5. 未決事項（⑩は決めていない）

| # | 相手 | 内容 |
|---|---|---|
| U1 | ④ | 検証器の V26 を⑧の地図の拡張と⑩の custody のどちらに残すか（§4） |
| U2 | ④ | custody を入れたプログラムの版（今は `custody-preview` の版 5。⑳の `nft-experimental` との組み合わせは拒否している） |
| U3 | ④・⑳ | NFT の住民の Citizen が custody の命令を使えるか（今は財布と Frontier の session だけ。`Auth::Wallet`） |
| U4 | ④・⑱ | ⑱の試験 `every_abi_tag_has_a_coverage_answer` の期待値に custody の 11 命令を足す（⑱のファイル。§3.1） |
| U5 | ⑨・⑩ | ⑨の `bridge10/tests/connect10.rs` が⑩の削除した `connect` を使う件（(a) ⑨が書き直す／(b) ⑩が戻す。前回の報告のとおり利用者の判断待ち） |
| U6 | 所有者 | 混合材料（`MixedSource`）、区画に木材・兵器を入れるか、倉の押収での区画の扱い |
| U7 | ⑩ | V26 の命令ごとの再生（番号が rev 4 で仮に決まったので着手できる。確定の後に固める） |
| U8 | ④ | 割当 rev 4 は**仮**。統合で確定するまで、⑩の差分の番号も仮 |
