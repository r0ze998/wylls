# C. Realms Eternum / Realms Blitz の公開プレイヤー体験

調査日: 2026-10-29（WebSearch / WebFetch による読み取り専用調査。X は api.fxtwitter.com 経由で公開投稿のみ取得。GitHub は `gh` で公開 issue のみ閲覧）
目的: WYLLS との UX 比較の材料。

## 0. 読む前の注意（バイアスと信頼性）

- **声の母集団が偏っている。** 見つかった一人称の体験談は、優勝トライブ（orden）、エコシステム関係者（StarkWare 社員の Odin、FOCGERS、Wolf Pack League 所属のライター）、長期プレイヤー（Nexonik、Cumberlord、KrumpyLumpkins）にほぼ限られる。**途中でやめたカジュアル層の声は見つからなかった**（生存者バイアス）。「不満が少ない」と読むのは誤り。
- **Reddit・独立系レビュー（GAM3S.GG / DappRadar / PlayToEarn の評価記事）・YouTube のコメントは、実質的に取得できなかった。** PlayToEarn と Bankless の記事は告知や宣伝の色が強い。
- **GitHub issue が最も具体的な「声」の供給源だった。** 2025年9月の Blitz プレイテストでは、プレイヤーの発言が issue 本文に引用されている（Lord_kb、defiedpiper、cryptodyosh など）。ただし、issue を起票したのは開発者で、要約されている。
- **信頼性の低い情報源:** Medium の @Oddsanjay「The Evolution of Eternum」（2026-01-28）。Season 3・Season 4 の詳細な数値（同時接続 6,800、継続率 68% など）を出典なしで載せている。公式 docs は「Season 1 は終了、Season 2 は開発中」としており、**内容が一次情報と矛盾**する。本ノートでは「信頼性低」と明記したうえで参考扱いにとどめる。
- ラベル: 「プレイヤーが報告」「レビュー」「開発/運営の発言」「推測」。原文の引用は 15 語以内。それ以外は要約。

---

## 1. 情報源一覧（ID → 以降で参照）

| ID | 情報源 | 日付 | 書き手の種別 | 版 |
|---|---|---|---|---|
| S01 | orden「eternum s0 - an orden recap」 https://x.com/orden_gg/status/1873316296009629921 | 2024-12-29 | プレイヤー（S0 優勝トライブ、約18人） | Eternum S0 |
| S02 | Odin「brothers in eternum... the real season 0 story」 https://x.com/odin_free/status/1873664756885704730 | 2024-12-30 | プレイヤー（StarkWare の Head of Product Growth。エコシステム関係者） | Eternum S0 |
| S03 | Realms 公式「Season 0 crowns its champions」 https://x.com/RealmsEternum/status/1872493966916235630 | 2024-12-27 | 運営 | S0 |
| S04 | Sovereign Frontier「Play Eternum…」 https://sovereignfrontier.substack.com/p/play-eternum-to-experience-fully | 2024-12-14 | ガイド執筆者（プレイ体験の記述なし） | S0 |
| S05 | FOCGERS「Eternum Game Guide」 https://x.com/FOCGERS/status/1866802676371165551 | 2024-12-11 | コミュニティのガイド（ローンチ前） | S0 |
| S06 | FOCGERS / heynejc「Eternum Guide to Settling: Village or Realm」 https://x.com/FOCGERS/status/1925536860056551835 | 2025-05-22 | プレイヤー兼ガイド | Eternum S1 |
| S07 | Bankless（W. Peaster）「Eternum Season 1…」 https://www.bankless.com/read/eternum-season-1-starknet および「Eternum Returns to Starknet」 https://www.bankless.com/read/eternum-returns-to-starknet | 2025-04-30 | レビュー（宣伝色あり）＋開発者 Loaf の発言 | S0 の振り返り / S1 |
| S08 | PlayToEarn「Play to Earn in Eternum Season One」 https://playtoearn.com/news/play-to-earn-in-eternum-season-one | 2025-04-30 | ニュース | S1 |
| S09 | StarkWare の X 投稿 https://x.com/StarkWareLtd/status/1922692394421461127 | 2025-05-14 | エコシステム（運営寄り） | S1 |
| S10 | StarkWare の X 投稿 https://x.com/StarkWareLtd/status/2002290372655853596 | 2025-12-20 | エコシステム（運営寄り） | Blitz |
| S11 | Bankless「What Onchain Gaming Learned in 2025」（FOCGERS の nejc による寄稿） https://www.bankless.com/read/crypto-gaming-year-in-review | 2025-12-30 | レビュー（関係者による寄稿） | Eternum（Villages 導入後のシーズン）/ Blitz |
| S12 | Nexonik「Blitz vs. Eternum: Which is Right for You?」 https://x.com/Nexonik/status/2013956510972260752 （公式が https://x.com/LootRealms/status/2014033688917365239 で引用） | 2026-01-21 | 長期プレイヤー | Eternum 全般 / Blitz |
| S13 | Medium @AlexiaChukwuma「Eternum or Blitz…」 https://medium.com/@AlexiaChukwuma/eternum-or-blitz-choosing-your-battle-in-starknets-flagship-rts-c017ef48cb98 （RSS 経由で取得） | 2026-01-23 | コンテンツ制作者（Wolf Pack League 所属） | Eternum / Blitz |
| S14 | Medium @Oddsanjay「The Evolution of Eternum…」 https://medium.com/@Oddsanjay/the-evolution-of-eternum-or-how-i-learned-to-stop-worrying-and-love-onchain-chaos-2e9f29fd06cd | 2026-01-28 | 書き手不明（**信頼性低**） | 自称 S1〜S4 / Blitz |
| S15 | eGamers（KrumpyLumpkins インタビューの要約） https://egamers.io/realms-world-offers-a-look-at-upcoming-blitz-changes-buy-ins-elite-brackets-and-onchain-prediction-markets/ | 2026-09-30 | ニュース＋運営/コミュニティの発言 | Blitz |
| S16 | eGamers「Realms Playtest Goes Live…」 https://egamers.io/realms-playtest-goes-live-putting-frontier-and-blitz-on-a-single-site/ | 2026-10-22 | ニュース | Blitz / Frontier |
| S17 | GitHub BibliothecaDAO/eternum の issue 群（個別番号は本文中に記載） https://github.com/BibliothecaDAO/eternum/issues | 2024-12〜2026-10 | プレイヤー報告を開発者が転記したもの、およびプレイヤー本人の起票 | S0 / S1 / Blitz |
| S18 | Alchemy の dapp ページ https://www.alchemy.com/dapps/realms-world | 日付なし | ディレクトリ | 不明 |
| S19 | Realms docs のリンク集 https://eternum-docs.realms.world/overview/links | 2026-10 閲覧 | 運営 | — |

---

## 2. 8つのプレイ場面

### 場面1: ゲームを知ってから最初の操作まで

- **プレイヤーが報告（S02, 2024-12-30, Eternum S0）:** 新規には極めて厳しかったと総括している。原文: "the learning curve was steep…a damn vertical wall."。同じ記事で「Season 1 では AI エージェントが新規を支える」と期待も述べている。書き手は StarkWare の社員で、エコシステム側の人物。
- **レビュー（S04, 2024-12-14, S0）:** 早期参加の利点と引き換えに、原文 "get to experience all the bugs and lags" とする。準備としてウォレット（Argent / Braavos）、Season Pass、Discord 参加を挙げている。
- **コミュニティのガイド（S05, 2024-12-11, S0）:** 開始前に必要な手順として Starknet ウォレット、Cartridge Controller、Season Pass（Discord の配布か購入）、任意で $LORDS の購入を挙げる。**推測:** 最初の操作の前に、ゲーム外の準備が 3〜4 段ある。
- **開発/運営の発言（S17 #2521, 2024-12-15, S0。起票者 LordSecretive は運営寄りのコミュニティメンバーと推測）:** 「到着→大きなロード→ログイン→大きなロード→プレイ→短いロード」の流れを問題視し、再訪するたびにクリックとロードが 2 回あるのが煩わしいとしている。原文: "going away and coming back to click to load again x2 is annoying"。
- **開発/運営の発言（S17 #2514, 2024-12-14, S0）:** 離脱率（bounce rate）を下げるため、ロード画面にゲームガイドへのリンクと豆知識を置く提案。**推測:** S0 中に、ロード中に離脱する人がいると運営が認識していた。
- **開発/運営の発言（S17 #1958, 2024-11）:** オンボーディングのポップアップに「固まったらリロードして」と書くよう提案している。
- **プレイヤーが報告（S17 #2528, 2024-12-15, S0。起票者 mmkholerdi）:** 普通のノート PC では非常に重く、見た目の演出を切るオプションがほしいという要望。
- **反証になる声（S09, 2025-05-14, S1）:** StarkWare は "with all blockchain complexity abstracted away" と主張している。運営寄りの発言。
- **レビュー（S07, 2025-04-30, S1）:** S1 では Village Lords が導入され、NFT なしで現金やステーブルコインで参加できる。**参入の簡略化はオンボーディングの不満への対応**と読めるが、記事中に明示はない（推測）。
- **プレイヤー兼ガイド（S06, 2025-05-22, S1）:** Village は約 $5 で、クレジットカードでも購入できる。
- **開発/運営の発言（S17 #5052, 2026-10-16, Blitz/Frontier）:** 2026 年時点でも、ゲームに入るまでの手順と画面探しが多すぎると自己評価している。原文: "takes more steps and more screen-hunting than it should"。ロード中の待機表示がないこと、モバイルが縮小版にすぎないことも課題に挙げている。
- 独立した情報源の数: **「最初の障壁が高い」系は 5 件**（S02 / S04 / #2521 / #2514 / #5052。うち 3 件は運営側）。**反証は 1 件**（S09。運営寄り）。

### 場面2: 拠点の設立と最初の生産

- **プレイヤーが報告（S01, S0）:** 開始前に「infinite planning」をした結果、レア資源が足りないと分かり、市場で Season Pass を追加購入して生産チェーンを埋めた（wonder pass 5 枚で 5,560 $LORDS）。隣接農場による +10% を狙った建設計画は、実戦では緩い指針に変わった。
- **プレイヤーが報告（S01, S0）:** 出現位置が中央銀行から遠く不利だった。原文: "spawning in at a 'disadvantageous' location, far from the bank"。
- **プレイヤーが報告（S02, S0）:** 最初の 1 週間は生産チェーンの構築に充てた。
- **プレイヤー兼ガイド（S06, S1）:** 初手の助言は「食料農場を先に建てる」「builders hut 用に labour を 250k 確保する」。トライブのロジスティクス担当 Nexonik の発言として紹介されている。
- **プレイヤーが報告（S17 #3218, 2025-05-14, S1。起票者 starknetdev）:** 軍を選ぶと "Missing wheat and fish" と出るが、何が足りないのか分からない。原文: "Not sure what the missing resources are referring too"。
- **プレイヤーが報告（S17 #3670, 2025-09, Blitz プレイテスト。Lord_kb）:** 生産の「max」ボタンの値が多すぎる。原文: "have to click max, than manually reduce by 10% or guess"。
- **開発/運営の発言（S17 #3755, 2025-10-13）:** 「standard/simple production」と「labor production」という用語がユーザーを混乱させているとして、改名を提案。
- **プレイヤーが報告（S12, 2026-01-21）:** Eternum では NFT によって持てる Realm の数が違い、開始位置に差が出る。原文: "sparked some player controversy over fairness"。
- **レビュー（S13, 2026-01-23）:** 同じ公平性の問題を "Is it pay-to-win if NFT holders start stronger?" と問いかけている。
- **独立した情報源の数:** 開始条件の不公平感は 3 件（S01 の位置、S12、S13）。生産 UI の分かりにくさは 3 件（#3218、#3670、#3755）。

### 場面3: 建物や兵の材料集め

- **プレイヤーが報告（S12）:** Eternum の資源は 22 種で、各 Realm が作れるのはその一部だけ。原文: "Eternum has a complex resource chain" / "P2P trading is essential"。Blitz は 9 種に減らし、どの Realm でも全資源を作れるので交易は不要。
- **プレイヤーが報告（S01, S0）:** 最初の 4〜5 日は工場を回し、その後は軍の生産に全振りした（帝国全体で 1 日 75 万体以上）。
- **プレイヤーが報告（S17 #2526, 2024-12-15, S0。bob0005）:** 投入資源が足りなくても生産建物を建てられるようにしてほしいという要望。
- **開発/運営の発言（S17 #3623, 2025-09）:** UI では資源が足りているように見えるのに建てられない不具合。プレイテストで判明した。
- **ニュース（S08, S1）:** Labor への変換で資源が目減りする（石→labor→石で減る）。
- **レビュー（S07, 開発者 Loaf の発言を含む）:** Labor は、資源管理に圧倒されがちなカジュアル層のための簡略化として導入された。
- **信頼性低（S14）:** 「Season 2 の labor 制度は賛否が分かれた」「学習曲線が急になった」と書いているが、出典がない。
- **独立した情報源の数:** 資源チェーンが複雑だという指摘は 3 件（S12、S13、S07 の運営側の認識）。

### 場面4: 資源と兵の移動

- **プレイヤーが報告（S01, S0）:** 交易の手間を減らすため、トライブ内製ツール「nexus」を作った。原文: "significantly reducing the overhead of sending trades between realms"。シーズンを通じて使い捨てたロバは 1,100 万頭超（皮肉まじり）。届け先は Discord でメンションすれば誰かが運んでくれる運用だった。**推測:** 標準 UI だけでは多拠点の物流が回らず、外部ツールと人手で補っていた。
- **開発/運営の発言（S17 #2576, 2024-12-21, S0）:** 「銀行へロバを送って資産をブリッジアウトしている最中に Realm を奪われた」ユーザーの事例。
- **プレイヤー/コミュニティ（S17 #2493、#2494, S0）:** 資源の送付で完全に正確な入力（句読点）を求められる。輸送ウィンドウの情報が不足している。
- **プレイヤーが報告（S17 #3262〜#3264, 2025-05-15, S1。Cumberlord）:** Realm の並べ替え、距離順の表示、手元にない資源も一覧から選べるようにすることを要望。コメントでは名前の変更や資源の絵文字を付けたいという声もある。
- **プレイヤーが報告（S17 #3290, 2025-05-18, S1。robertkodra）:** Village が多いとドロップダウンからの移動が煩雑なので、マップから直接開きたい。
- **プレイヤーが報告（S17 #3374, 2025-05-27, S1。robertkodra）:** 自動化の設定を誤ると収拾がつかないので、一括停止ボタンがほしい。原文: "if I messed up my automation things goes banana"。
- **プレイヤーが報告（S17 #3243, 2025-05-14, S1。Cumberlord）:** 兵の移動の処理中にウィンドウを閉じると、ゲーム全体がフリーズする。
- **プレイヤーが報告（S17 #3667、#3669, 2025-09, Blitz プレイテスト。Lord_kb）:** realm 間で兵や資源を送受信するとフリーズする。ハイライト表示される最大移動距離が 1〜2 マス過大。
- **プレイヤーが報告（S17 #3666, 同上。Lord_kb）:** 移動先を選ぶ際のメッセージ窓が他の候補マスを隠し、比較できない。
- **開発/運営の発言（S17 #3171, 2025-05-12, S1）:** ブリッジで持ち込むと 75% の効率に加えて手数料 7.5% がかかり（Village 宛てならさらに 5%）、100 石が約 65〜69 石になる。これを UI に表示すべきという issue。
- **独立した情報源の数:** 移動と輸送の操作負荷に関する指摘は**最多で、プレイヤー本人の報告が 5 人以上**（orden、Cumberlord、robertkodra、Lord_kb、bob0005）。

### 場面5: 交易と協力

- **プレイヤーが報告（S01, S0）:** FOCG Bois と同盟し、他勢力とは不可侵条約を結んだ。Gislegob との 2 日間の和平は破られた。10 日目に複数トライブで終戦に合意した。原文（称賛）: "real comradery being built between players"。
- **プレイヤーが報告（S02, S0）:** チャット内にスパイがいると疑い、偽情報を流した。社会的な連携が戦力より効くこともあると総括している。
- **プレイヤー兼ガイド（S06, S1）:** 隣人選びが生死を分ける（検索結果の要約による）。Village は隣接する Realm にしか兵を送れない。
- **開発/運営の発言（S17 #2366, 2024-12-10, S0）:** 市場で取引した注文が「incoming」に表示されない。
- **レビュー（S11, 2025-12-30）:** 「Pope」というプレイヤーが Eternum 内で宗教を始めた例を、創発的な社会性として紹介している。
- **プレイヤーが報告（S12）:** Blitz にはプレイヤー間の市場がない。**推測:** 交易と協力の体験は Eternum に固有で、Blitz では意図的に省かれている。S13 も「Blitz は交易と経済の層を失っている」と指摘する。
- **信頼性低（S14）:** 大同盟が資源を寡占し、終盤が停滞した。
- **独立した情報源の数:** 外交や協力を楽しんだ記述は 3 件（S01、S02、S11）。協力の負担や停滞の指摘は、信頼できる情報源では**未発見**（S14 のみ）。

### 場面6: 戦闘リスクの判断と結果の確認

- **プレイヤーが報告（S17 #3671, 2025-09, Blitz。Lord_kb）:** ワールドビューでは守備 2,900、攻撃ダイアログでは 5,900 と表示が食い違う。
- **プレイヤーが報告（S17 #3673, 同上。Lord_kb）:** 白い点（敵）の軍に何が起きたか確認できない。原文: "Cant see what happened to this army with white dots."
- **プレイヤーが報告（S17 #3662, 同上。defiedpiper ほか）:** 倒した軍がリロード後も表示され続ける「phantom army」が複数件。
- **プレイヤーが報告（S17 #3674, 同上。Lord_kb）:** 作れる軍の数がリロードするまで 2,000 のまま更新されない。
- **開発/運営の発言（S17 #3618, 2025-09-18）:** プレイテストで、戦闘タイマーが地図上に見えない、軍と出身 realm の対応が分からない、守備兵の構成が分かりにくい、といった指摘があった（raschel、KrumpyLumpkins）。
- **プレイヤーが報告（S17 #4261, 2026-02-20, Blitz。lordcumberlord、vorpalsword21）:** キャンプやハイパーストラクチャーへの攻撃が、理由の表示なく失敗した（原因は免除期間の設定）。開発側も "silent transaction fail is bad UX" と認めている。
- **プレイヤーが報告（S17 #4264, 同上。lordcumberlord）:** T2 騎士の軍が地図から消え、兵を失ったうえ、その枠に再配置もできなくなった。
- **プレイヤーが報告（S01, S0）:** 戦闘後も終了処理されず隠れている軍を見つけるため、独自のフィルタを作った。
- **プレイヤーが報告（S02, S0）:** 未配備の兵 17 万を抱えた大勢力に奇襲が成功した。原文: "we caught them slipping with 170k undeployed troops."。勝因は腕前よりタイミングと注意深さだとしている。
- **開発/運営の発言（S17 #2413, 2024-12-11）:** 終わった戦闘の通知を出すべきという issue。
- **独立した情報源の数:** 戦力表示や結果の可視性の問題は、**プレイヤー本人の報告が 4 人以上**（Lord_kb、defiedpiper、lordcumberlord、vorpalsword21）に加え、開発側の issue が 2 件以上。

### 場面7: 離れて戻ってくる（不在中の出来事の把握）

- **プレイヤーが報告（S01, S0）:** 通知ボットの不具合の間に ignium realm を奪われた。原文: "an issue with our aforementioned notification bot"。**推測:** 自作の通知に頼らないと不在中の防衛が成り立たない設計だった。
- **プレイヤーが報告（S01, S0）:** コア 6 人が 2 人 1 組で 24 時間体制を組み、1 人あたり約 50 realm を管理した。原文: "the majority of our players had been playing 12-18h days"。クリスマス前で、疲労が溜まっていたと書いている。
- **反証になる声（S02, S0）:** 自分たちは 24 時間体制を組まなかったと明言している。原文: "no fancy titles, no 24/7 schedules"。それでも大勢力への奇襲を成功させた。
- **プレイヤーが報告（S12）:** Eternum は数週間にわたる毎日の関与を求める。原文: "demanding regular daily engagement over several weeks"。
- **レビュー（S13）:** シーズンは 3〜6 週間で、終了日が決まっていない。真剣に競うなら毎日のログインが必要。
- **開発/運営の発言（S17 #2521）:** 再訪するたびにロードが 2 回あるのが煩わしい（場面1 を参照）。
- **開発/運営の発言（S17 #3023, 2025-05-06 / #3614, 2025-09-18）:** 資源の到着を通知すべき。リロードしないと、realm の所有者の変化や生産量が反映されない。
- **開発/運営の発言（S17 #3756, 2025-10-13）:** プレイヤーは relic を持っていても気づいていない。原文: "Players are not noticing when they have relics"。
- **開発/運営の発言（S17 #3863, 2025-11-16）:** 「Activity Chronicles」の出来事一覧から、地図上の現場へ飛べるアイコンを追加。**推測:** 不在中の出来事を追うための履歴 UI を後から整えている。
- **独立した情報源の数:** 不在のリスクと拘束時間の重さは 4 件（S01、S12、S13、#2521）。「戻ってきて何が起きたか分からなかった」と**プレイヤー本人が具体的に語った声は未発見**。通知と更新の不足は開発側の issue からのみ読み取れる。

### 場面8: 負けたり遅れたりした後の再参加

- **プレイヤーが報告（S01, S0）:** await_0x は約 15 realm を orden に奪われた後、orden に加入した。**推測:** 負けた側の再起の道筋として、勝者側への合流が実際に起きている。
- **プレイヤーが報告（S02, S0）:** ハイパーストラクチャーの抽選結果が厳しく、目標を変えざるを得なかった。原文: "the random draw was just brutal and we had to shift targets."
- **ニュースと運営（S08 / S06, S1）:** Village は奪われず略奪されるだけ。一方、Realm は奪われると「永遠に失われる」。
- **開発/運営の発言（S15, 2026-09-30, Blitz）:** Blitz は毎試合リセットされ、何も持ち越さない。**推測:** 「遅れたら次の試合で再挑戦」という構造で、場面8 に対する設計上の回答になっている。
- **開発/運営の発言（S17 #4316, 2026-02-27。kingofrealms69 の機能提案）:** ベテランだらけのサーバーに入った新規は即座に一掃されて去る、という問題意識を書いている。原文: "New players hitting a server full of veterans get wiped immediately and leave."。**データではなく提案者の認識。** 同じ提案者が MMR に応じたハンデ（#4294）、PvE のソロ挑戦（#4324）も提案している。
- **信頼性低（S14）:** Season 1 の最大の不満は「ソロが圧倒された」こと。
- **独立した情報源の数:** 負けた後の再参加を**プレイヤー本人が語った声は未発見**。間接的な材料が 3 件（S01、#4316、S14）。

---

## 3. 横断テーマ

### 3-1. 継続・離脱・残った理由

- **プレイヤーが報告（S01, S0）:** 約 18 人で始め、終盤まで活動したのは約 15 人。FOCG では標準的な継続率だとしている。称賛として "the round was an absolute blast"。
- **プレイヤーが報告（S02, S0）:** "top-tier entertainment, would recommend."
- **プレイヤーが報告（S01）:** 疲労が理由として挙がっている（12〜18 時間プレイの日が続いた）。
- **開発/運営の発言（S15, 2026-09-30）:** Realms のゲームは休止中で、再開日は未定。原文: "Everyone's waiting for Realms games to return"。2026-10-21 からプレイテストが開かれている（S16）。
- **やめた理由を語る一人称の声は未発見。**

### 3-2. オンボーディングにかかる長さ

- 時間や分単位の数値は**未発見**。手順の多さは S05 と #5052、学習曲線は S02 から読み取れる。Blitz の Recruit 枠（無料・賭けなし）は、運営が「学習用」と位置づけている（docs、S15）。

### 3-3. ボット・ホエール・複数アカウント

- **ホエール的な集中（S01, S0）:** 隣の Gislegob は 500 以上の realm と 300 万超の初期兵力を持ち、orden は「Great Grey Wall」と呼んだ。**推測:** Realm NFT を大量に持つ勢力が S0 の構図を決めていた。
- **NFT による開始時の格差（S12、S13）:** 公平性をめぐる議論として 2 件。
- **ボット:** 信頼できる情報源では**未発見**（S14 の「Season 3 でボットが出た」は信頼性低）。
- **複数アカウント / Sybil:** **未発見**。Village は約 $5、NFT 不要、譲渡不可なので、**推測:** 複数アカウントの費用は低い。ただし、それを問題にした声は見つからなかった。Blitz は「1 ウォレットにつき 1 回登録」と docs に明記されている。
- **自作ツールによる格差（S01）:** nexus ツールや通知ボットを持つトライブが有利だった。**推測:** 公式の UI と自作ツールの差が、実質的なホエール要因になっている。

### 3-4. コスト（ガス代・手数料・参加費）

| 項目 | 内容 | 出典・日付 |
|---|---|---|
| Season Pass | Realm NFT の保有者は無料。それ以外は二次市場で購入 | S07 2025-04-30 |
| Village | 約 $5。クレジットカード可 | S06 2025-05-22 |
| orden の追加投資 | wonder pass 5 枚で 5,560 $LORDS | S01 2024-12-29 |
| ブリッジ手数料 | 75% の効率 ＋ 7.5% の手数料（Village 宛てはさらに 5%） | #3171 2025-05-12（開発） |
| Blitz | Recruit は無料。有料枠の参加費は 70% が賞金、15% が Lordship、15% が開発へ。docs の例では 250 $LORDS | S15 2026-09-30 |
| Blitz の賞金受け取り | 「受け取りにトークンが要る」と表示され、受け取れない（cryptodyosh）。原文 "how to get tokens to claim blitz prize? or is this a bug?" | #3675 2025-09-28 |
| ガス代 | 「10 週間で $30〜50」との記述あり | S14（**信頼性低**） |

### 3-5. 称賛されている点（反証を含む）

- **深さ・Civ 的な面白さ:** Bankless の Peaster は "one of my favorite titles in onchain games" と書いている（S07。レビュー、宣伝色あり）。S11 は「本格 RTS が crypto に居場所を持てることを示した」と評価。
- **社会性・外交:** S01 の comradery、S02 の外交とスパイ、S11 の宗教の例。合わせて 3 件。
- **Blitz という形式:** 開始条件が平等、短時間、NFT の有利なし（S12、S13）。StarkWare は "the UX has literally 1000x'd since last month" と主張している（S10、2025-12-20、運営寄り）。**推測:** 裏を返すと、2025 年 11 月時点の UX は大きく劣っていたことになる。
- **AI エージェント:** S1 の Daydreams エージェントは、NPC として「狩る対象」になる設計（S07）。**プレイヤーの実際の反応は未発見。**
- **UI・アート:** 明確な称賛は**未発見**。逆に、メニューが大きすぎて盤面を隠す（#3615）、ラベルが多すぎる、という指摘がある。

---

## 4. 公開されている数値（いずれも報告値。独自には検証していない）

| 数値 | 内容 | 出典・日付 |
|---|---|---|
| S0 の参加 | 約 800 sign-ups、「100s of players」 | Loaf（開発）の発言を Bankless が報道 S07, 2025-04-30。PlayToEarn S08 は「800 人超」 |
| S0 の優勝トライブ | 約 18 人で開始、終盤まで活動 約 15 人 | S01 |
| S0 の物流 | ロバ 1,100 万頭超 | S01（誇張を含む表現） |
| S0 の賞金 | 1M $LORDS | S04、S05 |
| S1 の賞金 | 1M $LORDS ＋ 100k $STRK（Bitrue は約 $40,000 相当と記載） | S07、Bitrue 2025-05-14 |
| Villages 導入後の 10 日間シーズンの売上 | $20,000 超 | S11, 2025-12-30（関係者による寄稿） |
| Realms.World 全体 | 「5 live worlds」「約 1,850 active players」 | S18（日付なし） |
| Blitz の定員 | 1 試合 24 人、Frontier は 1 シーズン 96 人 | S16, 2026-10-22 |
| 負荷試験 | 2,000 席・84 試合を 54.9 秒で処理（試験値で、実プレイヤー数ではない） | S16 |
| Blitz の試合時間 | 2 時間（2025）→ 60 分（2026） | S11 / S15 |
| 状態 | Eternum S1 は終了、Season 2 は開発中 | S19（2026-10 閲覧） |
| **信頼性低** | S1 の同時接続ピーク 約 2,400、1 か月継続率 47%、Blitz 1,200 試合以上、Blitz→Eternum 転換率 23% など | S14。出典がなく、公式のシーズン状況と矛盾する |

- S0 公式まとめ（S03）に「Starknet のブロックスペースの 50% を使った」という記述がある、と検索要約は示した。しかし本文の取得では確認できなかったため、**未確認**とする。

---

## 5. まとめ

### 5-1. 繰り返し出るテーマ（独立した情報源の数）

1. **資源と兵の移動が操作として重い（多拠点の物流、ロバ、送付 UI、フリーズ）:** プレイヤー本人 5 人以上 ＋ orden の記録 ＋ 開発の issue 多数。**最も裏付けが厚い。**
2. **戦力と結果の表示が信用できない（数値の不一致、幽霊軍、理由の出ない失敗、結果が見えない）:** プレイヤー本人 4 人以上 ＋ 開発の issue。
3. **拘束時間と不在のリスク（毎日数週間、24 時間体制、通知の不足）:** 4 件（S01、S12、S13、#2521）。反証 1 件（S02）。
4. **入口の障壁（学習曲線、ウォレットやパスの準備、ロードとログインの往復、手順の多さ）:** 5 件（うち運営側 3 件）。
5. **開始条件の不公平感（NFT の数、位置、抽選）:** 4 件（S01、S02、S12、S13）。
6. **社会性・外交の楽しさ:** 3 件（S01、S02、S11）。
7. **Blitz（短時間・平等・リセット）は Eternum の問題への回答:** 3 件（S12、S13、S15）＋ 運営の主張（S10）。

### 5-2. 目立つ反証

- 「24 時間体制は必須」という見方に対し、Odin（S02）は 24 時間体制なしで戦果を上げたと書いている。
- 「難しすぎて楽しめない」という見方に対し、"vertical wall" と書いた当の Odin が "top-tier entertainment" とも書いている。orden も 12〜18 時間の疲労と "absolute blast" を両方書いている。**難しさと満足度は、熱心な層の中では両立している。**
- 「UX が悪い」という見方に対し、StarkWare は「complexity abstracted away」（S09）、「UX 1000x」（S10）と主張している。ただし、いずれも運営寄りの発言。
- 「負けたら終わり」という見方に対し、await_0x は勝者側に合流して継続した（S01）。Village は奪われない（S08）。

### 5-3. 調べきれなかった点

- **やめた人・カジュアル層の一人称の声**: 未発見。Reddit や独立系レビューのサイトでは実質的に何も見つからなかった。Discord は非公開なので未調査。
- 場面7（戻ってきて状況を把握する体験）と場面8（負けた後の再参加）について、**プレイヤー本人の具体的な声**は未発見。
- Season 1 のプレイヤー側の振り返り（トライブのまとめ記事）は未発見。S0 は 2 本見つかった。
- AI エージェント（Daydreams）や Blitz のエージェント対戦について、プレイヤーの反応は未発見。
- 複数アカウントやボットについての信頼できる声は未発見。
- 公式統計ダッシュボード（stats.eternum.realms.world）は JS 描画のため数値を取得できなかった。
- YouTube の動画（「Eternum Season 1 | Beginner Guide」 https://www.youtube.com/watch?v=d0AdRcg3m5U ）は、説明文もコメントも取得できなかった。
- 同名の別作品が多く、検索のノイズになった。成人向けビジュアルノベル「Eternum」（Caribdis、v0.9 など）と「New World: Aeternum」は除外した。
