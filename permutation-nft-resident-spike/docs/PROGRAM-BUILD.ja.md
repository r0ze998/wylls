# 住民プログラムの配備用ファイルとソースの一致（2026-11-06）

## 1. いまの状態

`node archive/program-artifact.mjs status` の結果（v0.16 の時点）：

```
source digest 6d906500d82d6818031f4a83c5abc94d1f1c6756cb91e9275f1e3ef492c2504a (4 files)   ← v0.16 のソース
.so           95e462f39364b10ca5b2773a169a00755c64ce41e64fead97632477ac408e8bf (153120 B)
record        absent
MISMATCH: no build record (program/BUILD-RECORD.json)
NOT DEPLOYABLE as is
```

`program/target/deploy/wylls_resident_program.so` は 2026-10-31 の build（ENV-RECORD #10 の sha256 と同じ）で、そのあとの変更を含まない：`InitConfig` の upgrade authority 限定（v0.14）、販売条件・供給上限・受取先・メタデータ・authority の引き渡し（v0.16）。ファイルは git の管理外（`.gitignore` の `target/`）なので、リポジトリには古いファイルは入っていない。

## 2. 一致させる手順（所有者の端末、または鍵の扱いが承認された環境で）

鍵について：`cargo-build-sbf` は、`program/target/deploy/` にプログラム ID の鍵（`wylls_resident_program-keypair.json`）が無いと**自動で生成する**。本環境ではこの理由で build していない。build する環境で、生成させるか、所有者が決めたプログラム ID の鍵を置くかを先に決める（U27・U29）。

1. 配備するコミットを取り出す：`git checkout <完全な SHA>`。作業ツリーに変更が無いこと（`git status` が空）。
2. 道具の版を記録する：`cargo-build-sbf --version`（ENV-RECORD：3.1.9、platform-tools v1.52）。
3. build：`cargo-build-sbf --manifest-path permutation-nft-resident-spike/program/Cargo.toml`。root の `.cargo/config.toml` により生成物が `permutation-chain/target/deploy/` に出る場合は、`.so` を `permutation-nft-resident-spike/program/target/deploy/` に写す（ENV-RECORD #10）。
4. 記録：`BUILD_TOOLCHAIN="$(cargo-build-sbf --version)" node permutation-nft-resident-spike/archive/program-artifact.mjs record` → `program/BUILD-RECORD.json`（source の digest と `.so` の sha256・大きさ）。
5. 確認：`node permutation-nft-resident-spike/archive/program-artifact.mjs status` が `OK` を返すこと（終了コード 0）。
6. `BUILD-RECORD.json` をコミットする（`.so` 自体はコミットしない）。
7. 配備の直前にもう一度 5 を実行する。`MISMATCH` なら配備しない。
8. 配備の後：`solana program dump <program id> /tmp/p.so` で取り出した中身の sha256 と、記録の `soSha256` を比べる（programdata には末尾に余白が付くため、`.so` の長さで切ってから比べる）。
9. 推奨：再現できる build（`solana-verify build` など）で、第三者が同じ hash を得られることを確かめる（P7）。

`status` の判定：記録が無い、ソースが記録と違う、`.so` が記録の hash と違う、のどれかで `NOT DEPLOYABLE`。ソースの digest は `Cargo.toml`・`Cargo.lock`・`rust-toolchain.toml`・`src/` 以下の全ファイルから計算する（スクリプトの先頭）。

## 3. 鍵を使わずに確かめたこと

`test/sale-terms.test.mjs` の 3 件目：記録が無いと不一致、記録どおりなら一致、ソースを変えると「source changed」、別の `.so` だと「not the recorded build」。手元の一時ディレクトリの偽のファイルで確認した（build はしていない）。
