# 専用売買経路（最小案、試作 v0.3）

目的：代金の支払い・NFT の譲渡・`HOLDER_GEN` 更新・旧 session の失効を**同じ取引**で成立させ、途中で失敗したときに支払いだけ／譲渡だけが残らないこと。価格・通貨・販売手数料は**試験用の仮値**（`PRICE = 25_000_000`（6 桁テストトークン 25 単位）、手数料 250 bps）で、製品仕様ではない。

## 1. 命令

| 命令 | 署名者 | 内容 |
|---|---|---|
| `List {asset, price, mint}` | 現保有者 | 住民プログラムに出品を記録：`{seller, price, mint, gen = 現在の HOLDER_GEN}`。ガード無し asset は出品不可 |
| `CancelList {asset}` | 出品者 | 出品を消す |
| `Buy {asset, maxPrice?}` | 買い手 | **1 命令で**：出品の検査（存在、`seller == 現保有者`、`listing.gen == HOLDER_GEN`、`price ≤ maxPrice`）→ 買い手 −price、出品者 +price−fee、運営 +fee → asset を買い手へ（Permanent Transfer Delegate として CPI）→ `HOLDER_GEN += 1`、`SESSION = 0` → 出品削除 |
| `TransferResident {asset, to}` | 現保有者 | 無償譲渡（贈与）。同じく世代 +1・session 消去。出品があれば消す |

出品者の署名は `List` 時だけで、`Buy` 時には要らない（escrow 無し。asset は出品者の手元に残り、凍結されているので出品中も二重譲渡できない）。

## 2. 原子性（テストで確認）

| ケース | 結果 | テスト |
|---|---|---|
| 正常 | 支払い・所有者・世代・session・出品が同時に変わる | `sale.test.mjs` 1 |
| 支払い直後に失敗（注入） | 全て元のまま。支払いだけ残らない。失敗した署名は処理済みで、再送は `AlreadyProcessed` | 2 |
| 2 命令の取引 `[トークン転送, TransferResident]` で 2 つ目が失敗 | 1 つ目も戻る（取引単位の全体ロールバック） | 3 |
| 残高不足／上限価格超過 | 何も動かない | 4 |
| 出品後に贈与（世代が進む）→ 旧出品で購入 | `NoListing`／`ListingStale`。支払いなし | 4 |
| 二重購入（B と C が同じ出品） | 先着のみ成立。後着は `NoListing`、残高不変、再送は `AlreadyProcessed`。世代は +1 だけ | 5 |
| 同じ idempotency key の二重押し | 1 回の購入 | 5 |
| 送信後に応答消失 → 再試行 | 送信**前**に記録した署名でチェーンを照会し復旧。再送しない | 6 |
| 売買とゲーム操作の競合 | チェーンの実行順どおり。先に着いた操作は成立し買い手が引き継ぐ。後に着いた売り手の操作は `NotOwner`（買い戻しなら `StaleGen`） | 7 |

模擬チェーンの取引は複数命令をスナップショットとロールバックで原子的に実行する（`mock-chain.mjs` の `#snapshot`/`#restore`）。実 Solana では取引の原子性はランタイムが保証する。

## 3. 安全確認との対応（指示の 5 項目）

| 確認 | どこで |
|---|---|
| relay が譲渡を一度も観測しなくてもチェーン側で旧権限を拒否 | `buyback.test.mjs` 1・2（世代は Citizen 側、資格情報は世代束縛） |
| 通常の Core 譲渡・delegate・凍結解除・権限変更から世代更新を迂回できない | `sale.test.mjs` 8：plain transfer → `Frozen`、owner-managed Transfer Delegate → `Frozen`、owner の thaw は owner-managed freeze だけで永続凍結は残る、永続凍結の thaw は owner も collection authority も `Auth`。永続プラグインの authority は作成時に固定（公式）。ガード無し asset では delegate で世代更新なしに動く（対比） |
| A→B→A 後に A・B 双方の旧 session・capability・AI 委任・署名済み未送信が復活しない | `buyback.test.mjs` 1（A 側）・2（B 側）、`sale.test.mjs` 1・7 |
| 売買とゲーム操作の競合はチェーンの実行順 | `sale.test.mjs` 7、`transfer-loop.test.mjs` 2・3 |
| 二重購入・結果不明・応答消失後の再送で二重払い・二重実行なし | `sale.test.mjs` 2・5・6 |

## 4. 最小取引：買い手のウォレットだけで成立する購入（v0.4）

売買の検証は、まず **relay も x402 も使わない最小取引**で行う：

```
transaction {
  fee payer = 買い手ウォレット（唯一の署名者）
  instructions = [ Buy{asset} ]      // 必要なら ComputeBudget の prefix を前置（CU は実測後）
}
```

`Buy` 1 命令が、トークン転送（買い手→出品者、買い手→運営）・Core への CPI 譲渡（Permanent Transfer Delegate の PDA 署名）・Citizen の `HOLDER_GEN+1`／`SESSION=0`・出品削除を行う。模擬では `buildTx([ixBuy])` の署名者が買い手だけであることをテストで固定した（`sale.test.mjs` 1）。出品者の署名は `List` 時のみ。

実 Core での `Buy` の口座（想定）：買い手、出品者、運営、買い手・出品者・運営のトークン口座、mint、Token program、asset、collection、Core program、Citizen、出品 PDA、プログラム PDA（permanent delegate authority）、System。口座数と CU は LiteSVM で実測する（REAL-CORE-PLAN）。

## 5. ⑰（x402・USDC）との接続：検査規則・スポンサー・署名者の照合（v0.4）

**結論**：現行の `/f/x402/join`（`Pay+Join`）と「利用者署名の取引に relay が署名を足す」という外形は同じだが、**その一致は互換性も原子性も保証しない**。⑰ の実装の検査規則は `Pay+Join` に固く結び付いていて、`Buy` はそのままでは通らない。照合結果：

| ⑰ 側の規則（`permutation-gateway` の実装を読んだ事実） | `Buy` 取引との関係 | 必要になること（⑰が判断） |
|---|---|---|
| `classifyPaidJoin`：命令は**ちょうど 5 つ**（ComputeBudget 3 ＋ prize `Pay` ＋ game `Join`）、CU limit／price 0／loaded limit は固定値 | `Buy` は 1 命令（＋prefix）で、`Pay` も `Join` も含まない → **不一致** | `Buy` 用の分類器を別に定義する（命令数、prefix の固定値、`Buy` のタグと口座列） |
| `Pay` の 9 口座が「この season の pool・vault・mint・wallet の Entry」と一致すること | `Buy` の支払先は出品者と運営で、prize vault ではない | 支払先・金額が**命令側で固定**されることを分類器で確認する（出品 PDA の price・seller を読む） |
| 署名者は「fee payer（relay のプール鍵）・wallet・join gate」のみ | 最小取引は買い手が fee payer。x402 形にするなら fee payer を relay に替え、署名者は relay ＋買い手 | 署名者集合の定義替え。出品者は署名しない |
| `sponsor()`：fee payer は relay プールの鍵、`season` 口座が今季のもの、`checkRelayShape` の shape 許可表（`classify`）に `Buy` は**無い** | **不一致** | `shapes.mjs` に `Buy` の shape（口座列・署名者・L(kind)）を追加 |
| `drainGuard`：fee payer の減少 ≤ fee ＋ `allowanceFor(shape)`。`Buy` の allowance は未定義 | 出品 PDA の閉鎖で家賃が返る方向なら 0 でよいが未定義 | allowance の定義（0 か、Citizen 更新に伴う家賃） |
| 二重送信：`relayed`（署名の replay cache）と `AlreadyProcessed` | 同じ機構で足りる見込み | — |
| 応答消失：`landed()` は 60×250 ms 待ち、`SettlementPending`（504）で署名を返す | `Buy` も署名で照会可能 | `GET /f/tx/{sig}` で結果照会（既存） |
| x402 "exact" の `maxAmountRequired`・`payTo`・`asset` | 出品ごとに price・seller が異なる | 402 応答を出品ごとに生成（price は出品 PDA から） |

**原子性について**：`Buy` 1 命令の原子性は Solana の取引実行が保証する（命令が失敗すれば取引全体が失敗）。x402 の facilitator が署名を足しても壊れない。ただし「facilitator の検査を通った取引が実際に着地する」ことと「着地の有無を正しく返す」ことは⑰の実装の責務で、本側は保証しない。
