# 15 V26 の命令の再生、④の統合候補 cf517b55・fa822453 への差分、⑨ 872fe6a2 との照合（2026-11-08）

## 0. 起点

| もの | 完全 SHA | tree | 扱い |
|---|---|---|---|
| ④の統合候補（依頼時） | `claude/gallant-ride-cunptv` `cf517b558d1303a84dba618550f40cb460b7ad99` | `75b67dc4f929527deaf885ae8858325e0b23b482` | 0001–0014（`45cea676`）を含み、0015（`ed1e009e`）を含まない（確認した） |
| ④の統合候補（作業中に更新） | 同じブランチ `fa8224538b8e4e4a92c2aee06ff5186a7e033576` | `8c4b1a852a90bafc777d96eab62d400c53294d17` | 0015 を `5ee66869` として取り込み済み（④の INTEGRATION §12） |
| ⑨ | `claude/elegant-bohr-co2uhr` `872fe6a2195267415684351126cd9abb6effcd2a`（利用者の連絡） | `11aa5184482a44b28235bfe54e0405a0219bb03a` | その後の `8ea3c047` も bridge10 の tree `1177f502…` と⑩の pin は同じ |

## 1. 統合候補に取り込める差分

**残る差分は 1 つ**：`patches-candidate/0001-Verifier-V26-replay-the-single-lot-custody-instructi.patch`（`SHA256SUMS`）。同じ patch-id（`e9071f24…`）で両方の起点に当たる。

| 起点 | 当て方 | 結果の commit | tree |
|---|---|---|---|
| `5ee66869`（④の指定、tree `f140f6316d7db6e1bd410cca3a751ec40006ef4a`） | `git am` | `workstream/10-custody-5ee6` `aa8110f83c030b4b17f4f51ea35a646db2f15986` | `bd2ed1f07da907333b43efa1f18a780f94ca5822` |
| `fa822453`（最新） | `git am` | `workstream/10-custody-fa822` `b91d2e52c705ab1cfa3d0bf8c5860cfa2b4c446f` | `b123bc4b0cca4c3f5ed79dc9dd362f8f4a4ca243` |
| `cf517b55` | 先に `patches-r4/0015`、次にこの patch（`git am`） | `workstream/10-custody-cf517` `fea1f36f…`（0015、tree `93d3c31b…`）→ `f9f9754544bff5e818b14d99236ac668ce53794b` | `8eaa7585dc05f55ee0bcd518b5d991fe5c955594` |

変えるのは `frontier-node/crates/verify` だけ（`checks/v26_custody.rs`・`checks/mod.rs`・`codes.rs`、試験 `custody*.rs`）。他のチームのファイルは触れていない。

## 2. V26 の命令の再生（`V26:custody-replay`、custody のシーズンだけ）

着地した取引に custody の命令が 1 つあれば、その取引の前に記録された状態（`World::state_before`）の上で、⑩のカーネル（`permutation_rules::frontier::custody`）をプログラムと同じ口座の順・引数の読み方（`permutation-frontier/src/proc/custody.rs`）で動かし、取引が残した区画（と、プログラムが書くときは倉の custody の数）と比べる。

| 命令 | 口座（プログラムの順） | カーネル | 比べるもの |
|---|---|---|---|
| OpenLot | 倉 4・所有者の Citizen 5・区画 6・支払い 1 | `open` | 区画の全体、倉の STORES・CUSTODY_QUOTA・CUSTODY_LOTS |
| SetLotQuota | 倉 4・区画 5 | `set_quota` | 区画、倉の数 |
| SetLotOrder | 倉 4・区画 5・受け手 6・宛先の倉 7 | `set_order`（運ぶ注文は、宛先の倉が立っていてその世代であること。プログラムの確認） | 区画 |
| RevokeLotOrder | 区画 4 | `revoke_order` | 区画 |
| ConsumeLot | 倉 4・区画 5 | `consume` | 区画 |
| CloseLot | 倉 4・区画 5・家賃の受け取り 6（区画の `RENT_TO` と同じこと） | `close`（開いた区画は倉の数を戻す。没収された区画は倉を読まない） | 区画が閉じたこと、開いた区画なら倉の数 |

**署名者**：プログラムの財布の前処理（`Auth::Wallet`）と同じく、口座 0 が Citizen（口座 3）の財布なら財布、期限内の Frontier の session なら session（`by_session`）。どちらでもなければ FAIL。**時刻**：`bell_at(genesis_ts, 取引の時刻)`。

| 結果 | 判定 | コード |
|---|---|---|
| カーネルが同じものを書く | 所見なし | — |
| カーネルが拒む、または結果が違う | **FAIL**（その取引） | `CustodyReplayMismatch`（新規、FAIL_CODES に追加） |
| 前後の状態・時刻が入力にない／隊商を動かす命令（DepositLot・ShipLot・SettleCustody・ReconcileLot・WithdrawLot）／一つの取引に custody の命令が複数 | UNVERIFIABLE | `CustodyReplayIncomplete`（新規） |

**PASS にしない**：再生が一致しても、ガードの `CustodyUnverified`（隊商と記録は再生していない）は残る。custody のシーズンの最良は UNVERIFIABLE のまま。ガードの文は「no V26 replay yet」から「V26 does not replay caravans or records yet」に直した（試験 3 か所の期待値も）。

**再生していないこと**：口座の住所と所有者（V9）、シーズンと行動の枠（前処理）、命令が書く記録、隊商。

## 3. 試験（鍵の生成・導出・署名なし）

新しい試験 `tests/custody_replay.rs`（10 件）。状態はカーネルで作り、`verify()` を通す試験は記録済みの取引のメッセージに命令を入れるだけ（署名し直さない。`fclient::tx::from_wire`/`wire`）。

| 試験 | 確かめたこと |
|---|---|
| `what_the_kernel_writes_replays_to_a_match` | 6 命令すべてが一致 |
| `a_different_result_is_a_mismatch` | 区画の HELD が 1 単位違う／閉じたはずの区画が残る：FAIL |
| `the_vaults_counts_are_replayed_where_the_program_writes_them` | 倉の lots が 1 違う：FAIL（OpenLot・SetLotQuota・CloseLot） |
| `a_signer_the_program_refuses_is_a_mismatch` | 別人の署名、session で注文（`WalletRequired`）、期限切れの session：FAIL。session の取消は一致 |
| `a_step_the_kernel_refuses_is_a_mismatch` | 注文より多く使う、古い NONCE（`Stale`）、物の残る区画を閉じる、家賃の受け取りが違う：FAIL |
| `missing_evidence_is_not_replayed_and_not_a_fail` | 前後の区画・倉・Citizen、時刻のどれが欠けても UNVERIFIABLE で FAIL でない |
| `caravan_instructions_are_not_replayed` | ReconcileLot は UNVERIFIABLE |
| `random_runs_replay_and_any_unit_off_is_caught` | 乱択 300 系列（注文・使用・取消）：毎手一致し、1 単位ずらした結果（HELD・CONSUMED・注文の残り）は毎回 FAIL |
| `verify_replays_a_landed_instruction_and_fails_a_tampered_one` | `verify()` を通して：一致なら再生の所見 0 件、区画を 1 単位ずらすとその取引の署名に `CustodyReplayMismatch` がちょうど 1 件 |
| `verify_leaves_a_caravan_instruction_unverifiable` | DepositLot は `CustodyReplayIncomplete` 1 件、ガードの所見は残る |

**変異 9 件をすべて検出**（どの試験で落ちたか）：倉の数を比べない（倉の数・欠けた証拠）／session の期限を見ない（署名者）／HELD だけ比べる（乱択）／拒否を UNVERIFIABLE にする（拒否・署名者）／不一致を UNVERIFIABLE で出す（verify 経由）／閉じた区画が残っても通す（結果の違い）／誰の署名でも通す（署名者）／家賃の受け取りを見ない（拒否）／再生を呼ばない（verify 経由 2 件と `a_custody_season_is_never_a_pass`）。

| 起点 | 実行した試験 | 結果 |
|---|---|---|
| `cf517b55` + 0015（再生の前） | rules（全部）、frontier-abi（全部）＋ `abi-vectors --check`、permutation-frontier（既定 107、`custody-preview` 108）、`sync-web-sdk.mjs --check`、カーネルの写し（`core-kernel.py --check`）、`frontier-node` の `cargo check --workspace --all-targets --locked`、verify の `custody` 6・`custody_history` 8・`custody_state` 7・`new_bands` 7・lib の `v0_coverage`（⑱の `every_abi_tag_has_a_coverage_answer`）1 | すべて通過。**U4（⑱の期待値）は⑪の patch 0012（`6cd6dd14`）で解消済み** |
| `cf517b55` + 0015 + 再生（`f9f97545`） | `frontier-node` の check、verify の `custody` 6・`custody_history` 8・`custody_replay` 10・`custody_state` 7・`new_bands` 7・lib の `v0_` 1、stable（1.97）の clippy `-p verify --all-targets -D warnings`、stable の rustfmt | すべて通過 |
| `5ee66869` + 再生（`aa8110f8`） | `frontier-node` の check、verify の `custody` 6・`custody_history` 8・`custody_replay` 10・`custody_state` 7・`new_bands` 7・lib の `v0_` 1、stable の clippy `-D warnings`、stable の rustfmt | すべて通過 |
| `fa822453` + 再生（`b91d2e52`） | `frontier-node` の check、verify の `custody` 6・`custody_history` 8・`custody_replay` 10・`custody_state` 7・`new_bands` 7・lib の `v0_` 1、stable の clippy `-D warnings`、stable の rustfmt | すべて通過 |

実行していない：LiteSVM・SBF・`tamper.rs`・`record.rs`・`coverage.rs`・`fixtures.rs`・`tests/common` の `world()` を使う試験など、鍵の生成・導出・署名を伴うもの。

## 4. ⑨ `872fe6a2` との照合（U5 を閉じる）

| 確認 | 結果 |
|---|---|
| `bridge10/tests/connect10.rs` | `8fe85cc9` で足され、`872fe6a2` で削除（⑨ が⑩に合わせた）。⑩の削除した `connect` を呼ぶ所は残っていない |
| ⑨の `run.sh` の⑩の pin | `563407d9`、custody の tree `b91cbfdd…`、adapter-09 の tree `8d68b5dc…`。**⑩の担当ブランチの現在の tree と同じ**（`git rev-parse HEAD:workstreams/10-custody/{custody,adapter-09}` で確認） |
| ⑨の bridge10 が使う⑩の口 | `LotCustody::new`・`release_by_order`・`try_return_unused`・`owed`・`pay_owed`・`find_lot`・`with_lot`・`check`。すべて現在のアダプターにある |
| ⑩の `with-bridge10` | pin を `06c817cc` から `872fe6a2` へ（kernel の tree `9bd610c3…`、bridge10 `1177f502…`、rules `9ffca167…`）。`adapter-09/run.sh` を実行して全部通過（`results/`）：アダプター自身の試験と変異 14 件、⑨の bridge10 の上の 5 件（乱択 1,000 種：投入 3,388、鉱石を返した受け取り 907、投入の再送 6,813、再起動 7,163）、⑨の bridge を通した変異 3 件をすべて検出 |

**「⑨が直すか⑩が戻すか」は閉じる**：⑨が直した（(a)）。⑩は `connect` を戻さない。

## 5. 未決（⑩は決めていない）

| # | 相手 | 内容 |
|---|---|---|
| U1 | ④ | 検証器の V26 の名前：統合候補の `v26_growth.rs`（⑧の地図の拡張）も `const V = "V26"`。⑩の所見は `V26:custody-*`、コードは重ならないが、所見の `check` 欄は同じ "V26"。どちらかの番号を変えるのは④の判断 |
| U2 | ④ | custody を入れたプログラムの版（今は `custody-preview` の版 5）。⑳の `nft-experimental`（`0x8000 \| S1`）との同時有効はコンパイルエラーのまま |
| U3 | ④・⑳ | NFT の住民の Citizen が custody の命令を使えるか。今は `Auth::Wallet` だけ（財布と Frontier の session）。再生も同じ前提で、住民の証明による署名は「Citizen の財布でも session でもない」として FAIL にする。**住民に許すと決まれば、プログラムと再生の両方を変える必要がある** |
| U6 | 所有者 | 混合材料（`MixedSource`）、区画に木材・兵器を入れるか、倉の押収での区画の扱い |
| U8 | ④ | 割当 rev 4 は仮。新しいコード `CustodyReplayMismatch`・`CustodyReplayIncomplete` は検証器の文字列で、ABI の番号ではない |
| U9 | ⑩ | 隊商を動かす 5 命令の再生（隊商と州の経路の再生が要る）と、記録（`LOT_*`）の照合。これができるまで custody のシーズンは PASS にならない |

## 6. ④への適用方法

1. ④の指定の基点 `5ee66869` なら commit `aa8110f8`（tree `bd2ed1f0…`）を cherry-pick、または同じ patch を `git am`。最新の `fa822453` の上で：`git am workstreams/10-custody/patches-candidate/0001-*.patch`（`sha256sum -c SHA256SUMS`）。tree が `b123bc4b0cca4c3f5ed79dc9dd362f8f4a4ca243` になることを確認する。または commit `b91d2e52`（⑩の担当ブランチの merge の第 2 親として保存）を cherry-pick。
2. 確認（鍵なし）：`cd frontier-node && cargo test --locked -p verify --test custody --test custody_state --test custody_history --test custody_replay`（31 件）。
3. ⑩の担当ブランチの先端の `permutation-rules/`・`frontier-node/` は以前の統合候補のまま（core は patch と、merge の第 2 親として保存しているだけ）。

## 7. ⑨の capacity-preview との接続（⑨からの確認、2026-11-08）

| # | ⑨の質問 | ⑩の答え |
|---|---|---|
| 1 | ⑨の命令の中で `custody::consume`・`return_unused` を呼んでよいか、共有の補助関数はあるか | カーネルの関数（`permutation_rules::frontier::custody`）はそのまま呼べる。プログラムの `proc/custody.rs` の読み書き・倉の検査（`vault_view`・`vault_of_lot`・`lot_of`・`put_lot`・`put_vault`・`actor`）は**モジュールの中だけ**（`pub` でない）。⑩が `pub(crate)` にする差分を出せる（⑩の領域、判定は変わらない）。同じ配置を⑨が別に書くと二重になるので、こちらを勧める |
| 2 | V26 は⑨の命令（0xF6・0xF9）が区画を動かすことをどう扱うか | 今の V26 では FAIL にならない：区画の口座の変化は履歴の検査で、「利用注文の減った量の範囲で CONSUMED が増える」「CONSUMED は減ってよい（返却）」として通る。⑨の命令は custody の命令ではないので再生されず、区画は痕跡として UNVERIFIABLE のまま。**⑨の命令を再生して検証するには、V26 が⑨の tag と口座の順を知る必要がある**（⑨の命令が確定した後に⑩が足す）。記録：`consume` には `LOT_CONSUMED`（112）があるが、返却の記録の種類は ABI にない（番号は④の割当） |
| 3 | 凍結した区画 | ⑩のカーネルも、押収された倉の区画には `consume`・`return_unused` を拒む（`usable`）。未返却のまま残すのは⑩のアダプターと同じ。没収の扱いは未決のまま（所有者の判断） |
