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
