# 継続する世界：シーズン依存の洗い出しと④の変更（2026-10-31）

方針：Wylls の世界は終了もリセットもしない。戦期（戦争・競争の区切り）は世界の寿命とは別に扱い、周期・集計・配分は未決とする。この文書は④（共有コアと移行の統合担当）の正本の候補である。各担当が別に World／Period の正本や移行処理を作らないよう、ここに集める。

区分：**実装した**のは④の実行器（`src/`）と試験だけである。**提案**は program・gateway・keeper・herald・UI への変更で、どれも当てていない。実チェーンでは何も確かめていない。

## 1. 残っていたシーズン依存

### 1.1 program と ABI（④が読んで確認した）

| # | 依存 | 根拠 | 継続する世界での影響 |
|---|---|---|---|
| S1 | **すべての口座の住所が Season から導かれる**：`sha256(Season PDA ‖ seed ‖ program)`。Season PDA は `["season", le64(id)]` | `frontier-abi/src/addr.rs`、`permutation-frontier/src/addr.rs:3-7` | 新しいシーズン＝新しい世界（村・土地・物資がすべて別の住所になる）。続けるには、**同じ Season PDA を世界の口座として使い続ける**しかない。名前の置換では解決しない |
| S2 | player の処理の前提（prologue）が、実効の状態 Running と `bell < end_bell` を要求する | `proc/citizen.rs:131-136` | `end_bell` で、すべての player の操作（SendCaravan、施設、進軍など）が止まる |
| S3 | `EndSeason`：`bell ≥ end_bell` で Ended にする。stack と keeper が自動で送る | `proc/season.rs:625-660`、`stack/src/up.rs:1643-1667` | 世界を止める装置である |
| S4 | 参加の締め切り：`bell ≥ join_close_bell` で Join を拒否する | `proc/citizen.rs:321-349` | 後から来る人が入れない |
| S5 | 閉じられる時期が終了に縛られている：CloseMarch、CloseProvince、CloseHolding、CloseCitizen は「Ended から 72 時間後」か tombstone の後だけ。RingSeed・AnchorArchive・DefenceClaim は CloseSeason の part 8〜10（tombstone）だけ | `proc/conquest.rs:1750-1780`、`map.rs:917`、`citizen.rs:2412-2470`、`season.rs:941-1010` | 終わらない世界では、これらの口座と rent が**増え続ける**。立ち去った人の Holding／Citizen の rent が戻らない |
| S6 | 終了に縛られずに閉じられるもの：ClashInputs（決着の後）、ArrivalDay（その日の bell をすべて決着した後）、ArrivalSlot（精算の後）、SeedCache（archive の後）、Vault（空にした後、持ち主）、Structure（持ち主）、Caravan（settle の時） | `proc/clash.rs:1839,1941,2013`、`beacon.rs:729`、`caravan.rs:876,1851`、`structure.rs:553` | そのまま使える |
| S7 | `end_bell` で止まるもの：beacon・anchor（`bell ≥ end_bell` は BadData）、進軍の到着（`< end_bell`）、包囲の完成、reveal | `proc/beacon.rs:192,240`、`host.rs:652-657`、`conquest.rs:785-793,1006-1012`、`reveal.rs:761` | 戦期の区切りに転用すると、進軍や封印が境界で失われる（⑱の範囲） |
| S8 | 賞金：Tally は Season が Ended であることを要求する。pool の PDA は `["pool", game, le64(season_id)]`。bitmap は ring 0〜17 まで | `permutation-prize/src/lib.rs`（module doc、`pool_of`） | 賞金が世界の終了に結び付いている。戦期の賞金は未決。今の pool は**旧経路の互換**としてだけ残す |
| S10 | **終了をまたぐ隊商は永久に精算できない**：SettleCaravan は道中の全 Province が隊商の最後の bell より先まで解決済みであることを要求する（`proc/caravan.rs:955-958`）。end_bell 以降の bell は決して解決されない（`proc/clash.rs:442-448` `in_season`）。SendCaravan には到着の bell の上限が無い。⑯の報告を④が実物で確認した | 境界の直前に送った隊商は、物資を積んだまま道に残る（CaravanEarly のまま）。④の旧経路の試験はこれを写し、run を保留 `SettlementOverdue` にする（§2） |
| S11 | `SeasonParams::validate` は `end_bell ≤ 4,032`（28 日）を要求する（`frontier-abi/src/presets.rs:285-287`。⑯の報告を④が確認した） | 「end_bell を巨大な値にする」ことは、検証で拒否されて**できない**。program の変更が要る |
| S9 | 上限：bell は `u32`（600 秒で約 81,000 年）。`R_MAX` は u16 で、preset は 16、web の `R_MAX_HARD` は 128。herald の累計は `u16::MAX` で飽和する | `fclient/src/clock.rs:22-23,103`、`client/frontier/addresses.mjs:150`、`herald/src/standings.rs:85-106` | 時刻は十分に足りる。地図の広さと herald の累計は有限である |

### 1.2 program の外（読み取り専用の agent による調査。4 点を④が実物で再確認した）

- **終了を待つ**：
  - herald の `final.json` は Ended の後だけ作られる（`herald/src/conquest.rs:2303-2313`、④が確認）。
  - 賞金の精算 script は STATUS 4 を要求する（`scripts/prize-settle.mjs:184`）。
  - AI の監査の公開は `season-end.json` を待つ（`citizens/audit/season_end.mjs`）。
  - 封印した AI の記録は、シーズン終了の bundle でだけ開かれる（`citizens/verify-minds.mjs`）。
- **終了を起こす**：
  - stack は `genesis + end_bell × bell_secs` で EndSeason を送る（④が確認）。
  - keeper の各種の役割は Running か Ended の間だけ動き、`end_bell` で予定を打ち切る。
- **シーズンごとの識別子**：
  - relay・herald・keeper は `--season` を 1 つだけ受け取る。
  - in-game key を作る署名文と鍵の保存名に `Season: id` が入る（`fsession.mjs:25-30`、④が確認）。
  - invite は `HMAC(… ‖ le64(season_id) ‖ nonce)`、話と投票の署名は `season`、封印進軍の帳簿の key は `…:seasonId:wallet`。
- **シーズン開始からの日数**：relay の quota は genesis から 7 日間だけ多い（`quota.mjs:20-34`、④が確認）。後から来た人は多い枠を受け取らない。
- **増え続けるもの**：
  - verifier は CreateSeason から全部を再生する。findex は archive 全体を読む。keeper は再起動のたびに feed 全体を読む。
  - herald の `Cq` は sieges・tally・hour_snaps などを保持し続け、checkpoint に全部書く。bell ごとのファイルも増え続ける。
- **表示と AI の文言**：「シーズンは終わりました」「シーズン終了まで …」「今シーズンの入植受付は終了しました」、AI の prompt の "Season ends at turn …"、persona の "the next season inherits"（`permutation-server/web/frontier/*`、`citizens/*`）。

（調査の全体：file と行の一覧が約 90 件。④の作業の記録にある。必要なら一覧のファイルとして渡す。）

### 1.3 ④の実行器

| 依存 | 結果 |
|---|---|
| Run の期限 | `deadline_slot` は run ごとの期限で、世界の終了ではない。依存は無かった |
| caravan の key `(owner_tag, seq)`、施設の key `fac:<run_id>` | 一つの世界の中では一意である。ただし store が**どの世界の run か**を記録していなかった。別の世界（別の Season）に向けて開くと、同じ seq を別のものと取り違えうる → **直した**（§2） |
| world 側の「受け付けない」 | 区別が無く、`FacilityRejected` として**失敗**にしていた（材料が無くなったように見える） → **直した**（§2） |
| store の伸び | `due` は `state NOT IN (…)` で、終わった run も走査していた。何年も続く世界では、毎 tick が遅くなる → **直した**（§2） |

## 2. 変更した挙動（④の実行器、`ws04/integration-20261030`）

1. **store は一つの世界に属する**：`Chain::world()`（program と世界の口座）を、最初の tick で store に記録する（`meta.world`）。別の世界の port で開くと、実行器は何もせず、alert `world_mismatch` を出す。run は変わらない。
2. **世界が受け付けない（`Reject::WorldClosed` → `Reason::WorldClosed`）**：失敗にしない。保留にする。
   - 施設の前なら `Reserved` で保留：何も使っていない。予約は残す。
   - 発送の前なら `FacilityConfirmed` で保留：産出物は stock に残る。owner の seq は空ける。
   - 世界が再び受け付けるようになれば、`resume` で続く。
   - 既に道にある隊商は、そのまま精算を待つ。
3. **開いている run だけの部分 index（`runs_open_due`）**：`due` はこの index だけを読む。cancel は `next_check = 0` にするので、前と同じく次の tick で拾われる。
4. **模擬正本**：
   - 世界の id（`world`）。
   - 戦期（`period_slots`）：境界は番号を進めるだけで、世界の状態を変えない。
   - 旧経路（`legacy_end_slot`）：今の program の S2 の規則を写す。player の操作は拒否し、精算は続ける。
5. **精算されない隊商（`Reason::SettlementOverdue`）**：到着から `settle_grace`（既定 3,000 slot）を過ぎても道にある隊商は、保留にする。積荷について何も述べない（0 とも、届いたとも書かない）。resume で再確認する。旧版の世界の終了（S10）でも、keeper の遅れでも同じ扱いにする。
6. **賞金の通し試験の位置付け**（`e2e-native/tests/legacy_season_claims.rs`）：完成形ではなく、**旧経路の互換と既存の受取権の確認**とした。

## 3. 試験で確認したこと（MOCK と host 実行。実チェーンではない）

| 試験 | 確認したこと |
|---|---|
| `continuity::boundaries_and_restarts_change_nothing` | 7 slot ごとに戦期の境界を置き、6 本の run（施設、材料の入荷待ち、村あて、倉あて、途中から始まる run）を境界にまたがらせた。境界ごとに再起動しない／再起動する／別の実行者 id に替わる、の 3 通りを試した。どれも、境界の無い世界と次が一致した：状態・理由・入った量・Receipt・費用の帳簿・各地点の物資・正本の効果の回数（各 1 回まで）。保存の監査（milli 単位）も通った。境界で隊商の積荷を消す変異は検出した |
| `continuity::legacy_world_end_holds_work_and_strands_the_late_road` | 旧経路の世界の終了について、3 つを確かめた。(1) 終了の前に着く隊商は精算され、Fulfilled になる。(2) 終了の後に着く隊商は道に残る（S10）。run は保留 `SettlementOverdue` で、結果は無く、物資は隊商の中にある。(3) まだ施設を使っていない run は、`Reserved` で保留 `WorldClosed` になる：結果は無し、材料は手つかず、効果は 0。世界が再び受け付け、bell を解決するようになると、両方とも resume で Fulfilled まで進む。保留を失敗に戻す変異は検出した。**訂正**：`5a103765` の版のこの試験は、道にある隊商がすべて精算されるとしていたが、program の実物では誤りだった（⑯の指摘） |
| `continuity::a_store_is_never_applied_to_another_world` | 別の世界の port では、run の版も状態も変わらず、alert が残る。元の世界に戻れば続く |
| `continuity::finished_runs_do_not_slow_the_due_query` | `due` の実行計画は `runs_open_due` を使い、runs の全表走査をしない（長期の伸びの検証。境界の通過とは別の試験） |
| `e2e-native/tests/legacy_season_claims.rs`（2 件） | permutation-prize の `process_instruction` を host で実行した（System と SPL Token は④の stub）。テスト USDC → Pay → Tally → Finalize → SetShares → Claim の後、受取額が token の口座の残高の差と一致する。勝たなかった国と、払っていない人は受け取れない。入ったテスト USDC ＝ 支払い＋運営分＋端数 |
| `e2e-native/tests/registry.rs` | 契約の登録表（`contracts/registry.txt`）がコードの定数と一致する |
| 全体 | `cargo test` 72 件、gateway の試験 9 件（ignored として別に実行）、clippy の警告 0 |

**試験していないもの**：
- 封印進軍・drand の round が境界をまたぐこと（⑱）。
- 預かりの義務（⑩）と加工の能力の予約（⑨）。④の模擬の施設と倉は近いが、各担当の実装ではない。
- 実際の program を戦期の境界で動かすこと（program を変えていないため）。

## 4. 移行と仕様判断が残る点

### 4.1 共通方針（④の提案。採否は未定）

| 項目 | 方針の案 |
|---|---|
| 世界の識別子 | 今の Season PDA を、そのまま**世界の口座**とする（移行の理由：すべての住所がこれから導かれるので、変えると全口座の移し替えになる）。名前の `season_id` は世界の id として固定し、二度と増やさない。戦期の番号は別の欄にする |
| 世界の状態 | 「終わる」状態を世界から外す。旧版の Season（Ended／Closed）は、そのまま旧版の証拠として読む。書き換えない |
| 戦期 | 別の口座（例：`WarPeriod{index, start_bell, end_bell, params_hash}`。世界の住所の下）。player の処理の前提は戦期を見ない。何を集計するか、賞金をどう配るかは未決（採用しない） |
| 賞金 | 今の pool（シーズン単位）は旧経路として残し、既存の入金と受取権を守る（試験済み）。新しい料金の周期や賞金の制度は決めない（⑰） |
| 口座の後始末 | S5 の「終了後だけ閉じる」を、口座ごとの経過の規則（決着・精算からの経過、空になったこと、本人の退出）に移す。新しい世界の終了を前提にしない |
| 参加 | `join_close_bell` は継続する世界では使わない。参加の制御は別の規則にする（NFT の参加証は未決で、毎戦期の買い直しや参加費を前提にしない） |
| 版 | `program_version` と `ruleset_hash` は registry に一本化する。旧版の証拠は旧版の規則で再検証し、新版の証拠に読み替えない |

### 4.2 program の変更（提案、未適用）

- **P-C1**：Season の予約領域に「継続モード」の印を足す。継続モードでは、player の処理の前提で `bell < end_bell` と EndSeason を使わない。旧版の Season は今の挙動のまま。
- **P-C2**：継続モードでは Join の締め切りを外す。
- **P-C3**：S5 の口座に、経過による close を足す（March、AnchorArchive、RingSeed、DefenceClaim、立ち去った Holding／Citizen）。
- **P-C4**：戦期の口座を足す（中身は未決）。

どれも program の build と LiteSVM での試験が要る。**承認待ちの環境**（下）が無いと検証できない。

### 4.3 program の外

- keeper・stack：EndSeason を自動で送らない。
- herald：final.json を戦期の集計に分け、累計の飽和と checkpoint の肥大を直す。
- verifier・findex：checkpoint からの再検証にし、genesis からの全再生をやめる。
- relay：quota を参加した日から数える。
- UI と AI の文言：⑦⑬と調整する。

担当は各 workstream だが、World／Period の定義は④の registry と、この文書に揃える。

### 4.4 承認が要る環境（入れていない）

| 項目 | 内容 |
|---|---|
| 入手元 | Anza の Agave release（solana-cargo-build-sbf 3.1.9、platform-tools v1.52）。`scripts/build-prize.sh`・`build-frontier.sh` が要求する版 |
| 変更する場所 | `~/.local/share/solana/install/active_release`（この container だけ） |
| 実行すること | `scripts/build-frontier.sh`、`scripts/build-prize.sh`、`permutation-frontier/svm-tests` と `permutation-prize/svm-tests` の `cargo test`（LiteSVM、network なし） |
| 得られるもの | P-C1〜P-C4 と、旧経路の互換を、実際の SBPF の build で試せる。host 実行（e2e-native）との差（CU、loaded data、本物の SPL Token）を確かめられる |

### 4.5 受領物の一覧（実物の有無）

| 担当 | 実物を受け取って照合した版 | 報告されたが、受け取っていない版 |
|---|---|---|
| ① | `3f3c8478`（tree `8d94de05`） | `f5a953b` |
| ② | `dc3bd3d`（StockSwap は不採用） | — |
| ③ | `acdcd0bf`（v4）、0005 は適用済み | `a361a30f`、b79bf1f（③の session の要約より） |
| ⑤ | `45cba41e`（tree `c6e07b04`）、0001 は適用済み。0002b・0003 は隔離した試験だけ | `29365e60` |
| ⑥ | `517796dc` r2（ADDENDUM 優先） | — |
| ⑦ | `1f2d7419`（v2） | `3eb51686`、v5 |
| ⑧ | `f0dd683d` | 新しい地図（地図拡張） |
| ⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲ | 受け取っていない（⑮は予告のみ） | ⑪ `fc61a21`、⑫ `cb7b1fad`、⑬ `19d9f72e`、⑭ `bc949430`、⑯ `2fbc6a21`（各 session の要約より） |

受け取っていない版は、取り込み済みとしない。届いたら、照合済みの版からの差分だけを照合する。

## 5. 他の担当から届いた要件（データとして受け取った。採否は未定）

- **⑪（拡張）**：
  - 拡張の口座の根を、期間で変わらない根にする。④の案（Season PDA を世界の口座として固定し、二度と変えない）と両立する。
  - 許可・状態・預かりは、所有者の変わらない識別で引く。
  - 返却の出口は、期間の状態で拒否しない（今の player の処理の前提を通さない）。
  - 規則の版と期間の識別を分ける。
  - 古い seq の呼び出しは、他の検査より先に SeqMismatch とする。
  - CloseHolding が終了の 72 時間後に預かりごと閉じる経路をどう扱うかは、④⑩の判断。
- **⑯（独立検証）**：
  - S10・S11 を確認した（④も実物で再確認した）。
  - 休眠の解放 `release_after_secs` が季の長さと同じ。ring の開放と盾の「遅参」が genesis からの経過で決まる。
  - `MAX_SESSION_SECS` が 30 日。`gen` は u8 で、番兵 0xFF と衝突する。
  - marchbook（封印進軍の平文）が season id の切り替えで孤立する。
  - これらは program・UI の側の残りとして扱う。④の実行器には影響しない（④の `PlaceRef.gen` は u8 だが、番兵として使っていない）。
- **⑮（協力の達成評価、`ws/15-coop-outcomes` @ 75b1d95b、未受領）**：評価期間は外から入力として受け取る（`windows: [{id, opensAt, endsAt}]`）。閉じるのは判定だけ。再開の後も、同じ記録を二度は適用しない。④への問いと、④の案での答え：
  - M1 評価期間の境界の正本：P-C4 の戦期の口座（未決）。決まるまでは、⑮のように外から入力として渡す形でよい。
  - M2 世界の時計：bell は Season の genesis から数える。④の案では、Season を世界の口座として固定するので、**bell は期ごとに 0 に戻らない**。0 に戻るのは、期ごとに新しい Season を作る今の運用だけである。
  - M3 期をまたぐ同一性：④の案では住所が変わらない。`epoch` と `actorOfTag(tag, epoch)` の写しは、旧版の（終わった）Season の記録を読むときだけに要る。
  - M4 欠落の判定の番号：④は、出来事の識別に記録の位置（`sig ‖ 命令の位置 ‖ log の位置`、CONTRACTS §2）を使い、欠落の判定に port の feed の位置を使っている。herald の `/h/events` の番号は期ごとの畳み込みなので、世界の正本にはしない。未決。
  - M7 履歴の圧縮：未決。④の側では、開いている run だけの index で、毎 tick の処理を履歴の量から切り離した（§2）。記録そのものの保存期間と圧縮の規則は、⑧と決める。
- **⑰（決済・賞金。⑰の commit 5 件、未受領）**：⑰の D2・D3 を、④が host 実行（permutation-prize の実際のコード）で確認した。
  - **D2**（`e2e-native` の `while_the_world_runs_deposits_have_no_exit`）：Season が動いている間も Pay は入金を受け付ける。一方、Tally と Finalize は SeasonNotEnded、SetShares と WithdrawOps は WrongState、Claim も通らない。**終わらない世界では、入金にも運営分にも出口が無い。**
  - **D3**（`a_closed_citizen_loses_its_shares_claim_but_not_a_refund`）：shares モードの Claim は、勝った国の Citizen の口座を要求する。後始末で Citizen が閉じられると、その人の受取は拒否され、取り分が金庫に残ったままになる。refund モードの Claim は Entry だけで通る。**既存の受取権を守るには、精算と受取の前に CloseCitizen を止めるか、Claim が Citizen を要求しない経路が要る**（program の変更。未適用）。
  - x402 の欄の案（今のコードが返す値）：x402Version 1、scheme exact、`maxAmountRequired = pool.fee`（6 桁の最小単位）、`payTo` は金庫の PDA、取引は 5 命令（Pay＋Join を含む）。公式の x402 との差（network 名、resource の形、Join を含むこと）が⑰から報告されている。registry には、⑰の 0001〜0005 を受け取って照合してから載せる。
- **⑲（MagicBlock と公開 RPC。ローカル枝 `claude/ecstatic-cannon-d0jfc4`、基点 4cd901de、未受領）**：④の「着地した／していない」の判定と、履歴の取得に効く事実。
  - fclient は `getTransaction` に `maxSupportedTransactionVersion: 0` を送る（`frontier-node/crates/fclient/src/rpc.rs:157`。④が確認）。そのため、委任プログラムの v1 の取引（解除・commit）が program のアドレスの履歴に現れると、-32015 で findex の取得が毎回止まる（⑲が Agave 4.2.2 と ephemeral-validator 1.1.1 で再現）。
  - findex の `RpcPoll` は、最後のページが `until` に届いたかを確かめない。ノードが履歴を刈り込んでいると、欠落を黙って保存する（`findex/src/ingest.rs:115-150`。④がコードで確認）。⑲は修正 7b53a87 を持っている（欠落なら `Unavailable("history gap")` で何も保存しない）。
  - Absent の条件についての⑲の提案は、④の HANDOFF §3 と一致する：finalized で読み、全履歴を探し、ノードの保持範囲が送信の slot 以前で、blockhash が失効済みのときだけ。ER 宛ての送信は、署名の状態からは Absent にせず、対象口座の状態（seq と head の compare-and-set）で判定する。
  - 委任のセッションは、期間の終わりでは閉じない（閉じるのは commit の予算、検証者の交代、保守のとき）。S1 の既存の口座は、どれも委任の候補にしていない。
  - 共有コアの変更案（未適用、④の判断待ち）：(a) `maxSupportedTransactionVersion` を 1 以上にする、(b) v1 の取引は解釈できなくても記録する、(c) 委任先の口座のアドレスでも履歴を取る、findex の欠落の検出（7b53a87）。届いたら、隔離した作業コピーで検証する。
- **⑱（drand・封印進軍・検証。ローカル枝 `claude/brave-bohr-xe4n4p`、コード 853140ef、文書 90df6a64、未受領）**：
  - 境界の試験（⑱の `fclient/tests/period_boundary.rs`）：bell の時計（genesis_ts と bell の番号）が続いていれば、境界をまたぐ封印進軍は T(arrive) の署名でだけ開く。境界で bell を振り直したり genesis をずらしたりすると、平文と transit が合わず破棄される。**戦期の切り替えで genesis_ts や bell を変えてはいけない**。これは共通方針 1.4（bell を戻さない）と一致する。
  - **秘匿の漏れ**：THE anchor がまだ投稿されていないとき、keeper は Reveal の作成を止めない（`keeper/src/play.rs:1078-1120`、anchor が `None` でも先へ進む）。また、fclient はすべての取引を `skipPreflight: true` で送る（`fclient/src/rpc.rs:423`）。そのため、THE anchor より先に、平文と salt を含む Reveal が RPC へ渡り、T(arrive) の最大約 600 秒前に公開されうる。**訂正（2026-10-31）**：前の版では「早すぎて失敗した Reveal」と書いたが、program は THE anchor が無くても Reveal を受け付ける（`proc/reveal.rs:803-835`）。したがって、着地しても失敗しても平文は公開される。④は RPC の境界で再現した（`patches/r18-check/README.ja.md`）。⑱の修正（anchor の前に Reveal を作らない）は、取り込みの候補（共有コア、未適用）。
  - 証拠不足の名前：FAIL（`UnknownInstruction`、`Undecodable`）と UNVERIFIABLE（`UnverifiedInstruction`、`UnknownProgramVersion`、`MissingData`）。推測で FAIL にも PASS にもしない、という点は、④の数量契約の「証拠のない 0 や奪取を断定しない」と同じ考え方。名前は registry に載せる候補（未決）。
  - 残る課題：keeper の journal（plaintexts、owner_material、PlayDuty.owner）に削除の経路が無い。検証器は CreateSeason から全部を読むので、checkpoint の定義が要る。FastForward の検証器のモデルが無い。CloseMarch と V5 ArrivalAfterEnd の見直し（P-C1・P-C3）。
  - ⑲の最終の保存パッケージ：`package-er19.tar.gz`（sha256 `3455ffcfaaed12b6a829957a501315c314f3cbff348cd5b036689ece957e4f24`、枝 HEAD `a91b7a4f532b3a6c2e63eeeafd33279f789740c3`、基点 4cd901de）。中身は、基点に単独で当たる独立パッチ 3 本（A：findex の欠落の検出、B：frontier-er（S1 とは別の program の候補）、C：docs）。⑲の報告では、frontier-node の workspace で合格 711・失敗 0。未受領。④の判断を待つ点は⑲の `docs/frontier/er-candidate/CONTINUING-WORLD.ja.md` §4 にあり、上の (a)(b)(c) のほかに次がある：findex の確定度、検証器の「最終状態」の意味（世界が続くと HEAD_MISMATCH になる）、archive の長期の増加、板を S1 に入れる場合の seed（`["wylls-er-board", Season PDA]`。世界の口座の案 W1 と整合する）。
  - ⑲の補足（2026-10-31）：findex の欠落の検出（A-findex.patch）は、完全な履歴を保証しない。次の場合は、欠落が無いとは言えない：初回（cursor が無い）、cursor が不明・古い形式、ノードが最後の署名を持ちつつ途中だけ欠けている（一つのノードからは見抜けない）。**findex に記録が無いことを、「起きていない」根拠にしない**。④の実行器では、findex の entity 履歴と feed は「あった」ことの証拠にだけ使い、Absent（着地していない）は全履歴・確定・範囲が揃ったときにだけ言う（HANDOFF §3）。この規則は⑫・⑮が findex を使うときにも当てはまる。
