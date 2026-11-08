# 導入記録：ローカル検証環境（R1、承認 2026-10-31）

承認された範囲だけを、公式配布元・公式レジストリから固定版で導入した。保存先はすべてこの作業環境（使い捨てコンテナ）内。リポジトリには **バイナリも鍵も入れない**（`.local/` は `.gitignore`）。環境の変更は本書に列挙する。

## 1. 導入物

| # | 導入物 | 版 | 取得元 | 保存先 | 検証 |
|---|---|---|---|---|---|
| 1 | Rust toolchain | **1.95.0**（`rustc 1.95.0 (59807616e 2026-04-14)`） | rustup（`rustup toolchain install 1.95.0 --profile minimal`） | `~/.rustup/toolchains/1.95.0-x86_64-unknown-linux-gnu` | `rustup run 1.95.0 rustc --version` |
| 2 | Agave（`solana` CLI、`cargo-build-sbf`） | **3.1.9**（`solana-cli 3.1.9 (src:765ee54a; feat:1620780344, client:Agave)`、`solana-cargo-build-sbf 3.1.9`） | `https://release.anza.xyz/v3.1.9/install`（スクリプト 5,034 B、sha256 は `install-agave.log` に記録）→ 公式 release tarball | `~/.local/share/solana/install/releases/3.1.9/solana-release`（`active_release` シンボリックリンク）。PATH は**シェルごとに**追加（恒久的な rc 変更はしていない） | `cargo-build-sbf --version` |
| 3 | platform-tools | **v1.52**（`cargo-build-sbf --version` が報告） | `cargo-build-sbf` が初回ビルド時に `https://github.com/anza-xyz/platform-tools/releases/download/v1.52/platform-tools-linux-x86_64.tar.bz2`（519,270,959 B）を取得 | `~/.cache/solana/v1.52/` | 初回ビルドのログ（`sbf-build.log`） |
| 4 | Metaplex Core プログラム本体 | mainnet 現行配備（**last deployed slot 455005931**、upgrade authority `bfQVv6niKVgEURYqQ1beJmiEQQN7MrvLRvk3mZGFubb`） | `https://api.mainnet-beta.solana.com` の `getAccountInfo`（読み取りのみ）。program ID `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` → programdata `9ZC25KLUrfgSoFVgjE1rrydZBbZns58UXi8A8ZhTdGfr`（読取スロット 463549898） | `permutation-nft-resident-spike/.local/programs/mpl_core.so`（git 管理外）＋ `mpl_core.record.json` | **使用した ELF（810,288 B）sha256 `515541c84caa71a2f142c603fc1e2372196825003e66126d1e824dd9213ea056`**。長さは ELF ヘッダから決めた（セクションヘッダ表の終端・NOBITS 以外の各セクションの offset+size・各セグメントの offset+filesz の最大）。programdata の buffer 全体（848,320 B、末尾は配備時の padding）は `51d41542456639a01820c747e72b9d3b4ca258930a5bbb7e78db0cda133dc209`。**訂正**：v0.4 で記録した `af40bd11…`（810,273 B）は末尾のゼロを機械的に削った値で、15 byte 足りず LiteSVM が `ProgramLoad("Offset or value is out of bounds")` で拒否した。buffer の sha256 は v0.4 の読取（スロット 463526629）と一致し、配備は変わっていない |
| 5 | LiteSVM | **=0.16.0** | crates.io（`static.crates.io`、537,442 B） | `~/.cargo/registry` | `svm-core/Cargo.lock` に固定 |
| 6 | `mpl-core`（Rust クライアント・CPI ビルダー） | **=0.12.1** | crates.io（131,061 B） | `~/.cargo/registry` | `program/Cargo.lock`、`svm-core/Cargo.lock` |
| 7 | `solana-program`、`solana-system-interface` ほか（プログラム側の依存） | lockfile の解決値（`solana-program 3.0.0`、`solana-system-interface 2.0.0`、`borsh 1.8.1`／`0.10.4`、`solana-pubkey 3.0.0`／`4.4.0`、`solana-address 2.9.0`／`1.1.0`） | crates.io | 同上 | `program/Cargo.lock` |
| 8 | LiteSVM 側の solana-* | `permutation-frontier/svm-tests` と同じ pin（`solana-account =4.3.2`、`solana-address =2.6.1`、`solana-instruction =3.4.1`、`solana-keypair =3.1.2`、`solana-message =4.4.1`、`solana-transaction =4.1.6` ほか） | crates.io | 同上 | `svm-core/Cargo.lock` |

| 9 | **Criterion v2.3.3**（C のテストフレームワーク） | v2.3.3 | `cargo-build-sbf` が初回実行時に `https://github.com/Snaipe/Criterion/releases/download/v2.3.3/criterion-v2.3.3-linux-x86_64.tar.bz2` を**自動取得**（提示一覧に無かった差分。cargo-build-sbf 3.1.9 の既定動作。約 2.2 MB、ビルドには使われていない） | `~/.cache/solana/v2.3.3/criterion` | ログ `sbf-build.log` |
| 10 | 住民プログラムのビルド生成物 | 本リポジトリの `program/`（commit は最終報告） | `cargo-build-sbf --manifest-path program/Cargo.toml`（46 秒、platform-tools 取得を除く） | root の `.cargo/config.toml`（`target-dir = permutation-chain/target`）が効いて `permutation-chain/target/deploy/` に出た。`program/target/deploy/wylls_resident_program.so` へ**コピー**（両方 git 管理外） | **153,120 B、sha256 `95e462f39364b10ca5b2773a169a00755c64ce41e64fead97632477ac408e8bf`** |

承認外のものは導入していない。差分は #9（Criterion の自動取得）。**生成された鍵**：`cargo-build-sbf` は `permutation-chain/target/deploy/wylls_resident_program-keypair.json`（プログラム鍵、0600）を自動生成する。配備には使わず、`shred -u` で削除した。テストはプログラム ID を `sha256("wylls-resident-program id (test)")` から導いて LiteSVM に直接載せる。

**ビルド時の警告（記録）**：`cargo-build-sbf` は `mpl-core` 0.12.1 の 3 関数で「Stack offset … exceeded max offset of 4096」を報告した（`hooked::plugin::registry_records_to_plugin_list`：+144 B、`hooked::asset::Asset::deserialize`：+8 B、`hooked::collection::Collection::deserialize`：+48 B）。これは `mpl-core` のプラグイン一覧を復号する経路で、**本プログラムは呼ばない**（`BaseAssetV1::from_bytes` と CPI ビルダーのみ）。ただし同じバイナリに含まれるため、devnet 配備の前に `mpl-core` 側の修正版の有無を確認する（未決事項に追加）。

## 2. 環境の変更（隔離の状況）

| 変更 | 範囲 | 戻し方 |
|---|---|---|
| `~/.rustup` に 1.95.0 を追加 | ユーザー領域。root workspace は 1.89.0 のまま（`rust-toolchain.toml` は各 crate が持つ） | `rustup toolchain uninstall 1.95.0` |
| `~/.local/share/solana/install/` | ユーザー領域。PATH はコマンド実行時に `export PATH=...active_release/bin:$PATH` で付け、`.bashrc` 等は変更していない | ディレクトリ削除 |
| `~/.cache/solana/v1.52` | platform-tools | ディレクトリ削除 |
| `~/.cargo/registry` | 新規 crate のソース | `cargo cache` 掃除 |
| `permutation-nft-resident-spike/.local/programs/` | Core の `.so` と記録 | `.gitignore` 済み。削除可 |
| `permutation-chain/target/`（root の `.cargo/config.toml` により svm-core のビルドもここ）、`permutation-nft-resident-spike/program/target/` | ビルド生成物 | `.gitignore` 済み（`target/`） |
| `~/.cache/solana/v2.3.3/criterion` | cargo-build-sbf の自動取得 | ディレクトリ削除 |
| rustup の toolchain リンク `1.89.0-sbpf-solana-v1.52` | cargo-build-sbf が platform-tools の rustc を rustup に登録 | `rustup toolchain uninstall 1.89.0-sbpf-solana-v1.52` |

リポジトリの共有コードは変更していない。新規は `permutation-nft-resident-spike/program/`（住民プログラム）と `svm-core/`（LiteSVM テスト）。

### v0.7 の追加（導入物の追加は無し）

| 物 | 内容 | 保存先 | 戻し方 |
|---|---|---|---|
| `solana-test-validator` 3.1.9（Agave 3.1.9 の同梱物。#2 の導入に含まれる） | ループバック（`--bind-address 127.0.0.1`、空きポート）で起動。`--bpf-program` で Core（`.local/programs/mpl_core.so`）と住民プログラムを搭載。`--reset`、`--limit-ledger-size 10000` | ledger は `os.tmpdir()/wylls-localnet-*`（約 5 MB）。停止時に削除 | 残っていれば `rm -rf /tmp/wylls-localnet-*` |
| Playwright の Chromium | 既存（本環境に同梱） | — | — |

ネットワーク：validator は外へ出ない。faucet も 127.0.0.1 のみ。

### v0.8 の追加（2026-11-05）

| 物 | 内容 | 保存先 | 戻し方 |
|---|---|---|---|
| `permutation-gateway` の依存（`npm ci`、リポジトリの `package-lock.json` どおり、59 パッケージ） | 既存 gateway の試験と、接続試験に必要 | `permutation-gateway/node_modules/`（`.gitignore` 済み） | ディレクトリ削除 |

新しい鍵・外部アカウント・API キーは無い。接続試験の鍵は固定ラベル由来の使い捨て（`test-gateway/worlds.mjs`）。

## 3. 鍵

LiteSVM 内の使い捨て鍵のみ（`sha256(ラベル)` から導出、テスト本体に平文のラベルがあるだけ）。v0.7 のローカル validator でも同様：初期化鍵は起動ごとの乱数でメモリ内のみ、ブラウザのテストウォレットは localStorage の固定 seed（テスト本体に平文）、資金は validator の faucet。外部への配備権限・継続アクセスを持つ鍵は作っていない。devnet／mainnet への配備は行っていない。

## 4. 実行コマンド（記録）

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd permutation-nft-resident-spike/program && cargo-build-sbf --manifest-path Cargo.toml      # → target/deploy/wylls_resident_program.so
cd ../svm-core && cargo +1.95.0 test                                                        # PSF_CORE_SO / WYLLS_RESIDENT_SO で場所を上書き可
cd .. && node --test test/browser.localnet.test.mjs                                         # v0.7: the page on the real program over a loopback validator
node demo/mint-screens.mjs --localnet                                                        # v0.7: screens → demo/screens-localnet/
```
