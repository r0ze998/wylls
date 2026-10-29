# A. 公式ドキュメント調査メモ — Realms / Eternum / Blitz（UX比較用）

- 調査日（全ページのアクセス日）: **2026-10-29**
- 起点: https://eternum-docs.realms.world/ （同一ビルドが https://docs.realms.world/ でも配信。JS バンドル名 `index-CtAU6RIj.js` が一致。旧 https://docs.eternum.realms.world/ は docs.realms.world へ 301 リダイレクト）
- 取得方法: サイトの JS バンドルから全ルート（ページ）一覧を抽出し、全ページの静的 HTML を取得してテキスト化した。数値表は静的 HTML では空なので、主要ページはブラウザで描画したうえで再読した（読み取りのみ。ログイン・ウォレット接続・フォーム送信はしていない）。ソース MDX の書き出し（https://eternum-docs.realms.world/llm.txt）でも内容を照合した。
- 表記ルール: 「公式に記載」= ドキュメント本文にある記述（URL付き）。「資料で未確認」= ドキュメント内で見つからなかった（機能が存在しないとは結論しない）。「推測」= 筆者の推論。「観測」= ドキュメント外で筆者が直接確認した事実（HTTP 応答など）。「二次資料」= 公式ドキュメント以外の記事。
- 引用は 15 語以内に抑え、それ以外は要約した。

---

## Part 1 — 版（バージョン）マップ

### 1.1 ドキュメントが自分の版について何と言っているか

| 項目 | 内容 | 出典 |
|---|---|---|
| サイドバーの Eternum セクション名 | 「Eternum (Season 1 - Concluded)」。Eternum 配下のページは S1 を記述していると読める | 公式に記載 https://eternum-docs.realms.world/overview/introduction （サイドバー） |
| Quick Links | 「Season 1 has concluded; Season 2 is in development」 | 公式に記載 https://eternum-docs.realms.world/overview/links |
| Eternum 本文 | 「Welcome to Season 1.」。S1 前提の記述が多い（7日間の入植期間、Labor は S1 で新登場、S0 との違いなど） | 公式に記載 https://eternum-docs.realms.world/eternum/world-physics 、 https://eternum-docs.realms.world/eternum/resources/production |
| Blitz セクション | ページ単位の版表記はない。Changelog に「Series 0」の開始（2026-03-28）と Combat v3（2026-06-05）が記載されている | 公式に記載 https://eternum-docs.realms.world/changelog/28-march-2026 、 https://eternum-docs.realms.world/changelog/5-june-2026 |
| 各ページの「最終更新日」 | どのページにも表示されていない | 資料で未確認 |
| バージョン番号 | ドキュメント自体のバージョン番号はない | 資料で未確認 |
| Changelog | 8件: 2025-09-03、2025-11-07、2025-11-14、2025-12-08、2026-01-31、2026-02-18、2026-03-28、2026-06-05。サイドバーに出るのは最新の 2026-06-05 だけで、他は URL 直打ちで閲覧できる | 公式に記載 https://eternum-docs.realms.world/changelog/5-june-2026 ほか |
| Season 1 の開始日・終了日 | ドキュメントに日付の記載なし | 資料で未確認 |
| 過去シーズン（S0）の別ドキュメント | 見つからない。S0 への言及は production ページの比較文 1 か所だけ | 資料で未確認（言及元は https://eternum-docs.realms.world/eternum/resources/production ） |
| Blitz の別ドキュメント | 別サイトはなく、同じサイトの「Blitz」セクションにある | 公式に記載（サイドバー） |
| Frontier モード | ドキュメント全体（llm.txt を含む）に「Frontier」という語は一度も出ない | 資料で未確認 |

### 1.2 モード・シーズンの整理

| 版 | ドキュメント上の状態 | 日付 | 根拠 |
|---|---|---|---|
| Eternum Season 0 | production ページで比較対象として触れられるだけ | ドキュメントに日付なし。二次資料では 2024年12月開始 | https://eternum-docs.realms.world/eternum/resources/production 、二次資料 https://www.bankless.com/read/eternum-returns-to-starknet |
| Eternum Season 1 | 「Concluded」（終了済み） | ドキュメントに日付なし。二次資料では Settling フェーズ 2025-05-07、Empire フェーズ 2025-05-14 開始。終了日は確認できず | 公式（状態） https://eternum-docs.realms.world/overview/links ／二次資料（日付） https://www.bitrue.com/blog/starknet-realms-eternum-launch 、 https://www.bankless.com/read/eternum-returns-to-starknet |
| Eternum Season 2 | 「in development」 | なし | https://eternum-docs.realms.world/overview/links |
| Blitz（Series 0 以降） | 60分マッチ、ブラケット制、MMR。Series 0 は 2026-03-28 の Changelog で「launched」と記載 | 2025-09 から 2026-06 の Changelog で変更履歴を追える | https://eternum-docs.realms.world/changelog/28-march-2026 |
| Frontier | ドキュメントに記述なし | 二次資料では 2026-10-21 にプレイテスト開始 | 二次資料 https://egamers.io/?p=125812 （2026-10-22 付） |

### 1.3 現在アクセスできるクライアント URL（2026-10-29 の観測）

| URL | 観測結果 | ドキュメント上の扱い |
|---|---|---|
| https://empire.realms.world/ | ルートは HTTP 404（curl での観測。ボット対策の可能性もあるため推測の余地あり） | トップページの「Enter the Realms」と Quick Links の「Empire Home」のリンク先（公式に記載 https://eternum-docs.realms.world/ 、 https://eternum-docs.realms.world/overview/links ） |
| https://eternum.realms.world/ | 307 で https://blitz.realms.world/ へリダイレクトされる | Quick Links には「Eternum」として掲載 |
| https://blitz.realms.world/ | 200。title は「Realms: Blitz」 | ドキュメントに直接の記載なし（資料で未確認） |
| https://play.realms.party/ （realms.party からは 301） | 200。title は「Realms」、description は「Frontier expeditions and Blitz battles」 | ドキュメントに記載なし（資料で未確認）。二次資料: https://egamers.io/?p=125812 |
| https://next-m.eternum.realms.world | 応答なし | ドキュメントでは開発者向け環境変数の例（モバイル版 URL）として出るだけ（https://eternum-docs.realms.world/development/getting-started ） |
| https://stats.eternum.realms.world/ | 200 | Quick Links に「Statistics」として掲載 |

**推測**: ドキュメントのリンク先（empire / eternum）と、現在実際にプレイできる入口（blitz.realms.world、play.realms.party）は一致していない。ドキュメントはまだ統合後の Play アプリや Frontier に追いついていない。

### 1.4 ページ別の版の判定（アクセス日はすべて 2026-10-29）

判定の基準: サイドバーの「Eternum (Season 1 - Concluded)」配下は「S1」とする。ただし本文の表の数値は、描画時に別の設定値を読み込んでいる形跡がある（後述）ため、**数値は版不明**とする。Blitz 配下は版の明記がないので「Blitz・版不明」とし、Changelog と一致する場合はその旨を書く。

| ページ | URL | 版の判定 |
|---|---|---|
| Introduction | https://eternum-docs.realms.world/overview/introduction | 版不明（エコシステム全体の説明） |
| Cartridge Controller | https://eternum-docs.realms.world/overview/controller | 版不明 |
| $LORDS | https://eternum-docs.realms.world/overview/lords | 版不明（Eternum と Blitz の両方に言及） |
| Loot Chests / Contents / Cosmetics | https://eternum-docs.realms.world/overview/chests/loot-chests ／ https://eternum-docs.realms.world/overview/chests/contents ／ https://eternum-docs.realms.world/overview/chests/cosmetics | Epoch 1（S1 と Blitz Series 0 の報酬）。装備機能は「開発中」 |
| Quick Links | https://eternum-docs.realms.world/overview/links | S1 終了・S2 開発中と明記 |
| Disclaimer | https://eternum-docs.realms.world/overview/disclaimer | 版不明（Eternum と Blitz の両方） |
| Resource Addresses | https://eternum-docs.realms.world/overview/resource-addresses | 版不明 |
| The Agora (AMM) | https://eternum-docs.realms.world/overview/agora | 版不明（「Eternum's on-chain AMM」とあるが、S1 の Bank 経由 AMM 記述とは別系統。**推測**: S1 以降の新しい仕組み） |
| Eternum: Key Concepts / Game Entry / World Physics / Realms / Villages / Wonders / Buildings / Materials / Production / Storage / Bridging / Transfers & Trade / Automation / Armies / Troop Tiers / Damage / Stamina & Biomes / Raiding / World Map / Movement / World Structures / Tribes / Victory / Prize Pool / Achievements | https://eternum-docs.realms.world/eternum/… | S1（サイドバーによる）。ただし数値表は版不明 |
| Blitz: 全ページ | https://eternum-docs.realms.world/blitz/… | Blitz・版不明。内容の多くは 2026-03-28（Series 0）と 2026-06-05（Combat v3）の Changelog と一致するが、一致しない数値もある |
| Development / Axis | https://eternum-docs.realms.world/development/… | 開発者向け。版不明 |

**数値表が S1 を表していない証拠（公式ページの描画結果として確認）**: Eternum S1 の Production ページは本文で「22 resources」と書いているが、ブラウザで描画した表には Blitz の 9 資源（Wood, Coal, Copper, Ironwood, Cold Iron, Gold, Adamantine, Mithral, Dragonhide）と「Research」という行しか出ない。https://eternum-docs.realms.world/eternum/resources/production
**推測**: 表のコンポーネントは共有の「現在の設定値」を読み込んで描画しており、S1 当時の値ではない可能性が高い。

---

## Part 2 — 8つの場面別（ドキュメントの記述のみ）

各場面の **E** は Eternum（S1）、**B** は Blitz（版不明）を指す。

### 場面1: ゲームを知ってから最初の行動まで（ウォレット、オンボーディング、チュートリアル、入植、費用、時間）

**プレイヤーの目的**: アカウントを用意し、自分の拠点（Realm / Village）を地図上に置く。

**知っておくべきルール・知識**
- E と B のどちらを遊ぶにも Cartridge Controller が必須。公式に記載 https://eternum-docs.realms.world/overview/controller 引用: 「You must have a controller to play Eternum or Blitz.」
- Controller の作り方: ユーザー名を入力してサインアップする。認証方法は Passkey、MetaMask、Rabby、Discord、WalletConnect から選べる。その後「Create Session」を押すと、トランザクション確認のポップアップなしでプレイできる。公式に記載 https://eternum-docs.realms.world/overview/controller
- E の Village と B の Recruit ブラケットは Controller だけで遊べる。Season Pass や $LORDS を使う場合は、Ready（旧 ArgentX）または Braavos ウォレットから Controller へ送る必要がある。公式に記載 https://eternum-docs.realms.world/overview/controller
- ガス代は Cartridge Paymaster が負担するため無料。公式に記載 https://eternum-docs.realms.world/overview/controller
- E の入場（Realm NFT 保有者）: https://empire.realms.world/mint で Season Pass を発行し、Cartridge ウォレットへ送る。公式に記載 https://eternum-docs.realms.world/eternum/game-entry 。入植するには Pass を焼却（burn）し、地図上の候補地から場所を選ぶ。公式に記載 https://eternum-docs.realms.world/eternum/realm-and-villages/realm
- E の入場（NFT 非保有者）: マーケットプレイスで Season Pass を買うか、Village を作る。公式に記載 https://eternum-docs.realms.world/eternum/game-entry
- E の Village の作り方: Village トークンを発行（mint）し、親 Realm の asset ID を入力するかランダムに任せる。さらに六方向のどこに置くかを方角で選ぶ。公式に記載 https://eternum-docs.realms.world/eternum/realm-and-villages/villages
- E の時間: S1 には開始前に 7 日間の入植期間がある。期間後も入植はできるが、早いほど有利。公式に記載 https://eternum-docs.realms.world/eternum/realm-and-villages/realm
- E の時間単位: 1 Eternum Day は現実の 1 時間で、6 フェーズ（各 10 分）に分かれる。毎正時に日が切り替わる。公式に記載 https://eternum-docs.realms.world/eternum/world-physics
- B の入場: NFT も Pass も不要で、ブラケットごとに条件が違う。Recruit は無料、Gladiator と Warrior は $LORDS の参加費、Elite は Warrior の上位者に配られる NFT 招待状が必要。公式に記載 https://eternum-docs.realms.world/blitz/game-entry 。Gladiator の参加費は 250 $LORDS（2025-09-03 時点）。公式に記載 https://eternum-docs.realms.world/changelog/3-september-2025
- B の手順: ゲーム開始前に「Registration Phase」で登録する（1ウォレットにつき1回）。開始後に Realm を settle する。settle しないと枠は空のまま残り、参加費は没収される。公式に記載 https://eternum-docs.realms.world/blitz/realms/realm
- B の時間: 1試合は 60 分。1 Eternum Day は 6 分（6 フェーズ×1分）なので、1試合は 10 日分にあたる。公式に記載 https://eternum-docs.realms.world/blitz/world-physics

**ドキュメントにある操作手順**
- Controller: ゲーム開始時にログインまたはサインアップ → ユーザー名入力 → 認証方法を選択 → 「Create Session」。https://eternum-docs.realms.world/overview/controller
- Season Pass の Controller への移動: https://empire.realms.world/season-passes を開き、ページ上部の Controller アイコンから接続して、移したい Pass を選ぶ。https://eternum-docs.realms.world/overview/controller
- 入植画面のスクリーンショットと GIF（settle-realm.gif）が掲載されている。https://eternum-docs.realms.world/eternum/realm-and-villages/realm
- チュートリアルやゲーム内オンボーディングの手順: 資料で未確認。B の Recruit ブラケットは「導入・テストプレイ・練習」用と位置づけられている。https://eternum-docs.realms.world/blitz/game-entry

**混乱しやすい点**
- Windows で Bluetooth がない PC を使い Passkey を選ぶと、サインインできなくなる既知の問題がある（ドキュメントの警告）。https://eternum-docs.realms.world/overview/controller
- 機種をまたぐ利用（Apple と Android など）では Passkey が同期されない場合がある。https://eternum-docs.realms.world/overview/controller
- $LORDS の入手には、ウォレット作成、ブリッジ、スワップといった外部の手順が必要で、ドキュメントは外部（X）のガイドに誘導している。https://eternum-docs.realms.world/overview/lords
- 推測: 「Season Pass」「Village トークン」「Controller」「Ready/Braavos」と登場する概念が多く、最初の行動までの距離が長い。
- Village トークンの価格: 資料で未確認。

**失敗と回復について書かれていること**
- E: ゲーム開始から 24 時間は全構造物が攻撃・襲撃を受けない。それ以降に入植する場合は保護がないため、spectator mode（観戦モード）で比較的安全な場所を偵察するよう勧めている。https://eternum-docs.realms.world/eternum/realm-and-villages/realm
- B: settle しないと参加費は没収される。https://eternum-docs.realms.world/blitz/realms/realm 。B には免除期間がない。https://eternum-docs.realms.world/blitz/worldmap-movement/worldmap
- 全モード共通: コントラクトは変更不可で監査も受けておらず、取引はすべて最終的で返金されない。https://eternum-docs.realms.world/overview/disclaimer

### 場面2: 拠点を作り、最初の生産を回す（資源、建物、人口・容量、労働・食料、生産チェーン）

**プレイヤーの目的**: Local ビューで建物を置き、食料・資源・Labor を回し始める。

**知っておくべきルール・知識**
- E の初期資源（Realm）: Wheat 1,000、Fish 1,000、Labor 1,200、資源3種（180/120/60）、Donkey 200。T1 部隊 5,000（4,900 は防衛スロットに配置済み、100 は保管）。部隊の種類は入植地のバイオームで決まる。https://eternum-docs.realms.world/eternum/realm-and-villages/realm 。Village は各値がほぼ半分で、部隊は 1,000。https://eternum-docs.realms.world/eternum/realm-and-villages/villages
- B の初期資源（Realm あたり、Series 0 の値と一致）: Wheat 1,000、Labor 1,500、Wood 360、Coal 240、Copper 120、Donkey 500、T1 部隊 5,000。全 Realm が City レベルから始まる。https://eternum-docs.realms.world/blitz/realms/realm
- 2 層のヘックス構造: World ビュー（大地図）と、各 Realm の中のヘックスで建物を配置する Local ビューがある（「hexes within hexes」）。https://eternum-docs.realms.world/eternum/world-physics
- 建設モードは 2 種類。E では Standard（資源効率が良いが複雑）と Simple（Labor だけで建てられるが非効率）。B では Resource mode と Labor mode と呼ぶ。建設タブ上部のトグルでいつでも切り替えられる。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings 、 https://eternum-docs.realms.world/blitz/realms/buildings
- 建てられるヘックス数はレベルで決まる: Settlement 6、City 18、Kingdom 36、Empire 60。https://eternum-docs.realms.world/eternum/realm-and-villages/realm
- 人口: Worker's Hut で人口上限を増やし、それ以外の建物は上限の空きを消費する。資源建物は 2、Farm は 1、Market と軍事建物は 3 を使う。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings
- 同じ種類の建物を増やすたびにコストが上がる: Cost = Base + Base×0.5×(N−1)²。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings
- E の生産: S1 では必要な材料を全量先払いし、毎秒一定量が産出される（S0 の逐次消費方式から変更）。https://eternum-docs.realms.world/eternum/resources/production
- 食料（Wheat / Fish）だけは入力なしで生産できる。それ以外はすべて何らかの入力が必要。https://eternum-docs.realms.world/eternum/world-physics
- E の Labor: Keep で資源を永久に焼却して作る。希少な資源ほど効率が良い。https://eternum-docs.realms.world/eternum/resources/production 。B の Labor は Keep が自動で毎秒 2 生産する。https://eternum-docs.realms.world/blitz/materials/production
- E の Donkey 生産には $LORDS が必要（「ガス」にあたる）。B の Donkey は食料だけで作れる。https://eternum-docs.realms.world/eternum/resources/production 、 https://eternum-docs.realms.world/blitz/key-concepts
- E の倉庫: 容量を超えた生産分は捨てられる。Storehouse を建てて容量を増やす。https://eternum-docs.realms.world/eternum/resources/storage 。B には倉庫システムがない（2025-09 に削除）。https://eternum-docs.realms.world/changelog/3-september-2025
- E の Village: 生産量は Realm の 50%、生産できる資源は 1 種類だけ（発行時のランダム抽選で決まり、確率表あり）。https://eternum-docs.realms.world/eternum/realm-and-villages/villages
- E の Wonder: 周囲 12 タイル以内の Realm と Village の生産効率が 120% になる（重ね掛けは不可）。https://eternum-docs.realms.world/eternum/realm-and-villages/wonders

**ドキュメントにある操作手順**
- E: 建設タブは Local ビューにある。整地済み（土がむき出し）のヘックスに建てる。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings
- B: 建物メニューで選んで Local ビューの空きヘックスをクリックする。World ビューから開いた場合は「Build」ボタンで次の空きヘックスに自動配置される。https://eternum-docs.realms.world/blitz/realms/buildings
- 生産: 生産画面で注文を作るときに、Standard か Simple のパネルを選ぶ。https://eternum-docs.realms.world/eternum/resources/production
- E の自動化: エンティティの「Automation」タブ → 「Add New Automation」 → モード（Produce Once / Maintain Balance）、種類、優先度 1〜9、対象資源、目標量を設定 → 「Add Automation」。https://eternum-docs.realms.world/eternum/resources/automation
- B の自動化: 右側ナビの Automation パネル → 「modify」 → 資源ごとのスライダー（0〜90%、5% 刻み）とプリセットで設定する。https://eternum-docs.realms.world/blitz/materials/automation
- GIF が掲載されている（construction.gif、simple-mode.gif、labor-production.gif、produce-from-building-click.gif、produce-from-automation.gif）。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings 、 https://eternum-docs.realms.world/eternum/resources/production ほか

**混乱しやすい点（ドキュメント内の矛盾を含む）**
- Keep の人口上限が「baseline population capacity of 5」と「Pop Cap: +6」で食い違う。Worker's Hut も「Pop Cap: +6」と「by 5」で食い違う。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings
- 描画後のページで、Storehouse の容量が `{formatNumberWithCommas(ETERNUM_CONFIG()…)}` というテンプレート文字列のまま表示されている。倉庫の基本容量と Storehouse の加算量はどちらも「0 kg」と表示される。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings 、 https://eternum-docs.realms.world/eternum/resources/storage
- 建物コストの表は数字とアイコンだけで、テキストとして資源名が出ない（描画後の確認）。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings
- 軍事建物の産出物が「Footman / Archer / Horseman / Royal Guardian / Beast Hunter / Dragon Rider」と書かれており、他ページの部隊名（Knight / Crossbowman / Paladin）と一致しない。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings
- E の自動化の説明が「10-Minute Cycles」と「processed every minute」で矛盾している。https://eternum-docs.realms.world/eternum/resources/automation
- B の自動化のプリセット名が、本文では「Labor / Resource / Custom / Idle」、Changelog では「Smart/Custom/Idle」になっている。https://eternum-docs.realms.world/blitz/materials/automation 、 https://eternum-docs.realms.world/changelog/31-january-2026
- E の自動化ページの手順説明は「[GIF placeholder…]」のまま残っており、画像がない。https://eternum-docs.realms.world/eternum/resources/automation

**失敗と回復について書かれていること**
- 倉庫が満杯になると、新しい生産分は無駄になる。対策として、満杯前に Storehouse を建てる、満杯近くで生産を止める、と勧めている。https://eternum-docs.realms.world/eternum/resources/storage
- 自動化は入力が足りないと実行されない。B では実行サマリーに、飛ばされたレシピとその理由が表示される。https://eternum-docs.realms.world/blitz/materials/automation
- 建てた建物の取り壊しや入れ替え: 資料で未確認（Keep は壊せないとだけ記載）。

### 場面3: 欲しい建物・部隊のための材料集め（レシピ、ティア、必要量の確認場所）

**プレイヤーの目的**: 目標の建物・部隊・アップグレードに必要な材料を把握し、集める。

**知っておくべきルール・知識**
- 資源を作るには、Standard では別の資源 2 種、Simple では Labor が必要。https://eternum-docs.realms.world/eternum/resources/production
- 部隊のティア: T1×2 で T2×1、T2×2 で T3×1 を作る。希少資源と食料も必要。T2 と T3 は Standard モード限定。https://eternum-docs.realms.world/eternum/military/troop-tiers 、 https://eternum-docs.realms.world/eternum/resources/production
- 部隊の強さは T2 が T1 の 3 倍、T3 が 9 倍。最大スタミナは T1 120、T2 140、T3 160。https://eternum-docs.realms.world/eternum/military/troop-tiers
- 軍事建物は 3 兵種×3 ティアで 9 種類あり、ティアごとに別の建物が要る。T2 と T3 の建物は Standard 限定。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings
- E の Realm アップグレードのコスト（S1 ページの表）: City は Labor 180、Wheat 1,200、Fish 1,200、Essence 200。Kingdom、Empire は段階的に増える。https://eternum-docs.realms.world/eternum/realm-and-villages/realm （推測: Essence は S1 の資源一覧に出てこないので、この表も現行設定から描画されている可能性がある）
- E の資源の希少度は Common から Mythic までの 6 段階。Realm ごとに産出できる資源は NFT のメタデータで 1〜7 種類に決まっている。https://eternum-docs.realms.world/eternum/resources/resources 、 https://eternum-docs.realms.world/eternum/realm-and-villages/realm
- B の Essence: 探索と World Structure からしか手に入らない。全アップグレード、一部の建物、高ティア部隊に必要。https://eternum-docs.realms.world/blitz/materials/resources
- B では探索で資源は見つからない。https://eternum-docs.realms.world/blitz/key-concepts
- E の Hyperstructure: Ancient Fragments 2,000万で起動し、22 資源それぞれの必要量はランダム（範囲の表あり）。加えて Labor 5,000万が必要。https://eternum-docs.realms.world/eternum/victory

**必要量を確認できる場所**
- ドキュメント側: Buildings、Production、Realm Upgrade の各ページの表（ただし上記のとおり、表示は版不明で資源名はアイコンのみ）。
- ゲーム内: 「The UI shows required input resources」（自動化の資源→資源レシピについて）。https://eternum-docs.realms.world/eternum/resources/automation 。それ以外の、ゲーム内でレシピや必要量を一覧する画面の説明は資料で未確認。

**混乱しやすい点**
- 描画された Production 表が S1 の 22 資源と一致しない（Part 1 参照）。
- 「Mithral」と「Mithril」で表記が揺れている。https://eternum-docs.realms.world/blitz/key-concepts
- E の Materials ページでは Relics が「E1, E2, E3」と書かれているが、詳細ページは B にしかない。https://eternum-docs.realms.world/eternum/resources/resources 、 https://eternum-docs.realms.world/blitz/materials/relics

**失敗と回復について書かれていること**
- 手元にない資源は、E では AMM や Orderbook で買えるほか、Simple モードで Labor から代わりに作れる。https://eternum-docs.realms.world/eternum/resources/production 、 https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
- 部隊は一度展開すると資源（トークン）の形に戻せない。https://eternum-docs.realms.world/eternum/world-physics

### 場面4: 資源と部隊を動かす（ロバ、軍、移動時間、スタミナ、探索、ヘックス移動）

**プレイヤーの目的**: 資源を拠点間で運ぶこと、軍を展開して移動・探索すること。

**知っておくべきルール・知識（輸送）**
- 物資の移動はすべて Donkey（ロバ）で行い、ロバは 1 回の輸送で消費される。https://eternum-docs.realms.world/eternum/world-physics
- 積載量は E がロバ 1 頭あたり 500 kg、B が 50 kg。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade 、 https://eternum-docs.realms.world/blitz/materials/transfers-and-trade
- 重量は資源 1 kg、食料 0.1 kg、部隊 5 kg（描画後の表）。https://eternum-docs.realms.world/eternum/resources/storage （数値は版不明）
- 一度送ったものは取り消せない。所要時間は距離で決まる。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
- E: 届いた物資は「Resource Arrivals」タブで手動で受け取る必要がある。さらに S1 では到着「ゲート」があり、次の Eternum Day（毎正時）にならないと受け取れない。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
- B: 到着した物資は自動で受け取られる。https://eternum-docs.realms.world/blitz/materials/transfers-and-trade
- B では、部隊を同じプレイヤーの構造物の間でロバ輸送できる。構造物が奪われると、そこに保管中・輸送中の部隊は消滅する。https://eternum-docs.realms.world/blitz/materials/transfers-and-trade
- E の Village は、親 Realm 以外から部隊を受け取れない（ロバ網を使った部隊の「テレポート」を防ぐため）。https://eternum-docs.realms.world/eternum/realm-and-villages/villages

**知っておくべきルール・知識（軍）**
- 1 つの軍は 1 兵種・1 ティアで構成し、1 ヘックスに置ける軍は 1 つだけ。https://eternum-docs.realms.world/eternum/military/armies
- 野戦軍は Realm に隣接する 6 ヘックスのどこかに展開する。全部埋まっていると展開できない。https://eternum-docs.realms.world/eternum/military/armies
- 移動にはスタミナを使う。基本コストは 20/ヘックスで、バイオームと兵種によって ±10 変わる（表あり）。探索は 30/ヘックス。https://eternum-docs.realms.world/eternum/worldmap-movement/movement
- 移動には食料も使う（1 部隊・1 ヘックスあたり 0.03）。https://eternum-docs.realms.world/eternum/worldmap-movement/movement 、 https://eternum-docs.realms.world/blitz/worldmap-movement/movement
- 遠くへ移動するには、空いているヘックスが連続していて、全行程分のスタミナがあることが条件。https://eternum-docs.realms.world/eternum/worldmap-movement/movement
- 探索で構造物やエージェント軍に当たると、軍は元のヘックスへ押し戻される（スタミナの追加罰はない）。https://eternum-docs.realms.world/eternum/worldmap-movement/movement
- E: 積載量を超えた軍は探索できなくなる。捨てた物資は焼失する。https://eternum-docs.realms.world/eternum/worldmap-movement/movement 。B: 探索報酬は本拠の Realm へ自動で送られる。探索には最低 10 部隊が必要。https://eternum-docs.realms.world/blitz/worldmap-movement/movement
- 部隊の移し替えは、隣接していて同兵種・同ティアの場合だけできる。受け取った側は「低い方のスタミナ」と「長い方のバトルタイマー」を引き継ぐ。https://eternum-docs.realms.world/eternum/worldmap-movement/movement

**ドキュメントにある操作手順**
- E の詳細輸送: Trade タブの輸送メニューを使う。複数の資源を、他プレイヤーの構造物を含む任意の構造物へ送れる。クイック輸送: 資源サイドバーから自分の構造物間で送る。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
- B: 右側ナビの輸送パネルを使う。「advanced」ボタンで、定期輸送（1〜30分間隔）の強制実行、一時停止・再開、削除ができる。https://eternum-docs.realms.world/blitz/materials/transfers-and-trade
- 軍の展開: Local ビューの Military タブから。https://eternum-docs.realms.world/eternum/military/armies
- 部隊の移し替え: 自軍を左クリックで選択 → 対象を右クリック → 「Transfer → Transfer Troops」タブ。https://eternum-docs.realms.world/eternum/worldmap-movement/movement
- GIF: moving-army.gif、explore.gif、create-explorer.gif、transfer-troops.gif、transfer-panel.gif など。https://eternum-docs.realms.world/eternum/worldmap-movement/movement ほか
- 移動自体のクリック操作（目的地の指定方法）の文章による説明: 資料で未確認（GIF のみ）。

**混乱しやすい点（ドキュメント内の矛盾を含む）**
- E のスタミナ回復が「+2/フェーズ、+12/日」（Key Concepts、Stamina、Movement 本文）と書かれている一方、同じ Movement ページの表は「Stamina on Deployment 20 / Gain Per Eternum Day 20」で、移動コストは 20/ヘックス。+12/日では 1 日に 1 ヘックスも動けない計算になる。https://eternum-docs.realms.world/eternum/worldmap-movement/movement 、 https://eternum-docs.realms.world/eternum/military/stamina-and-biomes （推測: 本文は S1 初期の値、表は後の設定値で、混在している）
- B の Movement ページでも、本文は「+30/フェーズ」、表は「Stamina on Deployment 20 / Stamina Gain Per Phase 20」で食い違う。Changelog（2026-03-28）では配備時もフェーズごとも 30 と書かれている。https://eternum-docs.realms.world/blitz/worldmap-movement/movement 、 https://eternum-docs.realms.world/changelog/28-march-2026
- Key Concepts には「兵種ごとに最大スタミナが違う」とあるが、表では 3 兵種とも同じ値（120/140/160）。https://eternum-docs.realms.world/eternum/key-concepts 、 https://eternum-docs.realms.world/eternum/military/troop-tiers
- ロバの積載量は E と B で 10 倍違う（500 kg と 50 kg）。

**失敗と回復について書かれていること**
- 送った輸送は取り消せない。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
- スタミナを使い切ると、攻撃されたときに大きく不利になるという警告がある。https://eternum-docs.realms.world/eternum/worldmap-movement/movement
- 積載超過のときは、構造物へ戻って荷を下ろすか、物資を捨てる（焼失する）。https://eternum-docs.realms.world/eternum/worldmap-movement/movement

### 場面5: 他プレイヤーとの取引・協力（市場/AMM、注文、トライブ/ギルド、Hyperstructure、共同拠出）

**プレイヤーの目的**: 足りない資源を手に入れ、仲間と協力して勝利点を稼ぐ。

**知っておくべきルール・知識**
- E の AMM: 6 つの Bank が提供する。取引には最寄りの Bank が自動で使われ、手数料はその Bank の所有者に入る。手数料は「比較的高い」ため、まず Orderbook を検討するよう勧めている。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
- E の Orderbook: プレイヤー間の指値注文で手数料は低い。友人向けの OTC 注文も出せる。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
- The Agora（版不明）: LORDS と各資源のプールを使う定数積型 AMM。資源同士の交換は LORDS を経由して自動ルーティングされる。手数料は LP 1% と Protocol 3%。スリッページ許容の既定値は 0.5%、期限の既定値は 20 分。https://eternum-docs.realms.world/overview/agora
- E のトライブ: 誰でも作れる。公開または非公開（招待制）を選べ、トライブ専用の機能がある。同盟や宣戦はプレイヤー同士の取り決めに任されている。https://eternum-docs.realms.world/eternum/tribes
- E の Hyperstructure への拠出: 建設を始めた Lord が、拠出を全員に開くかトライブ限定にするかを決める。Realm や Village からロバなしで直接拠出でき、拠出量に応じて VP が配られる（合計 499,836）。https://eternum-docs.realms.world/eternum/victory
- 保有中に溜まる VP は、所有者が分配比率を設定して他の Lord と分けられる。https://eternum-docs.realms.world/eternum/victory
- E の賞金: 上位 10 トライブに配分（1位 30% など）。トライブ内ではリーダーが 30%、残り 70% を VP に比例して分ける。https://eternum-docs.realms.world/eternum/prize-pool
- E の Village は、親 Realm の Portal を使ってゲーム外へ持ち出す（ブリッジ）。その際、親 Realm の所有者に 5% の手数料が入る。https://eternum-docs.realms.world/eternum/resources/bridging
- B には取引の仕組みがない（Bank、プレイヤー間輸送、AMM、Orderbook のどれもない）。https://eternum-docs.realms.world/blitz/materials/transfers-and-trade
- B のリアルタイムチャット（DM 通知を含む）は 2026-03-28 に有効化。https://eternum-docs.realms.world/changelog/28-march-2026

**ドキュメントにある操作手順**
- Agora のスワップ: 左のプール一覧から選ぶ → Pay と Receive を選択 → 数量を入力 → 見積額・価格影響・最低受取額を確認 → 歯車アイコンでスリッページを調整 → Swap。https://eternum-docs.realms.world/overview/agora
- トライブ作成: 名前を設定 → 公開/非公開を選ぶ → 非公開なら招待を送る（create-guild.gif あり）。https://eternum-docs.realms.world/eternum/tribes
- Bank AMM や Orderbook の画面操作の手順: 資料で未確認。

**混乱しやすい点**
- 「Tribes」と「Guild」（GIF のファイル名）で呼び名が揺れている。https://eternum-docs.realms.world/eternum/tribes
- E の AMM（Bank 経由で、手数料は Bank 所有者へ）と The Agora（LP 手数料と veLORDS 向け Protocol 手数料）の関係が説明されていない。推測: 別の版の仕組みである。
- トライブページの記述は短く、トライブ専用機能の中身は資料で未確認。

**失敗と回復について書かれていること**
- AMM は許容スリッページを超えるか期限が切れると取引が取り消される（revert）。https://eternum-docs.realms.world/overview/agora
- シーズン終了後もできるのは、LP の引き出しと注文の取り消しだけ。https://eternum-docs.realms.world/overview/disclaimer

### 場面6: 戦闘前のリスク・結果判断（戦闘式、兵種/ティア、バイオーム、スタミナ、シミュレーター、襲撃、守備）

**プレイヤーの目的**: 攻撃するか守るかを判断し、損失を見積もる。

**知っておくべきルール・知識**
- 損害式: Dx = K·(Tx/Ty)·x·C^(−0.2)·B·S·T（K=2）。損害は双方に同時に適用される。https://eternum-docs.realms.world/eternum/military/damage
- バイオーム補正: 防御側がいるヘックスのバイオームで、兵種ごとに ±30% または 0%。表あり。https://eternum-docs.realms.world/eternum/military/stamina-and-biomes
- E の戦闘のスタミナ: 攻撃側は 5（不足していると攻撃できない）、防御側は 4（不足していると与ダメージが 30% 減る）。https://eternum-docs.realms.world/eternum/military/stamina-and-biomes
- B の戦闘のスタミナ: 攻撃側 50、防御側 40。Crossbowman は 2 ヘックス先から攻撃でき、その場合の防御側の消費は 20。https://eternum-docs.realms.world/blitz/military/stamina-and-biomes
- B の Combat v3: Crossbowman の 2 ヘックス攻撃は、野戦軍に 70%、構造物の守備隊に 30% の損害。バイオーム補正なし、反撃なし。Knight は構造物戦に強く +15%。構造物を奪うには隣接が必要。https://eternum-docs.realms.world/blitz/military/damage 、 https://eternum-docs.realms.world/changelog/5-june-2026
- バトルタイマー: 戦闘後 1 フェーズ（E 10分、B 1分）は攻撃できない。タイマー中に攻撃されると与ダメージが 15% 減る。https://eternum-docs.realms.world/eternum/military/damage
- 一方的な戦闘の返還: 損害比が 2.5 を超えると、優勢側にスタミナが戻り、タイマーが短くなる（10 以上で最大）。https://eternum-docs.realms.world/eternum/military/damage
- 守備隊: 外側のスロットから順に狙われる。全滅したスロットには一定時間、増援を置けない（E は「0 hours」と表示されて値不明、B は 10 分）。https://eternum-docs.realms.world/eternum/military/armies 、 https://eternum-docs.realms.world/blitz/military/armies
- 防御スロット数: E は Realm レベルに応じて 1〜4、Bank と Hyperstructure は 4、Fragment Mine は 1。https://eternum-docs.realms.world/eternum/military/armies
- E の襲撃（Raid）: 守備隊を倒さずに資源を盗める。必要なのはスタミナ 50 と隣接。成功率は「襲撃側の総ダメージ ÷ 守備隊の合計ダメージ」で決まり、50% 未満なら 0%、200% 超なら 100%、その間は比例。守備隊がいなければ自動で成功。双方の損害は通常戦闘の 10%。https://eternum-docs.realms.world/eternum/military/raiding
- E では、Realm は奪われる（Hardcore）が、Village は襲撃されても奪われない。https://eternum-docs.realms.world/eternum/key-concepts
- B の軍の規模: 配備上限（Deployment Cap）とティア補正で最大軍サイズが決まる（計算例あり）。https://eternum-docs.realms.world/blitz/military/armies

**ドキュメントにある操作手順**
- 攻撃: 自軍を左クリック → 対象ヘックスを右クリック。守備隊で攻撃するときは、構造物を選択 → 右クリック。https://eternum-docs.realms.world/eternum/military/armies
- 敵の防御を見る: World ビューでヘックスを選び、Details タブを開く。https://eternum-docs.realms.world/eternum/military/armies
- 襲撃: 構造物を攻撃するときに「raid」アクションを選ぶ。https://eternum-docs.realms.world/eternum/military/raiding
- 戦闘シミュレーター、勝敗予測、損害プレビュー: 資料で未確認。

**混乱しやすい点（ドキュメント内の矛盾を含む）**
- E の Scorched バイオーム: 注記では「全兵種 +30%」、表では「Knight 0 / Crossbowman +30 / Paladin −30」。https://eternum-docs.realms.world/eternum/military/stamina-and-biomes
- 襲撃ページの中で、「$LORDS も襲撃で奪われる」という警告と、「LORDS/STRK は Realm を奪わない限り盗めない」という本文が矛盾している。https://eternum-docs.realms.world/eternum/military/raiding
- 襲撃の計算例で「Slot 1 loses 36 troops (10% of 180)」とあり、10% なら 18 になるはずで数値が合わない（推測: 誤記）。https://eternum-docs.realms.world/eternum/military/raiding
- 襲撃で優先して盗まれる資源の順位表は、静的な HTML では空欄。https://eternum-docs.realms.world/eternum/military/raiding
- E のスタミナ消費が 5/4（攻撃/防御）なのに襲撃には 50 必要で、回復は +12/日。数値の規模が合わない（推測: 版が混在している）。
- 最大軍サイズ: E の Armies ページは 30,000 と書き、「+NaN」という未描画の値も残っている。B は配備上限から計算する方式。https://eternum-docs.realms.world/eternum/military/armies 、 https://eternum-docs.realms.world/changelog/7-november-2025

**失敗と回復について書かれていること**
- 襲撃に失敗しても、損害はあり、スタミナ 50 も消費する。https://eternum-docs.realms.world/eternum/military/raiding
- 守備隊が全滅すると、隣接する野戦軍に構造物を奪われうる。https://eternum-docs.realms.world/eternum/military/armies
- B では、構造物を奪った側が、その構造物の展開済みの軍も手に入れる。保管中・輸送中の部隊は消滅する。https://eternum-docs.realms.world/blitz/key-concepts

### 場面7: 離席と復帰 — 不在中に何が起きたかを把握する（通知、イベントログ、不在中の生産、襲撃）

**プレイヤーの目的**: 復帰したときに、状況（生産、到着物、被害）をすばやく把握する。

**ドキュメントの記述**
- 不在中の生産: 注文時に材料を全量先払いし、毎秒一定量が産出される（S1）。https://eternum-docs.realms.world/eternum/resources/production 。食料の建物は入力なしで生産を続ける。https://eternum-docs.realms.world/eternum/resources/production
- 倉庫が満杯なら、不在中の生産分は失われる。https://eternum-docs.realms.world/eternum/resources/storage
- 自動化はブラウザ内で動くため、タブを閉じると止まる（E・B 共通）。https://eternum-docs.realms.world/eternum/resources/automation 、 https://eternum-docs.realms.world/blitz/materials/automation
- E の到着物は「Resource Arrivals」で手動受け取りが必要で、毎正時に受け取り可能になる。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
- スタミナはフェーズの開始時にまとめて付与され、それ以外では回復しない。https://eternum-docs.realms.world/eternum/military/stamina-and-biomes
- E: 誰かが規定の VP に達して「End Season」を押した瞬間に、ほぼすべての操作ができなくなる。残るのは輸送、到着物の受け取り、LP の引き出し、注文の取り消し、ブリッジアウトだけ。そこから 7 日以内にブリッジで持ち出さないと資産は永久にロックされる。スコア登録の期限は 4 日。https://eternum-docs.realms.world/overview/disclaimer
- B の自動化の実行サマリーには、最終実行時刻、産出・消費の合計、飛ばされたレシピと理由が表示される。https://eternum-docs.realms.world/blitz/materials/automation
- B のリーダーボードは試合中に更新されるようになった。試合後の振り返り画面、共有用の報酬まとめカード、DM 通知（toast）、「story events」も Changelog に記載がある。https://eternum-docs.realms.world/changelog/28-march-2026

**資料で未確認**
- 通知（プッシュ、メールなど）の仕組み。
- 被襲撃・被攻撃のイベントログ、戦闘履歴の画面。Changelog の「story events」という語以外に説明はない。
- 不在中の被害をまとめて見る方法。

**混乱しやすい点（推測）**
- E は時間スケールが 1 日 = 1 時間で、到着ゲートやフェーズ単位の回復があるため、復帰のタイミングで受け取れる物と待つ必要がある物が変わる。
- 自動化に頼ると「ブラウザを開いたままにする」ことが前提になり、離席という状況と相性が悪い（ドキュメントの記述からの推測）。

**失敗と回復について書かれていること**
- シーズン終了後の 7 日間の持ち出し期間を過ぎた資産は「回復不能」と明記されている。https://eternum-docs.realms.world/overview/disclaimer

### 場面8: 負けた・遅れた後の再参加（リスポーン、新しい Realm、Village、途中参加、追いつき策、シーズンリセット）

**ドキュメントの記述**
- E: 防御が崩れた Realm は他プレイヤーに奪われ、プレイの権利が移る。https://eternum-docs.realms.world/eternum/key-concepts
- E: Village は奪われないため、低リスクの参加手段と位置づけられている。https://eternum-docs.realms.world/eternum/game-entry
- E: 途中参加はできる（入植期間後でも settle できる）。ただし免除期間はないので、観戦モードで場所を偵察するよう勧めている。https://eternum-docs.realms.world/eternum/realm-and-villages/realm
- E: Realm または Village を支配している限り、追加の参加費なしでシーズン終了まで遊べる。https://eternum-docs.realms.world/eternum/game-entry
- E: シーズン制で、シーズン間に数週間の開発期間がある。https://eternum-docs.realms.world/eternum/game-entry 。獲得した VP は失われない。https://eternum-docs.realms.world/eternum/victory
- B: 各試合は新しい状態から始まり、試合をまたいだ進行要素はない（MMR を除く）。https://eternum-docs.realms.world/blitz/game-entry 、 https://eternum-docs.realms.world/blitz/mmr
- B: MMR は試合後に「Social → MMR → Update MMR」で反映する。登録済みで得点が 0 でないプレイヤーだけが対象。https://eternum-docs.realms.world/blitz/mmr
- B: 500 VP 以上で終えたプレイヤーは、入賞しなくても Loot Chest を受け取れる。https://eternum-docs.realms.world/blitz/prize-pool
- B: 新しいシーズンが始まると、自動化の設定は消去される。https://eternum-docs.realms.world/blitz/materials/automation
- Loot Chest の「Epoch」は Eternum のシーズンごとに区切られる。https://eternum-docs.realms.world/overview/chests/loot-chests

**資料で未確認**
- E で全拠点を失った後のリスポーンや再入植の手順（同じシーズン内でもう一度 Pass が必要かどうかなど）。
- E の追いつき策（遅れて参加した人への補助）。
- B の試合中に全 Realm を失ったときの扱い（脱落になるのか、観戦になるのか）。
- Village を失う条件があるかどうか。

---

## Part 3 — 理解を助ける仕掛けと、ドキュメント自身の注意書き

### 3.1 理解を助けるための記載（公式に記載）
- Key Concepts のページが E と B それぞれにあり、ルールの要約を担っている。https://eternum-docs.realms.world/eternum/key-concepts 、 https://eternum-docs.realms.world/blitz/key-concepts
- 用語の定義:「materials」と「resources」の区別を明記している。https://eternum-docs.realms.world/eternum/world-physics 。独立した用語集ページは資料で未確認。
- 計算式を例付きで掲載している: 損害式と返還、同種建物のコスト増加、Hyperstructure Foundation の発見確率、B の Hyperstructure のリング数、B の最大軍サイズ、B の賞金配分（例: 106 人 × 250 LORDS）。各ページは上記で引用済み。
- 表: バイオームの戦闘補正、バイオームの移動コスト、レベル別のヘックス数・軍枠、Village の資源抽選確率、ブリッジ効率（Hyperstructure の完成数に応じて 25%〜95%）、Relic の効果表。https://eternum-docs.realms.world/eternum/resources/bridging 、 https://eternum-docs.realms.world/blitz/materials/relics ほか
- 操作の GIF が 17 種類ある（settle-realm、construction、simple-mode、labor-production、create-explorer、create-guard、explore、moving-army、transfer-troops、attack-from-structure、transfer-panel、create-guild など）。ただし 2025-11-07 の Changelog には「GIFs and client flow instructions: updates pending」とあり、UI の変更に追いついていないことを認めている。https://eternum-docs.realms.world/changelog/7-november-2025
- ゲーム内の補助として Changelog に記載があるもの（B）: リソース増減のカウントアップ表示、生産バッジの色、試合後の振り返り、マップの fingerprint カード。https://eternum-docs.realms.world/changelog/28-march-2026
- LLM 向けに全文の書き出し（llm.txt）を用意している。https://eternum-docs.realms.world/development/llm
- 計算機やシミュレーターのツール: 資料で未確認。

### 3.2 ドキュメント自身が「複雑・注意」としている点（公式に記載）
- 「Disclaimer - MUST READ」: 監査を受けていない不変のコントラクトであること、損失の自己責任、シーズン終了後 7 日で資産がロックされること。https://eternum-docs.realms.world/overview/disclaimer
- Standard モードは「more complex」で複数拠点向け、Simple モードは「accessibility」のためと位置づけている。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings
- 引用: 「Eternum is a high-stakes game, it can be unforgiving」。https://eternum-docs.realms.world/eternum/game-entry
- AMM の手数料が高いという注意。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
- 倉庫の満杯、スタミナの枯渇、免除期間後の入植、Windows での Passkey についての警告（各場面で引用済み）。
- 開発中（WIP）と明記されているもの: Achievements（E・B とも本文は「WIP」のみ）、Relic と Bridging（B）、Cosmetics の装備、Loot Chest。https://eternum-docs.realms.world/eternum/achievements 、 https://eternum-docs.realms.world/blitz/achievements 、 https://eternum-docs.realms.world/blitz/materials/bridging 、 https://eternum-docs.realms.world/overview/chests/cosmetics

### 3.3 ドキュメント品質の問題（理解を妨げる要因。事実は公式ページで確認、評価は推測）
1. 数値が未描画・不正: 「0 kg」「0 hours」「+NaN」「NaN points」「0 victory points」、テンプレート文字列 `{formatNumberWithCommas(...)}` がそのまま見える（Storage、Armies、Victory、Materials、Buildings の各ページ）。
2. S1 のページなのに、表が別版の設定値を表示している（Production 表に Blitz の 9 資源と「Research」）。
3. スタミナの数値がページ内・ページ間で矛盾している（E: +12/日 と表の 20、B: +30 と表の 20）。
4. Relic Crate の VP が、B の World Map ページでは 1,000、Victory ページと 2026-03-28 の Changelog では 250。https://eternum-docs.realms.world/blitz/worldmap-movement/worldmap 、 https://eternum-docs.realms.world/blitz/victory
5. 人口上限（5 と 6）、Scorched 補正、$LORDS が襲撃で奪われるかどうか、襲撃の計算例、自動化の周期（10分と1分）が矛盾している。
6. 部隊名の不一致（Footman などと Knight などの混在）、Mithral と Mithril、Tribe と Guild の表記揺れ。
7. 2026-01-31 の Changelog は「quests are temporarily disabled」の注記を E の Prize Pool ページに追加したとしているが、現在のページにその注記は見当たらない。https://eternum-docs.realms.world/changelog/31-january-2026 、 https://eternum-docs.realms.world/eternum/prize-pool
8. B の Buildings ページに、B には存在しない「Village」への言及がある。https://eternum-docs.realms.world/blitz/realms/buildings

---

## UX 比較で重要な事実トップ10（ドキュメントの裏付けあり）

1. E と B はどちらも Cartridge Controller（Passkey などで作るスマートウォレット）が必須。セッションキーで確認ポップアップをなくし、Paymaster でガス代を無料にしている。https://eternum-docs.realms.world/overview/controller
2. E の入場経路は 3 つ（Realm NFT から Season Pass を発行、Pass を購入、Village を作る）。Village は奪われない「低リスク枠」で、生産量は Realm の 50%、資源は 1 種類。https://eternum-docs.realms.world/eternum/game-entry 、 https://eternum-docs.realms.world/eternum/realm-and-villages/villages
3. B は NFT 不要で、無料の Recruit ブラケットを練習用と位置づけている。1試合 60 分で、各自 3 Realm から始まり、取引の仕組みはない。https://eternum-docs.realms.world/blitz/key-concepts 、 https://eternum-docs.realms.world/blitz/materials/transfers-and-trade
4. 建設と生産に「Standard/Resource（効率は良いが複雑）」と「Simple/Labor（簡単だが非効率）」の 2 モードがあり、建設タブのトグルでいつでも切り替えられる。複雑さへの公式な対策といえる。https://eternum-docs.realms.world/eternum/realm-and-villages/buildings
5. 物資の移動はすべて使い捨てのロバで行い、取り消せない。E では到着後に「Resource Arrivals」で手動受け取りが必要で、毎正時のゲートを待つ。https://eternum-docs.realms.world/eternum/resources/transfers-and-trade
6. 戦闘は公開された決定的な式（K=2、ティア比、C^−0.2、バイオーム ±30%、スタミナ・タイマー補正）で計算される。ただし事前のシミュレーターやプレビューについては資料で未確認。https://eternum-docs.realms.world/eternum/military/damage
7. 襲撃の成功率は「襲撃側ダメージ ÷ 守備隊ダメージ」の比で決まる（50% 未満で 0%、200% 超で 100%）。損害は通常の 10% で、守備隊がいなければ自動成功。https://eternum-docs.realms.world/eternum/military/raiding
8. 自動化（生産・輸送）はブラウザ内で動くため、タブを閉じると止まる。離席中の運営を自動化で補う手段は限られる。https://eternum-docs.realms.world/eternum/resources/automation 、 https://eternum-docs.realms.world/blitz/materials/automation
9. E のシーズンは、誰かが「End Season」を押した瞬間に終わる。その後は 7 日以内に持ち出さないと資産は永久にロックされ、スコア登録は 4 日以内。https://eternum-docs.realms.world/overview/disclaimer
10. ドキュメントは「Eternum = Season 1（終了済み）、S2 は開発中」と明記しているが、ページごとの日付はない。数値表は別版の値や未描画の値が混ざっており、現行クライアントの仕様書としては信頼できない。https://eternum-docs.realms.world/overview/links 、 https://eternum-docs.realms.world/eternum/resources/production

## ドキュメントでは答えが出なかった問い

1. Eternum S1 の正式な開始日と終了日。誰がいつ End Season したのか。
2. Season 2 の内容と時期。Frontier モードのルール（ドキュメントに記述なし）。play.realms.party とドキュメントの関係。
3. 現行クライアントで、チュートリアルやゲーム内オンボーディングがあるかどうか。
4. 通知、イベントログ、被襲撃履歴など、不在中の出来事を把握する UI。
5. 戦闘シミュレーター、勝敗予測、損害プレビューがあるかどうか。
6. E で全拠点を失った後に再参加する手順と費用（同じシーズン内で Pass を買い直す必要があるか、など）。
7. B の試合中に全 Realm を失ったプレイヤーの扱い。
8. Village トークンの価格と入手経路の詳細。
9. 各種表の正しい値（S1 当時の生産レシピ、倉庫容量、勝利に必要な VP、Hyperstructure の VP/秒、守備スロットの復活時間）。現在は 0 や NaN、別版の値が表示されている。
10. ゲーム内で、レシピや必要材料を一覧できる画面があるかどうか。
11. E の Bank AMM と The Agora の関係（置き換えなのか併存なのか）。
12. トライブ専用機能の中身と、同盟・宣戦の仕組みがゲーム内にあるかどうか。
13. B の「Smart」プリセット（Changelog）と、本文の「Labor / Resource」プリセットのどちらが現行か。（→ 後述の現行版で解決: 現行は Smart / Custom / Off）

---
---

# 現行版（Frontier / Blitz, docs.realms.party と patch notes）

（このセクションは、コーディネーターからの追加依頼を受けて 2026-10-29 に追記した。上のセクションは変更していない。）

## 0. 取得したもの・取得方法・版の扱い

- **https://docs.realms.party/** : Vocs 製のサイト。トップページの静的 HTML は 6 KB しかないが、各ページはサーバー側で描画されており、静的取得で本文が取れた。JS バンドル（`index-C84ugtMA.js`）からルートとサイドバーの構成を抽出し、全ページを取得した。トップページの見出しは「Two strategy games, played onchain.」。
  - サイドバーの構成: 「Your account」（Sign in / Payout wallet / LORDS）、「Frontier」（Frontier / Your realm / Armies / The expedition / Chests and LORDS）、「Blitz」（Blitz / Entry and the lobby / Realms and production / Transfers and donkeys / Armies and combat / The map / Points, results and prizes）、「More」（What's new = /changelog、Development の 3 ページ、旧 Eternum の全ページ）。
  - 取得したページ: `/`、`/account/sign-in`、`/account/payout-wallet`、`/account/lords`、`/frontier`、`/frontier/realm`、`/frontier/armies`、`/frontier/expedition`、`/frontier/chests`、`/blitz`、`/blitz/entry`、`/blitz/realms`、`/blitz/transport`、`/blitz/armies`、`/blitz/map`、`/blitz/scoring`、`/changelog`。どれも本文が取れた。
  - 取れなかった部分: 静的 HTML では、一部の数値表（Blitz の Realm Upgrade Costs、生産レシピの表、Material Weights、Exploration Rewards）が空欄だった。旧サイトと同じく、クライアント側で描画するコンポーネントだと思われる（推測）。
  - 「More」配下の Eternum ページ（`/eternum/...`）は旧サイトと同じ構成で、いまも掲載されている（ルート一覧で確認）。
- **https://play.realms.party/scroll** : クライアント側で描画されるため、curl では 3.4 KB の外枠しか取れなかった。そこでブラウザで描画して読んだ（サインインはしていない）。見出しは「Patch notes」で、「Full rules」へのリンクがある。リリース一覧は Season alpha（29 Oct）、Combat v3（5 Jun）、Series 0（28 Mar）、Blitz MMR（31 Jan）、Starting labor（8 Dec 2025）、Farms and rifts（14 Nov 2025）、Smaller armies（7 Nov 2025）、Phases and brackets（3 Sept 2025）の 8 件。各リリースは「All modes / Frontier / Blitz / Eternum」のタブで切り替わる。
  - クライアント内で実際に開いて確認したのは、Season alpha（All modes タブと Frontier タブ）と Series 0。docs.realms.party の `/changelog` は自ら「the same notes as What's new in the game」と書いており、全リリース・全タブの本文を 1 ページに載せている。クライアントで確認した部分は一字一句一致したので、残りのリリースとタブは `/changelog` の本文で読んだ。
- **版ラベル**: このセクションの主張には、すべて「現行版 2026-10-29」というラベルを付けている。ただし、ドキュメントの各ページに日付はない。このラベルの根拠は、取得日と、patch notes の最新版（Season alpha、29 Oct）が同じ日付であることだけ。patch notes の過去のリリースについては、それぞれのリリース日を併記した。
- **出典の略記**: 以下では URL を毎回フルで書く。「PN」は https://docs.realms.party/changelog （＝ https://play.realms.party/scroll と同じ内容）の該当リリースを指す。

### 0.1 旧ドキュメントと現行ドキュメントの関係（UX 比較での注意）
- 旧サイト（eternum-docs.realms.world、上のセクション）の Blitz ページは、現行の Blitz と大きく食い違う。現行版での例: 3 つの Realm はそれぞれ 1 兵種だけ（1,000 守備＋1,000 予備）、Settlement から始まる、Labor では生産できない、Raid（襲撃）はない、行軍の Wheat は 0.05、Hyperstructure は 12 ヘックス間隔で、プレイヤーが自分で「founded」する、参加費は 100 LORDS、賞金は試合ごとではなくシーズン単位。旧サイトは S1 Eternum、および 2026 年 6 月までの Blitz の記述とみなし、**現行クライアントの仕様としては docs.realms.party を正とするべき**（推測）。
- 現行のドキュメントとパッチノートの両方とも、「Eternum Season 2」には触れていない（資料で未確認）。PN Season alpha の Eternum タブには、Trade に関する修正が 1 件あるだけ。

### 0.2 現行版の中での矛盾（重要）
- **Frontier の戦闘にサイコロがあるかどうかが食い違っている。** Frontier のドキュメントは「no dice are rolled, so a fight's forecast is its result」（https://docs.realms.party/frontier 、 https://docs.realms.party/frontier/armies ）。一方、PN Season alpha の Frontier タブは「Fights roll dice」と書き、引用:「Each side rolls a d20 and hits up to 20% harder」（クライアントの Frontier タブで確認済み。https://play.realms.party/scroll 、 https://docs.realms.party/changelog ）。現行版 2026-10-29。どちらが実装どおりかは資料で未確認。
- Frontier の Ruin（廃墟）のチェストの価格の出どころが、ページによって「the season's pool」と「the day's budget」で言い方が違う（https://docs.realms.party/frontier/chests ）。推測: 同じものを指しており、矛盾ではない可能性が高い。
- Blitz の Relic の効果時間: 現行ドキュメントは「3 minutes」（https://docs.realms.party/blitz/map ）、PN Combat v3（5 Jun）は「3 Eternum days (18 minutes)」。Season alpha のパッチノートには時間変更の記載がない（「Relics end on time」は修正のみ）。現行版 2026-10-29。どちらが現行か資料で未確認。

---

## 1. 8場面別（現行版。F = Frontier、B = Blitz）

### 場面1: ゲームを知ってから最初の行動まで

**目的**: サインインして、最初の拠点を持つ。

**ルール・知識**
- サインインは Discord か、メールに届くコード。プレイにもサインインにもウォレットは不要。操作への署名は端末自身が行う。https://docs.realms.party/account/sign-in （現行版 2026-10-29）
- 初回サインイン時に Realms アカウントが作られ、名前と肖像を設定する（「Claim name」）。https://docs.realms.party/account/sign-in （現行版 2026-10-29）
- 1 アカウントで使える端末は 8 台まで。9 台目では、既存の端末を 1 台外すよう求められる。https://docs.realms.party/account/sign-in （現行版 2026-10-29）
- F は無料。シーズン中のどの日に入っても、初回入場時に自分の Realm が無料で作られる。https://docs.realms.party/frontier （現行版 2026-10-29）
- F の初期値: 部隊 1,500、Wheat 4,500、Labor 2,000。https://docs.realms.party/frontier/realm （現行版 2026-10-29）
- F の最初の一日の流れ（ドキュメント記載）: Barracks を建てる → 軍を展開する → 霧の中へ進める。https://docs.realms.party/frontier （現行版 2026-10-29）
- B の参加費は LORDS で、今シーズンは 100 LORDS。払うにはリンク済みの payout wallet（受取用ウォレット）が必要。https://docs.realms.party/blitz/entry （現行版 2026-10-29）
- B のスロットは UTC の固定グリッドで 90 分ごとに始まる。受付は開始 5 分前に締め切られ、最大 24 人ずつのゲームに分けられる。https://docs.realms.party/blitz/entry （現行版 2026-10-29）
- payout wallet は Ready（旧 Argent）、Braavos、Controller のいずれか。持っていなければ、メールだけで作れる Ready を使う。リンクの手順は、ウォレットでメッセージに署名 → メールで届く 6 桁コードを入力、の 2 段階。「Realms creates no wallet and holds no key」。https://docs.realms.party/account/payout-wallet （現行版 2026-10-29）
- LORDS は LORDS のローンチまで価値のないテストトークンで、無料で発行（mint）できる（「Mint 1,000 test tokens」）。https://docs.realms.party/account/lords （現行版 2026-10-29）
- ネットワーク手数料（STRK）はウォレットが払う。STRK がないと「Swap on AVNU」が提示される。https://docs.realms.party/account/payout-wallet （現行版 2026-10-29）

**操作手順（ドキュメント記載）**
- Connect は、Play free、You 画面の Sign in、Blitz のロビーのいずれかから開く。Discord の場合は、別ブラウザで認証が終わったときにそこに出るコードを Connect に入力する。メールの場合は、6 桁目を入力した時点でサインインが完了する。https://docs.realms.party/account/sign-in （現行版 2026-10-29）
- B の参加: Play からスロットを選ぶ。スロットに表示される「Link wallet」で Settings へ移動し、リンク後に元の画面へ戻る。https://docs.realms.party/blitz/entry （現行版 2026-10-29）
- 新しいアプリの構成: 上部（スマホでは下部）に Play、Season、What's new、You。Play は最初に「your next step」を表示する。PN Season alpha（29 Oct）
- チュートリアル: 専用の説明は資料で未確認。代わりに HUD の「Next up」が「今やるべき 1 つのこと」を提示する（場面2・7 参照）。

**混乱しやすい点**
- B のエントリー状態は Registered → Seated と進むが、「Not seated」になる場合がある。支払ったウォレットがアカウントの payout wallet と違うとき、または同じスロットに既に席があるとき。https://docs.realms.party/blitz/entry （現行版 2026-10-29）
- Discord を携帯のアプリで認証すると、別のブラウザで認証が終わり、コードの入力が必要になる。https://docs.realms.party/account/sign-in （現行版 2026-10-29）
- 推測: F は「サインインしてすぐ無料で遊べる」のに対し、B は「ウォレットのリンク＋テスト LORDS＋STRK の手数料」が必要で、入口の手間が大きく違う。

**失敗・回復**
- 席が取れなかったエントリーは全額返金され、剣・盾の代金も戻る。スロットに表示される「Take refund」を押す。https://docs.realms.party/blitz/entry （現行版 2026-10-29）
- ウォレットをなくした場合、リンク解除はメールのコードだけでできる。https://docs.realms.party/account/payout-wallet （現行版 2026-10-29）
- ゲームの成績・チェスト・賞金は、その席でプレイしたウォレットに送られる（後から payout wallet を変えても変わらない）。https://docs.realms.party/blitz/scoring （現行版 2026-10-29）

### 場面2: 拠点を作り、最初の生産を回す

**F（Frontier）**
- 建物の代金は Labor。費用と人口: Farm 400/人口1、Barracks 400/3、Workshop 2,000/2、Workers' hut 300/人口を使わない、訓練建物 4 種 3,000/2。https://docs.realms.party/frontier/realm （現行版 2026-10-29）
- Workers' hut は 1 棟で人口 6 を収容する。同じ建物を増やすほど値上がりし、取り壊すと代金の 50% が戻る。Barracks での訓練は無料で、展開時に部隊 1 につき Wheat 2 がかかる。https://docs.realms.party/frontier/realm （現行版 2026-10-29）
- 城（castle）のアップグレード: 4,000 → 15,000 → 40,000 Labor。上げるごとに区画が 1 リング増え、出せる軍は 3 から 6 へ、1 回に展開できる部隊は 3,000 から 60,000 へ増える。https://docs.realms.party/frontier/realm （現行版 2026-10-29）
- 研究: 建物の種類ごとに common から legendary まで上げる。費用は Essence と Labor。研究時の選択肢（生産量を増やすか、貯蔵を増やすか など）は**シーズン中は変更できない**。https://docs.realms.party/frontier/realm （現行版 2026-10-29）
- 操作: 空いている区画をタップして建てる。PN によると、建物カードには何を作るか、何が足りずロックされているか、なぜ値上がりしたかが表示される。建設が拒否された場合は理由が表示され、解決策がボタンになる。PN Season alpha（29 Oct）

**B（Blitz）**
- 3 つの Realm はそれぞれ Settlement から始まり、Wheat 1,000、Labor 1,500、Wood 360、Coal 240、Copper 120、Donkey 500 を持つ。City への昇格は無料。https://docs.realms.party/blitz/realms （現行版 2026-10-29）
- Keep は毎秒 Labor 2、Farm は毎秒 Wheat 6 を入力なしで作る。それ以外の生産は「開始時に入力を全部払う」方式。「Labor cannot be turned into resources」。https://docs.realms.party/blitz/realms （現行版 2026-10-29）
- 建物の費用表（Labor だけで払う場合と、Labor＋資源で払う場合）が全建物ぶん静的に掲載されている。例: Workers Hut は 100 Labor、または 20 Labor＋20 Wood。https://docs.realms.party/blitz/realms （現行版 2026-10-29）
- 操作: 区画をタップ → タブ（Resources / Economic / Military）を選ぶ → 建物を選ぶ。Realm のレベル上げは保有一覧の行にある矢印から行い、「i」にカーソルを合わせると残りの必要量が出る。生産は Production（P キー）で、欲しい産出量か、使いたい入力量を入力する。https://docs.realms.party/blitz/realms （現行版 2026-10-29）
- 自動化: Smart（既定）、Custom、Off の 3 種。ブラウザでゲームを開いている間だけ動く。https://docs.realms.party/blitz/realms （現行版 2026-10-29）
- 新機能「Build order」（デスクトップ）: Next up の下に、推奨順で次に建てる建物とそのボタンを表示する。レベル上げを最優先し、人口が上限の 3 手前になったら Worker hut を勧める。PN Season alpha（29 Oct）

### 場面3: 欲しい建物・部隊のための材料集め

- B: 建物カードにカーソルを合わせると、費用と手持ちの比較、もう 1 棟建てたら何が増えるか、何を消費するかが表示される。PN Season alpha（29 Oct）
- B: T1 部隊は Wheat＋資源 1 種から作る。T2 は T1 から、T3 は T2 から。https://docs.realms.party/blitz/armies （現行版 2026-10-29）。T2 と T3 の建物は資源払いのみで、Essence 300 または 600 がかかる（表あり）。https://docs.realms.party/blitz/realms （現行版 2026-10-29）
- B: Essence、Labor、Donkey は探索で手に入る。探索 1 回の報酬は軍の strength（部隊数×ティア係数、上限 3,000）に比例する。dormant spire（休眠中の尖塔）を見つけると Essence 1,000。https://docs.realms.party/blitz/map （現行版 2026-10-29）
- F: Essence と Labor は探索で手に入る（軍の部隊数に対する割合で、深い層ほど多い）。Camp を制圧すると Labor、Rift を制圧すると Essence。研究の費用表あり。https://docs.realms.party/frontier/expedition 、 https://docs.realms.party/frontier/realm （現行版 2026-10-29）
- F: payout wallet 内の Realm NFT 1 つにつき、1 日 1 回 1,000 Labor を受け取れる（Realms を開く → 番号で追加 → Claim all）。https://docs.realms.party/frontier/realm （現行版 2026-10-29）
- F: Crossbowman、Paladin、T2 以上の部隊は作れない（Knight の T1 のみ）。https://docs.realms.party/frontier （現行版 2026-10-29）
- ゲーム内の「必要量一覧」画面: 資料で未確認（上記の建物カードのホバー表示と、B の「i」のホバー表示が、それに近い役割を果たす）。

### 場面4: 資源と部隊を動かす

**B**
- 輸送は自分の保有物（Realm、Camp、Rift、Hyperstructure）の間だけで、他プレイヤーには送れない。Transfer（T キー）を開くか、地図上の自分の保有物を右クリックする。宛先が複数ある場合は均等に分け、宛先ごとに分配量を指定することもできる。https://docs.realms.party/blitz/transport （現行版 2026-10-29）
- ロバ 1 頭の積載量は 50 kg で、使い捨て。部隊は物資より遅く移動する。到着は 3 分ごとの配送タイミングの終わりで、Transfer ウィンドウの Arrivals タブに入る。一度送ると呼び戻せない。https://docs.realms.party/blitz/transport （現行版 2026-10-29）
- 届いた輸送に「Repeat」を押すと、その輸送が自動化に追加される。https://docs.realms.party/blitz/transport （現行版 2026-10-29）
- 軍の展開: 自分の Realm を選び、隣の空きタイルを右クリックするか、Military（M キー）から行う。新しい軍のスタミナは 30。https://docs.realms.party/blitz/armies （現行版 2026-10-29）
- 展開画面は兵種ごとの列にティア 3 つを並べ、「+500」「Max」ボタンと費用を表示する。展開先として選べる 6 タイルだけを示す。PN Season alpha（29 Oct）
- スタミナ: 上限は T1 120、T2 140、T3 160。60 秒ごとに 30 回復する。探索 30、既知のタイルへの 1 歩は 20±10。移動と探索で部隊 1 につき Wheat 0.05 を本拠から消費する。https://docs.realms.party/blitz/armies （現行版 2026-10-29）
- 部隊の移し替え（合流）は Realm をまたいでもできる。条件は同兵種・同ティア。https://docs.realms.party/blitz/armies （現行版 2026-10-29）
- 新機能「The next order」: 移動中の軍に次の命令を予約でき、今の移動が着いた時点で出発する。新機能「What a right-click does」: 軍を選んでタイルにカーソルを合わせると、右クリックで何が起きるか、費用、得点が表示される。PN Season alpha（29 Oct）

**F**
- 軍のスタミナは 120 で、2 分に 1 回復する（空から満タンまで 4 時間）。探索 20、既知の地面への 1 歩 10、攻撃 30。1 歩と 1 回の探索ごとに部隊 1 につき Wheat 0.02。https://docs.realms.party/frontier/armies （現行版 2026-10-29）
- 「Refill」: 足りないスタミナ 1 につき 1 LORDS を Realm の LORDS から払い、即座に満タンにする。Well（泉）を使うとスタミナ 60。https://docs.realms.party/frontier/armies （現行版 2026-10-29）
- **スタミナは軍ではなく「スロット」に属する。** 軍が死亡・解散・合流してスロットが空いても残りスタミナはスロットに残り、次にそのスロットへ展開した軍はその値から始まる。日が変わると全スロットが満タンに戻る。https://docs.realms.party/frontier/armies （現行版 2026-10-29）
- 探索の報酬は自動で本拠へ送られ、軍は失って困るものを運ばない。https://docs.realms.party/frontier （現行版 2026-10-29）
- F には他プレイヤーへの輸送はない。https://docs.realms.party/frontier （現行版 2026-10-29）

**混乱しやすい点**
- F の「スタミナはスロットに残る」という仕組み。ドキュメントは引用:「Replacing a tired army never brings a fresh one.」と明記している。https://docs.realms.party/frontier/armies （現行版 2026-10-29）
- 推測: F と B でスタミナの単位と回復速度が大きく違う（F は 2 分に 1、B は 60 秒に 30）。

### 場面5: 他プレイヤーとの取引・協力

- F: 取引、ブリッジ、他プレイヤーへの送付はできない。トライブへの加入、Hyperstructure の建設もできない。Season board から他プレイヤーの Realm を「visit」（見学）することはできる。https://docs.realms.party/frontier （現行版 2026-10-29）
- B: 取引も他プレイヤーへの送付もできず、同盟も組めない（全員が敵）。https://docs.realms.party/blitz （現行版 2026-10-29）
- B: 他プレイヤーとチャットはできる。ロビーのチャットに書き込めるのは登録者だけで、読むのは誰でもできる。https://docs.realms.party/blitz 、 https://docs.realms.party/blitz/entry （現行版 2026-10-29）
- 全モード: DM の相手をブロックできる（相手には通知されない）。PN Season alpha（29 Oct）
- 「Market opens Realms' marketplace」: アプリ上部の Market からマーケットプレイスへ移れる。PN Season alpha（29 Oct）。ゲーム内での取引に使えるかどうかは資料で未確認。
- 推測: 現行版の 2 モードは、どちらもプレイヤー間の経済的な協力を意図的に取り除いている。協力の要素は、チャット・見学・ランキング閲覧に限られる。

### 場面6: 戦闘前のリスク・結果判断

**B**
- 「Blitz rolls no dice, so the attack forecast is the result.」 https://docs.realms.party/blitz/armies （現行版 2026-10-29）
- 攻撃の手順: 軍を選び、射程内の敵を右クリック → 攻撃予測（attack forecast）が開き、双方の損失が表示される → 「Attack」で実行。https://docs.realms.party/blitz/armies （現行版 2026-10-29）
- 攻撃予測は双方の名前、それぞれの損失、生き残る側を示す。確実に負ける場合は、代わりに何をすべきかを提示する。PN Season alpha（29 Oct）
- 損害式を文章で説明しており、計算例の表もある（1,000 対 1,000 の T1 同士なら双方 437 ずつ失う、など）。バトルタイマーは「残り時間に加算」される仕組みで、例が載っている。https://docs.realms.party/blitz/armies （現行版 2026-10-29）
- 兵種の役割: Knight は構造物の守備隊に対して +15%、守備側では被ダメージ −15%。Crossbowman は 2 ヘックス先から攻撃できる（射撃で構造物は奪えない）。Paladin は戦闘ボーナスがなく、開けた地形の移動が安い。https://docs.realms.party/blitz/armies （現行版 2026-10-29）
- 地図のトークン: 部隊数とティア、スタミナバー、守備のない構造物には破線のリング。カーソルを合わせると、Realm の守備隊を攻撃側が当たる順に表示する。PN Season alpha（29 Oct）
- 免除期間はない。Raid（襲撃）はない。https://docs.realms.party/blitz （現行版 2026-10-29）
- 「Next up」は、攻撃されたら軍が全滅する状況では「先にレベル上げ」を勧める。PN Season alpha（29 Oct）

**F**
- 他プレイヤーとは戦わない。PvE の相手は Troll、Rift、Ruin、Beast で、攻撃前に守備隊と報酬が表示される。https://docs.realms.party/frontier （現行版 2026-10-29）
- 攻撃前のカードに、双方の戦闘前後の部隊数と、制圧したときの報酬が表示される。地形（バイオーム）の影響はない。https://docs.realms.party/frontier/armies （現行版 2026-10-29）
- 守備隊の強さの範囲を、深さ別の表で掲載している。https://docs.realms.party/frontier/expedition （現行版 2026-10-29）
- 戦闘の結果は「Victory / Army lost / Guard holds」の 3 種で、双方の前後の部隊数が表示される。PN Season alpha（29 Oct）
- **矛盾**: サイコロの有無（0.2 節を参照）。

### 場面7: 離席と復帰 — 不在中の把握

- 通知は Off / Important / All から選ぶ。Important で知らされるのは、F の日が終わる 1 時間前、B の開始、メッセージの受信、攻撃された・保有物を奪われたとき。All ではこれに加えて、制圧・戦闘・建設のすべてと、スタミナが回復した軍。PN Season alpha（29 Oct）
- Events には直近 3 件を重要度順に表示し、Mine と All を切り替えられる。Log は各行動を一度ずつ平易な言葉で記録し、占領は双方に伝える。PN Season alpha（29 Oct）
- Next up は、警告を優先して「今やること」を 1 つ出す。Space キーでその手順を実行できる。I キーでスタミナ満タンの次の軍を選択する。PN Season alpha（29 Oct）
- F: 1 日の長さは 8〜24 時間。シーズン全体の日の長さを 5 日ずつの袋（合計 80 時間）で抽選して決める。上部バーに今日の終わりと明日の長さが表示される。https://docs.realms.party/frontier （現行版 2026-10-29）
- F: 日が終わると、地図・霧・すべての軍が消える。Realm、建物、研究、部隊、Wheat、Labor、Essence、LORDS は残る。https://docs.realms.party/frontier （現行版 2026-10-29）
- F: Homecoming を育てた軍は、日の終わりに生存者の 3〜30% を本拠に帰す。https://docs.realms.party/frontier/expedition （現行版 2026-10-29）
- F: 「Today」で今日の合計、「Season」で全 Realm の順位を見られる。PN Season alpha（29 Oct）
- B: 60 分の試合なので、離席して戻る想定は薄い（推測）。B の自動化はブラウザを開いている間だけ動く。https://docs.realms.party/blitz/realms （現行版 2026-10-29）
- 試合の終わり: Results で順位が確定し、「See the end map」で終了時点の地図を誰でも見られる。PN Season alpha（29 Oct）

### 場面8: 負けた・遅れた後の再参加

- F: シーズン中ずっと無料で参加でき、遅れて来たプレイヤーも初日の人と同じ条件で始まる（引用:「a player who arrives late starts the same way」）。https://docs.realms.party/frontier （現行版 2026-10-29）
- F: 毎日マップがリセットされ、Realm は持ち物ごと次のマップに建て直される。軍を失っても、翌日はスロットのスタミナが満タンに戻る。https://docs.realms.party/frontier 、 https://docs.realms.party/frontier/armies （現行版 2026-10-29）
- F: 他プレイヤーから攻撃されないので、PvP で拠点を失うことはない。https://docs.realms.party/frontier （現行版 2026-10-29）
- B: 最後の Realm を失ったら、試合終了まで観戦する。https://docs.realms.party/blitz 、 https://docs.realms.party/blitz/armies （現行版 2026-10-29）
- B: Next up は、負けた後に次の軍をどこで編成するかを示す。PN Season alpha（29 Oct）
- B: 試合ごとに独立しており、次のスロットは 90 分ごとに来る。全プレイヤーが試合後にチェストを受け取る（99.98% の確率で参加費 1 回分の LORDS）。https://docs.realms.party/blitz/entry 、 https://docs.realms.party/blitz/scoring （現行版 2026-10-29）
- B: レーティングの変動は 1 試合で最大 45。剣（sword）で上昇量 2 倍、盾（shield）で下降量半分。シーズン賞金はレーティング上位 20% に配られる。https://docs.realms.party/blitz/scoring （現行版 2026-10-29）
- B: 得点 0 のプレイヤーは同率最下位（一度も行動しなかった登録者を含む）。https://docs.realms.party/blitz/scoring （現行版 2026-10-29）

---

## 2. パッチノートが修正を記載している「痛み」の一覧

ラベル: 「公式パッチノートが修正を記載（以前の問題の示唆）」。各行で「→」の右側に、修正内容から読み取れる以前の問題を書いた（推測を含む）。出典は PN（https://play.realms.party/scroll 、 https://docs.realms.party/changelog ）。

### Season alpha（29 Oct 2026）の「Fixes」
1. Selection holds → 以前は、命令が完了すると軍の選択が外れ、カードを閉じると位置を見失っていた。公式パッチノートが修正を記載（以前の問題の示唆）
2. Numbers stay put → 以前は、操作の後に貯蔵量やスタミナの表示が空白になり、前の命令が反映されるまで次の命令を出せなかった。公式パッチノートが修正を記載（以前の問題の示唆）
3. One press, one send → 以前は、2 回押すと同じ操作が二重に送信され、応答待ちの状態も表示されなかった。公式パッチノートが修正を記載（以前の問題の示唆）
4. A map that fails says so → 以前は、地図の描画に失敗しても何も知らされず、自分の Realm にたどり着けないことがあった。公式パッチノートが修正を記載（以前の問題の示唆）
5. Chat reconnects → 以前は、接続が切れるとチャットが自動で戻らなかった。公式パッチノートが修正を記載（以前の問題の示唆）
6. Armies on the ground → 以前は、行軍中の軍が地図の上で浮いて揺れていた。公式パッチノートが修正を記載（以前の問題の示唆）
7. Relics end on time → 以前は、時限付き Relic の開始・終了時刻がずれていた。公式パッチノートが修正を記載（以前の問題の示唆）
8. Show frames both → 以前は、「Show」を押しても自軍と対象が同時に画面に収まらなかった。公式パッチノートが修正を記載（以前の問題の示唆）
9. （Blitz）Captured hyperstructures pay at once → 以前は、奪った Hyperstructure の得点がすぐには入らず、持ち分（share）も占領に追随しなかった。公式パッチノートが修正を記載（以前の問題の示唆）
10. （Eternum）Trade opens → 以前は、Trade を開くとゲームが止まり、市場の一部の資源・Relic の画像が表示されなかった。公式パッチノートが修正を記載（以前の問題の示唆）

### Season alpha の「New」のうち、理解・把握の不足を補う項目
「Fixes」ではないため、上の修正ラベルとは区別し、何が足りなかったかは推測として書く。
- Next up、Build order、What a right-click does、the attack forecast（確実に負ける場合は代替案を示す）、Events と Log（占領は双方に伝える）、Notifications、Map tokens と Ownership rings、One Transfer window（Transfer / Arrivals / Automation / Balances を 1 つに統合。拒否された輸送は再送できるよう選択されたまま残る）、Deploy by troop column、Build cards（費用と手持ちの比較）、build の拒否理由とその解決策ボタン（Frontier）。
- 推測: これらは以前のクライアントで「次に何をすべきか」「右クリックすると何が起きるか」「攻撃したらどうなるか」「不在中に何があったか」「輸送がどの画面に散らばっているか」が分かりにくかったことを示している。旧ドキュメントで「資料で未確認」としていた項目（通知、イベントログ、戦闘プレビュー）は、現行版で明示的に追加された。

### 過去リリースの記述で、以前の問題を示唆するもの
- Series 0（28 Mar 2026）: 「the board fills during the game, not only at the end」→ 以前は、リーダーボードが試合終了まで埋まらなかった。公式パッチノートが修正を記載（以前の問題の示唆）
- Blitz MMR（31 Jan 2026）の Eternum タブ: 「Quests are disabled for now.」→ クエスト機能の停止（問題の内容は資料で未確認）。
- Phases and brackets（3 Sept 2025）: Blitz から Storage を削除。推測: 倉庫管理の負担を取り除いた。
- Season alpha の Blitz タブ: Realm ごとに 1 兵種、初期部隊を各兵種 3,500 から 1 兵種計 2,000 へ（「10,500 → 2,000」）、Labor による生産を廃止、行軍 Wheat を 0.03 から 0.05 へ、無料参加枠と協賛を廃止。推測: 初期状態と生産の選択肢を単純化した。

---

## 3. 現行版で、理解を助けるために書かれていること（現行版 2026-10-29）
- 「Fights forecast = result」の方針: B は「no dice」と明記し、攻撃予測で結果が分かる。F のドキュメントも同じことを書いているが、PN とは矛盾している（0.2 節）。https://docs.realms.party/blitz/armies 、 https://docs.realms.party/frontier/armies
- 「消えるもの / 残るもの」の対照表（F の日の終わり）。https://docs.realms.party/frontier
- 「What you can do / What you can't do」のリストを F と B の両方のトップページに置いている。https://docs.realms.party/frontier 、 https://docs.realms.party/blitz
- 戦闘の計算例の表、バトルタイマーの加算例。https://docs.realms.party/blitz/armies
- B の建物費用の全表（静的に掲載）、F の研究費用の全表、探索で見つかる物の確率表、守備隊の強さの表、チェストのレアリティ表。
- キーボードショートカット（B / P / M / T、Space、I）。PN Season alpha（29 Oct）

## 4. UX 比較で重要な事実 追加トップ10（現行版 2026-10-29）
1. サインインは Discord かメールのコードで、プレイにウォレットは不要。署名は端末の鍵が行う。https://docs.realms.party/account/sign-in
2. F は無料で、他プレイヤーから攻撃されない。マップは毎日（8〜24 時間ごとに）作り直され、Realm と建物・研究・貯蔵は持ち越される。https://docs.realms.party/frontier
3. F は遅れて参加しても初日と同じ条件で始まる（追いつきの問題を設計で回避している）。https://docs.realms.party/frontier
4. B は 60 分・最大 24 人で、90 分ごとにスロットがある。参加費は LORDS（今シーズンは 100、現在はテストトークン）。https://docs.realms.party/blitz 、 https://docs.realms.party/blitz/entry
5. B はサイコロなしで、攻撃予測がそのまま結果になる。予測は双方の損失を示し、確実に負ける場合は代替案を出す。https://docs.realms.party/blitz/armies 、 PN Season alpha
6. HUD の「Next up」は、今やることを 1 つだけ（警告を優先して）示し、Space キーで実行できる。PN Season alpha
7. 通知は 3 段階（Off / Important / All）で、被攻撃・保有物の喪失・F の日の終了 1 時間前を知らせる。Events（直近 3 件）と Log（平易な言葉、占領は双方に）がある。PN Season alpha
8. 輸送・到着・自動化・残高を 1 つの Transfer ウィンドウに統合した。B の到着は 3 分ごとのタイミングで、呼び戻しはできない。PN Season alpha、 https://docs.realms.party/blitz/transport
9. F のスタミナはスロットに属し、疲れた軍を入れ替えても回復しない。Refill は LORDS で行う。https://docs.realms.party/frontier/armies
10. 現行版の 2 モードは、どちらもプレイヤー間の取引・輸送・同盟がない。B では最後の Realm を失うと観戦に回る。https://docs.realms.party/frontier 、 https://docs.realms.party/blitz

## 5. 現行版でも答えが出なかった問い
1. F の戦闘にサイコロ（d20）があるかどうか。ドキュメントとパッチノートが矛盾している。
2. B の Relic の効果時間は 3 分なのか 18 分なのか。
3. Eternum Season 2 の予定（現行ドキュメントにも PN にも記載なし）。
4. F のシーズンの長さと終了日（チェストの受け取り期間は「シーズン終了から 7 日に 1 時間足りない時点まで」とあるが、終了日自体は資料で未確認）。
5. 通知がどの経路で届くのか（ブラウザ通知なのか、メールなのか）。資料で未確認。
6. Log をどこまで遡れるか、オフライン中の出来事がどう要約されるか。資料で未確認。
7. B の生産レシピの数値表と探索報酬の表（静的 HTML では空欄。クライアント側で描画する部品と推測）。
8. ゲーム内の Market（Realms のマーケットプレイス）とゲームプレイの関係。
