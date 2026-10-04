# ゲーム設計の食い違い一覧（48件）

- 日付: 2026-10-04（夜）
- 対象: ブランチ frontier/unify（head 19fe89c）。読んだ他のブランチの先端は、ai-integ bbf452a（読み始めは 0cc0973。smoke-b3 の記録は b41dd1b の時点。smoke-b4 は 2026-10-04 21:07 JST に開始で、終了の記録なし）、cq-integ 6ec65e4、playtest 0058f78。
- 状態: あなたの確認前の版です。この作業では何も push していません（すでに公開されている範囲は、設計書の 8.1）。あなたの確認が要る点は、第9節にまとめてあります。この表は食い違いと、その解決の方針を記録するもので、ゲーム設計書そのものではありません。設計書は docs/GAME-DESIGN.ja.md です。各項目が設計書のどの章に入ったかは、第11節に一覧にしました。
- 作り方: 七人の読み手が、すべての設計文書とあなた自身の発言から約400の記述を取り出し、分析で 48 件（C01〜C48）にまとめました。今回、決定的な主張は原資料のファイルを開いて照合しました。照合で訂正した点は第8節にあります。

## 0. この表について

### 0.1 五つの分類

| 分類 | 意味 | 件数 | 解決の方法 |
|---|---|---|---|
| A 状態の古い記述 | 文書が、今の実際より前の状態を書いている | 7 | 正しい状態への書き換えを示す。文書の修正は、この表の次の作業で行う |
| B ルール・数値の不一致 | 同じルールや数値が、文書やコードで別の値になっている | 12 | どの出典の値を正とするかを示す。文書の修正は次の作業で行う |
| C 設計方針の判断 | あなたの判断がないと決まらない、または判断と文書が食い違っている | 17 | あなたの決定 D1〜D12 のどれで解決するか、または決まっていない理由を書く |
| D 主張・言い回し | 提出物で言ってよいことと、実際の根拠が合っていない | 7 | 直す文言を示す。文書の修正は次の作業で行う |
| E 未設計 | 設計そのものが存在しない、または複数の設計がまだ一つになっていない | 5 | 何が空白かを書き、別の設計作業に回す |

### 0.2 状態の語

| 状態 | 意味 |
|---|---|
| 未対応 | 決定、または訂正の方針は出ているが、文書にはまだ反映していない |
| 対応済み（文書） | 文書の修正が済んでいる。この表の各行の状態は、表を書いた時点のままです。その後の反映状況は第12節にまとめました |
| 未決 | あなたの決定または確認が要る。決まるまで文書は現状の書き方を保つ |
| 設計のみ | 決定により設計として確定したが、実装はない。提出物では「設計」として書く |

文中の状態タグは次の5つだけです。【動いている】（コードがあり、実際に実行した。別ブランチのコードは「ブランチ上で」と書く）、【作成中】（今回のハッカソンの提出に向けて、実装または実行を続けているもの。征服線には使わない）、【設計のみ】（書いてあるが作っていない）、【計画】（時期の決まっていない予定）、【やめた】（決定により外した）。あなたの確認が要る点には【確認】を付けています。

### 0.3 出典の書き方

- パスは、リポジトリ直下からの相対パスです。frontier/unify にあるファイルには接頭辞を付けません。他のブランチのファイルには ai-integ:、cq-integ:、playtest: を付けます。
- リポジトリの外にある資料には pitch-materials:、game-design:、pitch: を付けます（設計書と同じ書き方です）。pitch-materials: と game-design: は outputs/.claude/data/ の下（pitch-materials の ONE-PAGE-BASE.md、CLAIMS.md、FIX-LIST.md、SHOT-LIST.md、game-design の REDESIGN-v4.ja.md）、pitch: は outputs/pitch/ の下です。
- ai-integ:.local/ の下の実行結果は、git で管理されない生成物です。
- あなたの発言は、相談チャットの書き起こしのイベント番号（MAIN、PLAYER、PITCH など）で示します。この作業では書き起こしの原文を開いていません。読み手の記録（readers-full.json）に残る要約と番号を使っています。
- 「決定 D1〜D12」は、あなたが 2026-10-04 の夜にチャットで一つずつ答えた決定です。決定の記録（DECISIONS の Y 部）は、この表の次の作業で書きます。

### 0.4 件数

| 状態 | 件数 | 該当 |
|---|---|---|
| 未対応 | 37 | A 7 件、B 12 件、C 9 件（C03 C04 C10 C11 C14 C15 C16 C21 C45）、D 7 件、E 2 件（C32 C34） |
| 未決 | 8 | C09 C20 C22 C23 C24 C46、C33 C35 |
| 設計のみ | 3 | C06 C18 C19 |
| 対応済み（文書） | 0 | |

## 1. 解決の前提になる事実（提出物の現状）

ここに書く事実は、第2節以降の「決定による解決」の前提です。

| 項目 | 現状 | 状態 | 出典 |
|---|---|---|---|
| 提出物の範囲 | ピッチ、デモ、README です。開発をハッカソンまでに終える必要はありません。作ったものは今のまま（基本ゲーム M1 と AI市民）で、決定 D1〜D12 は目標の設計として書きます。README は「作ったもの」と「設計したもの」を分けます | — | 決定の記録（あなた、チャット、2026-10-04） |
| 基本ゲーム M1 | ローカルの試験用チェーン上で、7ゲーム日（1,008 ターン、20 倍速。ターンは、10分ごとに世界が一斉に進む区切りで、コード上の名前は bell）のシーズンを、1,000 体のルールBot で最後まで実行した。人間はまだ遊んでいない | 【動いている】 | README.md:7,136; docs/DESIGN-OVERVIEW.md:144; frontier-abi/src/presets.rs:350-360 |
| AI市民 | 契約 v1.3 が規範。frontier/unify にコードはない。コードは ai-integ にあり、提出用の木への合流は契約書上 10-12 朝（§11.9）の予定。実行記録は 8 件（最後の smoke-b4 は 2026-10-04 21:07 JST に開始、終了の記録なし）で、実行できたのは 6 体（各国 1 体）のスモークテストまで。本走（18 体、3 ゲーム日、10 倍速）の結果はない | 【作成中】 | docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:3,16,34,855,865; ai-integ:docs/frontier/ai-citizens/RUNS.md:8-37 |
| 征服 | 契約 v1.5。Wave 1〜2 が cq-integ にマージ済みで Gate CQ2 の各行が成功。Wave 3〜5 は未着手。frontier/unify にはマージされていない | 【設計のみ】（製品として）。コードはブランチ上で【動いている】（Wave 1〜2）。Wave 3〜5 は【設計のみ】 | cq-integ:docs/frontier/conquest/CONQUEST-CONTRACT.md:3; cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:168,231-237 |
| 参加直後の土地の付与（D3） | 現在は、参加すると敷地の抽選券を出し、約 11〜21 分後に村が現れる。確定まで最大 24 ターン（約 4 時間）は仮の村。付与を即時にする設計は、PlaceHome 命令の追加として見積もったが、実装していない | 【設計のみ】 | docs/frontier/m1/M1-CONTRACT.md:59,69; feasibility.json（作業用の見積もり、リポジトリ外） |
| 友人テスト（D11a） | 開催しない（中止）。仕組みは playtest ブランチにあり、台本で動く訪問者 20 人で通しの練習をしただけ | 【やめた】 | playtest:docs/frontier/playtest/PT-C-NOTES.md:1-3 |
| シーズンの長さ（D6） | 設計は 14 日。実際に走ったのは 7 ゲーム日の 1 回だけ。AI の本走は 3 ゲーム日（10 倍速）。古い設計値は 28 日（仮の数字で、一度も走っていない） | 【設計のみ】 | frontier-abi/src/presets.rs:350-360; docs/frontier/DESIGN.md:170,1347 |

## 2. A 状態の古い記述（7 件）

| ID | 内容 | 出典（ファイル:行） | 決定による解決 | 状態 |
|---|---|---|---|---|
| C01 | **AI市民の状態。** README、概要、DESIGN、DECISIONS、PITCH、SUBMISSION、SUMMARY.ja は、AI市民を「未実装、コードなし、契約 v1.2」と書く。事実は 2 つに分かれる。<br>(1) frontier/unify にコードがないのは正しい（permutation-gateway/citizens がない）。契約書は v1.3 で、unify のファイルは 19fe89c の版。ai-integ のファイルは、v1.3 に R12 などの改訂（FB1〜FB5。自軍の「勝ち」の定義の変更など）が加わっていて、同一ではない（差は契約の 420〜422、431、639、763、1077 行）。GAME-DESIGN-CORE.ja.md は同一。<br>(2) ai-integ には波 A・B のコードがあり、実行記録が 8 件ある（slice-1〜4、smoke-b1〜b4。smoke-b4 は終了の記録なし）。完了は slice-4、smoke-b2、smoke-b3 で、verify-minds は smoke-b2 が FAIL、smoke-b3 が PASS（この PASS は、あとで直した検証器 FB3 より前のもの）。smoke-b3 は 6 体（各国 1 体、征服者）、86 ターンで、モデルが選んだ 52 件がすべて有効（52/52、95% 区間（本当の値が入ると見込める範囲）93.1〜100%。報告書自身が、n=52 は基準の 300 に足りず G1 は標本不足と書く）。モデルが選んだ行動の割合は上限 29.8%。<br>GAME-DESIGN-CORE.ja.md:395 も「コードはまだない」と書いており、自分のブランチに追い抜かれている | README.md:7,44; docs/frontier/DECISIONS.md:447; PITCH.md:24; SUBMISSION.md:21; docs/DESIGN-OVERVIEW.md:166; docs/frontier/ai-citizens/GAME-DESIGN-CORE.ja.md:395; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:1-3; ai-integ:docs/frontier/ai-citizens/RUNS.md:8-37; ai-integ:docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:420-422,1077; ai-integ:.local/frontier/ai/smoke-b3/report.md:5-14,26-28 | 事実の訂正で、決定の対象ではない。統一書には状態を 3 段で書く。契約 v1.3 は【設計のみ】、コードは ai-integ にあり提出用の木への合流は 10-12 朝の予定で【作成中】、実行結果は小さな標本のスモークテスト（6 体、86 ターン、n=52）まで。本走の結果は書かない。README の [AS-BUILT: pending] 欄は、合流後にだけ埋める。契約の版は v1.3 に揃える。本走の規模は決定 D11b（18 体）に従う | 未対応 |
| C02 | **征服の状態。** README と概要は、征服を「Wave 1 のカーネルとシミュレータだけ、結果は引用しない」と書く。unify の docs/frontier/conquest/ の契約と要約は v1.1 のまま。<br>cq-integ の実際は、契約 v1.5。Wave 1（規則、シミュレータ、ABI、文書）と Wave 2（プログラム v2、keeper、herald、Bot）がマージ済みで、Gate CQ2 の各行が成功している（svm テスト 342 件成功・5 件無視、ワークスペース 534 件、npm 573 件）。Wave 3（検証器、スタック、リレー、Web データ、結合テスト）以降は着手していない（cq-integ の conquest 配下に CQ3 の記録がない）。cq-integ は frontier/unify にマージされていない。ルールBot によるテストとシミュレータでの実行まで。人間や AI市民が征服を遊んだ記録はない | README.md:19,43; docs/DESIGN-OVERVIEW.md:44; docs/frontier/conquest/CONQUEST-CONTRACT.md:3; docs/frontier/conquest/SUMMARY.ja.md:1-4; cq-integ:docs/frontier/conquest/CONQUEST-CONTRACT.md:3,1651-1663; cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:23-32,168,231-237 | 決定 D7: 征服は製品設計に含め、領土は得点に入る【設計のみ】。提出用の木では、征服は cq-integ にあり、ブランチ上で【動いている】（Wave 1〜2）、Wave 3〜5 は【設計のみ】（未着手）で、提出物には含まれない。統一書にはこの二つを並べて書く。unify の征服の契約と要約は、v1.5 の要約に差し替えるか、「cq-integ が正」の帯を付ける。DECISIONS には征服の部（CQ）への参照を置く | 未対応 |
| C13 | **約束・裏切りの残骸。** 決定 X2（2026-10-04）で、AI 同士の約束・裏切り・同盟・名声（Renown）はビルドから外れた。しかし、あなたが 10-03 に承認したルール文書の ai-integ 版、ai-integ の SUMMARY.ja.md（v1.1）、資料の ONE-PAGE-BASE.md の「記録された約束」には、約束の記述が残る。unify 側のルール文書には冒頭に置換の注記があり（:3）、DECISIONS の W6 には X2 の注記が付いている。ai-integ 側と資料側にはない | docs/frontier/DECISIONS.md:438,452; docs/frontier/ai-citizens/RULES-AND-AI-CITIZENS.ja.md:3; ai-integ:docs/frontier/ai-citizens/RULES-AND-AI-CITIZENS.ja.md:97,123,143,171-175,192,200,203; ai-integ:docs/frontier/ai-citizens/SUMMARY.ja.md:16,28-36; pitch-materials:ONE-PAGE-BASE.md:19 | 決定 X2（あなた、2026-10-04、記録済み）。統一書に約束の語を載せない。ai-integ のルール文書と SUMMARY.ja、資料の ONE-PAGE-BASE には「X2 で置き換え済み」の帯を付けるか、統一書から作り直す。AI 同士の約束・裏切り・同盟・名声は【やめた】 | 未対応 |
| C27 | **用語（国・村と勢力・拠点）。** 決定 W11 で「国」「村」に決まったが、征服の契約・要約・画面の文言（cq-integ）、W5/W6/W9 の表、DESIGN の第 8 節以降、動いている画面の文字列が「勢力 faction」「拠点 holding」のまま。資料の SHOT-LIST は、m1-exit スタックの英語文言が holding と faction のままであること、デモ再生ページの題名と文言に旧称「六重の辺境」が残ることを記録している。<br>「faction」を含む行数は、征服契約 157、DESIGN.md 46。「勢力」「拠点」を含む行数は、征服の SUMMARY.ja 56 | docs/frontier/DECISIONS.md:437,443; cq-integ:docs/frontier/conquest/CONQUEST-CONTRACT.md（全体）; cq-integ:docs/frontier/conquest/SUMMARY.ja.md（全体）; docs/frontier/DESIGN.md（全体）; pitch-materials:SHOT-LIST.md:16,18 | 決定 W11（あなた、2026-10-03）に従う。統一書に用語表を置く: 国、村（集落・町・都市・要塞は村の段階名）、前哨、砦、攻撃命令（コード名 Call）、評議会、AI市民、スクリプトBot、席。コード上の識別子（faction、holding、Call）は変えない。画面の文字列の修正は別作業 | 未対応 |
| C28 | **同じ事実の多重記述。** 同じ設計事実が、README(.ja)、DESIGN-OVERVIEW(.ja)、DESIGN.md、SUMMARY.ja、PITCH.md、SUBMISSION.md、資料の ONE-PAGE-BASE と CLAIMS、ピッチ各版に、日付も契約の版も違う形で重ねて書かれている（例: AI 契約の v1.2 と v1.3、12 体と 18 体の言い方、28 日と 14 日）。日本語版の一部に「オーナー」の呼称が残る（docs/DESIGN-OVERVIEW.ja.md 8 行、ルール文書 10 行、征服の SUMMARY.ja 1 行）。ただし、あなたが承認したルール文書では、あなたの発言を引用している箇所を含む | README.md; docs/DESIGN-OVERVIEW.md; docs/frontier/DESIGN.md; docs/frontier/SUMMARY.ja.md; PITCH.md; SUBMISSION.md; pitch-materials:ONE-PAGE-BASE.md; pitch-materials:CLAIMS.md; docs/DESIGN-OVERVIEW.ja.md（「オーナー」8 行）; docs/frontier/ai-citizens/RULES-AND-AI-CITIZENS.ja.md（10 行）; docs/frontier/conquest/SUMMARY.ja.md（1 行） | 統一設計書を唯一の源にする（あなたが読んで確認する）。README は統一書の要約にし、ONE-PAGE-BASE と CLAIMS は統一書から作り直す。docs/frontier/DESIGN.md は技術の参照として残し、古い箇所と置き換え済みの箇所に注記する（C07、C26、C36、C37、C39 の訂正を参照）。日本語の呼称は「あなた」に統一する。なお、この行の「オーナー」は、置き換える対象の語を示すための引用で、あなたへの呼びかけではない | 未対応 |
| C29 | **契約の版。** README.md:44、概要:166、PITCH.md:24、SUBMISSION.md:95、docs/frontier/SUMMARY.ja.md:3、ai-citizens/SUMMARY.ja.md:1、資料の CLAIMS.md:3,46 は、AI 契約 v1.2 を規範と書く。契約書そのものは、unify の AI-CITIZENS-CONTRACT.md が v1.3（コミット 19fe89c で入った。波 A の裁定 R1〜R11 を適用済み）。ai-integ のファイルは、v1.3 に R12 などの改訂（FB1〜FB5）が加わっていて、unify のものと同一ではない。SUMMARY.ja.md は、ai-integ 側が v1.1 のまま、unify 側は v1.2 用に書き直し済みで、同名のファイルが 2 つのブランチで別内容になっている | README.md:44; docs/DESIGN-OVERVIEW.md:166; PITCH.md:24; SUBMISSION.md:95; docs/frontier/SUMMARY.ja.md:3; docs/frontier/ai-citizens/SUMMARY.ja.md:1-3; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:3; ai-integ:docs/frontier/ai-citizens/SUMMARY.ja.md:1-3; pitch-materials:CLAIMS.md:3,46 | 契約 v1.3 が AI 線の規範（決定の記録済み事項）。統一書は v1.3 を参照し、上の v1.2 の記述を v1.3 に書き換える。両ブランチの SUMMARY.ja は、統一書への案内 1 枚に置き換えるか、v1.3 に合わせる。同名ファイルの二重化は、10-12 の合流（契約 §11.9）で解消する | 未対応 |
| C42 | **公開リポジトリの顔。** origin/main の README は、名前だけ Wylls に変えた旧試作（Handoff、マーラ・タラ・イーヴォ）のもの。開放世界の Wylls の README は frontier/unify にだけあり、origin/main より 438 コミット先（2026-10-04 時点、git rev-list）。資料の FIX-LIST.md 第 4 節は、unify で直した後の状態を反映していない。outputs 直下の PITCH.md、SUBMISSION.md、DEMO_SCRIPT.md、README.md も本文が旧試作のまま | git show origin/main:README.md:1-12; pitch-materials:FIX-LIST.md:50-60; outputs/README.md:1-5 | あなたが統一書を確認した後に README を置き換える。push は、あなたが指示したときにだけ行う（公開済みなのは、あなたが承認した codex/frontier の 5ed36fa と main の 5c111f4 まで。frontier/unify、AI線、征服線は push していない）。outputs 直下の旧 3 ファイルには「旧試作」の帯を付ける | 未対応 |

## 3. B ルール・数値の不一致（12 件）

| ID | 内容 | 出典（ファイル:行） | 決定による解決 | 状態 |
|---|---|---|---|---|
| C05 | **最初の村の待ち時間。** README、SUBMISSION、ONE-PAGE-BASE、概要は「次のターンに村が現れる（約 11〜21 分、モデル値）」とだけ書く（修正前の記述。引用は本書の日本語訳で、原文の語は bell）。DESIGN と M1 契約は、現れた村は最大 24 ターン（約 4 時間）は「仮」で、そのあいだ招集・探索・出撃ができない（収穫・建設・訓練はできる）と定める。<br>実測は「村が現れるまで」だけ。台本で動く訪問者 20 人（実在の人ではない）で、中央値 18.0 分（最小 11.4、90 パーセンタイル 19.6、最大 20.7）、10 倍速で中央値 106 秒。確定までの時間は測っておらず、テスター案内も「測っていない」と書く | README.md:28; SUBMISSION.md:19; docs/DESIGN-OVERVIEW.md:77,104; docs/frontier/DESIGN.md:179; docs/frontier/m1/M1-CONTRACT.md:59,69; playtest:docs/frontier/playtest/TESTER-GUIDE.md:31; playtest:docs/frontier/playtest/PT-C-NOTES.md:29-31,50-51; pitch-materials:ONE-PAGE-BASE.md:16 | 決定 D3（あなた）は「参加と同時に土地を渡す（待ちも仮の村も練習戦もなし）」。これは【設計のみ】で、プログラムは変えない。提出物の README と統一書は、現在の動作を次のように書く。村は次のターン以降、約 11〜21 分で現れる【動いている】。確定まで最大約 4 時間かかり、そのあいだ招集・探索・出撃ができない【動いている】。確定までの実測はないので、その数字は書かない。即時付与の見積もり（PlaceHome 命令の追加、実作業の時計時間で約 11〜14 時間、機械時間で約 6〜8 時間）は作業用の記録にあるが、開発を間に合わせる必要がないため実施しない | 未対応 |
| C07 | **戦って得るもの。** DESIGN.md:191 は「戦闘報告、略奪、ワークス」、第 6.3 節（:639-642）は襲撃の略奪 10%、占領の貢納（最初の村の放出配分の 50% と生産の 20%）、村 2〜3 の占領と 25% の移転を書く。M1 では戦っても何も得ない（蛮族の野営地を倒すと得点（Works）10 点が入るが、使い道はない）。征服契約は貢納を延期し（K-12）、ラウレルを MC に持ち込まず（K-16）、砦は何も産まない（:201） | docs/frontier/DESIGN.md:191,639-642; docs/DESIGN-OVERVIEW.md:91; cq-integ:docs/frontier/conquest/CONQUEST-CONTRACT.md:134,138,197-201 | DESIGN.md の第 6.3 節の末尾に「征服契約が優先。略奪と貢納は M2/M3 の設計として残す」と注記する。統一書の戦闘の節には、M1 の実際（戦っても得るものがない）【動いている】と、征服の実際（砦、占領、前哨）をブランチ上で【動いている】ものとして書き分ける。戦う理由は、決定 D1（領土が得点に入る）と D7 による【設計のみ】 | 未対応 |
| C08 | **1 人あたりの村の数。** M1 は 1 人 1 村（村 2〜3 は M1 が作らないものとして明記）。DESIGN.md は最大 3 村とし、2〜3 村目は「どこでも」築けると書く。征服は 2〜3 村目を前哨としてチケットで築く（どの国の本拠地の輪の外、最初の村が町以上、自分の村から 3 州以内、自国の占める割合が 50% 未満の州）。入植者の封印行軍は M3 | docs/frontier/m1/M1-CONTRACT.md:17,608; docs/frontier/DESIGN.md:148,266; cq-integ:docs/frontier/conquest/CONQUEST-CONTRACT.md:98,129,331-345; cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:27 | 統一書に 1 つの表で書く。M1: 1 村【動いている】。征服線: 前哨で 2〜3 村目、ブランチ上で【動いている】（cq-integ、提出物に含まれない）。M3: 封印行軍による入植【設計のみ】。DESIGN.md:266 の「どこでも」は、征服線では前哨の規則が優先する旨を注記する | 未対応 |
| C25 | **保護（シールド）の長さ。** M1 は 48 ゲーム時間（SHIELD_SECS、founding から 288 ターン）。征服の Frontier-7 プリセットは 24 時間で、48 時間は Frontier-28 だけ。前哨は 2 時間。同じ「保護」の語に値が複数ある | permutation-rules/src/frontier/holding.rs:128,173-180; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:54; cq-integ:docs/frontier/conquest/CONQUEST-CONTRACT.md:351,417-418 | 統一書に表で書く。M1: 48 ゲーム時間【動いている】。征服のプリセット: Frontier-7 は 24 時間、Frontier-28 は 48 時間、前哨は 2 時間（ブランチ上で【動いている】）。設計のシーズンの長さは決定 D6 で 14 日になったが、14 日用のプリセットはコードにない（C04 参照） | 未対応 |
| C26 | **休眠した最初の村。** DESIGN.md:308 は「10 日休眠で自由都市（Free City）の跡地」。M1 のコードは、5 日で休眠（生産が半分）、10 日で解放され、その敷地は自由な空き地になる。征服契約 K-08 は、解放された村の敷地は普通の空き地で自由都市ではない、7 日の Frontier-7 では解放自体が起きない（解放は 7 日＝シーズン全体）と定める。休眠の時計が 2 つある点は、征服の未回答の質問 14 にある | docs/frontier/DESIGN.md:308; permutation-rules/src/frontier/holding.rs:120-126; cq-integ:docs/frontier/conquest/CONQUEST-CONTRACT.md:130,420; cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:152 | 統一書では M1 の休眠規則（5 日で休眠、10 日で解放して空き地）を正とし、征服の違い（休眠 3 日、解放はシーズン全体、自由都市にならない）を表で書く。DESIGN.md:308 の「自由都市の跡地」は「自由な空き地」に直す | 未対応 |
| C36 | **ラウレル賭け金の価格。** DESIGN.md:178（2.2）は残り日数の式（賭け金 6 USDC × max(0.25, (28−日)/28)、21 日目に 1.50 USDC）。DESIGN.md:483（5.4）とプログラム（規則ライブラリ）は「これから貯まるラウレル」を基準にした価格（後半ほど高く、傾き 2.0）。傾きを 1.0 にするか 2.0 にするかは未決（D22） | docs/frontier/DESIGN.md:178,483,1348; permutation-rules/src/frontier/pools.rs:90-148; docs/frontier/DECISIONS.md:137 | お金は M2 の設計で、まず無料のシーズンを出す（決定 D4）。統一書は M2 の価格の数字を書かず、「ラウレル基準、傾きは未決（D22）」とだけ書く【設計のみ】。DESIGN.md:178 の式は、28 日基準で、決定 D6（14 日）では再計算が要る旨を注記する | 未対応 |
| C37 | **Bot を使う賭けの余裕の数字。** DESIGN.md:121,244,517,1295 は、最悪の組み合わせで 0.980、余裕は約 2 ポイント。同じ文書の 21.4 節（D23 を入れた再実行）は 0.979、保留種（held-out seeds）では 0.985、余裕 1.5 ポイント。DESIGN.md:223 は「0.985 対 0.980」のまま | docs/frontier/DESIGN.md:121,223,244,517,1295,1693-1708; docs/frontier/DECISIONS.md:137 | 保留種の値（0.985、余裕 1.5 ポイント）で書き換える。「自動化は割に合わない」という主張には、余裕が薄いと併記する。これは M2（お金）の設計内の数字で、シミュレータの結果であり、実プレイの結果ではない | 未対応 |
| C38 | **M1 のお金の言い方。** README と SUBMISSION は「誰も払わず稼がない」と書く。M1 は試験用 SOL で、行軍手数料（10,000 lamports）、開示チップ（最小 14,668 lamports）、防衛プール、シーズン作成の担保（既定 1 SOL）、州基金（ProvinceFund）の資金移動を動かしている。運営の防衛プールへの預託は既定 20 SOL（使われなければ返金）と設計されている | README.md:45,138; SUBMISSION.md:112; docs/frontier/DESIGN.md:1061-1065; docs/DESIGN-OVERVIEW.md:110; docs/frontier/m1/M1-CONTRACT.md:49,88,191; docs/frontier/DECISIONS.md:413 | 「プレイヤーが払う・稼ぐお金はない。プロトコルの内部に、試験用 SOL の小額の支払いがある」と書く。数字は M1 契約の値で書く。お金（参加費、賭け金、賞金）は M2 の設計【設計のみ】で、順序は決定 D4（無料のシーズンが先） | 未対応 |
| C39 | **1 人あたりの家賃とチップの数字。** DESIGN.md:828 は 1 人あたり約 0.0079 SOL（Citizen 1 つと Holding 1.15 個、(448 + 1.15×960) バイトを前提に導出）と書き、:1055,1058 の表（1,000 人で 7.9 SOL、100,000 人で 790 SOL）もこれに基づく。M1 のプログラムは Citizen 384B と Holding 1,280B で、1 人あたり 9,753,600 lamports（約 0.0098 SOL）。開示チップの最小値は 14,668 lamports。DESIGN.md:1060 には M1 の 0.0098 SOL が併記されているが、:828 と :1055,1058 は古い値のまま。行軍手数料の 10,000 lamports（DESIGN.md:1061）は、M1 のプリセット（march_fee 10,000）と一致していて、食い違いではない | docs/frontier/DESIGN.md:828,1055,1058,1060,1061; docs/frontier/DECISIONS.md:49,72,413; docs/frontier/m1/M1-CONTRACT.md:71,297; docs/DESIGN-OVERVIEW.md:110; frontier-abi/src/presets.rs:372 | プログラムの値（1 人あたり 9,753,600 lamports、チップの最小値 14,668）を使う。DESIGN.md の「1,000 人あたりの預託額」の行は、7.9 SOL から、約 24% 増の約 9.75 SOL に直す（1 人あたり 0.0098 SOL × 1,000）。100,000 人の行（790 SOL）も同じ比率で直す | 未対応 |
| C40 | **行動の上限の書き方。** 概要と M1 契約は「1 時間に 30 回（バースト 60）、代払い枠は 0〜6 日目に 1 日 40 回、7 日目以降は 20 回」。テスター案内は「1 日約 40 回、繰越は 60 まで」とだけ書く。0〜6 日目の範囲では一致するが、7 日目以降の 20 回と 1 時間あたりの持ちを書いていない | docs/DESIGN-OVERVIEW.md:116; docs/frontier/m1/M1-CONTRACT.md:323,882; permutation-gateway/src/frontier/quota.mjs:3,18; playtest:docs/frontier/playtest/TESTER-GUIDE.md:45 | quota.mjs の値（0〜6 日目 1 日 40 回、7 日目以降 20 回、繰越の上限 60、1 時間あたり 30 回でバースト 60）を正とし、テスター案内に足す。友人テストは中止（決定 D11a）なので優先度は低いが、案内はツール文書として playtest ブランチに残る | 未対応 |
| C41 | **年代記と持ち越し。** 「シーズンの終わりに何も持ち越さない、年代記だけ持ち越す」（T1）と、お金の設計が上限超過分や余りを「次のシーズンのプール」に回す、が衝突する。シーズン 1 には後継がなく、持ち越し先（CL-17）は未決。年代記（DESIGN.md:350）を作るコードは、プログラム・ABI・ノードのクレートのどこにも見当たらない（検索で確認。画面の文言とテストに語が出るだけ） | docs/frontier/DECISIONS.md:139,397; docs/frontier/DESIGN.md:350,417,495,1096 | 設計に次の案を入れる。シーズン 1 は後継がないので、請求されなかった分は参加費に比例して返す（DECISIONS:139 の「後継向けエスクロー、90 日後に参加費按分へ」の既定と同じ向き）。M2 のレビューで確定する。年代記は【設計のみ】で、書いてよいのは設計としてだけ | 未対応 |
| C43 | **「築く」と自動の村、「48 席」の呼び方。** あなたの言葉「村を築く」は、最初の村が自動で与えられる決定 V2 と合わない。「48 席の試作」は、V5（上限 256 人）ではなく、v9 の硬化ラウンド（中止）の人数 | docs/frontier/DECISIONS.md:425; docs/frontier/DESIGN.md:74,250,1359; docs/earlier-prototype/PERMUTATION_STATE_GAME_DESIGN_V5.md:511 | 「村をもらう」（最初の村）と「入植して築く」（2 村目以降の前哨）に分ける。旧試作は「V5（最大 256 人）」と「v9 の 48 席ラウンド（中止）」と呼び分ける | 未対応 |

## 4. C 設計方針の判断（17 件）

| ID | 内容 | 出典（ファイル:行） | 決定による解決 | 状態 |
|---|---|---|---|---|
| C03 | **AI市民の数。** 「12」が 2 つの意味を持つ。W5 は無料シーズンで国あたり約 12 体。ハッカソンの実行は全体の数で、A/B と録画が 12、本走が 18、スモークテストが 6。DESIGN.md:708 は両者を分けて書いているが、他の文書は分けていない。あなたが承認したルール文書は 12 体で、本走 18 体は設計者の既定だった（10-08 までに異議がなければ実行）。あなたの返事の記録がなかった | docs/frontier/DECISIONS.md:437; docs/frontier/DESIGN.md:708; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:135,939; docs/frontier/ai-citizens/GAME-DESIGN-CORE.ja.md:331; ai-integ:docs/frontier/ai-citizens/RULES-AND-AI-CITIZENS.ja.md:194,231 | 決定 D11b（あなた、2026-10-04）: 本走は 18 体（各国 3 体。復讐者、外交官、征服者）、A/B と録画は 12 体、スモークテストは 6 体。契約 v1.3 のとおり。「国あたり約 12 体（将来の無料シーズン）」と「ハッカソンの実行の全体数 6/12/18」を別の行に書く。設計者の既定だった 10-08 の異議期限は、この決定で不要になる | 未対応 |
| C04 | **シーズンの長さ。** 4 通りが並ぶ。28 日（用語集、ONE-PAGE-BASE、CLAIMS）、実走 7 日（M1 プリセット）、AI 本走 3 ゲーム日（X5）、友人テスト約 3 実日（中止）。征服のプリセットは Frontier-7（7 日）、Frontier-28、試験用の MC_TEST で、14 日のプリセットはコードにない。28 日は DESIGN の D2 で「未決の仮の初期値」で、あなたは数字を言っていなかった | docs/DESIGN-OVERVIEW.md:81,364; docs/frontier/DESIGN.md:170,1347; README.md:142; frontier-abi/src/presets.rs:350-360; cq-integ:frontier-abi/src/v2/presets.rs:458-509; cq-integ:docs/frontier/conquest/CONQUEST-CONTRACT.md:406-420 | 決定 D6（あなた）: 設計上のシーズンは 14 日【設計のみ】。実走したのは 7 ゲーム日の M1 出口シーズン 1 回だけ【動いている】。AI 本走は 3 ゲーム日・10 倍速【作成中】。統一書で「設計上の長さ」「実走したプリセット」「ハッカソンの実演の長さ」を別の項目にする。28 日で書かれた価格表と年代記の設計は、14 日に換算するか「28 日の仮値、未走」と明記する（C36 参照） | 未対応 |
| C06 | **仮の村と練習戦。** あなたの 10-02 の発言は、村が仮なのはなぜか、国の一員として区画をすぐ渡せばよい、練習戦は要らない、という趣旨（PLAYER event 255）。決定 V2 は国の選択だけの参加は決めたが、待ちと練習戦は残した。「即時の村・練習戦なし」は設計し直し案（v4 案）にとどまり、決定はなかった | PLAYER event 255（発言記録、2026-10-01T23:06Z）; docs/frontier/DECISIONS.md:425; docs/DESIGN-OVERVIEW.md:34,77,104; game-design:REDESIGN-v4.ja.md:4,9-10 | 決定 D3（あなた、2026-10-04）: 土地は参加と同時に渡す（待ちなし、仮の村なし、練習戦なし）。これは設計として確定した【設計のみ】。プログラムは変えない。現在の動作（待ちと仮の村）は、現在の動作として書く（C05 参照）。V2 の「約 11〜21 分」の記述は、この決定で置き換わる設計として注記する | 設計のみ |
| C10 | **「人と同じルール」。** あなたの 10-03 の発言は、AI は人間と変わらない AI プレイヤー、という趣旨。契約は、同じ鍵・回数制限・霧に加えて、候補は最大 12 個、兵は 1 回 60%・1 日 60%（本拠に 40% を残す）、モデルが選ぶ進軍は 1 日 4 回、自動運転は自分から進軍しない、人間必須の評議会規則は 0 番の席だけ、と制限する。ピッチ v20 と ONE-PAGE-BASE は「人間も AI も同じルールで、誰もズルできない」「同じルールと上限で遊ぶ」と書く | docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:40,235,251,345,906; docs/frontier/ai-citizens/GAME-DESIGN-CORE.ja.md:121-134,289; pitch:v20/en.txt:4; pitch-materials:ONE-PAGE-BASE.md:18 | 決定 D2（あなた）: 「人と同じルール」は、限定つきの言い方のままにする。同じ鍵・回数制限・霧に加えて、安全のための制限（候補 12 個、兵の上限 60%/40%、モデルの進軍は 1 日 4 回、自動運転は進軍しない）。README、ピッチ、SUBMISSION は「誰もズルできない」「同じルールで」と、限定なしには書かない | 未対応 |
| C11 | **AI の表示。** あなたの発言（10-01/02）は両方向がある。AI は遊ぶ人から見ても人間のようであるべき、隠れた AI は意味が分からない、など。W2「AI は常に表示」は決定として記録されているが、根拠は計画の承認で、あなた自身の文はなかった。契約は、AI の市民カードと名簿（roster.json）にラベルを付け、名簿にある市民を見せる画面はすべて AI バッジを出す（MUST）と定める | MAIN event 290, 392; PITCH event 66（発言記録）; docs/frontier/DECISIONS.md:434; ai-integ:docs/frontier/ai-citizens/RULES-AND-AI-CITIZENS.ja.md:91-93; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:144-145,355,672,689,738 | 決定 D2（あなた、2026-10-04）: AI市民はゲーム画面で人間のプレイヤーと同じ見え方にする（表示なし）。決定 W2「AI は常に表示」は、この決定で変更される。現状: メインの地図クライアントに AI バッジはない（CLAIMS D1 も同じ）。評議会・監査ページと名簿には、ai / script / seat のラベルがある。<br>次を既定のまま保つ（あなたが異議を言うまで）: 本当に知りたくて尋ねられたら AI は AI だと答える（契約 :355 のシステムプロンプトの開示規則。内容は、尋ねられたら運営が動かす AI市民だと答える、という指示）。README とルールに「この世界には運営が動かす AI の市民が含まれる」と一般的に書く。<br>【確認 Q2】評議会・監査ページと名簿のラベルを残すか。契約の「バッジは必ず出す」（:689）は、この決定と矛盾するので、残す・外すのどちらでも契約の改訂が要る。<br>法的確認（例: EU AI 法 50 条）は必要だが、まだ行っていない。README、ピッチ、SUBMISSION は「AI は常に表示される」と書かない | 未対応 |
| C14 | **ピッチ v20 の表現。** v20 は、斥候が壊されたという記憶、「誰もズルできない」、「追加費用なし」（「プレイするほど費用が増えない」の趣旨）、「恨みを持つ」「記憶している」を使う。設計の背骨は、斥候が戦闘に参加しないので「斥候が壊された」は起きないとして使わないとし、主張シートは「恨みを持つ」「記憶している」を言えないものとする（記憶は「引用した」とだけ言える）。「追加費用がない」は SUMMARY.ja の「言えないこと」にある。「誰もズルできない」は、限定なしの「同じルール」にあたり、C10 と同じ問題である。一方、あなたは 10-04 に「恨みを持つシヴィライゼーション」の一行を気に入っている | pitch:v20/en.txt:2,4,5（5 行目の「次のターンで戦いが本物になる」（原文は英語の "At the next bell"、日本語は本書の訳）は、到着までの実時間との照合をこの作業では行っていない）; docs/frontier/ai-citizens/GAME-DESIGN-CORE.ja.md:201-203; pitch-materials:CLAIMS.md:56-70; docs/frontier/ai-citizens/SUMMARY.ja.md:131; MAIN/PITCH event 2986, 3086（発言記録） | ピッチは主張シートに合わせて直す（担当はピッチのセッションで、この作業は材料だけ出す）。冒頭の軸は決定 D12（「AI がプレイヤーのように振る舞うゲーム」）。<br>【確認 Q26】「恨みを持つ」の一行の扱い。あなたの言葉と、主張シートの「記憶は引用した、とだけ言える」という制限が衝突する。残す場合は、記憶の根拠（引用したエピソードの記録）を併記する形に限る | 未対応 |
| C15 | **ピッチのお金。** v19/v20 は「参加費が賞金になり、運営が [P]% を取る」「スタジオ [studio] と話している」。主張シートの A9 と F は、賞金・USDC 参加費・80/20 の取り分を禁じる。スタジオとの会話の記録はなく、[P]、[channel]、[studio] は空欄 | pitch:v20/en.txt:7; pitch:build20.js:74-83; pitch-materials:CLAIMS.md:19,83 | 決定 D5（あなた）: 事業計画を、各部分に状態を付けた設計・計画として完全に書く。自分たちのシーズン【計画】、最初は無料【計画】、後で参加費（USDC）と運営の取り分【計画】、後で AI市民をゲームスタジオに提供【計画】。取り分や料金の数字は、法的確認が済むまで「検討中」。スタジオとの会話は、日付つきの記録が存在しないので、あったとは書かない。主張シート A9 は、この「計画」の書き方を許す形に直す | 未対応 |
| C16 | **問題設定の文。** README.md:30 と PITCH.md:9 は「新しいオンライン世界は空で始まる」「ボットが人のふりをする（それを拒む）」というv18の枠で始まる。この枠は、あなたが 10-04 に退けたもの（ピッチ構成メモは「r0ze が却下した枠組み」と記録）。あなたの最後の枠の言葉は「AI がプレイヤーのように振る舞う（AI ネイティブ）」で、「AI が国の物事を一緒に決める」ではない | README.md:30; PITCH.md:9; pitch:v20/structure.md:27-31; MAIN/PITCH event 2505, 2533（発言記録） | 決定 D12（あなた）: 軸は「AI がプレイヤーのように振る舞うゲーム」。国の評議会は二番目の見せ場。README と PITCH.md の冒頭をこの軸で書き直す。評議会と攻撃命令は、AI の自分の進軍（デモの主役）の次に置く（既存の決定 X1、X2 と整合） | 未対応 |
| C18 | **勝利条件。** あなたは「勝利条件は？」「領土の大きさだけ？」と 2 回聞いていたが、答えがなかった。M1 に得点も勝者もない。DESIGN の 4 経路（支配・繁栄・知識・協調）は、一人あたりに換算し群れ効果を抑える賞金配分のための式（§5.6）で、勝利条件ではない。単一の「国の得点」案は未決定だった | PLAYER event 255, 343（発言記録）; docs/DESIGN-OVERVIEW.md:91; docs/frontier/DESIGN.md:209-215,529-560; game-design:REDESIGN-v4.ja.md:4,11-15 | 決定 D1（あなた）: 国ごとの総合得点が 1 つあり、シーズンの終わりに国の順位を付ける。得点は、領土を持った時間、繁栄、知識の合計。これで「勝者なし」を置き換える【設計のみ】。M1 に得点も勝者もない。領土の得点は征服が前提で、知識は技術の設計が前提（C33）。<br>【確認 Q6】DESIGN §5.6 の「一人あたりに換算して抑える」式と、国ごとの合計は食い違う。統一書では、式を未決の設計点として書く（重み、一人あたりにするかどうかは決まっていない） | 設計のみ |
| C19 | **無料の最初のシーズン。** W4、W5、PITCH.md:46 は「お金のないシーズンが先」。あなたは 10-04 に、一行「最初は無料シーズン」に対して「勝手になんで作る？」と聞き、参加費が賞金になり運営が一部を取る、という趣旨も述べた。DESIGN のマイルストーンには公開の無料シーズンがなく、無料シーズンの長さ・得点・勝者の設計もなかった | docs/frontier/DECISIONS.md:436-437; PITCH.md:46; docs/frontier/DESIGN.md:1266-1269; MAIN/PITCH event 2533, 2546（発言記録） | 決定 D4（あなた）: 無料のシーズンが先、お金のシーズンはその後。決定 W4 と同じ向き【設計のみ】。M1 にお金はない。無料のシーズンの設計は、長さが 14 日（D6）、得点と順位が国の総合得点（D1）。DESIGN のマイルストーンの表に、公開の無料シーズンを設計として加える | 設計のみ |
| C20 | **次に作る順序。** あなたの 10-01 の発言は「領土争奪（征服）がコア、お金より先」。W8（10-03）は「共有文明（エンジン、技術、外交）がハッカソン後の最優先」。DESIGN 第 12 節は M2（お金）を M3（社会）より前に置く。概要のロードマップは共有文明、お金、社会の順。W9 は征服を並行して続ける | MAIN events 12686, 12716（発言記録）; cq-integ:docs/frontier/DECISIONS.md:424; docs/frontier/DECISIONS.md:440-441; docs/frontier/DESIGN.md:1253,1266-1267; docs/DESIGN-OVERVIEW.md:310-314 | 決定 D7 は征服を製品設計に含め、決定 D4 はお金を無料のシーズンの後に置いたが、ハッカソン後の開発の順序（征服・共有文明・お金）そのものを決める決定はない。記録されている W8（共有文明が最優先）と W9（征服は並行）、あなたの 10-01 の発言を並べて書き、決定ではなく「現在の記録」とする。DESIGN 第 12 節の週数は、再計画が要る旨の注記つきで残す。<br>【確認 Q13】ハッカソン後の順序 | 未決 |
| C21 | **征服のハッカソン扱い。** AI 契約の O-AI-8（征服版は落とす）は設計者の既定で、理由は「MC の Wave 2 が 10-03 時点で未着手」。実際には Wave 2 は済んで Gate CQ2 の行が成功している。あなたが承認したルール文書は「10-09 ごろまでに終われば砦と評議会を一緒に見せる」としていた。AI のプロンプトには「進軍で土地は取れない」という文が入っている | docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:22,129,305,945; ai-integ:docs/frontier/ai-citizens/SUMMARY.ja.md:139; ai-integ:docs/frontier/ai-citizens/RULES-AND-AI-CITIZENS.ja.md:216-217; cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:231-237 | 決定 D7（あなた）: 征服は製品設計に含めるが、提出用の木には入らない（cq-integ にあり、Wave 3〜5 は未着手）。したがって、AI の本走と提出物は M1 のルールで見せる。O-AI-8 の結論（落とす）は変わらず、理由を書き換える。「Wave 2 が未着手」ではなく「征服は cq-integ にあり提出用の木に入らない。Wave 3〜5 が未着手で、AI市民は征服を遊べない」。ルール文書と SUMMARY.ja の「10-09 ごろまでに終われば一緒に見せる」は、開発を間に合わせる必要がないため、削除する | 未対応 |
| C22 | **征服の未回答 15 問。** integ-CQ2-NOTES §7 の 15 問（前哨の足場、入植費の返金、自由都市の占有、包囲の保護、保持ロックの穴など）に、あなたの回答の記録がない。各問に既定が実装済みで、推奨が付くのは自由都市の 1 問（4 番）だけ。Wave 3 は、1〜6 番への回答、または既定を使う確認の後に始める予定だった | cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:133-168 | 決定 D8〜D10（あなた）: 15 問は未回答のまま、既定の実装で進める。第 7 節に、15 問を平易な日本語で、既定つきで 1 行ずつ載せた。Wave 3 は着手しておらず、提出物にも入らないので、今の提出物には影響しない。決まるまで契約の文は現状を保つ | 未決 |
| C23 | **砦で地図の色を決める。** 征服の要約は「砦が地図を塗る」を最重要の決定として扱うが、契約と DECISIONS は、16 個の既定（OD-1〜16）は「あなたの明示的な承認ではなく、作業上の既定」と書く。あなたの記録された言葉は「おすすめで進めて」「３つとも構わないので進めて」のみ | cq-integ:docs/frontier/DECISIONS.md:438,544,557-566; cq-integ:docs/frontier/conquest/SUMMARY.ja.md:210 | 決定 D7 は征服を製品設計に含め、領土を得点に入れると決めたが、砦のモデル（OD-1: 砦を持つ国が地図の色を決める）自体を確認する決定は記録にない。統一書は OD-1 を「作業上の既定」として書く。<br>【確認 Q11】砦モデル（OD-1）を、征服設計の中心として確認するか | 未決 |
| C24 | **W9 の再調整。** W9 は、ドクトリン帯の再調整（CQI21a）を Gate CQ2 より前に済ませるとした。cq-integ は、その再調整を記録せずに Gate CQ2 を通した。記録では、帯の 6/6 は「孤立した国の集結の不具合」を残すことに依存し、新しい種では、種 90000 で 5/6、種 110000 で 6/6（1,500 シーズンで 1 勝率あたり標準誤差約 1 ポイント） | docs/frontier/DECISIONS.md:441; cq-integ:docs/frontier/DECISIONS.md:589,594; cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:218-262 | 決定 D8〜D10（あなた）: 未回答のまま、既定で進める。W9 の再調整は、実施の記録がないので「W9 の約束の未実施」として書く。不具合を直して帯を再測定するか、5/6 の事実を記録して進めるかは決まっていない。征服は提出物に入らないので、提出物には影響しない | 未決 |
| C45 | **プレイテストの承認。** README は「準備中で未実施」。決定 X4 は、友人テストを 10-06 夜から約 3 実日と計画していた（設計者の記録）。企画担当の記録は 10-03 に「承認も実施もされていない」と述べ、ピッチ（v18、v20）には人数の枠 [N]、[M] がある。あなたの承認の記録はなかった | README.md:136; PITCH.md:48; SUBMISSION.md:107,124; docs/frontier/DECISIONS.md:454; pitch:v18/notes.md:28; playtest:docs/frontier/playtest/PT-C-NOTES.md:1-3 | 決定 D11a（あなた）: 友人テストは開催しない（中止）。README、ピッチ、SUBMISSION は「プロジェクトの外の人はまだ誰も遊んでいない」と書く【やめた】。ピッチの「人が遊んだ」枠（[N]、[M]、[N2]）は使わない。スケジュールと凍結チェックリスト（決定 X4、契約 §11.7）からプレイテストを外す。道具一式は playtest ブランチにあり、文書化され、台本で動く訪問者での練習が済んでいる。人が遊んだ結果ではない | 未対応 |
| C46 | **創業者の主張と開始日。** 0xCiv と 0xARK の説明がピッチの版ごとに違う（v14: 3 作目で 0xCiv は AI 相手の Civilization 風、0xARK は手札を隠すカード。v18: 4 年間 AI と作ってきた、0xCiv の AI 対戦相手、0xARK の支払うエージェント。v20: Solana 上で遊び支払うエージェント）。あなたのメモは実装が 9/14 開始、リポジトリの最初のコミットは 9/21、SUBMISSION は開始日などの確認を求めている。スタジオとの会話を知っているのはあなただけで、記録がない | pitch:v14/final.txt:8; pitch:v18/en.txt:9; pitch:v20/en.txt:8; pitch:conversation/memory-colosseum.md:5,15; SUBMISSION.md:86,90,98,125; git log（最初のコミットは 2026-09-21） | あなた自身の確認事項で、設計の 12 の決定には含めない。提出チェックリストで個別に確認する。確認が取れるまで、未確認の主張（開始日、過去作の説明、スタジオとの会話）は書かない。<br>【確認 Q32】SUBMISSION の [OWNER: confirm] の 3 点（開始日、コードの持ち込みがないこと、AI コーディング支援の記述） | 未決 |

## 5. D 主張・言い回し（7 件）

| ID | 内容 | 出典（ファイル:行） | 決定による解決 | 状態 |
|---|---|---|---|---|
| C12 | **鍵の言い方。** README:70、DESIGN:709、PITCH.md:35、ONE-PAGE-BASE:18 は「AI は鍵を持たない（AI never holds keys）」と書く。契約と主張シートは、これを書くことを禁じ、言ってよいのは「モデルは鍵を見ない」だけとする。全 AI の鍵は公開シードから導出でき、すべて同じ macOS ユーザーで動く（鍵は秘密ではない） | README.md:70; docs/frontier/DESIGN.md:709; PITCH.md:35; pitch-materials:ONE-PAGE-BASE.md:18; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:92,885,925; pitch-materials:CLAIMS.md:60,84 | 文言を次のように置き換える。「モデルは鍵を見ない。署名は別のプロセス（ブレイン）が行う。試験用の鍵は公開シードから導出でき、秘密ではない」。OS ユーザーの分離は、ハッカソンの後の【計画】と明記する。DESIGN.md:709 は後半の補足が正しいので、冒頭の一文だけ直す | 未対応 |
| C17 | **「みんなで 1 つのセーブ」と 6 国。** あなたの一行「みんなで 1 つのセーブのシヴィライゼーション」と旧憲法の柱は、1 つの文明で国同士の対立なし。Wylls は競い合う 6 つの国で、シーズンで終わる。共有エンジンは M3 の設計 | pitch:HANDOFF.md:19-20; docs/earlier-prototype/PERMUTATION_STATE_GAME_CONSTITUTION.md:9,53-57; docs/frontier/DESIGN.md:131,213,360 | 統一書は「1 つの世界を 6 つの国が共有する。共有文明（エンジン）は設計で【設計のみ】、シーズンごとに新しい地図」と書く。旧憲法は歴史の文書（冒頭に置き換え済みの注記がある）。一行の差し替えは、ピッチ作業で行う | 未対応 |
| C30 | **評議会の周期と人間の規則。** 設計（DESIGN:737、W6）は 1 日 1 回、人間と AI が 1 票ずつ。ハッカソンの実行は試験用の周期で、本走は 48 ターン（ゲーム時間 8 時間）ごと、A/B とデモは 24 ターン（4 時間）ごと。人間必須の規則は 0 番の国（運営の席がある国）だけで、A/B の票は運営の台本。ピッチは「人と AI が同じ国を決める」と書く。実行記録では、smoke-b2 と smoke-b3 の評議会は合わせて 18 件で、採択された攻撃命令は 0 件（各国の AI は 1 体で、票は 1 票または 0 票）。slice-4 には評議会がない | docs/frontier/DESIGN.md:737-738; docs/frontier/DECISIONS.md:438; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:528-535,940; pitch-materials:CLAIMS.md:68; ai-integ:docs/frontier/ai-citizens/AC9-REPORT-slice-4.md:63-65; ai-integ:.local/frontier/ai/smoke-b3/report.json（social.council_periods）; ai-integ:.local/frontier/ai/smoke-b2/report.json（同） | 評議会は「試験設定、人間必須の規則は 0 番の席だけ、実機で攻撃命令が採択された記録はまだない」と書く【作成中】。主張シートの G6（3 国以上で攻撃命令が出た）は、結果が出るまで主張しない。設計（1 日 1 回、人間と同数の票）は【設計のみ】として別に書く。ピッチの「人と AI が同じ国を決める」は、個々の行動（同じ鍵・回数制限・霧）についてだけ言える（主張シート D10） | 未対応 |
| C31 | **AI の定義とモデルが決めた割合。** あなたの基準では、隠れた決定論の Bot は「AI」ではなく、モデルが決めるものが AI。しかし自動運転（旧 Shade の方針）が行動の大半を担う。smoke-b3 で、モデルが決めた行動の割合は上限 29.8%（171 件中 51 件）、スライス 4 の実行では 14.4%（146 件中 21 件）。smoke-b3 のモデルが選んだ進軍 10 回のうち、報告書が衝突と数えたものは 9（Y=9）。これは公開の出来事の記録から数えた代用値で、herald の衝突の行は確かめていない（ai-integ の FB2）。衝突の「勝ち」の名前は R12 より前の定義で、野営地を落とした数ではない。標本は小さい | ai-integ:.local/frontier/ai/smoke-b3/report.md:26-35,39-41; ai-integ:docs/frontier/ai-citizens/AC9-REPORT-slice-4.md:26-35; docs/frontier/ai-citizens/GAME-DESIGN-CORE.ja.md:134,316-318; pitch-materials:CLAIMS.md:61 | 統一書に規則を入れる。「AI が決めた」と書くときは、必ず、モデルが決めた行動の割合（by:model）と、衝突に至った自発の進軍の数 Y、決定の数 n を併記する。数字は標本が小さい（6 体、86 ターン）ことを書く。本走の結果が出るまで、これ以上の数字は書かない | 未対応 |
| C44 | **旧試作の主張。** 旧 README-V5 と旧 SUBMISSION は「外部のエージェントが x402 で参加した」と書く。創業者のメモ（HANDOFF）では、自分の試験用クライアント（Hypatia）で、「外部の第三者が来た」とは言わないとある。devnet シーズンの検証記録は、14 人の会員のうち 12 人が運営の AI で、本拠地を征服された都市は 0 | docs/earlier-prototype/README-V5-game.md:9; docs/earlier-prototype/SUBMISSION.md:24,47; pitch:HANDOFF.md:134; docs/earlier-prototype/devnet-season-1790355636798-verification.txt:10,16-17 | その文を削除する。devnet の記録は、名簿の内訳（14 人のうち 12 人が運営の AI、征服された本拠地 0）を添えて、旧試作の履歴として 1 文だけ使う。この記録が Wylls の現在の提出物の根拠にならないことを書く | 未対応 |
| C47 | **チェーンの理由。** あなたの理由は、開いたチェーンでの組み合わせ可能な改造、許可のいらない経済、DeFi。文書の理由は、プログラムが戦闘を解決し、公開ログを検証器が再生できること（「速度や費用のためではない」）。トークノミクスの設計はどの文書にもない | pitch:conversation/memory-colosseum.md:67-69; README.md:34; docs/DESIGN-OVERVIEW.md:122 | 統一書の「なぜチェーンか」を二つに分ける。実測したもの（プログラムによる解決と公開ログの再生。出口シーズンで検証器が 144,300 件の取引を再生し、意図的な改ざん 30 件をすべて検出した【動いている】）と、設計だけのもの（組み合わせ可能な改造、許可のいらない経済、DeFi【設計のみ】）。トークノミクスは「未設計」と書く | 未対応 |
| C48 | **AI市民の表示とバッジ。** バッジは評議会ページにだけあり、メインの地図クライアントにはない。デザイン担当が出荷したかの記録がない（O-AI-7）。評議会ページ（council.html）は ai-integ にあるが、実機のスタックと実モデルでは動かしていない（AC7 の記録） | docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:46,144-145,738; ai-integ:docs/frontier/ai-citizens/AC7-NOTES.md:1-12 | 決定 D2 により、メインの地図クライアントに AI バッジは付けない設計になったので、O-AI-7（デザイン担当が出荷したか）は、メインのクライアントについては不要になる。録画は評議会ページのみ、の既定で足りる。評議会・監査ページのラベルを残すかは C11 の【確認】に統合する | 未対応 |

## 6. E 未設計（5 件）

| ID | 内容 | 出典（ファイル:行） | 決定による解決 | 状態 |
|---|---|---|---|---|
| C09 | **国の意思決定の三重。** 国全体を動かす仕組みが 3 つある。M3 の任務（Mandate）と大臣、征服の「Herald's Call」（日替わりの表示だけの目標）、AI評議会の攻撃命令（コード名 Call）。「Call」が 2 つの意味で使われ、「守り手」「席」の語も重なる | docs/frontier/DESIGN.md:131,194,386-396; cq-integ:docs/frontier/conquest/design/game-design.md:220; cq-integ:docs/frontier/conquest/CONQUEST-CONTRACT.md:95,100; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:46,544 | 統一書で 1 つの物語にする。M1 に国の意思決定はない【動いている】。ハッカソンでは国の評議会と攻撃命令がある（試験設定、オフチェーン）【作成中】。征服の日替わり目標（Herald's Call）は表示だけで、ブランチ上で【動いている】。M3 の任務と大臣が、この 2 つの正式な後継になる、という整理は案で、決定の記録はない【設計のみ】【確認 Q22】。利用者向けの名前は、評議会が採用した目標を「攻撃命令」と書く。「Call」は利用者向けの文言に使わず、コード上の識別子だけに残す。征服の日替わり目標の利用者向けの名前は、決まっていない | 未決 |
| C32 | **あなたの言葉が文書にないもの。** あなたの発言のうち、文書に記録がないものがある。10-04 の「設計を優先する、矛盾がなければ進める、日程ではなく最適な形を採用する」（契約と設計の背骨にだけある）、10-01 の「領土争奪を先に」（cq-integ にだけある）、タグライン『One world. Many wills.』、ルールがゲームで試され産業になるというビジョン、ゲーム内のトークノミクス、スマホ版は不要、Civ 風に見える人物、開幕画面で世界観を伝える、自分の AI を持ち込む人は後、10-03 の「シヴィライゼーション風の MMO」の文 | MAIN events 16500, 12686; XCHAT events 369, 428; PITCH event 2546; UIDES events 5848, 11248（発言記録）; docs/frontier/DECISIONS.md（該当なし） | 決定の記録に新しい部（Y 部、日付 2026-10-04、出典「あなた、チャット」）を作る。D1〜D12 と、上の発言を、日付・出典・要旨の形で記録する。決定 D2 は W2 を変更する、と明記する。内容が食い違うものだけを D1〜D12 で聞いた | 未対応 |
| C33 | **設計の空白: 共有文明の中身。** エンジン、技術、時代の中身（費用、効果、段階のしきい値）、影響力の使い道、科学の使い道、外交の細部は、どの設計文書にもない。旧 V5 の 16 技術の木と時代の計算はコードに残るが、使われていない。決定 D1 の「知識」の得点は、この空白に依存する | docs/frontier/DESIGN.md:213,360,388,407,536,1204; permutation-rules/src/tech.rs:27,49; ai-integ:docs/frontier/ai-citizens/RULES-AND-AI-CITIZENS.ja.md:63 | 統一書に「中身は未設計」と明記する。ハッカソン後の最優先の作業（W8）として、別の設計書を作る。README は、これらが実装済みと読めない書き方にする。D1 の知識の項は、この設計が済むまで中身を決められない | 未決 |
| C34 | **M3 の中身の区切り。** README は M3 に統治・エンジン・技術・市場・外交を含め、概要のロードマップは共有文明（3 番目）と社会 M3（5 番目）を分け、DESIGN:1253 は W8 を M3 の行に入れる。DESIGN の 2.4 節は取引所を「M2/M3」、5 節は M3 と書く | README.md:46; docs/DESIGN-OVERVIEW.md:310-314; docs/frontier/DESIGN.md:202,437,1253,1267 | 概要のロードマップ（共有文明、お金、社会の順）に統一し、DESIGN 第 12 節と第 2.4 節のタグを直す。順序の決定は C20 に統合する | 未対応 |
| C35 | **M3 の設計がお金を前提にしている。** 市民は課金した財布、役職給は USDC、任務はラウレル（賞金）、文明の取り分は賞金の一部。お金なしの統治・エンジン・得点の設計はない。共有文明を先に作る（W8）なら、報酬と得点の設計し直しが要る | docs/frontier/DESIGN.md:385,392,415,475,529 | 決定 D4（無料のシーズンが先）と決定 D1（国の総合得点）により、お金なしの得点と順位は設計できる状態になった。しかし、統治の報酬、役職給、任務の報酬のお金なし版はまだ設計がない。統一書は「M3 の設計はお金を前提にしている。無料のシーズン用の版は未設計」と依存関係を書く | 未決 |

## 7. 征服の未回答 15 問（平易な日本語）

出典: cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:133-155（番号は同ファイルの §7 の表と同じ）。決定 D8〜D10（あなた、2026-10-04）: 15 問は未回答のまま、実装済みの既定で進める。いずれも Gate CQ2 を止めるものではなく、Wave 3 は着手していません。推奨が付いているのは 4 番だけです。

| 番号 | 問い | 既定（今のプログラムの動作） |
|---|---|---|
| 1 | 前哨（2、3村目）の申請券を出すとき、起点にする前哨が、券に書いた州のどれにも属していなくてもよいか。属していないと、奪取中の鍵をプログラムが確認できず、奪われた側が入植費を1回払える隙間が残る | よい。券に州が書かれているときだけ、奪取中の鍵を確認する（試験済み） |
| 2 | 3つ目の村の前提（2つ目の村が確定済みか）と、町以上の前提（最初の村が町以上か）を、起点の前哨からは確かめられない。確かめるべきか | 確かめない。確定前の2つ目の村からでも、3つ目の券を受け付ける。段階は起点の村から読む |
| 3 | 入植費（前哨を築く費用）は券を出すときに払い、券が期限切れになっても、押し出されても返さない。契約は「返す」と書いている。返すか | 返さない |
| 4 | 初期配置の自由都市（持ち主のいない都市）は、占有された場所か。シミュレータは占有扱い、プログラムは空き地扱いで、輪4より外側では空き地が約12か所に1か所多く見える | プログラムの動作（占有されていない）。推奨は、シミュレータに合わせること（保護の床はシミュレータで測ったため） |
| 5 | 包囲を宣言するとき、保護を調べる相手は、宣言を出す軍の出発元の村か、宣言する人の最初の村か | 出発元の村。最初の村が保護中でも、保護のない前哨から宣言できる |
| 6 | 奪取が完了してから処理が済むまでの間に、別の州から戻る兵が、奪われた村に入ってしまう隙間（処理の順序で結果が変わる）を塞ぐか。同じ間に、奪われた側が包囲の賭け金（金500）を払える隙間もある | 塞がない（文書化し、試験で再現するが、その試験は無効にしてある） |
| 7 | 奪われる前の持ち主の行軍が差し戻されるときのチップを、奪った側の資金提供者に払うか、元の持ち主の資金提供者に返すか。契約は何も書いていない | 奪った側の資金提供者に払う。保証金だけ元の持ち主に返す |
| 8 | 自由都市の奪取に成功したとき、包囲の賭け金（金500）を出発元の村に返すか。契約は成功の場合を書いていない（失敗の場合は没収）。シミュレータは毎回返す | 返す（批准済みとして扱う。違うなら言う） |
| 9 | 地区（7州）の1時間ごとの集計の計算予算を、20,000から36,000に上げてよいか（第2次レビュー時の測定は、7州1時間で14,984、最初の集計を含む6時間で33,903。最終ツリーでの再測定は、14,982と33,901）。代案は件数を絞ることで、キーパーの呼び出しが約3倍になる | 36,000（報告として） |
| 10 | 奪取のあと、奪われた村から出ていた古い軍の帰り先が解放されていた場合、その州が閉じるまで待たせてよいか | 待たせる |
| 11 | 包囲宣言の「最終」状態への切り替えは、宣言元が目標と同じ州にあるときだけ働く。別の州にあると、自分の州で招集か駐屯をするまで「未確定」で断られる。これでよいか | このまま受け入れる |
| 12 | 称号「辺境の守り手」のターンの数を、攻める側が砦の上に立ったターンで数えている（守る側がいると、契約が想定する「守った砦」は起きない）。守る側を数えるべきか | 攻める側を数える |
| 13 | 昇格の建設を、前の昇格が完了したターンに出すと、新しい段階が最大2ターン早く、地区の集計の重みに入る（戦闘の結果は変わらない）。直すか | 作ったとおり（早く入る） |
| 14 | 「休眠」の時計が2つある。包囲と解放はシーズンごとの値（7日のシーズンでは3日と7日）、生産の半減と表示は M1 の5日固定。1つにするか | 2つのまま |
| 15 | 地区の集計の時点が、シミュレータはターン 6h−1 の処理後、プログラムとキーパーはターン 6h の処理後で、1ターンずれる。そろえるか | プログラムの時点（ターン 6h の、そのターンの戦闘と決済のあと） |

W9 のドクトリン帯の再調整（C24）は、この 15 問の外にあり、同じく未回答です。

## 8. 原資料との照合で訂正した点

食い違い一覧の元の分析と、原資料を開いて確かめた結果が異なった点です。この表の本文は、確かめた結果で書いています。

1. C02: svm テストの件数は、元の分析では 337 件でした。最終のツリーでは 342 件成功・5 件無視です（integ-CQ2-NOTES.md:237。337 は途中のマージ時点の値）。
2. C04: 元の分析は「征服に 14 日のプリセットがある」と書いていましたが、コードのプリセットは MC_LOCAL_7D、MC_SEASON_28、MC_TEST だけで、14 日のものはありません（cq-integ:frontier-abi/src/v2/presets.rs:458-509）。14 日は決定 D6 による新しい設計値です。
3. C08: 入植者の封印行軍が M3 であるという記述は、契約の 99 行ではなく 98 行です。「カーネルは M2+ と書く」という主張は、該当する記述を見つけられなかったので載せていません。
4. C09: 利用者向けの名前は、元の分析の「攻撃指令」ではなく、契約と決定が使う「攻撃命令」です。
5. C12: 元の分析が挙げた ai-citizens/SUMMARY.ja.md:30 は、鍵ではなく、性格の配り方の乱数についての行でした。「AI は鍵を持たない」と書いてある箇所は、README:70、DESIGN:709、PITCH.md:35、ONE-PAGE-BASE:18 です。
6. C24: 元の分析の「新しい種では 5/6」は、種 90000 では 5/6、種 110000 では 6/6 です（cq-integ の DECISIONS.md:594）。
7. C30、C31: smoke-b3 の閉じたターンは 86 回で、10 分刻みでは約 14 ゲーム時間です（元の分析は 12 ゲーム時間。12 は stack.toml の設定値で、設定にはほかに後始末 26 ターンがあります）。評議会は 9 件すべて採択なしで、票は 1 票または 0 票でした。公開記録（ai-integ:.local/frontier/ai/smoke-b3/pub/council の 9 ファイル）はすべて adopted が false、reason が quorum（定足不足）で、元の分析の「定足不足で閉じた」は記録で確かめられました。この表の初版は、理由を確かめられないとして書いていませんでした。smoke-b2 も、9 件すべての評議会が採択なし（reason は quorum、票は 0 票）でした。
8. C37: 元の分析が挙げた DESIGN.md:519 は、別の内容の行でした。0.980 と余裕 2 ポイントは、DESIGN.md:121、244、517、1295 にあります。
9. C40: 元の分析は矛盾としていましたが、0〜6 日目の範囲ではテスター案内も正しい値です。足りないのは、7 日目以降の 20 回と、1 時間あたりの持ち（30 回、バースト 60）の記述です。
10. C44: HANDOFF の記述は season 1790284871773（参加者 14 人）、検証記録のファイルは season 1790355636798（会員 14 人、運営の AI 12 体）で、シーズンが別です。この表は、各ファイルの記述をそのまま引用しています。
11. C01: frontier/unify にはもともと AI市民のコードがなく、「この木にコードはない」は正しい記述です。古いのは、プロジェクト全体の状態（ai-integ にコードと実行記録がある）と、契約の版（unify のファイルは v1.3）です。
12. C45: playtest の記録に出る「20 人の友人」は、実在の友人ではなく、台本で動くブラウザの訪問者です（PT-C-NOTES.md:3）。
13. C01、C29: 初版は、unify の契約を ai-integ のファイルと「同一」と書きました。ai-integ は、2026-10-04 20:54〜21:00 JST に R12 などの改訂（FB1〜FB5）が入っていて、契約は同一ではありません（ai-integ:docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:420-422,431,639,763,1077）。
14. C31: smoke-b3 の Y=9 は、公開の出来事の記録から数えた代用値です。herald の衝突の行は確かめていません（ai-integ:docs/frontier/ai-citizens/FB2-NOTES.md:15,52）。「勝ち」の名前は R12 より前の定義で、落とした野営地の数ではありません（FB5-NOTES.md:42-45）。
15. C42: 「何も push していない」は、frontier/unify 以降の作業についてだけ正しい記述です。codex/frontier（5ed36fa）と main（5c111f4）は、あなたの承認で公開済みです（docs/frontier/DECISIONS.md:5,24,424）。
16. C09: 初版は「M3 の任務が正式な後継」と「国の日課」という名前を、解決として書きました。どちらも決定の記録がない案なので、取り下げ、状態を未決にしました。

## 9. あなたの確認が要る点（【確認】のまとめ）

1. C11、C48: 評議会・監査ページと名簿（roster.json）の AI ラベルを残すか。契約の「バッジは必ず出す」は決定 D2 と矛盾するので、どちらでも契約の改訂が要る。法的確認（EU AI 法 50 条など）は未実施。
2. C14: 「恨みを持つシヴィライゼーション」の一行を、主張シートの制限（記憶は「引用した」とだけ言える）のもとで残すか。
3. C18: 国の総合得点の式。重みと、一人あたりに換算するかは決まっていません。DESIGN §5.6 の式と食い違う。
4. C20: ハッカソン後の開発の順序（征服、共有文明、お金）。
5. C23: 砦のモデル（OD-1）を、征服設計の中心として確認するか。
6. C22、C24: 征服の 15 問と W9 の再調整（決定 D8〜D10 により未回答のまま、既定で進める）。
7. C46: 開始日、過去作の説明、コードの持ち込みがないこと、AI コーディング支援の記述、スタジオとの会話。提出チェックリストで個別に確認します。
8. C09: 国の評議会・攻撃命令・征服の日替わり目標と、M3 の任務の関係。「任務が後継になる」は案で、決定の記録がありません（付録A Q22）。

## 10. 読んだ資料

作業用の資料（リポジトリ外）:
- DECISIONS-OWNER-2026-10-04.md（あなたの決定 D1〜D12 と書き方の規則）
- matrix.json（分析の行列。conflicts の 48 件、owner_decisions、outline、docs_to_retire_or_banner）
- readers-full.json（七人の読み手の約 400 の記述）、readers-summary.json
- feasibility.json（即時付与と征服の組み込みの見積もり）

frontier/unify（head 19fe89c）:
- README.md、README.ja.md、PITCH.md、SUBMISSION.md
- docs/DESIGN-OVERVIEW.md、docs/DESIGN-OVERVIEW.ja.md
- docs/frontier/DESIGN.md、DECISIONS.md、SUMMARY.ja.md
- docs/frontier/m1/M1-CONTRACT.md
- docs/frontier/ai-citizens/ の契約、GAME-DESIGN-CORE.ja.md、RULES-AND-AI-CITIZENS.ja.md、SUMMARY.ja.md
- docs/frontier/conquest/CONQUEST-CONTRACT.md、SUMMARY.ja.md
- docs/earlier-prototype/ の README-V5-game.md、SUBMISSION.md、PERMUTATION_STATE_GAME_CONSTITUTION.md、PERMUTATION_STATE_GAME_DESIGN_V5.md、devnet-season-1790355636798-verification.txt
- コード: frontier-abi/src/presets.rs、permutation-rules/src/frontier/holding.rs と pools.rs、permutation-rules/src/tech.rs、permutation-gateway/src/frontier/quota.mjs
- origin/main の README（git show）、git log

ai-integ（head bbf452a。読み始めは 0cc0973。smoke-b3 の記録は b41dd1b の時点）:
- docs/frontier/ai-citizens/ の AI-CITIZENS-CONTRACT.md（v1.3）、RUNS.md、GAME-DESIGN-CORE.ja.md、RULES-AND-AI-CITIZENS.ja.md、SUMMARY.ja.md、AC7-NOTES.md、AC9-REPORT-slice-4.md と .json
- .local/frontier/ai/smoke-b2、smoke-b3 の report.md と report.json（git で管理されない生成物）

cq-integ（head 6ec65e4）:
- docs/frontier/conquest/ の CONQUEST-CONTRACT.md（v1.5）、integ-CQ2-NOTES.md、SUMMARY.ja.md
- docs/frontier/DECISIONS.md（征服の部）
- frontier-abi/src/v2/presets.rs

playtest（head 0058f78）:
- docs/frontier/playtest/ の TESTER-GUIDE.md、PT-C-NOTES.md

リポジトリ外の資料（outputs/.claude/data/）:
- pitch-materials/ の ONE-PAGE-BASE.md、CLAIMS.md、FIX-LIST.md、SHOT-LIST.md
- game-design/REDESIGN-v4.ja.md

ピッチ（outputs/pitch/）:
- v14/final.txt、v18/en.txt と notes.md、v20/en.txt と structure.md、build20.js、HANDOFF.md、conversation/memory-colosseum.md
- outputs/README.md（先頭）

読んでいないもの: 相談チャットの書き起こしの原文（MAIN、PLAYER、PITCH、XCHAT、UIDES）。あなたの発言の引用は、読み手の記録（readers-full.json、matrix.json）の要約と番号によります。

## 11. 統一設計書（docs/GAME-DESIGN.ja.md）での扱い

48 件のそれぞれが、設計書のどこで解決されているか、またはどこで未決として残っているかを示します。「付録A Qn」は、設計書の付録Aの【確認】の番号です。文書の修正（第2節〜第5節の「未対応」）は、設計書の 8.6 に一覧にしました。

| ID | 設計書の章 | 扱い |
|---|---|---|
| C01 | 0.2、4.9、8.2、8.6 | 状態を3段で記述。文書の修正は 8.6 |
| C02 | 5.4、5.6、8.6 | cq-integ の実際と、提出物に含まれないことを並べて記述 |
| C03 | 4.1、10.1（D11b） | 解決。6/12/18 と、将来の無料シーズンの約12体を別の行に記述 |
| C04 | 6.2、5.3、10.1（D6） | 設計上の長さ、実走したプリセット、AI本走の長さを別項目に。14日の細部は未決（付録A Q14） |
| C05 | 2.2、3.7、9.2 | 現在の動作を、現在の動作として記述 |
| C06 | 2.2、10.1（D3）、10.3 | D3 で決定。設計のみ |
| C07 | 3.6、5.1、5.2、8.6 | M1 と征服線を書き分け。DESIGN.md への注記は 8.6 |
| C08 | 3.7 | 1つの表（M1、征服線、M3） |
| C09 | 7.7、9.1 | 3つの仕組みを並べて記述。整理案は未決（付録A Q22） |
| C10 | 4.7、9.2 | 限定つきの言い方を固定 |
| C11 | 4.6、9.3 | D2 で変更。ラベルを残すかは未決（付録A Q2） |
| C12 | 4.7、9.3、8.6 | 「モデルは鍵を見ない」に固定 |
| C13 | 4.10、9.3、8.6 | 設計書に約束の語を載せない。旧文書への帯は 8.6 |
| C14 | 9.3、9.4 | 「恨みを持つ」の一行は未決（付録A Q26） |
| C15 | 6.6、9.3 | D5 に従って記述。公の場での言い方は未決（付録A Q18） |
| C16 | 1.5、10.1（D12）、8.6 | D12 の軸 |
| C17 | 1.2、10.3 | 1つの世界を6国が共有する形で記述 |
| C18 | 6.3 | D1 で決定。式は未決（付録A Q6） |
| C19 | 6.5 | D4 に従って記述 |
| C20 | 7.9、8.5 | 未決（付録A Q13） |
| C21 | 5.6 | O-AI-8 の理由を更新して記述 |
| C22 | 5.7 | D8〜D10 により未決。既定つきで15問を記述（付録A Q31） |
| C23 | 5.3 | 未決（付録A Q11） |
| C24 | 5.4、10.2 | 未決（付録A Q30） |
| C25 | 5.3、3.7 | 表で記述 |
| C26 | 3.7、5.7、8.6 | M1 の休眠規則を正として記述 |
| C27 | 9.1、8.6 | 用語表 |
| C28 | 冒頭の表、8.6 | この文書を唯一の源にする |
| C29 | 4（冒頭）、8.6 | 契約 v1.3 に揃えて記述 |
| C30 | 4.5、9.2 | 試験設定と、採択の記録がないことを記述 |
| C31 | 4.2、4.5、9.4 | 「AIが決めた」と書く条件。Y は代用値と書く |
| C32 | 10.1、10.3 | 決定Yとして記録。記録のない発言は 10.3 |
| C33 | 7.6、7.8 | 中身は未設計と明記 |
| C34 | 7.9、8.5 | ロードマップに揃えて記述 |
| C35 | 7.8 | 依存関係を記述 |
| C36 | 6.2、6.4 | 28日基準、ランプは未決（DESIGN の D22） |
| C37 | 6.4 | 保留種の値を採用 |
| C38 | 6.4、9.2 | 言い方を訂正 |
| C39 | 6.4、8.6 | M1 のプログラムの値を採用 |
| C40 | 6.1 | quota.mjs の値を正として記述 |
| C41 | 6.2、6.4 | 年代記は設計のみ。余りの送り先は未決（付録A Q16） |
| C42 | 8.1、8.6 | push の可否は未決（付録A Q24） |
| C43 | 3.7、9.1、11 | 「もらう」と「築く」を書き分け。旧試作の呼び分け |
| C44 | 9.2、11 | 旧試作の履歴として1回だけ |
| C45 | 3.11、8.2、8.3、8.6 | D11a で中止 |
| C46 | 付録A Q32 | あなた自身の確認事項 |
| C47 | 1.6 | 実測したものと設計だけのものに分けて記述 |
| C48 | 4.6 | D2 により統合。ラベルは付録A Q2 |

## 12. 反映状況（2026-10-04 夜の編集のあと）

この節は、上の表を書いた後に、README(.ja)、DESIGN-OVERVIEW(.ja)、PITCH.md、SUBMISSION.md、DEMO_SCRIPT.md、DECISIONS.md、docs/frontier の要約と README、DESIGN.md、ピッチ素材を書き換えたときの記録です。表の各行の「状態」の列は、書き換えていません。48件すべてを再点検したわけではなく、第三の読み手が17件を抜き取りで確かめた結果と、編集で直した点だけを書きます。

| 区分 | 件 | 内容 |
|---|---|---|
| 文書に反映済みと確認した | C03、C04、C05、C07、C11、C12、C16、C19、C26、C31、C32、C34、C37、C38、C39、C45、C48 | 抜き取りの確認で、文書の該当箇所が決定どおりに直っていた |
| この編集で直した | C02、C28、C29、C44、C47 | C02: 征服契約と要約（v1.1）に、cq-integ の v1.5 が正という帯を付けた。C28: 連結した日本語文書の「オーナー」を「あなた」にした。C29: 契約の版を v1.3 に揃えた。C44: README の以前のプロトタイプの文に、参加者14人のうち12人が運営のAIで、本拠の征服は0という内訳を添えた。C47: README に、チェーンのもう1つの理由（設計のみ）と、トークノミクスは未設計という文を加えた |
| 残っている | C01 | docs/frontier/ai-citizens/GAME-DESIGN-CORE.ja.md の395行目が「AI市民のコードはまだありません」のまま。このファイルは契約の設計の背骨で、19fe89c と同じに保っているため、あなたの返事のあとに直す |
| 残っている | C42 | origin/main の README は古い試作のまま。push は、あなたが指示したときだけ |
| 決定待ち | C06、C09、C10、C14、C15、C18、C20、C22〜C24、C46 ほか | あなたの決定または確認が要る行は、決まるまで現状の書き方を保つ。【確認 Qn】で印を付けてある |

