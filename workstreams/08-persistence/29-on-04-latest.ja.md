# 29 ④の最新への移植：地図拡張・継続世界・BeaconLog（2026-11-06）

- **基準：** ④の最新 `8e96f24df4aa4ed51277fa42de6a354a21cd2bc6`（tree `ebbc0f764dd02490e2cea15ce0403d9480f59a65`、`origin/claude/gallant-ride-cunptv`）。
- **試験の制約：** 鍵の生成・導出・署名を伴う試験はしていません。実チェーン・ローカルチェーン・LiteSVM の実行もしていません（LiteSVM の試験はコンパイルだけ）。

## 1. ④の最新が持っているもの・持っていないもの

| ⑧の成果 | ④の最新 |
|---|---|
| 継続世界（バイト80、`NO_END_BELL`、エラー94、EndSeason の拒否、賞金の `ContinuousSeason`、画面の文言） | **取り込み済み**（④自身の commit。⑧の案に、未知のフラグを拒否する規則と試験を足したもの） |
| 地図拡張・分散配置・ヘラルド・画面・キーパー・終了ベルの修正 `f3f23442` | **無し**。征服パラメータのバイト77〜79は「⑧の項目のための予約（0 必須）」 |
| BeaconLog の再起動後の再投稿の修正 `5366f7c5` | **無し**（2章） |
| 継続世界の `agents/campaign.rs` の u32 の桁あふれの修正 | **無し**（3章） |
| `frontier-stack snapshot`・継続世界の LiteSVM 試験・`keeper-journal-counts.py` | 無し（検証用の道具） |

## 2. BeaconLog の再投稿

- **状態：未採用です。**
  - ④の keeper の `beacon_log_plan` は、今も記憶の中の `beacon_log_bell` だけで防いでいます。
  - ④の `Engine::ensure` が同じ操作キー（`beacon:{bell}:{region}`）を飛ばすのは、そのキーが処理中・待機中・保留中・曖昧として引き継ぎ中のときだけです。再起動の前に着地したキーは、もう一度予定に入ります。
  - したがって、同じベルの中で再起動すると、また投稿します（⑧の ver-4 では、余分な16件で602,048 lamports）。
- **最小差分：** `workstream/08-beacon-on04` = `7128e3bd0665a5c0223f3fce67f42fc9962f79ef`（tree `5bf585b25337eb5fc1bbc4d3574a1813a515ba9d`）。
  - `beacon.rs` の1ファイル、+52／−4 行。
  - チェーンの BeaconLog の `posted_ts` が今のベルなら、投稿しません。
  - 同じ操作キーの扱い（統合側の担当）は変えていません。
  - 鍵を使わない単体試験 `beacon_log_due_reads_the_posted_bell_from_the_chain`：通過。

## 3. 継続世界の小さな修正

`workstream/08-cont-fix-on04` = `b8aedd7e447b6a285e97705353d75e7d6296a45e`（tree `0a10e49fd5795b9b28fb42f89d0ba526b36f05a5`）。

- `agents/src/campaign.rs` の `self.end_bell + 300` を `saturating_add` にしました。
- 継続世界では `end_bell` = u32::MAX なので、元の式は桁あふれします（debug なら panic、release なら 299 に戻る）。
- 型の検査（`cargo check -p agents --tests`）だけ行いました。

## 4. 地図拡張の移植

`workstream/08-on04` = `3f979d18dc1c83a06abc851863ea86b1b16b37c4`（tree `6a909ea997fdbe5e03ae9c7cb0093d8644da4edb`）。3つの commit です。

1. **`d1b44b57`：** 有限の地図の系列（基準 → `58c5ef64`）のコードを1つの差分として当て、14ファイルの衝突を解きました。⑧の文書は含みません。
2. **`f3841914`：** 予約の末尾が81から始まることに合わせた試験の修正と、④の registry の再生成（差分は `0xc1 ExtendFrontier` の1行だけ）。
3. **`3f979d18`：** 画面の世界の判定に配置の規則を足し、④の継続世界の画面試験と⑧の live-map の fixture を、合わせた並びに直しました。

**衝突の解き方（すべて両方を残す形）：**

- **征服パラメータ：** `PLACEMENT` 77、`R_MAX_CEILING` 78〜79、`CONTINUOUS` 80、予約 81〜127。
  - ⑧の継続世界の候補 `e3d773df` と同じ並びです。④の予約はこの項目のためのものでした。
  - 復号器は④の fail-closed（フラグが 0・1 以外なら拒否）を保ち、未知の配置（2以上）にも同じ規則を当てました（Rust の `from_bytes`、`fclient` の復号、画面の `fcodec`）。
- **賞金：** `CeilingPastTally` 0x111 と④の `ContinuousSeason` 0x112。InitPool は両方を検査します。
- **ヘラルドの `/h/season`・`/h/world`：** ④の `continuous` と⑧の地図の項目。
- **stack：** ④の `--continuous` と⑧の `--placement`・上限・キーパーの拡張。
- **生成物：** 生成器で作り直しました（`abi-vectors`、`sync-web-sdk.mjs`）。

**3つの枝の合わせ：** ④が3つを一緒に取り込んでも衝突しません（`git merge-tree` で確認。合わせた tree `00aff8068a75140b3f593edee1d87a7f1d0df0ff`）。

## 5. 保存・再起動・履歴の整合

| 確認 | 種類 | 結果 |
|---|---|---|
| 生成物が新しいか（`cq-regen.sh` の手順1・2・4・5・6） | 生成器の確認 | すべて新しい。手順3（fclient の vectors）は鍵から作る署名を含むため実行していない（⑧はこのファイルを変えていない）。手順7・8（wasm）は wasm32 の target がないため未実行 |
| ⑧の地図の program で作った実際の Season（mx-1 の t0・t3） | 実際の記録の復号 | ④の最新では `BadWorldMode`（予約のバイトが0でない）で**読めない**。移植では読める（配置0、上限7、継続0、終了ベル2016） |
| ④の registry・エラー番号・旧経路の賞金の試験（e2e-native） | host 実行、鍵なし | 8件通過（registry の再生成の後） |
| `permutation-rules`・`frontier-abi` | 単体・結合 | 507件・127件、失敗0 |
| `permutation-frontier`・`permutation-prize` の lib | 単体 | 95件・6件、失敗0 |
| frontier-node：鍵を使わないと判定できた試験 | 単体 | herald 5・stack 27・bots 25・verify 3・agents 1、keeper の `rings` 2、fclient の `land` 9。失敗0 |
| 型の検査（root・prize・frontier-node 全体・LiteSVM の試験） | コンパイル | すべて通過 |
| 画面の試験 13本（clock・codec・conquest-state・conquest-ui・conquest-wiring・holding-projection・home・live-map・map・placement・wave4-map・world・continuous） | 画面の関数 | 109件通過 |
| カーネルの照合（`kernel-parity`、Node） | ネイティブ ↔ コミット済み wasm ↔ 画面 | 38,760・5,449・21,438・393件、不一致0 |
| 同じ照合をブラウザで。mx-1 の実際のヘラルドの記録の再生（t0〜t3）と、継続の fixture | ブラウザ | 不一致0。鍵の操作0回。有限は「シーズン終了まで」、継続は「この世界は続きます」 |

- **frontier-node の試験の選び方：** 鍵の型や署名の呼び出しを含むファイルの試験と、それを含むモジュールを参照するモジュールの試験は、すべて飛ばしました（`tools/keyless.py`。crate の場所を渡すと、飛ばすモジュールと実行する試験を出す）。そのため、ヘラルドの復号・キーパーの journal と再起動・fclient の復号の大半の試験は、**実行していません**。
- **再起動：** チェーン上の再起動の確認は、⑧の系列での以前の結果（mx-1 の停止・再開で食い違い0、cont-2・ver-1〜4）だけです。④の最新の上では、チェーンでの再起動は試していません。
- **履歴：** 拡張のログ（104）の形の vectors は新しい状態です。ヘラルドが104を復号するコード（`3bea283e`）は移植に入っています。その試験は鍵を含むモジュールにあるため、実行していません。

## 6. 世界ID・時計・期間

28章（`28-world-clock-period-contract.ja.md`）と `contract/world-clock-period.json`。

## 7. ④の判断を待つもの

- 3つの枝の採否と順番（どの順でも衝突しない）。
- 征服パラメータの77〜80の並び（⑧の案。④の予約と同じ意図）と、配置の fail-closed。
- registry に prize のエラーを載せるか（0x111・0x112 とも未掲載）。
- 期間の単位（世界の bell の半開区間）の確認。
- 履歴の圧縮（M7）。
- 移植の上での、チェーンでの再起動・LiteSVM の実行（署名が要る）。
