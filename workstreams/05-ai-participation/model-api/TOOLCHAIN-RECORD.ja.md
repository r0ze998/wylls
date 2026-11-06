# 環境の変更の記録：Rust のツールチェーンと crate（2026-10-30）

④の試験（`cargo test --locked`）を再現した時に、この環境に次の物が加わりました。**最初のツールチェーンの取得は、許可を得てから行ったものではありません。** `rustc --version` を実行した時に、rustup がリポジトリの `rust-toolchain.toml` を読んで自動で取得しました。今後は、取得を起こしうるコマンド（rustup・cargo・npm・pip のバージョン確認を含む）は、許可を確かめてから実行します。

**消していません。** 消すかどうかは、利用者の判断を待ちます（下の「戻し方」）。

## 1. ツールチェーン（rustup が自動で取得）

| 項目 | 値 |
|---|---|
| きっかけ | リポジトリの中で `rustc --version` を実行した（rustup の proxy が `rust-toolchain.toml` の `channel = "1.89.0"` に従った） |
| 版 | `rustc 1.89.0 (29483883e 2025-08-04)`、チャネルの更新日 2025-08-07 |
| 部品 | cargo、clippy、rust-std、rustc、rustfmt（`profile = "minimal"`、`components = ["rustfmt", "clippy"]`） |
| 取得元 | rustup の既定の配布元（チャネル `1.89.0-x86_64-unknown-linux-gnu`。この環境の proxy を経由） |
| 置いた場所 | `~/.rustup/toolchains/1.89.0-x86_64-unknown-linux-gnu`（約 590 MB）。作成 2026-10-30T13:19:30 |
| 変わっていない物 | 既定のツールチェーン（`stable-x86_64-unknown-linux-gnu`、2026-10-22 から在る）、`~/.rustup/settings.toml`（既定は stable のまま、override なし）、リポジトリの中のファイル |

## 2. crate（`cargo fetch --locked` で取得。これは意図して実行した）

| 項目 | 値 |
|---|---|
| コマンド | 使い捨ての clone（④ `2e536b6b`）の `workstreams/04-execution` で `cargo fetch --locked` |
| 取得元 | crates.io（`index.crates.io-1949cf8c6b5b557f`）。版は④の `Cargo.lock` の固定どおり |
| 置いた場所 | `~/.cargo/registry`（約 101 MB。index は 2026-10-30T13:19:47 に作成。cache の 62 件はすべて当日の物） |
| ビルドの出力 | 使い捨ての clone の `workstreams/04-execution/target`（約 747 MB、作業用の一時フォルダの中） |

**取得した 62 件（名前-版）：**
bitflags-2.13.2, block-buffer-0.10.4, borsh-1.6.1, borsh-derive-1.6.1, bumpalo-3.20.3, bytes-1.12.1, cc-1.10.0, cfg-if-1.0.5, cfg_aliases-0.2.2, cpufeatures-0.2.17, crypto-common-0.1.7, digest-0.10.7, equivalent-1.0.3, fallible-iterator-0.3.0, fallible-streaming-iterator-0.1.9, find-msvc-tools-0.1.15, foldhash-0.2.0, generic-array-0.14.7, hashbrown-0.16.1, hashbrown-0.17.1, hashlink-0.12.2, hex-0.4.3, indexmap-2.14.2, itoa-1.0.18, js-sys-0.3.106, libc-0.2.191, libsqlite3-sys-0.38.2, memchr-2.8.3, once_cell-1.21.4, pkg-config-0.3.34, proc-macro-crate-3.5.0, proc-macro2-1.0.107, quote-1.0.47, rsqlite-vfs-0.1.1, rusqlite-0.40.2, rustversion-1.0.23, serde-1.0.229, serde_core-1.0.229, serde_derive-1.0.229, serde_json-1.0.151, sha2-0.10.9, shlex-2.0.1, smallvec-1.16.4, solana-define-syscall-4.0.1, sqlite-wasm-rs-0.5.5, syn-2.0.119, syn-3.0.9, thiserror-2.0.21, thiserror-impl-2.0.21, toml_datetime-1.1.2+spec-1.1.0, toml_edit-0.25.17+spec-1.1.0, toml_parser-1.1.5+spec-1.1.0, typenum-1.20.1, unicode-ident-1.0.27, vcpkg-0.2.15, version_check-0.9.5, wasm-bindgen-0.2.129, wasm-bindgen-macro-0.2.129, wasm-bindgen-macro-support-0.2.129, wasm-bindgen-shared-0.2.129, winnow-1.0.4, zmij-1.0.23

`libsqlite3-sys` は、ビルドの時に SQLite の C のコードを手元でコンパイルしました（④の依存の作り。外部への通信は、上の取得の時だけ）。

## 3. 戻し方（実行していない。利用者の判断で）

```
rustup toolchain uninstall 1.89.0-x86_64-unknown-linux-gnu    # 約 590 MB
rm -rf ~/.cargo/registry                                   # 約 101 MB（当日の取得分だけ）
rm -rf <作業用の一時フォルダ>/recv/repo/workstreams/04-execution/target   # 約 747 MB
```

ただし、ツールチェーンを消しても、リポジトリの中で `rustc`・`cargo` を実行すれば、rustup はまた同じ物を取得します（`rust-toolchain.toml` があるため）。

## 4. この作業で入れていない物

- npm・pip の依存（③の `@modelcontextprotocol/sdk` は入れていない。そのため③の `sdk-client.test.mjs` は未実行の扱い）
- `.rustup/settings.toml` の変更、override、環境変数

## 5. 2026-11-06：④ `95686606` の `runexec` のビルド（取得なし）

- ④の `Cargo.lock` と `rust-toolchain.toml` は `2e536b6b` と同じでした（`git diff` で確かめた）。そのため、§1・§2 で手元にある物だけで、ビルドできました。
- コマンド：`RUSTUP_AUTO_INSTALL=0 CARGO_NET_OFFLINE=true cargo build --release --offline --locked --bin runexec`（作業用の一時フォルダの中の、④の木の使い捨ての worktree で実行）。
- 新しい取得はありません：ツールチェーン・crate・ネットワークのどれも使っていません。
- 出力は一時フォルダの `target` の中だけです。`runexec` の sha256 は `0b5a13e73dbe6ea876028fecc073d219b6fc3d7433626e2d19ed3b69af0bbf11`（2回のビルドで同じ値）。
- ④の提案パッチを確かめるために、同じ方法でもう一度ビルドし、`cargo test --offline --locked --test acts --test act_cli` を実行しました。その後、④の木に戻して、元のバイナリを作り直しました。

## 6. 2026-11-06（2回目）：④ `8e96f24d` の `runexec`（取得なし）

- ④の `Cargo.lock`・`Cargo.toml`・`rust-toolchain.toml` と、path で使う `permutation-rules`・`frontier-abi` は、95686606 と同じでした。
- 同じ offline の方法でビルドしました。sha256 は `da8755f6f9aaa49d9bb3d178a0dc5cedb416798ea9728f8ae2a7c8ce1d8105e9` です。
- 新しい取得はありません。

## 7. 2026-11-06（3回目）：④ `d0e96d53` の `runexec`（取得なし）

- `frontier-abi` は変わっていましたが、`Cargo.lock`・`Cargo.toml`・`rust-toolchain.toml` は同じでした。
- 同じ offline の方法でビルドしました。sha256 は `dd022fc2be1948b36b4ed13b8d2eea3ffcb4d901ac7ef11da0337169af3f5f15` です。
- 新しい取得はありません。
