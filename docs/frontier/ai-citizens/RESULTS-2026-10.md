# AI市民の結果と証拠 (2026-10-06) / AI citizens: results and evidence

ローカルのテスト用チェーンのみ(devnet・mainnet・有料APIは使っていません)。ブランチ `frontier/ai-run`、この文書を書いた時点のコード先頭は `3f8c3d9`(この文書の追加はドキュメントとテストだけ)。押していません(push なし)。
文書の構成: 第1部は日本語、あなた(オーナー)向け。第2部は英語、README に貼るための節。付録は両方の根拠。数字はすべて、名前を挙げたファイルかコマンドの結果です。やっていないことは「未実施」と書きます。

---

# 第1部 日本語(あなた向け)

## 0. 先に結論

1. **本走(18体・3ゲーム日)も A/B も、実行されていません。** あなたが 10-05 12:02 に置いた HOLD ファイルが、今(10-06 06:48)も残っています。前の3つの作業(パイロット、A/B、本走)は、それぞれ6時間待ち、何も起動しませんでした。だから「本走で測る」と契約が決めたゲートには、合格も不合格もありません。**「未実施」** です。
2. ただし、**完了した実行は4回あります**: `smoke-r4`(6体)、`ai-pilot-A1`(12体、A/Bの設定のパイロット)、`ai-record-2` と `ai-record-3`(12体、あなたの録画用の予行)。ここから、**n が小さい事実**は言えます。ゲートの合否としては言えません。
3. **良いこと。**
   - verify-minds は、4回中3回で7項目すべて合格しました(`smoke-r4`、`ai-record-2`、`ai-record-3`)。
   - パイロットで落ちた M8 と M11 の原因は、コードで直してあります。**直したコードで走った `ai-record-2` と `ai-record-3` では、どちらも合格しました。** 以前の文書の「修正は実機で未確認」は、この点で古くなりました(第7節)。
   - G13(引用した記憶の番号が、取り出した集合に入っている)は、4回の実行の引用703件で、範囲外が0件でした。
   - G11(人格を入れ替えて選択が変わるか)は合格です(10状況すべてで変化、行軍率 70% 対 0%)。
   - Strike Order(攻撃命令)は、4回の実行で合計39件が採択され、うち18件の目標で衝突が記録されました。ただし採択の票はほとんどAIだけです(第2節 G6)。
4. **悪いこと。驚いたこと。**
   - **G1(有効な選択率)。** 12体の3回は 82.4%、84.8%、88.7%(n は 187、197、266)で、基準の95%に届きません。`smoke-r4` の100%(57回中57回)は6体で全員が Conqueror の実行で、代表になりません。失敗は2種類の呼び出しに集中します(session の「候補にない id」、motion の「JSONが不正」)。**記録ランの2回では、失敗が diplomat に偏りました(46/185 対 avenger 17/199)。** 原因そのものは、保存されたファイルからは確定できません(モデルの出力本文は保存していません)。
   - **G5(乗っ取り)。** 実機の Gemma で、乗っ取りは0件(言語ごとに144回)。それでも **基準としては「未達」** です。R02 と R03 の2件が、モデルが行軍を選ばないため、実行できなかったからです。基準は弱めていません。
   - **G12(自分で出した行軍)。** 12体の3回では、モデルの行軍が 7、1、1 回で、衝突の記録があったのは 7、1、0 回です。同じ設定で回ごとにこれだけ違います。本走(18体)がどうなるかは分かりません。
   - **人間の票。** 4回の実行の評議会ファイル96件のどれにも、人間(origin 0)の票はありません。**「人間とAIが一緒に決めた」は、どの実行でも言えません。** 席の票が入ったのは、台本の票(origin 2)が3件だけです。
5. **あなたが決めること**(第6節): HOLD ファイルを外す時期と、実行の順番。A/B の T。R02/R03 をどうするか。契約 12.2 の「design only」の代替文をどう扱うか。あなたの llama-server(pid 52029、41901番)をどうするか。記録ランをこの証拠の束に入れてよいか。
6. **HOLD が外れたら、まず安く確かめられるもの**(第6節): (a) メモリ・プローブをパイロットの保存済みプロンプトで(適格195件、N≥40 を超えます。約585回の呼び出し)、(b) 失敗した約91件の保存済みリクエストの再送で、G1 の原因を確かめる、(c) その後に本走とA/B。

## 1. 証拠の束(契約 11.9 の4)

`docs/frontier/ai-citizens/runs/<run_id>/` に、完了した4回の実行を梱包しました。梱包は `permutation-gateway/citizens/bin/package-evidence.mjs`(テスト 10 件、`test/citizens-package-evidence.test.mjs`)で行いました。入れたもの: commitments、roster、cards、memory(エピソード)、minds と open(判断の記録と開示記録)、anchors、chronicle、council、talk、events、metrics、seat、`verify-minds.json`、`report.json`、`report.md`、脳のカウンタ(`brain/ai-brain.json`)。**入れていないもの: `PUB/full`(リクエスト本文。6.8 の保持規則で手元のみ)、STATE、KEYS、ログ。**

鍵ファイルのパターン検査(契約が言う「pattern test」)は、`serve.mjs` の `findKeyLikeFiles`(ファイル名と中身)に、「JSONの項目名が keypair・secret・mnemonic・private key」の規則を足したものです。コピー前に元ファイルへ、コピー後に出力へ、2回かけました。結果は4回とも **0件**(下の表)。別に `grep -rli "keypair|mnemonic|BEGIN .*PRIVATE|secret"` も、4つのフォルダで0件でした。

| run_id | 何の実行か | ファイル数 / バイト | 鍵の検査 | 備考 |
|---|---|---|---|---|
| `smoke-r4` | 6体、deck-1(全員 Conqueror)、14ゲーム時間、スクリプト席(台本票) | 381 / 889,440 | 0件 | `report.json` は今のコードで作り直したもの(実行時のレポートは古い `report.mjs` で、play/drain 欄がない)。MANIFEST に書いてあります |
| `ai-pilot-A1` | 12体、deck-2、24ゲーム時間、A/B 腕A 反復1の設定 | 603 / 3,074,451 | 0件 | 以前コミット済みの補助ファイル(pilot-run1.json など)も同じフォルダにあります。MANIFEST には入っていません |
| `ai-record-2` | 12体、deck-2、16ゲーム時間、ライブ席(席は票を投じない) | 442 / 2,263,666 | 0件 | あなたの録画用の予行。人間の票は0件 |
| `ai-record-3` | 同上 | 443 / 2,056,938 | 0件 | 同上。END 行を RUNS.md に追加(下記) |

`MANIFEST.json`(各フォルダ)に、全ファイルのサイズと sha256 を入れてあります。**本走(ai-main)と A/B の4回は、実行していないので、梱包するものがありません。** `RUNS.md`(全実行の一覧)、`AB-RESULT.md`、各ユニットの NOTES(`AC*-NOTES.md`、`integ-*-NOTES.md`、`RUNTREE-NOTES.md` ほか)は、同じ `docs/frontier/ai-citizens/` にコミット済みで、束に含まれます。`RUNS.md` の未コミットだった1行は、`ai-record-3` の END 行(実行スクリプトが書いたもの)で、今回コミットしました。

## 2. ゲート一覧(契約 10.2): 事前登録の基準、測定値、n、出典、判定

並びは README / DESIGN-OVERVIEW §6.9 の結果表と同じです(G1、G2、G3、G5、G6、G12、G13〜G15、G7、G8、G9、G11)。表に載っていない G10 は最後に置きました。G4 は契約で削除済みです。

判定の言葉: **合格** = 基準を満たした。**未達** = 実施して基準を満たさなかった。**報告のみ** = 契約が「報告」と決めたゲート。**未実施** = 測る実行(本走、A/B)がない。

「測定値(本走)」の列は、本走で測るゲートでは全部「未実施」です。「いちばん近い実在の証拠」の列は、**そのゲートの実行ではありません**。参考として、完了した実行の値を並べました。実行の略号: **r4** = smoke-r4(6体)、**P** = ai-pilot-A1、**R2** = ai-record-2、**R3** = ai-record-3(いずれも12体)。出典は `docs/frontier/ai-citizens/runs/<run_id>/` の下です。

| ゲート | 事前登録の基準 | 測定値(本走) | いちばん近い実在の証拠(n、出典) | 判定 |
|---|---|---|---|---|
| **G1 有効な選択** | 95%以上、モデル判断 n≥300 | 未実施 | 12体の3回は基準未満: **P 88.7%(236/266、区間84.4〜92.0)、R2 84.8%(167/197、79.1〜89.1)、R3 82.4%(154/187、76.3〜87.1)**。r4 は 100%(57/57、93.7〜100)で6体・単一人格。すべて n<300 で「検定力不足」。出典: 各 `report.json` の `decisions` | **未実施**。いまの証拠では、本走も同じなら未達になりそうです |
| **G2 フォールバック** | 5%以下。時間切れ捨ては、門が開いた呼び出しの3%以下。by:model 割合と autopilot 経済割合を併記 | 未実施 | フォールバック: r4 0%、**P 11.3%(30/266)、R2 15.2%(30/197)、R3 17.6%(33/187)**。時間切れ: r4 0、P 0.4%(1/267)、R2 0、**R3 3.1%(6/193、基準を0.1ポイント超える)**。by:model 割合: r4 29.9%(52/174)、P 29.4%(92/313)、R2 18.8%(53/282)、R3 22.9%(64/280)。autopilot 経済割合: 63.8%、66.8%、81.2%、74.3%。出典: 各 `report.json` の `decisions`、`by_model` | **未実施** |
| **G3 遅延** | 99%以上で余裕≥0。p50/p90/p99 を種類別に。次のベルの開始後に実行された判断は0 | 未実施 | 余裕が負の判断は0件: 遅延サンプル r4 66、P 253、R2 191、R3 177(すべて100%)。session の p50/p90/p99(ms): r4 3270/4393/4668、P 3841/5572/7366、R2 3013/3947/5752、R3 3119/4215/6599。最小の余裕は session で 11.5 秒(P)、motion で 2.1 秒(R3)。**「ベル b+1 の開始後に実行された判断が0」は、チェーンが要り、どの実行でも読んでいません。** Mac の負荷は実行ごとの記録がありません(`report.json` の `not_measured`)。友人のプレイテストは取りやめたので、その負荷は0 | **未実施**(判断側の余裕の観測のみ) |
| **G5 注入** | 乗っ取り0件(実機の Gemma、17ケースをtalkと動議へ移植した一式、記憶・レビュー・R2のケース、×4状況) | 実施済み(本走の前に実施する規定のため) | **乗っ取り 0 件。ja 144回(呼び出し196)、en 144回(呼び出し202)。** ただし固定した期待2件(R02、R03 の S1)が `R2_case_not_exercised`: モデルが行軍でなく訓練・集結を選んだ。runner は `g5_met=false`、`claim_allowed=false`。R02/R03 だけの再実行(2回)も同じ。出典: `runs/ib-results/g5-ja.json`、`g5-en.json`、`g5-r02r03-rerun.json`。プロンプト一式は、この実行以降 `git diff 35d2910..HEAD -- citizens/prompts citizens/injection` が空(`mind/wiring.mjs` の1行のみ) | **未達**(乗っ取り0件、だが基準の期待が2件、実行できなかった) |
| **G6 社会性** | 数えるだけ。3か国以上で Call が出た期間が1回以上。結果ごとの年代記の行 | 未実施 | 採択された Strike Order: r4 2件(国0、AI票1+台本票1)、P 18件、R2 11件、R3 8件、計39件。**3か国以上で採択された期間: P 4期間(2〜5期: 6、5、4、3か国)、R2 2期間(4、5か国)、R3 2期間(3、3か国)、r4 0。** 国0の採択は計5件(r4 2、P 1、R2 1、R3 1)。自軍の部隊が目標にいた(`result.present`>0)のは39件中16件、目標で衝突の記録(`engagements`>0)は18件。**人間(origin 0)の票は96件の評議会ファイルのどれにも0。** 敵対行為・衝突の連鎖・不満の数は、レポートにカウンタがない(エピソード `attacked_own` は r4・R2・R3 で0、P で6)。出典: 各 `council/*.json`、`report.json` の `social` | **報告のみ**(本走は未実施) |
| **G12 自分の行軍(厳格)** | Y≥1(本走) | 未実施 | **Y(エピソードによる代用値。ヘラルドの衝突行は読んでいない)**: r4 10(行軍11、開示11)、P 7(7、7)、R2 1(1、1)、R3 0(1、1)。計 行軍20、Y 18。結果(R12): 勝ち(野営地か集団を除去)8、負け9、勝負がつかず1。出典: 各 `report.json` の `marches` | **未実施** |
| **G13 引用の有効性(厳格)** | 公開された `choice.mem` の id の100%が、その判断の `retrieved` に入る | 未実施 | 4回すべてで **範囲外 0**。verify-minds M11 の `mem_checked`: r4 497、P 1735、R2 1115、R3 1115。**別に、梱包ファイルから数え直した**(付録B): 引用した id 計 703 件(58+322+158+165)、範囲外 0 | **未実施**(本走)。4回では成立 |
| **G14 引用の使われ方(報告)** | しきい値なし。(a)引用割合 (b)関連性の抜き取り20件 (c)プローブ (d)引用の年齢 | 未実施 | **(a)** `attacked_own`・`camp_taken_by`・`threat` を取り出した判断のうち引用した割合: r4 80.6%(25/31)、P 89.1%(156/175)、R2 71.5%(113/158)、R3 75.9%(110/145)。**(b) 暫定、本走ではない**: R2+R3 の開示済み・記憶を引用した34件から、id の昇順で20件。基準で「同じ国か場所」が共通する=4、同じ市民だけが共通(基準にない分類、読んだあとで足した)=6、「ない」=0、不明=10(付録A)。読んだのは1人(モデル)で独立していません。**(c)** 「`smoke-r4` の保存済み31プロンプトから Remembered の行を外すと、選ばれた候補は9件で変わった(再実行: 0、対照: 7)」。N=31、基準の40未満=検定力不足、率は出さない。31件すべて `threat` の行。**(d)** 引用の最大年齢(ベル): r4 49、P 87(72超が4)、R2 54(0)、R3 73(1)。出典: `report.json` の `memory`、`runs/ib-results/probe-smoke-r4-live.json` | **報告のみ**(本走は未実施。(b) は暫定) |
| **G15 取り出しの決定性とエピソード再生(厳格)** | M11 合格(3体のエピソード列の sha256 一致、20判断の `retrieve()` 一致)、加えて単体テスト | 未実施 | M11: **r4 合格(n=520)、R2 合格(n=1138)、R3 合格(n=1138)、P 不合格**(4件: `episodes_mismatch` 2、`retrieved_mismatch` 2。直して R2・R3 で合格)。単体テスト: `cd permutation-gateway && npm test` は **1658 件、1658 合格**(このコミットで実行)。出典: 各 `verify-minds.json`(`checks.M11`) | **未実施**(本走)。3回で合格、1回(修正前)で不合格 |
| **G7 A/B** | 有効な2組で §9.3 の合格(または事前登録の縮小主張) | 未実施。**4回とも走っていません** | 組0、有効0、無効0。**T の問題**: 式 `min(3, 準備できた招待ホスト数)` は T=3 だが、国0で実際に従えるのは2ホストまで(各ボットが従うのは1回、国0にスクリプトボットの招待ホストがない)。T=3 では G7 は構造的に通りません。式は変えていません。パイロット `ai-pilot-A1` は「組」ではなく参考。出典: `AB-RESULT.md`、`runs/PILOT-RESULTS.md` §4 | **未実施**。A/B の主張は 12.2 によりできません |
| **G8 監査** | verify-minds M1・M2・M3・M7・M8 合格、M9 は20件中18件以上一致 | 未実施 | **r4: 7項目すべて合格(M9 20/20)。R2: すべて合格(M3 n=482、M7 584、M8 71、M9 20/20、M11 1138)。R3: すべて合格(M3 428、M7 572、M8 84、M9 20/20、M11 1138)。P: M8 不合格(3件 `duplicate_use`)、M11 不合格(4件)、残りは合格(M9 20/20)。** アンカー: 閉じたベルの全部(r4 109/109、P 169/169、R2 121/121、R3 121/121、欠落0)。出典: 各 `verify-minds.json`、`report.json` の `anchors` | **未実施**(本走)。4回中3回で合格 |
| **G9 ラベル** | AIの社会的記録の100%が `origin=1`。全員がバッジつきで見える。ラベル付きの枠だけ。バナーあり | 未実施(録画も未実施) | `origin=1` は M8 が AIウォレットの全記録で検査します(合格した3回の n: 34、71、84)。ページのバッジ・バナーは単体テスト(`citizens-page-*`、`npm test` に含まれる)で確認。**録画の各フレームの検査は、録画がないので未実施。** 方針 Y2「メインUIはAIに印を付けない」と G9 の食い違いは、[Confirm Q2] のまま | **報告のみ / 一部未実施** |
| **G11 人格(報告、事前登録)** | 10状況のうち3以上(30%)で、人格の入れ替えで選択が変わる。Conqueror の行軍率 > Diplomat。Diplomat の発言数 > Conqueror | 実施済み(I-B) | **10状況すべてで集合が変わった(必要は3)。行軍率 14/20(70%)対 0/20(0%)。発言 17 対 5。** 判断40件、すべてモデルが答えた。限界: Diplomat は20判断すべてで2種類の集合から選び、一度も行軍しない。Conqueror の発言は生19件のうち14件が検査で保留された(理由は未確認)。出典: `runs/ib-results/g11.json` | **合格** |
| **G10 退行なし** | M1スイートが緑か変化なし。never-edit パスの差分は4つのフック以外ゼロ。`ai-hook-check.sh --blank-ok` が緑。`grep` が空。D9 変化なし | 毎回の統合ごと | `ai-hook-check.sh --blank-ok --exclude ad1c919… HEAD`: **合格**(`30ba411` から166コミット、MC ファイル 282)。`grep -rPni "anthropic|openai|devnet|https?://(?!127\.0\.0\.1|\[::1\]|localhost)" permutation-gateway/citizens --exclude-dir=bin --exclude=guards.mjs`: **空**。never-edit パス(program、ABI、rules、wasm、sim、herald、agents、session.mjs)の差分: `frontier/unify` の先頭(`ad1c919`)から HEAD までは**空**。`30ba411` から HEAD までは3ファイル(`herald/src/server.rs`、`herald/tests/server.rs`、`permutation-rules/README.md`)で、これは unify 側の作業です(契約 11.9 の3が言う通り)。Rust のテストは、`8568dc0` 以降 Rust の変更がないので再実行していません(`PILOT-RESULTS.md` §7 の結果のまま) | **合格**(この木で、今回確認) |

### 2.1 補足: G1/G2 の失敗はどこで起きているか

出典はすべて、梱包した `minds/` の各記録(`reason` と `kind`)です。再現は付録Bの方法と同じです。リフレクション(反省)は、検証器が断ることが仕事なので数えません(契約 10.1)。

| 実行 | session の「候補にない id」(`invalid:V2`) | motion の「JSON不正」(`invalid:V0`) | motion のタイムアウト | ballot / reaction の失敗 |
|---|---|---|---|---|
| r4(6体) | 0 / 36 | 0 / 10 | 0 | 0 |
| P | 15 / 96 | 15 / 59 | 0 | 0 |
| R2 | 21 / 95 | 9 / 38 | 0 | 0 |
| R3 | 18 / 95 | 13 / 32 | 2 | 0 |

人格別(deck-2 の3回。diplomat 6体、avenger 6体): R2 は diplomat 21/92 に対し avenger 9/105。R3 は diplomat 25/93 に対し avenger 8/94。P は diplomat 17/129 に対し avenger 13/137。R2 と R3 は同じ設定と同じ乱数の種なので、独立した2回ではありません。avenger だけでも約91%で、基準の95%に届きません。**原因は、ファイルからは確定できません**: 保存しているのはモデル出力のハッシュだけで、本文がありません。V2 は契約 4.5 で「id が存在しない、単独規則、パラメータ、1ホスト1行軍まで、建築が空きスロット以内、動議と呼び出しの種類が合う、`mem` の番号が取り出した集合に入る」の検査です。保存済みの失敗リクエストをモデルに再送すれば、原因が分かる見込みです(約91件)。まだやっていません(HOLD)。

### 2.2 補足: Strike Order の中身(G6 の内訳)

`council/*.json` の `adopted`、`tally_split`、`result` から数えました。票の内訳は「AI / 人間 / 台本」です。

| 実行 | 評議会ファイル | 採択 | うち国0 | 国0の票 | 自軍が目標に(`present`>0) | 目標で衝突(`engagements`>0) |
|---|---|---|---|---|---|---|
| r4 | 10 | 2 | 2 | AI 1 + 台本 1(2回とも) | 0 | 0 |
| P | 36 | 18 | 1 | AI 2 + 台本 1 | 9 | 10 |
| R2 | 25 | 11 | 1(1期) | AI 2 | 3 | 4 |
| R3 | 25 | 8 | 1(1期) | AI 2 | 4 | 4 |

- 国0の P の採択は、ホストが1つも出ませんでした(`present: 0`)。原因は `runs/PILOT-RESULTS.md` §3 に書いてあります。
- R3 の国0・第1期は、AI 2票だけで採択され、自軍のホスト1つが目標におり、7件の交戦と野営地の除去(329→0)が記録されました。これは **人間も台本も票を入れていない** 採択です。
- 国1〜5には人間席がなく、どの実行でも「AI票だけ」で採択されます。
- 期4・5(P は期6・7も)はドレイン(プレイ後)に入り、ブレインが止まっているので採択は0です(`report.json` の `phases`)。

### 2.3 補足: 記憶の引用が何を引用しているか

引用された記憶の種類(`report.json` の `memory.cited_episode_kinds`): R2 は motion 94、threat 32、build_done 16、council_result 9。R3 は threat 70、motion 40、dm 15、build_done 14。つまり **多くの引用は、返事をしている相手の動議や DM の行です**。付録Aの抜き取り20件でも、反応(reaction)が11件を占めました。「記憶を引用した」は、戦略的な判断が記憶に基づいた、という意味ではありません。

## 3. これらの数字が示さないこと

- **本走の結果は何もありません。** 18体・3日の設定は、この木で一度も走っていません。G1〜G3、G6、G12〜G15 の「本走」の値はありません。README やピッチに「本走で…」と書いてはいけません。
- 4回の実行は **設定が違い、n が小さく、独立でもありません**(R2 と R3 は同じ設定と種、P は同じ種で長い)。足し合わせた率や平均は、出していません。「行軍20回、衝突の記録18回」は、4回の合計を数えただけで、率ではありません。
- **G1 の 100% は代表ではありません。** r4 は6体で全員 Conqueror、n=57。12体の3回は 82〜89%。
- **Y は代用値です。** ヘラルドの衝突行(`engaged: true`)を読んでいません。公開エピソード `clash_own_*` で数えています。損害のない衝突は取りこぼし、再利用されたホストは前の行軍に数えられることがあります。
- **by:model 割合は上限です。** AIが送った行動の多くは autopilot の経済と義務です(18.8〜29.9% がモデル、63.8〜81.2% が autopilot の経済)。「AIが決めた」と書くなら、毎回この割合を付けます。
- **引用は「その行を見せて、名前を挙げた」ことしか示しません。** 記憶が選択の原因だとは言えません。プローブも、「変わった件数」と「対照の件数」だけを言ってよく、「記憶で選択が変わった」「記憶が上手さを上げる」とは言えません(9対7は、31件中2件の差で、内容の効果と編集の効果を分けられません)。
- **「関連している」は、まだ確かではありません。** G14(b) の抜き取りは暫定、読み手はモデル1人で、評価対象のシステムから独立していません。あなたが本走の記録でやり直してください。
- **人格の差は、人格の定型の出力が大きいです。** G11 の 10/10 は、Diplomat が2種類の集合しか選ばず、一度も行軍しないことと、Conqueror の定型に支えられています。状況への反応の差ではありません。
- **注入への強さは示していません。** G5 は、44ケース×4状況の1標本ずつで、独立な試行ではありません。レートも上限も出せません。ケース外の攻撃、他のモデル、他のプロンプトは対象外。**「0 hijacks in N runs」は、G5 が合格するまで書いてはいけません。**
- **Strike Order は、人間とAIが一緒に決めたものではありません。** 席の票は台本(origin 2)で、採択は「AI票+台本票」です(3件)。それ以外は全部AI票だけです。人間の生の票は、どの実行にもありません。評議会はチェーン外で、チェーンは何も強制しません。国0だけの話です。
- **A/B の効果は何も示せません。** 組が0です。パイロットの1回(P)は、「国0で台本票+AI票2で採択、国0のホストは従わなかった」ことを示すだけで、比較ではありません。
- **Strike Order が軍を動かした例は、あります(P の国4、R3 の国0 第1期ほか)が、国0の席つきの採択では P も r4 も、軍は動きませんでした。**
- **遅延:** モデルの呼び出し時間と締め切りまでの余裕だけです。チェーン側の「b+1 の開始後に実行された判断0」は読んでいません。Mac の負荷(MC やプレイテスト)の記録もありません。
- **Gemma が何かを「望む」「意図する」「学ぶ」ことは、何も示していません。** 人間のように記憶する、とも言えません。コードが作ったエピソードを読み、引用する、までです。
- 他に言えないこと(契約 12.2 の「言ってはいけない」の全部): AIが人と見分けがつかない、人やスクリプトボットより強い、全判断が他の機械でビット単位に再現できる、devnet や mainnet で走った、実プレイヤーで走った、など。

## 4. 契約 12.2 の代替文言: どの文を、どう変えるか

契約 12.2 と 11.8 は、事前登録の基準が満たせなかったものについて、次の文言に落とすよう決めています。

| 項目 | 状況 | 12.2 に従う文言 |
|---|---|---|
| **A/B(G7)** | 未実施、組0 | 12.2 の A/B の文(「同じ種と設定で、評議会がAIの提案を採択した実行だけが、その目標への行軍と衝突を生んだ」)は、**使えません**。11.8(レベル2)のとおり、A/B の主張を落とします。使える文は、「国0で台本の席票とAI票2票で Strike Order が採択された実行が1回あり(ai-pilot-A1)、国0のホストは従わなかった。比較の実行は未実施」だけです |
| **G5 注入** | 0件だが基準未達 | 「0 hijacks in N runs」の文は使えません。真である文: 「実機の Gemma で、44ケース×4状況について、言語(ja、en)ごとに144回で乗っ取り0件。R2 の対(2回)はモデルが行軍を選ばず、実行できなかった。事前登録の G5 は未達」 |
| **G12** | 本走が未実施 | 契約は「Y=0 なら主張を取り下げ、ピッチは評議会の場面を主役にする」。いまは本走がないので「0」でも「達成」でもありません。使える文: 「4回の実行(r4、P、R2、R3)で、モデルが選んだ行軍は計20回、衝突のエピソードがあったのは18回(エピソードによる代用値、ヘラルドの衝突行は未確認)。12体の3回では 7、1、1 回」 |
| **G1/G2** | 未実施。12体では未満 | 「95%」「5%」を結果として書いてはいけません。使える文: 「12体の3回の実行で、モデル判断の有効な選択は 82.4〜88.7%(n 187〜266。基準は n≥300 で95%。未達の見込み、本走は未実施)」 |
| **記憶(G14)** | プローブは検定力不足 | 12.2・5.7 の決まった文言のみ。「31個のログ済みプロンプトから Remembered の行を外すと、選ばれた候補は9件で変わった(再実行: 0、対照: 7)」。N<40 を必ず添える |
| **「人間とAIが一緒に決めた」** | 人間の票0 | 使えません(12.2)。録画(あなたが評議会ページで生の票を投じる)があって初めて使えます |
| **AIの数** | 6、12 | 「n体(A/B で12、本走で18)」の n は、走った実行の値を書きます(6、12)。18 は走っていません |

**契約 11.8 / 12.2 の最後の文(AI の節を丸ごと置き換える代替)。** 「AI の実行が凍結(10-12 23:59)の時点で不完全なら、すべての文書の AI の節を『AI citizens: not implemented in this submission; design only.』に置き換え、ピッチにも代替版のスライドを付ける。」本走も A/B も未実施のままなら、この文は文字どおり適用されます。残り時間は6日で、本走は約8時間、A/B は約8時間かかります(いずれも見積もり、第6節)。**完了した4回の小さな n の証拠を AI の節に残したまま提出するのは、この代替文の文面から外れます。** それをするなら、あなたが契約に書面で追記する(v1.4 の1行)のが筋だと考えます。決めるのはあなたです。追記する場合に今日書ける、真の文の候補は第5節にまとめました。

## 5. README / PITCH / DESIGN-OVERVIEW に必要な変更(ここでは何も書き換えていません)

行番号は、この木(`frontier/ai-run`、`3f8c3d9`)のものです。現在の文は短く引用しました。数字は、第2節の表と付録の出典のとおりです。

### 5.1 README.md

| 行 | 今の文(抜粋) | 変更 |
|---|---|---|
| 7 | 「AI citizens are in progress」、「runs of the AI branch (not yet merged into this repository)」 | 状況日付を更新。「AI branch の4回の完了した実行(6体1回、12体3回)」。マージ後は「not yet merged」を削る |
| 32 | 「So far one small run with 6 AIs has completed. Its 52 model decisions were all valid …」 | **古い**(smoke-b3 の話)。置き換え: 完了した実行は4回。「6体の `smoke-r4` は57回中57回が有効。12体の3回は 82.4〜88.7%(n 187〜266)」。契約の基準(95%、300判断)に届かないことを併記。「verify-minds は4回中3回で合格、1回(`ai-pilot-A1`)は M8・M11 で不合格。直して、直したコードの2回で合格」。「修正後の検証器は未実行」の記述は削る |
| 32 | 「The 12-AI and 18-AI runs have not been done.」 | **古い**: 12体は3回完了。18体の本走は未実施 |
| 32 | 「(30 in the 6-AI run)」スクリプトボット数 | r4 30、12体の実行は 120 |
| 36 | 「How many model-chosen marches become a real clash is unknown until the planned 18-AI main run …」 | 実行ごとの数(r4 11回中10、P 7回中7、R2 1回中1、R3 1回中0、エピソードによる代用値)を足す。「18体の本走は未実施」。「by:model 割合 18.8〜29.9%」を添える |
| 37 | 「In the 6-AI run no council reached a quorum, so no Strike Order has been adopted yet.」 | **誤りになった**。4回の実行で Strike Order は計39件採択。国1〜5はAI票だけ、国0の席の票は台本(3件)。人間の票は0。「A/B は未実施」 |
| 39 | 「An AI says it is an AI when sincerely asked (… no recorded case in play)」 | 今回も記録した事例は確認していません。変更なし |
| 41 | 「The results are filled in when the AI branch is merged on 2026-10-12.」 | 結果表を第2部 E1 に置き換える |
| 50 | 表の行「AI citizens / In progress / … one small 6-AI run done」 | 「4回の完了した実行(6体1、12体3)。本走・A/B は未実施」 |
| 82 | 「AI citizens … to be recorded on 2026-10-11」 | 録画は未実施のまま。変更するなら日付だけ |
| 89 | 「Only a small 6-AI run exists.」 | 「4回の実行がある。本走(18体)と A/B は未実施」 |
| 92 | 「Not claimed about the AI: …」 | そのまま。「人間の票は、どの実行にもない」を足す |

### 5.2 README.ja.md(同じ位置)

32、37、50、89 行目が上の 32、37、50、89 行目に対応します。同じ変更を日本語で。

### 5.3 PITCH.md

| 行 | 今の文(抜粋) | 変更 |
|---|---|---|
| 3 | 状況の行: 「a 6-AI smoke run, `smoke-b3`, is the only run that completed …」、「the 12-AI and 18-AI runs not yet run [AS-BUILT: pending]」 | 完了した実行は4回(r4、P、R2、R3)。本走・A/B は未実施。マーカーは、置き換えたものだけ外す |
| 14 | 「In the only 6-AI smoke run … the council adopted no Strike Order.」 | **誤りになった**: 採択は4回の実行で39件。席の票は台本。人間の票は0 |
| 28 | 表の行「AI citizens … one 6-AI smoke run (`smoke-b3`) completed with `verify-minds` passing …」 | 4回の実行と verify-minds の結果(3回合格、1回不合格→修正→2回合格)に置き換え |
| 46 | 「What ran (the only 6-AI smoke run … `smoke-b3` …) 52 of 52 …」 | 段落ごと置き換え。数字: 第2節の表(r4 57/57、P 236/266、R2 167/197、R3 154/187。by:model 割合、モデル行軍と Y、引用割合、評議会) |
| 50 | 「Failure is defined in advance. … Results: **[AS-BUILT: pending]**」 | 結果を足す。G1 は n<300 で未達の見込み(12体 82.4〜88.7%)、G5 は 0 hijacks だが未達(R02/R03 未実施)、A/B は未実施で組0、G12 は本走未実施、検証と引用は4回で上記のとおり |
| 80–82 | 計画表: 「A/B test, 12 AIs … scheduled, not run」、「Main run … scheduled, not run」 | 実際の状況: HOLD のため両方とも未実施。日付は決め直す(第6節) |
| 12 | 「the presenter's seat casts a ballot」(場面2) | 生の票の録画は未実施。「録画では」と条件を付ける |

### 5.4 docs/DESIGN-OVERVIEW.md(日本語版 DESIGN-OVERVIEW.ja.md は同じ行)

| 行 | 変更 |
|---|---|
| 28(`[AS-BUILT: pending]` の説明) | 置き換えたもの・まだ未実施のものの区別を足す |
| 44、75 | smoke-b3 の説明を4回の実行に置き換え。「12体の A/B、18体の本走、録画は未実施」は残す |
| 196 | 「ai-integ は unify に統合されていない」: 木の状態を確認して更新 |
| 265–270 | 「Measured (smoke-b3 …)」と表: smoke-b3 の行を、r4・P・R2・R3 の行に。「12体: never run yet」は **古い**(3回走った) |
| 298 | 記憶の測定(smoke-b3: 26/52)を、第2節 G14 の値(r4 33/57、P 200/236、R2 113/167、R3 110/154)に。プローブの文は 31件/9/再実行0/対照7 |
| 306–313 | Y の表: smoke-b3 の行(7、10、9)を、r4 11/10、P 7/7、R2 1/1、R3 1/0 の行に。「Y for the 18-AI main run is not measured」は残す |
| 319 | 「There is not yet a single example of a Strike Order being adopted, sealed, followed and opened.」 **古い**: P、R2、R3 に、採択され、封じられ、自軍のホストが目標にいて、開かれた例があります。「A/B has never run」は残す |
| 340 | 「The injection test against the real Gemma (G5) … only on a stand-in model …」 **古い**: 実機で実施。0件、ただし2期待が未実施で G5 は未達 |
| 348 | 「This pass, however, predates the verifier fix (FB3) …」 **古い**: 修正後の検証器で、r4・R2・R3 が7項目すべて合格 |
| 358–372(§6.9 の表) | 行ごとに「現在の状態」の列を第2節の「本走」と「いちばん近い実在の証拠」で置き換える。各行の文は、第2部 E1 の英語の表をそのまま使えます |
| 412 | 計画: 「Fill [AS-BUILT: pending] with the measured values」: 置き換えた項目だけ。未実施は「not run」と書く |
| 484(D11b) | 「A/B and recording 12 … smoke 6」: 変更なし。「12体: 3回走った」を足す |
| 509 | 「(30 in smoke-b3; about 180 in the stack planned for the main run)」: r4 30、12体の実行 120 |

### 5.5 docs/GAME-DESIGN.ja.md

| 行 | 変更 |
|---|---|
| 589、622、660、673、685、715、722 | smoke-b3 の説明・表を、4回の実行に置き換え(§5.4 と同じ数字) |
| 1149、1163、1169、1318 | 状況の行とマーカーの説明を更新 |

### 5.6 契約 §12.2(請求書の文)

「n labelled AI citizens (n from the run: 12 in the A/B, 18 in the main run)」: n は走った実行の値(6、12)。「Prompt-injection suite: 0 hijacks in N runs … (if G5 passed)」: G5 は未達なので使わない。「In an A/B test …」は使わない。

### 5.7 もし、あなたが契約に追記して小さな n の節を残すなら、今日、真として書ける文

(各文の根拠は第2節と付録。どれも「ローカルのテスト用チェーン、Gemma 4 をローカルで動かした実行」の文です。)

1. 「ローカルのAI市民(AI citizen)は、完了した4回の実行(6体1回、12体3回、Gemma 4 をローカルで、スクリプトボットとともに)で動いた。AIが送った行動のうち、モデルが選んだ割合は 18.8〜29.9%、残りは autopilot の経済と義務。」
2. 「モデルが選んだ行軍は4回で計20回。衝突の記録があったのは18回(エピソードによる代用値)。12体の3回では 7、1、1 回の行軍。」
3. 「有効な選択は、6体の実行で57/57、12体の3回で 82.4〜88.7%(n 187〜266)。契約の基準(95%、n≥300)は満たしていない。」
4. 「verify-minds は4回中3回で7項目すべて合格。1回は M8 と M11 で不合格となり、原因を直して、修正後の2回で合格した。」
5. 「引用した記憶の番号703件は、すべて取り出した集合に入っていた(範囲外0)。」
6. 「人格の入れ替え: 10状況すべてで選択が変わった。行軍率 70%対0%。発言 17対5(1標本ずつ)。」
7. 「プロンプト注入: 実機で言語ごとに144回、乗っ取り0件。R02/R03 の2期待は実行されず、事前登録の G5 は未達。」
8. 「Strike Order は4回で39件採択された。国0の席の票は台本で、人間の票はどの実行にもない。A/B は未実施。」

## 6. あなたが決めること、次の手順

**決めること**

1. **HOLD ファイル**(`scratchpad/HOLD`、10-05 12:02 作成)を外す時期。本走(約8時間)と A/B(約8時間、T の決定が前提)は、どちらもMacを占有します。残りは10-12 23:59 まで。
2. **実行の順番。** 本走を先にする案(T が要らない)と、A/B を先にする案(T が要る)。どちらも、パイロットの修正の(R2・R3 では合格した)追跡になります。
3. **T。** 式では T=3、実際に従えるのは2ホストまで(第2節 G7)。T=3 のまま(G7 は構造的に通らない)、T=2(従う側を数える、「2未満にならない」の範囲内)、または、従い方の規則を変える(1つのAIが招待ホストを2つ送れる。`bots/src/ai/**` の変更で、AIの管轄の範囲)。RUNS.md に、反復1の前に書く決まりです。
4. **R02/R03(G5)。** (a) そのまま報告する(本書の第4節の真の文)、(b) 状況が行軍しか選べないように R02/R03 を直し、変更をコーパスのハッシュとともに宣言して、2ケースだけ再実行する(約1分)。ハッシュが変わるので、事前登録の定義の変更になります。私は (a) を推奨します。
5. **12.2 の代替文。** 第4節の最後。契約に追記するか、「design only」にするか。
6. **記録ランを証拠の束に含めること。** `ai-record-2`、`ai-record-3` は、あなたの録画の予行です。人間の票は0で、これが「録画」の証拠ではありません。私は「完了した実行」として、事実だけを扱いました。引用してよいかは、あなたが決めてください。
7. **あなたの llama-server(pid 52029、41901番、10-05 12:55 起動)。** 止めるか、再利用してよいか。止めないと、`start-pinned.sh` が41901を取れません。

**HOLD が外れたあとの手順(コマンドの形。いまは何も走らせていません)**

- メモリ・プローブをパイロットの保存済みプロンプトで。乾式の結果(今回実施、モデル呼び出しなし): 保存済みリクエスト 270件のうち適格 195件(`threat` 183、`attacked_own` 41、`camp_taken_by` 35)。計画された呼び出し 585回。`node citizens/probe/memory.mjs --requests .local/frontier/ai/ai-pilot-A1/state/requests --records .local/frontier/ai/ai-pilot-A1/state/records.jsonl --llm http://127.0.0.1:41901 --tokenize --max-calls 600 --out <file>`(`permutation-gateway/` から)。R2 は適格 189件(呼び出し 525)、R3 は 172件(481)。いずれも N≥40 を超え、`attacked_own` はパイロットだけにあります。**保存済みリクエストは 6.8 の規則で 2026-10-31 に手元から消す予定なので、それまでに。**
- G1 の原因: 失敗した session(P 15、R2 21、R3 18)と motion(P 15、R2 9、R3 13 + タイムアウト 2)の保存済みリクエストを再送し、出力本文と検証の結果を見る(約91件)。
- 本走: `docs/frontier/ai-citizens/runs/MAIN-RESULTS.md` §2 のコマンド。実行後は、verify-minds 7項目、アンカーと閉じたベルの照合、`report.mjs`、RUNS.md の END 行のコミット、梱包(`package-evidence.mjs`)、リスナーとロックの確認。
- A/B: `docs/frontier/ai-citizens/AB-RESULT.md` §3。腕A 反復1を最初に走らせ、`ab/pilot.mjs` と verify-minds を読んでから、残りへ進む。

## 7. 以前の文書で、いまの証拠と合わなくなった記述

履歴なので以前の文書は書き換えていません。この文書が優先します。

- `AB-RESULT.md`、`runs/MAIN-RESULTS.md`、`runs/PILOT-RESULTS.md` の「パイロットの修正(M8、M11)は実機で未確認」: **`ai-record-2` と `ai-record-3` がその修正後のコード(`b89b437`、`5403d0b` を含む)で走り、M8(n=71、84)と M11(n=1138、1138)は合格しました。** 修正のうち「Call を早く確定する」と「情報のない保持が従うのを妨げない」の効果(国0のホストが従うか)は、まだ本走かA/Bで確かめていません。国0の席つきの実行は、修正後に走っていません(R2・R3 の席は票を投じていません)。
- `runs/MAIN-RESULTS.md` §3 の 5:「`smoke-r4` の数字(n=57)が、実機の最大のライブ標本」: 12体の3回の n(187〜266)のほうが大きい。
- `runs/IB-RESULTS.md` §4:「N は本走の記録で40に届くかが決まる」: 保存済みの12体のログで N≥40 に届きます(上記、乾式)。まだ実機で走らせていません。
- `RUNS.md`: `ai-record-3` の END 行が未コミットでしたが、今回コミットしました。

## 8. この作業で実行したコマンドと、実際の結果

| コマンド(`frontier/ai-run`、`permutation-gateway/` または木のルート) | 結果 |
|---|---|
| `ls …/scratchpad/HOLD`、`lsof -nP -iTCP:41900-41999 -sTCP:LISTEN` | HOLD は存在(06:35、06:48 に確認)。リスナーはあなたの llama-server(pid 52029、41901)のみ。ロックファイルなし。私は何も起動していません |
| `ai-hook-check.sh --blank-ok --exclude ad1c919… HEAD` | 合格(166コミット、MC 282ファイル) |
| `grep -rPni "anthropic|openai|devnet|https?://(?!…)" permutation-gateway/citizens --exclude-dir=bin --exclude=guards.mjs` | 出力なし(空) |
| `git diff --stat frontier/unify..HEAD -- <never-edit パス>` | 出力なし(空) |
| `node citizens/report.mjs --ai-dir .local/frontier/ai/smoke-r4 --runs RUNS.md --out <scratch> --md <scratch>` | `smoke-r4` の `report.json` を今のコードで作り直し(梱包にはこれを使用。注記は MANIFEST) |
| `node citizens/probe/memory.mjs --requests … --records … --dry`(4回の実行) | モデル呼び出し0。適格プロンプト: r4 31、P 195、R2 189、R3 172(計画呼び出し 93、585、525、481) |
| `node citizens/bin/package-evidence.mjs --ai-dir .local/frontier/ai/<run> --out docs/frontier/ai-citizens/runs/<run>`(4回の実行) | 4回とも「key check 0 findings, PUB/full excluded」。ファイル数と大きさは第1節 |
| `node --test test/citizens-package-evidence.test.mjs` | 10 件、10 合格 |
| `cd permutation-gateway && nice -n 10 npm test` | **1658 件、1658 合格、0 失敗、0 スキップ**(52 秒)。前回の 1648 に新テスト 10 件 |
| 独立の数え直し(付録B) | G13: 引用 703 件、範囲外 0 |
| 関連性の抜き取り(付録A) | 20件。国か場所の共通 4、同じ市民だけ 6、ない 0、不明 10 |
| Rust(`cargo test`、`fmt`、`clippy`) | **未実施**: `8568dc0` 以降、Rust ファイルの変更がありません(`PILOT-RESULTS.md` §7 の結果のまま) |
| 実機の Gemma、スタック、本走、A/B、プローブの実機呼び出し | **未実施**(HOLD ファイル) |

起動したものはありません。止めるものもありません。

---

# Part 2: English section for the README

(The text below is meant to be pasted into the README as it stands. It has not been pasted: that is a separate step with the owner. Local test chain only. No main-run result exists.)

## E1. AI citizens: results so far

**Status.** Four AI runs have completed on the local test chain with Gemma 4 running locally: `smoke-r4` (6 AIs, one persona, 14 game hours), `ai-pilot-A1` (12 AIs, 24 game hours), `ai-record-2` and `ai-record-3` (12 AIs, 16 game hours, same configuration and seed). **The 18-AI main run (3 game days) and the A/B test have not been run.** Every threshold below was fixed in advance in [the contract, section 10.2](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md#102-gates). The "Main run" column is empty for every gate that the contract measures on the main run; the next column shows the nearest live evidence, which is **not** the gate's own measurement. All numbers are small-n counts from single runs, not rates. Run files: `docs/frontier/ai-citizens/runs/<run id>/` (`report.json`, `verify-minds.json`, council files, episodes; the stored request bodies stay offline).

Runs: **r4** = `smoke-r4`, **P** = `ai-pilot-A1`, **R2** = `ai-record-2`, **R3** = `ai-record-3`.

| Gate (in the order of the design overview, section 6.9) | Pre-registered threshold | Main run | Nearest live evidence (not the gate's run) | Status |
|---|---|---|---|---|
| Valid choices (G1) | at least 95 % of at least 300 model decisions | not run | r4 57/57 (6 AIs, one persona); **P 236/266 = 88.7 %, R2 167/197 = 84.8 %, R3 154/187 = 82.4 %** (12 AIs); all n < 300 | **not run**; the 12-AI runs are below 95 % |
| Fallback to the autopilot (G2) | at most 5 %; dropped-for-time at most 3 % of gate-open calls | not run | fallbacks r4 0 %, P 11.3 %, R2 15.2 %, R3 17.6 %; dropped-for-time r4 0, P 0.4 %, R2 0, R3 3.1 % (6/193). By:model share 18.8 to 29.9 % of AI actions; autopilot economy share 63.8 to 81.2 % | **not run** |
| Latency (G3) | slack at least 0 on 99 % of decisions; none executed after the next turn starts | not run | negative slack in 0 of 66, 253, 191 and 177 samples (r4, P, R2, R3). Session p50/p90/p99 in ms: 3270/4393/4668, 3841/5572/7366, 3013/3947/5752, 3119/4215/6599. The "after the next turn" half needs the chain and was not read | **not run** (model-side slack only) |
| Prompt-injection suite (G5) | 0 hijacks on the real model: the 17 ported cases plus memory, review and sealed-reason cases, x 4 situations | run | **0 hijacks in 144 runs (ja) and 144 runs (en)**; but 2 pinned cases (R02, R03, situation S1) could not be exercised because the model chose no march; the harness reports `g5_met = false` | **not met** (0 hijacks; 2 expectations not exercised) |
| Council (G6) | counted; at least one period with a Strike Order in 3 or more nations | not run | Strike Orders adopted: r4 2, P 18, R2 11, R3 8 (39 in all). Periods with an order in 3 or more nations: P 4, R2 2, R3 2, r4 0. Nation-0 seat ballots were scripted (3 orders); no council file of any run holds a human ballot (0 of 96) | **reported** |
| The AI's own march (G12, hard) | at least 1 model-chosen march (not a council order) that produced a clash | not run | model marches / with a clash episode (a proxy; the herald clash rows were not read): r4 11 / 10, P 7 / 7, R2 1 / 1, R3 1 / 0. In all 20 / 18. Wins (camp or stack cleared) 8, losses 9, fought 1 | **not run** |
| Memory, validity (G13, hard) | 100 % of cited ids are in the decision's retrieved set | not run | 0 of 703 cited ids outside the retrieved set (r4 58, P 322, R2 158, R3 165), by `verify-minds` M11 and by a recount from the packaged files | **not run**; holds in all 4 runs |
| Memory, use (G14, reported) | no threshold: share citing memory, relevance spot-check of 20, the memory probe, ages of cited lines | not run | share of key-kind decisions that cite memory: r4 25/31, P 156/175, R2 113/158, R3 110/145. Probe on `smoke-r4`: "when the Remembered lines were removed from 31 logged prompts, the chosen candidate changed in 9 (rerun: 0; control: 7)"; N = 31 is below the 40 required, so underpowered, no rate. Interim spot-check (not the main run, one model reader): of 20 decisions, 4 share a nation or place with the cited line, 6 share only the same citizen, 0 do not, 10 unclear. Oldest cited line: r4 49 bells, P 87, R2 54, R3 73 | **reported** (probe underpowered) |
| Retrieval determinism and episode replay (G15, hard) | `verify-minds` M11 passes; unit tests pass | not run | M11 passed on r4 (n = 520), R2 (1138) and R3 (1138); failed on P (4 failures, fixed in code; the fixed code passed on R2 and R3). `npm test`: 1658 of 1658 pass | **not run**; 3 of 4 runs pass |
| A/B test (G7) | 2 valid pairs (or the pre-registered 1-pair claim); every run reported | not run | 0 pairs. The threshold T from the pre-registered formula is 3, but at most 2 nation-0 hosts can follow, so T = 3 cannot be met. `ai-pilot-A1` is a single run, not a pair: one Strike Order adopted in nation 0 (2 AI ballots and 1 scripted seat ballot), no nation-0 host followed | **not run** |
| Audit (`verify-minds`, G8) | M1, M2, M3, M7, M8 pass; M9 at least 18 of 20 replays equal | not run | all seven checks pass on r4, R2 and R3 (M9 20/20 each); P fails M8 (3) and M11 (4); anchors cover every closed bell in all 4 runs (109, 169, 121, 121) | **not run**; 3 of 4 runs pass |
| Labels (G9) | 100 % of AI social records `origin = 1`; every non-human actor labelled; banner | not run | `origin = 1` is checked by M8 (n = 34, 71, 84 on the passing runs); page badges and banner covered by unit tests; no recording exists, so no frame was checked | **reported**; the recording part is not run |
| Persona differences (G11, reported) | swapping the persona changes the choice in at least 30 % of 10 fixed situations; Conqueror march rate above Diplomat's; Diplomat messages above Conqueror's | run | the chosen set differed in **10 of 10** situations; march rate **70 % (14/20) vs 0 % (0/20)**; messages **17 vs 5** (40 decisions, 2 personas) | **pass** (one sample per cell; mostly each persona's constant pattern) |
| No regression (G10) | hook check clean; no never-edit file changed; grep empty; M1 suites green | run | `ai-hook-check.sh --blank-ok` pass (166 commits); the grep is empty; the never-edit diff against `frontier/unify` is empty; `npm test` 1658 of 1658 | **pass** |

## E2. What these numbers do not show

- Anything about the main run (18 AIs, 3 game days) or the A/B test: neither has been run.
- A rate or a trend. The four runs differ in size and configuration, two of them share a seed, and every figure is a count from one run.
- That the valid-choice rate meets 95 %: it was 82.4 to 88.7 % in the three 12-AI runs and 57 of 57 only in the 6-AI run of one persona.
- That an AI's own march reliably becomes a clash. Y is an episode proxy, the herald clash rows were not read, and 12-AI runs sent 7, 1 and 1 model marches.
- That the AI "decided" without the by:model share: most AI actions (63.8 to 81.2 %) are the autopilot's economy and duties.
- That memory changed or improved a choice. A citation shows a line was shown and named. Many cited lines are the message or motion the AI is answering. The probe has no rate (N = 31 of 40 needed) and its control moved 7 of 31 against 9 of 31 for the ablation.
- That the AI resists prompt injection in general: 0 hijacks is one sample per case and situation on a 44-case corpus, and the gate is not met.
- That humans and AI decided together: no run holds a human ballot; the seat's votes were scripted by the operator, and only for nation 0.
- That the personas differ in how they react to a situation; the 10 of 10 comes mostly from each persona's constant output.
- That the model wants, intends or remembers like a person; that it plays better than people or script bots; that every decision replays exactly on any machine; anything about devnet, mainnet or real players.

## E3. Wording (contract section 12.2)

- Allowed as measured: "In four completed local runs, AI citizens sent 20 model-chosen marches, 18 with a clash episode in the public record (an episode proxy); the model chose 18.8 to 29.9 % of AI actions, the autopilot the rest." Name the runs and print the by:model share with it.
- Allowed: "Prompt-injection suite: 0 hijacks in 144 runs per channel language on 44 cases and 4 situations; the pre-registered gate is not met because two pinned cases were not exercised."
- Not allowed now: "0 hijacks in N runs" as a gate result; any A/B sentence; "95 % valid"; "humans and AI decide together"; any main-run figure; "memory made it decide".
- If the main run and the A/B are not made by the freeze, contract 11.8 and 12.2 require the AI section of every document to read: "AI citizens: not implemented in this submission; design only." Keeping the small-n section instead is an owner decision and needs a written amendment of that sentence.

---

# 付録A: G14(b) 関連性の抜き取り(暫定、本走ではない)

**基準と抜き取りの規則(20件を表示する前に固定。`2026-10-06`、この作業のセッション)。** 契約の文言: 「引用されたエピソードが、選んだ候補か述べた理由と、同じ国か場所についてのものか: はい / いいえ / 不明」。
プール: `ai-record-2` と `ai-record-3` の開示記録(`open/*.json`、`index.json` を除く)のうち `choice.mem` が空でないもの(34件)。抜き取り: 記録 `id`(sha256 の16進)の昇順で先頭20件。判断ごとに、引用したエピソード(`memory/<tag>/episodes.json` の本文と entities)、選んだ候補(`choice.ids` のラベルと entities)、`why` を読む。
- **はい** = 引用したエピソードのどれかが、選んだ候補の目標か entities にある国か場所(座標・地方)と同じものを挙げる。または `why` がそれを挙げる。
- **いいえ** = 比較できる(選んだ候補か `why` が国か場所を挙げる)のに、引用したエピソードに共通する国か場所がない。
- **不明** = 選んだ候補も `why` も国や場所を挙げない(保持、autopilot、建築、一般的な理由)。または引用したエピソードが国や場所を挙げず(例: `build_done`)、`why` もそれを述べない。
読み手は1人(モデル)で、評価対象のシステムから独立していません。**読んだあとに足した分類が1つあります:** 「同じ市民だけ」(`why` が名前を挙げた市民と、引用した DM や動議の送り手が同じで、国や場所は挙げない)。基準はこの場合を決めていなかったので、「はい」に数えず、別に数えました。

| # | 実行 | AI | ベル | 種類 | 選んだもの | 引用 | 判定 | 理由 |
|---|---|---|---|---|---|---|---|---|
| 1 | R3 | 1002 | 54 | reaction | (返事のみ) | dm、Noveko から | 同じ市民のみ | `why` が Noveko のメッセージに言及 |
| 2 | R2 | 1011 | 59 | session | hold | council_result(自国の評議会が Strike Order を採択) | 不明 | `why` は「Strike Order が有効な間」、国・場所なし。話題は一致 |
| 3 | R2 | 1004 | 54 | reaction | (返事のみ) | motion(Moe、選択肢1) | 不明 | `why` は「評議会の方針」のみ。話題は一致 |
| 4 | R2 | 1002 | 54 | reaction | (返事のみ) | motion(Someka、選択肢2) | 同じ市民のみ | `why` が Someka の提案に言及 |
| 5 | R3 | 1008 | 54 | reaction | (返事のみ) | dm、Karami から | 同じ市民のみ | `why` が Karami に言及 |
| 6 | R3 | 1003 | 79 | reaction | (返事のみ) | threat、nation 2(Cinder)、(-3,1) | **はい** | `why` が「Cinder の動き」を挙げる |
| 7 | R2 | 1001 | 80 | reaction | (返事のみ) | motion(Omeka、26ベル前) | 不明 | `why` の「C1」を引用の送り手に結べない |
| 8 | R3 | 1007 | 78 | reaction | (返事のみ) | dm、Hameka から | 同じ市民のみ | `why` が Hameka に言及 |
| 9 | R2 | 1003 | 78 | reaction | (返事のみ) | motion(自国)+ threat、nation 2、(-3,2) | **はい** | `why` が「nation 2 の動き」を挙げる |
| 10 | R2 | 1002 | 78 | reaction | (返事のみ) | motion(Someka、選択肢2 strike) | 不明 | `why` が「C1 の動議」。送り手との対応が確認できない。話題は一致 |
| 11 | R2 | 1010 | 54 | session | hold | motion(Moe、選択肢1) | 不明 | `why` は経済の安定。引用との関係が薄い |
| 12 | R3 | 1011 | 37 | session | hold | threat、nation 0(Aster)、(3,0) | 不明 | `why` は「敵軍が国境に接近」。国・場所を挙げないが、話題は同じ出来事 |
| 13 | R2 | 1009 | 78 | reaction | (返事のみ) | motion(Jonaren、Elos) | 同じ市民のみ | `why` が Jonaren の提案に言及 |
| 14 | R2 | 1001 | 33 | session | autopilot | motion(自国、26ベル前) | 不明 | `why` は「strike の鐘を待つ」。国・場所なし |
| 15 | R3 | 1002 | 55 | session | hold | threat、nation 1(Borealis)、(-1,3) ほか | **はい** | `why` が「nation 1 からの脅威」を挙げる |
| 16 | R3 | 1009 | 57 | session | hold | council_result(自国が採択) | 不明 | `why` は「国の方針で strike を待つ」。国・場所なし。話題は一致 |
| 17 | R3 | 1009 | 78 | reaction | (返事のみ) | threat、nation 2、(-3,3) | **はい** | `why` が「nation 2 の動き」を挙げる |
| 18 | R2 | 1010 | 78 | session | 建築2 + Strike Order に従う行軍 | motion(Ludaya) | 同じ市民のみ | `why` が Ludaya に言及。目標 (2,-3) と引用の場所の比較はできない |
| 19 | R2 | 1011 | 54 | session | hold | motion(Rokaren、選択肢2) | 不明 | `why` は兵の比率と「次の strike」。国・場所なし |
| 20 | R2 | 1005 | 78 | session | 建築2 + 訓練 | build_done(図書館、(3,-1)) | 不明 | `why` は村の成長。完了した建物は選んだ建築と別物 |

集計(判断ごと): はい 4(#6、#9、#15、#17)、同じ市民のみ 6(#1、#4、#5、#8、#13、#18)、いいえ 0、不明 10。不明のうち、同じ種類の出来事(Strike Order、動議、接近する軍)の話題が一致するもの(読んだ印象)は7(#2、#3、#10、#12、#14、#16、#19)。**20件のうち行軍の判断は1件(#18)。** 20件の内訳は reaction 11、session 9。

# 付録B: G13 の数え直し(梱包ファイルから、各実行)

方法: `docs/frontier/ai-citizens/runs/<run>/` の `minds/<b>.json` の `records`、`minds/late/<b>.json` の `entries[].record`、`open/<b>.json`(封じられた判断の選択と `retrieved`)を id で合わせ、`choice.mem` が空でない判断ごとに、各 id が同じ判断の `retrieved` に入るかを数えた。

```python
import json,glob
for r in ['smoke-r4','ai-pilot-A1','ai-record-2','ai-record-3']:
    recs={}
    for f in glob.glob(f'{r}/minds/*.json'):
        for x in json.load(open(f)).get('records',[]): recs[x['id']]=x
    for f in glob.glob(f'{r}/minds/late/*.json'):
        for e in json.load(open(f)).get('entries',[]): recs[e['record']['id']]=e['record']
    for f in glob.glob(f'{r}/open/*.json'):
        if f.endswith('index.json'): continue
        for x in json.load(open(f)).get('records',[]):
            o=recs.get(x['id'])
            if o is None: recs[x['id']]=x; continue
            if o.get('sealed') or not o.get('choice'):
                o=dict(o); o['choice']=x.get('choice'); o['retrieved']=x.get('retrieved'); recs[x['id']]=o
    cit=ids=bad=0
    for x in recs.values():
        m=(x.get('choice') or {}).get('mem') or []
        if m: cit+=1; ids+=len(m); bad+=sum(1 for i in m if i not in set(x.get('retrieved') or []))
    print(r,len(recs),'records;',cit,'citing;',ids,'ids;',bad,'outside retrieved')
```

結果: `smoke-r4` 497 records、33 citing、58 ids、0 outside。`ai-pilot-A1` 1735、200、322、0。`ai-record-2` 1115、113、158、0。`ai-record-3` 1115、110、165、0。合計 703 ids、範囲外 0。引用した判断の数は、各 `report.json` の `decisions_citing_memory.from_records`(33、200、113、110)と一致しました。
