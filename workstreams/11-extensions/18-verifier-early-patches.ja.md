# 18 検証器のパッチを先に入れる: main での照合と残りの穴（2026-11-18）

**対象。** `origin/main` `0b7c8dd6`（PR #41 のマージ後）。ブランチ `grok/ws11-verifier-patches`。

**決定。** ⑪ = (b) 宣言型の効果。ただし拡張そのものは最初に遊べる devnet の後。検証器のパッチ 0001・0003 は先に入れる（2026-11-18、r0ze）。この PR は拡張と宣言型の効果に手を付けない。

**方針。** 知らないもの・証明できないものは UNVERIFIABLE（PASS にしない）。正しい記録を FAIL にしない。0001 は [12](12-verifier-r5.ja.md) のとおり再適用しない（知らないタグは⑱の V0 が正。r13 以降は「知っている版の下だけ FAIL、それ以外は UNVERIFIABLE」）。

## 1. パッチごとの状態（main）

「塞がっている」は、その守りを main のコードで 1 つ外すと既存の試験が落ちることで確かめた（変異 M1〜M8、ログは `~/Projects/wylls-grok-state/evidence/ws11-verifier-patches/mutations.log`）。

| パッチ | 穴 | main での状態 | 場所（commit） | 変異で落ちる試験 |
|---|---|---|---|---|
| 0001（知らないタグ） | 知らないタグの命令が PASS | **置き換え済み**（⑱の V0。知っている版で FAIL `UnknownInstruction`、知らない版・版不明で UNVERIFIABLE `UnverifiedInstruction`） | `checks/v0_coverage.rs` `judge_outside_v2`（⑱、0010・0013 で版の条件） | M1: `coverage::an_unknown_tag_fails` |
| 0001（CPI） | CPI で呼ばれた Frontier が PASS | **置き換え済み**（V0E `UnverifiedInnerInstruction`） | `checks/v0_evidence.rs`（0004、`e401158a`） | M2: `evidence::the_program_run_by_another_program_is_not_a_pass` |
| 0003 | Holding の post-state の欠落が PASS | **適用済み**（V7 `MissingData`: 既知の Holding の書込に post-state が無い、前の post-state が無い、archive に post-state が無い） | `checks/v7_replay.rs` 854〜895、1023 行 | M3a・M3b: `missing_state` の 2 件 |
| 0004 | ログ無し・切れたログ・Holding 以外の post-state | 適用済み（V0E `MissingLogs`、`TruncatedLogs`、`MissingPostState`） | `e401158a` | M4・M5・M7 |
| 0005 | CPI だけでログ無し、印なしで失われた末尾 | 適用済み（`IncompleteLogs` など） | `e401158a` | M4・M6 |
| 0006 | 0004＋0005＋r7 を 1 つにしたもの | **使われていない**（main は 0004 → 0005 → 0007 の経路。中身は同じ） | — | — |
| 0007 | 判定されない記録 | 適用済み（`UnverifiedRecord`） | `4c65aaa2` | M8: `new_bands::a_resident_joined_without_its_join_is_unverifiable` |
| 0008 | kind 130 は JoinResident の横だけ | 適用済み | `a11c86cc` | M8 |
| 0009 | V27 JoinResident | 適用済み | `7227a003` | （既存の v27 の試験） |
| 0010 | 割当てタグの偽造は知っている版だけ | 適用済み | `30bfb119` | （`new_bands::tags_outside_abi_v2_are_told_apart`） |
| 0011 | V27 の正規アドレス | 適用済み | `57c5c171`、`3c6d2b6b` | （既存） |
| 0012 | custody のタグと kind | 適用済み | `6cd6dd14` | （既存） |
| 0013・0014 | V0 の偽造は知っている版だけ、ResidentAct は V28 | 適用済み | `2bd74426` | （既存） |
| 0015 | S1 の口座の post-state | 適用済み | `f3339c68` | M7: `a_written_s1_account_without_its_post_state_is_not_a_pass` |
| 0016 | wide のタグは VW | 適用済み | `af41e617` | （既存） |
| 0017 | V27 の join bell | 適用済み（パッチの本文はこのディレクトリに無い） | `3e617b28` | （既存） |

## 2. main に残っていた穴（この PR で直した）

まず改変した fixture で落ちる試験を書き、main のコードで落ちることを確かめてから直した（ログ `evidence-before-fix.log`、`unknown-accounts-before-fix.log`）。

| # | 穴 | main での結果 | 直したこと | 試験 |
|---|---|---|---|---|
| H1 | V0E の `MissingPostState` が ABI v2 の 23 種（`AccountKind`）の口座だけを見る。resident policy・link、Grant、wide の口座、後の build の形式の post-state を落としても V0E は何も言わない | 7 形式すべてで V0E の所見なし（M1 の land では VR の `UnknownAccount` が別に FAIL にしていたが、それらの形式を作る版では何も残らない） | プログラムが持つ口座はどの形式でも数える（Holding だけは V7） | `evidence::a_written_program_account_of_any_layout_without_its_post_state_is_not_a_pass`、対照 `a_written_foreign_account_without_its_post_state_is_not_reported` |
| H2 | ログに最上位の呼出しがあるのにメッセージに無い（[08](08-host-vs-onchain.ja.md) §3 の「ありえない archive」） | **140 件中 130 件 PASS** | V0E `UnexplainedInvocation`（UNVERIFIABLE）: ログの `invoke [1]` がメッセージの最上位の呼出しより多い | `evidence::logs_that_show_a_call_the_message_does_not_make_are_not_a_pass` |
| H3 | 呼出し 1 つ分のログがまるごと無い（呼出しの境目で失われ、残った呼出しはすべて `success` で終わる） | **345 件中 336 件 PASS** | V0E `IncompleteLogs`: `invoke [1]` がメッセージの最上位の呼出しより少ない（0 で入れ子の呼出しも無ければ従来どおり `MissingLogs`。入れ子だけあれば `UnverifiedInnerInstruction`） | `evidence::logs_that_lose_a_whole_invocation_are_not_a_pass` |
| H4 | VR の `UnknownAccount` が、知らない形式のプログラム口座をどの版でも FAIL にする。⑳の `nft-experimental` の resident policy・link（V27・V28 が読む正当な口座）も FAIL。知らない版の下でも FAIL（⑪ r13 の「偽造は知っている版だけ」と食い違う） | NFT 版で policy・link が FAIL、知らない版（5、0x4004、0xC004、0xFFFF）で FAIL | 知っている版の下で、その版が作らない形式だけ FAIL。NFT 版では policy・link を既知とする。知らない版・版不明では UNVERIFIABLE | `unknown_accounts` の 3 件 |

H2・H3 を FAIL にしない理由: 実際のチェーンからは生じない、archive の食い違い。プログラムが規則を破った証拠ではないので「検証できない」と言う（V0E の他の所見と同じ）。正しい記録では、成功した取引の `invoke [1]` の数はメッセージの最上位の呼出しの数と一致する（ResidentAct が開いた内側の命令は同じ index なので数えない）。記録済みの fixture は V0E の所見なしのまま（`the_fixtures_have_nothing_for_v0e`）。

## 3. 直していないこと

| 残り | 理由 |
|---|---|
| CPI の内側の命令の判定 | 索引が `innerInstructions` を保存する必要がある（③ 0002）。V0E は UNVERIFIABLE と言うまで |
| post-state の無い closer の取引（すべて `Close…`） | 記録済みの archive の書き方による例外のまま（[12](12-verifier-r5.ja.md) §3） |
| wide の形式を VR が既知とするか | wide の版は検証器が知らない版なので UNVERIFIABLE のまま。wide の規則を実装するとき（VW）に決める |
| 拡張（宣言型の効果） | ⑪ (b): 最初の devnet の後 |

## 4. 文書とコードの食い違い

報告書 `~/Projects/wylls-grok-state/reports/ws11-verifier-patches.md` の D-ws11-verifier-patches-1〜 を参照。
