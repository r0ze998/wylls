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
