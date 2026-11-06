# ② 他人の資源・施設を、限定した権限で使える土台

> **未採用（統合側の判断待ち）。** StockSwap は、施設がすでに作った武具を、同じ州の中で**隊商を使わずに**交換する案で、既存の物流・距離・襲撃の危険を変える。設計 20 の「使用権の札」が指す**「工房の加工能力を貸す権利」とは別の候補**であり、その代わりではない。①④⑥はこれを決定版として前提にしないこと（`HANDOFF.ja.md` §0）。

**担当：** ②（権利の検査・予約・実行・失効の契約とテスト）。
**状態：** 採用待ちの提案。**②の追加実装は止めて、統合側の判断を待っている。**
- 本体の `dispatch` を使った **host-native の検証までは完了**。
- **SBF・LiteSVM・イベントの再生への接続は未完了。**
- 採用・統合・配備はしていない。この交換を最初の権利として採用するかも、判断されていない。

**基準：** `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補。main 統合済み・CI 全成功とは扱わない）。
**作業場所：** 隔離した worktree `/home/user/wylls/.worktrees/02-rights`、ブランチ `claude/modest-wozniak-xcc7d8`。ローカル commit のみで、push していない。git の状態の変更と復元方法は [08-GIT-STATE.ja.md](08-GIT-STATE.ja.md)。

基準 commit には `AGENTS.md` と、関連する skill が**存在しない**。読んだのは `docs/DEVELOPMENT-HANDOFF.ja.md` と設計文書（20、21、22、24、26、99）。

## 担当の対応（第2回で訂正）

| 担当 | 範囲 | ②からの接続 |
|---|---|---|
| ① | 国の方針・国制度 | 国籍は権利を与えない。所有者の許可が要る |
| ③ | 公開 API・外部接続・MCP | 03 §8 |
| ④ | 複数段階の実行 | 03 §8 |
| ⑤ | AI の参加・AI staking・予算管理・手動／自動の切替 | 03 §8、05 |
| ⑥ | 作成・公開・再利用 | 03 §8、02 §5 |
| 担当未定 | 検証器・キーパー・herald（チェーンを読む側） | 06 |

## 納品物

| ファイル | 中身 |
|---|---|
| [09-PS2-VERIFIER.ja.md](09-PS2-VERIFIER.ja.md) | **第3回（隔離候補）**：PS2 記録と検証器 VR・V7、④⑧⑩⑱との番号の照合、④へのパッチ（`patches/v2/`、⑱の後に当てる adapter）、署名なしの検証 |
| [10-R4-RECONCILE.ja.md](10-R4-RECONCILE.ja.md) | **第4回（隔離候補）**：④ `77c5cbe2`・⑪ `c8d694bd`（0004・0005）を含む検証器との照合、ログ欠落・CPI・事後状態不足を PASS にしない修正（`patches/v3/`）、④への最小パッチと適用順（`patches/for-ws04/`）。ABI 番号は仮 |
| [HANDOFF.ja.md](HANDOFF.ja.md) | **引き渡しの入口**：未採用の明記、契約の参照表（実装・提案・未検証・未作成）、状態遷移、③④⑤⑥への引き渡し、統合を止める条件 |
| [01-AUDIT.ja.md](01-AUDIT.ja.md) | 現状の権限（チェーン上・外）、予算の範囲、工房の生産の進み方 |
| [02-SPEC.ja.md](02-SPEC.ja.md) | **工房在庫の交換権**の意味と定義、資源の置き場所、保存と損失の条件、①④⑥との比較、脅威モデル |
| [03-CONTRACT.ja.md](03-CONTRACT.ja.md) | アカウント・命令・エラー・取消と占領の場合分け・各担当への接続依頼 |
| [04-PROPOSALS.ja.md](04-PROPOSALS.ja.md) | 未決定：取消、容量の配分、占領と戻し先の消失、経済への影響 |
| [05-DELEGATION.ja.md](05-DELEGATION.ja.md) | 財布・セッション・Grant の権限の一覧。⑤の制限を迂回する経路。コアの委任とサーバーの委任の比較 |
| [06-EVENTS.ja.md](06-EVENTS.ja.md) | 再生できないことの再現、操作ごとに必要な情報、割当案、命令・ABI・版・既存クライアントへの影響 |
| [07-VERIFICATION.ja.md](07-VERIFICATION.ja.md) | host-native で動く検査と代替している検査、Solana で未確認の部分、SBF・LiteSVM の手順 |
| [08-GIT-STATE.ja.md](08-GIT-STATE.ja.md) | git の状態の変更前後、復元方法、push の前の調査 |
| `patches/v0/` | 第1回のパッチ（保全）：0001 コア、0002 host の実行環境 |
| `patches/v1/` | 第2回：0001 コアの提案、0002 host の実行環境とテスト、0003 検証器の再現テスト、0004 LiteSVM のテスト（未実行） |
| [run-tests.sh](run-tests.sh)、[mutate.py](mutate.py)、[tests/](tests/) | 下の表の再現 |

v1 のパッチ 0001〜0004 を基準 commit に順に当てると、このブランチのコードと同じ木になる（確認済み。手順は 07 §4）。

**このブランチの commit（基準 `4cd901d` の上。すべてローカル）：**
- 第1回（保全）：`41b4b36`（コア）、`186609c`（host の実行環境）、`924b826`（文書）
- 第2回：`a109f2e`（コアの v1 と host のテスト）、`e7165ee`（検証器・LiteSVM・Node の再現テスト）、その上に文書の commit（SHA は報告に記載）

## 第2回の変更点

1. **名前と意味：** 「WorkshopUse／利用」を「**StockSwap／工房在庫の交換**」に改めた。加工の実行と生産能力の予約ではないことを、コード・ABI・文書・テストでそろえた。在庫がないときは待機しない（失敗し、後で再試行する）。
2. **焼却をやめた：** 戻し先の村が消えた側は Grant に凍結する（`ReturnBlocked`、閉鎖不可）。資源保存の例外かつ未決定事項として分けた。
3. **再送の防止：** ReserveSwap・ExecuteSwap に `seq` を足した（`SeqMismatch`）。作り直した再送で二重に交換しない。
4. **委任：** ⑤の予算・操作制限は、セッション鍵で迂回できる。両側の最小テストで示した（05）。新しい方式は採用していない。
5. **再生：** 実際の検証器で再現した。交換は V7 で FAIL になり、Grant だけの操作は検証器から見えない（06）。
6. **プログラム版の二律背反を発見した：** 版を上げると、走っている季節の PlaceHome が止まる（06 §5）。
7. **ハーネスにランタイムの規則の近似を足した**：lamports、writable、所有者。

## テスト結果（2026-10-30、`run-tests.sh`）

| 項目 | 結果 |
|---|---|
| fmt・clippy（`permutation-frontier`、`frontier-abi`、検証器と LiteSVM の新しいテストファイル） | 通過 |
| `cargo check -p permutation-frontier --no-default-features` | 通過 |
| ABI `v2::rights`（4件） | 4 通過 |
| host の rights（35件。成功した命令ごとに、ランタイムの規則の近似も検査する） | 35 通過 |
| `permutation-frontier` と `frontier-abi` の全テスト | 通過（失敗 0） |
| 変異テスト（22種） | 22種とも検出 |
| 検証器の再現 `verify --test rights_replay`（2件） | 2 通過。交換は FAIL を再現し、対照は PASS。Grant だけの操作は PASS（見えないことの記録） |
| 代理 AI の方針の境界（Node、2件） | 2 通過 |
| LiteSVM の rights（3件） | **コンパイルだけ通過。実行していない**（program の `.so` がない） |
| SBF ビルド、svm-tests の全件 | **未実行**（Agave の導入が拒否された。回避はしていない） |
| keeper・herald・bots・wasm・web・gateway の全件 | **未実行**（変更なし） |

### 必須テストとの対応（`permutation-frontier/src/proc/rights_tests.rs`）

| 必須・追加 | テスト |
|---|---|
| 許可なし／別人／別施設／別シーズン | `no_grant_no_use`、`another_person_cannot_use_it`、`another_facility_or_station_is_refused`、`another_season_is_refused` |
| 期限切れ／取消済み／上限超過／二重使用 | `expired_…`、`revoked_grant_is_refused`、`quota_is_enforced`、`double_use_is_refused` |
| 同時要求 | `concurrent_requests_cannot_overcommit`、`parallel_reservations_cannot_take_the_same_stock_twice` |
| 古い施設世代 | `stale_facility_generation_…`、`generation_and_owner_are_each_pinned` |
| 偽の権利アカウント／直呼び | `forged_grant_accounts_are_refused`、`signers_and_flags_are_checked_on_direct_calls`、`grantee_session_from_any_client_…` |
| 予約後の取消と、未使用枠の取消 | `revoking_after_a_reservation_…`、`revoking_unused_quota_moves_nothing` |
| 予約中の通常利用 | `escrow_is_outside_every_store_during_a_reservation`（実際の Harvest と、2時間の連続生産） |
| 取消時の戻し先の容量不足 | `a_return_into_a_full_store_is_kept_above_the_cap` |
| 在庫がない場合 | `no_stock_means_no_reservation_and_no_waiting_state` |
| 占領：施設・受取口・両方・実行後 | `stale_facility_…`、`station_captured_while_reserved_…`、`both_sides_captured_…`、`after_an_executed_swap_…` |
| アカウントの閉鎖 | `a_closed_facility_keeps_the_arms_in_the_grant_…`、`a_station_that_is_gone_keeps_its_escrow_in_the_grant` |
| 再送で二重交換しない | `rebuilt_retries_do_not_swap_twice` |
| 委任の境界 | `a_live_session_votes_though_the_agent_wallet_never_offers_vote`、`a_grantee_session_also_acts_on_the_grantees_other_assets` と Node のテスト |

## 境界

- ①の国制度、独自トークン、持ち分の市場、融資、汎用的な金融は足していない。資源は倉の値のまま。
- ③④⑤⑥の実装はしていない。接続依頼だけ。
- 既存のセッションの権限は変えていない。
- push、merge、配備、実資金、追加課金、他の作業の削除はしていない。
