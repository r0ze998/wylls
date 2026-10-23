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

## 確認範囲

この文書は公開資料と上記の固定 SHA のコードを確認した結果であり、live 環境の操作、利用量、収益、継続稼働、初心者の達成率を検証したものではない。Wylls の提案の成立も未検証。比較対象の機能が今後変われば記述を再確認する。
