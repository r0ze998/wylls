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

## 2. 市場側の対応状況：市場・経路ごとに「確認できたこと」と「未確認」を分ける（v0.4）

凡例：**確認**＝一次資料（当該市場の公式ページ・changelog）に記載がある。**未確認**＝資料に記載が無い、または第三者の記載のみ。記載が無いだけなら「非対応」とは書かない。

### 2.1 Metaplex Core asset（ガード無し、通常の Core）

| 市場 | 出品（list） | 購入（buy） | 送付（wallet 間 transfer） | 根拠 |
|---|---|---|---|---|
| Magic Eden（Solana） | **確認**：Creator Hub で Core コレクションを MCC アドレスで登録・出品できる | **確認**：「Metaplex Core … をひとつの画面で売買」と記載 | **未確認**：アプリ内の Core／cNFT の送付は非対応（外部ツール案内）と別記事に記載。ウォレットからの直接送付は市場の範囲外 | help.magiceden.io（Creator Hub 記事、cNFT/Core 記事）、magiceden.io |
| Tensor | **確認（部分）**：changelog「TAMM now supports Metaplex Core Collections」。mainnet 配備は延期の記載 | 同上 | — | dev.tensor.trade changelog |

### 2.2 Core asset ＋ Permanent Freeze ＋ Permanent Transfer Delegate（専用売買方式 S）

| 市場 | 出品 | 購入 | 送付 | 根拠 |
|---|---|---|---|---|
| Magic Eden | **非対応（規格から導ける）**：市場の譲渡は owner 署名か Transfer Delegate による `transferV1` で、凍結中は拒否される（Core 公式「Frozen Assets cannot be transferred」「Frozen Assets cannot be transferred by delegates」）。出品自体が受理されるかは**未確認** | **非対応（同）**：市場が我々の `Buy`／`TransferResident` を呼ばない限り成立しない | **非対応（同）**：ウォレットの送付は owner の `transferV1` | Core 公式・ソース（REAL-CORE-TEST §3）。市場側の挙動は未確認 |
| Tensor | 同上 | 同上 | 同上 | 同上 |

### 2.3 Token-2022 NFT ＋ Transfer Hook（一般市場対応方式 G）

| 市場 | 出品 | 購入 | 送付 | 根拠 |
|---|---|---|---|---|
| Magic Eden | **未確認**：「Token 22 対応」の記載はあるが、Transfer Hook 付き mint の追加口座解決への言及なし | **未確認** | **未確認**（ウォレット側の対応も未確認。Phantom は Token-22 の開発者文書を持つが、フック付き送付の記載は確認していない） | magiceden.io（一般記載）、docs.phantom.com（一般記載） |
| Tensor | **未確認**：第三者サイトの「Token Extensions 対応」のみ | **未確認** | — | solanacompass（第三者） |
| 参考：Meteora（DEX、NFT ではない） | DAMM v2：有効なフックは**拒否**（確認）。Presale Vault：追加口座を渡せば可（確認） | — | — | docs.meteora.ag |

### 2.4 公開環境での実証（別途承認事項）

確認できない部分は、devnet で次を行えば判る。**未承認の導入・鍵が要るため提案のみ**：

1. devnet でフック付き Token-2022 NFT を 1 つ mint（フック＝カウンタを進める最小プログラムの devnet 配備：SBF ツールと devnet 用のテスト鍵・devnet SOL が要る）。
2. Magic Eden／Tensor の devnet 対応面（存在するなら）で出品・購入・送付を試す。devnet UI が無い市場は mainnet でしか確かめられず、**mainnet での実証は実資金が要るため本件の範囲外**。
3. 同じ asset を Phantom／Backpack から送付し、追加口座解決の有無を確かめる。

必要な承認：devnet への SBF プログラム配備（新しいテスト鍵、devnet SOL の faucet）、SBF ツールの導入。得られる答え：「主要市場がフック付き T22 NFT を扱うか」（U19）。

## 3. 「互換性がない」と明記するもの

- M0（専用経路）：一般市場での売買は**できない**。売買は我々の `List`/`Buy`（SALE-PATH）か、市場が `TransferResident`／`Buy` を呼ぶ連携でのみ可能。
- M1（Oracle）：市場の通常フローとは**両立しない**（買い手確定前に宛先別の許可を書けない。宛先を限らない許可は世代更新を迂回される）。
