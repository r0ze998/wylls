# ④ 受領物との照合（第3回：① ws01-coop-s1、⑤ ai05-ws03-ws04-check-delivery、2026-10-30）

**この文書は照合の記録である。** 共有パッチの採否は、この送付では確定しない（受け取った指示のとおり）。統合ブランチ `ws04/integration-20261030` に当てた共有コードは、前回と同じ③0005・⑤0001 だけである。今回の受領物は、使い捨ての作業コピーでだけ当てて試した。

すべて MOCK かローカルの実証であり、実チェーン・実 API・実資金では確かめていない。

## 1. 受領物と復元

| | ① | ⑤ |
|---|---|---|
| ファイル | `ws01-coop-s1-20261030.tar.gz` | `ai05-ws03-ws04-check-delivery.tar.gz` |
| 外側の SHA256 | `07fc6d152706927a6e8afadf94fbdb666487b990cd15f4d876982e84022f1aa6`（一致） | `e2f91ac823f7d202d33f325637b5f3c798a8baf8a7a512b95ac15852bfaaa3a0`（一致） |
| 内部の `SHA256SUMS` | 全件 OK。一覧に無いファイル・一覧にあって無いファイルは無い | 全 15 件 OK。同上 |
| パス | 絶対パス・`..` 無し | 同左 |
| bundle | `ws01.bundle`：前提 `9214293`・`9aa4ea12`（どちらも手元にある）。ref 3 本 | `…budget.bundle`：前提 `ba3c180b`。`…since-9f1209c4.bundle`：前提 `9f1209c4`（全体の bundle を取り込んだ後に検証 OK） |
| 復元した HEAD | `3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52`（`ws/01-coop-s1`） | `45cba41e57341c61a3b2999ce33cec1fd425065b`（2 つの bundle で同じ） |
| 復元した tree | `8d94de0505eed410b491084e07b7b5d61bf1d945`（一致） | `c6e07b04aaa821b054a54507bbf6e8eccebd62f1`（一致） |
| patch から | `4cd901de` に `all-ws01` 10 本 → 同じ tree。`ccc2f8e7` に `this-round` 1 本 → 同じ tree | `ba3c180b` に `five-patches` 5 本 → 同じ tree |
| 基準との関係 | merge-base は `4cd901de`。変更は `workstreams/01-national-strategy/` だけ | `ba3c180b..45cba41e` は 5 commit（`6cdd648c`・`9f1209c4` を含む）。変更は `workstreams/05-ai-participation/` だけ |
| 展開物 | `workstreams/01-national-strategy/` は bundle の tree と同一 | — |
| 試験 | `node --test` 191/191 | model-api 45/45、participation 37/37（`permutation-gateway/node_modules` は④の統合 worktree の既存のものを link。新しい install はしていない） |

不足：無し。① `ccc2f8e` は今回の bundle に含まれる（`ws/01-coop-connect`）。⑧ の新しい地図は今回も受け取っていない。

## 2. ①の到着量と④の契約

### 2.1 実物で確かめた規則

村（holding）への決着では、加算は milli 単位の全量で、上限が無い（`permutation-rules/src/frontier/holding.rs:296`、`:774-783`）。記録 CARAVAN_SETTLED の `cargo` は、その milli の量を整数に**切り捨てた**値である（`permutation-frontier/src/proc/caravan.rs:401-407` `cargo_log`。送付時の損耗 `worn_cargo` で端数が出うる）。

したがって、記録の `cargo` は**入った量の下限**であり、資源ごとに 1 未満多く入っていうる。①の `qtyKind: 'lower-bound'` が正しい。

### 2.2 ④の誤りと修正

④は `RuleDerived` を「入荷量 = cargo」と書いていた（`docs/SURVEY` §2、`STATE-MACHINE`、`HANDOFF` §2、`RUNBOOK`、`src/model.rs`）。これを「整数の下限」に直した（この commit）。

- 動作は変えていない。Fulfilled／Partial の判定は下限で正しい。下限が依頼量以上なら実際も以上で、下限が少なくても Partial として扱うのは安全側である。
- 表示（⑦）は、RuleDerived の量を「n 個以上」とする。

### 2.3 未解決（④の動作に関わる。判断待ち、未修正）

| # | 内容 | 影響 | 案 |
|---|---|---|---|
| R-1 | ④は、記録の `cargo` が全部 0 の決着を「焼かれた」（KnownZero、Failed LostInTransit）としている（`src/executor.rs` `on_arrived`）。しかし 1 未満の積荷も 0 と記録される。襲撃の記録（burn）が無いのに 0 と断定しうる | 端数だけの隊商で「0 と分かっている」と表示しうる。量は 1 未満なので、進捗への算入は変わらない | burn の記録（CARAVAN_RAIDED、choice=BURN）があるときだけ KnownZero にし、無ければ RuleDerived の下限 0（Partial）にする。テストの期待値が変わるので、採否を決めてから直す |
| R-2 | 提案 P1（`credited` を記録に足す）も、整数で記録するなら同じ切り捨てになる | Recorded も下限になりうる | P1 の案に「milli のまま記録するか、整数なら下限と明記する」を足す（P1 は未適用の提案のまま） |

### 2.4 ①の契約（18-2）と④の Run の対応

| ①の欄・状態 | ④ |
|---|---|
| `caravanId: {ownerTag, seq}` | `CaravanKey {owner, seq}`、Receipt の `subject` `cv:<owner_hex>:<seq>` |
| `delivered`＋`verifiedQty`（村、chain-log） | `Fulfilled`／`Partial`、`outcome.delivered`、`verification: RuleDerived`（下限。2.2） |
| `delivered`＋`verifiedQty: null`（倉） | `DeliveredUnverified`、`delivered: None`、`verification: Unverifiable`。④も残高の前後差で推し量らない |
| `lost` | `Failed`（outcome LOST）、`KnownZero` |
| `misdelivered`（依頼の届け先と別） | **（§5 で訂正）** 当初の④は、別の宛先での決着を証拠なしに「奪われた」（Raided、KnownZero）としていた。これは名前だけの違いではなく、根拠のない帰属だった。今は、この隊商の TAKE の記録があるときだけ Raided、無ければ保留 `DestinationMismatch`（原因未確認） |
| `raided-taken`／`raided-burned` | `Failed`（Raided／LostInTransit）、`KnownZero` |
| `moving` | `InTransit`（進捗ではない） |
| `unknown` | 状態は進めない（`Indeterminate`、保留） |
| `source: 'chain-log'`＋`signature` | Receipt の `source`（`sig:`／`event:`／`history:`）。④は settle の取引の署名を Receipt に載せていない（event／history の id だけ） |
| `duplicateOf` | ④では一つの隊商は一つの Run に固定（`(owner, seq)` は spec に結び付く）。依頼との多対一は④の外（①の判断） |

### 2.5 ①18-4 の問いへの答え（④の今の実装から）

1. 検証済み量は「加算量の下限」（村）。積荷そのものではなく、加算量を切り捨てた記録から得る。倉あては未検証。
2. 倉あての加算量は、P1（記録に加算量を足す）でだけ得る案。ヘラルドが前後の倉の口座を比べる案は採らない（他の入出庫が混ざる）。
3. ④は新しい公開物を作らない。Receipt はローカルの store の中だけ。

### 2.6 ①の共有パッチ（未適用）

| パッチ | 統合ブランチ `967ffc01` | ⑤の 0002b＋0003 を当てた上 | 試験 |
|---|---|---|---|
| 0002 herald `ended` | `apply --check` OK | OK | 当てた作業コピーで `cargo test --locked -p herald --lib` 39/39 |
| 0003 s1 の入口（⑦向け） | OK | OK | 未実行（⑦の判断） |
| 0004 `fcodec` `[i16;N]` | OK | OK | 未実行 |

`shared-patches-for-04/` は `proposals/` の写しとバイト単位で同じ。⑤の共有パッチとファイルが重ならない。

## 3. ⑤の CONTRACT-DIFF-4 と共有パッチ

### 3.1 共有パッチ

| パッチ | SHA256 | 統合ブランチ（③0005＋⑤0001 適用済み） |
|---|---|---|
| 0001 staking limits | `83f3f77c…d175` | **前回適用したものとバイト単位で同じ**（`eb5ad70d`） |
| 0002 byte collision | `64b2142e…59b2` | **当たらない**（`gateway.mjs` の `#build` で③0005 と衝突。⑤の報告どおり） |
| 0002b（0005 の上に作り直し） | `0ea2db14…073b` | 当たる |
| 0003 MCP `source` | `a2c8f45d…a6f6` | 当たる |

0002b＋0003 を当てた使い捨ての作業コピーでの結果：

| 試験 | 結果 |
|---|---|
| `permutation-gateway` の `npm test` | 2,543 件、通過 2,542、失敗 0、スキップ 1（⑤の報告と同じ） |
| `agent-wallet-*`・`frontier-relay*` | 111/111 |
| ④ `cargo test` | 62/62 |
| ④ `cargo test --test gateway -- --ignored`（MOCK の gateway） | 9/9 |

0002b が④に与える影響：relay が `Duplicate`（送る前、同じバイト列）を返したとき、別の fee payer で作り直して署名する。④の SendCaravan では、同じ `(owner, seq)` に二つ目の署名ができうるが、program が seq を一度しか受け付けないので、効果は一度までのまま。④は署名を gateway の記録（`chain_sig`）から得るので、作り直した署名もそこから読む。

### 3.2 CONTRACT-DIFF-4 §3 の不一致（④の判断待ち、未実装）

| # | ⑤の指摘 | ④の今 | ④の案 |
|---|---|---|---|
| D-1 | ⑤の Train などの代理人の行動は④の Run の外 | ④の Run は物流（施設→隊商）だけ | Run に入れない。⑤の RunReceipt は別の kind（例 `agent_action`）として並べる案。採否は未定 |
| D-2 | 費用の単位が違う（④ lamports、⑤ 試験用 USDC） | ④の `fees` は lamports だけ | 足し合わせない。⑤の `fourClasses()` の名前の対応（settled＝charged、undecided＝unconfirmed）は④と一致 |
| D-3 | `cancel.until`（`valid_until`）を中継が返さない | ④の gateway port は `valid_until = u64::MAX`（前回の G-1） | 前回の G-1 のまま。中継が `lastValidBlockHeight` を返すまで、署名済みの取消は「確認待ち」のまま |
| D-4 | ④の実行器が別の場所で session key を持つと、③⑤と Citizen の 1 枠を取り合う。`sole_owner_send` は③の送付を見ない | ④の統合経路は gateway の `submit` の後ろ（session key は中継の keyring）。ただし同じ owner の③⑤の送付は④の store に見えない | seq の検査（program の `SeqMismatch`）で効果は一度まで。④は gateway の `/history`（`historySeq`）を見て、他の送り手の送付を検出する案 |
| D-5 | 代理 1 つに capability は 1 つ（③と⑤が同じ Citizen で同時に書けない） | ④も同じ代理を使えば同じ制約を受ける | 共有コアの判断（⑤の提案：送り手ごとの capability） |

## 4. ⑮から届いた予告（参考、未受領）

⑮は④の Receipt の body の欄名を仮定している（`owner_tag`、`verification`、`raider_tag` など）。④の実物とは違う（`verification` は Receipt でなく Run の `outcome` にある。欄名は `raider`）。⑮の成果物は未受領で、照合していない。

## 5. 追記（同日、`30e7de98` の後）：指示を受けて直した点

この節は `30e7de98` の照合の続きである。照合の対象は今も ① `3f3c8478`、⑤ `45cba41e`、③ `acdcd0bf` だけである。**その後に報告された ① `f5a953b`、⑤ `29365e60`、③ `a361a30f` は受け取っていない。** この文書の結果を、それらの版にも成り立つものとして扱わない。受け取ったら、照合済みの版からの差分だけを照合する。

### 5.1 数量契約の正本

[QUANTITY-CONTRACT](QUANTITY-CONTRACT.ja.md) を④の正本にした。①③⑦⑫⑮に揃えてほしい点は同文書 §7（提案。他の担当の作業は変えていない。⑫は資料を受け取っていない）。

### 5.2 R-1（正確性の修正。新しいゲームルールではない）

- 記録の cargo が 0 なだけでは KnownZero にしない。この隊商の BURN の記録（feed または entity 履歴）があるときだけ 0 と断定する。
- 材料の入荷（inbound）にも同じ規則を当てた。証拠のない「材料が失われた」（`InputLost`）を出さず、正本の在庫を期限まで待つ。
- 模擬正本を program の単位に合わせた。損耗は milli で計算し、記録は切り捨て、holding には milli の端数まで加算する。保存の監査も milli で行う。
- 回帰試験は 5 件、変異 4 件をすべて検出（QUANTITY-CONTRACT §3）。既存の 62 件と変異 15 件は変わらず通る。

### 5.3 宛先の不一致

この隊商の TAKE の記録が無い不一致は、「奪われた」としない。記録を待ち、見つからなければ保留 `DestinationMismatch`（原因未確認）にする。量は述べず、相手の名前を出さず、責任や評判に使わない。後で記録が見つかれば、`resume` で判定する（`destination_mismatch_without_raid_record_is_unconfirmed`）。

### 5.4 Fulfilled／Partial の精度

判定はこの run の依頼量（資源ごと、整数）と、整数の下限 b との比較である。実際の量は［b, b＋1）にあるので、この run について Fulfilled も Partial も正しい。ただし、複数の run を足した目標には、Partial は何も言わない。合計の目標は「達成・未達・判定できない」の三つに分けて判定する（QUANTITY-CONTRACT §4）。④の旧い記述「未達の証明ではない」は、run 単位では言い過ぎだったので直した。

### 5.5 R-2（P1 は適用しない）

案 A（milli、正確。`credited_milli + lost_milli = cargo_milli`）と案 B（整数の切り捨て、下限。`lost` は載せない）に分けた。単位・精度・丸め・範囲は表にし、二つを混ぜないと明記した（[patches/README](../patches/README.ja.md) P1）。

### 5.6 ⑤ 0002b と署名（隔離したコピーでだけ検証。採否は未定）

**「Duplicate」が未送信を保証する範囲**（`permutation-gateway/src/frontier/routes/relay.mjs` `sponsor`、`src/guards.mjs` `ReplayCache`。コードを読んで確かめた）：

| 保証する | 保証しない |
|---|---|
| `Duplicate` を受けた呼び出しは、何も送っていない。検査は `sponsor` の最初で、await・fee payer の署名・simulate・`beforeSend`・送信のどれよりも前にある | 同じバイト列（同じ署名）が送られていないこと。鍵を先に持つ別の要求が送った、または送っている |
| 同じバイト列は同じ署名になる。チェーンは一度しか処理しない（効果と手数料は一度） | `Duplicate` が出ないこと＝未送信、ではない。cache は relay のプロセスのメモリだけにある（TTL 30 分、上限 200,000 件で古いものから消える）。再起動・別の relay・期限切れの後は検出しない |

**0002b で署名し直すと**：一回目に作ったバイト列は、別の要求のものと同じで、この要求からは送られていない。二回目は別の fee payer で作るので、**別の署名**になる。中身が同じ SendCaravan（同じ owner・seq）なら、二つの取引がチェーンに届く（`bridge/probe-0002b-sendcaravan.test.mjs`。0002b なしでは 1 件と `Duplicate`、0002b ありでは 2 件。模擬チェーン）。

- seq は一度しか受け付けられないので、ゲームの効果は一度まで。守られるのはここまでである。
- 手数料は二重に発生しうる。二つ目は失敗として着地しても手数料がかかる。relay は送る前に simulate するので、一つ目が着地した後なら二つ目は送られない。二重になるのは、両方が着地する前の短い間だけである（コードを読んだ結果。実チェーンでは未確認）。
- 手数料は relay の fee payer が払う。④の `fees` には gateway 経由の手数料が入らない（gateway の port の `fee = 0`）。relay の帳簿と、各署名の着地・失敗を突き合わせる必要がある。
- ④が追う署名は、attempt ごとに gateway が返した署名（`chain_sig`）である。二回目の署名は返される。一回目のバイト列の署名は、別の要求のものとして gateway の記録に残る。④は、seq の `CaravanSent` が自分の署名でなければ「別の送り手が使った」とし、自分の attempt の手数料は未確定（`superseded`）のまま残す（M12 の試験）。
- gateway の結果が `Sent` で、模擬チェーンの状態が着地以外なら、④は `Unavailable` として待つ。旧い署名の着地や失敗を「来ない」と決めない。
- 書き直しが尽きると、gateway は `refused`（`Duplicate`）を返す。署名は無く、手数料も取られない。④はこれを gateway の拒否として保留にする（送信前に止まる）。

**提案**（⑤・共有コアへ、未送付）：SendCaravan のように同じ中身の二つ目が必ず失敗する命令は、作り直しから外す。そうすれば、二つ目は `Duplicate` で止まり、手数料が二重にならない。gateway の結果には、作り直した回数と、使わなかった最初のバイト列の署名を載せる。
