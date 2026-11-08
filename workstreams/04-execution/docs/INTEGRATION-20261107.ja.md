# 統合 2026-11-07（④、ローカル、push していない）

## 1. 順序

1. 3ad0bcdb（利用者の CC の統合候補。⑲ r2、⑪ 0011 を含む）
2. → ⑳ 552c1d14、9e9fe7af、030bf677、72d84173
3. → ⑲ 7ab2b0b2（利用者から受け取った bundle `ws19-ledger-on-72d84173`、SHA-256 `23dffcb5c2a5249922b88b3a592d36a7e604ab052dabcf67817b847cb1f8b0e9`、前提は 72d84173。照合済み）
4. → ⑳ 7d077fc6
5. ＋ ④ r4（57c5c171。31 項目の照合）＋ ④ の試験

**二重に当てていないもの**：⑲ r2（c022f4fc）と ⑪ 0011（3c6d2b6b）は、3ad0bcdb にすでにあります。もう一度は当てていません。

## 2. 履歴の試験の期待値の変更（⑲）を読んだ結果

- **変更**：`tests/history.rs` の 2 か所の assert。
  - 変更前：feed の cursor だけのアーカイブを `ledger_feed` とする。
  - 変更後：`unproven` とする。
- **判断**：期待値は厳しくなる方向にしか変わっていません（台帳の履歴として信用しない）。このため、不具合を隠す変更ではありません。
  - 台帳の履歴になるのは、`input::read_archive` が `findex::ledger::join` で欠けがないと確かめたアーカイブだけです。

## 3. 誤って PASS にならないことの確認（④ の独立した試験 `findex/tests/ws04_join_adversarial.rs`、7 件、鍵なし）

| 場合 | 結果 |
|---|---|
| 同じ runId のまま末尾が巻き戻り、もう片方のアーカイブが巻き戻り後の台帳を読んでいる | 「一つの番号に二つの取引」：whole にならない |
| 共有の取引の番号を、片方だけで動かす（5 通り）。または署名を変える（3 通り） | どれも whole にならない |
| 片方のアーカイブが短い | 短い方の cursor で切る。それより先は結合しない（beyond として数える） |
| 短い方が、自分の cursor より先の記録を持つ | whole にならない |
| 片方のアーカイブが何も読んでいない | 0 で切る。何も結合しない |
| runId が違う | whole にならない |

- **⑲ の試験で確かめていること**：再開のとき、アーカイブの最後の記録が同じ番号・同じ署名で node に残っていなければ、拒否します（`a_rewound_ledger_under_the_same_run_id_is_refused`）。

## 4. 見つかった限界（⑲・⑳ へ。修正は未着手）

- **どちらにも見えない巻き戻り**
  - **起きること**：A が番号 5 を記録した後、node が巻き戻ります。番号 5 には、どちらの program にも関係しない取引が付きます。B は巻き戻った後に読みます。
  - **結果**：`join` は whole=true を返し、A の古い番号 5 を含めてしまいます（④ が実行して確かめました）。
  - **気づける時点**：A を次に再開したときです。その前に、A のアーカイブだけで検証すると、node が今はもう持っていない取引を含んだ履歴を、`ledger_feed` として扱います。
  - ⑲ の module の注記には、この限界が書いてあります。
- **対策の案**
  - 検証で `--rpc` があるとき、各アーカイブの最後の記録が、同じ番号・同じ署名で node に残っているかを確かめる（再開のときと同じ確認）。
  - あわせて、`frontier_status` の `ledgerBytes` を記録し、前回より減っていないかを確かめる。
- **住民プログラムの判定が止まる範囲**：アーカイブの cursor は、その program 自身の最後の番号です。そのため、住民プログラムの最後の取引より後の行為は、UNVERIFIABLE のままです。台帳の先頭（tip）を記録するかどうかは、未決です。

## 5. 実行した試験（鍵ペアの生成なし、署名なし。PDA は計算する）

- **findex**：lib 10、ledger 9、ws04_join_adversarial 7、coverage 14、no_hidden_gap 4、open_items 5、store_failure 5、ingest 4（鍵を使わない 4 件だけを名前で選んだ）
- **verify**：lib 45、history 16、ledger_history 3、resident_ledger 3、new_bands 7
- **herald**：ingest_health 3
- **通しの場面**：固定ファイルの照合 31/31。この merge で、通しの場面のコードは変わっていません。

## 6. 実行していない試験

- **鍵を使うもの**
  - findex の ingest の 4 件（feed_and_rpc_poll…、rpc_poll_pages_the_local_node、enriched_poll の 2 件）
  - verify の tests/common を使う試験（record、tamper、coverage など）
  - LiteSVM と SBF
- **そのほか**
  - findex の `rpc_poll_against_a_live_node`
  - 住民プログラムを載せた、本物の frontier-localnet での実行
  - CI

## 7. 走査した台帳の末尾を返す変更と、⑲ の巻き戻り対策の統合（2026-11-07 追記）

### 7.1 変更の内容

**node（④、e473d9f8）**
- `frontier_feed(after, limit, program, {"scan": true})` は、次の値を、node の lock の中で、記録と同じ読取りで返します。
  - `{txs, scannedThrough, ledgerLen, atAfter, runId, ledgerBytes, durable}`
- `scannedThrough` の意味：`after < seq <= scannedThrough` の台帳の項目は、すべて調べてあります。
- `{"scan": true}` を付けなければ、これまでどおり配列を返します。
- program が address として読めないときは、エラーにしました。これまでは、黙って全取引を返していました。

**findex（④ の提案で、⑲ が同意。70029ee9）**
- 応答のたびに、次のどれかに当たれば拒否します。
  - runId が違う
  - 台帳が cursor より短い
  - cursor の番号にある取引が、記録したものと違う（atAfter）
  - ledgerBytes が減った
- cursor には、走査した範囲（`feed_scanned`）を残します。その pull の全応答が範囲を返したときだけです。
- join は、最も小さい `feed_scanned` で切ります。無ければ、これまでどおり `feed_after` で切ります。

**⑲ の 3c664a61**（bundle の SHA-256 は d5780f3130b77703f44ba2aed68570ac31587925d6aa72095ea25983521a6f69。照合済み）
- `check_node`：アーカイブを node と照らし合わせます。
- 確認した記録だけを、台帳の履歴（`confirm_archive`）とします。

### 7.2 統合で合わせた条件（⑲ と合意）

- `ledger_bytes` は一つの欄にしました。意味は「最後に読んだときの node の値」で、すでに見た値より小さい値では上書きしません（restore、`with_ledger_bytes`、scan のどれでも最大を取る）。
- `check_node` は、アーカイブごとに 1 回、scan の付いた読取りをします。その 1 回の応答で、次のことを確かめます。
  - 最後の記録の署名（atAfter）
  - 台帳の長さ
  - runId と大きさ
  - 走査した範囲が、まだ台帳の上にあること
- scan のない node では、⑲ の元の方法で確かめます。
- node を読めないときは、「確認できなかった」とします。
- **④ の追加**（⑲ のレビュー待ち）：node と照らし合わせていないアーカイブ（`ARCHIVE_ONLY`）は、`basis` を `unproven` にしました。PASS にはなりません。
  - 理由：利用者の条件「node で確かめられないアーカイブは完全扱いしない」。

### 7.3 ⑳ の担当で、レビューが済んでいないもの

- `verify/src/resident_feed.rs`：`from_archive` の `through` に `feed_scanned` を使うようにしました（④ の提案）。
- `verify/tests/resident_ledger.rs`：node と照らし合わせていない 2 本は完全ではない、と確かめるようにしました。照らし合わせた後は、元の期待値のままです。
- ⑳ の確認を待っています。

### 7.4 実行した試験（同じ統合版 d6030067 で。鍵ペアの生成・導出なし、署名なし。PDA は計算する）

- **localnet**：feed_scan_tests 3
- **fclient**：lib 94
- **findex**：lib 10、ledger 14（⑲）、ws04_join_adversarial 7、ws04_feed_scan 9、coverage 14、no_hidden_gap 4、open_items 5、store_failure 5、ingest の鍵を使わない 4 件
- **verify**：lib 45、history 16、ledger_history 5（⑲）、resident_ledger 3（⑳）、ws04_scan_resident 3、new_bands 7
- **herald**：ingest_health 3
- **clippy**（stable、localnet・fclient・findex・verify・herald、all-targets）：警告なし

**④ の試験が確かめていること**（両方のプログラムと、共有の取引を含む）

| 場合 | 結果 |
|---|---|
| 正常 | 走査した台帳の末尾まで完全。どちらのプログラムの最後の取引よりも先まで |
| 読取り中に台帳が伸びる | 取りこぼしがない |
| 同じ runId で、読取り中に巻き戻る | 拒否 |
| 同じ runId で、読取りと読取りの間に巻き戻る | 次の読取りで拒否。アーカイブは書き換えない |
| 台帳が cursor より短い | 拒否 |
| 片方の履歴が短い | 短い方で切る |
| scan のない node | これまでどおり、各プログラムの最後の番号で切る |
| 範囲と大きさが食い違う | 拒否 |
| **古いアーカイブを読み直さずに使う** | 結合だけでは完全に見える。node と照らし合わせると、そのアーカイブの名前を挙げて拒否する（最新のアーカイブは挙げない）。node を読めなければ「確認できない」。verifier では、アーカイブだけなら unproven、巻き戻った後に照らし合わせると unknown、変わっていない node と照らし合わせて初めて完全 |
| V28 | 住民プログラムの最後の取引より後の行為も、走査した範囲までは判定する。その先は UNVERIFIABLE |

### 7.5 確かめていないこと

- 本物の frontier-localnet のプロセスでの実行。
  - node 側は、純関数と stand-in の node でしか確かめていません。台帳に取引を入れるには署名が要るためです。
  - program が読めないときのエラーも、実行していません。
- `fsync: false` の node が電源を失った場合（`durable` を記録するだけです）。
- 鍵を使う試験：findex の ingest の残り 4 件、verify の tests/common を使う試験、LiteSVM、SBF。
- CI。

## 8. 公開された統合候補 c7b3c54c の上への統合（2026-11-07 追記）

**土台**：⑳ 85a48c7c（c7b3c54c の上。⑳ 7d077fc6、⑲ 3c664a61、⑩ の custody などを含む）に、④ の 6a97a611 を merge しました。

**方針は c7b3c54c に合わせました**（利用者の方針）
- アーカイブは、node の照合が合っても unknown です。合った末尾は、台帳全体を一度に写したものではないためです。
- そのため、§7.2 の「確認したアーカイブは完全」と、§7.4 の「変わっていない node と照らし合わせて初めて完全」は、この版では当てはまりません。

**衝突**
- `verify/tests/resident_ledger.rs` だけが衝突しました。候補の版（⑳）を採りました。
- ④ の `history.rs` の ARCHIVE_ONLY の扱いは残してあります。候補の `read_archive` は ARCHIVE_ONLY を作らないので、影響はありません。

**④ の試験 `ws04_scan_resident` を、この方針に書き換えました**
- 照合が合ってもアーカイブは unproven で、どの行為についても完全ではありません。
- それでも、`feed_scanned` は残り、node の照合で確かめられます。node の照合は、次の 3 つを名指しで拒否します。
  - 巻き戻り
  - 持っている記録より先まで走査したと主張する cursor
  - program を記録していない cursor

**scan が効く場所**
- 今は、ライブの読取りだけです（⑳ が `resident_feed::fetch` を `scannedThrough` と `ledgerLen` に替える予定）。

**⑲ の提案 (b)〜(d)**（PASS にしてよい条件と、ライブとアーカイブの扱いの一貫性）
- 利用者の判断を待っています。

## 9. 訂正：鍵の規則に反する試験を実行していた（④、2026-11-07）

**何をしたか**
- §7.4 と §8 で「鍵ペアの生成・導出なし、署名なし」として挙げた試験のうち、`cargo test -p fclient --lib`（94 件）は、規則に反していました。
  - `fclient/src/beacon.rs` と `seal.rs` の試験は、試験用の beacon の鍵（`TestKey::new()`）を作り、署名します。
  - `fclient/src/tx.rs` の試験は、固定 seed の鍵ペア（`Keypair::new_from_array([3; 32])`）で取引に署名します。
  - ④は、2026-11-07 の回帰試験で、これを 5 回ほど実行しました。
- `cargo test -p verify --test fixtures` の `march_fixture_is_fresh` も、規則に反していました。
  - この試験は `verify_core::fixture::march::march()` を呼び、固定 seed の鍵ペアと試験用の beacon の鍵で署名します。
  - ④は、これを 1 回実行しました。

**原因**
- ④の事前の確認は、試験のファイルそのものしか探していませんでした。fclient の lib の試験の module や、試験が呼ぶ src の関数（`fixture::march`）は、見ていませんでした。

**影響**
- この container の中の試験の process だけです。外への送信、公開、CI はありません。
- 作られた鍵と署名は、試験の後に残っていません。

**今後**
- fclient の lib と、`verify --test fixtures` の `march_fixture_is_fresh` は実行しません（`record`、`tamper`、`coverage` も、これまでどおり実行しません）。
- 事前の確認は、試験の module と、試験が呼ぶ src の関数まで辿ります。

**確かめ直した結果**（鍵を使わないと分かったもの）
- verify・findex・localnet・herald の lib の試験の module
- findex の tests（ledger、ws04_*、coverage、no_hidden_gap、open_items、store_failure、ingest の鍵を使わない 4 件）
- herald の ingest_health
- verify の history、ledger_history、resident_ledger、ws04_scan_resident、new_bands、custody*、evidence
- どれも、直接にも、呼び出し先の fixture の生成や tamper の注入を通しても、鍵の生成と署名がありません。

**fixtures と evidence の失敗**（0012 の後）
- `evidence` の `the_fixtures_have_nothing_for_v0e`、`fixtures` の `march_synth_passes` と `march_fixture_is_fresh` が FAIL しました。
- ⑪ の報告では、85a48c7c でも同じで、地図の配置の変更（V11 の TicketPlacementMismatch）が原因です。④の差分の外です。

## 10. 荷車の受付で、依頼者の権限を確かめる（④、2026-11-07）

**以前の状態**
- runexec の `accept(spec)` には、依頼者を表す欄がありませんでした。
- 利用者の CC の受付 CLI（`preserve/cargo-cli-reviewed-20261107`、7d2fbe0d）にも、この確認はありませんでした。
- そのため、譲渡後の元の所有者からの依頼を拒否できませんでした（CHAIN-FLOW §10.2）。

**実装**（`src/intake.rs`、`Executor::accept_as`）
- `accept_as(spec, requester, passes)` は、次の順で確かめてから受け付けます。
  1. **run の Citizen のパスを読む**（`Passes`、chain の読取りの port）。無ければ拒否します（全プレイヤーにパスが必須）。
  2. **link と policy**：link と policy は game program のものでなければなりません。link が指す Citizen の `citizen_tag` が、run の `owner` と一致しなければなりません。
  3. **⑳ の `holder`**：asset が、束ねた collection の Core の asset であること、移転ガード（guard）があること、resident の記録が束ねたものであること。
  4. **⑳ の `Holder::authority`**：
     - 署名した世代が、今の世代であること（違えば StaleGeneration）。
     - 依頼者が、今の所有者か、今の所有者がこの世代で設定した、期限内の session であること（違えば NotCurrentAuthority）。
     - session を認めるのは、game の ResidentAct の SendCaravan（`player_as`、session_ok=true）と同じです。
- 確かめるのは、store に書く前です。同じ `run_id` でも先に確かめるので、元の所有者は、run を足すことも、その run があるかを知ることもできません。
- 受け付けた run には、確かめた結果を `Detail.authority` として残します（依頼者、asset、所有者、世代、owner か session か、時刻）。
- 既存の `accept(spec)` はそのまま残しました（プロセス内の経路と、既存の試験）。外からの受付は `accept_as` を使う必要があります。

**試験**（`tests/intake.rs`、6 件、鍵なし。key は固定の 32 byte で、asset と resident は ⑳ の配置の byte）

| 場合 | 結果 |
|---|---|
| 所有者 | 受け付ける。確認の結果が run に残る |
| 譲渡前の、所有者の session | 受け付ける（session として） |
| 譲渡後の元の所有者（古い世代 0 で署名） | 拒否（StaleGeneration） |
| 譲渡後の元の所有者（新しい世代 1 で署名） | 拒否（NotCurrentAuthority） |
| 元の所有者の session（世代 0 と 1） | どちらも拒否 |
| 新しい所有者が古い世代で署名 | 拒否 |
| 新しい所有者 | すぐに受け付ける |
| 譲渡後も残っている、元の所有者の session の記録 | 拒否 |
| 新しい所有者の session | 受け付ける。期限が切れたら拒否 |
| 元の所有者が同じ `run_id` を送り直す | 拒否。新しい所有者なら既存の run を返す |
| パスが無い、link が別の Citizen を指す、link・policy が game program のものでない、guard が無い、asset が Core のものでない、resident の記録が違う | どれも拒否。何も書かない |

- 変異で確かめました。authority の確認を外すと、譲渡に関わる 3 件が FAIL になります。
- runexec の全試験も通りました（signing の bridge を使う gateway の 9 件は、もともと ignore）。

**未決**（利用者の判断が要るもの）
- **実行中の run と譲渡**：受け付けた後でパスが動いたとき、止めるか、続けるか、確かめ直すか。今は続けます。確認の結果が残るので、決まれば適用できます。
- **session に荷車の依頼を任せてよいか**：game の SendCaravan と同じく、今は認めています。賞金の受取の session（U49）とは別の判断です。

**この版でしていないこと**
- 依頼の署名そのものの検証。依頼者の鍵は、呼び出し側（gateway の資格情報の層、③⑤）で認証済みとして受け取ります。
- `Passes` の本物の chain の実装（link・policy の PDA を計算し、asset・resident を読む）。試験は、stand-in の chain で行いました。
- 受付 CLI（7d2fbe0d）への接続。CLI は preserve の branch にあり、統合されていません。

## 11. NFT譲渡後の荷車受付（所有者の決定 2026-11-07 に沿った実装）

決定: 受付済みの荷車は譲渡後も完了まで続行。譲渡後の新規受付は、新しい所有者（またはその所有者が現世代で設定した期限内のセッション）だけを通す。

| 部分 | 実装 | 試験（鍵なし） |
|---|---|---|
| 実チェーンからの所有者情報 | `src/intake_rpc.rs` `RpcPasses`: Citizen → link `["nft-citizen-link", season, asset]`・policy → asset・resident `["resident", asset]`・Clock を `getMultipleAccounts`（confirmed）で読む。最後の3つは1回で読み、所有者・世代・セッション・時刻が同じスロットのものになる | `tests/intake_chain.rs`（PDA上の口座を返すスタンドインノード `tests/common/passnode.rs`） |
| 外部受付 → 権限確認 | `runexec run accept --requester <file> --rpc --program --season`。`intake::authorize` が拒否すれば exit 5 `NotAuthorized`、ストアを開く前（何も書かない）。通れば確認結果を初回detailに記録 | 同上 + `tests/run_cli.rs`（全acceptが依頼者付き） |
| executor | `accept_as(spec, req, passes)` → `intake::accept_checked` | `tests/intake.rs`, `tests/intake_chain.rs` |
| gateway → 依頼者の受け渡し | `clients/runs.mjs` `createRunsClient().accept(spec, {actor, generation, citizen, authenticatedBy})`。依頼者ファイルは0600で一時作成し、終了後に削除 | `clients/runs.test.mjs`（スタブと実バイナリ） |

譲渡前と譲渡後は分けて試験しています。
- 譲渡前: Aの依頼、およびAのセッションの依頼が受け付けられ、A→B譲渡（世代1）の後も Fulfilled まで続く。記録された権限は A・世代0 のまま。
- 譲渡後: Aは世代0では StaleGeneration、世代1では NotCurrentAuthority で拒否。Aの残存セッションも、同じrun_idでの再依頼も、Bの世代0も拒否し、ストアには残らない。Bと、Bが世代1で設定したセッションは受付。期限切れのセッションは拒否。
- CLI: 譲渡後のAは exit 5、Bは Created。依頼者なしは exit 2。

**ここで試験していない部分:** 署名の検証そのもの（gatewayの認証層、③/⑤）は、試験に署名が要るため対象外です。`authenticatedBy` は、検証した層の名前を記録するだけです。実ノード（frontier-localnet）での読み取りも未実施です。

## 12. 2026-11-08 の統合（④）

基点 cf517b55 の上に、次の順で載せた。各チームのサブツリーは、チームが申告した tree と一致することを確認した。

| 順 | 取り込んだもの | commit | 確認（鍵なし） |
|---|---|---|---|
| 1 | live の台帳の読み取りを未証明のままにする（2c8fbfa2） | 8decc936 | verify：lib 47、history 16、ledger_history 7、resident_ledger 4、new_bands 7 |
| 2 | ⑩ ed1e009e（custody の試験が V26 自身の所見で判定する） | 5ee66869 | custody 6、custody_state 8、custody_history 7 |
| 3 | ⑭ 5f4c0b99、のちに d9c8b81d | edd091aa、4b13a7e3 | ⑭ 38 |
| 4 | ゲーム画面の文：custody 100〜104、WideWorldUnavailable。node-key-tests.txt に1行追加（鍵を使うので除外） | 122039e1 | gateway・web 1779/0 |
| 5 | ⑱ fc645596、⑮ 95f44cf3、⑫ 7b75122f、⑥ 59bc9565 | bd14dc81、40356ebb、1dd7b5e9、35ab0f1b | agents の reveal_time_tests 1、⑮ 120、⑫ 56（省略2）、⑥ ports・dispatch・connect・connect-live 17（省略7） |
| 6 | registry.txt の 0xc1〜0xcc（ExtendFrontier と custody の lot） | f7d3b70d | e2e-native registry 1 |
| 7 | wide 系列 0465adc5（preserve/wide-keeper-duties。capture-read・discovery・reader-guards と同じ patch を含む） | cd8b1756 | 下記 |
| 8 | widemode の英語14文、WideIndexUnavailable | 9f68f123 | gateway・web 1790/0 |
| 9 | ⑮ の chain-flow stage D の patch。⑫ の CI job memory12 | d491fd8d、aa20628a | check-fixtures 31/31、check-ci-keyfree ok |

**行った衝突の解消**
- verify/src/resident_feed.rs（2c8fbfa2 と ④ の scan）：安全側に倒した。scan で全体を読めても history は unknown、through は 0 とする。取得した取引は残し（所見は作る）、tip は報告する。試験の期待値は厳しい方向に変えた。
- keeper/src/play.rs の plan_core（⑱ と wide）：wide の feed gate → load_owner_materials → take_shared → ⑱ の owner_tracks_from_chain、の順。

**wide 系列の確認**（試験の呼び出し先を監査した。鍵ペアの生成・導出や署名はなく、engine は中身を見るだけで送信しない）
- keeper：wide_duties 70、wide_discovery 14、wide_reveal 30、wide_snapshot_rpc 6、wide_feed_guard 12
- frontier-abi：world_index 138
- permutation-frontier：map_growth の実行時試験 17（wide-world-experimental）と 6（既定）
- rules：frontier_clash_identity 4
- findex：wide_typed_index 12、ws04_feed_scan 11
- herald：wide 3、wide_capture 9、wide_index_read 1
- 実行していないもの：native-crypto-tests の feature（公開の vector を検証するだけだが opt-in）、SBF、LiteSVM、ブラウザでの表示

**wide の到達点と残り**（実装済みでも、まだ遊べる完成ではない）
- **できていること**：ゲーム画面の地図に、記録された広い世界を読み取り専用で表示する（map/widemode.mjs、herald の /h/world/wide、型付きの索引、観測された履歴は「未検証」と表示）。wide の州の中では、開く → 招集 → 出発 → 開封 → 集合 → 決着 → 精算 → 帰還 → シーズン末の閉鎖までが、host の試験で本物の dispatcher を通る。keeper は、署名しない候補として作り、観測して照合するところまで。
- **ルールの判断が要るので止めているもの**（docs/frontier/map-growth/PLAYABLE-WIDE-COMPATIBILITY.md）：
  1. 一つの世界か、地域に分けるか
  2. 128 環より外の国の配置の続け方
  3. 環の乱数（seed）の証明
  4. 賞の対象とする土地の範囲と集計（今の tally は 17 環まで）
  5. 旧形式と wide の境目（移行）
  6. 128 環をまたぐ行軍で、同点と押し出しの順番（二つの key の系統の間）
- **技術上の閉鎖**（この判断の後に開ける）：DEPART_DEBIT_ENABLED は配備用の build では false。境目をまたぐ移動は拒否。feature は既定で無効で、SBF では使えない。

**取り込んでいないもの**：⑬（別口）。⑤ の共有コア（③が担当）。⑦ は claude/wylls-ui-ux-visual-oixhgs を aa20628a へ積み直し中。⑰ は公開待ち（routes/prize.mjs をどちらにするかは利用者の判断）。⑳ d85c42da は文書1行のみ。②・① はまだ取得できない。

## 13. 2026-11-08 の第2回の統合（④）

fa822453 の上に載せた。各チームのサブツリーは、チームが申告した tree と一致することを確かめた。

| 取り込んだもの | commit | 確認（鍵なし） |
|---|---|---|
| ⑦ 960ca258（22 commit）と ⑱ 6fefd3e6（marches の 4件、サンプル世界を鍵なしにする） | 821b23c5 | gateway・web 1882/0（192ファイル、鍵を使う97ファイルは除外） |
| ⑭ 45da6d38、⑮ 2a3a0c94、① 099a462f、⑥ 148bcebd | fbdd3741、d437b22a、20f0c0d1、384e8e3d | ⑭ 40、⑮ 133、① 234 と browser の鍵なし 8、⑥ 18（省略 7） |
| ⑫ fa4baf14（workstreams/12-memory だけ） | 5c324f91 | ⑫ 62（省略 1） |
| ⑧ 2ad3f450、a8303465、6516a52f、9d2323b1、d6c17faa、0a716e02、46a5fd16（d1d07078 は製品の判断が要るので外した） | f3834d35〜ace22dc6 | map_growth 8（既定）と 19（wide） |
| ⑲ 4dbbe4a3（名前を付けた欠け gaps と LedgerMark） | 7c78e191 | verify の一式（下記） |
| ⑳ b2bd9711、⑪ 606910ba のディレクトリとパッチ 0013 | — | verify の一式 |
| 利用者の integrate/ws13-on-ws04-20261108 5d178b77（⑬ 0e6df20e、⑫ fa4baf14、W1） | cd05ff57 | ⑬ 188件中 182 合格、0 失敗、6 省略（署名を伴うもの）。runexec と ⑤ 10e74967 は実物 |
| ⑤ の 6 パッチ（10e74967、on-ws04-6984acfa）＋ ③ 6b5d1b7b のディレクトリ | 74b29df8 ほか | agent/、mcp/、routes/agent.mjs は ⑤ の e29ec011 と同じ。③ の方法どおりの木（dc4a6265）で ③ 24/24 |

**衝突の解消**
- ⑲ と 2c8fbfa2 と ④ の scan：⑲ の設計を採った。live は、欠けが無くなるまで unproven。2c8fbfa2 の live の試験 2件は、Unknown を見る代わりに unproven と point_in_time_unverified を見るようにした。判定は Unverifiable のままで、緩めていない。
- ⑫ の版は、5d178b77 の中身と同じだった（6c72f320）。二重には当てていない。

**この候補の verify**：lib 50、history 16、history_assurance 8、ledger_history 7、resident_ledger 4、ws04_scan_resident 4、evidence 8、camp_clear 3、unit 8、missing_state 2、open_items 3、custody 6・8・7、new_bands 10

**この候補の keeper ほか**：⑱ の鍵なし 8件、wide_duties 70、wide_reveal 30、wide_feed_guard 12、agents の reveal_time_tests 1、frontier-abi の全部、runexec の全部（署名を伴う gateway の 9件と chain_caravan の 1件は ignored）、chain-flow の check-fixtures 31/31

**残っていること**
- ③ の試験は、この候補では 12/24 にとどまる。原因：③ の代わりのヘラルドの /h/me に `slots` が無い。本物のヘラルドはこれを出し、統合後の画面（ac16d39e）はこれを要る。手元で `slots: []` を足すと 24/24 になった（commit はしていない）。③ に直してもらうよう頼んだ。
- ⑬ の 4種の SQLite を読む canonical の試験（WS04_DB）は、ここでは実行していない。
- ⑰ は公開を待っている。routes/prize.mjs をどちらにするかは、利用者の判断。
- ⑨ の割当て（記録の kind、ClaimSplit、RULESET_HASH）は保留にした。
- 実チェーン、SBF・LiteSVM、ブラウザでの表示は、まだ確かめていない。

## 14. 第3回・第4回の統合と VW1（④、2026-11-08）

**第3回**（20db3313 の後）
- ⑦ 8373ba63
- ⑬ d9ac99ad：W1（5d178b77）と両方を保った。ファイルごとに確かめた。
- ⑲ 668e9b66 の文書2か所：コードの部分は ⑳ の変更を戻すので取らない。
- ⑪ の 0014（sha256 f8763979…）
- ⑩ b91d2e52（V26 の命令の再生）
- ② d0da1d02（rights-experimental）
- ④ が直したもの：
  - ② の分の v2/logs.json と web SDK（作り直し）
  - プログラムの割当ての試験（kind 114〜119 と、版）
  - 画面の試験の偽のヘラルドの形（539e6b89）

**VW1**（4ecef1d9。verify/src/checks/vw_chains.rs。feature wide-world-experimental）
- 確かめること：wide の event の chain。
- 判定：
  - chain の切れは FAIL。
  - 最終の口座との不一致は、履歴が whole のときだけ FAIL。そうでなければ UNVERIFIABLE。
  - wide の記録が1つでもあれば、必ず WideUnmodelled（UNVERIFIABLE）。
- 鍵なしの試験：7件。
- 分担：⑪ が V0 の振り分け、⑳ が 0xDD を受け持つ。

**第4回**（c7836449）
- ③ 6ee7c4d1：③ の試験は、この候補で 27/27。
- ⑦ 24369382（協力の板の入口）、① c01c7418（/coop/config）
- ⑬ 36376b3b、⑥ 7bcdfa24
- ⑩ の 0002（a690a038）、⑪ の 0015（sha256 68b6a039…）
- ⑨ dddef5b5（capacity-preview、コアのパッチ 0001）
- **版のビットの衝突**：② と ⑨ が、どちらも仮の 0x2000 を出していた。④ の仮の割当てとして、② は 0x2000、⑨ は 0x1000 にした。rights と capacity を同時に build するのは compile_error。
- ④ が直したもの：
  - 統合の後の dispatch の閉じかっこ
  - 版の試験を build ごとに
  - quick.rs の試験だけで使うものが、clippy で落ちていた件
  - BadConfig の文

**この候補（c7836449）の確認**（鍵なし）
- gateway・web 1885/0、⑬ 189/0（省略 6）、③ 27/27、① 234、⑥ 20（省略 7）
- verify の一式と VW1 7件
- permutation-frontier：既定 111、capacity 115、custody 112、capacity＋custody 118、rights 150、wide 128、no-default 44
- clippy -D warnings：permutation-frontier と frontier-abi で通過
- rules：既定と capacity。abi：既定と capacity
- abi-vectors と web SDK：fresh
- e2e-native：registry と error_codes

**決めていないこと**
- ⑨ の記録の kind（帯 120〜129、副種別の案）、AccountKind 25・26、KERNEL_VERSIONS、継続世界の R1、Holding の履歴
- ⑩ の LOT_RETURNED
- capacity と custody を組んだ版（今は仮に 5|0x1000）
- NFT 賞金の候補 3090242a：利用者の Mac にしか無い。取得待ち。

## 15. chosen-march の review 系列（④、2026-11-08）

- 取得：GitHub の review/chosen-march-7702251-20261108 → refs/review/chosen-march-20261108。HEAD は 7702251c64b91ba76ad5a86aab18bd04bafa337a、tree は dfc01fd1cbd19326c3910ccbb017c8c25e361c8a（一致を確かめた）。
- 列の形：0465adc5（候補にある wide 系列）の上の 17 commit。内部の merge は 12740235 と 298fdc91。

**取り込んだもの（4b34fd67 を merge、11cc2f2b）**

| commit | 中身 |
|---|---|
| d584424d | wide の命令を、全体の識別子で見直す（実行はしない） |
| 391aa666 | 既存の村の画面に、捕捉した wide の村を読み取り専用で出す |
| 17b8ffaa | 同じものを、鍵なしのブラウザの fixture で確かめる |
| 62f27eb2 | wide の Holding の経済の preview（S1 の規則は変えない） |
| 8c36b961 | 同じ経済の、host での実行。verify に feature wide-economy-experimental を足す |
| bf8bd8a6 | 退却と帰還の境目の試験 |
| 12740235 | 内部の merge |
| 74752b54 | wide の移動中に訓練し、安全に帰る試験 |
| 2eb916aa | 実際の wide の出発と帰還の間に、訓練を挟む試験 |
| 4b34fd67 | 敵対する wide の戦闘と、生き残りの帰還の試験 |

**保留（別の demo の画面と examples。利用者の方針「別の技術デモは作らない」による。⑧ と照合中）**

| commit | 中身 |
|---|---|
| 64f7cd15 | screens/wide-economy-fixture |
| 86b293e8 | examples/local_economy_demo、screens/wide-economy-local（prologue.rs と lib.rs も変える） |
| 298fdc91 | demo の worktree への merge（keeper の 17 ファイル） |
| f9b0f60b、26769fa1、07ae3f0d、7702251c | examples/local_march_demo、screens/wide-march-local（crypto、init.rs、proc も変える） |

**統合で直したもの**
- verify の Cargo.toml：両方の feature を残した。
- controller.mjs：
  - ⑦ の resetViewer（wallet が変わったときだけ消すもの）を残し、wide の表示を消す処理を足した。
  - adoptResident に、⑦ の viewer の初期化を入れた。NFT の login と logout は adoptResident を通る。
- wideholding.mjs と en-frontier：遊ぶ画面の語の規則に合わせた。口座・区画・ランポートを出さない（ランポートは shell の lamports() を通す）。英語の settlement も直した。試験の期待する文も、それに合わせた。

**この木での確認（鍵なし。呼び出し先を監査した）**
- gateway・web：1908/0
- ⑦ の画面全体：12/12
- frontier-abi（world-index-experimental）：254 ほか
- permutation-frontier：wide 168、既定 112。clippy も通過
- verify：wide-economy lib 60 と wide_economy 6、wide lib 59、既定の一式
- keeper の wide：70・33・14・6・12
- herald の wide：3・10・1

## 16. 検証済みの候補 16576826 と、その記録（④、2026-11-08）

**候補（固定）**
- `claude/gallant-ride-cunptv` @ `16576826084a8ea7bd6b12b845d50b97f3d14904`（tree `7f6ff8b0fd1a3765fe00f4507ee87fdcd1ccdd71`）
- 統合の後の判断は、ここでは何もしていない。この節は文書だけで、別の review の枝に置く（候補の枝には入れない）。

**§15 の後に取り込んだもの（取得した源）**

| 源 | 取り込み方 | 候補の commit |
|---|---|---|
| ⑥ `ef9f152d`（文書） | merge | `daa7f48f` |
| ⑧ `6ff7347e`（土地の数の回帰試験と31章） | cherry-pick（`d1d07078` とその取り消しは入れない） | `cd449f08` |
| ⑦ `aac14551`（鍵なしで画面全体を開く試験） | merge | `c2faf106` |
| ⑤ `638c46b5`（⑤のディレクトリ。鍵の guard の変更は監査した） | ディレクトリを checkout | `bd63fc41` |
| chosen-march の core と UI の部分（`4b34fd67` まで。10 commit） | merge。直したもの：controller.mjs、wideholding.mjs の文言 | `11cc2f2b`、`7535a17e` |
| ⑤ `07fc6f64`（relay の木の attestation。隔離した ref `refs/review/ws05-07fc6f64` で読んだ） | ディレクトリを checkout（tree `01582ec1` で一致） | `16576826` |

**7535a17e から 16576826 への差**
- `workstreams/05-ai-participation/model-api` の 4 ファイルだけ（+129/−26）。
- permutation-gateway の subtree（`52ccd7fc`）と workstreams/04-execution は、7535a17e と同じ。

**独立した検証（どの木の結果かを分けて書く）**
- **⑧（7535a17e で実行）**
  - 終了ベル、BeaconLog、配置の fail-closed、輪128、土地の数を確かめた。退行なし。
  - 成長の host 試験 10/10、wide の成長 33/33（成長 10 と wide land 23）、本体の lib 112、abi 152、rules 520、web 63/63。
  - 16576826 については、⑧の担当ファイルが同じであることを確かめた。新しく流したものではない。
- **⑯（7535a17e で実行。REPORT §23。`claude/dreamy-ramanujan-ijj8qj` の `cb2b44f5`）**
  - 鍵なしの範囲で失敗 0 件。
  - verify：既定 193、wide-world 91（VW1 と w1〜w5）、wide-economy 66
  - keeper の wide 138、findex 96、herald 17、abi の world_index 139、wide land 23
  - chain-flow 31/31（変異 12/12）、④ 130、e2e-native 24、⑬ 191（6 件は省略）、gateway・web 1908、画面 46/46
- **⑯（16576826 で実行。REPORT §23.4・§24。`0beb9f6c`）**
  - ⑤ の strict の一式 61/61、⑤ の wallet 13/13、relay-tree の負の対照 2 つ（期待どおり落ちる）。
  - 長い Rust の一式は流し直していない。コードが同じなので、7535a17e の結果として扱う。
- **④（16576826 で実行）**
  - ⑤ の strict の一式 61/61。runexec はこの checkout から build したもの（sha256 `f039854a…`）。
  - 負の対照 2 つ、⑤ の wallet 13/13、gateway・web 1908 通過・0 失敗・1 省略。
- **`web-frontier-controller.test.mjs`**
  - 鍵の一覧に入っているので、CI の鍵なしの一式には入っていない。
  - guard を付けて手で流した結果：④ が fixture を直した後に 19/19。⑯ も 7535a17e で 19/19（⑯ の hook の記録 0 件、guard の発動 0 回）。
  - 一覧は scan が機械的に作るので、手で例外にはしない。

**CI**
- `claude/gallant-ride-cunptv` の workflow run の数は、この枝だけで数えて 16 のまま。
- 最後の run は 2026-11-06 の `8e96f24d` で、その後の push はすべて `[skip ci]`。
- repository 全体の数ではない。

**まだ確かめていないもの（実装はあるが、鍵なしの制約のため）**
- プレイヤーが署名して送る経路。画面の操作は実装済みだが、ブラウザでの署名と、実チェーンでの送信と着地は、検証していない。
- 鍵を使う試験：gateway.rs の 9 件、tamper・record・coverage、findex の ingest の 4 件、⑬ の署名を伴う 6 件、native-crypto-tests。
- 実チェーン（frontier-localnet）、SBF、LiteSVM。

**採用していない判断（提案だけ）**
- 依頼者の認証と route：⑤ の R・D1・D3・D5（`workstreams/05-ai-participation/model-api/DECISIONS-PROPOSAL-9.ja.md`）、⑥ の D1〜D5（`workstreams/06-creation/docs/12-intake-contract.ja.md`）。⑥ の計画の実行と ⑬ の住民の run は、`NoAuthenticatedRequester` で止めている。
- 賞金：U48〜U52（`permutation-nft-resident-spike/docs/UNDECIDED.ja.md`）、中止の返金の出口、受取の route（④版か⑰版か）。NFT の賞金の候補 `3090242a` は、まだ受け取っていない。
- wide のルール 6 点（`docs/frontier/map-growth/PLAYABLE-WIDE-COMPATIBILITY.md`）、⑧ の 31 章（`workstreams/08-persistence/31-decisions.ja.md`）。
- 仮の割当て：版のビット（rights 0x2000、capacity 0x1000、wide 0x4000）、⑨ の記録の kind・AccountKind 25 と 26・KERNEL_VERSIONS（`workstreams/09-capacity/INTEGRATION-04.ja.md`）、⑩ の LOT_RETURNED（`workstreams/10-custody/16-v26-caravan-replay.ja.md`）。
- 保留した demo：`64f7cd15`、`86b293e8`、`298fdc91`、`f9b0f60b`、`26769fa1`、`07ae3f0d`、`7702251c`。本来の画面には入れていない。

### 16.1 ⑧ の読み取りの結果と、建設の締め切りの照合（読むだけ。規則は選ばない）

**⑧ が確かめたこと（16576826 で）**
- 31 章の古い懸念のうち、次の 2 つは直っている：
  - 札と分散配置：`ticket_nation_allowed`
  - 年代記の feed の誤り：`FS.chronicle ?? []`
- wide の開設・claim・行軍・帰還：
  - host だけの実験。Solana の build は無い。
  - WideSetRules は一度だけ設定できる。設定しないままなら NotImplemented のまま。
- ⑧ の将来の設定の案「1/2/2/1」（砦の分散、今の自由都市の hash、今の野営地、鍵を並べ替えた beacon の地域）：
  - 提案だけで、採用していない。
  - 費用・容量の数え方と、賞の対象は、未決のまま。
- 31 章の勧め：
  - §1：中心が満員のときは、新しい地理の成長の規則ではなく、札への切り替えにする。画面の候補 `d1d07078` は取り消してあり、候補に入っていない。
  - §2：世界・座標・本拠・世代・番号の全体の識別子。提案だけで、新しい形式と規則の hash が要る。live では確かめていない。

**有限のシーズンの最後のベルに頼んだ建設が、終わりの後まで続くか（④ が 16576826 のコードを読んだ）**
- 確かめたこと：
  - `permutation-frontier/src/proc/holding.rs` の `build_as` は、完成の時刻 `done_at` を、シーズンの終わりと比べない。
  - `permutation-rules/src/frontier/holding.rs` の `enqueue` は、前の項目の `done_at` の続きから数え、上限を付けない。
  - そのため、最後のベルに頼んだ建設の完成は、シーズンの終わりの後になりうる。
  - プレイヤーの操作は、`frontier-abi/src/prologue.rs` の `player_prologue` が `STATUS_RUNNING` だけを通すので、終わりの後には新しく頼めない。
  - ただし、次の経路は `STATUS_ENDED` も通し、holding を今の時刻で `touch` する：隊商の精算（`caravan.rs`）、征服（`conquest.rs`）、軍勢の帰還（`host.rs`）、custody（`custody.rs`）。`touch` は期限の来た項目を完成させる。このため、終わりの後に完成が反映されうる。
- 確かめていないこと：
  - 「最長 792 ベル」という上限の数字。
  - 終わりの後の完成が、得点や賞に影響するか。賞の集計は、州と土地を数える。建物が数えられるかは確かめていない。
- 提案の commit `02013235`：
  - GitHub の ref にも手元にも無いので、中身と当てはまるかは確かめられない。
- 扱い：
  - 懸念は「古い」ではなく「今もありうる」として残す。
  - 締め切りの規則（終わりで打ち切る、終わりで止める、続ける）は選ばず、コードも変えていない。

### 16.2 画面の検証範囲の訂正（⑦ から、2026-11-08）

**⑦ の訂正**
- これまでの既定の headless shell では、secure-origin の指定（`--unsafely-treat-insecure-origin-as-secure`）が効いていなかった。
- そのため、ページでは WebCrypto が使えず、march の画面は NoWasm で止まっていた。実際の march の操作は動いていなかった。
- ⑦ は full Chromium に切り替えた。ページ自身の `keyFromSeed` なども、呼ばれる前に拒否するガードと、ガードが入っていることの assertion を足して、確かめ直している。
- `session.preflight()` は固定 seed（`fill(7)`）から鍵を導くので、これまでどおり実行しない。

**この記録での分け方**
- 画面の部品の試験の成功と、WASM を動かした march の操作の成功は、別のものとして書く。
- ⑦ の訂正が及ぶのは、問題のあった run（既定の headless shell で、NoWasm になったもの）の限界。ほかの run の証拠まで一律に無効にするものではない（利用者の明確化、2026-11-08）。
- そこで run ごとに、使った browser と、どこまで届いたかを分けて書く：

| run | browser | 届いた範囲 | 届いていない範囲 |
|---|---|---|---|
| ⑯ 画面 46/46（7535a17e） | 記録に browser の種類なし（⑯ に確認中） | 画面の部品 | march の操作（WASM）は、⑦ の新しい結果まで確かめていない |
| ⑧ web 63/63（7535a17e） | 同上（⑧ に確認を依頼済み） | 画面の部品 | 同上 |
| `web-frontier-controller.test.mjs` 19/19（④・⑯） | browser を使わない（Node） | controller の部品 | march の操作 |
| ④ S1 8/8（4d44f021） | full Chromium（`chromium-1243/chrome-linux64/chrome`） | S1 の村のカード、① の板への入口 | march（試験の範囲に入っていない） |
- **march の操作は、⑦ の新しい結果が届くまで「確かめていない」とする。** 検証済みとは書かない。

**④ の S1 の画面の試験（4d44f021、`screens/ws07-s1-pure.screen.mjs` の 8/8）について**
- `WS07_CHROME=/opt/pw-browsers/chromium` で流した。これは full Chromium（`chromium-1243/chrome-linux64/chrome`）で、headless shell ではない。
- 中身は、S1 の村のカードと、① の板への入口の試験。march の操作は含まない。画面の部品の試験の結果として扱う。
- ページ内のガード（`screens/ws07/nokey-page.mjs`）が止めるのは、WebCrypto の generateKey・deriveKey・deriveBits・sign・unwrapKey と、pkcs8 などの importKey。
  - `keyFromSeed` は、公開鍵の計算（`publicKeyOf`、JS で seed から計算する）の後に、pkcs8 の importKey を呼ぶ。記録が 0 件なので、`keyFromSeed` は最後まで呼ばれていない。
  - ただし、`publicKeyOf` だけを呼ぶ経路（`importBackup`）は、このガードでは止まらない。この試験はバックアップを読み込まないので、通らない。
  - 「導出がなかった」の根拠は、記録とコードの読みによるもので、入れたガードが証明したものではない。
  - これからのブラウザの試験は、page が鍵の経路（`keyFromSeed`、`publicKeyOf`、dev wallet、① の `testSigner` など）に届かないことを、呼び出し元と import 先の静的な監査で示せたものだけを流す。ガードは最後の守りで、事前の監査の代わりにはしない。7c7fe932 と c260c438 では、ブラウザの試験は流していない。
- 最初の 1 回は、playwright-core のリンク先の誤り（`ERR_MODULE_NOT_FOUND`）で失敗した。これは ④ の手順の誤りで、ページの不具合ではない。
- 今、ほかに失敗している S1 の試験の記録は見つかっていない。⑦ の新しい結果を受け取ってから、この訂正に照らして原因を分ける。

### 16.3 後継の候補 4d44f021（④、2026-11-08）

- `claude/gallant-ride-cunptv` @ `4d44f021df1e9e6c37a072e81bcfc04f0c2e6d06`（tree `131c6cb451bd597ccc037546bd96d2373ce9ffa0`）。16576826 の上に、各担当の directory だけを重ねた 4 commit。どれも `[skip ci]`。
  - ⑮ `fb7bbdef` → `0541478f`、③ `838338be` → `7e820189`、⑥ `7232c86b` → `d35604d6`、① `ca44e603` → `4d44f021`
- 検証済みの基準は 16576826 のまま。4d44f021 は ⑯ が差分の範囲を確かめている途中。
- ④ が流したもの（すべて no-keys-guard の下）：⑮ 134/134、③ 25 通過・7 省略、⑥ 29 通過・1 省略（2 回）、① 239/239 と coop.browser.nokey 10/10、gateway の ws07-coop 4/4、S1 の画面 8/8（§16.2 のとおり、画面の部品の試験）。
- ⑥ の package 全体を guard の script で流すと、`test/roles.test.mjs`（`generateKey()` を呼ぶ）が鍵の一覧に無いため、exit 3 で止まる。このファイルは変わっておらず、実行していない。scan が ⑥ の directory を見ていないことによる、もとからの欠け。直していない。

### 16.4 後継 7c7fe932・c260c438 と、証拠の分け方（④、2026-11-08）

- `claude/gallant-ride-cunptv` @ `c260c4386ad8fe02417bb491941bff18c788e111`（tree `4c7302251ad553831d2c48ea6a01a8f9017eba24`）。4d44f021 の早送り。どれも `[skip ci]`、この枝の CI の数は 16 のまま。
  - ④ `9781d04e`：鍵の試験の scan の範囲の欠け（下）
  - ① `9dcb1e88` → `42b1f393`、⑫ `5370d0fe` → `720ab60b`、⑬ `a420f924` → `5133f3c7`（directory の重ね）
  - merge：⑱ `0bf02548`、⑳ `8c328cbc`、② `626a5cc8`、⑲ `5b7a0fda`、⑨ `b1157847`、⑩ `0075d356`
  - ④ `7c7fe932`：⑱ の試験の clippy（clone_on_copy）。動作は変えない
  - ④ `c260c438`：V23 の送りの道の関数を crate 内で共有（見える範囲だけ。意味は変えない）
- 検証済みの基準は 16576826 のまま。⑯ が差分の範囲を確かめている途中。

**鍵の試験の scan の欠けと直し（9781d04e）**
- 欠け：scan が gateway と receipt spike しか読まず、⑥ の `roles.test.mjs`（`generateKey()`）が一覧に無かった。CI が node-keyfree.sh で流す `workstreams/12-memory` も scan の外だった。
- 直し：git が追う `*.test.mjs` をすべて読む。`import './x'` も追う。scan が読んでいない file は node-keyfree.sh が流さない（`--covers`、exit 4）。もとの 93 行は同じ。
- 確かめ方：静的な fixture（file を文字として書くだけで、import も実行もしない）。3/3。直す前の scan では 0/3。

**証拠の三つの分け方**
- (a) 実行したもの：静的な監査（呼び出し元と import 先）で鍵に届かないと示した、名前を挙げた試験だけ。結果は ⑯ への連絡のとおり（① 161、⑫ 69＋省略 1、⑥ 29＋省略 1、Rust の各 target、clippy・fmt）。
- (b) ガードが止めた試み（繰り返さない）：scan の直しの途中で、⑥ の 11 file を一度ガードの下で流し、鍵に届く file を探した。どれも最初の鍵の呼び出し（private key の `importKey`、`generateKey`）でガードが拒否した。⑥ の `src/keys.mjs` を読むと、その前に seed から何かを導く処理は無い。鍵は作られず、導かれず、署名にも使われていない。利用者の指示により、今後はこうした探し方をしない。
- (c) 流していないもの：import の閉包が鍵の処理に届く file（⑬ の 29、① の 9 と browser の試験、⑥ の roles など）。これらは各担当の報告だけがある。

**⑩ と V23 の共有（c260c438）**
- program の custody の `send` は、SendCaravan と同じ `proc::caravan::route` を同じ引数で呼ぶ。そこで V23 の `route`・`check_caravan`・`check_slots`・`slots_of` を V26 から使えるようにした。
- 共有で賄えないもの（V26 では UNVERIFIABLE のまま）：SettleCustody の道の Province の解決（`RESOLVED_NEXT`）と raid の状態、手数料と rent。DepositLot の holding からの引き落とし。V23 の `judge_settle_caravan` も、これらは確かめていない。
- V26 の実装は ⑩ の担当。⑩ に案を送った。PASS への格上げはしていない。

### 16.5 後継 11bc9698 まで：⑥ の lock、⑦ の browser の guard、src/ を辿る scan（④、2026-11-08）

- `claude/gallant-ride-cunptv` @ `11bc9698`。どれも `[skip ci]`、この枝の CI の数は 16 のまま。基準は 16576826 のまま。
- 取り込み：⑥ `11be9d44`・`5f74a270`・`0918a973`、⑱ `a7bc0d01`、⑪ 0017、⑫ `13903d94`、⑦ `487e75e8`・`e28d6b38`。

**⑥ の journal の lock：二つを分けて書く**
- (1) ⑥ の手順（open・takeover・save・close）の中の競合：直した。⑯ の J1〜J5、⑥ の R1（空の mutex が「奪う人がいない」と読まれる）・R2（他の taker の置き換えた mutex を消す）。5f74a270 で、file は書き終えてから置き、他の処理の file は誰も消さない。
- (2) J7：生きている持ち主の `.lock` を、手順の外（一時 file の掃除・運用の後始末など）が消した場合、save の窓で古い書き込みが 1 回通る。⑥ の中では直さない、運用の限界として残す（利用者の判断、2026-11-08：新しい native の依存を足してまで閉じない）。
  - 運用の条件：生きている持ち主の `.lock`・`.takeover` を手順の外で消さない。journal を自動で掃除される directory に置かない。
  - 被害：journal が一度、古い状態に戻る。二重送信の立証ではない（実行 id と requestId は plan から決まり、④・③ は同じ id を一度しか受けない）。

**⑦ の browser の guard と、UI の検証の再開**
- ⑦ の helper は full Chromium（channel 'chromium'、`chromium-1243/chrome-linux64/chrome`）で開き、`web/session.mjs` を配るときに `keyFromSeed`・`publicKeyOf` を拒否に差し替える。差し替えられない（配る file が変わった・取得に失敗）と、module は読まれない。
- 入っていることの証明：`ws07-guard.screen.mjs` 1/1（④ が c260c438 の上の a23f02bb で流した）。secure context、WebCrypto あり。`keyFromSeed`・`publicKeyOf` は入口で拒否し、derivation の最初の段（digest）は 0 回。generateKey・deriveBits・sign・pkcs8 の importKey も拒否。記録は順に残り、reload の後も guard は入る。入力は 0 バイトで、何も導かず・作らず・署名しない。
- その上で流した UI：march の画面 2/2（desktop・phone）、S1 pure 8/8、S1 page 4/4、ws07-coop（Node）5/5。鍵の使用の記録 0。
- 静的な確認：`web/frontier/` は `lobby.mjs` も `preflight` も呼ばない。固定 seed の `preflight` は実行していない。
- 届いた範囲：march の注文を組む操作（host と tile、stance、取消、再読込、戻る・進む）。**届いていない範囲**：「封じて出発」は押さない。封じること・送ること・チェーンでの着地は確かめていない。

**src/ を辿る scan（11bc9698）**
- 三つに分けて書く：
  - 直接、または test の helper が鍵の API を名指しする file（119）：実行しない。
  - import を src/ まで辿ると、鍵の API を名指しする file に届くもの（205）：**保守的な除外**。呼ぶことは示していない（定義や言及にも当たる）。実行しない。
  - 静的な呼び出しの監査で、鍵の処理を呼ばないと示した named targets（`scripts/ci/node-key-reviewed.txt`、理由つき。今は ⑥ の 5）：実行する。
- 鍵なしの job で流れる数（数えただけ、実行していない）：gateway 194 → 87、receipt spike 2 → 2、⑫ の CI の一覧 8 → 8、⑥ 5 → 5。gateway の 107 は、監査して reviewed に入れるまで流れない。
- 確かめ方：静的な fixture 4/4。前の scan では 4 件中 3 件が落ちる。

**追記（⑯ の §27、2026-11-08）**
- ⑥：⑯ も、通常の手順の中に残る競合は無いと合意した。J6 は「手順の中では閉じた」（届くのは `alive` を偽って注入した場合だけ）、J7 は運用の限界、として記録する。
- ⑫ 13903d94：二度の crash を全部の組合せで試すと、123,219 回の再読込のうち 9,024 回が `corrupt line 4` で開けない（1 つ目の marker の中で crash し、2 つ目の marker の中か直後でもう一度 crash した場合）。黙って消えるデータは無いが、journal が開けない。⑫ に送られている。直るまで未解決として扱う。
- ⑦ の guard の試験（`ws07-guard.screen.mjs`）は fail-open だった（⑯ の G1）：guard が入っているかを確かめる前に、`keyFromSeed(zero)` や `generateKey` を呼ぶ。
  - ④ は ⑯ の監査の前に、この試験を一度流した（a23f02bb、full Chromium）。結果では、どの呼び出しも拒否された（`key use blocked`、digest は 0 回、順に記録）。つまり、そのときは guard が入っていて、何も導かず・作らず・署名していない。ただし、試験の順序はそれを保証しない。
  - ⑦ に、guard を外から確かめてから呼ぶ形（確かめられなければ何も呼ばない）に直すよう頼んだ。直るまで、④ はこの試験も、ほかの browser の試験も流さない。
  - G2：Web Worker の中は guard されていない。今は Worker に届かない。⑦ に、Worker も guard するか、Worker を作らないことを確かめるよう頼んだ。
- verify（c260c438）：⑯ が 128/128。
- ⑥ の 5 件（node-key-reviewed.txt）：⑥ が、keys.mjs の export 6 つを「呼ばれたら throw する罠」に替えて流し、罠に当たったのは 0 件（38 件中 37 通過・1 省略）。静的な理由に加える証拠として記録する。
  - **ガードが止めた試み（⑥、記録のみ）**：⑥ は対照として `roles.test.mjs`（鍵を作る試験）を罠の下で流し、罠に 4 回当たった。鍵は作られず・導かれず・読み込まれず・署名に使われていない。利用者の規則（鍵の処理を動かして探さない）により、④ から ⑥ に、今後は対照を静的な fixture にするよう伝えた。

## 17. この bounded pass の checkpoint（④、2026-11-08）

**位置**
- 検証済みの基準：`16576826084a8ea7bd6b12b845d50b97f3d14904`（tree `7f6ff8b0fd1a3765fe00f4507ee87fdcd1ccdd71`）。置き換えていない（今の HEAD の祖先）。
- この pass の最後：`claude/gallant-ride-cunptv` @ `95b0ab225ca9e9e626941b51981df2240198d91c`（tree `89a64830da399101530eef3e004b81d5007d2203`）。16576826 から first-parent で 34 commit、85 file。すべて `[skip ci]`、この枝の workflow run は 16 のまま（最後は 2026-11-06 の `8e96f24d`）。
- ⑯ の独立の確認：6de240aa まで済み（REPORT §25〜§27.11、`claude/dreamy-ramanujan-ijj8qj` @ `c615fb8f`）。**55d5c2da（⑦ の wide の画面の試験）と 95b0ab22（④ の guard の門）は ⑯ がまだ確かめていない。**

**16576826 からの差分の出所**（重ねたもの＝その担当の directory だけ。merge・cherry-pick＝その担当の commit）

| 担当 | 取り込んだ commit | 候補での commit |
|---|---|---|
| ① | `ca44e603`、`9dcb1e88`（協力の依頼の画面） | `4d44f021`、`42b1f393` |
| ② | `626a5cc8`（V0 の Grant） | merge `387721c2` |
| ③ | `838338be`（MCP の cargo と 409） | `7e820189` |
| ④ | 鍵の試験の scan と guard（`9781d04e`、`11bc9698`、`bb41fc0d`、`5045fe3d`、`95b0ab22`）、V23 の共有（`c260c438`）、⑱ の試験の clippy（`7c7fe932`） | 同じ |
| ⑥ | `7232c86b`、`11be9d44`、`5f74a270`、`0918a973`（journal の lock） | `d35604d6`、`eb700a8a`、`82ddc29f`、`695e1d83` |
| ⑦ | `487e75e8`・`e28d6b38`、`780acac7`、`84251e5a`、`55d5c2da` | merge `a23f02bb`、`d415e013`、`6de240aa`、早送り `55d5c2da` |
| ⑨ | `b1157847`（capacity の桁あふれ） | merge `6875228d` |
| ⑩ | `0075d356`、`3fd1db24`、`995bfe3c`（V26） | merge `d83a9707`、cherry-pick `02be5f41`、`0dd37253` |
| ⑪ | patch 0017（V27、sha256 `babba7ff…`） | `3e617b28` |
| ⑫ | `5370d0fe`、`13903d94`、`a7ac51b7`（journal の torn） | `720ab60b`、`4b3b399e`、`64960c1e` |
| ⑬ | `a420f924`（run view の欠けは unknown） | `5133f3c7` |
| ⑮ | `fb7bbdef`（0 の到着の端数） | `0541478f` |
| ⑱ | `0bf02548`、`a7bc0d01`（keeper の Reveal の秘匿、owner の track） | merge `7d25f1eb`、`d3b89ede` |
| ⑲ | `5b7a0fda`（findex のページの巻き戻し） | merge `83e10889` |
| ⑳ | `8c328cbc`（V28 の WideEconomy） | merge `8d8e8c18` |

**1〜20 の状態**（統合済み／保存のみ／非公開／製品判断待ち）
- ① 統合済み。
- ② 統合済み。製品判断待ち：版のビット（rights 0x2000 など）は仮の割当て。
- ③ 統合済み。
- ④ 統合済み（scan・guard・V23 の共有）。製品判断待ち：依頼者の認証と route（S1 は D5-a を勧める。未採用）。
- ⑤ この pass では新しい差分なし（`07fc6f64` は基準に入っている）。製品判断待ち：R・D1・D3・D5。
- ⑥ 統合済み。J7（手順の外で生きている lock が消される）は運用の限界（利用者の判断）。製品判断待ち：D1〜D5。intake は `NoAuthenticatedRequester` で閉じたまま。
- ⑦ 統合済み。製品判断待ち：reveal／⑮／31 章の方針。
- ⑧ この pass では新しい差分なし。結果は 7535a17e のものを、変わっていない file について持ち越す。製品判断待ち：31 章。
- ⑨ 統合済み。製品判断待ち：記録の kind、AccountKind 25・26、KERNEL_VERSIONS、R1 などの仮の割当て。
- ⑩ 統合済み。製品判断待ち：LOT_RETURNED、U1〜U3、SettleCustody の Province 条件を写すか。
- ⑪ 統合済み（0017）。
- ⑫ 統合済み。
- ⑬ 統合済み。
- ⑭ この pass では新しい差分なし。製品の選択だけが残る。
- ⑮ 統合済み。
- ⑯ 独立の検証。記録は ⑯ の枝にだけあり、候補には入れない。
- ⑰ **非公開**。賞金の series は非公開のまま。候補にも公開の枝にも入れていない。製品判断待ち：U48〜U52、中止の返金の出口など。
- ⑱ 統合済み。
- ⑲ 統合済み。
- ⑳ 統合済み。製品判断待ち：U49／U50。
- 保存のみ：chosen-march の demo（`64f7cd15`、`86b293e8`、`298fdc91`、`f9b0f60b`、`26769fa1`、`07ae3f0d`、`7702251c`）、`preserve/*` の枝。この docs の枝（review/ws04-docs-handoff-20261108）は候補に merge していない。NFT の賞金の候補 `3090242a` は受け取っていない。

**この pass で ④ が新しく流した試験**（呼び出し元と import 先の静的な監査で、本物の鍵に届かないと示した named targets だけ）
- Node（no-keys-guard の下）：⑮ 134、③ 25（7 省略）、⑥ の 5 file 37（1 省略）、① 8 file 161、⑫ の CI 一覧 76（1 省略）、gateway の ws07-coop 4（後に 5）、ws07-world 6。
- Rust：verify（V0・V23・V24・V26・V27・V28、custody 系 6/7/9/14/13、rights_replay 19、resident_ledger 4、ws04_scan_resident 4）、findex（lib 10、ws19_feed_pages 4）、keeper（4 module で 32）、permutation-rules と permutation-frontier の capacity（debug と release）、⑨ の kernel 43。clippy -D warnings と rustfmt。
- Browser（full Chromium、`ws07-guard` の fail-closed の証明を先に流してから）：ws07-guard 2、ws07-march 2、ws07-wide 3、ws07-s1-pure 8、ws07-s1-page 4。鍵の使用の記録 0。
- scan の静的な fixture：6/6（前の版では落ちることも確かめた）。

**持ち越し（新しく流していない）**
- 16576826 の結果：⑤ の strict 61/61（④ と ⑯）、gateway・web 1908、⑯ の 7535a17e の Rust の一式、⑧ の 7535a17e の結果。入力の変わっていない部分だけに当てはまる。
- gateway・web の全体は、この pass で流し直していない（web の hud・join・coopboard・css が変わった。関係する試験の多くは、今は保守的な除外）。

**別に記録する証拠**
- ガードが止めた試み（繰り返さない）：④ が scan の直しの途中で ⑥ の 11 file を一度流した（最初の鍵の呼び出しで拒否、鍵は作られていない）。⑥ が対照として roles.test.mjs を罠の下で流した（罠に 4 回、鍵は作られていない）。
- 手順の誤り：④ が resident_ledger・ws04_scan_resident を、ヒットの中身を確かめる前に流した（後で World::parse だけと確認）。⑥ の差分を試験の前に push した（直後に流した）。fail-open だった頃の ws07-guard を一度流した（どの呼び出しも拒否され、何も導かれていない）。

**実行していない経路**
- 署名、Seal（封じる）、送信、着地、実チェーン（frontier-localnet）、SBF、LiteSVM。**これらの成功は主張しない。**
- 鍵を使う試験：scan が一覧にする 119（直接・helper）、205（src/ を辿る、保守的）、23（追えない、保守的）。gateway の鍵なしの job は 72 file になる（107 は監査されるまで除外のまま。この pass では解除しない）。
- ⑦ の interaction の既定（鍵あり）の run、wide の herald の index、capture の鮮度。
- ⑨ の run.sh、② の new_bands・evidence（④ は流していない）、Rust の workspace 全体。

**鍵の試験の scan の限界**（実行元を監査したかどうかで分ける）
- このチェックアウトの JavaScript：scan と review の digest が静的に読む。監査済み。
- 外の木（`WS*_ROOT` がこのチェックアウトでない）：scan は読まない。**拒否**（95b0ab22、exit 6）。手で監査するまで流さない。
- Rust の binary（`RUNEXEC_BIN`）：scan は読まない。`RUNEXEC_BIN_SHA256` で bytes を名指したときだけ流す。「監査した source から build した」は実行する人の申告で、④ の build（`f039854a…`、16576826 から。`workstreams/04-execution/src` はその後変わっていない）について ④ が申告する。それ以外は**要手動監査**。
- package の import（node_modules）：scan は辿らない。実行のときの guard だけが守る。

**§17 への追記（⑯ の REPORT §28 と照合して、2026-11-08）**
- ⑯ の checkpoint は 55d5c2da まで（⑯ が確かめた）。④ の checkpoint は 95b0ab22（node-keyfree.sh の門。⑯ はまだ確かめていない）。55d5c2da と 95b0ab22 の差は `scripts/ci/node-keyfree.sh` だけ。
- **原因が分からないまま残る 1 件**：③ の integration の「③ and ⑤ on one agent…」が、⑯ の 4d44f021 の run で一度だけ落ちた（`r3.state` が undefined）。その後の 9 回と基準の 5 回では再現しない。後退とも flake とも断定しない。
- **⑯ の hook の下で結論が出ていない gateway の試験 37 件**（hook と module の link が合わない）。候補の欠陥ではないが、確かめてもいない。
- **④ の run が使った外の root と binary**（⑯ の問い）：⑥ connect-live・ports などの run では、`WS03_ROOT`・`WS04_ROOT` はどちらもこの候補の木（int-merge の作業木の root）。`RUNEXEC_BIN` は 16576826 から build した debug の runexec（sha256 `f039854aaaad26d141201f9e1066eacf4be11e69f0c2f1e6365ad0bd3d76819b`）。`workstreams/04-execution/src` は 16576826 から変わっていない。95b0ab22 からは、この binary を `RUNEXEC_BIN_SHA256` で名指さないと流れない。
- ⑯ の手順の誤り：`71713b34` の広い add -f（⑯ の §27.9 で監査済み、untrack 済み、履歴には残る）。

**§17 の訂正（⑯ の REPORT §28.1・§28.7、0dc6107b）**
- 上に「55d5c2da と 95b0ab22 は ⑯ がまだ確かめていない」と書いたのは、もう当たらない。⑯ は両方を確かめた（55d5c2da は §28.1、95b0ab22 は §28.7）。**16576826 からの後継で、commit の単位で ⑯ が確かめていないものは無い。**
- 95b0ab22 についての ⑯ の確認（静的な読みと、どの file にも当たらない glob での無害な run）：外の `WS04_ROOT` は 6、このチェックアウトへの symlink は 0、`WS03_GATEWAY_ROOT=/tmp` は 6、sha の無い・違う `RUNEXEC_BIN` は 6、正しい sha は 0、何も設定しなければ 0 で、node --test は始まらない。
- ⑯ が挙げた限界：`_SHA256` は bytes を確かめるだけ。「このチェックアウトの監査した build」は実行する人の申告で、確かめてから使うまでの間は原子的でない。⑯ は ④ の build（`f039854a…`）の bytes を見ていない。確かめたのは、ws04 が 16576826 から 95b0ab22 まで `a33e3b0a` のままで、その Rust の source に鍵の API の呼び出しが無いこと。
- ⑯ が自分で流していないもの：keeper と、②⑨⑱⑲⑳ の Rust の一式（④ の結果だけ）、ws07-guard（④ の 2/2 だけ）、保守的な除外。
- 未解決のまま残すもの：③ の再現しない 1 回の失敗、⑯ の hook の下で結論の出ない gateway の 37 件。合意した限界（fix とは別）：⑥ の J7、digest と実行元の範囲、Worker の realm。
- 結論：この bounded pass の checkpoint で、「すべての機能が完成した」ではない。

**§17 の更新（⑯ の REPORT §29、8574a9af）**
- 「⑯ の hook の下で結論の出ない gateway の試験 37 件」は、**候補の欠陥ではなく、⑯ の実行の条件によるもの**と分かった。
  - 37 は file の数ではなく結果の数：14 file の全体と、7 file の中の 23 の subtest。合わせて 21 file（一覧は ⑯ の logs/phase23/hook37-list.txt）。
  - 原因：⑯ の最初の hook（node:module registerHooks の sync load hook）が、Node 22.22 で uuid の require(esm) を壊した（web3.js → jayson → uuid）。hook を NODE_OPTIONS で渡したので、permission model の子の process にも入り、読めずに落ちた（ERR_ACCESS_DENIED 4 件）。
  - 同じ blob の gateway は、hook なしで 1908/1908（7535a17e と 20db3313）。
  - 鍵なしで流せる 4 file（agent-wallet-bench、agent-wallet-s1、frontier-resident、frontier-s1-relay）は、静的な監査の後、repo の guard と hook v2（--import だけ）で 22/22。鍵の入口の呼び出しは 0。
  - 残る 17 file は scan の保守的な除外（src/ 経由 14、追えない 3）で、流していない。
  - 一つだけ観察できていないもの：relay-resume の正しい faucet の記録が、hook v1 の下で「無効」とされた仕組み。⑯ の pure な probe では、hook なし・v1・v2 のどれでも、正しい記録を受け入れ、13 の変異を拒む。
  - ④ の node-keyfree.sh は guard を --import で渡すので、この問題は無い。
- ③ の 4d44f021 の失敗の実行条件（⑯ から ③ に送られた）：17:44:00Z、前景、3.1 秒、NODE_OPTIONS なし。roots は ⑯ の 4d44f021 の作業木、RUNEXEC_BIN は ws04 a33e3b0a の debug build（sha256 4cb6634d…）、run-guarded.sh はそのまま。4 vCPU、ほかの job は無し、run の外で共有した tmpdir や SQLite は無し。並列は node --test の file ごとの並列だけ。
- これを受けても、③ の失敗は INCONCLUSIVE のまま（cold open の競合は、起こりうる仕組みとして示されたが、その run の原因とは示されていない）。

**§17 の後の後継**（16576826 は基準のまま、95b0ab22 は区切りのまま）
- `89232fad`（tree `0301f85e`）：④ の runexec `Store::open` の WAL の切替えの修正。古い store.rs で落ち、新しいもので通る `tests/store_cold_open.rs`。
- `490407d8`：⑦ `9b547d9d` の merge（記録が読めない viewer を「未参加」として見せない）。
- `8afe8426`（tree `94c56522`）：③ `d4b22c97` の重ね（試験の頑丈さ、registry busy の場合）。
- どれも ⑯ の独立の review の途中。

**後継（§17 の後、続き）と、利用者の判断を待つもの**
- `dc9974e2`（⑦ 08928ea5）、`f2e63ff2`（④ passnode の型 alias、clippy）、`b9a4c0a2`（③ a24d6dbb）、`1398f44c`（key 一覧と ③ c029948a。commit の文は key 一覧だけを書いているが、③ の doc 24 §6 も含む）、`b381c2bb`（⑦ c4eae408）、`883b4be6`・`8c53176a`（⑦ a8c9eccb と key 一覧）、`6af321d2`（④ cancels_race_executors を開始の門で決定的に）、`7e6ef2b6`（⑦ 9cd15799）。HEAD は `7e6ef2b6`（tree `580c2614`）。
- **回帰を fail で捕まえるのは `store_cold_open` だけ**。③ の cold-open.test.mjs は旧と修正後の両方を受け入れ、退行しても診断の branch が変わるだけで red にならない。同じ強さの regression gate ではない（利用者の訂正）。
- **利用者の判断を待つもの：join と paidJoin の meStatus の確認**（⑯ §29.8 b）。controller の join と paidJoin は、今の記録の読みが成功したかを確かめずに送る。16576826 から変わっていない（この回の後退ではない）。⑯ の最小の案は、confirmHome と同じ確認を前に置くこと。送れる時を変えるので、⑦ も ④ も変えていない。
  - ⑯ の静的な事実（§29.10、公開の source と、署名しない pure な probe だけ）：atomic の paidJoin は、Pay と Join を一つの取引に入れ、relay はその形だけを受け、送る前に署名済みの bytes を simulate する。Join は既存の Citizen に Err(AlreadyDone)、Pay は既存の Entry に Err(AlreadyPaid)。取引の原子性により、atomic の形では Join が失敗すれば Pay の送金と Entry も戻る。source の上では、手数料だけが取られることは無い。ネットワークの手数料は relay の fee payer が払い、着地して失敗したときだけかかる。残高が足りないときの faucet は別の取引で、Join が失敗しても戻らない（localnet だけ）。
  - 確かめていないもの：SVM での実行（keypair を使う試験）。wallet が relay の外で Pay だけを自分で送る場合。

## 18. 引継ぎ：95b0ab22 の後の継続（④、2026-11-08）

**位置**
- 今の候補：`claude/gallant-ride-cunptv` @ `caeb1b7463e5a7e5b473a71c9c4f08a34bc17fea`（tree `5916b6461432226867036a33948a73fcbae7334d`）。**全機能の完成ではない。**
- 過去の区切り：`95b0ab225ca9e9e626941b51981df2240198d91c`（tree `89a64830`）。過去の検証済みの基準：`16576826`（tree `7f6ff8b0`）。どちらもそのまま残す。
- 95b0ab22 から first-parent で 13 commit、25 file。すべて `[skip ci]`、この枝の workflow run は 16 のまま。
- ⑯ の独立の確認：`7e6ef2b6` まで（REPORT §29.1〜§29.11、`claude/dreamy-ramanujan-ijj8qj` @ `a0e10420`）。**`caeb1b74` は ⑯ の review 待ち。**

**95b0ab22 からの差分**
| commit | 出所 | 中身 |
|---|---|---|
| `89232fad` | ④ | runexec `Store::open`：WAL への切替えが、他の process の lock を busy の予算（10 秒）の中で待つ。`tests/store_cold_open.rs`（古いもので落ち、新しいもので通る） |
| `490407d8` | ⑦ `9b547d9d` | 記録が読めない viewer を「未参加」（国の選択）として見せない |
| `8afe8426` | ③ `d4b22c97` | ③ の試験：store を一度開いてから使う、registry busy の場合 |
| `dc9974e2` | ⑦ `08928ea5` | 村の Province が読めない間、案内が Muster・Train を勧めない |
| `f2e63ff2` | ④ | 試験の helper の型 alias（clippy type_complexity）。動作は同じ |
| `b9a4c0a2` | ③ `a24d6dbb` | 一つの agent の失敗の決定的な再現（cold-open.test.mjs） |
| `b381c2bb` | ⑦ `c4eae408` | 軍勢の画面が、読めない間に「軍勢はいません」と言わない |
| `1398f44c` | ④・③ `c029948a` | key 一覧 1 行と ③ の doc 24 §6（commit の文は key 一覧だけを書いている） |
| `883b4be6`・`8c53176a` | ⑦ `a8c9eccb`・④ | 「未参加」と答えた後の読み失敗で、国の選択を閉じない（FS.meAnswered）。key 一覧 1 行 |
| `6af321d2` | ④ | cancels_race_executors：executor と時計を、最初の cancel まで門で待たせる |
| `7e6ef2b6` | ⑦ `9cd15799` | 案内の行軍の段が、読めない間に「兵を準備する」と言わない |
| `caeb1b74` | ④ | ⑯ の指摘への修正：canceller が死んでも試験が止まらない（drop guard）。門の前の cancel を競合の数から外す |

**実行したもの**（呼び出し元と import 先の静的な監査の後、鍵に届かないと示した named targets だけ）
- runexec：lib、store_cold_open（古い store.rs で 2 件とも落ち、新しいもので通る）、concurrency、run_cli、act_cli、acts、intake_chain。clippy -D warnings（1.89、CI の toolchain）と rustfmt。
- cold open の競合：`runexec status` の 2 process × 80 で、古い binary 8/160、修正後 0/160。③ の `act register` の再現でも、修正後 0/160（n=2）・0/320（n=8）。⑯ の独立の build で 42/400 → 0/400。
- ③ の run-guarded.sh：16576826 の store.rs の runexec と、修正後の runexec の両方で 35/35（2 回ずつ）。
- ⑦ の画面（full Chromium、`ws07-guard` の fail-closed の証明を先に）：ws07-guard 2/2、ws07-read は修正ごとに新で通り、旧で、その修正の群だけが落ちる。Node の guard の阻止 0。
- ⑥ の 5 件（修正後の runexec を sha で名指し）：37 通過・1 省略。
- cancels_race_executors：一時的な編集（commit していない）で、2 秒遅れの canceller は旧で落ち新で通る。門の前で死ぬ canceller は 2 秒で fail（hang しない）。

**実行していないもの**
- ⑦ の unit 試験（web-frontier-ws07-unread、ws07-me-answered、wave3-hud、first-village-ui など）：scan の保守的な除外。⑦ の結果だけがある。
- runexec の gateway.rs（node の gateway が署名する）と signed.rs。
- 鍵を使う試験、署名、Seal、送信、着地、実チェーン、SVM。**これらの成功は主張しない。**
- gateway・web の全体、Rust の workspace 全体。

**未解決・利用者の判断待ち**
- **join と paidJoin の meStatus の確認**（⑯ §29.8 b）：今の記録の読みが成功したかを確かめずに送る。16576826 から変わっていない。送れる時を変えるので、新しい Join の gating・鮮度の規則は決めていない。
- **paidJoin の手数料**（⑯ §29.10、公開の source と署名しない pure な probe）：atomic の形では Pay と Join が一つの取引で、relay はその形だけを受け、送る前に simulate する。Join が失敗すれば、取引の原子性で Pay の送金と Entry も戻る。**source の上では、入場の手数料だけが取られることは無い。** ネットワークの手数料は relay の fee payer が払い、着地して失敗したときだけかかる（wallet の quota に数える）。残高不足の faucet は別の取引で戻らない（localnet だけ）。**確かめていない**：SVM での実行、wallet が relay の外で Pay だけを送る場合（別の利用者の操作）。
- cancels_race_executors：門で「canceller が遅れて始まる」原因は取り除いた。後の cancel が実行中に届くかは、今も時間に依存し、それを戻した assertion が確かめる（完全に決定的とは言わない）。`caeb1b74` は ⑯ の review 待ち。

**③ の過去の一回の失敗と、cold open の仕組み（分けて書く）**
- 仕組み：新しい run store を二つの process が同時に開くと、`PRAGMA journal_mode=WAL` が busy の待ちなしで「database is locked」を返す。③ が決定的に再現し（試験 17 の line 85 と同じ値 `[undefined, true, 'real']`）、`89232fad` で直した。旧で落ち新で通る証拠がある。
- 過去の出来事：4d44f021 の一回の失敗が、この順序を通ったことは**証明されていない**（その run は r3 を表示していない）。観察されたすべての値と合うが、閉じたとは書かない。
- 回帰を fail で捕まえるのは `store_cold_open` だけ。③ の cold-open.test.mjs は旧と修正後の両方を受け入れる診断で、同じ強さの gate ではない。

**37 件の gateway の分類の訂正**
- 37 は file の数ではなく結果の数（14 file の全体と、7 file の中の 23 の subtest。合わせて 21 file）。
- **候補の欠陥ではなく、⑯ の実行の条件**：⑯ の最初の hook が Node 22.22 で uuid の require(esm) を壊し、NODE_OPTIONS で渡したので permission model の子の process でも落ちた。同じ blob は hook なしで 1908/1908。
- 鍵なしで流せる 4 file は 22/22。残る 17 file は保守的な除外で流していない。relay-resume の一件の仕組みだけは観察できていない。
