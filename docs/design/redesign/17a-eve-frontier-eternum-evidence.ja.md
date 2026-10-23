# EVE Frontier／Eternum 比較の根拠と留保

**状態：調査補足（2026-10-23）。Wylls の仕様決定ではない。** [比較と独自性の議論](17-summary-uniqueness-integration.ja.md)を更新するため、確認した事実、そこからの推論、未検証事項を分ける。Wylls で試す案は[補給サービスの設計提案](27a-composable-supply-design-proposal.ja.md)に置く。

## 先に読む結論

- **確認した事実：** EVE Frontier には、施設所有者が承認した Move 拡張、コードを書かずに組み立てるための外部ツール、SSU への納品と Gate の通行許可をつなぐ公開例がある。「EVE は開発者向けで、Wylls だけがノーコード」「複数施設の連携は Wylls だけ」という主張は成り立たない。ツールの継続稼働、利用率、初心者の成功率は未検証。
- **確認した範囲：** 固定した Eternum の公開コードには、その SHA で定義された72のコマンド経路と account／release／preset／権限の検査がある。調べた経路では、施設所有者が任意の拡張を選んで登録する EVE 型のフックは見つからない。Eternum に拡張がない、あるいは全ての稼働環境で不可能だとは言えない。
- **Wylls への推論・提案：** 技術の独占性を主張せず、「他人の設備を使って別の人が使える仕組みを作り、その依存関係が戦争の判断を変える」体験を通常の文明戦略プレイで試す。これは面白さと採用を検証する仮説であり、実績ではない。

## EVE Frontier：施設ごとの拡張と先行例

**公式資料で確認：** 世界の基本機能、Smart Assembly、プレイヤーによる Move 拡張は別の層である。[World explainer](https://docs.evefrontier.com/smart-contracts/eve-frontier-world-explainer)と[Smart Storage Unit の説明](https://docs.evefrontier.com/smart-assemblies/storage-unit)は、施設所有者が拡張を承認する仕組みを説明している。拡張が扱えるのは定義された施設操作と権限の範囲であり、基礎物理やサーバー処理を自由に置き換えるという意味ではない。

| 公開例 | 資料から言えること | 言えないこと |
|---|---|---|
| [EasyAssemblies](https://github.com/SuperChainStage/EasyAssemblies) | README はテンプレートと Protocol Chips、ブラウザでの Move 生成・コンパイル・ウォレットでの公開手順を説明する。 | 実利用率、初心者の成功率、現在の全機能の稼働。 |
| [Frontier Flow](https://github.com/Scetrov/frontier-flow) | README は型付きノード編集、Move 生成とビルド、公開を扱う画面・フローを示す。 | ロードマップにはウォレットからの直接公開も将来項目として載るため、公開経路のどこまでが現時点で動くか。 |
| [Gate 拡張の公式作成ガイド](https://docs.evefrontier.com/smart-assemblies/gate/build) | `corpse_gate_bounty` は SSU へのアイテム納品と Gate permit を組み合わせる例。 | 任意の複数施設サービスが、誰にでも日常的に使われていること。 |

**推論：** ノーコードの入口や複数施設接続の有無では Wylls を区別できない。比較すべきは、文明の生産・物流・戦争の中で、第三者の能力を再利用する依存関係がどれほど普通に発生し、戦略を変えるかである。EVE にそれが「不可能」とは主張しない。

## Eternum：調べたコード経路と既存の遊び

**参照した公開コードの固定 SHA：** [`da9e10a130dd6a4b5dad637ac602abf83554dda2`](https://github.com/BibliothecaDAO/eternum/tree/da9e10a130dd6a4b5dad637ac602abf83554dda2)。この HEAD を live deployment と同一視しない。Eternum、Blitz、Realms の Frontier は資料と時期を分けて扱う。

- [`command_routes.cairo`](https://github.com/BibliothecaDAO/eternum/blob/da9e10a130dd6a4b5dad637ac602abf83554dda2/contracts/l3/world-native/src/command_routes.cairo) は参照 SHA で定義された72のコマンド経路を列挙し、生産、資源移動、取引注文、銀行、ギルド、Hyperstructure のアクセス・分配に関する経路を含む。文明、交易、軍事、ギルド、利用範囲設定、分配そのものは Wylls の新規要素ではない。
- [`games_entry.cairo`](https://github.com/BibliothecaDAO/eternum/blob/da9e10a130dd6a4b5dad637ac602abf83554dda2/contracts/l3/world-native/src/games_entry.cairo) は direct transaction account、承認された account、現在の release、preset、コマンドの許可を検査する。任意のラッパーが世界コマンドを自由に呼べる、とは読めない。
- [`logic/release.cairo`](https://github.com/BibliothecaDAO/eternum/blob/da9e10a130dd6a4b5dad637ac602abf83554dda2/contracts/l3/world-native/src/logic/release.cairo) には登録 authority と launcher による適用権限がある。任意の施設所有者による世界ルール差し替えとは異なる。
- [agent runner の README](https://github.com/BibliothecaDAO/eternum/blob/da9e10a130dd6a4b5dad637ac602abf83554dda2/apps/agent-runner/README.md) と、[2023 年の Dojo 向け expansion starter](https://github.com/BibliothecaDAO/eternum-expansion-starter) も公開されている。「Eternum に bot や拡張はない」は誤り。

**限定した推論：** 上のコマンド入口と権限経路では、EVE のように施設所有者が任意の第三者拡張を登録するフックを確認できない。全コード、全モード、全 deployment に対する不存在の証明ではない。

## 比較から外してはいけないもの

| 観点 | Eternum：上記資料の範囲 | EVE Frontier：上記資料の範囲 | Wylls での扱い |
|---|---|---|---|
| 生産・交易・戦争 | 既存の中心的な遊び。 | [公式 FAQ](https://evefrontier.com/en/faq)と[製造ガイド](https://support.evefrontier.com/hc/en-us/articles/28958653997340-Forging-Industry-in-the-Void-The-Manufacturing-Path)に、探索、採掘、製造、施設、戦闘の説明がある。 | これらの存在を独自性とは数えない。 |
| 拡張の入口 | 参照コードには固定コマンドと権限検査。bot、古い mod starter もある。 | 所有者が承認する施設別の Move 拡張。外部の組立ツールもある。 | 許可された基本機能の接続を、通常プレイで検証する提案。 |
| 施設をまたぐ組み合わせ | 調べた経路で EVE 型フックは未確認。 | SSU 納品と Gate permit の公式例がある。 | 「世界初」「EVE には不可」とは言わない。 |
| 利用の実績 | このコード読解からは測れない。 | 公開 README・サンプルからは測れない。 | 第三者が自発的に使うかを試作で測る。 |

## 基盤と市場の違い［事実と提案を分離］

**公開資料で確認したこと：**

| 対象 | 基盤と合成の範囲 |
|---|---|
| EVE Frontier／Sui | [Sui の object model](https://docs.sui.io/develop/sui-architecture/object-model)は所有者・版を持つ object を中心にする。[Programmable Transaction Blocks](https://docs.sui.io/develop/transactions/ptbs/prog-txn-blocks)は Move call などの結果を同じ transaction の後続処理に渡せ、全体を原子的に成功・失敗させる。原子的な合成は Solana の独占ではない。[EVE の移行先](https://www.sui.io/blog/eve-frontier-migrates-to-sui-hackathon-live)は Sui **Testnet**。これだけで Sui mainnet の資産と EVE の操作が同一 transaction で接続済みとは言えない。 |
| Eternum／Starknet 系 | [固定 SHA の README](https://github.com/BibliothecaDAO/eternum/blob/da9e10a130dd6a4b5dad637ac602abf83554dda2/README.md)は native Cairo／Madara の shard ごとの Starknet appchain と、価値を扱う Starknet mainnet の層を分ける。全ゲーム操作が mainnet 上の同一状態で合成されると単純化しない。live 配置の全経路は未検証。 |
| Wylls の候補基盤／Solana | [CPI](https://solana.com/docs/core/cpi)で program 間を呼び出し、[PDA](https://solana.com/docs/core/pda)で program が管理するアドレスを設計できる。[transaction](https://solana.com/docs/core/transactions)の原子性は単一 transaction 内。CPI の深さ・計算予算、共有書込み先の[競合](https://solana.com/docs/core/transactions/transaction-pipeline)は設計・実測の課題であり、複数ターンの補給履行まで原子的にはならない。 |

[Circle の公式一覧](https://developers.circle.com/stablecoins/usdc-contract-addresses)には Solana、Sui、Starknet の各 mainnet の native USDC が載る。**USDC 対応だけ**は Wylls 固有の価値ではない。Solana では[手数料を別の fee payer が払う設計](https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction)も可能だが、実費と濫用の負担は残る。CPI と PDA を使っても、注文ごとの権限・予算の検査は Wylls 側で作る必要がある。

**Wylls で試す機会［提案・未採用］：**

1. 工場・輸送・予約の公開入口を、Solana 上の他の開発者が遠征準備や共同発注の道具に組み込めるようにする。入口の互換性、権限、負荷を検証する。単一の world account に書込みを集中させない構成は性能検証の候補であり、現行実装や性能改善の実績ではない。
2. 別ブランチにある agent-wallet の作業との接続を検討し、人間と AI が同じ検査入口から、対象機能・期限・予算を絞って注文する。推論費と transaction 手数料を分け、停止・撤権・重複防止を設計する。agent-wallet がこの文書の基点に統合済みとは扱わない。
3. 既に Solana を使う人が別 chain に移動せず参加できる入口を検討する。これは**獲得仮説**であり、既存ユーザー数や自動的な成長の証拠ではない。Wylls のローカル／devnet の確認と、将来の mainnet 資産への接続を分ける。

ゲームの重心に加え、基盤・市場・開発者の違いにも価値がありうる。ただし「他 chain では技術的に不可能」とは言わず、利用や外部開発の成立を測ってから評価する。

**説明候補［提案・未採用］：**「Solana の共有経済基盤の上で、プレイヤーが作った機能を他者や AI が再利用する文明戦略ゲーム」。共有基盤を使う価値は、公開入口の利用とプレイテストで確かめる。

## 確認範囲

この文書は公開資料と上記の固定 SHA のコードを確認した結果であり、live 環境の操作、利用量、収益、継続稼働、初心者の達成率を検証したものではない。Wylls の提案の成立も未検証。比較対象の機能が今後変われば記述を再確認する。
