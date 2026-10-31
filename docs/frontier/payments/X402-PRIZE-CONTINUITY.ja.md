# x402・テストUSDC決済と継続世界（⑰の作業記録、2026-10-31）

試験用トークン（価値なし）だけを扱う。実USDC・実資金・公開配備は対象外。成功の主張は、下に書いた環境と手段に限る。

## 0. 基準と取得状況

| 対象 | 状態 |
|---|---|
| 共通基準 `4cd901de9f8e0d6c0b2016851d30595c4a70aa46` | 取得済み。`main` 921429 との差は README の2行のみ（コードは同一） |
| ④の統合候補 `integrate/claude-consolidation-20261029` @ `a4fc78ca`（PR #22） | 取得済み。`main` に対して文書のみ追加。決済コードの差はない |
| ⑤の成果物 `29365e602e96e6b27eb327f1ed676f7abee7ef39` | **取得不可**。`git fetch origin <sha>` は "not our ref"、GitHub API も "No commit found"。⑤の予算エンジンとの接続照合は、リポジトリ内の agent wallet に対してだけ行った（§5） |
| SBF ビルド道具（Agave 3.1.9） | **導入が承認されず未導入**（下記）。プログラムを手元では実行していない |

導入できなかったソフト（承認が必要なもの）:

- 入手元: `https://github.com/anza-xyz/agave/releases/download/v3.1.9/solana-release-x86_64-unknown-linux-gnu.tar.bz2`（CI は `https://release.anza.xyz/v3.1.9/install` を使う）
- 版: Agave 3.1.9（`cargo-build-sbf` 3.1.9、platform-tools v1.52。`scripts/build-prize.sh` と `build-frontier.sh` がこの版以外を拒否する）
- 変更場所: `~/.local/share/solana/install/`（リポジトリ外。コンテナ内のみ）
- 用途: `permutation_prize.so` と `permutation_frontier.so` のビルド、LiteSVM テスト（`permutation-prize/svm-tests`）の実行、`frontier-stack` によるローカル通し試験

自動で入ったもの（リポジトリの `rust-toolchain.toml` が固定する公式 Rust）: rustup が 1.89.0 と 1.95.0 を取得し、1.95.0 に rustfmt・clippy を追加した。npm はロックファイルどおり `npm ci --ignore-scripts`。照合用に公式 `x402@1.2.0` をスクラッチ領域にだけ入れた（リポジトリには入れていない）。

## 1. 残っていたシーズン依存（決済・参加・賞金）

| # | 依存 | 場所 | 継続世界での影響 |
|---|---|---|---|
| D1 | プールの PDA が `(ゲームプログラム, season_id)` ごと。Entry も `(pool, wallet)` | `permutation-prize/src/lib.rs` `pool_address`・`entry_address` | 識別子としては安全に残せる。ただしプールの寿命がシーズンの寿命に縛られる（D2） |
| D2 | **出口がシーズン終了にしかない。** Tally と Finalize は Season が Ended でなければ `SeasonNotEnded`。Claim・SetShares・WithdrawOps は Finalize 後でなければ `WrongState`。その間も Pay は入金を受け付ける | `lib.rs` `tally`・`finalize`・`claim`・`withdraw_ops` | 世界が終わらなければ、入金も運営分も金庫から永久に出ない。新しい試験 `while_the_season_runs_deposits_have_no_exit` が現行挙動を固定する |
| D3 | **終了後の掃除が受取権を消し得る。** 終了＋72時間後、CloseCitizen・CloseProvince・CloseSeason は誰でも送れる。shares の Claim は勝利国の生きた Citizen 口座を要求する。Tally は Province と Season、Finalize は ProvinceFunds を要求する | `permutation-frontier/src/proc/citizen.rs` (CloseCitizen)、`map.rs` (CloseProvince)、`season.rs` (CloseSeason)、`lib.rs` `claim` | 72時間以内に精算と受取が済まないと、受取権が消えるか、金庫が恒久的に動かなくなる。返金モードの Claim は Entry だけで通る。オフチェーンの自動送信はない（`fclient` にビルダーがあるだけ）。試験 `the_games_clean_up_after_the_end_against_open_claims` を参照 |
| D4 | 参加は `join_close_bell` まで。それ以後の Join は `WrongStatus` | `citizen.rs` `join` | Pay と Join は1つの取引なので、参加が拒まれても支払いは起きない（Solana の取引の原子性。手元では未実行） |
| D5 | 中継の 402 の説明文が「Entry to Wylls season N」。要件の `extra.seasonId`・`season` | `permutation-gateway/src/frontier/routes/prize.mjs` | 文言は⑦の範囲。識別子としては動作に影響しない |
| D6 | 精算スクリプトが Season の Ended（status 4）を前提にする。旧 E2E はシーズン終了を前提にする | `scripts/prize-settle.mjs`、`scripts/prize-e2e.mjs` | 旧経路の互換確認として残す。継続世界の完成形にはしない |
| D7 | 賞金の決定事項（`prize-params.json` の `decided.winner`）が「シーズン終了時に最多の州を持つ国」 | `src/frontier/prize-params.json`（プールの `params_hash` に束縛） | 戦期の扱いは未決定なので変更していない。新しいプールではこの文言の見直しが必要 |

## 2. 変更した挙動

1. **応答消失後の再送が冪等になった**（中継）。従来は同じ X-PAYMENT を再送すると、支払いと参加が済んでいても 409 `Duplicate` を返した。手数料支払者の署名は決定的なので、取引の署名は送信前にわかる。チェーンにその結果があれば、同じ 200 と X-PAYMENT-RESPONSE（`replayed: true`）か、チェーン上の失敗（402）を返し、再送信はしない。中継が再起動しても、プールが集計に入っても同じ答えを返す。新規の支払いは従来どおり拒否する（`EntriesClosed`）。
2. **SetShares の再計算照合**（`prize-settle --verify-shares LEDGER`）。精算と照合が同じ関数（`src/frontier/shares.mjs`）を通る。照合では台帳の各行をチェーンから導き直し、Entry と Citizen から参加者を、`prize-params.json` から得点・totals・mode・merkle root を再計算する。これをプールの値、台帳の sha256、params の sha256 と突き合わせる。
3. **会計の読み出し**（`prize-settle --accounts`）。Season の状態を問わず、どのプール状態でも使える。入金、80/20、受取、金庫を Entry 全件と金庫残高に照合し、各支払者の「今ある出口」を示す。Season が墓標になっても起動する。
4. `prize-settle` のプロファイル: 固定の 2（MC）をやめ、Season から読む（S1 は 3。口座レイアウトは同じ v2）。
5. 旧 `prize-e2e` は互換試験と明記した。S1 のルールモジュール（`frontier-v3.wasm`）と、402 が示すプロファイルを使う。受取後に `--verify-shares` と `--accounts` を実行する。

**変えていないもの**: 参加費（25 テストUSDC）、80/20、勝利条件、同点処理、得点の重み、返金モード、プログラム本体（`lib.rs`）、料金周期、賞金制度。

## 3. 試験で確認したこと

| 範囲 | 結果 | 実行者・環境 |
|---|---|---|
| gateway 全体 `npm test` | 2,543 件中 2,542 合格、1 件は従来どおりスキップ、失敗 0（新規 14 件を含む） | 手元（Node 22.22.0、スクリプト化したチェーン） |
| x402 の失敗例（新規） | 応答消失後の再送（同じ中継／再起動後／集計開始後）、チェーン上で失敗した取引の再送、別ネットワーク4種と別スキーム（シミュレーション前に拒否）、期限切れの blockhash（409 `BlockhashExpired`、送信なし）、同一ウォレットの二重参加（402 `AlreadyPaid`）、二重受取（409 `AlreadyClaimed`、送信なし） | 同上 |
| 既存の失敗例 | 偽署名、別の金庫・mint、gate 抜き、残高不足（`InsufficientFunds`）、集計後の参加（`EntriesClosed`）、未払いの Join（402・`InviteRequired`） | 同上 |
| S1（profile 3） | 402 が profile 3 とその予算を示す。M1 形の取引はシミュレーション前に拒否。S1 形は着地。SDK は 402 から S1 形を作る | 同上 |
| 独立クライアント | Wylls SDK を使わず `@solana/web3.js` だけで、402 本文から計算予算・Pay・PDA・メッセージ・署名・X-PAYMENT を組み立てた。中継が受理し、X-PAYMENT-RESPONSE を返した。ゲームの Join 命令のバイト列だけは ABI エンコーダを使用 | 同上 |
| 公式 `x402@1.2.0` の zod スキーマ | X-PAYMENT と X-PAYMENT-RESPONSE は network 名を除いて合格。402 本文は `network: solana-localnet`（公式に localnet の名前がない）と `resource` が相対パス（公式は URL）の2点で不合格（§4） | 手元（スクラッチ領域） |
| SetShares の再計算（新規4件） | S1 で実際に起きた6か国同点：入賞者の支払者 3+1 人で等分。受取額 13,333,333×3＋40,000,000、端数 1 単位が金庫に残る。運営による改ざん5種（得点の水増し root、totals 過大、totals 過小で1件が賞金全額を取れる状態、別台帳、別 params）と、不当な返金指定を検出 | 手元 |
| 会計（新規4件） | 継続中の OPEN プール（全額保持、出口なし）、金庫不足・Entry 欠落の検出、外部送付の余剰、shares・refund 後の照合（1 単位まで一致） | 手元 |
| prize プログラム（LiteSVM、SBF） | 既存 13 件合格。`permutation_prize.so` sha256 `c386b425f15fdd9ee6473fe3819ef9d4e560d8dd7be7cece54101631eb87b6f6`、104,536 B | **CI**（`main` 921429、run 40795125323、job 123189625279）。手元では未実行 |
| 新規 LiteSVM 2件（D2・D3 の現行挙動） | コンパイル・rustfmt・clippy は通過 | **未実行**（SBF ビルドがない） |
| チェーン上の取引・残高 | **手元では1件も実行していない。** 実行済みの記録は既存の [S1-SEASON-RUN](../stage1f/S1-SEASON-RUN.md)（4人の有料参加、Tally・Finalize、見積もりのみで送金なし）と CI だけ | — |

## 4. 移行や仕様判断が残る点

1. **D2：継続世界で入金をどう扱うか**（④⑧と所有者）。いま出口は「Season Ended → Finalize」だけ。戦期の区切り、集計対象、賞金の扱いは未決定なので、新しい出口（戦期を閉じる命令、期限付きの返金など）は作っていない。候補の比較は④へ渡す。
2. **D3：受取権を掃除から守る順序**（④）。候補は2つ。(a) CloseCitizen・CloseSeason を、プールが受取を終えるか期限を過ぎるまで送らない運用規則にする（オンチェーンでは誰でも送れるので保証にならない）。(b) Claim が Citizen の代わりに SetShares 時点の記録を使う（ただし、運営が leaf の国を偽れる余地が増える）。採否は未決定。
3. **SetShares の信頼構成**（下の §6）。オンチェーンで強制されない部分は `--verify-shares` で誰でも検出できる。ただし検出であって防止ではない。
4. **x402 の版**（§4a）。互換性を壊さない独立候補として残す。採用していない。
5. ⑤の 29365e60 との照合（入金・予約・確定・未確定・出金）。取得できたら §5 の表を再実行する。
6. SBF での実行：新しい LiteSVM 2件、`prize-e2e`（互換試験）、`frontier-stack` の通し試験。Agave 3.1.9 の承認後、または④⑯の環境で実行する。

### 4a. x402 の採用版と方式

- 採用: **x402 v1 の形**。`x402Version: 1`、ヘッダは `X-PAYMENT` と `X-PAYMENT-RESPONSE`、`scheme: "exact"`、402 本文は `{x402Version, error, accepts}`、要件は `maxAmountRequired`。照合した公式は coinbase/x402 @ `0e6e8c55`（2026-10-15）の `specs/x402-specification-v1.md` と `scheme_exact_svm.md`、npm `x402@1.2.0`。
- 公式との違い:
  - network が `solana-localnet` で、公式に localnet の名前はない。
  - `resource` が相対パス。
  - 支払いが TransferChecked の単独命令ではなく、`[計算予算, prize Pay（CPI の TransferChecked）, ゲーム Join]` の legacy 取引になっている。公式クライアント（`ExactSvmScheme`）はこの取引を作れず、公式 facilitator も拒否する。v1 の公式検証器は命令3個を要求する。v2 は「追加命令を制限しない」結果ベースだが、プログラム許可リストがある。
  - 支払い失敗の一部を 402 ではなく 409・400 で返し、その応答に `accepts` が付かない。
  - 公式 SVM クライアントが必須とする Memo（ノンス）がない。Wylls は Entry PDA で二重支払いを防いでいる。
- v2（`PAYMENT-REQUIRED`・`PAYMENT-SIGNATURE`、CAIP-2 の network、`amount`）への移行は互換性を壊すので、併記する独立候補とする。

## 5. ⑤の AI 運用費との境界（リポジトリ内の agent wallet との照合）

| 項目 | 賞金プール | agent wallet（`src/frontier/agent/`） |
|---|---|---|
| 置き場 | prize プログラムの PDA 金庫 | custody 鍵の ATA（運営保有、別口座） |
| 台帳 | チェーン上の Pool と Entry | 中継の状態ファイル `state.agentWallet` |
| 不変条件 | 金庫 = collected − claimed − opsWithdrawn | deposited = available + reserved + Σspent + pendingWithdraw + withdrawn |
| mint | テストUSDC | **同じ mint**。口座・残高・台帳は共有していない |
| 参加費の支払い | Pay（ウォレット本人の署名） | 参加費を払う経路はない（`x402`・Pay の参照なし） |
| lamports | 扱わない（Entry の rent は中継が払う） | ネットワーク手数料は `recordNetwork` で金額 0、lamports を別欄に記録。USDC とは混ぜない |
| 推論費用 | 扱わない | `spent.inference`。予約→実行中→確定・解放、または未確定→運営判断 |

コード上の結合は、`gateway.mjs` が `routes/prize.mjs` の `landed` を、`custody.mjs` が SDK の `ata`・`decodeTokenAccount` を使っていることだけ（関数の再利用で、残高は共有していない）。今回の変更で `landed` は変えていない。

## 6. SetShares の root：誰が何を信頼するか

- **チェーンが保証すること**: 勝利国は Province 口座から Tally・Finalize で決まり、誰でも実行できる。Claim には支払い済みの Entry、勝利国の Citizen、root への証明が必要。得点は国の total 以下。受取の合計は賞金以下。1ウォレット1回。
- **運営を信頼すること**（プログラムは確かめない）: root の leaf が台帳から導かれること、totals が leaf の合計であること、`ledger_hash` が公開台帳の sha256 であること、台帳を公開すること。totals を過大にすると残りが金庫に永久に残る。過小にすると先に受け取った人が多く取り、最後の人が拒否される。
- **元の実績から再計算できるか**: できる。条件は、公開台帳と `prize-params.json` があり、チェーン（取引履歴と口座）が読めること。`prize-settle --verify-shares` が台帳の各行の導出、参加者、得点、totals、root、2つのハッシュを照合する。ただし防止ではなく、事後の検出にとどまる。また、導出規則（`achievements.mjs`）自体が正しいことは前提である。**完全に trustless ではない。**

## 7. 文書と既存コードの食い違い（コードに従った）

1. `prize-e2e.mjs` が S1 の `main` で `frontier-v2.wasm` と profile 2（MC）を使っていた（修正）。
2. `prize-settle.mjs` が `profile = 2` 固定で、S1（3）と食い違っていた（修正。読むレイアウトは同じ）。
3. 中継の冒頭コメントは `POST /f/prize/claim` の返り値を `{ok, signature}` とするが、コードは `amount` も返す。
4. x402 v1 の仕様文は 402 本文の `error` を自由文の例で示すが、公式 `x402@1.2.0` の zod スキーマは列挙コードを要求する（仕様と公式パッケージの食い違い）。Wylls は仕様文に合わせている。
5. M1 の設計文書（`docs/frontier/m1/design/program.md` の CloseCitizen 行）は "M2 inserts claims before this" としている。しかし、賞金の Claim を CloseCitizen より先に行わせる仕組みはない（D3）。
6. `prize-params.json` の決定事項「シーズン終了時」と、README の「次の公開シーズン」は、2026-10-31 の方針（世界は終わらない）と食い違う。仕様判断が必要なので変更していない（⑦・所有者）。
7. `lib.rs` の冒頭は「Tally は終了後」としか書いておらず、終了＋72時間の掃除との順序に触れていない。

## 8. 一覧：実装あり／実行確認済み／未検証／未実装

| 項目 | 状態 |
|---|---|
| 残高確認（GET /f/prize?wallet）、faucet、x402 支払い＋参加、SDK | 実装あり。スクリプト化したチェーンで実行確認済み（手元）。実チェーンでの実行は既存の S1-SEASON-RUN の記録のみ |
| 応答消失後の再送の冪等化 | 実装あり（今回）。実行確認済み（手元、スクリプト化したチェーン） |
| 独立クライアント | 実行確認済み（手元）。公式クライアントでは不可（§4a） |
| Tally・Finalize・SetShares・Claim・WithdrawOps・返金 | 実装あり。SBF・LiteSVM で実行確認済み（CI、`main` 921429）。手元では未実行 |
| ゲーム終了→Claim→着金の通し試験 | 互換試験として更新済みだが未実行（ローカルスタックのビルド道具がない） |
| SetShares の再計算照合、会計の読み出し | 実装あり（今回）。単体で実行確認済み。実チェーンでは未実行 |
| 継続世界での入金の出口、受取権を掃除から守る仕組み | 未実装（仕様判断待ち。§4） |
| x402 v2 対応 | 未実装（独立候補） |
