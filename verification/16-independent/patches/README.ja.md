# 修正候補パッチ（⑯。**本体へは未適用**）

各パッチは基点 `4cd901de`（= `main` `92142932`）の tree に `git apply` できる独立した差分。隔離した git worktree で適用し、⑯ の再現テストが通ること、関係する既存スイートが通ることを確認した（結果: `../logs/`）。採否は各担当の判断。設計上の決定を含むものは「判断を要する点」に明記する。

| パッチ | 対象（担当） | 直す不具合 | 検証に使った試験 | 既存試験への影響 | 判断を要する点 |
|---|---|---|---|---|---|
| `P1-verify-unknown-tag-and-cpi-shape.patch` | `frontier-node/crates/verify`（⑦⑪の領域） | X2: ABI 表に無い／予約されたタグの着地命令が PASS になる。A8: CPI 形が WARN 止まり。**P1b**（同梱）: 番号だけ既知で判定の無いタグ（SetSession, SetVigil, FastForward, CloseMarch, FoldOccupancy, CloseCitizen/CloseHolding, 季のライフサイクル命令）の着地を WARN `UnjudgedInstruction` で報告に出す | `v16_unknown_tag.rs`（X2, X2b, X2c, A8 が通る。control は PASS のまま） | `cargo test -p verify` 全件（`../logs/wt-fix-verify.log`） | CPI 形を `MissingData`（Unverifiable）にした。③の 0002（inner instruction を archive に入れる）が入るまでの暫定。未知タグは FAIL `UnknownInstruction`（新コード） |
| `P2-herald-caravan-holder-and-wear.patch` | `frontier-node/crates/herald`（⑦の領域） | A1: TAKE 後の feed が持ち主を示さない。A1c: 再 SENT が `raided` を false に戻す。C2: `worn_bps` を落とす | `v16_caravan_holder.rs`（4 件とも通る） | `cq_fold`・`fold` 通過 | feed に `holderTag`（TAKE の raider_tag）と `wornBps` を**追加**するだけ。`ownerTag` は口座シードなので変えない |
| `P3-web-caravan-holder.patch` | `permutation-server/web/frontier`（⑦の画面側） | A1/A1b: 画面の「自分の隊商」判定が ownerTag のみ | `v16-web-caravan-holder.test.mjs`（A1, A1b） | `web-frontier-s1.test.mjs` の期待値に `holderTag: null, wornBps: null` を追加（同梱） | `holderTag ?? ownerTag` を持ち主とみなす。古い herald（holderTag なし）とは後方互換 |
| `P4-gateway-idempotency-keep-sent.patch` | `permutation-gateway/src/frontier/agent/ledger.mjs`（④⑤の代役である基点 runner/gateway） | B1/X5: 2,000 件超で古い冪等記録が消え、同じ key の再送が再送信になる | `v16-agent-wallet-replay.test.mjs`（B1 が通る） | `agent-wallet-*.test.mjs` 全件通過 | 上限超過時は **refused の記録だけ**古い順に削る。sent/failed は無期限に保持（送信 1 件につき 1 エントリ。relay の 1 日の quota で有界） |
| `P5-web-foreign-session-key.patch` | `permutation-server/web/frontier/fdelegation.mjs`（Web）＋既存試験 1 行 | A7/B5: session 枠を③ courier 等の別鍵が持つとき、画面が「鍵を作り直す」（黙って委任解除）を提示 | `v16-web-caravan-holder.test.mjs`（A7） | `web-frontier-delegation.test.mjs` 21 行目の期待値を更新、`lang/en-frontier.mjs` に英訳 6 件を追加（同梱。`web-lang.test.mjs` の完全性検査が要求）。それ以外通過 | **設計判断**: 既存試験は「別の鍵 → 通常カード」を意図して固定していた。③の委任を採用するなら必要。文言は仮 |
| `P6-web-wallet-switch-follows.patch` | `permutation-server/web/frontier/controller.mjs`（Web） | C3: ウォレット内のアカウント切替後も旧アカウントとして表示・署名 | 自動再現なし（`v16-web-wallet-switch.test.mjs` は controller の 2 行の**模擬**） | `web-frontier-controller.test.mjs` ほか通過 | 切替を再接続として扱い、Citizen・鍵・画面を読み直す。実ブラウザでの確認が必要 |

| `P7-x402-lost-response-recovery.patch` | `permutation-gateway/src/frontier/routes/prize.mjs`（⑰、旧経路の互換性）＋既存試験 1 箇所 | T17-2: 応答喪失後の同一再送が 409 Duplicate だけ。T17-3: 504 後の再試行が 402 AlreadyPaid（本人は参加済み）。**P8**（同じファイル末尾のハンク）: Claim 後に Entry を読めないと金額 "0" | `v16-x402-settlement.test.mjs`（T17-2, T17-3, T17-5 が通る） | `frontier-prize.test.mjs` の「同じバイト列は拒否」の期待値を「200 で決済済みの取引を返す」に更新（同梱）。ほか通過 | 同一バイト列の記憶はプロセス内（relay の replay cache と同じ寿命）。再起動後は Entry と Citizen の存在で `mode: settled` を返す。x402 の facilitator 慣行（同じ支払いの再送は同じ結果）に寄せた |
| `P9-prototype-crank-undelegation-order.patch` | `permutation-gateway/src/crank.mjs`（⑲、**旧 prototype**。Frontier 再構築に MagicBlock の配線は無い） | T19-1: 解除 intent の順序（国→州）がプログラムの `undelegation_order`（州 1..19→国→州 0）と逆で、最初の intent が `UndelegationOrder` で拒否される | `v16-public-ops.test.mjs`（T19-1 が通る） | `crank.test.mjs` の期待値を更新（同梱） | 旧 prototype の保守に限る。再起動時の `meta.undelegated` 再同期は別途（未修正） |
| `P10-docs-reveal-timing-wording.patch` | `README.md`（⑦⑱） | T18-1: 「到着ターンが終わるまで秘匿」は実装（所有者は到着ターン開始時に自己 Reveal、M1 契約の仕様）と食い違う | 文書のみ。T18-1 は挙動の記録として残る | なし | 文言案。所有者の確認が要る |

| `P11-keeper-no-reveal-before-arrival-turn.patch` | `frontier-node/crates/keeper`（⑱、keeper の受付と Reveal 担当）＋既存試験 1 件 | T18-2: 到着ターン開始前の所有者平文を `202` で受理し、Reveal 書込みに時刻の下限が無い | `keeper/tests/v16_early_reveal.rs`（通る） | `reveal_accept_over_localnet` を「早期は 425 TooEarly、開始後に 202」に調整（同梱）。keeper 全試験通過 | **秘匿性の修正ではない**（④の照合: ターン開始後・T(arrive) 公開の約 593 秒前の送信と、anchor 無しの送信には効かない）。受付の下限の一案。採否と位置（ターン開始か drand 公開時か）は所有者の判断。秘匿性は⑱の条件（確認済み anchor と検証済み T(arrive) 署名）による |
| `P12-keeper-count-every-landed-version-fee.patch` | `frontier-node/crates/keeper/src/engine.rs`（④共有コア、⑰の費用照合） | T18-3: 書込み終了後に着地した版（AlreadyDone 含む）の手数料を `fees_charged` に数えない | `keeper/tests/v16_reveal_versions_fees.rs`（通る） | keeper 全試験 81 件通過。④の Reveal 試験 v4 でも集計がチェーンと一致（④ commit `88cc131d`） | 勝者でなく先に判定された AlreadyDone 版が `Landed` に記録される点（journal の正確さ）は未修正・未検証 |

適用順は任意（互いに独立）。P2 と P3 は組で意味を持つ（feed に holderTag が無ければ P3 は何も変えない）。

## 適用していない理由

指示どおり、他担当の本体へ勝手に取り込まない。本ブランチ（`claude/dreamy-ramanujan-ijj8qj`）には試験・文書・パッチファイルだけを置き、本体コードは基点のまま。
