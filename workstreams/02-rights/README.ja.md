# ② 他人の資源・施設を、限定した権限で使える土台

**担当：** ②（権利の検査・予約・消費・失効の契約とテスト）。**状態：** 採用待ちの提案。共有仕様・main・統合ブランチには入れていない。
**基準：** `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補。main 統合済み・CI 全成功とは扱わない）。
**作業場所：** 専用の worktree・ブランチ `claude/modest-wozniak-xcc7d8`（ローカル commit のみ。push していない）。

基準 commit には `AGENTS.md` と、関連する skill（`.claude/skills/` など）が**存在しない**。読んだのは `docs/DEVELOPMENT-HANDOFF.ja.md` と、そこから参照される設計文書（20, 24, 99）。

## 納品物

| ファイル | 中身 |
|---|---|
| [01-AUDIT.ja.md](01-AUDIT.ja.md) | 現状の権限表（チェーン上・チェーン外）、予算が縛るもの、工房の生産の進み方、必要な最小のコア変更 |
| [02-SPEC.ja.md](02-SPEC.ja.md) | 最小仕様（工房の利用権1種類）、定義、不変条件、脅威モデル |
| [03-CONTRACT.ja.md](03-CONTRACT.ja.md) | Grant アカウント・命令・エラー・不変条件の契約案。③④と、チェーンを読む側・クライアント側への契約案 |
| [04-PROPOSALS.ja.md](04-PROPOSALS.ja.md) | 未決定事項：取消、容量の配分、占領時 |
| [patches/0001-…](patches/) | コアの最小差分（ABI の `v2::rights`、プログラムの `proc::rights`、dispatch の振り分け、エラーの型） |
| [patches/0002-…](patches/) | テスト専用の host 実行環境（`cfg(test)` のみ）と 24 のテスト |
| [run-tests.sh](run-tests.sh) | 下の表を再現するコマンド |

パッチは基準 commit に `git apply` で当たり、ブランチの commit `186609c` と同じ木になる（確認済み）。

## どこまで実証したか

**実証した（host 上で、WYLLS 本体のプログラムのコードを通して）：**
所有者の鍵を使わずに、利用者が自分の財布、または自分のセッションで、許可の範囲内だけ施設を使える。範囲の外（別人・別施設・別季節・期限切れ・取消済み・上限超過・二重使用・古い世代・偽の権利アカウント・直接の生の命令）は、プログラムが拒否する。

テストが通したのは、本体の `permutation_frontier::dispatch` そのもの。その中で次の本物のコードが動く。
- 命令の振り分け
- プレイヤー前処理：署名、セッション、季節 PDA・状態・ruleset、Citizen の正規アドレス、行動バケツ
- 村のカーネル（settle、pay、credit）と、アカウントの書き込み
- 占領ロック
- SetSession（既存の命令）

単独の模擬プログラムではない。

**実証していない（重要）：**
- **SBF ビルドと LiteSVM では動かしていない。** この環境では、Agave 3.1.9（`cargo-build-sbf`）の導入を、権限の判定が拒否した。LiteSVM の svm-tests は実行していない。そのため、次は未確認。
  - SBF 上での挙動、計算量（CU）、取引の大きさ（1,232 B）、アカウントのロード上限
  - `build-frontier.sh` の検査（e_flags、overflow checks、再配置）
- host では、System プログラムの CPI と Clock/Rent を `cfg(test)` の差し替え（`host_test.rs`）で動かしている。差し替えは、署名・PDA の seed・with-seed アドレスを検査する。ただし本物のランタイムではない。取引の原子性は、テストの側で巻き戻して再現している。
- 季節・Citizen・村・州は、テストが直接書いた。Join・Build などの命令では作っていない。**占領は、世代と所有者と州の写しを書き換えて模した**。攻城から SettleCapture までの本物の経路は通していない。
- 検証器・キーパー・herald・relay・MCP・Web は、変更も実行もしていない。**PS2 の記録の種類がないため、v0 の命令は今の検証器と矛盾するはず**（03 §8.3）。配備の前提条件。
- 国（①）・公開命令と CPI（③）・複数段階（④）との結合は、契約案だけ。

## テスト結果（`run-tests.sh`、2026-10-29、基準 + パッチ 0001・0002）

| 項目 | 結果 |
|---|---|
| `cargo fmt --all -- --check` | 通過 |
| `cargo clippy -p permutation-frontier -p frontier-abi --all-targets -D warnings` | 通過 |
| `cargo check -p permutation-frontier --no-default-features` | 通過 |
| `frontier-abi` の `v2::rights`（4件：tag とコードの非衝突、seed、data の往復、枠と条件） | 4 通過 |
| `permutation-frontier` の `proc::rights`（24件、下の表） | 24 通過 |
| 両 crate の全テスト（既存の回帰確認） | 通過（permutation-frontier 118、frontier-abi 91 と結合テスト群。失敗 0） |
| 変異テスト（`mutate.py`。安全の検査を1つずつ外し、テストが落ちるかを見る。18種） | 18 種とも検出（最初の実行で2種が生き残った。世代の固定と所有者の固定が、テストで分かれていなかった。テストを足して検出） |
| SBF ビルド、LiteSVM、svm-tests | **未実行**（ツールの導入が拒否された） |
| permutation-rules、frontier-node、frontier-wasm、gateway、web | **未実行**（変更なし。rules カーネルは無変更なので、ruleset hash も不変） |

### 必須テストとの対応

| 必須 | テスト（`permutation-frontier/src/proc/rights_tests.rs`） | 期待どおりの拒否 |
|---|---|---|
| 許可なし | `no_grant_no_use` | `BadGrant`、同じ国の C も `NotGrantee`、所有者でない者の発行は `NotOwner` |
| 別人 | `another_person_cannot_use_it` | `NotGrantee`、他人の Citizen を名指しすると `Auth`、発行者自身も `Auth` |
| 別施設 | `another_facility_or_station_is_refused` | `BadGrant`（施設・受取口）、`BadAddress`（州） |
| 別シーズン | `another_season_is_refused` | `BadGrant`（アカウントそのもの／正規アドレスへの複製／季節 id だけが違う場合）。対照：id を合わせると通る |
| 期限切れ | `expired_grant_is_refused_and_its_reservation_can_be_released_by_anyone` | `Expired`。期限後は第三者が解放でき、量は正確 |
| 取消済み | `revoked_grant_is_refused` | `Revoked`。発行者以外の取消は `NotGrantee`／`Auth` |
| 上限超過 | `quota_is_enforced` | `QuotaExceeded`（数量・回数・0） |
| 二重使用 | `double_use_is_refused` | `NoReservation`。倉は変わらない |
| 同時要求 | `concurrent_requests_cannot_overcommit` | `ReservationOpen`、続けて `QuotaExceeded`。財布とセッションは同じ枠を使う |
| 古い施設世代 | `stale_facility_generation_is_refused_and_its_escrow_follows_the_capture`、`generation_and_owner_are_each_pinned` | 決着前は `CapturePending`。決着後は `StaleHolding`（世代だけ、所有者だけ、受取口側の場合も） |
| 偽の権利アカウント | `forged_grant_accounts_are_refused` | `BadGrant`（他プログラム所有、別アドレス、上限の書換え、別種のアカウント、grantee の書換え） |
| 別クライアントからの直呼び | `signers_and_flags_are_checked_on_direct_calls`、`another_person_cannot_use_it`、`grantee_session_from_any_client_works_within_the_grant` | 未署名は `Auth`、読取専用の Grant は `BadAccount`、足りないアカウントは `TooManyAccounts`、壊れた data は `BadData`。利用者のセッションは、どのクライアントからでも範囲内で通る。期限切れのセッションは `SessionExpired` |
| 予約した後の取消 | `revoking_after_a_reservation_returns_both_sides_and_keeps_what_was_consumed` | 予約は両側とも戻り、消費済みは戻らない |
| 未使用枠の取消 | `revoking_unused_quota_moves_nothing` | 村の倉は1バイトも変わらない |
| （追加）正当な利用 | `legitimate_use_moves_exactly_the_terms_and_no_key` | 量が正確。資源ごとの合計が保存される。施設の所有者と `LAST_OWNER_ACTION` は変わらない |
| （追加）発行は財布だけ | `issuing_needs_the_issuers_wallet_not_its_session` | `WalletRequired` |
| （追加）不足時の原子性 | `shortfalls_move_nothing` | `Insufficient`。何も動かない |
| （追加）消えた受取口 | `a_station_that_is_gone_loses_its_escrowed_inputs_and_nothing_else` | 施設側だけ戻る |
| （追加）発行の検査 | `issue_terms_and_places_are_checked` | `NoWorkshop`、`BadStation`、`BadTerms`、`BadAddress`、同じ nonce は `BadGrant` |
| （追加）後始末 | `close_returns_rent_only_when_nothing_is_escrowed_or_usable` | `StillLive`。賃料は `RENT_TO` だけへ |
| （追加）実行環境の確認 | `harness_runs_a_real_instruction_set_session` | 既存の SetSession が本物の経路で動く。セッションによる更新は `Auth` |

## 境界（やっていないこと）

- ①の国の制度、独自トークン、持ち分の市場、融資、汎用的な金融の仕組みは足していない。ゲーム内の資源は、倉の値のまま（SPL トークンにしていない）。
- ③の公開命令・CPI、④の複数段階の実行は作っていない。契約案だけを 03 §8 に置いた。
- push、main への merge、配備、実資金の利用、追加の課金、他の作業の削除はしていない。主 checkout（`/home/user/wylls`）は、ブランチを外して同じ commit `9214293` の detached HEAD にした。ファイルは変えていない。ブランチ `claude/modest-wozniak-xcc7d8` は、`9214293`（= main。この branch に固有の commit はなかった）から基準 commit へ付け替えた。worktree の置き場所 `.worktrees/` は `.git/info/exclude` に足した。

## 再現

```sh
git apply workstreams/02-rights/patches/0001-*.patch workstreams/02-rights/patches/0002-*.patch   # 基準 commit の上で
workstreams/02-rights/run-tests.sh
```
