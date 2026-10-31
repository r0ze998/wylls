# 専用売買方式と一般市場対応方式の比較と推奨（2026-10-31、v0.3）

対象：**S（専用売買方式）**＝ Core ＋ Permanent Freeze ＋ Permanent Transfer Delegate ＋ 住民プログラムの `List`/`Buy`/`TransferResident`（試作 M0）。**G（一般市場対応方式）**＝ Token-2022 NFT ＋ Transfer Hook（フック = 住民プログラム、M3）。参考に **N（ガード無し Core ＋ relay 観測、M4）**。

| 観点 | S：専用売買 | G：Token-2022 ＋ Transfer Hook | N：ガード無し |
|---|---|---|---|
| **安全性（A→B→A で旧権限が復活しない）** | **構造的に保証**：譲渡経路がプログラムだけ。模擬で 46 件のテスト（買い戻し・迂回・競合・二重購入・結果不明） | **規格上は保証**：全 transfer でフック CPI。実行未確認。フックが参照する世代 PDA の設計次第 | **保証なし**（復活を実証） |
| 支払いと譲渡の原子性 | `Buy` 1 命令（模擬で確認） | 市場の取引に依存。我々の専用 `Buy` も併設可 | 市場依存 |
| **互換性（一般市場で売買）** | **なし**。売買は専用 UI か市場側の連携（`Buy` を呼ぶ）が必要 | **市場がフック付き Token-2022 NFT を扱えば可**。主要市場の対応は一次資料で**未確認**；DEX の例では「有効なフックは拒否」もある | 完全互換 |
| ウォレット表示 | Core asset として表示されるが「frozen」。送付ボタンは失敗する | Token-2022 NFT。フック付きの送付は追加口座解決が要るため、未対応ウォレットでは送れない | 普通 |
| **実装量** | 住民プログラムに 4 命令＋出品記録＋`HOLDER_GEN`／`SESSION_SETTER`（ABI パッチ 02 済み）、relay に desk、UI に出品・購入画面（⑦）。Core の mint は既存知識で可 | フックプログラム（`Execute`、`extra-account-metas` 初期化）、Token-2022 の mint（Metadata・Member・TransferHook 拡張）、Citizen の鍵付けを mint 由来に、relay の読取を Token-2022 口座へ。**METHODS の選定が Core から Token-2022 へ変わる**（verifier・herald・SDK の層も） | 最小 |
| **運用権限** | プログラム PDA が永続 Freeze／Transfer authority。運営はプログラムの upgrade authority を通じて間接的に全 asset を動かせる立場になる（開示と制限が要る） | フックプログラムの upgrade authority が全転送の可否を握る（同様の開示が要る）。mint authority は発行後に放棄可 | 発行元の authority のみ |
| 価格・手数料の決定権 | 出品者が価格、運営が fee（仮値）。市場手数料なし | 市場の手数料体系に従う＋フック内で何かを徴収するなら別設計 | 市場 |
| **未検証事項** | 実 Core での forceApprove 譲渡と凍結の優先（ソースで確認、実行未）、LiteSVM、CU、`Buy` の CPI 口座数、x402 との接続（⑰） | フック付き NFT の市場対応（一次資料なし）、フック内で書き込みが許される口座の制約、ウォレット対応、Token-2022 の group/member を使った collection 検証、全体の実装 | — |
| ⑰ との接続 | `Buy` を x402 payload にする同型（SALE-PATH §4） | 市場購入は⑰を通らない。専用 `Buy` を併設するなら同じ | — |

## 推奨

1. **本線の売買方式は今は決めない**。決め手は「主要市場がフック付き Token-2022 NFT の listing・購入・送付を実際に処理するか」で、これは一次資料がなく、小さな実証（devnet でフック付き mint を作り各市場で出品を試す）で確かめられる。これが**可**なら G、**不可**なら S が残る。
2. **当面の試作は S を維持**する。理由：安全性が構造的で模擬が揃っており、Core の選定（METHODS）と ABI パッチ 02 がそのまま使える。S を採っても、後に G へ移る余地を残すため、Citizen の鍵付け（住民 ID）と世代の規則は規格に依存しない形（asset/mint の address 由来）のまま保つ。
3. **N は採らない**。
4. 継続課題（次の担当範囲）：(a) G の市場対応の実証（devnet、新規導入が要るため承認待ち：REAL-CORE-TEST）、(b) S の実 Core 検証（同）、(c) ⑰ との `Buy` 接続契約の確定、(d) ⑦ の出品・購入・譲渡後案内の画面。

Permanent Freeze ＋ Permanent Transfer Delegate は**候補**であり、一般市場との非互換を受け入れる決定ではない（UNDECIDED U7）。Metaplex Core の本線採用も未決（U18）。
