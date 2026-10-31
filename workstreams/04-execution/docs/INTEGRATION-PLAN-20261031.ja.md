# 統合の計画、判断の一覧、文書とコードの食い違い（④、2026-10-31）

## 0. 受領の状態（この文書を書いた時点）

| 担当 | 正本 | 状態 |
|---|---|---|
| ⑧ 継続世界 | `wylls-08-archive-v4.tar.gz`（sha256 `78a2e4db…33ec`、候補 e3d773df） | **未受領**（uploads にも GitHub の branch にも無い） |
| ⑱ 早期 Reveal の対策 | `r18-package-20261031.tar.gz`（`e75ab1e4…8884`、4cd901de → 90df6a64、0001〜0009）と補助 v2 `r18-package-20261031-addendum-v2.tar.gz`（`395d0f9e…ae06b`、90df6a64 → 41984e99、0010〜0014）。補助 v1（`02724422…ee90`）は⑱が取り下げた | **未受領**（uploads に無く、origin にも 41984e99・d9e1900b・90df6a64 は無い。10:23 時点） |
| ⑰ 再送・会計の照合 | `wylls-17-package.tgz`（`2dfaf966…c257`） | **未受領**。以前に message の本文から書き起こした 0001 は、正本として扱わない（「報告文からソースを再構成しない」による） |
| ⑲ 履歴の欠落の検出 | `package-er19.tar.gz`（`3455ffcf…4f24`、HEAD a91b7a4f）と補助 `package-er19-supp.tar.gz`（`6b724527…d9a8`、HEAD d793ebd4、tree 6d205008） | **未受領**（uploads に無く、origin にも a91b7a4f・d793ebd4 は無い。10:28 時点） |

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

## 5. ⑰から届いた、継続世界と既存の入金・受取権の衝突（C1〜C7。データとして受け取った。⑧の候補は未受領）

| # | 衝突 | ⑰の最小案（新しい規則を決めない部分） | 判断が要る部分（未決） | ④の扱い |
|---|---|---|---|---|
| C1 | Season が Ended にならないと、OPEN の pool は出口が無いまま、Pay を受け付け続ける（D2、④で確認済み） | (a) 継続世界の season では pool を作らない（新しい入金を増やさない）。(b) 既存の pool がある旧 season には、Ended に達する経路を残す | (c) 戦期を閉じる口座を Tally が読む、(d) 期限つきの返金 | P-C4 (a) の具体案として記録 |
| C2 | 終了の 72 時間後の後片付けで、shares の受取権が消える。Finalize の前に CloseSeason が送られると、金庫が恒久的に動かなくなる（D3） | 旧 pool がある season では、精算と受取が済むまで、keeper とツールから Close* を送らない（運用の規則。チェーン上の保証ではない） | (i) CloseCitizen が Entry を見て拒否する、(ii) Claim が leaf の国を信じる | P-C3 の第一段と一致 |
| C3 | ⑧が Citizen・Season を新しい seed に移すと、旧 pool の Claim が通らない | 旧 season の口座を、旧 address・同じ owner・同じ layout のまま読み取り専用で残す。新しい口座は別の address にする | — | 共通方針 W1（住所を変えない）と一致。⑧の候補で照合する |
| C4 | `pool.GAME_PROGRAM` が固定。同じ id で upgrade するなら、prize が読む offset を変えられない | prize が読む欄を registry に固定し、照合試験を付ける | — | **実装した**：`contracts/registry.txt` の `[prize_reads_game_accounts]`（`e2e-native/tests/registry.rs` が照合する） |
| C5 | 継続世界でも `join_close_bell` で Join が WrongStatus になる。Pay と Join は一つの取引なので、支払いは起きない | — | — | P-C2 |
| C6 | 長く続く世界で RPC が古い履歴を持たないと、0001 の replay の答えが出ない（二重の効果は起きない。応答は 402 AlreadyPaid） | 状態が見つからなければ、Entry と Citizen の存在を「確定済み」とみなして 200 を返す（候補、未適用） | — | ⑰の正本の受領の後に検証する |
| C7 | 境界の前後と再起動の後の照合 | `prize-settle --accounts`（0002）で不変条件を見る：collected＝Σ Entry、vault＝collected−claimed−opsWithdrawn（差は surplus）、claimed ≤ prize | — | ④の host 実行の試験は、この等式の一部（入金＝支払い＋運営分＋端数）を既に確かめている。0002 は正本の受領の後 |

⑰は、0001 を「④が受領し、適用し、実行した」と記録している。しかし④が検証した 0001 は、message の本文から書き起こしたものである（blob は一致した）。2026-10-31 の指示に従い、正本のパッケージ（`2dfaf966…c257`）を受け取るまでは「正本としては未受領」として扱う。⑰の追加の commit（d2b82b6d7bcfa95c2a63dbcff855b45723f930b8、tree 436a31734ac42a9e382245e9c8e1cac7526a2168）も未受領。

### 5.1 ⑰の補助パッケージと、AlreadyPaid の応答の案（データとして受け取った。未受領・未適用）

- 補助：`wylls-17-addendum.tgz`（sha256 `d7dcc779674fd378d77b8e927ca07828964b9cd7192543e7063e000834262b78`）。基準 `0c80381d431c8f897a873aaae6d6c5427f8460f9`（main に正本 0001〜0005 を当てた状態）。0006 `d2b82b6d…`、0007 `4c6ef0b05192f015909aa23429990ea36ec84a07`。当てた後の tree は `ee7e8be17bc4117f8101dce7ed472388d0045fb1`（⑰の報告：2,546 件中 2,545 件合格、1 件スキップ）。**未受領**。
- 残る危険（⑰の報告。模擬チェーン）：署名の履歴が欠けて状態が引けないとき、AlreadyPaid の 402 に `accepts`（支払い条件）が付いたまま返る。汎用の x402 のクライアントが払い直そうとしうる。払い直しは拒否され、資金は動かない。
- 案：
  - R1：AlreadyPaid の応答から `accepts` を外す（409 にする）。x402 v1 の「失敗は 402」から外れる。
  - R2：状態が無くても、Entry（amount ≥ fee）と Citizen があれば settled として 200 を返す（`replayed`、`fromAccounts` を付ける。transaction は空）。既存の settled の経路（plain の Join）と意味をそろえる。
  - R3：説明だけを足す。
- ④の見方（採否は未決）：R2 が筋がよい。Entry は Pay と Join が一つの取引で着地したときにだけできるので、チェーン上の支払いの証拠になる。署名の履歴に頼らずに済み、x402 の 402 の意味も変えない。ただし、Entry の存在は「この wallet が払った」証拠であって「この要求の取引が着地した」証拠ではない。そのため transaction を空にする扱いは妥当である。R1 は仕様からの逸脱が増える。

### 5.2 ⑱の補助 v2（データとして受け取った。未受領・未適用、10:23 UTC）

- ⑱の報告による固定値：最終 HEAD `41984e99f6ef31c4d3027da1b984221e3ffb36d8`（tree `397c450bd2a8db4755fd1b443be57926af677f85`）、最終コード `d9e1900b84cb4f411bec23296aa8490e1e866488`（tree `2d3a93cfb76f2ce4576c08233a9ee056af628d6c`）。bundle の fetch でも 0001〜0014 の順の `git am` でも同じ tree になる、と⑱は報告している。環境：Rust 1.95.0、Node 22、`npm ci --ignore-scripts`。SBF は不要（実プログラムの試験は未実行）。
- 受け取ったら確かめること：二つの sha256、基点 4cd901de が統合の祖先にあるか、bundle と `git am` の tree の一致、上の二つの tree。続いて同じ tree で ⑱の `w6t_tests`（17 件）と ④の r18-check の 5 場面を走らせ、通常の Reveal が出て決着することも確かめる。④の基準（修正前）は secrecy 違反 2／validity 違反 7（再起動は 0／6）。
- ⑱の区分のうち④と利用者が決めるもの：
  - program 側の拒否（案 A：anchor も archive も無い Reveal を既存の `NoAnchor(8)` で拒否。新しい番号は不要。到着鐘の中の自己公開ができなくなる）。program の拒否は秘匿の対策ではなく、早すぎる公開を無効にする対策にとどまる。
  - 検証器の警告の code 候補 `RevealBeforePublication`（成功した Reveal の時刻が round_time(T(arrive)) より前）。材料が無ければ UNVERIFIABLE で、PASS にしない。番号は未定。
- 未修正として⑱が挙げた点：ブラウザと bots が到着鐘の開始時点で material を relay・keeper へ送る（RPC には出ない。運用者を信用する範囲）。提案パッチはあるが未適用。この点を含むので、公開の判断まで push しない。

### 5.3 ⑲の補助パッケージ（データとして受け取った。未受領・未適用、10:28 UTC）

- `package-er19-supp.tar.gz`（sha256 `6b724527a1f23257fb5a724010de987efa91f8369ee7d4bd6236ae3a4598d9a8`）。正本 a91b7a4f の上に 3 commit。HEAD `d793ebd4dfded1a4c4fa23796181c55d29874224`、tree `6d205008fc24ef325e957d795f9374f24c8fc183`。
- A の追加の修正（⑲の報告）：取引の束の途中で getTransaction が失敗すると、それより前の取引を保存せずに cursor だけ進み、次の pull で黙って抜ける。基点 4cd901de でも再現。A の patch の sha256 は `910af799…4327`。⑲は origin/main 92142932 に A と D を当て、frontier-node の workspace で 741 合格・0 失敗と報告。手順は `docs/frontier/er-candidate/verify-A.sh <worktree> <patches>`。
- D は再現の試験だけ（A に依存。仕様は未決）：findex の v1 取引で止まる・fork から外れた confirmed の記録が残る・archive のバイト数、verify の前半だけの再生と委任プログラムの最終状態がどちらも HeadMismatch。
- 検出の限界（⑲）：初回の取得、cursor が無い・読めない・古い形式、途中だけ欠けたノードでは検出できない。findex に「無い」ことを「起きていない」根拠にしない（⑫・⑮にも伝える）。
- B（S1 とは別のプログラム）と C（文書）は別扱いのまま。S1 の口座の委任、公開 devnet、実際の ER での脱出は未決定・未確認。
- 受け取ったら：二つの sha256、a91b7a4f と d793ebd4 の祖先関係と tree、A だけを ④の統合 HEAD から分けた候補 branch に当て、frontier-node の workspace 全体、④の 72 件、e2e-native を走らせる。

### 5.4 ⑱の側で④の記録用 patch を走らせた結果（⑱の報告。データとして受け取った。④は未照合、10:40 UTC）

- ⑱は本文から書き写した patch が sha256 `eb859fed…3234`（12,760 バイト）で一致したと報告。前提の `play.rs`（blob 915abb50）は 4cd901de と 41984e99 の両方にあり、そのまま当たった。⑱のブランチには commit していない。
- 5 場面（`--test-threads 1`）：

| 場面 | 4cd901de（修正前）秘匿／有効性 | 41984e99（⑱の最終）秘匿／有効性 |
|---|---|---|
| normal | 2 / 7 FAIL | 0 / 0、Reveal 7 件 PASS |
| held_anchor | 2 / 7 FAIL | 0 / 0、7 件 PASS |
| reads_fail | 2 / 7 FAIL | 0 / 0、7 件 PASS |
| restart | 0 / 6 FAIL | 0 / 0、6 件 PASS |
| retries | 2 / 7 FAIL（anchor あり 20 件） | 0 / 0、27 件 PASS |

- 修正前の数字は④の測定と同じ。修正後も Reveal は出て、すべて THE anchor がチェーンにあり drand の公開後だった、と⑱は報告。
- transit の digest は 5 場面とも同じ（`181c0c1a…`）で、restart でも所有者の material は失われていない。戦闘結果の digest は anchor の着地時刻から決まる seed に依存するので、遅延の場面では normal と違う。④の試験は outcome の一致を条件にしていない（`check()` は秘匿と有効性だけ）。この扱いのままにする。
- ログ（⑱の手元。次のパッケージに入る）：`ws04-base.log` `24114c76…`、`ws04-head.log` `fe403d00…`、`ws04-head-digests.log` `16a7c871…`。
- ④の判定は、正本と補助 v2 を受け取り、同じ tree で④自身が走らせてからにする。
