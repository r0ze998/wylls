# ⑫ ④・⑧・⑬への接続（2026-11-05）

最新の版 `73a3e984` から、④の Receipt、⑧の世界、⑬の住民の記憶への接続口（アダプタ）を作り、契約試験を足した。⑬の行動ロジックは変えていない。データはすべて合成（④の模擬世界の出力、⑬の模擬世界、fixture）で、実ユーザーの私的データにはつないでいない。

照合した実コード：統合候補 `origin/integration/ws09-13-v16-d0949fd4`（`d0949fd417180b11704de5690ab0dfb6e5ef3148`）。④は `workstreams/04-execution/src/{store,executor,ports,model}.rs`、⑧は `frontier-abi`（`CONTINUOUS`、`NO_END_BELL`、エラー 94）、⑬は `workstreams/13-citizens/resident/{resident.mjs,ports/memory.mjs,ports/execution.mjs,ports/ws12-public-evidence.mjs}`。統合候補に入っている⑫は、`73a3e984` と同じ内容に統合担当の記録 1 件を足したもの。

## 1. 接続口の入出力

| アダプタ | 入力 | 出力（⑫へ） | 出さないもの |
|---|---|---|---|
| `adapters/ws08-world.mjs` `worldConfig` | ⑧の世界口座：cluster、program、world account（Season PDA を固定して使う）、season id、`continuous` | world `{cluster, world_id: <program>/<account>}`、partition 1 つ、理由 | `continuous` でない口座には world を与えない（「未発送」を証明できない） |
| `adapters/ws08-world.mjs` `clockFromGenesis` | `genesis_ts` と、slot の block time（RPC の getBlockTime） | slot → world bell（＝続いていく Season bell） | 時刻が分からないときは null。呼び出し側は推測せず、その記録を保留する |
| `adapters/ws04-receipts.mjs` `ingestReceipts` | ④の Receipt `{run_id, kind, subject, source, slot, body}`、run の spec、finalized の slot、時計、tag→wallet の resolver | `caravan_sent`（宛先は spec の `ship.dst`）、`caravan_settled`、`caravan_credited`（settle に `credited` があるとき＝P1）、`caravan_raided`、`identity_alias` | coverage、所有者の区間、照会失敗は作らない（記録が無いことは証拠にしない）。`facility_used` は記憶の入力ではない |
| `adapters/ws13-resident.mjs` `mirrorMemoryPort` | ⑬の MemoryPort（`append/recall/all`）と住民の wallet | ⑬が新しく保持した episode ごとに、住民本人だけが見る note を 1 件（解釈であって証拠ではない） | ⑬への返り値は変えない。⑬の判断・ActionResult（`sent`・`unknown`・`pending`）・掲示板の文は入力にしない |
| ⑫ → ⑬ | 統合担当の `ws12-public-evidence.mjs`（公開記録だけ、本人の resolver が必須） | 出典付きの公開の行 | ⑬の MemoryPort には何も書き戻さない。私的な note は、住民本人以外には読めない |

## 2. 照合で見つかった食い違いと対処

1. **相手の名前**：⑬は相手を wallet アドレス（base58、最大 44 文字）で覚える。Season ごとに変わる citizen tag を避けるためである。⑫の識別子は最大 32 文字だったので、**64 文字まで受け付けるよう広げた**。既存の記録はすべて有効のまま。
2. **u64 の精度**：④は `owner` と `raider` を JSON の数値（u64）で書く。citizen tag は口座アドレスの 8 バイトで、2⁵³ を超えるのが普通なので、通常の `JSON.parse` では別の値に丸まる。`parseJsonU64` で正確に読み、caravan の持ち主は subject の 16 進から取る。丸まった数値は拒否し、別人の tag にしない。
3. **発送の宛先**：④の `caravan_sent` の Receipt には宛先が無い。④は run の spec（`ship.dst`）と照合してから Receipt を出すので、宛先は spec から取る。spec が無ければ保留にする（`dst_unknown`）。
4. **重複の単位**：同じ出来事が、feed（`event:`）と entity 履歴（`history:`）の両方から、別の `source` で届く。④の数量契約 §7 と同じく、`kind|subject` で一つの事実にした。`content_from` や `source` のように読んだ経路で変わる値は、事実の中身に入れない。
5. **⑫自身の不具合（修正）**：本人の対応づけ（`identity_alias`）が、受け取った Receipt の時刻を持っていた。そのため同じ対応が Receipt ごとに別の内容になり、誤って「衝突」になっていた。④の実際の Receipt 3 件（3 つの run が同じ隊商を報告）で見つかった。継続世界では対応は世界の開始から変わらないので、bell 0 にした。
6. **確定性**：Receipt 自体は finalized かどうかを持たない。呼び出し側が示す finalized の slot 以下のものだけを事実にし、それ以外は保留して、後で改めて取り込む。
7. **⑬の結果は模擬の掲示板のもの**：`lapsed`・`not-returned`・`returned-late`・`raided` を、⑫の確定した不履行や評判にしない（統合担当の sidecar の方針と同じ）。遅れた返済や襲われた返送の評価は未決なので、本人の note として残すだけにした。

## 3. 試験（`test/adapters.test.mjs` 15 件、`test/adapters-ws13-real.test.mjs` 3 件）

| 観点 | 確認したこと |
|---|---|
| ④の実物 | `fixtures/ws04-receipts/` は、④の `runexec demo`（happy・crash・raid・lost-response）を統合候補 `d0949fd4` で build・実行して出力した Receipt と run spec（SQLite から原文のまま）。`tools/check-integration.sh --regen-ws04` で作り直しても同一 |
| 重複 | 3 つの run が同じ隊商を報告しても、`caravan_sent`・`caravan_settled` は 1 件ずつで、拒否も 0。履歴経由の同じ settle は重複になる。同じ `kind\|subject` で中身が違えば衝突として記録し、先のものを残す |
| 順不同 | Receipt の順を入れ替えても、記憶の状態のハッシュは同じ |
| 欠落 | spec が無い、時計が無い、本人の対応が無い場合は、それぞれ保留・`caravan_unknown`・`identity_unverified`。Receipt も coverage も無い約束は `no_record_found` で、「未発送」にはしない |
| 未確定 | finalized の slot より後の Receipt は保留し、約束は未確認のまま。finalized が進むと新しい分だけが入り、二重にならない。finalized の slot が示されなければ何も入れない |
| 再起動 | 途中まで取り込んで journal から開き直し、feed を最初から読み直しても、増えるのは新しい分だけで、状態は一度に取り込んだ場合と同じ |
| 期間の境界 | 戦期の印をまたぐ Receipt も、同じ partition の続く記憶として扱う（印で何も区切らない） |
| u64 | 2⁶³ を超える tag も正確に扱い、丸まった値は拒否する |
| ⑬（契約の代役） | mirror の返り値は⑬の port と同一。⑬が拒んだ重複は書かない。note は本人だけに見える。事実・約束・評判は増えない。両方を再起動して reconcile しても note は増えない。⑫が書けなくても⑬の返り値は変わらない |
| ⑬（実コード） | ⑬の `localMemory` と `trustOf` を、mirror 越しでも同じ答えで使える。⑬が書く種類 11 個をすべて受け付ける。再起動と reconcile で増えない。⑬の sidecar の試験 6 件は、この⑫で通る |
| ⑬の住民の実行 | ⑬の模擬世界で住民を mirror 付き・無しで走らせて比べる試験（再起動・戦期の印を含む）を書いたが、⑬の demo は `permutation-gateway` の npm 依存（`@solana/web3.js`）が無いと読み込めない。導入は未承認のソフト導入にあたるため入れず、**理由を表示して skip した**（実行していない） |

変異試験：`tools/mutate.sh` の 67 か所すべてで、試験が失敗することを確認した（アダプタ分 7 か所を含む）。

## 4. 実接続に必要な残件

1. **④**：Receipt を⑫へ渡す経路（SQLite の `receipts` と `runs.spec` を読むか、④が出力するか）、finalized の slot の出し方、slot → block time。倉宛ての `credited`（P1）は program に未適用で、今の vectors の `credited` は④の模擬世界のもの。所有者の区間と coverage（全経路・gapless・finalized）を作る主体はまだ無い。
2. **⑧**：world account・program・cluster・`genesis_ts` を、正本（herald の `/h/world` など）からどう渡すか。tag → wallet の resolver（世界口座と wallet から citizen の住所を導くもの）を④・⑧のどちらが持つか。
3. **⑬**：`runDemo` に memory port を差し替える口が無いので、⑫の試験は同じ手順を自前で回している。差し替え口を⑬に設けるかは⑬の判断。⑬の全試験と住民の実行比較には、`permutation-gateway` の npm 依存の導入（承認が必要）がいる。⑬の bell が⑫の world bell と同じ時計であることの確認も要る（今は模擬世界の bell）。
4. **未決**：遅れた返済・襲われた返送の評価、私的記憶の公開範囲、NFT 譲渡時の記憶の扱い。どれも実装していない（note は所有者本人だけに見え、譲渡で移る仕組みは無い）。
