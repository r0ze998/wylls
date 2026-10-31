# 初回 mint の一巡：サイト → 利用者のウォレット → devnet の NFT → waitlist 登録（v0.5、2026-10-31）

**完成条件**：devnet で、ウェブサイトから利用者が自分のウォレットでテスト SOL を払い、NFT を mint して waitlist 登録が完了する。
**現状（v0.6）**：画面と処理は模擬チェーン上の実ブラウザ（Chromium）で一巡と必須試験 11 件が通る段階。**実プログラムとの適合は、住民プログラム（`program/`）を実 Core と LiteSVM で検証した範囲まで**（`docs/REAL-CORE-RESULTS.ja.md`）。模擬 RPC の `MintResident` と実プログラムの口座順・データは揃えたが、**ページが実プログラムの取引を組んで devnet で通ることはまだ確認していない**（devnet 配備は未承認）。「devnet 配備を除く全部が完成」「RPC 先を替えるだけで動く」とは言わない。

決定事項の反映：**初回 mint の通貨は SOL で決定済み**（USDC・x402 は入口の条件にしない）。本番価格は未決で、devnet・ローカルでは変更可能な試験価格で進める。利用者自身のウォレットが取引を確認・署名する。NFT 取得＝waitlist 登録（別のフォーム無し）。公開後も同じ NFT を住民の操作権に使う。継続世界。devnet の価格は変更可能な試験価格（`TEST PRICE`）で、本番の販売条件ではない。

## 1. 画面（`web/mint.html`、`web/mint.mjs`）

| 要件 | 実装 | 試験 |
|---|---|---|
| devnet のテストで、本番の参加権や金銭価値を保証しないことの明示 | 冒頭の赤帯（`data-testid=notice`） | B1 |
| 接続先ネットワーク・試験価格・手数料・口座作成費の見込み | 「接続先と費用の見込み」カード。`GET /mint/config` の値（手数料＝署名 2 件、rent＝asset＋住民口座） | B1 |
| 支払い・NFT 発行・住民 ID 紐付けが同じ取引 | `MintResident` 1 命令（§4）。失敗は取引ごと戻る（手数料のみ消費） | B10 |
| 確定した取引と正規 collection・asset の保有を確認してから「登録完了」 | `getSignatureStatuses` → `GET /mint/status`（サーバがチェーンを読み、プログラム・collection・保有者・住民口座の紐付けを検査）→ 表示 | B1, B11 |
| 再読込・再接続でも保有状態を確認できる | 接続時に `GET /mint/mine` → `GET /mint/status`。ページの記憶ではなくチェーンの読取 | B1（reload）, B7 |
| 応答が消えたら既存の署名を照会し、結果不明のまま再課金・再発行しない | 送信**前**に `{signature, asset, lastValidBlockHeight}` を localStorage に記録。再開時は署名で照会。未決なら mint ボタンを無効化 | B6, B7, B9 |
| 期限切れ | `getBlockHeight > lastValidBlockHeight` かつ状態なし → 着地不可能と判定し再試行を許す。送信時の `Blockhash not found` も同様 | B8 |
| 接続先ネットワーク違い | RPC の `getGenesisHash` ≠ 設定値 → 全操作停止。ウォレットの口座が `solana:devnet` を持たない → 接続拒否 | B4 |
| SOL 不足 | 残高 < 価格＋手数料＋rent → 署名前に拒否 | B3 |
| 署名拒否 | ウォレットの拒否 → 何も送らず、記録も残さない | B2 |
| 二重クリック | `busy` と pending 記録で 1 取引 | B5 |
| スマホ（viewport） | 端末 UA で案内表示。ウォレットアプリへ行って戻る経路は「送信後に離脱 → 別タブ／再読込で再開」として **Chromium の iPhone 15 viewport** で試験。これは画面幅と再開経路の試験であって、実機の試験ではない | B7 |
| スマホ（実機＋実ウォレット） | **未実施**。Phantom／Backpack のアプリ内ブラウザ、または deep link で署名して戻る往復は、devnet 配備と実機が要る（§8） | — |

## 2. ブラウザ試験（`test/browser.mint.test.mjs`、Playwright の Chromium、模擬チェーン＋実取引バイト）

| # | 試験 | 結果 |
|---|---|---|
| B1 | 正常系：表示 → 接続 → mint（ウォレット署名）→ 確定 → 保有確認 → 登録完了 → 再読込で同じ | 合格 |
| B2 | 署名拒否 | 合格（送信 0、残高不変、pending なし） |
| B3 | SOL 不足（価格ちょうどで rent・手数料が足りない） | 合格（署名前に拒否） |
| B4 | 接続先違い（ウォレット mainnet／RPC の genesis 不一致） | 合格 |
| B5 | 二重クリック | 合格（取引 1、asset 1、課金 1） |
| B6 | 応答消失（送信は着地、応答 504） | 合格（署名で照会、再送なし） |
| B7 | 途中離脱→戻る／再読込、Chromium の iPhone 15 viewport（実機ではない） | 合格（pending が解決、取引 1） |
| B8 | 取引期限切れ | 合格（課金 0、再試行可） |
| B9 | 結果不明が続く → 再 mint 拒否 → 後で解決 | 合格 |
| B10 | 支払い後の処理失敗 | 合格（preflight で拒否、支払い残らず） |
| B11 | 譲渡後の旧保有者：登録なし、新保有者：登録あり | 合格（世代 +1） |

ユニット側（`node --test test/*.test.mjs`、ブラウザ試験込み）。relay 未観測の A→B→A で旧権限が復活しないことは、模擬では `test/buyback.test.mjs`、**実 Core＋実プログラムでは `svm-core/tests/core.rs`（LiteSVM）**。ブラウザ試験は模擬チェーン上。devnet での同じ試験は未実施。

実行：`node src/mint-demo.mjs --port 41990` → `http://127.0.0.1:41990/web/mint.html`（テストウォレット付き）。`node --test test/browser.mint.test.mjs`。

## 3. 処理の規則（サーバ `src/mint-server.mjs`、RPC `src/mint-rpc.mjs`）

- `GET /mint/config`：network、chainId、genesisHash、価格（test: true, changeable: true）、見込み費用、program/collection/treasury/PDA、命令の口座順。
- `POST /rpc`：JSON-RPC。模擬モードでは模擬チェーン、devnet モードでは設定 RPC へ転送（未実施）。
- `GET /mint/status?wallet&asset`：サーバ側の読取で `verifyResidentAsset`（Core プログラム所有・`AssetV1`・`Collection(期待値)`）→ 保有者 == wallet → 住民口座の `bound == residentId(asset)`。全部揃って `registered: true`。
- `GET /mint/mine?wallet`：wallet が保有する住民 asset（模擬は走査。devnet では DAS `getAssetsByOwner` か registry の索引が要る：§7）。
- `/mock/*`：試験ノブ（模擬モードのみ）。

## 4. `MintResident` 命令（住民プログラムへの提案。模擬 RPC が同じ口座順・データで実行）

```
accounts: [payer s,w] [treasury w] [asset s,w] [collection w] [collection_authority PDA] [resident PDA w] [config] [Core program] [System program]
data:     0x50 ‖ price: u64 LE   （画面が表示した価格。config の価格と違えば PriceChanged で拒否）
effects (all or nothing):
  payer → treasury : price（System transfer CPI）
  payer → rent     : asset 口座 ＋ resident 口座
  Core CreateV1    : collection 配下、owner = payer、Permanent Freeze Delegate ＋ Permanent Transfer Delegate = program PDA（collection_authority PDA が署名）
  resident 口座    : { gen: 0, session: 0, bound: sha256("PSF-RES" ‖ asset)[0..15] }
```

- asset は**ブラウザが生成する使い捨て鍵**が署名する（Core の作成は asset 口座の署名を要する）。鍵は取引の後に捨てる。保有者は payer。
- collection の update authority を**プログラム PDA**にすることで、サーバの常時オンライン鍵（hot key）が不要になる。これが「鍵の保管」の中心（§7）。
- 譲渡時の世代更新（`TransferResident`／`Buy`、CONTRACT §10）はこの asset に対しても働く。**世代更新を迂回できる NFT（ガード無し）は住民アカウントとして完成扱いにしない**。

## 5. devnet モードで必要になる差（未実施）

| 項目 | 模擬 | devnet |
|---|---|---|
| RPC | 模擬 | 公開 devnet RPC（`https://api.devnet.solana.com`）または運営の RPC。`/rpc` 転送か、ページから直接 |
| `getGenesisHash` | 設定値 | devnet の genesis（`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`、実行時に取得して記録する） |
| 住民口座の導出 | サーバの `/mint/derive` | PDA をページで導出（seeds `["resident", asset]`、program id） |
| `/mint/mine` | 走査 | DAS `getAssetsByOwner`（Metaplex DAS 対応 RPC）か、registry の索引（`src/registry.mjs`） |
| 価格 | 定数 | config PDA の値（運営が devnet 上で変更可） |
| 手数料・rent の見込み | 定数 | `getFeeForMessage`、`getMinimumBalanceForRentExemption` |
| explorer | — | `https://explorer.solana.com/address/<asset>?cluster=devnet` |

## 6. 既存サイトへの組み込み（SITE-STATUS.ja.md）

既存サイトのソース（`wylls-site/`）はリポジトリに無く、公開先は `DEPLOYMENT_DISABLED`。別サイトの新設はしない。組み込みは、既存 `index.html` の `#waitlist` 節（メールフォーム）を `web/mint.html` の 4 カードに置き換え、`mint.mjs`・`wallet-standard.mjs`・`/sdk/*` を同じオリジンに置く形。必要なファイルと作業は SITE-STATUS §2・§3。

## 7. 実行前の確認：必要な範囲の一括提示（承認依頼）

| # | 範囲 | 内容 | 取得元・固定版・変更場所 | 配備対象 | 管理者・更新権限 | devnet SOL | 鍵の保管 | 公開先 |
|---|---|---|---|---|---|---|---|---|
| R1 | **追加導入**（REAL-CORE-PLAN §1） | Core `.so`（mainnet 配備、sha256 `af40bd11…`）、LiteSVM `=0.16.0`、`mpl-core` `=0.12.1`、Rust 1.95.0；我々のプログラムをビルドするなら Agave 3.1.9 ＋ platform-tools v1.52 | REAL-CORE-PLAN §1 の表 | 作業環境のみ | — | 0 | テスト鍵のみ | — |
| R2 | **住民プログラムの実装と devnet 配備** | Frontier プログラム（または独立した最小プログラム）に `MintResident`／`TransferResident`／`List`／`Buy`／config を実装し、SBF ビルドして devnet へ `solana program deploy` | 変更場所：`permutation-frontier/`（パッチ 02 ＋ prologue 変更）か新規 crate | devnet | **upgrade authority**：配備者の鍵。推奨：運営の多重署名、または検証後に凍結（TRUST-MODEL §3）。**config PDA の authority**（価格変更）：運営鍵 | 配備に約 **2× プログラム容量 × 6960 lamports**（例：400 KB → 約 5.6 SOL、配備中は buffer で一時的に 2 倍）。faucet は 1 アドレス 1 日 1〜5 SOL のため数日分か複数アドレス | 配備鍵：ファイル（0600）を運営の端末に。本環境に**永続鍵を置かない** | — |
| R3 | **collection の作成** | Core collection を 1 つ作成。update authority ＝ プログラム PDA（R2 の後） | mpl-core の `createCollection`（devnet） | devnet | collection authority ＝ PDA（運営が直接は触れない。変更はプログラム経由） | 約 0.003 SOL | 作成時の一時鍵は配備鍵 | — |
| R4 | **treasury・config** | treasury（SOL の受け口）＝運営のアドレス（鍵は本環境に置かない）。config PDA に試験価格（例：0.1 SOL、変更可）を書く | プログラムの `InitConfig` | devnet | config authority ＝ 運営鍵 | 約 0.002 SOL | — | — |
| R5 | **devnet での実発行試験** | テストウォレット 3〜5 個で B1〜B11 相当を devnet で実行。A→B→A の世代更新も `TransferResident` で実行 | ブラウザ（Chromium、Phantom/Backpack 拡張は本環境に無し → テストウォレットで実施、実ウォレットは所有者の端末で） | devnet | — | ウォレット 1 個あたり 価格 ＋ 約 0.01 SOL；合計 約 1 SOL | テスト鍵のみ、記録に秘密鍵を含めない | — |
| R6 | **サイト公開** | companion server（`/mint/*`、`/rpc` 転送）と静的ページの公開。既存サイト（Vercel）の復旧は SITE-STATUS §3 | 公開先候補：(a) Vercel 既存プロジェクトに `/mint` を追加、(b) herald に同居（`permutation-server/web`）、(c) GitHub Pages ＋ 別ホストの companion | — | サイト担当・Vercel 所有者 | 0 | — | **要決定** |
| R7 | **`/mint/mine` の索引** | DAS 対応 RPC（Helius 等は API キーが要る）か、自前 registry。API キーは新しい外部アカウント＝**承認事項** | — | — | — | 0 | API キーの保管 | — |

**止めているもの**：R1〜R7 すべて。本環境で**行ったこと**：模擬チェーンでの実装と試験、mainnet からの Core バイナリの読み取りとハッシュ記録（バイナリは破棄）。

## 8. 試験計画（devnet、R1〜R5 承認後）

B1〜B11 を devnet で再実行し、各ケースの取引署名・asset・保有者を `docs/DEVNET-RESULTS.ja.md`（未作成）に記録する。加えて：実ウォレット（Phantom／Backpack）での署名拒否・ネットワーク違い（mainnet のまま）・スマホのアプリ内ブラウザからの mint と戻り。秘密鍵は記録に含めない。
