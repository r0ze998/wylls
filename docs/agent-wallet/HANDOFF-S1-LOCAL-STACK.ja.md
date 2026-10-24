# 引き継ぎ：S1 のプログラムで、ローカルのシーズンが立たない（2026-10-24）

宛先：S1（再設計の段階 1）の担当。
- S1 のコミットを書いたのはセッション `session_01Gx3UAdszBY9hdWLCVNjTUE` です。
- 作業中のブランチは `ccr-184d6862-fqutoz` です（S1 1f。main より 5 コミット先）。

書いたのは agent wallet の担当（PR #10）です。この文書の修正案は、agent wallet 側では行いません（二重修正を避けるため）。

## 1. 再現

- 対象：main の `c59372ccdcd02a7dbd91be6e323e3e84d12adb31`（PR #11 のマージ）を、そのまま使いました。
- ビルド：

```sh
scripts/build-frontier.sh --features test-beacon
scripts/build-prize.sh
(cd frontier-node && cargo build --locked --release --workspace)
```

- 起動：

```sh
frontier-node/target/release/frontier-stack up --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 10 \
  --game-hours 48 --season-end-at-play-end --bots 0 --personas off --prize-so permutation-prize/target/deploy/permutation_prize.so \
  --entry-fee 25000000 --run-id <新しい run id> --base-port 41700 --season <新しい番号>
```

- 結果：`run failed: operator transaction … failed: {"InstructionError":[3,{"Custom":1}]}`。
  - `Custom 1` は `BadData` です。CreateSeason の命令（取引の 4 番目）で起きます。
  - 計算量は 7,370 CU です。
- PR #10 の HEAD（`df2f7654`）でも、同じ設定でまったく同じ失敗になりました（同じ命令、同じ CU）。
- 両者で、プログラムの `.so` と Prize の `.so` は sha256 が一致しました。プログラム・スタック・ヘラルド・keeper・検証器のソースにも差分はありません。

## 2. 版の番号（紛らわしいので整理）

| `program_version` | 意味 | Rust の定数 | JS の profile | ruleset hash |
|---|---|---|---|---|
| 2 | M1 | （M1 のプリセット） | 1 | `RULESET_HASH` |
| 3 | 征服（MC） | `PROGRAM_VERSION_V2`（「v2」は CreateSeason のデータ形式の版） | 2 | `RULESET_HASH_V2` |
| 4 | S1 | `PROGRAM_VERSION_S1` | 3 | `RULESET_HASH_V3` |

- 以前の main（`2321d557`）のプログラムは `PROGRAM_VERSION = 3` でした。
- 今の main（`c59372cc`）のプログラムは `PROGRAM_VERSION = 4` です。

## 3. 原因（どこが食い違っているか）

S1 のプログラムは、自分と同じ版 4 のシーズンしか作りません。次の箇所が、まだ版 3（MC）だけを前提にしています。

| # | 場所 | 今の動き | 起きること |
|---|---|---|---|
| 1 | `frontier-node/crates/stack/src/setup.rs` の `conquest_params` | `MC_LOCAL_14D`（版 3）を送る。`S1_LOCAL_14D` は使われていない | CreateSeason が `BadData`（`permutation-frontier/src/proc/season.rs` の `prm.program_version != crate::PROGRAM_VERSION`）。**今回の失敗の直接の原因** |
| 2 | `frontier-node/crates/keeper/src/lib.rs` の `follow_abi` | v2 系なら一律 `PROGRAM_VERSION_V2` の上限表（`Budgets::canonical_for(3)`）を使う | 1 を直したあと、ConsumeGenesisSeed が毎回 `MaxLoadedAccountsDataSizeExceeded`。ring が公開されず、参加できない |
| 3 | `frontier-node/crates/herald/src/conquest.rs` の `season_info` | 版がちょうど 3 のときだけ征服シーズンとして扱う | `/h/status/conquest` が `"conquest": false` のまま |
| 4 | `frontier-node/crates/stack/src/verifyrun.rs` | 征服シーズンを `RULESET_HASH_V2` で検証する | S1 シーズンは V3 なので検証で食い違う |
| 5 | `frontier-node/crates/verify/src/conquest.rs`（CQ2 `SeasonIdentity`） | 版 3 以外を指摘する | S1 シーズンの身元の不一致として報告 |
| 6 | `frontier-node/crates/verify/src/facts.rs` | CreateSeason のデータを版 3 のときだけ読む | S1 のパラメータを拾わない |
| 7 | `frontier-node/crates/stack/src/resume.rs` | 版 3 のときだけ再開できる | S1 のシーズンを再開できない |
| 8 | `permutation-server/web/frontier/fplay.mjs` の `accountsFor` | `profile === 2` のときだけ征服の形（Province を付ける） | プレイ画面からの収穫が送れない。**`ccr-184d6862-fqutoz` ではすでに `isV2(...)` に直っている**（main には未マージ） |

- S1 のテストはプログラム単体（LiteSVM）とホスト側の検査で行われています。スタックからシーズンを立てる経路は通っていなかったようです。
- `setup.rs` のテストは MC のパラメータを検査して通っていますが、プログラムが受け付けるかどうかは見ていません。

## 4. 必要な修正（案）

1. スタックが S1 のシーズン（`S1_LOCAL_14D`。短い run では同じ上書き）を作る。MC も選べるようにするかは、担当の判断。
2. keeper の `follow_abi` は、シーズンの `program_version` をそのまま `Budgets::canonical_for` に渡す（S1 の上限表になる）。
3. ヘラルドの `season_info`、検証器の `conquest.rs` と `facts.rs`、スタックの `resume.rs` は、「版 3 と等しい」ではなく「版 3 以上」（S1 は MC のルールをすべて保つ、という `presets.rs` の説明どおり）にする。
4. スタックの `verifyrun.rs` は、シーズンの版に合った ruleset hash（S1 は V3）で検証する。
5. `ccr-184d6862-fqutoz` の `fplay.mjs` の修正（`isV2`）を main に入れる。
6. 回帰の確認として、CI か手順書に「スタックで S1 のシーズンを立て、参加と収穫が着地し、検証器が PASS」を加える。

## 5. 一時的なパッチで確かめたこと（診断のみ。どのブランチにも入れていない）

- PR #10 の HEAD をもとに、上の 1〜6（`setup.rs`、`keeper/lib.rs`、`herald/conquest.rs`、`verifyrun.rs`、`verify/conquest.rs`、`verify/facts.rs`）を最小限に書き換えた作業用コピーを作りました。
- 結果：
  - シーズンが立ち、ring 5 つが公開され、ヘラルドは `"conquest": true`。
  - keeper の genesis-seed・open-ring・open-province は、すべて着地しました。
- その上で、さらに次の 2 つを当てて、agent wallet の実ブラウザの確認を通しました。
  - 8 の `fplay.mjs`（`ccr-184d6862-fqutoz` と同じ一行）。
  - agent wallet 側の修正（下の 6）。
- 実ブラウザの結果：
  - 手動プレイ → 委任 → 自動行動 → 委任中の拒否 → 鍵の取り戻し → 手動プレイ → 全額出金：9/9。
  - テスト用の拡張での全操作と 4 か所の拒否：13/13。
- 検証器：PASS。警告は V2 `ProgramMismatch`（tx#9）と V9 `PrefundedAddress` で、どちらも以前から出ているものです。
- これは「必要な修正の範囲」を確かめるためのもので、正式な修正の代わりにはなりません。正式な修正は、S1 の担当がテストと一緒に入れてください。

## 6. agent wallet 側で直したこと（PR #10）

- `permutation-gateway/src/frontier/agent/gateway.mjs` の `accountsFor` も `profile === 2` で判定していました。そのため S1 では、代理人の収穫が `BadRequest` で拒否されていました（判断料は 0）。
- `isV2(profile)` に直し、テストを追加しました。

## 7. S1 の修正が入ったあとに agent wallet 側で行うこと

S1 の修正が入った main を PR #10 に取り込み、ビルドし直した最終 HEAD で、次を実チェーンと実ブラウザで確かめ直します。

- 作成 → 入金 → 予算 → 委任 → 自動行動 → 停止 → 鍵の取り戻し → 出金。
- 手動プレイへの復帰。
- 署名を拒否しても、残高と権限が変わらないこと。
- 課金と残高が合っていること。
