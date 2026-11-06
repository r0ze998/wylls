# permutation-nft-resident-spike：NFT で譲渡できる住民アカウント（隔離試作）

**状態（2026-11-06、v0.14）**：ローカルのみ（模擬チェーン、LiteSVM、ループバック validator）。公開発行・devnet／mainnet・実資金・新しい鍵は無し。価格・無料／有料・供給数・公開発行・ロイヤリティは未決（`docs/UNDECIDED.ja.md`）。Metaplex Core は**試作の選定方式**で、本線採用は未決。継続世界は決定済み。依存パッケージ無し（Node 20+ の標準モジュールだけ。`test-gateway/` だけは `permutation-gateway` の依存を使う）。v0.8 で担当ブランチへ通常 push（根拠は `docs/PUSH-AUDIT.ja.md`）。merge・deploy はしていない。

**v0.14 の変更**：本番の NFT パスを公開するまでの見積もり（`docs/PRODUCTION-PASS-ESTIMATE.ja.md`、すべて推測）。住民プログラムの `InitConfig` を upgrade authority だけに限った（配備直後の乗っ取りを防ぐ。SBF の再 build は未実施）。

**v0.13 の変更**：作成の記録（kind 130）を program と keeper・herald・検証器・fclient に入れた。keeper の精算が NFT Citizen を正しく名指す。中継が `JoinResident`・`ResidentAct` を受け、web に住民 NFT の選択・初回ログイン・操作を入れた（操作はウォレットが署名）。鍵を使わない実行時の試験で、譲渡後の旧所有者・旧 session・旧世代と A→B→A の拒否を確かめた（限界は `docs/NFT-ACCOUNT-WIRING.ja.md` §5）。別の Season では今の link のためにログインできないことを確かめた（`docs/SEASON-SCOPE.ja.md`、未決 U45）。

**v0.12 の変更**：program の外の読み手を NFT Citizen に対応させた（番号に依存しないものだけ）。検証器 V9 の住所の検算、herald の識別・WS の範囲・`/h/me`（NFT 住民は Core の asset で識別）、fclient の住民 ID からの住所と `resident_asset` の読み取り。財布の Citizen の住所・答えは不変。記録の kind は、④ の初版の 90 が v2 の既存 kind と重なっていたため ④ が 130 に訂正した。記録と、それを読む keeper・検証器は未実装。住民の拒否 6 種に ④ が割り当てたエラー番号 170–175 を配線した（これまでは区別できない `InvalidAccountData`）。v0.12 の作業中に固定 seed の鍵で署名する既存の試験を 1 回実行してしまった（規則違反、`docs/NFT-ACCOUNT-WIRING.ja.md` §5）。

**v0.11 の変更**：NFT 住民の初回アカウント作成（`Join`：1 NFT につき 1 Citizen）と、Citizen の権限を持つ 27 命令すべてへの NFT の権限検査の接続（`Act`）。財布の経路と本体を共有し、複製は無い。財布から決まる住所を前提にしていた keeper 向けの精算 5 か所を、NFT Citizen でも動くようにした。program の外の未対応箇所を洗い出した（`docs/NFT-ACCOUNT-WIRING.ja.md`）。命令 tag（0xE0–0xE2）・予約領域・住所と記録の key（住民 ID）は ④ の割り当て（統合まで仮）に合わせた。作成の記録（kind 90）は読み手と同時に入れる必要があり未実装。実行時の試験は未実施。

**v0.10 の変更**：候補 20（NFT と Citizen の認証・一対一登録・試験用 Harvest・厳格な索引、`a0b80384`）を受け取り、そのまま取り込んだうえで確認した（`docs/CANDIDATE-20-REVIEW.ja.md`）。transfer guard の未確認（A→B→A で古い署名が戻りうる）を直し、実 Core のバイトで試験した。NFT Citizen 用の共通の入口を作り、Harvest の本体を財布の経路と共通にした。CI の fmt・clippy に通るようにした。NFT Citizen の作成命令と、Harvest 以外の命令の接続は未着手。鍵を使う試験は実行していない。

**v0.9 の変更**：確定仕様（最初に NFT でログイン、1 NFT につき 1 アカウント、譲渡で操作権が新所有者へ、旧所有者は操作不可）に向けて、Frontier program の操作者の判定箇所を棚卸しし、仕様案を書いた（`docs/FRONTIER-HOLDER.ja.md`）。program の実装は、別作業の認証・一対一登録・命令接続・検証器対応の候補を受け取るまで止めている（GitHub に見当たらない）。固定 seed を含む鍵の試験の禁止に従い、今回は鍵を使う試験を実行していない。

**v0.8 の変更**：既存 gateway（relay・agent wallet・画面の session 判定）への接続。旧パッチ 01・03・04 を現行コードと照合し、作り直した共有コアの差分 3 つを独立したコミットにした（`patches/v2/`）。旧 03 は A→B→A で旧 agent を復活させていた（D29）。保有者・世代・session の確認アダプター `src/resident-gate.mjs` と回帰試験 `test-gateway/`（mock 9 件、**実 Core＋実住民プログラム 6 件**）。既存 gateway の全試験は差分の前後で同じ結果。結果と限界は `docs/GATEWAY-CONNECTION.ja.md`。Frontier program の変更（世代の検査）は未着手で、relay を迂回した直接送信は止まらない。

**v0.7 の変更**：mint 画面を**実プログラムの命令・口座・エラー**に接続。実 Core バイナリと実住民プログラムを載せた `solana-test-validator`（127.0.0.1）へ実 JSON-RPC で送り、確定・口座・エラーを実物で確認（`docs/LOCALNET-RESULTS.ja.md`、`test/browser.localnet.test.mjs` 6 件：正常系＋再読込、preflight ロールバック `PriceChanged`、応答消失→結果不明、二重クリック、relay 未観測の A→B→A、着地したロールバック）。ページが PDA を導出し、`Custom(n)` を `ResidentError` 名に対応付け、config PDA の価格を読む。companion server の裏側を `MockAdapter`／`RpcAdapter` に分離（`src/adapters.mjs`、`src/rpc-client.mjs`、`src/resident-ix.mjs`、`src/localnet.mjs`）。画面記録 `demo/screens-localnet/`（viewport は実機ではない）。devnet へ進むための承認一覧は `docs/DEVNET-APPROVALS.ja.md`。devnet・サイト公開・push は未実施。

**v0.6 の変更**：承認された R1・R2（MintResident／TransferResident）・R7 を実施。実 Metaplex Core の `.so`（mainnet 配備、program ID で照合、sha256 記録）と自作の住民プログラム（`program/`、SBF ビルド）を LiteSVM で動かし、一括成立・途中失敗の全体ロールバック・譲渡と世代更新と session 失効・relay 未観測の A→B→A・迂回試験・二重実行・競合を検証（`svm-core/`、結果は `docs/REAL-CORE-RESULTS.ja.md`）。実 Core が作った口座バイトで自前 registry を検証（`test/real-bytes.test.mjs`）。導入記録は `docs/ENV-RECORD.ja.md`。devnet 配備・collection 公開・サイト公開は未承認で未実施。

**v0.5 の変更**：完成条件の変更（devnet で、サイトから利用者のウォレットでテスト SOL を払い NFT を mint して waitlist 登録）に合わせ、mint 画面（`web/mint.html`、`web/mint.mjs`、Wallet Standard、テストウォレット）、companion server（`src/mint-server.mjs`）、実取引バイトを検証する模擬 JSON-RPC と `MintResident` 命令（`src/mint-rpc.mjs`）、Playwright のブラウザ試験 11 件（`test/browser.mint.test.mjs`：署名拒否・SOL 不足・接続先違い・二重クリック・途中離脱・再読込・期限切れ・結果不明・支払い後失敗・譲渡後の旧保有者・Chromium の iPhone viewport。実機＋実ウォレットは未実施）。設計と承認依頼は `docs/MINT-FLOW.ja.md`、既存サイトの状態は `docs/SITE-STATUS.ja.md`。devnet 配備・実 Core・サイト公開は未承認で未実施。

**v0.4 の変更**：実 Core＋LiteSVM 検証の**承認判断用**の導入物一覧と検証計画（`docs/REAL-CORE-PLAN.ja.md`：固定版・公式取得元・用途・保存先・容量・コマンド、Core 本体の program ID・programdata・ハッシュ）、誰を信頼する設計かの安全性評価（`docs/TRUST-MODEL.ja.md`：upgrade authority・管理者の変更範囲・鍵侵害時）、市場互換を市場×経路で「確認／未確認」に分離（`docs/MARKET-COMPAT.ja.md` §2）、買い手ウォレットだけの最小取引と ⑰ の実際の検査規則との照合（`docs/SALE-PATH.ja.md` §4・§5）。導入・配備は行っていない。

**v0.3 の変更**：専用売買経路（`List`/`Buy`：支払い・譲渡・世代更新・session 失効を 1 命令、失敗は取引ごと戻る）と、複数命令の原子的な取引・模擬トークン・delegate／thaw の迂回試験を模擬チェーンに追加（`test/sale.test.mjs` 8 件）。一般市場互換の候補の調査（`docs/MARKET-COMPAT.ja.md`）、比較と推奨（`docs/COMPARISON.ja.md`）、実 Core／LiteSVM の実施可否（`docs/REAL-CORE-TEST.ja.md`：承認済み環境では不可、必要物を列挙）。Permanent Freeze＋Permanent Transfer Delegate は**候補**で、一般市場との非互換を採用決定にしていない。

**v0.2 の変更**：買い戻し（A→B→A）で旧権限が復活しないことの検証と、その保証の根拠（チェーン側の保有者世代 `gen` と譲渡ガード、`docs/CONTRACT.ja.md` §10）。ガード無しの通常 Core 譲渡では復活する穴も実証して残した（`test/buyback.test.mjs`）。データ対応表を「決定／現コード／推奨案」に分離。宛先番号を修正。ABI パッチにベクタ再生成を含めた。

## 何を試したか

Wylls の住民アカウントを **NFT（Metaplex Core 資産）に紐付け**、

- NFT の取得＝waitlist 登録（別の先行登録・引換券を挟まない）、
- 公開前は参加待ちの資格、公開後は同じ NFT で住民へログイン、
- 保有型で売却・譲渡でき、譲渡すると住民のゲームデータと操作権が買い手へ移り、売り手は同じ住民を操作できない、

という一巡を、**変更できない住民 ID（asset 由来）と、現在操作するウォレット（現保有者）を分けた**構成で動かした。認可は名前・画像・メタデータではなく、**Core プログラム・collection・asset・現在の保有者**で判定し、ログイン時だけでなく**操作の権限を判定する時点**で保有者を読み直す。

## 動かす

```sh
cd permutation-nft-resident-spike
node --test test/*.test.mjs        # 67 tests (12 in Chromium on the mock chain; 6 in Chromium on the REAL program over a loopback validator; 3 on real-Core account bytes; each group skips when its inputs are absent)
(cd svm-core && cargo +1.95.0 test)  # 9 LiteSVM tests against the real Core binary (needs ENV-RECORD §1)
node --test test-gateway/*.test.mjs  # 15 tests: the existing relay and agent wallet with the resident gate (needs npm ci in permutation-gateway; 6 of them on the REAL program over a loopback validator)
node src/mint-demo.mjs --port 41990  # the mint page on a mock chain: http://127.0.0.1:41990/web/mint.html
node src/mint-demo.mjs --localnet --port 41990  # the same page on the REAL program (solana-test-validator with the real Core .so; ENV-RECORD)
node demo/run-loop.mjs             # the loop, printed; transcript at .local/nft-resident-demo/transcript.json (or --out)
node archive/manifest.mjs verify   # the package's SHA-256 manifest
```

## 構成

| ファイル | 役割 |
|---|---|
| `src/core-asset.mjs` | Core `AssetV1` の Borsh 復号・符号化と、住民資産の判定（`WrongProgram` / `NotAnAsset` / `NotInCollection` / `Malformed` / `NoAccount`）。**実物の判定ロジック** |
| `src/mock-chain.mjs` | 模擬チェーン：Core 形の口座（実物同形の bytes）、スロットと履歴（遅延 RPC の模擬）、署名検証と実行順、**模擬の住民プログラム**（保有者世代 `gen`、`SetSession` の設定者と世代、`TransferResident`、prologue で「現保有者 or 現世代で設定された session」かつ「命令の世代 = 現世代」だけ通す）、**譲渡ガード**（Permanent Freeze＋Permanent Transfer Delegate の模擬） |
| `src/registry.mjs` | 住民 registry：チェーン読取からだけ記録を作る。通知は「読み直せ」の合図。`epoch` = チェーンの世代 ＋ 観測した迂回（ガード無し asset のみ）。waitlist はその投影 |
| `src/auth.mjs` | SIWS 形のログイン、ログイン token・MCP capability・AI 委任の記録（全て保有者＋epoch に束縛）。`authorize` は毎回保有者を読み直す |
| `src/world.mjs` | 最小の村：住民 ID 鍵。輸送中の隊商・加工中の注文・預かり物・債務。ウォレット鍵の未受取報酬と費用確認待ち |
| `src/entry.mjs` | 支払い → 発行 → 資格の 3 記録。冪等・結果不明・送信後クラッシュの復旧 |
| `src/gateway.mjs` | relay 側の操作入口：認可時と送信直前の保有者読取、費用確認、署名、送信 |
| `src/sale.mjs` | 専用売買の desk：出品、冪等な購入、送信前の署名記録と応答消失からの復旧（再送しない） |
| `src/mint-rpc.mjs`、`src/mint-server.mjs`、`src/adapters.mjs`、`src/mint-demo.mjs` | 模擬 JSON-RPC（実取引バイト・署名検証・`MintResident`）、companion server（config・status・mine・rpc）と裏側 2 種（模擬／実 RPC）、起動（`--localnet` で validator） |
| `src/rpc-client.mjs`、`src/resident-ix.mjs`、`src/localnet.mjs` | 実 JSON-RPC クライアント、実プログラムの命令・PDA・レイアウト・エラー表、`solana-test-validator` の起動と世界の初期化 |
| `web/` | mint 画面、Wallet Standard、テストウォレット（ブラウザ試験用） |
| `program/` | 住民プログラム（Rust、`solana-program` 3 ＋ `mpl-core` 0.12.1 の CPI）：InitConfig／SetPrice／MintResident／TransferResident／SetSession／Op |
| `svm-core/` | LiteSVM 検証（実 Core の `.so` ＋ 住民プログラムの SBF ビルド）。`out/` は実 Core が作った口座バイトの書き出し |
| `src/http.mjs` | 契約の HTTP 面（loopback） |
| `docs/` | 接続契約・データ対応表・方式比較・④ への提案・未決定・食い違い・push 監査・専用売買経路・市場互換候補・比較と推奨・実 Core 試験の可否・**実 Core 検証計画と導入物（REAL-CORE-PLAN）・信頼モデル（TRUST-MODEL）** |
| `patches/` | 共有コード向けの独立パッチ（未適用） |
| `archive/` | SHA-256 マニフェストと復元手順 |

## 模擬と実物の境界（要約。詳細は `docs/CONTRACT.ja.md` §8）

- **実物と同じ**：Core の口座レイアウトの判定（プログラム ID、`AssetV1`、`update_authority = Collection`、`owner`）、ed25519 署名検証、SIWS 文面の検証規則、冪等と再起動の規則。
- **模擬**：チェーン（スロット・実行順・手数料無し）、Core のプラグイン領域（凍結は口座フラグで模擬）、RPC の遅延・欠落、決済レール、発行鍵（relay が持つテスト鍵）、世界。
- **していないこと**：実チェーンでの発行・譲渡（実 Core の Permanent Delegate の挙動を含む）、Frontier プログラムの prologue 変更（提案とレイアウトパッチのみ。パッチは独立作業コピーで `cargo test -p frontier-abi` 全件合格）、既存 gateway・web への接続とその既存テストの実行、x402 facilitator との接続、ウォレット拡張での署名、LiteSVM。

## 必須テストとの対応

`docs/CONTRACT.ja.md` §7 の表を参照。偽物・同名別 collection・古い保有情報・他人の署名／再送・二重押し・支払い結果不明・通知重複／譲渡と操作の競合・譲渡後の旧 session・MCP・AI／署名済み操作の遅延到着／再起動・RPC 遅延欠落・住民 ID 重複／複数 NFT・買い戻し、の各項目に対応するテストがある。
