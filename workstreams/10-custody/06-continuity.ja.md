# 06 世界の継続（2026-10-31 の方針訂正）：⑩ custody の点検と対応

方針：世界は期間で終了・リセットしない。戦期は世界の寿命と別。⑩は「所有者別の預かり・輸送・引出し義務を引き継ぐ。期間の切替を没収や返却不能の理由にしない」。World／Period の定義と移行処理は④・⑧が一本化する（⑩は独自の正本を作らない）。

本文の区別：**確認した**＝実行した試験、**コードを読んだ**＝未実行、**提案**＝④・⑧の判断待ち。基準はコア候補 `workstream/10-custody-core` @ `96fe6abff2004d05967854c4edc75c10ce2af7a4`。SBF ビルドと LiteSVM は引き続き未実行。

## 1. 残っていたシーズン依存

### 1.1 ⑩自身のもの（直した）

| 依存 | 場所 | 影響 |
|---|---|---|
| モデルの「シーズン終了で凍結」 | `custody/src/model`（`running`、`end_season`、`SeasonOver`、`Whereabouts::Frozen{"season over"}`） | 期間の終わりを、預かり品が動かせなくなる理由として扱っていた |
| カーネルの `CustodyError::SeasonOver` | `custody/src/lot.rs`（カーネルは一度も返さない） | 期間を知る語彙がカーネルにあった |
| 文書の「シーズン終了で凍結」「終了後の区画を閉じるか」 | `02` §3.4、`03` §2・§5、`04` | 同上 |
| 累計の桁あふれ | `lot.rs` の `IN_TOTAL` など。rules crate は overflow 検査なしでビルドされる | 終わらない世界では累計が増え続け、最終的に**黙って巻き戻る**（wrap） |

### 1.2 コアに残るもの（④・⑧へ。⑩では直していない）

| # | 依存 | 場所（コードを読んだ） | custody への影響 |
|---|---|---|---|
| C1 | **全口座のアドレスが Season PDA から派生** | `frontier-abi/src/addr.rs:295-304`（`AddrCtx.season` と `with_seed`）。Lot は `v2::addr::lot`、作成は `proc/custody.rs` の `init_with_seed(…SeasonSigner…)` | 新しい Season を作ると、前の Season の区画・倉・隊商・Citizen に新しい命令から到達できない。**期間の切替＝新 Season** の作りのままでは「返却不能」になる |
| C2 | **プレイヤー命令は `end_bell` 以後すべて拒否** | `frontier-abi/src/prologue.rs:1067`（`now_bell >= s.end_bell` で `WrongStatus`）。custody の P 命令はすべて `hold::player` を通る（`proc/custody.rs:271,347,530,629,689,756,843,1054,1174`） | 終了後、所有者は引出し・注文の取消しができず、保管者は容量の解放ができない |
| C3 | 精算と照合は Running と Ended のみ | `proc/custody.rs:942`（SettleCustody）、`:1107`（ReconcileLot）の `season_v2(…[STATUS_RUNNING, STATUS_ENDED]…)` | CloseSeason（tombstone）後、輸送中の保管品の隊商は精算できず、宛先の予約が残る |
| C4 | **CloseCitizen が custody の義務を見ない** | `proc/citizen.rs:2447-2452`（Ended + 72 h、または tombstone で閉じられる） | 区画の所有者の Citizen が閉じると、所有者として署名できる者がいなくなり物は戻らない。保管者・運搬者の Citizen も同様 |
| C5 | CloseSeason は Vault・Caravan・Lot を閉じない | `proc/season.rs:937-956` | 期間切替を Season の作り直しにすると、custody の口座が古いアドレス空間に取り残される（rent も） |
| C6 | 鐘（bell）は Season の genesis から数える | `frontier-abi/src/prologue.rs:956-968` | 注文の `EXPIRES_BELL`、襲撃の窓、到着予定はすべて鐘。Season を作り直すと鐘が 0 に戻り、古い期限の意味が変わる。継続する一本の時計なら u32 × 600 秒で約 8 万年で、上限ではない |
| C7 | 検証器の単位がシーズン | `frontier-node/crates/verify`（入力が `season_id`・`ruleset_hash`）。V26 ガードも Season の版で FAIL／UNVERIFIABLE を分ける | 区画が期間をまたぐなら、検証も期間をまたいで状態を引き継ぐ必要がある |
| C8 | **隊商の slot id が送り手の連番の下位 16 bit** | `permutation-rules/src/frontier/caravan.rs:381-383`（`caravan_id`）。精算済みの slot は再利用されるまで id が残る（`reusable`） | 一人が 65,536 回送ると id が重なる（確認した：`caravan_slot_ids_repeat_after_65536_sends`）。SettleCaravan・SettleCustody は slot を id で探す（襲撃中かの検査を含む）ので、古い slot が新しい隊商の代わりに答えうる。リセットのない世界では到達しうる |
| C9 | 連番・世代の上限 | `Citizen.CARAVANS` u32（`proc/caravan.rs:799` の `checked_add` → 上限で送れなくなる）、Vault `GEN` u8（`proc/caravan.rs:1811` → 255 回押収されると以後押収できない）、Lot `NONCE` u32（上限で注文を出せない。引出しはできる） | 長期運用で規則が桁で変わる。区画の世代は seed に入るので GEN の拡張は Lot のアドレスも変える |

賞金・受取権・参加費：custody はどれにも関与しない（区画は得点・賞金に数えない）。旧経路の互換は⑰の範囲。

## 2. 変更した挙動（確認した）

1. **カーネル**：累計（`IN_TOTAL`・`OUT_TOTAL`・`CONSUMED`・`FORFEITED`、倉の在庫）をすべて検査つきの加算にし、限界では `CustodyError::Overflow`（プログラムでは `OVERFLOW`）で拒否する。拒否は何も変えない（精算の到着予定も消さない）。`SeasonOver` を削除。カーネルの説明に「期間はどの操作の入力でもない」と明記。ruleset の表は不変で `RULESET_HASH_V4` も不変。コアの写しは再生成して一致を確認（パッチ 0009）。
2. **モデル**：`running`・`end_season`・`SeasonOver`・「season over」凍結を削除。代わりに `World::boundary()` を置いた。これは**期間の定義ではなく**、「④・⑧が定める何らかの切替」を表す外部の出来事で、custody はこれを一切読まない。スナップショットの形式を `WYCUST02` に更新。
3. **文書**：凍結の条件から期間を外し、「終了後の区画を閉じるか」の論点を撤回した。

## 3. 試験で確認したこと

`custody/tests/continuity.rs`（6 件、すべて通過）：

| 試験 | 内容 |
|---|---|
| `a_boundary_anywhere_changes_nothing` | 預け入れ中・運搬注文の途中・襲撃が未決定・利用注文の途中消費・到着済み未精算・精算後・後始末の各段階（10 か所）で境界を入れた場合、境界＋再起動の場合、毎段階に境界を入れた場合で、終状態が**境界なしの実行とバイト単位で一致**（境界の記録を除く）。各隊商の精算はちょうど1回、消費量 40、所有者の保存則と損失の内訳も一致 |
| `a_boundary_does_not_settle_a_pending_forfeiture` | 押収後・照合前の区画は境界をまたいでも凍結のまま（境界で没収も解除もされない）。照合はその後も同じく動く |
| `orders_expire_on_their_own_bells_not_at_boundaries` | 注文は境界を何度またいでも有効で、自分の期限でだけ切れる（権利の期限と世界の寿命を分ける） |
| `a_long_run_keeps_custody_state_bounded` | 2,000 周（預け入れ→運搬→宛先から引出し→消費、50 周ごとに境界）。区画は 2 つのまま、隊商は周の間に残らず、到着予定・注文の枠は固定、保存則は毎回成立。増えるのは連番と累計だけで、上限まで十分遠い |
| `running_totals_refuse_rather_than_wrap` | `IN_TOTAL` が上限の手前で精算は `Overflow` で拒否され、世界は変わらず、所有者はなお引き出せる。`OUT_TOTAL` など他の累計は区画の保存則で `IN_TOTAL` 以下に抑えられ、到達しない（検査は防御） |
| `caravan_slot_ids_repeat_after_65536_sends` | C8 の事実の確認（④向け） |

既存の試験（abuse 12、failures 12、capacity 6、property 300 種 × 400 手と排出）はすべて通過。変異試験は「累計の巻き戻り」を足して 12 件すべて検出。コアは既定と `custody-preview` の両方で rules・ABI・プログラムの試験と clippy `-D warnings` が通過。

**境界の通過**（上の最初の3件）と**長期運用での状態の量**（4件目以降）は別々に検証した。ただしどちらもモデル上で、オンチェーンの期間切替（C1–C7）は再現していない。

## 4. 移行や仕様判断が残る点（④・⑧へ）

1. **期間切替の作り（C1・C5・C6）**：同じ Season PDA（アドレス空間と時計）の中で戦期を区切るのか、新しい口座空間へ移すのか。後者なら区画・倉・輸送中の隊商・注文を移す手順が要り、旧版の証拠を新版の証拠に読み替えない形で（区画の記録は旧空間の連鎖のまま残し、移行先で新しい連鎖を始める）。⑩としては、custody の口座を移動しない前者を推す（提案）。
2. **終了後の命令拒否（C2・C3）**：戦期の終了は、少なくとも所有者の引出し・注文の取消し・保管品の隊商の精算・照合を止めないこと。現在の `end_bell` による一律の拒否は、戦期の集計を閉じる条件と切り分ける必要がある。
3. **閉鎖（C4）**：Citizen を閉じる条件に「区画の所有者・保管者・輸送中の保管品が残っていない」を加える（Citizen の予約領域に custody の数を置くのは共有コアの変更）。
4. **隊商 id（C8）**：連番を 16 bit に切らない id（slot の 36 B に収まる形）にするか、精算時に slot を消すか。custody の到着予定は (tag, seq) を全部持つので影響しない。
5. **上限（C9）**：Vault `GEN` u8（区画の seed に入る）、`Citizen.CARAVANS` u32 の扱い。
6. **検証（C7）**：区画が期間をまたぐ場合の V26 の範囲（前の期間の終状態を入力に取る）。
7. **番号**（タグ・口座種別・記録・エラー・版）は④が②⑨⑪と照合するまで仮のまま。
8. 押収時の区画の扱い（⑩の提案、決定ではない）、⑨との接続（未接続）は [05](05-integration-review.ja.md) のとおり。
