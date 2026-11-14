# devnet へ進むために必要な承認の一括提示（2026-10-31、v0.7）

本環境で**まだ実行していないこと**を、鍵・配備・公開を伴う順に一つの表にまとめた。承認が無いものは実行しない。承認されたものだけを、記載の範囲で行う。価格・供給数・ロイヤリティが未決でも、試験価格（config で変更可）での接続作業はこの表の前提に含めている（U24 は本番条件の話）。

## 1. 一覧

| # | 項目 | 具体的に何をするか | 要る鍵・権限 | 鍵の保管（提案） | devnet SOL（概算） | 外部アカウント | 承認が無い時に起きること |
|---|---|---|---|---|---|---|---|
| A1 | **プログラムの devnet 配備** | `program/target/deploy/wylls_resident_program.so`（2026-11-14 の build：165,360 B、sha256 `947da0b9…`、`program/BUILD-RECORD.json`。10/31 の 153,120 B・`95e462f3…` は古い）を `solana program deploy --url devnet`。配備後、programdata のハッシュと ELF 長を記録 | **配備鍵**（手数料と rent の支払者）、**upgrade authority**（既定では配備鍵） | 配備鍵・upgrade authority は**所有者の端末**（ファイル 0600 か HW）。本環境には置かない。本環境で配備するなら「配備専用の使い捨て鍵を所有者が作り、配備後に upgrade authority を所有者の鍵（または多重署名）へ移す」手順が要る（TRUST-MODEL §3） | 約 **2.2 SOL**（program 容量 ×2 の rent ≒ 153 KB × 2 × 6,960 lamports/byte ≒ 2.13 SOL、配備中は buffer で一時的に 2 倍近く）。faucet は 1 アドレス 1 日 2〜5 SOL 程度 | 無し（公開 devnet RPC） | 配備できない。ローカル validator まで |
| A2 | **upgrade authority の形** | (a) 配備鍵のまま、(b) 多重署名（Squads 等）、(c) 検証後 `--final` で凍結。devnet は (a) か (c) で足りる | 同上 | 同上 | 0 | (b) は外部サービス | 配備後の変更権限が曖昧なまま |
| A3 | **collection の作成** | Core の `CreateCollectionV1`（update authority ＝ プログラムの `["collection-authority"]` PDA）。名前・URI は仮値（`Wylls Resident (test)`） | 作成の支払い鍵のみ（PDA が authority なので、以後は運営が直接触れない） | 支払い鍵は使い捨て可 | 約 0.003 SOL | 無し | mint 先が無い |
| A4 | **config の初期化（`InitConfig`）** | 試験価格（例 0.1 SOL、変更可）、treasury、collection を config PDA に書く | **config authority**（価格変更と treasury 変更ができる鍵） | 所有者の端末。本環境には置かない | 約 0.002 SOL | 無し | 価格・treasury が決まらず mint 不可 |
| A5 | **treasury** | 支払い（テスト SOL）の受け口アドレス。所有者のアドレスを指定するだけで鍵は不要 | 無し（アドレスのみ） | — | 0 | 無し | config を書けない |
| A6 | **devnet 試験の資金（test SOL）** | 配備・collection・config・試験ウォレット 3〜5 個（各 価格＋約 0.01 SOL）。faucet（`solana airdrop` または faucet.solana.com） | 無し | — | 合計約 **3〜4 SOL** | faucet（公開） | 試験不可 |
| A7 | **RPC** | 公開 devnet RPC（`https://api.devnet.solana.com`）か、提供者の RPC（Helius／QuickNode／Triton 等は API キー＝外部アカウント）。`/mint/mine` に gPA が使えない場合は DAS（`getAssetsByOwner`）か自前索引 | API キー（提供者を使う場合） | companion server の環境変数。リポジトリに入れない | 0 | **提供者のアカウント＝承認事項** | 公開 RPC の制限内（rate limit、gPA 不可の可能性）。自前索引なら本リポジトリの `src/registry.mjs` 系で代替 |
| A8 | **サイトの公開** | companion server（`/mint/*`、`/rpc` 転送）と静的ページ（`web/`、`/sdk/`）を公開。候補：既存 Vercel（`DEPLOYMENT_DISABLED` の復旧が先：SITE-STATUS §3）、herald 同居、GitHub Pages＋別ホスト | ホスティングの権限 | — | 0 | **ホスティング**（Vercel 等。課金が発生しうる） | 公開 URL が無い。ローカルまたは所有者の端末での試験のみ |
| A9 | **利用規約・表示** | devnet 試験であること、本番の参加権・金銭価値を保証しないこと、試験価格であること、鍵・資金は移らないこと、データ対応表の開示（DATA-MAP）。既存サイトのメール waitlist 文言の撤去（D21） | 無し | — | 0 | 無し | 公開しない |
| A10 | **実ウォレット・実機試験** | Phantom／Backpack（拡張・アプリ）で署名拒否・ネットワーク違い・スマホ往復。所有者の端末で実施 | 所有者のテストウォレット（devnet） | 所有者の端末 | 試験ウォレット分 | ウォレットアプリ | viewport 試験まで |
| A11 | **push（コード共有）** | 専用ブランチ `claude/funny-wozniak-cy4n64` への push。条件：Vercel／Netlify／GitBook の GitHub App がブランチ push で配備・公開・課金しないことの確認 | リポジトリへの書込み（セッション既存） | — | 0 | 既存の GitHub Apps の設定確認 | ローカルのみ。tar と SHA-256 で受け渡し |

## 2. 順序と依存

A5（treasury アドレス）→ A1（配備）→ A3（collection）→ A4（config）→ A6（資金）→ A7（RPC）→ 試験（L1〜L6 の devnet 再実行、A10）→ A8・A9（公開）。A2 は A1 と同時に決める。A11 は独立。

## 3. 本環境で行うこと・行わないこと（承認後）

- 行う：承認範囲のコマンドを**所有者が用意した使い捨て配備鍵**で実行し、取引署名・program ID・programdata ハッシュ・collection・config・treasury を `docs/DEVNET-RESULTS.ja.md` に記録。試験ウォレットは faucet で用意し、秘密鍵は記録・添付・リポジトリに入れない。
- 行わない：永続的な管理鍵を本環境に置く、upgrade authority を本環境の鍵に残す、mainnet、実資金、課金サービスの契約、承認外の外部アカウント。

## 4. この表に入れていない未決（接続作業を止めない）

本番価格・供給数・ロイヤリティ（U1・U24）、売買経路の価格・手数料（U20）、賞金規則・譲渡データの最終表（④ と揃える：INTEGRATION-04、DATA-MAP）。これらは試験価格・collection 1 つ・royalties プラグイン無しの状態で devnet を進めても後から config／プラグインで足せる範囲だが、**ロイヤリティ（Royalties プラグイン）だけは collection 作成時に付ける方が後付けより単純**なので、A3 の前に「付けない（後で collection 側に追加）」か「仮値で付ける」かの判断が要る。
