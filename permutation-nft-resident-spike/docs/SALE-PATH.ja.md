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

## 4. ⑰（x402・USDC）との境界

実装していないもの：x402 の 402 応答・`X-PAYMENT` の検査・facilitator の共同署名・USDC の実トークン転送。本試作の `Buy` は模擬トークンで支払い脚を含む。

⑰ に求める契約（推測で作らない。相手の実装は相手が決める）：

| 項目 | 本側が提供 | ⑰ 側に必要 |
|---|---|---|
| 取引の形 | `Buy` 1 命令の取引（買い手署名、fee payer は relay）。USDC 転送は命令の中の CPI（`TransferChecked` 相当）で、支払先は出品者と運営 | x402 "exact" の payload として**この取引**を受け取り、既存の検査（「exactly one Register」のような現行規則）を `Buy` 命令の形に合わせること。金額・支払先は命令が固定し、facilitator は署名を足すだけ |
| 二重払い防止 | 署名を送信前に記録、再送は `AlreadyProcessed`、同じ key は 1 購入 | `X-PAYMENT-RESPONSE` に署名を返す。結果不明のとき署名で照会できること（`GET /f/tx/{sig}` 相当） |
| 失敗時 | 命令が失敗すれば支払いも戻る（取引の原子性） | 402 で理由（`InsufficientFunds`、`ListingStale`、`NoListing`）を返す |
| 境界外 | 価格の決め方、通貨、手数料率、返金規則 | — |

現行の `/f/x402/join`（`Pay+Join` の atomic モード）は「利用者署名の取引に relay が署名を足す」形で、同じ型。`Buy` も同型で接続できる見込みだが、⑰ の検査規則に合うかは⑰側で判断する。
