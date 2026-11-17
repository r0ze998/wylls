# ⑨ のコア変更（④へ渡す）

> **2026-11-08：** 0001 はこの木に適用済み（④ の候補 `cf517b55` の上の commit `5813eb2d`）。④ の候補へ当てる列は [to-04-cf517b55/](to-04-cf517b55/)（5 つ、`git am` で tree `f96bd565…`）。[../INTEGRATION-04.ja.md](../INTEGRATION-04.ja.md)。

| 番号 | 種類 | 中身 | 確かめたこと |
|---|---|---|---|
| [0001](0001-holding-lent-workshops.patch) | `git apply` できる差分（8 ファイル、+187 −9） | `Holding.lent_workshops`（規則）と `LENT_WORKSHOPS @ 700`（ABI v2、旧 `RSV_700`）、program・検証器・LiteSVM ハーネスの読み書き、占領での解除 | 下の表 |
| [0002](0002-core-instructions.ja.md) | 文書（命令の案） | CapacityPool／CapacityJob の口座と 11 命令、材料の出入口、喪失の時刻、検証器・Herald・予算への影響 | 未実装。カーネルが同じ状態遷移を実行し試験済み |
| [0003](0003-kernel-claimsplit-accounts-refusal.patch) | `git apply` できる差分（`workstreams/09-capacity/kernel` だけ。コアは変えない） | ⑩ の要求への回答：`Op::ClaimSplit`（材料ごとの整数単位の返却と端数の宛先）、`Harness::apply_detailed` と `CustodyError::Refused(u16)`（預かりの理由）、予約の口座 `Job::accounts()` と `Event::Receipt`、`testkit::world_with` | 統合候補 `ef63544c` に `git apply` で当たり、そこで kernel 43 件と ⑩ の adapter-09 11 件が通過（2026-11-06）。④ の最新 `8e96f24d` にも変更なしで当たる（同日） |
| [0004](0004-kernel-abi-04-provisional.patch) | `git apply` できる差分（kernel だけ、4 ファイル +263。0003 の後に当てる） | ④ の仮割当（改訂 3、④ `8e96f24d`）どおりの ⑨ の番号：命令 `0xF0–0xFD`、エラー `109 + カーネルの番号`（110–139）、AccountKind 25・26、seed `cp`・`cj`、magic の提案 `PSF1CPOL`・`PSF1CJOB`。記録の kind は**割り当てない**（⑨ は 20 種、④ の帯は 10）。feature `abi-04-provisional` の内側だけ（既定の build は変わらない）。`ClaimSplit` は `ClaimJob`（0xF9）に入れる**提案** | ④ `8e96f24d` の kernel に 0003 → 0004 の順で当たり、tree `9bd610c3…`。そこで kernel を feature つきで 47 件通過。0003 を当てた kernel は ⑨ の `06c817cc` の kernel と同じ tree `f2398a2c…`（2026-11-06） |

## 0001 の中身

- `permutation-rules/src/frontier/holding.rs`：`Holding` に `lent_workshops: u32`。自分の兵器生産は `production[ARMS] − lent × WORKSHOP_DELTA`（`own_arms`）で、材料の使用もその分だけ。枯渇の切り替え（`dry_after`/`dry_at`）も自分の分で判定。`workshops()`、`lend_workshops(now, n)`、`reclaim_workshops(now, n)` を追加。`CaptureEffects.lent_workshops = 0`。**lent = 0 なら挙動は一切変わらない**ので版（`HOLDING_VERSION_V4`）と ruleset hash は変えていない（④ の判断事項）。
- `permutation-rules/src/frontier/arms.rs`：試験 4 件（貸した Holding は「その分少なく建てた Holding」と全時刻で同じ店の値、経路独立と上限、全部貸すと兵器も材料も動かない、占領で解除）。
- `frontier-abi/src/v2/layout/player.rs`・`vectors/v2/layouts.json`：`RSV_700` → `LENT_WORKSHOPS`（同じ 4 バイト。v1 の M1 レイアウトは変えない）。vectors は同梱の生成器（`cargo run -p frontier-abi --bin abi-vectors`）で作り直した。
- `permutation-frontier/src/proc/holding.rs`・`conquest.rs`：Holding の読み書きと、占領での `lent_workshops = 0`。
- `frontier-node/crates/verify/src/holding.rs`・`permutation-frontier/svm-tests/src/world/holding.rs`：同じ読み書き。

## 0001 で確かめたこと（2026-10-30、この作業機、Rust 1.89.0）

| 対象 | 結果 | 記録 |
|---|---|---|
| `permutation-rules` 全試験 | 通過（lib 166 件を含む） | `../results/patch-0001-tests.log` |
| `frontier-abi` 全試験（layout の不変条件と vectors の鮮度を含む） | 通過（87 件ほか） | 同上 |
| `permutation-frontier` のホスト試験 | 通過（94 件） | 同上 |
| `frontier-verify`（frontier-node、Rust 1.95.0） | 通過（58 件ほか） | `../results/patch-0001-verify.log` |
| `permutation-frontier/svm-tests` の **コンパイル**（`cargo check --tests`） | `../results/patch-0001-svm-check.log` を参照 | 実行には SBF の `.so` が要る |
| カーネルを `--features core-patch-0001` で | 通過。模擬の貸し出しとパッチの貸し出しが 400 通りで店の値まで一致 | `../results/patch-0001-tests.log` |
| **SBF ビルドと LiteSVM 実行** | **未実行**（Agave 3.1.9 の導入が自動承認で拒否されたため。回避していない） | — |

## ④ に判断を頼むこと

1. `lent_workshops` を S1 の版に入れるか、S2 の版（新しい `HOLDING_VERSION`）を立てるか。
2. `ReleaseDormant` で解放された Holding の `LENT_WORKSHOPS` を明示的に 0 にするか（閉じられるなら不要）。
3. 検証器の Holding 再生に `lent_workshops` を含める範囲（0001 は読み書きだけ。0002 の命令が入るまで値は常に 0）。
