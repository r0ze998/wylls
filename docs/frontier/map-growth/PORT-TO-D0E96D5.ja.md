# 分散配置・拡張マップの独立移植候補

基点は④ d0e96d5394d88decf878676f37bc3782654d1045 に⑫のローカル修正2件を重ねた b3920a557e8b74fb75027b3a6910d9d77e5e1220。公開・push・CIは行っていない。

## 出典と限界
⑧v9（3f979d18、wylls-08-archive-v9.tar.gz）は取得できていない。本候補はv9の再現ではない。GitHub preserve/ws08-persistence-ca67d40e の handoff-04/live/all-on-base.diff（SHA256 b147a33b0506fe7df1d5e2fe46506ce77c36a270d33fe12d4ffe6ca94faf7b1d）を実物として三者マージした。旧パッチ基点は4cd901de。20ファイルの競合を解消した。

## 維持・接続
- 継続世界フラグ80、NFT記録130と最大kind134、賞金InitPoolの継続世界拒否・状態検査を保持。
- placement77、ceiling78–79、Frontier拡張値66、命令0xC1、記録104を追加。④の割当と一致。
- 既定placement0/ceiling0、keeper自動拡張無効を維持。設定や採否は変更していない。
- Rust/JSで未知のplacement値を拒否。旧UI fixtureのprogram version不足を修正。
- ABIの競合したJSONは構造マージし、SDK同期を実行。アドレス生成を含むabi-vectors全体は実行していないため、生成器との完全な鮮度照合は未確認。

## 実行済み（鍵なしホスト）
- Web placement/live-map/continuous: 23/23。node cryptoガード付き、WASM既存成果物で境界経路も通過。
- rules geometry: 7/7。
- ABI cq_v2_contract: 4/4。presets: 9/9。record specs: 1/1。
- cargo check --locked --offline -p permutation-frontier: 成功。
- cargo check --locked --offline --manifest-path permutation-prize/Cargo.toml: 成功。
- git diff --check: 成功。

## 未実行・未確認
- frontier-nodeのherald/keeper/stack/fclient/botsのcargo checkは、承認機構のauthorization changed before approval could be appliedで未実行。迂回・再試行していない。
- 新たなSBF、LiteSVM、ローカルチェーン、ブラウザ実画面、実ウォレット、本番確認は未実行。
- v9との差分、拡張時の大規模負荷、keeper/herald全州走査、旧ticket経路との境界は追加レビューが必要。
- 上限は半径128、賞金対応は17。無限マップではない。実配備・本番設定の変更なし。

鍵生成・導出・署名の試験、セットアップ・チェーン起動は一切実行していない。コードのコンパイルは実行時の認証を試した証拠ではない。

## 最新④との照合
④ b954990dd148c51b6591907cf61d8931cb9334a5（30a3fd2e荷車Run含む）と競合なしで統合。旧基点以降の④変更と本移植の変更ファイルの重複は0。仮merge treeは9dc220b38ac3834c50e24ef0d248c0e8b6f0e3a6。④の08取り込みは保存文書と引渡しパッチであり、コアへの本移植とは別。新④追加分の実行試験は未実施。

## 独立レビュー後の修正
- JoinResidentの容量が初期R_MAXのみだった不一致を修正。通常Joinと同じmax(初期半径、設定上限、Frontier拡張値)を使い、共通の純粋容量述語へ接続。境界試験1/1、nft-experimental付きhost compile成功。実NFT参加取引の通し確認ではない。
- V11は分散配置のseed/設定欠落を旧扇形に推定せずmissingとして返す。Webも欠落seed/未知modeでは候補をUnavailableにする。Web回帰24/24。V11のcompile・実行は承認不成立のnode確認と同じ範囲であり、再試行していない。
- 最新④統合後の再試験：Web24、幾何7、ABI契約4、presets9が通過。v9未受領・上限128・実チェーン未確認という限界は変わらない。

## 追加レビュー：FileTicket と分散本国の整合

FileTicket は本国範囲（ring 2..heartlandMaxRing）だけ PlaceHome と同じ home_nation で申請者の国を判定するようにした。外側の難民・隣扇形 overflow、および旧 placement 0 の許可条件は変更していない。Web の planTicket と autoTicket も同じ配置情報を渡し、本国範囲で別国を候補にしない。seed 不足は readfail とし推定しない。

純粋 Rust の dispersed_tickets_match_home_nation_but_preserve_external_overflow は 1/1。NFT feature の cargo check は成功。鍵禁止ガード付き placement/live-map/continuous の限定 Web 試験は 25/25。FileTicket の実チェーン実行、署名付き自動申請試験は未実施。旧8が残していた逃げ道を全域で禁止する変更ではない。

## 追加修正：PlaceHome の JoinShard 扇形カウンタ（基点 4b3abc62、未実行）

PlaceHome は `holdings_by_wedge` を申請者の国（faction）で加算していた。SettleTicket・SettleTicket の押し出し戻し・ReleaseDormant はいずれも州の幾何扇形（`coord.wedge()`）で加減算し、FoldOccupancy が `wedge_open`（扇形基金ごと）と並べる `wedge_occupied` もこの扇形の意味である。placement 0 では国＝扇形なので差は出ないが、分散配置では国の本国州が別扇形に置かれるため、同じ村を置いた加算と解放した減算が別の添字に当たり、`wedge_occupied` が OpenRing・ExtendFrontier の θ 判定と FileTicket の旧 overflow 判定（own_open − own_occupied）に対して永続的にずれる。

- `permutation-frontier/src/proc/citizen.rs`：`holding_wedge(coord)` を追加し、PlaceHome・SettleTicket・ReleaseDormant が同じ添字を使う。PlaceHome の権利判定（`home_nation == faction`）・ReservedSite・旧 ticket 経路・overflow 方針は変更していない。純粋試験 `dispersed_first_home_counts_in_the_provinces_wedge_not_the_nation` を追加。
- `permutation-frontier/svm-tests/tests/placement.rs`：分散配置の PlaceHome ごとに、州の扇形の添字だけが +1、他の 5 添字は不変であることを実 VM 試験に追加。
- `frontier-node/crates/verify/src/checks/v11_land.rs`：HOME_PLACED の検証を同じ添字（州の扇形）に揃え、他扇形の不変も見る。あわせて本国上限（ring ≤ heartland_max_ring）を検証に加えた（プログラムは ReservedSite で拒否するが検証器は見ていなかった）。配置証拠の読み取りを純粋関数 `home_rule_of` に分け、conquest ブロック欠落・分散 seed 欠落・未知 placement は従来どおり missing（扇形への推定なし）。純粋試験 `home_rule_follows_the_program_and_fails_closed_without_evidence` を追加。

この作業では Bash・ネットワークを使えず、cargo check・cargo test・node test・SBF・LiteSVM はいずれも実行していない。親が鍵なしの対象を指定して実行する。Web 側（home/fjoin/fgeo/controller）は seed を復号済み Season から 32 バイトで受けており、本国内では home_nation、本国外では旧扇形規則と一致していたため変更なし。

## 第二回：鍵なしホスト回帰・V11 FileTicket・V26 ExtendFrontier（基点 4b3abc62 + 第一回修正、未実行）

第一回の修正を独立に再確認した。FoldOccupancy は各 JoinShard の `holdings_by_wedge[w]` を `wedge_occupied[w]` に合算し（`proc/map.rs` fold_occupancy part 2）、`wedge_open` は ProvinceFund の扇形（`fund_wedge` = 州の幾何扇形）で折り畳まれるので、PlaceHome・SettleTicket・ReleaseDormant が `holding_wedge(coord)` で同じ添字を使う修正は前提ごと正しい。V11 の HOME_PLACED 検証は、追放中（`EXPELLED_SINCE ≠ 0`）の市民の村に `mark_holding` が立てる expelled フラグを許していなかった（正当な配置を偽の FAIL にする）ため、市民の事前状態から読んで許すよう直した。それ以外は変更していない。

### 実装ファイル
- `permutation-frontier/src/map_growth_runtime_tests.rs`（新規）、`permutation-frontier/src/lib.rs`（`#[cfg(all(test, feature = "program"))] mod map_growth_runtime_tests;` を追加）。実物の `dispatch` で PlaceHome と ReleaseDormant を手組みの口座上で実行する鍵なしホスト回帰。`resident_runtime_tests` とは別モジュールで、その suites は実行しない。
- `frontier-node/crates/verify/src/checks/v11_land.rs`：TICKET 記録ごとに FileTicket を事前状態から再判定する `filed_ticket` と、純粋関数 `judge_ticket` / `ticket_site_rule` / `legacy_wedge_allowed`（プログラムの `wedge_allowed` をそのまま固定）。分散本国（placement 1、ring 2..=heartland_max_ring）は `home_nation`、それ以外（placement 0、M1、本国外）は旧扇形規則と隣扇形 overflow を無変更で判定する。conquest 季節に conquest ブロックが無い、分散本国の州なのに GENESIS_SEED が無い、未知 placement、事後状態なし、Citizen/Frontier の事前状態なし、CreateSeason なしは MissingData（推定なし）。FileOutpost が同じ取引にある TICKET は V22 の対象なので触らない。
- `frontier-node/crates/verify/src/checks/v26_growth.rs`（新規）、`checks/mod.rs`（conquest 季節で `V26:map-growth` を実行）、`checks/v0_coverage.rs`（ExtendFrontier を S1 季節で modelled に。V26 が検証するので追加した）、`checks/v0_evidence.rs`（記録 104 を MODELLED_CQ_KINDS に追加。`tests/new_bands.rs` の every_conquest_kind_the_abi_knows_is_modelled は 104 が ABI にあるのに未登録だったため、基点では失敗していたはず）、`codes.rs`（`TicketPlacementMismatch`、`FrontierExtensionMismatch`）。V26 は成功した ExtendFrontier ごとに、取引前の Season と Frontier から `fclient::land::frontier_extend_check`（プログラムの検査順：ceiling、d = 実効 r_max + 1 ≤ ceiling、Running、rings_opened == d、前回開輪から 1 bell、θ 占有）で d を再計算し、事後 Frontier が「r_max_ext = d と連鎖ヘッダ以外は 1 バイトも変わらない」こと、FRONTIER_EXTENDED がちょうど 1 件で key d・payload (from, ceiling)・bell が取引のものであることを見る。ExtendFrontier の無い取引の FRONTIER_EXTENDED、ログが無い取引、事前状態の欠落、復号できない事前状態は MissingData（第三回で帰属ガードに整理）。

### 監査用の試験名（鍵生成・導出・署名なし。実行は親）
- `cargo test -p permutation-frontier --lib map_growth_runtime_tests::`（既定 feature。`--features nft-experimental` と同一バイナリにするなら `--test-threads=1`）
  - `map_growth_runtime_tests::map_growth_dispersed_home_lands_off_its_wedge_and_counts_under_the_provinces_wedge`：扇形外の本国州への PlaceHome。Holding/Citizen/Province/JoinShard（`holdings` +1、`holdings_by_wedge[州の扇形]` +1、国の添字は 0 のまま）、HOME_PLACED の key/payload/4 links、賛助者の家賃支出。
  - `map_growth_runtime_tests::map_growth_dispersed_placement_refuses_a_stranger_a_taken_site_and_a_second_grant`：他国の州（自扇形内でも）BadData、ring 4 と ring 1 は ReservedSite、取られた拠点 TicketState、二度目の付与 AlreadyDone。拒否はログも計数も残さない。
  - `map_growth_runtime_tests::map_growth_release_dormant_undoes_the_wedge_counter_and_keeps_the_lifetime_grant`：7 日前は NotDormant、家賃先違いは BadAddress、解放で同じ添字が 0 に戻り `released` +1、拠点は released-free（gen 維持）、Holding は家賃払いへ閉鎖、RELEASE と CLOSE の 2 記録、HOME_GRANTED は残り再配置は AlreadyDone、FileTicket の資格（旗と ticket_bell）は戻る。
- `cargo test -p verify --lib checks::v11_land::tests::` と `checks::v26_growth::tests::`
  - `checks::v11_land::tests::legacy_wedge_rule_is_the_programs`
  - `checks::v11_land::tests::ticket_site_rule_follows_the_program_and_fails_closed_without_evidence`
  - `checks::v11_land::tests::dispersed_ticket_judgement_follows_the_program_and_fails_closed`（有効・無効・不完全：国の州は Pass、扇形の国は Fail、placement 0 なら逆、本国外の隣扇形 overflow は自扇形満杯かつ最外輪のときだけ Pass、`r_max_ext` による実効 r_max、seed/ブロック/事前状態/事後状態/CreateSeason 欠落は Missing）
  - `checks::v26_growth::tests::a_valid_extension_passes_and_the_next_ones_stop_at_the_ceiling`
  - `checks::v26_growth::tests::an_extension_the_program_would_refuse_fails`
  - `checks::v26_growth::tests::a_post_state_or_record_other_than_the_programs_fails`
  - `checks::v26_growth::tests::incomplete_evidence_is_unverifiable_never_a_pass`
  - 既存で影響するもの：`checks::v0_coverage::tests::every_abi_tag_has_a_coverage_answer`（ExtendFrontier の判定を追加）、`tests/new_bands.rs` の `every_conquest_kind_the_abi_knows_is_modelled`、`tests/unit.rs` のコード重複検査。
- 第一回の純粋試験 `dispersed_first_home_counts_in_the_provinces_wedge_not_the_nation`、`home_rule_follows_the_program_and_fails_closed_without_evidence` は変更していない。

### ホスト回帰の限界
- `is_signer` は試験が立てる（署名検証なし）。SBF・計算予算・ローダ・ランタイムの口座検査は無い。System の Transfer/Allocate/Assign/AllocateWithSeed だけを stub が模倣する。
- 拒否時の巻き戻しが無い（実鎖では取引ごと戻る）。試験する拒否はいずれもバケット以外の書き込み前に出る。
- Season・Frontier（ring 0–3 開）・Province（空き 4 拠点）・Citizen はバイト列で直接置く。OpenRing・OpenProvince・Join・FoldOccupancy は実行しないので、折り畳み値そのものは動かしていない。
- Holding の閉鎖で呼ばれる `AccountInfo::resize` は鍵の 4 バイト前と data の 8 バイト前を読み書きするので、口座バッファに余白を付けてある。
- 時計と家賃は `set_test_clock` と既定 Rent。

### 親の監査結果（第二回）
親がモジュール名の完全一致フィルタでオフライン実行：ホスト dispatch 試験 3/3、V11 モジュール試験 4/4、V26 モジュール試験 4/4、いずれも PASS。鍵・署名の作業なし。監査で正しさの問題が 2 件指摘され、第三回で直した（下）。

### 第三回：取引への帰属ガード（親監査の 2 件、未実行）
記録庫が持つのは取引単位の事前・事後状態で命令単位ではない。第二回の V26 と V11 は「取引 = 命令 1 つ」を前提にしていたので、帰属できない取引を判定せず、かつ黙って飛ばさないよう直した。

- `checks/v26_growth.rs`：`guard(ixs, n_records, season, frontier)` を `run` の前段に置いた。ExtendFrontier がちょうど 1 つで、取引内の他のプログラム命令が Frontier **または Season** を書きうる（`Ix::writes`：OpenRing、FoldOccupancy、2 つ目の ExtendFrontier、Season を書く lifecycle 命令、表で解決できず message が writable にしている位置）ものが無いときだけ `judge_extension` に渡す。判定は取引前の Season（ceiling・θ・時計・状態）も読むので、Season だけを書く命令の同梱も MissingData。Season/Frontier を読むだけの命令（FileTicket、SetVigil 等）は妨げない。V11 の `judge_ticket` は Season の事前状態を使わず、CreateSeason の命令データと GENESIS_SEED 記録（後続命令が書き換えない値）から placement・本国上限・r_max・seed を取るので、Season 書き込みの同梱に対する追加ガードは不要（最終レビューで確認、変更なし）。同梱された取引は MissingData（プログラムは同梱を許すので「無効な取引」とは呼ばない。2 つ目が必ず拒否されるとも主張しない：間に別命令が挟まりうる）。最上位の ExtendFrontier が無い取引の FRONTIER_EXTENDED も MissingData（内部命令。V0E が報告する）。別の Season/Frontier を名指す命令だけ FAIL。
- `checks/v11_land.rs`：`route_ticket(ixs, citizen, frontier, n_records)`。TICKET 記録の市民口座（`citizen_by_tag15`）を名指す FileTicket がちょうど 1 つで、取引内の他の命令がその Citizen も Frontier も書きえないときだけ `judge_ticket`。市民の唯一の申請が FileOutpost なら V22 の対象。同一市民の FileTicket+FileOutpost、FileTicket 2 つ、別の Citizen/Frontier 書き込み（SetVigil、OpenRing など）、最上位命令なしは MissingData で、FileOutpost が同居しているだけで FileTicket の検証を飛ばす旧動作は無い。市民の申請がどれも無い TICKET、FileTicket 1 つに対し同一市民の TICKET が 2 件は FAIL。他の市民の申請が同居していても、孤立した申請はそのまま検証される。
- 追加の鍵なし試験（帰属層）：
  - `checks::v26_growth::tests::the_guard_judges_only_an_isolated_extension_and_never_calls_a_bundle_invalid`（最終レビューで Season だけを書く命令の同梱 → Missing、Season/Frontier 読み取りのみの命令の同梱 → 判定、の 2 件を同じ試験に追加）
  - `checks::v11_land::tests::tickets_are_attributed_by_instruction_evidence_and_mixed_transactions_never_pass`

### 残る未確認・blocker
- 第三回の変更（ガード 2 つと試験 2 つ、`run`/`filed_ticket` の配線）は未コンパイル・未実行（Bash 不可。親が実行する）。第二回の 11 試験は親が実行済み PASS。
- V11 の FileTicket 判定と V26 は純粋関数と帰属層の単体試験のみで、記録済み fixture（march/conquest）に対する全体実行は未実施。既存 fixture に TICKET があれば `filed_ticket` が新たに判定するので、Citizen/Frontier の事後状態が無い fixture や同梱取引では MissingData が増える（fail-closed。既存の期待 verdict が Pass の試験は影響を受けうる）。
- 帰属が「取引内の他命令が書きうるか」を `Ix::writes` で見る以上、M1 の表で解決できない v2 命令は message の writable フラグへ退避する保守判定になる。命令単位の状態再生（取引内の命令列を順に適用する）は実装していない。
- 統合候補 6984acfa の取り込み・merge・fetch は行っていない。v9 未受領・上限 128・実鎖未確認の限界は変わらない。

## 最終独立確認（第三回修正後）

上記の各回の「未実行」は執筆時点の状態。第三回の帰属ガードとSeason書込みガードを含む最終候補について、実行対象と共通セットアップを読んでから、次をオフラインで実行した。

- `cargo +1.89.0 test --locked --offline -p permutation-frontier --lib map_growth_runtime_tests:: -- --test-threads=1`: 3/3 PASS。
- frontier-nodeで `cargo +1.95.0 test --locked --offline -p verify --lib checks::v11_land::tests:: -- --test-threads=1`: 5/5 PASS。
- 同じく `checks::v26_growth::tests::`: 5/5 PASS。
- 変更したRust3ファイルのrustfmtとgit diff --checkは成功。鍵の生成・導出・署名、CI、push、deployは行っていない。

これはゲーム本体dispatchの鍵なしホスト試験と検証器の証拠判定試験であり、署名・実SBF・チェーン・全命令の統合動作を証明しない。最新④ 6984acfaへのmergeは未実行。


## 6984acfa統合後の監査訂正

ローカルの56914060にCCの7107127eを取り込み、mod.rsの宣言競合はV26とV27を両方残して解消した。V27本体とV9本体は6984acfaと同一で、V0の「S1検査が実際に走らないJoinResidentは未検証」という修正も保持した。

以前の「map_growth_runtime_tests 3/3は鍵の導出なし」という報告は不正確だった。共通のWorld::newはseason_bumpでfind_program_addressを呼び、AddrCtxによるwith-seedアドレス計算も行う。CPI模擬はcreate_program_addressを呼ぶ。秘密鍵生成・暗号署名とは異なるが、PDA/with-seed禁止の条件を満たさない。以前の3件成功はその条件に準拠した試験結果として数えない。本統合作業ではこの試験を実行していない。

V11/V26の限定単体試験は固定バイトと純粋な配置・証拠判定を使うが、本統合SHAでの再実行・全検証器実行は未実施。以前の承認エラーとなった試験の代替実行は行っていない。静的差分検査のみで実ゲーム・実チェーン・完成を証明しない。push・CI・deployなし。
