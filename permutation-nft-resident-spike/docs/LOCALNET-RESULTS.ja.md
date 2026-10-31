# mint 画面 × 実プログラムの接続結果（ループバック validator、2026-10-31、v0.7）

指示：mint 画面を**実プログラムの命令・口座・エラー**に接続し、承認済みローカル環境で実行できるところまで進める。模擬 RPC だけの成功を接続完了とは扱わない。

**到達点**：ページ（`web/mint.mjs`）が組む取引を、**実 Metaplex Core バイナリ**（mainnet 配備、sha256 `515541c8…`）と**実住民プログラム**（`program/`、sha256 `95e462f3…`）を載せた `solana-test-validator`（Agave 3.1.9、127.0.0.1 のみ）へ**実 JSON-RPC** で送り、確定・口座・エラーを実物で確認した。devnet・mainnet には何も配備していない（承認事項は `docs/DEVNET-APPROVALS.ja.md`）。

## 1. 何が「実物」で、何がまだ違うか

| 層 | v0.6 まで | v0.7（本結果） | devnet との残差 |
|---|---|---|---|
| 住民プログラム | LiteSVM 内で Rust テストから呼ぶ | **同じ `.so` を validator に載せ、ページが組んだ取引で呼ぶ** | 配備先（ID は配備鍵で決まる。テスト ID `68TBCtDEfvunEQYEb4cZSBnkPWnu2h6XuvSTmLctZyv5` = `sha256("wylls-resident-program id (test)")`） |
| Core | 同上 | **同じ mainnet バイナリを validator に載せる** | devnet の Core は Metaplex が配備した同 ID。版が mainnet と同じかは配備時に programdata のハッシュで確認する（REAL-CORE-PLAN §2） |
| 取引の組立 | ページ → 模擬 RPC が解釈 | ページ → **validator の runtime が検証**（署名、blockhash、手数料、preflight、CPI） | 無し |
| PDA | 模擬は `residentAccountOf(asset)`（サーバ導出） | **ページが `findProgramAddress` で `["config"]`・`["collection-authority"]`・`["resident", asset]` を導出**し、サーバ設定と一致しなければ `PdaMismatch` で止める | 無し |
| エラー | 模擬の文字列 | **実 preflight の `Custom(n)`／`custom program error: 0x…` を `ResidentError` 名に対応付け**（1005 PriceChanged、1008 AlreadyInitialized、1003 NotOwner、1004 StaleGen …） | 無し |
| 住民口座の読取 | 模擬レイアウト | **実レイアウト 133 B**（`decodeResidentAccount`：asset・tag15・gen・session…）を companion server が復号 | 無し |
| 保有一覧 `/mint/mine` | 模擬チェーンの走査 | **`getProgramAccounts`**（Core プログラム、memcmp offset 1 = owner、offset 33 = `Collection(collection)`）→ 各件を `verifyResidentAsset` で検証（索引だけで判定しない） | 公開 RPC は gPA を拒否・制限することが多い → DAS か自前索引（U28） |
| RPC | 模擬 | **実 JSON-RPC**（`/rpc` は validator へ転送。試験ノブは応答の握りつぶしと状態の秘匿だけ） | RPC 提供者（承認事項） |
| commitment | 模擬は常に finalized | ページの読取を **`confirmed`** に統一。`processed` だけの状態は「未決」として扱う（D25） | 無し |
| ウォレット | テストウォレット（Wallet Standard 形） | 同左 | Phantom／Backpack（実機・実拡張は未実施） |
| 価格 | 定数 | **config PDA の値**を読み、`SetPrice` で変えられる（試験価格） | 本番価格は未決（U24） |

## 2. 実プログラム上のブラウザ試験（`test/browser.localnet.test.mjs`、6 件すべて合格）

| # | 試験 | 実物で確認したこと |
|---|---|---|
| L1 | **正常系**：表示 → 接続 → mint（ウォレット署名 1 回、asset 鍵の署名を含む 1 取引）→ 確定 → 保有確認 → 「waitlist 登録完了」→ 再読込で「登録済み」 | 取引署名は validator で `err: null`。asset は Core 所有、住民 PDA は gen 0・asset 一致。treasury ＝ 0.1 SOL。支払者の減少 ＝ 価格＋rent（asset 233 B・住民 133 B）＋手数料 10,000（署名 2 件）。再読込後は localStorage の pending が無く、チェーン読取だけで「登録済み」 |
| L2 | **ロールバック（preflight）**：ページが古い価格を持ったまま、チェーン側は `SetPrice` 済み | 実プログラムが `PriceChanged`（1005）で拒否。残高不変、pending 無し、保有 0。設定を取り直して再押下すると新価格で mint 成立 |
| L3 | **応答消失 → 結果不明**：送信は着地、応答は 504、状態照会も null | 「結果がまだ分かりません… 再課金・再発行はしません」、mint ボタン無効。force click でも 2 件目は出ない（チェーン上 1 件）。状態が見えるようになると署名から解決して「登録完了」。保有は 1 のまま |
| L4 | **二重クリック**（連打＋スクリプトの click） | 取引 1、asset 1 |
| L5 | **A→B→A（relay 未観測）** | ブラウザのウォレット A と同じ seed の鍵で Node から実プログラムを操作：A の `SetSession`（鍵 K）、A と K の gen 0 署名済み op、`TransferResident` A→B（gen 1、session 0）、B の `SetSession`（K2）と K2 の gen 1 op、`TransferResident` B→A（gen 2）。その後、A の gen 0 op ＝ **StaleGen（1004）**、K の op ＝ **NotOwner（1003）**、K2 の op ＝ **NotOwner**、K の gen 2 新規 op ＝ **NotOwner**。住民口座：gen 2、ops 0、session 0。companion server には何も知らせていないが、`/mint/status` は B 保有時に B を、戻った後は A を gen 2 で返す。ページは再接続で「登録済み」 |
| L6 | **着地したロールバック**：支払い（System transfer CPI）が実行された後に Core の `CreateV1` が失敗する取引を `skipPreflight` で着地させる | チェーン上は失敗取引として記録。**treasury は増えない、支払者は手数料 10,000 lamports だけ減る、住民口座も asset も作られない**（取引全体が巻き戻る） |

模擬チェーンの 11 件（`test/browser.mint.test.mjs`）も同じページ・同じサーバの `MockAdapter` で引き続き合格。実プログラムでは追加で L6 と、`PriceChanged` が**プログラムの**エラーとして返ることを確認した。

画面の記録：`demo/screens-localnet/`（desktop と Chromium の iPhone 15 viewport、各 4 場面）。**viewport は実機・実ウォレットアプリの試験ではない**。

## 3. 構成（追加分）

| ファイル | 役割 |
|---|---|
| `src/rpc-client.mjs` | 実 JSON-RPC クライアント（health、genesis、blockhash、残高、口座、rent、airdrop、送信、状態、確認、gPA による保有一覧） |
| `src/resident-ix.mjs` | 実プログラムの命令（InitConfig／SetPrice／MintResident／TransferResident／SetSession／Op）、Core の CreateCollectionV1、PDA、口座レイアウト（config 106 B・住民 133 B）、エラー表、署名済み取引の組立、`Custom(n)` の取り出し |
| `src/localnet.mjs` | `solana-test-validator` の起動（`--reset`、一時 ledger、127.0.0.1、Core と住民プログラムを `--bpf-program` で搭載）と世界の初期化（collection 作成、`InitConfig`）。初期化鍵は乱数・メモリ内・使い捨て |
| `src/adapters.mjs` | companion server の裏側を 2 つに分離：`MockAdapter`（模擬）、`RpcAdapter`（実 RPC、実レイアウト復号、gPA 索引、ノブは応答握りつぶし・状態秘匿のみ） |
| `test/browser.localnet.test.mjs` | 上の L1〜L6 |
| `demo/mint-screens.mjs --localnet` | 実プログラム上の画面記録 |

起動：`node src/mint-demo.mjs --localnet --port 41990`（validator を起動し、ページを `http://127.0.0.1:41990/web/mint.html` に出す。`.local/programs/mpl_core.so` と `program/target/deploy/wylls_resident_program.so` が要る：ENV-RECORD）。

## 4. 接続して分かったこと（修正したもの）

| 事項 | 内容 | 対応 |
|---|---|---|
| commitment | 模擬 RPC は commitment を無視し常に finalized を返していたため、ページは既定（finalized）で読んでいた。実 validator では airdrop 直後の残高が finalized では 0 のまま約 13 秒続き、「SOL 不足」になった | 読取を `confirmed` に統一（`getBalance`・`getBlockHeight`・`getLatestBlockhash`、`getSignatureStatuses` は `searchTransactionHistory`）。`processed` だけの状態は未決として再照会（D25） |
| 手数料 | 署名は payer と asset 鍵の 2 件 → 10,000 lamports。表示（「署名 2 件」）と一致 | 変更なし（L6 で実測） |
| 価格の出所 | 模擬は定数。実物は config PDA | `RpcAdapter.config()` が config を復号して返す |
| 住民 PDA | 模擬は `sha256` 由来の擬似アドレス | ページで `findProgramAddress`。模擬モードだけ旧経路 |
| 保有一覧 | 走査 | gPA＋検証。公開 RPC では gPA が使えない前提で U28 |
| 期限切れの判定 | 期限切れ＝未着地としていた | ⑰からの共有（データ）を受け、期限切れ後は試行ごとの asset 口座の有無で判定（有＝confirmed、無＝finalized が期限を過ぎた後に finalized、一度観測したら `seen`；D28、模擬 B12）。実プログラム上では期限切れ待ち（約 150 block）を試験に入れていない |

## 5. まだ示していないこと（言い切らない）

- **devnet での実行**：配備・collection・config・treasury・RPC・公開先が未承認（DEVNET-APPROVALS）。ローカル validator と devnet の差は §1 右列。
- **実ウォレット**（Phantom／Backpack の拡張・アプリ）での署名、ネットワーク違いの実挙動、スマホ実機の往復。
- **公開 RPC での `/mint/mine`**（gPA 不可の場合の DAS か自前索引）。
- **既存サイトへの組み込み**（ソースが手元に無い：SITE-STATUS）。
- **本番価格・供給数・ロイヤリティ**（未決。試験価格の接続作業は止めていない）。
