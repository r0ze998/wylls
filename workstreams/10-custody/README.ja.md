# ⑩ 所有権を保った保管・輸送・利用（custody）

作業日 2026-10-30。基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（統合候補 `integrate/claude-consolidation-20261029` の中。`main` の `921429322d5aecd1a3df0dd8d82c405c87dd985a` を含む）。この担当の成果物はこのディレクトリと、コアへの差分案 [patches/](patches/) です。**このブランチ自体はコアを一行も変えていません。** push・merge・deploy はしていません。

> **状態（2026-10-30、統合前の指摘への回答後）。** 所有者別の区画と、一般在庫から分離した保管・運搬の最小基盤（カーネル・モデル・ホストでの差分）はできている。**オンチェーンでの完成ではない**：SBF ビルド・LiteSVM・V26 本体がない。コア候補は `workstream/10-custody-core` @ `96fe6abff2004d05967854c4edc75c10ce2af7a4`（前回の `823bb71d`・`385b623f` を置き換える。差は [05](05-integration-review.ja.md) と [patches/](patches/)）。custody は別版のプログラム（`custody-preview`、`RULESET_HASH_V4`、版 5、配備用として拒否されるマーカー付き）だけで動く。

> **2026-10-31 方針訂正（世界は終わらない）への対応**：[06-continuity.ja.md](06-continuity.ja.md)。custody 自身からシーズン終了の前提を除き（凍結の条件、カーネルの語彙、累計の桁あふれ）、期間の境界をまたぐ通し試験と長期運用の試験を足した。コアに残るシーズン依存（アドレス空間、`end_bell` での命令拒否、閉鎖、隊商 id など）は④・⑧へ。コア候補は `96fe6abff2004d05967854c4edc75c10ce2af7a4`。

> **2026-11-05 ⑨との接続と V26 の再判定**：[08-adapter-09.ja.md](08-adapter-09.ja.md)（⑨の `Custody` を⑩の区画で実装したアダプター `adapter-09/` と、⑨自身の `Harness` を動かす契約試験。⑨と⑩本体のコードは変えていない）と [09-v26-state.ja.md](09-v26-state.ja.md)（core 差分 0010：custody シーズンの口座の再判定。証拠不足は PASS にしない）。本体 `3aef9673`・core `96fe6abf` はそのまま保持し、このブランチ `workstream/10-custody-adapter` は④の統合候補 `d0949fd4` を基点にしている。

> **2026-11-07**：core 0001–0013 を④の統合候補 `c1e8137e` の上で実際に当て、割当 rev 4 の番号（tag 0xC2–0xCC、記録 105–113、エラー 100–104）に合わせた [14-core-on-candidate-rev4.ja.md](14-core-on-candidate-rev4.ja.md)、差分 [patches-r4/](patches-r4/)（⑧との番号の衝突を解消。検証器の名前 V26 の重なりは④の判断）。

> **2026-11-06（3）**：⑨ `06c817cc`（⑩の差分を取り込み済み）との T5 の解消 [13-t5-and-v26-replay.ja.md](13-t5-and-v26-replay.ja.md)：アダプターの `connect` を削除し、単一の区画表の試験を⑨自身の bridge10 の上へ（`adapter-09/with-bridge10`）。V26 は注文の帳簿の再生（core `1624d14a`、patch 0013。core は先端に適用せず別の親として保存）。⑨への差分 `patches-to-09/0002`（pin の更新だけ）。

> **2026-11-06（2）**：⑨の最新 `a24defcf` との照合 [12-connect-09-a24defcf.ja.md](12-connect-09-a24defcf.ja.md)。本人の区画と利用注文の区画を一つの表に、使わなかった鉱石は `return_unused` で消費を戻す（入庫に二重に数えない）、端数は預かりの中の未返却、⑨への差分 [patches-to-09/](patches-to-09/)、V26 の履歴の検査（core `38a273a9`、patch 0012。core は担当ブランチの先端には適用せず、別の親として保存）。

> **2026-11-06**：⑨の `992f4ba5`（bridge10）との照合と揃え [10-adapter-bridge.ja.md](10-adapter-bridge.ja.md)（自分の区画と他人の区画の利用注文を一つの区画の置き場に、bridge10 との差分試験）、V26 の続き（core `5bb79786` を起点に 0011、⑱と組み合わせてビルド）[09](09-v26-state.ja.md) §7、④への ABI 番号の依頼 [11-abi-request-04.ja.md](11-abi-request-04.ja.md)。

> **読み方。** 「確認した」は実行して確かめたこと、「コードを読んだ」は未実行、「提案」は判断待ち。[04-results.ja.md](04-results.ja.md) に実行したもの・していないものを分けて書いています。

## 結論

| 求められたこと | 判定 | 根拠 |
|---|---|---|
| 所有者・保管者・運搬者・利用者・所在を分ける | **できた（カーネル、モデル、プログラム差分）** | 区画（Lot）口座が所有者と所在を、倉の持ち主が保管者を、隊商の持ち主と国が運搬者を、注文の受け手が利用者を持つ（[02](02-contract.ja.md) §1） |
| 預けた物が保管者の通常在庫・生産・売却・別の貸出に混ざらない | **確認した（モデル）** | 区画は倉の `STORES` と別の口座。S1 の SendCaravan・配達・CloseVault は `STORES` しか読まない。保管者の売り送り・注文・発送・消費・倉を閉じる・容量の二重約束はすべて拒否（`tests/abuse.rs`）。乱択試験で「区画の量は所有者か範囲内の受け手か押収以外では減らない」「倉の一般在庫は配達か没収でしか増えない」を各段階で確認 |
| 二重確保できない・予約と消費を分ける | **確認した（モデル）** | 注文＝予約（利用可能＝保管−予約）、発送・消費＝実物の移動。到着予定も出発時に容量を予約 |
| 各段階で権限と所有者を原子的に検査 | **確認した（モデル）／コンパイル確認（プログラム）** | 命令ごとにカーネルを一度呼び、失敗なら何も書かない。モデルでは「拒否は世界を一切変えない」を全段階で検査 |
| 再送・再起動・並行・容量超過・宛先消失・占領・略奪・途中退出・権限取消 | **確認した（モデル）** | `tests/failures.rs`、`tests/abuse.rs`、`tests/property.rs`（300 種 × 400 手、別に 3,000 種でも実行） |
| 略奪・占領と採用ルールの衝突を明記 | **明記した** | [03-rules-and-conflicts.ja.md](03-rules-and-conflicts.ja.md)。安全な倉庫の例外は足していない |
| 不明・凍結・損失確定の区別 | **できた** | `World::whereabouts`、`LOT_LOSS` の原因 5 種 |
| 最小デモ | **動く（モデル上）** | `cargo run --example demo`（[results/demo.log](results/demo.log)） |
| ⑨・④への引き渡し（形式・状態遷移・署名・保存則・イベント） | **書いた** | [02-contract.ja.md](02-contract.ja.md) |
| 独立パッチでの実装 | **コンパイルとネイティブ試験まで** | [patches/](patches/) 9 件：rules・ABI・プログラム・オフチェーン・版の分離・検証器ガード・消費側の修正・説明の訂正・累計の検査。**SBF ビルドと LiteSVM は実行していない**（Agave の導入は許可されていない） |
| 版：custody が v3 を名乗らない | **差分で分離した** | 既定ビルドは V3・版 4 で custody タグを拒否、custody は `custody-preview`（V4・版 5）だけ（[05](05-integration-review.ja.md) §1） |
| 検証器：未対応の痕跡を PASS にしない | **ガードを足した（本体はまだ）** | 修正前は偽の custody 命令が PASS だった。今は FAIL（custody のないシーズン）／UNVERIFIABLE（custody シーズン）（[05](05-integration-review.ja.md) §2） |
| 宛先容量の予約 | **一般在庫を書く経路が今の3つである限り保証。配達は保証しない** | 競合・解放の試験と不変条件（[05](05-integration-review.ja.md) §3） |
| ⑨との接続 | **アダプターと契約試験（モデル）** | ⑨の trait を⑩の区画で実装。材料利用・加工中の返却予約・返却と完了の通知を照合し、重複・再起動でも二重消費・二重返却・予約の解放漏れなし（[08](08-adapter-09.ja.md)）。成果物の所有者・多資源・押収は未決のまま |

**名前を画面で変えるだけの模擬ではない**ことの根拠：保管者が使える命令の経路そのものが区画に届かない（口座が別）こと、そして実装の誤りを11種わざと入れると試験が必ず落ちること（[04](04-results.ja.md) §1.2）。

**利用者向けには二つを分けて説明する**（[05](05-integration-review.ja.md) §4.5）：保管者は仕組みとして区画に手を出せない／戦闘（略奪・倉の押収）ではゲームの規則で持ち主が変わる（押収の扱いは⑩の提案で決定待ち）。

## 成果物の地図

| パス | 内容 |
|---|---|
| [01-research.ja.md](01-research.ja.md) | 既存 OSS（TigerBeetle の二段階振替、SPL Token の委任と凍結、EVE Frontier の Storage Unit、Eternum の承認と受け取り）の比較と採った形 |
| [02-contract.ja.md](02-contract.ja.md) | **⑨・④への引き渡し**：データ形式、状態遷移、署名、保存則、イベント、命令、エラー、⑨の接続点 |
| [03-rules-and-conflicts.ja.md](03-rules-and-conflicts.ja.md) | 略奪・占領・障害で所有権がどう変わるか、採用ルールとの衝突、足さなかった例外、判断待ち |
| [04-results.ja.md](04-results.ja.md) | 実行した試験・していない試験、変異試験、測っていないもの |
| [08-adapter-09.ja.md](08-adapter-09.ja.md) | **⑨との接続（2026-11-05）**：アダプター、双方の入出力、食い違い、試験 |
| [09-v26-state.ja.md](09-v26-state.ja.md) | **V26 の再判定（2026-11-05）**：口座だけで決まる法則の再判定、⑱の V0 との関係、回帰試験 |
| [10-adapter-bridge.ja.md](10-adapter-bridge.ja.md) | **⑨ bridge10 との照合（2026-11-06）**：揃えた点・合わなかった点、差分試験、所有と押収の問い |
| [12-connect-09-a24defcf.ja.md](12-connect-09-a24defcf.ja.md) | **⑨ `a24defcf` との照合（2026-11-06）**：一つの区画表、返却・端数・二重計上、⑨への差分、V26 の履歴 |
| [13-t5-and-v26-replay.ja.md](13-t5-and-v26-replay.ja.md) | **T5 と V26 の再生（2026-11-06）**：`connect` の削除、⑨ bridge10 の上の試験、注文の帳簿の再生、⑨・④への差分 |
| [14-core-on-candidate-rev4.ja.md](14-core-on-candidate-rev4.ja.md) | **core を統合候補と rev 4 へ（2026-11-07）**：適用順、試験、⑧との衝突、未決事項 |
| [patches-r4/](patches-r4/) | ④の統合候補 `c1e8137e` に当てる core の差分 0001–0014 |
| [patches-to-09/](patches-to-09/) | ⑨の `a24defcf` に当てる差分（`git am`）と、当てた上での⑨の `run.sh` のログ |
| [11-abi-request-04.ja.md](11-abi-request-04.ja.md) | **④への依頼（2026-11-06）**：ABI 番号と版の衝突（統合候補でエラー 94 が埋まった）と決めてほしいこと |
| [adapter-09/](adapter-09/) | crate `wylls-custody-adapter-09`（独立 workspace）：⑨の `Custody` の実装と契約試験 |
| [07-handoff-status.ja.md](07-handoff-status.ja.md) | **引き渡しの現状（2026-11-03）**：ABI 番号の衝突一覧（⑧と tag 0xC1・記録 104・error 94）、V4・V26・⑨接続の修正済み／未解決／仕様判断待ち |
| [06-continuity.ja.md](06-continuity.ja.md) | **世界の継続**：残っていたシーズン依存、変更した挙動、境界・長期の試験、④・⑧への論点 |
| [05-integration-review.ja.md](05-integration-review.ja.md) | **統合前の4点**：版の対応、検証器、容量予約の範囲と限界、⑨との照合と押収の扱いの分け方 |
| [custody/](custody/) | crate `wylls-custody`（独立 workspace）：`src/lot.rs`・`src/layout.rs` がカーネル（`no_std`）、`src/model/` がプログラムの口座と S1 命令のモデル、`examples/demo.rs`、`tests/` |
| [scripts/core-kernel.py](scripts/core-kernel.py) | カーネルからコア用の `permutation-rules/src/frontier/custody.rs` を作る／一致を確かめる |
| [patches/](patches/) | コアへの差分（`git format-patch`、4cd901de に順に当たる）と説明 |
| [results/](results/) | この作業機での実行ログ |
| [run.sh](run.sh) | 全部を実行し、`results/` を書き直す |

## 実行手順

前提：Rust 1.89.0（`custody/rust-toolchain.toml`）。ネットワークは crates.io からの依存取得だけ。

```sh
workstreams/10-custody/run.sh            # fmt・clippy・試験・デモ・変異試験・コア写しの一致
cd workstreams/10-custody/custody
cargo run --example demo                 # デモ
CUSTODY_SEEDS=3000 cargo test --release --test property   # 乱択試験を増やす
```

コア差分の適用と確認（4cd901de の上で）：

```sh
git checkout -b try-custody 4cd901de
git am workstreams/10-custody/patches/*.patch
cargo test -p permutation-rules -p frontier-abi -p permutation-frontier
cargo test -p permutation-frontier --features custody-preview
(cd frontier-node && cargo test --locked -p fclient -p herald -p verify -p keeper)   # Rust 1.95.0
```

## 担当の境界

- ⑨の加工は作っていない（消費までを保証し、できた物の持ち主は⑨の決定。[02](02-contract.ja.md) §7）。
- NFT・市場・通貨・保険・貸付・担保・手数料市場は足していない。資源は鉱石だけ。
- 既存ブランチの reset、push、merge、deploy、鍵の設定、外部公開はしていない。コアの変更は [patches/](patches/) の差分で④に渡す。

<a id="食い違い"></a>
## ドキュメントとコードの食い違い（見つけたもの）

コードの書き方に従い、ドキュメントは直していません（④の判断）。

1. `S1-1B-CONTRACT.md` §1.2：Caravan の `STATE 3 lost` を「cargo burned or the destination gone」とするが、コード（`settle_raid`）では焼かれた隊商は `STATE_MOVING` のまま空で進み、SettleCaravan で `STATE_DELIVERED`（積荷 0）になる。`STATE_LOST` は宛先が消えたときだけ。
2. `S1-1B-CONTRACT.md` §3 の見出し「Instructions (tags 0xB0–0xB7)」：1b の命令は 0xB0–0xB6（0xB7 は 1d の BuildStructure）。
3. `S1-1B-CONTRACT.md` §3.4 と `settle_caravan`：倉への配達で `CAP` を超えた分は捨てられるが、`CARAVAN_SETTLED` は積荷の全量を記録し、捨てた量はどこにも記録されない（ドキュメントは「any excess lost」とだけ書く）。
4. `frontier-abi/src/v2/error.rs` 冒頭：「62–78 (MC) and 79–86 (S1, 1b)」だが S1 の番号は 93 まである。同じファイルの `all_codes` の説明は「S1's 79–90」。
5. `permutation-frontier/src/events.rs`：`WIDTHS_V2` の説明が「CQ_SPECS for 80–88」だが、表は 103（REST）まで覆う。
6. `permutation-frontier/src/proc/mod.rs` 冒頭の担当表は M1 の wave の分だけで、`caravan.rs`・`conquest.rs`・`structure.rs`・`nation.rs` がない。
7. 決定ログ 2026-10-23 の「襲う側は『運べる量まで奪う』か『全部焼く』を選ぶ」（[18](../../docs/design/redesign/18-stage1-play.ja.md) 8・9章）は、同じ日の J2（隊商ごと奪う、運べる量の上限なし）とコードで置き換わっている。決定ログ上は両方が「採用」のまま並ぶ。
