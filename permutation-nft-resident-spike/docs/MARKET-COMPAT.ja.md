# 一般マーケットプレイス互換の候補（資料上の可能性と実行確認を分ける。2026-10-31、v0.3）

問い：**一般のマーケットプレイスで売買でき、かつ A→B→A で旧権限が復活しない**方式はあるか。

必要条件（CONTRACT §10）：asset が手を替えるとき、**同じ取引の中で**我々のプログラムが動き（世代 +1、session 消去）、それを迂回する譲渡経路が無いこと。マーケットプレイスの売買は「買い手の支払い」と「asset の譲渡」を市場のプログラムが組み立てる取引なので、我々の処理はその取引の中に**市場側が意図せず含める**形でしか入らない。すなわち、譲渡のたびに我々のプログラムを呼ぶ仕組みが**トークン規格側**に要る。

## 1. 候補の一覧

| 候補 | 譲渡時に我々のプログラムが動くか | 迂回可能性 | 市場互換 | 必要な追加口座・命令 | 資料 | 実行確認 |
|---|---|---|---|---|---|---|
| **M0. Core ＋ Permanent Freeze ＋ Permanent Transfer Delegate（専用経路、試作）** | 動く（我々の `TransferResident`／`Buy` が唯一の経路） | なし（owner 譲渡・Transfer Delegate は frozen で拒否、永続プラグインの authority は固定） | **無し**（市場の listing・escrow・delegate 譲渡が全て frozen で失敗） | 住民プログラムに `List`/`CancelList`/`Buy`/`TransferResident`、出品記録 | Core 公式・ソース（REAL-CORE-TEST §3） | 模擬のみ |
| **M1. Core ＋ Oracle 外部プラグイン（transfer を既定 Rejected、プログラムが許可を書く）** | **動かない**。Oracle は Core が**読むだけ**で、プログラムに CPI しない。許可を書く命令は譲渡の**前**に別取引で走る | 許可を書いた後、Oracle が `Pass` のままなら**次の譲渡も**世代更新なしで通る。宛先別 PDA（`PreconfiguredRecipient`、seeds `["mpl-core", recipient]`）なら 1 許可 1 譲渡だが、市場の escrow／買い手は出品時に不明 | 実質**無し**（市場は我々の許可命令を知らない。買い手確定前に許可できない） | Oracle 口座（asset 別または宛先別 PDA、家賃）、`ArmTransfer{recipient}` 命令、Oracle 状態の解除命令 | docs/core/external-plugins/oracle、`lifecycle.rs`（外部プラグインは reject のみ、`ForceApproved` 不可） | 模擬せず |
| **M2. Core ＋ LifecycleHook（譲渡時に CPI）** | 動くはず（設計上） | — | 市場互換になり得る（市場は何も変えずに我々のフックが走る） | — | **使えない**：`plugins/utils.rs`「currently we are blocking adding LifecycleHook and LinkedLifecycleHook external plugin adapters as they are still in development」 | 不可 |
| **M3. Token-2022 NFT（Metadata／Group Member 拡張）＋ Transfer Hook 拡張（フック = 我々のプログラム）** | **動く**：Token-2022 が全ての transfer で mint に記録されたフックプログラムを CPI する（公式「this extension tells Token-2022 which program to invoke whenever a transfer is conducted」「The transfer hook program can then perform any custom functionality」）。フックは追加口座（`extra-account-metas` PDA、`is_writable` 可）を宣言でき、自分の PDA（世代カウンタ）を更新できる。失敗を返せば譲渡は失敗 | **なし**（規格レベル：フック無しの転送は不可。追加口座を渡さない転送は失敗） | **市場がフック付き Token-2022 NFT に対応していれば**互換。対応の有無は**公式に確認できなかった**（下記 §2） | mint に Transfer Hook・Metadata・Member 拡張、フックプログラム、`extra-account-metas` PDA、世代 PDA（住民 Citizen）。Core ではなく Token-2022 の標準なので METHODS の選定が変わる | solana-program.com/docs/token-2022/extensions、transfer-hook-interface | 模擬せず |
| M4. ガード無し（通常 Core）＋ relay 観測 | 動かない | **迂回そのもの**（`buyback.test.mjs` 最終テスト） | 完全互換 | — | — | 模擬（穴を実証） |

## 2. 市場側の対応状況（確認できた範囲）

| 市場 | Core | Token-2022 | Transfer Hook 付き | 出典の種類 |
|---|---|---|---|---|
| Magic Eden | 対応（Creator Hub は MCC アドレスで出品；アプリ内の Core/cNFT の**送付**は非対応） | 「Token 22」対応と記載 | **不明**（記載なし） | help.magiceden.io、magiceden.io（一次だが詳細なし） |
| Tensor | TAMM が Core コレクション対応（changelog）。mainnet 配備は延期の記載 | 第三者サイトが「Token Extensions 対応」と記載 | **不明**（一次資料なし） | dev.tensor.trade changelog、solanacompass（第三者） |
| Meteora（参考・DEX） | — | DAMM v2 は「フックのプログラム ID と authority が未設定なら対応、**有効なフックは拒否**」。Presale Vault は追加口座を渡せば可 | 製品により**拒否**または**要追加口座** | docs.meteora.ag（一次） |

結論：**M3 は資料上は唯一「市場互換＋世代更新を迂回不可」を同時に満たす候補**だが、(a) 主要 NFT 市場がフック付き Token-2022 NFT の listing・購入を実際に処理するかは一次資料で確認できず、(b) Core ではなく Token-2022 標準への切替になり、(c) 実行確認はしていない。M1 は Oracle の性質（読むだけ、reject のみ）から市場互換を満たせない。M2 は現時点で使えない。

## 3. 「互換性がない」と明記するもの

- M0（専用経路）：一般市場での売買は**できない**。売買は我々の `List`/`Buy`（SALE-PATH）か、市場が `TransferResident`／`Buy` を呼ぶ連携でのみ可能。
- M1（Oracle）：市場の通常フローとは**両立しない**（買い手確定前に宛先別の許可を書けない。宛先を限らない許可は世代更新を迂回される）。
