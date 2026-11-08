# ①・④・⑭の実出力との照合（2026-11-05）

起点は `b1a09a0b15dd44f587b1158fc40dd3f17577fcca`（`origin/preserve/ws15-b1a09a0b`）。

勝利条件・評価期間・賞金は、引き続き決めていない。評価期間は外から与える入力のまま。⑭の境界から作る手段を足しただけで、周期は決めていない。

## 0. 照合した相手

| 相手 | 版 | 実出力の取り方 |
|---|---|---|
| ⑭ 中央塔 | `7d7f2143d6f2696a3bc323d1d619b1d6961a7b18`（`origin/preserve/ws14-7d7f2143`） | ⑭のコード（`proto/model.mjs`・`proto/adapters.mjs` の `toFacts`）をそのまま動かした出力。`scenarios/fixtures/ws14-7d7f2143.json`。作り方は `gen-ws14.mjs` |
| ① 国の協力 | `3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52`（`origin/preserve/ws01-coop-s1-3f3c8478`） | ①の純粋な関数（`coop/arrival.mjs` の `arrivalOf`・`creditedOf`・`indexFeed`）の出力。①が commit した herald の写しを使った。`scenarios/fixtures/ws01-3f3c8478.json`、作り方は `gen-ws01.mjs`。署名を要する `fold()` は動かしていない（鍵・署名の試験はしない）。依頼の形は `fold()` のコードから写した |
| ④ 実行基盤 | `a967f5f1c64facc32facf07010f39a679c77d80a`（`origin/preserve/ws04-a967f5f1`） | ④は実行結果の JSON を commit していない。Rust を build して動かすこともしていない。そこで、④の serde 型（Receipt、Settle、Raid、RunSpec、Outcome）の JSON の形で ⑮ が書いた。`scenarios/fixtures/ws04-types-a967f5f1.json` で、実行の出力ではないと明記している |

⑮の修正とされる `1913625d` は、origin のどのブランチにも、手元にもない。⑯に照合と差分を依頼した（未着）。

## 1. ⑭：何を直したか

| 点 | ⑭の実際 | 直す前の⑮ | 直した後 |
|---|---|---|---|
| 時刻 | `t` は模型の時間（1時間＝6ターン） | `hour` を読み、鐘として扱っていた | 鐘 = `t × 6`（1ターン＝S1 の1鐘、600秒） |
| 掲示（`board_post {req}`） | 依頼を塔に掲げた。目撃ではない | 目撃（`tower.sighting`）として読んでいた | `tower.request.posted`。目撃としては読まない |
| 引受（`board_taken {req, cross}`） | 応えて荷を**送った**（到着ではない） | `by`・`of` を読んでいた | `tower.request.taken`。送っただけでは何も満たさない（`taken_not_arrived`） |
| 交換の完了（`board_fulfilled {req, cross}`） | 双方に届いた（`actor` は依頼主） | 読んでいなかった | `tower.request.fulfilled` |
| 中継の倉の交換（`relay_swap`） | 模型の中の交換 | 共同の建物の「利用」として読んでいた | `tower.relay.swap`。共同目標の利用には数えない |
| 確かさ | 模型の事実で、チェーンの記録ではない | `derived` | `model`。数えない。模型の事実だけが根拠の目標は `model_only`。達成にも報酬枠にもならない |
| 期間の境界 | `period.boundary` は、その時間の最初に記録される。だから同じ `t` の事実は境界の後に入る | — | ⑮の評価期間 `[opensAt, endsAt)` と同じ向き。`windowsFromBoundaries` で、⑭の境界から評価期間を作れる |

目撃の個人目標（P-scout）には、今は出どころがない。S1 の物見櫓は目撃を記録せず、⑭の塔に目撃の働きはない。目撃の入力があるときだけ出す。

旧シナリオ `coop-with-tower` は、⑭の出力ではなく仮の目撃だったので、`coop-with-sighting` に名前を変えた。

足した比較用の個人目標 P-board-helper（他国の人の掲示の依頼に応え、交換が双方に届いた）は、採用案ではない。⑭の入力では、いつも `model_only` で終わる。

**⑭との食い違い：** ⑭の README §12・§9 は「`period.boundary` も事実として渡せる」と書く。しかし `toFacts()` は `tower.*` と `centre.*` しか渡さない。⑮は、境界を `sim.facts` から別に受け取る形にした。

## 2. ①：何を直したか

- `fold()` の `requests` は id をキーにした object である。配列だけを前提にしていたのを直した。
- ①は、依頼が開いている間にだけ link を受け付け、その link は取消・期限切れの後も有効（隊商はそのまま届く）。⑮は取消済みの依頼の link を捨てていたので直した。重複は、①の記録の順（`n`）で最初のものを残す。
- `fromWs01Arrivals` を足した。量を数えるのは `source: 'chain-log'` の記録だけ。

| ①の到着の記録 | ⑮の扱い |
|---|---|
| 村あての到着（`lower-bound`） | 下限として数える |
| 倉あての到着（量なし） | 不明として数えない |
| `lost`（失われた） | 失われた |
| `misdelivered`（別の場所に着いた） | 失われた。原因は未確認とし、誰の名前も出さない（④ §7(b) の提案） |
| 襲撃 | 計画には何も届かない |
| ヘラルドの写しだけ | 数えない（保留） |

- 同じ隊商を2つの経路から入れても、一度しか数えない（試験あり）。
- ①の `arrivalOf` は、依頼の座標にある倉に着いた場合を `misdelivered` とする。依頼は村だけを宛先にできるため。そのため、①の記録から「量が不明の到着」は出てこない。

## 3. ④：何を直したか（④ 数量契約 §7 の⑮への4点）

- (a) 量の確かさは、受領書の中身ではなく Run の `outcome` から読む。
- (b) 襲撃した人の欄は `raider`。
- (c) 重複は `kind|subject` で除く。同じ中身を feed と履歴から読んだ場合も一度になる。中身が違えば衝突として外す。
- (d) 合計の判定を三つに分けた（§4 を見よ）。
- 送った隊商の受領書には、持ち主の数と宛先がない。持ち主は `subject` の16進から、宛先は Run の `spec.ship.dst` から読む。
- 持ち主・襲撃した人は u64 である。JSON の数では 2^53 を超えると JavaScript で正確に読めない。持ち主は `subject` の16進から正確に読める。襲撃した人には代わりがないので、欠落として残し、推し量らない。④に、文字列での出力を頼みたい。
- `DestinationMismatch`（別の場所に着き、襲撃の記録がない）は、「失われた、原因未確認」として扱う。量は述べず、誰の名前も出さない。

## 4. 到着量：下限・ゼロ・不明を分ける

| 種類 | 実際に入った量 | 出どころ |
|---|---|---|
| exact | その量 | ⑮の試験用の入力 |
| lower_bound | b 以上、b＋1 未満 | ①の村あて、④の RuleDerived・Recorded |
| zero | ちょうど 0（その隊商の証拠があるときだけ） | ④の KnownZero、settle の LOST。記録の 0 だけでは zero にしない |
| unknown | 0 以上、記録の積荷＋1 未満 | ④の Unverifiable（倉あて） |

計画の資源ごとの判定（④ §4 に合わせた）：
- 下限の和が要求量に届けば **met**（満たした）。
- 上限でも届かなければ **short**（足りない）。上限が「未満」のときは、要求量に等しいだけで足りない。
- それ以外は **undecided**。共同目標は「判定できない」になる。

例：下限 100 と 99 の2本（合計 199、上限 201 未満）は、要求 200 に対して「未達」ではなく「判定できない」。

下限・不明の量は、達成の根拠には数えない。

## 5. 試験

| 試験 | 件数 | 結果 |
|---|---|---|
| `node --test test/*.test.mjs` | 94 | 94 通過（契約試験：⑭ 8、① 5、④ 7、量 6 を含む） |
| `test/play.browser.mjs` | 5 | 5 通過 |
| `test/long-run.mjs 160` | — | 通過。全境界で収支が合い、再開も一致。1期間の時間は履歴 4 倍で 3.44 倍 |
| `bin/compare.mjs` | 16 シナリオ × 3 案 | シナリオ名の変更のほかは、前と同じ |

## 5b. 受け取った候補差分の適用（2026-11-05、添付 `wylls-candidates-clean-patches-20261105`）

**添付ファイル**
- SHA256：`d16b812d5cec881a7997bb0e696f62754e11ff99dcf843a48034d9b502ece7be`
- 中の `SHA256SUMS` はすべて一致した。

**⑮に関わる差分は2つあった**

| 差分 | 基点（`required_base_commit`） | もとの候補 | 期待する tree |
|---|---|---|---|
| `15-separate.patch`（SHA256 `7439d018…5515`） | `32ad894dfe4659e716421c711d8170c7c86e50d4` | `fix/ws15-exact-source-identity-20261105` @ `33d8c9fd88448f8dc783f9050c1421cf93cb1861` | `d64b3f36401970f8bd59430e3075728a0431ab8c` |
| `13-15-integrated.patch` | `1913625de7f3b1361d509c05982410dccb27718d` | `fix/ws13-review-integrity-20261105` @ `9905c6863e20c9c6db4debfff12022ec6eb3beb9` | `93c2263f74ef5c7e0fadd4a2e1b8dda67062b01a` |

- 以前、利用者から照合を頼まれた `1913625d` は修正ではなかった。`13-15-integrated` の**基点**である。
- 2つの差分の⑮の部分は、バイト単位で同じだった。そこで `15-separate` だけを一度当てた。`13-15-integrated` の⑮の部分は当てていない。⑬の部分は⑮の範囲外なので当てていない。
- **基点の照合はできなかった。** 2つの基点も、もとの候補の commit も、GitHub にも手元にもない（`git cat-file` で不明）。そのため `expected_tree` は再現できない。
- 差分の適用前の `s1-chain.mjs` の blob は `fd015ddc…` で、⑮のどの commit にもない（⑮は `9d8da975…`）。それでも⑮の HEAD には1行ずれて当たった。
- 差分の試験は、基点 `32ad894d` にあるはずの振る舞いを前提にしている。積荷のバイト列が正しくない記録を、「確かめた正確な積荷の証拠がない」として未解決にする振る舞いである。この振る舞いは差分にも⑮にもなかった。そこで⑮が書いた（`s1-chain.mjs` の `exactCargo`）。基点の実装と同じかは確かめられない。

**中身**
- 記録の流れの番号・鐘・場所・積荷を、正確な整数でなければ拒否する。
- JSON の数で 2^53 を超えたもの、負の数、先頭の 0、範囲外を拒否する。

**⑭の差分は含まれていなかった**
- 添付の README は「14・15の対応修正」とするが、`workstreams/14-*` を変える差分はない。
- ⑭の時刻（`t × 6`）・掲示と引受・actor・証拠の区分（`model`）の扱いは、5753626c の契約試験（⑭の実出力）で確かめている。

**あわせて直した残件**
- 下限の荷を分けて入れると「＋1」が重なる件（§6 の 6）を直した。端数は到着ごとに一度だけ、荷と一緒に運ぶ（`slack`）。最初に使った入力が持っていき、荷をまとめると足し合わせる。
- 試験：`quantity.test.mjs` の分割の場合。下限 199 を 100 と 99 に分けても、上限は 200 未満のままで、「足りない」と判定できる。

## 5c. ⑭の契約 v1 との組み合わせ（2026-11-06）

**受け取ったもの**
- 添付 `ws14-handoff-bde8d1c1.tar.gz`（SHA-256 `8a53f297ac573b0f36590ab8472dff4e4f16da93679e9b8533400e50bb80e8f4`）。中の `SHA256SUMS` はすべて一致した。
- ⑭の commit `bde8d1c1a92b5766b79bf0af7aae69052ca8ea34`（tree `99b73ee4d29dd897754c9bebf2080d3f13188b88`）。前提 `7d7f2143` の上の bundle から復元した。
- ⑭の試験：その commit を全部取り出した checkout で 27 件すべて通過。⑭の範囲だけを取り出すと、共有のファイルがなくて1件読み込めない。⑭の不具合ではない。
- 実出力の固定データ（案 A・B・C）は、⑭の `gen-fixture.mjs` で作り直すとバイト単位で同じになった。⑮には、中身を変えずに `scenarios/fixtures/ws14-v1-bde8d1c1-case{A,B,C}.json` として置いた。出どころは `ws14-v1-bde8d1c1.source.json`。

**⑮で直したこと（旧⑭の対応と別の道を作らず、同じ adapter で v0・v1 の両方を読む）**

| 点 | v1 の扱い |
|---|---|
| 時刻 | `hour`（模型の時刻）× ⑭が `time.bellsPerHour` で明示する倍率（6）。v1 でこの値がなければ拒否する。v0 は⑭の文書の 6 を使い、そう使ったことを結果に書く |
| 連番 | `seq` を記録の流れの位置に使う。位置と違えば契約違反として外す（欠落になる） |
| actor | 模型の村の番号。参加者への写しは呼び出し側が渡す。写せなければ欠落にし、推し量らない |
| 確かさ | ⑭は全件 `unverified`。⑮では `model` として、ゲームの事実に数えない。`unverified` でない事実は契約違反として外す |
| 掲示と応答 | 掲示は依頼で、目撃ではない。引受（`board_taken`）は送っただけで、`poster` を持つ。完了（`board_fulfilled`）は双方に届いたことで、`responder` を持つ。P-board-helper は `responder` 本人だけを数える（同じ依頼を引き受けたが届けていない村は数えない） |
| 期間の境界 | `period.boundary` は `model.boundary` として記録し、判定結果の `modelBoundaries` に**報告するだけ**。評価期間にはしない（前の版の `windowsFromBoundaries` は削った）。戦期でも評価の終わりでもない。⑭も「戦期ではない。⑮は windows を外から受け取る」と書いている |

境界の向き：⑭は区切りをその時間の最初に記録する。だから同じ時間の事実は区切りの後に来る。⑮の評価期間 `[opensAt, endsAt)` の向きと同じ（試験で確認）。ただし、向きを揃えただけで、境界から評価期間を作ってはいない。

⑭の照合スクリプト `check-ws15.mjs` で、⑮の新しい adapter を調べた。
- v1 は 1802 件すべて読めた（拒否 0）。
- v1 を v0 と偽った場合は、全件を契約違反として読まない。掲示を目撃にしたもの 0、境界を渡したもの 0。直す前の版では、掲示 631 件が目撃になっていた。

**試験**
- `test/contract-ws14.test.mjs` を v1 と v0 の両方に書き直した（11 件）。
- 全体で `node --test` 99 件すべて通過、画面 5 件、長期も通過。
- 比較表は、判定の hash まで前と同じ。

## 5d. ①の fold() と④の現在の JSON 出力への接続（2026-11-06）

起点は `cb87e30ceace7b959657d43b3c07cd4873aae9c7`。勝利条件・評価期間・賞金は決めていない。模型（⑭）の事実を数えないこと、⑭の境界から評価期間を作らないことは、そのまま（既存の試験が通る）。

**① fold() の実出力**
- 版：GitHub で最新の① `3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52`（これより新しい①の commit は、どのブランチにもない）。
- `gen-ws01-fold.mjs` が①のコード（`coop/record.mjs` の `fold`・`recordId`・`ownerTagOf`、`coop/goal.mjs` の `GOALS`、`coop/arrival.mjs` の `arrivalOf`）をそのまま動かし、その返り値を `scenarios/fixtures/ws01-fold-3f3c8478.json` に置いた。作り直してもバイト単位で同じ。
- 鍵・署名は使っていない：`fold()` は `sig` が文字列かどうかしか見ない（署名の検査は板が記録を受け取るときにする）。記録には `sig: 'unsigned'` を入れた。財布は 32 バイトの固定の公開アドレス（0x11… など）で、対になる秘密鍵はない。それに対する唯一の計算は①の `ownerTagOf`。公開データの hash で Citizen の口座アドレス（createWithSeed と Season の PDA）を求め、先頭 8 バイトを取る。秘密鍵の生成・導出・署名ではない。
- 15 件の記録のうち 9 件を fold() が受け付け、6 件を①自身の理由で拒んだ：自分の依頼への応答、同じ記録の二度目、他人の隊商の結び付け、同じ隊商の二度目の結び付け、取消の後の結び付け、別のシーズン。
- u64：①の持ち主の印は 2⁵³ を超える（例 `17278127443140898241`）。①は 10 進の文字列で書き、⑮もそのまま文字列で扱う（隊商の id に丸めずに入る）。
- 到着量：村あては①の `lower-bound` → 下限、失われた隊商（LOST）は何も届かない、倉あて（①は量を示さない）は不明、ヘラルドだけの写しは数えない。①には「ゼロ」の区分がない。焼かれた・奪われた隊商は計画に何も届けない、として扱う。
- 重複・順序：同じ出力を二度入れても一度だけ数え、並びを逆にしても判定の hash は同じ。fold() だけからは、達成・報酬枠・賞金は何も出ない。

**④ の現在の JSON 出力**
- ④の最新は `8e96f24d`（`origin/claude/gallant-ride-cunptv`）。④自身は実行結果の JSON を commit していない。
- 実出力として、⑫が④の `runexec demo`（happy・crash・raid・lost-response）を `d0949fd4` で build・実行し、SQLite から原文のまま書き出したものがある（⑫ の commit `4bc76d05`、`origin/claude/trusting-allen-dox8j6`）。⑮はこれをバイト単位で写した：`scenarios/fixtures/ws04-runexec-d0949fd4/`。出どころと SHA-256 は `source.json` にある。
- d0949fd4 から 8e96f24d までに、Receipt を書くコード（`executor.rs`・`store.rs`・`model.rs`・`ports.rs`・`sim.rs`）と数量契約は変わっていない。変わったのは `acts.rs`・`gateway.rs`・`lib.rs`・`main.rs`（代理の行為）だけ。⑮は④を build も実行もしていない。

**④の実出力で分かった、型からの想定との違い（⑮で直した）**

| 点 | 実出力 | ⑮の扱い |
|---|---|---|
| body と spec | オブジェクトではなく JSON の**文字列**（`body_json`、`run_specs_json`）。u64 は JSON の数 | `parseExact`：2⁵³ を超える整数は 10 進の文字列のまま読む（Node の JSON.parse の source text）。`fromRunexecDump` で読む |
| 持ち主の照合 | subject の 16 進（`cv:77:0`）と body の `key.owner`（119）の両方にある | 両方が正確に一致するときだけ使う。一致しない・正確でないときは欠落として残し、別の人に付け替えない |
| run の outcome | 書き出しにない（delivered・verification なし） | settle の記録から決める（④ §3）：倉あてで `credited` があれば下限［b, b+1）、なければ不明［0, cargo+1）、LOST はゼロ。outcome を渡せばそれを使う（KnownZero → ゼロ） |
| demo の積荷 | 8 枠の 6 番（Science）に 3 | 評価器は Science・Influence を持たない。**黙って捨てず**、「数えない資源」として報告し、記録の位置は保つ（欠落にしない） |
| 同じ隊商を 3 つの run が報告 | `caravan_sent`・`caravan_settled` が同じ中身で 3 回 | 1 件ずつに減らし、量も 1 回だけ（3 であって 9 ではない） |
| 重複の選び方 | — | **直した不具合**：同じ中身のうちどれを残すかが入力の順で変わり、判定の hash が変わっていた。run の id と source で決めるようにした |

量の区別（正確・下限・ゼロ・不明）と u64 の試験は、④のバイト列に一か所だけ文字を置き換えて行った（積荷を 6 番から 1 番の木材へ、持ち主を 2⁶⁴−59、襲撃者を 2⁶³+1、`credited` を除く）。どれを置き換えたかは試験に書いてある。

**試験**
- `test/contract-ws01-fold.test.mjs`（6 件）、`test/contract-ws04-runexec.test.mjs`（8 件）を足した。
- 全体で `node --test` 113 件すべて通過。比較表は前と同じ。

## 5e. ④の chain flow（実ゲームのコードを通った隊商）と⑫の事実の照合（2026-11-08）

起点 `bf7f43fca3f4425160ab8a4c318fb45073261955`。④の公開統合候補 `cf517b558d1303a84dba618550f40cb460b7ad99`（その後 `5ee66869` も確認）の chain flow の出力を、バイト単位で写した：`scenarios/fixtures/ws04-chain-flow-cf517b55/`。
- 段 A：ゲームのプログラム自身の JoinResident で NFT の通行証を参加させる。
- 段 B：その Citizen の隊商を④の run executor が送る。
- 段 C：⑫の adapter で読む。
- 段 D：⑮の旧 b1a09a0b の adapter で読む。

④の書き出しのとおり、時計（bell＝slot）、確定（すべての slot が確定）、国（RESIDENT_JOINED の faction の値）は代役。

| 確かめたこと | 結果 |
|---|---|
| 送り | Citizen（tag `1973050754706772817`、2⁵³ を超える）が木材 4 を送る |
| 到着 | 4 が届く。④の run の outcome は `Recorded`。§3 の案 B なので下限［4, 5）で、正確な量ではない |
| ⑫との一致 | ⑫ の事実（c-memory）と、送り手の tag・seq・積荷・credited（whole_units）・鐘が一致する |
| 確定 | `finalizedSlot` より後の記録は保留する。欠落にはしない。slot の順なので、確定が進んでも判定した記録の位置は動かない |
| 時計 | 時計が鐘に置けない slot は欠落にする。鐘を推し量らない |
| 判定の外 | 事実からは報酬枠も賞金も出ない。世界は続く |
| 旧版との差 | 旧 adapter は送りを落とし、ship の id に `undefined` の seq を書いていた（④の d-outcome が記録している）。今の adapter では起きない |

**④との境目**
- ④の `tools/chain-flow/stages-cde.mjs` は、⑮の旧い呼び方 `(receipts, map, opts)` を使っている。⑮はその形も受け付ける。
- ただし、⑮の新しい版を④に取り込むと、stage D を作り直したときに④の検査が 2 つ落ちる（「到着が chain で正確」を期待しているため）。
- その直しを④向けの差分 `patches/ws04-chain-flow-stage-d-cf517b55.patch` にした。④の領域なので、当てるかは④が決める。当て方は [patches/README.ja.md](../patches/README.ja.md)。
- この差分は、④の固定データから SQLite の store を作り直し、④の no-keys-guard の下で stage C・D・E を動かして確かめた。D は通る。C と E の出力はバイト単位で同じ。`check-fixtures.mjs` は 31/31。

**試験**
- `test/contract-ws04-chainflow.test.mjs`（7 件）。
- 全体で 120 件。④の `scripts/ci/no-keys-guard.mjs` を先に読み込んだ実行でも 120 件すべて通過。

## 5f. ⑭の中央の事実（centre-facts/1）、⑫・⑬との名前の揃え、①の待ち（2026-11-08）

**⑭ `wylls.ws14.centre-facts/1`（`d9c8b81d09fac0a0eeb9ef471e1dc7cb2c20fbd1`、`origin/claude/hopeful-cori-tql3le`）**
- `gen-ws14-centre.mjs` が⑭の `game/centre.mjs` の `centreFacts` をそのまま動かし、その返り値を `scenarios/fixtures/ws14-centre-d9c8b81d.json` に置いた。入力は二つ。
  - ①が commit したヘラルドのファイル。本物のヘラルドの出力で、中央には何もない。
  - ⑮がヘラルドの形で書いた一覧（⑭の試験と同じ形）。
- 読むのは `src/adapters/ws14-centre.mjs` の `readCentreFacts`。**事実の集計として報告するだけで、評価器の event にはしない。** 目標・報酬枠・得点・賞金は読まない。中央の倉・建物・通行が何に値するかの規則がないため。
- `verified: 'derived'`：ヘラルドがチェーンの記録から畳み込んだもの。⑭の模型の事実（`unverified`）とは別の schema として扱う。tower-facts の adapter は centre-facts を断る。
- 時点の扱い：⑭の provenance を写す。
  - 前後の `/h/status` が同じ → `snapshot`
  - 違う → `between`
  - 読んでいない → `source_unknown`
  - どれでも事実は並べるが、時刻を推し量らない。
- **使わない欄：** `centre.transit.cargo` は資源をまたいだ合計（⑭の `sumCargo`。例：木材30＋石材50＝80）。summary の積荷の割合もその合計から作られている。⑮は資源を合計しないので、どちらも使わない。数は事実から数え直す。
- 目撃（`centre.sighting`）には、物見櫓の持ち主も、見られたものも入っていない。だから誰の手柄にもしない（`creditedTo: null`）。

**目撃の出どころ（以前の記述の補足）**
- S1 のチェーンには目撃の記録がない。ヘラルドは公開の記録（DEPART・REVEAL など）から目撃を計算して `h/structures.json` の `sightings` に出している（`frontier-node/crates/herald/src/structure.rs`）。
- よって、目撃そのものの出どころはヘラルドの派生の事実としてある。ない記録は、目撃を別の人が**使った**ことのほう。P-scout の判定は変えていない（`no_sighting_source` のまま。理由の文は [06](06-conflicts-decisions.ja.md) の食い違い 15）。

**⑫・⑬との名前の揃え**
- 実際のゲームの参加者は、⑫ の identity（`identity_alias`：Citizen の tag → wallet、または NFT の通行証）で名付ける。⑬の住民も相手を wallet で覚える。
- chain flow の試験（§5e）では、⑫の `identity_alias` の principal を⑮の actor にした。
- ⑬の住民の隊商は④の run を通るので、⑮には④の receipt として届く。⑬の住民が実際に送った隊商の receipt は、まだ commit されていない（読むものがない）。

**①**
- ①の最新とされる `a110411bb98cabd8ab1f3521cfc1b7d954a27d76` は GitHub にない（fetch すると "not our ref"）。①に push を依頼した（2026-11-08）。
- 届くまで、⑮は 3f3c8478 の `fold()`（§5d）で照合している。requests は id をキーにしたオブジェクト。記録の season は `{programId, seasonId}` で、fold は season の違う記録を拒む。
- `fold()` の返り値自体は season を持たない。そのため、どの program・season の板かは呼び出し側が⑫の `worldFromSeason` と揃えて渡すしかない。これを①への確認点にした。

**試験**：`test/contract-ws14-centre.test.mjs`（7 件）。全体で 127 件。

## 6. 残っていること（2026-11-08 時点）

**依存待ち（相手の成果物が要る）**
1. ①の `a110411b`（GitHub にない）。届いたら、`fold()` の requests の形と season の文脈を照合する。①の板が受け付けた本物の（署名つきの）記録の列と、チェーンから読んだ隊商の確定（`caravanEndFromChain` の実際の返り値）も未受領。
2. ④が⑮の更新を取り込むかどうかと、stage D の差分（`patches/ws04-chain-flow-stage-d-cf517b55.patch`）を当てるかどうか（④の判断）。④の cargo の stage A・B は鍵を作る試験を含むので、⑮では動かしていない。固定データだけで確かめた。
3. ⑬の住民が実際に送った隊商の、④の store（receipt と run）。
4. ⑭の centre-facts の積荷を資源ごとに出す欄、目撃の持ち主と subject（⑮から要求はしていない。使うかどうかは規則の判断）。
5. 差分の基点 `32ad894d`・`1913625d` と、もとの候補 commit の本体（照合できていない）。

**持ち主の判断（未決のまま）**
6. 勝利条件、評価期間（戦期の口座）、報酬の配分、P-scout をどうするか（目撃を使った記録を足すか、目標をやめるか）、中央の倉・建物・通行に何かを与えるか。⑮は決めていない。

**未確認**
7. 動いているヘラルドと本物のチェーンからの読み取り。⑮が読んだのはすべて固定データ：④の chain flow（模擬の時計・確定・国）、④の runexec の demo（模擬の世界）、⑭の centreFacts の出力。
8. ⑭の `toFacts()` が `period.boundary` を渡さない件（⑭は今の形を続けると連絡済み）。
