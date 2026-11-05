# 09 V26：仕様が決まっている範囲の再判定（2026-11-05）

core 差分に 0010 を足した（`patches/0010-*.patch`、ブランチ `workstream/10-custody-core-v26`。`96fe6abf` の上の 1 コミットで、`96fe6abf` 自体は変えていない）。検証器 `frontier-node/crates/verify` の `V26` に **`V26:custody-state`**（custody シーズンだけ）を足し、口座だけで決まる法則を再判定する。**どの場合も custody シーズンは PASS にならない**：履歴の再生（命令ごとの再判定）がまだないので、法則がすべて成り立っても `CustodyUnverified`（UNVERIFIABLE）が残る。

## 1. 何を「決まっている」とみなしたか

⑩のカーネル（`permutation-rules/src/frontier/custody.rs`）は、どの命令も書く前に次を検査する。どの番号（タグ・記録種別・エラー）を④が割り当てても変わらない、区画と倉の**口座の中身についての法則**なので、ここだけを再判定の対象にした。

| 法則 | 破れていたら | 根拠（カーネル） |
|---|---|---|
| 区画の保存則 `IN_TOTAL = HELD + OUT_TOTAL + CONSUMED + FORFEITED`、各値が負でない | FAIL `CustodyLotBroken` | `finish_inbound`・`spend_ship`・`consume`・`forfeit` が両辺を同時に動かす |
| 区画の資源が有効（今は鉱石だけ）、`QUOTA` が整数単位 | FAIL `CustodyLotBroken` | `open`・`set_quota` |
| 注文枠：空き枠はすべて 0、使用中なら残量 > 0・id < `NONCE`・受け手 ≠ 所有者・id の重複なし・発送は別の倉宛て・利用は宛先なし | FAIL `CustodyLotBroken` | `set_order`・`spend_order`・`revoke_order` |
| 到着枠：空き枠はすべて 0、使用中なら量 > 0、同じ隊商を二重に待たない | FAIL `CustodyLotBroken` | `begin_inbound`・`finish_inbound`・`drop_inbound` |
| 状態が 開／没収／閉 のどれか。閉じた区画は空 | FAIL `CustodyLotBroken` | `close` |
| 開いた区画：`HELD + 到着予定 ≤ QUOTA` | FAIL `CustodyOverCapacity` | `begin_inbound` |
| 生きている倉：`STORES[r] + CUSTODY_QUOTA[r] ≤ CAP`、`CUSTODY_QUOTA` が負でない | FAIL `CustodyOverCapacity`／`CustodyLotBroken` | `open`・`set_quota`・改定した SettleCaravan |
| 固定スロットの一つの写しの中で：倉の `CUSTODY_LOTS` ≥ 見えている開いた区画の数、`CUSTODY_QUOTA[r]` ≥ 見えている開いた区画の quota の和、区画の世代 ≤ 倉の世代 | FAIL `CustodyVaultCounts` | `open`・`close`・`forfeit`、押収で世代は増えるだけ |

**証拠不足を FAIL にもしない。** 倉の数と和は「見えている区画が多すぎる」ときだけ FAIL にする。入力に欠けた口座は見える和を減らすだけで増やさないので、この向きだけが確実に言える。少なすぎる側（区画が入力から欠けている可能性）は判定しない。

## 2. 判定しないもの（UNVERIFIABLE のまま）

| 対象 | 理由 |
|---|---|
| 予約 ≤ 保管 | 期限内の注文だけが予約する。口座に今の鐘がないので、期限切れの注文と区別できない |
| 区画の住所（`cl` の seed） | 住所の導出は V9 の領分。⑩の seed 自体が仮（④の割当） |
| 署名者・権限・命令の順序・二重送信 | 命令の再生が要る（V26 の本体、未実装） |
| 没収された区画、押収された倉に残る開いた区画 | 押収時の扱いは⑩の提案で、決定ではない。`CustodyRuleUndecided`（UNVERIFIABLE）。没収された区画でも保存則が破れていれば FAIL |
| 保管品の隊商（`CUSTODY` 欄） | 隊商の積荷と区画の到着枠の対応は命令の再生が要る |

## 3. ⑱の V0 との関係

| | ⑱ V0（④の候補 `d0949fd4` に入っている） | ⑩ V26 |
|---|---|---|
| custody のないシーズンで custody 命令が着地 | `supported()` が false → `UnverifiedInstruction`（UNVERIFIABLE） | `CustodyInProgramWithoutIt`（FAIL）。合わせると FAIL |
| custody シーズン（版 5） | `UnknownProgramVersion`（UNVERIFIABLE、既知の版は 1〜4） | 痕跡ごとに `CustodyUnverified`（UNVERIFIABLE）＋口座の法則違反は FAIL |
| 口座の中身 | 見ない | 本書 §1 |

二つは重なるが矛盾しない（どちらも PASS にしない）。**組み合わせの注意**：⑱の V0 と⑩の 0006 は、`Ctx` に同じ名前・同じ引数の `unverifiable` を足している。両方を当てると定義が二重になる。⑱が先に入るなら 0006 のその関数は落とす（中身は同じ）。どちらを残すか、V26 のガードを V0 に寄せるかは④の判断（[07](07-handoff-status.ja.md) §3）。

## 4. 回帰試験

`frontier-node/crates/verify/tests/custody_state.rs`（7 件）。既存の `tests/custody.rs`（6 件、ガード）もそのまま通る。

| 試験 | 確かめること |
|---|---|
| `what_the_kernel_writes_passes_the_audit_and_the_season_is_still_unverifiable` | カーネルが書いた区画と倉に V26 の FAIL なし。それでも判定は PASS でなく `CustodyUnverified` が残る。`V26:custody-state` が走った |
| `a_lot_the_kernel_cannot_write_fails` | 12 種の偽造（どこからか増えた・消えた・負・無効な資源・所有者への注文・未来の id・使い切った注文の残り・空き枠に量・自分の倉への発送・二重の到着・quota 超過・不明な状態）と、読めない区画がすべて FAIL |
| `a_vault_over_its_cap_fails` | `STORES + CUSTODY_QUOTA > CAP` が FAIL |
| `vault_counts_fail_only_when_the_visible_lots_exceed_them` | 一致なら所見なし。区画が入力から欠けても V26 は FAIL にしない（PASS にもならない）。数・quota が見えている分より少ない、区画の世代が倉より新しい、は FAIL |
| `undecided_rules_are_unverifiable_not_fail` | 押収された倉の開いた区画、没収済みの区画は V26 の FAIL にならず `CustodyRuleUndecided`（UNVERIFIABLE）。没収済みでも保存則が破れていれば FAIL |
| `a_broken_lot_in_a_post_state_fails_at_its_transaction` | 取引の後の状態に壊れた区画があれば、その取引の FAIL |
| `random_kernel_runs_never_fail_the_audit` | カーネルの関数を乱択で 300 × 60 回動かし、どの状態も FAIL にならない（誤検出がない） |

**試験の限界（正直に）。** 記録済みの custody シーズンはない（SBF ビルドができない）。試験は M1 の記録 `march` に区画・倉の口座を差し込み、設定の ruleset を V4 にしている。そのため判定全体には V1（どの取引も書いていない口座＝`ChainGap`）・V2（記録上の ruleset と設定の不一致）の FAIL も出る。試験は **V26 自身の所見**（`check == "V26"`）と「PASS でない」だけを確かめている。本物の custody シーズンでの判定は、記録ができてから確かめる必要がある。

## 5. 実行結果（この作業機、frontier-node は Rust 1.95.0、`--offline --locked`）

| 対象 | 結果 |
|---|---|
| `cargo test -p verify`（全体） | **103 件通過、失敗 0**（ignored 2 件は以前から）。新しい `tests/custody_state.rs` 7 件、既存のガード `tests/custody.rs` 6 件を含む |
| 変異試験 6 件（区画の保存則を外す／倉の数を両方向で判定／未決を FAIL に／区画の quota 上限を外す／倉の CAP 上限を緩める／監査を走らせない） | **6 件すべて検出** |
| rustfmt（1.89.0 の rustfmt、edition 2021） | 整形済み |
| clippy | 下記 §5.1 |

### 5.1 clippy

frontier-node の 1.95.0 には clippy がない（`rust-toolchain.toml` の注記どおり）。stable（1.97.0）の clippy で `-p verify --all-targets -D warnings` を実行し、警告なしで通過した。

### 5.2 ⑱との組み合わせ（当てて数えただけ、ビルドはしていない）

0001–0009 を⑱の先端 `0bba3f31` に `git am -3` で当てると全部当たるが、`frontier-node/crates/verify/src/checks/mod.rs` に `pub fn unverifiable` が **2 つ**できる（⑱の V0 と⑩の 0006 が同じ関数を足す）。このままでは検証器がコンパイルできない。11-03 の報告（[07](07-handoff-status.ja.md) §1「全部当たる」）は当たることだけを確かめたもので、ビルドの確認ではなかった。⑱と合わせるときは 0006 のその関数を落とす（中身は同じ）。0010 は⑱の上にも当たる。

## 6. 版と番号

0010 は ABI の番号も版も変えない（検証器の所見コードの文字列を 4 つ足すだけ：`CustodyLotBroken`・`CustodyOverCapacity`・`CustodyVaultCounts`・`CustodyRuleUndecided`）。`custody_season` の判定（`RULESET_HASH_V4` か版 5 以上）は⑩の仮の版のままで、④が版を割り当て直したら合わせる。
