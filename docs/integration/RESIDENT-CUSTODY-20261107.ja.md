# ResidentFeed と custody-preview の保全統合

## 入力と範囲

- ResidentFeed・広域マップ・ゲームUI: 133ae051f446fd1850a5da8899bc5909609d0591。
- custody core rev4: 3fa1f4a73c858ac02bf8a422dc35b9ddfa0da2e8（455f03af と 45cea676 の統合）。
- 独立枝で通常 merge。競合なし。追加のコード変更は verify/checks/mod.rs の module 順序の整形だけ。
- UI の画面ソースは 133ae051 から変更していない。SDK の custody ABI データは追加した。
- main、デプロイ、実取引には反映しない。

## 同一の統合木で実行した確認

鍵ペア生成・秘密鍵導出・署名は実行していない。PDA/with_seed の公開アドレス計算は許可された範囲で実行。保存済み fixture を読み、取引を作り直す record 関数は呼ばない。

frontier-node で、既存 target を利用し cargo test --offline -p verify の次の対象を指定した。

- --lib checks::v26_growth::tests:: : 5/5。
- --lib checks::v27_residents::tests:: : 7/7。
- --lib checks::v28_resident_acts::tests:: : 7/7。
- --lib resident_feed::tests:: : 2/2。
- --test history : 16/16。
- --test custody : 6/6。
- --test custody_state : 7/7。
- --test custody_history : 8/8。

合計 58 件通過。custody の試験はホスト上の規則・保存状態・履歴の照合であり、配備済みプログラムの実取引ではない。

- cargo check --offline --workspace --all-targets: 通過（コンパイルのみ）。
- cargo clippy --offline -p verify --tests -- -D warnings: 通過（コンパイルのみ）。
- permutation-frontier の cargo +1.95.0 check --offline --lib: 通常版、nft-experimental 単独、custody-preview 単独が各通過。
- nft-experimental,custody-preview 同時指定: 意図どおり compile_error で拒否（exit 101）。PROGRAM_VERSION 未定義の追加エラーも出る。この併用を許す変更はしていない。

## 残る制限

- custody-preview は既定無効。NFT と custody を同じゲームで使える完成版ではない。共通の権限・プログラム版は未決。
- map-growth と custody は V26 の番号を共用する。checks_run の接尾辞では区別できるが、所見の check は双方 V26。この番号割当は解決していない。
- custody 命令そのものの再生は未完成。custody の季は UNVERIFIABLE のままで PASS としない。
- 新規 custody 11 命令に関する旧 coverage 試験の期待値は今回変更も実行もしていない。全試験通過とは主張しない。
- ResidentAct の内側の効果の再生、実チェーン、署名付き E2E、LiteSVM、SBF は未確認。
- NFT 賞金の成功確認ではない。従来の stage E は BadAccount による拒否確認。
- ④ r4/r5 の bundle 本体は未受領。賞金 31 項目照合の修正を取り込んだとは主張しない。

[skip ci] 付き保全枝だけへ push。CI/実配備を起動しない。
