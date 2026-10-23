# 付録B 比較調査の詳細

[第8章](../08-comparison-eternum-eve.md) の根拠です。2026-10-23 に、公式の文書とコードを読んで調べました。第8章の教訓の根拠になる主要な箇所（下の「執筆者が再確認」の印）は、執筆者がコードと文書の原文を開いて、もう一度確かめています。

**表記。** 確認（文書）、確認（コード）、非公式（コミュニティ）、見つからない（探したが見つからない。存在しないとは限らない）。

## B.1 EVE Frontier

### 版と出典

| 出典 | 確認した版 |
|---|---|
| https://docs.evefrontier.com （GitBook。全文は `/llms-full.txt`） | 2026-10-23 13:51 GMT に取得 |
| https://github.com/evefrontier/world-contracts | main `18f56ffe06be6e78d1fa7eb79006bfc694312ef6`（2026-10-23）。最新のリリースタグ `v0.0.35`（2026-08-20）。dev ブランチ `e2d914e`（2026-10-23） |
| https://github.com/evefrontier/builder-documentation | `4a2edd5`（2026-09-22） |
| https://github.com/evefrontier/builder-scaffold | `ebc321a`（2026-03-17） |
| https://github.com/evefrontier/dapps | `33e77c6`（2026-09-25） |
| https://github.com/evefrontier/eve-frontier-builders-program | `759a377`（2026-10-12） |
| CCP の発表「EVE Frontier to Launch on Layer-1 Blockchain Sui」 | 2025-10-08（https://fenris.com/news/2025/eve-frontier-to-launch-on-layer-1-blockchain-sui） |

**今の仕組み。** Sui/Move。稼働中のサーバー（Stillness）は Sui のテストネットに置かれています（確認：文書、`contracts/world/Published.toml`）。旧 Redstone/MUD/Solidity の `projectawakening/world-chain-contracts` は 2025-12-19 の commit を最後にアーカイブされています（確認：コード）。文書の「Resources」ページのパッケージ ID は、2026-09-24 の再配置より古いものです。

### 施設（Smart Assemblies）

| 型（コード） | 文書の名前 | 拡張でプログラムできるか |
|---|---|---|
| `world::storage_unit::StorageUnit` | Smart Storage Unit | できる |
| `world::gate::Gate` | Smart Gate | できる |
| `world::turret::Turret` | Smart Turret | できる |
| `world::network_node::NetworkNode` | Network Node（燃料からエネルギーを作る） | できない |
| `world::assembly::Assembly` | 汎用 | できない |

文書は「プログラムできるのは保管庫、ゲート、タレットの 3 種」と書きます（確認：文書）。

### 持ち主が規則を足す仕組み

- 施設は拡張を最大 1 つ持ちます（`extension: Option<TypeName>`）。持ち主の権限（`OwnerCap`）を持つ者が `authorize_extension<Auth>` で登録し、世界の関数は `Auth` の型が一致するときだけ動きます（確認：コード `storage_unit.move` L127）。
- `freeze_extension_config` は一度だけで取り消せず、「持ち主が凍結の後に拡張を変えられないように（no rugpull）」と注記されています（確認：コード `extension_freeze.move`。執筆者が再確認）。
- 保管庫の拡張は、本体の在庫、拡張だけが扱う「開いた」区画、指名した人の区画への出し入れができます（確認：コード）。
- ゲートは、拡張があると通行証（`JumpPermit`）が要ります。両端のゲートに同じ拡張が要り、通行証は 1 回で消えます（確認：コード）。
- タレットの拡張は、標的の優先順位を返すだけで、撃つのはゲームです（確認：コードと文書）。

### 基盤が守る制約（拡張では変えられない）

稼働状態、エネルギーと燃料、容量、品物の出どころ（`parent_id`：別の保管庫へチェーン上で移せない）、テナントの分離、ゲームとチェーンの橋渡し（ゲームサーバーの署名）、近さ（ゲームサーバーの署名による証明）、ゲートの接続、所有の権限（`OwnerCap` は包めない）、施設の設置と撤去（運営の署名が要る）。確認：コード（`storage_unit.move`、`gate.move`、`primitives/*.move`、`access_control.move`）。

**文書とコードの食い違い（調査で見つかったもの）。** 文書は「引き出しの前に近さを確かめる」と書きますが、`withdraw_item` に近さの検査はありません。ゲートの「20 km 以上離す」の検査は、Move のコードでは上限の距離しか見つかりません。

### 利用者の操作

- ゲーム内で施設に近づいて F を押すと、施設の dApp が開きます。持ち主は名前、説明、dApp の URL を設定できます（確認：文書「Connecting In-Game」）。
- 外部の dApp の操作は、利用者が SUI のガス代を払います（同）。
- 他人の保管庫には、利用者ごとの区画があります。利用者は自分の区画だけを扱え、持ち主の本体の在庫には触れません（確認：コード `check_inventory_authorization`）。

### 組み合わせの例

| 例 | 内容 | 出典 |
|---|---|---|
| 死体の懸賞 → 通行証 | 1 回の呼び出しで、保管庫に死体を納め、ゲートの通行証を出す | `contracts/extension_examples/sources/corpse_gate_bounty.move`（確認：コード） |
| 部族の通行証 | 部族が一致すれば通行証を出す | `tribe_permit.move`（確認：コード） |
| 通行料のゲート | 文書にコードの素描がある。公式のコードでは完成していない | 文書の Gate のページ |
| 共有の方針に従うゲート | ゲートの持ち主が CradleOS の方針オブジェクトに従う。「どの方針でもどのゲートの通行証も出せた」不具合を v3 で修正 | `CradleOS/cradleos/sources/gate_policy.move`（非公式） |
| 公式の意図 | 「あなたの市場は他人の通貨を使え、あなたのゲートは他人の通行名簿を参照できる」 | 文書の Smart Infrastructure のページ |

**組み合わせの制限**：拡張は施設ごとに 1 つ。`OwnerCap` は包めない。品物は保管庫をまたげない。新しい世界の配置ごとにパッケージ ID が変わる。dev ブランチの ADR 0002 は「組み合わせが限られる（Composition is limited）」を移行の理由に挙げています（確認：コード。執筆者が再確認）。

**安全の注意。** 公式の例 `extension_examples/sources/config.move` の `x_auth()` は `public` で、誰でも証を作れます（執筆者が再確認）。scaffold の写しは `public(package)` に直しています。

### EasyAssemblies、Frontier Flow、CradleOS

| 名前 | 何か | 所有者 | 最終の commit | 公式との関係 |
|---|---|---|---|---|
| EasyAssemblies | ひな形と部品の切り替えで Move のコードを作り、ブラウザでコンパイルして配置する。ゲート（部族の通行証、通行料、懸賞など）、保管庫（自動販売機、品物の交換、鍵付きの保管庫など）、タレットのひな形 | `SuperChainStage`（https://github.com/SuperChainStage/EasyAssemblies） | `3bc9bcd`（2026-04-01）。依存は world `v0.0.18`（古い） | 非公式。ハッカソンの Utility 部門で入賞。公式の Builders Program の文書が名前を挙げる |
| Frontier Flow | ノードをつなぐ画面から Move のコードを作る。調べた出力はタレットの判断 | `Scetrov`（https://github.com/Scetrov/frontier-flow） | `3c86fd4`（2026-10-21、v0.13.3） | 非公式。ハッカソンの技術部門で入賞。公式の Builders Program の文書が名前を挙げる |
| CradleOS | 部族の金庫、防衛、契約、投票、情報の Move パッケージとゲーム内の dApp | `r4wf0d0g23`（https://github.com/r4wf0d0g23/CradleOS） | master `70ef2a1`（2026-10-05） | 非公式。ハッカソンの総合 1 位。公式のリポジトリと文書に言及は見つからない |

ハッカソンの結果：CCP の発表（2026-04-24、https://fenris.com/news/2026/ccp-games-announces-winners-of-80-000-eve-frontier-sui-2026-hackathon）。

### 経済と停止

- 燃料をネットワークノードで燃やしてエネルギーを作り、施設は稼働するときにエネルギーを予約します（確認：文書とコード）。
- 燃料が尽きると、ノードとつながる施設が停止します（確認：文書。コードの `update_fuel` には「期待どおり動かない」という TODO）。
- 停止中は、持ち主を含めて保管庫の出し入れがすべて止まり、品物は残ります（確認：コード）。
- 保管庫を撤去すると、区画の中身はチェーン上で焼却されます（確認：コード）。ゲームの側の扱いは見つかりません。

### 見つからなかったこと

撤去で焼却された品物の、ゲームのサーバーでの扱い。ゲートの最短距離の検査の場所。Sui の本番ネットワークでの公開日。製造と精製の施設が汎用の型か。

## B.2 Eternum（Realms）

### 版と出典

| 出典 | 確認した版 |
|---|---|
| https://github.com/BibliothecaDAO/eternum | HEAD `da9e10a130dd6a4b5dad637ac602abf83554dda2`（2026-10-23） |
| https://docs.realms.party | 2026-10-23 に取得（ソースは `apps/game-docs/`） |
| `docs.eternum.realms.world` | `docs.realms.world` に転送。旧版で「Season 1 - Concluded」の表示 |

### 今の状態

- ゲームは Dojo の世界ではなく、自前の Cairo のコントラクト（`contracts/l3/world-native`）を、自前の Madara のチェーンで動かしています。Dojo の世界は 2026-09-18 の commit `e09cc622` で削除されました（確認：コード）。
- 形式は Frontier、Blitz、Eternum の 3 つです。設定には、文書にない Duel もあります（確認：コード）。
- 長期の Eternum 形式は「Season Ended」の表示で、本番の配置にあるのは Frontier と Blitz です（確認：文書とコード）。
- 「Season alpha」が 2026-10-29 付けのパッチノートにあり、Frontier を開きます（確認：コード）。
- 文書の説明文の多くは Season 1（2025）のままで、同じページの表（今の設定から作られる）と食い違う箇所があります。

### 経済

| 項目 | 内容 | 出典 |
|---|---|---|
| 資源 | 22 種の資源（希少度の 6 段階）、労働、ロバ、兵、小麦、魚、LORDS など。今の Eternum の設定で生産のレシピがあるのは 9 種 | `packages/types/src/constants/resource-ids.ts`、`config/source/eternum/resources.ts`（確認：コード） |
| 重さ | 資源と労働 1 kg、小麦と魚 0.1 kg、兵 5 kg、ロバと LORDS 0 kg | 同（確認：コードと文書） |
| 倉庫 | 今の設定では上限なし | `config/source/common/base-config.ts`、文書の Storage のページ |
| 運搬 | ロバは 1 回で使い切り。必要数は重さ ÷ 積載。移動時間は距離 × 秒/km | `src/transport.cairo`（確認：コード） |
| 銀行 | ちょうど 6 つ、運営だけが作る。資源ごとに 1 つの定積の AMM を全銀行で共有。手数料は流動性提供者 15%、持ち主 15%（持ち主の分は LORDS で銀行の建物に入る） | `logic/economy.cairo`、`src/market.cairo`、`config/source/eternum/economy.ts`（確認：コード） |
| 注文 | 出す側が品物を預ける。相手を 1 人に絞れる。1 人 10 件まで。手数料のコードは見つからない | `src/trade.cairo`、`logic/economy.cairo:111`（確認：コード） |
| ブリッジ | 入出金ごとに 2.5% × 3（veLORDS、シーズンのプール、クライアント）。クライアントの分は命令で指定した受取人へ。村は親の Realm に 5% | `logic/bridge.cairo`（確認：コード） |
| ゲームの外の売買所（Agora、Starknet の L2） | 文書は「流動性提供者 1% ＋ 運営 3%」、コントラクトの README の例は合計 1.5%。食い違っており、実際の値は確かめていない | https://docs.realms.party/overview/agora、`contracts/l2/ammv2/README.md` |

### 施設と、他人による利用

| 施設 | 他人が使えるか | 持ち主が条件を決められるか | 誰が受け取るか |
|---|---|---|---|
| 銀行 | 使える | 決められない（手数料は変更不可のプリセット） | 持ち主に 15%、流動性提供者に 15% |
| ハイパーストラクチャー | 参加範囲による | 建設への参加範囲（公開、自分だけ、ギルドだけ）。完成後の配分（最大 20 人、各 1% 以上） | 拠出者と株主に勝利点。奪取で株は新しい持ち主に移る |
| ワンダー | 誓約できる | 持ち主は誓約を取り消せる。持ち主の取り分は 30% で固定 | 持ち主 30%、誓約者 70% |
| 注文 | 使える | 値段、数量、相手 | 手数料なし |

出典：`logic/hyperstructures.cairo:210-231,342-355,580`、`logic/faith.cairo`（確認：コード）。

### 戦闘と奪取

- 襲撃では、襲う側が盗む資源を選び、積載で上限が掛かります（`src/raid.cairo`）。文書の「最も希少なものから」はコードと合いません。
- 奪取は建物の実体ごとの所有の移転で、蓄えた資源と建物も移ります（`logic/structures.cairo:605`）。Eternum では村を奪取できず、Blitz と Duel ではできます（確認：コード）。

### シーズンと形式

| 項目 | 内容 | 出典 |
|---|---|---|
| Season 1 | 入植の開始 2025-05-09 13:00 UTC、本編 2025-05-14。終了は 2025-06-04 ごろ（commit からの推定） | commit `fcaca820f`、`c1948a5b6e`（確認：コード） |
| Season 1 の賞金 | 100 万 LORDS ＋ 10 万 STRK。内訳は、上位 10 部族への勝利の賞（30 万 LORDS ＋ 5 万 STRK ほか）、達成（30 万 LORDS）、Daydreams のエージェント（25 万 LORDS ＋ 2.5 万 STRK）、芸術など（15 万 LORDS ＋ 2.5 万 STRK）。エージェントの報酬以外は手作業で配布 | https://docs.realms.party/eternum/prize-pool（確認：文書） |
| Season 2 | 計画の文書（2026-03-11）はある。公開された証拠は見つからない | `docs/prd/eternum-s2/*`（commit `22009c4713`、後に削除） |
| Blitz | 60 分、最大 24 人。参加費 100 LORDS。90% を宝箱の積立、10% を運営 | 文書の Blitz のページ、`config/source/blitz/native.ts`（確認：文書とコード） |
| Frontier | 無料、プレイヤー同士の戦闘なし、8〜24 時間ごとに新しい地図 | 文書の Frontier のページ |
| ロジックの差し替え | 運営は進行中のゲームのロジックの版を差し替えられる。文書の「誰もシーズンを止めたり変えたりできない」（Season 1 の文）と食い違う | `logic/release.cairo:65-80`（確認：コード） |

### AI と自動化

| 項目 | 内容 | 出典 |
|---|---|---|
| Season 1 の Daydreams エージェント | NPC のエージェント。運営の 1 つのアドレスが制御 | 旧コード（commit `4551a26db`）（確認：コード） |
| チームの振り返り | 上位のエージェントは、全体のチャットでプレイヤーに影響されると「非常に強く、脅威になりうる」。探索できなかった。狩るのは割に合わなかった | Season 2 の計画の文書（執筆者が再確認） |
| 今の計画 | 「雇う AI」（サンドボックスのエージェントを定額で提供）。実行部品 `apps/agent-runner` はあるが、Blitz 1 試合の検証は未実施 | `docs/plans/hired-agents-*.md`、`apps/agent-runner`（確認：コードと文書） |
| ブラウザの自動化 | 生産と輸送の繰り返し。タブを開いておく必要がある | `packages/core/src/automation/production.ts`、文書の Automation のページ |
| MCP | 見つからない | — |
| 柱の言葉 | 「人と AI エージェントが、チェーンが守る同じルールで一緒に遊ぶ」 | `apps/game-docs/docs/pages/overview/introduction.mdx:42`（執筆者が再確認） |

### 拡張と組み合わせ

| 項目 | 内容 | 出典 |
|---|---|---|
| 今の実装 | 外部のコントラクトからゲームを呼べない。`play()` は直接のアカウントだけを受け付ける（"direct account required"） | `src/games_entry.cairo:131-205`（執筆者が再確認） |
| 第三者のクライアント | コードは MIT。誰でも自分のチェーン（shard）を動かせる。ブリッジのクライアント手数料 2.5% を受け取れる | `deploy/shard/README.md`、`logic/bridge.cairo` |
| Season 0 の文書 | ゲームの分岐（fork）と変種を勧めていた | 旧文書（commit `f6e63b346`） |
| Season 1 のクエスト | 運営が許可した外部ゲーム（Dark Shuffle など）を探検者が遊び、目標の点で資源を受け取る。2026-01-31 に停止 | 旧コード（commit `4551a26db`） |
| Blitz の予測市場 | 外部の世界が `blitz_get_winner` を読んで決済。2026-08-11 に画面から外した。「L3 への移行で読み取りが壊れる」 | `docs/plans/realms-value-plane-design.md` |

### チーム自身が書いた問題（Season 2 の計画の文書、2026-03-11）

- 「Season 0 と 1 は最長 2 週間で、1 週間あまりで上位の部族の談合により結果が決まった」（執筆者が再確認）
- 「上位のプレイヤーは 1 日数時間を費やし、燃え尽きた」（同）
- 「新しい人がゲームを知ったときには、イベントが終わっていて、次のシーズンの予定がなかった」（同）
- 村の悪用（村からの安全な出撃、連続の襲撃で村が遊べなくなる）

## B.3 `research/BENCHMARK_ETERNUM.md`（main）の古い点

| 古い、または不正確な記述 | 今の事実 |
|---|---|
| `contracts/l3/game` などの Dojo の記述 | 2026-09-18 に削除。今は自前の Cairo |
| 「雇う AI は作られていない」 | `apps/agent-runner` がある（全試合の検証は未実施） |
| Blitz の賞金 70%／15%／15% と段位 | 90% 宝箱の積立、10% 運営。シーズン末に MMR の上位 20% |
| 「倉庫が満杯なら生産は無駄になる」 | 今の設定では倉庫に上限がない |
| 「襲撃は最も希少なものから盗む」 | 襲う側が選ぶ |
| 「村は奪取できない」 | Eternum だけ。Blitz と Duel ではできる |
| 「取引は最寄りの銀行を通る」 | クライアントの選択で、コントラクトはどの銀行も受け付ける |
