# 実 Core＋LiteSVM 検証：導入物一覧と検証計画（承認判断用、2026-10-31、v0.4）

**これは承認を求めるための一覧と計画であり、導入・配備は行っていない。** 本線採用の判断材料であって、方式の決定ではない。価格・通貨・手数料・供給数・ロイヤリティは未決のまま。

## 1. 導入物一覧

保存先は全てこの作業環境の中（`~/.cargo`、`~/.local/share/solana`、リポジトリ外の `.local/`）。公開配備・永続鍵・外部アカウントは**不要**（LiteSVM のテスト鍵で足りる）。容量は HEAD 要求の Content-Length と crates.io の `crate_size`（2026-10-31 取得）。ビルド生成物（`target/`）は別に数 GB。

| # | 導入物 | 固定版 | 公式の取得元 | 用途 | 保存先 | 容量の目安 | 実行コマンド |
|---|---|---|---|---|---|---|---|
| 1 | **Metaplex Core プログラム本体**（`mpl_core.so`） | mainnet の現行配備。program ID `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`、programdata `9ZC25KLUrfgSoFVgjE1rrydZBbZns58UXi8A8ZhTdGfr`、**last deployed slot 455005931**、upgrade authority `bfQVv6niKVgEURYqQ1beJmiEQQN7MrvLRvk3mZGFubb`（読取スロット 463526629） | mainnet RPC（`api.mainnet-beta.solana.com`、読み取りのみ）の `getAccountInfo(programdata)`、または `solana program dump CoREEN… mpl_core.so --url mainnet-beta`。GitHub `metaplex-foundation/mpl-core` の release（`release/core@0.15.3`、10/07）の資産は本環境から一覧取得できず（API がリポジトリ範囲外で遮断）、**配備とリリースの対応は未照合** | LiteSVM に読み込む対象プログラム | `permutation-nft-resident-spike/.local/programs/mpl_core.so`（git 管理外） | 810,273 B（ELF、末尾ゼロ除去後）。buffer 全体 848,320 B | `curl … getAccountInfo` → base64 復号 → 45 byte のヘッダ（kind u32, slot u64, has_authority u8, authority 32）を除いた ELF。**ハッシュ（記録）**：ELF（末尾ゼロ除去）`sha256 = af40bd111c783e4c4bf28fa1d36297db012cfcc3838a75a3a5a8361546742eb4`、buffer 全体 `sha256 = 51d41542456639a01820c747e72b9d3b4ca258930a5bbb7e78db0cda133dc209`。取得後に同じ値であることを確認する |
| 2 | **LiteSVM**（Rust クレート） | `=0.16.0`（リポジトリの `permutation-frontier/svm-tests` と同じ pin。最新は 0.18.1、2026-10-18） | crates.io `litesvm`（`https://static.crates.io/crates/litesvm/litesvm-0.16.0.crate`、repo `LiteSVM/litesvm`） | プログラムをインプロセスで実行する SVM | `~/.cargo/registry` | クレート 537,442 B。依存（solana-* クレート群）込みのビルドで target に 2〜4 GB | `cargo fetch` → `cargo test -p nft-resident-svm-tests` |
| 3 | **`mpl-core` Rust クライアント** | `=0.12.1`（2026-06-16） | crates.io `mpl-core`（`https://static.crates.io/crates/mpl-core/mpl-core-0.12.1.crate`） | Core 命令（`CreateV1`、`TransferV1`、プラグイン追加・authority 更新）の組み立てと口座復号 | `~/.cargo/registry` | 131,061 B | 同上 |
| 4 | **Rust 1.95.0 toolchain** | `1.95.0`（svm-tests の pin。LiteSVM 0.16 は 1.89 ではビルドできない） | rustup（`rustup toolchain install 1.95.0 --profile minimal`） | svm-tests と同じ条件 | `~/.rustup` | 約 300 MB | 同上 |
| 5 | **Agave 3.1.9**（`cargo-build-sbf`、`solana` CLI） | `v3.1.9`（CI と `scripts/build-frontier.sh` が要求） | `https://release.anza.xyz/v3.1.9/install`（スクリプト 5,034 B）→ `https://github.com/anza-xyz/agave/releases/download/v3.1.9/solana-release-x86_64-unknown-linux-gnu.tar.bz2` | **我々の側**（Frontier プログラムに `TransferResident`／`Buy`／`HOLDER_GEN` を実装した版）を SBF ビルドし、Core と一緒に LiteSVM で動かすため。`solana program dump` にも使える。**Core 単体の検証（§2 の T1〜T4 の Core 側）には不要** | `~/.local/share/solana/install/active_release` | 214,999,945 B（圧縮） | `sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"` |
| 6 | **platform-tools v1.52**（SBF 用 LLVM／Rust） | `v1.52`（Agave 3.1.9 が取得） | `https://github.com/anza-xyz/platform-tools/releases/download/v1.52/platform-tools-linux-x86_64.tar.bz2` | 同上（`cargo-build-sbf` が初回に自動取得） | `~/.cache/solana/v1.52` | 519,270,959 B（圧縮） | `scripts/build-frontier.sh --features test-beacon`（既存） |

**段階的な承認案**：**第 1 段（#1〜#4）**は Core 単体の挙動（永続プラグイン・凍結・forceApprove・authority 変更不可）を LiteSVM で確かめるのに十分で、容量も小さい。**第 2 段（#5〜#6）**は我々のプログラム側（CPI 譲渡・世代更新・原子性）を実行するのに要る。

## 2. 検証計画

テストクレート（案）：`permutation-nft-resident-spike/svm-core/`（独立 workspace、svm-tests と同じ pin、`PSF_CORE_SO` 環境変数で #1 の `.so` を読む）。**作っていない**（依存の取得が承認待ち）。各テストは「期待する結果」まで書き、実行して初めて「確認済み」になる。

### 2.1 Core 単体（第 1 段で可能）

| # | 内容 | 期待 | 対応する要求 |
|---|---|---|---|
| C1 | `CreateV1`：collection 配下、Permanent Freeze Delegate（frozen = true、authority = テスト PDA）＋ Permanent Transfer Delegate（authority = 同 PDA）付きで asset を作る | 成功。`AssetV1.owner = A`、`update_authority = Collection` | 前提 |
| C2 | owner A の `TransferV1` | **拒否**（frozen） | 通常の譲渡で迂回不可 |
| C3 | A が Transfer Delegate を承認 → delegate の `TransferV1` | **拒否**（frozen。公式「Frozen Assets cannot be transferred by delegates」） | delegate で迂回不可 |
| C4 | テスト PDA（permanent transfer delegate）署名の `TransferV1` | **成功**（forceApprove が Rejected に先立つ：`lifecycle.rs`） | 専用経路の譲渡が通る |
| C5 | A・collection authority による Permanent Freeze の thaw、`UpdatePluginAuthority`／`RevokePluginAuthority`／`RemovePlugin` を永続プラグインに対して | **拒否**（永続プラグインの authority は固定、公式「Authority is never revoked」） | 凍結解除・plugin／authority 変更で迂回不可 |
| C6 | `AddPlugin` で既存 asset に Permanent* を追加 | **拒否**（作成時のみ） | 同上 |
| C7 | Oracle 外部プラグイン付き asset：Oracle = Rejected で owner 譲渡 → Pass で owner 譲渡 | 拒否 → 成功。Oracle は CPI しない（プログラム側に何も起きない） | M1 の性質の実行確認 |
| C8 | 作成後の asset を Core の `fetch` で復号し、本試作の `decodeAssetV1` に同じバイト列を通す | 一致（`owner`、`update_authority`） | 判定ロジックが実物に合う |

### 2.2 我々のプログラム込み（第 2 段）

Frontier プログラムに `TransferResident`／`List`／`CancelList`／`Buy`／`HOLDER_GEN`／`SESSION_SETTER_TAG15` を実装した版（パッチ 02 ＋ 未作成の prologue パッチ）を SBF ビルドし、Core と一緒に読み込む。トークンは SPL Token（テスト mint）。

| # | 内容 | 期待 | 対応する要求 |
|---|---|---|---|
| P1 | `List`（A）→ `Buy`（B、買い手が fee payer、唯一の署名者）：前後で B・A・運営のトークン残高、`AssetV1.owner`、`HOLDER_GEN`、`SESSION`、出品 PDA | 全てが同時に変わる | 支払い・譲渡・世代・session が一括 |
| P2 | `Buy` を失敗させる（B の残高不足／出品 PDA を事前に取消／mint 不一致）→ 取引失敗 | トークン残高・owner・`HOLDER_GEN`・`SESSION` が**全て**元のまま（LiteSVM の取引失敗はロールバック） | 途中失敗で全体が戻る |
| P3 | 2 命令取引 `[SPL Transfer, TransferResident]` で 2 つ目を失敗させる | 1 つ目も戻る | 同上 |
| P4 | A が `SetSession(K)`、A が op を署名して未送信 → `TransferResident` A→B → `TransferResident` B→A（relay なし、チェーンだけ）→ K 署名の op、A の未送信 op、A の新 op（旧 gen を data に持つ） | K：`Auth`（SESSION は消え、設定者も世代も合わない）。未送信 op：`StaleGen`。A が現 gen で作った op：成功 | relay 未観測の A→B→A で旧 session・旧委任・署名済み未送信を拒否 |
| P5 | P4 を B 側でも（B が `SetSession(K2)` して買い戻し後） | K2：`Auth` | 同上（B 側） |
| P6 | C2・C3・C5・C6 を我々のプログラム配下の asset で再実行＋Transfer Delegate の承認後に `Buy` | 迂回は全て拒否。`Buy` は成功し、Core が delegate を失効させる | 迂回不可 |
| P7 | 同じ出品に B と C の `Buy` を続けて送る | 先着のみ成功。後着は `NoListing`、残高不変、`HOLDER_GEN` は +1 だけ | 二重購入 |
| P8 | `List` → `CancelList` と `Buy` を同じスロットに（順序を両方） | 取消が先なら `Buy` は `NoListing` で支払いなし。`Buy` が先なら取消は `NoListing`。どちらも二重払い・二重実行なし | 出品取消との競合 |
| P9 | `Buy` の同じ署名済み取引を 2 回送る／結果不明を装って再送 | 2 回目は `AlreadyProcessed`。残高・世代は 1 回分 | 応答消失後の再送 |
| P10 | `Buy` と A の op（旧 gen）を同じスロットに両順序で | チェーンの実行順どおり：op が先なら成立し B が引き継ぐ、`Buy` が先なら op は `NotOwner`／`StaleGen` | 売買と操作の競合 |
| P11 | CU・口座数の実測 | `Buy` の CU と loaded-data を記録（Frontier の budget 表に載せる） | 統合条件 C6 |

### 2.3 判定

- 全件の期待どおり → 「専用売買と権限失効は実 Core（LiteSVM、mainnet 配備と同一バイナリ）で成立」。それでも**本線採用の決定ではない**（市場互換・信頼モデル・未決事項は別）。
- C4 または C5 が期待と違う → 専用売買方式の前提が崩れる。方式の再検討。
- P2・P3 が期待と違う → 原子性の前提が崩れる（LiteSVM の挙動差を疑う前に、命令の実装を疑う）。

## 3. 実行の順序と記録

1. #1 を取得し、`sha256sum` が §1 の値と一致することを確認して保存（不一致なら止める：配備が変わった可能性）。
2. #2〜#4 を取得（`cargo fetch`）。lockfile を `svm-core/Cargo.lock` に固定。
3. C1〜C8 を実行し、結果を `docs/REAL-CORE-RESULTS.ja.md`（未作成）に、実行日・LiteSVM 版・`.so` のハッシュ・各テストの結果で記録。
4. 承認があれば #5〜#6、プログラム側の実装、P1〜P11。
5. 「模擬で確認」と「実 Core で確認」の列を CONTRACT §7 と SALE-PATH §2 の表に分けて追記する。

## 4. 承認を求める事項（まとめ）

| 事項 | 内容 | 必要な理由 |
|---|---|---|
| A1 | #1 の取得（mainnet RPC からの読み取り、またはリポジトリ外への保存） | 実 Core 検証の対象 |
| A2 | #2〜#4 の取得（cargo の新規依存、1.95.0 toolchain） | LiteSVM の実行 |
| A3 | #5〜#6 の導入（約 730 MB 圧縮） | 我々のプログラム側の SBF ビルド |
| A4 | devnet 実証（MARKET-COMPAT §2.4）：devnet への配備、テスト鍵、devnet SOL | 市場互換（U19）の確認。本計画とは別件 |

いずれも実資金・課金・永続鍵・公開配備を伴わない（A4 の devnet 鍵はテスト鍵）。
