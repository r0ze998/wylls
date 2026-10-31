# 統合の計画、判断の一覧、文書とコードの食い違い（④、2026-10-31）

## 0. 受領の状態（この文書を書いた時点）

| 担当 | 正本 | 状態 |
|---|---|---|
| ⑧ 継続世界 | `wylls-08-archive-v4.tar.gz`（sha256 `78a2e4db…33ec`、候補 e3d773df） | **未受領**（uploads にも GitHub の branch にも無い） |
| ⑱ 早期 Reveal の対策 | `r18-package-20261031.tar.gz`（`e75ab1e4…8884`）と補助 `…-addendum.tar.gz`（`02724422…ee90`） | **未受領**（branch `claude/brave-bohr-xe4n4p` も origin に無い） |
| ⑰ 再送・会計の照合 | `wylls-17-package.tgz`（`2dfaf966…c257`） | **未受領**。以前に message の本文から書き起こした 0001 は、正本として扱わない（「報告文からソースを再構成しない」による） |
| ⑲ 履歴の欠落の検出 | `package-er19.tar.gz`（`3455ffcf…4f24`） | **未受領**（branch `claude/ecstatic-cannon-d0jfc4` も origin に無い） |

受け取ったら、次を確認する：sha256、bundle の前提の commit・HEAD・tree、patch から復元した tree の一致。そのうえで、最新の統合 HEAD から分けた候補の branch に、一つずつ当てる。

## 1. 当てる順序、依存、予想される衝突（各担当の報告から。実物で確かめるのは受領の後）

| 順 | 担当 | 報告にある変更の範囲 | 依存 | 予想される衝突と対処 |
|---|---|---|---|---|
| 1 | ⑧ | 継続世界（program・ABI・エラー 94 を含むと報告） | なし。共有コアの基礎 | エラー 94（⑩も仮に使っている）→ `e2e-native/tests/error_codes.rs` と registry の照合で検出する。番号は先に入る方を 94 にする（§3、未採用）。kernel の版が上がれば ruleset hash が変わる → registry・preset・web の pin をそろえる |
| 2 | ⑱ | keeper（`play.rs`、`journal.rs`、`testkit.rs`）、fclient（HTTPS、drand の固定） | ⑧が bell・genesis を戻さないこと（⑱も同じ方針） | ④の試験の patch（`keeper/tests/play.rs`）とはファイルが違う。⑱の試験は `src/play.rs` の `w6t_tests`。fclient は⑲とも重なりうる |
| 3 | ⑰ | gateway の `routes/prize.mjs`、`scripts/prize-settle.mjs`、新しい `shares.mjs`・`prize-accounts.mjs`、`permutation-prize/svm-tests` | なし（旧経路の互換） | ③0005・⑤0001 と同じ gateway だが、ファイルは別。0003（LiteSVM）は SBF の承認待ちで実行できない |
| 4 | ⑲ A | findex の `ingest.rs`（欠落の検出、cursor の欄の追加） | なし | ⑱の fclient の変更と同じ crate の利用者。cursor の形が変わるので、④の feed の cursor とは別物として扱う |
| — | ⑲ B（板の program） | S1 とは別の program | — | S1 への採用とは分ける。統合の候補には入れない |
| — | ⑲ C（文書） | 文書だけ | — | 参照のみ |

**④の回帰試験**（受け取った後、毎回同じ tree で走らせる）：
- ④の `cargo test`（72 件）と、MOCK の gateway の試験 9 件
- `e2e-native`（8 件：旧経路の互換、registry、エラー番号）
- `r18-check` の 5 場面（秘匿と有効性）
- frontier-node の workspace、permutation-gateway の `npm test`

## 2. 決める必要がある項目

| 項目 | 現行の挙動 | 提案する変更 | 既存データへの影響 | 互換性 | 推奨案 |
|---|---|---|---|---|---|
| 共通方針：世界の識別子 | 全口座の住所が Season の口座から決まる。新しいシーズン＝新しい住所 | 今の Season の口座を、世界の口座として固定する（W1） | 住所はすべて変わらない | 旧版の Season はそのまま読める | 採用 |
| 共通方針：時計と番号 | bell は genesis から数える | bell・genesis・seq を戻さない。戦期の番号は別の欄にする | なし | ⑱の境界の試験と一致する | 採用 |
| 共通方針：証拠と版 | 版は registry で照合する | 旧版の記録は旧版の規則で再検証し、新版の証拠に読み替えない | なし | — | 採用 |
| P-C1 継続モード | `end_bell` で player の全操作が止まり、EndSeason で終わる。`end_bell ≤ 4,032`（28 日） | Season の予約領域に、一方向の継続モードの印を置く。継続モードでは `end_bell` と EndSeason を使わない | Running のシーズンを `end_bell` の前に切り替えるなら、全口座はそのまま。Ended のシーズンは戻さない | 旧版の印（0）は今の挙動のまま。keeper・herald・UI・verifier の対応が要る | 採用（最初の核） |
| P-C2 参加 | `join_close_bell` で Join を締め切る | 継続モードでは締め切らない。gate は残す | 既存の Citizen に影響なし | 参加費・NFT の参加条件は**決めない**（別の判断） | P-C1 と同時に採用 |
| P-C3 後始末 | 進軍の記録・Citizen・archive は、終了の後にしか閉じない | 第一段：受取権と預かりを守る。Citizen は本人だけが、何も残っていないときに閉じる。第二段：経過と完了で閉じる | 旧版の pool は、受取が済むまで後始末を送らない運用で守る | close の条件に試験を付ける | 第一段を先に、第二段は長期運用の前に |
| P-C4 戦期 | 賞金の集計は Season Ended が前提。入金に出口が無い（D2）。Citizen が閉じると受取権が消える（D3） | (a) 既存の pool の出口、(b) 戦期の口座（器だけ）、(c) 境界の写し | 既存の pool の受取は変えない | 戦期・賞金の規則は**決めない** | (a) は有料の入金がある場合だけ急ぐ。(b)(c) は規則が決まるまで保留 |
| P4（旧版の不具合） | SendCaravan が到着の bell を `end_bell` と比べない。終了をまたぐ隊商は永久に CaravanEarly | P4-a：進軍と同じく `last_bell ≥ end_bell` を拒否する | 既に道に残っている隊商は救えない（回収の規則は別の判断） | 旧版の規則の修正 | 採用（継続とは独立） |
| 早期 Reveal（⑱） | keeper が、THE anchor と drand の公開より前に平文を RPC へ出す（④が再現） | ⑱の修正：anchor をチェーンで確認し、かつ T(arrive) の署名を検証してから作る | なし（keeper の挙動だけ） | program は anchor 無しでも受け付ける。program 側で拒否するかは別の判断 | ⑱の正本を検証してから採否を決める |
| エラー 94 | ⑧と⑩が両方 94 を仮に使う | 先に入る方を 94、もう一方を 95 | 番号はチェーンで使われたら変えない | 生成物は script で作り直す | 受領の後に照合してから決める |
| findex の欠落（⑲） | 欠落を黙って保存する | 連続性を確かめ、欠落なら保存しない。ただし完全な履歴の保証ではない | cursor に欄が増える（古い cursor も読める） | 「記録が無い」を「起きていない」の根拠にしない | ⑲の正本を検証してから |
| v1 の取引（⑲） | `maxSupportedTransactionVersion: 0` で取得が止まる | 1 にして、解釈できない取引も記録する | 保存済みの archive は書き換えない | — | 採用の方向（委任を使う前に） |
| 継続世界の検証 | genesis から全部を再生し、終わりで完全一致を見る | 署名つきの checkpoint から、窓ごとに再生する | なし | checkpoint を誰が作り署名するかは未決 | 設計を進める |

## 3. 文書とコードの食い違い（見つけたもの。挙動は既存のコードに従って扱った）

| # | 文書 | コード | 扱い |
|---|---|---|---|
| 1 | `keeper/src/reveal_accept.rs:20-22`：「keeper は THE anchor が着地するまで material を保持する」 | play の duty は、anchor（slot 703）より前（slot 627）に owner material の Reveal を RPC へ出した（④の基準の測定） | コードの挙動を事実とした。⑱の修正の対象 |
| 2 | ⑱の当初の報告：「NoAnchor で拒否され、失敗取引として載る」 | `permutation-frontier/src/proc/reveal.rs:803-835`：anchor も archive も無ければ窓の確認を飛ばして受け付ける | ⑱が訂正した（commit 5c1649b9）。④の記録も訂正した |
| 3 | ④の 2026-10-31 の記録：「早すぎて失敗した Reveal」 | 同上 | 訂正した（CONTINUITY §5） |
| 4 | `frontier-abi/vectors/v2/errors.json` の説明文：「MC's 62–78」 | 実際は 62〜93 | 番号は一致している。説明文が古い（生成の元の文言） |
| 5 | ④の旧経路の試験（5a103765）：「道にある隊商は精算される」 | `proc/caravan.rs:955-958` と `proc/clash.rs:442-448`：終了をまたぐ隊商は精算されない | ⑯の指摘で直した（e7f7909d） |
| 6 | ④の数量の文書（30e7de98 より前）：「RuleDerived＝正確な量」 | `proc/caravan.rs:401-407`：記録は milli の切り捨て | 下限に直した |
| 7 | `permutation-prize` の module doc：Tally は凍結（end_bell 以降は解決されない）に依存 | 継続世界では成り立たない（P-C4 (c)） | 設計の課題として記録 |
| 8 | ⑰の報告：「SetShares・Claim・WithdrawOps は Finalize 前だと WrongState」 | ④の host 実行：SetShares と WithdrawOps は WrongState。Claim も拒否される（④の試験は失敗することだけを確かめ、code は見ていない） | 一致する。Claim の code は未確認 |

## 4. push（GitHub の保存）の状態

- 保留中。理由は二つ。
  - Vercel・Netlify・GitBook の連携の範囲を、④の環境から設定で確かめられない。
  - この branch には、未修正の脆弱性（早期 Reveal）の再現と詳細が入っている。公開してよいかの判断を待っている。
- 統合と試験は、隔離した worktree で push と切り離して進める。
