# ⑨ 他人の工房の「加工能力」を借りる

> **2026-11-06：⑩ の adapter-09 の上で動かし、⑩ の要求 R1–R6 に答えた（`ClaimSplit`、`apply_detailed`、予約の口座と受領書）。** [CONNECT-10.ja.md](CONNECT-10.ja.md) §5。共有の kernel 変更は [patches/0003](patches/0003-kernel-claimsplit-accounts-refusal.patch)。

> **2026-11-05：⑩ との接続（工房・加工側のアダプターと契約試験）は [CONNECT-10.ja.md](CONNECT-10.ja.md)。**

> **2026-11-05 の隔離統合候補では、世代番号の再利用を安全側で拒否する修正があります。** [INTEGRATION-20261105.ja.md](INTEGRATION-20261105.ja.md) を参照してください。下記の元担当の試験記録は、その修正より前の記録です。

> **2026-10-31 の方針訂正（世界は期間で終わらない）への対応は [CONTINUITY.ja.md](CONTINUITY.ja.md)。** 残っていたシーズン依存、変更した挙動、試験、残る判断をまとめています。

作業日 2026-10-30。ブランチ `claude/elegant-bohr-co2uhr`。この担当の成果物はすべてこのディレクトリにあります。**共通コア（`permutation-rules`、`frontier-abi`、`permutation-frontier`、`frontier-node`）はこの checkout では一行も変えていません**。コアの変更は [patches/](patches/) に独立した差分として置き、一時 worktree に当てて試験しています。

## 0. 作業開始時の状態（記録）

| 項目 | 値 |
|---|---|
| 作業開始時の HEAD | `921429322d5aecd1a3df0dd8d82c405c87dd985a`（= `origin/main`、PR #20 の merge）。未 commit の変更・未追跡ファイルなし |
| 既知の共通基準 `4cd901de` | `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`「Document consolidated development handoff」。`main` には無く、`origin/integrate/claude-consolidation-20261029`（その後 `a4fc78ca` まで進んでいる）と ③ の `origin/claude/modest-goldberg-c180fk` に含まれる。`main` から文書だけの 6 commit 先 |
| この担当の基点 | `4cd901de` へ早送り（`git merge --ff-only`。誰の作業も reset していない） |
| 他の担当の資料 | ③（`workstreams/03-composability/`、別ブランチ）だけが remote にあった。②（StockSwap・Grant）、④、⑥、⑩ の資料は remote のどのブランチにも無い → **adapter を分けて先に進めた**（§4） |
| AGENTS・スキル | リポジトリのどのブランチにも `AGENTS.md`・`CLAUDE.md`・スキル定義は無い（§6 の食い違い 1） |

## 1. 何ができたか（結論）

| 目標 | 判定 | 根拠 |
|---|---|---|
| A が工房の一部の能力を B へ許可 | **動いた（カーネル）** | `OpenPool` → `Lend` → `Grant`。A の実物の `Holding` の兵器の率が 12/時 → 4/時 に下がる（2 棟を貸出枠へ） |
| B が材料を投入 | **動いた（カーネル＋模擬の預かり）** | B の実物の `Holding` が材料を払い、隊商（`caravan::walk` の実時間 1,620 秒）で施設へ、`Deposit` でホッパーへ |
| 実際の能力と時間で加工 | **動いた** | 2 棟 × 兵器 4/時、鉱石 2・木材 1/兵器（`permutation_rules::frontier::arms` の定数を直接使う）。30 兵器に 13,500 秒。途中で精算しても、何度精算しても同じ |
| B が成果物を受け取る | **動いた（カーネル＋模擬の預かり）** | `Claim` で帰りの隊商へ、到着で B の `Holding` に兵器 30 |
| A の秘密鍵を B や AI に渡さない | **成り立つ** | A の署名は最初の 3 回だけ。以後の操作は B の署名か、署名の要らない精算（crank）。デモが A の署名回数 0 を検査 |
| 二重使用なし | **検査済み** | B の加工中、A 自身の兵器 15 + B の兵器 30 = 45 = 工房 3 棟の能力。A の減少分 30 = 貸した 2 棟の能力 |
| 2 利用者の能力競合 | **検査済み** | 枠を超える予約は `CapacityExceeded`、予約がある枠の取り戻しは `ReclaimBlocked`。早く終わった予約の枠はその時刻から使える。ランダムな 300 通り（約 36,000 手）で不変条件を毎手検査 |
| **オンチェーンでの実行** | **未実行** | 命令がまだ無い（[0002](patches/0002-core-instructions.ja.md) に具体案）。SBF ビルド用の Agave 3.1.9 の導入は自動承認で拒否され、回避していない |

## 2. 実物・カーネル・模擬の区別

| 部分 | 状態 | どこ |
|---|---|---|
| A と B の村（`Holding`：遅延精算、工房の連続変換、休眠、占領の効果） | **実物**（`permutation-rules`） | `kernel/src/facility.rs`、`testkit.rs` |
| レシピの数字（鉱石 2 + 木材 1 → 兵器 1、4/時/棟） | **実物**（定数を読む。書き写さない） | `kernel/src/recipe.rs` |
| 隊商の移動時間 | **実物**（`caravan::fastest_path` と `walk`）。ただし土地は全部通れる平地、道なし、襲撃なし | `testkit::caravan_secs` |
| A の工房を貸出枠へ移す | パッチ 0001 を当てれば **実物の `Holding::lend_workshops`**。当てない build では同じ結果を出す写し（`facility::emulated`）。両者の一致を 400 通りで検査 | `facility.rs`、`tests/owner_side.rs` |
| 貸出枠・許可・予約・精算・取消・喪失 | **カーネル**（純 Rust の状態機械。命令ではない） | `kernel/src/ledger.rs` |
| 材料と成果物の預かり | **模擬**（`MockCustody`。⑩ の代わり） | `kernel/src/custody.rs` |
| 命令・口座・検証器・Herald | **案だけ** | [patches/0002](patches/0002-core-instructions.ja.md) |

## 3. 動くデモ

```sh
cd workstreams/09-capacity/kernel
cargo run --example demo          # 出力の保存版: results/demo.txt
```

段階 1（1 施設・1 レシピ・1 利用者）と段階 2（2 利用者の競合）を順に実行し、各時点の材料・成果物の場所と所有者、預かりの保存則、A の生産の減少、A の署名回数を表示・検査します（どれかが崩れると assert で止まる）。

## 4. 成果物の地図

| パス | 内容 |
|---|---|
| [CONTINUITY.ja.md](CONTINUITY.ja.md) | 継続世界への対応（シーズン依存、変更、試験、④⑧⑩への要求） |
| [CONTRACT.ja.md](CONTRACT.ja.md) | **接続契約**（実装の前に版 0.1 を commit `9b801368`、実装後に 0.2、継続世界で 0.3）。④ へ操作・状態・イベント・エラー、⑩ へ預かりの入出力と不変条件 C1–C7、⑥ へ加工手順 |
| [RESEARCH.ja.md](RESEARCH.ja.md) | 実装の前に調べたオープンソース（Eternum の生産、Star Atlas の crafting、ERC-4907、Cardinal）と採否 |
| [kernel/](kernel/) | crate `wylls-capacity`（独立 workspace・lock）。`src/`：model, recipe, policy, error, event, custody（trait＋模擬）, facility, ledger, plan, testkit。`examples/demo.rs`。`tests/`：single_user（17）, loss（7）, contention（2、ランダム 300 通り＋精算の頻度の比較 50 通り）, owner_side（3、パッチ有りで 4）, continuity（8、戦期の境界・再起動・長期運用） |
| [patches/](patches/) | 0001（`Holding.lent_workshops`、適用可能な差分）、0002（命令の案）、README（試した範囲と ④ への判断事項） |
| [run.sh](run.sh) | fmt・clippy・試験・デモ、そして一時 worktree にパッチ 0001 を当てて rules・ABI・program（ホスト）・カーネル（パッチ有り）を試験 |
| [results/](results/) | この作業機での記録（下表） |

## 5. 試験の結果（2026-10-30、この作業機、Rust 1.89.0）

| 試験 | 結果 | 記録 |
|---|---|---|
| カーネル（パッチ無し、模擬の貸し出し）37 件 | 通過 | `results/kernel-tests.log` |
| ランダムな競合 300 通りの網羅（適用された手の種類と数） | reserve 2,854、deposit 1,501、settle 1,152、claim 803、cancel 386、owner 1,923、占領 234、枠の拒否 533、再送の無変化 5,059 | `results/contention-coverage.log` |
| デモ | 通過（assert 込み） | `results/demo.txt` |
| パッチ 0001：rules・ABI・program ホスト・カーネル（パッチ有り 38 件） | 通過 | `results/patch-0001-tests.log` |
| パッチ 0001：frontier-verify（Rust 1.95.0） | 通過 | `results/patch-0001-verify.log` |
| パッチ 0001：svm-tests のコンパイル（Rust 1.95.0） | 通過（**実行はしていない**） | `results/patch-0001-svm-check.log` |

各手で検査している不変条件（`tests/contention.rs`）：預かりの非負と保存則（C1, C2）、任意の時刻の占有 ≤ lent、Holding の lent = 貸出枠の lent ≤ 工房の棟数、精算量 ≤ 上限、受取 ≤ 精算量（二重受取なし）、預かりのホッパー・出力の残高 = 予約の帳簿、生産 = 精算量の合計・消費 = レシピ × 生産（C3、二重生産・二重消費なし）、保存・復元（Borsh）した世界が同一、再送が合計を変えない。

## 6. 文書とコードの食い違い（コードに従った）

1. **AGENTS・スキルが無い。** 指示は AGENTS と関連スキルを読むよう求めたが、リポジトリのどのブランチにも無い。
2. **工房は「回数」ではなく「連続変換」。** 設計 12・16・20・29 は工房を「動かす」施設、使用権を「1日○回」と書く。コード（`arms.rs`、`holding.rs`）は工房 1 棟が兵器 4/時を連続で作る。⑨ は「棟 × 時間」で貸す。
3. **レシピの数字。** 設計 16 の例は「鉄3と木2で兵器1」、コードは鉱石 2 と木材 1 で兵器 1。
4. **強い兵の名前。** 設計 18 は「重装兵、攻城兵」、コードは槍兵・弩兵・騎士（`TRAIN_ARMS_PER_100`）。
5. **他人の村のそばに倉を建てられる。** 設計 14 は「自分の村の土地：村の持ち主だけ建てられる」。コードの BuildVault は site のタイルそのもの以外なら、州の持ち主も距離も検査しない。0002 の材料の出入口はこのコードの挙動を前提にしている。
6. **休眠の日数が二つある。** `holding.rs` の経済の休眠は `DORMANT_AFTER`（5 日）、季節ごとの `LifecycleParams`（例：FRONTIER_7 は 3 日）は保護と土地の判定だけに使う（コードの注記どおり）。⑨ の離席方針は前者（`Holding::is_dormant`）に従う。
7. **基準 commit の位置。** 指示は `4cd901de` を共通基準と呼ぶが、`main` には無く統合候補ブランチにある。統合候補はその後 `a4fc78ca` まで進んでいる。

## 7. 未検証・限界

- **オンチェーンは何も動いていない。** 命令・口座は案（0002）。SBF ビルドと LiteSVM の実行は未実施（Agave の導入が拒否された。回避していない）。svm-tests はコンパイルまで。
- **預かりは模擬。** ⑩ の実装との接続は未確認。`JobId::tag` を預かりの鍵に使っているが衝突の可能性を排除していない（模擬の範囲）。
- **隊商は簡略化。** 地形・道・襲撃・bell 単位の到着（`SettleCaravan`）は扱っていない。デモの「到着」は `walk` の時刻を使った仮定。
- **材料なしの予約が枠を開始まで押さえる。** 開始時に 0 で終わるので枠はそこで空くが、それまでの妨害は許可の上限（`max_units`、`max_output`）でしか防げない。予約の費用は課金の禁止に従って入れていない。
- **解放の時刻。** カーネルでは呼び出し側が渡す（`Facility::release(at)`）。オンチェーンでは `LifecycleParams` から決める案（0002）で、未実装。
- **② の Grant との写し方、session 鍵で利用者の操作を許すか、CU と取引の大きさ** は未検討・未測定。
- **パッチ 0001 は版を上げていない**（lent = 0 で挙動が同じため）。版と検証器の扱いは ④ の判断。

## 8. 再現・復元

```sh
git checkout claude/elegant-bohr-co2uhr           # この担当の commit（push はしていない場合はローカル）
workstreams/09-capacity/run.sh                    # 全部（約 10 分。一時 worktree は自動で消える）
workstreams/09-capacity/run.sh --no-patch         # カーネルとデモだけ（約 1 分）
git apply workstreams/09-capacity/patches/0001-holding-lent-workshops.patch   # コアへ当てる場合（④）
```

本番ネットワークへの送信、push、merge、deploy、課金・報酬トークン・価格の追加、認証情報の設定はしていません。
